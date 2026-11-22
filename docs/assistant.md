# Assistant (AI sidebar)

The assistant is a chat sidebar, open from any workspace page with **⌘J** (Ctrl+J) or **Assistant** in the navigation. Each member adds their **own API key** for a model provider, and the assistant uses a model through that key. It works in Knotworking through the [MCP server](mcp.md) with that member's permissions.

```
browser ──POST prompt / SSE──▶ API (Hono)
                                 │ 1. decrypts the member's key
                                 │ 2. mints a 15-minute token of theirs
                                 │ 3. streamText (Vercel AI SDK) ──▶ provider (their key)
                                 │ 4. tool calls ──▶ apps/mcp ──Bearer knw_…──▶ /v1
                                 └ events ─▶ Postgres ─▶ the browser's stream
```

It is the `assistant` module (`defaultAccess: "none"`): owners and admins have it, and they grant it to others under Settings → Members → Module access.

If you would rather use an agent platform you already have (Claude, ChatGPT, Claude Code, Codex…), connect it to the MCP server instead: see [MCP](mcp.md). The sidebar is for people who want a chat inside Knotworking without setting that up.

## Providers

| Id         | Provider      | Package             |
| ---------- | ------------- | ------------------- |
| `claude`   | Claude        | `@ai-sdk/anthropic` |
| `openai`   | OpenAI        | `@ai-sdk/openai`    |
| `google`   | Google Gemini | `@ai-sdk/google`    |
| `mistral`  | Mistral       | `@ai-sdk/mistral`   |
| `xai`      | xAI Grok      | `@ai-sdk/xai`       |
| `groq`     | Groq          | `@ai-sdk/groq`      |
| `deepseek` | DeepSeek      | `@ai-sdk/deepseek`  |

The model must support tool calling. A model that rejects tools fails the turn with the provider's own error.

Adding a provider is one entry in `assistantProviderDefs` (`apps/server/src/services/assistant-providers.ts`: how to build a model from a key, and how to list its chat models), one id and name in `packages/core/src/assistant.ts`, and one dependency. Azure OpenAI and Amazon Bedrock need more than one credential field, and generic OpenAI-compatible endpoints (Ollama, gateways) let a member make the server fetch any host, so neither is offered yet.

## Pieces

| Piece     | Where                                                                             | What it does                                                                                    |
| --------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Core      | `packages/core/src/assistant.ts`                                                  | Provider ids, event and request schemas, `applyAssistantEvent` (the reducer), the system prompt |
| Tables    | `packages/db/src/schema/assistant.ts`, `assistant-runtime.ts`                     | Keys, settings, conversations, messages; turns, claims and the stream's event log               |
| Keys      | `services/assistant-keys.ts`, `assistant-crypto.ts`                               | Check a key with the provider, seal it at rest, decrypt it for one turn                         |
| Providers | `services/assistant-providers.ts`                                                 | The registry above                                                                              |
| Turns     | `services/assistant-turn.ts`                                                      | The agent loop: model, MCP tools, events                                                        |
| Hub       | `apps/server/src/assistant-hub.ts`                                                | Stores replies, one turn per conversation, the browser stream, ending stale turns               |
| Routes    | `apps/server/src/routes/assistant.ts`                                             | `/v1/me/assistant/*` (keys, settings) and `/v1/workspaces/:slug/assistant/*` (chats)            |
| Web       | `components/assistant-panel.tsx`, `lib/assistant-store.tsx`, `settings/assistant` | The sidebar (a column on desktop, a sheet on phones) and the key settings                       |

## Setting it up (each person)

