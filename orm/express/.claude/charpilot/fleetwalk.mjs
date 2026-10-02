#!/usr/bin/env node
/**
 * fleetwalk — everything a container run does EXCEPT let an agent answer, on
 * every repo in the fleet, so the bug shape in each stage is known before a
 * single dollar of model budget is spent on it.
 *
 *   node tools/fleetwalk.mjs                 # every repo in the fleet list
 *   node tools/fleetwalk.mjs --only a,b      # just these
 *   node tools/fleetwalk.mjs --from pricing-ms
 *   node tools/fleetwalk.mjs --rounds 1      # how many walk passes (default 1)
 *   node tools/fleetwalk.mjs --keep          # leave the clone and node_modules
 *   node tools/fleetwalk.mjs --force         # walk a repo that is already cached
 *   node tools/fleetwalk.mjs --ready [--json] # the readiness report, off the cache alone
 *
 * WHY THIS EXISTS. Nobody knows the bug shape or the mismatch shape in any
 * stage of any repo until the pipeline has been run on it, and a
 * characterization run costs real money — $0.23/side measured on the one run
 * that finished, which is ~$809 for the nine-repo cover and ~$14,954 for the
 * whole fleet (fleetshapes, 2026-09-18). Running 32 of them to find out where
 * each one breaks is the most expensive possible way to learn it.
 *
 * But the money is in ONE HALF of a run: the agent answering handovers. The
 * other half — clone, install the repo's real dependencies, install the
 * charpilot toolset, walk the mechanical steps until one of them asks a
 * question — is free, and it is where most of today's defects have lived:
 * `install.sh` refusing a repo that runs `vitest run` with no config,
 * `handoff.mjs` dying on a fresh clone, `--service` not reaching the tools,
 * `vocabulary` re-probing what it had already written, a suite that is red
 * before charpilot touches it, an environment that cannot be resolved. Every
 * one of those is reproducible with no model call at all.
 *
 * SO THE SUCCESS CONDITION IS EXIT 75. `workflow.mjs` exits 75 when a step
 * needs a decision and has written the handover that asks for it; that is a
 * HEALTHY repo reaching the point where an agent would earn its money.
 * Anything else — exit 0 (nothing to decide, which on a repo with open sides
 * means a step is lying), exit 1 (a refusal), a timeout, a crash before the
 * walk starts — is the finding, and it is attributed to the STEP that produced
 * it, because a defect in `scan` on eleven repos is one fix and a defect in
 * `stagingenv` on one repo is that repo's own problem. That grouping is the
 * deliverable; the per-repo rows are the evidence for it.
 *
 * WHAT A ROW IS NOT. It is not a coverage number, not a cost estimate, and not
 * a prediction that a repo will finish: it says only how far the mechanical
 * half gets and what stopped it. A repo that reaches exit 75 may still fail in
 * stage 4 against a boundary nothing here dials — this host cannot reach
 * staging at all, which is why the whole sweep runs `CHARPILOT_MODE=mocked`.
 *
 * DISK, AND WHY THE LOOP IS SERIAL AND SELF-CLEANING. This installs each repo's
 * whole dependency tree AND the four packages `install.sh` adds (ts-morph, the
 * istanbul provider, two stryker packages). fleetcheck measured a full `npm ci`
 * of this fleet at 20–33 GB; `fleetbaseline` is running its own sweep in its own
 * work directory while this one runs, and there were 38 GB free when this was
 * written. So: install, walk, cache the ANSWER, delete node_modules, next.
 * `--keep` opts out for one repo you want to open by hand.
 *
 * ITS OWN WORK DIRECTORY, and this is not a preference. `out/fleet-work` holds
 * fleetcheck's PRISTINE clones — "which is what makes `--recheck` honest" — and
 * this tool writes `.claude/charpilot/` into every clone it touches, so pointing
 * it there would silently change what a recheck measures.
 * `out/fleet-baseline-work` belongs to fleetbaseline and is in use. This uses
 * `out/fleet-walk-work` and shares only the answer cache, `out/fleet/<name>/`.
 *
 * RESUMABLE AND IDEMPOTENT, exactly as fleetbaseline is, because this will run
 * unattended for hours: a repo whose `walk.json` is on disk is skipped and its
 * cached row is still printed, so a sweep that dies at repo 19 is worth
 * restarting rather than repeating. Re-running the identical command after a
 * crash is safe. `--force` walks a cached repo again.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NOT from config.mjs, for the reason fleetcheck and fleetbaseline are not:
// that module resolves ONE repo from the CWD and refuses a directory that is
// not a package root — right for a tool that measures a target, wrong for one
// that runs from the pilot and walks many. `nodejs/` is not a package root by
// its rule (no `src/`), so importing it here would refuse before the first line.
//
// `steps/index.mjs` IS safe to import and is imported rather than parsed: it
// declares ORDER and a lazy `loadStep`, and pulls in nothing at module load.
// The order is what this tool attributes findings to, and a second copy of it
// would drift the moment a step is inserted — which has already happened once
// (`determinism` went in between `record` and `emit` after a run died in the
// gap), and a copy would have quietly mis-attributed every row after it.
import { ORDER } from "./steps/index.mjs";
// The fleet list has ONE owner and it is `fleetcheck.mjs`; `parseFleet` reads
// the literal out of its source because fleetcheck calls `main()` at the bottom
// and importing it would clone and measure the whole fleet as a side effect of
// asking what is in it. That parser already exists in fleetbaseline, is
// exported, and runs nothing on import — so it is imported rather than copied.
// A copy costs the failure it was written to prevent: this tool walking a repo
// on `main` that the cache beside it was measured on at `production`.
import { decisiveLine, parseFleet } from "./fleetbaseline.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

const WORK = resolve(arg("--work", join(OUT_DIR, "fleet-walk-work")));
// The SAME per-repo cache directory fleetcheck and fleetbaseline write, under a
// name neither of them uses. One directory per repo holding everything anybody
// has measured about it beats three directories that have to be joined by name.
const CACHE = resolve(arg("--cache", join(OUT_DIR, "fleet")));
const ORG = "https://github.com/Qode-Platform";
const BRANCH_OVERRIDE = arg("--branch", "");
const ROUNDS = Math.max(1, Number(arg("--rounds", "1")));

/**
 * The qode-iac checkout stage 1 resolves the deployed environment from.
 *
 * PASSED ON PURPOSE, even though staging is unreachable from this host. The two
 * are different questions and conflating them is what this tool is for: "can
 * `stagingenv` find a ConfigMap named after this service" is answered from
 * files on disk and is answerable here; "can stage 4 dial the address it
 * found" is not, and is never attempted because the whole sweep is mocked. A
 * repo whose environment cannot be resolved is a FINDING recorded against
 * `stagingenv`, never a reason to skip the repo.
 */
