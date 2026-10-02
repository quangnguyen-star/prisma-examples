#!/usr/bin/env node
/**
 * pregen — fill a packet's proposal skeleton with MECHANICAL candidates, and
 * score those candidates against answers that already validated.
 *
 *   node tools/pregen.mjs --packets <dir> --score --truth <proposalsDir>
 *   node tools/pregen.mjs --packets <dir> --out <dir>
 *   node tools/pregen.mjs --packet <file> --json
 *
 * WHY THIS IS A TOOL AND NOT AN EDIT TO `steps/derive.mjs`. Plan 19's D66 says
 * a tool should pre-generate candidate inputs so the agent VERIFIES rather than
 * AUTHORS. That claim is testable exactly once: as a thing that can be switched
 * on for one arm of a measurement and off for the other. Folded into derive it
 * is a behaviour change nobody can price. Standalone it has a `--score` mode
 * that costs nothing and a `--out` mode `packetcost.mjs --packet-overlay`
 * consumes, and the two together are the whole experiment.
 *
 * WHAT IS ALREADY PRE-GENERATED, WHICH D66 DOES NOT SAY AND IS THE FIRST
 * FINDING. The skeleton in `context.proposal.skeleton` ALREADY carries `id`,
 * `functionId`, `lane`, `covers`, `reaches`, one `args` entry per parameter in
 * declaration order, every `boundaries` key `validate.mjs` demands with its
 * `module` filled in, and every `from.arm` set to an arm this row covers. D66's
 * three named examples — "`args` from types, `mock` from boundary class,
 * `covers`/`reaches` from the scan" — are one-and-a-half items, not three:
 * `covers`/`reaches` are DONE and have been since the skeleton existed.
 *
 * WHAT IS LEFT, counted over notification-ms's 63 skeletons — 1,515 fill
 * obligations, which is what `--census` prints:
 *
 *     258  17.0%  boundaries[].behaviour          prose
 *     258  17.0%  boundaries[].mock.kind          ENUM  <- derivable, 66%
 *     258  17.0%  boundaries[].from.evidence      file:line
 *     258  17.0%  boundaries[].from.reading       prose
 *     140   9.2%  args[].from.evidence            file:line
 *     140   9.2%  args[].from.reading             prose
 *     140   9.2%  args[].value | build            THE INPUT  <- derivable, 21%
 *      63   4.2%  rationale                       prose
 *
 * **73.7% of what a worker owes is a sentence citing a line it has to have
 * read.** That is not an accident of this repo's style, it is `validate.mjs`'s
 * `checkEvidence`: a value with no `from.evidence` is refused as a fabricated
 * value. So the two fields this tool can fill are 26.3% of the obligations, and
 * filling them removes no reading — the citation beside each one still demands
 * the same line of the same file.
 *
 * THE TWO RULES, AND THEIR MEASURED ACCURACY against the 22 notification-ms
 * packets whose answers landed and validated in run 20260918:
 *
 *   `mock.kind` from the boundary's MODULE CLASS      68/103 = 66.0%
 *       local `@/…` -> passthrough · package -> passthrough · `<instance
 *       field>` -> value. Every miss is `notCalled` (16) or `returns` (9) or
 *       `rejects` (2), and all three of those are statements about WHETHER AND
 *       HOW THE SIDE REACHES THE CALL — which is reading the function.
 *       Two sharper rules were tried and are WORSE, not better: gating on
 *       whether the symbol appears in the arm's own `source` text scores
 *       31.1%, because an arm's source is one branch statement and the
 *       boundary is called ten lines away. The module class is the only
 *       signal, and 66% is its ceiling.
 *
 *   `args[i]` from the PARAMETER TYPE                 11/52 = 21.2%
 *       `Request<…>` -> `doubles.expressRequest({})` · `Response<…>` ->
 *       `doubles.expressResponse()` · `NextFunction` -> `doubles.spy()` ·
 *       primitives -> their zero value. The HELPER is right 20 of 52 times;
 *       the exact expression is right 11. Every one of those 11 is
 *       `doubles.expressResponse()`, a double with no content — so the rule's
 *       real score on any argument that CARRIES the input is **0 of 34**, and
 *       7 of its 9 remaining misses are `doubles.spy()` against
 *       `() => undefined`, which is the same no-op spelled differently.
 *       `doubles.expressRequest({})` against
 *       `doubles.expressRequest({ params: { id: "not-a-valid-uuid" } })` is
 *       the whole of D66's failure mode in one line: it looks like an answer,
 *       it parses, `validate.mjs` accepts it, and it steers the arm the other
 *       way.
 *
 * WHAT THE TWO-ARM MEASUREMENT FOUND, notification-ms, `packetcost.mjs`, same
 * packets, same prompt, one variable — the brief with candidates against the
 * brief without. $4.71 of agent time, four dispatches:
 *
 *     packet     arm                sec  turns    USD   cacheRead   validated
 *     packet-06  control †          146     11   1.76     761,728      1/1
 *     packet-06  pregen-candidate    93      8   0.95     380,456      1/1
 *     packet-36  control            166     19   1.54   1,167,659      1/1
 *     packet-36  pregen-candidate    77      7   0.83     303,994      1/1
 *     packet-16  control            225     14   1.80   1,016,627      6/6
 *     packet-16  pregen-candidate   261     16   1.99   1,046,866      6/6
 *     packet-06  pregen-POISONED     99      7   0.94     316,212      1/1
 *
 * † packet-06's control is NOT from this experiment. It is the earlier
 * standalone packetcost measurement, another session and other host
 * conditions, set beside a paired arm-B run. Two of the three pairs are
 * matched; the one carrying the biggest saving is one of them, and its control
 * is the 19.
 *
 * TURNS DROPPED ON TWO OF THREE AND ROSE ON THE THIRD, and the split is not
 * random: **the two that dropped are the two where a candidate filled `args`;
 * the one that rose is the one where the rule could fill nothing but
 * `mock.kind`.** packet-16's parameter is a `{ userId: string; channel?: … }`
 * object literal, which `argCandidate` abstains on, so its brief got 12 slots
 * of candidate receipt, 10.5 KB more to read, and no answer — and paid two
 * turns for it. That is the shape of the result, at n=3 — and the section below
 * is what happened when the run-to-run variance it rests on was finally priced.
 * The short version: one more control run did not reproduce the 19, and two of
 * the three savings do not survive it.
 *
 * ---------------------------------------------------------------------------
 * THE VARIANCE OF A CONTROL, MEASURED, WHICH IS WHAT THE TABLE ABOVE WAS
 * MISSING. Eight further dispatches, $11.41, same packets, same prompt, same
 * arm — control, no overlay — run one at a time on one host, interleaved with
 * nothing. The question is not whether pregen helps; it is how much of the
 * table above one arm reproduces on its own.
 *
 *     packet-36  control x5    turns  19, 11, 15, 16, 14   mean 15.0  sd 2.92  CV 19.4%
 *                              sec   166,124,152,168,139   mean 149.8 sd 18.6  CV 12.4%
 *                              cacheRead 1,167,659 · 777,389 · 827,579 ·
 *                                        995,068 · 885,523  mean 930,644  CV 16.7%
 *     packet-06  control x3    turns  12, 7, 6             mean  8.3  sd 3.21  CV 38.6%
 *                              sec   183, 101, 62          mean 115.3 sd 61.8  CV 53.5%
 *                              cacheRead 696,943 · 325,409 · 254,364  mean 425,572  CV 55.9%
 *     packet-16  control x2    turns  14, 15               mean 14.5  sd 0.71  CV  4.9%
 *                              sec   225, 232              mean 228.5 sd 4.95  CV  2.2%
 *                              cacheRead 1,016,627 · 1,226,562        mean 1,121,595  CV 13.2%
 *
 * (Each packet's first value is the original control from the table above;
 * packet-06's three are all new, since its old row was another session's.
 * Every one of the eight validated with zero faults and closed its roster,
 * so the spread below is a spread in COST, never in outcome.)
 *
 * A CONTROL ON ONE SIDE SWINGS 6 TO 12 AND 11 TO 19 TURNS. That is the whole
 * finding. On packet-06 the max is 2.00x the min; on packet-36, 1.73x. The
 * effect the table claimed is the same size as the noise it was read out of.
 *
 *   packet-06, claimed 11 -> 8.  DOES NOT SURVIVE. The three matched controls
 *       mean 8.3 turns; the pregen arm scored 8. It is not a saving of three
 *       turns, it is 0.3 turns of nothing, z = -0.10, dead on the control
 *       mean. 93 s sits inside 62–183 s and 380,456 cache-read sits inside
 *       254,364–696,943. The 11 that made it look like a saving is a normal
 *       high draw of a control, and it came from another session besides.
 *
 *   packet-36, claimed 19 -> 7.  SURVIVES, BUT AT A THIRD OF ITS SIZE AND ON
 *       ONE OBSERVATION. The control's mean is 15.0, not 19, so the honest
 *       claim is 15 -> 7, eight turns rather than twelve — a third of the
 *       headline is regression to the mean. What is left is not nothing: 7
 *       turns is below all five controls (z = -2.74), 77 s is below the
 *       95% prediction interval for a single new control run ([93, 206] s),
 *       and 303,994 cache-read is 2.6x under the lowest control and far
 *       outside its interval ([458k, 1,403k]). On turns alone, though, 7 is
 *       just INSIDE that interval ([6.1, 23.9]), so turns — the harder
 *       number — is the one metric that cannot yet reject a lucky control.
 *       And the arm it is being compared against is n=1.
 *
 *   packet-16, the regression 14 -> 16.  PROBABLY REAL, and it is the tightest
 *       thing here: two controls landed 14 and 15 turns, 225 and 232 s, CV
 *       under 5%. The pregen arm's 16 turns and 261 s are outside both. The
 *       one packet where the rule could fill no `args` is the one packet whose
 *       cost is reproducible enough to say the candidates made it worse.
 *
 * IS THE 19 AN OUTLIER? NO — IT IS THE TOP OF THE SPREAD. Against the five
 * control runs it is z = +1.37, the largest of five draws and exactly where a
 * largest-of-five belongs. Nothing about it is anomalous; what was anomalous
 * was reading a single draw as the packet's cost. That distinction is the
 * whole reason this section exists: the number was not wrong, the inference
 * from one of it was.
 *
 * WHERE THE VARIANCE LIVES, WHICH IS THE FINDING WORTH KEEPING. It is not
 * uniform across packets — it is concentrated in exactly the ones the effect
 * was claimed on. The two SINGLE-SIDE packets have CV 19% and 39% in turns;
 * the SIX-SIDE packet has CV 5%. On a one-side brief a single extra read or
 * one repair loop is a third of the whole job; on a six-side brief the
 * per-side work averages and the total barely moves. So a one-side packet is
 * the worst possible instrument for an A/B of this size, and packet-16 — the
 * one that says the candidates HURT — is the most trustworthy row in the
 * original table. Future arms should be measured on multi-side packets, or on
 * many single-side ones, and never on one pair of one side.
 *
 * WHAT WOULD SETTLE IT, priced. For a two-arm comparison at 80% power and
 * alpha 0.05, n per arm is about 16 sigma^2 / delta^2:
 *
 *     packet-36, sigma 2.92 turns, delta 8 turns   ->  n ~ 3 per arm
 *     packet-16, sigma 0.71 turns, delta 1.5 turns ->  n ~ 4 per arm
 *     packet-06, sigma 3.21 turns, delta 0.3 turns ->  n ~ 1,800 per arm
 *
 * packet-06's answer is the useful one: an effect that needs 1,800 runs per
 * arm to see is an effect nobody should build for. The cheap and decisive buy
 * is packet-36's OTHER arm — its control is already at n=5, its pregen arm at
 * n=1, and a pregen dispatch on that packet costs $0.83. FOUR MORE PREGEN RUNS
 * OF packet-36, about $3.30, would take that pair to 5 v 5 and either confirm
 * an eight-turn saving or end it. Four more of packet-16, about $8, would
 * settle the regression. Nothing should be built on the `args` slice until the
 * first of those two has been bought — as it stands the entire positive result
 * is one dispatch that has never been repeated, against a control whose own
 * spread is 1.7x wide.
 * ---------------------------------------------------------------------------
 *
 * VALIDATION DID NOT DEGRADE. 8 sides claimed and 8 validated in each arm,
 * zero faults in each arm, rosters closed 1/1, 1/1 and 6/6 both ways.
 *
 * THE RUBBER-STAMP TEST, WHICH IS THE ONE THE PLAN ASKED FOR FIRST. Across the
 * four dispatches the workers were handed 29 candidate slots. **0 were kept
 * wrong.** 22 were kept and all 22 agreed with the answer that landed and
 * validated in the real run; 5 were replaced with a better value; 2 were
 * CORRECTED from a wrong candidate to exactly the landed one. The poisoned run
 * is the sharp case and it was designed to be un-catchable by the validator: a
 * `params.id` of `"550e8400-e29b-41d4-a716-446655440000"` — a VALID uuid, so
 * `messageLogIdSchema.safeParse` succeeds and the `if (!parsed.success)` guard
 * takes the ELSE side — with a `value` mock beside it stubbing `safeParse` to
 * succeed, so the two poisons agree with each other. The worker replaced both
 * and said why, in the row: *"z.object({ id: z.string().uuid() }) is a pure
 * in-process zod schema with no I/O, so the real export can run; stubbing
 * safeParse to succeed would take the `else` side instead."*
 *
 * AND THE VALIDATOR CANNOT DO THAT, WHICH IS WHY THE AGENT DOING IT IS NOT A
 * GUARANTEE. The same poisoned row, submitted verbatim with the real worker's
 * own citations around it, was put through `propose.mjs` and `validate.mjs` in
 * a packetcost sandbox:
 *
 *     ✓ validated 1 proposals from 1 file(s)
 *       errors 0 · warnings 0 · advisories 0
 *
 * A row that claims the `then` side and reaches the `else` one passes stage 3
 * clean, is counted by `ledger.mjs` from its `reaches`, and is not contradicted
 * until stage 5. `validate.mjs` says so itself, in the comment above the check
 * it deleted: this defect class "is caught by STAGE 5 measuring whether the
 * side actually went green. That is the honest place for it." So the safety
 * result above is a measurement OF ONE MODEL ON ONE REPO AT 29 SLOTS, not a
 * property of the pipeline, and nothing downstream would report it if it
 * stopped holding.
 *
 * WHAT IT REFUSES TO GUESS, and why the refusal is the safety property.
 * `from.evidence`, `from.reading`, `behaviour` and `rationale` keep their
 * `<<DERIVE>>` sentinel. That is not modesty. `validate.mjs` scans for a
 * surviving sentinel TO ANY DEPTH and refuses the row, so a candidate this
 * tool wrote cannot reach the proposals directory unless the agent wrote the
 * citation beside it. A pre-filled row is therefore incapable of landing
 * unreviewed — the governing rule of this tree is that no change may add a
 * place where correct work is lost, and an unconfirmable candidate would add
 * the worst kind. What it CAN do is bias the sentence the agent writes, and
 * that is what the measurement is for, not this docblock.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ARGV = process.argv.slice(2);
const flag = (f) => ARGV.includes(f);
const arg = (f, d) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : d);
const log = (s) => process.stdout.write(`${s}\n`);

/** The sentinel `validate.mjs` refuses at any depth. Never written over by a guess. */
export const DERIVE = "<<DERIVE>>";

