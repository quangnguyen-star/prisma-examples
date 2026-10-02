/**
 * repair — the sides that came back still uncovered, handed round again.
 *
 * THIS IS THE PHASE THAT PRODUCES COVERAGE. A run that derives inputs and never
 * reassesses them lands on the repo's existing baseline: run `20260916T024808Z`
 * checked nine claims without reassessment and reported 62.7% against a
 * `baseline.json` of 60.21%; the run that did reassess reached 96.7%. An
 * earlier attempt to convert this pack to a tool-driven shape dropped this
 * phase and the coverage went with it. So a defect here does not look like a
 * crash — it looks like a run that finishes and reports the baseline.
 *
 * Like `derive`, this is the MACHINE HALF only. A tool can say which side did
 * not land and quote every observation made about it; only a turn can look at
 * an argument and a boundary answer and say which of them was wrong. Nothing
 * here writes a proposal, a declaration or an artifact of any kind.
 *
 * WHAT IT READS, AND FROM WHOSE HANDS.
 *
 *   out/coverage.json     coverage.mjs:686 — the join. `stillUncovered` is
 *                         every side neither the suite nor these inputs
 *                         reached; `falseClaims`, `verified` and `unmeasurable`
 *                         are what became of each `reaches` sentence.
 *   out/behaviour.json    record.mjs:2513 — what the recorder OBSERVED, per
 *                         row: `args` as built, `boundaryCalls` as applied,
 *                         `armsMoved`, and its own `claimVerdicts`.
 *   out/worklist.json     worklist.mjs — the arm, its source, its owner's entry
 *                         recipe and its side labels.
 *   proposals/            the inputs, so an item names the document to edit.
 *
 * It restates none of them. `context` is assembled out of their own rows, for
 * the reason derive.mjs gives at length: three of the skeleton's fields are
 * join keys `validate.mjs` matches byte-exactly, and a restatement is not a
 * duplicate, it is a silent mis-join waiting to happen.
 *
 * THE FOUR KINDS ARE A ROUTING HINT and the evidence is identical on all of
 * them, so a mis-kinded item costs attention and never an answer:
 *
 *   unreached          the input ran and the arm it named stayed uncovered.
 *   false-claim        the input reached AN arm and not the one it claimed.
 *                      The dangerous one: it looks like coverage.
 *   blocked-candidate  a side that has now failed to move twice. Two honest
 *                      answers — an input that reaches it, or a declaration
 *                      that nothing reaches it in this deployment, with proof.
 *   not-proposed       NO input names this side at all. `derive` no longer
 *                      gates the pipeline on closing every side (5c6732c), so
 *                      this step receives sides that were never attempted as
 *                      well as sides whose claims missed, and the two need
 *                      different sentences: for a never-proposed side nothing
 *                      ran, `context.recorded.observed` is empty, and it must
 *                      never become a blocked-candidate — a side nobody tried
 *                      is not evidence that nothing reaches it. `claims.length
 *                      === 0` is that distinction exactly, and it is already on
 *                      every item as `context.inputs.claims`.
 *
 * THE FAILURE IS CLASSIFIED BEFORE THE QUESTION IS ASKED, on a second axis, and
 * the classifier's own docblock carries the argument. Two things about it
 * belong here: exactly three failures may skip the agent (`MECHANICAL` — a
 * schema field, an invocation adapter, a mock binding), and "the target was
 * reached and the wrong side taken" is never one of them, because which value
 * chooses which branch is the domain and a tool has the types and not the
 * domain. Failures with one shared EXECUTION TRACE are then asked as one
 * question rather than N: run `20260916T112101Z` asked six, and all six missed
 * claims came out of a single Google Maps proposal.
 *
 * WHAT THE COVERAGE DOCUMENT ALONE CANNOT TELL YOU, said here rather than
 * guessed at. `coverage.json` records that a claim is FALSE and, for the rows
 * it can, a `mechanism` of `closure-not-invoked` or `path-not-taken`. Neither
 * says whether the input reached some OTHER arm, which is the whole difference
 * between `unreached` and `false-claim`. The recorder does say it, per row, in
 * `armsMoved` (record.mjs:2322) — so that is what is read, and when a row
 * carries no `armsMoved` the item is `unreached` and its `question` says the
 * distinction could not be made from evidence. A kind invented where the
 * artifacts are silent would be a sentence about the run rather than a reading
 * of it, which is the one thing this pipeline does not accept from anybody.
 *
 * A FLAT ROUND IS NOT A FAILURE. A round whose numbers did not move is
 * frequently correct — late in a loop the sides that remain are the ones
 * waiting on a person's ruling, and no input will move them. So a plateau is
 * REPORTED, in `did`, and the ledger decides. What fails is a round that
 * measured NOTHING, and that line is drawn once, by `measure`: `unjudgeable()`
 * is imported rather than re-asked, because a second version of that question
 * is a second version that can disagree with it.
 *
 * THE CAP IS DERIVE'S CAP. One knob bounds one handover, whichever phase built
 * it, because the failure it exists to stop is one failure: `recipes.mjs`
 * records `qode-ptp-ms out/worklist.md 3.3M`, generated, therefore treated as
 * delivered, and read by nobody. `batchSize` and `nextBatch` are imported from
 * derive.mjs — a second cap here would be a second number to keep true and a
 * second place for it to be wrong. It bounds the ROUND and never `satisfied`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PROPOSALS_DIR, WORKLIST_JSON } from "../config.mjs";
// The BLOCKED.md vocabulary from the file that ENFORCES it, never a copy. A
// blocked-candidate's honest second answer is a declaration, and an agent told
// the wrong category or the wrong killer writes an entry `pilot:ledger` then
// refuses — which reads as the declaration being wrong rather than as the brief
// being wrong. `sidesOf` comes from the same file for the same reason derive
// imports it: a side label is an operand's source text and four of them on this
// repo contain a comma — which is why the side joins below are derive's, and
// derive's are ledger.mjs's.
// D56: a declaration the ledger refused is open again, asked with its refusal.
import {
  CATEGORIES,
  KILLERS,
  armSideLabels,
  refusedDeclarationContext,
  refusedDeclarationNote,
  refusedDeclarations,
  withoutRefused,
} from "../ledger.mjs";
import { reportNoteCache } from "../notes.mjs";
// A log line states a parameter's name and a condition's shape, never a value.
import { oneLine } from "../novalues.mjs";
// WHERE THE WALK RECORDS WHAT IT ASKED. Imported rather than rebuilt from
// OUT_DIR so there is one name for that file; this step only ever READS it.
// THE FURNITURE A PACKET CARRIES comes from there as well. This step used to
// build its packets from scratch: a grep over the index AND all 19 packet files
// of a live repair round found `charpilot-answers` 0, `limits` 0, `checkpoint`
// 0, `parallel` 0, `concurrent` 0, `mock.kind` 0 and `covers` 0, and the same
// grep over this file printed nothing at all. `derive.satisfied()` is
// permanently true on a repo past first-derive, so REPAIR IS THE ONLY ROUND
// SUCH A REPO EVER GETS — the furniture has to be here, and it has to be the
// SAME OBJECTS derive hands over rather than a second copy of the same prose.
import {
  ANSWERS_DIRNAME,
  BUNDLE_KEY,
  COVERS_RULE,
  WORKLIST_DECISIONS,
  answerFileFor,
  answeredAfter,
  answersBlock,
  askRunId,
  handoverStep,
  lastTurnUnanswered,
  nextAskRepeat,
  packetFurniture,
  readHandoverDoc,
  roundWorkers,
  workerConcurrency,
} from "./handover.mjs";
import {
  BATCH_ENV,
  CHECKPOINT_TOOL,
  CITE_FIELDS,
  DEFAULT_BATCH,
  OUTCOMES,
  OUTCOME_ROUTES,
  batchSize,
  dynamicBatch,
  declaredSides,
  decisiveText,
  flatProposals,
  nextBatch,
  outcomeOfSkip,
  proposedSides,
  readSchema,
  roundLimits,
  toolPaths,
} from "./derive.mjs";
import { COVERAGE_JSON, LOOP_JSON, flatReason, readCoverage, undeliverableRows, unjudgeable } from "./measure.mjs";
import { here, runTool } from "./preflight.mjs";
// WHICH artifact holds this round's rows, resolved by the step that spawned the
// recorder. A live round writes behaviour-live.json, and a reader with its own
// opinion about that would reassess a mocked capture against a staging one.
import { recordedArtifact } from "./record.mjs";

export const NAME = "repair";

/** The ledger, which is the exit condition made checkable. */
export const LEDGER_TOOL = "ledger";

/**
 * A side, as one key. NUL rather than a printable separator, for the reason
 * derive.mjs gives: a side label is an operand's source text and can contain
 * anything a colon or a pipe could be mistaken for.
 */
const sideKey = (armId, side) => `${armId}\u0000${side}`;

/** The way the ledger and the walk both name one unaccounted side. */
export const sideId = (armId, side) => `${armId} [${side}]`;

/**
 * Where this step reads from.
 *
 * The COVERAGE DOCUMENT IS NOT OVERRIDABLE and that is deliberate: it is read
 * through `measure`'s own `readCoverage`/`unjudgeable`, so this step and the
 * step that produced it cannot come to two views of whether the round is
 * judgeable. Everything else is a path a test can point at a temp tree;
 * nothing in the walk passes an override.
 */
export function paths(repo, opts = {}) {
  // THE SPAWNING HALF, borrowed from `derive` rather than written again. Two
  // runners exist and they answer different questions: `exec` runs a tool by
  // NAME and reports `{ ok, line }`, which is what a step wants from the ledger;
  // `spawn` runs a SCRIPT and hands back status, stdout and stderr, which is
  // what a step wants when the tool's own refusal is the thing it has to route
  // on. `opts.exec` is deliberately NOT forwarded — it is the ledger-shaped one
  // and a caller that passed it would silently get it here in the other shape.
  const spawning = toolPaths(repo, { ...opts, exec: opts.spawn });
  return {
    repo,
    proposalsDir: opts.proposalsDir ?? PROPOSALS_DIR,
    worklistJson: opts.worklistJson ?? WORKLIST_JSON,
    behaviourJson: opts.behaviourJson ?? recordedArtifact(),
    handover: opts.handover ?? WORKLIST_DECISIONS,
    exec: opts.exec ?? runTool,
    tool: opts.tool ?? spawning.tool,
    spawn: spawning.exec,
  };
}

/** A JSON document, or null when it is absent or will not parse. */
function readDoc(path) {
  // THROUGH THE INDEX, because the walk now writes a round as an index plus one
  // brief per packet (workflow.mjs:writeWorklist) and `pending` is no longer a
  // key of the file at `path`. Reading it here would find nothing and every
  // caller would conclude the previous round asked nothing — which would forget
  // `previouslyAsked` and `priorAttempts` silently, and a forgotten prior
  // attempt is re-run rather than recognised. `readHandoverDoc` reassembles the
  // round, and still returns a `{ step, pending }` file unchanged, which is what
  // this function used to read and what the tests write by hand.
  //
  // Its own docblock carries the null contract this one had: absent, or
  // unparseable, is null, and every caller treats null as "unread".
  return readHandoverDoc(path);
}

/** The work list's arms, keyed by arm id. */
export function armIndex(worklistJson) {
  const doc = readDoc(worklistJson);
  return new Map((doc?.items ?? []).map((i) => [i.armId, i]));
}

/** Every label an arm has, so a comma inside one cannot be split on (D59: the ledger's one definition). */
function labelIndex(arms) {
  return armSideLabels({ worklist: { items: [...arms.values()] } });
}

/** The recorded rows, keyed by the proposal id that produced each one. */
export function recordedRows(behaviourJson) {
  const doc = readDoc(behaviourJson);
  return new Map((doc?.rows ?? []).filter((r) => r?.id).map((r) => [r.id, r]));
}

/**
 * THE ROWS THE RECORDER COULD NOT RUN, AND ITS OWN SENTENCE ABOUT EACH.
 *
 * THE DEFECT THIS CLOSES, measured on run `20260916T223906Z`. record.mjs writes
 * a `skipped` entry with the EXACT reason whenever it cannot run a row
 * (record.mjs:2785). This step built its whole diagnosis out of `rows` only. So
 * 122 skipped entries, every one of them saying
 * `blocked egress: prisma.cachedLocation - no boundary declared for it`,
 * reached the answering agent as:
 *
 *     repair: 122 of them have an input and NO recorded row in behaviour.json —
 *             there is no observation to reassess
 *     repair: classified them before asking: 123 no-evidence — 123 for the
 *             agent, 0 mechanical
 *
 * Coverage sat at 234/367 across rounds 7, 8 and 9 — about an hour — and the
 * agent only GUESSED the cause in round 7. `89e4714` fixed the root cause of
 * those particular skips and `946be8c` fixed re-recording; neither of them made
 * this step read `skipped[]`, so the next skip reason of any kind repeated it
 * exactly.
 *
 * It is keyed the same way `recordedRows` is, by proposal id, because that is
 * the join every caller already has: a side's claims name proposals, and a
 * proposal is in `rows` or in `skipped` and never in both.
 */
export function recordedSkips(behaviourJson) {
  const doc = readDoc(behaviourJson);
  return new Map((doc?.skipped ?? []).filter((s) => s?.id).map((s) => [s.id, s]));
}

/**
 * The measurement, indexed the four ways an item needs it.
 *
 * `unmeasurable` rows are keyed BOTH by side and by arm, because coverage.mjs
 * emits them without a `side` whenever the arm itself could not be joined — and
 * an item that dropped those would tell an agent its input simply missed, when
 * what actually happened is that nothing asked.
 */
export function measurementIndex(coverage) {
  const stillUncovered = new Map();
  const falseClaims = new Map();
  const verified = new Map();
  const unmeasurableBySide = new Map();
  const unmeasurableByArm = new Map();

  const push = (map, key, row) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  };

  for (const row of coverage?.stillUncovered ?? []) stillUncovered.set(sideKey(row.armId, row.side), row);
  for (const row of coverage?.falseClaims ?? []) push(falseClaims, sideKey(row.armId, row.side), row);
  for (const row of coverage?.verified ?? []) push(verified, sideKey(row.armId, row.side), row);
  for (const row of coverage?.unmeasurable ?? []) {
    push(unmeasurableByArm, row.armId, row);
    if (row.side !== undefined) push(unmeasurableBySide, sideKey(row.armId, row.side), row);
  }
  return { stillUncovered, falseClaims, verified, unmeasurableBySide, unmeasurableByArm };
}

/**
 * The owning function of an arm, from the work list where it has one and from
 * the measurement's own row otherwise.
 *
 * Both, because neither is complete: `stillUncovered` rows carry `functionId`
 * and `falseClaims` rows carry only `functionName`, while the work list carries
 * the entry recipe and the parameters and may not hold an arm the position join
 * has just started seeing.
 */
export function functionIndex(arms, coverage) {
  const byArm = new Map();
  for (const item of arms.values()) {
    if (item.owner?.functionId) byArm.set(item.armId, item.owner.functionId);
  }
  for (const row of coverage?.stillUncovered ?? []) {
    if (row.functionId && !byArm.has(row.armId)) byArm.set(row.armId, row.functionId);
  }
  return byArm;
}

/**
 * Every side this step has already asked about, from the walk's record of the
 * last handover.
 *
 * WHY THIS FILE. "Failed to move twice" is a fact about two ROUNDS, and no tool
 * artifact holds one: `out/coverage.json` is overwritten every measurement and
 * `out/loop.json` carries totals, not sides. The walk's handover is the only
 * durable record that this step asked about this side before, and it is read
 * here and written nowhere — it is not a second account of the run, because it
 * makes no claim about progress at all: it says which questions were handed
 * over, and it is the walk's own record of what the walk did.
 *
 * Only the items THIS step handed over count. A side briefed by `derive` last
 * round has not failed at anything yet — it had no input then — and counting it
 * would turn every first repair round into a list of blocked candidates.
 *
 * THE HONEST LIMIT: a round that stopped at an earlier step overwrites this
 * file with that step's questions, so a repair ask can be forgotten. Forgetting
 * re-asks a side that could have been declared; the opposite would declare a
 * side nobody had tried twice, and of the two this is the one that costs a
 * round rather than a suppression.
 */
/**
 * PLAN 20 T2.2b — A REPAIR ROUND SIZED THE WAY A DERIVE ROUND IS.
 *
 * `batchSize` returns `DEFAULT_BATCH` (20) for `auto`, and `nextBatch` then
 * stops at the first function that does not fit, so repair handed 19-20 sides
 * while 166-180 were held back on pricing-ms (rounds 6-14) and 5 with 180 held
 * back on tracy-agent-be-ms (rounds 8-9). By default (since the nginx A/B, run
 * 20260924T091852Z; CHARPILOT_REPAIR_BATCH=off is the rollback) the round is `dynamicBatch`, derive's
 * own sizing by packet weight against the round's budget. A pinned numeric
 * CHARPILOT_DERIVE_BATCH, or an explicit `opts.batch`, still wins, as it does
 * for derive.
 */
export function repairBatch(open, opts = {}, env = process.env) {
  const pinned = opts.batch !== undefined || /^\d+$/.test(String(env.CHARPILOT_DERIVE_BATCH ?? "").trim());
  if (env.CHARPILOT_REPAIR_BATCH !== "off" && !pinned) return dynamicBatch(open, { env });
  return batchSize(opts, env);
}

export function previouslyAsked(handover) {
  const doc = readDoc(handover);
  if (doc?.step !== NAME) return new Set();
  const ids = new Set();
  for (const p of doc.pending ?? []) {
    if (p?.id) ids.add(p.id);
    // EVERY SIDE A GROUPED ITEM SPOKE FOR, not just the one whose id it wore.
    // A collapsed group asks one question about N sides; if only the lead's id
    // were recorded, the other N-1 would look never-asked next round and could
    // never reach `blocked-candidate`. `workflow.pendingJson` keeps `id`,
    // `kind`, `question` and `context` and drops everything else, so the
    // members ride inside `context` — `p.group` is read too, for the in-process
    // item this step returns before the walk has written anything.
    for (const member of p?.context?.group?.members ?? p?.group?.members ?? []) {
      if (member) ids.add(member);
    }
  }
  return ids;
}

/**
 * What the PREVIOUS round asked about each side, and what it had observed.
 *
 * Read for one purpose: to recognise an attempt that is byte-for-byte the
 * attempt that already failed. The evidence is the handover's own
 * `context.recorded.observed` rows — the arguments as built, the mocks as
 * bound, the seeds and the env — which is what `contextFor` put there, so no
 * new artifact is needed and none is written.
 */
export function priorAttempts(handover) {
  const doc = readDoc(handover);
  const out = new Map();
  if (doc?.step !== NAME) return out;
  for (const p of doc.pending ?? []) {
    const observed = p?.context?.recorded?.observed ?? [];
    const prints = new Map();
    for (const row of observed) {
      const print = attemptFingerprint(row);
      if (print) prints.set(print, row);
    }
    const entry = { fingerprints: prints, question: p?.question ?? null, kind: p?.kind ?? null };
    const ids = [p?.id, ...(p?.context?.group?.members ?? p?.group?.members ?? [])].filter(Boolean);
    for (const id of ids) out.set(id, entry);
  }
  return out;
}

/**
 * One attempt, as the INPUT it was rather than as the outcome it had.
 *
 * Only what the proposal decided: the entry recipe, the arguments as built, the
 * env, the precondition calls, the seeds and the mock bindings. Deliberately
 * NOT the outcome — two runs of one unchanged input can differ in what staging
 * answered, and a fingerprint that moved with the answer would never match.
 * Null for a row that recorded none of it, because "nothing recorded" is not an
 * attempt anybody can call a repeat.
 */
export function attemptFingerprint(row) {
  if (!row) return null;
  const has =
    row.entry !== undefined || row.args !== undefined || row.mocks !== undefined || row.seeds !== undefined;
  if (!has) return null;
  return JSON.stringify({
    entry: row.entry ?? null,
    args: row.args ?? [],
    env: row.env ?? null,
    calls: row.calls ?? [],
    seeds: row.seeds ?? [],
    mocks: (row.mocks ?? []).map((m) => ({
      symbol: m?.symbol ?? null,
      module: m?.module ?? null,
      imported: m?.imported ?? null,
      kind: m?.kind ?? null,
      build: m?.build ?? null,
      value: m?.value ?? null,
    })),
  });
}

/**
 * Which arms the row's subject call moved that this side's claim did not name.
 *
 * THE EVIDENCE THAT SEPARATES THE TWO DANGEROUS KINDS. `armsMoved` is what the
 * recorder counted during the subject call (record.mjs:2322). A row that moved
 * some other arm reached the code and took a different path — coverage that
 * landed somewhere nobody aimed — and that is a `false-claim`. A row that moved
 * nothing at all is `unreached`.
 */
export function movedElsewhere(rows, armId, side) {
  const elsewhere = [];
  for (const row of rows) {
    for (const moved of row?.armsMoved ?? []) {
      for (const label of moved.sides ?? []) {
        if (moved.armId === armId && label === side) continue;
        elsewhere.push({ row: row.id, armId: moved.armId, file: moved.file, line: moved.line, side: label });
      }
    }
  }
  return elsewhere;
}

/** Whether any of these rows recorded what the recorder saw the arms do. */
const observedArms = (rows) => rows.some((r) => Array.isArray(r?.armsMoved));

/**
 * Why this side counts as having failed twice, or an empty list.
 *
 * Two independent facts, either of which is a second failure:
 *   - this step briefed the side in the previous round and it still has not
 *     moved;
 *   - two or more distinct inputs name it in `reaches` and none of them
 *     reached it.
 *
 * Reported as SENTENCES rather than as a count, because the two answers a
 * blocked candidate has are expensive — an input nobody can write, or a
 * suppression somebody has to rule on — and "trust me, twice" is not a reason
 * to spend either.
 */
