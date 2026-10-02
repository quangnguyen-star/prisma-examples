#!/usr/bin/env node
/**
 * One call to add one BLOCKED.md entry.
 *
 * Measured on run `20260915T050314Z`, the mocked baseline: 46 calls landed on
 * `proposals/BLOCKED.md` - 13 reads and 9 edits of ONE file - to write 15
 * entries. Every edit needed a read first, because the tool the agent had was
 * "replace this exact string", and a string cannot be replaced until it has
 * been seen. That is the whole cost: the file is append-only in practice and
 * was being rewritten like a document.
 *
 *   node .claude/charpilot/blocked.mjs --arm <armId> --side <label[,label]> \
 *        --category code-dead --killer code-local --proof <file:line> \
 *        [--fix <how it could be unblocked>]   (required for data-blocked) \
 *        [--heading <one line>] [--why <the argument, in prose>] \
 *        [--replace] [--json]
 *
 * It appends ONE fenced `blocked` block, optionally preceded by the `##`
 * heading and the paragraph a person reads. It writes nothing else, and it
 * moves no byte that was already in the file.
 *
 * WHY IT REFUSES RATHER THAN REPAIRS, which is the only way this can be a
 * saving instead of a new place for a failure to rest. A writer that sits
 * between what the agent meant and what the artifact says has the same shape as
 * the replay defect that cost run 20260914T070959Z 4.4 coverage points: the
 * artifact reads as ruled, and the ruling is not the one anybody made. So every
 * check below ends in a non-zero exit naming the input, never in a fixed-up
 * entry:
 *
 *   - an arm the work list does not hold, a side that is not one of that arm's
 *     labels, or a side that is already COVERED. All three are the same defect
 *     - a ruling about a side that does not exist to be ruled - and ledger.mjs
 *     reports the last two as `stale` much later, in the stage that cannot fix
 *     them.
 *   - a side a proposal already claims. ledger calls that `doubleClaimed`; it
 *     is an input and a reason for the same side, and only one of them is true.
 *   - a duplicate. An entry for a side this file already rules is REFUSED, and
 *     `--replace` rewrites that one fence and PRINTS what it replaced. Nothing
 *     here overwrites an entry quietly.
 *   - a malformed field, judged by ledger.mjs's own parser over the candidate
 *     file - not by a second copy of the rules living here. The category, the
 *     killer, the `fix:` a data-blocked side owes, the proof that cites the
 *     arm's own line: all of those refusals are ledger's, imported.
 *
 * And it adds no field. `arm`, `side`, `category`, `killer`, `proof`, `fix` are
 * what ledger.mjs reads; a seventh key would be a disposition this pipeline
 * does not have, so an unrecognised flag is refused by name rather than written
 * through.
 *
 * The write is a temp file and a rename, so a failure leaves the file exactly
 * as it was rather than truncated - a half-written BLOCKED.md is a file whose
 * missing entries look like sides nobody ruled.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
// THE FORMAT LIVES IN THE READER. ledger.mjs defines what a blocked entry is
// and is the thing that fails when one is wrong, so this writer imports its
// parser and its vocabularies rather than restating them. A writer with its own
// copy of the rules is a writer that can drift from the checker - and a drifted
// writer produces a file that reads as checked and is not, which is the exact
// artifact this pipeline exists to stop accepting.
import {
  CATEGORIES,
  KILLERS,
  UNREAD_CALLER_SET,
  doubleClaimEvidence,
  loadProposed,
  parseBlocked,
  resolveDoubleClaim,
  sidesOf,
} from "./ledger.mjs";

const BLOCKED_MD = join(PROPOSALS_DIR, "BLOCKED.md");
// Deterministic, and beside the target so the rename is within one filesystem.
// It doubles as an interruption marker: see the refusal below.
const TMP = `${BLOCKED_MD}.tmp`;

const ARGV = process.argv.slice(2);
/** Flags that consume the next argument. These are also exactly the fields. */
const VALUE_FLAGS = ["--arm", "--side", "--category", "--killer", "--proof", "--fix", "--heading", "--why"];
const BARE_FLAGS = ["--replace", "--json"];
/**
 * `indexOf` returns -1 when the flag is absent, so `ARGV[-1 + 1]` reads the
 * FIRST argument, whatever it is. That bug has shipped in this toolset once
 * already (worklist.mjs's `--file`), so the read is guarded here too.
 */
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};

