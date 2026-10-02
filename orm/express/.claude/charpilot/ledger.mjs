#!/usr/bin/env node
/**
 * The exit condition, made checkable.
 *
 * Stage 5's rule is "every uncovered side has an input, OR a written reason why
 * it cannot". Until now that was prose in BLOCKED.md plus a count in a report —
 * which is exactly the shape of claim this pilot exists to stop accepting.
 *
 * Reconciles three sets at SIDE level:
 *   proposed  - a side named in some proposal's `reaches`
 *   blocked   - a side declared in a fenced `blocked` block in BLOCKED.md
 *   uncovered - every instrumented uncovered side in the worklist
 *
 * Fails on: an unaccounted side, a side both proposed and blocked that the
 * measurement does not decide (resolveDoubleClaim), a blocked
 * side that is not actually uncovered, or a proof pointing at a missing file.
 *
 *   node .claude/charpilot/ledger.mjs [--lane unit|integration]
 *
 * A blocked entry is a fenced block tagged `blocked` containing:
 *   arm: <armId>   side: <side[,side]>   category: <...>   proof: <file:line>
 *   killer: <where the constraint lives>
 *   fix: <how it could be unblocked>   (required for data-blocked)
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { BEHAVIOUR_JSON, CORPUS_REL, OUT_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
import { loadProposals } from "./validate.mjs";

const ARGV = process.argv.slice(2);
const LANE = ARGV.includes("--lane") ? ARGV[ARGV.indexOf("--lane") + 1] : undefined;
// The findings as one JSON document on stdout, with the same exit code. For a
// step that has to ROUTE on what the ledger found (repair turns an undecided
// double claim into a question), because routing on the prose below breaks the
// moment it is reworded.
const JSON_OUT = ARGV.includes("--json");

// data-blocked : reachable in principle; a seed or a stub away. Recoverable.
// code-dead    : no input reaches it in any environment. A DEFECT, not a gap.
// needs-seam   : requires a production change (an export, a reset hook).
export const CATEGORIES = new Set(["data-blocked", "code-dead", "needs-seam"]);

// `category` says WHETHER a side is reachable. `killer` says WHERE the
// constraint lives, which is what decides how the entry goes false:
//
//   code-local    inside the arm's own function - cannot rot unseen
//   code-callers  an enumerated caller set - ADDING a caller re-opens it silently
//   config        an env / Zod boot-schema value
//   schema        a column's nullability in schema.prisma
//   dependency    third-party behaviour - an npm bump falsifies it
//
// The distinction is not cosmetic. Five entries in this file were falsified
// once already, all by data that arrived after the ruling, and a flat
// `code-dead` label gave no way to aim the re-check.
export const KILLERS = new Set(["code-local", "code-callers", "config", "schema", "dependency"]);

/**
 * The one error that is about the ARTIFACTS, not about the entry.
 *
 * `code-callers` can only be judged against a caller set, and that comes from
 * out/dead-exports.json joined to out/scan.json. Absent them, the ledger says
 * so and stops — right for a READER, whose job is to report that the artifacts
 * are stale.
 *
 * A WRITER must not refuse on it. blocked.mjs judges a candidate by whether it
 * introduces an error the file did not already have, and this error arrives
 * once per `code-callers` entry, so a new entry always adds one and the writer
 * would refuse every `code-callers` entry ever written — 11 of the 15 in the
 * corpus. Exported as one string so the reader's message and the writer's
 * exemption cannot drift apart.
 */
export const UNREAD_CALLER_SET =
  "killer `code-callers` cannot be checked - the caller set is unread.";
const FENCE = new RegExp("```blocked\\n([\\s\\S]*?)```", "g");

/**
 * D56 — A PROOF IN A FILE THE PIPELINE WRITES IS NOT A PROOF.
 *
 * qode-itl-be, run 20260926T165924Z: 21 entries cited
 * `.claude/charpilot/out/behaviour.json:<line>`, the recorder's own skip of the
 * side ("trigger:decorator-metadata - a framework fires this, and the proposal
 * supplies no invoke of its own"). blocked.mjs accepted each one, because on the
 * day it was written that line held the skip. The next recording rewrote the
 * file, four of the cited lines became `],`, and the ledger then refused them as
 * "a location, not a fact" and exited 1 at the end of the run. The other 17 were
 * the same mistake still waiting for its re-record. Worse than the drift: what
 * they cited was the recorder saying it had not tried, which is a statement
 * about the pipeline, never about the code - and the sides were reachable.
 * pricing-ms is the same defect one directory up: its BLOCKED.md cites
 * `.claude/charpilot/record.mjs:1223`, a line of a charpilot TOOL, so any edit
 * to the recorder moves it and the four sides it rules fall back to open.
 *
 * So a proof under any of these is refused by the parser, which means by the
 * writer too (blocked.mjs judges a candidate with this parser): everything
 * under .claude/charpilot/ - the artifacts, the proposals and the installed
 * tools themselves - the emitted corpus, and the answers directory the agent
 * submits into (steps/handover.mjs's ANSWERS_DIRNAME). An entry already on
 * disk that cites one is refused on the next read, and its side is open and
 * dealt again (refusedBySide) - never dropped, never a tool failure.
 */
export const GENERATED_PROOF_DIRS = Object.freeze([".claude/charpilot/", `${CORPUS_REL}/`, "charpilot-answers/"]);
export const GENERATED_PROOF =
  "cites a generated file - a file the pipeline owns (an artifact it writes and rewrites, or one of its own tools), " +
  "so its line numbers move with every re-record or toolset change, and what it says is about the pipeline, not the " +
  "code. Cite the source line, not a generated file: the repo's own line that makes the side impossible.";
