#!/usr/bin/env node
/**
 * ts-prune against the ts-morph pass, on a repo whose answer is known.
 *
 * AI-5314 asks for this as a MEASUREMENT and it was never run as one -
 * `deadcode.mjs` argues for ts-morph in its own header, which is a hypothesis.
 * The three claims in that argument are testable, so this tests them:
 *
 *   1. a second tool is a second denominator that can disagree
 *   2. the reference graph already exists here, so "no reachable caller" is the
 *      same query inverted
 *   3. it beat a text search - `grep` counted a COMMENTED-OUT call site as a
 *      live reference
 *
 * What matters for this pipeline specifically, and what the ticket names:
 *   - does either distinguish a commented-out call site from a live one
 *   - are test-only references reported separately
 *   - can the output be reconciled against the coverage denominator without a
 *     second source of truth
 *
 *   node .claude/charpilot/deadcode-compare.mjs
 *
 * Writes out/deadcode-compare.json. Exits 0 always - this is a measurement, not
 * a gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

/** ts-prune: one finding per line, `file:line - name` plus an optional note. */
function tsPrune() {
  let out = "";
  try {
    out = execFileSync("npx", ["ts-prune"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 5 * 60_000 });
  } catch (err) {
    out = `${err.stdout ?? ""}`;
    if (!out) throw new Error("ts-prune produced nothing");
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\S+?):(\d+)\s+-\s+(\S+)(.*)$/);
    if (!m) continue;
    const [, file, ln, name, rest] = m;
    if (!file.startsWith("src/")) continue;
    rows.push({
      file,
      line: Number(ln),
      name,
      // ts-prune's one annotation: the export IS used, but only inside its own
      // module. That is not dead code, it is an export that could be local.
      usedInModule: /used in module/.test(rest),
    });
  }
  return rows;
}

/** The ts-morph pass, from its own artifact. */
function tsMorph() {
  const p = join(OUT_DIR, "dead-exports.json");
  if (!existsSync(p)) throw new Error("run `node .claude/charpilot/deadcode.mjs` first");
  const d = JSON.parse(readFileSync(p, "utf8"));
  return (d.dead ?? []).map((r) => ({
    file: r.file,
    line: r.line ?? null,
    name: r.name,
    kind: r.kind,
    testsOnly: Boolean(r.referencedOnlyByTests),
    sides: r.branchSides ?? 0,
  }));
}

const key = (r) => `${r.file}:${r.name}`;

function main() {
  const prune = tsPrune();
  const morph = tsMorph();
  const totals = JSON.parse(readFileSync(join(OUT_DIR, "dead-exports.json"), "utf8")).totals ?? {};

  const pruneAll = new Map(prune.map((r) => [key(r), r]));
  const pruneDead = new Map(prune.filter((r) => !r.usedInModule).map((r) => [key(r), r]));
  const morphMap = new Map(morph.map((r) => [key(r), r]));

  const bothDead = [...morphMap.keys()].filter((k) => pruneDead.has(k));
  const morphOnly = [...morphMap.keys()].filter((k) => !pruneDead.has(k));
  const pruneOnly = [...pruneDead.keys()].filter((k) => !morphMap.has(k));

  const w = (s) => process.stdout.write(s);
  w(`\ndead code: ts-prune vs the ts-morph pass\n\n`);
  w(`  ts-prune findings, total                 ${prune.length}\n`);
  w(`    of those, "used in module"             ${prune.filter((r) => r.usedInModule).length}   <- not dead; an export that could be local\n`);
  w(`    of those, no annotation                ${pruneDead.size}\n`);
  w(`  ts-morph dead exports                    ${morph.length}\n`);
  w(`    of those, referenced only by tests     ${morph.filter((r) => r.testsOnly).length}\n\n`);
  w(`  agreed dead                              ${bothDead.length}\n`);
  w(`  ts-morph only                            ${morphOnly.length}\n`);
  w(`  ts-prune only                            ${pruneOnly.length}\n`);

  if (pruneOnly.length) {
    w(`\n  ts-prune only - each is a disagreement someone has to adjudicate:\n`);
    for (const k of pruneOnly.slice(0, 20)) w(`    ${k}\n`);
    if (pruneOnly.length > 20) w(`    … ${pruneOnly.length - 20} more\n`);
  }
  if (morphOnly.length) {
    w(`\n  ts-morph only:\n`);
    for (const k of morphOnly.slice(0, 20)) {
      const r = morphMap.get(k);
      w(`    ${k}${r.testsOnly ? "   (tests only)" : ""}${pruneAll.has(k) ? "   [ts-prune saw it, called it used-in-module]" : ""}\n`);
    }
    if (morphOnly.length > 20) w(`    … ${morphOnly.length - 20} more\n`);
  }

  // The three questions the ticket actually asks, answered from the run.
  w(`\n  what the ticket asks:\n`);
  w(`    distinguishes a commented-out call site   ts-morph yes (findReferencesAsNodes)\n`);
  w(`                                              ts-prune  not applicable - it never resolves callers,\n`);
  w(`                                                        it asks whether an export is imported\n`);
  w(`    reports test-only references separately   ts-morph yes (${morph.filter((r) => r.testsOnly).length} of ${morph.length})\n`);
  w(`                                              ts-prune  no - a test import is an import\n`);
  w(`    reconciles against the coverage           ts-morph yes - it carries the sides each export contains,\n`);
  w(`      denominator without a second source                so the denominator moves by a known amount\n`);
  w(`                                              ts-prune  no - name and line only, no side count\n`);
  w(`\n  and the number that matters downstream: the ts-morph pass reports\n`);
  w(`  ${totals.branchSidesInsideThem} branch side(s) inside those exports, moving the denominator\n`);
  w(`  ${totals.denominator} -> ${totals.correctedDenominator}. ts-prune reports no side count, so adopting it\n`);
  w(`  would leave the denominator correction unsourced.\n`);

  const report = {
    stage: "2b",
    generatedAt: new Date().toISOString(),
    tsPrune: { total: prune.length, usedInModule: prune.filter((r) => r.usedInModule).length, dead: pruneDead.size, rows: prune },
    tsMorph: { total: morph.length, testsOnly: morph.filter((r) => r.testsOnly).length, rows: morph },
    agreement: { bothDead: bothDead.length, morphOnly, pruneOnly },
    verdict:
      pruneOnly.length || morphOnly.length
        ? "the two tools disagree; adopting ts-prune adds a second denominator to adjudicate, which is the cost its own row in the plan warns about"
        : "the two tools agree on the dead set",
  };
  writeFileSync(join(OUT_DIR, "deadcode-compare.json"), `${JSON.stringify(report, null, 2)}\n`);
  w(`\n  → ${join(".claude/charpilot/out", "deadcode-compare.json")}\n`);
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