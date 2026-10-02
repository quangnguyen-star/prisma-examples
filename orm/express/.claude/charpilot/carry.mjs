/**
 * carry.mjs — which packets a cut-off worker was holding, and what they get next.
 *
 * PLAN 20, T2.1, ON BY DEFAULT since the nginx A/B (run 20260924T091852Z); CHARPILOT_CARRY_CUTOFF=off is the
 * rollback. Built on two things that ship before it:
 *
 *   - the pack's per-round banking (`out/rounds/index-<n>.json`, the round's
 *     deal, and `out/rounds/workers-<n>.json`, each launch's packet files and
 *     whether it was still out when the turn ended), and
 *   - P1, write-as-you-go, so a cut-off worker has banked the sides it did and
 *     only the rest of its packet is still open.
 *
 * WHAT A CARRIED PACKET GETS, and why each is there:
 *
 *   MORE TIME, NOT THE SAME TIME. Its deadline is the base worker deadline
 *   doubled for every consecutive round it was cut off in, capped at the round
 *   wall less a margin. The cap is the answer to the design's Q3: a deadline past
 *   the wall is a deadline the wall enforces first, and a longer wall for one
 *   packet is a longer round for every other worker.
 *
 *   FIRST AND ALONE. `queuePackets` puts it at the front of the queue as its own
 *   entry, so it has the whole round.
 *
 *   CUT OFF TWICE IS A VISIBLE EXCEPTION. After CARRY_LIMIT consecutive cut-offs
 *   it is not dealt again on the same terms: its open sides are ruled `open`
 *   ("cut off N times at M min") through the same salvage ruling T2.3 uses, and
 *   stay in the denominator. Never dropped silently.
 *
 * The weight term in the design's formula (`clamp(weight)/k`) is left out on
 * purpose: `k` was to be set from live per-worker timing (T0.2b), which no run
 * has produced yet, and a constant guessed here would be the "number with a
 * p95 painted on it" plan 15 warns about.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export const CARRY_LIMIT = 2;
export const WALL_MARGIN_MIN = 10;

export const carryOn = (env = process.env) => env.CHARPILOT_CARRY_CUTOFF !== "off";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The banked round numbers, newest first. */
export function bankedRounds(outDir) {
  const dir = join(outDir, "rounds");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^workers-(\d+)\.json$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => b - a);
}

/** Packet ids a round's cut-off workers were holding. */
export function cutOffIds(outDir, n) {
  const workers = readJson(join(outDir, "rounds", `workers-${n}.json`))?.workers ?? [];
  const index = readJson(join(outDir, "rounds", `index-${n}.json`));
  const byFile = new Map((index?.packets ?? []).map((p) => [basename(String(p.file ?? "")), p]));
  const out = new Map();
  for (const w of workers) {
    if (!w?.cut_off) continue;
    for (const f of w.packets ?? []) {
      const p = byFile.get(basename(f));
      if (p?.id) out.set(p.id, p);
    }
  }
  return out;
}

/**
 * Map packet id -> { times, deadlineMinutes, limitReached, sides } for every
 * packet a worker was cut off holding in the latest banked round, with `times`
 * the consecutive rounds (ending there) it was cut off in.
 */
export function carriedPackets(outDir, { baseMin = 60, roundWallMin = 90 } = {}) {
  const rounds = bankedRounds(outDir);
  if (!rounds.length) return new Map();
  const latest = cutOffIds(outDir, rounds[0]);
  const out = new Map();
  const cap = Math.max(1, roundWallMin - WALL_MARGIN_MIN);
  for (const [id, packet] of latest) {
    let times = 1;
    for (let i = 1; i < rounds.length && rounds[i] === rounds[i - 1] - 1; i++) {
      if (!cutOffIds(outDir, rounds[i]).has(id)) break;
      times += 1;
    }
    out.set(id, {
      times,
      deadlineMinutes: Math.min(baseMin * 2 ** times, cap),
      limitReached: times >= CARRY_LIMIT,
      sides: packet.sides ?? [],
    });
  }
  return out;
}

/** What the carried packet's header says, once, at the top of its file. */
export function carriedBlock(carry) {
  return {
    times: carry.times,
    deadlineMinutes: carry.deadlineMinutes,
    says:
      `THIS PACKET WAS CUT OFF ${carry.times} ROUND(S) RUNNING: the worker holding it was still working when the ` +
      `round ended. What it had written is banked; the sides below are the ones it had not reached. It is dealt FIRST ` +
      `and ALONE this round, and its worker has ${carry.deadlineMinutes} minutes, not the usual deadline. Write as you ` +
      `go, so whatever you finish is kept even if the round ends again.`,
  };
}
