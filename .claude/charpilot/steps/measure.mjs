/**
 * measure — the suite measured under one denominator, and every `reaches`
 * claim checked against the arm it named.
 *
 * TWO TOOLS. `coverage.mjs` measures the committed suite and writes the join —
 * claims verified, sides still uncovered — to `out/coverage.json`
 * (coverage.mjs:87), appending one row to the loop ledger from the same totals
 * object so the history and the document can never disagree (coverage.mjs:688).
 * `union.mjs` then merges the stage-4 and stage-6 istanbul reports into one, so
 * a side hit by either half is counted once.
 *
 * A ROUND THAT MEASURED NOTHING FAILS. A FLAT ROUND DOES NOT. These pull in
 * opposite directions and getting them the wrong way round is the ordinary
 * mistake:
 *
 *   - No `coverage.json`, or one that will not parse, or one carrying no
 *     `totals`, means this round produced no measurement at all. Nothing
 *     downstream can be judged against it — not the ratchet, not a claim, not a
 *     ruling — so the step is not satisfied and the walk stops and says so.
 *   - Numbers IDENTICAL to the previous round are frequently correct. Late in a
 *     loop the sides that remain are the ones waiting on a person's ruling, and
 *     no input will move them; that is the loop working, not failing. So it is
 *     reported in `did` and the step is satisfied. gate.mjs's `progress` check
 *     is where two flat rounds in a row become a STOP, reading the same ledger
 *     — and it is a decision about whether another iteration is worth its cost,
 *     not a defect in this step. A check that fires on a healthy loop is one
 *     nobody reads on the day it is finally right.
 *
 * WHAT `satisfied` ALSO ASKS: the join must be no older than the suite it
 * describes. `emitted.json` is rewritten every time the suite is regenerated,
 * so a `coverage.json` older than it is a measurement of tests that no longer
 * exist — the stale-half merge union.mjs's own header prices at 1649 branches
 * reported against a real 1466, "a number that looked like progress".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { COVERAGE_DIR, OUT_DIR, PROPOSALS_DIR, REPO_ROOT, isCorpusSpec } from "../config.mjs";
import { incrementalOn, manifestHashes } from "../incremental.mjs";
import * as earlyMeasure from "./earlymeasure.mjs";
import { EMITTED_JSON, EMIT_TESTS_REL } from "./emit.mjs";
import { here, runTool } from "./preflight.mjs";
import { supersededReason } from "./record.mjs";

export const NAME = "measure";

/** The join and the ledger, fixed at coverage.mjs:87-88; config.mjs exports neither. */
export const COVERAGE_JSON = resolve(OUT_DIR, "coverage.json");
export const LOOP_JSON = resolve(OUT_DIR, "loop.json");

/* ------------------------------------------------------------------------ *
 * D51 — A CLAIM THAT CANNOT BE MEASURED IS REFUSED EVERY ROUND AND WITHDRAWN
 * BY NOBODY.
 *
 * THE DEFECT, run `20260919T104903Z` (location-ms), read off its own log.
 * Rounds 3 and 5 both stopped here on
 * `getPlaceDetailsSingleV1WithCountryCode-347-if-0-355-binary-expr-1-merged`,
 * claiming `src/services/googleMap.service.ts#355:binary-expr:0` side "null",
 * with byte-identical text — coverage.mjs measured that side at 0 hits both
 * times. `68bf8e7` made this step ASK instead of spin, and asking is not
 * repairing: the refusal names the row, the round ends, THE ROW STAYS ON DISK
 * ANSWERING ITS SIDE, and the next walk to reach stage 6 refuses on it again.
 * Three of that run's nine rounds died on two causes that were each raised
 * more than once, and 750 seconds of agent turn went to rounds that had one
 * item in front of them.
 *
 * WHAT WITHDRAWS IT TODAY, AND WHY IT NEVER RAN. `repair` withdraws every
 * FALSE claim the measurement recorded (steps/repair.mjs:withdrawFalseClaims)
 * — but `repair` is the step AFTER this one (steps/index.mjs ORDER), and this
 * step refusing is exactly what stops the walk before it. The automatic
 * withdrawal is downstream of the refusal that makes it necessary, so on this
 * run it never ran once.
 *
 * THE FIX, and it is the mechanism the quarantine already is. The row is set
 * aside the way `validate.mjs`'s refusals are set aside in `steps/derive.mjs`:
 * it stays on disk, it stops counting as an answer, and its side goes back
 * into the brief as an open question. Nothing here edits a proposal and
 * nothing here deletes one.
 *
 * AND NOTHING HERE WRITES ANYTHING. A first cut of this had `measure` record
 * its own refusal in `out/measure-refusal.json` for `derive` to read, and
 * `steps.never-repair-a-tools-output` is right to refuse it: a step that
 * writes what a step reads has made the disk into the run's second account,
 * and `satisfied` rests on the disk being the first. So the quarantine is read
 * out of THE TOOL'S OWN ARTIFACT — `out/coverage.json`, which coverage.mjs
 * writes — and the one fact the artifact was missing was added to the TOOL:
 * `suitePassed`, so a reader can tell a claim measured under a green suite
 * from one measured while tests were failing.
 *
 * WHY THAT FIELD EXISTS AND WHAT IT IS FOR. coverage.mjs writes the join
 * BEFORE it checks whether the suite passed (coverage.mjs:712 against :832),
 * so a `falseClaims` list is on disk in both cases. Under a failing suite
 * those numbers are an OVERSTATEMENT — a failing assertion runs after the row
 * body, so the counters had already moved — and a claim called false against
 * them is not evidence. `suitePassed: false` is therefore the one state that
 * quarantines nothing, which is D51's own distinction, made from the artifact
 * rather than from a second file.
 *
 * SELF-CLEARING, with nothing to clear. The quarantine IS the measurement: a
 * join with no false claim in it holds no row, and the next measurement that
 * passes rewrites the join. It cannot outlive what it was taken from.
 * ------------------------------------------------------------------------ */

