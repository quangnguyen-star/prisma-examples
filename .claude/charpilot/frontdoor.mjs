#!/usr/bin/env node
/**
 * frontdoor — the sides a RULE can answer, answered before a model is asked.
 *
 *   node .claude/charpilot/frontdoor.mjs                  # the census, writes nothing
 *   node .claude/charpilot/frontdoor.mjs --write          # submit the candidates it has
 *   node .claude/charpilot/frontdoor.mjs --json           # the census as a document
 *   node .claude/charpilot/frontdoor.mjs --callers        # inspect the no-own-entry gate
 *   node .claude/charpilot/frontdoor.mjs --no-recording   # the census without behaviour.json
 *   node .claude/charpilot/frontdoor.mjs --scan out/fleet/<repo>/scan.json
 *                                                        # classify a CACHED scan, no repo
 *
 * WHY THIS EXISTS, in the numbers that paid for it. On run `20260916T223906Z`
 * stage 3 took 190.5 minutes against location-ms. 55.4 of those minutes were
 * the agent reading charpilot's OWN tools to recover contracts, and 93 of its
 * 98 source reads were re-reads of a file it had already opened. The work that
 * survives all of that is one derived input per side — and for some sides the
 * input is not a reading of the function at all, it is a restatement of what
 * the scan already wrote down. `expandViewport: number = 100` has exactly one
 * uncovered side, "expandViewport falls back to its default", and exactly one
 * input that takes it: call the function without that argument. Nothing about
 * the body decides it.
 *
 * So this is a DETERMINISTIC PRE-PASS. It reads the work list and the scan,
 * puts every open side into a pattern family, and for the families where the
 * input follows from the arm's own text it writes a candidate proposal. What it
 * cannot answer it does not mention again: the agent gets the rest, unchanged,
 * through the same brief it always got.
 *
 * WHAT A WRONG CANDIDATE COSTS, which is why almost every shape is refused.
 * A candidate is not a suggestion. `validate.mjs` takes it, `record.mjs` runs
 * it, and stage 6 reconciles its claim against istanbul. A claim that does not
 * hold is a FALSE CLAIM — the most expensive failure this pipeline has, because
 * it is the one that looks like progress. An absent candidate costs one side of
 * one round at the price the agent was going to pay anyway. So every gate below
 * refuses on doubt, and each refusal is counted and named rather than dropped:
 * a rule that silently answers less than it did is the same defect as one that
 * answers wrongly, one report later.
 *
 * THE THREE FAMILIES, and why these three first.
 *
 *   default-arg    `expandViewport: number = 100`. istanbul gives this arm ONE
 *                  location, so there is one side, and the input is to omit the
 *                  argument. The binding happens before the body runs, so no
 *                  statement in the function can divert it.
 *   nullish/falsy  `a ?? b`, `a || b`, where the left operand is a parameter.
 *                  Two locations: operand 0 is incremented when the expression
 *                  is evaluated, operand 1 when the left did not short-circuit.
 *                  So `null` takes both and a truthy value takes the first.
 *   comparison     `if (x === "a")`, `n > 0 ? … : …`, where one operand is a
 *                  parameter and the other is a literal the scan already
 *                  carries in the arm's own `text`. The two sides are the
 *                  comparison and its negation, and both values come off the
 *                  literal.
 *
 * Everything else — `switch`, `catch`, a condition over a property, a call or a
 * local, an `if` whose subject is not a parameter — produces NOTHING. Those are
 * readings of behaviour, and this file has not read any behaviour.
 *
 * WHAT IT REFUSES BEFORE IT LOOKS AT THE FAMILY AT ALL, in the order asked:
 *
 *   not instrumented        istanbul has no counter for the side, so no claim
 *                           about it can ever be verified. `openSides` drops
 *                           these from the brief for the same reason.
 *   no own entry            the arm is reached through a caller, so `args` are
 *                           positioned against the DRIVER and steering the arm
 *                           means choosing the caller's arguments — which is a
 *                           reading of the caller. NOT asked when the driver
 *                           is an exported INSTANCE rather than a function:
 *                           `validate.mjs` positions `args` against the arm's
 *                           own signature there, so nothing about the caller
 *                           is needed. `instanceAddress` is that exception and
 *                           states its own limits.
 *   entry needs building    a class whose constructor takes parameters. The
 *                           rule would have to invent them.
 *   a boundary to answer    every non-advisory, non-type-only boundary of the
 *                           function needs a `behaviour` and a `mock`
 *                           (validate.mjs:1373), and both are statements about
 *                           what a collaborator does. On qode-ptp-ms's work
 *                           list this alone is the first refusal for 3,046 of
 *                           its 8,546 instrumented open sides.
 *
 * WHAT IT IS WORTH TODAY, measured over the six work lists on disk
 * (interview-service, location-ms, notification-ms, pricing-ms,
 * profile-centralized, qode-ptp-ms — each one the repo's own last measured
 * state, not a fresh run):
 *
 *   19,931 open sides, 9,617 of them instrumented and therefore askable
 *      888 are a shape this file recognises   (nullish 530, comparison 224,
 *                                              default-arg 134)
 *       26 become a candidate                 0.27% of the instrumented sides
 *
 * The gap between 888 and 26 is two gates and nothing else: 419 of those sides
 * are reached only through a caller and 346 have a boundary to answer. That is
 * the list that says what the next rule is, and it is printed by this command
 * on every run rather than written down here.
 *
 * BOTH GATES HAVE NOW BEEN INSPECTED, AND ONE OPENED IN ONE SHAPE. Plan 16
 * puts the ceiling at 808 of 9,617 — 8.4% — if both opened perfectly. This is
 * what looking at them actually found, and the census after all of it reads
 * 26 candidates, 888 shapes, 9,617 instrumented sides.
 *
 *   the caller gate — measured; the FORWARDING half not opened, the ADDRESS
 *      half opened. `--callers` prints the distribution of the 486 it started
 *      at. **10 of them are reached through a driver that forwards its
 *      argument unchanged** — 2.1% of the gate and 0.10% of the instrumented
 *      sides. Plan 16 ranks this item "measure, then decide"; a 2.1% share is
 *      not a real share, so the forwarding rule is NOT built and `callerGate`
 *      is the measurement anybody who disagrees has to re-run. Of the rest,
 *      153 have a boundary on the DRIVER (the other gate, one frame up), 131
 *      are two or more frames out, 38 turn on something that is not a plain
 *      parameter, 25 are framework triggers with no caller at all — and 96
 *      were "reached through an exported binding rather than a function",
 *      which turned out not to be a caller problem at all. See
 *      `instanceAddress`: their arguments are their own, the receiver's name
 *      is already a field (`via`), and the refusal was resting on a premise
 *      `validate.mjs` contradicts. That one is built, it moves 96 sides off
 *      `no-own-entry`, and **4 of the 96 survive the later gates** — 90 have a
 *      boundary to answer, 1 has no plain parameter, 1 cannot have its call
 *      built. The census moves 22 -> 26 and location-ms is still 0.
 *
 *   the boundary gate — opened in one narrow shape, which yields nothing yet.
 *      A `notCalled` answer is written for a symbol that the arm's own text
 *      does not mention AND that the recorder ran this function without ever
 *      calling. It learns from `behaviour.json` — stage 4's output — and never
 *      from source. Measured over the six work lists with each repo's own
 *      recording loaded: it frees **23 sides** through the boundary gate, of
 *      which 16 are a shape this file recognises, and every one of those 16
 *      then dies at a LATER gate — 14 on `subject-not-a-param`, 2 on
 *      `args-not-derivable`. So it writes **0 candidates on this corpus** and
 *      the census is unmoved. It is kept because it is correct and exercised
 *      rather than because it paid: the fixture supplies the row the corpus
 *      does not, and that row goes through `propose.mjs` and `validate.mjs`
 *      for real and comes back with 0 errors and 0 warnings. A rule that can
 *      author a claim and has never authored one is exactly the rule that
 *      fires for the first time on somebody else's repo.
 *      `census.learnedBoundaries` is the counter that says the day it does.
 *
 *   the module gate — the gap plan 10 does not have at all, and the reason
 *      correct candidates still return nothing. See `blockedEgressModules`.
 *      Learned from qode-ptp-ms's recording it names 4 modules and refuses 24
 *      sides that were going nowhere anyway; **0 of the 19 candidates this
 *      file writes for that repo live in one of them**, so it buys nothing on
 *      the round that is on disk. What it buys is the round after a frontdoor
 *      round records.
 *
 *   the address gate — the only one of the four that moved the census, and it
 *      moved it by 4. See `instanceAddress` for what it recognises and
 *      `census.instanceAddressed` for the counter that says when it fires.
 *
 * NOTHING ABOVE IS A LEVER ON RUN TIME and none of it is offered as one. The
 * census is 26 candidates, 0.27% of 9,617 instrumented open sides, 0 on
 * location-ms — which is where it was, plus four.
 *
 * END TO END, on qode-ptp-ms's own work list and its own source: 17 candidates,
 * 17 landed through `propose.mjs`, `validate.mjs` exited 0 with 0 errors, 0
 * warnings and 0 advisories, and `record.mjs` recorded 8 of them with 8 claims
 * verified and 0 FALSE at record time. Of the 9 that did not record, 7 were
 * refused by the egress guard — importing the module opens a Redis connection,
 * which is not a boundary of the FUNCTION and so is not a thing this file's
 * gate can see — and 2 were harness failures. None of them was a wrong claim,
 * which is the one failure mode that would make this file not worth having.
 *
 * WHAT IS STILL A JUDGEMENT AND NOT A PROOF, said plainly because the whole
 * point of this file is that its output is trusted without review. For the two
 * families whose arm is IN the body, the candidate assumes the call reaches
 * that arm. The check for that is structural — the arm must be the earliest
 * instrumented arm of its function, so no branch can divert the call before it
 * — and it is not a guarantee: a statement with no arm of its own (a
 * `JSON.parse`, a destructuring of a value that is not there) can still throw
 * on the way. That residual is why the two body families are gated on a
 * function with no boundary LEFT UNANSWERED, where there is nothing to throw
 * but the function's own arithmetic, and it is why the deliverable of this
 * file is a measured survival rate and not a count of candidates. Until the
 * boundary gate above, "unanswered" and "none at all" were the same sentence;
 * they are now two, and the difference is exactly the 23 sides a recording
 * freed and the 0 candidates they produced.
 *
 * HOW A CANDIDATE REACHES DISK, and why it is not written where proposals live.
 * It is SUBMITTED, into `charpilot-answers/`, in the proposal document shape —
 * the same door the answering turn writes through since the submission
 * mechanism landed. `steps/derive.mjs`'s `inspectSubmissions` picks it up,
 * `materialise` spawns `propose.mjs` for it, and `validate.mjs` judges the
 * result at the round boundary. Writing into `proposals/` directly would skip
 * every one of those, and a rule's output is exactly the output that must not
 * be exempt from the check: if a candidate does not validate, that is a defect
 * in the rule, and the pipeline has to report it as one.
 *
 * IT IS NOT WIRED INTO THE WALK, and that is a decision with a number behind
 * it. `steps/derive.mjs`'s `run()` would take it in one line, immediately after
 * `const labelsByArm = labelIndex(worklist);` and before `materialise` — the
 * same pass then lands what this wrote, with no second mechanism:
 *
 *     writeSubmissions(frontDoor({ worklist, scan: JSON.parse(readFileSync(paths.scanJson, "utf8")) }).rows, paths.answersDir);
 *
 * What stops it is the measurement above: 0.27% of instrumented open sides, and
 * 0 of them on location-ms, which is the repo every timing in this pipeline is
 * quoted against. A round that spawns this for no candidate is a cost with no
 * return, and wiring it before either gate above is opened would be measuring
 * the wiring rather than the idea. Open `no-own-entry` or `boundary-unanswered`
 * first; the line is here for the round after that.
 *
 * AND EVERY ROW SAYS A RULE WROTE IT. `authoredBy` is the field
 * `worklist.mjs --skeleton` already stamps on the document it hands the agent
 * ("agent"), no tool reads it, and `validate.mjs` neither requires nor refuses
 * it. So the same word carries the same meaning here, on the document AND on
 * every row — a row is read alone far more often than its document is, and
 * stage 6's false-claim accounting is a list of row ids. The row's `id` also
 * carries the `fd-` prefix, so a rule's claim is separable in every artifact
 * downstream that only ever kept the id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { BEHAVIOUR_JSON, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
import { paramName } from "./novalues.mjs";
// The directory the answering turn writes into, taken from the step that owns
// the name rather than rebuilt here. Two spellings of one path is how a writer
// and a reader come to disagree about where the answers are.
import { answersDir } from "./steps/handover.mjs";

/** The word this file signs its work with, on the document and on every row. */
export const AUTHORED_BY = "rule:frontdoor";

