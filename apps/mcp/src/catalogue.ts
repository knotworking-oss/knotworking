import { moduleIds, modules as moduleManifest, type ModuleId, type TokenActionId } from "@knotworking/core";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ToolError } from "./api";

/**
 * The tool catalogue (docs/mcp.md, "Catalogue mode"). Every tool a connection is offered is an
 * entry here, whether or not it is listed natively:
 *
 *  - resource operations (`list_items`, `get_item`, …) are reached through the reusable
 *    `find_records` / `get_record` tools;
 *  - other module tools are described on demand (`describe_module`) and called through
 *    `run_module_tool`;
 *  - pinned tools are always listed natively.
 *
 * An entry exists only when its tool is offered (module, token action and read-only checks in
 * `define`), so what `list_modules` / `describe_module` show and what the dispatchers accept are
 * decided by one gate: a hidden tool is indistinguishable from a misspelt one.
 */

/** How a connection lists tools: the small catalogue core (default) or every tool natively. */
export const toolListModes = ["catalogue", "all"] as const;
export type ToolListMode = (typeof toolListModes)[number];

export type ResourceOp = "list" | "get";

export interface ToolEntry {
  name: string;
  module: ModuleId | "platform";
  title: string;
  description: string;
  annotations: Record<string, boolean>;
  input: z.ZodRawShape;
  resource?: { name: string; op: ResourceOp };
  pinned: boolean;
  tokenAction?: TokenActionId;
  requiresModules?: readonly ModuleId[];
  /** Runs the tool with already validated arguments. Never throws: errors are tool results. */
  invoke(args: Record<string, unknown>): Promise<CallToolResult>;
}

/** Which entries the caller is shown: everything, or what its user's access allows. */
export type CatalogueView = (entry: ToolEntry) => boolean;

/** What a caller may see: its readable modules and enabled token actions (docs/mcp.md). */
export interface CallerAccess {
  modules: readonly ModuleId[];
  tokenActions: readonly TokenActionId[];
}

/** The listing gate as a view: the same checks `define` applies when it registers a tool. */
export function viewFor(access: CallerAccess): CatalogueView {
  const modules = new Set(access.modules);
  const actions = new Set(access.tokenActions);
  return (e) =>
    (e.module === PLATFORM || modules.has(e.module)) &&
    !e.requiresModules?.some((m) => !modules.has(m)) &&
    (!e.tokenAction || actions.has(e.tokenAction));
}

const everything: CatalogueView = () => true;

interface Resource {
  name: string;
  module: ModuleId | "platform";
  list?: ToolEntry;
  get?: ToolEntry;
  /** The `get` tool's identifying parameter (its only required one besides `workspace`). */
  idParam?: string;
}

/** Shown as the module of the platform tools (tasks-free workspace orientation, attachments). */
export const PLATFORM = "platform";

const isRequired = (schema: z.ZodType) => !schema.safeParse(undefined).success;

const without = (shape: z.ZodRawShape, ...keys: string[]) =>
  Object.fromEntries(Object.entries(shape).filter(([k]) => !keys.includes(k))) as z.ZodRawShape;