/** The two refusals, named once so both readers spell them the same way. */
export const CANNOT_MEASURE = "measure-cannot-measure";
export const SUITE_DOES_NOT_PASS = "measure-suite-does-not-pass";

/* ------------------------------------------------------------------------ *
 * D92 — A MEASUREMENT THE TOOL FAILED IS NOT A QUESTION FOR THE AGENT.
 *
 * qode-ptp-ms run 20260930T170133Z (image 1.0-d92). The full measure at
 * 18:02Z was red: the 34 MB aiInterviewService spec's module fetch timed out
 * (D90 measured it again alone, and it loaded), and one unhandled error that
 * no test owned - `getFileStorageInstance(...).getBlobAccessLink is not a
 * function`, in the parse-cv route spec - was left. No row was named: the
 * verdict read "1 failing test(s): " and quoted the answered timeout. The
 * item went to the agent as `measure-suite-does-not-pass`, and round 1's
 * whole turn (18:05-18:10Z, 20 turns) was spent on it, rightly doing nothing:
 * "correct that row, or leave it", with no row.
 *
 * So a red measurement no row can clear is a TOOL FAILURE, returned as
 * `defect` and never as `pending`:
 *   - a spec whose module fetch timed out and timed out again when measured
 *     alone (D90) - the host, not a row;
 *   - every failure an unhandled error no row owns.
 * A failure that names a row is still the agent's, as before. A signal death
 * or a heap abort (D91) writes no coverage.json and was a defect already.
 * The walk's own machinery does the rest: a pulled-forward visit is asked
 * again at measure's own position, which measures again (`satisfied` is false
 * while the suite is red) - the retry; failing again there, it is written to
 * out/defects.json and the walk carries on to real items.
 *
 * `CHARPILOT_MEASURE_TOOL_DEFECT=off` hands it over as before.
 * ------------------------------------------------------------------------ */
export const TOOL_FAILURE = "measure-tool-failure";
export const TOOL_DEFECT_ENV = "CHARPILOT_MEASURE_TOOL_DEFECT";
export const toolDefectOn = (env = process.env) => String(env[TOOL_DEFECT_ENV] ?? "").trim().toLowerCase() !== "off";

/** Why this red measurement is the tool's and no row's, or null. */
export function toolFailure(doc) {
  if (!doc || doc.suitePassed !== false) return null;
  const failing = doc.failingTests ?? [];
  // A failure that names a row is a row to correct.
  if (failing.some((t) => t?.rowId)) return null;
  const again = (doc.loadTimeoutRetry?.files ?? []).filter((f) => f && f.loadedOnRetry === false);
  if (again.length) {
    return (
      `${again.map((f) => `${f.file} (${f.size})`).join(", ")} did not load under measurement: vitest's module fetch timed out, ` +
      `and again when measured ${doc.loadTimeoutRetry.how === "full" ? "in a second full measurement" : "alone"} (${again[0].message}) - the host, not a row`
    );
  }
  const unowned = failing.filter((t) => t?.unhandled && !t.rowId);
  if (failing.length && unowned.length === failing.length) {
    const u = unowned[0];
    return (
      `the suite was red only for ${unowned.length} unhandled error(s) no test owns and no row is named for ` +
      `(${u.file ?? "no spec file"}: ${String(u.message ?? "").slice(0, 200)})`
    );
  }
  return null;
}

/**
 * The rows a refused measurement condemns, off the join coverage.mjs wrote.
 *
 * TWO POPULATIONS, BOTH TAKEN FROM THE TOOL'S OWN ARTIFACT AND NEITHER
 * RE-DERIVED HERE:
 *
 *   FALSE       `falseClaims` — the row claims a side and istanbul recorded 0
 *               hits on it. coverage.mjs:846 exits 1 on this list alone, so it
 *               is the list that produced this run's refusal.
 *   UNMEASURABLE `unmeasurable`, and ONLY when nothing was checked at all.
 *               coverage.mjs:611 refuses a measurement that verified nothing,
 *               and a run in that state has every claimable row unjoined —
 *               run 20260919T092106Z's round 3 is the case, where `"[]
 *               (fallback)" is not a side of this arm` was the whole blocker.
 *               When claims WERE checked, an unmeasurable one is not what
 *               stopped the run and setting its row aside would reopen sides
 *               nobody asked about.
 */