/**
 * On the front of every id it writes.
 *
 * Stage 6 reports a false claim as `{ id, armId }` and nothing else, so a
 * prefix is the only marking that survives into the accounting without a new
 * field in four artifacts. `authoredBy` is the field a reader of the ROW sees;
 * this is the one a reader of a LIST of ids sees.
 */
export const ID_PREFIX = "fd-";

/** A plain identifier — never a destructuring pattern, never a truncation. */
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** `snippet()` in scan.mjs caps at 160 characters and marks the cut with this. */
const TRUNCATED = "…";

/* ---------------------------------------------------------------------------
 * READING WHAT THE SCAN ALREADY WROTE DOWN
 * ------------------------------------------------------------------------ */

/**
 * The literal on one side of a comparison, or null when it is not one.
 *
 * Deliberately narrow. A literal this does not recognise is a refusal, and a
 * refusal costs one side; a literal it recognises WRONGLY is a value in a
 * committed test that nobody derived. Single-quoted strings are accepted only
 * when they carry no backslash, because unescaping them correctly is a second
 * implementation of a language rule and this file is not the place for one.
 */
export function literalOf(text) {
  const t = String(text ?? "").trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
    try {
      return { type: "string", value: JSON.parse(t) };
    } catch {
      return null;
    }
  }
  if (/^'[^'\\]*'$/.test(t)) return { type: "string", value: t.slice(1, -1) };
  if (/^-?(?:\d+|\d*\.\d+)$/.test(t)) return { type: "number", value: Number(t) };
  if (t === "true" || t === "false") return { type: "boolean", value: t === "true" };
  if (t === "null") return { type: "null", value: null };
  // `undefined` is NOT here, and that is a decision rather than an omission.
  // It has no JSON form, so it would have to be a `build`; and on an OPTIONAL
  // parameter "supplied as undefined" and "not supplied at all" are two
  // different inputs that a `build: "undefined"` cannot tell apart — which is
  // exactly the distinction the default-arg family turns on.
  return null;
}

/** The comparison an `if` or a `?:` turns on, or null. */
export function comparisonOf(condition) {
  const m = /^([A-Za-z_$][\w$]*)\s*(===|!==|>=|<=|>|<)\s*(.+?)\s*$/.exec(String(condition ?? "").trim());
  if (!m) return null;
  const literal = literalOf(m[3]);
  if (!literal) return null;
  return { name: m[1], op: m[2], literal };
}

/**
 * The condition text of an `if` or a `cond-expr` arm, or null.
 *
 * ANCHORED, and it has to be: the arm's `text` is a one-line excerpt of the
 * whole statement, so a condition read out of the middle of it would be a
 * parse this file is not doing. `if (…)` must close its parenthesis
 * immediately after the condition, and a `?:` must have its `?` immediately
 * after it — so a compound condition (`a === 1 && b`) does not match, which is
 * the correct answer for it.
 */
export function conditionOf(item) {
  const text = String(item?.source ?? item?.text ?? "").trim();
  if (item?.kind === "if") {
    const m = /^if\s*\(([^()]*)\)/.exec(text);
    return m ? m[1].trim() : null;
  }
  if (item?.kind === "cond-expr") {
    const m = /^([^?:()]*?)\s*\?/.exec(text);
    return m ? m[1].trim() : null;
  }
  return null;
}

/**
 * The `??` / `||` an arm is, with its left operand, or null.
 *
 * `&&` is not here. Its two locations are the same shape, but the RIGHT
 * operand of an `&&` is a statement the author wrote for its effect — the
 * `retryRawLocations.forEach(…)` in googleMap.service.ts:131 is one — and
 * "make the left truthy" then runs it. That is a behaviour the rule has not
 * read, so it is the agent's.
 */
export function nullishOf(item) {
  const text = String(item?.source ?? item?.text ?? "").trim();
  const m = /^([A-Za-z_$][\w$]*)\s*(\?\?|\|\|)\s/.exec(text);
  if (!m) return null;
  return { name: m[1], op: m[2] };
}

/** `expandViewport falls back to its default` -> `expandViewport`. */
export function defaultedParam(side) {
  const m = /^(.*?)\s+falls back to its default\s*$/.exec(String(side ?? ""));
  return m ? m[1].trim() : null;
}

/* ---------------------------------------------------------------------------
 * WHAT A RECORDED ROUND ALREADY PROVED
 *
 * Everything in this section reads `behaviour.json` — stage 4's own output —
 * and nothing in it reads source. That distinction is the whole licence for
 * the two rules below. A rule that inferred "this collaborator is not called"
 * from the shape of the body would be reading behaviour, which is the one
 * thing this file does not do; a rule that reads it off a row the RECORDER
 * ran is quoting an observation. The observation is still not a proof for a
 * different input, and the two functions say where that residual lives.
 *
 * Both are optional. With no `behaviour.json` on disk the maps are empty, the
 * gates below behave exactly as they did before, and the census reproduces its
 * 19,931 / 9,617 / 888 / 26 baseline unchanged. That is checked by a test.
 * ------------------------------------------------------------------------ */

/**
 * Per function, the boundary symbols a recorded row actually called.
 *
 * `boundaryCalls[].symbol` is a path — `createClient.on` — and the ROOT is the
 * declared boundary, so the root is what is indexed. Indexing the full path
 * would report `createClient` as uncalled on a row that called
 * `createClient.on`, which is the wrong direction for a refusal list: it would
 * free a boundary the recorder had just proven live.
 *
 * Only `source: "recorded"` rows that actually `invoked` the subject count. A
 * row that never reached the function proves nothing about what the function
 * calls, and counting it would turn "we never ran it" into "it is inert" —
 * which is the exact failure this whole family has to avoid.
 */
export function inertBoundaries(behaviour, evidence = null) {
  const called = new Map();
  const observed = new Map();
  for (const r of behaviour?.rows ?? []) {
    if (r?.source !== "recorded" || !r.invoked) continue;
    const fn = r.functionId;
    if (!fn) continue;
    observed.set(fn, (observed.get(fn) ?? 0) + 1);
    if (!called.has(fn)) called.set(fn, new Set());
    for (const c of r.boundaryCalls ?? []) called.get(fn).add(String(c?.symbol ?? "").split(".")[0]);
  }
  return { called, observed, evidence };
}

