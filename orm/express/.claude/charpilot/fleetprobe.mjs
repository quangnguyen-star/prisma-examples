#!/usr/bin/env node
/**
 * fleetprobe — one or two packets per SHAPE, per repo, with an agent answering,
 * so the kill points of the whole fleet are known for the price of a rounding
 * error on one characterization run.
 *
 *   node tools/fleetprobe.mjs                  # every repo in the fleet list
 *   node tools/fleetprobe.mjs --only a,b       # just these
 *   node tools/fleetprobe.mjs --from pricing-ms
 *   node tools/fleetprobe.mjs --plan           # classify and sample only: no clone, no agent, no money
 *   node tools/fleetprobe.mjs --per-type 2     # functions sampled per shape (default 2)
 *   node tools/fleetprobe.mjs --max-functions 12
 *   node tools/fleetprobe.mjs --rounds 3       # walk/answer rounds per repo (default 3)
 *   node tools/fleetprobe.mjs --keep           # leave the clone and node_modules
 *   node tools/fleetprobe.mjs --force          # probe a repo that is already cached
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A RUN. A full characterization pass over
 * this fleet is ~65,000 sides at the one measured rate, $0.23/side — about
 * $15,000 and weeks of wall time. The thing we actually need out of each repo
 * is NOT coverage. It is WHERE IT BREAKS. Every defect this pipeline has lost a
 * day to was a SHAPE it had not met before:
 *
 *     a proposal building its own subject, whose functionId the scan does not hold
 *     a boundary entry that is `null`
 *     a repo with vitest 4 and no vitest config at all      (tracy-worker)
 *     a service whose deploy name is not its package name   (qode-ptp-ms)
 *     an arm inside a closure the driver returns
 *
 * None of those is visible in a side count, and none of them needs a whole repo
 * to find. They are properties of a FUNCTION TYPE — its entry kind, the driver
 * that reaches it, the boundary classes it touches — and `fleetshapes` already
 * classifies every function in the fleet by exactly those, out of the scan
 * cache, for nothing. So: take a few functions of each type, hand the pipeline
 * those and nothing else, and let a subagent run the full flow over all their
 * sides. One or two packets buys the knowledge a whole repo would have bought.
 *
 * WHAT IT IS AND IS NOT A SIBLING OF.
 *
 *   `fleetsweep`    counts the work from the cache. No clone, no run.
 *   `fleetbaseline` runs each repo's OWN suite, so the sweep can subtract it.
 *   `fleetwalk`     does everything a container run does EXCEPT let an agent
 *                   answer — clone, install, toolset, walk to the first
 *                   handover. Free, and it stops exactly where the money starts.
 *   `fleetprobe`    starts where fleetwalk stops. It is the same mechanical
 *                   half plus the expensive half, over a deliberately tiny
 *                   selection, so the stages PAST the first handover — record,
 *                   determinism, emit, measure, repair, ruling, report — are
 *                   exercised at all. fleetwalk can never reach them: nothing
 *                   answers, so `record` refuses with no proposals on disk,
 *                   which is what it did on notification-ms.
 *
 * THE SELECTION IS THE WHOLE IDEA, and it is not a shard. `CHARPILOT_SHARD` is
 * a source prefix and cannot express "these twelve functions"; the selector this
 * tool writes for is `CHARPILOT_PROBE_FUNCTIONS`, added to `worklist.mjs` for
 * this, with the shard's three rules kept exactly — applied to the items and
 * never to the scan, reported in the summary with what it excluded, and added
 * back into the join self-check, which is a defect that was fixed today and
 * would have come straight back through a second selector.
 *
 * HOW THE AGENT ANSWERS, and what this does NOT reproduce. `docker/localrun.py`
 * is the reference for a walk running locally with an agent: it builds the
 * container's own `Run`, calls the container's own pack, and `char.agent.turn`
 * spawns `claude --print` with `docker/settings.json` layered on by `--settings`.
 * This drives the same loop — walk, then answer what the walk refuses to decide,
 * then walk again — and spawns the agent the same way, with the same permission
 * file and the same credential rule. It deliberately does NOT go through
 * localrun.py itself, and the reason is one variable: the nodejs pack's
 * preflight refuses a run without `CHARPILOT_EXPECTED_DB` naming a staging
 * database. That refusal is right for a run that may go live. There is no live
 * to go to here — staging is not routable from this host, every probe runs
 * `CHARPILOT_MODE=mocked` — so satisfying it would mean writing a database
 * triple into 32 env files that nothing will ever dial. What each stage REPORTS
 * about an unreachable boundary is one of the things being measured, so the
 * variable is left absent exactly as `fleetwalk` leaves it, and this drives the
 * pack's loop directly instead. Also not reproduced, each for localrun's own
 * stated reason: the clone from GITHUB_TOKEN (this clones anonymously over
 * HTTPS from the public org path, as fleetcheck and fleetbaseline do), the
 * branch, the commit, the push and the pull request.
 *
 * A REPO WHOSE ENVIRONMENT WILL NOT RESOLVE IS A FINDING, NEVER A SKIP. Stage 1
 * resolves the deployed environment out of the qode-iac manifests by the
 * service's DEPLOY name, which is the FLEET entry's name and is not always the
 * package name — that is `qode-ptp-ms`'s known shape. "stagingenv cannot find a
 * ConfigMap for this service" is an answer about the repo and is recorded
 * against the step that said it.
 *
 * BOUNDED EVERYWHERE, AND THE BOUND IS IN THE ROW. This runs unattended over 32
 * repos and any one of them waiting forever costs every repo after it. A
 * timeout is a WRONG ANSWER — it says "we do not know" where a longer wait would
 * have said something — so every bound is recorded beside the outcome it may
 * have produced, and a reader can tell a slow stage from a stuck one.
 *
 * RESUMABLE AND IDEMPOTENT, exactly as fleetbaseline and fleetwalk are: a repo
 * whose `probe.json` is on disk is skipped and its cached row is still printed,
 * so a sweep that dies at repo 19 is worth restarting rather than repeating.
 * `--force` probes a cached repo again. Its own work directory, and self-
 * cleaning: `out/fleet-work` holds fleetcheck's pristine clones,
 * `out/fleet-baseline-work` and `out/fleet-walk-work` belong to the other two
 * sweeps and are in use; this uses `out/fleet-probe-work` and shares only the
 * answer cache, `out/fleet/<name>/`.
 *
 * WHAT IT ALREADY FOUND, on its third repo, which is the argument for it. Round 1
 * of `notification-ms` printed `worklist.mjs exited 1 — ✗ worklist measures 16
 * uncovered sides where coverage-charpilot recorded 108, and
 * CHARPILOT_PROBE_FUNCTIONS excluded 161`. Both selectors in `worklist.mjs` were
 * counting removed ITEMS into a self-check that counts instrumented, joined,
 * uncovered SIDES — and `CHARPILOT_SHARD` had the identical bug, which the same
 * clone confirmed at `67 + 74 should equal 108`. That is a defect in a shipped
 * feature, found for one repo and twenty minutes, by exactly the mechanism this
 * tool exists to be.
 *
 * WHAT A PROBE COSTS, said here because the obvious arithmetic is wrong. NOT
 * $0.23/side: that rate came from a run amortising its per-round and per-packet
 * cost over 146 sides, and a probe amortises it over sixteen. Measured on
 * `notification-ms`: $27.21 for 16 sides over 2 rounds, or $1.70/side. This is
 * cheap per REPO and dear per side, which is the right trade when the product is
 * "where does it break" rather than coverage.
 *
 * WHAT THE REPORT IS. Not the rows — the GROUPING. `out/fleetprobe.json` and the
 * printed summary group the findings by KILL SHAPE across repos: how many repos
 * died at the same stage for the same kind of reason, and which function TYPE
 * was in the packet when they did. That is what separates "this is one fix for
 * eleven repos" from "this is that repo's own problem", and it is the only thing
 * here worth reading first.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The fleet list has ONE owner and it is `fleetcheck.mjs`. `parseFleet` reads
// the literal out of its source because fleetcheck calls `main()` at the bottom
// and importing it would clone and measure the whole fleet as a side effect of
// asking what is in it. That parser already exists in fleetbaseline, is
// exported, and runs nothing on import — so it is imported rather than copied.
// `decisiveLine` comes with it and is the right pick for npm's own output,
// which is what the clone and the two installs produce.
import { decisiveLine, parseFleet } from "./fleetbaseline.mjs";
// The walk's own vocabulary, imported from the tool that owns it. `parseWalk`
// turns the walk's stdout into one row per step; `refusalLine` picks the
// sentence a step CHOSE to write rather than whichever substring looks like an
// error; `reasonShape` is the normaliser that decides when two repos died of
// the same thing. A second copy of any of the three would drift, and the way it
// drifts is that two tools disagree about whether eleven repos are one fix.
// `walkEnv` is the clean-slate environment a probe must run under and is
// extended here rather than rebuilt.
import { parseWalk, reasonShape, refusalLine, walkEnv } from "./fleetwalk.mjs";
// ORDER is what findings are attributed to. Imported and never copied: a copy
// would have silently mis-attributed every row after `determinism` when that
// step was inserted between `record` and `emit`.
import { ORDER } from "./steps/index.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_SELF = resolve(PILOT_DIR, "..", "..");
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

const WORK = resolve(arg("--work", join(OUT_DIR, "fleet-probe-work")));
const CACHE = resolve(arg("--cache", join(OUT_DIR, "fleet")));
const ORG = "https://github.com/Qode-Platform";
const BRANCH_OVERRIDE = arg("--branch", "");
const IAC = resolve(arg("--iac", "/Users/qode/Desktop/Repo/workspace/qode-knowledge/repos/qode-iac"));
const SETTINGS = resolve(arg("--settings", join(REPO_ROOT_SELF, "docker", "settings.json")));
const PROMPTS = resolve(arg("--prompts", join(PILOT_DIR, "..", "prompts")));

/**
 * HOW MANY FUNCTIONS OF EACH SHAPE, AND HOW MANY IN TOTAL.
 *
 * Two numbers and not one, because they answer different questions. `--per-type`
 * is how much evidence one shape gets: two, because one function that happens to
 * be trivial tells you nothing about its type and the second is what separates
 * "this shape is fine" from "that function was easy". `--max-functions` is how
 * long the flow is allowed to be, and it exists because the two multiply: on a
 * repo with 60 distinct shapes, two each is 120 functions, which is not a probe
 * — it is a run. Twelve keeps a round to one or two packets, which is what makes
 * this a short FULL flow rather than a slow partial one.
 *
 * When the cap bites, shapes are taken round-robin RAREST FIRST: a shape carried
 * by one function in the repo is the one that will otherwise be met for the
 * first time in production, and a shape carried by forty will be met again.
 */
