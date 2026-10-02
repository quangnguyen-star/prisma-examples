#!/usr/bin/env node
/**
 * fleetsweep — how much branch work every repo in the fleet holds, before
 * anybody spends a model call on it.
 *
 *   node tools/fleetsweep.mjs                 # every repo fleetcheck has cached
 *   node tools/fleetsweep.mjs --only a,b      # just these
 *   node tools/fleetsweep.mjs --json          # the table as a document
 *   node tools/fleetsweep.mjs --rate 0.23     # $/side, if a better number exists
 *
 * WHY THIS IS NOT A RUN. The instinct when a pipeline finally works is to point
 * it at all 32 repos and find out. That is the most expensive possible way to
 * learn the denominators: measured cost is $0.23/side, qode-ptp-ms alone holds
 * 8,546 open sides -- about $2,000 -- and nobody knows the other thirty numbers
 * until something counts them. A run that discovers a repo is 4,000 sides deep
 * has already paid to find out.
 *
 * Everything needed to count them is ALREADY ON DISK. `fleetcheck` clones each
 * repo at its deployed branch, measures it with istanbul, scans it, and caches
 * `scan.json` and `coverage-final.json` per repo under `out/fleet/<name>/`. The
 * last full pass reconciled 33 of 33 repos exactly. So this tool clones nothing,
 * installs nothing, runs no tests and calls no model: it reads that cache and
 * does the arithmetic the walk would otherwise do one expensive repo at a time.
 *
 * WHAT "SIDES" MEANS HERE, AND WHAT IT DOES NOT. `fleetcheck` runs the
 * denominator only -- its generated config is `include: []` with
 * `passWithNoTests: true`, deliberately, because "a service whose suite wants a
 * database would otherwise decide whether we get one". So every cached
 * `coverage-final.json` carries istanbul's branch MAP with every hit count at
 * zero, and there is no way to ask this cache what a repo's own tests already
 * cover.
 *
 * This table therefore reports the CEILING: every branch side in the repo, which
 * is what the work would be if the existing suite covered nothing. The true
 * figure is that minus whatever the suite already reaches, and the only way to
 * learn it is to run each repo's own suite with coverage -- which is `baseline`,
 * and which is the next gate. Read the numbers as an upper bound and a ranking,
 * never as a quote.
 *
 * WHAT IT COUNTS, and why each column is here rather than a neighbouring one:
 *
 *   sides          Not `armsAst` and not istanbul's branch count -- SIDES,
 *                  because a two-sided `if` is two units of work. Counted by
 *                  the same `measureArms` join stage 6 uses, so this number and
 *                  the one a run reports are the same quantity, measured
 *                  against different coverage.
 *   packets        One function with open sides is one packet, and a packet is
 *                  what a worker reads once. This is the unit the round is
 *                  sized in, so it -- not the side count -- says how wide a
 *                  round can be.
 *   sides/packet   The ratio that makes two repos of equal side count cost
 *                  differently: location-ms is 4.05 and qode-ptp-ms 4.45, so a
 *                  round of 150 sides is 37 functions on one and 34 on the
 *                  other, and the reading is per function.
 *   rounds         What `dynamicBatch` will actually choose, asked of the real
 *                  function rather than estimated here, so this table cannot
 *                  drift from what a run does.
 *   hours / $      Priced from 20260916T031317Z, which did 146 sides in 216
 *                  minutes for $34.16. That is 1.48 min/side and $0.23/side,
 *                  and both are quoted as what they are -- a single
 *                  observation, on the smallest repo in the fleet, at a batch
 *                  size that has since changed. It is NOT the only run that
 *                  ever finished; see the rate block below for the other
 *                  three and why they are not in this number.
 *
 * WHAT IT CANNOT SEE, said here because a number without its limits is worse
 * than no number. It does not know whether a repo's own suite is green (that is
 * `baseline`, and it needs the repo), whether its boundaries are reachable
 * (qode-ptp-ms is 61% blocked behind a Redis service with no route from a
 * container), or whether stage 1 can resolve its environment. Those are the
 * next gate, not this one. This answers "how much work is in there", which is
 * the question that decides whether the next gate is worth running at all.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hitIndexFrom, measureArms } from "./armjoin.mjs";
import { dynamicBatch } from "./steps/derive.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

const CACHE = arg("--cache", join(OUT_DIR, "fleet"));
const ONLY = (arg("--only", "") || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * The two rates, from the one run that priced a WHOLE repo end to end.
 *
 * `20260916T031317Z`: location-ms, 146 uncovered sides, 216 minutes, $34.16.
 *
 * THIS BLOCK USED TO SAY "the only run in `docker/runs/` that finished", AND
 * THAT WAS FALSE FOUR TIMES OVER. Counted across the 127 run directories on
 * record (`nodejs/tests/fixtures/runs-on-record.json`), FOUR result.json files
 * say `succeeded`:
 *
 *   20260908T174455Z  location-ms, PR 56, 96.5% branches
 *   20260916T031317Z  location-ms, 96.7% live-code branches, 132/132 claims
 *                     verified, 0 false. No PR -- the checkout was not a git
 *                     repository, which is why it reported none.
 *   20260917T172502Z  location-ms, PR 58, 96.7%, 139/139 verified, 0 false
 *   20260917T181622Z  location-ms, PR 59, 96.7%, 144/144 verified, 0 false
 *
 * The last two are LATER than the run this rate comes from and both opened
 * PRs, so "the only one that finished" was not even the most recent thing it
 * was wrong about.
 *
 * AND THE RATE STILL COMES FROM 031317Z, for a reason the uniqueness claim was
 * standing in for. The two 2026-09-17 runs are top-ups on a repo already at
 * 96.7%: 172502Z ran 56 minutes over six packets and 181622Z ran 123 minutes
 * over one packet's four sides. Neither carries a whole repo's side count
 * against a whole repo's clock, so averaging them in would not widen the
 * sample -- it would dilute a full-repo rate with two tails. 20260908T174455Z
 * predates the side accounting entirely and records no side count at all.
 *
 * So: quoted rather than averaged, because ONE observation prices the thing
 * this column prices. That is a narrower claim than the old one and it is a
 * true one. Pricing from what is left -- the runs that died or were
 * rate-limited -- is how a reserve once came to hold back 4.4 hours (see
 * docker/char/context.py).
 *
 * Both are pessimistic for a large repo and optimistic for a hostile one, and
 * the point of the column is the ORDER OF MAGNITUDE: it is the difference
 * between "run it tonight" and "this is a quarter's budget".
 */