/* --------------------------------------------------------------- the rules */

/**
 * Which of three classes a boundary's `module` puts it in.
 *
 * The packet already prints `module` for every boundary key, so this needs no
 * scan lookup and no file read. `<instance field>` is the recorder's own label
 * for a `this.x` collaborator; `@/…` and `./…` are this repo's source; anything
 * else came out of `node_modules`.
 */
export function moduleClass(module) {
  if (module === "<instance field>") return "instance-field";
  if (typeof module === "string" && (module.startsWith("@/") || module.startsWith("."))) return "local";
  return "package";
}

/**
 * A candidate `mock.kind`, or null when there is no rule.
 *
 * 66.0% against the landed answers, and the 34% that is wrong is wrong in the
 * one direction that matters: `value` where the truth is `notCalled` means an
 * answer is INSTALLED on a collaborator the side never reaches, and
 * `passthrough` where the truth is `notCalled` means the real collaborator is
 * left live. `validate.mjs` refuses neither — its own comment says this defect
 * class "is caught by STAGE 5 measuring whether the side actually went green",
 * which is four stages and one recording after the row was written.
 */
export function kindCandidate(module) {
  const cls = moduleClass(module);
  if (cls === "instance-field") return { value: "value", rule: "module is an instance field -> the collaborator is replaced by a value", accuracy: 0.72 };
  if (cls === "local") return { value: "passthrough", rule: "module is repo-local -> the real export runs", accuracy: 0.75 };
  return { value: "passthrough", rule: "module is a package -> the real export runs", accuracy: 0.64 };
}

