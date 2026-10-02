#!/usr/bin/env node
/**
 * Stage 3, machine half — build the brief the agent derives inputs from.
 *
 * This script writes NO argument values and no expected outputs. That is not an
 * oversight, it is the point: a tool that derives the input AND consumes it buys
 * ~0.015 branch arms per test, against ~0.70 when the agent reads the input off
 * the arm. All this does is put everything needed to read an arm in one place —
 * the condition source, its labels, which side is already covered, the owning
 * function's entry recipe and params, and what boundaries it touches.
 *
 *   node .claude/charpilot/worklist.mjs [--all] [--file <substring>]
 *   node .claude/charpilot/worklist.mjs --skeleton [--batch 20] [--offset 0]
 *                                                  [--ids-from <file>]
 *   node .claude/charpilot/worklist.mjs --fields armId,owner.functionId,via [--json]
 *   node .claude/charpilot/worklist.mjs --count-by owner.functionId [--json]
 *
 * Writes out/worklist.json (the machine artifact stage 3 validates against) and
 * out/worklist.md (what the agent actually reads).
 *
 * `--skeleton` writes nothing. It PRINTS a proposal document with every
 * address already filled in - function id, arm ids, side labels, `via`, the
 * boundary symbols and their modules, one `args` slot per declared parameter -
 * and `<<DERIVE>>` in every slot that is a derivation. Measured on this repo's
 * own 375 proposals, 18.7% of every authored byte sits in fields the tool
 * already held exactly, and three of them (`covers`, the `reaches` labels,
 * `via`) are join keys validate.mjs matches BYTE-EXACTLY - so pre-filling them
 * removes a class of silent mis-join, not just typing. The document is invalid
 * until it is filled: the sentinel is a hard rejection and an `args` entry
 * carries neither `value` nor `build`.
 *
 * The window is a bounded range of ROWS - one row per uncovered side, `--offset`
 * counting rows - and EVERY offset was swept rather than sampled, because a
 * bound is not a bound until the thing that could breach it has been capped.
 * On this repo, 256 function groups and 945 rows:
 *
 *   --batch 20   48 windows    5,357 - 39,351 bytes   median 22,623   (default)
 *   --batch 40   24 windows   30,641 - 69,980 bytes   median 41,595
 *
 * THOSE TWO LINES PREDATE the boundary block moving onto the row, and the
 * window is bigger for it: an answer shared by a function's rows is now written
 * once per row rather than once per function. Swept the same way over run
 * `20260916T223906Z`'s work list (365 rows, 19 windows at `--batch 20`),
 * 6,552 - 25,384 bytes / median 21,959 became 8,255 - 51,376 / median 35,103.
 * That is the price of a row that stands alone, and it is the shape the pipeline
 * hands over either way: since `a6813ec` the derive step lifts the block onto
 * one row and submits it by itself, so the sharing was already not reaching the
 * authoring turn. What it bought instead is that every citation on the row is
 * one `validate.mjs` accepts - see `renderSkeleton`.
 *
 * Two earlier shapes were not bounds at all, and the sweep is what said so:
 * eight FUNCTIONS per window gave a 107,309-byte worst case against a 25,317
 * median, and a 40-row budget that refused to split a function put
 * qode-ptp-ms's FIRST page at 96,785 bytes, because its first group alone
 * carries 123 uncovered sides. So a function's rows may straddle two windows;
 * `window.straddling` names it, and each window re-emits that function's
 * `functionBoundaries` and `functionSignatures` blocks so it stands alone.
 *
 * In practice the window is not how this is used - `--ids-from` is. One
 * function (`helpers.ts:11:runWithRetry`, 11 uncovered sides) is 10,177 bytes.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  BASELINE_JSON,
  COVERAGE_DIR,
  OUT_DIR,
  PROPOSALS_DIR,
  REPO_ROOT,
  SCAN_JSON,
  WORKLIST_JSON,
  WORKLIST_MD,
} from "./config.mjs";

import { ISTANBUL_TYPE, armCoverage, buildHitIndex, buildPositionIndex, decoratorMetadataSides, measureArmsByPosition } from "./armjoin.mjs";
// THE ONE RULE lives in novalues.mjs, imported rather than reimplemented: this
// file and recipes.mjs render the same scan fields, and when each carried its
// own answer to "what counts as a leak" they gave different ones - recipes
// stripped defaults out of a param name and this file, which writes the brief
// stage 3 actually reads, printed `modelName = 'gpt-4o'` into it.
import {
  capped,
  ctorArgs,
  displayName,
  mdCell,
  mdSource,
  mdType,
  NAME_CAP,
  oneLine,
  paramName,
  sanitiseVia,
} from "./novalues.mjs";
// WHETHER A SYMBOL IS COMPARED AGAINST OR CALLED is policy.mjs's question and
// it already answers it off the target's own source (`instanceof X`,
// `extends X`, `X.prototype`). Imported rather than re-detected here: two
// detectors for one rule is how a repo ends up with a symbol that is an
// identity to one tool and a collaborator to the other, and nothing to say
// which is wrong.
import { identityUse } from "./policy.mjs";
import { priced } from "./suppressions.mjs";
// The sentinel lives with the tool that REFUSES it, not with the tool that
// writes it. A skeleton whose unfilled slots pass validation is the artifact
// this repo hates most - one that reads as checked and is not - so the string
// and the rejection are the same decision and cannot drift apart.
import { setupEntryExample, SKELETON_TODO } from "./validate.mjs";

const ARGV = process.argv.slice(2);
/**
 * `indexOf` returns -1 when the flag is absent, so `ARGV[-1 + 1]` reads ARGV[0]
 * - the FIRST argument, whatever it is. That bug shipped here once already (see
 * FILE_FILTER below) and adding four more flags is exactly how it comes back,
 * so the read is a guarded helper now.
 */
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};
/**
 * A window bound must be a non-negative integer or the run refuses. Copied in
 * spirit from recipes.mjs, and for its reason: `Number("--json")` is NaN and
 * `slice(NaN, NaN)` returns an empty array, so a typo'd flag prints a
 * perfectly formatted skeleton containing zero functions.
 */
