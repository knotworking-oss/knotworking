"use client";

import type { ModuleId } from "@knotworking/core";
import { Button } from "@knotworking/ui/components/button";
import { LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-store";

/**
 * A module's Dashboards link: its `module:<id>` dashboards, where a module
 * owner finds the ones built for them (and can start from the module's template). Shown only to
 * people who can open dashboards.
 */
export function ModuleDashboardsLink({ module }: { module: ModuleId }) {
  const { slug, can } = useWorkspace();
  if (!can("bi")) return null;
  return (
    <Button size="sm" variant="ghost" asChild>
      <Link href={`/${slug}/dashboards?scope=module:${module}`}>
        <LayoutDashboard />
        <span className="hidden lg:inline">Dashboards</span>
      </Link>
    </Button>
  );
}