/**
 * A candidate `args[i]`, or null when the parameter's type says nothing.
 *
 * Null is the common and the honest answer: a domain type has no zero value
 * that is also an INPUT, and an input that does not steer the arm is the
 * failure this is being measured for. The three express types are named
 * because `doubles` has a helper for each and 22 of notification-ms's 63
 * skeletons are express handlers.
 */
export function argCandidate(param) {
  const t = String(param?.type ?? "");
  if (/\bRequest</.test(t)) return { build: "doubles.expressRequest({})", rule: "type Request<> -> the express request double, CONTENT EMPTY", carriesInput: true };
  if (/\bResponse</.test(t)) return { build: "doubles.expressResponse()", rule: "type Response<> -> the express response double", carriesInput: false };
  if (t === "NextFunction") return { build: "doubles.spy()", rule: "type NextFunction -> a spy", carriesInput: false };
  if (t === "string") return { value: "", rule: "primitive string -> its zero value", carriesInput: true };
  if (t === "number") return { value: 0, rule: "primitive number -> its zero value", carriesInput: true };
  if (t === "boolean") return { value: false, rule: "primitive boolean -> its zero value", carriesInput: true };
  return null;
}

/* ------------------------------------------------------------ the fill */

/**
 * One item's skeleton with candidates written in, and the receipt of what was
 * written.
 *
 * The receipt is not decoration: it is the only thing that tells the worker a
 * filled slot is a GUESS. A value that arrives looking like the rest of the
 * skeleton — where every other field IS an address the tools computed and
 * `proposal.rules` says "retyping one is how a claim silently stops being
 * verifiable" — reads as an instruction, not a proposal. So every candidate is
 * listed by path with the rule that produced it and that rule's measured hit
 * rate, and the note says in its first clause that these are unverified.
 */
