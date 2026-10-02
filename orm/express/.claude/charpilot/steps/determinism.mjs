/**
 * determinism — every recorded row OBSERVED A SECOND TIME, and the verdict
 * stamped onto the row it judges.
 *
 * THE STAGE THE WALK NEVER HAD. `determinism.mjs` has been in the toolset all
 * along and no step referenced it: ORDER went `derive, record, emit, measure`
 * with nothing between the recording and the emission. Under the old shape one
 * agent drove all 29 tools and ran this itself — run 20260916T024808Z typed it
 * by hand and said so ("wasn't in the original 4-command list but the tool
 * refused otherwise") — and when the driving moved into the walk, the command
 * moved nowhere.
 *
 * Run 20260916T194950Z is what that costs. Stage 3 closed cleanly, `record`
 * wrote behaviour.json, and `emit` then exited 1 at 147 minutes with no
 * coverage number at all:
 *
 *     emit: record.mjs exited 1 — Unstamped: convertToRawLocationWithLanguage-
 *     39-cond-expr-0 anonymous-18-if-0 … (+50 more)
 *
 * record.mjs:1949 refuses to render a row that carries no verdict, and its own
 * comment says why: emitting it asserts a value byte-exactly without ever
 * having measured whether that value is the same on a second observation. A
 * subject that writes a fresh Date or uuid into its own return value then
 * produces a test that CANNOT pass, and the failure reads as the service being
 * nondeterministic rather than as this stage being skipped.
 *
 * NOT OPTIONAL, and that is a decision rather than an omission. `workflow.mjs`
 * excuses an OPTIONAL step from the "ran, asked nothing, still unsatisfied"
 * refusal — which is right for `vocabulary`, whose whole job is to make
 * `derive` better informed. It is wrong here: an unmeasured row does not make
 * the next stage worse informed, it makes the next stage emit an assertion
 * nobody measured. If this cannot be done the run stops here and says so.
 *
 * WHAT `satisfied` ASKS, and why it is not "determinism.json exists".
 * record.mjs:1949 reads the verdict off the OBSERVATION, and record.mjs:1977
 * copies the outcome from that same map —
 * `observed.get(r.id).determinism`, where `observed` is behaviour.json's own
 * rows (record.mjs:1897) — precisely because a side file can be skipped, can go
 * stale against the recording it judges, and can cover only a subset; all three
 * happened. `determinism.mjs --write` stamps the verdict ONTO each row, so a
 * fresh recording drops every stamp with the rows it replaces and nothing can
 * disagree with the disk. This step asks the same disk the same question:
 * WHICH INVOKED ROWS CARRY NO `determinism` FIELD. A determinism.json beside a
 * re-recorded behaviour.json would answer yes to a question nobody asked.
 *
 * THE POPULATION IS THE ONE record.mjs:1948 USES, exactly. Rows with `invoked`,
 * and no others: a row the emitter never looks at is not a row whose absence of
 * a verdict may stop a run, and a step that demanded more than `emit` does
 * would stall a walk that `emit` would have accepted — the same defect as
 * reporting satisfied while `emit` refuses, one direction along.
 *
 * A NOT-COMPARED ROW IS UNCHECKED, NOT STABLE, and this step reports it and
 * does not refuse it. determinism.mjs:222 stamps `{compared: false, reason}`
 * on a row absent from the second observation, and record.mjs:1949 tests for
 * the VERDICT, not for the comparison — so `emit` accepts it and pins the value
 * byte-exactly with `__unstablePaths` empty. Refusing it here would stop every
 * round over a row that can never be compared, which is how a stage that exists
 * to prevent a dead run becomes one. So `satisfied` agrees with `emit` and
 * `did` says out loud how many values are about to be asserted unmeasured.
 * Run 20260916T031317Z found the way this goes wrong at scale: `recordSecond`
 * does not check the spawned recorder's exit code, so a refused second
 * observation leaves a STALE behaviour-second.json and every new row reports
 * "absent". That is a defect in the tool, named here and fixed there.
 *
 * WHAT THIS STEP PUTS ON THE COMMAND LINE, and what it deliberately does not.
 *
 *   --write     ALWAYS. Without it determinism.mjs writes the report and stamps
 *               nothing (determinism.mjs:268-281), so the step would run the
 *               whole second observation, cost what it costs, and leave `emit`
 *               refusing exactly as before.
 *   --live      When, and only when, `liveDecision` says this round is live.
 *               The record step passes NO arguments because record.mjs asks
 *               `liveDecision` itself (steps/record.mjs:13-20); determinism.mjs
 *               does not — it reads `--live` off its own argv
 *               (determinism.mjs:57) and resolves behaviour-live.json from it
 *               (determinism.mjs:90). Omitted on a live round it judges the
 *               mocked artifact, or throws ENOENT. So the flag is passed from
 *               the SAME decision function, never from a second one.
 *   --policy    Read off `selection.policy` of the recording being judged
 *               (record.mjs:2041), which is the only thing that knows how the
 *               first observation was actually taken. determinism.mjs forwards
 *               it to the second observation, and the second observation must
 *               be taken THE SAME WAY as the first or every boundary the policy
 *               answers differently reports as per-run identity. The walk's own
 *               recordings are all at record.mjs's default, so this matters for
 *               the round that resumes over a recording someone made by hand:
 *               `record` reports itself satisfied over it, and nothing else
 *               would ever have compared the two policies.
 *   --env-file  NOT PASSED, and that is the same rule the record step keeps.
 *               determinism.mjs never reads the env itself; it only forwards
 *               the flag to the record.mjs it spawns, and that record.mjs
 *               resolves `out/staging.env` for itself when nothing is passed
 *               (record.mjs:93-99, `defaultEnvFile`). The FIRST observation was
 *               taken by a record.mjs that resolved it exactly the same way —
 *               run 20260916T194950Z's behaviour.json records `envFile:
 *               .claude/charpilot/out/staging.env` under `selection.argv: []`.
 *               Spelling the path here would be this layer paraphrasing the
 *               resolver below it, and would turn a missing staging.env from
 *               "no env file, as before" into `--env-file <path> not found`.
 *   --row-timeout  NOT PASSED. determinism.mjs reads the budget off the first
 *               observation's own rows and forwards it (determinism.mjs:196-200);
 *               a budget from anywhere else made 1 of 16 rows report as unstable
 *               that were not.
 *
 * THIS STEP WRITES NOTHING. determinism.mjs owns both formats — the report and
 * the stamp — and this spawns it. `out/determinism.json` is read here for the
 * count that goes in the log and never for `satisfied`.
 *
 * COST. This is a second recording of every row, served from the second
 * observation's OWN cache for each row already observed a second time at the
 * same input and harness (determinism.mjs `recordSecond`). It used to be
 * `--fresh`, so every walk paid for every row: 13 rows in ~35s on run
 * 20260916T024808Z, and 1,135 rows in about 26 minutes on sourcing-ms
 * (2026-09-26), which is what outgrew the walk's bound. On a LIVE round every
 * row that is not cached is a real billed request for the second time, which is
 * why the mode is the first line of `did` rather than something a reader infers
 * from an invoice.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BEHAVIOUR_JSON, OUT_DIR } from "../config.mjs";
import { here, runTool } from "./preflight.mjs";
import { mode, recordedArtifact, supersededReason } from "./record.mjs";

export const NAME = "determinism";

/**
 * Where determinism.mjs writes its report, fixed at determinism.mjs:36.
 * config.mjs exports no constant for it, so it is derived here against OUT_DIR
 * rather than re-spelled as a string in two places — the same reason emit.mjs
 * derives EMITTED_JSON.
 *
 * Read for the LOG ONLY. See the docblock: `satisfied` is answered from the
 * stamps on the rows, never from this file.
 */
