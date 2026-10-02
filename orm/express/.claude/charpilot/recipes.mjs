#!/usr/bin/env node
/**
 * Stage 3's brief, in slices an agent can actually read.
 *
 * Stage 3 is the agent's stage: it reads a brief and writes an INPUT per
 * target. On the biggest target in the fleet the brief stopped being readable:
 *
 *   qode-ptp-ms  out/scan.json      15M   (6948 functions)
 *                out/worklist.json  32M
 *                out/worklist.md    3.3M
 *
 * No agent reads 3.3M of markdown, and nothing downstream noticed - the brief
 * was "generated", so it was treated as delivered. A brief that cannot be read
 * is the same defect as a coverage number without its denominator: it looks
 * like work was handed over when nothing was.
 *
 * What an agent needs to make a function INVOCABLE is small: the id, where it
 * is, how you call it, what it takes, and - when you cannot call it directly -
 * which driver or trigger reaches it. Nothing else. MEASURED on those same 6948
 * functions, a 40-function batch of this tool's output is
 *
 *   markdown  11,691 bytes  (292 B/function)   34,233 bytes as --json
 *
 * and EVERY offset (all 174 of them, both formats) was swept: markdown
 * 7,433-25,134 bytes per batch, --json 16,046-58,736. So the window is bounded
 * rather than merely usually-small. 3.3M became 11.7KB; that is readable, and
 * it is the whole point of the tool.
 *
 * Those figures PREDATE the five-line pointer to `worklist.mjs --skeleton` in
 * the markdown header, which is a fixed cost measured at 374 bytes per batch -
 * so read the markdown range as 7,807-25,508. A bound whose output has changed
 * since it was measured is exactly the stale artifact this pipeline keeps
 * paying for, and 374 is a number rather than a shrug.
 *
 * That range is the real one. The header used to claim "10.0-21.2KB", measured
 * over a sweep that had been narrowed, while the true max was 25,778 bytes and
 * 185 offsets breached the figure being advertised - a bound is not a bound
 * until the thing that could breach it has been capped, and three fields could:
 * a param type (16,233 bytes), a constructor's argument list (a 2,651-byte
 * line) and a driver list (1,864). All three are capped through novalues.mjs
 * now, which is what pulled the longest line in the whole pool from 2,651 down
 * to 261.
 *
 *   cd <target> && node .claude/charpilot/recipes.mjs [--batch 40] [--offset 0]
 *                                                     [--ids-from <file>]
 *                                                     [--file <substring>]
 *                                                     [--id <functionId>]
 *                                                     [--callable-only] [--json]
 *
 * `--file` and `--id` are the SCAN QUERY, and they are here rather than in
 * scan.mjs or worklist.mjs for the reason the next paragraph gives: this is
 * already the tool that reads out/scan.json and only that. scan.mjs would have
 * to re-walk the AST to answer, and worklist.mjs would drag the coverage join
 * into a question that has nothing to do with what the suite hit.
 *
 * Measured on run 20260915T033521Z: 20 of its calls open out/scan.json in a
 * `node -e` or a `python3 -c` heredoc, and 16 of those filter by file or by
 * function id - `for fn in d['functions']: if 'md5.ts' in fn['file']: print(fn['id'])`,
 * written again by every agent because nothing pointed at this tool. The other
 * four ask what shape the file is, which is a question only someone writing
 * such a parser has.
 *
 * Both REFUSE an address that matches nothing, unlike `--ids-from`, which
 * reports stale ids and carries on. The difference is what was asked: a bulk
 * window may legitimately have gone stale in part, but `--file md5.ts` naming a
 * file with no scanned function is either a typo or a scan that is out of date,
 * and printing an empty brief for it says "this file has no functions" - a
 * wrong answer that reads as finished.
 *
 * Reads out/scan.json and NOTHING else. Not worklist.json (32M, and joining it
 * to answer "how do I call this" would re-import the very cost this tool
 * exists to avoid), and no coverage report - invocability is a property of the
 * AST, not of what the suite happened to hit, so there is nothing to join.
 *
 * It writes no file. Output goes to stdout, because the consumer is an agent's
 * context window and a file on disk would just be a smaller unread artifact.
 *
 * THE ONE RULE: no argument VALUES, ever. The agent derives inputs and the
 * machine records outputs; a brief that suggests a value has already made the
 * derivation for it, and stage 4 would then record the tool's guess as the
 * service's behaviour. Types and names only.
 *
 * FIVE fields in the allowed set can carry a literal out of the source anyway,
 * and three more are unbounded - `novalues.mjs` names all eight with the
 * measured count of each. Every one of them is rendered through that module,
 * and so is worklist.mjs's copy of this brief: two renderers of the same fields
 * had drifted to different answers about what counts as a leak, which is why
 * the sanitisers live in one importable place instead of here.
 */
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { REPO_ROOT, SCAN_JSON } from "./config.mjs";
import {
  capped,
  ctorArgs,
  displayName,
  driverList,
  mdCell,
  mdType,
  NAME_CAP,
  oneLine,
  paramName,
  sanitiseVia,
  TYPE_CAP,
} from "./novalues.mjs";

