#!/usr/bin/env node
/**
 * replaywalk — drive the REAL walk across rounds against a finished run's
 * answers, with no agent and no money.
 *
 *   node tools/replaywalk.mjs --runs
 *       what is replayable on this machine, and why each other run is not
 *   node tools/replaywalk.mjs --run docker/runs/20260920T030124Z
 *       the whole ORDER, up to 40 rounds, about two minutes — the walk exactly as
 *       the container spawns it
 *   node tools/replaywalk.mjs --run <dir> --pack-rev 2bc77ae
 *       the same run against the pack as it stood at some commit
 *   node tools/replaywalk.mjs --run <dir> \
 *     --order preflight,stagingenv,baseline,scan,deadcode,worklist,vocabulary,derive
 *       stage 3 alone, in seconds — the mode D75 would have been caught in
 *   node tools/replaywalk.mjs --run <dir> --env CHARPILOT_YIELD_RATCHET=off
 *       with the collapsed-round stop out of the way, so a termination defect
 *       behind it is reachable
 *
 *   --repo <path>        the checkout to build the sandbox from; taken from the
 *                        run's own log when it is not given
 *   --rounds <n>         the round cap. 40 is `docker/char/packs/nodejs.py`'s
 *   --round-timeout <s>  the bound on one walk, in seconds. 2700
 *   --work <dir>         where sandboxes go. Never inside a git repo — see
 *                        `DEFAULT_WORK`
 *   --keep               do not delete the sandbox afterwards
 *   --verbose            print every line the walk printed, per round
 *
 * WHY THIS EXISTS. The test ladder had a hole exactly the width of a round
 * boundary:
 *
 *   node --test      pure functions on mocked artifacts   fast, blind to the walk
 *   packetcost.mjs   ONE packet, ONE shot, a real agent   cost and first-pass yield
 *   fleetwalk.mjs    the real walk, stops at the FIRST handover
 *   a container run  ~2 hours and ~$40, real everything
 *
 * Nothing between the third row and the fourth exercised the walk ACROSS
 * rounds. `packetcost.mjs` has no round loop and never calls `derive.satisfied`;
 * `fleetwalk.mjs` stops before round 2. A predicate that goes false from round 2
 * onward was therefore invisible to everything cheaper than a container.
 *
 * D75 was that defect and it was found by reading a log after the fact.
 * `inspectSubmissions`'s notes branch had no already-answered test, so every
 * cleanly-materialised note stayed in `ready` for ever and
 * `ready.every(asked.has)` was false from the first note that landed. It cost
 * run `20260920T030124Z` four rounds, 2,231 seconds and a 96.5%-branch success
 * that ended as `status 1`. That run is this tool's regression fixture: against
 * `2bc77ae` the replay must reproduce the non-termination, and against `70a4d99`
 * it must terminate.
 *
 * WHAT IT REPLAYS, AND WHY IT IS FREE. A run's `answers/` directory is a
 * complete record of what its workers produced, and the expensive half — the
 * agent turn that produced it — is already paid for. The walk MATERIALISES those
 * files itself (`steps/derive.mjs`'s `materialise` spawns `propose.mjs`,
 * `notes.mjs` and `blocked.mjs`), so the answering turn's entire contribution to
 * the filesystem is a set of files in `charpilot-answers/`. Replaying a round is
 * therefore: run the walk, and when it exits 75, copy in the answer files the
 * original run's agent wrote during ITS round of the same number. The walk is
 * spawned exactly as `docker/char/packs/nodejs.py` spawns it — `node
 * workflow.mjs <root>` with `cwd` at the root — because config.mjs fixes every
 * path from the CWD at import and an in-process call would resolve them here.
 *
 * WHAT IT ANSWERS, PER ROUND: which steps ran and what each said, whether
 * `derive.satisfied` is true and WHICH OF ITS SIX CLAUSES IS FALSE when it is
 * not, the `open` / `ready` / `problems` / `asked` counts, how many items were
 * handed over, and how far down ORDER the walk reached. The last one is the
 * point: no run in this project's history has written `result.json` through the
 * walk rather than through `workflow.salvageResult`, and this is the only cheap
 * way to find out what stops it.
 *
 * WHAT IT IS A SIBLING OF, AND WHAT IT DELIBERATELY IS NOT.
 *
 *   `fleetprobe`   one or two packets per SHAPE across the fleet, to find where
 *                  the fleet breaks. Clones over the network, two npm installs
 *                  per repo, a real agent.
 *   `packetcost`   ONE packet against artifacts already on disk, one real agent
 *                  turn, no walk and no round loop. Its SANDBOX is what this
 *                  reuses (`sandboxPlan`, `refuseOverlap`).
 *   `fleetwalk`    the real walk against a real repo, ONE round, stopping at the
 *                  first handover. Its `parseWalk` is what this reads step lines
 *                  with, imported rather than rewritten.
 *   `replaywalk`   the real walk, MANY rounds, NO agent. It buys round-to-round
 *                  behaviour and nothing else, and it buys it for the price of
 *                  the tools the walk spawns.
 *
 * WHAT A REPLAY CANNOT SEE, and every one of these has cost a run:
 *
 *   - A WORKER READING THE WRONG FILE. The answers are given; nothing here
 *     decides what a worker would have read out of a packet it was handed, so a
 *     brief that misleads is invisible. `packetcost` is where that is measured.
 *   - A DEADLINE. `handover.mjs` gives a container worker 30 minutes and
 *     `nodejs.py` bounds the walk by the run's remaining budget. A replay has no
 *     clock, so a round that a real run would have been killed in the middle of
 *     finishes here.
 *   - A FAULT THE AGENT WOULD HAVE REPAIRED. A real round that is handed a
 *     refusal can answer it; the recording only holds what that run's agent
 *     actually wrote. Once the recording is exhausted the replay keeps walking
 *     and the answers stop arriving, so every round after that is a round with a
 *     silent agent. It is reported as `recording exhausted` and never as a
 *     finding.
 *   - THE GATEWAY, THE MODEL AND THE MONEY. No turn is spawned, so nothing here
 *     says anything about cost, cache hit rate, turn count or a 502.
 *   - A DIVERGENT WALK. Answers are sliced into rounds by the ORIGINAL run's
 *     round boundaries. If the replayed walk asks something different from what
 *     that run was asked, the answers still arrive on the original schedule. The
 *     replay is faithful to the ANSWERS, not to a counterfactual agent.
 *   - THE RUN'S OWN ISTANBUL REPORT. `finish.py` does not copy
 *     `coverage-charpilot/` out of the container, so the report the brief is
 *     joined against has to come from the checkout and is the nearest one rather
 *     than the right one — 219 of 365 branch arms against the run's 221 of 367
 *     on `20260920T030124Z`. Sides whose arm exists in one and not the other
 *     appear as `the measurement and the work list disagree about the arm
 *     model`, and those are the replay's mismatch and not the run's. The two
 *     numbers are printed side by side at the top of every replay for that
 *     reason.
 *
 * THE SANDBOX, AND THE FOUR SUBSTITUTIONS A REPLAY NEEDS. `packetcost.sandboxPlan`
 * already describes a sandbox that cannot write into the target: every top-level
 * entry symlinked, the pack COPIED (node resolves symlinks in ESM, so a
 * symlinked config.mjs would resolve `PROPOSALS_DIR` back into the live repo),
 * `out/` relinked, `proposals/` and `charpilot-answers/` created empty. That plan
 * is reused, and four things are substituted into it. Three of the four were
 * found the same way: a replay ran, printed a clean table, and described
 * something that never happened.
 *
 *   THE PACK UNDER TEST replaces the repo's frozen one. install.sh's own two
 *   copy lines (`*.mjs`/`*.mts`, then `steps/.`) are applied over the copied
 *   pack, from this checkout's `tools/` or from `--pack-rev <rev>`, which is what
 *   makes "against 2bc77ae it must not terminate, against 70a4d99 it must" a
 *   thing one command can ask.
 *
 *   `out/` IS COPIED FROM THE RUN'S `stages/`, not relinked from the repo, and
 *   only the artifacts that existed before stage 3 began — see
 *   `STAGE_THREE_ONWARD` for what is withheld and why seeding any of it would
 *   answer the question this tool asks. Copied and not linked because
 *   `freshness.mjs` asks whether the artifact is newer than the newest file
 *   under `src/`, and a copy is.
 *
 *   `src/` AND `test/` COME FROM THE RUN'S OWN COMMIT, via `git archive` — see
 *   `materialiseTree`. The working tree is a CHARACTERIZED checkout and the
 *   container's clone was not, and the difference is not cosmetic: a
 *   `test/characterization/` full of generated specs makes `measure`'s
 *   precondition pass on the banking visit, so `measure` runs `coverage.mjs`,
 *   refuses, and ends the round before `derive` has run once. Measured: twelve
 *   replayed rounds with `open=148` unmoved in every one.
 *
 *   EVERY `coverage*` DIRECTORY STARTS EMPTY, and `coverage-charpilot/` is then
 *   filled with the istanbul report nearest the run's own baseline. `packetcost`
 *   only ever needed to skip the big one; a replay walks stage 6, and
 *   `coverage.mjs:92` writes into `coverage-charpilot-stage6/` — a symlink into
 *   the checkout, which is exactly the write this sandbox exists to prevent,
 *   arriving through the directory nobody was watching.
 *
 * WHY THE WHY-NOT IS COMPUTED HERE AND THE WALK IS NOT TOUCHED. `derive.satisfied`
 * returns a bare boolean and must go on doing so — a predicate that reported its
 * own reasons would be a second account of the run, which is the thing this
 * pipeline has none of on purpose. So the diagnosis is taken by asking the SAME
 * exported functions the predicate asks, in the same order, from the SANDBOX's
 * copy of the pack under test: `judgeProposals`, `proposedSides`, `declaredSides`,
 * `handedOver`, `inspectSubmissions`, `openSides`, `handedEverything`. Nothing is
 * reimplemented, so the diagnosis cannot disagree with the predicate; it is the
 * predicate, unrolled. It runs AFTER the walk, over the disk the walk left.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// THE SANDBOX, from the tool that owns it. `sandboxPlan` carries the NEVER_LINK
// set and the reason each entry is in it, and `refuseOverlap` is what stops a
// `--work` inside the checkout from having `rmSync` delete a repo whose
// artifacts are, for three of these six services, the only copy anybody has. A
// second sandbox builder here would be a second set of those decisions.
import { refuseOverlap, sandboxPlan, labelsByArmFrom } from "./packetcost.mjs";
// WHAT THE WALK SAID ABOUT EACH STEP, in the walk's own words, from the tool
// that already knows the five things workflow.mjs prints about a step. A second
// reader here would disagree with fleetwalk about what "already done" means.
import { parseWalk } from "./fleetwalk.mjs";
// ORDER is what a step's progress is measured against. Imported and never
// copied, for fleetprobe's reason: a copy goes stale the moment a step is added.
import { ORDER } from "./steps/index.mjs";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_SELF = resolve(PILOT_DIR, "..", "..");
const RUNS_DIR = join(REPO_ROOT_SELF, "docker", "runs");

/**
 * Where the six repos with full artifacts live.
 *
 * FOUND BY WALKING UP AND NEVER BY COUNTING `..`. This checkout is as likely to
 * be a treehouse worktree four levels down as the workspace clone two levels
 * down, and a fixed depth resolves to a directory that does not exist in the
 * other layout — which reads as "no checkout of location-ms", a sentence that
 * sends the reader looking for a missing repo rather than a wrong constant.
 */
