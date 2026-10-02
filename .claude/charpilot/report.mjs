#!/usr/bin/env node
/**
 * The one machine-readable result, for a caller that is not a person.
 *
 * `status.mjs` is the place numbers come from and it stays that way -- this
 * derives nothing, computes nothing, and re-measures nothing. Stage 6 already
 * wrote every figure below into `out/coverage.json`; this reshapes two of them
 * into the contract a container reads and stops.
 *
 * Why not let the caller read `out/coverage.json` directly: that document has
 * twenty-odd fields in `totals` and answers a different question -- how the
 * loop is progressing, which claims were false, what is still uncovered. A
 * caller binding to it would bind to all of that. This file is the narrow
 * promise, and it is the only thing outside this repo is allowed to depend on.
 *
 * Two units, because they are the two that mean the same thing in python,
 * nextjs and here:
 *
 *   branches   arm sides, `hitByEither / sides`
 *   functions  function entries, `functionsCovered / functionsTotal`
 *
 * Statements exist in `totals` too and are deliberately left out. They were
 * the obvious single number and they do not travel: a statement here and a
 * statement in Python are counted by different tools with different ideas of
 * what one is, and two of those in one column get averaged by somebody.
 *
 * TWO MORE FIELDS, and one verdict:
 *
 *   coverage_percentage_live_code   the same two units with the sides inside
 *                                   dead exports removed from BOTH halves
 *   mode                            live or mocked, stamped at stage 6
 *   target                          the floor this mode had to clear
 *   missing                         D64 — live sides nothing exercised, each
 *                                   with the recorder's own written reason.
 *                                   They are IN the denominator and counted as
 *                                   uncovered; naming them changes no number
 *                                   here. See `missingFrom`.
 *
 * and a `failed` status when the run did not clear it. See targets.mjs for why
 * that is per-mode, why it is compared against the live-code rate, and why the
 * raw pair is still printed beside it every time.
 *
 *   node .claude/charpilot/report.mjs --out result.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defectsDigest } from "./defectsdigest.mjs";
import { STRETCH, percentage, rateVerdict } from "./targets.mjs";

// Deliberately NOT `import { OUT_DIR } from "./config.mjs"`. config.mjs
// statically imports the target repo's `test/src-exclude.mjs`, so importing it
// throws ERR_MODULE_NOT_FOUND anywhere that file is absent. A reporter has no
// business failing because the scan is unconfigured -- it needs one path, and
// that path is derived from this file's own location exactly as config.mjs
// derives it.
const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "out");

const COVERAGE = join(OUT_DIR, "coverage.json");
const DEFAULT_OUT = "result.json";

// `percentage` comes from targets.mjs, which is also where the comparison that
// reads it lives. Two implementations of "covered out of total" is two answers
// the day one of them learns to round differently.

/**
 * The most sides this run ever measured, from the loop ledger.
 *
 * Derived rather than stored on the row, so it reads correctly on a loop.json
 * written before this existed - which is every ledger in the wild today. A row
 * missing `hitByEither` contributes 0 rather than NaN: an unreadable row must
 * not make the peak disappear, because a peak that silently becomes the current
 * value is exactly the silence this function was added to break.
 */
export function peakOf(iterations, current) {
  return Math.max(current, ...(iterations ?? []).map((r) => r?.hitByEither ?? 0));
}

/**
 * D64 — THE LIVE SIDES THIS RUN DID NOT EXERCISE, AND THE RECORDER'S OWN
 * REASON FOR EACH.
 *
 * WHAT IT IS NOT, said first because the two are one keystroke apart in a
 * reader's head and opposite in effect:
 *
 *   dead_export_sides_removed        already above, inside
 *                                    `coverage_percentage_live_code`. Code
 *                                    that is NOT live, taken out of both
 *                                    halves of the rate.
 *   missing                          code that IS live. In both halves,
 *                                    counted as uncovered in both, and named
 *                                    here because nothing exercised it and
 *                                    the recorder said why.
 *
 * So `missing` never changes a number in this document. Its whole job is to
 * stop a rate being quoted as though the shortfall were unexplained: five
 * sides of `parseAddressesForJd` on run `20260919T142723Z` were live code the
 * mocked-mode recorder refused to invoke, and eight rounds re-asked for them
 * because nobody had written that down where a reader of the result could see
 * it.
 *
 * READ, NEVER DERIVED. `coverage.mjs` marks the rows out of `record.mjs`'s own
 * `skipped[]` entries and this reshapes them; `why` is the recorder's sentence
 * verbatim and no rule here decides anything. A coverage document with no
 * marked rows — which is every document written before this existed, and every
 * run whose recorder refused nothing — yields an empty list.
 */
