/**
 * packetlog.mjs — what one PACKET cost and what it returned, one row each.
 *
 *   node .claude/charpilot/packetlog.mjs [--json] [--dir <path>]
 *   node .claude/charpilot/packetlog.mjs --rounds [--json] [--dir <path>]
 *
 * WHY THIS EXISTS AT ALL, and it is the smallest possible answer to a real
 * hole. Plan 14a gave every round a row: seconds, parent and child turns,
 * cache-read tokens, refused worker launches, sides closed. That row is per
 * ROUND, and every scheduling decision anybody wants to make next is per
 * PACKET:
 *
 *   - a p95 straggler trigger needs a distribution of packet durations;
 *   - "deal less work before the round rather than discovering it afterwards"
 *     needs to know what a packet of N sides in a 47 KB file actually cost;
 *   - weighting a packet by estimated context cost (`packetWeights` in
 *     steps/derive.mjs) is a PREDICTION, and nothing on disk has ever recorded
 *     the outcome it predicts.
 *
 * So this builds the distribution and acts on none of it. That ordering is
 * deliberate and plan 15 states it: the pilot round's first job is to produce
 * the numbers, not to schedule on them, and a trigger written against a
 * distribution nobody has seen is a constant with a p95 painted on it.
 *
 * WHAT A ROW CAN AND CANNOT SAY TODAY. A row is written by `steps/derive.mjs`
 * at the START of the round after the one it describes, because that is the
 * first moment the answers exist to join against. So it carries what was DEALT
 * (sides, and the source bytes of the file the packet's reading plan names) and
 * what came BACK (whether a submission landed under the packet's reserved name,
 * how many of its sides are now answered or declared, and whether every one of
 * them is). It does NOT carry seconds, child turns, or cache-read tokens per
 * packet: nothing in this pipeline measures those per packet — the walk does
 * not dispatch, the answering turn fans out inside one agent turn, and the
 * gateway's usage is attributed to the round. Closing that gap is the pilot's
 * job and this file is the shape it will land in.
 *
 * WHY A STEP MAY WRITE THIS AT ALL, given that `steps/derive.mjs` reads the
 * handover and writes nothing. The same line `notes.mjs` draws, for the same
 * reason: this is an append-only MEASUREMENT log under `out/packets/`, it is
 * not a pipeline artifact, nothing downstream reads it to decide anything, and
 * a step that could not record what it did would leave every scheduling claim
 * unmeasurable. A failed append is swallowed for the same reason it is in
 * `notes.mjs`: losing a counter costs a number in a report, and throwing here
 * would cost the round.
 *
 * ONE FILE PER PROCESS, appended, never rewritten. Six workers never touch it —
 * only the walk does — but a run is many processes over one directory, and an
 * append with no lock cannot lose a row to a losing rename.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

/**
 * Beside `out/notes/`, and published with the rest of the run's artifacts.
 *
 * It accumulates ACROSS RUNS on purpose. A single run of a medium repo is at
 * most twelve rounds and a few hundred packets, which is enough to see a shape
 * and not enough to trust a p95; the same service characterized three times is.
 */
export const PACKETS_DIR = resolve(OUT_DIR, "packets");

const FILES = new Map();
let SEQ = 0;

function logFile(dir) {
  if (!FILES.has(dir)) {
    mkdirSync(dir, { recursive: true });
    const tag = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    FILES.set(dir, join(dir, `${tag}.jsonl`));
  }
  return FILES.get(dir);
}

/**
 * THE FIELDS, and what each one does and does not include.
 *
 *   round          THE ORDINAL OF THIS LOG'S OWN WRITES, not the run's round
 *                  number. Nothing passes the run's round number down to a
 *                  step — `docker/char/packs/nodejs.py` keeps it in its own
 *                  loop — so inventing one here would be a second account of
 *                  the run that could disagree with the first. What this
 *                  number is good for is ordering rows within a directory,
 *                  which is all the distribution needs.
 *   packet         the packet id, which is `packet <functionId>` and is stable
 *                  across rounds: the same function is the same packet in
 *                  round 3 that it was in round 2.
 *   sidesDealt     how many sides that packet's roster held. NOT how many the
 *                  worker attempted, which nothing records.
 *   contextBytes   the size of the file the packet's reading plan names first —
 *                  where the function is DECLARED. Null when the file could not
 *                  be stat'd. It does NOT include the packet's boundary
 *                  modules, the brief itself, or anything the worker chose to
 *                  read beyond the plan.
 *   contextWeight  `contextBytes` expressed in the unit the scheduler deals in,
 *                  floored at one packet. This is the PREDICTION whose outcome
 *                  the rest of the row is the evidence for.
 *   filed          whether a submission landed under this packet's own reserved
 *                  name. This is the old D48 signal, kept because it is a real
 *                  and different fact — workers mostly name their own files, so
 *                  a `false` here beside a full `sidesClosed` is a worker that
 *                  answered everything under a name of its own.
 *   sidesClosed    how many of its sides now carry a proposal or a written
 *                  reason, joined on SIDE IDS. A row validate.mjs quarantined
 *                  does not count, because it does not answer its side.
 *   finished       sidesClosed === sidesDealt. Derived, never declared.
 */
export function recordPackets(rows = [], { dir = PACKETS_DIR, at = Date.now() } = {}) {
  if (!rows.length) return [];
  const round = (roundsIn({ dir }) ?? 0) + 1;
  const written = rows.map((row) => ({
    at,
    seq: (SEQ += 1),
    pid: process.pid,
    round,
    packet: row.packet ?? null,
    functionId: row.functionId ?? null,
    file: row.file ?? null,
    sidesDealt: Number(row.sidesDealt ?? 0),
    contextBytes: row.contextBytes ?? null,
    contextWeight: row.contextWeight ?? null,
    filed: row.filed ?? null,
    sidesClosed: Number(row.sidesClosed ?? 0),
    finished: Boolean(row.finished),
  }));
  try {
    appendFileSync(logFile(dir), written.map((r) => `${JSON.stringify(r)}\n`).join(""));
  } catch {
    // Reported by its absence from the distribution, which is the honest
    // result: a measurement that could not be written is a number nobody
    // should have.
  }
  return written;
}

/* ------------------------------------------------------------------------ *
 * D66 — THE ROW A PARENT WRITES WHILE THE ROUND IS RUNNING.
 *
 * `recordPackets` above is written by the NEXT round, off the handover and the
 * submissions, so it can only carry what was dealt and what came back. It
 * cannot carry seconds, because nothing in this pipeline has ever timed one
 * packet — this file's own `missing` field has said so since it was written,
 * and every scheduling number in the project is a division because of it:
 *
 *   "9 minutes a packet" is 292.8 worker-minutes of SLOT over 33 packets.
 *   135.5 of those worker-minutes were busy. 4.1 is the real figure and the
 *   other 157 are one round's barrier.
 *
 * Nobody could tell those apart from anything on disk. They were recovered by
 * reading `· Agent:` lines out of a container log by hand, which is not a
 * measurement anybody can repeat per round.
 *
 * SO THE PARENT WRITES THIS ONE, as each worker returns: what it was handed,
 * when it started, when it came back, what it wrote, and whether that landed.
 * It is the same append-only log and the same directory; what is new is that
 * the row has a clock in it and an author who was there.
 *
 * NOTHING READS IT TO DECIDE ANYTHING, and that ordering is plan 15's: the
 * distribution comes first and the trigger comes after it. `packetsPerRound`
 * uses a CONSTANT, `packetMinutes`, and the constant is overridable precisely
 * so that this log can replace it once it has rows.
 *
 * EVERY FIELD IS OPTIONAL AND A MISSING ONE IS NULL, never zero. A parent that
 * reports a packet's start and end and nothing else is worth strictly more
 * than no row, and a zero where a number is absent is the kind of value that
 * reads as a measurement.
 * ------------------------------------------------------------------------ */