export function fillItem(item) {
  const sk = item?.context?.proposal?.skeleton;
  if (!sk) return { item, filled: [] };
  const params = item?.context?.owner?.params ?? [];
  const filled = [];
  const out = JSON.parse(JSON.stringify(sk));

  for (let i = 0; i < (out.args ?? []).length; i += 1) {
    const c = argCandidate(params[i]);
    if (!c) continue;
    if ("build" in c) out.args[i].build = c.build;
    else out.args[i].value = c.value;
    filled.push({
      path: `args[${i}]`,
      param: params[i]?.name ?? `#${i}`,
      wrote: "build" in c ? c.build : JSON.stringify(c.value),
      rule: c.rule,
      // Named per slot, because the two rules are not equally trustworthy and a
      // single "verify this" banner would flatten a 0-of-41 rule into a 66% one.
      check: c.carriesInput
        ? "THIS ARGUMENT CARRIES THE INPUT. The rule filled its SHAPE and knows nothing about its CONTENT: measured 0 of 34 correct on arguments that steer an arm. Read the branch and replace the content, or the row aims at the other side."
        : "This argument does not steer the arm; the rule is the shape and the shape is all there is.",
    });
  }

  for (const [sym, b] of Object.entries(out.boundaries ?? {})) {
    if (b?.mock?.kind !== DERIVE) continue;
    const c = kindCandidate(b.module);
    if (!c) continue;
    b.mock.kind = c.value;
    filled.push({
      path: `boundaries[${JSON.stringify(sym)}].mock.kind`,
      wrote: c.value,
      rule: c.rule,
      check:
        `Measured ${Math.round(c.accuracy * 100)}% correct on this class. Every miss is notCalled, returns or rejects — ` +
        `whether the side REACHES this call, which the rule cannot see. validate.mjs does not check this field against the arm; ` +
        `a wrong one lands, validates, and dies at stage 5 as a side that never went green.`,
    });
  }

  if (!filled.length) return { item, filled: [] };
  const next = JSON.parse(JSON.stringify(item));
  next.context.proposal.skeleton = out;
  next.context.proposal.candidate = {
    says:
      "SOME SLOTS BELOW ARE ALREADY FILLED AND EVERY ONE OF THEM IS A GUESS. They were written by " +
      "`tools/pregen.mjs` from the parameter type and the boundary's module and from nothing else — no line of " +
      "your function was read to produce them. They are here to be CONFIRMED against the source or REPLACED, " +
      "and confirming one means writing the `from.evidence` and `from.reading` beside it, which is the same " +
      "reading you would have done to author it. A candidate you accept without that reading is a value nobody " +
      "sourced, and it is indistinguishable from a correct one until stage 5.",
    filled: filled.length,
    slots: filled,
  };
  return { item: next, filled };
}

