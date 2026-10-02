/**
 * sweep — the cheap pass, before the agent reads anything.
 *
 * TWO VISITS, and the split is what makes it cheap. The first asks the agent
 * ONE question it can answer from signatures alone: what values does a
 * parameter of this name and this type take? The second spends no agent turn at
 * all — it builds the cross product, runs it through `record.mjs`, and keeps the
 * sides that MOVED.
 *
 *   visit 1   out/sweep-domain.json absent  ->  pending: the domain brief
 *   visit 2   it is there                   ->  generate, record, harvest
 *
 * MEASURED BY HAND on notification-ms before this was wired, which is why it
 * was worth wiring:
 *
 *   domain ask (subagent, names and types only)   2m 14s   58,558 tokens
 *   297 rows generated                            validate: errors 0
 *   the sweep itself                              20 seconds
 *   open sides lit                                23 of 199 = 11.6%
 *   claims FALSE                                  0, and 0 claimed
 *
 * Against that run's own derive round 1: 2,832 seconds and 120,171,070
 * cache-read for 108 sides. The ask is ~2,050x fewer tokens; the sweep is CPU
 * and no model at all. `frontdoor.mjs` answers 0.27% of instrumented open sides
 * by RULE and refuses on doubt; this guesses from a name and lets the
 * measurement decide, which is 43x more of them.
 *
 * NOTHING HERE CLAIMS. Candidates carry no `reaches`. Only `armsMoved` becomes
 * a claim, so the failure that put notification-ms at 42.9% false — a claim
 * written before the input was ever run — cannot occur on this path.
 *
 * WHY IT RUNS BEFORE `derive` AND NOT INSTEAD OF IT. It answers the sides a
 * name can answer and no others: 164 of 461 candidate rows on notification-ms
 * are functions with NO OWN ENTRY, where reaching the arm means driving the
 * caller with the caller's parameters. Those, and every side the sweep does not
 * light, go to `derive` unchanged. This step removes work from the agent's
 * round; it does not replace the round.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OUT_DIR, REPO_ROOT, WORKLIST_JSON } from "../config.mjs";
import { domainBrief } from "../sweep.mjs";
import { ANSWERS_DIRNAME } from "./handover.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "sweep";

export const DOMAIN_BASENAME = "sweep-domain.json";
/**
 * WHERE THE AGENT WRITES IT, and it is not under `.claude/`.
 *
 * Run `20260921T114243Z` was killed four minutes in because this named
 * `out/sweep-domain.json`: every packet's `answers` block tells the agent it
 * never writes under `.claude/`, so the ask contradicted the rule it had been
 * given on every other item, and it went looking through the pipeline's own
 * source and the skills for an explanation that did not exist.
 */
export const SWEEP_DOMAIN = join(REPO_ROOT, ANSWERS_DIRNAME, DOMAIN_BASENAME);
export const SWEEP_DOMAIN_LEGACY = join(OUT_DIR, DOMAIN_BASENAME);
export const SWEEP_JSON = join(OUT_DIR, "sweep.json");

const read = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

export function precondition(_repo) {
  if (!existsSync(WORKLIST_JSON)) {
    return `no work list at ${here(WORKLIST_JSON)} — the sweep aims at open sides, so derive the list first`;
  }
  return null;
}

/**
 * Satisfied when the sweep has REPORTED, and a report with nothing in it counts.
 *
 * A sweep that lit no side is a finished sweep, not a pending one: the domain
 * had nothing for those sides and `sweep.mjs --harvest` says which. Re-running
 * it would spend the same executions for the same nothing — the reason this is
 * one full pass and not a per-round one.
 */
export function satisfied(_repo) {
  return existsSync(SWEEP_JSON);
}