/**
 * THE FIELDS, and what each one is for.
 *
 *   packet        the packet id, so this row joins `recordPackets`'s.
 *   entry         the queue entry it was launched from, 1-based, which is what
 *                 `handover.queue` numbers. Several packets share one entry.
 *   worker        whatever the parent calls the worker. A LABEL, never an
 *                 index into anything: the fan-out is refilled, so the third
 *                 worker to start is not the third slot.
 *   startedAt/
 *   endedAt       epoch milliseconds, from the parent's own clock. `busyMs` is
 *                 derived and never taken, because two numbers and their
 *                 difference is two places for the difference to be wrong.
 *   items         how many items the packet held, which is the term a worker's
 *                 time is linear in (0.76-2.70 min/item, measured).
 *   childTurns    the worker's own turn count if the parent can see it.
 *   wrote         the file name the worker actually wrote, which is almost
 *                 never the reserved name — that mismatch is what made the old
 *                 D48 completion metric report 0 of 33 on a round that closed
 *                 127 sides.
 *   joined        whether anything in `wrote` matched a side this packet holds.
 *   validated     whether the rows in it survived validate.mjs.
 *   sidesClosed   how many of its sides the parent saw answered or declared.
 *   abandoned     the worker gave up rather than finished, with its own words
 *                 in `why`. MEASURED AND NOT HYPOTHETICAL: run logs carry
 *                 "worker 1 ran out of its time budget before deriving this
 *                 one" and "Given the time budget (~30-45 min total, already
 *                 far", and `CHARPILOT_WORKER_DEADLINE_SECONDS` appears in none
 *                 of them. The abandonment is SELF-IMPOSED, from a number the
 *                 worker estimates, so a row that does not record it leaves the
 *                 distribution full of short packets that were never finished.
 */
export function recordPacketRun(rows = [], { dir = PACKETS_DIR, at = Date.now() } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const bool = (v) => (v === true || v === false ? v : null);
  const written = list.map((row) => {
    const startedAt = num(row.startedAt);
    const endedAt = num(row.endedAt);
    return {
      at,
      seq: (SEQ += 1),
      pid: process.pid,
      kind: "run",
      packet: row.packet ?? null,
      entry: num(row.entry),
      worker: row.worker == null ? null : String(row.worker),
      startedAt,
      endedAt,
      // DERIVED, so the log cannot hold a duration that disagrees with its own
      // two timestamps. Null when either end is missing.
      busyMs: startedAt != null && endedAt != null && endedAt >= startedAt ? endedAt - startedAt : null,
      items: num(row.items),
      childTurns: num(row.childTurns),
      wrote: row.wrote ?? null,
      joined: bool(row.joined),
      validated: bool(row.validated),
      sidesClosed: num(row.sidesClosed),
      abandoned: bool(row.abandoned),
      why: row.why ?? null,
    };
  });
  try {
    appendFileSync(logFile(dir), written.map((r) => `${JSON.stringify(r)}\n`).join(""));
  } catch {
    // Same judgement as `recordPackets`: a measurement that could not be
    // written is a number nobody should have.
  }
  return written;
}

/** The rows a parent wrote while the round ran, oldest first. */
export function packetRuns({ dir = PACKETS_DIR } = {}) {
  return readPacketRecords({ dir }).filter((r) => r?.kind === "run");
}

/**
 * What a packet actually cost a worker, in minutes — or null, which is the
 * honest answer until a parent has written rows.
 *
 * THE POINT OF THE WHOLE BLOCK ABOVE. `packetMinutes` in steps/handover.mjs is
 * 4.1 because somebody divided one round's busy total by its packet count.
 * This is the same quantity measured, and when it disagrees it is right.
 */
export function measuredPacketMinutes({ dir = PACKETS_DIR } = {}) {
  const busy = packetRuns({ dir }).map((r) => r.busyMs).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (!busy.length) return null;
  return {
    packets: busy.length,
    meanMinutes: busy.reduce((n, ms) => n + ms, 0) / busy.length / 60000,
    medianMinutes: percentile(busy, 50) / 60000,
    p95Minutes: percentile(busy, 95) / 60000,
  };
}

/**
 * Every row in a log directory, oldest first.
 *
 * Shared by the packet log and the round clock below rather than written
 * twice: both are append-only jsonl under `out/`, both are written by several
 * processes over one directory, and both have to survive a torn last line. A
 * second copy of this loop would be a second place for the torn-line
 * judgement to be missing from.
 */
function readJsonl(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // ONE TORN LINE DOES NOT ERASE THE LOG, the same judgement `notes.mjs`
        // makes about the same failure: a process killed mid-append leaves a
        // partial line, and throwing here turns a lost row into a lost report.
      }
    }
  }
  out.sort((a, b) => a.at - b.at || a.pid - b.pid || a.seq - b.seq);
  return out;
}

/** Every packet row on disk, oldest first. */
export function readPacketRecords({ dir = PACKETS_DIR } = {}) {
  return readJsonl(dir);
}

/** How many rounds this log already holds, or null when it holds none. */
export function roundsIn({ dir = PACKETS_DIR } = {}) {
  const rows = readPacketRecords({ dir });
  if (!rows.length) return null;
  return Math.max(...rows.map((r) => Number(r.round) || 0));
}