/**
 * The modules a recorded round refused to record, because importing one opens
 * a connection the egress guard denies.
 *
 * THIS IS THE GAP NO PER-FUNCTION BOUNDARY LIST CAN SEE, and it is the largest
 * single reason a correct candidate still returns nothing. On qode-ptp-ms's
 * end-to-end run 17 candidates validated, 8 recorded, and 7 of the 9 that did
 * not were refused with `blocked egress: net.createConnection
 * redis-ptp-caching.staging`. That connection is opened by the MODULE at import
 * time. It is not a boundary of the function, `collectBoundaries` never sees
 * it, and so every boundary idea in plan 10 — all of which are per-function —
 * is blind to it by construction.
 *
 * WHAT THIS IS AND IS NOT. It is a blacklist learned from one recording round:
 * a module that already cost a round a refusal does not get another candidate
 * submitted into it. It is NOT a detector — it cannot say a module opens Redis
 * until a recording has failed in that module once, so the first round in a
 * fresh module still pays the refusal. That is the cheap version plan 16 asked
 * for and it is the only version available from data on disk.
 *
 * MEASURED, and the number is the reason this is reported rather than sold.
 * Learned from qode-ptp-ms's `behaviour.json` as it sits on disk (an agent
 * round, `recordedAt` 2026-09-18T07:26:03Z, 21 skipped rows all naming the same
 * Redis endpoint) it names 4 modules, and **0 of the 19 candidates this file
 * writes for that repo live in any of them**. The blacklist and the candidates
 * are simply in different files. So it buys nothing today and it is still
 * worth its forty lines, because the round it pays for is the SECOND one: once
 * a frontdoor round has recorded and 7 rows have come back blocked, those 7
 * modules are named here and the next census refuses them before propose.mjs,
 * validate.mjs and record.mjs are each spawned for a row that cannot record.
 *
 * WHAT IT DOES NOT GENERALISE TO, said because the limit is the interesting
 * part. It names the module of the refused ROW, not the module that opens the
 * connection. A sibling module that imports the same offending dependency is
 * invisible to it. Following imports to the actual offender is a source
 * analysis this file does not do, and `record.mjs`'s reason string names the
 * ENDPOINT (`redis-ptp-caching.staging`) rather than the module that reached
 * it, so nothing on disk closes that gap either.
 *
 * HOW THE MODULE IS RECOVERED, and why the obvious version was wrong. A
 * `skipped[]` row carries `{ id, file, reason }` — `file` is the answer packet
 * it arrived in — and no `functionId`, so the module has to come off the id,
 * which is `<function>-<line>-<kind>-<side index>` in the skeleton's shape.
 *
 * The first cut matched the leading identifier against the scan's function
 * names and blacklisted every file a name appeared in, on the reasoning that
 * over-refusing is the cheap direction. It is not, and the corpus said so
 * immediately: notification-ms has exactly ONE blocked row,
 * `sendMessage-77-binary-expr-0`, and `sendMessage` is the name of a function
 * in five different modules — so one refused row blacklisted five modules,
 * four of them on no evidence at all. Over-refusing costs candidates and buys
 * nothing; under-refusing costs one wasted recording attempt and cannot make a
 * claim wrong. So the LINE in the id is used to narrow the name to the one
 * function whose body contains it, and a name that still resolves to more than
 * one module is dropped rather than guessed. On qode-ptp-ms every one of the
 * 21 blocked rows resolves to exactly one module (4 modules in total), so the
 * narrowing costs that repo nothing.
 */
export function blockedEgressModules(behaviour, scan) {
  const byName = new Map();
  for (const f of scan?.functions ?? []) {
    const short = String(f?.name ?? "").split(".").pop();
    if (!short || !f.file) continue;
    if (!byName.has(short)) byName.set(short, []);
    byName.get(short).push(f);
  }
  const modules = new Map();
  for (const s of behaviour?.skipped ?? []) {
    if (!/^blocked egress/.test(String(s?.reason ?? ""))) continue;
    let files = [];
    // `functionId` is not written on a skipped row today. It is read first
    // anyway, so that the day it is this stops reading the id at all.
    if (s.functionId) files = [String(s.functionId).split(":")[0]];
    else {
      const m = /^([A-Za-z_$][\w$]*)(?:-(\d+))?/.exec(String(s.id ?? ""));
      let candidates = (m && byName.get(m[1])) ?? [];
      const line = m?.[2] ? Number(m[2]) : null;
      if (line !== null && candidates.length > 1) {
        const inRange = candidates.filter((f) => f.line <= line && line <= (f.endLine ?? f.line));
        if (inRange.length) candidates = inRange;
      }
      files = [...new Set(candidates.map((f) => f.file))];
    }
    // A row whose module cannot be named to one file teaches nothing, and is
    // dropped rather than spread across every candidate.
    if (files.length !== 1) continue;
    if (!modules.has(files[0])) modules.set(files[0], String(s.reason).replace(/\s+/g, " ").slice(0, 150));
  }
  return modules;
}

/* ---------------------------------------------------------------------------
 * THE GATES EVERY CANDIDATE PASSES BEFORE ITS FAMILY IS EVEN ASKED
 * ------------------------------------------------------------------------ */

/** A refusal: a code the census counts by, and the sentence a reader needs. */
const no = (code, why) => ({ code, why });

/** `export cacheService` — an exported module-scope binding, and nothing else. */
const EXPORTED_BINDING = /^export ([A-Za-z_$][\w$]*)$/;

/**
 * THE ADDRESS OF A METHOD ON AN EXPORTED INSTANCE, or null.
 *
 * WHAT THIS CORRECTS. `no-own-entry` refused this shape with the sentence
 * "`args` are positioned against the DRIVER, so steering the arm means
 * choosing the caller's arguments". That is true of a driver that is a
 * FUNCTION and false of a driver that is a BINDING, and `validate.mjs` says so
 * in its own code: `driverFn` is `fnIndex.get(p.via)`, an exported binding is
 * not in that index, so `signature` falls back to the arm's OWN function and
 * only the minimum-arity check is skipped ("a `via` that names something other
 * than a function — an exported singleton, say — means the call shape is not
 * this signature's"). So for this one shape there is no caller to read: the
 * arguments are the method's own, and the only thing the row was missing is
 * the receiver's NAME.
 *
 * AND THE NAME IS ALREADY A FIELD. `via` carries it, `validate.mjs` checks it
 * against `scan.functions[].via.drivers` rather than trusting it, and
 * `record.mjs` resolves it as `entry.kind: "exported-binding"` and emits
 * `binding[member].bind(binding)`. Measured on the proposals on disk: 71 rows
 * across four repos already declare `via: "export <binding>"` and 70 of them
 * are in a `behaviour.json` — this is the pipeline's ordinary path, not a new
 * one. Nothing outside this file had to change.
 *
 * WHAT IT IS WORTH, measured before it was written, over the same six work
 * lists: 96 of the 486 `no-own-entry` refusals are this shape. 90 of those 96
 * have a boundary to answer, 1 more has no plain parameter to turn and 1 more
 * cannot have its call built — so **4 become candidates**, and the census goes
 * 22 -> 26. The 96 is not the yield and was never going to be; it is the size
 * of the bucket. The 4 is the yield.
 *
 * WHAT IS REFUSED, and each one because the recipe cannot address it:
 *
 *   - anything but a `through-class-holder` resolution at `certain`
 *     confidence, with exactly ONE driver. An ambiguous receiver is a reading.
 *   - a driver that is not `export <ident>`. `record.mjs` matches the same
 *     expression; a spelling it does not match resolves to no subject at all.
 *   - an entry that is not a plain instance method: a `static` is not on the
 *     instance, a `constructor` is not a call on it, a `private` member is not
 *     on its public surface (and the emitted spec is TypeScript, where
 *     reaching one through the binding does not compile), and a `nested`
 *     callback is invoked by a library rather than by the binding —
 *     `record.mjs` refuses that last one by name.
 *
 * `via` on the scan's FUNCTION is the authority, and `item.via` is read first
 * only because the work list may carry the same record.
 */
export function instanceAddress(item, via = null) {
  const entry = item?.owner?.entry ?? {};
  if (entry.reachable) return null;
  if (entry.kind !== "class-method") return null;
  if (entry.static === true || entry.private === true) return null;
  if (!entry.module || typeof entry.module !== "string") return null;
  const member = entry.member ?? String(item?.owner?.name ?? "").split(".").pop();
  if (!member || !IDENT.test(member) || member === "constructor") return null;
  const v = item?.via ?? via;
  if (!v || v.kind !== "through-class-holder" || v.confidence !== "certain") return null;
  const drivers = v.driver ? [v.driver] : (v.drivers ?? []);
  if (drivers.length !== 1) return null;
  return EXPORTED_BINDING.test(String(drivers[0])) ? String(drivers[0]) : null;
}

/** Whether the arm's own text names this symbol. Word-boundary, not substring. */
function armMentions(text, symbol) {
  const root = String(symbol ?? "").split(".")[0];
  if (!root) return false;
  return new RegExp(`\\b${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(String(text ?? ""));
}

/**
 * The boundary answers a RECORDING already justifies, or the ones still owed.
 *
 * THE ONE SHAPE ALLOWED HERE IS `notCalled`, and only for a symbol that two
 * separate facts agree is beside the point:
 *
 *   - the arm's own text does not mention it, so the side this row claims does
 *     not turn on what the collaborator does; and
 *   - every recorded row of this function ran without calling it, so the
 *     recorder — not a reading of the source — is what says it is inert.
 *
 * ALL OR NOTHING. A function with one boundary this cannot answer stays
 * refused with all of them, because a row that answers three of four
 * boundaries is a row `validate.mjs` warns on and `record.mjs` runs against a
 * live collaborator.
 *
 * WHERE THE RESIDUAL IS. A recorded row ran with ITS arguments; this candidate
 * runs with different ones, and a branch this input takes could reach a call
 * the recorded input did not. The containment is `record.mjs`'s and it is
 * real but partial: a `notCalled` mock is never delegated, so a broken claim
 * cannot reach a host — the call is logged with `declaredNotCalled` and stage 6
 * reports the contradiction. What it does not contain is the arm: the
 * collaborator answers `undefined`, the function may take a different branch,
 * and the row's claim about its side can come back FALSE at record time. That
 * is a caught failure rather than a shipped one, and it is the reason this is
 * gated on the arm's own text as well as on the recording.
 */
export function boundaryAnswers(item, learned = null) {
  const demanded = (item?.boundaries ?? []).filter((b) => b && !b.advisory && !b.typeOnly);
  if (!demanded.length) return { answers: {} };
  const fn = item?.owner?.functionId;
  const rows = learned?.observed?.get(fn) ?? 0;
  if (!rows) return { unanswered: demanded, rows: 0 };
  const called = learned.called.get(fn) ?? new Set();
  const armText = String(item?.source ?? item?.text ?? "");
  const answers = {};
  const unanswered = [];
  for (const b of demanded) {
    if (called.has(String(b.symbol).split(".")[0]) || armMentions(armText, b.symbol)) {
      unanswered.push(b);
      continue;
    }
    answers[b.symbol] = {
      behaviour: `not called on this path. The recorder ran this function ${rows} time(s) and \`${b.symbol}\` (${b.module}) appears in no row's call list, and the arm this row claims does not mention it.`,
      mock: { kind: "notCalled" },
      rows,
    };
  }
  if (unanswered.length) return { unanswered, rows };
  return { answers, rows };
}

