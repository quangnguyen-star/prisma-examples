#!/usr/bin/env node
/**
 * Walk the steps, and stop at the first thing a tool cannot decide.
 *
 *   node .claude/charpilot/workflow.mjs [<repo>]
 *     exit 0    every step satisfied
 *     exit 75   a step needs a decision -> out/worklist-decisions.json
 *     other     a real failure, already named on stderr
 *
 * 75 AND NOT 20. `20` is taken in docker/CONTRACT.md and in the container
 * entrypoint for "language not supported", and anything routed through that
 * path writes `status: failed` — so a workflow exiting 20 would reach Fleet
 * Control as an unsupported language rather than as a run waiting on an answer.
 * python/tools/pipeline.py carries the same number for the same reason.
 *
 * RESUMABLE, WITH NO STATE FILE. Every step answers `satisfied` from the
 * filesystem, so a re-invocation skips what is done rather than redoing it and
 * nothing can go stale or disagree with the disk. A state file would be a
 * second account of the run, and this pipeline exists because the second
 * account is the one that turns out to be wrong.
 *
 * Each refusal below is a place where a previous run carried on and produced a
 * clean report over a false premise: a step that reported work and changed
 * nothing, an exit 75 with no question on disk, a precondition that failed after
 * everything before it said it was done, a handover answered after it was
 * edited, and a brief that named an arm and carried no evidence about it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { OUT_DIR, REPO_ROOT, SAFETY_MARKER } from "./config.mjs";
import { BANK_WALK_ENV, VISIT_ENV, WALK_ID_ENV } from "./incremental.mjs";
import { PROCESS_STARTED_AT, ROUNDS_DIR, recordRoundClock } from "./packetlog.mjs";
import { BANKS, CLEARS_A_REFUSAL, HANDS_OVER_A_ROUND, ORDER, loadStep as loadStepFromDisk } from "./steps/index.mjs";
import * as earlyMeasure from "./steps/earlymeasure.mjs";
import {
  BUNDLE_KEY,
  WORKLIST_DECISIONS,
  digestPath,
  packetDirFor,
  packetFileName,
  briefCensus,
  entryItemCap,
  itemMinutes,
  packetMinutes,
  readHandoverDoc,
  roundBudgetMin,
  workerConcurrency,
  LIGHT_WORKER_AGENT,
  WORKER_AGENT,
  answeredAfter,
  askRunId,
  lastTurnUnanswered,
  nextAskRepeat,
  roundWorkers,
} from "./steps/handover.mjs";
export { BUNDLE_KEY, WORKLIST_DECISIONS, digestPath, packetDirFor, packetFileName, readHandoverDoc };

/**
 * NOT `worklist.json`. That name belongs to worklist.mjs and validate.mjs reads
 * it; a second writer on it would make the uncovered-arm list and the open
 * questions the same artifact, and the first tool to run would delete the
 * other's answer.
 */

export const EXIT_OK = 0;
export const EXIT_NEEDS_DECISION = 75;
export const EXIT_FAILED = 1;

/**
 * FIX PLAN 1, RULE 2 — A SAFETY REFUSAL IS NOT A WALK FAILURE.
 *
 * The handover tamper check and the production-database triple check stop a
 * run so that its work is kept OFF the remote. A plain EXIT_FAILED reads to
 * the pack as "the walk failed; bank what is on disk and deliver it", which
 * is exactly what a safety refusal must not do. So it has its own code, and
 * the outcome (and the salvaged result.json) carries `safety: {check, reason}`.
 * 77 is unused by every tool and step here (0, 1, 3, 75) and by CONTRACT.md's
 * container codes (0-70); it never reaches Fleet Control, the pack turns it
 * into its own Stage.
 */
export const EXIT_SAFETY = 77;

/**
 * FIX PLAN 1, F1.2 — THE LAST WALK OF A RUN, WITH THE HANDOVER SWITCHED OFF.
 *
 * `docker/char/packs/nodejs.py` passes this once, after its round loop has
 * ended on the round cap, the budget, or a failed last turn. Every walk banks
 * what the PREVIOUS round answered before it hands the next one over, so the
 * answers of the LAST round were never banked by anybody: assessment-service
 * `20260922T101156Z` exited 75 in round 16 of 16, its agent answered five
 * packets, and the loop ended without walking again.
 *
 * It is the normal walk: same ORDER, same steps, same code. The one difference
 * is that nothing is handed over, because there is no next round to answer it:
 * a question is HELD (the walk never exits 75), and a step that cannot run or
 * is still unsatisfied is held too rather than ending the walk, so `report`
 * always gets its turn. `derive` still runs, because it is what materialises
 * the answers on disk into proposals; `record` is incremental by fingerprint,
 * so re-running it adds nothing twice.
 *
 * The one thing it will not do is report over a measurement nobody can
 * believe (stale, missing, or taken while the emitted suite was failing).
 * Then it exits 1 and the salvage below writes `partial`; the pack keeps the
 * last good result.json instead.
 */
export const BANK_ONLY_FLAG = "--bank-only";

/** One line, flushed. The container reads this as it happens. */
const toStdout = (line) => process.stdout.write(line + "\n");

/**
 * One pending item as it goes on disk.
 *
 * `file`, `line` and `context` are dropped when absent rather than written as
 * null, because the answering turn reads this file and an explicit null is a
 * field it has to decide to ignore. `context` carries the evidence the step
 * already gathered — a stack, a signature, the arm it is chasing — so the agent
 * does not pay to collect it twice.
 */
export function pendingJson(item) {
  const out = { id: item.id, kind: item.kind, question: item.question };
  if (item.file) out.file = item.file;
  if (item.line !== undefined && item.line !== null) out.line = item.line;
  // PRESENT, not truthy. `""` is falsy and is exactly the shape being refused
  // below — a step that assembled its brief into a string and assembled
  // nothing. `null` and `undefined` stay "absent": the docblock above drops
  // them rather than writing a field the answering turn has to decide to
  // ignore.
  if (item.context !== undefined && item.context !== null) {
    // A CONTEXT THAT IS THERE AND CARRIES NOTHING IS REFUSED HERE, at the only
    // moment anything can still be done about it.
    //
    // The brief is the deliverable. An item that names an arm and hands over an
    // empty object sends the answering turn back to grepping the repo for the
    // condition, the entry recipe, the parameters and the boundaries — 193
    // calls and 25.6% of run 20260916T031317Z, which is the cost this whole
    // step exists to remove. A step that got that far believed it had assembled
    // evidence and assembled none, and that is a defect in the step, not a
    // question anybody can answer, so it fails rather than shipping a brief
    // that reads as one and is not.
    //
    // ABSENT is not empty, and stays legal: a step with nothing to add omits
    // the field, and the item is then honestly just a question.
    if (isEmptyContext(item.context)) {
      throw new Error(
        `pending item ${JSON.stringify(item.id)} carries an empty \`context\`. ` +
          "A brief that carries nothing sends the answering turn back to the repo to find the " +
          "condition, the entry recipe, the parameters and the boundaries — which is the work this " +
          "step exists to have already done. Omit the field or fill it."
      );
    }
    out.context = item.context;
  }
  return out;
}

/** `{}`, `[]` and whitespace carry nothing; `0` and `false` are answers. */
function isEmptyContext(context) {
  if (typeof context === "string") return context.trim() === "";
  if (Array.isArray(context)) return context.length === 0;
  if (typeof context === "object" && context !== null) return Object.keys(context).length === 0;
  return false;
}

/* ------------------------------------------------------------------------ *
 * THE HANDOVER IS FANNED OUT: AN INDEX, AND ONE FILE PER PACKET.
 *
 * THE PROPERTY, stated so it can be tested: AN AGENT CAN READ ONE PACKET FILE
 * AND ACT ON ANY ITEM IN IT, WITHOUT RUNNING A SCRIPT. That means, exactly:
 *
 *   - every item of a packet is in that one file, and nowhere else;
 *   - nothing in that file names a location outside it — not another file, not
 *     another item in another file;
 *   - the things the whole packet shares (the roster of its sides, the reading
 *     plan, the reference blocks) are at the TOP of it, written once, not
 *     restated on each item and not fetched from anywhere.
 *
 * It is NOT a claim about bytes, and the distinction is the whole reason this
 * exists. A previous attempt satisfied a byte-count refusal — "no block stored
 * twice", `sharedBytesSaved=841580` — and the behaviour did not change at all,
 * because the file was still 1.4 MB and still the only unit on offer. Splitting
 * so that reading one item requires rejoining it to two other places would
 * rebuild that defect with more steps.
 *
 * WHY THIS LAYER. A step may not write (`steps.never-repair-a-tools-output`
 * greps every step for it), no existing tool owns a per-packet brief format,
 * and both a new tool and a per-packet spawn are refused by
 * `derive.packet.test.mjs`. The walk's handover is already the single, named
 * exception to "tools write, steps spawn" — so the fan-out happens here, in the
 * walk's own write, and the rule stays exactly as narrow as it was.
 * ------------------------------------------------------------------------ */

/**
 * A pending item that declares no bundle is filed on its own.
 *
 * THE HONEST DEFAULT, not a fallback. An item that belongs with nothing is
 * answerable alone, so a file holding just it satisfies the property above
 * trivially — and a step with no grouping to declare (repair hands back
 * unaccounted sides, not function groups) keeps working unchanged.
 */
export function bundleAlone(item) {
  return {
    id: `alone ${item?.id}`,
    count: 1,
    sides: [item?.id],
    why: "one item, filed on its own — the step that raised it declared no group it belongs to, so it is answered by itself.",
  };
}

/**
 * The round's items as the files they will be written to, in round order.
 *
 * GROUPING IS WHAT MAKES "A PACKET IS NEVER SPLIT" STRUCTURAL rather than a
 * property somebody has to keep checking. `derive.packet.test.mjs` requires
 * every side of a packet to carry its lead's brief byte for byte, because the
 * sides may be answered out of order or by different turns; collecting them by
 * bundle id means there is no arrangement of the list that can put two of them
 * in different files.
 */
