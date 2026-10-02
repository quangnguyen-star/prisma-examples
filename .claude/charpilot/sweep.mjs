#!/usr/bin/env node
/**
 * sweep — run inputs to find out which sides they light, before anything claims one.
 *
 * THE FAILURE THIS EXISTS TO REMOVE, in the numbers that paid for it. Five
 * measurements of notification-ms, across two models, local and container, and
 * every fix on this branch:
 *
 *   50.5%  52/103   20260920 local, claude-opus-5[1m]
 *   52.5%  42/80    PROD-resume,   claude-sonnet-5
 *   43.8%  32/73    PROD-resume2,  claude-sonnet-5
 *   54.2%  45/83    20260921T050441Z mid-run, container
 *   42.9%  36/84    20260921T050441Z final, container
 *
 * Every one of those is `path-not-taken`: the subject ran and the arm did not
 * move. They are not bad readings of behaviour. They are claims made WITHOUT
 * EVER RUNNING THE INPUT -- the agent writes `reaches`, `record` runs the row,
 * and stage 6 is the first thing that checks. A wrong claim then costs a full
 * record-and-measure cycle, a quarantine, and the same side back in the next
 * round's brief. message-templates on the identical image scored 0 of 76,
 * because its sides are pure functions over arguments where supplying the input
 * and reaching the side are one act; notification-ms is Express controllers over
 * integrations, where they are two.
 *
 * SO NOTHING HERE CLAIMS. A sweep row carries no `reaches` at all. It is run,
 * `record.mjs` reports which arms moved, and the sides it MOVED become the
 * claim. A false claim is not unlikely in this path, it is unrepresentable: the
 * claim is a transcript of a measurement that already happened.
 *
 * THE PRIMITIVES ARE ALREADY HERE and none of this is new machinery:
 *   `record.mjs --only <id>`   runs one row on its own (verify-on-write)
 *   row.armsMoved              [{armId, file, line, sides}] -- what actually lit
 *   row.movedBranchesBeforeSubject   what setup lit, which is NOT the input's
 *   row.subjectCallStarted     whether the call ran at all
 *
 * ONE FULL SWEEP, THEN ONLY WHAT IS NEW. The domain is values per parameter
 * NAME and TYPE, and those come from `scan.json`, which does not change between
 * rounds -- so re-sweeping the same domain over the same sides lights exactly
 * what it lit the first time, and every row is a real execution. The full sweep
 * therefore runs once, before round 1, when every side is still open and the
 * yield is at its maximum. After that a sweep runs only over domain values that
 * were ADDED since the last one, against sides still open. A round that learns
 * nothing new sweeps nothing.
 *
 * WHEN THE DOMAIN STALLS IT IS RE-ASKED. An incremental sweep that lights no
 * side means the domain has nothing left to offer those sides, not that the
 * sides are unreachable -- so `stalled()` names them and the agent is asked to
 * extend the domain for those specific sides. That is the difference between
 * this and `frontdoor.mjs`, which derives values by RULE and is measured at
 * 0.27% of instrumented open sides (26 of 9,617 over six work lists) precisely
 * because a rule can only answer a side whose input follows from syntax.
 *
 * WHAT IT MUST NOT SPEND EXECUTIONS ON. Run `20260921T050441Z` named four
 * sides in `slackAuth.service.ts#handleCallback` that no input can reach:
 *
 *   blocked egress: https.request to slack.com - no boundary declared for it,
 *   so recording would need a real call to a default-deny endpoint
 *
 * Those are structurally unreachable under the sandbox's egress policy, not
 * merely unsolved. A sweep that does not exclude them burns a real execution per
 * candidate on each, forever, and lights nothing. They want a BLOCKED.md reason,
 * which is what the pipeline has been asking for.
 */

/**
 * The question put to the agent: one row per parameter the open sides depend on.
 *
 * NAMES AND TYPES ONLY, and no source. The agent is being asked what values a
 * parameter of this name and this type plausibly takes -- `tenant: string` wants
 * "ptp" and "" and a tenant that does not exist; `userAgent: string | null`
 * wants null. That is a question about vocabulary, not about behaviour, and
 * answering it from the signature is the whole reason it is cheap.
 *
 * GROUPED BY name+type, not per function. `tenant: string` appearing in nine
 * controllers is one question, and asking it nine times is nine times the cost
 * for one answer. The functions that wanted it are listed so the answer can be
 * aimed, and `sides` counts what is waiting on it so the agent can spend its
 * effort where the arms are.
 */