export function unmeasurableRows(coverage) {
  // THE SUITE GATE, AND IT IS D51'S OWN DISTINCTION. `suitePassed: false` is a
  // measurement taken while tests were failing: every number in it is an
  // overstatement and a claim called false against it is not evidence of
  // anything. Absent is not false — a join written before this field existed
  // resolves the way every other ambiguity in the quarantine resolves, towards
  // holding MORE rows, because an over-held row costs one more question and an
  // under-held one costs the number's meaning.
  if (coverage?.suitePassed === false) return [];
  const rows = (coverage?.falseClaims ?? [])
    .filter((c) => c?.id)
    .map((c) => ({
      id: c.id,
      armId: c.armId ?? null,
      side: c.side ?? null,
      kind: "false-claim",
      why:
        `claims ${c.armId} side ${JSON.stringify(c.side)}` +
        `${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""} — istanbul says 0 hits`,
    }));
  if (rows.length) return rows;
  if (Number(coverage?.totals?.claimsChecked ?? 0) > 0) return [];
  return (coverage?.unmeasurable ?? [])
    .filter((u) => u?.id)
    .map((u) => ({ id: u.id, armId: u.armId ?? null, side: null, kind: "unmeasurable", why: u.why ?? "unmeasurable" }));
}

/**
 * D64 — the still-uncovered sides the RECORDER refused to exercise, off the
 * same join, with its own written reason on each.
 *
 * coverage.mjs marks them (`coverage.mjs`'s `markUndeliverable`) out of the
 * `skipped[]` entries record.mjs wrote in the recording that measurement was
 * taken from. This is the reader, and it is here for the reason
 * `unmeasurableRows` is: the step that owns `out/coverage.json` owns how that
 * document is read, so `derive` and `report` cannot come to different readings
 * of the same field.
 *
 * WHAT A READER MAY DO WITH THESE ROWS, and it is one thing: stop ASKING about
 * them. They are uncovered, they are in the denominator, and the rate already
 * counts them as missed — see the D64 block in coverage.mjs. A caller that
 * subtracted them from anything would be applying the dead-export correction
 * to live code.
 *
 * SELF-CLEARING FOR FREE. It is read out of the join and stored nowhere, so a
 * measurement whose recording no longer carries the skip yields no rows and
 * the sides are open again the same round. There is no state to clear and
 * therefore no step that has to remember to clear it.
 */
export function undeliverableRows(coverage) {
  return (coverage?.stillUncovered ?? [])
    .filter((row) => row?.undeliverable?.why && row.armId && row.side)
    .map((row) => ({
      armId: row.armId,
      side: row.side,
      file: row.file ?? null,
      line: row.line ?? null,
      functionId: row.functionId ?? null,
      functionName: row.functionName ?? null,
      // record.mjs's sentence, verbatim, exactly as it reached the artifact.
      why: row.undeliverable.why,
      saidBy: row.undeliverable.saidBy ?? "record.mjs",
      rule: row.undeliverable.rule ?? null,
      proposal: row.undeliverable.proposal ?? null,
    }));
}

/* ------------------------------------------------------------------------ *
 * D60 — THE STEP THAT WITHDRAWS THE BLOCKER RUNS AFTER THE STEP THE BLOCKER
 * STOPS, SO IT HAS NEVER RUN ON A RUN THAT HAD ONE.
 *
 * THE QUARANTINE ABOVE IS A HOLDING ACTION AND SAYS SO: the condemned row stops
 * ANSWERING its side, and nothing takes the false claim OFF the row. The next
 * measurement therefore reads the same `reaches` sentence, records the same
 * false claim, and `coverage.mjs` exits 1 again — which is exactly what rounds
 * 3 and 5 of `20260919T104903Z` did, byte for byte. D51's own stated residual.
 *
 * WHAT ALREADY CLOSES IT, AND HAS NEVER EXECUTED. `steps/repair.mjs`'s
 * `withdrawFalseClaims` spawns `propose.mjs --withdraw` once per FALSE claim
 * and takes the sentence off the document. `repair` is ORDER[13]; this step is
 * ORDER[12] and `derive` is ORDER[7], and both of them end the walk first.
 * Across the five container runs against a real service in `docker/runs` — 27
 * rounds — `repair` has printed no step line at all. The one run of thirteen in
 * which it HAS run, `20260918T072551Z`, is the shape that proves it: a
 * hand-driven round where `derive` was satisfied and `measure` did not yet hand
 * its refusal over, in which it withdrew 7 FALSE claims in one go.
 *
 * SO THIS STEP NAMES ITS CLEARER AND THE WALK SPLICES IT IN, the same way it
 * splices the banking steps ahead of a step that is about to ask. Nothing is
 * written here, nothing is reordered, and `steps/index.mjs:CLEARS_A_REFUSAL`
 * has to agree before the walk will act on the name.
 *
 * WHY THE ANSWER IS NOT A CONSTANT, AND THIS IS D51'S DISTINCTION AGAIN:
 *
 *   FALSE CLAIM    `withdrawFalseClaims` reads `coverage.falseClaims` and
 *                  withdraws each one. That IS the clear, so say so.
 *   SUITE FAILED   `rows` is empty by construction, because a measurement
 *                  taken while tests were failing is an overstatement and a
 *                  claim called false against it is not evidence. Withdrawing
 *                  against it would delete true claims on the strength of a
 *                  number that is known to be wrong. NOT clearable, and the
 *                  emitted test is the thing to fix.
 *   UNMEASURABLE   the zero-claims-checked shape (run 20260919T092106Z round
 *                  3). `withdrawFalseClaims` iterates `falseClaims` and there
 *                  are none, so it would spawn nothing and change nothing.
 *                  Splicing a step that cannot act is a round spent proving it.
 *
 * So: clearable exactly when this refusal condemned at least one FALSE claim.
 * ------------------------------------------------------------------------ */

