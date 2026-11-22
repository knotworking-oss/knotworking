"use client";

import { Badge } from "@knotworking/ui/components/badge";
import { Button } from "@knotworking/ui/components/button";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalWorkspace } from "@/lib/workspace-store";

const sections = [
  ["", "Today's checks"],
  ["/review", "Review"],
  ["/plans", "HACCP plans"],
  ["/library", "Hazard library"],
  ["/deviations", "Deviations"],
  ["/records", "Cleaning & calibration"],
] as const;

/**
 * The food safety pages, in the page header. "Review" (readings from API tokens awaiting a
 * person's review, with their count) is for people with manage access, who review them.
 */
export function HaccpNav({ slug, awaitingReview = 0 }: { slug: string; awaitingReview?: number }) {
  const pathname = usePathname();
  // Outside a workspace (the design page) the full navigation is shown.
  const canManage = useOptionalWorkspace()?.can("haccp", "manage") ?? true;
  const base = `/${slug}/haccp`;
  return (
    <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Food safety">
      <span className="mr-2 shrink-0 font-medium">Food safety</span>
      {sections.map(([path, label]) => {
        if (path === "/review" && !canManage) return null;
        const href = `${base}${path}`;
        const active = path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Button key={path} asChild size="sm" variant={active ? "secondary" : "ghost"}>
            <Link href={href} aria-current={active ? "page" : undefined}>
              {label}
              {path === "/review" && awaitingReview > 0 && (
                <Badge
                  className="border-transparent bg-label-yellow-bg text-label-yellow tabular-nums"
                  aria-label={`${awaitingReview} awaiting review`}
                >
                  {awaitingReview}
                </Badge>
              )}
            </Link>
          </Button>
        );
      })}
    </nav>
  );
}
