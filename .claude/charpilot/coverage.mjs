/**
 * Stage 5 - measurement.
 *
 * Stages 3 and 4 produce a claim and an observation. Neither can tell you
 * whether the input actually reached the side it was written for: `reaches` is
 * a SENTENCE a proposal wrote about itself. The README lists that as residual
 * risk #1, and this is the script that retires it.
 *
 * What it does:
 *   1. re-runs the recorded rows under istanbul, into their OWN reports dir
 *   2. joins the result to the AST arms with the same matching stage 2 proved
 *      closes at zero drift (imported, not re-implemented)
 *   3. checks every `reaches` claim against what was actually hit
 *   4. emits the sides still uncovered, which is the input to the next loop
 *
 * The interesting output is not the percentage. It is a claim that turns out to
 * be false: an input written to exercise the then-side that never reached it,
 * whose recorded pair therefore freezes a DIFFERENT arm under the wrong label.
 * Nothing before this stage can detect that.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  armCoverage,
  armIdKind,
  armIndexFromScan,
  buildHitIndex,
  buildPositionIndex,
  claimedSides,
  isNonBranchKind,
  measureArmsByPosition,
  nonBranchReason,
  sideIndexOf,
} from "./armjoin.mjs";
import { peakOf } from "./report.mjs";
// D64 — WHOSE FAILURE A SKIP REASON IS ABOUT. `skipDiagnosis` is the one
// classifier of record.mjs's own `skipped[]` sentences in this toolset, and a
// second copy of that table here is the drift the rest of this file argues
// against everywhere else. It is a pure function of one string; importing the
// step it lives in costs a module load and buys the guarantee that `derive`,
// `repair` and this stage read the recorder's words the same way.
import { SKIP_ABOUT, harnessDiagnosis, skipDiagnosis } from "./steps/repair.mjs";
// The BLOCKED.md format, read by the same parser the ledger and blocked.mjs use.
import { armSideLabels, parseBlocked, refusedBySide, sidesOf } from "./ledger.mjs";
import { loadProposals as loadProposalCorpus } from "./validate.mjs";
// The rate rule and the live-code correction: pure, config-free, and imported
// rather than reimplemented so the gate, result.json and this stage cannot
// reach three different denominators from one artifact.
import { deadExportFunctionIds, liveCodeTotals, modeOf, modeStamp } from "./targets.mjs";
import {
  BASELINE_JSON,
  COVERAGE_DIR,
  BEHAVIOUR_JSON,
  OUT_DIR,
  CONFIG_DIR,
  PILOT_DIR,
  PROPOSALS_DIR,
  REPO_ROOT,
  SCAN_JSON,
  WORKLIST_JSON,
  CORPUS_REL,
  isCorpusSpec,
  maskDatabaseEnv,
} from "./config.mjs";
import { CHUNKS_OUT_ENV, REUSE_ENV } from "./coveragechunks.mjs";
import { suiteTimeoutMs, timedOutLine } from "./suitelimit.mjs";
import { MEASURE_HEAP_ENV, V8_OOM, heapNeedMB, heapRetryMB, measureHeapOn, measureHeapPlan, oomLine, signalVerdict, targetHeapLimitMB } from "./measureheap.mjs";
// D54: the measurement runs the target under the Node its CI runs (cinode.mjs).
import { targetNode, targetNodeEnv } from "./cinode.mjs";
import { parseEnvText } from "./envfile.mjs";
import {
  INCREMENTAL_ENV,
  contextDigest,
  digestOfHashes,
  diskHashes,
  fullEvery,
  incrementalOn,
  manifestHashes,
  nextLedger,
  planIncremental,
  readDirty,
  sha256,
} from "./incremental.mjs";
import {
  LOAD_TIMEOUT_RETRY_ENV,
  classifyUnhandled,
  failedToLoad,
  loadTimeoutRetryOn,
  loadTimeoutWithhold,
  loadTimeoutsIn,
  readUnhandled,
  sizeOf,
  unhandledThatCounts,
  withUnhandledReporter,
} from "./vitestred.mjs";

const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const SKIP_RUN = ARGV.includes("--no-run");
const ENV_FILE = arg("--env-file");
/**
 * The suite to measure, and the default is the COMMITTED one.
 *
 * It used to default to `out/specs` - the recorder's throwaway specs - so
 * `npm run pilot:coverage` with no flags measured whatever generation last left
 * in that directory. Run today it measured specs written five days earlier
 * against a src/ that had moved: 0 sides credited to characterization and 452
 * claims reported FALSE, with nothing in the output saying which suite it had
 * read. That is the same defect as the hard-wired `include` this flag was added
 * to fix, one layer up - the recorder's specs run every runnable row, the
 * committed tests only the ones with a recorded outcome, and the two are not
 * interchangeable.
 *
 * So the default is `test/characterization`, and `--specs out/specs` is the
 * deliberate act it should always have been.
 */
const SPECS_DIR = resolve(arg("--specs") ?? join(REPO_ROOT, CORPUS_REL));
const SPECS_RELATIVE = relative(REPO_ROOT, SPECS_DIR);
/** Set by runSpecsUnderCoverage; 0 means the ledger row describes a measurement of nothing. */
let SPECS_COUNT = 0;
/** Set by runSpecsUnderCoverage: the suite's own test counts (see suiteTestCounts). */
let SUITE_TESTS = null;
// Stage 6 measures the GENERATED SUITE. It used to point at the recorder's own
// specs, which hit 845 sides where the shipped tests hit 726 - the specs run
// all 269 runnable rows, the tests only the 218 with a recorded outcome.
// Quoting the specs' figure would have credited the suite with coverage it
// does not have.
const STAGE5_COVERAGE = resolve(REPO_ROOT, arg("--coverage-dir") ?? "coverage-charpilot-stage6");
const CONFIG = join(CONFIG_DIR, "vitest.coverage.config.mts");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const OUTPUT = join(OUT_DIR, "coverage.json");
const LOOP_JSON = join(OUT_DIR, "loop.json");
const DEAD_EXPORTS = join(OUT_DIR, "dead-exports.json");

const read = (p) => JSON.parse(readFileSync(p, "utf8"));

/** Same env handling as the recorder: the arms read these values. */
function buildEnv() {
  const env = { ...process.env, NODE_ENV: "test", TZ: "UTC" };
  if (ENV_FILE) {
    if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
    Object.assign(env, parseEnvText(readFileSync(ENV_FILE, "utf8")));
  }
  // Defence in depth (tool backlog): the suite under measurement replays its
  // recording and never needs a database; outside a live run it gets none.
  if (String(process.env.CHARPILOT_MODE ?? "").toLowerCase() !== "live") maskDatabaseEnv(env);
  return env;
}

function runSpecsUnderCoverage() {
  const specs = existsSync(SPECS_DIR) ? readdirSync(SPECS_DIR).filter(isCorpusSpec) : [];
  if (!specs.length) {
    process.stderr.write(
      `\nno specs in ${relative(REPO_ROOT, SPECS_DIR)}. Stage 5 measures the RECORDED rows, so emit them first:\n` +
        `  node .claude/charpilot/record.mjs --emit-specs ${relative(REPO_ROOT, SPECS_DIR)}` +
        (ENV_FILE ? ` --env-file ${ENV_FILE}` : "") +
        "\n"
    );
    process.exit(1);
  }
  SPECS_COUNT = specs.length;
  // THE PLAN (incremental.mjs, and coveragechunks.mjs for why the merge is
  // vitest's own). Only for the committed suite measured into its own
  // directory: `--specs` and `--coverage-dir` are diagnostics, run in full.
  const incremental = incrementalOn() && !arg("--specs") && !arg("--coverage-dir");
  const manifest = incremental ? manifestHashes(join(SPECS_DIR, "emitted.json")) : null;
  const disk = incremental ? diskHashes(SPECS_DIR) : null;
  const context = incremental ? contextDigest() : null;
  const store = incremental ? readChunkStore() : null;
  let plan = incremental && ARGV.includes("--incremental")
    ? planIncremental({ ledger: store, manifest, disk, dirty: readDirty(), context, refusal: storeRefusal(store), every: fullEvery() })
    : { scope: "full", why: incremental ? "the walk asked for a full measurement" : `${INCREMENTAL_ENV}=off or a diagnostic run`, files: [] };

  if (plan.scope === "unchanged") {
    // THE SAME SUITE, MEASURED ALREADY: its report is the one on disk, checked
    // against the hash the store wrote beside it. It is stamped as of now,
    // because it IS this suite's measurement - the emission that made
    // emitted.json newer changed no byte of it.
    const final = join(STAGE5_COVERAGE, "coverage-final.json");
    const now = new Date();
    utimesSync(final, now, now);
    SUITE_TESTS = sumCounts(Object.values(store.counts));
    writeChunkStore({ ...store, ...nextLedger({ prior: store, plan, manifest: { hashes: disk, digest: digestOfHashes(disk) }, context, green: true }) });
    process.stdout.write(`· measuring nothing: ${plan.why} - the report measured at ${store.at} is this suite's\n`);
    return { status: 0, signal: null, failingTests: [], measuredBy: { scope: "unchanged", why: plan.why, ran: [], reused: Object.keys(store.chunks).length } };
  }

  let run = null;
  if (plan.scope === "partial") {
    run = measureOnce(plan.files, store);
    const off = partialRefusal(run, plan.files);
    if (off) {
      process.stdout.write(`· the partial measurement is not the one that stands (${off}) - measuring every spec file\n`);
      plan = { scope: "full", why: `a partial measurement over ${plan.files.length} file(s) could not stand: ${off}`, files: [] };
      run = null;
    }
  }
  if (!run) run = measureOnce(null, null);
  // D90: a spec whose module fetch timed out is measured again alone.
  const retried = measureLoadTimeoutsAgain(run, { incremental });
  run = retried.run;
  const measuredBy = { scope: plan.scope, why: plan.why, ran: plan.scope === "partial" ? plan.files : [], reused: plan.scope === "partial" ? Object.keys(store.chunks).length - plan.files.filter((f) => f in store.chunks).length : 0 };
  if (incremental) {
    const kept = keepStore({ run, plan, store, disk, context });
    if (kept.why) process.stdout.write(`· per-file coverage not kept for the next walk: ${kept.why}\n`);
  }
  SUITE_TESTS = run.tests;
  if (run.error) {
    // D77: a pass killed at its limit is not one that could not start.
    const why = run.error.code === "ETIMEDOUT" && run.limitMs
      ? `vitest ${timedOutLine(run.limitMs, run.specs)}`
      : `vitest could not be started: ${run.error.message}`;
    process.stderr.write(`\n✗ stage 6: ${why}\n`);
    process.exit(1);
  }
  if (!existsSync(join(STAGE5_COVERAGE, "coverage-final.json"))) {
    // D64: vitest's first error lines, not the last 2000 characters of its
    // stderr - see vitestSaid.
    // D91: a signal is named with what it most likely means and what to do.
    const summary =
      `✗ stage 6: no coverage report produced (vitest exited ${run.status}${run.signal ? `, signal ${run.signal}` : ""})` +
      (run.signal ? ` - ${signalVerdict({ signal: run.signal, stderr: run.stderr, heap: run.heap, stderrAt: run.stderrAt })}` : "");
    process.stderr.write(`\n${vitestSaidLines(vitestSaid(run.stderr, run.stdout), summary)}`);
    process.exit(1);
  }
  return {
    status: run.status,
    signal: run.signal,
    failingTests: run.failingTests,
    measuredBy,
    said: run.status === 0 ? null : vitestSaid(run.stderr, run.stdout),
    // Under the kill switch a timed-out file fails stage 6 exactly as before.
    loadTimeouts: loadTimeoutRetryOn() ? run.loadTimeouts ?? [] : [],
    loadTimeoutRetry: retried.retry,
    // D91: the heap vitest's main process was given, when it was not node's default.
    measureHeap: run.heap?.mb ? run.heap : null,
    heap: run.heap,
    stderrAt: run.stderrAt,
    fatal: run.signal ? oomLine(run.stderr) : null,
  };
}

/**
 * D90: A SPEC WHOSE MODULE FETCH TIMED OUT IS MEASURED AGAIN, ALONE, AND MERGED.
 *
 * qode-ptp-ms run 20260930T093551Z, 2026-09-30T11:13:42Z:
 *   measure: coverage.mjs exited 1 - ✗ stage 6: the suite under measurement did not pass (vitest exited 1)
 *   · FAIL test/characterization/lib-server-services-aiInterviewService.char.test.ts
 *   · Error: [vitest-worker]: Timeout calling "fetch" with "["/work/repo/test/characterization/lib-server-services-aiInterviewService.char.test.ts","ssr"]"
 * The spec is 33 MB. vitest 2.1.9's worker gives its module fetch a fixed 60 s,
 * vite's transform of that file on a host at load 10 took longer, and the file
 * never ran: the measurement failed, and the file's coverage was missing from
 * the number it printed (16923 of 18427). The attempt before measured the same
 * file at 96.8%.
 *
 * So each file the run lost this way (vitestred.mjs loadTimeoutsIn) is measured
 * again, and one line says so, with the file and its size:
 *   - alone, with the per-file coverage every other file just wrote handed to
 *     vitest (coveragechunks.mjs) - the partial measurement's own machinery,
 *     so coverage-final.json and the counts are the whole suite's, as a full
 *     run that had loaded it would have written them;
 *   - where that coverage is not there to hand over (the incremental store is
 *     off, or the run was not one isolated file per batch), the full
 *     measurement once more.
 * A file that times out again is not a behaviour change and is not called one:
 * `loadTimeouts` stays set, and stage 6 fails naming the timeout (see main).
 * `CHARPILOT_LOAD_TIMEOUT_RETRY=off` measures once, as before.
 */
