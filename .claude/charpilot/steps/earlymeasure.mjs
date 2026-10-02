/**
 * ITEM 1 - MEASURE ALONGSIDE THE GATE.
 *
 * qode-ptp-ms, run 20260930T033300Z: the resumed first walk spent 45 minutes
 * in `emit` (cigate over 414 spec files) and then 17 in `measure`
 * (coverage.mjs over the same files under istanbul), one after the other.
 * Neither reads what the other writes: cigate writes out/cigate.json and the
 * quarantine, coverage.mjs writes out/coverage.json, its chunk store and
 * coverage-charpilot-stage6/. What makes measure wait for the gate is that a
 * withhold re-emits the suite, and a measurement of the suite before that
 * re-emit is a measurement of tests that no longer exist.
 *
 * So `emit` starts the measurement the walk's `measure` visit would run, with
 * the same arguments, as soon as the suite is emitted and before cigate runs.
 *
 *   - cigate withholds nothing: the suite measured is the suite delivered, and
 *     `measure` adopts this measurement instead of running its own. Checked
 *     from the disk, not assumed: emitted.json's digest must be the one the
 *     measurement started over.
 *   - cigate withholds a row: before anything is re-emitted (ciGate's
 *     `onWithhold`), the measurement is stopped - its whole process tree, and
 *     the ledger row it would have added is dropped - and `measure` runs as
 *     today over the re-emitted suite.
 *
 * WHAT IS NEVER ADOPTED, and is measured again as today: a measurement that
 * exited on "the suite under measurement did not pass" (it ran beside the
 * gate, and a test red only under that load is not the suite's verdict), one
 * that wrote no join, and one killed by a signal. A false-claim or claims-floor
 * refusal is the tool's verdict on the suite, whatever ran beside it, and is
 * adopted and handed over exactly as `measure` would have.
 *
 * THE LEDGER ROW. coverage.mjs appends one row to out/loop.json per
 * measurement, and a stopped or discarded measurement must not leave one (two
 * flat rows in a row are a STOP in gate.mjs). So it runs with
 * CHARPILOT_COVERAGE_LEDGER_ROW, which makes coverage.mjs write that row to a
 * file of its own (and clear the one a stopped run left); adopting runs
 * `coverage.mjs --adopt-ledger-row`, and the tool appends it. Like every step,
 * this one writes nothing itself (steps.never-repair-a-tools-output): the
 * tool's output comes back on pipes, and the row file is the tool's.
 *
 * Every walk, the bank walk included: the bank walk's gate is full and in one
 * process whatever runs beside it, and a measurement it adopts is of the suite
 * it delivers. Armed only by workflow.mjs, when `measure` follows `emit` in
 * the walk's order. CHARPILOT_MEASURE_WITH_GATE=off is the kill switch.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { OUT_DIR, PILOT_DIR, SELF_REPO_ROOT } from "../config.mjs";

export const MEASURE_WITH_GATE_ENV = "CHARPILOT_MEASURE_WITH_GATE";
export const LEDGER_ROW_ENV = "CHARPILOT_COVERAGE_LEDGER_ROW";
export const on = (env = process.env) => String(env[MEASURE_WITH_GATE_ENV] ?? "").trim().toLowerCase() !== "off";

const ROW = join(OUT_DIR, ".measure-early-row.json");
/** What is kept of the tool's output: its last lines are the reason a refusal names. */
const KEEP = 64 * 1024;

/** What the walk armed this with: the measure step's precondition and its arguments. */
let armed = null;
/** The measurement running or finished: { child, exited, args, startedAt, digest, status, signal, stopped }. */
let early = null;

export function arm({ precondition, args }) {
  armed = { precondition, args };
}

/** The walk is over: a measurement still running is stopped, and nothing is left for another walk. */
export function disarm() {
  if (early && early.status === undefined) stopTree(early.child.pid);
  armed = null;
  early = null;
}

/**
 * Start the measurement, if armed, switched on and `measure` could run now.
 * `digest` is emitted.json's, which adoption checks is still the suite's.
 * Returns the line to log, or null when nothing was started.
 */
export function start(repo, digest, env = process.env, script = resolve(PILOT_DIR, "coverage.mjs")) {
  if (!armed || !on(env) || early) return null;
  let blocker;
  try {
    blocker = armed.precondition(repo);
  } catch (err) {
    blocker = err?.message ?? String(err);
  }
  if (blocker) return null;
  if (!existsSync(script)) return null;
  // NOT detached: a walk killed at its limit is killed as a process group
  // (docker/char/proc.py), and this measurement goes with it. Its output is a
  // summary of a few KB, well inside a pipe's buffer while the gate holds the
  // walk's event loop; were it not, it would wait for the loop and lose only
  // the overlap, never a byte.
  const child = spawn(process.execPath, [script, ...armed.args], {
    cwd: SELF_REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, [LEDGER_ROW_ENV]: ROW },
  });
  const state = { child, script, args: armed.args, startedAt: Date.now(), digest, status: undefined, signal: null, stopped: null, out: "", err: "" };
  child.stdout.on("data", (b) => { state.out = (state.out + b).slice(-KEEP); });
  child.stderr.on("data", (b) => { state.err = (state.err + b).slice(-KEEP); });
  state.exited = new Promise((done) => {
    child.on("close", (status, signal) => {
      state.status = status;
      state.signal = signal;
      done();
    });
    child.on("error", (e) => {
      state.status = null;
      state.signal = `spawn failed: ${e.message}`;
      done();
    });
  });
  early = state;
  return `started coverage.mjs${armed.args.length ? ` ${armed.args.join(" ")}` : ""} beside cigate (${MEASURE_WITH_GATE_ENV}=off runs it after the gate) - kept if cigate withholds nothing`;
}