export function reposDir(from = REPO_ROOT_SELF) {
  let at = resolve(from);
  for (let i = 0; i < 8; i++) {
    const guess = join(at, "qode-knowledge", "repos");
    if (existsSync(guess)) return guess;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  return null;
}

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);

const log = (s) => process.stdout.write(`${s}\n`);

/**
 * The container's own round cap for this pack, taken rather than invented:
 * `docker/char/packs/nodejs.py` reads `CHARPILOT_NODE_MAX_ROUNDS` and defaults
 * to 40, a backstop now that time is the limit. A replay that ran further than a real run can would be reporting a
 * termination no container would ever have reached.
 */
export const DEFAULT_ROUNDS = 40;

/**
 * WHERE A SANDBOX GOES, AND WHY IT IS NOT UNDER THIS CHECKOUT.
 *
 * `freshness.mjs` calls `git rev-parse HEAD` in the target root and calls an
 * artifact STALE when the sha it records is not that one. A container's
 * `/work/repo` is a checkout of the service at the sha its artifacts were
 * written at, so every stage-1 and stage-2 artifact reads FRESH and the walk
 * says `already done`. A sandbox has no `.git` of its own — `packetcost`'s
 * NEVER_LINK excludes it, because a worker with a git dir is a worker that can
 * commit into the evidence — so `rev-parse` walks UP, and a sandbox placed under
 * `nodejs/out/` answers with qode-characterize's HEAD. Measured: every seeded
 * artifact then reads `recorded e04b2950, HEAD is 70a4d99e`, `baseline` and
 * `scan` re-run in round 1, scan.json is rewritten from the local checkout, and
 * the replay's round 1 reports 361 open sides against the run's 146 — it is
 * replaying a different repo. Outside any git repo `rev-parse` fails,
 * `headSha()` is null, the sha clause is skipped, and freshness falls back to
 * the mtime test, which a copied artifact passes. That is the same verdict the
 * container reaches, by the other route.
 */
export const DEFAULT_WORK = join(tmpdir(), "charpilot-replaywalk");

/** The walk's own exit codes, spelled as `workflow.mjs` spells them. */
export const EXIT_OK = 0;
export const EXIT_NEEDS_DECISION = 75;

/* ------------------------------------------------------- reading a finished run */