export const DETERMINISM_JSON = resolve(OUT_DIR, "determinism.json");

/**
 * The artifact determinism.mjs will actually open.
 *
 * NOT `recordedArtifact()`. That one honours CHARPILOT_OUTPUT, as record.mjs
 * does; determinism.mjs:90 resolves its first observation from `--live` ALONE
 * and never looks at that variable. The two agree on every ordinary run and the
 * precondition below is where they are made to say so, rather than the step
 * stamping one file and asking about another for as many rounds as the walk has.
 */
export function judgedArtifact() {
  return mode().live ? resolve(OUT_DIR, "behaviour-live.json") : BEHAVIOUR_JSON;
}

/**
 * The ids of the rows `emit` will refuse over, or null when the recording
 * cannot be read at all.
 *
 * Ids rather than a boolean because `run` prints them: "6 of 58 rows carry no
 * verdict (anonymous-18-if-0, …)" is where a reader goes next, and a bare false
 * is a reader diffing two documents by hand — which is what run
 * 20260916T194950Z's operator was left with.
 *
 * `r.invoked && !r.determinism` is record.mjs:1897 and record.mjs:1949 in one
 * line, and it is the same question on purpose. See the docblock.
 */
export function unstamped(artifact = recordedArtifact()) {
  if (!existsSync(artifact)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(artifact, "utf8"));
  } catch {
    return null;
  }
  return (doc.rows ?? []).filter((r) => r?.id && r.invoked && !r.determinism).map((r) => r.id);
}