/** The q-th percentile of a numeric list, by nearest rank, or null when empty. */
export function percentile(values, q) {
  const sorted = (values ?? []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * THE DISTRIBUTION, AND DELIBERATELY NOT A TRIGGER.
 *
 * Plan 15 asks for a p95 straggler trigger and says in the same breath that it
 * cannot be built until the distribution exists. So p95 is REPORTED here and
 * acted on nowhere: no round is split on it, no packet is stolen, nothing reads
 * this number to make a decision. When a pilot round has filled this log with
 * per-packet DURATIONS as well as sides, the trigger has something to fire
 * against; until then a trigger would be a constant wearing a percentile's
 * name.
 *
 * `p95SidesDealt` and `p95ContextBytes` are the two axes D46 weighs, reported
 * separately for the reason D46 keeps them separate: a cheap-to-read round of
 * hard sides and an expensive-to-read round of easy ones want opposite
 * responses, and one blended number cannot tell them apart.
 */
export function packetDistribution({ dir = PACKETS_DIR } = {}) {
  // THE DEALT ROWS ONLY. `recordPacketRun` writes into the same log — one
  // append-only directory, for the reason `readPacketRecords` is shared — and a
  // run row is a different fact about the same packet. Counting the two
  // together would double every packet that has both.
  const rows = readPacketRecords({ dir }).filter((r) => r?.kind !== "run");
  const dealt = rows.map((r) => Number(r.sidesDealt));
  const bytes = rows.map((r) => Number(r.contextBytes)).filter((b) => Number.isFinite(b));
  const finished = rows.filter((r) => r.finished).length;
  const closed = rows.reduce((n, r) => n + (Number(r.sidesClosed) || 0), 0);
  const total = rows.reduce((n, r) => n + (Number(r.sidesDealt) || 0), 0);
  return {
    packets: rows.length,
    rounds: rows.length ? Math.max(...rows.map((r) => Number(r.round) || 0)) : 0,
    finished,
    finishedShare: rows.length ? finished / rows.length : null,
    filedUnderReservedName: rows.filter((r) => r.filed === true).length,
    sidesDealt: total,
    sidesClosed: closed,
    closedShare: total ? closed / total : null,
    medianSidesDealt: percentile(dealt, 50),
    p95SidesDealt: percentile(dealt, 95),
    medianContextBytes: percentile(bytes, 50),
    p95ContextBytes: percentile(bytes, 95),
    // SAID OUT LOUD ON THE OBJECT, because the absent field is the whole point
    // of the next plan and a reader who does not notice it is missing will
    // assume the trigger is buildable.
    secondsPerPacket: null,
    childTurnsPerPacket: null,
    cacheReadPerClosedSide: null,
    // D66 — AND WHERE THEY COME FROM WHEN THEY EXIST. Null when no parent has
    // written a run row, which is the state every log is in today.
    measured: measuredPacketMinutes({ dir }),
    missing:
      "no packet DEALT row carries seconds, child turns or cache-read tokens. The walk dispatches nothing, the " +
      "answering turn fans out inside one agent turn, and the gateway's usage is attributed to the round by " +
      "`docker/char/agentlog.py`, so this step cannot time a packet. `recordPacketRun` is the row that can — the " +
      "PARENT writes it as each worker returns — and `measured` above is null until one has. A p95 straggler " +
      "trigger needs it and must not be built against the side counts below as a stand-in.",
  };
}

/** One line a person reads, folded into a step's `did`, or nothing to say. */
export function reportPackets(metrics, did, { dir = PACKETS_DIR } = {}) {
  const d = packetDistribution({ dir });
  if (!d.packets) return d;
  metrics.packetRecords = d.packets;
  metrics.packetRecordRounds = d.rounds;
  metrics.packetRecordsFinished = d.finished;
  metrics.packetRecordMedianSides = d.medianSidesDealt;
  metrics.packetRecordP95Sides = d.p95SidesDealt;
  if (d.medianContextBytes != null) metrics.packetRecordMedianContextBytes = d.medianContextBytes;
  if (d.p95ContextBytes != null) metrics.packetRecordP95ContextBytes = d.p95ContextBytes;
  did.push(
    `packet records: ${d.packets} packet(s) over ${d.rounds} recorded round(s) — ${d.finished} finished every side ` +
      `they held, ${d.sidesClosed} of ${d.sidesDealt} dealt side(s) closed, median ${d.medianSidesDealt} side(s) per ` +
      `packet and p95 ${d.p95SidesDealt}` +
      (d.medianContextBytes != null
        ? `, median ${d.medianContextBytes} context byte(s) and p95 ${d.p95ContextBytes}`
        : ``) +
      `. This is the DISTRIBUTION and nothing acts on it: no packet carries seconds, child turns or cache-read ` +
      `tokens, because nothing in this pipeline measures those per packet, so the p95 straggler trigger plan 15 ` +
      `describes has nothing to fire against yet and is deliberately not built`
  );
  return d;
}

/* ==========================================================================
 * THE ROUND CLOCK — where a round's seconds went, and what they bought.
 *
 * WHY IT IS HERE AND NOT BESIDE THE ROUND ROW. There is already a round row:
 * `docker/char/packs/nodejs.py` writes one per round with seconds, parent and
 * child turns, cache-read tokens and refused worker launches. It is written by
 * the HOST, from the gateway's stream, and it is per ROUND with nothing inside
 * it — which is exactly the hole plan 16 item 6 names. Nobody can say how much
 * of location-ms's 1,945-second round 1 was the agent thinking and how much
 * was the pipeline running, and four verdicts in that document are blocked on
 * the answer.
 *
 * The host cannot answer it: it sees one opaque agent turn and the walk's
 * stdout. The walk can, because the walk is the thing that runs the steps. So
 * the split is recorded here, beside the packet distribution, for three
 * reasons: this file already owns the append-only jsonl machinery and the
 * torn-line judgement; a run publishes `out/` and so publishes this with it;
 * and the alternative — adding columns to the host's row — costs a change in
 * `docker/**` for a number the host still could not measure.
 *
 * WHAT A ROUND IS, stated exactly, because the boundary is a choice and a
 * reader who assumes the other one will misread every number below.
 *
 *   A ROUND RUNS FROM ONE HANDOVER TO THE NEXT. The walk writes a brief and
 *   exits 75; the agent answers it; the container invokes the walk again; that
 *   walk banks what came back, derives the next brief, and hands it over. That
 *   whole span is one round, and it is the span the sides closed in it were
 *   closed in.
 *
 * So the row for round k is written by the walk process that ENDS round k,
 * which is the walk AFTER the one that asked. That is also the first moment
 * round k's yield exists to be joined against — the same ordering, and for the
 * same reason, as the packet rows above.
 *
 * THE SPLIT ADDS UP BY CONSTRUCTION, and every term says what it excludes:
 *
 *   roundSeconds = agentTurnSeconds + stepSeconds + predicateSeconds
 *                  + unattributedSeconds
 *
 * and the same seconds regrouped into the two halves item 6 names, which also
 * partition the round and also add up exactly:
 *
 *   roundSeconds = derivingSeconds + bankingSeconds + otherStepSeconds
 *                  + predicateSeconds + unattributedSeconds
 *
 * where `derivingSeconds` is the agent turn plus the `derive` step and
 * `bankingSeconds` is `record` + `determinism` + `emit` + `measure`.
 *
 *   agentTurnSeconds   From the previous walk writing the handover to THIS
 *                      walk process starting. It is everything the walk cannot
 *                      see: the agent reading the brief, its workers, the
 *                      gateway, and the container's own re-invocation of the
 *                      walk. It is NOT "model time" and must never be quoted
 *                      as one — a 502 from the gateway lands in here too.
 *   steps              One entry per step, seconds inside `step.run(repo)`.
 *                      `record`, `determinism`, `emit` and `measure` are the
 *                      banking half; `derive` is the deriving half; the rest
 *                      are whatever else this walk had to run.
 *   predicateSeconds   `satisfied` and `precondition` across every step,
 *                      totalled and not split per step. They are not free —
 *                      `derive.satisfied` spawns `validate.mjs` — and a
 *                      bucket that is not on the row is a bucket that gets
 *                      silently attributed to the agent turn.
 *   unattributedSeconds  The rest of the walk process: node's startup, the
 *                      step imports, the worklist write, this log. Recorded
 *                      rather than rounded away, because the whole claim of
 *                      this row is that its parts add up to its total.
 *
 * WHAT IT STILL CANNOT SAY. Nothing here splits the agent turn into the parent
 * turn and its children, and nothing here carries tokens or dollars: the
 * gateway's usage reaches `docker/char/agentlog.py` on the host and never
 * reaches this process. So this row answers "agent or pipeline" and does not
 * answer "parent or fan-out". Those are different questions and the second one
 * needs the host's row beside this one.
 * ========================================================================== */

/**
 * Beside `out/packets/`, and published with the rest of the run's artifacts.
 *
 * Its own directory rather than a `kind` column in the packet log: a packet
 * row is per packet and a clock row is per round, so one directory holding
 * both would make every reader of either filter first, and the packet
 * distribution's counts are taken off `rows.length`.
 */
export const ROUNDS_DIR = resolve(OUT_DIR, "rounds");

/**
 * When this process started, in the same clock the rows are stamped in.
 *
 * `performance.timeOrigin` and not the first line of `walk()`: the agent turn
 * ends when the container invokes the walk, and node's own startup plus the
 * step imports are pipeline seconds. Measuring from inside the walk would
 * quietly move them into the agent turn, which is the one bucket this row
 * exists to size honestly.
 */
export const PROCESS_STARTED_AT = Math.round(performance.timeOrigin);

/** The banking steps, named here so a clock row can split itself without importing the walk. */
const BANKING_STEPS = new Set(["record", "determinism", "emit", "measure"]);

/** Seconds, to two places — a round is minutes long and milliseconds are noise on it. */
const secs = (ms) => (Number.isFinite(ms) ? Math.round(ms / 10) / 100 : null);

/**
 * TWO ROUNDS ARE THE SAME RUN ONLY IF THEY COULD BE, and these are the two
 * ways they could not.
 *
 * `out/` is fresh in every container, so in a real run this never rejects
 * anything. It matters on a developer's machine and in this repo's own test
 * suite, where one `out/rounds/` accumulates across runs and across hundreds
 * of in-process `walk()` calls, and where a stale row joined to a live one
 * would invent a round that never happened — and could then end a run on it.
 *
 *   A ROUND CROSSES TWO PROCESSES. The walk that asks exits; the agent
 *   answers; a NEW walk is invoked. So a row this same pid wrote is not a
 *   previous round, it is this process writing twice, which only ever happens
 *   when something drives the walk in-process.
 *   THE GAP HAS TO BE A ROUND'S GAP. The whole run budget is ~235 minutes and
 *   the longest round ever measured is 32 (location-ms round 1, 1,945s), so a
 *   join across more than four hours is not a slow round, it is yesterday's
 *   run sharing this directory.
 */
const ROUND_JOIN_MAX_MIN = 240;

function joinable(previous, { at = Date.now(), pid = process.pid, target = REPO_ROOT } = {}) {
  if (!previous || !Number.isFinite(previous.handoverAt)) return false;
  if (previous.pid === pid) return false;
  if (previous.target && target && previous.target !== target) return false;
  return at - previous.handoverAt <= ROUND_JOIN_MAX_MIN * 60_000;
}

/** Every clock row on disk, oldest first. */
export function readRoundClocks({ dir = ROUNDS_DIR } = {}) {
  return readJsonl(dir);
}

/**
 * The last clock row, or null — which is the row that says when the round now
 * ending was handed over.
 */
export function lastRoundClock({ dir = ROUNDS_DIR } = {}) {
  const rows = readRoundClocks({ dir });
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * When the round now ending began, or null when no round is ending here.
 *
 * Null on the first walk of a run, which is correct and not a gap: nothing was
 * handed over before it, so there is no round behind it to attribute.
 */
export function roundStartedAt({ dir = ROUNDS_DIR, at = Date.now(), pid = process.pid, target = REPO_ROOT } = {}) {
  const previous = lastRoundClock({ dir });
  return joinable(previous, { at, pid, target }) ? previous.handoverAt : null;
}

/**
 * One row for the round this walk process ended.
 *
 * `steps` is `{ name: milliseconds }` as the walk timed them; everything else
 * is arithmetic on the four timestamps, done here so there is one place where
 * the split is defined and one place it can be wrong.
 */
/* --------------------------------------------------------------------------
 * THE THREE WORDS `dealtNothingReason` MAY BE, OWNED HERE.
 *
 * `steps/derive.mjs:dealtNothing` DECIDES which of them a round is, off the
 * handover index's own `step` key. This file owns what they are CALLED, because
 * they are the vocabulary of the round row: `recordRoundClock` writes the word,
 * `readRoundClocks` reads it back, and `stallRule` below decides on it. Two
 * spellings of a word two files have to agree on is the shape of defect this
 * file's own header is about, so `derive.mjs` re-exports these rather than
 * declaring them.
 * ------------------------------------------------------------------------ */

/** Round 1, or a walk re-entered with no agent turn between it and the last. */
export const NO_ROUND_BEFORE = "no-round-before";

/** The last round was handed over by a step that deals sides, and had none. */
export const NOTHING_WAS_OPEN = "nothing-was-open";

/** The walk stopped before the step that deals sides was reached. */
export const UPSTREAM_DEATH = "walk-died-upstream";

export function recordRoundClock(
  {
    startedAt = PROCESS_STARTED_AT,
    handoverAt = null,
    endedAt = Date.now(),
    steps = {},
    predicateMs = 0,
    sidesDealt = null,
    sidesClosed = null,
    // D53 — WHY THIS ROUND DEALT NOTHING, when it dealt nothing.
    //
    // `sidesDealt: 0, sidesClosed: 0` is written by three different rounds and
    // means three different things: no round ran before this one, nothing was
    // open to deal, or the walk died before the step that deals sides was
    // reached. Run `20260919T104903Z` carried all three and the row could not
    // tell them apart, so nothing downstream could either — the yield ratchet
    // says exactly this in prose and then has to refuse to judge any of them.
    // `steps/derive.mjs:dealtNothing` decides which it is; this row carries the
    // word. Null when packets WERE dealt, which is the ordinary round.
    dealtNothingReason = null,
    stopped = false,
    stopReason = null,
    exit = null,
    target = REPO_ROOT,
  } = {},
  { dir = ROUNDS_DIR, at = Date.now(), pid = process.pid } = {}
) {
  const previous = lastRoundClock({ dir });
  const previousHandoverAt = joinable(previous, { at: startedAt, pid, target }) ? previous.handoverAt : null;
  // THE ROUND ENDS AT THE HANDOVER, not at process exit. A walk that hands
  // over exits within milliseconds of writing the worklist, so the difference
  // is noise — but a walk that exits 0 has no handover at all, and using its
  // exit would put the whole report phase inside a round that had already
  // ended.
  const closedAt = handoverAt ?? endedAt;
  const agentTurnMs = previousHandoverAt == null ? null : startedAt - previousHandoverAt;
  const pipelineMs = closedAt - startedAt;
  const roundMs = agentTurnMs == null ? null : agentTurnMs + pipelineMs;

  // EVERY TERM IS DERIVED FROM THE TERMS ALREADY ROUNDED, and the last one is
  // a REMAINDER rather than its own subtraction of milliseconds.
  //
  // The alternative — rounding each bucket independently off the raw
  // milliseconds — is what this file did first, and its buckets summed to the
  // total plus or minus 0.02s. That is nothing as a duration and it is fatal
  // as a claim: the whole point of the row is that a reader can add its parts
  // up and get the round, and a split that "nearly" adds up invites exactly
  // the argument about missing seconds it was built to settle.
  const stepRows = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, secs(v) ?? 0]));
  const round2 = (v) => Math.round(v * 100) / 100;
  const stepSeconds = round2(Object.values(stepRows).reduce((n, v) => n + v, 0));
  const predicateSeconds = secs(predicateMs) ?? 0;
  const agentTurnSeconds = secs(agentTurnMs);
  const bankingSeconds = round2(
    Object.entries(stepRows).reduce((n, [k, v]) => n + (BANKING_STEPS.has(k) ? v : 0), 0)
  );
  const deriveStepSeconds = stepRows.derive ?? 0;
  const total = roundMs == null ? secs(pipelineMs) : secs(roundMs);
  const row = {
    at,
    seq: (SEQ += 1),
    pid,
    kind: "round",
    target,
    startedAt,
    handoverAt,
    endedAt,
    previousHandoverAt,
    // Null, never zero, when this walk ended no round. A zero here would be
    // read as "the agent turn took no time", which is a different claim.
    agentTurnSeconds,
    steps: stepRows,
    stepSeconds,
    predicateSeconds,
    // THE TWO HALVES PLAN 16 ITEM 6 ASKS FOR. "Deriving" is the agent turn
    // PLUS the derive step, because the agent turn exists only to answer the
    // brief derive built; "banking" is `record`, `determinism`, `emit` and
    // `measure`, which is exactly the list the walk banks with. `deriving`,
    // `banking`, `other`, `predicates` and `unattributed` partition the round
    // — no seconds in two of them, and none in none of them.
    derivingSeconds: round2((agentTurnSeconds ?? 0) + deriveStepSeconds),
    deriveStepSeconds,
    bankingSeconds,
    otherStepSeconds: round2(stepSeconds - bankingSeconds - deriveStepSeconds),
    pipelineSeconds: secs(pipelineMs),
    unattributedSeconds: round2(total - (agentTurnSeconds ?? 0) - stepSeconds - predicateSeconds),
    roundSeconds: secs(roundMs),
    agentShare: roundMs ? Math.round((agentTurnMs / roundMs) * 1000) / 1000 : null,
    sidesDealt: sidesDealt == null ? null : Number(sidesDealt),
    sidesClosed: sidesClosed == null ? null : Number(sidesClosed),
    dealtNothingReason: dealtNothingReason ?? null,
    secondsPerClosedSide: roundMs != null && Number(sidesClosed) > 0 ? secs(roundMs / Number(sidesClosed)) : null,
    stopped: Boolean(stopped),
    stopReason: stopReason ?? null,
    exit,
  };
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(logFile(dir), `${JSON.stringify(row)}\n`);
  } catch {
    // Swallowed for the reason the packet log swallows its own: losing a
    // measurement costs a number in a report, and throwing here would cost the
    // round that produced it.
  }
  return row;
}

