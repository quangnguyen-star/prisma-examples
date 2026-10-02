/**
 * record — each input run against the real boundary policy, both halves of
 * what it did written down.
 *
 * THIS STEP NEVER DECIDES WHETHER A RUN BILLS. record.mjs already owns that
 * decision and owns it in one place — `liveDecision` (stagingenv.mjs:732),
 * which record.mjs:333 calls and which outranks the command line in the one
 * direction that matters: `CHARPILOT_MODE=mocked` is the operator saying what
 * the run is for, and no argv may overrule it. In `live` mode every row is a
 * real billed request against staging and `--fresh` drops the cache so they are
 * billed a second time.
 *
 * So this step spawns `record.mjs` WITH NO ARGUMENTS AT ALL and hands it the
 * environment it was given. It adds no `--live`, no `--live-providers` and no
 * `--fresh`; a step that quietly turned a mocked round into a billed one would
 * be the worst defect available here, and a step that re-billed a cached round
 * is the same defect one flag along. What it does instead is SAY the mode: the
 * first `did` line names the decision and the reason record.mjs will act on, so
 * a run's log states which mode it was in rather than leaving a reader to infer
 * it from a bill. Run 20260916T031317Z had to infer it.
 *
 * WHAT `satisfied` ASKS. The artifact has to ACCOUNT FOR every proposal, not
 * merely exist. record.mjs writes rows for what it ran and `skipped` entries —
 * with a written reason — for what it could not (record.mjs:2545-2554), and a
 * proposal that appears in neither is one this document never saw: an input
 * derived after the recording, which reads exactly like an input that was
 * recorded and produced nothing. Requiring a ROW instead would be wrong in the
 * other direction and permanently so — run 20260916T031317Z had 68 proposals
 * with a real unrunnable reason, and a step waiting for rows they can never
 * have would never finish.
 *
 * AND ACCOUNTING FOR AN ID IS NOT ENOUGH ON ITS OWN. That is the whole of the
 * section headed "AN ID IS NOT AN OBSERVATION" below, and it is what made the
 * repair loop structurally incapable of working for the nine rounds of run
 * 20260916T223906Z: a proposal SKIPPED once was accounted for ever, however
 * many times the agent repaired it, so the recorder never ran again and the
 * repair could not reach it. `satisfied` asks both halves.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  BEHAVIOUR_JSON,
  CONFIG_DIR,
  CORPUS_REL,
  INCREMENTAL_RECORD,
  OUT_DIR,
  PILOT_DIR,
  PROPOSALS_DIR,
  REPO_ROOT,
  SELF_REPO_ROOT,
} from "../config.mjs";
import { WALK_ID_ENV, incrementalOn, readDirty, sha256, writeDirty } from "../incremental.mjs";
import { environmentDefect, environmentFailures, failedOnPlaceholder, placeholderRowsAreStale } from "../prismaclient.mjs";
import { readRecorded } from "../recordedstore.mjs";
import { check as freshnessOf } from "../freshness.mjs";
import { liveDecision } from "../stagingenv.mjs";
// D54: the Node the repo's CI runs (cinode.mjs).
import { targetNode, targetNodeLine } from "../cinode.mjs";
import { here, runTool } from "./preflight.mjs";

export const NAME = "record";

/**
 * Which artifact this round's rows are in, resolved exactly as record.mjs
 * resolves it at record.mjs:492-498.
 *
 * NOT always `behaviour.json`. A live run writes `behaviour-live.json`, because
 * a mocked capture and a staging capture are not interchangeable and one must
 * never be read as the other. A `satisfied` that only ever looked at
 * `behaviour.json` would therefore report every live round as never-done, re-run
 * it, and BILL IT AGAIN — the precise failure this step is written to avoid.
 *
 * The `--only` arm of record.mjs's own precedence is absent here because this
 * step never passes `--only`: a partial capture is a thing an agent asks for by
 * hand, not something the walk produces.
 */
export function recordedArtifact() {
  if (process.env.CHARPILOT_OUTPUT) return resolve(process.env.CHARPILOT_OUTPUT);
  return mode().live ? join(OUT_DIR, "behaviour-live.json") : BEHAVIOUR_JSON;
}

/** The mode record.mjs will act on, from the one function record.mjs asks. */
export function mode() {
  return liveDecision({ outDir: OUT_DIR, argv: [] });
}

