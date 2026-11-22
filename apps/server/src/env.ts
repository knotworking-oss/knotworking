import type {
  ApiTokenScope,
  ModuleAccessMap,
  ModuleId,
  TokenActionId,
  WorkspaceRole,
} from "@knotworking/core";
import type { Database } from "@knotworking/db";
import type { AccountingAdapterRegistry } from "./accounting/registry";
import type { AssistantHub } from "./assistant-hub";
import type { AssistantProviderRegistry } from "./services/assistant-providers";
import type { AssistantTurnRunner } from "./services/assistant-turn";
import type { Auth } from "./auth";
import type { CalendarDeps } from "./calendar/sync";
import type { Mailer } from "./mailer";
import type { Storage } from "./storage";
import type { SyncHub } from "./sync-hub";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/** How the request authenticated: a Better Auth session (cookie or session bearer) or a personal API token. */
export type Credential =
  | { kind: "session" }
  | {
      kind: "token";
      scope: ApiTokenScope;
      tokenId: string;
      modules: ModuleId[] | null;
      /**
       * The person-only actions the token may use when the workspace allows them; `null` or absent:
       * every action the workspace allows (tokens made before allowlists existed).
       */
      tokenActions?: TokenActionId[] | null;
      /** The most this token may send a purchase order for (`purchasing.send`); null or absent: no cap. */
      maxOrderValue?: number | null;
    };

export interface CurrentWorkspace {
  id: string;
  slug: string;
  name: string;
  /** IANA zone every business date is decided in (`todayIn(c)` gives today there). */
  timeZone: string;
  /** ISO 4217 code costs and prices are shown in (`GBP` by default). */
  currency: string;
  role: WorkspaceRole;
  /** The caller's effective level per active module (see `@knotworking/core` modules.ts). */
  modules: ModuleAccessMap;
}

export interface Services {
  db: Database;
  auth: Auth;
  mailer: Mailer;
  appUrl: string;
  providers: ("google" | "github" | "microsoft")[];
  calendar: CalendarDeps;
  setupToken: string | undefined;
  /** Server push: tells `/events` listeners when a workspace's sync log advances. */
  syncHub: SyncHub;
  /** How often an open `/events` stream re-checks its credential and membership (ms). */
  streamRevalidateMs: number;
  /** Attachment bytes (local disk or S3-compatible). */
  storage: Storage;
  /** Largest accepted upload, in bytes. */
  uploadMaxBytes: number;
  /** Modules switched on in this environment (`KNOTWORKING_MODULES`). */
  activeModules: readonly ModuleId[];
  /** Key kiosk PINs are hashed under, derived from the server secret (`services/people.ts`). */
  staffPinKey: Buffer;
  /** Key signed attachment download links are made under, derived from the server secret. */
  attachmentLinkKey: Buffer;
  /** Stores assistant replies and streams them to browsers (docs/assistant.md). */
  assistantHub: AssistantHub;
  /** Runs assistant turns in this process, with the member's own API key. */
  assistantTurns: AssistantTurnRunner;
  /** The model providers a member can bring a key for. */
  assistantProviders: AssistantProviderRegistry;
  /** Key members' provider API keys are sealed under, derived from the server secret. */
  assistantKeyKey: Buffer;
  /** Accounting adapters installed in this process; empty unless configured (docs/accounting.md). */
  accountingAdapters: AccountingAdapterRegistry;
  /**
   * Runs a request through this app (no network), for reading an analysis's sources again with
   * the caller's own credential (services/bi/analysis.ts).
   */
  internalFetch: (request: Request) => Promise<Response>;
}

export interface AppEnv {
  Variables: Services & {
    user: AuthUser;
    credential: Credential;
  };
}

export interface WorkspaceEnv {
  Variables: AppEnv["Variables"] & {
    workspace: CurrentWorkspace;
  };
}
