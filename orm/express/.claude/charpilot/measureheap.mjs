/**
 * D91: VITEST'S MAIN PROCESS IS GIVEN THE HEAP THE CORPUS NEEDS, AND A VITEST
 * THAT DIES ON A SIGNAL IS SAID AS SUCH.
 *
 * qode-ptp-ms run 20260930T133720Z (image 1.0-d92), 16:09Z and again 16:34Z:
 *   measure: coverage.mjs exited 1 - ✓ test/characterization/lib-common-uuid.char.test.ts (1 test) 20ms · ⎯ ·
 *   ✗ stage 6: no coverage report produced (vitest exited null, signal SIGABRT) · ✓ ...
 * The corpus is 418 spec files, 471 MB. vite-node's server keeps every spec's
 * transform - the code with its source map inlined as base64 - in its fetch
 * cache for the whole run, and vite's module graph keeps the transform result
 * beside it, so vitest's MAIN process holds about 9 bytes of heap for every
 * byte of spec it has loaded. Measured on that corpus at V8's default (4144 MB
 * for Node 20 on a host with no memory limit): the main process's heap grew
 * linearly to 4029 MB used of a 4192 MB limit - with the 34 MB
 * aiInterviewService spec NOT loaded (its fetch had timed out, D90). Loaded, it
 * adds about 300 MB more, and V8 aborts the process: "FATAL ERROR: Reached heap
 * limit Allocation failed - JavaScript heap out of memory", SIGABRT. The
 * container had 26-37 GB free; the limit was V8's default, not the machine.
 *
 * So, before vitest starts, the heap its main process will need is estimated
 * from the bytes of spec it will load (HEAP_PER_SPEC_BYTE, measured), and when
 * that comes near the default limit, vitest's main process alone is started
 * with `--max-old-space-size` at half as much again as the estimate
 * (HEAP_MARGIN), never more than the memory still available or HEAP_CAP_MB
 * (the cap D72 set for deadcode). Not "half of what is free": inside a
 * container the page cache of the corpus it just read counts as used, and on
 * a 14 GB container that left 3986 MB for a 4712 MB need. Workers are untouched: vitest
 * passes its own execArgv to them, not this one. A corpus the default is enough
 * for is run exactly as before, so a VM carrying ten runs does not pay for the
 * headroom on every one (D72's lesson: a bigger limit is collected later).
 * A run handed the other files' kept coverage (a partial measurement, D90's
 * lone re-run) builds the whole suite's report, and is sized as the whole
 * suite: on the same corpus, D90's lone re-run of two files (52 MB) with 416
 * chunks handed to it (911 MB of JSON) died of the heap at 2096 MB.
 * An estimate can be short, so a vitest that dies of the heap anyway is run
 * once more at the larger heap, when there is a larger heap to give.
 *
 * `CHARPILOT_MEASURE_HEAP=off` runs vitest at node's default, as before.
 */
import { spawnSync } from "node:child_process";

export const MEASURE_HEAP_ENV = "CHARPILOT_MEASURE_HEAP";
export const measureHeapOn = (env = process.env) => String(env[MEASURE_HEAP_ENV] ?? "").trim().toLowerCase() !== "off";

/**
 * Heap bytes vitest's main process holds per byte of spec it loaded: 4029 MB
 * for 438 MB on qode-ptp-ms (9.2), rounded up.
 */
export const HEAP_PER_SPEC_BYTE = 10;
/** The most heap asked for, as deadcode's retry (steps/deadcode.mjs RETRY_HEAP_CAP_MB). */
export const HEAP_CAP_MB = 8192;
/** The estimate is acted on once it passes this share of the default limit. */
export const HEAP_NEAR = 0.75;
/** The limit asked for is the estimate and half as much again. */
export const HEAP_MARGIN = 1.5;

const MB = 1048576;

/** The main process's estimated need, in MB, for `specBytes` of spec. */
export const heapNeedMB = (specBytes) => Math.ceil((specBytes * HEAP_PER_SPEC_BYTE) / MB);

/**
 * THE HEAP TO START VITEST'S MAIN PROCESS WITH, or null for node's default.
 * `defaultMB` is the limit the target's node would give it (targetHeapLimitMB),
 * `available` the bytes of memory this process could still get.
 */
