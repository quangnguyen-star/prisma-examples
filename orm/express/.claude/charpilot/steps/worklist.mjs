/**
 * worklist — the uncovered sides, joined to the scan's arm model and to the
 * baseline's istanbul denominator, as the brief stage 3 derives against.
 *
 * WHAT `satisfied` ASKS, and why existence is not enough. The worklist is
 * DERIVED from out/scan.json: it names arms by `file#line:kind:index`, so a
 * scan that ran afterwards has already moved every line the brief quotes. A
 * worklist older than the scan beside it is therefore not a shorter worklist,
 * it is a worklist about a tree that no longer exists — and read as fresh it
 * sends an agent to derive inputs for arms at lines that have moved, which is
 * the same class of defect armids.mjs exists to catch after the fact.
 *
 * So freshness is a mtime comparison against SCAN_JSON, taken off the disk like
 * everything else here. NOT-OLDER rather than strictly newer: worklist.mjs runs
 * after scan.mjs and the two writes can land in the same millisecond, and
 * treating that as stale would re-run the brief on every walk forever.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { BASELINE_JSON, COVERAGE_DIR, OUT_DIR, SCAN_JSON, WORKLIST_JSON } from "../config.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "worklist";

/** The istanbul run the brief is measured against; worklist.mjs reads it directly. */
const COVERAGE_FINAL = join(COVERAGE_DIR, "coverage-final.json");

/**
 * The three inputs worklist.mjs reads with no existence check of its own
 * (worklist.mjs:266, :409, :410). Each is another step's artifact, so a missing
 * one is an inconsistency in the walk rather than a question for anybody.
 */
export function precondition(_repo) {
  for (const [path, why] of [
    [SCAN_JSON, "the arm model every worklist item names"],
    [BASELINE_JSON, "the istanbul denominator the brief is quoted against"],
    [COVERAGE_FINAL, "the per-file istanbul counters that say which sides are uncovered"],
  ]) {
    if (!existsSync(path)) return `${here(path)} is missing — worklist.mjs reads it for ${why}`;
  }
  return null;
}

/** THE DISK: the brief exists, and it is not older than the scan it describes. */
export function satisfied(_repo) {
  if (!existsSync(WORKLIST_JSON) || !existsSync(SCAN_JSON)) return false;
  return statSync(WORKLIST_JSON).mtimeMs >= statSync(SCAN_JSON).mtimeMs;
}

/**
 * worklist.mjs's own code for "stage 3 is past its budget with proposals on
 * disk", from worklist.mjs:1147.
 *
 * A NUMBER AND NOT A REGEX OVER THE MESSAGE. The sentence the tool prints is
 * the thing the walk quotes verbatim to the reader; routing on it as well would
 * make a reworded sentence into a wedged run.
 */
const OVER_BUDGET = 3;

export function run(_repo) {
  const outcome = decide(runTool("worklist"));

  // WHAT THE LAST RECORDING STILL ANSWERS, said where the work is decided.
  //
  // This step builds the list stage 3 is asked about, and stage 3 is 97% of a
  // run's clock - 7,614s of 7,749s on notification-ms, 13,550s of 14,010s on
  // pricing-ms, every second of it an agent turn against the gateway. A second
  // run of the same service used to repeat all of it, because nothing from the
  // first survived: the proposals live under `.claude/`, which targets
  // gitignore, so 0 of 56 reached the branch of run `20260921T184935Z`.
  //
  // `sincelast.mjs` reads the `recorded.json` the corpus now carries, diffs the
  // commit it was recorded against with HEAD, and says how much of it still
  // holds. Measured on notif-prod against a commit four back, nine files
  // changed: 75 of 79 rows still answered, 4 in a changed file, 0 arms gone.
  //
  // READ-ONLY, AND NEVER FATAL. It decides nothing and closes no side; a
  // missing recording, a sha this clone does not have and an absent ledger are
  // each a written reason rather than a refusal. A first run on a repo has no
  // recording and must derive everything, which is correct and not a fault.
  const since = runTool("sincelast");
  if (since.line) outcome.did.push(since.line);
  // THE COUNTS, not the fact that it ran. `runTool`'s line says "ran
  // sincelast.mjs", which tells the agent nothing it can act on - and the whole
  // value of this step is the three numbers.
  outcome.did.push(sinceLine());
  return outcome;
}

/** `out/since-last.json`, read back as one sentence for the walk's `did`. */
export function sinceLine(read = defaultSince) {
  const doc = read();
  if (!doc) return "since-last: no out/since-last.json - every recorded row must be treated as unanswered";
  if (doc.state === "no-recording") {
    return "since-last: this corpus carries no recorded.json, so nothing from a previous run can be reused - derive every side";
  }
  if (doc.state === "unanswerable") return `since-last: UNANSWERABLE - ${doc.reason}. Treat every recorded row as unanswered`;
  const t = doc.totals ?? {};
  return (
    `since-last: ${doc.changedFiles ?? 0} file(s) changed since ${String(doc.head ?? "?").slice(0, 7)} - ` +
    `${t.valid ?? 0} of ${t.rows ?? 0} recorded row(s) still answered, ` +
    `${t.redoByFile ?? 0} in a changed file, ${t.gone ?? 0} whose arm is gone (delete, do not re-derive)`
  );
}