/**
 * Why this side cannot be answered by a rule at all, or null.
 *
 * Asked in cost order — the cheapest fact first — so the census reports the
 * FIRST reason a side is out, which is the one worth fixing.
 *
 * `module-blocked-egress` is asked LAST, after every other gate, and the order
 * is deliberate rather than incidental. Asked first it would be the cheapest
 * fact of all and would relabel every side in a blocked module, which destroys
 * the comparison with the 19,931 / 9,617 / 888 / 26 baseline this file is
 * measured against. Asked last it can only fire on a side that was about to
 * become a candidate, which is the only place it does any work anyway.
 */
export function blockedBy(item, learned = null, blockedModules = null, via = null) {
  if (!item?.instrumented) {
    return no(
      "not-instrumented",
      "istanbul has no counter for this side, so no claim about it can be verified — the work list does not ask about it either"
    );
  }
  const entry = item.owner?.entry ?? {};
  // THE ONE SHAPE WHOSE ARGUMENTS ARE ITS OWN. See `instanceAddress`: a driver
  // that is an exported BINDING is not a caller whose arguments have to be
  // chosen, it is a receiver whose name has to be written down, and `via`
  // already carries that name through validate and record.
  if (!entry.reachable && !instanceAddress(item, via)) {
    return no(
      "no-own-entry",
      "the arm is reached through a caller, so `args` are positioned against the driver and steering it means choosing the caller's arguments — a reading of the caller this file has not done"
    );
  }
  if ((entry.ctorParams ?? []).length) {
    return no(
      "entry-needs-building",
      `the subject is a method of a class whose constructor takes ${entry.ctorParams.length} argument(s), and the rule would have to invent them`
    );
  }
  const boundaries = boundaryAnswers(item, learned);
  if (boundaries.unanswered) {
    const demanded = boundaries.unanswered;
    const learnt = boundaries.rows
      ? ` the recorder has ${boundaries.rows} row(s) of this function and they do not clear ${demanded.length === 1 ? "it" : "these"}, and`
      : "";
    return no(
      "boundary-unanswered",
      `${demanded.length} boundary answer(s) are demanded of this function (${demanded.slice(0, 3).map((b) => b.symbol).join(", ")}${demanded.length > 3 ? ", …" : ""}):${learnt} a \`behaviour\` plus a \`mock\` is a statement about what a collaborator does`
    );
  }
  const blockedWhy = blockedModules?.get?.(item.file);
  if (blockedWhy) {
    return no(
      "module-blocked-egress",
      `a recorded round already refused a row in \`${item.file}\` — "${blockedWhy}" — so importing this module opens a connection the egress guard denies. That is a property of the MODULE and not of the function, so no boundary answer can clear it and a candidate here would spend propose, validate and record to arrive at the same refusal`
    );
  }
  return null;
}

/**
 * The family this side belongs to, whether or not a rule can answer it.
 *
 * Kept apart from the answering so the census can say how much work each
 * family holds — which is the number that decides what the NEXT rule should
 * be, and it is not the same number as how much this file answers today.
 */
export function familyOf(item, side) {
  if (item?.kind === "default-arg") return defaultedParam(side) ? "default-arg" : null;
  if (item?.kind === "binary-expr") return nullishOf(item) ? "nullish" : null;
  if (item?.kind === "if" || item?.kind === "cond-expr") return comparisonOf(conditionOf(item)) ? "comparison" : null;
  return null;
}

/* ---------------------------------------------------------------------------
 * BUILDING THE CALL
 * ------------------------------------------------------------------------ */

/**
 * The `args` array for a call that supplies SOME parameters and omits the rest,
 * or the reason there is no such call.
 *
 * `supply` is `Map<index, { value } | { build }>`. Two rules, and both are
 * `validate.mjs`'s rather than this file's:
 *
 *   - `args` is POSITIONAL, so supplying parameter k means supplying every
 *     parameter before it. One this rule did not derive is a value it would be
 *     inventing, so it refuses instead.
 *   - the array may be SHORTER than the signature only while every parameter
 *     past its end is optional — `validate.mjs:1096` counts the non-optional
 *     ones and refuses a call that cannot be made. `derive.mjs`'s `argSlots`
 *     already truncates a default-arg row on exactly this rule.
 */
export function callArgs(params, supply) {
  const last = supply.size ? Math.max(...supply.keys()) : -1;
  for (let i = 0; i < last; i += 1) {
    if (supply.has(i)) continue;
    return {
      refusal: no(
        "args-not-derivable",
        `parameter ${i} (${paramName(params[i]?.name ?? `#${i}`)}) sits before the one this arm turns on and nothing in the arm says what to pass for it — \`args\` is positional, so the call cannot be made without inventing a value`
      ),
    };
  }
  for (let i = last + 1; i < params.length; i += 1) {
    const p = params[i];
    if (p?.optional || p?.rest) continue;
    return {
      refusal: no(
        "args-not-derivable",
        `parameter ${i} (${paramName(p?.name ?? `#${i}`)}) is required and this call does not reach it — it supplies ${last + 1} argument(s), and validate.mjs:1096 refuses a call shorter than the signature needs`
      ),
    };
  }
  return { args: Array.from({ length: last + 1 }, (_, i) => supply.get(i)) };
}

/** The index of a parameter by name, or -1. A destructured pattern is not one. */
export function paramIndex(params, name) {
  return (params ?? []).findIndex((p) => IDENT.test(String(p?.name ?? "")) && p.name === name);
}

/**
 * A value of the declared type that is not `null` and not `undefined`, or null.
 *
 * Only the three primitives, read off the DECLARED type text. An object type
 * gets no value here: `{}` would satisfy `??` and would also be a shape the
 * function then reads fields off, and what it does with them is behaviour.
 */
export function presentValue(type) {
  const t = String(type ?? "");
  if (/\bstring\b/.test(t)) return { value: "x" };
  if (/\bnumber\b/.test(t)) return { value: 1 };
  if (/\bboolean\b/.test(t)) return { value: true };
  return null;
}

/**
 * A value that fails `op` against `literal`, and one that satisfies it.
 *
 * `===` and `!==` are one rule read in two directions. The relational four are
 * arithmetic on a NUMBER literal only: `s > "b"` is a lexicographic comparison
 * whose negation depends on a collation this file is not modelling.
 */
export function comparisonValues({ op, literal, type }) {
  const lit = literal.value;
  if (op === "===" || op === "!==") {
    let other;
    if (literal.type === "string") other = `${lit}-not`;
    else if (literal.type === "number") other = lit + 1;
    else if (literal.type === "boolean") other = !lit;
    else {
      // `x === null`. The satisfying value is `null`; the failing one has to be
      // a value of the parameter's own type, and there is one only for a
      // declared primitive.
      const present = presentValue(type);
      if (!present) {
        return {
          refusal: no(
            "type-not-supported",
            `the arm compares against \`null\` and the parameter is declared \`${String(type ?? "(no type)")}\`, so the value that FAILS the comparison would be one this rule invented rather than read`
          ),
        };
      }
      other = present.value;
    }
    const equal = op === "===";
    return { satisfies: equal ? lit : other, fails: equal ? other : lit };
  }
  if (literal.type !== "number") {
    return {
      refusal: no(
        "literal-not-supported",
        `\`${op}\` against a ${literal.type} literal is a comparison whose negation depends on an ordering this rule does not model — only a numeric bound is arithmetic`
      ),
    };
  }
  const n = literal.value;
  if (op === ">") return { satisfies: n + 1, fails: n };
  if (op === ">=") return { satisfies: n, fails: n - 1 };
  if (op === "<") return { satisfies: n - 1, fails: n };
  return { satisfies: n, fails: n + 1 };
}

/**
 * Which side of an `if` / `?:` is the one the condition HOLDS on.
 *
 * The labels are istanbul's, and the scan writes them verbatim: `then`/`else`
 * for an `if`, `whenTrue`/`whenFalse` for a conditional expression. A label
 * that is neither is a shape this file has not seen and refuses.
 */
export function holdsOn(side) {
  if (side === "then" || side === "whenTrue") return true;
  if (side === "else" || side === "whenFalse") return false;
  return null;
}

/* ---------------------------------------------------------------------------
 * THE CANDIDATE
 * ------------------------------------------------------------------------ */

