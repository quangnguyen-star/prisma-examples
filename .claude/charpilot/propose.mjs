#!/usr/bin/env node
/**
 * One call to put one SUBMITTED proposal document into the proposals directory.
 *
 * WHY THIS FILE HAD TO EXIST AT ALL, measured on run `20260916T112101Z`: the
 * answering turn spent 34.6 minutes and $3.80 in its first round and wrote
 * nothing, because every attempt to write into `.claude/charpilot/proposals/`
 * — with `Write` and with `Bash` — was refused. `docker/settings.json` allows
 * `Write(.claude/**)`; the refusal is above it, because `.claude/` is the agent
 * harness's own directory. An agent that cannot write there cannot author a
 * proposal, and stage 3 produces nothing however long it runs.
 *
 * So the agent SUBMITS its document somewhere it can write, and this moves it.
 * That is the whole job:
 *
 *   node .claude/charpilot/propose.mjs --from <submitted.json> \
 *        [--name <file.json>] [--replace] [--json]
 *
 * And one call to take ONE claim back out of a row already there, when a run
 * has proved it false — see WITHDRAWAL below:
 *
 *   node .claude/charpilot/propose.mjs --withdraw <proposalId> \
 *        --claim "<armId> [<side>]" --evidence <artifact.json> \
 *        [--file <file.json>] [--json]
 *
 * WHY A TOOL AND NOT THE STEP THAT SPAWNS IT. `steps/derive.mjs` is the caller,
 * and a step never writes — `tests/steps.never-repair-a-tools-output.test.mjs`
 * enforces it, because a step that writes is a step that can quietly repair a
 * tool's output instead of refusing on it, and because `satisfied` would then
 * be reading back its own writing. Steps read and spawn; tools write. There was
 * no tool that wrote a proposal file, which is why writing one was the agent's
 * job and why the agent could not do it.
 *
 * WHAT IT DOES NOT DO, and this is the contract worth stating. It does not
 * judge the proposal: `validate.mjs` does that, it is 1,340 lines of it, and a
 * second opinion here would be a second thing to keep true. It does not fill a
 * slot, complete a field, rename a key or reformat a document — the bytes that
 * land are the bytes that were submitted, and `cmp` will say so. It refuses,
 * and it refuses on exactly four things a WRITER must not carry through:
 *
 *   - a file that is not a proposal document at all. Written through, it
 *     becomes validate.mjs's error three stages of confusion later.
 *   - the skeleton's unfilled-slot sentinel, still in place. That slot IS the
 *     derivation; a document carrying it says the agent did not make one, and
 *     the one thing a renderer must never do is fill it in.
 *   - a field stage 3 may not carry — `expected`, `returns`, `assert`. Stage 4
 *     records the output; a stage-3 document that predicts one is the failure
 *     this whole pipeline exists to refuse, and it is cheaper to refuse it at
 *     the door than to find it in a committed test.
 *   - a `setup[].apply` that is not an object. This is the FOURTH, and it is
 *     here for the same reason as the first: the document is malformed, and
 *     written through it becomes a quarantined row rather than a question.
 *     WHY IT EARNS A DOOR CHECK when `validate.mjs` already refuses it: the
 *     door refusal reaches the worker mid-turn and costs one bash call, while
 *     the same refusal reached in the derive step costs a ROUND — validation
 *     runs after the answering turn has ended, the row is quarantined, its
 *     sides go back to the brief and another worker is dealt them. Measured
 *     over the run logs on this machine, that is 18 rows across three runs,
 *     and run `20260919T171842Z` shows seven of them re-dealt.
 *     IT IS STILL A REFUSAL, NOT A REPAIR. A bare `"apply": "call"` names a
 *     directive and carries no payload; every one of those 18 rows also had
 *     no `state`. There is nothing to normalise into, so this file does what
 *     it always does — refuses, and prints the corrected row it cannot write.
 *     And the judgement is IMPORTED, not restated: `applyShapeFault` is
 *     validate.mjs's own, so the door and the checker cannot come to disagree.
 *
 * All four judgements are IMPORTED from validate.mjs rather than restated: a
 * writer with its own copy of the rules is a writer that can drift from the
 * checker, and a drifted writer produces an artifact that reads as checked and
 * is not.
 *
 * The write is a lock, a temp file and a rename, for the reason blocked.mjs
 * spells out at length: two writers appending at once lose one document
 * silently, and a half-written proposal file is a set of sides that look like
 * sides nobody ever derived.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { PROPOSALS_DIR, REPO_ROOT } from "./config.mjs";
// THE FORMAT LIVES IN THE CHECKER. validate.mjs is what fails when a proposal
// is wrong, so the two things this refuses on come from its own constants.
import { applyShapeFault, BANNED_FIELDS, SKELETON_TODO } from "./validate.mjs";

const ARGV = process.argv.slice(2);
const VALUE_FLAGS = ["--from", "--name", "--withdraw", "--claim", "--evidence", "--file", "--exclude"];
const BARE_FLAGS = ["--replace", "--json"];

/** `indexOf` returns -1 when the flag is absent, so `ARGV[-1 + 1]` would read the FIRST argument. */
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};

const rel = (p) => relative(REPO_ROOT, p) || p;

/** The lock this process holds, or null. Module scope so `refuse` can release it. */
let HELD = null;