/**
 * Where the clock went across every round on disk.
 *
 * Shares are of the seconds that were ATTRIBUTED, so they sum to 1 and a
 * reader is never left dividing by a total that includes rounds with no
 * agent turn.
 */
export function roundClockSummary({ dir = ROUNDS_DIR } = {}) {
  const rows = readRoundClocks({ dir }).filter((r) => Number.isFinite(r.roundSeconds));
  const sum = (f) => rows.reduce((n, r) => n + (Number(f(r)) || 0), 0);
  const total = sum((r) => r.roundSeconds);
  return {
    rounds: rows.length,
    roundSeconds: Math.round(total * 100) / 100,
    agentTurnSeconds: Math.round(sum((r) => r.agentTurnSeconds) * 100) / 100,
    // THE AGENT TURN PLUS THE DERIVE STEP. `agentTurnSeconds` above is one of
    // its two parts and is reported separately because it is the one nothing
    // in this pipeline can shorten from inside the walk.
    derivingSeconds: Math.round(sum((r) => r.derivingSeconds) * 100) / 100,
    deriveStepSeconds: Math.round(sum((r) => r.deriveStepSeconds) * 100) / 100,
    bankingSeconds: Math.round(sum((r) => r.bankingSeconds) * 100) / 100,
    otherStepSeconds: Math.round(sum((r) => r.otherStepSeconds) * 100) / 100,
    predicateSeconds: Math.round(sum((r) => r.predicateSeconds) * 100) / 100,
    unattributedSeconds: Math.round(sum((r) => r.unattributedSeconds) * 100) / 100,
    agentShare: total ? Math.round((sum((r) => r.agentTurnSeconds) / total) * 1000) / 1000 : null,
    bankingShare: total ? Math.round((sum((r) => r.bankingSeconds) / total) * 1000) / 1000 : null,
    sidesClosed: sum((r) => r.sidesClosed),
    medianSecondsPerClosedSide: percentile(
      rows.map((r) => r.secondsPerClosedSide).filter((v) => Number.isFinite(v)),
      50
    ),
    // SAID ON THE OBJECT, like the packet distribution's `missing` above.
    missing:
      "no row here carries tokens or dollars, and the agent turn is not split into the parent turn and its " +
      "children: the gateway's usage reaches docker/char/agentlog.py on the host and never reaches the walk. " +
      "This row answers `agent or pipeline` and does not answer `parent or fan-out`.",
  };
}