const IAC = resolve(arg("--iac", "/Users/qode/Desktop/Repo/workspace/qode-knowledge/repos/qode-iac"));

/**
 * The three bounds, in minutes, and why a bound is not optional.
 *
 * This runs unattended over 32 repos, and any one of them waiting forever costs
 * every repo after it. All three are generous rather than tight, because a
 * timeout is a WRONG ANSWER — it says "we do not know" where a longer wait
 * would have said "exit 75" — and all three are recorded in the row so a reader
 * can tell a slow stage from a stuck one.
 *
 *   install   the repo's own `npm ci`. Minutes of network on the Nest services.
 *   toolset   `install.sh`, which adds four packages at the host's EXACT vitest
 *             version, so it is a second npm install and gets its own clock.
 *   walk      one pass of `workflow.mjs`. It runs the repo's whole suite under
 *             istanbul (`baseline`) and ts-morph over its whole source
 *             (`scan`), so it is the largest of the three by a wide margin.
 */
const INSTALL_MINUTES = Number(arg("--install-minutes", "30"));
const TOOLSET_MINUTES = Number(arg("--toolset-minutes", "20"));
const WALK_MINUTES = Number(arg("--walk-minutes", "45"));

const log = (s) => process.stdout.write(`${s}\n`);

/** Every child, with the two settings a long unattended sweep needs. */
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, {
    encoding: "utf8",
    // 64 MB and not node's 1 MB default: the default does not truncate, it
    // KILLS the child with ENOBUFS, which arrives here looking exactly like the
    // command failing. `scan.mjs` alone prints a per-file table over a whole
    // service. NO_COLOR keeps ANSI escapes out of the line we quote as the
    // reason.
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, NO_COLOR: "1", ...(opts.env ?? {}) },
  });

export function fleetFromDisk(pilotDir = PILOT_DIR) {
  return parseFleet(readFileSync(join(pilotDir, "fleetcheck.mjs"), "utf8"));
}

/* --------------------------------------------------------- the pure decisions */

/**
 * The environment the walk runs under, built from a CLEAN slate.
 *
 * EVERY `CHARPILOT_*` VARIABLE THE OPERATOR'S SHELL HAPPENS TO HOLD IS DROPPED,
 * and that is the whole point of building this by hand rather than spreading
 * `process.env`. There are 37 of them in this toolset; `CHARPILOT_EXPECTED_DB`,
 * `CHARPILOT_DB_ADDRESS` and `CHARPILOT_MODE` each change what stage 1 decides
 * and what stage 4 is allowed to dial. A row that says "the environment could
 * not be resolved" is worth nothing if the next machine's shell would have
 * resolved it, so the row's environment is exactly these four values and
 * nothing else.
 *
 * `CHARPILOT_EXPECTED_DB` IS DELIBERATELY ABSENT. The nodejs pack's own
 * preflight refuses a container run without it, and that refusal is right for a
 * run that may go live. Here there is no live to go to: staging is not routable
 * from this host, and setting a real database address would be asking each
 * stage a question this machine cannot answer honestly. What each stage REPORTS
 * about an unreachable boundary is the thing being measured.
 */
export function walkEnv({ service, iac = IAC, base = process.env } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith("CHARPILOT_")) env[k] = v;
  env.NO_COLOR = "1";
  // Not a preference: `liveDecision` reads it first and returns "every boundary
  // is answered by a double" without looking at anything else, which is the
  // only honest setting on a host with no route to staging.
  env.CHARPILOT_MODE = "mocked";
  env.CHARPILOT_IAC = iac;
  // The deploy name, which is what the FLEET entry's name IS, and what
  // `stagingenv.mjs` looks up the ConfigMap and Secret by. Passed as the
  // per-machine answer to `--service` because the walk's `stagingenv` step
  // spawns the tool with no arguments at all.
  env.CHARPILOT_SERVICE = service;
  return env;
}

/**
 * The shortest line that identifies a walk refusal, never a stack dump.
 *
 * DIFFERENT SOURCE, DIFFERENT PICK, which is why this is not `decisiveLine`.
 * That function is tuned for npm and vitest output — `npm error code E403` and
 * `ECONNREFUSED 127.0.0.1:5432` are the whole diagnosis there — and it is used
 * unchanged below for the clone and the two installs, which produce exactly
 * that output. The WALK does not: it prints its own refusals in its own format,
 * `✗ <step>: <reason>`, and the reason is prose that the step wrote on purpose.
 * Running `decisiveLine` over it picks whichever substring happens to look like
 * an error and throws away the sentence the step chose.
 *
 * Two things are stripped, and both are boilerplate rather than findings:
 *
 *   - `whereToLook()`, the "Which layer is at fault is not something this walk
 *     can tell…" paragraph, which workflow.mjs appends to EVERY "ran and is
 *     still not satisfied" refusal. It is identical on every such row, so
 *     keeping it would make three different defects read as one string.
 *   - anything past the first sentence, because the first sentence is the one
 *     that names the step and what it could not do.
 *
 * A reader who needs the rest has the clone (`--keep`) and the full output in
 * the row's own `output` tail.
 */
export function refusalLine(text, limit = 200) {
  const clean = String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trim();
  if (!clean) return "no output at all";
  // The walk's own refusal marker, and install.sh's. Both write `✗ <reason>` on
  // stderr and nothing else does, so this is decisive wherever it appears.
  const marked = clean.split("\n").find((l) => l.trimStart().startsWith("✗"));
  const line = marked ? marked.trim().replace(/^✗\s*/, "") : null;
  if (line) return firstSentence(line, limit);
  // A step that could not RUN says so on stdout rather than stderr, in the
  // walk's own words: `<step>: cannot run — <blocker>`.
  const blocked = clean.split("\n").find((l) => / cannot run — /.test(l));
  if (blocked) return firstSentence(blocked.trim(), limit);
  // Nothing in the walk's vocabulary matched, so this is a child that died
  // under it — an npm error, a module that would not load, a thrown stack — and
  // that is exactly what `decisiveLine` is for.
  return decisiveLine(clean, limit);
}

/**
 * The first sentence, ending at `. ` and never mid-word.
 *
 * `. ` and not `.`, because the reasons are full of `worklist.mjs`,
 * `record.mjs` and `0.23` and splitting on a bare full stop cuts every one of
 * them in half.
 */
function firstSentence(line, limit = 200) {
  const at = line.indexOf(". ");
  const cut = at > 0 ? line.slice(0, at + 1) : line;
  return cut.length > limit ? `${cut.slice(0, limit - 1)}…` : cut;
}

