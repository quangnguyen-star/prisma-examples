#!/usr/bin/env node
/**
 * One shared freshness guard.
 *
 * Every wrong number in this pilot traced back to the same shape: an artifact
 * that described a `src/` older than the one on disk, read as fact by the stage
 * downstream of it. `out/baseline.json` froze at a denominator of 1460 and the
 * reconcile then reported five "drifting" files that were really measuring the
 * artifact's age; a suppression staled four artifacts at once and two gave no
 * signal at all. Nothing refused to read any of them.
 *
 * So: two questions, both cheap, and neither of them a judgement call.
 *
 *   1. Is the artifact older than the newest file in `src/`?
 *   2. Does the git sha it recorded still equal HEAD?
 *
 * A `stale` answer is not "probably fine". The whole point of an artifact is
 * that a later stage trusts it without re-deriving it.
 *
 *   node .claude/charpilot/freshness.mjs            # report every artifact
 *   node .claude/charpilot/freshness.mjs --json
 *
 * Import `assertFresh` to make a stage refuse rather than warn.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { CORPUS_REL, OUT_DIR, REPO_ROOT, SRC_ROOT } from "./config.mjs";

/** The artifacts a later stage reads as fact, in the order they are produced. */
export const TRACKED = [
  { file: "baseline.json", stage: 1, producedBy: "npm run pilot:baseline" },
  { file: "staging-env.json", stage: 1, producedBy: "npm run pilot:stagingenv -- --iac <qode-iac>" },
  { file: "scan.json", stage: 2, producedBy: "npm run pilot:scan" },
  { file: "armids.json", stage: 2, producedBy: "npm run pilot:scan" },
  { file: "dead-exports.json", stage: "2b", producedBy: "npm run pilot:deadcode" },
  { file: "entry-verify.json", stage: "2a", producedBy: "node .claude/charpilot/verify.mjs" },
  { file: "worklist.json", stage: 3, producedBy: "npm run pilot:worklist" },
  { file: "behaviour.json", stage: 4, producedBy: "npm run pilot:record" },
  // The two VERDICT artifacts. Missed on the first pass, and they are the ones
  // where staleness is hardest to notice: a verdict file older than the
  // behaviour.json it judges is describing a previous recording, and nothing
  // in the row it judged says so. determinism.json is currently two days older.
  { file: "determinism.json", stage: 4, producedBy: "node .claude/charpilot/determinism.mjs" },
  { file: "quarantine.json", stage: 5, producedBy: "node .claude/charpilot/quarantine.mjs" },
  { file: "emitted.json", stage: 5, producedBy: "npm run pilot:record -- --emit-tests", dir: CORPUS_REL },
  { file: "coverage.json", stage: 6, producedBy: "npm run pilot:coverage" },
];

/** The newest mtime under src/, and which file it was. */
export function srcNewest() {
  let newest = { mtimeMs: 0, file: null };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.ts$/.test(e.name)) continue;
      const { mtimeMs } = statSync(p);
      if (mtimeMs > newest.mtimeMs) newest = { mtimeMs, file: relative(REPO_ROOT, p) };
    }
  };
  walk(SRC_ROOT);
  return newest;
}

/**
 * D61 — WHAT MADE AN ARTIFACT, as well as what it was made from.
 *
 * The two questions above ask whether an artifact describes the `src/` on disk.
 * Neither asks whether the TOOL that wrote it is the tool installed now, and for
 * the scan that is the question that matters after a fix: D58 changed how
 * scan.mjs resolves a via, sourcing-ms was resumed under the fixed image, and
 * `scan: already done` kept the old scan.json and its 16 unresolved vias,
 * because the tree and HEAD had not moved. The sha256 of the tool's own bytes,
 * or null when it cannot be read. Read by scan.mjs of itself when it writes, and
 * by steps/scan.mjs of the installed copy when it asks - one function, so the
 * two cannot hash different things.
 */
export function toolDigest(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

export function headSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * Every artifact carries its sha under a different key, because each was added
 * by a different stage. Read all of them rather than making one of them right.
 */
function recordedSha(doc) {
  return doc?.environment?.gitSha ?? doc?.gitSha ?? doc?.environment?.sha ?? doc?.head ?? null;
}

/** One artifact's verdict. Never throws — `assertFresh` is what refuses. */
export function check(file, { head = headSha(), src = srcNewest(), dir } = {}) {
  const path = dir ? join(REPO_ROOT, dir, file) : join(OUT_DIR, file);
  if (!existsSync(path)) return { file, state: "missing", reason: "artifact does not exist" };

  const mtimeMs = statSync(path).mtimeMs;
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { file, state: "unreadable", reason: "not parseable JSON", mtimeMs };
  }

  const sha = recordedSha(doc);
  const olderThanSrc = mtimeMs < src.mtimeMs;
  const shaDrift = Boolean(sha && head && sha !== head);

  if (olderThanSrc) {
    return {
      file, state: "stale", mtimeMs, sha,
      reason: `older than ${src.file} (${new Date(mtimeMs).toISOString()} < ${new Date(src.mtimeMs).toISOString()})`,
    };
  }
  if (shaDrift) {
    return { file, state: "stale", mtimeMs, sha, reason: `recorded ${sha.slice(0, 8)}, HEAD is ${head.slice(0, 8)}` };
  }
  return { file, state: "fresh", mtimeMs, sha: sha ?? null, reason: sha ? `at HEAD, newer than src/` : "newer than src/ (records no sha)" };
}

export function all() {
  const head = headSha();
  const src = srcNewest();
  return { head, src, results: TRACKED.map((t) => ({ ...t, ...check(t.file, { head, src, dir: t.dir }) })) };
}

/**
 * Refuse rather than warn. Call this at the top of any stage that reads an
 * artifact it did not just produce.
 */
export function assertFresh(file) {
  const r = check(file, { dir: TRACKED.find((x) => x.file === file)?.dir });
  if (r.state === "fresh") return r;
  const t = TRACKED.find((x) => x.file === file);
  throw new Error(
    `out/${file} is ${r.state}: ${r.reason}. ` +
      `Re-run ${t?.producedBy ?? "the stage that produces it"} — a stage must not read an artifact ` +
      `describing a src/ that no longer exists.`
  );
}

function main() {
  const { head, src, results } = all();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ head, src, results }, null, 2)}\n`);
    return;
  }
  const out = process.stdout;
  out.write(`\nfreshness — HEAD ${head?.slice(0, 8) ?? "(unknown)"} · newest src/ file ${src.file}\n\n`);
  for (const r of results) {
    const mark = r.state === "fresh" ? "✓" : r.state === "missing" ? "·" : "✗";
    out.write(`  ${mark} ${String(r.file).padEnd(20)}${`stage ${r.stage}`.padEnd(10)}${r.state.padEnd(11)}${r.reason}\n`);
  }
  const stale = results.filter((r) => r.state === "stale" || r.state === "unreadable");
  out.write(`\n  ${results.filter((r) => r.state === "fresh").length} fresh · ${stale.length} stale · ${results.filter((r) => r.state === "missing").length} missing\n`);
  if (stale.length) {
    out.write(`\n  A stale artifact is not "probably fine" — a later stage trusts it without\n  re-deriving it. Re-run:\n`);
    for (const r of stale) out.write(`    ${results.find((x) => x.file === r.file)?.producedBy}\n`);
  }
  out.write("\n");
  process.exitCode = stale.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
