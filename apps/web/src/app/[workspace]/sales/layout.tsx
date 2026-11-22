import type { ReactNode } from "react";
import Link from "next/link";
import { requireModule } from "@/lib/api";
export default async function Layout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspace: string }>;
}) {
  const { workspace: slug } = await params;
  await requireModule(slug, "sales");
  return (
    <div className="print-scroll flex min-h-0 flex-1 flex-col">
      <nav aria-label="Sales" className="flex flex-wrap gap-5 border-b px-6 py-3 text-sm print:hidden">
        <Link href={`/${slug}/sales`}>Orders and quotes</Link>
        <Link href={`/${slug}/sales/prices`}>Price agreements</Link>
        <Link href={`/${slug}/sales/commitments`}>Delivery commitments</Link>
        <Link href={`/${slug}/sales/integration`}>Integration</Link>
      </nav>
      {children}
    </div>
  );
}