/**
 * Where the scan actually is, as a path an agent can open.
 *
 * This tool said `out/scan.json` in its header AND in the `--json` envelope's
 * `source`, while the file is at `.claude/charpilot/out/scan.json` - so the one
 * citation the brief made about itself pointed at nothing. A brief that
 * misquotes its own source teaches the agent that citations here are
 * decorative, in the pipeline whose stage-3 gate is a citation check.
 */
const SCAN_CITE = relative(REPO_ROOT, SCAN_JSON);

const ARGV = process.argv.slice(2);

/**
 * `indexOf` returns -1 when the flag is absent, so the obvious
 * `ARGV[ARGV.indexOf(f) + 1]` reads ARGV[0] - the first argument, whatever it
 * is. worklist.mjs shipped that bug: adding a second flag turned its file
 * filter into the string "--coverage-dir" and it reported 0 uncovered arms
 * against a report holding 268. Guard the -1.
 */
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};

/**
 * Every value given for a REPEATABLE flag, in the order it was written.
 *
 * `--id` is repeatable because a function id is not splittable: ids quote
 * source, and `<arg0 of fetch(a, b)>` carries a comma. Splitting a
 * comma-separated list would cut such an id in half, and half an id joins to
 * nothing - the same failure `driverList` exists to avoid.
 *
 * A value that is missing or is itself a flag is refused. `--id --json` would
 * otherwise look for a function called "--json", find none, and refuse for the
 * right reason with the wrong sentence.
 */
function every(flag) {
  const out = [];
  for (let i = 0; i < ARGV.length; i += 1) {
    if (ARGV[i] !== flag) continue;
    const value = ARGV[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`recipes: ${flag} needs a value, got ${JSON.stringify(value ?? null)}`);
    }
    out.push(value);
  }
  return out;
}

/**
 * A window bound must be a non-negative integer or the run refuses.
 * `Number("--json")` is NaN, and `slice(NaN, NaN)` returns an empty array - so
 * a typo'd flag would print a perfectly formatted brief containing zero
 * functions and a footer claiming that was the window.
 */
