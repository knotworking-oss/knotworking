# Workforce and HR

The workforce module extends the People register with whole-day leave, sickness records, privacy-limited availability, rotas, and payroll exports.

## Access and privacy

Two optional-access modules separate planning from private employment/health records:

- `workforce` depends on People and defaults to no member access. Read access permits the individual's own request workflow and the planning availability view. Personal submission/withdrawal routes are deliberate read-level writes, like other personal acknowledgements. They require an account session, never an agent token.
- `workforce_hr` depends on Workforce and defaults to no member access. Its readers can inspect the private absence register and audit history. Managing access is needed to enter a record on someone's behalf, approve/reject leave, acknowledge sickness, cancel a record or correct dates/HR notes. Every HR route requires a signed-in person; tokens and MCP cannot access it.

Owners/admins have manage access through the existing module rules. Other members need explicit grants, with readable dependencies. The pages are `/<workspace>/workforce` and `/<workspace>/workforce/hr`. Navigation follows these grants. Environment module switches hide the corresponding workflows. When Private HR is inactive, both self-service data and derived planning data are withheld; availability explicitly reports `sourceEnabled: false`, not an all-clear.

The self-service account must be linked to an active People record. Self-service history is additionally bound to the original submitting user, and never includes HR notes or review evidence. Changing the login link in People does not give the new account the earlier user's private history. HR-entered records are kept in the HR register; the individual's page explicitly lists records **they submitted**. The safe availability view still includes the operational unavailable dates of HR-entered records.

All absence rows, notes and events are private database records, deliberately excluded from workspace bootstrap, shared sync, search, attachments, notifications and token tools. Personal command receipts contain only the personal projection. No email, calendar event or external message is sent by this milestone.

## Requests, decisions and corrections

Staff request annual/other leave over inclusive whole-day dates, or report sickness with a known last day or an ongoing end. Submission notes are private to that submitting account and authorised HR readers. HR can create records for existing People entries, including staff without a login and closed historical ranges for leavers.

Leave starts `pending`; HR may `approve` or `reject` it. The employee may withdraw only their own pending leave. Sickness starts `reported`; HR `record`s its acknowledgement. This is acknowledgement of an absence record, not medical approval of an illness. An HR manager cannot decide or correct their own absence: both the original self-service author and the currently linked subject are checked. HR-entered records for another colleague can be handled by the entering manager.

HR cancellation retains the original record and history. A correction can change dates or a private HR note on an active record, with a reason and reviewed revision. Record a last sickness day this way when an ongoing absence ends; the former open interval remains in retained evidence. Closed rejected/cancelled records are not silently reopened or edited; a new record represents a new absence.

Every command has a durable UUID receipt. Retrying identical commands returns the earlier result; reusing a command for different data conflicts. Workspace locks and reviewed revisions prevent concurrent approvals, withdrawals and corrections from overwriting one another. Staff ownership and permissions are checked before a self-service receipt can be replayed.

Dates are checked against the staff member's recorded employment dates. A sickness report cannot start after the workspace's current business date. There are no invented booking-notice periods, statutory limits, entitlement balances or sickness pay rules.

## Overlaps and planning

Duplicate/overlapping active leave requests and duplicate sickness records are refused. A sickness report is still accepted over already-booked leave so that a current illness is not suppressed by a future booking. HR readers see an overlap marker on both active records and decide how to reconcile the booking under the organisation's policy. Reporting sickness does not automatically cancel leave or reclassify pay.

The planning view includes approved leave and reported/recorded sickness, clips them to the requested date window and merges overlapping ranges per person. It exposes only staff identifiers/names, dates and the constant `unavailable`; it does not expose absence kind, notes, approval state, private record IDs or reviewers. Pending, rejected and cancelled leave is excluded. This is recorded absence availability, not a judgement that a person is employed, present, competent or sufficient for a particular shift.