const rel = (p) => relative(REPO_ROOT, p) || p;

/**
 * The `kind` scan.json gives an arm id, or null when the scan is not there,
 * does not parse, or holds no such arm. Read only to word a refusal: an arm
 * the work list does not hold is refused either way.
 */
function scannedKind(armId) {
  try {
    const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
    const arms = [
      ...(scan.functions ?? []).flatMap((f) => f?.arms?.list ?? []),
      ...(scan.moduleScopeArms ?? []).flatMap((g) => g?.list ?? []),
    ];
    return arms.find((a) => a?.armId === armId)?.kind ?? null;
  } catch {
    return null;
  }
}

/**
 * Every exit from this file that is not a written entry.
 *
 * stdout stays EMPTY on a refusal. A reader that greps stdout for the entry it
 * asked for must find nothing, because a half-printed confirmation for a file
 * that was not written is the same wrong answer as a silent repair.
 */
/**
 * The lock this process holds, or null. Module scope so `refuse` can release it.
 *
 * `process.on("exit")` looked like enough and was not: the corpus test's
 * fifteenth append inherited a lock from an earlier one, because a handler
 * registered inside a function body is not reached by every path that leaves it.
 * An explicit release on the two ways out - refused, or written - does not
 * depend on where the handler was installed.
 */
let HELD = null;

function releaseLock() {
  if (!HELD) return;
  try { if (existsSync(HELD)) unlinkSync(HELD); } catch {}
  HELD = null;
}

function refuse(message) {
  releaseLock();
  process.stderr.write(`blocked: ${message}\n`);
  process.exit(2);
}

/**
 * An unrecognised flag is REFUSED, not ignored.
 *
 * Ignoring it is how `--reason "..."` writes an entry with no argument in it at
 * all: the prose the agent wrote goes nowhere, the entry is still well-formed,
 * and the ruling ships with its reason missing. Same for a stray positional -
 * an unquoted `--why` paragraph arrives as eight arguments and seven of them
 * would vanish.
 */
function checkFlags() {
  const seen = new Set();
  for (let i = 0; i < ARGV.length; i += 1) {
    const token = ARGV[i];
    // A flag passed twice takes its FIRST value here (`indexOf`), so
    // `--killer code-local ... --killer config` would write code-local and
    // report success - the ruling that ships is not the one the second flag
    // asked for, and nothing says so. One field, one value, or refuse.
    if (VALUE_FLAGS.includes(token) || BARE_FLAGS.includes(token)) {
      if (seen.has(token)) {
        refuse(
          `${token} is given more than once. Only the first would be written, so the entry would not be the one you ` +
            `asked for. Pass it once.`
        );
      }
      seen.add(token);
    }
    if (VALUE_FLAGS.includes(token)) {
      const value = ARGV[i + 1];
      if (value === undefined || VALUE_FLAGS.includes(value) || BARE_FLAGS.includes(value)) {
        refuse(`${token} needs a value. Give it one, or leave the flag off - an empty field is not a field.`);
      }
      i += 1;
      continue;
    }
    if (BARE_FLAGS.includes(token)) continue;
    refuse(
      `${JSON.stringify(token)} is not an argument this tool takes. It writes the six fields ledger.mjs reads ` +
        `(${VALUE_FLAGS.slice(0, 6).join(" ")}) plus ${BARE_FLAGS.join(" ")}, and nothing else: a field the format ` +
        `does not define is a disposition this pipeline does not have. If the text is a paragraph, quote it - ` +
        `an unquoted --why arrives as one argument per word.`
    );
  }
}

/**
 * A value that spans lines, or carries a fence, cannot be written into this
 * format - `^\s*([a-z]+)\s*:\s*(.+?)\s*$` is what reads it back, one field per
 * line, and ``` ends the block. Rather than strip the newline (a repair, and
 * one that changes the ruling) this refuses and names the field.
 */
function singleLine(flag, value) {
  if (value === undefined) return value;
  if (value.includes("\n")) {
    refuse(`${flag} must be one line - ledger.mjs reads one field per line, so a newline here would split the field in two.`);
  }
  if (value.includes("```")) {
    refuse(`${flag} contains a \`\`\` fence, which would end the block early and silently truncate the entry.`);
  }
  if (!value.trim()) refuse(`${flag} is empty. An empty field is not a field; leave the flag off or say something.`);
  return value.trim();
}