export function loadTimeoutRetryPlan(run, { incremental, chunks = stagedChunks(run?.staged ?? ""), env = process.env } = {}) {
  if (!loadTimeoutRetryOn(env) || !run || run.error || !(run.loadTimeouts ?? []).length) return null;
  const files = [...new Set(run.loadTimeouts.map((t) => t.file))];
  // The rest's coverage is handed over only when each chunk is ONE spec
  // file's, from an isolated run - what partialRefusal asks of a partial run.
  const perFile = incremental && chunks.all.every((m) => (m.testFiles ?? []).length === 1 && m.isolate === true);
  if (!perFile) return { how: "full", files, why: incremental ? "the run's coverage is not one isolated spec file per batch" : `the per-file coverage store is off (${INCREMENTAL_ENV}=off or a diagnostic run)` };
  const reuse = chunks.all.filter((m) => !(m.testFiles ?? []).some((t) => files.includes(relative(REPO_ROOT, resolve(REPO_ROOT, t)))));
  return { how: "alone", files, reuse: reuse.map((m) => join(run.staged, m.file)), drop: chunks.all.filter((m) => !reuse.includes(m)).map((m) => m.file) };
}

/**
 * The first run and the lone re-run of its timed-out files, as ONE run: the
 * run that would have been, had those files loaded the first time. The lone
 * run's chunks join the first run's (the files' own, if any, replaced), its
 * per-file counts replace theirs, and it is red if either was red for any
 * reason but the timeouts the re-run answered.
 */
export function mergeLoneRun(run, lone, files) {
  const again = new Set((lone.loadTimeouts ?? []).map((t) => t.file));
  const perFile = { ...run.perFile };
  for (const f of files) if (f in (lone.perFile ?? {})) perFile[f] = lone.perFile[f];
  // Red for something else: a failing test, or a file that did not load for
  // its own reason. Those stand; the answered timeouts do not.
  const otherRed = run.failingTests.length > 0 || (run.unloaded ?? []).some((f) => !files.includes(f));
  const loneRed = lone.error || lone.status !== 0 || lone.failingTests.length > 0;
  const status = loneRed ? (lone.status || 1) : otherRed ? run.status || 1 : 0;
  // The full run's summary line counted the timed-out files as nothing ran,
  // so the lone run's counts are added to it; keepStore checks it against the
  // per-file counts, as for any full run.
  const summary = run.summary ? sumCounts([run.summary, ...files.map((f) => lone.perFile?.[f]).filter(Boolean)]) : null;
  // D92: the first run's words about a file the re-run loaded are not what
  // stands. qode-ptp-ms run 20260930T170133Z, 18:02Z: the file loaded alone,
  // the suite was red for an unhandled error elsewhere, and the quote the
  // agent was handed was the answered timeout.
  const answered = files.filter((f) => !again.has(f));
  return {
    ...run,
    status,
    signal: lone.signal ?? run.signal,
    error: lone.error ?? run.error,
    heap: lone.heap?.mb ? lone.heap : run.heap,
    stderrAt: lone.stderrAt ?? run.stderrAt,
    stdout: loneRed ? lone.stdout : withoutAnswered(run.stdout, answered),
    stderr: loneRed ? lone.stderr : withoutAnswered(run.stderr, answered),
    failingTests: [...run.failingTests, ...lone.failingTests],
    perFile,
    summary,
    tests: sumCounts(Object.values(perFile)),
    unloaded: [...(run.unloaded ?? []).filter((f) => !files.includes(f)), ...(lone.unloaded ?? [])],
    loadTimeouts: (lone.loadTimeouts ?? []).filter((t) => again.has(t.file)),
  };
}

/**
 * `text` without the lines about `files` - vitest's FAIL header for each and
 * its module-fetch timeout, both of which carry the file's path. Exported for
 * the test.
 */
export function withoutAnswered(text, files = []) {
  if (!files.length || !text) return text;
  const names = files.flatMap((f) => [f, resolve(REPO_ROOT, f)]);
  return String(text)
    .split("\n")
    .filter((l) => !names.some((n) => l.includes(n)))
    .join("\n");
}

/** Move the lone run's chunks in beside the first run's, over the files' own. */
export function joinStaged(into, from, drop = []) {
  mkdirSync(into, { recursive: true });
  for (const f of drop) for (const x of [f, `${f}.meta.json`]) rmSync(join(into, x), { force: true });
  if (!existsSync(from)) return;
  for (const f of readdirSync(from)) {
    if (f === "reuse.json" || /^reused-\d+\.json$/.test(f)) continue;
    renameSync(join(from, f), join(into, f));
  }
  rmSync(from, { recursive: true, force: true });
}

function measureLoadTimeoutsAgain(run, { incremental }) {
  const plan = loadTimeoutRetryPlan(run, { incremental });
  if (!plan) return { run, retry: null };
  const said = plan.files.map((f) => `${f} (${sizeOf(join(REPO_ROOT, f))})`);
  const first = run.loadTimeouts.find((t) => t.file === plan.files[0]);
  process.stdout.write(
    `· ${said.join(", ")} did not load: vitest's module fetch timed out (${first.message}) - a fixed 60 s limit in vitest's worker, not a behaviour change; ` +
      (plan.how === "alone"
        ? `measuring ${plan.files.length === 1 ? "it" : "them"} again alone, merged with the coverage the other ${plan.reuse.length} spec file(s) just wrote\n`
        : `measuring every spec file once more (${plan.why})\n`)
  );
  let merged;
  if (plan.how === "alone") {
    const lone = measureOnce(plan.files, null, { reuse: plan.reuse, tag: "-retry", say: `· measuring ${plan.files.length} timed-out spec file(s) alone under istanbul, with the coverage of the other ${plan.reuse.length} from the run just made\n` });
    joinStaged(run.staged, lone.staged, plan.drop);
    merged = mergeLoneRun(run, lone, plan.files);
  } else {
    merged = measureOnce(null, null);
  }
  const again = (merged.loadTimeouts ?? []).map((t) => t.file);
  const retry = {
    how: plan.how,
    ...(plan.why ? { why: plan.why } : {}),
    files: plan.files.map((f) => ({ file: f, size: sizeOf(join(REPO_ROOT, f)), message: run.loadTimeouts.find((t) => t.file === f)?.message ?? null, loadedOnRetry: !again.includes(f) })),
    killSwitch: `${LOAD_TIMEOUT_RETRY_ENV}=off`,
  };
  process.stdout.write(
    again.length
      ? `· ${again.join(", ")} timed out loading again ${plan.how === "alone" ? "alone" : "in a second full measurement"}\n`
      : `· ${plan.files.join(", ")} loaded ${plan.how === "alone" ? "alone" : "in the second full measurement"}: the measurement is the whole suite's\n`
  );
  return { run: merged, retry };
}

/**
 * The stage-6 verdict on a measurement a spec never loaded into (D90): what it
 * is, in the last lines the walk quotes - the module-fetch timeout on a named
 * file of a named size, not a behaviour change and not an overstatement.
 */
export function loadTimeoutVerdict(loadTimeouts, retry = null) {
  const how = retry?.how === "full" ? "in a second full measurement" : retry ? "when measured again alone" : "";
  const files = loadTimeouts.map((t) => `${t.file} (${sizeOf(join(REPO_ROOT, t.file))})`).join(", ");
  return (
    `\u2717 stage 6: the vitest module-fetch timeout on ${files}, not a behaviour change - vitest's worker gives the fetch of a spec a fixed 60 s` +
    `${how ? `, and it ran out ${how}` : ""}: ${loadTimeouts[0].message}`
  );
}

/** Where each spec file's coverage is kept between walks, and the store's own index. */
const CHUNK_STORE = join(OUT_DIR, "coverage-chunks");
const STORE_JSON = join(CHUNK_STORE, "store.json");

function readChunkStore() {
  try {
    return JSON.parse(readFileSync(STORE_JSON, "utf8"));
  } catch {
    return null;
  }
}

function writeChunkStore(doc) {
  mkdirSync(CHUNK_STORE, { recursive: true });
  writeFileSync(`${STORE_JSON}.${process.pid}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(`${STORE_JSON}.${process.pid}.tmp`, STORE_JSON);
}

/** vitest's JSON statuses, counted the way its summary line counts them. */
export function countsOf(assertions = []) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const t of assertions) {
    const s = t?.status === "passed" ? "passed" : t?.status === "failed" ? "failed" : t?.status === "todo" ? "todo" : "skipped";
    counts[s] += 1;
    counts.total += 1;
  }
  return counts;
}

export function sumCounts(list = []) {
  const out = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const c of list) for (const k of Object.keys(out)) out[k] += Number(c?.[k]) || 0;
  return out;
}

/**
 * WHY THE STORE CANNOT BE BUILT ON, or null. Everything a merge would read is
 * checked before anything is run, so a store that lost a chunk, was left by a
 * run that was not isolated, or sits beside a coverage-final.json that is not
 * the one it wrote, is measured over in full rather than merged into.
 */
export function storeRefusal(store, { dir = CHUNK_STORE, final = join(STAGE5_COVERAGE, "coverage-final.json") } = {}) {
  if (!store) return "there is no per-file coverage from an earlier measurement";
  if (store.version !== 1) return "the per-file coverage store is from another version of this tool";
  if (store.incremental !== true) return `the last measurement could not be kept per file (${store.why ?? "no reason recorded"})`;
  let finalHash;
  try {
    finalHash = sha256(readFileSync(final));
  } catch {
    return `${relative(REPO_ROOT, final)} is missing or unreadable`;
  }
  if (finalHash !== store.coverageFinal) return `${relative(REPO_ROOT, final)} is not the report the last measurement wrote`;
  for (const [spec, entry] of Object.entries(store.chunks ?? {})) {
    if (entry === null) continue;
    try {
      if (sha256(readFileSync(join(dir, entry.file))) !== entry.sha) return `the kept coverage of ${spec} does not match its hash`;
    } catch {
      return `the kept coverage of ${spec} is missing`;
    }
  }
  const missing = Object.keys(store.specs ?? {}).filter((s) => !(s in (store.chunks ?? {})));
  if (missing.length) return `${missing.length} spec file(s) have no kept coverage (${missing.slice(0, 3).join(", ")})`;
  return null;
}

/**
 * One vitest run under istanbul: every spec file (`files` null), or `files`
 * with `store`'s chunks for the rest handed to the provider (coveragechunks.mjs).
 * Never exits: returns what happened, and the caller decides.
 *
 * D91 (measureheap.mjs): vitest's main process is started with the heap the
 * spec files it loads will need, when that is near node's default limit, and a
 * run that dies of the heap anyway is run once more at the most there is.
 */
function measureOnce(files, store, opts = {}) {
  const node = targetNode({ root: REPO_ROOT });
  const env = targetNodeEnv({ ...buildEnv(), CHARPILOT_SPECS: relative(REPO_ROOT, SPECS_DIR) }, node);
  const defaultMB = measureHeapOn() ? targetHeapLimitMB(node.node, env) : null;
  // A run handed the other files' kept coverage (a partial measurement, or
  // D90's lone re-run) builds the whole suite's report: every chunk it is
  // handed is a string in its heap until written. Measured: the lone re-run of
  // two spec files, 52 MB, with 416 chunks (911 MB of JSON) handed to it, died
  // of the heap at 2096 MB. So it is sized as the whole suite.
  const handed = Boolean(opts.reuse || (files && store));
  const all = existsSync(SPECS_DIR) ? readdirSync(SPECS_DIR).filter(isCorpusSpec).map((f) => relative(REPO_ROOT, join(SPECS_DIR, f))) : [];
  const specs = files && !handed ? files : all;
  const specBytes = specs.reduce((n, f) => {
    try {
      return n + statSync(resolve(REPO_ROOT, f)).size;
    } catch {
      return n;
    }
  }, 0);
  let heap = measureHeapPlan({ specBytes, defaultMB, available: process.availableMemory() });
  if (heap) {
    process.stdout.write(
      `· vitest's main process gets a ${heap.mb} MB heap (node's default here is ${heap.defaultMB} MB): ` +
        (handed
          ? `it builds the whole suite's report from the kept coverage of ${specs.length} spec file(s), ${heap.specMB} MB of spec, about ${heap.needMB} MB`
          : `the ${specs.length} spec file(s) it loads are ${heap.specMB} MB, and it keeps every one's transform for the whole run, about ${heap.needMB} MB`) +
        ` (${MEASURE_HEAP_ENV}=off keeps the default)\n`
    );
  }
  let run = measureOnceAt(files, store, opts, heap);
  const oom = run.signal ? oomLine(run.stderr) : null;
  const again = oom ? heapRetryMB({ atMB: heap?.mb ?? defaultMB ?? 0, available: process.availableMemory() }) : null;
  if (again) {
    process.stdout.write(
      `· vitest's main process ran out of heap at ${heap?.mb ?? defaultMB} MB (${oom}) - measuring once more with a ${again} MB heap (${MEASURE_HEAP_ENV}=off measures once)\n`
    );
    heap = { mb: again, defaultMB, needMB: heapNeedMB(specBytes), specMB: Math.round(specBytes / 1048576), how: "retry", after: oom };
    run = measureOnceAt(files, store, opts, heap);
  }
  return { ...run, heap: heap ?? (defaultMB ? { mb: null, defaultMB } : null) };
}

