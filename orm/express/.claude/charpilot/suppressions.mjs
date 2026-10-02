#!/usr/bin/env node
/**
 * Stage 7 - every `istanbul ignore` in src, what it removed, and who ruled it.
 *
 * The plan said dead code "leaves the denominator" and stopped there. What it
 * did not say, and what cost the most to learn, is that a suppression is never
 * surgical: `istanbul ignore next` is scoped to a STATEMENT, so it takes every
 * branch side in that statement, not the one you meant. Measured on a throwaway
 * probe with an object-literal argument whose properties are `??` expressions:
 *
 *   directive before the property   3 branch locations left, dead side still [2,0]
 *   directive before the statement  0 branch locations left
 *
 * So a property-level directive is INERT, there is no narrower placement than
 * the enclosing statement, and the only honest way to run stage 7 is to price
 * each suppression before accepting it. This pilot gave up 36 exercised sides
 * across six directives to reach 100%, deliberately - and that number has to be
 * reprinted every run, or the 100% quietly becomes the whole story.
 *
 * Suppressed sides are MEASURED, not declared: an AST arm that `scan.mjs` says
 * istanbul models, with no matching branch location in the coverage report, was
 * removed by a directive. Each is attributed to the nearest directive above it
 * in the same file. A declared cost that disagrees with this is the declaration
 * being wrong.
 *
 *   node .claude/charpilot/suppressions.mjs [--coverage <dir>]
 *
 * Exit 1 if any directive lacks `-- @preserve`, lacks the standing instruction,
 * or has no fenced entry in proposals/BLOCKED.md.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { COVERAGE_DIR as BASELINE_COVERAGE_DIR, REPO_ROOT, SCAN_JSON, SRC_ROOT, isSrcExcluded } from "./config.mjs";

const ARGV = process.argv.slice(2);
/**
 * Which report prices a directive, and why the default is not simply `coverage`.
 *
 * A suppression's cost is "how many sides left the denominator", so it can only
 * be measured against a report built over ALL of `src/` - which is what stage 1
 * produces, because it forces `coverage.all` and `include`. A repo's own
 * `coverage/` is whatever its own script happened to write, and on a repo that
 * has never run one it does not exist at all: the reconcile check then reported
 * `coverage/coverage-final.json missing` on a freshly onboarded repo and the
 * three-term identity could not close, which reads as drift rather than as a
 * missing input.
 *
 * So: stage 1's directory first, the repo's own second, and the one actually
 * used is named in the output rather than assumed.
 */
const COVERAGE_CANDIDATES = [relative(REPO_ROOT, BASELINE_COVERAGE_DIR), "coverage"];
const COVERAGE_DIR = ARGV.includes("--coverage")
  ? ARGV[ARGV.indexOf("--coverage") + 1]
  : COVERAGE_CANDIDATES.find((d) => existsSync(join(REPO_ROOT, d, "coverage-final.json"))) ?? COVERAGE_CANDIDATES[0];

const BLOCKED_MD = join(REPO_ROOT, ".claude/charpilot/proposals/BLOCKED.md");
const CLAUSE = "REACHABLE NOW?";

/**
 * Every .ts the scan walks, so a directive cannot hide in a file nobody listed.
 *
 * THE SAME FILE SET AS THE SCAN, not every .ts under SRC_ROOT. A repo whose
 * code sits at the root (SRC_DIR ".") made this walk node_modules: contact-ms's
 * run on 2026-09-25 asked about `istanbul ignore` directives in
 * node_modules/@babel/parser/typings/babel-parser.d.ts every round from round
 * 29 to 40, and nothing a turn writes can change a dependency's file. The
 * ts-morph walks are bounded by SRC_EXCLUDE (node_modules, build output and
 * declarations for a root layout), so this one is too; `.d.ts` is skipped
 * everywhere because a declaration has no runtime code to ignore.
 */