/**
 * What the walk said about each step, in the walk's OWN words.
 *
 * `events` are the child's lines with the moment each one ARRIVED HERE, which
 * is how per-step wall time is recovered at all: `workflow.mjs` prints no
 * timestamps and every line a step produces is emitted after that step has
 * finished running. So the clock between one step's last line and the next
 * step's last line is that next step's run, and it is measured at this
 * process's end of the pipe.
 *
 * WHAT THAT NUMBER INCLUDES AND DOES NOT. It includes the step's `satisfied`,
 * its `precondition`, its `run`, and the few milliseconds of pipe latency and
 * printing after it. It does NOT include anything before the walk's first line
 * — node's own startup and the import of config.mjs and ts-morph — which lands
 * in the first step's figure, nor anything after the last line, which is the
 * process exiting. It is a wall clock, not CPU: a step waiting on a socket and
 * a step computing look identical here, which is the correct reading for
 * "which stage is slow".
 *
 * The outcome vocabulary is TAKEN FROM THE WALK and not invented: `already
 * done`, `cannot run — …`, `N decision(s) needed`, `optional, and not
 * satisfied`, `deferring to …` are the five things workflow.mjs prints about a
 * step, and everything else it prints is a `did` line or a metric, which means
 * the step ran.
 */
export function parseWalk(events, { order = ORDER, startedMs = 0 } = {}) {
  const steps = [];
  const byName = new Map();
  // The last line seen from ANY step, which is where the next step's clock
  // starts. Tracked separately from the step being filled in because a step's
  // own second and third lines must not restart its clock — that reads a step
  // that took two minutes and printed three lines as three instant steps.
  let lastMs = startedMs;
  let current = null;

  const open = (name) => {
    let row = byName.get(name);
    if (!row) {
      row = { step: name, index: order.indexOf(name), outcome: "ran", lines: [], asked: [], seconds: 0, base: lastMs };
      byName.set(name, row);
      steps.push(row);
    }
    current = row;
    return row;
  };
  const mark = (row, ms) => {
    lastMs = ms;
    row.seconds = Number(((ms - row.base) / 1000).toFixed(1));
  };

  for (const ev of events) {
    const text = String(ev.text ?? "");
    // An item of the handover, indented and belonging to whichever step printed
    // the `N decision(s) needed` line above it.
    const item = text.match(/^\s+- \[([^\]]+)\]\s*(.*)$/);
    if (item && current) {
      current.asked.push({ kind: item[1], question: item[2].trim() });
      mark(current, ev.ms);
      continue;
    }
    // `<step>: <whatever it said>`. Matched against the known step names rather
    // than against `^(\w+):`, because a `did` line may contain a colon of its
    // own and a metric line certainly does.
    const named = order.find((name) => text.startsWith(`${name}: `));
    if (!named) continue;
    const said = text.slice(named.length + 2).trim();
    const row = open(named);
    row.lines.push(said);
    if (said === "already done") row.outcome = "satisfied";
    else if (said.startsWith("cannot run — ")) row.outcome = "refused";
    else if (/^\d+ decision\(s\) needed/.test(said)) row.outcome = "handover";
    else if (said.startsWith("optional, and not satisfied")) row.outcome = "optional-unsatisfied";
    else if (said.startsWith("deferring to ")) row.outcome = "deferred";
    mark(row, ev.ms);
  }
  // `base` is scaffolding for the arithmetic above and would read in the cached
  // row as a second, contradictory account of the timing. `seconds` is the
  // answer; the offset it was computed from is not.
  for (const row of steps) delete row.base;
  return steps;
}

/**
 * Which step the walk's own refusal belongs to.
 *
 * Every refusal `workflow.mjs` returns is prefixed with the step's label — it
 * builds them as `${label}: …` in all fourteen places — so the attribution is
 * read off the reason rather than guessed. The two that are not: a handover the
 * walk refuses to look at because its bytes changed, and "the walk itself
 * threw", both of which belong to no step and are attributed to `walk` itself
 * so they are never silently filed under whichever step happened to be last.
 */
export function refusalStep(reason, { order = ORDER } = {}) {
  const text = String(reason ?? "");
  const named = order.find((name) => text.startsWith(`${name}:`) || text.startsWith(`${name} ran (`));
  return named ?? null;
}

/**
 * What the handover on disk actually holds, read from the CLONE and not from
 * the walk's own line about it.
 *
 * The walk prints `N decision(s) needed`, and N is the item count it was
 * handed — but the file is what an agent would read, and the two have
 * disagreed before: the fan-out writes one file per PACKET and the index last,
 * so a walk killed between the two prints a number for a handover that is not
 * there. Reading the disk answers "could a round have been dealt from this",
 * which is the question.
 */
export function handoverFacts(doc) {
  if (!doc || typeof doc !== "object") return { written: false, items: 0, packets: 0 };
  const h = doc.handover ?? {};
  return {
    written: true,
    // Which step asked, which is what decides the prompt a real round would get
    // and is therefore part of the shape, not a detail.
    step: typeof doc.step === "string" ? doc.step : null,
    items: Number.isInteger(h.items) ? h.items : 0,
    packets: Number.isInteger(h.packets) ? h.packets : (doc.packets?.length ?? 0),
    bytes: Number.isInteger(h.bytesTotal) ? h.bytesTotal : null,
    workers: Number.isInteger(h.workers) ? h.workers : null,
    // How many sides are still open, as `openSides()` in steps/derive.mjs counts
    // them — NOT worklist.json's `uncoveredArms`, which is a different and
    // larger quantity (15,194 against 8,546 on qode-ptp-ms).
    open: Number.isInteger(h.progress?.open) ? h.progress.open : null,
    // Only ever non-zero on `--rounds 2` or more, where with no agent answering
    // it is the EXPECTED result and not a defect: the same questions, because
    // nothing answered the last ones.
    repeated: Number.isInteger(h.repeated) ? h.repeated : 0,
  };
}

/**
 * One repo's row, assembled from the parts each stage produced.
 *
 * Pure and separate from the stages that produce those parts, so the shape can
 * be tested without cloning anything. The row IS the artifact: a field missing
 * from it is a repo nobody can plan for.
 *
 * `stage` and `step` together are the attribution, and they are two fields
 * rather than one because they answer different questions. `stage` is which
 * half of the mechanical run died — clone, deps, toolset, walk — and `step` is
 * which of the walk's sixteen it was, which is null for the first three.
 */
