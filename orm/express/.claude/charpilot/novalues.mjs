/**
 * THE ONE RULE, in one place: a brief states a parameter's NAME and TYPE and
 * never a VALUE.
 *
 * The agent derives the INPUT and the machine records the OUTPUT. A brief that
 * hands over a plausible value has already made the derivation - the agent
 * pastes it instead of deriving one from the service's own vocabulary and
 * citing where it came from, and stage 4 then records the brief's guess as the
 * service's behaviour. `validate.mjs` rejects a proposal whose value cannot
 * cite its source; a brief that supplies the value defeats that check upstream
 * of it, where nothing is looking.
 *
 * FIVE fields the scan stores carry literals OUT OF SOURCE, every count below
 * MEASURED on qode-ptp-ms (6948 functions, 15200 uncovered arms) rather than
 * guessed at:
 *
 *   1. `params[].name` is the whole BINDING PATTERN, newlines and defaults
 *      included. 18 of those 6948 carry a default;
 *      `src/lib/server/services/langfuseService.ts:89:getResponse` stores
 *
 *          "{\n    modelName = 'gpt-4o',\n    promptName,\n    ...params\n  }"
 *
 *      so a renderer that printed the name verbatim printed
 *      `modelName = 'gpt-4o'` - an argument value, in the artifact whose one
 *      rule is that it contains none. Rendered into out/worklist.md that was
 *      15 param cells carrying 20 ` = ` occurrences on ptp-be and 3 cells
 *      carrying 4 on ai-centralization. The multi-line pattern also BREAKS the
 *      markdown row it is printed into - 178 rows on ptp-be spanned newlines,
 *      which is how this was noticed.
 *
 *   2. `via.how` quotes source. `src/app.ts:32:<arg0 of [>` on ptp-be has a
 *      686-byte `via.how` that is mostly a 30-element array of route strings
 *      lifted out of `app.use([...])`; that function's own param is just
 *      `route: string`. Whether those strings are technically arguments to the
 *      enclosing call rather than to the function under test does not matter:
 *      it READS as a suggestion.
 *
 *   3. `name` is a synthesised description for anything that has no declared
 *      name, and it quotes the call it was an argument to: 93 of the 6948 read
 *      like `<arg0 of e.split(',').map>` or
 *      `<arg0 of fetch('https://cdp.customer.io/v1/track', {>`. One of them
 *      names an env var holding a secret. `name` is a DISPLAY string - the
 *      substring of `id` after its last colon - and carries no join weight, so
 *      it is stripped.
 *
 *   4. `id` embeds the same text, because `name` is part of it (93 ids). It is
 *      NOT stripped: it is the join key for `--ids-from`, the ledger, armids
 *      and every proposal, all of which match it byte-exactly. A brief that
 *      cannot be joined back is a worse defect than a literal in a heading, so
 *      the renderers print the id verbatim and SAY that an id is an address, not
 *      an argument.
 *
 *   5. arm LABELS (`uncoveredSides`) can carry a whole binding pattern -
 *      stage 2 builds a `default-arg` label out of `node.getName()`, so one
 *      label on ai-centralization is
 *      `"{\n    maxRetry,\n    actionName,\n    delayMs,\n  } falls back to its
 *      default"`. Also NOT stripped, and for the same reason as `id`:
 *      validate.mjs matches a label byte-exactly, so a tidied label is a label
 *      no proposal can ever name. That is a stage-2 defect with its own blast
 *      radius; the renderers leave it alone rather than paper over it.
 *
 * And three fields are UNBOUNDED without being a leak:
 *
 *   - `params[].type` is whatever the checker inferred: 209 types over 2000
 *     bytes on ptp-be, the largest 16,233.
 *   - `entry.ctorParams[].type` likewise - one ptp-be constructor renders a
 *     2509-byte `name: type` list on a single markdown line.
 *   - `via.drivers` is every caller that reaches the function: 14 of them,
 *     1798 bytes once rendered.
 *
 * A brief is only delivered if it can be READ, so all three are capped - and a
 * capped field is flagged with its true length, because a truncation that does
 * not say it was truncated is worse than a long one: the consumer reads it as
 * the whole signature and derives against a type that stops mid-generic. The
 * flag belongs in BOTH formats; having it only in `--json` satisfied the rule
 * in the one format the agent does not read.
 *
 * This module exists because TWO renderers of the same two fields disagreed
 * about what counts as a leak. recipes.mjs sanitised both; worklist.mjs, which
 * writes out/worklist.md - the artifact stage 3 actually reads - sanitised
 * neither. Copying the logic into the second place would have set up the same
 * drift again, so it lives here and BOTH import it. Anything that renders
 * `name`, `params[].name`, `params[].type`, `entry.ctorParams[].name/.type`,
 * `via.how` or `via.drivers` to an agent uses these; a new renderer that does
 * not is the defect repeating itself.
 *
 * A pure library: no shebang, no main, no side effects on import - the gate's
 * `tools-parse` check imports every .mjs in this directory.
 */

