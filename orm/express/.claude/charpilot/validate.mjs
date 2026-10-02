#!/usr/bin/env node
/**
 * Stage 3, machine half — validate what the agent wrote.
 *
 * The agent authors out/proposals.json. This checks it against the worklist and
 * the scan. It cannot check that an input is CORRECT — only the run in stage 4
 * can do that. What it can do is refuse the failure mode that destroys the whole
 * exercise while looking exactly like success: values that came from nowhere.
 *
 * Every proposed value must carry provenance — the arm it was read off and the
 * file the vocabulary came from. A proposal that cannot say where its value is
 * from is rejected, not warned about.
 *
 *   node .claude/charpilot/validate.mjs
 *
 * Exits non-zero on any error.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { sideIndexOf } from "./armjoin.mjs";
import { OUT_DIR, PILOT_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
// This file is the CHECK a brief must not defeat: it rejects a proposal whose
// value cannot cite its source. Its own error messages render two of the scan
// fields that carry literals - `via.how` and `params[].name` - so they go
// through the same sanitisers the briefs use. An error message that hands the
// agent the value it just failed to cite is the leak with the shortest possible
// path from a rule to its breach.
import { oneLine, paramName } from "./novalues.mjs";

const errors = [];
const warnings = [];
/**
 * A third channel, because the gate fails on `warnings` and three of the checks
 * here fire on work that is CORRECT.
 *
 * `gate.mjs`'s `validate` check reads `errors N` and `warnings N` out of the
 * summary below and passes only on `0 && 0`. So a warning is not advice, it is
 * a refusal with a softer word on it — and measured on this repo's own 375
 * proposals, 226 of 296 warnings were the one the stage-3 skill itself
 * describes as *"the tool's blind spot, not your error"*: `answers boundary X,
 * which neither <fn> nor its driver touches`, raised because
 * `collectBoundaries` does not follow calls. Two more are the same shape: the
 * "already covered" note that `expand.mjs`'s horizontal rung EXPECTS on every
 * pick, and the `invoke.build` parse suspicion whose own text already says
 * stage 4 is the authority.
 *
 * Leaving those in `warnings` left the author two moves: delete a correct
 * boundary answer, or keep the gate red. That is the failure mode this
 * pipeline names *a check that cries wolf* — and it costs the 50 warnings that
 * ARE actionable their audience. So they are counted and printed, separately,
 * and they do not fail the gate. Nothing is hidden: the summary prints the
 * advisory count on its own line.
 */
const advisories = [];

const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
const advise = (where, msg) => advisories.push(`${where}: ${msg}`);

/**
 * Stage 4 has to EXECUTE a proposal, so every field it consumes must be a
 * program, not a sentence. Prose stays — it is the auditable reading — but each
 * prose field now needs an executable sibling:
 *
 *   args[].construct (prose)      -> args[].build   : a JS expression
 *   boundaries[].behaviour (prose) -> boundaries[].mock : a directive
 *   setup[].state (prose)          -> setup[].apply  : env / call / module / manual
 *
 * Discovered by building the recorder: 179 `construct` values were English, and
 * 77 `setup` entries were boundary answers filed in the wrong field.
 */
// `spy` is the common case and deserves to be named: a boundary whose OBSERVABLE
// is the call itself — a logger, a fire-and-forget writer, a slack notifier —
// where the return value is irrelevant. Recording "called with X" is the point.
export const MOCK_KINDS = new Set([
  "resolves", "rejects", "returns", "throws", "notCalled", "passthrough", "value", "spy",
]);

/* ---------------------------------------------------------------------------
 * WHICH KINDS INSTALL AN ANSWER IS THE RECORDER'S QUESTION, ASKED HERE EARLY.
 *
 * `MOCK_KINDS` above is the vocabulary: eight kinds this file accepts. It says
 * nothing about what stage 4 DOES with each one, and for two of them the answer
 * is "nothing". `passthrough` is defined as delegating to the real export, so a
 * `build` written beside it is never installed and the real export runs — and
 * nobody finds out here. They find out a round later, in stage 4, as a skipped
 * recording.
 *
 * MEASURED, and the measurement is `value`'s, not `passthrough`'s, because
 * `value` is the one that has already been paid for. On run `20260916T223906Z`
 * against location-ms, 233 of 393 boundary declarations carried
 * `{"kind": "value", "build": …}` under a kind the recorder then dropped along
 * with everything written beside it; the real prisma client ran, the deny proxy
 * refused it, and 122 of 136 rows died as `blocked egress`. Commit `89e4714`
 * gave `value` substitution semantics in `record.mjs`. `passthrough` did not
 * get them and must not — delegating IS its definition — so the answer for it
 * is the OTHER half of the same repair: refuse the executable answer here,
 * where it costs an edit, instead of at stage 4, where it costs a round.
 *
 * THE RULE IS READ OUT OF `record.mjs`, NOT RESTATED HERE. A second list of
 * which kinds substitute is precisely how the checker and the recorder came to
 * disagree in the first place — this file listed `value` as legal while
 * `record.mjs` dropped it, for as long as both lists existed. So the six
 * declarations below are SLICED OUT OF THE RECORDER'S SOURCE and evaluated:
 * `boundaryDisposition` answering `"dropped-with-answer"` is the whole
 * condition, and `droppedAnswerNote` writes the sentence, so an author reads
 * the same advice here that `blockedReason()` would have given them at stage 4.
 * There is no vocabulary in this file to keep in step.
 *
 * AND THE BARE FORM IS NOT AN ERROR. `migrate-executable.mjs:105-107` emits a
 * bare `{kind: "value"}` for "an env read is a value, not a call", and
 * `record.mjs` deliberately keeps it inert — nothing is substituted and
 * `setup.apply.env` is the arrangement. `boundaryDisposition` returns `"inert"`
 * for it, not `"dropped-with-answer"`, which is exactly why the condition is
 * the recorder's function and not `MOCK_KINDS.has(kind)`. The defect is an
 * EXECUTABLE ANSWER beside a kind that will not install it, never the kind.
 *
 * record.mjs is READ-ONLY to this file. Nothing here can change what the
 * recorder installs; it can only refuse earlier what the recorder would drop.
 * ------------------------------------------------------------------------ */

/** Where the recorder lives. install.sh puts every tool in one directory. */
export const RECORD_MJS = join(PILOT_DIR, "record.mjs");

/**
 * The declarations of `record.mjs` this reading depends on, in evaluation order.
 *
 * `boundaryDisposition` closes over the first three sets and over
 * `carriesAnswer`, whose `"value" in mock` subtlety — `{kind: "value", value:
 * undefined}` is a row DECLARING undefined — is itself a rule that must not be
 * copied. `droppedAnswerNote` is taken for its wording, so the sentence an
 * author reads here is the recorder's own.
 */
const DISPOSITION_DECLS = Object.freeze([
  "ACTIVE_MOCK", "OBSERVE_MOCK", "SUBSTITUTE_MOCK", "carriesAnswer", "boundaryDisposition", "droppedAnswerNote",
]);

/** The next module-scope declaration of ANY name — where one slice ends. */
const ANY_DECL = /\n(?:export\s+)?(?:async\s+)?(?:function|const|let|var)\s+[A-Za-z_$][\w$]*/g;

/** The raw text of one module-scope declaration in `source`, or null. */
function declarationSlice(source, name) {
  const re = new RegExp(`(?:^|\\n)(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`);
  const m = re.exec(source);
  if (!m) return null;
  const at = m.index + (m[0].startsWith("\n") ? 1 : 0);
  ANY_DECL.lastIndex = at + 1;
  const next = ANY_DECL.exec(source);
  return source.slice(at, next ? next.index + 1 : source.length);
}

/**
 * The recorder's own decision about one declared boundary, or a refusal.
 *
 * `{ boundaryDisposition, droppedAnswerNote, refusal: null }` when the reading
 * held, `{ refusal: "<why>" }` when it did not. A refusal is NOT an error
 * against anybody's proposal — it is this file saying it could not ask the
 * question, which is reported as an advisory and leaves the other 40-odd checks
 * running. A guess would be worse than the silence it replaced.
 */
export function recorderDisposition(recordSource) {
  const source = String(recordSource ?? "");
  const parts = [];
  const missing = [];
  for (const name of DISPOSITION_DECLS) {
    const text = declarationSlice(source, name);
    if (text === null) missing.push(name);
    else parts.push(text);
  }
  if (missing.length) {
    return {
      refusal:
        `record.mjs does not declare ${missing.join(", ")} at module scope, so this file cannot read ` +
        "which mock kinds install an answer. No rule is applied rather than a guessed one: a second " +
        "list of substituting kinds is the defect this reading exists to remove.",
    };
  }
  let loaded;
  try {
    // eslint-disable-next-line no-new-func
    loaded = new Function(`${parts.join("\n\n")}\nreturn { boundaryDisposition, droppedAnswerNote };`)();
  } catch (e) {
    return { refusal: `record.mjs's boundary disposition did not evaluate here: ${e?.message ?? e}` };
  }
  // A slice that yields the SAME answer for every kind is a slice that broke
  // quietly - which is how this whole class of defect travels. No kind is named
  // to check it; the discrimination itself is the evidence.
  const seen = new Set();
  for (const kind of MOCK_KINDS) {
    try {
      seen.add(loaded.boundaryDisposition(kind, { kind, build: "0" }));
      seen.add(loaded.boundaryDisposition(kind, { kind }));
    } catch (e) {
      return { refusal: `record.mjs's boundaryDisposition threw on a declared kind: ${e?.message ?? e}` };
    }
  }
  const known = new Set(["install", "dropped-with-answer", "inert"]);
  const strange = [...seen].filter((d) => !known.has(d));
  if (strange.length) {
    return { refusal: `record.mjs's boundaryDisposition returned ${strange.map((s) => JSON.stringify(s)).join(", ")}, which this file has no reading for` };
  }
  if (!seen.has("install")) {
    return { refusal: "record.mjs's boundaryDisposition installs nothing for any declared kind, so the slice is not the recorder's decision" };
  }
  return { ...loaded, refusal: null };
}

/** Read once, from disk, and reused by the boundary check and by `--schema`. */
let DISPOSITION = null;
function disposition() {
  if (DISPOSITION === null) {
    DISPOSITION = recorderDisposition(existsSync(RECORD_MJS) ? readFileSync(RECORD_MJS, "utf8") : "");
  }
  return DISPOSITION;
}

// HOISTED SO THERE IS ONE COPY, NOT SO IT READS BETTER.
//
// Both of these were function-local arrays, which is fine for a check and not
// fine for `--schema`: a printer that cannot see the array has to restate it,
// and a restated vocabulary is the defect this flag exists to remove. They are
// used in exactly the same places as before, by name.
/** The directives `setup[].apply` accepts. */
export const APPLY_KINDS = ["env", "call", "module", "manual", "db"];

/* ---------------------------------------------------------------------------
 * THE FIELD THIS FILE DESCRIBED WRONG, IN THE ONE DOCUMENT THAT CLAIMS TO BE
 * RIGHT WHEN IT DISAGREES WITH THE OTHERS.
 *
 * `--schema` printed the vocabulary above as
 *
 *     boundaries[<symbol>].mock.kind   resolves | rejects | returns | …
 *     setup[].apply                    env | call | module | manual | db
 *
 * Two lines, one grammar. The FIRST is true — `mock.kind` IS one of those
 * words. The SECOND is false: `apply` is not one of those words, it is an
 * OBJECT whose KEY is one of them. A worker reading the second line one line
 * after the first writes `"apply": "call"`, which is the single largest fault
 * class in the corpus.
 *
 * AND IT IS PRINTED ONTO EVERY ITEM OF EVERY PACKET. `--schema`'s output is
 * `packet.shared["proposal.schema"]`, so both lines are in front of every
 * worker on every row, under this file's own sentence *"Nothing here is
 * transcribed: if this disagrees with a document, the document is wrong"* —
 * and a packet repeats the claim in its own words (*"THE PARTITION IS PRINTED,
 * NEVER TRANSCRIBED … If it and this disagree, it is right"*). The stage-3
 * skill states the shape CORRECTLY —
 *
 *   QUOTES nodejs/skill/charpilot-stage-3-derive-input/SKILL.md: "{ env } | { call } | { module } | { manual } | { db }"
 *
 * — so the two disagreed, and the worker was told which one wins.
 *
 * THAT EXPLAINS WHAT A BETTER REFUSAL COULD NOT. The fault is repo-independent
 * (the schema is on every packet of every repo), it predates every change ever
 * blamed for it (the line is as old as `--schema`), and rewriting the refusal
 * in `2bc77ae` did not stop it (the refusal is read AFTER the row is written;
 * the schema is read BEFORE). Measured across every run log on this machine,
 * by DISTINCT ROW rather than by fault line — a bare-string `apply` used to
 * cost one row up to ten faults, which is how the same defect has been quoted
 * as 84, 63, 27 and 18:
 *
 *   20260919T171842Z (tracy)   7 rows wrote a bare-kind `apply`   (63 fault lines)
 *                             11 rows wrote a prose `apply.call`  (21 fault lines)
 *   20260919T092410Z (tracy)  39 + 28 fault lines, same two shapes
 *   20260917T082737Z          9 fault lines, `apply.call` only
 *
 * EVERY ONE OF THOSE 18 ROWS ALSO HAD NO `state`. Both shapes are the same
 * mistake — the prose and the directive collapsed into one field, because
 * nothing the worker was handed showed it the entry WHOLE. The 11
 * `apply.call` rows put the prose in `call`; the 7 bare-kind rows put the kind
 * in `apply` and the payload nowhere. So the refusal below prints the WHOLE
 * ENTRY, not the one field that failed: a worker that fixes `apply` and
 * resubmits into "must be an object with a `state` and a `from`" has paid for
 * two rounds to learn one shape.
 *
 * WHAT A BODY MAY SAY HERE. The shape of each directive is stated only where
 * THIS FILE ENFORCES IT — `apply.env`'s literals at the prose check,
 * `apply.call`'s expression at `parsesAsExpression`, `apply.db`'s
 * `{ create: { model, data }, why }` at the db block. `module` and `manual`
 * are checked by nothing here and their meaning is `record.mjs`'s, so they
 * print `…` rather than a semantics this file would then have to keep true.
 * ------------------------------------------------------------------------ */
const APPLY_BODY = Object.freeze({
  // `null` UNSETS the var for the row (record.mjs), which is how a row reaches
  // the missing-env side of a var the run stood in for or staging supplies.
  env: `{ "<NAME>": "<literal>", "<UNSET_NAME>": null }`,
  call: `"<a JS expression>"`,
  module: "…",
  manual: "…",
  db: `{ "create": { "model": "<model>", "data": { … } }, "why": "<why this row exists>" }`,
});

/** `{ "env": … } | { "call": … } | …` — the directive, keyed, in APPLY_KINDS order. */
export const applyForms = () => APPLY_KINDS.map((k) => `{ "${k}": ${APPLY_BODY[k] ?? "…"} }`).join(" | ");

/**
 * One whole `setup` entry, rendered for the row that got it wrong.
 *
 * `arm` is the row's own — `p.covers[0]` where there is one — because a `from`
 * printed with a placeholder arm is a `from` the author has to go and look up,
 * and `checkEvidence` refuses any arm this row does not cover anyway.
 */
export function setupEntryExample(kind, arm, state) {
  const body = APPLY_BODY[kind] ?? "…";
  // THE AUTHOR'S OWN PROSE WHERE THERE IS ANY. A corrected row printed with a
  // placeholder in a field the author already filled reads as a third thing to
  // write; printed with their own sentence in it, it reads as their row.
  const said =
    typeof state === "string" && state.trim() ? JSON.stringify(state) : `"<prose: the precondition this arranges>"`;
  return (
    `{ "state": ${said}, ` +
    `"apply": { "${kind}": ${body} }, ` +
    `"from": { "arm": ${JSON.stringify(arm || "<an arm this row covers>")}, "evidence": "<file:line>", "reading": "<what that line says>" } }`
  );
}