export function buildRow({
  name,
  branch,
  style,
  sha = null,
  toolsetCommit = null,
  clone = {},
  deps = {},
  toolset = {},
  walks = [],
  bounds,
  rounds = 1,
  ms = 0,
}) {
  const last = walks[walks.length - 1] ?? null;
  const stage = clone.ok === false ? "clone" : deps.ok === false ? "deps" : toolset.ok === false ? "toolset" : "walk";
  const row = {
    name,
    branch,
    style,
    sha: sha ? String(sha).slice(0, 8) : null,
    // The toolset that was walked, read out of the INSTALLED.json install.sh
    // stamps. Without it a row cannot be re-read a week later: "scan refused"
    // means nothing if nobody can say which scan.
    toolsetCommit,
    stage,
    clone: { ok: clone.ok ?? false, seconds: Math.round((clone.ms ?? 0) / 1000), ...(clone.note ? { note: clone.note } : {}), ...(clone.reason ? { reason: clone.reason } : {}) },
    deps: { ok: deps.ok ?? false, mode: deps.mode ?? null, seconds: Math.round((deps.ms ?? 0) / 1000), ...(deps.note ? { note: deps.note } : {}), ...(deps.reason ? { reason: deps.reason } : {}) },
    toolset: { ok: toolset.ok ?? false, seconds: Math.round((toolset.ms ?? 0) / 1000), ...(toolset.reason ? { reason: toolset.reason } : {}) },
    rounds,
    // EVERY pass, not just the last one. With no agent a second pass can only
    // repeat the first or fail on the repeat, and which of those it does is
    // itself a finding about whether the walk is idempotent.
    walks,
    // The top-level answer is the LAST pass, because that is the furthest this
    // repo got. On the default `--rounds 1` there is only one.
    step: last?.furthest ?? null,
    exitCode: last?.exitCode ?? null,
    handover: last?.handover ?? { written: false, items: 0, packets: 0 },
    // The bounds are in the row because a `timed-out` row without them is
    // uninterpretable: 45 minutes and 45 hours are different findings.
    bounds,
    minutes: Number((ms / 60_000).toFixed(1)),
    generatedAt: new Date().toISOString(),
  };
  row.healthy = stage === "walk" && row.exitCode === 75 && row.handover.written && row.handover.items > 0;
  row.reason = rowReason(row, clone, deps, toolset, last);
  return row;
}

/** The one sentence that says where this repo stopped, or why it is fine. */
function rowReason(row, clone, deps, toolset, last) {
  if (clone.ok === false) return `clone failed: ${clone.reason ?? "unknown"}`;
  if (deps.ok === false) return `the repo's own dependencies did not install: ${deps.reason ?? "unknown"}`;
  if (toolset.ok === false) return `install.sh refused this repo: ${toolset.reason ?? "unknown"}`;
  if (!last) return "the walk never ran";
  if (last.timedOut) return `the walk hit the ${row.bounds.walkMinutes} min bound at \`${last.furthest ?? "no step"}\` — slow or stuck, this run cannot tell which`;
  if (row.healthy) {
    return (
      `exit 75 at \`${last.furthest}\` holding ${row.handover.items} item(s) in ${row.handover.packets} packet(s) — ` +
      "this is the success condition: the mechanical half finished and an agent would start here"
    );
  }
  if (row.exitCode === 75) return `exit 75 at \`${last.furthest}\` but the handover on disk holds nothing an agent could answer`;
  if (row.exitCode === 0) {
    return (
      "exit 0: every step reported itself satisfied and nothing was asked, which on a repo with open sides means a " +
      "step answered `satisfied` from an artifact it did not earn"
    );
  }
  return `exit ${row.exitCode} at \`${last.furthest ?? "no step"}\`: ${last.refusal ?? "no reason on stderr"}`;
}

/**
 * The reason, reduced to its SHAPE, so two repos that died the same way group
 * together and two that died differently do not.
 *
 * Mechanical, and deliberately so. A hand-written taxonomy of failures would be
 * a fourth account of this pipeline's defects, written by somebody who has not
 * seen the sweep's output yet — which is the position everybody is in, and the
 * reason this tool exists. Instead the step's own sentence is normalised:
 * absolute paths, quoted names and numbers are the things that differ between
 * two repos with the SAME defect (a different clone directory, a different
 * module name, a different count), so they become placeholders and everything
 * else stays exactly as the step wrote it.
 *
 * What that costs: two genuinely different failures whose sentences differ only
 * in a quoted module name land in one group — `Cannot find module <name>` is
 * one shape whether the module is `@prisma/client` or `ts-morph`, and those
 * have different fixes. That is the right direction to be wrong in for a first
 * pass: the group is still one investigation, and the rows inside it carry the
 * unnormalised reason.
 */