export function srcFiles(dir = SRC_ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    const rel = relative(REPO_ROOT, p);
    if (statSync(p).isDirectory()) srcFiles(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !isSrcExcluded(rel)) out.push(rel);
  }
  return out;
}

/** Directives, with the two hygiene facts checkable from the text itself. */
function directives() {
  const out = [];
  for (const file of srcFiles()) {
    const lines = readFileSync(join(REPO_ROOT, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const m = text.match(/istanbul ignore (next|else|file)/);
      if (!m) return;
      // The clause may sit on a later line of a block comment, so read to the
      // close of the comment rather than looking at one line.
      let j = i;
      while (j < lines.length && !lines[j].includes("*/")) j += 1;
      const body = lines.slice(i, Math.min(j + 1, lines.length)).join("\n");
      out.push({
        file,
        line: i + 1,
        kind: m[1],
        preserve: text.includes("-- @preserve"),
        clause: body.includes(CLAUSE),
      });
    });
  }
  return out;
}

/**
 * Sides a directive removed, measured against the coverage report.
 */
function suppressedSides(coverageDir) {
  const covFile = join(REPO_ROOT, coverageDir, "coverage-final.json");
  if (!existsSync(covFile)) {
    return {
      gone: new Map(),
      error:
        `no coverage-final.json in ${COVERAGE_CANDIDATES.join(" or ")} - a directive's cost can only be measured ` +
        `against a report built over ALL of src/, so run \`npm run pilot:baseline\` (which forces coverage.all) ` +
        `or pass --coverage <dir>`,
    };
  }
  const cov = JSON.parse(readFileSync(covFile, "utf8"));
  const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));

  const instrumented = new Map();
  for (const [abs, d] of Object.entries(cov)) {
    const rel = relKey(abs, REPO_ROOT);
    const perLine = instrumented.get(rel) ?? new Map();
    for (const bm of Object.values(d.branchMap)) {
      const L = bm.loc.start.line;
      // SIDES, not locations. A branchMap entry is one decision point holding
      // one entry per side in `locations`; the scan's arms carry the same total
      // as `count`. Counting entries instead priced every surgical operand
      // placement at 0 - AST 1 location, istanbul 1 location, difference 0 -
      // and those are exactly the placements we got right. Weighted, the two
      // agree: sum(count) 1518 - sum(locations) 1449 = 69.
      perLine.set(L, (perLine.get(L) ?? 0) + bm.locations.length);
    }
    instrumented.set(rel, perLine);
  }

  const arms = scan.functions
    .flatMap((f) => f.arms?.list ?? [])
    .concat((scan.moduleScopeArms ?? []).flatMap((g) => g.list ?? []));

  const perLine = new Map();
  for (const a of arms) {
    if (!a.istanbul) continue;
    const file = a.armId.split("#")[0];
    const k = `${file}\u0000${a.line}`;
    perLine.set(k, (perLine.get(k) ?? 0) + (a.count ?? 1));
  }

  const gone = new Map();
  for (const [k, n] of perLine) {
    const [file, lineStr] = k.split("\u0000");
    const have = instrumented.get(file)?.get(Number(lineStr)) ?? 0;
    if (n > have) {
      const list = gone.get(file) ?? [];
      list.push({ line: Number(lineStr), sides: n - have });
      gone.set(file, list);
    }
  }
  return { gone };
}

/**
 * The same measurement for FUNCTIONS, which leave the denominator exactly as
 * arms do.
 *
 * `istanbul ignore next` above a function does not mark its fnMap entry
 * `skip: true` - it DELETES the entry. Probed against istanbul-lib-instrument
 * 6.0.3, which is what the coverage provider runs:
 *
 *   no directive                 fnMap 2   branchMap 2   locations 4
 *   ignore next on a function    fnMap 1   branchMap 1   locations 2
 *   ignore file                  fnMap 0   branchMap 0   locations 0
 *
 * So the functions reconcile needs the same third term the arms reconcile
 * already has. Without it, `ast == istanbul` is only true of a repo carrying no
 * function-level directive, and every repo that carries one reports drift the
 * scan cannot be fixed to remove - because the scan is right and the identity
 * was wrong.
 *
 * The join is per (file, line) against `scan.perFileFunctionLines`, which keys
 * each function on the line istanbul uses rather than the line ts-morph starts
 * it at. Those differ for a decorated member, and on a Nest repo that is most
 * of the file.
 */