/** One line a person reads, folded into a step's `did`, or nothing to say. */
export function reportRoundClock(metrics, did, { dir = ROUNDS_DIR } = {}) {
  const s = roundClockSummary({ dir });
  if (!s.rounds) return s;
  metrics.roundClockRounds = s.rounds;
  metrics.roundClockSeconds = s.roundSeconds;
  metrics.roundClockAgentTurnSeconds = s.agentTurnSeconds;
  metrics.roundClockBankingSeconds = s.bankingSeconds;
  metrics.roundClockAgentShare = s.agentShare;
  metrics.roundClockDerivingSeconds = s.derivingSeconds;
  did.push(
    `round clock: ${s.rounds} attributed round(s), ${s.roundSeconds}s in total — ${s.derivingSeconds}s DERIVING ` +
      `(${s.agentTurnSeconds}s of it the agent turn, ${Math.round((s.agentShare ?? 0) * 100)}% of the round, and ` +
      `${s.deriveStepSeconds}s the derive step building the brief), ${s.bankingSeconds}s BANKING (record, ` +
      `determinism, emit, measure), ${s.otherStepSeconds}s in the other steps, ${s.predicateSeconds}s answering ` +
      `satisfied/precondition and ${s.unattributedSeconds}s in the walk itself (node's startup, the step imports, ` +
      `the worklist write). Those five add up to the total exactly, by construction. The agent turn is everything ` +
      `between the walk handing a brief over and the walk being invoked again — the agent, its workers, the ` +
      `gateway AND the container's re-invocation — so it is not "model time", and nothing here carries tokens or ` +
      `dollars`
  );
  return s;
}

