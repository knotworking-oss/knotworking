import Link from "next/link";
import type { ReactNode } from "react";
import { requireModule, canReadModule } from "@/lib/api";
export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ workspace: string }>;
  children: ReactNode;
}) {
  const { workspace: slug } = await params;
  await requireModule(slug, "hse");
  const restricted = await canReadModule(slug, "hse_incidents");
  return (
    <div className="print-scroll flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="Health, safety and environment"
        className="flex flex-wrap gap-5 border-b px-6 py-3 text-sm print:hidden"
      >
        <Link href={`/${slug}/hse`}>HSE registers</Link>
        <Link href={`/${slug}/hse/permits`}>Contractor permits</Link>
        {restricted && <Link href={`/${slug}/hse/incidents`}>Restricted incidents</Link>}
      </nav>
      {children}
    </div>
  );
}