function count(flag, dflt) {
  const raw = arg(flag, null);
  if (raw === null) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`recipes: ${flag} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** The seven fields, and nothing else. The point of this tool is the size. */
const SLICE = ["id", "file", "line", "name", "entry", "params", "via"];

/**
 * The call recipe, mirroring worklist.mjs's `entryLine`.
 *
 * Deliberately a copy and not an import: worklist.mjs does not export it, and
 * importing worklist.mjs would pull armjoin.mjs and suppressions.mjs - the
 * coverage-report readers - into a tool whose whole claim is that it reads
 * scan.json alone. If the shapes ever diverge, this is the one to change; the
 * scan writes `entry.kind`, and both readers switch on it.
 *
 * `ctorParams` renders through `ctorArgs` as `name: type`. Those are parameter
 * names and TYPES off the AST, never values - the agent still has to derive
 * what to construct it with. Both entryLines got that list raw until one
 * ptp-be constructor rendered 2509 bytes of inferred type on a single line, so
 * the list is now built by the one shared helper.
 */
function entryLine(entry) {
  switch (entry.kind) {
    case "import-named":
      return `import { ${entry.symbol} } from "${entry.module}"`;
    case "import-default":
      return `import mod from "${entry.module}"`;
    case "import-named-property":
      return `import { ${entry.symbol} } from "${entry.module}"  →  ${entry.symbol}.${entry.property}(…)`;
    case "class-method":
      return `new ${entry.className}(${ctorArgs(entry.ctorParams)}).${entry.member}(…)   from "${entry.module}"`;
    case "class-static":
      return `${entry.className}.${entry.member}(…)   from "${entry.module}"`;
    default:
      return `NO OWN ENTRY (${entry.kind}) — ${oneLine(entry.reason)}`;
  }
}

/**
 * How a function that has no own entry is reached: the driver, or the trigger.
 *
 * A function with `entry.reachable === false` gets this INSTEAD of a recipe,
 * because a recipe for it would be a lie - there is no import that calls it.
 * `via.driver` is a single caller, `via.drivers` several (the scan marks that
 * case `ambiguous`), `via.kind === "trigger"` means nothing calls it at all
 * and something has to happen for it to run.
 *
 * The driver list is BOUNDED by `driverList`: one ptp-be function resolves 14
 * drivers, 1798 bytes once each id is backticked and joined with " or ", on a
 * line in a brief that budgets ~280 bytes for the whole function. Whole ids are
 * dropped and counted rather than one id cut in half - half an id joins to
 * nothing, and every id still printed is one the agent can declare and pass
 * validate.mjs with.
 */
function viaLine(fn) {
  const via = fn.via;
  if (!via) return `NOT CALLABLE (${fn.entry.kind}) — no driver resolved; ${oneLine(fn.entry.reason)}`;
  if (via.kind === "trigger") {
    return `NOT CALLABLE — trigger \`${via.trigger}\`: ${oneLine(via.how)}`;
  }
  const how = driverList(via.drivers ?? [via.driver]);
  return `NOT CALLABLE — ${via.kind} via ${how}${via.confidence === "ambiguous" ? " (ambiguous: any of these)" : ""}`;
}

/**
 * The pool: every function in the scan, after --ids-from and --callable-only.
 *
 * Ids named by --ids-from that the scan does not have are RETURNED, not
 * dropped. A window silently narrowed by a stale id file produces a batch that
 * is short for a reason nobody can see, and this pipeline has been bitten
 * enough times by a clean number measured over nothing.
 */
export function pool({ idsFrom = null, callableOnly = false, scanPath = SCAN_JSON, fileFilter = null, ids = null } = {}) {
  if (!existsSync(scanPath)) {
    throw new Error(
      `recipes: no scan at ${scanPath} - run stage 2 (\`npm run pilot:scan\`) from the repo root first.`
    );
  }
  const scan = JSON.parse(readFileSync(scanPath, "utf8"));
  const all = scan.functions ?? [];
  const scanTotal = all.length;

  let selected = all;
  let missingIds = [];
  // `--id` and `--ids-from` are two different pools, not two filters on one.
  // Silently intersecting them would answer a question neither was asked.
  if (ids?.length && idsFrom) {
    throw new Error("recipes: --id and --ids-from each select the pool. Pass one.");
  }
  if (ids?.length) {
    const byId = new Map(all.map((f) => [f.id, f]));
    // REFUSED, where --ids-from reports and carries on: an id named on the
    // command line is one address the caller means, and an empty brief for it
    // reads as "this function has no recipe" rather than "no such function".
    const absent = ids.filter((id) => !byId.has(id));
    if (absent.length) {
      throw new Error(
        `recipes: --id names ${absent.length} function(s) the scan does not hold: ${absent.join(", ")}. ` +
          `An id is a byte-exact address - if the source moved, re-run stage 2 (\`npm run pilot:scan\`); ` +
          `\`--file <substring>\` finds the current id.`
      );
    }
    selected = ids.map((id) => byId.get(id));
  }
  if (idsFrom) {
    const doc = JSON.parse(readFileSync(idsFrom, "utf8"));
    const ids = Array.isArray(doc) ? doc : (doc.ids ?? null);
    if (!Array.isArray(ids)) {
      throw new Error(`recipes: --ids-from ${idsFrom} is neither an array of ids nor an object with an "ids" array`);
    }
    const byId = new Map(all.map((f) => [f.id, f]));
    // The file's order is the AGENT's order - it chose it. Keep it.
    selected = ids.map((id) => byId.get(id)).filter(Boolean);
    missingIds = ids.filter((id) => !byId.has(id));
  }

  // The file filter runs on whatever the pool already is, so `--file` narrows
  // an `--ids-from` window rather than replacing it.
  let fileMatched = null;
  if (fileFilter !== null && fileFilter !== undefined) {
    if (!String(fileFilter).trim()) throw new Error("recipes: --file needs a path substring, e.g. --file md5.ts");
    const before = selected.length;
    selected = selected.filter((f) => String(f.file ?? "").includes(fileFilter));
    fileMatched = selected.length;
    // A filter that matched nothing is REFUSED, not printed as an empty brief.
    // "No function in this file" and "that is not the path" are different
    // answers, and only one of them means stop looking.
    if (!selected.length) {
      throw new Error(
        `recipes: --file ${fileFilter} matched none of the ${before} function(s) in ${SCAN_CITE}. ` +
          `Either the substring is wrong or the scan predates the file - an empty brief would say neither.`
      );
    }
  }

  const beforeCallable = selected.length;
  if (callableOnly) selected = selected.filter((f) => f.entry?.reachable === true);

  return { selected, scanTotal, missingIds, fileMatched, droppedNotCallable: beforeCallable - selected.length };
}

