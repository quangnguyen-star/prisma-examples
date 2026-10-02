/**
 * report — the one machine-readable result, written where the container reads
 * it and nowhere else.
 *
 * `report.mjs` derives nothing and re-measures nothing; stage 6 already put
 * every figure in `out/coverage.json` and this reshapes two of them into the
 * narrow contract outside this repo is allowed to depend on (report.mjs:3-38).
 * The path is the one `ctx.pack_result` resolves to for this language —
 * `.claude/charpilot/out/result.json`, docker/char/context.py:77 — so it is
 * passed explicitly rather than left to report.mjs's `result.json` default,
 * which resolves against a CWD this step does not own.
 *
 * WHAT `satisfied` ASKS: the file is there, it parses, it carries the two
 * coverage numbers, AND it is no older than the `out/coverage.json` those
 * numbers were reshaped from — see `staleReason`, which is where the last of
 * those four was missing. Those two numbers are exactly what `finish.py`'s own validator
 * demands of a result before it will let it reach Fleet Control —
 * `coverage_percentage.branches` and `.functions`, both numeric
 * (docker/finish.py:208-213). An early `report.mjs` failure — no coverage
 * document, no totals, a denominator of zero — writes a result whose
 * `coverage_percentage` is null, and that is a run that measured nothing
 * wearing the shape of one that did.
 *
 * WHAT IT DOES NOT ASK, and this is the whole of the step's restraint: THE RATE.
 * `report.mjs` sets `status: "failed"` when the run lands below its target and
 * exits 1, and a `satisfied` that refused on that would be refusing on a
 * judgement it cannot make. `satisfied` is a pure function of the disk. It
 * cannot see whether a failing rate is still climbing, so refusing while
 * `failed` spends every remaining round re-reporting a number that is already
 * as high as this run can get it. The judgement of whether another round is
 * worth its cost lives in docker/char/packs/nodejs.py, next to `best_rate`,
 * which is the only place that has both this round's number and the last one's.
 * A second copy here would be the second account of the run, and the second
 * account is the one that turns out to be wrong.
 *
 * So a `failed` result with both numbers in it SATISFIES this step. The status
 * and its reason are printed in `did`, where the walk quotes them; the exit
 * code is in `did` too, because report.mjs exits 1 on a failure and the tool's
 * own bytes reach the top verbatim.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { OUT_DIR } from "../config.mjs";
import { defectsDigest } from "../defectsdigest.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "report";

/**
 * Where the result goes: `ctx.pack_result` for the nodejs pack.
 *
 * config.mjs exports no path for it — `report.mjs` deliberately does not import
 * config.mjs at all (report.mjs:46-52) — so it is spelled out once here against
 * OUT_DIR, and passed to the tool rather than assumed of it.
 */
export const RESULT_JSON = resolve(OUT_DIR, "result.json");

/**
 * The result document, or null when there is not one to read.
 *
 * Null covers all three of absent, unparseable and carrying no numbers, because
 * the step's answer is the same in all three: this run has not reported. Which
 * of the three it was is said in `run`, where a reader is looking for it.
 */
export function reported(path = RESULT_JSON) {
  if (!existsSync(path)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const pct = doc?.coverage_percentage;
  if (typeof pct?.branches !== "number" || typeof pct?.functions !== "number") return null;
  return doc;
}

/**
 * Nothing to be blocked on. `report.mjs` never throws — every failure comes
 * back as a `failed` status carrying its reason (report.mjs:84-86) — so an
 * absent coverage document arrives as a sentence in the result rather than as a
 * crash a precondition would have to pre-empt.
 */
export function precondition(_repo) {
  return null;
}

/**
 * The coverage document `report.mjs` reshapes, and nothing else.
 *
 * report.mjs:54 opens exactly this file and derives every figure in the result
 * from it; `steps/measure.mjs` exports the same constant and is deliberately
 * not imported here, for the reason report.mjs gives at report.mjs:44-52 — this
 * step's business is one path, and pulling in the measure step drags the record
 * step and stagingenv.mjs behind it.
 */
const COVERAGE_JSON = resolve(OUT_DIR, "coverage.json");
/** Beside it, and read by report.mjs for the verdict (D31). */
const DEFECTS_JSON = resolve(OUT_DIR, "defects.json");

/** Milliseconds, or null when the file is not there. */
const mtimeOf = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);