/**
 * The refusal for a `setup[].apply` that is not an object, or null if it is.
 *
 * EXPORTED BECAUSE `propose.mjs` REFUSES IT AT THE DOOR TOO, and that file's
 * own rule is that a writer imports the checker's vocabulary rather than
 * keeping a second copy of it. The door refusal costs the worker one bash
 * call; the same refusal reached here costs a whole round, because the derive
 * step validates after the answering turn has ended and a quarantined row is
 * re-dealt.
 *
 * NOTHING IS COERCED, AND THE MEASUREMENT IS WHY RATHER THAN THE PRINCIPLE. A
 * normaliser would have to turn `"apply": "call"` into `{ call: … }` and it has
 * no `…` to put there — the bare word carries no expression — and the same
 * rows carry no `state` either. There is nothing to normalise INTO. The row is
 * incomplete, not merely mis-shaped, and it must still be refused.
 */
export function applyShapeFault(entry, arm) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const apply = entry.apply;
  if (apply === undefined) return null; // a different refusal owns the absent case
  if (typeof apply === "object" && apply !== null && !Array.isArray(apply)) return null;
  const named = typeof apply === "string" && APPLY_KINDS.includes(apply.trim()) ? apply.trim() : null;
  const head =
    `\`apply\` is ${JSON.stringify(apply)}, which is not an object — it is a DIRECTIVE KEYED BY KIND, and the ` +
    `kind is the KEY.` +
    (named
      ? ` You wrote the key as the whole value, so this row names a directive and carries no payload: it is ` +
        `INCOMPLETE, not merely mis-shaped, and nothing here will invent the payload for you.`
      : ` The key is one of ${applyForms()}.`);
  const missing = entry.state
    ? ""
    : " It also has no `state` — the prose the directive arranges — which is the other half of the same mistake.";
  return `${head}${missing} Written out, this entry is:  ${setupEntryExample(named ?? "env", arm, entry.state)}`;
}

/* ---------------------------------------------------------------------------
 * "apply.call must be a JS expression" NAMED NO CAUSE, AND THE CAUSE IS
 * USUALLY ONE KEYWORD.
 *
 * MEASURED, on a real dispatch of tracy `packet-126` through
 * `tools/packetcost.mjs` on 2026-09-20 (control arm, 275s, $1.62, 2 sides
 * claimed, 1 validated). The one fault was this message, and the row it
 * condemned was otherwise perfect — three fields, `apply` keyed by kind, a
 * `from` citing an arm it covers:
 *
 *     "apply": { "call": "await cache.init(\"redis://127.0.0.1:6379\")" }
 *
 * `parsesAsExpression` compiles with `new Function`, which is NOT an async
 * context, so the `await` is what failed — and `record.mjs:6242` emits the
 * directive as `try { await (<call>); } catch {}` inside an async function,
 * so the recorder awaits it for the author. The keyword is redundant AND
 * fatal, and the old message said neither.
 *
 * THE SAME DEFECT WAS ALREADY FIXED ONE FIELD OVER. `record.mjs` says of
 * `args[].build`: *"isExpression parses with `new Function`, which is not an
 * async context, so a TOP-LEVEL `await` in the build has always been refused
 * here - it just said 'no executable build', which reads as a typo."* It then
 * names the keyword and the fix. `apply.call` never got that sentence.
 *
 * STILL AN ERROR, AND DELIBERATELY. `record.mjs`'s own `isExpression` refuses
 * the same string, so the row is `runnable: false` at stage 4 whatever this
 * file says. Refused here it costs an edit; refused there it costs the round.
 * What changes is that the author is told which keyword to delete.
 * ------------------------------------------------------------------------ */

/** The `new Function` complaint for an expression that will not compile, or null. */
function expressionParseError(text) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${text});`);
    return null;
  } catch (e) {
    return String(e?.message ?? e).trim();
  }
}

/**
 * Why `apply.call` will not run, as a clause appended to the refusal, or null
 * when it runs. The HEAD of that refusal stays a literal at the `err()` site so
 * `enforcedRules()` still lists the rule; only the cause is composed here.
 */
export function callExpressionCause(text) {
  if (typeof text !== "string" || !text.trim()) return "it is empty, so there is nothing for stage 4 to evaluate";
  if (parsesAsExpression(text)) return null;
  if (/\bawait\b|\basync\b/.test(text)) {
    return (
      "it uses await/async, which this check cannot parse because it compiles with `new Function` — and you do " +
      "not need it: record.mjs emits the directive as `try { await (<your call>); } catch {}` inside an async " +
      "function, so the call is ALREADY awaited at the call site. Delete the keyword and leave the expression"
    );
  }
  if (/^\s*[A-Za-z_$][\w$]*\s*=[^=>]/.test(text)) {
    return (
      "it is a bare assignment, which compiles but writes an implicit global rather than arranging anything a " +
      "reader can see. Assign through the object that owns it (`globalThis.x = …`, `process.env.X` via " +
      "`apply.env`), or parenthesise it if the assignment really is the precondition"
    );
  }
  const why = expressionParseError(text);
  // `why` is null only if `parsesAsExpression` refused a string that COMPILES —
  // no guard does that today, and the fallback is here so a guard added later
  // cannot produce a refusal with an empty reason.
  return why
    ? `it does not compile as a single expression: ${why}. A statement, a semicolon-separated pair or a prose sentence is not one`
    : "it compiles but this file's expression check refuses it";
}

/** Fields a proposal may NOT carry: stage 4 records the output, stage 3 does not predict it. */
export const BANNED_FIELDS = ["expected", "expects", "returns", "assert", "snapshot"];

/**
 * An `await` the synchronous mock wrapper cannot run.
 *
 * A boundary answer is rendered OUTSIDE the row's async block —
 * `record.mjs:6192` emits `out[X] = applyMock(sym, kind, orig?.[X], () => (BUILD))`
 * above `settle(async () => …)`, and `applyMock` calls that thunk
 * synchronously (`const v = answer()`, record.mjs:5892). So a top-level
 * `await` in a boundary build has nowhere to run. `args[].build` and
 * `invoke.build` are rendered INSIDE that async block, which is why this is
 * asked of boundaries only.
 *
 * WHY `parsesAsExpression` DOES NOT CATCH IT. That check is
 * `new Function("return (" + text + ");")`, a sloppy-mode SCRIPT, and in a
 * script `await` is an ordinary identifier — so `await (async () => …)()`
 * parses there as a CALL to a function named `await` and is waved through.
 * The generated spec is a MODULE, where `await` is reserved, and rollup
 * refuses the file:
 *
 *   RollupError: Parse failure: await isn't allowed in non-async function
 *
 * WHAT IT COST. One proposal on notification-ms (`sendMessage-119-if-0`,
 * `boundaries.axios.mock.build`) made the whole 16-row chunk fail to PARSE, so
 * all 16 rows recorded nothing — and because the pending set re-forms the same
 * chunk, every resume produced the same 16 pending rows for ever. One build
 * held 16 rows and no message named it.
 *
 * THE LIMIT, stated. This compares the first `await` against the first
 * `async`: an `await` inside an async function the build itself declares is
 * legal and must stay legal (`doubles.stub({ post: async () => await x })`).
 * A top-level `await` AFTER such a declaration — `[async () => 1, await f()]` —
 * is not caught here; rollup still refuses it, one stage later, by name.
 *
 * AND THE ROW IT REFUSES MAY BE UNWRITABLE. `sendMessage-119-if-0` needs
 * `err instanceof HttpException` to be true, so its answer has to carry an
 * instance of the real class — and the mocks are rendered ABOVE the async
 * block, so neither `await import()` nor a `setup` binding can reach it. That
 * row is refused here and has no rewrite; it wants a BLOCKED.md reason, or the
 * mock installation moved inside the async block, which is a change to every
 * row of every repo and not this one's to make.
 */
export function awaitOutsideAsync(text) {
  if (typeof text !== "string") return false;
  const await_ = text.search(/\bawait[\s(]/);
  if (await_ === -1) return false;
  const async_ = text.search(/\basync\b/);
  return async_ === -1 || await_ < async_;
}

/**
 * AN `invoke.build` THAT IS THE SUBJECT'S OWN BODY, COPIED, IS NOT A CALL TO IT.
 *
 * Measured on tracy-agent-be-ms, run 20260922T152300Z.
 * `buildCollectionSystemPrompt` (agent.ts:255) is not exported, so no row can
 * import it. The agent's two rows for it set `entry: null` and wrote the
 * function's body into `invoke.build` - `(tools) => { const CANDIDATE_TARGET =
 * 10; let prompt = ... }` - and the recorder ran that copy. Both rows validated,
 * recorded, and emitted a test; the service's line 275 never executed, both
 * claims measured FALSE, and `repair` could not withdraw either one because
 * each row claimed nothing else. A test of a copy tests nothing, and nothing
 * before measurement said so.
 *
 * The signal is textual and specific: the build contains most of the subject's
 * own non-trivial source lines. A line counts when it is long enough to be
 * distinctive (20+ characters, trimmed); the copy is flagged when at least 3
 * such lines appear AND they are at least half of the body. A build that merely
 * CALLS the subject shares at most its name with the body, so this cannot fire
 * on the shape every legitimate row takes.
 *
 * Returns `{ copied, of }` or null. Never throws: a subject whose file cannot be
 * read is simply not judged here.
 */
const DISTINCTIVE_LINE = 20;
export function copiedFromSubject(build, fn) {
  if (typeof build !== "string" || !fn?.file || !fn.line || !fn.endLine) return null;
  let lines;
  try {
    lines = readFileSync(join(REPO_ROOT, fn.file), "utf8").split("\n").slice(fn.line, fn.endLine - 1);
  } catch {
    return null;
  }
  const body = lines.map((l) => l.trim()).filter((l) => l.length >= DISTINCTIVE_LINE);
  if (body.length < 3) return null;
  const copied = body.filter((l) => build.includes(l)).length;
  return copied >= 3 && copied * 2 >= body.length ? { copied, of: body.length } : null;
}

/** A build/call expression must actually parse, or stage 4 cannot run it. */
function parsesAsExpression(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  // A bare assignment COMPILES as an expression, so `new Function` waves it
  // through - `message = "A".repeat(3000)` is valid JS. It is still not a value:
  // evaluated in the harness it writes an implicit global and yields the right
  // side, so the argument built from it is whatever that assignment returned,
  // not the object the proposal describes. The recorder catches this at run
  // time; catching it here means the defect is reported at the stage that owns
  // it. A parenthesised assignment or an arrow is left alone.
  if (/^\s*[A-Za-z_$][\w$]*\s*=[^=>]/.test(text)) return false;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${text});`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The literal a zero-argument thunk wraps, or null if `text` is not one.
 *
 * `"() => undefined"` reads like "pass undefined" and is not: the recorder
 * inlines `build` as the argument expression, so the subject receives the ARROW
 * - a function object, which is truthy - and `await` on a function is the
 * identity, so nothing ever unwraps it. Found 13 times in one run's proposals
 * on location-ms: every default parameter the rows meant to exercise was
 * defeated (the param was supplied, just with a function), and one row produced
 * a real NaN-vs-null mismatch that JSON serialisation hid at record time. Every
 * stage was green with the pairs recorded against arguments no caller can pass.
 *
 * Only single-literal bodies count. `() => Promise.resolve(x)` and
 * `() => ({ ... })` are how a genuine callback or a lazily built object gets
 * proposed, and flagging those would reject the rows `runWithFallback` exists
 * for.
 */
