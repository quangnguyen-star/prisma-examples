/**
 * WHAT MAKES A VITEST RUN RED, INCLUDING THE RED ITS JSON REPORT DOES NOT SHOW.
 *
 * vitest's JSON reporter counts failed ASSERTIONS and failed FILES. An
 * unhandled error - an uncaught exception or an unhandled rejection raised
 * while a test ran - is neither: vitest prints "Errors 1 error" and exits 1,
 * and the JSON has every test `passed`. Measured on nginx-redirecting-ms
 * (run 20260924T054903Z): `Tests 103 passed`, `Errors 1`, exit 1, from
 * `listen EADDRINUSE :::4000` - and cigate, reading only the JSON, withheld
 * nothing and called it green while stage 6 stayed red on the exit code.
 *
 * So this file is also a vitest REPORTER. Passed with `--reporter <this
 * file>`, it writes the run's unhandled errors, each with the test vitest
 * names for it (`VITEST_TEST_NAME` / `VITEST_TEST_PATH` - the same fields
 * behind "The latest test that might've caused the error is ..."), to the
 * file named by CHARPILOT_UNHANDLED_OUT. cigate.mjs and coverage.mjs both run
 * it, so the two classify red the same way.
 *
 * Dependency-free on purpose: vitest loads it into its own process.
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This file, as the `--reporter` value. */
export const UNHANDLED_REPORTER = fileURLToPath(import.meta.url);
export const UNHANDLED_ENV = "CHARPILOT_UNHANDLED_OUT";

const clip = (s, n) => String(s ?? "").slice(0, n);

/** One unhandled error as the reporter writes it. */
function rowOf(e) {
  return {
    name: e?.name ?? null,
    message: clip(e?.message, 2000),
    code: e?.code ?? null,
    stack: clip(e?.stack, 4000),
    test: e?.VITEST_TEST_NAME ?? null,
    file: e?.VITEST_TEST_PATH ?? null,
  };
}

/**
 * Two hooks, because the fleet runs two reporter APIs. vitest >= 3 calls
 * `onTestRunEnd(modules, unhandledErrors, reason)`; vitest 1.x and 2.x have no
 * such hook and call `onFinished(files, errors)` - 9 fleet repos pin vitest 2,
 * and there this reporter wrote nothing, so cigate could name no row behind an
 * unhandled error (verifier, fix round 1, `probes/vitest2-out.txt`). vitest 3
 * calls both, with the same errors: the first writes, the second is skipped.
 */
export default class UnhandledErrorReporter {
  written = false;

  write(errors) {
    const out = process.env[UNHANDLED_ENV];
    if (!out || this.written) return;
    this.written = true;
    writeFileSync(out, `${JSON.stringify([...(errors ?? [])].map(rowOf), null, 2)}\n`);
  }

  onTestRunEnd(_modules, errors = []) {
    this.write(errors);
  }

  onFinished(_files, errors = []) {
    this.write(errors);
  }
}

/** The args and env that add this reporter to a vitest command line. */
export function withUnhandledReporter(outPath) {
  return { args: ["--reporter", UNHANDLED_REPORTER], env: { [UNHANDLED_ENV]: outPath } };
}

/** The errors one run wrote, or null when the reporter wrote nothing. Removes the file. */
export function readUnhandled(path) {
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
  return Array.isArray(doc) ? doc : null;
}

/** `<id> - returns` -> `<id>`, the inverse of the emitter's title. */
export const rowIdOf = (title) => String(title).replace(/ - (returns|throws|returns-function)$/, "");