/** A whole packet document with every item filled, plus the receipt. */
export function pregenPacket(doc) {
  const pending = [];
  const filled = [];
  for (const item of doc?.pending ?? []) {
    const r = fillItem(item);
    pending.push(r.item);
    filled.push(...r.filled);
  }
  return { doc: { ...doc, pending }, filled };
}

/* ------------------------------------------------------------ the census */

/**
 * Every fill obligation in a directory of packets, by class.
 *
 * `args[].value | build` is counted as an ABSENT KEY rather than a sentinel,
 * because that is what it is: the skeleton gives an args entry its `from` and
 * no value at all. A census that only counted `<<DERIVE>>` would miss the 140
 * slots that hold the actual input.
 */
export function census(dir) {
  const by = new Map();
  const bump = (k) => by.set(k, (by.get(k) ?? 0) + 1);
  let skeletons = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const it of doc.pending ?? []) {
      const sk = it?.context?.proposal?.skeleton;
      if (!sk) continue;
      skeletons += 1;
      if (sk.rationale === DERIVE) bump("rationale (prose)");
      for (const a of sk.args ?? []) {
        if (a?.from?.evidence === DERIVE) bump("args[].from.evidence (file:line)");
        if (a?.from?.reading === DERIVE) bump("args[].from.reading (prose)");
        if (a?.value === undefined && a?.build === undefined) bump("args[].value | build (THE INPUT)");
      }
      for (const b of Object.values(sk.boundaries ?? {})) {
        if (b?.behaviour === DERIVE) bump("boundaries[].behaviour (prose)");
        if (b?.mock?.kind === DERIVE) bump("boundaries[].mock.kind (ENUM)");
        if (b?.from?.evidence === DERIVE) bump("boundaries[].from.evidence (file:line)");
        if (b?.from?.reading === DERIVE) bump("boundaries[].from.reading (prose)");
      }
    }
  }
  const total = [...by.values()].reduce((n, v) => n + v, 0);
  const derivable = (by.get("boundaries[].mock.kind (ENUM)") ?? 0) + (by.get("args[].value | build (THE INPUT)") ?? 0);
  return { skeletons, total, derivable, readingRequired: total - derivable, by: [...by].sort((a, b) => b[1] - a[1]) };
}