/**
 * Keep the seven fields. Everything else in a scan function is why it is 15M.
 *
 * FOUR of the seven need sanitising and every one of them was measured on
 * qode-ptp-ms rather than guessed at. `novalues.mjs` carries the case for each;
 * what matters here is that the JSON gets exactly the same treatment as the
 * markdown. The no-values rule is not a property of the markdown renderer - a
 * JSON consumer feeding this to an agent hands over the same route strings, the
 * same defaults and the same 16KB type.
 *
 *   - `name` is stripped: 93 of the 6948 quote the call they were an argument
 *     to, one of them naming an env var that holds a secret.
 *   - `params[].name` is collapsed to its binding names and `params[].type` is
 *     capped and FLAGGED with its true length.
 *   - `entry.ctorParams` gets the same, because `entry` is passed through whole
 *     and one constructor carries 2489 bytes of inferred type.
 *   - `via.how` is deliterated and `via.drivers` bounded by count.
 *
 * `id` is NOT touched. It is the join key for --ids-from, the ledger and every
 * proposal; a tidied id joins to nothing.
 */
function slice(fn) {
  const out = Object.fromEntries(SLICE.map((k) => [k, fn[k]]));
  out.name = displayName(fn.name, NAME_CAP);
  if (Array.isArray(out.params)) {
    out.params = out.params.map((p) => ({ ...p, name: paramName(p.name), ...capped(p.type, "type") }));
  }
  if (out.entry && Array.isArray(out.entry.ctorParams)) {
    out.entry = {
      ...out.entry,
      ctorParams: out.entry.ctorParams.map((p) => ({ ...p, name: paramName(p.name), ...capped(p.type, "type") })),
    };
  }
  out.via = sanitiseVia(out.via);
  return out;
}

function renderMarkdown(batch, footer) {
  const lines = [
    "# Call recipes — how to invoke each function",
    "",
    `From \`${SCAN_CITE}\` only. **No argument values, by design** — types and`,
    "names are what the AST knows; the value is yours to derive and cite.",
    "",
    "This tool answers *how do I call this*. For a proposal with the addresses",
    "already in it — arm ids, side labels, boundary symbols, one `args` slot per",
    "declared parameter — run `worklist.mjs --skeleton`. It needs the coverage",
    "join, which is why it is not this tool: `covers` has to name a side that is",
    "actually uncovered, and invocability is a property of the AST alone.",
    "",
    "A heading is an `id`: an ADDRESS the ledger and your proposal must match",
    "byte-for-byte, so it is printed exactly as the scan holds it. Where an id",
    "quotes source — `<arg0 of fetch(…)>` — that text is part of the address and",
    "not a value to paste; the deliterated `name` on the line under it is the",
    "one meant for reading. A type shown with `(N B)` after it was CUT at",
    `${TYPE_CAP} characters and is N bytes long in full.`,
    "",
  ];
  for (const fn of batch) {
    // The id VERBATIM - see novalues.mjs on why this one is never sanitised -
    // and the display name under it stripped, since `name` joins nothing.
    lines.push(`## ${fn.id}`, "");
    lines.push(`\`${fn.file}:${fn.line}\` · ${mdCell(fn.name, NAME_CAP, { strip: true })}`, "");
    if (fn.entry?.reachable === true) {
      lines.push("```", entryLine(fn.entry), "```", "");
    } else {
      lines.push(viaLine(fn), "");
    }
    if (fn.params?.length) {
      lines.push("| param | type | optional |", "|---|---|---|");
      for (const p of fn.params) {
        // Both cells go through the shared cell renderer: capped at the cap
        // worklist.mjs uses, FLAGGED when cut, pipes escaped after the cap and
        // backticks fenced. An express
        // `Request<ParamsDictionary, any, any, ParsedQs, ...>` is 120+ bytes of
        // type on its own and would put a single param over the whole slice.
        lines.push(`| ${mdCell(paramName(p.name), NAME_CAP)} | ${mdType(p.type)} | ${p.optional ? "yes" : "no"} |`);
      }
      lines.push("");
    } else {
      lines.push("_no params_", "");
    }
  }
  lines.push("---", "", ...footer, "");
  return lines.join("\n");
}