function releaseLock() {
  if (!HELD) return;
  try {
    if (existsSync(HELD)) unlinkSync(HELD);
  } catch {}
  HELD = null;
}

/**
 * Every exit that is not a written document. stdout stays EMPTY: a reader that
 * greps stdout for the file it asked for must find nothing.
 */
function refuse(message) {
  releaseLock();
  process.stderr.write(`propose: ${message}\n`);
  process.exit(2);
}

/** An unrecognised flag is REFUSED, not ignored — the same rule blocked.mjs states. */
export function checkFlags(argv = ARGV, fail = refuse) {
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (VALUE_FLAGS.includes(token) || BARE_FLAGS.includes(token)) {
      if (seen.has(token)) {
        fail(`${token} is given more than once. Only the first would be read, so pass it once.`);
        return;
      }
      seen.add(token);
    }
    if (VALUE_FLAGS.includes(token)) {
      const value = argv[i + 1];
      if (value === undefined || VALUE_FLAGS.includes(value) || BARE_FLAGS.includes(value)) {
        fail(`${token} needs a value.`);
        return;
      }
      i += 1;
      continue;
    }
    if (BARE_FLAGS.includes(token)) continue;
    fail(
      `${JSON.stringify(token)} is not an argument this tool takes. It takes ` +
        `${VALUE_FLAGS.join(" ")} plus ${BARE_FLAGS.join(" ")}, and nothing else.`
    );
    return;
  }
}

/**
 * The file name a submitted document lands under.
 *
 * A BASENAME and never a path: the submission is written by the answering turn,
 * so `--name ../../src/index.ts` is the one input here that could reach outside
 * the proposals directory. Sanitised to the same character class record.mjs
 * uses for a path segment built out of an id, and forced to end `.json`,
 * because validate.mjs and ledger.mjs both read `readdirSync(...).filter(f =>
 * f.endsWith(".json"))` and a document under any other name is a document
 * nothing reads.
 */
export function targetName(name) {
  const bare = basename(String(name ?? "")).replace(/[^\w.-]+/g, "_");
  const stripped = bare.replace(/\.json$/i, "");
  if (!stripped || /^\.+$/.test(stripped)) return null;
  return `${stripped}.json`;
}

/** Every path in `doc` whose key or string value carries `needle`. */
export function findAll(node, needle, path = "") {
  const found = [];
  if (typeof node === "string") {
    if (node.includes(needle)) found.push(path || "(the document)");
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => found.push(...findAll(v, needle, `${path}[${i}]`)));
    return found;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.includes(needle)) found.push(`${path}.${k} (the key itself)`);
      found.push(...findAll(v, needle, path ? `${path}.${k}` : k));
    }
  }
  return found;
}

/** Every path in `doc` that is one of the fields stage 3 may not carry. */
export function bannedIn(node, path = "") {
  const found = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => found.push(...bannedIn(v, `${path}[${i}]`)));
    return found;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const here = path ? `${path}.${k}` : k;
      if (BANNED_FIELDS.includes(k)) found.push(here);
      found.push(...bannedIn(v, here));
    }
  }
  return found;
}

/**
 * Everything wrong with a submitted document, as sentences, or an empty list.
 *
 * Separated from `main` so the step that spawns this can be tested against the
 * same judgement without spawning anything, and so the four refusals are one
 * function rather than three places in a script.
 */
export function problemsWith(doc) {
  const problems = [];
  const rows = doc && typeof doc === "object" && !Array.isArray(doc) ? doc.proposals : Array.isArray(doc) ? doc : null;
  if (!Array.isArray(rows)) {
    problems.push(
      "`proposals` is not an array. A proposal document is `{ \"proposals\": [ ... ] }` — the shape " +
        "`worklist.mjs --skeleton` prints and `validate.mjs` reads."
    );
    return problems;
  }
  if (!rows.length) {
    problems.push("`proposals` is empty, so this document proposes nothing. Leave the submission off rather than submitting an empty one.");
    return problems;
  }
  rows.forEach((p, i) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) problems.push(`proposals[${i}] is not an object`);
    else if (!p.id) problems.push(`proposals[${i}] has no \`id\` — every other artifact addresses a proposal by it`);
  });
  for (const at of findAll(rows, SKELETON_TODO, "proposals")) {
    problems.push(
      `${at} is still the skeleton's \`${SKELETON_TODO}\` placeholder — that slot IS the derivation, ` +
        `and nothing has been derived into it. Fill it or leave the proposal out; nothing here will fill it for you.`
    );
  }
  // `setup` is agent-written and nothing about the document says what one
  // entry looks like, which is why this shape exists at all — see
  // `applyShapeFault`. Walked here rather than deep-searched, because a
  // refusal has to name the row and the index the author has to go and edit.
  rows.forEach((p, i) => {
    if (!p || typeof p !== "object" || !Array.isArray(p.setup)) return;
    p.setup.forEach((entry, j) => {
      const fault = applyShapeFault(entry, p.covers?.[0]);
      if (fault) problems.push(`proposals[${i}]${p.id ? ` "${p.id}"` : ""}.setup[${j}]: ${fault}`);
    });
  });
  for (const at of bannedIn(rows, "proposals")) {
    problems.push(
      `${at} is a field stage 3 may not carry (${BANNED_FIELDS.join(", ")}). Stage 4 RECORDS the output; ` +
        `a stage-3 document that predicts one is the claim this pipeline exists to refuse.`
    );
  }
  return problems;
}