export function failedTwice({ id, claims, asked, handoverPath }) {
  const why = [];
  // A SIDE NOBODY EVER TRIED CANNOT HAVE FAILED TWICE, and this is the guard
  // that keeps it out of a suppression. `derive` stopped gating the pipeline on
  // closing every side (5c6732c), so this step now receives sides that were
  // never PROPOSED as well as sides whose claims missed — and `claims.length
  // === 0` is exactly that distinction: no proposal names the side in
  // `reaches`. Without this line such a side becomes `blocked-candidate` on the
  // strength of having been briefed before, and a blocked-candidate is the item
  // that invites a declaration that nothing reaches it. Nothing has been aimed
  // at it yet; the honest answer is an input, not a ruling.
  if (!claims.length) return why;
  if (asked.has(id)) {
    why.push(`this step briefed it in the previous round (${here(handoverPath)}) and it has not moved since`);
  }
  if (claims.length > 1) {
    why.push(`${claims.length} inputs name it in \`reaches\` and none of them reached it: ${claims.join(", ")}`);
  }
  return why;
}

/**
 * Which of the four kinds this side is, asked in the order that puts the
 * costliest answer first.
 *
 * `blocked-candidate` outranks the others because it changes what an honest
 * answer IS: a third input is no longer the only legitimate move, and a side
 * re-asked forever is the failure this kind exists to stop.
 *
 * `not-proposed` RANKS ABOVE `unreached` and is keyed on `claims.length === 0`.
 * That equivalence is exact and needs no new artifact: a side has a claim here
 * iff some proposal's `reaches` names it (`proposedSides`), so an empty claim
 * list means no input was ever aimed at this side. `unreached`'s question opens
 * "the input ran and …" and sends the reader to `context.recorded.observed`,
 * and for a never-proposed side no input exists, nothing ran and that list is
 * empty — so the prose would be false on every clause. The two are also
 * unreachable for it by construction: `movedElsewhere` is built from the rows
 * the claims name, so no claims means no rows means no `elsewhere`, and
 * `failedTwice` returns nothing for an unproposed side by its own guard.
 */
export function kindOf({ elsewhere, twice, claims = [] }) {
  if (twice.length) return "blocked-candidate";
  if (elsewhere.length) return "false-claim";
  if (!claims.length) return "not-proposed";
  return "unreached";
}

/* ------------------------------------------------------------------------ *
 * THE CLASSIFIER — what kind of failure this was, and who has to answer it.
 *
 * THE DEFECT IT REPLACES. An input that did not reach the arm it claimed was
 * handed over as "the claim was FALSE" and nothing else: not where execution
 * stopped, not which mocks were consumed, not what threw, not which arms did
 * move. So the answering turn re-derived from the source instead of reading the
 * evidence, and several missed targets that shared one cause were asked as
 * several separate questions. Measured on run `20260916T112101Z`: six missed
 * claims came from a single Google Maps proposal — one scenario wrong, six
 * questions asked.
 *
 * THE DROP-OFF, and it is the only one that matters here. A classifier that
 * routes a DOMAIN failure to a mechanical fix produces a proposal that RUNS,
 * reaches the wrong arm, and VALIDATES — and the agent never sees the case it
 * was needed for. So:
 *
 *   - `wrong-side` is asked FIRST and unconditionally. A row that moved the
 *     target arm on a different side reached the code and chose the other
 *     branch, and which value chooses which branch is the domain. A tool has
 *     the types and not the domain, so that one is ALWAYS the agent's, and no
 *     mechanical rule below is even consulted for it.
 *   - Exactly three failures may skip the agent, and `MECHANICAL` is the whole
 *     list: a schema field, an invocation adapter, a mock binding. Every other
 *     failure — named, unnamed or new — routes to the agent, because `routeOf`
 *     asks membership of that set rather than asking each failure in turn.
 *   - The agent-routed rules are asked BEFORE the mechanical ones, so a row
 *     that is both (an arrangement that threw AND a misspelt side label) goes
 *     to the agent. A misclassification that routes everything to the agent is
 *     today's behaviour and is safe; that is the failure to prefer.
 * ------------------------------------------------------------------------ */

/* ------------------------------------------------------------------------ *
 * A SKIP REASON IS THE RECORDER'S SENTENCE ABOUT ITS OWN FAILURE, AND SOME OF
 * THEM ARE ABOUT THE TOOLSET RATHER THAN ABOUT THE PROPOSAL.
 *
 * THIS IS THE HALF THAT MATTERS, and getting it wrong is what round 7 of
 * `20260916T223906Z` did for an hour. `blocked egress: prisma.cachedLocation -
 * no boundary declared for it` READS like a critique of the proposal — it names
 * something the proposal did not declare — and it was true of the RECORDER:
 * `89e4714` fixed it in the toolset, not in any input. An item that hands that
 * sentence over as a repair instruction sends the agent to fix what is not
 * broken, and it will keep doing it every round because nothing it changes can
 * make the sentence stop appearing.
 *
 * So the item carries the reason VERBATIM and says WHO IT IS ABOUT. Three
 * answers and no fourth:
 *
 *   proposal   the sentence names a field of the submitted document. The fix is
 *              in that document and the agent is the one who makes it.
 *   toolset    the sentence is the recorder stating what IT cannot do. No input
 *              fixes it. It is reported so a person fixes the tool, and the
 *              agent is told plainly not to repair a proposal that is not broken.
 *   undecided  no rule here recognises the sentence. It is still handed over
 *              verbatim and still routed to the agent, and it claims nothing
 *              about whose failure it is. NULL IS A REAL ANSWER here for the
 *              same reason it is in `outcomeOfSkip`: a sentence classified
 *              WRONGLY as `toolset` would tell an agent to ignore a broken input.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD ROUTE, AND WHAT WAS TRADED FOR IT.
 *
 * Routing here was `mechanical` vs `agent`, and `routeOf` asked membership of
 * one frozen set so that a failure nobody has invented yet comes back `agent`.
 * `MECHANICAL` is UNCHANGED and still holds exactly `schema-invalid`,
 * `target-not-invoked` and `mock-never-matched`: the guarantee "exactly three
 * failures may skip the agent" is intact, because `toolset` DOES NOT SKIP THE
 * AGENT EITHER — a toolset-routed item is still a pending item, still read by a
 * turn, and the only thing its route changes is what the turn is told to do
 * with it.
 *
 * WHAT WAS TRADED: `routeOf` used to have exactly two answers, so "not `tool`"
 * meant "`agent`". It now has three, and a reader that tested `route !== "tool"`
 * to mean "the agent will fix this" is wrong for one failure. That inference was
 * never written down anywhere and is not what the field means — `route` says who
 * ANSWERS the item, and for a toolset skip the honest answer is neither of the
 * first two. It still holds that `MECHANICAL.has(f)` iff `routeOf(f) === "tool"`,
 * and that every failure not named in this file routes to the agent.
 *
 * `routeOf` STAYS A PURE FUNCTION OF THE FAILURE NAME, one argument, which is
 * why the skip failures are NAMED for their route (`skipped-toolset` vs
 * `skipped-proposal`) rather than carrying `about` as a second parameter. A
 * route that needed two arguments could disagree with the route already written
 * on a handed-over item, and `repair.classify.test.mjs` checks exactly that
 * equality against the item on disk.
 * ------------------------------------------------------------------------ */

/** The three answers to "whose failure is this sentence about", and no fourth. */
export const SKIP_ABOUT = Object.freeze({
  PROPOSAL: "proposal",
  TOOLSET: "toolset",
  UNDECIDED: "undecided",
});

/**
 * RECORD.MJS'S OWN LINES, sorted into who each sentence is about.
 *
 * Keyed on `outcomeOfSkip`'s `rule` — the record.mjs line the pattern is
 * anchored to — and not on the outcome, because one outcome covers both: a
 * `mock-not-applied` skip is the proposal's missing declaration at
 * record.mjs:944 and the recorder's own egress guard at record.mjs:2551, and
 * those two want opposite instructions.
 *
 * A rule that is not in this table is `undecided` by omission, which is the
 * direction this has to fail in.
 */
export const SKIP_ABOUT_BY_RULE = Object.freeze({
  // A field of the submitted document is not what the document format allows.
  "record.mjs:960,977": SKIP_ABOUT.PROPOSAL,
  "record.mjs:867": SKIP_ABOUT.PROPOSAL,
  "record.mjs:897": SKIP_ABOUT.PROPOSAL,
  "record.mjs:886": SKIP_ABOUT.PROPOSAL,
  "record.mjs:739,744": SKIP_ABOUT.PROPOSAL,
  "record.mjs:715": SKIP_ABOUT.PROPOSAL,
  // Fix plan 1, F3.6: egress to an endpoint the proposal declared no boundary
  // for. Since 89e4714 the recorder says "DOES declare ... did not install it"
  // when it dropped a declaration, so this sentence is now true of the
  // proposal: declaring the boundary is the fix, and the side stays askable.
  "record.mjs:3418": SKIP_ABOUT.PROPOSAL,
  // D68 follow-on: an egress through the owner file's own import of a symbol
  // the proposal declared at another module. The `module` is the proposal's.
  "record.mjs:module-overrides-import": SKIP_ABOUT.PROPOSAL,
  // D43: `setup[].apply.manual`, which the contract refuses outright - the
  // proposal wrote no directive, and the reason says which to write.
  "record.mjs:841": SKIP_ABOUT.PROPOSAL,
  // D43: a field double on a constructor subject, which assigns its own fields.
  "record.mjs:field-ctor-subject": SKIP_ABOUT.PROPOSAL,
  // D43: a field double refused under a via the scan does not resolve.
  "record.mjs:field-via-not-the-scans": SKIP_ABOUT.PROPOSAL,
  // The recorder stating a limit of its own: what it can drive, what it can
  // arrange, what its egress guard will let through. No input changes any of
  // these, and `20260916T223906Z` round 7 spent an hour proving it.
  "record.mjs:819": SKIP_ABOUT.TOOLSET,
  "record.mjs:1784": SKIP_ABOUT.TOOLSET,
  "record.mjs:765": SKIP_ABOUT.TOOLSET,
  "record.mjs:760": SKIP_ABOUT.TOOLSET,
  // D68: a functionId the scan does not have is a stale reference, and a stale
  // reference is the proposal's to correct - never a tool that failed.
  "record.mjs:stale-function-id": SKIP_ABOUT.PROPOSAL,
  "record.mjs:859": SKIP_ABOUT.TOOLSET,
  "record.mjs:856": SKIP_ABOUT.TOOLSET,
  "record.mjs:2551": SKIP_ABOUT.TOOLSET,
  // The recorder saying a row failed on a tool of its own (fix plan 1, F1.1).
  "record.mjs:pipeline-defect": SKIP_ABOUT.TOOLSET,
  // fix/plan1-records da4c8be: no receiver for a field double is the
  // recorder's limit; a field double with no value is the proposal's.
  "record.mjs:field-no-receiver": SKIP_ABOUT.TOOLSET,
  "record.mjs:field-value-empty": SKIP_ABOUT.PROPOSAL,
  // Tool backlog: the recorder cannot reach an arm that runs at import with
  // the module's own arguments; the proposal declares its sides.
  "record.mjs:called-at-import": SKIP_ABOUT.PROPOSAL,
  "record.mjs:module-private-via": SKIP_ABOUT.PROPOSAL,
  // D43: the via's binding holds what a call returned, not the function.
  "record.mjs:wrapped-via": SKIP_ABOUT.PROPOSAL,
  // A via that names no driver: the proposal's field (record.mjs viaNotADriver).
  "record.mjs:via-not-a-driver": SKIP_ABOUT.PROPOSAL,
});

/** The failure name a skip gets, which is also what decides its route. */
export const SKIP_FAILURE = Object.freeze({
  [SKIP_ABOUT.PROPOSAL]: "skipped-proposal",
  [SKIP_ABOUT.TOOLSET]: "skipped-toolset",
  [SKIP_ABOUT.UNDECIDED]: "skipped-undecided",
});

/** The one failure that is neither mechanical nor the agent's to repair. */
export const TOOLSET_ROUTED = Object.freeze(new Set([SKIP_FAILURE[SKIP_ABOUT.TOOLSET]]));

/**
 * One `skipped[]` entry, read as far as it can honestly be read.
 *
 * `{ about, failure, outcome, rule, reason }`. `reason` is record.mjs's bytes
 * and is never paraphrased; everything else is a reading OF those bytes, and
 * `rule` names the line the reading came from so a wrong one is arguable.
 */
export function skipDiagnosis(skip) {
  const reason = String(skip?.reason ?? "").trim();
  const { outcome, rule } = outcomeOfSkip(reason);
  const about = SKIP_ABOUT_BY_RULE[rule] ?? SKIP_ABOUT.UNDECIDED;
  return { about, failure: SKIP_FAILURE[about], outcome, rule, reason };
}

/**
 * A RECORDED ROW WHOSE HARNESS FAILED, read the way a skip is (tool backlog;
 * verifier #2 finding on coverage.mjs markRulings).
 *
 * A row with \`harnessError\` is not behaviour, and the side it was for was
 * ruled \`open\` with "no reason is written for it" - while the recorder had
 * written one. Same shape as skipDiagnosis, so the rulings read both alike:
 *
 *   proposal   the recorder's own sentence says what the proposal has to
 *              declare: \`charpilot: this.logger: spy on a field that is
 *              undefined on the receiver ... declare an answer for the field
 *              instead\` (notification-ms). The side stays askable.
 *   toolset    everything else. A harness failure is the tool's until an input
 *              is shown to fix it - an SDK constructor throwing at import on
 *              the env the recorder handed it (pricing-ms's \`Neither apiKey nor
 *              config.authenticator provided\`), or a PLATFORM-NATIVE module
 *              the recording host cannot load (company-enrich's \`sharp\` built
 *              for linux, loaded on darwin). The last is named as a host
 *              artifact: no input and no service change fixes it, and on the
 *              platform the dependencies were installed for it does not occur.
 */
