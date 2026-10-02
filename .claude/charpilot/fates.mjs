#!/usr/bin/env node
/**
 * WHERE THE WORK WENT — one terminal fate per side, and the tool that lost it.
 *
 *   node tools/fates.mjs --run docker/runs/20260920T030124Z
 *   node tools/fates.mjs --run docker/runs/20260919T092410Z --json
 *
 * THE QUESTION THIS ANSWERS, AND WHY NOTHING ELSE COULD. A side's answer walks
 * a chain — propose, materialise, validate, record, determinism, emit,
 * coverage — and if each link keeps 90% of valid work, six of them deliver 53%.
 * Retention is therefore the largest single lever on `coverage_percentage`, and
 * until this file the pipeline could not measure one link of it. `packetcost.mjs`
 * measures exactly one: `sidesClaimed` against `sidesValidated`, which is
 * `validate` alone.
 *
 * EVERY OTHER COUNTER IN THIS PIPELINE COUNTS EVENTS, NOT FATES, and the two
 * are not the same number. From the two runs this file was built on:
 *
 *                              sides dealt   submissions refused   rows quarantined
 *   location-ms 20260920T030124Z    154              57                   5
 *   tracy       20260919T092410Z    476              72                  94
 *
 * Not one of those refusals is a loss. `derive`'s per-round counters are
 * re-scans of a directory that persists across rounds, so the same refused
 * submission is counted again every round it sits there — location-ms's 57 are
 * 20, 15, 15, 3, 2, 2 and 0 over seven rounds of a directory that was never
 * cleaned, and `quarantinedRows` is a CUMULATIVE snapshot, so tracy's "94" is
 * 15 + 36 + 43 where 43 is the whole quarantine and the other two are prefixes
 * of it. A row refused in round 2 and repaired in round 3 is indistinguishable
 * from a row refused and lost forever, in every number the run prints.
 *
 * SO THIS JOINS ON OUTCOMES AND NOT ON EVENTS. Each side in the run's own
 * universe is walked forward through the artifacts that survived the run, and
 * gets the ONE state it ended in. A side refused by `validate` in round 2 and
 * covered by round 4 is `covered`; the same side still absent at the end is
 * `lost`, and only then does it count against the tool that dropped it.
 *
 * JOINED ON SIDE IDS, WHICH IS `derive.answeredSideIds` AND NOT A SECOND
 * OPINION. Row ids are reused (`evaluateSalarySignal-35-binary-expr-1` names a
 * DIFFERENT claim in 20260919T092410Z's `behaviour.json` than it does in that
 * run's own proposals directory — the row was repaired between the two and the
 * id did not move), rows merge (`parseAddressesForJd-113-171-merged` answers
 * several sides at once), and `materialise` dedupes by id with a reserved-name
 * tie-break. The only thing that is one-to-one anywhere in this pipeline is the
 * SIDE. `packetCompletion` already says this in its own header; this file
 * imports its join rather than restating it, and the one place a row id is used
 * at all — the recorder's `skipped` list, which carries no `reaches` — says so.
 *
 * IT MEASURES AND IT CHANGES NOTHING. Nothing here is imported by any step, no
 * round consults it, and it writes no artifact any tool reads. Every number is
 * derived from files the run already wrote, so there is no new seam for correct
 * work to fall through. It cannot raise `coverage_percentage` and it is not
 * meant to: it says WHICH TOOL to fix to raise it, which is a different and
 * cheaper thing to know.
 *
 * ------------------------------------------------------------------------
 * THE VOCABULARY, AND WHAT MAKES EACH STATE DISTINGUISHABLE FROM THE ARTIFACTS
 * ------------------------------------------------------------------------
 *
 *   covered            istanbul hit the side (it is absent from
 *                      `coverage.stillUncovered`) AND some recorded row's claim
 *                      for it is in `coverage.verified`. Aimed at, and landed.
 *
 *   covered-incidental istanbul hit it, and no claim names it. Real coverage
 *                      that nobody asked for — 150 of location-ms's sides are
 *                      `incidentalSides`. Kept separate from `covered` because
 *                      a retention figure that counts luck is not a retention
 *                      figure.
 *
 *   declared           a `blocked` fence in `proposals/BLOCKED.md` carries a
 *                      written reason for it, and istanbul did not hit it. This
 *                      is the only deliberate retraction the artifacts can
 *                      prove, so it is the one this file uses; a withdrawal
 *                      (`propose.mjs --withdraw`, which appends `withdrawn` to
 *                      the row) is reported separately as a ROW count, because
 *                      neither run on disk has one and a side-level state
 *                      nothing has ever produced would be an invented state.
 *
 *   never-answered     in the universe, and no document in the answers
 *                      directory ever named it. See the honest limit below: it
 *                      does NOT distinguish "dealt and nobody answered" from
 *                      "never dealt at all", because the archive cannot.
 *
 *   lost:<tool>        it was answered, and the answer stopped somewhere. The
 *                      tool is the FIRST gate the side failed, and it is
 *                      charged only when the side is still uncovered at the end
 *                      of the run.
 *
 * THE STATES DELIBERATELY NOT HERE. `superseded` is a real thing that happens —
 * `record.mjs` writes `overwrite.superseded` and `totals.supersededRows` for
 * rows a re-recording replaced — but it is a ROW fate and it is not terminal
 * for a SIDE: the side simply passes to the replacing row. It is reported in
 * the row census and never as a side's end state.
 *
 * ------------------------------------------------------------------------
 * THE GATES, IN ORDER, AND THE ARTIFACT THAT DECIDES EACH ONE
 * ------------------------------------------------------------------------
 *
 *   universe     `stages/worklist.json`. Every `uncoveredSides` entry of every
 *                INSTRUMENTED item — the same filter `openSides` applies, which
 *                is why location-ms's universe is 146 and not the 300 sides its
 *                252 items hold. `worklist.mjs` runs ONCE per run (verified in
 *                both logs: one `worklist: ran worklist.mjs` line each), so
 *                this file is the run's whole ask and not a round's.
 *
 *   propose      the answers directory. A side some submission's `reaches`
 *                names, or some `declarations` entry declares.
 *
 *   deadline     not a tool: every submission naming the side was written
 *                AFTER the last write in the proposals directory, so the run
 *                ended before the round that would have materialised it and no
 *                check ever judged the work. `lastMaterialisedAt` says how this
 *                is told apart and how weak the evidence for it is. It matters:
 *                without the split, 22 of 20260919T092410Z's sides read as
 *                `materialise` refusals and would have sent a fix at a tool
 *                that never opened the file.
 *
 *   materialise  the proposals directory. A side some LANDED row's `reaches`
 *                names, or `BLOCKED.md` declares. The gap between this and the
 *                one above — minus the deadline — is what `materialise`
 *                refused, and across every run on disk with full artifacts
 *                that is one side in total.
 *
 *   record       `stages/behaviour.json`, and it has two failures, not one.
 *                Recorded claims are read off `rows[].reaches` — the
 *                recording's OWN statement of what it observed — and never off
 *                the proposals directory filtered by recorded id, which is the
 *                trap the three `aiSalaryEvaluation.ts` sides of
 *                20260919T092410Z were caught in. The recorder's REFUSALS are
 *                `skipped[]`, which carries an id and a reason and no
 *                `reaches`, so those sides are resolved through the proposals
 *                directory and say so in their reason. And a row recorded with
 *                `invoked: false` is the quiet one: `coverage.mjs:563` gates
 *                its claim check on that field, so such a side is never
 *                verified, never FALSE and never unmeasurable — it is simply
 *                absent from the measurement, and it is charged here.
 *
 *   banking      not a tool: a row on disk that `record` never saw at all,
 *                because the round that would have banked it never finished.
 *                Charged separately from `record` on purpose — "the recorder
 *                refused this" and "the run died before the recorder looked"
 *                want completely different fixes, and 69 of tracy's 754 sides
 *                are the second one.
 *
 *   emit         `coverage.unmeasurable`. A row `quarantine.json` holds is
 *                emitted as `it.skip`, so its claim is neither true nor false;
 *                `coverage.mjs` says exactly that in its own reason string and
 *                this reads it back rather than re-deciding it.
 *
 *   aim          `coverage.falseClaims`. The test ran and did not enter the
 *                side it was written for. Charged to `aim` and not to
 *                `coverage`, because the measurement is right and the input is
 *                wrong — 52 of tracy's sides end here, which is its largest
 *                single tool loss.
 *
 * ------------------------------------------------------------------------
 * WHAT IS UNKNOWABLE FROM THE ARCHIVE, SAID HERE RATHER THAN LEFT TO BE FOUND
 * ------------------------------------------------------------------------
 *
 *   WHICH ROUND. The answers and proposals directories are LAST STATE, not
 *   history: a submission file is rewritten under the same reserved name each
 *   time its packet is re-answered, and the per-round packet briefs
 *   (`worklist-decisions.packets/`) are not archived at all. So "refused in
 *   round 2, repaired in round 3" is visible in the AGGREGATE (the counters say
 *   a refusal happened and the final state says the side is covered) and never
 *   per side. Fixing this needs an append-only per-round side ledger; nothing
 *   here can reconstruct one.
 *
 *   DEALT VERSUS UNDEALT. `derive` logs `open`, `handed` and `heldBack` as
 *   COUNTS and never as side ids. tracy held back 630, 550, 479 and 431 sides
 *   over its four rounds, so most of its 433 `never-answered` sides were never
 *   asked about — but which ones, and whether any given one was dealt and
 *   ignored, cannot be recovered. `never-answered` therefore means exactly
 *   "no submission ever named it" and claims nothing more.
 *
 *   A SIDE THAT WAS REFUSED AND THEN COVERED. It is `covered`, and this file
 *   cannot say it was ever refused. That is the point — the gross counters
 *   already say how many refusals happened, and this says how many cost
 *   anything. Reading the two side by side is the whole measurement, and
 *   `--json` prints both.
 *
 *   A MEASUREMENT TAKEN UNDER A RED SUITE. Both runs' `coverage.mjs` exited 1
 *   ("the suite under measurement did not pass"), which `coverage.mjs`'s own
 *   message calls an OVERSTATEMENT rather than a shortfall. Every `covered`
 *   here inherits that, and the tool prints `suitePassed` so a reader cannot
 *   miss it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PILOT_DIR = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(PILOT_DIR, "..", "out");
const WORK = join(OUT_DIR, "fates-work");

const ARGV = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const at = ARGV.indexOf(name);
  return at === -1 || at === ARGV.length - 1 ? fallback : ARGV[at + 1];
};

/* ------------------------------------------------------------------ the join */