function suppressedFunctions(coverageDir) {
  const covFile = join(REPO_ROOT, coverageDir, "coverage-final.json");
  if (!existsSync(covFile)) return { gone: new Map(), error: undefined };
  const cov = JSON.parse(readFileSync(covFile, "utf8"));
  const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));

  const perFileLines = scan.perFileFunctionLines;
  if (!perFileLines) {
    return {
      gone: new Map(),
      error:
        "out/scan.json has no perFileFunctionLines - it was written by a scan older than the " +
        "function-suppression term. Re-run `npm run pilot:scan`",
    };
  }

  const instrumented = new Map();
  for (const [abs, d] of Object.entries(cov)) {
    const rel = relKey(abs, REPO_ROOT);
    const perLine = new Map();
    for (const fn of Object.values(d.fnMap ?? {})) {
      const L = fn.decl?.start?.line ?? fn.loc?.start?.line;
      if (L === undefined) continue;
      perLine.set(L, (perLine.get(L) ?? 0) + 1);
    }
    instrumented.set(rel, perLine);
  }

  const gone = new Map();
  for (const [file, lines] of Object.entries(perFileLines)) {
    for (const [lineStr, n] of Object.entries(lines)) {
      const line = Number(lineStr);
      const have = instrumented.get(file)?.get(line) ?? 0;
      if (n > have) {
        const list = gone.get(file) ?? [];
        list.push({ line, functions: n - have });
        gone.set(file, list);
      }
    }
  }
  return { gone, error: undefined };
}

/**
 * A coverage key, as a path relative to the repo - through any symlink.
 *
 * istanbul writes ABSOLUTE keys, and the obvious `abs.replace(ROOT + "/", "")`
 * silently does nothing when the two spellings differ. They differ whenever the
 * repo is reached through a symlink: on macOS `/var` IS one, so a checkout under
 * a temp directory has `process.cwd()` resolved to `/private/var/...` while the
 * report holds `/var/...`.
 *
 * The failure is silent AND it points the wrong way. An unmatched key leaves the
 * file with no instrumented lines at all, so every arm and every function the
 * scan models inside a directive's scope reads as "removed by that directive" -
 * the suppressed term is over-counted, and an identity that should have failed
 * closes. Caught by this pipeline's own fixture, where two functions were priced
 * against one real directive and `ast - suppressed` came out one BELOW istanbul.
 */
function relKey(abs, root) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return relative(real(root), real(abs));
}

/** Which BLOCKED.md entries name an arm in which file, by line. */
function blockedByFile() {
  const byFile = new Map();
  if (!existsSync(BLOCKED_MD)) return byFile;
  const text = readFileSync(BLOCKED_MD, "utf8");
  for (const [, body] of text.matchAll(/```blocked\n([\s\S]*?)```/g)) {
    const arm = body.match(/^arm:\s*(\S+)/m)?.[1];
    if (!arm) continue;
    const [file, rest] = arm.split("#");
    const list = byFile.get(file) ?? [];
    list.push({
      line: Number(rest?.split(":")[0]),
      arm,
      killer: body.match(/^killer:\s*(\S+)/m)?.[1],
      side: body.match(/^side:\s*(.+)$/m)?.[1]?.trim(),
    });
    byFile.set(file, list);
  }
  return byFile;
}