/**
 * Why the result on disk is not this round's, or null.
 *
 * WHAT `satisfied` USED TO ASK: that `result.json` parses and carries two
 * numbers. Nothing tied it to the measurement it was computed FROM — so a
 * result written in round 2 satisfies this step in round 7, and the walk
 * reports `report: already done` over a document quoting round 2's percentage
 * while `out/coverage.json` beside it holds round 7's. That number is what
 * `docker/finish.py` reads and what reaches Fleet Control; it is also, being
 * exit 0, the ending nobody investigates.
 *
 * THE QUESTION ASKED IS THE ONE THIS STEP CAN ANSWER, and that is the whole of
 * why it is a timestamp against coverage.json rather than `freshness.check`
 * over the whole chain. A result older than its coverage document is fixed by
 * running report.mjs again, which is this step's own `run` — so the predicate
 * is false only in a state `run` changes, which is the rule. A predicate that
 * demanded coverage.json itself be fresh against `src/` would be false in a
 * state only `measure` can change, and `measure` is EARLIER in ORDER: the walk
 * would stop here for ever, which is the defect being removed and not a
 * stricter version of the check. `steps/measure.mjs` asks that question, where
 * the answer is producible.
 */
export function staleReason(path = RESULT_JSON) {
  const measuredAt = mtimeOf(COVERAGE_JSON);
  if (measuredAt === null) return null;
  const reportedAt = mtimeOf(path);
  if (reportedAt === null) return null;
  if (reportedAt < measuredAt) {
    return (
      `${here(path)} is older than ${here(COVERAGE_JSON)} — it quotes a measurement that has since been replaced, ` +
      "and it is the document docker/finish.py reads as this run's result"
    );
  }
  // D31. AND WHAT IT READ OUT OF out/defects.json. A stall `repair` writes in a
  // walk where nothing was re-measured leaves coverage.json's timestamp where it
  // was, so the timestamp alone said "already done" over a result that still
  // read "no reason is written for them" (assessment-service, mocked,
  // 2026-09-25, walked to the end on its checkpoint). Stale only when this
  // run's rows differ from the ones the result was built from, so the note the
  // walk rewrites every walk does not re-run report every walk.
  const doc = reported(path);
  if (doc && (doc.defects_digest ?? null) !== defectsDigest(DEFECTS_JSON)) {
    return (
      `${here(path)} was built from a different ${here(DEFECTS_JSON)} than the one on disk — a defect, a note or a ` +
      "stall was written or cleared after it, and the result's status and reason read those rows"
    );
  }
  return null;
}

/**
 * THE DISK: a result that parses, carries both numbers, and is no older than
 * the coverage document it was computed from. The rate is not asked.
 */
export function satisfied(_repo) {
  const doc = reported();
  if (doc === null) return false;
  // A SALVAGE IS NOT A REPORT. `workflow.salvageResult` writes this same file
  // with `status: "partial"` on every non-zero ending, and a salvage parses,
  // carries both numbers and is newer than coverage.json -- so without this
  // line `report` says "already done" over a document whose own `partial.says`
  // reads "This run did not reach `report`", and docker/finish.py reads it as
  // a failed run. Measured on 20260920T030124Z through tools/replaywalk.mjs:
  // with this line the walk writes the result itself rather than inheriting
  // the salvage. A partial is the one document this step must overwrite.
  //
  // `partial.reportedBy` is the exception: report.mjs itself writes `partial`
  // for a measured run that is not a success (fix plan 1, rule 3). That is this
  // step's own verdict, and treating it as a salvage would re-run report for
  // ever.
  if (doc.status === "partial" && doc.partial?.reportedBy !== "report.mjs") return false;
  return staleReason() === null;
}

export function run(_repo) {
  const did = [];

  // `--out`, and nothing else. report.mjs:248-250 reads exactly this flag, and
  // resolves an absolute path unchanged.
  const outcome = runTool("report", ["--out", RESULT_JSON]);
  if (outcome.line) did.push(outcome.line);

  const doc = reported();
  if (doc === null) {
    did.push(
      `${here(RESULT_JSON)} is absent, unreadable, or carries no numeric ` +
        "`coverage_percentage.branches` and `.functions` — a run that measured nothing cannot report one"
    );
    return { did, pending: [], metrics: {} };
  }

  const stale = staleReason();
  if (stale) did.push(stale);

  // The status is REPORTED and not judged. `failed` here is a verdict about the
  // run, already computed by the tool and already in the file a person reads.
  did.push(`wrote ${here(RESULT_JSON)} — status ${doc.status}${doc.failed_reason ? `: ${doc.failed_reason}` : ""}`);

  return {
    did,
    pending: [],
    metrics: { branches: doc.coverage_percentage.branches, functions: doc.coverage_percentage.functions },
  };
}