/**
 * `derive`'s own side arithmetic, imported late for `packetcost.mjs`'s reason.
 *
 * `steps/derive.mjs` imports `config.mjs`, which resolves one repo from the CWD
 * and REFUSES a directory that is not a package root — and `nodejs/` is not
 * one, because it has no `src/`. A static import therefore kills this tool
 * before its first line. So a throwaway package root is created under this
 * tool's own work directory and `CHARPILOT_SELF_ROOT` is pointed at it, which
 * is the arrangement `fleetprobe.mjs` already uses. Nothing is ever written
 * into it, none of the module-scope constants config bakes from it are read —
 * every function below takes the directory it works on as an argument — and an
 * operator who has already set the variable keeps their value.
 */
let JOIN = null;
export async function loadJoin({ work = WORK } = {}) {
  if (JOIN) return JOIN;
  if (!process.env.CHARPILOT_SELF_ROOT) {
    const self = join(work, ".self-root");
    mkdirSync(join(self, "src"), { recursive: true });
    writeFileSync(join(self, "package.json"), '{"name":"fates-self","type":"module"}\n');
    process.env.CHARPILOT_SELF_ROOT = self;
  }
  const derive = await import("./steps/derive.mjs");
  const ledger = await import("./ledger.mjs");
  JOIN = {
    sideId: derive.sideId,
    sideIdOfKey: derive.sideIdOfKey,
    proposedSides: derive.proposedSides,
    declaredSides: derive.declaredSides,
    answeredSideIds: derive.answeredSideIds,
    sidesOf: ledger.sidesOf,
  };
  return JOIN;
}