const PER_TYPE = Math.max(1, Number(arg("--per-type", "2")));
const MAX_FUNCTIONS = Math.max(1, Number(arg("--max-functions", "12")));

/**
 * The five bounds, in minutes, and why a bound is not optional.
 *
 *   install   the repo's own `npm ci`. Minutes of network on the Nest services.
 *   toolset   `install.sh`, which adds four packages at the host's EXACT vitest
 *             version, so it is a second npm install and gets its own clock.
 *   walk      one pass of `workflow.mjs`. It runs the repo's whole suite under
 *             istanbul (`baseline`) and ts-morph over its whole source (`scan`),
 *             so it is the largest of the mechanical three by a wide margin.
 *   turn      one agent turn. `char/agent.py` bounds this by the run's whole
 *             remaining budget; there is no run budget here, so it is bounded on
 *             its own — a turn that will not end must not take the fleet with it.
 *   repo      everything above, end to end, for one repo. The per-stage bounds
 *             cannot add up to a promise on their own: three rounds of walk plus
 *             turn is already over two hours at the individual caps.
 */
const INSTALL_MINUTES = Number(arg("--install-minutes", "30"));
const TOOLSET_MINUTES = Number(arg("--toolset-minutes", "20"));
const WALK_MINUTES = Number(arg("--walk-minutes", "45"));
const TURN_MINUTES = Number(arg("--turn-minutes", "30"));
const REPO_MINUTES = Number(arg("--repo-minutes", "120"));
const ROUNDS = Math.max(1, Number(arg("--rounds", "3")));

/**
 * How many turns one answering round may take, and why this number.
 *
 * 40 is `CHARACTERIZE_MAX_TURNS` in `char/agent.py`, taken rather than invented:
 * a probe whose turn ceiling differs from a container run's is measuring the
 * ceiling as much as the repo. Its own note records why it is 40 and not 12 —
 * an item whose answer genuinely needs a component read costs several turns, and
 * cutting those off trades time for wrong answers.
 */
const MAX_TURNS = Math.max(1, Number(arg("--max-turns", process.env.CHARACTERIZE_MAX_TURNS ?? "40")));

const log = (s) => process.stdout.write(`${s}\n`);

/** Every child, with the two settings a long unattended sweep needs. */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    // 64 MB and not node's 1 MB default: the default does not truncate, it
    // KILLS the child with ENOBUFS, which arrives here looking exactly like the
    // command failing. NO_COLOR keeps ANSI escapes out of the quoted reason.
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
  });

export function fleetFromDisk(pilotDir = PILOT_DIR) {
  return parseFleet(readFileSync(join(pilotDir, "fleetcheck.mjs"), "utf8"));
}

/* ------------------------------------------------------- the join, borrowed */

/**
 * `measureArms` and `hitIndexFrom`, loaded through a synthetic package root.
 *
 * WHY THIS IS NOT A PLAIN IMPORT. `armjoin.mjs` imports `config.mjs`, which
 * resolves ONE repo from the CWD and REFUSES a directory that is not a package
 * root — and `nodejs/` is not one by its rule, because it has no `src/`. A
 * static import therefore kills this tool before its first line, which is
 * exactly what `node tools/fleetshapes.mjs` does today from that directory.
 * `fleetwalk` avoids the problem by never importing config at all; this cannot,
 * because the number it needs is "how many uncovered sides does this function
 * have" and the ONE implementation of that join is `measureArms` — the same one
 * stage 6 uses and the same one fleetsweep and fleetshapes quote. A second
 * implementation here would be a second answer to the question the whole
 * selection is sorted by.
 *
 * So a throwaway package root is created inside this tool's own work directory
 * and `CHARPILOT_SELF_ROOT` is pointed at it, which is the same arrangement the
 * tool tests use. Nothing is ever written into it. An operator who has already
 * set the variable keeps their value.
 */
let joinModules = null;
async function join_() {
  if (joinModules) return joinModules;
  if (!process.env.CHARPILOT_SELF_ROOT) {
    const self = join(WORK, ".self-root");
    mkdirSync(join(self, "src"), { recursive: true });
    writeFileSync(join(self, "package.json"), '{"name":"fleetprobe-self","type":"module"}\n');
    process.env.CHARPILOT_SELF_ROOT = self;
  }
  const armjoin = await import("./armjoin.mjs");
  const shapes = await import("./fleetshapes.mjs");
  const config = await import("./config.mjs");
  joinModules = {
    hitIndexFrom: armjoin.hitIndexFrom,
    measureArms: armjoin.measureArms,
    boundaryClass: shapes.boundaryClass,
    repoRoot: config.REPO_ROOT,
  };
  return joinModules;
}

/**
 * The cached coverage document, re-keyed to absolute paths under the root the
 * join will measure against.
 *
 * NOT COSMETIC, and it is the difference between a real sample and a silent
 * zero. `hitIndexFrom` builds its keys with `relative(REPO_ROOT, absPath)`,
 * because in a normal run istanbul writes absolute paths and REPO_ROOT is the
 * repo. The FLEET CACHE is different by design — `fleetcheck` strips the machine
 * prefix before caching, so every key in `out/fleet/<name>/coverage-final.json`
 * is already relative — and `relative(<an absolute root>, "src/index.ts")`
 * resolves the second argument against the process CWD and produces a key that
 * matches no arm. The join then reports every arm as UNKNOWN, `uncoveredSides`
 * is empty for all of them, and the sample silently degrades to "sorted by
 * parameter count", which is a plausible-looking answer computed from nothing.
 *
 * `hitIndexFromSkeleton` in armjoin.mjs does exactly this re-keying for exactly
 * this reason; this is the same line for the cache's documents.
 */
export function absoluteKeys(coverage, repoRoot) {
  if (!coverage) return null;
  const out = {};
  for (const [key, entry] of Object.entries(coverage)) {
    out[key.startsWith("/") ? key : join(repoRoot, key)] = entry;
  }
  return out;
}

/* --------------------------------------------------------- the pure decisions */

