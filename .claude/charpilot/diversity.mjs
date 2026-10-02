#!/usr/bin/env node
/**
 * Which functions are DRASTICALLY DIFFERENT from others of their own kind?
 *
 * The entry-kind census answered the wrong question. All 8 kinds appear in all
 * 9 scanned repos, so "is this kind new" is never true and a rule keyed on it
 * always samples the minimum. What differs is the MIX, and inside a single kind
 * the functions differ in the only way that matters here: how much arranging
 * the recorder has to do before the function will run at all.
 *
 * So the signature is the shape of that arranging:
 *
 *   entry kind          how it is reached
 *   arity bucket        0 / 1 / 2 / 3+ parameters
 *   param shape         primitive · object · callback · framework (req/res/next)
 *   async               a promise has to be awaited
 *   returns-closure     the driver hands back a function the input must CALL
 *   reachable           callable at its own id, or only through a caller
 *   via kind            caller · chain · trigger · needs-seam · unresolved
 *   boundary classes    db · http · cache · logger · time · none
 *   optional params     an omitted argument is a different arrangement
 *
 * Two functions with the same signature need the same arrangement, so a second
 * one teaches the recorder nothing new. Two with different signatures are the
 * diversity worth paying for - and the point of the sample is to find out
 * whether stage 4 can actually run each shape against a staging environment,
 * not to admire the count.
 *
 *   node .claude/charpilot/diversity.mjs [--min 5] [--json out]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

import { OUT_DIR } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const MIN = Number(arg("--min", "5"));

const IS_TEST = /(^|\/)(__tests__|__mocks__|test|tests|e2e)\/|\.(test|spec|e2e-spec|bench|stories)\.tsx?$|(^|\/)test-utils?\//i;
const FRAMEWORK = /^(req|request|res|response|next|ctx|context|socket|reply)$/i;
const DB = /prisma|knex|kysely|typeorm|repository|sequelize|mongo|drizzle|\bdb\b/i;
const HTTP = /axios|fetch|got|node-fetch|http|undici|superagent/i;
const CACHE = /redis|ioredis|cache|memcach/i;
const LOG = /logger|winston|pino|bunyan|log4/i;
const TIME = /dayjs|moment|date-fns|luxon|setTimeout|setInterval/i;

export function paramShape(params) {
  if (!params?.length) return "none";
  const names = params.map((p) => p.name ?? "");
  const types = params.map((p) => String(p.type ?? ""));
  if (names.some((n) => FRAMEWORK.test(n))) return "framework";
  if (types.some((t) => /=>|\bFunction\b|Callback|Handler/.test(t))) return "callback";
  if (types.some((t) => /^\{|\[\]|Record<|Map<|Array<|[A-Z]\w+(<|$)/.test(t))) return "object";
  return "primitive";
}

export function boundaryClasses(boundaries) {
  const out = new Set();
  for (const b of boundaries ?? []) {
    const s = `${b.symbol ?? ""} ${b.module ?? ""}`;
    if (DB.test(s)) out.add("db");
    else if (HTTP.test(s)) out.add("http");
    else if (CACHE.test(s)) out.add("cache");
    else if (LOG.test(s)) out.add("log");
    else if (TIME.test(s)) out.add("time");
    else out.add("other");
  }
  return out.size ? [...out].sort().join("+") : "none";
}

const arity = (n) => (n === 0 ? "0" : n === 1 ? "1" : n === 2 ? "2" : "3+");

/**
 * The signature, COARSENED to what changes the arranging.
 *
 * A first version used entry kind x arity bucket x param shape x async x
 * reachable x via kind x boundary set x optional, and produced 2462 distinct
 * shapes with 2281 of them unseen by ai-cen. That is not a sampling plan, it is
 * a restatement of "every function is a bit different". Most of those axes do
 * not change the WORK: 2 parameters versus 3 is the same arrangement, and
 * `via: caller` versus `via: chain` both mean "reach it through something else".
 *
 * These five do change the work, and each is the cause of a real stage-4
 * failure class recorded on this pilot:
 *
 *   entryClass    can it be called at its own id at all - 15 rows needed a
 *                 hand-built harness because they could not
 *   handOff       does the driver return a CLOSURE the input must then call -
 *                 8 rows failed exactly here, "the driver returns a closure
 *                 taking 3 arguments that no proposal supplies"
 *   paramShape    a framework req/res is a different arrangement from a
 *                 primitive, and a callback different again
 *   boundary      whether anything has to be answered, and of what class
 *   async         whether a promise has to be awaited before observing
 */
