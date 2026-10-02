#!/usr/bin/env node
/**
 * The one place numbers come from.
 *
 * Every figure that turned out to be wrong in this pilot was one derived in
 * prose — a sum, a subtraction, a category call — carried across a report
 * instead of recomputed. Every figure that held up came straight out of a
 * script. So: this prints the whole funnel, and a status report quotes it
 * rather than remembering it.
 *
 *   node .claude/charpilot/status.mjs
 *
 * It derives nothing new. It reads baseline.json, scan.json, worklist.json,
 * proposals/ and BLOCKED.md, and prints what they say. If a number is not here,
 * it should not be in a report.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

import { BASELINE_JSON, PROPOSALS_DIR, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const pad = (n, w = 5) => String(n).padStart(w);

function main() {
  for (const [label, path] of [["baseline", BASELINE_JSON], ["scan", SCAN_JSON], ["worklist", WORKLIST_JSON]]) {
    if (!existsSync(path)) {
      process.stdout.write(`\n\u2717 ${label} artifact missing — run the earlier stage first\n`);
      process.exit(1);
    }
  }

  const baseline = read(BASELINE_JSON);
  const scan = read(SCAN_JSON);
  const worklist = read(WORKLIST_JSON);

  const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"));
  const proposals = files.flatMap((f) => read(join(PROPOSALS_DIR, f)).proposals ?? []);

  // Side-level accounting.
  //
  // Built from the SCAN, with the worklist as a supplement. It used to come
  // from worklist.items alone, and the worklist holds only UNCOVERED arms - so
  // every label on an already-covered arm got an empty valid set and was
  // reported as "not a real side". That is the loudest line in pilot:status and
  // it was wrong: two agents checked their flagged labels against scan.json and
  // found 0 of 58 genuinely wrong, while record.mjs verified 105 of the same
  // claims. One of them reproduced it exactly - regenerate the worklist with
  // --all and the whole block disappears.
  //
  // validate.mjs already got this right by unioning arm.sides with
  // arm.uncoveredSides; this is the same union, one tool over.
  const labelsByArm = new Map();
  for (const fn of scan.functions ?? []) {
    if (fn.entryArmId) labelsByArm.set(fn.entryArmId, new Set(["entered"]));
    for (const arm of fn.arms?.list ?? []) labelsByArm.set(arm.armId, new Set(arm.labels ?? []));
  }
  for (const g of scan.moduleScopeArms ?? []) {
    for (const arm of g.list ?? []) labelsByArm.set(arm.armId, new Set(arm.labels ?? []));
  }
  for (const i of worklist.items) {
    const have = labelsByArm.get(i.armId) ?? new Set();
    for (const s of [...(i.sides ?? []), ...i.uncoveredSides]) have.add(s);
    labelsByArm.set(i.armId, have);
  }
  const sidesOf = (value, valid) => {
    const raw = Array.isArray(value) ? value.map(String) : [String(value)];
    const out = [];
    for (const entry of raw) {
      const t = entry.trim();
      if (valid.has(t)) { out.push(t); continue; }
      const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
      if (parts.length > 1 && parts.every((x) => valid.has(x))) out.push(...parts);
      else out.push(t);
    }
    return out;
  };

  const proposedSides = new Set();
  const badLabels = [];
  for (const p of proposals) {
    for (const [armId, v] of Object.entries(p.reaches ?? {})) {
      const valid = labelsByArm.get(armId) ?? new Set();
      for (const side of sidesOf(v, valid)) {
        if (valid.has(side)) proposedSides.add(`${armId} ${side}`);
        else badLabels.push(`${p.id} :: ${armId} :: ${JSON.stringify(side)}`);
      }
    }
  }

  const blockedSides = new Set();
  const blockedPath = join(PROPOSALS_DIR, "BLOCKED.md");
  if (existsSync(blockedPath)) {
    const md = readFileSync(blockedPath, "utf8");
    for (const [, body] of md.matchAll(new RegExp("```blocked\\n([\\s\\S]*?)```", "g"))) {
      const f = {};
      for (const line of body.split("\n")) {
        const m = line.match(/^\s*([a-z]+)\s*:\s*(.+?)\s*$/);
        if (m) f[m[1]] = m[2];
      }
      if (!f.arm || !f.side) continue;
      for (const side of sidesOf(f.side, labelsByArm.get(f.arm) ?? new Set())) {
        blockedSides.add(`${f.arm} ${side}`);
      }
    }
  }

  const instrumented = worklist.items.filter((i) => i.instrumented);
  let withInput = 0;
  let withReason = 0;
  let unaccounted = 0;
  let bothClaimed = 0;
  const laneTally = {};
  for (const item of instrumented) {
    const lane = item.lane ?? "unit";
    laneTally[lane] ??= { input: 0, reason: 0, unaccounted: 0 };
    for (const side of item.uncoveredSides) {
      const k = `${item.armId} ${side}`;
      const p = proposedSides.has(k);
      const b = blockedSides.has(k);
      if (p && b) { bothClaimed += 1; continue; }
      if (p) { withInput += 1; laneTally[lane].input += 1; }
      else if (b) { withReason += 1; laneTally[lane].reason += 1; }
      else { unaccounted += 1; laneTally[lane].unaccounted += 1; }
    }
  }

  // Stage-4 readiness: how much of stage 3 is a PROGRAM rather than a document.
  // Added after building the recorder found 179 English `construct` values and
  // 1223 prose boundary answers, none of which a machine could execute.
  const INERT = /^not (a )?call|^not constructed|^not read|^not matched|^not reached|^no call|type only|imported for its type/i;
  let argsTotal = 0;
  let argsExecutable = 0;
  let bndLive = 0;
  let bndWithMock = 0;
  let setupTotal = 0;
  let setupWithApply = 0;
  let manualCount = 0;
  for (const p of proposals) {
    for (const a of p.args ?? []) {
      argsTotal += 1;
      if (!a?.construct || a.build !== undefined) argsExecutable += 1;
    }
    for (const ans of Object.values(p.boundaries ?? {})) {
      if (INERT.test(ans?.behaviour ?? "")) continue;
      bndLive += 1;
      if (ans?.mock !== undefined) bndWithMock += 1;
    }
    for (const e of p.setup ?? []) {
      setupTotal += 1;
      if (e?.apply !== undefined) setupWithApply += 1;
      if (e?.apply?.manual !== undefined) manualCount += 1;
    }
  }
  const pct = (a, b) => (b === 0 ? "100" : ((a / b) * 100).toFixed(0));

  // A baseline with no `coverage` block is what stage 1 writes when the suite is
  // RED, and this crashed outright on it - TypeError reading 'totals' of
  // undefined - which made the pipeline's own "only place numbers come from"
  // unusable on exactly the repo that needed diagnosing. Two agents had to
  // quote validate and record directly instead.
  const totals = baseline.coverage?.totals;
  if (!totals) {
    process.stdout.write(
      `\n  ! out/baseline.json has no coverage block, so no baseline percentage can be shown.\n` +
        `    Stage 1 writes it only when the suite is not RED; this one recorded ` +
        `${baseline.suite?.failed ?? "?"} failing test(s).\n` +
        `    Everything below is still measured - only the baseline comparison is missing.\n`
    );
  }
  const br = totals?.branches ?? { covered: 0, total: 0, pct: 0 };
  const fnc = totals?.functions ?? { covered: 0, total: 0, pct: 0 };
  const armRec = scan.reconcile?.arms ?? {};
  const fnRec = scan.reconcile?.functions ?? {};
  const stamp = statSync(WORKLIST_JSON).mtime.toISOString();

  const lines = [
    "",
    `charpilot status   (worklist generated ${stamp})`,
    "",
    "STAGE 1  baseline",
    baseline.suite?.state === "no-spec-files"
      ? `  suite            NO SPEC FILE - nothing ran; the denominator below is from coverage.all`
      : `  suite            ${baseline.suite.passed}/${baseline.suite.tests} green in ${baseline.suite.files} files`,
    `  branch sides     ${pad(br.total)}   covered ${pad(br.covered)}  (${br.pct}%)   uncovered ${pad(br.total - br.covered)}`,
    `  functions        ${pad(fnc.total)}   covered ${pad(fnc.covered)}  (${fnc.pct}%)   uncovered ${pad(fnc.total - fnc.covered)}`,
    "",
    "STAGE 2  scan",
    `  functions        ${pad(scan.totals.functions)}   own entry ${pad(scan.totals.withOwnEntry)}  (${scan.totals.pctWithOwnEntry}%)   no own entry ${pad(scan.totals.withoutOwnEntry)}`,
    `  reconcile arms   ast ${armRec.astTotal} vs istanbul ${armRec.istanbulTotal}  \u2192 ${armRec.matchPct}% match, ${armRec.filesWithDrift?.length ?? "?"} files drift`,
    `  reconcile fns    ast ${fnRec.astTotal} vs istanbul ${fnRec.istanbulTotal}  \u2192 ${fnRec.matchPct}% match, ${fnRec.filesWithDrift?.length ?? "?"} files drift`,
    "",
    "STAGE 3  work list  (uncovered SIDES, the unit coverage counts)",
    `  total            ${pad(withInput + withReason + unaccounted + bothClaimed)}`,
    `    with an input  ${pad(withInput)}`,
    `    with a reason  ${pad(withReason)}`,
    `    UNACCOUNTED    ${pad(unaccounted)}`,
    ...(bothClaimed ? [`    both claimed   ${pad(bothClaimed)}   \u2190 a side cannot be proposed AND blocked`] : []),
    "",
    "  by lane:",
    ...Object.entries(laneTally).map(
      ([lane, t]) =>
        `    ${lane.padEnd(12)} input ${pad(t.input, 4)}   reason ${pad(t.reason, 4)}   unaccounted ${pad(t.unaccounted, 4)}`
    ),
    "",
    `  proposals        ${pad(proposals.length)} across ${new Set(proposals.map((p) => p.functionId)).size} functions in ${files.length} files`,
    "",
    "STAGE 4 READINESS  (can a machine execute the input?)",
    `  args             ${pad(argsExecutable)} / ${argsTotal} executable   (${pct(argsExecutable, argsTotal)}%)`,
    `  live boundaries  ${pad(bndWithMock)} / ${bndLive} have a mock   (${pct(bndWithMock, bndLive)}%)`,
    `  setup entries    ${pad(setupWithApply)} / ${setupTotal} have an apply  (${pct(setupWithApply, setupTotal)}%)`,
    ...(manualCount ? [`  of those, manual ${pad(manualCount)}   \u2190 needs a hand-built harness, not a directive`] : []),
    ...(badLabels.length
      ? ["", `  \u2717 ${badLabels.length} \`reaches\` labels are not real sides of their arm:`, ...badLabels.slice(0, 10).map((b) => `      ${b}`)]
      : ["", "  \u2713 every `reaches` label is a real side of its arm"]),
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
  if (unaccounted || bothClaimed || badLabels.length) {
    process.stdout.write(
      "\n  This is a SNAPSHOT. Quote it, do not remember it \u2014 rerun before reporting.\n"
    );
  }
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