function measureOnceAt(files, store, { reuse = null, tag = "", say = null } = {}, heap = null) {
  const ran = files ?? [];
  process.stdout.write(
    say ??
      (files
        ? `· measuring ${files.length} changed spec file(s) of ${SPECS_COUNT} in ${SPECS_RELATIVE} under istanbul, with the kept coverage of the other ${SPECS_COUNT - files.length}\n`
        : `· measuring ${SPECS_COUNT} spec file(s) in ${SPECS_RELATIVE} under istanbul\n`)
  );
  // F2.2: a second, machine-readable reporter, so a failing suite can name
  // the ROW each failing test was emitted from rather than the emitted file
  // (which `emit` regenerates away).
  const jsonOut = join(OUT_DIR, `.coverage-vitest.${process.pid}.json`);
  // And the red the json reporter cannot show: an unhandled error leaves every
  // test `passed` there and exits 1 (vitestred.mjs). Same reporter as cigate's.
  const errsOut = join(OUT_DIR, `.coverage-unhandled.${process.pid}.json`);
  const unhandled = withUnhandledReporter(errsOut);
  // THE CHUNKS THIS RUN WRITES, into a directory of its own until they are kept.
  // A run killed before it kept its chunks left its own directory behind; one
  // measurement runs at a time, so every leftover is swept with this one's.
  // A D90 re-run (`tag`) keeps the run it completes: its chunks are joined to it.
  const staged = join(CHUNK_STORE, `.run-${process.pid}${tag}`);
  if (existsSync(CHUNK_STORE)) {
    for (const f of readdirSync(CHUNK_STORE)) {
      if (f.startsWith(".run-") && (!tag || f === `.run-${process.pid}${tag}`)) rmSync(join(CHUNK_STORE, f), { recursive: true, force: true });
    }
  }
  const chunkEnv = incrementalOn() ? { [CHUNKS_OUT_ENV]: staged } : {};
  if (reuse) {
    mkdirSync(staged, { recursive: true });
    const list = join(staged, "reuse.json");
    writeFileSync(list, JSON.stringify({ chunks: reuse }));
    chunkEnv[REUSE_ENV] = list;
  } else if (files && store) {
    const reuse = Object.entries(store.chunks)
      .filter(([spec, entry]) => entry !== null && !files.includes(spec))
      .map(([, entry]) => join(CHUNK_STORE, entry.file));
    mkdirSync(staged, { recursive: true });
    const list = join(staged, "reuse.json");
    writeFileSync(list, JSON.stringify({ chunks: reuse }));
    chunkEnv[REUSE_ENV] = list;
  }
  // D77: the limit is the corpus's, not a fixed 30 minutes (suitelimit.mjs).
  const limitMs = suiteTimeoutMs(files ? files.length : SPECS_COUNT);
  // D91: the heap flag goes to vitest's main process only - vitest hands its
  // workers an execArgv of its own, and NODE_OPTIONS is left as it was.
  const heapArgs = heap?.mb ? [`--max-old-space-size=${heap.mb}`] : [];
  const run = spawnSync(targetNode({ root: REPO_ROOT }).node, [...heapArgs, VITEST_BIN, "run", "--config", CONFIG, "--reporter=default", "--reporter=json", ...unhandled.args, `--outputFile.json=${jsonOut}`, ...ran.map((f) => resolve(REPO_ROOT, f))], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // The directory `--specs` names is what vitest must actually run. Passing
    // it through is what makes the flag mean something: before this it only
    // fed the file count printed above, while the config ran a hard-wired
    // path, and the two silently disagreed.
    env: targetNodeEnv({ ...buildEnv(), ...unhandled.env, ...chunkEnv, CHARPILOT_SPECS: relative(REPO_ROOT, SPECS_DIR) }, targetNode({ root: REPO_ROOT })),
    timeout: limitMs,
    // NOT node's 1 MB default. qode-ptp-ms, mocked, September 2026: a
    // 490-row recording's default reporter output passed 1 MB, node killed
    // vitest with ENOBUFS, no coverage report was written, and the walk
    // stopped at `measure` with "vitest could not be started" - repair,
    // ruling and report never ran. cigate.mjs spawns the same suite at 64 MB;
    // this reads more (every spec's console), so it gets the larger bound.
    maxBuffer: 256 * 1024 * 1024,
  });
  // D91: vitest ended by a signal keeps its whole stderr, which is where V8's
  // FATAL line and the native stack are, for the verdict to point at.
  let stderrAt = null;
  if (run.signal) {
    try {
      stderrAt = join(OUT_DIR, "coverage-vitest-stderr.log");
      writeFileSync(stderrAt, run.stderr ?? "");
      stderrAt = relative(REPO_ROOT, stderrAt);
    } catch {
      stderrAt = null;
    }
  }
  // The per-file results, read BEFORE failingTestsFrom consumes the report.
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(jsonOut, "utf8"));
  } catch {
    doc = null;
  }
  const perFile = {};
  // The files that did not load at all, and of them the ones whose module
  // fetch timed out (D90, vitestred.mjs): keepStore must not take either for a
  // file that loaded no instrumented source.
  const unloaded = [];
  for (const file of doc?.testResults ?? []) {
    perFile[relative(REPO_ROOT, String(file.name ?? ""))] = countsOf(file.assertionResults ?? []);
    if (failedToLoad(file) && !(file.assertionResults ?? []).length) unloaded.push(relative(REPO_ROOT, String(file.name ?? "")));
  }
  const loadTimeouts = loadTimeoutsIn(doc, REPO_ROOT);
  const summary = suiteTestCounts(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
  // A non-zero exit is EXPECTED and not fatal: these specs record throws as
  // observations. What is fatal is no coverage report, because then there is
  // nothing to measure and a 0% would be indistinguishable from a real 0%.
  const failingTests = [...failingTestsFrom(jsonOut), ...unhandledTestsFrom(errsOut, run.status)];
  // Merged with the kept counts, when this ran only the changed files; the
  // summary line otherwise, exactly as before.
  const tests = files && store
    ? sumCounts([...Object.entries(store.counts).filter(([spec]) => !files.includes(spec)).map(([, c]) => c), ...Object.values(perFile)])
    : summary;
  return { status: run.status, signal: run.signal, error: run.error, stdout: run.stdout, stderr: run.stderr, stderrAt, failingTests, perFile, summary, tests, staged, ran, limitMs, specs: files ? files.length : SPECS_COUNT, unloaded, loadTimeouts };
}

/** The chunks a run wrote, by spec file: `{ spec: [meta] }`, from their sidecars. */
function stagedChunks(staged) {
  const bySpec = {};
  const all = [];
  if (!existsSync(staged)) return { bySpec, all };
  for (const f of readdirSync(staged).filter((n) => n.endsWith(".meta.json"))) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(staged, f), "utf8"));
    } catch {
      continue;
    }
    meta.file = f.replace(/\.meta\.json$/, "");
    all.push(meta);
    for (const t of meta.testFiles ?? []) (bySpec[relative(REPO_ROOT, resolve(REPO_ROOT, t))] ??= []).push(meta);
  }
  return { bySpec, all };
}

/**
 * WHY A PARTIAL MEASUREMENT CANNOT STAND, or null.
 *
 * It stands only when it is the full measurement's equal by construction:
 * every changed file ran on its own (one chunk, one file, isolated), and the
 * suite passed - a red file under a partial run is measured again with the
 * others, so the verdict on a failing suite is never a partial one.
 */
export function partialRefusal(run, files, chunks = stagedChunks(run?.staged ?? "")) {
  if (!run || run.error) return `vitest could not be started${run?.error ? ` (${run.error.message})` : ""}`;
  if (run.status !== 0 || run.failingTests.length) {
    // D64: vitest's first error line leads, then its last lines.
    const heard = vitestSaid(run.stderr, run.stdout);
    const said = [...heard.first.slice(0, 1), ...heard.tail].join(" | ");
    return `the changed files did not pass (vitest exited ${run.status}${run.failingTests.length ? `, ${run.failingTests.length} failing test(s)` : ""}: ${said.slice(0, 400)})`;
  }
  if (!existsSync(join(STAGE5_COVERAGE, "coverage-final.json"))) return "vitest wrote no coverage report";
  if (chunks.all.some((m) => (m.testFiles ?? []).length !== 1 || m.isolate !== true)) return "a batch held more than one spec file, or the run was not isolated";
  const lost = files.filter((f) => !(f in run.perFile));
  if (lost.length) return `${lost.length} changed file(s) never reported a result (${lost.slice(0, 3).join(", ")})`;
  return null;
}

/**
 * KEEP THIS MEASUREMENT PER FILE for the next walk to build on - or say why it
 * cannot be, and leave a store that makes the next walk measure in full.
 */
function keepStore({ run, plan, store, disk, context }) {
  const { bySpec, all } = stagedChunks(run.staged);
  const final = join(STAGE5_COVERAGE, "coverage-final.json");
  const specs = disk;
  const refuse = (why) => {
    writeChunkStore({ version: 1, incremental: false, why, at: new Date().toISOString() });
    rmSync(run.staged, { recursive: true, force: true });
    return { why };
  };
  if (run.error || !existsSync(final)) return refuse("vitest wrote no coverage report");
  if (all.some((m) => m.isolate !== true)) return refuse("the run was not isolated, so no spec file's coverage is its own");
  if (all.some((m) => (m.testFiles ?? []).length !== 1)) return refuse("a worker batch held more than one spec file");
  // The summary line and the JSON report must count the same suite, or the
  // counts a later merge adds up are not the counts a full run would print.
  if (plan.scope === "full" && run.summary && JSON.stringify(sumCounts(Object.values(run.perFile))) !== JSON.stringify(sumCounts([run.summary]))) {
    return refuse(`vitest's summary (${JSON.stringify(run.summary)}) and its JSON report disagree about the test counts`);
  }
  const chunks = {};
  const counts = {};
  for (const spec of Object.keys(specs)) {
    const ranNow = plan.scope === "full" || plan.files.includes(spec);
    if (!ranNow) {
      chunks[spec] = store.chunks[spec] ?? null;
      counts[spec] = store.counts[spec];
      continue;
    }
    if (!(spec in run.perFile)) return refuse(`${spec} reported no result, so its coverage cannot be told from a crash`);
    // D90: a file that did not load ran nothing. Its missing chunk is not "a
    // file that loaded no instrumented source", which is what null would say.
    if ((run.unloaded ?? []).includes(spec)) return refuse(`${spec} did not load, so it has no coverage of its own to keep`);
    const metas = bySpec[spec] ?? [];
    counts[spec] = run.perFile[spec];
    // No chunk from a file that ran is a file that loaded no instrumented
    // source: it adds nothing to the report, and a merge that adds nothing
    // for it is exact.
    if (!metas.length) {
      chunks[spec] = null;
      continue;
    }
    const name = `${sha256(spec).slice(0, 16)}-${specs[spec].slice(0, 12)}.json.gz`;
    renameSync(join(run.staged, metas[0].file), join(CHUNK_STORE, name));
    chunks[spec] = { file: name, sha: sha256(readFileSync(join(CHUNK_STORE, name))) };
  }
  const green = run.status === 0 && !run.failingTests.length;
  const manifest = { hashes: specs, digest: digestOfHashes(specs) };
  writeChunkStore({
    version: 1,
    incremental: true,
    ...nextLedger({ prior: store, plan, manifest, context, green }),
    chunks,
    counts,
    coverageFinal: sha256(readFileSync(final)),
  });
  // What no entry names any more: the chunks of files that changed or left.
  const named = new Set(Object.values(chunks).filter(Boolean).map((c) => c.file));
  for (const f of readdirSync(CHUNK_STORE)) {
    if (f.endsWith(".json.gz") && !named.has(f)) rmSync(join(CHUNK_STORE, f), { force: true });
  }
  rmSync(run.staged, { recursive: true, force: true });
  return { why: null };
}

/**
 * D64: WHAT VITEST SAID, ITS FIRST ERROR FIRST.
 *
 * qode-itl-be, September 2026: a full re-measure stopped on
 *   coverage.mjs exited 1 — ✗ stage 6: the suite under measurement did not pass (vitest exited 1)
 * and nothing else. The real error was vitest's
 *   Error: Failed to resolve entry for package "@qode/contract"
 * printed near the top of its output; the one place this tool quoted vitest
 * at all was the last 2000 characters of stderr, which on that run was the
 * code frame of an istanbul-instrumented source file, and the walk's own line
 * is the last four lines of this tool's stderr, which were this tool's own
 * paragraph. So the reader had a tail of noise or no quote, and repair was
 * never reached.
 *
 * So the lines that ARE errors - a FAIL header, an `Error:` / `SomethingError:`
 * line, vitest's "Failed to ..." - are taken first, in the order vitest printed
 * them, each once, and a short tail after them for context. ANSI colour is
 * stripped and every line is cut to `width`, so a code frame or a minified
 * line cannot crowd the error out.
 */