Queries cover at most 366 days and page 100 merged ranges. A scan with more than 5,000 source records is refused with a request to narrow the dates, rather than returning a partial all-clear. HR registers and history page 50 rows; staff search shows at most 100 matches and asks the reader to refine it. A People entry with any retained absence history cannot be deleted or renumbered; make it a leaver instead. Deletion and absence creation share the workspace lock.

The sole MCP tool, `get_workforce_availability`, uses this same safe projection and declares `module: workforce`. There are no tools for personal requests, HR notes, decisions or private history.

## Verification and limits

Core tests cover whole-day/open-ended dates, privileged-input refusal and bounded queries. Real API tests cover personal ownership, command retries, stale and concurrent work, independent HR grants, approval rules, sickness acknowledgement/correction, booked-leave overlap, interval merging, cross-workspace isolation, login relinking, deletion protection, workspace dates and sync privacy. MCP tests cover the read-only projection and module visibility. Browser verification exercises the employee → HR → availability workflow.

Half-day/hour requests, entitlements/holiday calendars, attachments to HR records, return-to-work interviews, fit-note workflows, payroll calculations/exports and production scheduling are future milestones. Rotas, agency labour and competence-based staffing follow below (3.4.4.2–3.4.4.3). Existing Attendance and Training remain authoritative for clock times and qualifications. No payroll or statutory submission is performed.

## Rotas, working patterns and agency workers (3.4.4.2)

Rotas build on People: everyone on a rota is a staff record, including agency workers, so Training, kiosk clocking and attendance apply to them unchanged. There is no second worker register. The page is `/<workspace>/workforce/rota`.

- **Shifts** have a name, a 24-hour start and end time (an end at or before the start finishes the next day) and an optional production line. Names are unique per workspace. Once a shift has rota entries its times are fixed, so past entries keep their meaning; create a new shift for different hours. A shift with entries from today onwards can't be deactivated until they're cancelled.
- **Rota entries** put one person on one shift on one date (the date the shift starts), optionally covering a job role they hold, with a note. An entry is refused (`409 rota_<reason>`) when the shift is inactive, the person isn't employed that day (People start/end dates; a leaver needs an end date), doesn't hold the role, is already on that shift, or would work overlapping hours on another shift. Overlaps use absolute times, so a night shift into the next morning is checked against the next day. Entries are cancelled with a reason, not deleted; a person can be rostered again after a cancellation.
- **Recorded absences:** while Private HR records are on, a person recorded as unavailable that day (approved leave, reported or recorded sickness) can't be rostered. If an absence is recorded after they were rostered, the entry stays and the rota marks it `unavailable: true`. With Private HR off, `absenceSourceEnabled` is false and `unavailable` is null rather than an all-clear. Only this same date-level projection is used; no absence kind, note or review state appears on the rota.
- **Working patterns** give a person a shift on chosen weekdays from a date, optionally until a date and covering a role. **Generate rota** (at most 62 days, optionally for chosen people) turns patterns into entries. Every covered day either becomes an entry or is reported as skipped with the same reasons as above; nothing existing is changed. Repeating the command returns its first receipt; a new command over the same dates skips what's already there. Ending a pattern never extends it, and already generated entries stay until cancelled.
- **Agencies and engagements:** an agency has a name and contact. An engagement records that a People record is supplied by an agency from a date, optionally until a date, with the agency's reference. One person can't have overlapping engagements, and an engagement must sit within the person's People employment dates. The rota and staffing check show the agency on each entry for that date. Ending an engagement never extends it.
- **My shifts:** `GET /workforce/rota/me` returns the caller's own entries through their People login link.

Access follows the `workforce` module: read views the rota, patterns, agencies and the staffing check; write adds and cancels entries, patterns and generation; manage sets up shifts, agencies, engagements and staffing requirements. These are ordinary planning records, so personal API tokens may use them within their scope and module grants. Rota records stay out of shared sync like absences: Workforce defaults to no member access and rotas show individual schedules. Views are bounded to 31 days and 5,000 entries; generation to 62 days and 5,000 new entries.

## Competence-based staffing (3.4.4.3)