const HARNESS_PROPOSAL = [
  { rule: "record.mjs:spy-undefined-field", re: /^charpilot: .+: spy on a field that is undefined on the receiver\b[\s\S]*declare an answer\b/ },
  // The subject was constructed with required parameters nobody answered.
  // A throw from the proposal's own invoke.build.
  { rule: "record.mjs:build-threw", re: /; thrown by the proposal's own invoke\.build before the subject was entered - repair the build\b/ },
  { rule: "record.mjs:ctor-undefined", re: /; the subject's constructor was called with .+ undefined because no proposal answered (it|them) - declare an answer\b/ },
  // A module the row loads calls a member its "value" answer does not have.
  { rule: "record.mjs:value-lacks-member", re: /; .+ calls .+\(\) (while it loads|before the subject was entered), and the row answered .+ with a "value" that has no \S+ - a value answer is the whole export\b[\s\S]*: the answer must include \S+/ },
  // D70: the same, for a returns/resolves answer to a function export, whose
  // member reads reach the answer's members only (record.mjs valueMissingMember).
  { rule: "record.mjs:returns-lacks-member", re: /; .+ calls .+\(\) (while it loads|before the subject was entered), and the row answered .+ with a "(returns|resolves)" answer that has no \S+ - a \2 answer to a function export is that function\b[\s\S]*: the answer must include \S+/ },
  // A boundary answered with a string of JSON text where the real export
  // is an object or a function, and the row's arrangement then threw.
  { rule: "record.mjs:value-json-text", re: /; the row answered .+ with a string holding JSON text - a mock's "value" is the answer itself, not its JSON encoding\b/ },
  // A notCalled answer the row's own modules call and use what it returns,
  // or whose member (of a function export) they call.
  { rule: "record.mjs:not-called-used", re: /; .+ calls .+\(\) (while it loads|before the subject was entered)(,| and uses what it returns,) and the row declared .+ notCalled - a notCalled answer (records the call and returns undefined|to a function export is that function alone)\b/ },
  // A boundary's own build threw while vitest built the module's double.
  { rule: "record.mjs:mock-build-threw", re: /; thrown by the proposal's own build of .+ while the row's doubles were built: [\s\S]* - repair the build\b/ },
  // D43: a build names a binding it never imported (record.mjs buildUnboundName).
  { rule: "record.mjs:build-unbound-name", re: /^([\w$]+) is not defined; \1 is named by the proposal's own (?:invoke\.build|args\[\d+\]\.build) and bound nowhere\b[\s\S]* - repair the build\b/ },
];
const HARNESS_PLATFORM = /Could not load the "[^"]+" module using the \S+ runtime|invalid ELF header|not a valid Win32 application|was compiled against a different Node\.js version|NODE_MODULE_VERSION|wrong ELF class|incompatible architecture|mach-o file, but is an incompatible/i;
export function harnessDiagnosis(row) {
  const reason = String(row?.harnessError?.message ?? "").trim();
  const hit = HARNESS_PROPOSAL.find((h) => h.re.test(reason));
  if (hit) return { about: SKIP_ABOUT.PROPOSAL, failure: SKIP_FAILURE[SKIP_ABOUT.PROPOSAL], rule: hit.rule, reason };
  const platform = HARNESS_PLATFORM.test(reason);
  return {
    about: SKIP_ABOUT.TOOLSET,
    failure: SKIP_FAILURE[SKIP_ABOUT.TOOLSET],
    rule: platform ? "record.mjs:harness-platform-native" : "record.mjs:harness-failure",
    reason: platform
      ? `platform-native dependency the recording host cannot load (a host artifact, not the service or the input): ${reason}`
      : `the harness failed on this row (${row?.harnessError?.phase ?? "unknown phase"}): ${reason}`,
  };
}

/**
 * THE THREE FAILURES A TOOL MAY ANSWER WITHOUT AN AGENT TURN, and no others.
 *
 * Each is provably mechanical — the fix is a field, an adapter or a binding,
 * and the correction is computed from a value some artifact already holds
 * exactly. Frozen, and consulted as a SET: a fourth failure added to the
 * classifier below is routed to the agent until somebody deliberately adds its
 * name here, which is the direction this has to fail in.
 *
 * A tool-routed item is still handed over. A STEP NEVER WRITES AN ARTIFACT, so
 * this step cannot apply the correction itself — what it can do, and does, is
 * carry the correction already computed so the answering turn applies it rather
 * than deriving it.
 */
export const MECHANICAL = Object.freeze(new Set(["schema-invalid", "target-not-invoked", "mock-never-matched"]));

/**
 * Who answers this failure. Membership of a frozen set, never a chain of ifs.
 *
 * Three answers now, and the third is asked SECOND so that `MECHANICAL`'s
 * membership is still the first and only thing that can produce `tool`. Every
 * failure named in neither set — one the classifier can produce, one it cannot,
 * and one nobody has invented yet — is still the agent's, which is the direction
 * this has to fail in.
 */
export function routeOf(failure) {
  if (MECHANICAL.has(failure)) return "tool";
  if (TOOLSET_ROUTED.has(failure)) return "toolset";
  return "agent";
}

/** The default action for each failure, in the words the table was written in. */
const ACTIONS = {
  "schema-invalid": "the tool returns the exact field correction",
  "target-not-invoked": "repair the invocation adapter",
  "mock-never-matched": "inspect the binding and the call arguments",
  "threw-before-target": "repair the prerequisites or the fixture shape",
  "wrong-side": "the agent, with the execution trace",
  "duplicate-attempt": "rejected as a duplicate; the prior evidence is returned",
  "driver-impossible": "the agent, and a scoped proof that this driver cannot reach it",
  "reached-other-arm": "the agent: the input reached a different arm entirely",
  "not-proposed": "the agent: no input exists for this side yet",
  "no-evidence": "the agent: nothing was recorded about this attempt",
  "skipped-proposal": "repair the field of the proposal the recorder's own skip reason names",
  "skipped-toolset": "NOT the proposal: the recorder said what IT cannot do, so report the tool and do not re-aim an input at this",
  "skipped-undecided": "the agent, with the recorder's own skip reason verbatim — nothing here classified whose failure it is",
};

/**
 * THE DOMAIN GATE. Which sides of the TARGET arm a row moved instead of the one
 * it claimed.
 *
 * Distinct from `movedElsewhere`, which counts any arm at all. This is the same
 * condition, evaluated, choosing the other branch — the input reached the arm
 * and the value it carried selected the other side. That is a question about
 * what the value MEANS, and the answer is never in the types.
 */
export function reachedWrongSide(rows, armId, side) {
  const hits = [];
  for (const row of rows) {
    for (const moved of row?.armsMoved ?? []) {
      if (moved.armId !== armId) continue;
      for (const label of moved.sides ?? []) {
        if (label === side) continue;
        hits.push({ row: row.id, armId: moved.armId, file: moved.file, line: moved.line, side: label });
      }
    }
  }
  return hits;
}

/**
 * coverage.mjs:523 and record.mjs:2345 write this one sentence about one
 * defect: a `reaches` value naming a label that is not a side of the arm.
 *
 * Matched rather than re-derived, because the permitted set is in the sentence
 * and this step holds no second copy of the arm model.
 */
const NOT_A_SIDE = /^"(.*)" is not a side of this arm \((.*)\)$/;

/**
 * Proposals that named a label this arm does not have, when the label they
 * SHOULD have named is this side.
 *
 * The join is the reason a never-proposed side and a misspelt side are not the
 * same item: `sidesOf` keeps an unknown label verbatim, so a proposal that
 * wrote `whenTru` proposes the side `whenTru`, which matches no still-uncovered
 * row — and the real side reads as never proposed. The unmeasurable row is the
 * thread back: it names the arm, the label that was written, and the labels the
 * arm actually has.
 */
export function schemaFaults({ armId, side, measurement, rows }) {
  const faults = [];
  const consider = (id, why) => {
    const m = NOT_A_SIDE.exec(String(why ?? ""));
    if (!m) return;
    const permitted = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    // The arm has to actually own this side, or the sentence is about some
    // other arm's labels and this side is not what was meant.
    if (!permitted.includes(side)) return;
    faults.push({ proposal: id ?? null, armId, named: m[1], permitted });
  };
  for (const row of measurement.unmeasurableByArm.get(armId) ?? []) consider(row.id, row.why);
  for (const row of rows) {
    for (const v of row?.claimVerdicts ?? []) {
      if (v?.armId === armId) consider(row.id, v.why);
    }
  }
  return faults;
}

/**
 * The exact field correction, or null when it cannot be proved.
 *
 * PROVABLE MEANS ONE CANDIDATE. The arm's permitted labels are known; the
 * correction is exact only when exactly ONE of them is still uncovered, because
 * then the misspelt label can only have meant that one — every other label of
 * the arm is already covered and no input needs to aim at it. With two open
 * labels the tool would be picking, and picking is the agent's.
 */
export function schemaCorrection({ armId, side, faults, measurement }) {
  if (!faults.length) return null;
  const permitted = faults[0].permitted;
  const open = permitted.filter((label) => measurement.stillUncovered.has(sideKey(armId, label)));
  if (open.length !== 1 || open[0] !== side) return null;
  return {
    field: `reaches[${JSON.stringify(armId)}]`,
    proposals: [...new Set(faults.map((f) => f.proposal).filter(Boolean))],
    written: [...new Set(faults.map((f) => f.named))],
    permitted,
    correction: side,
    why:
      `the arm's sides are exactly ${permitted.join(", ")} and ${JSON.stringify(side)} is the only one still ` +
      `uncovered, so the label that was written can only have meant it`,
  };
}

/**
 * Rows whose subject never started and which the recorder did not attribute to
 * the arrangement.
 *
 * `invoked` is the recorder's own field for "this was not recorded as
 * behaviour" (record.mjs:5466-5575) and `subjectCallStarted` is
 * `covBefore !== null` (record.mjs:5656) — the coverage snapshot taken
 * immediately before the subject call. Both false, with no `phase:
 * "arrangement"` attribution and nothing thrown, is the recorder saying the
 * call was never made: the invocation adapter, not the input.
 *
 * THE LIMIT, said rather than inferred: `harnessError` carries a `phase` only
 * for arrangement failures, so this document cannot separate "the entry did not
 * resolve" from "the recorder refused the row for some other reason". Both are
 * adapter repairs, which is why one classification covers them; a document that
 * separated them would let this be two.
 */
export function notInvoked(rows) {
  return rows
    .filter(
      (r) =>
        r?.invoked === false &&
        r?.subjectCallStarted === false &&
        r?.harnessError?.phase !== "arrangement" &&
        !("threw" in (r ?? {}))
    )
    .map((r) => ({ row: r.id, entry: r.entry ?? null, harnessError: r.harnessError ?? null }));
}

/**
 * Rows that declared boundaries and consumed none of them.
 *
 * ALL of them, not some. A row that consumed one mock and not another took a
 * path, and which path it should have taken is a domain question; a row that
 * consumed nothing at all never bound to anything it declared, and that is a
 * binding — the module specifier, the imported name, the symbol. The recorder
 * has measured that shape at scale: record.mjs:3798 records 13 of 18 rows with
 * `boundaryCalls: []` while the declared symbol never appeared once.
 */
export function unmatchedMocks(rows) {
  const out = [];
  for (const row of rows) {
    const declared = (row?.mocks ?? []).map((m) => m?.symbol).filter(Boolean);
    if (!declared.length) continue;
    if (!Array.isArray(row.boundaryCalls)) continue;
    const consumed = new Set(row.boundaryCalls.map((c) => c?.symbol));
    if (declared.some((s) => consumed.has(s))) continue;
    out.push({
      row: row.id,
      declared,
      consumed: [...consumed].filter(Boolean),
      bindings: (row.mocks ?? []).map((m) => ({
        symbol: m?.symbol ?? null,
        module: m?.module ?? null,
        imported: m?.imported ?? null,
        kind: m?.kind ?? null,
      })),
    });
  }
  return out;
}

/** Rows the recorder stopped before the subject, and how it said so. */
export function threwBeforeTarget(rows) {
  return rows
    .filter((r) => r?.harnessError?.phase === "arrangement" || (r?.subjectCallStarted === false && "threw" in (r ?? {})))
    .map((r) => ({
      row: r.id,
      phase: r.harnessError?.phase ?? null,
      harnessError: r.harnessError ?? null,
      subjectCallStarted: r.subjectCallStarted ?? null,
      threw: "threw" in r,
    }));
}

/** Which of this side's false claims coverage.mjs:596 called a closure it never invoked. */
export function driverImpossible(measurement, armId, side) {
  return (measurement.falseClaims.get(sideKey(armId, side)) ?? []).filter((r) => r.mechanism === "closure-not-invoked");
}

/**
 * The failure, the route, and the evidence each rule read.
 *
 * Asked in ONE order, and the order is the drop-off: every agent-routed rule is
 * asked before every mechanical one, so a side that satisfies both leaves with
 * the agent. `wrong-side` is first of all and is the only rule that cannot be
 * displaced by anything.
 */
export function classify({ armId, side, rows, claims, measurement, prior, skips = [] }) {
  const say = (failure, evidence, reads) => ({
    failure,
    route: routeOf(failure),
    action: ACTIONS[failure] ?? "the agent",
    reads,
    evidence,
  });

  // 1. THE DOMAIN. Never displaced, never mechanical.
  const wrong = reachedWrongSide(rows, armId, side);
  if (wrong.length) {
    return say("wrong-side", { movedInstead: wrong }, "record.mjs:2322 `armsMoved`, restricted to the target arm");
  }

  // 2. The same attempt, again. Rejected with what it produced last time.
  const duplicate = repeatedAttempt(rows, prior);
  if (duplicate) return say("duplicate-attempt", duplicate, "the previous handover's own `context.recorded.observed`");

  // 3. The driver cannot reach it as chosen — the agent, and a scoped proof.
  const closures = driverImpossible(measurement, armId, side);
  if (closures.length) {
    return say("driver-impossible", { falseClaims: closures }, "coverage.mjs:596 `mechanism`");
  }

  // 4. Something threw before the target. Prerequisites or fixture shape.
  const threw = threwBeforeTarget(rows);
  if (threw.length) {
    return say("threw-before-target", { rows: threw }, "record.mjs:5557 `harnessError.phase` and `subjectCallStarted`");
  }

  // 5-7. THE MECHANICAL THREE, and each has to prove itself.
  const faults = schemaFaults({ armId, side, measurement, rows });
  const correction = schemaCorrection({ armId, side, faults, measurement });
  if (correction) {
    return say("schema-invalid", { faults, correction }, "coverage.mjs:523 / record.mjs:2345 `\"x\" is not a side of this arm`");
  }

  const never = notInvoked(rows);
  if (never.length && never.length === rows.length) {
    return say("target-not-invoked", { rows: never }, "record.mjs:5466 `invoked` and record.mjs:5656 `subjectCallStarted`");
  }

  const unbound = unmatchedMocks(rows);
  if (unbound.length && unbound.length === rows.length) {
    return say("mock-never-matched", { rows: unbound }, "the row's own `mocks` bindings against its `boundaryCalls`");
  }

  // 8. THE RECORDER COULD NOT RUN IT, AND SAID WHY.
  //
  // ASKED HERE, and the position is load-bearing in one direction only: a
  // skipped proposal produces NO row, so every rule above it needs a row or a
  // false claim and none of them can fire for one. What it DOES displace is
  // `no-evidence`, which is exactly the defect — 122 skips with a written reason
  // reaching the agent as "there is no observation to reassess".
  //
  // The failure NAME carries who it is about, because the name is what `routeOf`
  // reads; the reason is carried verbatim beside it either way.
  if (skips.length) {
    const diagnoses = skips.map(skipDiagnosis);
    // The worst case first when they disagree: a side whose proposals were
    // skipped for two different reasons is answered by the one somebody can act
    // on, and an undecided sentence is never allowed to mask a proposal defect.
    const lead =
      diagnoses.find((d) => d.about === SKIP_ABOUT.PROPOSAL) ??
      diagnoses.find((d) => d.about === SKIP_ABOUT.TOOLSET) ??
      diagnoses[0];
    return {
      failure: lead.failure,
      route: routeOf(lead.failure),
      action: ACTIONS[lead.failure] ?? "the agent",
      reads: "record.mjs:2785 `skipped[]` — the recorder's own sentence about why it could not run this row",
      // WHOSE FAILURE THE SENTENCE IS ABOUT, on the diagnosis itself and not
      // only inside the evidence, because it is the thing that decides whether
      // the answering turn touches the proposal at all.
      about: lead.about,
      evidence: {
        skipped: skips.map((skip, i) => ({
          proposal: skip.id,
          file: skip.file ?? null,
          // VERBATIM. The recorder's sentence is the evidence; a summary of it
          // is a sentence this step wrote about a failure it did not see.
          reason: skip.reason ?? null,
          about: diagnoses[i].about,
          outcome: diagnoses[i].outcome,
          route: diagnoses[i].outcome ? OUTCOME_ROUTES[diagnoses[i].outcome] ?? null : null,
          rule: diagnoses[i].rule,
        })),
      },
    };
  }

  // Everything else is the agent's, and says which shape it is.
  const elsewhere = movedElsewhere(rows, armId, side);
  if (elsewhere.length) return say("reached-other-arm", { movedElsewhere: elsewhere }, "record.mjs:2322 `armsMoved`");
  if (!claims.length) return say("not-proposed", { claims: [] }, "`context.inputs.claims` — no `reaches` names this side");
  return say("no-evidence", { rows: rows.map((r) => r.id) }, "the recorded rows this side's claims name");
}

/** This side's attempt, byte for byte the one the last round already asked about. */
function repeatedAttempt(rows, prior) {
  if (!prior || !rows.length) return null;
  const prints = rows.map(attemptFingerprint);
  if (prints.some((p) => p === null)) return null;
  const matched = prints.map((p) => prior.fingerprints.get(p));
  if (matched.some((m) => m === undefined)) return null;
  return {
    repeated: rows.map((r) => r.id),
    askedLastRound: prior.question,
    kindLastRound: prior.kind,
    priorObserved: matched,
  };
}

/* ------------------------------------------------------------------------ *
 * GROUPING — one cause asked once.
 *
 * GROUP ON THE EXECUTION TRACE, NEVER ON THE ERROR TEXT. Grouping failures that
 * only LOOK alike sends one fix to cases with different causes and the whole
 * group comes back unfixed, so the key below is built out of what the run DID —
 * whether the subject started, which arms moved and in what order, which
 * boundary calls were consumed and in what order, and which declared boundaries
 * went unused — and out of nothing that anybody wrote in prose. No `message`,
 * no `name`, no `why`, no recorded value.
 *
 * It could not use the text even if it wanted to: `snap()` excludes `stack`
 * (record.mjs:3019), so a thrown value carries a name and a message and no
 * site. Two throws with the same message from two different places are
 * indistinguishable by text, which is precisely why text is the wrong key —
 * their traces differ, and the traces are what is read.
 *
 * A ROW THAT OBSERVED NOTHING HAS NO TRACE, and no trace means no group. A side
 * with no recorded row is never grouped with anything, because "both recorded
 * nothing" is a shared absence and not a shared cause.
 * ------------------------------------------------------------------------ */

/**
 * One row's execution trace, as a key. Structured facts only.
 *
 * `null` when the row recorded no execution at all — an absence is not a trace.
 */
export function traceKey(row) {
  if (!row) return null;
  const moved = Array.isArray(row.armsMoved)
    ? row.armsMoved.flatMap((m) => (m?.sides ?? []).map((s) => `${m.armId}|${s}`))
    : null;
  const boundaries = Array.isArray(row.boundaryCalls) ? row.boundaryCalls.map((c) => c?.symbol ?? null) : null;
  const consumed = new Set(boundaries ?? []);
  const unused = (row.mocks ?? [])
    .map((m) => m?.symbol)
    .filter((s) => s && !consumed.has(s))
    .sort();
  if (moved === null && boundaries === null && row.invoked === undefined && row.subjectCallStarted === undefined) {
    return null;
  }
  return JSON.stringify({
    invoked: row.invoked ?? null,
    subjectCallStarted: row.subjectCallStarted ?? null,
    arrangement: row.harnessError?.phase === "arrangement",
    harness: Boolean(row.harnessError),
    threw: "threw" in row,
    moved,
    boundaries,
    unused,
  });
}

/** The trace, in the fields a reader reads rather than as a key. */
export function traceOf(row) {
  if (!row) return null;
  const consumed = new Set(Array.isArray(row.boundaryCalls) ? row.boundaryCalls.map((c) => c?.symbol) : []);
  return {
    row: row.id,
    invoked: row.invoked ?? null,
    subjectCallStarted: row.subjectCallStarted ?? null,
    stoppedInArrangement: row.harnessError?.phase === "arrangement",
    threw: "threw" in row,
    armsMoved: Array.isArray(row.armsMoved)
      ? row.armsMoved.flatMap((m) => (m?.sides ?? []).map((s) => `${m.armId} [${s}]`))
      : null,
    boundaryCallsConsumed: Array.isArray(row.boundaryCalls) ? row.boundaryCalls.map((c) => c?.symbol ?? null) : null,
    boundariesDeclaredAndUnused: (row.mocks ?? []).map((m) => m?.symbol).filter((s) => s && !consumed.has(s)),
  };
}

/**
 * The key two sides have to share to be asked as one question: the same
 * failure, and the same set of execution traces.
 *
 * Null — ungroupable — whenever any row has no trace or there are no rows. The
 * FAILURE is part of the key because the three mechanical fixes and the agent's
 * are different repairs; a shared trace under two different failures is two
 * questions.
 */
export function groupKeyFor({ failure, rows }) {
  if (!rows.length) return null;
  const keys = rows.map(traceKey);
  if (keys.some((k) => k === null)) return null;
  return JSON.stringify([failure, [...new Set(keys)].sort()]);
}

/** The round's items, clustered on that key, first-seen order preserved. */
export function clusterByTrace(items) {
  const order = [];
  const buckets = new Map();
  for (const item of items) {
    const key = item.groupKey;
    if (key === null || key === undefined) {
      order.push([item]);
      continue;
    }
    if (!buckets.has(key)) {
      const bucket = [];
      buckets.set(key, bucket);
      order.push(bucket);
    }
    buckets.get(key).push(item);
  }
  return order;
}

/**
 * One item's whole brief.
 *
 * Everything in it is a value some tool already holds exactly: the arm's own
 * source, the recorder's own row, the measurement's own rows. There is
 * deliberately no slot for an expected output, and the recorded outcome is
 * carried as EVIDENCE — `rule` says so in the document itself, next to it.
 */
export function contextFor({
  item,
  armId,
  side,
  coverage,
  measurement,
  functionId,
  functionIds,
  claims,
  rows,
  elsewhere,
  twice,
  diagnosis,
  skips = [],
  proposalsDir,
  behaviourJson,
  loop,
  onDisk = new Map(),
}) {
  const key = sideKey(armId, side);
  // THE ROWS THIS SIDE'S CLAIMS NAME, as they stand on disk. `claims` is a list
  // of `<file>::<id>` addresses and nothing else, which is enough to spawn a
  // withdrawal and not enough to write a `from`. Reading them here is what
  // makes `covers` — the legal `from.arm` set — an answer on the item rather
  // than something the agent has to go and look up in a directory it may not
  // even read.
  const proposalRows = claims
    .map((address) => onDisk.get(proposalIdOf(address)))
    .filter(Boolean)
    .map((row) => ({ id: row.id, file: row.file, covers: [...(row.covers ?? [])], reaches: row.reaches ?? {} }));
  // NEVER NARROWER THAN THE TOOL'S. `checkEvidence` decides with
  // `covers.includes(evidence.arm)`, so this is those `covers` whole, unioned
  // across the rows this side has — and, where it has none, this arm, which is
  // the least a new row can cover and still claim this side.
  const citable = proposalRows.length ? [...new Set(proposalRows.flatMap((r) => r.covers))] : [armId];
  // ONE predicate over two row shapes. `stillUncovered` rows carry `functionId`
  // (coverage.mjs:493); claim rows carry only `functionName`, so theirs is
  // resolved through the arm. A row whose owner cannot be resolved is left out
  // rather than guessed into the wrong function's evidence.
  const owns = (row) =>
    functionId !== undefined && functionId !== null && (row.functionId ?? functionIds.get(row.armId)) === functionId;
  const ofFunction = (rowsIn) => (rowsIn ?? []).filter(owns);

  return {
    arm: {
      armId,
      kind: item?.kind ?? measurement.stillUncovered.get(key)?.kind ?? null,
      file: item?.file ?? measurement.stillUncovered.get(key)?.file ?? null,
      line: item?.line ?? measurement.stillUncovered.get(key)?.line ?? null,
      // VERBATIM, literals and all: it is the condition being READ, not a value
      // to paste, and worklist.md already prints it for that reason.
      source: item?.source ?? null,
      side,
      sides: item?.sides ?? [],
      uncoveredSides: item?.uncoveredSides ?? [],
      lane: item?.lane ?? "unit",
      via: item?.via ?? null,
    },
    owner: {
      functionId: functionId ?? null,
      name: item?.owner?.name ?? measurement.stillUncovered.get(key)?.functionName ?? null,
      async: item?.owner?.async ?? false,
      // How this function is called at all — the import, the class and member,
      // the constructor's parameters — handed over whole rather than rendered
      // into a sentence, because the fields are what a call is built out of.
      entry: item?.owner?.entry ?? null,
      params: item?.owner?.params ?? [],
      boundaries: item?.boundaries ?? [],
    },
    // WHAT THE MEASUREMENT SAID, about this side and about everything else the
    // owning function owns. The function's rows are the reason a reassessment
    // is cheaper than a derivation: they show whether the function was entered
    // at all, and which of its arms the round already holds.
    measurement: {
      document: here(coverage.__path),
      measuredAt: coverage.measuredAt ?? null,
      mode: coverage.mode ?? null,
      totals: coverage.totals ?? null,
      side: {
        stillUncovered: measurement.stillUncovered.get(key) ?? null,
        falseClaims: measurement.falseClaims.get(key) ?? [],
        unmeasurable: [
          ...(measurement.unmeasurableBySide.get(key) ?? []),
          ...(measurement.unmeasurableByArm.get(armId) ?? []).filter((r) => r.side === undefined),
        ],
      },
      function: {
        stillUncovered: ofFunction(coverage.stillUncovered),
        verified: ofFunction(coverage.verified),
        falseClaims: ofFunction(coverage.falseClaims),
        unmeasurable: ofFunction(coverage.unmeasurable),
      },
    },
    // WHAT THE RECORDER OBSERVED. The arguments as BUILT and the boundary
    // answers as APPLIED, which is the difference between reassessing from
    // evidence and re-deriving the input from scratch — the 193 calls and 55.4
    // minutes run 20260916T031317Z spent on exactly that.
    recorded: {
      document: here(behaviourJson),
      observed: rows.map((row) => ({
        id: row.id,
        invoked: row.invoked ?? null,
        subjectCallStarted: row.subjectCallStarted ?? null,
        entry: row.entry ?? null,
        args: row.args ?? [],
        env: row.env ?? null,
        calls: row.calls ?? [],
        mocks: row.mocks ?? [],
        seeds: row.seeds ?? [],
        boundaryCalls: row.boundaryCalls ?? [],
        armsMoved: row.armsMoved ?? null,
        claimVerdicts: row.claimVerdicts ?? [],
        harnessError: row.harnessError ?? null,
        notSettled: row.notSettled ?? null,
        // THE OUTCOME, and `rule` below says what may be done with it.
        ...("threw" in row ? { threw: row.threw } : {}),
        ...("returned" in row ? { returned: row.returned } : {}),
      })),
      // Whether any row here recorded WHICH arms it moved. False is not the
      // same fact as an empty `movedElsewhere`: one says the input reached
      // nothing, the other says nobody wrote down what it reached, and the
      // kind on this item is only evidence in the first case. Said as a field
      // rather than left to be inferred from an empty list.
      armsObserved: observedArms(rows),
      movedElsewhere: elsewhere,
      // THE EXECUTION TRACE, per row, in the fields it is read in. This is what
      // groups are formed on and what a `wrong-side` item is answered from: not
      // "the claim was FALSE", but where execution stopped, which boundaries
      // were consumed, which were declared and never touched, and which arms
      // moved.
      trace: rows.map(traceOf),
      // THE ROWS THE RECORDER NEVER RAN, with its own sentence about each.
      //
      // A SEPARATE FIELD FROM `observed`, deliberately. A skipped proposal is
      // not an observation that came out empty — nothing was observed at all —
      // and merging the two would put "there is no observation to reassess" back
      // on an item that has a written reason sitting next to it. `about` says
      // whose failure the sentence is, so the agent can tell a proposal to
      // repair from a tool to report.
      skipped: skips.map((skip) => {
        const d = skipDiagnosis(skip);
        return {
          proposal: skip.id,
          file: skip.file ?? null,
          reason: skip.reason ?? null,
          about: d.about,
          outcome: d.outcome,
          route: d.outcome ? OUTCOME_ROUTES[d.outcome] ?? null : null,
          rule: d.rule,
          says:
            d.about === SKIP_ABOUT.TOOLSET
              ? "THIS SENTENCE IS ABOUT THE RECORDER, NOT ABOUT THE PROPOSAL. No input fixes it and re-aiming one " +
                "wastes the round: report the tool. Run 20260916T223906Z spent an hour of rounds 7-9 repairing " +
                "inputs against `blocked egress: ... no boundary declared`, which 89e4714 then fixed in the toolset."
              : d.about === SKIP_ABOUT.PROPOSAL
                ? "This sentence names a field of the submitted document. Repair that field; the subject was never " +
                  "reached, so nothing is yet known about its behaviour."
                : "Nothing here classified whose failure this sentence is. It is the recorder's own bytes, verbatim. " +
                  "Read it before assuming it is a critique of the proposal — some of these are about the toolset.",
        };
      }),
    },
    // WHAT THIS FAILURE WAS, CLASSIFIED BEFORE THE QUESTION WAS ASKED, with the
    // evidence each rule read named beside it so a wrong route is arguable
    // rather than mysterious. `route` is "tool" for exactly the three failures
    // in `MECHANICAL` and "agent" for everything else.
    diagnosis: diagnosis ?? null,
    // THE DOCUMENTS TO EDIT — AND, SEPARATELY, WHERE YOUR EDIT GOES.
    //
    // THE DEFECT, and it made a repair item unanswerable. The only two write
    // targets an item named were `.claude/charpilot/proposals` and
    // `.claude/charpilot/proposals/BLOCKED.md`. Both are under `.claude/`,
    // which the agent harness refuses to let an agent write, above the project
    // allowlist and unreachable by any setting in this repo — so a repair item
    // had no legal way to be ANSWERED and no legal way to be DECLARED BLOCKED
    // either. If the repair failed there was nowhere to say so.
    //
    // So the destination and the route are two fields and are named as what
    // they are. `readOnlyAt` is where the tools materialise what you submit: an
    // address to read, never a place to write. `submitTo` is the route, filled
    // in by the packet this item is filed into, and it is always the answers
    // directory outside `.claude/`.
    inputs: {
      readOnlyAt: here(proposalsDir),
      claims,
      // THE ROWS THEMSELVES — the file each already lives in and the `covers`
      // that decides which arms its `from` may name. A repair round pre-fills
      // no skeleton, so the row on disk is the only place either exists.
      rows: proposalRows,
      submitTo: null,
      says:
        "You never write into the directory above. Submit the repaired document to `submitTo`, and this step spawns " +
        "propose.mjs — which owns that format — to materialise it. A row that already exists is replaced by what " +
        "you submit under the file name it already lives in; that is why `submitTo.file` may be a name this round " +
        "did not derive.",
    },
    // THE LEGAL `covers` SET FOR THESE ROWS, and the rule that reads it.
    //
    // `from.arm` is the one address in a proposal that is neither pre-filled
    // nor free, and the run this step reassesses lost 95 of 99 quarantined rows
    // to it. In a DERIVE round the skeleton pre-fills the list; in a repair
    // round nothing does, so it is read off the rows on disk — and for a side
    // nothing has ever proposed there are no rows, so the honest answer is the
    // one arm this item is about, and it says that rather than pretending to a
    // set it does not have.
    proposal: {
      cite: {
        arms: citable,
        fields: [...CITE_FIELDS],
        prefilled: false,
        from: proposalRows.length ? "the `covers` of the rows this side already has on disk" : "this item's own arm — no row for this side exists yet, and a new row must list at least it",
      },
    },
    // The other honest answer, with the vocabulary the checker enforces so a
    // declaration is not refused for a word — and the SUBMISSION ROUTE, because
    // BLOCKED.md is under `.claude/` and is blocked.mjs's to write.
    declaration: {
      submitTo: null,
      key: "declarations",
      required: ["arm", "side", "category", "proof", "killer"],
      categories: [...CATEGORIES],
      killers: [...KILLERS],
      note:
        "a fenced ```blocked``` block. `fix` is required for data-blocked. A proof must be a " +
        "file:line that makes the side impossible — the arm's own line is a restatement, not evidence.",
      readOnlyAt: here(join(proposalsDir, "BLOCKED.md")),
      materialisedBy:
        "blocked.mjs, spawned by this step. It is the only sanctioned writer of that file: a hand-written fence is " +
        "not tagged ```blocked, ledger.mjs's FENCE regex matches only that tag, and run 20260916T112101Z looped " +
        "three rounds over ten sides reporting `0 has a written reason` for exactly that.",
    },
    // Why this side is a blocked candidate, when it is one. Present and empty
    // otherwise, so an item never has to be read twice to learn it is not.
    failedTwice: twice,
    loop,
    // THE RULE EVERYTHING RESTS ON, carried in the document the answering turn
    // reads rather than left in a prompt it may have scrolled past.
    rule:
      "You may change inputs. You never change what the code returned. A recorded value that looks " +
      "wrong is a defect found in the service, not a value to fix: say so and leave it recorded.",
  };
}

/**
 * The one line the walk prints for an item.
 *
 * The arm, the side and the shape of the condition, because those three are
 * what makes one of 400 items distinguishable in a log. `oneLine` strips
 * literals: the verbatim source is in `context`, where it is read as evidence,
 * and a log line carrying a value is a value that gets pasted.
 */
export function question(kind, { item, armId, side, elsewhere, twice, rows, armsObserved, diagnosis }) {
  const where = sideId(armId, side);
  const cond = item ? oneLine(decisiveText(item)) : null;
  const of = cond ? ` of \`${cond}\`` : "";
  const fn = item?.owner?.name ?? item?.owner?.functionId ?? "the owning function";
  // A row that recorded an outcome is a row somebody could be tempted to
  // "correct". Said on the item itself, not only in `context`.
  const froze = rows.some((r) => "returned" in r || "threw" in r)
    ? " The recorded outcome is what the service did: if it looks wrong that is a defect to report, never a value to rewrite."
    : "";

  // WHAT THE CLASSIFIER ALREADY SETTLED, appended rather than substituted. The
  // kind is still the prompt's routing hint; this sentence says which failure
  // it was, who answers it and — for the three mechanical ones — that the
  // correction is already computed and does not need deriving.
  // THE SKIP REASON, ON THE QUESTION AND NOT ONLY IN `context`. A skip is the
  // only failure where the first sentence an agent reads decides whether it
  // spends the round on the right artifact, and `20260916T223906Z` shows what
  // the wrong first sentence costs: three rounds and about an hour repairing
  // inputs against a defect that was in the recorder.
  const said = diagnosis?.evidence?.skipped?.[0]?.reason ?? null;
  const skipped = said
    ? ` The recorder did not run it and said why, verbatim: "${said}". That sentence is about ` +
      (diagnosis.about === "toolset"
        ? "THE TOOLSET, not this proposal — no input fixes it, so report the tool rather than re-aiming an input."
        : diagnosis.about === "proposal"
          ? "the PROPOSAL — repair the field it names."
          : "something this step could not classify: read it before treating it as a critique of the proposal.")
    : "";
  const routed = diagnosis
    ? ` Classified \`${diagnosis.failure}\` from ${diagnosis.reads}: ${diagnosis.action}.` +
      skipped +
      (diagnosis.route === "tool"
        ? " This is a mechanical repair and the correction is in `context.diagnosis.evidence` — apply it, do not re-derive the input."
        : "")
    : "";

  switch (kind) {
    case "blocked-candidate":
      return (
        `${where}: this side has failed to move twice — ${twice.join("; ")}. Two answers are honest: ` +
        `an input that reaches it, or a declaration that nothing reaches it in this deployment, with proof.${froze}${routed}`
      );
    // NO INPUT EXISTS FOR THIS SIDE. `derive` no longer gates the pipeline on
    // closing every side (5c6732c), so this step receives sides that were never
    // PROPOSED as well as sides whose claims missed. Nothing ran, so this
    // question says nothing ran: it does not send the reader to
    // `context.recorded.observed`, which is empty, and it does not describe an
    // aiming failure, because nothing was aimed.
    case "not-proposed":
      return (
        `${where}: NO input exists for this side — no proposal's \`reaches\` names it, so nothing has been ` +
        `run at it and \`context.recorded\` is empty. This is not an aiming failure and there is nothing to ` +
        `reassess. Write an input for \`${side}\`${of} in ${fn}, or declare with proof that nothing reaches it ` +
        `in this deployment.${routed}`
      );
    case "false-claim":
      return (
        `${where}: the input reached ${elsewhere[0].armId} [${elsewhere[0].side}] and NOT the side it claimed — ` +
        `that is coverage landing where nobody aimed, and it reads as coverage for this side. ` +
        `Fix the address or fix the input, and say which.${froze}${routed}`
      );
    default:
      return (
        `${where}: the input ran and \`${side}\`${of} in ${fn} is still uncovered` +
        (armsObserved ? "" : ", and no row recorded which arms it moved, so whether it reached another arm is not on the disk") +
        `. Read the arguments as built and the boundary answers as applied in \`context\`, then say what to change.${froze}${routed}`
      );
  }
}

/**
 * The one question a whole group is asked as.
 *
 * ONE SCENARIO WRONG, ONE QUESTION. Run `20260916T112101Z` asked six, because
 * six missed claims came out of a single Google Maps proposal and each was
 * handed over on its own. The lead's question is kept whole — it carries the
 * arm, the condition and the frozen-outcome rule — and the group's sentence is
 * put in front of it, naming every side the one fix is expected to close.
 *
 * The sentence says WHAT THEY SHARE in execution terms, never in words
 * somebody wrote: where the run stopped, which arms moved, which boundaries
 * were consumed and which were declared and never touched.
 */
export function groupQuestion(leadQuestion, { members, trace, failure }) {
  const first = trace?.[0] ?? null;
  const shared = [];
  if (first) {
    shared.push(first.subjectCallStarted === false ? "the subject call never started" : "the subject call ran");
    if (first.stoppedInArrangement) shared.push("and stopped in the arrangement");
    shared.push(
      first.armsMoved === null
        ? "no row recorded which arms moved"
        : first.armsMoved.length
          ? `the same arms moved (${first.armsMoved.join(", ")})`
          : "no arm moved at all"
    );
    if (first.boundaryCallsConsumed !== null) {
      shared.push(
        first.boundaryCallsConsumed.length
          ? `the same boundary calls were consumed (${first.boundaryCallsConsumed.join(", ")})`
          : "no boundary call was consumed"
      );
    }
    if (first.boundariesDeclaredAndUnused?.length) {
      shared.push(`the same declared boundaries went unused (${first.boundariesDeclaredAndUnused.join(", ")})`);
    }
  }
  return (
    `${members.length} sides failed as ONE \`${failure}\` with ONE execution trace — ${shared.join("; ")}. ` +
    `They are grouped on that trace and not on any message, so they share a cause: fix it ONCE and all ` +
    `${members.length} are expected to close. The sides: ${members.join(", ")}. ` +
    `The lead side, in full — ${leadQuestion}`
  );
}

/* ------------------------------------------------------------------------ *
 * THE WITHDRAWAL — a FALSE claim taken back off the row that made it.
 *
 * `2137a73` built the channel and proved it against real artifacts: a FALSE
 * claim is removed from a row's `reaches`, the side goes ACCOUNTED ->
 * UNACCOUNTED, `ledger.loadProposed` drops from 188 to 187 claimed sides, and
 * the rest of the file is byte-identical. NOTHING SPAWNED IT. A corpus replay
 * on the fixed toolset measured 20 claims FALSE and 30 sides still uncovered —
 * that is the population this exists for, visible for the first time because
 * those rows now record at all.
 *
 * WHY HERE. This step is the one that reads `coverage.json`, and `falseClaims`
 * is coverage.mjs's own verdict. It is also the step whose `satisfied` asks the
 * ledger, and the ledger counts a side accounted the moment some `reaches`
 * names it — so a FALSE claim left on disk is a run that can CLOSE on coverage
 * nothing produced. That is the 62.7% of run `20260916T024808Z` with a
 * different cause.
 *
 * ONE CALL PER `falseClaims` ENTRY, and there is no batch flag and there must
 * not be. `propose.mjs --withdraw` takes one claim, named in full, with the
 * artifact that judged it. A batch flag would be a coverage reduction applied
 * from a list, and the one direction this must fail in is "withdrew too few".
 *
 * IT IS SPAWNED, exactly as `proposeArgv` spawns the submission path
 * (derive.mjs:748), so `steps.never-repair-a-tools-output.test.mjs` stays true:
 * this step reads the measurement and spawns the tool that owns the format. It
 * writes nothing.
 *
 * NEVER `blocked.mjs`, AND THE ROUTE IS NOT A MATTER OF TASTE. A blocked entry
 * has the ledger count the side accounted WITH A WRITTEN REASON, it trips the
 * ledger's `doubleClaimed` check against the `reaches` that is still there, and
 * none of `data-blocked` / `code-dead` / `needs-seam` is a claim a machine can
 * make out of a failed recording — which is the invitation `repair.mjs:381-392`
 * (`failedTwice`'s no-claims guard) already refuses. Withdrawn returns the side
 * to UNACCOUNTED, which is its true state.
 *
 * TWO REFUSALS, AND THEY ARE ROUTED IN OPPOSITE DIRECTIONS. This is the whole
 * of how this fails in practice:
 *
 *   `claims exactly one thing`   withdrawing a row's ONLY claim would leave a
 *                                row that still validates, still records and
 *                                still emits a test while speaking for nothing.
 *                                propose.mjs calls that a row DELETION and
 *                                refuses it. IT IS THE COMMON CASE, not an
 *                                edge: 1 of 1 on `20260916T223906Z` and 10 of
 *                                55 on `20260915T111114Z`. A caller that reads
 *                                it as a failure to retry spins on it every
 *                                round forever, so it is routed as an OPEN
 *                                DECISION — handed to a person, never retried.
 *
 *   `another writer holds`       the lock. Transient, and the file is untouched,
 *                                so this one IS retried.
 *
 * AND IT IS IDEMPOTENT AGAINST A STALE MEASUREMENT. `coverage.json` is not
 * rewritten by a withdrawal, so next round it still lists the claim it listed
 * this round. Asking propose.mjs again would earn `does not claim ... so there
 * is nothing to withdraw` and turn a completed withdrawal into an open decision
 * that never closes. So the PROPOSALS ON DISK decide: a claim the row no longer
 * states has already been withdrawn, and nothing is spawned for it.
 * ------------------------------------------------------------------------ */

/** The tool that owns `reaches`, and the only writer of a withdrawal. */
export const WITHDRAW_TOOL = "propose.mjs";

/** How many times the lock is worth waiting out before it becomes a question. */
export const WITHDRAW_ATTEMPTS = 3;

/**
 * propose.mjs's whole command line, as a function so a test can assert it
 * exactly — one claim, named in full, with the artifact that judged it.
 *
 * `--file` is always passed when the row's file is known. A proposal id that
 * appears in two files is a refusal propose.mjs raises by design ("is in N
 * places"), and naming the file is how the caller says which row it meant
 * rather than discovering the ambiguity as a failure.
 */
export function withdrawArgv(id, { arm, side, evidence, file = null }) {
  return [
    "--withdraw",
    id,
    "--claim",
    `${arm} [${side}]`,
    "--evidence",
    evidence,
    ...(file ? ["--file", file] : []),
  ];
}

/**
 * propose.mjs's OWN SENTENCES, anchored to the lines that print them.
 *
 * Matched rather than re-derived, for the reason `NOT_A_SIDE` above is: the
 * rule is in the sentence, and this step holds no second copy of it. A reworded
 * refusal stops matching here and falls through to `null` — which routes it as
 * an open decision with the tool's bytes quoted, the safe direction, because
 * the unsafe one is retrying something that will never succeed.
 */
export const WITHDRAW_REFUSALS = Object.freeze({
  ROW_DELETION: Object.freeze({ at: "propose.mjs:676", re: /claims exactly one thing/ }),
  LOCKED: Object.freeze({ at: "propose.mjs:724", re: /another writer holds/ }),
});

/** Which refusal this is: `row-deletion`, `locked`, or null for anything else. */
export function withdrawRefusal(text) {
  const said = String(text ?? "");
  if (WITHDRAW_REFUSALS.ROW_DELETION.re.test(said)) return "row-deletion";
  if (WITHDRAW_REFUSALS.LOCKED.re.test(said)) return "locked";
  return null;
}

/**
 * Every proposal row on disk, keyed by id: the file it lives in, what it still
 * CLAIMS, and the `covers` that decides which arms its `from` may name.
 *
 * ONE READ FOR THREE QUESTIONS, because they are three questions about the same
 * bytes and a second pass over the directory would be a second opinion about
 * what is in it. `withdrawFalseClaims` asks whether a claim is still stated;
 * `contextFor` asks which arms are citable; the packet asks WHICH FILE a row
 * lives in, which is the name its repair has to be submitted under.
 *
 * A duplicated id is propose.mjs's refusal to raise, not this step's to
 * resolve: the first row seen is kept and `--file` is passed, so the tool
 * decides rather than this guessing which row was meant.
 */
export function proposalRowsById(proposalsDir) {
  const out = new Map();
  for (const row of flatProposals(proposalsDir)) {
    if (!row.id) continue;
    const claims = [];
    for (const [armId, value] of Object.entries(row.reaches ?? {})) {
      for (const side of Array.isArray(value) ? value : [value]) claims.push(`${armId} [${side}]`);
    }
    if (!out.has(row.id)) out.set(row.id, { id: row.id, file: row.file, claims, covers: [...(row.covers ?? [])], reaches: row.reaches ?? {} });
  }
  return out;
}

/**
 * Withdraw every FALSE claim the measurement recorded, one call each.
 *
 * Returns `{ did, metrics, open }` and NEVER throws. `open` is the decisions
 * that came back — pending items like any other — and every one of them quotes
 * propose.mjs's own bytes rather than a paraphrase of them.
 */
export function withdrawFalseClaims(p, { coverage, evidence }) {
  const did = [];
  const open = [];
  const metrics = { falseClaimsSeen: 0, withdrawn: 0, withdrawalsAlreadyDone: 0, withdrawalDecisions: 0, withdrawalRetries: 0 };
  const claims = coverage?.falseClaims ?? [];
  metrics.falseClaimsSeen = claims.length;
  if (!claims.length) return { did, open, metrics };

  const script = p.tool(WITHDRAW_TOOL);
  if (!existsSync(script)) {
    did.push(
      `${claims.length} FALSE claim(s) stand, and ${here(script)} is not installed, so none can be withdrawn — ` +
        "re-run `.claude/charpilot/install.sh`. Until then the ledger counts each of those sides as accounted"
    );
    return { did, open, metrics };
  }

  const onDisk = proposalRowsById(p.proposalsDir);
  for (const claim of claims) {
    const stated = `${claim.armId} [${claim.side}]`;
    const row = onDisk.get(claim.id) ?? null;
    // ALREADY WITHDRAWN. The measurement is not rewritten by a withdrawal, so
    // it names this claim for as long as it stands; the documents are what say
    // whether it still exists.
    if (!row || !row.claims.includes(stated)) {
      metrics.withdrawalsAlreadyDone += 1;
      continue;
    }

    let res = null;
    for (let attempt = 1; attempt <= WITHDRAW_ATTEMPTS; attempt += 1) {
      res = p.spawn(script, withdrawArgv(claim.id, { arm: claim.armId, side: claim.side, evidence, file: row.file }), { cwd: p.repo });
      if (res.status === 0) break;
      // THE LOCK, AND ONLY THE LOCK. Two withdrawals against one file are two
      // read-modify-writes and propose.mjs holds a lock across them; the file
      // is untouched when it refuses, so running it again is the whole fix.
      if (withdrawRefusal(res.stderr || res.stdout) !== "locked") break;
      metrics.withdrawalRetries += 1;
    }

    if (res.status === 0) {
      metrics.withdrawn += 1;
      did.push(`withdrew ${stated} from ${claim.id} in ${row.file} — the side is UNACCOUNTED again, which is its true state`);
      continue;
    }

    const said = (res.stderr || res.stdout || "").trim();
    const refusal = withdrawRefusal(said);
    metrics.withdrawalDecisions += 1;
    open.push({
      // NOT a side id. `previouslyAsked` collects the ids of what this step
      // handed over and uses them to decide a side has failed twice; a
      // withdrawal decision is not an attempt at the side, and an id that
      // looked like one would push the side towards a suppression on the
      // strength of a question about a document.
      id: `withdrawal ${claim.id} — ${stated}`,
      kind: "withdrawal",
      file: claim.file ?? null,
      line: claim.line ?? null,
      question:
        refusal === "row-deletion"
          ? `${claim.id} claims ONLY ${stated}, and the measurement says that claim is FALSE. Withdrawing it would ` +
            `leave a row that still validates, still records and still emits a test while speaking for no side, so ` +
            `propose.mjs refuses it as a row DELETION and this is the decision it wants: repair the input so it ` +
            `reaches ${stated}, or remove the row deliberately. THIS IS NOT A RETRY — nothing here will make the ` +
            `refusal go away, and re-running it every round is the loop this routing exists to avoid.`
          : `the FALSE claim ${stated} on ${claim.id} could not be withdrawn, and the measurement still says nothing ` +
            `reaches it. Until it is taken off the row the ledger counts that side as accounted. propose.mjs's own ` +
            `refusal is in \`context.refusal.said\`; act on that sentence.`,
      context: {
        refusal: {
          by: WITHDRAW_TOOL,
          kind: refusal ?? "unrecognised",
          at: refusal === "row-deletion" ? WITHDRAW_REFUSALS.ROW_DELETION.at : refusal === "locked" ? WITHDRAW_REFUSALS.LOCKED.at : null,
          retried: refusal === "locked",
          // The tool's bytes, whole. A summary of a refusal is a refusal
          // nobody can act on.
          said,
          argv: withdrawArgv(claim.id, { arm: claim.armId, side: claim.side, evidence, file: row.file }),
        },
        claim: { proposal: claim.id, file: row.file, arm: claim.armId, side: claim.side, hits: claim.hits ?? 0, mechanism: claim.mechanism ?? null },
        stillClaims: row.claims,
        evidence: { document: here(evidence), says: `${stated} was measured FALSE — the input did not reach the side it named` },
        // SAID ON THE ITEM, because it is the route somebody will reach for.
        rule:
          "This is NOT a `blocked` declaration. A blocked entry has the ledger count the side accounted WITH a " +
          "written reason and trips its `doubleClaimed` check against the `reaches` that is still there, and none of " +
          "`data-blocked` / `code-dead` / `needs-seam` is a claim anybody can make out of a failed recording. " +
          "Withdrawn returns the side to UNACCOUNTED, which is what it is.",
      },
    });
  }

  if (metrics.withdrawn) {
    did.push(
      `withdrew ${metrics.withdrawn} of ${claims.length} FALSE claim(s) by spawning ${WITHDRAW_TOOL} once each — ` +
        `each of those sides stops counting as accounted in the ledger, which is the number going DOWN correctly`
    );
  }
  if (metrics.withdrawalsAlreadyDone) {
    did.push(
      `${metrics.withdrawalsAlreadyDone} of them are already off their row — ${here(evidence)} still names them because ` +
        "a withdrawal does not rewrite the measurement, so the documents on disk decide and nothing was spawned for them"
    );
  }
  if (metrics.withdrawalDecisions) {
    did.push(
      `${metrics.withdrawalDecisions} withdrawal(s) came back as an OPEN DECISION rather than a retry — a row whose ` +
        "only claim is false is a row DELETION and wants a ruling, and re-running it every round is the loop this avoids"
    );
  }
  return { did, open, metrics };
}

/* ------------------------------------------------------------------------ *
 * REPAIR'S ITEMS ARE PACKETED TOO, AND ON THE SAME KEY DERIVE USES.
 *
 * WHAT WAS WRONG. This step declared no bundle at all, so `workflow.bundlesOf`
 * synthesised a name per item and every repair item became its own one-item
 * file. That is safe in the narrow sense — a one-item packet cannot be split —
 * and it fails the invariant the packet exists for one level up: TWO
 * `unreached` sides of ONE function land in two files with two briefs, and two
 * workers then read that function separately and answer from different context.
 * "Two readings of one function disagree about the same subject" is exactly
 * what `derive.packet.test.mjs` refuses, arriving through the back door.
 *
 * THE KEY IS THE OWNING FUNCTION, which is `derive`'s key (`ownerKey`), because
 * the thing being made cheap is the same thing: one reading of one function
 * answers every side of it. A side whose owner could not be resolved is filed
 * on its own, which is the honest default and not a fallback — nothing is known
 * about it that would group it with anything.
 *
 * A COLLAPSED GROUP IS ONE ITEM and is filed by its LEAD's function. A cluster
 * is formed on the execution trace and may span functions; it is still one
 * question with one answer, so it belongs in one file, and the lead's function
 * is the one its brief is written from.
 * ------------------------------------------------------------------------ */

/**
 * The packet block for one function's repair items, shared by all of them.
 *
 * `sides` and `count` are filled by the caller once the round is grouped: a
 * header that named a subset of its own file's items would be a roster that
 * silently drops work, which is worse than no roster.
 *
 * EVERYTHING ELSE ON IT IS FURNITURE — where to write, which `mock.kind`
 * installs, the limits, the checkpoint, the parallelism rule and the citation
 * rule. It is here, once per packet FILE, and never once per item: `derive`'s
 * handover was 1.4 MB and its answering turn scripted over it, and `53b09bc`
 * fixed that by making a packet self-contained and small. Every one of these
 * blocks is about the RULES and not about a side, so one copy per file is all
 * any reader of that file needs.
 *
 * WHICH FILE THE ANSWERS GO IN IS NOT ALWAYS THE DERIVED NAME. See `answersFile`
 * below: a packet whose rows already live in a proposals file names THAT file,
 * because `propose.mjs` materialises a submission under its own file name and
 * `validate.mjs` keeps `seen` ids across the whole flattened proposals
 * directory — so a repaired row under a fresh name is `duplicate id` and
 * nothing else.
 */
export function repairPacketHeader({ key = null, functionId, name, file, line, answersFile = null, existing = [], limits = null, schema = null }) {
  // `key` is for a packet that is not one function's — the withdrawal decisions
  // about one proposals file — where `functionId` is genuinely null and two
  // such packets would otherwise share the id "repair packet unresolved", which
  // is two different pieces of work reserving one answer file name.
  const id = `repair packet ${key ?? functionId ?? file ?? "unresolved"}`;
  return {
    id,
    functionId: functionId ?? null,
    name: name ?? null,
    file: file ?? null,
    line: line ?? null,
    count: 0,
    sides: [],
    repeats: [],
    shared: {},
    // ONE NAME PER PACKET, and the DIRECTORY beside it, because either half on
    // its own is an address the reader has to complete. The same block
    // `derive`'s packets carry, from the same function, so the two cannot
    // describe the answering route differently.
    answers: answersBlock({ packetId: id, file: answersFile, existing }),
    // HOW MUCH MAY BE ANSWERED, AND THE CHECKPOINT INSIDE IT. `derive`'s own
    // `roundLimits`, called with this round's numbers — the numbers are this
    // round's and the four sentences are every round's, which is exactly the
    // split that function exists to keep.
    ...(limits ? { limits } : {}),
    // WHICH `mock.kind` INSTALLS and one worker per packet — the same frozen
    // objects a derive packet carries, so the two cannot drift apart.
    ...packetFurniture(),
    // AND THE CITATION RULE. `derive` states this per row in `proposal.rules`,
    // which a repair round has no skeleton to build; here it is the packet's,
    // beside the `proposal.cite.arms` each item carries.
    covers: COVERS_RULE,
    // THE VOCABULARIES, PRINTED BY THE TOOL THAT ENFORCES THEM. Absent rather
    // than empty when it could not be printed, and it says why: a block that
    // was there and said nothing is a block a reader has to decide to ignore.
    ...(schema ? { schema } : {}),
    why:
      "these sides are one piece of work: they are arms of the same function, and one reading of it answers all of " +
      "them. Each still needs its own answer, one per side, addressed by its own id. THIS FILE IS THE WHOLE JOB: " +
      "nothing in it sends you to another file.",
  };
}

/**
 * The vocabularies `validate.mjs --schema` prints, or the reason there are none.
 *
 * SPAWNED, NEVER TRANSCRIBED. The printout partitions every `mock.kind` by
 * asking `record.mjs`'s own `boundaryDisposition`, so it cannot drift from the
 * recorder; a table in a step could, and the one that did cost 20 false claims.
 *
 * SOFT, unlike `derive`'s. A derive round cannot brief a side without the
 * vocabulary and refuses when it is missing. A repair round is reassessing rows
 * that already exist and can still say every true thing about them without it,
 * so a missing tool degrades one block and never the round — and the block says
 * so instead of being silently absent.
 */
export function schemaBlock(paths, repo) {
  try {
    const text = readSchema({ tool: paths.tool, exec: paths.spawn, cwd: repo });
    if (!text) return null;
    return {
      of: CHECKPOINT_TOOL,
      printedBy: `node .claude/charpilot/${CHECKPOINT_TOOL} --schema`,
      says:
        "Printed from the constants the checker enforces, never transcribed. The `mock.kind` rows say which kinds " +
        "record.mjs INSTALLS and which ones drop an answer written beside them. If this and a document disagree, " +
        "this is right.",
      text,
    };
  } catch (err) {
    return {
      of: CHECKPOINT_TOOL,
      printedBy: `node .claude/charpilot/${CHECKPOINT_TOOL} --schema`,
      text: null,
      unavailable: String(err?.message ?? err).split("\n")[0],
      says:
        "The vocabularies could not be printed this round, so they are ABSENT rather than guessed. Re-run " +
        "`.claude/charpilot/install.sh` and they come back; the `mockKinds` block above states the one distinction " +
        "that decides whether your answer is installed at all.",
    };
  }
}

/** Which packet an item belongs to: its owner's function, or itself alone. */
export function repairBundleKey(item) {
  return item?.context?.owner?.functionId ?? `alone ${item?.id}`;
}

/**
 * Which proposals files a packet's rows already live in, with the ids in each.
 *
 * THE WHOLE PACKET DECIDES, not one item, because the answer file name is the
 * packet's and a header that named a file one of its own items disagreed with
 * would be the silent-truncation failure arriving by a different road.
 */
export function filesOfRows(items) {
  const byFile = new Map();
  for (const item of items) {
    for (const row of item?.context?.inputs?.rows ?? []) {
      if (!row?.file) continue;
      if (!byFile.has(row.file)) byFile.set(row.file, new Set());
      if (row.id) byFile.get(row.file).add(row.id);
    }
  }
  return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, ids]) => ({ file, ids: [...ids].sort() }));
}

