#!/usr/bin/env node
/**
 * Stage 2, benchmarked against foreign code.
 *
 * The reconcile closes on THIS service. That proves the arm model matches
 * istanbul here; it does not prove the model is a model of TypeScript rather
 * than a model of one Express service. Five TS-specific model errors had to be
 * fixed before it closed the first time, and the only way to find the sixth is
 * to run the SAME scan against code nobody tuned it on.
 *
 *   node .claude/charpilot/bench.mjs [--repos a,b,c] [--files N] [--json out]
 *
 * GROUND TRUTH WITHOUT A TEST SUITE. Running each repo's tests would mean
 * installing it, standing up its database and hoping its suite is green - and a
 * repo whose suite does not run would simply be excluded, which biases the
 * sample towards well-kept repos. Instead each file is put through exactly the
 * transform the real pipeline uses - esbuild TS -> JS, then istanbul
 * instrumentation - and the branchMap, fnMap and statementMap that come out ARE
 * istanbul's denominator. No tests, no install, no database.
 *
 * What is compared, per file and in total:
 *   branch SIDES     sum of branchMap[].locations.length   vs scan's arm sides
 *   FUNCTIONS        fnMap entries                         vs scan's functions
 *   STATEMENTS       statementMap entries                  vs scan (not modelled)
 *
 * Drift is reported by istanbul branch `type` and by scan arm `kind`, because
 * "off by 12" is not actionable and "every `assign-pattern` is missing" is.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { OUT_DIR, SELF_REPO_ROOT } from "./config.mjs";

const BENCH_CONFIG = ".claude/charpilot/bench/vitest.bench.config.mts";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const JSON_OUT = arg("--json", join(OUT_DIR, "bench.json"));

/**
 * The corpus. Internal services first, because they are the fleet this has to
 * work on - a popular public repo is a nice-to-have, an ITL service is the
 * actual customer. Both framework styles, Prisma throughout, 32 to 873 files.
 */
const REPOS_ROOT = "/Users/qode/Desktop/Repo/workspace/qode-knowledge/repos";
const DEFAULT_REPOS = [
  { name: "qode-itl-be", style: "nest" },
  { name: "qode-ptp-ms", style: "express" },
  { name: "sourcing-ms", style: "express" },
  { name: "email-centralization-ms", style: "express" },
  { name: "outreach-thread-ms", style: "express" },
  { name: "pricing-ms", style: "express" },
  { name: "ats-sourcing-service", style: "express" },
  { name: "profile-centralized", style: "express" },
  { name: "notification-ms", style: "express" },
  { name: "interview-service", style: "express" },
  { name: "location-ms", style: "express" },
];

function tsFiles(root) {
  const out = [];
  const src = join(root, "src");
  if (!existsSync(src)) return out;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === "generated") continue;
        walk(p);
      } else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(src);
  return out.sort();
}

/**
 * istanbul's answer for a whole repo, from the REAL toolchain.
 *
 * The first version of this used esbuild + istanbul-lib-instrument directly. It
 * was wrong, and the control run is what caught it: on this repo that proxy
 * reported 1718 branch sides at target es2021 and 1305 at esnext, against a
 * real 1518, and NO esbuild target reproduced the real figure - vitest
 * instruments after vite's whole transform chain, not after a bare esbuild
 * call. A benchmark whose ground truth is off by 13% measures nothing.
 *
 * So this runs vitest with @vitest/coverage-istanbul and `all: true`, which
 * instruments every file in `include` WITHOUT executing it. That is what makes
 * it work on a repo whose suite needs a database, an env file and a green
 * install. Validated against this repo: 1464 branches, 482 functions, 2265
 * statements - identical to `coverage-charpilot`, to the digit.
 */