export function domainBrief(items) {
  const byKey = new Map();
  for (const item of items ?? []) {
    const params = item.owner?.params ?? [];
    const open = (item.uncoveredSides ?? []).length;
    if (!open) continue;
    for (const p of params) {
      if (!p?.name) continue;
      const type = p.type ?? "unknown";
      const key = `${p.name}:${type}`;
      const row = byKey.get(key) ?? {
        name: p.name,
        type,
        optional: Boolean(p.optional),
        functions: new Set(),
        sides: 0,
      };
      row.functions.add(item.owner?.functionId ?? item.file);
      row.sides += open;
      byKey.set(key, row);
    }
  }
  // MOST-WANTED FIRST. The order is the spending advice: a parameter 40 open
  // sides are waiting on is worth more thought than one that gates a single
  // arm, and a brief that lists them alphabetically hides that.
  return [...byKey.values()]
    .map((r) => ({ ...r, functions: [...r.functions].sort() }))
    .sort((a, b) => b.sides - a.sides || a.name.localeCompare(b.name));
}

/**
 * A domain document is REFUSED unless every entry is usable, and each refusal
 * names the entry rather than the file.
 *
 * WHY REFUSE AT ALL, when a bad entry could just be skipped. Because a domain
 * that silently holds fewer values than it was written with produces a sweep
 * that lights fewer sides than it could, reports a number, and looks like a
 * measurement of the idea rather than of the typo. That is the same shape as
 * `5a438f4`'s `byFailure=[object Object]`: the work was done and the reporting
 * lost it. An empty `values` is the one that matters most -- it reads as "this
 * parameter was considered and has no interesting values", which is a claim.
 */
export function validateDomain(doc) {
  const problems = [];
  if (!doc || typeof doc !== "object") return ["the domain is not an object"];
  const entries = doc.domain;
  if (!Array.isArray(entries)) return ["`domain` is missing or not an array"];
  if (!entries.length) problems.push("`domain` is empty — nothing to sweep");
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = `domain[${i}]`;
    if (!e || typeof e !== "object") { problems.push(`${at} is not an object`); return; }
    if (!e.name || typeof e.name !== "string") problems.push(`${at} has no \`name\``);
    if (!Array.isArray(e.values)) { problems.push(`${at} (${e.name}) has no \`values\` array`); return; }
    if (!e.values.length) {
      problems.push(
        `${at} (${e.name}) has an EMPTY \`values\` array — that reads as "considered, nothing interesting", ` +
          `which is a claim. Give it values or leave the entry out`
      );
    }
    const key = `${e.name}:${e.type ?? "unknown"}`;
    if (seen.has(key)) problems.push(`${at} repeats ${key} — one entry per name and type`);
    seen.add(key);
  });
  return problems;
}

/**
 * The cross product, CAPPED and SAMPLED DETERMINISTICALLY.
 *
 * A function of four parameters with five values each is 625 rows and every row
 * is a real execution. So the product is bounded by `cap` and, when it is over,
 * thinned by a fixed stride rather than at random: two sweeps of one domain over
 * one function produce the SAME rows, because a sweep whose rows move between
 * runs cannot be compared with the one before it, and comparability is the only
 * way to tell a domain that improved from a domain that got luckier. `d5542e1`
 * bought that lesson on brief bytes; it is the same lesson.
 *
 * FIRST VALUE OF EVERY PARAMETER IS ROW 0. Whatever the agent put first is the
 * one it thought most likely, so the cheapest row is the one it would have
 * written by hand, and a cap of 1 is a useful sweep rather than an arbitrary
 * corner of the product.
 */
export function generateInputs(params, domain, { cap = 24 } = {}) {
  const byName = new Map();
  for (const e of domain?.domain ?? []) byName.set(e.name, e.values);

  const axes = [];
  for (const p of params ?? []) {
    const values = byName.get(p?.name);
    // A parameter with no domain entry is held at a single `undefined`: the
    // sweep is about the parameters the agent had something to say about, and
    // inventing values for the rest is exactly the fabrication this pipeline
    // refuses.
    axes.push({ name: p?.name, values: values?.length ? values : [undefined] });
  }
  if (!axes.length) return [];

  const total = axes.reduce((n, a) => n * a.values.length, 1);
  const stride = total > cap ? Math.ceil(total / cap) : 1;
  const rows = [];
  for (let i = 0; i < total && rows.length < cap; i += stride) {
    let rest = i;
    const args = {};
    for (const a of axes) {
      args[a.name] = a.values[rest % a.values.length];
      rest = Math.floor(rest / a.values.length);
    }
    rows.push({ index: i, args });
  }
  return rows;
}