/* --------------------------------------------------------------- the artifacts */

/**
 * Where an archived run keeps each thing this file reads.
 *
 * An archived run is `docker/runs/<stamp>/`: `stages/` is the run's `out/`,
 * `proposals/` and `answers/` are copied whole, and `log.jsonl` is the walk's
 * own line log. A LIVE checkout has the same four in different places, so each
 * is overridable and none is guessed from another.
 */
export function runPaths(dir, opts = {}) {
  const root = resolve(dir);
  return {
    root,
    worklist: opts.worklist ?? join(root, "stages", "worklist.json"),
    behaviour: opts.behaviour ?? join(root, "stages", "behaviour.json"),
    coverage: opts.coverage ?? join(root, "stages", "coverage.json"),
    determinism: opts.determinism ?? join(root, "stages", "determinism.json"),
    proposalsDir: opts.proposalsDir ?? join(root, "proposals"),
    answersDir: opts.answersDir ?? join(root, "answers"),
    log: opts.log ?? join(root, "log.jsonl"),
  };
}

/** A JSON artifact, or null when the run does not hold it. Absence is a fact, not a crash. */
export function readJson(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Which arm has which side labels, from the worklist the packets came out of.
 *
 * The same two lines `packetcost.mjs` writes, and for the same reason: the
 * index `derive.mjs` builds is private. `sides` and `uncoveredSides` are
 * unioned because a row may legitimately claim a side that was already covered.
 */
export function labelsByArmFrom(worklist) {
  return new Map((worklist?.items ?? []).map((i) => [i.armId, new Set([...(i.sides ?? []), ...(i.uncoveredSides ?? [])])]));
}

/**
 * The run's whole ask, as roster ids.
 *
 * INSTRUMENTED ONLY, which is `openSides`'s filter and not a new one: a side on
 * an arm istanbul never instrumented cannot be covered by anything and counting
 * it would put 154 permanent losses in location-ms's denominator that no tool
 * could ever have delivered.
 */
export function universeOf(worklist, sideId) {
  const out = new Set();
  for (const item of worklist?.items ?? []) {
    if (!item.instrumented) continue;
    for (const side of item.uncoveredSides ?? []) out.add(sideId(item.armId, side));
  }
  return out;
}

/**
 * Every side a `declarations` submission in `dir` names, as roster ids.
 *
 * `declaredSides` reads BLOCKED.md, which is what a declaration becomes AFTER
 * `blocked.mjs` materialises it. This reads the submission on the other side of
 * that seam — the raw `{"declarations":[…]}` document a worker writes — so the
 * two can be compared and `materialise`'s refusals attributed.
 */
/**
 * WHEN THE PIPELINE LAST MATERIALISED ANYTHING, as an epoch millisecond.
 *
 * The newest write in the proposals directory. It is the cutoff that separates
 * the two completely different things an unlanded submission can be:
 *
 *   REFUSED      written before this, and still not on disk as a row. Some
 *                check in `materialise` said no and the side came back open.
 *   NEVER LOOKED written after it. The run ended before the round that would
 *   AT           have materialised it, so no tool ever judged the work.
 *
 * MTIME IS THE ONLY EVIDENCE FOR THIS AND THE TOOL SAYS SO RATHER THAN HIDING
 * IT. The refusal REASONS live in pending items that no run archives, so the
 * archive can prove that a submission did not land and never why. What it can
 * do is separate the 5 submissions 20260919T092410Z's `materialise` actually
 * refused from the 14 its workers wrote between 19:02 and 19:28 against a
 * proposals directory whose last write is 18:52 — and charging those 14 to
 * `materialise` would have aimed a fix at a tool that never saw them. Null when
 * the directory is empty or its times are unreadable, and then every unlanded
 * submission is charged to `materialise`, which is the conservative direction:
 * it blames a tool that ran rather than excusing one.
 */
export function lastMaterialisedAt(proposalsDir) {
  if (!existsSync(proposalsDir)) return null;
  let newest = null;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json"))) {
    try {
      const at = statSync(join(proposalsDir, file)).mtimeMs;
      if (newest === null || at > newest) newest = at;
    } catch {
      // A file the archive holds a name for and not a stat. One unreadable
      // time must not move the cutoff.
    }
  }
  return newest;
}

