import { Button } from "@knotworking/ui/components/button";
import Link from "next/link";

/** Switches between the demand plan (grid) and the list of lines. */
export function DemandNav({ slug, current }: { slug: string; current: "plan" | "cover" | "lines" }) {
  return (
    <nav className="flex gap-1" aria-label="Demand views">
      <Button variant={current === "plan" ? "secondary" : "ghost"} size="sm" asChild>
        <Link href={`/${slug}/demand`} aria-current={current === "plan" ? "page" : undefined}>
          Plan
        </Link>
      </Button>
      <Button variant={current === "cover" ? "secondary" : "ghost"} size="sm" asChild>
        <Link href={`/${slug}/demand/cover`} aria-current={current === "cover" ? "page" : undefined}>
          Cover
        </Link>
      </Button>
      <Button variant={current === "lines" ? "secondary" : "ghost"} size="sm" asChild>
        <Link href={`/${slug}/demand/lines`} aria-current={current === "lines" ? "page" : undefined}>
          Lines and imports
        </Link>
      </Button>
    </nav>
  );
}