/**
 * The item with its submission route filled in — and nothing else touched.
 *
 * THE ROUTE IS THE PACKET'S, so it cannot be known while the item is being
 * built: `contextFor` leaves both fields `null` and they are filled here, once
 * the packet that owns them exists. Both name the answers directory, which is
 * the only directory the agent may write; neither ever names a path under
 * `.claude/`, because the harness refuses writes there above the project
 * allowlist and an instruction to write there is an instruction that cannot be
 * carried out.
 */
export function routedTo(context, answers) {
  if (!context || typeof context !== "object" || !answers) return context;
  const to = { directory: answers.directory, file: answers.file };
  const out = { ...context };
  if (out.inputs) out.inputs = { ...out.inputs, submitTo: { ...to, key: "proposals" } };
  if (out.declaration) out.declaration = { ...out.declaration, submitTo: { ...to, key: "declarations" } };
  return out;
}

/**
 * TWO PACKETS MUST NEVER NAME ONE SUBMISSION FILE, so packets whose rows share
 * a proposals file are ONE packet.
 *
 * THE HAZARD THIS CLOSES, and it is the one this codebase calls the worst.
 * Naming the file a packet's rows already live in is what stops a repaired row
 * being refused as a `duplicate id` — but two packets whose rows live in the
 * SAME file then reserve the same name, and two workers writing one name is not
 * a merge and not a conflict: it is a silently truncated submission that reads
 * downstream as an agent that answered fewer questions than it did. A round
 * that fixed the duplicate-id refusal by creating that is not a fix.
 *
 * MERGING ONLY EVER MAKES A PACKET BIGGER, which is why it is safe against the
 * invariant one level up: every side of a function is still in one file, and
 * `derive.packet`'s refusal — two readings of one function must not disagree —
 * is strengthened rather than weakened. What joins them is a real relation:
 * `propose.mjs` materialises a submission under its own file name and replaces
 * what is there, so rows that share a destination share a submission.
 *
 * Union-find over the group keys, with the FILE as the thing that joins two.
 * A group with no rows on disk joins nothing and keeps its own derived name.
 */