/** `src/services/location.service.ts:385:findCountryByIso2` -> a printable stem. */
const slug = (text) =>
  String(text ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "fn";

/**
 * One candidate proposal for one side, or the reason there is none.
 *
 * `firstArm` is the earliest instrumented arm of the owning function, read off
 * the scan. Two of the three families need it: their arm is IN the body, so a
 * branch ahead of it could send the call somewhere else, and the claim would be
 * false through no fault of the value. `default-arg` does not, because the
 * binding it is about happens before the first statement runs.
 *
 * `learned` and `blockedModules` come from `behaviour.json` and are both
 * optional; with neither, this decides exactly what it decided before they
 * existed.
 */
export function candidateFor({ item, side, firstArm = null, learned = null, blockedModules = null, via = null }) {
  const blocked = blockedBy(item, learned, blockedModules, via);
  if (blocked) return { refusal: blocked };
  const address = instanceAddress(item, via);

  const family = familyOf(item, side);
  if (!family) {
    return {
      refusal: no(
        "unrecognised-shape",
        `${/^[aeiou]/i.test(String(item.kind)) ? "an" : "a"} ${item.kind} arm whose input is not written in its own text — deciding it is a reading of the function, which is the agent's work`
      ),
    };
  }

  const params = item.owner?.params ?? [];
  const built = inputFor({ item, side, family, params });
  if (built.refusal) return { refusal: built.refusal, family };

  if (family !== "default-arg" && firstArm && firstArm !== item.armId) {
    return {
      refusal: no(
        "not-first-arm",
        `an earlier branch (${firstArm}) decides whether the call ever reaches this arm, and which way it goes is a reading of the function`
      ),
      family,
    };
  }

  const shaped = callArgs(params, built.supply);
  if (shaped.refusal) return { refusal: shaped.refusal, family };

  const armId = item.armId;
  const from = {
    arm: armId,
    // `file:line` of the arm itself. validate.mjs checks that the file part
    // exists (validate.mjs:591), and the line is the one the reader opens to
    // see the same text this rule read.
    evidence: `${item.file}:${item.line}`,
    reading: built.reading,
  };
  // The skeleton's own id shape, prefixed. The side is named by its INDEX and
  // never by its label: a binary-expr label is an operand's source text, so two
  // labels of one arm can slug to the same string and two rows would collide on
  // an id — which `validate.mjs` refuses as a duplicate and BOTH sides reopen.
  const at = (item.sides ?? item.uncoveredSides ?? []).indexOf(side);
  const row = {
    id: `${ID_PREFIX}${slug(item.owner?.name ?? item.file)}-${item.line}-${item.kind}-${at === -1 ? 0 : at}`,
    functionId: item.owner?.functionId,
    lane: item.lane ?? "unit",
    // THE ROW SAYS WHO WROTE IT, in the field the skeleton already uses for
    // that. A row is read alone far more often than its document is.
    authoredBy: `${AUTHORED_BY}/${family}`,
    covers: [armId],
    reaches: { [armId]: [side] },
    rationale: built.rationale,
    args: shaped.args.map((a) => ({ ...a, from })),
    // EITHER NOTHING IS DEMANDED, OR A RECORDING ANSWERED IT.
    //
    // With no `behaviour.json` this is always `{}` and the sentence that used
    // to be here still holds: `blockedBy` refused every function that has a
    // boundary, so an empty block is the honest statement that this row says
    // nothing about a collaborator. With one, the only answers that can appear
    // are `notCalled` on symbols the recorder ran this function without
    // calling — see `boundaryAnswers` for what that does and does not prove.
    boundaries: boundaryBlock(item, learned, armId),
  };
  // THE RECEIVER, WHEN THE ARM HAS NO OWN ENTRY AND `instanceAddress` FOUND
  // ONE. Written LAST so the field order says what it is — everything above is
  // the claim, this is the address it is made at — and omitted entirely
  // otherwise, because `validate.mjs` refuses a `via` on an arm the scan does
  // not resolve through one ("declares via X but the scan resolves Y").
  if (address) row.via = address;
  return { row, family };
}

/**
 * The `boundaries` block, with every answer citing the RECORDING it came off.
 *
 * `from.evidence` is the behaviour.json path rather than a source line, and
 * that is the point: the claim is "the recorder observed this", so the
 * artifact a reader has to open to check it is the recorder's output.
 * `validate.mjs:594` only verifies that the file part exists, and it does.
 */
function boundaryBlock(item, learned, armId) {
  const { answers } = boundaryAnswers(item, learned);
  const out = {};
  for (const [symbol, a] of Object.entries(answers ?? {})) {
    out[symbol] = {
      behaviour: a.behaviour,
      mock: a.mock,
      from: {
        arm: armId,
        // The path `config.mjs` puts behaviour.json at when the toolset is
        // installed in the repo, which is every case but a direct call from a
        // test. `frontDoor` is given the real relative path by the command.
        evidence: learned?.evidence ?? ".claude/charpilot/out/behaviour.json",
        reading: `\`${symbol}\` is in no call list of the ${a.rows} recorded row(s) stage 4 has for this function, and this arm's own text does not name it — so the answer is read off the recorder's output and not off the body.`,
      },
    };
  }
  return out;
}

/**
 * What to pass, per family: the supplied parameters, and the two sentences that
 * say where the values came from.
 */
function inputFor({ item, side, family, params }) {
  if (family === "default-arg") {
    const want = defaultedParam(side);
    const at = paramIndex(params, want);
    if (at === -1) {
      return {
        refusal: no(
          "subject-not-a-param",
          `the side names \`${want}\`, which is not a plain declared parameter of this function — a destructured or renamed one cannot be omitted positionally`
        ),
      };
    }
    // NOTHING IS SUPPLIED AT ALL — not even the parameters BEFORE this one.
    //
    // The first cut of this required the defaulted parameter to be the first,
    // on the reasoning that `args` is positional. That is the wrong reading of
    // its own rule: omitting parameter 0 as well does not weaken the claim,
    // because the side claimed here is "`<name>` fell back to its default" and
    // a call that supplies nothing takes it just the same. It also takes the
    // default side of every other defaulted parameter, which is over-delivery
    // and not a false claim — this row claims one side and stage 6 credits what
    // istanbul actually counted.
    //
    // So the whole condition is `callArgs`'s: every parameter must be optional,
    // or the call cannot be made at all. It is the correct reading of the
    // constraint and it did not pay: across the six work lists on disk it
    // produced 19 default-arg candidates, 0 of them behind an earlier
    // parameter, because a defaulted parameter that is not first sits behind a
    // REQUIRED one every time on this corpus. Kept because the looser rule is
    // the true one, not because it bought a side.
    return {
      supply: new Map(),
      reading: `the scan records this arm as \`${String(item.source ?? "").slice(0, 80)}\`, whose one side is taken when the argument is not supplied; the call omits it.`,
      rationale: `\`${want}\` has a default and this call does not supply it, so the parameter binding takes the default — the only side this arm has.`,
    };
  }

  if (family === "nullish") {
    const { name, op } = nullishOf(item);
    const at = paramIndex(params, name);
    if (at === -1) {
      return {
        refusal: no(
          "subject-not-a-param",
          `the left operand \`${name}\` is not a declared parameter of this function, so nothing a caller passes decides this arm`
        ),
      };
    }
    const labels = item.sides ?? item.uncoveredSides ?? [];
    if (labels.length !== 2) {
      return {
        refusal: no(
          "label-count",
          `istanbul gives this arm ${labels.length} locations rather than 2, so a chained \`${op}\` — which side is which is not a two-way choice`
        ),
      };
    }
    const right = labels[1] === side;
    if (!right && labels[0] !== side) {
      return { refusal: no("label-count", "the side is neither of the arm's two operands as the scan recorded them") };
    }
    if (right) {
      return {
        supply: new Map([[at, { value: null }]]),
        reading: `the arm is \`${name} ${op} …\` and \`${name}\` is a declared parameter; \`null\` is ${op === "??" ? "nullish" : "falsy"}, so evaluation does not stop at the left operand.`,
        rationale: `\`${name}\` is passed as \`null\`, so \`${op}\` evaluates its right operand — the side this row claims.`,
      };
    }
    const present = presentValue(params[at]?.type);
    if (!present) {
      return {
        refusal: no(
          "type-not-supported",
          `the left operand's declared type is \`${String(params[at]?.type ?? "(no type)")}\`, and a value of it that is neither null nor falsy would be one this rule invented rather than read`
        ),
      };
    }
    return {
      supply: new Map([[at, present]]),
      reading: `the arm is \`${name} ${op} …\` and \`${name}\` is a declared parameter of type \`${params[at]?.type}\`; a value of that type that is neither null nor falsy stops the evaluation at the left operand.`,
      rationale: `\`${name}\` is passed a present value, so \`${op}\` evaluates the left operand and stops — the side this row claims.`,
    };
  }

  const condition = conditionOf(item);
  const cmp = comparisonOf(condition);
  const at = paramIndex(params, cmp.name);
  if (at === -1) {
    return {
      refusal: no(
        "subject-not-a-param",
        `the condition turns on \`${cmp.name}\`, which is not a declared parameter of this function, so nothing a caller passes decides this arm`
      ),
    };
  }
  const holds = holdsOn(side);
  if (holds === null) {
    return {
      refusal: no(
        "label-count",
        `\`${side}\` is not one of the two labels istanbul gives a condition, so which way this side runs is not decidable from the scan`
      ),
    };
  }
  const values = comparisonValues({ op: cmp.op, literal: cmp.literal, type: params[at]?.type });
  if (values.refusal) return { refusal: values.refusal };
  const value = holds ? values.satisfies : values.fails;
  return {
    supply: new Map([[at, { value }]]),
    reading: `the arm's condition is \`${condition}\`; \`${cmp.name}\` is a declared parameter and the other operand is a literal the scan carries, so the value is read off the comparison and not off the function's behaviour.`,
    rationale: `\`${cmp.name}\` is passed a value that ${holds ? "satisfies" : "fails"} \`${condition}\`, so the arm takes \`${side}\`.`,
  };
}

/* ---------------------------------------------------------------------------
 * THE WHOLE WORK LIST
 * ------------------------------------------------------------------------ */

/** The earliest instrumented arm of each function, by function id. */
export function firstArms(scan) {
  const out = new Map();
  for (const fn of scan?.functions ?? []) {
    let best = null;
    for (const a of fn.arms?.list ?? []) {
      if (a.istanbul === false) continue;
      if (!best || a.line < best.line || (a.line === best.line && (a.column ?? 0) < (best.column ?? 0))) best = a;
    }
    if (best) out.set(fn.id, best.armId);
  }
  return out;
}

/**
 * Every open side, classified, with a candidate where a rule can write one.
 *
 * `worklist.items[].uncoveredSides` is the open list, exactly as `openSides`
 * reads it. A side already proposed for is NOT excluded here: this file does
 * not read `proposals/`, and `derive`'s `inspectSubmissions` will not
 * materialise a row whose id is already landed — so a second pass over the same
 * work list is idempotent without this file having an opinion about it.
 *
 * `behaviour` is stage 4's own output and is OPTIONAL. Passed, it can free a
 * boundary the recorder proved inert and it can refuse a module the recorder
 * proved unrecordable; omitted, every gate decides exactly what it decided
 * before either rule existed, which is the 19,931 / 9,617 / 888 / 26 baseline.
 */
export function frontDoor({ worklist, scan, behaviour = null, evidence = null }) {
  const learned = behaviour ? inertBoundaries(behaviour, evidence) : null;
  const blockedModules = behaviour ? blockedEgressModules(behaviour, scan) : null;
  const first = firstArms(scan);
  const rows = [];
  const refusals = [];
  const census = {
    sides: 0,
    candidates: 0,
    byFamily: new Map(),
    byRefusal: new Map(),
    byKind: new Map(),
    // WHAT STOPS THE SIDES THIS FILE ALREADY RECOGNISES, which is a different
    // question from what stops all of them and the only one that says what to
    // build next. A family with 400 sides behind one gate is a gate worth
    // opening; a family with 400 sides behind eight is a family to leave alone.
    familyRefusal: new Map(),
    // WHAT THE RECORDING CHANGED, so the delta from the baseline census is a
    // number and not an impression. Both stay 0 with no `behaviour.json`.
    learnedBoundaries: 0,
    blockedModules: blockedModules?.size ?? 0,
    // HOW MANY CANDIDATES ARE ADDRESSED AT AN EXPORTED INSTANCE rather than
    // imported by name. The same kind of counter as `learnedBoundaries`: a
    // gate that is correct and fires on nobody's repo is indistinguishable
    // from one that is broken, unless something counts it.
    instanceAddressed: 0,
  };
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  // `via` lives on the scan's FUNCTION, and the work list does not always copy
  // it onto the item. Indexed once here rather than searched per side.
  const viaByFunction = new Map((scan?.functions ?? []).map((f) => [f.id, f.via ?? null]));

  for (const item of worklist?.items ?? []) {
    for (const side of item.uncoveredSides ?? []) {
      census.sides += 1;
      bump(census.byKind, item.kind ?? "(no kind)");
      // ASKED OF THE ARM, not of the candidate, and the difference is the whole
      // census. `candidateFor` answers "no family" for a side it refused one
      // gate earlier — a function with a boundary to answer never gets that
      // far — so counting the family off the candidate would report the shapes
      // this file ANSWERS and call it the shapes that EXIST. The second number
      // is the one that says what the next rule should be.
      const family = familyOf(item, side);
      bump(census.byFamily, family ?? "(no family rule)");
      const out = candidateFor({
        item,
        side,
        firstArm: first.get(item.owner?.functionId) ?? null,
        learned,
        blockedModules,
        via: viaByFunction.get(item.owner?.functionId) ?? null,
      });
      if (out.row) {
        census.candidates += 1;
        census.learnedBoundaries += Object.keys(out.row.boundaries ?? {}).length;
        if (out.row.via) census.instanceAddressed += 1;
        rows.push(out.row);
        continue;
      }
      bump(census.byRefusal, out.refusal.code);
      if (family) bump(census.familyRefusal, `${family} · ${out.refusal.code}`);
      refusals.push({ armId: item.armId, side, kind: item.kind, family: family ?? null, ...out.refusal });
    }
  }

  // TWO ROWS, ONE ID: BOTH GO, AND NEITHER IS RENAMED.
  //
  // The id is `<name>-<line>-<kind>-<side index>`, the skeleton's own shape, and
  // it carries no file — so two functions of the same name at the same line in
  // two different files collide. `validate.mjs:801` keeps `seen` ids across the
  // whole proposals directory and refuses BOTH as `duplicate id`, which reopens
  // both sides after `propose.mjs` has already written them. Renaming one here
  // would be this file inventing an address the rest of the pipeline did not
  // hand it, so the pair is dropped and counted: two sides unanswered, which is
  // the cheap direction. Measured on the six work lists on disk: 0 collisions.
  const byId = new Map();
  for (const row of rows) byId.set(row.id, (byId.get(row.id) ?? 0) + 1);
  const kept = rows.filter((r) => byId.get(r.id) === 1);
  for (const r of rows) {
    if (byId.get(r.id) === 1) continue;
    census.candidates -= 1;
    bump(census.byRefusal, "id-collision");
    refusals.push({
      armId: r.covers[0],
      side: Object.values(r.reaches)[0]?.[0] ?? null,
      kind: null,
      family: null,
      code: "id-collision",
      why: `another candidate generates the same row id (\`${r.id}\`), and one id in two files is refused as a duplicate by validate.mjs — both are dropped rather than one renamed`,
    });
  }
  return { rows: kept, refusals, census };
}

/* ---------------------------------------------------------------------------
 * THE CALLER GATE, MEASURED BEFORE ANYBODY OPENS IT
 *
 * `no-own-entry` is the largest single refusal of the shapes this file already
 * recognises — 486 of 888 on the six work lists — and plan 16 part 6 records
 * that it "has never been inspected". Everything below exists to inspect it,
 * and it is a MEASUREMENT rather than a step towards a rule: it writes no
 * candidate and `frontDoor` does not call it.
 *
 * THE QUESTION IT ANSWERS. If most of those 486 are reached through a driver
 * that hands its own parameter straight through, the missing fact is one fact
 * — "this parameter reaches that parameter unchanged" — and a rule can have it
 * from the scan plus one line of the driver. If they are not, then steering
 * the arm means reading a transform, a closure or a second frame, which is a
 * reading of the caller and belongs to the agent.
 *
 * THE ANSWER, on the six work lists (interview-service, location-ms,
 * notification-ms, pricing-ms, profile-centralized, qode-ptp-ms):
 *
 *     486  recognised-shape sides refused as `no-own-entry`
 *     153  the DRIVER has a boundary to answer — the boundary gate again, one
 *          frame up, not a caller problem
 *     131  two or more frames (115 at two hops, 12 at three, 1 at four,
 *          3 at six) — `via.kind === "through-chain"`
 *      96  the driver is an exported module-scope binding, not a function
 *      38  the subject is not a plain declared parameter of the arm's function
 *      25  a framework trigger — there is no caller to steer
 *      19  the driver is a method of a class with a constructor
 *      11  several possible drivers, or an ambiguous one
 *      13  reach the call site at all, and of those:
 *      10    FORWARDED VERBATIM
 *       2    the driver references the callee but never calls it
 *       1    the argument is a local, not a driver parameter
 *
 * SO THE FORWARDING CASE IS 10 OF 486 — 2.1% of the caller gate, and 0.10% of
 * the 9,617 instrumented open sides. Building it would move the census from 22
 * candidates to at most 32 before the driver's own positional-argument and
 * reach gates cut into that, against a new correctness assumption on every one
 * of them: that the driver reaches the call unconditionally, which is a
 * reading of the driver this file would not have done. Plan 16 ranks this item
 * "measure, then decide". The measurement says a small minority, so the
 * decision is not to build it, and this function is what would have to be
 * re-run for anybody who wants to overturn that.
 *
 * TWO THINGS WORTH SAYING ABOUT THE BUCKETS THAT ARE NOT THE ANSWER. The
 * biggest, 153, is the boundary gate wearing a different hat: those sides are
 * refused as `no-own-entry` and would be refused as `boundary-unanswered` one
 * frame up, so opening the caller gate for them buys nothing until the
 * boundary gate opens too.
 *
 * THE SECOND, 96, IS NOT A CALLER PROBLEM AND IS NOW BUILT — see
 * `instanceAddress`. Every one is a method of a class the module does not
 * export, reached through an exported binding that holds an instance
 * (`cacheService.getRedisCacheKeys(…)`), so its arguments are its OWN and no
 * caller has to be read. Two things were said about it that turned out not to
 * be true, and both were checked by running the tools rather than reading
 * them:
 *
 *   "every one is a PUBLIC method" — 27 of the 96 are `private`, and 3 of
 *   those are private members of a class that IS exported. A private member
 *   is not on the binding's surface and the emitted spec is TypeScript, so
 *   `instanceAddress` refuses all 27.
 *
 *   "it is a change to how `validate.mjs` and `propose.mjs` position `args`"
 *   — it is neither. `propose.mjs` never positions `args`; it is a writer that
 *   does not judge. And `validate.mjs` already positions them correctly for
 *   this shape: `driverFn` is `fnIndex.get(p.via)`, an exported binding is not
 *   a function in that index, so `signature` stays the arm's OWN function.
 *   `record.mjs` already resolves the same `via` as `entry.kind:
 *   "exported-binding"`. 71 hand-authored rows on disk across four repos
 *   already use it and 70 are in a `behaviour.json`. The whole change was
 *   inside this file: stop refusing the shape, and write the `via` the scan
 *   already resolved.
 *
 * AND THE 96 IS NOT THE YIELD. Measured with the gate in place: 4 candidates.
 * 90 of the 96 have a boundary to answer — including
 * `cacheService.getRedisCacheKeys` itself, the example the finding was written
 * around, which touches `this.redisClient` — 1 turns on something that is not
 * a plain parameter, and 1 cannot have its call built. The census moves
 * 22 -> 26.
 * ------------------------------------------------------------------------ */

/** Split an argument list on TOP-LEVEL commas, respecting nesting and quotes. */
export function splitArgs(source) {
  const text = String(source ?? "");
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\") {
        cur += text[i + 1] ?? "";
        i += 1;
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
      continue;
    }
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Every call to `name` inside `text`, as its split argument list.
 *
 * A BRACKET WALK RATHER THAN A PARSE, and the difference matters for what this
 * is allowed to conclude. It finds `name(` and `.name(` and then counts
 * brackets to the matching close, so a string containing a bracket is handled
 * and a comment containing `name(` is not. That is acceptable for a census —
 * a miscount lands a side in the "several call sites" bucket, which is a
 * refusal — and it is NOT acceptable for writing a candidate, which is one
 * more reason step 2 above is measured rather than built.
 */
export function callSites(text, name) {
  const out = [];
  // Escaped even though every caller checks `IDENT` first: this is exported,
  // and an unescaped `.` in a name is a wildcard that would match a call to
  // something else entirely and report its arguments as this one's.
  const safe = String(name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!safe) return out;
  for (const rx of [
    new RegExp(`(^|[^\\w$.])${safe}\\s*\\(`, "g"),
    new RegExp(`\\.\\s*${safe}\\s*\\(`, "g"),
  ]) {
    let m;
    while ((m = rx.exec(text))) {
      let i = m.index + m[0].length;
      const start = i;
      let depth = 1;
      let quote = null;
      for (; i < text.length && depth > 0; i += 1) {
        const c = text[i];
        if (quote) {
          if (c === "\\") i += 1;
          else if (c === quote) quote = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") quote = c;
        else if ("([{".includes(c)) depth += 1;
        else if (")]}".includes(c)) depth -= 1;
      }
      if (depth === 0) out.push(splitArgs(text.slice(start, i - 1)));
    }
  }
  return out;
}

/** The parameter a recognised family's arm turns on, by name. */
export function subjectParam(item, side, family) {
  if (family === "default-arg") return defaultedParam(side);
  if (family === "nullish") return nullishOf(item)?.name ?? null;
  return comparisonOf(conditionOf(item))?.name ?? null;
}

/**
 * The distribution of the `no-own-entry` refusals, over the sides whose shape
 * this file already recognises.
 *
 * `readSource(file)` returns a module's text or null; it is injected so this
 * can be measured against a fixture as well as against a checkout, and so that
 * a file that is not on disk is a counted bucket rather than a crash.
 */
export function callerGate({ worklist, scan, readSource }) {
  const byId = new Map((scan?.functions ?? []).map((f) => [f.id, f]));
  const buckets = new Map();
  const samples = new Map();
  const forwards = [];
  const bump = (key, sample) => {
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    if (sample && !samples.has(key)) samples.set(key, sample);
  };

  for (const item of worklist?.items ?? []) {
    if (!item?.instrumented) continue;
    if (item.owner?.entry?.reachable) continue;
    for (const side of item.uncoveredSides ?? []) {
      const family = familyOf(item, side);
      if (!family) continue;
      const via = item.via ?? byId.get(item.owner?.functionId)?.via ?? null;

      if (!via) {
        bump("the scan resolved no driver at all");
        continue;
      }
      if (via.kind === "trigger" || via.kind === "at-import") {
        bump("a framework trigger — there is no caller to steer");
        continue;
      }
      if (via.kind === "unresolved" || via.kind === "needs-seam") {
        bump("the driver is unresolved — it needs a test seam");
        continue;
      }
      if (via.kind === "through-chain") {
        bump(`two or more frames (${(via.path ?? []).length} hops)`);
        continue;
      }
      const drivers = via.driver ? [via.driver] : (via.drivers ?? []);
      if (drivers.length !== 1 || via.confidence !== "certain") {
        bump("several possible drivers, or an ambiguous one");
        continue;
      }
      const driver = byId.get(drivers[0]);
      if (!driver) {
        // Every one of these on the six work lists is `through-class-holder`
        // onto `export <binding>` — a different shape, and NOT a caller
        // problem. `instanceAddress` answers it; this bucket is still counted
        // here because `callerGate` measures the raw `no-own-entry`
        // population, which is what makes it comparable to the 486 it was
        // first run against.
        bump("the driver is an exported module-scope binding, not a function", `${via.kind} -> ${drivers[0]}`);
        continue;
      }
      if (!driver.entry?.reachable) {
        bump("the driver itself has no own entry");
        continue;
      }
      if ((driver.entry.ctorParams ?? []).length) {
        bump("the driver is a method of a class with a constructor");
        continue;
      }
      if ((driver.boundaries ?? []).filter((b) => b && !b.advisory && !b.typeOnly).length) {
        bump("the DRIVER has a boundary to answer — the boundary gate, one frame up");
        continue;
      }

      const subject = subjectParam(item, side, family);
      const at = paramIndex(item.owner?.params ?? [], subject);
      if (at === -1) {
        bump("the subject is not a plain declared parameter of the arm's function");
        continue;
      }
      const text = readSource(driver.file);
      if (text == null) {
        bump("the driver's module is not on disk");
        continue;
      }
      const body = text.split("\n").slice(driver.line - 1, driver.endLine).join("\n");
      const callee = String(item.owner?.name ?? "").split(".").pop();
      if (!callee || !IDENT.test(callee)) {
        bump("the callee has no plain name to find a call by");
        continue;
      }
      const calls = callSites(body, callee);
      if (!calls.length) {
        bump("the driver references the callee but never calls it");
        continue;
      }
      if (calls.length > 1) {
        bump(`${calls.length > 3 ? "several" : calls.length} call sites in the driver — which one reaches the arm is a reading`);
        continue;
      }
      const args = calls[0];
      if (at >= args.length) {
        bump("the call does not supply that argument");
        continue;
      }
      const passed = args[at];
      if (!IDENT.test(passed)) {
        bump("the argument is an expression, not a bare name", passed);
        continue;
      }
      const driverAt = paramIndex(driver.params ?? [], passed);
      if (driverAt === -1) {
        bump("the argument is a local or a closure, not a driver parameter", passed);
        continue;
      }
      bump("FORWARDED VERBATIM", `${driver.id} param ${driverAt} (${passed}) -> ${callee} param ${at} (${subject})`);
      forwards.push({ armId: item.armId, side, family, driver: driver.id, driverParam: driverAt, param: at });
    }
  }
  const total = [...buckets.values()].reduce((a, b) => a + b, 0);
  return { total, forwarded: forwards.length, buckets, samples, forwards };
}

/**
 * The submission document for one candidate.
 *
 * ONE ROW PER FILE, which costs a `propose.mjs` spawn each and buys the thing
 * that matters: a row `validate.mjs` refuses is quarantined WITH THE FILE it
 * came in, so a single defective rule would otherwise take every candidate
 * beside it down. `steps/derive.mjs` states the same trade from the other side
 * — a resubmission that trims the refused rows also loses the rows that were
 * fine.
 */
export function submissionDoc(row) {
  // THE NOTE SAYS WHICH OF TWO SOURCES THIS ROW USED, and it has to, because
  // they carry different weight. Every `args` value is read off the arm's own
  // text in scan.json and is as certain as the scan is. A boundary answer is
  // read off `behaviour.json` — a recorded row, with ITS arguments — and is an
  // observation rather than a derivation. A reviewer who sees one sentence for
  // both would be told the weaker claim is as strong as the stronger one.
  const learned = Object.keys(row.boundaries ?? {});
  return {
    stage: "3-proposals",
    authoredBy: AUTHORED_BY,
    note:
      "Written by frontdoor.mjs, a deterministic pre-pass: every value here is read off the arm's own text in " +
      "scan.json, and no behaviour of the function was read. " +
      (learned.length
        ? `The boundary answer(s) for ${learned.join(", ")} are the exception and are not read from source either: ` +
          "each is a `notCalled` taken from behaviour.json, where the recorder ran this function without calling " +
          "that symbol. That is an observation on other arguments, not a proof for these — a wrong one is logged " +
          "with `declaredNotCalled` and never delegated, and stage 6 reports the contradiction. "
        : "") +
      "It goes through propose.mjs and validate.mjs like " +
      "every other answer — if it does not validate, the rule is wrong and that is the finding.",
    proposals: [row],
  };
}

/** `charpilot-answers/frontdoor-<id>.json` for each candidate. */
export function writeSubmissions(rows, dir) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const row of rows) {
    const name = `frontdoor-${row.id.replace(/^fd-/, "")}.json`;
    writeFileSync(join(dir, name), `${JSON.stringify(submissionDoc(row), null, 2)}\n`);
    written.push(name);
  }
  return written;
}