const isGeneratedProof = (file) => {
  const f = String(file ?? "").replace(/^\.\//, "");
  return GENERATED_PROOF_DIRS.some((d) => f.startsWith(d));
};

const key = (armId, side) => `${armId} ${side}`;

/** The proposal id out of loadProposed's `file::id` claim. A file name carries no `::`. */
const idOfClaim = (claim) => {
  const at = String(claim).indexOf("::");
  return at === -1 ? String(claim) : String(claim).slice(at + 2);
};

/**
 * A side label is the operand's SOURCE TEXT for a binary-expr, so it can contain
 * commas — `{ content: [], stop_reason: "error", }` is one label, not three.
 * Splitting on "," corrupts exactly those. So: match the whole value against the
 * arm's real labels first, and only fall back to splitting when it is not one.
 */
export function sidesOf(value, validLabels) {
  const raw = Array.isArray(value) ? value.map(String) : [String(value)];
  const out = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (validLabels.has(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((x) => validLabels.has(x))) out.push(...parts);
    else out.push(trimmed);
  }
  return out;
}

/**
 * D59 — THE ONE DEFINITION OF AN ARM'S SIDE LABELS, for every reader of a
 * `side:` field.
 *
 * `sidesOf` splits `side: then,else` only when every part is a label of the
 * arm, so what it returns is decided by WHICH labels the caller hands it. Four
 * readers each built their own: derive, the ledger and repair from worklist.json
 * (`sides` plus `uncoveredSides`), and coverage.mjs `readBlockedBySide` from
 * `stillUncovered` alone - the sides the measurement still has open. So the
 * moment ONE side of a multi-side entry was covered, coverage.mjs's label set
 * for that arm lost it, `then,else` stopped splitting, and the OTHER side was
 * ruled `open` ("no row covers it and no reason is written for it") while derive
 * counted it as having a written reason and the ledger as accounted for. Nothing
 * asked about it again, and the run ended partial with that side stranded.
 * sourcing-ms run 20260926T222646Z: `search-debug.service.ts#109:if:0 [else]`,
 * after `[then]` was covered by `arg0-of-hits-map-575-if-0`; the same shape on
 * #109, #86, #113, #119, #121, #122 and #123.
 *
 * The labels are the ARM's, never the measurement's: the work list's `sides`
 * and `uncoveredSides` and, where a caller has it, the scan's own `labels` for
 * the arm. A covered side of a multi-side entry is still one of the arm's
 * labels, so the entry still splits - the covered side simply matches no
 * uncovered side and drops out, and the uncovered ones keep the entry's reason
 * in every reader alike. `extra` is any caller-held rows `{armId, side}` (the
 * old coverage.mjs source), merged in so a reader with no work list on disk
 * loses nothing it had.
 */
export function armSideLabels({ worklist = null, scan = null, extra = [] } = {}) {
  const out = new Map();
  const add = (armId, labels) => {
    if (!armId) return;
    if (!out.has(armId)) out.set(armId, new Set());
    const set = out.get(armId);
    for (const l of labels ?? []) if (typeof l === "string") set.add(l);
  };
  for (const i of worklist?.items ?? []) add(i?.armId, [...(i?.sides ?? []), ...(i?.uncoveredSides ?? [])]);
  for (const f of scan?.functions ?? []) for (const a of f?.arms?.list ?? []) add(a?.armId, a?.labels);
  for (const g of scan?.moduleScopeArms ?? []) for (const a of g?.list ?? []) add(a?.armId, a?.labels);
  for (const r of extra ?? []) add(r?.armId, [r?.side]);
  return out;
}

export function loadProposed(labelsByArm) {
  const proposed = new Map();
  // READ THROUGH THE ONE READER, because a second parser is the bug.
  //
  // `loadProposals`' own docstring says why two readers is the defect: they
  // were "identical by luck rather than by construction", and an answer one
  // stage accepts and another drops is this pipeline's most expensive failure
  // mode. This was the fourth copy. It guarded the DIRECTORY — no proposals
  // directory means stage 3 has not started, a legitimate state on a freshly
  // onboarded repo, and throwing here made the gate's `ledger` check report a
  // stack trace tail ("Node.js v24.14.1") where the next action belongs, and
  // the shared reader guards it the same way — but it parsed every file bare, so ONE unreadable proposal
  // produced exactly that stack trace again, and `p.reaches` on a null row
  // threw the same way. The shared reader keeps the guard, names the file it
  // could not read, and hands back only rows that are objects.
  const { proposals, malformed } = loadProposals(PROPOSALS_DIR);
  // NEVER SILENTLY: this function decides which sides are ACCOUNTED FOR, so a
  // file it did not read is a side that reads as unproposed when it may not be.
  for (const m of malformed) {
    process.stderr.write(
      `· ledger: ${m.file} is not a readable proposal document (${m.message}) — ` +
        "the sides it claims are counted as unaccounted until it is fixed\n"
    );
  }
  for (const p of proposals) {
    for (const [armId, sides] of Object.entries(p.reaches ?? {})) {
      for (const side of sidesOf(sides, labelsByArm.get(armId) ?? new Set())) {
        const k = key(armId, side);
        if (!proposed.has(k)) proposed.set(k, []);
        proposed.get(k).push(`${p._file}::${p.id}`);
      }
    }
  }
  return proposed;
}

/**
 * Every export with an EMPTY caller set, as line spans.
 *
 * `pilot:deadcode` already asks this exact question and writes the answer to
 * out/dead-exports.json: it keeps an export only when `srcRefs.length === 0`,
 * i.e. `findReferencesAsNodes` found no reference anywhere under `src/`. What
 * that artifact does not carry is where the declaration ENDS, so the span comes
 * from the scan, which records `endLine` per function - joined on file and
 * declaration line. A dead export the scan holds no function for (a plain
 * exported object, say) yields no span and therefore no verdict: this is a
 * check, not a guess.
 *
 * Verified on run 20260915T033521Z: 26 dead exports, 25 with a span, and all 9
 * `code-callers` entries in that run's BLOCKED.md fall inside one.
 */
export function callerlessExports(deadExports, scan) {
  const endByDecl = new Map((scan?.functions ?? []).map((f) => [`${f.file}:${f.line}`, f.endLine]));
  const spans = [];
  for (const d of deadExports?.dead ?? []) {
    const end = endByDecl.get(`${d.file}:${d.line}`);
    if (end === undefined) continue;
    spans.push({ file: d.file, name: d.name, start: d.line, end, referencedOnlyByTests: !!d.referencedOnlyByTests });
  }
  return spans;
}

/** The callerless export an armId sits inside, or undefined. */
export function callerlessHost(armId, spans) {
  const file = String(armId).split("#")[0];
  const line = Number(String(armId).split("#")[1]?.split(":")[0]);
  if (!Number.isInteger(line)) return undefined;
  return spans.find((s) => s.file === file && line >= s.start && line <= s.end);
}

/**
 * The blocked entries in a BLOCKED.md, and everything wrong with them.
 *
 * `callerless` is the span list from `callerlessExports`, or `null` when
 * out/dead-exports.json has not been written - the two are different answers
 * and must not read alike.
 */
export function blockedEntries(text, callerless = null) {
  const entries = [];
  // The entries this parser finds NOTHING wrong with. `entries` keeps every
  // block that names an arm and a side, well-formed or not, because the ledger
  // reports the errors beside them; a reader that treats an entry as a
  // reason (coverage.mjs's `unreachable` ruling) must read this list instead.
  const accepted = [];
  // D56: the entries it DID find something wrong with, each with its own errors.
  const refused = [];
  const errors = [];
  const blocks = [];

  // `fence`, not `m`: the field loop below declares its own `m`, and a match
  // object shadowed halfway through the block it is read at the end of is the
  // kind of quiet confusion this file is not for.
  for (const fence of text.matchAll(FENCE)) {
    const body = fence[1];
    const errorsBefore = errors.length;
    const fields = {};
    for (const line of body.split("\n")) {
      const m = line.match(/^\s*([a-z]+)\s*:\s*(.+?)\s*$/);
      if (m) fields[m[1]] = m[2];
    }
    const where = `blocked(${fields.arm ?? "?"} / ${fields.side ?? "?"})`;

    for (const required of ["arm", "side", "category", "proof", "killer"]) {
      if (!fields[required]) errors.push(`${where}: missing \`${required}\``);
    }
    if (fields.category && !CATEGORIES.has(fields.category)) {
      errors.push(`${where}: category "${fields.category}" is not one of ${[...CATEGORIES].join(" | ")}`);
    }
    if (fields.killer && !KILLERS.has(fields.killer)) {
      errors.push(`${where}: killer "${fields.killer}" is not one of ${[...KILLERS].join(" | ")}`);
    }
    // `code-callers` asserts a CALLER SET: "unreachable given the argument shape
    // every current caller passes". An export with no callers has no such set,
    // and the claim inverts - with no call site fixing the arguments, a
    // characterization test calls the export directly and may pass anything, so
    // the side is reachable rather than dead. Membership in KILLERS was the only
    // thing checked here, so the inverted claim passed.
    //
    // Measured, run 20260915T033521Z on location-ms: 9 sides blocked
    // `code-callers` against exports with ZERO references in src/ per
    // pilot:deadcode - and that run's own report notes the repo's pre-existing
    // unit tests already reach several of them by calling the export directly.
    // Run 20260914T080742Z wrote 13 `code-dead` entries at commit e04b295; this
    // run wrote 22 at the same commit. Identical source, 9 sides of coverage
    // given away by a killer that cannot be true.
    if (fields.killer === "code-callers" && fields.arm) {
      if (callerless === null) {
        errors.push(
          `${where}: ${UNREAD_CALLER_SET} ` +
            `out/dead-exports.json and out/scan.json are what enumerate it; ` +
            `run npm run pilot:scan && npm run pilot:deadcode.`
        );
      } else {
        const host = callerlessHost(fields.arm, callerless);
        if (host) {
          errors.push(
            `${where}: killer \`code-callers\`, but the caller set is EMPTY - \`${host.name}\` ` +
              `(${host.file}:${host.start}) has zero references in src/ per out/dead-exports.json` +
              `${host.referencedOnlyByTests ? ", only tests call it" : ""}. An empty caller set constrains ` +
              `nothing: with no call site fixing the argument shape, a characterization test calls the export ` +
              `directly and can pass anything, so this side is reachable. Either name the real killer or write the input.`
          );
        }
      }
    }
    if (fields.category === "data-blocked" && !fields.fix) {
      errors.push(`${where}: a data-blocked side must say how it could be unblocked (\`fix\`)`);
    }
    if (fields.proof && isGeneratedProof(fields.proof.split(":")[0])) {
      // D56: refused before anything reads the line, because the line is not
      // the point - it moves on the next recording either way.
      errors.push(`${where}: proof ${fields.proof} ${GENERATED_PROOF}`);
    } else if (fields.proof) {
      const file = fields.proof.split(":")[0];
      const proofLineNo = Number(fields.proof.split(":")[1]);
      const abs = join(REPO_ROOT, file);
      if (existsSync(abs) && Number.isInteger(proofLineNo)) {
        const src = readFileSync(abs, "utf8").split("\n");
        const text = (src[proofLineNo - 1] ?? "").trim();
        if (!text) {
          errors.push(
            `${where}: proof ${fields.proof} points at a blank or out-of-range line`
          );
        } else if (/^[)}\]]+[;,]?$/.test(text) || /^\} catch \(/.test(text)) {
          // A closing brace or the catch clause the arm sits in is a location,
          // not evidence. This check exists because four entries shipped citing
          // `} catch (err) {` and passed.
          errors.push(
            `${where}: proof ${fields.proof} cites "${text}" - a location, not a fact. Cite the line that makes the side impossible.`
          );
        }
      }
      if (file.includes("/") && !existsSync(join(REPO_ROOT, file))) {
        errors.push(`${where}: proof points at "${file}", which does not exist`);
      }
      // A proof must not be the arm citing itself. `anthropicAIModel.ts#680`
      // was blocked with `proof: anthropicAIModel.ts:680` - a restatement, not
      // an argument - and the side turned out to be taken by roughly 214 of
      // 17,136 recorded production calls. A suppression whose evidence is
      // itself cannot be checked by anyone.
      const armFile = String(fields.arm ?? "").split("#")[0];
      const armLine = String(fields.arm ?? "").split("#")[1]?.split(":")[0];
      const proofLine = fields.proof.split(":")[1];
      if (file === armFile && armLine && proofLine === armLine) {
        errors.push(
          `${where}: proof cites the arm's own line (${fields.proof}) - that is a restatement, not evidence`
        );
      }
    }
    if (fields.arm && fields.side) {
      entries.push(fields);
      if (errors.length === errorsBefore) accepted.push(fields);
      // D56: the entry beside ITS OWN refusals, so a reader can put the
      // ledger's sentence on the side it is about rather than on the run.
      else refused.push({ fields, errors: errors.slice(errorsBefore) });
    }
    blocks.push({ fields, body, start: fence.index, end: fence.index + fence[0].length });
  }

  return { entries, accepted, refused, errors, blocks };
}

