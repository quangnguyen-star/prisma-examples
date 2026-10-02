#!/usr/bin/env node
/**
 * THE RATE RULE - what a run has to reach before it may call itself finished.
 *
 * Nothing compared a run's rate to anything. `report.mjs` wrote `result.json`,
 * `finish.py` checked only that `coverage_percentage` held two numbers, and the
 * container opened a pull request. So run 20260915T033521Z - the first live
 * one - exited 0 at 65.9% branch coverage, thirty points below the mocked run
 * beside it, and nothing in the pipeline said a word. The percentage was
 * quotable and the shortfall was not.
 *
 * The ratchet does not cover this and cannot. `coverage-ratchet` asks "is the
 * union above what the pre-existing suite already covered", which 65.9% passed
 * comfortably: the existing suite covered less. A ratchet answers "did it go
 * down"; this answers "did it get there". Both are needed and neither implies
 * the other.
 *
 * PER MODE, and this is the part a single number gets wrong. Live and mocked
 * answer a different question of every boundary, so their rates are not each
 * other's baseline - `runcmp.py` already refuses to compare across modes (exit
 * 2) for exactly this reason. One threshold spanning both means either the
 * mocked target is lowered to whatever live can manage, or the live target is
 * set where no live run can reach it and the check is switched off. Two stated
 * numbers keep each honest, and a run whose mode is UNKNOWN is refused rather
 * than judged against a number that may not be its own.
 *
 * AGAINST LIVE CODE. The rate compared here is `correctedHitByEither /
 * correctedSides` - the raw pair with the sides inside dead exports removed
 * from both halves. A compliant run DELETES the characterization tests written
 * for dead exports (stage 2b), so it can never cover those sides; a target on
 * the raw rate is therefore a target the pipeline's own rules forbid reaching.
 * The raw pair is printed beside it every time, because a corrected rate that
 * hides the raw one is how a smaller run comes to wear a bigger number.
 *
 * It never repairs. There is no "close enough", no tolerance that defaults to
 * anything but zero, and nothing here reads the run's own achieved rate for any
 * purpose other than comparing it. A target that bends to what a run managed is
 * not a target.
 */

/**
 * The floor each mode must reach, and where each number comes from.
 *
 * ON THE DEFAULTS. 96.5 is the figure the work was commissioned against. It is
 * NOT taken from run 20260914T080742Z - that run's 96.5% describes a
 * configuration that no longer exists and its mode is not even derivable from
 * its log (see docs/plans/stage3-cost.html §3, §7). It is a chosen floor, and
 * it is written here rather than inferred from any run precisely so that no
 * measurement can quietly become the target.
 *
 * The two modes default to the same floor because there is no valid live
 * measurement on current code to justify a different one. When there is, change
 * THIS number and say what run justified it - do not let a run set it.
 */
export const DEFAULT_TARGETS = { live: 96.5, mocked: 96.5 };

/**
 * Reported, never gated.
 *
 * 97.5% was reached on run 20260915T050314Z at loop iteration 4 (358/367) -
 * but against the RAW denominator, and 35 of those sides were inside dead
 * exports. Against live code the same run sat at 323/332 = 97.29% at iteration
 * 4 and at iteration 6 alike, so 97.5 has never been reached on live code and
 * gating it would fail a run that did everything right. It is printed as the
 * distance still to go.
 */
export const STRETCH = 97.5;

const NUM = /^\d+(\.\d+)?$/;

/**
 * The target for a mode, and the answer to "who typed this number".
 *
 * `--tolerance` in runcmp.py prints in the output where a reader can see it,
 * for the same reason: a threshold a person moved must never look like one the
 * tool derived.
 */