/** When each submission file was last written, by name. */
export function submissionTimes(dir) {
  const times = new Map();
  if (!existsSync(dir)) return times;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    try {
      times.set(file, statSync(join(dir, file)).mtimeMs);
    } catch {
      times.set(file, null);
    }
  }
  return times;
}

export function declarationSubmissions(dir, labelsByArm, { sidesOf, sideId }) {
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      // An unreadable submission leaves its sides looking unanswered, which is
      // the safe direction: they are asked about rather than counted as work.
      continue;
    }
    for (const entry of doc?.declarations ?? []) {
      for (const side of sidesOf(entry?.side, labelsByArm.get(entry?.arm) ?? new Set())) out.add(sideId(entry.arm, side));
    }
  }
  return out;
}

/**
 * Every landed row, by id, with the sides it claims.
 *
 * Used for ONE thing: resolving the recorder's `skipped[]` entries, which carry
 * an id and a reason and no `reaches`. Everywhere else the side sets come from
 * `proposedSides`, which does not need a row id to exist.
 */
export function rowsById(proposalsDir, labelsByArm, { sidesOf, sideId }) {
  const rows = new Map();
  if (!existsSync(proposalsDir)) return rows;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json"))) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      continue;
    }
    (doc?.proposals ?? []).forEach((p, at) => {
      if (!p?.id) return;
      rows.set(p.id, {
        id: p.id,
        file,
        at,
        sides: claimedBy(p, labelsByArm, { sidesOf, sideId }),
        withdrawn: Array.isArray(p.withdrawn) && p.withdrawn.length > 0,
        // Fix plan 1, F3.3: the claims `propose.mjs --withdraw` moved off
        // `reaches`, each with the measurement's evidence.
        withdrawnClaims: (Array.isArray(p.withdrawn) ? p.withdrawn : [])
          .filter((w) => w?.arm && w?.side)
          .map((w) => ({ side: sideId(w.arm, w.side), evidence: w.evidence ?? null, artifact: w.artifact ?? null })),
      });
    });
  }
  return rows;
}

/** The sides one row's `reaches` names, as roster ids. */
export function claimedBy(row, labelsByArm, { sidesOf, sideId }) {
  const out = [];
  for (const [armId, value] of Object.entries(row?.reaches ?? {})) {
    for (const side of sidesOf(value, labelsByArm.get(armId) ?? new Set())) out.push(sideId(armId, side));
  }
  return out;
}

/**
 * What the recording itself says it observed, as roster ids.
 *
 * OFF `rows[].reaches` AND NOT OFF THE PROPOSALS DIRECTORY. The two disagree
 * whenever a row was repaired after the last recording, and the id does not
 * move when it is: 20260919T092410Z's `evaluateSalarySignal-35-binary-expr-1`
 * is recorded claiming the empty string and sits on disk claiming `""`, and a
 * join that trusted the id would have reported that side recorded when nothing
 * had ever recorded the claim it now makes. Three sides of that run turn on
 * this, and they are the difference between `covered` and `lost:banking`.
 */
/**
 * What the recording itself says it observed, split by whether the subject RAN.
 *
 * `invoked` is `record.mjs`'s own field and it is a gate, not a detail:
 * `coverage.mjs:563` builds its `recordedIds` as `rows.filter(r => r.invoked)`,
 * so a row recorded with `invoked: false` produces NO claim at all — not
 * verified, not FALSE, not unmeasurable. Its side simply never appears in the
 * measurement, and before this split it was the one side in three runs this
 * file could not place: `arg0-of-app-use-58-if-0` on 20260919T171842Z, an
 * express middleware the recorder held a row for and never called.
 */
export function recordedSidesOf(behaviour, labelsByArm, { sidesOf, sideId }) {
  const invoked = new Set();
  const notInvoked = new Set();
  for (const row of behaviour?.rows ?? []) {
    const target = row?.invoked === true ? invoked : notInvoked;
    for (const s of claimedBy(row, labelsByArm, { sidesOf, sideId })) target.add(s);
  }
  for (const s of invoked) notInvoked.delete(s);
  return { invoked, notInvoked };
}

/* --------------------------------------------------------------- the fates */

