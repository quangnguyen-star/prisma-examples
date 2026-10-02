#!/usr/bin/env node
/**
 * fleetshapes — the smallest set of repos that shows every shape the fleet has.
 *
 *   node tools/fleetshapes.mjs                # the covering set, and why
 *   node tools/fleetshapes.mjs --matrix       # every repo against every shape
 *   node tools/fleetshapes.mjs --json
 *   node tools/fleetshapes.mjs --budget 1500  # cover as much as $1500 buys
 *
 * WHY THIS EXISTS. `fleetsweep` counts how much work each repo holds, which
 * answers "what would this cost". It cannot answer the question that actually
 * decides the order: WHAT BREAKS. Every defect this pipeline lost a day to was
 * a SHAPE it had not met before —
 *
 *     a proposal with `invoke.build` whose functionId the scan does not hold
 *     a boundary entry that is `null`
 *     a repo with vitest 4 and no vitest config at all      (tracy-worker)
 *     a service whose deploy name is not its package name   (qode-ptp-ms)
 *     an arm inside a closure the driver returns
 *     a repo whose suite is red only because vitest auto-loads its own `.env`
 *
 * — and none of those are visible in a side count. They are visible in the
 * ENTRY KINDS, ARM KINDS, DRIVER KINDS and BOUNDARY CLASSES a repo contains,
 * and every one of those is already in `out/fleet/<name>/scan.json`, which
 * `fleetcheck` cached without running a single test.
 *
 * So this turns "which repos do we run" from a guess into a set cover: pick the
 * cheapest repos whose union carries every shape in the fleet. Running those is
 * how a defect gets found once instead of thirty-three times.
 *
 * WHAT IT WILL NOT TELL YOU, and this is the honest half. A shape that has never
 * failed can still fail; two repos with identical shape vectors can differ in
 * their environment, their suite and their boundaries, which is where half of
 * today's defects actually lived. The covering set is where to START, not a
 * proof that the rest are safe. `fleetbaseline` answers the environment half.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hitIndexFrom, measureArms } from "./armjoin.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

const CACHE = arg("--cache", join(OUT_DIR, "fleet"));
const USD_PER_SIDE = Number(arg("--rate", "0.23"));
const BUDGET = ARGV.includes("--budget") ? Number(arg("--budget", "0")) : null;

/**
 * The framework each repo runs, read from fleetcheck's own list.
 *
 * READ, NOT COPIED. `FLEET` in fleetcheck.mjs is the one place the fleet's
 * membership, deployed branch and framework live, and a second copy here would
 * be a second thing to keep right -- which is the defect `loadProposals` exists
 * to prevent, one directory over. It is not exported, so this reads the source;
 * if that array ever moves, this says so rather than quietly reporting every
 * repo as unknown.
 */
function frameworks() {
  const src = readFileSync(join(PILOT_DIR, "fleetcheck.mjs"), "utf8");
  const block = src.slice(src.indexOf("const FLEET = ["), src.indexOf("];", src.indexOf("const FLEET = [")));
  const out = new Map();
  for (const m of block.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    out.set(m[1], { branch: m[2], framework: m[3] });
  }
  if (!out.size) {
    process.stderr.write("! fleetcheck.mjs's FLEET array could not be read — frameworks will read as unknown\n");
  }
  return out;
}

/**
 * What a boundary module IS, rather than what it is called.
 *
 * The specifier is not the question; what answers it is. `@prisma/client`,
 * `ioredis` and `axios` fail in three different ways at stage 4 -- a database
 * a container may reach, a cache with no route from one, and a transport that
 * is never answered because it is a transport. A repo that has all three has
 * met every class of boundary refusal there is; a repo with thirty internal
 * `@/services/...` imports has met none of them.
 *
 * Unrecognised bare specifiers are `vendor`, and relative ones `internal`.
 * Deliberately coarse: this decides which repos to run, not what to mock.
 */