/** The rows, priced. Exported so gate.mjs reports the same numbers. */
export function priced(coverageDir = COVERAGE_DIR) {
  const ds = directives();
  const { gone, error } = suppressedSides(coverageDir);
  const { gone: goneFns, error: fnError } = suppressedFunctions(coverageDir);
  const blocked = blockedByFile();
  const rows = ds.map((d) => {
    const inFile = ds.filter((x) => x.file === d.file).map((x) => x.line).sort((a, b) => a - b);
    const next = inFile.find((l) => l > d.line) ?? Infinity;
    // The lines this directive actually removed sides from - not "everything up
    // to the next directive", which is the rest of the file when a file has one
    // directive. mutants.mjs audits exactly these lines, so it must be these.
    const lines = (gone.get(d.file) ?? []).filter((g) => g.line >= d.line && g.line < next);
    const sides = lines.reduce((n, g) => n + g.sides, 0);
    const fnLines = (goneFns.get(d.file) ?? []).filter((g) => g.line >= d.line && g.line < next);
    const functions = fnLines.reduce((n, g) => n + g.functions, 0);
    const entry = (blocked.get(d.file) ?? []).find((b) => b.line >= d.line && b.line < next);
    const problems = [];
    if (!d.preserve) problems.push("no -- @preserve (esbuild strips it; the ignore does nothing)");
    if (!d.clause) problems.push("no standing instruction");
    if (!entry) problems.push("no BLOCKED.md entry");
    return { ...d, sides, lines, functions, fnLines, entry, problems, id: `${d.file}:${d.line}` };
  });
  return {
    rows,
    total: rows.reduce((n, r) => n + r.sides, 0),
    totalFunctions: rows.reduce((n, r) => n + r.functions, 0),
    error,
    fnError,
  };
}

function main() {
  const { rows, total, totalFunctions, error, fnError } = priced();
  process.stdout.write(`\nstage 7 - suppressions (${COVERAGE_DIR})\n\n`);
  if (error) process.stdout.write(`  ! ${error}\n\n`);
  if (fnError) process.stdout.write(`  ! functions not priced: ${fnError}\n\n`);
  process.stdout.write(
    `  ${"where".padEnd(50)}${"kind".padEnd(6)}${"sides".padStart(5)}${"fns".padStart(5)}  killer / problem\n`
  );
  for (const r of [...rows].sort((a, b) => b.sides - a.sides || a.id.localeCompare(b.id))) {
    const note = r.problems.length ? `FAIL ${r.problems.join("; ")}` : (r.entry?.killer ?? "-");
    process.stdout.write(
      `  ${r.id.padEnd(50)}${r.kind.padEnd(6)}${String(r.sides).padStart(5)}${String(r.functions).padStart(5)}  ${note}\n`
    );
  }
  // Never print a total that could not be measured. Without a coverage report
  // this printed "0 branch side(s) out of the denominator", which reads as
  // "nothing is suppressed" - the exact inversion of the truth, and the same
  // class of defect as an empty scan reported under a tick.
  process.stdout.write(
    error
      ? `\n  ${rows.length} directive(s). SIDES NOT MEASURED - no coverage report, so the\n` +
        `  suppressed count is unknown, not zero. Re-measure before quoting anything.\n`
      : `\n  ${rows.length} directive(s), ${total} branch side(s) and ${totalFunctions} function(s) out of\n` +
        `  the denominator. The percentage above them is computed on what is LEFT. Quote both.\n`
  );
  const bad = rows.filter((r) => r.problems.length);
  if (bad.length) {
    process.stdout.write(`\n  FAIL - ${bad.length} directive(s) not fit to be ruled:\n`);
    for (const r of bad) process.stdout.write(`      ${r.id} - ${r.problems.join("; ")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `\n  OK - every directive carries -- @preserve, the standing instruction, and a BLOCKED.md entry\n`
  );
}

if (process.argv[1]?.endsWith("suppressions.mjs")) main();
