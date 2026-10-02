/**
 * ruling — every `istanbul ignore` in src, what it removed, and whether it is
 * fit for a person to rule on.
 *
 * ONE CHECK, NOT A STAGE. `run` spawns `suppressions.mjs`, which prices each
 * directive against the stage-1 report and exits 1 on any that is not fit to be
 * ruled. `satisfied` then answers the gate's `suppressions` check and NOTHING
 * ELSE.
 *
 * WHY NOT `gate --stage 7`, which is the obvious way to ask. The gate's filter
 * is `(c.stage ?? 3) <= STAGE` (gate.mjs:84 and its `main`), i.e. CUMULATIVE —
 * `--stage 7` runs the rate rule, the mutation check and twenty others
 * alongside this one. A run whose coverage is below its target would then fail
 * here forever, and no amount of re-running this step could move it, because
 * the rate is not this step's business and is not decided on this step's disk.
 * That is a missing verdict turned into a wedged run.
 *
 * THE ROUTE TAKEN, and it is the second of the two the build item offered:
 * gate.mjs has no CLI selector for a single check — `ARGV` is read once, at
 * gate.mjs:32-84, and `--stage` is the only thing it looks at — so `priced` is
 * imported from `suppressions.mjs` exactly as gate.mjs:29 imports it, and the
 * check's own rule is applied to the same rows the gate would have seen. One
 * implementation of "what did this directive cost", read by both.
 *
 * THE RULE, from gate.mjs:1447:
 *
 *   no directives in src        -> satisfied. This is every unattended run:
 *                                  nothing has been suppressed, because nobody
 *                                  has ruled.
 *   a directive not fit to rule -> not satisfied, and the reason names it.
 *                                  Three things make one fit, and each was
 *                                  violated at least once in the pilot:
 *                                  `-- @preserve`, the standing instruction,
 *                                  and a fenced BLOCKED.md entry.
 *
 * ONE DEVIATION FROM THE GATE'S ORDER, and it is deliberate. `priced()` reports
 * an `error` when no coverage report exists to price against, and the gate
 * returns on that BEFORE it looks at how many directives there are. Asked in
 * that order, a repo with no directives at all and no report would refuse — on
 * a measurement of nothing, that this step cannot produce and `suppressions.mjs`
 * cannot produce either. So the count is asked first. With directives present
 * the error is still a refusal, because then it really is a price nobody can
 * read.
 *
 * NO PENDING ITEM ASKS FOR THE RULING. A suppression is ruled by a PERSON at
 * stage 7, signing `decisions.json` with their name and the date — the run's job
 * is to hand the directives to the pull request, priced and evidenced, and stop.
 * An agent answering "is this branch truly unreachable" in a worklist item is
 * the signature this whole stage exists to require, and no item below asks for
 * one.
 *
 * BUT THE FITNESS DEFECT IS HANDED OVER, AND IT WAS NOT.
 *
 * WHAT THIS STEP USED TO DO. `satisfied` was `verdict().reason === null` and
 * `run` returned `pending: []` unconditionally. Read together those two say: a
 * directive that is not fit to be ruled stops the walk, for ever, with nothing
 * in front of anybody. `run` spawns `suppressions.mjs`, which PRINTS the
 * problem and changes nothing — it is a pricer, not a fixer — so re-running
 * this step re-reads the same directive and reports the same refusal. That is
 * the exact shape the walk cannot route: not satisfied, not askable, not
 * fixable by the step that owns it.
 *
 * WHAT IT COST. This sits at ORDER[13], one step before `report` — the ONLY
 * writer of `out/result.json`, which is the whole deliverable. A single
 * `istanbul ignore` in the target's `src/` missing its `-- @preserve`, or one
 * fenced BLOCKED.md entry written before charpilot existed and therefore
 * pointing at no arm this run can find, discards everything the run measured.
 * Run `20260918T073111Z` is what that class of ending looks like from outside:
 * 865 of 865 sides closed across 7 rounds of an allowed 14, zero errors, and no
 * result document at all.
 *
 * WHY AN ITEM RATHER THAN `OPTIONAL`. Both endings were available and they are
 * not equivalent. `OPTIONAL` would let the walk carry on and leave `gate.mjs`
 * to fail the pull request on the same rule — honest, and it throws away the
 * one turn that could have fixed it. The three things that make a directive fit
 * are all MECHANICAL and all in front of the agent: add `-- @preserve` so
 * esbuild stops stripping the comment, add the standing instruction, write the
 * fenced BLOCKED.md entry. None of them is the ruling; all of them are work an
 * answering turn does in seconds, and the ruling a person signs afterwards is
 * then a ruling over evidence rather than over a directive nobody priced.
 *
 * WHAT THE ITEM CARRIES, and why it is not just the sentence. `priced()` has
 * already measured what each directive removed from the denominator, so the
 * item names the file, the line, the `istanbul ignore` kind, the sides and
 * functions it took out, and which of the three requirements is missing. The
 * answering turn opens one file and writes one comment; it does not re-derive
 * what the directive costs.
 */