/**
 * A work list built from a SCAN ALONE, with every side counted as open.
 *
 * For a cached fleet scan there is no coverage — `fleetcheck` runs the
 * denominator only, with `include: []` and every hit count at zero — so this
 * reports the CEILING, exactly as `fleetsweep` does: what the classification
 * would be if the repo's own suite covered nothing. It is an upper bound and a
 * ranking, never a quote, and the fraction it reports is a fraction OF THAT
 * BOUND.
 */
export function worklistFromScan(scan) {
  const items = [];
  for (const fn of scan?.functions ?? []) {
    for (const a of fn.arms?.list ?? []) {
      items.push({
        armId: a.armId,
        file: fn.file ?? String(a.armId).split("#")[0],
        line: a.line,
        kind: a.kind,
        source: a.text,
        sides: a.labels ?? [],
        uncoveredSides: a.labels ?? [],
        instrumented: a.istanbul !== false,
        owner: { functionId: fn.id, name: fn.name, async: fn.async, params: fn.params ?? [], entry: fn.entry ?? {} },
        via: fn.via ?? null,
        lane: "unit",
        boundaries: fn.boundaries ?? [],
      });
    }
  }
  return { items, statementUnits: [] };
}

/* ---------------------------------------------------------------------------
 * THE COMMAND
 * ------------------------------------------------------------------------ */