export function targetFor(mode, env = process.env) {
  // AN UNSTAMPED RUN CANNOT BE GATED, AND MUST NOT BE FAILED FOR IT.
  //
  // `mode` is null on a run that never declared one, AND THAT IS MOST OF THEM.
  // Counted over the 127 runs on record (nodejs/tests/fixtures/runs-on-record.json):
  // 97 wrote a result.json and only 10 of those declared a mode. This comment
  // used to say "2 of the 3 real runs on disk" - a count taken when three runs
  // was all there was, left standing through a hundred and twenty-four more -
  // and to name 20260915T050314Z as "the last successful one", which it is
  // not: four runs are recorded `succeeded` (20260908T174455Z,
  // 20260916T031317Z, 20260917T172502Z, 20260917T181622Z), the latest of them
  // two days after that stamp, and 20260915T050314Z has no run directory on
  // any reachable checkout at all - it survives only as the vendored
  // `tests/fixtures/blocked-20260915T050314Z.entries.json`.
  //
  // The mode gap is real and is what this branch is for: an unstamped run
  // errored, `rate-target` turned that error into a failure, and the moment
  // the stage default stopped hiding that check, every such run failed a gate
  // it had passed the day before. Of the four that succeeded, three declared
  // `mocked` and the oldest declared nothing.
  //
  // A live target and a mocked target are different numbers; with no mode there
  // is no target to compare against, and that is a fact about the run's
  // provenance, not a defect in its coverage. Reported as unjudgeable, exactly
  // as `sameMode` passes an artifact it cannot place.
  if (mode === null || mode === undefined) {
    return { unjudgeable: "the run declared no CHARPILOT_MODE, so there is no target to hold it to - the rate is reported, not gated" };
  }
  if (mode !== "live" && mode !== "mocked") {
    return { error: `no target for mode ${JSON.stringify(mode)} - it is neither "live" nor "mocked"` };
  }
  const varName = `CHARPILOT_TARGET_BRANCHES_${mode.toUpperCase()}`;
  const raw = env[varName];
  if (raw === undefined || String(raw).trim() === "") {
    return { target: DEFAULT_TARGETS[mode], source: "default" };
  }
  const text = String(raw).trim();
  // REFUSED, not ignored. A malformed target that silently falls back to the
  // default is a threshold nobody set reading as one somebody did.
  if (!NUM.test(text)) {
    return { error: `${varName} is ${JSON.stringify(raw)}, which is not a number` };
  }
  const target = Number(text);
  if (target > 100) return { error: `${varName} is ${target}, which no run can reach` };
  return { target, source: varName };
}

/** Covered out of total, to one decimal. Zero total is 100 - a tree with no branches has no uncovered ones. */
export const percentage = (covered, total) =>
  total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;

/**
 * The verdict, from a coverage.json `totals` block and the run's mode.
 *
 * Returns `{ pass, detail }` on a decidable comparison and `{ error }` when it
 * cannot make one - an unstamped mode, a totals block with no corrected pair.
 * The caller exits non-zero on either; they are separated because they are
 * different failures and reading them alike is what this whole file is about.
 */
export function rateVerdict(totals, mode, env = process.env) {
  if (!totals) return { error: "no coverage totals to compare against a target" };

  const t = targetFor(mode, env);
  // Passed straight through to the caller, which reports it and does not fail.
  // A run with no declared mode still gets its rate printed; what it does not
  // get is a verdict, because there is nothing to hold it to.
  if (t.unjudgeable) return { unjudgeable: t.unjudgeable };
  if (t.error) {
    return {
      error:
        `${t.error}. A rate is not comparable across modes, so an unstamped run cannot be judged: ` +
        "set CHARPILOT_MODE=live or CHARPILOT_MODE=mocked and re-run stage 6",
    };
  }

  const { correctedHitByEither, correctedSides, hitByEither, sides } = totals;
  if (correctedSides === undefined || correctedHitByEither === undefined) {
    return {
      error:
        "the coverage document carries no live-code pair (`correctedHitByEither` / `correctedSides`), so the " +
        "only rate available counts sides inside dead exports that a compliant run is required to delete. " +
        "Re-run `node .claude/charpilot/deadcode.mjs` then stage 6",
    };
  }
  if (!correctedSides) {
    return { error: "the coverage document records 0 live-code sides - every side it found is inside a dead export" };
  }

  const rate = percentage(correctedHitByEither, correctedSides);
  const raw = percentage(hitByEither ?? 0, sides ?? 0);
  const where =
    `${mode}: ${rate}% against live code (${correctedHitByEither}/${correctedSides}), ` +
    `raw ${raw}% (${hitByEither}/${sides}) · target ${t.target}% (${t.source})`;

  if (rate < t.target) {
    return {
      pass: false,
      rate,
      raw,
      target: t.target,
      detail:
        `${where} · SHORT BY ${Math.round((t.target - rate) * 10) / 10} point(s). ` +
        "The target does not move to meet the run",
    };
  }
  return {
    pass: true,
    rate,
    raw,
    target: t.target,
    detail: `${where}${rate < STRETCH ? ` · ${Math.round((STRETCH - rate) * 10) / 10} short of the ${STRETCH}% stretch, which does not gate` : ` · at or above the ${STRETCH}% stretch`}`,
  };
}