export function mergeByAnswerFile(filesByKey) {
  const parent = new Map([...filesByKey.keys()].map((k) => [k, k]));
  const find = (k) => {
    let at = k;
    while (parent.get(at) !== at) at = parent.get(at);
    while (parent.get(k) !== at) {
      const next = parent.get(k);
      parent.set(k, at);
      k = next;
    }
    return at;
  };
  const owner = new Map();
  for (const [key, files] of filesByKey) {
    for (const file of files) {
      if (!owner.has(file)) {
        owner.set(file, find(key));
        continue;
      }
      const a = find(owner.get(file));
      const b = find(key);
      if (a !== b) parent.set(b, a);
      owner.set(file, find(a));
    }
  }
  return new Map([...filesByKey.keys()].map((k) => [k, find(k)]));
}

/**
 * THE WITHDRAWAL DECISIONS ARE PACKETS TOO, one per proposals file.
 *
 * They used to declare no bundle at all, so the walk filed each on its own —
 * and a file the walk synthesises carries NO header this step wrote, which
 * means no answer file name, no limits, no checkpoint and no `mock.kind` rule.
 * On the live round that was 17 of the 19 packet files: the greps that found
 * `charpilot-answers: 0` and `mock.kind: 0` ACROSS ALL 19 FILES were mostly
 * finding these. A decision about a row is answered by repairing or removing
 * that row, so the same furniture is exactly what it needs — and the file the
 * row already lives in is the name the repair has to be submitted under.
 */
export function withdrawalKey(item) {
  const file = item?.context?.claim?.file ?? null;
  return { key: `withdrawals in ${file ?? "an unnamed file"}`, file };
}

/**
 * Every packet of a round, headers built and items routed — for both kinds of
 * item, in one place, because both need the same furniture and both compete for
 * the same submission file names.
 *
 * `entries` is `[{ item, key, files }]`: the group the item was put in and the
 * proposals files its rows live in. Packets that share a file are merged first
 * (see `mergeByAnswerFile`), so no two headers can reserve one name.
 */
export function packetsOf(entries, { limits = null, schema = null } = {}) {
  const filesByKey = new Map();
  for (const { key, files } of entries) {
    if (!filesByKey.has(key)) filesByKey.set(key, new Set());
    for (const file of files) filesByKey.get(key).add(file);
  }
  const canonical = mergeByAnswerFile(filesByKey);

  const merged = new Map();
  for (const { key } of entries) {
    const to = canonical.get(key) ?? key;
    if (!merged.has(to)) merged.set(to, new Set());
    for (const file of filesByKey.get(key) ?? []) merged.get(to).add(file);
  }

  const headers = new Map();
  const leads = new Map();
  for (const entry of entries) {
    const to = canonical.get(entry.key) ?? entry.key;
    if (!leads.has(to)) leads.set(to, entry.item);
  }
  for (const [to, files] of merged) {
    const lead = leads.get(to);
    const existing = [...files].sort().map((file) => ({ file, ids: [] }));
    headers.set(
      to,
      repairPacketHeader({
        key: lead?.context?.owner?.functionId ? null : to,
        functionId: lead?.context?.owner?.functionId ?? null,
        name: lead?.context?.owner?.name ?? null,
        file: lead?.context?.owner?.functionId ? lead?.file ?? lead?.context?.arm?.file ?? null : null,
        line: lead?.context?.owner?.functionId ? lead?.line ?? lead?.context?.arm?.line ?? null : null,
        // A PACKET WHOSE ROWS ALREADY LIVE IN A FILE NAMES THAT FILE. Only when
        // there is exactly ONE of them: with two, no single name is right for
        // the whole packet, and `answersBlock` says so and lists them rather
        // than picking one.
        answersFile: existing.length === 1 ? existing[0].file : null,
        existing,
        limits,
        schema,
      })
    );
  }

  const items = entries.map(({ item, key }) => {
    const header = headers.get(canonical.get(key) ?? key);
    header.sides.push(item.id);
    header.count = header.sides.length;
    for (const row of item.context?.inputs?.rows ?? []) {
      const at = header.answers.existing?.find((e) => e.file === row.file);
      if (at && row.id && !at.ids.includes(row.id)) at.ids.push(row.id);
    }
    const claim = item.context?.claim ?? null;
    if (claim?.file && claim?.proposal) {
      const at = header.answers.existing?.find((e) => e.file === claim.file);
      if (at && !at.ids.includes(claim.proposal)) at.ids.push(claim.proposal);
    }
    // THE SUBMISSION ROUTE, FILLED IN FROM THE PACKET THAT OWNS IT. Until this
    // point the item names where its rows are READ and nowhere to write.
    return { ...item, context: routedTo(item.context, header.answers), [BUNDLE_KEY]: header };
  });
  return { items, headers };
}

/**
 * D64 — the one item the sides the recorder refused ever produce, and only
 * when the ledger is the last thing holding the run.
 *
 * ONE ITEM FOR ALL OF THEM, because it is one fact with several addresses: the
 * recorder named a boundary it could not cross, and the same double clears
 * every side behind it. Five packets asking five turns to derive five inputs
 * is what run 20260919T142723Z did, and none of the five could have worked.
 *
 * It carries the recorder's sentences verbatim and it claims NOTHING about
 * reachability: this is not a declaration that the sides are unreachable, and
 * an agent must not write one on this evidence alone. The arm is live, and the
 * question is only which of the two moves the repo wants.
 */
export function undeliverableItem(undeliverable, coverage) {
  const rows = new Map((coverage?.stillUncovered ?? []).map((r) => [sideKey(r.armId, r.side), r]));
  const named = undeliverable.map((u) => {
    const row = rows.get(sideKey(u.armId, u.side));
    return { side: sideId(u.armId, u.side), file: row?.file ?? null, line: row?.line ?? null, function: row?.functionName ?? null, why: u.why };
  });
  const reasons = [...new Set(named.map((n) => n.why))];
  const first = named[0] ?? {};
  return {
    id: "undeliverable-sides",
    kind: "toolset",
    failure: SKIP_FAILURE[SKIP_ABOUT.TOOLSET],
    route: routeOf(SKIP_FAILURE[SKIP_ABOUT.TOOLSET]),
    question:
      `${named.length} uncovered side(s) have no deliverable answer in this mode and the ledger counts them ` +
      `UNACCOUNTED, which is the only thing still holding this run. The recorder refused to exercise their ` +
      `function and said why, in its own words: ${reasons.map((r) => JSON.stringify(r)).join("; ")}. ` +
      `DO NOT derive an input and DO NOT write a reason claiming the arm is unreachable — it is live, and no ` +
      `argument reaches it while the recorder will not call the function. Two moves end this, either one: (1) give ` +
      `the fixture a double for the boundary the recorder named, after which the next recording carries no skip, ` +
      `the next measurement marks no row, and these sides are worked normally again with nothing to withdraw; or ` +
      `(2) write the fenced BLOCKED.md entry for each side, quoting the recorder's sentence as the evidence, which ` +
      `is the accounting the ledger is asking for. Either way the coverage number does not move: these sides are ` +
      `live code, they are in the denominator, and they are counted as uncovered now and after.`,
    file: first.file ?? null,
    line: first.line ?? null,
    context: {
      undeliverable: {
        saidBy: "record.mjs",
        sides: named,
        counted: "uncovered, in the denominator — declaring these changes no rate",
      },
    },
  };
}

/**
 * What `ledger.mjs --json` failed on that the agent can decide: the double
 * claims the measurement did not decide, and the code-dead entries a recorded
 * row contradicts whose side is still uncovered. `{ doubleClaimed, contradicted }`.
 *
 * Asked of the tool and never re-derived here: which of them the measurement
 * decides is the ledger's rule (`resolveDoubleClaim`, the superseded entry),
 * and a second copy of it in this step would be a second opinion that can
 * drift. A ledger that is not installed, will not run, or prints something
 * that is not its document gives empty lists, and its own line is still in
 * `did`.
 */
export function ledgerFindings(p) {
  const none = { doubleClaimed: [], contradicted: [], staleEntries: [], refused: [] };
  const script = p.tool(`${LEDGER_TOOL}.mjs`);
  if (!existsSync(script)) return none;
  const res = p.spawn(script, ["--json"], { cwd: p.repo });
  let doc;
  try {
    doc = JSON.parse(res?.stdout ?? "");
  } catch {
    return none;
  }
  return {
    doubleClaimed: (Array.isArray(doc?.doubleClaimed) ? doc.doubleClaimed : []).filter(
      (d) => d?.armId && typeof d.side === "string" && Array.isArray(d.claims) && d.claims.length
    ),
    contradicted: (Array.isArray(doc?.contradicted) ? doc.contradicted : []).filter((c) => c?.arm && typeof c.side === "string"),
    staleEntries: (Array.isArray(doc?.staleEntries) ? doc.staleEntries : []).filter((e) => e?.arm && typeof e.side === "string"),
    // D56: the entries it refused, one row per side, with its own sentence.
    refused: (Array.isArray(doc?.refused) ? doc.refused : []).filter((r) => r?.arm && typeof r.side === "string" && r.why),
  };
}

/**
 * D56 — A REFUSED ENTRY WHOSE SIDE IS NOT OPEN, asked as the document question
 * it is.
 *
 * A refused entry on an open side reopens that side and is asked there
 * (`refusedDeclarationNote`). This is the remainder: the entry is refused and
 * the measurement does not list its side as uncovered, and no recorded row
 * moved it (the ledger supersedes it then). Nothing measured retires it, so the
 * agent is asked to take it out - the same move a stale entry asks for.
 */
export function refusedEntryItem(r) {
  const side = sideId(r.arm, r.side);
  const [file, line] = String(r.arm).split("#");
  return {
    id: `refused entry ${side}`,
    kind: "refused-entry",
    file: file || null,
    line: Number.isInteger(Number(String(line ?? "").split(":")[0])) ? Number(String(line).split(":")[0]) : null,
    question:
      `BLOCKED.md rules ${side} ${r.category ?? "?"} (proof ${r.proof ?? "absent"}), and ${LEDGER_TOOL}.mjs refuses ` +
      `that entry: ${r.why} The side is not open in the last measurement, so the entry rules nothing and keeps the ` +
      `ledger failing. RETRACT it: delete that one fenced \`blocked\` block from BLOCKED.md and nothing else. If the ` +
      `side is still uncovered, declare it again with a SOURCE line as the proof, the way any declaration is submitted.`,
    context: { refusedDeclaration: { side, entry: { category: r.category ?? null, killer: r.killer ?? null, proof: r.proof ?? null }, why: r.why, saidBy: `${LEDGER_TOOL}.mjs` } },
  };
}

/**
 * The one question a stale BLOCKED.md entry asks: retract it (D46).
 *
 * ledger.mjs fails on an entry that names a side the work list does not know
 * at all: an arm that is gone, or a label that is not one of its sides. An
 * entry on a side that IS known and covered is superseded by the ledger itself
 * and never gets here. Nothing measured can decide an entry about nothing, and
 * the agent wrote it, so the agent is asked to take it out. Before this the
 * closing round quoted the ledger's line, asked nothing, and the walk ruled the
 * step a tool DEFECT.
 */
export function staleEntryItem(e) {
  const side = sideId(e.arm, e.side);
  const [file, line] = String(e.arm).split("#");
  return {
    // A question about a document, not an attempt at the side (see doubleClaimItem).
    id: `stale entry ${side}`,
    kind: "stale-entry",
    file: file || null,
    line: Number.isInteger(Number(String(line ?? "").split(":")[0])) ? Number(String(line).split(":")[0]) : null,
    question:
      `BLOCKED.md rules ${side} ${e.category ?? "?"} (proof ${e.proof ?? "absent"}), and the work list knows no such ` +
      `side: the arm is gone, or the label is not one of its sides. An entry about a side that does not exist ` +
      `accounts for nothing and keeps the ledger failing. RETRACT it: delete that one fenced \`blocked\` block from ` +
      `BLOCKED.md and nothing else. If it meant a side that does exist and is still uncovered, declare it again, the ` +
      `way any declaration is submitted, under that side's exact arm id and label; a declaration about a side that ` +
      `is gone or covered is refused.`,
    context: { staleEntry: { side, category: e.category ?? null, proof: e.proof ?? null, saidBy: `${LEDGER_TOOL}.mjs` } },
  };
}

