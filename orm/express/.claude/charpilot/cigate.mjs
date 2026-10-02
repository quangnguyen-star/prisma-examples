#!/usr/bin/env node
/**
 * THE REPO'S OWN CI, RUN OVER THE EMITTED SUITE BEFORE IT IS DELIVERED.
 *
 *   node .claude/charpilot/cigate.mjs [--tests test/characterization] [--no-typecheck]
 *
 * WHY. Seven characterization pull requests went red on their repo's own gate,
 * and every cause was the pipeline's: company-enrich #30 (17 of 431 in
 * `npm test`), cv-parsing-ms #67 (6 of 254), pricing-ms #20, location-ms #57,
 * outreach-thread-ms #143 and assessment-service #89 (`tsc --noEmit` over the
 * corpus). Each class is fixed in the tool; this is the LAST RESORT for the one
 * nobody has found yet, so that a run can never again deliver a suite that is
 * red in the repo it is delivered to.
 *
 * WHAT IT RUNS, and why these two:
 *   tests       the repo's own vitest over the corpus, with NO --config - so the
 *               repo's root config, setup files, clearMocks and default
 *               testTimeout, which is what `npm test` applies to these files.
 *               When that config collects none of them, `npm test` never runs
 *               the corpus, and the corpus's own config - what its CI check
 *               runs - is gated instead, and said (`gateConfig`).
 *   type-check  the repo's `typecheck` / `type-check` script when it declares
 *               one, which is what failed outreach and assessment. Skipped, and
 *               said, when there is none.
 *
 * WHAT IT DOES WITH A FAILURE. Nothing is deleted and nothing is refused (the
 * user's rule 1: this must not refuse the run). A failing test's row is
 * written to out/quarantine.json with the error, so the next emit renders it
 * as `it.skip` with that reason in the file - visible, not red, not gone - and
 * its sides are written to out/cigate.json for the emit step to hand the walk
 * as a pipeline_defect. report.mjs then rules those sides pipeline_defect, the
 * run is `failed` with its numbers, and finish.py names every one in the pull
 * request body. A spec that does not load at all (a parse error, a type error
 * in the file) withholds every row in it, for the same reason.
 *
 * NOTHING HERE IS RETRIED. A flaky test withheld is visible; a flaky test
 * retried until green ships the flake. The one exception is a spec that never
 * ran a row (D90, `retryLoadTimeouts`): vitest's module fetch timed out on it,
 * which says nothing about any row, so that file is run again alone and its
 * rows are judged on that run.
 *
 * Exit 0 with a report on every outcome it can describe; exit 1 only when it
 * could not run the repo's tests at all, which is a harness problem.
 */
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { CONFIG_DIR, CORPUS_REL, CORPUS_SUFFIX, OUT_DIR, REPO_ROOT } from "./config.mjs";
import { specsOfKey } from "./specsplit.mjs";
import { MEASURE_HEAP_ENV, measureHeapOn, measureHeapPlan, targetHeapLimitMB } from "./measureheap.mjs";
import {
  BANK_WALK_ENV,
  INCREMENTAL_ENV,
  contextDigest,
  diskHashes,
  fullEvery,
  incrementalOn,
  manifestHashes,
  nextLedger,
  planIncremental,
  readDirty,
  specDiff,
} from "./incremental.mjs";
import { readRecorded } from "./recordedstore.mjs";
import { classifyFailure } from "./verify-generated.mjs";
import {
  LOAD_TIMEOUT_RETRY_ENV,
  classifyUnhandled,
  failedToLoad,
  loadTimeoutRetryOn,
  loadTimeoutWithhold,
  loadTimeoutsIn,
  readUnhandled,
  rowIdOf,
  sizeOf,
  unhandledLine,
  unhandledThatCounts,
  withUnhandledReporter,
} from "./vitestred.mjs";
import { targetNode, targetNodeEnv, targetNodeLine } from "./cinode.mjs";
import { rootLeaks } from "./rootfree.mjs";
import { suiteTimeoutMs } from "./suitelimit.mjs";

const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const TESTS = arg("--tests") ?? "test/characterization";
const QUARANTINE = join(OUT_DIR, "quarantine.json");
const REPORT = join(OUT_DIR, "cigate.json");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const RECHECK_CONFIG = join(CONFIG_DIR, "vitest.recheck.config.mts");
/**
 * D54: THE NODE THE REPO'S CI RUNS THE SUITE UNDER, which this gate runs it
 * under too (cinode.mjs). It ran under `process.execPath` - the image's Node
 * 24 - and so passed two interview-service rows and four ai-centralization
 * rows whose recorded values were Node 24's own words, red on the repo's
 * Node 20 the moment the pull request opened.
 */
const TARGET_NODE = targetNode({ root: REPO_ROOT });

/**
 * D55: EVERY PLACE AN EMITTED SPEC STILL NAMES THIS CHECKOUT'S ABSOLUTE ROOT.
 *
 * This gate runs where the recording ran, so a spec that reads
 * `/work/repo/package.json` passes here and nowhere else: cv-parsing-ms PR #68
 * was green in cigate and red in its CI on
 *   Parse CV failed "ENOENT: no such file or directory, open '/work/repo/test/fixtures/doubles.ts'"
 * The emitter now rewrites the root out (rootfree.mjs), so anything found here
 * is what the rewrite could not reach, or a spec another toolset drew. Read off
 * the files, not run: no run in this container can see it.
 *
 * A leak inside a row's block withholds that row (`repo-root`); one in the
 * file's shared runtime is every row's, so it is a pipeline_defect naming the
 * file - never a silent green.
 */
export function rootLeakFindings(specs, root = REPO_ROOT, read = (f) => readFileSync(f, "utf8")) {
  const failures = [];
  const defects = [];
  for (const rel of specs) {
    let text = "";
    try { text = read(join(root, rel)); } catch { continue; }
    const leaks = rootLeaks(text, root);
    const seen = new Set();
    for (const l of leaks) {
      const message = oneLine(`${rel}:${l.line} names this checkout's absolute root ${root} (${l.snippet}) - the service's CI checks the repo out elsewhere, so this test reads a path that does not exist there`, 400);
      if (l.row) {
        if (!seen.has(l.row)) failures.push({ id: l.row, file: rel, kind: "repo-root", gate: "root-scan", message });
        seen.add(l.row);
      } else {
        defects.push({ kind: "repo-root", file: rel, message });
      }
    }
  }
  return { failures, defects };
}

/** The emitted spec files under TESTS, repo-relative. */
function corpusSpecs() {
  try {
    return readdirSync(join(REPO_ROOT, TESTS)).filter((f) => f.endsWith(".test.ts") || f.endsWith(".char.ts")).map((f) => join(TESTS, f));
  } catch {
    return [];
  }
}