/** A zod shape as compact JSON Schema (what `tools/list` would show for it). */
export function jsonSchemaOf(
  shape: z.ZodRawShape,
  compact: (node: unknown) => unknown,
): Record<string, unknown> {
  return compact(z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" })) as Record<
    string,
    unknown
  >;
}

/** zod issues as one line the agent can act on, naming the accepted fields. */
function invalid(what: string, error: z.ZodError, accepted: string[]): ToolError {
  const issues = error.issues
    .map((i) => {
      if (i.code === "unrecognized_keys") return `unknown field(s) ${i.keys.join(", ")}`;
      const at = i.path.join(".");
      return at ? `${at}: ${i.message}` : i.message;
    })
    .join("; ");
  return new ToolError(
    "invalid_input",
    `Invalid ${what}: ${issues}. Accepted fields: ${accepted.join(", ") || "none"}.`,
  );
}

/**
 * Two views of one set of tools. **Running** a call uses every registered entry (the API checks
 * each call, as it does for a tool called by name). **Showing** anything (`tools/list`,
 * `list_modules`, `describe_module`, the overview's module summary, and the names and fields in
 * an error) goes through the caller's view, so the agent never learns more than its listing says,
 * and a hidden name is answered exactly like a misspelt one. Over HTTP the view reads the user's
 * access lazily, only when something is shown; over stdio every entry is already the user's.
 */
export class Catalogue {
  readonly entries = new Map<string, ToolEntry>();
  private resources = new Map<string, Resource>();
  private viewed: Promise<CatalogueView> | undefined;

  constructor(private readonly loadView: () => Promise<CatalogueView> = async () => everything) {}

  /** The caller's view, read at most once per catalogue (one HTTP request, or the stdio process). */
  view(): Promise<CatalogueView> {
    return (this.viewed ??= this.loadView());
  }

  add(entry: ToolEntry) {
    if (this.entries.has(entry.name)) throw new Error(`Duplicate MCP tool ${entry.name}`);
    this.entries.set(entry.name, entry);
    if (!entry.resource) return;
    const { name, op } = entry.resource;
    const r = this.resources.get(name) ?? { name, module: entry.module };
    if (r.module !== entry.module) throw new Error(`Resource ${name} spans modules`);
    if (r[op]) throw new Error(`Resource ${name} has two ${op} tools`);
    if (op === "get") {
      const required = Object.keys(without(entry.input, "workspace")).filter((k) =>
        isRequired(entry.input[k] as z.ZodType),
      );
      if (required.length !== 1)
        throw new Error(`${entry.name}: a resource get needs exactly one required parameter`);
      r.idParam = required[0]!;
    }
    r[op] = entry;
    this.resources.set(name, r);
  }

  /** A resource as the view shows it: only its visible operations, or nothing. */
  private visibleResource(r: Resource, view: CatalogueView): Resource | undefined {
    const list = r.list && view(r.list) ? r.list : undefined;
    const get = r.get && view(r.get) ? r.get : undefined;
    if (!list && !get) return undefined;
    return { ...r, list, get };
  }

  private visibleResources(view: CatalogueView, module?: string) {
    return [...this.resources.values()]
      .filter((r) => module === undefined || r.module === module)
      .map((r) => this.visibleResource(r, view))
      .filter((r): r is Resource => r !== undefined);
  }

  /** Modules with at least one visible tool, in manifest order (platform first). */
  private moduleOrder(view: CatalogueView): Array<ModuleId | "platform"> {
    const used = new Set([...this.entries.values()].filter(view).map((e) => e.module));
    return [PLATFORM as "platform", ...moduleIds].filter((m) => used.has(m));
  }

  /** `list_modules`: what each module offers, names only. `core` are the tools listed natively. */
  async summary(mode: ToolListMode) {
    const view = await this.view();
    const entries = [...this.entries.values()].filter(view);
    return {
      howTo:
        mode === "catalogue"
          ? "Read with find_records / get_record. For anything else, call describe_module once for the module, then run_module_tool."
          : "Every tool is listed. Records can also be read with find_records / get_record.",
      core: entries.filter((e) => e.pinned).map((e) => e.name),
      modules: this.moduleOrder(view).map((m) => ({
        id: m,
        name: m === PLATFORM ? "Workspace" : moduleManifest[m].name,
        resources: this.visibleResources(view, m).map((r) => r.name),
        tools: entries
          .filter((e) => e.module === m && !e.pinned && (mode === "all" || !e.resource))
          .map((e) => e.name),
      })),
    };
  }

  /** `describe_module`: full schemas for one module's visible resources and tools. */
  async describe(module: string, compact: (node: unknown) => unknown) {
    const view = await this.view();
    const order = this.moduleOrder(view);
    if (!order.includes(module as ModuleId))
      throw new ToolError(
        "not_found",
        `No module "${module}" is available. Available: ${order.join(", ") || "none"}.`,
      );
    return {
      module,
      resources: this.visibleResources(view, module).map((r) => ({
        name: r.name,
        ...(r.list
          ? {
              list: {
                tool: r.list.name,
                description: r.list.description,
                filters: jsonSchemaOf(without(r.list.input, "workspace"), compact),
              },
            }
          : {}),
        ...(r.get
          ? {
              get: {
                tool: r.get.name,
                description: r.get.description,
                id: jsonSchemaOf({ [r.idParam!]: r.get.input[r.idParam!]! }, compact).properties,
                options: jsonSchemaOf(without(r.get.input, "workspace", r.idParam!), compact),
              },
            }
          : {}),
      })),
      tools: [...this.entries.values()]
        .filter((e) => view(e) && e.module === module && !e.resource && !e.pinned)
        .map((e) => ({
          name: e.name,
          title: e.title,
          description: e.description,
          readOnly: e.annotations.readOnlyHint === true,
          input: jsonSchemaOf(e.input, compact),
        })),
    };
  }

  /** The identifying parameter of a resource's get tool. */
  idParamOf(name: string) {
    return this.resources.get(name)?.idParam;
  }

  /** The not-found answer, naming only what the caller's view shows. */
  private async noResource(name: string) {
    const names = this.visibleResources(await this.view()).map((r) => r.name);
    return new ToolError(
      "not_found",
      `No resource "${name}" is available. Available: ${names.join(", ") || "none"}.`,
    );
  }

  private async noTool(name: string) {
    return new ToolError(
      "unknown_tool",
      `No tool "${name}" is available. Use list_modules and describe_module to see the tools you can call.`,
    );
  }

  /**
   * A failed check names fields, which would describe a hidden tool: hidden ones get the same
   * answer as a misspelt name. (A valid call to a hidden tool is left to the API, which refuses it.)
   */
  private async refuse(entry: ToolEntry, error: ToolError, missing: () => Promise<ToolError>) {
    return (await this.view())(entry) ? error : missing();
  }

  /** `find_records`: the resource's list tool, with `filters` checked against its own schema. */
  async find(name: string, filters: Record<string, unknown>, workspace: string | undefined) {
    const r = this.resources.get(name);
    if (!r) throw await this.noResource(name);
    if (!r.list) {
      const shown = r.get && (await this.view())(r.get);
      throw shown
        ? new ToolError(
            "unsupported_operation",
            `"${name}" can't be listed; use get_record with an id or reference.`,
          )
        : await this.noResource(name);
    }
    const shape = without(r.list.input, "workspace");
    const parsed = z.strictObject(shape).safeParse(filters);
    if (!parsed.success)
      throw await this.refuse(r.list, invalid(`filters for ${name}`, parsed.error, Object.keys(shape)), () =>
        this.noResource(name),
      );
    return r.list.invoke({ ...parsed.data, ...(workspace !== undefined ? { workspace } : {}) });
  }

  /** `get_record`: the resource's get tool, with `id` as its identifying parameter. */
  async get(name: string, id: string, options: Record<string, unknown>, workspace: string | undefined) {
    const r = this.resources.get(name);
    if (!r) throw await this.noResource(name);
    if (!r.get) {
      const shown = r.list && (await this.view())(r.list);
      throw shown
        ? new ToolError(
            "unsupported_operation",
            `"${name}" has no single-record read; use find_records to list it.`,
          )
        : await this.noResource(name);
    }
    const entry = r.get;
    const idParam = r.idParam!;
    const optionShape = without(entry.input, "workspace", idParam);
    const opts = z.strictObject(optionShape).safeParse(options);
    if (!opts.success)
      throw await this.refuse(
        entry,
        invalid(`options for ${name}`, opts.error, Object.keys(optionShape)),
        () => this.noResource(name),
      );
    const idSchema = entry.input[idParam] as z.ZodType;
    // Ids arrive as text; a numeric id parameter accepts its digits.
    let ident = idSchema.safeParse(id);
    if (!ident.success && /^-?\d+(\.\d+)?$/.test(id)) ident = idSchema.safeParse(Number(id));
    if (!ident.success)
      throw await this.refuse(entry, invalid(`id for ${name}`, ident.error, [idParam]), () =>
        this.noResource(name),
      );
    return entry.invoke({
      ...opts.data,
      [idParam]: ident.data,
      ...(workspace !== undefined ? { workspace } : {}),
    });
  }

  /** `run_module_tool`: any registered tool by name, its arguments checked against its own schema. */
  async run(name: string, args: Record<string, unknown>) {
    const entry = this.entries.get(name);
    if (!entry) throw await this.noTool(name);
    const parsed = z.strictObject(entry.input).safeParse(args);
    if (!parsed.success)
      throw await this.refuse(
        entry,
        invalid(`arguments for ${name}`, parsed.error, Object.keys(entry.input)),
        () => this.noTool(name),
      );
    return entry.invoke(parsed.data);
  }

  /** Names of the tools the caller's view hides (the `tools/list` filter). */
  async hiddenNames(): Promise<Set<string>> {
    const view = await this.view();
    return new Set([...this.entries.values()].filter((e) => !view(e)).map((e) => e.name));
  }
}