A **staffing requirement** says what a shift needs: a headcount of people holding a job role and/or current on up to ten Training courses, on chosen weekdays, between dates. It applies either on every scheduled day or **only when production is planned** on the shift's line (planned or in-progress batches that day, and not a workspace or line non-working day). Requirements are checked independently, so one person can count towards several (an operative who is also the first aider). Requirements on a deactivated shift are ignored, and a new or reactivated requirement needs an active shift. Every reference (shift, role, courses) must belong to the workspace, even on an inactive requirement. A course archived after it was added stays on the requirement (reported as `course_archived`) until removed; newly added courses must be active. The page is `/<workspace>/workforce/staffing`.

The **staffing check** (`GET /workforce/staffing`, at most 31 days) reports, for each date and shift with people rostered or a requirement in effect: who is rostered (with agency and unavailability), the production planned on the line, and for each requirement whether it applies, who counts, the shortfall and why each other rostered person doesn't count:

- `unavailable`: recorded as unavailable that day (only while Private HR records are on);
- `role_not_held`: doesn't hold the required job role in People;
- `training_missing`, `training_expired`, `training_awaiting_sign_off`, `training_outdated` (an earlier SOP version), `course_archived`: Training's own standing for the course, with the course and expiry date;
- `training_expires_before_shift`: current today but expiring before the shift date.

Competence uses the Training matrix's rules (`competenceLookup`, published through `services/ports/training.ts`): training counts when current or expiring today, signed off where the course requires it, on the SOP's current version, and still valid on the shift date. Leavers still within their notice period keep their standings. Readers without Training access see the shortfall and `competence_not_met` instead of per-course detail, and the requirements list returns `courses: null` for them. Planned batches per line (`production`) and line names on shifts are returned only to Production readers; production-linked requirements are still applied for everyone. The summary gives requirement checks, shortfalls and unfilled positions. The response states `absenceSourceEnabled`, `trainingSourceEnabled` and `productionSourceEnabled`; a requirement that can't be evaluated because its source is off reports `applies: null` with the reason, never a pass.

The check is advisory: it doesn't block rostering, production or clocking, and it sends no notifications. MCP adds `get_rota` and `get_staffing_check` (read-only, `module: workforce`).

### Acceptance

`apps/server/src/workforce-staffing.test.ts` runs the section scenario through the real API. An early shift on Line 1 needs two allergen-trained line operatives and, when production is planned, a first aider. Four people are rostered: one qualifies, one's training lapses before the shift, one is an agency worker without the role or training, and one awaits sign-off. The check reports a shortfall of one with each reason. Planning a batch brings the first-aider requirement into force; a line non-working day takes it out; leave approved after rostering removes a counted person. Rota tests (`workforce-rota.test.ts`) cover overlaps across midnight, employment dates, roles, absences, generation reports and receipts, shift changes, agencies, module levels, tokens and Private HR being off.

### Limits

Unnamed agency bookings (a headcount ordered without a named worker), shift swaps and staff self-rostering, hours/overtime rules, rest-period and working-time checks, skills levels beyond Training courses, automatic rota optimisation, shortfall notifications and pay calculations are not built. Requirements count people, not hours; there is no partial-shift cover.

## Payroll runs and package exports (3.4.4.4)

A **payroll run** freezes one pay period (at most 93 days) into a reviewed, immutable snapshot that payroll files are built from. The page is `/<workspace>/workforce/hr/payroll`, linked from Private HR records. Knotworking records hours and absence days; it never calculates pay, holiday entitlement, statutory sick pay or tax, and there is no payroll ledger.

**What a snapshot holds:**