/** One line, bounded - it lands in a `//` comment and in a PR body. */
export const oneLine = (s, n = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** `<id> - returns` -> `<id>`, the inverse of the emitter's title (vitestred.mjs). */
export { rowIdOf };

/** Every row id a rendered spec asserts, from the emitter's own `// [recorded: <id>]` markers. */
export function rowsInSpec(text) {
  return [...String(text).matchAll(/^ {2}\/\/ \[recorded: (\S+)\]/gm)].map((m) => m[1]);
}

/**
 * A prior entry about a recording the corpus no longer holds (D33): the row
 * is in recorded.json under a different observation than the one the entry
 * judged. A recorded.json that names no observation (an emit older than the
 * key) says nothing either way, so the entry stands.
 *
 * Or about a TEST the corpus no longer holds: `emitter` is the renderer that
 * drew the suite this run judged (recorded.json `emitter`, config.mjs
 * `emitterDigest`), and an entry for a rendered row that names another one
 * judged an older template's test. Without this a row that turned green
 * under a repaired template kept its entry, and every later emit skipped it.
 */
export function supersededEntry(entry, recorded, emitter = null) {
  if (!recorded.has(entry?.id)) return false;
  const now = recorded.get(entry.id)?.observation ?? null;
  if (now !== null && entry?.observation !== now) return true;
  return emitter !== null && entry?.emitter !== emitter;
}

/** The `armId [side]` keys a row claims, which is how report.mjs names a side. */
export function sidesOf(row) {
  const out = [];
  for (const [arm, sides] of Object.entries(row?.reaches ?? {})) {
    for (const s of Array.isArray(sides) ? sides : [sides]) out.push(`${arm} [${s}]`);
  }
  if (!out.length) for (const arm of row?.covers ?? []) out.push(`${arm} [*]`);
  return out;
}

/**
 * The failures in one vitest JSON report: a failed assertion names its row; a
 * file that failed with no assertions (it did not load) names every row in it.
 *
 * Except a file that did not load because vitest's module fetch timed out (D90,
 * vitestred.mjs loadTimeoutsIn): none of its rows ran, so none is named here.
 * `redOf` hands it to `retryLoadTimeouts`, which runs it again alone. Under
 * CHARPILOT_LOAD_TIMEOUT_RETRY=off it withholds every row, as before.
 */
export function failuresIn(doc, readSpec = (f) => readFileSync(f, "utf8"), env = process.env) {
  const out = [];
  const timedOut = new Set(loadTimeoutRetryOn(env) ? loadTimeoutsIn(doc, REPO_ROOT).map((t) => t.file) : []);
  for (const file of doc?.testResults ?? []) {
    const rel = file.name ? relative(REPO_ROOT, file.name) : null;
    const asserted = file.assertionResults ?? [];
    for (const t of asserted) {
      if (t.status !== "failed") continue;
      const { kind } = classifyFailure(t.failureMessages);
      out.push({ id: rowIdOf(t.title), file: rel, kind, gate: "tests", message: oneLine((t.failureMessages ?? [])[0]) });
    }
    if (failedToLoad(file) && !timedOut.has(rel)) {
      let ids = [];
      try { ids = rowsInSpec(readSpec(file.name)); } catch { ids = []; }
      for (const id of ids) out.push({ id, file: rel, kind: "load", gate: "tests", message: oneLine(`the spec did not load: ${file.message ?? "no message"}`) });
    }
  }
  return out;
}

/**
 * EVERY WAY ONE vitest RUN IS RED, not only the ones its JSON report shows.
 *
 * `failuresIn` reads failed assertions and files that did not load. An
 * UNHANDLED error is neither - vitest prints "Errors 1 error", exits 1, and
 * the JSON has every test passed (nginx-redirecting-ms, `listen EADDRINUSE`,
 * 103 passed and red). So:
 *
 *   - an unhandled error vitest ATTRIBUTES to a test (`VITEST_TEST_NAME`, the
 *     test behind "The latest test that might've caused the error is ...") is
 *     that test's failure, kind `unhandled`, withheld like any other;
 *   - one it attributes to no test is a pipeline_defect with the error text;
 *   - a non-zero exit that names no failure at all is a pipeline_defect too,
 *     carrying vitest's own exit reason (`exitReasonOf`) - except a coverage
 *     threshold, which is a `measurement`: named, and neither red nor green.
 *
 * Never a silent green: a red run always leaves a withheld row, a defect or a
 * measurement.
 * `unhandled` is null when the reporter wrote nothing (it did not load).
 *
 * An unhandled error only counts when vitest EXITED non-zero: under
 * `dangerouslyIgnoreUnhandledErrors` it still reports them and exits 0, and
 * that repo's CI is green (`unhandledThatCounts`).
 */
export function redOf({ doc, status, unhandled, output = "" }, readSpec, env = process.env) {
  const failures = failuresIn(doc, readSpec, env);
  const defects = [];
  const measurements = [];
  // D90: files whose module fetch timed out, which `failuresIn` names no row
  // for. They are red, and they are explained: not `red-without-a-failure`.
  const loadTimeouts = loadTimeoutRetryOn(env) ? loadTimeoutsIn(doc, REPO_ROOT) : [];
  const { attributed, unattributed } = classifyUnhandled(unhandledThatCounts(unhandled ?? [], status), REPO_ROOT);
  for (const u of attributed) failures.push({ id: u.id, title: u.title, file: u.file, kind: u.kind, gate: "tests", message: u.message });
  for (const u of unattributed) {
    // D75: an error vitest attributes to no test is traced by its own stack to
    // the emitted spec of the source file it was raised in, and that spec's
    // rows become suspects, each re-run alone by confirmUnhandled: the one
    // that raises it is withheld and re-dealt, the rest are left alone.
    // qode-ptp-ms 20260928T110132Z failed its whole walk on one fire-and-forget
    // rejection - `getFileStorageInstance(...).getBlobAccessLink is not a
    // function` at parse-cv/index.route.ts:54, surfacing after its test ended -
    // at 95.9% with every side otherwise ruled or covered.
    // vitest often names the spec file even when it names no test - it did
    // here - and that is better evidence than a stack frame.
    const inCorpus = u.file && u.file.startsWith(CORPUS_REL) && existsSync(join(REPO_ROOT, u.file));
    const traced = inCorpus ? { source: u.file, spec: u.file, specs: [u.file] } : (u.stack ? specOfStack(u.stack) : null);
    // N6: every part of a split spec holds some of the source file's rows.
    const ids = [];
    for (const spec of traced?.specs ?? []) {
      try {
        for (const id of rowsInSpec((readSpec ?? ((f) => readFileSync(f, "utf8")))(join(REPO_ROOT, spec)))) ids.push({ id, spec });
      } catch { /* unreadable: no suspects from it */ }
    }
    if (ids.length) {
      for (const { id, spec } of ids) {
        failures.push({ id, file: spec, kind: "unhandled-traced", gate: "tests",
          message: oneLine(`${u.message} - attributed to no test by vitest, traced by its stack to ${traced.source}, whose spec holds this row`, 600) });
      }
      continue;
    }
    defects.push({ kind: u.kind, file: u.file, message: oneLine(`${u.message} - attributed to no test by vitest: ${u.stack}`, 600) });
  }
  if (status !== 0 && !failures.length && !defects.length && !loadTimeouts.length) {
    const why = exitReasonOf({ doc, output });
    if (why.cause === "coverage-threshold") {
      measurements.push({
        kind: "coverage-threshold",
        message: oneLine(`vitest exited ${status} on the repo's coverage threshold(s) with every test passed: ${why.detail} - a measurement of the corpus run on its own, not a red test`, 800),
      });
    } else {
      defects.push({
        kind: "red-without-a-failure",
        cause: why.cause,
        message: oneLine(
          `vitest exited ${status} and named no failed test${unhandled === null ? " (the unhandled-error reporter wrote nothing)" : " and no unhandled error"} - its own exit reason: [${why.cause}] ${why.detail}`,
          800
        ),
      });
    }
  }
  // Only when there are any: a run that has none reads exactly as it did.
  return { failures, defects, measurements, ...(loadTimeouts.length ? { loadTimeouts } : {}) };
}

/**
 * D90: EVERY SPEC WHOSE MODULE FETCH TIMED OUT IS RUN AGAIN ALONE, AND ITS ROWS
 * ARE JUDGED ON THAT RUN.
 *
 * vitest 2.1.9's worker gives its module fetch a fixed 60 s, and vite's SSR
 * transform of qode-ptp-ms's 33 MB aiInterviewService spec, on a host at load
 * 10 on 8 cores, took longer (run 20260930T093551Z). Such a file ran none of
 * its rows. Withholding them (`kind: "load"`) would have taken all 1451 out of
 * the suite on a verdict about the host. So, for each such file:
 *
 *   - it is run alone, under the config the pass used, coverage off
 *     (`rerunFile`, cigate's own runVitest), and one note says so, with the
 *     file and its size - the line the walk's log carries;
 *   - it loads alone: its rows are judged on that run, exactly as a pass would
 *     judge them (`redOf`) - a green file clears them, a red row is withheld
 *     with its own error, an unhandled error goes on to `confirmUnhandled`;
 *   - it times out alone too, or the re-run could not answer: a
 *     pipeline_defect naming the file, its size and the timeout. Its rows are
 *     never withheld: the suite is not green, and says why, and no row is
 *     blamed for the host.
 *
 * `rerunFile(t)` returns a vitest run ({ doc, status, unhandled, output }) or
 * { error }. `size(file)` is the file's size as a reader weighs it.
 */
export function retryLoadTimeouts(timeouts, rerunFile, { readSpec, size = (f) => sizeOf(join(REPO_ROOT, f)), env = process.env } = {}) {
  const failures = [];
  const defects = [];
  const measurements = [];
  const notes = [];
  const rowsOf = (file) => {
    try { return rowsInSpec((readSpec ?? ((f) => readFileSync(f, "utf8")))(join(REPO_ROOT, file))).length; } catch { return 0; }
  };
  for (const t of timeouts) {
    const weight = size(t.file);
    notes.push({
      kind: "load-timeout-retry",
      file: t.file,
      size: weight,
      message: oneLine(`${t.file} (${weight}) did not load: vitest's module fetch timed out (${t.message}) - a fixed 60 s limit in vitest's worker, not its rows; run again alone (${LOAD_TIMEOUT_RETRY_ENV}=off to withhold its rows instead)`, 600),
    });
    const r = rerunFile(t);
    const again = r && !r.error ? redOf(r, readSpec, env) : null;
    const stillOut = (again?.loadTimeouts ?? []).find((x) => x.file === t.file);
    if (!again || stillOut) {
      const rows = rowsOf(t.file);
      defects.push({
        kind: "load-timeout",
        file: t.file,
        size: weight,
        message: oneLine(
          `${t.file} (${weight}) never loaded: vitest's module fetch timed out on it in the pass (${t.message}) and ` +
            (stillOut ? `again when run alone (${stillOut.message})` : `the lone re-run could not answer (${r?.error ?? "no result"})`) +
            ` - vitest's worker gives that call a fixed 60 s, so this is the module-fetch timeout on a spec this size, not the rows' behaviour; its ${rows} row(s) ran nowhere and are NOT withheld`,
          800
        ),
      });
      continue;
    }
    failures.push(...again.failures);
    defects.push(...again.defects);
    measurements.push(...again.measurements);
  }
  return { failures, defects, measurements, notes };
}

/** vitest's JSON report for a run that collected no test file at all. */
export function ranNoFile(doc) {
  return !!doc && !(doc.testResults ?? []).length && !doc.numTotalTestSuites;
}

/**
 * THE REPORT A RUN THAT COLLECTED NOTHING WOULD HAVE WRITTEN, when vitest wrote none.
 *
 * D45, qode-itl-be, the mocked run of September 26: cigate exited 1 on every
 * round with "vitest wrote no report (exit 1)", so the corpus was delivered
 * unchecked. Its root config includes `src/**\/*.test.ts` only, and vitest
 * 2.1.9 says `No test files found, exiting with code 1` on stderr and exits
 * BEFORE any reporter runs, so no JSON is written. vitest 4 and 5 write an
 * empty report in the same case, and `gateConfig` moves to the corpus's own
 * config on it. This is that empty report, built from vitest's own line, so
 * both versions reach the same fallback. Any other run with no report is still
 * a failure to run the tests. null when the output does not say so.
 */
export function noFileReport(output) {
  if (!/No test files found/.test(String(output ?? "").replace(ANSI, ""))) return null;
  return { numTotalTestSuites: 0, numTotalTests: 0, testResults: [] };
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * WHY vitest EXITED NON-ZERO, IN ITS OWN WORDS, when its JSON names no failure.
 *
 * tracy-agent-be-ms, run 20260925T080612Z (and notification-ms,
 * 20260925T072757Z, the same way): `files: 0`, exit 1, and the only line of
 * output was `JSON report written to ...` - so the gate's defect quoted that
 * and nothing else. The real reason is `No test files found, exiting with
 * code 1`: the root config's `include: ["tests/**\/*.test.ts"]` never matches
 * `test/characterization/`. Under `--reporter=json` vitest does NOT print that
 * line (its default reporter does), so it is read off the report itself - no
 * suite collected - as well as off the output.
 *
 * The other causes are the lines vitest itself prints, on stderr and under any
 * reporter (vitest 4/5 source): a worker that died, `process.exit` in a test,
 * a config that did not load, type errors, "Errors occurred". A coverage
 * threshold (`ERROR: Coverage for branches (61%) does not meet global
 * threshold (80%)`) is checked LAST, so it is the cause only when nothing
 * else is - and it is a measurement, not a crash: cigate runs the corpus
 * alone, so a threshold the repo sets for its whole suite is measured against
 * a slice of it.
 *
 * Anything else is `unnamed`, with vitest's last lines minus its own "JSON
 * report written" line - never an empty reason.
 */
export function exitReasonOf({ doc, output = "" }) {
  const text = String(output ?? "").replace(ANSI, "");
  const first = (re) => text.match(re)?.[0];
  const worker = first(/Worker exited unexpectedly[^\n]*|process\.exit unexpectedly called with[^\n]*/);
  if (worker) return { cause: "worker-exit", detail: oneLine(worker, 400) };
  const startup = first(/Startup Error[^\n]*\n(?:[^\n]*\n?){0,4}/);
  if (startup) return { cause: "startup-error", detail: oneLine(startup, 400) };
  const typeErrors = first(/TypeCheckError[^\n]*|Type Errors\s+\d+ failed[^\n]*/);
  if (typeErrors) return { cause: "type-errors", detail: oneLine(typeErrors, 400) };
  const errors = first(/Errors occurred while running tests[^\n]*/);
  if (errors) return { cause: "errors-occurred", detail: oneLine(errors, 400) };
  if (ranNoFile(doc) || /No test files found/.test(text)) {
    return { cause: "no-test-files", detail: "vitest collected no test file (\"No test files found, exiting with code 1\"): the config's `include` matches nothing under the filter" };
  }
  const thresholds = [...text.matchAll(/ERROR: ((?:Coverage for \w+ \([\d.]+%\) does not meet|Uncovered \w+ \(\d+\) exceed) [^\n]*?threshold \([\d.]+%?\)(?: for \S+)?)/g)].map((m) => m[1]);
  if (thresholds.length) return { cause: "coverage-threshold", detail: oneLine(thresholds.join("; "), 600) };
  const tail = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^JSON report written to /.test(l)).slice(-8).join(" | ");
  return { cause: "unnamed", detail: tail ? oneLine(tail, 600) : "vitest printed nothing but its JSON report, and the report holds no failure" };
}

/** How many tests an unhandled error is re-run alone for, at most, per cigate run. */
export const UNHANDLED_RECHECK_MAX = 10;
/** Re-runs for the rows of a spec an unattributed error's stack names (D75). */
export const TRACED_RECHECK_MAX = 25;

/**
 * The emitted spec of the first repo source file in `stack` that has one (D75).
 *
 * Named as emit names it: the source path less `src/` and `.ts`, slashes to
 * dashes, plus CORPUS_SUFFIX under CORPUS_REL. Frames in node_modules or in the
 * corpus itself are skipped - the rows are what drives the source, not the
 * other way round.
 */
export function specOfStack(stack, exists = existsSync, list = corpusNames) {
  const frame = /(?:file:\/\/)?((?:\/|\.{0,2}\/)?[^\s():]+\.[cm]?[tj]sx?):\d+(?::\d+)?/g;
  for (const m of String(stack).matchAll(frame)) {
    const rel = relative(REPO_ROOT, resolve(REPO_ROOT, m[1]));
    if (rel.startsWith("..") || rel.includes("node_modules") || rel.startsWith(CORPUS_REL)) continue;
    const key = rel.replace(/^src\//, "").replace(/\.ts$/, "").replace(/\//g, "-");
    const spec = join(CORPUS_REL, `${key}${CORPUS_SUFFIX}`);
    if (exists(join(REPO_ROOT, spec))) return { source: rel, spec, specs: [spec] };
    // N6: a spec written in parts (specsplit.mjs) is every part's rows.
    const parts = specsOfKey(key, list(), CORPUS_SUFFIX).map((f) => join(CORPUS_REL, f));
    if (parts.length) return { source: rel, spec: parts[0], specs: parts };
  }
  return null;
}

/** The spec file names in the corpus directory. */
function corpusNames() {
  try {
    return readdirSync(join(REPO_ROOT, CORPUS_REL));
  } catch {
    return [];
  }
}

/** `-t` for exactly one emitted test: its title, escaped, at the end of the full name. */
export function titlePattern(title) {
  return `(?:^|\\s)${String(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/**
 * `-t` for the emitted test of one row id, when no title is known (D88).
 *
 * D75's traced suspects come from the spec's `// [recorded: <id>]` markers,
 * which carry the id and not the title, and `rerunAlone` refused every one of
 * them ("vitest named no file or title for it"): qode-ptp-ms
 * 20260930T033300Z withheld all 17 rows of the parse-cv spec unconfirmed.
 * An emitted title is `<id> - <outcome>` (vitestred.mjs rowIdOf), so the id
 * and the outcomes rowIdOf strips pick out exactly that test.
 */
export function idPattern(id) {
  return `(?:^|\\s)${String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - (?:returns|throws|returns-function)$`;
}

/**
 * AN UNHANDLED ERROR IS WITHHELD ONLY FROM THE TEST THAT RAISES IT.
 *
 * vitest attributes an unhandled error to the test RUNNING when it surfaced
 * (`VITEST_TEST_NAME`), not to the one that caused it: a rejection a test
 * fires and forgets surfaces during the NEXT test (verifier probe
 * `stray.b.test.ts`: rowA schedules it, innocent rowB is named). Withholding
 * on that name alone quarantines an innocent test and costs its sides.
 *
 * So each test withheld only for an unhandled error is re-run ALONE (`-t` and
 * its file, coverage off, the same config):
 *   - still red there (it fails, or vitest exits non-zero): it raises the
 *     error itself - withheld;
 *   - green there: the error came from elsewhere - NOT quarantined, and a
 *     pipeline_defect "unhandled error, attribution unstable: <text>";
 *   - a re-run that could not answer (did not run, timed out, the test was not
 *     found): the withhold stands, and a pipeline_defect says it is unchecked.
 * At most `max` re-runs; the rest keep vitest's attribution and raise one
 * defect naming them, so the cost stays bounded and nothing is silent.
 *
 * `rerun(failure)` returns a vitest run ({ doc, status, unhandled }) or { error }.
 */
export function confirmUnhandled(failures, rerun, max = UNHANDLED_RECHECK_MAX) {
  const otherwiseRed = new Set(failures.filter((f) => f.kind !== "unhandled" && f.kind !== "unhandled-traced").map((f) => f.id));
  const suspects = [];
  const traced = [];
  const seen = new Set();
  for (const f of failures) {
    if (otherwiseRed.has(f.id) || seen.has(f.id)) continue;
    if (f.kind === "unhandled") { seen.add(f.id); suspects.push(f); }
    else if (f.kind === "unhandled-traced") { seen.add(f.id); traced.push(f); }
  }
  const innocent = new Set();
  const defects = [];
  const unchecked = [];
  // D75: rows a stack trace names are suspects, not accusations. Each is re-run
  // alone; an innocent one is simply not withheld (vitest never named it), and
  // only an error none of them reproduces is a pipeline_defect.
  let tracedGuilty = 0;
  for (const f of traced.slice(0, TRACED_RECHECK_MAX)) {
    const r = rerun(f);
    const alone = r && !r.error ? verdictAlone(r, f.id) : { verdict: "unchecked", why: r?.error ?? "no result" };
    if (alone.verdict === "innocent") innocent.add(f.id);
    else if (alone.verdict === "guilty") tracedGuilty += 1;
    else unchecked.push(`${f.id} (${alone.why})`);
  }
  if (traced.length && !tracedGuilty && !unchecked.length && traced.length <= TRACED_RECHECK_MAX) {
    defects.push({
      kind: "unhandled-untraced",
      file: traced[0].file,
      message: oneLine(`${traced[0].message} - but none of its ${traced.length} row(s) raises it when run alone`, 600),
    });
  }
  for (const f of traced.slice(TRACED_RECHECK_MAX)) unchecked.push(`${f.id} (over the ${TRACED_RECHECK_MAX} traced re-runs)`);
  for (const f of suspects.slice(0, max)) {
    const r = rerun(f);
    const alone = r && !r.error ? verdictAlone(r, f.id) : { verdict: "unchecked", why: r?.error ?? "no result" };
    if (alone.verdict === "innocent") {
      innocent.add(f.id);
      defects.push({
        kind: "unhandled-attribution-unstable",
        id: f.id,
        file: f.file,
        message: oneLine(`unhandled error, attribution unstable: ${f.message} - vitest named ${f.id}, which passes when run alone, so the error came from elsewhere and it is NOT quarantined`, 600),
      });
    } else if (alone.verdict === "unchecked") {
      unchecked.push(`${f.id} (${alone.why})`);
    }
  }
  const over = suspects.slice(max).map((f) => f.id);
  if (unchecked.length) {
    defects.push({
      kind: "unhandled-attribution-unchecked",
      message: oneLine(`${unchecked.length} test(s) withheld for an unhandled error vitest attributed to them could not be re-run alone - withheld unconfirmed: ${unchecked.join(", ")}`, 800),
    });
  }
  if (over.length) {
    defects.push({
      kind: "unhandled-attribution-unchecked",
      message: oneLine(`${over.length} more test(s) withheld for an unhandled error than the ${max} re-run alone - withheld on vitest's attribution only: ${over.join(", ")}`, 800),
    });
  }
  return { failures: failures.filter((f) => !innocent.has(f.id)), defects };
}

/** One test's re-run alone: "guilty", "innocent", or "unchecked" with why. */
export function verdictAlone(run, id) {
  const results = (run.doc?.testResults ?? []).flatMap((file) => file.assertionResults ?? []);
  const mine = results.filter((t) => rowIdOf(t.title) === id);
  if (mine.some((t) => t.status === "failed")) return { verdict: "guilty" };
  if (!mine.some((t) => t.status === "passed")) {
    // Not run at all: a file that did not load is red on its own; a filter that
    // matched nothing answers nothing. Nor does a file whose module fetch timed
    // out (D90): it ran nothing, so it cannot say the test is guilty.
    const timedOut = loadTimeoutRetryOn() ? loadTimeoutsIn(run.doc, REPO_ROOT) : [];
    if (timedOut.length) return { verdict: "unchecked", why: `its file did not load: ${timedOut[0].message}` };
    if ((run.doc?.testResults ?? []).some((file) => file.status === "failed")) return { verdict: "guilty" };
    return { verdict: "unchecked", why: `the re-run ran no test named ${id}` };
  }
  if (run.status !== 0) {
    const counted = unhandledThatCounts(run.unhandled ?? [], run.status);
    return counted.length ? { verdict: "guilty", why: unhandledLine(counted[0]) } : { verdict: "unchecked", why: `vitest exited ${run.status} with the test passed and no unhandled error` };
  }
  return { verdict: "innocent" };
}

/** The corpus files a type-check's output names, with their first error. */
export function typeErrorsIn(output, testsDir = TESTS) {
  const byFile = new Map();
  const esc = testsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const m of String(output).matchAll(new RegExp(`^(${esc}/[^(\\s]+)\\((\\d+),(\\d+)\\): error (TS\\d+: .*)$`, "gm"))) {
    if (!byFile.has(m[1])) byFile.set(m[1], `${m[4]} (line ${m[2]})`);
  }
  return byFile;
}

/** The config the corpus ships with, and the one its CI check runs (cicheck.mjs COMMAND). */
const CORPUS_CONFIG = join(REPO_ROOT, TESTS, "vitest.config.mts");

/**
 * THE CONFIG THE CORPUS IS GATED UNDER: the repo's own, unless it runs none of it.
 *
 * tracy-agent-be-ms, run 20260925T080612Z: the root config includes only
 * `tests/**\/*.test.ts`, so `vitest run test/characterization` collected no
 * file and exited 1, and the emit step failed the run on
 * `[red-without-a-failure]` over a suite nothing had run. That repo's `npm
 * test` never runs the corpus, so it cannot be red there; the CI that runs it
 * is the check cicheck.mjs writes, `npx vitest run --config
 * <corpus>/vitest.config.mts`. So that is what is gated, the report says so
 * (`corpus-not-in-repo-config`), and the run is otherwise the same. With no
 * corpus config to fall back to, the no-file run stays a defect.
 */
export function gateConfig(first, corpusConfigExists) {
  if (first.error || !ranNoFile(first.doc) || !corpusConfigExists) return { config: null, note: null };
  return {
    config: CORPUS_CONFIG,
    note: {
      kind: "corpus-not-in-repo-config",
      message: oneLine(
        `the repo's own vitest config collects no file under ${TESTS} (vitest: "No test files found"), so its \`npm test\` never runs the corpus - ` +
          `gated instead under ${relative(REPO_ROOT, CORPUS_CONFIG)}, the config the corpus ships with and its CI check runs`,
        600
      ),
    },
  };
}

/**
 * The corpus under the repo's own config, or `files` of it (a partial pass,
 * incremental.mjs). The files are vitest filters, repo-relative with the
 * corpus directory in front, so each matches its own file and no other.
 */
function runTests(config = null, files = null) {
  // D77: the limit is the corpus's, not a fixed 30 minutes (suitelimit.mjs).
  const specs = files?.length ? files.length : corpusSpecCount();
  // Item 18c: a full pass may be split into shards; a partial one never is.
  const shards = files?.length ? 1 : cigateShards(specs);
  if (shards > 1) return runVitestSharded([TESTS], shards, { tag: "result", timeout: suiteTimeoutMs(specs), config });
  return runVitest(files?.length ? files : [TESTS], { tag: "result", timeout: suiteTimeoutMs(specs), config });
}

/**
 * ITEM 18c - A FULL GATE MAY RUN AS SHARDS, EACH UNDER THE REPO'S OWN CONFIG.
 *
 * How it worked before: one vitest over the whole corpus under the repo's own
 * config. qode-ptp-ms's sets `maxWorkers: 1`, so its 408 spec files ran one at
 * a time: 27 min a pass, and a pass that withholds a row is followed by another
 * full one, so a resume's first walk spent about 80 of its ~100 minutes here
 * (run 20260929T103202Z, three passes).
 *
 * `CHARPILOT_CIGATE_SHARDS=N` runs vitest's own `--shard=k/N` as N processes at
 * once, each under the repo's config exactly (its workers, setup, isolation),
 * and merges their reports into the one this gate reads. `auto` sizes it to the
 * corpus: a shard per SPECS_PER_SHARD files, at most cores - 1 and 8, so a
 * small corpus stays one pass and a 10,000-test one is split.
 *
 * NOT on the bank walk (CHARPILOT_BANK_WALK=1), whose gate the report rests on:
 * that pass is the repo's CI exactly, one process over every file, so a file
 * red only in company (D48, D52) is still found before anything is reported. A
 * shard sees fewer neighbours, so a round's walk can miss such a file until the
 * bank walk; it can never report one green. Unset, 0 or 1 is today's gate and
 * the kill switch.
 */
export const CIGATE_SHARDS_ENV = "CHARPILOT_CIGATE_SHARDS";
export const SPECS_PER_SHARD = 100;
export function cigateShards(specs, env = process.env, cores = availableParallelism()) {
  if (String(env[BANK_WALK_ENV] ?? "") === "1") return 1;
  const raw = String(env[CIGATE_SHARDS_ENV] ?? "").trim().toLowerCase();
  const cap = Math.max(1, Math.min(8, cores - 1));
  if (raw === "auto") return Math.max(1, Math.min(cap, Math.ceil((Number(specs) || 0) / SPECS_PER_SHARD)));
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, cap) : 1;
}

/** One report from the shards' reports: counts summed, results in shard order. */
export function mergeShardReports(docs) {
  const merged = { ...docs[0], testResults: [] };
  for (const key of Object.keys(docs[0])) {
    if (typeof docs[0][key] === "number" && /^num/.test(key)) merged[key] = docs.reduce((n, d) => n + (Number(d[key]) || 0), 0);
  }
  if ("success" in docs[0]) merged.success = docs.every((d) => d.success !== false);
  if ("startTime" in docs[0]) merged.startTime = Math.min(...docs.map((d) => Number(d.startTime) || Infinity));
  for (const d of docs) merged.testResults.push(...(d.testResults ?? []));
  return merged;
}

const shq = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;

/** runVitest over `shards` shards at once: the same report, the same fields. */
function runVitestSharded(args, shards, { tag, timeout, config = null }) {
  const cfg = config ? ["--config", config] : [];
  const parts = [];
  const lines = [];
  const secs = Math.ceil(timeout / 1000);
  for (let k = 1; k <= shards; k += 1) {
    const json = join(OUT_DIR, `.cigate-${tag}-s${k}.json`);
    const errs = join(OUT_DIR, `.cigate-${tag}-s${k}-unhandled.json`);
    const log = join(OUT_DIR, `.cigate-${tag}-s${k}.log`);
    const code = join(OUT_DIR, `.cigate-${tag}-s${k}.status`);
    for (const f of [json, errs, log, code]) rmSync(f, { force: true });
    const extra = withUnhandledReporter(errs);
    const envs = Object.entries(extra.env).map(([key, v]) => `${key}=${shq(v)}`).join(" ");
    const argv = [TARGET_NODE.node, ...gateHeapArgs(args, { shards }), VITEST_BIN, "run", ...cfg, ...args, `--shard=${k}/${shards}`, "--reporter=json", ...extra.args, "--outputFile", json];
    // Each shard has the whole pass's limit: shards run at once, not in turn.
    lines.push(`( ${envs} timeout -k 30 ${secs} ${argv.map(shq).join(" ")} > ${shq(log)} 2>&1; echo $? > ${shq(code)} ) &`);
    parts.push({ json, errs, log, code });
  }
  lines.push("wait");
  spawnSync("bash", ["-c", lines.join("\n")], {
    cwd: REPO_ROOT, encoding: "utf8", timeout: timeout + 120_000, env: targetNodeEnv({ ...process.env }, TARGET_NODE),
  });
  const docs = [];
  let status = 0;
  let output = "";
  const unhandled = [];
  for (const [i, p] of parts.entries()) {
    const said = existsSync(p.log) ? readFileSync(p.log, "utf8") : "";
    output += `${said}\n`;
    const exit = existsSync(p.code) ? Number(readFileSync(p.code, "utf8").trim()) : null;
    if (exit === 124 || exit === 137) return { error: `shard ${i + 1}/${shards} timed out after ${secs}s`, timedOut: true };
    status = Math.max(status, Number.isFinite(exit) ? exit : 1);
    const doc = existsSync(p.json) ? JSON.parse(readFileSync(p.json, "utf8")) : noFileReport(said);
    if (!doc) return { error: `vitest shard ${i + 1}/${shards} wrote no report (exit ${exit})` };
    docs.push(doc);
    unhandled.push(...(readUnhandled(p.errs) ?? []));
    for (const f of [p.json, p.log, p.code]) rmSync(f, { force: true });
  }
  return {
    doc: mergeShardReports(docs),
    status,
    unhandled: unhandled.length ? unhandled : null,
    output,
    command: config
      ? `vitest run --config ${relative(REPO_ROOT, config)} ${TESTS} (the corpus's own config, ${shards} shards)`
      : `vitest run ${TESTS} (the repo's own config, ${shards} shards)`,
  };
}

/**
 * D91 FOR THE GATE: VITEST'S MAIN PROCESS GETS THE HEAP ITS CORPUS NEEDS.
 *
 * The gate's vitest keeps every loaded spec's transform for the whole pass,
 * as measure's does (measureheap.mjs), without istanbul's instrumentation on
 * top. Measured on qode-ptp-ms's corpus (475 MB, split by N6): at Node 20's
 * default for a host with no memory limit (4144 MB), the full pass's main
 * process peaked at 3979 MB of a 4192 MB limit; at the 2096 MB default of a
 * 14 GB container it died by SIGABRT at 700 s ("vitest wrote no report (exit
 * null, SIGABRT)"), and emit delivered the suite unchecked. So each pass is
 * sized as measure's is - the spec bytes it loads (a shard's share of them),
 * against the target node's own default - and one note says when it applies.
 * `CHARPILOT_MEASURE_HEAP=off` is the switch for both.
 */
let targetDefaultMB;
const heapNotes = [];
export function gateHeapArgs(args, { shards = 1, env = process.env, defaultMB = null, available = process.availableMemory(), bytesOf = specBytes } = {}) {
  if (!measureHeapOn(env)) return [];
  const limit = defaultMB ?? (targetDefaultMB ??= targetHeapLimitMB(TARGET_NODE.node, targetNodeEnv({ ...env }, TARGET_NODE)) ?? 0);
  const named = args.filter((a) => !String(a).startsWith("-") && /\.test\.[cm]?[jt]s$|\.char\.[cm]?[jt]s$/.test(String(a)));
  const bytes = bytesOf(named.length ? named : null) / Math.max(1, shards);
  const plan = measureHeapPlan({ specBytes: bytes, defaultMB: limit, available: available / Math.max(1, shards), env });
  if (!plan) return [];
  const message =
    `vitest's main process gets a ${plan.mb} MB heap${shards > 1 ? ` in each of ${shards} shards` : ""} (node's default here is ${plan.defaultMB} MB): ` +
    `it keeps the transform of every spec it loads, ${plan.specMB} MB of them, about ${plan.needMB} MB (${MEASURE_HEAP_ENV}=off keeps the default)`;
  if (!heapNotes.some((n) => n.message === message)) heapNotes.push({ kind: "gate-heap", message });
  return [`--max-old-space-size=${plan.mb}`];
}

/** The notes gateHeapArgs made since the last take. */
function takeHeapNotes() {
  return heapNotes.splice(0, heapNotes.length);
}

/** Bytes of spec in `files` (repo-relative or absolute), or in the whole corpus when null. */
function specBytes(files) {
  const list = files ?? corpusSpecFiles();
  let n = 0;
  for (const f of list) {
    try { n += statSync(resolve(REPO_ROOT, f)).size; } catch { /* gone: nothing to load */ }
  }
  return n;
}

/** Every spec file under the corpus directory. */
function corpusSpecFiles() {
  const out = [];
  const walk = (dir) => {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.test\.[cm]?[jt]s$|\.char\.[cm]?[jt]s$/.test(e.name)) out.push(join(dir, e.name));
      }
    } catch { /* no corpus */ }
  };
  walk(resolve(REPO_ROOT, TESTS));
  return out;
}

