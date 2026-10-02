/**
 * Run the generated suite immediately after generating it, and quarantine any
 * test that fails.
 *
 * A characterization test cannot legitimately fail the moment it is written:
 * nothing has changed between the recording and the first run. So a failure
 * here is never a regression - it is a defective PAIR, and the two causes seen
 * so far are both about isolation:
 *
 *   order dependence   the observation relied on state left by an earlier row
 *                      in the same recording chunk. `loggerV2-getInstance-
 *                      returns-existing-singleton` recorded a full winston
 *                      logger because a chunk-mate had already constructed the
 *                      singleton; run alone it gets "entry did not resolve to a
 *                      function". The recorder ran 12 rows per file, the test
 *                      runs one.
 *   hidden instability a value that differs run to run and that determinism.mjs
 *                      did not catch, because two runs happened to agree.
 *
 * Quarantine is `it.skip` with the reason written in the file, never deletion:
 * the pair is real and the input is worth repairing. Deleting it would remove
 * the arm from the work list and the gap would stop being visible.
 *
 * This only ever runs at generation time. A failure LATER means production
 * behaviour changed, which is the whole point of the suite, and must never be
 * quarantined automatically.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { CORPUS_REL, OUT_DIR, REPO_ROOT } from "./config.mjs";
// D54: the emitted suite runs under the Node the repo's CI runs (cinode.mjs).
import { targetNode, targetNodeEnv } from "./cinode.mjs";
import { readRecorded } from "./recordedstore.mjs";

const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const TESTS_DIR = arg("--tests") ?? CORPUS_REL;
const ENV_FILE = arg("--env-file") ?? join(TESTS_DIR, "recorded.env");
const QUARANTINE = join(OUT_DIR, "quarantine.json");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

// WHERE THE GENERATED SUITE IS, rather than a project name nothing declares.
//
// This ran `--project characterization`. No vitest projects config exists in
// this repo, at any revision, so the flag matched nothing and vitest ran zero
// tests - and then wrote a result file saying zero tests failed, which this
// read as a pass. A verification that verified nothing, reporting success.
//
// Measured across three runs: verify-generated was reached 0 times on the
// baseline, 0 times on the merged live run, and 10 times on the tree 2 run -
// and only there because that run's agent hand-repaired the flag mid-flight.
// So 94.3%, 96.7% and 79.0% were each measured with verification in a different
// state, and were never three readings of one instrument.
const SPECS = process.env.CHARPILOT_SPECS ?? CORPUS_REL;

/**
 * WHAT A FAILURE IS ABOUT, recorded, because `quarantine.json` is the only
 * evidence a later reader gets.
 *
 * This wrote one of two sentences: "entry did not resolve to a function", and
 * "the recorded value did not reproduce on an isolated run" for EVERYTHING
 * else. The second is a claim about the recorded VALUE, and it is false for
 * every failure that never got as far as comparing one:
 *
 *   egress-guard   the row's own default-deny guard fired. That guard is
 *                  installed into node's `http`/`https` for the WHOLE PROCESS
 *                  (record.mjs:3549, "applied once for the whole process")
 *                  while the bookkeeping that reads it back - `EGRESS`,
 *                  `FLOATING` (record.mjs:3538, record.mjs:5351) - is
 *                  module-local. Work that OUTLIVES the row that started it, a
 *                  retry timer or a fire-and-forget post, therefore trips
 *                  whichever guard is armed when it lands, not the one its own
 *                  row armed. That is a property of the arrangement, not of the
 *                  pair.
 *   row-timeout    the row did not settle inside its own budget
 *                  (record.mjs:3523).
 *   test-timeout   the test did not finish inside the HOST config's
 *                  testTimeout, which this run inherits - no --config is passed
 *                  below, deliberately, because the suite has to be verifiable
 *                  by the repo's own `vitest run`.
 *   arrangement    a module or entry did not resolve, so the subject was never
 *                  entered.
 *
 * None of those four is a statement that a recorded value changed, and three of
 * them are load- and timing-dependent. A verifier that files them under "the
 * value did not reproduce" erases the only evidence that could ever explain a
 * flaky round - which is exactly what happened: three separate investigations
 * of this suite's flakiness had nothing to read but that sentence.
 *
 * NOTHING HERE RE-RUNS ANYTHING. A retry would convert a flaky verifier into a
 * silent one and a genuinely defective pair would then ship. The row is still
 * quarantined, with its reason; what changes is that the reason is true, and
 * that a round holding one of these exits 3 instead of reporting a clean
 * verification.
 */