/**
 * D56 — A REFUSED DECLARATION IS AN ANSWER THE AGENT HAS TO GIVE AGAIN.
 *
 * Every side a written entry names that this parser refused, keyed `arm\0side`,
 * with the refusal in the ledger's own words: `{ entry, why, saidBy }`.
 *
 * The side is NOT ruled - coverage.mjs rules only `accepted` entries - and it
 * is not a tool failure either: the ledger did its job. Until D56 the three
 * readers disagreed about what it was. coverage.json ruled it `open` with "no
 * reason is written for it", derive and repair counted it as declared (they
 * read `entries`), so repair asked nothing about it, the ledger exited 1, and
 * the walk ruled the step a tool DEFECT (qode-itl-be, run 20260926T165924Z,
 * `failed` at 98.3% with 107 sides ruled). Now the side is open again and the
 * refusal travels with it as the feedback for the next ask.
 *
 * An entry refused ONLY for UNREAD_CALLER_SET is not here: that error is about
 * the artifacts, not the entry (see its docblock), and reopening a side because
 * out/dead-exports.json was not written yet would undo a correct ruling.
 */
export function refusedBySide(parsed, labelsByArm = new Map()) {
  const out = new Map();
  for (const { fields, errors } of parsed?.refused ?? []) {
    const own = errors.filter((e) => !e.includes(UNREAD_CALLER_SET));
    if (!own.length) continue;
    // Without the `blocked(arm / side): ` prefix, which the side it is filed
    // under already says - cut by its exact text, since a label can hold "): ".
    const where = `blocked(${fields.arm ?? "?"} / ${fields.side ?? "?"}): `;
    const why = own.map((e) => (e.startsWith(where) ? e.slice(where.length) : e)).join(" · ");
    for (const side of sidesOf(fields.side, labelsByArm.get(fields.arm) ?? new Set())) {
      out.set(`${fields.arm}\u0000${side}`, { entry: fields, arm: fields.arm, side, why, saidBy: "ledger.mjs" });
    }
  }
  return out;
}