/** Caps, shared so the two renderers cannot disagree about what "too long" is. */
export const NAME_CAP = 80;
export const TYPE_CAP = 90;
export const PROSE_CAP = 100;
export const SOURCE_CAP = 80;
export const JSON_CAP = 200;
/** How many of `via.drivers` a brief lists before it says "+N more"... */
export const DRIVERS_CAP = 6;
/** ...and how many characters that list may occupy, whichever binds first. */
export const DRIVERS_LENGTH_CAP = 240;

/** Truncate to exactly `cap` characters, ellipsis included, or leave it alone. */
export const truncate = (s, cap) => {
  const t = String(s ?? "");
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
};

/**
 * Strip quoted string literals out of scan prose.
 *
 * The literals go, the sentence stays: "invoked by [ '/api/x', '/api/y' ]"
 * becomes "invoked by [ …, … ]", which still says HOW the function is reached
 * and no longer says with what. Types are left alone - a type is what the AST
 * knows, and deriving against it is the agent's job.
 */
export const stripLiterals = (s) =>
  String(s ?? "")
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "…")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Walk `s` and call `at(index, char)` for every character that is at bracket
 * depth 0 and outside a string. One walker, because every scan below - split at
 * top-level commas, find the top-level `=`, find the top-level `:` - is the same
 * walk, and three hand-rolled copies would each get a different case wrong.
 *
 * Angle brackets are NOT tracked: a binding pattern has no generics, and an
 * arrow default (`= () => x`) would otherwise unbalance the depth. Depth is
 * clamped at 0 so a stray closer cannot drive it negative and silently merge
 * everything after it into one element.
 */
function walkTop(s, at) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && at(i, c) === false) return;
  }
}