/** The spec files under the corpus directory, for the full pass's time limit. */
function corpusSpecCount() {
  const count = (dir) => {
    let n = 0;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) n += count(join(dir, e.name));
        else if (/\.test\.[cm]?[jt]s$/.test(e.name)) n += 1;
      }
    } catch { /* no corpus: the floor applies */ }
    return n;
  };
  return count(resolve(REPO_ROOT, TESTS));
}

/** One vitest run under the repo's own config (or `config`), with both reporters. */
function runVitest(args, { tag, timeout, config = null }) {
  const json = join(OUT_DIR, `.cigate-${tag}.json`);
  const errs = join(OUT_DIR, `.cigate-${tag}-unhandled.json`);
  rmSync(json, { force: true });
  rmSync(errs, { force: true });
  const extra = withUnhandledReporter(errs);
  const cfg = config ? ["--config", config] : [];
  // D54: under the CI's Node, with its bin first on PATH (cinode.mjs).
  const r = spawnSync(TARGET_NODE.node, [...gateHeapArgs(args), VITEST_BIN, "run", ...cfg, ...args, "--reporter=json", ...extra.args, "--outputFile", json], {
    cwd: REPO_ROOT, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, env: targetNodeEnv({ ...process.env, ...extra.env }, TARGET_NODE),
  });
  if (r.error?.code === "ETIMEDOUT") return { error: `timed out after ${Math.round(timeout / 1000)}s`, timedOut: true };
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const doc = existsSync(json) ? JSON.parse(readFileSync(json, "utf8")) : noFileReport(output);
  if (!doc) return { error: `vitest wrote no report (exit ${r.status}${r.signal ? `, ${r.signal}` : ""})` };
  return {
    doc,
    status: r.status,
    unhandled: readUnhandled(errs),
    output,
    command: config ? `vitest run --config ${relative(REPO_ROOT, config)} ${TESTS} (the corpus's own config)` : `vitest run ${TESTS} (the repo's own config)`,
  };
}