const ARGV = process.argv.slice(2);
const VALUE_FLAGS = ["--scan", "--worklist", "--out", "--behaviour"];
const BARE_FLAGS = ["--write", "--json", "--callers", "--no-recording"];
const arg = (flag, dflt) => {
  const i = ARGV.indexOf(flag);
  return i === -1 ? dflt : ARGV[i + 1];
};

/** An unrecognised flag is REFUSED, not ignored — propose.mjs states the rule. */
export function checkFlags(argv = ARGV) {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (VALUE_FLAGS.includes(token)) {
      const value = argv[i + 1];
      if (value === undefined || VALUE_FLAGS.includes(value) || BARE_FLAGS.includes(value)) return `${token} needs a value.`;
      i += 1;
      continue;
    }
    if (!BARE_FLAGS.includes(token)) {
      return `unrecognised argument ${JSON.stringify(token)}. Known: ${[...VALUE_FLAGS, ...BARE_FLAGS].join(" | ")}.`;
    }
  }
  return null;
}

/** The census as lines, with what each number does and does not include. */
export function report({ census, refusals, repo, wrote = null, ceiling = false }) {
  const rows = (map) => [...map].sort((a, b) => b[1] - a[1]);
  const out = [];
  out.push(`\nfrontdoor — ${repo}`);
  out.push(
    ceiling
      ? `    ${census.sides} sides, EVERY side in the scan: this is a cached scan with no coverage behind it, so the`
      : `    ${census.sides} open sides, from the work list — uncovered only, one row per side`
  );
  if (ceiling) out.push("    count is the ceiling fleetsweep reports, not what a run would still have to answer.");
  out.push(`    ${census.candidates} of them have a candidate this file could write without reading the function.`);
  out.push("");
  out.push("  by arm kind, every open side:");
  for (const [k, n] of rows(census.byKind)) out.push(`    ${String(n).padStart(6)}  ${k}`);
  out.push("");
  out.push("  the SHAPE of each open side, whatever this file could do about it — a family is not a candidate:");
  for (const [k, n] of rows(census.byFamily)) out.push(`    ${String(n).padStart(6)}  ${k}`);
  if (!census.byFamily.size) out.push("           0  (none)");
  out.push("");
  out.push("  refused, by the FIRST reason each side was out:");
  for (const [k, n] of rows(census.byRefusal)) out.push(`    ${String(n).padStart(6)}  ${k}`);
  if (census.familyRefusal?.size) {
    out.push("");
    out.push("  of the sides this file DOES recognise, what stopped them — the list that says what to build next:");
    for (const [k, n] of rows(census.familyRefusal)) out.push(`    ${String(n).padStart(6)}  ${k}`);
  }
  const sample = new Map();
  for (const r of refusals) if (!sample.has(r.code)) sample.set(r.code, r);
  if (sample.size) {
    out.push("");
    out.push("  one of each, in its own words:");
    for (const [, r] of sample) out.push(`    ${r.code}: ${r.armId} [${r.side}] — ${r.why}`);
  }
  if (census.instanceAddressed) {
    out.push("");
    out.push(
      `    ${String(census.instanceAddressed).padStart(6)}  candidate(s) addressed at an exported instance — the arm has no own entry, the scan`
    );
    out.push("            resolves it through `export <binding>` at `certain` confidence, and the row declares that");
    out.push("            binding as `via`. The arguments are still the method's own; no caller was read.");
  }
  if (census.blockedModules || census.learnedBoundaries) {
    out.push("");
    out.push("  what a recorded round changed, and nothing here is read from source:");
    out.push(
      `    ${String(census.learnedBoundaries).padStart(6)}  boundary answer(s) written as \`notCalled\` — the symbol is in no call list of a`
    );
    out.push("            recorded row of that function, and the arm's own text does not name it");
    out.push(
      `    ${String(census.blockedModules).padStart(6)}  module(s) a recorded round refused for blocked egress; a candidate in one is`
    );
    out.push("            refused as `module-blocked-egress` above rather than spent on propose/validate/record");
  }
  if (wrote) {
    out.push("");
    out.push(`  wrote ${wrote.names.length} submission(s) into ${wrote.dir}. Nothing is in proposals/ yet: the next`);
    out.push("  derive round materialises them through propose.mjs and validate.mjs judges the result.");
  }
  return out.join("\n") + "\n";
}

