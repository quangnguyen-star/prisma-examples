#!/usr/bin/env node
/**
 * The next rung of the horizontal expansion, chosen by the machine.
 *
 * The instruction for this phase is "10% of all functions of each repo, then
 * 20%, then 30%, randomly, evenly distributed across the kind system we have".
 * Every word of that is a constraint on WHO chooses:
 *
 *   - "10% of all functions of each repo" - the denominator is the repo's own
 *     runnable function count, not the corpus. A repo with 548 functions owes
 *     55 at the first rung and a repo with 189 owes 19.
 *   - "randomly" - not the ones an agent finds easiest, which is the failure
 *     mode this exists to prevent. An agent picking its own targets will pick
 *     pure functions and report a high pass rate that means nothing.
 *   - "evenly distributed in the kind system" - stratified by arrangement
 *     SHAPE, round-robin across shapes, so the rung cannot fill up with 37
 *     variations of the one shape that happens to be most common.
 *
 * So the selection is seeded and reproducible: same repo, same rung, same seed
 * gives the same list, and anyone can re-derive it. That matters because the
 * whole point of the rung is that nobody hand-picked it.
 *
 * The shape function is imported from diversity.mjs rather than re-implemented,
 * because a second copy would drift and the two would stratify differently
 * while both claiming to be "the kind system".
 *
 *   node .claude/charpilot/expand.mjs --pct 10
 *   node .claude/charpilot/expand.mjs --pct 20 --repo pricing-ms
 *   node .claude/charpilot/expand.mjs --pct 10 --json out/expand-10.json
 *
 * Reads each installed repo's own scan.json and behaviour.json. Writes nothing
 * unless --json is given.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";
import { signature } from "./diversity.mjs";

const ARGV = process.argv.slice(2);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const PCT = Number(arg("--pct", "10"));
const ONLY_REPO = arg("--repo", null);
const SEED = Number(arg("--seed", "20260908"));
const JSON_OUT = arg("--json", null);

/** Same exclusion diversity.mjs uses: a test callback is not the subject. */
const IS_TEST = /(^|\/)(__tests__|__mocks__|test|tests|e2e)\/|\.(test|spec|e2e-spec|bench|stories)\.tsx?$|(^|\/)test-utils?\//i;

/**
 * The installed targets, and where each one's artifacts live.
 *
 * This repo is first because it is the pilot; the rest are the native installs
 * under qode-knowledge/repos. A repo with no scan.json is reported as such
 * rather than skipped silently - "not installed yet" is a real answer and the
 * caller needs it to know the rung is incomplete.
 */
const FLEET_ROOT = process.env.CHARPILOT_FLEET_ROOT
  ? resolve(process.env.CHARPILOT_FLEET_ROOT)
  : resolve(REPO_ROOT, "..", "qode-knowledge", "repos");
/**
 * The rung is a FLEET tool, and a freshly onboarded repo is not a fleet.
 *
 * The sibling list used to be unconditional, so on a repo installed anywhere
 * else this reported five services that do not exist as "not installed yet" -
 * a real answer about the wrong question. The target itself is always first and
 * always real; the siblings are added only when the fleet root is actually
 * there, and `CHARPILOT_FLEET_ROOT` points it somewhere else.
 */
const FLEET = [
  [basename(REPO_ROOT).slice(0, 12), REPO_ROOT],
  ...(existsSync(FLEET_ROOT)
    ? ["pricing-ms", "interview-service", "location-ms", "notification-ms", "profile-centralized"]
        .map((r) => [r, resolve(FLEET_ROOT, r)])
        .filter(([, dir]) => existsSync(dir))
    : []),
];