/** One spec file, alone, whole: the D90 re-run of a file that timed out loading. */
function rerunFileAlone(t, config = null) {
  return runVitest([resolve(REPO_ROOT, t.file), "--coverage.enabled=false"], { tag: "load-retry", timeout: suiteTimeoutMs(1), config });
}

/** One emitted test, alone: its file and its exact title, coverage off. */
function rerunAlone(f, config = null) {
  const argv = aloneArgs(f);
  return argv.error ? argv : runVitest(argv, { tag: "alone", timeout: 5 * 60_000, config });
}

/** The vitest filter for one row run alone: its spec and its test, by title or else by id (D88). */
export function aloneArgs(f) {
  if (!f.file || !(f.title || f.id)) return { error: "vitest named no file or title for it" };
  // Absolute: vitest matches a file filter against the absolute path.
  return [resolve(REPO_ROOT, f.file), "-t", f.title ? titlePattern(f.title) : idPattern(f.id), "--coverage.enabled=false"];
}

/**
 * A WITHHOLD MAY NEVER COST SIDES SILENTLY (the user's rule 1).
 *
 * A test that fails the repo's own config and PASSES under the repo's own
 * config WITH THE RECORDING'S RESOLUTION (`vitest.recheck.config.mts`: that
 * one difference and nothing else) is not a red test. Resolution is the only
 * thing that changed, so resolution is what made it red: a config this
 * pipeline wrote, or that the corpus extends, resolving differently from the
 * recording - OUR gap. nginx-redirecting-ms (run 20260924T054903Z) is the
 * measured case: its bootstrapped root config had no `@/` alias, cigate
 * withheld 55 of 103 green tests, and stage 6 fell from 131/133 live sides to
 * 39/133 with every drop reading as "quarantined".
 *
 * NOT the coverage config: it also drops the repo's setupFiles and sets its
 * own timeouts and env, so a test the repo's own setup makes red - a real CI
 * red - passed there and was called a config gap (verifier, fix round 1).
 *
 * So when a tests-gate withhold claims sides, cigate's own run is repeated
 * under that config - the same files, not only the candidates' (recheckFilter)
 * - with coverage off: this asks pass or fail. One that passes there
 * is NOT quarantined: it stays in the suite, and it is a pipeline_defect named
 * `config-gap`. One that fails there too is withheld as before. A re-check
 * that could not run keeps the withhold and says so as a pipeline_defect -
 * never a silent loss.
 */