const THUNK_LITERAL = /^\s*(?:async\s+)?\(\s*\)\s*=>\s*(undefined|null|true|false|-?\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?|(['"`])(?:\\.|(?!\2)[^\\])*\2)\s*;?\s*$/i;
function thunkLiteral(text) {
  const m = typeof text === "string" ? text.match(THUNK_LITERAL) : null;
  return m ? m[1] : null;
}

/** A declared type that can legitimately receive a function. */
const FUNCTION_TYPE = /=>|\bFunction\b/;

/** Prose that names a boundary outcome belongs in a mock, not in setup. */
const BOUNDARY_PROSE = /\b(rejects?|resolves?|throws?|returns)\b/i;

/** A boundary answer meaning "nothing happens" needs no directive. */
const INERT_BEHAVIOUR =
  /^not (a )?call|^not constructed|^not read|^not matched|^not reached|^no call|type only|imported for its type/i;

/**
 * The one string a skeleton leaves behind, and the one string this file
 * refuses outright.
 *
 * `worklist.mjs --skeleton` pre-fills every ADDRESS a proposal needs — arm ids,
 * side labels, boundary symbols, one `args` slot per declared parameter — and
 * puts this in every slot whose content is a derivation. It has to be a
 * sentinel and not an empty string or a `null`, because both of those VALIDATE:
 * `"value": null` satisfies `"value" in arg`, so an untouched skeleton would
 * pass the gate as 40 finished proposals. An unfilled skeleton is an error, by
 * construction, wherever the sentinel survives.
 *
 * Deliberately not "TODO": real prose says TODO. Nothing in a derivation says
 * this.
 */
export const SKELETON_TODO = "<<DERIVE>>";

/* ---------------------------------------------------------------------------
 * A MODULE-SCOPE ARM IS DEALT BY THE WORK LIST AND WAS REFUSED BY THIS FILE.
 *
 * THE DEFECT, run `20260919T092410Z` (tracy-worker). 18 quarantine events
 * across three CONSECUTIVE rounds — 4 in round 2, 7 in round 3, 7 in round 4 —
 * on SEVEN distinct proposal rows, all of them this one error. Counted off
 * that run's `derive: submissions: quarantined` lines, by file:
 *
 *   6 x  functionId "src/cluster.ts:0:<module scope>" is not in scan.json
 *   6 x  functionId "src/lib/logger.ts:0:<module scope>" is not in scan.json
 *   3 x  src/config.ts        3 x  src/lib/tracing.ts
 *
 * THREE NUMBERS HAVE BEEN QUOTED FOR THIS AND ONLY ONE OF THEM IS A ROW COUNT.
 * A grep of the log for `:0:<module scope>` returns 37, which is what this
 * block used to say and what a re-audit of it confirmed: every quarantine
 * event is logged once in the summary line and once again in the `✗` fault
 * detail beneath it, so 37 is 18 events plus 19 echoes. 18 is the events, 7 is
 * the rows, and 7 is the one that says what actually went wrong — the SAME
 * seven rows were dealt, answered correctly and refused three rounds running.
 * The old per-file split (12/11/6/6) was the 37 with its echoes unevenly
 * distributed and matches neither count.
 *
 * FOUR FILES, NOT FIVE. That run's own `stages/scan.json` carries
 * `moduleScopeArms` as a first-class key with `totals.armsAtModuleScope = 32`
 * over five files — `src/cluster.ts`, `src/config.ts`, `src/lib/logger.ts`,
 * `src/lib/tracing.ts` and `src/worker.ts`. Refusals landed on four of them;
 * `src/worker.ts` has one module-scope arm and no worker ever submitted for
 * it. So the
 * scan models them, `worklist.mjs:579-620` deals them as items with a SYNTHETIC
 * owner — `<file>:0:<module scope>`, minted because an arm that runs at import
 * time has no owning function — and the workers answered them correctly. This
 * file then refused every one, because `fnIndex` is built from `scan.functions`
 * and a synthetic owner is by construction not in it.
 *
 * Refused here, the row is quarantined, its sides return to the brief, and the
 * next round deals the same sides to another worker who answers them the same
 * way. Three rounds of that is what the run shows.
 *
 * AND IT IS THE LARGEST SINGLE FAULT IN THE RUN, which this line used to call
 * the second-largest while the `setup.apply` check further down this file
 * called that one "the largest single quarantine in it". Both were reading
 * the same 94 quarantine events
 * under different groupings, and neither said which. Ranked by fault message:
 * module-scope 18, "apply.call must be a JS expression" 14, "apply is not an
 * object" 13. So module-scope is the largest single message; the two
 * `setup.apply` shapes TOGETHER are 27 and are larger than it. Both sentences
 * are true and they now say which grouping they are true under. Every row in
 * this one was RIGHT.
 *
 * WHICH SIDE IS WRONG, reasoned rather than assumed. The scan is right: it
 * counts these arms in `totals`, `armjoin.mjs` joins them, `suppressions.mjs`
 * and `status.mjs` read them, and this file ALREADY accepts their armIds in
 * `scanArms` and `allArmIds` — so `covers` was legal while `functionId` was
 * not, for the same arm, in the same row. That is not a policy, it is two
 * halves of one check that were never made to agree. The fix is the smaller
 * half: give the function index the same synthetic owner the work list mints.
 *
 * WHAT A PSEUDO-FUNCTION MAY AND MAY NOT CARRY. `params` is empty and
 * `boundaries` is empty because a module's top level is not callable and the
 * scan collects no boundary list for it — both are absences this states rather
 * than invents. The consequence is checked and it is the mild one: an answered
 * boundary becomes an `advise` ("neither the function nor its driver touches
 * it"), which does not gate, and the arity checks are already exempt on the
 * `invoke.build` path every module-scope row has to take. Nothing here loosens
 * a check for an ORDINARY functionId: a typo'd or moved function id is still
 * "not in scan.json", which is the refusal `record.mjs:1240` was given after a
 * stale id took a whole round down.
 *
 * DERIVED FROM `scan.moduleScopeArms` AND NOT FROM `worklist.items`, for the
 * reason the covered-statement block above states at length: `items` holds only
 * what is still UNCOVERED, so a file whose module-scope arms all closed would
 * lose its owner from the index and a proposal that had WORKED would read as a
 * proposal naming a function that does not exist. Existence comes from the scan.
 *
 * AND IT IS ONLY HALF THE REPAIR — said here because a reader of this file will
 * otherwise conclude the sides now record. `record.mjs:993/1020/1240` refuses
 * the same id out of its own `fnIndex`, so a module-scope row now LANDS, is
 * counted as proposed, and is then skipped by the recorder with
 * "functionId ... is not in scan.json". That is strictly better than the
 * quarantine — the row survives, the side stops being re-dealt every round, and
 * D64's undeliverable accounting keeps it in the denominator with the
 * recorder's own written reason rather than hiding it — but it is not coverage.
 * Coverage needs the same pseudo-function in `record.mjs`, which is not this
 * file's to write.
 * ------------------------------------------------------------------------- */

/** The name the work list gives an owner that is a module's top level. */
export const MODULE_SCOPE_NAME = "<module scope>";

/**
 * The synthetic owner id for a file's module-scope arms.
 *
 * ONE SPELLING, and `tests/validate.a-module-scope-arm-is-answerable.test.mjs`
 * pins it against `worklist.mjs`'s own source. Two files computing an id for
 * one thing and being allowed to disagree is exactly how this defect was built:
 * `armjoin.mjs` already has a THIRD spelling (`<file>:module`) for its arm
 * GROUPS, which is a different key for a different reader and is left alone.
 */
export const moduleScopeFunctionId = (file) => `${file}:0:${MODULE_SCOPE_NAME}`;

/**
 * One pseudo-function per file that has module-scope arms, keyed by owner id.
 *
 * Shaped like a `scan.functions` entry in exactly the four fields this file
 * reads off one — `id`, `file`, `boundaries`, `params` — plus the `via` and
 * `entry` the work list gives the same owner, so a check that reaches for them
 * reads the same answer from both artifacts.
 */
export function moduleScopeFunctions(scan) {
  const out = new Map();
  for (const group of scan?.moduleScopeArms ?? []) {
    if (!group?.file) continue;
    const id = moduleScopeFunctionId(group.file);
    out.set(id, {
      id,
      file: group.file,
      name: MODULE_SCOPE_NAME,
      async: false,
      params: [],
      // The scan's own list since module-scope boundaries were collected; a
      // scan that predates it has none, which is what this used to say.
      boundaries: group.boundaries ?? [],
      moduleScope: true,
      entry: { kind: "module-import", reachable: true, reason: "runs at import time" },
      via: { kind: "trigger", trigger: "module-import", how: "evaluated when the module is first imported" },
      arms: { istanbul: group.istanbul ?? 0, list: group.list ?? [] },
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * D68 — A functionId THE SCAN DOES NOT HAVE IS A STALE REFERENCE, AND A STALE
 * REFERENCE IS THE PROPOSAL'S TO CORRECT, NEVER A TOOL THAT FAILED.
 *
 * THE DEFECT, run `20260927T061823Z` (qode-ptp-ms, mocked). 8 sides were ruled
 * pipeline_defect as "functionId not in scan.json", all in
 * evaluateCandidateService/helpers.ts, from three answer files:
 *
 *   answers-149b91b675f9.json  helpers.ts:190:getReasonToHireAppliedStep   7 sides
 *   answers-e44c29e5800c.json  helpers.ts:handleRevaluatePrescreeningQuestion 1 side
 *   (and helpers.ts:calculateDistanceToCentralPoint /
 *    helpers.ts:updateTotalScoreWithJobTitleQualification, whose sides other
 *    rows covered)
 *
 * The scan has all four functions, as `helpers.ts:189:getReasonToHireAppliedStep`,
 * `helpers.ts:310:handleRevaluatePrescreeningQuestion` and so on. So nothing
 * moved and no scan changed: the scan was stamped at 06:28 and every one of
 * these was written after it, and every packet dealt the scan's own id. The
 * workers spelled the id themselves — one line off, or with the line left out.
 *
 * TWO TOOLS LET IT THROUGH, AND NEITHER WAS WRONG ABOUT THE ID.
 *   - This file refuses such an id ("is not in scan.json") and derive
 *     quarantines the row. But in that run this file never got that far: a
 *     boundary written `"mock": null` in the same answer file threw
 *     `Cannot read properties of null (reading 'kind')` out of `main`, so every
 *     round's validation died, nothing was quarantined, and the stale rows landed
 *     with every other refusal in the corpus switched off (the `mock: null`
 *     guard below).
 *   - record.mjs then skipped them with "functionId not in scan.json", which
 *     derive read as `cannot-invoke`, repair as the TOOLSET's, and coverage as
 *     pipeline_defect. So the agent was told to stop deriving and write a
 *     declaration for a function it could call perfectly well.
 *
 * THE FIX, IN TWO HALVES. An id the scan does not have, but whose FILE and NAME
 * pick out exactly one function the scan does have, is re-keyed to that
 * function: validate warns and checks the row against it, record records it
 * under it. That is not a guess: file and name are what the id is made of, and
 * the line is the only part a worker can get wrong and still mean one
 * function. Where file and name pick out none or several, nothing is guessed:
 * the refusal names the file, the name and the ids the scan does list, and
 * record.mjs says the same sentence as a skip that repair and coverage read as
 * the PROPOSAL's. Its side stays open and is dealt again with that sentence.
 * ------------------------------------------------------------------------- */

/** `file:line:name` or `file:name`, split at the source file's extension. Null for anything else. */
export function parseFunctionId(id) {
  const m = /^(.+?\.(?:[cm]?[jt]sx?|vue|svelte)):(?:(\d+):)?(.+)$/.exec(String(id ?? ""));
  return m ? { file: m[1], line: m[2] === undefined ? null : Number(m[2]), name: m[3] } : null;
}

/**
 * What a proposal's `functionId` names in the scan: `{ fn }` for an id the scan
 * has, `{ fn, rekeyedFrom }` for one it re-keys (see D68 above), and
 * `{ fn: null, why }` for one nothing picks out, with `why` saying what was
 * looked for and what the scan lists instead.
 *
 * Several functions of one name in one file (`<arg0 of locs.some>` twice) are
 * told apart by the arm the row covers first, when exactly one of them owns it.
 * Pure: the proposal is not touched.
 */
export function resolveFunctionId(fnIndex, proposal) {
  const id = proposal?.functionId;
  if (typeof id === "string" && fnIndex.has(id)) return { fn: fnIndex.get(id) };
  const parsed = parseFunctionId(id);
  if (!parsed) {
    return { fn: null, why: `it is not of the scan's shape <file>:<line>:<name>` };
  }
  const inFile = [...fnIndex.values()].filter((f) => f.file === parsed.file);
  if (!inFile.length) {
    return { fn: null, why: `the scan lists no function in ${parsed.file}` };
  }
  let named = inFile.filter((f) => f.name === parsed.name);
  const firstArm = Array.isArray(proposal?.covers) ? proposal.covers[0] : undefined;
  if (named.length > 1 && firstArm) {
    const owners = named.filter((f) => (f.arms?.list ?? []).some((a) => a.armId === firstArm) || f.entryArmId === firstArm);
    if (owners.length === 1) named = owners;
  }
  if (named.length === 1) return { fn: named[0], rekeyedFrom: id };
  if (named.length > 1) {
    return {
      fn: null,
      why: `${named.length} functions in ${parsed.file} are named ${parsed.name} (${named.map((f) => f.id).join(" | ")}) and the row's first covered arm does not tell them apart`,
    };
  }
  const near = inFile
    .filter((f) => parsed.line === null || Math.abs((f.line ?? 0) - parsed.line) <= 40)
    .slice(0, 6)
    .map((f) => f.id);
  return {
    fn: null,
    why: `no function in ${parsed.file} is named ${parsed.name}${near.length ? ` (the scan lists ${near.join(" | ")}${inFile.length > near.length ? ", …" : ""})` : ""}`,
  };
}

/**
 * D79 - A DRIVER WHOSE LINE MOVED IS THE SAME DRIVER.
 *
 * How it worked before: D68 re-keyed a proposal's `functionId` by file and
 * name, but its `via` - the driver the row calls through - was looked up by
 * its exact id. qode-ptp-ms was resumed onto a production that had moved
 * (0c903551, AI-5440, which edited aiInterviewService.ts), so every function
 * below the edit changed line and so changed id. The offline measure of the
 * resumed checkpoint had 16 sides pipeline_defect, 14 of them "driver
 * src/lib/server/services/aiInterviewService.ts:2455:checkStatusCreateMeetingRoomProcess
 * not resolvable", for drivers the scan still has one line-shift away.
 *
 * A `via` of the scan's `<file>:<line>:<name>` shape that the scan does not
 * have, but whose file and name pick out exactly one function, is that
 * function - D68's rule, for the driver. The row's covered arms belong to the
 * subject, not the driver, so they never pick between two drivers of one name:
 * two or more is no match, and the row keeps its refusal.
 */
export function resolveVia(fnIndex, via) {
  if (typeof via !== "string" || via.startsWith("trigger:") || fnIndex.has(via)) return { id: via ?? null };
  if (!parseFunctionId(via)) return { id: via };
  const moved = resolveFunctionId(fnIndex, { functionId: via });
  return moved.fn ? { id: moved.fn.id, rekeyedFrom: via } : { id: via };
}

/**
 * THE ONE SENTENCE for a functionId nothing picks out, said by this file and by
 * record.mjs alike, so repair and coverage read one refusal (D68). It begins
 * `functionId "<id>" is not in scan.json - ` and derive's SKIP_REASONS anchors
 * on exactly that.
 */
export function staleFunctionIdReason(proposal, why) {
  return (
    `functionId ${JSON.stringify(proposal?.functionId ?? null)} is not in scan.json - ${why}. ` +
    `The scan is the authority on function ids and every packet deals the scan's own: write the id scan.json lists for the function this row calls, byte-exact`
  );
}

/**
 * Every path in a proposal where the sentinel survived, `a.b[0].c`-style.
 *
 * Walked rather than string-matched on the serialised proposal, because the
 * error has to name WHICH slot was left unfilled - "there is a placeholder
 * somewhere in this 4KB proposal" is a message that makes the author re-read
 * their own file, which is the cost this whole change exists to remove.
 * `_file`, `_inherited` and `_overridden` are this reader's own metadata and
 * are skipped.
 */
function sentinelPaths(node, path = "", found = []) {
  if (typeof node === "string") {
    if (node.includes(SKELETON_TODO)) found.push(path || "(the proposal)");
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => sentinelPaths(v, `${path}[${i}]`, found));
    return found;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k.startsWith("_")) continue;
      if (k.includes(SKELETON_TODO)) found.push(`${path}.${k} (the key itself)`);
      sentinelPaths(v, path ? `${path}.${k}` : k, found);
    }
  }
  return found;
}

/** Every armId mentioned anywhere in the scan, covered or not. */
let allArmIds = new Set();

/**
 * Boundary answers declared ONCE per function, overridden per row.
 *
 * A try/catch's two arms take the same arguments and differ only in a boundary
 * answer, so a function with four uncovered arms is four proposals over one set
 * of boundaries. Nothing let an author say so, and the cost was measured on
 * this repo's own corpus: 2185 boundary answers over 1146 distinct
 * (function, symbol) pairs — 1.91x restatement, 894KB, 56% of every byte in
 * `proposals/`. Worse than the size, the reason the repeats are not literally
 * identical: of the 454 pairs answered more than once, 294 differ ONLY in
 * `from`, and 245 of those differ only in `from.arm` — the answer was retyped
 * so its citation could point at this row's arm.
 *
 *   {
 *     "stage": "3-proposals",
 *     "functionBoundaries": {
 *       "src/models/prompt.ts:120:compilePrompt": {
 *         "redisCache": { "behaviour": "…", "mock": { … }, "from": { … } }
 *       }
 *     },
 *     "proposals": [ { "boundaries": { "redisCache": { … } } } ]
 *   }
 *
 * Three rules, and each one is answering a question the corpus asked:
 *
 *   - a row's own `boundaries[sym]` WINS outright. `behaviour` diverges in 158
 *     of those 454 pairs and `mock` in 101, so per-row override is not a
 *     convenience, it is most of the remaining work.
 *   - a row may write `"boundaries": { "<sym>": null }` to say *this row does
 *     not answer it* — the one thing an inherited block otherwise makes
 *     unsayable.
 *   - the block is keyed by function id, and a proposal driven through `via`
 *     inherits from BOTH its own function and its driver. Those are exactly the
 *     two whose boundaries `requiredBoundaries` demands.
 *
 * `from` on an inherited answer cites the FUNCTION, not the row, so the
 * covers cross-check is skipped for it — see `checkEvidence`'s caller. Without
 * that, hoisting would trade 613 restatements for 613 warnings.
 */
export function mergeBoundaries(doc, p) {
  const blocks = doc?.functionBoundaries;
  if (!blocks || typeof blocks !== "object") {
    return { boundaries: p.boundaries ?? {}, inherited: new Set(), overridden: new Set() };
  }
  // The driver first, then the function's own: a nested function's answer for a
  // symbol both touch is the more specific of the two.
  const levels = [p.via && !String(p.via).startsWith("trigger:") ? blocks[p.via] : undefined, blocks[p.functionId]];
  const merged = {};
  const inherited = new Set();
  for (const level of levels) {
    if (!level || typeof level !== "object") continue;
    for (const [sym, ans] of Object.entries(level)) {
      merged[sym] = ans;
      inherited.add(sym);
    }
  }
  const overridden = new Set();
  for (const [sym, ans] of Object.entries(p.boundaries ?? {})) {
    if (inherited.has(sym)) {
      overridden.add(sym);
      inherited.delete(sym);
    }
    // An explicit null is a DELETION, not an answer. `delete` rather than a
    // null value, so every reader downstream — including the recorder's
    // `Object.entries(proposal.boundaries)` — sees the symbol as unanswered
    // rather than as answered with nothing.
    if (ans === null) delete merged[sym];
    else merged[sym] = ans;
  }
  return { boundaries: merged, inherited, overridden };
}

/**
 * The ONE reader of `proposals/`, so stage 3 and stage 4 cannot disagree about
 * what a proposal says.
 *
 * They were two independent `readdirSync().flatMap()` expressions — identical
 * by luck rather than by construction — and `functionBoundaries` is precisely
 * the kind of field that would have landed in one of them. An answer accepted
 * by validate and dropped by the recorder is this pipeline's most expensive
 * failure mode (it has a heading in the stage-3 skill: *the prose was right and
 * the runnable half was wrong*), so the merge happens once, here, and both
 * stages import it.
 *
 * The merged answers are written back onto `boundaries`, which is the field
 * every downstream reader already consumes. The two `_` fields are metadata for
 * the report, following the `_file` convention the recorder already tolerates.
 */
/**
 * The fields a recording is only as good as, and the hash over them.
 *
 * Kept beside `loadProposals` because this is the document every stage means
 * when it says "the proposal": the row as stage 3 wrote it, before this file
 * merges anything into it. `steps/record.mjs` restates the same list (it must
 * not import a command to read one function) and `tests/` holds the test that
 * fails when the two lists move apart.
 */
export const FINGERPRINTED_FIELDS = [
  "args", "boundaries", "invoke", "setup", "via", "covers", "reaches", "functionId",
];

/**
 * The hoisted `functionBoundaries` blocks this row inherits, as the FILE holds
 * them, or null when it inherits none.
 *
 * PART OF THE INPUT, so part of the hash (D33). A row's answers are its own
 * `boundaries` AND whatever `mergeBoundaries` folds in from the document, and
 * the hash covered only the first. assessment-service's entry-file rows (late
 * September 2026) answered `app` from a hoisted block; the agent rewrote that
 * double into one the recorder can call, the row's own fields did not move, so
 * neither did the fingerprint: `record: already done` for three rounds, the
 * old observation (`app.listen is not a function`) emitted against the new
 * double, and both sides stalled on a repair that had already been made.
 *
 * Read off the file, not off the merge, for the reason `loadProposals` gives:
 * `steps/record.mjs` reads the file itself and must reproduce this. Only the
 * two levels `mergeBoundaries` reads — the driver `via` names, then the
 * function — keyed by level so a block moving between them is a change.
 */
export function inheritedBlocks(doc, proposal) {
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
 * The key is added ONLY when something is inherited, so a row that inherits
 * nothing keeps the hash it always had and is not re-recorded for a change
 * that never touched it.
 */
export function rawFingerprint(proposal, doc = null) {
  const subject = {};
  for (const field of FINGERPRINTED_FIELDS) subject[field] = proposal?.[field] ?? null;
  const inherited = inheritedBlocks(doc, proposal);
  if (inherited) subject.inherited = inherited;
  return createHash("sha1").update(JSON.stringify(subject)).digest("hex").slice(0, 12);
}

export function loadProposals(dir = PROPOSALS_DIR) {
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    : [];
  // A FILE THAT WILL NOT PARSE IS A FINDING, NOT A CRASH.
  //
  // This was a bare `JSON.parse`, so one malformed proposal exited the whole
  // validator with a raw SyntaxError naming no file. That failure mode is why
  // the agent ran `node -e "JSON.parse(...)"` before every validate: it was
  // defending against an error that said nothing. Measured on run
  // 20260914T080742Z: 269 inline script calls, 28% of every command in the run,
  // a share of them exactly this pre-check.
  //
  // The file is REPORTED and its proposals are not silently skipped into
  // nothing - `malformed` is returned so every caller has to decide, and
  // neither of them is allowed to shrug. A validator that quietly ignores an
  // unreadable proposal is the shape this whole pipeline exists to avoid.
  const malformed = [];
  const proposals = files.flatMap((f) => {
    let doc;
    let rows;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
      // A FILE THAT PARSES INTO THE WRONG SHAPE IS THE SAME FINDING AS ONE
      // THAT DOES NOT PARSE, AND IT USED TO BE A CRASH INSTEAD.
      //
      // `(doc.proposals ?? []).map(...)` sat OUTSIDE this `try`, so it was
      // never covered by the refusal above. A file holding the literal `null`
      // threw `Cannot read properties of null (reading 'proposals')`, and a
      // file whose `proposals` is an object rather than an array threw
      // `doc.proposals.map is not a function` — both out of the one reader that
      // validate and record share, which means out of the whole round. A bad
      // proposal file stays on disk between rounds, so the same crash came back
      // every round until a human deleted the file by hand. That is what one
      // unguarded read off an agent-written value costs: run 20260918T105518Z
      // (notification-ms, round 2) died on the sibling read `(nested ??
      // subject).file` with 79 runnable rows sitting on disk, and recorded none
      // of them.
      //
      // Reported exactly like a syntax error, naming the file and the shape it
      // actually holds, because "proposals is an object" is the sentence that
      // tells the agent what to edit. The other files in the directory are
      // still read.
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        malformed.push({
          file: f,
          message:
            `the file is ${doc === null ? "null" : Array.isArray(doc) ? "an array" : typeof doc}, ` +
            `not a proposal document — it must be an object carrying a \`proposals\` array`,
        });
        return [];
      }
      if (doc.proposals !== undefined && !Array.isArray(doc.proposals)) {
        malformed.push({
          file: f,
          message:
            `\`proposals\` is ${doc.proposals === null ? "null" : typeof doc.proposals}, not an array — ` +
            `every reader in the pipeline walks it as a list of rows`,
        });
        return [];
      }
      rows = doc.proposals ?? [];
    } catch (err) {
      // `position` is what turns "it does not parse" into a place to look.
      const at = typeof err.message === "string" ? err.message : String(err);
      malformed.push({ file: f, message: at.split("\n")[0].slice(0, 200) });
      return [];
    }
    return rows.flatMap((p, i) => {
      // A ROW THAT IS NOT AN OBJECT IS A MALFORMED ROW, NOT A CRASH.
      //
      // `{"proposals": [null]}` reached `mergeBoundaries(doc, p)`, which reads
      // `p.boundaries`, and threw `Cannot read properties of null (reading
      // 'boundaries')` out of the shared reader — so one empty row in one file
      // ended the round for every other row, and did it again next round
      // because the file persists. This is the same defect the recorder already
      // refuses per boundary entry ("A NULL BOUNDARY IS A MALFORMED ANSWER");
      // the row is named by its INDEX because a row with no object has no `id`
      // to name it by.
      if (p === null || typeof p !== "object" || Array.isArray(p)) {
        malformed.push({
          file: f,
          message:
            `proposals[${i}] is ${p === null ? "null" : Array.isArray(p) ? "an array" : typeof p}, ` +
            `not a proposal object — a row must at least carry an \`id\` and a \`functionId\``,
        });
        return [];
      }
      const { boundaries, inherited, overridden } = mergeBoundaries(doc, p);
      // STAMPED BEFORE THE MERGE, and that is the whole point of it being here.
      //
      // `steps/record.mjs` decides whether a recording still describes the
      // input on disk by hashing the proposal AS WRITTEN — it reads the file
      // itself and never sees this merge. record.mjs hashed what it holds,
      // which is the row AFTER `mergeBoundaries` has rewritten `boundaries`,
      // and the two are different documents for three ordinary shapes:
      //
      //   no `boundaries` key at all   the merge makes it `{}`, the file says
      //                                nothing, and `{}` does not hash to null
      //   `functionBoundaries` hoisted the merge folds the doc-level block in,
      //                                so the row carries symbols the file does
      //                                not, in an order the file does not have
      //   `"sym": null`                a deletion; the merge removes the key,
      //                                the file still carries it
      //
      // The recorder then stamped a hash the step could never match, so the
      // step reported the proposal as repaired, the walk re-recorded it, and
      // the recorder stamped the same unmatchable hash again. `satisfied()` was
      // false for ever. Run 20260918T073111Z (qode-ptp-ms, one shard) closed
      // 865 of 865 sides in 7 rounds of an allowed 14, with zero errors, and
      // then wrote no result.json at all: 16 proposals in exactly these shapes.
      //
      // Hoisting is not a corner: the comment on `mergeBoundaries` counts 613
      // restatements it exists to remove, so the bigger the repo the more of
      // its proposals inherit, and the more certain this deadlock becomes.
      //
      // One hash, taken from the file, carried on the row. The recorder uses
      // this rather than hashing what it holds, and both stages are then asking
      // about the same document.
      return [{
        ...p,
        boundaries,
        _file: f,
        _fingerprint: rawFingerprint(p, doc),
        _inherited: inherited,
        _overridden: overridden,
      }];
    });
  });
  return { files, proposals, malformed };
}

/** Provenance is the whole point — an unsourced value is a fabricated value. */
function checkEvidence(where, evidence, covers) {
  if (!evidence || typeof evidence !== "object") {
    err(where, "missing `from` — every value must cite the arm and file it came from");
    return;
  }
  if (!evidence.arm) {
    err(where, "`from.arm` is required (the armId the value was read off)");
  } else if (!allArmIds.has(evidence.arm)) {
    // A citation to an armId that does not exist reads as checked and is not.
    // This caught a one-character typo in a path that every other check passed.
    err(where, `\`from.arm\` cites "${evidence.arm}", which is not an arm in scan.json`);
  } else if (covers && !covers.includes(evidence.arm)) {
    warn(where, `\`from.arm\` cites ${evidence.arm}, which this proposal does not list in \`covers\``);
  }
  if (!evidence.evidence) {
    err(where, "`from.evidence` is required (file:line, fixture path, or .env.example key)");
    return;
  }
  // A citation that points at nothing is worse than no citation: it reads as
  // checked. Only file references are verifiable here, so only those are checked.
  const ref = String(evidence.evidence);
  const filePart = ref.split(":")[0];
  if (filePart.includes("/") && !filePart.startsWith("http")) {
    if (!existsSync(join(REPO_ROOT, filePart))) {
      err(where, `\`from.evidence\` points at "${filePart}", which does not exist`);
    }
  }
}

/**
 * How long stage 3 has been running, and whether that is still buying anything.
 *
 * `worklist.mjs` stamps out/stage3-clock.json the first time the brief is built.
 * This reads it back on EVERY validate - the call an agent makes most (46 times
 * in one measured run) - because a budget has to be visible where the work is,
 * not in a paragraph nobody re-reads.
 *
 * Measured on location-ms, twice: derivation took 47 of 75 minutes on one run
 * and had not reached stage 4 after 62 on the next. Both recorded ZERO pairs. A
 * partial dataset that recorded beats a complete one that did not, so past the
 * budget this says so in the imperative.
 */
function stage3Budget() {
  const budgetMin = Number(process.env.CHARPILOT_STAGE3_BUDGET_MIN ?? 25);
  try {
    const clock = join(OUT_DIR, "stage3-clock.json");
    if (!existsSync(clock)) return null;
    const { startedAt } = JSON.parse(readFileSync(clock, "utf8"));
    const mins = Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);
    return { mins, budgetMin, over: mins > budgetMin };
  } catch {
    return null;
  }
}

/**
 * The OVER-BUDGET form prints LAST, and that placement is the whole fix.
 *
 * Measured on run 20260908T200621Z: the clock tripped at minute 26, validate
 * ran 17 times, and no pair was ever recorded. The agent was not ignoring it -
 * it invokes `node validate.mjs 2>&1 | tail -30`, and this file prints up to
 * 107 advisory lines AFTER the summary block. The budget warning was scrolled
 * off every single time.
 *
 * A warning the reader cannot see is the same defect as a warning nobody acts
 * on, and it is cheaper to fix here than to argue with the pipe. Last line, so
 * any `tail` shows it.
 */
/**
 * Is the walk driving this run, rather than a person or an onboarding agent?
 *
 * Read off the filesystem, not off an env var a caller could forget: the walk
 * hands the agent a worklist and reads its answers out of `charpilot-answers/`,
 * and neither exists in a hand-driven run. Answering "no" is the safe direction
 * - it prints the advice that was always printed - so a missing artifact
 * degrades to the old wording rather than to silence.
 */
function walkIsDriving() {
  try {
    return existsSync(join(OUT_DIR, "worklist-decisions.json")) || existsSync(join(REPO_ROOT, "charpilot-answers"));
  } catch {
    return false;
  }
}

function stage3ClockBanner() {
  const b = stage3Budget();
  if (!b || !b.over) return "";
  // WHO IS BEING TOLD TO RUN IT DECIDES WHETHER TO SAY IT.
  //
  // This banner told every reader to "Run `npm run pilot:record`". Under the
  // walk the agent is forbidden from running any pilot:* tool, so the checker
  // was instructing it to break the one rule its prompt states twice - and
  // round 1 of run 20260916T223906Z stopped deriving on this banner after 24.5
  // minutes and 4 proposals, which is the half of the advice it COULD obey.
  //
  // The walk is detectable: it hands over a worklist and reads answers out of
  // charpilot-answers/, neither of which a hand-driven run has.
  return walkIsDriving()
    ? `\n  STAGE-3 CLOCK: ${b.mins}m of a ${b.budgetMin}m budget - OVER BUDGET.\n` +
      `  This is the last derive round before the walk records. Answer the items you\n` +
      `  were handed and submit them; the walk runs record.mjs itself, and the sides\n` +
      `  still uncovered are the NEXT loop brief, aimed by a coverage report.\n`
    : `\n  STAGE-3 CLOCK: ${b.mins}m of a ${b.budgetMin}m budget - OVER BUDGET.\n` +
      `  Stop deriving. Run \`npm run pilot:record\` with the proposals that validate now;\n` +
      `  the sides still uncovered are the NEXT loop brief, aimed by a coverage report.\n`;
}

/**
 * BOTH ends, because agents truncate this output and they do not agree on which
 * end to keep. Measured across two runs: `validate.mjs | head -20/-30/-40/-60`
 * thirteen times, `| tail -30` once. The summary sits near the top, so `head`
 * sees it and `tail` does not - and a banner placed only at the end fixes the
 * one case while breaking the thirteen. So the line is in the summary AND the
 * banner is the last line. Duplication is the cheap half of this trade.
 */
function stage3ClockLine() {
  const b = stage3Budget();
  if (!b) return "";
  if (!b.over) return `    stage-3 clock      ${b.mins}m of ${b.budgetMin}m\n`;
  return walkIsDriving()
    ? `    STAGE-3 CLOCK      ${b.mins}m of a ${b.budgetMin}m budget - OVER BUDGET.\n` +
      `                       Last derive round before the walk records. Answer what you were\n` +
      `                       handed; the uncovered sides are the NEXT loop brief.\n`
    : `    STAGE-3 CLOCK      ${b.mins}m of a ${b.budgetMin}m budget - OVER BUDGET.\n` +
      `                       Stop deriving. Run \`npm run pilot:record\` with the proposals that\n` +
      `                       validate now; the sides still uncovered are the NEXT loop brief.\n`;
}

function main() {
  const { files, proposals: loaded, malformed } = loadProposals(PROPOSALS_DIR);

  // Reported first, and as an ERROR: a proposal nobody can read is not a
  // proposal that happens to be fine.
  for (const m of malformed) {
    errors.push(`${m.file} is not readable JSON: ${m.message}`);
  }

  // SAID OUT LOUD, ONCE, WHEN ONE OF THE CHECKS COULD NOT BE ASKED.
  //
  // An advisory rather than an error or a warning: nobody's proposal is wrong,
  // and failing a run because this file could not read `record.mjs` would turn
  // a missing tool into a red gate on correct work. It is printed, because a
  // check that stops running in silence is how the executable-answer defect got
  // a whole run to itself in the first place.
  if (disposition().refusal) {
    advise(relative(REPO_ROOT, RECORD_MJS), `mock.kind disposition not checked — ${disposition().refusal}`);
  }

  if (files.length === 0) {
    console.error(
      `no proposals in ${relative(REPO_ROOT, PROPOSALS_DIR)}/.\n` +
        "Stage 3 is the agent's stage: read out/worklist.md, derive an input per arm, write it there."
    );
    process.exit(1);
  }

  const worklist = JSON.parse(readFileSync(WORKLIST_JSON, "utf8"));
  const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
  const proposals = { proposals: loaded };

  const armIndex = new Map(worklist.items.map((i) => [i.armId, i]));

  // Evidence from the last measurement: which proposal verifiably reached which
  // side, and which arms are covered at all. Absent on a first run, in which
  // case the work list holds every uncovered arm and nothing needs excusing.
  const covPath = join(REPO_ROOT, ".claude/charpilot/out/coverage.json");
  const cov = existsSync(covPath) ? JSON.parse(readFileSync(covPath, "utf8")) : null;
  // Every armId the scanner found, which is the only authority on existence.
  const scanArms = new Set(
    scan.functions.flatMap((f) => [
      f.entryArmId,
      ...((f.arms?.list ?? []).map((a) => a.armId)),
    ]).filter(Boolean)
  );
  for (const g of scan.moduleScopeArms ?? []) for (const a of g.list ?? []) scanArms.add(a.armId);

  // THE STATEMENT-UNIT CATALOGUE - every id worklist.mjs can mint, covered or
  // not. `worklist.items` holds only what is still UNCOVERED, so reading
  // existence from it made a proposal that had succeeded - drove the statement,
  // got it executed, and thereby removed it from the work list - read exactly
  // like a proposal naming an arm that does not exist. 187 of this tool's
  // errors on run 20260915T050314Z were that, and the same population showed up
  // as armids.mjs's 200 stale references.
  //
  // `coveredStatements` is kept apart from `allStatements` because the two
  // answer different questions and the verdicts differ: an id that exists and
  // is covered is the `advise` case already used for covered branch arms; an id
  // that exists in neither is a genuine error and still is.
  const allStatements = new Set((worklist.statementUnits ?? []).map((u) => u.armId).filter(Boolean));
  const coveredStatements = new Set(
    (worklist.statementUnits ?? []).filter((u) => u.covered && u.armId).map((u) => u.armId)
  );

  const verifiedArms = new Set((cov?.verified ?? []).map((v) => `${v.id}|${v.armId}`));
  const measuredArms = new Set([
    ...(cov?.verified ?? []).map((v) => v.armId),
    ...(cov?.falseClaims ?? []).map((v) => v.armId),
  ]);
  // THE MODULE'S TOP LEVEL IS AN OWNER. See `moduleScopeFunctions` above: the
  // work list deals these arms under a synthetic owner and this index is the
  // only reason answering one was an error. Scan functions win on a collision —
  // a real function can never carry this id, and if one ever did, the file's
  // own record is the authority.
  const fnIndex = new Map([...moduleScopeFunctions(scan), ...scan.functions.map((f) => [f.id, f])]);
  // `from.arm` and `covers` must accept THE SAME set, or a unit is legal to
  // cover and illegal to cite. That is what happened: this set came from the
  // scan (entry + arms + module-scope) while `covers` is checked against
  // `worklist.items`, which also carries statement units - so citing a
  // statement arm was an error while covering it was fine. It cost one agent
  // 15 of its 15 first-pass errors, none of which were about its derivation.
  allArmIds = new Set([
    ...scan.functions.map((f) => f.entryArmId),
    ...scan.functions.flatMap((f) => f.arms.list.map((a) => a.armId)),
    ...(scan.moduleScopeArms ?? []).flatMap((m) => m.list.map((a) => a.armId)),
    ...worklist.items.map((i) => i.armId),
    ...allStatements,
  ]);

  const list = proposals.proposals ?? [];
  if (!Array.isArray(list) || list.length === 0) {
    err("proposals", "`proposals` must be a non-empty array");
  }

  const seen = new Set();

  for (const [i, p] of list.entries()) {
    const where = `${p._file}[${i}]${p.id ? ` (${p.id})` : ""}`;

    // TRUTHY IS NOT ENOUGH. The test and the recorded row are keyed by this, and
    // record.mjs's `--only` path — the one verify-on-write takes for every
    // checkpoint row — matches against it. A number or an object here is a crash
    // one layer down, which costs the run rather than the row.
    if (!p.id) err(where, "`id` is required — the test and the recorded row are keyed by it");
    else if (typeof p.id !== "string") {
      err(where, `\`id\` is ${JSON.stringify(p.id)}, which is not a string — the test and the recorded row are keyed by it, so it is text`);
      continue;
    }
    else if (seen.has(p.id)) err(where, `duplicate id "${p.id}"`);
    else seen.add(p.id);

    // `via` IS A STRING OR IT IS ABSENT. This file already reads it as
    // `String(p.via)` (line 377), so a non-string passed validation and reached
    // `record.mjs:892`, where `proposal.via?.startsWith` is a TypeError rather
    // than a refusal — and a crashing recorder takes the whole run with it, not
    // just the bad row. Run 20260917T163043Z died that way in round 2.
    //
    // Named here so the agent fixes the field, rather than coerced silently
    // into a value nothing meant.
    if (p.via !== undefined && p.via !== null && typeof p.via !== "string") {
      err(where, `\`via\` is ${JSON.stringify(p.via)}, which is not a string — it names how the function is reached ("through-caller", "through-chain", "trigger:<kind>"), so it is one string or it is absent`);
      continue;
    }

    if (!Array.isArray(p.covers) || p.covers.length === 0) {
      err(where, "`covers` must list at least one armId this input is meant to reach");
      continue;
    }

    // D68: a functionId whose file and name pick out one scan function is that
    // function. Every check below reads it, as record.mjs records it; the
    // proposal on disk is not rewritten (this file writes nothing), so the
    // warning asks for the id to be written as the scan spells it.
    {
      const rk = resolveFunctionId(fnIndex, p);
      if (rk.rekeyedFrom) {
        warn(
          where,
          `\`functionId\` "${rk.rekeyedFrom}" is not the scan's id; ${rk.fn.id} is the one function in ${rk.fn.file} named ${rk.fn.name}, ` +
            `so it is checked and recorded as that - write "${rk.fn.id}"`
        );
        p.functionId = rk.fn.id;
      }
    }

    for (const armId of p.covers) {
      const arm = armIndex.get(armId);
      if (!arm) {
        // On a RELOOP the work list holds only what is still uncovered, so an
        // arm missing from it is usually one this proposal already covered -
        // success, not a defect. Flagging those reported 206 errors for 206
        // working inputs. The distinction is evidence: stage 6 recorded which
        // proposal verifiably reached which side.
        if (verifiedArms.has(`${p.id}|${armId}`)) continue;
        // EXISTENCE is a property of the scan, not of the measurement. An arm
        // can be absent from the work list (covered), absent from `verified`
        // and absent from `falseClaims` (no proposal claimed it) and still be a
        // perfectly real arm. Checking existence against the measurement sets
        // reported 4 real arms as non-existent.
        // A COVERED STATEMENT UNIT, which is the same situation as a covered
        // branch arm one line down and used to be the opposite verdict. It is
        // absent from `armIndex` because it is DONE.
        if (coveredStatements.has(armId)) {
          advise(where, `covers "${armId}", a statement unit that is already executed — this proposal contributes nothing further to it`);
          continue;
        }
        if (scanArms.has(armId)) {
          // An ADVISORY: `expand.mjs`'s horizontal rung stratifies by
          // arrangement SHAPE rather than by uncovered-ness, so most of its
          // picks land on a covered arm and the deliverable is a recorded pair,
          // not a coverage move. A check the pipeline's own sampler is expected
          // to trip cannot also be a gate failure.
          advise(where, `covers "${armId}", which is already covered — this proposal contributes nothing measurable to it`);
          continue;
        }
        err(where, `covers "${armId}", which is not an arm in scan.json at all — the armId is wrong`);
        continue;
      }
      // An arm with no own entry is still work — the input just belongs to a
      // caller. The scan computes which one, so the proposal must NAME it and
      // the name must match. "no own entry" is not an exemption.
      if (!arm.owner.entry.reachable) {
        const fn = fnIndex.get(arm.owner.functionId);
        const via = fn?.via;
        const drivers = via ? (via.drivers ?? [via.driver]).filter(Boolean) : [];

        // A framework-invoked arm has no caller to name. It declares its
        // TRIGGER instead, as `trigger:<kind>`, and the scan's resolution is
        // still the authority on which one.
        if (via?.kind === "trigger") {
          const want = `trigger:${via.trigger}`;
          if (!p.via) {
            err(where, `covers ${armId}, which is ${via.trigger}-triggered — declare \`via\`: "${want}" (${oneLine(via.how)})`);
          } else if (p.via !== want) {
            err(where, `declares via "${p.via}" but the scan resolves ${armId} as ${want}`);
          }
        } else if (!p.via) {
          if (drivers.length) {
            err(
              where,
              `covers ${armId}, which has no own entry — declare \`via\` naming the driver (scan says: ${drivers.join(" | ")})`
            );
          } else {
            warn(
              where,
              `covers ${armId}, which has no own entry and no driver the scan could resolve (${via?.kind ?? "unknown"})`
            );
          }
        } else if (drivers.length && !drivers.includes(resolveVia(fnIndex, p.via).id)) {
          err(
            where,
            `declares via "${p.via}" but the scan resolves ${armId} through ${drivers.join(" | ")}`
          );
        }
      }
    }

    // `reaches` is what the ledger reconciles against, so a label that is not an
    // actual side of the arm silently drops the side from the accounting. Caught
    // 29 such drifts on first run — several because "operand 1 is always
    // evaluated, so it must be covered" is FALSE when the function never ran.
    for (const [armId, sides] of Object.entries(p.reaches ?? {})) {
      const arm = armIndex.get(armId);
      if (!arm) {
        // `covers` and `from.arm` are both checked against the arm set and this
        // was not, so a key naming an arm that does not exist was skipped in
        // silence. profile-centralized had a reaches key for
        // `profile.service.ts#78:catch:0`, which is not in scan.json, and
        // nothing said so - the agent found it by hand. A claim about an arm
        // that does not exist can never be verdicted, so it reads at stage 4 as
        // "unmeasurable" rather than as the typo it is.
        if (!allArmIds.has(armId)) {
          err(where, `reaches names "${armId}", which is not an arm in scan.json`);
        }
        continue;
      }
      const valid = new Set([...(arm.sides ?? []), ...arm.uncoveredSides]);
      // The SAME comparison stages 4 and 6 make, from the one place it lives.
      // D6: this check was byte-exact while armjoin's `sideIndexOf` - which
      // stage 4's verdict and stage 6's claim check both run - already
      // tolerated the scan's 60-character truncation. So the two tools read one
      // stored label under two different names: a proposal naming the natural
      // untruncated operand was warned about here and then verdicted `false`
      // over there, indistinguishable from a mis-aimed input. Normalising the
      // comparison changes no stored label, so no recorded row, no ledger key
      // and no committed test moves.
      const validList = [...valid];
      const isSide = (s) => valid.has(s) || sideIndexOf(validList, s) !== -1;
      // A side label is a SOURCE OPERAND, so it can contain a comma - and 4 of
      // this repo's own labels do, one of them
      // `logger.info("Retry", { retry: retry - 1, actionName })`, on an arm
      // whose other side has to be nameable in the same claim. The ARRAY form
      // is the only one that can express that, it has always worked, and
      // nothing said so: the stage-3 skill's own worked example comma-joins two
      // labels, which teaches the form that breaks.
      //
      // So the comma split stays for the 15 proposals on this repo that use it,
      // and it is REFUSED where it cannot be trusted - when a valid label of
      // that same arm contains a comma, a successful split is a coincidence,
      // not a reading. Measured: 0 of those 15 sit on such an arm, so nothing
      // on disk moves and the ambiguous case now names its remedy instead of
      // guessing.
      const ambiguous = validList.some((v) => v.includes(","));
      const arrayForm = Array.isArray(sides);
      const named = arrayForm ? sides.map(String) : [String(sides)];
      for (const entry of named) {
        const trimmed = entry.trim();
        if (isSide(trimmed)) continue;
        // Inside an array, an entry is ONE label, verbatim. Splitting it there
        // would make the array form as lossy as the string it replaces.
        if (!arrayForm && !ambiguous) {
          const parts = trimmed.split(",").map((x) => x.trim()).filter(Boolean);
          if (parts.length > 1 && parts.every((x) => isSide(x))) continue;
        }
        // AN ERROR, NOT A WARNING, AND THAT IS THE WHOLE FIX.
        //
        // A side name that is not a side of the arm is UNMEASURABLE BY
        // CONSTRUCTION: coverage.mjs joins a claim to an istanbul branch by
        // side index, so a label the arm does not have has no counter to read.
        // Warning let it land as a proposal and deferred the refusal to stage
        // 6, where the worker who wrote it is long gone and the run is what
        // pays. Measured on run 20260919T092106Z (location-ms): one claim of
        //
        //   "[] (fallback)" is not a side of this arm (highestCountry?.cities, [])
        //     src/services/location.service.ts#488:binary-expr:0
        //
        // failed `measure` in round 3 — and since `measure` never satisfies,
        // the walk kept dealing rounds, closing three and six sides at a full
        // round's price each, until it was killed at 78 minutes against a
        // 56-minute baseline. The label was `[]` with a gloss the worker added.
        //
        // Refused here, the same worker fixes it in the same round for nothing.
        err(
          where,
          `reaches["${armId}"] = ${JSON.stringify(trimmed)} is not a side of that arm. ` +
            `Name the sides as a JSON ARRAY - one label per entry, verbatim - never a comma-joined string: a label can itself contain a comma` +
            `${ambiguous ? ", and one of this arm's does" : ""}. ` +
            `Valid: ${validList.map((v) => JSON.stringify(v)).join(" | ")}`
        );
      }
    }

    const fn = fnIndex.get(p.functionId);
    if (!fn) {
      err(
        where,
        `\`functionId\` "${p.functionId}" is not in scan.json` +
          // The one id shape that is legal and can still miss: a module-scope
          // owner for a file the scan found no module-scope arm in. Saying so
          // stops the next reader concluding the synthetic owner is refused on
          // principle, which is the state this file was in.
          (String(p.functionId ?? "").endsWith(`:0:${MODULE_SCOPE_NAME}`)
            ? ` — it names the module scope of a file the scan lists no module-scope arm for, so either the path is ` +
              `wrong or the arm this covers belongs to a function in that file`
            : ``)
      );
      continue;
    }

    const firstArm = armIndex.get(p.covers[0]);
    if (firstArm && firstArm.owner.functionId !== p.functionId) {
      err(where, `covers an arm owned by ${firstArm.owner.functionId} but claims functionId ${p.functionId}`);
    }

    // When the proposal drives a CALLER, the arguments belong to that caller —
    // not to the nested function whose arm is being reached. Validating against
    // the nested signature rejects correct proposals and, worse, would push an
    // author to invent arguments for something they cannot call.
    // D79: a driver one line-shift away is the same driver (resolveVia).
    const viaId = resolveVia(fnIndex, p.via).id;
    if (viaId !== p.via && p.via) warn(where, `via "${p.via}" is ${viaId} in this scan - the file moved under it; it is checked as ${viaId}`);
    const driverFn = viaId && !String(viaId).startsWith("trigger:") ? fnIndex.get(viaId) : undefined;
    const signature = driverFn ?? fn;

    // Boundaries on the PATH, not just at the two ends. A routing decision can
    // sit in an intermediate function — `fetchPrompt` reads redisCache.isHealthy()
    // on the way from compilePrompt down to fetchFromLangfuseApi — and a proposal
    // has to be able to answer it.
    const onPath = p.via
      ? scan.functions.filter((x) => {
          if (x.id === fn.id || x.id === viaId) return true;
          const drivers = x.via ? (x.via.drivers ?? [x.via.driver]).filter(Boolean) : [];
          return x.file === fn.file && drivers.includes(viaId);
        })
      : [fn];
    const boundaryScope = onPath.flatMap((x) => x.boundaries);
    const boundaryNames = new Set(boundaryScope.map((b) => b.symbol));
    // The scan's own metadata for a symbol, so a check can ask what KIND of
    // boundary it is - egress, nondeterminism, type-only - instead of guessing
    // from the name.
    const boundaryMeta = new Map(boundaryScope.map((b) => [b.symbol, b]));

    // Only the nested function's own boundaries are REQUIRED to be answered;
    // path boundaries are permitted, not demanded.
    const requiredBoundaries = driverFn ? [...fn.boundaries, ...driverFn.boundaries] : fn.boundaries;

    // `setup` IS AS AGENT-WRITTEN AS `args`, AND NOTHING ASKED WHAT SHAPE IT IS.
    //
    // Three loops below `.entries()` it, `record.mjs` reads `e.apply` off every
    // entry and `handoff.mjs` iterates it at the top of every round — and this
    // file, the one thing standing between an agent's JSON and all of them,
    // asserted the shape of `args` and said nothing about `setup`. So
    // `"setup": {}` passed validation and then threw "is not a function" or
    // "is not iterable" out of whichever tool read it first, which in a walk is
    // handoff, which means round 1 died before a single row was recorded. The
    // file persists on disk, so the next round died the same way.
    //
    // Stated here, beside `args`, because these two are the fields a proposal
    // is mostly made of and the validator is where a shape is decided once for
    // every reader downstream.
    const setupIsList = p.setup === undefined || Array.isArray(p.setup);
    if (!setupIsList) {
      err(where, "`setup` must be an array of { state, apply, from } entries, one per precondition");
    }
    // THE ONLY WALK OF `setup` IN THIS FILE, so a shape error recorded above
    // cannot be re-discovered as a crash by a loop three hundred lines below.
    const setupEntries = setupIsList ? (p.setup ?? []) : [];

    // Arguments: one entry per declared param, positional, each with provenance.
    const argsIsList = Array.isArray(p.args);
    if (!argsIsList) {
      err(where, "`args` must be an array, positional, one entry per declared param");
    } else {
      // `invoke.build` is the escape hatch every trigger row and every
      // constructor-injection row has to use, and until now NOTHING checked it.
      // So an unrunnable expression passed a green gate and only failed at
      // stage 4, where it reads as the service throwing. Three subagents on
      // three repos all routed their hardest rows through this field.
      // D84: `"build" in p.invoke` THROWS on a string, and the throw took the
      // whole validation down with it - qode-ptp-ms (run 20260929T210223Z) had
      // one proposal write `invoke` as the bare expression "await
      // processFlowInBackgroundWithoutWaitEnrichAndRanking({ data, userId })",
      // and every round the validator exited 1 on "Cannot use 'in' operator to
      // search for 'build'", set nothing aside, and asked the whole round again.
      // A non-object `invoke` is this proposal's error, said as one.
      if (p.invoke !== undefined && (p.invoke === null || typeof p.invoke !== "object" || Array.isArray(p.invoke))) {
        err(where, `\`invoke\` must be an object like { "build": "<expression>" }, not ${p.invoke === null ? "null" : Array.isArray(p.invoke) ? "an array" : `a ${typeof p.invoke}`}` +
          (typeof p.invoke === "string" ? ` - put the expression under \`invoke.build\`: { "build": ${JSON.stringify(p.invoke.slice(0, 120))} }` : ""));
      } else if (p.invoke && "build" in p.invoke) {
        const fn = fnIndex.get(p.functionId);
        const copy = copiedFromSubject(p.invoke.build, fn);
        if (typeof p.invoke.build !== "string" || !p.invoke.build.trim()) {
          err(where, "`invoke.build` must be a non-empty JS expression");
        } else if (copy) {
          err(
            where,
            `\`invoke.build\` re-implements \`${fn.name}\` instead of calling it: ${copy.copied} of the ${copy.of} lines of its body ` +
              `(${fn.file}:${fn.line}-${fn.endLine}) are copied into the build, so the row runs the copy and the service's own code never executes. ` +
              (fn.entry?.kind === "module-private"
                ? `\`${fn.name}\` is not exported - ${fn.entry.reason}${fn.via?.drivers?.length ? ` (${fn.via.drivers.join(", ")})` : ""}, or write a BLOCKED.md reason if no caller can reach it.`
                : `Import it and call it.`)
          );
        } else if (!parsesAsExpression(p.invoke.build)) {
          // A WARNING, not an error, and the distinction is load-bearing: the
          // emitted spec is TYPESCRIPT, so `const m: any = await import(...)`
          // is legal there and `new Function` - which is plain JS - rejects it.
          // Making this an error failed 8 proposals on this repo that record
          // perfectly well. So it reports a suspicion and stage 4 remains the
          // authority, which is the correct division anyway.
          advise(where, "`invoke.build` does not parse as plain JS - fine if it uses TypeScript syntax, a defect otherwise; stage 4 is the authority");
        }
      }
      // The same field carries provenance and it was never required, so a
      // proposal whose entire content is a build expression could cite nothing.
      // A warning, not an error: tightening it to an error would reject
      // proposals already on disk across five repos.
      if (p.invoke?.build && !p.invoke.from && !p.args.length && !setupEntries.length) {
        warn(where, "`invoke.build` is the only content here and it carries no `from` - nothing about this proposal is cited");
      }

      /* ----------------------------------------------------------------
       * AN EMPTY `invoke.args` IS NOT "NO ARGUMENTS". IT IS AN OVERRIDE,
       * AND IT WINS.
       *
       * `record.mjs` builds the call as
       *
       *     builtArgs: proposal.invoke.args ?? null
       *
       * and `??` falls back only on null or undefined. `[]` is a value, so an
       * empty `invoke.args` beats the row's own `args[]` and the subject is
       * called with nothing. A handler then runs with `req` and `res`
       * undefined and throws on its first property access, BEFORE any arm of
       * its body executes -- so every `reaches` this row claims is measured
       * FALSE, the row is quarantined, and its sides re-open and are asked
       * again next round.
       *
       * THE COMMENT ABOVE THAT LINE ALREADY DESCRIBES HALF OF THIS DEFECT.
       * It records a probe row on profile-centralized that passed
       * `doubles.expressResponse()` through `args[]` and died with "Cannot
       * read properties of undefined (reading 'status')" because `res` never
       * arrived. That was `?? []`, and fixing it to `?? null` closed the case
       * where `invoke.args` is ABSENT. The case where it is PRESENT AND EMPTY
       * was left, and it produces the identical failure.
       *
       * WHAT IT COST, measured on local runs in this branch's docker/runs/
       * (gitignored and per-worktree, so they live in tree 5 -- tags
       * LOCAL-mt-d5542e1 and SMOKE-1round-5a438f4): message-templates ended
       * `failed` twice on 3 of 68 false `reaches` claims, all three
       * path-not-taken, and both runs diagnosed the cause as rows carrying
       * `invoke.args: []`. 39.6 minutes and $69.60 across the pair, 12 sides
       * never closed. The run on the same branch with ZERO false claims,
       * LOCAL-loc-1fbfe46, finished in 21 minutes with 138 of 138 claims
       * verified. A sibling session recorded the same rate as
       * model-independent -- roughly half the claims false on notification-ms
       * under both Opus and Sonnet -- which is the signature of a pipeline
       * defect and not of a model.
       *
       * REFUSED HERE RATHER THAN NORMALISED IN `record.mjs`. Making an empty
       * array fall through to `args[]` would change what every row already on
       * disk MEANS, silently, including a row that genuinely intends "call
       * this with no arguments" -- and silent changes of meaning are the thing
       * this pipeline has been losing work to all week. A refusal costs the
       * author one edit and states which of the two fields to delete.
       * -------------------------------------------------------------- */
      if (p.invoke && typeof p.invoke === "object" && "args" in p.invoke) {
        if (!Array.isArray(p.invoke.args)) {
          err(where, "`invoke.args` must be an array of values to call the built subject with, or be absent");
        } else if (!p.invoke.args.length && p.args.length) {
          err(
            where,
            `\`invoke.args\` is [] while \`args\` has ${p.args.length} entry(ies), and the empty one WINS: ` +
              "record.mjs calls the subject with `proposal.invoke.args ?? null`, so `[]` overrides `args[]` and " +
              "the subject is invoked with nothing. Every arm past the first use of a missing parameter then " +
              "goes unreached and every `reaches` here is measured FALSE. Delete `invoke.args` to call with " +
              "`args[]`, or delete `args[]` if this subject really takes none"
          );
        }
      }
      const required = signature.params.filter((x) => !x.optional).length;
      const subject = driverFn ? `driver ${driverFn.id}` : "function";
      // A `via` that names something other than a function — an exported
      // singleton, say — means the call shape is not this signature's. The
      // maximum still applies (it catches typos), the minimum cannot.
      const arityKnown = !p.via || Boolean(driverFn);
      if (arityKnown && p.args.length < required) {
        // `invoke` means the subject is a value the proposal BUILDS, so the
        // driver's arity says nothing about it - the decorator factory takes
        // (options) while the decorated method takes the proposal's own args.
        if (!p.invoke?.build) {
          err(where, `${p.args.length} args given, ${subject} requires ${required} (${signature.params.map((x) => paramName(x.name)).join(", ")})`);
        }
      }
      // A REST parameter is unbounded, so arity has no ceiling. Capping it made
      // `runWithFallback(...runs: Run<T>[])` unproposable with more than one
      // runner - the multi-runner fallback the function exists for.
      const variadic = (signature.params ?? []).some((prm) => prm.rest);
      // The MINIMUM check already exempts a built subject; the maximum did not,
      // and it is the same argument - when `invoke.build` names the subject, the
      // driver's signature is not the subject's. profile-centralized could not
      // propose streamToBuffer (driver takes 0, subject takes 1) or the
      // errorHandler decorator's inner handler (driver 0, subject 3), and had to
      // rewrite both as zero-argument thunks that build their own arguments -
      // which moves every value's provenance out of args[] and into prose.
      if (!variadic && !p.invoke?.build && p.args.length > signature.params.length) {
        err(where, `${p.args.length} args given, ${subject} declares ${signature.params.length}`);
      }
      for (const [j, arg] of p.args.entries()) {
        const argWhere = `${where}.args[${j}]${signature.params[j] ? ` (${paramName(signature.params[j].name)})` : ""}`;
        if (!arg || typeof arg !== "object") {
          err(argWhere, "must be an object with a `value` or a `build`, plus a `from`");
          continue;
        }
        // `value` was REQUIRED here and it is not required at stage 4: the
        // recorder inlines `a.build !== undefined ? (build) : JSON.stringify(a.value ?? null)`,
        // so `build` alone is a complete argument and `build` WINS when both are
        // present. An argument no expression can express as a literal - an
        // Express request double, a class instance, a Buffer - has nothing to
        // put in `value`, and this rejected 30 of them in one run under a
        // message that named `value` as mandatory and never mentioned `build`.
        // So the requirement is what stage 4 actually needs: one of the two.
        if (!("value" in arg) && arg.build === undefined) {
          err(argWhere, "must carry a `value` (a literal) or a `build` (a JS expression stage 4 evaluates) — plus a `from`");
          continue;
        }
        // The emitter binds the literal to the name `value` in the expression
        // (record.mjs writeSpec). So a `build` that says `value` with no
        // `value` beside it runs with `undefined` there in the committed test - a pair recorded against a
        // different argument than the one the proposal describes, which is
        // silent at every stage until stage 8.
        if (arg.build !== undefined && !("value" in arg) && /\bvalue\b/.test(String(arg.build))) {
          err(
            argWhere,
            "`build` refers to `value`, which stage 5 substitutes as a literal — add the `value` it is built from, or write the expression without that identifier"
          );
        }
        checkEvidence(argWhere, arg.from, p.covers);
      }
    }

    // --- executable siblings, required so stage 4 can run this proposal ---
    //
    // GUARDED BY THE SHAPE CHECK ABOVE, which it used to ignore. `args` being a
    // non-array is recorded as an error two hundred lines up, and then this
    // loop ran anyway: `(p.args ?? []).entries()` on an object throws
    // "p.args.entries is not a function", so the validator crashed on the very
    // defect it had just written down, and printed none of the errors it had
    // collected for the other proposals. A validator that dies on malformed
    // input is the one input it must survive.
    for (const [j, a] of (argsIsList ? p.args : []).entries()) {
      if (!a || typeof a !== "object") continue;
      const w = `${where}.args[${j}]`;
      if (a.build !== undefined && !parsesAsExpression(a.build)) {
        err(w, `\`build\` must be a JS expression stage 4 can evaluate; got ${JSON.stringify(String(a.build).slice(0, 70))}`);
      }
      // A thunk around a literal, where the literal itself was meant. The
      // declared type decides how loudly: `invoke.build` names its own subject,
      // so this signature's params describe something else and cannot rule.
      const literal = thunkLiteral(a.build);
      if (literal !== null) {
        const prm = p.invoke?.build ? undefined : signature?.params?.[j];
        const fix = `write \`${literal}\` as the \`build\`, or as a \`value\` if it is a literal the emitter can substitute`;
        if (!prm) {
          warn(w, `\`build\` is a thunk around \`${literal}\` - stage 4 passes the function itself, not \`${literal}\`, and nothing unwraps it. If the subject takes a callback this is correct; otherwise ${fix}`);
        } else if (!FUNCTION_TYPE.test(String(prm.type ?? ""))) {
          err(w, `\`build\` is a thunk around \`${literal}\`, but \`${paramName(prm.name)}: ${prm.type}\` does not take a function - stage 4 would pass the arrow (truthy, never awaited into \`${literal}\`), defeating any default parameter. ${fix}`);
        }
      }
      if (a.construct && a.build === undefined) {
        if (parsesAsExpression(a.construct)) {
          warn(w, "`construct` parses as an expression — rename it to `build` so stage 4 uses it");
        } else {
          err(w, `\`construct\` is prose ("${String(a.construct).slice(0, 60)}…") and there is no \`build\`. Stage 4 cannot construct this value.`);
        }
      }
    }

    for (const [sym, a] of Object.entries(p.boundaries ?? {})) {
      const w = `${where}.boundaries.${sym}`;
      const inert = INERT_BEHAVIOUR.test(a?.behaviour ?? "");
      // D68: `"mock": null` IS NO DIRECTIVE, NOT A CRASH. It was read as one and
      // `a.mock.kind` threw `Cannot read properties of null (reading 'kind')` out
      // of main, in every round of run 20260927T061823Z: six rows in three answer
      // files wrote it, so nothing in the corpus was judged, nothing was
      // quarantined, and the rows with a stale functionId landed with them.
      // A null mock is a MISSING directive, exactly as an absent one is: refused
      // by name unless the behaviour says nothing happens, and the row is
      // quarantined, not the round.
      if (a?.mock === undefined || a?.mock === null) {
        if (!inert) err(w, "a live boundary needs a `mock` directive stage 4 can apply, alongside the prose `behaviour`");
        continue;
      }
      if (!a.mock.kind || !MOCK_KINDS.has(a.mock.kind)) {
        err(w, `mock.kind must be one of ${[...MOCK_KINDS].join(" | ")}`);
      }
      if (a.mock.build !== undefined && !parsesAsExpression(a.mock.build)) {
        err(w, "mock.build must be a JS expression");
      } else if (a.mock.build !== undefined && awaitOutsideAsync(a.mock.build)) {
        err(
          w,
          "mock.build is evaluated SYNCHRONOUSLY, outside the row's async block, so a top-level `await` cannot run - " +
            "and the generated spec is a module, where `await` is reserved, so the whole chunk fails to PARSE and every " +
            "row in it records nothing. Write an answer that needs no import: a plain object or a `new Error(...)`. A " +
            "`setup` binding does NOT help - the mocks are rendered above the async block that holds it - so an answer " +
            "that can only be built from an imported class is not expressible today and wants a BLOCKED.md reason, not " +
            "a rewritten build."
        );
      }
      // AN EXECUTABLE ANSWER BESIDE A KIND THAT WILL NOT INSTALL IT.
      //
      // Asked of `record.mjs` rather than of a list here - see the block above
      // `RECORD_MJS`. `"dropped-with-answer"` is the recorder's own word for
      // "a `build`/`value` was written and is NOT used", and it is the entire
      // condition: a bare `{kind: "value"}` or `{kind: "passthrough"}` comes
      // back `"inert"` and is left alone, which keeps the meaning
      // migrate-executable.mjs:105-107 gives the bare form.
      //
      // The sentence is `droppedAnswerNote`'s, so it is word for word the one
      // `blockedReason()` would print in the stage-4 skip a round later. An
      // author who hits this here and the same author reading behaviour.json
      // are told to do the same thing, because it is the same text.
      const decide = disposition();
      if (!decide.refusal && decide.boundaryDisposition(a.mock.kind, a.mock) === "dropped-with-answer") {
        const note = decide.droppedAnswerNote(p.id, sym, a.mock.kind, a.mock, a.mock.module ?? null);
        err(w, `an executable answer beside a kind that installs nothing — ${note.why}. To record it, ${note.howToRecord}.`);
      }
      // `passthrough` and `spy` both DELEGATE TO THE REAL EXPORT - that is
      // their definition, and it is why `spy` exists at all. On a boundary the
      // scan calls network egress, an answer that delegates is a real request
      // to a real host, which is the one thing stage 3 is not allowed to
      // produce: several of these hosts bill per call and a Slack hook posts to
      // a channel people read. The top-level skill states the rule ("`spy` is
      // not a substitute — it delegates to the real export") and nothing
      // enforced it, so an answer that reads as arranged reached the network.
      const meta = boundaryMeta.get(sym);
      if (meta?.global && meta.why === "network" && (a.mock.kind === "passthrough" || a.mock.kind === "spy")) {
        err(
          w,
          `mock.kind "${a.mock.kind}" delegates to the real \`${sym}\`, which the scan calls network egress — the row would reach a real host. Answer it with returns / resolves / rejects / throws / notCalled.`
        );
      }
    }

    for (const [j, entry] of setupEntries.entries()) {
      const w = `${where}.setup[${j}]`;
      if (!entry || typeof entry !== "object") continue;
      if (entry.apply === undefined) {
        if (BOUNDARY_PROSE.test(entry.state ?? "")) {
          err(w, `this describes a boundary outcome ("${String(entry.state).slice(0, 55)}…") — move it to boundaries[<symbol>].mock, not setup`);
        } else {
          err(w, "needs an `apply` directive: { env }, { call }, { module } or { manual }");
        }
        continue;
      }
      // `apply` IS AN OBJECT, AND THE REFUSAL FOR A STRING NAMED THE WRONG
      // THING. `Object.keys("env")` is `["0","1","2"]`, so a row that wrote
      // `"apply": "env"` — the shape `--schema` itself invited, see
      // `applyShapeFault` — was refused three times with
      //
      //   apply.0 is not one of env | call | module | manual | db
      //   apply.1 is not one of env | call | module | manual | db
      //   apply.2 is not one of env | call | module | manual | db
      //
      // which names a character index as though it were a key and never says
      // that the field is an object. Plan 19 reads seven of these in one file
      // as evidence that D63's newly addressable callback sides are "answered
      // malformed"; the `setup.apply` faults on run 20260919T092410Z total 27
      // quarantine events — 14 "apply.call must be a JS expression" and 13
      // "apply is not an object" — which is the largest bucket in that run
      // when the two are counted as one shape, and the module-scope refusal
      // documented at the top of this file is the largest single message at
      // 18. Said both ways because the file used to claim both.
      //
      // THE SENTENCE THIS BLOCK USED TO CARRY — *"the kind the author chose is
      // usually right and only its WRAPPER is missing"* — was right about the
      // kind and wrong about what the row was missing. Every one of the 18
      // rows measured over the logs on this machine was missing `state` TOO,
      // and got that as a SEPARATE fault reported after the four `apply` ones.
      // So the refusal is `applyShapeFault`'s and prints the WHOLE entry: one
      // shape, said once, at the top of the row's fault list. NOTHING IS
      // COERCED — a bare `"call"` carries no expression and these rows carry
      // no `state`, so there is nothing to normalise into.
      //
      // `enforcedRules()` no longer lists this one, because it scans for a
      // string literal next to `err(` and this message is composed per row.
      // That list is not where a worker reads it: `steps/derive.mjs`'s
      // `readSchema` takes `section(stdout, "vocabularies")` and nothing
      // below it, so the rules list has never reached a packet. The sentence
      // is in the vocabularies block instead — see `printSchema` — which is
      // the half that does.
      const shapeFault = applyShapeFault(entry, p.covers?.[0]);
      if (shapeFault) {
        err(w, shapeFault);
        continue;
      }
      const keys = Object.keys(entry.apply);
      for (const k of keys) if (!APPLY_KINDS.includes(k)) err(w, `apply.${k} is not one of ${APPLY_KINDS.join(" | ")}`);
      if (entry.apply.call !== undefined) {
        // The head is a literal so `enforcedRules()` keeps listing the rule;
        // `callExpressionCause` supplies the half that is about THIS string.
        const why = callExpressionCause(entry.apply.call);
        if (why) err(w, `apply.call must be a JS expression stage 4 can evaluate, and ${why}.`);
      }

      // A mutation of shared external state MUST carry its own undo. Without
      // this, a stage-4 run flips a staging config row and leaves it flipped —
      // which is exactly what the first version of these three proposals did.
      // TWO shapes, because the executor only ever supported one of them and
      // this file only ever accepted the other.
      //
      // Measured: `record.mjs:605` refuses anything that is not
      // `{ create: { model, data } }` — verbatim, *"setup.apply.db supports
      // { create: { model, data } } only - an undo has to be derivable"* — while
      // the loop below demanded six keys, none of them `create`. So a seed
      // written for the recorder failed validation with six errors, and a seed
      // written for validation was silently `runnable: false` at stage 4. The
      // mechanism was unusable from either end, which is why every repo that
      // needed a row wrote it off as `data-blocked` instead.
      //
      // A `create` IS fully specified including its undo: the created id is the
      // undo, and `record.mjs` journals it and reverse-replays it with
      // verification. So it is accepted on its own terms and asked only for the
      // rationale that every other shared-state mutation carries.
      if (entry.apply.db !== undefined) {
        const d = entry.apply.db;
        if (d.create !== undefined) {
          for (const field of ["model", "data"]) {
            if (d.create[field] === undefined) {
              err(w, `apply.db.create needs \`${field}\` — record.mjs:605 refuses a seed without it`);
            }
          }
          if (d.why === undefined) {
            err(w, "apply.db needs `why` — a row written into shared staging says what it is for");
          }
          // Only under --live is the write journalled and reverted, so a seed
          // that never says so reads as a mocked-run input and is not one.
          if (d.urlVar && /READ_ONLY/i.test(d.urlVar)) {
            err(w, "apply.db.urlVar points at a read-only URL; a mutation needs the writable one, named explicitly");
          }
        } else {
          // The legacy shape validates but `record.mjs` refuses it, so a row
          // written this way is skipped every run with nobody reading the
          // reason. A warning rather than an error: existing proposals on the
          // pilot repo may still carry it, and breaking them is worse than
          // naming it.
          warn(w, "apply.db uses the six-key `set`/`revert` shape, which record.mjs:605 refuses — the row will be skipped every run. Rewrite it as { create: { model, data }, why }");
          for (const field of ["urlVar", "table", "where", "set", "revert", "why"]) {
            if (d[field] === undefined) err(w, `apply.db needs \`${field}\` — a shared-state mutation must be fully specified, including its undo (or use the \`create\` form: { create: { model, data }, why })`);
          }
          if (d.revert && JSON.stringify(d.revert) === JSON.stringify(d.set)) {
            err(w, "apply.db.revert is identical to `set` — that is not an undo");
          }
          if (d.urlVar && /READ_ONLY/i.test(d.urlVar)) {
            err(w, "apply.db.urlVar points at a read-only URL; a mutation needs the writable one, named explicitly");
          }
        }
      }
    }

    // NOTE: an earlier version of this block tried to infer a contradiction by
    // matching "rejects" in the prose against mock.kind. It produced 11 false
    // positives (a `returns` of a STUB whose inner method rejects is correct,
    // and "rather than rejecting" reads as a rejection) while MISSING the four
    // proposals that were actually broken, because their prose named "the
    // executor" rather than the boundary symbol. A check that is noisy and
    // still misses the defect is worse than no check, so it was removed.
    //
    // This defect class - a mock that does not steer the arm it claims to -
    // is caught by STAGE 5 measuring whether the side actually went green.
    // That is the honest place for it.

    // A boundary whose prose says "see setup" while `setup` is empty is a
    // DANGLING REFERENCE: the sentence points at nothing, so the mock beside it
    // has no stated intent to check against. 22 of these appeared after setup
    // entries were relocated into boundary mocks and the prose was left behind.
    for (const [sym, ans] of Object.entries(p.boundaries ?? {})) {
      if (!/see setup/i.test(ans?.behaviour ?? "")) continue;
      if (setupEntries.length === 0) {
        err(
          `${where}.boundaries.${sym}`,
          'behaviour says "see setup" but `setup` is empty — say the outcome here, or the mock has no stated intent'
        );
      }
    }

    // An env value is a literal that gets assigned. Prose in it would be set as
    // the variable's value verbatim.
    for (const [j, e] of setupEntries.entries()) {
      for (const [k, v] of Object.entries(e?.apply?.env ?? {})) {
        if (v === null) continue; // unset for this row - see APPLY_BODY
        const val = String(v);
        if (/\s(so|because|which|and [A-Z])/.test(val) || val.split(/\s+/).length > 2) {
          err(
            `${where}.setup[${j}].apply.env.${k}`,
            `value ${JSON.stringify(val.slice(0, 60))} is prose, not a literal — it would be assigned verbatim. Put the reason in \`state\`.`
          );
        }
      }
    }

    // `setup` records a precondition that is STATE, not an argument — a singleton
    // already constructed, an env var set. It carries provenance like a value.
    for (const [j, entry] of setupEntries.entries()) {
      const setupWhere = `${where}.setup[${j}]`;
      if (!entry || typeof entry !== "object" || !entry.state) {
        err(setupWhere, "must be an object with a `state` and a `from`");
        continue;
      }
      checkEvidence(setupWhere, entry.from, p.covers);
    }

    // Boundary answers: arms 3 and 4 of a try/catch take the SAME arguments and
    // differ only here, so an unanswered boundary is an unreachable arm.
    const answers = p.boundaries ?? {};
    for (const b of requiredBoundaries) {
      if (!(b.symbol in answers)) {
        // An ADVISORY boundary is real nondeterminism that only matters when
        // the recorded value depends on it - a Date.now() in a log line does
        // not need controlling, one in the returned object does. Demanding an
        // answer for every one added 43 warnings to correct work in a single
        // run, all Date or setTimeout, and a check that noisy gets tuned off.
        if (b.advisory) continue;
        // A TYPE-ONLY symbol has no runtime existence to answer for.
        // `collectBoundaries` matched any identifier in the body against the
        // file's import map without asking whether it stood in a type
        // position, so `const m: EmailMessage = …` reported `EmailMessage` as a
        // live boundary. Measured on one freshly-onboarded service: 6 of 47
        // boundary answers existed only to say that a type is a type, and the
        // only escape was the `INERT_BEHAVIOUR` regex - an answer whose whole
        // content is the word "type only". ts-morph knows the position, so the
        // scan now marks it and this stops asking. Kept in the list rather than
        // dropped from it, so an answer already written for one does not become
        // an "answers a boundary nothing touches" advisory instead.
        if (b.typeOnly) continue;
        warn(where, `no answer declared for boundary \`${b.symbol}\` (${b.module})`);
        continue;
      }
      const a = answers[b.symbol];
      if (!a || typeof a !== "object" || !a.behaviour) {
        err(`${where}.boundaries.${b.symbol}`, "must declare a `behaviour` (e.g. resolves / rejects / throws)");
        continue;
      }
      // An INHERITED answer cites the function, not this row, so the
      // "cites an arm this proposal does not list in `covers`" cross-check does
      // not apply to it - passing `null` skips exactly that one comparison and
      // keeps every other provenance check. Without this, hoisting 613
      // restatements would have produced 613 warnings, which is the same bill
      // under a different name.
      checkEvidence(
        `${where}.boundaries.${b.symbol}`,
        a.from,
        p._inherited?.has(b.symbol) ? null : p.covers
      );
    }

    for (const key of Object.keys(answers)) {
      if (!boundaryNames.has(key)) {
        // An ADVISORY, not a warning. `collectBoundaries` reads a function's
        // own identifiers against its own import map and does not follow calls,
        // so a boundary reached through a private helper or a decorator is
        // real and absent from the list - the stage-3 skill says in as many
        // words that this warning "is the tool's blind spot, not your error"
        // and tells the author to declare it anyway. 226 of this repo's 296
        // warnings were this one, on a corpus with zero errors, which left
        // "declare it anyway" and "pass the gate" mutually exclusive.
        advise(
          where,
          `answers boundary \`${key}\`, which neither ${p.functionId}${p.via ? ` nor its driver ${p.via}` : ""} touches — declare it anyway if the call chain reaches it; \`collectBoundaries\` does not follow calls`
        );
      }
    }

    // Expected outputs are stage 4's job. Accepting one here is exactly how a
    // suite ends up asserting the agent's guesses back at itself.
    for (const banned of BANNED_FIELDS) {
      if (banned in p) {
        err(where, `\`${banned}\` is not allowed in a proposal — the machine records the output in stage 4`);
      }
    }

    // An UNFILLED SKELETON. The pre-fill removes every address from the
    // author's hands, which is the whole point of it - and it would also let a
    // batch of 40 untouched skeletons through the gate as finished work, which
    // is the whole cost. So the sentinel is scanned for wherever it survives,
    // to any depth, and named with its path.
    for (const path of sentinelPaths(p)) {
      err(where, `${path} is still the skeleton's \`${SKELETON_TODO}\` placeholder — that slot is the derivation, and nothing has been derived into it`);
    }
  }

  const coveredArms = new Set(list.flatMap((p) => p.covers ?? []));
  const reachable = worklist.items.filter((i) => i.owner.entry.reachable);

  // A function-entry unit asks only "was this invoked at all". Any proposal that
  // targets the function answers it, so crediting it only on an explicit
  // `covers` entry under-reports the work that is actually done.
  const targeted = new Set(list.map((p) => p.functionId));
  const impliedEntries = worklist.items.filter(
    (i) =>
      i.kind === "function-entry" &&
      !coveredArms.has(i.armId) &&
      targeted.has(i.owner.functionId)
  );
  for (const i of impliedEntries) coveredArms.add(i.armId);

  // WHICH LEVEL answered each boundary, because a hoisted answer that a reader
  // cannot locate is worse than a restated one. The counts say how much is
  // inherited; the override list is printed in full, because an override is the
  // one place the two levels disagree and therefore the only part worth reading.
  const answered = list.reduce((n, p) => n + Object.keys(p.boundaries ?? {}).length, 0);
  const inheritedCount = list.reduce((n, p) => n + (p._inherited?.size ?? 0), 0);
  const overrides = list.flatMap((p) =>
    [...(p._overridden ?? [])].map((sym) => `${p._file}[${p.id}] overrides \`${sym}\` declared for ${p.functionId}`)
  );
  const hoistedSymbols = new Set(
    list.flatMap((p) => [...(p._inherited ?? []), ...(p._overridden ?? [])].map((s) => `${p.functionId}#${s}`))
  );

  process.stdout.write(
    `\n${errors.length ? "✗" : "✓"} validated ${list.length} proposals from ${files.length} file(s) in ${relative(REPO_ROOT, PROPOSALS_DIR)}/\n` +
      `    units addressed    ${coveredArms.size} of ${worklist.items.length} uncovered (${reachable.length} behind an own entry)\n` +
      `    of which implied   ${impliedEntries.length} function-entry units, satisfied by a proposal on the same function\n` +
      `    boundary answers   ${answered} = ${inheritedCount} inherited from ${hoistedSymbols.size} function-level declaration(s) + ${answered - inheritedCount} written on the row (${overrides.length} of them overriding)\n` +
      `    errors             ${errors.length}\n` +
      stage3ClockLine() +
      `    warnings           ${warnings.length}\n` +
      // A SEPARATE line, and deliberately not called a warning: `gate.mjs`
      // matches /warnings\s+(\d+)/ and fails on anything but zero, so a count
      // printed under that word is a gate failure whatever the text says.
      `    advisories         ${advisories.length}  (the tool's own blind spots — reported, not gating)\n`
  );

  for (const o of overrides) process.stdout.write(`  · ${o}\n`);
  for (const a of advisories) process.stdout.write(`  · ${a}\n`);
  for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  for (const e of errors) process.stdout.write(`  ✗ ${e}\n`);

  // LAST, so a `| tail -N` cannot scroll it off. See stage3ClockBanner().
  process.stdout.write(stage3ClockBanner());

  if (errors.length) process.exit(1);
}
// ---------------------------------------------------------------------------
// `--schema`, AND THE REFUSAL THAT HAD TO COME WITH IT
//
// WHY THIS FLAG EXISTS. Measured on run 20260915T050314Z (mocked, 949 tool
// calls): 192 calls - 20.2% of the run - opened this pipeline's own source
// without executing it, and 79 of them were the agent recovering a legal-value
// vocabulary that is a named constant a few lines above. `MOCK_KINDS` alone was
// reconstructed by grep six separate times, including
// `grep -n "KIND\|VALID_KINDS\|kindSet\|Set(\[.*resolves" validate.mjs`.
// Until now this file had NO command-line flags at all, so the only two ways to
// obtain the vocabulary were to read the file or to be refused by it.
//
// WHY IT IS A FLAG AND NOT A DOCUMENT. It was a document, twice, and the
// document was wrong both times. `PROPOSAL-CONTRACT.md` shipped unreachable,
// then shipped with the blocked-entry field list wrong, and on the day this was
// written its `mock.kind` table offered `live` - which the Set below refuses -
// and omitted `value`, which it accepts. In the same run the agent read that
// document 15 times and then ran
// `grep -n 'passthrough' record.mjs docs/PROPOSAL-CONTRACT.md validate.mjs`,
// naming the document and both enforcing files in ONE pattern: it did not treat
// the prose as settled, and it was right. A printer over `MOCK_KINDS` cannot
// disagree with `MOCK_KINDS`. A markdown table can, and did.
//
// SO NOTHING BELOW RESTATES A RULE. The vocabularies are rendered from the
// constants themselves - `[...MOCK_KINDS].join(" | ")` is the same expression
// the refusal at the `mock.kind` check already uses - the blocked-entry
// vocabularies are imported from `ledger.mjs`, which owns the format and is the
// thing that fails when an entry is wrong, and the policy sets are imported
// from `policy.mjs`. The rule list is read out of THIS FILE'S OWN `err()` call
// sites at run time, so a check added tomorrow appears tomorrow and a check
// deleted disappears. There is no fixture, no table, and no second copy.
//
// AND THE REFUSAL IS THE SHIP CONDITION, not a nicety. This file parsed no
// arguments, which does not mean it rejected them - it means it IGNORED them.
// `validate.mjs --schema` before this change ran a full validation and exited
// 0, so a typo (`--schemas`, `--Schema`) would have read as "schema printed
// fine" while printing nothing: a failure absorbed rather than reported, which
// is the drop-off this toolset is built to refuse. An unknown argument now
// exits non-zero and names the argument.
// ---------------------------------------------------------------------------
const ARGV = process.argv.slice(2);
const KNOWN_FLAGS = ["--schema"];

/**
 * The second argument of every `err(...)` in this file, with its line number.
 *
 * Read out of the source rather than listed, because a list is a copy and a
 * copy drifts. The scanner walks to the top-level comma of each `err(` call -
 * skipping strings, templates and nested `${}` - and takes the literal after
 * it, so a message spread over four lines is found the same way a one-liner is.
 * Interpolations are shown as `<…>`: the rule is the sentence, and the value
 * that fills the hole belongs to the proposal that failed, not to the schema.
 */
function enforcedRules() {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const rules = [];
  for (let i = src.indexOf("err("); i !== -1; i = src.indexOf("err(", i + 1)) {
    // `const err = (where, msg) => ...` is the definition, not a call site —
    // and `indexOf("err(")` two functions above is this scanner finding its own
    // search string, which it did on the first run and printed 40 lines of its
    // own source as a rule. Both are excluded by looking at one character.
    if (/[A-Za-z0-9_$."'`]/.test(src[i - 1] ?? "")) continue;
    const comma = topLevelComma(src, i + 4);
    if (comma === -1) continue;
    let j = comma + 1;
    while (j < src.length && /\s/.test(src[j])) j += 1;
    const quote = src[j];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    // A real call's message sits next to its call. Anything further away is the
    // scanner having walked out of a construct it did not understand, and a
    // rule list that quietly includes a stray literal is worse than a short one.
    if (j - i > 200) continue;
    const end = literalEnd(src, j);
    if (end === -1) continue;
    rules.push({
      line: src.slice(0, i).split("\n").length,
      text: placeholders(src.slice(j + 1, end)),
    });
  }
  return rules;
}

/** Index of the comma separating `err`'s two arguments, or -1. */
function topLevelComma(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = literalEnd(src, i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (c === "," && depth === 0) return i;
  }
  return -1;
}

/** Index of the closing quote of the literal opening at `open`, or -1. */
function literalEnd(src, open) {
  const quote = src[open];
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") { i += 1; continue; }
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      // A `${}` may itself hold a template, so match braces rather than scan.
      let depth = 1;
      i += 2;
      for (; i < src.length && depth; i += 1) {
        if (src[i] === "\\") { i += 1; continue; }
        if (src[i] === "`") { i = literalEnd(src, i); if (i === -1) return -1; continue; }
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") depth -= 1;
      }
      i -= 1;
      continue;
    }
    if (c === quote) return i;
  }
  return -1;
}

/** `${whatever}` → `<…>`, brace-matched so a nested template does not truncate. */
function placeholders(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") { out += text[i + 1] ?? ""; i += 1; continue; }
    if (text[i] === "$" && text[i + 1] === "{") {
      let depth = 1;
      i += 2;
      for (; i < text.length && depth; i += 1) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
      }
      i -= 1;
      out += "<…>";
      continue;
    }
    out += text[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * What stage 3 is allowed to write, printed from the things that enforce it.
 *
 * `ledger.mjs` and `policy.mjs` are imported HERE rather than at the top of the
 * file on purpose: the validation path's dependency graph is unchanged by this
 * flag, so nothing about a normal run is different. It is a read path that
 * costs a normal run nothing, which is the only kind of addition this file was
 * open to.
 */
async function printSchema() {
  const { CATEGORIES, KILLERS } = await import("./ledger.mjs");
  const { REAL_ONLY, KEEP_AS_DECLARED, REDIS_MOCK_POINT, SLACK_MOCK_POINT } = await import("./policy.mjs");
  const set = (s) => [...s].join(" | ");
  const out = [];

  out.push("# charpilot proposal schema");
  out.push("");
  out.push("Printed from the constants validate.mjs enforces and the checks it runs.");
  out.push("Nothing here is transcribed: if this disagrees with a document, the document is wrong.");
  out.push("");
  out.push("## vocabularies");
  out.push("");
  out.push(`boundaries[<symbol>].mock.kind   ${set(MOCK_KINDS)}`);
  // WHICH OF THOSE EIGHT ACTUALLY INSTALL WHAT YOU WRITE BESIDE THEM.
  //
  // The vocabulary alone answered "is this kind legal" and never "will my
  // `build` be used", and the gap between those two questions is what run
  // 20260916T223906Z spent 216 minutes on. Partitioned by asking `record.mjs`'s
  // own `boundaryDisposition` about each kind — the same reading the refusal
  // uses — so this cannot drift from the recorder or from the check.
  const decide = disposition();
  if (decide.refusal) {
    out.push(`  ^ which of these install an answer: NOT READABLE — ${decide.refusal}`);
  } else {
    const installs = [...MOCK_KINDS].filter((k) => decide.boundaryDisposition(k, { kind: k, build: "0" }) === "install");
    const drops = [...MOCK_KINDS].filter((k) => decide.boundaryDisposition(k, { kind: k, build: "0" }) === "dropped-with-answer");
    out.push(`    ^ record.mjs INSTALLS the boundary for     ${installs.join(" | ")}`);
    out.push(`    ^ record.mjs DROPS an answer written beside ${drops.join(" | ")}`);
    out.push("      ^ those delegate to the real export, so a `build`/`value` beside one is never");
    out.push("        installed and the real export runs — refused here instead of at stage 4.");
    out.push("        Bare — no `build`, no `value` — they are inert and perfectly legal.");
    out.push("      ^ both rows come from record.mjs's boundaryDisposition(), not from a list here.");
  }
  // THE LINE THAT TAUGHT THE DEFECT. It read
  //   setup[].apply                    env | call | module | manual | db
  // directly under `mock.kind`'s identically-shaped line, which IS a bare word
  // — so it said, in this document's own authoritative voice, that `apply` is
  // one of five words. It is not: it is an object whose KEY is one of them.
  // See `applyShapeFault` for the measurement. The kinds are still APPLY_KINDS
  // and still not transcribed; only the grammar around them is corrected.
  out.push(`setup[].apply                    ${applyForms()}`);
  out.push(`    ^ THE KIND IS THE KEY, NOT THE VALUE. \`"apply": "call"\` is not a directive: it is the key`);
  out.push("      with no payload, and it is the largest single fault class this checker has recorded.");
  out.push(`setup[] entry, whole             ${setupEntryExample("call", "<an arm this row covers>")}`);
  out.push("    ^ three fields. `state` is the prose the directive arranges, `apply` is the directive,");
  out.push("      `from` is its provenance and its `arm` must be one this row lists in `covers`.");
  out.push(`proposals[i].<field> NOT allowed  ${BANNED_FIELDS.join(" | ")}`);
  out.push(`unfilled-slot sentinel           ${SKELETON_TODO}`);
  out.push("");
  out.push("BLOCKED.md, from ledger.mjs — the parser that fails when an entry is wrong:");
  out.push(`  category                       ${set(CATEGORIES)}`);
  out.push(`  killer                         ${set(KILLERS)}`);
  out.push("");
  // ONE HEADING OVER FOUR SETS SAID THE OPPOSITE OF WHAT HALF OF THEM MEAN.
  //
  // The heading was "which symbols stage 4 refuses to stand in for". That is
  // true of REAL_ONLY and the exact inverse of KEEP_AS_DECLARED and
  // REDIS_MOCK_POINT, which are the symbols stage 4 WILL stand in for - so
  // roughly half the names an agent read here were labelled with the opposite
  // of their meaning, on every item of every round. Each set now carries its
  // own sentence.
  //
  // The heading was also unconditional and the behaviour is not: even a
  // REAL_ONLY symbol keeps the proposal's declared answer in a MOCKED run,
  // because the drop is gated on REAL_DOWNSTREAM = LIVE && POLICY ===
  // "real-except-cache" (record.mjs:367) and spent at record.mjs:1004.
  out.push("boundary policy, from policy.mjs — what stage 4 does with your declared answer:");
  out.push(`  REAL_ONLY                      ${set(REAL_ONLY)}`);
  out.push("    ^ dropped under --live, where the real boundary is recorded instead. In a");
  out.push("      MOCKED run your answer still stands, and it is the only answer there is,");
  out.push("      so it must be true of the real thing - not merely enough to steer the arm.");
  out.push(`  KEEP_AS_DECLARED               ${set(KEEP_AS_DECLARED)}`);
  out.push("    ^ your declared answer is what runs, in BOTH modes.");
  // Two empty sets that are empty for different reasons rendered identically,
  // which reads as one fact and is two. Derived-and-empty is a statement about
  // this repo; literal-and-empty is a permanent decision.
  out.push(`  REDIS_MOCK_POINT               ${set(REDIS_MOCK_POINT) || "(empty — this target has no Redis)"}`);
  out.push("    ^ stood in for at the cache seam, whatever a proposal declared above it.");
  out.push(`  SLACK_MOCK_POINT               ${set(SLACK_MOCK_POINT) || "(empty — always; Slack is refused at its endpoint, never mocked)"}`);
  out.push("    ^ do not write a Slack mock to satisfy a document: hooks.slack.com is in no");
  out.push("      allowlist, so a real send is refused as blocked egress and named.");
  out.push("");
  out.push("## shapes the checker matches");
  out.push("");
  out.push(`a thunk around a literal         ${THUNK_LITERAL.source}`);
  out.push(`a type that may take a function  ${FUNCTION_TYPE.source}`);
  out.push(`prose that belongs in a mock     ${BOUNDARY_PROSE.source}`);
  out.push(`a boundary answer meaning inert  ${INERT_BEHAVIOUR.source}`);
  out.push("");

  const rules = enforcedRules();
  out.push(`## every rule this file enforces (${rules.length}), in its own words`);
  out.push("");
  out.push("Read out of validate.mjs's own err() sites at run time. <…> is a value from");
  out.push("the failing proposal. A warning is not in this list: the gate fails on errors.");
  out.push("");
  for (const r of rules) out.push(`validate.mjs:${String(r.line).padStart(4)}  ${r.text}`);
  out.push("");

  process.stdout.write(out.join("\n") + "\n");
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
  // BEFORE loadProposals, and before anything reads a file. A schema printer
  // that is also a validation run is a behaviour change wearing a read-path
  // label, and `--schema` on a repo with no proposals yet must still answer.
  const unknown = ARGV.filter((a) => !KNOWN_FLAGS.includes(a));
  if (unknown.length) {
    process.stderr.write(
      `✗ validate.mjs: unrecognised argument ${unknown.map((u) => JSON.stringify(u)).join(", ")}\n` +
        `  known flags: ${KNOWN_FLAGS.join(" | ")}\n` +
        `  This file ignored every argument until ${KNOWN_FLAGS.join("/")} existed, so a typo used to\n` +
        `  run a full validation and exit 0 - a schema request that printed no schema and said so.\n`
    );
    process.exit(2);
  }
  if (ARGV.includes("--schema")) {
    // `.then` rather than `await`, and this is not a style choice. A top-level
    // `await` — even one inside an `if` that is false on every import — makes
    // this an ASYNC MODULE, and `record.mjs` imports `loadProposals` from here.
    // Turning a dependency of the recorder async to print a list of strings is
    // exactly the kind of incidental behaviour change that has no business
    // riding along with a read-path flag.
    printSchema().then(
      () => process.exit(0),
      (e) => {
        process.stderr.write(`✗ validate.mjs --schema: ${e?.message ?? e}\n`);
        process.exit(1);
      }
    );
  } else {
    main();
  }
}