- Per employee: staff number, payroll reference, names, shifts, and basic and overtime minutes from Attendance. These use the same shift pairing, rounding, breaks and whole-week overtime as the attendance payroll preview (`payrollPeriodTotals`).
- Per employee: **calendar days** of annual leave, other leave and sickness in the period, from approved leave and reported or recorded sickness. Each day counts once per kind, and days are clipped to the person's People employment dates. Open-ended sickness counts only up to today. These are not working days or hours: the package applies its own working patterns and pay rules.
- **Agency workers** are listed separately with their hours, for reconciling the agency's invoice, and are never exported as employees, because their agency pays them. Someone agency-supplied for only **part** of the period is split. Hours on dates their engagement covers go to the agency list, and their absences on those dates are dropped (the agency handles them). Hours and absences on the other dates form an employee row. A warning notes that overtime weeks spanning the change count the whole week's hours towards the threshold.
- The package references in force (Sage payment references), copied in so a file can be rebuilt exactly. Warnings cover unfinished periods, unacknowledged sickness reports, sickness during booked leave, part-period agency engagements and missing payroll references.

**Blockers.** A run can't be prepared while any shift in the period has a missing or overlong clock event, anyone is still clocked in, a leave request overlapping the period awaits a decision, or someone who has left still has sickness with no last day (`409 payroll_run_blocked`, listing each). Preview first with `GET /workforce/hr/payroll-runs/preview`.

**Lifecycle.**

- **Prepared** by one person.
- **Approved** with a note by a different person (`payroll_run_four_eyes`), who must not have their own hours or absences in the run (`payroll_run_own_record`). This is checked against both today's People login links and those recorded when the run was prepared, so unlinking a record first doesn't get round it.
- Only approved runs can be **exported**. Live runs can't overlap (`payroll_run_overlap`). A prepared run that's wrong or stale (wrong dates, records changed since, an unwanted correction) is **withdrawn** with a reason, which frees its period; it stays in the list with its history.
- A **correction** of an approved run is a new version built from today's records, with a reason. Approving it marks the original `superseded`, which can then no longer be exported. Nothing is edited in place.
- Commands have durable receipts and reviewed revisions. The private history records each step: prepared, approved, exported, correction prepared, superseded.

**Exports and package compatibility.** Exports are built only from the approved snapshot. Each export is recorded with the adapter, file name, SHA-256 of the file, snapshot hash and person; the file itself isn't stored. Repeating an export command by the same person for the same adapter returns the file without recording it twice; a replay for a different adapter or by someone else is refused (`command_conflict`). Adapters implement `PayrollExportAdapter` in `@knotworking/core` (`payroll-runs.ts`): an ID, a label, whether the layout carries absences, problems that block it, and `build`. Each declares its **package compatibility**:

- `teamflow_hr_csv`: Knotworking's own documented layout of hours plus absence days. Compatibility is `not_applicable`: it implies no package import.
- `sage50_payroll_hours`: Sage 50 Payroll hours by payment reference, built from Sage's published conventions. It is `unverified`, so exporting needs an explicit acknowledgement, which is recorded on the export. Every employee needs a payroll reference, and one starting with `=`, `+`, `-`, `@` or a tab is refused, because CSV formula escaping would stop Sage matching it. It doesn't carry absences; the export returns the employees whose absences must be entered by hand.
- `verified` needs named evidence: a comparison with the package's own import template and a successful test import, done separately for each package and version. No adapter is verified in this repository. Adding one is a new registry entry with tests; verification is an installation's acceptance step, not a code claim.

**Access and privacy.** Every payroll-run route needs a signed-in person with Private HR records `manage` and Attendance `manage`; personal API tokens are refused, and there are no MCP tools. Runs and their history are private records outside shared sync. The live attendance payroll preview and CSV (`/attendance/payroll`) are unchanged.

**Verification.** `apps/server/src/payroll-runs.test.ts` covers blockers, snapshot contents against the attendance payroll figures, absence days, agency separation, overlap refusal, approval rules, export recording and idempotency, unverified-layout acknowledgement, copied references and corrections superseding the original, own-record refusal and access. `packages/core/src/payroll-runs.test.ts` covers the adapter layouts and compatibility declarations.

**Limits.** Pay rates, gross-to-net, holiday accrual and statutory sick pay calculations, pension and RTI submissions, direct package APIs, part-day absences and storing exported files are not built.