export function measureHeapPlan({ specBytes, defaultMB, available, env = process.env }) {
  if (!measureHeapOn(env) || !(defaultMB > 0)) return null;
  const needMB = heapNeedMB(specBytes);
  if (needMB <= defaultMB * HEAP_NEAR) return null;
  const mb = Math.min(roomMB(available), Math.ceil(needMB * HEAP_MARGIN));
  if (!(mb > defaultMB)) return null;
  return { mb, defaultMB, needMB, specMB: Math.round(specBytes / MB), how: "upfront" };
}

/** `available`, capped: the most a limit may say, so V8 and not the kernel is the one that refuses. */
export const roomMB = (available) => Math.min(Math.floor(available / MB), HEAP_CAP_MB);

/**
 * THE HEAP FOR ONE MORE RUN after vitest died of the heap at `atMB`, or null
 * when there is no more to give.
 */
export function heapRetryMB({ atMB, available, env = process.env }) {
  if (!measureHeapOn(env)) return null;
  const mb = roomMB(available);
  return mb > atMB ? mb : null;
}

/**
 * The heap limit, in MB, the target's node gives a process under `env` - its
 * NODE_OPTIONS included, so a limit the operator set is the one compared with.
 * Null when it cannot be asked.
 */
export function targetHeapLimitMB(node, env = process.env) {
  const r = spawnSync(node, ["-p", "require('node:v8').getHeapStatistics().heap_size_limit"], { env, encoding: "utf8", timeout: 30_000 });
  const n = Number.parseInt(String(r.stdout ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.round(n / MB) : null;
}

/** V8's own line for running out of heap, as a process that dies of it prints it. */
export const V8_OOM = /FATAL ERROR:.*(?:heap out of memory|heap limit)|Fatal JavaScript (?:out of memory|invalid size error)|JavaScript heap out of memory/i;

/** V8's FATAL line in `stderr`, trimmed, or null. */
export function oomLine(stderr = "") {
  // eslint-disable-next-line no-control-regex
  const line = String(stderr ?? "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").find((l) => V8_OOM.test(l));
  return line ? line.trim() : null;
}

/**
 * WHAT A SIGNAL MEANS, AND WHAT TO DO ABOUT IT: one sentence for the verdict
 * a vitest that died on `signal` leaves. `heap` is the run's heap
 * ({ mb, defaultMB } or null for node's default), `stderrAt` where vitest's
 * whole stderr was kept.
 */
export function signalVerdict({ signal, stderr = "", heap = null, stderrAt = null, env = process.env }) {
  const at = heap?.mb ? `a ${heap.mb} MB heap` : `node's default heap${heap?.defaultMB ? ` (${heap.defaultMB} MB)` : ""}`;
  const read = stderrAt ? `; vitest's whole stderr is in ${stderrAt}` : "";
  const oom = oomLine(stderr);
  if (oom) {
    const next = measureHeapOn(env)
      ? `give the container more memory (vitest's main process may use what is free, at most ${HEAP_CAP_MB} MB), or measure fewer or smaller spec files`
      : `remove ${MEASURE_HEAP_ENV}=off, so vitest's main process is given the heap its spec files need`;
    return `vitest's main process ran out of heap at ${at} (${signal ?? "no signal"}: ${oom}) - it keeps every loaded spec's transform. Next: ${next}${read}`;
  }
  const cause = {
    SIGABRT: `an abort in native code with no V8 FATAL line - most often vitest's main process running out of heap at ${at}`,
    SIGKILL: "killed from outside - the kernel's OOM killer or the container's memory limit, since node never sends it to itself",
    SIGTERM: "stopped from outside - the container shutting down, or a supervisor",
    SIGINT: "interrupted from outside",
    SIGSEGV: "a native crash in node or an addon it loaded",
    SIGBUS: "a native crash in node or an addon it loaded",
  }[signal] ?? "a signal from outside or a native crash";
  const next = {
    SIGABRT: "read vitest's stderr for the line before the native stack, and if it is the heap, give the container more memory",
    SIGKILL: `check the container's memory limit and the host's free memory, or lower CHARPILOT_MEASURE_WORKERS`,
    SIGTERM: "measure again once the container is up",
    SIGINT: "measure again",
    SIGSEGV: "measure again; if it repeats, read vitest's stderr for the crashing module",
    SIGBUS: "measure again; if it repeats, read vitest's stderr for the crashing module",
  }[signal] ?? "measure again, and read vitest's stderr";
  return `vitest was ended by ${signal}: ${cause}. Next: ${next}${read}`;
}