/* ------------------------------------------------------------- the score */

/**
 * The rules against answers that already landed AND validated.
 *
 * This is the half of the experiment that costs nothing, and it is deliberately
 * run before the half that costs $2 a packet. A rule whose candidate disagrees
 * with a validated answer two times in three is not a verification aid, it is a
 * distractor with a measured rate — and knowing that rate before dispatching is
 * the difference between a measurement and a hope.
 *
 * A packet is scored only when its RESERVED answer name is on disk, which is
 * `packet.answers.reserved` and nothing looser: a file the packet did not
 * reserve was written by some other packet and its rows answer other arms.
 */
export function scoreAgainst(packetsDir, proposalsDir) {
  const arg_ = { exact: 0, helperOnly: 0, wrong: 0, abstain: 0, misses: [] };
  const kind = { hit: 0, miss: 0, byClass: new Map(), misses: [] };
  let packets = 0;
  for (const f of readdirSync(packetsDir).filter((n) => n.endsWith(".json")).sort()) {
    const doc = JSON.parse(readFileSync(join(packetsDir, f), "utf8"));
    const reserved = doc?.packet?.answers?.reserved;
    if (!reserved || !existsSync(join(proposalsDir, reserved))) continue;
    let truth;
    try {
      truth = JSON.parse(readFileSync(join(proposalsDir, reserved), "utf8"));
    } catch {
      continue;
    }
    packets += 1;
    for (const it of doc.pending ?? []) {
      const sk = it?.context?.proposal?.skeleton;
      if (!sk) continue;
      const armId = (sk.covers ?? [])[0];
      const side = (Object.values(sk.reaches ?? {})[0] ?? [])[0];
      const t = (truth.proposals ?? []).find((r) => (r.covers ?? []).includes(armId) && ((r.reaches ?? {})[armId] ?? []).includes(side));
      if (!t) continue;
      const params = it?.context?.owner?.params ?? [];
      for (let i = 0; i < (sk.args ?? []).length; i += 1) {
        const ta = (t.args ?? [])[i];
        if (!ta) continue;
        const c = argCandidate(params[i]);
        if (!c) {
          arg_.abstain += 1;
          continue;
        }
        const mine = "build" in c ? String(c.build) : JSON.stringify(c.value);
        const theirs = ta.build !== undefined ? String(ta.build) : JSON.stringify(ta.value);
        const head = (s) => s.match(/^doubles\.\w+/)?.[0] ?? null;
        if (mine === theirs) arg_.exact += 1;
        else if (head(mine) && head(mine) === head(theirs)) {
          arg_.helperOnly += 1;
          arg_.misses.push({ packet: f, slot: `args[${i}]`, mine, theirs, how: "right helper, wrong content" });
        } else {
          arg_.wrong += 1;
          arg_.misses.push({ packet: f, slot: `args[${i}]`, mine, theirs, how: "wrong" });
        }
      }
      for (const [sym, b] of Object.entries(sk.boundaries ?? {})) {
        const tb = (t.boundaries ?? {})[sym];
        if (!tb) continue;
        const c = kindCandidate(b.module);
        if (!c) continue;
        const cls = moduleClass(b.module);
        const tk = tb?.mock?.kind ?? null;
        if (!kind.byClass.has(cls)) kind.byClass.set(cls, { hit: 0, miss: 0 });
        if (c.value === tk) {
          kind.hit += 1;
          kind.byClass.get(cls).hit += 1;
        } else {
          kind.miss += 1;
          kind.byClass.get(cls).miss += 1;
          kind.misses.push({ packet: f, slot: `boundaries[${sym}].mock.kind`, mine: c.value, theirs: tk });
        }
      }
    }
  }
  const argScored = arg_.exact + arg_.helperOnly + arg_.wrong;
  return {
    packetsScored: packets,
    args: { ...arg_, scored: argScored, exactRate: argScored ? arg_.exact / argScored : null, helperRate: argScored ? (arg_.exact + arg_.helperOnly) / argScored : null },
    kind: { ...kind, byClass: [...kind.byClass], rate: kind.hit + kind.miss ? kind.hit / (kind.hit + kind.miss) : null },
  };
}