/**
 * ONE FUNCTION'S TYPE, in fleetshapes' vocabulary and not a second one.
 *
 * `entry.kind` is how the function is reached from outside — an exported name,
 * a route handler, a call argument, a class method. `via.kind` is what stage 4
 * has to drive it THROUGH, and it is where the closure and trigger defects
 * lived. The pair is the type, because the two fail independently: an
 * `import-named` function behind a `trigger` driver and the same entry behind a
 * direct call are two different jobs for `derive` and two different jobs for
 * `record`.
 *
 * The boundary classes are the SECONDARY key and not part of the type, because
 * they decide what stage 4 has to answer rather than how stage 3 reaches it.
 * `@prisma/client`, `ioredis` and `axios` fail three different ways — a database
 * a container may reach, a cache with no route from one, and a transport that is
 * never answered because it is a transport — so two functions of the same type
 * touching different classes are two strata, and a repo that has both gets both.
 *
 * `via` is a string on some scans and an object on others; both shapes are read,
 * exactly as `fleetshapes.shapesOf` reads them.
 */
export function typeOf(fn, boundaryClass) {
  const entry = fn?.entry?.kind ?? "unknown";
  const via = typeof fn?.via === "string" ? fn.via : (fn?.via?.kind ?? "none");
  const classes = [...new Set((fn?.boundaries ?? []).map((b) => boundaryClass(b?.module)).filter(Boolean))].sort();
  return {
    type: `entry:${entry} via:${via}`,
    entry,
    via,
    boundaries: classes,
    // "none" is a real stratum and not a missing value: a function that touches
    // no boundary at all is the cheapest thing stage 4 can record, and a repo
    // whose probe holds only those has proved the least.
    boundaryKey: classes.length ? classes.map((c) => `boundary:${c}`).join("+") : "boundary:none",
  };
}

/**
 * How many uncovered branch sides each function has, by the one join there is.
 *
 * WHAT THIS COUNTS AND WHAT IT DOES NOT. Branch SIDES, joined arm by arm — the
 * same quantity `fleetsweep` prices and `fleetshapes` sorts by. It does not
 * count function-entry units, statements or `catch` arms: `worklist.mjs` calls
 * those "commissionable, NOT ratchetable" and they are a larger and different
 * number (15,194 against 8,546 on qode-ptp-ms). An arm whose join is UNKNOWN
 * contributes nothing rather than all of its sides, because claiming an unjoined
 * arm is uncovered is a claim on no evidence.
 *
 * `coverage-suite.json` when fleetbaseline has written one, `coverage-final.json`
 * otherwise, and WHICH IS SAID IN THE ROW. They are not the same question:
 * fleetcheck's document is the denominator measured with `include: []`, so every
 * hit count in it is zero and every side reads as uncovered. Sampling against it
 * is sampling against a ceiling, which is honest as long as nobody reads the
 * number as "what is left".
 */
export function uncoveredByFunction(scan, coverage, { measureArms, hitIndexFrom }) {
  const byArm = coverage ? measureArms(scan, hitIndexFrom(coverage)) : new Map();
  const out = new Map();
  for (const fn of scan.functions ?? []) {
    let sides = 0;
    let known = 0;
    for (const arm of fn.arms?.list ?? []) {
      const a = byArm.get(arm.armId);
      if (!a || !a.known) continue;
      known += 1;
      sides += a.uncoveredSides.length;
    }
    out.set(fn.id, { uncovered: sides, joinedArms: known, arms: (fn.arms?.list ?? []).length });
  }
  return out;
}

/**
 * Every function in a repo, with its type and its open work. Pure: one scan
 * document in, one array out, no disk and no clone.
 */
export function classify(scan, uncovered, boundaryClass) {
  return (scan.functions ?? [])
    .filter((fn) => fn && typeof fn.id === "string")
    .map((fn) => {
      const t = typeOf(fn, boundaryClass);
      const u = uncovered.get(fn.id) ?? { uncovered: 0, joinedArms: 0, arms: 0 };
      return {
        id: fn.id,
        file: fn.file,
        name: fn.name,
        params: (fn.params ?? []).length,
        sides: (fn.arms?.list ?? []).reduce((n, a) => n + (a.labels ?? []).length, 0),
        uncovered: u.uncovered,
        ...t,
        stratum: `${t.type} | ${t.boundaryKey}`,
      };
    });
}

/**
 * The sample: a few functions of each shape, deterministically.
 *
 * DETERMINISM IS THE PROPERTY, not an implementation detail. The same repo at
 * the same commit must produce the same twelve ids every time, or a second probe
 * is not comparable with the first and the whole tool degrades into anecdote. So
 * every comparison ends in the function id, which is unique, and nothing here
 * reads a clock, a hash seed or the order the scan happened to serialise in.
 *
 * WITHIN A SHAPE, in this order and for these reasons:
 *
 *   1. functions that HAVE uncovered sides first. A function with nothing open
 *      gives the walk nothing to ask about — worklist.mjs drops it — so a probe
 *      made of those is a probe that never reaches `derive`.
 *   2. fewest PARAMETERS. Parameters are what `derive` has to invent values for,
 *      and the point is to exercise the pipeline's shape rather than to buy the
 *      hardest instance of it. The cheap instance of a shape fails the same way
 *      the dear one does, for the failures this tool is looking for.
 *   3. fewest SIDES, for the same reason one step down: fewer sides is a shorter
 *      full flow, and the flow is the product.
 *   4. the id, so ties are broken by something that cannot move.
 *
 * ACROSS SHAPES, when the cap bites: round-robin, rarest shape first. A shape
 * carried by one function is the one that will otherwise be met for the first
 * time in production; a shape carried by forty will be met again next week. The
 * round-robin is what guarantees every shape is represented before any shape
 * gets its second function, so a cap of twelve on a repo with twenty shapes
 * samples twelve shapes rather than six shapes twice.
 */
export function sample(rows, { perType = PER_TYPE, cap = MAX_FUNCTIONS } = {}) {
  const strata = new Map();
  for (const r of rows) {
    if (!strata.has(r.stratum)) strata.set(r.stratum, []);
    strata.get(r.stratum).push(r);
  }
  for (const list of strata.values()) {
    list.sort(
      (a, b) =>
        (b.uncovered > 0) - (a.uncovered > 0) ||
        a.params - b.params ||
        a.sides - b.sides ||
        a.id.localeCompare(b.id)
    );
  }
  // Rarest first, then by stratum name so two shapes of equal rarity always
  // come out in the same order.
  const order = [...strata.entries()].sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]));

  const chosen = [];
  const takenFrom = new Set();
  for (let pass = 0; pass < perType && chosen.length < cap; pass++) {
    for (const [key, list] of order) {
      if (chosen.length >= cap) break;
      const pick = list[pass];
      if (!pick) continue;
      chosen.push(pick);
      takenFrom.add(key);
    }
  }
  return {
    chosen,
    // Both counts, because "12 functions" says nothing on its own. `types` is
    // the entry x driver pairs the repo has; `strata` adds the boundary classes;
    // `strataSampled` is how many of them this probe actually reached, and a
    // probe that reached 12 of 60 has proved a fifth of the repo's shapes.
    types: new Set(rows.map((r) => r.type)).size,
    strata: strata.size,
    strataSampled: takenFrom.size,
    withOpenSides: chosen.filter((c) => c.uncovered > 0).length,
    sidesInProbe: chosen.reduce((n, c) => n + c.uncovered, 0),
  };
}

/**
 * The probe file, exactly as `CHARPILOT_PROBE_FUNCTIONS` reads it: one id per
 * line, `#` a comment. The header is written so a person who finds this file in
 * a clone next month knows what wrote it and what it selected.
 */
export function probeFileBody(name, chosen, counts) {
  const lines = [
    `# fleetprobe: ${chosen.length} function(s) sampled from ${name}`,
    `# ${counts.strataSampled} of ${counts.strata} stratum/strata (${counts.types} entry x driver type(s)), ` +
      `${counts.withOpenSides} with uncovered sides, ${counts.sidesInProbe} uncovered side(s) between them`,
    "# read by worklist.mjs through CHARPILOT_PROBE_FUNCTIONS; one function id per line",
  ];
  for (const c of chosen) lines.push(`${c.id}  # ${c.stratum}, ${c.uncovered} open side(s), ${c.params} param(s)`);
  return `${lines.join("\n")}\n`;
}

/**
 * Whether this repo is already answered.
 *
 * The sweep is hours long and dies for reasons that have nothing to do with the
 * repo it died on — a laptop sleeping, a registry timing out, a gateway. Re-
 * running it must cost only what is missing, and it must cost nothing at all in
 * MODEL spend for a repo already probed. A cached row is still PRINTED, so the
 * final table after a restart is the whole fleet and not its tail.
 */