/* --------------------------------------------------------------------------
 * WITHDRAWAL — THE CHANNEL A FALSE CLAIM HAD NO WAY TO TRAVEL DOWN
 *
 * THE GAP, measured against the real `ledger.mjs`. `loadProposed`
 * (ledger.mjs:94-113) reads `p.reaches` out of every `.json` in
 * `PROPOSALS_DIR` and nothing else, and `ledger.mjs:373-385` counts a side
 * accounted the moment `proposed.has(k)`. So a proposal that CLAIMS it drives
 * a branch is accounted from the moment it is written — and stays accounted
 * after stage 6 has run it and proved the claim FALSE. On run
 * `20260916T223906Z` that is one live row: `arg0-of-rawLocations-map-111-
 * binary-expr-0` claims `src/decorator/googleLocationCache.decorator.ts#111:
 * binary-expr:0 [null]`, istanbul reported 0 hits for it
 * (`stages/coverage.json`, `falseClaims`), and the side still reads as
 * answered to the ledger, the gate and the report.
 *
 * There was no writer that could take it back. `propose.mjs` wrote submitted
 * bytes verbatim, `blocked.mjs` wrote BLOCKED.md, and `fillboundaries.mjs` /
 * `fixup-boundaries.mjs` / `migrate-executable.mjs` rewrite boundary and
 * invocation fields. Nothing wrote `reaches`. This does, in one direction only:
 *
 *   node .claude/charpilot/propose.mjs --withdraw <proposalId> \
 *        --claim "<armId> [<side>]" --evidence <artifact.json> \
 *        [--file <name.json>] [--json]
 *
 * WHY IT IS NOT A `reaches` EDITOR, and why that is the whole design. A
 * withdrawal is a COVERAGE REDUCTION: the side stops being accounted and the
 * reported rate goes down, correctly. The same mechanism pointed wrongly
 * deletes a TRUE claim and hides real coverage, and it would be reached for
 * precisely when a run is red. So the caller's word is never taken for it —
 * `--evidence` names a stage-6 `coverage.json` or a stage-4 `behaviour.json`,
 * and the claim is withdrawable only if THAT ARTIFACT lists it as false. One
 * claim per call, named in full, with the artifact and what the run actually
 * hit appended to the row.
 *
 * WHY IT IS NOT `blocked.mjs`. A blocked entry has the ledger count the side as
 * accounted WITH A WRITTEN REASON, and none of `data-blocked` / `code-dead` /
 * `needs-seam` is a claim a machine can make out of a failed recording — it is
 * the declaration `repair.mjs:381-392` refuses to invite. Routing a withdrawal
 * through it would also trip the ledger's `doubleClaimed` check. Withdrawn and
 * blocked are different things and stay different: withdrawn returns the side
 * to UNACCOUNTED, which is the true state of a side nothing reaches.
 *
 * WHY THE EDIT IS A TEXT SPLICE AND NOT A RE-SERIALISATION. A proposal file is
 * hand-authored and is the one artifact this pipeline cannot rebuild.
 * `JSON.stringify` of the whole document would rewrite all 35 rows to withdraw
 * one claim, and a diff that touches every row is a diff nobody reads. So the
 * bytes OUTSIDE the edit are identical by construction: the row is located in
 * the raw text, the one array element is cut out of it, and the withdrawal
 * record is appended before the row's closing brace. The result is re-parsed
 * and compared against the same edit applied to the parsed document, so a
 * splice that produced something else refuses instead of landing.
 * ------------------------------------------------------------------------ */

/** Past the whitespace at `i`. */
const skipWs = (text, i) => {
  while (i < text.length && " \t\n\r".includes(text[i])) i += 1;
  return i;
};

/** Index just past the JSON string that starts at `i`. Escapes are consumed as pairs. */
function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j += 1;
  }
  throw new Error(`unterminated string at ${i}`);
}

/**
 * Index just past the JSON value that starts at `i`.
 *
 * Nesting is counted with strings SKIPPED, because a side label is an operand's
 * source text — `{ content: [], stop_reason: "error", }` is a real label in
 * this corpus — and a brace counter that read inside strings would end the
 * value in the middle of one.
 */
export function valueEnd(text, i) {
  const c = text[i];
  if (c === '"') return stringEnd(text, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"') {
        j = stringEnd(text, j);
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    throw new Error(`unterminated ${c} at ${i}`);
  }
  let j = i;
  while (j < text.length && !",}] \t\n\r".includes(text[j])) j += 1;
  return j;
}