/* --------------------------------------------------------------------------
 * AN ID IS NOT AN OBSERVATION. WHICH VERSION OF THE INPUT WAS RUN IS.
 *
 * THE DEFECT, run `20260916T223906Z` at 01:54:13Z. `satisfied` asked only
 * whether every proposal id appeared in `rows` or `skipped`, so a proposal
 * skipped ONCE was accounted for ever — however many times the agent repaired
 * it. The log reads:
 *
 *     record: already done
 *     determinism: already done
 *     emit: already done
 *     measure: already done
 *     repair: read 133 still-uncovered side(s) … 234/367 sides hit
 *
 * `stillUncovered=133` is identical in rounds 7, 8 and 9. The repair agent
 * changed boundary definitions for an hour and its output could not reach the
 * recorder BY CONSTRUCTION, because nothing between the two of them asked what
 * had changed. The run then died of its round budget with no result.
 *
 * THE UNIT IS THE PROPOSAL, NOT THE FILE AND NOT THE DIRECTORY. A `satisfied`
 * that is simply false re-records all 135 rows every round, and recording is
 * the expensive stage — stage 4 spent 14.3 minutes on ~132 rows on run
 * `20260916T031317Z`, and re-recording them buys none of it back. (This cited
 * `20260916T095353Z` as "where per-row work made a round 56% slower". Its
 * rounds ran 28.2, 43.8 and 11.5 minutes with 0, 1 and 4 verify-on-write
 * recordings: the 56% is real round over round, the attribution to per-row
 * work is not.) So the question is asked per id, and a round that changed
 * nothing has nothing to re-record and spawns nothing.
 *
 * THE NOTION OF "CHANGED" IS THE ONE ALREADY IN THE PIPELINE, and it is not a
 * new one. Two answers exist on disk and this file invents neither:
 *
 *   A ROW carries the recorder's own stamp. record.mjs:1577
 *     (`proposalFingerprint`) hashes the fields that decide what a run IS —
 *     `args`, `boundaries`, `invoke`, `setup`, `via`, `covers`, `reaches`,
 *     `functionId` — and record.mjs:2258 writes that hash onto the cached row,
 *     which record.mjs:2696 then publishes into the artifact as
 *     `__fingerprint`. record.mjs:1969-1977 re-runs a cached row whose
 *     fingerprint moved, and its own comment says why: "editing a proposal's
 *     args, boundaries or invoke recipe left its old observation in the cache
 *     and the next run served it … The row is cited, internally consistent, and
 *     describes a program that no longer exists." `supersededFingerprint` below
 *     is that same hash, field for field and in the same order, so the step and
 *     the tool cannot disagree about which rows are stale — a second,
 *     differently-defined notion is how the two would drift apart.
 *
 *   A SKIP carries nothing. record.mjs:2711-2714 writes `{ id, file, reason }`
 *     and no fingerprint, so there is no stamp to compare and the only evidence
 *     the disk holds is WHEN the input was last written. That is exactly the
 *     question derive.mjs:2748 (`changedSince`) asks of its own per-proposal
 *     artifacts, and it is asked here the same way and against the same clock:
 *     an artifact OLDER than the proposal file is not an observation of it. It
 *     is coarser than the row answer — one edited proposal re-opens every SKIP
 *     in its file — and that is the recorder's stamp missing, not a second
 *     definition. Rows in that file are untouched, so the expensive half stays
 *     per-proposal.
 *
 * `skipped` STILL COUNTS AS ACCOUNTED, and that half was never wrong. Run
 * `20260916T031317Z` had 68 proposals with a real unrunnable reason; a step
 * waiting for rows they can never have would never finish. What changes is that
 * an UNCHANGED skip and a REPAIRED skip stop being the same thing.
 *
 * INVALIDATION IS ONE ITEM, NOT FOUR. `supersededReason` below is read by
 * `determinism`, `emit` and `measure` as well, because a determinism verdict or
 * an emitted test that outlives the recording it judges describes a program
 * that no longer exists and nothing says so. Re-recording is what drops the
 * determinism stamp — record.mjs:2696 republishes rows from the cache, which
 * determinism.mjs never writes to — so the order is forced: re-record, re-stamp,
 * re-emit, re-measure. Invalidating the stamp without re-recording, or the
 * recording without the stamp, both end at record.mjs:1949 refusing the run.
 * ------------------------------------------------------------------------ */

/**
 * The fields that decide whether two proposals are the same input, in the order
 * record.mjs:1577 writes them into its own hash.
 *
 * THE ORDER IS PART OF THE VALUE. `JSON.stringify` emits keys in insertion
 * order, so a list in a different order produces a different digest for the
 * same proposal and this step would then disagree with the recorder's cache
 * about every row. Exported so a test can hold it against record.mjs's own
 * source rather than against a remembered list.
 */
export const FINGERPRINTED_FIELDS = Object.freeze([
  "args",
  "boundaries",
  "invoke",
  "setup",
  "via",
  "covers",
  "reaches",
  "functionId",
]);

/**
 * One proposal's fingerprint, computed exactly as record.mjs:1577 computes it.
 *
 * Not imported from there: record.mjs is a command, and importing it to read
 * one function used to execute a full 366-row recording (record.mjs's own
 * `import.meta.main` comment). So it is restated here, in one place, with a
 * test that fails if the tool's field list moves.
 */
export function supersededFingerprint(proposal, doc = null) {
  const subject = {};
  for (const field of FINGERPRINTED_FIELDS) subject[field] = proposal?.[field] ?? null;
  const inherited = inheritedBlocks(doc, proposal);
  if (inherited) subject.inherited = inherited;
  return createHash("sha1").update(JSON.stringify(subject)).digest("hex").slice(0, 12);
}

