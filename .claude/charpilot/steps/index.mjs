/**
 * The step contract, and the order the steps run in.
 *
 * charpilot has 29 tools and, until this directory existed, nothing that put
 * them in order — so the agent was the orchestrator, and an orchestrator has to
 * read every tool's contract before it can call one. Measured on run
 * `20260916T031317Z`: 193 calls and 55.4 minutes spent reading charpilot's own
 * source, 25.6% of that run, for a decision count of zero. The order is the thing being moved out of prose and into code.
 *
 * Each step module exports:
 *
 *   NAME                what the log calls it
 *   precondition(repo)  the reason it cannot run yet, or null
 *   satisfied(repo)     whether it has already been done
 *   run(repo)           do it, and report what could not be decided
 *
 * `satisfied` is answered FROM THE FILESYSTEM and never from a state file.
 * That is what makes the walk resumable: "does out/baseline.json exist and
 * carry a denominator" is a question the disk answers, so a re-invocation skips
 * what is done instead of redoing it, and nothing can go stale or disagree with
 * reality. The python pack's docstring records two runs that lost everything
 * they had built because nothing could pick up where they stopped.
 *
 * `run` returns `{ did, pending, metrics }`. The `pending` half is the point of
 * the design — an enumerable list of open questions, so the agent answers items
 * rather than re-deriving a procedure, and so a run can report how many
 * decisions it actually needed.
 *
 * ONE FILE PER STEP, for two reasons. The later build steps fill these in
 * separately and must not queue behind each other on one file;
 * and three of the six mechanisms added on 2026-09-15 were defective on first
 * write, each of them a new refusal that refused the wrong thing, so a step
 * arrives on its own and is exercised on its own.
 */

/**
 * The order, which is the whole point of this directory existing.
 *
 * `derive` and `repair` are the two agentic phases — generating an input and
 * reassessing a recorded pair are semantic judgements a dictionary cannot make. Everything else runs without an agent.
 */
export const ORDER = Object.freeze([
  "preflight",
  "stagingenv",
  "baseline",
  "scan",
  "deadcode",
  "worklist",
  "vocabulary",
  // BEFORE `derive`, AND NOT INSTEAD OF IT. `sweep` answers the sides a
  // parameter's NAME can answer -- measured by hand on notification-ms at 23 of
  // 199 open sides, in 20 seconds of CPU and no model tokens at all, against
  // that run's derive round 1 of 2,832 seconds and 120,171,070 cache-read. The
  // sides it does not light reach `derive` unchanged, so this shrinks the
  // agent's round and never replaces it.
  //
  // IT IS TWO VISITS. The first spends one cheap agent turn on the value
  // domain, from signatures only; the second spends none. A step that asked for
  // nothing would have to guess the values, which is the fabrication the whole
  // pipeline refuses.
  "sweep",
  "derive",
  "record",
  // BETWEEN THE RECORDING AND THE EMISSION, and the walk went without it until
  // run 20260916T194950Z died on the gap: 146 sides accounted for, behaviour.json
  // written, and then `emit` exited 1 at 147 minutes with no coverage number,
  // because record.mjs:1949 will not assert a value byte-exactly without a
  // second observation saying that value is the same twice. The old shape had
  // one agent driving all 29 tools and it ran determinism.mjs itself; the walk
  // has no agent to remember.
  "determinism",
  "emit",
  "measure",
  "repair",
  "ruling",
  "report",
]);