export const UNHANDLED_KINDS = new Set(["unhandled", "unhandled-traced"]);

/**
 * An unhandled-error withhold is re-checked the way it was confirmed: ALONE
 * (D88). Its own assertions pass either way - the error is a rejection that
 * surfaces after its test ended - so "passed in the full re-check" said only
 * that the rejection had not surfaced there yet. qode-ptp-ms 20260930T033300Z
 * called 12 such rows `config-gap` and ruled them pipeline_defect: a double
 * with no `getBlobAccessLink`, the proposal's to repair. With `alone` (a lone
 * re-run under the recording's resolution) one that raises it there too stays
 * withheld; one that does not is the gap. Without `alone`, as before.
 */
export function configGaps(withheld, recheck, alone = null) {
  const candidates = withheld.filter((w) => w.gate === "tests" && (w.sides ?? []).length);
  if (!candidates.length) return { withheld, gaps: [], defects: [] };
  const lone = alone ? candidates.filter((w) => UNHANDLED_KINDS.has(w.kind)) : [];
  const whole = candidates.filter((w) => !lone.includes(w));
  const gapIds = new Set();
  const defects = [];
  const unchecked = [];
  for (const w of lone) {
    const r = alone(w);
    const v = r && !r.error ? verdictAlone(r, w.id) : { verdict: "unchecked", why: r?.error ?? "no result" };
    if (v.verdict === "innocent") gapIds.add(w.id);
    else if (v.verdict === "unchecked") unchecked.push(`${w.id} (${v.why})`);
  }
  if (unchecked.length) {
    defects.push({
      kind: "config-gap-unchecked",
      message: oneLine(`${unchecked.length} row(s) withheld for an unhandled error could not be re-run alone under the recording's resolution - withheld unverified: ${unchecked.join(", ")}`, 800),
    });
  }
  if (whole.length && (!recheck || recheck.error)) {
    defects.push({
      kind: "config-gap-unchecked",
      message: oneLine(`${whole.length} withheld row(s) claim sides, and the re-check under the repo's config with the recording's resolution could not run (${recheck?.error ?? "no result"}) - they are withheld unverified: ${whole.map((w) => w.id).join(", ")}`, 800),
    });
  } else if (whole.length) {
    const passed = new Set();
    const red = new Set(redOf(recheck).failures.map((f) => f.id));
    for (const file of recheck.doc?.testResults ?? []) {
      for (const t of file.assertionResults ?? []) if (t.status === "passed") passed.add(rowIdOf(t.title));
    }
    for (const w of whole) if (passed.has(w.id) && !red.has(w.id)) gapIds.add(w.id);
  }
  const gaps = withheld.filter((w) => gapIds.has(w.id));
  return {
    withheld: withheld.filter((w) => !gapIds.has(w.id)),
    gaps,
    defects: [...defects, ...gaps.map((w) => ({
      kind: "config-gap",
      id: w.id,
      file: w.file,
      // NOT `sides`: these stay covered - the test is not withheld - and a
      // defect's `sides` are what the walk rules pipeline_defect.
      coveredSides: w.sides,
      message: oneLine(
        `${w.id} fails the repo's own config (${w.message}) and PASSES under that same config with the recording's resolution - ` +
          `a config this pipeline wrote or the corpus extends resolves differently; NOT quarantined, which would cost ${w.sides.length} covered side(s)`,
        600
      ),
    }))],
  };
}