/**
 * The hoisted `functionBoundaries` blocks a row inherits, restated from
 * validate.mjs:`inheritedBlocks` for the same reason the hash is (D33): an
 * edit to a block the row inherits changes what the row RUNS, and a hash that
 * cannot see it calls a repaired row already recorded.
 */
function inheritedBlocks(doc, proposal) {
  const blocks = doc?.functionBoundaries;
  if (!blocks || typeof blocks !== "object" || Array.isArray(blocks)) return null;
  const out = {};
  const via = proposal?.via && !String(proposal.via).startsWith("trigger:") ? String(proposal.via) : null;
  if (via && blocks[via] && typeof blocks[via] === "object") out.via = blocks[via];
  const fn = proposal?.functionId;
  if (fn != null && blocks[fn] && typeof blocks[fn] === "object") out.functionId = blocks[fn];
  return Object.keys(out).length ? out : null;
}

/**
 * Every proposal stage 3 has written, by id: the file it lives in and the
 * fingerprint of the input it currently describes.
 *
 * A Map rather than a list because every caller below needs the id AND what is
 * behind it, and two passes over the directory would be two answers to one
 * question.
 */
export function landedProposals() {
  const landed = new Map();
  if (!existsSync(PROPOSALS_DIR)) return landed;
  // SORTED, as validate.mjs's `loadProposals` is: when two files carry one id,
  // the later one is the proposal record.mjs records (its `shadowed` list), and
  // an unsorted readdir - hash order on ext4 - would compare the row against
  // the other copy's fingerprint and call it superseded every round.
  for (const file of readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(PROPOSALS_DIR, file);
    let doc;
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      // An unparseable proposal is stage 3's defect and blocked.mjs:291 already
      // names it. Counting it as a missing id here would blame this step for it.
      continue;
    }
    // `doc.proposals ?? doc`: both shapes are in the tree and coverage.mjs:151
    // reads both, so the two must not disagree about what a proposal file is.
    for (const p of doc.proposals ?? doc) {
      if (p?.id) landed.set(p.id, { id: p.id, file, path, fingerprint: supersededFingerprint(p, doc) });
    }
  }
  return landed;
}

/** Every proposal id stage 3 has written, both document shapes. */
export function proposalIds() {
  return [...landedProposals().keys()];
}

/**
 * The proposal ids the recorded artifact says nothing about, or null when it
 * cannot be read at all.
 *
 * Returned as ids rather than a boolean because `run` prints them: "3 of 214
 * proposals are not in behaviour.json" sends a reader to the right place, and
 * a bare false sends them to diff two JSON files by hand.
 */
export function unaccounted(artifact = recordedArtifact()) {
  if (!existsSync(artifact)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(artifact, "utf8"));
  } catch {
    return null;
  }
  const accounted = new Set();
  for (const r of doc.rows ?? []) if (r?.id) accounted.add(r.id);
  for (const s of doc.skipped ?? []) if (s?.id) accounted.add(s.id);
  return proposalIds().filter((id) => !accounted.has(id));
}

/**
 * The recording's own document, or null when there is nothing readable to ask.
 *
 * One reader for the three questions below, so a truncated artifact cannot be
 * "unaccounted for" to one of them and "up to date" to another.
 */
function recordedDoc(artifact) {
  if (!existsSync(artifact)) return null;
  try {
    return JSON.parse(readFileSync(artifact, "utf8"));
  } catch {
    return null;
  }
}

/**
 * When the recorder that runs a row was last written, or null when it cannot
 * be read: record.mjs and the vitest config it runs under, the two files of
 * its harness that live beside this step (record.mjs `harnessVersion` hashes
 * both).
 */
export function harnessWrittenAt() {
  let newest = null;
  for (const f of [join(PILOT_DIR, "record.mjs"), join(CONFIG_DIR, "vitest.record.config.mts")]) {
    try {
      const at = statSync(f).mtimeMs;
      if (newest === null || at > newest) newest = at;
    } catch {
      // A harness file that is not there is record.mjs's to report.
    }
  }
  return newest;
}

/**
 * Was the proposal file written after the observation was?
 *
 * derive.mjs:2748's question, against this artifact instead of a per-proposal
 * one. A source that cannot be stat'd is treated as changed, exactly as it is
 * there: the alternative is reading an input nobody can see as unchanged.
 */
function writtenSince(source, observedAtMs) {
  try {
    return statSync(source).mtimeMs > observedAtMs;
  } catch {
    return true;
  }
}

