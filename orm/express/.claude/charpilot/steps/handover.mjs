/**
 * WHERE THE HANDOVER LIVES — and why it is not in `workflow.mjs`.
 *
 * `derive` and `repair` both need the path of the file the walk hands the agent:
 * derive to know what it has already asked, repair to know what it asked last
 * round. Both imported it from `../workflow.mjs`, which reads naturally and
 * DEADLOCKS THE PIPELINE.
 *
 * `workflow.mjs` ends with a top-level `await main()` when it is the entry
 * point. `main()` dynamically imports a step; the step statically imports
 * `../workflow.mjs`; that module is already in the registry and is SUSPENDED at
 * its own top-level await. ESM has nothing to resolve, so the process exits 13,
 * "unsettled top-level await", having printed every step up to the first one
 * that imports back.
 *
 * It only happens when `workflow.mjs` is the ENTRY POINT. Every test imports it
 * as a library, so the module finishes executing before `walk` is called and
 * the cycle never closes — 576 tests passed while `node workflow.mjs` hung, and
 * `packs/nodejs.py` and `pilot:workflow` both run it exactly that way. Found by
 * running the real CLI against a real checkout, which no test does.
 *
 * So the constant lives here, in a module that imports nothing from the walk.
 * `workflow.mjs` imports it too, and a step may import it without ever naming
 * the file that runs it.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { OUT_DIR } from "../config.mjs";

/**
 * The questions this run handed over, and nothing else.
 *
 * Deliberately NOT `worklist.json` — that file is `worklist.mjs`'s, and
 * `validate.mjs` reads it. A reader that confuses the two is reading the arms
 * the scan found as though they were the questions an agent was asked.
 */
export const WORKLIST_DECISIONS = join(OUT_DIR, "worklist-decisions.json");

/** The digest beside it. A file cannot carry its own hash. */
export const digestPath = (path) => `${path}.sha256`;

/* ------------------------------------------------------------------------ *
 * THE UNIT OF THE HANDOVER IS A PACKET, AND A PACKET IS A FILE.
 *
 * MEASURED, on the vendored work list of run `20260915T033521Z` (31 open sides,
 * one round at the default cap -> 20 items in 8 packets):
 *
 *   one file      171,439 B on disk, and 171,439 B to answer ANY packet,
 *                 because whichever packet the reader holds it is the whole
 *                 file it has to open.
 *   one file per  ~181 KB on disk, and 6 KB - 62 KB to answer one, median
 *   packet        ~16 KB. The two numbers are different questions and are
 *                 reported separately for exactly that reason: the fan-out
 *                 costs a little total and divides what a reader pays by ten.
 *
 * On the real 146-side round the single file is 1.4 MB, and on run
 * `20260916T194950Z` 35 of the answering agent's first 36 Bash calls touched
 * it. Run `20260916T223906Z` shows the same agent sharding it into
 * `/tmp/item_N.json` to work over it — which is the behaviour the stage-3
 * skill measures at "936 seconds across 99 calls" and forbids, made
 * unavoidable by the artifact it was handed.
 *
 * DEDUPLICATION DOES NOT FIX THIS AND WAS TRIED. A previous attempt removed
 * every file-wide block (`sharedBytesSaved=841580`) and the file was STILL
 * 1.4 MB, because completing an item costs the bytes back. What a reader pays
 * is set by the UNIT OF DELIVERY, not by how well the unit is packed.
 * ------------------------------------------------------------------------ */

/**
 * Where the per-packet briefs go: a directory beside the index, named after it.
 *
 * BESIDE, AND NAMED AFTER IT, for the reason the digest is: it is written, read
 * and deleted with the index, and it cannot survive into a round that has a
 * different handover. A directory somewhere else would be a second handover
 * that outlives the first.
 */
export const packetDirFor = (path) => String(path).replace(/\.json$/i, "") + ".packets";

/**
 * The name of the nth packet file, zero-padded so the directory listing reads
 * in round order.
 *
 * AN ORDINAL, NEVER A NAME DERIVED FROM THE PACKET'S CONTENT. A file called
 * `packet-src-services-googleMap.service.ts-112.json` would mean an item's own
 * content chooses where its reader must go, which is the join this whole change
 * removes — and it would change whenever the round did. The index names the
 * files; nothing else has to.
 */
export function packetFileName(ordinal, total = 0) {
  const width = Math.max(2, String(Math.max(total, ordinal)).length);
  return `packet-${String(ordinal).padStart(width, "0")}.json`;
}

/**
 * The field a pending item uses to name the brief it belongs in.
 *
 * It is a TOP-LEVEL field on the item and never part of `context`, because it
 * is routing and not evidence: `pendingJson` renders the brief and drops this,
 * so what the answering turn reads carries no trace of how it was filed.
 *
 * A step that has no grouping to declare sets nothing, and the walk files each
 * of its items on its own — which is the honest default, since an item that
 * belongs with nothing is answerable alone.
 */
export const BUNDLE_KEY = "bundle";

/**
 * READ A HANDOVER BACK AS ONE DOCUMENT — `{ step, pending }`, whole.
 *
 * WHO NEEDS THIS AND WHY IT IS NOT A CONTRADICTION. The fan-out is about what
 * an ANSWERING TURN has to open: one packet, one file, no script. The steps ask
 * a different question — `derive.handedOver` asks which sides the last round
 * already put in front of somebody, `repair.previouslyAsked` and
 * `repair.priorAttempts` ask what was asked last round and what had been
 * observed then — and those are questions about the WHOLE round. They are the
 * reason the walk stays resumable with no state file, so they must keep working
 * whatever shape the round is written in.
 *
 * So the reader moves with the writer, and it lives here, beside the constants
 * both steps already import, rather than being written out twice.
 *
 * IT READS THE INDEX, NEVER THE DIRECTORY. The index is the statement of what
 * was handed over; a listing is whatever is on disk. A packet file the index
 * does not name is exactly what `workflow.tamperReason` refuses, and it must
 * not become an item here by being found.
 *
 * A file that is already `{ step, pending }` is returned as it is. That is the
 * shape a step hands the walk in process, the shape the tests write by hand,
 * and the shape on disk in a repo whose last round predates the fan-out — and
 * none of those is wrong, so none of them is refused.
 */
export function readHandoverDoc(path, { readFile, exists } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  const there = exists ?? ((p) => existsSync(p));
  if (!path || !there(path)) return null;
  let index;
  try {
    index = JSON.parse(read(path));
  } catch {
    // Whose defect this is belongs to whatever wrote it, and that layer already
    // raises it. Here it must not be mistaken for an empty document: every
    // caller treats null as "unread" and says so.
    return null;
  }
  if (!index || typeof index !== "object") return null;
  if (Array.isArray(index.pending)) return index;
  if (!Array.isArray(index.packets)) return index;

  const root = dirname(path);
  const pending = [];
  for (const entry of index.packets) {
    if (!entry?.file) continue;
    const at = join(root, entry.file);
    if (!there(at)) continue;
    try {
      const brief = JSON.parse(read(at));
      for (const item of brief?.pending ?? []) pending.push(item);
    } catch {
      // ONE UNREADABLE BRIEF DOES NOT ERASE THE ROUND. The alternative is to
      // return null and have the step conclude that nothing was ever asked,
      // which re-asks every side of every packet including the ones that are
      // perfectly readable. Reporting what can be read is the smaller error,
      // and `workflow.tamperReason` refuses the round on the same bytes before
      // any step gets this far.
      continue;
    }
  }
  return { ...index, pending };
}

/* ------------------------------------------------------------------------ *
 * A PACKET IS A UNIT OF WORK, SO ITS ANSWERS HAVE A FILE OF THEIR OWN.
 *
 * WHAT THIS IS FOR, exactly. `charpilot-answers/` is a directory several
 * writers may be in at once — one per packet, once anything answers packets
 * concurrently. Concurrent writers there are safe ONLY while each writes its
 * OWN file name. Two writing the same name is not a merge and not a conflict:
 * it is a silently truncated submission, and it reads downstream as an agent
 * that answered fewer questions than it did, because `readSubmissions` finds
 * one file where two were written and nothing anywhere says the other existed.
 *
 * So each packet gets one name, derived from the packet's own id and from
 * nothing else:
 *
 *   - DERIVED, never assigned. Two processes that never speak to each other
 *     compute the same name for the same packet and a different one for every
 *     other packet, with no registry to keep and nothing to hand out.
 *   - A DIGEST, never the id itself. A packet id carries a function id, which
 *     carries a path — `src/services/googleMap.service.ts:112:parseAddressesForJd`
 *     is not a file name on any filesystem this runs on, and sanitising it is
 *     how two packets come to share a name again.
 *   - STABLE across rounds, because the packet is the same piece of work in
 *     round 3 that it was in round 2. A round that renamed it would leave the
 *     previous round's answer unattributable.
 *
 * THIS RESERVES A NAME. It dispatches nothing, it starts nothing, and it does
 * not make a packet answerable by more than one reader — `derive.packet`'s own
 * refusals still hold, and a packet is still never split.
 * ------------------------------------------------------------------------ */

/** So a reserved name is recognisable as one on sight, in a directory listing. */
export const ANSWER_FILE_PREFIX = "answers-";

/** The one file the answers to this packet go in. */
export function answerFileFor(bundleId) {
  const digest = createHash("sha256").update(String(bundleId ?? "")).digest("hex").slice(0, 12);
  return `${ANSWER_FILE_PREFIX}${digest}.json`;
}

/**
 * D62 — THIS ROUND'S NAME FOR A PACKET, FRESH WHEN AN EARLIER ROUND'S ANSWERS ALREADY HOLD THE DERIVED ONE.
 *
 * A packet id is stable across rounds (it names the function), so the name
 * derived from it is too, and a packet dealt again was reserved the file its
 * earlier round's answers already sit in. One file is one kind of answer, so
 * the round's answer could not be written there: sourcing-ms, the D58 walk -
 * `answers-71cefbae2866.json` held ten needs-seam declarations for
 * getWinningFieldAndTerm, `#109 [else]` came back as an input question, adding
 * the proposal was refused ("this submission carries more than one of
 * `declarations`, `proposals` and `notes`"), and replacing the file with it was
 * refused too ("this submission answered 10 side(s) last round and no longer
 * answers 9 of them"). Neither refusal is wrong about the file; the name was.
 *
 * So a name whose file already holds answers is not handed out again: the
 * round gets `answerFileFor(id#2)`, `#3`, ... - the first that holds nothing -
 * and the earlier file is left exactly as it is, landed and still counted.
 * Still derived from the id and the disk alone, so every reader computes it
 * the same, and `reservedAnswerFiles` reads it back off the header. A packet
 * whose rows need REPAIRING is not this: it names the file the rows live in
 * (`answersFile`), because a repaired row under a new name is a duplicate id.
 */