/**
 * WHAT THE RE-CHECK RUNS: the files cigate's own run ran, never only the
 * candidates' (D48).
 *
 * The re-check is a proof only while the config is its ONE difference from
 * the run that found the row red. It used to run just the candidates' files,
 * and that is a second difference: a lighter run. ats-sourcing-service (the
 * mocked run of late September 2026): once its 56 real resolution gaps were
 * fixed, one row stayed red - module-scope-14-binary-expr-0, the first row of
 * index.char.test.ts, whose cold import of the whole app graph takes 4s alone
 * and ran past its 10s row budget with 34 other spec files transforming beside
 * it. Its file re-checked ALONE passed, so it was called a `config-gap` and
 * kept in the suite, red in the repo's own `npm test` under that same load.
 * Run over the same files, it is red there too and is withheld with its error.
 * null when no candidate claims a side, so nothing needs re-checking.
 */
export function recheckFilter(candidates) {
  return candidates.some((w) => w.gate === "tests" && (w.sides ?? []).length) ? [TESTS] : null;
}

/**
 * WHETHER A PASS RUNS THE FULL CONFIG-GAP RE-CHECK, AND OVER WHAT.
 *
 * qode-ptp-ms 20260930T033300Z spent 44 of a 77-minute walk in emit, and one
 * of cigate's three or four passes over the corpus in it was this re-check.
 *
 *   - An unhandled-error withhold is re-checked alone since D88, so it never
 *     needs this pass. With every candidate of that kind there is nothing to
 *     re-check, and no pass runs.
 *   - A PARTIAL pass that withholds anything is never the pass that stands:
 *     main() gates the whole corpus after it (partialFound), and that pass
 *     re-checks what it finds. So a partial pass re-checks nothing.
 *     CHARPILOT_CIGATE_RECHECK_PARTIAL=on is the kill switch, and restores the
 *     re-check it used to run and then discard.
 *   - ITEM 4: on a ROUND walk the re-check runs only the withheld rows' spec
 *     files. The bank walk keeps D48's whole corpus: a lighter run can pass a
 *     row that is red under the full corpus's load and call it a `config-gap`
 *     it is not. A round walk may keep such a row in its suite one walk
 *     longer; the bank walk, whose report is the one delivered, re-checks
 *     under the whole corpus, finds it red and withholds it before anything
 *     is reported. CHARPILOT_CIGATE_RECHECK_SCOPE=full is the kill switch.
 *
 * `filter` null: no full re-check (`skip` true: nor any of configGaps).
 */