/* --------------------------------------------------------------------------
 * TWO SUBSETS OF THE ORDER ABOVE, SO THE WALK CAN BANK A ROUND BEFORE IT HANDS
 * THE NEXT ONE OVER.
 *
 * WHAT THE WALK USED TO DO. It ran ORDER straight through and stopped at the
 * first step that was not satisfied. `derive` is not satisfied until every open
 * side has been handed over, and it ends its round by handing one over — so on
 * any repo larger than one batch the walk exited at `derive` every single round
 * and never reached the step after it.
 *
 * WHAT THAT COST, read off plan 13's D45 table
 * (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`) for run
 * `20260918T164503Z` (tracy-worker, six hours, $225.19) — that run's directory
 * is gone, so the table is where these figures can be checked and the only
 * place they can: nine rounds, 626 of 754 sides answered — 83% of stage 3 — and
 * `record`, `determinism`, `emit`, `measure`, `repair`, `ruling` and `report`
 * never ran once. 581 proposals sat on disk for nine rounds and nothing
 * recorded one of them; `result.json` read `coverage_percentage: null`. 83% of
 * stage 3 was worth exactly what 0% is worth.
 *
 * WHY THE DEFECT IS AN ORDERING ONE AND NOTHING ELSE. `repair` also hands over
 * sides and never had this problem, because `record` comes BEFORE `repair`: the
 * round after a repair round begins by recording what the repair answered.
 * `derive` sits before `record`, so nothing ever banked what a derive round
 * answered. These two lists give `derive` what `repair` already had.
 *
 * `BANKS` is the steps that turn answers already on disk into measured
 * coverage, and nothing else — they spawn no agent, they ask nothing, and each
 * one is a no-op on a round that answered nothing, because every `satisfied`
 * here is answered from the filesystem. `HANDS_OVER_A_ROUND` is the steps that
 * end a walk by asking a question. `repair` is in the second list and has no
 * banking step after it in ORDER, so naming it changes nothing today; it is
 * named because the rule is about the SHAPE of a step, and a reader who finds
 * only `derive` here would reasonably conclude the rule is about `derive`.
 * ------------------------------------------------------------------------ */

/** The steps that turn what is already answered into recorded, measured coverage. */
export const BANKS = Object.freeze(["record", "determinism", "emit", "measure"]);

/** The steps that end a walk by handing a round of sides to an answering turn. */
export const HANDS_OVER_A_ROUND = Object.freeze(["derive", "repair"]);

/* --------------------------------------------------------------------------
 * D60 — A THIRD SUBSET, AND IT IS THE ONE THE ORDER ABOVE GETS WRONG.
 *
 * `repair` is ORDER[13]. `measure` is ORDER[12] and `derive` is ORDER[7], and
 * BOTH of them end a walk before ORDER[13] is reached — `derive` by handing
 * over every round in which a side is open, `measure` by handing over its
 * refusal. So `repair` runs only in the narrow window where `derive` is
 * satisfied AND `measure` passed.
 *
 * WHAT THAT COST, counted over every run in `docker/runs` on this machine:
 * `repair` has printed ZERO step lines in the five container runs against a
 * real service. Not once on qode-ptp-ms (7 rounds), tracy-worker (2 and 5), or
 * location-ms (4 and 9) — and `ruling` and `report` are behind it, so none of
 * those runs wrote a `result.json` either. Run
 * `20260919T104903Z` is the clearest instance: its rounds 3 and 5 both died in
 * `measure` on `googleMap.service.ts#355:binary-expr:0` with byte-identical
 * text, and `repair.withdrawFalseClaims` — which withdraws exactly that claim
 * by spawning `propose.mjs --withdraw` — sat two steps away and never ran.
 *
 * AND IT IS WHERE THE COVERAGE NUMBER COMES FROM. `repair.mjs`'s own header:
 * run `20260916T024808Z` checked nine claims without reassessment and reported
 * 62.7% against a 60.21% baseline; the run that did reassess reached 96.7%. A
 * run whose `measure` ever refuses never repairs and never reaches its real
 * number.
 *
 * THE FIX IS THE BANKING SPLICE, POINTED THE OTHER WAY, and it moves nothing
 * in ORDER — see `workflow.walkSteps`. Banking says "a step that is about to
 * ASK first runs the steps that BANK what is already answered". This says "a
 * step whose refusal another step exists to CLEAR first runs that step, and is
 * then asked again over what it left behind". Same queue, same splice, same
 * one implementation of "run a step".
 *
 * WHY A MAP AND NOT A REORDER. `repair` cannot move ahead of `measure`: its
 * `precondition` is `measure`'s own `unjudgeable()` and it reads
 * `out/coverage.json`, so it has nothing to reassess until the measurement has
 * been taken. The defect is not that the order is wrong, it is that the order
 * is only ever walked to its end on a round that needed nothing from the end.
 *
 * THE WALK REQUIRES BOTH HALVES, and neither alone is enough. This map says
 * WHICH step may clear which — a static fact about shape, beside the other two
 * lists a reader comes here for. The refusing step says on its own result
 * whether THIS refusal is one that step can clear (`clearableBy`), because
 * only it can tell a false claim, which `repair` withdraws, from a failing
 * suite, which it must not touch — a measurement taken while tests were
 * failing is an overstatement and a claim called false against it is not
 * evidence (see `steps/measure.mjs`). A step may therefore not nominate an
 * arbitrary step, and a clearing that is spelled in only one of the two places
 * is dead rather than dangerous.
 * ------------------------------------------------------------------------ */