import { SRC_ROOT } from "../config.mjs";
import { priced } from "../suppressions.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "ruling";

/**
 * The gate's `suppressions` check, over the rows `priced()` measured.
 *
 * `{ count, sides, unfit, reason }`. `reason` is null when the check passes and
 * is otherwise the sentence the walk quotes back — never a bare false, because
 * "ruling is not satisfied" sends a reader to look at every directive in the
 * repo rather than at the two that are missing a BLOCKED.md entry.
 */
export function verdict() {
  let rows;
  let total;
  let error;
  try {
    ({ rows, total, error } = priced());
  } catch (err) {
    // `priced` reads src/, out/scan.json and the coverage report directly. A
    // throw out of it is one of those being absent or unparseable, and it
    // belongs in the refusal verbatim rather than as a stack trace out of a
    // predicate the walk does not wrap.
    return { count: 0, sides: 0, unfit: [], reason: `the \`istanbul ignore\` directives in src could not be priced — ${err.message}` };
  }

  // gate.mjs:1447. Asked before the error — see the docblock.
  if (!rows.length) return { count: 0, sides: 0, unfit: [], reason: null };

  if (error) return { count: rows.length, sides: 0, unfit: [], reason: error };

  const unfit = rows.filter((r) => r.problems.length).map((r) => `${r.id} — ${r.problems.join("; ")}`);
  return {
    count: rows.length,
    sides: total,
    unfit,
    reason: unfit.length
      ? `${unfit.length} of ${rows.length} directive(s) not fit to be ruled, ${total} side(s) suppressed in total: ${unfit.join(" · ")}`
      : null,
  };
}

/**
 * Nothing to be blocked on. `suppressions.mjs` names its own missing inputs
 * with the command that produces each, and a second copy of that search here is
 * the copy that drifts.
 */
export function precondition(_repo) {
  return null;
}

/** THE DISK, through the same `priced()` the gate reads: the suppressions check alone. */
export function satisfied(_repo) {
  return verdict().reason === null;
}

/**
 * The standing instruction and the BLOCKED.md fence, spelled as the answering
 * turn has to type them.
 *
 * Read off `suppressions.mjs`'s own refusal vocabulary — `no -- @preserve`,
 * `no standing instruction`, `no BLOCKED.md entry` — rather than restated as a
 * second list of rules: the tool decides what is missing, and this only says
 * what to do about each. A second list here is the one that drifts when the
 * rule moves.
 */
const HOW_TO_FIX = Object.freeze({
  "no -- @preserve (esbuild strips it; the ignore does nothing)":
    "append ` -- @preserve` inside the comment. Without it esbuild drops the comment before istanbul ever sees it, " +
    "so the directive suppresses nothing and the side is still in the denominator — the directive is decoration.",
  "no standing instruction":
    "the comment has to carry the standing instruction verbatim, so a reader of the diff sees under which rule this " +
    "was suppressed rather than that somebody suppressed it.",
  "no BLOCKED.md entry":
    "add a ```blocked fence to BLOCKED.md naming this arm (`arm: <file>#<line>:<kind>:<index>`), its `killer` and its " +
    "`side`. That entry is what a person rules ON at stage 7; without it the pull request asks for a signature over " +
    "a line number.",
});

/**
 * One open question per directive that cannot be ruled as it stands.
 *
 * NEVER "should this be suppressed" — see the docblock. Every item asks the one
 * thing the answering turn can settle: make this directive FIT, or delete it
 * and let the side go back into the denominator where it is measured like any
 * other.
 */