export function reasonShape(text) {
  return String(text ?? "")
    .replace(/(?:\/[\w.@+-]+)+/g, "<path>")
    .replace(/[`"'][^`"']*[`"']/g, "<name>")
    .replace(/\b\d[\d.,]*\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/** The key two repos share when they are one fix rather than two. */
export function shapeKey(row) {
  if (row.healthy) return `walk/${row.step}: exit 75 holding a handover`;
  const where = row.stage === "walk" ? `walk/${row.step ?? "no step"}` : row.stage;
  const last = row.walks?.[row.walks.length - 1] ?? null;
  const reason = row.stage === "walk" ? (last?.refusal ?? row.reason) : (row[row.stage]?.reason ?? row.reason);
  return `${where}: ${reasonShape(reason)}`;
}

/**
 * The summary that is the whole deliverable: how many repos died at the same
 * step for the same kind of reason.
 *
 * Sorted by size, because a shape carried by eleven repos is one fix worth
 * making before breakfast and a shape carried by one is that repo's own
 * problem. The healthy group is included rather than filtered out, so the
 * counts add up to the fleet and a reader can see at a glance what fraction of
 * it got through.
 */
export function failureShapes(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = shapeKey(row);
    if (!groups.has(key)) groups.set(key, { shape: key, healthy: row.healthy === true, stage: row.stage, step: row.step ?? null, repos: [], example: null });
    const g = groups.get(key);
    g.repos.push(row.name);
    // The FIRST unnormalised reason in the group, kept whole: the shape key has
    // had its paths and numbers taken out, and somebody has to be able to see
    // one real instance of it without opening the JSON.
    if (!g.example) g.example = row.reason;
  }
  return [...groups.values()]
    .map((g) => ({ ...g, count: g.repos.length }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape));
}

/**
 * Whether this repo is already answered.
 *
 * The sweep is hours long and dies for reasons that have nothing to do with the
 * repo it died on — a laptop sleeping, a registry timing out. Re-running it must
 * cost only what is missing. A cached row is still PRINTED, so the final table
 * after a restart is the whole fleet and not its tail.
 */
export function resumeDecision({ cached, force = false }) {
  if (force) return { skip: false, why: "--force: walking again over the cached row" };
  if (cached) return { skip: true, why: "walk.json already on disk (--force to walk again)" };
  return { skip: false, why: "no walk.json cached yet" };
}

/* ------------------------------------------------------------------ the table */

export function renderTable(rows) {
  const head = ["repo", "furthest step", "exit", "items", "min", "first refusal"];
  const body = rows.map((r) => [
    r.name,
    r.stage === "walk" ? (r.step ?? "—") : `(${r.stage})`,
    r.exitCode === null || r.exitCode === undefined ? "—" : String(r.exitCode),
    r.handover?.items ? String(r.handover.items) : "—",
    String(r.minutes ?? 0),
    r.healthy ? "" : firstSentence(String(r.reason ?? ""), 78),
  ].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) =>
    cells.map((c, i) => (i === 2 || i === 3 || i === 4 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/* ------------------------------------------------------------- the readiness
 *
 * WHAT THIS ADDS TO THE SWEEP ABOVE, AND WHY IT IS NOT THE SAME TABLE.
 *
 * `failureShapes` groups by the SENTENCE a step printed, which is the right
 * unit for "is this one fix or several". It is the wrong unit for the question
 * plan 16 item 1 asks, which is "what would make this repo runnable, and whose
 * change is it". Eleven repos share one sentence here — `install.sh refused
 * this repo: vitest is not installed in <repo>` — and they are FOUR different
 * problems with two different owners. A group of eleven that reads as one fix
 * is worse than no group, because somebody will try to make it.
 *
 * SO THIS JOINS THREE THINGS THAT ARE ALREADY ON DISK and clones nothing:
 *
 *   out/fleet/<name>/walk.json       how far the mechanical half got
 *   out/fleet/<name>/baseline.json   whether the repo's OWN suite runs green
 *   out/fleet-*-work/<name>/         the clone, for its package.json and
 *                                    whether it has a single test file
 *
 * The clone is the part that is not guaranteed — a fresh machine has none — so
 * every row says whether it had one. A row built without a clone is still a
 * row; it just cannot tell "no runner at all" from "a runner nobody installed",
 * and it says so rather than guessing.
 *
 * WHAT IT MEASURED, 2026-09-19, over the 2026-09-18 sweeps. 17 of 32 repos
 * reach exit 75 — four of them over a suite that is RED before charpilot touches
 * it, which is a finding about the service and not a refusal. Of the 15 that do
 * not reach it:
 *
 *   11  refused at the door for no vitest — and of those, NINE have no test
 *       runner, no `test` script and zero test files; ONE (ai-interview-
 *       centralization) names jest in a script and depends on no runner and has
 *       no tests either; ONE (profile-ms) is a real jest repo with ts-jest and
 *       @nestjs/testing. ZERO have vitest declared and not installed, which is
 *       the only one of the four that "run npm ci" would have fixed — and it
 *       was the only advice the refusal gave.
 *    2  refused at the door for `no src/ directory` — candidate-ms and
 *       contact-ms, both of which keep their TypeScript at the repo root. That
 *       refusal is GONE as of f082129 and these two rows are stale; contact-ms
 *       already has vitest 2.1.9, a config and a green 7-file suite, so it is
 *       the cheapest repo in this table to re-walk.
 *    1  interview-service, whose own `npm ci` exits 403 against the private
 *       Google Artifact Registry that serves `@qode/*`. It HAS `vitest run` in
 *       its scripts; nothing about its suite is known because nothing could
 *       install it.
 *    1  qode-itl-be, which installed and walked and died inside `baseline`.
 *
 * AND THE ONE THING THE ELEVEN SHARE THAT MATTERS: not one of them has a
 * private-registry dependency or an `.npmrc`. All eleven install cleanly with
 * `npm ci` from public npm. So the 403 hazard `fleetcheck.mjs` documents — the
 * reason it installs its runner OUTSIDE the clone — does not apply to a single
 * one of them. That is the measurement somebody will need the day it is
 * decided whether this pipeline may supply a runner to a service that has none.
 * ------------------------------------------------------------------------- */

/** The test runners a package.json declares, and the script it declares them for. */
export function testRunner(pkg) {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const script = pkg?.scripts?.test ?? null;
  const OTHERS = ["jest", "mocha", "ava", "tap", "jasmine", "ts-jest"];
  return {
    vitest: deps.vitest ?? null,
    others: OTHERS.filter((r) => deps[r]).map((r) => `${r}@${deps[r]}`),
    script,
    nodeTest: Boolean(script && /--test\b/.test(script)),
  };
}

/**
 * Whether this repo has ANY test file, counted rather than assumed.
 *
 * It stops at the first one. "Does a suite exist" and "how big is it" are
 * different questions and only the first decides an owner: a repo with a
 * runner and no tests is its owner's to populate, a repo with tests and the
 * wrong runner is its owner's to re-tool, and a repo with neither is not a
 * candidate for anything yet. Returns null when there is no clone to look in,
 * which is a different answer from zero and is printed differently.
 */
export function countTestFiles(dir, { depth = 6 } = {}) {
  if (!dir || !existsSync(dir)) return null;
  const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".claude"]);
  let found = 0;
  const walk = (at, left) => {
    if (left < 0 || found) return;
    let entries = [];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(at, e.name), left - 1);
      } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) found += 1;
    }
  };
  walk(dir, depth);
  return found;
}

/**
 * ONE REPO'S READINESS ROW: what is missing, whose change it is, and the
 * smallest thing that would make the pipeline run on it.
 *
 * `owner` is the field the table exists for, and it takes three values. `ours`
 * is a change in this toolset. `theirs` is a change in the service repo by
 * whoever owns it. `both` is neither half being enough on its own. There is
 * deliberately no "unknown": a row nobody can act on is the state this report
 * replaces, so where the evidence does not decide, the row names what WOULD
 * decide it and calls that the smallest change.
 *
 * IT IS PURE. Every input is already read — the two cached rows, the clone's
 * package.json, a test-file count — which is what lets it be tested against a
 * shape the fleet does not currently have. Most of them are: 0 of 32 repos are
 * in the "vitest declared, not installed" state, and that row still has to be
 * right the day one is.
 */
