import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(status, { message });
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "invalid_input", message, details);

/**
 * Whether an error is a Postgres primary-key violation. Drizzle wraps driver errors
 * (`DrizzleQueryError.cause`); PGlite reports `constraint`, postgres.js `constraint_name`.
 * This is how a client-supplied `id` that already exists surfaces from a create.
 */
export function isPrimaryKeyViolation(err: unknown): boolean {
  for (let e: any = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (e.code === "23505") {
      return String(e.constraint ?? e.constraint_name ?? "").endsWith("_pkey");
    }
  }
  return false;
}