/** `refusedBySide` over the BLOCKED.md on disk. Never throws: no file, or one that will not read, refuses nothing. */
export function refusedDeclarations(proposalsDir = PROPOSALS_DIR, labelsByArm = new Map()) {
  const path = join(proposalsDir, "BLOCKED.md");
  if (!existsSync(path)) return new Map();
  try {
    return refusedBySide(parseBlocked(readFileSync(path, "utf8")), labelsByArm);
  } catch {
    return new Map();
  }
}

/**
 * D56 — THE DECLARED MAP WITHOUT THE ENTRIES THE LEDGER REFUSED.
 *
 * derive's `declaredSides` reads every entry that names an arm and a side,
 * well-formed or not - right for "has somebody written about this side", and
 * wrong for "is this side answered". Read that way here, a refused entry made
 * its side look ruled: `openSides` left it out, the closing round ran the
 * ledger, the ledger exited 1 on the entry, and nothing was asked. qode-itl-be,
 * run 20260926T165924Z: four sides, `failed` with "step repair (ledger.mjs)".
 * `refusals` is `refusedDeclarations`, keyed as this map is (`arm\0side`).
 * Here, beside the rule, because derive and repair both read it and neither
 * may import the other's copy.
 */
export function withoutRefused(declared, refusals = new Map()) {
  if (!refusals.size) return declared;
  const out = new Map();
  for (const [k, e] of declared) if (!refusals.has(k)) out.set(k, e);
  return out;
}

/** The sentence a reopened side's question leads with: the ledger's refusal, verbatim. */
export function refusedDeclarationNote(r) {
  return (
    `THE LAST ANSWER FOR THIS SIDE WAS REFUSED. BLOCKED.md rules it ${r.entry?.category ?? "?"} with proof ` +
    `${r.entry?.proof ?? "absent"}, and ${r.saidBy ?? "ledger.mjs"} will not accept that entry: ${r.why} So the side ` +
    `is not ruled, it is open again, and this is the ask again. Either land an input for it (the question below), or ` +
    `write the declaration again with a proof that is a SOURCE line - never a file under ` +
    `${GENERATED_PROOF_DIRS.join(", ")}, which the pipeline rewrites - and it replaces the refused entry.`
  );
}

/** An item for a reopened side, with the refusal leading its question and carried in its context. */
export function withRefusedDeclaration(r, it) {
  if (!r || !it) return it;
  return { ...it, question: `${refusedDeclarationNote(r)} ${it.question}`, context: { ...it.context, refusedDeclaration: refusedDeclarationContext(r) } };
}

/** The refusal as the item carries it, for a reader that routes rather than reads. */
export function refusedDeclarationContext(r) {
  return {
    side: `${r.arm} [${r.side}]`,
    entry: {
      category: r.entry?.category ?? null,
      killer: r.entry?.killer ?? null,
      proof: r.entry?.proof ?? null,
    },
    why: r.why,
    saidBy: r.saidBy ?? "ledger.mjs",
    counted: "open - a refused declaration rules nothing",
  };
}

/**
 * The caller set from the artifacts on disk, or null when they are not there.
 *
 * Factored out of `loadBlocked` because a WRITER needs the same answer the
 * reader gets. `blockedEntries` treats `null` as "unread" and reports every
 * `code-callers` entry as uncheckable — correct for a reader that genuinely has
 * no artifact, and fatal for a writer, which refuses to add any entry that
 * introduces an error the file did not already have. A writer calling the
 * parser without this would therefore be unable to write a `code-callers`
 * entry at all: 11 of the 15 entries in the corpus this was measured against.
 */