/** A measurement is waiting for `measure` to adopt it. */
export function pending() {
  return Boolean(early && !early.stopped);
}

/** cigate withheld rows: the suite is about to be re-emitted, so the measurement is stopped and dropped. */
export function stop(why) {
  if (!early || early.stopped) return null;
  const running = early.status === undefined;
  if (running) stopTree(early.child.pid);
  early.stopped = why;
  return `the measurement started beside cigate is ${running ? "stopped" : "dropped"} - ${why}; measure runs after the re-emit, as before`;
}

/**
 * Wait for the measurement and say whether it stands. Resolves to
 * { adopted: true, cov, since, line } with `cov` shaped like runTool's result,
 * or { adopted: false, why }. `digestNow` is emitted.json's digest now.
 */
export async function adopt(digestNow, readJoin) {
  if (!pending()) return { adopted: false, why: "no measurement was started beside the gate" };
  const e = early;
  await e.exited;
  early = { ...e, stopped: "adopted or refused" };
  const refuse = (why) => ({ adopted: false, why });
  if (e.signal) return refuse(`it ended on ${e.signal}`);
  if (digestNow !== e.digest) return refuse("the suite was re-emitted after it started");
  const doc = readJoin(e.startedAt);
  if (!doc) return refuse(`coverage.mjs exited ${e.status} and wrote no join`);
  if (e.status !== 0 && !["false-claims", "claims-floor"].includes(doc.refused)) {
    return refuse(`coverage.mjs exited ${e.status} (${doc.refused ?? "no refusal named"}), which a run beside the gate may cause - measured again alone`);
  }
  let rowLine = null;
  // Only the row THIS measurement wrote: coverage.mjs clears a stopped run's
  // on start, and a row older than this start is not this measurement's
  // (less a second, for whole-second mtimes). coverage.mjs writes one on every
  // outcome but the claims floor, which it refuses before the ledger; one
  // missing otherwise is a measurement the ledger would not hear of.
  const row = existsSync(ROW) && statSync(ROW).mtimeMs >= e.startedAt - 1000;
  if (!row && doc.refused !== "claims-floor") return refuse("it wrote no ledger row - measured again, so out/loop.json hears of it");
  if (row) {
    const r = spawnSync(process.execPath, [e.script, "--adopt-ledger-row", ROW], { cwd: SELF_REPO_ROOT, encoding: "utf8" });
    rowLine = r.status === 0 ? null : `the ledger row could not be appended (coverage.mjs --adopt-ledger-row exited ${r.status}): ${(r.stderr ?? "").trim().slice(-300)}`;
  }
  const said = `ran coverage.mjs${e.args.length ? ` ${e.args.join(" ")}` : ""} beside cigate, which withheld nothing - adopted, ${Math.round((Date.now() - e.startedAt) / 1000)}s after it started`;
  const why = e.status === 0 ? null : tailOf(e.err) || tailOf(e.out);
  return {
    adopted: true,
    since: e.startedAt,
    rowLine,
    cov: { ok: e.status === 0, status: e.status, line: e.status === 0 ? said : `coverage.mjs exited ${e.status} — ${why}` },
    said,
  };
}

const tailOf = (text) => text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-4).join(" · ");

/**
 * Stop a process and everything it started, and return once none of them is
 * running. coverage.mjs runs vitest, which runs workers: killing coverage.mjs
 * alone would leave a vitest writing coverage-final.json over the suite the
 * re-emit is about to render. A zombie is not running.
 */
export function stopTree(root, { ps = psTable, kill = (pid) => process.kill(pid, "SIGKILL"), sleep = sleepMs } = {}) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const live = descendants(root, ps()).filter((p) => !p.zombie);
    if (!live.length) return true;
    for (const p of live) {
      try {
        kill(p.pid);
      } catch {
        /* gone already */
      }
    }
    sleep(100);
  }
  return false;
}

/** `root` and every process under it, from a `ps` table: [{ pid, ppid, zombie }]. */
export function descendants(root, table) {
  const out = [];
  const seen = new Set();
  const queue = [root];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = table.find((p) => p.pid === pid);
    if (row) out.push(row);
    for (const c of table) if (c.ppid === pid) queue.push(c.pid);
  }
  return out;
}

function psTable() {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat="], { encoding: "utf8" });
  return String(r.stdout ?? "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 3)
    .map(([pid, ppid, stat]) => ({ pid: Number(pid), ppid: Number(ppid), zombie: stat.startsWith("Z") }));
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
