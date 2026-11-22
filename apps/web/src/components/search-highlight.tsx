import { splitByRanges, type SearchRange } from "@knotworking/core";

/** Text with the matched ranges emphasised. Plain React text nodes, so nothing is ever interpreted as HTML. */
export function SearchHighlight({ text, ranges }: { text: string; ranges: SearchRange[] }) {
  return (
    <>
      {splitByRanges(text, ranges).map((part, i) =>
        part.match ? (
          <mark key={i} className="bg-transparent font-semibold text-foreground">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