function readCallerless() {
  const deadExportsPath = join(OUT_DIR, "dead-exports.json");
  return existsSync(deadExportsPath) && existsSync(SCAN_JSON)
    ? callerlessExports(
        JSON.parse(readFileSync(deadExportsPath, "utf8")),
        JSON.parse(readFileSync(SCAN_JSON, "utf8"))
      )
    : null;
}

/**
 * The format, over TEXT rather than over a path, with the caller set resolved.
 *
 * This is what a writer judges itself by: blocked.mjs renders a candidate file,
 * runs it through this, and refuses unless the parse says the entry is
 * well-formed and nothing already in the file moved. Same reason worklist.mjs
 * imports `SKELETON_TODO` from the tool that rejects it — a writer carrying its
 * own copy of the format is a writer that can drift from the checker, and then
 * the artifact reads as checked and is not.
 *
 * The caller set defaults to whatever is on disk rather than to `null`, so the
 * writer is held to the same `code-callers` rule as `pilot:ledger`. Pass it
 * explicitly to judge text against a caller set other than this repo's.
 */
export function parseBlocked(source, callerless = readCallerless()) {
  return blockedEntries(source, callerless);
}

/**
 * `blockedEntries` over the files on disk.
 *
 * NO FILE IS NO ENTRIES, NOT A MALFORMED ONE. A run whose every side is covered
 * never needs a reason written for one, so nothing ever creates BLOCKED.md, and
 * this used to report it "missing" as a malformed entry: ledger.mjs exited 1,
 * repair logged that as a pipeline defect, and report.mjs ruled the run
 * `failed`. The one-packet bench (plan 20) covered 8 of 8 sides with 8 of 8
 * claims verified and still could not succeed. `benchguard.mjs` already seeds
 * an empty BLOCKED.md for the same reason: "an empty BLOCKED.md is the honest
 * starting state". A side that DOES need a reason still fails the ledger, as
 * UNACCOUNTED.
 */
export function loadBlocked(path = join(PROPOSALS_DIR, "BLOCKED.md")) {
  if (!existsSync(path)) return { entries: [], errors: [] };
  return blockedEntries(readFileSync(path, "utf8"), readCallerless());
}

/**
 * A SIDE CLAIMED BY A PROPOSAL AND BY A BLOCKED ENTRY, DECIDED BY MEASUREMENT.
 *
 * Only one of the two can be true, and usually the run has already measured
 * which one. notification-ms, 25 September: `src/utils/logger.ts#8:if:0
 * [then]` had a proposal (arg0-of-format-8-if-0) that record.mjs never ran
 * ("trigger:log-call - a framework fires this, and the proposal supplies no
 * invoke of its own"), and a `needs-seam` entry written from that same
 * refusal. coverage.json had the side uncovered, 423 of 428 sides were hit and
 * every open side was ruled, and the ledger still exited 1 on the pair. Repair
 * logged that as a tool defect with nothing to ask, so the run could not
 * close. The proposal could not be taken back either: it is its row's only
 * claim, and propose.mjs refuses that withdrawal as a row deletion.
 *
 * So the measurement decides, when it can:
 *   - coverage.json VERIFIED the side: the input is true and wins. The
 *     entry is superseded and should be deleted. A code-dead entry is still
 *     failed below, as contradicted.
 *   - every proposal claiming the side was SKIPPED by record.mjs (it produced
 *     no row, for a reason of the row's own, not a pipeline defect), AND
 *     coverage.json still has the side uncovered: none of them is an input,
 *     and the entry's reason stands.
 *   - every proposal claiming the side is either SKIPPED as above or WITHHELD
 *     from the suite: it recorded, but its emitted test is quarantined
 *     (`it.skip`), so coverage.json lists the claim under `unmeasurable` for
 *     this very side and the suite never enters the arm. AND the side is still
 *     uncovered. The suite the run delivers carries no input for the side
 *     either way, so the entry's reason stands. email-centralization-ms, the
 *     evening run of 25 September: `_isFromRecruiter` (sendEmail.service.ts
 *     #678/#679) recorded, cigate withheld both tests because the repo's own
 *     test env answers the other way, the agent wrote a needs-seam entry
 *     citing that env, coverage.json ruled both sides unreachable from the
 *     entry, and the ledger alone still exited 1 on the pair.
 *   - anything else (no measurement, a row that ran and whose test ran but
 *     did not verify, a skip or a withholding the pipeline caused): still a
 *     double claim, and still a failure. The message says which two claims to
 *     choose between, and `repair` hands that choice to the agent.
 *
 * `claims` are loadProposed's `file::id` strings. `evidence` is
 * doubleClaimEvidence's, or null.
 */
export function resolveDoubleClaim(k, claims, evidence) {
  if (!evidence) {
    return {
      winner: null,
      why: `only one can be true: ${claims.join(", ")} claims an input and the blocked entry a reason, and there is no measurement on disk (coverage.json, behaviour.json) to decide it - drop one of them`,
    };
  }
  if (evidence.verified?.has(k)) {
    return {
      winner: "proposal",
      why: `coverage.json verified it for ${claims.join(", ")}, so the input is true and supersedes the blocked entry - delete the entry`,
    };
  }
  const ownReason = (r) => typeof r === "string" && !/^pipeline defect/i.test(r);
  // Why each claim is not an input the suite carries, or null when it may be.
  const notAnInput = claims.map((c) => {
    const skip = evidence.skipped?.get(c);
    if (ownReason(skip)) return { claim: c, how: "skipped", why: skip };
    // Anywhere in the sentence, not only at its start: coverage.mjs prefixes
    // the quarantine's own reason with what a withheld test means.
    const withheld = evidence.withheld?.get(`${idOfClaim(c)}\u0000${k}`);
    if (typeof withheld === "string" && !/pipeline defect/i.test(withheld)) return { claim: c, how: "withheld", why: withheld };
    return null;
  });
  if (claims.length && notAnInput.every(Boolean) && evidence.stillUncovered?.has(k)) {
    if (notAnInput.every((n) => n.how === "skipped")) {
      return {
        winner: "blocked",
        why:
          `${claims.join(", ")} never recorded (record.mjs skipped it: "${notAnInput[0].why.slice(0, 160)}") and coverage.json has the ` +
          "side uncovered, so no input claims it and the blocked entry's reason stands",
      };
    }
    const said = notAnInput
      .map((n) => (n.how === "skipped" ? `${n.claim} never recorded (record.mjs skipped it)` : `${n.claim} recorded but its emitted test is withheld from the suite`))
      .join("; ");
    return {
      winner: "blocked",
      why:
        `${said} ("${notAnInput[0].why.slice(0, 160)}"), and coverage.json has the side uncovered, so the suite carries no ` +
        "input for it and the blocked entry's reason stands",
    };
  }
  return {
    winner: null,
    why: `only one can be true: ${claims.join(", ")} claims an input and the blocked entry a reason, and nothing measured says which - drop one of them`,
  };
}