export function pending() {
  const v = verdict();
  if (v.reason === null) return [];

  const { rows } = (() => {
    try {
      return priced();
    } catch {
      // `verdict()` has already turned this into its own sentence, and the item
      // below carries that sentence. Re-throwing here would put a stack trace
      // where a question belongs.
      return { rows: [] };
    }
  })();

  const unfit = rows.filter((r) => r.problems.length);
  if (!unfit.length) {
    // A REASON WITH NO ROW UNDER IT, and it still has to be askable. `priced()`
    // reports an `error` when there is no coverage report to price against, and
    // it throws when src/, out/scan.json or the report cannot be read at all —
    // both leave `satisfied` false with nothing per-directive to name. Handed
    // over as one item quoting the tool, because the alternative is the state
    // this whole change exists to remove: a step that refuses and asks nothing.
    return [
      {
        id: "ruling:unpriceable",
        kind: "suppression",
        question:
          `the \`istanbul ignore\` directives in ${here(SRC_ROOT)} cannot be priced, so nothing here can say what they ` +
          `removed from the denominator: ${v.reason}`,
        context: {
          reason: v.reason,
          directives: v.count,
          says:
            "A directive whose cost cannot be measured cannot be ruled on: the percentage above it is computed on " +
            "what is LEFT, and nobody can sign that without knowing what was taken out. Produce the coverage report " +
            "this prices against (stage 1's `out/coverage-charpilot`, or the repo's own), or remove the directives.",
        },
      },
    ];
  }

  return unfit.map((r) => ({
    // STABLE OVER THE DIRECTIVE AND ITS PROBLEMS, so a round that fixed one of
    // two problems asks a different question rather than repeating itself, and
    // `writeWorklist`'s repeat detector can tell the two apart.
    id: `ruling:${r.id}:${r.problems.length}`,
    kind: "suppression",
    file: r.file,
    line: r.line,
    question:
      `\`istanbul ignore ${r.kind}\` at ${r.id} is not fit to be ruled on: ${r.problems.join("; ")}. ` +
      `Make it fit, or delete it and let its ${r.sides} side(s) go back into the denominator.`,
    context: {
      directive: `istanbul ignore ${r.kind}`,
      at: r.id,
      // WHAT IT COST, measured by `priced()` and not re-derived here. This is
      // the number a person is being asked to sign over.
      removedFromDenominator: { sides: r.sides, functions: r.functions },
      lines: (r.lines ?? []).map((g) => g.line),
      problems: r.problems,
      fixes: r.problems.map((p) => HOW_TO_FIX[p] ?? p),
      blockedEntry: r.entry ?? null,
      says:
        "This is NOT a request to rule on the suppression. A person signs that at stage 7 in decisions.json, with " +
        "their name and the date, and no agent may stand in for them. What is asked here is the three mechanical " +
        "things that make the directive readable as evidence: the `-- @preserve` that stops esbuild deleting it, the " +
        "standing instruction that says under which rule it was written, and the BLOCKED.md entry that names the arm " +
        "and its killer. A directive missing any of them wedges this step, because nothing this step spawns can add " +
        "them.",
    },
  }));
}

export function run(_repo) {
  const did = [];

  // No `--coverage`: suppressions.mjs:52-55 already prefers stage 1's report
  // over the repo's own and prints which one it used, and naming it here would
  // be a second place for that choice to be made.
  const outcome = runTool("suppressions");
  if (outcome.line) did.push(outcome.line);

  const v = verdict();
  did.push(
    v.reason ??
      (v.count
        ? `${v.count} directive(s) · ${v.sides} side(s) out of the denominator, every one fit to be ruled — ` +
          `the percentage above them is computed on what is LEFT, so quote both`
        : "no directives in src — nothing has been suppressed, so there is nothing for a person to rule")
  );

  // THE UNFIT DIRECTIVES GO IN FRONT OF THE ANSWERING TURN. `pending` is empty
  // whenever `verdict().reason` is null, which is every healthy run and every
  // run with no directives at all — so nothing is asked that did not need
  // asking. It is non-empty exactly when `satisfied` is false, which is the
  // property the walk needs: see the docblock for what the old unconditional
  // `pending: []` cost one step before `report`.
  const open = pending();
  if (open.length) {
    did.push(
      `${open.length} directive(s) are handed over to be MADE FIT — not to be ruled on. ` +
        `suppressions.mjs prices them and cannot repair them, so re-running this step reports the same refusal for ever.`
    );
  }
  return { did, pending: open, metrics: v.count ? { directives: v.count, suppressedSides: v.sides } : {} };
}