1. In Knotworking: user menu → **Assistant** (`/<workspace>/settings/assistant`). You need the `assistant` module in at least one workspace.
2. Under **Your API keys**, choose a provider and paste a key from that provider's console. The server checks it by listing the provider's models, and only then stores it. The first key you save becomes your default provider.
3. Optionally set a **model for new chats** (pick from the provider's list or type any model id), choose what the assistant may do (**Read and change things, as you** or **Only look things up**), and choose **Tools it can use**: which modules' tools the model is given.

Usage is billed to your account with the provider. There are no Knotworking-side spend limits beyond the step cap and timeout below.

## Tools

Listing every MCP tool natively would be 286 tools (167 read-only), about 97,000 tokens sent to the model on every step, and more than OpenAI accepts (128). Two things keep it small:

- **Which modules.** Each turn asks the MCP server for `?tools=read` (when the member's scope is read-only) and `?modules=…` (the member's choice; default `tasks`, `docs` and `time`). The same modules also limit the temporary token at the API (not just the tool list), so the model cannot reach other modules even by guessing. The choice only narrows what is offered: the member's own permissions and the API's checks still decide what works, and an empty list is never sent because the MCP server would read it as every module.
- **Which tools at each step.** The turn opens MCP with `?list=all`, reads every tool definition once and asks `list_modules` which tools belong to which module. The model then sees only the core: orientation, the pinned tools, the reusable reads `find_records` / `get_record` (which read every resource of the chosen modules), the platform tools, and a local `load_modules` tool. When the model calls `load_modules(["quality"])`, that module's tools (writes, reports, plans) are switched on from the next step (`activeTools` in `prepareStep`; `ToolPlan` in `assistant-turn.ts`). Loading is local, because the definitions are already in hand. The module of the page the person had open (`assistantModuleForPath`, kept in step with the sidebar by `sidebar-nav.test.ts`) starts loaded. If the MCP server has no `list_modules` tool (it predates catalogue mode), every tool is offered at once, as before. If it has one but the call fails twice (a rate limit, a bad answer), the turn ends with a message saying the tool list couldn't be read: quietly offering every tool could pass OpenAI's limit for a reason the member can't fix. Modules with no tools the turn can see are left out of `load_modules`.

For OpenAI the 128-tool limit is checked against what one step carries: a turn whose core is already over it stops with a message to choose fewer modules, and `load_modules` refuses a load that would go over it. With Claude, two Anthropic `cacheControl` markers are set: one on `load_modules` (the last core tool) and one on the instructions. The tools are sent in a stable order: core first, then loaded modules in manifest order. So on each step after the first, the core tools are read from the prompt cache even when a module was just loaded, and the tools and instructions are cached while nothing changes.

## Keys

A key is sealed with AES-256-GCM under a key derived from `BETTER_AUTH_SECRET`, with a fresh IV each time and the owner and provider bound in as authenticated data, so a ciphertext copied to another row will not open. Rotating `BETTER_AUTH_SECRET` makes stored keys unreadable: members add them again. Nothing returns a key: the API shows the provider, the last four characters, the model and when it was saved. A key is decrypted only inside a turn and passed to the provider's constructor; provider errors are shown with the key removed. Key routes refuse API tokens, so nothing holding a token can read, replace or spend a member's key. A password reset does not delete keys (they are the member's credentials with the provider, and cannot be read back).

## How a turn runs

1. The browser posts the prompt with the page the person has open (`context: { path, title }`). The API claims the conversation (`409 assistant_busy` if a reply is running), stores the prompt and an empty `running` reply, and answers `409 no_provider_key` or `no_model` before storing anything if the chat has no key or model.
2. In the background of the same process it mints a token for the member: their permissions at the scope they chose, valid 15 minutes, hidden from their token list, not counted toward their 25-token limit, and with no person-only actions (sign-offs, approvals). It opens an MCP client to `MCP_INTERNAL_URL` with that token.
3. It runs `streamText` with the member's model, the MCP tools only (no files, shell or web; plus the local `load_modules`, which only switches MCP tools on), `assistantSystemPrompt`, and the conversation's earlier text (tool calls are not replayed). The turn stops after 12 tool rounds or 10 minutes.
4. The stream becomes `AssistantEvent`s (`text_delta`, `text`, `tool_use`, `tool_result`, `done`, `error`), batched about every 120 ms and written through the hub, which folds each into the reply and pushes it to the person's open `GET …/assistant/stream`.
5. However the turn ends (done, error, Stop, timeout), the MCP client is closed and the token revoked. Page titles are written by members, so they only ever appear in the user message as a quoted note marked as data, never in the system prompt.

**Stop** (`POST …/conversations/:id/cancel`) ends the reply at once; the process generating it notices within a second and aborts. That process checks its turn every second and records a heartbeat about every 10 seconds; a turn with no heartbeat for 45 seconds (its server died) is ended with an error. On a clean shutdown (SIGTERM) the server ends its running replies with an error and revokes their tokens, waiting up to 5 seconds. The MCP connection has a 15-second limit, a failed write of a reply's events is retried once and otherwise stops the turn, and a member can have 3 replies running at once (`429 assistant_too_many`). Finished coordination records, stream events and leftover turn tokens are pruned after a day. Conversation history stays. A conversation can switch provider or model between messages, because only text is replayed (neighbouring messages from the same person are merged, since providers disagree about two in a row).

Errors shown in the chat are the provider's own (with the key removed, and rate-limit retries looked through to the last real failure). Anything else, a database error for instance, is logged on the server and shown as a generic sentence.

## Routes

| Route                                                                           | Who                         |
| ------------------------------------------------------------------------------- | --------------------------- |
| `GET /v1/me/assistant/keys`, `PUT/PATCH/DELETE /v1/me/assistant/keys/:provider` | Sign-in session only        |
| `GET /v1/me/assistant/keys/:provider/models`                                    | Sign-in session only        |
| `GET/PATCH /v1/me/assistant/settings`                                           | Sign-in session only        |
| `GET …/assistant/status`, `GET/POST …/assistant/conversations`                  | Session, module `assistant` |
| `GET/PATCH/DELETE …/assistant/conversations/:id`                                | Session, own chats only     |
| `POST …/assistant/conversations/:id/messages` `{ text, context? }`, `…/cancel`  | Session, own chats only     |
| `GET …/assistant/stream` (SSE, `event: assistant`)                              | Session                     |

Workspace routes are under `/v1/workspaces/:slug`. They refuse API tokens (`forbidTokens` in `app.ts`), so nothing holding a token, not even the assistant's own temporary one, can spend someone's key or read their chats. Conversations are personal: they are written directly, never added to the sync log or bootstrap, and any other member's chat is a 404.

## Configuration

- `MCP_INTERNAL_URL`: where the API reaches the MCP server (default `http://127.0.0.1:${MCP_PORT:-4100}/mcp`; compose sets `http://mcp:4100/mcp`). The MCP server always accepts that hostname, even when `MCP_ALLOWED_HOSTS` is set.
- `BETTER_AUTH_SECRET`: keys are sealed under a key derived from it (see above).

## Upgrading from the runner

Migrations `0090`-`0092` add the new tables, then drop the runner tables and revoke the API tokens runners were paired with. Stop old API instances before migrating: an old instance still running against the new schema fails on assistant turns and on password reset (which used to remove runners). Members who paired a read-and-write runner start on the read-only scope, because the choice now lives in `assistant_settings`; they pick **Read and change things** again under Settings → Assistant. Runner machines can uninstall the runner; it no longer connects to anything.

## Limits

- **Multiple API processes.** Claims, replies, turns and the browser's event log live in Postgres, so any instance can serve a browser. A turn runs in the process that took the prompt; if that process stops, the sweep ends the reply with an error and the member sends it again.
- **No tool approvals in the browser yet.** The agent can use the Knotworking tools its token allows and nothing else. Person-only actions (sign-offs, approvals) stay refused, as for any token.
- **No spend controls.** Cost is whatever the member's own account allows, bounded per reply by the step cap and timeout and per member by 3 concurrent replies.