/** Split at top-level commas. */
function splitTop(s) {
  const parts = [];
  let start = 0;
  walkTop(s, (i, c) => {
    if (c === ",") {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  });
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Everything before the top-level `=` that starts a DEFAULT, or all of it. */
function cutDefault(s) {
  let cut = -1;
  walkTop(s, (i, c) => {
    if (c !== "=") return;
    // `==`, `===`, `!=`, `<=`, `>=`, `=>` are operators inside a default, not
    // the assignment that introduces one.
    if (s[i + 1] === "=" || s[i + 1] === ">") return;
    if (s[i - 1] === "=" || s[i - 1] === "!" || s[i - 1] === "<" || s[i - 1] === ">") return;
    cut = i;
    return false;
  });
  return cut === -1 ? s : s.slice(0, cut);
}

/** Index of the top-level `:` that renames a destructured key, or -1. */
function topColon(s) {
  let at = -1;
  walkTop(s, (i, c) => {
    if (c !== ":") return;
    at = i;
    return false;
  });
  return at;
}

/**
 * Collapse a binding pattern to its BINDING NAMES.
 *
 *   "{ modelName = 'gpt-4o', promptName, ...params }" → "{ modelName, promptName, ...params }"
 *   "{ page = 1, q }"                                 → "{ page, q }"
 *   "{ connectionMin, language = ['EN'] }"            → "{ connectionMin, language }"
 *   "[first, second = 2]"                             → "[ first, second ]"
 *   "attempts = 3"                                    → "attempts"
 *
 * The names STAY - they are names, and the agent needs them to know the shape
 * of the object it has to build. Only the defaults go. Depth-aware, so a
 * default that itself contains a comma or a brace (`{ opts = { a: 1, b: 2 } }`)
 * is removed whole rather than cut at its first comma, which is what a plain
 * `= [^,}]+` regex does - it would leave `b: 2` behind, still a value.
 */
function collapsePattern(s) {
  const t = s.trim();
  const wrapped =
    (t.startsWith("{") && t.endsWith("}") && ["{", "}"]) ||
    (t.startsWith("[") && t.endsWith("]") && ["[", "]"]);
  if (!wrapped) return cutDefault(t).trim();
  const inner = splitTop(t.slice(1, -1)).map(collapseElement).filter(Boolean);
  return inner.length ? `${wrapped[0]} ${inner.join(", ")} ${wrapped[1]}` : `${wrapped[0]}${wrapped[1]}`;
}

function collapseElement(el) {
  const noDefault = cutDefault(el).trim();
  const colon = topColon(noDefault);
  if (colon === -1) return collapsePattern(noDefault);
  return `${noDefault.slice(0, colon).trim()}: ${collapsePattern(noDefault.slice(colon + 1))}`;
}

/**
 * A param NAME, safe to render: one line, no defaults, no literals, capped.
 *
 * `stripLiterals` runs AFTER the collapse as belt and braces - a stranger
 * pattern than anything measured (a computed key, say) can still carry a quote
 * past the collapse, and the rule holds for shapes nobody has seen yet.
 */
export const paramName = (name, cap = NAME_CAP) =>
  truncate(stripLiterals(collapsePattern(String(name ?? "").replace(/\s+/g, " ").trim())), cap);

/**
 * A param TYPE, safe to render: one line, capped, literals INTACT.
 *
 * A type is not a value. `'a' | 'b'` is the AST's own statement of what the
 * parameter accepts, and stripping it to `… | …` would delete the very thing
 * the agent derives against.
 */
export const paramType = (type, cap = TYPE_CAP) =>
  truncate(String(type ?? "").replace(/\s+/g, " ").trim(), cap);

/** Scan prose (`via.how`, `entry.reason`) on one line, delittered and capped. */
export const oneLine = (s, cap = PROSE_CAP) => truncate(stripLiterals(s), cap);

/**
 * A function's DISPLAY name, safe to render.
 *
 * `<arg0 of fetch('https://cdp.customer.io/v1/track', {>` becomes
 * `<arg0 of fetch(…, {>` - still says which call the function was an argument
 * to, no longer says with what. The `id` it came from stays verbatim wherever
 * it is printed, because that one is an address.
 */
export const displayName = (name, cap = NAME_CAP) => truncate(stripLiterals(name), cap);

/**
 * One markdown table cell, code-spanned, capped, and STRUCTURALLY SAFE.
 *
 * Three separate things break a row, and all three were measured:
 *
 *   - a NEWLINE. 305 param names on ptp-be contain one, and `.slice(0, 80)` on
 *     a multi-line string truncates mid-word and leaves the newline in, which
 *     destroyed 178 param rows and 40 arm rows. Whitespace is collapsed first.
 *   - a PIPE, which ends the cell. Escaped - and escaped AFTER the cap, since
 *     capping an escaped string can cut between the backslash and its pipe.
 *   - a BACKTICK. 653 arm-source cells and 1 param type on ptp-be contain one,
 *     and a backtick inside a single-backtick code span ends the span. The
 *     fence grows to one more backtick than the longest run inside it, which is
 *     what markdown specifies for exactly this case.
 *
 * `over` reports the true length when the cell was cut, so a reader can tell a
 * 91-byte type from a 16,233-byte one.
 */
export function mdCell(text, cap, { strip = false } = {}) {
  const full = strip ? stripLiterals(text) : String(text ?? "").replace(/\s+/g, " ").trim();
  const shown = truncate(full, cap).replace(/\|/g, "\\|");
  const longestRun = Math.max(0, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  const pad = shown.startsWith("`") || shown.endsWith("`") ? " " : "";
  const span = `${fence}${pad}${shown}${pad}${fence}`;
  return full.length > cap ? `${span} (${Buffer.byteLength(full, "utf8")} B)` : span;
}

/**
 * Capped text for a line that is NOT a table cell - a fenced entry recipe, or
 * prose. Same cap and same truncation flag as `mdCell`, without the code span:
 * inside a ``` fence a code span is noise, and the reason for the flag is the
 * same in both places.
 */
export function capFlagged(text, cap, { strip = false } = {}) {
  const full = strip ? stripLiterals(text) : String(text ?? "").replace(/\s+/g, " ").trim();
  return full.length > cap ? `${truncate(full, cap)} (${Buffer.byteLength(full, "utf8")} B)` : full;
}

/** A param/ctor TYPE in a table cell: literals intact, capped, flagged. */
export const mdType = (type, cap = TYPE_CAP) => mdCell(type, cap);

/** An arm's condition SOURCE in a table cell: literals intact - it IS the arm. */
export const mdSource = (source, cap = SOURCE_CAP) => mdCell(source, cap);

/**
 * The `name: type` argument list of a class constructor, for an entry recipe.
 *
 * Shared, because both entryLine copies rendered it raw: names undefaulted and
 * types uncapped, which is how one ptp-be constructor put a 2509-byte list on
 * a single line of a brief that advertises ~280 B per function.
 */
export const ctorArgs = (ctorParams) =>
  (ctorParams ?? []).map((p) => `${paramName(p.name)}: ${capFlagged(p.type, TYPE_CAP)}`).join(", ");

/**
 * `via.drivers` as prose, bounded twice.
 *
 * Every driver id is printed VERBATIM - it is the address the proposal has to
 * declare, and half an id joins to nothing - so the list is bounded by dropping
 * whole drivers and saying how many, never by cutting one in half.
 *
 * By COUNT and by LENGTH, because either alone leaves the line unbounded in
 * practice: 21 drivers is the most any ptp-be function resolves, but six ptp-be
 * ids are ~90 characters each, so a count-only bound still put 822 characters on
 * one line of a brief that budgets a few hundred bytes for the whole function.
 * At least one driver is always shown - a "NOT CALLABLE via (+21 more)" line
 * would name nothing at all.
 */
export function driverList(drivers, cap = DRIVERS_CAP, lengthCap = DRIVERS_LENGTH_CAP) {
  const all = (drivers ?? []).filter(Boolean);
  if (!all.length) return "no driver resolved";
  const kept = [];
  let width = 0;
  for (const d of all.slice(0, cap)) {
    const piece = `\`${d}\``;
    if (kept.length && width + piece.length + 4 > lengthCap) break;
    kept.push(piece);
    width += piece.length + 4;
  }
  const shown = kept.join(" or ");
  return kept.length < all.length ? `${shown} (+${all.length - kept.length} more)` : shown;
}

/**
 * A prose field for a JSON artifact: `{ how: "…", howTruncated: 686 }`.
 *
 * The true length is reported when it is cut, so a consumer can tell a short
 * field from a shortened one.
 */
export function capped(text, key, cap = JSON_CAP) {
  const s = String(text ?? "");
  if (s.length <= cap) return { [key]: s };
  return { [key]: truncate(s, cap), [`${key}Truncated`]: s.length };
}

/**
 * A `via` safe to hand over: `how` deliterated and capped, `drivers` bounded by
 * COUNT rather than by length.
 *
 * `kind`, `trigger`, `driver` and each surviving `drivers` entry stay VERBATIM:
 * they are addresses the agent has to quote back, and validate.mjs matches a
 * proposal's declared `via` against the scan's own list byte-exactly. Dropping
 * whole drivers keeps every one that IS printed usable, and `driversTruncated`
 * says how many were held back - the agent can still name any of the six shown
 * and pass validation.
 */
export function sanitiseVia(via, { driversCap = DRIVERS_CAP } = {}) {
  if (!via) return via;
  const out = { ...via };
  if (out.how !== undefined) Object.assign(out, capped(stripLiterals(out.how), "how"));
  if (Array.isArray(out.drivers) && out.drivers.length > driversCap) {
    out.driversTruncated = out.drivers.length;
    out.drivers = out.drivers.slice(0, driversCap);
  }
  return out;
}