export const FATES = Object.freeze({
  COVERED: "covered",
  COVERED_INCIDENTAL: "covered-incidental",
  DECLARED: "declared",
  NEVER_ANSWERED: "never-answered",
  LOST: "lost",
});

/**
 * The gates a side can be lost at, in the order it meets them.
 *
 * `deadline` and `banking` are not tools and are named anyway: they are the two
 * ways a run ends holding correct work nothing judged — a submission written
 * after the last materialisation, and a row landed after the last recording.
 * Folding either into the tool beside it would send a fix at the wrong thing.
 */
export const TOOLS = Object.freeze(["deadline", "materialise", "record", "banking", "emit", "aim"]);

/**
 * One terminal state per side, and for a lost side the first gate it failed.
 *
 * THE ORDER IS THE WHOLE ALGORITHM and it is deliberately delivery-first: a
 * side istanbul hit is `covered` whatever happened to it on the way, because
 * this measures what a run DELIVERED and not how tidy its middle was. A side
 * refused by `validate` in round 2, repaired in round 3 and hit in round 4
 * costs `validate` nothing here, which is the correction this file exists to
 * make.
 *
 * `validate` HAS NO GATE OF ITS OWN, AND THAT IS A FINDING RATHER THAN AN
 * OMISSION. `derive`'s quarantine sets a refused row aside from the OPEN LIST
 * so its side is asked again; it does not delete the row, and `record.mjs`
 * records the whole proposals directory regardless — 20260919T092410Z recorded
 * 103 rows from a directory `derive` reported 43 quarantined rows in. So a
 * validate refusal costs ROUNDS, not coverage, and the only way it reaches this
 * ledger is through a gate further down. Charging it a side here would be
 * inventing a loss the artifacts do not show.
 */
export function fatesOf({ universe, submitted, landed, declared, recorded, notInvoked = new Set(), verified, skipped, seenByRecorder, unmeasurable, falseClaims, stillUncovered, unjudgedSubmissions = new Set(), withdrawn = new Map() }) {
  const fates = new Map();
  for (const side of universe) {
    if (!stillUncovered.has(side)) {
      // `verified` and not `recorded`: a recorded row may claim a side the
      // measurement then judged FALSE while a DIFFERENT row's execution walked
      // through it anyway. That side is covered and nobody aimed at it, which
      // is the distinction `coverage.mjs` calls `incidentalSides`.
      fates.set(side, { fate: verified.has(side) ? FATES.COVERED : FATES.COVERED_INCIDENTAL, tool: null, why: null });
      continue;
    }
    if (declared.has(side)) {
      fates.set(side, { fate: FATES.DECLARED, tool: null, why: "a written reason in BLOCKED.md" });
      continue;
    }
    if (!submitted.has(side)) {
      fates.set(side, { fate: FATES.NEVER_ANSWERED, tool: null, why: "no submission ever named it; whether it was dealt is not recoverable from the archive" });
      continue;
    }
    // A CLAIM WITHDRAWN ON EVIDENCE IS NOT LOST AT MATERIALISE. Its row is on
    // disk; `propose.mjs --withdraw` moved the claim off `reaches` because the
    // measurement proved it false (fix plan 1, F3.3). That is the aim missing,
    // measured - unless a later row claims the side again, which lands it.
    if (!landed.has(side) && withdrawn.has(side)) {
      const w = withdrawn.get(side);
      fates.set(side, {
        fate: FATES.LOST,
        tool: "aim",
        why:
          "withdrawn on the measurement's evidence - the emitted test ran and did not enter this side" +
          (w?.evidence ? ` (${typeof w.evidence === "string" ? w.evidence : JSON.stringify(w.evidence)})` : "") +
          (w?.artifact ? `, per ${w.artifact}` : ""),
      });
      continue;
    }
    if (!landed.has(side)) {
      fates.set(
        side,
        unjudgedSubmissions.has(side)
          ? { fate: FATES.LOST, tool: "deadline", why: "every submission naming it was written after the last materialisation the run completed, so nothing ever judged it" }
          : { fate: FATES.LOST, tool: "materialise", why: "submitted before the last materialisation, and no row carrying it reached the proposals directory" }
      );
      continue;
    }
    if (skipped.has(side)) {
      fates.set(side, { fate: FATES.LOST, tool: "record", why: skipped.get(side) });
      continue;
    }
    if (notInvoked.has(side)) {
      fates.set(side, {
        fate: FATES.LOST,
        tool: "record",
        why: "the recorder held a row for it and never invoked the subject, so coverage.mjs:563 never checked the claim — neither verified nor FALSE, just absent",
      });
      continue;
    }
    if (!recorded.has(side)) {
      fates.set(side, {
        fate: FATES.LOST,
        tool: "banking",
        why: seenByRecorder.has(side)
          ? "the recorder held a row for it and the claim on disk is a later, unrecorded one — the repair was never banked"
          : "it landed after the last recording the run completed, so nothing ever recorded it",
      });
      continue;
    }
    if (unmeasurable.has(side)) {
      fates.set(side, { fate: FATES.LOST, tool: "emit", why: unmeasurable.get(side) });
      continue;
    }
    if (falseClaims.has(side)) {
      fates.set(side, { fate: FATES.LOST, tool: "aim", why: "the emitted test ran and did not enter the side it claims" });
      continue;
    }
    // EVERY SIDE ENDS SOMEWHERE OR THIS FILE IS WRONG. A side that is recorded,
    // not quarantined, not false and still uncovered means the join disagrees
    // with the measurement, and saying so is worth more than picking a bucket.
    fates.set(side, { fate: FATES.LOST, tool: "unattributed", why: "recorded, not quarantined, not a false claim, and istanbul still reports it uncovered" });
  }
  return fates;
}