/**
 * What an input ACTUALLY lit, from the row `record.mjs` wrote for it.
 *
 * SETUP IS SUBTRACTED, and this is the half that makes the result a measurement
 * of the input rather than of the fixture. `movedBranchesBeforeSubject` is every
 * branch the harness moved getting ready -- doubles being installed, a config
 * being read, the module importing. Crediting those to the input would bank
 * sides the input had nothing to do with, and the next round would find them
 * uncovered again with a passing row on disk claiming otherwise: a false claim
 * arriving through the one path built to make false claims impossible.
 *
 * A ROW WHOSE SUBJECT NEVER RAN LIGHTS NOTHING, whatever moved. `subjectCallStarted`
 * false means the harness failed before the call -- a wrong argument shape, a
 * throw in setup. Arms moved on the way to that failure are not this input's
 * work, and reporting them would make a broken row look productive.
 */
export function harvest(row) {
  if (!row || row.subjectCallStarted !== true) return [];
  const before = row.movedBranchesBeforeSubject ?? {};
  const out = [];
  for (const moved of row.armsMoved ?? []) {
    if (!moved?.armId || !Array.isArray(moved.sides) || !moved.sides.length) continue;
    // The before-subject map is keyed by file and then by istanbul's branch
    // index, which is not the armId — so it cannot be compared side by side.
    // What it CAN do is say "this file moved nothing before the subject", and
    // for a file with no setup movement at all every arm that moved is the
    // input's. Where setup did move branches in that file, the arm is reported
    // with `afterSetupOnly: false` and the caller decides; this file does not
    // guess which of the two it was.
    const setupTouched = Object.keys(before[moved.file] ?? {}).length > 0;
    out.push({
      armId: moved.armId,
      file: moved.file,
      line: moved.line,
      sides: [...moved.sides],
      afterSetupOnly: !setupTouched,
    });
  }
  return out;
}

/**
 * Sides a sweep must not spend an execution on, and why each one.
 *
 * `record.mjs` already says both of these; nothing here decides anything. An
 * egress-blocked side is structurally unreachable under the sandbox policy --
 * four of them on `slackAuth.service.ts#handleCallback` in run
 * `20260921T050441Z` -- and a covered side has nothing left to light.
 */
export function excluded(items, { blocked = [], covered = [] } = {}) {
  const blockedSides = new Set(blocked.map((b) => b.side ?? b));
  const coveredSides = new Set(covered);
  const skip = [];
  for (const item of items ?? []) {
    for (const side of item.uncoveredSides ?? []) {
      const key = `${item.armId}[${side}]`;
      if (blockedSides.has(key) || blockedSides.has(side)) {
        skip.push({ key, why: "blocked egress — no boundary declared, so no input can reach it" });
      } else if (coveredSides.has(key)) {
        skip.push({ key, why: "already covered — nothing left to light" });
      }
    }
  }
  return skip;
}

/**
 * The domain has nothing left for these sides, so the agent is asked again.
 *
 * NOT "unreachable". A sweep that lights nothing has established one thing
 * only: no combination of the values currently in the domain moved these arms.
 * That is a statement about the domain. Calling it unreachable would close a
 * side the next handful of values might open, and `not_exercised_because` is the
 * field that exists for sides that genuinely cannot be reached.
 */
export function stalled(sweptSides, lit) {
  const hit = new Set();
  for (const h of lit ?? []) for (const s of h.sides ?? []) hit.add(`${h.armId}[${s}]`);
  return (sweptSides ?? []).filter((k) => !hit.has(k));
}

/**
 * `via`, in the one form a sweep can honestly declare — or null, meaning skip.
 *
 * The work list's `via` is an OBJECT; a proposal's is a STRING, and
 * `validate.mjs` refuses one that does not match what the scan resolved. Two
 * forms are declarable from a name-derived candidate:
 *
 *   already a string        pass it through
 *   {kind: "trigger", ...}  `trigger:<trigger>`
 *
 * Everything else is a function with NO OWN ENTRY: reaching its arm means
 * driving the CALLER, so the input has to be built from the caller's
 * parameters, not this function's. A sweep over this function's names cannot
 * reach it, and saying otherwise would put a row on disk whose `via` the scan
 * contradicts. Measured on notification-ms: 164 of 461 candidate rows are this
 * shape, and it is the same `no-own-entry` gate that took 419 of
 * `frontdoor.mjs`'s 888 recognisable sides.
 */
export function viaOf(item) {
  const v = item?.via;
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && v.kind === "trigger" && v.trigger) return `trigger:${v.trigger}`;
  if (v === null || v === undefined) return null;
  return undefined; // a driver form: not declarable here
}

/**
 * A parameter the service will CALL: `next: NextFunction`, `cb: Function`,
 * `(err) => void`. Judged from the type text, the same thing the domain was.
 */
export function functionTyped(type) {
  return /Function\b|=>/.test(String(type ?? ""));
}