const VITEST_ERROR_LINE = /^(?:FAIL\b|×\s|Error\b|[A-Z][A-Za-z]*Error\b|Failed to\b|Cannot find (?:module|package)\b|Unhandled (?:Rejection|Error)\b)/;
// vitest's own report of what went wrong starts under one of these rules. The
// suite's console comes BEFORE them, and on itl-be it was full of the
// service's own "Error: boom" log lines, so once a rule is there only what
// follows it is read.
const VITEST_SECTION = /^⎯+\s*(?:Failed Suites?|Failed Tests?|Unhandled (?:Errors?|Rejections?)|Startup Error)\b/;
export function vitestSaid(stderr = "", stdout = "", { first = 5, last = 3, width = 300 } = {}) {
  // eslint-disable-next-line no-control-regex
  const split = (t) => String(t ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const streams = [split(stderr), split(stdout)];
  const lines = streams.flat();
  const cut = (l) => (l.length > width ? `${l.slice(0, width)}…` : l);
  const errors = [];
  // D91: V8'S FATAL LINE FIRST, wherever it is. A main process that runs out
  // of heap prints "FATAL ERROR: Reached heap limit ... JavaScript heap out of
  // memory" and a native stack on stderr and dies by SIGABRT, with no vitest
  // rule and no `Error` line after it - so the quote read only stdout's last
  // line, a passing file, and the one line that said why was dropped.
  for (const l of lines) if (V8_OOM.test(l) && !errors.includes(cut(l))) errors.push(cut(l));
  // Each stream from its first rule on; a stream with no rule is only read
  // when neither has one.
  const at = streams.map((s) => s.findIndex((l) => VITEST_SECTION.test(l)));
  const read = at.some((i) => i !== -1) ? streams.flatMap((s, k) => (at[k] === -1 ? [] : s.slice(at[k]))) : lines;
  for (const l of read) {
    if (!VITEST_ERROR_LINE.test(l)) continue;
    const c = cut(l);
    if (!errors.includes(c)) errors.push(c);
    if (errors.length >= first) break;
  }
  return { first: errors, tail: lines.slice(-last).map(cut) };
}
/**
 * The same, as the lines this tool prints: the tail and every error line for
 * the log, then `summary` and the first two error lines LAST and short, because
 * the walk quotes the last four lines of stderr (steps/preflight.mjs tail) and
 * keeps the first 600 characters of them.
 */
export function vitestSaidLines(said, summary) {
  const out = [];
  if (said.tail.length) out.push("  vitest's last line(s):", ...said.tail.map((l) => `    ${l}`));
  if (said.first.length) out.push("  vitest's first error line(s):", ...said.first.map((l) => `    ${l}`));
  // The last four lines, which are all the walk keeps: a short rule, the
  // verdict, and the first two things vitest said were wrong - each bounded,
  // so the 600 characters reach the second.
  const short = (l) => (l.length > 150 ? `${l.slice(0, 150)}…` : l);
  const lead = [...said.first, ...said.tail.slice(-1)].slice(0, 2);
  out.push("  ⎯", summary, ...lead.map((l) => `  ${short(l)}`));
  return `${out.join("\n")}\n`;
}

/**
 * The failing tests of one vitest json report, each with the row it was emitted
 * from: an emitted test is titled `<row id> - <what it asserts>`. Never throws;
 * the report file is read once and removed.
 */
export function failingTestsFrom(path) {
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    doc = null;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    /* scratch */
  }
  const out = [];
  for (const file of doc?.testResults ?? []) {
    for (const t of file?.assertionResults ?? []) {
      if (t?.status !== "failed") continue;
      const title = String(t.title ?? "");
      out.push({
        file: relative(REPO_ROOT, String(file.name ?? "")) || null,
        title,
        rowId: title.includes(" - ") ? title.split(" - ")[0].trim() : null,
        message: String((t.failureMessages ?? [])[0] ?? "").split("\n")[0].slice(0, 300),
      });
    }
  }
  return out;
}

/**
 * The run's unhandled errors, in `failingTests`' shape, so a suite that is red
 * only on one (every assertion passed, vitest exited 1) still names the row it
 * came from - or, attributed to no test, still names the error. Never throws.
 */
export function unhandledTestsFrom(path, status = 1) {
  // A run that exited 0 is green even with errors reported: the repo set
  // dangerouslyIgnoreUnhandledErrors (vitestred.mjs unhandledThatCounts).
  const { attributed, unattributed } = classifyUnhandled(unhandledThatCounts(readUnhandled(path) ?? [], status), REPO_ROOT);
  return [
    ...attributed.map((u) => ({ file: u.file, title: u.title, rowId: u.id, unhandled: true, message: u.message })),
    ...unattributed.map((u) => ({ file: u.file, title: null, rowId: null, unhandled: true, message: u.message })),
  ];
}

// `measureArms` and `claimedSides` live in armjoin.mjs. Stage 4 now asks the
// same branch->arm question at record time, and a second copy of either would
// be a second thing to keep true.

/**
 * READ THROUGH THE ONE READER, because a second parser is the bug.
 *
 * `loadProposals`' own docstring says why two readers is the defect: they were
 * "identical by luck rather than by construction", and an answer one stage
 * accepts and another drops is this pipeline's most expensive failure mode.
 * This was the second copy and it failed in three ways the shared one does not.
 * It called `readdirSync` with no `existsSync`, so measuring a repo whose stage
 * 3 has not run yet died on ENOENT instead of reporting no claims. It parsed
 * each file bare, so one unreadable proposal ended the measurement with a
 * SyntaxError naming no file — and the file stays on disk, so the next round
 * died the same way. And `doc.proposals ?? doc` is not iterable when
 * `proposals` is an object, which is an ordinary thing for an agent to write.
 *
 * `doc.proposals ?? doc` also accepted a file that is a bare ARRAY of rows.
 * Nothing else in the pipeline does: validate.mjs reads `doc.proposals`, so a
 * file in that shape has already failed stage 3 and holds claims no recording
 * could contain. The shared reader reports it as malformed, which is the
 * honest answer, and this stage says so out loud rather than counting claims
 * from a document no other stage can read. The only field this copy added was
 * `sourceFile`, which nothing reads; the shared reader's `_file` is the same
 * value under the name every other stage already uses.
 */
function loadProposals() {
  const { proposals, malformed } = loadProposalCorpus(PROPOSALS_DIR);
  // NEVER SILENTLY. A file that will not parse is claims this measurement
  // cannot ask about, and an unasked claim reads exactly like a verified one in
  // the totals below.
  for (const m of malformed) {
    process.stderr.write(
      `· coverage: ${m.file} is not a readable proposal document (${m.message}) — ` +
        "its claims are not measured, and this stage's claim counts are short by them\n"
    );
  }
  return proposals;
}

/* ------------------------------------------------------------------------ *
 * D64 — A SIDE THE RECORDER REFUSED TO EXERCISE IS UNCOVERED, NOT ABSENT.
 *
 * THE DISTINCTION, AND IT IS THE WHOLE OF IT:
 *
 *   dead export      the code is NOT live    -> out of the denominator, which
 *                                               is `deadExportFunctionIds` and
 *                                               `liveCodeTotals` above, and is
 *                                               NOT this.
 *   blocked egress   the code IS live        -> STAYS in the denominator,
 *                                               stays uncovered, and carries
 *                                               the recorder's own reason.
 *
 * A side that left the denominator because nobody exercised it would raise the
 * reported rate by hiding live code, which is the exact fraud the corrected
 * denominator exists to prevent. So NOTHING here touches `sides`,
 * `hitByEither`, `deadSides` or anything `liveCodeTotals` reads. It annotates
 * rows that are already in `stillUncovered` and counts them, and the count is
 * reported beside the rate rather than inside it.
 *
 * MEASURED, run `20260919T142723Z` round 2:
 *
 *   verify-on-write: parseAddressesForJd-113-default-arg-0 produced no row —
 *                    skipped: blocked egress: prisma.apiKey
 *
 * `parseAddressesForJd` reaches a real database, so in `CHARPILOT_MODE=mocked`
 * the recorder refuses to invoke it and its five sides have no deliverable
 * answer in this mode. They came back into the brief in every one of the eight
 * rounds regardless, and in round 4 two workers answered the same unanswerable
 * thing and both rows were quarantined as duplicates. Five of that run's
 * sixteen remaining sides are these.
 *
 * WHAT IT IS READ OUT OF, and why it cannot outlive its reason. The source is
 * `skipped[]` in the behaviour artifact this measurement is already reading —
 * record.mjs's own bytes, written this round. Nothing is stored anywhere: the
 * next measurement re-derives the whole set from the next recording, so the
 * day a double for `prisma.apiKey` lands and the recorder invokes the
 * function, the skip is gone from the artifact, the annotation is gone from
 * these rows, and `derive` deals the sides again without anybody clearing
 * anything. Same property, same reason, as D51's quarantine: it IS the
 * measurement rather than a note about one.
 *
 * WHICH SKIPS COUNT. Only the ones `skipDiagnosis` calls `toolset` — the
 * recorder stating a limit of its own, which no input can fix. A
 * `skipped-proposal` reason names a field of a submitted document and IS
 * answerable, so it stays open; an unclassified reason is `undecided` and also
 * stays open, which is the direction this has to fail in. Sending an
 * answerable side here would be coverage lost silently, and it would look
 * exactly like this on disk.
 * ------------------------------------------------------------------------ */

/**
 * Every function the recorder refused for a reason about ITSELF, from its own
 * `skipped[]` entries, keyed by `functionId`.
 *
 * `{ why, about, rule, proposal }` per function, where `why` is record.mjs's
 * sentence verbatim and is never paraphrased, and `rule` is the line of
 * record.mjs the classification was anchored to, so a reason that gets reworded
 * there stops matching rather than getting quietly reclassified.
 *
 * A skip whose id is not a proposal this run holds speaks for nothing: it is a
 * stale artifact's, or another target's, and the guard is the same one
 * `steps/derive.mjs`'s probe applies for the same reason. First entry wins, so
 * the reported reason is the first one the recorder wrote about that function
 * rather than the last file read.
 */
/**
 * FIX PLAN 1, F1.2 — THE JOIN IS REPLACED WHOLE OR NOT AT ALL, AND THE ONE IT
 * REPLACES IS KEPT.
 *
 * The run's last walk (`workflow.mjs --bank-only`) re-measures after the round
 * cap. A write that dies half way would leave a truncated `coverage.json`, and
 * `report` reads nothing else. So the document goes to a temp file beside it
 * and is renamed into place, and the previous join is copied to
 * `coverage.prev.json` first: a person comparing the last two measurements, or
 * a pack that must not deliver a worse one, has both.
 */
/**
 * HOW MANY TESTS OF THE MEASURED SUITE PASSED, from vitest's own summary line
 * (` Tests  3 passed | 2 skipped | 1 todo (6)`). Fix plan 1, F1.7(a):
 * finish.py adds a bootstrapped vitest to package.json only for a suite with a
 * PASSING test, and `suitePassed` alone cannot say that - a suite whose every
 * test is `it.skip` exits 0 too. Null when there is no summary line, which a
 * reader must treat as "not known", never as zero failures.
 */
export function suiteTestCounts(text) {
  // eslint-disable-next-line no-control-regex
  const plain = String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split("\n").reverse().find((l) => /^\s*Tests\s+.*\(\d+\)\s*$/.test(l));
  if (!line) return null;
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: Number(line.match(/\((\d+)\)\s*$/)[1]) };
  for (const [, n, what] of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) counts[what] = Number(n);
  return counts;
}

export function writeJoin(path, doc) {
  if (existsSync(path)) copyFileSync(path, path.replace(/\.json$/, ".prev.json"));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
}

export function refusedByRecorder(behaviour, proposals) {
  const byId = new Map((proposals ?? []).map((p) => [p.id, p]));
  const refused = withAimed(new Map());
  for (const s of behaviour?.skipped ?? []) {
    const p = byId.get(s?.id);
    if (!p?.functionId) continue;
    const diagnosis = skipDiagnosis(s);
    if (diagnosis.about !== SKIP_ABOUT.TOOLSET) continue;
    const verdict = { why: diagnosis.reason, about: diagnosis.about, rule: diagnosis.rule, proposal: p.id };
    aim(refused, p.reaches, verdict);
    if (refused.has(p.functionId)) continue;
    refused.set(p.functionId, verdict);
  }
  return refused;
}

/**
 * D68: THE SKIPS THE RECORDER SAID ARE THE PROPOSAL'S, keyed like
 * `refusedByRecorder`'s, so an open side says what its row has to correct
 * instead of "no reason is written for it" - the recorder wrote one. A stale
 * functionId is the case that needed it: open, and dealt again with the
 * sentence naming the id the scan lists. Read by `markAsked`; it rules nothing
 * and counts nothing.
 */
export function askedOfProposal(behaviour, proposals) {
  const byId = new Map((proposals ?? []).map((p) => [p.id, p]));
  const asked = withAimed(new Map());
  for (const s of behaviour?.skipped ?? []) {
    const p = byId.get(s?.id);
    if (!p?.functionId) continue;
    const diagnosis = skipDiagnosis(s);
    if (diagnosis.about !== SKIP_ABOUT.PROPOSAL) continue;
    const verdict = { why: diagnosis.reason, about: diagnosis.about, rule: diagnosis.rule, proposal: p.id };
    aim(asked, p.reaches, verdict);
    if (!asked.has(p.functionId)) asked.set(p.functionId, verdict);
  }
  return asked;
}

/** D68: write a proposal's skip onto the uncovered sides it speaks for that carry no verdict yet, as `askable`. */
export function markAsked(stillUncovered, asked) {
  let n = 0;
  for (const row of stillUncovered) {
    if (row.undeliverable || row.askable) continue;
    const v = verdictFor(asked, row);
    if (!v) continue;
    row.askable = { ...v, saidBy: "record.mjs" };
    n += 1;
  }
  return n;
}

/*
 * THE SIDES A ROW WAS AIMED AT (fix round 4, rule 3). Both verdict maps are
 * keyed by `functionId`, and a MODULE-SCOPE arm has none on its coverage row -
 * so image-forwarder's `blobService.ts#11:if:0 then`, whose only rows the
 * recorder refused (`entry kind module-import not supported yet`) or failed in
 * arrangement, was ruled `open`, "no reason is written for it", while the
 * recorder had written one. Each map also carries, per verdict, the arm and
 * sides its proposal's `reaches` named; a side that no function key answers
 * takes the verdict of a row aimed at it. `open` is left to a side nothing was
 * aimed at, or whose row timed out (neither map holds a timeout).
 */