/**
 * The funnel, as the counts a retention argument is made of.
 *
 * `kept` is delivery: `covered` plus `covered-incidental`. `declared` is
 * neither kept nor lost — a written reason is the run doing its job — so it has
 * a column of its own and is excluded from the retention denominator, exactly
 * as `correctedSides` excludes dead-export sides from `coverage.mjs`'s.
 */
export function funnelOf(fates) {
  const byFate = new Map();
  const byTool = new Map();
  for (const { fate, tool } of fates.values()) {
    byFate.set(fate, (byFate.get(fate) ?? 0) + 1);
    if (fate === FATES.LOST) byTool.set(tool, (byTool.get(tool) ?? 0) + 1);
  }
  const universe = fates.size;
  const declared = byFate.get(FATES.DECLARED) ?? 0;
  const kept = (byFate.get(FATES.COVERED) ?? 0) + (byFate.get(FATES.COVERED_INCIDENTAL) ?? 0);
  const judged = universe - declared;
  return {
    universe,
    declared,
    kept,
    judged,
    retention: judged ? kept / judged : null,
    byFate: Object.fromEntries([...byFate].sort((a, b) => b[1] - a[1])),
    byTool: Object.fromEntries([...byTool].sort((a, b) => b[1] - a[1])),
  };
}

/**
 * THE CHAIN, ONE LINK AT A TIME — the table the "ten stages at 90% deliver 35%"
 * argument has always been made without.
 *
 * Each link's denominator is what REACHED it: the ask, less every side an
 * earlier link lost, less the declared sides, which are the run doing its job
 * and belong in no link's denominator. Its retention is what walked out.
 *
 * READ THIS AND NOT THE PER-TOOL TOTALS when the question is where to spend.
 * A gate that loses 52 of 745 and a gate that loses 52 of 90 are the same
 * number and completely different problems, and only the denominator says
 * which one is in front of you.
 */
export function linksOf(fates) {
  const order = ["propose", ...TOOLS];
  const loss = new Map(order.map((k) => [k, 0]));
  let declared = 0;
  for (const { fate, tool } of fates.values()) {
    if (fate === FATES.DECLARED) declared += 1;
    else if (fate === FATES.NEVER_ANSWERED) loss.set("propose", loss.get("propose") + 1);
    else if (fate === FATES.LOST) loss.set(tool, (loss.get(tool) ?? 0) + 1);
  }
  let entered = fates.size - declared;
  const links = [];
  for (const link of order) {
    const lost = loss.get(link) ?? 0;
    links.push({ link, entered, lost, left: entered - lost, retention: entered ? (entered - lost) / entered : null });
    entered -= lost;
  }
  return links;
}

/* ----------------------------------------------------------- the gross counters */

/**
 * `derive`'s own per-round counters, so the gross and the net can be read side
 * by side.
 *
 * READ OFF THE WALK'S LINE LOG, which prints `derive: <key>=<value>` once per
 * round. Two of these do not mean what a reader assumes and the reader should
 * be told rather than protected: `submissionsRefused` is a re-scan of a
 * directory that persists, so one unfixed submission is counted every round it
 * sits there; `quarantinedRows` and `proposed` are CUMULATIVE snapshots of the
 * whole proposals directory, so summing them across rounds counts the same rows
 * up to N times. The sums are printed anyway, labelled, because they are the
 * numbers that have been quoted, and the point is to show what they are worth.
 */
export function roundMetrics(logPath) {
  if (!existsSync(logPath)) return [];
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const rounds = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.phase !== "steps" || typeof event.msg !== "string") continue;
    const round = /^round (\d+)\/\d+/.exec(event.msg);
    if (round) {
      current = { round: Number(round[1]), metrics: {} };
      rounds.push(current);
      continue;
    }
    const metric = /^([a-z]+): ([A-Za-z0-9_]+)=(.*)$/.exec(event.msg);
    if (!metric || !current) continue;
    const value = Number(metric[3]);
    current.metrics[`${metric[1]}.${metric[2]}`] = Number.isFinite(value) ? value : metric[3];
  }
  return rounds;
}

/** One key summed over the rounds that carry it, with the rounds it came from. */
export function sumOver(rounds, key) {
  const seen = rounds.map((r) => r.metrics[key]).filter((v) => typeof v === "number");
  return { total: seen.reduce((n, v) => n + v, 0), rounds: seen.length, values: seen };
}

/* ---------------------------------------------------------------- the reading */

