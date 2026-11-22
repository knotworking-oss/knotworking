import type { DocumentMeta } from "./api";
import type { WorkspaceIndex } from "./model";

/**
 * A doc can be attached to one team and/or one project (`documents.teamId` / `projectId`).
 * These helpers are the pure logic behind the Docs sections and the attachment control.
 */

/** Which team or project a "Docs" section belongs to. Exactly one of the two is set. */
export type DocScope = { teamId: string; projectId?: undefined } | { projectId: string; teamId?: undefined };

/** The fields a new doc created from a scope starts with. */
export function scopeAttachment(scope: DocScope) {
  return scope.teamId ? { teamId: scope.teamId } : { projectId: scope.projectId };
}

/**
 * The docs attached to a team or project, in tree order (the store keeps docs sorted by `sortOrder`).
 * Subpages count too: a nested doc attached to the project is listed on its own, however deep it sits.
 */
export function docsInScope(docs: readonly DocumentMeta[], scope: DocScope): DocumentMeta[] {
  return docs.filter((d) => (scope.teamId ? d.teamId === scope.teamId : d.projectId === scope.projectId));
}

/**
 * What a doc is attached to, resolved against the live workspace. A link to a team or project the
 * client doesn't have (an archived team stays linked on the server, a deleted project is cleared) is
 * treated as no attachment, so the UI never shows a dangling chip.
 */
export function resolveAttachment(doc: Pick<DocumentMeta, "teamId" | "projectId">, idx: WorkspaceIndex) {
  return {
    team: doc.teamId ? idx.teams.get(doc.teamId) : undefined,
    project: doc.projectId ? idx.projects.get(doc.projectId) : undefined,
  };
}