export function readinessRow({ name, walk = null, baseline = null, pkg = null, testFiles = null }) {
  const runner = testRunner(pkg);
  const suite = baseline?.suite ?? null;
  const row = { repo: name, clone: Boolean(pkg), state: null, missing: null, owner: null, smallest: null };

  if (walk?.healthy) {
    // REACHING EXIT 75 IS THE WALK'S SUCCESS CONDITION AND NOT A RUN'S. A red
    // baseline suite does not stop the mechanical half, and it does change
    // what a run is measured against, so it is reported here rather than
    // folded into "ready".
    const red = suite?.state === "red";
    return {
      ...row,
      state: red ? "ready, suite RED" : "ready",
      missing: red ? `${suite.failed} test(s) failing in ${suite.failedFiles} file(s) on the deployed branch` : null,
      owner: red ? "theirs" : null,
      smallest: red
        ? "their suite goes green, or the run quotes coverage that only the passing tests reached"
        : "nothing — this repo reached the point where an agent earns its money",
    };
  }

  const stage = walk?.stage ?? null;
  const reason = String(walk?.reason ?? "");

  if (/no src\/ directory/.test(reason)) {
    // STALE, AND SAYING SO IS THE POINT. `install.sh` accepts a repo whose
    // TypeScript sits at the root as of f082129 (2026-09-19 15:02); the sweep
    // on disk was taken 2026-09-18 17:21. A report that repeated a refusal the
    // toolset no longer makes would send somebody to fix a repo that is not
    // broken.
    return {
      ...row,
      state: "door/layout (STALE)",
      missing: "nothing — this refusal predates the fix that accepts TypeScript at the repo root",
      owner: "ours",
      smallest: "re-walk it: fleetwalk --only <repo> --force",
    };
  }

  if (/vitest is not installed/.test(reason)) {
    if (!pkg) {
      return {
        ...row,
        state: "door/no-vitest",
        missing: "no clone on this machine, so which KIND of no-vitest this is cannot be said",
        owner: "theirs",
        smallest: "keep the clone and re-walk, so the runner and the test count can be read",
      };
    }
    if (runner.vitest) {
      return {
        ...row,
        state: "door/no-vitest",
        missing: `vitest ${runner.vitest} is declared and was not in node_modules`,
        owner: "ours",
        smallest: "install the repo's own dependencies before install.sh runs — npm ci, or pnpm install in a pnpm workspace",
      };
    }
    if (runner.others.length) {
      return {
        ...row,
        state: "door/other-runner",
        missing: `${runner.others.join(" + ")}${testFiles ? ", with test files" : ", with no test files"} and no vitest`,
        owner: "theirs",
        smallest: "its owner adds vitest beside what it has — stage 4 spawns node_modules/vitest/vitest.mjs and drives no other runner",
      };
    }
    if (runner.nodeTest) {
      return {
        ...row,
        state: "door/other-runner",
        missing: `node's own test runner (${runner.script})${testFiles ? ", with test files" : ""} and no vitest`,
        owner: "theirs",
        smallest: "its owner adds vitest — and note this script also carries --watch, which never exits",
      };
    }
    return {
      ...row,
      state: "door/no-runner",
      missing: runner.script
        ? `a test script (${runner.script}) naming a runner the repo does not depend on, and ${testFiles ? "test files" : "no test files"}`
        : `no test script, no test runner and ${testFiles ? "test files nothing can run" : "no test files"}`,
      owner: "theirs",
      smallest:
        "its owner adds vitest and one test. There is no suite here for this pipeline to intrude on and nothing yet to characterize against",
    };
  }

  if (stage === "deps") {
    return {
      ...row,
      state: "deps",
      missing: firstSentence(reason, 110),
      owner: "both",
      smallest:
        "a read-only token for the registry it resolves from, in the environment the sweep runs in; nothing about its suite is known until then",
    };
  }

  return {
    ...row,
    state: stage === "walk" ? `walk/${walk?.step ?? "no step"}` : (stage ?? "not walked"),
    missing: reason ? firstSentence(reason, 110) : "no walk on disk for this repo",
    owner: "ours",
    smallest: reason ? "one repo, one step, one defect — read out/fleet/<repo>/walk.json" : "walk it",
  };
}

/**
 * The readiness table.
 *
 * Sorted by owner and then by state, because the whole use of this document is
 * "hand me the list of things I can fix" and "hand the rest to the services".
 */
export function renderReadiness(rows) {
  const head = ["repo", "state", "owner", "what is missing", "smallest change"];
  const order = { ours: 0, both: 1, theirs: 2 };
  const sorted = [...rows].sort(
    (a, b) =>
      (order[a.owner] ?? 3) - (order[b.owner] ?? 3) ||
      String(a.state).localeCompare(String(b.state)) ||
      a.repo.localeCompare(b.repo)
  );
  const body = sorted.map((r) => [r.repo, r.state ?? "—", r.owner ?? "—", r.missing ?? "—", r.smallest ?? "—"].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

/** How many repos are ready, and how many are waiting on us, on them, or on both. */
export function readinessCounts(rows) {
  const counts = { ready: 0, ours: 0, theirs: 0, both: 0 };
  for (const r of rows) {
    if (String(r.state).startsWith("ready")) counts.ready += 1;
    if (r.owner && counts[r.owner] !== undefined) counts[r.owner] += 1;
  }
  return counts;
}

/** The single line printed per repo as the sweep goes, so a dead run is readable. */
export function progressLine(row) {
  const where = row.stage === "walk" ? (row.step ?? "no step") : `(${row.stage})`;
  return (
    `${row.name.padEnd(28)}` +
    `${row.healthy ? "OK " : "!! "} · ` +
    `${String(where).padEnd(12)} · ` +
    `exit ${String(row.exitCode ?? "—").padStart(3)} · ` +
    `${row.handover?.items ?? 0} item(s) in ${row.handover?.packets ?? 0} packet(s) · ` +
    `${row.minutes} min`
  );
}

/* ------------------------------------------------------------------ the steps */

function timed(fn) {
  const t = Date.now();
  try {
    const r = fn();
    return { ok: true, ms: Date.now() - t, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, reason: refusalLine(String(e.message ?? e)) };
  }
}

/** fleetcheck's clone, with the same rule: a clone on the wrong branch is moved. */
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
 * The repo's REAL dependencies — the same two commands, in the same order, that
 * `docker/char/packs/common.py:npm_install` runs in the container.
 *
 * `npm ci` first, because it is what CI does and the only mode that reproduces
 * the lockfile exactly; `npm install` when it refuses, RECORDED as such, because
 * several services on this fleet carry a lockfile a branch older than their
 * manifest and a repo with a stale lockfile is still characterizable. The
 * container makes the same fallback silently; recording which one ran is the one
 * thing this adds, because a toolset installed against resolved-today
 * dependencies is a slightly different program from the one CI runs.
 *
 * `--legacy-peer-deps` is not passed, for the reason fleetbaseline does not pass
 * it: a peer conflict in the repo's own tree is the repo's own state, and
 * papering over it would install a combination the service never runs — and the
 * conflict is exactly the kind of finding this sweep is for.
 */
function installDeps(dir, bounds) {
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
 * The charpilot toolset, installed by the SAME script the container runs.
 *
 * `bash`, not `sh`, and not a reimplementation. `docker/char/packs/nodejs.py`
 * calls `bash tools/install.sh <scan_root>` and nothing else, so this is the
 * imitation being made: install.sh's own prerequisite gate — package.json, a
 * `src/` directory, a `.ts` file in it, a vitest in node_modules — is one of the
 * places defects have actually lived, and reproducing it by hand here would
 * measure this file's idea of the gate rather than the gate.
 *
 * Its refusals go on stdout as `✗ <what>` followed by an indented hint; the
 * reason kept is the `✗` line, which is the whole diagnosis.
 */
function installToolset(dir, bounds) {
  const r = run("bash", [join(PILOT_DIR, "install.sh"), dir], { cwd: dir, timeout: bounds.toolsetMinutes * 60_000 });
  if (r.error?.code === "ETIMEDOUT") throw new Error(`install.sh hit the ${bounds.toolsetMinutes} min bound`);
  if (r.status !== 0) throw new Error(refusalLine(r.stdout || r.stderr || ""));
  return {};
}

/**
 * ONE PASS OF THE WALK, WITH NO AGENT, spawned exactly as the container spawns
 * it: `node .claude/charpilot/workflow.mjs <repo>` with the CWD at the repo.
 *
 * The CWD is not optional and cost a run to learn: config.mjs resolves the repo
 * from it and REFUSES a directory that is not a package root, so a walk spawned
 * from anywhere else dies before its first step with "charpilot: /work is not a
 * package root" (run 20260916T093831Z, dead in 55 seconds). The positional
 * argument is passed for the same reason the container passes it — `resolveRepo`
 * accepts and CHECKS it, never obeys it, so it is a cross-check that the CWD and
 * the intent agree.
 *
 * Streamed line by line rather than collected at the end, because the ARRIVAL
 * TIME of each line is the only per-step clock that exists.
 */
function walkOnce(dir, service, bounds) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(dir, ".claude", "charpilot", "workflow.mjs"), dir], {
      cwd: dir,
      env: walkEnv({ service }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    const tail = { out: "", err: "" };
    const reader = (which) => {
      let buffer = "";
      return (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const text of lines) {
          events.push({ ms: Date.now() - started, text, stream: which });
          tail[which] = `${tail[which]}${text}\n`.slice(-8000);
        }
      };
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", reader("out"));
    child.stderr.on("data", reader("err"));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM then SIGKILL: a walk in the middle of a `record` spawn has
      // children of its own, and a TERM it never handles leaves them running
      // against the next repo's clock.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, bounds.walkMinutes * 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      done({ events, exitCode: null, timedOut, ms: Date.now() - started, spawnError: String(err.message ?? err), tail });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ events, exitCode: code, signal, timedOut, ms: Date.now() - started, tail });
    });
  });
}