export const VALUE_KIND = "value";

/** The kinds that are NOT a claim about the recorded value. */
export const UNATTRIBUTABLE_KINDS = ["arrangement", "egress-guard", "row-timeout", "test-timeout"];

const MATCHERS = [
  {
    kind: "arrangement",
    // "invoke.build evaluated to ..." is the same failure for a built subject.
    test: (m) => m.includes("entry did not resolve to a function") || /invoke\.build evaluated to \S+, not the subject function/.test(m),
    why: "the observation is not reproducible in isolation - it relied on state left by an earlier row in its recording chunk",
  },
  {
    kind: "arrangement",
    test: (m) => /Cannot find module|Failed to resolve import|Failed to load url/.test(m),
    why: "the arrangement never ran - a module the row imports did not resolve, so no value was compared",
  },
  {
    kind: "egress-guard",
    test: (m) => m.includes("CharpilotEgressBlocked") || m.includes("blocked by the recorder"),
    why:
      "the recorder's process-wide egress guard fired during this test - that guard is armed for the whole " +
      "process while its bookkeeping is per-file, so this may be work started by ANOTHER row landing here",
  },
  {
    kind: "row-timeout",
    test: (m) => m.includes("CharpilotRowTimeout") || /row did not settle( in \d+ms|: its arrangement)/.test(m),
    why: "the row did not settle inside its own budget - a timing outcome, not a changed value",
  },
  {
    kind: "test-timeout",
    test: (m) => /Test timed out in \d+ms/.test(m),
    why: "vitest's own testTimeout expired before the row finished - a timing outcome, not a changed value",
  },
];

/** The kind and the sentence for one failed assertion's messages. */
export function classifyFailure(failureMessages = []) {
  const m = (failureMessages ?? []).join(" ");
  for (const c of MATCHERS) {
    if (c.test(m)) return { kind: c.kind, why: c.why };
  }
  return { kind: VALUE_KIND, why: "the recorded value did not reproduce on an isolated run" };
}

/** Rows whose failure says nothing about the pair, in the order they failed. */
export function unattributable(rows = []) {
  return rows.filter((r) => !r.carriedForward && UNATTRIBUTABLE_KINDS.includes(r.kind));
}

/**
 * The argv this drives vitest with. Exported so the arrangement is a value a
 * test can read rather than a string buried in a spawn call, and stamped into
 * `quarantine.json` so a reader knows WHICH arrangement produced the verdict.
 *
 * No `--config`. The generated suite is committed to the target repo and has to
 * pass the repo's own `vitest run`; verifying it under a config only charpilot
 * knows would verify a suite CI never runs. The cost is that `testTimeout`,
 * `setupFiles`, `pool` and `isolate` are all the host's, and they are therefore
 * reported rather than assumed.
 */
export function vitestArgv(outputFile = "") {
  return [VITEST_BIN, "run", SPECS, "--reporter=json", "--outputFile", outputFile];
}

function runSuite() {
  const json = join(OUT_DIR, ".verify-result.json");
  const dir = join(REPO_ROOT, SPECS);
  if (!existsSync(dir)) {
    return { missing: `${SPECS} does not exist - stage 5 has emitted no suite to verify` };
  }
  // DELETED FIRST, so "the file is there" cannot mean "the file is LAST round's".
  //
  // `spawnSync`'s status was discarded and this file was never removed, so a
  // vitest that died - killed by the 20-minute timeout, an OOM, a crashed
  // worker - left the previous round's report on disk and `existsSync` read it
  // as this round's. In the emit/verify loop that is round N+1 answering with
  // round N's result and the loop then calling itself settled. A round with no
  // fresh report of its own is a refusal, never an answer.
  rmSync(json, { force: true });
  const r = spawnSync(targetNode({ root: REPO_ROOT }).node, vitestArgv(json), {
    env: targetNodeEnv(process.env, targetNode({ root: REPO_ROOT })),
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20 * 60_000,
  });
  if (!existsSync(json)) {
    return {
      missing:
        `vitest wrote no result file for this run (exit ${r.status}${r.signal ? `, signal ${r.signal}` : ""}` +
        `${r.error ? `, ${r.error.message}` : ""}) - the round produced no verdict, and the previous round's is not one`,
    };
  }
  const doc = JSON.parse(readFileSync(json, "utf8"));
  // ZERO TESTS IS NOT ZERO FAILURES. The whole defect above, closed: a run that
  // matched no spec produced an empty report and this called it clean.
  const ran = (doc.testResults ?? []).reduce((n, f) => n + (f.assertionResults ?? []).length, 0);
  if (!ran) {
    return { missing: `vitest ran 0 tests under ${SPECS} - nothing was verified, so nothing can be reported as verified` };
  }
  return doc;
}