/**
 * WHICH ARTIFACTS OF A FINISHED RUN BELONG TO STAGE 3 AND LATER.
 *
 * A replay starts where stage 3 started, so everything in this set is withheld
 * from the sandbox's `out/` and everything else in `stages/` is copied in. The
 * split is by PRODUCER and not by name pattern: `behaviour*.json` is `record`'s,
 * `determinism.json` is `determinism`'s, `coverage.json` and `loop.json` are
 * `measure`'s, `result.json` is `report`'s, and the three
 * `worklist-decisions*` entries are the WALK's own record of what it asked.
 *
 * SEEDING ANY OF THEM WOULD ANSWER THE QUESTION THIS TOOL ASKS. `report.satisfied`
 * reads `result.json`; a seeded one makes the walk report `already done` and the
 * replay would announce that the walk reaches `report` on a `result.json` the
 * original run's SALVAGE wrote. `record.satisfied` reads the recording, and a
 * seeded `worklist-decisions.json` is a handover for questions nobody asked this
 * time — `derive.satisfied` reads exactly that file to decide whether a
 * submission has already been raised.
 */
export const STAGE_THREE_ONWARD = Object.freeze([
  /^behaviour.*\.json$/,
  /^determinism\.json$/,
  /^coverage\.json$/,
  /^loop\.json$/,
  /^result\.json$/,
  /^quarantine\.json$/,
  /^emitted\.json$/,
  /^worklist-decisions\b/,
  /^record\.test\.ts$/,
  /^notes$/,
]);

/** Whether this entry of a run's `stages/` is one a replay must NOT be given. */
export function producedByStageThree(name) {
  return STAGE_THREE_ONWARD.some((re) => re.test(name));
}

/**
 * When each round of the recorded run STARTED, off the pack's own log line.
 *
 * `docker/char/packs/nodejs.py` prints `round <n>/<max> (<m> min left)` under
 * phase `steps` immediately before it spawns the walk, so the line is the round
 * boundary as the run itself drew it. Read from there rather than from the
 * `round <n> row` events, which `packetlog.mjs` writes at the END of a round and
 * which are MISSING for any round whose agent turn failed — round 2 of
 * `20260920T030124Z` has no row, and a slicing built on rows would silently fold
 * its five answers into round 3.
 */
export function roundStarts(lines) {
  const starts = [];
  for (const ev of lines) {
    if (ev?.phase !== "steps") continue;
    const m = /^round (\d+)\/(\d+)\b/.exec(String(ev.msg ?? ""));
    if (!m) continue;
    starts.push({ round: Number(m[1]), at: Date.parse(ev.ts), max: Number(m[2]) });
  }
  return starts;
}

/** Which service the run characterized, off the first line it wrote. */
export function targetName(lines) {
  for (const ev of lines) {
    const m = /^characterizing\s+(\S+)/.exec(String(ev.msg ?? ""));
    if (!m) continue;
    return basename(String(m[1]).replace(/\.git$/, ""));
  }
  return null;
}