/**
 * This machine's clone path, written back as `<repo>`.
 *
 * NOT cosmetic, and not a paraphrase of anybody's words. install.sh refuses
 * with `vitest is not installed in <target>`, and `<target>` here is 108
 * characters of worktree, work directory and repo name — the same 105
 * characters on every row, which is most of the table's refusal column and all
 * of its width. Only the path is touched; the sentence is the step's, whole.
 *
 * A PLACEHOLDER AND NOT THE REPO'S NAME, which was the first version of this and
 * was worse than leaving the path alone. `reasonShape` normalises a PATH to
 * `<path>`, so two repos refused for the same reason grouped correctly while
 * the path was there — substituting the name put `image-forwarder` into the
 * shape key itself, and every repo with that one defect became its own group of
 * one. That is precisely the way this summary can be wrong while looking
 * finished. The row already carries the repo's name in its own column, so the
 * placeholder loses a reader nothing.
 */
const unprefix = (text, dir) => String(text ?? "").split(dir).join("<repo>");

/** Whatever JSON is at `path`, or null — a truncated write is not an answer. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- the run */

async function measure(name, branch, style, bounds, rounds) {
  const t0 = Date.now();
  const dir = join(WORK, name);
  const parts = { name, branch, style, bounds, rounds };
  // Every reason this repo produces, with this machine's clone path written
  // back as the repo's name. Applied at the one place all of them pass through.
  const stage = (fn) => {
    const out = timed(fn);
    return out.reason ? { ...out, reason: unprefix(out.reason, dir) } : out;
  };

  const cl = stage(() => clone(name, branch, dir));
  if (!cl.ok) return buildRow({ ...parts, clone: cl, ms: Date.now() - t0 });

  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout?.trim() ?? null;
  const common = { ...parts, clone: cl, sha };

  const deps = stage(() => installDeps(dir, bounds));
  if (!deps.ok) return buildRow({ ...common, deps, ms: Date.now() - t0 });

  const toolset = stage(() => installToolset(dir, bounds));
  const toolsetCommit = readJson(join(dir, ".claude", "charpilot", "INSTALLED.json"))?.sourceCommit ?? null;
  if (!toolset.ok) return buildRow({ ...common, deps, toolset, toolsetCommit, ms: Date.now() - t0 });

  const walks = [];
  for (let round = 1; round <= rounds; round += 1) {
    const result = await walkOnce(dir, name, bounds);
    const steps = parseWalk(result.events);
    // stderr carries the walk's own refusal, `✗ <step>: <reason>`. stdout
    // carries a step that could not run. Both are looked at, in that order.
    const refusal =
      result.exitCode === 0 || result.exitCode === 75
        ? null
        : unprefix(refusalLine(result.tail.err || result.tail.out || result.spawnError || ""), dir);
    const handover = handoverFacts(readJson(join(dir, ".claude", "charpilot", "out", "worklist-decisions.json")));
    const furthest = steps.length ? steps[steps.length - 1].step : null;
    walks.push({
      round,
      exitCode: result.exitCode,
      ...(result.signal ? { signal: result.signal } : {}),
      timedOut: result.timedOut,
      minutes: Number((result.ms / 60_000).toFixed(1)),
      furthest,
      // How far down ORDER that is, so a reader can compare two repos without
      // knowing the order by heart.
      furthestIndex: furthest ? ORDER.indexOf(furthest) + 1 : 0,
      stepCount: ORDER.length,
      steps,
      handover,
      refusal,
      // Attributed to the step whose words the refusal is, not to whichever
      // step happened to print last.
      refusalStep: refusal ? (refusalStep(refusal) ?? furthest) : null,
      // The last 8 KB of each stream, so a reader can see the rest without the
      // clone. Only kept when something went wrong — a healthy walk's stdout is
      // the `steps` array above, said twice.
      ...(refusal || result.timedOut ? { tail: result.tail } : {}),
    });
    // A SECOND PASS IS ONLY WORTH SPAWNING IF THE FIRST ONE STOPPED CLEANLY.
    // With no agent, a walk that refused will refuse identically, and the
    // minutes are better spent on the next repo.
    if (result.exitCode !== 75 && result.exitCode !== 0) break;
  }

  return buildRow({ ...common, deps, toolset, toolsetCommit, walks, ms: Date.now() - t0 });
}

/**
 * The clone this machine happens to have of one repo, whichever sweep left it.
 *
 * THREE DIRECTORIES AND NOT ONE, in the order of how recently each is written:
 * `fleet-walk-work` is this tool's, `fleet-baseline-work` is fleetbaseline's,
 * `fleet-work` is fleetcheck's pristine one. Any of them answers "what does
 * this repo's package.json say", none of them is guaranteed to be there, and
 * reading fleetcheck's does not disturb it — nothing here writes.
 */