/* ---------------------------------------------------------------- main */

function main() {
  const packetsDir = arg("--packets", "") ? resolve(arg("--packets")) : null;
  const one = arg("--packet", "") ? resolve(arg("--packet")) : null;
  if (!packetsDir && !one) {
    process.stderr.write(
      "✗ pregen: name what to fill.\n" +
        "  --packets <dir> --out <dir>            write a candidate copy of every packet\n" +
        "  --packets <dir> --score --truth <dir>  score the rules against answers that validated\n" +
        "  --packets <dir> --census               what a worker owes, by field class\n" +
        "  --packet <file> --json                 one packet's candidates, as data\n"
    );
    process.exit(2);
  }

  if (flag("--census")) {
    const c = census(packetsDir);
    if (flag("--json")) return log(JSON.stringify(c, null, 2));
    log(`${c.skeletons} skeleton(s) · ${c.total} fill obligation(s)`);
    for (const [k, n] of c.by) log(`  ${String(n).padStart(4)}  ${((100 * n) / c.total).toFixed(1).padStart(5)}%  ${k}`);
    log(`\n  mechanically approachable: ${c.derivable} (${((100 * c.derivable) / c.total).toFixed(1)}%)`);
    log(`  needs the function read:   ${c.readingRequired} (${((100 * c.readingRequired) / c.total).toFixed(1)}%)`);
    return undefined;
  }

  if (flag("--score")) {
    const truth = resolve(arg("--truth", ""));
    if (!truth || !existsSync(truth)) {
      process.stderr.write("✗ pregen: --score needs --truth <proposalsDir>, a directory of answers that already validated.\n");
      process.exit(2);
    }
    const s = scoreAgainst(packetsDir, truth);
    if (flag("--json")) return log(JSON.stringify(s, null, 2));
    log(`scored against ${s.packetsScored} packet(s) whose reserved answer is on disk`);
    log(`  args      exact ${s.args.exact} · right helper wrong content ${s.args.helperOnly} · wrong ${s.args.wrong} · abstained ${s.args.abstain}`);
    log(`            exact rate ${s.args.exactRate === null ? "—" : `${(100 * s.args.exactRate).toFixed(1)}%`} over ${s.args.scored} scored`);
    log(`  mock.kind hit ${s.kind.hit} · miss ${s.kind.miss} · rate ${s.kind.rate === null ? "—" : `${(100 * s.kind.rate).toFixed(1)}%`}`);
    for (const [cls, v] of s.kind.byClass) log(`            ${cls.padEnd(15)} ${v.hit}/${v.hit + v.miss}`);
    log("");
    for (const m of s.args.misses.slice(0, 8)) log(`  ${m.packet} ${m.slot} ${m.how}\n     wrote : ${m.mine}\n     landed: ${m.theirs}`);
    for (const m of s.kind.misses.slice(0, 8)) log(`  ${m.packet} ${m.slot}  wrote ${m.mine}  landed ${m.theirs}`);
    return undefined;
  }

  if (one) {
    const { doc, filled } = pregenPacket(JSON.parse(readFileSync(one, "utf8")));
    if (flag("--json")) return log(JSON.stringify({ packet: basename(one), filled, doc }, null, 2));
    log(`${basename(one)} · ${filled.length} candidate slot(s)`);
    for (const f of filled) log(`  ${f.path.padEnd(46)} ${String(f.wrote).slice(0, 60)}`);
    return undefined;
  }

  const out = resolve(arg("--out", ""));
  if (!out) {
    process.stderr.write("✗ pregen: --packets without --score or --census needs --out <dir> to write the candidate packets into.\n");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  let slots = 0;
  const only = arg("--only", "") ? arg("--only").split(",").map((s) => s.trim()).filter(Boolean) : null;
  for (const f of readdirSync(packetsDir).filter((n) => n.endsWith(".json")).sort()) {
    if (only && !only.includes(f) && !only.includes(f.replace(/\.json$/, ""))) continue;
    const { doc, filled } = pregenPacket(JSON.parse(readFileSync(join(packetsDir, f), "utf8")));
    writeFileSync(join(out, f), `${JSON.stringify(doc, null, 2)}\n`);
    slots += filled.length;
    log(`  ${f.padEnd(16)} ${String(filled.length).padStart(3)} candidate slot(s)`);
  }
  log(`\n${slots} candidate slot(s) written into ${out}`);
  return undefined;
}

if (import.meta.main === undefined) {
  throw new Error(`charpilot requires Node >= 24: import.meta.main is unavailable on ${process.version}`);
}
if (import.meta.main) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`✗ pregen: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}