/** Every JSON line of a run's log, skipping whatever cannot be parsed. */
export function readRunLog(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The recorded answers, each with the moment it was written.
 *
 * MTIME AND NOT CONTENT, because nothing inside a submission says which round
 * produced it: `propose.mjs` writes the document verbatim and `notes.mjs` reads
 * `--round` off the step, not off the file. `finish.py` copies the directory out
 * of the container with `shutil.copytree`, which preserves mtimes, so the times
 * are the container's and they are the only round attribution that exists.
 */
export function recordedAnswers(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
}

/**
 * The answers, split into the rounds that produced them.
 *
 * Round `n` gets every answer written at or after round `n`'s start and before
 * round `n+1`'s. An answer written before the first round started belongs to
 * round 1 — the walk's first invocation is a few seconds into the run and a
 * clock skew of seconds must not lose a file — and anything after the last round
 * started belongs to the last round.
 *
 * A ROUND WITH NO ANSWERS IS A REAL ROUND AND KEEPS ITS SLOT. Rounds 3, 5, 8 and
 * 10 of `20260920T030124Z` produced nothing; compacting them away would shift
 * every later slice one round earlier and the replay would no longer be
 * reproducing that run's shape.
 */
export function sliceByRound(answers, starts) {
  const ordered = [...starts].sort((a, b) => a.round - b.round);
  if (!ordered.length) return answers.length ? [answers.map((a) => a.name)] : [];
  const slices = ordered.map(() => []);
  for (const answer of answers) {
    let idx = 0;
    for (let i = 0; i < ordered.length; i++) if (answer.at >= ordered[i].at) idx = i;
    slices[idx].push(answer.name);
  }
  return slices;
}

/** What a run directory offers a replay, or why it offers nothing. */
export function surveyRun(dir) {
  const lines = readRunLog(join(dir, "log.jsonl"));
  const answers = recordedAnswers(join(dir, "answers"));
  const starts = roundStarts(lines);
  let result = null;
  try {
    result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
  } catch {
    result = null;
  }
  let pipeline = null;
  try {
    pipeline = JSON.parse(readFileSync(join(dir, "pipeline.json"), "utf8"));
  } catch {
    pipeline = null;
  }
  return {
    dir,
    stamp: basename(dir),
    target: targetName(lines),
    rounds: starts.length,
    answers: answers.length,
    pipelineSha: pipeline?.gitSha ?? null,
    status: result?.status ?? null,
    why: !existsSync(join(dir, "stages", "worklist.json"))
      ? "no stages/worklist.json — this run never reached stage 3, so there is no walk to replay"
      : !answers.length
        ? "no answers on disk — the expensive half of a replay is the half this run did not produce"
        : null,
  };
}

/* ------------------------------------------------------------- the pack under test */

/**
 * The tools a sandbox is built with: this checkout's `tools/`, or the same
 * directory as it stood at some revision.
 *
 * `git archive` and NOT `git worktree add`, which the workspace forbids outright,
 * and not a checkout either — this has to leave the tree it runs in untouched
 * while two container runs are writing to it. The result is a temp directory
 * holding `nodejs/tools` at that revision, and nothing else in the repo is read.
 */
export function packAtRevision(rev, dest, { root = REPO_ROOT_SELF } = {}) {
  mkdirSync(dest, { recursive: true });
  const archive = spawnSync("git", ["-C", root, "archive", rev, "nodejs/tools"], {
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (archive.status !== 0) {
    throw new Error(`git archive ${rev} failed — ${String(archive.stderr ?? "").trim() || `status ${archive.status}`}`);
  }
  const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (untar.status !== 0) throw new Error(`could not unpack ${rev} into ${dest}`);
  const tools = join(dest, "nodejs", "tools");
  if (!existsSync(join(tools, "scan.mjs"))) throw new Error(`${rev} carries no charpilot tools at nodejs/tools`);
  return tools;
}

/**
 * Lay the pack under test over an installed one.
 *
 * EXACTLY install.sh's two copy lines and no more — `*.mjs` plus `*.mts` into the
 * pack root (install.sh:239) and `steps/.` into `steps/` (install.sh:262). What is
 * deliberately NOT overwritten is everything install.sh GENERATES for a specific
 * repo: the vitest configs it rewrites, `docs/`, the skill. A pack overlay that
 * also replaced those would be testing this checkout's idea of location-ms rather
 * than location-ms.
 */
export function overlayPack(sandbox, tools) {
  const dest = join(sandbox, ".claude", "charpilot");
  for (const name of readdirSync(tools).sort()) {
    if (!/\.(mjs|mts)$/.test(name)) continue;
    cpSync(join(tools, name), join(dest, name));
  }
  const steps = join(tools, "steps");
  if (existsSync(steps)) {
    mkdirSync(join(dest, "steps"), { recursive: true });
    for (const name of readdirSync(steps).sort()) cpSync(join(steps, name), join(dest, "steps", name), { recursive: true });
  }
  return dest;
}

/* ------------------------------------------------- the istanbul report underneath */

/**
 * THE ONE ARTIFACT A RUN DIRECTORY DOES NOT CARRY, AND THE BRIEF IS BUILT ON IT.
 *
 * `worklist.mjs` reads `coverage-charpilot/coverage-final.json` twice
 * (worklist.mjs:313 `buildEntryIndex`, worklist.mjs:394 `buildStatementUnits`)
 * and `coverage-summary.json` once (worklist.mjs:1402), and `derive.run` spawns
 * it every round to get the skeleton. `finish.py` does not copy
 * `coverage-charpilot/` out of the container — `packetcost`'s NEVER_LINK skips
 * it too, for its own reason — so a replay has to take the istanbul report from
 * the checkout.
 *
 * WHICH ONE, AND WHY IT IS NOT A CONSTANT. A characterized checkout accumulates
 * several: location-ms holds seven `coverage*` directories, of which
 * `coverage-charpilot/` is the LATEST — 348 of 365 branch arms, a
 * post-characterization report — while the run this replays began from a
 * baseline of 221 of 367. Handing the brief the post report would tell the
 * skeleton that almost everything is already entered, which is the opposite of
 * the state the round loop is being replayed from. So the report is chosen by
 * comparing branch arms against the run's OWN `stages/baseline.json`, and the
 * comparison is printed: a reader sees which report was used and how far it is
 * from the run's, rather than finding out from a side count that does not match.
 */
export function branchArms(final) {
  let total = 0;
  let covered = 0;
  for (const entry of Object.values(final ?? {})) {
    for (const arms of Object.values(entry?.b ?? {})) {
      for (const hits of arms ?? []) {
        total += 1;
        if (hits > 0) covered += 1;
      }
    }
  }
  return { total, covered };
}

/** Every istanbul report in the checkout, with what each one measured. */
export function istanbulReports(repo) {
  const out = [];
  for (const name of readdirSync(repo).sort()) {
    if (!name.startsWith("coverage")) continue;
    const final = join(repo, name, "coverage-final.json");
    if (!existsSync(final)) continue;
    try {
      out.push({ dir: name, path: final, ...branchArms(JSON.parse(readFileSync(final, "utf8"))) });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The report nearest the run's own baseline, by branch arms.
 *
 * Total first and covered second: a report of a different SIZE is a report of a
 * different tree, which is a worse mismatch than a report of the same tree taken
 * at a different moment.
 */
export function pickReport(reports, baselineBranches) {
  if (!reports.length) return null;
  if (!baselineBranches) return reports[0];
  return [...reports].sort(
    (a, b) =>
      Math.abs(a.total - baselineBranches.total) - Math.abs(b.total - baselineBranches.total) ||
      Math.abs(a.covered - baselineBranches.covered) - Math.abs(b.covered - baselineBranches.covered)
  )[0];
}

/**
 * Copy one istanbul report into the sandbox, re-rooted.
 *
 * ISTANBUL KEYS BY ABSOLUTE PATH and `worklist.mjs` turns each key back into a
 * repo-relative one with `relative(REPO_ROOT, absPath)`. REPO_ROOT is the
 * sandbox, so a report copied verbatim yields keys like
 * `../../../qode-knowledge/repos/location-ms/src/env.ts` and joins to nothing —
 * silently, as an empty `entered` index rather than as an error. The prefix is
 * rewritten and nothing else is touched.
 *
 * THE SUMMARY IS DERIVED WHEN IT IS ABSENT, because `coverage-baseline-istanbul/`
 * carries only the detail file and worklist.mjs:1402 wants `total.branches`.
 * Istanbul's own summary is that sum, so this computes the sum rather than
 * inventing a number — and it writes nothing else into the summary, because
 * nothing else is read.
 */
export function installReport(report, repo, sandbox) {
  const dest = join(sandbox, "coverage-charpilot");
  mkdirSync(dest, { recursive: true });
  const reroot = (doc) =>
    Object.fromEntries(
      Object.entries(doc).map(([key, value]) => [
        key.startsWith(`${resolve(repo)}/`) ? join(sandbox, key.slice(resolve(repo).length + 1)) : key,
        value,
      ])
    );
  const final = reroot(JSON.parse(readFileSync(report.path, "utf8")));
  writeFileSync(join(dest, "coverage-final.json"), `${JSON.stringify(final)}\n`);
  const summaryFrom = join(dirname(report.path), "coverage-summary.json");
  if (existsSync(summaryFrom)) {
    writeFileSync(join(dest, "coverage-summary.json"), `${JSON.stringify(reroot(JSON.parse(readFileSync(summaryFrom, "utf8"))))}\n`);
  } else {
    const { total, covered } = branchArms(final);
    writeFileSync(
      join(dest, "coverage-summary.json"),
      `${JSON.stringify({ total: { branches: { total, covered, skipped: 0, pct: total ? Number(((covered / total) * 100).toFixed(2)) : 0 } } })}\n`
    );
  }
  return { dir: dest, ...branchArms(final) };
}

/* -------------------------------------------------------------------- the sandbox */

/**
 * `src/` AND `test/` AS THEY WERE AT THE RUN'S OWN COMMIT.
 *
 * THE DEFECT THIS EXISTS FOR, and it is the one that made the first full-order
 * replay meaningless. A characterized checkout has a
 * `test/characterization/` directory full of generated specs; the clone the
 * container made did not. `measure`'s precondition is "is there a `*.test.ts`
 * in `test/characterization`", so in the container it answered `nothing to bank
 * yet` and the banking visit was excused — and in a sandbox built from the
 * working tree it answered YES, ran `coverage.mjs`, and handed over a refusal
 * before `derive` had run once. Twelve replayed rounds, `open=148` unmoved in
 * every one, and not a single side derived: the replay was reporting the
 * checkout's history as the walk's behaviour.
 *
 * `src/` travels with it, because `scan.json` and `worklist.json` come from the
 * RUN and address functions by line. Reading them against a `src/` that has
 * moved is the same class of mistake one file over.
 *
 * `git archive` and not a checkout or a worktree: nothing is written into the
 * target, the workspace forbids `git worktree add` outright, and this tree has
 * two container runs live in it. If the commit is not in the checkout the
 * working tree is used and the caller is told which, because a replay against
 * a moved `src/` is still worth more than no replay — as long as nobody has to
 * guess which one they got.
 */
export function materialiseTree(repo, sha, trees, dest) {
  if (!sha) return { from: "working tree", why: "the run's artifacts record no git sha" };
  const archive = spawnSync("git", ["-C", repo, "archive", sha, ...trees], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) {
    return { from: "working tree", why: `${String(sha).slice(0, 8)} is not in this checkout — ${String(archive.stderr ?? "").trim().split("\n").slice(-1)[0]}` };
  }
  for (const tree of trees) rmSync(join(dest, tree), { recursive: true, force: true });
  const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
  if (untar.status !== 0) return { from: "working tree", why: `could not unpack ${sha} into the sandbox` };
  return { from: String(sha).slice(0, 8), why: null };
}

/**
 * A sandbox at the state stage 3 started from.
 *
 * `plan.links` and `plan.create` are `packetcost`'s, unchanged. `plan.copy` is
 * applied and then overlaid with the pack under test. `plan.relink` — the repo's
 * own `out/` — is DROPPED and replaced by the run's `stages/`, minus everything
 * stage 3 and later produced: those artifacts are what the replay is trying to
 * produce, and a seeded one is a question answered before it is asked.
 */
export function buildReplaySandbox({ repo, runDir, tools, dest }) {
  const no = refuseOverlap(repo, dest);
  if (no) throw new Error(no);
  rmSync(dest, { recursive: true, force: true });
  const plan = sandboxPlan(repo, dest);
  mkdirSync(join(dest, ".claude", "charpilot", "out"), { recursive: true });
  for (const c of plan.create) mkdirSync(c, { recursive: true });
  for (const { from, to } of plan.copy) cpSync(from, to, { recursive: true, dereference: true });
  // `test/` IS COPIED AND NOT LINKED. See the docblock: `emit` renders into
  // `test/characterization/` and `record` writes fixtures beside it, so the one
  // symlink that would let a replay write into the checkout is this one.
  for (const { from, to } of plan.links) {
    mkdirSync(dirname(to), { recursive: true });
    if (basename(to) === "test") cpSync(from, to, { recursive: true, dereference: true });
    // EVERY `coverage*` DIRECTORY STARTS EMPTY AND IS NEVER A LINK. `packetcost`
    // skips only `coverage-charpilot/` and skips it for size; a replay walks
    // stage 6, and `coverage.mjs:92` writes its report into
    // `coverage-charpilot-stage6/` — which arrives here as a symlink into the
    // checkout, so the one thing this sandbox exists to prevent would happen
    // through the directory nobody was watching. `coverage-charpilot/` is filled
    // below with the run's own baseline report; the rest are the checkout's
    // history and nothing in the walk reads them.
    else if (basename(to).startsWith("coverage")) mkdirSync(to, { recursive: true });
    else symlinkSync(from, to, lstatSync(from).isDirectory() ? "dir" : "file");
  }
  overlayPack(dest, tools);

  // THE TWO TREES THE RUN ADDRESSED, at the commit it addressed them at. See
  // `materialiseTree` for the twelve wasted rounds that bought this paragraph.
  const stages = join(runDir, "stages");
  let sha = null;
  try {
    sha = JSON.parse(readFileSync(join(stages, "scan.json"), "utf8"))?.gitSha ?? null;
  } catch {
    sha = null;
  }
  const source = materialiseTree(repo, sha, ["src", "test"], dest);
  // install.sh:327, AND ONLY WHEN IT IS ABSENT. The container installs the pack
  // into its clone before the first walk, and that install writes
  // `test/fixtures/doubles.ts` from the template when the repo has none — which
  // a clone at the run's commit does not. Without it the emitted suite cannot
  // import its doubles, which is a failure of this sandbox and not of the walk.
  const doubles = join(dest, "test", "fixtures", "doubles.ts");
  const stub = join(tools, "templates", "doubles.stub.ts");
  if (!existsSync(doubles) && existsSync(stub)) {
    mkdirSync(dirname(doubles), { recursive: true });
    cpSync(stub, doubles);
  }

  const out = join(dest, ".claude", "charpilot", "out");
  const seeded = [];
  const withheld = [];
  for (const name of existsSync(stages) ? readdirSync(stages).sort() : []) {
    if (producedByStageThree(name)) {
      withheld.push(name);
      continue;
    }
    cpSync(join(stages, name), join(out, name), { recursive: true });
    seeded.push(name);
  }
  // THE ONE ORDERING FACT `worklist.satisfied` RESTS ON: `out/worklist.json`
  // must be no older than `out/scan.json`, because a brief built before the scan
  // it was built from describes a repo that has since been re-read. A directory
  // copy makes both mtimes "now" in an order nobody controls, so the one the
  // predicate compares is stamped explicitly rather than left to readdir.
  const worklist = join(out, "worklist.json");
  if (existsSync(worklist)) {
    const now = new Date();
    utimesSync(worklist, now, now);
  }

  let baselineBranches = null;
  try {
    baselineBranches = JSON.parse(readFileSync(join(stages, "baseline.json"), "utf8"))?.coverage?.totals?.branches ?? null;
  } catch {
    baselineBranches = null;
  }
  const chosen = pickReport(istanbulReports(repo), baselineBranches);
  const report = chosen ? { ...chosen, ...installReport(chosen, repo, dest) } : null;
  return { plan, seeded, withheld, report, baselineBranches, source };
}

/* ------------------------------------------------------------------ the round loop */

/**
 * A NARROWED WALK, THROUGH THE WALK'S OWN OPTION AND NOT A NEW ONE.
 *
 * `workflow.walk` takes `order` and `steps/index.mjs` documents what a narrowed
 * one means — "a test's `order: [\"measure\"]`, or an installation narrowed to a
 * few steps" — so the banking splice, the clearing splice and the deferral all
 * already have a defined behaviour on a short list. This writes the four lines
 * that call it, into the SANDBOX so `config.mjs` resolves there, and is used
 * only when `--order` is given.
 *
 * WHY IT IS WORTH HAVING. The full ORDER runs `record` (a vitest pass per round)
 * and `measure` (a coverage pass), which is minutes; `--order
 * preflight,...,derive` answers "does this round loop terminate" in the time
 * `validate.mjs` takes. That is the mode D75 would have been caught in. It
 * answers NOTHING about reaching `repair`, `ruling` or `report`, which is the
 * full walk's question and is why the full walk is the default.
 */
export function writeOrderDriver(sandbox, order) {
  const path = join(sandbox, "replaywalk-order.mjs");
  const workflow = pathToFileURL(join(sandbox, ".claude", "charpilot", "workflow.mjs")).href;
  writeFileSync(
    path,
    [
      `import { walk } from ${JSON.stringify(workflow)};`,
      `const order = Object.freeze(${JSON.stringify(order)});`,
      `const out = await walk({ order });`,
      `if (out.reason) process.stderr.write(\`\\u2717 \${out.reason}\\n\`);`,
      `process.exit(out.code);`,
      "",
    ].join("\n")
  );
  return path;
}

/** Run the walk once, exactly as `docker/char/packs/nodejs.py` runs it. */
export function walkOnce(sandbox, { timeoutMs = 45 * 60 * 1000, env = process.env, driver = null } = {}) {
  const workflow = driver ?? join(sandbox, ".claude", "charpilot", "workflow.mjs");
  const at = Date.now();
  const res = spawnSync(process.execPath, [workflow, sandbox], {
    cwd: sandbox,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: timeoutMs,
    env,
  });
  return {
    status: res.status,
    seconds: Number(((Date.now() - at) / 1000).toFixed(1)),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    killed: Boolean(res.error && res.error.code === "ETIMEDOUT"),
    error: res.error ? String(res.error.message ?? res.error) : null,
  };
}

/**
 * The walk's own lines, in the shape `fleetwalk.parseWalk` reads.
 *
 * `parseWalk` recovers per-step wall time from the moment each line ARRIVED, and
 * a `spawnSync` has no such moments — the whole of stdout arrives at once. So
 * every line is stamped with the same instant and the `seconds` column that
 * comes back is zero for every step. That is the honest answer for a buffered
 * child, and it is why this tool reports the WALK's seconds and not the step's;
 * a fabricated per-step split would be the paraphrase this codebase refuses.
 */
export function walkEvents(stdout, at = 0) {
  return String(stdout)
    .split("\n")
    .filter((l) => l.length)
    .map((text) => ({ text, ms: at }));
}

/** How far down ORDER the walk reached, and what stopped it there. */
export function reachedThrough(steps, order = ORDER) {
  let furthest = null;
  for (const s of steps) {
    if (s.index < 0) continue;
    if (!furthest || s.index > furthest.index) furthest = s;
  }
  return {
    furthest: furthest?.step ?? null,
    furthestIndex: furthest ? order.indexOf(furthest.step) + 1 : 0,
    stepCount: order.length,
    reached: new Set(steps.map((s) => s.step)),
  };
}

/** Copy one round's recorded answers into the sandbox's answers directory. */
export function deliverAnswers(sandbox, runDir, names) {
  const dest = join(sandbox, "charpilot-answers");
  mkdirSync(dest, { recursive: true });
  const landed = [];
  for (const name of names ?? []) {
    const from = join(runDir, "answers", name);
    if (!existsSync(from)) continue;
    cpSync(from, join(dest, name));
    landed.push(name);
  }
  return landed;
}

/* ------------------------------------------------- why `derive.satisfied` said no */

/**
 * `derive.satisfied`, unrolled, asked of the SANDBOX's own pack.
 *
 * This runs in a child process with `cwd` at the sandbox, because config.mjs
 * bakes `OUT_DIR`, `PROPOSALS_DIR` and `WORKLIST_DECISIONS` from the CWD at
 * import. Every function it calls is imported from the pack under test, in the
 * order `satisfied` calls them, so what comes back is that predicate's reasoning
 * and not a second opinion about it. `satisfied` itself is called last and its
 * answer is reported beside the clause breakdown: if the two ever disagreed, the
 * unrolling is wrong and the disagreement is the finding.
 */
async function probe(sandbox) {
  const pilot = join(sandbox, ".claude", "charpilot");
  const derive = await import(pathToFileURL(join(pilot, "steps", "derive.mjs")).href);
  const paths = derive.toolPaths(sandbox);
  if (!existsSync(paths.worklistJson)) return { satisfied: false, clause: "worklist.json is absent" };

  const labelsByArm = labelsByArmFrom(paths.worklistJson);
  const judgement = derive.judgeProposals(sandbox, paths);
  const proposed = derive.proposedSides(paths.proposalsDir, labelsByArm, derive.allHeld(judgement));
  const declared = derive.declaredSides(paths.proposalsDir, labelsByArm);
  const asked = derive.handedOver(paths.handover);
  const submissions = derive.inspectSubmissions(paths, { labelsByArm, declared, proposed });
  const { open } = derive.openSides(JSON.parse(readFileSync(paths.worklistJson, "utf8")), {
    proposed,
    declared,
    undeliverable: derive.undeliverableIndex(paths.coverageJson),
  });

  const unaskedReady = submissions.ready.filter((r) => !asked.has(r.id));
  const unaskedProblems = submissions.problems.filter((p) => !asked.has(p.id));
  const kinds = {};
  for (const r of unaskedReady) kinds[r.kind ?? "proposal"] = (kinds[r.kind ?? "proposal"] ?? 0) + 1;

  let clause = null;
  if (unaskedReady.length) {
    clause =
      `${unaskedReady.length} materialisable submission(s) are not in the handover ` +
      `(${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}) — ` +
      `\`ready.every(asked.has)\` is false. First: ${unaskedReady[0].id}`;
  } else if (unaskedProblems.length) {
    clause = `${unaskedProblems.length} refused submission(s) are not in the handover. First: ${unaskedProblems[0].id}`;
  } else if (!derive.handedEverything(open, asked)) {
    clause = `${open.length} side(s) are open and not all of them are in the handover of ${asked.size} asked id(s)`;
  } else if (!existsSync(paths.tool("validate.mjs"))) {
    clause = "validate.mjs is not in this pack";
  } else if (!judgement.ran) {
    clause = "validate.mjs could not be run";
  } else if (judgement.status !== 0 && !(judgement.faults.length > 0 && judgement.unplaced.length === 0)) {
    clause = `validate.mjs exited ${judgement.status} with ${judgement.unplaced.length} fault(s) this step could not place`;
  }

  return {
    satisfied: derive.satisfied(sandbox),
    clause,
    open: open.length,
    asked: asked.size,
    ready: submissions.ready.length,
    readyUnasked: unaskedReady.length,
    readyKinds: kinds,
    problems: submissions.problems.length,
    problemsUnasked: unaskedProblems.length,
    validateStatus: judgement.status ?? null,
    quarantined: derive.allHeld(judgement)?.size ?? null,
  };
}

/** Ask the probe in a child whose CWD is the sandbox, and hand back its JSON. */
export function askProbe(sandbox) {
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--probe"], {
    cwd: sandbox,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CHARPILOT_SELF_ROOT: sandbox },
  });
  const line = String(res.stdout ?? "")
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  if (!line) return { satisfied: null, clause: `the probe said nothing — ${String(res.stderr ?? "").trim().split("\n").slice(-3).join(" ")}` };
  try {
    return JSON.parse(line);
  } catch (err) {
    return { satisfied: null, clause: `the probe's answer was not JSON — ${err.message}` };
  }
}

/* --------------------------------------------------------------------- the report */

/** One round's row, as the table prints it. */
export function roundLine(row) {
  const bits = [
    `round ${String(row.round).padStart(2)}`,
    `${String(row.seconds).padStart(7)}s`,
    `exit ${String(row.status).padStart(3)}`,
    `through ${String(row.furthest ?? "—").padEnd(12)}`,
    `open=${String(row.open ?? "?").padStart(3)}`,
    `ready=${String(row.ready ?? "?").padStart(3)}`,
    `problems=${String(row.problems ?? "?").padStart(2)}`,
    `asked=${String(row.asked ?? "?").padStart(3)}`,
    `handed=${String(row.handed ?? 0).padStart(3)}`,
    `answers+${String(row.delivered ?? 0).padStart(2)}`,
    `derive.satisfied=${row.satisfied === null ? "?" : row.satisfied ? "YES" : "no "}`,
    row.stopped ? "STOPPED-ASKING" : "",
  ];
  return `  ${bits.filter(Boolean).join("  ")}`;
}

/* ------------------------------------------------------------------------- main */

function resolveRepo(name) {
  const given = arg("--repo", null);
  if (given) return resolve(given);
  if (!name) throw new Error("this run's log does not name a service, so --repo is required");
  const repos = reposDir();
  if (!repos) throw new Error("no qode-knowledge/repos above this checkout — pass --repo <path>");
  const guess = join(repos, name);
  if (!existsSync(guess)) throw new Error(`no checkout of ${name} at ${guess} — pass --repo <path>`);
  return guess;
}

/**
 * REFUSED BEFORE A SANDBOX IS BUILT, NOT DISCOVERED HALFWAY THROUGH ONE.
 *
 * `qode-knowledge/repos/` holds a directory for every submodule and several of
 * them are uninitialised — `tracy-worker/` is empty on this machine, and
 * `20260919T092410Z` is a tracy-worker run with 109 recorded answers. Without
 * this the replay builds a sandbox out of nothing, the walk dies on
 * `config.mjs`'s "not a package root", and the tool reports it as `the probe
 * said nothing` — a sentence about this tool's plumbing standing in front of a
 * one-line fact about the checkout.
 */
export function unusableRepo(repo) {
  if (!existsSync(join(repo, "package.json"))) {
    return `${repo} holds no package.json. If it is a qode-knowledge submodule, it is not checked out — \`git submodule update --init\` it, or pass --repo at a checkout that is.`;
  }
  if (!existsSync(join(repo, "node_modules"))) {
    return `${repo} has no node_modules, and the walk spawns this repo's own vitest and ts-morph. Install its dependencies, or pass --repo at a checkout that has them.`;
  }
  return null;
}

function listRuns() {
  if (!existsSync(RUNS_DIR)) {
    log(`no runs under ${RUNS_DIR}`);
    return;
  }
  log("");
  log(`  ${"run".padEnd(18)}${"service".padEnd(16)}${"rounds".padEnd(8)}${"answers".padEnd(9)}${"status".padEnd(10)}why not`);
  for (const stamp of readdirSync(RUNS_DIR).sort()) {
    const s = surveyRun(join(RUNS_DIR, stamp));
    log(
      `  ${s.stamp.padEnd(18)}${String(s.target ?? "—").padEnd(16)}${String(s.rounds).padEnd(8)}` +
        `${String(s.answers).padEnd(9)}${String(s.status ?? "—").padEnd(10)}${s.why ?? ""}`
    );
  }
  log("");
}

async function main() {
  if (flag("--probe")) {
    process.stdout.write(`${JSON.stringify(await probe(process.cwd()))}\n`);
    return;
  }
  if (flag("--runs")) return listRuns();

  const runDir = resolve(arg("--run", "") || "");
  if (!runDir || !existsSync(runDir)) throw new Error("--run <docker/runs/<stamp>> is required; `--runs` lists what is replayable");
  const survey = surveyRun(runDir);
  if (survey.why) throw new Error(`${survey.stamp}: ${survey.why}`);

  const repo = resolveRepo(survey.target);
  const unusable = unusableRepo(repo);
  if (unusable) throw new Error(unusable);
  // REALPATH, AND IT IS NOT TIDINESS. On macOS `tmpdir()` is `/var/folders/…`,
  // a symlink to `/private/var/folders/…`, and a child's `process.cwd()` reports
  // the resolved one. `config.mjs` takes REPO_ROOT from that CWD, so every path
  // the pack computes is under `/private/var`, while anything this process built
  // from the unresolved name is under `/var` — and the two meet in
  // `relative(REPO_ROOT, absPath)` inside `worklist.mjs`, where the mismatch is
  // silent: the istanbul join simply finds nothing.
  const work = resolve(arg("--work", DEFAULT_WORK));
  mkdirSync(work, { recursive: true });
  const sandbox = join(realpathSync(work), `${survey.stamp}-${arg("--pack-rev", "HEAD").replace(/[^A-Za-z0-9]/g, "")}`);
  const maxRounds = Math.max(1, Number(arg("--rounds", DEFAULT_ROUNDS)));
  const order = arg("--order", null);
  const timeoutMs = Math.max(60, Number(arg("--round-timeout", 2700))) * 1000;

  let tools = PILOT_DIR;
  let packLabel = "this checkout";
  const rev = arg("--pack-rev", null);
  if (rev) {
    tools = packAtRevision(rev, join(work, `pack-${rev.replace(/[^A-Za-z0-9]/g, "")}`));
    packLabel = rev;
  }

  log("");
  log(`  replaying ${survey.stamp} — ${survey.target}, ${survey.rounds} recorded round(s), ${survey.answers} answer file(s)`);
  log(`  that run ended: ${survey.status ?? "no result.json"} · pipeline ${String(survey.pipelineSha ?? "?").slice(0, 8)}`);
  log(`  pack under test: ${packLabel} (${tools})`);
  log(`  sandbox: ${sandbox}`);

  const built = buildReplaySandbox({ repo, runDir, tools, dest: sandbox });
  log(`  src/ and test/: ${built.source.from}${built.source.why ? ` — ${built.source.why}` : ""}`);
  log(`  seeded out/: ${built.seeded.join(", ")}`);
  log(
    built.report
      ? `  istanbul report: ${built.report.dir}/coverage-final.json — ${built.report.covered}/${built.report.total} branch arms, ` +
          `against this run's baseline of ${built.baselineBranches?.covered ?? "?"}/${built.baselineBranches?.total ?? "?"}`
      : "  istanbul report: none in this checkout — worklist.mjs will refuse and derive cannot build a brief"
  );
  log(`  withheld (stage 3 and later): ${built.withheld.join(", ") || "nothing"}`);

  const lines = readRunLog(join(runDir, "log.jsonl"));
  const slices = sliceByRound(recordedAnswers(join(runDir, "answers")), roundStarts(lines));
  log(`  answers per recorded round: ${slices.map((s) => s.length).join(", ")}`);
  log("");

  // THE RUN'S OWN MODE, off its own second log line, and never a default chosen
  // here. `CHARPILOT_MODE=mocked` and `=live` record different artifacts —
  // `record.recordedArtifact()` resolves `behaviour-live.json` for one and
  // `behaviour.json` for the other — so a replay that picked the wrong one would
  // be walking a different pipeline from the run it claims to be replaying.
  const env = { ...process.env };
  for (const ev of lines) {
    const m = /^CHARPILOT_MODE=(\S+)/.exec(String(ev.msg ?? ""));
    if (m) env.CHARPILOT_MODE = m[1];
  }
  // ANYTHING ELSE THE OPERATOR WANTS THE WALK TO SEE, by its own name.
  //
  // `--env CHARPILOT_YIELD_RATCHET=off` is the one this tool was built needing.
  // The yield ratchet is a real stop and a replay reproduces it faithfully — two
  // rounds in a row closing no side, judged on sides and never on the clock — but
  // it is a stop about whether ANOTHER ROUND IS WORTH BUYING, and it ends the
  // asking before a termination defect downstream of it can be reached. On
  // `20260920T030124Z` it fires at replay round 4 on BOTH packs and hides the D75
  // difference behind an identical exit 0. Switching it off is how the replay is
  // asked the other question: if nothing stopped the asking, would this round
  // loop ever end? Named rather than defaulted, because a default here would be
  // this tool quietly deciding which of the walk's endings count.
  for (const pair of ARGV.filter((a, i) => ARGV[i - 1] === "--env")) {
    const at = pair.indexOf("=");
    if (at > 0) {
      env[pair.slice(0, at)] = pair.slice(at + 1);
      log(`  env: ${pair}`);
    }
  }
  const driver = order ? writeOrderDriver(sandbox, order.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  if (driver) log(`  narrowed order: ${order} (through workflow.walk's own \`order\` option)`);
  log(`  mode: ${env.CHARPILOT_MODE ?? "(the pack's default)"}`);

  const rows = [];
  let ending = null;
  for (let round = 1; round <= maxRounds; round++) {
    const walked = walkOnce(sandbox, { timeoutMs, env, driver });
    const steps = parseWalk(walkEvents(walked.stdout));
    const far = reachedThrough(steps);
    const handover = steps.find((s) => s.outcome === "handover");
    // NOT AFTER AN EXIT 0, AND THE REASON IS THE LAST LINE OF `walkSteps`. A walk
    // that satisfies every step ends with `clearWorklist(worklist)`, so the
    // handover the predicate reads is gone by the time a probe could run and
    // `handedEverything(open, asked)` is false over an empty `asked` for any
    // side still open-but-already-asked. The probe would report `no` about a
    // walk that had just answered `yes`, which is a disagreement between this
    // tool and the walk and not a fact about the run. On every other ending the
    // handover is on disk and the probe is the predicate, unrolled.
    const d = walked.status === EXIT_OK ? { satisfied: true, clause: null, afterClear: true } : askProbe(sandbox);

    const slice = slices[round - 1] ?? null;
    const exhausted = slice === null;
    const delivered = walked.status === EXIT_NEEDS_DECISION ? deliverAnswers(sandbox, runDir, slice ?? []) : [];

    const row = {
      round,
      status: walked.status,
      seconds: walked.seconds,
      furthest: far.furthest,
      furthestIndex: far.furthestIndex,
      steps: steps.map((s) => ({ step: s.step, outcome: s.outcome })),
      handed: handover ? handover.asked.length : 0,
      handedBy: handover?.step ?? null,
      // A DELIBERATE END TO THE ASKING IS NOT THE SAME ENDING AS A SATISFIED
      // PREDICATE, and both print `every step satisfied` and exit 0. `derive`
      // stops when the yield collapses and the walk carries on through the steps
      // after it; a replay that reported only the exit code would call that
      // "terminated" beside a run whose `satisfied` actually went true, which is
      // the one distinction this tool exists to draw.
      stopped: walked.stdout.split("\n").some((l) => /^[a-z]+: STOPPING — /.test(l)),
      satisfied: d.satisfied,
      clause: d.clause ?? null,
      open: d.open,
      ready: d.ready,
      problems: d.problems,
      asked: d.asked,
      delivered: delivered.length,
      exhausted,
      // THE WALK'S OWN LAST WORDS, and they are on BOTH pipes: `workflow.mjs`
      // prints its salvage line to stdout and the refusal that killed the round
      // to stderr, so a reader of one gets the recovery without the reason or
      // the reason without the recovery.
      reason: `${walked.stdout}\n${walked.stderr}`.split("\n").filter((l) => l.startsWith("✗") || l.startsWith("walk: ")).slice(-2),
    };
    rows.push(row);
    log(roundLine(row));
    if (flag("--verbose")) for (const l of walked.stdout.split("\n")) if (l.length) log(`      | ${l}`);
    if (row.clause) log(`      derive said no because: ${row.clause}`);
    for (const r of row.reason) log(`      ${r}`);
    if (exhausted && walked.status === EXIT_NEEDS_DECISION) {
      log("      RECORDING EXHAUSTED — the original run wrote no more answers, so from here the replay's agent is silent");
    }

    if (walked.status === EXIT_OK) {
      ending = { kind: row.stopped ? "stopped-asking" : "terminated", round };
      break;
    }
    if (walked.status !== EXIT_NEEDS_DECISION) {
      ending = { kind: "failed", round, status: walked.status };
      break;
    }
    if (exhausted && !delivered.length) {
      // TWO IDENTICAL EMPTY ROUNDS AND NOT ONE. A round whose answers were
      // exhausted may still make progress — the walk banks what the last round
      // answered before it asks again — so the first silent round is not
      // evidence of anything. The second one, asking the same question over the
      // same disk, is the loop.
      const prior = rows[rows.length - 2];
      if (prior?.exhausted && prior.handed === row.handed && prior.clause === row.clause) {
        ending = { kind: "exhausted", round };
        break;
      }
    }
  }
  if (!ending) ending = { kind: "cap", round: maxRounds };

  const last = rows[rows.length - 1];
  const reached = new Set(rows.flatMap((r) => r.steps.map((s) => s.step)));
  log("");
  log(`  ENDED: ${ending.kind} at round ${ending.round}`);
  log(`  furthest step any round reached: ${last.furthest ?? "—"} (${last.furthestIndex} of ${ORDER.length})`);
  log(`  steps that never ran: ${ORDER.filter((s) => !reached.has(s)).join(", ") || "none"}`);
  // THE QUESTION THE WHOLE TOOL WAS BUILT TO ASK, and it is not "is there a
  // result.json". There is nearly always one: `workflow.walk` salvages a partial
  // through `report.mjs` on every non-zero ending, and it stamps `salvagedBy`.
  // A result written THROUGH the walk is one the `report` step wrote, and no run
  // in this project's history has produced one — so the distinction is the
  // finding, and a line that printed the document without drawing it would read
  // as the opposite answer.
  const result = join(sandbox, ".claude", "charpilot", "out", "result.json");
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(result, "utf8"));
  } catch {
    doc = null;
  }
  log(
    doc === null
      ? "  result.json: never written"
      : doc.partial?.salvagedBy
        ? `  result.json: SALVAGED by ${doc.partial.salvagedBy} at step \`${doc.partial.step}\` — status ${doc.status}, ` +
          `coverage_percentage ${JSON.stringify(doc.coverage_percentage)}. The \`report\` step did not write it.`
        : `  result.json: WRITTEN THROUGH THE WALK — status ${doc.status}, coverage_percentage ${JSON.stringify(doc.coverage_percentage)}`
  );
  log(`  reached \`report\`: ${reached.has("report") ? "YES" : "no"} · reached \`ruling\`: ${reached.has("ruling") ? "YES" : "no"} · reached \`repair\`: ${reached.has("repair") ? "YES" : "no"}`);

  const rowsDir = resolve(PILOT_DIR, "..", "out", "replaywalk");
  mkdirSync(rowsDir, { recursive: true });
  const rowPath = join(rowsDir, `${survey.stamp}-${packLabel.replace(/[^A-Za-z0-9]/g, "")}.json`);
  writeFileSync(
    rowPath,
    `${JSON.stringify({ at: Date.now(), run: survey.stamp, target: survey.target, pack: packLabel, order: order ?? null, ending, rows }, null, 2)}\n`
  );
  log(`  rows: ${relative(REPO_ROOT_SELF, rowPath)}`);
  if (!flag("--keep")) rmSync(sandbox, { recursive: true, force: true });
  else log(`  kept: ${sandbox}`);
  log("");
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`✗ replaywalk: ${e?.message ?? e}\n`);
    process.exit(1);
  });
}