export function resumeDecision({ cached, force = false }) {
  if (force) return { skip: false, why: "--force: probing again over the cached row" };
  if (cached) return { skip: true, why: "probe.json already on disk (--force to probe again)" };
  return { skip: false, why: "no probe.json cached yet" };
}

/**
 * What `claude --print --output-format stream-json` said it did.
 *
 * The LAST `result` record and no other. The stream carries one record per
 * assistant message and a single terminating `result`, and the terminating one
 * is the only place the turn's own totals appear. Unparseable lines are skipped
 * rather than fatal: the CLI writes its own diagnostics into the same pipe, and
 * a turn that worked must not be reported as a failure because a warning was not
 * JSON.
 *
 * A TURN THAT COST NOTHING DID NOTHING, and the CLI still exits 0 for it —
 * measured on run 20260914T192024Z, where a gateway answering `503 no pool token
 * available` produced eight consecutive `success, 1 turns, $0.00` rounds. So
 * zero billable cost with an error is its own outcome here, as it is in
 * `char/agent.py`, and it is reported as `no-work` rather than as the repo's
 * failure. A repo is not broken because our gateway was.
 */
export function agentOutcome({ stdout = "", status = null, timedOut = false }) {
  let result = null;
  for (const line of String(stdout).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const doc = JSON.parse(t);
      if (doc?.type === "result") result = doc;
    } catch {
      continue;
    }
  }
  if (timedOut) {
    return { state: "timed-out", exitCode: status, turns: result?.num_turns ?? null, usd: result?.total_cost_usd ?? null };
  }
  const usd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
  const turns = Number.isInteger(result?.num_turns) ? result.num_turns : null;
  if (!result) {
    return { state: "no-result", exitCode: status, turns, usd, reason: "the agent produced no `result` record at all" };
  }
  if (usd === 0 && result.is_error) {
    return { state: "no-work", exitCode: status, turns, usd, reason: decisiveLine(result.result ?? "the agent reported an error at zero cost") };
  }
  if (result.is_error || status !== 0) {
    return { state: "failed", exitCode: status, turns, usd, reason: decisiveLine(result.result ?? `the agent exited ${status}`) };
  }
  return { state: "answered", exitCode: status, turns, usd };
}

/**
 * Where this probe stopped, and what it stopped on. `stage` is which half died —
 * classify, clone, deps, toolset, walk, agent — and `step` is which of the
 * walk's sixteen, which is null for everything before the walk. Two fields
 * because they answer two questions, exactly as `fleetwalk` splits them.
 */
export function killPoint(row) {
  if (row.classified?.ok === false) return { stage: "classify", step: null, reason: row.classified.reason };
  if (row.clone?.ok === false) return { stage: "clone", step: null, reason: row.clone.reason };
  if (row.deps?.ok === false) return { stage: "deps", step: null, reason: row.deps.reason };
  if (row.toolset?.ok === false) return { stage: "toolset", step: null, reason: row.toolset.reason };
  if (row.completed) return { stage: "done", step: null, reason: "every step satisfied — the full flow ran" };
  const rounds = row.rounds ?? [];
  const last = rounds[rounds.length - 1] ?? null;
  if (!last) return { stage: "walk", step: null, reason: "no round ran at all" };
  if (last.agent && last.agent.state && last.agent.state !== "answered") {
    return { stage: "agent", step: last.walk?.step ?? null, reason: last.agent.reason ?? `the agent turn ended ${last.agent.state}` };
  }
  // RAN OUT OF ROUNDS IS NOT A REFUSAL, and grouping it as one would be the
  // worst kind of wrong answer here: it would file a repo that was working
  // perfectly under whichever step it happened to be handing over at, and put
  // it in the same group as repos that genuinely died there. A walk that exits
  // 75 has succeeded — it reached the point where an agent earns its money —
  // and the round cap is this tool's own bound, not the repo's problem.
  if (last.walk?.exitCode === 75 && last.agent?.state === "answered") {
    return {
      stage: "rounds",
      step: last.walk?.step ?? null,
      reason:
        `the ${rounds.length}-round cap was reached with \`${last.walk?.step ?? "the walk"}\` still handing over ` +
        `${row.handover?.items ?? 0} item(s) — the probe's own bound, not a refusal by the repo`,
    };
  }
  return { stage: "walk", step: last.walk?.step ?? null, reason: last.walk?.refusal ?? "the walk stopped without naming a step" };
}

/**
 * THE DELIVERABLE: how many repos died at the same stage for the same kind of
 * reason, and which function TYPES were in the packet when they did.
 *
 * The reason is normalised by `reasonShape` — the tool that owns it — so paths,
 * quoted names and numbers do not split one shape into thirty. The types come
 * from the probe's own sample, and they are the half `fleetwalk`'s grouping
 * cannot have: a `record` refusal that only ever appears with
 * `entry:call-argument via:trigger` in the packet is a defect in how the
 * pipeline drives callbacks, and the same refusal spread evenly across every
 * type is a defect in `record`. The two need different fixes and they read
 * identically without this column.
 *
 * Sorted by repo count, because a shape carried by eleven repos is one fix worth
 * making before breakfast and a shape carried by one is that repo's own problem.
 * The completed group is included rather than filtered out, so the counts add up
 * to the fleet.
 */
export function killShapes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const k = row.kill ?? killPoint(row);
    const where = k.step ? `${k.stage}/${k.step}` : k.stage;
    const key = `${where}: ${reasonShape(k.reason)}`;
    if (!groups.has(key)) {
      groups.set(key, { shape: key, stage: k.stage, step: k.step ?? null, completed: k.stage === "done", repos: [], types: new Map(), example: null });
    }
    const g = groups.get(key);
    g.repos.push(row.name);
    for (const t of row.probe?.typesInProbe ?? []) g.types.set(t, (g.types.get(t) ?? 0) + 1);
    // The FIRST unnormalised reason, kept whole: the key has had its paths and
    // numbers taken out and somebody has to see one real instance of it without
    // opening the JSON.
    if (!g.example) g.example = k.reason;
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      count: g.repos.length,
      // Most-carried type first, so the column reads as "this shape shows up
      // with these types" rather than as an unordered set.
      types: [...g.types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, repos]) => ({ type, repos })),
    }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));
}

/**
 * One repo's row, assembled from the parts each stage produced. Pure and
 * separate from the stages that produce them, so the shape can be tested without
 * cloning anything. The row IS the artifact: a field missing from it is a repo
 * nobody can plan for.
 */
export function buildRow({
  name,
  branch,
  style,
  sha = null,
  classified = {},
  probe = {},
  clone = {},
  deps = {},
  toolset = {},
  rounds = [],
  steps = [],
  result = null,
  handover = null,
  completed = false,
  bounds,
  ms = 0,
}) {
  const row = {
    name,
    branch,
    style,
    sha: sha ? String(sha).slice(0, 8) : null,
    classified: { ok: classified.ok ?? false, ...(classified.reason ? { reason: classified.reason } : {}) },
    probe,
    clone: { ok: clone.ok ?? false, seconds: Math.round((clone.ms ?? 0) / 1000), ...(clone.note ? { note: clone.note } : {}), ...(clone.reason ? { reason: clone.reason } : {}) },
    deps: { ok: deps.ok ?? false, mode: deps.mode ?? null, seconds: Math.round((deps.ms ?? 0) / 1000), ...(deps.reason ? { reason: deps.reason } : {}) },
    toolset: { ok: toolset.ok ?? false, seconds: Math.round((toolset.ms ?? 0) / 1000), ...(toolset.reason ? { reason: toolset.reason } : {}) },
    rounds,
    // EVERY STAGE OF THE FLOW, one row each, merged across rounds with the last
    // word winning — a step that refused in round 1 and ran in round 2 is a step
    // that ran, and the round history above still holds both.
    steps,
    // Null is a real answer and not a missing field: it means the walk never
    // wrote a result document, which the kill point explains.
    result,
    handover,
    completed,
    // The money, and what it does and does not include: agent turns only. The
    // clone, the two installs and every walk are `node` and `npm` and cost
    // nothing but time.
    usd: Number(rounds.reduce((n, r) => n + (r.agent?.usd ?? 0), 0).toFixed(4)),
    turns: rounds.reduce((n, r) => n + (r.agent?.turns ?? 0), 0),
    // The bounds are in the row because a `timed-out` without them is
    // uninterpretable: 45 minutes and 45 hours are different findings.
    bounds,
    minutes: Number((ms / 60_000).toFixed(1)),
    generatedAt: new Date().toISOString(),
  };
  row.kill = killPoint(row);
  row.reason = rowReason(row);
  return row;
}