export const RECHECK_PARTIAL_ENV = "CHARPILOT_CIGATE_RECHECK_PARTIAL";
export const RECHECK_SCOPE_ENV = "CHARPILOT_CIGATE_RECHECK_SCOPE";
export function recheckPlan(candidates, { partial = false, env = process.env } = {}) {
  const whole = candidates.filter((w) => !UNHANDLED_KINDS.has(w.kind));
  if (partial && candidates.length && String(env[RECHECK_PARTIAL_ENV] ?? "").trim().toLowerCase() !== "on") {
    return { filter: null, skip: true, why: "a partial pass that withholds a row is followed by a full pass, which re-checks it" };
  }
  const filter = recheckFilter(whole);
  if (!filter) {
    return { filter: null, skip: false, why: candidates.length && !whole.length ? "every candidate is an unhandled-error withhold, re-checked alone (D88)" : "no candidate claims a side" };
  }
  if (String(env[BANK_WALK_ENV] ?? "") === "1") return { filter, skip: false, why: "the bank walk re-checks under the whole corpus (D48)" };
  if (String(env[RECHECK_SCOPE_ENV] ?? "").trim().toLowerCase() === "full") return { filter, skip: false, why: `${RECHECK_SCOPE_ENV}=full` };
  const rows = whole.filter((w) => w.gate === "tests" && (w.sides ?? []).length);
  if (rows.some((w) => !w.file)) return { filter, skip: false, why: "a withheld row names no spec file, so the whole corpus is re-checked" };
  const files = [...new Set(rows.map((w) => w.file))].sort();
  return { filter: files, skip: false, why: `a round walk re-checks only the ${files.length} spec file(s) of the withheld rows; the bank walk re-checks the whole corpus (D48)` };
}

/** cigate's own run again, under the repo's config plus the recording's resolution, coverage off. */
function recheckUnderRecordedResolution(filter) {
  if (!existsSync(RECHECK_CONFIG)) return { error: `${relative(REPO_ROOT, RECHECK_CONFIG)} is not installed` };
  // The same run as cigate's own - same env, same files, same everything - but the config.
  // D77 and item 18c for it too: it is a second full pass whenever a withheld
  // row claims sides. On qode-ptp-ms it followed every red gate, one file at a
  // time, under a fixed 30 minutes: the half of a 39-minute red gate that the
  // shards did not reach, and a limit one pass away from config-gap-unchecked.
  const full = filter.length === 1 && filter[0] === TESTS;
  const specs = full ? corpusSpecCount() : filter.length;
  const shards = full ? cigateShards(specs) : 1;
  const opts = { tag: "recheck", timeout: suiteTimeoutMs(specs), config: RECHECK_CONFIG };
  return shards > 1
    ? runVitestSharded(["--coverage.enabled=false", ...filter], shards, opts)
    : runVitest(["--coverage.enabled=false", ...filter], opts);
}

function typecheckScript() {
  try {
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).scripts ?? {};
    return ["typecheck", "type-check", "tsc"].find((k) => typeof scripts[k] === "string") ?? null;
  } catch {
    return null;
  }
}

