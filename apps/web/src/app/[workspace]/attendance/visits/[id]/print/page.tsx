import type { Metadata } from "next";
import Link from "next/link";
import { PrintHeading, PrintNotice, PrintPage } from "@/components/print-page";
import { getBootstrap, getVisit } from "@/lib/api";
import { printDate, printDateTime } from "@/lib/print";

export const metadata: Metadata = { title: "Visitor pass" };

/**
 * A visitor's pass, printed from the browser's print dialog: a card to cut out and wear or carry,
 * with who they are, who they are visiting and when they came in, and the visit's site rules
 * acceptance below it. Needs `write` on attendance (the visits list does too).
 */
export default async function PrintVisitorPassPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>;
}) {
  const { workspace: slug, id } = await params;
  const [visit, boot] = await Promise.all([getVisit(slug, id), getBootstrap(slug)]);
  const timeZone = boot.workspace.timeZone;
  const name = `${visit.firstName} ${visit.lastName}`;
  const left = visit.signedOutAt !== null;

  return (
    <PrintPage
      crumbs={
        <>
          <Link href={`/${slug}/attendance/shifts`} className="text-muted-foreground hover:text-foreground">
            Attendance
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="font-medium">Visitor pass</h1>
        </>
      }
    >
      <PrintHeading
        workspace={boot.workspace.name}
        timeZone={timeZone}
        title="Visitor pass"
        subtitle="Cut out along the line; wear it or keep it with you while you are on site."
      />

      {left && (
        <div className="mb-4">
          <PrintNotice strong>
            Signed out {printDateTime(visit.signedOutAt, timeZone)}: no longer valid
          </PrintNotice>
        </div>
      )}

      <section
        aria-label="Visitor pass"
        className="w-[100mm] break-inside-avoid border-2 border-dashed border-black p-[3mm]"
      >
        <div className="flex flex-col border-2 border-black">
          <p className="bg-black px-3 py-1.5 text-center text-2xl font-bold tracking-[0.3em] text-white uppercase">
            Visitor
          </p>
          <div className="flex flex-col gap-1 px-4 py-3">
            <p className="text-[11px] tracking-wide uppercase">{boot.workspace.name}</p>
            <p className="text-3xl leading-tight font-bold">{name}</p>
            {visit.company && <p className="text-lg">{visit.company}</p>}
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
              <dt className="text-muted-foreground">Visiting</dt>
              <dd className="font-medium">{visit.hostName ?? "Not given"}</dd>
              <dt className="text-muted-foreground">Date</dt>
              <dd className="font-medium">{printDate(visit.signedInAt, timeZone)}</dd>
              <dt className="text-muted-foreground">Signed in</dt>
              <dd className="font-medium">{printDateTime(visit.signedInAt, timeZone)}</dd>
            </dl>
          </div>
          <p className="border-t-2 border-black px-4 py-2 text-[11px]">
            Please sign out at the kiosk when you leave. In an emergency, go to the assembly point and report
            to the fire marshal.
          </p>
        </div>
      </section>

      <section className="mt-6 text-[12px]">
        <h2 className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Site rules
        </h2>
        {visit.siteRulesAcceptedAt ? (
          <p>Accepted {printDateTime(visit.siteRulesAcceptedAt, timeZone)}.</p>
        ) : visit.siteRules || visit.siteRulesHash ? (
          <p>Shown at sign-in; not accepted.</p>
        ) : (
          <p>No site rules were shown for this visit.</p>
        )}
        {visit.siteRules && <p className="mt-1 whitespace-pre-line">{visit.siteRules}</p>}
      </section>
    </PrintPage>
  );
}