/**
 * READS AND SPAWNS, AND WRITES NOTHING — `steps.never-repair-a-tools-output`.
 *
 * The first version of this step wrote `out/sweep.json` and the candidate rows
 * itself and that suite caught it: a step that writes can repair a tool's
 * output instead of refusing on it, and its `satisfied` then reads its own
 * writing back. Every write is `sweep.mjs`'s, spawned through `runTool`, and
 * this file only decides WHICH of the two visits this is.
 */
export function run(_repo) {
  const did = [];
  const items = read(WORKLIST_JSON)?.items ?? [];
  const brief = domainBrief(items);

  // VISIT 1 — the one question, asked only when a name could answer something.
  if (!existsSync(SWEEP_DOMAIN) && !existsSync(SWEEP_DOMAIN_LEGACY) && brief.length) {
    // COUNTED BY THE TOOL, because an unanswered ask must not repeat for ever.
    // `satisfied` is "out/sweep.json exists", so a domain that never arrives
    // means the walk asks again every round and never reaches `derive`. Past
    // `CHARPILOT_SWEEP_ASKS` the tool writes the report itself and says it was
    // skipped: the domain is an optimisation, and a run without it is the run
    // this pipeline already had.
    const counted = runTool("sweep", ["--asked"]);
    if (counted.line) did.push(counted.line);
    if (existsSync(SWEEP_JSON)) {
      did.push("the value domain was asked for and never written, so the sweep is skipped and derive gets every side");
      return { did, pending: [], metrics: { sweptSides: 0, lit: 0 } };
    }
    did.push(
      `${brief.length} distinct parameter name+type pair(s) gate ` +
        `${brief.reduce((n, r) => n + r.sides, 0)} open side slot(s) — asking once per pair, not once per function`
    );
    return {
      did,
      pending: [
        {
          id: "sweep-domain",
          says:
            `Write ${ANSWERS_DIRNAME}/${DOMAIN_BASENAME} — the same directory every other submission goes in, and ` +
            `NOT under \`.claude/\`. Shape: {"domain":[{"name","type","values":[...]}]}, one entry per pair below, ` +
            `3-6 values each, \`type\` copied verbatim so the entry can be matched back.\n\n` +
            `WHAT THIS IS, so nothing has to be looked up: a value SWEEP. These values are run against the open ` +
            `sides by a tool, and the arms they are measured to move become the coverage. It is not stage 3 and it ` +
            `is not a proposal — write no \`reaches\`, no \`covers\`, no \`invoke\`, and do not read the service's ` +
            `source for this. Judge from the NAME and the TYPE alone; that is what makes it cheap.\n\n` +
            `Include the degenerate and boundary cases (null, "__undefined__" for undefined, "", 0, [], {}, a value ` +
            `that fails a schema, a value of the wrong shape) beside one or two ordinary ones — those are what ` +
            `steer an arm. For an object-ish type give a small plain-object literal with only the fields the name ` +
            `implies. Nothing here is a claim: a value that lights nothing costs 19 milliseconds, so guess freely.`,
          brief: brief.map((r) => ({
            name: r.name,
            type: r.type,
            optional: r.optional,
            sidesWaiting: r.sides,
            functions: r.functions,
          })),
        },
      ],
      metrics: { domainPairs: brief.length },
    };
  }

  // VISIT 2 — the tool generates, records and harvests. Also the path taken
  // when no open side has a named parameter, so the tool writes the report that
  // says so rather than this step deciding it is finished.
  const outcome = runTool("sweep", ["--harvest"]);
  if (outcome.line) did.push(outcome.line);
  const report = read(SWEEP_JSON);
  if (report) {
    did.push(
      `swept ${report.candidates ?? 0} row(s) over ${report.recorded ?? 0} recording(s) and lit ` +
        `${(report.closedOpen ?? []).length} open side(s) — every one measured, none claimed, so none of them ` +
        `can be a FALSE claim`
    );
  }
  return {
    did,
    pending: [],
    metrics: { sweptSides: report?.candidates ?? 0, lit: (report?.closedOpen ?? []).length },
  };
}