/** Every member of the object whose `{` is at `objStart`, as spans into `text`. */
export function members(text, objStart) {
  const out = [];
  let i = objStart + 1;
  for (;;) {
    i = skipWs(text, i);
    if (i >= text.length) throw new Error(`unterminated object at ${objStart}`);
    if (text[i] === "}") return out;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    if (text[i] !== '"') throw new Error(`expected a key at ${i}, found ${JSON.stringify(text[i])}`);
    const keyStart = i;
    const keyEnd = stringEnd(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    let j = skipWs(text, keyEnd);
    if (text[j] !== ":") throw new Error(`expected ':' after ${key}`);
    j = skipWs(text, j + 1);
    const end = valueEnd(text, j);
    out.push({ key, keyStart, valueStart: j, valueEnd: end });
    i = end;
  }
}

/** Every element of the array whose `[` is at `arrStart`, as spans into `text`. */
export function elements(text, arrStart) {
  const out = [];
  let i = arrStart + 1;
  for (;;) {
    i = skipWs(text, i);
    if (i >= text.length) throw new Error(`unterminated array at ${arrStart}`);
    if (text[i] === "]") return out;
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    const end = valueEnd(text, i);
    out.push({ start: i, end });
    i = end;
  }
}

/** The span of every proposal row, in file order — the same order `JSON.parse` yields. */
export function proposalSpans(text) {
  const i = skipWs(text, 0);
  if (text[i] === "[") return elements(text, i);
  if (text[i] !== "{") throw new Error("the document is neither an object nor an array");
  const m = members(text, i).find((x) => x.key === "proposals");
  if (!m) throw new Error("the document has no `proposals`");
  if (text[m.valueStart] !== "[") throw new Error("`proposals` is not an array");
  return elements(text, m.valueStart);
}

/**
 * The text with the `k`th of `spans` cut out, comma and all.
 *
 * Cutting forward (this member's start to the next one's) for every element but
 * the last, and backward (the previous element's end to this one's) for the
 * last, is what keeps the SURVIVING elements' bytes untouched — a cut that
 * always ate the following comma would leave a trailing one on the last.
 */
export function cutSpan(text, spans, k, startOf = (s) => s.start, endOf = (s) => s.end) {
  // Never the only one left. A cut that quietly produced `{}` here would be a
  // decision made by a helper; spliceWithdrawal makes the one such decision
  // there is (a row's last claim) explicitly, by replacing the value.
  if (spans.length < 2) throw new Error("cutting the only entry would empty the thing it is in");
  if (k < spans.length - 1) return `${text.slice(0, startOf(spans[k]))}${text.slice(startOf(spans[k + 1]))}`;
  return `${text.slice(0, endOf(spans[k - 1]))}${text.slice(endOf(spans[k]))}`;
}

/** `--claim "<armId> [<side>]"`. The brackets are the delimiter: a side label can contain spaces, commas and `]`. */
export function parseClaim(spec) {
  const m = /^\s*(\S+)\s+\[([\s\S]+)\]\s*$/.exec(String(spec ?? ""));
  return m ? { arm: m[1], side: m[2] } : null;
}

/**
 * What the evidence artifact says about one claim, or why it cannot be used.
 *
 * Reads a stage-6 `coverage.json` (`falseClaims`, `verified`) or a stage-4
 * `behaviour.json` (`falseClaimsAtRecordTime`, `rows[].movedBranches`). Both
 * halves are required: the artifact must say this claim was FALSE, and it must
 * say what the run DID hit for this row — a withdrawal whose evidence cannot
 * name that is an assertion, which is the thing this refuses to accept.
 */
export function evidenceFor(doc, { id, arm, side }) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { error: "is not a JSON object, so it is not a verify artifact." };
  }
  const list = Array.isArray(doc.falseClaims)
    ? doc.falseClaims
    : Array.isArray(doc.falseClaimsAtRecordTime)
      ? doc.falseClaimsAtRecordTime
      : null;
  if (!list) {
    return {
      error:
        "carries neither `falseClaims` (a stage-6 coverage.json) nor `falseClaimsAtRecordTime` (a stage-4 " +
        "behaviour.json), so nothing in it judged any claim. Only a run that CHECKED this claim can retire it.",
    };
  }
  const hit = list.find((f) => f && f.id === id && f.armId === arm && String(f.side) === side);
  if (!hit) {
    const aboutRow = list.filter((f) => f && f.id === id).map((f) => `${f.armId} [${f.side}]`);
    return {
      error:
        `does not record ${id} claiming ${arm} [${side}] as FALSE. ` +
        (aboutRow.length
          ? `It calls these claims of that row false: ${aboutRow.join(", ")}.`
          : `It says nothing false about that row at all.`) +
        ` A claim that was not proven false must not be withdrawn — withdrawing it would DELETE coverage that is real ` +
        `and take the reported rate down with it. Measure first; if the claim is true, there is nothing to withdraw.`,
    };
  }
  if (Number(hit.hits ?? 0) > 0) {
    return { error: `records ${hit.hits} istanbul hit(s) for ${arm} [${side}], which is not a false claim.` };
  }
  const verified = Array.isArray(doc.verified) ? doc.verified.filter((v) => v && v.id === id) : null;
  const row = Array.isArray(doc.rows) ? doc.rows.find((r) => r && r.id === id) : null;
  if (verified === null && !row) {
    return {
      error:
        `says ${arm} [${side}] is false and says nothing about what the run actually hit — it carries neither ` +
        `\`verified\` nor a \`rows\` entry for ${id}. A withdrawal has to record the arm the run DID reach, or it is ` +
        `an assertion with a file path stapled to it. Use the run's coverage.json or its behaviour.json.`,
    };
  }
  return {
    record: {
      arm,
      side,
      evidence: {
        stage: doc.stage ?? null,
        at: doc.measuredAt ?? doc.recordedAt ?? null,
        mode: doc.mode ?? null,
        hits: Number(hit.hits ?? 0),
        mechanism: hit.mechanism ?? null,
      },
      reached: {
        verifiedClaims: (verified ?? []).map((v) => ({ arm: v.armId, side: v.side, hits: v.hits ?? null })),
        movedBranches: row?.movedBranches ?? null,
      },
    },
  };
}

