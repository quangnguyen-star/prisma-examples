#!/usr/bin/env node
/**
 * Attribute every side the hand-written suite covers, and the recorded suite
 * does not, to the test file that already drives it.
 *
 * WHY this exists. The pilot reports 100% branch coverage, and that number is
 * the UNION of two suites with different provenance: 365 characterization cases
 * whose expected values were produced by running the code, and 287 pre-existing
 * hand-written cases whose expected values were authored. Measured, the recorded
 * half alone is 1198/1449 - 82.68%. So 251 sides and 61 function entries in the
 * headline are carried by assertions nobody recorded.
 *
 * That matters twice. Here, it is a provenance gap: nothing in the repo marks
 * which half of the 100% was recorded. Across the fleet it is worse - most of
 * the 84 repos have no existing suite at all, so they get no such subsidy, and
 * the pilot's per-repo cost was measured with one.
 *
 * WHAT this does. Stage 3's hard part - deriving an arrangement that drives a
 * given side - is already done for those 251 sides by whoever wrote the tests.
 * This runs each hand-written test file under coverage on its own and records
 * which of the gap sides it drives, so each one arrives at stage 4 with a named
 * existing arrangement to record instead of an input to invent.
 *
 * It does not convert anything on its own. It produces the worklist that makes
 * the conversion cheap, and the measurement that says how much of the gap is
 * "hard to reach" versus "nobody asked stage 3 for it".
 *
 *   node .claude/charpilot/harvest.mjs [--union coverage] [--recorded coverage-char-only]
 *
 * Writes out/harvest.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (name, dflt) => (ARGV.includes(name) ? ARGV[ARGV.indexOf(name) + 1] : dflt);
const UNION = arg("--union", "coverage");
const RECORDED = arg("--recorded", "coverage-char-only");

/** Every hit side, as `file branchId side`, from an istanbul report. */
function hitSides(dir) {
  // `dir` may be absolute (a scratch report) or repo-relative. join() would
  // graft an absolute path onto REPO_ROOT and silently miss the file, which is
  // exactly how the first run of this script failed.
  const f = dir.startsWith("/") ? join(dir, "coverage-final.json") : join(REPO_ROOT, dir, "coverage-final.json");
  if (!existsSync(f)) throw new Error(`${dir}/coverage-final.json missing - measure it first`);
  const cov = JSON.parse(readFileSync(f, "utf8"));
  const sides = new Set();
  const lines = new Map();
  for (const [abs, d] of Object.entries(cov)) {
    const rel = abs.replace(`${REPO_ROOT}/`, "");
    for (const [id, counts] of Object.entries(d.b)) {
      counts.forEach((n, i) => {
        if (n > 0) sides.add(`${rel} ${id} ${i}`);
      });
      lines.set(`${rel} ${id}`, d.branchMap[id]?.loc?.start?.line);
    }
  }
  return { sides, lines };
}

/**
 * The hand-written suite's own files - the characterization project owns the
 * rest. `.mb.test.ts` files are INCLUDED: they belong to the suite project, so
 * their coverage is part of the union this is attributing.
 */
function suiteFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) {
        if (name.name === "characterization" || name.name === "helpers") continue;
        walk(rel);
      } else if (/\.test\.ts$/.test(name.name)) {
        out.push(rel);
      }
    }
  };
  walk("test");
  return out.sort();
}

function main() {
  const union = hitSides(UNION);
  const recorded = hitSides(RECORDED);
  const gap = [...union.sides].filter((s) => !recorded.sides.has(s));
  process.stdout.write(
    `\nharvest - ${gap.length} side(s) in the ${UNION} total that ${RECORDED} never reached\n\n`
  );

  const files = suiteFiles();
  const tmp = mkdtempSync(join(OUT_DIR, "harvest-"));
  const owners = new Map(); // side -> [test file]
  const perFile = [];

  for (const [i, file] of files.entries()) {
    const dir = join(tmp, String(i));
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${files.length}] ${file} `);
    try {
      execFileSync(
        "npx",
        ["vitest", "run", "--project", "suite", "--coverage", "--coverage.reportsDirectory", dir, "--reporter=default", file],
        { cwd: REPO_ROOT, encoding: "utf8", stdio: "pipe", timeout: 10 * 60_000 }
      );
    } catch {
      // A non-zero exit still leaves a report; a missing report is the failure.
    }
    if (!existsSync(join(dir, "coverage-final.json"))) {
      process.stdout.write("no report\n");
      continue;
    }
    const mine = hitSides(dir);
    const drives = gap.filter((s) => mine.sides.has(s));
    for (const s of drives) owners.set(s, [...(owners.get(s) ?? []), file]);
    perFile.push({ file, drives: drives.length });
    process.stdout.write(`${drives.length} of the gap\n`);
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(tmp, { recursive: true, force: true });

  const orphan = gap.filter((s) => !owners.has(s));
  perFile.sort((a, b) => b.drives - a.drives);

  process.stdout.write(`\n  attributable to one existing test file:\n`);
  for (const r of perFile.filter((r) => r.drives)) {
    process.stdout.write(`    ${String(r.drives).padStart(4)}  ${r.file}\n`);
  }
  process.stdout.write(
    `\n  ${gap.length - orphan.length} of ${gap.length} gap side(s) have a named arrangement already written.\n`
  );
  if (orphan.length) {
    // A side no single file drives is driven by a COMBINATION - module state
    // that one test leaves behind for another. Those are the expensive ones:
    // there is no single arrangement to record, so stage 3 has to derive one.
    process.stdout.write(
      `  ${orphan.length} side(s) are driven by no single file - cross-test state, so stage 3 must derive these.\n`
    );
    const byFile = new Map();
    for (const s of orphan) {
      const [f, id] = s.split(" ");
      const line = union.lines.get(`${f} ${id}`);
      byFile.set(f, [...(byFile.get(f) ?? []), line]);
    }
    for (const [f, lines] of [...byFile].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
      process.stdout.write(`    ${String(lines.length).padStart(4)}  ${f}  (lines ${[...new Set(lines)].sort((a, b) => a - b).slice(0, 8).join(" ")})\n`);
    }
  }

  const rows = gap.map((s) => {
    const [file, id, side] = s.split(" ");
    return { file, branchId: id, side: Number(side), line: union.lines.get(`${file} ${id}`), tests: owners.get(s) ?? [] };
  });
  writeFileSync(
    join(OUT_DIR, "harvest.json"),
    JSON.stringify(
      {
        stage: 7,
        generatedAt: new Date().toISOString(),
        union: UNION,
        recorded: RECORDED,
        totals: { gap: gap.length, attributed: gap.length - orphan.length, orphan: orphan.length },
        perFile,
        rows,
      },
      null,
      2
    )
  );
  process.stdout.write(`\n  wrote ${join(".claude/charpilot/out", "harvest.json")}\n`);
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