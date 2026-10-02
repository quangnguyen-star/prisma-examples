/**
 * Is the recorded value the SAME on a second observation?
 *
 * A characterization test asserts a value produced by running the code. If that
 * value carries per-run identity, the test is flaky by construction and will be
 * deleted by whoever hits it on a Friday - which quietly removes real coverage.
 *
 * Found by one failing generated test: `getLangfuseWithKeyTraceV1-key-without-
 * baseUrl` returns a Langfuse client whose `pendingEventProcessingPromises` is
 * keyed by a FRESH UUID per construction. The two snapshots were byte-identical
 * in length and equal at every leaf; the difference was a key. Scanning values
 * for uuid-shaped strings missed it entirely.
 *
 * So this does not guess. It records every row twice and reports which paths
 * differ, and stage 5 excludes exactly those paths from the assertion - keeping
 * the rest of the value pinned instead of discarding the row.
 */
import { spawnSync } from "node:child_process";
import { modeStamp } from "./targets.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { BEHAVIOUR_JSON, OUT_DIR, PILOT_DIR, SELF_REPO_ROOT } from "./config.mjs";
import { INCREMENTAL_RECORD } from "./config.mjs";
// The row budget is READ OFF THE FIRST OBSERVATION, from the same resolver the
// emit path uses - see the note on recordSecond. Importing record.mjs is safe
// and cheap: it guards its own main() on import.meta.main, which is what the
// gate's `tools-parse` check relies on to load every tool here.
import { resolveRowTimeout } from "./record.mjs";

const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const ENV_FILE = arg("--env-file");
const ROW_TIMEOUT_GIVEN = ARGV.includes("--row-timeout");
const ROW_TIMEOUT_FLAG = ROW_TIMEOUT_GIVEN ? Number(arg("--row-timeout")) : null;
const SECOND = join(OUT_DIR, "behaviour-second.json");
const OUTPUT = join(OUT_DIR, "determinism.json");

/**
 * THE RECORDER THIS SPAWNS, resolved where every other tool here resolves it.
 *
 * It was `".claude/charpilot/record.mjs"` run with `cwd: REPO_ROOT`, and both
 * halves of that are wrong on a foreign-target run. `REPO_ROOT` is
 * `CHARPILOT_TARGET_ROOT` (config.mjs:47) - the checkout being MEASURED, which
 * holds no tools and must never be written into - while the toolset, the
 * artifacts and `OUT_DIR` all hang off `SELF_ROOT` (config.mjs:40-52). On an
 * ordinary run the two are the same directory and nothing shows; on a bench run
 * the spawn lands in a tree with no `.claude/charpilot` in it, which is run
 * 20260916T093831Z's `/work is not a package root` one script along.
 *
 * So: the script is the SIBLING of this file (`PILOT_DIR`, config.mjs:49) -
 * the same copy this module already imports `resolveRowTimeout` from, so the
 * budget logic and the recorder that must honour it can never come from two
 * different installs - and the CWD is `SELF_REPO_ROOT`, which is what
 * steps/preflight.mjs:88 does and for the reason stated there: config.mjs
 * resolves the repo from the CWD and fixes every path at import, so a tool
 * spawned from anywhere else writes its artifacts where nothing reads them.
 *
 * `CHARPILOT_TARGET_ROOT` is not touched. The child reads it from the inherited
 * environment exactly as this process did, so the second observation is taken
 * of the same target as the first.
 */
const RECORDER = join(PILOT_DIR, "record.mjs");

/**
 * WHICH RECORDING IS BEING JUDGED. `record.mjs` writes a `--live` recording to
 * `behaviour-live.json` and a mocked one to `behaviour.json`; this script read
 * `behaviour.json` UNCONDITIONALLY, and had no `--live` flag to pass.
 *
 * So on a live run it judged the mocked artifact - or, with no mocked artifact
 * present, threw ENOENT - and either way `determinism.json` came out holding
 * verdicts for rows that are not the rows being emitted. `record.mjs`'s emit
 * path then looks each live row id up in that report, misses, and falls through
 * its `?? []` to "no unstable paths" - which emits a BYTE-EXACT assertion on a
 * value whose stability was never measured.
 *
 * Measured on location-ms: the subject writes `createdAt: new Date()` into its
 * own return value, so three emitted tests asserted one run's timestamp against
 * another's and failed on `returned.createdAt.$date` alone. The same rows pass
 * under a mocked run only because the mocked run's determinism report is the
 * one this script can actually read. That is the whole live-vs-mocked coverage
 * gap: not a property of live boundaries, a stage that could not see them.
 */