/** The indentation of the object's own members, taken from the text rather than assumed. */
function leadOf(text, objStart, firstKeyStart) {
  const lead = text.slice(objStart + 1, firstKeyStart);
  return lead.includes("\n") ? lead : "\n  ";
}

/**
 * The withdrawal, as a text edit. Throws with the sentence a caller should print.
 *
 * Everything outside the row is untouched by construction, and inside the row
 * only the withdrawn side's own element and the appended `withdrawn` field move.
 */
export function spliceWithdrawal(text, at, { arm, side, record }) {
  const rows = proposalSpans(text);
  const row = rows[at];
  if (!row) throw new Error(`there is no row ${at} in this file`);
  const rowText = text.slice(row.start, row.end);
  const rowMembers = members(rowText, 0);
  const reaches = rowMembers.find((m) => m.key === "reaches");
  if (!reaches) throw new Error("the row has no `reaches`");
  const armMembers = members(rowText, reaches.valueStart);
  const k = armMembers.findIndex((m) => m.key === arm);
  if (k === -1) throw new Error(`the row does not claim ${arm}`);

  let edited;
  const armValueStart = armMembers[k].valueStart;
  // THE ROW'S LAST CLAIM: `reaches` becomes `{}`. cutSpan will not empty a
  // container, on purpose, so the whole value is replaced here instead - the
  // one place that decides a last claim may go (fix plan 1, F3.3).
  const emptyReaches = () => `${rowText.slice(0, reaches.valueStart)}{}${rowText.slice(reaches.valueEnd)}`;
  const lastArm = armMembers.length === 1;
  if (rowText[armValueStart] === "[") {
    const sides = elements(rowText, armValueStart);
    const s = sides.findIndex((e) => {
      try {
        return JSON.parse(rowText.slice(e.start, e.end)) === side;
      } catch {
        return false;
      }
    });
    if (s === -1) throw new Error(`the row does not claim ${arm} [${side}]`);
    edited =
      sides.length > 1
        ? cutSpan(rowText, sides, s)
        : lastArm
          ? emptyReaches()
          : cutSpan(rowText, armMembers, k, (m) => m.keyStart, (m) => m.valueEnd);
  } else {
    if (JSON.parse(rowText.slice(armValueStart, armMembers[k].valueEnd)) !== side) {
      throw new Error(`the row does not claim ${arm} [${side}]`);
    }
    edited = lastArm ? emptyReaches() : cutSpan(rowText, armMembers, k, (m) => m.keyStart, (m) => m.valueEnd);
  }

  // The record goes ONTO the row, so it travels with the claim it retires.
  // `ledger.mjs` reads `reaches` and nothing else, so this field is invisible
  // to the count and legible to the person auditing it.
  const after = members(edited, 0);
  const lead = leadOf(edited, 0, after[0].keyStart);
  const pad = lead.slice(lead.lastIndexOf("\n") + 1);
  // The file's OWN indent step, not this tool's opinion of one. A proposal file
  // is hand-authored; a record indented two spaces inside a four-space document
  // is a diff that reads as a reformat.
  const rowIndent = text.slice(text.lastIndexOf("\n", row.start) + 1, row.start);
  const step = Math.max(1, pad.length - rowIndent.length) || 2;
  const render = (v) => JSON.stringify(v, null, step).split("\n").join(`\n${pad}`);
  const existing = after.find((m) => m.key === "withdrawn");
  if (existing && edited[existing.valueStart] === "[") {
    const kept = JSON.parse(edited.slice(existing.valueStart, existing.valueEnd));
    return `${text.slice(0, row.start)}${
      edited.slice(0, existing.valueStart) + render([...kept, record]) + edited.slice(existing.valueEnd)
    }${text.slice(row.end)}`;
  }
  const last = after[after.length - 1];
  return `${text.slice(0, row.start)}${
    edited.slice(0, last.valueEnd) + `,${lead}"withdrawn": ${render([record])}` + edited.slice(last.valueEnd)
  }${text.slice(row.end)}`;
}

/** The same edit, applied to the parsed document — what the splice has to agree with. */
export function withdrawnDoc(doc, at, { arm, side, record }) {
  const rows = Array.isArray(doc) ? doc : doc.proposals;
  const row = rows[at];
  const value = row.reaches[arm];
  if (Array.isArray(value)) {
    const rest = value.filter((v) => String(v) !== side);
    if (rest.length) row.reaches[arm] = rest;
    else delete row.reaches[arm];
  } else delete row.reaches[arm];
  row.withdrawn = [...(Array.isArray(row.withdrawn) ? row.withdrawn : []), record];
  return doc;
}

/** Every `reaches` entry a row still states, as `arm [side]`. */
export function claimsOf(row) {
  const out = [];
  for (const [arm, value] of Object.entries(row?.reaches ?? {})) {
    for (const side of Array.isArray(value) ? value : [value]) out.push(`${arm} [${side}]`);
  }
  return out;
}