/** The one sentence that says where this repo stopped, or that it did not. */
function rowReason(row) {
  const k = row.kill;
  if (k.stage === "done") {
    return `the full flow ran: ${row.probe.functions ?? 0} function(s), ${row.rounds.length} round(s), $${row.usd.toFixed(2)}`;
  }
  const where = k.step ? `${k.stage}/${k.step}` : k.stage;
  return `stopped at ${where}: ${k.reason}`;
}

/* ------------------------------------------------------------------ the table */

export function renderTable(rows) {
  const head = ["repo", "types", "smpl", "fns", "sides", "furthest", "rounds", "$", "min", "stopped on"];
  const body = rows.map((r) => [
    r.name,
    String(r.probe?.strata ?? "—"),
    String(r.probe?.strataSampled ?? "—"),
    String(r.probe?.functions ?? "—"),
    String(r.probe?.sidesInProbe ?? "—"),
    r.kill?.step ? `${r.kill.stage}/${r.kill.step}` : (r.kill?.stage ?? "—"),
    String(r.rounds?.length ?? 0),
    (r.usd ?? 0).toFixed(2),
    String(r.minutes ?? 0),
    String(r.kill?.reason ?? "").slice(0, 60),
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 0 || i >= 5 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/** The single line printed per repo as the sweep goes, so a dead run is readable. */
export function progressLine(row) {
  return (
    `${row.name.padEnd(28)}` +
    `${String(row.probe?.functions ?? 0).padStart(3)} fn / ` +
    `${String(row.probe?.strataSampled ?? 0).padStart(3)} of ${String(row.probe?.strata ?? 0).padEnd(3)} shape(s) · ` +
    `${String(row.probe?.sidesInProbe ?? 0).padStart(4)} side(s) · ` +
    `${(row.kill?.step ? `${row.kill.stage}/${row.kill.step}` : (row.kill?.stage ?? "—")).padEnd(18)} · ` +
    `${row.rounds?.length ?? 0} round(s) · $${(row.usd ?? 0).toFixed(2)} · ${row.minutes} min`
  );
}

/* ------------------------------------------------------------------ the steps */

function step(fn) {
  const t = Date.now();
  try {
    const r = fn();
    return { ok: true, ms: Date.now() - t, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, reason: decisiveLine(String(e?.message ?? e)) };
  }
}

/*
 * THE NEXT THREE ARE THE THIRD COPY IN THIS DIRECTORY, and that is said out loud
 * rather than hidden. `fleetbaseline` and `fleetwalk` each clone at the deployed
 * branch and install the repo's real dependencies, and neither exports the
 * function that does it — fleetbaseline because it was written before there was
 * a second caller, fleetwalk because it is another agent's file this pass. The
 * alternative to copying was to edit one of them to export, which is a change to
 * a tool that is RUNNING over 32 repos right now. So these are copies, they are
 * small, and the moment either of those tools exports its own, these should be
 * deleted and that one imported.
 */

/** Clone at the deployed branch, with the same rule: a clone on the wrong branch is moved. */
function clone(name, branch, dir) {
  if (existsSync(join(dir, ".git"))) {
    const on = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir }).stdout?.trim();
    if (on === branch) return { note: "cached" };
    const f = run("git", ["fetch", "--depth", "1", "origin", `${branch}:refs/remotes/origin/${branch}`], { cwd: dir });
    if (f.status !== 0) throw new Error(`fetch ${branch} failed: ${(f.stderr || "").trim().slice(0, 200)}`);
    const c = run("git", ["checkout", "-B", branch, `refs/remotes/origin/${branch}`], { cwd: dir });
    if (c.status !== 0) throw new Error(`checkout ${branch} failed: ${(c.stderr || "").trim().slice(0, 200)}`);
    return { note: `switched ${on} -> ${branch}` };
  }
  rmSync(dir, { recursive: true, force: true });
  const r = run("git", ["clone", "--depth", "1", "--branch", branch, `${ORG}/${name}.git`, dir]);
  if (r.status !== 0) throw new Error(`clone failed: ${(r.stderr || "").trim().slice(0, 200)}`);
  return { note: "cloned" };
}

/**
 * The repo's REAL dependencies. `npm ci` first because it is what CI does and
 * the only mode that reproduces the lockfile exactly; several services carry a
 * lockfile a branch older than their manifest, so the fallback is `npm install`,
 * RECORDED as such — a suite run against resolved-today dependencies is a
 * slightly different program from the one CI runs.
 */
function install(dir, bounds) {
  const opts = { cwd: dir, timeout: bounds.installMinutes * 60_000 };
  const ci = run("npm", ["ci", "--no-audit", "--no-fund"], opts);
  if (ci.status === 0) return { mode: "npm ci" };
  if (ci.error?.code === "ETIMEDOUT") throw new Error(`npm ci hit the ${bounds.installMinutes} min bound`);
  const first = decisiveLine(ci.stderr || ci.stdout || "");
  const fallback = run("npm", ["install", "--no-audit", "--no-fund"], opts);
  if (fallback.status === 0) return { mode: "npm install", note: `npm ci refused: ${first}` };
  if (fallback.error?.code === "ETIMEDOUT") throw new Error(`npm install hit the ${bounds.installMinutes} min bound`);
  throw new Error(decisiveLine(fallback.stderr || fallback.stdout || first));
}

/**
 * `install.sh`, which copies the toolset in, adds four packages at the host's
 * EXACT vitest version and symlinks the skills the agent is told to load.
 *
 * Its refusals are findings and not errors: "vitest is not installed in <repo>"
 * is the whole diagnosis for half this fleet, whose deployed branch pins no
 * runner. `refusalLine` is used rather than `decisiveLine` because install.sh
 * writes `✗ <reason>` on purpose and that sentence is the answer.
 */
function toolset(dir, bounds) {
  const r = run("bash", [join(PILOT_DIR, "install.sh"), dir, REPO_ROOT_SELF], { timeout: bounds.toolsetMinutes * 60_000 });
  if (r.error?.code === "ETIMEDOUT") throw new Error(`install.sh hit the ${bounds.toolsetMinutes} min bound`);
  if (r.status !== 0) throw new Error(refusalLine(r.stderr || r.stdout || ""));
  return {};
}

/**
 * The environment a probe runs under: `fleetwalk`'s clean slate plus the
 * selector.
 *
 * `walkEnv` is imported rather than rebuilt, and what it does is the important
 * part: it drops EVERY `CHARPILOT_*` variable the operator's shell happens to
 * hold — there are 37 in this toolset and three of them change what stage 1
 * decides — and sets exactly `CHARPILOT_MODE=mocked`, `CHARPILOT_IAC` and
 * `CHARPILOT_SERVICE`. A row that says "the environment could not be resolved"
 * is worth nothing if the next machine's shell would have resolved it.
 *
 * `CHARPILOT_EXPECTED_DB` stays absent for fleetwalk's reason exactly: staging is
 * not routable from this host, so naming a database would be asking each stage a
 * question this machine cannot answer honestly.
 */
export function probeEnv({ service, iac = IAC, probeFile, base = process.env }) {
  return {
    ...walkEnv({ service, iac, base }),
    CHARPILOT_PROBE_FUNCTIONS: probeFile,
    // The two CLI settings `entrypoint.py` and `localrun.py` both set, taken
    // rather than left to whatever this shell holds, and each for a measured
    // reason. 0 waits indefinitely for background subagents — the default
    // ceiling of 600000 ms killed four of them mid-write and produced a run with
    // no result. Eight is the measured concurrency ceiling (20 concurrent probes
    // peak at 8), and `workflow.mjs` reads the same variable as the cap on the
    // worker count it derives, so the handover can never ask for more than the
    // runtime allows — twelve asked for nine and lost the ninth's packets.
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: base.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS ?? "0",
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: base.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS ?? "8",
  };
}

/**
 * One walk, bounded, with the arrival time of every line it printed.
 *
 * `spawn` and not `spawnSync`, because per-step wall time is recoverable only
 * from when each line ARRIVED: `workflow.mjs` prints no timestamps and every
 * line a step produces is emitted after that step has finished, so the clock
 * between one step's last line and the next step's last line is that next step's
 * run. `parseWalk` does that arithmetic; this only has to timestamp the pipe.
 */
function walkOnce(dir, env, bounds) {
  return new Promise((done) => {
    const started = Date.now();
    const events = [];
    const chunks = { out: "", err: "" };
    let timedOut = false;
    const child = spawn(process.execPath, [join(dir, ".claude", "charpilot", "workflow.mjs"), dir], {
      cwd: dir,
      env: { ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      // ITS OWN PROCESS GROUP, so one `kill(-pid)` reaches what the walk
      // spawned. The walk runs the repo's whole suite under vitest and ts-morph
      // over its whole source; a SIGTERM to the leader alone leaves those
      // holding the pipe, and the bound then does not bound anything.
      detached: true,
    });
    let pending = "";
    const take = (buf) => {
      chunks.out += buf;
      pending += buf;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const text of lines) events.push({ text, ms: Date.now() });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", take);
    child.stderr.on("data", (b) => {
      chunks.err += b;
      take(b);
    });
    const killer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, bounds.walkMinutes * 60_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      if (pending.trim()) events.push({ text: pending, ms: Date.now() });
      done({
        exitCode: timedOut ? null : code,
        timedOut,
        seconds: Math.round((Date.now() - started) / 1000),
        events,
        stdout: chunks.out,
        stderr: chunks.err,
        startedMs: started,
      });
    });
    child.on("error", (e) => {
      clearTimeout(killer);
      done({ exitCode: null, timedOut: false, seconds: 0, events, stdout: "", stderr: String(e.message ?? e), startedMs: started, spawnError: true });
    });
  });
}