/**
 * EVERY EMITTED TEST MUST HAVE RUN, and a partial run is refused rather than
 * reported.
 *
 * `ran > 0` was the only completeness check, and it is satisfied by nine of ten
 * files. A file that fails to COLLECT - a parse error, a worker that died
 * during transform - contributes ZERO assertionResults, so its rows are neither
 * passed nor failed: they are invisible. This then printed "tests 124,
 * quarantined 0" for a suite of 136 and called it verified, and the twelve rows
 * in the missing file were silently unverified. Worse, the ratchet below reads
 * "did not pass" as "still broken", so a prior entry for one of those rows is
 * carried forward on no evidence at all.
 *
 * `emitted.json` is what says how many tests stage 5 wrote (record.mjs:2177,
 * `tests` counts the `it`s and EXCLUDES the `it.skip`s a quarantine produces),
 * so the comparison is against executed tests, skips excluded on both sides.
 */
export function completeness(manifest, { executed, skipped }) {
  if (!manifest || typeof manifest.tests !== "number") {
    return { checked: false, executed, skipped, expected: null, complete: null };
  }
  return { checked: true, executed, skipped, expected: manifest.tests, complete: executed === manifest.tests };
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const result = runSuite();
  if (!result) {
    process.stderr.write("\nthe generated suite produced no result file - that is a harness problem, not a quarantine decision\n");
    process.exit(1);
  }
  if (result.missing) {
    // Named separately from "no result file": one is vitest failing to write,
    // the other is vitest writing a report about nothing. Both refuse, and a
    // reader who cannot tell them apart cannot fix either.
    process.stderr.write(`\n✗ ${result.missing}\n`);
    process.exit(1);
  }

  // Which recording each row is (record.mjs observationKey), so the entry says
  // what it judged and the next emit can tell it from a re-recording (D33).
  const observations = (() => {
    try {
      // In shards or one file (D57, recordedstore.mjs).
      const doc = readRecorded(join(REPO_ROOT, TESTS_DIR));
      return new Map((doc.rows ?? []).map((r) => [r.id, r.observation ?? null]));
    } catch {
      return new Map();
    }
  })();
  const failed = [];
  for (const file of result.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status !== "failed") continue;
      // The test title is "<row id> - <kind>"; the row id is what generation keys on.
      const id = String(t.title).replace(/ - (returns|throws|returns-function)$/, "");
      const { kind, why } = classifyFailure(t.failureMessages);
      failed.push({
        id,
        file: file.name?.replace(`${REPO_ROOT}/`, "") ?? null,
        kind,
        why,
        message: (t.failureMessages ?? [])[0]?.slice(0, 300) ?? null,
        observation: observations.get(id) ?? null,
      });
    }
  }

  // A row already quarantined is emitted as `it.skip`, so it does not run, so
  // it cannot fail - and writing only this run's failures ERASED it. The next
  // generate then un-skipped it and the suite broke again. Quarantine has to
  // ratchet: a prior entry survives unless the row actually RAN and PASSED.
  const passed = new Set();
  const skipped = new Set();
  let executed = 0;
  let skippedCount = 0;
  for (const file of result.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const id = String(t.title).replace(/ - (returns|throws|returns-function)$/, "");
      if (t.status === "passed") passed.add(id);
      else if (t.status !== "failed") skipped.add(id || String(t.title));
      if (t.status === "passed" || t.status === "failed") executed += 1;
      else skippedCount += 1;
    }
  }

  const manifest = (() => {
    const p = join(REPO_ROOT, TESTS_DIR, "emitted.json");
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  })();
  const complete = completeness(manifest, { executed, skipped: skippedCount });
  if (complete.checked && !complete.complete) {
    process.stderr.write(
      `\n✗ a PARTIAL run is not a verification.\n` +
        `    emitted.json says stage 5 wrote ${complete.expected} runnable test(s); vitest executed ${complete.executed}` +
        `${complete.skipped ? ` (and skipped ${complete.skipped})` : ""}.\n` +
        `    The difference is rows that were neither passed nor failed, so they were not verified and\n` +
        `    cannot be quarantined either - and the ratchet below would read "did not pass" as "still\n` +
        `    broken" and carry a prior entry for them forward on no evidence. Re-emit and re-run.\n`
    );
    process.exit(1);
  }
  const prior = existsSync(QUARANTINE) ? (JSON.parse(readFileSync(QUARANTINE, "utf8")).rows ?? []) : [];
  const stillFailingIds = new Set(failed.map((f) => f.id));
  for (const old of prior) {
    if (stillFailingIds.has(old.id)) continue;
    if (passed.has(old.id)) continue; // repaired - release it
    failed.push({ ...old, carriedForward: true });
  }

  const total = (result.testResults ?? []).reduce((n, f) => n + (f.assertionResults?.length ?? 0), 0);
  const loud = unattributable(failed);
  writeFileSync(
    QUARANTINE,
    `${JSON.stringify(
      {
        stage: "5-verify",
        verifiedAt: new Date().toISOString(),
        envFile: ENV_FILE,
        // WHICH ARRANGEMENT produced this verdict. No --config is passed, so
        // pool, isolate, setupFiles and testTimeout are the host repo's, and
        // three of the four failure kinds above depend on them. A quarantine
        // that does not say how it was produced cannot be argued with.
        ran: { argv: vitestArgv("").slice(1), config: "the host repo's own vitest config - verify passes no --config" },
        completeness: complete,
        totals: {
          tests: total,
          quarantined: failed.length,
          unattributable: loud.length,
        },
        rows: failed,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(
    `\n✓ generated suite verified → ${relative(REPO_ROOT, QUARANTINE)}\n` +
      `    tests            ${total}\n` +
      `    quarantined      ${failed.length}  ${failed.length ? "← defective PAIRS, not regressions; regenerate to apply" : ""}\n`
  );
  for (const f of failed) {
    process.stdout.write(
      `      ${f.id}  [${f.kind ?? "carried-forward"}]${f.carriedForward ? "  (carried forward - skipped this run, so not re-proven)" : ""}\n        ${f.why}\n`
    );
  }

  // LOUD, and not a retry.
  //
  // The brief for this file is that a verifier which quarantines a good test at
  // random both corrupts the instrument and, in a live run, permanently deletes
  // coverage the agent earned. The cure for that is NOT to run the test again
  // and believe the second answer - that would let a genuinely defective pair
  // through, which is the one thing this stage exists to stop. So the row stays
  // quarantined and the round says, in the exit code, that its verdict rests on
  // something other than a comparison of recorded values.
  if (loud.length) {
    process.stderr.write(
      `\n✗ ${loud.length} of ${failed.length} quarantined row(s) failed for a reason that says NOTHING about the pair.\n` +
        `  These are the signature of a flaky verify round, not of a defective observation:\n` +
        loud.map((f) => `      ${f.id}  [${f.kind}]\n        ${f.message ?? f.why}\n`).join("") +
        `  They are quarantined anyway - nothing here re-runs a test or believes a second answer - but\n` +
        `  the round is NOT a clean verification. Look at the arrangement before the input:\n` +
        `    · the egress guard and the row budget are installed process-wide by record.mjs's ROW_RUNTIME\n` +
        `      (record.mjs:3549, record.mjs:3523) while EGRESS/FLOATING are per-file, so work that outlives\n` +
        `      its own row lands on whichever row is running when it settles;\n` +
        `    · pool, isolate, setupFiles and testTimeout come from the host repo's vitest config, stamped\n` +
        `      in ${relative(REPO_ROOT, QUARANTINE)} under "ran".\n`
    );
    process.exit(3);
  }
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