/**
 * Report the size of the output INCLUDING the line that reports it.
 *
 * A byte count that excludes its own footer is off by the length of the
 * footer, which is the sort of almost-true number every other check in this
 * pipeline exists to catch. The count is rendered, measured, and re-rendered
 * until it stops changing - two passes in practice, since only the digit count
 * can move.
 */
function withByteCount(render) {
  let bytes = 0;
  for (let i = 0; i < 8; i += 1) {
    const text = render(bytes);
    const measured = Buffer.byteLength(text, "utf8");
    if (measured === bytes) return text;
    bytes = measured;
  }
  return render(bytes);
}

function main() {
  const batchSize = count("--batch", 40);
  const offset = count("--offset", 0);
  const callableOnly = ARGV.includes("--callable-only");
  const idsFromRaw = arg("--ids-from", null);
  const idsFrom = idsFromRaw ? resolve(REPO_ROOT, idsFromRaw) : null;
  // Keyed on PRESENCE, not on value: `--file` as the last argument would
  // otherwise read as absent and print the whole scan, which is the answer to a
  // different question and says nothing about the one that was asked.
  const fileFilter = ARGV.includes("--file") ? every("--file")[0] : null;
  const ids = ARGV.includes("--id") ? every("--id") : null;

  const { selected, scanTotal, missingIds, fileMatched, droppedNotCallable } = pool({
    idsFrom,
    callableOnly,
    fileFilter,
    ids,
  });
  const total = selected.length;
  // The window RAW, and the JSON projection of it. The markdown renders from
  // the raw functions on purpose: `slice` caps a type at JSON_CAP first, so
  // rendering the projection made the markdown's own "(N B)" marker report
  // 202 B for a type that is really 16,233 - a truncation flag that
  // understates by 80x is worse than none, because it reads as reassurance.
  const window = selected.slice(offset, offset + batchSize);
  const batch = window.map(slice);
  const next = offset + batchSize < total ? `--offset ${offset + batchSize}` : null;

  const notes = [];
  if (ids?.length) notes.push(`pool: ${ids.length} function(s) named by --id`);
  if (fileMatched !== null) notes.push(`--file ${fileFilter} matched ${fileMatched} of ${scanTotal} scanned function(s)`);
  if (idsFrom) notes.push(`pool: ${total} of ${scanTotal} named by ${idsFromRaw}`);
  if (callableOnly) notes.push(`--callable-only dropped ${droppedNotCallable} not reachable through an own entry`);
  if (missingIds.length) {
    notes.push(`${missingIds.length} id(s) in ${idsFromRaw} are not in the scan (stale ids): ${missingIds.slice(0, 5).join(", ")}${missingIds.length > 5 ? ", …" : ""}`);
  }

  if (ARGV.includes("--json")) {
    process.stdout.write(
      withByteCount((bytes) =>
        `${JSON.stringify(
          {
            source: SCAN_CITE,
            window: { offset, batch: batchSize, returned: batch.length, total, scanTotal, next },
            notes,
            missingIds,
            bytes,
            functions: batch,
          },
          null,
          2
        )}\n`
      )
    );
    return;
  }

  process.stdout.write(
    withByteCount((bytes) => {
      const footer = [
        `${window.length} of ${total} (offset ${offset})${next ? ` — next: ${next}` : " — end of window"}`,
        ...notes,
        `${bytes} bytes printed`,
      ];
      return renderMarkdown(window, footer);
    })
  );
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead. The gate's `tools-parse`
// check IMPORTS every tool in this directory, so a side effect at module scope
// here would run a scan read - and consume the gate's own argv - on every gate
// run.
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