/** The caller-gate distribution as lines. A measurement, not a candidate list. */
export function callerReport({ total, forwarded, buckets, samples, repo }) {
  const out = [];
  out.push(`\nfrontdoor --callers — ${repo}`);
  out.push(`    ${total} sides whose SHAPE this file recognises and whose arm has no own entry.`);
  out.push("    This writes nothing. It is the inspection plan 16 part 6 says has never been done,");
  out.push("    and the one number it exists to produce is the forwarding share below.");
  out.push("");
  for (const [k, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
    out.push(`    ${String(n).padStart(6)}  ${k}`);
    if (samples.has(k)) out.push(`            e.g. ${samples.get(k)}`);
  }
  out.push("");
  const pct = total ? ((forwarded / total) * 100).toFixed(1) : "0.0";
  out.push(`  FORWARDED VERBATIM: ${forwarded} of ${total} (${pct}%). That is the share for which the only missing`);
  out.push("  fact is \"this driver parameter reaches that callee parameter unchanged\", which a rule could have.");
  out.push("  Every other bucket needs a reading of the caller, of a second frame, or of a collaborator.");
  out.push("  It does NOT include: whether the driver's own signature can be called positionally, whether the");
  out.push("  call sits behind a branch in the driver, or whether the resulting row would validate.");
  return out.join("\n") + "\n";
}

function main() {
  const bad = checkFlags();
  if (bad) {
    process.stderr.write(`✗ frontdoor: ${bad}\n`);
    process.exit(2);
  }
  const scanPath = resolve(arg("--scan", SCAN_JSON));
  if (!existsSync(scanPath)) {
    process.stderr.write(`✗ frontdoor: no scan at ${scanPath}. Run scan.mjs first, or name one with --scan.\n`);
    process.exit(2);
  }
  const scan = JSON.parse(readFileSync(scanPath, "utf8"));

  // A SCAN NAMED ON THE COMMAND LINE WITH NO WORK LIST BESIDE IT IS THE FLEET
  // CASE, and it answers a different question: the ceiling, not the remaining
  // work. It is allowed because the cache holds 33 of those and needs no clone,
  // so the classification can be measured across the whole fleet for nothing —
  // and it is LABELLED, because a ceiling reported as a work list is a number
  // that reads as a quote.
  //
  // The condition is the FLAG and not the absence of out/worklist.json: run in
  // a repo that has its own work list, `--scan out/fleet/other/scan.json` would
  // otherwise classify one repo's sides against another repo's arms and report
  // the join failures as refusals.
  const worklistPath = arg("--worklist", null);
  const ceiling = Boolean(arg("--scan", null)) && !worklistPath;
  const listPath = resolve(worklistPath ?? WORKLIST_JSON);
  if (!ceiling && !existsSync(listPath)) {
    process.stderr.write(`✗ frontdoor: no work list at ${listPath}. Run worklist.mjs first, or name one with --worklist.\n`);
    process.exit(2);
  }
  const worklist = ceiling ? worklistFromScan(scan) : JSON.parse(readFileSync(listPath, "utf8"));

  // THE CALLER GATE IS A SEPARATE COMMAND because it answers a separate
  // question and costs a separate thing: it reads every driver's module off
  // disk, which the census never does. Nothing it prints is a candidate.
  if (ARGV.includes("--callers")) {
    const cache = new Map();
    const readSource = (file) => {
      if (!cache.has(file)) {
        const p = resolve(REPO_ROOT, file);
        cache.set(file, existsSync(p) ? readFileSync(p, "utf8") : null);
      }
      return cache.get(file);
    };
    const gate = callerGate({ worklist, scan, readSource });
    if (ARGV.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify(
          { repo: relative(REPO_ROOT, scanPath), total: gate.total, forwarded: gate.forwarded, buckets: Object.fromEntries(gate.buckets), forwards: gate.forwards },
          null,
          2
        )}\n`
      );
      return;
    }
    process.stdout.write(callerReport({ ...gate, repo: relative(REPO_ROOT, scanPath) || scanPath }));
    return;
  }

  // STAGE 4'S OWN OUTPUT, PICKED UP WHEN IT IS THERE AND NEVER DEMANDED.
  //
  // A recording is what licences the only two rules in this file that are not
  // read off the arm's own text, so it is loaded by default rather than behind
  // a flag: a repo that has recorded once should not have to be told twice.
  // `--no-recording` turns it off, which is how the baseline census is
  // reproduced on a repo that has since recorded.
  let behaviour = null;
  let evidence = null;
  const behaviourPath = resolve(arg("--behaviour", BEHAVIOUR_JSON));
  if (!ARGV.includes("--no-recording") && existsSync(behaviourPath)) {
    behaviour = JSON.parse(readFileSync(behaviourPath, "utf8"));
    evidence = relative(REPO_ROOT, behaviourPath) || behaviourPath;
  }

  const { rows, refusals, census } = frontDoor({ worklist, scan, behaviour, evidence });

  let wrote = null;
  if (ARGV.includes("--write")) {
    if (ceiling) {
      process.stderr.write(
        "✗ frontdoor: --write needs a work list. Against a bare scan every side counts as open, so the candidates\n" +
          "  would claim sides the repo's own suite may already cover, and `from.evidence` names files this repo may\n" +
          "  not have. Run worklist.mjs first.\n"
      );
      process.exit(2);
    }
    const dir = resolve(arg("--out", answersDir(REPO_ROOT)));
    wrote = { names: writeSubmissions(rows, dir), dir: relative(REPO_ROOT, dir) || dir };
  }

  if (ARGV.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          repo: relative(REPO_ROOT, scanPath),
          ceiling,
          sides: census.sides,
          candidates: census.candidates,
          byKind: Object.fromEntries(census.byKind),
          byFamily: Object.fromEntries(census.byFamily),
          byRefusal: Object.fromEntries(census.byRefusal),
          familyRefusal: Object.fromEntries(census.familyRefusal),
          learnedBoundaries: census.learnedBoundaries,
          blockedModules: census.blockedModules,
          instanceAddressed: census.instanceAddressed,
          wrote: wrote?.names ?? null,
          rows: rows.map((r) => r.id),
        },
        null,
        2
      )}\n`
    );
    return;
  }
  process.stdout.write(report({ census, refusals, repo: relative(REPO_ROOT, scanPath) || scanPath, wrote, ceiling }));
}

// Only when this file is the ENTRY POINT — validate.mjs states the rule and the
// three tools it cost when 26 of 40 here executed on import.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) main();