function withAimed(map) {
  map.aimed = [];
  return map;
}

function aim(map, reaches, verdict) {
  if (!reaches || typeof reaches !== "object" || Array.isArray(reaches)) return;
  for (const [armId, value] of Object.entries(reaches)) map.aimed.push({ armId, value, verdict });
}

/** The verdict for one uncovered side: its function's, else that of a row aimed at this very side. */
function verdictFor(map, row) {
  if (row.functionId != null && map.has(row.functionId)) return map.get(row.functionId);
  for (const a of map.aimed ?? []) {
    if (a.armId !== row.armId) continue;
    try {
      if (claimedSides(a.value, [row.side]).includes(row.side)) return a.verdict;
    } catch {
      /* an unreadable claim aims at nothing */
    }
  }
  return null;
}

/**
 * THE FUNCTIONS WHOSE RECORDED ROW FAILED IN THE HARNESS, and whose failure
 * that is (harnessDiagnosis). Tool backlog: these sides were ruled \`open\` with
 * "no reason is written", though the recorder wrote one on the row. A function
 * the recorder REFUSED keeps that verdict; this only reads rows.
 */
export function failedInHarness(behaviour) {
  const out = withAimed(new Map());
  for (const r of behaviour?.rows ?? []) {
    if (!r?.harnessError || !r.functionId) continue;
    const d = harnessDiagnosis(r);
    const verdict = { why: d.reason, about: d.about, rule: d.rule, proposal: r.id };
    aim(out, r.reaches, verdict);
    if (!out.has(r.functionId)) out.set(r.functionId, verdict);
  }
  return out;
}

/**
 * Write a harness verdict onto the uncovered sides of its function that carry
 * no recorder verdict yet: a toolset one as \`undeliverable\` (pipeline_defect),
 * a proposal one as \`askable\` (open, with the recorder's reason). Mutates the
 * rows only.
 */
export function markHarnessFailed(stillUncovered, failed) {
  const n = { undeliverable: 0, askable: 0 };
  for (const row of stillUncovered) {
    if (row.undeliverable || row.askable) continue;
    const v = verdictFor(failed, row);
    if (!v) continue;
    if (v.about === SKIP_ABOUT.TOOLSET) {
      row.undeliverable = { ...v, saidBy: "record.mjs" };
      n.undeliverable += 1;
    } else {
      row.askable = { ...v, saidBy: "record.mjs" };
      n.askable += 1;
    }
  }
  return n;
}

/**
 * FIX PLAN 1, RULE 3 — EVERY UNCOVERED SIDE ENDS IN ONE RULING, AND IT IS
 * WRITTEN ON THE ROW.
 *
 *   unreachable      a dead export, or a BLOCKED.md entry naming this side
 *   pipeline_defect  the recorder refused its function, or a row aimed at
 *                    the side (`undeliverable`), or that row failed in the
 *                    harness for a reason of the tool's: a tool failed on it,
 *                    and the tool said why
 *   open             nothing covers it and nothing explains it, or the
 *                    proposal has something to declare (`askable`), or the
 *                    declaration written for it was refused by the ledger
 *                    (D56, `refused: true`, with the ledger's sentence)
 *
 * `succeeded` allows only the first. `open` and `pipeline_defect` make a run
 * `partial` - it still delivers, with every such side named. Nothing here
 * moves a side out of the denominator; `unreachable` is a reason, not an
 * exclusion. Returns the tally.
 */
export function markRulings(stillUncovered, blockedBySide = new Map(), salvagedBySide = new Map(), refusedSides = new Map()) {
  const tally = { unreachable: 0, pipeline_defect: 0, open: 0 };
  for (const row of stillUncovered) {
    const blocked = blockedBySide.get(`${row.armId}\u0000${row.side}`) ?? null;
    if (row.deadExport) {
      row.ruling = { state: "unreachable", why: "inside a dead export - no caller in src reaches it", saidBy: "deadcode.mjs" };
    } else if (blocked) {
      row.ruling = { state: "unreachable", why: `${blocked.category}: ${blocked.proof}`, saidBy: "BLOCKED.md" };
    } else if (row.undeliverable) {
      row.ruling = { state: "pipeline_defect", why: row.undeliverable.why ?? "the recorder refused this function", saidBy: row.undeliverable.saidBy ?? "record.mjs" };
    } else if (refusedSides.has(`${row.armId}\u0000${row.side}`)) {
      // D56: a declaration WAS written, and the ledger refused it. Still open -
      // a refused entry rules nothing - but "no reason is written" would be
      // false, and the refusal is what the next ask has to answer.
      const r = refusedSides.get(`${row.armId}\u0000${row.side}`);
      row.ruling = { state: "open", why: `the declaration written for it was refused - ${r.why}`, saidBy: r.saidBy ?? "ledger.mjs", refused: true };
    } else if (salvagedBySide.has(`${row.armId}\u0000${row.side}`)) {
      // PLAN 20 T2.3: open, and says why it stopped being asked.
      const s = salvagedBySide.get(`${row.armId}\u0000${row.side}`);
      row.ruling = { state: "open", why: `no progress after ${s.attempts} identical attempts: ${s.outcome}`, saidBy: "salvage", attempts: s.attempts };
    } else if (row.askable) {
      row.ruling = { state: "open", why: row.askable.why, saidBy: row.askable.saidBy ?? "record.mjs" };
    } else {
      row.ruling = { state: "open", why: "no row covers it and no reason is written for it", saidBy: "coverage.mjs" };
    }
    tally[row.ruling.state] += 1;
  }
  return tally;
}

/**
 * BLOCKED.md's well-formed entries, keyed `arm\0side`, for the sides this
 * measurement left uncovered. Never throws: no file, or one that cannot be
 * read, is no reasons - every side it would have explained is `open`.
 *
 * WELL-FORMED MEANS WHAT THE LEDGER ACCEPTS (step-1 fixup E): the ledger's own
 * parser, with the caller set from disk, and only the entries it found nothing
 * wrong with - required fields, a valid category and killer, the
 * `code-callers` rule, a proof that is a fact. A block with no category or
 * proof used to rule its side `unreachable` as "undefined: undefined", which a
 * success allows.
 */
/**
 * PLAN 20 T2.3: the sides derive salvaged, keyed `arm\0side`, from
 * out/salvaged.json. No file or an unreadable one is nothing salvaged.
 */
export function readSalvagedBySide(path = join(OUT_DIR, "salvaged.json")) {
  const out = new Map();
  if (!existsSync(path)) return out;
  try {
    for (const s of JSON.parse(readFileSync(path, "utf8")).sides ?? []) out.set(`${s.armId}\u0000${s.side}`, s);
  } catch {
    return new Map();
  }
  return out;
}

export function readBlockedBySide(stillUncovered, path = join(PROPOSALS_DIR, "BLOCKED.md"), { worklist = null, scan = null } = {}) {
  const out = new Map();
  if (!existsSync(path)) return out;
  let entries = [];
  try {
    ({ accepted: entries } = parseBlocked(readFileSync(path, "utf8")));
  } catch {
    return out;
  }
  // D59: THE ARM'S LABELS, NOT THE MEASUREMENT'S. This set was built from
  // `stillUncovered` alone, so once one side of a `side: then,else` entry was
  // covered the entry no longer split and its other side was ruled `open`
  // while derive and the ledger - reading worklist.json - counted it reasoned.
  // `armSideLabels` is the one definition all three read now; the rows are
  // merged in so a measurement with no work list on disk keeps what it had.
  const labels = armSideLabels({ worklist, scan, extra: stillUncovered });
  for (const e of entries) {
    for (const side of sidesOf(e.side, labels.get(e.arm) ?? new Set())) out.set(`${e.arm}\u0000${side}`, e);
  }
  return out;
}

/**
 * D56: BLOCKED.md's REFUSED entries, keyed `arm\0side`, with the ledger's own
 * sentence - the complement of `readBlockedBySide`, from the same parse. Never
 * throws: no file, or one that will not read, refuses nothing.
 */
export function readRefusedBySide(stillUncovered, path = join(PROPOSALS_DIR, "BLOCKED.md"), { worklist = null, scan = null } = {}) {
  if (!existsSync(path)) return new Map();
  // D59's one definition of an arm's labels, as readBlockedBySide reads it.
  const labels = armSideLabels({ worklist, scan, extra: stillUncovered });
  try {
    return refusedBySide(parseBlocked(readFileSync(path, "utf8")), labels);
  } catch {
    return new Map();
  }
}

/**
 * Mark the still-uncovered sides whose function the recorder refused, and say
 * how many there were.
 *
 * MUTATES THE ROWS AND NOTHING ELSE. The rows are already in `stillUncovered`
 * and they stay there; the totals this returns into are reported beside the
 * rate and are never subtracted from it.
 */
export function markUndeliverable(stillUncovered, refused) {
  let n = 0;
  for (const row of stillUncovered) {
    const verdict = verdictFor(refused, row);
    if (!verdict) continue;
    // NAMED `undeliverable`, never `dead` and never `excluded`: this side is
    // live, it is uncovered, and it is counted. What is missing is an
    // exercise of it, and the recorder has already said why there is not one.
    row.undeliverable = { ...verdict, saidBy: "record.mjs" };
    n += 1;
  }
  return n;
}

/**
 * The statement units, so this stage's arm index holds the same set stage 3 was
 * allowed to cite.
 *
 * `worklist.items` is the only producer of a `#NN:stmt:N` id, exactly as in
 * `annotateClaims` - and absent is TOLERATED rather than fatal, because a
 * measurement must not fail on a missing brief. What must not happen is the
 * absence being reported as the arm's, which is why `whyUnjoined` below says so
 * instead of falling through to "not in scan".
 */
function loadWorklistItems() {
  try {
    return JSON.parse(readFileSync(WORKLIST_JSON, "utf8")).items ?? null;
  } catch {
    return null;
  }
}

/**
 * Why this armId is not in the position join - the REAL reason, not the first
 * one that fits.
 *
 * The join holds one entry per arm istanbul instruments, and nothing else. Four
 * different situations therefore reach a missing key, and only ONE of them is
 * the missing arm id the old message named:
 *
 *   1. a non-branch UNIT (function-entry, statement, catch) that the scan does
 *      carry. Permanent, structural, nothing to repair - `nonBranchReason`.
 *   2. a `:stmt:` id with no worklist to check it against. Still not a branch,
 *      and its existence was NOT verified - say both, and claim neither.
 *   3. an arm the scan carries whose kind istanbul DOES instrument. Then the
 *      join should have held it and did not, which is a join defect: reporting
 *      it as a bad input would send a stage-3 report for a stage-6 bug.
 *   4. genuinely absent from scan.json - a stale id after a source edit, which
 *      `pilot:armids` names. This alone gets `arm not found in scan`, and the
 *      string is unchanged so a reader who has seen it before still recognises
 *      it.
 *
 * The string was worth this much care because a wrong reason is not a cosmetic
 * defect here: `validate.mjs` hard-errors on an id absent from scan.json, so
 * every id that reached case 1 had already been proved to exist - and the
 * message told the reader to go and look for it anyway.


 */
function whyUnjoined(armId, staticArms, worklistItems) {
  const known = staticArms.get(armId);
  if (known) {
    if (!known.istanbul) return nonBranchReason(known.kind);
    return (
      `${known.kind} is instrumented by istanbul and this arm is in scan.json, but the position join produced no record for it - ` +
      `that is a JOIN defect (stage 6), not a wrong input: re-run pilot:scan and pilot:armids, and report it if they are clean`
    );
  }
  const kind = armIdKind(armId);
  if (kind === "stmt" && !worklistItems) {
    return (
      "statement unit: out/worklist.json was unreadable, so whether this id still exists was NOT checked - " +
      "and a statement is not a branch either way, so istanbul's branch map could never hold it"
    );
  }
  if (isNonBranchKind(kind)) {
    // The id names a non-branch kind AND the scan does not carry it. Both facts
    // matter: the first says no oracle here could ever verdict it, the second
    // says the id is also stale. Reporting only one sends the reader to the
    // wrong repair.
    return `${nonBranchReason(kind)} - and no such unit is in scan.json, so this id is also stale: run pilot:armids`;
  }
  return "arm not found in scan";
}

/**
 * Row id -> why stage 5 quarantined it, or an empty map.
 *
 * Read rather than inferred: `out/quarantine.json` is written by
 * verify-generated.mjs, which is the only thing that knows a recorded value did
 * not reproduce. Absent means stage 5 has not verified this suite - and that is
 * NOT the same as "nothing is quarantined", so it is worth saying which.
 * Callers treat an empty map as "no quarantine information", which is why the
 * claim loop can only ever MOVE a claim from false to unmeasurable, never the
 * other way: a missing file leaves every verdict exactly as it was before.
 */
function loadQuarantine() {
  const path = join(OUT_DIR, "quarantine.json");
  if (!existsSync(path)) return new Map();
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    // D90: a withhold for a spec that timed out loading is released, not counted.
    return new Map((doc.rows ?? []).filter((r) => !loadTimeoutWithhold(r)).map((r) => [r.id, String(r.why ?? "no reason recorded")]));
  } catch {
    return new Map();
  }
}