/**
 * WHICH MODE THIS MEASUREMENT DESCRIBES, and the contradiction it refuses.
 *
 * A rate is not comparable across modes - live and mocked answer a different
 * question of every boundary - so the number has to travel with the mode that
 * produced it. Nothing stamped it, so `result.json` carried 65.9% and 94.3%
 * in the same shape and a reader had to go to the log to learn which was which.
 *
 * `CHARPILOT_MODE` names the run's mode; `--live` tells THIS script which
 * recording to check claims against. They can disagree, and when they do the
 * measurement is of the other mode's corpus under this mode's label - the same
 * defect BEHAVIOUR_FOR_RUN's note describes, one layer up. Refused, not
 * reconciled: this script cannot know which of the two the caller meant.
 *
 * An unset CHARPILOT_MODE is not a contradiction. Measuring is still this
 * script's job; deciding whether an unlabelled rate may be compared to a target
 * belongs to the check that does the comparing, which refuses it there.
 */
/**
 * What the OPERATOR said this run is, and nothing else.
 *
 * Separate from `modeOf` because the two questions are different. This one is
 * "which mode was this run launched in" - readable anywhere, including a tool
 * that takes no `--live` flag of its own. `modeOf` additionally asks whether
 * THIS invocation's flags agree with it, which only a tool that has such a flag
 * can be judged on. Conflating them made the stage-4 gate check read
 * `CHARPILOT_MODE=live` as a contradiction, because a gate run has no `--live`
 * to agree with, and it then judged a live run by the mocked recording.
 *
 * Returns null for unset, and `{ error }` for a value that is neither mode -
 * never a guess.
 */
export function declaredMode(env = process.env) {
  const raw = env.CHARPILOT_MODE ? String(env.CHARPILOT_MODE).trim().toLowerCase() : null;
  if (raw && raw !== "live" && raw !== "mocked") {
    return { error: `CHARPILOT_MODE is "${raw}", which is neither "live" nor "mocked"` };
  }
  return { mode: raw };
}

export function modeOf(env = process.env, argv = process.argv.slice(2)) {
  const d = declaredMode(env);
  if (d.error) return d;
  const declared = d.mode;
  const live = argv.includes("--live");
  if (declared === "live" && !live) {
    return {
      error:
        "CHARPILOT_MODE=live but this stage-6 run was not given --live, so it would check claims against " +
        "out/behaviour.json - the MOCKED recording - and report the result as a live rate",
    };
  }
  if (declared === "mocked" && live) {
    return {
      error:
        "CHARPILOT_MODE=mocked but this stage-6 run was given --live, so it would check claims against " +
        "out/behaviour-live.json and report the result as a mocked rate",
    };
  }
  return { mode: declared ?? (live ? "live" : null) };
}

/**
 * The functions a dead export owns, so their sides can leave the denominator.
 *
 * WHY A SIDE MAY LEAVE AT ALL. Deleting a characterization test written for a
 * dead export is the pipeline's own stage-2b rule, and it is correct - the test
 * pins behaviour no caller can observe. What was wrong is that the deletion
 * took the side out of the NUMERATOR and left it in the DENOMINATOR, so doing
 * the correct thing cost coverage. Run 20260915T050314Z reached 358/367 at
 * iteration 4, deleted 11 such proposals at iteration 5, and reported 346/367:
 * -12 sides, -3.2 points, for obeying its own rule.
 *
 * WHAT MAY NOT LEAVE. Only membership in `out/dead-exports.json` - an export
 * `findReferencesAsNodes` finds no reference to anywhere under src/. That is a
 * written, sourced, machine-checked reason. An export that is merely UNCOVERED
 * is not dead and never leaves: nothing in this function reads a hit count.
 *
 * REFUSES rather than falls back. An absent or pre-`functionIds` artifact means
 * the correction cannot be computed, and the raw rate is a DIFFERENT number
 * against a different denominator - quoting it under the corrected label is the
 * "smaller run wearing a bigger number" failure inverted. So it returns an
 * error for the caller to exit on, and never a partial answer.
 */