export function bundlesOf(pending) {
  const groups = new Map();
  for (const item of pending) {
    const declared = item?.[BUNDLE_KEY] ?? null;
    // A NUL prefix so a synthesised key cannot collide with a declared id.
    const key = declared?.id ?? `\u0000alone:${item?.id}`;
    if (!groups.has(key)) groups.set(key, { header: declared ?? bundleAlone(item), items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

/**
 * Write the index and the packet files, and return what reached the disk.
 *
 * The signature is the one the walk already called: the fan-out is this
 * function's business and no step's, so nothing about the step contract moved.
 */
/**
 * THE SIGNATURE OF A ROUND'S HANDOVER: exactly which sides were asked about.
 *
 * Sides and not counts, because two different rounds can coincidentally hand
 * over the same NUMBER of items — what says a round made no progress is that
 * it is asking the same QUESTIONS.
 */
/** D38: `{ members }` when a packet's items speak for grouped sides beside their own ids, else nothing. */
function membersOf(rendered) {
  const ids = new Set(rendered.map((p) => String(p.id)));
  const members = [
    ...new Set(rendered.flatMap((p) => p.context?.group?.members ?? []).map(String).filter((m) => !ids.has(m))),
  ];
  return members.length ? { members } : {};
}

function handoverSignature(packets) {
  return (packets ?? [])
    .flatMap((p) => p.sides ?? [])
    .map(String)
    .sort()
    .join("\n");
}

/** Last round's signature, repeat count and per-step asks, off the index about to be replaced. */
export const tailFoldOn = (env = process.env) => env.CHARPILOT_TAIL_FOLD !== "off";

/** D65's rollback: `off` hands a round over without banking what the handing-over step materialised. */
export const BANK_BEFORE_HANDOVER_ENV = "CHARPILOT_BANK_BEFORE_HANDOVER";

/**
 * PLAN 20 T2.2c — WHICH HELD ASK, IF ANY, TAKES A TINY ROUND.
 *
 * A step pulled forward to clear inside another step's round has its questions
 * HELD (D76) until that step is satisfied. Measured: assessment-service round 13
 * held 13 repair questions while derive dealt 1 packet, and message-templates
 * round 3 held 8 while derive dealt 2 and took 29 minutes. The design's fold
 * would put both in one mixed handover, a protocol change for every reader that
 * keys on `doc.step`. This is the smaller version (the design's Q5 alternative):
 * the held step takes the round, in its own format.
 *
 * It does, only when all of these hold:
 *   - this round's own ask is smaller than one item per worker;
 *   - a held ask has MORE items than this round's;
 *   - the last handover was not already a takeover by that same step, so a
 *     large repair backlog can never starve derive's small round for good.
 */
export function tailFoldTakeover(pending, heldAsks, prior, workers, label = null, env = process.env) {
  if (!pending.length) return null;
  // D85 - A HELD STEP IS NOT STARVED BY A STEP THAT ASKS EVERY ROUND.
  //
  // The rule below only let a held ask take a round smaller than one item per
  // worker, and derive never asks that little: qode-ptp-ms dealt a derive round
  // every round of four runs (20260928T063515Z, 20260928T110132Z,
  // 20260929T151429Z, 20260929T210223Z) while repair held 277-296 items that
  // were "dealt before to a turn that answered: 0". Those are the rows the
  // recorder refused - blocked egress, a harness failure, a refused shape - so
  // the sentence that says what to fix never reached a worker, and 292 of the
  // 306 open sides were open in all four runs with the same reason. So when
  // THIS step also asked the round before, the largest held ask takes this one:
  // the two alternate. The last-takeover rule still keeps a held step from
  // taking two rounds in a row. CHARPILOT_STARVED_FOLD=off restores the old rule.
  const starved = starvedFoldOn(env) && label && prior?.step === label;
  if (!starved && pending.length >= Math.max(1, workers)) return null;
  const best = [...heldAsks].filter((h) => h.pending.length && (starved || h.pending.length > pending.length))
    .sort((a, b) => b.pending.length - a.pending.length)[0];
  if (!best) return null;
  if (prior?.step === best.label || prior?.step === best.name) return null;
  return best;
}
export const starvedFoldOn = (env = process.env) => String(env.CHARPILOT_STARVED_FOLD ?? "").trim().toLowerCase() !== "off";

function priorHandover(path) {
  const none = { signature: null, repeated: 0, asks: {} };
  if (!existsSync(path)) return none;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const asks = {};
    for (const [name, ask] of Object.entries(doc?.handover?.asks ?? {})) {
      if (typeof ask?.signature === "string") {
        // The run it was counted in rides along (D31): a resumed run's first
        // ask must be able to tell that the streak it found is not its own.
        asks[name] = { signature: ask.signature, repeated: Number(ask.repeated) || 0, ...(typeof ask.run === "string" ? { run: ask.run } : {}) };
      }
    }
    return {
      signature: handoverSignature(doc?.packets),
      repeated: Number(doc?.handover?.repeated) || 0,
      asks,
      // The step whose round it was (plan 20 T2.2c's no-starvation guard).
      step: typeof doc?.step === "string" ? doc.step : null,
      // D38: what `answeredAfter` settles - the round's packets, the run it
      // was written in, and the per-side counts it carried.
      packets: Array.isArray(doc?.packets) ? doc.packets : [],
      run: typeof doc?.handover?.run === "string" ? doc.handover.run : null,
      answered: doc?.handover?.answered && typeof doc.handover.answered === "object" ? doc.handover.answered : {},
    };
  } catch {
    // Unreadable is not evidence of a repeat. The tamper check owns that.
    return none;
  }
}

/* --------------------------------------------------------------------------
 * D76 — THE REPEAT COUNT, PER STEP, CARRIED ACROSS THE ROUNDS THAT WERE NOT
 * THAT STEP'S.
 *
 * `repeated` above is one number about the LAST round whoever wrote it, and
 * that is the right shape for the warning it feeds: "this round asks what the
 * last one asked" is a statement about two adjacent rounds.
 *
 * IT IS THE WRONG SHAPE FOR A STEP THAT WANTS TO STOP. Replaying
 * `20260920T030124Z`, `repair` asked the identical five items in rounds 5, 6,
 * 8, 9, 11 and 12 — and `measure` handed over in rounds 7 and 10, in between,
 * which overwrote the index and reset `repeated` to zero each time. A step
 * reading that counter can never see a streak it did not have uninterrupted.
 *
 * SO THE INDEX CARRIES ONE ENTRY PER STEP AND INHERITS THE REST. The step that
 * writes this round updates its own entry; every other step's is copied
 * forward untouched, so `asks.repair` still says what `repair` last asked and
 * how many rounds running it had asked it, however many rounds of somebody
 * else's questions have been through the file since.
 *
 * THE WALK COMPUTES IT AND NEVER ACTS ON IT, exactly as it does `progress`.
 * `steps/repair.mjs` reads its own entry and decides; `steps.never-repair-a-tools-output`
 * forbids a step from writing, which is why the counting is here — the walk
 * already owns this file, and a step keeping a tally of its own would be a
 * step whose `satisfied` could read its own writing back.
 * ------------------------------------------------------------------------ */
function asksAfter(prior, step, signature, env = process.env) {
  const asks = { ...(prior.asks ?? {}) };
  if (!step) return asks;
  const runId = askRunId(env);
  // D31: a turn that never answered this step's question does not count as
  // it having been asked, and another run's streak is not this run's. See
  // `nextAskRepeat` in steps/handover.mjs, which `repair` reads too.
  const repeated = nextAskRepeat({
    before: asks[step],
    signature,
    step,
    lastStep: prior.step,
    unanswered: lastTurnUnanswered(env),
    runId,
  });
  if (signature) asks[step] = { signature, repeated, ...(runId ? { run: runId } : {}) };
  else delete asks[step];
  return asks;
}

/**
 * A ROUND THAT ASKS EXACTLY WHAT THE LAST ONE ASKED HAS MADE NO PROGRESS, AND
 * NOTHING ELSE IN THE WALK SAYS SO.
 *
 * THE DEFECT THIS CATCHES, twice in one day and on two different mechanisms:
 *
 *   run 20260917T082737Z   a repair that trimmed the rows a fault named also
 *                          dropped their siblings' answers, so those sides came
 *                          back. Rounds 4 and 5 were handed a byte-identical
 *                          `7 packets, 34 items`. Cost: 41.3 min, $8.94, and
 *                          `record` never ran in 93 minutes.
 *   run 20260917T100643Z   a submission item named one file to fix and reserved
 *                          another, so every repair minted a fresh name fault.
 *                          Five rounds, `proposed` oscillating 135/136/136/136/134.
 *                          Cost: 90.8 min, no coverage number.
 *
 * Both were found by hand, after the fact, by diffing two rounds' indexes. Both
 * would have been named here on the round after they started.
 *
 * IT WARNS AND DOES NOT REFUSE. A repeat is strong evidence of a loop and it is
 * not proof: a round whose agent turn failed outright — the gateway 403s of
 * `20260917T114326Z`, a DNS blip — legitimately re-asks the same sides, and a
 * walk that killed those runs would have destroyed recoverable work. The budget
 * and the round cap already bound the damage; what was missing is the sentence
 * that says which of the two is happening.
 */
const REPEAT_SAYS =
  "THIS ROUND IS ASKING EXACTLY WHAT THE LAST ONE ASKED. No side was closed, so either the answers are not " +
  "reaching the disk, or answering an item is creating its replacement. Two measured instances: a repair that " +
  "trimmed the rows a fault named also dropped their siblings' answers (run 20260917T082737Z, 41 min for nothing), " +
  "and a submission item that named one file to fix while its packet reserved another, so every repair minted a " +
  "fresh fault (run 20260917T100643Z, 91 min, no coverage). Read the previous round's submissions before deriving " +
  "anything new: if an answer was written and did not count, that is the defect, not the input.";

/**
 * ONE LINE PER PENDING DECISION IN THE RUN LOG, whatever shape the step gave it.
 *
 * Stage-3 items carry `kind` and `question`; the sweep's domain ask carries
 * `id` and `says` (a brief, many lines long) and a `brief` of pairs. The
 * printer read only the first shape, so every fleet run that swept printed
 * `  - [undefined] undefined` (ai-interview-centralization, pricing-service,
 * and 25 other logs in the PR #38 probes). The line now names the item by the
 * first of kind / id it has, and says the first line of question / says.
 */
export function decisionLine(item) {
  const kind = item?.kind ?? item?.id ?? "decision";
  const where = item?.file ? (item.line ? ` (${item.file}:${item.line})` : ` (${item.file})`) : "";
  const text = [item?.question, item?.says, item?.reason]
    .find((v) => typeof v === "string" && v.trim())
    ?.trim()
    .split("\n")[0];
  const size = Array.isArray(item?.brief) ? ` (${item.brief.length} item(s) in its brief)` : "";
  return `  - [${kind}]${where} ${text ?? "(no question text; see the worklist)"}${refusedBecause(item)}${size}`;
}

/**
 * THE REFUSING TOOL'S OWN SENTENCE, on the line that says it refused.
 *
 * A refused submission's question is `<file>#<at>: <tool> exited N` on its
 * first line and the tool's stderr on the lines after (derive.mjs
 * `toolFailure`). The item carries all of it to the answering turn; the run log
 * printed the first line only. profile-centralized (September 2026) logged 25
 * lines of `blocked.mjs exited 2` across five rounds and not one of them said
 * why, so a reader of the log could not tell a wrong declaration from a broken
 * writer - the reason was on disk in the handover, one file away. Bounded,
 * because this is a log line and the handover keeps the whole text.
 */
const REFUSAL_CHARS = 400;
function refusedBecause(item) {
  if (item?.kind !== "submission") return "";
  const why = item?.context?.submission?.why;
  if (typeof why !== "string") return "";
  const said = why.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).join(" ");
  if (!said) return "";
  return ` — ${said.length > REFUSAL_CHARS ? `${said.slice(0, REFUSAL_CHARS - 1)}…` : said}`;
}

export function writeWorklist(path, step, pending, progress = null, env = process.env) {
  // Rendered in full BEFORE anything reaches the disk, so an item refused by
  // `pendingJson` leaves no half-written handover for the next turn to answer
  // out of — and with several files to write that matters more, not less.
  const groups = bundlesOf(pending).map((g) => ({ ...g, rendered: g.items.map(pendingJson) }));

  mkdirSync(dirname(path), { recursive: true });
  const packetsDirPath = packetDirFor(path);

  /* ---------------------------------------------------------------------- *
   * THE DIGEST GOES FIRST, AND THE PACKETS ARE BUILT BESIDE THE ROUND THEY
   * REPLACE.
   *
   * WHAT THIS USED TO DO, in order: delete the packets directory, write the
   * packet files one at a time, and write the index LAST — all of it under the
   * PREVIOUS round's `.sha256`, which named files that no longer existed from
   * the first line of it.
   *
   * WHAT THAT COST. A container kill anywhere in that window leaves a handover
   * whose digest names deleted files, and `tamperReason` reads a deleted file
   * exactly as it reads an edited one: "<file> is gone since the workflow wrote
   * it … This walk does not repair it and does not rewrite it." That refusal is
   * the FIRST thing `walk` does, before any step is asked, so every later
   * invocation dies on it — and the walk says out loud that it will not fix it.
   * A run is then wedged by a crash that happened to land in a window of a few
   * milliseconds, and the only way out is a person deleting files by hand.
   *
   * WHY THE DIGEST FIRST RATHER THAN A LOCK OR A JOURNAL. `tamperReason`
   * already has the right answer for "nothing was recorded": a missing `.sha256`
   * is not evidence of a change and does not refuse — that is the first-run
   * case and the cleared-handover case, and its own docblock says absence is
   * not evidence. So removing the record BEFORE touching what it describes
   * makes every interrupted state read as "nothing recorded", which is true:
   * this round's handover is not finished, and the next invocation rebuilds it
   * from the step rather than refusing to look at it. The record is written
   * back by `recordDigest`, from the disk, after the index lands.
   *
   * AND THE PACKETS ARE STAGED. The directory is built under a sibling name and
   * moved into place in one `renameSync`, so the window in which the packets
   * directory is half-written does not exist at all; only the swap itself is
   * unprotected, and a kill there leaves either the old round or the new one
   * whole. The index is still written last, which is what makes the swap safe
   * in the other direction: a reader that finds new packets under an old index
   * finds an index naming `packet-01.json … packet-NN.json`, the same names.
   * ---------------------------------------------------------------------- */
  rmSync(digestPath(path), { force: true });
  // A SIBLING, not a tmpdir: `renameSync` is only atomic within one filesystem,
  // and os.tmpdir() is a different one often enough that this would silently
  // become a copy — which is the non-atomic write this exists to remove.
  const stagingDirPath = `${packetsDirPath}.writing`;
  rmSync(stagingDirPath, { recursive: true, force: true });
  mkdirSync(stagingDirPath, { recursive: true });

  const packets = [];
  groups.forEach((group, i) => {
    const name = packetFileName(i + 1, groups.length);
    const packetPath = join(stagingDirPath, name);
    // THE PACKET'S OWN BLOCK AT THE TOP, ONCE. The roster and the reading plan
    // are properties of the packet, so they are written where the packet is and
    // not copied onto each of its items. On the 146-side round those two were
    // 32% of the artifact, because a roster restated on each of its own sides
    // grows as the square of the packet.
    const body = JSON.stringify({ step, packet: group.header, pending: group.rendered }, null, 2) + "\n";
    writeFileSync(packetPath, body, "utf8");
    packets.push({
      // Relative to the index, which is the directory a reader is already in.
      file: `${basename(packetsDirPath)}/${name}`,
      id: group.header?.id ?? null,
      name: group.header?.name ?? null,
      at: group.header?.file ? `${group.header.file}${group.header.line ? `:${group.header.line}` : ""}` : null,
      items: group.rendered.length,
      // WHERE THIS PACKET WRITES, carried so the queue can keep two packets
      // that share a destination off two workers. See `writesOf`.
      writes: group.header?.answers?.file ?? null,
      // PLAN 20 T2.2a: WHETHER THIS PACKET'S FILE MAY BE READ BY TWO WORKERS,
      // copied off the packet header so the queue can obey it. The dealer used
      // to split a small round's file one packet per entry whether or not a
      // note existed, which is the duplicate reading `clusterPackets` refuses.
      mayBeSplit: group.header?.cluster?.mayBeSplit ?? null,
      // PLAN 20 T2.1: how many rounds running this packet's worker was cut off.
      // Non-zero only with CHARPILOT_CARRY_CUTOFF=on; the queue deals it first.
      carried: group.header?.carried?.times ?? 0,
      // PLAN 20 T2.5d: the worker type this packet goes to, when not the default.
      ...(group.header?.worker ? { worker: group.header.worker } : {}),
      // The sides this file answers, so the index can be read as a routing
      // table without opening anything.
      sides: group.rendered.map((p) => p.id),
      // D38: and the sides a grouped item speaks for beside its lead, so the
      // per-side count (`handover.answered`) credits every member it dealt.
      ...membersOf(group.rendered),
      bytes: Buffer.byteLength(body, "utf8"),
    });
  });

  // THE SWAP. LAST ROUND'S FILES GO HERE and not before the writing started: a
  // round with fewer packets than the one before it would otherwise leave
  // `packet-09.json` lying about, naming sides that are not open any more — and
  // the index would not mention it, so nothing would ever say it was stale.
  // Removing the old directory immediately before the rename keeps that
  // property and shrinks the window it used to be true in from "the whole
  // write" to "two syscalls".
  rmSync(packetsDirPath, { recursive: true, force: true });
  renameSync(stagingDirPath, packetsDirPath);

  // READ BEFORE THE WRITE: `path` still holds the round this one is replacing.
  const prior = priorHandover(path);
  const signature = handoverSignature(packets);
  const repeated = signature && prior.signature === signature ? prior.repeated + 1 : 0;

  const header = indexHeader(packets);
  // THE STEP'S OWN TRANSITION STATE, carried forward so the next round can ask
  // whether anything moved. The walk stores it and reads nothing from it — the
  // step that wrote it is the only thing that knows what its numbers mean.
  if (progress && typeof progress === "object") header.progress = progress;
  if (repeated > 0) {
    header.repeated = repeated;
    header.repeatedSays = REPEAT_SAYS;
  }
  // D76. Per step, and inherited across the rounds that were not this step's.
  header.asks = asksAfter(prior, step, signature, env);
  // D38. The round being replaced is settled here, for the step whose round it
  // was: each side a turn that answered actually received counts once. See
  // `answeredAfter` in steps/handover.mjs, which `repair` reads too.
  const runId = askRunId(env);
  if (runId) header.run = runId;
  header.answered = answeredAfter({ prior, env, workers: roundWorkers(join(dirname(path), "rounds"), prior.packets) }).answered;
  const body = JSON.stringify({ step, handover: header, packets }, null, 2) + "\n";
  writeFileSync(path, body, "utf8");
  return { path, packets, repeated, asks: header.asks };
}

/**
 * WHAT ONE PACKET COSTS A WORKER, IN ITEMS.
 *
 * Fitted against the nine workers of round 1 of run 20260917T082737Z, which is
 * the only round where per-worker start and finish times and per-worker packet
 * rosters are both on the log: T = 4.8 min/packet + 0.16 min/item, rss 116,
 * n=9. One reading is worth thirty items, so a packet's SIZE is a nudge and its
 * EXISTENCE is the cost.
 *
 * That run is also why this number is not bytes and not items. Its slowest
 * worker held four packets and eleven items and took 27.6 min; its worker
 * holding packet-25 — forty items, 389,674 bytes, the largest in the round —
 * took 26.5. Weighing by either size alone deals the small packets four-deep
 * onto one worker and rebuilds exactly that tail.
 */
const READING_WEIGHT = 30;

/**
 * HOW MANY WORKERS THE ROUND IS DEALT TO — DERIVED FROM THE ROUND, NEVER FIXED.
 *
 * A worker's time is `READING_WEIGHT * itsPackets + itsItems`, in items. Two
 * things bound the round:
 *
 *   the biggest packet, alone       READING_WEIGHT + maxItems
 *   all the work, split perfectly   (READING_WEIGHT * packets + items) / W
 *
 * No W makes the round shorter than the first, because a packet is never split.
 * So the useful W is the smallest one whose second term has dropped to the
 * first, and that is arithmetic on numbers this function already has:
 *
 *   W* = ceil( (READING_WEIGHT * packets + items) / (READING_WEIGHT + maxItems) )
 *
 * Every worker past W* is idle by construction; every worker short of it is a
 * second reading queued behind a first. On round 1 of run 20260917T082737Z —
 * 34 packets, 146 items, largest 40 — that is ceil(1166 / 70) = 17.
 *
 * A round of few large packets lands near one worker per packet; a round of
 * many one-item packets lands far below it and bundles them, which is the
 * whole point: a worker that finishes a one-item packet and returns for another
 * pays a round trip through the lead for six minutes of work.
 *
 * THE CEILING IS NOT OPTIONAL, AND IT IS THE RUNTIME'S, NOT OURS. Asking for
 * more workers than the CLI allows is not a queue. It is a refusal —
 * "Concurrent subagent limit reached. You can run N subagents at once. Do not
 * retry." — so the packets in the overflow get no worker at all, and a round
 * that silently answered fewer sides than it was asked is the exact failure
 * this whole handover exists to remove.
 *
 * So the cap is read from CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, which is the
 * variable the CLI itself obeys and which the container sets (entrypoint.py,
 * localrun.py). One number, one place, and the deal cannot ask for more than
 * the runtime will start. CHARPILOT_STAGE3_WORKERS lowers it further for a
 * single run without touching the runtime.
 *
 * THE READING ITSELF MOVED, and this file no longer holds a second copy of it.
 * `workerConcurrency` in steps/handover.mjs is the one definition, because
 * derive.mjs now sizes the round against the SAME number — a round is
 * `concurrency x minutes / packet-minutes` packets — and two readings of one
 * cap is exactly the drift `steps.never-repair-a-tools-output` exists to stop.
 */

/**
 * HOW MANY PACKETS ONE WORKER CARRIES — AND WHY IT IS NOT ONE.
 *
 * `W*` above is the makespan-optimal count and it was MEASURED WRONG. Giving
 * the round's biggest packet a worker to itself made that packet SLOWER, not
 * faster, on two runs of the identical 146-side round against commit e04b295
 * with the same model:
 *
 *   packet-25 (40 sides), bundled with packets 31, 15 and 8   26.5 min
 *   packet-25 (40 sides), alone on a dedicated worker          42.8 min
 *
 * The two bundles were the same size — 44 items against 41, within 7% — so
 * this is not load. The LIGHTER bundle lost by 62%, and round 1 went 33.0 min
 * at 8 workers x 4 packets to 45.3 min at 12 workers with the giants alone.
 * Whatever costs those sixteen minutes is inside one worker's handling of one
 * packet, and nothing about how packets are distributed reaches it.
 *
 * So the sizing goes back to the shape that has actually produced a finished
 * round — run 20260917T070737Z, 96.39% in 46 minutes, four packets to a
 * worker. What is KEPT from the derived version is the part that measured
 * well on its own: the deal is still computed here and written into the index,
 * which took the lead's first dispatch from +11.0 min to +2.5 min, and the
 * bundles are still balanced by weight so no worker draws two giants.
 *
 * CHARPILOT_PACKETS_PER_WORKER is the A/B knob. Set it to 1 to get the
 * one-packet-per-worker shape back without editing this file.
 */
/**
 * ONE WORKER PER PACKET, UP TO THE CEILING — bundling is what happens when
 * there are more packets than workers, never a target of its own.
 *
 * THE DEFECT THIS REPLACES. This divided by a fixed 4 packets per worker, and
 * that number was fitted on round 1, where a packet costs 0.30 min/item. In
 * the TAIL a packet costs 2.9 min/item — eight to ten times more — and the
 * same rule then caps the fan-out exactly where the packets are expensive.
 * Measured on run 20260917T140215Z:
 *
 *   round 1   34 packets, 146 items   ->  9 workers   44m   0.30 min/item
 *   round 2    8 packets,   8 items   ->  2 workers   23m   2.9  min/item
 *   round 3   14 packets,  14 items   ->  4 workers   33m   2.4  min/item
 *
 * Rounds 2 and 3 had one independent packet per item and ran them two and four
 * at a time. Round 3 spent 167 tool calls across 4 workers and moved
 * `verifyActionable` from 8 to 8.
 *
 * AND THE REASON FOR THE OLD RULE DID NOT SURVIVE THE DAY. 5cfa052 set 4 on
 * the premise that bundling made `packet-25` fast — but run 20260917T070737Z's
 * own log says "C2 — matchingLocations (packet-25, 40 sides, solo)". It was
 * solo in the fast run too, so bundling was never why.
 *
 * So the count is one per packet, and the ceiling does the bundling when it
 * must: 34 packets against a ceiling of 12 gives 12 workers holding 2-3 each,
 * while 8 packets gives 8 workers holding one. CHARPILOT_PACKETS_PER_WORKER
 * still forces the old behaviour for an A/B.
 */
function workerCount(packets) {
  if (!packets.length) return 0;
  const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);
  const per = positive(process.env.CHARPILOT_PACKETS_PER_WORKER);
  const wanted = per ? Math.ceil(packets.length / per) : packets.length;
  // THE DEAL MUST NOT CLAIM THE WHOLE CONCURRENCY BUDGET, and the quarter held
  // back for the workers' own fan-out is `workerConcurrency`'s business now —
  // one reading of the cap, shared with the step that sizes the round against
  // it. The measurement that put the slack there (run 20260917T170601Z, a
  // sub-spawn against a full ceiling, 798d2f9) is written down there.
  return Math.max(1, Math.min(packets.length, wanted, workerConcurrency()));
}

/**
 * DEAL THE PACKETS INTO ONE BUNDLE PER WORKER, HEAVIEST FIRST ONTO THE LIGHTEST
 * WORKER.
 *
 * WHY THE INDEX DEALS AND NOT THE AGENT. The agent that dealt its own round in
 * run 20260917T082737Z spent 11 minutes reading packet sizes before it
 * dispatched anything, with ten workers idle behind it. Every number that deal
 * needs — `items`, `bytes` — is already computed here, before the index is
 * written, so the round can arrive already dealt and the first worker can start
 * on the agent's first turn.
 *
 * WHY A QUEUE AND NOT ONE BUNDLE PER WORKER — D66, and this reverses what this
 * comment used to say. "A worker that finishes a one-item packet and comes back
 * for another pays a full round trip through the lead" is true and it is the
 * SMALLER cost. A bundle per worker makes the round ONE WAVE: it is dispatched
 * in a single burst and ends when the slowest bundle returns, however early the
 * others did.
 *
 * NO RUN HAS EVER DONE ANYTHING ELSE, AND THAT IS THE POINT. Counted off the
 * `· Agent:` lines, run 20260919T092410Z dispatched 7, 6, 6 and 6 — one burst
 * of one to two minutes a round, then forty-five minutes of waiting (round 1's
 * burst ended 09:27:08 and round 2's began 10:18:18; round 2's ended 10:20:06
 * and round 3's began 11:05:03). This block credited 20260919T181800Z, which
 * has ONE round, twelve dispatches inside 2.2 minutes and a 21-minute life —
 * it cannot show a four-round pattern, and the numbers were never its. Run
 * 20260918T073111Z looks like a counter-example at 9, 10, 18, 9, 19, 3 with
 * round 5's launches spanning fifteen minutes, and it is NOT one: those
 * nineteen are nine launches that all failed on an invalid model id
 * ("All 9 workers failed at launch — `claude-opus-5` isn't a valid model ID in
 * this environment"), nine relaunches, and one later one-off. No parent in any
 * logged run has refilled a slot on return. This is NEW BEHAVIOUR being built,
 * not behaviour being restored, and nothing below should be read as citing a
 * precedent for it.
 *
 * AND THE WAVE COSTS TWICE. It idles every early worker until the slowest
 * returns, and then the parent reconciles single-threaded: on run
 * 20260918T073111Z round 5 the last worker finished at 10:25:30 and the parent
 * did not finish consolidating until 10:34:48 — nine minutes of wrap-up with
 * the whole fan-out idle. The newest tracy build says the same thing from the
 * other side: "Packet-06 and packet-01 are both done … waiting on the remaining
 * 10 workers". So refill-on-return and materialise-as-it-lands are one change,
 * and `dealSays` asks for both.
 *
 * The unit dealt is still a whole FILE GROUP — affinity is untouched, and the
 * measurement that put it there (132 source reads scattered against 40 grouped)
 * is below — but the groups are handed over as an ORDERED QUEUE with a
 * concurrency beside it. That is what `PARALLELISM.howToDeal` has said since it
 * was written; the artifact is what contradicted it.
 */
/**
 * THE SOURCE FILE A PACKET'S WORKER HAS TO READ, or null when the index does
 * not say. `at` is "src/services/location.service.ts:278".
 */
function sourceOf(packet) {
  const at = packet?.at;
  if (typeof at !== "string" || !at) return null;
  return at.replace(/:\d+$/, "");
}

/**
 * WHERE A PACKET WRITES ITS ANSWER — a correctness key, not a preference.
 *
 * MEASURED, run SMOKE-1round-5a438f4. Four packets, two destinations:
 * packet-01 and packet-03 both reserved `answers-518fe7188fba.json`, packet-02
 * and packet-04 both reserved `answers-efbbbaaa0143.json`. Each pair is one
 * function seen from two ends -- an open-side item and the validator's verdict
 * on the rows that claim those very sides -- and the deal put each pair on two
 * workers at once. packet-03's write was refused by a stale-read guard about
 * 80 seconds after packet-01's landed.
 *
 * THE REFUSAL IS THE LUCKY OUTCOME. Had packet-03 won that race it would have
 * replaced a correct two-row repair with its own document, and by the
 * replacement rule nothing would have said so. The reserved-name scheme makes
 * two workers ON ONE PACKET safe; it says nothing about two packets that
 * reserve one name, and until now nothing did.
 *
 * `sourceOf` is an affinity PREFERENCE -- group by it and a file is read once.
 * This is not negotiable in the same way: two packets on one destination must
 * be dealt to one worker, whatever their sources are, because the alternative
 * is a lost write that reports success.
 */
function writesOf(packet) {
  const to = packet?.writes;
  return typeof to === "string" && to ? to : null;
}

/**
 * ONE SOURCE FILE, ONE WORKER — the largest measured sink in the fan-out.
 *
 * A packet is one function, but a FILE holds many functions, and a worker that
 * opens `location.service.ts` to answer one packet has paid for every other
 * packet in that file too. Scattering a file's packets across workers makes
 * every one of them rebuild the same context from scratch.
 *
 * MEASURED on round 1 of three runs doing identical work — 146 sides, 34
 * packets, commit e04b295, claude-sonnet-5:
 *
 *   run 20260917T070737Z   8 workers, grouped BY FILE     40 source reads  (5.0/worker)
 *   run 20260917T082737Z  10 workers, scattered          132 source reads (13.2/worker)
 *   run 20260917T100643Z  12 workers, scattered          147 source reads (12.2/worker)
 *
 * `googleMap.service.ts` was read 6 times in the first and 38 times in the
 * third. Round 1 went 31.6 min to 44.6 min. The waste scales with WORKER COUNT
 * and not with work, which is the shape of "more parallelism made it slower".
 *
 * Run 20260917T070737Z's own words. IT DID NOT FINISH — its result.json says
 * `"status": "failed"`, "the agent exited 1 in round 12 - the turn failed
 * rather than ran out of work, and round 12 was the last" — and this comment
 * called it "the only run that ever finished" twice. Four runs finished
 * (20260908T174455Z, 20260916T031317Z, 20260917T172502Z, 20260917T181622Z;
 * see `nodejs/tests/fixtures/runs-on-record.json`) and this is none of them.
 *
 * WHAT IT IS STILL THE EVIDENCE FOR is the table directly above: round 1 of
 * three runs doing identical work, where this one grouped BY FILE and paid 40
 * source reads to the scattered runs' 132 and 147. That measurement is of
 * ROUND 1 and does not depend on round 12, which is where the run died. The
 * grouping below is designed against that round, not against an outcome:
 *
 *   **B1** — googleMap.service.ts part 1 (03, 04, 05, 06)
 *   **B2** — googleMap.service.ts callbacks (16, 17, 18, 19, 20)
 *   **A**  — decorator packets (02, 12, 13, 14) — googleLocationCache.decorator.ts
 *
 * WHAT THIS GIVES UP, deliberately: even bundles. A file with many packets
 * lands whole on one worker and that worker carries more weight than its
 * siblings. That is the trade — balancing by weight is what CAUSED the scatter,
 * and the barrier cost of one heavy worker measured smaller than the re-read
 * cost of twelve. A file group still goes to the LIGHTEST worker, so the
 * balance survives wherever affinity does not decide.
 *
 * IT IS A PREFERENCE, NOT A LAW. Packets whose `at` is missing are dealt
 * individually, exactly as before.
 */
export function queuePackets(packets) {
  const workers = workerCount(packets);
  if (workers < 1) return [];
  // Group first, so a file's packets are placed as one unit. A packet with no
  // source of its own is its own group and is placed on its own merits.
  const groups = new Map();
  let loose = 0;
  for (const p of packets) {
    // PLAN 20 T2.1: A CARRIED PACKET IS ITS OWN ENTRY, so it has a worker to
    // itself for the whole round. The destination merge below still applies:
    // two packets on one answer file are one writer, carried or not.
    const key = (p.carried ?? 0) > 0 ? `\u0000carried-${p.id ?? loose++}` : (sourceOf(p) ?? `\u0000loose-${loose++}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  // THEN MERGE ANY GROUPS THAT SHARE A DESTINATION. Source grouping is the
  // affinity preference; this is the correctness constraint on top of it, and
  // it has to be a merge rather than a different key: keying on the
  // destination instead would scatter a file whose packets write to different
  // names, losing the reading affinity for a race that was not there.
  //
  // A destination seen in two source groups joins them, transitively -- A and
  // B share one name, B and C share another, so all three are one entry and
  // one worker. See `writesOf` for the run this comes from.
  const homeOf = new Map();
  const find = (k) => {
    let r = k;
    while (homeOf.get(r) !== r) r = homeOf.get(r);
    for (let at = k; at !== r; ) {
      const next = homeOf.get(at);
      homeOf.set(at, r);
      at = next;
    }
    return r;
  };
  for (const key of groups.keys()) homeOf.set(key, key);
  const byDestination = new Map();
  for (const [key, ps] of groups) {
    for (const p of ps) {
      const to = writesOf(p);
      if (!to) continue;
      const first = byDestination.get(to);
      if (first === undefined) {
        byDestination.set(to, key);
        continue;
      }
      const a = find(first);
      const b = find(key);
      if (a !== b) homeOf.set(b, a);
    }
  }
  const merged = new Map();
  for (const [key, ps] of groups) {
    const home = find(key);
    if (!merged.has(home)) merged.set(home, []);
    merged.get(home).push(...ps);
  }

  let units = [...merged.values()].map((ps) => ({
    packets: ps,
    items: ps.reduce((n, x) => n + x.items, 0),
    weight: ps.reduce((n, x) => n + READING_WEIGHT + x.items, 0),
  }));

  // AFFINITY IS A PREFERENCE, BOUNDED BY WHAT ONE ENTRY MAY HOLD — and run
  // 20260917T070737Z's ROUND 1 is what put the bound there. (That run failed
  // in round 12; it is not, as this comment twice said, "the only run that
  // finished". Four runs did. What round 1 of this one has is the by-file
  // deal, measured against two scattered runs doing identical work.)
  // It kept a file on one worker where it could and SPLIT the two big ones
  // where it could not: `B1` took googleMap.service.ts packets 03-06 and `B2`
  // took its callbacks 16-20; `C2` took matchingLocations alone and `C4` took
  // location.service.ts 31-33. Pure affinity would have put all twelve
  // location.service.ts packets on one worker and left most of the fan-out
  // idle, which is a different way to lose the same time.
  //
  // THE BOUND IS NOW ITEMS AND NOT A SHARE OF THE ROUND'S WEIGHT, because items
  // is what a worker's time is linear in — 0.76 to 2.70 minutes an item over
  // the workers of run 20260919T092410Z — and a fair share of the round is the
  // wrong shape twice over. It moves when the round's size moves, and it says
  // nothing about whether one entry outlasts the round: run 20260918T094824Z
  // ended with 23.0 minutes of ONE worker on 50 items while eight sat idle, and
  // that entry was inside any fair share you like. `entryItemCap` is
  // `roundBudgetMin / itemMinutes`, which is what one worker can finish.
  // TWO BOUNDS IN ONE NUMBER, AND BOTH ARE IN ITEMS.
  //
  //   entryItemCap()      no entry outlasts the round — `roundBudgetMin /
  //                       itemMinutes`, 37 items at the defaults. Run
  //                       20260918T094824Z ended with 23.0 minutes of ONE
  //                       worker on 50 items while eight sat idle.
  //   the fan-out's share pure affinity would put a whole file's packets on one
  //                       entry and starve every other worker, which is a
  //                       different way to lose the same time. A file's entries
  //                       are therefore no larger than one worker's share of
  //                       the round.
  //
  // The smaller of the two wins, and `pieces` is the FEWEST that brings the
  // group under it — two reads of one file, not twelve.
  const totalItems = units.reduce((n, u) => n + u.items, 0);
  const share = Math.max(1, Math.floor(totalItems / workers));
  const cap = Math.min(entryItemCap(), share);
  // PLAN 20 T2.2a, ON BY DEFAULT (strict) since the nginx A/B (run 20260924T091852Z); CHARPILOT_DEAL_AFFINITY=off is the
  // rollback. In a small tail round `share` falls to 1 or 2, so a
  // file with several packets was split one packet per entry and read by that
  // many workers. With the flag on, a file is split for the fan-out only when
  // every packet on it says `mayBeSplit` — a note exists, so a second worker
  // reads the note and not the file. Otherwise only `entryItemCap` splits it,
  // the bound that no entry outlasts the round, which is never relaxed.
  const strict = !["off", "loose"].includes(process.env.CHARPILOT_DEAL_AFFINITY ?? "strict");
  const capFor = (u) => (strict && !u.packets.every((pk) => pk.mayBeSplit === true) ? entryItemCap() : cap);
  const placeable = [];
  for (const u of units) {
    // THE SPLIT'S UNIT IS A DESTINATION, NOT A PACKET. Splitting is what puts
    // two pieces of one group on two workers, so a split that separated two
    // packets writing to one name would reintroduce the race the merge above
    // exists to remove -- on the entries big enough to matter. Packets with no
    // reserved name are their own atoms and split exactly as before.
    const byName = new Map();
    const atoms = [];
    for (const pk of u.packets) {
      const to = writesOf(pk);
      if (!to) {
        atoms.push({ packets: [pk], items: pk.items });
        continue;
      }
      let atom = byName.get(to);
      if (!atom) {
        atom = { packets: [], items: 0 };
        byName.set(to, atom);
        atoms.push(atom);
      }
      atom.packets.push(pk);
      atom.items += pk.items;
    }
    const unitCap = capFor(u);
    if (u.items <= unitCap || atoms.length < 2) {
      // A SINGLE PACKET OVER THE CAP IS LEFT WHOLE, deliberately. Splitting a
      // packet needs the note cache primed first (plan 15's D47a) or the split
      // trades a straggler for the duplicate reading affinity existed to
      // remove, and a packet is one reading by definition. tracy's `packet-02`
      // is 37 items in a 623 KB brief and is exactly that case.
      placeable.push(u);
      continue;
    }
    // Fewest pieces that fit, heaviest packet first into the lightest piece —
    // the same greedy one level down, so a split file's halves are even.
    const pieces = Math.min(atoms.length, Math.ceil(u.items / unitCap));
    const parts = Array.from({ length: pieces }, () => ({ packets: [], items: 0, weight: 0 }));
    for (const atom of [...atoms].sort((a, b) => b.items - a.items)) {
      const into = parts.reduce((l, x) => (x.items < l.items ? x : l), parts[0]);
      into.packets.push(...atom.packets);
      into.items += atom.items;
      into.weight += atom.packets.length * READING_WEIGHT + atom.items;
    }
    placeable.push(...parts);
  }

  // MOST ITEMS FIRST, AND THAT IS THE WHOLE SCHEDULE NOW. Under bundles this
  // ordering existed so the big groups chose their bin before the small ones
  // filled it; under a queue it is the classic longest-processing-time rule and
  // it does the same job better — the last entry launched is the smallest, so
  // the tail of the round is the cheapest thing in it. `PARALLELISM.howToDeal`
  // says it this way:
  //
  // QUOTES nodejs/tools/steps/handover.mjs: "Launch `concurrency` entries, largest first, and LAUNCH THE NEXT THE MOMENT ONE RETURNS"
  //
  // This comment used to quote it as "drawn largest file first", which was the
  // bundle-era wording and describes a different rule — one packet per worker,
  // dealt whole, no refill. That phrase now survives in exactly one place,
  // `tests/fixtures/packet-tracy-worker-02.json`, which is a FROZEN SNAPSHOT of
  // the old prose kept so the old shape stays readable. Anybody who went
  // looking for the quote would have found it there and concluded the fixture
  // was the source. It sorts on ITEMS, with the reading
  // weight as the tie-break, for the reason the cap above is in items: run
  // 20260919T092410Z's round 4 balanced packet COUNT and dealt one worker 41
  // items and another 13.
  // PLAN 20 T2.1: carried packets launch FIRST, then the usual order.
  const carriedOf = (u) => Math.max(0, ...u.packets.map((pk) => pk.carried ?? 0));
  return placeable
    .sort((a, b) => carriedOf(b) - carriedOf(a) || b.items - a.items || b.weight - a.weight)
    .map((u, i) => {
      const src = sourceOf(u.packets[0]);
      return {
        // ONE-BASED AND IN LAUNCH ORDER, so "I have launched through entry 12"
        // is a thing the agent can say and the next round can read.
        entry: i + 1,
        packets: u.packets.length,
        items: u.items,
        // What this entry has to READ. The point of the grouping, stated on it.
        sources: src ? [src] : [],
        files: u.packets.map((p) => p.file),
        // PLAN 20 T2.5d: an entry of only light-cohort packets names the lighter
        // worker type; every other entry launches as the default, as before.
        ...(u.packets.length && u.packets.every((p) => p.worker === LIGHT_WORKER_AGENT) ? { workerAgent: LIGHT_WORKER_AGENT } : {}),
      };
    });
}

/**
 * A METRIC THAT IS NOT A NUMBER STILL HAS TO BE READABLE.
 *
 * Template interpolation calls `String(value)`, and `String({})` is
 * `[object Object]`. Measured on run LOCAL-mt-d5542e1, where `repair` printed
 *
 *     repair: byFailure=[object Object]
 *
 * for three rounds. That metric is the classification the step made BEFORE it
 * asked anybody -- `{"not-proposed":9,"reached-other-arm":2,"wrong-side":1}` --
 * and it is the one number that says what KIND of work is left. The same round
 * printed the same breakdown correctly in a `did` sentence, so the information
 * was never lost, only the machine-readable copy of it.
 *
 * FIXED IN THE PRINTER, not in `repair`. Any step may put an object on
 * `metrics` and every one of them would print the same way; a per-metric fix
 * is a fix that has to be repeated by whoever adds the next one.
 *
 * BOUNDED, because a metrics line is read by a person and an unbounded object
 * on one is a log nobody scrolls past. Truncated says so rather than trailing
 * off, so a reader knows to open the document rather than trusting a clipped
 * number.
 */
export const METRIC_VALUE_MAX = 300;

export function metricValue(value) {
  if (value === null || typeof value !== "object") return String(value);
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    // A cycle is not a reason to lose the line the rest of the metrics are on.
    return "[unserialisable]";
  }
  if (text === undefined) return String(value);
  if (text.length <= METRIC_VALUE_MAX) return text;
  return `${text.slice(0, METRIC_VALUE_MAX)}… (${text.length} chars, truncated)`;
}

/**
 * PLAN 20 T2.2d, ON BY DEFAULT since the nginx A/B (run 20260924T091852Z); CHARPILOT_SMALL_ROUND_FANOUT=off is the
 * rollback: EVERY ENTRY GOES TO A WORKER, AND ONLY ONE.
 *
 * Measured both ways on the one-packet bench, BENCH-1pkt-fix1: round 2 had one
 * entry and the parent answered it itself with 0 workers (8.3 min, a merged
 * row claiming 7 sides that measured 0 hits, all 7 withdrawn), and round 3 had
 * one entry and the parent launched 11 workers on it (34 idle worker-minutes,
 * 17.5M cache-read tokens). In the fleet logs, rounds with 2 or more packets
 * and 0 child turns total 84 minutes. The deal already says how many to run
 * at once; this says how many to launch in all.
 */
function smallRoundFanout(entries) {
  if (process.env.CHARPILOT_SMALL_ROUND_FANOUT === "off" || entries < 1) return "";
  return (
    ` EVERY ENTRY GOES TO A WORKER, AND TO ONE WORKER ONLY: ${entries} entry(ies), so ${entries} launch(es) in all, ` +
    'plus a relaunch only for an entry whose launch came back "Concurrent subagent limit reached". This holds in ' +
    "a small round and in a round of one entry: do NOT answer a packet yourself, and do NOT launch a second worker " +
    "on an entry that already has one. A packet file is the whole job for one worker, and a second reader of it is " +
    "a second reading of the same source with nothing new to find."
  );
}

/** What the index says about itself, before it lists anything. */
function indexHeader(packets) {
  const bytes = packets.map((p) => p.bytes);
  const largest = bytes.length ? Math.max(...bytes) : 0;
  const queue = queuePackets(packets);
  // HOW MANY RUN AT ONCE, never how many entries there are. The queue is
  // usually longer than the fan-out and that is the point of it.
  const concurrency = Math.max(0, Math.min(queue.length, workerConcurrency()));
  const budget = roundBudgetMin();
  return {
    packets: packets.length,
    items: packets.reduce((n, p) => n + p.items, 0),
    bytesTotal: bytes.reduce((n, b) => n + b, 0),
    bytesLargest: largest,
    // WHAT THE ROUND'S BRIEFS COST TO READ, said before it launches. Nothing
    // here splits, drops or reorders a packet -- see handover.briefCensus for
    // why the bound is in bytes and why packet-002 is dealt whole anyway.
    brief: briefCensus(packets),
    // KEPT UNDER ITS OLD NAME because it answers the old question — how wide is
    // the fan-out — and `workflow.leaves-room-for-the-workers-own-fanout` reads
    // it. What changed is that it is no longer the length of the deal.
    workers: concurrency,
    concurrency,
    workerAgent: WORKER_AGENT,
    roundBudgetMinutes: budget,
    packetMinutes: packetMinutes(),
    queue,
    dealSays:
      `THE ROUND IS ALREADY DEALT, AS A QUEUE AND NOT AS BUNDLES. \`queue\` is ${queue.length} entry(ies) in LAUNCH ` +
      `ORDER, largest first. Launch ${concurrency} worker(s) on the first ${concurrency}, hand each one the packet ` +
      "FILES its entry names, and THE MOMENT ONE RETURNS LAUNCH THE NEXT ENTRY." +
      ` LAUNCH EVERY WORKER AS subagent_type "${WORKER_AGENT}" — it has no Agent tool, which is what lets this ` +
      "round use the whole concurrency cap. NEVER HAVE MORE THAN " + `${concurrency}` + " IN FLIGHT: count launches " +
      "minus returns, and launch only when that is below it. If a launch comes back \"Concurrent subagent limit " +
      "reached\", that entry was NOT worked: put it back at the FRONT of the queue and launch it when the next " +
      "worker returns. Do not skip it and do not leave it for next round. Do not re-sort it, do not re-deal " +
      "it, and do not hand one worker several entries up front — it cannot start its second until its first is " +
      "done, which is how the round's longest packet ends up waiting behind whatever landed beside it. A packet is " +
      "still never split across workers: every entry hands over WHOLE packet files." +
      " MATERIALISE EACH ENTRY AS IT LANDS. Read its submission, record it and move on — do NOT hold the round's " +
      "consolidation until the slowest worker is back. On run 20260918T073111Z round 5 the last worker finished at " +
      "10:25:30 and the parent was still consolidating at 10:34:48: nine minutes single-threaded with every worker " +
      "idle." +
      ` THE ROUND'S BUDGET IS ${budget} MINUTES. Keep launching until the queue is empty or the budget is spent; ` +
      "when it is spent, stop launching, take what has landed, SAY WHICH ENTRIES YOU NEVER LAUNCHED and end the " +
      "round. They come back next round aimed by a coverage report. A round held open for one worker is the rest of " +
      "the fan-out idle and no new evidence at all." +
      smallRoundFanout(queue.length) +
      (queue.some((e) => e.workerAgent === LIGHT_WORKER_AGENT)
        ? ` AN ENTRY THAT NAMES \`workerAgent\` "${LIGHT_WORKER_AGENT}" IS LAUNCHED AS THAT TYPE; every other entry as "${WORKER_AGENT}".`
        : ""),
    says:
      "THIS FILE IS AN INDEX AND CARRIES NO BRIEF. Each entry below names one file that is a WHOLE, SELF-CONTAINED " +
      "piece of work: open it and you can answer every item in it without opening anything else and without writing a " +
      "script to take it apart. The packet's roster, its reading plan and every block its items share are at the top of " +
      "that file, written once. Pick the packet you are going to answer, open that one file, and answer it. " +
      `The largest is ${largest} bytes; the whole round is ${bytes.reduce((n, b) => n + b, 0)} bytes, and you never have to read that.`,
  };
}

/**
 * WHERE THE HANDOVER'S FINGERPRINT GOES, and why it is a file beside it.
 *
 * The derive prompt tells the answering turn it may not edit
 * `worklist-decisions.json`, and says the workflow records what it handed over
 * and refuses a round that changed it. Nothing else can implement that:
 * docker/finish.py writes `.claude/charpilot/out/` into `.git/info/exclude`, so
 * those files never enter a diff and the pull request cannot see them.
 *
 * Three things ruled out the alternatives:
 *
 *   - It is NOT a second account of the run. It records one fact about one
 *     file — the bytes handed over — and says nothing about which steps ran,
 *     what is covered or what is left. Every `satisfied` answers from the
 *     filesystem precisely because a second account of progress is the one that
 *     turns out to be wrong; a digest cannot disagree with the disk about
 *     progress, because it makes no claim about it.
 *   - It is NOT inside worklist-decisions.json. A file cannot carry its own
 *     hash, and a round that answered items would have to rewrite the record
 *     the guard reads.
 *   - It lives beside the file it describes, named after it, so it is written,
 *     read and deleted with it and cannot survive into a round that has a
 *     different handover.
 *
 * It detects an EDIT, not an adversary: anyone who can rewrite the handover can
 * delete this. That is the honest limit and it is the right one — the answering
 * turn is a process that drifts, not an attacker, and the failure being caught
 * is a round that answered a list it had altered.
 */

/** The sha256 of a file's bytes, or null when it is not there. */
export function digestOf(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Every file this handover consists of, index first, in the index's own order.
 *
 * READ BACK OFF THE INDEX, never from a directory listing. The index is the
 * statement of what was handed over; a listing is whatever happens to be on
 * disk. Taking the list from the index is what lets `tamperReason` below catch
 * a packet file that was DELETED as readily as one that was edited, and a file
 * that appeared that the index does not name.
 */
export function handoverFiles(path) {
  if (!existsSync(path)) return [];
  const names = [basename(path)];
  let index = null;
  try {
    index = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // An unparseable index is still a file whose bytes can be recorded; the
    // step that reads it will say what is wrong with it far better than a
    // digest can.
    return names;
  }
  for (const packet of index?.packets ?? []) if (packet?.file) names.push(packet.file);
  return names;
}

/**
 * Record what was handed over: one `<sha256>  <name>` line per file, index
 * first.
 *
 * ONE RECORD FOR THE WHOLE HANDOVER, not one beside each file. The thing being
 * protected is a ROUND — the index and the packet files are one statement made
 * at one moment — and a per-file digest would let a round be half-restored and
 * still pass. The names are relative to the index's own directory, so the
 * record says nothing about where this checkout happens to live.
 */
export function recordDigest(path) {
  const digest = digestOf(path);
  if (digest === null) return null;
  const root = dirname(path);
  const lines = [];
  for (const name of handoverFiles(path)) {
    const sha = digestOf(join(root, name));
    if (sha === null) continue;
    lines.push(`${sha}  ${name}`);
  }
  writeFileSync(digestPath(path), lines.join("\n") + "\n", "utf8");
  return digest;
}

/**
 * The reason the last handover cannot be trusted, or null.
 *
 * A MISMATCH refuses. A missing record does not: nothing was recorded, which is
 * true of the first run and of any round whose handover was cleared, and
 * refusing on it would fail a repo that has done nothing wrong. Absence is not
 * evidence of a change, and this guard reports only what it can actually see.
 */
export function tamperReason(path) {
  if (!existsSync(path) || !existsSync(digestPath(path))) return null;
  const root = dirname(path);
  const recorded = readFileSync(digestPath(path), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split(/\s+/);
      return { sha, name: rest.join(" ") };
    });
  if (!recorded.length || !recorded[0].sha) return null;

  for (const { sha, name } of recorded) {
    const actual = digestOf(join(root, name));
    if (sha === actual) continue;
    const what = actual === null ? "is gone" : `has changed`;
    return (
      `${join(root, name)} ${what} since the workflow wrote it (recorded ${sha.slice(0, 12)}, found ${String(actual).slice(0, 12)}). ` +
      "That is part of the list of what this run handed over to be answered; answers go into the proposals, never into it. " +
      "This walk does not repair it and does not rewrite it — restore it, or delete it and let the step build the round again."
    );
  }

  // AND NOTHING THE INDEX DOES NOT NAME. Every brief has to be reachable from
  // the index, or a packet can sit on disk unanswered with nothing pointing at
  // it — which is the one failure a fanned-out handover has that a single file
  // could not.
  const known = new Set(recorded.map((r) => r.name));
  const packetsDirPath = packetDirFor(path);
  if (existsSync(packetsDirPath)) {
    for (const entry of readdirSync(packetsDirPath).sort()) {
      const name = `${basename(packetsDirPath)}/${entry}`;
      if (known.has(name)) continue;
      return (
        `${join(root, name)} is not named by ${basename(path)}, which is the index of everything this run handed over. ` +
        "A brief nothing points at is a brief nobody answers. " +
        "This walk does not repair it and does not rewrite it — restore the index, or delete it and let the step build the round again."
      );
    }
  }
  return null;
}

/** So a finished run does not leave last round's questions lying about. */
export function clearWorklist(path) {
  if (existsSync(path)) rmSync(path);
  // The fingerprint goes with the file it fingerprints. Left behind, it would
  // be a record of a handover that no longer exists, and the next round's
  // guard would compare new bytes against an old fact.
  if (existsSync(digestPath(path))) rmSync(digestPath(path));
  // And the briefs the index named. The index alone would leave every packet
  // file on disk with nothing listing them — the exact state `tamperReason`
  // refuses, arrived at by tidying up.
  const packetsDirPath = packetDirFor(path);
  if (existsSync(packetsDirPath)) rmSync(packetsDirPath, { recursive: true, force: true });
}

/**
 * A step that is missing one of its four exports crashes the walk on
 * `step.satisfied is not a function`, which names neither the step nor the
 * contract it broke. Name both instead.
 */
function shapeProblem(step) {
  for (const fn of ["precondition", "satisfied", "run"]) {
    if (typeof step?.[fn] !== "function") return `exports no ${fn}()`;
  }
  return null;
}

/**
 * The refusal for a step whose `satisfied()` or `precondition()` threw.
 *
 * WHAT THE WALK USED TO DO WITH ONE. `await step.satisfied(repo)` and `await
 * step.precondition(repo)` were both written bare, OUTSIDE the try/catch that
 * wraps `run()`. The `run` call was wrapped precisely because it reaches
 * outside itself — and the two predicates reach outside themselves just as far:
 * `steps/ruling.mjs` prices every `istanbul ignore` in `src/` through
 * `suppressions.mjs`, `steps/baseline.mjs` walks the whole of `src/` through
 * `freshness.check`, `steps/record.mjs` parses every file in the proposals
 * directory. Any of those throws on a truncated JSON file, a directory that is
 * not there, or a `src/` a benchmark checkout does not have.
 *
 * WHAT THAT COST. A throw out of a predicate is a rejected promise out of an
 * async `walk`, and `main()` did not wrap `walk` either — so the process died
 * on Node's own unhandled-rejection banner with no `✗ <reason>` line at all,
 * which is the one ending `docker/char/packs/nodejs.py` cannot tell from a
 * killed container. It was also the one ending the salvage could never have
 * reached, because the value `walk` was going to return never existed.
 *
 * REPORTED LIKE ANY OTHER REFUSAL: the step's name, which predicate, the
 * message verbatim, and the same layer-ordering sentence every other refusal in
 * this file ends with.
 */
function predicateThrew(label, which, err) {
  return (
    `${label}: ${which}() threw — ${err?.message ?? err}. ` +
    "A predicate answers FROM THE DISK and must not fail on it, so whatever it read is absent, truncated, or a " +
    "shape it does not handle. " +
    whereToLook()
  );
}

/* ------------------------------------------------------------------------ *
 * SALVAGE: A RUN THAT MEASURED SOMETHING SAYS SO, WHICHEVER WAY IT ENDS.
 *
 * WHAT THIS USED TO DO. `out/result.json` was written by exactly one thing:
 * `report`, the last step of a walk in which every step before it answered
 * `satisfied` true. There are fourteen other ways out of `walk()` and not one
 * of them put a byte on disk, so a run that stopped anywhere else produced
 * nothing at all — no numbers, no reason, no document.
 *
 * WHAT IT COST, measured. Run `20260918T073111Z`, qode-ptp-ms, one shard:
 * open=0, 865 of 865 sides accounted for, 809 proposals, 7 rounds of an allowed
 * 14, zero errors. Sixteen proposals were then in a state `record`'s
 * `satisfied` could not be made true by re-running it, the step refused, and NO
 * `result.json` WAS WRITTEN AT ALL. Every number that run had bought — hours of
 * recording, a full coverage measurement — was discarded at the last gate, and
 * `docker/finish.py:216` reported it as "the nodejs pack wrote no result",
 * which is indistinguishable from a run that never started.
 *
 * WHY HERE AND NOT IN A STEP. A step may not write (the rule
 * `steps.never-repair-a-tools-output.test.mjs` enforces), and in any case the
 * step that refused is by definition the one that could not finish. The thing
 * being recorded is not a tool's artifact: it is THE WALK'S OWN ACCOUNT OF HOW
 * THE WALK ENDED, which is the same narrow exception under which this file
 * already writes the handover and its digest.
 *
 * WHY IT REUSES report.mjs RATHER THAN COMPUTING ANYTHING. See the import at
 * the top. `build()` is the only implementation of "reshape out/coverage.json
 * into the result contract" in the toolset, and a second one here would be free
 * to round differently from the one `report` writes on a good run.
 *
 * WHAT IT REFUSES TO DO: OVERWRITE A REAL RESULT. A `result.json` that
 * `report` wrote is the run's own verdict, `succeeded` or `failed`, computed
 * from a coverage document by the tool that owns the judgement. This replaces
 * it only when the coverage document has MOVED SINCE — i.e. when the real
 * result no longer describes this state — and otherwise leaves it alone and
 * says so. A salvage that stamped `partial` over a finished run's `succeeded`
 * would be this mechanism destroying exactly what it exists to preserve.
 *
 * `status: "partial"` AND WHAT IT MEANS DOWNSTREAM, stated rather than left to
 * be discovered. `docker/finish.py` takes a partial as what it is — a run that
 * measured something and did not finish — so it pushes the branch, opens a pull
 * request naming what is missing, and reports a FAILED run carrying this
 * document's reason and its numbers. The verdict is still failure, because the
 * walk did not finish; what changes is that the failure can be priced and the
 * work can be picked up. The document carries the numbers this run really
 * measured, the step that refused, its words, and what never ran.
 * ------------------------------------------------------------------------ */

/**
 * The two paths the salvage reads and writes.
 *
 * SPELLED HERE, though `steps/report.mjs` and `steps/measure.mjs` each export
 * one of them, and this is a duplication with a reason rather than an
 * oversight. THE WALK MUST LOAD IN AN INSTALLATION THAT CARRIES ONLY THE
 * MODULES ITS `order` NEEDS: `workflow.determinism-before-emit.test.mjs` copies
 * eight files into a temp repo and drives the real `walk` over three steps, and
 * a static `import` of a step this run never walks — or of `report.mjs`, a TOOL
 * — turns "that step is not installed" into a module-resolution error before
 * the first step is even asked. report.mjs itself makes the same call for the
 * same reason and says so at report.mjs:44-52.
 *
 * The values cannot drift silently: both are `resolve(OUT_DIR, <name>)` over
 * the one OUT_DIR config.mjs exports, which is the same expression the two
 * steps use.
 */
export const RESULT_JSON = resolve(OUT_DIR, "result.json");
const COVERAGE_JSON = resolve(OUT_DIR, "coverage.json");

/* ------------------------------------------------------------------------ *
 * FIX PLAN 1, F1.5 — A STEP THAT FAILS IS WRITTEN DOWN, AND THE WALK GOES ON.
 *
 * A step whose tool exits non-zero without its artifact, a step that runs and
 * is still unsatisfied having asked nothing, a step whose `run` or predicate
 * throws: each of these returned EXIT_FAILED, and the pack turned that into a
 * dead run (Stage 40) with no report. Now each is one row of
 * `out/defects.json`, `{ step, kind, tool, exit, message, sides }`, and the walk
 * carries on from the last good artifact. A step whose precondition then fails
 * is written as `kind: "blocked"` with `blockedBy` naming the first defect of
 * this walk. `report` reads the file: a tool defect makes the run `failed`
 * with its numbers (rule 3), a blocked step is named in a `partial`.
 *
 * STAYS FATAL, because they are safety refusals and not tool failures: the
 * tamper check on the handover, and the production-database triple check
 * (`config.assertExpectedDb`), recognised by its own words wherever it
 * surfaces. Also fatal, because there is no step to contain: a step module
 * that cannot be loaded or is not a step, and a question whose worklist could
 * not be written.
 *
 * THE FILE IS THE WALK'S OWN ACCOUNT, like the handover. Each walk rewrites the
 * rows of the steps it visits at their own position and keeps every other row
 * (a step it never reached, or the pack's own `bank-walk` row).
 * ------------------------------------------------------------------------ */
export const DEFECTS_JSON = resolve(OUT_DIR, "defects.json");

/**
 * WHOSE ROWS THESE ARE. out/ persists across a resume, so a run that started
 * from a salvaged branch inherited the previous run's defects.json - and every
 * inherited row turned the new run `failed` for a tool failure it never had
 * (verifier, round 6). Each row now carries the run it was written in; at walk
 * start, rows from any other run move to defects.history.json (kept: they are
 * evidence) and report.mjs counts only this run's.
 *
 * The id is CHARPILOT_RUN_ID, else CHAR_RUN_STAMP (run.sh sets it for the
 * container, so every walk of one run shares it). With neither - a walk run by
 * hand - there is no run to scope to, and nothing is moved.
 */
export function currentRunId(env = process.env) {
  return (env.CHARPILOT_RUN_ID || env.CHAR_RUN_STAMP || "").trim() || null;
}

/** Rows from another run out of `defectsPath`, into defects.history.json beside it. Returns the rows kept. */
export function retireForeignDefects(defectsPath = DEFECTS_JSON, runId = currentRunId()) {
  const rows = readDefects(defectsPath);
  if (!runId) return rows;
  const mine = rows.filter((d) => (d?.run ?? null) === runId);
  const foreign = rows.filter((d) => (d?.run ?? null) !== runId);
  if (!foreign.length) return rows;
  const historyPath = join(dirname(defectsPath), "defects.history.json");
  let history = [];
  try {
    const doc = JSON.parse(readFileSync(historyPath, "utf8"));
    if (Array.isArray(doc?.history)) history = doc.history;
  } catch {
    history = [];
  }
  const movedAt = new Date().toISOString();
  history.push(...foreign.map((d) => ({ ...d, movedAt, movedBy: runId })));
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, `${JSON.stringify({ history }, null, 2)}\n`, "utf8");
  writeDefects(defectsPath, mine);
  return mine;
}
// RULE 2: recognised by the guard's MARKER, never by its wording. Every
// database guard in config.mjs throws with SAFETY_MARKER; the tamper check
// below uses TAMPER_MARKER. `[charpilot:safety:<check>]` names the check.
export const TAMPER_MARKER = "[charpilot:safety:handover-tamper]";
const SAFETY_REFUSAL = /\[charpilot:safety:([a-z-]+)\]/;
void SAFETY_MARKER;
/** The safety outcome a line carries, or null. */
function safetyOutcome(line, name, label) {
  const m = SAFETY_REFUSAL.exec(String(line ?? ""));
  if (!m) return null;
  const reason = `${label}: ${line}`;
  return { code: EXIT_SAFETY, reason, safety: { check: m[1], step: name, reason } };
}

/** The rows of a defects file, or [] when there is none or it cannot be read. */
export function readDefects(path = DEFECTS_JSON) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(doc?.defects) ? doc.defects : [];
  } catch {
    return [];
  }
}

