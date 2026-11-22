/**
 * Class names that turn a `<Table>` into a list of cards below `md`, instead of a table that scrolls
 * sideways and hides its later columns (the status, the date) off-screen. Pass it as the table's
 * `className`, then mark the cells:
 *
 *   data-primary  the main cell (name or course): gets the first line to itself
 *   data-label    "Label" shown in front of the value ("Trained  3 Aug 2026"); every other cell needs it
 *   data-block    a long value that takes a line to itself (a course title, a list of roles)
 *   data-select   a leading checkbox: pinned to the card's top-left corner
 *   data-actions  buttons: pushed to the right
 *
 * Empty cells are dropped. From `md` up nothing changes.
 */
export const stackedTable = [
  "max-md:block",
  "max-md:[&_thead]:hidden",
  "max-md:[&_tbody]:block",
  "max-md:[&_tbody_tr]:relative max-md:[&_tbody_tr]:flex max-md:[&_tbody_tr]:flex-wrap max-md:[&_tbody_tr]:items-center",
  "max-md:[&_tbody_tr]:gap-x-4 max-md:[&_tbody_tr]:gap-y-1 max-md:[&_tbody_tr]:px-4 max-md:[&_tbody_tr]:py-3",
  "max-md:[&_td]:block max-md:[&_td]:max-w-none max-md:[&_td]:p-0 max-md:[&_td:empty]:hidden",
  "max-md:[&_td[data-label]]:text-sm max-md:[&_td[data-label]]:before:mr-1.5 max-md:[&_td[data-label]]:before:text-xs",
  "max-md:[&_td[data-label]]:before:text-muted-foreground max-md:[&_td[data-label]]:before:content-[attr(data-label)]",
  "max-md:[&_td[data-primary]]:order-first max-md:[&_td[data-primary]]:basis-full max-md:[&_td[data-primary]]:whitespace-normal",
  "max-md:[&_td[data-block]]:basis-full max-md:[&_td[data-block]]:whitespace-normal",
  "max-md:[&_td[data-select]]:absolute max-md:[&_td[data-select]]:top-3.5 max-md:[&_td[data-select]]:left-4",
  "max-md:[&_tr:has([data-select])_td[data-primary]]:pl-8",
  "max-md:[&_td[data-actions]]:ml-auto",
].join(" ");