/** The step that can take these rows off their documents, or null. */
export function clearableBy(rows = []) {
  return rows.some((r) => r?.kind === "false-claim") ? "repair" : null;
}

/** What the walk is about to do about it, in one line the run log carries. */
export function clearableSaid(rows, by) {
  const n = rows.filter((r) => r?.kind === "false-claim").length;
  return (
    `${n} of those row(s) state a FALSE claim, which \`${by}\` withdraws from the document by spawning propose.mjs ` +
    `— so \`${by}\` runs before this refusal is handed to anybody and this step is asked again over what it leaves ` +
    `behind. Until now \`${by}\` sat AFTER this step in the order and has printed no line in any run on record, ` +
    `which is why rounds 3 and 5 of 20260919T104903Z died on the same claim with byte-identical text`
  );
}

/** What this refusal set aside, in one line the run log carries. */
export function unmeasurableSaid(rows) {
  return (
    `${rows.length} recorded row(s) are QUARANTINED by this refusal — they stay on disk, they stop counting as an ` +
    `answer, and every side they claim is back in the brief as an open question, so the next round asks about it ` +
    `instead of dying here again: ${rows.map((r) => r.id).join(", ")}`
  );
}

/* ------------------------------------------------------------------------ *
 * THE ITEM THIS STEP HANDS OVER, AND WHY IT IS BUILT HERE RATHER THAN INLINE.
 *
 * WHAT THE OLD ITEM WAS: `{ id, title, detail }`. That is not the item
 * contract. `workflow.pendingJson` keeps `{ id, kind, question }` and drops
 * everything else, so what reached the disk was
 *
 *     { "pending": [ { "id": "measure-cannot-measure" } ] }
 *
 * — which is what round 5 of run `20260919T104903Z` printed back, verbatim,
 * out of the file it was handed. The walk's own log line for it is
 * `- [undefined] undefined` (round 3). The title and the detail — the
 * diagnosis, the row, the next move — were written and never left the process.
 *
 * WHAT THAT COST, on the same run: round 5 spent 194 seconds and round 7 spent
 * 201, each with 34 and 28 parent turns and ZERO child turns, on an item that
 * said nothing but its own name. Both rounds ended having asked nobody
 * anything. It is the cheapest line in this plan and it is why two of the six
 * dealt-nothing rounds bought nothing at all.
 *
 * `kind: "submission"` because that is what it is and because the deriving
 * prompt documents it: something already submitted could not be turned into an
 * answer, and the move is to correct the document it came from. The unmeasured
 * claim's row is a submitted row; the failing test was emitted from one.
 * ------------------------------------------------------------------------ */
/**
 * F2.2: the proposal rows the failing emitted tests came from, by id, with the
 * file each lives in. Read off coverage.mjs's `failingTests` and the proposals
 * directory; a test whose row is not found is still named, by its test.
 */
export function failingRows(coverage, dir = PROPOSALS_DIR) {
  const fileOf = new Map();
  for (const f of existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    for (const p of Array.isArray(doc) ? doc : Array.isArray(doc?.proposals) ? doc.proposals : []) {
      if (p?.id && !fileOf.has(String(p.id))) fileOf.set(String(p.id), f);
    }
  }
  const seen = new Set();
  const out = [];
  for (const t of coverage?.failingTests ?? []) {
    const id = t?.rowId ?? null;
    const key = id ?? t?.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id, proposal: id && fileOf.has(id) ? `${here(join(dir, fileOf.get(id)))}` : null, test: t.title, failure: t.message ?? null });
  }
  return out;
}