/** What resolveDoubleClaim reads: coverage.json's verdicts and behaviour.json's skips. Null when either is absent or the suite was red. */
export function doubleClaimEvidence(coveragePath = join(OUT_DIR, "coverage.json"), behaviourPath = BEHAVIOUR_JSON) {
  if (!existsSync(coveragePath) || !existsSync(behaviourPath)) return null;
  try {
    const cov = JSON.parse(readFileSync(coveragePath, "utf8"));
    const beh = JSON.parse(readFileSync(behaviourPath, "utf8"));
    // A measurement taken over a red suite decides nothing: coverage.mjs says
    // its numbers are an overstatement then.
    if (cov.refused === "suite-did-not-pass" || cov.suitePassed === false) return null;
    return {
      // A measurement that ran: a side it does not list as uncovered is hit.
      measured: Boolean(cov.totals) && Array.isArray(cov.stillUncovered),
      verified: new Set((cov.verified ?? []).map((v) => key(v.armId, v.side))),
      stillUncovered: new Set((cov.stillUncovered ?? []).map((v) => key(v.armId, v.side))),
      skipped: new Map((beh.skipped ?? []).map((s) => [`${s.file}::${s.id}`, String(s.reason ?? "")])),
      // A claim coverage.mjs could not measure FOR THIS SIDE because the row's
      // emitted test is quarantined (`it.skip`). Only entries that name a
      // side: the others (an arm the join does not know, a label that is not
      // a side) are about the claim's spelling, not about the suite.
      withheld: new Map(
        (cov.unmeasurable ?? [])
          .filter((u) => u?.id && u.armId && typeof u.side === "string")
          .map((u) => [`${u.id}\u0000${key(u.armId, u.side)}`, String(u.why ?? "")])
      ),
    };
  } catch {
    return null;
  }
}