/** How the first observation was taken, so the second can be taken the same way. */
export function recordedPolicy(artifact = recordedArtifact()) {
  if (!existsSync(artifact)) return null;
  try {
    return JSON.parse(readFileSync(artifact, "utf8")).selection?.policy ?? null;
  } catch {
    return null;
  }
}

/** The totals determinism.mjs wrote, or null. For the log; never for `satisfied`. */
function report() {
  if (!existsSync(DETERMINISM_JSON)) return null;
  try {
    return JSON.parse(readFileSync(DETERMINISM_JSON, "utf8")).totals ?? null;
  } catch {
    return null;
  }
}

/**
 * determinism.mjs exits 1 with its own diagnosis when there is no first
 * observation, and that is a stage-4 state rather than a stage-5 failure, so it
 * is named here instead of spawned into.
 */
export function precondition(_repo) {
  const artifact = recordedArtifact();
  if (!existsSync(artifact)) {
    return `${here(artifact)} is missing — determinism.mjs compares a second observation against the first, so record it first`;
  }
  // A STAMP IS A VERDICT ABOUT ONE VERSION OF ONE INPUT. Stamping a row whose
  // proposal has been repaired since would put a fresh-looking verdict on a
  // stale observation, and `emit` reads the verdict off the row it is about to
  // render — so record.mjs:1949 would pass and the suite would assert values
  // from a program that no longer exists. Re-recording is what drops the stamp
  // with the row it judges (record.mjs:2696 republishes rows from the cache,
  // which determinism.mjs never writes to), so the only correct move is back to
  // `record`. Unreachable on an ordinary walk — `record` runs first and clears
  // it — which is exactly what a precondition is for: an inconsistency nobody
  // can answer, rather than a question for an agent.
  const repaired = supersededReason(artifact);
  if (repaired) return `${repaired} Re-record before a second observation is taken of them.`;
  const judged = judgedArtifact();
  if (resolve(artifact) !== resolve(judged)) {
    return (
      `this round recorded to ${here(artifact)} and determinism.mjs judges ${here(judged)} — it resolves that path from ` +
      `--live alone (determinism.mjs:90) and never reads CHARPILOT_OUTPUT, so it would stamp its verdicts onto a recording ` +
      `\`emit\` will not read. Run the walk without CHARPILOT_OUTPUT, or stamp that artifact by hand.`
    );
  }
  return null;
}