export function deadExportFunctionIds(doc, where = "out/dead-exports.json") {
  if (doc === null || doc === undefined) {
    return {
      error:
        `${where} does not exist, so no side can be shown to be dead. ` +
        "Run `node .claude/charpilot/deadcode.mjs` - the gate already requires it at stage 2, before stage 3 derives anything",
    };
  }
  if (!Array.isArray(doc.dead)) {
    return { error: `${where} has no \`dead\` array - it is not a dead-export scan` };
  }
  if (doc.totals?.deadFunctionIds === undefined) {
    return {
      error:
        `${where} was written by a deadcode.mjs that did not record \`functionIds\`, ` +
        "so which sides sit inside a dead export cannot be decided by identity - only re-derived, which is a second " +
        "denominator. Re-run `node .claude/charpilot/deadcode.mjs`",
    };
  }
  const ids = new Set();
  for (const d of doc.dead) {
    if (!Array.isArray(d.functionIds)) {
      return {
        error: `${where}: dead export \`${d.name}\` (${d.file}:${d.line}) carries no \`functionIds\``,
      };
    }
    for (const id of d.functionIds) ids.add(id);
  }
  return { ids, declaredSides: doc.totals.branchSidesInsideThem ?? 0 };
}

/**
 * The rate against LIVE code, and the arithmetic that cannot exceed 100.
 *
 * The naive correction - `hitByEither / correctedDenominator` - is wrong, and
 * loudly so: on run 20260915T050314Z it yields 346/332 = 104.2%. A rate over
 * 100 is the proof that it takes the sides out of one side of the fraction
 * only. A dead side that the suite happens to cover is counted in `hitByEither`
 * too, so it has to leave BOTH:
 *
 *     correctedHitByEither = hitByEither - deadSidesHit
 *     correctedSides       = sides       - deadSides
 *
 * which is just "covered live sides over live sides", and is bounded by 100
 * because `deadSidesHit <= deadSides` and every remaining covered side is one
 * of the remaining sides. On that run: (346 - 23) / (367 - 35) = 323/332.
 */
export function liveCodeTotals({ sides, hitByEither, stillUncovered, deadSides, deadSidesHit }) {
  const correctedSides = sides - deadSides;
  const correctedHitByEither = hitByEither - deadSidesHit;
  return {
    deadExportSides: deadSides,
    deadExportSidesHit: deadSidesHit,
    correctedSides,
    correctedHitByEither,
    correctedStillUncovered: stillUncovered - (deadSides - deadSidesHit),
  };
}

// ---------------------------------------------------------------- artifacts
//
// AN ARTIFACT REMEMBERS THE MODE IT WAS MADE IN, and a reader in another mode
// refuses it.
//
// Run 20260915T111158Z-live was launched live, recorded live, then at 14:00:39Z
// deleted out/behaviour-live.json and continued with `--no-live` for another 71
// minutes. Its coverage.json reads `"mode": "mocked"`; its result was merged
// under the title "live staging reaches 96.7%". Nothing refused anything,
// because only coverage.json carried a mode at all and nothing compared it to
// the run's.
//
// The same shape one layer down: determinism compares two recordings, and a
// second observation taken in the other mode compares a double to a database.
// That is not instability in the subject, and it was reported as if it were.
//
// Only artifacts whose CONTENT depends on the mode are stamped. scan.json and
// worklist.json are an AST walk and a join over it; they are the same document
// in either mode and stamping them would invent a conflict.

/** The mode stamp to merge into an artifact being written, or nothing. */
export function modeStamp(env = process.env) {
  const d = declaredMode(env);
  // An undeclared mode is stamped as undeclared rather than guessed. `null` and
  // absent must read alike to `sameMode` below, and both must mean "this
  // artifact cannot say", never "this artifact is mocked".
  return d.error || !d.mode ? {} : { mode: d.mode };
}

/**
 * Whether an artifact may be read by THIS run, and why not when it may not.
 *
 * Silent on an artifact with no stamp: every file written before this existed
 * has none, and refusing them would refuse every corpus in docker/runs/. The
 * check is for a stamp that DISAGREES, which is a fact, not an absence.
 */
export function sameMode(doc, what, env = process.env) {
  const d = declaredMode(env);
  if (d.error || !d.mode) return { ok: true };
  const stamped = doc?.mode;
  if (!stamped || stamped === d.mode) return { ok: true };
  return {
    ok: false,
    error:
      `${what} was written in ${stamped} mode and this run is ${d.mode}. ` +
      `A recording of doubles and a recording of staging are not each other's evidence, ` +
      `so the number built from it would be about the other run. ` +
      `Re-run the stage that writes it under CHARPILOT_MODE=${d.mode}, or delete it.`,
  };
}