export function boundaryClass(module) {
  const m = String(module ?? "");
  if (!m) return null;
  if (/^[./]/.test(m) || m.startsWith("@/")) return "internal";
  if (/prisma|typeorm|sequelize|mongoose|knex|drizzle|pg$|mysql/.test(m)) return "database";
  if (/redis/.test(m)) return "cache";
  if (/axios|node-fetch|got$|undici|superagent/.test(m)) return "http";
  if (/graphile|bullmq|bull$|kafkajs|amqplib|sqs/.test(m)) return "queue";
  if (/@aws-sdk|googleapis|@google-cloud|firebase|stripe|twilio|@slack|telegraf|openai|@anthropic/.test(m)) return "sdk";
  if (/^(fs|path|crypto|http|https|child_process|node:)/.test(m)) return "node-builtin";
  if (/jsonwebtoken|bcrypt|argon2/.test(m)) return "crypto";
  if (/zod|joi|yup|class-validator/.test(m)) return "schema";
  return "vendor";
}

/** Every shape one repo carries, as a set of `class:value` tags. */
function shapesOf(name, meta) {
  const dir = join(CACHE, name);
  const scanPath = join(dir, "scan.json");
  if (!existsSync(scanPath)) return { name, error: "no scan.json in the cache" };
  const scan = JSON.parse(readFileSync(scanPath, "utf8"));

  const tags = new Set();
  const counts = new Map();
  const bump = (tag) => { tags.add(tag); counts.set(tag, (counts.get(tag) ?? 0) + 1); };

  if (meta?.framework) bump(`framework:${meta.framework}`);

  for (const fn of scan.functions ?? []) {
    const kind = fn.entry?.kind;
    if (kind) bump(`entry:${kind}`);
    // The driver kind is what stage 4 has to reach the function THROUGH, and it
    // is where the closure and trigger defects lived.
    const via = typeof fn.via === "string" ? fn.via : fn.via?.kind;
    if (via) bump(`via:${via}`);
    if (fn.name === "<returned closure>") bump("shape:returned-closure");
    if (fn.async) bump("shape:async");
    if ((fn.params ?? []).some((p) => p?.name && typeof p.name === "object")) bump("shape:destructured-param");
    for (const arm of fn.arms?.list ?? []) if (arm.kind) bump(`arm:${arm.kind}`);
    for (const b of fn.boundaries ?? []) {
      const c = boundaryClass(b.module);
      if (c) bump(`boundary:${c}`);
    }
  }
  for (const g of scan.moduleScopeArms ?? []) {
    if ((g.list ?? []).length) bump("shape:module-scope-arm");
  }

  // The side count, so the cover can prefer a cheap carrier of a rare shape.
  const covPath = join(dir, "coverage-final.json");
  let sides = 0;
  if (existsSync(covPath)) {
    const byArm = measureArms(scan, hitIndexFrom(JSON.parse(readFileSync(covPath, "utf8"))));
    for (const a of byArm.values()) if (a.known) sides += a.uncoveredSides.length;
  }

  return {
    name,
    branch: meta?.branch ?? null,
    framework: meta?.framework ?? "unknown",
    functions: (scan.functions ?? []).length,
    sides,
    usd: Math.round(sides * USD_PER_SIDE),
    tags: [...tags].sort(),
    counts: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * The cheapest repos whose union carries every shape, greedily.
 *
 * GREEDY AND NOT OPTIMAL, said out loud. Exact set cover is NP-hard and this is
 * 33 sets; greedy is within a log factor and, more to the point, the input is
 * uncertain enough that an exact answer would be false precision. What matters
 * is the ORDER — it always takes the repo that buys the most new shapes per
 * dollar, so reading the list top-down is reading the diagnostic value.
 */
export function cover(repos, { budget = null } = {}) {
  const universe = new Set(repos.flatMap((r) => r.tags));
  const remaining = new Set(universe);
  const chosen = [];
  const pool = repos.filter((r) => r.tags.length);
  let spent = 0;

  while (remaining.size && pool.length) {
    let best = null;
    for (const r of pool) {
      const gain = r.tags.filter((t) => remaining.has(t)).length;
      if (!gain) continue;
      // Per dollar, with a floor so a free repo does not divide by zero. A repo
      // that carries one rare shape and costs $6 beats one that carries three
      // and costs $3,000, which is the whole point of pricing the cover.
      const value = gain / Math.max(1, r.usd);
      if (!best || value > best.value || (value === best.value && r.usd < best.repo.usd)) {
        best = { repo: r, gain, value };
      }
    }
    if (!best) break;
    if (budget !== null && spent + best.repo.usd > budget) {
      pool.splice(pool.indexOf(best.repo), 1);
      continue;
    }
    const gained = best.repo.tags.filter((t) => remaining.has(t));
    for (const t of gained) remaining.delete(t);
    chosen.push({ ...best.repo, gained });
    spent += best.repo.usd;
    pool.splice(pool.indexOf(best.repo), 1);
  }
  return { universe, chosen, uncovered: [...remaining], spent };
}

function main() {
  if (!existsSync(CACHE)) {
    process.stderr.write(`no fleet cache at ${CACHE}. Run \`node tools/fleetcheck.mjs\` first.\n`);
    process.exit(1);
  }
  const meta = frameworks();
  const names = readdirSync(CACHE, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();

  const repos = names.map((n) => shapesOf(n, meta.get(n))).filter((r) => !r.error);

  // WHICH SHAPES ARE RARE, which is the other half of the answer. A shape only
  // one repo carries is a shape that will be met for the first time in
  // production if that repo is never run.
  const carriers = new Map();
  for (const r of repos) for (const t of r.tags) {
    if (!carriers.has(t)) carriers.set(t, []);
    carriers.get(t).push(r.name);
  }
  const rare = [...carriers.entries()].filter(([, who]) => who.length <= 2)
    .sort((a, b) => a[1].length - b[1].length);

  const { universe, chosen, uncovered, spent } = cover(repos, { budget: BUDGET });

  if (flag("--json")) {
    mkdirSync(OUT_DIR, { recursive: true });
    const doc = { generatedAt: new Date().toISOString(), rate: USD_PER_SIDE,
                  universe: [...universe].sort(), repos, cover: chosen, rare, uncovered };
    writeFileSync(join(OUT_DIR, "fleetshapes.json"), `${JSON.stringify(doc, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }

  if (flag("--matrix")) {
    const tags = [...universe].sort();
    for (const r of repos.sort((a, b) => b.tags.length - a.tags.length)) {
      process.stdout.write(`${r.name.padEnd(28)} ${r.tags.length}/${tags.length}  ${r.framework}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    `${universe.size} distinct shape(s) across ${repos.length} repo(s) — entry kinds, driver kinds, arm kinds,\n` +
    `boundary classes and frameworks, all read from the scan cache with no test run and no model call.\n\n` +
    `THE COVERING SET — run these, in this order, and every shape in the fleet has been exercised once:\n\n`
  );

  let running = 0;
  for (const [i, r] of chosen.entries()) {
    running += r.usd;
    process.stdout.write(
      `${String(i + 1).padStart(2)}. ${r.name.padEnd(28)} ${String(r.sides).padStart(6)} sides  ` +
      `~$${String(r.usd).padStart(5)}  (cumulative $${running})\n` +
      `    +${r.gained.length} new: ${r.gained.slice(0, 8).join(" ")}${r.gained.length > 8 ? ` …+${r.gained.length - 8}` : ""}\n`
    );
  }

  process.stdout.write(
    `\n${chosen.length} of ${repos.length} repo(s) · ~$${spent.toLocaleString()} of the ` +
    `$${repos.reduce((n, r) => n + r.usd, 0).toLocaleString()} the whole fleet would cost` +
    (uncovered.length ? ` · ${uncovered.length} shape(s) NOT covered: ${uncovered.join(" ")}` : "") + "\n\n"
  );

  process.stdout.write("SHAPES CARRIED BY ONE OR TWO REPOS — met for the first time in production if never run:\n");
  for (const [tag, who] of rare.slice(0, 20)) {
    process.stdout.write(`  ${tag.padEnd(30)} ${who.join(", ")}\n`);
  }

  process.stdout.write(
    `\nThis ranks by SHAPE, not by risk: two repos with the same shape vector can still differ in their suite,\n` +
    `their environment and which boundaries a container can reach, and half of today's defects lived there.\n` +
    `The covering set is where to start, not a proof the rest are safe.\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