const LIVE = ARGV.includes("--live");
/**
 * THE POLICY, FORWARDED. It was not, and the comment in recordSecond() states
 * the invariant that omission breaks: "The second observation has to be taken
 * THE SAME WAY as the first... A determinism report is only meaningful between
 * two observations of the same configuration."
 *
 * record.mjs defaults to `--policy real-except-cache`, so a first observation
 * recorded under `--policy as-declared` - which is what every run on this
 * branch typed, to stop prisma being forced real - was compared against a
 * second one taken under a DIFFERENT boundary policy. Every row whose answer
 * the policy replaced then differed for that reason alone and reported as
 * unstable, which excludes the value from the assertion: the row is recorded,
 * emitted, and pins nothing.
 *
 * The guard that refuses exactly this mismatch cannot fire here.
 * record.mjs's guardOutput() compares the stored `selection.policy` against the
 * running one, but returns early when the output file does not exist - and
 * recordSecond points CHARPILOT_OUTPUT at a fresh behaviour-second.json, so it
 * never exists. The check was real and unreachable.
 *
 * Read as a value rather than as a flag-presence test, so `--policy` with no
 * argument is refused here instead of forwarding `undefined` into the argv.
 */
const POLICY = (() => {
  if (!ARGV.includes("--policy")) return null;
  const v = arg("--policy");
  if (!v || v.startsWith("--")) {
    process.stderr.write("\n\u2717 --policy needs a value (as-declared | real-except-cache | right-level)\n");
    process.exit(2);
  }
  return v;
})();
const FIRST_JSON = LIVE ? join(OUT_DIR, "behaviour-live.json") : BEHAVIOUR_JSON;

