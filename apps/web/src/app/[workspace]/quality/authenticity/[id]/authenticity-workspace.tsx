"use client";
import {
  authenticityFactors,
  authenticityFactorLabels,
  authenticityLevels,
  authenticityControlKinds,
  authenticityTriggerKinds,
  authenticityDraftSchema,
  authenticityTriggerSchema,
  newId,
  dateInZone,
  type AuthenticityDetail,
  type AuthenticityDraft,
  type AuthenticityControl,
  type AuthenticityVerification,
} from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { Input } from "@knotworking/ui/components/input";
import { Textarea } from "@knotworking/ui/components/textarea";
import {
  useState,
  useId,
  cloneElement,
  type ReactElement,
  type FormEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AuthenticityReview } from "@/components/authenticity-review";
import { browserApi, unwrap, errorMessage } from "@/lib/auth-client";
import { useWorkspace } from "@/lib/workspace-store";
const selectClass = "rounded-md border bg-background p-2 text-sm";
function F({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <div className="grid gap-1 text-sm">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
    </div>
  );
}
const fieldText = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export function AuthenticityWorkspace({
  slug,
  detail: d,
  users,
  timeZone,
}: {
  slug: string;
  detail: AuthenticityDetail;
  users: { id: string; name: string }[];
  timeZone: string;
}) {
  const { can, viewer } = useWorkspace();
  const router = useRouter();
  const draft = d.versions.find((v) => v.id === d.draftVersionId),
    current = d.versions.find((v) => v.id === d.currentVersionId);
  const [body, setBody] = useState<AuthenticityDraft>(draft?.body ?? authenticityDraftSchema.parse({}));
  const [saved, setSaved] = useState(() => JSON.stringify(body));
  const [stamp, setStamp] = useState(d.updatedAt);
  const [commandId, setCommand] = useState(newId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty = JSON.stringify(body) !== saved,
    stale = new Date(d.updatedAt).getTime() > new Date(stamp).getTime();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const draftBody = authenticityDraftSchema.parse(body);
      const updated = await unwrap(
        browserApi().v1.workspaces[":slug"].quality.authenticity[":id"].draft.$put({
          param: { slug, id: d.id },
          json: { commandId, expectedUpdatedAt: stamp, draft: draftBody },
        }),
      );
      const version = updated.versions.find((v) => v.id === updated.draftVersionId)!;
      setBody(version.body);
      setSaved(JSON.stringify(version.body));
      setStamp(updated.updatedAt);
      setCommand(newId());
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const reload = () => {
    if (!draft) return;
    setBody(draft.body);
    setSaved(JSON.stringify(draft.body));
    setStamp(d.updatedAt);
    setCommand(newId());
    setError("");
  };
  return (
    <div className="space-y-6">
      {d.status === "active" && draft && can("quality", "write") && (
        <section className="space-y-4 rounded-md border p-4">
          <h2 className="text-lg font-semibold">Draft review · Revision {draft.number}</h2>
          <p className="text-sm text-muted-foreground">
            Save the draft before signing. Signed control plans stay in force until a later review is
            approved.
          </p>
          {stale && (
            <div role="alert" className="space-y-2 rounded-md border p-3 text-sm">
              <p>
                New evidence or edits arrived after this draft was loaded. Your unsaved work is retained here;
                copy it before loading the latest record.
              </p>
              <Button type="button" variant="outline" onClick={reload}>
                Load latest draft
              </Button>
            </div>
          )}
          <form onSubmit={save} className="space-y-5">
            <fieldset disabled={busy}>
              <DraftEditor
                slug={slug}
                itemId={d.itemId}
                body={body}
                setBody={setBody}
                users={users}
                today={d.today}
              />
            </fieldset>
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy || stale}>{busy ? "Saving…" : "Save authenticity draft"}</Button>
              <span className="text-sm text-muted-foreground">
                {dirty ? "Unsaved changes" : "Draft content saved"}
              </span>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        </section>
      )}
      {d.status === "active" && (
        <ReviewActions slug={slug} detail={d} blocked={!!draft && (dirty || stamp !== d.updatedAt)} />
      )}
      {!!d.triggers.length && (
        <section className="rounded-md border p-4">
          <h2 className="font-medium">Review trigger history</h2>
          <ul className="mt-3 divide-y">
            {d.triggers.map((t) => (
              <li key={t.id} className="space-y-1 py-3 text-sm">
                <p className="font-medium">
                  {t.kind.replaceAll("_", " ")} ·{" "}
                  {t.resolvedByVersionId
                    ? `Reviewed in revision ${d.versions.find((v) => v.id === t.resolvedByVersionId)?.number ?? "history"}`
                    : "Open — review required"}
                </p>
                <p className="whitespace-pre-wrap">{t.note}</p>
                <p className="break-words text-muted-foreground">
                  {t.reference} · {t.createdAt} ·{" "}
                  {users.find((u) => u.id === t.actorId)?.name ?? "Former member"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {current && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Current signed assessment</h2>
          <AuthenticityReview
            version={current}
            verifications={d.verifications}
            today={d.today}
            users={users}
            slug={slug}
            showTesting={can("testing")}
            timeZone={timeZone}
          />
          {d.status === "active" && can("quality", "write") && (
            <div className="grid gap-4 lg:grid-cols-2">
              {d.controls
                .filter((c) => can("quality", "manage") || c.ownerUserId === viewer.id)
                .map((c) => (
                  <ControlVerificationForm
                    key={`${d.currentVersionId}:${c.id}`}
                    slug={slug}
                    detail={d}
                    control={c}
                    approvedOn={dateInZone(current.approvedAt!, timeZone)}
                  />
                ))}
            </div>
          )}
        </section>
      )}
      {draft && d.status === "active" && !can("quality", "write") && (
        <AuthenticityReview
          version={draft}
          verifications={d.verifications}
          today={d.today}
          users={users}
          slug={slug}
          showTesting={can("testing")}
          timeZone={timeZone}
        />
      )}
      {!current && !draft && <p className="text-sm text-muted-foreground">No signed revision is recorded.</p>}
      {d.versions
        .filter((v) => v.status === "superseded")
        .map((v) => (
          <details key={v.id} className="rounded-md border p-4">
            <summary className="cursor-pointer font-medium">Earlier signed revision {v.number}</summary>
            <div className="mt-4 space-y-3">
              <Link
                className="text-sm underline"
                href={`/${slug}/quality/authenticity/${d.id}/print?version=${v.id}`}
              >
                Print revision {v.number}
              </Link>
              <AuthenticityReview
                version={v}
                verifications={d.verifications}
                today={d.today}
                users={users}
                slug={slug}
                showTesting={can("testing")}
                timeZone={timeZone}
              />
            </div>
          </details>
        ))}
      {d.status === "archived" && draft && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer font-medium">
            Archived unfinished draft · Revision {draft.number}
          </summary>
          <div className="mt-4">
            <AuthenticityReview
              version={draft}
              verifications={d.verifications}
              today={d.today}
              users={users}
              slug={slug}
              showTesting={can("testing")}
              timeZone={timeZone}
            />
          </div>
        </details>
      )}
      {can("quality", "manage") && d.verifications.some((v) => !v.voidedAt) && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer font-medium">Correct a verification record</summary>
          <p className="my-3 text-sm text-muted-foreground">
            Keep the original evidence and add a dated correction. Correcting current evidence raises a review
            trigger.
          </p>
          <div className="space-y-3">
            {d.verifications
              .filter((v) => !v.voidedAt)
              .map((v) => (
                <VoidVerificationForm key={v.id} slug={slug} detail={d} verification={v} />
              ))}
          </div>
        </details>
      )}
    </div>
  );
}
function DraftEditor({
  slug,
  itemId,
  body: b,
  setBody,
  users,
  today,
}: {
  slug: string;
  itemId: string;
  body: AuthenticityDraft;
  setBody: Dispatch<SetStateAction<AuthenticityDraft>>;
  users: { id: string; name: string }[];
  today: string;
}) {
  const { viewer, can } = useWorkspace();
  const [samples, setSamples] = useState<{ id: string; reference: string }[]>([]);
  const [sampleQuery, setSampleQuery] = useState("");
  const [sampleMessage, setSampleMessage] = useState("");
  const update = (patch: Partial<AuthenticityDraft>) => setBody((prev) => ({ ...prev, ...patch }));
  async function loadSamples() {
    try {
      const page = await unwrap(
        browserApi().v1.workspaces[":slug"].testing.samples.$get({
          param: { slug },
          query: { itemId, q: sampleQuery, limit: "50" },
        }),
      );
      setSamples(page.samples);
      setSampleMessage(
        page.total > page.samples.length
          ? "Showing 50 tests; refine the reference to find more."
          : `${page.total} matching test samples`,
      );
    } catch (e) {
      setSampleMessage(errorMessage(e));
    }
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <F label="Assessment owner">
          <select
            className={selectClass}
            value={b.ownerUserId ?? ""}
            onChange={(e) => update({ ownerUserId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </F>
        <F label="Next assessment review date">
          <Input
            type="date"
            value={b.reviewDueOn ?? ""}
            onChange={(e) => update({ reviewDueOn: e.target.value || null })}
          />
        </F>
        <F label="Assessment scope">
          <Textarea maxLength={4000} value={b.scope} onChange={(e) => update({ scope: e.target.value })} />
        </F>
        <F label="Declared origin and provenance">
          <Textarea maxLength={1000} value={b.origin} onChange={(e) => update({ origin: e.target.value })} />
        </F>
        <F label="Supply-chain route, access and traceability">
          <Textarea
            maxLength={4000}
            value={b.supplyChain}
            onChange={(e) => update({ supplyChain: e.target.value })}
          />
        </F>
      </div>
      <section className="space-y-3">
        <h3 className="font-medium">Vulnerability factors</h3>
        <p className="text-xs text-muted-foreground">
          Assess each factor using commodity, supplier and site evidence. Record your team's judgement and
          rationale; there is no automatic certification score.
        </p>
        {authenticityFactors.map((factor) => {
          const f = b.factors.find((f) => f.factor === factor) ?? {
            factor,
            level: "unassessed" as const,
            rationale: "",
          };
          const edit = (patch: Partial<typeof f>) =>
            setBody((prev) => ({
              ...prev,
              factors: authenticityFactors.map((k) =>
                k === factor
                  ? { ...f, ...patch }
                  : (prev.factors.find((v) => v.factor === k) ?? {
                      factor: k,
                      level: "unassessed",
                      rationale: "",
                    }),
              ),
            }));
          return (
            <fieldset key={factor} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <legend className="px-1 text-sm font-medium">{authenticityFactorLabels[factor]}</legend>
              <F label={`${authenticityFactorLabels[factor]} rating`}>
                <select
                  className={selectClass}
                  value={f.level}
                  onChange={(e) => edit({ level: e.target.value as typeof f.level })}
                >
                  {authenticityLevels.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </F>
              <F label={`${authenticityFactorLabels[factor]} rationale`}>
                <Textarea
                  maxLength={2000}
                  value={f.rationale}
                  onChange={(e) => edit({ rationale: e.target.value })}
                />
              </F>
            </fieldset>
          );
        })}
        <div className="grid gap-3 sm:grid-cols-2">
          <F label="Overall vulnerability conclusion">
            <select
              className={selectClass}
              value={b.vulnerability}
              onChange={(e) =>
                update({ vulnerability: e.target.value as AuthenticityDraft["vulnerability"] })
              }
            >
              {authenticityLevels.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </F>
          <F label="Conclusion and reasoning">
            <Textarea
              maxLength={4000}
              value={b.rationale}
              onChange={(e) => update({ rationale: e.target.value })}
            />
          </F>
        </div>
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Intelligence sources</h3>
        {b.sources.map((s, i) => {
          const edit = (patch: Partial<typeof s>) =>
            update({ sources: b.sources.map((s, n) => (n === i ? { ...s, ...patch } : s)) });
          return (
            <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" key={i}>
              <legend className="px-1 text-sm">Intelligence source {i + 1}</legend>
              <F label={`Source ${i + 1} title`}>
                <Input
                  required
                  maxLength={200}
                  value={s.title}
                  onChange={(e) => edit({ title: e.target.value })}
                />
              </F>
              <F label={`Source ${i + 1} reference or URL`}>
                <Input
                  required
                  maxLength={2000}
                  value={s.reference}
                  onChange={(e) => edit({ reference: e.target.value })}
                />
              </F>
              <F label={`Source ${i + 1} date checked`}>
                <Input
                  type="date"
                  max={today}
                  required
                  value={s.checkedOn}
                  onChange={(e) => edit({ checkedOn: e.target.value })}
                />
              </F>
              <F label={`Source ${i + 1} findings and relevance`}>
                <Textarea
                  required
                  maxLength={4000}
                  value={s.findings}
                  onChange={(e) => edit({ findings: e.target.value })}
                />
              </F>
              <Button
                type="button"
                variant="outline"
                onClick={() => update({ sources: b.sources.filter((_, n) => n !== i) })}
              >
                Remove source {i + 1}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={b.sources.length >= 50}
          onClick={() =>
            update({ sources: [...b.sources, { title: "", reference: "", checkedOn: today, findings: "" }] })
          }
        >
          Add intelligence source
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Provenance, claim and supporting evidence</h3>
        <p className="text-xs text-muted-foreground">
          Reference controlled source records or reports. Test results remain in Testing; linking a report
          does not mark a control verified.
        </p>
        {can("testing") && (
          <div className="grid gap-2 sm:grid-cols-2">
            <F label="Find item tests by reference">
              <Input value={sampleQuery} onChange={(e) => setSampleQuery(e.target.value)} maxLength={200} />
            </F>
            <Button type="button" variant="outline" className="self-end" onClick={loadSamples}>
              Load existing item tests
            </Button>
            {sampleMessage && <p className="text-xs text-muted-foreground sm:col-span-2">{sampleMessage}</p>}
          </div>
        )}
        {b.evidence.map((x, i) => {
          const edit = (patch: Partial<typeof x>) =>
            update({ evidence: b.evidence.map((x, n) => (n === i ? { ...x, ...patch } : x)) });
          return (
            <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" key={i}>
              <legend className="px-1 text-sm">Evidence {i + 1}</legend>
              <F label={`Evidence ${i + 1} category`}>
                <select
                  className={selectClass}
                  value={x.kind}
                  onChange={(e) => edit({ kind: e.target.value as typeof x.kind })}
                >
                  {["provenance", "claim", "testing", "mitigation", "other"].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </F>
              <F label={`Evidence ${i + 1} title`}>
                <Input
                  required
                  maxLength={200}
                  value={x.title}
                  onChange={(e) => edit({ title: e.target.value })}
                />
              </F>
              <F label={`Evidence ${i + 1} reference or location`}>
                <Input
                  required
                  maxLength={2000}
                  value={x.reference}
                  onChange={(e) => edit({ reference: e.target.value })}
                />
              </F>
              <F label={`Evidence ${i + 1} valid until (optional)`}>
                <Input
                  type="date"
                  value={x.validUntil ?? ""}
                  onChange={(e) => edit({ validUntil: e.target.value || null })}
                />
              </F>
              <F label={`Evidence ${i + 1} relevance / claim supported`}>
                <Textarea maxLength={2000} value={x.note} onChange={(e) => edit({ note: e.target.value })} />
              </F>
              {can("testing") && (
                <F label={`Evidence ${i + 1} linked test (optional)`}>
                  <select
                    className={selectClass}
                    value={x.sampleId ?? ""}
                    onChange={(e) => edit({ sampleId: e.target.value || null })}
                  >
                    <option value="">No test linked</option>
                    {x.sampleId && !samples.some((s) => s.id === x.sampleId) && (
                      <option value={x.sampleId}>Previously linked test</option>
                    )}
                    {samples.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.reference}
                      </option>
                    ))}
                  </select>
                </F>
              )}
              {!can("testing") && x.sampleId && (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    This evidence links a Testing record. Editing a draft with linked tests requires Testing
                    read access.
                  </p>
                  <Button type="button" variant="outline" onClick={() => edit({ sampleId: null })}>
                    Remove test link {i + 1}
                  </Button>
                </div>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => update({ evidence: b.evidence.filter((_, n) => n !== i) })}
              >
                Remove evidence {i + 1}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={b.evidence.length >= 50}
          onClick={() =>
            update({
              evidence: [
                ...b.evidence,
                { kind: "provenance", title: "", reference: "", validUntil: null, sampleId: null, note: "" },
              ],
            })
          }
        >
          Add supporting evidence
        </Button>
      </section>
      <section className="space-y-3">
        <h3 className="font-medium">Mitigation and verification controls</h3>
        <p className="text-xs text-muted-foreground">
          Assign an owner, initial due date and acceptance criteria. Recurring controls become due again after
          the stated interval; leave the interval empty for a one-off control.
        </p>
        {b.controls.map((c, i) => {
          const edit = (patch: Partial<typeof c>) =>
            update({ controls: b.controls.map((c, n) => (n === i ? { ...c, ...patch } : c)) });
          return (
            <fieldset className="grid gap-3 rounded-md border p-3 sm:grid-cols-2" key={c.id}>
              <legend className="px-1 text-sm">Control {i + 1}</legend>
              <F label={`Control ${i + 1} type`}>
                <select
                  className={selectClass}
                  value={c.kind}
                  onChange={(e) => edit({ kind: e.target.value as typeof c.kind })}
                >
                  {authenticityControlKinds.map((k) => (
                    <option key={k} value={k}>
                      {k.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </F>
              <F label={`Control ${i + 1} action`}>
                <Textarea
                  required
                  maxLength={2000}
                  value={c.description}
                  onChange={(e) => edit({ description: e.target.value })}
                />
              </F>
              <F label={`Control ${i + 1} owner`}>
                <select
                  className={selectClass}
                  value={c.ownerUserId}
                  onChange={(e) => edit({ ownerUserId: e.target.value })}
                >
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </F>
              <F label={`Control ${i + 1} initial due date`}>
                <Input
                  type="date"
                  required
                  value={c.dueOn}
                  onChange={(e) => edit({ dueOn: e.target.value })}
                />
              </F>
              <F label={`Control ${i + 1} repeat interval (days, optional)`}>
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  step={1}
                  value={c.frequencyDays ?? ""}
                  onChange={(e) => edit({ frequencyDays: e.target.value ? Number(e.target.value) : null })}
                />
              </F>
              <F label={`Control ${i + 1} acceptance criteria`}>
                <Textarea
                  required
                  maxLength={2000}
                  value={c.acceptanceCriteria}
                  onChange={(e) => edit({ acceptanceCriteria: e.target.value })}
                />
              </F>
              <Button
                type="button"
                variant="outline"
                onClick={() => update({ controls: b.controls.filter((_, n) => n !== i) })}
              >
                Remove control {i + 1}
              </Button>
            </fieldset>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={b.controls.length >= 50}
          onClick={() =>
            update({
              controls: [
                ...b.controls,
                {
                  id: newId(),
                  kind: "mitigation",
                  description: "",
                  ownerUserId: viewer.id,
                  dueOn: today,
                  frequencyDays: null,
                  acceptanceCriteria: "",
                },
              ],
            })
          }
        >
          Add authenticity control
        </Button>
      </section>
    </div>
  );
}
function ReviewActions({
  slug,
  detail: d,
  blocked,
}: {
  slug: string;
  detail: AuthenticityDetail;
  blocked: boolean;
}) {
  const { can } = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [commands, setCommands] = useState(() => ({
    start: newId(),
    approve: newId(),
    trigger: newId(),
    archive: newId(),
  }));
  if (!can("quality", "write")) return null;
  async function start() {
    setBusy(true);
    setError("");
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].quality.authenticity[":id"].draft.$post({
          param: { slug, id: d.id },
          json: { commandId: commands.start, expectedUpdatedAt: d.updatedAt },
        }),
      );
      setCommands((c) => ({ ...c, start: newId() }));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>, action: "approve" | "trigger" | "archive") {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = e.currentTarget,
      f = new FormData(form),
      api = browserApi().v1.workspaces[":slug"].quality.authenticity[":id"],
      param = { slug, id: d.id };
    try {
      if (action === "approve")
        await unwrap(
          api.approve.$post({
            param,
            json: {
              commandId: commands.approve,
              expectedUpdatedAt: d.updatedAt,
              note: fieldText(f, "note"),
              triggerIds: f.getAll("trigger").map(String),
            },
          }),
        );
      else if (action === "archive")
        await unwrap(
          api.archive.$post({
            param,
            json: {
              commandId: commands.archive,
              expectedUpdatedAt: d.updatedAt,
              reason: fieldText(f, "note"),
            },
          }),
        );
      else
        await unwrap(
          api.triggers.$post({
            param,
            json: authenticityTriggerSchema.parse({
              commandId: commands.trigger,
              kind: fieldText(f, "kind"),
              note: fieldText(f, "note"),
              reference: fieldText(f, "reference"),
            }),
          }),
        );
      setCommands((c) => ({ ...c, [action]: newId() }));
      form.reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-md border p-4">
      <h2 className="font-medium">Review decisions and triggers</h2>
      {!d.draftVersionId && (
        <Button disabled={busy} onClick={start}>
          Start next authenticity review
        </Button>
      )}
      {d.draftVersionId && can("quality", "manage") && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">Sign assessment review</summary>
          <form onSubmit={(e) => submit(e, "approve")} className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              Sign the saved vulnerability judgement and control plan. Earlier revisions remain available.
              Controls in the new revision require their own verification evidence.
            </p>
            {!!d.approvalBlockers.length && (
              <ul className="list-disc pl-5 text-sm text-destructive">
                {d.approvalBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
            {blocked && (
              <p role="status" className="text-sm text-destructive">
                Save or reload the draft before signing its review.
              </p>
            )}
            {d.triggers
              .filter((t) => !t.resolvedByVersionId)
              .map((t) => (
                <label key={t.id} className="flex gap-2 text-sm">
                  <input type="checkbox" name="trigger" value={t.id} required />
                  Reviewed {t.kind.replaceAll("_", " ")}: {t.note}
                </label>
              ))}
            <F label="Review decision and signature note">
              <Textarea name="note" required maxLength={4000} />
            </F>
            <Button disabled={busy || blocked || !!d.approvalBlockers.length}>
              Sign saved authenticity assessment
            </Button>
          </form>
        </details>
      )}
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-medium">Record new intelligence / review trigger</summary>
        <form onSubmit={(e) => submit(e, "trigger")} className="mt-3 grid gap-3 sm:grid-cols-2">
          <F label="Review trigger type">
            <select className={selectClass} name="kind">
              {authenticityTriggerKinds
                .filter((k) => k !== "failed_control" && k !== "evidence_correction")
                .map((k) => (
                  <option key={k} value={k}>
                    {k.replaceAll("_", " ")}
                  </option>
                ))}
            </select>
          </F>
          <F label="Trigger source or reference">
            <Input name="reference" required maxLength={2000} />
          </F>
          <F label="Trigger evidence and reason for review">
            <Textarea name="note" required maxLength={4000} />
          </F>
          <Button disabled={busy} className="self-end">
            Record authenticity trigger
          </Button>
        </form>
      </details>
      {can("quality", "manage") && (
        <details className="rounded-md border p-3">
          <summary className="cursor-pointer font-medium">Archive this assessment scope</summary>
          <form onSubmit={(e) => submit(e, "archive")} className="mt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Retain all versions and verification history. Archived scopes stop accepting draft edits and new
              verification records.
            </p>
            <F label="Reason for archiving assessment">
              <Textarea name="note" required maxLength={4000} />
            </F>
            <Button variant="outline" disabled={busy}>
              Sign and archive assessment
            </Button>
          </form>
        </details>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
function ControlVerificationForm({
  slug,
  detail: d,
  control,
  approvedOn,
}: {
  slug: string;
  detail: AuthenticityDetail;
  control: AuthenticityControl;
  approvedOn: string;
}) {
  const router = useRouter();
  const [commandId, setCommand] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = e.currentTarget,
      f = new FormData(form);
    try {
      const outcome = fieldText(f, "outcome");
      if (outcome !== "pass" && outcome !== "fail") throw Error("Choose the verification outcome");
      await unwrap(
        browserApi().v1.workspaces[":slug"].quality.authenticity[":id"].versions[":versionId"].controls[
          ":controlId"
        ].verify.$post({
          param: { slug, id: d.id, versionId: d.currentVersionId!, controlId: control.id },
          json: {
            commandId,
            verifiedOn: fieldText(f, "date"),
            outcome,
            evidenceReference: fieldText(f, "reference"),
            evidenceValidUntil: fieldText(f, "validUntil") || null,
            note: fieldText(f, "note"),
          },
        }),
      );
      setCommand(newId());
      form.reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-md border p-4">
      <summary className="cursor-pointer font-medium">Verify: {control.description}</summary>
      <form onSubmit={submit} className="mt-3 space-y-3">
        <p className="text-sm">Acceptance: {control.acceptanceCriteria}</p>
        <F label="Control verification date">
          <Input name="date" type="date" min={approvedOn} max={d.today} defaultValue={d.today} required />
        </F>
        <F label="Control verification outcome">
          <select name="outcome" className={selectClass} required defaultValue="">
            <option value="" disabled>
              Choose result
            </option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
          </select>
        </F>
        <F label="Verification evidence or report reference">
          <Input name="reference" required maxLength={2000} />
        </F>
        <F label="Verification evidence valid until (optional)">
          <Input name="validUntil" type="date" />
        </F>
        <F label="Verification findings and sign-off note">
          <Textarea name="note" required maxLength={4000} />
        </F>
        <p className="text-xs text-muted-foreground">
          A failure raises an assessment review trigger. Record laboratory results and any lot containment in
          Testing or the existing Quality/Stock workflows.
        </p>
        <Button disabled={busy}>Sign control verification</Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
function VoidVerificationForm({
  slug,
  detail: d,
  verification: v,
}: {
  slug: string;
  detail: AuthenticityDetail;
  verification: AuthenticityVerification;
}) {
  const router = useRouter();
  const [commandId] = useState(newId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const form = e.currentTarget;
    try {
      await unwrap(
        browserApi().v1.workspaces[":slug"].quality.authenticity[":id"].verifications[
          ":verificationId"
        ].void.$post({
          param: { slug, id: d.id, verificationId: v.id },
          json: { commandId, reason: fieldText(new FormData(form), "reason") },
        }),
      );
      form.reset();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2 rounded-md border p-3">
      <p className="text-sm">
        Revision {d.versions.find((x) => x.id === v.versionId)?.number} · {v.verifiedOn} · {v.outcome} ·{" "}
        {v.evidenceReference}
      </p>
      <F label={`Correction reason for ${v.evidenceReference}`}>
        <Textarea name="reason" required maxLength={4000} />
      </F>
      <Button disabled={busy} variant="outline">
        Sign verification correction
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