/**
 * Branch sides are not the whole program, and reporting only them is how a real
 * gap went unreported.
 *
 * This pipeline ratchets `hitByEither / sides` and calls it the number. But a
 * FUNCTION nothing invokes has no branch side to be uncovered - it simply never
 * runs - so it is invisible to the arm join. Measured at 98.52% branch
 * coverage: 26 functions had never been invoked by any test, every one an
 * anonymous callback (`req.on("close", () => ac.abort())`, the three
 * `this.redis.on(...)` handlers, `async () => await executor()`), and not one
 * appeared in the uncovered-sides list or in BLOCKED.md.
 *
 * Three causes, all repairable, none of them dead code:
 *   - a mock ANSWERS the thing that would have invoked the callback
 *   - nothing EMITS the event the handler is registered for
 *   - nothing FIRES the timer
 *
 * A metric that answers a narrower question than the one being asked is the
 * same defect as a join keyed on the wrong thing. It just reads as progress
 * rather than as a bug.
 */
/** F1.4: whether stage 3 wrote no proposal file at all. */
export function noProposalFiles(dir = PROPOSALS_DIR) {
  return !existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".json"));
}

/** F1.4: the same arms with every hit zeroed - measured by nothing of this run's. */
export function zeroHits(byArm) {
  const out = new Map();
  for (const [k, a] of byArm) out.set(k, { ...a, hits: (a.hits ?? []).map(() => 0) });
  return out;
}

function uncoveredNonBranch(...dirs) {
  const maps = dirs
    .filter(Boolean)
    .map((d) => join(d, "coverage-final.json"))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, "utf8")));
  if (!maps.length) return { functions: 0, statements: 0, functionsTotal: 0, statementsTotal: 0 };
  const files = new Set(maps.flatMap((m) => Object.keys(m)));
  let functions = 0;
  let statements = 0;
  // The DENOMINATORS too, not just the misses. Counting only what is uncovered
  // is what left this unit kind unratchetable: a ratchet needs `covered out of
  // total`, and this returned a bare miss count that no later run could compare
  // against. Same loop, two more accumulators.
  let functionsTotal = 0;
  let statementsTotal = 0;
  for (const file of files) {
    const shape = maps.find((m) => m[file])?.[file];
    if (!shape) continue;
    for (const id of Object.keys(shape.fnMap ?? {})) {
      functionsTotal += 1;
      if (!maps.some((m) => (m[file]?.f?.[id] ?? 0) > 0)) functions += 1;
    }
    for (const id of Object.keys(shape.statementMap ?? {})) {
      statementsTotal += 1;
      if (!maps.some((m) => (m[file]?.s?.[id] ?? 0) > 0)) statements += 1;
    }
  }
  return { functions, statements, functionsTotal, statementsTotal };
}

/**
 * Append this measurement to the loop ledger - the ONE artifact the agent does
 * not write.
 *
 * The unattended loop is 3 -> 4 -> 5 -> 6 -> 3, and its stop condition cannot
 * live in the skill the agent reads, because the failure it guards against is
 * the agent judging its own progress. The pilot's own account: the recording
 * lane stalled, no rule said what to do, and the agent wrote 572 tests whose
 * every value came from running its own suite - then reported success, because
 * no written rule had been broken.
 *
 * So every stage-6 run appends one row here, and `gate.mjs`'s `progress` check
 * reads it. Two consecutive iterations that move `hitByEither` by nothing are a
 * STOP: report what is left, never widen the run, never record from the suite's
 * own output. `newSides` is computed here, from the previous row, so the number
 * a report quotes is not one anybody derived in prose.
 *
 * Appended, never rewritten: the shape of a run - front-loaded, then flat - is
 * the evidence for whether another iteration is worth its cost, and only the
 * history shows it.
 */