function runTypecheck() {
  const script = typecheckScript();
  if (!script || ARGV.includes("--no-typecheck")) return { skipped: script ? "--no-typecheck" : "the repo declares no typecheck script" };
  const r = spawnSync("npm", ["run", "--silent", script], { cwd: REPO_ROOT, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: targetNodeEnv(process.env, TARGET_NODE) });
  return { command: `npm run ${script}`, ok: r.status === 0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function recordedDoc() {
  try {
    // In shards or one file (D57, recordedstore.mjs).
    return readRecorded(join(REPO_ROOT, TESTS));
  } catch {
    return {};
  }
}

function recordedRows(doc = recordedDoc()) {
  return new Map((doc.rows ?? []).map((r) => [r.id, r]));
}

/**
 * ONE PASS OF THE GATE over `files` (null: the whole corpus), with nothing
 * written: main() decides whether this pass is the one that stands.
 */
function gateOnce(files = null, { partial = Boolean(files?.length) } = {}) {
  let tests = runTests(null, files);
  const notes = [];
  const { config, note } = gateConfig(tests, existsSync(CORPUS_CONFIG));
  if (config) {
    notes.push(note);
    tests = runTests(config, files);
  }
  if (tests.error) return { error: tests.error };
  const red = redOf(tests);
  const defects = red.defects;
  const measurements = red.measurements;
  // D90: a spec whose module fetch timed out is run again alone, and its rows
  // are judged on that run - never withheld for the host's load.
  const retried = retryLoadTimeouts(red.loadTimeouts ?? [], (t) => rerunFileAlone(t, config));
  notes.push(...retried.notes);
  defects.push(...retried.defects);
  // D91 for the gate: said once per pass, when a heap was raised.
  notes.push(...takeHeapNotes());
  measurements.push(...retried.measurements);
  // An unhandled error withholds only the test that raises it when run alone.
  const confirmed = confirmUnhandled([...red.failures, ...retried.failures], (f) => rerunAlone(f, config));
  const failures = confirmed.failures;
  defects.push(...confirmed.defects);

  const tc = runTypecheck();
  if (tc.command && !tc.ok) {
    for (const [file, first] of typeErrorsIn(tc.output)) {
      let ids = [];
      try { ids = rowsInSpec(readFileSync(join(REPO_ROOT, file), "utf8")); } catch { ids = []; }
      for (const id of ids) failures.push({ id, file, kind: "type-check", gate: "type-check", message: oneLine(`${tc.command}: ${first}`) });
    }
  }

  // D55: what no run here can see - a spec that names this checkout's root.
  // Over the files this pass gates (the whole corpus on a full pass).
  const leaks = rootLeakFindings(files?.length ? files.filter((f) => /\.ts$/.test(f)) : corpusSpecs());
  failures.push(...leaks.failures);
  defects.push(...leaks.defects);

  // One entry per row: the first failure is the one that withholds it.
  const byId = new Map();
  for (const f of failures) if (!byId.has(f.id)) byId.set(f.id, f);
  const drawn = recordedDoc();
  const rows = recordedRows(drawn);
  // The renderer that drew the suite just judged (config.mjs emitterDigest).
  const emitter = drawn.emitter ?? null;
  const candidates = [...byId.values()].map((f) => ({
    ...f,
    // WHICH RECORDING this verdict is about (record.mjs observationKey, D33):
    // the next emit keeps the row skipped only while that is still the one on
    // disk, and runs it again once the row has been recorded anew.
    observation: rows.get(f.id)?.observation ?? null,
    // And WHICH TEST: the same recording rendered by another template is
    // judged again (record.mjs bindQuarantine).
    emitter,
    sides: sidesOf(rows.get(f.id)),
    why: oneLine(
      f.gate === "root-scan"
        ? `withheld by cigate: the spec names this checkout's absolute root, which the repo's CI does not have (D55) - ${f.message}`
        : `withheld by cigate: fails the repo's own ${f.gate === "tests" ? tests.command : tc.command} - ${f.message}`,
      400
    ),
  }));
  // D88: an unhandled-error withhold is re-checked alone, not by the full
  // pass; and a partial pass that withholds is gated again in full (recheckPlan).
  const plan = recheckPlan(candidates, { partial });
  const recheck = plan.filter;
  // Under the corpus's own config the resolution already IS the recording's,
  // and the re-check config (the repo's root plus that resolution) would
  // collect none of these files: there is no config gap to look for.
  const gate = config || plan.skip
    ? { withheld: candidates, gaps: [], defects: [] }
    : configGaps(candidates, recheck ? recheckUnderRecordedResolution(recheck) : null, (w) => rerunAlone(w, RECHECK_CONFIG));
  if (!config && candidates.length) process.stdout.write(`· config-gap re-check: ${recheck ? `over ${recheck.join(", ").slice(0, 200)}` : "no full pass"} - ${plan.why}\n`);
  defects.push(...gate.defects);
  return { tests, tc, notes, failures, byId, rows, emitter, withheld: gate.withheld, gapIds: new Set(gate.gaps.map((g) => g.id)), defects, measurements };
}

/**
 * A PARTIAL PASS THAT FOUND ANYTHING AT ALL IS NOT THE PASS THAT STANDS.
 *
 * A red file may be red because of another file (D52, a mock leaking between
 * rows), a coverage threshold measured over a few files is a number about
 * those few, and a withhold's config-gap re-check has to run over what the
 * full gate runs (D48). So the whole corpus is gated instead, and the partial
 * pass is only said. Null when the partial pass found nothing.
 */
export function partialFound(outcome) {
  if (!outcome || outcome.error) return outcome?.error ? `a run that could not start (${outcome.error})` : "nothing it could report";
  const parts = [];
  if (outcome.failures.length) parts.push(`${outcome.failures.length} failure(s)`);
  if (outcome.defects.length) parts.push(`${outcome.defects.length} pipeline_defect(s)`);
  if (outcome.measurements.length) parts.push(`${outcome.measurements.length} measurement(s)`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * ITEM 3: A ROUND WALK RE-GATES ONLY THE FILES A PASS FOUND RED.
 *
 * `--red-files a,b` is steps/emit.mjs asking, after a withhold and its
 * re-emit, for the files whose rows were withheld and nothing else. Those are
 * the only files the re-emit changed, and every other file was just gated
 * with the whole corpus. The pass is never widened: what it finds is
 * withheld like any other pass's. The bank walk never asks for it (emit.mjs
 * redFilesFor), so a file red only in company (D48, D52) is still found by a
 * full pass before anything is delivered.
 *
 * `afterFull` is what lets a round walk's report stand on this pass
 * (incremental.mjs restsOnFull): the last pass was full, or a re-gate after
 * one, over the same context, and no file changed since it but these.
 */
export function redFilesPlan(list, ledger, manifest, context) {
  const files = String(list ?? "").split(",").map((f) => f.trim()).filter(Boolean).sort();
  if (!files.length) return null;
  const moved = ledger?.specs && manifest?.hashes ? specDiff(ledger.specs, manifest.hashes) : null;
  const outside = moved ? [...moved.changed, ...moved.added, ...moved.removed].filter((f) => !files.includes(f)) : null;
  const afterFull =
    (ledger?.scope === "full" || (ledger?.scope === "red-files" && ledger.afterFull === true)) &&
    (context?.digest ?? null) === (ledger?.context ?? null) &&
    Array.isArray(outside) && !outside.length;
  return {
    scope: "red-files",
    why: `the ${files.length} spec file(s) whose rows the last pass withheld, re-emitted; every other file was gated with the whole corpus`,
    files,
    afterFull: Boolean(afterFull),
  };
}

/**
 * What a red-files pass carries from the pass before it: that pass's
 * pipeline_defects about any OTHER file, or about no file (this pass could
 * not have seen them go away), and its measurements, which were taken over
 * the corpus - a measurement over a few files is a number about those few.
 */
export function carriedFindings(prior, files, defects) {
  const own = new Set(files);
  const carried = (prior?.pipelineDefects ?? []).filter((d) => !d?.file || !own.has(d.file)).map((d) => ({ ...d, carried: true }));
  return { defects: [...defects, ...carried], measurements: (prior?.measurements ?? []).map((m) => ({ ...m, carried: true })) };
}

function readPriorReport() {
  try {
    return JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  // THE PLAN (incremental.mjs). `--incremental` is the walk's permission and
  // only its permission: this tool still gates everything unless its own
  // ledger, emitted.json, out/dirty.json and the disk all agree it need not.
  const prior = readPriorReport();
  const manifest = manifestHashes(join(REPO_ROOT, TESTS, "emitted.json"));
  const context = incrementalOn() ? contextDigest() : null;
  const red = redFilesPlan(arg("--red-files"), prior?.ledger, manifest, context);
  let plan = red
    ? red
    : ARGV.includes("--incremental")
    ? planIncremental({
        ledger: prior?.ledger,
        manifest,
        disk: diskHashes(join(REPO_ROOT, TESTS)),
        dirty: readDirty(),
        context,
        refusal: incrementalOn() ? null : `${INCREMENTAL_ENV}=off`,
        every: fullEvery(),
      })
    : { scope: "full", why: incrementalOn() ? "the walk asked for a full gate" : `${INCREMENTAL_ENV}=off`, files: [] };

  // NOTHING CHANGED SINCE A GREEN PASS: the report stands as it was, with its
  // notes, and the ledger says so. The quarantine is untouched - no row was
  // judged, and a row whose recording moved renders differently, so it is in a
  // changed file and never reaches this branch.
  if (plan.scope === "unchanged") {
    const report = {
      ...prior,
      ranAt: new Date().toISOString(),
      scope: "unchanged",
      scopeWhy: plan.why,
      gatedFiles: [],
      withheld: [],
      pipelineDefects: [],
      ledger: nextLedger({ prior: prior.ledger, plan, manifest, context, green: true }),
    };
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\n✓ cigate: nothing to gate - ${plan.why}; the last pass (${prior.ledger.scope}, ${prior.ledger.at}) stands\n`);
    return;
  }

  let outcome = gateOnce(plan.scope === "partial" || plan.scope === "red-files" ? plan.files : null, { partial: plan.scope === "partial" });
  let partialSaid = null;
  if (plan.scope === "partial") {
    const found = partialFound(outcome);
    if (found) {
      partialSaid = `a partial pass over ${plan.files.length} changed file(s) found ${found}`;
      plan = { scope: "full", why: `${partialSaid} - gated in full, because a file can be red in company (D48, D52)`, files: [] };
      outcome = gateOnce(null);
    }
  }
  if (outcome.error) {
    process.stderr.write(`\n✗ cigate: could not run the repo's tests over ${TESTS}: ${outcome.error}\n`);
    process.exit(1);
  }
  const { tests, tc, notes, failures, byId, rows, emitter, withheld, gapIds } = outcome;
  let { defects, measurements } = outcome;
  if (plan.scope === "red-files") ({ defects, measurements } = carriedFindings(prior, plan.files, defects));

  const quarantine = existsSync(QUARANTINE) ? JSON.parse(readFileSync(QUARANTINE, "utf8")) : { rows: [] };
  // A config gap is un-withheld even when an EARLIER pass quarantined it.
  // And one whose recording has been replaced is not carried: it judged an
  // observation that is no longer the suite's (D33), and the emit that follows
  // renders the row to run.
  // And one withheld only because its spec timed out loading (D90) is never
  // carried: it said nothing about the row, which this pass has run again.
  const keep = (quarantine.rows ?? []).filter(
    (r) =>
      !byId.has(r.id) &&
      !(gapIds.has(r.id) && /^withheld by cigate/.test(String(r.why ?? ""))) &&
      !supersededEntry(r, rows, emitter) &&
      !loadTimeoutWithhold(r)
  );
  writeFileSync(
    QUARANTINE,
    `${JSON.stringify({ ...quarantine, rows: [...keep, ...withheld.map(({ sides, ...r }) => r)] }, null, 2)}\n`
  );
  // GREEN is what a later partial pass may build on: nothing withheld, nothing
  // red, no threshold. A type-check that is red on the repo's OWN code is the
  // repo's state and the same whichever files were gated; a type error IN the
  // corpus is already a failure above, and withholds its rows.
  const green = !withheld.length && !defects.length && !measurements.length;
  const report = {
    stage: "5-cigate",
    ranAt: new Date().toISOString(),
    tests: { command: tests.command, files: (tests.doc.testResults ?? []).length, failed: failures.filter((f) => f.gate === "tests").length },
    typecheck: tc.command ? { command: tc.command, ok: tc.ok } : { skipped: tc.skipped },
    withheld,
    // Red the gate could not hang on a row: never withheld, never green.
    pipelineDefects: defects,
    // A non-zero exit that is a number, not a red test (a coverage threshold
    // over the corpus alone): its own class, named, not a defect and not green.
    measurements,
    // What the gate did differently, and why (the corpus's own config).
    notes,
    // D54: the Node the suite ran under, and where that was read (cinode.mjs).
    targetNode: { node: TARGET_NODE.node, major: TARGET_NODE.major, source: TARGET_NODE.source, available: TARGET_NODE.available, why: TARGET_NODE.why },
    // WHAT THIS PASS RAN OVER (incremental.mjs): the whole corpus, or the
    // files that changed since a green pass. `ledger` is what the next pass
    // plans from, and what steps/emit.mjs asks before a report rests on it.
    // Absent under the kill switch, which is today's report exactly.
    ...(incrementalOn()
      ? {
          scope: plan.scope,
          scopeWhy: plan.why,
          gatedFiles: plan.scope === "partial" || plan.scope === "red-files" ? plan.files : [],
          ...(partialSaid ? { partialFallback: partialSaid } : {}),
          ledger: nextLedger({ prior: prior?.ledger, plan, manifest, context, green }),
        }
      : {}),
  };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `\n${defects.length ? "✗" : withheld.length || measurements.length ? "!" : "✓"} cigate: ${tests.command}${tc.command ? ` and ${tc.command}` : ` (type-check: ${tc.skipped})`}\n` +
      (incrementalOn() || plan.scope === "red-files"
        ? `    ${plan.scope === "partial" ? `PARTIAL over ${plan.files.length} spec file(s): ${plan.why}` : plan.scope === "red-files" ? `RED FILES over ${plan.files.length} spec file(s): ${plan.why}` : `full: ${plan.why}`}\n`
        : "") +
      `    withheld ${withheld.length} row(s)${withheld.length ? " - quarantined with their error; re-emit renders them it.skip, and their sides are a pipeline_defect" : ""}\n`
  );
  process.stdout.write(`    ${targetNodeLine(TARGET_NODE)}\n`);
  for (const n of notes) process.stdout.write(`    note [${n.kind}]  ${n.message}\n`);
  for (const m of measurements) process.stdout.write(`    ! [${m.kind}]  ${m.message}\n`);
  for (const w of withheld.slice(0, 20)) process.stdout.write(`      ${w.id}  [${w.gate}/${w.kind}]  ${w.message}\n`);
  if (defects.length) {
    process.stdout.write(`    ✗ ${defects.length} pipeline_defect(s) - red that is NOT withheld, so the suite is NOT green:\n`);
    for (const d of defects.slice(0, 20)) process.stdout.write(`      [${d.kind}]  ${d.message}\n`);
  }
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}