export function item({ suite, line, rows = [], failing = [] }) {
  const why = suite
    ? "A failing assertion runs AFTER the row body, so the counters had already moved: the percentage coverage.mjs " +
      "printed is an OVERSTATEMENT and not a shortfall. Do NOT edit the emitted test: `emit` regenerates it from its " +
      "row next round and the edit is gone. The row each failing test came from is named below" +
      (failing.length ? ` (${failing.slice(0, 5).map((f) => f.id ?? f.test).join(", ")}${failing.length > 5 ? ", …" : ""})` : "") +
      " — correct that row, or leave it: this is the toolset's item, asked once. NOTHING IS QUARANTINED for this " +
      "failure: every side involved is already answered."
    : "A claim istanbul recorded no hit for, or a side name that is not a side of the arm, can never be measured " +
      "from the row that wrote it. Correct the claim on the row named below — the arm's real side labels are in " +
      "the message — or withdraw it. The row is QUARANTINED: it stays on disk, it stops counting as an answer, and " +
      "its side is back in the brief as an open question, so this round asks about the side as well.";
  return {
    id: suite ? SUITE_DOES_NOT_PASS : CANNOT_MEASURE,
    // F2.2: the TOOL's item, not a submission to fix. The walk asks it once;
    // asked again unchanged, it goes to out/defects.json and is not asked.
    kind: "toolset",
    question:
      `${suite ? "the emitted suite does not pass, so its coverage cannot be believed" : "a recorded claim cannot be measured"}: ` +
      `${line}\n\n${why}`,
    context: {
      submission: {
        // F2.2: a failing test is answered at the ROW it was emitted from;
        // `emit` regenerates an edited test away.
        file: suite && failing.some((f) => f.proposal) ? failing.find((f) => f.proposal).proposal : here(COVERAGE_JSON),
        at: suite && failing.length ? failing.map((f) => f.id ?? f.test).join(", ") : "(coverage.mjs)",
        field: suite ? "(the proposal row each failing test was emitted from)" : "(a `reaches` claim)",
        ...(suite && failing.length ? { failingRows: failing } : {}),
        refusedBy: "coverage.mjs",
        why: `${line}\n\n${why}`,
        ...(rows.length
          ? {
              quarantined: rows.map((r) => `${r.id} — ${r.why}`),
              keepSiblings:
                "DO NOT REMOVE A QUARANTINED ROW TO MAKE ITS FILE PASS. It is already set aside — it stays on " +
                "disk, stops counting as an answer, and its side is back in the brief — so the round advances on " +
                "the rows that measured without you doing anything. A resubmission REPLACES THE DOCUMENT WHOLE, " +
                "so send the whole corrected document or send nothing for that file.",
            }
          : {}),
      },
    },
  };
}

/**
 * The two halves of the union, and where it lands.
 *
 * COVERAGE_DIR is stage 4's report (config.mjs) and the stage-6 directory is
 * coverage.mjs:84's `--coverage-dir` default, which this step does not override.
 * Both are resolved against REPO_ROOT because that is what both tools do.
 */
export const STAGE6_COVERAGE_DIR = resolve(REPO_ROOT, "coverage-charpilot-stage6");
export const UNION_DIR = resolve(REPO_ROOT, "coverage-union");

/**
 * Whether a half of the union is a MEASUREMENT OF THIS SUITE, rather than a
 * file of that name.
 *
 * WHAT THIS USED TO ASK: `existsSync(join(dir, "coverage-final.json"))`, which
 * is the question union.mjs asks before it throws — union.mjs:32 opens exactly
 * this file in each input directory. Existence is the right question for "will
 * union.mjs crash" and the wrong one for "should these two be merged".
 *
 * WHAT THAT COSTS. `coverage-charpilot` is stage 4's report and
 * `coverage-charpilot-stage6` is this stage's, and the union is what the
 * live-code rate is finally computed over. A stage-4 directory left behind by
 * an earlier round is a file of exactly this name describing a suite that has
 * since been regenerated, and merging it counts sides that this round's tests
 * never hit: union.mjs's own header prices one such merge at 1649 branches
 * reported against a real 1466 — "a number that looked like progress". The
 * merge is silent, so the run exits 0 and the number is quotable.
 *
 * SO THE QUESTION IS THE ONE `unjudgeable` ALREADY ASKS OF THE JOIN, one file
 * along: a half older than `emitted.json` measured a suite that no longer
 * exists. `emitted.json` is rewritten every time `--emit-tests` runs, which is
 * the only thing that changes which tests there are.
 *
 * REPORTED, NEVER REPAIRED, and that is why this is a predicate and not a
 * refusal. A stale half is named in `did` beside an absent one and the union is
 * skipped — the join in `out/coverage.json` is still written by coverage.mjs
 * and is still this round's, so the round is measured. Deleting the stale
 * directory would be this step repairing a tool's output.
 */
const measured = (dir) => {
  const report = join(dir, "coverage-final.json");
  if (!existsSync(report)) return false;
  const emittedAt = mtimeOf(EMITTED_JSON);
  if (emittedAt === null) return true;
  return statSync(report).mtimeMs >= emittedAt;
};

/** Milliseconds, or null when the file is not there. */
const mtimeOf = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);