/** The commit the measurement describes. A ledger row without it cannot be checked against a tree. */
function headSha() {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function appendLoopLedger(totals, gitSha) {
  const rows = existsSync(LOOP_JSON) ? (JSON.parse(readFileSync(LOOP_JSON, "utf8")).iterations ?? []) : [];
  const prev = rows[rows.length - 1] ?? null;
  const row = {
    n: rows.length + 1,
    at: new Date().toISOString(),
    gitSha,
    // WHICH suite produced this row. A ledger whose rows do not say what they
    // measured cannot be read back: two iterations pointed at different
    // directories look like progress or a regression, and neither is real.
    specs: SPECS_RELATIVE,
    specsMeasured: SPECS_COUNT,
    sides: totals.sides,
    hitByCharacterization: totals.hitByCharacterization,
    hitByEither: totals.hitByEither,
    stillUncovered: totals.stillUncovered,
    // The live-code pair on every row, so the loop history shows what deleting
    // a dead export's proposals actually cost. On run 20260915T050314Z it shows
    // 323/332 at iteration 4 AND at iteration 6 - the -12 `newSides` bought
    // back, and the proof that obeying stage 2b is free against live code.
    correctedHitByEither: totals.correctedHitByEither,
    correctedSides: totals.correctedSides,
    // The movement, against the PREVIOUS iteration. A first row has no
    // predecessor, so it reports null rather than crediting the loop with
    // everything the existing suite already covered.
    newSides: prev ? totals.hitByEither - prev.hitByEither : null,
    claimsFalse: totals.claimsFalse,
  };
  // Item 1 (steps/earlymeasure.mjs): a measurement run beside cigate writes
  // its row to a file of its own, and the walk appends it only once the
  // measurement is kept (`--adopt-ledger-row`). A measurement that is stopped
  // or dropped leaves no row.
  const deferred = process.env.CHARPILOT_COVERAGE_LEDGER_ROW;
  if (deferred) {
    writeFileSync(deferred, `${JSON.stringify({ row, totals, gitSha, modeStamp: modeStamp() }, null, 2)}\n`);
    return row;
  }
  rows.push(row);
  writeFileSync(LOOP_JSON, `${JSON.stringify({ stage: "6-loop", ...modeStamp(), iterations: rows }, null, 2)}\n`);
  return row;
}

/**
 * `--adopt-ledger-row <file>`: append the row a deferred measurement wrote,
 * numbered and moved against the ledger as it is now, and remove the file.
 */
function adoptLedgerRow(file) {
  const kept = JSON.parse(readFileSync(file, "utf8"));
  const rows = existsSync(LOOP_JSON) ? (JSON.parse(readFileSync(LOOP_JSON, "utf8")).iterations ?? []) : [];
  const prev = rows[rows.length - 1] ?? null;
  rows.push({ ...kept.row, n: rows.length + 1, newSides: prev ? kept.row.hitByEither - prev.hitByEither : null });
  writeFileSync(LOOP_JSON, `${JSON.stringify({ stage: "6-loop", ...(kept.modeStamp ?? modeStamp()), iterations: rows }, null, 2)}\n`);
  rmSync(file, { force: true });
  process.stdout.write(`· loop ledger: iteration ${rows.length} appended from ${relative(REPO_ROOT, file)}\n`);
}

/**
 * THE RECORDING THIS MEASUREMENT IS ABOUT.
 *
 * `record.mjs --live` writes `behaviour-live.json`; a mocked run writes
 * `behaviour.json`. This read `behaviour.json` unconditionally and had no flag
 * that could aim it anywhere else, so after a live run it either found nothing
 * or - worse, and the likelier case in a long loop - found a STALE MOCKED
 * artifact whose mtime was genuinely recent, and checked the mocked corpus
 * against coverage produced by the live-emitted suite.
 *
 * Silent both ways, because `recordedIds` gates the claim check: an id that is
 * not in it makes the claim `continue`, so a completely mismatched artifact
 * reports `0 verified, 0 FALSE` - and `0 FALSE` is the condition for exit 0.
 * The measurement that is supposed to retire residual risk #1 reported success
 * by measuring nothing.
 */
const BEHAVIOUR_FOR_RUN = ARGV.includes("--live") ? join(OUT_DIR, "behaviour-live.json") : BEHAVIOUR_JSON;

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (arg("--adopt-ledger-row")) {
    adoptLedgerRow(resolve(arg("--adopt-ledger-row")));
    return;
  }
  // A deferred row a stopped measurement left is not this one's (item 1).
  if (process.env.CHARPILOT_COVERAGE_LEDGER_ROW) rmSync(process.env.CHARPILOT_COVERAGE_LEDGER_ROW, { force: true });

  const modeVerdict = modeOf();
  if (modeVerdict.error) {
    process.stderr.write(`\n✗ stage 6: ${modeVerdict.error}.\n  Set CHARPILOT_MODE and --live to the same mode, or neither.\n`);
    process.exit(1);
  }

  // Read BEFORE the suite is run, so a missing dead-export scan costs a
  // refusal rather than a full istanbul pass followed by one.
  const deadVerdict = deadExportFunctionIds(existsSync(DEAD_EXPORTS) ? read(DEAD_EXPORTS) : null, relative(REPO_ROOT, DEAD_EXPORTS));
  if (deadVerdict.error) {
    process.stderr.write(
      `\n✗ stage 6 cannot report a rate against live code: ${deadVerdict.error}.\n` +
        `  Sides inside a dead export leave the numerator when their proposals are deleted; they must leave the\n` +
        `  denominator with them, and this artifact is the only written reason a side may.\n`
    );
    process.exit(1);
  }

  // FIX PLAN 1, F1.4: A STAGE 3 THAT MADE NO PROPOSALS IS MEASURED, NOT REFUSED.
  // There is no suite to run and no recording to read, and the existing suite
  // still covers what it covers - so the join is the baseline suite alone,
  // every characterization count zero, and no claim to check (no floor).
  // A location-ms run of 2026-09-20 died on "no proposal files" instead.
  const emptyStage3 = noProposalFiles();
  const specRun = SKIP_RUN || emptyStage3 ? null : runSpecsUnderCoverage();

  const scan = read(SCAN_JSON);
  const baseline = read(BASELINE_JSON);
  // REFUSED, not defaulted to an empty corpus. `{ rows: [] }` here makes every
  // claim unreachable and every number below describe nothing, while still
  // printing as a measurement and exiting 0.
  if (!existsSync(BEHAVIOUR_FOR_RUN) && !emptyStage3) {
    const other = BEHAVIOUR_FOR_RUN === BEHAVIOUR_JSON ? join(OUT_DIR, "behaviour-live.json") : BEHAVIOUR_JSON;
    process.stderr.write(
      `\n\u2717 stage 6: ${relative(REPO_ROOT, BEHAVIOUR_FOR_RUN)} does not exist, so there is no recording to check claims against.\n` +
        (existsSync(other)
          ? `  ${relative(REPO_ROOT, other)} DOES exist. These are not interchangeable - one is a live recording and\n` +
            `  one is mocked. Pass --live (or drop it) so this measures the recording you mean.\n`
          : `  Record first:  node .claude/charpilot/record.mjs${ARGV.includes("--live") ? " --live" : ""}\n`)
    );
    process.exit(1);
  }
  const behaviour = emptyStage3 && !existsSync(BEHAVIOUR_FOR_RUN) ? { rows: [], skipped: [] } : read(BEHAVIOUR_FOR_RUN);
  const recordedIds = new Set((behaviour.rows ?? []).filter((r) => r.invoked).map((r) => r.id));

  // EVERY unit the scan and the brief know about, coverage report or not. The
  // position join below holds only the arms istanbul instruments, so it is the
  // wrong thing to ask "does this arm exist" - and asking it anyway is what
  // made a present entry, catch or statement unit read as a missing arm id.
  // Same index and same producer as stage 4's `annotateClaims`.
  const worklistItems = loadWorklistItems();
  const staticArms = armIndexFromScan(scan, worklistItems);

  // THE SAME JOIN THE BRIEF WAS BUILT FROM.
  //
  // worklist.mjs pairs arms to istanbul branches by position rank; if this
  // measured with the old line-keyed join instead, stage 6 would judge stage
  // 3's claims against a different arm model. On ptp-be that is an 8-side
  // disagreement, and the damage is not the count: this stage decides whether a
  // `reaches` claim is TRUE, so a claim naming an arm only the position join can
  // see would come back FALSE against a correct input - sending a stage-3 defect
  // report for a defect that is in the joiner.
  const joinArms = (coverageDir) => {
    const hitIndex = buildHitIndex(coverageDir);
    return measureArmsByPosition(scan, buildPositionIndex(coverageDir), {
      lineFallback: (file, arm, cursor) => armCoverage(file, arm, hitIndex, cursor),
    });
  };

  // F1.4: with no suite of its own the arm model is the baseline report's, and
  // this run's hits are all zero.
  const byArm = emptyStage3 ? zeroHits(joinArms(COVERAGE_DIR)) : joinArms(STAGE5_COVERAGE);
  const otherMetrics = emptyStage3 ? uncoveredNonBranch(COVERAGE_DIR) : uncoveredNonBranch(STAGE5_COVERAGE, COVERAGE_DIR);
  // The reloop list has to be sides uncovered by the existing suite AND by the
  // characterization inputs. Measuring the specs alone reports 673 uncovered
  // against a baseline of 484 - not a regression, just a different question,
  // and feeding those 673 back to stage 3 would commission work for sides the
  // suite already covers.
  const bySuite = existsSync(join(COVERAGE_DIR, "coverage-final.json")) ? joinArms(COVERAGE_DIR) : new Map();

  let sides = 0;
  let hit = 0;
  let hitBySuite = 0;
  let hitByEither = 0;
  // Sides inside a dead export, counted in the SAME pass as the sides they are
  // subtracted from. Counted here rather than re-derived from dead-exports.json
  // so the numerator and the denominator can never be enumerated differently.
  let deadSides = 0;
  let deadSidesHit = 0;
  const stillUncovered = [];
  for (const a of byArm.values()) {
    if (!a.known) continue;
    const suite = bySuite.get(a.armId);
    // An arm with no `functionId` - a module-scope arm, say - is NOT dead. The
    // default has to point this way: an unattributed side that stayed in the
    // denominator understates the rate, and an unattributed side that left it
    // would inflate one. Only a side this tool can place inside a named dead
    // export leaves, which is also what makes `deadExportSidesDeclared` below a
    // real cross-check rather than a restatement.
    const inDeadExport = a.functionId !== undefined && deadVerdict.ids.has(a.functionId);
    a.hits.forEach((n, i) => {
      sides += 1;
      const s = suite?.known ? (suite.hits[i] ?? 0) : 0;
      if (n > 0) hit += 1;
      if (s > 0) hitBySuite += 1;
      if (n > 0 || s > 0) hitByEither += 1;
      if (inDeadExport) {
        deadSides += 1;
        if (n > 0 || s > 0) deadSidesHit += 1;
      }
      // Only a side neither the suite nor these inputs reached is work for the
      // next loop.
      if (n === 0 && s === 0) {
        stillUncovered.push({
          armId: a.armId,
          file: a.file,
          line: a.line,
          side: a.labels[i] ?? `arm${i}`,
          kind: a.kind,
          functionName: a.functionName,
          functionId: a.functionId,
          ...(inDeadExport ? { deadExport: true } : {}),
        });
      }
    });
  }

  // READ ONCE for the two questions that want it: which sides the recorder
  // refused to exercise (D64, immediately below) and which claims this
  // measurement can check (the loop after it). `loadProposals` prints a line
  // per malformed document, so calling it twice would report the same
  // unreadable file twice and read as two files.
  const proposalCorpus = loadProposals();

  // D64. AFTER the counters above and BEFORE the totals below, and it changes
  // neither: `sides`, `hitByEither` and `deadSides` are already final, and
  // this only writes a reason onto rows that are already in `stillUncovered`.
  // A row the harness failed on carries the recorder's reason too: the tool's
  // becomes a pipeline_defect, the proposal's stays open with that reason.
  const undeliverableSides =
    markUndeliverable(stillUncovered, refusedByRecorder(behaviour, proposalCorpus)) +
    markHarnessFailed(stillUncovered, failedInHarness(behaviour)).undeliverable;
  // D68: and a skip that is the proposal's stays open WITH its reason. After
  // both of the above, so a tool's verdict on the same side is never overwritten.
  markAsked(stillUncovered, askedOfProposal(behaviour, proposalCorpus));
  // Fix plan 1, rule 3: every uncovered side gets a ruling, after the reasons
  // above are on the rows. Changes no counter; report.mjs reads the tally.
  const labelSources = { worklist: worklistItems ? { items: worklistItems } : null, scan };
  const rulings = markRulings(
    stillUncovered,
    readBlockedBySide(stillUncovered, undefined, labelSources),
    readSalvagedBySide(),
    readRefusedBySide(stillUncovered, undefined, labelSources)
  );

  // The claim check. A proposal names an arm and the side it means to reach;
  // this asks istanbul whether that side ran.
  const verified = [];
  const falseClaims = [];
  const unmeasurable = [];
  const quarantined = loadQuarantine();
  // Which proposals this measurement could even ASK about. A proposal the
  // recording does not hold is skipped below, silently, and a wholesale skip is
  // how "0 verified, 0 FALSE" comes to mean "I measured nothing" while reading
  // as "nothing is wrong" - see the floor asserted after the loop.
  let claimable = 0;
  for (const p of proposalCorpus) {
    if (!recordedIds.has(p.id)) continue;
    if (Object.keys(p.reaches ?? {}).length) claimable += 1;
    for (const [armId, value] of Object.entries(p.reaches ?? {})) {
      const a = byArm.get(armId);
      if (!a || !a.known) {
        unmeasurable.push({ id: p.id, armId, why: a ? a.reason : whyUnjoined(armId, staticArms, worklistItems) });
        continue;
      }
      for (const side of claimedSides(value, a.labels)) {
        const i = sideIndexOf(a.labels, side);
        if (i === -1) {
          unmeasurable.push({ id: p.id, armId, why: `"${side}" is not a side of this arm (${a.labels.join(", ")})` });
          continue;
        }
        const row = { id: p.id, armId, side, file: a.file, line: a.line, functionName: a.functionName, hits: a.hits[i] ?? 0 };
        if (row.hits > 0) verified.push(row);
        // A QUARANTINED ROW'S CLAIM IS UNMEASURABLE, NOT FALSE.
        //
        // Stage 5 emits a row that did not reproduce as `it.skip`. A skipped
        // test cannot enter an arm, so istanbul reports zero hits, so this
        // called the claim FALSE - and the run's headline verdict told a person
        // "repair the stage-3 inputs" about inputs that were never run.
        //
        // Measured on 20260915T111114Z: 30 of 65 rows quarantined, and 46 of
        // the 55 FALSE claims came from them. Every quarantine reason in that
        // file is a record/replay reproduction failure - 25 "replay answered a
        // request the recording does not hold", 4 harness failures, 1 dropPath
        // array-hole. NOT ONE is a stage-3 aiming failure. The number sent the
        // reader to the wrong stage, which is the definition this pipeline
        // writes its own rules against.
        //
        // Unmeasurable is the honest bucket: the claim is neither shown true
        // nor shown false, because the thing that would show it did not run.
        else if (quarantined.has(p.id)) {
          unmeasurable.push({
            id: p.id, armId, side,
            why: `the emitted test is quarantined (\`it.skip\`), so it never entered this arm — ` +
                 `${quarantined.get(p.id)}. The claim is unverified, not false: repair the ` +
                 `RECORDING, not the input`,
          });
        } else falseClaims.push(row);
      }
    }
  }

  // Sides the characterization inputs covered that no proposal claimed. Not a
  // defect - incidental coverage is real coverage - but it is the difference
  // between what was aimed at and what was achieved, and worth seeing.
  // Two unlike mechanisms produce a false claim, and they have different fixes.
  //
  //   closure-not-invoked  the driver RETURNED a function and that function is
  //                        where the arm lives. The recorded output is
  //                        `{$function}` - a function object, not behaviour -
  //                        so nothing inside it ever ran. The `via` names the
  //                        outermost reachable function, but reaching the arm
  //                        needs the returned closure CALLED.
  //   path-not-taken       the row returned a real value and still missed the
  //                        side: a declared boundary short-circuited the path,
  //                        or the input does not select the branch it claims.
  const rowById = new Map((behaviour.rows ?? []).map((r) => [r.id, r]));
  // A NON-ZERO FLOOR. `claimsChecked` had none anywhere: 0 verified, 0 FALSE and
  // any number of unmeasurable printed "0 of 0 claims verified against istanbul"
  // and PASSED, here and in gate.mjs. Since the exit code keys on falseClaims
  // alone, a measurement that joined nothing at all was indistinguishable from a
  // clean one - which is what makes reading the wrong behaviour artifact silent
  // rather than loud.
  //
  // The floor is not "some claims exist", it is "the claims that could be
  // checked were". A run with genuinely zero claimable rows says so and stops;
  // it does not report a percentage nobody can act on.
  // FIX PLAN 1, F1.3: the refusal is decided here and SAID after the join is
  // on disk. It used to exit before `coverage.json` existed, so `measure` had
  // nothing to quarantine from and the same question was asked every round
  // (contact-ms 20260922T101057Z, 9 times). The document now carries
  // `claimsChecked: 0` and the `unmeasurable` list, and this still exits 1.
  let floorRefusal = null;
  if (!verified.length && !falseClaims.length && !emptyStage3) {
    floorRefusal = () => process.stderr.write(
      `\n\u2717 stage 6: 0 claims were checked, so nothing above was verified against istanbul.\n` +
        `  ${claimable} recorded proposal(s) carry a \`reaches\` claim and ${unmeasurable.length} claim(s) were\n` +
        `  unmeasurable. This is the check that retires residual risk #1 - a \`reaches\` sentence a\n` +
        `  proposal wrote about itself - so a run that checks none of them has measured coverage and\n` +
        `  verified nothing, and "0 of 0 verified" must not read as a pass.\n` +
        (claimable === 0
          ? `  No recorded row carries a claim: check that ${relative(REPO_ROOT, BEHAVIOUR_FOR_RUN)} is the\n` +
            `  recording these proposals were recorded into (--live selects the live one).\n`
          : `  Every claimable row failed to join the coverage report - usually the wrong suite, the wrong\n` +
            `  behaviour artifact, or a src/ that moved since the recording.\n`)
    );
  }

  for (const f of falseClaims) {
    const r = rowById.get(f.id);
    f.mechanism = r?.returned?.$function ? "closure-not-invoked" : "path-not-taken";
  }

  const claimedKeys = new Set(verified.map((v) => `${v.armId}|${v.side}`));
  let incidental = 0;
  for (const a of byArm.values()) {
    if (!a.known) continue;
    a.hits.forEach((n, i) => {
      if (n > 0 && !claimedKeys.has(`${a.armId}|${a.labels[i] ?? `arm${i}`}`)) incidental += 1;
    });
  }

  // baseline.json nests these under coverage.totals, not coverage. Reading the
  // wrong path yielded `undefined`, and the ratchet check then failed with
  // "records no branch total" - a check reporting a missing input as a
  // regression. Both are recorded: the stored summary, and `hitBySuite`, which
  // is the SAME suite measured through this script's own join. They must agree,
  // and if they ever disagree the join has drifted.
  const base = baseline.coverage?.totals?.branches ?? {};
  const live = liveCodeTotals({
    sides,
    hitByEither,
    stillUncovered: stillUncovered.length,
    deadSides,
    deadSidesHit,
  });
  const doc = {
    stage: "6-coverage",
    measuredAt: new Date().toISOString(),
    measured: "the GENERATED characterization suite alone - the existing suite is measured separately and unioned",
    envProvenance: behaviour.envProvenance ?? null,
    // The mode this rate describes. A rate without one is not comparable to a
    // target, and the check that compares them refuses rather than guesses.
    mode: modeVerdict.mode,
    /* --------------------------------------------------------------------
     * WHETHER THE SUITE UNDER MEASUREMENT PASSED — persisted, because this
     * document is written BEFORE that is checked and a reader of it cannot
     * otherwise tell the two refusals apart.
     *
     * The check itself is at the bottom of this file and is unchanged: a
     * failing assertion runs AFTER the row body, so the counters had already
     * moved and every number above is an OVERSTATEMENT. That makes a claim
     * called FALSE here different evidence in the two cases — real under a
     * green suite, and not evidence at all under a red one — and `falseClaims`
     * is on disk either way.
     *
     * WHO NEEDS IT. `steps/derive.mjs` sets a row aside when the measurement
     * could not measure the claim it makes (D51, run 20260919T104903Z rounds 3
     * and 5, the same row twice). It must NOT do that on numbers measured
     * while tests were failing — `measure`'s own item says the suite is the
     * thing to fix there and the sides are already answered. Without this
     * field that step would have to keep a second account of what this tool
     * decided, which `steps.never-repair-a-tools-output` refuses and is right
     * to: the fact belongs in the artifact of the tool that knows it.
     *
     * NULL when no suite was run at all (`--skip-run`), which is neither a
     * pass nor a failure and must not read as either.
     * ------------------------------------------------------------------ */
    suitePassed: specRun ? specRun.status === 0 : null,
    // The counts behind that verdict (suiteTestCounts): an all-skip suite
    // passes with nothing passed. Null with no run, or no summary line.
    tests: specRun ? SUITE_TESTS : null,
    // WHICH SPEC FILES THIS RUN RAN (incremental.mjs): all of them, the ones
    // that changed with the rest's kept coverage merged in by vitest, or none
    // because nothing changed. Every number here is the full suite's either
    // way; this says how it was arrived at. Absent under the kill switch.
    ...(specRun?.measuredBy && incrementalOn() ? { measuredBy: specRun.measuredBy } : {}),
    // D90: the spec(s) whose module fetch timed out, and how they were measured
    // again. steps/measure.mjs says it in the walk's log.
    ...(specRun?.loadTimeoutRetry ? { loadTimeoutRetry: specRun.loadTimeoutRetry } : {}),
    // D91: the heap vitest's main process ran with, when it was not node's
    // default. steps/measure.mjs says it in the walk's log.
    ...(specRun?.measureHeap ? { measureHeap: { ...specRun.measureHeap, killSwitch: `${MEASURE_HEAP_ENV}=off` } } : {}),
    totals: {
      sides,
      hitByCharacterization: hit,
      hitByExistingSuite: hitBySuite,
      hitByEither: hitByEither,
      stillUncovered: stillUncovered.length,
      // THE SAME MEASUREMENT AGAINST LIVE CODE. Both are carried, always: a
      // corrected rate that hides the raw one is how a smaller run comes to
      // wear a bigger number, and the raw pair is what the ratchet holds.
      ...live,
      // deadcode.mjs's own count of the same sides. Equal means the two tools
      // still agree about what a dead export contains; a difference is a real
      // disagreement between the ts-morph span and the istanbul position join,
      // and it is reported rather than averaged.
      deadExportSidesDeclared: deadVerdict.declaredSides,
      // D64. BESIDE THE RATE AND NEVER INSIDE IT. These sides are live, they
      // are in `sides`, they are in `correctedSides`, and every one of them is
      // counted as uncovered in both. The number says how much of
      // `stillUncovered` this mode's recorder refused to exercise and wrote a
      // reason for; subtracting it anywhere would be the dead-export
      // correction applied to code that is not dead.
      undeliverableSides,
      // Fix plan 1, rule 3: how the uncovered sides are ruled. Beside the rate
      // and never inside it, like the line above.
      rulings,
      claimsChecked: verified.length + falseClaims.length,
      claimsVerified: verified.length,
      claimsFalse: falseClaims.length,
      claimsFalseClosureNotInvoked: falseClaims.filter((f) => f.mechanism === "closure-not-invoked").length,
      claimsFalsePathNotTaken: falseClaims.filter((f) => f.mechanism === "path-not-taken").length,
      claimsUnmeasurable: unmeasurable.length,
      incidentalSides: incidental,
      baselineSuiteCovered: base.covered ?? null,
      // Function entries and statements, PERSISTED. They were computed here and
      // printed to the terminal, then dropped - so the ratchet had only branch
      // sides to hold, and a function or statement could be driven, measured and
      // then silently lost. This is the same blind spot as the 26 invisible
      // functions (item 6), one tool further down: a branch side was the only
      // unit that survived a persistence boundary.
      functionsTotal: otherMetrics.functionsTotal,
      functionsCovered: otherMetrics.functionsTotal - otherMetrics.functions,
      functionsUncovered: otherMetrics.functions,
      statementsTotal: otherMetrics.statementsTotal,
      statementsCovered: otherMetrics.statementsTotal - otherMetrics.statements,
      statementsUncovered: otherMetrics.statements,
      baselineFunctionsCovered: baseline.coverage?.totals?.functions?.covered ?? null,
      baselineStatementsCovered: baseline.coverage?.totals?.statements?.covered ?? null,
      baselineSuiteTotal: base.total ?? null,
      // A cross-check, not a duplicate: the stored baseline says the suite
      // covered `baselineSuiteCovered` sides; re-measuring that same suite
      // through this join says `hitByExistingSuite`. Equal means the join is
      // still the one stage 2 proved closes at zero drift.
      joinAgreesWithBaseline: (base.covered ?? null) === hitBySuite,
    },
    // Published so validate can tell "this arm is covered BECAUSE of this
    // proposal" from "this proposal targets a covered arm and contributes
    // nothing". Without it a reloop reports every working input as an error.
    verified,
    falseClaims,
    unmeasurable,
    stillUncovered,
    // F1.3. Which of this tool's refusals, if any, this document was written
    // under. `measure` reads exit 1 WITH a fresh document carrying this as
    // "measured, with a refusal"; exit 1 without one is a step defect.
    // F1.4: measured with no characterization suite at all.
    ...(emptyStage3 ? { emptyStage3: true } : {}),
    // F2.2: which rows the failing tests came from, for measure's item.
    failingTests: specRun?.failingTests ?? [],
    refused: floorRefusal ? "claims-floor" : specRun && specRun.status !== 0 ? "suite-did-not-pass" : falseClaims.length ? "false-claims" : null,
  };
  writeJoin(OUTPUT, doc);
  if (floorRefusal) {
    floorRefusal();
    process.stderr.write(`  ${relative(REPO_ROOT, OUTPUT)} is written with claimsChecked 0 and ${unmeasurable.length} unmeasurable claim(s).\n`);
    process.exit(1);
  }

  // The ledger row is written from the SAME totals object that was just
  // persisted, so the loop history and coverage.json can never disagree.
  const loop = appendLoopLedger(doc.totals, headSha());

  const pct = sides ? ((hit / sides) * 100).toFixed(2) : "0.00";
  process.stdout.write(
    `\n✓ stage 6 measured → ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    sides                 ${sides}\n` +
      `    hit by these inputs   ${hit}  (${pct}%)   ← the generated suite ALONE\n` +
      `    hit by the suite      ${hitBySuite}\n` +
      `    hit by EITHER         ${hitByEither}  (${sides ? ((hitByEither / sides) * 100).toFixed(2) : "0.00"}%)   ← RAW, every side the scan found\n` +
      `    inside a dead export  ${live.deadExportSides}  (${live.deadExportSidesHit} of them covered)   ${
        live.deadExportSides === deadVerdict.declaredSides
          ? "← out/dead-exports.json agrees"
          : `← out/dead-exports.json says ${deadVerdict.declaredSides}; the ts-morph span and the position join DISAGREE`
      }\n` +
      `    against LIVE code     ${live.correctedHitByEither}/${live.correctedSides}  (${
        live.correctedSides ? ((live.correctedHitByEither / live.correctedSides) * 100).toFixed(2) : "0.00"
      }%)   ← the rate a target is held against\n` +
      `    still uncovered       ${stillUncovered.length}  (${live.correctedStillUncovered} of them in live code)  ← neither reached it: this is the next loop's input\n` +
      `      undeliverable        ${undeliverableSides}  ${
        undeliverableSides
          ? "← live code the RECORDER refused to exercise in this mode and said why; still counted, still uncovered, not asked again"
          : "← the recorder refused none of them"
      }\n` +
      `    function entries      ${otherMetrics.functionsTotal - otherMetrics.functions}/${otherMetrics.functionsTotal}  ${otherMetrics.functions ? `\u2190 ${otherMetrics.functions} uncovered: callbacks nothing invokes; NOT branch sides, NOT in BLOCKED.md` : "\u2190 ratchetable now"}\n` +
      `    statements            ${otherMetrics.statementsTotal - otherMetrics.statements}/${otherMetrics.statementsTotal}  ${otherMetrics.statements ? `\u2190 ${otherMetrics.statements} uncovered` : "\u2190 ratchetable now"}\n` +
      `    claims checked        ${verified.length + falseClaims.length}\n` +
      `    verified              ${verified.length}\n` +
      `    FALSE                 ${falseClaims.length}   ${falseClaims.length ? "← the input never reached the side it was written for" : ""}\n` +
      `      closure not invoked  ${falseClaims.filter((f) => f.mechanism === "closure-not-invoked").length}  (driver returned a function; the arm is inside it)\n` +
      `      path not taken       ${falseClaims.filter((f) => f.mechanism === "path-not-taken").length}  (returned a value, but not down this side)\n` +
      `    unmeasurable          ${unmeasurable.length}\n` +
      `    incidental            ${incidental}  (hit, but no proposal aimed at it)\n`
  );

  if (falseClaims.length) {
    process.stdout.write(`\n  a claim that is false means the recorded pair freezes a DIFFERENT arm under this label:\n`);
    for (const f of falseClaims.slice(0, 12)) {
      process.stdout.write(`      ${f.id}\n        claims ${f.armId} side "${f.side}" (${f.file}:${f.line}) — istanbul says 0 hits\n`);
    }
    if (falseClaims.length > 12) process.stdout.write(`      … +${falseClaims.length - 12} more in ${relative(REPO_ROOT, OUTPUT)}\n`);
  }

  // THE REASONS, grouped, in the terminal - because an unmeasurable count with
  // no reason beside it is the thing that got investigated. 8 of 38 claims read
  // `arm not found in scan` on one run and every one of the eight was a
  // present, correct id; the count alone could not say that, and the reasons
  // were only in coverage.json. Grouping is what makes the answer one line:
  // "all 8 are units istanbul has no branch counter for" needs no follow-up,
  // and "1 is absent from scan.json" names a stale id to rebuild.
  if (unmeasurable.length) {
    const byReason = new Map();
    for (const u of unmeasurable) {
      if (!byReason.has(u.why)) byReason.set(u.why, []);
      byReason.get(u.why).push(u);
    }
    process.stdout.write(`\n  unmeasurable, by reason (${unmeasurable.length} claim(s) - a reason is not a defect unless it names one):\n`);
    for (const [why, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      process.stdout.write(`      ${String(list.length).padStart(4)}  ${why}\n`);
      for (const u of list.slice(0, 3)) process.stdout.write(`            ${u.armId}   (${u.id})\n`);
      if (list.length > 3) process.stdout.write(`            … +${list.length - 3} more in ${relative(REPO_ROOT, OUTPUT)}\n`);
    }
  }

  process.stdout.write(
    `\n    loop iteration        ${loop.n}` +
      (loop.remeasured
        ? `  ← re-measured ${loop.remeasured}x with no new recording, so this is the SAME iteration\n`
        : loop.newSides === null
        ? `  ← first measurement, no movement to report yet\n`
        : `  ← ${loop.newSides >= 0 ? "+" : ""}${loop.newSides} side(s) since iteration ${loop.n - 1}` +
          (loop.newSides === 0
            ? `  STALLED: one more flat iteration and the loop must stop\n`
            : loop.newSides < 0
              ? `  WENT BACKWARDS: ${Math.abs(loop.newSides)} side(s) this run had already measured are no longer covered\n`
              : `\n`))
  );
  // BELOW ITS OWN PEAK. Not a failure on its own - deleting a proposal that
  // aimed at a dead export is correct, and it costs sides - but it must never
  // be silent, because the number printed above is the one that gets quoted.
  // THE BEST THIS RUN EVER MEASURED, derived from the ledger rather than stored
  // on the row - so it reads correctly on a loop.json written before this
  // existed, which is every ledger in the wild today.
  //
  // A loop that goes backwards had no reader. `newSides === 0` prints "STALLED:
  // one more flat iteration and the loop must stop"; a NEGATIVE newSides
  // printed the number and nothing else, so standing still was louder than
  // giving coverage away.
  //
  // Measured on run 20260915T050314Z, a clean hermetic mocked run with 133 of
  // 133 claims verified: it reached 358 of 367 sides at iteration 4 and
  // finished at 346. It gave back 12 sides, 3.3 points, and reported the lower
  // number as its result with nothing marking the fall.
  const ledger = existsSync(LOOP_JSON) ? (read(LOOP_JSON).iterations ?? []) : [];
  const peak = peakOf(ledger, doc.totals.hitByEither);
  if (peak > doc.totals.hitByEither) {
    const pct = (n) => (doc.totals.sides ? Math.round((n / doc.totals.sides) * 1000) / 10 : 0);
    process.stdout.write(
      `\n\u2717 this run measured ${peak}/${doc.totals.sides} (${pct(peak)}%) at its best and is reporting ` +
        `${doc.totals.hitByEither}/${doc.totals.sides} (${pct(doc.totals.hitByEither)}%).\n` +
        `  ${peak - doc.totals.hitByEither} side(s) it had already covered are not covered now. Every drop is in\n` +
        `  out/loop.json as a negative newSides. Find which iteration gave them back before quoting this\n` +
        `  number: a quarantined row, a deleted proposal and a real regression all look like this line.\n`
    );
  }

  process.stdout.write("\nThis is a SNAPSHOT. Quote it, do not remember it.\n");

  // THE SUITE'S OWN VERDICT, which this computed, packaged into { status } and
  // then discarded at the call site. The only liveness check was that a
  // coverage report existed - which a PREVIOUS run satisfies just as well.
  //
  // It mattered in exactly the wrong direction: a failing `expect` runs AFTER
  // the row body, so the counters have already moved. Failures push the
  // coverage number UP. A suite with 13 of 29 tests failing printed a
  // percentage and exited 0, and the number it printed was higher than the
  // truth. The comment justifying the tolerance was written when the target was
  // throwaway `--emit-specs` output; the default is now the committed suite,
  // where a failing test is a behaviour change or a replay defect, never noise.
  if (specRun && specRun.status !== 0) {
    // D64: the explanation first and vitest's own first error LAST, where the
    // walk's quote of this tool (its last four stderr lines) can see it.
    const failing = specRun.failingTests ?? [];
    const named = failing.length
      ? `; ${failing.length} failing test(s): ${failing.slice(0, 3).map(failingName).join(", ")}${failing.length > 3 ? ", \u2026" : ""}`
      : "";
    const summary =
      `\u2717 stage 6: the suite under measurement did not pass (vitest exited ${specRun.status}` +
      (specRun.signal ? `, signal ${specRun.signal}` : "") +
      `${named})` +
      (specRun.signal ? ` - ${signalVerdict({ signal: specRun.signal, stderr: specRun.fatal ?? "", heap: specRun.heap, stderrAt: specRun.stderrAt })}` : "");
    // D90: a spec that never loaded is the module-fetch timeout, and the walk's
    // quote (the last lines) says that, not "did not pass". Its coverage is
    // missing from the number, so the number is a shortfall, not an overstatement.
    if ((specRun.loadTimeouts ?? []).length && !failing.length) {
      process.stderr.write(
        `\n  ${specRun.loadTimeouts.length} spec file(s) never loaded, so none of their rows ran: the number above is\n` +
          `  missing their coverage. That is vitest's fixed 60 s module fetch running out on a large spec\n` +
          `  under load - the environment, not a behaviour change. Measure again on a quieter host.\n` +
          vitestSaidLines(specRun.said ?? { first: [], tail: [] }, loadTimeoutVerdict(specRun.loadTimeouts, specRun.loadTimeoutRetry))
      );
      process.exit(1);
    }
    process.stderr.write(
      `\n  Every number above was measured while those tests were failing, and a failing assertion runs\n` +
        `  AFTER the row body - so the counters had already moved and the percentage is an OVERSTATEMENT,\n` +
        `  not a shortfall. Fix the suite, then measure.\n` +
        vitestSaidLines(specRun.said ?? { first: [], tail: [] }, summary)
    );
    process.exit(1);
  }
  // A false claim is a stage-3 defect that stage 4 has already recorded under
  // the wrong label. That is exactly the failure this pipeline exists to
  // prevent, so it fails the run.
  if (falseClaims.length) process.exit(1);
}

/**
 * D92: a failing test by its row, its title, or - for an unhandled error no
 * test owns - the file and what it said. It printed as nothing
 * ("1 failing test(s): ") on qode-ptp-ms run 20260930T170133Z.
 */
export function failingName(t) {
  if (t?.rowId ?? t?.title) return t.rowId ?? t.title;
  return `an unhandled error in ${t?.file ?? "no spec file"}${t?.message ? ` (${String(t.message).slice(0, 160)})` : ""}`;
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