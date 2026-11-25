import {
  attachmentTargetScope,
  biCanManagePacks,
  biCanReadDashboardHistory,
  biCanViewPack,
  type BiBoardPackAccessFields,
  biCanViewDashboard,
  type BiDashboardAccessFields,
  hasModuleLevel,
  isAttachmentTargetType,
  isModuleId,
  moduleOfEntity,
  type ModuleAccessMap,
  type ModuleId,
  type SyncChange,
  type WorkspaceRole,
} from "@knotworking/core";

/** Who is asking; decides what parts of a meeting row they may see. */
export interface Viewer {
  role: WorkspaceRole;
  userId: string;
  /** The viewer's module levels; needed to filter dashboards by audience in the sync log. */
  modules?: ModuleAccessMap;
}

/** Meeting columns that identify the organizer's external calendar event. */
const EXTERNAL_LINK_FIELDS = ["connectionId", "externalEventId", "htmlLink"] as const;

const isAdmin = (role: WorkspaceRole) => role === "owner" || role === "admin";

/**
 * A meeting row as one viewer may see it:
 *  - `connectionId`, `externalEventId` and `htmlLink` point into the organizer's own calendar,
 *    so only the organizer and workspace admins get them (everyone else sees `null`).
 */
export function redactMeeting<T extends Record<string, unknown>>(viewer: Viewer, meeting: T): T {
  if (isAdmin(viewer.role) || (meeting.organizerId != null && meeting.organizerId === viewer.userId)) {
    return meeting;
  }
  const out: Record<string, unknown> = { ...meeting };
  for (const field of EXTERNAL_LINK_FIELDS) if (field in out) out[field] = null;
  return out as T;
}

/** Guests (outside collaborators) see attendee names but not the team's email addresses. */
export function redactAttendee<T extends { email: string }>(viewer: Viewer, attendee: T): T {
  return viewer.role === "guest" ? { ...attendee, email: "" } : attendee;
}

/** A meeting with its attendees, as one viewer may see it. */
export function redactMeetingWithAttendees<
  T extends Record<string, unknown> & { attendees: { email: string }[] },
>(viewer: Viewer, meeting: T): T {
  const redacted = redactMeeting(viewer, meeting);
  return { ...redacted, attendees: redacted.attendees.map((a) => redactAttendee(viewer, a)) } as T;
}

/**
 * Applies the viewer's redactions to the raw sync log (`GET /sync`). Guest email blanking is done
 * separately by the route (it applies to every entity carrying an email).
 *  - A meeting's calendar links go only to its organizer and admins.
 *  - A member's access level in a module (`module_access`) goes only to that member and admins:
 *    clients refetch when their own access changes, and nobody else needs to see who may do what
 *    (it would show guests and ungranted members who holds people, payroll or accounting access).
 */
export function redactChanges(viewer: Viewer, changes: SyncChange[]): SyncChange[] {
  const visible = isAdmin(viewer.role)
    ? changes
    : changes.filter((change) => change.entity !== "module_access" || change.data?.userId === viewer.userId);
  const dashboardViewer = { userId: viewer.userId, role: viewer.role, modules: viewer.modules ?? {} };
  return visible.flatMap((change): SyncChange[] => {
    // Dashboard versions (the spec history) go only to those who may change the dashboard.
    if (change.entity === "bi_dashboard_version") {
      // A version row carries its dashboard's owner and scope (a module dashboard needs that module).
      const fields = {
        ownerId: (change.data?.ownerId as string | null) ?? null,
        scope: String(change.data?.scope ?? "workspace"),
      };
      return change.action === "upsert" && !biCanReadDashboardHistory(fields, dashboardViewer)
        ? []
        : [change];
    }
    if (change.action !== "upsert" || !change.data) return [change];
    // A dashboard the viewer may not open arrives as a tombstone (only its id), so one that was
    // unpublished, archived or narrowed to other people disappears from their copy.
    if (change.entity === "bi_dashboard") {
      return biCanViewDashboard(change.data as unknown as BiDashboardAccessFields, dashboardViewer)
        ? [change]
        : [{ ...change, action: "delete", data: null }];
    }
    // Snapshot headers go to the people who may open snapshots; pack headers to the pack's readers.
    if (change.entity === "bi_snapshot") {
      return biCanManagePacks(dashboardViewer) ? [change] : [{ ...change, action: "delete", data: null }];
    }
    if (change.entity === "bi_board_pack") {
      return biCanViewPack(change.data as unknown as BiBoardPackAccessFields, dashboardViewer)
        ? [change]
        : [{ ...change, action: "delete", data: null }];
    }
    if (change.entity === "meeting") {
      return [{ ...change, data: redactMeeting(viewer, change.data) }];
    }
    return [change];
  });
}

/**
 * Drops sync-log changes of modules the viewer can't read (or that are switched off), as the
 * bootstrap does. Platform entities pass, except attachments, which follow the task or document
 * they hang on (a task, a document or a module's record), and API access toggles (`token_action`), which follow their action's module.
 * Deletes carry no data, so an attachment tombstone always passes (it is only an id). The page's
 * cursor is untouched: the viewer still advances past what they may not see.
 */
export function filterChangesByModule(modules: ModuleAccessMap, changes: SyncChange[]): SyncChange[] {
  const can = (id: "tasks" | "docs" | "time" | "calendar") => hasModuleLevel(modules[id], "read");
  return changes.filter((change) => {
    if (change.entity === "hse_permit" && !hasModuleLevel(modules.assets, "read")) return false;
    if (change.entity === "quality_recall_test" && !hasModuleLevel(modules.stock, "read")) return false;
    if (
      (change.entity === "quality_sales_volume" || change.entity === "quality_authenticity") &&
      !hasModuleLevel(modules.items, "read")
    )
      return false;
    if (change.entity === "site_asset" && !hasModuleLevel(modules.haccp, "read")) return false;
    if (change.entity.startsWith("site_checklist_") && !hasModuleLevel(modules.checklists, "read"))
      return false;
    const owner = moduleOfEntity(change.entity);
    if (owner) return hasModuleLevel(modules[owner], "read");
    // An API access toggle belongs to the module its action is in.
    if (change.entity === "token_action" && change.data && isModuleId(String(change.data.module))) {
      return hasModuleLevel(modules[change.data.module as ModuleId], "read");
    }
    if (change.entity === "attachment" && change.data) {
      if (change.data.taskId) return can("tasks");
      if (change.data.documentId) return can("docs");
      // A file on a module record follows that record's module.
      if (change.data.entityType) {
        const type = String(change.data.entityType);
        if (!isAttachmentTargetType(type)) return false;
        const target = attachmentTargetScope(type);
        return [target.module, ...target.requiresModules].every((id) => hasModuleLevel(modules[id], "read"));
      }
    }
    return true;
  });
}