function withdrawMain(JSON_OUT) {
  const id = arg("--withdraw");
  const claimSpec = arg("--claim");
  const evidencePath = arg("--evidence");
  for (const bad of ["--from", "--name", "--replace"]) {
    if (ARGV.includes(bad)) {
      refuse(`${bad} is the SUBMISSION path and --withdraw is the withdrawal path. One call does one of them.`);
    }
  }
  if (!claimSpec) {
    refuse(
      `--claim is required: the one claim to withdraw, as \`--claim "<armId> [<side>]"\`. ` +
        `This tool drops ONE entry from one row's \`reaches\`; it is not a \`reaches\` editor.`
    );
  }
  const claim = parseClaim(claimSpec);
  if (!claim) {
    refuse(
      `--claim ${JSON.stringify(claimSpec)} is not \`<armId> [<side>]\`. The brackets are the delimiter, because a ` +
        `side label is an operand's source text and can contain spaces and commas — e.g. ` +
        `--claim "src/a.ts#30:cond-expr:0 [whenFalse]".`
    );
  }
  if (!evidencePath) {
    refuse(
      `--evidence is required: the verify artifact that recorded this claim FALSE — a stage-6 coverage.json or a ` +
        `stage-4 behaviour.json. A withdrawal REMOVES a side from the accounted set and takes the reported rate down ` +
        `with it, so it is made on a measurement, never on a caller's word. If no run has judged this claim, measure ` +
        `first: \`npm run pilot:measure\`.`
    );
  }

  if (!existsSync(PROPOSALS_DIR)) refuse(`${rel(PROPOSALS_DIR)} does not exist, so there is no proposal to withdraw from.`);
  const only = arg("--file") ? targetName(arg("--file")) : null;
  const found = [];
  for (const file of readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"))) {
    if (only && file !== only) continue;
    let doc;
    const bytes = readFileSync(join(PROPOSALS_DIR, file), "utf8");
    try {
      doc = JSON.parse(bytes);
    } catch {
      continue;
    }
    const rows = Array.isArray(doc) ? doc : doc?.proposals;
    if (!Array.isArray(rows)) continue;
    rows.forEach((p, at) => {
      if (p && p.id === id) found.push({ file, at, bytes, doc, row: p });
    });
  }
  if (!found.length) {
    refuse(
      `no proposal with id ${JSON.stringify(id)} is in ${rel(PROPOSALS_DIR)}${only ? `/${only}` : ""}. ` +
        `A withdrawal names the row it takes a claim off; nothing was changed.`
    );
  }
  if (found.length > 1) {
    refuse(
      `${JSON.stringify(id)} is in ${found.length} places (${found.map((f) => `${f.file}[${f.at}]`).join(", ")}). ` +
        `Name one with --file, so the row this takes a claim off is the row you meant.`
    );
  }

  const { file, at, bytes, doc, row } = found[0];
  const target = join(PROPOSALS_DIR, file);
  const stated = claimsOf(row);
  if (!stated.includes(`${claim.arm} [${claim.side}]`)) {
    refuse(
      `${id} does not claim ${claim.arm} [${claim.side}], so there is nothing to withdraw.\n` +
        `  ${rel(target)} says that row reaches:\n` +
        (stated.length ? stated.map((c) => `    ${c}\n`).join("") : "    nothing at all\n") +
        `  Nothing was written.`
    );
  }

  const evidenceAbs = resolve(evidencePath);
  if (!existsSync(evidenceAbs)) refuse(`--evidence ${rel(evidenceAbs)} does not exist, so no measurement backs this withdrawal.`);
  let evidenceDoc;
  try {
    evidenceDoc = JSON.parse(readFileSync(evidenceAbs, "utf8"));
  } catch (err) {
    refuse(`--evidence ${rel(evidenceAbs)} is not JSON — ${err.message}. Nothing was written.`);
  }
  const judged = evidenceFor(evidenceDoc, { id, arm: claim.arm, side: claim.side });
  if (judged.error) refuse(`--evidence ${rel(evidenceAbs)} ${judged.error}\n  Nothing was written.`);
  const record = {
    arm: judged.record.arm,
    side: judged.record.side,
    artifact: rel(evidenceAbs),
    evidence: judged.record.evidence,
    reached: judged.record.reached,
    withdrawnAt: new Date().toISOString(),
  };

  // THE LAST CLAIM IS WITHDRAWN LIKE ANY OTHER, and the row stays.
  //
  // WHAT THIS USED TO DO: refuse, calling it "a row DELETION" that wants its
  // own decision. Measured across notification-ms, company-enrich, pricing-ms,
  // outreach-thread-ms and tracy-agent-be-ms (2026-09-21/22): every false row
  // claimed exactly one side, so every withdrawal was refused, `withdrawn=0` in
  // every late round of all five, and the false claim stood until report
  // refused the run on it. Nobody ever made the "own decision" the refusal
  // asked for; it became a decision item the agent could not answer.
  //
  // Nothing is deleted. The row keeps its input and its recorded behaviour,
  // which are real; it stops claiming a side the measurement says it never
  // reached, and the `withdrawn` record says why. With `reaches` empty the
  // ledger accounts nothing for it, so the side returns to unaccounted and
  // derive deals it again with this evidence - it is counted neither covered
  // nor unreachable. Fix plan 1, F3.3.

  let nextText;
  try {
    nextText = spliceWithdrawal(bytes, at, { arm: claim.arm, side: claim.side, record });
  } catch (err) {
    // The splice reads the raw bytes rather than the parse, so it can disagree
    // with the parse about a document nothing else has complained about. That
    // is a refusal with a sentence, never a stack trace over a half-written file.
    refuse(`${rel(target)} could not be edited — ${err.message}. Nothing was written.`);
  }
  const expected = withdrawnDoc(doc, at, { arm: claim.arm, side: claim.side, record });
  let landed;
  try {
    landed = JSON.parse(nextText);
  } catch (err) {
    refuse(`the edit did not produce JSON — ${err.message}. Nothing was written.`);
  }
  if (JSON.stringify(landed) !== JSON.stringify(expected)) {
    refuse(
      `the edited bytes do not parse to the document this withdrawal meant to produce. This is a defect in the ` +
        `splice, not in the input — nothing was written.`
    );
  }
  const problems = problemsWith(landed);
  if (problems.length) {
    refuse(`withdrawing would leave ${rel(target)} unreadable:\n` + problems.map((p) => `    ${p}`).join("\n") + `\n  Nothing was written.`);
  }

  // The same lock, temp file and rename the submission path uses. Two
  // withdrawals against one file are two read-modify-writes, and without this
  // the second one's copy of the bytes is the pre-first-withdrawal copy — so
  // the first withdrawal is silently undone and a side nothing reaches goes
  // back to reading as accounted.
  const LOCK = `${target}.lock`;
  try {
    writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
    HELD = LOCK;
  } catch (err) {
    if (err?.code !== "EEXIST") refuse(`could not take ${rel(LOCK)}: ${err?.message ?? err}`);
    refuse(
      `another writer holds ${rel(LOCK)}. Two writers on one proposal file lose one of the two edits silently, so ` +
        `this one is refused rather than raced. Retry when it releases; if no writer is running, the lock is stale ` +
        `and deleting it is safe.`
    );
  }
  process.on("exit", releaseLock);

  // Re-read UNDER THE LOCK. The bytes above were read before it was taken, so a
  // withdrawal that landed in between would be overwritten by this one.
  if (readFileSync(target, "utf8") !== bytes) {
    refuse(`${rel(target)} changed while this withdrawal was being prepared. Nothing was written; run it again.`);
  }

  const TMP = `${target}.tmp`;
  if (existsSync(TMP)) refuse(`${rel(TMP)} already exists — a previous write was interrupted. Look at it, then remove it.`);
  try {
    writeFileSync(TMP, nextText);
    if (readFileSync(TMP, "utf8") !== nextText) throw new Error("the bytes read back from the temp file are not the bytes written");
    renameSync(TMP, target);
    releaseLock();
  } catch (err) {
    try {
      if (existsSync(TMP)) unlinkSync(TMP);
    } catch {}
    refuse(`could not write ${rel(target)}: ${err.message}. It is unchanged.`);
  }

  const remaining = claimsOf(landed.proposals ? landed.proposals[at] : landed[at]);
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify(
        { file: rel(target), action: "withdrawn", proposal: id, claim: `${claim.arm} [${claim.side}]`, evidence: record.artifact, remaining },
        null,
        2
      )}\n`
    );
    return;
  }
  process.stdout.write(
    `\n✓ propose --withdraw — ${rel(target)}\n` +
      `    ${id} no longer claims ${claim.arm} [${claim.side}]\n` +
      `    evidence  ${record.artifact} (${record.evidence.stage ?? "?"}, ${record.evidence.hits} istanbul hits${
        record.evidence.mechanism ? `, ${record.evidence.mechanism}` : ""
      })\n` +
      `    the run hit  ${
        record.reached.verifiedClaims.length
          ? record.reached.verifiedClaims.map((v) => `${v.arm} [${v.side}]`).join(", ")
          : "no arm this row claimed"
      }\n` +
      remaining.map((c) => `    still claims  ${c}\n`).join("") +
      `    That side is UNACCOUNTED again — \`npm run pilot:ledger\` will say so, and that is the point.\n`
  );
}