/** Everything this file knows about one run, computed. */
export async function readRun(dir, opts = {}) {
  const join_ = await loadJoin(opts);
  const { sideId, sidesOf, proposedSides, declaredSides, answeredSideIds } = join_;
  const paths = runPaths(dir, opts);
  const worklist = readJson(paths.worklist);
  if (!worklist) throw new Error(`fates: ${paths.worklist} is missing or unreadable — this reads an archived run directory (docker/runs/<stamp>) or a live out/ via --worklist`);
  const behaviour = readJson(paths.behaviour) ?? {};
  const coverage = readJson(paths.coverage) ?? {};

  const labelsByArm = labelsByArmFrom(worklist);
  const universe = universeOf(worklist, sideId);

  const submittedProposals = proposedSides(paths.answersDir, labelsByArm);
  const submitted = new Set([...answeredSideIds({ proposed: submittedProposals }), ...declarationSubmissions(paths.answersDir, labelsByArm, { sidesOf, sideId })]);

  // THE EARLIEST MOMENT ANY SUBMISSION NAMED EACH SIDE, against the last
  // materialisation. `proposedSides` already carries the file each claim came
  // from (`<file>::<id>`), so this is a re-read of the map it returns and not a
  // second walk of the directory with its own opinion about what a claim is.
  const cutoff = lastMaterialisedAt(paths.proposalsDir);
  const times = submissionTimes(paths.answersDir);
  const firstSubmittedAt = new Map();
  for (const [key, claims] of submittedProposals) {
    const side = join_.sideIdOfKey(key);
    for (const claim of claims) {
      const at = times.get(String(claim).split("::")[0]);
      if (typeof at !== "number") continue;
      if (!firstSubmittedAt.has(side) || at < firstSubmittedAt.get(side)) firstSubmittedAt.set(side, at);
    }
  }
  const unjudgedSubmissions = new Set();
  if (typeof cutoff === "number") for (const [side, at] of firstSubmittedAt) if (at > cutoff) unjudgedSubmissions.add(side);
  const landedDeclared = declaredSides(paths.proposalsDir, labelsByArm);
  const landed = answeredSideIds({ proposed: proposedSides(paths.proposalsDir, labelsByArm), declared: landedDeclared });
  const declared = answeredSideIds({ declared: landedDeclared });

  const rows = rowsById(paths.proposalsDir, labelsByArm, { sidesOf, sideId });
  const { invoked: recorded, notInvoked } = recordedSidesOf(behaviour, labelsByArm, { sidesOf, sideId });
  const seenByRecorder = new Set();
  for (const row of behaviour?.rows ?? []) if (row?.id && rows.has(row.id)) for (const s of rows.get(row.id).sides) seenByRecorder.add(s);

  // The recorder's refusals carry an id and a reason and no `reaches`, so they
  // are the one place a row id is joined on. Flagged in the reason it prints.
  const recorderSaw = new Set([...(behaviour?.rows ?? []).map((r) => r?.id), ...(behaviour?.skipped ?? []).map((s) => s?.id)].filter(Boolean));
  const skipped = new Map();
  for (const entry of behaviour?.skipped ?? []) {
    for (const side of rows.get(entry?.id)?.sides ?? []) if (!skipped.has(side)) skipped.set(side, `the recorder refused it: ${entry.reason}`);
  }

  const unmeasurable = new Map();
  for (const u of coverage?.unmeasurable ?? []) if (u?.side) unmeasurable.set(sideId(u.armId, u.side), u.why ?? "the measurement could not ask about this claim");
  const falseClaims = new Set((coverage?.falseClaims ?? []).map((f) => sideId(f.armId, f.side)));
  const verified = new Set((coverage?.verified ?? []).map((v) => sideId(v.armId, v.side)));
  const stillUncovered = new Set((coverage?.stillUncovered ?? []).map((s) => sideId(s.armId, s.side)));

  const withdrawn = new Map();
  for (const row of rows.values()) for (const w of row.withdrawnClaims ?? []) if (!withdrawn.has(w.side)) withdrawn.set(w.side, w);
  const fates = fatesOf({ universe, submitted, landed, declared, recorded, notInvoked, verified, skipped, seenByRecorder, unmeasurable, falseClaims, stillUncovered, unjudgedSubmissions, withdrawn });
  return {
    run: paths.root.split("/").filter(Boolean).pop(),
    paths,
    lastMaterialisedAt: cutoff,
    suitePassed: coverage?.suitePassed ?? null,
    coverageTotals: coverage?.totals ?? null,
    sets: { universe, submitted, landed, declared, recorded, verified, stillUncovered },
    rows: {
      landed: rows.size,
      recorded: new Set((behaviour?.rows ?? []).map((r) => r.id)).size,
      recordedEntries: (behaviour?.rows ?? []).length,
      skipped: (behaviour?.skipped ?? []).length,
      dropped: (behaviour?.droppedAnswers ?? []).length,
      superseded: behaviour?.totals?.supersededRows ?? 0,
      withdrawn: [...rows.values()].filter((r) => r.withdrawn).length,
      neverSeenByRecorder: [...rows.keys()].filter((id) => !recorderSaw.has(id)).length,
    },
    fates,
    funnel: funnelOf(fates),
    rounds: roundMetrics(paths.log),
  };
}

/* ------------------------------------------------------------------ the report */

const log = (s) => process.stdout.write(`${s}\n`);
const pct = (n) => (n === null ? "  n/a" : `${(n * 100).toFixed(1)}%`);

