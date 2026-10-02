/**
 * deadcode — the exports nothing in this repo reaches, priced BEFORE anybody
 * derives an input for one of their branches.
 *
 * Order matters here and it is why this sits between scan and worklist: an
 * uncovered arm inside an export no caller reaches is not an input anyone can
 * write, and finding that out after deriving it is the expensive way round.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getHeapStatistics } from "node:v8";

import { OUT_DIR, SCAN_JSON } from "../config.mjs";
import { check as freshnessOf } from "../freshness.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "deadcode";

/** Where deadcode.mjs writes, fixed at deadcode.mjs:32; config.mjs does not export it. */
export const DEAD_EXPORTS_JSON = resolve(OUT_DIR, "dead-exports.json");

/**
 * deadcode.mjs reads SCAN_JSON at deadcode.mjs:43 with no existence check, so
 * without it the tool dies on ENOENT naming a path and not a stage.
 */
export function precondition(_repo) {
  if (!existsSync(SCAN_JSON)) return `${here(SCAN_JSON)} is missing — deadcode.mjs reads the scan's function model`;
  return null;
}

/**
 * THE DISK, not a state file — AND NOT MERELY THAT THE FILE IS THERE.
 *
 * WHAT THIS USED TO ASK: `existsSync(DEAD_EXPORTS_JSON)`, full stop. That is
 * true of a dead-exports.json produced against a `src/` that has since been
 * rewritten, and it is true for ever once written, so the step reports itself
 * done and the walk carries on.
 *
 * WHAT THAT COSTS, and it is worse than a crash because the walk EXITS 0.
 * `dead-exports.json` is what `coverage.mjs` removes from the denominator to
 * compute the live-code rate the target is judged against, and `worklist`
 * reads it to decide which uncovered arms are worth deriving an input for at
 * all. A stale copy names exports that are now reached and misses ones that are
 * not, so the run derives inputs for branches nobody calls, prices the
 * denominator wrong, and reports a number. Nothing anywhere says the number
 * describes a tree that no longer exists.
 *
 * freshness.mjs has TRACKED this artifact by name since it was written —
 * `{ file: "dead-exports.json", stage: "2b" }` — and only `baseline` and `scan`
 * ever called it. Its own docblock says to call it "at the top of any stage
 * that reads an artifact it did not just produce". This is that call.
 *
 * IT IS FIXABLE BY RUNNING, which is the test for whether a predicate may
 * refuse on it: `run` spawns deadcode.mjs, which rewrites the artifact against
 * the `src/` on disk now, and the next question answers fresh.
 */
export function satisfied(_repo) {
  if (!existsSync(DEAD_EXPORTS_JSON)) return false;
  return freshnessOf("dead-exports.json").state === "fresh";
}

/** The most heap the retry asks for. The tool needed about 3.1 GB live on qode-ptp-ms after D72. */
export const RETRY_HEAP_CAP_MB = 8192;

/**
 * The heap for ONE retry after an out-of-memory, or null when there is no
 * room for one: half the memory this process could still get, capped, and
 * only when that beats the default limit it already died at.
 *
 * A retry, not a bigger heap on every run (D72). With a 12 GB limit V8
 * collected later, so the same run peaked at 8.2 GB RSS instead of 4.2 GB, and
 * a VM carries ten runs at once. The default is kept for the ordinary case,
 * and the headroom is spent only when the default was not enough.
 */
export function retryHeapMB(available = process.availableMemory(), defaultMB = getHeapStatistics().heap_size_limit / 1048576) {
  const half = Math.floor(available / 2 / 1048576);
  const mb = Math.min(half, RETRY_HEAP_CAP_MB);
  return mb > defaultMB ? mb : null;
}

export function run(_repo) {
  const first = runTool("deadcode");
  const heap = first.oom ? retryHeapMB() : null;
  if (!heap) return runToolsFrom([first]);
  return runToolsFrom([first, runTool("deadcode", [], { nodeArgs: [`--max-old-space-size=${heap}`] })]);
}

/** runTools' report, for outcomes already in hand. */
function runToolsFrom(outcomes) {
  const did = outcomes.map((o) => o.line).filter(Boolean);
  if (outcomes.at(-1).ok && existsSync(DEAD_EXPORTS_JSON)) did.push(`wrote ${here(DEAD_EXPORTS_JSON)}`);
  return { did, pending: [], metrics: {} };
}