function main() {
  checkFlags();

  const JSON_OUT = ARGV.includes("--json");
  const REPLACE = ARGV.includes("--replace");

  // TWO PATHS, ONE DOOR. The submission path PUTS a document in; the withdrawal
  // path takes one claim out of a document already there. They share the lock,
  // the temp file and the rename, which is the only reason they share a file.
  if (ARGV.includes("--withdraw")) {
    withdrawMain(JSON_OUT);
    return;
  }

  const from = arg("--from");
  if (!from) refuse("--from is required: the path of the document the answering turn submitted.");
  const source = resolve(from);
  if (!existsSync(source)) refuse(`--from ${rel(source)} does not exist, so there is nothing to put anywhere.`);
  if (resolve(source).startsWith(`${resolve(PROPOSALS_DIR)}/`)) {
    refuse(`--from ${rel(source)} is already inside ${rel(PROPOSALS_DIR)}. This tool moves a submission IN; it does not copy one onto itself.`);
  }

  const submitted = readFileSync(source, "utf8");
  let doc;
  try {
    doc = JSON.parse(submitted);
  } catch (err) {
    refuse(`${rel(source)} is not JSON — ${err.message}. Nothing was written.`);
  }

  /* --- D73: ONE CLASHING ROW MUST NOT COST THE NINETEEN BESIDE IT ---------
   *
   * `--exclude a,b,c` drops those row ids from the document being landed and
   * writes the rest. It exists for exactly one caller and one situation:
   * `steps/derive.mjs:materialise` has found that a row id in this submission
   * is ALREADY answered in another file of the same round, and
   * `validate.mjs:681` keeps `seen` ids across the whole flattened proposals
   * directory — so landing both copies refuses BOTH as `duplicate id` and the
   * side comes back open. Until this flag existed the only way to avoid that
   * was to drop the WHOLE file, which is 19 correct rows paying for one
   * collision (plan 19, D73).
   *
   * WHY HERE AND NOT IN THE STEP. `steps/derive.mjs` puts no bytes on disk —
   * `derive.submission.test.mjs`'s "the step writes nothing of its own" greps
   * its source for every write call there is — so a step cannot hand this tool
   * a filtered temp file. The filter belongs to the writer or nowhere.
   *
   * WHAT IT COSTS, said rather than hidden: with `--exclude` the bytes written
   * are NOT the bytes submitted. Without it they still are, byte for byte, and
   * that is every other call. The excluded ids are printed, so what landed and
   * what did not is in the tool's own output rather than in the caller's
   * summary of it.
   */
  const excludeRaw = arg("--exclude");
  const exclude = new Set(
    String(excludeRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );
  let bytes = submitted;
  let dropped = [];
  if (exclude.size) {
    const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.proposals) ? doc.proposals : null;
    if (!rows) {
      refuse(`--exclude was given but ${rel(source)} carries no \`proposals\` array to exclude a row from.`);
    }
    const keep = rows.filter((r) => !exclude.has(r?.id));
    dropped = rows.filter((r) => exclude.has(r?.id)).map((r) => r.id);
    if (!keep.length) {
      refuse(
        `--exclude names every row in ${rel(source)} (${dropped.join(", ")}), so there is nothing left to land. ` +
          `Nothing was written.`
      );
    }
    doc = Array.isArray(doc) ? keep : { ...doc, proposals: keep };
    bytes = `${JSON.stringify(doc, null, 2)}\n`;
  }

  const problems = problemsWith(doc);
  if (problems.length) {
    refuse(
      `${rel(source)} is not a document this can put in ${rel(PROPOSALS_DIR)}:\n` +
        problems.map((p) => `    ${p}`).join("\n") +
        `\n  Nothing was written.`
    );
  }

  const name = targetName(arg("--name", basename(source)));
  if (!name) refuse(`--name ${JSON.stringify(arg("--name", basename(source)))} is not a file name.`);
  const target = join(PROPOSALS_DIR, name);

  if (existsSync(target) && !REPLACE) {
    refuse(
      `${rel(target)} already exists. Overwriting it would remove proposals nobody asked to remove — ` +
        `pass --replace to overwrite it deliberately, or submit under a different name.`
    );
  }

  // The lock, for the reason blocked.mjs spells out: two writers renaming over
  // one name both succeed and one document is gone, silently.
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const LOCK = `${target}.lock`;
  try {
    writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
    HELD = LOCK;
  } catch (err) {
    if (err?.code !== "EEXIST") refuse(`could not take ${rel(LOCK)}: ${err?.message ?? err}`);
    refuse(
      `another writer holds ${rel(LOCK)}. Two writers landing on one name lose a document silently, so this one ` +
        `is refused rather than raced. Retry when it releases; if no writer is running, the lock is stale and deleting it is safe.`
    );
  }
  process.on("exit", releaseLock);

  const TMP = `${target}.tmp`;
  if (existsSync(TMP)) {
    refuse(`${rel(TMP)} already exists — a previous write was interrupted. Look at it, then remove it.`);
  }
  const replaced = existsSync(target);
  try {
    // VERBATIM. The bytes read are the bytes written: this tool is a door, not
    // an editor, and a document that came back reformatted would be one whose
    // author could no longer diff what they submitted against what landed.
    writeFileSync(TMP, bytes);
    if (readFileSync(TMP, "utf8") !== bytes) throw new Error("the bytes read back from the temp file are not the bytes written");
    renameSync(TMP, target);
    releaseLock();
  } catch (err) {
    try {
      if (existsSync(TMP)) unlinkSync(TMP);
    } catch {}
    refuse(`could not write ${rel(target)}: ${err.message}. ${replaced ? "It is unchanged." : "It was not created."}`);
  }

  const ids = (Array.isArray(doc) ? doc : doc.proposals).map((p) => p.id);
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify(
        { file: rel(target), from: rel(source), action: replaced ? "replaced" : "written", proposals: ids, ...(dropped.length ? { excluded: dropped } : {}) },
        null,
        2
      )}\n`
    );
    return;
  }
  process.stdout.write(
    `\n✓ propose — ${rel(target)} (${replaced ? "replaced" : "written"}) from ${rel(source)}\n` +
      ids.map((id) => `    ${id}\n`).join("") +
      (dropped.length
        ? `    ${dropped.length} row(s) EXCLUDED and not written — ${dropped.join(", ")}\n`
        : "") +
      `    \`npm run pilot:validate\` judges them.\n`
  );
}

// Only when this file is the ENTRY POINT. `import.meta.main` needs Node 24; on
// an older runtime it is undefined, and a bare truthiness test would make this
// a silent no-op — a tool that runs and writes nothing while reporting success.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}