function main() {
  const worklist = JSON.parse(readFileSync(WORKLIST_JSON, "utf8"));
  // D59: the shared definition, so this and coverage.mjs split a multi-side
  // entry the same way.
  const labelsByArm = armSideLabels({ worklist });
  const proposed = loadProposed(labelsByArm);
  const { entries, refused = [], errors } = loadBlocked();

  // ---- a suppression measurement can contradict --------------------------
  //
  // `code-dead` asserts no input reaches a side in any environment. Stage 4
  // now records, per row, which arms that row's subject actually moved - so
  // the assertion is checkable, and it has been wrong: two entries
  // (anthropicAIModel.ts#680/#681, "the nullish fallback cannot be taken")
  // were reached by a recorded row, and `usage_log` puts the suppressed side
  // at roughly 214 of 17,136 real calls.
  //
  // 2 of 25 entries false is an 8% false-suppression rate on the artifact that
  // defines "done". A suppression nobody can contradict is indistinguishable
  // from one that is wrong, so this reads the measurement rather than trusting
  // the prose.
  // Side -> the recorded rows that moved it.
  const movedSides = new Map();
  if (existsSync(BEHAVIOUR_JSON)) {
    try {
      const beh = JSON.parse(readFileSync(BEHAVIOUR_JSON, "utf8"));
      for (const row of beh.rows ?? []) {
        for (const m of row.armsMoved ?? []) {
          for (const side of m.sides ?? (m.side ? [m.side] : [])) {
            const k = `${m.armId}\u0000${side}`;
            if (!movedSides.has(k)) movedSides.set(k, []);
            if (row.id && !movedSides.get(k).some((r) => r.id === row.id)) movedSides.get(k).push({ id: row.id, file: row.file ?? null });
          }
        }
      }
    } catch {
      errors.push("behaviour.json could not be read, so no blocked side was checked against measurement");
    }
  }
  const contradicted = [];
  // A CONTRADICTED ENTRY WHOSE SIDE THE MEASUREMENT COVERS IS DECIDED: the
  // measurement is authoritative, the side is covered, and the entry is simply
  // wrong. It is reported as superseded (delete it) and the side is counted as
  // covered, never as ruled. cv-parsing-ms, the night run of 25 September:
  // `parseDataMappingUtil.ts#84:binary-expr:0 [!a.fromDate]` was ruled
  // code-dead, two recorded rows moved it, coverage.json had it hit (775/804
  // sides, 0 open), and this still exited 1 - repair asked nothing and the run
  // ended `failed`. A contradicted entry whose side is STILL uncovered is left
  // exactly as it was: a failure, which repair hands to the agent.
  const superseded = [];
  const evidence = doubleClaimEvidence();
  const coveredByMeasurement = (k) => Boolean(evidence?.measured) && !evidence.stillUncovered.has(k);

  const blocked = new Map();
  // The side each key was made from: `key` joins arm and side with a space,
  // and a side label can hold spaces, so it is not split back apart.
  const sideOfBlocked = new Map();
  for (const e of entries) {
    for (const side of sidesOf(e.side, labelsByArm.get(e.arm) ?? new Set())) {
      const contra = e.category === "code-dead" && movedSides.has(`${e.arm}\u0000${side}`);
      const movedBy = contra ? movedSides.get(`${e.arm}\u0000${side}`) : [];
      if (contra && coveredByMeasurement(key(e.arm, side))) {
        superseded.push({ arm: e.arm, side, proof: e.proof ?? null, category: e.category, movedBy });
        continue;
      }
      blocked.set(key(e.arm, side), e);
      sideOfBlocked.set(key(e.arm, side), side);
      if (contra) contradicted.push({ arm: e.arm, side, proof: e.proof, movedBy });
    }
  }
  // D56 — A REFUSED ENTRY ON A SIDE THE MEASUREMENT COVERS IS DECIDED TOO.
  //
  // A refused declaration goes back to the agent (refusedBySide), and one of
  // the two things the agent can do about it is the better one: land an input.
  // Once a recorded row moved the side and coverage.json has it hit, the side
  // is covered, so the entry is superseded for the same two facts the rule
  // above reads - and its refusal stops failing the ledger. Without this the
  // agent could fix the side and still not fix the run, since only a
  // declaration written again replaces the refused one.
  const refusedCovered = new Set();
  for (const r of refused) {
    const sides = sidesOf(r.fields.side, labelsByArm.get(r.fields.arm) ?? new Set());
    const covered = (s) => movedSides.has(`${r.fields.arm}\u0000${s}`) && coveredByMeasurement(key(r.fields.arm, s));
    if (!sides.length || !sides.every(covered)) continue;
    for (const s of sides) {
      superseded.push({ arm: r.fields.arm, side: s, proof: r.fields.proof ?? null, category: r.fields.category ?? null, movedBy: movedSides.get(`${r.fields.arm}\u0000${s}`), refused: true });
    }
    for (const e of r.errors) {
      const at = errors.indexOf(e);
      if (at !== -1) errors.splice(at, 1);
    }
    refusedCovered.add(r);
  }
  // What `--json` hands repair: one row per refused side, in the ledger's words.
  const refusedSides = [...refusedBySide({ refused: refused.filter((r) => !refusedCovered.has(r)) }, labelsByArm).values()].map(
    ({ arm, side, entry, why }) => ({ arm, side, category: entry.category ?? null, killer: entry.killer ?? null, proof: entry.proof ?? null, why })
  );
  const supersededKeys = new Set(superseded.map((x) => key(x.arm, x.side)));

  const universe = worklist.items.filter(
    (i) => i.instrumented && (!LANE || (i.lane ?? "unit") === LANE)
  );
  // Arms whose uncovered sides this ledger enumerates: a side of one of these
  // that is not in `live` is one the existing suite covers.
  const inUniverse = new Set(universe.map((i) => i.armId));
  // Sides the work list has uncovered that the measurement covers and nothing
  // else accounts for (D46).
  const coveredIncidentally = [];

  const unaccounted = [];
  const doubleClaimed = [];
  const doubleClaimWhy = [];
  const undecided = [];
  const resolved = [];
  const byCategory = {};
  const live = new Set();
  let proposedSides = 0;
  // Sides the measurement covers whose only account was a superseded entry.
  let coveredSides = 0;
  let blockedSides = 0;

  for (const item of universe) {
    for (const side of item.uncoveredSides) {
      const k = key(item.armId, side);
      live.add(k);
      const isProposed = proposed.has(k);
      const isBlocked = blocked.has(k);
      const verdict = isProposed && isBlocked ? resolveDoubleClaim(k, proposed.get(k), evidence) : null;
      if (verdict && !verdict.winner) {
        doubleClaimed.push(`${item.armId} [${side}]`);
        doubleClaimWhy.push(`${item.armId} [${side}]: ${verdict.why}`);
        const e = blocked.get(k);
        undecided.push({
          armId: item.armId,
          side,
          functionId: item.owner?.functionId ?? null,
          claims: proposed.get(k).map((c) => ({ file: c.slice(0, c.indexOf("::")), id: idOfClaim(c) })),
          entry: { category: e.category ?? null, killer: e.killer ?? null, proof: e.proof ?? null },
          why: verdict.why,
        });
      } else if (verdict?.winner === "proposal") {
        proposedSides += 1;
        resolved.push(`${item.armId} [${side}] -> the input: ${verdict.why}`);
      } else if (verdict?.winner === "blocked") {
        blockedSides += 1;
        const c = blocked.get(k).category;
        byCategory[c] = (byCategory[c] ?? 0) + 1;
        resolved.push(`${item.armId} [${side}] -> the reason: ${verdict.why}`);
      } else if (isProposed) {
        proposedSides += 1;
      } else if (isBlocked) {
        blockedSides += 1;
        const c = blocked.get(k).category;
        byCategory[c] = (byCategory[c] ?? 0) + 1;
      } else if (supersededKeys.has(k)) {
        coveredSides += 1;
      } else if (movedSides.has(`${item.armId}\u0000${side}`) && coveredByMeasurement(k)) {
        // D46 — A SIDE THE MEASUREMENT COVERS NEEDS NO OTHER ACCOUNT.
        //
        // The work list is the round BEFORE these inputs ran, so it can list a
        // side as uncovered that coverage.json now has hit, by a row that no
        // longer claims it. turing-integration-ms, 26 September: the two
        // `"cv"` fallbacks of cvStorage.service.ts#62 had their claims
        // withdrawn while the rows' tests were still skipped. Once the tests
        // ran they covered both sides (1525/1531, every other side ruled), and
        // this still counted the pair UNACCOUNTED and exited 1, which repair
        // could only report as a tool DEFECT. Covered is the strongest account
        // a side can have. It takes two facts, as the superseded rule above
        // does: a recorded row MOVED the side, and a measurement over a green
        // suite (doubleClaimEvidence is null otherwise) does not list it as
        // uncovered. Absence from that list alone is not enough, because an arm
        // id the measurement never heard of is absent too. derive.mjs's
        // `measuredCoveredIndex` reads the same two facts.
        coveredSides += 1;
        coveredIncidentally.push(`${item.armId} [${side}]`);
      } else {
        unaccounted.push(`${item.armId} [${side}]  in ${item.owner.functionId}`);
      }
    }
  }

  // A blocked side that is not actually uncovered is stale bookkeeping.
  //
  // D46: when the work list KNOWS that side and the side is covered (the
  // existing suite covers it, so the work list does not list it as uncovered,
  // or the measurement has it hit), the entry is ruling a covered side. That is
  // decided the way a contradicted code-dead entry is: superseded, delete it,
  // not a failure. An entry naming a side nobody knows (an arm that is gone, a
  // label that is not one of its sides) is still stale and still fails, and
  // `--json` carries it so repair can ask for the entry to be retracted rather
  // than end the step on a line nobody can act on.
  const knownSide = (arm, side) => labelsByArm.get(arm)?.has(side) ?? false;
  const stale = [];
  const staleEntries = [];
  for (const [k, e] of blocked) {
    if (live.has(k)) continue;
    const side = sideOfBlocked.get(k);
    if (knownSide(e.arm, side) && (inUniverse.has(e.arm) || (movedSides.has(`${e.arm}\u0000${side}`) && coveredByMeasurement(k)))) {
      superseded.push({ arm: e.arm, side, proof: e.proof ?? null, category: e.category, movedBy: [], stale: true });
      continue;
    }
    stale.push(k);
    staleEntries.push({ arm: e.arm, side, category: e.category ?? null, proof: e.proof ?? null });
  }

  const total = proposedSides + blockedSides + coveredSides + unaccounted.length + doubleClaimed.length;
  const ok =
    unaccounted.length === 0 &&
    doubleClaimed.length === 0 &&
    stale.length === 0 &&
    contradicted.length === 0 &&
    errors.length === 0;

  if (JSON_OUT) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok,
          uncovered: total,
          withAnInput: proposedSides,
          withAReason: blockedSides,
          unaccounted,
          doubleClaimed: undecided,
          coveredByTheMeasurement: coveredSides,
          coveredIncidentally,
          resolved,
          superseded,
          stale,
          staleEntries,
          refused: refusedSides,
          contradicted,
          errors,
        },
        null,
        2
      )}\n`
    );
    if (!ok) process.exit(1);
    return;
  }

  const cats = Object.entries(byCategory)
    .map(([c, n]) => `${c} ${n}`)
    .join(", ");

  process.stdout.write(
    `\n${ok ? "\u2713" : "\u2717"} ledger${LANE ? ` (lane: ${LANE})` : ""} \u2014 ${relative(REPO_ROOT, WORKLIST_JSON)}\n` +
      `    uncovered sides    ${total}\n` +
      `      with an input    ${proposedSides}\n` +
      `      with a reason    ${blockedSides}${cats ? `  (${cats})` : ""}\n` +
      (coveredSides - coveredIncidentally.length ? `      covered, entry superseded  ${coveredSides - coveredIncidentally.length}\n` : "") +
      (coveredIncidentally.length ? `      covered, claimed by nothing  ${coveredIncidentally.length}\n` : "") +
      `      UNACCOUNTED      ${unaccounted.length}\n`
  );

  if (byCategory["code-dead"]) {
    process.stdout.write(
      `\n  note: ${byCategory["code-dead"]} sides are code-dead \u2014 defects to delete or fix,\n` +
        `  not coverage to chase. A rising count here is bad news, not progress.\n`
    );
  }

  const dump = (label, rows) => {
    if (!rows.length) return;
    process.stdout.write(`\n  ${label} (${rows.length}):\n`);
    for (const r of rows.slice(0, 30)) process.stdout.write(`    ${r}\n`);
    if (rows.length > 30) process.stdout.write(`    \u2026 ${rows.length - 30} more\n`);
  };
  dump("UNACCOUNTED \u2014 no input and no reason", unaccounted);
  dump("claimed by BOTH a proposal and a blocked entry", doubleClaimed);
  dump("  which to drop", doubleClaimWhy);
  dump("claimed by both, decided by the measurement (not a failure)", resolved);
  dump(
    "stale blocked entries - the work list knows no such side (an arm that is gone, or a label that is not one of its sides): retract the entry",
    staleEntries.map((x) => `${x.arm} [${x.side}]   (${x.category ?? "?"}, proof was ${x.proof ?? "absent"})`)
  );
  dump(
    "code-dead entries SUPERSEDED by the measurement - a recorded row moved the side and coverage.json has it hit, so the side is covered and the entry is wrong: delete it (not a failure)",
    superseded.filter((x) => !x.stale && !x.refused).map((x) => `${x.arm} [${x.side}]   (proof was ${x.proof ?? "absent"})`)
  );
  dump(
    "refused blocked entries SUPERSEDED by the measurement - a recorded row moved the side and coverage.json has it hit, so the side is covered and the refused entry is moot: delete it (not a failure)",
    superseded.filter((x) => x.refused).map((x) => `${x.arm} [${x.side}]   (${x.category ?? "?"}, proof was ${x.proof ?? "absent"})`)
  );
  dump(
    "blocked entries SUPERSEDED because their side is covered - the existing suite or the measurement covers it, so the entry rules a covered side: delete it (not a failure)",
    superseded.filter((x) => x.stale).map((x) => `${x.arm} [${x.side}]   (${x.category ?? "?"}, proof was ${x.proof ?? "absent"})`)
  );
  dump(
    "uncovered in the work list, covered by the measurement, and claimed by nothing (not a failure)",
    coveredIncidentally
  );
  dump("malformed blocked entries", errors);

  if (contradicted.length) {
    process.stdout.write(
      `\n  \u2717 ${contradicted.length} side(s) declared code-dead were MOVED by a recorded row.\n` +
        `    A suppression the measurement contradicts is a false suppression - it is a\n` +
        `    100% that is short by exactly this many arms. Retract the entry, do not\n` +
        `    re-argue it:\n` +
        contradicted
          .map((c) => `      ${c.arm} ${c.side}   (proof was ${c.proof ?? "absent"})`)
          .join("\n") +
        "\n"
    );
  }

  if (!ok) process.exit(1);
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}