/**
 * The proposals this recording ACCOUNTS FOR UNDER A VERSION THAT NO LONGER
 * EXISTS, or null when the artifact cannot be read at all.
 *
 * `[{ id, evidence, observed, current }]`, not a boolean, because `run` and the
 * three steps downstream all print it: "p2 was skipped before its input was
 * rewritten" sends a reader to the proposal, and a bare false sends them to
 * diff a recording against a directory by hand.
 *
 * ABSENCE IS NOT EVIDENCE OF CHANGE, and that is the same rule workflow.mjs's
 * `tamperReason` keeps. A row written before record.mjs:2258 stamped anything —
 * the one in tests/fixtures/behaviour-live-20260915T033521Z.json is such a row —
 * carries no `__fingerprint`, and refusing on it would re-record every artifact
 * recorded before the stamp existed. record.mjs:1966's own comment makes the
 * same call: "An entry written before fingerprints existed carries none, and is
 * re-run once."
 *
 * A row or skip for an id THIS ROUND'S PROPOSALS NO LONGER CARRY is not
 * superseded either. It is a proposal that was deleted, which is `unaccounted`'s
 * mirror image and nobody's failure: the recording holds one row too many, and
 * re-running the recorder would not remove it.
 */
export function superseded(artifact = recordedArtifact()) {
  const doc = recordedDoc(artifact);
  if (doc === null) return null;
  // Not `statSync(artifact)` bare: the file was there a line ago and a walk
  // shares this tree with the agent answering its handover, so an artifact that
  // vanishes between the read and the stat would crash the step rather than
  // report on it. Unreadable is `unaccounted`'s answer, not this one's.
  let observedAt;
  try {
    observedAt = statSync(artifact).mtimeMs;
  } catch {
    return null;
  }
  const landed = landedProposals();
  const out = [];

  for (const r of doc.rows ?? []) {
    const p = landed.get(r?.id);
    if (!p) continue;
    if (typeof r.__fingerprint !== "string") continue;
    if (r.__fingerprint === p.fingerprint) continue;
    out.push({
      id: r.id,
      evidence: "row",
      observed: r.__fingerprint,
      current: p.fingerprint,
      why: `its \`${FINGERPRINTED_FIELDS.join("`, `")}\` and the \`functionBoundaries\` it inherits no longer hash to what the recorded row was run from`,
    });
  }

  // A ROW THE RECORDER ITSELF FAILED ON, recorded by a recorder that has been
  // replaced since. Its fingerprint still matches - nobody edited the input,
  // because the input was never the problem - so without this the row keeps
  // the old harness's failure for ever and its sides stay a pipeline_defect
  // after the tool is fixed. contact-ms's entry-file row (late September 2026)
  // is the case: "Cannot find module './routes/api/healthz'" was the
  // recorder's, and a recorder that resolves the require has to be asked again.
  // Re-recording a row the new recorder still fails on writes the artifact
  // after the recorder, so this asks once per change, never in a loop.
  const harnessAt = harnessWrittenAt();
  if (harnessAt !== null && harnessAt > observedAt) {
    for (const r of doc.rows ?? []) {
      const p = landed.get(r?.id);
      if (!p || r.invoked !== false || !r.harnessError) continue;
      if (out.some((o) => o.id === r.id)) continue;
      out.push({
        id: r.id,
        evidence: "harness",
        observed: r.__fingerprint ?? null,
        current: p.fingerprint,
        why: `the recorder failed on it (${String(r.harnessError.message ?? r.harnessError.name ?? "a harness error").split("\n")[0].slice(0, 160)}) and the recorder has been replaced since`,
      });
    }
  }

  for (const s of doc.skipped ?? []) {
    const p = landed.get(s?.id);
    if (!p) continue;
    if (!writtenSince(p.path, observedAt)) continue;
    out.push({
      id: s.id,
      evidence: "skip",
      observed: null,
      current: p.fingerprint,
      // The reason is quoted so a reader can see WHICH skip was repaired, and
      // the recorder's own sentence is the only account of it there is.
      why: `it was skipped (${s.reason ?? "no reason recorded"}) and ${p.file} has been written since`,
    });
  }

  return out;
}

/**
 * Why this recording no longer describes the inputs on disk, or null.
 *
 * ONE SENTENCE, read by `determinism`, `emit` and `measure` as well as by this
 * step, because the four of them must invalidate together or not at all. A
 * determinism verdict, an emitted test or a coverage entry that outlives the
 * recording it was computed from describes a program that no longer exists, and
 * a stale downstream artifact surviving its proposal's repair is worse than no
 * invalidation at all — nothing says it is stale, and everything reads it as
 * this round's.
 */
export function supersededReason(artifact = recordedArtifact()) {
  const stale = superseded(artifact);
  if (stale === null || stale.length === 0) return null;
  const shown = stale.slice(0, 3).map((s) => `${s.id} — ${s.why}`).join("; ");
  return (
    `${stale.length} proposal(s) have been repaired since ${here(artifact)} observed them (${shown}` +
    `${stale.length > 3 ? `, … ${stale.length - 3} more` : ""}). ` +
    "That recording, the determinism verdicts stamped on it, the tests emitted from it and the coverage measured off " +
    "them all describe inputs that no longer exist, so they are re-executed rather than read as this round's."
  );
}

/**
 * record.mjs exits 1 on an empty proposals directory, several frames inside its
 * own plan, so the absence is named here instead — it is a stage-3 state, not a
 * stage-4 failure.
 */