function istanbulTruth(root) {
  const covDir = join(OUT_DIR, "bench", `${root.split("/").filter(Boolean).pop()}.coverage`);
  const r = spawnSync(
    process.execPath,
    [join(SELF_REPO_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--coverage", "--passWithNoTests", "--config", BENCH_CONFIG],
    {
      cwd: SELF_REPO_ROOT,
      encoding: "utf8",
      timeout: 15 * 60_000,
      env: {
        ...process.env,
        CHARPILOT_BENCH_ROOT: root,
        CHARPILOT_BENCH_COVERAGE: covDir,
        CHARPILOT_BENCH_EXCLUDE: "",
        CHARPILOT_BENCH_SELF: SELF_REPO_ROOT,
      },
    }
  );
  const finalPath = join(covDir, "coverage-final.json");
  if (!existsSync(finalPath)) {
    return { error: (r.stderr || r.stdout || "no coverage written").trim().split("\n").slice(-3).join(" | ").slice(0, 300) };
  }
  const cov = JSON.parse(readFileSync(finalPath, "utf8"));
  const perFile = new Map();
  const totals = { sides: 0, functions: 0, statements: 0, byType: {} };
  for (const [abs, d] of Object.entries(cov)) {
    const file = relative(root, abs);
    let sides = 0;
    for (const b of Object.values(d.branchMap ?? {})) {
      const n = (b.locations ?? []).length;
      sides += n;
      totals.byType[b.type] = (totals.byType[b.type] ?? 0) + n;
    }
    const fns = Object.keys(d.fnMap ?? {}).length;
    const stmts = Object.keys(d.statementMap ?? {}).length;
    perFile.set(file, { sides, functions: fns, statements: stmts });
    totals.sides += sides;
    totals.functions += fns;
    totals.statements += stmts;
  }
  return { perFile, totals };
}

/** Run the REAL scan.mjs against a foreign root. Not a copy of its walk. */
function runScan(root) {
  const out = join(OUT_DIR, "bench", `${root.split("/").filter(Boolean).pop()}.scan.json`);
  mkdirSync(dirname(out), { recursive: true });
  const tsconfig = ["tsconfig.json", "tsconfig.build.json"].find((f) => existsSync(join(root, f)));
  if (!tsconfig) return { error: "no tsconfig.json" };
  const r = spawnSync(process.execPath, [join(SELF_REPO_ROOT, ".claude/charpilot/scan.mjs")], {
    cwd: SELF_REPO_ROOT,
    encoding: "utf8",
    timeout: 10 * 60_000,
    env: { ...process.env, CHARPILOT_TARGET_ROOT: root, CHARPILOT_SCAN_OUT: out, CHARPILOT_TSCONFIG: tsconfig },
  });
  if (!existsSync(out)) {
    return { error: (r.stderr || r.stdout || "scan wrote nothing").trim().split("\n").slice(-3).join(" | ").slice(0, 300) };
  }
  return { doc: JSON.parse(readFileSync(out, "utf8")), tsconfig };
}

function main() {
  const names = arg("--repos") ? arg("--repos").split(",") : DEFAULT_REPOS.map((r) => r.name);
  const styleOf = new Map(DEFAULT_REPOS.map((r) => [r.name, r.style]));
  const results = [];

  for (const name of names) {
    // An absolute path or one containing a slash is taken as-is, so THIS repo
    // can be benched as the control. A harness that disagrees with the one
    // repo whose answer is known is a broken harness, not a broken scan.
    const root = name.includes("/") ? resolve(name) : resolve(REPOS_ROOT, name);
    if (!existsSync(root)) {
      results.push({ name, error: "not on disk" });
      continue;
    }
    process.stdout.write(`· ${name} … `);
    const files = tsFiles(root);
    if (!files.length) {
      process.stdout.write("no src/**/*.ts\n");
      results.push({ name, error: "no src/**/*.ts" });
      continue;
    }

    const t0 = istanbulTruth(root);
    if (t0.error) {
      process.stdout.write(`istanbul truth failed: ${t0.error}\n`);
      results.push({ name, style: styleOf.get(name) ?? "?", files: files.length, error: `truth: ${t0.error}` });
      continue;
    }
    const truth = t0.perFile;
    const truthTotals = t0.totals;
    const unparseable = [];

    const { doc, error, tsconfig } = runScan(root);
    if (error) {
      process.stdout.write(`scan failed: ${error}\n`);
      results.push({ name, style: styleOf.get(name) ?? "?", files: files.length, error, truth: truthTotals });
      continue;
    }

    // scan's answer, per file
    const scanPerFile = new Map();
    const scanKinds = {};
    const counted = (file) => truth.has(file);
    // Seed from the model the RECONCILE uses, not from a count of entries in
    // `functions`. The latter omits the transpile artifacts istanbul does
    // count - downlevelled enums, and the constructor esbuild synthesises for a
    // class with property initializers - so the two sides were measuring
    // different sets, and a fix for exactly that looked like it changed nothing.
    for (const [file, n] of Object.entries(doc.perFileFunctions ?? {})) {
      scanPerFile.set(file, { sides: 0, functions: n });
    }
    // perFileFunctions is ALREADY declared-functions plus artifacts - it starts
    // at the artifact count and increments once per function. Adding one per
    // `functions` entry on top of it double-counts, which a first attempt did:
    // +980 instead of -180.
    for (const fn of doc.functions ?? []) {
      const cur = scanPerFile.get(fn.file) ?? { sides: 0, functions: 0 };
      for (const a of fn.arms?.list ?? []) {
        if (!a.istanbul) continue;
        cur.sides += a.count ?? 1;
        if (counted(fn.file)) scanKinds[a.kind] = (scanKinds[a.kind] ?? 0) + (a.count ?? 1);
      }
      scanPerFile.set(fn.file, cur);
    }
    for (const g of doc.moduleScopeArms ?? []) {
      const cur = scanPerFile.get(g.file) ?? { sides: 0, functions: 0 };
      for (const a of g.list ?? []) {
        if (!a.istanbul) continue;
        cur.sides += a.count ?? 1;
        if (counted(g.file)) scanKinds[a.kind] = (scanKinds[a.kind] ?? 0) + (a.count ?? 1);
      }
      scanPerFile.set(g.file, cur);
    }

    const drift = [];
    for (const [file, t] of truth) {
      // A file only ONE side measured is a file-set difference, not model
      // drift, and folding it in reports a harness mismatch as a defect: a
      // tsconfig that excludes `*.spec.ts` while coverage includes `src/**`
      // gave scan 0 functions against istanbul's 6, and that read as -6 model
      // error. Excluded from the comparison and counted separately, the same
      // way scan-only files already are.
      if (!scanPerFile.has(file)) continue;
      const s = scanPerFile.get(file);
      const dSides = s.sides - t.sides;
      const dFns = s.functions - t.functions;
      if (dSides || dFns) drift.push({ file, sides: [s.sides, t.sides, dSides], functions: [s.functions, t.functions, dFns] });
    }
    // Compare only files BOTH sides measured. scan.mjs always walks the whole
    // ts-morph project, so under --files it would be summed against a truth set
    // of N files - which is how a first run reported functions +113 on an
    // 8-file slice. A comparison across two different denominators is not a
    // comparison.
    const scanTotals = { sides: 0, functions: 0 };
    const truthTotalsShared = { sides: 0, functions: 0, statements: 0 };
    for (const [file, x] of scanPerFile) {
      if (!truth.has(file)) continue;
      scanTotals.sides += x.sides;
      scanTotals.functions += x.functions;
      const t = truth.get(file);
      truthTotalsShared.sides += t.sides;
      truthTotalsShared.functions += t.functions;
      truthTotalsShared.statements += t.statements;
    }
    // Compare on the SHARED file set on both sides, or the totals are drawn
    // from different denominators - which is the mistake this whole benchmark
    // exists to catch.
    truthTotals.sides = truthTotalsShared.sides;
    truthTotals.functions = truthTotalsShared.functions;
    truthTotals.statements = truthTotalsShared.statements;
    const scanOnlyFiles = [...scanPerFile.keys()].filter((f) => !truth.has(f)).length;
    const truthOnlyFiles = [...truth.keys()].filter((f) => !scanPerFile.has(f)).length;

    results.push({
      name,
      style: styleOf.get(name) ?? "?",
      tsconfig,
      files: files.length,
      unparseable,
      truth: truthTotals,
      scan: { ...scanTotals, byKind: scanKinds },
      deltaSides: scanTotals.sides - truthTotals.sides,
      deltaFunctions: scanTotals.functions - truthTotals.functions,
      filesWithDrift: drift.length,
      scanOnlyFiles,
      truthOnlyFiles,
      drift: drift.slice(0, 12),
    });
    process.stdout.write(
      `${files.length} files · sides ${scanTotals.sides} vs ${truthTotals.sides} (${scanTotals.sides - truthTotals.sides >= 0 ? "+" : ""}${scanTotals.sides - truthTotals.sides}) · ` +
        `fns ${scanTotals.functions} vs ${truthTotals.functions} (${scanTotals.functions - truthTotals.functions >= 0 ? "+" : ""}${scanTotals.functions - truthTotals.functions}) · ${drift.length} files drift` +
        `${scanOnlyFiles || truthOnlyFiles ? ` · file sets differ: scan-only ${scanOnlyFiles}, istanbul-only ${truthOnlyFiles}` : ""}\n`
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify({ stage: "2-bench", benchedAt: new Date().toISOString(), esbuildTarget: "es2021", results }, null, 2)}\n`);

  const ok = results.filter((r) => !r.error);
  const out = process.stdout;
  out.write(`\nstage 2 benchmark — the SAME scan.mjs, against ${ok.length} foreign repo(s)\n\n`);
  out.write(`  ${"repo".padEnd(26)}${"style".padEnd(9)}${"files".padStart(6)}${"sides".padStart(9)}${"istanbul".padStart(10)}${"Δ".padStart(7)}${"fns".padStart(7)}${"istanbul".padStart(10)}${"Δ".padStart(7)}${"drift".padStart(7)}\n`);
  for (const r of results) {
    if (r.error) {
      out.write(`  ${r.name.padEnd(26)}${String(r.style ?? "?").padEnd(9)}${String(r.files ?? "-").padStart(6)}   ${r.error}\n`);
      continue;
    }
    out.write(
      `  ${r.name.padEnd(26)}${r.style.padEnd(9)}${String(r.files).padStart(6)}${String(r.scan.sides).padStart(9)}${String(r.truth.sides).padStart(10)}${String(r.deltaSides).padStart(7)}` +
        `${String(r.scan.functions).padStart(7)}${String(r.truth.functions).padStart(10)}${String(r.deltaFunctions).padStart(7)}${String(r.filesWithDrift).padStart(7)}\n`
    );
  }
  const tSides = ok.reduce((n, r) => n + r.truth.sides, 0);
  const sSides = ok.reduce((n, r) => n + r.scan.sides, 0);
  const tFns = ok.reduce((n, r) => n + r.truth.functions, 0);
  const sFns = ok.reduce((n, r) => n + r.scan.functions, 0);
  out.write(`\n  TOTAL  sides ${sSides} vs istanbul ${tSides} (${sSides - tSides >= 0 ? "+" : ""}${sSides - tSides}) · functions ${sFns} vs ${tFns} (${sFns - tFns >= 0 ? "+" : ""}${sFns - tFns})\n`);

  const byType = {};
  for (const r of ok) for (const [k, v] of Object.entries(r.truth.byType)) byType[k] = (byType[k] ?? 0) + v;
  const byKind = {};
  for (const r of ok) for (const [k, v] of Object.entries(r.scan.byKind)) byKind[k] = (byKind[k] ?? 0) + v;
  out.write(`\n  istanbul branch types across the corpus:\n`);
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) out.write(`    ${String(v).padStart(6)}  ${k}\n`);
  out.write(`  scan arm kinds:\n`);
  for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) out.write(`    ${String(v).padStart(6)}  ${k}\n`);
  const unp = ok.flatMap((r) => r.unparseable ?? []);
  if (unp.length) {
    out.write(`\n  ${unp.length} file(s) esbuild could not transform - EXCLUDED from both sides, not silently zeroed:\n`);
    for (const u of unp.slice(0, 6)) out.write(`    ${u.file} — ${u.why}\n`);
  }
  out.write(`\n  written → ${relative(SELF_REPO_ROOT, JSON_OUT)}\n\n`);
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