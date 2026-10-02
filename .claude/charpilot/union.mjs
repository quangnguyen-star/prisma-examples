/**
 * Merge two or more istanbul coverage directories into one report, and print
 * every branch side that neither of them hit.
 *
 * This existed only as an ad-hoc snippet, and that cost a whole round: the
 * union report was regenerated from a stale half, istanbul merged two
 * disagreeing branch maps, and the totals came out at 1649 branches against a
 * real 1466 - a number that looked like progress. Two rules follow from that:
 *
 *   - every input directory must be re-measured against the CURRENT src; a
 *     directory older than the sources it describes is a corrupt merge waiting
 *     to happen. Check mtimes before trusting a union.
 *   - the uncovered sides are printed from the merged map, not from a
 *     hand-maintained list, so the list cannot drift from the measurement.
 *
 * Usage: node .claude/charpilot/union.mjs <dir> <dir> [...] <outDir>
 */
import libCoverage from "istanbul-lib-coverage";
import { createContext } from "istanbul-lib-report";
import reports from "istanbul-reports";
import { readFileSync, existsSync, statSync } from "fs";

const dirs = process.argv.slice(2, -1);
const out = process.argv.at(-1);
if (dirs.length < 1 || !out) {
  console.error("usage: node .claude/charpilot/union.mjs <dir> [...] <outDir>");
  process.exit(2);
}

const map = libCoverage.createCoverageMap({});
for (const d of dirs) {
  const f = `${d}/coverage-final.json`;
  if (!existsSync(f)) throw new Error(`missing ${f} - re-measure that half before merging`);
  console.log(`  + ${f}  (measured ${statSync(f).mtime.toISOString()})`);
  map.merge(JSON.parse(readFileSync(f, "utf8")));
}

const ctx = createContext({ dir: out, coverageMap: map, defaultSummarizer: "nested" });
reports.create("html").execute(ctx);
reports.create("json").execute(ctx);
reports.create("text-summary").execute(ctx);

const uncovered = [];
for (const file of map.files()) {
  const d = map.fileCoverageFor(file).data;
  const rel = file.replace(`${process.cwd()}/`, "");
  for (const [id, bm] of Object.entries(d.branchMap)) {
    (d.b[id] ?? []).forEach((n, i) => {
      if (n === 0)
        uncovered.push(
          `  ${rel}:${bm.loc.start.line}  ${bm.type} side${i}` +
            `  counts=${JSON.stringify(d.b[id])}`
        );
    });
  }
}
console.log(`\n${uncovered.length} uncovered branch side(s):`);
console.log(uncovered.sort().join("\n"));