/* ==========================================================================
 * THE YIELD RATCHET — end a run when a round's clock stops buying sides.
 *
 * WHAT IT IS FOR, measured. Run `20260919T092106Z` (location-ms): round 1 spent
 * 1,945 seconds and closed 136 sides; rounds 2 and 3 spent 2,304 seconds
 * between them and closed 6. 54% of that run's clock bought 4% of its sides,
 * and round 1's sides were already recorded, emitted and measured before round
 * 2 started, so ending after round 2 loses nothing that is not on disk.
 *
 * WHAT IT RATCHETS ON, and this is plan 13's D45 exactly.
 *
 * AND D45 IS WHERE THE tracy-worker NUMBERS BELOW COME FROM. Run
 * `20260918T164503Z` has no directory on any reachable checkout; every
 * figure attributed to it here is read off that table in
 * `docs/plans/plan13-bank-the-work-and-price-it-honestly.md`. Said once,
 * here, for the whole block: those are D45s, not a log.
 *
 *   ON THE UNIT COST OF A NEWLY CLOSED SIDE, NEVER ON THE ROUND'S TOTAL. Run
 *   `20260918T164503Z`'s round 7 cost $25.83 against a run median of about
 *   $25 — nine rounds inside $21.84 and $29.13 — and closed 9 sides against
 *   round 6's 97. A ratchet on total round cost would have flagged nothing on
 *   that run. A round is a fixed price; the only variable is what it closes.
 *
 *   ON A MULTIPLE OF THE ROLLING MEDIAN, over the rounds BEFORE the one being
 *   judged. Excluding the round under judgement is not a detail: location-ms
 *   has one good round behind the collapse, so a median that included the
 *   collapsed round would be the midpoint of the two and the ratio would be
 *   1.9x — under any threshold worth having. On the tracy-worker run the prior
 *   median is $0.28/side and round 7 is $2.87, which is 10x, so 4x catches it
 *   and no other round of that run comes within a factor of two of the
 *   threshold.
 *
 *   AND NEVER WITHOUT A SAMPLE BEHIND THE MEDIAN. "At least ten newly closed
 *   sides" is a condition on the HISTORY and not on the round being judged,
 *   and it has to be: the round D45 was written to catch closed NINE, so
 *   reading the ten as the firing round's own count would make the rule unable
 *   to catch the only round anybody has ever seen it needed for. What the ten
 *   buys is a median that one genuinely hard side cannot set — which is the
 *   failure D45 names, a breaker that trips on a single expensive row and ends
 *   healthy rounds. On location-ms the sample is round 1's 136 closed sides;
 *   on tracy-worker it is 428 across rounds 2 to 6.
 *
 *   AND NEVER ON ONE ROUND ALONE. THE ROUND BEFORE IT MUST HAVE COLLAPSED
 *   TOO, each judged against the median of the rounds before IT. This is the
 *   correction the first version of this rule needed, and the evidence for it
 *   is the first version's own replay: on `20260918T164503Z` it fires at the
 *   top of round 8, and rounds 8 and 9 then closed 96 and 48 sides. That is
 *   144 sides — a fifth of the run's answered work — traded for about $48, on
 *   the single historical case where the rule fired at all. A stop rule whose
 *   one measured firing is a false positive is not ready to end runs. The
 *   confirming round is what a collapse has to survive to be called one, and
 *   `CHARPILOT_YIELD_RATCHET_CONFIRM=1` restores the single-round behaviour
 *   for anyone who wants it.
 *
 *   The confirming round is the previous round THAT HAS A CLOSED-SIDE COUNT,
 *   not simply the previous walk. A walk that died before `derive` — three of
 *   the nine on `20260919T104903Z` died in `measure` — handed nothing over and
 *   counted nothing, so it is neither a collapse nor a confirmation. Skipping
 *   it is not generosity: treating it as a break would make the rule unable to
 *   fire on exactly the run it now catches.
 *
 * A ROUND THAT CLOSED NOTHING has no unit cost, and is treated as the worst
 * one rather than skipped — but it still needs the sample AND a confirming
 * round, and round 1 of a run has neither. That is how tracy-worker's cold
 * round 1 (zero proposals, 100% of itself spent acquiring context) cannot end
 * its own run, and how one unlucky round in an otherwise healthy run cannot
 * either.
 *
 * THREE RUNS, REPLAYED under 4x / 10 sides / confirm 2. All three verdicts are
 * stated, including the one where the rule now saves nothing. TWO OF THE THREE
 * ARE LOGS AND ONE IS A TABLE, and this block called all three "the runs on
 * disk" — which was true of two of them and has never been true of the first.
 *
 *   `20260918T164503Z` (tracy-worker). NOT A LOG: no run directory of that
 *   stamp exists on any reachable checkout, and these numbers are read off
 *   plan 13's D45 table
 *   (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`), which is
 *   where they can still be checked and the only place they can.
 *   `packetlog.a-round-that-buys-nothing-ends-the-run` has said "from D45's
 *   table" all along; this comment implied a log anyone could open. Round 7
 *   collapses ($2.87/side against a $0.28 median, 10.2x) and round 6 did not
 *   (0.88x), so there is no confirmation — NO FIRE, anywhere on the run.
 *   Rounds 8 and 9 and their 144 sides are kept. The rule costs this run
 *   nothing and saves it nothing, which is the correct verdict on it.
 *
 *   `20260919T092106Z` (location-ms). Round 2 is 334.7s/side and round 3 is
 *   433.3s/side, both far past 4x a 14.3s median — FIRES at the top of round
 *   4, saving 451s. Under the single-round rule it fired at the top of round 3
 *   and saved 1,751s, so the confirming round costs 1,300s of savings on this
 *   run. That is what avoiding tracy's false positive is priced at, and it is
 *   the round that is paid for rather than a round that is lost.
 *
 *   `20260919T104903Z` (location-ms again, and this is the run the rule is now
 *   for). Nine rounds. Five of them reached `derive` and therefore have a
 *   closed-side count: 138 sides in 2,251s, then 8 in 1,898s, then 0, 0 and 4.
 *   Open sides went 146 -> 8 -> 0 -> 4 -> 4: the run reached ZERO and reopened,
 *   because repair withdrew claims, and then spun. Rounds 5, 6 and 7 ran 194s,
 *   355s and 201s with ZERO child turns — the parent alone, closing nothing,
 *   four sides open the whole way. The 1,898s round is 14.6x and the 823s
 *   round after it closed nothing, so it FIRES on that pair, ending the run
 *   about 18 minutes before the SIGTERM did. Cheap spinning rather than
 *   expensive spinning, and the reason a rule that ratchets on a 4x unit cost
 *   still has to treat a zero-closing round as the worst round there is.
 *
 * NEITHER of the two runs above ended by finishing. Both died by SIGTERM when
 * Docker Desktop stopped — location-ms exit 143 in round 9, tracy-worker "the
 * workflow failed in round 5" — and tracy salvaged to `status: partial`. No
 * sentence here cites either ending as a completion.
 *
 * SECONDS, NOT DOLLARS, AND THE SUBSTITUTION IS NAMED. D45 ratchets on
 * dollars per closed side. The walk cannot see dollars: the agent's spend is
 * reported by the gateway to `docker/char/agentlog.py` on the HOST, which
 * writes `docker/runs/<stamp>/log.jsonl`, and nothing inside the container
 * reads it. So this ratchets on SECONDS per newly closed side, which is the
 * best proxy the walk can see, and it is a good one on the only run where both
 * can be checked. On `20260919T092106Z`:
 *
 *   round | closed |     s |      $ |  s/side |  $/side | x median
 *       1 |    136 | 1,945 |  21.58 |    14.3 |   0.159 | —
 *       2 |      3 | 1,004 |   8.44 |   334.7 |   2.813 | 23.4x / 17.7x
 *       3 |      3 | 1,300 |   9.38 |   433.3 |   3.127 |
 *
 * Dollars per second across those three rounds is 0.0111, 0.0084 and 0.0072 —
 * within 35% — while the yield varies 45-fold. The substitution changes the
 * multiple and changes the verdict on no round of that run. What it would miss
 * is a round that got expensive without getting slow, which no measured round
 * has ever been; when a cost figure reaches the walk, this should ratchet on
 * it instead and keep the seconds as the second column.
 * ========================================================================== */

/** 4x the rolling median, and it is a threshold with one measurement behind it. */
export const RATCHET_MULTIPLE_DEFAULT = 4;

/** Ten newly closed sides BEHIND the median before it may be used. */
export const RATCHET_SAMPLE_DEFAULT = 10;

/**
 * Two collapsed rounds in a row, because one is a false positive on the only
 * run where one has ever been measured. Set to 1 for the single-round rule.
 */
export const RATCHET_CONFIRM_DEFAULT = 2;

/**
 * Did ONE round exceed the multiple, judged against what came before IT?
 *
 * Split out because the firing round and every confirming round have to be
 * asked the same question against their own history, and an inlined version of
 * this would have been two spellings of one rule — which is how the two
 * accounts of the same arithmetic that this file exists to prevent get in.
 *
 * A round with no closed-side count is `judgeable: false`: it neither collapses
 * nor confirms, and the caller SKIPS it rather than reading it as a break.
 */