/* --------------------------------------------------------------------------
 * A SECOND OBSERVATION THAT FAILED LEAVES ROWS THIS STEP CANNOT STAMP, AND THE
 * WALK HAS TO BE ABLE TO ROUTE THAT.
 *
 * WHAT THE PAIR OF THEM DOES. `satisfied` is "no `invoked` row is missing a
 * `determinism` field", and `determinism.mjs`'s own refusal path
 * (determinism.mjs:262-284) exits 1 having STAMPED NOTHING AT ALL when the
 * second observation does not finish — deliberately, and its comment argues the
 * case well: a recorder that did not run is not evidence that a row is
 * incomparable, and stamping `compared: false` over it would let `emit` pin a
 * value byte-exactly that nothing ever compared.
 *
 * WHAT THAT COSTS WHEN IT IS THE STEP'S ONLY ANSWER. The refusal is all-or-
 * nothing over the whole recording: one row that cannot settle a second time —
 * a subject that times out, a boundary staging answers differently on the
 * second pass — takes every other row's verdict with it. `run` then spawns the
 * tool, the tool refuses, the rows are as unstamped as before, and `satisfied`
 * is false in a state running again cannot change. This is ORDER[9], so `emit`,
 * `measure`, `repair`, `ruling` and `report` are all behind it: the run ends
 * with a full recording and no coverage number, which is run 20260918T073111Z's
 * ending reached by a different door.
 *
 * SO THE ROWS ARE HANDED OVER. Each unstamped row becomes one item carrying its
 * id, the recorder's own bytes, and the two moves that actually exist — repair
 * or withdraw the proposal so the row is re-recorded (which re-opens the
 * question honestly), or fix what `record.mjs` is reporting. Both are things an
 * answering turn does; neither is something this step can do, which is exactly
 * the test for whether a state belongs in `pending`.
 *
 * NOT `OPTIONAL`, AND THE DOCBLOCK ABOVE ALREADY ARGUES WHY: an unmeasured row
 * does not make the next stage worse informed, it makes the next stage emit an
 * assertion nobody measured. Skipping this step is the one ending that must not
 * be available. Asking is.
 *
 * WHERE THE DURABLE FIX BELONGS, said here because this is the layer that had
 * to work around it: `determinism.mjs` should stamp `{ compared: false, reason }`
 * on the rows a failed second observation NEVER REACHED — the way
 * determinism.mjs:222 already stamps the rows a GOOD second observation simply
 * did not contain — and keep its refusal for the rows it did reach. Then a
 * deterministically-failing row costs its own verdict and not the run's. That
 * is a change in the tool, and a step that quietly repaired the tool's output
 * instead would leave it wrong for the next repo.
 * ------------------------------------------------------------------------ */

/**
 * One open question per row `emit` will refuse over, or none.
 *
 * `said` is the recorder's own words, verbatim: `run` reads them off
 * `runTool`'s line, and a paraphrase here would be this layer restating the one
 * below it.
 */
export function pendingFor(rows, said, artifact) {
  return rows.map((id) => ({
    id: `determinism:${id}`,
    kind: "determinism",
    question:
      `\`${id}\` was recorded and invoked, and the second observation never stamped a verdict on it, so ` +
      `record.mjs:1949 will refuse to emit it. Repair or withdraw the proposal behind it, or fix what the recorder ` +
      `is reporting — re-running this step alone cannot stamp it.`,
    context: {
      row: id,
      artifact: here(artifact),
      // THE TOOL'S OWN BYTES. determinism.mjs prints which stream record.mjs
      // spoke on and quotes the tail of it; that sentence is the diagnosis, and
      // a summary of it would send the reader back to the log to find the
      // original.
      toolSaid: said ?? "determinism.mjs left this row unstamped and said nothing this step could read",
      says:
        "A stamp is a verdict about one version of one input, and determinism.mjs stamps NOTHING when the second " +
        "observation does not finish (determinism.mjs:262-284) — a recorder that did not run is not evidence that a " +
        "row is incomparable. That refusal is over the whole recording, so one row that cannot settle twice holds " +
        "every other row's verdict, and `emit`, `measure`, `repair` and `report` are all behind this step. The two " +
        "moves that exist: repair the proposal so the row is re-recorded and re-stamped, or withdraw it so there is " +
        "no row to emit. Do not hand-write a `determinism` field onto the row — `emit` reads it as a measurement " +
        "and pins the value byte-exactly on the strength of it.",
    },
  }));
}

/**
 * THE DISK: every row `emit` will look at carries a verdict OF ITS OWN — its
 * own, meaning about the version of the proposal that is on disk now.
 *
 * A verdict that survived its proposal's repair is not a verdict about this
 * row, and reporting satisfied over it is how a stale stamp reaches `emit`
 * looking exactly like a fresh one.
 */