export function precondition(_repo) {
  if (!existsSync(PROPOSALS_DIR)) {
    return `no proposals directory at ${here(PROPOSALS_DIR)} — record.mjs runs the inputs stage 3 wrote, so derive them first`;
  }
  if (!readdirSync(PROPOSALS_DIR).some((f) => f.endsWith(".json"))) {
    return `${here(PROPOSALS_DIR)} holds no proposal files — there is nothing to record`;
  }
  return null;
}

/**
 * THE DISK: the artifact is there, it accounts for every proposal on it, AND
 * what it accounts for them WITH is the input that is on disk now.
 *
 * The second half is the whole of the repair loop. Without it a proposal
 * skipped once is accounted for ever, and an agent can repair it for as many
 * rounds as the budget allows without the recorder ever running again.
 */
/**
 * Why the recording describes a `src/` that is no longer on disk, or null.
 *
 * THE THIRD QUESTION, and it was missing. `unaccounted` asks whether every
 * proposal is in the document; `superseded` asks whether the PROPOSALS have
 * moved since. Neither asks whether the CODE has. A behaviour.json recorded
 * against a three-week-old `src/` answers both of them perfectly — the ids all
 * appear, the fingerprints all match, because a proposal is not edited by
 * someone changing the service — and then propagates untouched through `emit`,
 * `measure` and `report`, which each check only that they are no older than the
 * artifact above them. Every one of those four is "fresh" with respect to the
 * others and all four describe a program that no longer exists, and the walk
 * exits 0 with a number on it. freshness.mjs's own header is about precisely
 * this shape and it TRACKS this artifact (`{ file: "behaviour.json", stage: 4 }`);
 * nothing in the walk asked it.
 *
 * ONLY WHEN THE ARTIFACT IS IN OUT_DIR, and that guard is load-bearing.
 * `recordedArtifact()` honours `CHARPILOT_OUTPUT`, which may point anywhere;
 * `freshness.check` resolves its argument against OUT_DIR and would report an
 * artifact outside it as `missing` — a predicate false in a state re-recording
 * could never change, which is the exact class of defect this change is part of
 * removing. So a recording the operator redirected is left to the freshness of
 * its own choosing, and the ordinary case is asked.
 */
export function staleReason(artifact = recordedArtifact()) {
  const name = relative(OUT_DIR, artifact);
  if (!name || name.startsWith("..") || isAbsolute(name)) return null;
  const r = freshnessOf(name);
  if (r.state === "fresh" || r.state === "missing") return null;
  return `${here(artifact)} is ${r.state}: ${r.reason}`;
}

/**
 * ROWS THAT FAILED ON A PRISMA CLIENT THAT IS NOT HERE ANY MORE (D42).
 *
 * A row recorded over @prisma/client's placeholder dies in arrangement
 * (prismaclient.mjs PLACEHOLDER_FAILURE), and that failure describes the
 * container's install, not the input. A resumed run lays the previous
 * container's recording over its own generated client: qode-ptp-ms, late
 * September 2026, resumed a recording with 931 such rows, called it `already
 * done`, and round 1 dealt around sides whose only reason was the previous
 * container's client. They are stale once the client is generated, so the
 * step is not satisfied and record.mjs runs them again (its cache drops them
 * for the same reason).
 */
export function placeholderRows(artifact = recordedArtifact()) {
  const doc = recordedDoc(artifact);
  if (!doc) return [];
  // Only a row whose proposal is on disk: re-recording one that is not would
  // write it out of the recording, which is what the missing proposal's own
  // skip does already.
  const rows = (doc.rows ?? []).filter(failedOnPlaceholder);
  if (!rows.length || !placeholderRowsAreStale(REPO_ROOT)) return [];
  const landed = landedProposals();
  return rows.filter((r) => landed.has(r.id));
}

/**
 * The OBSERVATION_VERSION record.mjs declares now, read off its source, or null.
 *
 * READ, NOT RESTATED, and not imported: record.mjs is a command, and the step
 * asks one number of it. The constant's own comment is the convention for
 * changing it (record.mjs OBSERVATION_VERSION).
 */