/** The one question a code-dead entry a recorded row contradicts asks, while its side is still uncovered. */
export function falseSuppressionItem(c) {
  const side = sideId(c.arm, c.side);
  const rows = (c.movedBy ?? []).map((r) => `\`${r.id}\`${r.file ? ` in \`${r.file}\`` : ""}`).join(", ") || "a recorded row";
  const [file, line] = String(c.arm).split("#");
  return {
    // A question about a document, not an attempt at the side (see doubleClaimItem).
    id: `false suppression ${side}`,
    kind: "false-suppression",
    file: file || null,
    line: Number.isInteger(Number(String(line ?? "").split(":")[0])) ? Number(String(line).split(":")[0]) : null,
    question:
      `BLOCKED.md rules ${side} code-dead (proof ${c.proof ?? "absent"}), and ${rows} MOVED that side when it was ` +
      `recorded, so the entry is false: the side is reachable. The suite still leaves it uncovered, so the ` +
      `measurement cannot retire the entry yet. Make the row that moved it land in the suite - repair its ` +
      `recording so its emitted test runs and enters the side - and the next measurement supersedes the entry. Do ` +
      `not re-argue the entry and do not write another one for this side.`,
    context: {
      ...(c.movedBy?.[0]?.file ? { claim: { proposal: c.movedBy[0].id, file: c.movedBy[0].file, arm: c.arm, side: c.side } } : {}),
      falseSuppression: { side, proof: c.proof ?? null, movedBy: c.movedBy ?? [], saidBy: `${LEDGER_TOOL}.mjs` },
    },
  };
}

/** The one question an undecided double claim asks: which of the two documents is true. */
export function doubleClaimItem(dc) {
  const side = sideId(dc.armId, dc.side);
  const rows = dc.claims.map((c) => `\`${c.id}\` in \`${c.file}\``).join(", ");
  const entry = `the BLOCKED.md entry (${dc.entry?.category ?? "?"}, proof ${dc.entry?.proof ?? "?"})`;
  const [file, line] = String(dc.armId).split("#");
  return {
    // NOT a side id, for the reason a withdrawal decision's is not: this is a
    // question about two documents, not an attempt at the side, and an id that
    // read as one would push the side towards a stall ruling.
    id: `double claim ${side}`,
    kind: "double-claim",
    file: file || null,
    line: Number.isInteger(Number(String(line ?? "").split(":")[0])) ? Number(String(line).split(":")[0]) : null,
    question:
      `${side} is claimed by an input — ${rows} — AND by ${entry}, and only one of them can be true. Nothing the run ` +
      `measured decides it (${dc.why}). KEEP ONE: (1) if the input is right, repair the row so its recorded test ` +
      `runs in the suite and enters the side — the next measurement verifies it and the ledger takes the input over ` +
      `the entry; or (2) if the reason is right, resubmit the proposal file named in this packet with that claim ` +
      `taken off the row's \`reaches\` (or the row removed, if the side was its only claim) — the entry then stands ` +
      `alone. Do not write a second entry and do not add another input for this side: either adds a third claim to ` +
      `a pair that already disagrees.`,
    context: {
      claim: { proposal: dc.claims[0].id, file: dc.claims[0].file, arm: dc.armId, side: dc.side },
      doubleClaim: {
        side,
        claims: dc.claims,
        entry: dc.entry ?? null,
        saidBy: `${LEDGER_TOOL}.mjs`,
        why: dc.why,
      },
    },
  };
}

/**
 * Every side that did not land, split into what has an answer and what is open.
 *
 * THE UNIVERSE IS THE MEASUREMENT'S `stillUncovered`, not the work list's. The
 * work list is built from the existing suite's istanbul report (worklist.mjs
 * reads COVERAGE_SRC), so it describes the round BEFORE these inputs ran;
 * `coverage.json` describes the round after. Asking the older document which
 * sides are still uncovered is how a run comes to reassess sides it already
 * covered.
 *
 * WHAT COUNTS AS ANSWERED IS ONE THING ONLY: a `blocked` entry declaring the
 * side. A PROPOSAL NAMING IT IS NOT AN ANSWER HERE, and this is the difference
 * between this step and the ledger. `pilot:ledger` counts a side as accounted
 * the moment some `reaches` names it (ledger.mjs's `isProposed`) — it judges
 * the DOCUMENTS, and it cannot see a measurement. This step just read the
 * measurement, and the measurement says that input did not reach it: every side
 * in `stillUncovered` is, by construction, a side whose claim did not land. So
 * the claims are carried as EVIDENCE — the addresses of the documents to
 * edit — and never as an answer. A false claim that closed the loop would end a
 * run on the baseline with every side "accounted for", which is exactly the
 * 62.7% of run 20260916T024808Z.
 */
export function openSides({ coverage, measurement, arms, proposed, declared }) {
  const open = [];
  let declaredCount = 0;
  let claimedCount = 0;
  const undeliverable = [];
  // D64 — THE SIDES THE RECORDER REFUSED TO EXERCISE, off the same rows this
  // loop is already walking. Read through `undeliverableRows` rather than by
  // testing the field here, so this step and `derive` cannot come to different
  // readings of one document.
  //
  // IT IS THIS STEP THAT WAS RE-ASKING THEM. Run `20260919T142723Z` printed
  // five `[unreached]` items in round 3, each already carrying
  // `Classified skipped-toolset from record.mjs:2785` and each already telling
  // the turn "report the tool and do not re-aim an input at this" — and then
  // printed them again, and again. The classification was right and the item
  // was still a question; what was missing was the step declining to ask it.
  //
  // THE SIDE IS NOT ANSWERED AND NOT ACCOUNTED FOR. It stays in
  // `stillUncovered`, it stays in the denominator, the ledger is told nothing,
  // and `satisfied` below may close only because there is no question anybody
  // can answer — not because the coverage arrived.
  const refused = new Set(undeliverableRows(coverage).map((r) => sideKey(r.armId, r.side)));

  for (const row of coverage?.stillUncovered ?? []) {
    const key = sideKey(row.armId, row.side);
    if (declared.has(key)) {
      declaredCount += 1;
      continue;
    }
    if (refused.has(key)) {
      undeliverable.push({ armId: row.armId, side: row.side, why: row.undeliverable.why });
      continue;
    }
    const claims = (proposed.get(key) ?? []).slice();
    if (claims.length) claimedCount += 1;
    open.push({ item: arms.get(row.armId) ?? syntheticItem(row), armId: row.armId, side: row.side, row, claims });
  }
  return { open, declaredCount, claimedCount, undeliverable };
}

/**
 * An arm the measurement sees and the work list does not.
 *
 * Kept rather than dropped, and shaped so `nextBatch` can group it: a side that
 * exists in one document and not the other is a disagreement to report, and a
 * side silently left out of the round is a side nobody ever answers. `run` says
 * how many there were.
 */
function syntheticItem(row) {
  return {
    armId: row.armId,
    file: row.file,
    line: row.line,
    kind: row.kind,
    sides: [],
    uncoveredSides: [row.side],
    owner: { functionId: row.functionId, name: row.functionName },
  };
}

/** The last two rows of the loop ledger — the plateau, where there is one. */
function loopTail() {
  const doc = readDoc(LOOP_JSON);
  const rows = doc?.iterations ?? [];
  return { document: here(LOOP_JSON), iterations: rows.slice(-2), rounds: rows.length };
}

/** The proposal id out of the `<file>::<id>` address derive's join builds. */
const proposalIdOf = (address) => String(address).slice(String(address).indexOf("::") + 2);

/* ==========================================================================
 * D76 — THE RATCHET THIS STEP DID NOT HAVE, AND IT IS THE STEP THAT GATES THE
 * END OF THE RUN.
 *
 * `derive` has two: `packetlog.yieldRatchet` stops it when a round's seconds
 * stop buying sides, and `packetlog.stallRule` stops it when nobody is being
 * asked at all. Both END THE ASKING AND NOT THE RUN — the walk carries on
 * through `repair`, `ruling` and `report`, so the run still writes a result.
 * `repair` is ORDER[13] and `ruling` and `report` are ORDER[14] and ORDER[15],
 * which makes `repair` the last thing between a run and its `result.json`, and
 * it had NO rule of this kind at all. It asks until something closes, and
 * nothing in the walk is allowed to decide that nothing will.
 *
 * WHAT THAT COSTS, replaying run `20260920T030124Z` through
 * `tools/replaywalk.mjs` against the parent commit: rounds 8 through 12 handed
 * over THE SAME FIVE ITEMS, byte for byte, same sides, and the walk printed
 * its own warning before doing it again —
 *
 *   repair: WARNING — this round asks EXACTLY what the last 4 rounds asked
 *   (5 item(s), same sides). No side closed.
 *
 * — and then did it again. The run ended `exhausted at round 12`; `ruling` and
 * `report` never ran, and `result.json` was written by
 * `workflow.salvageResult` rather than by the step whose job it is.
 *
 * AND ONE OF THE FIVE CANNOT BE ANSWERED AT ALL, which is why "ask until it
 * closes" is not a rule that can hold. The withdrawal decision on
 * `arg0-of-run-21-if-0` is refused by `propose.mjs --withdraw` by
 * construction: withdrawing it would leave a row that still validates, still
 * records and still emits a test while speaking for no side. The item says so
 * in its own question — "THIS IS NOT A RETRY — nothing here will make the
 * refusal go away". A step that re-asks it every round has read its own brief
 * and not believed it.
 *
 * WHY A REPEAT AND NOT A YIELD. `derive`'s ratchet prices a round in seconds
 * per closed side, which needs a packet log; `repair` deals no packets of
 * sides and has no such log. What a repeat needs is only the QUESTION, and
 * `workflow.writeWorklist` already defines "the same question" for its own
 * `handover.repeated` warning: the handed-over item ids, sorted.
 * `askSignature` below is that same definition, so the rule and the warning
 * cannot come to disagree about what a repeat is.
 *
 * WHY IT READS `handover.asks` AND NOT `handover.repeated`, and this is
 * measured rather than assumed. `repeated` is one number about whoever wrote
 * the index LAST, so a round handed over by another step resets it: on the
 * same replay `measure` handed over in rounds 7 and 10, between `repair`
 * rounds asking the identical five items, and the counter never reached two.
 * `handover.asks` is the same arithmetic kept PER STEP and inherited across
 * the rounds that were not that step's — see `workflow.asksAfter`.
 *
 * AND THE COUNTING IS THE WALK'S, NOT THIS STEP'S, because
 * `steps.never-repair-a-tools-output` forbids a step from writing at all: a
 * step that keeps a tally of its own is a step whose `satisfied` can read its
 * own writing back. This file only reads, exactly as it reads
 * `previouslyAsked` and `priorAttempts` off the same document.
 *
 * IT STOPS THE ASKING AND NOT THE RUN, exactly as `derive`'s two do. `run`
 * returns `stop`, `workflow.walkSteps` treats the step as satisfied for the
 * rest of THIS walk only, and `ruling` and `report` run. `satisfied` is
 * untouched and still asks the disk and the ledger, so the next walk reaches
 * the same decision from the same evidence — the log is a MEASUREMENT and
 * never an answer to "is this step done".
 *
 * NOTHING IS LOST WHEN IT FIRES. The sides it was asking about are still
 * uncovered, still in the denominator, still named in `result.json` under
 * `missing`, and the withdrawals this round performed already reached the disk
 * before the pending list was assembled. What is given up is the NEXT
 * identical round.
 *
 * D31 — BUT A STOP THAT ONLY STOPPED LEFT ITS SIDES `open` FOR EVER, and two
 * things about it were wrong on contact-ms (mocked, 2026-09-25). The count grew
 * on rounds whose agent turn never answered (a gateway breaker on 429s, then an
 * exit 1 on 429s), and a resumed run inherited it off the checkpoint and stopped
 * on its first walk without asking anybody. And once stopped, nothing ruled the
 * three sides: `ruling` reads suppressions and never a side, so `report` ended
 * `partial` on "nothing covers them and no reason is written for them". Now:
 *
 *   - an unanswered turn neither grows nor resets the count, and a count kept
 *     by another run starts again (`nextAskRepeat`, steps/handover.mjs);
 *   - the FIRST firing hands the sides over once more as a DECISION
 *     (`stallRulingItem`: a declaration with proof), under the same ids;
 *   - the SECOND stops, and names the sides in `stalled` so the walk writes
 *     the stall down as their recorded reason. They stay `open` and the run
 *     `partial`: an agent that was asked twice and could not close a side is
 *     not a tool that failed, so this is never a `pipeline_defect`, and
 *     `report` names them as stalled rather than as sides nobody explained.
 *
 * A round with no open side (the closing round of withdrawal decisions) has
 * nothing to rule and stops on the first firing, as before.
 * ========================================================================= */

/** Off switch, spelled as `derive`'s two are (`CHARPILOT_YIELD_RATCHET=off`). */
export const REPEAT_RATCHET_ENV = "CHARPILOT_REPAIR_RATCHET";

/** And the knob that moves it, spelled as `CHARPILOT_STALL_RULE_ROUNDS` is. */
export const REPEAT_RATCHET_ROUNDS_ENV = "CHARPILOT_REPAIR_RATCHET_ROUNDS";

/**
 * How many REPEATS in a row before the asking stops. Two, and the number is
 * argued rather than copied: one repeat is an agent turn that failed outright
 * — the gateway 403s of `20260917T114326Z`, a DNS blip — re-asking sides
 * nobody ever looked at, and `workflow.REPEAT_SAYS` is explicit that killing
 * those runs would have destroyed recoverable work. Two repeats is the third
 * identical round. On `20260920T030124Z` that is round 8 of 12, and it buys
 * back four rounds plus the `ruling` and `report` that never ran.
 */
export const REPEAT_RATCHET_ROUNDS_DEFAULT = 2;

/**
 * WHICH SIDES A ROUND IS ASKING ABOUT, as one comparable string.
 *
 * The handed-over item ids, sorted — deliberately the same definition
 * `workflow.handoverSignature` uses, because the count this rule reads is
 * built on that one and two definitions of "the same question" would be two
 * rules wearing one number. Sorted, so the order the items happen to be
 * assembled in is not a difference. Null for a round that asks nothing: there
 * is no repeat to have.
 */
export function askSignature(items = []) {
  const ids = (items ?? []).map((p) => p?.id).filter(Boolean).map(String);
  return ids.length ? [...ids].sort().join("\n") : null;
}

/**
 * This step's own entry in the walk's per-step ask record, or nothing.
 *
 * `{ signature, repeated }`, where `repeated` is how many rounds in a row
 * BEFORE this one asked that signature. Written by `workflow.writeWorklist`
 * and inherited by it across rounds another step handed over.
 */
export function lastAsk(handover) {
  const ask = readDoc(handover)?.handover?.asks?.[NAME];
  if (typeof ask?.signature !== "string") return null;
  // D31: and the run the count was kept in, when the walk wrote one.
  return { signature: ask.signature, repeated: Number(ask.repeated) || 0, ...(typeof ask.run === "string" ? { run: ask.run } : {}) };
}

/**
 * Whether this round is the Nth identical ask in a row, and what to say.
 *
 * Pure, like `packetlog.stallRule`: it takes this round's signature and what
 * the walk recorded about this step's last ask, and returns the whole
 * judgement including the numbers it judged on — so the sentence the walk
 * prints and the metric on disk are one piece of arithmetic.
 */
export function repeatRatchet({
  asking = null,
  prior = null,
  priorRepeats = 0,
  rounds = REPEAT_RATCHET_ROUNDS_DEFAULT,
  enabled = true,
  // D31. The run the prior count was kept in and this walk's; whether the turn
  // before this walk answered; and whose round the index on disk is.
  priorRun = null,
  runId = null,
  unanswered = false,
  lastStep = NAME,
} = {}) {
  const same = Boolean(asking) && asking === prior;
  // WHAT THE WALK IS ABOUT TO WRITE INTO `handover.asks`, computed by the one
  // rule `workflow.asksAfter` computes it by (`nextAskRepeat`): the previous
  // count plus one when the question has not changed, zero otherwise - held
  // where it was when the turn it was handed to never answered, and started
  // again when the count is another run's.
  const repeats = nextAskRepeat({
    before: prior === null ? null : { signature: prior, repeated: priorRepeats, run: priorRun ?? undefined },
    signature: asking,
    step: NAME,
    lastStep,
    unanswered,
    runId,
  });
  const judged = { fired: false, ruling: false, why: null, repeats, rounds, items: asking ? asking.split("\n").length : 0 };
  if (!enabled) return { ...judged, why: `the repair ratchet is switched off (${REPEAT_RATCHET_ENV}=off)` };
  if (!asking) {
    return { ...judged, why: "this round asks nothing, so there is no repeated question to judge" };
  }
  if (!prior) {
    return { ...judged, why: `this step has asked nothing before this round, so there is nothing to compare its ${judged.items} item(s) against` };
  }
  if (!same) {
    return { ...judged, why: `this round asks a different set of ${judged.items} side(s) from the last one this step asked` };
  }
  if (runId && priorRun !== runId) {
    return {
      ...judged,
      why:
        `this round asks exactly what this step last asked (${judged.items} item(s), same sides), but that count was ` +
        `kept by ${priorRun ? `run ${priorRun}` : "an earlier run"} and this is run ${runId}: a resumed run has not ` +
        `asked it yet, so the count starts again here`,
    };
  }
  if (unanswered && lastStep === NAME && repeats < rounds) {
    return {
      ...judged,
      why:
        `this round asks exactly what the last round of this step asked (${judged.items} item(s), same sides), and the ` +
        `turn it was handed to never answered - it failed or hit the gateway and wrote nothing - so that round is not ` +
        `counted as asked: the count stays at ${repeats} of the ${rounds} repeat(s) the rule needs`,
    };
  }
  if (repeats < rounds) {
    return {
      ...judged,
      why:
        `this round asks exactly what the last ${repeats === 1 ? "round" : `${repeats} rounds`} of this step asked ` +
        `(${judged.items} item(s), same sides) — but the rule needs ${rounds} repeat(s) and this is ${repeats}. ` +
        `One repeat is an agent turn that failed outright and re-asked what it never looked at`,
    };
  }
  const why =
    `${repeats + 1} rounds of this step in a row have asked EXACTLY these ${judged.items} item(s), same sides, ` +
    `and no side closed. Measured on run 20260920T030124Z, whose rounds 8-12 handed over the same five items ` +
    `byte for byte — one of which \`propose.mjs --withdraw\` refuses by construction, so no turn could ever ` +
    `have closed it`;
  // D31. THE FIRST TIME IT FIRES IT ASKS FOR A RULING, NOT FOR NOTHING. The
  // sides go back to the agent once more as a DECISION - a declaration with
  // proof, which `report` counts as ruled - rather than as the same repair;
  // the round after that, if they are still open, it stops. `ruling` says
  // which of the two this is; a round with no open side to rule simply stops.
  return { ...judged, fired: true, ruling: repeats === rounds, why };
}

/**
 * D31 - THE SIDES A STOPPED ASK WAS ABOUT, as the side ids `report` matches.
 *
 * Only items about a side (they carry `context.arm`), and every member of a
 * grouped one. A withdrawal decision is about a row, not a side, and is left
 * to the stop as it always was.
 */
export function stalledSidesOf(pending = []) {
  const out = new Set();
  for (const p of pending ?? []) {
    if (!p?.context?.arm) continue;
    for (const id of [p.id, ...(p.group?.members ?? p.context?.group?.members ?? [])]) if (id) out.add(String(id));
  }
  return [...out];
}

/**
 * D31 - THE LAST QUESTION A STALLED SIDE IS ASKED: DECIDE IT.
 *
 * The same item, the same id (so the count and `previouslyAsked` still see
 * the same sides), the same context with its `declaration` block, and a
 * question that no longer asks for another input: the repair has come back
 * unchanged `asked` times. Nothing is invented for the agent to sign - the
 * declaration still needs a category, a killer and a proof the ledger accepts,
 * and a side the agent cannot prove anything about is left undeclared, in
 * which case the next round stops and the stop is its ruling.
 */
export function stallRulingItem(item, { asked, rounds }) {
  if (!item?.context?.arm) return item;
  const to = item.context.declaration?.submitTo;
  const where = to ? `\`${to.directory}/${to.file}\` under \`${to.key}\`` : "the answers file this packet names, under `declarations`";
  return {
    ...item,
    kind: "stall-ruling",
    question:
      `DECIDE THIS SIDE - the repair below has been asked ${asked} round(s) running with no side closing, so this is ` +
      `the last round it is asked. Write the declaration that rules it: category, killer and a proof at a file:line ` +
      `that makes the side impossible in this deployment, or shows it needs a seam the code does not have ` +
      `(\`context.declaration\` lists both vocabularies), in ${where}. Write a new input instead only if it differs ` +
      `from every attempt recorded in \`context\`. If neither can be written with evidence, write nothing: the next ` +
      `round leaves the side open with the stall as its recorded reason, which is honest and is not a success. ` +
      `The repair, as it was asked: ${item.question}`,
    context: {
      ...item.context,
      stall: {
        asked,
        threshold: rounds,
        says:
          "A question that came back unchanged is one no further input closed. What ends it is a decision per side: " +
          "a declaration, which `report` counts as ruled unreachable, or the side left open with the stall recorded as its reason.",
      },
    },
  };
}