/** The coverage join, or null when this round produced no readable one. */
export function readCoverage() {
  if (!existsSync(COVERAGE_JSON)) return null;
  try {
    const doc = JSON.parse(readFileSync(COVERAGE_JSON, "utf8"));
    return doc?.totals ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Why this round cannot be judged, or null when it can.
 *
 * ONLY absence, unreadability and staleness are reasons. A number that did not
 * move is not one of them — see the docblock.
 */
export function unjudgeable() {
  // BEFORE the join is read at all. A coverage entry credits an arm to an
  // input, and an input that has been repaired since the suite was rendered is
  // one this measurement never ran — so the number is about a program that no
  // longer exists, whatever its timestamps say. This is the third reading of
  // the same one question (steps/record.mjs:supersededReason), deliberately:
  // the recording, the verdicts, the tests and the coverage are invalidated
  // together or one of them outlives its repair with nothing saying so.
  const repaired = supersededReason();
  if (repaired) return repaired;
  const doc = readCoverage();
  if (doc === null) {
    return (
      `this round measured nothing — ${here(COVERAGE_JSON)} is absent, unreadable, or carries no \`totals\`, ` +
      "so the ratchet, the `reaches` claims and the still-uncovered list have no measurement to be judged against"
    );
  }
  const emittedAt = mtimeOf(EMITTED_JSON);
  // F1.4: a join of the baseline suite alone, taken because stage 3 wrote no
  // proposal, describes no emitted suite and needs none - while that is still
  // true. The first proposal makes it stale.
  if (emittedAt === null && doc.emptyStage3 && noProposals()) return null;
  if (emittedAt === null) return `${here(EMITTED_JSON)} is missing — nothing says which suite this measurement describes`;
  if (mtimeOf(COVERAGE_JSON) < emittedAt) {
    return (
      `${here(COVERAGE_JSON)} is older than ${here(EMITTED_JSON)} — it measures a suite that has since been regenerated, ` +
      "and a stale half read as fresh is how a merge comes to report more branches than exist"
    );
  }
  return null;
}

/**
 * The sentence for a round whose numbers did not move, or null.
 *
 * Read from the loop ledger rather than from a remembered figure, because the
 * ledger is the one artifact the agent does not write (coverage.mjs:301) and
 * the previous round's numbers are otherwise nobody's to hold.
 */
export function flatReason() {
  if (!existsSync(LOOP_JSON)) return null;
  let rows;
  try {
    rows = JSON.parse(readFileSync(LOOP_JSON, "utf8")).iterations ?? [];
  } catch {
    return null;
  }
  if (rows.length < 2) return null;
  const now = rows.at(-1);
  const before = rows.at(-2);
  const same = ["sides", "hitByEither", "stillUncovered"].every((k) => now?.[k] === before?.[k]);
  if (!same) return null;
  return (
    `coverage did not move: ${now.hitByEither}/${now.sides} sides, ${now.stillUncovered} still uncovered, identical to iteration ${before.n}. ` +
    "That is not a failure — the sides that remain may all be waiting on a ruling"
  );
}

/** coverage.mjs refuses an empty specs directory (coverage.mjs:107), so name it here. */
/** F1.4: stage 3 wrote no proposal file. */
export function noProposals() {
  return !existsSync(PROPOSALS_DIR) || !readdirSync(PROPOSALS_DIR).some((f) => f.endsWith(".json"));
}

export function precondition(_repo) {
  // F1.4: nothing was proposed, so nothing was emitted, and coverage.mjs
  // measures the baseline suite alone. Not a precondition failure.
  if (noProposals()) return null;
  const specs = resolve(REPO_ROOT, EMIT_TESTS_REL);
  const present = existsSync(specs) ? readdirSync(specs).filter(isCorpusSpec) : [];
  if (!present.length) {
    return `no *.test.ts in ${here(specs)} — coverage.mjs measures the committed suite, so emit it first`;
  }
  // Measuring a suite rendered from a superseded recording costs a full vitest
  // run and produces a number nothing may be ratcheted against. Refused rather
  // than measured and then disbelieved.
  const repaired = supersededReason();
  if (repaired) return `${repaired} Re-record, re-stamp and re-emit before this suite is measured.`;
  return null;
}

/**
 * A RULING WRITTEN SINCE THE JOIN RULED, or null when there is none.
 *
 * coverage.mjs rules every still-uncovered side at measure time, reading
 * BLOCKED.md (`readBlockedBySide`), and `report` reads those rulings and
 * nothing else. derive materialises a declaration AFTER it has banked the
 * round's measurement, so a side declared in the last round stayed `open` in
 * coverage.json: nothing about the suite had changed, so this step read as
 * done, and the run reported as open a side BLOCKED.md rules.
 * profile-centralized (September 2026): the declaration for
 * `organization.title ?? undefined [undefined]` landed, the ledger counted it
 * ruled, and result.json still said "1 side(s) are open - nothing covers them
 * and no reason is written for them".
 */
export function rulingsStale() {
  const blocked = join(PROPOSALS_DIR, "BLOCKED.md");
  const writtenAt = mtimeOf(blocked);
  const measuredAt = mtimeOf(COVERAGE_JSON);
  if (writtenAt === null || measuredAt === null || writtenAt <= measuredAt) return null;
  return (
    `${here(blocked)} has been written since ${here(COVERAGE_JSON)} ruled its still-uncovered sides, so a side it ` +
    "now rules would be reported open - measured again so the rulings are this BLOCKED.md's"
  );
}

/** THE DISK: a readable join, no older than the suite it describes, and ruled by the BLOCKED.md on disk. */
export function satisfied(_repo) {
  // Item 1: a measurement taken beside the gate is this step's to adopt, and
  // its join on disk is not done until it has been (steps/earlymeasure.mjs).
  if (earlyMeasure.pending()) return false;
  if (unjudgeable() !== null) return false;
  if (rulingsStale() !== null) return false;
  // F2.2. A join taken under a failing suite, or one the claims floor refused,
  // is a refusal still standing: re-measured and re-asked rather than read as
  // done - which is what lets the walk stop asking it after one repeat, and
  // what keeps an overstated number from reading as a finished measurement.
  // A false-claim refusal is not here: that join is the verdict (rule 3).
  const doc = readCoverage();
  return !(doc?.suitePassed === false || doc?.refused === "claims-floor");
}

/**
 * FIX PLAN 1, F1.3 — coverage.mjs's exit contract, as this step reads it.
 *
 *   0                            measured.
 *   1 and a coverage.json THIS   measured with a refusal (`refused` on the
 *     invocation wrote, readable  document says which): the step hands it over
 *     and carrying `totals`       and the rows it names are quarantined.
 *   anything else                a STEP DEFECT: the tool failed without its
 *                                artifact. Returned as `defect`, never as a
 *                                question, so the walk records it and goes on.
 *
 * "This invocation wrote" is the file's mtime against the moment the tool was
 * spawned, less a second for filesystems that keep whole-second times.
 */
/**
 * D91: the walk's one line for a vitest main process that ran with more than
 * node's default heap (coverage.json `measureHeap`), or null.
 */
export function heapSaid(heap) {
  if (!heap?.mb) return null;
  return heap.how === "retry"
    ? `vitest's main process ran out of heap (${heap.after}), so it was measured once more with a ${heap.mb} MB heap (${heap.killSwitch} measures once)`
    : `vitest's main process ran with a ${heap.mb} MB heap, not node's default ${heap.defaultMB} MB: it keeps every loaded spec's transform, about ${heap.needMB} MB for ${heap.specMB} MB of spec (${heap.killSwitch} keeps the default)`;
}

export function freshJoin(since) {
  if (!existsSync(COVERAGE_JSON) || statSync(COVERAGE_JSON).mtimeMs < since - 1000) return null;
  return readCoverage();
}

/**
 * What this step runs coverage.mjs with. No `--specs`: it defaults to the
 * committed suite as of coverage.mjs:75, which is the directory emit.mjs just
 * wrote; passing it again would be a second place for that name to be true.
 * `--incremental` lets coverage.mjs measure only the spec files that changed
 * and have vitest merge the rest's kept coverage - on EVERY visit, the bank
 * walk's included, because the merge is the full measurement's equal by
 * construction and coverage.mjs measures in full whenever it cannot show that
 * (incremental.mjs). Exported so the measurement `emit` starts beside the gate
 * (steps/earlymeasure.mjs) is this one exactly.
 */
export function coverageArgs() {
  return incrementalOn() ? ["--incremental"] : [];
}

export function run(repo) {
  // Item 1: a measurement started beside the gate is waited for and adopted,
  // or refused and this step measures as before.
  if (earlyMeasure.pending()) {
    return earlyMeasure.adopt(manifestHashes(EMITTED_JSON)?.digest ?? null, freshJoin).then((got) => {
      if (got.adopted) return measureOver(got.cov, got.since, [got.said, ...(got.rowLine ? [got.rowLine] : [])]);
      return measureOver(null, Date.now(), [`the measurement started beside cigate is not kept - ${got.why}`]);
    });
  }
  return measureOver(null, Date.now(), []);
}

/** The rest of `run`, over `cov` (runTool's shape), or over a coverage.mjs spawned here when it is null. */
function measureOver(adopted, since, said) {
  const did = [...said];
  const metrics = {};
  const spawnedAt = since;

  const cov = adopted ?? runTool("coverage", coverageArgs());
  if (cov.line && (!adopted || !cov.ok)) did.push(cov.line);

  if (cov.ok) {
    if (existsSync(COVERAGE_JSON)) did.push(`wrote ${here(COVERAGE_JSON)}`);
  }
  const joined = readCoverage();
  const by = joined?.measuredBy;
  // D90: a spec whose module fetch timed out, measured again - one line, with
  // the file and its size, whichever way it went.
  const retry = joined?.loadTimeoutRetry;
  if (retry && freshJoin(spawnedAt)) {
    for (const f of retry.files ?? []) {
      did.push(
        `${f.file} (${f.size}) did not load under measurement - vitest's module fetch timed out (${f.message}) - ` +
          `so it was measured again ${retry.how === "alone" ? "alone, merged with the coverage of every other spec file" : `with every spec file (${retry.why})`}: ` +
          (f.loadedOnRetry ? "it loaded, and the measurement is the whole suite's" : "it timed out again, which is the environment, not a behaviour change") +
          ` (${retry.killSwitch} measures once)`
      );
    }
  }
  // D91: vitest's main process given more than node's default heap - one
  // line, with why and the switch.
  if (heapSaid(joined?.measureHeap) && freshJoin(spawnedAt)) did.push(heapSaid(joined.measureHeap));
  if (by && freshJoin(spawnedAt)) {
    did.push(
      by.scope === "partial"
        ? `measured ${by.ran.length} changed spec file(s) (${by.ran.join(", ")}) and merged the kept coverage of ${by.reused} - ${by.why}`
        : `measured ${by.scope === "unchanged" ? "nothing" : "every spec file"} - ${by.why}`
    );
  }

  if (cov.ok) {

    // BOTH halves or neither. union.mjs throws on a directory with no
    // `coverage-final.json`, and its own header is about what a merge over a
    // half that was not re-measured produces — so an absent half is reported
    // rather than merged over.
    const inputs = [COVERAGE_DIR, STAGE6_COVERAGE_DIR];
    const absent = inputs.filter((d) => !measured(d));
    if (absent.length) {
      did.push(
        `no union: ${absent.map(here).join(" and ")} hold no coverage-final.json, or hold one older than ` +
          `${here(EMITTED_JSON)} and so measured a suite that has since been regenerated. A merge over a half that ` +
          `was not measured is the corruption union.mjs was written about`
      );
    } else {
      // INPUTS FIRST, OUTPUT LAST — union.mjs:23-24 takes `argv.slice(2, -1)`
      // as the directories to merge and `argv.at(-1)` as where the report goes.
      const union = runTool("union", [...inputs, UNION_DIR]);
      if (union.line) did.push(union.line);
    }
  }

  const doc = readCoverage();
  if (doc === null) {
    // Said here as well as in `unjudgeable`, because this is the line the walk
    // quotes back when it refuses, and "ran (nothing)" is not a diagnosis.
    did.push(`this round measured nothing — ${here(COVERAGE_JSON)} is absent, unreadable, or carries no \`totals\``);
  } else {
    const t = doc.totals;
    metrics.sides = t.sides;
    metrics.hitByEither = t.hitByEither;
    metrics.stillUncovered = t.stillUncovered;
    const flat = flatReason();
    if (flat) did.push(flat);
  }

  /* ---------------------------------------------------------------------- *
   * A MEASUREMENT THAT CANNOT BE TAKEN IS A QUESTION, NOT A LOOP.
   *
   * This returned `pending: []` whatever happened, so a coverage.mjs that
   * exited non-zero was reported in `did` and nothing else. `satisfied` then
   * stayed false, the walk went back to `derive`, and `derive` briefed the
   * handful of sides still open — a full agent round, 17 to 22 minutes and $8
   * to $9, spent on three or six sides while the actual blocker sat in stage 6
   * untouched.
   *
   * Measured on run 20260919T092106Z (location-ms): it banked 89.6% branches by
   * round 3 and was still going at 78 minutes against a 56-minute baseline,
   * because `measure` could not pass and nothing asked anybody to fix it.
   *
   *   round 3  coverage.mjs exited 1 — "[] (fallback)" is not a side of this arm
   *   round 4  coverage.mjs exited 1 — the suite under measurement did not pass
   *
   * The run was not slow. It was failing to stop.
   *
   * Two failures, and they want different work. An unmeasurable CLAIM is a
   * stage-3 input to repair. A suite that does not PASS is an emitted test to
   * fix, and the row it came from is named in the same output. Neither is
   * answerable by deriving more inputs, so both are handed over — after every
   * `did` line above, because the diagnosis is what the reader needs and the
   * question is what the next round acts on.
   * ---------------------------------------------------------------------- */
  if (!cov.ok && !freshJoin(spawnedAt)) {
    const line = cov.line ?? "coverage.mjs exited non-zero";
    did.push(
      `coverage.mjs exited ${cov.status ?? "abnormally"} and wrote no coverage.json in this run — that is a tool ` +
        "failure, not a refusal anybody can answer"
    );
    return {
      did,
      pending: [],
      metrics: { ...metrics, measureDefect: 1 },
      defect: { tool: "coverage.mjs", exit: cov.status ?? null, message: line },
    };
  }

  // D92: red for a reason no row can clear - the tool's, recorded, not asked.
  const tool = !cov.ok && toolDefectOn() ? toolFailure(doc) : null;
  if (tool) {
    did.push(
      `${tool}. No row an agent could write clears that, so it is recorded as a pipeline defect and not dealt as a ` +
        `decision; measure runs again at its own position (${TOOL_DEFECT_ENV}=off hands it over)`
    );
    return {
      did,
      pending: [],
      metrics: { ...metrics, measureToolFailure: 1 },
      defect: { tool: "coverage.mjs", id: TOOL_FAILURE, exit: cov.status ?? null, message: `measure: ${tool}` },
    };
  }

  if (!cov.ok) {
    const line = cov.line ?? "coverage.mjs exited non-zero";
    const suite = /did not pass|vitest exited/i.test(line);
    // D51. WHICH ROWS THIS REFUSAL CONDEMNS — named here, held by `derive`.
    // Nothing is written: `steps.never-repair-a-tools-output` is the house
    // rule and it is right. The rows are read back out of coverage.mjs's own
    // join, by the step that has to stop counting them.
    const rows = suite ? [] : unmeasurableRows(doc);
    if (rows.length) did.push(unmeasurableSaid(rows));
    // D60. Who clears this without asking anybody — `clearableBy` above.
    const clearedBy = clearableBy(rows);
    if (clearedBy) did.push(clearableSaid(rows, clearedBy));
    return {
      did,
      metrics: { ...metrics, measureRefused: 1, measureQuarantinedRows: rows.length },
      pending: [item({ suite, line, rows, failing: suite ? failingRows(doc) : [] })],
      clearableBy: clearedBy,
    };
  }

  // A MEASUREMENT THAT PASSED REFUSES NOTHING, and nothing has to be cleared
  // for that to be true: the quarantine is read out of this measurement's own
  // join, so a join with no false claim in it holds no row. It cannot outlive
  // the measurement it was taken from because it IS the measurement.
  return { did, pending: [], metrics };
}