/**
 * One agent turn, spawned the way `char/agent.py` spawns it.
 *
 * Same flags, same permission file, same turn ceiling. `--settings` is what
 * imposes the container's allowlist without relocating CLAUDE_CONFIG_DIR, which
 * on a laptop loses the login outright: without an allowlist `--print` has no
 * approver, `acceptEdits` covers edits only, every Bash call is refused, and the
 * turn ENDS REPORTING SUCCESS having done nothing. A missing settings file is
 * therefore a refusal and never a shrug.
 *
 * stdin is the prompt FILE, not a pipe: `--add-dir` is variadic, so a positional
 * prompt is read as one more directory, and a pipe adds a deadlock class.
 */
function agentTurn(dir, promptPath, bounds, env) {
  if (!existsSync(SETTINGS)) {
    throw new Error(
      `${SETTINGS} is missing, and it is the agent's permission allowlist. Without it every Bash call the ` +
        `agent makes is refused with no approver present, and the turn ends reporting success having done nothing.`
    );
  }
  const fd = openSync(promptPath, "r");
  try {
    const r = spawnSync(
      "claude",
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--settings",
        SETTINGS,
        "--max-turns",
        String(MAX_TURNS),
        "--add-dir",
        dir,
      ],
      {
        cwd: dir,
        env: { ...env, NO_COLOR: "1" },
        stdio: [fd, "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: bounds.turnMinutes * 60_000,
      }
    );
    const timedOut = r.error?.code === "ETIMEDOUT";
    const out = agentOutcome({ stdout: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, status: r.status, timedOut });
    if (out.state === "timed-out") out.reason = `the turn hit the ${bounds.turnMinutes} min bound`;
    return out;
  } finally {
    closeSync(fd);
  }
}

/**
 * The prompt this round gets, rendered from the pack's own template.
 *
 * WHICH TEMPLATE IS A FACT ON DISK, not a guess about the round number. The walk
 * writes the step that asked into `worklist-decisions.json`, and `packs/nodejs.py`
 * chooses the template from that field for a measured reason: when it read
 * `round_no == 1`, round 2 of run 20260916T024808Z was handed the RESUME prompt
 * against an empty disk. An unknown step gets the deriving prompt, which says to
 * answer the items and nothing else — the same instruction applied to items it
 * has not seen — because refusing here would turn a new step into a dead run.
 *
 * The substitutions are `char/prompts.py`'s, applied here rather than
 * shelling out to it: a rendered prompt is a string replace, and importing
 * Python to do one would make every probe depend on the container's package
 * layout resolving from a node process.
 */
/** `char/prompts.py`'s CHECKROW_EXCEPTION, the same sentence, behind the same flag (plan 20 T2.4). */
export const CHECKROW_EXCEPTION =
  " The one exception is `.claude/charpilot/checkrow.mjs`: a worker may run it on a row it has " +
  "written, to see the boundary's verdict on that row before submitting. It checks and advances " +
  "nothing, so a worker using it is following the brief, not breaking this rule.";

const PROMPT_FOR_STEP = { derive: "worklist-prompt-derive.md", repair: "worklist-prompt-repair.md" };

export function renderPrompt({ template, body, target, skill }) {
  return body
    .replaceAll("{{LANGUAGE}}", "nodejs")
    .replaceAll("{{TARGET}}", target)
    .replaceAll("{{RESULT}}", join(target, ".claude", "charpilot", "out", "result.json"))
    .replaceAll("{{WORKLIST}}", join(target, ".claude", "charpilot", "out", "worklist-decisions.json"))
    .replaceAll("{{SKILL}}", skill)
    .replaceAll("{{CHECKROW_EXCEPTION}}", process.env.CHARPILOT_INROUND_VERIFY !== "off" ? CHECKROW_EXCEPTION : "")
    .concat(`\n<!-- rendered by fleetprobe from ${template} -->\n`);
}