/**
 * The domain values for a parameter the service will call, as FUNCTIONS.
 *
 * The domain is written as JSON, so `"() => {}"` arrives as a string, and
 * `renderValue` renders a string as a string literal: nginx's `next` got
 * null, 0, "not-a-function" and "() => {}" and not one function. express-jwt
 * then called it from setImmediate, after the row had settled, and 24 of 57
 * sweep rows on the jwt bench threw "next is not a function" -- a row the
 * recorder now marks and the sweep refuses to bank, so every one was an
 * execution spent for nothing. A non-function handed to a callee that calls
 * it measures only the crash, and the crash is after the window closes.
 *
 * So: the domain's function-shaped strings become code (`__fn__` + source,
 * rendered as a `build`), a no-op is added when there are none, and a value
 * that is not a function is dropped for this parameter.
 */
export function functionValues(vals) {
  const fns = (vals ?? []).filter((v) => typeof v === "string" && /^\s*(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(v) && !/\bvalue\b/.test(v));
  return (fns.length ? fns : ["() => undefined"]).map((v) => ({ __fn__: v }));
}

/**
 * The source text `record.mjs` evaluates for one candidate value, or null.
 *
 * `value` is a literal the emitter substitutes; `build` is an expression stage 4
 * evaluates. An object or array has to be a `build`, and `validate.mjs` reserves
 * the bare identifier `value` inside one — so a candidate whose JSON text
 * carries that word is DROPPED rather than rewritten. Rewriting it would change
 * what the agent said the value was.
 */
export function renderValue(v) {
  if (v === "__undefined__") return { build: "undefined" };
  // A function for a parameter the service calls (see `functionValues`).
  if (v !== null && typeof v === "object" && typeof v.__fn__ === "string") return { build: `(${v.__fn__})` };
  if (v !== null && typeof v === "object") {
    const text = JSON.stringify(v);
    if (/\bvalue\b/.test(text)) return null;
    return { build: text };
  }
  return { value: JSON.stringify(v) };
}

/**
 * Candidate proposals for the sweep, from the work list and the domain.
 *
 * NO `reaches`, WHICH IS THE WHOLE DESIGN. A candidate claims nothing. It is
 * run, `record.mjs` reports `armsMoved`, and only the sides that MOVED are
 * turned into a claim afterwards. `validate.mjs` does not require `reaches`, so
 * a claimless row is representable and a false claim on this path is not.
 *
 * WHAT THE PROVENANCE SAYS, and it says it straight. `validate.mjs` demands
 * `from.arm` and `from.evidence` on every value because "an unsourced value is
 * a fabricated value". A name-derived candidate was not read off an arm, so the
 * citation names the arm it is AIMED AT, the arm's own line as the evidence, and
 * a `reading` that says in words that this is a sweep candidate and not a
 * reading of anything. A reviewer who sees the row knows which it is.
 */
export function toProposals(items, domain, { cap = 3, idFor } = {}) {
  const values = new Map();
  for (const e of domain?.domain ?? []) if (!values.has(e.name)) values.set(e.name, e.values);

  const out = [];
  const skipped = { noEntry: 0, noParams: 0, unrenderable: 0, noDomain: 0 };
  for (const item of items ?? []) {
    if (!(item.uncoveredSides ?? []).length) continue;
    const params = item.owner?.params ?? [];
    if (!params.length) { skipped.noParams += 1; continue; }
    if (!params.every((p) => values.has(p?.name))) { skipped.noDomain += 1; continue; }
    const via = viaOf(item);
    if (via === undefined) { skipped.noEntry += 1; continue; }

    const axes = params.map((p) => (functionTyped(p.type) ? functionValues(values.get(p.name)) : values.get(p.name)));
    const total = axes.reduce((n, a) => n * a.length, 1);
    const stride = total > cap ? Math.ceil(total / cap) : 1;
    for (let i = 0, made = 0; i < total && made < cap; i += stride) {
      let rest = i;
      const args = [];
      let ok = true;
      for (const axis of axes) {
        const rendered = renderValue(axis[rest % axis.length]);
        rest = Math.floor(rest / axis.length);
        if (!rendered) { ok = false; break; }
        args.push({
          ...rendered,
          from: {
            arm: item.armId,
            evidence: `${item.file}:${item.line}`,
            reading:
              "SWEEP CANDIDATE. This value was derived from the parameter's NAME and TYPE, not read off this arm. " +
              "It claims nothing: the row carries no `reaches`, and only the arms it is measured to move become a claim.",
          },
        });
      }
      if (!ok) { skipped.unrenderable += 1; continue; }
      made += 1;
      out.push({
        id: idFor ? idFor(item, i) : `sweep-${item.armId}-${i}`,
        functionId: item.owner.functionId,
        via,
        lane: item.lane ?? "unit",
        covers: [item.armId],
        args,
        invoke: null,
        setup: [],
        boundaries: {},
      });
    }
  }
  return { proposals: out, skipped };
}

/**
 * The sides a sweep measured, as a claim per arm — the only place `reaches` is
 * written on this path, and it is written from `armsMoved` and nothing else.
 */
export function claimsFrom(rows) {
  const byArm = new Map();
  for (const row of rows ?? []) {
    for (const hit of harvest(row)) {
      const set = byArm.get(hit.armId) ?? new Set();
      for (const side of hit.sides) set.add(side);
      byArm.set(hit.armId, set);
    }
  }
  return [...byArm.entries()].map(([armId, sides]) => ({ armId, sides: [...sides] }));
}

/**
 * THE ROWS THAT LIT AN OPEN SIDE, AS PROPOSALS -- the half of "only the sides
 * that MOVED become the claim" that was never written.
 *
 * Until this, `harvestMain` recorded the candidates, deleted
 * `sweep-candidates.json`, and reported `lit` into sweep.json, which nothing
 * reads. So the sweep's measurement was thrown away: `behaviour.json` held rows
 * with no proposal behind them, determinism compared 0 of them, emit wrote no
 * suite, measure read 0, and derive dealt every side -- the 20 the sweep had
 * already lit on nginx-redirecting-ms (run 20260924T091852Z, 13% of the big
 * round) included.
 *
 * WHAT A BANKED ROW CLAIMS: exactly the open sides its recording moved after
 * setup, and nothing else. `reaches` is the transcript of `armsMoved`, so it
 * cannot be false; `covers` is those arms; each value's `from` names the first
 * arm it lit and says in words that the value was measured, not read.
 *
 * WHAT IS NOT BANKED, and why:
 *   - an arm the harness also moved during setup (`afterSetupOnly: false`):
 *     `harvest` cannot tell which half moved it, so it is not claimed;
 *   - a side an earlier banked row already lit: one row per side is enough;
 *   - an arm another function owns, UNLESS the scan says that owner is reached
 *     through the function this row drove. A row driving `jwtHandler` also
 *     lights its callee `getNextAuthCookieName` and the callback it hands
 *     `expressjwt` (nginx bench, 2026-09-24); validate.mjs refuses a row that
 *     covers an arm its `functionId` does not own, and asks for `via` naming
 *     the driver on one with no own entry. So each such owner gets its own
 *     row, `functionId` the owner and `via` the driver -- which is how the
 *     recording reached it. Any other owner's sides go to derive as before,
 *     counted in `otherOwner`;
 *   - a row whose recording was not CLEAN: not invoked, a harness error, a
 *     blocked egress attempt, or a throw or rejection after it settled. What
 *     it lit happened under an arrangement the service never runs in, or the
 *     suite emitted from it fails (nginx bench: `next: null` to jwtHandler
 *     threw from express-jwt's setImmediate), and `withheld` says how many.
 *
 * AND ITS BOUNDARIES ARE ANSWERED AS WHAT THE RECORDING DID. A candidate
 * answers no boundary, so validate.mjs would warn on every required one, and
 * the round boundary quarantines every warned row whenever ANY row in the
 * directory fails -- most early rounds. A clean recording ran each boundary
 * for real (mocked mode denies only egress and the database, and a clean row
 * touched neither), so each is answered `passthrough`, saying so: the answer
 * is a description of the recording, not a new arrangement. On nginx that is
 * 12 of 20 lit sides, all behind the local `formatDate` helper, that a
 * strict "no required boundary" rule would have withheld.
 */
export function litProposals(candidates, rows, items, { already = [] } = {}) {
  const byId = new Map((candidates ?? []).map((p) => [p.id, p]));
  const itemByArm = new Map((items ?? []).map((i) => [i.armId, i]));
  const open = new Set();
  for (const item of items ?? []) for (const side of item.uncoveredSides ?? []) open.add(`${item.armId}[${side}]`);
  const taken = new Set();
  for (const p of already) for (const [armId, sides] of Object.entries(p.reaches ?? {})) for (const s of sides) taken.add(`${armId}[${s}]`);
  const required = (item) => (item?.boundaries ?? []).filter((b) => b?.symbol && !b.advisory && !b.typeOnly);
  // A throw or rejection after the row settled breaks the suite emitted from it
  // (vitest exits 1 on an uncaught error), so that row is not clean either.
  const clean = (row) =>
    row.invoked === true && !row.harnessError && !(row.egressAttempts ?? []).length &&
    !(row.unhandledRejections ?? []).length && !(row.uncaughtAfterSettle ?? []).length;
  const banked = [];
  const withheld = new Set();
  // Distinct sides, not per-row hits: 57 rows over one driver light the same
  // callee arms over and over.
  const otherOwner = new Set();
  // Does `item`'s owner name `driver` as the function that reaches it?
  const drivenBy = (item, driver) => {
    const v = item?.via;
    return !!v && typeof v === "object" && (v.driver === driver || (v.drivers ?? []).includes(driver));
  };
  for (const row of rows ?? []) {
    const cand = byId.get(row.id);
    if (!cand) continue;
    // Grouped by OWNER. The driven function's own arms make one row; an owner
    // the scan says is reached THROUGH that driver (a module-private callee, a
    // nested callback) makes its own row with `via` naming the driver -- the
    // form validate.mjs asks for, and exactly how this recording drove it.
    const byOwner = new Map();
    for (const hit of harvest(row)) {
      if (!hit.afterSetupOnly) continue;
      const item = itemByArm.get(hit.armId);
      const owner = item?.owner?.functionId;
      const sides = hit.sides.filter((s) => open.has(`${hit.armId}[${s}]`) && !taken.has(`${hit.armId}[${s}]`));
      if (!sides.length) continue;
      if (owner !== cand.functionId && !drivenBy(item, cand.functionId)) {
        for (const side of sides) otherOwner.add(`${hit.armId}[${side}]`);
        continue;
      }
      if (!byOwner.has(owner)) byOwner.set(owner, {});
      byOwner.get(owner)[hit.armId] = sides;
    }
    if (!byOwner.size) continue;
    if (!clean(row)) {
      for (const reaches of byOwner.values()) for (const [a, ss] of Object.entries(reaches)) for (const x of ss) withheld.add(`${a}[${x}]`);
      continue;
    }
    let n = 0;
    for (const [owner, reaches] of byOwner) {
      const arms = Object.keys(reaches);
      for (const a of arms) for (const s of reaches[a]) taken.add(`${a}[${s}]`);
      const first = itemByArm.get(arms[0]);
      const cite = { arm: arms[0], evidence: `${first?.file ?? ""}:${first?.line ?? ""}` };
      const boundaries = { ...(cand.boundaries ?? {}) };
      for (const item of [itemByArm.get(cand.covers?.[0]), ...arms.map((a) => itemByArm.get(a))]) {
        for (const b of required(item)) {
          if (boundaries[b.symbol]) continue;
          boundaries[b.symbol] = {
            module: b.module,
            imported: b.imported,
            behaviour: "not substituted: the sweep's recording of this row ran the real one, and that recording is what the claim is",
            mock: { kind: "passthrough" },
            from: { ...cite, reading: "SWEEP, MEASURED. The recording ran this boundary for real; passthrough says so." },
          };
        }
      }
      const own = owner === cand.functionId;
      banked.push({
        ...cand,
        id: String(cand.id).replace(/^sweep-/, "sweep-lit-") + (own ? "" : `-via-${++n}`),
        functionId: owner,
        ...(own ? {} : { via: cand.functionId }),
        covers: arms,
        reaches,
        boundaries,
        args: (cand.args ?? []).map((a) => ({
          ...a,
          from: {
            arm: arms[0],
            evidence: cite.evidence,
            reading:
              "SWEEP, MEASURED. This value was derived from the parameter's NAME and TYPE, and its recording moved " +
              `${arms.map((x) => `${x} [${reaches[x].join(", ")}]`).join("; ")} after setup` +
              (own ? "" : `, driving ${cand.functionId}`) +
              ". The claim is that measurement, nothing more.",
          },
        })),
        rationale: "Banked by sweep.mjs from armsMoved: every side in `reaches` was measured moving on this row's own recording.",
      });
    }
  }
  // A side another function owns that this harvest ALSO banked through its own
  // driver is not "left to derive".
  for (const k of taken) { otherOwner.delete(k); withheld.delete(k); }
  return { banked, withheld: withheld.size, otherOwner: otherOwner.size };
}

// ---------------------------------------------------------------------------
// THE CLI, WHICH IS WHERE EVERY WRITE LIVES.
//
// `steps.never-repair-a-tools-output` forbids a step from writing an artifact:
// a step that writes can repair a tool's output instead of refusing on it, and
// its `satisfied` then reads its own writing back. So `steps/sweep.mjs` reads
// and spawns, and this half generates, records and reports.
// ---------------------------------------------------------------------------
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

import { OUT_DIR, PROPOSALS_DIR, WORKLIST_JSON } from "./config.mjs";

/**
 * THE DOMAIN IS AN ANSWER, SO IT LIVES WHERE ANSWERS LIVE.
 *
 * The first version named `out/sweep-domain.json` as the destination and run
 * `20260921T114243Z` showed what that costs: every packet's `answers` block
 * tells the agent "You never write under `.claude/`. … they are addresses to
 * READ", so the ask pointed at a path the agent had been forbidden on every
 * other item. It spent its turns searching instead --
 * `grep -rl "sweep" .claude/charpilot`,
 * `grep -rl "sweep-domain" /opt/characterize/claude/skills/`, `FLEETCHECK.md`
 * -- which is the same reading-charpilot's-own-source cost this pipeline has
 * already measured at 25% of one run's calls.
 *
 * `charpilot-answers/` is the one directory the agent writes, for every other
 * submission, and the tools read. The domain is a submission like any other.
 * `out/` is still read as a fallback so a domain placed there by hand, as this
 * one was during the measurement, is not ignored.
 */
const ANSWERS_DIRNAME = "charpilot-answers";
const DOMAIN_BASENAME = "sweep-domain.json";
const SWEEP_DOMAIN = join(OUT_DIR, DOMAIN_BASENAME);
const SWEEP_DOMAIN_ANSWER = join(OUT_DIR, "..", "..", "..", ANSWERS_DIRNAME, DOMAIN_BASENAME);
const domainDoc = () => readJson(SWEEP_DOMAIN_ANSWER) ?? readJson(SWEEP_DOMAIN);
const SWEEP_JSON = join(OUT_DIR, "sweep.json");
/** Where the sweep banks the rows that lit an open side (`litProposals`). */
export const SWEEP_LIT_BASENAME = "sweep-lit.json";
const HELD_DIR = join(OUT_DIR, "sweep-held");
const SWEEP_ASKS = join(OUT_DIR, "sweep-asks.json");

/**
 * THE RATCHET, because a step with no give-up condition asks for ever.
 *
 * `satisfied` is `out/sweep.json` exists. If the agent never writes the domain,
 * nothing ever writes that report, the walk asks again next round, and a
 * three-hour run spends every round on one unanswered question and never
 * reaches `derive`. `derive` has `withRepeatRatchet` for exactly this; this
 * step had nothing.
 *
 * So each ask is COUNTED, and past the cap the sweep reports itself skipped and
 * the walk moves on. The domain is an optimisation: a run without it is the run
 * this pipeline already had, which is worth strictly more than a run that
 * cannot start.
 */
function askMain() {
  const cap = Number(process.env.CHARPILOT_SWEEP_ASKS ?? 3);
  const prior = readJson(SWEEP_ASKS)?.asks ?? 0;
  const asks = prior + 1;
  writeFileSync(SWEEP_ASKS, JSON.stringify({ asks, cap }, null, 1));
  if (asks > cap) {
    writeFileSync(
      SWEEP_JSON,
      JSON.stringify(
        {
          stage: "3-sweep",
          skipped: `asked for the value domain ${asks - 1} time(s) and ${ANSWERS_DIRNAME}/${DOMAIN_BASENAME} was never written`,
          candidates: 0,
          lit: [],
          closedOpen: [],
        },
        null,
        1
      )
    );
    process.stdout.write(`! sweep skipped: no domain after ${asks - 1} ask(s) — the walk goes on to derive\n`);
    return 0;
  }
  process.stdout.write(`… sweep: ask ${asks} of ${cap} for the value domain\n`);
  return 0;
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Generate, run, harvest, report — and put the agent's rows back whatever
 * happens.
 *
 * `record.mjs` reads the proposals directory, so the candidates have to be in
 * it while they run. The agent's files are copied aside first and restored in a
 * `finally`: a sweep must not be able to lose them, and the 85 answers and 56
 * proposals on the notification-ms checkout are what that sentence is about.
 */
function harvestMain() {
  const items = readJson(WORKLIST_JSON)?.items ?? [];
  const domain = domainDoc();

  const problems = domain ? validateDomain(domain) : [`no domain document at ${ANSWERS_DIRNAME}/${DOMAIN_BASENAME}`];
  if (problems.length) {
    writeFileSync(SWEEP_JSON, JSON.stringify({ stage: "3-sweep", refused: problems, candidates: 0, lit: [], closedOpen: [] }, null, 1));
    process.stdout.write(`✗ sweep refused: ${problems.slice(0, 3).join("; ")}\n`);
    return 1;
  }

  const cap = Number(process.env.CHARPILOT_SWEEP_CAP ?? 3);
  const { proposals, skipped } = toProposals(items, domain, {
    cap: Number.isFinite(cap) && cap > 0 ? cap : 3,
    idFor: (item, i) => `sweep-${String(item.armId).replace(/[^a-zA-Z0-9]+/g, "-")}-${i}`,
  });

  if (!proposals.length) {
    writeFileSync(SWEEP_JSON, JSON.stringify({ stage: "3-sweep", candidates: 0, lit: [], closedOpen: [], skipped }, null, 1));
    process.stdout.write("✓ sweep: no candidate row could be built, so nothing was run\n");
    return 0;
  }

  const existing = existsSync(PROPOSALS_DIR) ? readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json")) : [];
  mkdirSync(HELD_DIR, { recursive: true });
  let status = 0;
  try {
    for (const f of existing) writeFileSync(join(HELD_DIR, f), readFileSync(join(PROPOSALS_DIR, f)));
    for (const f of existing) rmSync(join(PROPOSALS_DIR, f));
    writeFileSync(
      join(PROPOSALS_DIR, "sweep-candidates.json"),
      JSON.stringify(
        {
          stage: "3-proposals",
          authoredBy: "sweep",
          note:
            "SWEEP CANDIDATES. Values derived from parameter names and types. NO `reaches` is claimed on any row: " +
            "these are run so that `armsMoved` can say which sides they actually light.",
          proposals,
        },
        null,
        1
      )
    );
    const record = join(OUT_DIR, "..", "record.mjs");
    try {
      execFileSync(process.execPath, [record, "--fresh"], { stdio: "inherit" });
    } catch {
      status = 0; // a row that would not run is data, not a failure of the sweep
    }
  } finally {
    rmSync(join(PROPOSALS_DIR, "sweep-candidates.json"), { force: true });
    for (const f of existing) writeFileSync(join(PROPOSALS_DIR, f), readFileSync(join(HELD_DIR, f)));
    rmSync(HELD_DIR, { recursive: true, force: true });
  }

  const behaviour = readJson(join(OUT_DIR, "behaviour.json")) ?? readJson(join(OUT_DIR, "behaviour-partial.json"));
  const rows = behaviour?.rows ?? [];
  const lit = claimsFrom(rows);
  // BANKED, so what the sweep measured reaches record, emit, measure and the
  // deal (see `litProposals`). Merged with an earlier harvest's rows, never
  // replacing them: an incremental sweep adds sides, it does not forget any.
  const litFile = join(PROPOSALS_DIR, SWEEP_LIT_BASENAME);
  const earlier = readJson(litFile)?.proposals ?? [];
  const { banked, withheld, otherOwner } = litProposals(proposals, rows, items, { already: earlier });
  if (banked.length) {
    writeFileSync(
      litFile,
      JSON.stringify(
        {
          stage: "3-proposals",
          authoredBy: "sweep",
          note:
            "SWEEP, MEASURED. Each row's `reaches` is exactly the open sides its own recording moved after setup " +
            "(sweep.mjs litProposals). Written by the sweep, not by an agent.",
          proposals: [...earlier, ...banked],
        },
        null,
        1
      )
    );
  }
  const open = new Set();
  for (const item of items) for (const side of item.uncoveredSides ?? []) open.add(`${item.armId}[${side}]`);
  const closedOpen = lit.flatMap((c) => c.sides.map((s) => `${c.armId}[${s}]`)).filter((k) => open.has(k));
  const sweptSides = [...new Set(proposals.map((p) => p.covers[0]))].flatMap((armId) =>
    [...open].filter((k) => k.startsWith(`${armId}[`))
  );

  writeFileSync(
    SWEEP_JSON,
    JSON.stringify(
      {
        stage: "3-sweep", candidates: proposals.length, recorded: rows.length, lit, closedOpen, stalled: stalled(sweptSides, lit), skipped,
        banked: { rows: banked.length, sides: banked.reduce((n, p) => n + Object.values(p.reaches).flat().length, 0), withheld, otherOwner, file: SWEEP_LIT_BASENAME },
      },
      null,
      1
    )
  );
  process.stdout.write(
    `✓ sweep: ${closedOpen.length} of ${open.size} open side(s) lit by ${proposals.length} row(s), none claimed; ` +
      `banked ${banked.length} row(s) into proposals/${SWEEP_LIT_BASENAME}` +
      (withheld ? `, ${withheld} lit side(s) withheld (their recording was not clean: not invoked, a harness error, blocked egress, or a throw after settle)` : "") +
      (otherOwner ? `, ${otherOwner} lit side(s) left to derive (owned by a function other than the one the row drives)` : "") +
      "\n"
  );
  return status;
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  const argv = process.argv;
  const code = argv.includes("--harvest")
    ? await harvestMain()
    : argv.includes("--asked")
      ? askMain()
      : (process.stdout.write("usage: sweep.mjs --harvest | --asked\n"), 2);
  process.exit(code);
}