function judgeRound({ roundSeconds, sidesClosed, secondsPerClosedSide, priorUnits, multiple }) {
  if (!Number.isFinite(roundSeconds) || roundSeconds <= 0) return { judgeable: false };
  if (sidesClosed == null || !Number.isFinite(Number(sidesClosed))) return { judgeable: false };
  const median = percentile(priorUnits, 50);
  // THE UNIT COST IS COMPUTED EVEN WHEN THERE IS NO MEDIAN TO JUDGE IT
  // AGAINST, because round 1 has no median and round 2's median is round 1's
  // unit cost. Returning null here instead cost this file an evening: every
  // round came back unjudged, because the first round's cost never reached the
  // list the second round's median is taken over.
  const unit = Number(sidesClosed) > 0
    ? (Number.isFinite(secondsPerClosedSide) && secondsPerClosedSide > 0 ? secondsPerClosedSide : roundSeconds / Number(sidesClosed))
    : null;
  if (median == null) return { judgeable: true, collapsed: false, median: null, unit, ratio: null };
  // A ROUND THAT CLOSED NOTHING IS THE WORST ROUND, not an unmeasurable one.
  // There is no ratio with a zero denominator and there is no doubt about the
  // verdict either: the round bought no sides at any price.
  if (unit == null) return { judgeable: true, collapsed: true, median, unit: null, ratio: null };
  return { judgeable: true, collapsed: unit / median >= multiple, median, unit, ratio: unit / median };
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Whether the round just ended is the one to stop the run on.
 *
 * Pure: it takes the round's two numbers and the history, and returns the
 * whole judgement including the numbers it judged on, so the sentence the walk
 * prints and the row on disk are the same arithmetic rather than two accounts
 * of it.
 *
 * `history` is the prior rounds' `secondsPerClosedSide` paired with the sides
 * each one closed — the sides are what the minimum sample counts, the seconds
 * are what the median is taken over. A prior round that closed nothing
 * contributes its sides (zero) and no unit cost, because a ratio with a zero
 * denominator is not a data point.
 */
export function yieldRatchet({
  seconds = null,
  closed = null,
  history = [],
  multiple = RATCHET_MULTIPLE_DEFAULT,
  sample = RATCHET_SAMPLE_DEFAULT,
  confirm = RATCHET_CONFIRM_DEFAULT,
  enabled = true,
} = {}) {
  // THE ROUNDS THAT CAN BE JUDGED, oldest first, with the round that just
  // ended appended as the last of them. A walk that died before `derive`
  // carries no closed-side count and is dropped here, so "the round before
  // this one" means the last round that counted something rather than the last
  // process that ran.
  const judgeable = [
    ...history.filter((h) => Number.isFinite(h?.roundSeconds) && h?.sidesClosed != null),
    { roundSeconds: seconds, sidesClosed: closed, secondsPerClosedSide: null },
  ];
  // The median a round is judged against is taken over the unit costs of the
  // rounds before IT, so the list is walked forwards accumulating them.
  const units = [];
  const verdicts = judgeable.map((r) => {
    const v = judgeRound({ ...r, priorUnits: [...units], multiple });
    if (v.judgeable && Number.isFinite(v.unit) && v.unit > 0) units.push(v.unit);
    return v;
  });
  const me = verdicts[verdicts.length - 1];
  const priorUnits = history.map((h) => Number(h?.secondsPerClosedSide)).filter((v) => Number.isFinite(v) && v > 0);
  const sampleSides = history.reduce((n, h) => n + (Number(h?.sidesClosed) || 0), 0);
  const round2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
  const judged = {
    fired: false,
    why: null,
    seconds: Number.isFinite(seconds) ? Math.round(seconds) : null,
    closed: closed == null ? null : Number(closed),
    secondsPerClosedSide: round2(me?.unit),
    median: round2(me?.median),
    ratio: round2(me?.ratio),
    multiple,
    sample,
    confirm,
    sampleSides,
    priorRounds: priorUnits.length,
    // How many rounds back the collapse actually runs, so the sentence can say
    // "two in a row" with a number rather than a claim.
    collapsedInARow: 0,
  };
  if (!enabled) return { ...judged, why: "the ratchet is switched off" };
  if (!Number.isFinite(seconds) || seconds <= 0) return { ...judged, why: "no round ended here to judge" };
  if (me.median == null) return { ...judged, why: "no round before this one has a unit cost to be a median of" };
  if (sampleSides < sample) {
    return {
      ...judged,
      why:
        `only ${sampleSides} side(s) closed behind the median, and the rule needs ${sample} — one genuinely hard ` +
        `side can cost more than twenty easy ones, so a median with less than that behind it is one side's opinion`,
    };
  }

  // HOW FAR BACK THE COLLAPSE RUNS. Counted over the judgeable rounds, newest
  // first, stopping at the first one that did not collapse. The sample gate is
  // NOT re-applied to the confirming rounds: they are judged against smaller
  // histories than the firing round's, and the question they answer is "was
  // this the second one in a row", not "would this one have ended the run".
  let streak = 0;
  for (let i = verdicts.length - 1; i >= 0; i -= 1) {
    if (!verdicts[i].judgeable) continue;
    if (!verdicts[i].collapsed) break;
    streak += 1;
  }
  judged.collapsedInARow = streak;

  const cost =
    closed == null || !(Number(closed) > 0)
      ? `spent ${Math.round(seconds)}s and closed no side at all`
      : `spent ${Math.round(seconds)}s to close ${closed} side(s) — ${judged.secondsPerClosedSide}s each, ` +
        `${judged.ratio}x the ${judged.median}s/side median of the ${priorUnits.length} round(s) before it`;

  if (!me.collapsed) {
    return {
      ...judged,
      why: closed == null || !(Number(closed) > 0)
        ? `this round closed nothing, but it is the first such round and the rule needs ${confirm} in a row`
        : `${judged.secondsPerClosedSide}s/side is ${judged.ratio}x the median of ${judged.median}s/side, under ${multiple}x`,
    };
  }
  if (streak < confirm) {
    return {
      ...judged,
      why:
        `this round ${cost}, which is past ${multiple}x — but only ${streak} round(s) in a row have collapsed and ` +
        `the rule needs ${confirm}. One collapsed round is not a failing run: on 20260918T164503Z the round after ` +
        `the collapse closed 96 sides, so a rule that ended the run on one would have thrown away 144 sides ` +
        `(that run's log is gone — the figures are plan 13's D45 table, not something you can open)`,
    };
  }
  return {
    ...judged,
    fired: true,
    why:
      `this round ${cost}` +
      (streak > 1 ? `, and so did the ${streak - 1} round(s) before it — ${streak} collapsed rounds in a row` : "") +
      `, against a median taken over the rounds before each of them, with ${sampleSides} side(s) closed behind it`,
  };
}

/**
 * The ratchet asked of the log, which is where the history lives.
 *
 * `seconds` is the round's elapsed measured from the previous handover to NOW,
 * which is an UNDERCOUNT of the `roundSeconds` the clock row will carry: the
 * brief this walk is about to build is inside the round and has not happened
 * yet. Undercounting is the safe direction — it can only make the ratchet less
 * likely to fire — and on the measured runs the brief is a rounding error
 * against a round that is tens of minutes long.
 */
export function ratchetFromLog({
  closed = null,
  dir = ROUNDS_DIR,
  at = Date.now(),
  pid = process.pid,
  target = REPO_ROOT,
  env = process.env,
} = {}) {
  const enabled = String(env.CHARPILOT_YIELD_RATCHET ?? "").trim().toLowerCase() !== "off";
  const startedAt = roundStartedAt({ dir, at, pid, target });
  const history = readRoundClocks({ dir }).filter((r) => r.target === target && Number.isFinite(r.roundSeconds));
  return {
    ...yieldRatchet({
      seconds: startedAt == null ? null : (at - startedAt) / 1000,
      closed,
      history,
      multiple: num(env.CHARPILOT_YIELD_RATCHET_MULTIPLE, RATCHET_MULTIPLE_DEFAULT),
      sample: num(env.CHARPILOT_YIELD_RATCHET_SAMPLE, RATCHET_SAMPLE_DEFAULT),
      confirm: num(env.CHARPILOT_YIELD_RATCHET_CONFIRM, RATCHET_CONFIRM_DEFAULT),
      enabled,
    }),
    roundStartedAt: startedAt,
  };
}


/* ==========================================================================
 * D54 — THE STALL THE YIELD RATCHET CANNOT SEE, AND MUST NOT BE MADE TO.
 *
 * THE RATCHET ABOVE IS FINISHED AND CORRECT and nothing here touches it. It
 * asks "what did this round's seconds BUY", which needs a unit cost, which
 * needs a round that was dealt something. Run `20260919T104903Z` has only two
 * judgeable rounds and they are not adjacent, so the ratchet is BLIND to it —
 * and forcing a unit cost onto a round that was dealt nothing would make every
 * dealt-nothing round in every run read as the worst round ever measured. That
 * is why this is a second rule rather than a looser first one.
 *
 * THE SIGNAL THAT CATCHES THAT RUN IS A DIFFERENT ONE: `derive:
 * packetsHandedOutLastRound=0`, in rounds 1, 4, 6 and 8 of nine. One zero is
 * normal — round 1 has no round before it to have dealt anything. Four is not.
 *
 * AND IT FIRES ON EXACTLY ONE OF THE THREE ZEROS' REASONS, which is why D53 had
 * to land first. `dealtNothing` names them apart, and only one is a defect:
 *
 *   no-round-before    a cold round 1. Never a stall, and there is nothing
 *                      before it to have stalled.
 *   nothing-was-open   the last round was handed over by a step that DEALS
 *                      sides and it had none to deal. That is a run finishing,
 *                      and a rule that ended a run for finishing would be worse
 *                      than the stall it was built for.
 *   walk-died-upstream the walk stopped before the step that deals sides was
 *                      reached, so every side still open is one nobody was
 *                      asked about. THIS is the run killer and this is the only
 *                      word that fires.
 *
 * THE MEASURED RUN, round by round, from its own `log.jsonl`. Judgeable rounds
 * are the ones whose `derive` ran — rounds 3, 5 and 7 died inside `measure` and
 * carry no deal at all, exactly as the ratchet drops rounds with no closed-side
 * count. The streak is counted over the rounds that reached `derive`, not over
 * the processes that started:
 *
 *   r1  handed 146   dealt-nothing: no-round-before    open 146
 *   r2  handed   8   dealt 34                          open   8
 *   r3  — died in `measure`, no deal, not judgeable
 *   r4  handed   0   dealt-nothing: walk-died-upstream open   0
 *   r5  — died in `measure`
 *   r6  handed   4   dealt-nothing: walk-died-upstream open   4   <- fires here
 *   r7  — died in `measure`
 *   r8  handed   4   dealt-nothing: walk-died-upstream open   4
 *   r9  handed   0   dealt 4                           open   0
 *
 * TWO IN A ROW, AND THE DEFAULT IS ARGUED RATHER THAN COPIED. The ratchet needs
 * two because one collapsed round was measured to be a false positive. This
 * needs two for a different reason: ONE upstream death is ordinary — a step
 * refused, the next agent turn fixes it, and the round after that deals again —
 * while two in a row is the fix not taking, which is a loop and not a setback.
 * Three would fire on round 8 of the only run that has ever stalled, one round
 * before SIGTERM, which is a rule that can technically fire and never usefully
 * does.
 *
 * `open > 0` IS ASKED OF THE FIRING ROUND AND OF NO OTHER. It is the guard that
 * keeps a finishing run safe: a round with nothing open has nothing anybody
 * failed to deal, so it cannot fire however many walks died before it. It is
 * NOT asked of the rounds in the streak, because the round row does not carry
 * an open count and inventing one here would be a second account of a number
 * `derive` already holds — round 4 above had open 0 and its upstream death was
 * still real, and what makes round 6 a stall is that four sides are open NOW.
 *
 * WHAT FIRING COSTS, AND IT IS MUCH LESS THAN THE RATCHET'S. This returns a
 * `stop`, which is a deliberate end to the ASKING: `workflow.mjs` carries the
 * walk on through `repair`, `ruling` and `report`, so the run still repairs,
 * still rules and still writes `result.json`. On `20260919T104903Z` firing in
 * round 6 trades four sides for three rounds and a result — and that run had no
 * result at all, because it was killed by SIGTERM in round 9.
 *
 * REPLAYED ON THE THREE MEASURED RUNS, in
 * `packetlog.a-round-nobody-was-asked-about.test.mjs`:
 *
 *   20260918T164503Z  NO FIRE  every round was handed over by `derive`; the only
 *                              dealt-nothing round is the cold round 1
 *   20260919T092106Z  NO FIRE  same — `measure` exited 1 in rounds 3 and 4 and
 *                              on that pipeline did not end the walk, so
 *                              `derive` dealt in every round
 *   20260919T104903Z  FIRES    judging round 6, on `walk-died-upstream` twice
 *                              running with four sides open
 * ========================================================================== */

/** Two rounds in a row, and the docblock argues the number rather than copying it. */
export const STALL_ROUNDS_DEFAULT = 2;

/**
 * Whether the round just ended is one nobody was asked about, again.
 *
 * Pure, like `yieldRatchet`: it takes this round's reason, what is still open,
 * and the history, and returns the whole judgement including the numbers it
 * judged on — so the sentence the walk prints and the row on disk are one piece
 * of arithmetic rather than two accounts of it.
 *
 * `history` is the prior round-clock rows, oldest first. A row that never
 * reached `derive` carries no deal and is DROPPED, the same way the ratchet
 * drops a row with no closed-side count: "the round before this one" means the
 * last round that was dealt to, not the last process that ran.
 */
export function stallRule({
  reason = null,
  open = 0,
  history = [],
  rounds = STALL_ROUNDS_DEFAULT,
  enabled = true,
} = {}) {
  // THE ROUNDS THAT CAN BE JUDGED, oldest first, with this one appended last.
  // `sidesDealt == null` is a walk that died before `derive` — it has no deal
  // to have a reason about, and reading its silence as a break would hide the
  // stall behind the very deaths that cause it.
  const judgeable = [
    ...history.filter((h) => h?.sidesDealt != null).map((h) => h.dealtNothingReason ?? null),
    reason ?? null,
  ];
  let streak = 0;
  for (let i = judgeable.length - 1; i >= 0; i -= 1) {
    if (judgeable[i] !== UPSTREAM_DEATH) break;
    streak += 1;
  }
  const judged = {
    fired: false,
    why: null,
    reason: reason ?? null,
    open: Number(open) || 0,
    rounds,
    // How far back the run of upstream deaths goes, so the sentence can say
    // "twice running" with a number rather than a claim.
    deadInARow: streak,
    judgeableRounds: judgeable.length,
  };
  if (!enabled) return { ...judged, why: "the stall rule is switched off" };
  if (reason == null) {
    return { ...judged, why: "the last round dealt a packet of sides, so somebody was asked about them" };
  }
  if (reason !== UPSTREAM_DEATH) {
    return {
      ...judged,
      why:
        `the last round dealt nothing because \`${reason}\`, which is not a stall — a cold first round and a run ` +
        `with nothing open are both rounds nobody FAILED to ask about, and a rule that ended a run for finishing ` +
        `would be worse than the stall it was built for`,
    };
  }
  if (!(judged.open > 0)) {
    return {
      ...judged,
      why:
        "the walk did die before the step that deals sides, and there is nothing open for it to have dealt — so " +
        "nobody was denied a question. This is the guard that keeps a finishing run safe",
    };
  }
  if (streak < rounds) {
    return {
      ...judged,
      why:
        `the walk died before \`derive\` and ${judged.open} side(s) are open that nobody was asked about — but only ` +
        `${streak} round(s) in a row have ended that way and the rule needs ${rounds}. One upstream death is a step ` +
        `refusing and the next turn fixing it; two in a row is the fix not taking`,
    };
  }
  return {
    ...judged,
    fired: true,
    why:
      `${streak} rounds in a row ended before \`derive\` was reached, and ${judged.open} side(s) have been open ` +
      `throughout with nobody asked about one of them. Run 20260919T104903Z did exactly this: rounds 3, 5 and 7 ` +
      `died inside \`measure\`, rounds 4, 6 and 8 dealt nothing, four sides stayed open for five rounds, and the ` +
      `run was killed at 109 minutes having never written a result`,
  };
}

/**
 * The stall rule asked of the log, which is where the history lives.
 *
 * Shares `ratchetFromLog`'s shape exactly — same directory, same per-target
 * filter, same `off` switch spelling — because two rules that end a round
 * should be turned off and moved the same way, and a reader who has learned one
 * has learned the other.
 */
export function stallFromLog({
  reason = null,
  open = 0,
  dir = ROUNDS_DIR,
  target = REPO_ROOT,
  env = process.env,
} = {}) {
  const enabled = String(env.CHARPILOT_STALL_RULE ?? "").trim().toLowerCase() !== "off";
  const history = readRoundClocks({ dir }).filter((r) => r.target === target);
  return stallRule({
    reason,
    open,
    history,
    rounds: num(env.CHARPILOT_STALL_RULE_ROUNDS, STALL_ROUNDS_DEFAULT),
    enabled,
  });
}

if (process.argv[1] && process.argv[1].endsWith("packetlog.mjs")) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--dir");
  // TWO LOGS, TWO DEFAULTS, ONE `--dir`. `--rounds` asks the clock instead of
  // the packet distribution, and `--dir` then names the clock's directory —
  // one flag that means "not the default place", rather than two that a reader
  // has to remember apart.
  const rounds = argv.includes("--rounds");
  const dir = at >= 0 ? resolve(argv[at + 1]) : rounds ? ROUNDS_DIR : PACKETS_DIR;
  const d = rounds ? roundClockSummary({ dir }) : packetDistribution({ dir });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
  } else {
    const did = [];
    if (rounds) reportRoundClock({}, did, { dir });
    else reportPackets({}, did, { dir });
    process.stdout.write(`${did[0] ?? `no ${rounds ? "round clock" : "packet"} records under ${dir}`}\n`);
  }
}