export function signature(fn) {
  const via = fn.via?.kind ?? "direct";
  const entryClass = fn.entry?.reachable
    ? "callable"
    : via === "trigger"
      ? "trigger-only"
      : ["unresolved", "needs-seam"].includes(via)
        ? "no-seam"
        : "via-caller";
  const t = (fn.params ?? []).map((p) => String(p.type ?? "")).join(" ");
  const handOff = /=>\s*(\(|Promise<\s*\()/.test(String(fn.returnType ?? "")) ? "returns-closure" : "returns-value";
  const b = boundaryClasses(fn.boundaries);
  const boundary = b === "none" ? "no-boundary" : b.includes("db") ? "db" : b.includes("http") ? "http" : "other-boundary";
  return [entryClass, handOff, paramShape(fn.params), boundary, fn.async ? "async" : "sync"].join(" | ");
}

function scans() {
  const out = [];
  const self = join(OUT_DIR, "scan.json");
  if (existsSync(self)) out.push(["ai-cen", JSON.parse(readFileSync(self, "utf8"))]);
  const dir = join(OUT_DIR, "bench");
  if (existsSync(dir)) {
    // ai-centralization-fresh is THIS repo scanned through the bench path - the
    // same repo as `ai-cen`, and counting it twice would make its shape coverage
    // look corroborated by an independent source. `conformance` is a fixture,
    // not a codebase.
    const SKIP = new Set(["ai-centralization-fresh", "conformance"]);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".scan.json") && !SKIP.has(n.replace(".scan.json", ""))).sort()) {
      out.push([f.replace(".scan.json", ""), JSON.parse(readFileSync(join(dir, f), "utf8"))]);
    }
  }
  return out;
}