export function freshAnswerFile(bundleId, census) {
  const holds = (name) => {
    const c = census?.get?.(name);
    return Boolean(c && (c.proposals > 0 || c.declarations > 0 || c.parsed === false || c.sides?.length));
  };
  const earlier = [];
  for (let n = 1; n < 1000; n += 1) {
    const file = answerFileFor(n === 1 ? bundleId : `${bundleId}#${n}`);
    if (!holds(file)) return { file, earlier };
    earlier.push(file);
  }
  return { file: answerFileFor(`${bundleId}#${Date.now()}`), earlier };
}

/** Why the name is not the derived one: an earlier round's answers hold that file. */
export const ANSWERS_FRESH_SAYS =
  "AN EARLIER ROUND'S ANSWERS ALREADY HOLD THIS PACKET'S DERIVED NAME (listed in `earlier`) - they landed and are " +
  "left as they are. This round's answers go in the fresh name above, and only this round's: do not copy the " +
  "earlier file's rows or declarations into it, and do not edit the earlier file.";

/** Whether a submission file name is one this scheme handed out. */
export const isReservedAnswerFile = (name) => new RegExp(`^${ANSWER_FILE_PREFIX}[0-9a-f]{12}\\.json$`).test(String(name ?? ""));

/**
 * Every name this round reserved — THE NAME THE PACKET ITSELF PRINTED.
 *
 * `Map<fileName, { bundleId, sides }>`.
 *
 * WHY THIS READS THE HEADER AND NOT `answerFileFor(entry.id)`, WHICH IS WHAT IT
 * USED TO DO. Two mechanisms were computing "the name this packet reserved" and
 * they were allowed to disagree: this one derived it from the packet id, and the
 * packet's own `answers.file` — the field the ANSWERING TURN reads and obeys —
 * may name something else. `repair` now names the file a packet's rows already
 * live in, because `propose.mjs` materialises a submission under its own file
 * name and `validate.mjs` keeps `seen` ids across the whole flattened proposals
 * directory, so resubmitting an existing row under a fresh name is a
 * `duplicate id` refusal and nothing else.
 *
 * MEASURED, on a repair round against location-ms: the packet reserved
 * `answers-e927fa1b00ab.json`, the rows already lived in
 * `.claude/charpilot/proposals/proposals-googlemap.json`, the agent submitted
 * under the existing name — which is what `derive.mjs`'s own refusal text tells
 * it to do — and the next round's log counted it against them:
 * `packets: 0 of the 2 packet(s) handed over last round have a submission under
 * their own reserved name`. The step told the agent one thing and the
 * accounting scored another, so the accounting now reads the same field the
 * agent was handed. The derivation stays as the FALLBACK for a header that
 * names no file at all.
 *
 * Empty for a handover that is absent, unparseable, or predates the fan-out.
 * Empty means "reserved nothing", so every submission is left alone, which is
 * the state every round before this one was in.
 */
