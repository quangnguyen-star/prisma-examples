#!/usr/bin/env node
/**
 * Run the stage-3 guard chain against a FOREIGN target.
 *
 * `validate.mjs:89` rejects any `from.arm` "which is not an arm in scan.json",
 * and `:195`/`:260` do the same for `covers` and `functionId`. That is correct
 * and it is why a proposal written for another repo cannot be judged here: the
 * scan it is checked against is this service's.
 *
 * So the chain runs per target instead. `CHARPILOT_TARGET_ROOT` redirects
 * SCAN_JSON, WORKLIST_JSON and PROPOSALS_DIR to out/bench/<repo>.* and
 * proposals/bench/<repo>/, leaving this service's own artifacts untouched -
 * which matters, because 16 repos' arm ids collide (`file#line:kind:index`
 * carries no repo) and one shared directory would have the ledger reconciling
 * one repo's proposals against another repo's scan.
 *
 * The coverage report a foreign worklist joins against is the one the benchmark
 * already produced: vitest with `all: true` instruments every file WITHOUT
 * executing it, so every arm reads as uncovered. That is the honest state - we
 * run no tests in these repos - and it means every sampled arm is available to
 * aim at.
 *
 *   node .claude/charpilot/benchguard.mjs --repo location-ms [--step worklist|validate|ledger]
 *   node .claude/charpilot/benchguard.mjs --all
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OUT_DIR, SELF_REPO_ROOT } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const REPOS_ROOT = "/Users/qode/Desktop/Repo/workspace/qode-knowledge/repos";
const PUBLIC_ROOT = "/private/tmp/claude-501/-Users-qode-Desktop-Repo-workspace-ai-centralization-fresh/54885df7-a323-4266-a4a8-3555e6d9df4c/scratchpad/corpus";

function rootOf(name) {
  for (const base of [REPOS_ROOT, PUBLIC_ROOT]) {
    const p = join(base, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function run(script, root, extra = []) {
  const cov = join(OUT_DIR, "bench", `${root.split("/").filter(Boolean).pop()}.coverage`);
  const r = spawnSync(process.execPath, [join(SELF_REPO_ROOT, ".claude/charpilot", script), ...extra], {
    cwd: SELF_REPO_ROOT,
    encoding: "utf8",
    timeout: 10 * 60_000,
    env: { ...process.env, CHARPILOT_TARGET_ROOT: root, CHARPILOT_BENCH_SELF: SELF_REPO_ROOT },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, cov };
}

function one(name) {
  const root = rootOf(name);
  if (!root) return { name, error: "not on disk" };
  const cov = join(OUT_DIR, "bench", `${name}.coverage`);
  if (!existsSync(join(cov, "coverage-final.json"))) {
    return { name, error: `no coverage at out/bench/${name}.coverage — run \`npm run pilot:bench -- --repos ${name}\` first` };
  }
  const scan = join(OUT_DIR, "bench", `${name}.scan.json`);
  if (!existsSync(scan)) return { name, error: `no scan at out/bench/${name}.scan.json — run pilot:bench first` };

  // Seed the target's proposals dir and a BLOCKED.md, or validate reports "no
  // proposals" and ledger reports "BLOCKED.md is missing" as malformed - both
  // true, neither useful. An empty BLOCKED.md is the honest starting state:
  // nothing has been ruled dead yet.
  const pdir = join(SELF_REPO_ROOT, ".claude/charpilot/proposals/bench", name);
  mkdirSync(pdir, { recursive: true });
  const blocked = join(pdir, "BLOCKED.md");
  if (!existsSync(blocked)) {
    writeFileSync(
      blocked,
      `# BLOCKED — ${name}\n\n` +
        `Fenced \`\`\`blocked entries, one per SIDE, for arms in ${name} that no input can\n` +
        `reach. Empty is the correct starting state: nothing has been ruled dead here.\n\n` +
        `Required fields: arm, side, category, killer, proof. Plus fix: when\n` +
        `category is data-blocked. A proof must cite a FACT, not the arm's own line.\n`
    );
  }

  const steps = {};
  const only = arg("--step");
  // ABSOLUTE. worklist.mjs resolves --coverage-dir against REPO_ROOT, which is
  // the foreign target under a bench run, so a repo-relative path sends it
  // looking inside the target for our out/ directory.
  if (!only || only === "worklist") steps.worklist = run("worklist.mjs", root, ["--coverage-dir", cov]);
  if (!only || only === "validate") steps.validate = run("validate.mjs", root);
  if (!only || only === "ledger") steps.ledger = run("ledger.mjs", root);
  return { name, root, steps };
}

const names = ARGV.includes("--all")
  ? readdirSync(join(OUT_DIR, "bench"))
      .filter((n) => n.endsWith(".scan.json"))
      .map((n) => n.replace(".scan.json", ""))
      .filter((n) => n !== "ai-centralization-fresh" && n !== "conformance")
  : [arg("--repo")].filter(Boolean);

if (!names.length) {
  process.stderr.write("\n✗ pass --repo <name> or --all\n\n");
  process.exit(1);
}

const out = process.stdout;
out.write(`\nstage-3 guard, per target\n\n`);
let bad = 0;
for (const name of names) {
  const r = one(name);
  if (r.error) {
    out.write(`  ✗ ${name.padEnd(26)} ${r.error}\n`);
    bad += 1;
    continue;
  }
  const bits = [];
  for (const [step, s] of Object.entries(r.steps)) {
    const first = s.out.split("\n").find((l) => /✓|✗|!|UNACCOUNTED|error|Error/.test(l))?.trim().slice(0, 84) ?? "(no output)";
    bits.push(`${step}=${s.code === 0 ? "ok" : `exit ${s.code}`}`);
    if (s.code !== 0) bad += 1;
    out.write(`  ${s.code === 0 ? "✓" : "✗"} ${name.padEnd(26)}${step.padEnd(10)}${first}\n`);
  }
}
out.write(`\n  ${names.length} target(s) · ${bad} failing step(s)\n\n`);
process.exitCode = bad ? 1 : 0;