/**
 * A seeded generator, so a rung is reproducible.
 *
 * Math.random would make the selection unauditable: the list could not be
 * re-derived, so nobody could check that it was not hand-picked, which is the
 * one property the rung needs. mulberry32 - small, and its distribution is
 * fine for choosing rows out of buckets.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function loadRepo(name, root) {
  const scanPath = join(root, ".claude/charpilot/out/scan.json");
  if (!existsSync(scanPath)) return { name, root, installed: false };
  const scan = JSON.parse(readFileSync(scanPath, "utf8"));
  const functions = (scan.functions ?? []).filter((f) => !f.typeOnly && !IS_TEST.test(f.file ?? ""));

  // Which functions already have a RECORDED row. Not "has a proposal" - a
  // proposal that validates and does not record has proven nothing, which is
  // the rule the whole phase rests on.
  const recorded = new Set();
  const behPath = join(root, ".claude/charpilot/out/behaviour.json");
  if (existsSync(behPath)) {
    try {
      const beh = JSON.parse(readFileSync(behPath, "utf8"));
      for (const row of beh.rows ?? []) if (row.invoked && row.functionId) recorded.add(row.functionId);
    } catch {
      // An unreadable artifact means "nothing proven yet", which is the safe
      // reading: it can only make the rung larger, never smaller.
    }
  }
  return { name, root, installed: true, functions, recorded };
}

function pickForRepo(repo, pct, rand) {
  const target = Math.max(1, Math.round(repo.functions.length * (pct / 100)));
  const have = repo.functions.filter((f) => repo.recorded.has(f.id));
  const short = target - have.length;
  if (short <= 0) {
    return { target, have: have.length, short: 0, picks: [], byShape: [] };
  }

  // Bucket the NOT-yet-recorded functions by shape, shuffle inside each bucket,
  // then take one from each bucket in turn. Round-robin is what makes the rung
  // evenly distributed rather than merely random: a plain random draw over all
  // candidates would return the common shapes in proportion, which is the
  // opposite of what a shape census is for.
  const buckets = new Map();
  for (const f of repo.functions) {
    if (repo.recorded.has(f.id)) continue;
    const sig = signature(f);
    if (!buckets.has(sig)) buckets.set(sig, []);
    buckets.get(sig).push(f);
  }
  // Bucket ORDER is shuffled too. Sorting by size would make the rung start
  // with the most common shape every time, and sorting by name would make it
  // alphabetical - both are hand-picking with extra steps.
  const order = shuffled([...buckets.keys()], rand);
  for (const k of order) buckets.set(k, shuffled(buckets.get(k), rand));

  const picks = [];
  let exhausted = false;
  while (picks.length < short && !exhausted) {
    exhausted = true;
    for (const sig of order) {
      if (picks.length >= short) break;
      const bucket = buckets.get(sig);
      if (!bucket.length) continue;
      exhausted = false;
      const f = bucket.shift();
      picks.push({
        repo: repo.name,
        id: f.id,
        shape: sig,
        file: f.file,
        async: Boolean(f.async),
        params: (f.params ?? []).map((p) => p.name),
        via: f.via?.kind ?? "direct",
        entryReachable: Boolean(f.entry?.reachable),
        entryKind: f.entry?.kind ?? null,
        uncoveredArms: f.arms?.uncovered ?? null,
        boundaries: (f.boundaries ?? []).map((b) => b.symbol),
      });
    }
  }

  const byShape = [...picks.reduce((m, p) => m.set(p.shape, (m.get(p.shape) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1]);
  return { target, have: have.length, short, picks, byShape, shapesAvailable: buckets.size };
}

function main() {
  const rand = rng(SEED);
  const out = [];
  const missing = [];
  for (const [name, root] of FLEET) {
    if (ONLY_REPO && name !== ONLY_REPO) continue;
    const repo = loadRepo(name, root);
    if (!repo.installed) {
      missing.push(name);
      continue;
    }
    out.push({ repo: name, root, functions: repo.functions.length, ...pickForRepo(repo, PCT, rand) });
  }

  const w = process.stdout;
  w.write(`\nexpansion rung — ${PCT}% of each repo's own runnable functions · seed ${SEED}\n\n`);
  let totalShort = 0;
  for (const r of out) {
    totalShort += r.short;
    const state = r.short === 0 ? "MET" : `needs ${r.short}`;
    w.write(
      `  ${r.repo.padEnd(21)} ${String(r.functions).padStart(5)} functions · target ${String(r.target).padStart(4)} · recorded ${String(r.have).padStart(4)} · ${state}\n`
    );
    if (r.short) {
      w.write(`      drawn from ${r.shapesAvailable} shape(s), round-robin: `);
      w.write(`${r.byShape.slice(0, 3).map(([s, n]) => `${n}x ${s.split(" | ").slice(0, 3).join("/")}`).join(" · ")}\n`);
    }
  }
  if (missing.length) {
    w.write(`\n  not installed (no scan.json), so this rung cannot include them: ${missing.join(", ")}\n`);
  }
  w.write(`\n  ${totalShort} function(s) short of the ${PCT}% rung across ${out.length} repo(s)\n`);
  w.write(
    `\n  The selection is SEEDED. Re-run with the same --pct and --seed to get the\n` +
      `  same list - which is the point: nobody hand-picked it, and anyone can check.\n`
  );

  if (JSON_OUT) {
    const path = resolve(REPO_ROOT, JSON_OUT.startsWith("out/") ? join(OUT_DIR, JSON_OUT.slice(4)) : JSON_OUT);
    writeFileSync(path, `${JSON.stringify({ stage: "expand", pct: PCT, seed: SEED, builtAt: new Date().toISOString(), repos: out, missing }, null, 2)}\n`);
    w.write(`\n  → ${path}\n`);
  }
  return totalShort;
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