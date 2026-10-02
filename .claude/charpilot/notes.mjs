#!/usr/bin/env node
/**
 * notes.mjs — a read-through cache of what a worker LEARNED about a source file.
 *
 *   node .claude/charpilot/notes.mjs --submission charpilot-answers/w3-notes.json --round 2
 *   node .claude/charpilot/notes.mjs --get src/agent/agent.ts --by worker-3 --round 2
 *   node .claude/charpilot/notes.mjs --put src/agent/agent.ts --by worker-3 --round 2 \
 *        --entries facts.json [--read full|ranged]
 *   node .claude/charpilot/notes.mjs --ranged src/agent/agent.ts --from 66 --to 111 \
 *        --by worker-3 --round 2
 *   node .claude/charpilot/notes.mjs --full-read src/agent/agent.ts --by worker-3 --round 2
 *   node .claude/charpilot/notes.mjs --counters [--json]
 *
 * THE ANSWERING TURN RUNS NONE OF THESE, AND THAT IS NOT A DETAIL. The deriving
 * prompt forbids running any tool in `.claude/charpilot/` and forbids writing
 * anywhere under `.claude/`, and `prompts.submit-never-run.test.mjs` exists
 * specifically to stop an exception being carved for one tool: the rule removed
 * 193 calls and 55.4 minutes of contract lookup from run `20260916T031317Z`, a
 * quarter of it, because an agent that MAY call a tool first has to learn the
 * tool. `blocked.mjs` was the last tool to want an exception and did not get
 * one. So this file takes the same route the writers before it take:
 *
 *   SERVING is done by the step. `noteCacheFurniture` puts the note's entries
 *   INLINE at the top of the packet's own file, so a hit costs the worker
 *   nothing at all — no command, no path to find, no second file to open. That
 *   is strictly cheaper than a tool call, which is why it is not a compromise.
 *
 *   PUBLISHING is a SUBMISSION. The worker writes one more file into
 *   `charpilot-answers/` — `{ "notes": [ { "source": …, "entries": [ … ] } ] }`
 *   — and the round materialises it by spawning `--submission`, exactly as it
 *   spawns `propose.mjs` for a proposal and `blocked.mjs` for a ruling. Every
 *   verification below still happens before a byte is written, and a fact that
 *   does not check comes back to the worker as a `submission` item — THAT FACT
 *   ALONE. The facts beside it that did check are published, the write exits
 *   `PARTIAL_EXIT` and says how many of each, and a note none of whose facts
 *   check is still refused whole. See `publishNote` for what the old
 *   all-or-nothing rule cost run `20260919T092410Z`.
 *
 * WHAT THAT COSTS, said plainly: a note written in round N is served in round
 * N+1, so two workers in the SAME round who both read one file both pay for it.
 * The measurement says most of the waste is not that — 1,537 reads over 214
 * paths across NINE rounds — but it is real, and the only way to close it is an
 * exception to a rule that has already been paid for twice.
 *
 * THE MEASUREMENT THAT PAID FOR THIS, run `20260918T164503Z` (tracy-worker, nine
 * rounds, $225.19) — AND ITS LOG IS GONE. No directory of that stamp exists on
 * any reachable checkout; the counts below are plan 13's D45 table
 * (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`), which is where
 * they can still be checked and the only place they can. Everything this file
 * attributes to that run is that table. 1,537 `Read` calls over 214 distinct paths: 86% of the calls
 * and 91% of the BYTES were re-reads. `src/agent/agent.ts` was read 72 times at
 * 47.2 KB a time — 3.48 MB, roughly 869k tokens, of one file. Across every path
 * that resolved, 56.7 MB delivered and 51.7 MB of it re-read. And 1,723 `Bash`
 * calls, MORE than the reads, most of them greps of files that had just been
 * read. Six workers per round, nine rounds, and nothing carried a reading
 * forward: not between workers in one round, not between rounds, not into the
 * next run.
 *
 * WHAT THAT IS AND IS NOT WORTH. 12.9M tokens of re-read content is worth about
 * $39 at Sonnet list input rates if none of it was cached and about $4 if nearly
 * all of it was — 17% of that run, or 2% of it. The run recorded no token usage
 * at all (`agentlog._usage` reads a `usage` object this gateway does not send),
 * so the byte figures are measured and the dollar figures are a range. The
 * counters below exist to close that range with one instrumented round; nothing
 * here claims it is already closed.
 *
 * THE PRINCIPLE THE WHOLE DESIGN HANGS ON, from plan 14:
 *
 *     Notes are a navigation cache, not an authority layer.
 *
 * A note says WHERE to look and HOW to set the subject up. It never says what
 * the code does. `validate.mjs` requires `covers` armIds byte-exact and
 * `from.evidence` pointing at a path that exists, so a proposal cites the source
 * file and the line — never a note — and a note hit can never by itself satisfy
 * an evidence or a coverage requirement. Everything this file refuses follows
 * from that sentence.
 *
 * HOW THIS DIFFERS FROM THE NOTES ALREADY IN `steps/handover.mjs`, because two
 * things called notes in one toolset is a trap. Those are PACKET notes: short
 * sentences a STEP mints about one FUNCTION out of its own artifacts, carried in
 * the handover from one round to the next, keyed to a 12-character digest of the
 * function's own text. These are FILE notes: line-addressed facts a WORKER
 * writes about a whole SOURCE FILE after reading it, keyed to the sha256 of the
 * file's bytes, living on disk in `out/notes/` where the next worker, the next
 * round and the NEXT RUN can all hit them. They do not replace each other and
 * neither reads the other's storage.
 *
 * WHY ONE FILE PER SOURCE SHA rather than one shared append-only document. The
 * shared document is the shape `blocked.mjs` has, and it is the wrong shape
 * here: six workers run at once, so one document puts all six behind one lock,
 * and one corrupt write costs every note at once instead of one. So: one note
 * file per `<path>@<sha256>`, written temp-then-rename so a reader never sees a
 * half-written note, with the lock held only over that one file. A journal
 * compacted later is the other alternative and is worth it only if per-file
 * contention turns out to be real — which the `noteLockWaits` counter measures
 * rather than assumes.
 *
 * WHY THE KEY IS THE CONTENT AND NOT THE PATH. The source does not change during
 * a run, so within one run every hit is trivially valid. Keying on content is
 * what makes a note survive into the NEXT run and invalidate itself the moment
 * the service changes: a note whose key does not match the file on disk is a
 * MISS, not a stale hit, and nothing has to remember to expire it.
 *
 * WHY VERIFICATION COMES BEFORE THE WRITE, AND BEFORE THE DERIVATION. An earlier
 * draft of plan 14 wrote the note first so that a derivation which then failed
 * still left the reading behind. That is a bad trade: it publishes unverified
 * interpretation into shared infrastructure, six workers inherit it, and one
 * model's mistake acquires a provenance that looks like a fact. The probe
 * measured 5 false claims out of 16 on notification-ms; a note repeating one of
 * those to six workers is worse than six workers each reading the file. So a
 * note is written after its claims have been checked against the source they
 * cite, or it is not written.
 *
 * THAT IS A RULE ABOUT A FACT AND NOT ABOUT A FILE, and reading it as the
 * second cost three rounds of dead cache on run `20260919T092410Z`. A fact
 * that does not check is not written. A fact that does check is not made
 * unverified by the one beside it — `verifyEntries` checked both, against the
 * bytes, and knows which is which. Nothing below is more tolerant than it was;
 * the refusal is the same refusal, aimed at the entry that earned it.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

/* ------------------------------------------------------------------------ *
 * WHERE NOTES LIVE, AND WHY THAT IS THE COMPOUNDING PART.
 *
 * `out/notes/`, beside the other artifacts, published by `publish_recording`
 * like everything else and committed to the characterization branch. Plan 13's
 * banking gives a run something to resume FROM; these give it something to
 * resume WITH. A second run against the same service starts with every reading
 * the first one paid for, and a service characterized over three runs pays for
 * `agent.ts` once rather than 72 times per run.
 * ------------------------------------------------------------------------ */
export const NOTES_DIR = resolve(OUT_DIR, "notes");

/** The per-process event log lives under the notes directory it describes. */
export const eventsDirFor = (dir = NOTES_DIR) => join(dir, "_events");

/* ------------------------------------------------------------------------ *
 * THE ENTRY SCHEMA — eight fields, and no ninth.
 *
 * `kind` says whether the writer SAW it or concluded it. `confidence` says
 * whether anybody has checked. They are not the same axis, and the combination
 * that must never exist is `inferred` + `verified`: an inference is promoted
 * only by a reader who did the ranged read and is then recording an observation
 * of its own.
 *
 * A NINTH FIELD IS REFUSED BY NAME, which is `blocked.mjs`'s discipline and is
 * the strongest of the three things stopping a note from becoming an authority
 * layer. `expected`, `value`, `returns`, `behaviour`, `assert` — a proposal
 * could cite any of those INSTEAD of the source, and the cheapest way to make
 * that impossible is for there to be nowhere to put one. The lexical check
 * below is the weaker second line; `validate.mjs` is the third and the only one
 * that is airtight, because it demands `from.evidence` be a real path.
 * ------------------------------------------------------------------------ */
export const ENTRY_FIELDS = Object.freeze([
  "fact",
  "source",
  "lines",
  "source_sha",
  "kind",
  "confidence",
  "written_by",
  "round",
]);

export const KINDS = Object.freeze(["observed", "inferred"]);
export const CONFIDENCES = Object.freeze(["verified", "needs-check"]);

/**
 * How long one fact may be.
 *
 * 300 characters. A fact that needs a paragraph is an explanation, and an
 * explanation is what the source is for — the note says where to look. The
 * alternative, no cap, costs the whole point: three 4 KB facts and the note is
 * the size of the file it describes, which is the state the ceiling below
 * exists to prevent and which one entry could reach on its own.
 */
export const MAX_FACT_CHARS = 300;

/**
 * Phrases a note may not contain, each with what it would cost.
 *
 * WHAT THIS CATCHES AND WHAT IT CANNOT. It catches the COPYABLE shapes — the
 * ones a worker could lift out of a note and paste into a proposal as an
 * expected value or an assertion. It cannot catch a sentence that claims
 * behaviour in ordinary prose, and no keyword list can: plan 14's own list of
 * useful notes includes "a driver that returns a closure", so `returns` on its
 * own has to be allowed. That gap is covered structurally rather than
 * lexically — there is no field for a value, and `validate.mjs` will not accept
 * a note as evidence — and saying so plainly is better than a longer list that
 * refuses honest navigation facts and reads as thorough.
 */