function defaultSince() {
  try {
    return JSON.parse(readFileSync(join(OUT_DIR, "since-last.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * What the walk does with worklist.mjs's exit, as a function of that exit alone.
 *
 * SEPARATE FROM `run` so the three answers can be exercised without spawning the
 * tool. They are three, they are not interchangeable, and getting one of them
 * wrong is not visible in a log: a refusal reported and then ignored reads
 * exactly like a refusal that was handled.
 */
export function decide(outcome) {
  const did = [];
  if (outcome.line) did.push(outcome.line);

  /* ---------------------------------------------------------------------- *
   * PAST THE BUDGET, THE WALK GOES ON TO `record` — IT DOES NOT SIT HERE.
   *
   * WHAT THIS STEP USED TO DO. `run` was `runTools(["worklist"], WORKLIST_JSON)`
   * and nothing else, and `satisfied` is `mtime(worklist.json) >=
   * mtime(scan.json)`. worklist.mjs:1147 exits 3 and WRITES NOTHING when stage 3
   * is past its budget with proposals unrecorded — deliberately, because
   * rebuilding the brief at that point would re-open sides whose answers are
   * already on disk waiting to be run. So the brief keeps the mtime it had, the
   * predicate keeps answering false, and the step keeps re-running the tool that
   * keeps refusing.
   *
   * WHY RE-RUNNING CANNOT CLEAR IT. The clock the budget is measured against is
   * cleared by RECORDING (record.mjs:2728 — "a brake that cannot be released is
   * not a brake, it is a wall"), and `record` is ORDER[8] while this is ORDER[5].
   * Nothing between here and there can move it, and the walk stops at the first
   * step that is not satisfied — so `record` is unreachable from this state by
   * construction, for every remaining round of the run.
   *
   * THE SHAPE IS NOT NEW AND IT IS DELIBERATELY THE SAME ONE. `steps/derive.mjs`
   * meets this identical refusal from the identical tool and answers it with
   * `deferTo: "record"`, which workflow.mjs honours ONLY when the named step is
   * genuinely later in THIS order — run 20260917T131746Z died at minute 36.8
   * with all 146 sides of round 1 answered and unrecorded before that existed.
   * Two steps spawning one tool must read its exit 3 the same way, or the walk's
   * behaviour depends on which of them happened to be asked first.
   *
   * NOTHING IS ASKED. There is no question here for an agent: the answers are
   * already on disk and the move is mechanical.
   * ---------------------------------------------------------------------- */
  if (outcome.status === OVER_BUDGET) {
    did.push(
      "stage 3 is past its budget with proposals unrecorded, so worklist.mjs wrote no new brief and this step " +
        "cannot become satisfied by running it again. record is what clears the clock, and the brief rebuilt after " +
        "it describes what is actually still open — nothing is discarded, and the previous brief stays on disk."
    );
    return { did, pending: [], metrics: { overBudget: 1 }, deferTo: "record" };
  }

  /* ---------------------------------------------------------------------- *
   * A BRIEF THE TOOL REFUSED TO BUILD IS NOT A BRIEF THE WALK MAY USE.
   *
   * Every other non-zero exit used to land here and be reported in `did` — and
   * then this returned success. `satisfied` is `mtime(worklist.json) >=
   * mtime(scan.json)`, so whenever an EARLIER worklist.json was still newer than
   * the scan, the walk read the step as done and `derive` dealt a round built
   * from a brief worklist.mjs had just declined to rebuild. Nothing downstream
   * noticed, because nothing downstream is told.
   *
   * Found on notification-ms while probing: worklist.mjs exited 1 with
   * "worklist measures 16 uncovered sides where coverage-charpilot recorded 108,
   * and CHARPILOT_PROBE_FUNCTIONS excluded 161 — so 16 + 161 should equal 108",
   * and the round was dealt anyway. That refusal was itself a defect in the
   * selector's arithmetic and is fixed; the walk continuing past it is a
   * separate defect and this is it. A self-check that the walk ignores is not a
   * self-check.
   *
   * ASKED RATHER THAN RAISED. The tool's own sentence is the whole diagnosis and
   * an agent can act on most of what it says — a stale artifact to delete, a
   * scan to re-run, a selector to correct — so this hands it over the way every
   * other refusing step now does. What it must not do is nothing.
   * ---------------------------------------------------------------------- */
  if (!outcome.ok) {
    return {
      did,
      pending: [{
        id: "worklist-refused",
        title: "worklist.mjs refused to rebuild the brief",
        detail:
          `${outcome.line ?? "worklist.mjs exited non-zero"}\n\n` +
          "The brief on disk, if there is one, was built BEFORE this refusal and does not describe what is open " +
          "now. A round dealt from it asks about sides that may already be answered and misses sides that are not, " +
          "so the walk stops here rather than deriving from it. Fix what the tool names, then this step rebuilds " +
          "the brief and the round is dealt from what is actually open.",
      }],
      metrics: { refused: 1 },
    };
  }

  // Named from the disk rather than from the tool's claim to have written it,
  // which is the rule `runTools` keeps and the same one `satisfied` follows.
  if (existsSync(WORKLIST_JSON)) did.push(`wrote ${here(WORKLIST_JSON)}`);
  return { did, pending: [], metrics: {} };
}