export function missingFrom(doc) {
  return (doc?.stillUncovered ?? [])
    .filter((row) => row?.undeliverable?.why)
    .map((row) => ({
      side: `${row.armId}[${row.side}]`,
      file: row.file ?? null,
      line: row.line ?? null,
      function: row.functionName ?? row.functionId ?? null,
      // Not "excluded", not "skipped": this side is in the denominator and is
      // counted as uncovered in every rate above. What is missing is an
      // exercise of it.
      counted: "uncovered, in the denominator",
      not_exercised_because: row.undeliverable.why,
      said_by: row.undeliverable.saidBy ?? "record.mjs",
    }));
}

/**
 * The pipeline_defect sides grouped by the tool's own sentence, up to its first
 * " - " (the part that names what failed, not the per-row detail), most first.
 */
export function defectClasses(doc) {
  const counts = new Map();
  for (const row of doc?.stillUncovered ?? []) {
    if (row?.ruling?.state !== "pipeline_defect") continue;
    const key = String(row.ruling.why ?? "unnamed").split(" - ")[0].slice(0, 160);
    const at = counts.get(key) ?? { class: key, count: 0, saidBy: row.ruling.saidBy ?? null };
    at.count += 1;
    counts.set(key, at);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}

/**
 * out/defects.json's rows, split into tool defects, blocked steps and NOTES.
 * Never throws: no file, or one that cannot be read, is no defects.
 *
 * A NOTE is a fact a step wants in the result that loses no side and stops no
 * step - stagingenv's "no manifest under any name tried, recording mocked" is
 * the first. Rule 3 decides the status from the sides, so a note is listed in
 * `notes[]` and never counts as a tool defect (it used to: a no-manifest row
 * with no `kind` made a run `failed`).
 */
export function stepDefects(path, runId = (process.env.CHARPILOT_RUN_ID || process.env.CHAR_RUN_STAMP || "").trim() || null) {
  let rows = [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    rows = Array.isArray(doc?.defects) ? doc.defects : [];
  } catch {
    rows = [];
  }
  // THIS RUN'S ROWS ONLY (see workflow.mjs currentRunId). The walk already
  // moved other runs' rows to defects.history.json; this is the same rule for
  // a report built outside a walk. With no run id there is nothing to scope to.
  if (runId) rows = rows.filter((d) => (d?.run ?? null) === runId);
  // `blocking: false` is a row its writer says decides nothing: it is listed
  // with the notes and never counted as a tool defect.
  const informational = (d) => d.kind === "note" || d.blocking === false;
  return {
    toolDefects: rows.filter((d) => d && d.kind !== "blocked" && !informational(d)),
    blockedSteps: rows.filter((d) => d && d.kind === "blocked" && d.blocking !== false),
    notes: rows.filter((d) => d && informational(d)),
  };
}

/**
 * D37 — THE ROWS A CIGATE WITHHOLD IS MADE OF, or null for any other defect.
 *
 * A cigate defect is two things in one sentence: rows withheld as `it.skip`
 * because the repo's own config ran them red, and a suite red for reasons no
 * row could be withheld for. The first costs exactly the sides those rows
 * claim; the second is a red CI whatever the sides say. This returns the
 * withheld ids only for a defect that is NOTHING BUT withholds: from the
 * fields steps/emit.mjs writes (`withheld`, `suiteRed`), or, on a row written
 * before them, from the sentence it wrote, which begins with the count.
 * `{ count, ids }`: the sentence is cut at 4000 characters, so on an old row
 * `ids` may name fewer rows than `count`, which is whole.
 */
export function withheldRowsOf(d) {
  if (!d || d.tool !== "cigate.mjs") return null;
  if (Array.isArray(d.withheld)) {
    return d.suiteRed === 0 && d.withheld.length ? { count: d.withheld.length, ids: d.withheld.map(String) } : null;
  }
  const msg = String(d.message ?? "");
  const head = /^(\d+) emitted test\(s\) failed the repo's own CI and were withheld as it\.skip with their error: /.exec(msg);
  if (!head || /the repo's own CI is red for \d+ reason/.test(msg)) return null;
  const count = Number(head[1]);
  const ids = [...msg.slice(head[0].length).matchAll(/(?:^|; )([^\s;]+) \[(?:tests|typecheck)\] /g)].map((m) => m[1]);
  return { count, ids: ids.slice(0, count) };
}

/** `armId [side]` and `armId[side]` are one side: the walk writes the first, `missing` the second. */
const sideKey = (k) => String(k).replace(/\s+\[/, "[");

const failure = (reason) => ({
  status: "failed",
  failed_reason: reason,
  pr_url: null,
  coverage_percentage: null,
});

/**
 * A MEASURED RUN THAT IS NOT A SUCCESS IS PARTIAL, NOT FAILED.
 *
 * Fix plan 1, rule 3: `succeeded` needs every side covered or ruled
 * unreachable (the target is reported, not gated, since 2026-09-25); anything
 * short of that is `partial`, and still
 * delivers - numbers, branch and a draft pull request. `failed` is kept for a
 * run with no number at all, and for the safety refusals, which are not this
 * file's to make.
 *
 * `partial.reportedBy` is what tells this document from the salvage
 * `workflow.salvageResult` writes with the same status: a salvage says the walk
 * never reached `report`; this says it did, and this is the verdict.
 */
const partialResult = (reason) => ({
  status: "partial",
  failed_reason: reason,
  pr_url: null,
  partial: { reportedBy: "report.mjs", step: "report", reason },
});

/**
 * THE FALSE-CLAIM SIDES, NAMED where `missing` names every other uncovered side.
 *
 * A false claim is a row whose input never reached the side it was written for.
 * The side is uncovered and already in the denominator; this says why, with
 * the mechanism coverage.mjs measured, so a reviewer does not have to open
 * coverage.json to learn which rows they are.
 */
export function falseClaimSides(doc) {
  return (doc?.falseClaims ?? []).map((c) => ({
    side: `${c.armId}[${c.side}]`,
    file: c.file ?? null,
    line: c.line ?? null,
    function: c.functionName ?? null,
    counted: "uncovered, in the denominator",
    not_exercised_because:
      `false-claim: row \`${c.id}\` claimed this side and istanbul counted ${c.hits ?? 0} hit(s) ` +
      `(${c.mechanism ?? "mechanism not recorded"})`,
    open_because: "false-claim",
    said_by: "coverage.mjs",
  }));
}

/**
 * The result document, computed or explained.
 *
 * Never throws. A caller that gets no file cannot tell a crash from a repo
 * with nothing to measure, so every failure comes back as a `failed` status
 * carrying its reason.
 */
export function build(coveragePath = COVERAGE, env = process.env) {
  const verdict = buildVerdict(coveragePath, env);
  // Listed whatever the status, and never part of deciding it.
  const { notes } = stepDefects(join(dirname(coveragePath), "defects.json"));
  // And (D37) a cigate withhold that cost no side, which the verdict put there.
  const decided = verdict.notes ?? [];
  if (notes.length || decided.length) {
    verdict.notes = [
      ...notes.map((n) => ({ step: n.step, ...(n.id ? { id: n.id } : {}), tool: n.tool ?? null, message: n.message })),
      ...decided,
    ];
  }
  // WHICH PATH THE RUN TOOK (tool backlog, runner.mjs): the repo's own vitest,
  // our vitest alongside another runner, or vitest set up where there was no
  // suite. On the result whatever the status, so a PR says which it was.
  const runner = readRunner(join(dirname(coveragePath), "runner.json"));
  if (runner) verdict.runner = runner;
  const digest = defectsDigest(join(dirname(coveragePath), "defects.json"));
  if (digest) verdict.defects_digest = digest;
  return verdict;
}

/** out/runner.json as the result carries it, or null. */
function readRunner(path) {
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    return { runner: r.runner, detail: r.detail, action: r.action, measuredByStage1: r.measuredByStage1, evidence: r.evidence ?? [], note: r.note ?? null };
  } catch {
    return null;
  }
}

/**
 * The stand-in names, from the recorder's own artifact first (what it applied)
 * and stage 1's report second (what it planned). Names only - no value is in
 * either file.
 */
function standInNames(outDir) {
  for (const [file, pick] of [["behaviour.json", (d) => d.standIns], ["staging-env.json", (d) => d.standIns?.names]]) {
    try {
      const names = pick(JSON.parse(readFileSync(join(outDir, file), "utf8")));
      if (Array.isArray(names)) return names;
    } catch { /* absent or unreadable - try the next */ }
  }
  return [];
}

function buildVerdict(coveragePath, env) {
  if (!existsSync(coveragePath)) {
    return failure(`no coverage at ${coveragePath} -- run stage 6 first`);
  }

  let doc;
  try {
    doc = JSON.parse(readFileSync(coveragePath, "utf8"));
  } catch (err) {
    return failure(`could not read ${coveragePath}: ${err.message}`);
  }

  const t = doc.totals;
  if (!t) return failure(`${coveragePath} has no totals block`);

  // `sides` of zero means the scan found no arms, which is a scan problem
  // rather than a perfect score. Reporting 100 here would be the most
  // flattering possible way to hide a broken join.
  if (!t.sides) {
    return failure(
      "the coverage document records no branch sides -- stage 2's scan found " +
        "no arms, so there is nothing to measure",
    );
  }
  if (!t.functionsTotal) {
    return failure("the coverage document records no function total");
  }

  // A FALSE CLAIM IS NOT A SUCCESS, and this file used to be the place that
  // forgot it. (Since fix plan 1 it is a `partial`, not a `failed`: below.)
  //
  // `succeeded` meant no more than "a coverage document exists, parses, and
  // records a non-zero denominator". Nothing here read claimsFalse, so run
  // 20260915T033521Z reported
  //
  //     {"status":"succeeded","coverage_percentage":{"branches":65.9,...}}
  //
  // while 118 of its 140 claims were FALSE, 20 rows were quarantined, and its
  // own loop.json recorded coverage falling 130 -> 110 -> 94 across three
  // iterations. The number was quotable and the defects were not.
  //
  // coverage.mjs already exits 1 on the same condition. The verdict was being
  // computed and then discarded by the next consumer - the same shape as the
  // three stage-6 defects fixed alongside this, and the reason a 30-point
  // shortfall reached a result document unchallenged.
  //
  // A FALSE claim means the recorded pair froze a DIFFERENT arm under this
  // label, so the suite pins behaviour nobody asked for while the side it was
  // written for stays uncovered. That is the failure this pipeline exists to
  // prevent; it cannot be the thing it reports success over.
  const claimsFalse = t.claimsFalse ?? 0;
  const claims = {
    checked: t.claimsChecked ?? 0,
    verified: t.claimsVerified ?? 0,
    false: claimsFalse,
    unmeasurable: t.claimsUnmeasurable ?? 0,
  };

  // BOTH NUMBERS, ALWAYS, and neither is optional.
  //
  // `coverage_percentage` keeps its meaning exactly: the raw pair over every
  // side the scan found. finish.py binds to it and runcmp.py compares runs on
  // it, and a field that quietly starts meaning something else is worse than a
  // new one.
  //
  // `coverage_percentage_live_code` is the same measurement with the sides
  // inside dead exports removed from the numerator AND the denominator. It is
  // the one a target is held against, because a compliant run deletes the
  // characterization tests written for dead exports and therefore cannot cover
  // those sides. Printing it without the raw pair would be how a smaller run
  // wears a bigger number, so they travel together or not at all.
  const rates = {
    coverage_percentage: {
      branches: percentage(t.hitByEither, t.sides),
      functions: percentage(t.functionsCovered, t.functionsTotal),
    },
    coverage_percentage_live_code:
      t.correctedSides === undefined
        ? null
        : {
            branches: percentage(t.correctedHitByEither, t.correctedSides),
            sides: `${t.correctedHitByEither}/${t.correctedSides}`,
            dead_export_sides_removed: t.deadExportSides ?? null,
            dead_export_sides_removed_that_were_covered: t.deadExportSidesHit ?? null,
          },
    mode: doc.mode ?? null,
    stretch: STRETCH,
    // THE ENV VARS THIS RUN FAKED, by name (standins.mjs): needed by the
    // service, supplied by nothing, and given an obviously-fake value so the
    // module graph loads in a mocked run. A row that passes because of one of
    // these passed against a value nobody deployed, and the reader has to be
    // able to see that. Empty in a live run, which gets none.
    env_stand_ins: standInNames(dirname(coveragePath)),
  };

  // D64 — CARRIED ON EVERY RETURN BELOW, INCLUDING THE FAILING ONES. A run
  // that fell short of its target has more need of "here is live code nobody
  // exercised, and here is the recorder's reason" than a run that cleared it,
  // and a field that appears only sometimes is a field its reader forgets
  // exists. Empty is the normal case and says so.
  const missing = [...missingFrom(doc), ...falseClaimSides(doc)];

  // THE SENTENCE A FALSE CLAIM ADDS TO THE VERDICT, if there is one. It no
  // longer ends the report on its own: fix plan 1, F3.5.
  let falseSentence = null;
  if (claimsFalse > 0) {
    // THE RATE AND THE STANDING OF THE MEASUREMENT, in the sentence itself.
    //
    // The verdict does not soften - a false `reaches` claim is a row frozen
    // under the wrong label, and three wrong labels are three wrong tests. What
    // was missing is PROPORTION. The old sentence read identically at 46 of 98
    // and at 3 of 110, and `docker/finish.py` now quotes it verbatim into the
    // pull request body, so it is the first thing a reviewer reads. A reviewer
    // told only "claims are FALSE" cannot tell a run that mislabelled a third
    // of its corpus from one that mislabelled three rows of a complete,
    // passing suite that cleared its target.
    //
    // Measured on notification-ms run 20260921T184935Z: 3 of 110 false,
    // 417/426 live-code sides, `suitePassed: true`, 97.9% against a 97.5%
    // stretch. Reported with the same words as run 20260921T115426Z, which was
    // 46 of 98 false.
    const rate = percentage(claimsFalse, claims.checked);
    const sound =
      rates.coverage_percentage_live_code === null
        ? ""
        : ` The rest of the measurement stands: ${rates.coverage_percentage_live_code.sides} live-code ` +
          `side(s) = ${rates.coverage_percentage_live_code.branches}%, and the emitted suite ` +
          `${doc.suitePassed === true ? "PASSES" : doc.suitePassed === false ? "does NOT pass" : "was not measured"}.` +
          ` A refused verdict is not a refused corpus - the ${claims.verified} verified claim(s) are unaffected.`;
    // WHAT CHANGED: this returned `failed` here, before the rate was read.
    // One false row anywhere refused the whole run - notification-ms
    // 20260921T184935Z, 3 of 110 false, 97.9% live code, suite passing, was
    // the only run of the batch that reached this line, and it delivered as a
    // failure. The false sides are uncovered and already in the denominator,
    // and each is named in `missing`. A run with any of them cannot be
    // `succeeded`, so the verdict is `partial`, and the rate is still read.
    falseSentence =
      `${claimsFalse} of ${claims.checked} \`reaches\` claims are FALSE (${rate}%) - the input never ` +
      `reached the side it was written for, so those sides are uncovered; each is in \`missing\` as a ` +
      `false-claim.${sound}`;
  }

  // THE RATE, AND WHAT IT NO LONGER DECIDES. It used to be the rule that a run
  // below its target is not a success; since 2026-09-25 the target is reported
  // beside the verdict instead (see THE TARGET IS REPORTED, NOT GATED below).
  // What follows is still why the comparison is made, and made strictly.
  //
  // `claimsFalse` above catches a run that froze the wrong arm. Nothing caught
  // a run that simply did not get there: run 20260915T033521Z exited 0 at 65.9%
  // and opened a pull request thirty points below the mocked run beside it.
  // `coverage-ratchet` does not cover this and cannot - it asks whether the
  // union fell below the pre-existing suite, which 65.9% passed comfortably.
  //
  // The target is per MODE and it never moves to meet the run. When the
  // comparison cannot be MADE - an unstamped mode, a coverage document with no
  // live-code pair - that is its own failure and says so, rather than falling
  // back to a rate against a denominator the pipeline's own rules forbid
  // reaching. See targets.mjs.
  const verdict = rateVerdict(t, doc.mode ?? null, env);
  // THE RUN'S OWN VERDICT IS STRICT WHERE THE GATE IS NOT.
  //
  // `rateVerdict` reports an unstamped mode as unjudgeable rather than an
  // error, because a gate reading an old artifact should print its rate and
  // move on. A RUN writing its own result.json is the other case: it knows what
  // mode it was launched in, and if that did not reach the artifact then the
  // number it is about to publish cannot be compared to anything. So here it is
  // a refusal, and the message says which input to fix.
  if (verdict.unjudgeable) {
    return {
      ...partialResult(
        `the run's rate cannot be compared to a target: ${verdict.unjudgeable}. ` +
        `Set CHARPILOT_MODE and re-run stage 6`
      ),
      ...rates,
      claims,
      missing,
    };
  }
  if (verdict.error) {
    return { ...partialResult(`the run's rate cannot be compared to a target: ${verdict.error}`), ...rates, claims, missing };
  }
  // FIX PLAN 1, RULE 3: A SUCCESS LEAVES NO SIDE UNRULED. coverage.mjs rules
  // every uncovered side `unreachable`, `pipeline_defect` or `open`; only the
  // first is allowed in a success. A document written before the rulings
  // existed carries no tally and is judged as it always was.
  // FIX PLAN 1, F1.5: the walk's own account of the steps whose tool failed
  // (out/defects.json, beside this coverage document). A tool defect is a
  // pipeline_defect; the sides it names are moved to that ruling, and it
  // makes the run `failed` with its numbers like any other. A step that was
  // only BLOCKED is named, and keeps the run from succeeding.
  const { toolDefects: stepToolDefects, blockedSteps, notes: infoRows } = stepDefects(join(dirname(coveragePath), "defects.json"));
  // D37: THE SIDES THIS MEASUREMENT STILL COUNTS AS LOST - uncovered and not
  // ruled unreachable. A side covered by another row, or ruled unreachable with
  // a reason, is not lost to any tool, whatever a step said about it earlier.
  const atStake = new Set(
    (doc.stillUncovered ?? []).filter((r) => r?.ruling?.state !== "unreachable").map((r) => sideKey(`${r.armId}[${r.side}]`))
  );
  const affectedBy = (d) => (d.sides ?? []).filter((k) => atStake.has(sideKey(k))).length;
  // D37: A WITHHOLD THAT COSTS NO SIDE IS A NOTE, NOT A FAILURE. cigate
  // withholding a row takes away exactly the sides that row claims; when every
  // one of them is covered or ruled otherwise, the suite lost nothing and the
  // run is as good as it was. email-centralization-ms, September 2026: two
  // isFromRecruiter rows withheld, both sides already ruled unreachable by
  // BLOCKED.md entries, and the run ended `failed` "in 0 class(es): .". A
  // withhold whose suite was ALSO red for reasons no row explains is never one
  // of these (withheldRowsOf).
  const costless = [];
  const toolDefects = [];
  for (const d of stepToolDefects) {
    const w = withheldRowsOf(d);
    if (w && affectedBy(d) === 0) costless.push({ d, w });
    else toolDefects.push(d);
  }
  const named = new Set(toolDefects.flatMap((d) => d.sides ?? []).map(String));
  let moved = 0;
  for (const row of doc.stillUncovered ?? []) {
    if (row?.ruling?.state !== "open") continue;
    if (!named.has(`${row.armId} [${row.side}]`) && !named.has(`${row.armId}[${row.side}]`)) continue;
    const d = toolDefects.find((x) => (x.sides ?? []).some((k) => k === `${row.armId} [${row.side}]` || k === `${row.armId}[${row.side}]`));
    row.ruling = { state: "pipeline_defect", why: `${d.step}: ${d.message}`.slice(0, 400), saidBy: d.tool ?? d.step };
    moved += 1;
  }
  const withholdNotes = costless.map(({ d, w }) => ({
    step: d.step,
    tool: d.tool ?? null,
    message:
      `${d.step}: cigate withheld ${w.count} row(s) (0 sides affected)${w.ids.length ? `: ${w.ids.join(", ")}` : ""} - ` +
      `each side they claim (${(d.sides ?? []).length}) is covered by another row or ruled unreachable, so the suite lost ` +
      "nothing; the rows stay in the suite as it.skip with their error, and can be withdrawn",
    withheld: w.ids,
  }));
  // Listed with the step notes (build), on whichever verdict this returns.
  const withNotes = (v) => (withholdNotes.length ? { ...v, notes: withholdNotes } : v);
  // D31: THE SIDES A STALL LEFT OPEN keep `open` - an agent asked twice that
  // could not close a side is not a tool failure - and carry the stall as the
  // recorded reason. The walk writes them as a non-blocking `stalled` row.
  const stallOf = new Map();
  for (const d of infoRows.filter((x) => x?.kind === "stalled")) {
    for (const s of d.sides ?? []) stallOf.set(String(s).replace(/\s+\[/, "["), d);
  }
  const stalled = [];
  for (const row of doc.stillUncovered ?? []) {
    if (row?.ruling?.state !== "open") continue;
    const d = stallOf.get(`${row.armId}[${row.side}]`);
    if (!d) continue;
    row.ruling = { state: "open", why: `stalled: ${d.message}`.slice(0, 400), saidBy: d.tool ?? d.step, stalled: true };
    stalled.push(`${row.armId} [${row.side}]`);
  }
  const r0 = t.rulings ?? null;
  const r = r0 ? { ...r0, open: (r0.open ?? 0) - moved, pipeline_defect: (r0.pipeline_defect ?? 0) + moved } : null;
  const rulings = r ? { unreachable: r.unreachable ?? 0, pipeline_defect: r.pipeline_defect ?? 0, open: r.open ?? 0 } : null;
  // D56: THE SIDES OPEN BECAUSE THEIR DECLARATION WAS REFUSED. Written about,
  // so "no reason is written for them" would be false; not ruled, so they stay
  // open; and not a tool failure - the ledger refusing an entry is the ledger
  // working, and the side is asked again with the refusal as its feedback.
  const refusedOpen = (doc.stillUncovered ?? [])
    .filter((row) => row?.ruling?.state === "open" && row.ruling.refused && !row.ruling.stalled)
    .map((row) => `${row.armId} [${row.side}]`);
  // D68: THE SIDES OPEN ON A REASON THE RECORDER GAVE THEIR ROW, which is the
  // proposal's to correct (a stale functionId, an undeclared boundary). Written
  // about, so they are not "no reason is written"; asked again with it.
  const askedOpen = (doc.stillUncovered ?? []).filter(
    (row) => row?.ruling?.state === "open" && !row.ruling.refused && !row.ruling.stalled && row.ruling.saidBy === "record.mjs"
  ).length;
  const unexplained = (rulings?.open ?? 0) - stalled.length - refusedOpen.length - askedOpen;
  const openSentence = rulings?.open
    ? [
        stalled.length
          ? `${stalled.length} side(s) are open after the agent was asked twice and no answer closed them (stalled): ` +
            `${stalled.join(", ")}.`
          : null,
        refusedOpen.length
          ? `${refusedOpen.length} side(s) are open because the declaration written for them was refused by ledger.mjs ` +
            `- a refused declaration rules nothing, and each carries the refusal on its ruling: ` +
            `${refusedOpen.slice(0, 10).join(", ")}${refusedOpen.length > 10 ? ` (+${refusedOpen.length - 10} more)` : ""}.`
          : null,
        askedOpen
          ? `${askedOpen} side(s) are open because the recorder refused or failed their row for a reason the proposal has to ` +
            `correct - each carries the recorder's sentence on its ruling, and is asked again with it.`
          : null,
        unexplained > 0 ? `${unexplained} side(s) are open - nothing covers them and no reason is written for them.` : null,
        "A success needs every uncovered side ruled unreachable with a reason; each is in out/coverage.json " +
          "stillUncovered[].ruling.",
      ]
        .filter(Boolean)
        .join(" ")
    : null;
  const blockedSentence = blockedSteps.length
    ? `${blockedSteps.length} step(s) could not run: ` +
      blockedSteps.map((b) => `${b.step}${b.blockedBy ? ` (blocked by defect ${b.blockedBy})` : ""} - ${String(b.message).slice(0, 160)}`).join("; ") +
      ". Named in out/defects.json."
    : null;
  // THE TARGET IS REPORTED, NOT GATED (rule set by the user, 2026-09-25).
  //
  // A run whose every side is covered or claimed has done all the work there
  // is: the rest is dead export, or a side the agent ruled unreachable with a
  // reason that no recorded row contradicted, and a person reviews those
  // claims on the pull request. Holding that run to a rate anyway would make
  // it `partial` for code that cannot run. So the verdict is decided by the
  // rulings alone (open -> partial, a tool failure -> failed), and the target
  // travels beside it as `target_met` and `target_note` so a reader still sees
  // how far the covered share is from it.
  const targetNote = verdict.pass ? null : `branch coverage is below the target for this mode - ${verdict.detail}`;
  const targetFacts = { target_met: Boolean(verdict.pass), ...(targetNote ? { target_note: targetNote } : {}) };
  // A document with no rulings tally (written before rule 3) cannot say whether
  // every side was covered or claimed, so for it the target still decides, as
  // it always did.
  const reasons = [
    ...(targetNote && !rulings ? [targetNote] : []),
    ...(falseSentence ? [falseSentence] : []),
    ...(openSentence ? [openSentence] : []),
    ...(blockedSentence ? [blockedSentence] : []),
  ];

  // FIX PLAN 1, RULE 3 AS THE USER SET IT (2026-09-23): an open side, a short
  // rate or a false claim is `partial` - the clock ran out before the work did.
  // A side a TOOL failed on or lost is a FAILURE: the pipeline is what is
  // wrong, and no amount of time would have covered it. It is a failed run
  // that still delivers - every number, the rulings and `missing` stay on the
  // document, and docker/finish.py opens a pull request for a `failed` with
  // numbers.
  if (rulings?.pipeline_defect || toolDefects.length) {
    // Side-level classes come off the rows (the ones moved above included);
    // a step-level defect that costs no side is its own class, counted 0 -
    // one that names no side, and (D37) one whose named sides are all covered
    // or ruled unreachable, which used to be in no class at all: "in 0
    // class(es): ." named neither the step nor the tool.
    const classes = [
      ...defectClasses(doc),
      ...toolDefects
        .filter((d) => affectedBy(d) === 0)
        .map((d) => ({
          class:
            `step ${d.step}${d.tool ? ` (${d.tool})` : ""}: ${String(d.message).split("\n")[0].slice(0, 160)}` +
            ((d.sides ?? []).length ? ` (0 of its ${(d.sides ?? []).length} side(s) affected)` : ""),
          count: 0,
          saidBy: d.tool ?? d.step,
          step: d.step,
        })),
    ];
    const toolSentence =
      (rulings?.pipeline_defect
        ? `${rulings.pipeline_defect} side(s) were lost to a tool that failed on them (pipeline_defect)`
        : `${toolDefects.length} step(s) of the walk failed in a tool`) +
      `, in ${classes.length} class(es): ${classes.map((c) => `${c.count} x ${c.class}`).join("; ")}. ` +
      "A tool failure is never a success and never only a partial; each side is named in `missing`.";
    return withNotes({
      status: "failed",
      failed_reason: [toolSentence, ...reasons].join(" "),
      pr_url: null,
      ...rates,
      claims,
      missing,
      rulings,
      pipeline_defects: classes,
      target: verdict.target,
      ...targetFacts,
    });
  }
  if (reasons.length) {
    return withNotes({ ...partialResult(reasons.join(" ")), ...rates, claims, missing, rulings, target: verdict.target, ...targetFacts });
  }

  return withNotes({
    status: "succeeded",
    // Filled in by whatever opens the pull request. This pack never touches
    // git, so it cannot know.
    pr_url: null,
    ...rates,
    target: verdict.target,
    ...targetFacts,
    // Fix plan 1, rule 3: how the uncovered sides were ruled. On a success
    // every one of them is `unreachable`, with its reason on the row.
    rulings,
    // CARRIED, ALWAYS. A percentage on its own is quotable without any sign
    // that most of its claims were never verified - 22 verified of 140 reads
    // exactly like 140 of 140 once the number leaves this file.
    claims,
    // D64 — live sides nothing exercised, with the recorder's own reason. It
    // is beside a `succeeded` status on purpose: the run cleared its target
    // AND there is live code in the denominator nobody drove, and both of
    // those are true at once.
    missing,
  });
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = resolve(i === -1 ? DEFAULT_OUT : argv[i + 1]);

  const result = build();

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);

  // Also to stdout, so a run's log carries the figures without anyone having
  // to fetch the file afterwards.
  process.stdout.write(`${JSON.stringify(result)}\n`);

  // Non-zero on failure, so a caller that ignores the file still notices. The
  // reason is in the file either way.
  if (result.status === "failed") process.exit(1);
}

// See the note in coverage.mjs: 26 of the tools here once executed on import.
// Its absence is an error rather than a fallback, because a pipeline that runs
// and does nothing reports success.
//
// The floor is 24.2, not 24. `import.meta.main` shipped in 24.2.0, so on
// 24.0.x this throws -- as do the other tools here, whose message says ">= 24"
// and is a minor version optimistic.
if (import.meta.main === undefined) {
  throw new Error(
    `charpilot requires Node >= 24.2: import.meta.main is unavailable on ${process.version}`,
  );
}
if (import.meta.main) {
  main();
}
