# Design system

Knotworking's UI is built on **[shadcn/ui](https://ui.shadcn.com)**: accessible Radix primitives styled with Tailwind CSS and theme variables. The component source is copied into our repo, so we own and can edit every component. Browse everything at **`/design`** in the web app, in light and dark mode.

Configuration: style `radix-nova` (Lucide icons, Geist font), base color `neutral`, CSS variables on.

## Where things live

```
packages/ui/
  components.json            shadcn config for the package
  src/styles/globals.css     Tailwind + theme variables (light/dark) + Knotworking colors
  src/components/*.tsx       shadcn components (button, sidebar, command, dialog, …)
                             + Knotworking components (status-icon, priority-icon, project-badges, label-badge, user-avatar, property-menu)
  src/hooks/                 hooks used by components (use-mobile)
  src/lib/utils.ts           cn()
apps/web/components.json     shadcn config for the app (points at packages/ui)
```

Import from subpaths:

```tsx
import { Button } from "@knotworking/ui/components/button";
import { StatusIcon } from "@knotworking/ui/components/status-icon";
import { cn } from "@knotworking/ui/lib/utils";
```

## Adding components

Run the shadcn CLI from the app. It writes the files into `packages/ui` automatically:

```bash
pnpm ui:add calendar          # same as: cd apps/web && pnpm dlx shadcn@latest add calendar
pnpm ui:add calendar --diff   # preview upstream changes to a component you already have
```

The full catalogue is at ui.shadcn.com/docs/components. Prettier skips the shadcn-managed folders, so registry updates diff cleanly.

## Theme

All colors are CSS variables in `globals.css` (OKLCH), with `:root` for light and `.dark` for dark. Dark mode uses `next-themes` (a `class` on `<html>`, following the system by default). Use the semantic Tailwind classes:

| Purpose         | Classes                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| Page and text   | `bg-background`, `text-foreground`, `text-muted-foreground`                               |
| Surfaces        | `bg-card`, `bg-popover`, `bg-muted`, `bg-sidebar`                                         |
| Actions         | `bg-primary` / `text-primary-foreground`, `bg-secondary`, `bg-accent`, `text-destructive` |
| Lines and focus | `border-border`, `border-input`, `ring-ring`                                              |

To re-theme the app, edit the variables, or generate a palette at ui.shadcn.com/themes and paste it in. Corner radius comes from one `--radius` variable.

### Knotworking colors

Knotworking-specific meaning, added alongside the shadcn variables:

| Group           | Classes                                                                                                                               | Use                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Workflow status | `text-status-{backlog,unstarted,started,completed,canceled}`                                                                          | Status icons                                  |
| Priority        | `text-priority-{urgent,high,medium,low,none}`                                                                                         | Priority icons                                |
| Labels          | `bg-label-{color}`, `bg-label-{color}-bg`, `text-label-{color}` for gray, brown, orange, yellow, green, teal, blue, purple, pink, red | Labels, project chips, avatars, health badges |

## Knotworking components

| Component                                  | Notes                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `StatusIcon`                               | Glyph per workflow category. Shape alone carries the meaning, and `progress` fills "started" states (In Progress → In Review). |
| `PriorityIcon`                             | Signal bars, plus a filled tile for urgent.                                                                                    |
| `ProjectStatusBadge`, `ProjectHealthBadge` | Project status as a neutral badge. Health (on track, at risk, off track) as a green, yellow or red tint.                       |
| `LabelBadge`, `ColorDot`                   | Labels as an outline badge with a color dot (dense lists) or a soft tint (properties, cards).                                  |
| `UserAvatar`                               | shadcn `Avatar` with initials in a color derived from the name.                                                                |
| `PropertyMenu`                             | Searchable popover picker (single or multi-select) with single-key shortcuts. The web app's task pickers are built on it.      |

`PrintPage`, `PrintHeading`, `PrintNotice`, `SignatureLine`, `DateRangeForm` (`print-page.tsx`), `AuditRecordList` and `ExportCsvButton` are the print and export pieces: an A4 sheet that previews on screen and prints without the app's chrome (rules in `globals.css`, `.print-sheet` sets its own black-on-white variables), and CSV built in the browser. See [Printing and exports](modules.md#printing-and-exports). They are shown on `/design`.

The web app's `GanttChart` (`apps/web/src/components/gantt-chart.tsx`, the project Timeline view) builds on these: bars use the status colours as fills (`bg-status-*`), overdue and violated dependencies use `destructive`, and the project range and today line use `primary`. It is shown on `/design`.

## Guidelines

- **Use the shadcn component before writing markup.** Use `Empty` for empty states, `Field` for forms, `Kbd` for shortcuts, `Sidebar` for navigation and `Command` for search.
- **Color carries meaning** (status, priority, labels, health). Everything else stays neutral.
- **Use one primary (`default`) button per view.** Use `outline` and `ghost` for the rest.
- **Accessibility:** icon-only buttons need an `aria-label`. Radix handles focus management, keyboard support and ARIA for overlays.

## Small screens

- **Sidebar:** from `lg` (1024px) it is docked. Below that it is hidden and opens as an overlay on top of the page (the `SidebarTrigger` in `PageHeader`, or Ctrl/Cmd+B). It closes when you pick a link, search or new task, tap outside it or press Escape. The breakpoint is `MOBILE_BREAKPOINT` in `packages/ui/src/hooks/use-mobile.ts`; keep the `lg:` classes in `sidebar.tsx` in step with it.
- **Tables:** a table that matters on a phone must not scroll sideways and hide its status column. Use `stackedTable` (`apps/web/src/components/stacked-table.tsx`) as the table's `className` and mark the cells (`data-primary`, `data-label`, `data-actions`, `data-block`, `data-select`). Below `md` each row becomes a card. A true grid (the training matrix) may keep scrolling, with a narrow sticky first column.
- **Touch targets:** buttons used on phones and tablets (roll-call marks, kiosk keypad) are at least 44px tall.
- **Short screens:** the `short` and `short-wide` variants (max height 44rem) are for the kiosk. Landscape tablets and phones get a smaller keypad, and the wide ones a two-column layout.

## Desktop

The desktop app wraps the web UI and uses the same components.