/** The skill name out of the pack's own frontmatter, so the prompt names one that exists. */
function skillName() {
  const md = join(PILOT_DIR, "..", "skill", "charpilot", "SKILL.md");
  if (!existsSync(md)) throw new Error(`the nodejs pack has no SKILL.md at ${md}, so the prompt cannot name a procedure`);
  const m = readFileSync(md, "utf8").match(/^name:[ \t]*(\S+)/m);
  if (!m) throw new Error(`${md} has no \`name:\` in its frontmatter, so the prompt cannot name it`);
  return m[1];
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * What the walk's result document says, which is the answer to "did anything
 * land". `partial` is a status the walk writes deliberately: it means the run
 * measured something and did not finish, and `docker/finish.py` reads it as a
 * FAILED run carrying real numbers. Reported as such rather than folded into a
 * boolean.
 */
export function resultFacts(doc) {
  if (!doc || typeof doc !== "object") return { written: false };
  return {
    written: true,
    status: doc.status ?? null,
    partial: doc.status === "partial",
    step: doc.partial?.step ?? null,
    exit: doc.partial?.exit ?? null,
    reason: doc.failed_reason ? decisiveLine(doc.failed_reason, 200) : null,
    coverage: doc.coverage_percentage ?? null,
  };
}

/** What the handover on disk holds, read from the clone and not from the walk's line about it. */
export function handoverFacts(doc) {
  if (!doc || typeof doc !== "object") return { written: false, items: 0, packets: 0 };
  const h = doc.handover ?? {};
  return {
    written: true,
    step: typeof doc.step === "string" ? doc.step : null,
    items: Number.isInteger(h.items) ? h.items : 0,
    packets: Number.isInteger(h.packets) ? h.packets : (doc.packets?.length ?? 0),
    open: Number.isInteger(h.progress?.open) ? h.progress.open : null,
  };
}

/** The per-step outcomes of every round, merged with the last word winning. */
export function mergeSteps(rounds, order = ORDER) {
  const byName = new Map();
  for (const r of rounds) for (const s of r.walk?.steps ?? []) byName.set(s.step, { ...s, round: r.round });
  return order.filter((n) => byName.has(n)).map((n) => byName.get(n));
}

/* -------------------------------------------------------------------- the run */

async function probeRepo(name, branch, style, bounds, opts) {
  const t0 = Date.now();
  const dir = join(WORK, name);
  const parts = { name, branch, style, bounds };
  const { measureArms, hitIndexFrom, boundaryClass, repoRoot } = await join_();

  /* 1 — CLASSIFY AND SAMPLE, from the cache, before anything is cloned. */
  const scanPath = join(CACHE, name, "scan.json");
  if (!existsSync(scanPath)) {
    return buildRow({
      ...parts,
      classified: { ok: false, reason: `no scan.json in ${join(CACHE, name)} — run \`node tools/fleetcheck.mjs\` first` },
      probe: { functions: 0 },
      ms: Date.now() - t0,
    });
  }
  const scan = readJson(scanPath);
  // The suite's own coverage when fleetbaseline has measured it, fleetcheck's
  // denominator otherwise — and WHICH, in the row. They answer different
  // questions and the second reads every side as uncovered.
  const suite = join(CACHE, name, "coverage-suite.json");
  const final = join(CACHE, name, "coverage-final.json");
  const covPath = existsSync(suite) ? suite : existsSync(final) ? final : null;
  const coverage = absoluteKeys(covPath ? readJson(covPath) : null, repoRoot);
  const rows = classify(scan, uncoveredByFunction(scan, coverage, { measureArms, hitIndexFrom }), boundaryClass);
  const picked = sample(rows, { perType: opts.perType, cap: opts.cap });
  const probe = {
    functions: picked.chosen.length,
    ids: picked.chosen.map((c) => c.id),
    types: picked.types,
    strata: picked.strata,
    strataSampled: picked.strataSampled,
    withOpenSides: picked.withOpenSides,
    sidesInProbe: picked.sidesInProbe,
    typesInProbe: [...new Set(picked.chosen.map((c) => c.type))].sort(),
    perType: opts.perType,
    cap: opts.cap,
    // Named, because a sample taken against fleetcheck's all-zero denominator is
    // a sample against a ceiling and a reader must not mistake it for one taken
    // against what the suite leaves open.
    coverageSource: covPath ? (covPath === suite ? "coverage-suite.json (the repo's own suite, measured by fleetbaseline)" : "coverage-final.json (fleetcheck's denominator — every hit count is zero, so every side reads as uncovered)") : "none on disk — every function reads as having no measurable sides",
    functionsInRepo: rows.length,
  };
  if (!picked.chosen.length) {
    return buildRow({
      ...parts,
      classified: { ok: false, reason: `${rows.length} function(s) in the scan and none could be sampled — the repo has no classifiable function` },
      probe,
      ms: Date.now() - t0,
    });
  }
  if (opts.plan) {
    // `--plan` writes the probe file where it can be read and stops. No clone,
    // no install, no agent, no money — the selection is the half worth checking
    // before any of it is spent.
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "probe-functions.txt");
    writeFileSync(path, probeFileBody(name, picked.chosen, picked));
    const row = buildRow({ ...parts, classified: { ok: true }, probe: { ...probe, file: path }, ms: Date.now() - t0 });
    row.kill = { stage: "plan", step: null, reason: `--plan: ${picked.chosen.length} function(s) selected, nothing was run` };
    row.reason = row.kill.reason;
    return row;
  }

  /* 2 — CLONE, INSTALL, TOOLSET. */
  const cl = step(() => clone(name, branch, dir));
  if (!cl.ok) return buildRow({ ...parts, classified: { ok: true }, probe, clone: cl, ms: Date.now() - t0 });
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout?.trim() ?? null;
  const common = { ...parts, classified: { ok: true }, probe, clone: cl, sha };

  const deps = step(() => install(dir, bounds));
  if (!deps.ok) return buildRow({ ...common, deps, ms: Date.now() - t0 });

  const tool = step(() => toolset(dir, bounds));
  if (!tool.ok) return buildRow({ ...common, deps, toolset: tool, ms: Date.now() - t0 });

  /* 3 — THE PROBE FILE, written into the clone where the walk will read it. */
  const probeFile = join(dir, ".claude", "charpilot", "probe-functions.txt");
  mkdirSync(dirname(probeFile), { recursive: true });
  writeFileSync(probeFile, probeFileBody(name, picked.chosen, picked));
  probe.file = probeFile;

  /* 4 — WALK, ANSWER, WALK AGAIN, until every step is satisfied or a round
   *     produces nothing. The loop is `packs/nodejs.py`'s, and the exit
   *     condition is the ARTIFACT rather than the agent's opinion of whether it
   *     is done. */
  const env = probeEnv({ service: name, iac: opts.iac, probeFile });
  for (const key of opts.drop ?? []) delete env[key];
  const rounds = [];
  let completed = false;
  const skill = skillName();
  for (let n = 1; n <= bounds.rounds; n++) {
    if (Date.now() - t0 > bounds.repoMinutes * 60_000) {
      rounds.push({ round: n, walk: { exitCode: null, refusal: `this repo hit the ${bounds.repoMinutes} min bound before round ${n}`, step: null, steps: [], seconds: 0 }, agent: null });
      break;
    }
    const w = await walkOnce(dir, env, bounds);
    const steps = parseWalk(w.events, { order: ORDER, startedMs: w.startedMs });
    const refusal = w.timedOut
      ? `the walk hit the ${bounds.walkMinutes} min bound — slow or stuck, this round cannot tell which`
      : refusalLine(w.stderr || w.stdout || "");
    // Attribution: the step the walk itself named. Every refusal workflow.mjs
    // returns is prefixed with the step's label, and the handover names the step
    // that asked, so neither is guessed.
    const decisions = readJson(join(dir, ".claude", "charpilot", "out", "worklist-decisions.json"));
    const asked = decisions?.step ?? null;
    const lastRan = steps[steps.length - 1]?.step ?? null;
    const hand = handoverFacts(decisions);
    const walkRow = {
      exitCode: w.exitCode,
      timedOut: w.timedOut,
      seconds: w.seconds,
      steps,
      step: asked ?? lastRan,
      handover: hand,
      // EXIT 75 IS NOT A REFUSAL and must not be described by one. It is the
      // walk reaching the point where an agent earns its money, and running
      // `refusalLine` over that stdout picks whichever substring happens to look
      // like an error out of a healthy round. The sentence is written here
      // instead, from the handover the walk actually left on disk.
      refusal:
        w.exitCode === 0
          ? null
          : w.exitCode === 75
            ? `exit 75 at \`${asked ?? lastRan}\` holding ${hand.items} item(s) in ${hand.packets} packet(s)`
            : refusal,
    };
    if (w.exitCode === 0) {
      rounds.push({ round: n, walk: walkRow, agent: null });
      completed = true;
      break;
    }
    if (w.exitCode !== 75) {
      // Anything but 0 or 75 is a real failure the walk has already named on
      // stderr. There is nothing for an agent to answer, so no turn is bought.
      rounds.push({ round: n, walk: walkRow, agent: null });
      break;
    }
    if (!decisions) {
      walkRow.refusal = `the walk exited 75 without writing worklist-decisions.json, so there is nothing to hand over`;
      rounds.push({ round: n, walk: walkRow, agent: null });
      break;
    }
    const template = PROMPT_FOR_STEP[asked] ?? PROMPT_FOR_STEP.derive;
    const rendered = join(dir, `.fleetprobe-${template}`);
    writeFileSync(rendered, renderPrompt({ template, body: readFileSync(join(PROMPTS, template), "utf8"), target: dir, skill }));
    let agent;
    try {
      agent = agentTurn(dir, rendered, bounds, env);
    } catch (e) {
      agent = { state: "failed", exitCode: null, turns: null, usd: null, reason: decisiveLine(String(e?.message ?? e)) };
    }
    rounds.push({ round: n, walk: walkRow, agent });
    // A turn that failed, timed out or did nothing ends the loop. Re-prompting
    // is the right answer to "the agent stopped early" and the wrong answer to
    // "the agent never ran": eight rounds against a gateway returning 503 cost
    // twenty-five minutes and zero work on run 20260914T192024Z. A probe has no
    // budget to spin.
    if (agent.state !== "answered") break;
  }

  const result = resultFacts(readJson(join(dir, ".claude", "charpilot", "out", "result.json")));
  const handover = handoverFacts(readJson(join(dir, ".claude", "charpilot", "out", "worklist-decisions.json")));
  return buildRow({ ...common, deps, toolset: tool, rounds, steps: mergeSteps(rounds), result, handover, completed, ms: Date.now() - t0 });
}

/**
 * Whether there is anything to run the agent with, answered BEFORE the first
 * clone.
 *
 * `docker/localrun.py`'s rule exactly, and its refusals nearly word for word.
 * The alternative is the failure this whole tool exists to avoid: a sweep that
 * walks 32 repos with no answering turn, records "the walk exited 75" for every
 * one of them, and reports a credentials problem as thirty-two repo failures.
 */
