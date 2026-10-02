/**
 * D31 — WHAT A RESULT READ OUT OF out/defects.json, as one digest.
 *
 * A module of its own, with nothing but node builtins, because two readers
 * need the same answer and neither may import the other: `report.mjs` writes
 * the digest into result.json as `defects_digest`, and `steps/report.mjs`
 * re-runs report when the file no longer matches. The step cannot import the
 * tool (the step tests stand a stub in for report.mjs), and the tool cannot
 * import the step (it would drag config.mjs's package-root refusal into every
 * importer of `build`).
 *
 * WHY IT IS NEEDED. A stall `repair` writes in a walk that re-measured nothing
 * leaves coverage.json's timestamp where it was, so `report` said "already
 * done" over a result that still read "no reason is written for them" beside
 * the stalled row that said why (assessment-service, mocked, 2026-09-25,
 * walked to the end on its checkpoint).
 *
 * This run's rows (the same filter as report.mjs `stepDefects`), without the
 * time each was written, sorted: the walk rewrites a note with a fresh `at`
 * every walk, and that is not a change in what the result says. Null for none.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function defectsDigest(path, runId = (process.env.CHARPILOT_RUN_ID || process.env.CHAR_RUN_STAMP || "").trim() || null) {
  let rows = [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    rows = Array.isArray(doc?.defects) ? doc.defects : [];
  } catch {
    rows = [];
  }
  if (runId) rows = rows.filter((d) => (d?.run ?? null) === runId);
  const kept = rows
    .filter(Boolean)
    .map(({ at: _at, ...rest }) => JSON.stringify(rest, Object.keys(rest).sort()))
    .sort();
  return kept.length ? createHash("sha1").update(kept.join("\n")).digest("hex") : null;
}