function writeDefects(defectsPath, rows) {
  mkdirSync(dirname(defectsPath), { recursive: true });
  writeFileSync(defectsPath, `${JSON.stringify({ defects: rows }, null, 2)}\n`, "utf8");
}

/** Which tool a step's own lines name as the one that failed, or null. */
function toolIn(did = []) {
  const m = did.map((line) => /^(\S+\.mjs) (?:exited (\d+)|killed by )/.exec(String(line))).find(Boolean);
  return m ? { tool: m[1], exit: m[2] === undefined ? null : Number(m[2]) } : { tool: null, exit: null };
}

/** The result document already on disk, or null when there is not a readable one. */
function resultOnDisk(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Unparseable is not a result anybody can read, so it is not one this
    // refuses to replace. `report` would overwrite it too.
    return null;
  }
}

/** Milliseconds, or null when the file is not there. */
const mtimeOrNull = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Write the partial result, or say why one was not needed.
 *
 * Returns a sentence for the log, always — a salvage that silently did nothing
 * is the same silence this exists to break.
 */
export async function salvageResult({ resultPath, coveragePath, outcome, order = ORDER, step = null }) {
  const existing = resultOnDisk(resultPath);
  const coverageAt = mtimeOrNull(coveragePath);
  const resultAt = mtimeOrNull(resultPath);
  // "FOR THIS SAME STATE" IS A TIMESTAMP, not a guess. `report` derives
  // result.json from coverage.json and nothing else, so a result at least as
  // new as that coverage document describes the coverage document on disk now.
  // Older, and the measurement moved after the verdict was taken, so the
  // verdict is about a run that no longer exists.
  // A `partial` report.mjs wrote is a verdict, not a salvage, and is kept like
  // any other (fix plan 1, rule 3).
  const isSalvage = existing?.status === "partial" && existing.partial?.reportedBy !== "report.mjs";
  // RULE 2: a safety refusal is written over whatever is there, as `failed`,
  // because the pack reads this document to decide what to deliver and a
  // standing `succeeded` or `partial` must not outlive the refusal.
  if (outcome?.safety) {
    let numbers = {};
    try {
      const { build } = await import(new URL("./report.mjs", import.meta.url).href);
      const b = build(coveragePath);
      numbers = { coverage_percentage: b.coverage_percentage ?? null, rulings: b.rulings ?? null };
    } catch {
      numbers = { coverage_percentage: null };
    }
    const doc = { status: "failed", failed_reason: outcome.reason, pr_url: null, ...numbers, safety: outcome.safety };
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    return `wrote ${relative(REPO_ROOT, resultPath) || resultPath} — status failed, SAFETY REFUSAL (${outcome.safety.check}): the work stays off the remote`;
  }
  if (existing && !isSalvage && (coverageAt === null || (resultAt !== null && resultAt >= coverageAt))) {
    return (
      `${relative(REPO_ROOT, resultPath) || resultPath} already carries a \`${existing.status}\` result that ` +
      `${relative(REPO_ROOT, coveragePath) || coveragePath} has not changed under — left exactly as report.mjs wrote it`
    );
  }

  // THE NUMBERS COME FROM THE TOOL THAT OWNS THE CONTRACT, never from here.
  //
  // `report.mjs:build()` is the one implementation of "reshape
  // out/coverage.json into `coverage_percentage`" in this toolset — the same
  // function `report` spawns on a good run — so a salvage and a finished run
  // cannot round differently or disagree about which totals mean what. It takes
  // the coverage path as an argument, so config.mjs's OUT_DIR is passed rather
  // than the CWD-derived default it computes for itself.
  //
  // IMPORTED HERE AND NOT AT THE TOP. See the note on RESULT_JSON: the walk has
  // to load in an installation that carries only the modules its `order` needs,
  // and this is the only path that reads a tool. An uninstalled report.mjs then
  // costs the numbers, not the document.
  let base;
  try {
    const { build } = await import(new URL("./report.mjs", import.meta.url).href);
    base = build(coveragePath);
  } catch (err) {
    // `build` documents itself as never throwing, and the import can still fail
    // on a partial installation. Either way the salvage has to land: a result
    // document that says only "the reporter could not be read" is worth more
    // than no file, because it is the difference between a run that failed and
    // a run nobody can tell apart from one that never started.
    base = {
      status: "failed",
      failed_reason: `report.mjs could not build a result from ${coveragePath}: ${err?.message ?? err}`,
      pr_url: null,
      coverage_percentage: null,
    };
  }

  const at = step === null ? -1 : order.indexOf(step);
  const missing = [];
  if (at >= 0) {
    // A HANDOVER IS NOT A REFUSAL. Exit 75 is `sweep` or `derive` asking a
    // question and waiting for its answer, which is the walk working as
    // designed; ai-interview-centralization's salvage said "`sweep` refused".
    const how = outcome?.code === EXIT_NEEDS_DECISION
      ? `handed over a decision (exit ${EXIT_NEEDS_DECISION}) and is waiting on its answer`
      : "refused";
    missing.push(
      `\`${step}\` ${how}, so it and the ${order.length - at - 1} step(s) after it did not finish: ` +
        `${order.slice(at).join(", ")}. Nothing those steps produce is in this document.`
    );
  }
  // `partial` too: since fix plan 1 report.mjs says why a measured run is not
  // a success with that status, and a salvage that dropped the sentence lost
  // the verdict's reason (step-1 fixup C).
  if ((base.status === "failed" || base.status === "partial") && base.failed_reason) {
    missing.push(`the numbers below are what ${relative(REPO_ROOT, coveragePath) || coveragePath} could give: ${base.failed_reason}`);
  }
  if (existing) {
    missing.push(
      `this replaced a \`${existing.status}\` result.json that was older than the coverage document it was ` +
        `computed from, so it described a measurement that has since been replaced`
    );
  }

  const doc = {
    ...base,
    // LAST, so it wins over whatever `build` decided. The rate rule and the
    // false-claim rule are report.mjs's to apply and they are still applied —
    // their sentences are kept in `failed_reason` below — but the STATUS of a
    // walk that did not reach `report` is neither of its two verdicts.
    status: "partial",
    failed_reason: outcome?.reason ?? base.failed_reason ?? null,
    // RULE 2: a safety refusal says so on the document, so nothing downstream
    // mistakes it for a walk that merely failed.
    ...(outcome?.safety ? { safety: outcome.safety } : {}),
    partial: {
      salvagedBy: "workflow.mjs",
      salvagedAt: new Date().toISOString(),
      exit: outcome?.code ?? null,
      step,
      reason: outcome?.reason ?? null,
      measuredFrom: existsSync(coveragePath) ? relative(REPO_ROOT, coveragePath) || coveragePath : null,
      missing,
      // Said in the document itself, because the document outlives this log.
      says:
        "This run did not reach `report`. The figures above are whatever out/coverage.json held when the walk " +
        "stopped, reshaped by the same report.mjs that writes a finished result — they are real, and they are not " +
        "the whole run. docker/finish.py reads `partial` as a run that measured something and did not finish: it " +
        "pushes the branch, opens a pull request saying what is missing, and reports a FAILED run carrying this " +
        "reason and these numbers. It did not succeed, and it is not lost either.",
    },
  };

  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  const pct = doc.coverage_percentage;
  return (
    `salvaged ${relative(REPO_ROOT, resultPath) || resultPath} — status partial, ` +
    `${pct ? `${pct.branches}% branches / ${pct.functions}% functions` : "no coverage_percentage (nothing measurable on disk)"}, ` +
    `${missing.length} thing(s) named as missing`
  );
}

