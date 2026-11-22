import { Separator } from "@knotworking/ui/components/separator";
import { SidebarTrigger } from "@knotworking/ui/components/sidebar";
import type { ReactNode } from "react";

/**
 * Top bar of the main pane: sidebar toggle, title/breadcrumbs, actions. On narrow panes the actions wrap
 * onto a second row instead of overflowing; toolbars drop their button labels below `lg` to avoid that.
 */
export function PageHeader({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
      <div className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-sm">{children}</div>
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </header>
  );
}