const count = (flag, dflt) => {
  const raw = arg(flag, null);
  if (raw === null || raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`worklist: ${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
};
/**
 * Which coverage report defines "uncovered".
 *
 * Iteration 1 read the stage-1 baseline, which is right the first time and
 * wrong every time after: it would hand stage 3 the original 484 sides when
 * only 268 remain, commissioning inputs for arms the suite already covers.
 * A reloop points this at the CURRENT union report.
 */
const COVERAGE_SRC = (() => {
  const i = ARGV.indexOf("--coverage-dir");
  return i === -1 ? COVERAGE_DIR : resolve(REPO_ROOT, ARGV[i + 1]);
})();
/**
 * AN ARTIFACT THAT IS NOT THERE IS A STAGE THAT HAS NOT RUN, AND THE MESSAGE
 * HAS TO SAY WHICH ONE.
 *
 * Every read below was a bare `JSON.parse(readFileSync(...))`, so a repo whose
 * scan or baseline had not been produced yet got
 * `ENOENT: no such file or directory, open '…/coverage-final.json'` and a stack
 * trace tail where the next command belongs. In a container walk nobody is
 * watching that scroll past: it reads as the tool being broken, which is how a
 * missing prerequisite becomes an hour of debugging the wrong thing.
 * `ledger.mjs` already answers this class of question properly — it names
 * `npm run pilot:scan && npm run pilot:deadcode` rather than throwing — and
 * this is the same answer for the four artifacts this tool cannot work without.
 */
function readArtifact(path, produce) {
  if (!existsSync(path)) {
    process.stderr.write(
      `✗ worklist.mjs: ${relative(REPO_ROOT, path)} is not there, and this tool is built from it.\n` +
        `  ${produce}\n`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** What produces the istanbul report this tool joins arms against. */
const COVERAGE_PRODUCER =
  "run `npm run pilot:baseline` to measure it, or point --coverage-dir at a report that exists.";

const INCLUDE_COVERED = ARGV.includes("--all");
// `indexOf` returns -1 when the flag is absent, so `ARGV[-1 + 1]` reads ARGV[0]
// - the FIRST argument, whatever it is. Harmless while this script took no other
// flags; the moment `--coverage-dir` was added, FILE_FILTER became
// "--coverage-dir" and silently filtered out every arm, reporting 0 uncovered
// against a report holding 268.
const FILE_FILTER = ARGV.includes("--file") ? ARGV[ARGV.indexOf("--file") + 1] : undefined;

/**
 * Read one dotted path off a work-list item.
 *
 * Module scope rather than inside `--fields`, because `--count-by` groups by
 * the SAME addresses `--fields` projects. Two copies of this would be two
 * answers to "what does `owner.entry.reachable` mean", and the count would then
 * be a count of something the projection does not show.
 */
const pick = (obj, path) =>
  path.split(".").reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);

/**
 * One value, rendered as a cell. A cell is read, not parsed: an array of side
 * labels is the common case and `|` keeps it one column; an array of boundary
 * objects is projected to the symbol, which is the only part a proposal names.
 */
const cell = (v) => {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === "object" ? (x.symbol ?? x.name ?? JSON.stringify(x)) : String(x))).join("|");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

/**
 * The same value, rendered as a GROUP KEY rather than as a cell.
 *
 * It differs from `cell` in exactly two places, and only where a blank would
 * lie. A cell may be empty because the row's value is empty; a group key that
 * is empty reads as a group that is not there, and the reader cannot tell
 * `null` from `[]` from the empty string. So `null` and `[]` print as
 * themselves. Neither is a bucket this tool invented - both are values the row
 * actually holds, and a row whose field is ABSENT never reaches here: it is
 * refused in `countBy` before anything is counted.
 */
const groupKey = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v) && v.length === 0) return "[]";
  return cell(v);
};

/**
 * Every dotted path that EVERY item carries — i.e. the fields that can be
 * counted. Used only to make a refusal useful; a field missing from one item is
 * not in this list, which is the answer to "then what may I ask for".
 */
function countableFields(items) {
  const seen = new Map();
  const walk = (obj, prefix, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      seen.set(path, (seen.get(path) ?? 0) + 1);
      if (depth < 3 && v && typeof v === "object" && !Array.isArray(v)) walk(v, path, depth + 1);
    }
  };
  for (const it of items) walk(it, "", 1);
  return [...seen].filter(([, n]) => n === items.length).map(([p]) => p);
}

/**
 * `--count-by <field>` — the group-by the agent otherwise writes by hand.
 *
 * WHY IT IS A FLAG. Measured on run 20260915T033521Z, the first run whose log
 * records whole commands: 57 calls run a pipeline tool and then reshape its
 * output inline, or parse an `out/*.json` in a heredoc. Three of them are
 * literally `worklist.mjs --fields armId,owner.functionId --json | node -e
 * '...byFile[file]=(byFile[file]||0)+1...'`, and each was preceded by a call
 * that probed the projection's shape so the reducer could be written. The
 * counts those scripts produce are the counts below.
 *
 * WHY IT REFUSES, and this is the whole risk of the flag. A field name that
 * resolves to nothing would return a grouping of zeros, or one blank group
 * holding every row - and a zero is the one wrong answer that reads as
 * finished. The agent would then derive inputs for arms it believes do not
 * exist. So:
 *
 *   - a field ABSENT from any item is refused, naming the field and how many
 *     items lack it. That covers the typo (absent from all of them) and the
 *     half-present field - `column` and `unit` exist on statement units only,
 *     and grouping by one would drop 143 of 252 rows into a blank key.
 *   - an EMPTY work list is refused, because over no rows a wrong field and a
 *     wrong `--file` produce the same empty answer, and neither says so.
 *
 * It never repairs, never defaults, and adds no "unknown" group: the sum of the
 * counts is the item count, always, which is the invariant a reader can check
 * against the `# N item(s)` line `--fields` prints.
 */
export function countBy(items, field) {
  const f = typeof field === "string" ? field.trim() : "";
  if (!f) {
    throw new Error(
      "worklist: --count-by needs one field name, e.g. --count-by owner.functionId. " +
        "One field, not a list - a grouping has one key."
    );
  }
  if (!items.length) {
    throw new Error(
      `worklist: --count-by ${f} has nothing to count - this work list holds 0 items` +
        `${FILE_FILTER ? `, and --file ${FILE_FILTER} is the filter that emptied it` : ""}. ` +
        "Over no rows a wrong field name and an empty filter give the same answer, so this is refused rather than printed as zero."
    );
  }
  const missing = items.filter((it) => pick(it, f) === undefined).length;
  if (missing === items.length) {
    throw new Error(
      `worklist: --count-by ${f} - no item in this work list carries \`${f}\`. ` +
        `Fields every item carries: ${countableFields(items).join(", ")}`
    );
  }
  if (missing) {
    throw new Error(
      `worklist: --count-by ${f} - ${missing} of ${items.length} item(s) do not carry \`${f}\`, ` +
        "so they have no group to fall in and a grouping would silently be short by that many. " +
        `Refused. \`--fields armId,${f}\` lists the rows that do.`
    );
  }
  const counts = new Map();
  for (const it of items) {
    const key = groupKey(pick(it, f));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const groups = [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { field: f, groups, total: items.length };
}

// AST arm kind → the type istanbul stamps on its branchMap entries.
function buildEntryIndex() {
  const final = readArtifact(join(COVERAGE_SRC, "coverage-final.json"), COVERAGE_PRODUCER);
  const entered = new Map();
  // Per file, every line istanbul put a function on, sorted. Needed because an
  // exact line lookup is not enough - see below.
  const linesByFile = new Map();
  for (const [absPath, entry] of Object.entries(final)) {
    const file = relative(REPO_ROOT, absPath);
    const lines = linesByFile.get(file) ?? [];
    for (const [fnId, fn] of Object.entries(entry.fnMap ?? {})) {
      const line = fn.decl?.start?.line ?? fn.loc?.start?.line;
      const hits = entry.f?.[fnId] ?? 0;
      const key = `${file}:${line}`;
      entered.set(key, Math.max(entered.get(key) ?? 0, hits));
      lines.push(line);
    }
    linesByFile.set(file, lines.sort((a, b) => a - b));
  }
  return { entered, linesByFile };
}

/**
 * istanbul's hit count for a function, tolerating the DECORATOR OFFSET.
 *
 * ts-morph reports a decorated method's start at its FIRST DECORATOR; istanbul's
 * fnMap reports it at the `method(` keyword. So `@Get() findOne()` is line 38 to
 * the scan and 39 to istanbul, an exact lookup misses, and
 * `neverEntered = (undefined === 0)` is false - so the entry unit was DROPPED.
 * Silently: it was not counted as unjoined either, so `summary` read clean.
 *
 * Measured on nest-realworld: 23 of 91 functions (25%), every one a decorated
 * method - all 12 ArticleController handlers, both TypeORM entity hooks, and so
 * on. Found independently by two agents on two repos. Nine internal Express
 * services never surfaced it because almost nothing there is decorated.
 *
 * The fallback is bounded: only a line INSIDE the function's own span, only if
 * no other scanned function claims it exactly, and the nearest one wins. An
 * unresolved entry is now reported rather than dropped.
 */
function entryHitsFor(fn, index, claimedExactly) {
  const exact = index.entered.get(`${fn.file}:${fn.line}`);
  if (exact !== undefined) return { hits: exact, via: "exact" };
  const end = fn.endLine ?? fn.line;
  for (const line of index.linesByFile.get(fn.file) ?? []) {
    if (line < fn.line || line > end) continue;
    if (claimedExactly.has(`${fn.file}:${line}`)) continue;
    return { hits: index.entered.get(`${fn.file}:${line}`), via: `decorator-offset +${line - fn.line}` };
  }
  return { hits: undefined, via: "unresolved" };
}

/**
 * STATEMENT units - every one istanbul instruments, each marked `covered`.
 *
 * Stage 3 commissioned from branch arms only, so a function with no decision
 * point and a bare statement had no row to derive an input from. Function
 * entries were added first; statements are the other half. istanbul already
 * counts them - `statementMap` plus the `s` counters - so this is a join, not a
 * new model.
 *
 * A statement on a line that already has an arm or entry unit is SKIPPED: it is
 * the same work, and emitting both would commission the same input twice and
 * inflate the unit count.
 *
 * EVERY statement unit is returned, covered or not, each carrying `covered`.
 * The caller puts only the uncovered ones on the work list - that part is
 * unchanged - and publishes the whole set as a catalogue, because the two
 * questions are different and were being answered by one list:
 *
 *   "what is left to do"   the uncovered ones. Shrinks as work lands.
 *   "does this id exist"   all of them. Must not shrink, or every proposal
 *                          that SUCCEEDED reads as a proposal pointing at
 *                          nothing.
 *
 * On run 20260915T050314Z that conflation was 71 of 73 cited statement ids:
 * covered, therefore absent from `items`, therefore reported stale by armids.mjs
 * (200 in INPUT artifacts) and as "not an arm in scan.json at all" by
 * validate.mjs (187 errors). Two gate checks red, both for work that had
 * worked. Nothing minted a statement id anywhere else, so the catalogue here is
 * the only place that question can be answered.
 */
function buildStatementUnits(scan, claimedLines) {
  const final = readArtifact(join(COVERAGE_SRC, "coverage-final.json"), COVERAGE_PRODUCER);
  const units = [];
  for (const [absPath, entry] of Object.entries(final)) {
    const file = relative(REPO_ROOT, absPath);
    if (FILE_FILTER && !file.includes(FILE_FILTER)) continue;
    const ordinals = new Map();
    for (const [stmtId, loc] of Object.entries(entry.statementMap ?? {})) {
      const covered = (entry.s?.[stmtId] ?? 0) > 0;
      const line = loc.start?.line;
      if (line === undefined) continue;
      if (claimedLines.has(`${file}:${line}`)) continue;
      // THE ORDINAL IS COUNTED OVER EVERY STATEMENT ON THE LINE, covered ones
      // included. It used to be counted over the survivors of the coverage
      // skip, so `#13:stmt:1` became `#13:stmt:0` the moment the statement
      // before it was covered - an id that renames itself as work succeeds
      // cannot be cited by anything. (Measured on 20260915T050314Z: every id in
      // play was ordinal 0, so nothing in flight renumbers; the change is what
      // stops the next multi-statement line from silently shifting.)
      const n = ordinals.get(line) ?? 0;
      ordinals.set(line, n + 1);

      // Innermost enclosing scanned function, so the unit carries a real entry
      // recipe rather than a bare file:line the agent cannot drive.
      const owner = scan.functions
        .filter((f) => f.file === file && f.line <= line && (f.endLine ?? f.line) >= line)
        .sort((a, b) => b.line - a.line)[0];
      if (!owner) continue;

      units.push({
        armId: `${file}#${line}:stmt:${n}`,
        file,
        line,
        column: loc.start?.column ?? null,
        kind: "statement",
        source: `statement at ${file}:${line}`,
        sides: ["executed"],
        hits: [covered ? 1 : 0],
        uncoveredSides: covered ? [] : ["executed"],
        covered,
        // istanbul DOES instrument it, but not as a branch - so it can be
        // measured and it cannot be ratcheted by the branch ratchet. Marked
        // false for the same reason `catch` is: `instrumented` in this file
        // means "counted in the branch denominator".
        instrumented: false,
        unit: "statement",
        owner: {
          functionId: owner.id,
          name: owner.name,
          async: owner.async,
          params: owner.params,
          entry: owner.entry,
        },
        via: sanitiseVia(owner.via ?? null, { driversCap: Infinity }),
        lane: laneOf(owner),
        boundaries: owner.boundaries,
      });
    }
  }
  return units;
}


/** coverage-final.json of the measurement the self-check compares against, or null. */
function readCoverageFinal() {
  try {
    return JSON.parse(readFileSync(join(COVERAGE_SRC, "coverage-final.json"), "utf8"));
  } catch {
    return null;
  }
}

function build() {
  const scan = readArtifact(SCAN_JSON, "run `npm run pilot:scan` — the scan is the only authority on which arms exist.");
  const baseline = readArtifact(BASELINE_JSON, "run `npm run pilot:baseline` — the baseline is the denominator every count here is quoted over.");
  const hitIndex = buildHitIndex(COVERAGE_SRC);
  // The join, computed once for every arm, by POSITION RANK within a file+type
  // rather than by line. istanbul keys a branch where the enclosing expression
  // starts and the AST keys the node, so the two disagree on any multi-line
  // condition - which is what made 10 arms on ptp-be never join and this build
  // refuse. The shape and the ORDER do agree (1175 of 1175 file+type slots,
  // every type delta zero), so ranking is exact and needs no line to match.
  // Where a slot's cardinality differs, a directive removed a branch and the
  // line-keyed join still handles it, passed in here as the fallback.
  const joined = measureArmsByPosition(scan, buildPositionIndex(COVERAGE_SRC), {
    lineFallback: (file, arm, cursor) => armCoverage(file, arm, hitIndex, cursor),
  });
  const covOf = (arm) => joined.get(arm.armId) ?? { known: false, reason: "arm is not in the join at all" };
  const entryIndex = buildEntryIndex();
  // Which istanbul lines a scanned function claims EXACTLY. The decorator-offset
  // fallback must not steal a line that belongs to another function.
  const claimedExactly = new Set();
  for (const fn of scan.functions) {
    if (entryIndex.entered.has(`${fn.file}:${fn.line}`)) claimedExactly.add(`${fn.file}:${fn.line}`);
  }
  const entryUnresolved = [];

  const items = [];
  const unmatched = [];
  // `catch` is a real decision point istanbul does not instrument. It is still
  // work — it just cannot be ratcheted by coverage, so it is tracked apart from
  // arms that failed to join for an unexpected reason.
  let notInstrumented = 0;

  // One cursor per file so repeated (type,line) slots consume istanbul branches
  // in source order, matching the order ts-morph walked them.
  const cursors = new Map();
  // Sides this build declines to emit. Declared, so the self-check can close.
  let skippedArtifactSides = 0;

  for (const fn of scan.functions) {
    if (!cursors.has(fn.file)) cursors.set(fn.file, new Map());
    const cursor = cursors.get(fn.file);

    // The entry unit, before any arm. Emitted only when istanbul recorded zero
    // calls — a function that ran has its happy path already exercised.
    const { hits: entryHits, via: entryVia } = entryHitsFor(fn, entryIndex, claimedExactly);
    if (entryVia === "unresolved") entryUnresolved.push(fn.id);
    const neverEntered = entryHits === 0;
    if (neverEntered && !(FILE_FILTER && !fn.file.includes(FILE_FILTER))) {
      items.push({
        armId: fn.entryArmId,
        file: fn.file,
        line: fn.line,
        kind: "function-entry",
        // A SIGNATURE, not a call: the display name and the binding names, both
        // sanitised. Built raw, this was a second independent leak of the very
        // values the param table leaked - 4 of these on ptp-be rendered
        // `isActionByCandidate = false` into the arm table - and the newlines a
        // binding pattern carries broke all 40 of its markdown rows.
        source: `${displayName(fn.name)}(${fn.params.map((x) => paramName(x.name)).join(", ")})`,
        sides: ["entered"],
        hits: [0],
        uncoveredSides: ["entered"],
        instrumented: false,
        owner: {
          functionId: fn.id,
          name: fn.name,
          async: fn.async,
          params: fn.params,
          entry: fn.entry,
        },
        via: sanitiseVia(fn.via ?? null, { driversCap: Infinity }),
        lane: laneOf(fn),
        boundaries: fn.boundaries,
      });
    }

    for (const arm of fn.arms.list) {
      const cov = covOf(arm);
      if (!cov.known) {
        if (arm.istanbul) unmatched.push({ armId: arm.armId, reason: cov.reason });
        else notInstrumented += 1;
      }

      const uncovered = cov.known ? cov.uncoveredSides : arm.labels ?? [];
      if (!INCLUDE_COVERED && cov.known && uncovered.length === 0) continue;
      if (FILE_FILTER && !fn.file.includes(FILE_FILTER)) continue;
      if (arm.kind === "transpile-artifact") {
        skippedArtifactSides += cov.known ? cov.uncoveredSides.length : 0;
        continue;
      }
      if (arm.kind === "function-entry") continue; // emitted above, not from the arm list

      items.push({
        armId: arm.armId,
        file: fn.file,
        line: arm.line,
        kind: arm.kind,
        source: arm.text,
        sides: arm.labels ?? [],
        hits: cov.known ? cov.hits : null,
        uncoveredSides: uncovered,
        // Only when it could be read. See `evaluatedWhen`: absent means the
        // connector was not determinable, never that the side has no
        // precondition.
        ...(evaluatedWhen(arm, uncovered) ? { evaluatedWhen: evaluatedWhen(arm, uncovered) } : {}),
        instrumented: arm.istanbul,
        owner: {
          functionId: fn.id,
          name: fn.name,
          async: fn.async,
          params: fn.params,
          entry: fn.entry,
        },
        // `via` and `lane` were each listed TWICE in this literal, same value
        // both times - harmless, and exactly the kind of thing nobody reads.
        via: sanitiseVia(fn.via ?? null, { driversCap: Infinity }),
        lane: laneOf(fn),
        boundaries: fn.boundaries,
      });
    }
  }

  // MODULE-SCOPE ARMS ARE UNITS. `moduleScopeArms` was never referenced in this
  // file, so 4 arms x 2 sides went missing on location-ms - exactly its
  // 359-vs-367 self-check gap, and `sidesUnknownUnjoined` reported 0, so the
  // discrepancy was invisible except through the exit code. They run at import
  // time and have no owning function, so they carry a synthetic owner whose
  // entry is the module import itself.
  for (const group of scan.moduleScopeArms ?? []) {
    if (FILE_FILTER && !group.file.includes(FILE_FILTER)) continue;
    for (const arm of group.list ?? []) {
      if (arm.kind === "transpile-artifact") {
        // Counted as SKIPPED, not silently dropped: the self-check compares
        // `emitted + skipped` against the coverage report, so anything this
        // loop declines has to be declared or the comparison is unfalsifiable.
        const c = covOf(arm);
        // 0 when the join is UNKNOWN, not `arm.count`. Claiming an unjoined
        // artifact is uncovered is a claim on no evidence, and it broke the
        // check on interview-service: 119 + 2 against a report of 119, because
        // those 2 sides were never in the report's uncovered set at all. An
        // unjoined arm is already reported on its own line.
        skippedArtifactSides += c.known ? c.uncoveredSides.length : 0;
        continue;
      }
      const cov = covOf(arm);
      const uncovered = cov.known ? cov.uncoveredSides : arm.labels ?? [];
      if (!INCLUDE_COVERED && cov.known && uncovered.length === 0) continue;
      items.push({
        armId: arm.armId,
        file: group.file,
        line: arm.line,
        kind: arm.kind,
        source: arm.text,
        sides: arm.labels ?? [],
        hits: cov.known ? cov.hits : null,
        uncoveredSides: uncovered,
        // Only when it could be read. See `evaluatedWhen`: absent means the
        // connector was not determinable, never that the side has no
        // precondition.
        ...(evaluatedWhen(arm, uncovered) ? { evaluatedWhen: evaluatedWhen(arm, uncovered) } : {}),
        instrumented: arm.istanbul,
        moduleScope: true,
        owner: {
          functionId: `${group.file}:0:<module scope>`,
          name: "<module scope>",
          async: false,
          params: [],
          entry: { kind: "module-import", reachable: true, reason: "runs at import time" },
        },
        via: { kind: "trigger", trigger: "module-import", how: "evaluated when the module is first imported" },
        lane: "unit",
        // What the module calls at import (scan.mjs, module-scope boundaries);
        // absent from a scan that predates them.
        boundaries: group.boundaries ?? [],
      });
    }
  }

  // Statements come last so `claimedLines` already holds every line an arm or
  // entry unit speaks for.
  const claimedLines = new Set(items.map((i) => `${i.file}:${i.line}`));
  // The work list takes the uncovered ones, exactly as before. The whole set
  // travels separately as `statementUnits`, because "is this id real" must not
  // be answered by a list whose job is to shrink.
  const statementUnits = buildStatementUnits(scan, claimedLines);
  items.push(...statementUnits.filter((u) => !u.covered));

  // THE SHARD, applied here and nowhere else.
  //
  // A repo two orders of magnitude larger than the one this pipeline was tuned
  // on cannot be characterized in a run: qode-ptp-ms carries 8,546 uncovered
  // sides against a run that hands out 20 per round for 12 rounds. Spreading
  // that over ~40 runs is arithmetic; making each run MEAN something is not.
  // "sides 2,001-3,000" is not a reviewable unit of work. `src/lib/common`
  // closing to 95% is.
  //
  // So a shard is a SOURCE PREFIX, and it is applied to the items rather than
  // to the scan: the reconcile still runs over the whole service, the
  // denominator is still the whole service, and only the questions this run
  // asks are narrowed. A shard that changed the denominator would make every
  // run's percentage incomparable with every other run's, which is the one
  // thing a ratchet cannot survive.
  //
  // Empty or unset means the whole repo, which is what every run did before
  // this existed.
  // WHAT A SELECTOR EXCLUDED, COUNTED THE WAY THE SELF-CHECK COUNTS WHAT IT KEPT.
  //
  // `shardExcluded` and `probeExcluded` are added to `uncoveredSidesMeasured`
  // and compared against the coverage report, so they have to be the SAME
  // QUANTITY it is — instrumented, joined, uncovered SIDES — and nothing else.
  // Counting removed ITEMS instead is not close: `items` also holds function
  // entries and statements, which are units with one nominal side each and are
  // not in istanbul's branch denominator at all, and one arm carries as many
  // sides as it has labels.
  //
  // MEASURED, on notification-ms with the real toolset installed:
  // `CHARPILOT_SHARD=src/services` removed 74 ITEMS worth 41 measured sides, and
  // the check read `67 + 74 should equal 108` and refused the run as "a real
  // join defect". It is the selector's own arithmetic, not the join. The same
  // repo under `CHARPILOT_PROBE_FUNCTIONS` read `16 + 161 should equal 108`.
  // Both are this one line.
  const unmatchedArmIds = new Set(unmatched.map((u) => u.armId));
  const measuredSides = (list) =>
    list
      .filter((i) => i.instrumented && !unmatchedArmIds.has(i.armId))
      .reduce((n, i) => n + i.uncoveredSides.length, 0);

  const SHARD = (process.env.CHARPILOT_SHARD ?? "").trim();
  let shardDropped = 0;
  if (SHARD) {
    const prefixes = SHARD.split(",").map((p) => p.trim().replace(/\/+$/, "")).filter(Boolean);
    const before = items.length;
    const inShard = (f) => prefixes.some((p) => f === p || f.startsWith(`${p}/`));
    const removed = [];
    for (let i = items.length - 1; i >= 0; i--) if (!inShard(items[i].file)) removed.push(...items.splice(i, 1));
    shardDropped = measuredSides(removed);
    if (items.length === 0) {
      // REFUSE rather than report a finished shard. A prefix that matches
      // nothing is a typo or a moved directory, and a run that hands out zero
      // sides and exits clean reads exactly like one that had no work left.
      throw new Error(
        `CHARPILOT_SHARD=${SHARD} matched none of the ${before} uncovered side(s). ` +
          `Shards are source prefixes as they appear in scan.json — e.g. src/lib/common, ` +
          `src/services — and this one selected nothing, which is a typo rather than a finished shard.`
      );
    }
  }

  // THE PROBE, applied here for the same reason and with the same rules.
  //
  // A shard is a source PREFIX, and a prefix cannot express "these twelve
  // functions". That is the selection a stratified probe needs: `fleetprobe`
  // classifies every function in a repo by entry kind x driver kind, takes two
  // per type, and wants the run to ask about those and nothing else — one or
  // two packets that between them carry every SHAPE the repo has, rather than a
  // directory that happens to hold a lot of work. `src/services` on contact-ms
  // is 53 sides; the probe's list of twelve functions is 5, and it is the five
  // that tell you where the pipeline breaks on this repo.
  //
  // One function id per line, exactly as `scan.json` writes them
  // (`src/a.ts:12:handler`) — which is the same string every item already
  // carries as `owner.functionId`. `#` starts a comment and blank lines are
  // ignored, because the file is written by a tool and read by a person.
  //
  // APPLIED TO THE ITEMS, NEVER TO THE SCAN, for the shard's reason exactly:
  // the reconcile still runs over the whole service and the denominator is
  // still the whole service. A selector that changed the denominator would make
  // the probe's percentage incomparable with every other run's — and it would
  // reintroduce the join-check defect fixed today, where a deliberate exclusion
  // was reported as a real join defect.
  //
  // MODULE-SCOPE ARMS ARE NEVER SELECTED, and that is not an oversight: their
  // synthetic owner id is `<file>:0:<module scope>`, which no scan function
  // carries, so a probe list built from `scan.json` cannot name one. They run at
  // import time and belong to no function, so there is no function TYPE to
  // stratify them by.
  //
  // Empty or unset means the whole repo, which is what every run did before
  // this existed.
  const PROBE = (process.env.CHARPILOT_PROBE_FUNCTIONS ?? "").trim();
  let probeDropped = 0;
  let probeWanted = 0;
  let probeMatched = 0;
  if (PROBE) {
    // Resolved against REPO_ROOT, like `--ids-from` one function down: the walk
    // runs with its CWD at the package root, and a tool handed a relative path
    // that resolved against the process CWD would read a different file
    // depending on who spawned it.
    const path = resolve(REPO_ROOT, PROBE);
    if (!existsSync(path)) {
      throw new Error(
        `CHARPILOT_PROBE_FUNCTIONS=${PROBE} is not a file (looked at ${path}). ` +
          `It holds one function id per line, as scan.json writes them — e.g. src/a.ts:12:handler.`
      );
    }
    const wanted = new Set(
      readFileSync(path, "utf8")
        .split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter(Boolean)
    );
    probeWanted = wanted.size;
    if (!wanted.size) {
      // An EMPTY list is not "select nothing", it is a file that was written
      // wrong — and selecting nothing is the failure mode below.
      throw new Error(
        `CHARPILOT_PROBE_FUNCTIONS=${PROBE} holds no function id (${path} is empty or all comments). ` +
          `One id per line, as scan.json writes them.`
      );
    }
    const before = items.length;
    const seen = new Set();
    const removed = [];
    for (let i = items.length - 1; i >= 0; i--) {
      if (wanted.has(items[i].owner.functionId)) seen.add(items[i].owner.functionId);
      else removed.push(...items.splice(i, 1));
    }
    probeDropped = measuredSides(removed);
    probeMatched = seen.size;
    if (items.length === 0) {
      // REFUSE, for the shard's reason exactly: a run that hands out zero sides
      // and exits clean reads exactly like one that had no work left. A list
      // that matches nothing is a stale scan or an id copied from another repo.
      throw new Error(
        `CHARPILOT_PROBE_FUNCTIONS=${PROBE} named ${wanted.size} function(s) and matched none of the ` +
          `${before} uncovered side(s). Ids are scan.json's own — e.g. src/a.ts:12:handler — and a list that ` +
          `selects nothing is a stale scan or a list written for a different repo, not a finished probe.`
      );
    }
  }

  // Reachable first, then widest arm first — the order a person would work in.
  items.sort((a, b) => {
    if (a.owner.entry.reachable !== b.owner.entry.reachable) return a.owner.entry.reachable ? -1 : 1;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  return { scan, baseline, items, statementUnits, unmatched, notInstrumented, entryUnresolved, hitIndex, cursors, skippedArtifactSides, shard: SHARD || null, shardDropped, probe: PROBE || null, probeDropped, probeWanted, probeMatched };
}

/**
 * Which lane a unit belongs to. `integration` needs a booted app — server.start()
 * binds a port, connects Redis and installs signal handlers — so stage 4/5 can
 * run or skip that lane on its own and report coverage with and without it.
 */
/**
 * WHY AN OPERAND SIDE IS NOT REACHED BY SUPPLYING A VALUE FOR IT.
 *
 * A `binary-expr` side is one operand of a `&&`/`||` chain, and istanbul counts
 * it as covered when it is EVALUATED. Operand 1 of `a && b` is only evaluated
 * when `a` is truthy; operand 1 of `a || b` only when `a` is falsy. So a side
 * at index > 0 is not reached by writing an input that makes that operand true
 * -- it is reached by an input that first drives every operand to its left to
 * the value that does not short-circuit.
 *
 * MEASURED, and this is why the field exists. On notification-ms run
 * `20260921T050441Z`, 45 of 83 `reaches` claims measured FALSE, every one of
 * them `path-not-taken`; 14 of the 45 were `binary-expr` sides at index > 0.
 * The work list already held everything needed to say so -- `sides` in source
 * order and `hits` per side -- and said nothing, so the brief asked for an
 * operand without stating the condition under which it runs at all. The agent
 * then wrote an input for the operand, the arm did not move, `measure`
 * contradicted the claim, the row was quarantined and the side came back in the
 * next round's brief unchanged. Four runs across two models sat at 43.8-54.2%
 * false for that reason among others.
 *
 * TEXTUAL, AND IT REFUSES RATHER THAN GUESSES. The connector is read from the
 * arm's own source between one operand's end and the next operand's start,
 * scanning forward so a repeated operand text cannot match the wrong
 * occurrence. Stage 2 truncates a long label at 60 characters, and a truncated
 * operand is not findable in the source -- so when any operand up to the side
 * cannot be located, or the gap between two of them holds neither `&&` nor
 * `||`, this returns null and the item carries no field. A wrong precondition
 * is worse than none: it would send the agent at an operand that is not the
 * one gating the side.
 */
export function evaluatedWhen(arm, uncovered) {
  if (arm.kind !== "binary-expr") return null;
  const sides = arm.labels ?? [];
  const source = arm.text ?? "";
  if (sides.length < 2 || !source) return null;

  // Every operand's position, scanning forward. `indexOf` from the previous
  // operand's end is what makes a repeated operand text unambiguous: `a && a`
  // has two identical labels and they are different sides.
  const at = [];
  let cursor = 0;
  for (const side of sides) {
    const i = source.indexOf(side, cursor);
    if (i === -1) return null;
    at.push({ side, start: i, end: i + side.length });
    cursor = i + side.length;
  }

  const out = [];
  for (const side of uncovered) {
    const index = sides.indexOf(side);
    if (index <= 0) continue; // operand 0 is always evaluated when the arm runs
    const after = [];
    let ok = true;
    for (let j = 1; j <= index; j += 1) {
      const gap = source.slice(at[j - 1].end, at[j].start);
      // `??` IS THE COMMON ONE HERE, and leaving it out was the first version's
      // mistake. Of the 25 operand sides notification-ms run
      // `20260921T050441Z` left uncovered at index > 0, **20 were `??`** and
      // only 3 `||` and 2 `&&` -- the repositories coalesce a nullable column
      // (`errorFields?.errorCode ?? null`, `userAgent ?? null`) and the right
      // operand runs only when the left is null or undefined. Reading only
      // `&&`/`||` refused 20 of 25 sides as unreadable and reported it as a
      // gap it could not parse, which is indistinguishable from a real refusal.
      //
      // `mustBe` is what the LEFT operand has to be for the right one to run:
      // truthy for `&&`, falsy for `||`, nullish for `??` -- and nullish is not
      // falsy. `0 ?? x` does not evaluate `x`; `0 || x` does. Telling the agent
      // "falsy" for a `??` would send it at 0 or "" and the side would not move.
      const found = ["&&", "||", "??"].filter((o) => gap.includes(o));
      // Exactly one, or it is not read. Two means nested parentheses or an
      // operand this scan did not label; none means the gap is not a connector
      // at all. A wrong precondition is worse than none.
      if (found.length !== 1) { ok = false; break; }
      const connector = found[0];
      after.push({
        operand: sides[j - 1],
        connector,
        mustBe: connector === "&&" ? "truthy" : connector === "||" ? "falsy" : "nullish",
      });
    }
    if (!ok || !after.length) continue;
    out.push({ side, index, after });
  }
  return out.length ? out : null;
}

function laneOf(fn) {
  const drivers = fn.via ? (fn.via.drivers ?? [fn.via.driver]).filter(Boolean) : [];
  if (fn.file === "src/server.ts") return "integration";
  if (drivers.some((d) => d === "src/server.ts:140:start")) return "integration";
  if (fn.via?.kind === "trigger" && fn.via.trigger === "http-request") return "integration";
  return "unit";
}

function groupByFunction(items) {
  const groups = new Map();
  for (const item of items) {
    const g = groups.get(item.owner.functionId);
    if (g) g.arms.push(item);
    else groups.set(item.owner.functionId, { owner: item.owner, boundaries: item.boundaries, arms: [item] });
  }
  return [...groups.values()].sort((a, b) => {
    if (a.owner.entry.reachable !== b.owner.entry.reachable) return a.owner.entry.reachable ? -1 : 1;
    return b.arms.length - a.arms.length;
  });
}

function entryLine(entry) {
  switch (entry.kind) {
    case "import-named":
      return `import { ${entry.symbol} } from "${entry.module}"`;
    case "import-default":
      return `import mod from "${entry.module}"`;
    case "import-named-property":
      return `import { ${entry.symbol} } from "${entry.module}"  →  ${entry.symbol}.${entry.property}(…)`;
    case "class-method":
      // `ctorArgs`, shared with recipes.mjs: undefaulted names and CAPPED
      // types. Raw, one ptp-be constructor put 2509 bytes of inferred type on
      // a single line of the brief.
      return `new ${entry.className}(${ctorArgs(entry.ctorParams)}).${entry.member}(…)   from "${entry.module}"`;
    case "class-static":
      return `${entry.className}.${entry.member}(…)   from "${entry.module}"`;
    default:
      return `NO OWN ENTRY (${entry.kind}) — ${oneLine(entry.reason)}`;
  }
}

/**
 * How much of a param name or type the SKELETON carries, against the 80/90 the
 * markdown brief uses.
 *
 * Those two caps exist to keep a markdown table row from breaking, and they
 * were doing real damage on the artifact stage 3 has to derive from: on a
 * freshly-onboarded 710-line service, deriving inputs meant reading all 710
 * lines of `src/` anyway, because the brief cut the destructured parameter
 * shapes and the types it needed. The skeleton is JSON, so it has no row to
 * break, and the shape of the object an author must construct is the single
 * most load-bearing thing on the page.
 *
 * It is still a CAP and not "uncapped", because one param type in this fleet is
 * 16,233 bytes of inferred type and nobody reads that either. `capped()` flags
 * the true length whenever it cuts, so a cut type says so.
 */
const SKELETON_CAP = 2000;

/** An id fragment: word characters only, so a proposal id stays a plain token. */
const slug = (s) =>
  String(s ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "fn";

/**
 * A ready-to-fill proposal document, with every ADDRESS already in it.
 *
 * The measured problem: on a fresh 710-line service, stage 3 produced 53,195
 * bytes of proposals of which 39% was boundary answers - 47 answers over 16
 * distinct symbols - and 14% was the derived input. On this repo's mature
 * corpus the same split is 18.7% of every byte in `proposals/` sitting in
 * fields the tool already holds exactly: `functionId`, `covers`, the `reaches`
 * side labels, `via`, the boundary symbols and their modules, and the
 * `from.arm` of every value.
 *
 * That is not a documentation gap. A refusal that can PRINT the right answer
 * had the answer, and asked the author to retype it - and three of those
 * fields are join keys `validate.mjs` matches byte-exactly, so retyping one is
 * how a claim silently stops being verifiable. Pre-filling them is a
 * correctness fix that happens to save bytes.
 *
 * What the author fills is VALUES ONLY, and the skeleton is invalid until they
 * do: every derived slot holds `SKELETON_TODO`, and `args[]` entries carry
 * neither `value` nor `build`, so `validate.mjs` refuses the untouched
 * document. There is deliberately NO slot anywhere for an expected output -
 * `expected`, `expects`, `returns`, `assert` and `snapshot` are refused on a
 * proposal, and a skeleton that made one of them convenient to write would
 * defeat the invariant the whole pipeline rests on.
 *
 * One row per uncovered SIDE, because the side is what ratchets. Rows merge
 * freely afterwards - one call takes one side of every point it passes
 * through, and `getClientIp` closes 7 decision points with 5 inputs - but a
 * skeleton that guessed the merge would hand back arms with no home.
 */
function renderSkeleton(groups, scan, { batch, offset }) {
  const fnIndex = new Map(scan.functions.map((f) => [f.id, f]));

  // The window is a bounded range of ROWS, and `--offset` counts rows.
  //
  // Two earlier shapes were wrong, and both were caught by sweeping every
  // offset rather than sampling one - `recipes.mjs`'s rule, that a bound is not
  // a bound until the thing that could breach it has been capped:
  //
  //   by FUNCTION, 8 per window   107,309 bytes worst, 25,317 median
  //   by ROW BUDGET, whole functions only, 40 rows
  //                                67,615 bytes worst, 38,488 median - and on
  //                                qode-ptp-ms the FIRST page was 96,785,
  //                                because its first group alone carries 123
  //                                uncovered sides. A budget the first page
  //                                always breaches is not a budget.
  //
  // So a function's rows MAY span two windows, and each window re-emits the
  // `functionBoundaries` and `functionSignatures` blocks for every function its
  // own rows belong to. That repetition is not the restatement this change
  // exists to remove: a window is one authoring session and the author keeps
  // one of them, so each has to stand alone.
  const flat = groups.flatMap((g) =>
    g.arms.flatMap((a) => (a.uncoveredSides ?? []).map((side, i) => ({ g, a, side, i })))
  );
  const window = flat.slice(offset, offset + batch);

  const slot = (arm) => ({ arm, evidence: SKELETON_TODO, reading: SKELETON_TODO });

  const functionBoundaries = {};
  // The signature, declared once per function beside the boundary block.
  //
  // It was on every `args[]` entry of every row first, which repeated one
  // function's two parameter lines 66 times in the largest window - the exact
  // restatement this whole change exists to remove, reintroduced by the tool
  // meant to remove it. No tool reads this field; it is here because deriving
  // an argument means knowing the shape of the thing being built, and on a
  // freshly-onboarded service that meant reading all 710 lines of `src/`
  // because the markdown brief cut the destructured shapes at 80 characters and
  // the types at 90.
  const functionSignatures = {};
  const proposals = [];

  for (const { g, a, side, i } of window) {
    const fnId = g.owner.functionId;
    const first = g.arms[0];
    const via = g.owner.entry.reachable
      ? undefined
      : first.via?.kind === "trigger"
        ? `trigger:${first.via.trigger}`
        // The scan's own resolution, VERBATIM: validate.mjs matches a declared
        // `via` against this list byte-exactly, and the refusal for getting it
        // wrong already prints the list - which is the definition of a value
        // the tool should have written itself.
        : (first.via?.drivers ?? [first.via?.driver]).filter(Boolean)[0];
    const driverFn = via && !via.startsWith("trigger:") ? fnIndex.get(via) : undefined;

    // Every boundary `validate.mjs` will DEMAND: the function's own plus its
    // driver's, minus the two classes it does not demand - `advisory` (real
    // nondeterminism that only matters if the recorded value depends on it)
    // and `typeOnly` (a symbol that never exists at run time).
    const demanded = [...(g.boundaries ?? []), ...(driverFn?.boundaries ?? [])].filter(
      (b) => !b.advisory && !b.typeOnly
    );
    // THE ANSWER, minus its citation. Built once per symbol and stamped twice,
    // because the two copies below are cited from different places and a shared
    // `mock: {}` would be one object on two rows.
    const answerFor = (b) => ({
      behaviour: SKELETON_TODO,
      // `kind` is the one field here the tool genuinely cannot pick: it is
      // the decision. The refusal it triggers prints the whole enum.
      mock: { kind: SKELETON_TODO },
      module: b.module,
      ...(b.imported && b.imported !== b.symbol ? { imported: b.imported } : {}),
    });

    // THE ROW'S OWN BLOCK, CITED FROM THE ROW'S OWN ARM.
    //
    // `from: slot(first.armId)` - `g.arms[0]`, the first arm of the function's
    // GROUP - was defensible only while this block reached a proposal by
    // INHERITANCE. validate.mjs:997 passes `null` instead of `covers` for an
    // inherited answer, so `checkEvidence`'s `covers.includes(from.arm)` is
    // skipped by construction and a function-level citation is legal there.
    //
    // It is not how the block reaches a proposal any more. Since `a6813ec` the
    // derive step hands the agent ONE ROW, alone, and the block lands on that
    // row - where it is no longer inherited and the cross-check runs against a
    // `covers` naming a different arm. Measured on run `20260916T223906Z`'s own
    // worklist, rendered through this tool: 726 boundary answers over 309 rows,
    // 556 of them citing an arm the row does not cover, condemning 222 of 365
    // rows before the agent wrote a character. The run's own round 3 quarantined
    // 99 of 135 proposals and 95 shared this fault; the agent had copied, byte
    // for byte, what this tool handed it.
    //
    // MOVING THE STAMP IS NOT ENOUGH ON ITS OWN, and that is why the block moves
    // with it. `functionBoundaries[fnId]` is written once per FUNCTION while
    // this loop runs once per ROW, so a `slot(a.armId)` left in a shared block
    // just records whichever row wrote last: measured the same way, that fixes
    // 7 of the 556. The citation is a property of the row, so it is stamped
    // where the row can carry it.
    const block = {};
    for (const b of demanded) {
      if (block[b.symbol]) continue;
      block[b.symbol] = { ...answerFor(b), from: slot(a.armId) };
    }

    // THE FUNCTION-LEVEL DECLARATION, which is now what it says it is: the
    // collaborators the function CALLS.
    //
    // It is still emitted, still stamped `slot(first.armId)` and still exempt -
    // an answer that reaches a proposal by inheritance is the one case
    // validate.mjs:997 skips the cross-check for, and nothing here changes it.
    // Two readers downstream key off this block and neither is reading it as an
    // answer: `kindOf` decides whether an item asks a BOUNDARY question by
    // matching its symbols against the arm's own condition, and `readingPlan`
    // turns them into "a collaborator <fn> calls".
    //
    // A SYMBOL USED AS AN IDENTITY IS NOT THAT. `err instanceof
    // PrismaClientKnownRequestError` at src/server.ts:58 is the right operand of
    // an `instanceof`: the subject never calls it and never constructs it, and
    // the arm is decided entirely by `args[0]`. Asked as a boundary, the item
    // reads "the condition turns on what a collaborator does - what does it do
    // on the run that takes then?", and the answer is that it does nothing. An
    // agent hit exactly this in a blind run, worked it out from the operator
    // with nothing on the item telling it, and answered it as an argument row.
    //
    // `policy.mjs`'s `identityUse` is the one detector - `instanceof X`,
    // `extends X`, `X.prototype`, read off the target's own source. A second
    // one here would be two answers to one question with nothing to say which
    // is wrong when they part.
    //
    // ERRING TOWARD ASKING IS CHEAP; ERRING TOWARD NOT ASKING IS INVISIBLE. So
    // this narrows the QUESTION and never the ANSWER SET: every demanded symbol,
    // identity or not, is on the row's block above, so validate.mjs still
    // demands an answer for it and a mocked run still has a declaration to stub
    // from. A symbol wrongly called an identity costs an item framed as an
    // argument question; it cannot cost a boundary nobody declared, which is
    // what run `20260916T223906Z` shows as 122 skipped recordings with
    // `blocked egress: … - no boundary declared for it`.
    const calls = {};
    for (const b of demanded) {
      if (calls[b.symbol]) continue;
      if (identityUse(b.symbol)) continue;
      calls[b.symbol] = { ...answerFor(b), from: slot(first.armId) };
    }
    if (Object.keys(calls).length) functionBoundaries[fnId] = calls;

    const params = (g.owner.params ?? []).map((p) => ({
      ...capped(paramName(p.name, SKELETON_CAP), "name", SKELETON_CAP),
      ...capped(p.type, "type", SKELETON_CAP),
      ...(p.optional ? { optional: true } : {}),
      // A REST parameter is the point of some functions - `...runs: Run<T>[]`
      // reads as one parameter and arity has no ceiling - so it is said here
      // rather than left for the author to notice.
      ...(p.rest ? { rest: true, note: "rest — arity has no ceiling; propose the variadic call the function exists for" } : {}),
    }));
    if (params.length) functionSignatures[fnId] = params;

    proposals.push({
      // Mechanical, unique and honest. Worth renaming to describe the
      // INPUT - the corpus reads `getModelKey-called-without-enable-argument`
      // - but a generated id is an address, not a derivation, so it is not
      // sentinelled. Slugified off the DISPLAY name, so a function whose
      // name quotes the call it was an argument to (93 of ptp-ms's 6948 do,
      // one of them naming an env var that holds a secret) cannot carry
      // that literal into a proposal id.
      id: `${slug(displayName(g.owner.name, 48))}-${a.line}-${a.kind}-${i}`,
      functionId: fnId,
      ...(via ? { via } : {}),
      lane: a.lane,
      covers: [a.armId],
      // The SIDE LABEL, verbatim, as an ARRAY. It is a join key
      // `validate.mjs`, stage 4's verdict and stage 6's claim check all
      // match byte-exactly, and a label can contain a comma - four on this
      // repo do - so the array is the only form that survives one.
      reaches: { [a.armId]: [side] },
      rationale: SKELETON_TODO,
      // One slot per DECLARED parameter, positional, in signature order -
      // the shape and type of each are in `functionSignatures` above.
      // Neither `value` nor `build` is present, so validate refuses the row
      // until one is derived into it.
      args: params.map(() => ({ from: slot(a.armId) })),
      // EVERY demanded boundary, on the row, cited from the row's own arm - so
      // the row is a document that stands alone when it is read alone, which is
      // the only way it now reaches the agent. `functionBoundaries` above is
      // the function-level declaration a reader of the whole window can fall
      // back on; a row that deletes its own block inherits from it, and set a
      // symbol to `null` to say this row does not answer it at all.
      boundaries: block,
      // THE ONE FIELD THE SKELETON LEFT THE AUTHOR TO INVENT, AND THE ONE THE
      // CORPUS GETS WRONG MOST OFTEN.
      //
      // `boundaries` above is pre-shaped down to `mock: { kind: <<DERIVE>> }`
      // and has no malformation fault class. `setup` was ABSENT, and the only
      // mention of it that reaches an item is `proposal.cite.fields`'s
      // `setup[].from.arm` - a field named inside a rule about a DIFFERENT
      // field, with no shape anywhere on the page. The author is told the key
      // exists and left to guess what one entry is, and 18 rows measured over
      // the run logs on this machine guessed a two-field entry with the prose
      // and the directive collapsed into one - see `validate.mjs`'s
      // `applyShapeFault` for the split and the counts.
      //
      // AN EMPTY ARRAY AND NOT A SENTINELLED ENTRY. A precondition is not
      // demanded the way a boundary answer is - most rows have none - so a
      // slot the author had to fill would buy a fabricated precondition per
      // row, which is worse than the shape error. What an empty array buys is
      // that the key is ON the row when `steps/derive.mjs`'s `fillSkeleton`
      // spreads it onto the item, that it is visibly an ARRAY, and that an
      // author with a precondition appends to something rather than inventing
      // a key. The ENTRY's shape is in the note below and in
      // `validate.mjs --schema`, whose `## vocabularies` block is the one
      // `readSchema` puts on every item.
      setup: [],
    });
  }

  return {
    stage: "3-proposals",
    authoredBy: "agent",
    note:
      `SKELETON from worklist.mjs --skeleton. Every address is filled in: function ids, arm ids, ` +
      `side labels, boundary symbols and modules, one args slot per declared parameter. Fill VALUES ONLY. ` +
      `Every "${SKELETON_TODO}" is a refusal until you replace it, and an args entry needs a \`value\` ` +
      `(a literal) or a \`build\` (a JS expression) - \`build\` wins when both are present. ` +
      `args[] is positional in the order given by \`functionSignatures\`, which no tool reads and is here ` +
      `so the shape you must construct is on the page. ` +
      `Every boundary the row must answer is on the row, under \`boundaries\`, cited from this row's own arm - ` +
      `\`from.arm\` must name an arm the row lists in \`covers\`, so do not repoint one at a sibling. ` +
      `\`functionBoundaries\` is the function-level declaration of the collaborators it CALLS: a row that ` +
      `deletes its own block inherits from there, and \`"<symbol>": null\` says this row does not answer it. ` +
      `\`setup\` is EMPTY and stays empty unless the row needs a precondition arranged before the call. One ` +
      `entry has THREE fields, and \`apply\` is an OBJECT whose KEY is the directive kind, never the bare ` +
      `word: ${setupEntryExample("call", "<an arm this row covers>")}. ` +
      `One row per uncovered SIDE: merge rows freely, since one call takes one side of every point it ` +
      `passes through. There is no field for an expected output and there must not be - stage 4 records it.`,
    window: {
      offset,
      batch,
      rows: proposals.length,
      rowsTotal: flat.length,
      functions: Object.keys(functionSignatures).length || new Set(window.map((r) => r.g.owner.functionId)).size,
      functionsTotal: groups.length,
      // A function whose rows STRADDLE this window is named, because the
      // author needs to know the rest of it is on the next page rather than
      // missing.
      straddling: [...new Set(window.map((r) => r.g.owner.functionId))].filter((id) => {
        const inWindow = window.filter((r) => r.g.owner.functionId === id).length;
        const total = flat.filter((r) => r.g.owner.functionId === id).length;
        return inWindow < total;
      }),
      next: offset + window.length < flat.length ? `--offset ${offset + window.length}` : null,
    },
    functionSignatures,
    functionBoundaries,
    proposals,
  };
}

function writeMarkdown(groups, summary) {
  const lines = [
    "# Stage 3 brief — derive an input for each uncovered arm",
    "",
    "Generated by `worklist.mjs`. **It contains no argument values on purpose.**",
    "Read the arm, read the service's own vocabulary (its schema, its fixtures,",
    // The PATH, correctly. This header said `out/proposals.json` while
    // `config.mjs` resolves PROPOSALS_DIR to `<pilot>/proposals` and says in
    // its own comment why it is not in out/ ("everything in out/ is
    // regenerable; proposals are hand-authored"). The stage-3 skill carries the
    // discrepancy as a documented trap, which is the wrong place for it: the
    // tool knew the real path and printed a different one, in the brief whose
    // whole job is to say where the work goes. A citation the pipeline makes
    // about ITSELF cannot be the one that is wrong.
    `its \`.env.example\`), and write the input into \`${relative(REPO_ROOT, PROPOSALS_DIR)}/<name>.json\`.`,
    "Every value must cite the arm and the file it came from — `validate.mjs`",
    "rejects a proposal that cannot say where its value is from.",
    "",
    "`worklist.mjs --skeleton` prints that file with every address already in",
    "it — arm ids, side labels, boundary symbols, one `args` slot per declared",
    "parameter. Start from it: the labels below are join keys matched",
    "byte-exactly, and pre-filling them is the only way to not mistype one.",
    "",
    "Three things here are quoted from source and are still not values to",
    "paste: a `##` heading is a function **id**, an `arm` is an **arm id**, and",
    "an `uncovered side` is a **label** — all three are addresses your proposal",
    "must match byte-for-byte. Param names are collapsed to their binding names",
    "and a cell showing `(N B)` after it was **cut**; N is its full length.",
    "",
    // TWO DENOMINATORS, one screen apart, and only one of them ratchets. This
    // block printed "uncovered arms: 132" while the summary printed
    // "uncovered sides 51", and nothing said which figure a coverage claim is
    // allowed to quote. The arm count includes function-entry, statement and
    // `catch` units - real work that istanbul's BRANCH map cannot verify - so a
    // percentage over it is a percentage over a denominator no oracle shares.
    // Every number here now says whether it ratchets.
    `- **uncovered SIDES: ${summary.uncoveredSidesMeasured}** — the ratchetable denominator. Coverage is quoted over this and nothing else.`,
    `- uncovered WORK UNITS: ${summary.uncoveredArms} across ${summary.functions} functions — arms plus ${summary.functionEntryUnits} function entries, ${summary.statementUnits} statements and ${summary.notInstrumentedArms} \`catch\` arms. Commissionable, **not** ratchetable.`,
    `- behind an own entry: ${summary.reachableArms} units (start here)`,
    `- reachable only through a caller: ${summary.unreachableArms} units`,
    "",
    "---",
    "",
  ];

  for (const g of groups) {
    lines.push(`## ${g.owner.functionId}`, "");
    lines.push("```", entryLine(g.owner.entry), "```", "");

    if (g.owner.params.length) {
      lines.push("| param | type | optional |", "|---|---|---|");
      for (const p of g.owner.params) {
        // The name COLLAPSED to its binding names and the type CAPPED with its
        // true length. This line printed both raw: 15 cells on ptp-be carried
        // ` = ` and a default value, 178 carried newlines that destroyed the
        // row, and the type was cut at 90 with no marker, so a 16,233-byte
        // inferred type reached the brief looking like a complete signature.
        lines.push(`| ${mdCell(paramName(p.name), NAME_CAP)} | ${mdType(p.type)} | ${p.optional ? "yes" : "no"} |`);
      }
      lines.push("");
    }

    if (g.boundaries.length) {
      lines.push("Boundaries it touches — stage 4 has to answer every one of these:", "");
      for (const b of g.boundaries) lines.push(`- \`${b.symbol}\` from \`${b.module}\``);
      lines.push("");
    }

    lines.push("| arm | line | uncovered side | source |", "|---|---|---|---|");
    for (const a of g.arms) {
      // The SIDE stays verbatim - it is the label a proposal has to name and
      // validate.mjs matches it byte-exactly, so a tidied side is a side no
      // proposal can ever claim. Stage 2 builds one `default-arg` label out of
      // a whole binding pattern (newlines included, 1 arm on
      // ai-centralization), and that row therefore still renders broken. It is
      // a stage-2 defect with its own blast radius and it is left visible
      // rather than papered over here.
      //
      // The SOURCE is the arm's own condition, literals and all - that is the
      // thing being read, not a suggested value - but it is collapsed to one
      // line and capped, because 40 arm rows on ptp-be and 653 backticked
      // source cells rendered as broken markdown.
      lines.push(
        `| \`${a.armId.split("#")[1]}\` | ${a.line} | ${a.uncoveredSides.map((s) => `\`${s}\``).join(", ") || "—"} | ${mdSource(a.source)} |`
      );
      // SAID IN THE BRIEF, not only in the JSON. The item is what a worker
      // reads; a field it never sees changes nothing. One line per operand
      // side, naming the operands to its left and the value each must take, so
      // the input is written for the whole chain rather than for the operand
      // the side is named after.
      for (const e of a.evaluatedWhen ?? []) {
        const chain = e.after
          .map((x) => `\`${mdSource(x.operand)}\` ${x.mustBe}`)
          .join(", then ");
        lines.push(
          `| | | \`${mdSource(e.side)}\` | **only evaluated when** ${chain} — an input that makes this operand true does NOT reach it unless the operands to its left short-circuit the other way |`
        );
      }
    }
    lines.push("");
  }

  writeFileSync(WORKLIST_MD, lines.join("\n"));
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // THE STAGE-3 CLOCK starts the first time the brief is built, because that is
  // the first thing stage 3 does. Measured twice on location-ms: derivation
  // consumed 47 of 75 minutes on one run and had not reached stage 4 after 62
  // on the next, both ending with zero recorded pairs. The skill already said
  // "time-box derivation"; prose does not time-box anything, so the clock is a
  // file and `validate.mjs` reads it back on every run.
  const clockPath = join(OUT_DIR, "stage3-clock.json");
  if (!existsSync(clockPath)) {
    writeFileSync(clockPath, JSON.stringify({ startedAt: new Date().toISOString() }, null, 2));
  }

  // TEETH, and they are justified by measurement rather than by frustration.
  //
  // The budget was first a paragraph in the skill: two runs ignored it. Then a
  // line in validate's summary: invisible behind 107 advisories, so run
  // 20260908T200621Z read as defiance and was not. Then printed at BOTH ends of
  // validate's output, verified in-container: run 20260908T222433Z sat 53
  // minutes over budget, read the banner ~18 times, called validate 19 times,
  // and still did not record until minute 98.
  //
  // Visibility was necessary and is not sufficient. So past the budget this
  // stops REBUILDING THE BRIEF while unrecorded proposals exist - the one move
  // that keeps deriving attractive - and names the command that moves forward.
  // Recording clears the clock (see record.mjs), so the next 3->4->5->6
  // iteration gets a fresh budget and the loop still turns.
  const budgetMin = Number(process.env.CHARPILOT_STAGE3_BUDGET_MIN ?? 25);
  const started = existsSync(clockPath) ? new Date(JSON.parse(readFileSync(clockPath, "utf8")).startedAt).getTime() : Date.now();
  const spentMin = Math.round((Date.now() - started) / 60000);
  // UNRECORDED, AND THE WORD HAS TO BE TRUE. This counted every proposal file
  // on disk and called them all unrecorded, so a directory whose every row had
  // already been recorded still tripped the brake: measured locally at 136 of
  // 136 recorded with the message still saying "8 proposal file(s) are
  // unrecorded". A brake that fires on work that is already done cannot be
  // acted on — there is nothing left to record — and the run dies with no way
  // forward.
  //
  // `behaviour.json` is what `record` writes and is the only thing that says a
  // proposal reached the recorder. Unreadable or absent means nothing has been
  // recorded, which is the honest reading of an empty disk.
  const recordedIds = (() => {
    const at = join(OUT_DIR, "behaviour.json");
    if (!existsSync(at)) return null;
    try {
      const doc = JSON.parse(readFileSync(at, "utf8"));
      const ids = new Set();
      for (const r of doc?.rows ?? []) if (r?.id) ids.add(r.id);
      for (const s of doc?.skipped ?? []) if (s?.id) ids.add(s.id);
      return ids.size ? ids : null;
    } catch {
      return null;
    }
  })();
  const proposalCount = !existsSync(PROPOSALS_DIR)
    ? 0
    : readdirSync(PROPOSALS_DIR)
        .filter((f) => f.endsWith(".json"))
        .filter((f) => {
          if (!recordedIds) return true;
          try {
            const doc = JSON.parse(readFileSync(join(PROPOSALS_DIR, f), "utf8"));
            const rows = doc?.proposals ?? (Array.isArray(doc) ? doc : []);
            // A file counts as unrecorded while ANY row in it has not reached
            // the recorder. A file with no identifiable rows counts, because
            // "cannot tell" is not "already done".
            if (!rows.length) return true;
            return rows.some((r) => !r?.id || !recordedIds.has(r.id));
          } catch {
            return true;
          }
        }).length;
  if (spentMin > budgetMin && proposalCount > 0 && !ARGV.includes("--past-budget")) {
    process.stderr.write(
      `\n✗ stage 3 has spent ${spentMin}m of a ${budgetMin}m budget and ${proposalCount} proposal file(s) are unrecorded.\n` +
        `  The brief is NOT rebuilt. Deriving more inputs cannot be the next move.\n\n` +
        `      npm run pilot:record        # record what validates; this clears the clock\n\n` +
        `  The sides still uncovered come back as the next brief, aimed by a coverage\n` +
        `  report instead of by a second reading of the same source.\n` +
        `  CHARPILOT_STAGE3_BUDGET_MIN raises the budget; --past-budget overrides once.\n`
    );
    process.exit(3);
  }
  const { scan, baseline, items, statementUnits, unmatched, notInstrumented, entryUnresolved, hitIndex, cursors, skippedArtifactSides, shard, shardDropped, probe, probeDropped, probeWanted, probeMatched } = build();
  const groups = groupByFunction(items);

  // `--skeleton` prints and WRITES NOTHING. Same reason recipes.mjs writes
  // nothing: the consumer is an agent's context window, and a skeleton on disk
  // is a smaller unread artifact. It is also not idempotent in the way
  // worklist.json is - the author edits their copy - so an artifact this tool
  // rewrote on the next run would silently discard a derivation.
  if (ARGV.includes("--skeleton")) {
    const idsFromRaw = arg("--ids-from", null);
    let selected = groups;
    if (idsFromRaw) {
      const doc = JSON.parse(readFileSync(resolve(REPO_ROOT, idsFromRaw), "utf8"));
      const ids = Array.isArray(doc) ? doc : (doc.ids ?? null);
      if (!Array.isArray(ids)) {
        throw new Error(`worklist: --ids-from ${idsFromRaw} is neither an array of ids nor an object with an "ids" array`);
      }
      const byId = new Map(groups.map((g) => [g.owner.functionId, g]));
      // The file's order is the AGENT's order - it chose it. Ids the work list
      // does not hold are REPORTED rather than dropped: a window silently
      // narrowed by a stale id file is short for a reason nobody can see.
      selected = ids.map((id) => byId.get(id)).filter(Boolean);
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) {
        process.stderr.write(
          `! ${missing.length} of ${ids.length} id(s) in ${idsFromRaw} have no uncovered unit in this work list ` +
            `(already covered, filtered out by --file, or a stale id): ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}\n`
        );
      }
    }
    const skeleton = renderSkeleton(selected, scan, {
      batch: count("--batch", 20),
      offset: count("--offset", 0),
    });
    process.stdout.write(`${JSON.stringify(skeleton, null, 2)}\n`);
    return;
  }

  // `--count-by` — the grouping, rather than the rows to build it from.
  //
  // It sits before `--fields` because the two are different projections of the
  // same list and passing both is an ambiguous instruction, not a combination:
  // refused rather than silently resolved in favour of one. Writes nothing, for
  // the same reason `--skeleton` writes nothing.
  // The PRESENCE of the flag selects this mode, not the presence of its value.
  // Keyed on the value, `--count-by` as the last argument reads as absent and
  // the tool quietly rebuilds the brief instead - a request that did something
  // else and said nothing, which is the failure this flag exists to remove.
  if (ARGV.includes("--count-by")) {
    const countByRaw = arg("--count-by", null);
    if (arg("--fields", null)) {
      throw new Error(
        "worklist: --fields and --count-by are two different projections of the same list. Pass one. " +
          "(--fields lists the rows; --count-by counts them by one field.)"
      );
    }
    const { field, groups, total } = countBy(items, countByRaw);
    if (ARGV.includes("--json")) {
      process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    } else {
      process.stdout.write(`${field}\tcount\n`);
      for (const g of groups) process.stdout.write(`${g.value}\t${g.count}\n`);
    }
    // Groups AND items, on stderr where a pipe stays clean. Two numbers because
    // they answer different questions and because their relationship is the
    // check on this output: the counts sum to the item total by construction,
    // so a reader who doubts the grouping can add it up.
    process.stderr.write(
      `# ${groups.length} group(s), ${total} item(s)${FILE_FILTER ? ` matching --file ${FILE_FILTER}` : ""}\n`
    );
    return;
  }

  // `--fields` — project the work list, because the alternative was measured.
  //
  // On one 75-minute containerized run, `node -e` was the single largest sink:
  // 936 seconds across 99 calls, almost all of them re-implementing this — open
  // worklist.json, walk `items`, pull `armId` / `owner.functionId` / `via` /
  // `boundaries`, print. Every agent wrote it again because the markdown brief
  // cuts cells at 80 characters and the JSON has no selector, so neither
  // artifact could answer "which arms do I own, and what drives them".
  //
  // TSV by default rather than JSON: the consumer is a context window, and the
  // same 46 rows cost roughly a third as many tokens without the punctuation.
  // `--json` when something downstream has to parse it.
  const fieldsRaw = arg("--fields", null);
  if (fieldsRaw) {
    const fields = String(fieldsRaw).split(",").map((f) => f.trim()).filter(Boolean);
    if (!fields.length) throw new Error("worklist: --fields needs at least one field name");
    // Dotted paths, because the addresses an agent needs live one level down:
    // `owner.functionId`, `owner.entry.reachable`. `pick` and `cell` are at
    // module scope so `--count-by` groups by exactly what this projects.
    const rows = items.map((it) => Object.fromEntries(fields.map((f) => [f, pick(it, f)])));
    if (ARGV.includes("--json")) {
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    } else {
      process.stdout.write(`${fields.join("\t")}\n`);
      for (const r of rows) process.stdout.write(`${fields.map((f) => cell(r[f])).join("\t")}\n`);
    }
    // The count goes to stderr so a pipe stays clean while a reader still sees
    // the denominator — a projection that silently returned 0 rows would read
    // as "no work" rather than as a wrong --file filter.
    process.stderr.write(`# ${rows.length} item(s)${FILE_FILTER ? ` matching --file ${FILE_FILTER}` : ""}\n`);
    return;
  }

  // Reconcile against the SAME report the arms were joined to. Comparing a
  // reloop's arm count against a stale baseline would fail for the correct
  // reason (they differ) and give the wrong instruction (fix the join).
  const srcSummary = readArtifact(join(COVERAGE_SRC, "coverage-summary.json"), COVERAGE_PRODUCER).total.branches;
  const baselineUncovered = srcSummary.total - srcSummary.covered;

  // Measured: 20 of 20 arms that "could not be joined to an istanbul branch"
  // sit on a line a directive suppressed. There is no branch to join to,
  // because a person removed it on purpose - so `no matching istanbul branch`
  // was reporting a deliberate decision as a mystery, and the fallback then
  // counted every one of their sides as uncovered work. That is C3 again, the
  // ledger's missing `suppressed` state, showing up in a different tool.
  const suppressedLines = new Set();
  let suppressionError = null;
  {
    // `priced()` resolves its argument against REPO_ROOT, so it must be handed a
    // REPO-RELATIVE dir. Passing the absolute COVERAGE_SRC made it read a path
    // that does not exist and report 0 suppressed lines - and an earlier
    // try/catch here turned that into a silent zero, which is the inversion
    // this repo keeps hitting: a clean number produced by measuring nothing.
    // So the failure is captured and PRINTED instead.
    const { rows, error } = priced(relative(REPO_ROOT, COVERAGE_SRC));
    suppressionError = error ?? null;
    for (const r of rows) for (const g of r.lines) suppressedLines.add(`${r.file}:${g.line}`);
  }
  const isSuppressed = (armId) => {
    const [file, rest] = String(armId).split("#");
    return suppressedLines.has(`${file}:${Number(String(rest).split(":")[0])}`);
  };
  for (const u of unmatched) {
    if (isSuppressed(u.armId)) u.reason = "suppressed by an istanbul directive - there is no branch to join to";
  }
  const suppressedArms = unmatched.filter((u) => isSuppressed(u.armId));
  const unmatchedIds = new Set(unmatched.map((u) => u.armId));
  const suppressedIds = new Set(suppressedArms.map((u) => u.armId));
  const reachableArms = items.filter((i) => i.owner.entry.reachable).length;
  const summary = {
    // WITHIN THE SHARD, when one is set. Named so a reader of worklist.json
    // cannot mistake a shard's count for the service's: `shard` is null on an
    // unsharded run, and `shardExcluded` says how many uncovered sides exist
    // outside it. Without those two fields a shard's 400 and a whole repo's 400
    // are the same number on the page.
    shard: shard ?? null,
    shardExcluded: shardDropped,
    // THE PROBE, said the same way and for the same reason. `probe` is null on
    // an ordinary run; `probeExcluded` is how many uncovered sides the list
    // removed, so a probe's 5 and a service's 5 are not the same number on the
    // page. `probeFunctionsRequested` against `probeFunctionsMatched` is the
    // other half a reader needs: a list of twelve that matched four is a scan
    // that has moved under the list, and without both numbers that reads as a
    // repo with eight closed functions.
    probe: probe ?? null,
    probeExcluded: probeDropped,
    probeFunctionsRequested: probeWanted,
    probeFunctionsMatched: probeMatched,
    uncoveredArms: items.length,
    functions: groups.length,
    reachableArms,
    unreachableArms: items.length - reachableArms,
    unmatchedArms: unmatched.length,
    notInstrumentedArms: notInstrumented,
    functionEntryUnits: items.filter((i) => i.kind === "function-entry").length,
    functionEntryUnitsReachable: items.filter(
      (i) => i.kind === "function-entry" && i.owner.entry.reachable
    ).length,
    moduleScopeUnits: items.filter((i) => i.moduleScope).length,
    entryUnresolved: entryUnresolved.length,
    entryUnresolvedIds: entryUnresolved.slice(0, 20),
    statementUnits: items.filter((i) => i.kind === "statement").length,
    statementUnitsReachable: items.filter((i) => i.kind === "statement" && i.owner.entry.reachable).length,
    // THREE numbers, because they are three different things, and folding them
    // into one is what left this stage unable to certify itself.
    //
    // An arm whose join FAILED falls back to `arm.labels`, i.e. every side it
    // has - see the `cov.known ? ... : ...` above. So a join failure INFLATES
    // the list, and the old self-check compared measured-plus-unknown against
    // coverage's measured-only, then blamed the join for "dropping work". It
    // was adding work. Measured: 3 joined + 39 unjoined = 42, against
    // coverage's 3 - and the 3 agree exactly.
    uncoveredSidesMeasured: items
      .filter((i) => i.instrumented && !unmatchedIds.has(i.armId))
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
    sidesSuppressed: items
      .filter((i) => i.instrumented && suppressedIds.has(i.armId))
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
    sidesUnknownUnjoined: items
      .filter((i) => i.instrumented && unmatchedIds.has(i.armId) && !suppressedIds.has(i.armId))
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
    uncoveredSides: items.filter((i) => i.instrumented).reduce((n, i) => n + i.uncoveredSides.length, 0),
    laneUnit: items
      .filter((i) => i.instrumented && i.lane !== "integration")
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
    laneIntegration: items
      .filter((i) => i.instrumented && i.lane === "integration")
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
    triggerDriven: items
      .filter((i) => i.instrumented && i.via?.kind === "trigger")
      .reduce((n, i) => n + i.uncoveredSides.length, 0),
  };

  writeFileSync(
    WORKLIST_JSON,
    JSON.stringify(
      {
        stage: "3-worklist",
        generatedAt: new Date().toISOString(),
        summary,
        unmatched,
        items,
        // THE CATALOGUE, beside the work list and not inside it. `items` answers
        // "what is left"; this answers "does this id exist", and only the second
        // may be used to decide that a reference is stale. armids.mjs and
        // validate.mjs read it for exactly that.
        statementUnits: statementUnits.map((u) => ({ armId: u.armId, file: u.file, line: u.line, covered: u.covered })),
      },
      null,
      2
    )
  );
  writeMarkdown(groups, summary);

  process.stdout.write(
    `\n✓ worklist → ${relative(REPO_ROOT, WORKLIST_JSON)}  +  ${relative(REPO_ROOT, WORKLIST_MD)}\n` +
      // Which of these two a percentage may be quoted over, said on the lines
      // themselves. They differ by every unit istanbul's branch map cannot
      // verify, and the difference is not small: on this repo 820 units against
      // 444 sides.
      `    uncovered SIDES    ${summary.uncoveredSidesMeasured}  ← RATCHETS. The only denominator a coverage number may be quoted over.  (${relative(REPO_ROOT, COVERAGE_SRC)} says ${baselineUncovered} — these must match)\n` +
      `    uncovered UNITS    ${summary.uncoveredArms} across ${summary.functions} functions  ← commissionable, does NOT ratchet (adds entries, statements and catch arms)\n` +
      `    behind own entry   ${summary.reachableArms} units  ← the agent's work list\n` +
      `    only via a caller  ${summary.unreachableArms} units\n` +
      `    sides suppressed   ${summary.sidesSuppressed}  a directive removed the branch, so there is nothing to join — ruled, not work\n` +
      `    sides UNKNOWN      ${summary.sidesUnknownUnjoined}  the arm did not join and is NOT suppressed — a real join defect\n` +
      `    catch arms         ${summary.notInstrumentedArms}  (real work, but coverage cannot ratchet them)\n` +
      `    function entries   ${summary.functionEntryUnits} never invoked (${summary.functionEntryUnitsReachable} callable at their own id)\n` +
      `    module-scope arms  ${summary.moduleScopeUnits} (import-time, no owning function)\n` +
      `    entry unresolved   ${summary.entryUnresolved} function(s) istanbul has no line for — reported, not dropped\n` +
      `    statements         ${summary.statementUnits} never executed (${summary.statementUnitsReachable} callable at their own id)  ← commissionable, NOT ratchetable\n` +
      `    unjoined arms      ${summary.unmatchedArms}\n` +
      `    lanes              unit ${summary.laneUnit} sides · integration ${summary.laneIntegration} sides\n` +
      `    trigger-driven     ${summary.triggerDriven} sides (framework-invoked: no caller, a named trigger)\n`
  );

  // WHAT THE SELECTOR TOOK OUT, on the page and not only in the JSON. The
  // numbers above are the run's, and on a probe they are a dozen functions'
  // worth — a reader who does not know a selector is on reads them as the
  // service's and concludes the repo is nearly closed.
  if (summary.probe) {
    process.stdout.write(
      `\n· CHARPILOT_PROBE_FUNCTIONS=${summary.probe} selected ${summary.probeFunctionsMatched} of the ` +
        `${summary.probeFunctionsRequested} function(s) it names and excluded ${summary.probeExcluded} uncovered side(s) ` +
        `outside them. The counts above are the PROBE's, not the service's; the denominator and the reconcile are ` +
        `still the whole service, which is why the self-check below adds the excluded sides back.\n`
    );
  }

  // Transpile artifacts are in istanbul's denominator and are NOT work: a
  // downlevelled enum emits `X || (X = {})` and no input can take arm 2. They
  // are skipped when building items, so the self-check has to subtract them or
  // it fails for the one reason that is not a defect. On location-ms that is
  // exactly the residual 4 sides after module-scope arms were added.
  // What the build DECLINED, counted by the build itself rather than
  // re-derived here. Re-deriving it produced `3 - 8 = -5` on this repo, because
  // it subtracted every artifact side from a count that holds only UNCOVERED
  // ones. `emitted + skipped == report` is true by construction or it is a real
  // defect - there is no third possibility for the arithmetic to hide in.
  const artifactSides = skippedArtifactSides + decoratorMetadataSides(scan, readCoverageFinal(), REPO_ROOT);
  if (artifactSides) {
    process.stdout.write(
      `    transpile artifacts ${artifactSides} uncovered side(s) this build DECLINED - no input can take arm 2; counted into the check\n`
    );
  }
  // THE SHARD IS NOT A JOIN DEFECT. `uncoveredSidesMeasured` counts the items
  // this run will ASK about, and a shard deliberately removes some of them,
  // while `baselineUncovered` is and must remain the whole service -- that is
  // the point of narrowing the questions without touching the denominator. Add
  // the excluded sides back before comparing, or every sharded run reports
  // "a real join defect" against a number it was told to exclude from. Measured
  // on run 20260918T073111Z: 865 measured against 8,550 recorded, which is the
  // shard working exactly as intended.
  const shardedOut = Number(summary.shardExcluded) || 0;
  // AND NEITHER IS THE PROBE, for the identical reason. `CHARPILOT_PROBE_FUNCTIONS`
  // removes items on purpose — every side outside the sampled functions — so its
  // exclusions are added back before comparing, exactly as the shard's are.
  // Leaving it out of this sum is the same defect wearing a different name: on
  // contact-ms a twelve-function probe measures 5 sides against 53 recorded, and
  // an unaccounted selector would call that a join defect and refuse the run.
  const probedOut = Number(summary.probeExcluded) || 0;
  if (summary.uncoveredSidesMeasured + artifactSides + shardedOut + probedOut !== baselineUncovered) {
    console.error(
      `\n✗ worklist measures ${summary.uncoveredSidesMeasured} uncovered sides where ` +
        `${relative(REPO_ROOT, COVERAGE_SRC)} recorded ${baselineUncovered}` +
        `${artifactSides ? `, and this build declined ${artifactSides} uncovered transpile-artifact side(s)` : ""}` +
        `${shardedOut ? `, and CHARPILOT_SHARD excluded ${shardedOut}` : ""}` +
        `${probedOut ? `, and CHARPILOT_PROBE_FUNCTIONS excluded ${probedOut}` : ""}` +
        ` - so ${summary.uncoveredSidesMeasured}${artifactSides ? ` + ${artifactSides}` : ""}${shardedOut ? ` + ${shardedOut}` : ""}${probedOut ? ` + ${probedOut}` : ""} should equal ${baselineUncovered}. ` +
        `These count the same thing, so a difference is a real join defect. Fix it before deriving inputs.`
    );
    process.exit(1);
  }
  if (suppressionError) {
    process.stdout.write(
      `\n! could not price suppressions, so every suppressed arm below reads as an UNKNOWN join failure: ${suppressionError}\n`
    );
  }
  if (summary.sidesSuppressed) {
    process.stdout.write(
      `\n· ${summary.sidesSuppressed} side(s) across ${suppressedArms.length} arm(s) are SUPPRESSED, not uncovered: ` +
        `a directive removed the branch, so there is nothing for the join to find. They are ruled decisions, not work - ` +
        `\`npm run pilot:suppressions\` prices them.\n`
    );
  }
  if (summary.sidesUnknownUnjoined) {
    // Not a failure of this stage, and not work to derive: the arm exists, the
    // branch exists, and the join between them did not resolve - so whether
    // those sides are covered is UNKNOWN. Deriving inputs for them writes tests
    // for arms that may already be covered.
    process.stdout.write(
      `\n! ${summary.sidesUnknownUnjoined} side(s) across ${unmatched.length} arm(s) are UNKNOWN, not uncovered: ` +
        `the arm could not be joined to an istanbul branch, so the fallback reports every side as uncovered. ` +
        `Repair the join before deriving anything for them.\n`
    );
  }

  if (unmatched.length) {
    process.stdout.write("\n  arms that could not be joined to an istanbul branch:\n");
    for (const u of unmatched.slice(0, 10)) process.stdout.write(`    ${u.armId} — ${u.reason}\n`);
    if (unmatched.length > 10) process.stdout.write(`    … ${unmatched.length - 10} more\n`);
  }
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