export function reservedAnswerFiles(path, io = {}) {
  const out = new Map();
  for (const header of headersInHandover(path, io)) {
    if (!header?.id) continue;
    out.set(header.answers?.file ?? answerFileFor(header.id), { bundleId: header.id, sides: header.sides ?? [] });
  }
  if (out.size) return out;
  // A handover whose packet FILES could not be read — one round's briefs
  // deleted, a single-file handover from before the fan-out — still says in its
  // index which packets it had. The derived name is all that is knowable then,
  // and knowing it is strictly better than reserving nothing.
  const read = io.readFile ?? ((p) => readFileSync(p, "utf8"));
  const there = io.exists ?? ((p) => existsSync(p));
  if (!path || !there(path)) return out;
  let index;
  try {
    index = JSON.parse(read(path));
  } catch {
    return out;
  }
  for (const entry of index?.packets ?? []) {
    if (!entry?.id) continue;
    out.set(answerFileFor(entry.id), { bundleId: entry.id, sides: entry.sides ?? [] });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * WHAT THE LAST WORKER LEARNED ABOUT THIS FUNCTION — AND WHAT IT COST TO LEARN.
 *
 * MEASURED on run `20260916T223906Z`: 95% of source reads were of a file an
 * earlier round had already read — 93 of 98 calls, 13 of 17 files — and
 * `location.service.ts` was read 31 times across rounds 1-3. Round 2 fanned out
 * and each worker re-read independently. The half with the most value is the
 * half that is currently discarded outright: the attempts that did NOT work and
 * why. A worker that knows "driving through `start()` opens a socket and cannot
 * deliver the arguments" does not spend a round rediscovering it.
 *
 * THREE CONSTRAINTS, and each is a way this goes wrong rather than a feature:
 *
 *   FINGERPRINTED. A note is keyed to the function AND to a digest of that
 *   function's source. Source moves; a note about source that moved is not
 *   served. The fingerprint bounds STALENESS. It does not bound CORRECTNESS and
 *   must never be read as though it did.
 *
 *   OBSERVED / DERIVED / UNTESTED, never mixed. A hypothesis passed forward as
 *   a fact is worse than no note at all: the next worker inherits the error and
 *   stops checking. `observed` is a tool's own bytes about what happened;
 *   `derived` is a reading of those bytes; `untested` is a hypothesis nobody has
 *   run. The kind is required and is not defaulted.
 *
 *   BOUNDED. A free-form note with no shape is how the handover reached 1.4 MB
 *   and the answering agent started scripting over it. A note has a stated
 *   format and a stated size, and a packet carries a stated number of them — or
 *   it does not exist.
 *
 * AND THE ONE THAT MATTERS MOST: A NOTE READS AS EVIDENCE, NEVER AS AUTHORITY.
 * A note is a summary, and a summary can be wrong in a way source is not. A
 * later worker that trusts a note INSTEAD OF the source propagates one early
 * misreading to every round that touches the function, silently. Every note
 * therefore carries its own provenance and every packet carries the sentence
 * that says so.
 * ------------------------------------------------------------------------ */

/**
 * The three provenances, and nothing else may be written in that field.
 *
 * Frozen and asked as a SET, for the reason `MECHANICAL` is: a fourth kind
 * invented at a call site would be a note whose standing nobody stated, and the
 * whole value of the field is that a reader can tell a measurement from a
 * guess without knowing who wrote it.
 */
export const NOTE_KINDS = Object.freeze({
  OBSERVED: "observed",
  DERIVED: "derived",
  UNTESTED: "untested",
});

export const NOTE_KIND_MEANS = Object.freeze({
  [NOTE_KINDS.OBSERVED]: "a tool's own bytes about what happened when this ran — record.mjs, validate.mjs or coverage.mjs said it, verbatim",
  [NOTE_KINDS.DERIVED]: "a reading OF those bytes, made by a step rather than measured — check it against the evidence it names before acting on it",
  [NOTE_KINDS.UNTESTED]: "a hypothesis nobody has run. It is carried so the next worker does not re-invent it, and it is not a fact",
});

/** The shape, stated so a reader knows what it is holding before reading one. */
export const NOTE_LIMITS = Object.freeze({
  perPacket: 8,
  chars: 400,
});

/** A short digest of a function's own source text. The only hashing here. */
export function sourceFingerprint(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * One note, bounded, or null when it cannot be made into one.
 *
 * NULL RATHER THAN A DEFAULT, in all four cases: a note with no kind, no
 * function, no fingerprint or no text is a note whose standing or whose subject
 * is unknown, and a note whose standing is unknown is the thing this format
 * exists to make impossible. The caller drops it; nothing is invented for it.
 */
export function boundedNote({ kind, functionId, source, what, why, from }) {
  if (!Object.values(NOTE_KINDS).includes(kind)) return null;
  if (!functionId || !source) return null;
  const text = String(what ?? "").trim();
  if (!text) return null;
  const clip = (s) => {
    const one = String(s ?? "").replace(/\s+/g, " ").trim();
    return one.length > NOTE_LIMITS.chars ? `${one.slice(0, NOTE_LIMITS.chars - 1)}…` : one;
  };
  return {
    kind,
    means: NOTE_KIND_MEANS[kind],
    functionId,
    source,
    what: clip(text),
    why: why ? clip(why) : null,
    // WHERE IT CAME FROM, on the note itself. A note that names its source can
    // be checked against it; a note that does not is an assertion with a shape.
    from: from ?? null,
  };
}

/**
 * The notes that may be served for this function, and the ones that may not.
 *
 * `{ served, stale }`. A note whose `source` fingerprint is not the one this
 * round computed is NOT served — the function it is about has been edited since
 * somebody wrote it down, and a note about source that moved is exactly the
 * silent staleness the fingerprint exists to stop. It is returned in `stale` so
 * the round can SAY it dropped one rather than dropping it quietly.
 *
 * Capped at `NOTE_LIMITS.perPacket`, observed first: when something has to go,
 * the thing that goes is the guess and never the measurement.
 */
export function servableNotes(notes, { functionId, source } = {}) {
  const served = [];
  const stale = [];
  const rank = { [NOTE_KINDS.OBSERVED]: 0, [NOTE_KINDS.DERIVED]: 1, [NOTE_KINDS.UNTESTED]: 2 };
  for (const note of notes ?? []) {
    if (!note || note.functionId !== functionId) continue;
    if (!source || note.source !== source) {
      stale.push(note);
      continue;
    }
    served.push(note);
  }
  served.sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3));
  return { served: served.slice(0, NOTE_LIMITS.perPacket), stale };
}

/**
 * Every packet header the last round wrote, whichever step wrote it.
 *
 * READ OFF THE INDEX, never off a directory listing, for the reason
 * `handoverFiles` gives: the index is the statement of what was handed over and
 * a packet file it does not name is not a source of anything. An absent,
 * unparseable or pre-fan-out handover yields an empty list, which is "the last
 * round said nothing" — the honest first-round answer, and never an error.
 *
 * This is the one read that lets a round know what the ROUND BEFORE IT said
 * about a packet, which is what both the answer-file census and the carried
 * notes are built out of. It makes no claim about progress and is not a second
 * account of the run: it reports what one file says, and nothing else.
 */
export function headersInHandover(path, { readFile, exists } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  const there = exists ?? ((p) => existsSync(p));
  if (!path || !there(path)) return [];
  let index;
  try {
    index = JSON.parse(read(path));
  } catch {
    return [];
  }
  const headers = [];
  // A single-file handover — what a test writes by hand, and what a repo whose
  // last round predates the fan-out holds — carries its header inline.
  if (Array.isArray(index?.pending) && index?.packet) headers.push(index.packet);
  const root = dirname(path);
  for (const entry of index?.packets ?? []) {
    if (!entry?.file) continue;
    const at = join(root, entry.file);
    if (!there(at)) continue;
    try {
      const brief = JSON.parse(read(at));
      if (brief?.packet) headers.push(brief.packet);
    } catch {
      // ONE UNREADABLE BRIEF DOES NOT ERASE THE ROUND, the same judgement
      // `readHandoverDoc` makes on the same bytes for the same reason.
      continue;
    }
  }
  return headers;
}

/**
 * WHICH STEP WROTE THE HANDOVER ON DISK, AND WHETHER THERE IS ONE.
 *
 * `{ present, step }`. The index carries `step` as its first key
 * (`writeWorklist` writes `{ step, handover, packets }`), and that one word is
 * the difference between the two ways a round can have dealt no packets:
 *
 *   ABSENT            nothing has been handed over yet. Round 1.
 *   step HANDS SIDES  `derive` or `repair` asked, and asked about no packet of
 *                     sides — so there was nothing open to deal.
 *   ANY OTHER STEP    the walk stopped BEFORE the step that deals sides ever
 *                     ran, and nobody was asked about a single open side. Run
 *                     `20260919T104903Z` did this three times, in rounds 3, 5
 *                     and 7, each of them dying inside `measure`.
 *
 * Read off the index alone and never off the packet files: the question is who
 * wrote the round, which the index states, and reassembling the briefs to
 * answer it would open every file to read one key. Unparseable is `present`
 * with no step — something is there and nothing can be concluded from it.
 */
export function handoverStep(path, { readFile, exists } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  const there = exists ?? ((p) => existsSync(p));
  if (!path || !there(path)) return { present: false, step: null };
  try {
    const index = JSON.parse(read(path));
    return { present: true, step: typeof index?.step === "string" ? index.step : null };
  } catch {
    return { present: true, step: null };
  }
}

/* --------------------------------------------------------------------------
 * D31 — A QUESTION NOBODY ANSWERED HAS NOT BEEN ASKED YET.
 *
 * `handover.asks` counts, per step, how many rounds in a row that step handed
 * over exactly the same sides, and `repair` stops asking at two repeats (D76).
 * The count went up every time the same sides were written, whatever happened
 * to the turn they were written for. On contact-ms (mocked, 2026-09-25) the two
 * repeats that stopped `repair` were rounds whose turn never answered: one
 * ended by the gateway breaker on 429s, the next exited 1 on 429s. The agent
 * never read the three items, `repair` stopped asking about them, and the
 * resumed run inherited the count off the checkpoint and stopped again on its
 * very first walk, without asking anybody.
 *
 * TWO RULES, and each leaves the guard's own case intact (a turn that ANSWERED
 * five times and could not close the five items):
 *
 *   A TURN THAT DID NOT ANSWER does not grow the count. The pack says so in
 *   LAST_TURN_UNANSWERED_ENV: the turn exited non-zero or hit the gateway, and
 *   wrote no answer and no proposal. It does not reset the count either, the
 *   way `derive.failedRoundsAfter` treats a gateway round: nothing was learned
 *   from it in either direction. It applies only when the handover that turn
 *   was given is this step's own; an answered or unanswered turn on another
 *   step's question says nothing about this step's.
 *
 *   ANOTHER RUN'S STREAK IS NOT THIS RUN'S. Each entry carries the run it was
 *   counted in (`currentRunId`: CHARPILOT_RUN_ID, else CHAR_RUN_STAMP), and an
 *   entry from another run, or one written before entries carried a run, starts
 *   the count again. A resume is a new container, new gateway conditions, and
 *   an agent that has not seen the question. With no run id (a walk by hand,
 *   a test) there is nothing to scope to, and the count carries as it did.
 *
 * ONE DEFINITION, read by both writers of the number: `workflow.asksAfter`,
 * which writes it, and `repair.repeatRatchet`, which predicts what it is about
 * to be written as. Two copies of this rule are two rules.
 * ------------------------------------------------------------------------ */

/** Set by docker/char/packs/nodejs.py to "1" when the turn before this walk did not answer. */
export const LAST_TURN_UNANSWERED_ENV = "CHARPILOT_LAST_TURN_UNANSWERED";

/** Whether the turn before this walk wrote nothing, having failed or hit the gateway. */
export const lastTurnUnanswered = (env = process.env) => String(env?.[LAST_TURN_UNANSWERED_ENV] ?? "").trim() === "1";

/** The run this walk belongs to, the same id `workflow.currentRunId` scopes defects by. */
export const askRunId = (env = process.env) => (env?.CHARPILOT_RUN_ID || env?.CHAR_RUN_STAMP || "").trim() || null;

/**
 * How many rounds in a row BEFORE this one asked `signature`, as the walk is
 * about to record it for `step`. `before` is the step's entry in the index
 * being replaced (`{ signature, repeated, run? }`) and `lastStep` the step that
 * index was written for.
 */
export function nextAskRepeat({ before = null, signature = null, step = null, lastStep = null, unanswered = false, runId = null } = {}) {
  if (!signature || before?.signature !== signature) return 0;
  if (runId && before?.run !== runId) return 0;
  const prior = Number(before?.repeated) || 0;
  if (unanswered && step && lastStep === step) return prior;
  return prior + 1;
}

/* --------------------------------------------------------------------------
 * D38 — A SIDE IS ASKED WHEN A TURN THAT ANSWERED WAS HOLDING IT, AND NOT
 * WHEN IT WAS WRITTEN INTO A HANDOVER.
 *
 * `nextAskRepeat` counts a step's handovers of the same set of sides, and the
 * D31 discount for a turn that never answered applies only when the index on
 * disk is that step's own. tracy-agent-be-ms (mocked, 2026-09-26) is the case
 * it could not see: `derive` and `repair` took alternate rounds, every turn of
 * the run was a 429 (one parent turn, no worker launched, nothing written), and
 * the walk after each `repair` turn was a `derive` walk, which carries
 * `asks.repair` forward untouched. The unanswered repair turn was never
 * discounted, so `repair`'s count went 0, 1, 2, 3 over rounds 2, 4, 6 and 8,
 * and 189 sides nobody had read were stalled - 93 of them the run's
 * `failed_reason`.
 *
 * A SET IS ALSO THE WRONG UNIT FOR A LARGE REPO. A round deals its sides in
 * packets, and a turn answers the packets its workers were given: a worker
 * refused for concurrency, cut off by the round wall or ended by the gateway
 * never answered its packet, whatever the rest of the turn did.
 *
 * SO THE WALK KEEPS A PER-SIDE COUNT, `handover.answered[step].sides[id]`:
 * how many rounds of that step dealt the side in a packet that an ANSWERING
 * turn received. It is settled one walk later, by whichever step writes the
 * next index, because that is the first moment anything knows how the turn
 * went: the pack says whether it answered (LAST_TURN_UNANSWERED_ENV), and
 * `out/rounds/workers-<n>.json` says which packet files each worker carried
 * and whether it came back. The round is credited to the step whose round it
 * was, so a `derive` walk settles `repair`'s round and the other way about.
 *
 *   - a turn that did not answer credits nobody;
 *   - a turn with workers credits the packets a worker came back from - not
 *     refused, not failed, not cut off - and no other;
 *   - a turn with no worker (the lead answered alone, or a pack older than
 *     the workers file) credits every packet it was handed, which is what the
 *     count did before, so the guard's own case still stops;
 *   - a round written by another run credits nothing, and a count kept by
 *     another run starts again, as D31's does.
 *
 * `repair` reads the same arithmetic (`answeredAfter`) to know, before the
 * walk writes, what the count is about to be. One definition, two readers.
 * ------------------------------------------------------------------------ */

/** Every side a packet entry of an index speaks for: its item ids and any group members. */
export const packetSides = (packet) => [...new Set([...(packet?.sides ?? []), ...(packet?.members ?? [])].map(String))];

/**
 * The workers of the round whose index is `packets`, off the pack's banked
 * rounds, or null when nothing banked says. The newest banked round is the
 * one the last turn answered; it is used only when its banked index names
 * exactly these packets, so a stale file is never read as this round's.
 */
export function roundWorkers(roundsDir, packets, { readFile, list } = {}) {
  const read = readFile ?? ((p) => readFileSync(p, "utf8"));
  let names;
  try {
    names = (list ?? ((d) => readdirSync(d)))(roundsDir);
  } catch {
    return null;
  }
  const n = Math.max(-1, ...names.map((f) => Number(/^workers-(\d+)\.json$/.exec(f)?.[1] ?? -1)));
  if (n < 0) return null;
  const sig = (ps) => (ps ?? []).flatMap((p) => p?.sides ?? []).map(String).sort().join("\n");
  try {
    const index = JSON.parse(read(join(roundsDir, `index-${n}.json`)));
    if (sig(index?.packets) !== sig(packets)) return null;
    const workers = JSON.parse(read(join(roundsDir, `workers-${n}.json`)))?.workers;
    return Array.isArray(workers) ? workers : null;
  } catch {
    return null;
  }
}

/**
 * Which sides of a round an answering turn actually received.
 *
 * `packets` is the round's index entries (`{ file, sides, members? }`),
 * `workers` the banked worker detail for that round (or null: no evidence),
 * and `unanswered` the pack's word on the turn. Returns the side ids and a
 * sentence saying which rule chose them.
 */
export function receivedSides({ packets = [], workers = null, unanswered = false } = {}) {
  const dealt = [...new Set((packets ?? []).flatMap(packetSides))];
  if (!dealt.length) return { sides: [], dealt: 0, why: "the round dealt no side" };
  if (unanswered) {
    return {
      sides: [],
      dealt: dealt.length,
      why: `the turn handed that round never answered - it failed or hit the gateway and wrote nothing - so none of its ${dealt.length} side(s) counts as asked`,
    };
  }
  const launched = Array.isArray(workers) ? workers : [];
  if (!launched.length) {
    return {
      sides: dealt,
      dealt: dealt.length,
      why: `the turn answered and launched no worker, so the lead held all ${dealt.length} side(s) and each counts as asked`,
    };
  }
  const base = (f) => String(f ?? "").split("/").pop();
  const came = new Set(
    launched.filter((w) => w && !w.cut_off && !w.refused && !w.failed).flatMap((w) => (w.packets ?? []).map(base))
  );
  const got = (packets ?? []).filter((p) => came.has(base(p.file)));
  const sides = [...new Set(got.flatMap(packetSides))];
  return {
    sides,
    dealt: dealt.length,
    why:
      `the turn answered, and its workers came back from ${got.length} of the round's ${(packets ?? []).length} packet(s): ` +
      `${sides.length} of its ${dealt.length} side(s) count as asked, and the ${dealt.length - sides.length} in packets no ` +
      `worker came back from (never launched, refused, failed or cut off) do not`,
  };
}

/**
 * `handover.answered` as the walk is about to write it: the index being
 * replaced (`prior`: `{ step, run, packets, answered }`) with its own round
 * settled. `workers` is that round's banked worker detail, or null.
 *
 * Returns `{ answered, credited }`, where `credited` names the step the round
 * was settled for, the sides it credited and why - the sentence `repair`
 * prints.
 */
export function answeredAfter({ prior = null, env = process.env, workers = null } = {}) {
  const runId = askRunId(env);
  const answered = {};
  for (const [name, entry] of Object.entries(prior?.answered ?? {})) {
    if (!entry || typeof entry.sides !== "object") continue;
    // Another run's count starts again (D31's rule, per side now).
    if (runId && entry.run !== runId) continue;
    answered[name] = { ...(entry.run ? { run: entry.run } : {}), sides: { ...entry.sides } };
  }
  const step = typeof prior?.step === "string" ? prior.step : null;
  const credited = { step, sides: [], why: "there is no earlier round of this run to settle" };
  if (!step || !(prior?.packets ?? []).length) return { answered, credited };
  if (runId && prior?.run !== runId) {
    credited.why = `the round on disk was ${prior?.run ? `run ${prior.run}'s` : "written before rounds carried a run"}, and this is run ${runId}: nothing of this run has been asked yet`;
    return { answered, credited };
  }
  const got = receivedSides({ packets: prior.packets, workers, unanswered: lastTurnUnanswered(env) });
  const entry = (answered[step] ??= { ...(runId ? { run: runId } : {}), sides: {} });
  for (const id of got.sides) entry.sides[id] = (Number(entry.sides[id]) || 0) + 1;
  return { answered, credited: { step, sides: got.sides, dealt: got.dealt, why: got.why } };
}

/**
 * Every note the last round wrote into its packet headers, by function.
 *
 * READ OFF THE INDEX'S OWN PACKET FILES, through `readHandoverDoc`'s rule: the
 * index says which files this handover consists of, and a packet file the index
 * does not name is not a source of anything. A round whose handover is absent
 * returns an empty map, which is "nobody has learned anything yet" and is the
 * honest first-round answer.
 */
export function notesInHandover(path, io = {}) {
  const out = new Map();
  for (const header of headersInHandover(path, io)) {
    for (const note of header?.notes?.notes ?? []) {
      if (!note?.functionId) continue;
      if (!out.has(note.functionId)) out.set(note.functionId, []);
      out.get(note.functionId).push(note);
    }
  }
  return out;
}

/**
 * PLAN 20 T2.5a, behind CHARPILOT_NOTES_RANGED=on: READ THE NOTE'S LINES, NOT THE
 * WHOLE FILE. Notes carry `lines: [from, to]` and the note cache counts ranged
 * reads, and on the fleet runs it counted none (company-enrich: 25 hits, 84
 * full-read misses, 0 ranged reads). The support is built; nothing told the
 * reader to use it. Keeping notes and using them better, not dropping them.
 */
export const notesRangedOn = (env = process.env) => env.CHARPILOT_NOTES_RANGED !== "off";
export const NOTES_RANGED_SAYS =
  "READ THE LINES A NOTE NAMES, NOT THE WHOLE FILE. Each note below carries `lines: [from, to]`. For what a note " +
  "covers, read just those lines (the Read tool's offset and limit) and check them against the note; read the whole " +
  "file only when the note does not cover what you need, and write a note for what you learned that it did not.";

/** The packet's notes block, with the sentence that says what a note is worth. */
export function notesBlock({ served = [], dropped = 0, functionId = null, source = null } = {}) {
  return {
    functionId,
    source,
    format: {
      kinds: NOTE_KIND_MEANS,
      maxNotes: NOTE_LIMITS.perPacket,
      maxChars: NOTE_LIMITS.chars,
    },
    droppedAsStale: dropped,
    notes: served,
    ...(notesRangedOn() && served.some((n) => Array.isArray(n?.lines) || (n?.entries ?? []).some((e) => Array.isArray(e?.lines)))
      ? { ranged: NOTES_RANGED_SAYS } : {}),
    says:
      "THESE ARE EVIDENCE, NEVER AUTHORITY. A note is a summary of what an earlier round learned about this " +
      "function, kept so you do not pay to learn it again — the attempts that did not work are the half worth " +
      "most. Each one says whether it was OBSERVED (a tool's own bytes), DERIVED (a reading of them) or UNTESTED " +
      "(a hypothesis nobody ran), and you act on that difference. A note is keyed to this function AND to a digest " +
      "of its source, so a note about source that has since moved is not served to you at all — but that bounds " +
      "STALENESS and not CORRECTNESS. If a note and the source disagree, the source is right and the note is the " +
      "thing to fix. Never use a note INSTEAD of reading the source: one early misreading trusted instead of " +
      "checked propagates to every round that touches this function, and nothing would ever say so.",
  };
}

/* ------------------------------------------------------------------------ *
 * THE FURNITURE A PACKET CARRIES — ONE SOURCE, TWO STEPS.
 *
 * THE DEFECT, measured on a live `repair` round against location-ms. An agent
 * was handed the round with the current toolset and could not find six
 * mechanisms that exist in this source. Its own grep, over the index AND all 19
 * packet files:
 *
 *     charpilot-answers : 0   limits : 0   checkpoint : 0
 *     parallel : 0   concurrent : 0   mock.kind : 0   covers : 0
 *
 * and over the step that wrote them, `grep -n
 * "charpilot-answers|limits|checkpoint|parallel|concurrent" steps/repair.mjs`
 * printed nothing at all. `repair` built its packets from scratch and reused
 * none of `derive`'s item furniture.
 *
 * WHY THAT IS URGENT RATHER THAN UNTIDY. `derive.satisfied()` is permanently
 * true on a repo past first-derive — every side is already briefed — so REPAIR
 * IS THE ONLY ROUND SUCH A REPO EVER GETS, and it is where the last stretch of
 * coverage is won. The same agent's summary: "the missing `mock.kind` sentence
 * is *the* reason 17 claims were false and why I was in a repair round at
 * all". A previous agent, working without it, inverted `value` and `returns`
 * across 22 boundaries and produced 20 false claims.
 *
 * WHY IT LIVES HERE AND NOT IN EITHER STEP. A second prose copy of the
 * `mock.kind` rule is the exact defect this codebase already paid for: one
 * document said `value` substitutes nothing, the code said the opposite, and
 * 20 claims went false against the document. So there is ONE copy, in the
 * module both steps already import and which imports nothing from the walk, and
 * a test fails if a derive packet and a repair packet ever stop carrying the
 * same object.
 *
 * AND IT IS WRITTEN ONCE PER PACKET FILE, NEVER ONCE PER ITEM. `derive`'s
 * handover was 1.4 MB and its answering turn scripted over it; `53b09bc` fixed
 * that by making a packet self-contained and small. These blocks are about the
 * RULES and not about a side, so they belong on the packet header the walk
 * writes at the top of each packet's own file — which is what `SHARED_BLOCKS`
 * does for the blocks that start life on an item.
 * ------------------------------------------------------------------------ */

/** Where the answering turn writes, named the way config.mjs names an override. */
export const ANSWERS_ENV = "CHARPILOT_ANSWERS_DIR";

/**
 * The directory, and the one thing that matters about it: it is NOT under
 * `.claude/`. That is the whole point — the harness refuses writes there, above
 * the project allowlist, and no setting in this repo can grant them. Run
 * `20260916T112101Z` spent 34.6 minutes and $3.80 in round 1 and wrote nothing
 * at all, because every attempt to write into `.claude/charpilot/proposals/`
 * was refused.
 */
export const ANSWERS_DIRNAME = "charpilot-answers";

export function answersDir(repo, opts = {}, env = process.env) {
  if (opts.answersDir) return resolve(opts.answersDir);
  const fromEnv = String(env[ANSWERS_ENV] ?? "").trim();
  if (fromEnv) return resolve(fromEnv);
  return join(repo, ANSWERS_DIRNAME);
}

/**
 * The tool that gives the verdict, named ONCE for the whole pipeline.
 *
 * `derive` re-exports this rather than holding a second copy, because
 * `derive.checkpoint-and-packet-unit` requires the checkpoint and the round
 * boundary to be ONE call site and not two that agree.
 */
export const CHECKPOINT_TOOL = "validate.mjs";

/**
 * WHAT THE CHECKPOINT IS. Prose and not numbers, so it is written once per
 * packet file. It is the same on every item of every round because it is about
 * the RULE and not about this round.
 */
export const CHECKPOINT = Object.freeze({
  do: "Submit ONE representative scenario, in its own file, before you write the rest of the packet. Then expand what passed.",
  youGet:
    "the real verdict. `propose.mjs` puts the document in, and `" +
    CHECKPOINT_TOOL +
    "` judges the result — the SAME spawn, with the same arguments, that this step makes at the round boundary. " +
    "Where verify-on-write is on you also get the recorder's own outcome for that one row.",
  advances:
    "nothing. No row is recorded, no measurement is rewritten, nothing is emitted. Asking whether a document would " +
    "be accepted advances no state, which is why it is not the thing you are forbidden to do.",
  stillRefused:
    "running `pilot:*` or any tool in `.claude/charpilot/` yourself. THOSE advance state, and that refusal is " +
    "unchanged — this is not a licence to re-run a stage by hand. You submit; the step spawns.",
  notExecutionEvidence:
    "AN ACCEPTED DOCUMENT IS NOT A RECORDED ROW. Validation says the SHAPE is right. Run 20260916T223906Z has the " +
    "case in its own bytes: `verify-on-write: parseAddressesForJd-113-default-arg-0 produced no row — skipped: " +
    "blocked egress: prisma.apiKey`. A scenario that validates and cannot be invoked teaches a pattern that never " +
    "records, so read the recorder's outcome as well and never treat the first as the second.",
  whyOneFirst:
    "Round 2 of run 20260916T223906Z ran 113 minutes and $28.02, and then 353 faults quarantined 99 of 135 rows — " +
    "95 of them sharing ONE structural fault. The cost was not the bad rows; it was paying for the same wrong shape " +
    "95 times before anything said it was wrong once.",
  neverBuildYourOwn:
    "DO NOT WRITE A TEST TO SETTLE A DOUBT — submit it and say what you are unsure of. Your harness is not the " +
    "recorder's. Run 20260917T140215Z: six scratch files in 7 min, deleted, no answer, 8 of 9 workers idle.",
});

/**
 * WHICH `mock.kind` INSTALLS WHAT YOU WRITE BESIDE IT.
 *
 * THE ENUMERATION IS NOT HERE AND MUST NOT BE. `validate.mjs --schema` prints
 * the partition by asking `record.mjs`'s own `boundaryDisposition` about every
 * kind, so a printed list cannot drift from the recorder; a markdown table can,
 * and did. What is here is the ONE distinction a list cannot express — the two
 * kinds that are legal, adjacent, and the opposite of each other on a function
 * export — and the measurement that says what getting it wrong costs.
 */
export const MOCK_KIND_RULE = Object.freeze({
  field: "boundaries[<symbol>].mock.kind",
  value:
    "`value` — THE EXPORT *IS* THE ANSWER. The `build`/`value` beside it replaces the export itself, so a " +
    "function-valued answer is CALLED by the subject: `doubles.prismaClient({...})`, `doubles.fetchStub([...])`, a " +
    "cache-bypass arrow like `(run, getter, setter) => run()`.",
  returns:
    "`returns` — THE EXPORT IS A FUNCTION HANDING THE ANSWER BACK, `() => v`. On a FUNCTION export the subject " +
    "receives THE ARROW, UNCALLED. Object answers read the same under both kinds; function answers are the exact " +
    "opposite of each other, and the inversion records a plausible value for a program that never ran.",
  installed:
    "A kind that SUBSTITUTES gets a `vi.doMock`/`stubGlobal`. A kind that DELEGATES calls through to the real " +
    "export, so a `build`/`value` beside one is accepted, never installed, and the real export runs. Bare `value` " +
    "— no `build`, no `value` — is inert and legal.",
  measured:
    "Run 20260916T223906Z, location-ms: 233 of 393 boundary declarations carried an executable answer under a kind " +
    "that substitutes nothing. All dropped; 122 of 136 rows died `blocked egress: prisma.<delegate>`; 63.8% against " +
    "a 96.7% baseline. The proposals were right and one word was wrong.",
  authority:
    "THE PARTITION IS PRINTED, NEVER TRANSCRIBED: `node .claude/charpilot/" +
    CHECKPOINT_TOOL +
    " --schema` lists every kind and which of them record.mjs installs, out of record.mjs's own " +
    "`boundaryDisposition()`. If it and this disagree, it is right.",
});

/* ------------------------------------------------------------------------ *
 * D66 — A ROUND IS A CONCURRENCY AND A CLOCK, NOT A PACKET COUNT.
 *
 * THE FIRST CUT OF THIS DIVIDED ROUND TOTALS BY WORKER COUNTS and got 9.4, 9.0
 * and 7.4 minutes a packet on location-ms, tracy-worker and qode-ptp-ms. That
 * number is SLOT TIME — how long a worker slot was reserved — and it is not
 * what the work costs. Run 20260919T092410Z round 1, per-worker busy time:
 *
 *   w1 43.5  w2 11.4  w3 25.7  w4 12.8  w5 15.6  w6 26.4   = 135.5 worker-min
 *   slot capacity 6 workers x 48.8 min                     = 292.8 worker-min
 *   utilisation                                            = 46%
 *
 * 292.8 / 33 packets is the 8.9 that looked like a per-packet cost. 135.5 / 33
 * is 4.1, and THAT is what a packet costs a worker. The other 157 worker-minutes
 * are the barrier: the round was dispatched in one burst and ended when its
 * slowest worker returned. On run 20260918T094824Z the same shape is starker —
 * 7 of 9 workers done 15 minutes in, 40 of 58 minutes with two or fewer workers
 * running, the last 23.0 minutes a single worker holding 50 items, 31%
 * utilisation, 347 idle worker-minutes, and `worklist.mjs exited 3 — stage 3
 * has spent 58m of a 25m budget`.
 *
 * SO THE BUDGET IS IN WORKER-MINUTES OF BUSY TIME, spent at PACKET_MINUTES a
 * packet, and the two terms that set it are how many workers run at once and
 * how long the round may take. Neither is a property of the repo, which is the
 * whole of this block: a packet count is a wall clock with the concurrency and
 * the utilisation silently baked in at whatever they were on the day.
 *
 * WHAT THAT COSTS TODAY, on tracy-worker's 203 packets: at 6 concurrent workers
 * and today's barrier it is 305 minutes however the packets are cut into
 * rounds. At 12 concurrent it is 152; at 12 with the barrier removed, 69.
 *
 * AND THE 4.1 IS STILL A DIVISION, NOT A MEASUREMENT. It is one round's busy
 * total over one round's packet count. Nothing in this pipeline has ever timed
 * ONE packet — `packetlog.mjs`'s own `missing` field says so — so
 * `recordPacketRun` is the row that would, and it is empty until a parent
 * fills it. Every number here is overridable for that reason.
 * ------------------------------------------------------------------------ */

/**
 * The worker ceiling when the runtime has not said what it is.
 *
 * SIXTEEN, which derived twelve workers under the old quarter reserve and
 * derives FIFTEEN under the one-slot reserve (see `workerConcurrency`). Twelve
 * is the largest fan-out a run has completed with nothing refused, measured
 * twice on current code:
 *
 *   20260921T034219Z  message-templates  workerConcurrency=12  602 child turns
 *   20260921T050441Z  notification-ms    workerConcurrency=12  1303 child turns
 *   20260921T115426Z  notification-ms    workerConcurrency=12  1318 child turns
 *
 * `0 refused worker launch(es)` on every round of all three, across 3,223
 * child turns.
 *
 * TEN WAS THE OLD ANSWER AND EIGHT WAS THE CONTAINER'S, and both came from
 * BEFORE the round became a queue. `entrypoint.py` pinned 8 citing run
 * `20260918T073111Z`, which logged six `subagent launch REFUSED for
 * concurrency` at a ceiling of twelve — and that run's pipeline is `6d640db9`,
 * 46 commits back, before `2bc77ae` made the deal a queue that refills on
 * return. The refusals were the one-wave dispatch asking for every worker at
 * once, not a hard runtime ceiling: the same twelve now launch, return and
 * refill without one.
 *
 * A DEFAULT IS THE WHOLE ANSWER FOR MOST RUNS, so it has to be the best known
 * one rather than the safest. Everything else sizes itself from it —
 * `packetsPerRound` is `concurrency x roundBudgetMin / packetMinutes` — so a
 * conservative concurrency shrinks every round in the run, and a repo that
 * needed no tuning got six workers where twelve were available.
 *
 * FIFTEEN IS UNMEASURED, and so is anything above twelve. The failure is
 * silent: `workflow.mjs` warns that the packets an overflowed worker
 * held get no answer at all, which reads as a round that answered fewer sides
 * than it was asked rather than as an error.
 */
export const WORKER_CEILING_DEFAULT = 16;

/**
 * HOW MANY WORKERS MAY RUN AT ONCE. One reading of the cap, for every caller.
 *
 * THE CEILING IS THE RUNTIME'S AND NOT OURS. Asking for more workers than the
 * CLI allows is not a queue, it is a refusal — "Concurrent subagent limit
 * reached. You can run N subagents at once. Do not retry." — so the packets in
 * the overflow get no worker at all. `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` is
 * the variable the CLI itself obeys, so it is the only honest source and a
 * second knob here would be a copy.
 *
 * AND IT WAS NEVER THE BINDING CONSTRAINT. Every round of run
 * 20260919T092410Z logged `0 refused worker launch(es)` while the deal it was
 * handed baked in six workers. The cap was not what held the fan-out to six;
 * the ARTIFACT was, and `indexHeader` in workflow.mjs is where that is fixed.
 *
 * ONE SLOT IS HELD BACK, NOT A QUARTER. A quarter was held while a worker
 * could spawn a helper of its own: on run 20260917T170601Z one asked a
 * sub-agent to "read the file src/services/location.service.ts and report
 * back", with 12 packets dealt to 12 workers against a ceiling of 12, and that
 * first sub-spawn hit the wall and ended the run five minutes in (798d2f9).
 * Workers are now launched as `WORKER_AGENT`, whose tool list carries no Agent
 * tool (docker/char/agent.py), so that spawn cannot happen and the quarter was
 * paying for nothing: at a cap of 16 it kept four slots idle all run.
 *
 * The one slot left is for the PARENT, not the workers. The refusals this code
 * still sees come from the parent launching one worker past the count it was
 * dealt — 14 of the 15 refused launches on runs 20260922T193606Z,
 * 20260922T152300Z and 20260923T051237Z were "You are one worker…" launches.
 * A refused entry is re-queued in the same round (the dealt instructions say
 * so), so the slot bounds the damage of one overshoot rather than preventing it.
 *
 * `CHARPILOT_WORKER_RESERVE` sets the held-back count, 0 included, for an A/B
 * or to restore the old quarter (4 at a cap of 16). `CHARPILOT_STAGE3_WORKERS`
 * lowers the result further for one run without touching the runtime. A
 * ceiling only ever LOWERS the count: it is a fact about the machine, never an
 * opinion about the round.
 */
export const WORKER_RESERVE_DEFAULT = 1;

/** The subagent type every stage-3 worker is launched as. Defined in docker/char/agent.py. */
export const WORKER_AGENT = "charpilot-worker";

/**
 * PLAN 20 T2.5d, behind CHARPILOT_LIGHT_WORKER=on: A LOWER-EFFORT WORKER TYPE FOR
 * A LOW-RISK COHORT ONLY. The CLI has no per-subagent thinking budget; its lever
 * is `effort` on the subagent definition (docker/char/agent.py), so the cohort
 * gets its own worker type. Never a blanket cap: only a packet with ONE side, a
 * default-argument or `??`/`||` arm, in a function of at most
 * LIGHT_MAX_SOURCE_BYTES. An A/B arm, gated on first-pass yield and false claims.
 */
export const LIGHT_WORKER_AGENT = "charpilot-worker-light";
export const LIGHT_KINDS = Object.freeze(["default-arg", "binary-expr"]);
export const LIGHT_MAX_SOURCE_BYTES = 1500;
export const lightWorkerOn = (env = process.env) => env.CHARPILOT_LIGHT_WORKER !== "off";

/** Whether one packet belongs to the light cohort: 1 side, a light arm kind, a small function. */
export function lightCohort({ count, sideIds = [], sourceBytes = null } = {}) {
  if (count !== 1 || sideIds.length !== 1) return false;
  const kind = /#\d+:([a-z-]+):\d+/.exec(String(sideIds[0]))?.[1];
  if (!LIGHT_KINDS.includes(kind)) return false;
  return Number.isFinite(sourceBytes) && sourceBytes <= LIGHT_MAX_SOURCE_BYTES;
}

export function workerReserve(env = process.env) {
  const raw = env.CHARPILOT_WORKER_RESERVE;
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : WORKER_RESERVE_DEFAULT;
}

export function workerConcurrency(env = process.env) {
  const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const ceiling = positive(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) ?? WORKER_CEILING_DEFAULT;
  const runtime = Math.max(1, ceiling - workerReserve(env));
  const asked = positive(env.CHARPILOT_STAGE3_WORKERS);
  return Math.max(1, asked ? Math.min(runtime, asked) : runtime);
}

/**
 * WHAT ONE PACKET COSTS ONE WORKER IN BUSY MINUTES — 4.1, and NOT the 9 that
 * falls out of dividing a round's wall clock by its packets.
 *
 * Run 20260919T092410Z round 1: 135.5 worker-minutes of busy time over 33
 * packets. The slot figure for the same round is 8.9, and the difference is
 * 157 idle worker-minutes of barrier. Sizing a round on the slot figure would
 * bake today's idleness into tomorrow's budget and make the barrier permanent.
 *
 * WHAT IT MEANS IF THE BARRIER SURVIVES. A round sized on 4.1 while the parent
 * still dispatches in one wave takes about twice its budget. Nothing is LOST by
 * that — the round's own budget language stops the launching, names the entries
 * it never launched and hands them to the next round — but it is the honest
 * risk of this number and it is why it is overridable.
 */
export function packetMinutes(env = process.env) {
  const raw = Number(env.CHARPILOT_PACKET_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 4.1;
}

/**
 * WHAT ONE ITEM COSTS ONE WORKER, in minutes — the term the DEAL has to balance
 * on.
 *
 * 1.2, and it is near-linear across the whole measured spread: 0.76 to 2.70
 * minutes an item over the workers of run 20260919T092410Z. So a round dealt as
 * bundles costs `max_items x ~1.2`, and round 4's bundles were balanced on
 * PACKET COUNT and not on items:
 *
 *   w1 packets=10 items=34   w4 packets=10 items=15
 *   w2 packets=10 items=41   w5 packets=11 items=14
 *   w3 packets=10 items=40   w6 packets=11 items=13
 *
 * Ten packets against eleven, and 41 items against 13. Balanced on items, run
 * 20260918T094824Z's 58-minute round is about 16.
 */
export function itemMinutes(env = process.env) {
  const raw = Number(env.CHARPILOT_ITEM_MINUTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.2;
}

/**
 * HOW LONG A ROUND MAY TAKE, in minutes.
 *
 * Forty-five, and it is the round this fleet has already completed rather than
 * a target. Run 20260919T092410Z's four tracy-worker rounds ran 50.1, 48.3,
 * 48.3 and 38.2 minutes; run 20260918T073111Z's qode-ptp-ms rounds ran 27 to
 * 40. The boundary between two rounds costs 14 to 62 SECONDS on those logs, so
 * a shorter round is cheap and a longer one is a straggler nobody can see.
 *
 * It bounds the DERIVE round and not the run: `MAX_DURATION_SECONDS` owns the
 * run and `out/stage3-clock.json` owns the stage.
 */
export function roundBudgetMin(env = process.env) {
  const raw = Number(env.CHARPILOT_ROUND_BUDGET_MIN);
  return Number.isFinite(raw) && raw > 0 ? raw : 45;
}

/**
 * THE MOST ITEMS ONE QUEUE ENTRY MAY CARRY, so no single entry outlasts the
 * round it is in.
 *
 * `roundBudgetMin / itemMinutes`, which is 37 items at the defaults. Run
 * 20260918T094824Z's last 23.0 minutes were ONE worker holding two packets and
 * 50 items while eight sat idle; at 1.2 minutes an item that entry was always
 * going to outlast the round.
 *
 * IT SPLITS A GROUP OF PACKETS AND NEVER A PACKET. A single packet with more
 * items than this is left whole and over the cap, because splitting a packet is
 * a different change with a prerequisite — plan 15's D47a: a second worker
 * taking half of one reading must be handed the NOTE and not the file, or the
 * split trades a straggler for the duplicate reading affinity existed to
 * remove. tracy's `packet-02` is 37 items and a 623 KB brief, and it is exactly
 * that case.
 *
 * AND IT WOULD NOT CATCH THAT PACKET EVEN IF IT WERE ALLOWED TO SPLIT ONE.
 * `packet-002.json` of tracy's dealt round carries THIRTY-SEVEN items against a
 * cap of THIRTY-SEVEN, so `items <= cap` is true of the largest brief the fleet
 * has ever written. A bound in items is not the bound that packet is over — see
 * `BRIEF_BUDGET_BYTES` below for the one it is over by a factor of twenty-four,
 * and for the measurement that says bytes are the better predictor of the two.
 */
export function entryItemCap(env = process.env) {
  return Math.max(1, Math.floor(roundBudgetMin(env) / itemMinutes(env)));
}

/* ------------------------------------------------------------------------ *
 * WHAT A BRIEF MAY COST TO READ — AND WHY THE BOUND IS IN BYTES, NOT ITEMS.
 *
 * NOTHING HAS EVER BOUNDED WHAT ONE PACKET CARRIES. `packetsFor` puts every
 * open side of a function into one packet by construction; `entryItemCap`
 * bounds a QUEUE ENTRY and says above that it never splits a packet;
 * `MAX_PACKET_WEIGHT` in derive.mjs clamps a `weight` field that no code and no
 * test reads — `sidesWithin` costs a packet by `difficulty` and D66 took the
 * context term out of the walk, so that clamp bounds nothing at all.
 *
 * WHAT THAT COSTS, measured on tracy's dealt round (131 packet files,
 * `node tools/packetcost.mjs --packets <round>.packets`):
 *
 *   packets 131 · items 586 · 9,634,091 B
 *   median 41,845 B · max 618,326 B · 16,440 B an item
 *   packet-002.json  618,326 B  37 items  src/agent/agent.ts
 *
 * 618,326 bytes is about 155K tokens of brief before the worker opens the 47 KB
 * file it is about. That is the packet plan 15 recorded as "packet-02 (31
 * sides, the large `agent.ts` run() function) deliberately left unanswered" on
 * run 20260918T164503Z. It has been read as a file-size problem for a
 * fortnight; the file is 7% of what the worker was handed.
 *
 * BYTES AND NOT ITEMS, and this is a measurement rather than a preference. Over
 * the 21 rows `tools/packetcost.mjs --rows` has on this tree — the only
 * per-packet timings that exist anywhere in this pipeline — seconds correlate
 *
 *   0.77 with BRIEF BYTES      0.65 with SOURCE BYTES      0.62 with SIDES
 *
 * so the unit the round is already scheduled in (items) is the weakest of the
 * three, and the unit nothing bounds (brief bytes) is the strongest. An item
 * cap is also not the same question in two repos: location-ms's packets cost
 * about 6 KB an item and tracy's about 16 KB, so one number in items is two
 * different budgets.
 *
 * AND THE BUDGET ALREADY EXISTS. 25,000 bytes is asserted by
 * `handover.one-packet-one-file.test.mjs` and quoted by three source files, and
 * it has never been asked of a real round. Asked of tracy's:
 * ONE HUNDRED AND THIRTY-ONE OF 131 PACKETS ARE OVER IT. The smallest brief in
 * that round is 31,759 bytes. The guard is real, the number is real, and the
 * population it was measured against is an eight-packet fixture whose median is
 * 24,930 B with 70 bytes of headroom.
 *
 * SO THIS REPORTS AND DOES NOT SPLIT. `NOT_SPLIT_SAYS` is the argument, and it
 * is the constraint this whole change is written under: an oversized packet
 * left whole and named loses nothing, and a split that drops a side is the
 * failure to avoid. A split is a real answer and it has a prerequisite that is
 * not met — plan 15's D47a, the note the second worker must be handed instead
 * of the file. The note store is not empty (20260920T030124Z ends with 27
 * submissions materialised and four notes on disk), but a note written in
 * round N is served from round N+1, and a split hands both halves out inside
 * ONE round — so there is nothing for the second worker to be handed, which is
 * the prerequisite, not the store being empty.
 *
 * THIS PROSE IS ON EVERY WORKER'S INDEX, so it is costed like a brief. The
 * argument is 550 B as first written and 10,511 B of index on the eight-packet
 * fixture, over `indexBytes < 10_000`; it is now stated in a third of that.
 * ------------------------------------------------------------------------ */

/**
 * WHAT ONE BRIEF MAY COST A WORKER TO READ, in bytes.
 *
 * TWENTY-FIVE THOUSAND, and it is not a new number: it is the one
 * `handover.one-packet-one-file.test.mjs` has asserted all along, named here so
 * the test, the runtime and the three comments that quote it stop being four
 * copies that may disagree. What is new is that anything outside that test can
 * ask it.
 *
 * IT IS A BUDGET AND NOT A CEILING, because nothing here may drop a packet for
 * being over one. A packet over budget is dealt, whole, and reported.
 */
export const BRIEF_BUDGET_BYTES = Math.max(
  1, Number(process.env.CHARPILOT_BRIEF_BUDGET_BYTES ?? 25_000));

/**
 * THE LARGEST BRIEF ANY PACKET HAS EVER BEEN MEASURED ANSWERING.
 *
 * 69,204 bytes — notification-ms `packet-41`, 385 seconds, 21 turns, 3 of 3
 * sides validated, in `out/packetcost/`'s own rows. It is REPORTED and it
 * triggers nothing, for the reason `packetlog.mjs` gives about its own p95: a
 * threshold built on a handful of rows is a constant wearing a measurement's
 * name. What it is good for is saying which part of a round is inside measured
 * territory and which part is not — 33 of tracy's 131 packets are above it, and
 * they hold 384 of its 586 items.
 *
 * THE ROWS ARE GENERATED AND NOT VENDORED. Re-read them with
 * `node tools/packetcost.mjs --rows` rather than trusting this line.
 */
export const BRIEF_MEASURED_MAX = 69_204;

/**
 * WHY AN OVER-BUDGET PACKET IS NOT CUT IN HALF.
 *
 * Stated once, carried on the report, because the next reader of a 618 KB
 * packet will reach for the obvious fix and the obvious fix has a prerequisite
 * that nothing in this pipeline has met yet.
 *
 * ONE SENTENCE AND NOT TWO. What to DO about a heavy entry is already on the
 * index, in `dealSays` — largest first, refill on return, end the round when
 * the budget is spent — and a second copy of it here would be the drift this
 * file's own furniture section exists to prevent. What is NOT anywhere else is
 * why the heaviest entry was not simply cut in half, so that is all this says.
 */
export const NOT_SPLIT_SAYS =
  "NOT SPLIT, DELIBERATELY. A packet is ONE FUNCTION AND ONE READING: two workers on two sides of it pay for "
  + "that reading twice and can answer from readings that disagree. A split needs D47a — the second worker handed "
  + "the NOTE, not the file — and a note is served from the round AFTER the one that wrote it, so inside one round "
  + "there is nothing to hand it. Dealt WHOLE and named here: whole loses no work, a split that drops a side does.";

/** The middle value of a sorted list of numbers, or 0 for an empty one. */
function medianOf(sorted) {
  if (!sorted.length) return 0;
  const half = sorted.length / 2;
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[half - 1] + sorted[half]) / 2;
}

/**
 * WHAT THIS ROUND'S BRIEFS COST TO READ, AND WHICH OF THEM ARE OVER BUDGET.
 *
 * `packets` is the index's own rows — `{ file, id, items, bytes }`, which is
 * exactly what `writeWorklist` already has in hand — so this measures the bytes
 * that were WRITTEN and never a prediction of them. Null when no row carries a
 * byte count, which is "nothing to say" rather than "nothing is wrong".
 *
 * IT NAMES THE WORST THREE AND NOT EVERY OFFENDER, and the reason is the
 * measurement above: on tracy every packet is over budget, so a list of the
 * over-budget ones is the round again with a longer name. What a reader needs
 * is the SHAPE — how many, how far, and which one is the straggler — and that
 * is four numbers and three rows however large the round is. `worst` is
 * therefore bounded and the index does not grow with the round.
 *
 * IT GOES ON THE INDEX AND NEVER ON A PACKET. The brief budget has 70 bytes of
 * headroom at the median (`handover.one-packet-one-file.test.mjs` prints it on
 * every run), so a block written once per packet file would spend the budget it
 * exists to report on. The index is where the scheduler reads, and the index is
 * a routing table nobody has to open a worker for.
 *
 * AND THE INDEX HAS ITS OWN BUDGET, which is why the prose here is one sentence
 * and `worst` is three rows. The same guard asserts `indexBytes < 10_000` and
 * the fixture round's index is 7,897 B, so this block has about 2,100 bytes to
 * live in; it measures ~1,150 on tracy's 131-packet round and ~1,000 on
 * location-ms's two. A fourth `worst` row or a second paragraph is the change
 * that spends the rest of it, and the guard is where that shows up.
 *
 * NOTHING HERE DROPS, SPLITS, REORDERS OR DEFERS A PACKET. It returns a
 * description. Every side of every packet is still dealt exactly as it was.
 */
export function briefCensus(packets = [], env = process.env) {
  const rows = (Array.isArray(packets) ? packets : []).filter(
    (p) => p && Number.isFinite(Number(p.bytes)) && Number(p.bytes) >= 0
  );
  if (!rows.length) return null;
  const budget = Math.max(1, Number(env.CHARPILOT_BRIEF_BUDGET_BYTES ?? BRIEF_BUDGET_BYTES));
  const bytes = rows.map((p) => Number(p.bytes)).sort((a, b) => a - b);
  const over = rows.filter((p) => Number(p.bytes) > budget);
  const unmeasured = rows.filter((p) => Number(p.bytes) > BRIEF_MEASURED_MAX);
  const worst = [...rows]
    .sort((a, b) => Number(b.bytes) - Number(a.bytes))
    .slice(0, 3)
    .map((p) => ({
      file: p.file ?? null,
      items: Number(p.items ?? 0),
      bytes: Number(p.bytes),
      // HOW FAR OVER, said as a multiple, because "618,326" is a number a
      // reader has to divide before it means anything and this is the division.
      timesBudget: Math.round((10 * Number(p.bytes)) / budget) / 10,
    }));
  return {
    budget,
    packets: rows.length,
    over: over.length,
    overItems: over.reduce((n, p) => n + Number(p.items ?? 0), 0),
    median: medianOf(bytes),
    largest: bytes[bytes.length - 1],
    // THE HALF OF THE ROUND NOBODY HAS A MEASUREMENT FOR, kept apart from
    // `over` because they are different claims: over budget is "more than we
    // said we would send", above this is "larger than anything that has ever
    // been answered".
    measuredMax: BRIEF_MEASURED_MAX,
    aboveMeasured: unmeasured.length,
    aboveMeasuredItems: unmeasured.reduce((n, p) => n + Number(p.items ?? 0), 0),
    worst,
    notSplit: NOT_SPLIT_SAYS,
  };
}

/**
 * HOW MANY PACKETS A ROUND CARRIES — concurrency times clock, over the busy
 * cost of a packet, and NOT a property of the repo.
 *
 * At a cap of 16 (dispatchable 12), a 45-minute round and 4.1 busy minutes a
 * packet that is 131 packets, whatever repo it is. tracy-worker's 203 packets
 * are then 2 rounds instead of 13, and location-ms's 34 still arrive in one.
 *
 * THE FLOOR SURVIVES AND THE CEILING DOES NOT, and the reason is in the
 * arithmetic. A ceiling in packets was a wall clock with the concurrency baked
 * in, so the budget states it directly and subsumes it. The floor guards the
 * opposite case: at a cap of 2 the dispatchable concurrency is 1 and this
 * returns 10 packets — BELOW location-ms's proven 34-packet round, which closed
 * 127 of 146 sides in one go. A low cap must not be allowed to cut a round that
 * is already measured finishing, so the floor only ever raises this answer.
 *
 * NOTHING HERE ENDS A ROUND EARLIER THAN IT WOULD HAVE ENDED. A larger budget
 * deals MORE per round; the entries a round does not launch are named and dealt
 * first next round, which is what `heldBack` has always been. No packet is
 * dropped and no late submission is refused by any of it.
 */
export const ROUND_PACKET_FLOOR = Math.max(1, Number(process.env.CHARPILOT_ROUND_PACKET_FLOOR ?? 34));

export function packetsPerRound(env = process.env) {
  const budget = Math.floor((workerConcurrency(env) * roundBudgetMin(env)) / packetMinutes(env));
  return Math.max(ROUND_PACKET_FLOOR, budget, 1);
}

/**
 * HOW MANY WORKERS, AND ON WHAT.
 *
 * A packet is one reading of one function. Two workers on two sides of it pay
 * for that reading twice and answer from two readings that can disagree, which
 * is what `derive.packet` refuses one level up.
 */
export const PARALLELISM = Object.freeze({
  rule: "ONE WORKER PER PACKET, NEVER ONE PER SIDE.",
  why:
    "A packet's sides are arms of the same function: they share the entry recipe, the parameters and the " +
    "boundaries, and ONE reading answers all of them. Splitting a packet buys nothing, costs the reading twice, and " +
    "two readings of one function are free to disagree.",
  howToFan:
    "Hand a worker THE ONE PACKET FILE. It carries every item it answers and names nothing outside itself, so a " +
    "worker needs no index, no second file and no script.",
  howToDeal:
    "THE INDEX CARRIES A QUEUE AND A CONCURRENCY, NOT A BUNDLE PER WORKER — see `handover.dealSays`. Launch " +
    "`concurrency` entries, largest first, and LAUNCH THE NEXT THE MOMENT ONE RETURNS. Never deal a worker several " +
    "entries up front: it cannot start its second until its first is done, so the round's longest packet waits " +
    "behind whatever else landed beside it. Run 20260917T082737Z dealt three or four per worker and had six of ten " +
    "workers idle from +30 min while packet-25 (389,674 bytes, 40 of 146 sides) sat behind three others.",
  writes:
    "Each packet writes its OWN `answers.file`, which is what makes concurrent writers safe. Two writers on one " +
    "name is not a merge: it is a silently truncated submission, and downstream it reads as an agent that answered " +
    "fewer questions than it did.",
  budget:
    "There is no per-packet deadline. The only bound is the STAGE budget (out/stage3-clock.json, " +
    "CHARPILOT_STAGE3_BUDGET_MIN) which every packet shares, so a packet that runs long spends another's time.",
  deadline:
    `EVERY WORKER IS BOUND. Give each one ${workerDeadlineMin()} minutes. When that is up, take what has landed, ` +
    "say which packets you left, and END THE ROUND — do not wait for the last worker to feel done. A side nobody " +
    "answered comes back next round aimed by a COVERAGE REPORT, which is better evidence than a second reading of " +
    "the same source; a round held open by one worker is eight workers idle and no new evidence at all.",
  deadlineWhy:
    "The straggler cannot be dealt around: on run 20260917T140215Z workers 3 and 5 held IDENTICAL bundles — 4 " +
    "packets, 12 sides each — and one finished at 15.8 min while the other ran to 44.7, with the two heaviest " +
    "bundles both in ahead of it. The cost is decided while the worker runs, so REFILLING ON RETURN is the answer " +
    "and a cleverer deal is not.",
});

/**
 * HOW LONG A WORKER MAY RUN, in minutes.
 *
 * SIXTY by default, and the number is the measured tail of the two runs whose
 * worker fan-out is timed on this machine.
 *
 * IT WAS THIRTY, on this sentence: "every run this month has had 8 of 9 (or 11
 * of 12) workers finished inside ~25 minutes, so a 30-minute bound costs almost
 * nothing in answers." That claim named no run. It is false of the one run of
 * "this month" whose per-worker timings survive. Run 20260918T094824Z
 * (tracy-worker, 9 workers, 33 packets), offsets from worker 1's launch at
 * 09:50:48Z, read off the answer files as they landed:
 *
 *   +3.9 … +15.8    eighteen answer files — seven of the nine workers
 *   +29.4           worker 4's one file: 12 sides, packets 01/03/19
 *   +41.6, +49.0,   worker 9's three files: the two LARGEST packets, 50 sides,
 *   +51.9           8 proposals + 2 declarations + 6 proposals recorded
 *
 * SEVEN of nine inside 25 minutes, not eight, and the round's own report closed
 * at +55.9.
 *
 * WHAT 30 WOULD HAVE COST THERE. The rule is "take what has landed", so the
 * bill is whatever is not yet written: worker 9's three files — all correct,
 * all answered, the largest two packets in the round. Worker 4's 12 sides are
 * NOT in that bill; its file landed at +29.4, thirty-five seconds inside the
 * bound, which is not a margin anybody should plan on. Forty-five — the round
 * budget — still loses two of worker 9's three. Sixty keeps every file either
 * run produced, with eight minutes over the longest.
 *
 * WHAT THE TAIL COSTS AT 60, because raising a bound is not free. The bound is
 * for the worker that never comes back: on run 20260917T140215Z round 1, 8 of 9
 * reported by +24.0, worker 3 never reported at all, and the round closed at
 * +44.0. At 60 that round waits another 16 minutes with eight workers idle, and
 * 60 is above `roundBudgetMin`'s 45, so one hung worker can overrun the round
 * budget by a quarter. That price is paid in clock. Thirty's is paid in
 * answered sides, and the rule here is that nothing may add a place where
 * correct work is lost.
 *
 * NO FINITE BOUND RECOVERS A WORKER THAT PRODUCES NOTHING. The number only
 * decides how long the round waits to find that out, which is why it is set
 * from the slowest worker that ANSWERED and not from the fastest that hung.
 *
 * SECONDS in the variable and minutes in the sentence, because the agent reads
 * the sentence and the operator sets the variable.
 */
export function workerDeadlineMin(env = process.env) {
  const raw = Number(env.CHARPILOT_WORKER_DEADLINE_SECONDS);
  const secs = Number.isFinite(raw) && raw > 0 ? raw : 3600;
  return Math.max(1, Math.round(secs / 60));
}


/**
 * WHICH ARMS A `from` MAY NAME — the citation rule, stated once.
 *
 * `checkEvidence` decides it with `covers.includes(evidence.arm)`
 * (validate.mjs:329) and nothing else. The run this came from lost 95 of 99
 * quarantined rows to this one field.
 */
export const COVERS_RULE = Object.freeze({
  field: "proposals[i].covers — and every `from.arm` is checked against it",
  rule:
    "`from.arm` MUST BE ONE OF THE armIds THIS ROW LISTS IN `covers`. An id built out of a functionId, or out of a " +
    "path and a line, is refused by the same check as \"not an arm in scan.json\".",
  elsewhere:
    "Where the value genuinely comes from OUTSIDE this row's `covers` — a driver's parameter, a line in the entry " +
    "region above the branch — that location goes in `from.evidence` as a `file:line` with the sentence in " +
    "`from.reading`, and `from.arm` names the arm of YOURS the value serves. `from.arm` is not where the bytes are.",
  never:
    "DO NOT DELETE A `from` TO CLEAR A CITATION FAULT, and never point one at an arm you did not read: a refused " +
    "row comes back as a question, an invented citation records a value nothing sourced.",
  fields: Object.freeze(["args[].from.arm", "setup[].from.arm", "boundaries.<symbol>.from.arm"]),
});

/** What a packet's answer file is, and what writing anywhere else does. */
export const ANSWERS_SAYS =
  "Write THIS packet's answers under THIS name, in this directory. The directory is shared and a second write to " +
  "one name loses the first with nothing reporting it — which reads downstream as fewer answers than were " +
  "written. The count in `lastSeen` is what this round observed in that file; the next round compares and raises a " +
  "`submission` item if it shrank. Nothing merges or reconstructs a lost half.";

/**
 * WHY A REPAIR PACKET MAY NAME A FILE THIS SCHEME DID NOT DERIVE.
 *
 * MEASURED: the packet reserved `answers-e927fa1b00ab.json`; the rows it was
 * asking about already lived in `proposals/proposals-googlemap.json`;
 * `propose.mjs` materialises a submission under its own file name
 * (`targetName`) and `validate.mjs:681` keeps `seen` ids across the whole
 * flattened proposals directory. So a repaired row submitted under a fresh name
 * is `duplicate id` and nothing else.
 */
export const ANSWERS_EXISTING_SAYS =
  "THE ROWS THIS PACKET IS ABOUT ALREADY EXIST, in the file named above, so the submission is named after THAT file " +
  "rather than after a name derived from the packet id. `propose.mjs` materialises a submission under its own file " +
  "name and `validate.mjs` keeps `seen` ids across the whole flattened proposals directory, so a repaired row " +
  "submitted under a new name is refused as a `duplicate id` — the id is already in the file it came from. " +
  "Resubmit the WHOLE file's worth of rows under this name: what you submit replaces it.";

/**
 * The packet's rows are spread over more than one file, so no single name is
 * the right one for the whole packet.
 */
export const ANSWERS_SPLIT_SAYS =
  "THIS PACKET'S ROWS ARE SPREAD OVER MORE THAN ONE FILE, listed in `existing`, so no one existing name is right " +
  "for all of them. Submit each row under the file name it already lives in — `propose.mjs` materialises a " +
  "submission under its own file name and `validate.mjs` keeps `seen` ids across the whole flattened proposals " +
  "directory, so a row resubmitted under a different name is refused as a `duplicate id`. The name above is this " +
  "packet's own reserved name, and it is where anything NEW goes.";

/** The name derived from the packet id, and what it is for. */
export const ANSWERS_RESERVED_SAYS =
  "No row of this packet is on disk yet, so the name is derived from the packet's own id and from nothing else — " +
  "two readers that never speak to each other compute the same name for the same packet and a different one for " +
  "every other packet, with no registry to keep.";

/**
 * PLAN 20 T2.1 P1, behind CHARPILOT_INCREMENTAL_ANSWERS=on: WRITE AS YOU GO.
 *
 * A worker wrote its packet's file once, at the end, so a worker cut off by the
 * round banked nothing of a packet it had half answered. `materialise` already
 * takes a partial file and the next round deals only what is still open, so the
 * one thing missing was the worker writing the half it had. Safe under "a second
 * write replaces the first" because every write is a SUPERSET of the sides of
 * the one before; `shrunkSubmissions` checks exactly that, by sides.
 */
export const ANSWERS_INCREMENTAL_SAYS =
  "WRITE THIS FILE AS YOU GO: after each side, rewrite it whole; never drop a side an earlier write answered. " +
  "What is on disk at round end is banked.";

export const incrementalAnswers = (env = process.env) => env.CHARPILOT_INCREMENTAL_ANSWERS !== "off";

/**
 * PLAN 20 T2.4, behind CHARPILOT_INROUND_VERIFY=on: THE ONE TOOL A WORKER MAY RUN.
 * `checkrow.mjs` checks one row against a scratch copy of the proposals and
 * advances nothing, so it is the single exception to "workers run no tools".
 */
export const inroundVerify = (env = process.env) => env.CHARPILOT_INROUND_VERIFY !== "off";
export const ANSWERS_CHECK_SAYS =
  "OPTIONAL, the one tool you may run: `node .claude/charpilot/checkrow.mjs charpilot-answers/<this file> <row-id>` " +
  "on a `reaches` row in this file. On `false` or not invoked, fix that row; at most two checks per row. " +
  "`not verified` is not a failure.";

/**
 * The one block that says WHERE TO WRITE — the directory and the file name,
 * together, because either on its own is an address the agent has to complete.
 *
 * `file` is the name to submit under. `reserved` is what the derivation would
 * have handed out, kept beside it so the two can never be confused and so a
 * reader can see that a legacy name was chosen deliberately.
 */
export function answersBlock({ packetId, file = null, lastSeen = null, existing = [], fresh = null } = {}) {
  const reserved = answerFileFor(packetId);
  // D62: a fresh name is the round's reservation, not a legacy file chosen for
  // its rows, so it is `reserved` too and says why it is not the derived one.
  const freshFile = !file && fresh?.earlier?.length ? fresh.file : null;
  return {
    directory: ANSWERS_DIRNAME,
    file: file ?? freshFile ?? reserved,
    reserved: freshFile ?? reserved,
    ...(freshFile ? { earlier: fresh.earlier } : {}),
    ...(existing.length ? { existing } : {}),
    lastSeen,
    says: ANSWERS_SAYS,
    ...(incrementalAnswers() ? { incremental: ANSWERS_INCREMENTAL_SAYS } : {}),
    ...(inroundVerify() ? { check: ANSWERS_CHECK_SAYS } : {}),
    because: file ? ANSWERS_EXISTING_SAYS : existing.length ? ANSWERS_SPLIT_SAYS : freshFile ? ANSWERS_FRESH_SAYS : ANSWERS_RESERVED_SAYS,
    // NEVER A PATH UNDER `.claude/`. The harness refuses writes there, above
    // the project allowlist, so a field that named one as a destination would
    // be an instruction the agent cannot carry out — which is the state a
    // repair item was in: its only two write targets were
    // `.claude/charpilot/proposals` and `.claude/charpilot/proposals/BLOCKED.md`,
    // so a repair could be neither answered NOR declared blocked.
    never:
      "You never write under `.claude/`. The proposals directory and BLOCKED.md are where the TOOLS materialise " +
      "what you submit; they are addresses to READ. Everything you write goes in this directory, under this name, " +
      "and the step spawns the tool that owns the format.",
    budget: PARALLELISM.budget,
  };
}

/**
 * The blocks a packet carries because they are RULES and not evidence.
 *
 * Both steps call this, so the objects a derive packet carries are the same
 * objects a repair packet carries — identity and not a copy, which is what
 * `handover.packets-share-one-furniture` asserts by comparing them.
 */
export function packetFurniture() {
  return {
    mockKinds: MOCK_KIND_RULE,
    parallelism: PARALLELISM,
  };
}

/** The furniture's keys, so a test can ask for them by name rather than by shape. */
export const FURNITURE_KEYS = Object.freeze(["mockKinds", "parallelism"]);

/*
 * `COVERS_RULE` is deliberately NOT in there, and the reason is the rule this
 * whole section is about. `derive` already states it, per row, in
 * `proposal.rules` — a block `SHARED_BLOCKS` writes once per packet file and
 * which `derive.cites-only-what-it-covers` pins verbatim by deleting it. Adding
 * a second statement of the same rule to a derive packet would be the drift
 * being avoided, written by the thing that avoids it. A repair round has no
 * `proposal.rules` — there is no skeleton and no row to state them for — so its
 * packet carries `COVERS_RULE` instead, and its items carry the SET
 * (`proposal.cite.arms`), which is the half a rule cannot supply.
 */