/** Every leaf path of a snapshot, so a differing KEY is as visible as a differing value. */
function leaves(value, prefix = "", out = new Map()) {
  if (value && typeof value === "object") {
    const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : Object.keys(value);
    if (!keys.length) out.set(prefix, Array.isArray(value) ? "[]" : "{}");
    for (const k of keys) leaves(value[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

/**
 * The DEEPEST prefix that explains a set of differences.
 *
 * A generated key makes its siblings differ, so the useful answer is the parent
 * that holds them - `returned.langfuse.pendingEventProcessingPromises`, not
 * `returned`. The first version walked UP to the shortest prefix with more than
 * one differing descendant, which is always the root: it reported "returned"
 * for two differing leaves and would have told stage 5 to exclude the entire
 * value rather than one field.
 */
function collapse(paths) {
  const parentOf = (p) => p.split(".").slice(0, -1).join(".");
  const byParent = new Map();
  for (const p of paths) {
    const par = parentOf(p);
    if (!byParent.has(par)) byParent.set(par, []);
    byParent.get(par).push(p);
  }
  const out = new Set();
  for (const [par, kids] of byParent) {
    // More than one sibling differing under the same parent means the PARENT is
    // what is unstable (its key set), not each child value.
    out.add(kids.length > 1 && par ? par : kids[0]);
  }
  // Drop anything already covered by a shorter answer in the set.
  return [...out].filter((p) => ![...out].some((q) => q !== p && p.startsWith(`${q}.`))).sort();
}

/**
 * HOW LONG THE SECOND OBSERVATION MAY TAKE, from the number of rows it observes.
 *
 * It was a flat 30 minutes, sized against nothing. sourcing-ms (2026-09-26)
 * observed 844 of its 1,135 rows in 20 minutes, so the whole recording needed
 * about 26 of the 30, and qode-ptp-ms has several times the rows. A recorder
 * stopped by this limit stamps every row it did not reach `compared: false`, so
 * a limit a large repo cannot fit inside pins values nobody compared.
 *
 * Five seconds a row is about three times the rate measured there (1.4 s a row,
 * mocked, 12 to a chunk). The 30 minutes stays as the floor. The walk's own
 * bound, set by the pack from the run's clock, is still the outer one.
 */
export const SECOND_OBSERVATION_FLOOR_MS = 30 * 60_000;
export const SECOND_OBSERVATION_MS_PER_ROW = 5_000;
export function secondObservationLimitMs(rowCount) {
  const rows = Number.isFinite(rowCount) && rowCount > 0 ? rowCount : 0;
  return Math.max(SECOND_OBSERVATION_FLOOR_MS, rows * SECOND_OBSERVATION_MS_PER_ROW);
}

/**
 * A STOP SIGNAL IS NOT A FACT ABOUT A ROW.
 *
 * The pack stops a walk that runs past its bound by sending SIGTERM to the
 * walk's process group, and this recorder is in that group. On sourcing-ms
 * (2026-09-26) that happened 844 rows into the second observation. This process
 * was blocked in spawnSync, so the signal reached it only after the child had
 * died, and by then it had already stamped the other 291 rows `compared: false`
 * ("never reached this row - record.mjs was killed by SIGTERM"). The step
 * reads any stamp as done, so the bank walk that followed reported
 * `determinism: already done` and would have emitted those 291 values pinned
 * byte-exactly, compared by nobody.
 *
 * So a recorder killed by SIGTERM, SIGINT or SIGHUP that this process did not
 * kill (its own limit sets `run.error`) leaves the rows it did not reach
 * UNSTAMPED. The rows it reached are compared as usual, the exit is still
 * non-zero, and the next walk observes only the rest, from the cache.
 */
export const STOP_SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGHUP"]);
export function stoppedFromOutside(run) {
  return !run?.error && STOP_SIGNALS.includes(run?.signal);
}

/**
 * The second observation has to run under the SAME per-row budget as the first,
 * and this used to spawn record.mjs without `--row-timeout` at all.
 *
 * A row is compared on `returned` and `threw`. A row that settles in 12s under
 * the first observation's 30000ms budget does not settle under the spawned
 * run's 10s default, so the second observation holds a `notSettled` row with no
 * `returned` at all - and this script then reports it as differing, i.e. as the
 * SERVICE carrying per-run identity. Measured: 1 of 16 rows unstable at the
 * default, 0 of 16 when the same rows were re-run at 30000ms. The verdict named
 * the service; the cause was a flag nobody typed.
 *
 * So the budget is read off the first observation's own rows and forwarded. The
 * budget is part of record.mjs's harness version, and the harness version is in
 * the cache file's NAME, so a second observation taken under another budget is
 * never served for this one.
 *
 * NOT `--fresh` ANY MORE, AND THE SECOND OBSERVATION IS STILL SECOND. The
 * recorder spawned here writes behaviour-second.json, and record.mjs gives a
 * redirected artifact its own cache (`cacheFileName`). So a row served from
 * that cache is this row's own earlier SECOND observation, of the same proposal
 * (the fingerprint) under the same harness (the version), and never the first
 * observation handed back. `--fresh` made every walk observe every row a second
 * time. On sourcing-ms (2026-09-26, 1,135 rows) that was the step that grew
 * with the repo: 500 to 880 seconds a walk, when the rows that had changed took
 * seconds to record. The last walk was killed by the pack's timeout 844 rows
 * into it, and with `--fresh` those 844 rows were lost. From the cache, a walk
 * observes only the rows it has not already observed twice, and a walk that is
 * stopped resumes where it stopped.
 */
function recordSecond(rowTimeoutMs, ids, total) {
  const rowCount = ids ? ids.length : total;
  process.stdout.write(
    `· recording a second observation of the ${rowCount} row(s) at --row-timeout ${rowTimeoutMs} ` +
      `(rows already observed a second time, at the same input and harness, come from the second observation's own cache)\n`
  );
  // ONLY THE ROWS THAT CARRY NO VERDICT (item 6), named to the recorder by id
  // (record.mjs `--ids`). A file, because a walk after a proposal change can
  // name hundreds of them.
  const IDS = ids ? join(OUT_DIR, `.determinism-ids.${process.pid}.json`) : null;
  if (IDS) writeFileSync(IDS, `${JSON.stringify(ids)}\n`);
  // THE EARLIER SECOND OBSERVATION IS REMOVED BEFORE THE SPAWN, so that the
  // file's existence afterwards means THIS recorder wrote it.
  //
  // `behaviour-second.json` is only ever written by the child below, and the
  // child was asked for it by name (CHARPILOT_OUTPUT). Leaving last run's copy
  // on disk makes `existsSync(SECOND)` answer a question about the PAST: the
  // spawn fails, the stale file is opened as "the second observation", and
  // every row recorded since reads as absent from it. That is run
  // 20260916T031317Z - the 96.7% run - diagnosing its own second observation as
  // silently failing.
  //
  // Unlinking is not enough on its own (a child that fails after truncating the
  // file would still leave one), which is why the exit code is checked too. It
  // is the half that closes the case where the child never starts at all and
  // writes nothing: without it, a spawn that never ran is indistinguishable
  // from one that ran a month ago.
  rmSync(SECOND, { force: true });
  const run = spawnSync(
    process.execPath,
    [
      RECORDER,
      "--chunk",
      "12",
      "--row-timeout",
      String(rowTimeoutMs),
      // The second observation has to be taken THE SAME WAY as the first.
      // Without this the comparison is mocked-vs-live, so every boundary answer
      // differs and every row reports unstable - which excludes the whole value
      // from the assertion and pins nothing at all. A determinism report is
      // only meaningful between two observations of the same configuration.
      ...(LIVE ? ["--live"] : []),
      // And the POLICY, for the same reason as --live and with the same force:
      // a boundary the policy answers differently is a boundary whose two
      // observations were never of the same thing. See the note beside POLICY.
      ...(POLICY ? ["--policy", POLICY] : []),
      ...(ENV_FILE ? ["--env-file", ENV_FILE] : []),
      ...(IDS ? ["--ids", `@${IDS}`] : []),
    ],
    // The limit is sized from the rows (secondObservationLimitMs), and the
    // buffer is preflight.mjs runTool's 64 MB: the recorder prints per chunk.
    { cwd: SELF_REPO_ROOT, encoding: "utf8", env: { ...process.env, CHARPILOT_OUTPUT: SECOND }, timeout: secondObservationLimitMs(rowCount), maxBuffer: 64 * 1024 * 1024 }
  );
  if (IDS) rmSync(IDS, { force: true });

  /**
   * BOTH STREAMS, because the commonest real failure here speaks on stdout.
   *
   * This was `run.stderr || run.stdout`, which drops stdout whenever stderr has
   * anything in it at all. record.mjs's most likely non-zero exit is
   * record.mjs:2188 - `failedChunks`, "N chunk(s) produced nothing - rerun to
   * resume; a stalled recorder is a STOP" - and it prints that on STDOUT, after
   * having already written a PARTIAL artifact. That is the exact case this
   * refusal exists for, and quoting the wrong stream would refuse it without
   * saying why.
   */
  const tailOf = (s) => (s ?? "").trim().split("\n").slice(-12).join("\n").slice(-1500);
  const said = [
    ["stderr", tailOf(run.stderr)],
    ["stdout", tailOf(run.stdout)],
  ]
    .filter(([, t]) => t)
    .map(([k, t]) => `  record.mjs ${k}:\n${t}`)
    .join("\n");
  const where = `  spawned: ${RECORDER}\n  cwd:     ${SELF_REPO_ROOT}\n`;
  /**
   * A SECOND OBSERVATION THAT DID NOT RUN IS NOT EVIDENCE OF ANYTHING.
   *
   * The exit code used to be discarded. Nothing downstream could recover it:
   * a row missing from the second observation is stamped
   * `{compared:false, reason:"absent from the second observation"}` below, and
   * record.mjs:1949 tests for the VERDICT and not for the comparison - so
   * `emit` accepts the row and pins its value byte-exactly with
   * `__unstablePaths` empty. A value nobody ever compared, asserted as stable.
   *
   * WHY THIS IS A REFUSAL AND "ABSENT" IS NOT. Both end with a row that was not
   * compared, and they are not the same fact. A row can be legitimately absent
   * from a GOOD second observation - the recorder ran, exited 0, and that row is
   * simply not in what it produced - and refusing over that would stall every
   * round for ever on a row that can never be compared, which is the stage
   * eating the pipeline it exists to protect. A recorder that exited non-zero is
   * the other thing entirely: nothing was observed, so nothing is known, and no
   * row may be described either way. The EXIT CODE is the only signal that
   * separates them and it was the one being thrown away.
   *
   * So the two outcomes stay distinct all the way out of here - and both of them
   * are now WRITTEN DOWN, which only one of them used to be.
   *
   * THIS PATH USED TO EXIT 1 HAVING STAMPED NOTHING AT ALL: no
   * `determinism.json`, and no verdict on any row, on the argument that a row
   * nobody observed must not be described. That argument is right about the ROW
   * and wrong about the RUN. `steps/determinism.mjs` asks "is any invoked row
   * missing a `determinism` field", so the refusal was all-or-nothing over the
   * whole recording: one row that cannot settle a second time - a subject that
   * times out, a boundary staging answers differently on the second pass - took
   * every other row's verdict with it, `satisfied` was then false in a state
   * running again cannot change, and this is ORDER[9], so `emit`, `measure`,
   * `repair`, `ruling` and `report` are all behind it. The run ends with a full
   * recording and no coverage number at all, which is run 20260918T073111Z's
   * ending reached by a different door. The step was left inferring the state
   * from an ABSENCE and handing every unstamped row over as a question - and
   * says so, at steps/determinism.mjs:229-270, along with where the fix belongs.
   *
   * SO WHAT IS KNOWN IS RECORDED, AND THE REFUSAL STAYS. A row this observation
   * never reached is stamped `{compared: false, reason: "<what happened>"}` - the
   * same shape the absent-row path below already writes, with the reason naming
   * the recorder's failure rather than the row's absence, and `secondObservation`
   * saying which kind of not-compared it is. A row the observation DID reach is
   * compared normally: record.mjs's commonest non-zero exit (`failedChunks`,
   * record.mjs:2188) leaves a PARTIAL artifact behind, an observation that exists
   * is evidence whatever the process's exit code was, and discarding it would
   * report a measured row as unmeasured - while `compared:true` with unstable
   * paths is the ONLY verdict that excludes a path from the assertion, so
   * throwing it away makes the emitted test flakier, not safer. The process still
   * exits non-zero with the recorder's own words, so the walk still stops here
   * rather than printing a coverage number over a half-observed run.
   *
   * WHAT THAT TRADES, stated rather than hidden: `emit` reads a `compared:false`
   * verdict as a measurement it may proceed on (record.mjs:1949 tests for the
   * VERDICT, not for the comparison) and pins the value byte-exactly. That was
   * already true of every row absent from a GOOD recording, and here it is
   * bounded in the only ways a document can bound it - the row itself says which
   * failure produced it, `determinism.json` counts it under `rowsNotCompared`
   * beside a `secondObservation` that names the failure, and the step prints
   * both. The alternative is not a safer emit; it is a run that cannot reach emit
   * at all, and that reaches it a round later over the same recording with
   * nothing written down about why.
   */
  // RETURNED, NOT EXITED, and that is what makes the stamping possible at all.
  // Each of these three called `process.exit(1)` from inside this function,
  // which put the decision in the one place that had not read a row yet. The
  // failure is DESCRIBED instead and `main` decides what to write before it
  // carries the exit code out: `how` is one phrase short enough to sit on a row
  // as its `reason`, `text` is the whole refusal, printed unchanged.
  if (run.error) {
    // The child never ran: a missing script, a bad interpreter, or the 30-minute
    // timeout killing it. `spawnSync` reports this here and NOT in `status`.
    return {
      how: `could not be started - ${run.error.message}`,
      text:
        `\n✗ determinism: the second observation could not be started - ${run.error.message}\n` +
        where +
        `  Nothing was observed a second time, so no row may be reported as compared.\n` +
        (said ? `${said}\n` : ""),
    };
  }
  if (run.status !== 0) {
    return {
      stopped: stoppedFromOutside(run),
      // The phrase reads after "record.mjs " wherever it is used - in SOURCE
      // and in each uncompared row's reason - so it is the recorder's outcome
      // and nothing else.
      how: run.signal ? `was killed by ${run.signal}` : `exited ${run.status}`,
      text:
        `\n✗ determinism: refusing to compare - the second observation FAILED ` +
        `(record.mjs ${run.signal ? `was killed by ${run.signal}` : `exited ${run.status}`}).\n` +
        where +
        `  A recorder that did not finish is not evidence that a row is incomparable, and this stage\n` +
        `  will not report one as compared on the strength of it. ` +
        (stoppedFromOutside(run)
          ? `It was STOPPED from outside, so the rows it never reached\n` +
            `  are left unstamped and the next walk observes them, resuming from this observation's cache;\n` +
            `  the rows it DID reach are compared as usual.\n`
          : `The rows it never reached are\n` +
            `  stamped \`compared: false\` with this failure named on each of them, so no value is pinned\n` +
            `  as measured; the rows a partial recording DID reach are compared as usual.\n` +
            `  Fix what record.mjs is reporting and run this stage again.\n`) +
        (said ? `${said}\n` : ""),
    };
  }
  if (!existsSync(SECOND)) {
    // Exited 0 and produced no artifact. Same refusal, different sentence: there
    // is nothing to read, and last run's copy is gone rather than about to be
    // mistaken for this one's.
    return {
      how: `exited 0 and wrote no ${relative(SELF_REPO_ROOT, SECOND) || SECOND}`,
      text:
        `\n✗ determinism: refusing to compare - record.mjs exited 0 and wrote no ` +
        `${relative(SELF_REPO_ROOT, SECOND) || SECOND}.\n` +
        where +
        `  There is no second observation to compare against. Any earlier one was removed before\n` +
        `  the spawn on purpose, so that this check cannot be answered by a stale file.\n` +
        (said ? `${said}\n` : ""),
    };
  }
  return null;
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // Named, not thrown. An ENOENT stack here reads as a broken script; the real
  // situation is a stage run out of order, and the next action differs.
  if (!existsSync(FIRST_JSON)) {
    process.stderr.write(
      `\n\u2717 determinism: ${relative(SELF_REPO_ROOT, FIRST_JSON)} does not exist, so there is no first observation to compare against.\n` +
        (LIVE
          ? "  Record the live pass first:  node .claude/charpilot/record.mjs --live --env-file <env>\n"
          : "  Record the mocked pass first: node .claude/charpilot/record.mjs\n" +
            "  (if the recording you mean to judge is a LIVE one, pass --live here too - this script\n" +
            "   judges whichever artifact record.mjs wrote, and the two are not interchangeable)\n")
    );
    process.exit(1);
  }

  // READ FIRST, RECORD SECOND. The order is the fix: the budget the second
  // observation must run under is a property of the first one's rows, so the
  // artifact has to be open before anything is spawned.
  const first = JSON.parse(readFileSync(FIRST_JSON, "utf8"));
  const budget = resolveRowTimeout(first, { flagMs: ROW_TIMEOUT_FLAG, where: "determinism.mjs" });
  if (budget.refusal) {
    process.stderr.write(`\n✗ ${budget.refusal}\n`);
    process.exit(1);
  }
  if (budget.notice) process.stdout.write(`${budget.notice}\n`);
  const REUSE = ARGV.includes("--reuse");
  // WHAT THE SECOND OBSERVATION DID, kept rather than exited on. `null` is a
  // recorder that ran and succeeded; anything else is the failure, and every
  // line below reads it - what may be compared, what each uncompared row's
  // `reason` says, and the exit code this process leaves with.
  let failure = null;
  // A VERDICT THAT CAME WITH ITS RECORDING IS KEPT (item 6).
  //
  // record.mjs carries a row's verdict for as long as it serves that same
  // recording (writeDoc, `__recording`) and drops it the moment the row is
  // recorded again, so a row that arrives here stamped `compared: true` was
  // judged against a second observation of exactly this first one, under the
  // same key. Observing it again would compare the same first observation with
  // another second one, which is what took qode-ptp-ms 50 minutes a walk
  // (26 September 2026) for rows no input, code or tool had touched. So only
  // the rows with no verdict - new, re-recorded, or never compared - are
  // observed a second time. `--all`, or CHARPILOT_INCREMENTAL_RECORD=off,
  // observes every row as before.
  const kept = new Map(
    INCREMENTAL_RECORD && !ARGV.includes("--all")
      ? (first.rows ?? []).filter((r) => r?.id && r.determinism?.compared === true).map((r) => [r.id, r.determinism])
      : []
  );
  const toObserve = (first.rows ?? []).filter((r) => !kept.has(r.id)).map((r) => r.id);
  if (kept.size) {
    process.stdout.write(`· ${kept.size} row(s) keep the verdict stamped on their own recording; ${toObserve.length} are observed a second time\n`);
  }
  if (!REUSE && !toObserve.length) {
    process.stdout.write(`· nothing to observe a second time - every row carries the verdict of the recording it holds\n`);
  } else if (!REUSE) {
    failure = recordSecond(budget.ms, INCREMENTAL_RECORD ? toObserve : null, (first.rows ?? []).length);
    // PRINTED HERE, BEFORE ANYTHING IS WRITTEN, and in the recorder's own words.
    // The operator reads the reason for the refusal first and the list of what
    // was stamped in spite of it second; the reverse order reads as a run that
    // succeeded and then changed its mind.
    if (failure) process.stderr.write(failure.text);
  } else if (!existsSync(SECOND)) {
    // `--reuse` is the one way a second observation may come from a file this
    // process did not write, so it is also the one place where a MISSING file
    // has to be named rather than thrown as an ENOENT out of readFileSync.
    process.stderr.write(
      `\n✗ determinism: --reuse, but ${relative(SELF_REPO_ROOT, SECOND) || SECOND} does not exist.\n` +
        `  There is no second observation to reuse. Drop --reuse to record one.\n`
    );
    process.exit(1);
  }

  // HOW THIS OBSERVATION WAS COME BY, carried onto every verdict below. Three
  // values, not two: a recording that RAN AND SUCCEEDED, one reused from disk,
  // and one that FAILED - which used to be unrepresentable here because
  // recordSecond() exited rather than returned. A reader of a row, or of
  // `determinism.json`, can now tell "this row was missing from a good
  // recording" from "no good recording exists", which is the whole difference
  // the exit code carries.
  const SOURCE = failure
    ? `failed (record.mjs ${failure.how})`
    : REUSE
      ? `reused (--reuse, this process did not record it)`
      : !toObserve.length
        ? `not needed (every row kept the verdict of its own recording)`
        : `recorded (record.mjs exited 0)`;
  // WHAT THE FAILED RECORDER LEFT, IF ANYTHING. record.mjs writes a partial
  // artifact before its `failedChunks` STOP (record.mjs:2188), and those rows
  // were really observed - so they are read and compared. An unreadable or
  // absent one is not an error here: it means the failure reached every row, and
  // each of them is stamped below with the reason instead. Never a stale file -
  // recordSecond unlinks SECOND before the spawn, so anything here is this run's.
  const second = (() => {
    if (!REUSE && !toObserve.length) return { rows: [] };
    if (!failure) return JSON.parse(readFileSync(SECOND, "utf8"));
    try {
      return JSON.parse(readFileSync(SECOND, "utf8"));
    } catch {
      return { rows: [] };
    }
  })();
  const byId = new Map((second.rows ?? []).map((r) => [r.id, r]));

  const rows = [];
  // A row absent from the second observation is NOT a stable row - it is an
  // unchecked one, and `continue` used to drop it silently while
  // `rowsCompared` went on counting it. That is how "218 compared" came to
  // describe 218 rows that EXISTED rather than 218 that were compared.
  const notCompared = [];
  // Rows a STOPPED recorder never reached: no verdict at all, see stoppedFromOutside.
  const notReached = [];
  const verdict = new Map();
  for (const a of first.rows ?? []) {
    const v = kept.get(a.id);
    if (v) {
      // Kept as stamped, unstable paths and all: emit reads them from this
      // document's `rows`, so a kept unstable row is listed like a new one.
      verdict.set(a.id, v);
      if (v.stable === false) rows.push({ id: a.id, file: a.file, unstablePaths: v.unstablePaths ?? [], kept: true });
      continue;
    }
    const b = byId.get(a.id);
    if (!b && failure?.stopped) {
      notReached.push(a.id);
      continue;
    }
    if (!b) {
      notCompared.push(a.id);
      verdict.set(a.id, {
        compared: false,
        // WHAT HAPPENED TO THIS ROW, in the two cases that can reach here. A
        // row missing from a recording that RAN is absent; a row missing
        // because the recording did not finish is a row the second observation
        // never reached, and the reason says which recorder failure it was.
        // Both are `compared: false` because both are uncompared - the
        // vocabulary record.mjs:1949 reads does not change - and the sentence
        // beside it is what stops the two being read as one fact.
        reason: failure
          ? `the second observation never reached this row - record.mjs ${failure.how}`
          : "absent from the second observation",
        // WHICH KIND OF NOT-COMPARED THIS IS. `compared:false` on its own cannot
        // say whether the second observation was any good, and record.mjs:1949
        // does not ask - it accepts any verdict and pins the value. Since a
        // failed recorder now reaches this loop too, this field is the thing
        // that separates the two: `recorded (record.mjs exited 0)` beside an
        // absent row is a fact about that row, `failed (...)` is a fact about
        // the whole run. It is recorded on the row, where a reader and the step
        // above find it without re-deriving it from a tool's stdout.
        //
        // ADDED BESIDE `compared`, never in place of it: `emit` reads the
        // verdict, and redefining that vocabulary from under record.mjs would
        // break the contract silently instead of loudly.
        secondObservation: SOURCE,
      });
      continue;
    }
    const la = leaves({ returned: a.returned, threw: a.threw });
    const lb = leaves({ returned: b.returned, threw: b.threw });
    const differing = [];
    for (const k of new Set([...la.keys(), ...lb.keys()])) {
      if (JSON.stringify(la.get(k)) !== JSON.stringify(lb.get(k))) differing.push(k);
    }
    if (differing.length) {
      const unstablePaths = collapse(differing);
      rows.push({ id: a.id, file: a.file, unstablePaths, rawDifferingLeaves: differing.length });
      verdict.set(a.id, { compared: true, stable: false, unstablePaths });
    } else {
      verdict.set(a.id, { compared: true, stable: true, unstablePaths: [] });
    }
  }

  const doc = {
    stage: "5-determinism",
    ...modeStamp(),
    checkedAt: new Date().toISOString(),
    envProvenance: first.envProvenance ?? null,
    // The budget BOTH observations ran under, and where it came from. An
    // unstable verdict is only readable beside it: the same rows report 1
    // unstable at 10000ms and 0 at 30000ms, and this document used to say
    // neither number.
    rowTimeoutMs: budget.ms,
    rowTimeoutMsSource: budget.source,
    // WHERE THE SECOND OBSERVATION CAME FROM, and `rowsNotCompared` is only
    // readable beside it: "12 not compared" against a recording that ran is a
    // fact about 12 rows, and against one that failed is a fact about the
    // recorder. This document used to exist only in the first case, which made
    // the distinction unrepresentable rather than unnecessary - the run that
    // failed wrote nothing at all and the step above had to infer it from an
    // absence. Both are written now, and this line is what tells them apart.
    secondObservation: SOURCE,
    secondObservationRows: (second.rows ?? []).length,
    totals: {
      rowsInFirst: (first.rows ?? []).length,
      rowsCompared: (first.rows ?? []).length - notCompared.length - notReached.length,
      rowsUnstable: rows.length,
      rowsNotCompared: notCompared.length,
      // Of rowsCompared: the verdicts carried with their recording, not observed again.
      ...(kept.size ? { rowsKept: kept.size } : {}),
      // Only when the recorder was stopped from outside; left unstamped.
      ...(notReached.length ? { rowsNotReached: notReached.length } : {}),
    },
    notCompared,
    ...(notReached.length ? { notReached } : {}),
    rows,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);

  // Write the verdict ONTO the row. A verdict in a side file can be skipped,
  // can go stale against the recording it judges, and can only ever cover a
  // subset - all three of which happened. On the row, an absent field is
  // itself the signal that the row was never checked, so the 147 unchecked
  // rows stop being invisible. `--write` because a read-only run must stay
  // read-only.
  if (ARGV.includes("--write")) {
    let stamped = 0;
    for (const r of first.rows ?? []) {
      const v = verdict.get(r.id);
      if (!v) continue;
      // A kept verdict is already on the row, with its own date: it was
      // checked when it was checked.
      if (kept.has(r.id)) continue;
      r.determinism = { ...v, checkedAt: doc.checkedAt };
      stamped += 1;
    }
    first.determinismCheckedAt = doc.checkedAt;
    writeFileSync(FIRST_JSON, `${JSON.stringify(first, null, 2)}\n`);
    process.stdout.write(`\n· stamped ${stamped} row(s) with a determinism verdict in ${relative(SELF_REPO_ROOT, FIRST_JSON)}\n`);
  } else {
    process.stdout.write(`\n· pass --write to stamp the verdict onto each behaviour.json row (a side file can be skipped, can go stale, and covers only a subset)\n`);
  }
  process.stdout.write(
    `\n${failure ? "✗ determinism REFUSED, and wrote down what it knows" : "✓ determinism checked"} → ${relative(SELF_REPO_ROOT, OUTPUT)}\n` +
      `    second obs       ${SOURCE}, ${doc.secondObservationRows} row(s)\n` +
      `    rows in first    ${doc.totals.rowsInFirst}\n` +
      `    actually compared${String(doc.totals.rowsCompared).padStart(5)}\n` +
      `    NOT compared     ${doc.totals.rowsNotCompared}  ${
        doc.totals.rowsNotCompared
          ? failure
            ? "← the second observation never reached them. UNCHECKED, not stable"
            : "← absent from the second observation. UNCHECKED, not stable"
          : ""
      }\n` +
      `    NOT stable       ${rows.length}  ${rows.length ? "← these carry per-run identity; stage 5 excludes those paths" : ""}\n` +
      (notReached.length
        ? `    NOT reached      ${notReached.length}  ← the recorder was stopped from outside; left UNSTAMPED, so the next walk observes them\n`
        : "") +
      // Beside the verdict, not in the file only. "1 of 16 unstable" is a
      // different finding at 10000ms than at 30000ms, and a reader who cannot
      // see the budget cannot tell an unstable value from a slow one.
      `    row budget       ${doc.rowTimeoutMs}ms  (${doc.rowTimeoutMsSource}) - both observations\n`
  );
  for (const r of rows.slice(0, 10)) {
    process.stdout.write(`      ${r.id}\n        unstable: ${r.unstablePaths.join(", ")}\n`);
  }

  // THE EXIT CODE IS STILL THE REFUSAL'S. Everything above is what this run
  // knows written down; none of it says the second observation was any good. The
  // walk reads this status (steps/determinism.mjs `runTool`) and stops the round
  // here with the recorder's own words - which is the half of the old behaviour
  // that was right, and the only half that was.
  if (failure) process.exit(1);
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}