export function render(read) {
  const { funnel, rows, rounds } = read;
  log(`\n  ${read.run} — ${funnel.universe} instrumented uncovered side(s) in the worklist\n`);
  log(`    delivered             ${String(funnel.kept).padStart(4)}   ${pct(funnel.retention)} of the ${funnel.judged} side(s) the run had to deliver`);
  for (const [fate, n] of Object.entries(funnel.byFate)) log(`      ${fate.padEnd(20)}${String(n).padStart(4)}`);
  if (read.coverageTotals) {
    const t = read.coverageTotals;
    log(
      `\n    the acceptance test, for scale: ${pct((t.hitByEither ?? 0) / (t.sides || 1))} of the repo's ${t.sides} side(s) — ` +
        `${t.baselineSuiteCovered} were already covered before this run, so the ${funnel.universe} above are the only ones it could move`
    );
  }
  log(`\n    the chain, one link at a time — "entered" is what reached it, "kept" is what walked out:`);
  log(`      link              entered   lost    kept   retention`);
  for (const l of linksOf(read.fates)) {
    log(`      ${l.link.padEnd(16)}${String(l.entered).padStart(7)}${String(l.lost).padStart(7)}${String(l.left).padStart(8)}      ${pct(l.retention)}`);
  }
  if (Object.keys(funnel.byTool).length) {
    log(`\n    lost, by the FIRST gate the side failed — counted only when it was never recovered:`);
    const whyByTool = new Map();
    for (const { fate, tool, why } of read.fates.values()) {
      if (fate !== FATES.LOST) continue;
      if (!whyByTool.has(tool)) whyByTool.set(tool, new Map());
      const bucket = whyByTool.get(tool);
      bucket.set(why, (bucket.get(why) ?? 0) + 1);
    }
    for (const [tool, n] of Object.entries(funnel.byTool)) {
      log(`      ${tool.padEnd(20)}${String(n).padStart(4)}   ${pct(n / funnel.judged)} of the ask`);
      for (const [why, k] of [...(whyByTool.get(tool) ?? new Map())].sort((a, b) => b[1] - a[1])) {
        log(`        ${String(k).padStart(4)}  ${why}`);
      }
    }
  }
  log(`\n    rows: ${rows.landed} landed · ${rows.recorded} recorded · ${rows.skipped} refused by the recorder · ${rows.neverSeenByRecorder} never seen by it · ${rows.superseded} superseded · ${rows.withdrawn} withdrawn`);
  if (read.suitePassed === false) {
    log(`    ! the suite was RED when this was measured, so every "delivered" above is coverage.mjs's stated OVERSTATEMENT, not a shortfall`);
  } else if (read.suitePassed === null) {
    log(`    ! this run's coverage.json carries no \`suitePassed\`, so whether the numbers above were measured under a green suite is unrecorded`);
  }
  if (rounds.length) {
    const refused = sumOver(rounds, "derive.submissionsRefused");
    const quarantined = sumOver(rounds, "derive.quarantinedRows");
    const handed = sumOver(rounds, "derive.handed");
    const undealt = funnel.universe - handed.total;
    log(`\n    the gross counters, for contrast — NONE of these is a loss:`);
    log(
      `      sides dealt            ${String(handed.total).padStart(4)}   summed over ${handed.rounds} round(s) against ${funnel.universe} distinct side(s) ever open — ` +
        (undealt > 0
          ? `at least ${undealt} were never dealt at all, and WHICH ones is not in the archive`
          : `so ${-undealt} of these are re-asks of a side already dealt`)
    );
    log(`      submissions refused    ${String(refused.total).padStart(4)}   ${refused.values.join(" + ")} — a re-scan of a directory that persists, so one unfixed submission is counted every round`);
    log(`      rows quarantined       ${String(quarantined.total).padStart(4)}   ${quarantined.values.join(" + ")} — CUMULATIVE snapshots, so this sum counts the same rows several times; the last value is the whole quarantine`);
    log(`      lost to them           ${String(funnel.byTool.materialise ?? 0).padStart(4)}   side(s) actually lost at materialise, and 0 at validate: a quarantined row is still recorded`);
  }
  log("");
}

function main() {
  const dir = arg("--run");
  if (!dir) {
    process.stderr.write(
      "usage: node tools/fates.mjs --run docker/runs/<stamp> [--json]\n" +
        "  one terminal fate per side, and the tool that lost it. Read-only.\n"
    );
    process.exit(2);
  }
  return readRun(dir).then((read) => {
    if (ARGV.includes("--json")) {
      log(
        JSON.stringify(
          {
            run: read.run,
            suitePassed: read.suitePassed,
            funnel: read.funnel,
            links: linksOf(read.fates),
            rows: read.rows,
            gross: {
              handed: sumOver(read.rounds, "derive.handed"),
              submissionsRefused: sumOver(read.rounds, "derive.submissionsRefused"),
              quarantinedRows: sumOver(read.rounds, "derive.quarantinedRows"),
              validationFaults: sumOver(read.rounds, "derive.validationFaults"),
            },
            lost: [...read.fates].filter(([, v]) => v.fate === FATES.LOST).map(([side, v]) => ({ side, tool: v.tool, why: v.why })),
          },
          null,
          2
        )
      );
      return;
    }
    render(read);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  });
}