/** Whose refusal which later step exists to clear. One entry, and it is D60's. */
export const CLEARS_A_REFUSAL = Object.freeze({ measure: "repair" });

/* --------------------------------------------------------------------------
 * D76 — THE RULE BOTH SPLICES ARE HELD TO, WRITTEN DOWN ONCE.
 *
 * Both lists above pull a step FORWARD, out of its position in ORDER, to do
 * something on another step's behalf: `BANKS` runs before a step that is about
 * to ASK, `CLEARS_A_REFUSAL` runs before a refusal is handed to anybody. A
 * step visited that way was not scheduled there and did not ask to be, so:
 *
 *   A SPLICED VISIT IS NEVER WHERE A WALK ENDS.
 *
 * Not on a failed precondition, not on a question, and not on "ran and is
 * still not satisfied". Every one of those is held, the walk carries on, and
 * the step is asked again at its OWN position in ORDER — where the refusal is
 * fatal, and the question is handed over, exactly as each was before either
 * splice existed. `workflow.walkSteps` spells all four cases and each one
 * carries the run that paid for it.
 *
 * THE TWO THAT WERE MISSING, and what each cost:
 *
 *   a banked step that ASKS     `measure` refuses a failing suite at the top
 *                               of the round, and the walk handed that one
 *                               item over and never ran `derive` at all.
 *                               Rounds 3, 5 and 7 of `20260920T030124Z`, after
 *                               which `derive`'s stall rule fired on "3 rounds
 *                               in a row ended before `derive` was reached".
 *   a banked step that REFUSES  `record.mjs` will not record a MOCKED run
 *                               against a REAL boundary — a correctness
 *                               refusal nothing here weakens — and the splice
 *                               made that refusal fatal from ORDER[8] at the
 *                               top of every round. Five runs end on it, the
 *                               clearest being round 5 of `20260919T092410Z`.
 *                               A sixth, `20260919T171842Z`, wears the same
 *                               three lines and is NOT this defect: there
 *                               `derive` had already STOPPED, so `record` was
 *                               at its own position and was right to be fatal.
 *
 * WHY HOLDING LOSES NOTHING. A step's refusal and its question are both read
 * off the DISK, by the same `precondition`/`satisfied`/`run` the walk asks a
 * few entries later; neither is a fact the walk computed and would have to
 * compute again. What is given up by holding is a round in which the bottom of
 * the order speaks for the top of it.
 * ------------------------------------------------------------------------ */

/**
 * Import one step module by name.
 *
 * Lazily, not at directory import: several steps will pull in the heavier tools
 * — scan.mjs loads ts-morph and record.mjs spawns vitest — and the walk often
 * only needs to ask `satisfied`, which the filesystem answers for free.
 */
export async function loadStep(name) {
  if (!ORDER.includes(name)) {
    throw new Error(`no step named \`${name}\` — the order is ${ORDER.join(", ")}`);
  }
  return import(new URL(`./${name}.mjs`, import.meta.url).href);
}