function cloneFor(name, dirs) {
  for (const dir of dirs) {
    const at = join(dir, name);
    if (existsSync(join(at, "package.json"))) return at;
  }
  return null;
}

/**
 * The readiness report, off the caches, with nothing cloned and nothing run.
 *
 * SEPARATE FROM THE SWEEP ON PURPOSE. The sweep takes hours and needs the
 * network; this needs neither and answers the question somebody asks the
 * morning after. It refuses to invent a row for a repo that was never walked —
 * "not walked" is a state and is printed as one — because a readiness table
 * that quietly omits the repos nobody measured reads as a shorter fleet.
 */
function reportReadiness(fleet) {
  const dirs = [WORK, resolve(OUT_DIR, "fleet-baseline-work"), resolve(OUT_DIR, "fleet-work")];
  const rows = fleet.map(({ name }) => {
    const clone = cloneFor(name, dirs);
    return readinessRow({
      name,
      walk: readJson(join(CACHE, name, "walk.json")),
      baseline: readJson(join(CACHE, name, "baseline.json")),
      pkg: clone ? readJson(join(clone, "package.json")) : null,
      testFiles: countTestFiles(clone),
    });
  });
  const counts = readinessCounts(rows);

  if (flag("--json")) {
    process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), cache: CACHE, counts, repos: rows }, null, 2)}\n`);
    return;
  }

  log("FLEET READINESS — what would make each repo runnable, and whose change it is.");
  log("Read off out/fleet/<repo>/{walk,baseline}.json and the clones beside them. Nothing is cloned, installed or run here.\n");
  log(renderReadiness(rows));
  log(
    `\n${counts.ready}/${rows.length} ready · ${counts.ours} waiting on this toolset · ${counts.both} on both · ` +
      `${counts.theirs} on the service's own maintainers\n` +
      `"Ready" means the mechanical half reached exit 75 holding a handover. It is not a promise that a run finishes,\n` +
      `and it says nothing about cost: every boundary in that sweep was a double, because the host has no route to staging.\n` +
      `A row whose clone is absent says so — it cannot tell "no runner at all" from "a runner nobody installed".\n`
  );
}

async function main() {
  const only = arg("--only", "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = arg("--from", "");
  const force = flag("--force");
  const bounds = { installMinutes: INSTALL_MINUTES, toolsetMinutes: TOOLSET_MINUTES, walkMinutes: WALK_MINUTES };

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
  // READ-ONLY, AND IT RETURNS BEFORE THE DIRECTORIES ARE MADE. `--ready`
  // answers off the cache; a report that created a work directory as a side
  // effect of being read would leave a 20-GB-shaped hole on a machine that
  // only wanted the table.
  if (flag("--ready")) return reportReadiness(fleet);

  mkdirSync(WORK, { recursive: true });
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(join(IAC, "manifests"))) {
    // NOT FATAL, and said out loud. Every repo would then record
    // `stagingenv: iac-not-found`, which is a true row about this machine and a
    // false one about the fleet — so the sweep says so once, here, rather than
    // 32 times in the table.
    log(`! ${IAC} has no manifests/ — every repo will record the environment as unresolvable. Pass --iac <qode-iac>.\n`);
  }

  log(
    `fleetwalk: ${fleet.length} repo(s), ${ROUNDS} walk pass(es) each, bounded at ${bounds.installMinutes} min install, ` +
      `${bounds.toolsetMinutes} min toolset and ${bounds.walkMinutes} min walk.\n` +
      `CHARPILOT_MODE=mocked · CHARPILOT_IAC=${IAC} · CHARPILOT_SERVICE=<the repo's deploy name> · no database address is set.\n` +
      `Exit 75 holding a handover is SUCCESS. Cache → ${CACHE}\n`
  );

  const rows = [];
  for (const { name, branch: declared, style } of fleet) {
    const branch = BRANCH_OVERRIDE || declared;
    const cachedPath = join(CACHE, name, "walk.json");
    const cached = existsSync(cachedPath) ? readJson(cachedPath) : null;
    const decision = resumeDecision({ cached, force });
    if (decision.skip && cached) {
      log(`${progressLine(cached)}   [cached]`);
      rows.push(cached);
      continue;
    }

    const row = await measure(name, branch, style, bounds, ROUNDS);
    log(progressLine(row));
    // The reason is on its own line under the repo, because the table has no
    // column wide enough for a sentence and the sentence is the finding.
    log(`  ↳ ${row.reason}`);
    rows.push(row);

    mkdirSync(join(CACHE, name), { recursive: true });
    writeFileSync(join(CACHE, name, "walk.json"), `${JSON.stringify(row, null, 2)}\n`);

    // Self-cleaning, and not optional: this installs each repo's whole tree plus
    // the four packages install.sh adds, fleetcheck measured the fleet's trees
    // at 20–33 GB, and fleetbaseline is installing its own alongside. The ANSWER
    // is cached, so what `--keep` buys back is only the time to install again.
    if (!flag("--keep")) {
      const nm = join(WORK, name, "node_modules");
      if (existsSync(nm) && !lstatSync(nm).isSymbolicLink()) rmSync(nm, { recursive: true, force: true });
    }
  }

  log(`\n${renderTable(rows)}\n`);

  const shapes = failureShapes(rows);
  const healthy = rows.filter((r) => r.healthy);
  log("BY FAILURE SHAPE — how many repos died at the same step for the same kind of reason.");
  log("A shape carried by several repos is ONE fix; a shape carried by one is that repo's own problem.\n");
  for (const g of shapes) {
    log(`${String(g.count).padStart(3)}  ${g.shape}`);
    log(`     ${g.repos.join(", ")}`);
    if (!g.healthy) log(`     e.g. ${g.example}`);
  }

  const doc = {
    generatedAt: new Date().toISOString(),
    cache: CACHE,
    work: WORK,
    bounds,
    rounds: ROUNDS,
    environment: {
      CHARPILOT_MODE: "mocked",
      CHARPILOT_IAC: IAC,
      CHARPILOT_SERVICE: "the repo's deploy name, per repo",
      CHARPILOT_EXPECTED_DB: null,
    },
    shapes,
    repos: rows,
  };
  const path = join(OUT_DIR, "fleetwalk.json");
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);

  log(
    `\n${healthy.length}/${rows.length} repo(s) reached exit 75 holding a handover · ${shapes.length} distinct shape(s)\n` +
      `That count is the MECHANICAL half only: clone, the repo's own dependencies, install.sh, and the walk's steps up to\n` +
      `the first one that asks a question. It says nothing about whether an agent could answer that handover, what the\n` +
      `run would cost, or whether stage 4 could dial a boundary — every boundary here is a double, because this host has\n` +
      `no route to staging and the sweep is CHARPILOT_MODE=mocked throughout.\n` +
      `\nwrote ${path}\n`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