export function observationVersionNow(file = join(PILOT_DIR, "record.mjs")) {
  try {
    const m = readFileSync(file, "utf8").match(/^export const OBSERVATION_VERSION = (\d+);$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Why the recording was observed under another OBSERVATION_VERSION, or null
 * (item 6b). The record cache no longer keys on the recorder's bytes, so a bump
 * is the one tools change that re-records every row - and it can only do that
 * if this step runs. A recording that names no version predates the constant
 * and is version 1. Not asked when the incremental record is off: that keys on
 * the recorder again, and asks nothing new of this step.
 */
export function observationVersionReason(artifact = recordedArtifact()) {
  if (!INCREMENTAL_RECORD) return null;
  const doc = recordedDoc(artifact);
  const now = observationVersionNow();
  if (!doc || now === null) return null;
  const then = doc.recordingKeyParts?.observationVersion ?? 1;
  return then === now
    ? null
    : `${here(artifact)} was observed under OBSERVATION_VERSION ${then}, and record.mjs declares ${now} - every row is recorded again`;
}

/**
 * Why the recording was observed under another Node than the one the repo's
 * CI runs, or null (D54, cinode.mjs). record.mjs keys its cache on that major
 * - absent for the unstamped default, Node 24 - so a repo whose CI resolves to
 * another one records every row again; but only if this step runs, and a
 * recording that is otherwise complete said `already done`.
 */
export const UNSTAMPED_NODE_MAJOR = 24;
export function targetNodeReason(artifact = recordedArtifact(), t = targetNode({ root: REPO_ROOT })) {
  if (!INCREMENTAL_RECORD) return null;
  const doc = recordedDoc(artifact);
  if (!doc || !doc.recordingKeyParts) return null;
  const then = doc.recordingKeyParts.targetNodeMajor ?? UNSTAMPED_NODE_MAJOR;
  const now = t.major ?? UNSTAMPED_NODE_MAJOR;
  return then === now
    ? null
    : `${here(artifact)} was observed under Node ${then}, and the repo's CI runs Node ${now} (${t.source}) - every row is recorded again under it`;
}

/**
 * The proposals the recording names as NOT YET RUN - record.mjs's own
 * sentence for a runnable row it never reached (writeDoc `pending`).
 *
 * A recording is written after every chunk, so a walk stopped part way through
 * record (the pack's timeout, a container kill) leaves an artifact that
 * accounts for every id - the rows it reached, and "runnable but not yet run"
 * for the rest - and `unaccounted` read that as done. Found by the 6b fault
 * injection on notification-ms (26 September 2026): killed 16 rows into a
 * 108-row recording, the next walk said `record: already done` and reported 78
 * sides open that nothing had tried. A pending row is a row to record, so the
 * step runs, and the rows already recorded are served from what they were.
 */
export const NOT_YET_RUN = "runnable but not yet run in this session";
export function pendingRows(artifact = recordedArtifact()) {
  // A run that finished and still names a row "not yet run" would name it
  // again: only a stopped one is asked to go on (record.mjs `recordingComplete`;
  // an artifact from before that field is asked once). Off, nothing new is asked.
  if (!INCREMENTAL_RECORD) return [];
  const doc = recordedDoc(artifact);
  if (!doc || doc.recordingComplete === true) return [];
  const landed = landedProposals();
  return (doc.skipped ?? []).filter((s) => s?.reason === NOT_YET_RUN && landed.has(s.id)).map((s) => s.id);
}

/* --------------------------------------------------------------------------
 * D67 - A RECORDING THE ENVIRONMENT FAILED IS ACCOUNTED FOR AND STILL NOT DONE.
 *
 * `unaccounted` asks whether the recording says something about every row.
 * qode-itl-be's resumed checkpoint (3a0dd7e-20260926T184305Z) said something
 * about all 1323 - that 884 of them could not be arranged, because
 * @qode/contract was unbuilt and the Prisma client not generated - so this
 * step was satisfied, and the emit shrank the delivered suite from 142 spec
 * files to 64 over rows whose only failure was the container's. Two questions
 * close that, both answered off the rows and the disk (prismaclient.mjs):
 *
 *   `environmentRows`   the rows that failed on a cause that is SET UP NOW, and
 *                       the rows holding an earlier observation over such a
 *                       failure (record.mjs `__environment`). They are
 *                       recorded again, so this step is not satisfied - D42's
 *                       placeholder rule, for every cause. This is what lets a
 *                       walk come back from the defect below by itself.
 *   `environmentDefectReason`   the causes STILL BROKEN, when they are a mass
 *                       of the recording or cost a row the delivered suite
 *                       asserts. Not a reason to record again - recording in
 *                       the same container brings back the same failures - but
 *                       the run's DEFECT (`defects`, below), named after the
 *                       cause, and what steps/emit.mjs is blocked behind. The
 *                       run ends on "the environment is not set up", never on
 *                       a smaller suite.
 *
 * NEITHER CAN WEDGE THE WALK. The first is false only while a set-up cause
 * still has a row on it, and recording that row rewrites it; the second never
 * makes this step unsatisfied at all, so the walk goes on past it and ends
 * with the defect written down.
 * ------------------------------------------------------------------------ */

/** The ids the delivered suite asserts, off its recorded.json (one file or shards). */
function deliveredIds() {
  try {
    return new Set((readRecorded(resolve(SELF_REPO_ROOT, CORPUS_REL)).rows ?? []).map((r) => String(r?.id)));
  } catch {
    return new Set();
  }
}

/** Ids, of proposals on disk, recorded over an environment that is set up now. */
export function environmentRows(artifact = recordedArtifact()) {
  const doc = recordedDoc(artifact);
  if (!doc) return [];
  const landed = new Set(landedProposals().keys());
  const { causes } = environmentFailures(doc, REPO_ROOT, { landed });
  return causes.filter((c) => c.fixed).flatMap((c) => [...c.failed, ...c.kept]);
}

/** The environment defect the recording carries, as one sentence, or null. */
export function environmentDefectReason(artifact = recordedArtifact()) {
  const doc = recordedDoc(artifact);
  if (!doc) return null;
  const found = environmentDefect(doc, REPO_ROOT, { delivered: deliveredIds(), landed: new Set(landedProposals().keys()) });
  return found ? `${here(artifact)}: ${found.sentence}` : null;
}

/**
 * THE DEFECT THE DISK STILL SAYS (workflow.mjs asks this at the step's own
 * position), so a walk that finds the recording already there still ends on
 * the environment rather than on a green suite. Only when the step is
 * satisfied, as steps/baseline.mjs does: an unsatisfied step runs, and `run`
 * returns the same defect itself.
 */
export function defects(repo) {
  if (!satisfied(repo)) return [];
  const reason = environmentDefectReason();
  return reason ? [{ tool: "record.mjs", id: "environment", message: reason }] : [];
}

export function satisfied(_repo) {
  const missing = unaccounted();
  if (missing === null || missing.length) return false;
  if (placeholderRows().length) return false;
  if (environmentRows().length) return false;
  if (pendingRows().length) return false;
  if (observationVersionReason()) return false;
  if (targetNodeReason()) return false;
  // FRESH AGAINST src/, as well as against the proposals. See `staleReason`:
  // re-recording rewrites the artifact at the current sha, so this is a
  // predicate `run` can change — which is what lets it refuse at all.
  if (staleReason()) return false;
  const stale = superseded();
  return stale !== null && stale.length === 0;
}

/**
 * One digest per recorded row, or null when there is no readable recording.
 * A row served from the cache is served verbatim, so its digest moves only
 * when the recorder ran it again - which is what `rows` in dirty.json means.
 */
export function rowDigests(artifact = recordedArtifact()) {
  const doc = recordedDoc(artifact);
  if (!doc) return new Map();
  // Without the determinism stamp: every recording rewrites behaviour.json and
  // drops it, and determinism.mjs stamps every row again from its own cache,
  // so it moves on rows nothing re-ran.
  // Nor the source stamp (record.mjs `__sources`, item 6b): a row recorded
  // before stamps existed is stamped the first time it is served, unchanged.
  return new Map((doc.rows ?? []).map(({ determinism: _stamp, __sources: _sources, ...r }) => [String(r.id), sha256(JSON.stringify(r))]));
}

/**
 * THE ROWS HALF OF out/dirty.json (incremental.mjs): the rows this walk's
 * recorder wrote anew, and the rows it no longer holds.
 *
 * FROM THE RECORDING, NOT FROM record.mjs, because record.mjs does not say
 * which rows it served from its cache and which it ran. When it does (6b keys
 * its cache per row and may write dirty.json itself), its own account for this
 * walk is kept and this one is not written over it. Nothing trusts this list
 * to decide what to run - the spec files' own hashes do that - so it is a
 * description of the round, and the cross-check a reader can make by hand.
 */
export function writeDirtyRows(before, after) {
  const prior = readDirty();
  if (prior?.walk && prior.walk === process.env[WALK_ID_ENV] && prior.rows?.source === "record.mjs") return prior.rows;
  const changed = [...after].filter(([id, d]) => before.get(id) !== d).map(([id]) => id).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const rows = { changed, removed, source: "steps/record.mjs, from behaviour.json before and after the recorder" };
  writeDirty({ rows });
  return rows;
}

export function run(_repo) {
  const decision = mode();
  // FIRST, and before anything is spawned. A round that fails halfway still
  // has to say whether what it did reached staging and was charged for.
  const did = [`mode: ${decision.live ? "live — each row is a real request" : "mocked — every boundary is answered by a double"} (${decision.why})`];

  // SECOND, and still before anything is spawned: WHY this round is recording
  // at all. A log that says "ran record.mjs" over and over says nothing about
  // whether the previous round's repair reached it — which is the question run
  // 20260916T223906Z's operator could not answer from nine rounds of log.
  const onPlaceholder = placeholderRows();
  if (onPlaceholder.length) {
    did.push(
      `${onPlaceholder.length} recorded row(s) failed on @prisma/client's placeholder ` +
        `(${onPlaceholder.slice(0, 3).map((r) => r.id).join(", ")}${onPlaceholder.length > 3 ? ", …" : ""}), and the client is generated now — ` +
        "they are recorded again"
    );
  }
  const setUp = environmentRows();
  if (setUp.length) {
    did.push(
      `${setUp.length} recorded row(s) failed on an environment that is set up now ` +
        `(${setUp.slice(0, 3).join(", ")}${setUp.length > 3 ? ", …" : ""}) — they are recorded again`
    );
  }
  const version = observationVersionReason();
  if (version) did.push(version);
  // D54: which Node the rows are observed under, and where that was read,
  // when it is not the image's own (the pack logs it at container start in
  // every case, and the recorder prints it on every run).
  const target = targetNode({ root: REPO_ROOT });
  if (target.node !== process.execPath || target.why) did.push(targetNodeLine(target));
  const node = targetNodeReason();
  if (node) did.push(node);
  const notRun = pendingRows();
  if (notRun.length) {
    did.push(
      `${notRun.length} proposal(s) the last recording never reached (${notRun.slice(0, 3).join(", ")}${notRun.length > 3 ? ", …" : ""}) — ` +
        "it was stopped part way through, and they are recorded now"
    );
  }
  const repaired = superseded();
  if (repaired?.length) {
    did.push(
      `${repaired.length} proposal(s) have been repaired since the last recording ` +
        `(${repaired.slice(0, 3).map((s) => s.id).join(", ")}${repaired.length > 3 ? ", …" : ""}) — ` +
        "their rows, determinism verdicts, emitted tests and coverage entries are all replaced by what follows"
    );
  }

  // NO ARGUMENTS, and no `env` option either: execFileSync inherits this
  // process's environment (preflight.mjs:runTool), which is what "pass the
  // environment through untouched" means. Every flag record.mjs might act on
  // therefore comes from the operator, never from this file.
  const rowsBefore = incrementalOn() ? rowDigests(recordedArtifact()) : null;
  const outcome = runTool("record");
  if (outcome.line) did.push(outcome.line);

  if (outcome.ok) {
    const artifact = recordedArtifact();
    if (existsSync(artifact)) did.push(`wrote ${here(artifact)}`);
    if (rowsBefore) {
      const moved = writeDirtyRows(rowsBefore, rowDigests(artifact));
      if (moved) did.push(`dirty: ${moved.changed.length} row(s) recorded anew, ${moved.removed.length} gone (${moved.source})`);
    }
    // HOW MUCH OF IT WAS RECORDED NOW (item 6b), so a log says whether a resume
    // re-recorded the repo and, when it did, what made it.
    const reuse = recordedDoc(artifact)?.reuse;
    if (reuse) {
      const because = Object.entries(reuse.recordedAgainBecause ?? {}).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`);
      did.push(
        `${reuse.recordedThisRun} of ${reuse.rows} row(s) recorded in this run, the rest served from what was already recorded` +
          ` (${reuse.takenFromArtifact ?? 0} taken from the recording on disk` +
          `${because.length ? `; recorded again because of: ${because.join(", ")}` : ""})`
      );
    }
    const missing = unaccounted(artifact);
    if (missing === null) {
      did.push(`${here(artifact)} is absent or unreadable, so no proposal is accounted for`);
    } else if (missing.length) {
      // Named, up to three: the list is the diagnosis, and the whole list on one
      // line is unreadable on a repo with a hundred of them.
      const shown = missing.slice(0, 3).join(", ");
      did.push(
        `${missing.length} of ${proposalIds().length} proposal(s) are in neither \`rows\` nor \`skipped\` of ${here(artifact)} ` +
          `(${shown}${missing.length > 3 ? ", …" : ""}) — this recording does not describe them`
      );
    }
    // ROWS THE PREVIOUS RECORDING HELD AND THIS ONE REPLACED WITH A REASON.
    //
    // record.mjs's `guardOutput` used to end the run over these, and that is
    // what killed location-ms `20260919T171842Z` in round 6 and tracy-worker
    // `20260919T092410Z` in round 5. It now lets them go - but only when it has
    // the recorder's own sentence to put in their place - and writes what it
    // let go into `overwrite.superseded`. A round that quietly held fewer rows
    // than the one before it is the thing this step exists to notice, so it is
    // said in the log as well as in the artifact: the sides those rows covered
    // have gone back to uncovered, and the reason each one went is the
    // recorder's, quoted rather than summarised.
    const replaced = recordedDoc(artifact)?.overwrite?.superseded ?? [];
    if (replaced.length) {
      did.push(
        `${replaced.length} row(s) the previous recording held have no row in this one and were carried into ` +
          `\`skipped\` with the recorder's own reason rather than dropped ` +
          `(${replaced.slice(0, 2).map((s) => `${s.id} — ${s.why}`).join("; ")}` +
          `${replaced.length > 2 ? `, … ${replaced.length - 2} more` : ""}) — ` +
          "the sides they covered are uncovered again, and stage 6 counts them with that reason attached"
      );
    }

    const aged = staleReason(artifact);
    if (aged) {
      did.push(
        `${aged} — every number computed from it describes a src/ that is not the one on disk, and nothing ` +
          `downstream of here would say so`
      );
    }
    // AFTER the recorder ran, and about the artifact it just wrote. A proposal
    // still superseded here is one the recorder read and did not re-observe,
    // which is a defect in the tool rather than a round to repeat — and the
    // walk's own "ran and is still not satisfied" refusal quotes this line.
    const stillStale = supersededReason(artifact);
    if (stillStale) did.push(stillStale);

    // D67. The environment this recording was taken in, said as the defect it
    // is: the walk writes it down and goes on, emit is blocked behind it, and
    // report cannot call the run a success over it.
    const envNow = environmentDefectReason(artifact);
    if (envNow) {
      did.push(envNow);
      return { did, pending: [], metrics: {}, defect: { tool: "record.mjs", id: "environment", message: envNow } };
    }
  }

  return { did, pending: [], metrics: {} };
}