/** A positive integer from the environment, or the default. */
function ratchetNum(raw, fallback) {
  const n = Number(String(raw ?? "").trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/* =========================================================================
 * D38 — THE COUNT IS PER SIDE, AND A SIDE IS COUNTED ONLY WHEN A TURN THAT
 * ANSWERED WAS HOLDING IT.
 *
 * The rule above judged the round as one set: the handed-over ids, sorted,
 * against the same set last time, grown on every handover of it. On
 * tracy-agent-be-ms (mocked, 2026-09-26) that stalled 189 sides nobody had
 * read. Every turn of the run was a 429 (one parent turn, no worker, nothing
 * written), `derive` and `repair` took alternate rounds, and D31's discount
 * for an unanswered turn applies only when the index on disk is this step's -
 * which after a `derive` round it never is. `asks.repair` went 0, 1, 2, 3 over
 * rounds 2, 4, 6 and 8, the decision round was handed to a 429, and the run
 * ended `partial` at 80.6% with 93 "stalled" sides in its `failed_reason`.
 *
 * NOW THE WALK COUNTS, PER SIDE, THE ROUNDS OF THIS STEP THAT DEALT THE SIDE
 * IN A PACKET AN ANSWERING TURN RECEIVED (`handover.answered`, settled by
 * `answeredAfter` in steps/handover.mjs, whichever step writes the next
 * index). The thresholds are the ones above, per side: after `rounds` such
 * rounds a side is handed over once as a decision, and after one more it is
 * not dealt again and stays open with the stall as its reason. A side never
 * dealt to a turn that answered is never stalled, and a stalled side is taken
 * out BEFORE the round is batched, so the sides behind it are dealt in its
 * place rather than held back behind a side nobody will ask again.
 *
 * `repeatRatchet` is still the judgement, applied to one item and its count;
 * the guard's own case - a side dealt and answered round after round with no
 * answer closing it - stops exactly as it did.
 *
 * AN INDEX WRITTEN BEFORE THE PER-SIDE COUNT (no `handover.answered`) is read
 * the old way, per id: every id of `asks.repair` carries the count
 * `nextAskRepeat` would have written. A resumed run never meets one, because a
 * count kept by another run starts again.
 * ========================================================================= */

/** Every side id an item speaks for: its own and its group's members. */
const idsOfItem = (item) =>
  [...new Set([item?.id, ...(item?.group?.members ?? item?.context?.group?.members ?? [])].filter(Boolean).map(String))];

/**
 * How many rounds of this step each side was dealt to a turn that answered,
 * counting the round on disk if it was this step's and is settled now.
 *
 * `{ counts: Map<sideId, n>, notes: string[], source }`, where `notes` are the
 * sentences that say how the last round was settled.
 */
export function sideAsks(handover, env = process.env) {
  const counts = new Map();
  const notes = [];
  const doc = readDoc(handover);
  if (!doc) return { counts, notes, source: "none" };
  const h = doc.handover ?? {};
  const runId = askRunId(env);
  if (h.answered && typeof h.answered === "object") {
    const prior = {
      step: typeof doc.step === "string" ? doc.step : null,
      run: typeof h.run === "string" ? h.run : null,
      packets: Array.isArray(doc.packets) ? doc.packets : [],
      answered: h.answered,
    };
    const { answered, credited } = answeredAfter({
      prior,
      env,
      workers: roundWorkers(join(dirname(handover), "rounds"), prior.packets),
    });
    for (const [id, n] of Object.entries(answered[NAME]?.sides ?? {})) counts.set(id, Number(n) || 0);
    if (credited.step === NAME) notes.push(`the last round was this step's, and ${credited.why}`);
    else if (credited.step) notes.push(`the last round was ${credited.step}'s, so it settles none of this step's sides`);
    return { counts, notes, source: "answered" };
  }
  const before = lastAsk(handover);
  if (!before) return { counts, notes, source: "none" };
  if (runId && before.run !== runId) {
    notes.push(
      `this step's last ask (${before.signature.split("\n").length} item(s)) was counted by ` +
        `${before.run ? `run ${before.run}` : "an earlier run"} and this is run ${runId}: a resumed run has not asked ` +
        `it yet, so the count starts again here`
    );
    return { counts, notes, source: "legacy" };
  }
  const lastStep = handoverStep(handover).step;
  const unanswered = lastTurnUnanswered(env);
  const n = nextAskRepeat({ before, signature: before.signature, step: NAME, lastStep, unanswered, runId });
  const ids = new Set(before.signature.split("\n").filter(Boolean));
  // A grouped item's members ride on the item the index reassembles.
  for (const item of doc.pending ?? []) if (ids.has(String(item?.id))) for (const m of idsOfItem(item)) ids.add(m);
  for (const id of ids) counts.set(id, n);
  if (unanswered && lastStep === NAME) {
    notes.push(
      `the turn handed this step's last round never answered - it failed or hit the gateway and wrote nothing - so ` +
        `that round is not counted as asked: the count stays at ${n}`
    );
  }
  return { counts, notes, source: "legacy" };
}

/** The rule's two knobs, read once per round. */
function ratchetKnobs(env) {
  const e = env ?? process.env;
  return {
    rounds: ratchetNum(e[REPEAT_RATCHET_ROUNDS_ENV], REPEAT_RATCHET_ROUNDS_DEFAULT),
    enabled: String(e[REPEAT_RATCHET_ENV] ?? "").trim().toLowerCase() !== "off",
  };
}

/** An item's count: the fewest rounds any side it speaks for was dealt to an answering turn. */
const countOf = (counts, item) => Math.min(...idsOfItem(item).map((id) => counts.get(id) ?? 0));

/**
 * The open sides whose count is past the decision round, taken out before the
 * round is batched: they are not dealt again. `open` entries carry `armId`
 * and `side`.
 */
export function stalledBeforeBatch(open = [], counts = new Map(), { rounds = REPEAT_RATCHET_ROUNDS_DEFAULT, enabled = true } = {}) {
  if (!enabled) return { live: open, stalled: [] };
  const live = [];
  const stalled = [];
  for (const entry of open) {
    const id = sideId(entry.armId, entry.side);
    const n = counts.get(id) ?? 0;
    if (n > rounds) stalled.push({ id, n });
    else live.push(entry);
  }
  return { live, stalled };
}

/**
 * The round's return, with the rule applied to it, item by item.
 *
 * Both of `run`'s asking returns go through here — the closing one, whose
 * items are withdrawal decisions and the undeliverable question, and the main
 * one — because both can repeat and the closing one holds the item that
 * CANNOT be answered. `stalledOpen` is the open sides `stalledBeforeBatch`
 * already took out of this round.
 *
 * SAID EVEN WHEN IT DOES NOT FIRE, for the reason `derive` says its two: a
 * rule nobody can see the arithmetic of is a rule nobody trusts on the day it
 * finally fires.
 */
function withRepeatRatchet({ did, pending, metrics, stalledOpen = [] }, { handover, env, asks = null }) {
  const { rounds, enabled } = ratchetKnobs(env);
  const { counts, notes } = asks ?? sideAsks(handover, env);
  for (const note of notes) did.push(`repeated ask: ${note}`);
  let repeats = Math.max(0, ...stalledOpen.map((s) => s.n));
  if (!enabled) {
    metrics.askRepeats = Math.max(repeats, ...pending.map((item) => countOf(counts, item)));
    did.push(`repeated ask: the repair ratchet is switched off (${REPEAT_RATCHET_ENV}=off)`);
    return { did, pending, metrics };
  }
  const keep = [];
  const ruled = [];
  const dropped = [];
  const stalled = stalledOpen.map((s) => ({ ids: [s.id], n: s.n }));
  let before = 0;
  for (const item of pending) {
    const n = countOf(counts, item);
    repeats = Math.max(repeats, n);
    if (n > 0) before += 1;
    const sig = askSignature([item]);
    const judged = repeatRatchet({ asking: sig, prior: n > 0 ? sig : null, priorRepeats: n - 1, rounds });
    if (!judged.fired) keep.push(item);
    else if (!item?.context?.arm) dropped.push(item);
    else if (judged.ruling) {
      keep.push(stallRulingItem(item, { asked: n + 1, rounds }));
      ruled.push(item);
    } else stalled.push({ ids: idsOfItem(item), n });
  }
  metrics.askRepeats = repeats;
  did.push(
    `repeated ask: per side - ${before} of this round's ${pending.length} item(s) were dealt before to a turn that ` +
      `answered (the most, ${repeats} round(s) of this step), and ${pending.length - before} never were. A side is ` +
      `handed over as a decision after ${rounds} such round(s) and not dealt again after ${rounds + 1}; a side never ` +
      `dealt to an answering turn is never stalled. ${REPEAT_RATCHET_ENV}=off switches it off and ` +
      `${REPEAT_RATCHET_ROUNDS_ENV} moves it`
  );
  if (ruled.length) {
    metrics.stallRuling = stalledSidesOf(ruled).length;
    did.push(
      `repeated ask: ${metrics.stallRuling} side(s) have been dealt to a turn that answered ${rounds} round(s) of ` +
        `this step and none closed, so they are not asked for the repair again: they are handed over ONCE as a ` +
        `decision - a declaration with proof, or the side left open next round with the stall recorded as its reason`
    );
  }
  if (dropped.length) {
    did.push(
      `repeated ask: ${dropped.length} decision(s) with no side - ${dropped.map((d) => d.id).slice(0, 5).join(", ")} - ` +
        `have been asked ${rounds + 1} rounds of this step running with nothing changing, so they are not asked again`
    );
  }
  const sides = [...new Set(stalled.flatMap((s) => s.ids))];
  const most = Math.max(0, ...stalled.map((s) => s.n));
  const why =
    `the same question was asked ${most + 1} rounds running and no side closed - each of these sides was dealt, in ` +
    `a packet a turn that answered received, ${rounds + 1} or more rounds of this step (the last of them the ` +
    `decision round), and no answer closed it`;
  if (sides.length) metrics.stalledSides = sides.length;
  const stalledRow = sides.length ? { stalled: { sides, tool: `${NAME} ratchet`, why } } : {};
  if (keep.length) {
    if (sides.length) {
      did.push(
        `${sides.length} side(s) stay open with the stall as their recorded reason and are not dealt again: ${why}. ` +
          `The other ${keep.length} item(s) are still asked - a side stalls on its own count, never on its neighbours'`
      );
    }
    return { did, pending: keep, metrics, ...stalledRow };
  }
  if (!sides.length && !dropped.length) return { did, pending: keep, metrics };
  const stop =
    `the same question has now been asked ${Math.max(repeats, most) + 1} rounds of this step running — every item ` +
    `left was dealt, in a packet a turn that answered received, ${rounds + 1} or more rounds of this step, and none ` +
    `closed. Ending the asking here rather than paying for another round of the same: every side this step closed is ` +
    `already withdrawn, recorded and measured, the ${sides.length + dropped.length} item(s) it was asking about are ` +
    `still uncovered and still in the denominator, and \`result.json\` names them. The walk runs on through ` +
    `\`ruling\` and \`report\`, so this run still writes a result rather than being killed at the round cap with none. ` +
    `The threshold is ${rounds} answered round(s) and a decision round, per side; ${REPEAT_RATCHET_ENV}=off switches ` +
    `it off and ${REPEAT_RATCHET_ROUNDS_ENV} moves it. THE THING TO FIX IS THE ITEM: a question that comes back ` +
    `unchanged is one no answering turn can close, and this round's brief is on disk to be read`;
  did.push(stop);
  if (!sides.length) return { did, pending: [], metrics, stop };
  // D31. AND THE SIDES IT LEAVES CARRY THE STALL AS THEIR REASON. The walk
  // writes them to out/defects.json as a NON-BLOCKING row (never a tool
  // defect) and `report` puts the stall on each side's `open` ruling and names
  // them as stalled. Without it nothing after this step says why they are open
  // - `ruling` does not read sides.
  did.push(
    `${sides.length} side(s) were handed over as a decision and are still open, so they stay open with the stall ` +
      `as their recorded reason: the walk writes them down with this sentence, and report names them as stalled. ` +
      `Not a pipeline defect - no tool failed; the agent was asked twice and no answer closed them`
  );
  return { did, pending: [], metrics, stop, ...stalledRow };
}

/**
 * The reason this step cannot run yet, or null.
 *
 * A ROUND THAT MEASURED NOTHING FAILS HERE, and the sentence is `measure`'s
 * own. There is no reassessment to do over a measurement that is absent,
 * unreadable or older than the suite it describes — every item this step would
 * build is a statement about what a run observed, and nothing observed
 * anything. A FLAT round is not this: identical numbers are a measurement, and
 * they are reported in `run`.
 */
export function precondition(repo, opts = {}) {
  const p = paths(repo, opts);
  const unmeasured = unjudgeable();
  if (unmeasured) {
    return (
      `there is nothing to reassess — ${unmeasured}. This step reads which sides did not land and what ` +
      "the recorder observed about them, and a round with no measurement holds neither"
    );
  }
  if (!existsSync(p.worklistJson)) {
    return `${here(p.worklistJson)} does not exist — the worklist step reported itself satisfied without writing it`;
  }
  if (!existsSync(p.behaviourJson)) {
    // NOT "record reported itself satisfied": record.satisfied is false while
    // this file is missing. On run 20260925T085519Z record was BLOCKED ("holds
    // no proposal files") and this line blamed it for a claim it never made.
    return `${here(p.behaviourJson)} does not exist — record has not written it, and its own line in this walk says why`;
  }
  return null;
}

/**
 * Whether every side that did not land has been accounted for, asked of the
 * filesystem and of the tool that judges the account. Never of a state file.
 *
 * TWO CONDITIONS, because neither is sufficient alone, and they are the two
 * `derive` asks one phase earlier.
 *
 *   nothing left open   the measurement's own still-uncovered list, every side
 *                       of it, with a `blocked` entry or a claim the
 *                       measurement did not contradict.
 *   the ledger exits 0  every uncovered side accounted for, no side both
 *                       proposed and blocked, no stale entry, no proof pointing
 *                       at a missing file, no `code-dead` a recorded row moved.
 *
 * The ledger alone would pass a run whose every input missed: it counts a side
 * as accounted when some `reaches` names it, and a FALSE claim is a `reaches`
 * that names it. The open list alone would pass a run that answered every side
 * with a malformed declaration. So: nothing left open, AND what was written
 * holds up.
 *
 * THE ROUND'S CAP IS NOT READ HERE, and `openSides` is asked for the whole
 * list. A cap that leaked in would end a run at the batch size with the rest of
 * the backlog silently unreassessed — and an unreassessed run reports the
 * baseline, which is the defect this step exists to prevent rather than to
 * produce.
 */
export function satisfied(repo, opts = {}) {
  const p = paths(repo, opts);
  // Not done, and `precondition` says why in one sentence the walk prints.
  if (unjudgeable()) return false;

  const coverage = readCoverage();
  if (!coverage) return false;

  const arms = armIndex(p.worklistJson);
  const labels = labelIndex(arms);
  const { open } = openSides({
    coverage,
    measurement: measurementIndex(coverage),
    arms,
    proposed: proposedSides(p.proposalsDir, labels),
    declared: withoutRefused(declaredSides(p.proposalsDir, labels), refusedDeclarations(p.proposalsDir, labels)),
  });
  if (open.length) return false;

  return p.exec(LEDGER_TOOL).ok;
}

/**
 * Enumerate what did not land, and hand it over.
 *
 * Every artifact is read ONCE for the whole round and indexed by side. A repo
 * with 945 open sides would otherwise re-parse a coverage document and a
 * behaviour document per item, and both are measured in megabytes.
 */
export function run(repo, opts = {}) {
  const p = paths(repo, opts);
  const coverage = readCoverage();
  const did = [];

  if (!coverage) {
    // Reached only when the measurement vanished between `precondition` and
    // here. Said rather than thrown: the walk quotes `did` back when a step
    // ran, asked nothing and is still not satisfied, and "ran (nothing)" is not
    // a diagnosis.
    return {
      did: [`this round measured nothing — there is no readable coverage document to reassess`],
      pending: [],
      metrics: {},
    };
  }
  // The path is carried on the document so `context` can name it without this
  // file holding a second opinion about where `measure` writes.
  coverage.__path = COVERAGE_JSON;

  const arms = armIndex(p.worklistJson);
  const labels = labelIndex(arms);
  const measurement = measurementIndex(coverage);
  const functionIds = functionIndex(arms, coverage);
  const rowsById = recordedRows(p.behaviourJson);
  const skipsById = recordedSkips(p.behaviourJson);
  // THE PROPOSAL ROWS THEMSELVES, read once. Three questions come out of them:
  // whether a claim is still stated, which arms a row may cite, and WHICH FILE
  // each row lives in — which is the name its repair has to be submitted under.
  const onDisk = proposalRowsById(p.proposalsDir);
  const asked = previouslyAsked(p.handover);
  const priors = priorAttempts(p.handover);
  const loop = loopTail();

  // BEFORE THE OPEN LIST IS READ, and before anything is briefed. A FALSE
  // claim left on a row has the ledger count its side as ACCOUNTED, and
  // `satisfied` below asks the ledger — so a round that briefed around them
  // could close on coverage nothing produced. Withdrawing first also means the
  // claims this round quotes as evidence are the ones still standing.
  const withdrawals = withdrawFalseClaims(p, { coverage, evidence: COVERAGE_JSON });
  did.push(...withdrawals.did);

  // D56: a declaration the ledger refused is not an answer, so its side is
  // open again and asked with the refusal beside it (`refusedDeclarationNote`).
  const refusals = refusedDeclarations(p.proposalsDir, labels);
  const { open, declaredCount, claimedCount, undeliverable } = openSides({
    coverage,
    measurement,
    arms,
    proposed: proposedSides(p.proposalsDir, labels),
    declared: withoutRefused(declaredSides(p.proposalsDir, labels), refusals),
  });

  // Before anything is assembled: a cap that cannot be read is refused where
  // the walk turns it into one sentence, not after a megabyte of evidence has
  // been indexed for a round whose size is unknown.
  //
  // D38: and a side already dealt to an answering turn past the decision round
  // is taken out first, so the batch is filled from sides still worth asking.
  const asks = sideAsks(p.handover, opts.env);
  const { live, stalled: stalledOpen } = stalledBeforeBatch(open, asks.counts, ratchetKnobs(opts.env));
  const batch = repairBatch(live, opts);
  const round = nextBatch(live, batch);
  const heldBack = live.length - round.length;

  const total = coverage.stillUncovered?.length ?? 0;
  did.push(
    `read ${total} still-uncovered side(s) from ${here(coverage.__path)} — ` +
      `${coverage.totals?.hitByEither ?? "?"}/${coverage.totals?.sides ?? "?"} sides hit, ` +
      `${coverage.totals?.claimsFalse ?? 0} claim(s) FALSE, ${coverage.totals?.claimsUnmeasurable ?? 0} unmeasurable`
  );
  did.push(`${declaredCount} of them has a written reason, ${claimedCount} has an input the measurement contradicted`);
  const reopened = open.filter((o) => refusals.has(sideKey(o.armId, o.side)));
  if (reopened.length) {
    did.push(
      `${reopened.length} of them has a declaration ledger.mjs REFUSED, so it is not ruled and is open again: each is ` +
        `asked this round with the ledger's refusal as its feedback, never counted as a tool failure — ` +
        [...new Set(reopened.map((o) => refusals.get(sideKey(o.armId, o.side)).why))].map((w) => JSON.stringify(w.slice(0, 200))).join("; ")
    );
  }
  // D64. Said whenever it is true, because a side nobody is asked about has to
  // be visible somewhere or this is a silent reduction of the work.
  if (undeliverable.length) {
    const reasons = [...new Set(undeliverable.map((u) => u.why))];
    did.push(
      `${undeliverable.length} of them is NOT reassessed: the recorder refused to exercise its function and said ` +
        `why, in ${reasons.length} distinct reason(s) — ${reasons.map((r) => JSON.stringify(r)).join("; ")}. ` +
        `They are still uncovered and still in the denominator, so the rate does not move and the ledger is told ` +
        `nothing; \`result.json\` names them under \`missing\`. Nothing is stored, so the round after the recorder ` +
        `records one of them reassesses it again`
    );
  }

  // A PLATEAU IS REPORTED AND IS NOT A FAILURE. Read from `measure`, out of the
  // loop ledger, so the two steps quote one sentence about one history.
  const flat = flatReason();
  if (flat) did.push(`${flat}, and this step reports it rather than stopping on it`);

  const metrics = {
    ...withdrawals.metrics,
    // THE WHOLE list, never this round's. The number that says how much is left
    // has to survive the batching or the log reports a backlog of 20 forever.
    open: open.length,
    handed: round.length,
    heldBack,
    batch,
    stillUncovered: total,
    blockedEntries: declaredCount,
    contradicted: claimedCount,
    // D64. Live, uncovered, counted, and not asked about.
    undeliverable: undeliverable.length,
    // D56. Open again because the declaration written for them was refused.
    refusedDeclarations: reopened.length,
  };

  if (!open.length) {
    // The ledger's verdict belongs in `did` exactly here: this is the branch
    // where `run` asks nothing, so if the ledger refuses, the walk's own
    // refusal quotes the reason instead of reporting a silent step.
    const ledger = p.exec(LEDGER_TOOL);
    if (ledger.line) did.push(ledger.line);
    // EXCEPT the withdrawals that came back as a decision. A row whose only
    // claim is false has nothing open on the measurement's side list and still
    // wants a ruling, and dropping it here is how it would never be asked. They
    // are packeted here for the same reason they are packeted below: a decision
    // handed over without the furniture is a decision whose answer has nowhere
    // legal to go.
    const entries = withdrawals.open.map((item) => {
      const { key, file } = withdrawalKey(item);
      return { item, key, files: file ? [file] : [] };
    });
    /* --------------------------------------------------------------------
     * D64 — THE ONE STATE IN WHICH AN UNDELIVERABLE SIDE STILL WANTS A TURN,
     * AND IT IS THE LAST QUESTION OF THE RUN RATHER THAN FIVE OF EVERY ROUND.
     *
     * `ledger.mjs` fails on an UNACCOUNTED side — one with neither an input
     * nor a written reason — and a side the recorder refused is exactly that.
     * Before D64 the state was unreachable: every such side was in `open`, so
     * this branch never ran with one outstanding. Now it is reachable, and
     * without this the walk would meet a step that is not satisfied, cannot
     * become satisfied by running again, and asked nothing — the one shape it
     * cannot route.
     *
     * SO IT ASKS, ONCE, FOR THE THING THAT RESOLVES ALL OF THEM. Not an input:
     * `skipped-toolset`'s own action has said "report the tool and do not
     * re-aim an input at this" since the classifier existed, and re-aiming is
     * what the five `[unreached]` items of run 20260919T142723Z kept inviting.
     * The two moves that end this state are a DOUBLE in the fixture for the
     * boundary the recorder named — after which the recording carries no skip,
     * the next measurement marks no row and the sides are dealt again by
     * themselves — or a fenced BLOCKED.md entry, which is the accounting the
     * ledger is asking for. Both are one turn's work and both make this item
     * disappear, which is what keeps an unbounded question from being a loop.
     * ------------------------------------------------------------------ */
    if (undeliverable.length && !ledger.ok) {
      entries.push({ item: undeliverableItem(undeliverable, coverage), key: "undeliverable", files: [] });
    }
    /* --------------------------------------------------------------------
     * A DOUBLE CLAIM THE LEDGER COULD NOT DECIDE IS A QUESTION, NOT A DEFECT.
     *
     * `ledger.mjs` fails on a side that a proposal claims and a blocked entry
     * rules, when nothing measured says which of the two is true
     * (`resolveDoubleClaim`). That is two documents the agent wrote
     * disagreeing, and only the agent can drop one. Before this, the closing
     * round quoted the ledger's line in `did` and asked nothing, so the walk
     * ruled the step a tool DEFECT and the run `failed` with every side
     * covered or ruled (email-centralization-ms, the evening run of 25
     * September). So the choice goes to the agent, one item per side, packeted
     * with the file the claiming row lives in so the answer has somewhere to go.
     * ------------------------------------------------------------------ */
    if (!ledger.ok) {
      const { doubleClaimed: doubles, contradicted, staleEntries, refused } = ledgerFindings(p);
      // D56: a refused entry is the agent's to write again or take out - an
      // answer the ledger sent back, never a tool failure of the ledger's.
      for (const r of refused) {
        entries.push({ item: refusedEntryItem(r), key: "refused entries in BLOCKED.md", files: [] });
      }
      metrics.refusedEntriesAsked = refused.length;
      if (refused.length) {
        did.push(
          `${refused.length} BLOCKED.md entry(ies) are refused by the ledger on a side the measurement does not ` +
            `list as open, so each goes to the agent to retract or write again rather than ending the step: ` +
            refused.map((r) => sideId(r.arm, r.side)).join(", ")
        );
      }
      for (const e of staleEntries) {
        entries.push({ item: staleEntryItem(e), key: "stale entries in BLOCKED.md", files: [] });
      }
      metrics.staleEntriesAsked = staleEntries.length;
      if (staleEntries.length) {
        did.push(
          `${staleEntries.length} BLOCKED.md entry(ies) name a side the work list does not know, so each goes to the ` +
            `agent to retract rather than ending the step: ` +
            staleEntries.map((e) => sideId(e.arm, e.side)).join(", ")
        );
      }
      for (const c of contradicted) {
        const files = [...new Set((c.movedBy ?? []).map((r) => r.file).filter(Boolean))].sort();
        entries.push({ item: falseSuppressionItem(c), key: `false suppression in ${files.join(", ") || c.arm}`, files });
      }
      metrics.falseSuppressionsAsked = contradicted.length;
      if (contradicted.length) {
        did.push(
          `${contradicted.length} code-dead entry(ies) are contradicted by a recorded row while the side is still ` +
            `uncovered, so each goes to the agent to land that row in the suite rather than ending the step: ` +
            contradicted.map((c) => sideId(c.arm, c.side)).join(", ")
        );
      }
      for (const dc of doubles) {
        const files = [...new Set(dc.claims.map((c) => c.file).filter(Boolean))].sort();
        entries.push({ item: doubleClaimItem(dc), key: `double claim in ${files.join(", ") || "an unnamed file"}`, files });
      }
      metrics.doubleClaimsAsked = doubles.length;
      if (doubles.length) {
        did.push(
          `${doubles.length} side(s) are claimed by BOTH an input and a blocked entry and nothing measured decides ` +
            `which is true, so each goes to the agent as a choice between the two rather than ending the step: ` +
            doubles.map((d) => sideId(d.armId, d.side)).join(", ")
        );
      }
    }
    const closing = packetsOf(entries, {
      // `entries.length` and NOT `closing.headers.size`: this literal is
      // `closing`'s own initializer, so reading it here is the same TDZ
      // ReferenceError the main path had. An item is what becomes a packet.
      limits: roundLimits({ items: entries.length, open: 0, briefed: 0, heldBack: 0, batch,
        concurrency: entries.length ? workerConcurrency(opts.env) : null }),
      schema: schemaBlock(p, repo),
    });
    metrics.sideGroups = closing.headers.size;
    metrics.handoverFiles = closing.headers.size;
    metrics.mergedOntoOneFile = 0;
    metrics.workerConcurrency = closing.headers.size ? workerConcurrency(opts.env) : null;
    // D76. The closing round is where the item that CANNOT be answered lives —
    // a withdrawal `propose.mjs` refuses as a row deletion — so it is the
    // round most able to repeat for ever.
    return withRepeatRatchet({ did, pending: closing.items, metrics }, { handover: p.handover, env: opts.env, asks });
  }

  let unreached = 0;
  let falseClaim = 0;
  let candidates = 0;
  let notProposed = 0;
  let unknownArm = 0;
  const byFailure = new Map();

  // ONE ITEM PER SIDE FIRST, always. Grouping happens over these, and nothing
  // is dropped on the way: every side that did not land is classified, briefed
  // and counted here, and a collapsed group carries every member's id so the
  // next round's `failedTwice` still sees each of them.
  const perSide = round.map((entry) => {
    const { item, armId, side, claims } = entry;
    const id = sideId(armId, side);
    const rows = claims.map((c) => rowsById.get(proposalIdOf(c))).filter(Boolean);
    // THE SAME JOIN, against the artifact's other half. A proposal is in `rows`
    // or in `skipped` and never in both, so these two lists partition the
    // claims — and reading only the first is the defect this closes.
    const skips = claims.map((c) => skipsById.get(proposalIdOf(c))).filter(Boolean);
    const elsewhere = movedElsewhere(rows, armId, side);
    const twice = failedTwice({ id, claims, asked, handoverPath: p.handover });
    const kind = kindOf({ elsewhere, twice, claims });
    const diagnosis = classify({ armId, side, rows, claims, measurement, prior: priors.get(id), skips });
    if (kind === "blocked-candidate") candidates += 1;
    else if (kind === "false-claim") falseClaim += 1;
    else if (kind === "not-proposed") notProposed += 1;
    else unreached += 1;
    byFailure.set(diagnosis.failure, (byFailure.get(diagnosis.failure) ?? 0) + 1);
    if (!arms.has(armId)) unknownArm += 1;

    const context = contextFor({
      item,
      armId,
      side,
      coverage,
      measurement,
      functionId: functionIds.get(armId),
      functionIds,
      claims,
      rows,
      elsewhere,
      twice,
      diagnosis,
      skips,
      proposalsDir: p.proposalsDir,
      behaviourJson: p.behaviourJson,
      loop,
      onDisk,
    });

    // D56: the refusal, when the last answer for this side was a declaration
    // the ledger would not accept. Same item, same route; the question leads
    // with what was wrong with the answer, and the context carries it whole.
    const refusal = refusals.get(sideKey(armId, side)) ?? null;
    const ask = question(kind, {
      item,
      armId,
      side,
      elsewhere,
      twice,
      rows,
      armsObserved: observedArms(rows),
      diagnosis,
    });
    return {
      id,
      kind,
      failure: diagnosis.failure,
      route: diagnosis.route,
      question: refusal ? `${refusedDeclarationNote(refusal)} ${ask}` : ask,
      file: item?.file,
      line: item?.line,
      context: refusal ? { ...context, refusedDeclaration: refusedDeclarationContext(refusal) } : context,
      // The grouping key, kept off the handed-over item: it is a join key, not
      // evidence, and `context.group.trace` is the readable form of the same
      // thing.
      groupKey: groupKeyFor({ failure: diagnosis.failure, rows }),
    };
  });

  const clusters = clusterByTrace(perSide);
  const clustered = clusters.map((cluster) => {
    const [lead] = cluster;
    const { groupKey: _key, ...item } = lead;
    if (cluster.length === 1) return item;

    const members = cluster.map((c) => c.id);
    const sides = cluster.map((c) => ({
      id: c.id,
      armId: c.context.arm.armId,
      side: c.context.arm.side,
      file: c.file ?? null,
      line: c.line ?? null,
      kind: c.kind,
    }));
    const group = {
      lead: lead.id,
      size: cluster.length,
      failure: lead.failure,
      // WHAT THEY SHARE, as execution and not as prose. Named `groupedOn` so it
      // cannot be read as a summary of an error.
      groupedOn: "the execution trace: where the run stopped, the arms moved, the boundary calls consumed and the declared boundaries left unused",
      members,
      sides,
      trace: lead.context.recorded.trace,
    };
    return {
      ...item,
      group,
      // INSIDE `context` as well, because `workflow.pendingJson` keeps only id,
      // kind, question, file, line and context — and `previouslyAsked` has to
      // find every member in the handover next round or the group's sides look
      // never-asked.
      context: { ...item.context, group },
      question: groupQuestion(lead.question, { members, trace: group.trace, failure: lead.failure }),
    };
  });

  // THE FILES THIS ROUND IS HANDED OVER AS, one per owning function. The header
  // object is SHARED by a packet's items — that is what makes "one packet, one
  // file" true of the bytes rather than of the intention — and the roster is
  // filled after the grouping, so a header can never name a subset of its own
  // file.
  // WHAT THIS ROUND PERMITS, in `derive`'s own words and with this round's
  // numbers. Called rather than restated: a second account of "how many of
  // these may I answer" is a second number to keep true, and the answering turn
  // that invented one for want of it cost run 20260916T194950Z a round.
  const items = clustered.length + withdrawals.open.length;
  const limits = roundLimits({
    items,
    open: open.length,
    briefed: round.length,
    heldBack,
    batch,
    // ITEM COUNT AND NOT `headers.size`, because `headers` comes back from
    // `packetsOf(entries, { limits })` -- which takes these limits, so a
    // concurrency read off it is a cycle, and reading it here is a TDZ
    // ReferenceError forty lines before the binding exists. An item is what
    // becomes a packet, so "are there items" answers "will there be a queue".
    concurrency: items ? workerConcurrency(opts.env) : null,
  });
  // The vocabularies, from the tool that enforces them. Soft: a repair round
  // can still say every true thing about a row it is reassessing without them.
  const schema = schemaBlock(p, repo);

  // EVERY ITEM OF THE ROUND, WITH THE GROUP IT BELONGS TO AND THE FILES ITS
  // ROWS LIVE IN — the two things a packet is built out of. The withdrawal
  // decisions are in here with the sides, deliberately: they used to declare no
  // bundle at all, so the walk filed each on its own, and a file the walk
  // synthesises carries NO header this step wrote — no answer file name, no
  // limits, no checkpoint, no `mock.kind` rule. On the live round that was 17
  // of the 19 packet files, which is most of what the greps that found
  // `charpilot-answers: 0` and `mock.kind: 0` across all 19 were looking at.
  const entries = [
    ...withdrawals.open.map((item) => {
      const { key, file } = withdrawalKey(item);
      return { item, key, files: file ? [file] : [] };
    }),
    ...clustered.map((item) => ({
      item,
      key: repairBundleKey(item),
      files: filesOfRows([item]).map((e) => e.file),
    })),
  ];
  const { items: bundled, headers } = packetsOf(entries, { limits, schema });

  // TWO DIFFERENT NUMBERS WERE BOTH PRINTED AS "packets", THREE LINES APART:
  // `repair: packets=2` (this step's groups), `repair: 19 brief(s) beside it,
  // one per packet` and `"handover": { "packets": 19 }` (files on disk). They
  // are named apart now: `sideGroups` is how many groups this round formed
  // before any of them were merged onto a shared submission file, and
  // `handoverFiles` is how many files the walk will write, which is the number
  // the walk's own two lines are about.

/**
 * THE DEAL, WHICH THIS STEP HANDED PACKETS OVER WITHOUT FOR AS LONG AS IT HAS
 * EXISTED — and it is where most of a run's ineffective time went.
 *
 * `derive` emits `workerConcurrency` beside its packets, and its rounds fan
 * out. `repair` emitted the packets and not the number, so the agent got
 * `PARALLELISM` (which `packetFurniture` has always put in every repair
 * packet, saying "ONE WORKER PER PACKET") and no concurrency to apply it
 * with — and answered every packet itself, in series.
 *
 * MEASURED, over the two container runs of 2026-09-21. Every round with zero
 * child turns is this step answering inline:
 *
 *   message-templates  rounds 2-6  3199s = 53 min of the run's 81   (65%)
 *   notification-ms    rounds 3,4,8  1590s = 26.5 min
 *
 * message-templates round 3 is the clearest: 1742 seconds, 80 parent turns,
 * ZERO child turns — 21.8 seconds per serial turn. Its round 1 ran 673 turns
 * in 1618 seconds across 12 workers. The per-turn cost is the same; the
 * difference is that one round was serial and the other was not. Six packets
 * answered by six workers is that round at about a sixth of its wall clock.
 *
 * ONE PER PACKET, AND THE COUNT IS NOT DEDICATED. `workflow.mjs` measured that
 * giving the round's biggest packet a worker to itself made that packet SLOWER
 * — 26.5 minutes bundled against 42.8 alone, on two runs of one 146-side round
 * — so what is published is a CONCURRENCY to launch against a queue, refilling
 * on return, exactly as `PARALLELISM.howToDeal` already states. Nothing here
 * splits a packet or pins a worker to one.
 *
 * NULL WHEN THERE IS NOTHING TO DEAL. A round with no packet publishes no
 * concurrency: a number beside an empty queue reads as a deal that was offered
 * and declined, which is the opposite of what happened.
 */
  metrics.sideGroups = new Set(entries.map((e) => e.key)).size;
  metrics.handoverFiles = headers.size;
  metrics.mergedOntoOneFile = metrics.sideGroups - headers.size;
  metrics.workerConcurrency = headers.size ? workerConcurrency(opts.env) : null;

  // THE WITHDRAWAL DECISIONS FIRST. They are about a document that is already
  // on disk and mis-counting a side as accounted, which is cheaper to settle
  // than any side in the round and blocks the ledger until it is.
  const pending = bundled;

  metrics.unreached = unreached;
  metrics.falseClaims = falseClaim;
  metrics.blockedCandidates = candidates;
  metrics.notProposed = notProposed;
  metrics.questions = pending.length;
  metrics.withdrawalDecisions = withdrawals.open.length;
  metrics.groups = clusters.filter((c) => c.length > 1).length;
  metrics.groupedSides = clusters.filter((c) => c.length > 1).reduce((n, c) => n + c.length, 0);
  metrics.byFailure = Object.fromEntries([...byFailure].sort((a, b) => b[1] - a[1]));
  metrics.toolRouted = perSide.filter((x) => x.route === "tool").length;
  metrics.agentRouted = perSide.filter((x) => x.route === "agent").length;
  metrics.toolsetRouted = perSide.filter((x) => x.route === "toolset").length;

  did.push(
    `handed over ${metrics.handoverFiles} packet FILE(s) from ${metrics.sideGroups} group(s) — a different number ` +
      `from the ${metrics.groups ?? 0} shared cause(s) below, and named differently for that reason. Each file ` +
      `carries where to write (${ANSWERS_DIRNAME}/ and the file name, together), which \`mock.kind\` installs, the ` +
      `limits, the checkpoint, the parallelism rule and the legal \`covers\` set for its rows — the same blocks ` +
      `derive hands over, from the same source`
  );
  if (metrics.mergedOntoOneFile) {
    did.push(
      `${metrics.mergedOntoOneFile} group(s) were merged into a packet they share a proposals file with: two packets ` +
        `naming one submission file is two writers on one name, which is a silently truncated submission and not a ` +
        `merge. Rows that share a destination share a submission`
    );
  }
  did.push(
    `briefed ${round.length} side(s) that did not land — ${unreached} unreached, ${falseClaim} false-claim, ` +
      `${candidates} blocked-candidate, ${notProposed} not-proposed — from ${here(coverage.__path)} and ` +
      `${here(p.behaviourJson)}`
  );
  const toolsetRouted = perSide.filter((x) => x.route === "toolset").length;
  did.push(
    `classified them before asking: ${[...byFailure].map(([f, n]) => `${n} ${f}`).join(", ")} — ` +
      `${metrics.agentRouted} for the agent, ${metrics.toolRouted} mechanical (schema field, invocation adapter or ` +
      `mock binding), ${toolsetRouted} about the TOOLSET rather than any input, and a \`wrong-side\` failure is never ` +
      "one of the mechanical ones"
  );
  const named = [...headers.values()].filter((h) => h.answers?.existing?.length === 1).length;
  if (named) {
    did.push(
      `${named} of those packet(s) name the proposals file their rows ALREADY live in as the file to submit under, ` +
        `rather than the name derived from the packet id — propose.mjs materialises a submission under its own file ` +
        `name and validate.mjs keeps \`seen\` ids across the whole flattened proposals directory, so a repaired row ` +
        `under a fresh name is a \`duplicate id\` refusal. The next round's "submitted under its own reserved name" ` +
        `census reads that same field, so the two agree about what was asked for`
    );
  }
  if (metrics.groups) {
    did.push(
      `grouped ${metrics.groupedSides} of them into ${metrics.groups} shared cause(s) and asked each once — ` +
        `${round.length} side(s) became ${pending.length} question(s). The clustering is on the execution trace ` +
        "(where the run stopped, the arms moved, the boundary calls consumed, the declared boundaries left unused) " +
        "and never on an error message, because two failures that only read alike have two causes"
    );
  }
  if (heldBack) {
    did.push(
      `handed over ${round.length} of ${open.length} open side(s) and held ${heldBack} back: a round is capped at ` +
        `${batch} side(s) (${BATCH_ENV}, default ${DEFAULT_BATCH}), and the next walk rebuilds from the filesystem ` +
        `and briefs the next ${Math.min(heldBack, batch)}`
    );
  }
  // A RECORDING GAP IS ONLY A RECORDING GAP WHERE SOMETHING WAS RECORDED AT.
  // A side with a claim and no row was aimed at and nobody wrote down what
  // happened; a side with NO claim was never aimed at, and counting it here
  // reported it as a gap in the recorder, which it is not.
  const silent = perSide.filter(
    (x) => x.context.inputs.claims.length && !x.context.recorded.observed.length && !x.context.recorded.skipped.length
  ).length;
  const withReason = perSide.filter((x) => x.context.recorded.skipped.length);
  if (silent) {
    did.push(
      `${silent} of them have an input and NO recorded row and NO skip reason in ${here(p.behaviourJson)} — there is ` +
        "no observation to reassess and nothing said why, which is a recording gap and not an aiming failure"
    );
  }
  // SAID SEPARATELY, AND THIS IS THE LINE RUN 20260916T223906Z DID NOT HAVE.
  // 122 skips with one identical written reason were reported as "no
  // observation to reassess", and the reason — which was about the recorder —
  // never reached the item at all.
  if (withReason.length) {
    const byAbout = {};
    for (const x of withReason) {
      for (const skip of x.context.recorded.skipped) byAbout[skip.about] = (byAbout[skip.about] ?? 0) + 1;
    }
    metrics.skipped = withReason.length;
    metrics.skippedByAbout = byAbout;
    did.push(
      `${withReason.length} of them were SKIPPED by the recorder with a written reason, quoted verbatim on the item — ` +
        `${Object.entries(byAbout).map(([k, n]) => `${n} about the ${k}`).join(", ")}. A skip reason is the recorder's ` +
        "sentence about its own failure, and the ones about the TOOLSET are not repaired by any input: handing those " +
        "over as a critique of the proposal is what sent run 20260916T223906Z to fix what was not broken for an hour"
    );
  }
  if (notProposed) {
    did.push(
      `${notProposed} of them were never PROPOSED — no \`reaches\` names the side, so nothing was ever aimed at it ` +
        "and nothing ran: those items ask for an input rather than for a repair, and none of them can become a " +
        "blocked-candidate on this round's evidence"
    );
  }
  if (unknownArm) {
    did.push(
      `${unknownArm} of them name an arm ${here(p.worklistJson)} does not hold — the measurement and the work list ` +
        "disagree about the arm model, so those items carry no condition source or entry recipe"
    );
  }
  // THE ROUNDS NOBODY COULD SEE. `reportNoteCache` was called by `derive` and
  // by nothing else, so a run whose later rounds are all `repair` reported the
  // note cache for the last time in its last derive round. Run
  // 20260920T030124Z is ten rounds long, `derive` ran three of them, and the
  // note numbers on record for it stop at round 3 (`noteCacheNotesWritten=10`)
  // while rounds 4-10 went on materialising submissions -- 27 by the end, with
  // four notes on disk. The cache was working and the log said nothing.
  //
  // NO `obligation`. That argument describes a round's READING PLAN, which
  // `derive` computes for the packets it deals; repair asks about sides that
  // failed, and inventing a plan here to fill the parameter would be a second
  // answer to a question derive already answers. Without it this reports what
  // the store holds -- hits, misses, writes, refusals, and the facts compacted
  // out -- which is the half that was missing.
  //
  // READ-ONLY, deliberately: `steps.never-repair-a-tools-output` refuses a
  // step whose `satisfied` could read back its own writing, and `counters()`
  // opens the notes directory and writes nothing.
  reportNoteCache(metrics, did);
  return withRepeatRatchet({ did, pending, metrics, stalledOpen }, { handover: p.handover, env: opts.env, asks });
}