export function satisfied(_repo) {
  const missing = unstamped();
  if (missing === null || missing.length) return false;
  return supersededReason() === null;
}

export function run(_repo) {
  const decision = mode();
  const artifact = recordedArtifact();
  const before = unstamped(artifact) ?? [];

  // FIRST, and before anything is spawned — the same rule the record step
  // keeps, for the same reason. This is a SECOND observation of every recorded
  // row, and on a live round that is every row billed again; a round that dies
  // halfway still has to say so.
  const did = [
    `mode: ${decision.live ? "live — the second observation of each row is a real request, billed again" : "mocked — every boundary is answered by a double"} (${decision.why})`,
    `${before.length} row(s) carry no verdict — a second observation of ${here(artifact)} follows; a row already observed a ` +
      `second time at the same input and harness is served from the second observation's own cache, and every other row is recorded again`,
  ];

  const policy = recordedPolicy(artifact);
  const args = [
    ...(decision.live ? ["--live"] : []),
    // The policy the RECORDING says it was taken under, not one this file
    // chooses. A second observation under a different policy observes a
    // different program, and every row the policy answers differently then
    // reports as per-run identity.
    ...(policy ? ["--policy", policy] : []),
    // The stamp is the deliverable. Without it the report is written, the rows
    // carry nothing, and `emit` refuses exactly as it did before.
    "--write",
  ];

  const started = Date.now();
  const outcome = runTool("determinism", args);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (outcome.line) did.push(outcome.line);

  const after = unstamped(artifact);
  const totals = report();

  if (after === null) {
    did.push(`${here(artifact)} is absent or unreadable, so no row carries a verdict`);
  } else if (after.length) {
    const shown = after.slice(0, 3).join(", ");
    did.push(
      `${after.length} of ${before.length} row(s) still carry no determinism verdict (${shown}${after.length > 3 ? ", …" : ""}) — ` +
        `record.mjs:1949 refuses to emit those rather than assert a value whose stability was never measured`
    );
  }

  if (totals) {
    did.push(
      `${here(DETERMINISM_JSON)}: ${totals.rowsCompared} of ${totals.rowsInFirst} row(s) compared, ` +
        `${totals.rowsUnstable} carry per-run identity, ${totals.rowsNotCompared} not compared`
    );
    if (totals.rowsNotCompared) {
      // SAID, not refused. See the docblock: `emit` accepts a `compared: false`
      // verdict, so the honest report is which values are about to be pinned
      // without ever having been measured.
      did.push(
        `${totals.rowsNotCompared} row(s) were NOT COMPARED — absent from the second observation, so they are UNCHECKED rather ` +
          `than stable, and \`emit\` will pin their values byte-exactly. determinism.mjs's recordSecond does not check the ` +
          `spawned recorder's exit code (run 20260916T031317Z), so a stale ${here(resolve(OUT_DIR, "behaviour-second.json"))} reads this way too`
      );
    }
  }

  did.push(`the second observation of ${before.length} row(s) took ${seconds}s`);

  // THE ROWS THE TOOL COULD NOT STAMP GO IN FRONT OF THE ANSWERING TURN. Empty
  // on every round where the second observation finished, which is every
  // healthy round — `after` is then [] and nothing is asked. See the block
  // above `pendingFor` for what the alternative cost.
  //
  // `after === null` is the recording being unreadable, which is not a question
  // about a row: `precondition` owns the absent artifact and `did` has already
  // said the artifact cannot be read.
  const stuck = outcome.ok || after === null ? [] : (after ?? []);
  const pending = supersededReason(artifact) ? [] : pendingFor(stuck, outcome.line, artifact);
  if (pending.length) {
    did.push(
      `${pending.length} row(s) are handed over: determinism.mjs stamps nothing at all when the second observation ` +
        `does not finish, so re-running this step reports the same refusal and the walk never reaches emit`
    );
  }

  return {
    did,
    pending,
    metrics: {
      seconds,
      rowsCompared: totals?.rowsCompared ?? 0,
      rowsNotCompared: totals?.rowsNotCompared ?? 0,
      rowsUnstable: totals?.rowsUnstable ?? 0,
      unstamped: after === null ? before.length : after.length,
    },
  };
}