/** The error as one bounded line, first line of the message and its code. */
export function unhandledLine(e) {
  const head = `${e?.name ?? "Error"}: ${String(e?.message ?? "").split("\n")[0]}`;
  return `unhandled error during the run - ${head}${e?.code ? ` (${e.code})` : ""}`.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * The unhandled errors that make a run RED: those of a run that exited non-zero.
 * vitest reports an unhandled error to every reporter even under
 * `dangerouslyIgnoreUnhandledErrors`, and then exits 0 - that repo has chosen
 * to call such a run green, and its CI does. So a zero exit counts none.
 */
export function unhandledThatCounts(errors, status) {
  return status === 0 ? [] : errors ?? [];
}

/**
 * Split a run's unhandled errors into the ones vitest attributed to a test
 * (a red TEST, named like any failed assertion) and the ones it did not (red
 * that belongs to no test: a pipeline_defect carrying the error text, never a
 * silent green).
 */
export function classifyUnhandled(errors, repoRoot) {
  const attributed = [];
  const unattributed = [];
  for (const e of errors ?? []) {
    const line = unhandledLine(e);
    if (e?.test) {
      attributed.push({
        id: rowIdOf(e.test),
        title: e.test,
        // vitest 2 names the file relative to its root, vitest >= 3 absolute.
        file: e.file ? relative(repoRoot, resolve(repoRoot, e.file)) : null,
        kind: "unhandled",
        message: line,
      });
    } else {
      unattributed.push({ kind: "unhandled-error", file: e?.file ? relative(repoRoot, resolve(repoRoot, e.file)) : null, message: line, stack: clip(e?.stack, 1200) });
    }
  }
  return { attributed, unattributed };
}

/**
 * D90: A SPEC THAT TIMED OUT LOADING. That is the environment, not its rows.
 *
 * qode-ptp-ms run 20260930T093551Z, measure, 2026-09-30T11:13:42Z:
 *   FAIL test/characterization/lib-server-services-aiInterviewService.char.test.ts
 *   Error: [vitest-worker]: Timeout calling "fetch" with "["/work/repo/test/characterization/lib-server-services-aiInterviewService.char.test.ts","ssr"]"
 * That spec is 33 MB, 1.13M lines and 1451 tests. A vitest worker asks the
 * main process for each module over birpc, and vitest 2.1.9 gives that call a
 * fixed 60 s (createRuntimeRpc, no config option). vite's SSR transform of a
 * file that size, on a host at load 10 on 8 cores, took longer, so the file
 * never loaded. The same file measured fine the attempt before, at 96.8%. A
 * file that fails this way ran none of its rows, so it says nothing about them:
 * cigate would have withheld all 1451 (`kind: "load"`), and measure failed the
 * whole measurement and lost the file's coverage from the number.
 *
 * The signature: the FILE failed, no assertion in it did, and its message is
 * vitest's RPC timeout, from the worker or the pool side, on one of the calls
 * that load a module. Anything else a file fails on (a syntax error, a missing
 * module, a throw at the top level) is the file's own, and is judged as before.
 *
 * Each such file is run again alone: cigate.mjs judges its rows on that lone
 * run, and coverage.mjs measures it alone and merges it with the rest. A file
 * that times out alone too is named as the timeout it is, never as its rows'.
 * `CHARPILOT_LOAD_TIMEOUT_RETRY=off` is the kill switch: such a file is a
 * load failure like any other, as before.
 */
export const LOAD_TIMEOUT_RETRY_ENV = "CHARPILOT_LOAD_TIMEOUT_RETRY";
export const loadTimeoutRetryOn = (env = process.env) => String(env[LOAD_TIMEOUT_RETRY_ENV] ?? "").trim().toLowerCase() !== "off";

/** vitest's own words for a module-loading RPC that ran out of time. */
export const LOAD_TIMEOUT = /\[vitest-(?:worker|pool)\]: Timeout calling "(fetch|transform|resolveId)"/;

/** A file-level failure: the file failed, and no assertion in it did. */
export const failedToLoad = (file) => file?.status === "failed" && !(file?.assertionResults ?? []).some((t) => t?.status === "failed");

/**
 * The files of one vitest JSON report that timed out loading, repo-relative,
 * each with vitest's line and the call that timed out. Empty for any other red.
 */
export function loadTimeoutsIn(doc, repoRoot) {
  const out = [];
  for (const file of doc?.testResults ?? []) {
    if (!failedToLoad(file)) continue;
    const message = String(file.message ?? "");
    const m = message.match(LOAD_TIMEOUT);
    if (!m) continue;
    out.push({
      file: file.name ? relative(repoRoot, resolve(repoRoot, file.name)) : null,
      call: m[1],
      message: message.split("\n").find((l) => LOAD_TIMEOUT.test(l))?.trim().slice(0, 400) ?? m[0],
    });
  }
  return out.filter((t) => t.file);
}

/** A file's size the way a reader weighs it: `33.0 MB`, or `unknown size`. */
export function sizeOf(path) {
  try {
    const bytes = statSync(path).size;
    return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} kB` : `${bytes} B`;
  } catch {
    return "unknown size";
  }
}

/**
 * D90: A WITHHOLD THAT ONLY EVER MEANT "ITS FILE TIMED OUT LOADING".
 *
 * qode-ptp-ms run 20260930T093551Z, full gate at 12:01:25Z, on the toolset
 * before this fix: 248 rows of the aiInterviewService spec withheld, each
 * `kind: "load"`, `the spec did not load: [vitest-worker]: Timeout calling
 * "fetch" with ...`, and emit rewrote the spec without them (33 MB -> 25 MB).
 * The verdict is about the host, not the recording, so nothing that re-judges
 * a row when its recording or renderer moves would ever lift it. An entry of
 * this shape is RELEASED wherever a quarantine is read: record.mjs renders the
 * row to run again (bindQuarantine), steps/emit.mjs re-emits for it
 * (unboundQuarantine), cigate.mjs does not carry it forward, and coverage.mjs
 * does not count it. The next gate judges the row, with the lone re-run above
 * if its file times out again. The same for a quarantine.json written before
 * this fix, which is how a resumed run meets one. Off with the kill switch.
 */
export function loadTimeoutWithhold(entry, env = process.env) {
  if (!loadTimeoutRetryOn(env) || entry?.kind !== "load") return false;
  return LOAD_TIMEOUT.test(`${entry?.message ?? ""} ${entry?.why ?? ""}`);
}