/** The one line a reader sees on stdout per written entry. */
function summarise(fields, count, path) {
  return (
    `\n✓ blocked — ${rel(path)}\n` +
    Object.entries(fields)
      .map(([k, v]) => `    ${k.padEnd(9)} ${v}\n`)
      .join("") +
    `    ${count} entr${count === 1 ? "y" : "ies"} in the file now. \`npm run pilot:ledger\` reads them.\n`
  );
}

/** The fence, in ledger.mjs's field order. Nothing else is written. */
function renderFence(fields) {
  return `\`\`\`blocked\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}\n`).join("")}\`\`\``;
}

function main() {
  checkFlags();

  const JSON_OUT = ARGV.includes("--json");
  const REPLACE = ARGV.includes("--replace");

  const fields = {};
  for (const name of ["arm", "side", "category", "killer", "proof", "fix"]) {
    const value = singleLine(`--${name}`, arg(`--${name}`, undefined));
    if (value !== undefined) fields[name] = value;
  }
  const heading = singleLine("--heading", arg("--heading", undefined));
  const why = arg("--why", undefined);
  if (why !== undefined && why.includes("```")) {
    refuse("--why contains a ``` fence, which would open or close a block outside the entry. Prose only.");
  }
  if (why !== undefined && !why.trim()) refuse("--why is empty. Leave it off rather than writing a blank argument.");

  // Required fields first, each named on its own, because "malformed entry" is
  // not an instruction and `missing \`killer\`` is.
  for (const name of ["arm", "side", "category", "killer", "proof"]) {
    if (!fields[name]) {
      refuse(
        `--${name} is required. ledger.mjs reads arm, side, category, killer and proof on every entry, ` +
          `and reports one that is short a field as malformed - in stage 6, where it cannot be answered.`
      );
    }
  }
  if (!CATEGORIES.has(fields.category)) {
    refuse(
      `--category ${JSON.stringify(fields.category)} is not one of ${[...CATEGORIES].join(" | ")}. ` +
        `These are the three ledger.mjs accepts; a fourth would be a new bucket, and this plan adds none.`
    );
  }
  if (!KILLERS.has(fields.killer)) {
    refuse(
      `--killer ${JSON.stringify(fields.killer)} is not one of ${[...KILLERS].join(" | ")}. ` +
        `\`category\` says whether the side is reachable; \`killer\` says WHERE the constraint lives, which is what ` +
        `decides how this entry goes false.`
    );
  }
  // Not a formatting rule: a data-blocked side is recoverable by definition, so
  // an entry that does not say how is a gap with no way back out of it.
  if (fields.category === "data-blocked" && !fields.fix) {
    refuse("--fix is required when --category is data-blocked: a side that could be unblocked must say how.");
  }

  // ---- the arm and the side have to exist, and be uncovered ---------------
  //
  // Everything here is a check ledger.mjs would make LATER, in stage 6, where
  // the answer is "some entry is stale" and not "this one is, and here is the
  // arm you typed". Failing at the keystroke is the whole difference.
  if (!existsSync(WORKLIST_JSON)) {
    refuse(
      `${rel(WORKLIST_JSON)} does not exist, so no arm id can be checked and an entry written now would be ` +
        `unverifiable bookkeeping. Build the brief first: \`npm run pilot:worklist\`.`
    );
  }
  const worklist = JSON.parse(readFileSync(WORKLIST_JSON, "utf8"));
  const item = worklist.items.find((i) => i.armId === fields.arm);
  if (!item && scannedKind(fields.arm) === "transpile-artifact") {
    // THE ARM EXISTS, AND IT IS NOT ONE ANYBODY RULES. The generic sentence
    // below sends the reader to `pilot:armids` to repair an id that has moved,
    // and this id has not moved: it is byte-exact in scan.json. profile-
    // centralized (September 2026) submitted five declarations on the `reuse`
    // side of enum guards, each refused with that sentence, and spent two
    // rounds of workers re-proving from worklist.mjs's source that the id was
    // right. The refusal has to say what the arm IS and what to do with the
    // entry, because the only fix is on the submitting side.
    refuse(
      `--arm ${fields.arm} is a transpile artifact, so there is nothing to rule. Remove it from the declarations file ` +
        `it came from (\`{ "declarations": [] }\` is a valid file) and it stops being refused. The id is right: it is ` +
        `the \`X || (X = {})\` guard tsc emits around an enum or a namespace, and worklist.mjs declines every such arm - ` +
        `its sides are counted into the work list's self-check and never put in front of anybody - so it is not in ` +
        `${rel(WORKLIST_JSON)} and ledger.mjs does not reconcile it.`
    );
  }
  if (!item) {
    refuse(
      `--arm ${fields.arm} is not an arm in ${rel(WORKLIST_JSON)}. An entry for an id nothing holds rules nothing. ` +
        `\`node .claude/charpilot/worklist.mjs --fields armId --file ${String(fields.arm).split("#")[0].split("/").pop()}\` ` +
        `lists the ids in that file; \`npm run pilot:armids\` repairs one that has moved.`
    );
  }
  if (!item.instrumented) {
    refuse(
      `--arm ${fields.arm} is not instrumented (${item.kind ?? "unit"}), so it is not in the set ledger.mjs reconciles ` +
        `and an entry for it reads as stale bookkeeping there. Catch arms and uninstrumented units are counted, not ruled.`
    );
  }
  const labels = new Set([...(item.sides ?? []), ...item.uncoveredSides]);
  const sides = sidesOf(fields.side, labels);
  for (const side of sides) {
    if (item.uncoveredSides.includes(side)) continue;
    if (labels.has(side)) {
      refuse(
        `--side ${JSON.stringify(side)} on ${fields.arm} is already COVERED. A covered side has nothing to rule, and ` +
          `ledger.mjs reports an entry for one as a stale blocked entry.`
      );
    }
    refuse(
      `--side ${JSON.stringify(side)} is not one of ${fields.arm}'s labels. Its uncovered sides are: ` +
        `${item.uncoveredSides.map((s) => JSON.stringify(s)).join(", ")}. Side labels are matched BYTE-EXACTLY, and a ` +
        `label can contain a comma - pass it exactly as the work list prints it.`
    );
  }

  // ---- a side cannot have an input AND a reason ---------------------------
  let proposed;
  try {
    proposed = loadProposed(new Map(worklist.items.map((i) => [i.armId, new Set([...(i.sides ?? []), ...i.uncoveredSides])])));
  } catch (err) {
    refuse(
      `a proposal file in ${rel(PROPOSALS_DIR)} will not parse, so this cannot tell whether an input already claims ` +
        `this side: ${err.message}. \`npm run pilot:validate\` lists every malformed file.`
    );
  }
  // A CLAIM THE LEDGER ITSELF WOULD OVERRULE IS NOT A REASON TO REFUSE.
  //
  // ledger.mjs does not fail every side with an input and a reason: its
  // `resolveDoubleClaim` lets the measurement decide, and when every proposal
  // claiming the side was SKIPPED by record.mjs and coverage.json still has
  // the side uncovered, the reason stands and the side counts as ruled. This
  // writer refused that same pair on sight, so an entry the reader would
  // accept could never be written. profile-centralized (September 2026):
  // `organization.title ?? undefined` sits behind a `.filter` that keeps only
  // truthy titles, the one row aimed at `undefined` could not be run ("names a
  // binding but the arm is nested"), repair asked for a declaration after the
  // side stalled - and the declaration could not land, because that row's
  // claim was still on disk. propose.mjs cannot take it back either: it is the
  // row's only claim, and withdrawing it would be a row deletion.
  //
  // The reader's own rule, imported: any other verdict still refuses, and its
  // sentence says which two claims to choose between.
  let evidence;
  for (const side of sides) {
    const claim = proposed.get(`${fields.arm} ${side}`);
    if (claim) {
      evidence ??= doubleClaimEvidence();
      const verdict = resolveDoubleClaim(`${fields.arm} ${side}`, claim, evidence);
      if (verdict.winner === "blocked") continue;
      refuse(
        `${fields.arm} [${side}] is already claimed by an input: ${claim.join(", ")}. A side with a proposal AND a ` +
          `reason is what ledger.mjs calls doubleClaimed - ${verdict.why}. Retract the proposal first ` +
          `if the side really cannot be reached.`
      );
    }
  }

  // ---- the file, and what it already rules -------------------------------
  if (existsSync(TMP)) {
    refuse(
      `${rel(TMP)} already exists. Either a previous write was interrupted or another writer holds it, and in both ` +
        `cases its contents are a fact about this file that this tool will not overwrite. Look at it, then remove it.`
    );
  }
  // Absent is not malformed. ledger.mjs reports a missing BLOCKED.md as an
  // error, so a first entry would otherwise cost two calls to write - which is
  // the cost this whole tool exists to remove. The header is benchguard.mjs's,
  // so a seeded file and a grown one read the same.
  //
  // It is built here and written ONLY by the write below, never as a side
  // effect: a refusal that left a header behind would be a refusal that changed
  // the artifact, and then "the file is unchanged" stops being true of every
  // refusal - which is the claim the whole design rests on.
  // ---- the lock ----------------------------------------------------------
  //
  // THE WINDOW BETWEEN THE READ AND THE RENAME, closed.
  //
  // Everything below reads BLOCKED.md, renders a candidate around it, checks
  // the candidate, and renames it into place. Two writers running that at once
  // both read the same `before`, both append one entry, and the second rename
  // wins - so the first entry is gone, and it is gone SILENTLY: the file is
  // well-formed, ledger.mjs accepts it, and the only evidence is a side nobody
  // ruled turning up as unaccounted three stages later.
  //
  // This is not hypothetical. Run 20260915T111158Z-live logged 21 of its 70
  // failure events against this one file - the largest single cluster - as
  // subagents contended for it: `cat >`, `cat >>`, Write, Edit, an `echo hello`
  // to test whether Bash worked at all, then `cp` to /tmp. Eleven were Edits,
  // which is the read-then-edit this tool already replaces; the rest are the
  // race, and atomicity alone does not close it. A rename is atomic and two
  // renames are still two.
  //
  // `wx` is O_CREAT|O_EXCL: the create succeeds for exactly one caller. The
  // loser REFUSES rather than waiting, because a wait would make the entry's
  // ordering depend on scheduling and this tool's contract is that it either
  // wrote the entry it was given or changed nothing.
  const LOCK = `${BLOCKED_MD}.lock`;
  // The directory first: the lock lives beside BLOCKED.md, and on a repo where
  // stage 3 has not written one yet there is nothing to live beside. Creating
  // it here is not a side effect on the artifact - `proposals/` is where this
  // tool's output goes, and `mkdirSync` below would make it anyway.
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  try {
    writeFileSync(LOCK, `${process.pid}\n`, { flag: "wx" });
    HELD = LOCK;
  } catch (err) {
    // ONLY EEXIST IS CONTENTION. Every other failure - a read-only mount, a
    // full disk - is its own problem, and reporting it as "another writer
    // holds" sends the reader to look for a process that does not exist. This
    // catch was written bare and did exactly that: the corpus test's first
    // append failed with ENOENT, because `proposals/` did not exist, and was
    // told to wait for a writer.
    if (err?.code !== "EEXIST") {
      refuse(`could not take ${rel(LOCK)}: ${err?.message ?? err}`);
    }
    refuse(
      `another writer holds ${rel(LOCK)}. Two writers appending at once lose one entry silently, ` +
        `so this one is refused rather than raced. Retry when it releases; if no writer is running, ` +
        `the lock is stale from a killed process and deleting it is safe.`
    );
  }
  // Released on every path out. A lock that outlives its holder turns one
  // failed write into every later write failing - measured: the corpus test's
  // fifteenth entry refused on a lock the first had left behind.
  process.on("exit", releaseLock);

  const created = !existsSync(BLOCKED_MD);
  const before = created
    ? "# Blocked sides\n\n" +
      "Central, shared file. Each fenced block is read by `ledger.mjs`; the prose\n" +
      "around it is for a person. Entries are added with\n" +
      "`node .claude/charpilot/blocked.mjs`, which refuses anything ledger.mjs would\n" +
      "later call malformed.\n\n" +
      "Required fields: arm, side, category, killer, proof. Plus fix: when category\n" +
      "is data-blocked. A proof must cite a FACT, not the arm's own line.\n"
    : readFileSync(BLOCKED_MD, "utf8");
  const parsedBefore = parseBlocked(before);

  const holders = parsedBefore.blocks.filter((b) => {
    if (b.fields.arm !== fields.arm) return false;
    const held = sidesOf(b.fields.side ?? "", labels);
    return sides.some((s) => held.includes(s));
  });
  if (holders.length > 1) {
    refuse(
      `${fields.arm} is already ruled by ${holders.length} entries covering these sides, so there is no single entry ` +
        `to replace. Two entries for one side is itself the defect - open ${rel(BLOCKED_MD)} and reconcile them.`
    );
  }
  if (holders.length && !REPLACE) {
    const held = holders[0];
    refuse(
      `${fields.arm} [${sides.join(", ")}] is already ruled at line ${before.slice(0, held.start).split("\n").length} ` +
        `of ${rel(BLOCKED_MD)}:\n${held.body.trim().split("\n").map((l) => `    ${l}`).join("\n")}\n` +
        `  A second entry for the same side would be two rulings of one thing. Pass --replace to overwrite that one, ` +
        `which prints what it removed.`
    );
  }
  if (REPLACE && !holders.length) {
    refuse(
      `--replace names no existing entry: nothing in ${rel(BLOCKED_MD)} rules ${fields.arm} [${sides.join(", ")}]. ` +
        `Drop --replace to append it.`
    );
  }
  if (REPLACE && (heading !== undefined || why !== undefined)) {
    refuse(
      "--replace rewrites the fence and leaves the prose around it exactly where it is, so --heading and --why " +
        "would be written a second time above an argument that already has one. Edit the prose by hand, or append " +
        "a new entry without --replace."
    );
  }
  if (REPLACE) {
    // Replacing a two-side entry with a one-side entry would silently drop the
    // other side's ruling - an unaccounted side appearing in stage 6 with no
    // record of who removed it.
    const held = sidesOf(holders[0].fields.side ?? "", labels);
    const dropped = held.filter((s) => !sides.includes(s));
    if (dropped.length) {
      refuse(
        `--replace would drop the ruling on ${dropped.map((s) => JSON.stringify(s)).join(", ")}: the entry it replaces ` +
          `covers ${held.join(", ")} and this one covers ${sides.join(", ")}. Name every side the old entry named, or ` +
          `edit it by hand.`
      );
    }
  }

  const fence = renderFence(fields);
  let candidate;
  if (REPLACE) {
    candidate = before.slice(0, holders[0].start) + fence + before.slice(holders[0].end);
  } else {
    const head = before.endsWith("\n") || before === "" ? before : `${before}\n`;
    candidate =
      head +
      (heading ? `\n## ${heading}\n` : "") +
      (why ? `\n${why.trim()}\n` : "") +
      `\n${fence}\n`;
  }

  // ---- judged by the reader, before anything is written ------------------
  //
  // Three questions, and the third is the one that makes this a writer worth
  // trusting: does ledger.mjs read back EXACTLY the entry that was asked for,
  // and did nothing else in the file move? A writer that is merely careful can
  // still be wrong about the format. One the format's own parser agrees with
  // cannot be.
  const parsedAfter = parseBlocked(candidate);
  const expected = REPLACE ? parsedBefore.blocks.length : parsedBefore.blocks.length + 1;
  const index = REPLACE ? parsedBefore.blocks.indexOf(holders[0]) : parsedAfter.blocks.length - 1;
  const fail = (why_) => {
    refuse(
      `refusing to write ${rel(BLOCKED_MD)}: ${why_}. Nothing was written. This is a defect in blocked.mjs, not in ` +
        `what you typed - report the arguments that produced it.`
    );
  };
  if (parsedAfter.blocks.length !== expected) {
    fail(`the candidate file parses to ${parsedAfter.blocks.length} fenced block(s) where ${expected} were expected`);
  }
  if (JSON.stringify(parsedAfter.blocks[index]?.fields) !== JSON.stringify(fields)) {
    fail(
      `ledger.mjs reads the new entry back as ${JSON.stringify(parsedAfter.blocks[index]?.fields)}, which is not ` +
        `${JSON.stringify(fields)}`
    );
  }
  const others = (blocks) => blocks.filter((_, i) => i !== index).map((b) => JSON.stringify(b.fields));
  if (JSON.stringify(others(parsedAfter.blocks)) !== JSON.stringify(others(parsedBefore.blocks))) {
    fail("an entry that was already in the file would have changed");
  }
  // Errors the candidate has and the file did not: the entry's own. Pre-existing
  // ones are NOT this tool's to report or to repair - a proof that rotted last
  // week must not block today's ruling, and it is ledger.mjs that reports it.
  const wasAlready = new Map();
  for (const e of parsedBefore.errors) wasAlready.set(e, (wasAlready.get(e) ?? 0) + 1);
  // D56: EXCEPT THE ENTRY BEING REPLACED. Its errors leave with it, so the same
  // refusal written back is introduced, not pre-existing. Without this a
  // --replace of a refused entry by the same entry "succeeded" as a no-op
  // rewrite, every round, and the refusal was never sent back to the agent.
  if (REPLACE) {
    for (const e of (parsedBefore.refused ?? []).find((r) => r.fields === holders[0].fields)?.errors ?? []) {
      const n = wasAlready.get(e) ?? 0;
      if (n) wasAlready.set(e, n - 1);
    }
  }
  const introduced = [];
  for (const e of parsedAfter.errors) {
    const n = wasAlready.get(e) ?? 0;
    if (n) wasAlready.set(e, n - 1);
    // The unread caller set is a fact about out/, not about this entry. It
    // arrives once per `code-callers` entry, so a new one always adds one, and
    // treating it as introduced would refuse every `code-callers` entry this
    // tool could ever write - 11 of the 15 in the corpus it was measured on.
    // ledger.mjs still reports it, to whoever runs the ledger.
    else if (!e.includes(UNREAD_CALLER_SET)) introduced.push(e);
  }
  if (introduced.length) {
    refuse(
      `this entry is one ledger.mjs would report as malformed, so it is not written:\n` +
        introduced.map((e) => `    ${e}`).join("\n") +
        `\n  ${rel(BLOCKED_MD)} is unchanged.`
    );
  }

  // ---- the write ---------------------------------------------------------
  //
  // Temp file, then rename. A truncated BLOCKED.md is the worst artifact this
  // tool could produce: the entries it loses look exactly like sides nobody
  // ever ruled, and stage 6 reports them as unaccounted work.
  try {
    mkdirSync(PROPOSALS_DIR, { recursive: true });
    writeFileSync(TMP, candidate);
    const onDisk = readFileSync(TMP, "utf8");
    if (onDisk !== candidate) throw new Error("the bytes read back from the temp file are not the bytes written");
    renameSync(TMP, BLOCKED_MD);
    // The entry is in. Nothing after this needs the lock, and the next writer
    // may be waiting on it.
    releaseLock();
  } catch (err) {
    try {
      if (existsSync(TMP)) unlinkSync(TMP);
    } catch {
      // Reported below rather than thrown over the top of the real failure.
    }
    refuse(
      `could not write ${rel(BLOCKED_MD)}: ${err.message}. The file is unchanged and no partial entry was left ` +
        `behind${existsSync(TMP) ? `, but ${rel(TMP)} could not be removed - delete it before retrying` : ""}.`
    );
  }

  const replaced = REPLACE ? holders[0].body.trim() : null;
  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: rel(BLOCKED_MD),
          action: REPLACE ? "replaced" : "appended",
          created,
          entry: fields,
          sides,
          replaced: replaced ? parsedBefore.blocks[index].fields : null,
          entries: parsedAfter.entries.length,
        },
        null,
        2
      )}\n`
    );
    return;
  }
  if (created) process.stdout.write(`\n· ${rel(BLOCKED_MD)} did not exist; it was created with its header.\n`);
  if (replaced) {
    // Loudly. An overwrite nobody was told about is indistinguishable from a
    // ruling that was never made.
    process.stdout.write(
      `\n! --replace REMOVED this entry:\n${replaced.split("\n").map((l) => `    ${l}`).join("\n")}\n`
    );
  }
  process.stdout.write(summarise(fields, parsedAfter.entries.length, BLOCKED_MD));
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead. `import.meta.main` needs
// Node 24; on an older runtime it is undefined, and a bare truthiness test
// would turn this into a silent no-op - a tool that runs and writes nothing
// while reporting success is worse than one that crashes.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}