/**
 * Walk the steps, and make sure the run says what it measured however it ends.
 *
 * TWO FUNCTIONS AND NOT ONE. `walkSteps` has fourteen `return`s and every one
 * of them was a place a result could fail to be written; the only way to make
 * "on every non-zero exit" true of all fourteen at once is to have exactly one
 * caller of it. A salvage repeated at fourteen `return`s is a salvage that is
 * missing from the fifteenth somebody adds next month.
 *
 * THE THROW IS CAUGHT HERE TOO. `main()` did not wrap `walk`, so anything that
 * escaped it reached the top as an unhandled rejection with no reason line;
 * `answer()` above closes the two predicates, and this closes everything else —
 * an injected `loadStep` that rejects, a `write` that throws outside the guard,
 * a bug in this file. An exit with no sentence is the one ending nobody can act
 * on.
 */
let walkCount = 0;

export async function walk({
  repo = REPO_ROOT,
  order = ORDER,
  loadStep = loadStepFromDisk,
  worklist = WORKLIST_DECISIONS,
  write = writeWorklist,
  emit = toStdout,
  result: resultPath = RESULT_JSON,
  coverage: coveragePath = COVERAGE_JSON,
  rounds = ROUNDS_DIR,
  bankOnly = false,
  defects: defectsPath = DEFECTS_JSON,
} = {}) {
  const trace = { step: null, defects: [] };
  // THE ROUND CLOCK, THREADED LIKE `trace` AND FOR THE SAME REASON. There are
  // fourteen ways out of `walkSteps` and every one of them ends a round; a
  // `clock` returned from each would be fourteen chances to forget one, and
  // the ending that forgets is the ending nobody tested. See `packetlog.mjs`
  // for what the row means and why the walk is the only layer that can
  // measure it.
  const clock = { steps: {}, predicateMs: 0, handoverAt: null, round: null, stop: null };
  // WHAT KIND OF WALK THIS IS, said to the steps and the tools they spawn
  // (incremental.mjs): the bank walk's report rests on full passes only, and
  // out/dirty.json is this walk's by its id. Put back afterwards, so a process
  // that walks twice (the tests) never carries one walk's into the next.
  const saidBefore = Object.fromEntries([BANK_WALK_ENV, WALK_ID_ENV, VISIT_ENV].map((k) => [k, process.env[k]]));
  process.env[BANK_WALK_ENV] = bankOnly ? "1" : "";
  process.env[WALK_ID_ENV] = `${Date.now()}-${process.pid}-${(walkCount += 1)}`;
  let outcome;
  try {
    await armEarlyMeasure(order, loadStep, repo);
    outcome = await walkSteps({ repo, order, loadStep, worklist, write, emit, trace, clock, bankOnly, defectsPath });
  } catch (err) {
    outcome = { code: EXIT_FAILED, reason: `the walk itself threw — ${err?.message ?? err}. ${whereToLook()}` };
  } finally {
    // A measurement started beside the gate never outlives its walk.
    earlyMeasure.disarm();
    for (const [k, v] of Object.entries(saidBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // BEFORE THE SALVAGE AND OUTSIDE ITS `if`. The clock row is a measurement
  // and it is wanted most on the endings that went wrong; a row written only
  // on the good path would leave every killed run unattributable, which is the
  // state plan 16 item 6 exists to end.
  try {
    recordRoundClock(
      {
        startedAt: PROCESS_STARTED_AT,
        handoverAt: clock.handoverAt,
        endedAt: Date.now(),
        steps: clock.steps,
        predicateMs: clock.predicateMs,
        sidesDealt: clock.round?.sidesDealt ?? null,
        sidesClosed: clock.round?.sidesClosed ?? null,
        dealtNothingReason: clock.round?.dealtNothingReason ?? null,
        stopped: Boolean(clock.stop),
        stopReason: clock.stop ?? null,
        exit: outcome.code,
        target: repo,
      },
      { dir: rounds }
    );
  } catch {
    // A measurement that could not be written is a number nobody should have.
    // It is never a reason to change what this walk returns.
  }

  // F1.5: what this walk wrote to out/defects.json, on every outcome.
  outcome.defects = trace.defects;
  if (outcome.code !== EXIT_OK) {
    try {
      emit(`walk: ${await salvageResult({ resultPath, coveragePath, outcome, order, step: trace.step })}`);
    } catch (err) {
      // A salvage that cannot write is reported and never replaces the reason
      // the walk already has. Losing "record: 16 proposals were repaired" to
      // "EACCES on result.json" would be this mechanism eating the diagnosis it
      // was built to preserve.
      emit(`walk: the partial result could not be written — ${err?.message ?? err}`);
    }
  }
  return outcome;
}

/**
 * ITEM 1: `emit` may start `measure`'s measurement beside the gate
 * (steps/earlymeasure.mjs) only on a walk that goes on to `measure`, and with
 * `measure`'s own precondition and arguments. A step without `coverageArgs` -
 * a test's stand-in - arms nothing.
 */
async function armEarlyMeasure(order, loadStep, repo) {
  if (!order.includes("emit") || order.indexOf("measure") < order.indexOf("emit")) return;
  let measure;
  try {
    measure = await loadStep("measure");
  } catch {
    return;
  }
  if (typeof measure?.coverageArgs !== "function" || typeof measure?.precondition !== "function") return;
  earlyMeasure.arm({ precondition: () => measure.precondition(repo), args: measure.coverageArgs() });
}

/**
 * Run the steps in order.
 *
 * `loadStep` is an option, not a hard-wired import, because the refusals below
 * cannot be provoked by a real step: the interesting case is a step that ran,
 * reported work and left the disk unchanged, and no honest step is written that
 * way. The tests inject one. A walk whose failure paths can only be reached by
 * breaking a real repo is a walk whose failure paths are never run.
 *
 * Returns `{ code, reason }` rather than exiting, so a test can read the code
 * and the caller can decide where `reason` is printed.
 */
/**
 * WHICH LAYER TO SUSPECT, rather than an assertion about one.
 *
 * This sentence used to read "That is a bug in the step", and for the commonest
 * failure that is the wrong layer: a step whose tool exits non-zero reports
 * `scan.mjs exited 1 — <stderr>` in `did` and is then blamed for the tool's
 * failure. There are five layers under a run - the service, the 29 tools, the
 * steps, this walk, and the container with its gateway - and a refusal that
 * names the wrong one sends the reader to the wrong file first.
 *
 * The walk genuinely cannot tell which layer failed. What it CAN do is say so,
 * and order the search from the bottom: check that the tool does what the step
 * asked before changing the step, and the step before the walk. Every layer
 * fixed top-down leaves the layer under it still wrong, and a workaround in the
 * walk for a tool that never met its contract is a workaround nobody can find
 * later.
 *
 * A step that already KNOWS which layer failed says so in `did`; this reads
 * that rather than guessing, and falls back to naming the order to search in.
 */
export function whereToLook(did = []) {
  const tool = did.map((line) => /^(\S+\.mjs) (exited \d+|killed by )/.exec(String(line))).find(Boolean);
  if (tool) {
    return (
      `${tool[1]} is the thing that failed, not the step. Run it by hand against this repo ` +
      "and fix it there first — a step written around a tool that does not meet its contract " +
      "hides the defect one layer up, where nobody looks for it."
    );
  }
  return (
    "Which layer is at fault is not something this walk can tell. Search from the bottom: " +
    "does the tool do what the step asked (run it by hand), then the step, then this walk. " +
    "A fix applied above the layer that is actually wrong leaves it wrong."
  );
}

async function walkSteps({
  repo = REPO_ROOT,
  order = ORDER,
  loadStep = loadStepFromDisk,
  worklist = WORKLIST_DECISIONS,
  write = writeWorklist,
  emit = toStdout,
  // WHERE THE WALK GOT TO, written as it goes rather than returned.
  //
  // There are fourteen ways out of this function and the salvage above needs
  // the same two facts from every one of them: which step was being asked, and
  // how far down ORDER that is. Threading a `step` field through fourteen
  // `return`s is fourteen chances to forget one — and the ending that forgets
  // is exactly the ending nobody tested, which is how `result.json` came to be
  // written by one ending out of fourteen in the first place.
  trace = { step: null },
  // WHERE THE SECONDS WENT, filled in as the walk goes. `walk` above writes it
  // out on every ending. Nothing here reads it back, so a caller that passes
  // none gets a walk that behaves identically and measures nothing.
  clock = { steps: {}, predicateMs: 0, handoverAt: null, round: null, stop: null },
  // F1.2. See BANK_ONLY_FLAG. Every place below that would hand a question
  // over, or end the walk on a step that cannot run or is not satisfied, holds
  // it instead and carries on, so `report` is always reached.
  bankOnly = false,
  defectsPath = DEFECTS_JSON,
} = {}) {
  // F1.5. See DEFECTS_JSON. `priorDefects` is the file as this walk found it;
  // `ledger` is what it will leave.
  const runId = currentRunId();
  const priorDefects = retireForeignDefects(defectsPath, runId);
  let ledger = [...priorDefects];
  const ruledThisWalk = new Set();
  const firstDefect = { step: null };
  let defectsThisWalk = 0;
  /** A step at its own position starts this walk with no rows of its own. */
  const visitOwn = (name) => {
    // The bank walk judges nothing afresh - it holds every question - so it
    // keeps the rows the rounds before it wrote and only adds its own.
    if (bankOnly || ruledThisWalk.has(name)) return;
    ruledThisWalk.add(name);
    const before = ledger.length;
    ledger = ledger.filter((d) => d?.step !== name);
    if (ledger.length !== before) writeDefects(defectsPath, ledger);
  };
  /** Write one row. Returns a fatal outcome for a safety refusal, else null. */
  /**
   * A NOTE: a fact a step wants in the result that loses no side and stops no
   * step. Asked of `step.notes(repo)` on every visit at the step's own
   * position, satisfied or not, so it lasts exactly as long as the disk says
   * it. One row per step and id; never counted as a defect, never blocking.
   */
  const recordNote = (name, label, row) => {
    const message = String(row.message ?? "");
    const id = row.id ?? null;
    if (ledger.some((d) => d?.kind === "note" && d.step === name && (d.id ?? null) === id && d.message === message)) return;
    const entry = { step: name, kind: "note", tool: row.tool ?? null, exit: null, message, sides: [], ...(id ? { id } : {}), run: runId, at: new Date().toISOString() };
    ledger.push(entry);
    writeDefects(defectsPath, ledger);
    (trace.notes ??= []).push(entry);
    emit(`${label}: NOTE — ${message}. Listed in the result's notes[]; it decides nothing`);
  };
  const recordDefect = (name, label, row) => {
    const message = String(row.message ?? "");
    if (SAFETY_REFUSAL.test(message)) {
      return safetyOutcome(message, name, label);
    }
    visitOwn(name);
    // D67: ONE ROW PER STEP AND DEFECT ID. record's environment defect is
    // said both by `run` on the visit that found it and by `defects` on every
    // visit after; a banking visit's is carried to the step's own position,
    // where `defects` says it again. Same step, same id, same run: one row.
    if (row.id && ledger.some((d) => d?.step === name && d.id === row.id && (d.kind ?? "defect") === (row.kind ?? "defect") && (d.run ?? null) === runId)) {
      return null;
    }
    const entry = {
      step: name,
      kind: row.kind ?? "defect",
      tool: row.tool ?? null,
      exit: row.exit ?? null,
      message,
      sides: Array.isArray(row.sides) ? row.sides : [],
      ...(row.id ? { id: row.id } : {}),
      // A cigate withhold says which rows it withheld and whether anything
      // else left the suite red (steps/emit.mjs ciGate): report.mjs decides
      // from these whether the withhold cost a side at all.
      ...(Array.isArray(row.withheld) ? { withheld: row.withheld.map(String) } : {}),
      ...(Number.isInteger(row.suiteRed) ? { suiteRed: row.suiteRed } : {}),
      ...(row.kind === "blocked" ? { blockedBy: firstDefect.step } : {}),
      ...(row.blocking === false ? { blocking: false } : {}),
      run: runId,
      at: new Date().toISOString(),
    };
    ledger.push(entry);
    writeDefects(defectsPath, ledger);
    (trace.defects ??= []).push(entry);
    if (entry.kind !== "blocked") {
      defectsThisWalk += 1;
      if (!firstDefect.step) firstDefect.step = name;
    }
    emit(
      entry.kind === "blocked"
        ? `${label}: BLOCKED${entry.blockedBy ? ` by defect ${entry.blockedBy}` : ""} — ${message}. Written to ` +
            `${relative(repo, defectsPath) || defectsPath}; the walk carries on`
        : `${label}: DEFECT${entry.tool ? ` in ${entry.tool}` : ""} — ${message}. Written to ` +
            `${relative(repo, defectsPath) || defectsPath}; the walk carries on from the last good artifact`
    );
    return null;
  };
  /**
   * D31 — A STALL: sides a step stopped asking about, each left `open` with
   * the stop as its recorded reason. `blocking: false`, so report.mjs lists it
   * with the notes and never counts it as a tool defect; it is not counted in
   * this walk's defects either. report.mjs reads `sides` to name them.
   */
  const recordStall = (name, label, row) => {
    visitOwn(name);
    const entry = {
      step: name,
      kind: "stalled",
      tool: row.tool ?? null,
      exit: null,
      message: String(row.message ?? ""),
      sides: row.sides,
      blocking: false,
      run: runId,
      at: new Date().toISOString(),
    };
    ledger.push(entry);
    writeDefects(defectsPath, ledger);
    (trace.stalls ??= []).push(entry);
    emit(
      `${label}: STALLED — ${entry.sides.length} side(s) stay open with this as their recorded reason: ` +
        `${entry.message}. Written to ${relative(repo, defectsPath) || defectsPath} as a non-blocking row; ` +
        `no tool failed, and report names them as stalled`
    );
  };
  /**
   * D31/D38 - the sides a step's `result.stalled` names, written once per walk.
   * A stop carries them, and so does a round that stalled some sides and goes
   * on asking about the rest (repair's per-side count, D38).
   */
  const ruleStalled = (name, label, result) => {
    const stalled = Array.isArray(result?.stalled?.sides) ? result.stalled.sides.map(String).filter(Boolean) : [];
    if (!stalled.length) return;
    // Written once. At the step's own position `visitOwn` has already
    // cleared last walk's rows, so an identical row here is this walk's own
    // (a spliced visit ruled it first) or, in the bank walk, which clears
    // nothing, the last round's.
    const key = [...stalled].sort().join("\n");
    const already = ledger.some(
      (d) => d?.step === name && d.kind === "stalled" && [...(d.sides ?? [])].map(String).sort().join("\n") === key
    );
    if (already) return;
    recordStall(name, label, {
      tool: result.stalled.tool ?? `${name} ratchet`,
      message: String(result.stalled.why ?? result.stop ?? "").slice(0, 1200),
      sides: stalled,
    });
  };
  /**
   * D37 — A DEFECT FROM A VISIT PULLED FORWARD, kept until the step's own
   * position. There it is asked again; a step that is then satisfied is
   * skipped before `run`, so what the pulled-forward visit said was the last
   * word on the disk, and it is written then. Before this it was dropped:
   * a clean walk on pricing-ms, September 2026, had cigate withhold a row on
   * the banking visit ("cigate.mjs failed on the visit pulled forward for
   * derive"), found `emit` satisfied at its own position, and wrote nothing
   * to defects.json.
   */
  const pulledForward = new Map();
  const held = [];
  const hold = (name, label, why) => {
    held.push({ step: name, why });
    emit(`${label}: held by the bank walk — ${why}. There is no next round to hand it to, so the walk carries on to report`);
  };
  /**
   * Time one call and put the milliseconds in the clock's own bucket.
   *
   * Steps are timed BY NAME and the predicates are timed into one total. Per
   * step is what item 6 asks for — a round's seconds split into deriving and
   * banking — and `satisfied`/`precondition` are per step too, but they are
   * asked several times for one step (the banking insertion re-enters it), so
   * a per-step predicate column would be a column whose denominator changes
   * between rows. One honest total beats four columns that do not compare.
   */
  const timed = async (bucket, key, call) => {
    const at = Date.now();
    try {
      return await call();
    } finally {
      const ms = Date.now() - at;
      if (bucket === "steps") clock.steps[key] = (clock.steps[key] ?? 0) + ms;
      else clock.predicateMs += ms;
    }
  };

  // BEFORE ANY STEP RUNS. The round that follows is built on what the last one
  // handed over, and a step is about to answer "am I satisfied" from a
  // filesystem the handover was supposed to describe. If those bytes changed,
  // nothing downstream can be read as an answer to the question that was asked
  // — so this refuses first and names the file, rather than discovering it
  // halfway through a walk that has already done work.
  const tampered = tamperReason(worklist);
  if (tampered) {
    const reason = `${TAMPER_MARKER} ${tampered}`;
    return { code: EXIT_SAFETY, reason, safety: { check: "handover-tamper", step: null, reason } };
  }

  /* ----------------------------------------------------------------------
   * A ROUND THAT HANDS WORK OVER FIRST BANKS THE WORK THE LAST ROUND ANSWERED.
   *
   * WHAT THIS LOOP USED TO BE: `for (const name of order)`, one pass, stopping
   * at the first step that was not satisfied. `derive` is not satisfied until
   * every open side has been handed over, and it ENDS a round by handing one
   * over — so on any repo bigger than one batch the walk left at `derive`
   * every round and never reached the step after it.
   *
   * WHAT THAT COST. Run `20260918T164503Z` (tracy-worker, six hours, $225.19)
   * — a run whose directory no longer exists on any reachable checkout, so
   * everything in this paragraph is plan 13's D45 table
   * (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`) rather than a
   * log you can open —
   * ran nine rounds and answered 626 of 754 sides — 83% of stage 3 — and
   * `record`, `determinism`, `emit`, `measure`, `repair`, `ruling` and
   * `report` never ran once. 581 proposals sat on disk across those nine
   * rounds and nothing recorded one of them; `result.json` said
   * `coverage_percentage: null`. A run that banks nothing as it goes makes 83%
   * of stage 3 worth exactly what 0% is worth.
   *
   * THE QUEUE IS THE SMALLEST CHANGE THAT FIXES IT. `order` is still walked in
   * order and the walk still stops at the first step it cannot satisfy; the
   * only new thing is that when a step which ENDS a walk by asking a question
   * is about to run, the steps that bank — `record`, `determinism`, `emit`,
   * `measure`, named in steps/index.mjs — are visited first, over whatever is
   * already on disk. `repair` has had this property all along, because
   * `record` precedes it in ORDER; this is `derive` being given the same one.
   *
   * WHY NOT REORDER ORDER ITSELF, which would need no queue: `derive` names
   * `record` as the step that clears its budget block (`deferTo`), and the
   * walk honours a deferral only to a step that is still AHEAD in `order`.
   * Moving `record` in front of `derive` would silently turn that recovery
   * into a dead end — the recovery that stopped run 20260917T131746Z from
   * dying at minute 36.8 with 146 sides answered and unrecorded.
   *
   * WHY NOT MAKE `derive.satisfied` TRUE ON A BATCH, which is what
   * docs/plans/plan13 argues for: nothing would ever make it false again. The
   * sides in a finished batch are closed for good, so the next walk would skip
   * `derive`, run to the end of ORDER and exit 0 — and docker/char/packs/
   * nodejs.py reads exit 0 as "every step satisfied" and ENDS THE RUN. The
   * repo would be reported as characterized having briefed one batch of 754
   * sides. This shape reaches the invariant that plan wanted — a finished
   * round has recorded what it answered — without that ending.
   * -------------------------------------------------------------------- */
  const queue = order.map((name) => ({ name, banking: false, clearing: false, asked: false }));
  // PLAN 20 T2.2c: the questions a pulled-forward visit had to hold this walk,
  // so a tiny round can hand them over instead (see `tailFoldTakeover`).
  const heldAsks = [];

  // D60. WHICH STEPS HAVE ALREADY HAD THEIR CLEARER RUN, this walk. Keyed by
  // step NAME and not by queue entry, because the banking splice puts a second
  // `measure` entry in the queue and two entries for one step are still one
  // step: a clearing that did not clear must not be tried again from the other
  // position. One attempt per step per walk, and the refusal is handed over as
  // it always was on the second.
  const cleared = new Set();
  // D65. The banking visits that left their step satisfied, and the ones its
  // precondition said had nothing to bank yet, this walk: only what one of
  // those says after `derive` ran is something `derive` changed. A banking
  // step that ran and asked, failed or stayed unsatisfied is not run a second
  // time over the same disk, unless a step before it is.
  const settledBanks = new Set();
  const blockedBanks = new Set();
  /**
   * D53 — THE BANK WALK'S RE-BANKING AFTER A CLEARER, as queue entries.
   *
   * The `BANKS` steps up to `refusing` in this order (`record`, `determinism`,
   * `emit`, and `measure` itself when `including`), or none outside the bank
   * walk. See the clearing splice below for why; this is also asked after the
   * clearer's OWN visit, because a re-measure can find a FALSE claim the first
   * one did not, and `repair` withdraws it there with no round left to bank it.
   */
  const rebankFor = (refusing, { including }) =>
    bankOnly
      ? BANKS.filter(
          (b) =>
            order.includes(b) &&
            (order.indexOf(b) < order.indexOf(refusing) || (including && b === refusing))
        ).map((b) => ({ name: b, banking: false, clearing: false, rebanking: true, asked: false, for: refusing }))
      : [];

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const entry = queue[cursor];
    const name = entry.name;
    trace.step = name;
    // WHICH VISIT THIS IS (incremental.mjs VISIT_ENV): only a banking visit
    // may be served by a partial gate, because only a banking visit ends in a
    // handover rather than a report. D53's `rebanking` visits are the bank
    // walk's, and gate in full like the rest of it.
    process.env[VISIT_ENV] = entry.banking ? "banking" : entry.clearing ? "clearing" : entry.rebanking ? "rebanking" : "own";
    let step;
    try {
      step = await loadStep(name);
    } catch (err) {
      return { code: EXIT_FAILED, reason: `${name}: cannot be loaded — ${err.message}` };
    }

    const label = step?.NAME ?? name;
    const broken = shapeProblem(step);
    if (broken) return { code: EXIT_FAILED, reason: `${label}: ${broken}, so it is not a step` };

    // D53: a `rebanking` visit (see the clearing splice below) is not the
    // step's own position either. That position is already behind it, where
    // its notes, its defects and anything pulled forward were asked, so they
    // are not asked twice. Nor is D65's `handover` entry, which is the step's
    // own visit coming back to hand over what it already said.
    const ownVisit = !entry.banking && !entry.clearing && !entry.rebanking && !entry.handover;
    if (ownVisit) visitOwn(name);
    const pulled = ownVisit ? pulledForward.get(name) ?? null : null;
    if (pulled) pulledForward.delete(name);
    if (ownVisit && typeof step.notes === "function") {
      try {
        for (const n of (await step.notes(repo)) ?? []) recordNote(name, label, n);
      } catch (err) {
        // A note is information; one that cannot be read is said, never fatal.
        emit(`${label}: notes() threw — ${err?.message ?? err}; no note recorded`);
      }
    }
    // A DEFECT THE DISK STILL SAYS, asked like a note on every visit at the
    // step's own position. visitOwn() above clears this step's rows, and a
    // satisfied step is skipped before `run`, so a defect only `run` returns
    // lasts one walk: baseline's "red because of charpilot" (redsuite.mjs)
    // was gone from the ledger the first walk after the one that measured it.
    if (ownVisit && typeof step.defects === "function") {
      let rows = [];
      try {
        rows = (await step.defects(repo)) ?? [];
      } catch (err) {
        emit(`${label}: defects() threw — ${err?.message ?? err}; none recorded`);
      }
      for (const d of rows) {
        const fatal = recordDefect(name, label, d);
        if (fatal) return fatal;
      }
    }

    // F1.2. The bank walk reaches `report` whatever was held before it, so it
    // asks the disk the one question the normal walk answers by never getting
    // here: is the measurement one a verdict may be taken from?
    if (bankOnly && name === "report" && order.includes("measure")) {
      const unsound = await measurementUnsound(loadStep);
      if (unsound) {
        emit(`${label}: not run by the bank walk — ${unsound}`);
        return { code: EXIT_FAILED, reason: `bank walk: report was not run over this measurement — ${unsound}` };
      }
    }

    // TIMED WITHOUT BEING REWRITTEN. Three of the conditions below are
    // rewritten byte-for-byte by `workflow.refusals-are-load-bearing`, which
    // proves each skip is load-bearing by turning it into `if (false) {` and
    // watching the walk misbehave. A stopwatch spelled inside one of those
    // conditions would break that test's grip on the guard it is holding, so
    // the stopwatch goes around the MODULE instead — same object, same three
    // functions, each one timed on its way through. The alternative, timing
    // the whole loop body per step, cannot separate `derive.satisfied`
    // spawning validate.mjs from `derive.run` spawning three tools, and that
    // separation is the point of the row.
    const original = step;
    step = {
      ...original,
      satisfied: (r) => timed("predicates", name, () => original.satisfied(r)),
      precondition: (r) => timed("predicates", name, () => original.precondition(r)),
      run: (r) => timed("steps", name, () => original.run(r)),
    };
    // D65: the step's own visit coming back to hand over. Nothing is asked or
    // run again: what it returned is handed over as it was (see the splice
    // below, "WHAT A HANDING-OVER STEP MATERIALISED").
    if (entry.handover) {
      const said = entry.handover;
      step = { ...step, precondition: () => null, run: () => said };
    }

    // THE GUARD IS INSIDE THE try, NOT REPLACED BY IT. See `predicateThrew`
    // below for what a throw out of here used to cost; the `if` itself is left
    // spelled exactly as it was, because `workflow.refusals-are-load-bearing`
    // proves this skip is load-bearing by rewriting this line to `if (false) {`
    // and watching a finished step be run again. A guard that has been
    // paraphrased into a temporary cannot be tested that way.
    //
    // ASKED ONCE PER STEP, NOT ONCE PER VISIT. `entry.asked` is set only by the
    // banking insertion below, which re-enters this step after the banking
    // steps have run; the answer it got a moment ago was false and re-asking
    // costs a `validate.mjs` spawn on the one step that owns it.
    if (!entry.asked) {
      try {
        if (await step.satisfied(repo)) {
          emit(`${label}: already done`);
          if (entry.banking) settledBanks.add(name);
          // What the pulled-forward visit said stands: nothing ran since.
          if (pulled) {
            const fatal = recordDefect(name, label, pulled);
            if (fatal) return fatal;
          }
          continue;
        }
      } catch (err) {
        const fatal = recordDefect(name, label, { message: predicateThrew(label, "satisfied", err) });
        if (fatal) return fatal;
        continue;
      }
    }

    // THIS STEP IS ABOUT TO ASK A QUESTION AND END THE WALK. Bank first — see
    // the block at the top of this function for the nine rounds and $225.19
    // that paid for this paragraph.
    //
    // Inserted into the queue rather than run inline, so a banked step is run
    // by exactly the code below that runs it in its own position: the same
    // `did` logging, the same `pending` handling, the same refusals. A second
    // implementation of "run a step" is a second place for the refusals to be
    // missing from. The steps are those of `BANKS` that come AFTER this one in
    // THIS order, so a walk that does not contain them — `order: ["derive"]`
    // in a test, or an installation narrowed to a few steps — banks nothing
    // and behaves exactly as it did before.
    if (!entry.banking && !entry.asked && HANDS_OVER_A_ROUND.includes(name)) {
      const bank = BANKS.filter((b) => order.indexOf(b) > order.indexOf(name));
      if (bank.length) {
        entry.asked = true;
        // `for` is the step the splice was made on behalf of, and `heldFor`
        // is WHOSE ROUND this visit is inside — the same step here, and
        // inherited by anything spliced ahead of a banking entry in turn. A
        // question raised inside somebody else's round is held; see the
        // `pending` block below.
        queue.splice(
          cursor,
          0,
          ...bank.map((b) => ({ name: b, banking: true, asked: false, for: name, heldFor: name }))
        );
        emit(
          `${label}: ${bank.join(", ")} first, over what is already on disk — a round that hands work over ` +
            `banks the work the last round answered, so a run that ends here still measured what it had`
        );
        cursor -= 1;
        continue;
      }
    }

    // A precondition that fails AFTER earlier steps reported themselves
    // satisfied is a real inconsistency, not a question for an agent: nobody
    // can answer "the scan says 0 functions and the baseline says 367
    // branches". So it fails, and it writes no worklist — there is nothing in
    // it a turn could answer.
    let blocker;
    try {
      blocker = await step.precondition(repo);
    } catch (err) {
      const fatal = recordDefect(name, label, { message: predicateThrew(label, "precondition", err) });
      if (fatal) return fatal;
      continue;
    }
    if (blocker && SAFETY_REFUSAL.test(String(blocker))) return safetyOutcome(blocker, name, label);
    if (blocker) {
      // EXCEPT WHEN IT IS BANKING, WHERE A BLOCKER MEANS "NOT YET".
      //
      // Round 1 has no proposals, so `record` says the proposals directory
      // holds nothing, `determinism` and `emit` say the recording is missing
      // and `measure` says there is no suite. All four are right, and none of
      // them is an inconsistency anybody can answer — they are the ordinary
      // state of a repo that has not derived anything yet. Failing the walk on
      // them would trade the defect this banking fixes for a run that cannot
      // start. The step keeps its refusal where the refusal means something:
      // it is asked again at its own position in ORDER, once `derive` is
      // satisfied, and there it is fatal exactly as before.
      if (entry.banking) {
        emit(`${label}: nothing to bank yet — ${blocker}`);
        blockedBanks.add(name);
        continue;
      }
      // D60, AND FOR THE SAME REASON. A clearing step is spliced in over
      // whatever is already on disk, so its own preconditions may not be met
      // yet — `repair` wants `behaviour.json` and a judgeable measurement, and
      // a round that has recorded nothing has neither. That is the ordinary
      // state of an early round, not an inconsistency anybody can answer.
      // Failing the walk on it would trade the defect this clearing fixes for
      // a run that cannot start, and the step keeps its refusal where it means
      // something: at its own position in ORDER, where it is fatal as before.
      if (entry.clearing) {
        emit(`${label}: nothing to clear yet — ${blocker}`);
        continue;
      }
      if (bankOnly) {
        hold(name, label, `cannot run: ${blocker}`);
        continue;
      }
      emit(`${label}: cannot run — ${blocker}`);
      // F1.5. Blocked, written down, and the walk goes on.
      const fatal = recordDefect(name, label, { kind: "blocked", message: blocker });
      if (fatal) return fatal;
      continue;
    }

    // A step's `run` reaches outside itself — derive spawns three of the
    // pipeline's own tools, and any of them can exit non-zero with a sentence
    // that names the next move (worklist.mjs exits 3 past the stage-3 budget
    // and says to record). Thrown out of here that sentence becomes a stack
    // trace with the reason buried in it. Caught, it is the reason.
    let result;
    // D81: a line as each step STARTS, so a walk the pack streams (proc.py
    // _collect_streaming) says where it is while a long step runs, not only
    // once it has finished.
    emit(`${label}: started`);
    try {
      result = (await step.run(repo)) ?? {};
    } catch (err) {
      if (entry.banking || entry.clearing) {
        emit(`${label}: threw on the visit pulled forward for ${entry.for ?? "another step"} — ${err?.message ?? err}. It is asked again at its own position`);
        continue;
      }
      const fatal = recordDefect(name, label, { message: `${err?.message ?? err}` });
      if (fatal) return fatal;
      continue;
    }
    const did = result.did ?? [];
    let pending = result.pending ?? [];
    const metrics = result.metrics ?? {};

    // WHAT THE ROUND THAT JUST ENDED CLOSED, taken from the step that can see
    // it rather than recomputed here. `derive` is the only thing in the walk
    // that joins last round's packets against the answers on disk — it does it
    // on side ids, for the reasons `packetCompletion` gives — and a second
    // count made in this file would be a second account of the run that could
    // disagree with the first.
    //
    // READ OFF `metrics` AND NOT A FIELD OF ITS OWN. These two numbers are
    // already on every one of `derive.run`'s six returns, already named, and
    // already printed in the run log by the loop below; a parallel `round`
    // field would be a seventh place to forget to fill in, on the endings
    // nobody exercises. The walk looks for the numbers and does not care
    // which step produced them.
    if (Number.isFinite(Number(metrics.packetSidesClosedLastRound))) {
      clock.round = {
        sidesDealt: Number(metrics.packetSidesDealtLastRound ?? 0),
        sidesClosed: Number(metrics.packetSidesClosedLastRound),
        // D53. A zero pair with no reason beside it is three different rounds
        // wearing one number — see packetlog.mjs's `dealtNothingReason`. Read
        // off `metrics` for the reason the two numbers above are: the step that
        // made the join is the only thing that knows, and a second answer
        // computed here could disagree with the first.
        dealtNothingReason: metrics.packetsDealtNothingReason ?? null,
      };
    }

    for (const line of did) emit(`${label}: ${line}`);
    for (const [key, value] of Object.entries(metrics).sort(([a], [b]) => a.localeCompare(b))) {
      emit(`${label}: ${key}=${metricValue(value)}`);
    }

    // RULE 2, ON EVERY VISIT. A production-database refusal is never held for
    // a later position: a banking visit of `record` is where a live run meets
    // it first, and holding it would let `derive` hand a round over first.
    {
      const unsafe = [...did, result.defect?.message ?? ""].find((l) => SAFETY_REFUSAL.test(String(l)));
      if (unsafe) return safetyOutcome(unsafe, name, label);
    }

    // D53. THE CLEARER AT ITS OWN POSITION, IN THE BANK WALK. Whatever it
    // withdrew there supersedes the measurement `report` is about to read, and
    // no round follows to re-record it, so the banks are asked again after it:
    // each answers `satisfied` off the disk, so a visit that withdrew nothing
    // costs four checks. Queued before any refusal below is held, and only
    // after the clearer RAN, which a satisfied or blocked visit did not.
    if (ownVisit) {
      const refusing = Object.keys(CLEARS_A_REFUSAL).find((r) => CLEARS_A_REFUSAL[r] === name && order.includes(r));
      const rebank = refusing && order.indexOf(refusing) < order.indexOf(name) ? rebankFor(refusing, { including: true }) : [];
      if (rebank.length) {
        queue.splice(cursor + 1, 0, ...rebank);
        emit(
          `${label}: ${rebank.map((r) => r.name).join(", ")} again after it — this is the bank walk, so no round ` +
            `follows to bank what ${label} changed, and report reads the measurement those leave`
        );
      }
    }

    // F1.5. A STEP THAT SAYS ITS TOOL FAILED. Written at its own position;
    // on a spliced visit it is asked again there, like every other refusal.
    // A later visit whose tool did not fail supersedes a pulled-forward one.
    if (!result.defect) pulledForward.delete(name);
    if (result.defect) {
      if (entry.banking || entry.clearing) {
        emit(`${label}: ${result.defect.tool ?? "its tool"} failed on the visit pulled forward for ${entry.for ?? "another step"} — it is asked again at its own position`);
        pulledForward.set(name, { ...result.defect, message: result.defect.message ?? did.join("; ") });
        continue;
      }
      const fatal = recordDefect(name, label, { ...result.defect, message: result.defect.message ?? did.join("; ") });
      if (fatal) return fatal;
      continue;
    }

    /* --------------------------------------------------------------------
     * D60 — THE STEP THAT CLEARS THIS REFUSAL RUNS BEFORE THE REFUSAL IS
     * HANDED TO ANYBODY.
     *
     * THE DEFECT, counted over every run in `docker/runs` on this machine:
     * `repair` has printed ZERO step lines across the FIVE container runs
     * against a real service — qode-ptp-ms (7 rounds), tracy-worker (2, 5),
     * location-ms (4, 9). It has run in exactly one of the thirteen runs on
     * disk, `20260918T072551Z`, a hand-driven round on a modified tree where
     * `derive` happened to be satisfied and `measure` did not yet hand its
     * refusal over — and there it withdrew 7 FALSE claims at once. It is
     * ORDER[13], and
     * two steps ahead of it end the walk first: `derive` (ORDER[7]) hands over
     * every round in which a side is open, and `measure` (ORDER[12]) hands over
     * its refusal. `repair` is reached only when `derive` is satisfied AND
     * `measure` passed — which is precisely the state in which it has nothing
     * to clear.
     *
     * WHAT THAT COSTS. `repair.withdrawFalseClaims` spawns `propose.mjs
     * --withdraw` on every FALSE claim the measurement recorded. Rounds 3 and 5
     * of `20260919T104903Z` both died in `measure` on
     * `googleMap.service.ts#355:binary-expr:0` with byte-identical text,
     * because the one thing that takes that sentence off the row was two steps
     * further down an order the walk never reaches. D51's quarantine stops the
     * row ANSWERING its side and states its own residual: nothing stops
     * `coverage.mjs` re-refusing while the claim is still on the document. This
     * is what closes it. `repair` is also where the coverage number comes from
     * — 62.7% against 96.7% (repair.mjs's header) — so a run whose `measure`
     * ever refuses never repairs and never reaches its real number.
     *
     * IT IS THE BANKING SPLICE POINTED THE OTHER WAY, and deliberately the same
     * mechanism rather than a second one beside it: same queue, same splice,
     * same single implementation of "run a step" below. Banking says a step
     * about to ASK first runs the steps that BANK. This says a step whose
     * refusal another step exists to CLEAR first runs that step, and is then
     * ASKED AGAIN over what it leaves behind.
     *
     * NOTHING IN `order` MOVES. `repair` cannot be moved ahead of `measure`:
     * its `precondition` IS `measure`'s `unjudgeable()` and it reads
     * `out/coverage.json`, so it has nothing to reassess until the measurement
     * exists. The order is right; what was wrong is that its tail was only ever
     * reached by a round that needed nothing from it.
     *
     * FOUR CONDITIONS, AND EACH OF THEM IS A WAY THIS COULD GO WRONG:
     *
     *   the step named a clearer      a refusal the clearer cannot act on is
     *                                 not spliced. `measure` names one only for
     *                                 a FALSE claim, never for a failing suite,
     *                                 whose numbers are an overstatement and
     *                                 whose claims are not evidence.
     *   CLEARS_A_REFUSAL agrees       a step may not nominate an arbitrary
     *                                 step. Both halves or nothing.
     *   the clearer is AHEAD in THIS  the same rule `deferTo` is held to, and
     *   order                         it is what makes a narrowed order — a
     *                                 test's `order: ["measure"]` — behave
     *                                 exactly as it did before.
     *   once per step name per walk   `cleared` below. A clearing that did not
     *                                 clear hands the refusal over as it always
     *                                 did, rather than spinning between two
     *                                 steps for the rest of the round.
     *
     * The spliced entry is `asked: true` on purpose, and both halves of that
     * matter. The CLEARER runs unconditionally: `repair.satisfied` asks the
     * ledger, and the ledger counts a FALSE claim's side as ACCOUNTED — the
     * hole this exists to close — so "satisfied" is exactly the answer that
     * must not be allowed to skip it. And the REFUSING step is re-entered with
     * its `satisfied` skipped, because `measure.satisfied` asks only whether
     * the join is readable and fresh, which a refused join is; without this it
     * would say "already done" and the withdrawal would never be measured.
     * ------------------------------------------------------------------ */
    if (pending.length && result.clearableBy && !cleared.has(name)) {
      const clearer = CLEARS_A_REFUSAL[name] ?? null;
      if (clearer && clearer === result.clearableBy && order.indexOf(clearer) > order.indexOf(name)) {
        cleared.add(name);
        entry.asked = true;
        /* --------------------------------------------------------------
         * D53 — AND IN THE BANK WALK, WHAT THE CLEARER CHANGED IS BANKED
         * BEFORE THE REFUSING STEP IS ASKED AGAIN.
         *
         * WHAT WAS WRONG. `repair` clears a FALSE claim by withdrawing it
         * (`propose.mjs --withdraw`), and a withdrawal edits the row's
         * `reaches`, which is one of the fields the recording's fingerprint
         * covers (steps/record.mjs FINGERPRINTED_FIELDS, record.mjs
         * `proposalFingerprint`). So the moment `repair` has done its job,
         * `measure`'s own precondition refuses the suite as superseded, and
         * rightly: the emitted test still carries `// claims:` for the claim
         * that was taken back, behaviour.json still judges it at record time,
         * and the coverage join credits a claim nobody makes any more. A
         * normal walk never meets this, because the next round begins with
         * `record` — re-record, re-stamp, re-emit, re-measure, the order
         * steps/record.mjs's header forces — and banks the withdrawal there.
         * The bank walk is the last walk, so there is no next round: sourcing-ms
         * `20260926T014717Z` (checkpoint `a22b892`) had `measure` refuse over 14
         * FALSE claims, `repair` withdraw 14 of 14, `measure` held on "14
         * proposal(s) have been repaired since .claude/charpilot/out/
         * behaviour.json observed them", and then `report: not run by the bank
         * walk`. The run ended on a salvaged result.json because the one step
         * that cleared its refusal was the one that made its measurement
         * unreportable.
         *
         * THE FIX IS THE NEXT ROUND'S BANKING, BROUGHT INTO THIS WALK. The
         * steps of `BANKS` that come BEFORE the refusing step in this order
         * are queued after the clearer and before the refusing step is asked
         * again — `record`, `determinism`, `emit`, then `measure` — which is
         * exactly what the round after a normal walk would have done. Each of
         * them answers `satisfied` off the disk first, so a clearing that
         * withdrew nothing costs three filesystem checks; record.mjs's cache
         * is keyed on the fingerprint, so a withdrawal re-runs only the rows
         * it touched.
         *
         * WHY RE-RECORD AND NOT EXEMPT `reaches` FROM THE FINGERPRINT. A
         * withdrawal does not change what a row RUNS, and excusing it would be
         * cheaper. But the recording is more than the run: behaviour.json's
         * row carries its `reaches` and a record-time verdict on each claim,
         * and the emitted test's header states `// claims:` in the suite the
         * run delivers. Left alone, a claim `measure` found FALSE and `repair`
         * took back would still be claimed in the committed test. Re-recording
         * keeps every artifact describing the proposal on disk, which is the
         * invariant `supersededReason` exists to hold, and it leaves record.mjs
         * and its cache key untouched.
         *
         * `rebanking`, NOT `banking`. A banking visit is asked again at its own
         * position, and here that position is already behind the walk, so a
         * refusal deferred to it would be deferred to nobody. So these visits
         * are held, written down and carried on from exactly as the bank walk
         * holds a step at its own position; only its notes, defects and
         * pulled-forward rows, which that position already asked, are skipped.
         * ------------------------------------------------------------ */
        const rebank = rebankFor(name, { including: false });
        // `heldFor` IS INHERITED AND IS NOT SET HERE. A clearing splice made
        // at `measure`'s OWN position is the round it was made in — D60's
        // whole point is that `repair`'s brief takes that round instead of a
        // refusal nobody can act on — so it hands over as normal. A clearing
        // splice made at `measure`'s BANKING visit is two splices deep inside
        // `derive`'s round, and there it is held like anything else.
        queue.splice(
          cursor,
          0,
          {
            name: clearer,
            banking: false,
            clearing: true,
            asked: true,
            for: name,
            heldFor: entry.heldFor ?? null,
          },
          ...rebank
        );
        emit(
          `${label}: ${clearer} first — this refusal names ${clearer} as the step that clears it without asking ` +
            `anybody, and ${clearer} runs AFTER ${label}, so on every run on record it has never run at all. It ` +
            `runs now, over what is already on disk, and ${label} is asked again over what it leaves behind`
        );
        if (rebank.length) {
          emit(
            `${label}: then ${rebank.map((r) => r.name).join(", ")} again, before ${label} is asked — this is the bank walk, so no ` +
              `round follows to bank what ${clearer} changes, and a withdrawn claim re-records its row or ${label} ` +
              `refuses the recording as superseded`
          );
        }
        cursor -= 1;
        continue;
      }
    }

    /* --------------------------------------------------------------------
     * D65 — WHAT A HANDING-OVER STEP MATERIALISED IS BANKED BEFORE THE ROUND
     * IS HANDED OVER.
     *
     * THE DEFECT. The banking visits run BEFORE `derive`, and `derive` is the
     * step that materialises the turn's answers into proposals. So a walk that
     * materialised new proposals and still had sides open handed its round
     * over with those proposals unrecorded, undeterminised, unemitted and
     * unmeasured, and left them to the next walk. sourcing-ms run
     * `20260927T031402Z`, round 2 (03:58 UTC): 14 new proposals, `record:
     * already done` (asked before they existed), `handed=102`, behaviour.json
     * untouched since 03:16 and coverage held at 6909/7254 until the round-3
     * walk (04:33, 6909 -> 7005), after a turn of up to 300 minutes. Not a
     * regression: every walk on this machine's runs since 25 September that
     * materialised proposals and handed sides over has this shape. A round
     * whose `derive` closed its last side walked on to `record` at its own
     * position, which is why it looked like a same-walk recording before.
     *
     * THE FIX IS THE BANKING SPLICE, ASKED ONCE MORE AFTER THE STEP RAN. The
     * `BANKS` steps after this one that the first banking pass left satisfied
     * are asked `satisfied` again; from the first that no longer is, they are
     * queued as banking visits of this step's round (held like any other: a
     * question one of them raises is asked at its own position, D76), and then
     * this step's own answer is handed over exactly as it was returned — not
     * asked or run again, so a round is dealt once. A bank the first pass left
     * unsatisfied (it asked, failed or stayed stale) is not run again over the
     * same disk unless a bank before it is. A walk that materialised nothing
     * costs up to four `satisfied` checks, the ones settled.mjs makes, and
     * hands over exactly as before. The incremental walk still applies: these
     * are banking visits, so the gate and the measurement may be partial over
     * what did not change, and record.mjs serves every row whose inputs did
     * not move from what was already recorded (6b).
     *
     * NOT IN THE BANK WALK, which holds `derive`'s question and walks on to
     * `record` at its own position anyway. CHARPILOT_BANK_BEFORE_HANDOVER=off
     * is the rollback.
     * ------------------------------------------------------------------ */
    if (
      pending.length &&
      ownVisit &&
      !bankOnly &&
      HANDS_OVER_A_ROUND.includes(name) &&
      String(process.env[BANK_BEFORE_HANDOVER_ENV] ?? "").trim().toLowerCase() !== "off"
    ) {
      const after = BANKS.filter((b) => order.includes(b) && order.indexOf(b) > order.indexOf(name));
      let from = -1;
      process.env[VISIT_ENV] = "banking";
      for (let i = 0; i < after.length && from < 0; i++) {
        // One the first banking pass RAN and left unsatisfied is not asked: it
        // would run again over a disk `derive` did not change for it. One that
        // had nothing to bank yet is, and counts only once it has something.
        const settled = settledBanks.has(after[i]);
        if (!settled && !blockedBanks.has(after[i])) continue;
        try {
          const bankStep = await loadStep(after[i]);
          const done = await timed("predicates", after[i], () => bankStep.satisfied(repo));
          if (!done && (settled || !(await timed("predicates", after[i], () => bankStep.precondition(repo))))) from = i;
        } catch {
          // Its own visit says why, where a throw is already handled.
          from = i;
        }
      }
      process.env[VISIT_ENV] = "own";
      if (from >= 0) {
        const banks = after.slice(from);
        queue.splice(
          cursor + 1,
          0,
          // The first was asked just now; asking it again would cost a second
          // `satisfied` over a disk nothing has touched since.
          ...banks.map((b, i) => ({ name: b, banking: true, clearing: false, asked: i === 0, for: name, heldFor: name })),
          // Its lines and metrics are already in the log above.
          { name, banking: false, clearing: false, asked: true, handover: { ...result, pending, did: [], metrics: {} } }
        );
        emit(
          `${label}: ${banks.join(", ")} again before this round is handed over — ${label} materialised answers after ` +
            `the banking visits above had run, and ${banks[0]} is not satisfied over them, so they are recorded and ` +
            `measured in this walk rather than after the next turn`
        );
        continue;
      }
    }

    /* --------------------------------------------------------------------
     * D76 — A SPLICED VISIT IS NOT WHERE A ROUND IS HANDED OVER, EITHER.
     *
     * The two splices above both pull a step FORWARD over whatever is already
     * on disk: banking runs `record`, `determinism`, `emit` and `measure`
     * before `derive` asks, and clearing runs `repair` before `measure` hands
     * a false claim to anybody. Three places already say that such a visit is
     * not where a walk ends — the banking blocker, the clearing blocker, and
     * the clearing "ran and is still not satisfied". THIS one did not, and it
     * is the one that costs a whole round.
     *
     * WHAT IT COST, replaying run `20260920T030124Z` through
     * `tools/replaywalk.mjs` against this checkout: rounds 3, 5 and 7 each
     * ended HERE, at `measure`'s BANKING visit, on "the suite under
     * measurement did not pass". `measure` is ORDER[12] and the step the round
     * was being banked FOR is `derive`, ORDER[7] — so the walk handed over one
     * item from the bottom of the order and never ran the step at the top of
     * it. Twelve materialisable submissions sat unmaterialised, the one open
     * side was dealt to nobody, and by round 8 `derive`'s own stall rule fired
     * on "3 rounds in a row ended before `derive` was reached". A spliced visit
     * turned three rounds of an agent's answers into three rounds of nothing.
     *
     * NOTHING IS LOST BY HOLDING IT. The refusal is not a fact this walk
     * computed and would have to recompute — it is the state of the disk, and
     * the step is asked again at its OWN position in ORDER, where it hands the
     * same question over exactly as before. On a round where `derive` is
     * satisfied there is no splice at all, so the question reaches an
     * answering turn on the very next round; on a round where `derive` is NOT
     * satisfied, `derive`'s own handover is what that round is for.
     *
     * AND IT IS NOT A SILENCED REFUSAL. The step's `did` lines, including the
     * tool's own stderr, are already printed above; what is held back is the
     * WORKLIST WRITE, which would otherwise replace a round of derivable work
     * with one item nobody asked for yet.
     *
     * THE TEST IS `heldFor` AND NOT "IS THIS A SPLICE", AND THE DIFFERENCE IS
     * D60 ITSELF. A clearing splice made at `measure`'s OWN position is not
     * inside anybody's round: `measure` was about to end the walk on a refusal
     * nobody can act on, and `repair`'s brief taking that round INSTEAD is the
     * entire point of the clearing splice — run `20260919T104903Z` spent that
     * round on `{"pending":[{"id":"measure-cannot-measure"}]}`. So a clearing
     * visit hands over as normal, and only INHERITS the hold when the step it
     * was spliced ahead of was itself banking, which puts it two splices deep
     * inside `derive`'s round. `heldFor` names whose round that is, which is
     * also what the log line has to say.
     * ------------------------------------------------------------------ */
    if (pending.length && entry.heldFor) {
      if (tailFoldOn()) {
        // D65: a step banked twice in one round is held twice; its later
        // question is the one the disk now says.
        const earlier = heldAsks.findIndex((h) => h.name === name);
        if (earlier >= 0) heldAsks.splice(earlier, 1);
        heldAsks.push({ name, label, pending, progress: result?.progress });
      }
      const visit = entry.banking ? "bank" : "clear";
      emit(
        `${label}: ${pending.length} decision(s) needed, and this is the visit where it was pulled forward to ` +
          `${visit} inside ${entry.heldFor}'s round — the question is HELD and the walk carries on. It is asked ` +
          `again at its own position in ORDER, where it is handed over exactly as before; ending the round here ` +
          `hands one item from the bottom of the order over and never runs the step at the top of it`
      );
      continue;
    }

    // D38. A round can stall some sides and go on asking about the rest: the
    // stalled ones are written down here, before the question is written or
    // held, exactly as a stop's are below.
    if (pending.length) ruleStalled(name, label, result);

    // F1.2. Nobody answers after the bank walk, so a question is never written.
    if (pending.length && bankOnly) {
      hold(name, label, `${pending.length} decision(s) needed (${pending.map((p) => p.id ?? p.kind).slice(0, 5).join(", ")})`);
      continue;
    }

    /* --------------------------------------------------------------------
     * FIX PLAN 1, F2.2 — A TOOL'S ITEM IS ASKED ONCE.
     *
     * `kind: "toolset"` is an item about a tool (measure-cannot-measure,
     * measure-suite-does-not-pass): no input the agent writes clears it.
     * contact-ms asked `measure-cannot-measure` 9 times (~50 min, $14.3),
     * turing 5. So on its first repeat - the same id in the last handover,
     * or in this step's own last ask (D76's `asks`, which survives other
     * steps' rounds), or already stopped by an earlier walk - it is written
     * to out/defects.json as `kind: "toolset-item"` and not asked. The walk
     * goes on; if nothing else is asked, the step asked nothing.
     * ------------------------------------------------------------------ */
    if (pending.length && !entry.heldFor) {
      const before = priorHandover(worklist);
      const askedBefore = new Set(
        [before.signature, before.asks?.[label]?.signature, before.asks?.[name]?.signature]
          .filter((sig) => typeof sig === "string")
          .flatMap((sig) => sig.split("\n"))
          .filter(Boolean)
      );
      const stoppedBefore = new Set(priorDefects.filter((d) => d?.kind === "toolset-item" && d.step === name).map((d) => d.id));
      const keep = [];
      for (const p of pending) {
        if (p?.kind !== "toolset" || !(askedBefore.has(String(p.id)) || stoppedBefore.has(p.id))) {
          keep.push(p);
          continue;
        }
        const fatal = recordDefect(name, label, {
          kind: "toolset-item",
          id: p.id,
          tool: p.context?.submission?.refusedBy ?? null,
          message: `asked once and unchanged, so not asked again: ${String(p.question ?? p.id).split("\n")[0].slice(0, 600)}`,
        });
        if (fatal) return fatal;
      }
      if (keep.length < pending.length && !keep.length) continue;
      pending = keep;
    }

    // PLAN 20 T2.2c, ON BY DEFAULT since the nginx A/B (run 20260924T091852Z); CHARPILOT_TAIL_FOLD=off is the
    // rollback: A TINY ROUND LETS HELD QUESTIONS TAKE IT. See
    // `tailFoldTakeover`. The step that takes the round writes its handover in
    // its OWN format under its OWN name, so every reader keyed on `doc.step`
    // reads exactly what it always read; this round's items are asked again
    // next round, at their own position in ORDER.
    let askLabel = label;
    if (pending.length && !entry.heldFor && tailFoldOn()) {
      const takeover = tailFoldTakeover(pending, heldAsks, priorHandover(worklist), workerConcurrency(), label);
      if (takeover) {
        emit(
          `${label}: ${pending.length} decision(s) are held for one round — ${takeover.label} had ` +
            `${takeover.pending.length} question(s) held behind this round, ` +
            `${pending.length < Math.max(1, workerConcurrency()) ? "which is smaller than one per worker" : `and ${label} asked the round before too (D85)`}, so ` +
            `${takeover.label} takes the round and ${label} asks again next round (plan 20 T2.2c)`
        );
        askLabel = takeover.label;
        pending = takeover.pending;
      }
    }

    if (pending.length) {
      let written = null;
      try {
        // The return value carries `repeated` — whether this round is asking
        // exactly what the last one asked. An injected `write` in a test may
        // return nothing, which reads as "no repeat" and is correct: a writer
        // that does not track rounds cannot report on them.
        written = write(worklist, askLabel, pending, result?.progress);
      } catch (err) {
        return { code: EXIT_FAILED, reason: `${label}: ${pending.length} decision(s) needed and the worklist could not be written — ${err.message}` };
      }
      // 75 is an ANSWERABLE stop, and what makes it answerable is the file. If
      // it is not on disk the next turn has nothing to read, so it re-runs the
      // same step and asks the same question, forever, and the loop looks like
      // work. Checked here rather than trusted to `write`, because the write
      // that matters is the one that reached the disk.
      if (!existsSync(worklist)) {
        return {
          code: EXIT_FAILED,
          reason:
            `${label}: ${pending.length} decision(s) needed but ${worklist} was not written. ` +
            "An exit 75 with no worklist is not a retry — there is nothing to answer.",
        };
      }
      // THE ROUND ENDS HERE, and this is the timestamp the next walk measures
      // its agent turn from. Taken after the worklist is known to be on disk,
      // because a handover that was not written is not a question anybody can
      // start answering — and it is the moment the question became readable,
      // not the moment this process exits, that begins the agent's turn.
      clock.handoverAt = Date.now();
      // The fingerprint is taken from the DISK, after the write, so what is
      // recorded is what the answering turn will actually read — not what this
      // process believed it wrote.
      recordDigest(worklist);
      // READ BACK OFF THE DISK, like the digest above it, so the line names
      // what the answering turn will actually find rather than what this
      // process believed it wrote.
      const fannedOut = handoverFiles(worklist).length - 1;
      emit(`${askLabel}: ${pending.length} decision(s) needed -> ${relative(repo, worklist) || worklist}`);
      // NAMED IN THE RUN LOG, not only on the item. An operator watching a
      // 90-minute run needs this at the round it starts, which is the whole
      // point: both instances were found by diffing indexes afterwards.
      if (written?.repeated > 0) {
        emit(
          `${label}: WARNING — this round asks EXACTLY what the last ${written.repeated === 1 ? "round" : `${written.repeated} rounds`} ` +
            `asked (${pending.length} item(s), same sides). No side closed. Either answers are not reaching the disk, ` +
            `or answering an item is creating its replacement — see run 20260917T082737Z (41 min) and ` +
            `20260917T100643Z (91 min), both this shape.`
        );
      }
      if (fannedOut > 0) {
        emit(
          `${label}: ${fannedOut} brief(s) beside it, one per packet — each is whole on its own, so answering one ` +
            `means opening one file and no script`
        );
      }
      for (const item of pending) emit(decisionLine(item));
      return { code: EXIT_NEEDS_DECISION, reason: null };
    }

    /* --------------------------------------------------------------------
     * A STEP MAY DECIDE IT IS DONE ASKING, AND THAT IS NOT A FAILURE.
     *
     * `derive` uses this when the round's yield collapses: plan 13's D45
     * ratchet, measured in `packetlog.mjs`. On run `20260919T092106Z`
     * (location-ms) round 1 closed 136 sides in 1,945 seconds and rounds 2
     * and 3 closed 6 between them in 2,304 — 54% of the clock for 4% of the
     * sides — and nothing in the run noticed, because the only stall detector
     * watches rounds that FAIL.
     *
     * WHY THE WALK CARRIES ON INSTEAD OF ENDING HERE. The sides this run
     * closed are already recorded, determinism-checked, emitted and measured:
     * the banking block above ran them before `derive` was asked. What is NOT
     * yet done is `repair`, `ruling` and `report` — and `repair` is the phase
     * that produces the coverage number (run `20260916T024808Z` skipped it and
     * reported 62.7% against a 60.21% baseline; the run that did it reached
     * 96.7%), while `report` is what writes `result.json`, which is the
     * artifact `docker/char/packs/nodejs.py` ends the run on. A stop that
     * returned EXIT_OK from here would end the run with no coverage number and
     * no result, which is a worse ending than the rounds it saved.
     *
     * So a stop stops the ASKING and the walk runs on. The step is treated as
     * satisfied for the rest of this walk — and only this walk, because
     * nothing is written to say otherwise; a next walk asks `derive` again and
     * `derive` judges the same rounds and reaches the same decision, which is
     * how the stop stays in force without a state file the run could
     * disagree with.
     *
     * WHY NOT `deferTo`, which already skips a step: a deferral says "another
     * step will unblock me and it is later in this order", and the walk checks
     * that the named step really follows. Nothing unblocks this one. Saying so
     * with the deferral mechanism would make a deliberate ending read in the
     * log as a step waiting for help that is never coming.
     * ------------------------------------------------------------------ */
    if (result.stop) {
      clock.stop = String(result.stop);
      emit(
        `${label}: STOPPING — ${result.stop}. This is a deliberate end to the asking and not a failure: everything ` +
          `answered so far is already recorded, emitted and measured, and the walk carries on through the steps ` +
          `after this one so the run still repairs, rules and reports on what it has`
      );
      /* ------------------------------------------------------------------
       * D31 — A STOP THAT LEAVES SIDES BEHIND RULES THEM.
       *
       * `repair`'s stall stop used to end the asking and leave its sides
       * `open`, and nothing after it looks at a side: `ruling` answers the
       * suppressions check alone and `report` counts what `coverage.mjs`
       * wrote, so the run ended `partial` on "nothing covers them and no
       * reason is written for them" — on contact-ms, three sides for ever.
       * A step that stops on sides now names them in `stalled`, and they are
       * written here with the stop itself as the reason, as a NON-BLOCKING
       * row: an agent asked twice that could not close a side is not a tool
       * that failed, so it is never a defect and never a `pipeline_defect`.
       * `report` keeps each side `open`, puts the stall on its ruling and
       * names it as stalled. Re-derived every walk, like the stop: the row is
       * this step's, and the step's next visit clears it with its rows.
       * ------------------------------------------------------------------ */
      ruleStalled(name, label, result);
      continue;
    }

    // A step that ran, asked nothing, and is still not satisfied has not done
    // its job, whatever it put in `did`. Carrying on would build every later
    // step on a precondition that is false: one run applied an import fix,
    // reported it, left the module unimportable, and went on to write cases
    // against a service that could not load. `did` is quoted back because the
    // gap between what it claims and what the disk says is the whole diagnosis.
    // AN OPTIONAL STEP RUNS AND IS NOT REQUIRED TO SUCCEED.
    //
    // Added after run 20260916T094420Z, which died at `vocabulary`: dbvocab had
    // written its half, providervocab could not resolve @prisma/client in the
    // target repo, and the walk stopped a run that had just completed six steps
    // in one minute - over a probe whose whole job is to make `derive` better
    // informed. Without it `derive` still reads the arm and still proposes a
    // value; it simply cannot cite a row staging holds.
    //
    // The first fix was to make that step's `satisfied` always true, and it was
    // worse: the walk asks `satisfied` BEFORE `run`, so the step was skipped
    // entirely and the vocabulary was never gathered at all. A help that never
    // runs is not a help.
    //
    // So the contract says it out loud. An optional step is RUN like any other
    // and its `did` is logged like any other - it is only excused from the
    // "ran, asked nothing, still unsatisfied" refusal. It may still ask a
    // question, and it may still fail its precondition; what it may not do is
    // end a run by not achieving something.
    if (step.OPTIONAL === true) {
      try {
        if (!(await step.satisfied(repo))) {
          emit(`${label}: optional, and not satisfied — the run continues without it`);
        }
      } catch (err) {
        const fatal = recordDefect(name, label, { message: predicateThrew(label, "satisfied", err) });
        if (fatal) return fatal;
      }
      continue;
    }

    // ASKED INSIDE THE try, ACTED ON OUTSIDE IT. The `if` keeps its exact old
    // spelling — `workflow.refusals-are-load-bearing` rewrites the LAST
    // occurrence of it to `if (false) {` and requires the walk to then report
    // success over a step that did nothing — while the body below stays out of
    // the catch, so an `emit` or a `whereToLook` that throws is not reported as
    // a predicate that threw.
    let unsatisfied = false;
    try {
      if (!(await step.satisfied(repo))) {
        unsatisfied = true;
      }
    } catch (err) {
      const fatal = recordDefect(name, label, { message: predicateThrew(label, "satisfied", err) });
      if (fatal) return fatal;
      continue;
    }
    if (entry.banking && !unsatisfied) settledBanks.add(name);

    if (unsatisfied) {
      const done = did.join("; ") || "nothing";
      // A STEP MAY NAME THE STEP THAT UNBLOCKS IT, and the walk honours that
      // ONLY when that step is still ahead of it in THIS order.
      //
      // `derive` does this past the stage-3 budget: `worklist.mjs` exit 3
      // refuses to rebuild the brief and says to record, because recording
      // clears the clock. `record` is later in ORDER, so the walk can simply
      // carry on and the loop turns. Thrown instead, that instruction killed
      // run 20260917T131746Z at minute 36.8 with 146 sides answered and
      // unrecorded.
      //
      // THE GUARD ON THE GUARD: the deferral is refused unless the named step
      // genuinely follows. A walk of one step that defers to a step it does not
      // contain has no recovery available, and pretending otherwise would turn
      // "this run cannot proceed" into a silent skip — which is the shape of
      // defect this whole refusal exists to catch. `order: ["derive"]` alone
      // still fails, still quoting the tool.
      const deferTo = result?.deferTo;
      const ahead = deferTo ? order.indexOf(deferTo) > order.indexOf(name) : false;
      if (ahead) {
        emit(`${label}: deferring to ${deferTo}, which is later in this walk — ${done}`);
        continue;
      }
      /* ------------------------------------------------------------------
       * D76. AND A BANKING VISIT IS NOT WHERE A RUN DIES, FOR THE REASON THE
       * BANKING BLOCKER ABOVE ALREADY GIVES AND THIS LINE DID NOT.
       *
       * The blocker case — `nothing to bank yet` — was excused from the day
       * the splice was written. THIS case was not: a banked step that gets
       * past its precondition, RUNS, and is still not satisfied ended the
       * whole walk from a position it was never scheduled in.
       *
       * WHAT IT COST. `record.mjs` refuses to record when a MOCKED run would
       * have recorded a boundary symbol against the REAL boundary, and that
       * refusal is right — it is a correctness problem and nothing here
       * weakens it. But the splice made `record` run at the TOP of every
       * round, so from `bd4a08e` onwards the refusal killed the run before
       * `derive` had been asked anything at all. Round 5 of
       * `20260919T092410Z` is the clearest instance on disk: `record: 18
       * proposal(s) have been repaired since the last recording`, then
       * `record: record.mjs exited 1 — … ! policy: 24 boundary symbol(s)
       * would have been recorded against the REAL boundary …`, then `the
       * workflow failed in round 5 (status 1)` — four rounds and 156 minutes
       * of answers, and the walk died at ORDER[8] on a visit ORDER[7] had
       * asked for. Five more runs on record end on this same three-line
       * shape: `20260916T194950Z`, `20260917T163043Z`, `20260918T094824Z`,
       * `20260918T105518Z` and `20260919T171842Z` — though that last one died
       * at `record`'s OWN position, after `derive` had already STOPPED, and
       * this change does not save it. See the test file for that correction.
       *
       * THE REFUSAL KEEPS ITS TEETH AT ITS OWN POSITION, which is the same
       * bargain the blocker above strikes. `record` is ORDER[8] and the walk
       * reaches it in every round `derive` does not end — there it is asked
       * again, with `entry.asked` false, and there it is fatal exactly as it
       * has always been. What changes is only that a step cannot kill a run
       * from a queue slot that exists to help another step.
       * ---------------------------------------------------------------- */
      if (entry.banking) {
        emit(
          `${label}: banked what it could and is not satisfied — ${done}. This is the visit it was pulled forward ` +
            `to on ${entry.for ?? "another step"}'s behalf, not its own position in ORDER; it is asked again ` +
            `there, and there this refusal ends the run exactly as it always has`
        );
        continue;
      }
      // D60. A CLEARING VISIT IS NOT WHERE A RUN ENDS. This entry is a splice:
      // the step was pulled forward over whatever is already on disk to take a
      // blocker off a document, and it is asked at its OWN position in `order`
      // a few entries later, where this refusal is fatal exactly as before.
      // Failing the walk here would report `repair` as the reason a run died
      // when the step that actually refused was `measure`, and it would do it
      // on a visit the step never asked for. Same narrowness as the banking
      // blocker above: excused on the spliced visit, in force on its own.
      if (entry.clearing) {
        emit(`${label}: cleared what it could and is not satisfied — ${done}. It is asked again at its own position`);
        continue;
      }
      if (bankOnly) {
        hold(name, label, `ran (${done}) and is still not satisfied`);
        continue;
      }
      // F1.5. Unsatisfied and asking nothing: a step defect, written down.
      const fatal = recordDefect(name, label, {
        ...toolIn(did),
        message: `ran (${done}) and is still not satisfied, and it asked no question. ` + whereToLook(did),
      });
      if (fatal) return fatal;
      continue;
    }
  }

  // F1.2. The handover on disk is the last round's and stays: it is what the
  // run was last asked, and nothing replaced it.
  if (bankOnly) {
    const reportHeld = held.find((h) => h.step === "report");
    emit(
      `bank walk: ${held.length} step(s) held (${held.map((h) => h.step).join(", ") || "none"})` +
        (reportHeld ? " — report did not write a result" : " — report wrote the result")
    );
    if (reportHeld) return { code: EXIT_FAILED, reason: `bank walk: report ${reportHeld.why}` };
    return { code: EXIT_OK, reason: null };
  }

  clearWorklist(worklist);
  const blockedThisWalk = (trace.defects ?? []).length - defectsThisWalk;
  emit(
    defectsThisWalk || blockedThisWalk
      ? `the walk reached the end with ${defectsThisWalk} defect(s) and ${blockedThisWalk} blocked step(s) written to ` +
          `${relative(repo, defectsPath) || defectsPath} — every other step ran, and report judged the run with them`
      : "every step satisfied"
  );
  return { code: EXIT_OK, reason: null };
}

/**
 * Why `report` may not be taken over the measurement on disk, or null.
 *
 * Read off the disk by `measure`'s own exports: the join is missing, stale
 * against the suite it describes, or was taken while that suite failed. A
 * step that is not installed, or does not export these, gates nothing.
 */
async function measurementUnsound(loadStep) {
  let measure;
  try {
    measure = await loadStep("measure");
  } catch {
    return null;
  }
  try {
    const stale = typeof measure?.unjudgeable === "function" ? measure.unjudgeable() : null;
    if (stale) return stale;
    const doc = typeof measure?.readCoverage === "function" ? measure.readCoverage() : null;
    if (doc?.suitePassed === false) {
      return "the emitted suite did not pass when it was measured, so its coverage cannot be believed";
    }
  } catch (err) {
    return `measure could not be asked whether its join is sound — ${err?.message ?? err}`;
  }
  return null;
}

/**
 * Which repo the steps work on.
 *
 * config.mjs is evaluated ONCE per process and fixes its paths at that moment,
 * and this file imports it — so by the time an argument is read, every constant
 * a step will later import is already pointing at the CWD-derived root. A
 * `<repo>` that disagrees would have the steps walking one tree while the tools
 * report on another, and it would report cleanly, which is the worst way for
 * this to break. So the argument is accepted and checked, never obeyed.
 */
export function resolveRepo(argv, repoRoot = REPO_ROOT) {
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (!positional.length) return { repo: repoRoot, reason: null };
  const repo = resolve(positional[0]);
  if (repo !== resolve(repoRoot)) {
    return {
      repo: null,
      reason:
        `${repo} is not the repo this toolset is pointed at (${repoRoot}). ` +
        "config.mjs fixes that at import, so retarget it with CHARPILOT_TARGET_ROOT rather than an argument.",
    };
  }
  return { repo, reason: null };
}

async function main() {
  const { repo, reason } = resolveRepo(process.argv.slice(2));
  if (reason) {
    process.stderr.write(`✗ ${reason}\n`);
    process.exit(EXIT_FAILED);
  }
  // WRAPPED, and it was not. `walk` is async, so anything thrown out of it —
  // and until `answer()` existed, a throw out of any step's `satisfied` or
  // `precondition` was exactly that — surfaced as Node's own unhandled
  // rejection banner: no `✗` line, no exit code this contract defines, and
  // nothing for the container to read. `walk` now catches its own throws, and
  // this is the second net under it: a process that dies here still dies
  // saying why, in the one format docker/char/packs/nodejs.py greps for.
  let outcome;
  try {
    outcome = await walk({ repo, bankOnly: process.argv.slice(2).includes(BANK_ONLY_FLAG) });
  } catch (err) {
    outcome = { code: EXIT_FAILED, reason: `the walk threw and did not report it — ${err?.message ?? err}` };
  }
  if (outcome.reason) process.stderr.write(`✗ ${outcome.reason}\n`);
  process.exit(outcome.code);
}

// pathToFileURL, not a `file://` template: the tests import this module to
// drive `walk` directly, and a path with a space in it would encode differently
// on the two sides and run main() during an import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