export function agentCredentials(env = process.env) {
  if (env.CHARPILOT_LOCAL_LOGIN === "1") {
    // The pin is KEPT. Dropping it here as well is what this used to do, and
    // it is how every local run landed on the CLI default of claude-opus-5[1m]
    // while all four local env files pinned claude-sonnet-5 — 2.5x the price
    // per token, unremarked, until an account ran out mid-round.
    if (!env.ANTHROPIC_MODEL) {
      return {
        ok: false,
        reason:
          "ANTHROPIC_MODEL is unset and CHARPILOT_LOCAL_LOGIN=1, so the CLI would pick its own default — which " +
          "is how a local run lands on Opus while the env file asks for Sonnet. Pin it (the container pins " +
          "claude-sonnet-5).",
      };
    }
    return {
      ok: true,
      mode: `${env.ANTHROPIC_MODEL} via this machine's own claude login`,
      // Said at the top of the sweep and again in the document, because the
      // cost lands somewhere else: on the account this machine is logged in as,
      // rather than on the gateway's.
      warning:
        `CHARPILOT_LOCAL_LOGIN=1 — using this machine's own claude login on ${env.ANTHROPIC_MODEL}. The ` +
        "gateway and the key are dropped and the model pin is kept, so turns are comparable with a container run " +
        "on the same model, but the dollar figures land on this machine's account.",
      // DROPPED BY NAME, not by spreading `undefined` over them: an env object
      // is stringified on the way to the child, and a key present with no value
      // is not the same thing as a key that is not there.
      drop: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_API_KEY is unset or empty, so there is nothing to run the agent with. Set it (with " +
        "ANTHROPIC_BASE_URL and ANTHROPIC_MODEL, as docker/run.env does), or set CHARPILOT_LOCAL_LOGIN=1 to use " +
        "this machine's own claude login — which still needs ANTHROPIC_MODEL and moves the cost to this " +
        "machine's account. " +
        "Nothing is probed without one of the two: a sweep with no answering turn records 32 walk refusals and " +
        "calls a credentials problem a fleet of broken repos.",
    };
  }
  if (!env.ANTHROPIC_MODEL) {
    return {
      ok: false,
      reason:
        "ANTHROPIC_MODEL is unset, so every probe would run on whatever the gateway defaults to and every number " +
        "it produces would be uncomparable. Pin it (the container pins claude-sonnet-5), or set " +
        "CHARPILOT_LOCAL_LOGIN=1.",
    };
  }
  return { ok: true, mode: `${env.ANTHROPIC_MODEL} via ${env.ANTHROPIC_BASE_URL ?? "the default endpoint"}`, drop: [] };
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  mkdirSync(CACHE, { recursive: true });

  const only = arg("--only", "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = arg("--from", "");
  const force = flag("--force");
  const plan = flag("--plan");
  const bounds = {
    installMinutes: INSTALL_MINUTES,
    toolsetMinutes: TOOLSET_MINUTES,
    walkMinutes: WALK_MINUTES,
    turnMinutes: TURN_MINUTES,
    repoMinutes: REPO_MINUTES,
    rounds: ROUNDS,
    maxTurns: MAX_TURNS,
  };

  let fleet = fleetFromDisk();
  if (only.length) fleet = fleet.filter((r) => only.includes(r.name));
  if (from) {
    const i = fleet.findIndex((r) => r.name === from);
    if (i >= 0) fleet = fleet.slice(i);
  }
  if (!fleet.length) {
    process.stderr.write("no repo matched. `--only` takes names from fleetcheck.mjs's FLEET array.\n");
    process.exit(1);
  }

  // THE CREDENTIALS, BEFORE THE FIRST CLONE. A sweep that discovers this at repo
  // 1 has already spent an install on it; a sweep that never discovers it at all
  // reports 32 walk refusals and blames the repos.
  const creds = plan ? { ok: true, mode: "--plan: no agent is run", drop: [] } : agentCredentials();
  if (!creds.ok) {
    process.stderr.write(`fleetprobe: ${creds.reason}\n`);
    process.exit(2);
  }
  if (creds.warning) log(`! ${creds.warning}\n`);

  log(
    `fleetprobe: ${fleet.length} repo(s), up to ${PER_TYPE} function(s) per shape capped at ${MAX_FUNCTIONS}, ` +
      `${ROUNDS} round(s) each, agent: ${creds.mode}.\n` +
      `Bounded at ${bounds.installMinutes} min install, ${bounds.toolsetMinutes} min toolset, ` +
      `${bounds.walkMinutes} min walk, ${bounds.turnMinutes} min turn, ${bounds.repoMinutes} min per repo.\n` +
      `Mode mocked, IAC ${IAC}. Cache → ${CACHE}\n`
  );

  const opts = { perType: PER_TYPE, cap: MAX_FUNCTIONS, plan, iac: IAC, drop: creds.drop ?? [] };
  const rows = [];
  for (const { name, branch: declared, style } of fleet) {
    const branch = BRANCH_OVERRIDE || declared;
    const cachedPath = join(CACHE, name, "probe.json");
    const cached = existsSync(cachedPath) ? readJson(cachedPath) : null;
    // `--plan` never consults the cache and never writes it: it runs nothing, so
    // it can have nothing to resume, and a plan row written into probe.json
    // would make the next real sweep skip the repo it never probed.
    const decision = plan ? { skip: false } : resumeDecision({ cached, force });
    if (decision.skip) {
      log(`${progressLine(cached)}   [cached]`);
      rows.push(cached);
      continue;
    }

    const row = await probeRepo(name, branch, style, bounds, opts);
    log(progressLine(row));
    // The reason on its own line under the repo, because the table has no column
    // wide enough for a sentence and the sentence is the finding.
    log(`  ↳ ${row.reason}`);
    rows.push(row);

    if (!plan) {
      mkdirSync(join(CACHE, name), { recursive: true });
      writeFileSync(join(CACHE, name, "probe.json"), `${JSON.stringify(row, null, 2)}\n`);
    }

    // Self-cleaning, and not optional: fleetcheck measured a full `npm ci` of
    // this fleet at 20–33 GB, and two other sweeps are using their own work
    // trees at the same time. The ANSWER is cached, so `--keep` buys back only
    // the time to install again.
    if (!flag("--keep") && !plan) {
      const nm = join(WORK, name, "node_modules");
      if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) rmSync(nm, { recursive: true, force: true });
    }
  }

  log(`\n${renderTable(rows)}\n`);

  /* ------------------------------------------------------------ the grouping */

  const shapes = killShapes(rows);
  log("KILL SHAPES — how many repos stopped at the same stage for the same kind of reason, and which function");
  log("TYPE was in the packet when they did. One fix for eleven repos looks different here from one repo's own");
  log("problem, and that difference is the only thing on this page worth reading first.\n");
  for (const g of shapes) {
    log(`${String(g.count).padStart(3)} repo(s)  ${g.shape}`);
    log(`           ${g.repos.slice(0, 8).join(", ")}${g.repos.length > 8 ? ` …+${g.repos.length - 8}` : ""}`);
    if (g.types.length) {
      log(`           types in the packet: ${g.types.slice(0, 4).map((t) => `${t.type} (${t.repos})`).join(" · ")}${g.types.length > 4 ? ` …+${g.types.length - 4}` : ""}`);
    }
    if (g.example) log(`           e.g. ${String(g.example).slice(0, 150)}`);
    log("");
  }

  const done = rows.filter((r) => r.kill?.stage === "done");
  const spent = rows.reduce((n, r) => n + (r.usd ?? 0), 0);
  const minutes = rows.reduce((n, r) => n + (r.minutes ?? 0), 0);

  const doc = {
    generatedAt: new Date().toISOString(),
    cache: CACHE,
    work: WORK,
    bounds,
    selection: { perType: PER_TYPE, cap: MAX_FUNCTIONS },
    environment: { mode: "mocked", iac: IAC, agent: creds.mode, expectedDb: null },
    killShapes: shapes,
    repos: rows,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  // `--plan` writes BESIDE the real report and never over it. A plan document
  // carries no outcome for any repo, and a sweep's findings replaced by one
  // would read as a fleet that stopped nowhere.
  const path = join(OUT_DIR, plan ? "fleetprobe-plan.json" : "fleetprobe.json");
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

  log(
    `${done.length}/${rows.length} repo(s) ran the full flow · $${spent.toFixed(2)} of model spend · ` +
      `${minutes.toFixed(0)} min of wall time.\n` +
      `The dollars are AGENT TURNS ONLY — the clone, both installs and every walk are node and npm and cost nothing\n` +
      `but time. The side counts are the PROBE's, never the service's: each repo's denominator and reconcile still\n` +
      `ran over the whole service, which is what the selector is built to preserve. A repo that stopped early has\n` +
      `told you where it stops; it has NOT told you it would finish if that were fixed, because only the stages\n` +
      `before the stop were exercised.\n` +
      `\nwrote ${path}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    process.stderr.write(`fleetprobe: ${decisiveLine(String(e?.stack ?? e?.message ?? e))}\n`);
    process.exit(1);
  });
}