export const AUTHORITY_MARKERS = Object.freeze([
  {
    pattern: /\bexpect(?:ed|s)?\s*[:=(]/i,
    why: "reads as an expected value. Stage 4 records what the code did; a note that predicts it is the artifact this pipeline exists not to produce",
  },
  {
    pattern: /\bexpected\s+(?:value|values|output|result|results|return|behaviour|behavior)\b/i,
    why: "names an expected value outright, which a proposal could cite instead of running the code",
  },
  {
    pattern: /\bto(?:Be|Equal|Throw|Match|Contain|HaveBeenCalled)\w*\s*\(/,
    why: "is an assertion, copyable straight into a test. A note says where to look, never what the answer is",
  },
  {
    pattern: /\bassert\w*\s*\(/i,
    why: "is an assertion, copyable straight into a test",
  },
  {
    pattern: /\bshould\s+(?:return|throw|equal|be|produce|reject|resolve|contain)\b/i,
    why: "is a claim about behaviour. Six workers inherit a note; one model's mistake in it acquires a provenance that looks like a fact",
  },
  {
    pattern: /\b(?:always|never)\s+returns\b/i,
    why: "is a claim about behaviour stated as a universal, which is the hardest kind to check and the easiest to trust",
  },
]);

/* ------------------------------------------------------------------------ *
 * THE SIZE CEILING.
 *
 * Append-only plus self-correction grows, and a note that reaches the size of
 * the file it describes has given back everything this exists for. 4 KB or a
 * THIRD of the source, whichever is SMALLER.
 *
 * MEASURED AGAINST THE ENTRIES, not against the whole file. The ceiling is
 * about what a reader has to read in order to navigate, which is the entries;
 * the envelope's bookkeeping (`writes`, `compactions`) is capped separately at
 * eight rows each so it can never crowd the entries out of their own budget.
 * The number therefore does NOT include the envelope, the key, or the JSON
 * punctuation around the entries array — a note file on disk is a few hundred
 * bytes larger than its ceiling by construction.
 *
 * IT WAS A TENTH, AND A TENTH THREW AWAY NINE FACTS IN TEN THAT HAD ALREADY
 * BEEN CHECKED. Run `20260920T030124Z` (location-ms) is the measurement, and
 * it is the clearest number this file has: 75 facts verified against the bytes
 * they cite, published into four notes, and EIGHT of them on disk at the end.
 * Not refused — refused facts are named back to their worker and are a
 * different count. Compacted out, silently, by a ceiling that was a tenth of a
 * file nobody had made big enough:
 *
 *     src/utils/decoratorsWrapperFunction.ts   4,723 B →   472 B →  1 of 11 facts
 *     src/utils/googleMaps.utils.ts            5,664 B →   566 B →  1 of  6
 *     src/services/googleMap.service.ts       17,076 B → 1,707 B →  3 of 18
 *     src/services/location.service.ts        18,203 B → 1,820 B →  3 of 40
 *
 * A stamped entry is ~400 bytes — a 64-character sha, the path, the range, four
 * small fields and the fact itself — so a 472-byte ceiling admits ONE, and a
 * note that can hold one fact about a 5 KB file is not a cache. Every one of
 * those four notes recorded eight writes and eight compactions of the same
 * facts being appended and squeezed straight back out.
 *
 * WHY A THIRD, AND WHY THE WORST CASE DOES NOT MOVE. `CEILING_BYTES` is the
 * brief-size guard and it is UNCHANGED: 4 KB of entries is the most a note has
 * ever been allowed to inline into a packet, and it still is. A source file
 * over 40 KB already got the full 4 KB under a tenth. All this changes is that
 * an 18 KB file now gets the ceiling a 41 KB file already had, instead of being
 * punished for being mid-sized. At a third, a hit still saves at least two
 * thirds of the file's bytes by construction, which is the whole of what the
 * fraction was protecting. Re-simulated over that run's own submissions with
 * `compact` unchanged: 8 facts kept becomes 23.
 *
 * WHAT IT COSTS, said plainly rather than left for somebody to find. A note is
 * inlined into the packet that hits it, so this is brief size. Measured at the
 * walk's own indentation over that run's four notes: a packet hitting all four
 * carried 5,651 B of note under a tenth and carries 15,429 B under a third,
 * against the 45,666 B of source those four hits displace. The 25,000 B median
 * budget `handover.one-packet-one-file` holds is measured on the ALL-MISS
 * brief, which this does not touch; no test measures the brief of a packet
 * that hits, and that gap is real and is not closed here.
 * ------------------------------------------------------------------------ */
export const CEILING_BYTES = 4096;
export const CEILING_FRACTION = 3;
export const BOOKKEEPING_ROWS = 8;

export const ceilingFor = (sourceBytes) =>
  Math.max(1, Math.min(CEILING_BYTES, Math.floor(Number(sourceBytes || 0) / CEILING_FRACTION)));

/**
 * Tokens from bytes, at four bytes to the token.
 *
 * WHAT THIS NUMBER IS AND IS NOT. It is a crude constant, not a tokenizer: it
 * does not know the model, it does not know that source code tokenizes worse
 * than prose, and it does not account for prompt caching, which is the whole
 * reason plan 14's dollar figure is a range and not a number. It exists only to
 * put the measured byte count on the same axis as the bill. Every counter below
 * reports bytes beside it so a reader can ignore this one.
 */
export const tokensOf = (bytes) => Math.round(Number(bytes || 0) / 4);

/** The sha256 of a file's bytes, full width. This is the cache key's second half. */
export function sourceSha(text) {
  return createHash("sha256").update(typeof text === "string" ? text : String(text ?? "")).digest("hex");
}

/** `<path>@<sha256>` — the key plan 14 names, written out in full. */
export const noteKey = (path, sha) => `${path}@${sha}`;

/**
 * A repo-relative path, whatever the caller passed.
 *
 * A note keyed by an absolute path is a note that misses on every other
 * checkout, including the container's, which is where these actually run. A
 * path that resolves OUTSIDE the repo is returned as given rather than as
 * `../../..` — it is a fact about the caller, and mangling it would produce a
 * key that looks repo-relative and is not.
 */
export function normalizePath(path, root = REPO_ROOT) {
  const p = String(path ?? "").trim();
  if (!p) return "";
  const rel = relative(root, isAbsolute(p) ? p : resolve(root, p));
  return rel && !rel.startsWith("..") ? rel : p;
}

/**
 * The file one note lives in.
 *
 * `<flattened path>-<8 of sha256(path)>@<16 of sha256(content)>.json`. The
 * flattened path is for a person reading a directory listing; the path digest
 * is what actually separates two paths that flatten the same way (`a/b.ts` and
 * `a-b.ts` are one string apart), and the content digest is the cache key.
 *
 * SIXTEEN characters of the content sha, not sixty-four: a file name near the
 * 255-byte limit breaks on the first deep path, and 16 hex characters is 64
 * bits of collision resistance over the notes of one repo. The full sha is
 * stored INSIDE the note and checked on read, so a truncation collision is a
 * miss and never a wrong hit.
 */
export function noteFileFor(path, sha, { dir = NOTES_DIR, root = REPO_ROOT } = {}) {
  const rel = normalizePath(path, root);
  const flat = rel.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80);
  const pathTag = createHash("sha256").update(rel).digest("hex").slice(0, 8);
  return join(dir, `${flat}-${pathTag}@${String(sha).slice(0, 16)}.json`);
}

/* ------------------------------------------------------------------------ *
 * VERIFICATION — the step that is not optional.
 * ------------------------------------------------------------------------ */

/**
 * The backtick-quoted spans of a fact that can be checked against source bytes.
 *
 * THIS IS THE ONE CHECK THAT ACTUALLY TOUCHES THE FILE. Everything else here is
 * a shape check; this one catches the misremembered symbol, which is the
 * failure mode the probe measured at 5 false claims out of 16. A worker that
 * writes ``the constructor takes `mockTransport` `` about lines 66-111 is
 * asserting those bytes are there, and if they are not the note is wrong before
 * anybody reads it.
 *
 * Only spans that LOOK like source are checked — an identifier, a member path,
 * a module specifier: `/^[\w$@./-]+$/`. A quoted English phrase is prose about
 * the code and is not expected to appear in it, and refusing those would refuse
 * most honest notes.
 */
export function checkableTokens(fact) {
  const out = [];
  for (const m of String(fact ?? "").matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim();
    if (token.length >= 2 && /^[\w$@./-]+$/.test(token)) out.push(token);
  }
  return out;
}

/**
 * Every fact, checked against the bytes the worker just read.
 *
 * Returns `{ ok, rejected }`. `ok` entries are STAMPED: `source`, `source_sha`,
 * `written_by` and `round` are filled from what the tool already knows when the
 * entry leaves them out, and a value that CONTRADICTS what the tool knows is
 * rejected rather than corrected. Filling is safe because none of those four is
 * evidence — they are provenance the caller passed on the command line — and
 * making a worker retype a 64-character sha is how a note gets a typo in the
 * one field that decides whether it ever hits.
 *
 * EVERY REASON AN ENTRY FAILED, NOT THE FIRST ONE, and that is a measurement
 * rather than a preference. Each check used to `return` the moment it fired, so
 * one entry could only ever teach a worker one defect per round — and a round
 * is the unit of retry here, because the worker does not run this tool and
 * learns of a refusal as next round's `submission` item. Run
 * `20260919T092410Z`, `test/fixtures/doubles.ts`, the SAME single-entry note in
 * three consecutive rounds:
 *
 *     round 2   entry[0] has a 384-character `fact` and the limit is 300
 *     round 3   entry[0] has no `lines: [from, to]` of two integers
 *     round 4   entry[0] has no whole-number `round`
 *
 * Three rounds, three defects, one note, and all three were visible in the
 * bytes the first call already had in hand. `src/lib/logger.ts` and
 * `src/agent/prompts/queryBuilding.ts` walked the same three steps in the same
 * three rounds. So `rejected[i]` now carries `whys`, every reason this entry
 * failed, and `why` is all of them in one sentence for the callers that print
 * it. Checks that depend on an earlier one — the byte check needs a line range
 * to slice — are still skipped rather than reported against a field that was
 * never readable, because a reason derived from a defect the worker already has
 * is noise in an item it is paying for by the byte.
 */
export function verifyEntries(entries, { path, sha, text, by, round, root = REPO_ROOT } = {}) {
  const rel = normalizePath(path, root);
  const lines = String(text ?? "").split("\n");
  const ok = [];
  const rejected = [];
  const reject = (index, whys) => rejected.push({ index, why: whys.join(" "), whys });

  if (!Array.isArray(entries)) {
    return {
      ok: [],
      rejected: [
        {
          index: -1,
          why: "the entries are not a list. One note is a list of entries, even when it holds one.",
          whys: ["the entries are not a list. One note is a list of entries, even when it holds one."],
        },
      ],
    };
  }

  entries.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      reject(index, ["is not an object. An entry is a record with the eight fields, never a bare sentence."]);
      return;
    }
    const whys = [];

    const extra = Object.keys(raw).filter((k) => !ENTRY_FIELDS.includes(k));
    if (extra.length) {
      whys.push(
        `carries ${extra.map((k) => JSON.stringify(k)).join(", ")}, which the entry schema does not have. The eight ` +
          `fields are ${ENTRY_FIELDS.join(", ")}. A ninth field is somewhere a proposal could cite a value instead of ` +
          `the source, and a note is a navigation cache and not an authority layer.`
      );
    }

    const fact = String(raw.fact ?? "").trim();
    if (!fact) {
      whys.push("has no `fact`. An empty fact is not a fact.");
    } else {
      if (fact.length > MAX_FACT_CHARS) {
        whys.push(
          `has a ${fact.length}-character \`fact\` and the limit is ${MAX_FACT_CHARS}. A fact that needs a paragraph is ` +
            `an explanation, and the source is where an explanation belongs — the note says where to look.`
        );
      }
      const marker = AUTHORITY_MARKERS.find((m) => m.pattern.test(fact));
      if (marker) {
        whys.push(
          `\`fact\` ${marker.why}. Rewrite it as navigation — where the decision is made and what a caller has to ` +
            `install first — and let the next worker read the lines you cite.`
        );
      }
    }

    const source = raw.source === undefined ? rel : normalizePath(raw.source, root);
    if (source !== rel) {
      whys.push(`says \`source\` is ${JSON.stringify(raw.source)}, and this note is about ${JSON.stringify(rel)}.`);
    } else if (normalizePath(source, root).split(/[\\/]/).includes("notes")) {
      whys.push("cites a path inside the notes directory. A note may not be another note's evidence.");
    }

    if (raw.source_sha !== undefined && String(raw.source_sha) !== sha) {
      whys.push(
        `carries a \`source_sha\` that is not the sha of ${rel} as it is on disk. A note keyed to bytes nobody has ` +
          `would never hit; leave the field off and it is filled from the file that was read.`
      );
    }

    // THE LINE RANGE IS THE ONE CHECK OTHERS DEPEND ON. A fact with no usable
    // range cannot also be told that its quoted symbols are not in the lines it
    // cites, because it cites none — so the byte check below is SKIPPED rather
    // than reported, and the worker gets the defect it can actually act on.
    const range = raw.lines;
    let from = null;
    let to = null;
    if (!Array.isArray(range) || range.length !== 2 || !range.every((n) => Number.isInteger(n))) {
      whys.push("has no `lines: [from, to]` of two integers. Line evidence is what makes the next read a ranged one.");
    } else if (range[0] < 1 || range[1] < range[0]) {
      whys.push(`has \`lines: [${range[0]}, ${range[1]}]\`, which is not a range. Lines are 1-based and \`to\` is not before \`from\`.`);
    } else if (range[1] > lines.length) {
      whys.push(
        `cites line ${range[1]} and ${rel} has ${lines.length}. A line that is not there is not evidence, and the ranged ` +
          `read this note exists to make possible would come back empty.`
      );
    } else {
      [from, to] = range;
    }

    if (!KINDS.includes(raw.kind)) {
      whys.push(`has \`kind: ${JSON.stringify(raw.kind)}\`, which is not ${KINDS.join(" or ")}.`);
    }
    if (!CONFIDENCES.includes(raw.confidence)) {
      whys.push(`has \`confidence: ${JSON.stringify(raw.confidence)}\`, which is not ${CONFIDENCES.join(" or ")}.`);
    }
    // THE COMBINATION THAT MUST NEVER EXIST. An inference nobody has checked is
    // the useful, honest thing a note can hold; an inference MARKED as checked
    // is an opinion wearing a measurement's clothes, and it is worse than no
    // note because the next reader skips the forty lines that would have caught
    // it. Promotion happens the other way round: a reader does the ranged read
    // and records an OBSERVATION of its own.
    if (raw.kind === "inferred" && raw.confidence === "verified") {
      whys.push(
        "is `inferred` and `verified` at once. An inference is promoted only by a reader who did the ranged read and " +
          "is then recording an observation of its own — write it `inferred` + `needs-check`, and let the next reader " +
          "promote it by observing it."
      );
    }

    const writtenBy = raw.written_by === undefined ? by : String(raw.written_by);
    if (!writtenBy) {
      whys.push("has no `written_by`, and the tool was not told who is writing. Pass `--by`.");
    } else if (by && writtenBy !== by) {
      whys.push(`says it was written by ${JSON.stringify(writtenBy)} and the tool was told ${JSON.stringify(by)}.`);
    }
    const roundOf = raw.round === undefined ? round : raw.round;
    if (!Number.isInteger(roundOf) || roundOf < 0) {
      whys.push("has no whole-number `round`, and the tool was not told one. Pass `--round`.");
    } else if (Number.isInteger(round) && roundOf !== round) {
      whys.push(`says round ${roundOf} and the tool was told round ${round}.`);
    }

    if (fact && from !== null) {
      const cited = lines.slice(from - 1, to).join("\n");
      const missing = checkableTokens(fact).filter((t) => !cited.includes(t));
      if (missing.length) {
        whys.push(
          `quotes ${missing.map((t) => `\`${t}\``).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in ` +
            `${rel}:${from}-${to}. Either the symbol is misremembered or the line range is the wrong one, and both ` +
            `send the next worker to the wrong forty lines.`
        );
      }
    }

    if (whys.length) {
      reject(index, whys);
      return;
    }

    ok.push({
      fact,
      source: rel,
      lines: [from, to],
      source_sha: sha,
      kind: raw.kind,
      confidence: raw.confidence,
      written_by: writtenBy,
      round: roundOf,
    });
  });

  return { ok, rejected };
}

/* ------------------------------------------------------------------------ *
 * COMPACTION.
 * ------------------------------------------------------------------------ */

const isVerifiedObservation = (e) => e.kind === "observed" && e.confidence === "verified";
const rangeKey = (e) => `${e.source}:${e.lines[0]}-${e.lines[1]}`;

/**
 * Which entries a later entry has superseded, derived rather than declared.
 *
 * NO `supersedes` FIELD, because the schema has eight fields and a ninth is
 * where a value would hide. Supersession is read off what the protocol already
 * produces: a reader who does the ranged read and records an observation of its
 * own is recording it over THE SAME LINES, so within one line range a later
 * `observed`+`verified` entry supersedes every earlier entry there that is not
 * one. Exact restatements — same fact, same range — are superseded by their own
 * last copy, which is how the same reading written down in three rounds costs
 * one entry.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never supersedes one verified
 * observation with another. Two workers who observed different things about the
 * same forty lines have a disagreement, and dropping one of them silently is
 * how a shared note amplifies a mistake instead of recording it. Both stay,
 * both keep their provenance, and the next reader sees that there is a question.
 */
export function supersededIndexes(entries) {
  const out = new Set();
  const list = entries ?? [];
  list.forEach((entry, i) => {
    for (let j = i + 1; j < list.length; j += 1) {
      const later = list[j];
      if (rangeKey(later) !== rangeKey(entry)) continue;
      if (later.fact === entry.fact) {
        out.add(i);
        break;
      }
      if (isVerifiedObservation(later) && !isVerifiedObservation(entry)) {
        out.add(i);
        break;
      }
    }
  });
  return out;
}

/** The bytes a reader pays for: the entries, and nothing around them. */
export const entriesBytes = (entries) => Buffer.byteLength(JSON.stringify(entries ?? []), "utf8");

/**
 * The note, brought back under its ceiling.
 *
 * Returns `{ entries, dropped, overCeiling }`. The order it drops in is the
 * order plan 14 states and then the only sensible continuation of it:
 * superseded entries first, then the oldest entry that is not a verified
 * observation, and only then the oldest verified observation. One entry always
 * survives — a note compacted to nothing is a key that hits and says nothing,
 * which costs a worker a read AND a round trip. When even one entry is over the
 * ceiling, `overCeiling` says so rather than the note quietly being too big.
 *
 * NOTHING IS DROPPED UNTIL THE CEILING IS REACHED, including entries that are
 * already superseded. A note is append-only and self-correcting: a worker that
 * finds one WRONG appends a correction naming what it observed, and the
 * superseded entry stays with its provenance rather than being deleted, because
 * the disagreement is itself worth reading. Compaction is what the ceiling
 * forces, not what every write does, and the alternative — dropping a
 * superseded entry the moment it is superseded — throws away the record of a
 * correction having happened at all, which is the only evidence a note ever
 * misled anybody.
 */
export function compact(entries, { ceiling } = {}) {
  const limit = Number(ceiling) || CEILING_BYTES;
  if (entriesBytes(entries) <= limit) return { entries: [...(entries ?? [])], dropped: [], overCeiling: false };
  const superseded = supersededIndexes(entries);
  const dropped = [];
  let kept = (entries ?? []).filter((e, i) => {
    if (!superseded.has(i)) return true;
    dropped.push({ entry: e, why: "superseded" });
    return false;
  });

  const dropOldest = (predicate, why) => {
    const i = kept.findIndex(predicate);
    if (i === -1) return false;
    dropped.push({ entry: kept[i], why });
    kept = kept.filter((_, k) => k !== i);
    return true;
  };

  while (entriesBytes(kept) > limit && kept.length > 1) {
    if (dropOldest((e) => !isVerifiedObservation(e), "over the ceiling, and not a verified observation")) continue;
    dropOldest(() => true, "over the ceiling, and the oldest verified observation in the note");
  }

  return { entries: kept, dropped, overCeiling: entriesBytes(kept) > limit };
}

/* ------------------------------------------------------------------------ *
 * THE EVENT LOG — how the counters are kept without a second shared lock.
 *
 * Every worker is its own process, so the counters cannot live in one JSON file
 * that each of them read-modify-writes: that is the shared document this design
 * rejected for the notes themselves, one level down, and it would put six
 * workers behind one lock to count how well the per-file locks are working.
 *
 * So each process appends one JSON line per event to its OWN file under
 * `_events/`, with `O_APPEND` and no lock at all, and `counters()` folds the
 * directory. Nothing contends, nothing can be lost by a losing rename, and the
 * cost is that the fold is O(events) — which for the run that motivated this is
 * about 1,500 lines.
 * ------------------------------------------------------------------------ */
const EVENT_FILES = new Map();
let EVENT_SEQ = 0;

function eventFile(dir) {
  const events = eventsDirFor(dir);
  if (!EVENT_FILES.has(events)) {
    mkdirSync(events, { recursive: true });
    const tag = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    EVENT_FILES.set(events, join(events, `${tag}.jsonl`));
  }
  return EVENT_FILES.get(events);
}

/**
 * One counted event.
 *
 * Failures here are SWALLOWED, which is the one place in this file that is
 * true. A worker mid-derivation whose measurement log is unwritable must still
 * get its note: losing a counter costs a number in a report, and losing the
 * note costs the full read this whole tool exists to remove.
 */
export function recordEvent(kind, payload = {}, { dir = NOTES_DIR } = {}) {
  const event = { at: Date.now(), seq: (EVENT_SEQ += 1), pid: process.pid, kind, ...payload };
  try {
    appendFileSync(eventFile(dir), `${JSON.stringify(event)}\n`);
  } catch {
    // Reported by its absence from the counters, which is the honest result:
    // a counter that cannot be written is a number nobody should have.
  }
  return event;
}

/** Every event on disk, in the order they happened. */
export function readEvents({ dir = NOTES_DIR } = {}) {
  const events = eventsDirFor(dir);
  if (!existsSync(events)) return [];
  const out = [];
  for (const name of readdirSync(events).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    let text;
    try {
      text = readFileSync(join(events, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // ONE TORN LINE DOES NOT ERASE THE LOG. A process killed mid-append
        // leaves a partial line, and throwing here would turn a lost counter
        // into a lost report.
      }
    }
  }
  // `at` is a millisecond clock and six workers can share one, so `pid` and
  // `seq` break the tie deterministically. The order matters for exactly one
  // counter — a full read AFTER a hit — and for nothing else.
  out.sort((a, b) => a.at - b.at || a.pid - b.pid || a.seq - b.seq);
  return out;
}

/**
 * The numbers plan 14 asks for, folded out of the event log.
 *
 * WHAT EACH ONE DOES AND DOES NOT INCLUDE:
 *
 *   fullReadMisses   a `--get` that found no note for the file's current sha.
 *                    It counts the miss, not the read: a worker that asked and
 *                    then never read is still a miss here.
 *   noteHits         a `--get` that served a note. Every hit also carries the
 *                    bytes of the note against the bytes of the file.
 *   rangedReads      a `--ranged` fallback. This is the EXPECTED move after a
 *                    hit that does not answer the question, and after a
 *                    `needs-check` fact, so it is not a failure of the cache.
 *   bytesSaved       source bytes minus served bytes, summed over hits and
 *                    ranged reads. It does NOT subtract the ranged read a hit
 *                    later cost — that read is counted as its own row, with its
 *                    own saving against the same baseline — and it does not
 *                    know about prompt caching, which is the difference between
 *                    plan 14's $39 and its $4.
 *   promotions       a `needs-check` or `inferred` fact on some line range,
 *                    later joined by a verified observation of the same range.
 *   corrections      a verified observation landing on a range that already had
 *                    a DIFFERENT verified observation. That is a disagreement
 *                    between two readings and both entries stay.
 *   duplicateFullReadsAfterHit
 *                    THE NUMBER THAT SAYS WHETHER THIS IS WORKING OR MERELY
 *                    RUNNING. A worker that reads the note and then reads the
 *                    file in full anyway is telling you the note is not
 *                    carrying what the work needs. It counts only what passes
 *                    through this tool: a `--put --read full` or an explicit
 *                    `--full-read` by a worker that already hit that key. A
 *                    worker that silently re-reads the file is invisible here
 *                    and visible only in the agent log's own `Read` calls,
 *                    which is where run 20260918T164503Z's 1,537 came from
 *                    (by way of plan 13's D45 table — that run's log is gone).
 *   lockWaits        how often a writer waited on another writer's lock, and
 *                    the longest wait. This is the measurement that decides
 *                    whether per-file contention is real and a journal would
 *                    have been the better shape.
 */
export function counters({ dir = NOTES_DIR } = {}) {
  const c = {
    noteHits: 0,
    fullReadMisses: 0,
    rangedReads: 0,
    notesWritten: 0,
    notesPartial: 0,
    entriesWritten: 0,
    entriesRejected: 0,
    compactions: 0,
    entriesCompacted: 0,
    promotions: 0,
    corrections: 0,
    duplicateFullReadsAfterHit: 0,
    lockWaits: 0,
    longestLockWaitMs: 0,
    bytesDelivered: 0,
    bytesSaved: 0,
  };
  const hitBy = new Set();
  for (const e of readEvents({ dir })) {
    const who = `${e.written_by ?? "?"}|${e.key ?? "?"}`;
    switch (e.kind) {
      case "hit":
        c.noteHits += 1;
        c.bytesDelivered += e.served_bytes ?? 0;
        c.bytesSaved += Math.max(0, (e.source_bytes ?? 0) - (e.served_bytes ?? 0));
        hitBy.add(who);
        break;
      case "miss":
        c.fullReadMisses += 1;
        c.bytesDelivered += e.source_bytes ?? 0;
        break;
      case "ranged":
        c.rangedReads += 1;
        c.bytesDelivered += e.served_bytes ?? 0;
        c.bytesSaved += Math.max(0, (e.source_bytes ?? 0) - (e.served_bytes ?? 0));
        break;
      case "full-read":
        if (hitBy.has(who)) c.duplicateFullReadsAfterHit += 1;
        break;
      case "write":
        c.notesWritten += 1;
        // A NOTE THAT LANDED INCOMPLETE IS COUNTED AS BOTH. It IS a write — it
        // is on disk and it will serve — and it is also a reading that is
        // missing facts the worker paid to produce, which is the number that
        // says whether the partial-write rule is carrying work or hiding a
        // worker that cannot write a schema.
        if ((e.refused ?? 0) > 0) c.notesPartial += 1;
        c.entriesWritten += e.added ?? 0;
        c.promotions += e.promotions ?? 0;
        c.corrections += e.corrections ?? 0;
        if (e.read === "full" && hitBy.has(who)) c.duplicateFullReadsAfterHit += 1;
        break;
      case "refused":
        // COUNTED ONCE, from the `refused` event, whether or not the rest of
        // that note landed. The `write` event beside it carries the same
        // `refused` number for `notesPartial` and is deliberately not added in
        // here — two counters over one fact would double it.
        c.entriesRejected += e.rejected ?? 0;
        break;
      case "compaction":
        c.compactions += 1;
        c.entriesCompacted += e.dropped ?? 0;
        break;
      case "lock-wait":
        c.lockWaits += 1;
        c.longestLockWaitMs = Math.max(c.longestLockWaitMs, e.waited_ms ?? 0);
        break;
      default:
        break;
    }
  }
  const asked = c.noteHits + c.fullReadMisses;
  c.noteHitRate = asked ? Number((c.noteHits / asked).toFixed(4)) : 0;
  c.tokensDelivered = tokensOf(c.bytesDelivered);
  c.tokensSaved = tokensOf(c.bytesSaved);
  return c;
}

/* ------------------------------------------------------------------------ *
 * THE LOCK — blocked.mjs's mechanism, and the one place it behaves differently.
 * ------------------------------------------------------------------------ */

/** A synchronous sleep with no busy loop. `Atomics.wait` is the only one in Node. */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const LOCK_TIMEOUT_MS = 10_000;
export const LOCK_STALE_MS = 60_000;
const LOCK_POLL_MS = 15;

/**
 * Take the lock for ONE note file, waiting for it rather than refusing.
 *
 * WHY THIS WAITS WHERE `blocked.mjs` REFUSES, which is the one deliberate
 * divergence from the mechanism it borrows. `blocked.mjs`'s contract is that it
 * either wrote the entry it was given or changed nothing, and its entries are
 * RULINGS whose order in a document a person reads should not depend on process
 * scheduling — so its loser refuses and says so, to an agent that can retry.
 *
 * A note has neither property. Its entries are order-independent records in a
 * cache, and its writer is a worker in the middle of a derivation with nobody
 * to report a refusal to. A refused note means the reading is thrown away and
 * the next worker pays the full read again, which is the exact cost this file
 * exists to remove. So the loser waits, and it waits on ONE source file's lock
 * rather than on a document every worker needs.
 *
 * A STALE LOCK IS BROKEN, ON PURPOSE. A container worker killed mid-write
 * leaves a lock behind, and because the note lives in `out/` and is committed,
 * that one source file would be uncacheable for the rest of the run AND every
 * later run against the repo. Sixty seconds is far longer than a write of a few
 * kilobytes and far shorter than a run, and the break is reported in the result
 * rather than done quietly.
 */
export function takeLock(file, { timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS, dir = NOTES_DIR } = {}) {
  const lock = `${file}.lock`;
  const started = Date.now();
  let waited = 0;
  let brokeStale = false;
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      if (waited) recordEvent("lock-wait", { file, waited_ms: waited }, { dir });
      return { lock, waitedMs: waited, brokeStale };
    } catch (err) {
      // ONLY EEXIST IS CONTENTION. A read-only mount or a full disk reported as
      // "another writer holds" sends the reader to look for a process that does
      // not exist — blocked.mjs learned that one from a bare catch that told a
      // missing directory to wait for a writer.
      if (err?.code !== "EEXIST") throw err;
      waited = Date.now() - started;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // It was released between the failed create and the stat. Go round.
      }
      if (age > staleMs) {
        try {
          unlinkSync(lock);
          brokeStale = true;
          continue;
        } catch {
          // Somebody else broke it first, which is the same outcome.
        }
      }
      if (waited >= timeoutMs) {
        throw new Error(
          `waited ${waited}ms for ${lock} and it is still held. Two writers appending at once can lose an entry ` +
            `silently, so this refuses rather than races. If no writer is running, the lock is stale from a killed ` +
            `process and deleting it is safe.`
        );
      }
      sleep(LOCK_POLL_MS);
    }
  }
}

export function releaseLock(lock) {
  try {
    if (lock && existsSync(lock)) unlinkSync(lock);
  } catch {
    // A lock that cannot be removed is reported by the next writer's wait, and
    // broken by it sixty seconds later. Throwing here would fail a write that
    // has already landed.
  }
}

/* ------------------------------------------------------------------------ *
 * READ AND WRITE.
 * ------------------------------------------------------------------------ */

function readSource(path, root) {
  const rel = normalizePath(path, root);
  const abs = isAbsolute(path) ? path : resolve(root, rel);
  if (!existsSync(abs)) return { rel, abs, missing: true };
  const text = readFileSync(abs, "utf8");
  return {
    rel,
    abs,
    text,
    sha: sourceSha(text),
    bytes: Buffer.byteLength(text, "utf8"),
    lineCount: text.split("\n").length,
  };
}

/**
 * The read half of the protocol: hit, or miss.
 *
 * A MISS IS A MISS AND NEVER A STALE HIT. The note file is found by the file's
 * CURRENT sha, and the key stored inside it is compared as well — so a
 * truncated-name collision, or a note somebody copied between repos, reads as a
 * miss rather than as somebody else's facts about somebody else's file.
 *
 * `record: false` turns the counting off, which is what the furniture builder
 * and the tests use: asking whether a note exists in order to TELL a worker
 * about it is not the worker hitting it, and counting it as a hit would inflate
 * the one rate this plan is judged on.
 */
export function readNote(path, { root = REPO_ROOT, dir = NOTES_DIR, by = null, round = null, record = true } = {}) {
  const src = readSource(path, root);
  if (src.missing) {
    return { hit: false, missing: true, path: src.rel, why: `${src.rel} is not in this checkout, so there is nothing to note.` };
  }
  const key = noteKey(src.rel, src.sha);
  const file = noteFileFor(src.rel, src.sha, { dir, root });
  const miss = (why) => {
    if (record) {
      recordEvent("miss", { key, path: src.rel, source_bytes: src.bytes, written_by: by, round }, { dir });
    }
    return { hit: false, key, path: src.rel, sha: src.sha, file, sourceBytes: src.bytes, why };
  };

  if (!existsSync(file)) {
    return miss(
      `no note for ${src.rel} at its current sha. Read it in full, extract the facts with their line evidence, ` +
        `verify each against the bytes you just read, publish the note, and only then derive.`
    );
  }
  let note;
  try {
    note = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return miss(`the note file for ${src.rel} will not parse (${err.message}), so it is treated as absent.`);
  }
  if (note?.key !== key) {
    return miss(
      `the note file found for ${src.rel} is keyed ${JSON.stringify(note?.key)} and this file is ${JSON.stringify(key)}. ` +
        `A note whose key does not match the file on disk is a miss, not a stale hit.`
    );
  }
  const served = Buffer.byteLength(JSON.stringify(note), "utf8");
  // A NOTE THAT IS NOT SMALLER THAN ITS FILE IS A RE-READ WITH EXTRA STEPS.
  // Measured while wiring this up: a 113-byte source has a ceiling of 11 bytes,
  // so its note compacts to one entry and still serves 845 bytes — seven times
  // the file, for a navigation aid nobody needs on a six-line file. `publishNote`
  // refuses to write one of these; this is the same judgement applied to notes
  // already on disk, including any written by an earlier version of this tool.
  if (served >= src.bytes) {
    return miss(
      `the note for ${src.rel} is ${served} bytes and the file itself is ${src.bytes}, so serving it would cost more ` +
        `than reading the file. Read the file.`
    );
  }
  if (record) {
    recordEvent(
      "hit",
      { key, path: src.rel, source_bytes: src.bytes, served_bytes: served, entries: note.entries?.length ?? 0, written_by: by, round },
      { dir }
    );
  }
  return { hit: true, key, path: src.rel, sha: src.sha, file, note, servedBytes: served, sourceBytes: src.bytes };
}

/**
 * The write half: verify everything, then publish what verified, then derive.
 *
 * REFUSES THE FACTS THAT DID NOT VERIFY, AND ONLY THOSE. A fact that does not
 * check against the bytes it cites is still rejected — individually, by index,
 * with every reason — and never written. What changed is the blast radius: the
 * eight facts beside it that DID check are published, and the result says so in
 * a way no caller can read as clean (`partial: true`, a non-empty `rejected`,
 * and exit `PARTIAL_EXIT` on the command line).
 *
 * WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT WAS WRONG. It said the wrong one
 * "is the evidence about whether the other four were checked at all", so the
 * whole publish was refused. The premise is false in this pipeline: the worker
 * does not check — THIS FUNCTION DOES, against the bytes, entry by entry, and
 * it knows exactly which four passed. Treating a neighbouring failure as
 * evidence against a fact it has itself verified is discarding its own
 * measurement in favour of a suspicion. And "fixing it is one edit and one
 * re-run" was false too: the worker cannot run this tool (see the docblock at
 * the top), so a refusal costs a whole ROUND.
 *
 * WHAT IT COST, run `20260919T092410Z` (tracy-worker, 185 minutes, four
 * rounds). 8, 9 and 7 facts failed per round across the same 4-6 notes files,
 * every submission refused whole, and `noteCacheHits` stayed at 0 through
 * rounds 1-3 against 95 full-read misses. The 6 notes that finally landed in
 * round 4 saved 139,948 tokens. 46% of the run's 693 `Read` calls were
 * byte-identical repeats; `test/fixtures/doubles.ts` was read end to end 16
 * times while the note about it was refused three rounds running.
 *
 * AN ALL-FAIL NOTE IS STILL AN ERROR, and a different one. Nothing was
 * verified, so nothing is written and there is no partial anything to report —
 * that is a worker whose whole reading of a file did not check out, which is
 * the signal the original refusal was built to give and the only case where it
 * gives it honestly.
 */
export function publishNote({
  path,
  entries,
  by,
  round,
  root = REPO_ROOT,
  dir = NOTES_DIR,
  read = "full",
  timeoutMs = LOCK_TIMEOUT_MS,
} = {}) {
  const src = readSource(path, root);
  if (src.missing) {
    return { written: false, why: `${src.rel} is not in this checkout, so nothing about it can be verified.`, rejected: [] };
  }
  const key = noteKey(src.rel, src.sha);
  const { ok, rejected } = verifyEntries(entries, { path: src.rel, sha: src.sha, text: src.text, by, round, root });
  // THE REFUSAL IS COUNTED WHETHER OR NOT THE REST LANDED. `entriesRejected` is
  // the number that says how much of a round's reading is being thrown away,
  // and a partial write throws away exactly as many facts as a whole refusal of
  // the same entries would have — it just keeps the others.
  if (rejected.length) {
    recordEvent(
      "refused",
      { key, path: src.rel, rejected: rejected.length, verified: ok.length, partial: ok.length > 0, written_by: by, round },
      { dir }
    );
  }
  if (!ok.length) {
    return {
      written: false,
      partial: false,
      key,
      path: src.rel,
      sha: src.sha,
      rejected,
      why: rejected.length
        ? `not one of the ${rejected.length} fact(s) in this note verified against the bytes they cite, so there is ` +
          `nothing to publish. Each is named below with every reason it failed`
        : "no entries were given. A note with no facts is a key that hits and says nothing.",
    };
  }

  mkdirSync(dir, { recursive: true });
  const file = noteFileFor(src.rel, src.sha, { dir, root });
  const tmp = `${file}.${process.pid}.tmp`;
  const { lock, waitedMs, brokeStale } = takeLock(file, { timeoutMs, dir });
  try {
    let before = { key, path: src.rel, source_sha: src.sha, source_bytes: src.bytes, source_lines: src.lineCount, entries: [], writes: [], compactions: [] };
    if (existsSync(file)) {
      try {
        const existing = JSON.parse(readFileSync(file, "utf8"));
        // A note under this exact key describes these exact bytes, so its
        // entries are still about the file in hand. One that is keyed to
        // something else is not merged into — it is replaced, and the
        // replacement is what the key says is true.
        if (existing?.key === key) before = { ...before, ...existing, entries: existing.entries ?? [], writes: existing.writes ?? [], compactions: existing.compactions ?? [] };
      } catch {
        // An unparseable note is an absent note, exactly as on the read side.
      }
    }

    // Promotions and corrections are measured BEFORE the merge, against what
    // the note already held: after the merge every new entry would look like it
    // agreed with itself.
    let promotions = 0;
    let corrections = 0;
    for (const entry of ok) {
      if (!isVerifiedObservation(entry)) continue;
      for (const old of before.entries) {
        if (rangeKey(old) !== rangeKey(entry)) continue;
        if (!isVerifiedObservation(old)) promotions += 1;
        else if (old.fact !== entry.fact) corrections += 1;
      }
    }

    const merged = [...before.entries, ...ok];
    const ceiling = ceilingFor(src.bytes);
    const bytesBefore = entriesBytes(merged);
    const compacted = compact(merged, { ceiling });
    // THE FILE IS TOO SMALL TO BE WORTH A NOTE, and that is a refusal rather
    // than a note nobody can use. `overCeiling` after compaction means even ONE
    // entry does not fit under a third of the source, which only happens on a
    // file of a few hundred bytes: a 113-byte source has a 37-byte ceiling.
    // Writing it anyway produces a note bigger than the file it describes, which
    // `readNote` then refuses to serve — so it would be a write that can never
    // be read, and a hit rate counting reads that never happened.
    if (compacted.overCeiling) {
      return {
        written: false,
        partial: false,
        key,
        path: src.rel,
        sha: src.sha,
        // The facts that failed verification are still reported here. They did
        // not cause this refusal and fixing them will not lift it, but a
        // refusal that mentions only the ceiling would send the worker back
        // next round to discover them one at a time — which is the round-per-
        // defect walk `verifyEntries`'s docblock measures.
        rejected,
        why:
          `${src.rel} is ${src.bytes} bytes, so a note about it may be at most ${ceiling} (4 KB or a third of the ` +
          `source, whichever is smaller) and one fact does not fit. A note bigger than the file it describes costs ` +
          `more than reading the file. Read this one and do not note it`,
      };
    }
    const note = {
      key,
      path: src.rel,
      source_sha: src.sha,
      source_bytes: src.bytes,
      source_lines: src.lineCount,
      ceiling_bytes: ceiling,
      entries: compacted.entries,
      // `by` and `round` fall back to the entries' own provenance, because the
      // submission route passes neither: a worker's facts carry who wrote them
      // and in which round, and the round that materialises them may be a later
      // one. A write log saying `null` would lose the only name it has.
      // A PARTIAL WRITE SAYS SO IN THE NOTE ITSELF, `refused` beside `added`.
      // The note on disk is the only artifact that outlives the round, and a
      // note that quietly holds eight of nine facts reads exactly like a note
      // that holds nine — which is how a reader concludes a file has been fully
      // read when a ninth of it never landed. The field is absent, not zero,
      // when nothing was refused: a clean write stays a clean write.
      writes: [
        ...before.writes,
        {
          at: new Date().toISOString(),
          by: by ?? ok[0].written_by,
          round: round ?? ok[0].round,
          added: ok.length,
          ...(rejected.length ? { refused: rejected.length } : {}),
          read,
        },
      ].slice(-BOOKKEEPING_ROWS),
      // THE COMPACTION IS RECORDED LIKE ANY OTHER WRITE. A note that silently
      // shrank is a note whose missing entries look like readings nobody ever
      // made, which is the same defect as a truncated BLOCKED.md one artifact
      // over.
      compactions: [
        ...before.compactions,
        ...(compacted.dropped.length
          ? [{
              at: new Date().toISOString(),
              by,
              round,
              dropped: compacted.dropped.length,
              kept: compacted.entries.length,
              bytes_before: bytesBefore,
              bytes_after: entriesBytes(compacted.entries),
              ceiling_bytes: ceiling,
              over_ceiling: compacted.overCeiling,
              why: compacted.dropped.map((d) => d.why),
            }]
          : []),
      ].slice(-BOOKKEEPING_ROWS),
    };

    const bytes = `${JSON.stringify(note, null, 2)}\n`;
    writeFileSync(tmp, bytes);
    const onDisk = readFileSync(tmp, "utf8");
    if (onDisk !== bytes) throw new Error("the bytes read back from the temp file are not the bytes written");
    renameSync(tmp, file);

    recordEvent(
      "write",
      { key, path: src.rel, added: ok.length, refused: rejected.length, entries: note.entries.length, promotions, corrections, read, written_by: by, round },
      { dir }
    );
    if (compacted.dropped.length) {
      recordEvent(
        "compaction",
        { key, path: src.rel, dropped: compacted.dropped.length, kept: note.entries.length, ceiling_bytes: ceiling, written_by: by, round },
        { dir }
      );
    }

    return {
      written: true,
      // THE WORD A CALLER CANNOT MISREAD. `written: true` alone is what a clean
      // publish returns, so a partial one has to carry something of its own —
      // and `rejected.length` is not it, because a caller that only ever looked
      // at `written` would go on not looking.
      partial: rejected.length > 0,
      key,
      path: src.rel,
      sha: src.sha,
      file,
      note,
      rejected,
      added: ok.length,
      refused: rejected.length,
      why: rejected.length
        ? `${ok.length} fact(s) verified against the bytes they cite and are in the note; ${rejected.length} did not ` +
          `and are NOT, each named below with every reason. This note is incomplete until they are resubmitted`
        : null,
      promotions,
      corrections,
      compacted: compacted.dropped.length,
      overCeiling: compacted.overCeiling,
      waitedMs,
      brokeStale,
    };
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // A leftover temp is named after this pid and is overwritten by the next
      // write from it. It is never read.
    }
    releaseLock(lock);
  }
}

/**
 * The cheap operation this whole file exists to make possible.
 *
 * Forty lines instead of twelve hundred, with their numbers, and the saving
 * counted against the full read it replaced.
 */
export function rangedRead(path, { from, to, root = REPO_ROOT, dir = NOTES_DIR, by = null, round = null, record = true } = {}) {
  const src = readSource(path, root);
  if (src.missing) return { ok: false, why: `${src.rel} is not in this checkout.` };
  const lines = src.text.split("\n");
  const a = Math.max(1, Number(from) || 1);
  const b = Math.min(lines.length, Number(to) || a);
  if (b < a) return { ok: false, why: `lines [${from}, ${to}] is not a range in a file of ${lines.length} lines.` };
  const slice = lines.slice(a - 1, b);
  const text = slice.map((line, i) => `${a + i}\t${line}`).join("\n");
  const served = Buffer.byteLength(text, "utf8");
  if (record) {
    recordEvent(
      "ranged",
      { key: noteKey(src.rel, src.sha), path: src.rel, from: a, to: b, source_bytes: src.bytes, served_bytes: served, written_by: by, round },
      { dir }
    );
  }
  return { ok: true, path: src.rel, from: a, to: b, text, servedBytes: served, sourceBytes: src.bytes };
}

/**
 * A worker saying it read the file in full.
 *
 * The only way `duplicateFullReadsAfterHit` can see a re-read that did not end
 * in a note. It depends on the worker being honest, and it is worth having
 * anyway: the number it produces is a floor, and a floor above zero is already
 * the finding.
 */
export function recordFullRead(path, { root = REPO_ROOT, dir = NOTES_DIR, by = null, round = null } = {}) {
  const src = readSource(path, root);
  if (src.missing) return { ok: false, why: `${src.rel} is not in this checkout.` };
  recordEvent("full-read", { key: noteKey(src.rel, src.sha), path: src.rel, source_bytes: src.bytes, written_by: by, round }, { dir });
  return { ok: true, path: src.rel, sourceBytes: src.bytes };
}

/* ------------------------------------------------------------------------ *
 * THE SUBMISSION — the route the answering turn actually takes.
 * ------------------------------------------------------------------------ */

/**
 * notes.mjs's whole command line, as a function so a test can assert it exactly.
 *
 * The same shape `blockedArgv` and `proposeArgv` have in `steps/derive.mjs`, so
 * wiring this in is one line beside theirs rather than a new way of spawning a
 * tool. `--round` is the round that MATERIALISES the submission and is only a
 * default: a fact carrying its own round keeps it, because the worker wrote it
 * in the round it was briefed for and that may be the one before this.
 */
export function notesArgv(path, { round = null } = {}) {
  return ["--submission", path, ...(Number.isInteger(round) ? ["--round", String(round)] : [])];
}

/** The key a note submission carries, beside `proposals` and `declarations`. */
export const NOTES_SUBMISSION_KEY = "notes";

/* ------------------------------------------------------------------------ *
 * THE RECEIPT — WHICH SUBMISSIONS THIS TOOL HAS ALREADY HAD ITS SAY ABOUT.
 *
 * D75. `steps/derive.mjs:inspectSubmissions` sorts `charpilot-answers/` into
 * what can still be materialised and what is refused, and `derive.satisfied`
 * then demands that every submission in the first list be in front of the
 * answering turn. That works for the other two formats because each of them can
 * be asked of the artifact it landed in: a proposal is consumed when its rows
 * are on disk with the same bodies (`consumedSubmission`), a declaration when
 * its side is already declared or proposed. A NOTE CANNOT BE ASKED THAT WAY,
 * and the reason is the ceiling. `compact` drops what does not fit under a
 * fraction of the source, so a submission of eleven facts about an 18 KB file
 * lands and leaves some of them out of the note; "are all its facts on disk" is
 * false for a submission that did everything right and will be false for ever.
 *
 * So the step read every `{ "notes": … }` file in the answers directory as
 * outstanding work on every round it ever ran, a cleanly materialised note was
 * never in the handover — nothing was wrong with it — and `derive.satisfied`
 * could not become true again. Run `20260920T030124Z` finished its sides at
 * round 6 with `open=0` and ran to round 10 on 26 such receipts-less notes
 * before the walk failed it for asking no question. The cost is not only the
 * rounds: the same submissions were re-published every round, and all four of
 * that run's notes carry eight writes and eight compactions of the same facts
 * being appended and squeezed out again.
 *
 * WHY A RECEIPT AND NOT A SECOND ACCOUNT OF THE RUN. `derive.satisfied`'s
 * docblock refuses a state file, and is right to: a second account of what the
 * run has done is the one that turns out to be wrong. This is not that. It is
 * this tool's record of which DOCUMENTS it has consumed, in its own output
 * directory beside its own `_events` log, and it is read in exactly one
 * direction — its absence means "materialise this again", which is the safe
 * reading and the one a wiped `out/` produces. Nothing about the run's progress
 * is stored here and nothing downstream reads it.
 *
 * A REFUSAL LEAVES ONE TOO, AND THAT IS THE SECOND HALF OF D75. The receipt
 * says "this tool has consumed this document and said everything it has to say
 * about it", not "this document was good". Rounds 7, 8 and 9 of that same run
 * were handed the IDENTICAL two items — `notes-worker-packet-22-18.json` and
 * `notes-worker-packet-25-26.json`, unchanged, three times — because a refused
 * note was re-materialised and re-raised every round for ever, and not one of
 * those rounds could close a side because every side was already covered. The
 * refusal is raised in the round that produced it, where the answering turn
 * sees it; a document nobody changed since is not a new question. This is D64's
 * shape exactly: the accounting is kept — the receipt records the outcome and
 * the reason — and the loop is not.
 *
 * AN EDIT IS A NEW SUBMISSION, which is what keeps this from swallowing a
 * repair. `noteSubmissionKey` fingerprints the document, so the moment a worker
 * changes a fact the receipt no longer matches, the submission is materialised
 * again and its outcome is raised again. Run `20260920T030124Z`'s round 10 is
 * that case: the agent edited both files in place at 04:51 and both landed.
 * ------------------------------------------------------------------------ */

/** Where a submission this tool has finished with leaves its receipt. */
export const submittedDirFor = (dir = NOTES_DIR) => join(dir, "_submitted");

/**
 * A note submission's identity: its FACTS, and not the file they arrived in.
 *
 * The same fingerprint `steps/derive.mjs:answerId` takes of the same parsed
 * document, so a submission the answering turn EDITED is a different submission
 * to both of them — which is the whole point of the fingerprint there, and has
 * to be the whole point of it here. A worker that renames its file without
 * changing a fact has resubmitted nothing, and this says so.
 */
export function noteSubmissionKey(doc) {
  return createHash("sha256").update(JSON.stringify(doc ?? null)).digest("hex").slice(0, 16);
}

/**
 * Has this tool already consumed this exact document and reported on it?
 *
 * ASKED OF EVERY SHAPE, INCLUDING THE ONES THAT DO NOTHING, and that is not
 * laxness — it is the same defect one file over. `materialiseNoteSubmission` is
 * total: whatever the document is, it produces the last word about it, and an
 * EMPTY `{ "notes": [] }` produces success with nothing published. Nine of run
 * `20260920T030124Z`'s 26 note submissions are exactly that shape — a worker
 * discharging a note obligation it had nothing to write for — and a receipt
 * withheld from them would have left nine files outstanding for ever, which is
 * the whole defect this receipt exists to remove. A document whose `notes` is
 * not a list produces a fault, and that fault is the last word about it too.
 */
export function noteSubmissionConsumed(doc, { dir = NOTES_DIR } = {}) {
  return existsSync(join(submittedDirFor(dir), `${noteSubmissionKey(doc)}.json`));
}

/**
 * Leave the receipt, WITH THE OUTCOME IT IS A RECEIPT FOR.
 *
 * The outcome is written down because this file is the only record that a
 * refusal stopped being asked, and "it stopped being asked" without "and here
 * is what it said" is the silent loss D64's own docblock refuses. Nothing reads
 * these fields — `noteSubmissionConsumed` asks only whether the file is there —
 * and that is the point: they are for whoever asks later why a fact is not in
 * any note.
 *
 * NEVER THROWS. A receipt that could not be written costs a re-materialisation,
 * which is the safe direction; a materialisation that failed because a
 * directory was read-only would cost the facts.
 */
export function recordNoteSubmission(doc, { dir = NOTES_DIR, landed = [], partial = [], faults = [] } = {}) {
  try {
    const at = submittedDirFor(dir);
    mkdirSync(at, { recursive: true });
    writeFileSync(
      join(at, `${noteSubmissionKey(doc)}.json`),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          rows: (doc?.[NOTES_SUBMISSION_KEY] ?? []).length,
          landed: landed.length,
          partial: partial.length,
          faults: faults.length,
          // THE TOOL'S OWN WORDS, not a count of them. A reader asking why a
          // fact is in no note gets the sentence that refused it.
          why: [...faults, ...partial].map((r) => ({ row: r.row, path: r.path ?? null, why: r.why ?? null })),
        },
        null,
        2
      )}\n`
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * THE EXIT STATUS OF A WRITE THAT LANDED SOME OF ITS FACTS AND REFUSED OTHERS.
 *
 * Four, and not zero and not two, and the choice is the whole of what the
 * caller sees.
 *
 *   0  every fact verified and is in the note. Nothing else means this.
 *   2  nothing was written: the document is not a submission, the row names no
 *      source, the file is not in the checkout, the note is bigger than the
 *      file it describes, or not one fact verified.
 *   3  a `--get` miss.
 *   4  the note is on disk and is INCOMPLETE. The facts that verified are
 *      served from the next round; the ones that did not are named on stderr,
 *      by index, with every reason, and they are not in the note.
 *
 * WHY NOT ZERO. A partial write that exits 0 is a note the round believes is
 * whole, and the rejected facts would reach nobody — the worker does not run
 * this tool and sees a refusal only as a `submission` item, which
 * `steps/derive.mjs` raises from a non-zero status. Exit 0 would trade one
 * silent loss for another.
 *
 * WHY NOT TWO. Two means nothing landed, and a caller that retries or reports
 * on that basis would be wrong about a note that is already on disk. The
 * distinction costs one integer and is the difference between "resubmit these
 * three facts" and "resubmit this file".
 *
 * WHAT TODAY'S CALLER DOES WITH IT, said plainly rather than assumed:
 * `steps/derive.mjs` treats every non-zero status as `the submission was
 * refused`, so a 4 reaches the worker as an item carrying this tool's own
 * stderr — which is the outcome that matters, the facts having already landed
 * — under a headline that is wrong about the file. Telling those two apart is
 * a change in `derive.mjs`, which this file does not edit.
 */
export const PARTIAL_EXIT = 4;

/**
 * A `{ "notes": [ … ] }` file from `charpilot-answers/`, materialised.
 *
 * Returns `{ landed, partial, faults }`.
 *
 *   landed    one row per note that published, including the partial ones —
 *             they are on disk and the next round will serve them.
 *   partial   the subset of `landed` that published SOME of its facts, each
 *             carrying `refused` and the `rejected` rows. A caller that reads
 *             only `faults` would call these clean, so they are a list of
 *             their own rather than a flag on a row nobody reads.
 *   faults    one row per note that published NOTHING, each naming the source
 *             file, the row and every fact that failed — the shape a
 *             `submission` item is built from, so a refusal comes back to the
 *             worker in this tool's own words rather than in a summary of them.
 *
 * THE GRANULARITY IS THE SAME AT BOTH LEVELS NOW, and it used to be two
 * different rules. One row's failure has never stopped the others — two source
 * files are two independent readings, and `derive`'s quarantine makes exactly
 * this trade with proposal rows. Inside one note the opposite rule applied and
 * cost run `20260919T092410Z` three rounds of a dead cache. A fact that does
 * not verify is refused; the facts beside it are not.
 */
export function materialiseNoteSubmission(doc, { root = REPO_ROOT, dir = NOTES_DIR, by = null, round = null } = {}) {
  const rows = doc?.[NOTES_SUBMISSION_KEY];
  if (!Array.isArray(rows)) {
    const faults = [
      { row: -1, why: `this submission has no \`${NOTES_SUBMISSION_KEY}\` list. A note file is { "${NOTES_SUBMISSION_KEY}": [ { "source": "…", "entries": [ … ] } ] }.` },
    ];
    // D75. RECEIPTED LIKE ANY OTHER OUTCOME. This IS the last word about this
    // document; a fault left un-receipted is a submission `steps/derive.mjs`
    // re-raises every round for ever, which is the loop this exists to end.
    recordNoteSubmission(doc, { dir, faults });
    return { landed: [], partial: [], faults };
  }
  const landed = [];
  const partial = [];
  const faults = [];
  rows.forEach((row, index) => {
    const path = row?.source ?? row?.path;
    if (!path) {
      faults.push({ row: index, why: "this note names no `source`, so there is no file to check its facts against." });
      return;
    }
    // `by` and `round` are DEFAULTS here, never assertions. The worker wrote
    // these facts in the round it was briefed for, and the round that
    // materialises them may be the next one; refusing on that difference would
    // refuse every note ever submitted.
    const entries = (row?.entries ?? []).map((e) => ({
      ...e,
      written_by: e?.written_by ?? row?.written_by ?? by ?? undefined,
      round: Number.isInteger(e?.round) ? e.round : Number.isInteger(row?.round) ? row.round : round ?? undefined,
    }));
    const r = publishNote({ path, entries, by: null, round: null, root, dir, read: row?.read === "ranged" ? "ranged" : "full" });
    if (!r.written) {
      faults.push({ row: index, path, why: r.why, rejected: r.rejected ?? [] });
      return;
    }
    const row_ = {
      row: index,
      path: r.path,
      key: r.key,
      added: r.added,
      entries: r.note.entries.length,
      ...(r.partial ? { partial: true, refused: r.refused, why: r.why, rejected: r.rejected } : {}),
    };
    landed.push(row_);
    if (r.partial) partial.push(row_);
  });
  // D75. THE RECEIPT. This document has now been through this tool and the
  // outcome above is everything this tool has to say about it — clean, partial
  // or refused. `steps/derive.mjs` reads the receipt so the submission stops
  // being read as outstanding work and its refusal stops being re-raised
  // unchanged. See the block above `submittedDirFor`.
  recordNoteSubmission(doc, { dir, landed, partial, faults });
  return { landed, partial, faults };
}

/* ------------------------------------------------------------------------ *
 * THE OBLIGATION — how many files this round owes a note, counted once.
 *
 * WHY THIS EXISTS AT ALL, and it is the whole of plan 16 item 4's second half.
 * Nothing in the handover ASKED for a note. The packet said a note was
 * possible; the round's expectations — sides answered, rows submitted, the
 * checkpoint, the limits — never mentioned one. So a note was an unrequested
 * extra competing with nineteen sides for a worker's attention, and both live
 * runs closed with `noteCacheNotesWritten=0` in every round of both. The agent
 * on run 20260919T092410Z understood the obligation and still did not act on
 * it, in its own words: "No noteCache present, so I should do a full read of
 * the source files and submit notes after checking." It did the read. It did
 * not submit.
 *
 * COUNTED OVER THE ROUND'S READING PLANS AND DEDUPED BY PATH, because that is
 * what the round owes. Two packets that read `agent.ts` owe ONE note between
 * them, not two — the second worker's note would be a second reading of a file
 * whose first reading is the thing being kept. Counting per packet would state
 * an obligation bigger than the one the round can discharge, and an expectation
 * that cannot be met is one nobody meets.
 *
 * `record: false`, for the reason `clusterPackets` gives at its own call site:
 * asking whether a note exists in order to COUNT it is not a worker hitting it,
 * and counting it as a hit would inflate the one rate plan 14 is judged on.
 * ------------------------------------------------------------------------ */

/**
 * `{ files, noted, owed, owes }` for a round's packets.
 *
 * `packets` is `packetsFor`'s `Map<sideId, packet>` — the same object shared by
 * a packet's sides — or any iterable of packets, which is the shape
 * `clusterPackets` already takes so a caller passes the same value to both.
 *
 * `owes` is the paths, in the order the round reads them, so a `did` sentence
 * can name the first few rather than assert a number nobody can check. A file
 * the checkout does not have is not counted as owing: there is nothing to read
 * and so nothing to write down, and `readNote` says so itself.
 */
export function noteObligation(packets, { dir = NOTES_DIR, root = REPO_ROOT } = {}) {
  const list = packets instanceof Map ? packets.values() : (packets ?? []);
  const seenPacket = new Set();
  const seenFile = new Set();
  const owes = [];
  let noted = 0;
  let missingFromCheckout = 0;
  let readings = 0;
  for (const packet of list) {
    if (!packet || seenPacket.has(packet)) continue;
    seenPacket.add(packet);
    const inThisPacket = new Set();
    for (const step of packet.read ?? []) {
      if (!step?.file) continue;
      const rel = normalizePath(step.file, root);
      // ONE PACKET NAMING A FILE TWICE IS ONE READING. `readings` counts
      // (packet, file) pairs so that `sameRoundRereads` below is the number of
      // readings this round pays for twice, and a reading plan that lists a
      // file under two clusters is not two payments.
      if (!inThisPacket.has(rel)) {
        inThisPacket.add(rel);
        readings += 1;
      }
      if (seenFile.has(rel)) continue;
      seenFile.add(rel);
      let found;
      try {
        found = readNote(step.file, { root, dir, record: false });
      } catch {
        // A NOTE STORE THAT CANNOT BE READ IS "NO NOTE", the same safe answer
        // `clusterPackets` takes: the round asks for a note it may already
        // have, which costs one submission, rather than asking for none and
        // losing the reading, which is what both live runs did.
        found = { hit: false };
      }
      if (found.missing) missingFromCheckout += 1;
      else if (found.hit) noted += 1;
      else owes.push(rel);
    }
  }
  return {
    files: seenFile.size - missingFromCheckout,
    noted,
    owed: owes.length,
    owes,
    missingFromCheckout,
    readings,
    // THE NUMBER THIS CACHE CAN NEVER BUY, COUNTED RATHER THAN ARGUED.
    //
    // A note submitted in round N is materialised at the START of round N+1,
    // so two packets in the SAME round that both read one file both pay for
    // it — the file docblock says so and nothing measured it. This is that
    // measurement: readings minus distinct files, which is the count of
    // full reads in this round that no round-boundary cache can serve, no
    // matter how well the notes are written.
    //
    // It is the number that decides what the cache can be judged on. Run
    // 20260920T042523Z (tracy) reported 131 full-read misses over 34 distinct
    // files IN ONE ROUND: 97 of those 131, 74%, are this. Run
    // 20260920T030124Z (location-ms) reported 29 misses over 10 files in its
    // round 1 and then 2 more misses in every round after, so nearly all of
    // its reading was in a round the cache could not yet serve either.
    //
    // A round-boundary cache is therefore bounded above at roughly a quarter
    // of the re-reads on a tracy-shaped round, and that bound is a property of
    // WHEN a note is served, not of how good it is. Closing it means serving a
    // note inside the round that wrote it, which is an exception to the rule
    // that the answering turn runs nothing — the rule at the top of this file,
    // paid for twice. Nothing here proposes carving it; this counts what it
    // costs so the trade can be argued over a number.
    sameRoundRereads: Math.max(0, readings - seenFile.size),
  };
}

/* ------------------------------------------------------------------------ *
 * WHAT THE HANDOVER SAYS ABOUT ALL THIS.
 * ------------------------------------------------------------------------ */

/**
 * The submission shape, as short as it can be and still be valid JSON.
 *
 * WHY THE SHAPE AND NOT A POINTER TO IT. This is the whole of plan 16 item 4's
 * first half. The ~3 KB protocol block that used to ride on an all-miss packet
 * was removed to stay under the 25,000-byte median brief budget
 * `handover.one-packet-one-file` holds, and removing it took the submission
 * shape out of the one place a worker sees it AT THE MOMENT IT INCURS THE MISS.
 * The full protocol belongs in the stage-3 skill and is there; what has to be
 * in front of the worker at the miss is the thing it would otherwise go
 * looking for, which is what a note looks like.
 *
 * IT IS REAL JSON AND NOT A SKETCH. `{notes:[{source,entries:[…]}]}` is 40
 * bytes shorter and is not parseable, so a worker that copies it writes a file
 * `materialiseNoteSubmission` refuses — and a refusal costs a `submission` item
 * next round, which is more than 40 bytes.
 *
 * `written_by` AND `round` ARE IN THE SHAPE, AND LEAVING THEM OUT WAS A
 * DEFECT — the single largest cause of refused facts in run
 * `20260919T092410Z`. This constant used to omit both, on the stated grounds
 * that "both are filled from what the tool already knows". The tool does not
 * know either one on the route that actually runs. `notesArgv` passes
 * `--submission` and `--round`, never `--by`, so `written_by` has no value to
 * fall back to at all; and `steps/derive.mjs:1539` reads `metrics.round` out of
 * an object its own submission step never sets, so `--round` is never passed
 * either. The worker was therefore handed a shape that `verifyEntries` is
 * guaranteed to refuse, on two fields, and the log says exactly that — 15
 * facts refused for `has no whole-number round` and 4 for `has no written_by`,
 * against 0 facts that failed the byte check. 33 bytes in this string buy all
 * 19 back — paid for out of `"<the file>"`, which is now `"<path>"`, because
 * the notice has a measured 400-byte ceiling and the two fields put it at 402.
 * The round `derive` never sets is a defect in `derive.mjs` and is
 * reported, not worked around here: a tool that invents a round number is
 * writing provenance nobody can check.
 */
export const NOTE_SUBMISSION_SHAPE =
  '{"notes":[{"source":"<path>","entries":[{"fact":"…","lines":[a,b],"kind":"observed","confidence":"verified","written_by":"<you>","round":<n>}]}]}';

/**
 * The all-miss notice — the obligation, and the shape, in three lines.
 *
 * MEASURED, because the budget is the reason the long version is gone: this
 * string costs 363 bytes in a packet header at the indentation the walk writes
 * (`JSON.stringify(…, null, 2)`, two levels deep), against the ~3 KB block it
 * replaces. The prose is the shortest that says all three things a worker needs
 * — how many files owe, that checking comes before writing, and where the file
 * goes — and every further word was cut against that list rather than for
 * style.
 *
 * IT IS 47 BYTES LONGER THAN THAT NOW, and both purchases were made against a
 * measured refusal. 33 of them are `NOTE_SUBMISSION_SHAPE` gaining
 * `written_by` and `round` — the two fields whose absence refused 19 of this
 * notice's own facts in run `20260919T092410Z`, which is the most expensive 33
 * bytes anybody has saved here, and which run `20260920T030124Z` then refused
 * ZERO facts for.
 *
 * THE OTHER 14 ARE THE 300-CHARACTER CAP, which took their place as the
 * largest cause of a refused fact the moment those two were fixed. In run
 * `20260920T030124Z` the cap refused 45 distinct facts across rounds 2-4 — five
 * times every other reason put together, against 9 for the byte check
 * and 0 for `written_by` and `round` — and the number was in this file, in the
 * stage-3 skill's prose, and in no sentence a worker reads at the moment it
 * writes the fact. The skill's own list of "the things that refuse one" did
 * not name it. The cost of saying it here is measured the same way as the
 * rest: the notice goes 397 → 410 bytes and the production median brief
 * 24,930 → 24,943 B, printed by `handover.one-packet-one-file` on every run.
 * Paid for out of "beside your answers", which said nothing the sentence
 * before it had not.
 *
 * IT IS NOW WIRED, and this docblock said otherwise for longer than it was
 * true. `steps/derive.mjs` counts the round's obligation once with
 * `noteObligation` and passes `owed` into `packetHeader`, which passes it to
 * `noteCacheFurniture`, so an all-miss packet in a round that owes something
 * carries this string. MEASURED at 410 bytes in a packet header at the walk's
 * indentation, by `handover.one-packet-one-file`, which prints it on every run
 * as the difference between the brief that suite builds and the brief a real
 * run sends. The old claim — "no packet has ever carried it" — rested on
 * `steps/derive.mjs:3433`, a line number that has not been that call for some
 * time.
 *
 * WHAT IS STILL TRUE is the neighbouring half: `metrics.round` is never set by
 * the submission step that should set it, so `notesArgv` passes no `--round`.
 * That is a defect in `derive.mjs` and is reported, not worked around here — a
 * tool that invents a round number is writing provenance nobody can check.
 */
export const noteOwedNotice = (here, owed) =>
  `${here} of the files above have no note and owe one; ${owed} in this round. After reading, check every fact ` +
  `against the lines it cites and keep it under ${MAX_FACT_CHARS} characters, then write ${NOTE_SUBMISSION_SHAPE} ` +
  `into charpilot-answers/. Rules: stage-3 skill.`;

/**
 * The sentence every packet carries about the note cache, and which of the
 * files in its reading plan already have a note.
 *
 * Built as furniture rather than as an item field, for `packetFurniture`'s own
 * reason: it is the same on every item of every round, so it is written once at
 * the top of the packet's own file. The per-file `note` flags are the part that
 * differs, and they are an ANSWER rather than an address — the worker does not
 * have to probe to find out whether a note exists.
 *
 * `owed` is the ROUND's obligation from `noteObligation`, passed in because a
 * packet cannot compute it: it sees its own reading plan and not the round's.
 * See the all-miss branch at the bottom for what it turns on and what leaving
 * it off costs.
 */
export function noteCacheFurniture(readingPlan = [], { dir = NOTES_DIR, root = REPO_ROOT, by = null, round = null, record = true, owed = null } = {}) {
  const files = [];
  for (const step of readingPlan ?? []) {
    if (!step?.file) continue;
    // RECORDED HERE, BECAUSE THIS IS WHERE THE SERVING HAPPENS. The worker does
    // not ask for a note, it is handed one, so the hit and the miss are events
    // of this call and there is nowhere else they could be counted from. The
    // write is an append to this tool's own event log under `out/notes/`; it
    // touches no pipeline artifact, which is the line `derive.quarantine`'s
    // "a step that writes can repair a tool's output" is actually drawing.
    const found = readNote(step.file, { root, dir, by, round, record });
    files.push({
      file: step.file,
      // THE NOTE ITSELF, INLINE. A path to a note is one more file to open and
      // one more chance to open the wrong one, and it is the per-item lookup
      // `packetHeader` spent a round removing from the handover. The size
      // ceiling — 4 KB or a third of the source — is what makes this safe to
      // inline, and now it is also what the ceiling is FOR: a note's size is
      // brief size.
      note: found.hit ? { source_sha: found.note.source_sha, source_lines: found.note.source_lines, entries: found.note.entries } : null,
      bytes: found.hit ? { note: found.servedBytes, file: found.sourceBytes } : { note: 0, file: found.sourceBytes ?? 0 },
      why: found.hit
        ? "a worker has already read this file and written down what it found, checked against the bytes. The facts are above; you do not open anything to get them."
        : "no note at this file's current bytes. Reading it in full is the cost, and it owes a note back — see `submit` below.",
    });
  }
  // THE STANDING INSTRUCTIONS ARE NOT REPEATED IN EVERY PACKET.
  //
  // The protocol, the submission shape and the authority rule are the same
  // sentences for every packet in the round, and a round is 33 packets: at ~3
  // KB each that is ~100 KB of identical prose, and it pushed the MEDIAN brief
  // from under 25,000 bytes to 27,954 -- through the budget
  // `handover.one-packet-one-file` holds, which exists because a brief nobody
  // can read is the defect this whole handover was built to remove.
  //
  // They live in the stage-3 skill, which the worker already has. A packet
  // carries them only when it is SERVING something -- where the worker needs
  // the rule about what a note may be used for beside the facts themselves --
  // and an all-miss packet carries one line saying so.
  // AND AN ALL-MISS PACKET CARRIES THE OBLIGATION AND THE SHAPE, AND NOTHING ELSE.
  //
  // WHAT THIS BRANCH USED TO DO AND WHY IT WAS WRONG. It returned `{}`. The
  // block before that returned ~600 bytes restating that there were no notes,
  // over the files the reading plan lists two lines above it, and the median
  // brief came out at 25,636 bytes against a 25,000 budget. Deleting it fixed
  // the budget and broke the feature: it removed the submission shape from the
  // one place a worker sees it at the moment it incurs the miss, and BOTH live
  // runs then closed with `noteCacheNotesWritten=0` in every round
  // (20260919T092106Z on location-ms, 20260919T092410Z on tracy-worker, whose
  // first round spent 3,008 seconds and 647 child turns and returned nothing
  // at all). The agent's own log says it knew and did not act:
  //
  //     "No noteCache present, so I should do a full read of the source files
  //      and submit notes after checking."
  //
  // So the notice is back, at 410 bytes instead of ~3,000, and it is an
  // EXPECTATION rather than a restatement — it says how many files owe a note,
  // which is a number the worker can discharge, and it carries the shape that
  // discharges it. The protocol, the authority rule and the worked example
  // stay in the stage-3 skill, which the worker already has.
  //
  // WHY IT IS CONDITIONAL ON `owed`, AND WHAT THE UNCONDITIONAL VERSION COSTS.
  // Two reasons, and the second is a measurement.
  //
  //   1. The number is the ROUND's, not the packet's. A packet that invented
  //      its own would state a different obligation on every file of the
  //      round, which is nineteen different expectations and therefore none.
  //      Only the caller that holds all the packets can count it, so only the
  //      caller can turn this on.
  //   2. THE BUDGET, AND IT IS NOT A NUMBER THIS COMMENT SHOULD BE CARRYING.
  //      This paragraph has held three different headroom figures — 80 bytes,
  //      then TEN, then 70 — and every one of them was measured, correctly, on
  //      a tree and a fixture that had both since moved. Three files ended up
  //      quoting three different ones at the same time. A number that moves
  //      whenever anybody edits a packet header does not belong in prose.
  //
  //      `handover.one-packet-one-file` now PRINTS the median and the headroom
  //      on every run, in the shape a real run sends and in the lighter shape
  //      the suite builds, and asserts the first. Read it there; it is right
  //      by construction and this sentence is not. On 2026-09-20 it printed
  //      24,533 B for the suite's shape and 24,943 B for production — the
  //      410-byte difference IS this notice — against a 25,000 B budget.
  //
  //      SO THE NOTICE FITS, and the conclusion this paragraph used to draw
  //      from its own arithmetic ("emitting it takes the median to 25,353,
  //      which is over, so the caller cannot wire it on") no longer follows.
  //      It is wired: `steps/derive.mjs` counts the round's obligation once
  //      with `noteObligation` and passes `owed` down through `packetHeader`,
  //      and the `Number.isInteger(owed)` gate below is what keeps a round
  //      that owes nothing from saying so. What is left of the warning is the
  //      margin: seventy bytes is the whole of it, the next header field
  //      spends it, and `packetFurniture`'s `parallelism` block is still
  //      2,450 bytes per packet telling one worker how to DEAL WORKERS — the
  //      orchestrator's job, and the obvious place to find room.
  if (!files.some((f) => f.note)) {
    if (!files.length || !Number.isInteger(owed)) return {};
    return { noteOwed: noteOwedNotice(files.length, owed) };
  }
  return {
    noteCache: {
      dir: relative(root, dir) || dir,
      files,
      protocol: [
        "HIT: the facts are already here. One that is `observed`+`verified` and answers your question, you use.",
        "A fact that is `inferred` or `needs-check` costs you a RANGED read of the lines it names BEFORE you use it — read those lines with your own reader, then promote it by recording an observation of your own, or correct it.",
        "A note that does not answer your question costs you a ranged read of the lines it names, not a full read of the file.",
        `MISS: read the file in full, extract facts each with its line evidence and each under ${MAX_FACT_CHARS} characters, CHECK every one against the bytes you just read, submit the note, and only THEN derive.`,
      ],
      submit: {
        where: "charpilot-answers/",
        shape: { notes: [{ source: "src/agent/agent.ts", entries: [{ fact: "…", lines: [66, 111], kind: "observed", confidence: "verified", written_by: "…", round: 0 }] }] },
        says:
          "You do not run anything and you do not write under `.claude/`. Write this file into `charpilot-answers/` " +
          "like a proposal or a declaration, and the next round materialises it by running the tool that owns the " +
          "format. That tool checks every fact against the bytes it cites before a byte is written. A fact that does " +
          "not check is refused BY ITSELF and comes back to you as a `submission` item naming it and every reason; " +
          "the facts beside it are published and serve from the next round. A note none of whose facts check is " +
          "refused whole, which is a different message and a different thing to fix.",
      },
      says:
        "NOTES ARE A NAVIGATION CACHE, NOT AN AUTHORITY LAYER. A note says where to look and how to set the subject " +
        "up; it never says what the code does. Your proposal cites the SOURCE FILE and the LINE — never a note — " +
        "because validate.mjs requires `covers` armIds byte-exact and `from.evidence` pointing at a path that " +
        "exists, and a note hit cannot by itself satisfy either. A note is keyed to the sha256 of the file's bytes, " +
        "so it invalidates itself the moment the file changes and can never be served stale; that bounds STALENESS " +
        "and not CORRECTNESS. If a note and the source disagree, the source is right and the note is the thing to " +
        "fix — submit a correction naming what you OBSERVED, over the same lines. The entry it supersedes stays with " +
        "its provenance rather than being deleted: a shared note can amplify a mistake as easily as a fact, and the " +
        "record of a correction having happened is the only evidence it ever misled anybody.",
    },
  };
}

/**
 * Fold the note cache's numbers into a step's `metrics` and `did`.
 *
 * ONE CALL, because the step that would make it is `steps/derive.mjs` and this
 * file does not edit it. `metrics` is flat and `did` is a list of sentences a
 * person reads, which is the shape derive already keeps them in.
 *
 * `obligation` is `noteObligation`'s row, and it is reported BEFORE the early
 * return below rather than after it. That ordering is the point: a round that
 * served no note and wrote no note is exactly the round whose obligation is
 * the only thing worth saying, and under the old ordering it said nothing at
 * all. Both live runs reported an empty note cache as silence, which is how
 * `noteCacheNotesWritten=0` survived two runs without anybody noticing it was
 * a defect rather than a cold start.
 */
export function reportNoteCache(metrics, did, { dir = NOTES_DIR, obligation = null } = {}) {
  const c = counters({ dir });
  if (obligation && Number.isInteger(obligation.owed)) {
    metrics.noteCacheOwed = obligation.owed;
    metrics.noteCacheFilesRead = obligation.files;
    metrics.noteCacheAlreadyNoted = obligation.noted;
    if (Number.isInteger(obligation.readings)) {
      metrics.noteCacheReadings = obligation.readings;
      metrics.noteCacheSameRoundRereads = obligation.sameRoundRereads;
    }
    did?.push?.(
      `this round's reading plans name ${obligation.files} distinct file(s): ${obligation.noted} already have a note ` +
        `at their current bytes and ${obligation.owed} owe one. That is an EXPECTATION of the round and not an ` +
        `extra — every all-miss packet says the number and carries the submission shape, because a note that nothing ` +
        `asks for is what runs 20260919T092106Z and 20260919T092410Z produced none of: ` +
        `noteCacheNotesWritten=0 in every round of both, with one agent writing "No noteCache present, so I should ` +
        `do a full read of the source files and submit notes after checking" and then submitting none. The count is ` +
        `deduped by path, so two packets reading one file owe ONE note between them` +
        (obligation.owes?.length ? `. First: ${obligation.owes.slice(0, 3).join(", ")}` : "")
    );
    if (obligation.sameRoundRereads) {
      did?.push?.(
        `note cache, what it cannot buy: this round's packets make ${obligation.readings} reading(s) over ` +
          `${obligation.readings - obligation.sameRoundRereads} distinct file(s), so ${obligation.sameRoundRereads} ` +
          `of the round's full reads are a second packet ` +
          `reading a file a sibling has already read. A note is materialised at the round boundary and serves the ` +
          `NEXT round, so no note written here can serve any of those — it is a bound on what this cache can ` +
          `return, and it is a property of when a note is served rather than of how good it is. Run ` +
          `20260920T042523Z reported 131 full-read misses over 34 distinct files in one round: 97 of them, 74%, ` +
          `were this. Judge the cache on the re-reads it CAN reach, which is the rest`
      );
    }
  }
  // `entriesRejected` IS IN THIS GUARD, and leaving it out was the same defect
  // one line up: a round that served nothing, wrote nothing and REFUSED nine
  // facts is the round whose numbers are worth saying, and under the old test
  // it said nothing unless something else had happened too.
  if (!c.noteHits && !c.fullReadMisses && !c.rangedReads && !c.notesWritten && !c.entriesRejected) return c;
  metrics.noteCacheHits = c.noteHits;
  metrics.noteCacheFullReadMisses = c.fullReadMisses;
  metrics.noteCacheRangedReads = c.rangedReads;
  metrics.noteCacheHitRate = c.noteHitRate;
  metrics.noteCacheBytesSaved = c.bytesSaved;
  metrics.noteCacheTokensSaved = c.tokensSaved;
  metrics.noteCacheNotesWritten = c.notesWritten;
  metrics.noteCacheNotesPartial = c.notesPartial;
  metrics.noteCacheFactsRefused = c.entriesRejected;
  metrics.noteCachePromotions = c.promotions;
  metrics.noteCacheCorrections = c.corrections;
  // THE SECOND WAY A CHECKED FACT LEAVES, AND IT WAS THE SILENT ONE.
  // `entriesRejected` above is the fact that did not verify; this is the fact
  // that DID and was squeezed out by the ceiling anyway. The counter has
  // existed since this file did and no `metrics` key ever carried it, which is
  // how run 20260920T030124Z published 75 verified facts, kept 8, and reported
  // a number for neither.
  metrics.noteCacheCompactions = c.compactions;
  metrics.noteCacheFactsCompactedOut = c.entriesCompacted;
  metrics.noteCacheDuplicateFullReadsAfterHit = c.duplicateFullReadsAfterHit;
  did?.push?.(
    `note cache: ${c.noteHits} hit(s) and ${c.fullReadMisses} full-read miss(es) (${(c.noteHitRate * 100).toFixed(1)}% ` +
      `hit rate), ${c.rangedReads} ranged read(s), ${c.notesWritten} note write(s) carrying ${c.entriesWritten} ` +
      `fact(s), ${c.promotions} promotion(s) from needs-check and ${c.corrections} correction(s). ` +
      `${c.notesPartial} of those write(s) landed INCOMPLETE and ${c.entriesRejected} fact(s) were refused for not ` +
      `verifying against the bytes they cite: those facts are named back to their worker and are not in any note, ` +
      `and the facts beside them landed rather than being thrown away with them — run 20260919T092410Z refused ` +
      `8, 9 and 7 facts a round and wrote nothing at all for three rounds because of the rule that has changed. ` +
      `A further ${c.entriesCompacted} fact(s) VERIFIED and were then compacted out over ${c.compactions} ` +
      `compaction(s): they checked against the bytes and the ceiling had no room for them, which is a different ` +
      `loss and had no number at all until now — run 20260920T030124Z published 75 checked facts into four notes ` +
      `and kept 8, at a ceiling that was a tenth of the source and is now a third. ` +
      `Saved ` +
      `${c.bytesSaved} bytes, about ${c.tokensSaved} tokens at four bytes to the token — a crude constant that does ` +
      `NOT account for prompt caching, which is the difference between plan 14's $39 and its $4. ` +
      `${c.duplicateFullReadsAfterHit} full read(s) happened AFTER a hit on the same file by the same worker, and ` +
      `that is the number that says whether this is working or merely running: a worker that reads the note and ` +
      `then reads the file anyway is saying the note does not carry what the work needs. It counts only what went ` +
      `through the tool, so it is a floor. Baseline, run 20260918T164503Z: 1,537 reads over 214 paths, 86% of calls ` +
      `and 91% of bytes re-reads — from plan 13's D45 table, not a log on disk; that run's directory is gone`
  );
  return c;
}

/* ------------------------------------------------------------------------ *
 * THE COMMAND LINE.
 * ------------------------------------------------------------------------ */

const ARGV = process.argv.slice(2);
const MODES = ["--submission", "--get", "--put", "--ranged", "--full-read", "--counters"];
const VALUE_FLAGS = ["--submission", "--get", "--put", "--ranged", "--full-read", "--by", "--round", "--entries", "--from", "--to", "--read", "--dir"];
const BARE_FLAGS = ["--counters", "--json"];

/**
 * `indexOf` returns -1 when the flag is absent, so `ARGV[-1 + 1]` reads the
 * FIRST argument, whatever it is. That bug has shipped in this toolset twice
 * (worklist.mjs's `--file`, and blocked.mjs guards against it for the same
 * reason), so the read is guarded here too.
 */
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};

function refuse(message) {
  process.stderr.write(`notes: ${message}\n`);
  process.exit(2);
}

/** An unrecognised flag is REFUSED, not ignored, for blocked.mjs's reason. */
function checkFlags() {
  for (let i = 0; i < ARGV.length; i += 1) {
    const token = ARGV[i];
    if (VALUE_FLAGS.includes(token)) {
      const value = ARGV[i + 1];
      if (value === undefined || VALUE_FLAGS.includes(value) || BARE_FLAGS.includes(value)) {
        refuse(`${token} needs a value. Give it one, or leave the flag off — an empty field is not a field.`);
      }
      i += 1;
      continue;
    }
    if (BARE_FLAGS.includes(token)) continue;
    refuse(
      `${JSON.stringify(token)} is not an argument this tool takes. The modes are ${MODES.join(" ")} and the ` +
        `options are --by --round --entries --from --to --read --dir --json.`
    );
  }
}

function main() {
  checkFlags();
  const chosen = MODES.filter((m) => ARGV.includes(m));
  if (chosen.length !== 1) {
    refuse(
      chosen.length
        ? `${chosen.join(" and ")} were both given, and this tool does one thing per call.`
        : `no mode given. One of ${MODES.join(" ")}.`
    );
  }
  const mode = chosen[0];
  const JSON_OUT = ARGV.includes("--json");
  const dir = arg("--dir") ? resolve(arg("--dir")) : NOTES_DIR;
  const by = arg("--by", null);
  const roundRaw = arg("--round", null);
  const round = roundRaw === null ? null : Number.parseInt(roundRaw, 10);
  if (roundRaw !== null && !Number.isInteger(round)) refuse(`--round ${JSON.stringify(roundRaw)} is not a whole number.`);

  if (mode === "--counters") {
    const c = counters({ dir });
    process.stdout.write(JSON_OUT ? `${JSON.stringify(c, null, 2)}\n` : `${Object.entries(c).map(([k, v]) => `    ${k.padEnd(28)} ${v}`).join("\n")}\n`);
    return;
  }

  if (mode === "--submission") {
    const at = resolve(arg("--submission"));
    let doc;
    try {
      doc = JSON.parse(readFileSync(at, "utf8"));
    } catch (err) {
      refuse(`${at} could not be read as JSON: ${err.message}`);
    }
    const r = materialiseNoteSubmission(doc, { dir, by, round });
    const status = r.faults.length ? 2 : r.partial.length ? PARTIAL_EXIT : 0;
    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return process.exit(status);
    }
    for (const l of r.landed) {
      process.stdout.write(
        l.partial
          ? `\n~ note — ${l.path} (+${l.added} of ${l.added + l.refused}, ${l.entries} in the note now; ${l.refused} fact(s) REFUSED and not in it)\n`
          : `\n✓ note — ${l.path} (+${l.added}, ${l.entries} in the note now)\n`
      );
    }
    if (!status) return;
    // A NON-ZERO EXIT WITH THE LANDED ROWS ALREADY PRINTED. The round reads
    // both: the notes that were checked and written are written, and the facts
    // that were not come back to the worker naming each one — whether the rest
    // of that note landed or not.
    const say = (row, head) =>
      `notes: ${NOTES_SUBMISSION_KEY}[${row.row}]${row.path ? ` ${row.path}` : ""} — ${head}\n` +
      (row.rejected ?? []).map((x) => `    entry[${x.index}] ${x.why}\n`).join("");
    process.stderr.write(
      [
        ...r.faults.map((f) => say(f, f.why)),
        ...r.partial.map((l) => say(l, l.why)),
      ].join("")
    );
    return process.exit(status);
  }

  const path = arg(mode);

  if (mode === "--get") {
    const r = readNote(path, { dir, by, round });
    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return process.exit(r.hit ? 0 : 3);
    }
    if (!r.hit) {
      process.stdout.write(
        `\n· MISS — ${r.path}\n    ${r.why}\n` +
          `    Then: node .claude/charpilot/notes.mjs --put ${r.path} --by <you> --round <n> --entries <file.json>\n`
      );
      return process.exit(3);
    }
    process.stdout.write(
      `\n✓ HIT — ${r.path} (${r.note.entries.length} fact(s), ${r.servedBytes} bytes against ${r.sourceBytes} in the file)\n` +
        `${JSON.stringify(r.note, null, 2)}\n`
    );
    return;
  }

  if (mode === "--ranged") {
    const r = rangedRead(path, { from: arg("--from"), to: arg("--to"), dir, by, round });
    if (!r.ok) refuse(r.why);
    process.stdout.write(JSON_OUT ? `${JSON.stringify(r, null, 2)}\n` : `\n· ${r.path}:${r.from}-${r.to}\n${r.text}\n`);
    return;
  }

  if (mode === "--full-read") {
    const r = recordFullRead(path, { dir, by, round });
    if (!r.ok) refuse(r.why);
    process.stdout.write(`\n· recorded a full read of ${r.path} (${r.sourceBytes} bytes)\n`);
    return;
  }

  // --put
  const source = arg("--entries");
  if (!source) refuse("--put needs --entries <file.json> (or `-` for stdin): the facts you verified against the bytes you read.");
  let payload;
  try {
    payload = JSON.parse(source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8"));
  } catch (err) {
    refuse(`--entries ${source} could not be read as JSON: ${err.message}`);
  }
  const entries = Array.isArray(payload) ? payload : payload?.entries;
  const readKind = arg("--read", "full");
  if (!["full", "ranged"].includes(readKind)) {
    refuse(
      `--read ${JSON.stringify(readKind)} is not \`full\` or \`ranged\`. It says which read produced these facts, and ` +
        `it is the difference between the expected fallback after a hit and the duplicate full read that says this ` +
        `cache is not carrying what the work needs.`
    );
  }
  const r = publishNote({ path, entries, by, round, dir, read: readKind });
  if (!r.written) {
    if (JSON_OUT) {
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return process.exit(2);
    }
    refuse(
      `${r.why}. Nothing was written.\n` +
        r.rejected.map((x) => `    entry[${x.index}] ${x.why}`).join("\n") +
        `\n  A note is written after its claims have been checked against the source they cite, or it is not written: ` +
        `a cache turns one model's mistake into shared infrastructure, and six workers then inherit it.`
    );
  }
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ...r, note: undefined }, null, 2)}\n`);
    if (r.partial) process.exit(PARTIAL_EXIT);
    return;
  }
  process.stdout.write(
    `\n${r.partial ? "~" : "✓"} note — ${r.path}@${r.sha.slice(0, 12)}…\n` +
      `    ${r.added} fact(s) added, ${r.note.entries.length} in the note now (ceiling ${r.note.ceiling_bytes} bytes)\n` +
      (r.promotions ? `    ${r.promotions} needs-check fact(s) promoted by an observation of your own\n` : "") +
      (r.corrections ? `    ${r.corrections} correction(s): a verified observation already there says something else, and both stay\n` : "") +
      (r.compacted ? `    ${r.compacted} entr(y/ies) compacted out — superseded first, verified observations last\n` : "") +
      (r.brokeStale ? `    a lock older than ${LOCK_STALE_MS}ms was broken to write this\n` : "")
  );
  if (!r.partial) return;
  // THE REFUSED FACTS GO TO STDERR EVEN THOUGH THE NOTE LANDED, and the exit
  // status is not 0. A partial write printed as a tick and exited clean is the
  // shape this change exists to remove, one level up.
  process.stderr.write(
    `notes: ${r.why}.\n` +
      r.rejected.map((x) => `    entry[${x.index}] ${x.why}\n`).join("") +
      `  The ${r.added} that verified are in the note and serve from the next round. Resubmit these ${r.refused} ` +
      `alone — a note is append-only, so the facts already in it are not resent and are not lost.\n`
  );
  return process.exit(PARTIAL_EXIT);
}

// Only when this file is the ENTRY POINT. 26 of the 40 tools here executed on
// import, so a tool that wanted to reuse another's helper triggered a full run
// of it instead. `import.meta.main` needs Node 24; on an older runtime it is
// undefined, and a bare truthiness test would turn this into a silent no-op — a
// tool that runs and writes nothing while reporting success is worse than one
// that crashes.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}
