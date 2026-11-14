// The "N changed, N unchanged, N could not confirm" tally of a re-check answer is DERIVED data, so code
// computes it from the model's per-item labels. When the model wrote it, it miscounted its own labels
// (one item "Changed", tally "1 could not confirm"); counting is what code is for, not a token stream.

export type Label = "changed" | "unchanged" | "could not confirm";

// A label line looks like "<item>: then X → now Y [n] — Changed". The label must follow a dash at the end
// of the comparison; "unchanged" is listed before "changed" so it wins at the same position.
const LABEL = /[—–-]\s*\**\s*(could not confirm|unchanged|changed)\b/i;

/** Per-item labels, one per comparison line ("→"), in order. */
export function itemLabels(answer: string): Label[] {
  return answer
    .split("\n")
    .filter((line) => line.includes("→"))
    .flatMap((line) => {
      const m = line.match(LABEL);
      return m ? [m[1].toLowerCase() as Label] : [];
    });
}

/** The appended summary line, or null when the answer has no labelled items (not a re-check). */
export function summaryLine(answer: string): string | null {
  const labels = itemLabels(answer);
  if (!labels.length) return null;
  const n = (l: Label) => labels.filter((x) => x === l).length;
  return `**Summary:** ${n("changed")} changed, ${n("unchanged")} unchanged, ${n("could not confirm")} could not confirm`;
}