function main() {
  const byRepo = new Map();
  const bySig = new Map();
  for (const [repo, doc] of scans()) {
    const local = new Map();
    for (const fn of doc.functions ?? []) {
      if (fn.typeOnly) continue;
      // TEST FILES ARE NOT THE SUBJECT. Foreign repos keep their specs under
      // src/, and a foreign target gets an empty SRC_EXCLUDE, so the first run
      // of this census reported its five most common "unseen shapes" as
      // `<arg1 of it>` and `<arg1 of describe>` - 8254 of them. Characterizing
      // a test callback is meaningless: it has no production caller and its
      // behaviour is the test's, not the service's.
      //
      // This does NOT invalidate the denominator benchmark, where istanbul
      // counted the same files and both sides agreed. It invalidates a sampling
      // census, which is about what is worth deriving an input for.
      if (IS_TEST.test(fn.file ?? "")) continue;
      const sig = signature(fn);
      local.set(sig, (local.get(sig) ?? 0) + 1);
      if (!bySig.has(sig)) bySig.set(sig, { total: 0, repos: new Map(), examples: [] });
      const e = bySig.get(sig);
      e.total += 1;
      e.repos.set(repo, (e.repos.get(repo) ?? 0) + 1);
      if (e.examples.length < 3) e.examples.push({ repo, id: fn.id });
      e.candidates ??= [];
      if (e.candidates.length < 60) {
        e.candidates.push({
          repo,
          id: fn.id,
          name: fn.name,
          span: (fn.endLine ?? fn.line) - fn.line,
          params: (fn.params ?? []).map((x) => x.name),
          uncoveredArms: (fn.arms?.list ?? []).filter((a) => a.istanbul).length,
          via: fn.via?.kind ?? "direct",
          boundaries: (fn.boundaries ?? []).map((b) => b.symbol),
        });
      }
    }
    byRepo.set(repo, local);
  }

  /**
   * The baseline is what has been RECORDED, not what has a proposal.
   *
   * A first version used "ai-cen has a proposal for this shape". That selector
   * conflated three different things - never arranged by the pipeline, covered
   * by the pre-existing hand-written suite, and hit incidentally (758 sides
   * were) - so it selected 43 ai-cen functions of which 42 were ALREADY FULLY
   * COVERED and 27 already had a proposal. Deriving for those yields a zero
   * coverage delta, which is the one thing a yield benchmark cannot afford.
   *
   * A recorded row in behaviour.json is proof the recorder could arrange that
   * shape and run it: input -> runner -> output, executed. That is the only
   * evidence worth baselining against.
   */
  const proven = new Map();
  const behPath = join(OUT_DIR, "behaviour.json");
  let provenRows = 0;
  let unjoinable = 0;
  if (existsSync(behPath)) {
    const beh = JSON.parse(readFileSync(behPath, "utf8"));
    const self = byRepo.has("ai-cen") ? scans().find(([n]) => n === "ai-cen")?.[1] : null;
    const fnById = new Map((self?.functions ?? []).map((f) => [f.id, f]));
    for (const r of beh.rows ?? []) {
      if (!r.invoked) continue;
      provenRows += 1;
      const fn = fnById.get(r.functionId);
      // A functionId that no longer resolves is arm-id rot in behaviour.json
      // itself - 8 of 365 rows are in that state. Counted, never guessed at.
      if (!fn) { unjoinable += 1; continue; }
      const sig = signature(fn);
      proven.set(sig, (proven.get(sig) ?? 0) + 1);
    }
  }

  const aicen = proven;
  const sigs = [...bySig.entries()].sort((a, b) => b[1].total - a[1].total);
  const unseen = sigs.filter(([s]) => !aicen.has(s));
  const thin = sigs.filter(([s]) => aicen.has(s) && aicen.get(s) < MIN);

  const out = process.stdout;
  out.write(`\nstage 3 diversity — how many DISTINCT arrangements the recorder must handle\n\n`);
  out.write(`  repo".padEnd"\n`.replace('  repo".padEnd"\n', ""));
  out.write(`  ${"repo".padEnd(16)}${"functions".padStart(10)}${"distinct shapes".padStart(17)}${"shapes only it has".padStart(20)}\n`);
  for (const [repo, local] of byRepo) {
    const only = [...local.keys()].filter((s) => bySig.get(s).repos.size === 1).length;
    const fns = [...local.values()].reduce((a, b) => a + b, 0);
    out.write(`  ${repo.padEnd(16)}${String(fns).padStart(10)}${String(local.size).padStart(17)}${String(only).padStart(20)}\n`);
  }
  out.write(`\n  ${bySig.size} distinct shapes across the corpus\n`);
  out.write(`  ${provenRows} recorded rows here, ${provenRows - unjoinable} joinable${unjoinable ? ` (${unjoinable} rotted functionIds)` : ""} → ${proven.size} shapes PROVEN arrangeable end to end\n`);
  out.write(`  ${unseen.length} shapes with NO recorded row anywhere · ${thin.length} proven by fewer than ${MIN} rows\n`);

  out.write(`\n  the 12 largest UNPROVEN shapes — these are the sample:\n`);
  for (const [sig, e] of unseen.slice(0, 12)) {
    out.write(`\n    ${e.total} functions in ${e.repos.size} repo(s)\n      ${sig}\n`);
    out.write(`      e.g. ${e.examples.map((x) => `${x.repo}:${x.id.split("/").pop()}`).join(" · ")}\n`);
  }

  // THE SAMPLE, named. A plan that says "5 per shape" is not executable; a plan
  // that names repo + functionId + the arms to aim at is. Preference order
  // within a shape: an uncovered arm to aim at, then a function small enough to
  // read whole, then spread across repos so one repo's idioms cannot dominate
  // a shape's evidence.
  const pick = (sig, want) => {
    const e = bySig.get(sig);
    const byRepo = new Map();
    // ai-cen is the CONTROL, not the sample: it already proves 47 shapes with
    // 357 joinable recorded rows, and 42 of 43 functions a proposal-based
    // selector picked here were already fully covered.
    for (const c of (e.candidates ?? []).filter((x) => x.repo !== "ai-cen")) {
      if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
      byRepo.get(c.repo).push(c);
    }
    for (const list of byRepo.values()) list.sort((a, b) => (b.uncoveredArms ?? 0) - (a.uncoveredArms ?? 0) || (a.span ?? 0) - (b.span ?? 0));
    // round-robin the repos so 5 samples come from up to 5 different codebases
    const out = [];
    const keys = [...byRepo.keys()];
    for (let i = 0; out.length < want && i < 200; i += 1) {
      const k = keys[i % keys.length];
      const next = byRepo.get(k).shift();
      if (next) out.push(next);
      if (keys.every((x) => byRepo.get(x).length === 0)) break;
    }
    return out;
  };

  const plan = [];
  for (const [sig, e] of unseen) {
    const want = Math.min(MIN, e.total);
    plan.push({ sig, have: 0, want, total: e.total, from: [...e.repos.keys()], sample: pick(sig, want) });
  }
  for (const [sig, e] of thin) {
    const want = Math.min(MIN * 2 - aicen.get(sig), e.total);
    plan.push({ sig, have: aicen.get(sig), want, total: e.total, from: [...e.repos.keys()], sample: pick(sig, want) });
  }
  const doc = { stage: "3-diversity", provenRows, provenShapes: proven.size, unjoinableRows: unjoinable, builtAt: new Date().toISOString(), minPerShape: MIN, shapes: bySig.size, aicenShapes: aicen.size, unseen: unseen.length, thin: thin.length, plan };
  const path = arg("--json", join(OUT_DIR, "diversity.json"));
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  const named = plan.reduce((n, x) => n + x.sample.length, 0);
  const short = plan.filter((x) => x.sample.length < x.want);
  out.write(`\n  sampling plan: ${plan.length} shapes · ${plan.reduce((n, x) => n + x.want, 0)} wanted · ${named} NAMED with repo+functionId\n`);
  if (short.length) out.write(`  ${short.length} shape(s) could not be filled - too few candidates in the corpus\n`);
  const byRepoCount = {};
  for (const x of plan) for (const c of x.sample) byRepoCount[c.repo] = (byRepoCount[c.repo] ?? 0) + 1;
  out.write(`\n  derivations per repo:\n`);
  for (const [r, n] of Object.entries(byRepoCount).sort((a, b) => b[1] - a[1])) out.write(`    ${String(n).padStart(4)}  ${r}\n`);
  out.write(`\n  → out/diversity.json carries the named sample\n\n`);
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