const MIN_PER_SIDE = Number(arg("--min-per-side", "1.48"));
const USD_PER_SIDE = Number(arg("--rate", "0.23"));

/** The hard limit a single run may take, from plan 11. */
const RUN_HOURS = Number(arg("--run-hours", "6"));

function read(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * One repo's numbers, or a sentence saying why there are none.
 *
 * A cache entry missing a half is REPORTED rather than skipped. The whole value
 * of a sweep is that it covers the fleet, and a repo that quietly vanishes from
 * the table is a repo nobody plans for.
 */
function sweep(name) {
  const dir = join(CACHE, name);
  const scanPath = join(dir, "scan.json");
  // THE SUITE'S OWN COVERAGE WHEN IT EXISTS, AND THE DENOMINATOR WHEN IT DOES
  // NOT. `fleetbaseline` installs each repo's real dependencies, runs its own
  // tests with istanbul and writes `coverage-suite.json` beside fleetcheck's
  // `coverage-final.json`. The two documents carry the same file keys and the
  // same branch map -- measured on location-ms, 28 files and 367 sides in both,
  // 0 hit in one and 221 in the other -- so this is a JOIN and not an estimate,
  // and swapping the file is the whole of the subtraction.
  //
  // With it, location-ms reads 146 open sides, which is the number every plan
  // in docs/ has quoted for it. Without it, 367: the same repo with nothing
  // subtracted.
  const suitePath = join(dir, "coverage-suite.json");
  const covPath = existsSync(suitePath) ? suitePath : join(dir, "coverage-final.json");
  if (!existsSync(scanPath)) return { name, error: "no scan.json in the cache — run fleetcheck for it" };
  if (!existsSync(covPath)) return { name, error: "no coverage-final.json in the cache — run fleetcheck for it" };

  const scan = read(scanPath);
  const meta = existsSync(join(dir, "meta.json")) ? read(join(dir, "meta.json")) : {};
  const byArm = measureArms(scan, hitIndexFrom(read(covPath)));

  // OPEN SIDES, and the definition is the one derive uses: an arm the join
  // KNOWS (so istanbul and the scan agree it exists), and each of its sides that
  // never incremented. An arm the join cannot place is counted separately --
  // it is a question for the scan, not work for an agent.
  let open = 0;
  let unjoined = 0;
  // Whether this coverage document holds any observation at all. A cache
  // written by `fleetcheck` never does (it runs no tests on purpose), and
  // saying so is the difference between a ceiling and a quote.
  let anyHit = false;
  const packets = new Set();
  const perFile = new Map();
  for (const arm of byArm.values()) {
    if (!arm.known) { unjoined += 1; continue; }
    if ((arm.hits ?? []).some((n) => n > 0)) anyHit = true;
    const sides = arm.uncoveredSides.length;
    if (!sides) continue;
    open += sides;
    packets.add(arm.functionId);
    perFile.set(arm.file, (perFile.get(arm.file) ?? 0) + sides);
  }

  // The boundaries those functions touch, which is what has to be answerable
  // before any of this work can record. Counted as DISTINCT MODULES: it is the
  // module that is reachable or not, and thirty symbols from one client are one
  // question.
  const openFunctions = new Set(packets);
  const modules = new Set();
  for (const fn of scan.functions ?? []) {
    if (!openFunctions.has(fn.id)) continue;
    for (const b of fn.boundaries ?? []) if (b?.module) modules.add(b.module);
  }

  const perPacket = packets.size ? open / packets.size : 0;
  // ASKED OF THE REAL FUNCTION. An estimate written here would be a second
  // implementation of the round sizing, and the two would drift -- which is the
  // defect `loadProposals` exists to prevent, one directory over.
  const batch = open
    ? dynamicBatch(
        Array.from({ length: open }, (_, i) => ({
          item: { owner: { functionId: `f${Math.floor(i / Math.max(1, perPacket))}` } },
        }))
      )
    : 0;
  const rounds = batch ? Math.ceil(open / batch) : 0;
  const hours = (open * MIN_PER_SIDE) / 60;

  // `baseline.json` is fleetbaseline's verdict on whether the suite could run at
  // all. A repo whose suite is RED or which would not install is the most
  // valuable row in the table -- its open count is real but unreachable until
  // somebody fixes the repo -- so it is carried rather than quietly averaged in.
  const basePath = join(dir, "baseline.json");
  const baseline = existsSync(basePath) ? read(basePath) : null;

  return {
    name,
    measured: anyHit,
    suite: baseline ? (baseline.suiteGreen ?? baseline.suite?.green ?? null) : null,
    suiteReason: baseline ? (baseline.reason ?? baseline.failure ?? null) : null,
    branch: meta.branch ?? null,
    sha: meta.sha ? String(meta.sha).slice(0, 8) : null,
    files: meta.files ?? scan.totals?.files ?? null,
    functions: scan.totals?.functions ?? (scan.functions ?? []).length,
    armsAst: scan.totals?.armsAst ?? null,
    armsIstanbul: scan.totals?.armsIstanbul ?? null,
    open,
    unjoined,
    packets: packets.size,
    perPacket: Number(perPacket.toFixed(2)),
    largestFile: [...perFile.entries()].sort((a, b) => b[1] - a[1])[0] ?? null,
    boundaryModules: modules.size,
    batch,
    rounds,
    hours: Number(hours.toFixed(1)),
    runs: Math.max(1, Math.ceil(hours / RUN_HOURS)),
    usd: Math.round(open * USD_PER_SIDE),
  };
}

function table(rows) {
  const head = ["repo", "sides", "packets", "s/pkt", "batch", "rounds", "hours", "runs", "$", "bnd"];
  const body = rows.map((r) => (r.error
    ? [r.name, "—", "—", "—", "—", "—", "—", "—", "—", "—"]
    : [r.name, r.open, r.packets, r.perPacket, r.batch, r.rounds, r.hours, r.runs, r.usd, r.boundaryModules]
  ).map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function main() {
  if (!existsSync(CACHE)) {
    process.stderr.write(
      `no fleet cache at ${CACHE}. It is written by \`node tools/fleetcheck.mjs\`, which clones and\n` +
      `measures each repo; this tool only does arithmetic over what that left behind.\n`
    );
    process.exit(1);
  }
  const names = readdirSync(CACHE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !ONLY.length || ONLY.includes(n))
    .sort();

  const rows = names.map(sweep);
  const ok = rows.filter((r) => !r.error);
  const ranked = [...ok].sort((a, b) => b.open - a.open);

  if (flag("--json")) {
    const doc = { generatedAt: new Date().toISOString(), cache: CACHE,
                  rates: { minPerSide: MIN_PER_SIDE, usdPerSide: USD_PER_SIDE, runHours: RUN_HOURS },
                  repos: rows };
    mkdirSync(OUT_DIR, { recursive: true });
    const path = join(OUT_DIR, "fleetsweep.json");
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    process.stderr.write(`\nwrote ${path}\n`);
    return;
  }

  process.stdout.write(`${table(ranked)}\n\n`);

  for (const r of rows.filter((x) => x.error)) {
    process.stdout.write(`! ${r.name}: ${r.error}\n`);
  }

  const measured = ok.filter((r) => r.measured);
  const totalOpen = ok.reduce((n, r) => n + r.open, 0);
  const totalUsd = ok.reduce((n, r) => n + r.usd, 0);
  const totalHours = ok.reduce((n, r) => n + r.hours, 0);
  const fitsOneRun = ok.filter((r) => r.hours <= RUN_HOURS && r.open > 0);
  const nothingOpen = ok.filter((r) => r.open === 0);

  process.stdout.write(
    `${ok.length} repo(s) measured · ${totalOpen.toLocaleString()} open side(s) · ` +
    `~${Math.round(totalHours).toLocaleString()} agent-hour(s) · ~$${totalUsd.toLocaleString()} at ` +
    `$${USD_PER_SIDE}/side and ${MIN_PER_SIDE} min/side\n` +
    `${fitsOneRun.length} repo(s) fit inside one ${RUN_HOURS}h run · ${nothingOpen.length} have no open sides at all\n\n` +
    `Rates come from 20260916T031317Z: 146 sides, 216 min, $34.16 — one observation, on the smallest repo, at a\n` +
    `batch size that has since changed. Four runs of the 127 on record finished; this is the only one that priced a\n` +
    `WHOLE repo, so the rate is quoted rather than averaged. The other three are 20260908T174455Z (no side count),\n` +
    `20260917T172502Z and 20260917T181622Z (56 and 123 min of top-up on a repo already at 96.7%).\n\n` +
    (measured.length === ok.length
      ? "Every repo here was measured against a suite that actually ran.\n"
      : `THIS IS A CEILING, NOT A QUOTE. ${ok.length - measured.length} of ${ok.length} repo(s) have coverage with no\n` +
        `observation in it at all — fleetcheck runs the denominator only (\`include: []\`, passWithNoTests), so every\n` +
        `side reads as uncovered and these numbers are what the work would be if the existing suites covered nothing.\n` +
        `Subtract what each repo's own tests already reach by running its suite with coverage; that is \`baseline\`,\n` +
        `and it is the next gate.\n`) +
    `Whether a side can be ANSWERED further depends on the environment and the boundaries, which this tool does\n` +
    `not look at either.\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
