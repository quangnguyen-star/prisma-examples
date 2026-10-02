/**
 * derive — an INPUT for each uncovered side, never an expected output.
 *
 * This is one of the two phases that stays with an agent: a tool can enumerate
 * arms, it cannot know which value staging has rows for. So this file is the
 * MACHINE HALF only. It enumerates what is left to decide and hands it over;
 * deciding is the answering turn's job, and nothing here writes a proposal.
 *
 * WHAT THE HANDOVER HAS TO CARRY, and why it is most of this file. The brief
 * is the whole deliverable. On run `20260916T031317Z` the answering turn spent
 * 193 calls and 55.4 minutes — 25.6% of the run — re-reading this pipeline's
 * own artifacts to assemble, per arm, the same five things: the condition
 * source, the owning function's entry recipe and parameters, the boundaries it
 * touches, the arm's side labels, and the shape of the document a proposal has
 * to be. Every one of those is already held exactly by a tool here. A `pending`
 * item that names an arm and leaves the agent to go and find them is not a
 * handover, it is a search request, and the search is the cost this step exists
 * to remove. So `context` is built by RUNNING the tools that own the material —
 *
 *   worklist.mjs --skeleton     the proposal document with every address
 *                               already filled in: function id, arm ids, side
 *                               labels, `via`, boundary symbols and modules,
 *                               one `args` slot per declared parameter
 *   handoff.mjs --stage 4       what must never be called, and at which address
 *   validate.mjs --schema       the vocabularies the filled document is
 *                               checked against, printed from the constants
 *                               that enforce them
 *
 * — and never by restating what they print. Three of the skeleton's fields
 * (`covers`, the `reaches` labels, `via`) are join keys validate.mjs matches
 * BYTE-EXACTLY, so a restatement here is not a duplicate, it is a silent
 * mis-join waiting to happen.
 *
 * WHAT COUNTS AS LEFT TO DECIDE is the ledger's question, and the answer is
 * read off the filesystem every time: an uncovered side with no proposal naming
 * it in `reaches` and no `blocked` entry declaring it. Sides already answered
 * either way are not asked about again, which is what makes the loop converge
 * instead of re-handing the same list every round.
 *
 * WHAT IS HANDED OVER IS ONE BATCH, NOT THE WHOLE BACKLOG. A pending item is
 * evidence and evidence has a size: MEASURED over all 31 open sides of the
 * vendored location-ms run `20260915T033521Z`, an item is 2,941-4,368 bytes
 * (median 3,748; 4,143 with its share of the file's wrapper). The largest
 * service in the fleet has ~945 open sides, so an uncapped round writes a ~3.8
 * MB out/worklist-decisions.json and calls it a handover. `recipes.mjs` records
 * what happens next, on the same fleet and in the same shape: `qode-ptp-ms
 * out/worklist.md 3.3M`, generated, therefore treated as delivered, and read by
 * nobody. A brief that cannot be read is the same defect as a coverage number
 * without its denominator, and this step would reproduce it exactly.
 *
 * So `run` hands over at most one batch of sides per round and says how many it
 * held back. That costs no convergence and no evidence. The walk exits 75 every
 * round anyway; the answering turn writes proposals; the next walk re-enters
 * here and rebuilds from the filesystem, where the sides answered last round
 * are no longer open — so the next round is the next batch, and the loop closes
 * in ceil(open / batch) rounds instead of one. The cap is on the ROUND and
 * never on the item: shrinking a `context` to fit more sides in would be the
 * unreadable brief again, one level down.
 *
 * AND THE ANSWER COMES BACK THE SAME WAY IT WENT OUT. The answering turn
 * cannot write inside `.claude/` — that is the harness's own directory and the
 * refusal sits above `docker/settings.json`, which already grants
 * `Write(.claude/**)`. Run `20260916T112101Z` spent 34.6 minutes and $3.80 in
 * one round discovering that, and wrote nothing; and the ten sides it did rule
 * were hand-written into BLOCKED.md, untagged, where ledger.mjs's fence regex
 * could not see them, so three rounds reported `0 has a written reason`. So the
 * agent SUBMITS into a directory it can write and this step materialises the
 * submission by spawning the tool that owns each format. The agent still runs
 * nothing, which is the rule worth 193 calls and 55.4 minutes of run
 * `20260916T031317Z` — see the SUBMISSION section below.
 *
 * THE CAP IS NOT PART OF `satisfied`, which is why it is read in `run` and
 * nowhere else. `satisfied` asks its same two questions of the whole open list,
 * so a repo that was handed 20 of its 945 sides is 925 short of done. A cap
 * that leaked into it would end a run with hundreds of sides silently
 * unbriefed, every later stage built on them, and the gate reporting stage 3
 * closed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

import { BEHAVIOUR_JSON, OUT_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "../config.mjs";
// The BLOCKED.md format, from the tool that owns it. Not reimplemented here:
// worklist.mjs imports `SKELETON_TODO` from the file that rejects it for the
// same reason — a second reader of a format is a reader that can drift from the
// checker, and then this step stops asking about a side the ledger still counts
// as unaccounted, which is the one mistake a work list must not make. Both
// imports are pure functions over text; ledger.mjs runs nothing on import.
// THE DECLARATION VOCABULARIES, from the file that enforces them. `CATEGORIES`
// and `KILLERS` are checked here so a typo comes back as a pending item naming
// the field instead of as a tool's exit code — and they are IMPORTED, never
// copied, for the reason blocked.mjs states about the same two sets: a second
// reader of a vocabulary is a reader that can drift from the checker, and a
// drifted one refuses what the checker accepts.
import {
  CATEGORIES,
  KILLERS,
  armSideLabels,
  blockedEntries,
  doubleClaimEvidence,
  refusedDeclarations,
  resolveDoubleClaim,
  sidesOf,
  withRefusedDeclaration,
  withoutRefused,
} from "../ledger.mjs";
import { noWayIn, premiseKey, submissionTag, supersededRulings } from "../premises.mjs";
// THE ONE RULE: a brief states a parameter's NAME and TYPE and never a VALUE.
// The `question` line is prose built out of the arm's own condition, and
// `stripLiterals` is what keeps a literal from riding into it — the arm source
// itself stays verbatim in `context`, where worklist.md already puts it,
// because the condition is the thing being read rather than a value to paste.
import { oneLine, paramName } from "../novalues.mjs";
// WHERE THE WALK RECORDS WHAT IT ASKED. Imported rather than rebuilt out of
// OUT_DIR so there is one name for that file — repair.mjs imports the same
// constant for the same reason. This step only ever READS it: it is the walk's
// own record of what the walk handed over, and a step that wrote it would be
// writing the disk it is about to read.
// THE FURNITURE BOTH STEPS HAND OVER comes from there too — `CHECKPOINT`,
// `MOCK_KIND_RULE`, `PARALLELISM`, `COVERS_RULE` and the answers block. It used
// to be written here, which made this file the only place a packet's rules
// existed and left `repair` to build its packets from scratch: its briefs named
// none of `charpilot-answers`, `limits`, `checkpoint`, `parallel` or
// `mock.kind`. Shared rather than copied, because two prose copies of the
// `mock.kind` rule is how 20 claims went false against a document that
// disagreed with the code.
import {
  ANSWERS_DIRNAME,
  ANSWERS_ENV,
  CHECKPOINT,
  CHECKPOINT_TOOL,
  COVERS_RULE,
  NOTE_KINDS,
  NOTE_LIMITS,
  WORKLIST_DECISIONS,
  answerFileFor,
  answersBlock,
  incrementalAnswers,
  workerDeadlineMin,
  LIGHT_WORKER_AGENT,
  lightCohort,
  lightWorkerOn,
  answersDir,
  boundedNote,
  handoverStep,
  headersInHandover,
  isReservedAnswerFile,
  freshAnswerFile,
  notesBlock,
  notesInHandover,
  packetFurniture,
  packetMinutes,
  packetsPerRound,
  readHandoverDoc,
  roundBudgetMin,
  workerConcurrency,
  servableNotes,
  sourceFingerprint,
} from "./handover.mjs";
// RE-EXPORTED, so every caller that already asks this file for them keeps
// working and there is still exactly one definition of each.
export { ANSWERS_DIRNAME, ANSWERS_ENV, CHECKPOINT, CHECKPOINT_TOOL, COVERS_RULE, answersDir };
// `here` renders a path the way every other step renders one, from the module
// that carries the shared runner. That runner is deliberately NOT what spawns
// the recorder below: it takes no environment, and verify-on-write has to move
// record.mjs's output with CHARPILOT_OUTPUT rather than let a narrowed run land
// on behaviour.json — and it takes no injectable seam, while the argv this file
// sends to a tool that can bill is a thing a test has to read back exactly.
import {
  NOTES_DIR,
  PARTIAL_EXIT,
  noteCacheFurniture,
  noteObligation,
  noteSubmissionConsumed,
  notesArgv,
  readNote,
  reportNoteCache,
} from "../notes.mjs";
// THE PER-PACKET DISTRIBUTION, in its own append-only log. Imported rather
// than written here for the reason `notes.mjs` is: it is a measurement log and
// not a pipeline artifact, and keeping the writer in one file is what makes
// "this step writes no artifact it later reads" still true and checkable.
import {
  NO_ROUND_BEFORE,
  NOTHING_WAS_OPEN,
  UPSTREAM_DEATH,
  ratchetFromLog,
  recordPackets,
  reportPackets,
  reportRoundClock,
  roundsIn,
  stallFromLog,
} from "../packetlog.mjs";
import { attemptLines, readAttempts, recordAttempts, salvageAfter, salvageOn, salvagedRows, writeSalvaged } from "../attempts.mjs";
import { carriedBlock, carriedPackets, carryOn } from "../carry.mjs";
// D51. WHICH ROWS THE LAST MEASUREMENT COULD NOT MEASURE. The join is
// coverage.mjs's artifact and is read here, never written — the reading itself
// lives in `measure`, where the two refusals are already told apart, so a
// second copy of that test cannot drift from the first.
import { COVERAGE_JSON, undeliverableRows, unmeasurableRows } from "./measure.mjs";
import { here } from "./preflight.mjs";
// THE MODE, and the artifact the batch recording lands in, from the step that
// owns both. Never re-derived here: `liveDecision` is the one function
// record.mjs asks, the record step already calls it, and a second copy of that
// precedence would be a second way for a step and the tool it spawns to
// disagree about whether a row is a real billed request.
import { mode, recordedArtifact } from "./record.mjs";

export const NAME = "derive";

/**
 * A side, as one key. NUL rather than a printable separator: a side label is an
 * operand's source text and can contain anything a colon or a pipe could be
 * mistaken for — four labels on this repo contain a comma.
 */
const sideKey = (armId, side) => `${armId}\u0000${side}`;

/**
 * The way the ledger, the walk's handover and this step all ADDRESS one side.
 *
 * One function and not two spellings, because `satisfied` below reads back the
 * ids `run` handed over: if the two ever drifted apart every open side would
 * read as never handed over and this step could never close. repair.mjs exports
 * the identical function for the identical reason.
 */
export const sideId = (armId, side) => `${armId} [${side}]`;

/**
 * Where the tools are, and where their artifacts land.
 *
 * The tools are addressed at `<repo>/.claude/charpilot/`, which is where
 * install.sh puts them and what every `pilot:*` script in package.json names.
 * NOT at this file's own directory: a shared toolset can be run from anywhere,
 * and resolving siblings from here would run THIS checkout's worklist.mjs
 * against the repo being walked, reporting a brief built by a different version
 * of the tool than the one installed beside the artifacts.
 *
 * `outDir` and `proposalsDir` come from config.mjs, which fixes them at import
 * — the same constants every other tool in the pipeline resolves. They are
 * overridable so a test can point the step at a temp tree; nothing in the walk
 * passes an override.
 */
export function toolPaths(repo, opts = {}) {
  const pilotDir = opts.pilotDir ?? resolve(repo, ".claude", "charpilot");
  return {
    pilotDir,
    outDir: opts.outDir ?? OUT_DIR,
    proposalsDir: opts.proposalsDir ?? PROPOSALS_DIR,
    // The constant the WRITER uses, not a path rebuilt out of OUT_DIR. They are
    // the same file by default and stop being the same the moment
    // CHARPILOT_WORKLIST_OUT or a foreign bench target redirects it, and a step
    // that then read a brief from where the brief is not would report a repo
    // with nothing left to decide.
    worklistJson: opts.worklistJson ?? (opts.outDir ? join(opts.outDir, "worklist.json") : WORKLIST_JSON),
    // THE SAME FILE validate.mjs BUILDS ITS `fnIndex` FROM (validate.mjs:22).
    // Read here for one thing only: a DRIVER's declared parameters. When a row
    // carries `via`, validate.mjs checks `args` against the driver's signature
    // and never the owner's (validate.mjs:663 `signature = driverFn ?? fn`), and
    // the skeleton has no block for a function that owns no uncovered row — the
    // drivers of this fixture's 24 `<argN of ...>` subjects are all absent from
    // `--skeleton`'s `functionSignatures`. Absent or unreadable is not fatal:
    // the shape degrades to the owner's signature and says so.
    scanJson: opts.scanJson ?? (opts.outDir ? join(opts.outDir, "scan.json") : SCAN_JSON),
    // The walk's record of what the last round handed over, READ and never
    // written. `satisfied` is the only reader; `run` does not consult it,
    // because what to ask about next is the open list and nothing else.
    handover: opts.handover ?? WORKLIST_DECISIONS,
    // THE MEASUREMENT'S OWN JOIN, READ and never written, and resolved against
    // THIS round's `out/` so a bench target or a fixture is not quarantined by
    // whatever last ran in the real one.
    coverageJson: opts.coverageJson ?? (opts.outDir ? join(opts.outDir, "coverage.json") : COVERAGE_JSON),
    // The recording, READ and never written: its `skipped[]` is half of what
    // the ledger's `doubleClaimEvidence` decides a double claim from.
    behaviourJson: opts.behaviourJson ?? (opts.outDir ? join(opts.outDir, "behaviour.json") : BEHAVIOUR_JSON),
    // WHERE THE ANSWERING TURN WRITES, and the one property that matters about
    // it: it is outside `.claude/`. Derived from the repo rather than from
    // config.mjs, because config.mjs's every path is under `.claude/` by
    // design, and that is the directory the harness refuses.
    answersDir: answersDir(repo, opts),
    // WHERE `notes.mjs` PUTS WHAT IT WRITES, and the only thing this step reads
    // out of it is the receipt directory (D75, `noteSubmissionConsumed`). It is
    // NOT derived from `opts.outDir` the way the artifacts above are: the
    // receipts are written by a SPAWNED `notes.mjs`, which resolves its own
    // `NOTES_DIR` off config.mjs unless it is given `--dir`, and `notesArgv`
    // gives it none. A path rebuilt out of a redirected `outDir` here would
    // have this step looking for receipts where the tool does not leave them,
    // which reads as "nothing has ever been consumed" — the safe direction, but
    // silently the old behaviour. `opts.notesDir` is for a test that redirects
    // both ends together.
    notesDir: opts.notesDir ?? NOTES_DIR,
    tool: (name) => join(pilotDir, name),
    exec: opts.exec ?? runTool,
  };
}

/**
 * Run one of the pipeline's own tools and hand back what it said.
 *
 * `spawnSync` and not `execSync`: the skeleton of a large service is hundreds of
 * kilobytes of JSON on stdout, and a shell in the middle of that buys nothing
 * and can mangle it. The buffer cap is raised for the same reason — the default
 * 1 MB truncates the skeleton of a repo with 945 uncovered rows, and a
 * truncated skeleton parses as a JSON error rather than as the silence it is.
 */
function runTool(script, args, { cwd, env } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd,
    // Undefined means "inherit", which is what every caller but
    // verify-on-write wants. That one passes this process's environment plus
    // the single variable that moves the recorder's output, and nothing else:
    // every flag record.mjs acts on still comes from the operator.
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
  };
}

/**
 * The tool failed, said so on stderr, and this is that sentence.
 *
 * Quoted rather than summarised. worklist.mjs exits 3 when stage 3 is past its
 * time budget with unrecorded proposals, and that stderr NAMES THE NEXT MOVE
 * (`npm run pilot:record`). A step that swallowed it and reported "could not
 * build the brief" would turn an instruction into a mystery.
 */
function toolFailure(label, script, res) {
  if (res.error) return `${label}: ${relative(REPO_ROOT, script) || script} could not be run — ${res.error.message}`;
  const said = (res.stderr || res.stdout).trim().split("\n").slice(-6).join("\n      ");
  return `${label}: ${relative(REPO_ROOT, script) || script} exited ${res.status}${said ? `\n      ${said}` : ""}`;
}

/**
 * Every side some proposal's `reaches` names, keyed by side.
 *
 * `held` is the quarantine — see `quarantineRows` below. A row in it is a row
 * validate.mjs refused, and its `reaches` MUST NOT reach this map: `ledger.mjs`
 * counts a side accounted the moment `proposed.has(k)` is true, so a refused
 * row left in here is a side that reads as answered while contributing no test.
 * That is a false coverage number, and a false number is worse than a stall
 * because the stall is visible in the log and the number is not.
 */
export function proposedSides(proposalsDir, labelsByArm, held = null) {
  const proposed = new Map();
  if (!existsSync(proposalsDir)) return proposed;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json"))) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      // A proposal file nobody can parse is validate.mjs's error to raise, and
      // it does raise it. Here it must not silently make its sides look
      // answered: skipping the file leaves them open, so they are asked about.
      continue;
    }
    for (const [at, p] of (doc.proposals ?? []).entries()) {
      // QUARANTINED, and therefore not an answer to anything. The row stays on
      // disk — nothing here removes it — it simply stops speaking for its side.
      if (held?.has(rowKey(file, at))) continue;
      for (const [armId, sides] of Object.entries(p.reaches ?? {})) {
        for (const side of sidesOf(sides, labelsByArm.get(armId) ?? new Set())) {
          const k = sideKey(armId, side);
          if (!proposed.has(k)) proposed.set(k, []);
          proposed.get(k).push(`${file}::${p.id}`);
        }
      }
    }
  }
  return proposed;
}

/* --------------------------------------------------------------------------
 * QUARANTINE — ONE REFUSED ROW MUST NOT HOLD THE OTHER 145 SIDES
 *
 * THE DEFECT, run `20260916T165524Z`. At minute 102 the run had 146 of 146
 * sides accounted — 113 inputs, 33 written reasons — and then made no progress
 * for the rest of its life. `validate.mjs` judges the WHOLE proposals
 * directory and exits 1 if any row anywhere is wrong, `satisfied` required it
 * to exit 0, so `derive` could not close and `record`, `emit`, `measure` and
 * `repair` never ran. The answering turn's only move was to get every row in
 * every file simultaneously correct; it resubmitted, the refusal came back
 * naming DIFFERENT rows in the file it had just rewritten, and the mole count
 * did not trend to zero because each resubmission was a fresh chance to write
 * a bad row. The run's log ends with the agent computing Levenshtein distances
 * over file names, which is what an agent with no convergent move left does.
 *
 * THE FIX IS NOT A SOFTER VALIDATOR. `validate.mjs` is not modified and its
 * verdicts are not weakened: a row it refuses stays refused. What changes is
 * what THIS STEP does with the refusal. The refused rows are set aside, the
 * rows that validated are left to land, and `derive` closes on those — so the
 * run advances every round instead of never.
 *
 * AND A ROW SET ASIDE IS NOT A ROW ANSWERED. Its side comes straight back into
 * the brief as an open question. That is the whole safety property, and it is
 * the opposite direction from the obvious mistake: `ledger.mjs` counts a side
 * accounted from `reaches` alone, so a quarantined row still counted would be
 * a 100% that nothing measured. Every ambiguity below therefore resolves
 * towards holding MORE rows, never fewer — an over-held row costs one more
 * question, an under-held one costs the number's meaning.
 *
 * WHERE VALIDATE'S OWN ADDRESS IS WRONG, and this one cost the run directly.
 * `validate.mjs:497` builds `${p._file}[${i}]` out of `list.entries()`, and
 * `list` is `loadProposals`'s FLAT concatenation across every file in the
 * directory (validate.mjs:310 flatMaps it). So the file name is the row's own
 * and the index is into the whole directory. On that run the item read
 * `matchingLocations.proposals.json[51]` while that file held 15 proposals:
 * an agent sent to row 51 of a 15-row file finds nothing, which is a complete
 * explanation for why that one fault survived every round. This step cannot
 * fix the printer, so it re-addresses the fault instead — the flat index is
 * resolved back to a file and a row, and the item prints both, with the
 * proposal id, which is the only address that was never ambiguous.
 * ------------------------------------------------------------------------ */

/** One row's address, and the only key the quarantine is held under. */
export const rowKey = (file, at) => `${file}#${at}`;

/**
 * Every finding validate.mjs printed, parsed out of its own bytes.
 *
 * Both markers, because both are faults the run has to clear: `✗` is what makes
 * it exit 1 and `!` is what `gate.mjs` fails on (it matches /warnings\s+(\d+)/
 * and accepts only zero — validate.mjs:1078 says so). `·` is not read: the tool
 * calls advisories its own blind spots and prints them as reported, not gating.
 *
 * THE WHOLE OUTPUT, not `toolFailure`'s tail. `toolFailure` keeps the last six
 * lines because a tool's closing sentence is usually its instruction; here that
 * is exactly wrong, because validate.mjs prints warnings, then errors, then a
 * clock banner, and six lines of a forty-line refusal is one bad proposal
 * hiding the others.
 */
const FAULT_LINE = /^[ \t]+(✗|!)[ \t]+(.*\S)[ \t]*$/;

export function validateFaults(res) {
  const faults = [];
  const text = `${res?.stdout ?? ""}\n${res?.stderr ?? ""}`;
  for (const line of text.split("\n")) {
    const m = FAULT_LINE.exec(line);
    if (!m) continue;
    faults.push({ severity: m[1] === "✗" ? "error" : "warning", line: m[2], ...faultAddress(m[2]) });
  }
  return faults;
}

/**
 * The row a finding is about, read off the address validate.mjs printed.
 *
 * Returns `{ file, index, proposal, at, why }`, all nullable. `index` is kept
 * as VALIDATE PRINTED IT — flat across the directory — and is resolved to a row
 * in `locateFault`, never silently reinterpreted as a position within `file`.
 */
export function faultAddress(text) {
  const head = /^(\S+\.json)\[(\d+)\]/.exec(text);
  if (!head) {
    // `<file> is not readable JSON: ...`, pushed before any row is indexed.
    const bad = /^(\S+\.json) is not readable JSON:/.exec(text);
    return { file: bad ? bad[1] : null, index: null, proposal: null, at: null, why: text };
  }
  let rest = text.slice(head[0].length);
  let proposal = null;
  const id = /^\s*\(([^)]*)\)/.exec(rest);
  if (id) {
    proposal = id[1];
    rest = rest.slice(id[0].length);
  }
  // The FIRST `: ` ends the address. A message can carry colons of its own
  // (`driver src/server.ts:20:start declares 0`), so splitting on the last one
  // would cut the sentence in half.
  const colon = rest.indexOf(": ");
  const at = (colon === -1 ? rest : rest.slice(0, colon)).trim();
  return {
    file: head[1],
    index: Number(head[2]),
    proposal: proposal || null,
    at: at || null,
    why: colon === -1 ? text : rest.slice(colon + 2),
  };
}

/**
 * Every proposal row on disk, in the order validate.mjs indexes them.
 *
 * Deliberately the same walk as `validate.mjs:loadProposals` — sorted file
 * names, `doc.proposals ?? []` flattened in order, an unparseable file
 * contributing nothing — because the flat index only resolves if the two walks
 * agree. They are checked against each other in `locateFault`: a row whose file
 * name does not match the one validate printed is a disagreement, and the fault
 * falls back to an address that cannot drift.
 */
export function flatProposals(proposalsDir) {
  const rows = [];
  if (!existsSync(proposalsDir)) return rows;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      continue;
    }
    // `covers` comes along because it is the LEGAL `from.arm` SET for that row
    // — `checkEvidence` decides with `covers.includes(evidence.arm)` — and a
    // repair round has no skeleton to pre-fill it from, so the row on disk is
    // the only place it exists.
    (doc.proposals ?? []).forEach((p, at) =>
      rows.push({ file, at, id: p?.id ?? null, reaches: p?.reaches ?? {}, covers: [...(p?.covers ?? [])] })
    );
  }
  return rows;
}

/**
 * The rows one fault condemns.
 *
 * BY ID FIRST, because the id is the one address in validate.mjs's message that
 * was never ambiguous, and the flat index is the one that was. Then the flat
 * index, but only when the row it lands on came from the file validate named.
 * Then, when neither places it, THE WHOLE FILE — a fault that cannot be pinned
 * to a row must hold every row of the file it names, because the alternative is
 * leaving the bad one counted.
 *
 * An empty result means the fault names no file at all. Nothing is quarantined
 * for it, and `judgeProposals` carries it as unplaced, where it holds the run.
 */
export function locateFault(fault, rows) {
  if (fault.proposal) {
    const byId = rows.filter((r) => r.id === fault.proposal);
    if (byId.length) return byId;
  }
  if (Number.isInteger(fault.index) && rows[fault.index] && (!fault.file || rows[fault.index].file === fault.file)) {
    return [rows[fault.index]];
  }
  if (fault.file) return rows.filter((r) => r.file === fault.file);
  return [];
}

/**
 * Which rows this round holds back, and which faults could not be placed.
 *
 * `held` is keyed by `rowKey` and carries the faults that condemned each row,
 * so the item can print the reason beside the address rather than leaving the
 * agent to match two lists.
 */
export function quarantineRows(faults, rows) {
  const held = new Map();
  const unplaced = [];
  for (const fault of faults) {
    const hit = locateFault(fault, rows);
    if (!hit.length) {
      unplaced.push(fault);
      continue;
    }
    for (const row of hit) {
      const k = rowKey(row.file, row.at);
      if (!held.has(k)) held.set(k, { ...row, faults: [] });
      held.get(k).faults.push(fault);
    }
  }
  return { held, unplaced };
}

/* ------------------------------------------------------------------------ *
 * ONE ROW ID IN TWO FILES IS DECIDED, OR IT IS ASKED - NEVER LEFT TO HOLD.
 *
 * `validate.mjs` refuses every copy of an id it has already seen as
 * `duplicate id`, and `locateFault` places that fault by id, so EVERY copy is
 * quarantined. That is the agent's mistake and it is honest to set the copies
 * aside, but it was not a decision: nothing said which copy to keep, and when
 * the side the copies named was covered by another row nothing asked either.
 *
 * MEASURED, email-centralization-ms, the evening run of 25 September. A
 * recorder outcome for `parseProviderValue-46-if-0` (a row of
 * answers-ffcef063db98.json) was handed over under a fresh name
 * (answers-fc411f67279c.json, see `soloHeader`), the worker repaired the row
 * there under the same id, and both copies were quarantined. The side was
 * covered by a third row, so the validate item was asked once, the agent's
 * turn was lost to a 429, and every later walk ruled `derive` a tool DEFECT
 * with 1615/1629 sides hit and every other side ruled.
 *
 * THE RULE, in order:
 *   1. the copies are the SAME ROW (`sameRow`): keep one - the one the
 *      recorder recorded, else the one it would record (the later file, the
 *      way record.mjs keys a duplicated id) - and set the rest aside;
 *   2. one copy was RECORDED AND VERIFIED - behaviour.json's row for the id
 *      came from that file, coverage.json verified the id and found nothing
 *      false, and the file has not been written since the recording: keep it;
 *   3. otherwise nothing measured says which copy was meant, and the choice is
 *      a precise question to the agent (`duplicateIdProblems`), with every copy
 *      still set aside until it is answered.
 * A kept copy is released from the quarantine and counts again; the copies set
 * aside stay on disk, held, exactly as a refused row always has.
 * ------------------------------------------------------------------------ */

const DUPLICATE_ID = /^duplicate id "([\s\S]*)"$/;

/** The id a `duplicate id` fault is about, or null for any other fault. */
export const duplicateIdOf = (fault) => DUPLICATE_ID.exec(String(fault?.why ?? "").trim())?.[1] ?? null;

/**
 * What the recording and the measurement say about ids, for rule 2.
 *
 * Empty sets when either is absent or unreadable - the safe reading, since an
 * empty set decides nothing. A measurement over a red suite decides nothing
 * either, the rule `ledger.doubleClaimEvidence` keeps.
 */
export function duplicateEvidence(paths) {
  const out = { recorded: new Map(), recordedAtMs: null, verified: new Set(), falseIds: new Set() };
  try {
    const behaviour = join(paths.outDir, "behaviour.json");
    const doc = JSON.parse(readFileSync(behaviour, "utf8"));
    for (const r of doc?.rows ?? []) if (r?.id && r.file && !out.recorded.has(r.id)) out.recorded.set(r.id, r.file);
    out.recordedAtMs = statSync(behaviour).mtimeMs;
  } catch {
    // no recording yet
  }
  try {
    const cov = JSON.parse(readFileSync(paths.coverageJson, "utf8"));
    if (cov?.suitePassed !== false && cov?.refused !== "suite-did-not-pass") {
      for (const v of cov.verified ?? []) if (v?.id) out.verified.add(v.id);
      for (const f of cov.falseClaims ?? []) if (f?.id) out.falseIds.add(f.id);
    }
  } catch {
    // no measurement yet
  }
  return out;
}

/** The top-level fields two rows disagree on, by name. */
function differingFields(rows) {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].sort();
  return keys.filter((k) => new Set(rows.map((r) => JSON.stringify(r?.[k] ?? null))).size > 1);
}

/**
 * The decision for one duplicated id: `{ id, copies, keep, how, why }`.
 *
 * `copies` are `{ file, at, row }` in validate.mjs's order. `keep` is one of
 * them, or null when the choice is the agent's. `writtenAtMs(file)` is when a
 * proposals file was last written, or null.
 */
export function duplicateIdVerdict(id, copies, evidence = {}, { writtenAtMs = () => null } = {}) {
  const recordedFile = evidence.recorded?.get(id) ?? null;
  if (copies.length > 1 && copies.every((c) => c.row && sameRow(c.row, copies[0].row))) {
    const keep = copies.find((c) => c.file === recordedFile) ?? copies[copies.length - 1];
    return {
      id, copies, keep, how: "identical",
      why:
        `the ${copies.length} copies are the same row, so the one in ${keep.file} is kept ` +
        `(${keep.file === recordedFile ? "the copy record.mjs recorded" : "the copy record.mjs records, from the later file"}) ` +
        `and the rest are set aside`,
    };
  }
  const recorded = copies.find((c) => c.file === recordedFile) ?? null;
  const written = recorded ? writtenAtMs(recorded.file) : null;
  const fresh = evidence.recordedAtMs != null && written != null && written <= evidence.recordedAtMs;
  if (recorded && evidence.verified?.has(id) && !evidence.falseIds?.has(id) && fresh) {
    return {
      id, copies, keep: recorded, how: "recorded",
      why:
        `the copy in ${recorded.file} is the one record.mjs recorded and coverage.json verified, and the file has not ` +
        `been written since, so it is kept and the rest are set aside`,
    };
  }
  const differs = differingFields(copies.map((c) => c.row));
  return {
    id, copies, keep: null, how: null,
    why:
      `the copies differ (${differs.join(", ") || "in their bytes"}) and none of them is a recorded row coverage.json ` +
      `verified${recorded ? ` (${recorded.file}'s copy was recorded, but ${fresh ? "its claims were not verified" : "the file changed after the recording"})` : ""}, ` +
      `so nothing measured says which one was meant`,
  };
}

/**
 * Every `duplicate id` fault, decided — and the quarantine corrected for the
 * copies kept. Mutates `held`: a kept copy whose only fault was the duplicate
 * is released. Returns the verdicts.
 */
export function decideDuplicates(faults, rows, held, paths) {
  const byId = new Map();
  for (const f of faults) {
    const id = duplicateIdOf(f);
    if (id === null) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(f);
  }
  if (!byId.size) return [];
  const docs = new Map();
  const rowAt = (file, at) => {
    if (!docs.has(file)) {
      try {
        const doc = JSON.parse(readFileSync(join(paths.proposalsDir, file), "utf8"));
        docs.set(file, Array.isArray(doc) ? doc : (doc?.proposals ?? []));
      } catch {
        docs.set(file, []);
      }
    }
    return docs.get(file)[at] ?? null;
  };
  const evidence = duplicateEvidence(paths);
  const writtenAtMs = (file) => {
    try {
      return statSync(join(paths.proposalsDir, file)).mtimeMs;
    } catch {
      return null;
    }
  };
  const verdicts = [];
  for (const [id, own] of byId) {
    const copies = rows.filter((r) => r.id === id).map((r) => ({ file: r.file, at: r.at, row: rowAt(r.file, r.at) }));
    if (copies.length < 2) continue;
    const verdict = duplicateIdVerdict(id, copies, evidence, { writtenAtMs });
    verdict.rowsInFile = Object.fromEntries(copies.map((c) => [c.file, docs.get(c.file)?.length ?? 0]));
    if (verdict.keep) {
      const k = rowKey(verdict.keep.file, verdict.keep.at);
      const h = held.get(k);
      if (h) {
        h.faults = h.faults.filter((f) => !own.includes(f));
        if (!h.faults.length) held.delete(k);
      }
    }
    verdicts.push(verdict);
  }
  return verdicts;
}

/* ------------------------------------------------------------------------ *
 * THE CHECKPOINT — VALIDATE ONE SCENARIO BEFORE BUILDING A FAMILY ON IT.
 *
 * THE DEFECT, measured. Round 2 of run `20260916T223906Z` ran 113 minutes and
 * $28.02, and then `validate.mjs` reported 353 faults and quarantined 99 of 135
 * rows — 95 of them sharing ONE structural fault. The agent wrote 135 rows
 * before anything told it whether ONE was acceptable. The cost is not the bad
 * rows; it is that the same wrong shape was paid for 95 times.
 *
 * WHAT THE CHECKPOINT IS. Submit ONE representative scenario, in its own file,
 * before writing the rest. The next thing that happens to it is exactly what
 * happens to a full submission: `propose.mjs` puts the document in,
 * `validate.mjs` judges the result, and — where verify-on-write is on —
 * `record.mjs` runs that one row. Then expand what PASSED.
 *
 * ASKING IS NOT ADVANCING, AND THAT DISTINCTION IS WRITTEN DOWN HERE SO THE
 * NEXT READER DOES NOT TAKE THIS AS A LICENCE. The refusal that must not be
 * crossed is running `pilot:*` or the tools in `.claude/charpilot/`, because
 * those ADVANCE STATE: they record rows, they emit tests, they overwrite
 * measurements, and an agent that advances state has made the pipeline's own
 * account of the run disagree with the disk. Asking whether a document would be
 * ACCEPTED advances nothing — no row is recorded, no measurement is rewritten,
 * nothing is emitted. This is not "let the agent drive the pipeline", and it
 * grants no exception to `prompts.submit-never-run`: the agent still submits and
 * still runs nothing.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FAILS, and it is the only failure mode worth this much prose.
 *
 * THE VALUE IS ENTIRELY IN THE CHECKPOINT USING THE SAME CODE PATH `derive`
 * USES AT THE ROUND BOUNDARY. A second, friendlier checker that disagreed with
 * `validate.mjs` would be strictly worse than no checkpoint at all: the agent
 * expands a pattern that passed the pretend gate, fails the real one, and now
 * trusts the wrong signal — and it trusts it about the one thing it cannot
 * check itself. So there is no second checker. `CHECKPOINT_TOOL` and
 * `checkpointArgv()` are the ONLY spawn of the verdict in this file, and
 * `judgeProposals` is the only function that makes it: the checkpoint and the
 * round boundary are not two call sites that agree, they are one call site.
 *
 * AND THE INVISIBLE ONE: VALIDATION IS NOT EXECUTION EVIDENCE. A checkpoint
 * that reported "accepted" for a row the recorder cannot invoke teaches a
 * pattern that never records. That run has the case, in its own bytes:
 * `verify-on-write: parseAddressesForJd-113-default-arg-0 produced no row —
 * skipped: blocked egress: prisma.apiKey`. An accepted document is a document
 * whose SHAPE is right. Whether it runs is a different question with a
 * different tool, and the checkpoint says which of the two it answered.
 * ------------------------------------------------------------------------ */

/**
 * THE TOOL THAT GIVES THE VERDICT is `CHECKPOINT_TOOL`, and it is imported from
 * `handover.mjs` and re-exported at the top of this file rather than declared
 * here, so `repair` names the same tool without holding a second copy of it.
 *
 * Every other mention of validate.mjs in this file is a different question —
 * `--schema` prints vocabularies, `satisfied` asks whether it is installed — and
 * neither is a verdict on a document. That constant is the verdict, and a test
 * fails if a second spawn of it appears anywhere in this file.
 */

/**
 * The verdict's whole command line: no flags at all.
 *
 * `validate.mjs` with no arguments judges the WHOLE proposals directory, which
 * is what makes one scenario's verdict the same verdict the round boundary
 * gives it — a flag that narrowed it to the new file would be the second,
 * friendlier checker with the same tool's name on it.
 */
export function checkpointArgv() {
  return [];
}

/**
 * WHAT THE CHECKPOINT IS, on every item of the round, is `CHECKPOINT` — prose
 * and not numbers, so `SHARED_BLOCKS` writes it once per packet file. It lives
 * in `handover.mjs` and is re-exported at the top of this file, because a
 * `repair` packet carries the same sentences and a second copy of them is the
 * drift this codebase argues against.
 */

/**
 * Run the tool that judges proposals, and read its verdict into rows.
 *
 * Returns `{ ran, status, res, faults, held, unplaced, rows }`. `ran: false`
 * when there is nothing to judge or no tool installed — an absent judgement
 * quarantines nothing and holds nothing, which is the state a repo with no
 * proposals is already in.
 */
export function judgeProposals(repo, paths) {
  const empty = { ran: false, status: 0, res: null, faults: [], held: new Map(), unplaced: [], rows: [], unmeasurable: NOTHING_UNMEASURABLE, duplicates: [] };
  const script = paths.tool(CHECKPOINT_TOOL);
  if (!existsSync(script) || !existsSync(paths.proposalsDir)) return empty;
  const res = paths.exec(script, checkpointArgv(), { cwd: repo });
  const rows = flatProposals(paths.proposalsDir);
  // D51, AND IT IS ASKED WHETHER OR NOT validate.mjs REFUSED. A row that
  // validates perfectly and claims a side istanbul recorded no hit on is the
  // exact shape of run 20260919T104903Z's rounds 3 and 5: nothing here would
  // have set it aside, because the tool that judges documents was never the
  // tool that could see it.
  const unmeasurable = unmeasurableHeld(unmeasuredClaims(paths.coverageJson), rows);
  if (res.status === 0) return { ...empty, ran: true, res, rows, unmeasurable, script };
  const faults = validateFaults(res);
  const { held, unplaced } = quarantineRows(faults, rows);
  // After the quarantine and against it: a copy the rule keeps is released.
  const duplicates = decideDuplicates(faults, rows, held, paths);
  return { ran: true, status: res.status, res, faults, held, unplaced, rows, unmeasurable, script, duplicates };
}

/**
 * The claims the last measurement could not measure, off its own join.
 *
 * Absent or unparseable is "nothing was refused", which is the safe reading
 * here: nothing is held, and `measure` is the step that refuses on a join it
 * cannot read.
 */
export function unmeasuredClaims(path) {
  if (!path || !existsSync(path)) return [];
  try {
    return unmeasurableRows(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------ *
 * D64 — A SIDE THE RECORDER REFUSED TO EXERCISE STOPS BEING DEALT, AND STAYS
 * UNCOVERED.
 *
 * MEASURED, run `20260919T142723Z`. Round 2's own log:
 *
 *   verify-on-write: parseAddressesForJd-113-default-arg-0 produced no row —
 *                    skipped: blocked egress: prisma.apiKey
 *
 * `parseAddressesForJd` reaches a real database, so in `CHARPILOT_MODE=mocked`
 * the recorder will not invoke it and its five sides have no deliverable
 * answer in this mode. They were dealt in every round from 2 to 8 anyway, and
 * in round 4 two workers answered the same unanswerable thing and both rows
 * were quarantined as duplicates. Five of that run's sixteen remaining sides
 * are these, and the last three rounds of the run ran with zero child turns.
 *
 * WHAT THIS IS NOT, and the distinction is the whole of it. It is NOT the dead
 * export correction. `deadcode.mjs` takes sides out of the DENOMINATOR because
 * the code is not live; this takes sides out of the OPEN LIST while they stay
 * in the denominator, uncovered, counted as missed, with the recorder's reason
 * attached. The reported rate does not move by a hundredth — `coverage.mjs`
 * computes every total before it marks a single row, and
 * `derive.a-side-the-recorder-refused.test.mjs` asserts the two documents are
 * numerically identical. A side that left the denominator because nobody
 * exercised it would raise the rate by hiding live code, which is the fraud
 * `correctedDenominator` exists to prevent.
 *
 * IT IS ALSO NOT AN ANSWER. A proposal answers a side and a BLOCKED.md entry
 * declares one; this does neither. Nobody has written anything, nothing is
 * claimed about reachability, and the ledger is not told the side is
 * accounted for. The only thing that changes is that the round stops paying
 * workers to rediscover a sentence the recorder already wrote.
 *
 * SELF-CLEARING, AND THAT IS WHY IT IS READ FROM HERE. The set is `coverage.json`'s
 * own rows — the join, re-derived by every measurement out of that round's
 * recording — exactly as D51's quarantine is. Nothing is stored, so there is no
 * state to clear: the day a double for `prisma.apiKey` lands, the recording
 * carries no skip, the measurement marks no row, this map is empty, and the
 * five sides are dealt again the same round without anybody withdrawing
 * anything. A declaration taken from a reason cannot outlive the reason.
 *
 * WHAT IT COSTS IF IT IS WRONG. An over-marked side is a side nobody is asked
 * about that somebody could have answered — coverage lost, visible in
 * `undeliverableSides` and in `result.json`'s `missing`, and recoverable the
 * moment the recorder stops refusing it. So the classification is the
 * recorder's own (`skipDiagnosis`, at the one place it lives) and only its
 * `toolset` verdicts reach here; a reason nobody classified leaves the side
 * open.
 *
 * THE REAL REMEDY FOR THESE FIVE IS A DOUBLE FOR `prisma.apiKey` so the
 * recorder can invoke the function. That is a gap in this repo's mocked-mode
 * fixture, not a defect in the pipeline. This only stops the pipeline paying
 * rounds to rediscover it.
 * ------------------------------------------------------------------------ */

/**
 * The sides the last measurement marked undeliverable, keyed like the open
 * list.
 *
 * Absent or unparseable is "the recorder refused nothing", which is the safe
 * reading and the same one `unmeasuredClaims` takes: the sides stay open and
 * get asked. `measure` is the step that refuses on a join it cannot read.
 */
export function undeliverableIndex(path) {
  const index = new Map();
  if (!path || !existsSync(path)) return index;
  let rows;
  try {
    rows = undeliverableRows(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return index;
  }
  for (const row of rows) index.set(sideKey(row.armId, row.side), row);
  return index;
}

/**
 * D46 — THE SIDES THE LAST MEASUREMENT COVERS, which no question is about.
 *
 * The work list is built from the existing suite's report, the round BEFORE
 * these inputs ran, so it can list a side as uncovered that the generated suite
 * now covers. When no row still CLAIMS such a side, `openSides` used to deal
 * it as open anyway. turing-integration-ms, 26 September: the claims on the two
 * `"cv"` fallbacks of cvStorage.service.ts#62 were withdrawn while the rows'
 * tests were still skipped. Once the tests ran, the rows covered both sides,
 * and every walk still asked "what does the collaborator do on the run that
 * takes \"cv\"?" about two covered sides. ledger.mjs made the same mistake
 * and failed the run on it.
 *
 * TWO FACTS, both read off disk and never stored: a recorded row MOVED the
 * side (behaviour.json `armsMoved`), and a measurement over a green suite does
 * not list it in `stillUncovered`. Absence from that list alone is not enough,
 * because an arm id the measurement never heard of is absent too. An empty set
 * when either document is missing, unreadable, refused or red.
 */
export function measuredCoveredIndex(coveragePath, behaviourPath) {
  const covered = new Set();
  if (!coveragePath || !behaviourPath || !existsSync(coveragePath) || !existsSync(behaviourPath)) return covered;
  let cov;
  let beh;
  try {
    cov = JSON.parse(readFileSync(coveragePath, "utf8"));
    beh = JSON.parse(readFileSync(behaviourPath, "utf8"));
  } catch {
    return covered;
  }
  if (!cov?.totals || !Array.isArray(cov.stillUncovered) || cov.refused || cov.suitePassed === false) return covered;
  const uncovered = new Set(cov.stillUncovered.map((u) => sideKey(u.armId, u.side)));
  for (const row of beh?.rows ?? []) {
    for (const m of row.armsMoved ?? []) {
      for (const side of m.sides ?? (m.side ? [m.side] : [])) {
        const k = sideKey(m.armId, side);
        if (!uncovered.has(k)) covered.add(k);
      }
    }
  }
  return covered;
}

/**
 * The one sentence a round says about them, naming the recorder's own words.
 *
 * It names the reasons rather than the sides, because the sides are five
 * addresses of one fact and the fact is what a reader has to act on: the
 * repair is a double in the fixture, and it is the same repair for all five.
 */
export function undeliverableSaid(rows) {
  const reasons = [...new Set(rows.map((r) => r.verdict?.why ?? r.why).filter(Boolean))];
  return (
    `${rows.length} side(s) are NOT dealt this round: the recorder refused to exercise their function and said why, ` +
    `in ${reasons.length} distinct reason(s) — ${reasons.map((r) => JSON.stringify(r)).join("; ")}. ` +
    `They stay UNCOVERED and stay in the denominator, so the rate does not move; ` +
    `\`result.json\` names them under \`missing\`. Nothing here declares them unreachable, and nothing is stored: ` +
    `the day the recorder records one of them, the next measurement carries no reason and the side is dealt again.`
  );
}

/** The shape `unmeasurableHeld` returns when there is nothing to hold. */
const NOTHING_UNMEASURABLE = Object.freeze({ claims: [], held: new Map(), unplaced: [] });

/**
 * The rows the last measurement condemned, as a quarantine keyed like the
 * other one.
 *
 * BY ID AND BY ID ONLY. `locateFault`'s ladder exists because validate.mjs
 * prints a flat index that has to be resolved back to a row; a coverage claim
 * carries the proposal id and nothing else, and the id is the address that was
 * never ambiguous. A claim naming a row that is not on disk any more is
 * `unplaced` — the agent already removed or replaced it, which is the outcome
 * this quarantine exists to provoke — and nothing is held for it.
 *
 * EVERY COPY OF A DUPLICATED ID IS HELD, which is `quarantineRows`'s own rule
 * for the same reason: an over-held row costs one more question and an
 * under-held one costs the number's meaning.
 */
export function unmeasurableHeld(claims = [], rows = []) {
  const held = new Map();
  const unplaced = [];
  for (const claim of claims) {
    const hit = rows.filter((r) => r.id === claim.id);
    if (!hit.length) {
      unplaced.push(claim);
      continue;
    }
    for (const row of hit) {
      const k = rowKey(row.file, row.at);
      if (!held.has(k)) held.set(k, { ...row, faults: [] });
      held.get(k).faults.push({
        severity: "error",
        line: `${claim.id}: ${claim.why}`,
        why: claim.why,
        file: row.file,
        index: null,
        proposal: claim.id,
        at: claim.armId ?? null,
        // WHICH TOOL SAID SO, on the fault itself. A reader of a held row has
        // to be able to tell "the document is wrong" from "the document is
        // fine and the measurement disagrees with it", because those are two
        // different repairs.
        by: "coverage.mjs",
      });
    }
  }
  return { claims, held, unplaced };
}

/**
 * BOTH QUARANTINES AS ONE MAP, which is the only form `proposedSides` takes.
 *
 * Kept as two up to this point on purpose: `quarantineDid` prints
 * "validate.mjs exited N — F fault(s); H row(s) QUARANTINED", and a sentence
 * that counted rows validate.mjs never refused would be false about the tool it
 * names. They are one thing only where the question is "does this row still
 * answer its side", and the answer there is the same for both: it does not.
 */
export function allHeld(judgement) {
  const merged = new Map(judgement?.held ?? []);
  for (const [k, row] of judgement?.unmeasurable?.held ?? []) {
    if (!merged.has(k)) merged.set(k, { ...row, faults: [] });
    merged.get(k).faults.push(...row.faults);
  }
  return merged;
}

/** Every side a `blocked` entry declares, keyed by side. */
export function declaredSides(proposalsDir, labelsByArm) {
  const declared = new Map();
  const path = join(proposalsDir, "BLOCKED.md");
  if (!existsSync(path)) return declared;
  // `null` for the caller set on purpose: it changes only which ERRORS the
  // parser reports, never which entries it returns, and the errors belong to
  // `pilot:ledger`. What is needed here is the arm/side pairs a person has
  // already written a reason for.
  const { entries } = blockedEntries(readFileSync(path, "utf8"), null);
  for (const e of entries) {
    for (const side of sidesOf(e.side, labelsByArm.get(e.arm) ?? new Set())) {
      declared.set(sideKey(e.arm, side), e);
    }
  }
  return declared;
}

/* ------------------------------------------------------------------------ *
 * SUBMISSION — how an answer reaches the disk without the agent writing it.
 *
 * THE DEFECT, and it was a contradiction the brief itself carried. Run
 * `20260916T112101Z` looped three rounds over the same ten sides reporting
 * `0 has a written reason` every time, and every link of that is checkable:
 * the deriving prompt forbids running "any other tool in `.claude/charpilot/`",
 * which bans blocked.mjs; blocked.mjs is the only sanctioned writer of
 * BLOCKED.md; so the agent hand-wrote the file and said so in the log; a
 * hand-written fence is not tagged ```blocked, and ledger.mjs's FENCE regex
 * matches only that tag; so the side stayed unaccounted for ever. The same run
 * spent 34.6 minutes and $3.80 in round 1 and wrote nothing at all, because
 * every attempt to write into `.claude/charpilot/proposals/` was refused —
 * `docker/settings.json` allows `Write(.claude/**)`, and the refusal is above
 * it, because `.claude/` is the agent harness's own directory.
 *
 * ONE MECHANISM ANSWERS BOTH, and it does not loosen the rule that removed 193
 * calls and 55.4 minutes of contract lookup from run `20260916T031317Z`. The
 * agent still drives nothing and still runs no tool. It SUBMITS — a file in a
 * directory it can write, outside `.claude/` — and this step materialises it by
 * spawning the tool that owns the format: `blocked.mjs` for a declaration,
 * `propose.mjs` for a proposal document, then `validate.mjs` over the result.
 * There is no exception for blocked.mjs in either prompt, because the agent
 * does not need one.
 *
 * A SUBMISSION IS REFUSED IN THE SAME ROUND, NEVER AT THE END OF ONE. Every
 * check below produces a pending item naming the field and the file; nothing
 * here throws. A refusal that ended the step would turn one mistyped `killer`
 * into a dead run, which is strictly worse than the defect it replaces.
 *
 * AND NOTHING HERE FILLS A SLOT. novalues.mjs states the rule this step is
 * built on — a brief states a parameter's NAME and TYPE and never a VALUE — and
 * the mirror of it is that a renderer never completes an answer either. A
 * fabricated value passes validate.mjs, because provenance is checked on the
 * values that exist. So an incomplete submission is REFUSED and named, and a
 * missing `proof` is never defaulted to anything.
 * ------------------------------------------------------------------------ */

/**
 * WHERE THE ANSWERING TURN WRITES — `ANSWERS_DIRNAME`, `ANSWERS_ENV` and
 * `answersDir` — lives in `handover.mjs` and is re-exported at the top of this
 * file. The one thing that matters about that directory is that it is NOT under
 * `.claude/`: the harness refuses writes there, above the project allowlist,
 * and no setting in this repo can grant them. `repair` names the same directory
 * from the same constant, which is why a repair item now has a legal way to be
 * answered at all.
 */

/* ------------------------------------------------------------------------ *
 * CONCURRENT WRITERS INTO `charpilot-answers/`, AND THE ONE THING THAT MAKES
 * THEM SAFE.
 *
 * Once a packet is a unit of work, several readers are in that directory at
 * once. It is an ordinary directory: this step reads whatever is in it, and a
 * SECOND WRITE TO ONE NAME LOSES THE FIRST WITH NOTHING REPORTING IT. That is
 * the whole failure — not a conflict, not a merge, a file that is simply
 * shorter than the work that went into it — and downstream it reads as an agent
 * that answered fewer questions than it did, which is unattributable.
 *
 * TWO THINGS ARE DONE ABOUT IT AND NEITHER OF THEM REPAIRS ANYTHING.
 *
 *   PREVENTED where it can be. Each packet reserves one file name, derived from
 *   the packet's own id (`answerFileFor`), so two readers never compute the same
 *   name for different work. A file written under a reserved name that carries
 *   another packet's arms is REFUSED, because the only ways to reach that state
 *   are two writers on one name and one writer filing under another packet's
 *   name, and both are this failure.
 *
 *   MADE VISIBLE where it cannot. A round records how many proposals each
 *   reserved file carried, on that packet's own header; the next round compares.
 *   A file that SHRANK is a `submission` item naming the file and both counts.
 *   IT IS NOT REPAIRED AND NOT RECONSTRUCTED: a submission that vanished is a
 *   question for the agent that wrote it, and a step that quietly papered over
 *   it would be the step repairing a tool's output with nobody able to find it.
 *
 * THE HONEST LIMIT, said rather than left to be discovered: the census is kept
 * per RESERVED name, on the packet header that reserved it. A worker that
 * invents its own file name gets the collision refusal's protection (it cannot
 * collide with a reserved one) and not the census's, because there is no packet
 * to hang the previous count on. The whole round's census is printed in `did`
 * either way, so a disappearing file is at least in the log.
 * ------------------------------------------------------------------------ */

/**
 * Every `arm [side]` a submission answers: each proposal row's `reaches`, and
 * each declaration's arm and side. `covers` is left out because it names arms
 * without sides, and it is `reaches` that says which side a row answers.
 */
export function sidesAnswered(doc) {
  const out = new Set();
  for (const row of Array.isArray(doc?.proposals) ? doc.proposals : []) {
    for (const [arm, value] of Object.entries(row?.reaches ?? {})) {
      for (const side of Array.isArray(value) ? value : [value]) out.add(`${arm} [${side}]`);
    }
  }
  for (const d of Array.isArray(doc?.declarations) ? doc.declarations : []) {
    if (d?.arm && d?.side !== undefined) out.add(`${d.arm} [${d.side}]`);
  }
  return [...out].sort();
}

/** How much each submission file carried this round, by file name. */
export function answersCensus(dir) {
  const census = new Map();
  for (const file of readSubmissions(dir)) {
    const doc = file.doc;
    census.set(file.name, {
      file: file.name,
      proposals: Array.isArray(doc?.proposals) ? doc.proposals.length : 0,
      declarations: Array.isArray(doc?.declarations) ? doc.declarations.length : 0,
      parsed: !file.error,
      // PLAN 20 T2.1 P1: the sides the file answers, so a worker that merges two
      // rows while writing as it goes is not read as a lost write. Only with
      // the flag on, so the packet header is byte for byte unchanged without it.
      ...(incrementalAnswers() ? { sides: sidesAnswered(doc) } : {}),
    });
  }
  return census;
}

/** Every arm id a submitted proposal document names in `reaches`. */
export function armsClaimedIn(doc) {
  const arms = new Set();
  for (const p of doc?.proposals ?? []) for (const armId of Object.keys(p?.reaches ?? {})) arms.add(armId);
  return arms;
}

/**
 * The reason this file may not be written under this name, or null.
 *
 * `reserved` is `Map<fileName, { bundleId, sides }>` — the names the LAST round
 * handed out, read off its index. A name nothing reserved is not this scheme's
 * business and is left alone, which is the state every round before this one
 * was in.
 *
 * `landed` is every arm the proposals file ALREADY LANDED UNDER THIS SAME NAME
 * answers (`armsLandedUnder`). Those arms are not strangers, because the roster
 * names only the sides still OPEN, and a submission replaces its landed file
 * whole. A packet whose function had one side answered in an earlier round is
 * dealt again for the side that is left, under the same reserved name, and the
 * file its worker writes has to carry the answered row as well, or the replace
 * drops it. Counting that row as another packet's arm refused every
 * resubmission that kept it. The only way to be accepted was to drop the row,
 * and then the side it answered was open again. Assessment-service ran into
 * this on the twenty-fifth of September 2026: the side dealt swapped between
 * the two arms of `callInternalApi` for five rounds, its answer verified and
 * never landed, and three of those rounds counted as FAILED ROUNDS, which
 * closed stage 3. An arm that no file under this name has landed is still
 * refused, so a worker filing another packet's arms here is caught as before.
 */
export function nameCollision(name, doc, reserved, landed = null) {
  const held = reserved?.get(name) ?? null;
  if (!held) return null;
  const owns = new Set((held.sides ?? []).map((side) => String(side).replace(/\s*\[[\s\S]*\]\s*$/, "")));
  if (!owns.size) return null;
  const strangers = [...armsClaimedIn(doc)].filter((armId) => !owns.has(armId) && !landed?.has(armId));
  if (!strangers.length) return null;
  return (
    `${name} is the answer file reserved for ${held.bundleId}, and this document answers ${strangers.length} arm(s) ` +
    `that packet does not speak for (${strangers.slice(0, 4).join(", ")}${strangers.length > 4 ? ", …" : ""}). ` +
    `There are two ways to reach that and both are the same defect: two writers landed on one name, or one worker ` +
    `filed under another packet's name. A second write to one name LOSES THE FIRST SILENTLY and reads downstream as ` +
    `an agent that answered fewer questions than it did, so nothing here merges it and nothing here guesses which ` +
    `half survived. Write this packet's answers under its own reserved name — each packet's file is named in its own ` +
    `\`packet.answers.file\` — and resubmit whatever was lost.`
  );
}

/** Every arm the proposals file landed under `name` answers. Empty when there is none or it does not parse. */
export function armsLandedUnder(proposalsDir, name) {
  const path = proposalsDir && name ? join(proposalsDir, name) : null;
  if (!path || !existsSync(path)) return new Set();
  try {
    return armsClaimedIn(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return new Set();
  }
}

/** Every submission file, parsed, in name order. A parse failure is carried, not thrown. */
export function readSubmissions(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(dir, name);
    // The BYTES as well as the document. propose.mjs writes a submission
    // verbatim, so "this one is already on disk" is a byte comparison and never
    // a guess about ids — which is what lets a REPAIRED document, same ids and
    // different contents, be materialised again instead of read as a duplicate.
    let bytes = null;
    try {
      bytes = readFileSync(path, "utf8");
      out.push({ name, path, bytes, doc: JSON.parse(bytes), error: null });
    } catch (err) {
      out.push({ name, path, bytes, doc: null, error: err.message });
    }
  }
  return out;
}

/**
 * The fields a declaration carries. Exactly blocked.mjs's six plus its two
 * prose flags — NOT a seventh, because a field the format does not define is a
 * disposition this pipeline does not have.
 */
export const DECLARATION_FIELDS = Object.freeze(["arm", "side", "category", "killer", "proof", "fix", "heading", "why"]);
const DECLARATION_REQUIRED = Object.freeze(["arm", "side", "category", "killer", "proof"]);

/**
 * One submission entry's id.
 *
 * ADDRESS PLUS FINGERPRINT, and the fingerprint is load-bearing. `satisfied`
 * reads these ids back out of the handover to decide whether a refused
 * submission is a question already asked or one still to ask — the same
 * asymmetry it applies to an open side. Without the fingerprint an entry the
 * agent REPAIRED would keep the id it was refused under, `satisfied` would see
 * it in the handover, and the fix would never be materialised.
 */
export function answerId(file, at, entry) {
  const print = createHash("sha256").update(JSON.stringify(entry ?? null)).digest("hex").slice(0, 8);
  return `submission ${file}#${at} (${print})`;
}

/* ------------------------------------------------------------------------ *
 * D75(b) — A CACHE REPAIR MAY NOT HOLD A RUN OPEN.
 *
 * A note is navigation and never evidence: `notes.mjs` says so, `validate.mjs`
 * refuses a note as the source behind any claim, and nothing downstream of this
 * step — `record`, `emit`, `measure`, `repair`, `ruling`, `report` — reads one.
 * So a refused note submission cannot move `coverage_percentage` by a
 * hundredth. While a side is still open it is worth raising anyway: the round
 * that fixes it hands the next worker a warm file. Once NOTHING is open there
 * is no next worker, and the item is a question whose best possible answer
 * changes nothing about the run.
 *
 * Run `20260920T030124Z` spent rounds 6, 7, 8 and 9 — 2,231 seconds, a third of
 * the run, with `open=0` throughout — on exactly this, and then failed instead
 * of reporting 96.5% branches. Every item in all four rounds was a note.
 *
 * IT IS NOT A DROP AND IT IS NOT SILENT. The submission was materialised: what
 * verified is in the note, `notes.mjs` left a receipt carrying its own words
 * for what did not, and `did` below says how many were held and why. What stops
 * is the ASKING.
 *
 * A REFUSED PROPOSAL IS NOT THIS, and the distinction is the whole rule. A
 * proposal answers a side; a proposal refused after the open list emptied may
 * be an answer this run is about to throw away, and it goes on being asked
 * exactly as before. Only a kind that cannot close a side is held, and the kind
 * travels on the problem rather than being inferred from the tool that refused
 * it.
 * ------------------------------------------------------------------------ */

/** The submission kinds that cannot close a side, whatever they say. */
export const CACHE_ONLY_KINDS = Object.freeze(["notes"]);

/** `{ ask, held }` — which refusals are still worth another round. */
export function cacheOnly(problems, open) {
  if (open.length) return { ask: problems, held: [] };
  const ask = [];
  const held = [];
  for (const p of problems ?? []) (CACHE_ONLY_KINDS.includes(p?.kind) ? held : ask).push(p);
  return { ask, held };
}

/** A refusal, as the pending item that goes back in this round's handover. */
export function submissionItem(problem) {
  return {
    id: problem.id,
    kind: "submission",
    question:
      `${problem.file}#${problem.at}: ${problem.why} ` +
      `Fix the submission and the next round materialises it; every other item in this round is unaffected.`,
    file: problem.file,
    context: {
      submission: {
        file: problem.file,
        at: problem.at,
        // NAMED, because "malformed entry" is not an instruction and
        // "`killer` is not one of ..." is.
        field: problem.field ?? null,
        refusedBy: problem.by ?? null,
        why: problem.why,
        // The entry AS SUBMITTED. It is the agent's own text coming back, not a
        // value this step read off the repo, so the no-values rule is untouched
        // — and without it the agent has to open the file again to see what it
        // typed.
        submitted: problem.entry ?? null,
        // ONLY WHEN THERE IS ONE. A validation refusal carries the file to
        // resubmit and every fault against it; a refused declaration carries
        // neither, and a key spelled `null` on every other item is a field the
        // reader has to decide to ignore (workflow.mjs:55 states the rule).
        ...(problem.resubmit ? { resubmit: problem.resubmit } : {}),
        ...(problem.faults ? { faults: problem.faults } : {}),
        // THE MOVE THIS ITEM IS MOST OFTEN ANSWERED WITH, AND IT IS THE WRONG
        // ONE. A fault names rows; the locally sensible repair is to drop them
        // so the file validates. But the write replaces the document WHOLE, so
        // the file that comes back is also missing every row the fault did NOT
        // name, and their sides return next round as items nobody answered.
        // Run 20260917T082737Z did this in rounds 2, 3 and 4 and was handed a
        // byte-identical `7 packets, 34 items` each time: 41 minutes and $8.94
        // for no progress, with the round reporting every item answered.
        ...(problem.resubmit
          ? {
              keepSiblings:
                "DO NOT REMOVE THE REFUSED ROWS TO MAKE THIS FILE PASS. They are already quarantined — they stay " +
                "on disk, stop counting as an answer, and their sides are back in the brief, so the round advances " +
                "on the rows that validated without you doing anything. Your next write REPLACES THIS DOCUMENT " +
                "WHOLE, so a resubmission with those rows trimmed out is also missing every other row this file " +
                "carried, and all of those sides come back next round unanswered. Either resubmit the whole " +
                "document with the named rows FIXED IN PLACE, or submit nothing for this file and let the " +
                "quarantine hold them.",
            }
          : {}),
      },
    },
  };
}

/** A string that blocked.mjs can carry in one field, or the reason it cannot. */
function fieldProblem(name, value) {
  if (value === undefined || value === null) return `\`${name}\` is missing`;
  if (typeof value !== "string") return `\`${name}\` is ${JSON.stringify(value)}, which is not a string`;
  if (!value.trim()) return `\`${name}\` is empty — an empty field is not a field`;
  if (name !== "why" && value.includes("\n")) return `\`${name}\` must be one line: ledger.mjs reads one field per line`;
  if (value.includes("```")) return `\`${name}\` carries a \`\`\` fence, which would end the block early`;
  return null;
}

/**
 * One declaration, checked against the vocabularies ledger.mjs enforces.
 *
 * Returns `{ fields }` or `{ field, why }`. What it deliberately does NOT check
 * is whether the arm exists, whether the side is uncovered, and whether an
 * input already claims it: blocked.mjs asks all three against the work list,
 * its refusals name the arm and print the arm's real side labels, and a second
 * copy of those checks here would be a second thing to keep true.
 */
export function checkDeclaration(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { field: "(the entry)", why: `this is ${JSON.stringify(entry)}, not a declaration object` };
  }
  const unknown = Object.keys(entry).filter((k) => !DECLARATION_FIELDS.includes(k));
  if (unknown.length) {
    return {
      field: unknown[0],
      why:
        `${unknown.map((k) => `\`${k}\``).join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} a ` +
        `declaration has. It carries ${DECLARATION_FIELDS.map((f) => `\`${f}\``).join(", ")} and nothing else — a field ` +
        `the format does not define is a disposition this pipeline does not have.`,
    };
  }

  const fields = {};
  // `side` may name several labels. A label is an operand's source text and
  // four of them on this repo contain a comma, so a list is given as an ARRAY
  // and joined here; blocked.mjs hands the joined value to ledger.mjs's own
  // `sidesOf`, which matches whole labels before it splits on anything.
  const side = Array.isArray(entry.side) ? entry.side : entry.side;
  if (Array.isArray(side)) {
    for (const [i, s] of side.entries()) {
      const bad = fieldProblem(`side[${i}]`, s);
      if (bad) return { field: "side", why: bad };
    }
    if (!side.length) return { field: "side", why: "`side` is an empty list — name the side this entry rules" };
    fields.side = side.map((s) => s.trim()).join(",");
  }

  for (const name of DECLARATION_FIELDS) {
    if (name === "side" && Array.isArray(side)) continue;
    const value = entry[name];
    const required = DECLARATION_REQUIRED.includes(name);
    if (value === undefined && !required) continue;
    const bad = fieldProblem(name, value);
    // REFUSED, never defaulted. A missing `proof` filled in from anywhere would
    // be evidence this step invented, and it would pass every check downstream.
    if (bad) return { field: name, why: bad };
    fields[name] = value.trim();
  }

  if (!CATEGORIES.has(fields.category)) {
    return {
      field: "category",
      why:
        `\`category\` is ${JSON.stringify(fields.category)}, which is not one of ${[...CATEGORIES].join(" | ")} — ` +
        `the three ledger.mjs accepts.`,
    };
  }
  if (!KILLERS.has(fields.killer)) {
    return {
      field: "killer",
      why:
        `\`killer\` is ${JSON.stringify(fields.killer)}, which is not one of ${[...KILLERS].join(" | ")}. ` +
        `\`category\` says whether the side is reachable; \`killer\` says WHERE the constraint lives, which is what ` +
        `decides how this entry goes false.`,
    };
  }
  if (fields.category === "data-blocked" && !fields.fix) {
    return {
      field: "fix",
      why: "`fix` is required when `category` is data-blocked: a side that could be unblocked must say how.",
    };
  }
  return { fields };
}

/**
 * The field a tool's refusal is ABOUT, read out of the refusal itself.
 *
 * blocked.mjs and propose.mjs both print the offending thing on an indented
 * continuation line — `--killer "kode-local" is not one of ...`,
 * `proposals[0].args[0].build is still the skeleton's ...`. Taking the token
 * from there rather than restating the rules keeps the name the reader sees and
 * the name the tool refused on the same string. Null when the refusal has no
 * such line, which is honest: the whole message is in the item either way.
 */
export function fieldFromRefusal(text) {
  const line = String(text ?? "").split("\n").map((l) => l.trim()).find((l) => /^(--[a-z]+|[A-Za-z_$][\w$[\].]*\.)/.test(l));
  return line ? line.split(/\s+/)[0] : null;
}

/**
 * D56: a declaration that answers a REFUSED entry replaces it. blocked.mjs's
 * --replace rewrites that one fence and keeps the prose around it, and refuses
 * a --heading or --why beside it, so those two are left off: the fence is what
 * the ledger reads, and the new `why` is still in the submission.
 */
const FENCE_FIELDS = Object.freeze(["category", "killer", "proof", "fix"]);
export function replacingArgv(answer) {
  if (!answer.replace) return blockedArgv(answer.fields);
  const { heading: _h, why: _w, ...fence } = answer.fields;
  return [...blockedArgv(fence), "--replace"];
}

/** blocked.mjs's whole command line, as a function so a test can assert it exactly. */
export function blockedArgv(fields) {
  const argv = [];
  for (const name of DECLARATION_FIELDS) if (fields[name] !== undefined) argv.push(`--${name}`, fields[name]);
  return argv;
}

/**
 * propose.mjs's whole command line. The submitted file is written through
 * verbatim, never rewritten.
 *
 * `--replace` only when a document of that name is already there, which is what
 * a REPAIR is: the same file name, corrected. Without it propose.mjs refuses to
 * overwrite, which is the right default for a writer and the wrong one for the
 * round that exists to fix what did not land.
 */
export function proposeArgv(path, name, { replace = false, exclude = [] } = {}) {
  const drop = [...new Set((exclude ?? []).filter((id) => typeof id === "string" && id))];
  return [
    "--from", path, "--name", name,
    ...(replace ? ["--replace"] : []),
    // D73 — THE ROWS THIS FILE MAY NOT LAND, and only those. Absent on every
    // call that has no collision, which is nearly all of them, so the bytes
    // propose.mjs writes are still the bytes submitted byte for byte in the
    // ordinary case. See the dedupe in `materialise` for why a row is here.
    ...(drop.length ? ["--exclude", drop.join(",")] : []),
  ];
}

/**
 * Every row landed in `proposals/`, by id, WHOLE.
 *
 * Not `flatProposals` and not `landedProposals`: both keep a chosen few fields
 * (`reaches`, `covers`, `functionId`, `via`, `boundaries`), and the question
 * below is whether the landed row is still the submitted row — which is a
 * question about every field it has, including the ones no reader here knows
 * the name of. The walk is otherwise theirs: sorted file names, `proposals`
 * flattened in order, an unparseable file contributing nothing, because a file
 * validate.mjs cannot read must not make a submission look answered.
 *
 * The FIRST row wins a duplicated id, the same way `proposalRowsById`
 * (steps/repair.mjs:1595) resolves one: two files claiming an id is
 * `materialise`'s own refusal to raise, not this index's to arbitrate.
 */
export function landedRowsById(proposalsDir) {
  const out = new Map();
  if (!existsSync(proposalsDir)) return out;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      continue;
    }
    for (const row of Array.isArray(doc) ? doc : (doc?.proposals ?? [])) {
      if (!row || typeof row !== "object" || typeof row.id !== "string") continue;
      if (!out.has(row.id)) out.set(row.id, { file, row });
    }
  }
  return out;
}

/**
 * Every row landed in `proposals/`, WHOLE, per file:
 * `Map<file, Map<id, { file, at, row }>>`.
 *
 * `landedRowsById` answers "is this id landed anywhere"; this answers "what
 * does the file of THIS NAME hold", which is the question a submission is
 * asked. They differ exactly when one id is landed in two files, and that is
 * the state the first-wins index got wrong: email-centralization-ms, the
 * evening run of 25 September, had `parseProviderValue-46-if-0` in two files,
 * the index held the copy from the file that sorts first, and the OTHER file's
 * submission compared its own row against that copy, read as never landed, and
 * was re-materialised every round - a submission that is always ready and
 * never asked about, which is the walk's "not satisfied, asked nothing" DEFECT.
 */
export function landedRowsByFile(proposalsDir) {
  const out = new Map();
  if (!existsSync(proposalsDir)) return out;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      continue;
    }
    const rows = new Map();
    (Array.isArray(doc) ? doc : (doc?.proposals ?? [])).forEach((row, at) => {
      if (!row || typeof row !== "object" || typeof row.id !== "string") return;
      if (!rows.has(row.id)) rows.set(row.id, { file, at, row });
    });
    out.set(file, rows);
  }
  return out;
}

/** Two rows that are the same row: the same body and the same claims, a withdrawal's record counted as a claim. */
export function sameRow(a, b) {
  if (rowBody(a) !== rowBody(b)) return false;
  const x = claimsEverStated(a);
  const y = claimsEverStated(b);
  return x.size === y.size && [...x].every((c) => y.has(c));
}

/**
 * Every claim a row is the record of — the ones it still states AND the ones a
 * withdrawal took off it.
 *
 * `propose.mjs --withdraw` removes the side from `reaches` and appends the
 * withdrawal to `withdrawn` (propose.mjs:551), so the union of the two is what
 * the row was submitted claiming. Read as a SET of `arm [side]` strings rather
 * than compared field by field, because `reaches[arm]` is a string when one
 * side is claimed and an array when several are, and a withdrawal collapses the
 * one shape into the other — a difference of spelling, not of claim.
 */
function claimsEverStated(row) {
  const out = new Set();
  for (const [arm, value] of Object.entries(row?.reaches ?? {})) {
    for (const side of Array.isArray(value) ? value : [value]) out.add(`${arm} [${side}]`);
  }
  for (const w of Array.isArray(row?.withdrawn) ? row.withdrawn : []) {
    if (w && typeof w === "object") out.add(`${w.arm} [${w.side}]`);
  }
  return out;
}

/** The row without the two fields a withdrawal is allowed to move. */
const rowBody = (row) => {
  const { reaches: _reaches, withdrawn: _withdrawn, ...rest } = row ?? {};
  return JSON.stringify(rest);
};

/**
 * D71 — which landed rows a submission may take out by leaving them out: those
 * the last measurement verified NONE of the claims of. `null` (no measurement,
 * or one over a red suite, which decides nothing - ledger.mjs
 * `doubleClaimEvidence`) means no omission counts, which is the rule before
 * D71. See `consumedSubmission`.
 */
export function omittedRowCounts(coveragePath) {
  let cov;
  try {
    cov = JSON.parse(readFileSync(coveragePath, "utf8"));
  } catch {
    return null;
  }
  if (!cov || typeof cov !== "object" || cov.refused === "suite-did-not-pass" || cov.suitePassed === false) return null;
  const verified = new Set((Array.isArray(cov.verified) ? cov.verified : []).map((v) => v?.id).filter(Boolean));
  return (row) => typeof row?.id === "string" && !verified.has(row.id);
}

/**
 * Has this submission already been materialised — every row of it landed, and
 * none of them since edited by anything but a withdrawal?
 *
 * THIS WAS A BYTE COMPARISON. A submission counted as consumed when some file
 * in `proposals/` hashed to the same sha256 as the submission, which holds only
 * for as long as nothing edits the landed document. `repair.run()` →
 * `withdrawFalseClaims` (steps/repair.mjs:1615) spawns `propose.mjs --withdraw`,
 * and that surgically edits the landed row (propose.mjs:740): the withdrawn side
 * comes out of `reaches` and a `withdrawn` record is appended. From that moment
 * the bytes no longer match.
 *
 * WHAT THAT COST. `derive` is ORDER[3] and `repair` is behind it, so the round
 * AFTER a withdrawal read the submission as unmaterialised and re-materialised
 * it verbatim with `--replace` — putting back the false claim the previous round
 * had withdrawn on measured evidence, re-flipping the fingerprint every later
 * stage keys off, and paying a full record → determinism → emit → measure cycle
 * to arrive where the round started. The next `repair` withdrew it again, and
 * the next `derive` put it back. Nothing in the loop converges, and it is
 * exactly the "asking exactly what the last round asked" shape workflow.mjs:213
 * refuses to let a walk spend its rounds on.
 *
 * SO THE QUESTION IS ASKED OF THE ROWS. Consumed means every row id in the
 * submission is landed AND the landed row is this row — either unchanged, or
 * changed only in the way `propose.mjs --withdraw` changes one. That tool leaves
 * its own durable marker ON THE ROW (`withdrawn: [{arm, side, artifact, ...}]`),
 * so an answered-and-withdrawn row is recognisable from the document alone, with
 * the withdrawn claims added back for the comparison and the rest of the row
 * compared as it stands.
 *
 * THE TRADE-OFF, chosen rather than fallen into. A marker file written by
 * `propose.mjs` beside the proposal — the digest of the submission it landed —
 * would survive ANY later edit, not only a withdrawal. It was not chosen: it is
 * a second piece of state about one fact, it goes stale the moment a proposals
 * directory is tidied by hand, it answers nothing for every proposal landed
 * before it existed, and a missing marker cannot be told from a never-landed
 * row. Reading the documents keeps the answer derived from the disk every round.
 * The price is that an edit by any OTHER writer — `fillboundaries.mjs`,
 * `fixup-boundaries.mjs`, a person — reads as a changed row and re-materialises
 * the submission over it, which is precisely what the byte comparison did too:
 * no behaviour is lost, and the safe direction is kept.
 *
 * A RESUBMISSION OF THE SAME BYTES AFTER A WITHDRAWAL IS NOT A REPAIR, and this
 * treats it as consumed on purpose. The withdrawal was made on measured evidence
 * that the claim is false (propose.mjs refuses one without it); an identical
 * document recorded again produces the identical measurement and is withdrawn
 * again. Change a row — its `args`, its `invoke`, its `boundaries` — and the
 * body differs, the submission is materialised, and the claim gets its second
 * chance honestly.
 */
export function consumedSubmission(doc, landed, own = null, { dropped = null } = {}) {
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.proposals) ? doc.proposals : null;
  // A document with no rows has nothing landed to compare against, so it is
  // never consumed: propose.mjs is the one that says what is wrong with it, and
  // its refusal is what the answering turn has to read.
  if (!rows || !rows.length) return false;
  // D71 — A ROW TAKEN OUT OF THE SUBMISSION CAN BE AN ANSWER TOO.
  //
  // This asked only whether every row the submission HOLDS is landed, so a
  // submission that dropped a row read as consumed while the file it replaces
  // still carried the row. cv-parsing-ms, run 20260927T142436Z: `repair` asked
  // the double claim on `cv.ts#275:cond-expr:0 [whenFalse]`, whose option (2)
  // is "resubmit the proposal file ... with the row removed". The worker did:
  // the answer file held 13 rows and `proposals/answers-8c77459225f7.json` 14,
  // `derive` was "already done", and the ledger (which reads proposals/) went
  // on dealing a double claim no answer stated any more, for ten rounds.
  //
  // `dropped(landedRow)` says whether an omitted landed row counts as taken
  // out; when one does, the submission is not consumed and lands with
  // `--replace` like any other change. The caller answers it from the
  // measurement (`omittedRowCounts`): A VERIFIED INPUT IS NEVER TAKEN OUT BY
  // OMISSION. The same checkpoint carries `answers-04a327f465e4.json` with one
  // row over a landed file of five, four of them verified by coverage.json -
  // a worker that wrote back only the row it was repairing, runs ago - and
  // landing that file would have dropped four covered sides. Without the
  // predicate (a subset asked below, or no usable measurement) an omitted row
  // decides nothing, as before.
  if (own && typeof dropped === "function") {
    const held = new Set(rows.map((row) => row?.id));
    for (const [id, there] of own) if (!held.has(id) && dropped(there.row)) return false;
  }
  return rows.every((row) => {
    if (!row || typeof row !== "object" || typeof row.id !== "string") return false;
    // THE FILE THIS SUBMISSION LANDS AS FIRST (`own`, one entry of
    // `landedRowsByFile`), because that is the file it replaces. The id index
    // is the fallback, and it keeps the first of two files that share an id,
    // so asked alone it compares one file's submission with the other file's
    // row whenever an id is duplicated.
    const there = own?.get(row.id) ?? landed.get(row.id);
    if (!there) return false;
    if (rowBody(there.row) !== rowBody(row)) return false;
    const submitted = claimsEverStated(row);
    const onDisk = claimsEverStated(there.row);
    return submitted.size === onDisk.size && [...submitted].every((c) => onDisk.has(c));
  });
}

/**
 * Everything on the submission disk, sorted into what can still be materialised
 * and what is refused — WITHOUT SPAWNING ANYTHING.
 *
 * `satisfied` needs this answer before `run` exists to give it, and a predicate
 * that spawned tools to decide whether it was satisfied would record proposals
 * as a side effect of being asked a question.
 */
export function inspectSubmissions(paths, { labelsByArm, declared, proposed, reserved = null }) {
  const ready = [];
  const problems = [];
  // WHAT IS ALREADY ON DISK, BY ROW ID — never by the landed file's bytes. A
  // submission whose rows are already landed has nothing left to do: this step
  // cannot delete a consumed submission (it writes nothing), so every later
  // round has to read it as answered rather than hand blocked.mjs and
  // propose.mjs a duplicate to refuse. See `consumedSubmission` for what a
  // withdrawal does to the landed bytes and what that cost every round after it.
  const landedRows = landedRowsById(paths.proposalsDir);
  const landedByFile = landedRowsByFile(paths.proposalsDir);
  // D60: the declarations whose BLOCKED.md entry the scan step SUPERSEDED. The
  // entry is gone, so read against BLOCKED.md alone the submission that wrote
  // it looks unanswered and would be written straight back; it answered a
  // question whose premise no longer holds, and is consumed. Only that file,
  // that index and that entry (premises.mjs `submissionTag`).
  const supersededSubmissions = paths.outDir
    ? supersededRulings(join(paths.outDir, "blocked-premises.json")).submissions
    : new Set();
  // D56: the entries on disk the ledger refused. A declaration submitted for
  // one of their sides is the answer to that refusal, not a duplicate.
  let refused = null;
  // What the ledger decides a double claim from, read once and only when a
  // declaration meets a claimed side. `null` (nothing measured) decides for the
  // input, exactly as the ledger does.
  let evidence;
  // D71: whether a landed row a submission no longer holds counts as taken
  // out of it (`consumedSubmission`), read once and only when asked.
  let omitted;

  for (const file of readSubmissions(paths.answersDir)) {
    const where = relative(REPO_ROOT, file.path) || file.path;
    if (file.error) {
      problems.push({
        id: answerId(where, "(the file)", file.error),
        file: where, at: "(the file)", field: "(the file)", entry: null,
        why: `this submission is not JSON — ${file.error}.`,
      });
      continue;
    }
    const doc = file.doc;
    const hasDeclarations = doc && typeof doc === "object" && !Array.isArray(doc) && doc.declarations !== undefined;
    const hasProposals = doc && typeof doc === "object" && !Array.isArray(doc) && doc.proposals !== undefined;
    // THE THIRD SHAPE. A worker that read a file it had no note for owes one,
    // and it submits that the way it submits everything else -- into
    // `charpilot-answers/`, materialised here by the tool that owns the format.
    // See notes.mjs; the note is navigation, never evidence.
    const hasNotes = doc && typeof doc === "object" && !Array.isArray(doc) && doc.notes !== undefined;
    const shapes = [hasDeclarations, hasProposals, hasNotes].filter(Boolean).length;
    // PLAN 20 — THE SWEEP'S OWN DOCUMENT IS NOT A STAGE-3 SUBMISSION.
    //
    // `steps/sweep.mjs` asks for `{"domain": [...]}` in THIS directory
    // (`charpilot-answers/sweep-domain.json`, sweep.mjs:49,59) and harvests it
    // itself. Read here as a submission it has none of the three shapes, so it
    // was refused with "carries none of `declarations`, `proposals` or
    // `notes`" and handed back as work every round. A worker then "fixed" it
    // under a packet's reserved name, which was refused again, and so on:
    // 9 of the 10 runs of 2026-09-21/23 re-asked it, in 1 to 11 rounds each
    // (profile-centralized 20260923T051237Z: 11), and the one-packet bench
    // BENCH-1pkt-fleet spent 2 of its 4 rounds on nothing else after every
    // side was answered. A domain document answers no side, so it is not this
    // step's to judge: it is left to the sweep, whatever it is called.
    const isDomain = doc && typeof doc === "object" && !Array.isArray(doc) && doc.domain !== undefined;
    if (file.name === "sweep-domain.json" || (isDomain && shapes === 0)) continue;
    if (shapes !== 1) {
      problems.push({
        id: answerId(where, "(the file)", doc),
        file: where, at: "(the file)", field: shapes > 1 ? "(more than one)" : "(neither)", entry: null,
        why:
          shapes > 1
            ? "this submission carries more than one of `declarations`, `proposals` and `notes`. One file is one " +
              "kind of answer: the proposal form is the proposal DOCUMENT, byte for byte, and it cannot also hold " +
              "declarations or notes."
            : "this submission carries none of `declarations`, `proposals` or `notes`. A declaration file is " +
              "`{ \"declarations\": [ ... ] }`; a proposal file is the proposal document itself, " +
              "`{ \"proposals\": [ ... ] }`; a note file is `{ \"notes\": [ ... ] }`.",
      });
      continue;
    }

    if (hasNotes) {
      // D75 — ALREADY CONSUMED, asked of the tool that owns the format.
      //
      // The two branches below each have one of these and this one had none, so
      // every note file in the answers directory read as outstanding work on
      // every round for ever, and it cost run `20260920T030124Z` its ending
      // twice over. A note that materialises CLEANLY is never in the handover —
      // nothing is wrong with it — so `satisfied`'s
      // `ready.every(r => asked.has(r.id))` could not become true again once a
      // single note had landed: that run reached `open=0` at round 6 and failed
      // at round 10 holding 26 of them. A note that is REFUSED is re-spawned
      // and re-raised unchanged every round: rounds 7, 8 and 9 of the same run
      // were handed the identical two items, and no round after 5 could close a
      // side because every side was already covered.
      //
      // IT IS NOT ASKED OF THE NOTE ON DISK, and that is the whole reason
      // `notes.mjs` leaves a receipt at all: the note has a ceiling, so a
      // submission that landed perfectly still has facts that are not in it.
      // See the block above `submittedDirFor` in that file for what the receipt
      // means, and for why an EDITED submission does not have one.
      if (noteSubmissionConsumed(doc, { dir: paths.notesDir })) continue;
      ready.push({
        // `at` IS "notes", AND IT USED TO BE MISSING. Every problem this file
        // raises reads `at: answer.at ?? "proposals"`, so a refused note was
        // filed as `<file>#proposals` — a proposals fault on a document that
        // carries no proposals, under an id that says `#notes` because
        // `answerId` was given the right word here. Run 20260920T030124Z's
        // rounds 6 to 9 are fifteen items reading `notes-worker-packet-25-26
        // .json#proposals`, which is the whole reason that run's refusals were
        // read as proposal refusals rather than as a cache repair.
        kind: "notes", at: "notes", id: answerId(where, "notes", doc),
        file: where, path: file.path, name: file.name, doc,
      });
      continue;
    }

    if (hasProposals) {
      // BEFORE ANYTHING IS SPAWNED FOR IT. A document filed under a name that
      // belongs to another packet is the two-writers-one-name failure, and
      // materialising half of it would put the wrong half on disk.
      const collision = nameCollision(file.name, doc, reserved, armsLandedUnder(paths.proposalsDir, file.name));
      if (collision) {
        problems.push({
          id: answerId(where, "(the file name)", doc),
          file: where, at: "(the file name)", field: "(the file name)", entry: null,
          why: collision,
        });
        continue;
      }
      // THE SUBMISSION IS THE DOCUMENT. Nothing narrower: a `build` expression,
      // a constructor argument, a `setup[].apply` directive — everything
      // validate.mjs accepts is expressible here, because this IS the shape
      // validate.mjs reads. An answer schema narrower than the proposal format
      // would be a total block, which is worse than the defect it replaces.
      //
      // WHAT IS WRONG WITH ONE IS NOT ASKED HERE, and that is deliberate.
      // propose.mjs refuses an unfilled slot, a banned field and a document
      // that is not one, out of validate.mjs's own constants; asking the same
      // questions here would be a second copy of them living one layer up,
      // which is the drift this file avoids everywhere else. Its refusal is
      // quoted verbatim into the pending item below instead. It also keeps this
      // step's LOAD independent of validate.mjs, which a walk over a stubbed
      // toolset does not have.
      // ALREADY ANSWERED — asked of the ROWS, and of a withdrawal's own record
      // of what it took off them. See `consumedSubmission`.
      if (omitted === undefined) omitted = omittedRowCounts(paths.coverageJson);
      if (consumedSubmission(doc, landedRows, landedByFile.get(file.name), { dropped: omitted })) continue;
      ready.push({
        kind: "proposal", id: answerId(where, "proposals", doc), file: where, path: file.path, name: file.name,
        doc, replace: existsSync(join(paths.proposalsDir, file.name)),
      });
      continue;
    }

    if (!Array.isArray(doc.declarations)) {
      problems.push({
        id: answerId(where, "declarations", doc.declarations), file: where, at: "declarations", field: "declarations",
        entry: null, why: "`declarations` is not an array.",
      });
      continue;
    }
    doc.declarations.forEach((entry, i) => {
      const at = `declarations[${i}]`;
      const checked = checkDeclaration(entry);
      if (checked.field) {
        problems.push({ id: answerId(where, at, entry), file: where, at, field: checked.field, entry, why: checked.why });
        return;
      }
      // Already ruled, or already claimed by an input: nothing to do and
      // nothing to say twice. The submission stays on disk — this step cannot
      // delete it — so every later round has to read it as already answered
      // rather than as a duplicate blocked.mjs will refuse.
      //
      // EXCEPT A CLAIM THE LEDGER ITSELF OVERRULES. `resolveDoubleClaim` lets
      // the reason stand when every proposal claiming the side was skipped by
      // record.mjs and coverage.json still has it uncovered: that claim never
      // ran, so it answers nothing. Reading it as an answer here dropped the
      // declaration without a word — not materialised, not refused, not asked
      // about — which is how profile-centralized (September 2026) ended with
      // `organization.title ?? undefined [undefined]` open: repair's stall
      // ruling asked for exactly this declaration, the agent wrote it with its
      // proof, and this line threw it away every round after.
      const labels = labelsByArm?.get(checked.fields.arm) ?? new Set();
      if (supersededSubmissions.has(submissionTag(file.name, at, premiseKey(checked.fields, labels)))) return;
      const sides = sidesOf(checked.fields.side, labels);
      const answeredByInput = (s) => {
        const claims = proposed?.get(sideKey(checked.fields.arm, s));
        if (!claims) return false;
        evidence ??= doubleClaimEvidence(paths.coverageJson, paths.behaviourJson);
        return resolveDoubleClaim(`${checked.fields.arm} ${s}`, claims, evidence).winner !== "blocked";
      };
      // D56 — EXCEPT AN ENTRY THE LEDGER REFUSED. It is on disk and rules
      // nothing, and a declaration submitted for its side is the agent writing
      // it again, as repair asked. Read as "already ruled" it was dropped
      // without a word every round, so no refused entry could ever be mended.
      // It is materialised with --replace, which rewrites that one fence.
      //
      // BUT NOT THE REFUSED DECLARATION ITSELF. The submission that wrote the
      // entry is still in charpilot-answers/ (a resumed run carries it in), and
      // it is the very thing the ledger refused: written back it would be
      // refused again, and asked about again, every round. It is consumed; the
      // refusal is asked where the side is (repair's reopened side), and only
      // a declaration that differs from the refused entry is a new answer.
      refused ??= refusedDeclarations(paths.proposalsDir, labelsByArm ?? new Map());
      const isRefused = (s) => {
        const r = refused.get(sideKey(checked.fields.arm, s));
        return Boolean(r) && FENCE_FIELDS.some((f) => (r.entry?.[f] ?? "") !== (checked.fields[f] ?? ""));
      };
      if (sides.length && sides.every((s) => (declared?.has(sideKey(checked.fields.arm, s)) && !isRefused(s)) || answeredByInput(s))) return;
      ready.push({
        kind: "declaration", id: answerId(where, at, entry), file: where, at, entry, fields: checked.fields, sides,
        ...(sides.some(isRefused) ? { replace: true } : {}),
      });
    });
  }
  return { ready, problems, landedByFile };
}

/**
 * Materialise what was submitted, by spawning the tool that owns each format.
 *
 * Returns `{ did, problems, metrics }` and NEVER throws. A tool that refuses is
 * a pending item quoting the tool's own bytes — the refusals blocked.mjs writes
 * name the arm, print the arm's real side labels and say what to do next, and a
 * step that summarised them would turn an instruction into a mystery.
 */
export function materialise(repo, paths, { labelsByArm, declared, proposed, asked, reserved = null, lastSeen = null, round = null } = {}) {
  const { ready, problems, landedByFile } = inspectSubmissions(paths, { labelsByArm, declared, proposed, reserved });
  // WHAT WAS IN THE DIRECTORY THIS ROUND, and what the last round said was in
  // it. Taken before anything is spawned, because propose.mjs does not alter a
  // submission and this has to describe what the answering turn actually wrote.
  const census = answersCensus(paths.answersDir);
  problems.push(...shrunkSubmissions(census, lastSeen));
  const did = [];
  // `round` IS ON THE METRICS BECAUSE `notesArgv` READS IT OFF THEM, and until
  // this line existed it never was. `notes.mjs`'s `--round` is the round that
  // MATERIALISES a submission and is the default a fact without its own round
  // falls back to; `verifyEntries` then requires a whole number and refused
  // **15 facts in one run** (`20260919T092410Z`) for its absence. The tool was
  // demanding a field the only route that calls it never supplied.
  //
  // NULL IS A REAL ANSWER AND NOT A PLACEHOLDER. A caller that does not know
  // the round passes nothing, `notesArgv` omits `--round` entirely, and every
  // fact carrying its own round still lands. A number invented here would be
  // provenance nobody can check, which `notes.mjs:1508` names as the worse
  // failure of the two.
  const metrics = {
    submissionsReady: ready.length,
    submissionsMaterialised: 0,
    submissionsRefused: problems.length,
    // ONLY WHEN IT IS A NUMBER. A caller that does not know the round adds no
    // key at all, so a `round: null` never appears in a run's own log next to
    // counters that are real.
    ...(Number.isInteger(round) ? { round } : {}),
  };
  if (!ready.length && !problems.length) {
    // SILENT when the directory is not there at all. A repo whose answering
    // turn has submitted nothing yet has nothing to report, and a line in every
    // `did` about a directory that does not exist is a line that stops being
    // read. An EMPTY directory is different: the mechanism is in use and this
    // round found nothing in it, which is worth one line.
    //
    // The judgement is still taken. The quarantine is a fact about the
    // proposals ON DISK, not about what this round wrote: a round that
    // submitted nothing still has to know which rows are refused, or it would
    // count a refused row's side as answered for every round after the one that
    // wrote it.
    const judgement = judgeProposals(repo, paths);
    return {
      did: [
        ...(existsSync(paths.answersDir) ? [`submissions: nothing to materialise in ${here(paths.answersDir)}`] : []),
        ...quarantineDid(judgement, paths),
        ...unmeasurableDid(judgement, paths),
      ],
      problems: [...problems, ...quarantineProblems(judgement, paths, asked, false), ...unmeasurableProblems(judgement, paths, asked)],
      metrics: { ...metrics, ...quarantineMetrics(judgement), submissionsRefused: problems.length },
      judgement,
      census,
    };
  }

  // ONE ROW ID, ONE SUBMISSION — decided HERE, before anything is written.
  //
  // `validate.mjs:681` keeps `seen` ids across the whole flattened proposals
  // directory, so two files carrying one id is `duplicate id` on BOTH and the
  // side reopens. Materialising both and letting the validator sort it out
  // loses the row twice over: 6e92e85 fixed the reservation a recorder outcome
  // is GIVEN, and this is the other half — two workers each choosing their own
  // file name for the same side.
  //
  // MEASURED, run 20260917T172502Z round 3:
  //   answers-4077fca32d81.json[0]            "arg0-of-rawLocations-map-111-binary-expr-0"
  //   packet-01-rawLocations-map-null.json[0] "arg0-of-rawLocations-map-111-binary-expr-0"
  // Four rows, two sides, both copies quarantined and `open` back from 0 to 2.
  //
  // THE RESERVED NAME WINS, because it is the one the packet named and the one
  // a later repair will be told to resubmit under. Everything else is refused
  // AS AN ITEM, so the agent learns the row was already answered rather than
  // silently losing it — and the surviving copy keeps the side closed, which is
  // the whole point.
  const reservedNames = new Set(reserved ? [...reserved.keys()] : []);
  // READ ONCE, AND ONLY IF A COLLISION IS FOUND. The no-collision path — which
  // is nearly every round — does not touch the proposals directory again.
  let landedCache = null;
  const landedNow = () => (landedCache ??= landedRowsById(paths.proposalsDir));
  const rowsOf = (a) => (a.doc?.proposals ?? []).map((r) => r?.id).filter((id) => typeof id === "string");
  const ordered = [...ready].sort((a, b) => {
    const ar = a.kind === "proposal" && reservedNames.has(a.name) ? 0 : 1;
    const br = b.kind === "proposal" && reservedNames.has(b.name) ? 0 : 1;
    return ar - br || String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });
  // D73 — THE EXCLUSION IS BY ROW, AND IT USED TO BE BY FILE.
  //
  // WHAT IT COST. A single duplicate id in a 20-row submission refused all 20
  // that round: 19 correct rows paid for one collision, their sides stayed
  // open and were re-dealt, and the round after did it again. Nothing was
  // silent — the file came back as an item — but "not silent" is not "not
  // lost", and this is the clearest instance of the rule this whole step is
  // built on: one bad part must not destroy the good work beside it.
  //
  // THE TIE-BREAK IS UNCHANGED, and it is still a PRECEDENCE RULE AND NOT A
  // GATE. `ordered` above puts reserved names first, so the reserved file's
  // copy of a contested id is the one that lands and the self-named file's
  // copy is the one dropped. Exactly as before — what changed is that the
  // self-named file's OTHER rows now land with it.
  //
  // A FILE WHOSE EVERY ROW IS CONTESTED IS STILL REFUSED WHOLE, because
  // `propose.mjs --exclude` would have nothing left to write and an empty
  // proposal document is not an answer. That is the same item as before.
  const claimedBy = new Map();
  const deduped = [];
  // AND ACROSS ROUNDS: an id ALREADY LANDED under another name. `claimedBy`
  // above sees only this round's submissions, so a row resubmitted under a
  // fresh name while its id still lived in the file it came from landed beside
  // it, and validate.mjs quarantined both (email-centralization-ms, the evening
  // run of 25 September: `parseProviderValue-46-if-0`). A file that is itself
  // resubmitted this round is left out — what it will hold is its submission,
  // which `claimedBy` already sees.
  const resubmitted = new Set(ordered.filter((a) => a.kind === "proposal").map((a) => a.name));
  let elsewhereCache = null;
  const landedElsewhere = () => {
    if (elsewhereCache) return elsewhereCache;
    elsewhereCache = new Map();
    for (const [file, rows] of landedByFile ?? new Map()) {
      if (resubmitted.has(file)) continue;
      for (const [id, landed] of rows) if (!elsewhereCache.has(id)) elsewhereCache.set(id, landed);
    }
    return elsewhereCache;
  };
  for (const answer of ordered) {
    if (answer.kind !== "proposal") { deduped.push(answer); continue; }
    const rows = rowsOf(answer);
    const clashes = rows.filter((id) => claimedBy.has(id));
    // THE SAME RULE `decideDuplicates` KEEPS FOR TWO LANDED COPIES, asked
    // before the second one lands: the same row is already answered and is
    // simply not written twice; a different row is not landed, the landed copy
    // stands, and which one was meant goes back as a question.
    const copies = [];
    const differ = [];
    for (const id of rows) {
      if (claimedBy.has(id)) continue;
      // Already under this name too: a clash that predates this submission,
      // which `decideDuplicates` decides or asks. Excluding it here would
      // replace this file without its copy — a choice nobody made.
      if (landedByFile?.get(answer.name)?.has(id)) continue;
      const there = landedElsewhere().get(id);
      if (!there || there.file === answer.name) continue;
      const mine = (answer.doc?.proposals ?? []).find((r) => r?.id === id);
      (sameRow(mine, there.row) ? copies : differ).push({ id, file: there.file });
    }
    if (copies.length) {
      metrics.rowsAlreadyLandedElsewhere = (metrics.rowsAlreadyLandedElsewhere ?? 0) + copies.length;
      did.push(
        `submissions: ${answer.file} carries ${copies.length} row(s) already landed, byte for byte, under another name ` +
          `(${copies.map((c) => `\`${c.id}\` in \`${c.file}\``).join(", ")}) — not written a second time, since two ` +
          `copies of one id quarantine both`
      );
    }
    if (clashes.length || differ.length) {
      const refused = clashes.length + differ.length;
      const whole = refused + copies.length === rows.length;
      metrics.submissionsCollided = (metrics.submissionsCollided ?? 0) + 1;
      metrics.rowsCollided = (metrics.rowsCollided ?? 0) + refused;
      if (!whole) metrics.rowsKeptPastACollision = (metrics.rowsKeptPastACollision ?? 0) + (rows.length - refused - copies.length);
      const named = clashes.map((id) => `\`${id}\` (already in \`${claimedBy.get(id)}\`)`).join(", ");
      const landedNamed = differ.map((d) => `\`${d.id}\` (already LANDED in \`${d.file}\`, as a different row)`).join(", ");
      problems.push({
        id: answer.id, file: answer.file, at: "proposals", field: whole ? "(the file name)" : "(the row ids below)", entry: null,
        why:
          (clashes.length
            ? `${clashes.length} of this file's ${rows.length} row(s) are already answered elsewhere in this round — ` +
              `${named}. `
            : "") +
          (differ.length
            ? `${differ.length} of this file's ${rows.length} row(s) carry an id that is already landed in another ` +
              `proposals file — ${landedNamed}. `
            : "") +
          `One row id may live in ONE file: validate.mjs keeps \`seen\` ids across the whole proposals ` +
          `directory, so materialising both copies would refuse BOTH as \`duplicate id\` and the side would come ` +
          `back open. ` +
          (whole
            ? `Every row in this file is contested, so nothing here was materialised and the other copies stand. `
            : `THOSE ROWS ALONE were not materialised; the other ${rows.length - refused - copies.length} row(s) in this file ` +
              `WERE, and the contested sides stay answered by the copy that landed first. `) +
          (differ.length
            ? `KEEP ONE: to change a landed row, resubmit the file it already lives in with the row changed; to add a ` +
              `second row, give it an id of its own. `
            : "") +
          `Answer a packet under the name its own \`packet.answers.file\` gives, and repair a row by resubmitting ` +
          `the file it already lives in.`,
      });
      if (whole) continue;
    } else if (rows.length && copies.length === rows.length) {
      // Every row is already landed, identically, elsewhere: nothing to write
      // and nothing wrong. Read as consumed, which is what it is.
      //
      // `rows.length` FIRST, because zero copies of zero rows is also "every
      // row". A submission with no row ids — `{"proposals": []}`, or rows
      // that carry no `id` — was dropped here without being written, refused
      // or asked about, while `inspectSubmissions` (which `satisfied` reads)
      // went on listing it as ready, because `consumedSubmission` never calls
      // an empty document consumed. So `satisfied` could never be true again
      // and `run` asked nothing: ai-centralization (September 2026) carried
      // two `{"proposals": []}` files and ended every round from the second on
      // as "ran and is still not satisfied, and it asked no question". Such a
      // document goes on to propose.mjs, as `consumedSubmission` intends: its
      // refusal is the question, and once it has been asked the run is no
      // longer held on it.
      continue;
    }
    const contested = new Set([...clashes, ...differ.map((d) => d.id), ...copies.map((c) => c.id)]);
    for (const id of rows) if (!contested.has(id)) claimedBy.set(id, answer.name ?? answer.file);
    if (!contested.size) { deduped.push(answer); continue; }
    // AND THE SURVIVING SUBSET IS ASKED THE QUESTION `consumedSubmission`
    // ASKS OF A WHOLE FILE, for the reason that function exists.
    //
    // `inspectSubmissions` only lets a submission through when NOT every row
    // of it is landed-and-unchanged — and a file with a contested row can
    // never satisfy that, because the contested row is landed under ANOTHER
    // name with other bytes. So without this the partial write would be
    // re-spawned with `--replace` every round for the rest of the run, and
    // `repair.mjs --withdraw` surgically edits a landed row: the round after a
    // withdrawal would put the withdrawn claim straight back, which is the
    // 6e92e85 loop this step already refuses to re-enter. The question is
    // asked of the ROWS THIS FILE WOULD ACTUALLY WRITE.
    const keep = (answer.doc?.proposals ?? []).filter((r) => !contested.has(r?.id));
    if (keep.length && consumedSubmission({ proposals: keep }, landedNow(), landedByFile?.get(answer.name))) continue;
    deduped.push({ ...answer, exclude: [...contested] });
  }
  metrics.submissionsReady = deduped.length;
  metrics.submissionsRefused = problems.length;

  let wroteProposal = false;
  for (const answer of deduped) {
    const script = paths.tool(
      answer.kind === "declaration" ? "blocked.mjs" : answer.kind === "notes" ? "notes.mjs" : "propose.mjs");
    if (!existsSync(script)) {
      problems.push({
        id: answer.id, file: answer.file, at: answer.at ?? "proposals", field: "(the toolset)", entry: answer.entry ?? null,
        why:
          `${relative(REPO_ROOT, script) || script} is not installed in this repo, so nothing here can write the ` +
          `answer. Re-run \`.claude/charpilot/install.sh\`.`,
      });
      continue;
    }
    const argv =
      answer.kind === "declaration"
        ? replacingArgv(answer)
        : answer.kind === "notes"
          ? notesArgv(answer.path, { round })
          : proposeArgv(answer.path, answer.name, { replace: answer.replace, exclude: answer.exclude ?? [] });
    const res = paths.exec(script, argv, { cwd: repo });
    // A SUCCESS WITH A NAMED REMAINDER IS NOT A REFUSAL.
    //
    // `notes.mjs` exits FOUR for "the note is on disk and is INCOMPLETE": the
    // facts that verified are published and serve from the next round, and the
    // ones that did not are named on stderr by index with every reason. Two is
    // "nothing was written", three is a `--get` miss, zero is "every fact
    // verified". This branch read every non-zero status as
    // `the submission was refused`, so a worker whose note LANDED was told its
    // submission had not — the headline `notes.mjs:1325-1330` says is wrong and
    // says is this file's to fix.
    //
    // WHY THE ITEM STILL EXISTS. The worker never runs this tool, so a refused
    // FACT reaches it only as a `submission` item built from a non-zero status.
    // Dropping the item to celebrate the landing would trade a wrong headline
    // for a silent loss, which is the trade this whole tree refuses. So the
    // item is raised with the tool's own bytes under a headline that is true,
    // and the write is counted as the materialisation it was.
    const landedIncomplete = answer.kind === "notes" && res.status === PARTIAL_EXIT;
    if (res.status !== 0 && !landedIncomplete) {
      problems.push({
        // THE KIND TRAVELS WITH THE REFUSAL. `cacheOnly` below is the one
        // reader: a refused NOTE cannot close a side, so once nothing is open
        // it is not a question worth another round. Nothing else in a problem
        // says which format it came from — `by` names the script, which is the
        // same fact one layer down and would tie the rule to a file name.
        kind: answer.kind, id: answer.id, file: answer.file, at: answer.at ?? "proposals",
        field: fieldFromRefusal(res.stderr || res.stdout) ?? "(the tool refused)",
        entry: answer.entry ?? null, by: basename(script),
        why: toolFailure("the submission was refused", script, res),
      });
      continue;
    }
    metrics.submissionsMaterialised += 1;
    if (landedIncomplete) {
      metrics.submissionsPartial = (metrics.submissionsPartial ?? 0) + 1;
      problems.push({
        kind: answer.kind, id: answer.id, file: answer.file, at: answer.at ?? "notes",
        field: fieldFromRefusal(res.stderr || res.stdout) ?? "(the facts named below)",
        entry: answer.entry ?? null, by: basename(script),
        why: toolFailure(
          "the note LANDED and is incomplete — the facts that verified are published and serve from the next round; " +
            "these did not and are not in it. Resubmit these facts corrected, not the whole file",
          script,
          res
        ),
      });
    }
    if (answer.kind === "proposal") wroteProposal = true;
    did.push(
      answer.kind === "declaration"
        ? `submissions: ${answer.file}#${answer.at} -> blocked.mjs wrote ${answer.fields.arm} [${answer.sides.join(", ")}]`
        // A NOTE SUBMISSION IS NOT A PROPOSAL SUBMISSION, and this line used to
        // say it was: `answer.doc.proposals` is undefined on a note, so a note
        // that landed was reported as `propose.mjs wrote 0 proposal(s)` — the
        // wrong tool and a count of zero for a write that happened.
        : answer.kind === "notes"
          ? `submissions: ${answer.file} -> notes.mjs ${landedIncomplete ? "wrote part of" : "wrote"} ` +
            `${(answer.doc.notes ?? []).length} note(s)${landedIncomplete ? " — some facts were refused, see the item" : ""}`
          : `submissions: ${answer.file} -> propose.mjs wrote ` +
            `${(answer.doc.proposals ?? []).length - (answer.exclude?.length ?? 0)} proposal(s)` +
            (answer.exclude?.length
              ? ` and EXCLUDED ${answer.exclude.length} whose id is already answered in another file this round ` +
                `(${answer.exclude.join(", ")}) — the rows beside them landed`
              : "")
    );
  }

  // AND THEN THE CHECK THE AGENT WOULD HAVE RUN, run here instead. A document
  // that landed and does not validate is a refusal the answering turn has to
  // see in the round that submitted it, not three stages later.
  const judgement = judgeProposals(repo, paths);
  if (wroteProposal && judgement.ran && judgement.status === 0) {
    did.push("submissions: validate.mjs exits 0 over the proposals that landed");
  }
  did.push(...quarantineDid(judgement, paths));
  did.push(...unmeasurableDid(judgement, paths));
  problems.push(...quarantineProblems(judgement, paths, asked, wroteProposal));
  problems.push(...unmeasurableProblems(judgement, paths, asked));

  metrics.submissionsRefused = problems.length;
  Object.assign(metrics, quarantineMetrics(judgement));
  if (!did.length) did.push(`submissions: ${problems.length} refused, none materialised`);
  return { did, problems, metrics, judgement, census };
}

/**
 * Every submission file that carries LESS than the last round said it did.
 *
 * NOT REPAIRED AND NOT RECONSTRUCTED. Nothing here knows what was in the bytes
 * that are gone, and a step that guessed would be inventing an answer on the
 * agent's behalf — which is the one thing this whole submission mechanism is
 * built not to do (`novalues.mjs`'s rule, one layer up). It is REPORTED, with
 * both counts and the file name, as an item the agent answers by resubmitting.
 *
 * A file that GREW is not reported: the agent added to it, which is the normal
 * shape of a round. A file that vanished entirely is reported the same way a
 * shrunken one is — zero is a count.
 */
export function shrunkSubmissions(census, lastSeen) {
  const problems = [];
  if (!lastSeen?.size) return problems;
  for (const [name, before] of lastSeen) {
    const now = census.get(name) ?? { file: name, proposals: 0, declarations: 0, parsed: false };
    // PLAN 20 T2.1 P1: BY SIDES when both counts carry them. Writing as you
    // go makes merges normal, and a merge lowers the row count while every
    // side is still answered; only a side that is no longer answered is a
    // lost write.
    if (Array.isArray(before.sides) && Array.isArray(now.sides)) {
      const kept = new Set(now.sides);
      const lost = before.sides.filter((x) => !kept.has(x));
      if (!lost.length) continue;
      problems.push({
        id: answerId(name, "(the file)", `lost ${lost.length} side(s)`),
        file: name,
        at: "(the file)",
        field: "(the file)",
        entry: null,
        why:
          `this submission answered ${before.sides.length} side(s) last round and no longer answers ${lost.length} of ` +
          `them: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}. Every write to a file must answer every ` +
          `side the write before it answered. Resubmit the whole file with those sides answered again.`,
      });
      continue;
    }
    const was = (before.proposals ?? 0) + (before.declarations ?? 0);
    const is = (now.proposals ?? 0) + (now.declarations ?? 0);
    if (was <= is) continue;
    problems.push({
      id: answerId(name, "(the file)", `shrank ${was}->${is}`),
      file: name,
      at: "(the file)",
      field: "(the file)",
      entry: null,
      why:
        `this submission carried ${was} answer(s) last round and carries ${is} now. Nothing in this pipeline removes ` +
        `an answer from a submission, so the only way to reach it is a SECOND WRITE TO THIS NAME that lost the first ` +
        `— which is silent, and reads downstream as an agent that answered fewer questions than it did. Nothing here ` +
        `merges or reconstructs it, because nothing here knows what was in the bytes that are gone: resubmit what is ` +
        `missing, and write each packet's answers under its own reserved name (\`packet.answers.file\`).`,
    });
  }
  return problems;
}

/** What the quarantine costs this round, in numbers the run's log carries. */
function quarantineMetrics(judgement) {
  return {
    validationFaults: judgement.faults.length,
    validationFaultsUnplaced: judgement.unplaced.length,
    quarantinedRows: judgement.held.size,
    // One id in two proposals files: how many, and how many the rule decided.
    duplicateIds: judgement.duplicates?.length ?? 0,
    duplicateIdsDecided: (judgement.duplicates ?? []).filter((d) => d.keep).length,
    // COUNTED SEPARATELY FROM `quarantinedRows`, because they are set aside by
    // a different tool for a different reason and the repair is different: a
    // refused row is a document to correct, an unmeasured claim is a sentence
    // the row wrote about itself that the measurement disagreed with.
    unmeasurableRowsQuarantined: judgement.unmeasurable?.held?.size ?? 0,
    unmeasurableClaimsUnplaced: judgement.unmeasurable?.unplaced?.length ?? 0,
  };
}

/**
 * The measurement's quarantine, said out loud, in the same words the other one
 * uses for the same fact.
 */
function unmeasurableDid(judgement, paths) {
  const q = judgement.unmeasurable ?? NOTHING_UNMEASURABLE;
  const lines = [];
  if (q.held.size) {
    lines.push(
      `submissions: ${q.held.size} row(s) QUARANTINED by the last measurement — coverage.mjs could not measure the ` +
        `claim each one makes, so they stay on disk and stop counting: every side they name is back in the brief as ` +
        `an open question. Run 20260919T104903Z died in \`measure\` on the same row in rounds 3 and 5 because ` +
        `nothing withdrew it.`
    );
    for (const row of [...q.held.values()].sort((a, b) => (a.file + a.at).localeCompare(b.file + b.at))) {
      lines.push(`submissions: unmeasurable ${row.file}[${row.at}]${row.id ? ` "${row.id}"` : ""} — ${row.faults[0].why}`);
    }
  }
  if (q.unplaced.length) {
    lines.push(
      `submissions: ${q.unplaced.length} unmeasurable claim(s) name a row that is no longer in ` +
        `${relative(REPO_ROOT, paths.proposalsDir) || paths.proposalsDir} — it has already been removed or ` +
        `replaced, so nothing is held for them`
    );
  }
  return lines;
}

/**
 * One item per answers file holding a row the measurement could not measure.
 *
 * WHY AN ITEM AT ALL, when the side is already back in the brief. The side
 * coming back asks "which argument values take this side"; it does not say
 * that a row on disk already claims it and was measured not to reach it. An
 * answering turn that writes a SECOND row for that side leaves the first one
 * standing, and the first one is what `measure` refuses on — so the next round
 * dies exactly where rounds 3 and 5 of run `20260919T104903Z` died. The item
 * names the document to replace.
 *
 * BOUNDED BY THE HANDOVER, like `quarantineProblems`: a file already in front
 * of the answering turn is not asked about twice.
 */
function unmeasurableProblems(judgement, paths, asked) {
  const q = judgement.unmeasurable ?? NOTHING_UNMEASURABLE;
  if (!q.held.size) return [];
  const answers = relative(REPO_ROOT, paths.answersDir) || paths.answersDir;
  const proposals = relative(REPO_ROOT, paths.proposalsDir) || paths.proposalsDir;
  const byFile = new Map();
  for (const row of q.held.values()) {
    if (!byFile.has(row.file)) byFile.set(row.file, []);
    byFile.get(row.file).push(row);
  }
  const problems = [];
  for (const [file, rows] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const submission = join(paths.answersDir, file);
    const submitted = existsSync(submission);
    const where = submitted ? relative(REPO_ROOT, submission) || submission : `${proposals}/${file}`;
    const why = [
      `${rows.length} row(s) of ${proposals}/${file} claim a side the last measurement could not measure. ` +
        `coverage.mjs is the tool that said so, and it says it about the RECORDED row rather than about the ` +
        `document's shape — validate.mjs is content with these rows.`,
      ...rows.map((r) => `  ✗ ${r.id ?? `${r.file}[${r.at}]`}: ${r.faults.map((f) => f.why).join("; ")}`),
      `  They are QUARANTINED: they stay on disk, they stop counting as an answer, and every side they named is ` +
        `back in the brief as an open question. Until one of them is corrected or its claim withdrawn, every walk ` +
        `that reaches stage 6 refuses on it again — which is what rounds 3 and 5 of run 20260919T104903Z did, ` +
        `byte for byte.`,
      submitted
        ? `  RESUBMIT ${where} with the claim corrected — or with the row's \`reaches\` no longer naming that side, ` +
          `which is a withdrawal and is a legitimate answer. A submission under the same file name REPLACES the ` +
          `document on disk, so send the whole corrected document, not a patch.`
        : `  This did not come from a submission that is still on disk — ${answers}/${file} is not there. Submitting ` +
          `a document as ${answers}/${file} replaces it; leaving it quarantined returns its sides to the brief.`,
    ];
    const problem = {
      id: answerId(where, "(coverage.mjs)", rows.map((r) => `${r.id}`).sort()),
      file: where,
      at: "(coverage.mjs)",
      field: file,
      entry: null,
      by: "coverage.mjs",
      why: why.join("\n      "),
      resubmit: {
        file: submitted ? where : null,
        landedAs: `${proposals}/${file}`,
        replacesOnResubmit: true,
        quarantined: rows.map((r) => `${r.file}[${r.at}]${r.id ? ` ${r.id}` : ""}`),
      },
    };
    if (!asked?.has?.(problem.id)) problems.push(problem);
  }
  return problems;
}

/**
 * The quarantine, said out loud.
 *
 * A row set aside silently is a coverage number nobody can explain afterwards,
 * so every held row is named with its address and its fault count, and the
 * sentence that matters — its side went back to being asked — is said once at
 * the top rather than implied.
 */
function quarantineDid(judgement, paths) {
  if (!judgement.ran || judgement.status === 0 || !judgement.faults.length) return [];
  const lines = [];
  if (judgement.held.size) {
    lines.push(
      `submissions: validate.mjs exited ${judgement.status} — ${judgement.faults.length} fault(s); ` +
        `${judgement.held.size} row(s) QUARANTINED. They stay on disk and stop counting: every side they name is ` +
        `back in the brief as an open question, and the rows that validated are left to record.`
    );
    for (const row of [...judgement.held.values()].sort((a, b) => (a.file + a.at).localeCompare(b.file + b.at))) {
      lines.push(
        `submissions: quarantined ${row.file}[${row.at}]${row.id ? ` "${row.id}"` : ""} — ` +
          `${row.faults.length} fault(s): ${row.faults[0].why}`
      );
    }
  }
  for (const d of judgement.duplicates ?? []) {
    const where = d.copies.map((c) => `${c.file}[${c.at}]`).join(" and ");
    lines.push(
      d.keep
        ? `submissions: duplicate id "${d.id}" in ${where} — DECIDED: ${d.why}. The kept copy counts as an answer ` +
          `again; the others stay on disk, set aside`
        : `submissions: duplicate id "${d.id}" in ${where} — ${d.why}, so every copy stays set aside and the choice ` +
          `between them goes to the agent as one question`
    );
  }
  if (judgement.unplaced.length) {
    lines.push(
      `submissions: ${judgement.unplaced.length} fault(s) name no row this step can place, so nothing is set aside ` +
        `for them and stage 3 stays open on them — ${relative(REPO_ROOT, paths.proposalsDir) || paths.proposalsDir}`
    );
  }
  return lines;
}

/* --------------------------------------------------------------------------
 * A CITATION REFUSAL SAYS WHICH SITUATION IT IS
 *
 * `checkEvidence` has one sentence for two situations and they need opposite
 * moves. "does not list in `covers`" reads as *this citation is wrong*, and the
 * cheapest way to make it go away is to delete the `from` or to retype it at
 * something the row does cover with no reading behind it. Both are FABRICATED
 * PROVENANCE, which is strictly worse than the refused row: the refused row
 * comes back as a question, the fabricated one records a value nothing sourced
 * and `validate.mjs` is the only thing between a cited value and an invented
 * one.
 *
 * The honest case is common and the tool's wording does not admit it exists. A
 * driver's parameter is not the subject's arm; a value read in the function's
 * entry region is not the branch arm below it. Neither citation is dishonest
 * and both are refused, because `from.arm` is not "where the bytes are" — that
 * is `from.evidence`, a `file:line`, which takes any location in the repo and
 * is checked for existence rather than for membership. `from.arm` is which of
 * THIS ROW's sides the value serves, and a row can only be run against those.
 *
 * So the refusal says both halves: which of yours to name, and where the true
 * location goes so that naming one costs nothing.
 * ------------------------------------------------------------------------ */

/** Both of `checkEvidence`'s `from.arm` verdicts — the cited one and the built one. */
export const isCitationFault = (fault) => /`from\.arm`/.test(String(fault?.why ?? fault?.line ?? ""));

export const CITATION_HELP =
  "ABOUT THE `from.arm` FAULT(S) ABOVE — this is the citation rule, not a claim that your reading is wrong. " +
  "`from.arm` must be one of the armIds THIS ROW lists in `covers` (validate.mjs `checkEvidence`); an id built " +
  "out of a functionId or a path and a line is refused by the same check as \"not an arm in scan.json\". Where " +
  "the value genuinely comes from outside this row's `covers` — a parameter of the `via` driver, a line in the " +
  "function's entry region above your branch — that location belongs in `from.evidence` as a `file:line`, with " +
  "the sentence in `from.reading`, and `from.arm` names the arm of yours the value serves. DO NOT DELETE A " +
  "`from` TO CLEAR THIS and do not point one at an arm you did not read: a row refused for a citation comes " +
  "back as a question, a row that passes on an invented citation records a value nothing sourced. Your item's " +
  "`proposal.cite.arms` is the list to pick from.";

/** One fault, re-addressed: the row it is really about, then what it says. */
function faultLine(fault, rows) {
  const hit = locateFault(fault, rows);
  const one = hit.length === 1 ? hit[0] : null;
  const where = one
    ? `${one.file}[${one.at}]${one.id ? ` "${one.id}"` : ""}${fault.at ? fault.at : ""}`
    : `${fault.file ?? "(the proposals)"}${hit.length > 1 ? ` (all ${hit.length} row(s))` : ""}`;
  return `${fault.severity === "error" ? "✗" : "!"} ${where}: ${fault.why}`;
}

/**
 * THE REFUSAL, ADDRESSED TO THE SUBMISSION THE AGENT CAN ACTUALLY FIX.
 *
 * One item per file, never one for the directory. The old item named
 * `.claude/charpilot/proposals` — a directory the prompt forbids the agent from
 * writing to, correctly — so its only actionable content was the faults, and
 * `toolFailure` had already cut those to six lines. This names the
 * `charpilot-answers/` file to resubmit, carries EVERY fault against that file,
 * and says what resubmitting does.
 *
 * WHERE THE SUBMISSION CANNOT BE NAMED, IT SAYS SO. `propose.mjs` lands a
 * submission under its own file name (propose.mjs:targetName sanitises it and
 * forces `.json`, and is otherwise the identity), so the answers file is the
 * landed file's name — but only if it is still there. A proposal from an
 * earlier run, or one whose submission has since been deleted, has no file to
 * name, and guessing one sends the agent to rewrite something that was correct.
 *
 * BOUNDED. A group already in the handover on disk is not asked again: the
 * quarantine has already returned its sides to the brief, and THAT is the
 * convergent move. Re-asking "fix these rows" every round is what run
 * `20260916T165524Z` did for 25 minutes and $2 with no progress.
 */
function quarantineProblems(judgement, paths, asked, wroteProposal = true) {
  if (!judgement.ran || judgement.status === 0) return [];
  const problems = [];
  const answers = relative(REPO_ROOT, paths.answersDir) || paths.answersDir;
  const proposals = relative(REPO_ROOT, paths.proposalsDir) || paths.proposalsDir;

  // NOTHING THIS STEP CAN READ. validate.mjs refused and printed no finding
  // either marker matches — an empty directory, a crash, a future format. The
  // whole refusal goes over verbatim, nothing is set aside for it, and
  // `satisfied` still holds the run on it: closing over a refusal nobody could
  // read is how a side gets counted that nothing validated. It is also NOT
  // bounded by the handover, because a question this step stops asking while
  // still refusing to close is a round with nothing in front of the agent.
  if (!judgement.faults.length) {
    /* -------------------------------------------------------------------- *
     * ASKED WHETHER OR NOT THIS ROUND WROTE A PROPOSAL, AND IT WAS NOT.
     *
     * WHAT THIS USED TO DO. The item below was suppressed — `return []` —
     * unless a proposal had been materialised in THIS round. The no-submission
     * path at materialise():1119 passes `wroteProposal: false` by definition,
     * because it is the path taken when there was nothing to materialise.
     *
     * WHAT THAT COST. `satisfied` does not care who wrote the proposals: it
     * ends at `judgement.faults.length > 0 && judgement.unplaced.length === 0`,
     * so a validate.mjs that refuses the DIRECTORY and prints no finding either
     * marker matches leaves `faults` empty and `satisfied` false — for ever,
     * over proposals written in an earlier round. The step then refuses with
     * nothing in front of anybody, which is the state the comment directly
     * above says must not happen ("a question this step stops asking while
     * still refusing to close is a round with nothing in front of the agent").
     * The suppression and that sentence contradicted each other, and the
     * suppression won on the one path where it mattered.
     *
     * WHY NOT INSTEAD RELAX `satisfied`. Because the refusal is real: a
     * proposals directory that does not validate, for a reason nothing here can
     * resolve to a row, is a directory whose rows may be answering sides with
     * values nothing sourced. Closing over it is what validate.mjs exists to
     * prevent. The question is whether the run can be TOLD; it can, and now is.
     *
     * THE NARROWING THAT REPLACES IT, and it is about the DIRECTORY rather than
     * about this round: the item is raised when there are proposals to refuse.
     * `validate.mjs` also exits non-zero over a directory with nothing in it,
     * and that is not a refusal of anybody's answer — it is the ordinary first
     * round, where the open sides in the brief are the question and `satisfied`
     * is false for that reason. Asking there would put an item about "the
     * proposals do not validate" in front of a turn that has not written one.
     *
     * `wroteProposal` is still read, below, for what it is actually evidence of
     * — see the sentence it now carries into the item.
     * -------------------------------------------------------------------- */
    if (!wroteProposal && !judgement.rows.length) return [];
    return [
      {
        id: answerId(here(paths.proposalsDir), "(validate.mjs)", null),
        file: here(paths.proposalsDir),
        at: "(validate.mjs)",
        field: "(the proposals)",
        entry: null,
        by: "validate.mjs",
        why:
          `${toolFailure("the proposals that landed do not validate", judgement.script, judgement.res)}\n      ` +
          `Nothing here could resolve that to a row, so no proposal was set aside and stage 3 stays open on it. ` +
          (wroteProposal
            ? `A proposal landed THIS round, so the document just submitted is the first place to look. `
            : `NOTHING WAS SUBMITTED THIS ROUND, so this is about proposals that were already on disk — reading the ` +
              `last submission again will not find it. `) +
          `Correct the document in ${answers} and resubmit it — a submission under the same file name REPLACES the ` +
          `document on disk.`,
        resubmit: { file: null, landedAs: null, replacesOnResubmit: true, quarantined: [] },
      },
    ];
  }
  // The faults `quarantineRows` could not pin to any row, by identity. Identity
  // and not id: these are the same objects `judgeProposals` put in both lists,
  // and a fault carries no field that is unique to it.
  const unplaced = new Set(judgement.unplaced ?? []);
  const byFile = new Map();
  for (const fault of judgement.faults) {
    // A `duplicate id` is about two files at once, so it is decided or asked
    // as ONE question below (`duplicateIdProblems`), not once per file. Only
    // when `decideDuplicates` saw it: a fault it could not pair with two rows
    // stays an ordinary fault of its file.
    const dupId = duplicateIdOf(fault);
    if (dupId !== null && (judgement.duplicates ?? []).some((d) => d.id === dupId)) continue;
    const key = fault.file ?? "(no file named)";
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(fault);
  }

  for (const [file, faults] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const named = file !== "(no file named)";
    const submission = named ? join(paths.answersDir, file) : null;
    const submitted = submission !== null && existsSync(submission);
    const where = submitted ? relative(REPO_ROOT, submission) || submission : named ? `${proposals}/${file}` : proposals;
    const heldHere = [...judgement.held.values()].filter((r) => r.file === file);
    // MIS-ADDRESSED BY THE PRINTER, and worth saying only when it actually is:
    // validate.mjs's index is into the whole directory, so it matches the row's
    // own position only for the first file it read.
    const misprinted = faults.some((f) => {
      const hit = locateFault(f, judgement.rows);
      return hit.length === 1 && Number.isInteger(f.index) && f.index !== hit[0].at;
    });

    const why = [
      `${named ? `${proposals}/${file}` : "the proposals directory"} does not validate: ` +
        `${relative(REPO_ROOT, judgement.script) || judgement.script} exited ${judgement.status} and reported ` +
        `${faults.length} fault(s) against it. All ${faults.length} are below — none is omitted, because fixing one ` +
        `per round is the stall this item exists to end.`,
      ...faults.map((f) => `  ${faultLine(f, judgement.rows)}`),
    ];
    if (faults.some(isCitationFault)) why.push(`  ${CITATION_HELP}`);
    if (misprinted) {
      why.push(
        `  (validate.mjs indexes the WHOLE proposals directory flattened, so the \`[n]\` it printed is not a ` +
          `position in this file. The addresses above are this step's, resolved back to the row.)`
      );
    }
    if (heldHere.length) {
      why.push(
        `  ${heldHere.length} row(s) of this file are QUARANTINED for this round: they stay on disk, they stop ` +
          `counting as an answer, and every side they named is back in the brief as an open question. The rows that ` +
          `validated are untouched and go on to be recorded, so the run advances whether or not these are fixed.`
      );
    }
    why.push(
      submitted
        ? `  RESUBMIT ${where}. A submission under the same file name REPLACES the document on disk, so send the ` +
          `whole corrected document, not a patch. Removing a row instead of fixing it is also fine and is not an ` +
          `answer: its side simply goes back to being asked.`
        : named
          ? `  This did not come from a submission this round — ${answers}/${file} is not there, so nothing here can ` +
            `name the file that produced it and naming one would be a guess. Submitting a document as ` +
            `${answers}/${file} replaces it; leaving it quarantined returns its sides to the brief.`
          : `  This fault names no file, so no row could be set aside for it and stage 3 stays open until it clears. ` +
            `Read the tool's own output above.`
    );

    const problem = {
      // STABLE OVER THE FAULTS AND NOTHING ELSE. The old id hashed
      // `stdout + stderr`, which carries validate.mjs's stage-3 clock line
      // (validate.mjs:405) — a minute counter — so the same refusal minted a new
      // id every round and `satisfied` could never recognise it as already
      // asked. The fingerprint is over the faults, so it changes when they do.
      id: answerId(where, "(validate.mjs)", faults.map((f) => f.line).sort()),
      file: where,
      at: "(validate.mjs)",
      field: named ? file : "(the proposals)",
      entry: null,
      by: "validate.mjs",
      why: why.join("\n      "),
      resubmit: {
        file: submitted ? where : null,
        landedAs: named ? `${proposals}/${file}` : null,
        replacesOnResubmit: true,
        quarantined: heldHere.map((r) => `${r.file}[${r.at}]${r.id ? ` ${r.id}` : ""}`),
      },
      faults: faults.map((f) => ({ severity: f.severity, at: f.at, proposal: f.proposal, why: f.why, printed: f.line })),
    };
    /* -------------------------------------------------------------------- *
     * BOUNDED ONLY WHERE SOMETHING ELSE IS STILL ASKING.
     *
     * The bound is right for a PLACED fault and it stays: the rows it condemned
     * are quarantined, every side they named is back in the brief as an open
     * question, and re-asking "fix these rows" each round is what run
     * 20260916T165524Z did for 25 minutes and $2 with no progress. The side is
     * the question now, and there are two questions where there should be one.
     *
     * IT WAS WRONG FOR AN UNPLACED FAULT, AND THAT ONE WEDGES THE RUN.
     * `locateFault` returns nothing when a fault names no file, or names a file
     * with no row in it — `quarantineRows` then carries it as `unplaced`,
     * NOTHING IS SET ASIDE FOR IT, and no side goes back into the brief. So
     * after the single round in which it was asked, the bound silences it while
     * `satisfied` goes on refusing on `judgement.unplaced.length === 0`
     * (steps/derive.mjs's own final predicate). That is a step that is not
     * satisfied, hands over nothing, and cannot be made satisfied by running
     * again: the walk's "ran and is still not satisfied, and it asked no
     * question" refusal, arrived at by a guard meant to stop a loop.
     *
     * KEEPING THE ITEM RATHER THAN DROPPING `unplaced` FROM THE PREDICATE, and
     * both were available. Dropping it would close stage 3 over a refusal
     * nobody read — the fault is still a fault, the rows it was about are still
     * counted as answers, and nothing downstream would ever mention it again.
     * Keeping the item asks the one turn that can actually resolve it, every
     * round, for as long as it is genuinely unresolved; when it is resolved the
     * fault is gone and the item goes with it. An unbounded question that
     * disappears the moment it is answered is not a loop.
     * -------------------------------------------------------------------- */
    const holdsUnplaced = faults.some((f) => unplaced.has(f));
    if (!holdsUnplaced && asked?.has(problem.id)) continue;
    problems.push(problem);
  }
  // BOUNDED BY THE HANDOVER like a placed fault: every copy is held, so a
  // question already in front of the answering turn is not asked twice.
  for (const problem of duplicateIdProblems(judgement, paths)) {
    if (!asked?.has(problem.id)) problems.push(problem);
  }
  return problems;
}

/**
 * The question a duplicated id the rule could not decide asks: KEEP ONE.
 *
 * ONE ITEM PER ID, naming every copy and saying, for each file, the move that
 * keeps the OTHER copy — the row taken out of a file that has other rows, or
 * given an id of its own in a file where it is the only row (propose.mjs
 * refuses an empty document, so "remove it" is not a move there). The id is
 * fingerprinted over the copies, so a copy the agent edits without resolving
 * the clash is asked about again rather than read as already asked.
 */
export function duplicateIdProblems(judgement, paths) {
  const answers = relative(REPO_ROOT, paths.answersDir) || paths.answersDir;
  const proposals = relative(REPO_ROOT, paths.proposalsDir) || paths.proposalsDir;
  const out = [];
  for (const d of judgement?.duplicates ?? []) {
    if (!d || d.keep || (d.copies ?? []).length < 2) continue;
    const copies = d.copies.map((c) => {
      const submitted = existsSync(join(paths.answersDir, c.file));
      return { ...c, submission: submitted ? `${answers}/${c.file}` : null, only: (d.rowsInFile?.[c.file] ?? 0) <= 1 };
    });
    const moves = copies.map((c) => {
      const others = copies.filter((o) => o !== c).map((o) => o.file).join(", ");
      const to = c.submission ?? `${answers}/${c.file}`;
      return c.only
        ? `to keep the copy in ${others}, resubmit ${to} with this row under an id of its own (it is that file's only ` +
            `row, and an empty document is refused)`
        : `to keep the copy in ${others}, resubmit ${to} without the row "${d.id}" — the whole document, since it ` +
            `REPLACES the file, with its other rows kept`;
    });
    const why = [
      `row id "${d.id}" is in ${copies.length} proposals files — ${copies.map((c) => `${proposals}/${c.file}[${c.at}]`).join(" and ")} — ` +
        `and one row id may live in ONE file: validate.mjs refuses every copy as \`duplicate id\`, so every copy is ` +
        `QUARANTINED — on disk, counting as no answer — until one is gone.`,
      `  Nothing measured decides between them: ${d.why}. KEEP ONE, deliberately:`,
      ...moves.map((m) => `  - ${m};`),
      `  or, if both rows are wanted, give either one an id of its own. Nothing else in either file needs to change.`,
    ];
    const first = copies.find((c) => c.submission) ?? copies[0];
    out.push({
      id: answerId(`duplicate id "${d.id}"`, "(validate.mjs)", copies.map((c) => [c.file, c.at, c.row])),
      file: first.submission ?? `${proposals}/${first.file}`,
      at: "(duplicate id)",
      field: d.id,
      entry: null,
      by: "validate.mjs",
      why: why.join("\n      "),
      resubmit: {
        file: first.submission,
        landedAs: `${proposals}/${first.file}`,
        replacesOnResubmit: true,
        quarantined: copies.map((c) => `${c.file}[${c.at}] ${d.id}`),
      },
      duplicate: { id: d.id, copies: copies.map((c) => ({ file: c.file, at: c.at, submission: c.submission, onlyRow: c.only })), why: d.why },
    });
  }
  return out;
}

/**
 * Every uncovered side, split into what is answered and what is open.
 *
 * INSTRUMENTED ONLY, which is the ledger's universe and not an oversight. A
 * `catch` arm is real work and istanbul's branch map cannot verify it, so it
 * never ratchets and `pilot:ledger` never demands an account of it — a step
 * that asked about it could never become satisfied, and the walk would hand the
 * same items over forever while the gate said the stage was closed. They are
 * counted in `metrics` instead, so "not asked about" is visible rather than
 * silent.
 */
export function openSides(worklist, { proposed, declared, undeliverable = null, covered = null }) {
  const open = [];
  let proposedCount = 0;
  let declaredCount = 0;
  let notInstrumented = 0;
  // D46: covered by the last measurement and claimed by nothing. See measuredCoveredIndex.
  let coveredCount = 0;
  const undeliverableSides = [];

  for (const item of worklist.items ?? []) {
    for (const side of item.uncoveredSides ?? []) {
      if (!item.instrumented) {
        notInstrumented += 1;
        continue;
      }
      const k = sideKey(item.armId, side);
      if (proposed.has(k)) proposedCount += 1;
      else if (declared.has(k)) declaredCount += 1;
      else if (covered?.has(k)) coveredCount += 1;
      // D64. ASKED LAST, so a side somebody has already answered or already
      // written a reason for is counted as that and not as this: the three
      // populations are exclusive here and `proposedCount + declaredCount +
      // undeliverableSides.length + open.length` is still every instrumented
      // uncovered side. It is NOT a fourth kind of answer — see `undeliverableIndex`.
      else if (undeliverable?.has(k)) undeliverableSides.push({ item, side, verdict: undeliverable.get(k) });
      else open.push({ item, side });
    }
  }
  return { open, proposedCount, declaredCount, notInstrumented, undeliverableSides, coveredCount };
}

/* ------------------------------------------------------------------------ *
 * D48 — WHICH OF LAST ROUND'S PACKETS FINISHED, JOINED ON SIDE IDS.
 *
 * WHAT THIS REPLACED AND WHAT IT COST. The count used to be "how many of the
 * names we reserved have a file on disk under that name", and it reported
 * `packets: 0 of the 33` on tracy-worker and `0 of 34` on location-ms in the
 * same week location-ms closed 127 sides. Both numbers were wrong in the same
 * way: workers name their submissions `w1-packet-15-server-error-handler.json`,
 * the reserved name is `answers-<12 hex>.json`, and a metric keyed on the file
 * name therefore reported total failure through two runs that worked. It is
 * harmless to the work and fatal to any scheduler built on it — rebalancing
 * the clusters that did not finish requires knowing which ones did.
 *
 * AND MATCHING ON A PACKET ID WOULD STILL HAVE BEEN WRONG, which is why this
 * joins one level down. Completion in this pipeline is many-to-many and the
 * run logs say so in their own words:
 *
 *   "Worker 3 finished - all 6 packets (13 sides, merged into 8 proposal rows
 *    across 6 files)"
 *   "Worker 4 finished - all 19 sides across its 6 packets answered (13
 *    proposals + a code-dead declaration cluster)"
 *
 * One submission answers several packets. One packet yields several rows, in
 * several files. Some of a packet's sides are answered by a proposal while
 * others are declared dead, and both of those are answers. The only thing that
 * is one-to-one anywhere in that is the SIDE: a proposal names the sides it
 * reaches byte-exact in `reaches`, a declaration names its arm and side in
 * BLOCKED.md, and `openSides` already counts both. So the join is on sides,
 * and packet completion is DERIVED from it rather than declared by a name:
 *
 *     a packet is finished when every side it holds is answered or declared.
 *
 * WHAT THIS COUNTS AND WHAT IT DOES NOT. It counts the packets the LAST round
 * handed over, against the answers on disk NOW — so it is read after the
 * submissions have been materialised, and a submission that validate.mjs
 * quarantined does not count, because `proposedSides` drops a held row. It says
 * nothing about how long a packet took, which worker held it, or whether it was
 * ever started: there is no per-packet clock in this pipeline yet, and
 * `packetlog.mjs` is where the distribution that would give it one accumulates.
 * ------------------------------------------------------------------------ */

/**
 * A `sideKey` read back as the `sideId` a packet roster prints.
 *
 * The two spellings exist because they serve different readers — `sideKey` is
 * NUL-joined so a side label containing a bracket cannot be split on, and
 * `sideId` is the printable address the ledger and the handover both use. This
 * is the one conversion between them, written once so the join cannot drift
 * from the roster it joins against.
 */
export const sideIdOfKey = (key) => {
  const text = String(key ?? "");
  const at = text.indexOf("\u0000");
  return at === -1 ? text : sideId(text.slice(0, at), text.slice(at + 1));
};

/**
 * Every side that now carries an answer of either kind, as roster ids.
 *
 * BOTH KINDS, and that is the half a `packet_id` match would have lost. A side
 * with a written reason is as finished as a side with a proposal — run
 * 20260919T092106Z's round 1 closed 127 sides with a declaration cluster among
 * them — and a packet whose last two sides are code-dead is a packet nobody
 * should be waiting on.
 */
export function answeredSideIds({ proposed, declared } = {}) {
  const out = new Set();
  for (const key of proposed?.keys?.() ?? []) out.add(sideIdOfKey(key));
  for (const key of declared?.keys?.() ?? []) out.add(sideIdOfKey(key));
  return out;
}

/**
 * Last round's packets against the answers on disk, one row each.
 *
 * `headers` are the packet headers the last round wrote, read off its own
 * index by `headersInHandover`; `answered` is `answeredSideIds` over the
 * proposals and declarations that exist now.
 *
 * A HEADER THAT IS NOT A PACKET OF SIDES IS COUNTED SEPARATELY rather than
 * scored either way, and there are two of them. A round also hands back refused
 * submissions, recorded contradictions and recorder outcomes, and the walk
 * files each of those under a header of its own (`soloHeader`) whose roster
 * holds the ITEM's id rather than a side id. Joining those against the answered
 * sides would score them permanently unfinished and the ratio would sink round
 * by round for reasons that have nothing to do with packets. The discriminator
 * is `functionId`: `packetHeader` always writes that key and `soloHeader` never
 * does, so it separates the two exactly rather than by guessing at the shape of
 * an id. An empty roster is excluded for the mirror reason — "every side it
 * holds is answered" is vacuously true of a packet holding none.
 */
/* --------------------------------------------------------------------------
 * D53 — A ROUND THAT DEALT NOTHING MUST SAY WHY IT DEALT NOTHING.
 *
 * THE DEFECT, run `20260919T104903Z` (location-ms, 9 rounds):
 * `derive: packetsHandedOutLastRound=0` in rounds 1, 4, 6 AND 8 — four of
 * nine, where one is normal and is round 1. `sidesClosed` is computed by
 * `packetCompletion` over the sides the previous round DEALT, so when nothing
 * was dealt the count is zero BECAUSE NOTHING WAS ASKED, not because nothing
 * was bought. Downstream — the yield ratchet, the round row, any stall rule —
 * those two are indistinguishable, and the ratchet's own guard says so in
 * prose while having no way to tell them apart in data.
 *
 * THE THREE CASES, and all three are on that one run:
 *
 *   NO ROUND BEFORE  round 1. Nothing had been handed over, so nothing could
 *                    have been dealt. Not a defect and never was.
 *   NOTHING WAS OPEN rounds 4 and 9 — `open=0`, `handed=0`. The last round
 *                    asked about refused submissions and recorder outcomes and
 *                    about no side, because no side was open. Also not a
 *                    defect: it is the shape of a run that is finishing.
 *   WALK DIED UPSTREAM rounds 6 and 8, after rounds 5 and 7 died inside
 *                    `measure`. Sides WERE open — four of them, for five
 *                    rounds — and nobody was asked about one. That is the run
 *                    killer, and it is the case that wants a different
 *                    response from the other two.
 *
 * READ OFF THE HANDOVER'S OWN `step` KEY, which is the walk's record of which
 * step wrote the round. Nothing new is stored: `handoverStep` reads one word
 * out of the index `headersInHandover` already opens.
 * ------------------------------------------------------------------------ */

/* --------------------------------------------------------------------------
 * THE THREE REASONS, SPELLED ONCE — AND THEY ARE SPELLED IN `packetlog.mjs`.
 *
 * They moved there when D54's stall rule was built. The words are the vocabulary
 * of the ROUND ROW: `recordRoundClock` writes `dealtNothingReason`,
 * `readRoundClocks` reads it back, and `stallRule` decides on it. A rule that
 * matched a string this file owns would be the second spelling of a word two
 * files have to agree on, which is the defect `packetlog.mjs`'s own header is
 * about. This file DECIDES which of the three it is; that file owns what they
 * are called and re-exports them here so every existing reader keeps working.
 * ------------------------------------------------------------------------ */
export { NO_ROUND_BEFORE, NOTHING_WAS_OPEN, UPSTREAM_DEATH } from "../packetlog.mjs";

/**
 * Why the last round dealt no packet of sides, or null when it dealt one.
 *
 * `handover` is `handoverStep`'s `{ present, step }`. An index that is present
 * and unparseable reads as an upstream death: something wrote a round this
 * step cannot recognise as a deal, and the safe reading is the one that makes
 * the next round ASK rather than assume the last one did.
 */
export function dealtNothing(handedOut, { present = false, step = null } = {}) {
  if (handedOut > 0) return null;
  if (!present) {
    return {
      reason: NO_ROUND_BEFORE,
      why: "no round was handed over before this one, so there is no deal to judge — a cold first round, or a walk re-entered with no agent turn between it and the last",
    };
  }
  if (HANDS_OVER_SIDES.includes(step)) {
    return {
      reason: NOTHING_WAS_OPEN,
      why: `the last round was handed over by \`${step}\` and carried no packet of sides, so nothing was open to deal — this zero is "nothing was asked for" and not "nothing was bought"`,
    };
  }
  return {
    reason: UPSTREAM_DEATH,
    why:
      `the last round was handed over by \`${step ?? "a step this file cannot read"}\`, which does not deal sides — ` +
      `the walk stopped before the step that does, so every side still open is one nobody was asked about. Run ` +
      `20260919T104903Z did this three times and four sides stayed open across five rounds`,
  };
}

export function packetCompletion(headers = [], answered = new Set(), handover = { present: false, step: null }) {
  const packets = [];
  let empty = 0;
  for (const header of headers ?? []) {
    const sides = Array.isArray(header?.sides) ? header.sides : [];
    if (!sides.length || !(header && Object.hasOwn(header, "functionId"))) {
      empty += 1;
      continue;
    }
    const open = sides.filter((s) => !answered.has(s));
    packets.push({
      id: header.id ?? null,
      functionId: header.functionId ?? null,
      file: header.file ?? null,
      answersFile: header.answers?.file ?? null,
      dealt: sides.length,
      closed: sides.length - open.length,
      open,
      finished: open.length === 0,
    });
  }
  const finished = packets.filter((p) => p.finished).length;
  return {
    packets,
    empty,
    handedOut: packets.length,
    finished,
    unfinished: packets.length - finished,
    sidesDealt: packets.reduce((n, p) => n + p.dealt, 0),
    sidesClosed: packets.reduce((n, p) => n + p.closed, 0),
    // NULL WHEN PACKETS WERE DEALT, and a reason when none were. Every reader
    // of `sidesClosed` inherits the ambiguity this resolves: a zero with a
    // reason beside it is a fact, and a zero on its own is two different facts
    // wearing one number.
    dealtNothing: dealtNothing(packets.length, handover),
  };
}

/**
 * Every side a quarantined row was the only answer for, as roster ids.
 *
 * TAKEN FROM THE OPEN LIST AND NOT FROM `reaches` ALONE. A held row may claim
 * a side that another row also answers, and that side is not freed by anything
 * — it was never closed by this row. So the claim is intersected with what
 * `openSides` says is open NOW, which is the only statement of what this
 * round has to ask about.
 */
export function freedSides(held, labelsByArm, open = []) {
  const openIds = new Set(open.map(({ item, side }) => sideId(item.armId, side)));
  const keys = new Set();
  const byRow = new Map();
  for (const [key, row] of held ?? []) {
    const mine = [];
    for (const [armId, sides] of Object.entries(row?.reaches ?? {})) {
      for (const side of sidesOf(sides, labelsByArm?.get(armId) ?? new Set())) {
        const id = sideId(armId, side);
        if (!openIds.has(id)) continue;
        keys.add(id);
        mine.push(id);
      }
    }
    if (mine.length) byRow.set(key, mine);
  }
  return { keys, byRow };
}

/**
 * The open list with the freed sides' OWNING FUNCTIONS at the front.
 *
 * WHOLE FUNCTIONS, because `nextBatch` deals whole functions and splitting one
 * to put a freed side first would pay for reading that function twice — the
 * cost `nextBatch`'s own docblock measures. Stable everywhere else: a side
 * that was not freed keeps its position relative to every other side that was
 * not freed, so a round with no quarantine is dealt byte for byte as before.
 */
export function freedFirst(open = [], freed = new Set()) {
  if (!freed.size) return open;
  const owners = new Set();
  for (const entry of open) {
    if (freed.has(sideId(entry.item.armId, entry.side))) owners.add(ownerKey(entry.item));
  }
  if (!owners.size) return open;
  const first = [];
  const rest = [];
  for (const entry of open) (owners.has(ownerKey(entry.item)) ? first : rest).push(entry);
  return [...first, ...rest];
}

/**
 * How many sides one round hands over, and why this many.
 *
 * 20 is the window `worklist.mjs --skeleton` already pages in — its own
 * `--batch` default, in the usage block at the top of nodejs/tools/worklist.mjs
 * and in the argv default that backs it. A round and a skeleton page being the
 * same size is not a coincidence worth breaking: the rows behind a handover are
 * then exactly one window of the tool that owns them, rather than a number
 * picked here because it sounded safe.
 *
 * What it costs, measured rather than assumed. On run 20260915T033521Z an item
 * is 4,143 bytes including its share of the wrapper, so a 20-side round is ~81
 * KB of out/worklist-decisions.json — the same order as the 34,233-byte `--json`
 * brief recipes.mjs measured for 40 functions, and three orders below the 3.3M
 * it records as unread. 40 sides would be ~162 KB and would halve the rounds,
 * and it is not the byte count that argues against it but the turn: an agent
 * deriving 40 inputs answers the last of them with the first ones' evidence
 * long out of view, and an input derived from nothing is precisely what
 * validate.mjs refuses.
 *
 * What it costs in rounds: location-ms's ~130 open sides on run
 * 20260916T031317Z close in 7, and the fleet's largest at ~945 in 48. A round
 * is one walk and one answering turn, which is what the loop is made of — the
 * walk is cheap, and 48 readable handovers deliver what 1 unreadable one does
 * not.
 */
export const DEFAULT_BATCH = 20;

/* ------------------------------------------------------------------------ *
 * D66 — A ROUND IS A CONCURRENCY AND A CLOCK, AND THE CONTEXT WEIGHT IS NOT
 * MEASURED.
 *
 * D46's two dials — `CHARPILOT_PACKET_FLOOR` at 34 packets and
 * `CHARPILOT_PACKET_CEILING` at 40 — no longer exist here, and nothing reads
 * either variable. `packetsPerRound` in handover.mjs sizes a round now, out
 * of the two things that actually move a round's wall clock — how many workers
 * run at once, and how long the round may take. The floor survives inside it,
 * as `ROUND_PACKET_FLOOR`, because a low concurrency cap must not be allowed to
 * cut a round that is already measured finishing; the ceiling does not survive,
 * because a ceiling in packets IS a wall clock with the concurrency baked in at
 * whatever it happened to be, and the budget states it directly.
 *
 * AND THE CONTEXT WEIGHT COMES OUT OF THE SIZING ALTOGETHER, because the
 * measurement contradicts it. D46 predicted that a packet in a 47 KB file costs
 * about four times a packet in a 12 KB one. Three repos later:
 *
 *   location-ms    34 packets ·  53 min · 6 workers → 9.4 min/packet   2-12 KB files
 *   tracy-worker  123 packets · 185 min · 6 workers → 9.0 min/packet   20-47 KB files
 *   qode-ptp-ms   161 packets · 199 min · 6 workers → 7.4 min/packet
 *
 * THOSE ARE SLOT MINUTES, NOT WHAT A PACKET COSTS. Wall clock times workers
 * over packets counts every minute a worker sat at the barrier. This block used
 * to read "a packet costs one worker about nine minutes"; the busy figure is
 * 4.1 — `handover.mjs:packetMinutes`, 135.5 worker-minutes of busy time over 33
 * packets on run `20260919T092410Z` round 1, against a slot figure of 8.9 for
 * that same round and 157 idle worker-minutes of barrier between them.
 *
 * WHAT THE TABLE DOES STILL SHOW is the thing it was built for: the repo whose
 * files are FOUR TIMES heavier is marginally the cheaper of the two. Source
 * bytes do not predict what a packet costs, so pricing tracy's round at a
 * quarter of location-ms's was a throttle with no measurement under it.
 *
 * THE SIZING CONCLUSION DOES NOT SURVIVE THE CORRECTED NUMBER, and it was
 * "tracy 13 rounds of 9 to 15 packets rather than 4 rounds of 60". At 4.1 busy
 * minutes and a 45-minute round, `packetsPerRound` deals 131 packets at a
 * subagent cap of 16 (dispatchable 12) and 87 at this repo's own default
 * ceiling of 10 (dispatchable 8) — either way tracy is a small number of
 * rounds, not thirteen:
 * QUOTES nodejs/tools/steps/handover.mjs: "tracy-worker's 203 packets are then 2 rounds instead of 13"
 * Thirteen rounds was the 9-minute answer. Two is this one.
 *
 * WHAT SURVIVES OF THE WEIGHT. `packetWeights` still computes and still reports
 * both terms — a reader deciding whether a round was mis-sized wants them — and
 * the DIFFICULTY term still prices a round, because it has evidence the context
 * term does not: location-ms's rounds 2 and 3 were made entirely of sides round
 * 1 had been handed and had not closed, and they closed 3 and about 6 for
 * 1,004s and 1,300s against round 1's 127 for 1,945s. A side coming back is
 * measurably dearer; a big file is not.
 *
 * WHAT IS MEASURED NOW, AND HOW FAR IT GOES. The table above is three round
 * totals divided by three worker counts; "nothing has ever timed ONE packet"
 * stopped being true when `tools/packetcost.mjs` landed. Its first spread ran
 * four real notification-ms packets end to end: 93 s (packet-06, 8 turns),
 * 166 s (packet-36, 19), 225 s (packet-16, 14) and 385 s (packet-41, 21) —
 * median 195 s, 3.3 minutes, which is the same order as the 4.1 above and
 * nothing like 9. Over all 15 rows that tool has recorded, seconds correlate
 * 0.83 with turns and 0.81 with brief bytes, so turns are NOT the clearly
 * better predictor on this data — neither is established.
 *
 * AND THE ROWS ARE NOT VENDORED. They live in `out/packetcost/`, which is
 * generated, so the four numbers above are a reading of one file on one
 * machine: re-run `node tools/packetcost.mjs --rows` rather than trust this
 * line. `recordPacketRun` in packetlog.mjs is still the ROUND's version of the
 * same row, and it is still empty until a parent fills it.
 * ------------------------------------------------------------------------ */

/**
 * The override, named the way config.mjs names every other one
 * (CHARPILOT_SCAN_OUT, CHARPILOT_WORKLIST_OUT, CHARPILOT_EXPECTED_DB): the
 * prefix, then the thing it points at.
 */
export const BATCH_ENV = "CHARPILOT_DERIVE_BATCH";

/**
 * This round's cap, from the environment or the default.
 *
 * REFUSED rather than defaulted when it is not a positive whole number, because
 * every wrong value is dangerous in a way a silent fallback would hide.
 * `CHARPILOT_DERIVE_BATCH=0` or `=-1` would hand over nothing while sides are
 * open, which the walk reads as a step that asked no question and reports as a
 * bug in this step — a diagnosis pointing at the wrong file. `=twenty` or
 * `=20,` would go on meaning 20 forever while somebody believes they changed
 * the one knob that decides how much of the backlog an agent is ever shown. An
 * unset or empty variable is not a wrong value; it is the default, which is how
 * config.mjs reads its own overrides.
 *
 * Read per call and not at import: the cap belongs to the round. A value fixed
 * when the module loaded could not be re-pointed by the test that proves the
 * override is honoured, and a step whose behaviour cannot be provoked in a test
 * is a step whose behaviour is a claim.
 */
/**
 * THE MOST PACKETS A ROUND SHOULD DEAL — GONE, AND SUBSUMED BY THE CLOCK.
 *
 * `CHARPILOT_PACKET_CEILING` was 40 packets, "set from the largest round anyone
 * has completed". That is a wall clock with the concurrency baked in at
 * whatever it was on the day: 40 packets is 60 minutes at 6 concurrent workers
 * and 30 at 12, and nothing in the name said which. `packetsPerRound()` in
 * handover.mjs says the clock and the concurrency out loud and multiplies them,
 * so there is nothing left for a ceiling in packets to bound.
 *
 * THE FLOOR SURVIVED THE MOVE and lives there too, as `ROUND_PACKET_FLOOR`: a
 * low concurrency cap must not cut a round below location-ms's proven 34
 * packets. It is the one direction a packet count is still the right unit,
 * because it is quoting a round that finished rather than predicting one.
 *
 * `CHARPILOT_PACKET_FLOOR` and `CHARPILOT_PACKET_CEILING` are therefore READ BY
 * NOTHING. Named here rather than deleted in silence, because an operator with
 * one of them in a run.env would otherwise watch it do nothing and have no way
 * to find out why. `CHARPILOT_ROUND_PACKET_FLOOR`, `CHARPILOT_ROUND_BUDGET_MIN`
 * and `CHARPILOT_PACKET_MINUTES` are what replaced them.
 */
/* ------------------------------------------------------------------------ *
 * D46 — A ROUND IS SIZED IN PACKETS, AND PACKETS ARE NOT THE SAME SIZE.
 *
 * SUPERSEDED IN PART BY D66 ABOVE, AND KEPT BECAUSE HALF OF IT IS STILL TRUE.
 * The CONTEXT term below no longer prices a round — three repos at 9.4, 9.0 and
 * 7.4 minutes a packet across a twentyfold spread in file size say source bytes
 * do not predict what a packet costs. It is still COMPUTED and still REPORTED,
 * because a reader asking why a round was the size it was wants to see it. The
 * DIFFICULTY term still prices a round; it is the half with a measurement.
 *
 * THE MEASUREMENT THIS BLOCK WAS WRITTEN FROM, two runs on the same build in
 * the same hour, both with zero errors. The floor was 34 packets and the
 * ceiling 40, so every repo in the fleet was handed about the same number:
 *
 *   location-ms   batch 146   34 packets   4.3 sides/packet   closed 127   1,945s
 *   tracy-worker  batch 126   33 packets   3.8 sides/packet   closed   0   3,008s
 *
 * The rounds are the same shape and the outcomes are not comparable. The
 * difference is what is IN the packets: location-ms's sit in small service
 * files, tracy-worker's in `agent.ts` (47 KB), `companyResearchAgent.ts`
 * (46 KB) and `bulkIntentSignalOrchestrator.ts` (20 KB). tracy's whole first
 * round — 647 child turns and 67.8M cache-read tokens — went into acquiring
 * context, and it closed nothing.
 *
 * So the unit stays a packet, because a packet is one function and one reading
 * and that is what a worker is paid for. What was added is a WEIGHT — and D66
 * is the measurement that says the attribution above is wrong. tracy's round
 * closed nothing for reasons this block guessed at from file sizes; the same
 * repo later did 123 packets in 185 minutes, 9.0 minutes a packet, which is
 * location-ms's own rate.
 *
 * TWO WEIGHTS AND NOT ONE, because they predict different things and a
 * scheduler that multiplies them into a single "size" will deal a round that is
 * cheap to read and impossible to answer and call it small:
 *
 *   CONTEXT COST is the source bytes of the files a packet's reading plan
 *   names. It predicts the cost of READING and nothing else, and it is
 *   available for free before the round — the handover already computes the
 *   reading plan, and a byte count is a `stat`.
 *
 *   SIDE DIFFICULTY is how hard the sides are to ANSWER, and source bytes say
 *   nothing about it. location-ms's rounds 2 and 3 closed 3 sides and about 6,
 *   at 1,004s and 1,300s — small files, cheap to read, and the sides left in
 *   them were the hard ones. The signal used here is the only one available for
 *   free: a side that was DEALT in an earlier round and is still open. That is
 *   exactly the population of location-ms's rounds 2 to 4, and it is read off
 *   the walk's own record of what it asked (`handedOver`), not off a guess.
 *
 * WHAT IS DELIBERATELY NOT IN THE WEIGHT, so the number is not read as more
 * than it is. The boundary MODULES in a packet's reading plan are not counted:
 * the skeleton that names them has not been spawned when the round is sized,
 * and the owning file is the dominant term anyway (47 KB against a handful of
 * imports). Nothing here knows how many turns a packet took or how long it ran,
 * because nothing in this pipeline records that yet — `packetlog.mjs` is where
 * that distribution accumulates, and until it has one this weight is a
 * prediction from bytes and history rather than from measured duration.
 * ------------------------------------------------------------------------ */

/**
 * The source bytes at which a packet weighs two packets instead of one.
 *
 * 12 KB, and it is a CHOICE with a stated basis rather than a measurement.
 * location-ms's service files — the repo whose 34-packet round finished in
 * 1,945s and closed 127 sides — are 2 to 12 KB, so at this reference its
 * packets weigh 1 and its round is the round it already had. tracy-worker's
 * three dominant files are 20, 46 and 47 KB, which weigh 1.6, 3.8 and 3.9: a
 * round of its heavy packets is dealt at roughly a quarter the count, which is
 * the direction the 3,008-second zero-yield round argues for.
 *
 * WHAT IT IS NOT: a measured cost per byte. Nobody has run a round at a known
 * weight and recorded what it cost, because per-packet timing does not exist —
 * that is step 3 of this plan and it is why the trigger that would use this
 * number is deliberately not built yet. Overridable for exactly that reason.
 */
export const PACKET_CONTEXT_BYTES = Math.max(
  1, Number(process.env.CHARPILOT_PACKET_CONTEXT_BYTES ?? 12288));

/**
 * The most one packet may weigh, in packets.
 *
 * A ROUND IS A FIXED PRICE — location-ms's rounds cost 1,945s, 1,004s and
 * 1,300s while closing 127, 3 and about 6 sides — so a round that deals ONE
 * monstrous packet pays a whole round's overhead for one function. Without this
 * clamp a single 400 KB file would do exactly that. At 8, a floor of 34
 * weighted packets still deals at least four packets however heavy they are.
 */
export const MAX_PACKET_WEIGHT = Math.max(
  1, Number(process.env.CHARPILOT_PACKET_MAX_WEIGHT ?? 8));

/**
 * What a side that has already been dealt and is still open weighs.
 *
 * 2, from location-ms's own tail: rounds 2 and 3 were made entirely of sides
 * round 1 had been handed and had not closed, and they closed 3 and about 6
 * sides for 1,004s and 1,300s against round 1's 127 for 1,945s. That is far
 * worse than 2x per side; 2 is deliberately conservative, because the
 * alternative — pricing the tail at what it actually cost — would collapse a
 * tail round to two or three packets and pay a full round's fixed price for
 * them. A number that is too small still points the right way.
 */
export const REDEALT_SIDE_WEIGHT = Math.max(
  1, Number(process.env.CHARPILOT_REDEALT_SIDE_WEIGHT ?? 2));

/**
 * A source file's size in bytes, or null when it cannot be asked.
 *
 * NULL AND NEVER A GUESS. `fleetsweep.mjs` sizes rounds for repos it has not
 * cloned, and a test weighs synthetic packets whose files are not on any disk;
 * both must get today's behaviour rather than a fabricated weight, so an
 * unstattable file weighs exactly one packet and the round is the round it
 * would have been before this existed.
 */
export function sourceBytes(file, { root = REPO_ROOT } = {}) {
  if (!file) return null;
  try {
    const at = resolve(root, String(file));
    const st = statSync(at);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * The open list as weighed packets, in the order the open list is in.
 *
 * One row per packet, carrying both weights separately as well as the product,
 * because a reader deciding whether a round was mis-sized needs to know WHICH
 * of the two made it heavy — a cheap-to-read, impossible-to-answer round and an
 * expensive-to-read, easy round want opposite responses.
 *
 * `dealtBefore` is the set of side ids the last handover asked about, from the
 * walk's own record. Absent, it is "nothing has been dealt yet", which is the
 * honest first-round answer and makes every side weigh 1.
 */
export function packetWeights(open = [], { root = REPO_ROOT, sizeOf = sourceBytes, dealtBefore = null } = {}) {
  const rows = [];
  for (const [key, entries] of groupByOwner(open)) {
    const item = entries[0].item;
    // THE FILE THE READING PLAN NAMES FIRST — where the function is DECLARED,
    // not where an arm's condition is. `readingPlan` makes the same call for
    // the same reason, and a weight taken from the arm's file would be a second
    // answer to "what does this packet read" that could disagree with the plan.
    const file = declaredAt(unitOf(item)?.functionId)?.file ?? item.file ?? null;
    const bytes = sizeOf(file, { root });
    // Floored at one packet: the turn, the brief and the answer cost the same
    // whatever the file weighs, so a 300-byte file is not a free packet.
    const context = bytes == null ? 1 : Math.max(1, bytes / PACKET_CONTEXT_BYTES);
    const sides = entries.map(({ item: i, side }) => sideId(i.armId, side));
    const redealt = dealtBefore ? sides.filter((s) => dealtBefore.has(s)).length : 0;
    // The MEAN over the packet's own sides, so a packet whose eight sides are
    // half fresh and half returning weighs 1.5 rather than 2. Difficulty is a
    // property of a side; context is a property of the reading they share.
    const difficulty = sides.length ? (sides.length - redealt + redealt * REDEALT_SIDE_WEIGHT) / sides.length : 1;
    rows.push({
      key,
      file,
      contextBytes: bytes,
      count: sides.length,
      sides,
      redealt,
      context,
      difficulty,
      weight: Math.min(MAX_PACKET_WEIGHT, context * difficulty),
    });
  }
  return rows;
}

/**
 * How many sides the first packets costing no more than `budget` carry.
 *
 * `budget` IS IN PACKETS, and a packet costs `difficulty` of them — 1 when
 * every side is fresh, up to `REDEALT_SIDE_WEIGHT` when every side is coming
 * back. The context term is deliberately not in this walk: see the D66 block
 * above for the three measurements that took it out.
 */
export function sidesWithin(weighed, budget, costOf = (p) => p.difficulty ?? 1) {
  let cost = 0;
  let sides = 0;
  for (const packet of weighed) {
    // AT LEAST ONE PACKET, ALWAYS. A round that handed over nothing while sides
    // are open is reported by the walk as a bug in this step, and one packet
    // over budget is the honest answer for a repo whose every packet is over
    // budget on its own.
    if (sides && cost + costOf(packet) > budget) break;
    cost += costOf(packet);
    sides += packet.count;
  }
  return sides;
}

/**
 * The batch this round should use when nobody has pinned one.
 *
 * A REPO'S BATCH IS A PROPERTY OF THE REPO. location-ms closes 146 sides in 4
 * rounds at 150; qode-ptp-ms carries 8,445 and at the default of 20 would need
 * 500 rounds, which at 12 rounds a run is 42 runs of mostly nothing. The same
 * constant cannot serve both, and the one that serves the small repo is the one
 * that makes the large repo look like it is not working.
 *
 * So: deal what this round can finish, and nothing else.
 *
 * `CHARPILOT_NODE_MAX_ROUNDS` NO LONGER SIZES A ROUND, and dropping it is the
 * point rather than a casualty. "Aim to finish in the rounds this run has" is
 * `ceil(open / rounds)`, which on qode-ptp-ms's 13,768 open sides at the
 * default of 12 asks for 1,147 sides — about 310 packets, a four-hour round —
 * and the old 40-packet ceiling existed mostly to catch it again afterwards. A
 * round that is sized by what it can finish does not need a second number
 * talking it out of a size it cannot. The knob still bounds how many rounds the
 * walk OPENS, which is `docker/char/packs/nodejs.py`'s loop and not this step;
 * `CHARPILOT_DERIVE_BATCH` is still the pin for a smoke run or a bisect.
 *
 *   want    = ceil(open / rounds)                 what finishing would take
 *   budget  = the sides of the first packets costing packetsPerRound() packets
 *
 * D66 — THE BUDGET IS A WALL CLOCK AND A CONCURRENCY, AND NOTHING IN IT IS A
 * PROPERTY OF THE REPO. `packetsPerRound()` is
 * `workerConcurrency x roundBudgetMin / packetMinutes`, floored at the 34-packet
 * round location-ms has already finished. At a cap of 16 that is 60 packets for
 * every repo on the fleet; at a cap of 8 it is the floor, 34.
 *
 * THERE IS NO SEPARATE ONE-ROUND CLAUSE ANY MORE and there does not need to be.
 * It existed because the weighted walk could shrink a round below the 34
 * packets location-ms is measured closing 127 of 146 sides in; the floor inside
 * `packetsPerRound` guards that directly, for every repo rather than only for
 * the ones that fit, and a packet costs 1 in this walk unless its sides are
 * coming back for a second time.
 *
 * WHAT FELL OUT WITH IT. The 40-packet ceiling bounds nothing — a ceiling
 * in packets is a wall clock with the concurrency baked in — and the context
 * weight no longer prices a packet, because three repos at 9.4, 9.0 and 7.4
 * minutes a packet across a 20x spread in file size say it does not predict
 * cost. Both arguments are written out at the top of this file's D66 block.
 *
 * FALLING SHORT IS THE EXPECTED OUTCOME ON A LARGE REPO, and it is not a
 * failure: the run hands over what it can deal, the closing line says what is
 * left and what it measured, and the next shard picks it up. What this must
 * never do is quietly hand over 20 because 20 was a good number for a service
 * a hundredth the size.
 */
export function dynamicBatch(open, { rounds = null, env = process.env, root = REPO_ROOT, sizeOf = sourceBytes, dealtBefore = null } = {}) {
  const n = Array.isArray(open) ? open.length : Number(open) || 0;
  if (n <= 0) return DEFAULT_BATCH;
  const perRound = packetsPerRound(env);

  // A BARE COUNT CARRIES NO PACKETS, so there is nothing to group and nothing
  // to weigh. 4 sides per packet is location-ms's own ratio and the only
  // defensible constant: it is what a caller holding a number rather than a
  // list is implicitly assuming anyway, and saying it here makes it visible.
  if (!Array.isArray(open)) return Math.min(n, perRound * 4);

  const weighed = packetWeights(open, { root, sizeOf, dealtBefore });
  // THE WHOLE OPEN LIST WHEN IT FITS IN THIS ROUND'S BUDGET. Stated as its own
  // clause so it is exact rather than approached: a repo with no more packets
  // than the budget is dealt entirely, and location-ms's 34 packets are that
  // repo at every concurrency this pipeline runs at.
  if (weighed.length <= perRound) return n;

  return Math.min(sidesWithin(weighed, perRound), n);
}

export function batchSize(opts = {}, env = process.env) {
  const fromOpts = opts.batch !== undefined;
  const given = fromOpts ? opts.batch : env[BATCH_ENV];
  const raw = fromOpts ? String(given) : String(given ?? "").trim();
  if (!fromOpts && raw === "") return DEFAULT_BATCH;
  // `auto` is resolved by the caller, which has the open sides this sizes
  // against. Reaching here means somebody asked this function directly.
  if (raw.toLowerCase() === "auto") return DEFAULT_BATCH;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `${fromOpts ? "the `batch` option" : BATCH_ENV} is ${JSON.stringify(given)}, which is not a batch size — it must ` +
        `be a whole number of sides, 1 or more. Unset it for the default of ${DEFAULT_BATCH}.`
    );
  }
  return Number(raw);
}

/**
 * The sides this round hands over, in the order that costs the reader least.
 *
 * GROUPED BY OWNING FUNCTION, with a function's sides kept together. The work
 * is per function and not per side: deriving one input means reading the
 * function — its parameters, its entry recipe, what its collaborators do — and
 * once that is read its siblings are nearly free. The vendored location-ms list
 * has one function owning 8 of its 31 open sides and another owning 4, so a
 * batch that split them across rounds would pay for reading
 * googleMap.service.ts twice to answer one function's worth of questions. An
 * arbitrary order wastes exactly that.
 *
 * The batch is filled a whole function at a time and STOPS at the first
 * function that will not fit, rather than skipping ahead to pack the last
 * slots. Successive rounds then walk the open list front to back, which is what
 * makes "held back" a count anybody can check against the previous round.
 * Nothing is lost by stopping short: the function that did not fit is the first
 * group of the next round.
 *
 * The ONE split is a function with more open sides than the whole cap, and it
 * is taken only when nothing else has been taken yet. It is that or a cap that
 * is not a cap — and a round that handed over zero items while sides are open
 * is reported by the walk as a bug in this step rather than as work to do.
 */
/* ------------------------------------------------------------------------ *
 * D63 — A CALLBACK IS NOT AN ADDRESSABLE UNIT OF WORK.
 *
 * MEASURED, run `20260919T142723Z` — location-ms on the full plan-17 build,
 * stopped at 127 minutes with 95.6% branches banked. Sixteen sides were left
 * open and TEN of them are branches inside anonymous callbacks:
 *
 *   3+3  src/services/googleMap.service.ts:179:<arg0 of resWithLanguage.forEach>
 *   2    src/services/googleMap.service.ts:383:<arg1 of trace.getTracer(…).startActiveSpan>
 *   1    src/services/googleMap.service.ts:131:<arg0 of retryRawLocations.forEach>
 *   1    src/services/location.service.ts:445:<arg0 of locations.reduce>
 *
 * The `functionId` is literally `<arg0 of resWithLanguage.forEach>`. THERE IS
 * NO SUCH FUNCTION TO CALL. A worker handed that packet cannot write an input
 * for it: to reach the arm it has to drive the ENCLOSING function with data
 * that makes the callback take it. The packet contract is "one function, and
 * its sides are the questions one reading of that function answers" — for a
 * callback the reading is right and the ADDRESS is missing. Rounds 4 through 8
 * of that run re-read the same file three times, filed rows that did not land,
 * and bought 1.0% in 87 minutes with zero child turns in three of them.
 *
 * SO THE PACKET'S UNIT BECOMES THE NEAREST ENCLOSING INVOCABLE FUNCTION and
 * the callback's sides become questions on that packet. One reading, one
 * input, N sides answered together. `googleMap.service.ts:112:parseAddressesForJd`
 * already had 5 open sides of its own on that run and lexically contains both
 * forEach callbacks, so eight of those sides are one packet rather than three.
 *
 * NOTHING ABOUT RECORDING OR VALIDATION CHANGES. The ROW keeps the callback's
 * own `functionId`, its own `via` driver, its own entry recipe and its own
 * boundaries — `contextFor` is untouched. What moves is the ADDRESS the work is
 * filed under: the grouping key, the reading plan, the packet weight and the
 * packet header. This is the same class as `frontdoor.mjs`'s `no-own-entry`
 * refusal, which is 486 sides fleet-wide.
 *
 * TWO THINGS THAT MUST NOT HAPPEN, both pinned by
 * `derive.a-callback-is-addressed-through-its-enclosing-function.test.mjs`:
 *
 *   1. An enclosing function must not absorb sides from callbacks it does not
 *      LEXICALLY contain. Sharing a file is not containment, and a sibling
 *      function two declarations down would otherwise collect arms nothing in
 *      its body can reach.
 *   2. A callback whose nearest enclosing function is ITSELF unaddressable is
 *      REFUSED rather than walked further up. The scan's own `via.driver`
 *      walks to the first REACHABLE ancestor (scan.mjs:1167) and that is the
 *      wrong answer here: driving a grandparent to reach a callback inside a
 *      callback is a claim this step cannot support, and a packet addressed to
 *      a function two hops away is a worse lie than one addressed to nothing.
 *      Those sides keep their own address exactly as they have it today.
 * ------------------------------------------------------------------------ */

/**
 * A function name the scan minted because the function is SYNTACTICALLY AN
 * ARGUMENT TO A CALL. `scan.mjs:deriveName` writes `<argN of callee>` and only
 * writes it when the parent node is a CallExpression, so this is a fact about
 * the syntax and not a guess from the shape of the string.
 */
export const CALL_ARGUMENT_NAME = /^<arg\d+ of /;

/** Every scanned function of a file, memoised against the scan map it came from. */
const FUNCTIONS_BY_FILE = new WeakMap();
function functionsByFile(scan) {
  if (!(scan instanceof Map)) return new Map();
  const cached = FUNCTIONS_BY_FILE.get(scan);
  if (cached) return cached;
  const byFile = new Map();
  for (const fn of scan.values()) {
    if (!fn?.file) continue;
    if (!byFile.has(fn.file)) byFile.set(fn.file, []);
    byFile.get(fn.file).push(fn);
  }
  FUNCTIONS_BY_FILE.set(scan, byFile);
  return byFile;
}

const spanOf = (fn) => (fn.endLine ?? fn.line) - fn.line;

/**
 * The innermost scanned function that LEXICALLY CONTAINS `fn`, or null.
 *
 * Containment is the line span out of scan.json — `line`..`endLine`, which
 * ts-morph writes from the node itself (scan.mjs:970) — and a candidate whose
 * span is identical to the subject's is not a container. The innermost is the
 * SMALLEST containing span; when two distinct candidates tie on it the
 * containment is ambiguous and this returns null rather than picking one,
 * because a packet addressed to the wrong one of two functions is exactly the
 * "absorbed a callback it does not contain" failure stated above.
 */
export function nearestEnclosingFunction(fn, scan = new Map()) {
  if (!fn?.file || typeof fn.line !== "number") return null;
  const end = fn.endLine ?? fn.line;
  let best = null;
  let tied = false;
  for (const candidate of functionsByFile(scan).get(fn.file) ?? []) {
    if (candidate.id === fn.id) continue;
    if (typeof candidate.line !== "number") continue;
    const candidateEnd = candidate.endLine ?? candidate.line;
    if (candidate.line > fn.line || candidateEnd < end) continue;
    if (candidate.line === fn.line && candidateEnd === end) continue;
    if (!best || spanOf(candidate) < spanOf(best)) {
      best = candidate;
      tied = false;
    } else if (spanOf(candidate) === spanOf(best)) {
      tied = true;
    }
  }
  return tied ? null : best;
}

/**
 * Where this item's work is ADDRESSED — `{ unit }`, `{ refused }` or null.
 *
 * null is "nothing to decide": the owning function has its own entry, or it is
 * not a call argument, and the packet is addressed to it exactly as before.
 */
export function unitFor(item, scan = new Map()) {
  const functionId = item?.owner?.functionId ?? null;
  if (!functionId) return null;
  if (item.owner?.entry?.reachable) return null;
  if (!CALL_ARGUMENT_NAME.test(String(item.owner?.name ?? ""))) return null;

  const fn = scan.get(functionId);
  if (!fn) {
    return { refused: `the scan does not carry ${functionId}, so nothing here knows what encloses it` };
  }
  const enclosing = nearestEnclosingFunction(fn, scan);
  if (!enclosing) {
    return {
      refused:
        `nothing in ${fn.file} lexically encloses ${functionId} — it is an argument at module scope, so there is no ` +
        `call to drive and the side is a declaration rather than an input`,
    };
  }
  if (!enclosing.entry?.reachable) {
    return {
      refused:
        `the nearest enclosing function ${enclosing.id} has no own entry either ` +
        `(${enclosing.entry?.kind ?? "unknown"}), and this step does not walk further up: a packet addressed two ` +
        `hops away is a claim nothing here can support`,
    };
  }
  return {
    unit: {
      functionId: enclosing.id,
      name: enclosing.name ?? null,
      async: enclosing.async ?? false,
      entry: enclosing.entry ?? null,
      params: enclosing.params ?? [],
      file: enclosing.file,
      line: enclosing.line,
      // The callback this unit is being driven FOR, kept so the packet header
      // and the reading plan can say which arm inside the reading is meant.
      through: { functionId, name: item.owner?.name ?? null, file: fn.file, line: fn.line },
    },
  };
}

/**
 * Decide every item's packet unit ONCE for the round, and say what happened.
 *
 * The decision is written onto the item as `packetUnit` rather than threaded
 * through six signatures, because `ownerKey` is the ONE grouping and everything
 * that deals, weighs, clusters and describes a round already goes through it.
 * `unit` is taken: `worklist.mjs:buildStatementUnits` writes `unit: "statement"`.
 *
 * NOTHING IS WRITTEN TO DISK. `worklist.json` is another step's artifact and
 * `steps.never-repair-a-tools-output.test.mjs` is about exactly that; this is
 * the in-memory copy this step already parsed, and the counts come back so the
 * walk can print them.
 */
export function attachUnits(items = [], scan = new Map()) {
  const readdressed = [];
  const refused = [];
  const units = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const verdict = unitFor(item, scan);
    if (!verdict) continue;
    if (verdict.refused) {
      refused.push({ armId: item.armId, functionId: item.owner?.functionId ?? item.armId, why: verdict.refused });
      continue;
    }
    item.packetUnit = verdict.unit;
    units.add(verdict.unit.functionId);
    readdressed.push({ armId: item.armId, functionId: item.owner?.functionId ?? item.armId, unit: verdict.unit.functionId });
  }
  return { readdressed, refused, units: [...units] };
}

/**
 * The function a packet is ADDRESSED to — the enclosing unit where D63 moved
 * it, the owning function otherwise. Same shape either way, so every reader of
 * an owner block reads a unit block without knowing which it got.
 */
export const unitOf = (item) => item?.packetUnit ?? item?.owner ?? null;

/**
 * THE ONE GROUPING. The owning function where the scan resolved one; the arm's
 * own address otherwise, so an ownerless row is its own group rather than
 * joining every other ownerless row into one oversized one.
 *
 * Extracted so the packet below GROUPS BY THE SAME KEY rather than by a second
 * one of its own. Two groupings that agree today are two groupings that can
 * disagree tomorrow, and the disagreement is silent: a round whose batch was
 * filled a function at a time and whose packets were cut somewhere else would
 * hand over a packet naming sides that are not in the round.
 *
 * D63: the key is the packet UNIT, so a callback's sides group with the
 * enclosing function a worker can actually call. Identical to the owner for
 * every function that has its own entry, which is all of them until
 * `attachUnits` has run.
 */
export const ownerKey = (item) => unitOf(item)?.functionId ?? item.armId;

/** The open list as function groups, in the order the open list is in. */
export function groupByOwner(entries) {
  const byFunction = new Map();
  for (const entry of entries) {
    const key = ownerKey(entry.item);
    if (!byFunction.has(key)) byFunction.set(key, []);
    byFunction.get(key).push(entry);
  }
  return byFunction;
}

/**
 * THE CONTEXT A PACKET READS — the file its reading plan names FIRST.
 *
 * That is where the owning function is DECLARED, which is what `readingPlan`
 * puts at the top of the plan and what a worker opens first. The arm's own file
 * is not asked, for the reason `declaredAt` exists: an arm's `file`/`line` is
 * where the CONDITION is, and on a re-exported or wrapped function that is not
 * the file the reading happens in.
 */
export const contextOf = (item) => declaredAt(unitOf(item)?.functionId)?.file ?? item?.file ?? null;

/**
 * The open list's function groups, reordered so groups sharing one CONTEXT are
 * adjacent — first appearance wins, and order inside a context is untouched.
 *
 * WHY THE DEAL AND NOT JUST THE DESCRIPTION. Measured on the vendored
 * location-ms list this suite runs on: the 16 function groups touch
 * `src/services/googleMap.service.ts` at positions 2, 3, 4, 5 and then again at
 * 12, 13, 14, 15. Dealt in open order at a cap that falls between them, that
 * one 11 KB file is read in one round and read AGAIN in the next — which is the
 * 91% re-read figure from plan 14 seen from the scheduling side. Dealt by
 * context, the whole file is one cluster and its reading is acquired once.
 *
 * WHAT THIS IS NOT ALLOWED TO CHANGE, and does not: which sides exist, which
 * function owns which side, and that a function's sides stay together. It
 * reorders GROUPS and never splits one, so `nextBatch`'s guarantee — a
 * function's sides are never split across rounds unless the function is bigger
 * than the whole cap — is exactly as it was.
 */
export function groupByContext(byFunction) {
  const byFile = new Map();
  for (const [key, sides] of byFunction) {
    const file = contextOf(sides[0]?.item) ?? key;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([key, sides]);
  }
  const out = new Map();
  for (const groups of byFile.values()) for (const [key, sides] of groups) out.set(key, sides);
  return out;
}

export function nextBatch(open, batch) {
  // BY CONTEXT, so a cluster's reading is dealt once. The grouping underneath
  // is still `groupByOwner` — the same one `packetsFor` builds packets from —
  // so a round can never carry a side no packet speaks for.
  const byFunction = groupByContext(groupByOwner(open));

  const taken = [];
  for (const sides of byFunction.values()) {
    if (!taken.length && sides.length > batch) return sides.slice(0, batch);
    if (taken.length + sides.length > batch) break;
    taken.push(...sides);
  }
  return taken;
}

/* ------------------------------------------------------------------------ *
 * THE PACKET — the unit of handover is a FUNCTION, and its sides are the
 * questions one reading of that function answers.
 *
 * MEASURED, run `20260916T112101Z` round 2 (82.9 min), every call attributed to
 * the service file it touched:
 *
 *   src/services/location.service     5 visits   29.8m total   28.6m longest
 *   src/services/googleMap.service    8 visits    2.3m total    0.6m longest
 *
 * Consecutive file-touching calls stay on the SAME file 78% of the time, and
 * location.service's 29.8 minutes is one sustained 28.6-minute block rather
 * than five re-entries. Two facts fall out of that and both are why this exists:
 *
 *   1. The agent ALREADY derives per function. It reads the function once and
 *      reasons about it in one stretch. So nothing here re-derives anything per
 *      side, and nothing here asks it to read the same thing twice.
 *   2. Those blocks are natural, INDEPENDENT units. location.service's 28.6
 *      minutes and googleMap.service's work share no reasoning at all.
 *
 * What the handover did not say is that they belong together. A function with 8
 * open sides — `googleMap.service.ts:112:parseAddressesForJd` has exactly that
 * on the vendored run `20260915T033521Z` — arrived as 8 items that each named
 * the same owner, the same entry recipe, the same parameters and the same
 * boundaries, with nothing anywhere saying "these are one piece of work and one
 * reading answers all of them". The packet says it.
 *
 * IT IS NOT A DISPATCH AND IT PERFORMS NONE. No worker, no subagent, no change
 * to how many turns a round costs: a round is still one walk, one exit 75, one
 * answering turn. Dispatching by packet is a later decision with a measured
 * drop-off behind it — on run `20260915T111114Z` 40 of 55 false claims were two
 * clusters, one subagent's slice each, forty minutes each on a wrong premise
 * nobody checked. This makes the unit VISIBLE, which is the part that cannot go
 * wrong.
 *
 * WHAT IS CARRIED ONCE AND WHAT IS DELIBERATELY NOT. The packet's own block —
 * the roster of its sides, the reading plan, and the reference material every
 * one of its items repeats — is written ONCE, at the TOP OF THE PACKET'S OWN
 * FILE. The walk fans the handover out into one file per packet
 * (`workflow.mjs:writeWorklist`), so the packet block is above the items it
 * describes and no item points at another item to find it.
 *
 * It used to be written on the first of the packet's sides, with every other
 * side carrying a sentence naming that one. That sentence was the last per-item
 * lookup in the handover, and it is gone.
 *
 * What is NOT deduplicated is `context.owner` and `context.boundaries`, and
 * that is a decision rather than an oversight. A side must be answerable from
 * its own item ALONE — read out of order, or by a different turn — and
 * `tests/derive.brief.test.mjs` already refuses a handed item with no entry
 * recipe on it, for exactly that reason. A packet that thinned the sides it
 * grouped would trade a verbose handover for an unanswerable one, which is the
 * worse defect: the verbose one costs bytes, the thin one costs the answer.
 * ------------------------------------------------------------------------ */

/**
 * The fields every side of one packet repeats verbatim.
 *
 * NAMES, never a second copy of the values. The agent reads this and knows the
 * five items in front of it differ only in `arm` and `proposal.skeleton` — one
 * reading of the owner, one answer for each side.
 */
export const PACKET_SHARED = Object.freeze(["owner.entry", "owner.params", "owner.async", "boundaries"]);

/**
 * Where the owning function is DECLARED, read out of its own id.
 *
 * `src/services/googleMap.service.ts:112:parseAddressesForJd` is a path, a line
 * and a name, and the scan builds it that way everywhere. The arm's own
 * `file`/`line` is where the CONDITION is, which is somewhere inside the
 * function and not where a reading of it starts. Null when the id is not that
 * shape, and the caller falls back to the arm — an address that is nearly right
 * is worse than one that says it does not know.
 */
export function declaredAt(functionId) {
  const m = /^(.+):(\d+):[^:]*$/.exec(String(functionId ?? ""));
  return m ? { file: m[1], line: Number(m[2]) } : null;
}

/**
 * THE SOURCE THE AGENT MUST READ, once, for the whole packet.
 *
 * The function itself first, at its declaration rather than at an arm's
 * condition; then every module a boundary of it lives in, with the symbols that
 * module backs. Boundaries are here because validate.mjs DEMANDS an answer for
 * each of them before any side of this packet can record — so they are part of
 * the one reading, not a separate errand per side.
 *
 * Deduplicated by module: `googleMap.service` reaches zod through several
 * symbols and a plan that named zod once per symbol would be the repetition
 * this packet exists to remove, one level down.
 */
export function readingPlan(item, boundaries = {}, { through = [] } = {}) {
  const unit = unitOf(item);
  const at = declaredAt(unit?.functionId);
  const fn = unit?.name ?? "the function";
  /* --------------------------------------------------------------------- *
   * D63 — THE CALLBACKS THIS UNIT IS BEING DRIVEN FOR, NAMED IN THE FIRST
   * ENTRY RATHER THAN AS ENTRIES OF THEIR OWN.
   *
   * They are inside the unit's own span, so they are already inside the one
   * reading — and a second entry naming the same file would be served a second
   * inlined copy of that file's note: `notes.mjs:noteCacheFurniture` walks the
   * plan and calls `readNote` per STEP, with no dedupe by file, and a note is
   * allowed 4 KB against a 25,000-byte brief budget. So the callbacks cost one
   * sentence on the entry that was already there, and the packet header's
   * `through` block carries the ids and the rosters.
   * --------------------------------------------------------------------- */
  const drives = through.length
    ? ` ${through.length} of this packet's callback(s) live inside it and have no address of their own — ` +
      through
        .map((cb) => `${cb.name ?? cb.functionId} at line ${cb.at?.line} (${cb.sides.length} side(s))`)
        .join(", ") +
      `. There is nothing to call there: reach those sides by giving ${fn} data that makes the callback take them.`
    : "";

  const plan = at
    ? [{
        file: at.file,
        line: at.line,
        why:
          `${fn} itself — its parameters, the entry recipe that calls it, and every condition in its body. ` +
          `One reading answers every side of this packet.` + drives,
      }]
    : [{
        file: item.file,
        line: item.line,
        why: "the arm's own file — the scan resolved no owning function, so this arm is its own unit of work",
      }];

  const byModule = new Map();
  for (const [symbol, boundary] of Object.entries(boundaries ?? {})) {
    const module = boundary?.module;
    if (!module) continue;
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(symbol);
  }
  for (const [module, symbols] of byModule) {
    plan.push({
      module,
      symbols: symbols.sort(),
      why:
        `a collaborator ${fn} calls. validate.mjs demands an answer for it before any side of this packet records, ` +
        `so it is part of the one reading rather than an errand per side.`,
    });
  }
  return plan;
}

/**
 * Every side of this round, keyed to the packet it belongs to.
 *
 * Built off `groupByOwner` — the SAME grouping `nextBatch` filled the round
 * with — so a packet can never name a side the round does not carry, and the
 * round can never carry a side no packet speaks for.
 *
 * Returns `Map<sideId, packet>`, one packet object SHARED by its sides. The map
 * is keyed by side rather than by function because every reader of it has a
 * side in hand and wants its packet; the packet names its function itself.
 */
export function packetsFor(round, { boundariesByFunction = {} } = {}) {
  const bySide = new Map();
  for (const entries of groupByOwner(round).values()) {
    const item = entries[0].item;
    const unit = unitOf(item);
    const functionId = unit?.functionId ?? null;
    const sides = entries.map(({ item: i, side }) => sideId(i.armId, side));
    const at = declaredAt(functionId) ?? { file: item.file, line: item.line };
    /* --------------------------------------------------------------------
     * D63 — THE CALLBACKS THIS PACKET SPEAKS FOR THAT ARE NOT THE UNIT.
     *
     * Built off the packet's OWN entries, so a callback can only appear under
     * the unit `attachUnits` addressed it to: the grouping and this roster are
     * the same pass, and a unit cannot collect a callback it does not contain
     * without `nearestEnclosingFunction` having said it does.
     * ------------------------------------------------------------------ */
    const throughBy = new Map();
    for (const { item: i, side } of entries) {
      const own = i.owner?.functionId ?? null;
      if (!own || own === functionId) continue;
      if (!throughBy.has(own)) {
        throughBy.set(own, {
          functionId: own,
          name: i.owner?.name ?? null,
          at: declaredAt(own) ?? { file: i.file, line: i.line },
          sides: [],
        });
      }
      throughBy.get(own).sides.push(sideId(i.armId, side));
    }
    const through = [...throughBy.values()];
    // EVERY function whose boundaries this one reading has to answer for: the
    // unit's own, plus each callback's. validate.mjs demands an answer per ROW
    // and the rows still carry the callback's own block, so a plan that named
    // only the unit's collaborators would send the worker back for the rest.
    const boundaries = {};
    for (const id of [functionId, ...through.map((t) => t.functionId)]) {
      Object.assign(boundaries, boundariesByFunction[id] ?? {});
    }
    const packet = {
      id: `packet ${ownerKey(item)}`,
      functionId,
      name: unit?.name ?? null,
      async: unit?.async ?? false,
      file: at.file,
      line: at.line,
      // EVERY side it speaks for, in the order the round carries them. A packet
      // that named a subset would be a grouping that silently drops work, which
      // is strictly worse than no grouping at all.
      count: sides.length,
      sides,
      // The first side, kept only so a round's packets have a stable, printable
      // anchor in a log. NOTHING POINTS AT IT ANY MORE: the packet's own block
      // is at the top of the packet's own file, so no item is privileged and no
      // item has to be found before another can be read.
      lead: sides[0],
      read: readingPlan(item, boundaries, { through }),
      shared: [...PACKET_SHARED],
      // D63: absent when every side of this packet is an arm of the unit
      // itself, by the same rule `notes` and `cluster` follow — an empty block
      // on every packet is a restatement with a header.
      ...(through.length ? { through } : {}),
    };
    for (const s of sides) bySide.set(s, packet);
  }
  return bySide;
}

/* ------------------------------------------------------------------------ *
 * D47 — CONTEXT AFFINITY AS LOGICAL OWNERSHIP, AND WHY IT IS NOT ONE WORKER.
 *
 * A round is a new process and a new conversation; nothing carries over. Within
 * a round, workers are dealt packets with no regard for which files they share,
 * so two workers holding sides in `agent.ts` both read all 47 KB of it. Across
 * rounds the same file is dealt to a different worker, which reads it again.
 * That is plan 14's 91% re-read figure seen from the scheduling side, and
 * `groupByContext` above is the half of the fix that stops the reading being
 * acquired twice.
 *
 * THE OBVIOUS FORM OF AFFINITY IS THE FAILURE THIS FLEET HAS ALREADY SEEN. Give
 * one worker `agent.ts` and let it answer every side in it, and run
 * 20260918T164503Z round 1 is what happens — that run has no directory on any
 * reachable checkout, so this is plan 13's D45 table (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`) and not a log anyone can open:
 *
 *   Worker 1 finished: packets 01, 03, 19, 33 fully answered; packet-02 (31
 *   sides, the large `agent.ts run()` function) DELIBERATELY LEFT UNANSWERED
 *
 * The dominant cluster becomes the straggler and the round waits on it. So the
 * rule plan 15 states is the constraint this code honours, both halves:
 *
 *   Affinity prevents duplicate context acquisition; bounded intra-context
 *   parallelism prevents affinity from creating a new straggler.
 *
 * AND THE SECOND HALF HAS A PREREQUISITE THAT IS NOT NEGOTIABLE. A second
 * worker taking a subcluster of `agent.ts` must not re-read 47 KB to do it — if
 * it does, the split has traded a straggler for the duplicate reading affinity
 * existed to remove. What it is handed instead is the NOTE, which is what
 * `notes.mjs` serves inline at the top of a packet's file. The note cache did
 * not prime in either of the two live runs this plan was written from, so on
 * those runs there was nothing to hand a second worker.
 *
 * THEREFORE: A CLUSTER WITH NO NOTE IS NOT SPLIT. It is stated as a condition
 * in the code below rather than as advice in a comment, because the failure
 * mode of getting it wrong is silent — the split happens, both workers read the
 * file in full, and the run looks exactly like the one before it while costing
 * the same 47 KB twice. Splitting is permitted only when a note for the
 * cluster's file exists at that file's CURRENT bytes, which is the one question
 * `readNote` answers and the one thing that makes the second reading cheap.
 *
 * NOTHING HERE DISPATCHES. `derive.packet.test.mjs` refuses a per-packet spawn,
 * a worker and a subagent, and those refusals are untouched. What a cluster
 * gains is a block at the top of each of its packets' own files saying which
 * packets share this reading and whether the answering turn may put more than
 * one worker on it.
 * ------------------------------------------------------------------------ */

/**
 * The round's packets grouped by the file they read, one cluster per file.
 *
 * `packets` is `packetsFor`'s `Map<sideId, packet>` — the same object shared by
 * a packet's sides — or any iterable of packets. `hasNote` is asked once per
 * cluster and answers exactly one question: is there a note for this file at
 * its current bytes? Default: no, which is the safe answer, because the cost of
 * a wrong "yes" is the duplicate reading and the cost of a wrong "no" is one
 * straggler this round.
 */
export function clusterPackets(packets, { hasNote = () => false } = {}) {
  const seen = new Set();
  const clusters = new Map();
  const list = packets instanceof Map ? packets.values() : (packets ?? []);
  for (const packet of list) {
    if (!packet || seen.has(packet)) continue;
    seen.add(packet);
    const file = packet.file ?? packet.id;
    if (!clusters.has(file)) clusters.set(file, { file, packets: [], sides: 0 });
    const cluster = clusters.get(file);
    cluster.packets.push(packet);
    cluster.sides += packet.count ?? packet.sides?.length ?? 0;
  }
  for (const cluster of clusters.values()) {
    // ASKED ONCE PER CLUSTER, not once per packet: it is the same file, and a
    // per-packet probe would be the per-item lookup the packet header spent a
    // round removing, one level up.
    cluster.note = cluster.packets.length > 1 ? Boolean(hasNote(cluster.file)) : false;
    cluster.mayBeSplit = cluster.packets.length > 1 && cluster.note;
  }
  return clusters;
}

/**
 * The cluster as it is written at the top of each of its packets' files, or
 * null when a packet is alone in its context and there is nothing to say.
 *
 * IT TAKES THE CLUSTER AND NOT THE PACKET, because every packet of a cluster
 * gets the same block. An earlier cut named the SIBLING packets, so the block
 * differed per packet — and both halves of that were wrong. Naming the other
 * packets names other FILES, which is the one thing a packet file promises not
 * to do ("THIS FILE IS THE WHOLE JOB: nothing in it sends you to another file"
 * is on every packet header), and it is not free: the ids are function
 * addresses, eight of them is about 480 bytes, and the median brief on the
 * location-ms fixture is 24,918 bytes against the 25,000 that
 * `handover.one-packet-one-file` allows. The file, the packet count and the
 * side count say everything a worker needs about the shape of the cluster it
 * is in.
 */
export function clusterBlock(cluster) {
  if (!cluster || cluster.packets.length < 2) return null;
  return {
    context: cluster.file,
    packets: cluster.packets.length,
    sides: cluster.sides,
    // `note` is not a second field beside this one: a cluster block only exists
    // when more than one packet shares the file, and at that point "a note
    // exists" and "this may be split" are the same fact. Two names for one fact
    // is how two readers come to disagree about which is authoritative.
    mayBeSplit: cluster.mayBeSplit,
    // NO PROSE, AND THE RULE LIVES IN THE SKILL. MEASURED, on the location-ms
    // fixture this suite runs: the median packet brief is 24,918 bytes against
    // the 25,000-byte budget `handover.one-packet-one-file` holds, so this
    // block has about 80 bytes of headroom and a sentence explaining itself
    // costs 110. It is the same judgement `noteCacheFurniture` made about its
    // own protocol block and for the same reason — the rule is identical in
    // every one of a round's forty packets, so repeating it forty times is how
    // that budget gets broken. `packet.cluster` is documented in
    // `charpilot-stage-3-derive-input`, which the worker already has: what
    // `mayBeSplit` means, why the split needs a note, and what having only one
    // half of the rule cost on runs 20260918T164503Z and 20260919T092410Z.
    // (164503Z has no run directory anywhere reachable; its figures are
    // plan 13's D45 table, not a log. 092410Z is on disk.)
  };
}

/**
 * The packet as ONE SIDE sees it: WHICH packet, and nothing a reader must fetch.
 *
 * IDENTICAL ON EVERY SIDE OF THE PACKET, which is the point. It used to differ:
 * the lead carried the reading plan and every other side carried a sentence
 * naming the lead. That sentence was the last genuine per-item join left in the
 * handover — `derive.states-its-limits.test.mjs` pinned it as exactly one, and
 * said in its own docblock that the fix is structural — and it is gone, because
 * the reading plan and the roster now sit at the top of the packet's own FILE
 * (`packetHeader`, written by the walk). There is nothing left to point at.
 *
 * What stays on the item is the packet's IDENTITY, so an item is still
 * self-describing when it is quoted, logged or read on its own: it says which
 * function it is an arm of and how many sides that function has open. Every one
 * of those fields is an answer, never an address.
 *
 * IT IS THE IDENTITY AND NOT A SECOND COPY OF THE HEADER, and it used to be
 * both. This returned `functionId`, `name`, `file` and `line` as well — all
 * four byte-identical to `packet.functionId`, `packet.name`, `packet.file` and
 * `packet.line` at the top of THE SAME FILE, and all four already inside `id`,
 * which is the string `packet <file>:<line>:<name>`. On the fixture
 * `handover.one-packet-one-file` measures, `functionId` alone appeared FIVE
 * times in one item's own brief. Nothing became an address: an item that is
 * quoted on its own still names its packet, and a reader that wants the
 * decomposition scrolls up in the file it is already holding.
 *
 * MEASURED, and this is what the bytes were spent on. The all-miss note notice
 * `noteCacheFurniture` emits costs 410 bytes on a packet header, and the median
 * brief on that fixture was 24,866 against the 25,000
 * `handover.one-packet-one-file` allows — 134 bytes of headroom, not the 10 the
 * plan quotes. Wiring the notice on without this took the median to 25,263,
 * which is over. With it the median is 24,533 without the notice and 24,943
 * with it. The two median packets of that fixture hold ONE and TWO items, which
 * is why `SHARED_BLOCKS` cannot pay for it: lifting a block out of a one-item
 * packet costs a pointer sentence and saves nothing.
 */
export function packetView(packet) {
  if (!packet) return null;
  return {
    id: packet.id,
    count: packet.count,
  };
}

/**
 * The packet's own block, written ONCE at the top of the packet's own file.
 *
 * WHAT MOVED HERE AND WHY IT IS THIS AND NOT MORE:
 *
 *   `sides`  the roster. It is a property of the PACKET, and restating it on
 *            each of the packet's own sides grows as the square of the packet:
 *            3.1% of the small fixture, part of the 32% on the 146-side round.
 *   `read`   the reading plan. One reading answers the whole packet, so it is
 *            written where the packet is.
 *   `shared` the reference blocks every item of this packet repeats verbatim,
 *            held once at the top of the file the items are in rather than on
 *            one item of one packet somewhere else in the round.
 *
 * WHAT DELIBERATELY DID NOT MOVE: `context.owner`, `context.boundaries`,
 * `context.proposal.skeleton`. `derive.packet.test.mjs` refuses a handed item
 * with no entry recipe, and that refusal is untouched — a side is still
 * answerable from its own item, and the packet block is reference material
 * above it, not a place a slot went.
 */
export function packetHeader(packet, { notes = null, lastSeen = null, answersFile = null, fresh = null, cluster = null, owed = null, carried = null, source = null, worker = null, root = REPO_ROOT } = {}) {
  if (!packet) return null;
  return {
    id: packet.id,
    functionId: packet.functionId,
    name: packet.name,
    file: packet.file,
    line: packet.line,
    count: packet.count,
    // THE ONE FILE THIS PACKET'S ANSWERS GO IN, and the last round's count for
    // it. See `nameCollision` above: the name is derived from the packet id so
    // two readers never compute the same one, and the count is what makes a
    // second write to it detectable next round instead of silent.
    answers: answersBlock({ packetId: packet.id, file: answersFile, lastSeen, fresh }),
    // THE RULES, NOT THE EVIDENCE: which `mock.kind` installs, one worker per
    // packet, and which arms a `from` may name. Written once at the top of this
    // packet's own file because they are the same on every item of every round,
    // and taken from `handover.mjs` so a `repair` packet carries the SAME
    // objects rather than a second copy of the same sentences.
    ...packetFurniture(),
    // THE NOTES FOR THE FILES THIS PACKET WILL READ, INLINE.
    //
    // Served here rather than fetched by the worker, because a worker in this
    // pipeline runs nothing -- the rule that removed 193 calls and 55.4 minutes
    // of contract lookup from run 20260916T031317Z, a quarter of it, and that
    // `blocked.mjs` was refused an exception to. Inline is also simply cheaper
    // than a tool call would have been, and the note's 4 KB ceiling is what
    // keeps it affordable: a note's size is brief size.
    //
    // AND `owed` — THE ROUND'S OBLIGATION, WHICH ONLY THE CALLER CAN COUNT.
    // Without it `noteCacheFurniture`'s all-miss branch hits
    // `Number.isInteger(owed)` and returns `{}`, so the ONE notice that tells a
    // worker at the moment of a cache MISS what a note submission looks like
    // has never reached a packet. COUNTED OFF THE RUN LOGS RATHER THAN QUOTED:
    // `20260919T092106Z` (location-ms) closed `noteCacheNotesWritten=0` and
    // `noteCacheHits=0` in all four rounds; `20260919T092410Z` (tracy-worker)
    // ran 0, 0, 0, 8 notes written and 0, 0, 0, 14 hits, against full-read
    // misses climbing 33 → 66 → 95 → 109. So the cache was cold for three
    // rounds of four and warmed only in the last one — NOT "zero in every
    // round of both", which is what `notes.mjs`'s own comment says and what
    // the first draft of this one repeated. The worker's log for those cold
    // rounds says why: "No noteCache present, so I should do a full read". A
    // packet cannot compute the number: it sees its own reading plan, not the
    // round's, and nineteen packets each stating a different obligation is
    // nineteen expectations and therefore none.
    ...noteCacheFurniture(packet.read, { by: packet.id, owed, root }),
    // WHAT AN EARLIER ROUND LEARNED ABOUT THIS FUNCTION. Absent when nothing
    // has been learned, rather than an empty block a reader has to decide to
    // ignore — workflow.mjs:55 states that rule for the items and it holds here.
    ...(notes ? { notes } : {}),
    // WHICH OTHER PACKETS OF THIS ROUND SHARE THIS READING, and whether more
    // than one worker may take them. Absent when this packet is alone in its
    // context, by the same rule as `notes`: an empty affinity block on every
    // solo packet is a restatement with a header, and the median brief is
    // already at the 25,000-byte budget `handover.one-packet-one-file` holds.
    ...(cluster ? { cluster } : {}),
    // PLAN 20 T2.1: cut off last round, so more time, first and alone.
    ...(carried ? { carried } : {}),
    // PLAN 20 T2.5c: the function's own lines, so the first turn is not a Read.
    ...(source ? { source } : {}),
    // PLAN 20 T2.5d: which worker type answers this packet, when not the default.
    ...(worker ? { worker } : {}),
    // D63 — THE CALLBACKS INSIDE THIS UNIT THAT SOME OF THESE SIDES BELONG TO.
    // Absent when there are none. Present, it is the difference between a
    // worker that cannot start and one that can: `<arg0 of x.forEach>` is not
    // a function to call, and this says which function to call instead and
    // which sides that gets you.
    ...(packet.through?.length ? { through: packet.through } : {}),
    // EVERY side this file answers, once, at the top of the file that answers
    // them. An agent holding this file can see all of them without having found
    // anything first — which is the guarantee the per-item roster was for, made
    // structural.
    sides: packet.sides,
    read: packet.read,
    // The fields the items below repeat on each other. Named rather than
    // copied: the values are on each item, because a side has to be answerable
    // from its own item, and a second copy here would be the duplication the
    // packet exists to name.
    repeats: packet.shared,
    // Filled by `shareIntoPackets`: the blocks that were the same on every item
    // of this packet, lifted out of them and written here once.
    shared: {},
    why:
      packet.through?.length
        ? `these ${packet.count} side(s) are one piece of work: ${packet.through.reduce((n, t) => n + t.sides.length, 0)} ` +
          `of them are arms inside ${packet.through.length} anonymous callback(s) that have no address of their own, ` +
          `and the only way to reach them is to drive ${packet.name ?? packet.functionId} — which is what this packet ` +
          `is addressed to. One reading of ${packet.file} answers all of them. Each still needs its own answer, one ` +
          `per side, addressed by its OWN id as the item gives it — the callback's id, not this one. THIS FILE IS THE ` +
          `WHOLE JOB: everything the items below refer to is above them, and nothing in it sends you to another file.`
        : packet.count > 1
        ? `these ${packet.count} side(s) are one piece of work: they are arms of the same function, they share the entry ` +
          `recipe, the parameters and the boundaries, and one reading of ${packet.file} answers all of them. Each still ` +
          `needs its own answer, one per side, addressed by its own id. THIS FILE IS THE WHOLE JOB: everything the ` +
          `items below refer to is above them, and nothing in it sends you to another file.`
        : `one side, one function. The packet is still named so a round's items group the same way whether a function ` +
          `has one open side or eight. THIS FILE IS THE WHOLE JOB: nothing in it sends you to another file.`,
  };
}

/**
 * Which of the three kinds the prompt documents this item is.
 *
 * A ROUTING HINT, and said plainly because it is read as one: `context` carries
 * the same evidence whichever kind is on the item, so a mis-kinded item costs
 * attention and never an answer. The three rules, in the order they are asked:
 *
 *   declaration  the scan resolved no way to call this at all — no own entry,
 *                no driver and no trigger. There is no argument to derive, so
 *                what is needed is a written reason with proof.
 *   boundary     the arm's own condition names one of the collaborators the
 *                function calls, so the side is not chosen by an argument, it
 *                is chosen by what that collaborator does.
 *   input        everything else: pick the arguments that take this side.
 */
export function kindOf(item, boundarySymbols) {
  // D60: premises.mjs `noWayIn` IS this test, moved there so the fact a
  // declaration question is dealt under and the fact its answer is re-checked
  // against are one definition.
  if (noWayIn({ entry: item.owner?.entry ?? {}, via: item.via })) return "declaration";

  const decisive = decisiveText(item);
  for (const symbol of boundarySymbols) {
    // Word-boundary, so `z` does not match inside `zone`. The symbol is a
    // JavaScript identifier, so escaping is a `$` away from nothing.
    if (new RegExp(`(^|[^\\w$])${symbol.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(decisive)) return "boundary";
  }
  return "input";
}

/**
 * The part of an arm's source that SELECTS the side, rather than the part that
 * runs once one is selected.
 *
 * The scan stores an `if` arm's whole statement, body included, and a
 * conditional expression's whole `A ? B : C`. Matching a boundary symbol
 * against all of that is matching against code the side merely EXECUTES: on the
 * vendored location-ms work list it turned
 * `req.query.iso2 ? z.string().parse(req.query.iso2) : undefined` into a
 * question about zod, when what selects the side is whether `req.query.iso2`
 * was sent, and `if (a && b) { const x = isInside(...) }` into a question about
 * `isInside`, which the body calls after the arm is already taken. Both are
 * argument questions. With the test alone, all 25 instrumented rows of that
 * work list read as `input`, which is what they are.
 *
 * It is still only a routing hint and it misses the other way round: a
 * condition like `response.results.length > 0` is decided by a collaborator
 * whose symbol is nowhere in it. The evidence handed over is identical for
 * every kind, so a miss costs attention and never an answer.
 */
export function decisiveText(item) {
  const source = String(item.source ?? "");
  if (/^\s*(if|while|switch|for)\s*\(/.test(source)) {
    const start = source.indexOf("(");
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) return source.slice(start + 1, i);
      }
    }
    return source;
  }
  // The test of a conditional expression, which is everything before its `?`.
  // `?.` and `??` are not that `?`, so they are stepped over rather than split
  // on.
  if (item.kind === "cond-expr") return source.split(/\?(?![.?])/)[0];
  return source;
}

/**
 * The whole skeleton, paged.
 *
 * `--skeleton` windows its output because its other consumer is an agent's
 * context window and a window is one authoring session. This consumer is a
 * program, so it takes the lot — but by FOLLOWING `window.next` rather than by
 * assuming one call got everything. A single call with a large `--batch` is the
 * normal case and the loop then runs once; the loop is what stops a silently
 * short answer from producing items with no proposal shape in them.
 */
export function readSkeleton({ tool, exec = runTool, cwd, batch = 10000 }) {
  const rows = new Map();
  const signatures = {};
  const boundaries = {};
  let note = null;
  let offset = 0;
  let total = null;

  for (;;) {
    const script = tool("worklist.mjs");
    const res = exec(script, ["--skeleton", "--batch", String(batch), "--offset", String(offset)], { cwd });
    // EXIT 3 NAMES THE NEXT STEP; IT DOES NOT REPORT A BROKEN TOOL.
    //
    // `worklist.mjs:1070` refuses to rebuild the brief once stage 3 is past its
    // budget with unrecorded proposals, and `record.mjs:2728` justifies
    // clearing the clock with "a brake that cannot be released is not a brake,
    // it is a wall." Thrown from here it was a wall: run 20260917T131746Z died
    // at minute 36.8 with all 146 sides answered and every one of them
    // unrecorded, and in the container `docker/char/packs/nodejs.py:339` turns
    // that into a dead run rather than an instruction the agent ever sees.
    //
    // The caller decides whether the recovery is available — see `deferTo`
    // below. It is reported, never swallowed: the tool's own bytes go into
    // `did` exactly as the throw used to put them into the error.
    if (res.status === 3) return { overBudget: true, said: String(res.stderr ?? "").trim(), rows, signatures, boundaries, note };
    if (res.status !== 0) throw new Error(toolFailure("the skeleton", script, res));
    let doc;
    try {
      doc = JSON.parse(res.stdout);
    } catch (err) {
      throw new Error(`the skeleton: worklist.mjs --skeleton did not print JSON — ${err.message}`);
    }
    note = doc.note ?? note;
    Object.assign(signatures, doc.functionSignatures ?? {});
    Object.assign(boundaries, doc.functionBoundaries ?? {});
    for (const row of doc.proposals ?? []) {
      for (const [armId, sides] of Object.entries(row.reaches ?? {})) {
        for (const side of Array.isArray(sides) ? sides : [sides]) rows.set(sideKey(armId, side), row);
      }
    }
    total = doc.window?.rowsTotal ?? total;
    const got = doc.window?.rows ?? (doc.proposals ?? []).length;
    if (!doc.window?.next || got === 0) break;
    offset += got;
  }

  return { rows, signatures, boundaries, note, rowsTotal: total };
}

/** One `## ` section of a markdown brief, heading included, or null. */
export function section(markdown, heading) {
  const lines = String(markdown).split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim() || null;
}

/**
 * The stage-4 brief, generated and then read.
 *
 * handoff.mjs writes out/HANDOFF-stage<N>.md and prints only a summary, so the
 * artifact is the answer and the run is how it gets refreshed. One section of it
 * belongs in every item: which boundaries are default-deny, which addresses are
 * real, and which of them quietly default to localhost. That is the difference
 * between a boundary answer that records staging's behaviour and one that
 * records this machine's.
 */
export function readHandoff({ tool, exec = runTool, cwd, outDir }) {
  const script = tool("handoff.mjs");
  const res = exec(script, ["--stage", "4"], { cwd });
  if (res.status !== 0) throw new Error(toolFailure("the stage-4 handoff", script, res));
  const path = join(outDir, "HANDOFF-stage4.md");
  if (!existsSync(path)) throw new Error(`the stage-4 handoff: handoff.mjs exited 0 and wrote no ${path}`);
  const text = readFileSync(path, "utf8");
  return {
    brief: relative(REPO_ROOT, path) || path,
    addresses: section(text, "Addresses, and what must never be called"),
  };
}

/**
 * The proposal vocabularies, from the file that enforces them.
 *
 * `validate.mjs --schema` prints them out of its own constants — the mock
 * kinds, the `setup[].apply` directives, the fields a proposal may not carry,
 * the unfilled-slot sentinel, the BLOCKED.md categories and killers. The
 * skeleton leaves `mock.kind` as a sentinel and its comment says the refusal
 * prints the enum; an agent that has to provoke a refusal to learn an enum is
 * an agent reading the pipeline's source, which the prompt forbids and which
 * this step exists to make unnecessary.
 */
export function readSchema({ tool, exec = runTool, cwd }) {
  const script = tool("validate.mjs");
  const res = exec(script, ["--schema"], { cwd });
  if (res.status !== 0) throw new Error(toolFailure("the proposal schema", script, res));
  return section(res.stdout, "vocabularies") ?? (res.stdout.trim() || null);
}

/**
 * What staging's own values are, where the pipeline has read them out.
 *
 * The keys only, never the rows: this is a brief, and a brief that pastes a
 * value has made the derivation. The path is named so the agent opens the one
 * file that holds real values instead of guessing which artifact has them, and
 * an absent file says which step writes it rather than reading as "there are
 * none".
 */
export function readVocabulary(outDir) {
  const out = {};
  for (const [key, file, writtenBy] of [
    ["db", "db-vocabulary.json", "the vocabulary step (dbvocab.mjs)"],
    ["provider", "provider-vocab.json", "the vocabulary step (providervocab.mjs)"],
  ]) {
    const path = join(outDir, file);
    if (!existsSync(path)) {
      out[key] = { path: relative(REPO_ROOT, path) || path, present: false, writtenBy };
      continue;
    }
    let keys = [];
    try {
      const doc = JSON.parse(readFileSync(path, "utf8"));
      keys = Object.keys(doc ?? {});
    } catch {
      keys = [];
    }
    out[key] = { path: relative(REPO_ROOT, path) || path, present: true, keys };
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * THE DOCUMENT THE AGENT SUBMITS
 *
 * `worklist.mjs --skeleton` prints ONE document per window: `functionSignatures`
 * and `functionBoundaries` at its top, `proposals[]` under them, and a `note`
 * that names all three. That document is coherent. What this step hands over is
 * ONE ROW of it, on its own, and the row alone is not — which is this step's
 * defect and not the tool's.
 *
 * Measured on the fixture at /tmp/p8test, run `20260916T165524Z`, all 56 items:
 *
 *   - `proposal.skeleton.boundaries` is `{}` on every one of them, while the
 *     `<<DERIVE>>` boundaries live in a SIBLING key, `context.boundaries`,
 *     which is not part of the document. Submitting the row exactly as handed
 *     over is three warnings per item from validate.mjs — proven directly:
 *     `no answer declared for boundary `ZodError` (zod)` and two more, on a row
 *     copied byte-for-byte out of the handover.
 *   - the note says "Boundaries are declared once per function in
 *     `functionBoundaries`" and "args[] is positional in the order given by
 *     `functionSignatures`". NEITHER KEY IS IN THE ITEM. So "Fill VALUES ONLY"
 *     asks for values that are not there, and the answering turn hand-built a
 *     `functionBoundaries` block and copied every symbol's `module` across from
 *     `context.boundaries` — the retyping of addresses worklist.mjs:665 prices
 *     at 18.7% of every authored byte.
 *   - `args` is one slot per OWNER parameter. validate.mjs checks it against the
 *     DRIVER's (validate.mjs:663, `const signature = driverFn ?? fn`). For
 *     `src/server.ts:48:<arg0 of app.use>` driven through `src/server.ts:20:start`
 *     that is four slots against a driver that declares none, and validate.mjs
 *     refuses it: `4 args given, driver src/server.ts:20:start declares 0`.
 *
 * So the row is completed HERE, into the shape the two tools downstream
 * actually accept. Nothing is invented: every value written in is one this step
 * already held — the demanded boundary block, the driver's own parameter list
 * out of scan.json, the sentinel from the file that refuses it.
 *
 * WHERE THIS BELONGS. `renderSkeleton` should emit a row that stands alone when
 * it is read alone, and the `args`-against-the-driver defect is squarely in it
 * (worklist.mjs:780 builds the slots from `g.owner.params` and never looks at
 * the driver). worklist.mjs is not this step's to edit, so the completion is
 * done here and said out loud in `did` — reported, never silent, which is the
 * one thing `steps.never-repair-a-tools-output.test.mjs` is about.
 * ------------------------------------------------------------------------ */

/** Every function the scan resolved, keyed the way validate.mjs keys it. */
export function readScan(path) {
  if (!path || !existsSync(path)) return new Map();
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Not fatal and not silent: `callShape` degrades to the owner's signature
    // and NAMES the degrade on the item, so a row whose driver could not be
    // read says so rather than reading as a driver with no parameters.
    return new Map();
  }
  return new Map((doc.functions ?? []).map((f) => [f.id, f]));
}

/**
 * THE UNFILLED-SLOT SENTINEL, READ OFF THE ROW THE TOOL PRINTED.
 *
 * Not a second spelling of `<<DERIVE>>` and NOT an import either. A second
 * spelling is a slot this step writes that validate.mjs does not recognise as
 * unfilled — a skeleton that passes the gate with nothing derived into it. An
 * import of `SKELETON_TODO` from validate.mjs would be the usual answer (it is
 * how worklist.mjs gets it), and it cannot be used here: a step is loaded
 * beside whatever toolset is INSTALLED in the target repo, and a toolset whose
 * validate.mjs predates that export stops the whole walk at module load —
 * `workflow.steps.vocabulary-ruling-report.test.mjs` installs exactly such a
 * one and the walk died at `derive` with "does not provide an export named".
 *
 * Reading it off `renderSkeleton`'s own output is stronger than either: it is
 * the same bytes the tool wrote into this very row, so the two cannot disagree
 * about what an unfilled slot looks like. The literal is the fallback for a row
 * that is not there to be read.
 */
export const SKELETON_TODO = "<<DERIVE>>";

export function sentinelOf(row) {
  const candidates = [row?.rationale, row?.args?.[0]?.from?.evidence, row?.args?.[0]?.from?.reading];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c;
  return SKELETON_TODO;
}

/** An unfilled provenance slot, exactly as `renderSkeleton` writes one. */
const derivedSlot = (arm, todo) => ({ arm, evidence: todo, reading: todo });

/* --------------------------------------------------------------------------
 * THE ARMS THIS ROW MAY CITE — handed over as data, not recalled as a rule
 *
 * THE DEFECT, run `20260916T223906Z`. Round 3 submitted 135 proposals;
 * `validate.mjs` reported 353 faults and this step quarantined 99 of them. 95
 * of the 99 are two messages that are one bug:
 *
 *     62  `from.arm` cites <path>, which this proposal does not list in `covers`
 *     33  `from.arm` cites <path>, which is not an arm in scan.json
 *
 * Counted over the whole run log, 170 of 355 fault lines are the first and 177
 * are the second — and 169 of those 170 and 66 of the 177 name a
 * `.boundaries.<symbol>` slot. Not `args`, not `setup`. One field.
 *
 * WHY THAT FIELD, and it is this step's own hand-over rather than the agent's
 * invention. `worklist.mjs:renderSkeleton` writes the demanded boundary block
 * under `functionBoundaries`, keyed by FUNCTION, and stamps every answer's
 * provenance with `slot(first.armId)` — `g.arms[0]`, the first arm of the
 * function's group. That address is correct WHERE THE TOOL PUTS IT:
 * `validate.mjs:997` passes `null` instead of `covers` for an answer the row
 * INHERITED, so the cross-check is skipped and a function-level citation is
 * legal by construction.
 *
 * `fillSkeleton` then lifts that block onto the ROW, because an answer sitting
 * in a sibling the agent does not submit is the defect commit `a6813ec` fixed.
 * On the row it is no longer inherited, `p._inherited` is empty, and
 * `checkEvidence` runs the comparison with this row's `covers`. Measured on
 * that run's own skeleton — 300 rows, 259 of them carrying a hoisted block —
 * 505 of 622 boundary answers carry an arm the row does not cover, condemning
 * 204 of the 300 rows before the agent has written a single character.
 *
 * The row quoted in the refusal is exactly this. `anonymous-23-if-0` covers
 * `…googleLocationCache.decorator.ts#23:if:0` and cites
 * `…#14:entry:0` on both `boundaries.prisma` and `boundaries.md5` — byte for
 * byte what `functionBoundaries` handed it, under a note that says the
 * addresses are already filled in and a rule that says retyping a join key is
 * how a claim stops being verifiable. The agent did as it was told.
 *
 * WHY THE SECOND MESSAGE IS THE SAME BUG. The three ids the run reports as
 * "not an arm in scan.json" are
 * `src/services/location.service.ts:278:matchingLocations` (81 times),
 * `src/services/location.service.ts#165` (67) and
 * `src/services/location.service.ts:165:matchingLocation` (62). Two are
 * FUNCTION ids and one is a truncated arm id — none is a copy of anything the
 * item carries. They are constructed, and they are constructed in the same
 * field, because the field is the one place the hand-over is wrong and the
 * agent is left repairing it by hand. Remove the thing to construct and both
 * classes go.
 *
 * THE RULE IS NOT REIMPLEMENTED HERE. `checkEvidence` decides with
 * `covers.includes(evidence.arm)` (validate.mjs:329); `citableArms` returns
 * that same `covers` and every comparison below is `includes` on it.
 * `tests/derive.cites-only-what-it-covers.test.mjs` drives the real
 * `validate.mjs` over a row built from this list and a row built from an arm
 * outside it, so the two cannot drift into agreeing on paper and disagreeing in
 * the run.
 *
 * AND THE LIST IS NEVER NARROWER THAN THE TOOL'S. A legal set computed too
 * narrowly makes an honest proposal unwritable, which is worse than a refusal
 * because a refusal comes back as a question and an unwritable row comes back
 * as nothing. So this is `covers` itself, whole, not a chosen element of it.
 * ------------------------------------------------------------------------ */

/**
 * The arms a row's `from.arm` may name — `checkEvidence`'s own `covers`.
 *
 * Every `from` in the document is checked against this one list:
 * `args[].from` at validate.mjs:774, `setup[].from` at :957 and
 * `boundaries.<symbol>.from` at :997. `invoke.from` is not cross-checked at
 * all, so it is not named here; a list that claimed a field the tool does not
 * check would be this step asserting a rule of its own.
 */
export function citableArms(row) {
  return [...(row?.covers ?? [])];
}

/**
 * How `fillSkeleton` tells `skeletonNote` it re-addressed a boundary citation.
 *
 * Through `filled`, which is already the record of what this step completed and
 * already a parameter of both — rather than as a fifth argument. Not tidiness:
 * `tests/derive.items-file.test.mjs:467` proves its refusal by cutting the
 * `note: skeletonNote(...)` line out of this file verbatim, so a signature
 * change there silently disarms that guard instead of failing it. One constant,
 * one producer, one reader.
 */
export const REPOINTED = "from.arm re-addressed to this row: ";

/** The symbols `fillSkeleton` re-addressed, read back off `filled`. */
export const repointedIn = (filled = []) => {
  const line = filled.find((f) => typeof f === "string" && f.startsWith(REPOINTED));
  return line ? line.slice(REPOINTED.length).split(", ").filter(Boolean) : [];
};

/** The three `from` blocks `checkEvidence` is called on, in document order. */
export const CITE_FIELDS = COVERS_RULE.fields;

/**
 * The demanded block, re-addressed for the row it is about to live on.
 *
 * The function-level `from.arm` is a PLACEHOLDER and nothing else: the tool
 * writes `slot(first.armId)` beside `evidence: "<<DERIVE>>"` and
 * `reading: "<<DERIVE>>"`, so no reading has been taken off that arm and there
 * is no evidence to lose by moving it. What the move restores is the tool's own
 * intent one branch away — `args` in the same function get `slot(a.armId)`,
 * this row's arm, for exactly the reason this block now needs it.
 *
 * ONLY WHEN IT IS ILLEGAL. An answer whose arm the row already covers is left
 * untouched, so a block that was right stays byte-identical and `repointed`
 * names only what changed. Copies rather than mutates: the block belongs to
 * `skeleton.boundaries` and is shared by every side of the function.
 */
export function rowBoundaries(block, citable) {
  const to = citable[0] ?? null;
  const out = {};
  const repointed = [];
  for (const [sym, ans] of Object.entries(block ?? {})) {
    if (!ans || typeof ans !== "object" || !ans.from || typeof ans.from !== "object") {
      out[sym] = ans;
      continue;
    }
    if (!to || citable.includes(ans.from.arm)) {
      out[sym] = { ...ans, from: { ...ans.from } };
      continue;
    }
    out[sym] = { ...ans, from: { ...ans.from, arm: to } };
    repointed.push(sym);
  }
  return { block: out, repointed };
}

/**
 * The parameter a `default-arg` arm is ABOUT.
 *
 * Its side label is the scan's own sentence — `timeZone falls back to its
 * default` — and the name in front of that phrase is the parameter. Read off
 * the label rather than off `source`, because `source` is the whole declaration
 * (`{ maxRetry, actionName, delayMs }: { … } = { maxRetry: 3 }`) and the label
 * is the part of it the scan already isolated.
 */
export function defaultedParam(side) {
  const m = /^(.*?)\s+falls back to its default\s*$/.exec(String(side ?? ""));
  return m ? m[1] : null;
}

/**
 * HOW THIS ROW IS CALLED, decided exactly the way the two tools downstream
 * decide it — never a fourth opinion about the same question.
 *
 *   driver   `via` names a function the scan resolved, and that function
 *            declares parameters. validate.mjs positions `args` against IT
 *            (validate.mjs:663) and record.mjs CALLS it
 *            (record.mjs:756, `fnIndex.get(proposal.via ?? proposal.functionId)`).
 *            So the slots are the driver's, named for the driver's parameters.
 *
 *   built    the subject has to be constructed, because nothing a caller can
 *            pass reaches it. Two ways in:
 *              - the driver declares NO parameters while the subject declares
 *                some. There is no value to vary, so the arm cannot be aimed
 *                through the driver at all — and driving it anyway runs whatever
 *                the driver does. `src/server.ts:20:start` opens a real socket
 *                (it reaches `app.listen(PORT)`) and still cannot deliver the
 *                four arguments `<arg0 of app.use>` takes.
 *              - `via` is a `trigger:`, which record.mjs:714 refuses outright
 *                unless the proposal supplies an `invoke` of its own.
 *            `invoke.build` exempts the row from BOTH arity checks
 *            (validate.mjs:726 and :741) and makes the built expression the
 *            subject record.mjs runs (record.mjs:1059-1083), which also means
 *            `via` no longer selects what is called — so no socket is opened.
 *            The slots are then the SUBJECT's own parameters, which is what
 *            record.mjs passes to it (`builtArgs ?? args[]`, record.mjs:1083).
 *
 *   owner    everything else: no `via` at all, or a `via` the scan does not
 *            resolve to a function (`export redisCache` names a binding). The
 *            minimum-arity check does not run on the second of those
 *            (validate.mjs:721) and the maximum still counts the owner's, so
 *            the owner's signature is the shape in both.
 */
export function callShape({ item, row, signatures = {}, scan = new Map() }) {
  const fnId = item?.owner?.functionId ?? row?.functionId ?? null;
  const ownerParams = signatures[fnId] ?? item?.owner?.params ?? [];
  const via = row?.via ?? null;
  const trigger = typeof via === "string" && via.startsWith("trigger:");
  const driverId = via && !trigger ? via : null;
  const driver = driverId ? scan.get(driverId) : null;
  const driverParams = driver ? (signatures[driverId] ?? driver.params ?? []) : null;

  if (trigger) {
    return {
      subject: "built",
      params: ownerParams,
      positionalIn: fnId,
      driverId: null,
      why: `\`via\` is "${via}" — a framework fires this, so nothing can call it but \`invoke.build\`.`,
    };
  }
  if (driver && driverParams.length === 0 && ownerParams.length > 0) {
    return {
      subject: "built",
      params: ownerParams,
      positionalIn: fnId,
      driverId,
      why:
        `the driver "${driverId}" declares NO parameters while this subject declares ${ownerParams.length}: there ` +
        `is nothing a caller can vary through it, so the arm cannot be aimed that way and driving it anyway just ` +
        `runs whatever it does.`,
    };
  }
  if (driver) {
    return {
      subject: "driver",
      params: driverParams,
      positionalIn: driverId,
      driverId,
      // D58: HOW THE DRIVER IS BUILT, from the scan's own entry recipe for it -
      // for a class method the class, the member and the constructor's
      // parameters. `owner.entry` is the SUBJECT's recipe, and for a
      // module-private helper it says only "not exported", which is how an
      // agent handed getWinningFieldAndTerm read "call it directly" off a row
      // that record.mjs drives as `new SearchDebugService().execute(...)`.
      ...(driver.entry ? { driverEntry: driver.entry } : {}),
      why:
        `you are calling the driver "${driverId}", not ${fnId} — whose own parameters are supplied by whatever ` +
        `invokes it inside the driver, so they get no slot.`,
    };
  }
  // D58: NO DRIVER BECAUSE THE SCAN FOUND NONE IS NOT "NO DRIVER EXISTS". The
  // owner branch below said "has its own entry" of every row with no `via`,
  // including one whose owner has NO own entry and whose via the scan left
  // unresolved - getWinningFieldAndTerm in sourcing-ms, run 20260926T203755Z,
  // asked twice and declared needs-seam twice off `call.driver: null`. When the
  // entry is unreachable the contract says so plainly, carries where the
  // static walk stopped and the module's callable functions it suggests, and
  // leaves the decision to a reading of the source.
  const unresolvedKind = item?.via?.kind ?? "unresolved";
  const unresolved =
    !driverId && item?.owner?.entry?.reachable === false && (unresolvedKind === "unresolved" || unresolvedKind === "needs-seam")
      ? (item?.via ?? { kind: "unresolved" })
      : null;
  if (unresolved) {
    const nearby = unresolved.nearby ?? [];
    return {
      subject: "owner",
      params: ownerParams,
      positionalIn: fnId,
      driverId: null,
      unresolved: {
        kind: unresolved.kind ?? "unresolved",
        ...(unresolved.note ? { note: unresolved.note } : {}),
        ...(unresolved.ends?.length ? { ends: unresolved.ends } : {}),
        nearby,
      },
      why:
        `${fnId} has NO own entry and the scan's call graph did not resolve a driver for it ` +
        `(${unresolved.note ?? unresolved.kind ?? "unresolved"}). That is a limit of the static walk, not a finding ` +
        `that nothing calls it` +
        (nearby.length
          ? `: the callable functions of the same module are ${nearby.join(", ")} - read whether one of them reaches ` +
            `this side, and if one does, set \`via\` to it and fill \`args\` positionally in ITS signature.`
          : `, and the module has no callable function to suggest.`) +
        ` Declare the side unreachable only with proof that no caller reaches it.`,
    };
  }
  return {
    subject: "owner",
    params: ownerParams,
    positionalIn: fnId,
    driverId: driverId ?? null,
    why: driverId
      ? `"${driverId}" is not a function the scan resolved, so its arity is unknown and \`args\` stay positional ` +
        `in ${fnId}'s own signature.`
      : `${fnId} has its own entry, so \`args\` are its own parameters in declaration order.`,
  };
}

/**
 * HOW MANY SLOTS, and why a `default-arg` arm gets FEWER than the signature has.
 *
 * A parameter takes its default only when it is NOT PASSED. The skeleton hands
 * one slot per declared parameter and the note says "Fill VALUES ONLY", so for
 * `src/utils/date.ts#1:default-arg:0 [timeZone falls back to its default]` both
 * of the two available moves are wrong: fill both slots and `timeZone` IS
 * passed, the arm takes its other side, and the `reaches` claim comes back
 * FALSE at stage 6 indistinguishably from a mis-aimed input; leave one
 * `<<DERIVE>>` and validate.mjs errors on the sentinel (validate.mjs:1035).
 *
 * A SHORT `args` ARRAY IS LEGAL, and this is not an inference — validate.mjs
 * compares against `required`, the count of NON-OPTIONAL parameters
 * (validate.mjs:716), and a parameter with a default is optional. Confirmed by
 * running the real tool: a one-slot row for two-parameter `formatDate`
 * validated with zero errors and zero warnings.
 *
 * So the array STOPS at the defaulted parameter. Everything from there on is
 * optional too (a required parameter cannot follow a defaulted one), so
 * truncating there is the only shape in which the default applies — and it is
 * the shape this step hands over, rather than a rule the agent has to guess.
 * When the truncation would not be legal, or when the row is driven through
 * someone else's signature so the defaulted parameter is not in `args` at all,
 * nothing is truncated and the note says which it is.
 */
export function argSlots({ item, side, shape, row }) {
  const arm = citableArms(row)[0] ?? item?.armId;
  const todo = sentinelOf(row);
  const full = shape.params.map(() => ({ from: derivedSlot(arm, todo) }));
  if (item?.kind !== "default-arg" || shape.subject !== "owner") {
    return { slots: full, truncatedAt: null, param: null };
  }
  const want = defaultedParam(side);
  if (!want) return { slots: full, truncatedAt: null, param: null };
  const at = shape.params.findIndex((p) => paramName(p?.name) === paramName(want) || p?.name === want);
  // Legal only if every parameter from there on is optional — otherwise the
  // short array would breach the minimum and validate.mjs would refuse it.
  if (at < 0 || !shape.params.slice(at).every((p) => p?.optional)) {
    return { slots: full, truncatedAt: null, param: want };
  }
  return { slots: full.slice(0, at), truncatedAt: at, param: want };
}

/**
 * THE ROW, COMPLETED — the whole document, nothing left in a sibling.
 *
 * A NEW object every time. The row this is built from is the tool's own output,
 * shared by every side of a packet through `skeleton.rows`, and mutating it
 * would rewrite what the tool printed for sides this call was not about.
 */
export function fillSkeleton({ item, side, row, boundaries = {}, shape, slots }) {
  if (!row) return { row: null, filled: [] };
  const citable = citableArms(row);
  const arm = citable[0] ?? item?.armId;
  const todo = sentinelOf(row);
  const filled = [];
  const out = { ...row };

  // EVERY BOUNDARY validate.mjs WILL DEMAND, in the document that answers it.
  // The skeleton leaves this `{}` because its own window declares them once per
  // function in `functionBoundaries`; a single row lifted out of that window has
  // no such block, and with none in the file validate.mjs reads the ROW's own
  // block as the whole answer set (validate.mjs:234). A row that already
  // overrides a symbol keeps its override.
  const demanded = Object.keys(boundaries ?? {});
  if (demanded.length && !Object.keys(row.boundaries ?? {}).length) {
    // RE-ADDRESSED ON THE WAY IN. The block is legal where the tool wrote it —
    // under `functionBoundaries`, where validate.mjs:997 skips the covers
    // cross-check for an inherited answer — and illegal the moment it is a row's
    // own block, which is what this hoist makes it. See `rowBoundaries`.
    const re = rowBoundaries(boundaries, citable);
    out.boundaries = re.block;
    filled.push(`boundaries (${demanded.length}: ${demanded.join(", ")})`);
    if (re.repointed.length) filled.push(`${REPOINTED}${re.repointed.join(", ")}`);
  }

  if (Array.isArray(row.args) && slots && slots.slots.length !== row.args.length) {
    out.args = slots.slots;
    filled.push(`args (${row.args.length} slot(s) -> ${slots.slots.length})`);
  } else if (slots) {
    out.args = slots.slots;
  }

  // The subject has to be built, so the field that builds it is IN the document
  // rather than a shape the agent has to know to reach for. `from` is required
  // beside it for the same reason every other value here carries one.
  if (shape?.subject === "built" && !row.invoke) {
    out.invoke = { build: todo, from: derivedSlot(arm, todo) };
    filled.push("invoke.build");
  }
  return { row: out, filled };
}

/**
 * THE NOTE, REWRITTEN TO BE TRUE OF THIS ROW.
 *
 * The tool's note is correct about the tool's document and false about this
 * one: it names `functionBoundaries` and `functionSignatures`, and neither
 * reaches an item. A note that names a key the reader cannot find is worse than
 * no note, because the reader concludes the key is missing and builds it — which
 * is exactly what happened.
 *
 * So this one names ONLY keys that are on the row in front of it, and says the
 * arm-kind rule where there is one. Every rule in it is checked by
 * `validate.mjs` or run by `record.mjs`, and the lines that were carried over
 * from the tool's note are carried over verbatim.
 */
export function skeletonNote({ item, side, row, shape, slots, filled = [] }) {
  const todo = sentinelOf(row);
  const repointed = repointedIn(filled);
  const lines = [
    `SKELETON for ONE side. Every address is already in it. Fill VALUES ONLY; see \`proposal.rules\` for what that ` +
      `means everywhere, and the rest of this note for what it means HERE.`,
  ];

  if (row) {
    const names = shape.params.map((p, i) => `[${i}] ${paramName(p?.name)}`);
    lines.push(
      `\`args\` is positional in the signature of ${shape.positionalIn}: ${names.join(", ") || "(no parameters)"}. ` +
        shape.why
    );
    if (slots?.truncatedAt !== null && slots?.truncatedAt !== undefined) {
      lines.push(
        `THIS \`default-arg\` ARM'S \`args\` IS DELIBERATELY SHORT — ${slots.slots.length} slot(s) for ` +
          `${shape.params.length} declared parameter(s) — and a short array is LEGAL here (see \`proposal.rules\`). ` +
          `\`${slots.param}\` takes its default only when it is NOT PASSED, so the array stops before it. Do not add ` +
          `the slot back: filling it passes \`${slots.param}\` and the arm takes its other side.`
      );
    } else if (item?.kind === "default-arg") {
      lines.push(
        `This arm is a \`default-arg\`: the side is taken only when the defaulted parameter is NOT PASSED. The array ` +
          `below is full length because the parameter is not one of these slots (this row is driven through ` +
          `${shape.positionalIn}) — say in \`rationale\` how the call leaves it unpassed.`
      );
    }
    if (shape.subject === "built") {
      lines.push(
        `\`invoke.build\` IS THE CALL — a JS expression yielding the subject, called with the \`args\` below. ` +
          `\`via\` stays byte-exact and is NOT a second instruction about what to run (see \`proposal.rules\`).`
      );
    }
    lines.push(
      Object.keys(row.boundaries ?? {}).length
        ? `\`boundaries\` is ON THIS ROW, keyed by symbol — every one validate.mjs demands, module already filled ` +
          `in; only \`behaviour\` and \`mock.kind\` are yours. \`null\` says this row does not answer it.`
        : `\`boundaries\` is empty because validate.mjs demands no answer for this row.`
    );
    // WHERE THE AGENT MEETS THE RULE. `proposal.rules` says what it is and why;
    // this says what it means for THIS row, because the list it has to pick from
    // is this row's and not the file's.
    const arms = citableArms(row);
    lines.push(
      `Every \`from.arm\` in this row is ALREADY one of \`proposal.cite.arms\` — ${arms.join(", ") || "(none)"} — ` +
        `and must stay one of them: validate.mjs refuses a \`from.arm\` this row's \`covers\` does not list. The ` +
        `line a value was actually read off goes in \`from.evidence\`, which is where a citation outside this row ` +
        `belongs and where nothing refuses it.`
    );
    if (repointed.length) {
      lines.push(
        `The boundary answer(s) ${repointed.join(", ")} were declared once for the whole function, so their ` +
          `\`from.arm\` named the function's first arm. On this row that is a citation this row cannot be checked ` +
          `against, so it now names the arm above. \`behaviour\`, \`mock.kind\`, \`evidence\` and \`reading\` are ` +
          `still yours.`
      );
    }
  }
  if (filled.length) {
    lines.push(`Completed by the derive step, not by worklist.mjs --skeleton: ${filled.join("; ")}.`);
  }
  return lines.join(" ");
}

/**
 * THE RULES THAT ARE TRUE OF EVERY ROW IN THE FILE.
 *
 * Split out of the note for one reason: they are the same sentences on every
 * item, so they are written once (see `shareOnce`) while the note above stays
 * about THIS row. Every clause here is enforced by `validate.mjs` — the
 * sentinel at validate.mjs:1035, the value/build pair at :759, the banned
 * output fields at :1025 — and none of it names a key that is not on the row.
 */
export const proposalRules = (todo) =>
  [
    `Every "${todo}" is a refusal until you replace it — that slot IS the derivation.`,
    `An args entry needs a \`value\` (a literal) or a \`build\` (a JS expression stage 4 evaluates); \`build\` wins ` +
      `when both are present, and a \`build\` that mentions \`value\` needs the \`value\` it is built from.`,
    `\`functionId\`, \`covers\`, the \`reaches\` labels and \`via\` are JOIN KEYS matched byte-exactly by ` +
      `validate.mjs, by stage 4's verdict and by stage 6's claim check. They are already filled in. Retyping one is ` +
      `how a claim silently stops being verifiable.`,
    `A \`from.arm\` MUST BE ONE OF \`proposal.cite.arms\`, which is this row's \`covers\` and nothing else. ` +
      `validate.mjs's \`checkEvidence\` refuses any other id — either as "which this proposal does not list in ` +
      `\`covers\`" or, if you built the id rather than copying one, as "which is not an arm in scan.json". It checks ` +
      `\`args[].from\`, \`setup[].from\` and \`boundaries.<symbol>.from\`. THE REASON IS NOT BOOKKEEPING: the only ` +
      `thing this row can be run against is the sides it covers, so provenance pointing outside them is provenance ` +
      `nobody can check by running this row. WHEN THE VALUE GENUINELY COMES FROM SOMEWHERE ELSE — a driver's ` +
      `parameter, a line in the function's entry region before your branch — that is what \`from.evidence\` and ` +
      `\`from.reading\` are for: put the real \`file:line\` and the sentence there, and let \`from.arm\` name the ` +
      `arm of yours the value serves. Never drop a \`from\` to get past this, and never invent one: an unsourced ` +
      `value is a fabricated value, and validate.mjs is the only thing standing between the two.`,
    `There is no field for an expected output and there must not be — \`expected\`, \`expects\`, \`returns\`, ` +
      `\`assert\` and \`snapshot\` are refused. Stage 4 records what happened; stage 3 only aims.`,
    `One row per uncovered SIDE. Merge rows freely afterwards, since one call takes one side of every point it ` +
      `passes through.`,
    `HOW \`args\` IS SIZED, which your item's \`proposal.note\` states for your row. When \`via\` names a function ` +
      `the scan resolved, \`args\` is positional in THAT function's signature and not the owner's — validate.mjs ` +
      `checks it there (validate.mjs:663) and record.mjs calls it (record.mjs:756). Otherwise it is the owner's.`,
    `A SHORT \`args\` ARRAY IS LEGAL, and it is the only answerable shape for a \`default-arg\` arm. validate.mjs ` +
      `compares the length against the count of NON-OPTIONAL parameters (validate.mjs:716), and a parameter with a ` +
      `default is optional — so stopping the array before that parameter is how it is left unpassed. Filling every ` +
      `slot passes it, the arm takes its other side, and the \`reaches\` claim comes back FALSE at stage 6 looking ` +
      `exactly like a mis-aimed input.`,
    `WHEN \`invoke.build\` IS PRESENT it is the call: record.mjs runs that expression as the subject and calls it ` +
      `with \`args\` (record.mjs:1059-1083), and it does NOT call \`via\`. \`via\` stays byte-exact because ` +
      `validate.mjs reads it as the scan's statement that the arm is reachable at all — the two do not contradict ` +
      `each other, and nothing drives the \`via\` function, so a driver that would open a socket does not open one.`,
  ].join(" ");

/**
 * One item's whole brief.
 *
 * Everything in here is a value some tool already held exactly. Nothing in here
 * is a value for the input: the parameter TYPES and NAMES come from the
 * skeleton (capped by it), the condition SOURCE is the arm's own text, and
 * there is deliberately no slot anywhere for an expected output.
 */
export function contextFor({ item, side, skeleton, handoff, schema, vocabulary, packet = null, scan = new Map() }) {
  const fnId = item.owner?.functionId;
  const row = skeleton.rows.get(sideKey(item.armId, side)) ?? null;
  const boundaries = skeleton.boundaries[fnId] ?? {};
  // THE ROW COMPLETED INTO A DOCUMENT THAT STANDS ALONE — see the block above.
  // Decided before anything is written, from the same two sources the tools
  // downstream decide it from, so this step cannot hold a fourth opinion about
  // how the row is called.
  const shape = callShape({ item, row, signatures: skeleton.signatures, scan });
  const slots = row ? argSlots({ item, side, shape, row }) : null;
  const { row: document, filled } = fillSkeleton({ item, side, row, boundaries, shape, slots });
  return {
    arm: {
      armId: item.armId,
      kind: item.kind,
      file: item.file,
      line: item.line,
      // VERBATIM, literals and all — it is the condition being read, not a
      // value to paste, and worklist.md already prints it for that reason.
      source: item.source,
      side,
      sides: item.sides ?? [],
      uncoveredSides: item.uncoveredSides ?? [],
      lane: item.lane ?? "unit",
      via: item.via ?? null,
    },
    owner: {
      functionId: fnId,
      name: item.owner?.name,
      async: item.owner?.async ?? false,
      // The ENTRY RECIPE as the scan resolved it — how this function is called
      // at all: the import, the class and member, the constructor's parameters.
      // Handed over whole rather than rendered into a sentence, because the
      // fields are what a call has to be built out of.
      entry: item.owner?.entry ?? null,
      // From the SKELETON, not from the work list: the skeleton caps names and
      // types at 2000 characters and flags the cut. One inferred type in this
      // fleet is 16,233 bytes, and a brief that carries it is a brief nobody
      // reads.
      params: skeleton.signatures[fnId] ?? [],
    },
    // EVERY BOUNDARY validate.mjs WILL DEMAND AN ANSWER FOR — THE ROW'S OWN
    // BLOCK, and not `functionBoundaries`.
    //
    // THE BUG THIS FIXES, which was latent and would only have shown on a real
    // repo. `derive.items-file.test.mjs` asserts this is a COPY of the block on
    // the row rather than an extra the agent has to move across by hand — that
    // was defect 2, where the note said "boundaries are declared once per
    // function in `functionBoundaries`" and no such key was ever in the item.
    // Since `worklist.mjs:855-858` began filtering identity symbols out of
    // `functionBoundaries` via `identityUse`, the two stopped being the same
    // set: the ROW carries every demanded symbol, identity or not, while
    // `functionBoundaries` carries only the ones the function CALLS. On a repo
    // with an `instanceof` arm the sibling would have been missing a symbol
    // validate.mjs demands an answer for, and the test that says it is a copy
    // would have started failing against the real tool while every stub-backed
    // test kept passing.
    //
    // So the sibling is the row's block, which is the ANSWER SET. The narrower,
    // identity-filtered set still decides the QUESTION — `run` reads it from
    // the skeleton for `kindOf`, which is the one thing it was ever for, and
    // that is the narrowing worklist.mjs documents at the same lines.
    //
    // It stays a sibling rather than moving to the packet header: a side has to
    // be answerable from its own item, `derive.packet.test.mjs` refuses a handed
    // item with no boundaries, and this is evidence about the row rather than
    // reference material about the file.
    boundaries: document?.boundaries ?? boundaries,
    stage4: handoff,
    proposal: {
      // The document to fill, with every address already in it. `covers`, the
      // `reaches` labels and `via` are join keys matched byte-exactly; this is
      // the copy that cannot be mistyped. It is the WHOLE document: every
      // `<<DERIVE>>` the agent must answer is in here, keyed the way the note
      // below says, and nothing it must fill lives in a sibling of this object.
      skeleton: document,
      // AUTHORED HERE, and deliberately not `skeleton.note`. The tool's note is
      // true of the tool's window and false of one row out of it — it names
      // `functionBoundaries` and `functionSignatures`, and neither reaches an
      // item. See `skeletonNote`.
      note: skeletonNote({ item, side, row: document, shape, slots, filled }),
      // THE LEGAL SET, AS DATA. `from.arm` is the one address in the document
      // that is neither pre-filled everywhere nor free, and the run this came
      // from lost 95 of 99 quarantined rows to it. The agent picks from this
      // list instead of recalling the rule; `citableArms` is `checkEvidence`'s
      // own `covers`, so there is nothing here to construct and nothing to
      // remember. `proposal.rules` carries the reasoning.
      cite: {
        arms: citableArms(document),
        fields: [...CITE_FIELDS],
      },
      // The clauses that are true of every row in the file, and therefore
      // written once for the file rather than once per item.
      rules: proposalRules(sentinelOf(document)),
      // HOW THIS ROW IS CALLED, said as data as well as in the note, so a
      // reader can tell a driver-shaped `args` from an owner-shaped one without
      // parsing prose.
      call: {
        subject: shape.subject,
        positionalIn: shape.positionalIn,
        driver: shape.driverId,
        ...(shape.driverEntry ? { driverEntry: shape.driverEntry } : {}),
        ...(shape.unresolved ? { unresolved: shape.unresolved } : {}),
        params: shape.params.map((prm) => paramName(prm?.name)),
        ...(slots?.truncatedAt !== null && slots?.truncatedAt !== undefined
          ? { shortArgsBecause: `${slots.param} must not be passed for this side to be taken` }
          : {}),
        ...(filled.length ? { completedByDerive: filled } : {}),
      },
      schema,
    },
    vocabulary,
    // WHICH SIDES ARE ONE PIECE OF WORK. Absent when the caller has no packet
    // to name — a recorder outcome is addressed by PROPOSAL and the side it
    // hangs on may not even be in this round, so a packet named for it would be
    // a roster of sides nobody was handed.
    ...(packet ? { packet: packetView(packet) } : {}),
  };
}

/* ------------------------------------------------------------------------ *
 * WRITTEN ONCE PER FILE
 *
 * MEASURED on the fixture at /tmp/p8test, run `20260916T165524Z`:
 * `worklist-decisions.json` was 537,373 bytes for 56 items, and 215,432 of
 * those bytes — 52% — were blocks byte-identical in ALL 56. Three of them did
 * almost all of it: `proposal.schema` at 1,667 bytes × 56, `stage4.addresses`
 * at 1,109 × 56, the skeleton note at 792 × 56.
 *
 * That is not a tidiness problem, it is the defect the whole projection exists
 * to prevent. The stage-3 skill says "Do not open `worklist.json` with a
 * script... your item's `context` is the projection", and prices the habit it
 * is replacing at 936 seconds over 99 calls. There is no way to read 537 KB of
 * JSON except with a script, so the answering turn ran NINE `node -e`
 * projections over the artifact meant to end that behaviour.
 *
 * THE PROPERTY, stated so it can be tested rather than admired:
 *
 *   To act on any item, the agent reads that ITEM, plus a set of locations that
 *   is THE SAME for every item in the file. No item sends the reader to a
 *   location chosen by that item's own content — no per-item index, no key
 *   looked up from a value on the item. So there is nothing to JOIN: a join is
 *   a lookup whose target varies with the row, and that is what makes a script
 *   the only way to read one item.
 *
 * `shareOnce` is the whole mechanism. The fixed location is THE FIRST ITEM of
 * `pending` — the same item for every reader, named on every other item in
 * words, and first in the file so it is read before anything that points at it.
 * Everything an item must FILL stays on the item: the arm, the owner, the
 * boundaries, and the completed document itself. What moves is reference
 * material — the vocabularies `validate.mjs --schema` prints and the address
 * table from the stage-4 brief — which is identical for all of them because it
 * is about the RULES and not about the side.
 *
 * WHY NOT A TOP-LEVEL KEY, which is the obvious shape. The file is written by
 * `workflow.mjs:writeWorklist`, which renders exactly `{ step, pending }` and
 * is not this step's to change. A `shared` block beside `pending` is the right
 * answer and it belongs there; this is the version of it available from inside
 * a step, and it costs one sentence per item to say where the block is.
 *
 * WHY NOT A SECOND FILE. Because that is the failure this is guarding against:
 * an item whose meaning is spread over an items file plus two sidecars is an
 * item the agent rejoins with a script, which is the defect rebuilt with more
 * steps. Everything stays in the one file the prompt already names.
 * ------------------------------------------------------------------------ */

/**
 * The blocks that are REFERENCE and not evidence: the same bytes whatever side
 * is in front of you, because they are about how a proposal is written rather
 * than about this arm. Addressed by path so the replacement can say exactly
 * what it replaced.
 */
export const SHARED_BLOCKS = Object.freeze([
  Object.freeze({
    path: ["proposal", "schema"],
    what: "the proposal vocabularies `validate.mjs --schema` prints",
    also: "re-printable at any time with `node .claude/charpilot/validate.mjs --schema`",
  }),
  Object.freeze({
    path: ["stage4", "addresses"],
    what: "the stage-4 address table — which boundaries are default-deny, which addresses are real",
    also: "also the `## Addresses, and what must never be called` section of the brief named in `stage4.brief`",
  }),
  Object.freeze({
    path: ["proposal", "rules"],
    what: "the rules that hold for every row in this file",
    also: null,
  }),
  Object.freeze({
    path: ["vocabulary"],
    what: "where the service's own values are written, by key and never by value",
    also: null,
  }),
  // THE PROSE HALF OF `limits`, and only that half. The NUMBERS stay on every
  // item — they are this round's, they are what run 20260916T194950Z's
  // answering turn invented for want of them, and an agent that has to go
  // somewhere else to find out how much it may do is the defect intact. What
  // moves is the paragraph explaining them, which is the same on every item of
  // every round because it is about the RULES and not about this round.
  Object.freeze({
    path: ["limits", "says"],
    what: "what the numbers in `limits` mean, and what a bad row in a large submission actually costs",
    also: null,
  }),
  // THE CHECKPOINT. Prose about the rule, identical on every item of every
  // round, so it is written once at the top of each packet's own file.
  Object.freeze({
    path: ["limits", "checkpoint"],
    what: "how to get the REAL verdict on one scenario before building a family on it, and what that verdict does and does not prove",
    also: null,
  }),
]);

const readPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** A copy with `path` replaced. Never mutates: items are handed to the walk. */
function withPath(obj, path, value) {
  if (!path.length) return value;
  const [head, ...rest] = path;
  return { ...obj, [head]: withPath(obj?.[head] ?? {}, rest, value) };
}

/**
 * ONE COPY OF EACH SHARED BLOCK, AT THE TOP OF THE FILE ITS READERS ARE IN.
 *
 * WHAT CHANGED AND WHY. This used to hold each block once for the WHOLE ROUND,
 * on one chosen packet's items, with every other item carrying a sentence
 * naming that item. That was correct while the round was one file. It is wrong
 * the moment the handover is one file per packet: seven files out of eight
 * would carry a sentence naming an item in the eighth, and answering a packet
 * would mean opening two files — which is the defect being removed, rebuilt
 * with more steps.
 *
 * So the unit of sharing is now the PACKET, and the home is the packet's own
 * header, which the walk writes at the top of the packet's own file. Every item
 * in the file names a block that is above it in the same file. Nothing is
 * fetched from anywhere.
 *
 * A BLOCK IS ONLY LIFTED WHEN IT IS BYTE-IDENTICAL ON EVERY ITEM OF THE PACKET
 * THAT CARRIES ONE — the condition the original refusal is written in. A packet
 * whose items genuinely differ in a block keeps its copies, because then the
 * block is evidence about the side and not a rule about the file.
 *
 * IT IS LIFTED EVEN WHEN ONE ITEM HOLDS IT, and that is deliberate rather than
 * an oversight in the arithmetic. It saves nothing on a one-side packet — it
 * costs a sentence. What it buys is that the shape of a brief does not depend
 * on how many sides its function happens to have open: every packet file reads
 * the same way, and every item of every packet is byte-identical to its
 * siblings in these fields, which is the invariant
 * `derive.packet.test.mjs` fixes and which a size-dependent rule would make
 * true only sometimes.
 */
export function shareIntoPackets(pending) {
  const holds = (p, block) => readPath(p.context, block.path) !== undefined && readPath(p.context, block.path) !== null;

  // The packet files this round will be written as, in round order. The header
  // object is SHARED by a packet's items, so writing into it once is what puts
  // the block at the top of that one file.
  const groups = new Map();
  for (const p of pending) {
    const header = p?.bundle;
    if (!header) continue;
    if (!groups.has(header.id)) groups.set(header.id, { header, items: [] });
    groups.get(header.id).items.push(p);
  }
  if (!groups.size) return { pending, shared: [], saved: 0 };

  const tally = new Map();
  let saved = 0;
  const replaced = new Map();

  for (const { header, items } of groups.values()) {
    for (const block of SHARED_BLOCKS) {
      // ONLY THE ITEMS THAT HOLD A BLOCK ARE ASKED ABOUT IT. A refused
      // submission is an item about one named field in a file the agent already
      // wrote — it has no `proposal` and no `stage4`, and reading its missing
      // block as "these are not all identical" silently disabled the whole of
      // this for any round that carried one. Which was every interesting round.
      const holders = items.filter((p) => holds(p, block));
      if (!holders.length) continue;
      const rendered = holders.map((p) => JSON.stringify(readPath(p.context, block.path)));
      if (new Set(rendered).size !== 1) continue;

      const key = block.path.join(".");
      header.shared[key] = readPath(holders[0].context, block.path);
      // A SENTENCE AND NOT A POINTER EXPRESSION. `pending[0].context.proposal.schema`
      // is an instruction to a script; this is an instruction to a reader, and a
      // reader is what this file is for. It names a place ABOVE the item, in the
      // same file, so following it is scrolling and not a lookup.
      const text = `Same for every item in this packet, so it is written once at the top of this file: \`packet.shared["${key}"]\`.`;
      for (const p of holders) {
        replaced.set(p, (replaced.get(p) ?? []).concat([{ block, text }]));
      }
      const was = tally.get(key) ?? { key, bytes: rendered[0].length, copies: 0, wasCopies: 0 };
      // `copies` is now files-that-hold-it, one per packet, and `wasCopies` is
      // the item copies there would otherwise be. Both are printed in `did`.
      tally.set(key, { ...was, copies: was.copies + 1, wasCopies: was.wasCopies + holders.length });
      saved += (rendered[0].length - text.length) * (holders.length - 1);
    }
  }
  if (!replaced.size) return { pending, shared: [], saved: 0 };

  const out = pending.map((p) => {
    const edits = replaced.get(p);
    if (!edits) return p;
    let context = p.context;
    for (const { block, text } of edits) context = withPath(context, block.path, text);
    return { ...p, context };
  });
  return { pending: out, shared: [...tally.values()], saved };
}

/**
 * THE BRIEF FOR AN ITEM THAT IS NOT AN ARM OF A FUNCTION THIS ROUND IS READING.
 *
 * A refused submission and a recorder outcome are not sides of a packet: they
 * are about a file the agent already wrote. They still need a file of their
 * own, because the property is about EVERY item — read one file, act on any
 * item in it — and an item filed nowhere would be the one exception that makes
 * the rule untestable.
 */
export function soloHeader(item) {
  const id = `item ${item.id}`;
  // A REPAIR OF A ROW THAT EXISTS ANSWERS UNDER THE FILE THAT ROW LIVES IN —
  // the rule `packetHeader`'s caller already keeps for a packeted item, and the
  // one this header broke: a recorder outcome and a refused submission are
  // exactly the items that never have a packet, so every one of them was
  // reserved a FRESH name. email-centralization-ms, the evening run of 25
  // September: the outcome for `parseProviderValue-46-if-0`, a row of
  // answers-ffcef063db98.json, reserved answers-fc411f67279c.json; the worker
  // repaired the row there under its own id, and validate.mjs quarantined both
  // copies as `duplicate id`.
  const resubmit = item?.context?.submission?.resubmit?.file ?? item?.context?.recorded?.proposalFile ?? null;
  return {
    id,
    count: 1,
    sides: [item.id],
    repeats: [],
    shared: {},
    // ONE NAME FOR THIS FILE TOO. A refused submission and a recorder outcome
    // are answered like anything else, and "every file has its own name" has to
    // be true of every file or it is a rule with a hole in it.
    answers: answersBlock({ packetId: id, file: resubmit ? basename(resubmit) : null }),
    ...packetFurniture(),
    why:
      "one item, on its own. It is not an arm of a function this round is reading — it is about a document that has " +
      "already been written — so it is answered by itself. THIS FILE IS THE WHOLE JOB: nothing in it sends you to " +
      "another file.",
  };
}

/* ------------------------------------------------------------------------ *
 * WHAT THE LAST WORKER LEARNED ABOUT THIS FUNCTION, CARRIED IN ITS PACKET.
 *
 * MEASURED on run `20260916T223906Z`: 95% of source reads were of a file an
 * earlier round had already read — 93 of 98 calls, 13 of 17 files — and
 * `location.service.ts` was read 31 times across rounds 1-3. Round 2 fanned out
 * and each subagent re-read independently. Every round and every worker meets
 * each function cold.
 *
 * THE HALF WITH THE MOST VALUE IS THE ONE CURRENTLY DISCARDED OUTRIGHT: the
 * attempts that did NOT work, and why. A worker that already knows "driving
 * through `start()` opens a socket and cannot deliver the arguments" does not
 * spend a round rediscovering it — and that sentence is a thing the recorder
 * already said, in `skipped[].reason`, which nothing carried forward.
 *
 * WHERE THE NOTES COME FROM, and every one of them is a tool's own bytes or a
 * named reading of them:
 *
 *   OBSERVED   this round's verify-on-write outcomes for proposals of this
 *              function, and the recorder's `skipped[]` verdicts the probe
 *              already read. record.mjs said these.
 *   DERIVED    what this step concluded from those bytes — that a function the
 *              recorder cannot call has declaration questions and not argument
 *              questions. Named as a reading so the next worker checks it.
 *   UNTESTED   nothing here mints one. A step has no hypotheses; it has
 *              artifacts. The kind exists because a note carried forward may be
 *              one, and it must not silently become a fact by being passed on.
 *
 * THE FINGERPRINT IS OVER THE FUNCTION'S OWN SOURCE, read at its declaration
 * through `scan.json`'s `file`/`line`/`endLine`. A note whose fingerprint is not
 * this round's is NOT SERVED and is counted as dropped. That bounds STALENESS
 * and nothing else — see `notesBlock`'s own sentence, which is on every packet
 * that carries notes: a note is evidence, never authority, and a note trusted
 * INSTEAD of the source propagates one early misreading to every round that
 * touches the function.
 * ------------------------------------------------------------------------ */

export const briefSourceOn = (env = process.env) => env.CHARPILOT_BRIEF_SOURCE === "on";
export const BRIEF_SOURCE_MAX_BYTES = 6000;

/**
 * PLAN 20 T2.5c, behind CHARPILOT_BRIEF_SOURCE=on: THE FUNCTION'S OWN SOURCE,
 * IN THE BRIEF, WITH ITS PROVENANCE.
 *
 * A packet's time is its model output (95% API time in the packetcost rows), and
 * each turn resends the whole context (~65k tokens, a median 12 turns). The
 * first turns of a worker are Read calls on the file the packet names. Putting
 * the function's exact lines at the top of the packet lets the worker start on
 * turn 1. `provenance` is `file:start-end`, so a bundle can be checked against
 * the source. Capped at BRIEF_SOURCE_MAX_BYTES so a large function cannot push
 * the brief past `briefCensus`'s budget: over the cap it says so and the worker
 * reads the file as before. Everything else still comes from the note cache
 * and the worker's own reads.
 *
 * AND ITS BOUNDARIES, WHICH THE FUNCTION'S OWN LINES DO NOT SHOW. The first
 * A/B on a real repo (nginx-redirecting-ms, run 20260924T074107Z) quarantined
 * 20 rows in round 2 against the control's 3, 15 of them "no answer declared
 * for boundary `logger`" or `sendSlackNotification`: a worker handed the body
 * and told to "read further only for what they call" never read the file's
 * top, so it never saw what was imported. The scan already knows the list --
 * it is exactly what validate.mjs checks -- so the block carries it, with the
 * import lines that name each module, instead of the worker inferring it.
 */
export function sourceBlock(scan, functionId, { root = REPO_ROOT, cache = null, maxBytes = BRIEF_SOURCE_MAX_BYTES } = {}) {
  const fn = scan?.get?.(functionId) ?? null;
  if (!fn?.file || !fn.line) return null;
  const text = functionSource(scan, functionId, { root, cache });
  if (text == null) return null;
  const provenance = `${fn.file}:${fn.line}-${fn.endLine ?? fn.line}`;
  const bytes = Buffer.byteLength(text, "utf8");
  const boundaries = (fn.boundaries ?? [])
    .filter((b) => b?.symbol && b?.module)
    .map((b) => ({ symbol: b.symbol, module: b.module }));
  const imports = boundaries.length ? importLines(root, fn.file, boundaries, Number(fn.line)) : null;
  const reach = boundaries.length
    ? ` It reaches ${boundaries.length} boundary(ies) -- ${boundaries.map((b) => `\`${b.symbol}\` (${b.module})`).join(", ")} -- and every row must declare an answer for each one it calls in \`boundaries\`; validate.mjs refuses a row that does not. Their import lines are in \`imports\`.`
    : " It reaches no boundary the scan can see.";
  const withBoundaries = (block) => ({ ...block, ...(boundaries.length ? { boundaries } : {}), ...(imports ? { imports } : {}) });
  if (bytes > maxBytes) {
    return withBoundaries({ provenance, bytes, text: null, says: `The function is ${bytes} bytes, over the ${maxBytes}-byte limit for the brief: read ${provenance} yourself.${reach}` });
  }
  return withBoundaries({ provenance, bytes, text, says: `These are the function's exact lines (${provenance}). Start from them; read further only for what they call.${reach}` });
}

/**
 * The file's import statements that name one of `boundaries`' modules, above
 * `before`, as `{ lines: "a-b, c-d", text }`, or null. A multi-line import is
 * taken whole, from its `import` line to the line naming the module.
 */
export function importLines(root, file, boundaries, before = Infinity) {
  let lines;
  try {
    lines = readFileSync(join(root, file), "utf8").split("\n");
  } catch {
    return null;
  }
  const modules = new Set(boundaries.map((b) => b.module));
  const ranges = [];
  const limit = Math.min(lines.length, Number.isFinite(before) ? before - 1 : lines.length);
  for (let i = 0; i < limit; i++) {
    const m = /(?:from\s*|require\(\s*|import\s*)(["'])([^"']+)\1/.exec(lines[i]);
    if (!m || !modules.has(m[2])) continue;
    let start = i;
    while (start > 0 && i - start < 30 && !/^\s*(import|const|let|var)\b/.test(lines[start])) start--;
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = i;
    else ranges.push([start, i]);
  }
  if (!ranges.length) return null;
  return {
    lines: ranges.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}-${b + 1}`)).join(", "),
    text: ranges.map(([a, b]) => lines.slice(a, b + 1).join("\n")).join("\n"),
  };
}

/** The function's own source text, at its declaration, or null. */
export function functionSource(scan, functionId, { root = REPO_ROOT, cache = null } = {}) {
  if (!functionId) return null;
  if (cache?.has(functionId)) return cache.get(functionId);
  const fn = scan?.get?.(functionId) ?? null;
  let text = null;
  if (fn?.file && fn.line) {
    try {
      const lines = readFileSync(join(root, fn.file), "utf8").split("\n");
      const end = Number(fn.endLine ?? fn.line);
      text = lines.slice(Number(fn.line) - 1, Number.isFinite(end) ? end : Number(fn.line)).join("\n");
    } catch {
      // A source file the scan names and this checkout does not hold is a
      // disagreement worth nothing here: no text means no fingerprint, and no
      // fingerprint means no note is served. Silence is the safe direction.
      text = null;
    }
  }
  cache?.set(functionId, text);
  return text;
}

/**
 * The notes this round can serve for one function: carried forward, plus what
 * this round observed.
 *
 * `{ block, minted, dropped }`, and `block` is null when there is nothing to
 * say — a packet with no notes carries no notes field at all, rather than an
 * empty one a reader has to decide to ignore.
 */
export function notesForFunction({ functionId, source, carried = [], observations = [] }) {
  const { served, stale } = servableNotes(carried, { functionId, source });
  const minted = [];
  for (const o of observations) {
    const note = boundedNote({ kind: o.kind, functionId, source, what: o.what, why: o.why, from: o.from });
    if (note) minted.push(note);
  }
  // DEDUPLICATED ON WHAT IS SAID, so a function that failed the same way in
  // three rounds carries the sentence once. The first copy wins, and `served`
  // is first, so a note that has survived a round is the one that is kept.
  const seen = new Set();
  const all = [];
  for (const note of [...served, ...minted]) {
    const key = `${note.kind}${note.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(note);
  }
  if (!all.length && !stale.length) return { block: null, minted: minted.length, dropped: 0 };
  return {
    block: notesBlock({ served: all.slice(0, NOTE_LIMITS.perPacket), dropped: stale.length, functionId, source }),
    minted: minted.length,
    dropped: stale.length,
  };
}

/**
 * Every observation this round holds about a function, as note material.
 *
 * `Map<functionId, [{ kind, what, why, from }]>`. Nothing is invented: `what` is
 * the recorder's own sentence, and the one DERIVED entry says in its own text
 * that it is a conclusion rather than a measurement.
 */
/**
 * behaviour.json's rows by id, or an empty map when there is no recording yet.
 * Never throws: a missing or unreadable recording means no note, not a round lost.
 */
export function recordedRowsById(outDir) {
  const out = new Map();
  try {
    const doc = JSON.parse(readFileSync(join(outDir, "behaviour.json"), "utf8"));
    for (const r of doc?.rows ?? []) if (r?.id && !out.has(r.id)) out.set(r.id, r);
  } catch {
    // no recording yet, or one this round cannot read - no notes from it
  }
  return out;
}

export function observationsByFunction({ results = [], probe = new Map(), landed = new Map(), recorded = new Map() } = {}) {
  const out = new Map();
  const add = (functionId, note) => {
    if (!functionId) return;
    if (!out.has(functionId)) out.set(functionId, []);
    out.get(functionId).push(note);
  };
  for (const r of results) {
    // A PASS TEACHES NOTHING WORTH CARRYING and `not-run` is this step's own
    // convenience failing to happen, not a fact about the function.
    if (!r?.outcome || r.outcome === OUTCOMES.VERIFIED || r.outcome === OUTCOMES.NOT_RUN) continue;
    if (!r.why) continue;
    add(r.proposal?.functionId, {
      kind: NOTE_KINDS.OBSERVED,
      what: `${r.proposal?.id ?? "a proposal"} did not work: ${r.why}`,
      why: `recorded outcome \`${r.outcome}\`${r.rule ? ` (${r.rule})` : ""}`,
      from: r.artifact ? here(r.artifact) : null,
    });
  }
  // A CLAIM THE MEASUREMENT PROVED FALSE, AND WAS WITHDRAWN (fix plan 1, F3.2).
  //
  // The side returns to the brief as unaccounted, and without this the next
  // worker meets it cold: it writes the same input, the recorder freezes the
  // same other arm, and the claim is false again. The `withdrawn` record on the
  // row is propose.mjs's own bytes - what istanbul counted and what the input
  // DID reach - so the note carries a measurement, not an opinion.
  for (const { row } of landed.values()) {
    for (const w of Array.isArray(row?.withdrawn) ? row.withdrawn : []) {
      // What the recorder saw that row do, from behaviour.json: the arms its
      // input moved, and what it threw. That is usually the whole diagnosis -
      // notification-ms's retry rows threw `reading 'info'` on an undefined
      // `this.logger` before the arm, and moved two other arms instead.
      const rec = recorded.get(row.id) ?? null;
      const reached = [
        ...(w?.reached?.verifiedClaims ?? []).map((v) => `${v.arm} [${v.side}]`),
        ...(rec?.armsMoved ?? []).map((a) => `${a.armId} [${(a.sides ?? []).join(", ")}]`),
      ];
      const threw = rec?.threw
        ? ` It threw ${rec.threw.$error ?? "an error"}: ${String(rec.threw.message ?? "").slice(0, 200)}.`
        : "";
      add(row.functionId, {
        kind: NOTE_KINDS.OBSERVED,
        what:
          `${row.id} claimed ${w?.arm} [${w?.side}] and the measurement says its input never reached it ` +
          `(${w?.evidence?.hits ?? 0} istanbul hit(s), ${w?.evidence?.mechanism ?? "mechanism not recorded"}); ` +
          `the claim was withdrawn.${threw} What that input did reach: ${reached.length ? reached.join(", ") : "nothing recorded"}. ` +
          `A new input for this side has to take a different path, not repeat this one.`,
        why: `the \`withdrawn\` record propose.mjs wrote on ${row.id}`,
        from: w?.artifact ?? null,
      });
    }
  }
  for (const [functionId, verdict] of probe) {
    add(functionId, {
      kind: NOTE_KINDS.OBSERVED,
      what: `the recorder could not invoke this function${verdict?.via ? ` through \`${verdict.via}\`` : ""}: ${verdict?.why ?? "no reason recorded"}`,
      why: `record.mjs's own \`skipped\` entry for ${verdict?.proposal ?? "a proposal of this function"}`,
      from: verdict?.artifact ? here(verdict.artifact) : null,
    });
    add(functionId, {
      kind: NOTE_KINDS.DERIVED,
      what:
        "DERIVED, not measured: because the recorder cannot call it, this function's open sides are declaration " +
        "questions and not argument questions — no set of arguments records against a subject that is never entered.",
      why: "read off the observed skip above; check it against that sentence before acting on it",
      from: null,
    });
  }
  return out;
}

/**
 * VERIFY-ON-WRITE — the proposal that just landed, recorded on its own, now.
 *
 * MEASURED, on run `20260916T031317Z`: the first proposal was written at minute
 * 45.2 and the first verdict — "38/38 claims verified" — arrived at minute
 * 52.5, covering 38 claims at once. Everything written in between was written
 * blind, and a wrong premise runs for as long as the batch is wide: on run
 * `20260915T111114Z` 40 of 55 false claims were two clusters, one subagent's
 * slice each, unchecked for forty minutes.
 *
 * That window is not a scheduling accident, it is the shape of the walk.
 * `record` is a LATER step and the walk exits 75 the moment this one hands
 * anything over, so nothing is recorded at all until every side is accounted
 * for. The whole deriving loop runs with no feedback, however many rounds it
 * takes — which is the one window the batch recording cannot cover, and the
 * only window this is for.
 *
 * So the round that reads the previous round's proposals off the disk also
 * RECORDS them, one at a time, and hands the recorder's own verdict back as the
 * next pending item instead of asking a second question built on the same
 * premise. record.mjs needs no change for this and gets none: `--only
 * <id-substring>` narrows what it executes (record.mjs:selectedOf) and
 * CHARPILOT_OUTPUT (record.mjs:492) sends the artifact somewhere the later
 * stages do not read — which is how the narrowed run cannot land on
 * behaviour.json and shrink it. Run `20260916T031317Z` used exactly that pair
 * by hand at minute 207.6.
 *
 * THE MODE RULE, which outranks the convenience. In `live` mode every recorded
 * row is a REAL BILLED REQUEST, so verify-on-write does not run and says so;
 * the batch recording covers those proposals as one decision about billing
 * rather than one per proposal. The mode comes from `liveDecision`
 * (stagingenv.mjs) through the record step's own `mode()`, so this step and the
 * tool it spawns cannot disagree about what the run is for. No `--live`, no
 * `--live-providers`, no `--fresh` is added anywhere here — `verifyArgv` is the
 * whole command line and it is two strings.
 *
 * WHAT IT COSTS, and why a round is capped. Stage 4 recorded ~132 rows in 14.3
 * minutes on run `20260916T031317Z`, ≈6.5 s per row — amortised over chunks of
 * 16, record.mjs's `--chunk` default. A `--only` run pays a whole vitest boot
 * for one row, so it is a MULTIPLE of 6.5 s rather than a fraction of it, and
 * record.mjs gives a narrowed run its own cache file (record.mjs:CACHE_FOR), so
 * none of this warms the broad recording that follows. Verify-on-write buys
 * EARLINESS and never total time. A round that bought it twenty times would
 * spend more than the batch it is anticipating; four keeps the added cost in
 * the order of the ~104 s one 16-row chunk already takes. A cluster shares its
 * premise — the first proposals of a slice carry the same assumption as its
 * last — so four per round is what surfaces a wrong premise in the round after
 * it was written rather than at minute 52.5.
 *
 * AND IT NEVER ENDS A ROUND. Every failure below degrades to the batch
 * recording and says so in `did`: a tool that exits non-zero, an artifact that
 * was not written, one that will not parse. A convenience that can end a run is
 * not a convenience, and this one anticipates a step that is still going to
 * run.
 */
export const VERIFY_ENV = "CHARPILOT_DERIVE_VERIFY";

/** See the cost paragraph above: four `--only` runs, not twenty. */
export const DEFAULT_VERIFY = 4;

/**
 * How many proposals this round records on their own.
 *
 * `0` is a legitimate thing to say here and is honoured — "do not spend this,
 * the batch recording is enough" — which is why this does not refuse 0 the way
 * `batchSize` does. There a 0 would hand over nothing while sides are open,
 * which the walk reports as a bug in this step; here it turns off an
 * anticipation of a step that still runs.
 */
export function verifyLimit(opts = {}, env = process.env) {
  const fromOpts = opts.verify !== undefined;
  const given = fromOpts ? opts.verify : env[VERIFY_ENV];
  const raw = fromOpts ? String(given) : String(given ?? "").trim();
  if (!fromOpts && raw === "") return DEFAULT_VERIFY;
  if (/^(off|no|false)$/i.test(raw)) return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${fromOpts ? "the `verify` option" : VERIFY_ENV} is ${JSON.stringify(given)}, which is not a number of ` +
        `proposals — it must be a whole number, or 0 (or "off") to leave every proposal to the record step. ` +
        `Unset it for the default of ${DEFAULT_VERIFY}.`
    );
  }
  return Number(raw);
}

/* ------------------------------------------------------------------------ *
 * THE ROUND'S REAL LIMITS, ON THE ITEM
 *
 * THE DEFECT, run `20260916T194950Z`. The answering turn wrote that it was
 * "staying under the 20-proposal claiming cap" and held itself to 12 proposals
 * in a round that took 66 minutes and produced 25 of 146 sides. THERE IS NO
 * SUCH CAP. Grepped across every prompt, every skill, every tool and the items
 * file itself, the phrase appears only in the agent's own words. It invented a
 * limit, obeyed it, and nothing it was handed could contradict it — because
 * nothing it was handed said anything about how much it was allowed to do.
 *
 * EVIDENCE QUALITY, said plainly because it decides the size of the fix: this
 * is ONE occurrence in ONE run, and round 1 across the three runs produced 76,
 * 25 and 2 sides, a spread that is mostly variance. NO SAVING IS CLAIMED HERE.
 * The fix is to state numbers that are true, and it stops there: a step that
 * argued with an agent about its pace would be a step with an opinion about
 * work it cannot see.
 *
 * THE NUMBERS ARE THIS RUN'S, not this file's. `batch` is already logged every
 * round (`metrics.batch`), the verify cap is already read from
 * `CHARPILOT_DERIVE_VERIFY`, and the open list is already counted — every one
 * of them is a value `run` is holding when the item is built, so none of them
 * is written down here. A constant in this block would be exactly the invented
 * cap one layer down, and harder to notice because it would look official.
 *
 * WHERE THIS DROPS OFF. "There is no cap" invites one enormous submission whose
 * single bad row used to take the whole file down with it. That risk is retired
 * by the quarantine — run `20260916T223906Z` refused 99 rows, set them aside,
 * and the round still advanced — but only while the quarantine holds, so the
 * block SAYS so rather than implying a submission is consequence-free.
 *
 * SHORT ON PURPOSE. Every string here is paid once per item, and a block that
 * explained itself at length would be the unreadable-brief defect wearing a
 * policy hat. The prose is four sentences; everything else is a number.
 * ------------------------------------------------------------------------ */

/**
 * What this round actually permits, built out of what `run` measured.
 *
 * Every field is either a count `run` is holding or the name of the variable
 * that set it, so a reader can check any of them against the same run's `did`
 * lines without taking this block's word for anything.
 */
export function roundLimits({ items, open, briefed, heldBack, batch, verify, concurrency }) {
  // VERIFY-ON-WRITE IS DERIVE'S AND NOT EVERY ROUND'S. `repair` calls this for
  // the same four sentences and the same five numbers, and it has no
  // verify cap — so the two fields that name one are OMITTED rather than
  // written as `null` beside the variable that would have set it, which is a
  // knob a repair round does not have described as though it did.
  return {
    // HOW MANY ITEMS THIS ROUND HOLDS, and how many of them may be answered.
    // The same number twice, deliberately: the second one is the question the
    // agent actually had and could not find an answer to.
    items,
    mayAnswer: items,
    // THE CAP THAT DOES NOT EXIST, said as data rather than left to be
    // inferred from its absence. `null` is the answer to "how many proposals
    // may one submission carry".
    perSubmissionCap: null,
    openSides: open,
    briefedThisRound: briefed,
    heldBack,
    roundCap: batch,
    roundCapFrom: BATCH_ENV,
    // THE CONCURRENCY, ON THE ITEM, because the item is what a worker reads.
    //
    // `PARALLELISM` has said "ONE WORKER PER PACKET" on every packet of every
    // round since `packetFurniture` existed, and `repair` shipped it with no
    // number to apply it with -- so repair rounds answered their packets in
    // series. Measured over the two container runs of 2026-09-21: every round
    // with zero child turns is that, 3199s of message-templates' 4817 (65%)
    // and 1590s of notification-ms'. message-templates round 3 ran 80 parent
    // turns in 1742 seconds with no worker at all -- 21.8s a turn, serial --
    // while its round 1 ran 673 turns in 1618 seconds across 12.
    //
    // OMITTED, NOT NULL, WHEN THERE IS NOTHING TO DEAL. A concurrency beside
    // an empty queue reads as a deal that was offered and declined. The
    // verify fields above are omitted for the same reason and it is the same
    // rule: a knob a round does not have is not described as though it did.
    // NO `...From` FIELD BESIDE IT, unlike `roundCapFrom`. The env var's name
    // carries the word this step's own invariant forbids in its code
    // (`derive.packet` scans for /subagent/i, and a dispatch is a decision
    // taken in the pack, not here), so the number is published and its source
    // stays documented in `handover.workerConcurrency`, which reads it.
    ...(concurrency === undefined || concurrency === null ? {} : { workerConcurrency: concurrency }),
    ...(verify === undefined ? {} : { verifiedNextRound: verify, verifiedFrom: VERIFY_ENV }),
    // THE CHECKPOINT, on every item, because the decision it exists to change
    // — how much to write before anything has judged one — is taken while
    // reading ONE item. A constant, so `SHARED_BLOCKS` writes it once per file.
    checkpoint: CHECKPOINT,
    // THE PROSE, SEPARATED FROM THE NUMBERS, because they are paid differently.
    // The numbers are this round's and belong on the item; these four sentences
    // are the same on every item of every round, so they are a reference block
    // and `SHARED_BLOCKS` writes them once (measured: 955 B/item x 20 items on
    // the vendored location-ms round, 9.6% of the whole handover, for a
    // paragraph that does not change).
    says:
      "There is no cap on how many of these you answer, in one file or in many: `mayAnswer` is every item here and " +
      "nothing in this pipeline limits a submission's size. `roundCap` bounds what this ROUND was briefed, never " +
      "what you may answer, and `heldBack` is the next round's work. A row validate.mjs refuses is quarantined — it " +
      "stays on disk, stops counting as an answer, and its side goes back into the brief — so one bad row in a large " +
      "submission costs that row and not the round: run 20260916T223906Z set 99 rows aside and the round still " +
      "advanced. That quarantine is the only thing making a large submission safe. NEVER DELETE A REFUSED ROW TO " +
      "MAKE ITS FILE PASS. The quarantine already set that row aside for you, and the file it is in is replaced " +
      "whole by your next write — so a document resubmitted without it is a document without every OTHER row it " +
      "carried too, and all of their sides come back next round as items nobody answered. Fix the row in place, or " +
      "leave the file alone and let the quarantine hold it. Every number above is this run's " +
      "own, as it stands now, and there are no limits other than these.",
  };
}

/**
 * The same limits block on every item of the round.
 *
 * ON EVERY ITEM and not on one, because the defect is an agent reading ONE item
 * and inventing what it may do. A refused submission is an item too, and it is
 * the one an agent reads while deciding whether to send its next batch in one
 * file or twelve.
 *
 * Never mutates: the items are handed to the walk, and `shareOnce` reads them
 * again afterwards.
 */
export function withLimits(pending, limits) {
  return pending.map((p) =>
    p?.context && typeof p.context === "object" ? { ...p, context: { ...p.context, limits } } : p
  );
}

/**
 * THE WHOLE COMMAND LINE, as a function so a test can assert it is exactly
 * this and not merely free of three flag names.
 *
 * `--only <id>` and nothing else. Every other thing record.mjs acts on —
 * `--env-file`, `--policy`, `--live` — comes from the operator through the
 * environment this process was given, which is the same rule the record step
 * spells out for its own bare spawn.
 */
export function verifyArgv(proposalId) {
  return ["--only", proposalId];
}

/**
 * Where the recorder is told to put this one proposal's observation.
 *
 * In OUT_DIR itself and not a subdirectory: record.mjs creates OUT_DIR
 * (record.mjs:1737) and nothing else, and a step cannot make the directory for
 * it — a step never writes. The name carries `behaviour-` for the same reason
 * record.mjs's own narrowed output is `behaviour-partial.json`, and the id is
 * sanitised with record.mjs's own filename sanitiser so the two agree on what
 * a path segment built out of an id may contain.
 */
export function verifyArtifact(outDir, proposalId) {
  return join(outDir, `behaviour-verify-${String(proposalId).replace(/[^\w.-]+/g, "_")}.json`);
}

/**
 * The environment the recorder is handed: this process's, plus the ONE variable
 * that moves its output. Nothing that could change what the run costs.
 */
export function verifyEnv(artifact, env = process.env) {
  return { ...env, CHARPILOT_OUTPUT: artifact };
}

/** Every proposal stage 3 has written, with the claims it makes about itself. */
export function landedProposals(proposalsDir) {
  const out = [];
  if (!existsSync(proposalsDir)) return out;
  for (const file of readdirSync(proposalsDir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
    } catch {
      // validate.mjs raises this one, and `proposedSides` skips it for the same
      // reason: an unparseable file must not make its sides look answered here.
      continue;
    }
    const rows = Array.isArray(doc) ? doc : (doc.proposals ?? []);
    // `functionId` and `via` are carried for the probe below, which asks what
    // the recorder said about a FUNCTION and has only a proposal id to get
    // there from. `via` is the driver the recorder was told to call, and it is
    // what makes "could not be invoked" name a thing the agent recognises.
    // `boundaries` is carried for `verifyPattern` below, which is the only
    // reader of it here: a row's DECLARED boundary set is what decides whether
    // the recorder can arrange the run at all, and it is the field that was
    // copied unchanged across dozens of rows on run `20260916T095353Z`.
    for (const p of rows) {
      if (p?.id) {
        out.push({
          id: p.id,
          file,
          reaches: p.reaches ?? {},
          functionId: p.functionId ?? null,
          via: p.via ?? null,
          boundaries: p.boundaries ?? {},
        });
      }
    }
  }
  return out;
}

/**
 * The proposal ids an artifact already says something about, or null when there
 * is no artifact to read.
 *
 * The same question the record step asks of the same two fields
 * (steps/record.mjs:unaccounted), asked here against the directory THIS ROUND
 * was read from. A verify that asked about a different proposals directory than
 * the round it belongs to would report the wrong proposals as unrecorded, which
 * is why it takes a path rather than reusing that function's fixed constants.
 */
export function accountedIn(artifact) {
  if (!existsSync(artifact)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(artifact, "utf8"));
  } catch {
    return null;
  }
  const ids = new Set();
  for (const r of doc.rows ?? []) if (r?.id) ids.add(r.id);
  for (const s of doc.skipped ?? []) if (s?.id) ids.add(s.id);
  return ids;
}

/** Was the proposal edited after the observation of it was written? */
function changedSince(source, artifact) {
  try {
    return statSync(source).mtimeMs > statSync(artifact).mtimeMs;
  } catch {
    return true;
  }
}

/**
 * The proposals with no observation behind them yet.
 *
 * Two ways to already have one, and both are read off the disk: the batch
 * recording accounts for it, or this round's predecessor already recorded it on
 * its own. The second is what stops a round from paying for the same proposal
 * again — and an artifact OLDER than the proposal file is not an observation of
 * it, so a repaired input is recorded again rather than judged on what the
 * previous version did.
 */
export function toVerify(paths, batchArtifact) {
  const accounted = accountedIn(batchArtifact);
  const out = [];
  for (const p of landedProposals(paths.proposalsDir)) {
    if (accounted?.has(p.id)) continue;
    const artifact = verifyArtifact(paths.outDir, p.id);
    if (existsSync(artifact) && !changedSince(join(paths.proposalsDir, p.file), artifact)) continue;
    out.push({ ...p, artifact });
  }
  return out;
}

/* --------------------------------------------------------------------------
 * WHICH PROPOSALS THE ROUND SPENDS ITS VERIFICATIONS ON
 *
 * THE DEFECT, run `20260916T223906Z`: `derive: verify-on-write: recording 4 of
 * 135 newly written proposal(s) one at a time, 131 left to the record step's
 * batch`. The four were `waiting.slice(0, limit)`, and `waiting` is built by
 * `landedProposals` in file order, so the four were adjacent rows — in practice
 * consecutive arms of ONE function, carrying one entry recipe and one copy of
 * one boundary block. Four verdicts, one premise tested.
 *
 * RAISING THE NUMBER IS THE WRONG FIX. Each verification is a separate
 * `record.mjs --only` run and pays a whole vitest boot for one row, which is a
 * MULTIPLE of the ~6.5 s an amortised row costs — that much is priced above,
 * off run `20260916T031317Z`.
 *
 * WHAT IT IS NOT IS RUN `20260916T095353Z`, which five sentences in this repo
 * cited as "where per-row work made a round 56% slower". Measured off that
 * log: round 1 ran 28.2 min with ZERO verify-on-write recordings, round 2 ran
 * 43.8 min with ONE (it asked for four; three were skipped on blocked egress),
 * round 3 ran 11.5 min with FOUR. The 56% is round 2 over round 1 and the
 * delta is real, but one `--only` recording is not 15.6 minutes of it, and the
 * round that did four times the per-row work was the FASTEST in the run. THE
 * CAP HAS NO COST MEASUREMENT BEHIND IT. What it has is the argument below —
 * near-identical rows teach one thing however many are recorded — and that is
 * what it stands on. So the cap stays at four for that reason, and the
 * SELECTION changes: four rows that can fail differently, rather than the
 * first four rows.
 *
 * WHAT MAKES TWO ROWS ABLE TO FAIL DIFFERENTLY. `OUTCOMES` has five members and
 * three of them are decided by the row's arrangement rather than by its values:
 *
 *   invalid           the recorder refused the DOCUMENT — its fields
 *   cannot-invoke     the SUBJECT could not be called — the owner and its `via`
 *   mock-not-applied  the arrangement did not take — the declared boundary set
 *
 * `target-missed` and `verified` turn on the argument VALUES, which are the one
 * thing per-row and the one thing no key can predict. So the key is exactly the
 * three that are predictable — owner, `via`, declared boundary symbols with
 * their mock kinds — and nothing else. Two rows that agree on all three reach
 * the recorder the same way; the second one can only tell us about values,
 * which is what the batch recording is for.
 *
 * THE CONCRETE CASE, run `20260916T223906Z` — the same run as the defect
 * above, and it was cited here as `20260916T095353Z`, which never logged this
 * line:
 * `parseAddressesForJd-113-default-arg-0 produced no row — skipped: blocked
 * egress: prisma.apiKey - no boundary declared for it`. That is a
 * `mock-not-applied` and it is a property of the declared boundary set alone.
 * The same boundary block was then copied across dozens of rows before anything
 * reported it had not recorded — counted off that run's own `proposals/`, the
 * largest identical block is 40 of its 136 rows and the next is 37. More
 * verification of the same block would not have caught it one row sooner; one
 * verification of a different block would.
 *
 * AMBIGUITY RESOLVES TOWARDS MORE PATTERNS, never fewer — the same asymmetry
 * the quarantine states about held rows. Splitting a pattern that did not need
 * splitting costs one round's ordering; merging two that did costs a failure
 * that nothing looks at until the batch. That is why the owner is IN the key
 * even though two functions can share a boundary block: `cannot-invoke` is the
 * owner's property and nothing else's, so an uninvokable function whose rows
 * happen to share a block with an invokable one would otherwise never be asked.
 * ------------------------------------------------------------------------ */

/**
 * What kind of row this is, for the purpose of spending a verification on it.
 *
 * A STRING, so it can key a Map and be printed in `did` — a reader of the log
 * has to be able to see that four verifications went to four different things.
 * Built only out of fields the proposal itself carries: nothing here reads the
 * scan or the skeleton, because this runs before either is loaded and because a
 * selection that needed a tool run would cost more than the run it is choosing.
 */
export function verifyPattern(p) {
  const owner = p?.functionId ?? `(no functionId) ${p?.file ?? ""}`;
  const via = p?.via == null ? "(no via)" : typeof p.via === "string" ? p.via : JSON.stringify(p.via);
  // The SYMBOLS and their mock KINDS, sorted so two rows that declare the same
  // block in a different key order are one pattern. The mock's values are NOT
  // read: a different `resolves` value is a different value, not a different
  // way of reaching the recorder.
  const boundaries = Object.entries(p?.boundaries ?? {})
    .map(([symbol, b]) => `${symbol}:${b?.mock?.kind ?? "(no kind)"}`)
    .sort()
    .join(",");
  return `${owner}\u0000${via}\u0000${boundaries || "(no boundaries)"}`;
}

/**
 * The round's verifications, one per distinct pattern before any pattern gets a
 * second.
 *
 * `seen` is the patterns some earlier round already recorded on their own, read
 * off the observations on disk. Without it a family of ten rows would take a
 * slot every round for ten rounds while a pattern nobody has ever run waits —
 * the same defect as taking the first N, one round further out.
 *
 * ORDER, and all of it is deterministic because `landedProposals` sorts the
 * files and keeps each file's rows in order:
 *
 *   1. patterns with no observation behind them at all, before ones that have
 *      one. A verdict that exists is not bought again while one is missing.
 *   2. within that, the LARGEST family first. The blast radius of a wrong
 *      arrangement is the number of rows that copied it, and on run
 *      `20260916T223906Z` that was 40 of 136 rows for the largest block and 37
 *      for the next (counted off that run's `proposals/`). This cited
 *      `20260916T095353Z`, which is not the run the block came from.
 *   3. ties by first appearance, so the same directory always chooses the same
 *      rows.
 *
 * Then round-robin: every pattern gets its first row before any gets a second.
 * A budget larger than the number of patterns is still spent — leaving it
 * unspent would be a different round's regression — but it is spent breadth
 * first.
 */
export function selectToVerify(waiting, limit, { seen = new Set() } = {}) {
  const buckets = new Map();
  for (const p of waiting) {
    const key = verifyPattern(p);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }
  const order = [...buckets.entries()].map(([key, rows], at) => ({ key, rows, at, unseen: !seen.has(key) }));
  order.sort((a, b) => Number(b.unseen) - Number(a.unseen) || b.rows.length - a.rows.length || a.at - b.at);

  const take = [];
  for (let depth = 0; take.length < limit; depth += 1) {
    let placed = 0;
    for (const bucket of order) {
      if (take.length >= limit) break;
      if (depth >= bucket.rows.length) continue;
      take.push(bucket.rows[depth]);
      placed += 1;
    }
    if (!placed) break;
  }
  return {
    take,
    patterns: buckets.size,
    covered: new Set(take.map(verifyPattern)).size,
    unseen: order.filter((b) => b.unseen).length,
  };
}

/**
 * What the recorder said about one proposal.
 *
 * Read off `claimVerdicts` and `armsMoved`, which record.mjs writes per row
 * (record.mjs:annotateClaims) out of istanbul's own counters. Not recomputed
 * here: a second opinion about whether a side moved is a second thing to keep
 * true, and the interesting failure — a claim that reads as checked and is not
 * — is exactly what that produces.
 */
export function recordedVerdict(doc, proposalId) {
  const row = (doc.rows ?? []).find((r) => r?.id === proposalId) ?? null;
  const skipped = (doc.skipped ?? []).find((s) => s?.id === proposalId) ?? null;
  const verdicts = row?.claimVerdicts ?? [];
  return {
    row,
    skipped,
    armsMoved: row?.armsMoved ?? [],
    verified: verdicts.filter((v) => v.verdict === "verified"),
    wrong: verdicts.filter((v) => v.verdict === "false"),
    unmeasurable: verdicts.filter((v) => v.verdict === "unmeasurable"),
  };
}

/**
 * WHAT ONE ATTEMPT CAN HAVE BEEN. Five things, not a pass and a fail.
 *
 * MEASURED, run `20260916T112101Z`: the same side came back as `kind: input`
 * in three consecutive rounds while the recorder had already printed
 * `anonymous-single-18-if-0-then produced no row — skipped: the driver returns
 * a closure taking 3 argument(s)` ten times. Nothing routed on it because
 * nothing could: the round's only distinction was "a claim came back false"
 * against everything else, and "everything else" held a document the recorder
 * refused before reading it, an arrangement that never took, and a function it
 * could not call at all. Those three want three different next moves, and a
 * caller cannot route what it cannot tell apart — so each one is named.
 *
 *   invalid           the recorder refused the DOCUMENT. No call was attempted,
 *                     so nothing about the subject is known. Fix the field.
 *   cannot-invoke     the SUBJECT could not be called: no resolvable entry, an
 *                     unsupported entry kind, a factory whose returned closure
 *                     takes arguments, a decorator a framework applies. No
 *                     argument exists to derive — this side wants a declaration.
 *   mock-not-applied  the subject was reachable and the ARRANGEMENT was not:
 *                     an undeclared boundary, a `manual` setup, a row whose
 *                     imports threw before the subject ran. Declare it.
 *   target-missed     it RAN, and took another arm. Repair the input or the
 *                     claim.
 *   verified          the claim held.
 *
 * `not-run` is the sixth and is deliberately not one of the five: it is this
 * step's own convenience failing to happen (the tool exited non-zero, wrote
 * nothing, wrote something unparseable), and the record step's batch recording
 * still covers it. Reporting that as `invalid` would blame the proposal for a
 * spawn that did not work.
 */
export const OUTCOMES = Object.freeze({
  INVALID: "invalid",
  CANNOT_INVOKE: "cannot-invoke",
  MOCK_NOT_APPLIED: "mock-not-applied",
  TARGET_MISSED: "target-missed",
  VERIFIED: "verified",
  NOT_RUN: "not-run",
});

/** The vocabulary itself, in the order a reader meets it. */
export const OUTCOME_VOCABULARY = Object.freeze([
  OUTCOMES.INVALID,
  OUTCOMES.CANNOT_INVOKE,
  OUTCOMES.MOCK_NOT_APPLIED,
  OUTCOMES.TARGET_MISSED,
  OUTCOMES.VERIFIED,
  OUTCOMES.NOT_RUN,
]);

/**
 * The ones that become a pending item.
 *
 * `verified` is not a question. `not-run` is not one either — the batch
 * recording is going to ask it, and a round that handed back "this did not get
 * recorded early" would hand back one item per proposal for a spawn failure.
 */
export const ACTIONABLE_OUTCOMES = Object.freeze([
  OUTCOMES.INVALID,
  OUTCOMES.CANNOT_INVOKE,
  OUTCOMES.MOCK_NOT_APPLIED,
  OUTCOMES.TARGET_MISSED,
]);

/**
 * WHAT A CALLER DOES ABOUT EACH ONE, in one sentence, carried on the item.
 *
 * The name alone is a label; the label plus the next move is a route. This is
 * the whole difference between "skipped: the driver returns a closure taking 3
 * argument(s)" printed ten times and ten sides that stopped being asked as
 * argument questions.
 */
export const OUTCOME_ROUTES = Object.freeze({
  [OUTCOMES.INVALID]: "fix the named field of the proposal — the recorder never got as far as a call, so nothing about the subject is known yet",
  // D56: the recorder's reason goes in `why`, and `proof` is a SOURCE line.
  // "With the recorder's own reason as the proof" read as "cite behaviour.json",
  // whose lines move on every re-record; the ledger refuses a generated file.
  [OUTCOMES.CANNOT_INVOKE]: "stop deriving arguments for this function and write the declaration for its side: the recorder's own reason goes in `why`, and `proof` is the SOURCE line that makes the function uncallable (where it is written, or the call that registers it) - never a file under .claude/charpilot/, which the ledger refuses",
  [OUTCOMES.MOCK_NOT_APPLIED]: "declare the boundary or arrangement the recorder names, then the same input records",
  [OUTCOMES.TARGET_MISSED]: "repair the input so it takes the side it claims, or the claim so it names the arm it reaches",
  [OUTCOMES.VERIFIED]: "nothing — the claim held",
  [OUTCOMES.NOT_RUN]: "nothing here — the record step's batch recording still covers this proposal",
});

/**
 * RECORD.MJS'S OWN WORDS, sorted into the vocabulary above.
 *
 * Every pattern is anchored to the line of record.mjs that produces it, so a
 * reason that gets reworded there stops matching here rather than getting
 * quietly reclassified — and an unmatched reason is `null`, which is
 * UNDECIDED and routes nowhere. That is the safe direction: a skip nobody
 * classified is still reported with the recorder's sentence verbatim; a skip
 * classified WRONGLY as `cannot-invoke` would send a derivable side to
 * declaration with a written reason attached, which is the worst form of
 * coverage loss.
 *
 * ORDER MATTERS in exactly one place: two `invalid` reasons begin
 * `boundary <symbol> ` (record.mjs:960,977) and would otherwise be read by the
 * catch-all boundary rule as an arrangement that did not take. The invalid
 * rules are therefore first.
 */
export const SKIP_REASONS = Object.freeze([
  // FIRST, ahead of every rule that matches a phrase inside a sentence: the
  // recorder's own "this is our defect" (fix plan 1, F1.1 on fix/plan1-records,
  // record.mjs `classify`). A tool failed on the row; no input fixes it, and
  // coverage.mjs rules its side pipeline_defect.
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:pipeline-defect", re: /^pipeline defect: / },
  // fix/plan1-records (da4c8be), record.mjs's instance-field doubles (F3.1).
  // The row names a field its subject gives no receiver for: the recorder's
  // limit, the toolset's to fix.
  // D43: the subject is a constructor, which assigns its own fields: the
  // collaborator is answered at its module. Ahead of field-no-receiver.
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:field-ctor-subject", re: /^instance field .+ has no receiver in this row: the subject is the constructor itself, which assigns its own fields\b/ },
  // D43: the row's via is not one the scan resolves; the scan's own driver has the receiver.
  { outcome: OUTCOMES.INVALID, at: "record.mjs:field-via-not-the-scans", re: /^instance field .+ has no receiver in this row: via ".+" is not a driver the scan resolves for\b/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:field-no-receiver", re: /^instance field .+ has no receiver in this row\b/ },
  // A field double declared `value` with nothing to set: the proposal's
  // missing declaration, so it stays askable. Ahead of the `^boundary \S+ `
  // catch-all, which nothing classifies.
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:field-value-empty", re: /^boundary \S+ is an instance field declared `value` with neither a build nor a value\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:960,977", re: /\bmock\.build is not an executable expression\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:867", re: /\.apply\.call is not an executable expression\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:897", re: /\.build is an assignment, not a value expression\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:886", re: /\bhas no executable build\b|\bbuild uses await\/async\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:859", re: /^setup\.apply\.db supports\b/ },
  // Tool backlog: the `via` names a binding the arm is not a member of, and
  // names the member that does reach it. The proposal's field to fix.
  // Tool backlog: an arm in a function a binding's initializer calls at import.
  // No input reaches it: the proposal's move is the declaration.
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:called-at-import", re: /^via ".+" cannot reach \S+: \S+\(\) is called by the initializer of \S+ at import\b/ },
  { outcome: OUTCOMES.INVALID, at: "record.mjs:module-private-via", re: /^via ".+" cannot reach \S+: it is module-private in\b/ },
  // D43: the function is handed to a call and the binding holds the call's result.
  { outcome: OUTCOMES.INVALID, at: "record.mjs:wrapped-via", re: /^via ".+" cannot reach .+?: (?:it|it is reached through .+?, and .+?) is written inside the arguments of \S+\(\.\.\.\), which \S+'s initializer calls\b/ },
  // A `via` that is no driver's name at all - prose written into the field
  // (record.mjs viaNotADriver). The proposal's field to fix.
  { outcome: OUTCOMES.INVALID, at: "record.mjs:via-not-a-driver", re: /^via "[\s\S]+" is not a driver - via is one name, byte-exact\b/ },

  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:819", re: /^the driver returns a closure taking \d+ argument\(s\)/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:1784", re: /^no call shape for this entry kind$/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:765", re: /^entry kind .+ not supported yet$/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:763", re: /\bwith no driver named$/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:760", re: /^driver .+ not resolvable$/ },
  // D68: NOT cannot-invoke. The scan is the authority on function ids and every
  // packet deals the scan's own, so an id it does not have is the proposal's to
  // correct: a field of the document, and the function is as callable as ever.
  // Read as cannot-invoke it told run 20260927T061823Z's workers to stop
  // deriving and declare 8 sides of evaluateCandidateService/helpers.ts, and
  // coverage ruled them pipeline_defect. The recorder's sentence now names the
  // id, what was looked for and what the scan lists; the bare form is kept for
  // an artifact that predates it.
  { outcome: OUTCOMES.INVALID, at: "record.mjs:stale-function-id", re: /^functionId (?:not in scan\.json$|"[\s\S]*" is not in scan\.json - )/ },
  { outcome: OUTCOMES.CANNOT_INVOKE, at: "record.mjs:739,744", re: /^via ".+" names a binding but the arm is\b/ },
  // D56: NOT cannot-invoke. Since D47 the recorder refuses a trigger row only
  // while the proposal supplies no invoke of its own, so the missing thing is a
  // field of the proposal - `invoke.build` - and the side is reachable. Read as
  // cannot-invoke it sent 21 reachable sides of qode-itl-be (run
  // 20260926T165924Z) to declarations whose proof was this very sentence in
  // behaviour.json, and the ledger refused them. The rule name is kept, so
  // repair still reads it as the proposal's (SKIP_ABOUT_BY_RULE).
  { outcome: OUTCOMES.INVALID, at: "record.mjs:715", re: /a framework fires this, and the proposal supplies no invoke of its own/ },

  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:841", re: /^setup needs manual\b/ },
  // Tool backlog: a row stopped from outside because it never yielded. Its
  // declared answers feed a loop none of them ends, so the repair is the
  // proposal's. The chunk's other rows are kept (record.mjs runChunk).
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:wedged-row", re: /^did not settle: the row ran past its \d+ms budget without once yielding\b/ },
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:856", re: /^setup needs db\b/ },
  // FIX PLAN 1, F3.6. BEFORE the catch-all egress rule, and anchored to
  // `blockedReason`'s last line: the proposal declared nothing for the endpoint
  // it reached. That is the proposal's to fix (declare `fetch` with
  // `doubles.fetchStub`, say), not the recorder's. The other two egress
  // sentences, "declared and not installed" and "declared AND installed",
  // stay on the catch-all and stay the toolset's. `[\s\S]`, not `.`: the
  // endpoint's own error can be a multi-line dump (a ZodError, run
  // 20260923T080000Z), and `.` stops at the first newline.
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:3418", re: /^blocked egress: (?![\s\S]*(?:DOES declare|declared AND installed))[\s\S]+ - no boundary declared for it\b/ },
  // D68 follow-on, ahead of the catch-all: the proposal's own `module` sent the
  // answer away from the module the owner file imports (record.mjs
  // blockedReason). The proposal's field to correct, so the side stays askable.
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:module-overrides-import", re: /^blocked egress: [\s\S]+ - the proposal's own `module` put the answer for `[^`]+` at `[^`]+`, and \S+ imports `[^`]+` from `[^`]+`: / },
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:2551", re: /^blocked egress:/ },
  { outcome: OUTCOMES.MOCK_NOT_APPLIED, at: "record.mjs:944,997", re: /^boundary \S+ / },

  { outcome: OUTCOMES.NOT_RUN, at: "record.mjs:2553", re: /^runnable but not yet run in this session$/ },
]);

/**
 * One `skipped[].reason` as an outcome, or null when nothing here recognises it.
 *
 * Null is a real answer and the callers act on it: the reason is still printed
 * verbatim and still becomes an item, it simply does not claim to know WHICH of
 * the five it is, and the probe below will not reroute a side on it.
 */
export function outcomeOfSkip(reason) {
  const text = String(reason ?? "").trim();
  for (const rule of SKIP_REASONS) if (rule.re.test(text)) return { outcome: rule.outcome, rule: rule.at };
  return { outcome: null, rule: null };
}

/**
 * One recorded ROW as an outcome.
 *
 * `invoked` is record.mjs's own field and it is the split that matters. Every
 * path that sets `invoked: false` (record.mjs:5466, 5549, 5569) is an
 * ARRANGEMENT that did not hold — an egress the proposal declared no boundary
 * for, a module replacement vitest could not build, a row whose imports or
 * preconditions threw before the subject was entered — and record.mjs says so
 * itself in `harnessError`. None of them is the subject misbehaving, so none of
 * them is an observation, and all of them are repaired by declaring what is
 * missing rather than by choosing different arguments.
 *
 * With `invoked: true` the claims decide it: any `false` verdict means it ran
 * and took another arm. A row with neither a `false` nor a `verified` verdict
 * measured nothing about its claims, and that is UNDECIDED rather than a pass —
 * "unmeasurable" reported as `verified` is the claim that reads as checked and
 * is not, which is the failure this pipeline exists to refuse.
 */
export function outcomeOfRow(row) {
  const verdicts = row?.claimVerdicts ?? [];
  if (row?.invoked !== true) {
    const err = row?.harnessError ?? null;
    if (!err) return { outcome: null, rule: null, why: "the row is not marked `invoked` and carries no `harnessError` to say why" };
    return {
      outcome: OUTCOMES.MOCK_NOT_APPLIED,
      rule: "record.mjs:harnessError",
      why: `${err.name ?? "harness failure"}: ${err.message ?? "no message"}${err.phase ? ` (phase: ${err.phase} — ${err.why ?? ""})` : ""}`.trim(),
    };
  }
  if (verdicts.some((v) => v.verdict === "false")) {
    return { outcome: OUTCOMES.TARGET_MISSED, rule: "record.mjs:annotateClaims", why: null };
  }
  if (verdicts.some((v) => v.verdict === "verified")) {
    return { outcome: OUTCOMES.VERIFIED, rule: "record.mjs:annotateClaims", why: null };
  }
  return {
    outcome: null,
    rule: null,
    why: `the row ran and none of its ${verdicts.length} claim(s) came back verified or false — ${
      verdicts.map((v) => v.why).find(Boolean) ?? "the recorder gave no reason"
    }`,
  };
}

/**
 * The whole classification of one proposal against one recorded artifact.
 *
 * `{ outcome, why, rule, verdict }`, where `outcome` may be null — undecided —
 * and `why` is always record.mjs's own sentence rather than a paraphrase of it.
 */
export function outcomeFor(doc, proposalId) {
  const verdict = recordedVerdict(doc, proposalId);
  if (verdict.row) {
    const r = outcomeOfRow(verdict.row);
    return { ...r, why: r.why ?? verdict.wrong[0]?.why ?? null, verdict };
  }
  if (verdict.skipped) {
    const { outcome, rule } = outcomeOfSkip(verdict.skipped.reason);
    return { outcome, rule, why: verdict.skipped.reason, verdict };
  }
  return { outcome: null, rule: null, why: "it is in neither `rows` nor `skipped` of the artifact", verdict };
}

/**
 * Record the proposals that landed since the last recording, one at a time.
 *
 * Returns `{ did, contradictions, metrics }` and NEVER throws for anything the
 * recorder did: every branch that cannot produce an observation says so in
 * `did` and leaves that proposal to the record step.
 */
/* ------------------------------------------------------------------------ *
 * THE PHASE-3 TAIL, AND WHEN TO STOP OPENING ROUNDS FOR IT
 *
 * Round 1 always works. Every run this month landed 59-93% of the sides in it,
 * and then spent 31-57% of the WHOLE RUN on the last ten or twenty:
 *
 *   run 20260917T070737Z  round 1 33.0 min, tail 15.1 min (31% of the run)
 *   run 20260917T145735Z  round 1 29.0 min, tail 23.0 min (44%)
 *   run 20260917T082737Z  round 1 48.0 min, tail 45.3 min (49%)
 *   run 20260917T140215Z  round 1 44.7 min, tail 58.9 min (57%)
 *
 * The tail is the verify drain, and its cost is ROUNDS times the per-round
 * agent overhead, not items: round 3 of run 20260917T140215Z took 30 minutes
 * and moved `verifyActionable` from 8 to 8.
 *
 * WHY "NOTHING NEW WAS COVERED" IS NOT ENOUGH TO STOP. That same run's round 3
 * looks stalled on every visible counter, and round 4 then drained
 * `verifyActionable` 8 -> 0. What was actually moving was the QUEUE:
 * `verifyWaiting` fell 52 -> 32 -> 15 throughout. Stopping at round 3 would
 * have thrown away the run that was about to succeed.
 *
 * So a round is stalled only when the whole transition is flat: no new
 * proposals, no new declarations, AND the queue did not shrink. One such round
 * warns; two consecutive close the phase. Anything moving resets the count,
 * because an unchanged proposal can still become verifiable once another
 * repair lands.
 *
 * NOTHING IS LOST WHEN IT CLOSES. The walk falls through to `record`, and the
 * sides still open come back through `repair` aimed by a COVERAGE REPORT —
 * which is better evidence than a fourth reading of the same source. The
 * handover stays on disk and `satisfied` is answered from the filesystem, so a
 * closed phase 3 resumes rather than restarts.
 * ------------------------------------------------------------------------ */

/** The transition state a stall is judged on. Read back off the last index. */
export function progressOf(metrics = {}) {
  return {
    proposed: Number(metrics.proposed) || 0,
    blocked: Number(metrics.blocked) || 0,
    verifyWaiting: Number(metrics.verifyWaiting) || 0,
    verifyRecorded: Number(metrics.verifyRecorded) || 0,
    // HOW MUCH IS LEFT, carried in the handover rather than only logged.
    //
    // `openSides()` is the only thing that knows this number: it counts per
    // SIDE, drops items that are not instrumented, and drops sides already
    // proposed or declared. `worklist.json`'s `summary.uncoveredArms` is a
    // different quantity — worklist.mjs itself calls those "work UNITS ...
    // commissionable, NOT ratchetable" — and on qode-ptp-ms the two read 8,546
    // and 15,194. Anything outside this file that wants "how much is left" had
    // to either re-derive the filter and drift from it, or quote the number
    // that is 78% too large.
    //
    // `stalledAgainst` reads `proposed`, `blocked` and `verifyWaiting` by name,
    // so this is inert to stall detection.
    open: Number(metrics.open) || 0,
  };
}

/**
 * THE BEST THIS RUN HAS EVER DONE, carried forward — because a number that
 * MOVED is not a number that IMPROVED.
 *
 * THE BLIND SPOT THIS CLOSES. The first cut of `stalledAgainst` compared each
 * round to the one before it, so any change read as movement. Run
 * 20260917T140215Z went `proposed` 136 -> 136 -> 134 -> 130 while `open` went
 * 0 -> 2 -> 6: rounds 4 and 5 were UNDOING round 3, and a last-round comparison
 * calls that progress because the number is different. It is different and
 * worse.
 *
 * Against the high-water mark those rounds are what they are — nothing in them
 * beat 136, and the run had already been there. Round 3 still passes, because
 * the QUEUE hit a new low (32 -> 15) even though `proposed` was flat, which is
 * the case that has to keep working: round 4 then drained verifyActionable
 * 8 -> 0.
 */
export function bestOf(prev, now) {
  return {
    proposed: Math.max(prev?.proposed ?? 0, now.proposed),
    blocked: Math.max(prev?.blocked ?? 0, now.blocked),
    // The queue's best is its LOWEST — shrinking is the good direction.
    verifyWaiting: Math.min(prev?.verifyWaiting ?? Infinity, now.verifyWaiting),
  };
}

/**
 * Did this round move anything at all?
 *
 * `verifyRecorded` is deliberately NOT a progress term: rows reach the recorder
 * every round the queue is non-empty, so counting it would mean no round is
 * ever stalled. It is reported, not judged on.
 */
export function stalledAgainst(prev, now, best = null) {
  if (!prev) return false;
  // Judged against the best this run has reached, not against last round. A
  // round that is merely DIFFERENT from its predecessor — the churn of
  // 20260917T140215Z, proposed 136 -> 134 -> 130 while open went 0 -> 2 -> 6 —
  // has improved nothing.
  const mark = best ?? prev;
  const wrote = now.proposed > (mark.proposed ?? 0) || now.blocked > (mark.blocked ?? 0);
  const queueShrank = now.verifyWaiting < (mark.verifyWaiting ?? Infinity);
  return !wrote && !queueShrank;
}

/** The previous round's progress block, or null on the first round. */
export function lastProgress(handoverPath) {
  try {
    if (!existsSync(handoverPath)) return null;
    const doc = JSON.parse(readFileSync(handoverPath, "utf8"));
    const p = doc?.handover?.progress;
    if (!p || typeof p !== "object") return null;
    return {
      ...progressOf(p),
      stalledRounds: Number(p.stalledRounds) || 0,
      failedRounds: Number(p.failedRounds) || 0,
      // Absent on an index written before high-water marks existed; the round
      // then judges against itself, which is the old behaviour and not worse.
      best: p.best && typeof p.best === "object" ? progressOf(p.best) : null,
    };
  } catch {
    return null;
  }
}

/** How many consecutive stalled rounds this one makes, and whether that closes the phase. */
export const STALL_LIMIT = 2;

/* ------------------------------------------------------------------------ *
 * A ROUND THAT BROUGHT NOTHING BACK IS A FAILED ROUND, NOT A TAIL.
 *
 * The stall rule above was written for the tail: round 1 answers most of the
 * list, and later rounds that move nothing are the hard remainder. It cannot
 * tell that apart from a round whose agent turn never delivered, and run
 * 20260925T085519Z (qode-itl-be) is the case. Round 2 handed out 95 packets,
 * 0 of 95 finished in a 1244 s turn, in the middle of the gateway's 429
 * storm; `stalledRounds=2` closed the phase, and the walk ended the run with
 * about 5 hours of budget left and 0 characterization rows.
 *
 * So a round that handed packets out and got NOTHING back — no packet
 * finished, no side closed — is counted apart and retried. It does not count
 * toward STALL_LIMIT, because nothing about the list was learned from it.
 * FAILED_ROUND_LIMIT consecutive failed rounds still close the phase, so a
 * repo no turn can answer does not spin until the run cap.
 *
 * A FAILED ROUND THE GATEWAY ENDED is not counted toward that limit either.
 * Every turn of that run ended on one `API Error: Request rejected (429)`
 * before it launched a worker. The pack says so in GATEWAY_TURN_ENV, backs off
 * between rounds, and ends the run on infrastructure when its patience (a
 * share of the time left) is spent. Counting those rounds here as well would
 * close stage 3 after minutes of an outage that lasted over an hour.
 * ------------------------------------------------------------------------ */
export const FAILED_ROUND_LIMIT = 3;

/** Set by docker/char/packs/nodejs.py to "1" when the turn before this walk hit a gateway error. */
export const GATEWAY_TURN_ENV = "CHARPILOT_LAST_TURN_GATEWAY";

/** How many consecutive failed rounds this one makes. A gateway round neither grows nor resets the count. */
export function failedRoundsAfter(prevCount, failed, gatewayTurn) {
  if (!failed) return 0;
  return gatewayTurn ? prevCount : prevCount + 1;
}

/** Did the last round hand packets out and get nothing back? */
export function failedRound(completion) {
  return Boolean(completion?.handedOut) && completion.finished === 0 && completion.sidesClosed === 0;
}

export function verifyOnWrite(repo, paths, opts = {}) {
  const decision = opts.decision ?? mode();
  // SAID FIRST and said whatever happens next, because a round that recorded
  // anything has to state whether what it recorded reached staging and was
  // charged for. Run 20260916T031317Z had to infer its mode.
  const inEffect = decision.live
    ? `live — each recorded row is a real billed request (${decision.why})`
    : `mocked — every boundary is answered by a double (${decision.why})`;

  const contradictions = [];
  /** Every attempt this round made, classified. The caller routes on these. */
  const results = [];
  const waiting = toVerify(paths, opts.batchArtifact ?? recordedArtifact());
  const metrics = { verifyRecorded: 0, verifyContradicted: 0, verifyWaiting: waiting.length };
  const off = (why) => ({ did: [`verify-on-write: did not run — ${why}. mode: ${inEffect}`], contradictions, results, metrics });

  if (!waiting.length) {
    return { did: [`verify-on-write: nothing newly written to record. mode: ${inEffect}`], contradictions, results, metrics };
  }
  if (decision.live) {
    return off(
      `${waiting.length} newly written proposal(s) are left to the record step's batch recording, because in live mode ` +
        `each row is a real billed request and a step that bills per proposal is strictly worse than the batch it anticipates`
    );
  }
  const script = paths.tool("record.mjs");
  if (!existsSync(script)) {
    return off(`${relative(REPO_ROOT, script) || script} is not installed, so nothing here can record one proposal`);
  }
  const limit = verifyLimit(opts);
  if (limit === 0) return off(`${VERIFY_ENV} is 0, so every proposal is left to the record step`);

  // WHICH ONES, and not the first `limit` of them. See the block above
  // `verifyPattern`: four rows of one function test one premise, and the cap is
  // the expensive thing to raise. `seen` is every pattern an earlier round
  // already bought an observation for — the landed proposals `toVerify` did NOT
  // hand back are exactly those the batch or a previous verify accounts for.
  const waitingIds = new Set(waiting.map((p) => p.id));
  const seen = new Set(
    landedProposals(paths.proposalsDir)
      .filter((p) => !waitingIds.has(p.id))
      .map(verifyPattern)
  );
  const { take, patterns, covered, unseen } = selectToVerify(waiting, limit, { seen });
  metrics.verifyPatterns = patterns;
  metrics.verifyPatternsCovered = covered;
  metrics.verifyPatternsUnobserved = unseen;
  const did = [
    `verify-on-write: recording ${take.length} of ${waiting.length} newly written proposal(s) one at a time` +
      (waiting.length > take.length
        ? `, ${waiting.length - take.length} left to the record step's batch (a round is capped at ${limit}, ${VERIFY_ENV})`
        : "") +
      `. mode: ${inEffect}`,
    `verify-on-write: chose them across ${covered} of the ${patterns} distinct pattern(s) among those ${waiting.length}, ` +
      `one row per pattern before any pattern gets a second — a pattern is one owner, one \`via\` and one declared ` +
      `boundary block, which is what decides \`invalid\`, \`cannot-invoke\` and \`mock-not-applied\`. ` +
      `${unseen} pattern(s) here have no observation behind them yet and were taken first. ` +
      `Near-identical rows teach one thing however many are recorded, which is why the cap is four and why WHICH ` +
      `four is the decision. Raising it has no measured cost behind it: on run 20260916T095353Z the round that ` +
      `recorded four was the FASTEST of the three (11.5 min, against 43.8 with one recording and 28.2 with none)`,
  ];

  /** A degrade: the convenience did not happen and the batch still covers it. */
  const notRun = (p, why) => {
    results.push({ proposal: p, artifact: p.artifact, outcome: OUTCOMES.NOT_RUN, rule: null, why, armsMoved: [], invoked: null });
  };

  for (const p of take) {
    const res = paths.exec(script, verifyArgv(p.id), { cwd: repo, env: verifyEnv(p.artifact, opts.env ?? process.env) });
    // A DEGRADE, not a failure. The recorder's own bytes are quoted rather than
    // summarised, and the sentence says what still covers this proposal, so a
    // reader is not left deciding whether the round is compromised.
    if (res.status !== 0) {
      did.push(
        `verify-on-write: ${toolFailure(`${p.id} was not recorded on its own`, script, res)}` +
          `\n      left to the record step's batch recording — this is a convenience that did not happen, not a round that failed`
      );
      notRun(p, toolFailure(`${p.id} was not recorded on its own`, script, res));
      continue;
    }
    if (!existsSync(p.artifact)) {
      did.push(
        `verify-on-write: record.mjs exited 0 and wrote no ${here(p.artifact)} for ${p.id} — left to the record step's batch recording`
      );
      notRun(p, `record.mjs exited 0 and wrote no ${here(p.artifact)}`);
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(readFileSync(p.artifact, "utf8"));
    } catch (err) {
      did.push(`verify-on-write: ${here(p.artifact)} is not JSON — ${err.message}; ${p.id} is left to the record step's batch recording`);
      notRun(p, `${here(p.artifact)} is not JSON — ${err.message}`);
      continue;
    }
    const { outcome, rule, why, verdict: v } = outcomeFor(doc, p.id);
    const result = {
      proposal: p,
      artifact: p.artifact,
      outcome,
      rule,
      why,
      armsMoved: v.armsMoved,
      invoked: v.row ? v.row.invoked === true : null,
      claims: { verified: v.verified.length, wrong: v.wrong.length, unmeasurable: v.unmeasurable.length },
    };
    results.push(result);

    if (!v.row) {
      // A RECORDER SKIP IS AN ITEM, not a log line. Run `20260916T112101Z`
      // printed `anonymous-single-18-if-0-then produced no row — skipped: the
      // driver returns a closure taking 3 argument(s)` ten times across three
      // rounds and the side was re-asked as `kind: input` every time, because
      // the sentence went to `did` and nothing went back to the caller. The
      // sentence still goes to `did` — it is the recorder's own bytes and they
      // reach the top verbatim — and now it also names an outcome the caller
      // can route on, and the round carries the item.
      did.push(
        `verify-on-write: ${p.id} produced no row — ` +
          (v.skipped ? `skipped: ${v.skipped.reason}` : `it is in neither \`rows\` nor \`skipped\` of ${here(p.artifact)}`) +
          `\n      outcome: ${outcome ?? "undecided — no rule in SKIP_REASONS matches this sentence, so it is reported and nothing is rerouted on it"}`
      );
      continue;
    }
    metrics.verifyRecorded += 1;
    did.push(
      `verify-on-write: recorded ${p.id} on its own -> ${here(p.artifact)} — ` +
        `${v.verified.length} claim(s) verified, ${v.wrong.length} FALSE, ${v.unmeasurable.length} unmeasurable` +
        `\n      outcome: ${outcome ?? `undecided — ${why}`}`
    );
    for (const claim of v.wrong) {
      contradictions.push({ proposal: p, artifact: p.artifact, claim, armsMoved: v.armsMoved, invoked: v.row.invoked === true });
      metrics.verifyContradicted += 1;
    }
  }
  metrics.verifyWaiting = waiting.length - metrics.verifyRecorded;
  // ONE COUNT PER OUTCOME, so a run's own log says how the round went without a
  // reader tallying `did` lines. `undecided` is counted too: a classification
  // that silently dropped what it could not name would hide exactly the case
  // the table is most likely to be wrong about.
  metrics.verifyOutcomes = Object.fromEntries(
    [...OUTCOME_VOCABULARY, "undecided"].map((name) => [name, results.filter((r) => (r.outcome ?? "undecided") === name).length])
  );
  return { did, contradictions, results, metrics };
}

/**
 * One contradicted claim, as the item that goes back to the answering turn.
 *
 * It NAMES THE ARM THE RUN ACTUALLY HIT. "this claim is false" sends the agent
 * back to the recorder to find out what happened; "it took
 * src/x.ts#30:cond-expr:0 [whenTrue]" is the diagnosis, and it is a value
 * record.mjs already computed from istanbul's counters.
 *
 * The evidence is the same brief a derived side gets — condition, entry recipe,
 * parameters, boundaries, the document to fill — because the repair is the same
 * work as the derivation and an item that carries less is the search request
 * this step exists to remove. Addresses only from the recording: arm ids, files
 * and lines, never a recorded value, because a brief that pastes a value has
 * made the derivation.
 */
export function contradictionItem(c, { byArm, skeleton, handoff, schema, vocabulary, scan }) {
  const item = byArm.get(c.claim.armId) ?? null;
  const hit = c.armsMoved.map((a) => `${a.armId} [${(a.sides ?? []).join(", ")}] at ${a.file}:${a.line}`);
  const took = hit.length
    ? `it took ${hit.join("; ")}`
    : `it took no instrumented arm at all${c.claim.why ? ` — ${c.claim.why}` : ""}`;
  return {
    id: `${c.proposal.id}: ${c.claim.armId} [${c.claim.side}]`,
    kind: "recorded",
    question:
      `${c.proposal.id} claims ${c.claim.armId} side "${c.claim.side}" and the recorded run did not take it: ${took}. ` +
      `Repair the input so it takes the side it claims, or the claim so it names the arm it reaches.`,
    file: item?.file ?? c.armsMoved[0]?.file,
    line: item?.line ?? c.armsMoved[0]?.line,
    context: {
      ...(item ? contextFor({ item, side: c.claim.side, skeleton, handoff, schema, vocabulary, scan }) : {}),
      recorded: {
        proposal: c.proposal.id,
        proposalFile: c.proposal.file,
        artifact: here(c.artifact),
        // THE SAME ROUTING KEY every other recorder outcome carries. A caller
        // that has to tell a contradiction from a skip by the shape of the
        // object it was handed is a caller that cannot route on the vocabulary.
        outcome: OUTCOMES.TARGET_MISSED,
        route: OUTCOME_ROUTES[OUTCOMES.TARGET_MISSED],
        claimed: { armId: c.claim.armId, side: c.claim.side },
        why: c.claim.why ?? null,
        invoked: c.invoked,
        armsMoved: c.armsMoved,
      },
    },
  };
}

/**
 * The first side a proposal claims that this work list still knows about.
 *
 * A recorder outcome is about a PROPOSAL and a brief is about a SIDE, so one
 * has to be chosen to hang the evidence on. The first claimed side that is
 * still an open row is the one the agent was working on when it wrote the
 * proposal; a proposal whose every claim has since been covered gets null and
 * the item carries the recorder's evidence without a brief, which is honest —
 * there is no side left to brief.
 */
export function firstClaimedSide(proposal, byArm, labelsByArm) {
  for (const [armId, sides] of Object.entries(proposal.reaches ?? {})) {
    const item = byArm.get(armId);
    if (!item) continue;
    for (const side of sidesOf(sides, labelsByArm?.get(armId) ?? new Set())) return { item, side };
  }
  return null;
}

/**
 * ONE RECORDER OUTCOME, as the item that goes back to the answering turn.
 *
 * `target-missed` is NOT built here — `contradictionItem` above builds it, one
 * item per contradicted claim, because that outcome has a second address (the
 * arm the run actually hit) that the others do not. This one covers the three
 * that today produce a `did` line and nothing else.
 *
 * WHAT MAKES IT ACTIONABLE rather than a label: it names the outcome, the route
 * for that outcome, the subject the recorder could not reach, and the
 * recorder's own sentence verbatim — plus the same full brief a derived side
 * gets, for the same reason `contradictionItem` carries one. An item that says
 * "this was skipped" sends the agent back to the recorder to find out what
 * happened; an item that says "the driver returns a closure taking 3
 * argument(s), so write the declaration" is the next move.
 */
/**
 * ONE UNDECLARED BOUNDARY IS ONE QUESTION, NOT SIXTEEN.
 *
 * `record.mjs` refuses a row whose boundary was never declared and says which
 * symbol: `blocked egress: prisma.apiKey - no boundary declared for it`. Every
 * such row becomes a MOCK_NOT_APPLIED result, every result became its own item,
 * and the agent was asked the SAME question once per row.
 *
 * MEASURED. Run 20260917T140215Z: 28 blocked-egress skips across three symbols
 * — prisma.apiKey 16, fetch 8, prisma.googleLocation 4. Sixteen items, one
 * missing declaration. Run 20260917T145735Z: 10 skips over prisma.country,
 * prisma.$queryRaw and prisma.cachedLocation. Run 20260917T070737Z — the only
 * run that reached 96.39% — had ZERO, which is the cleanest available evidence
 * that these skips are what the tail is made of.
 *
 * Each one gates `record` through `verifyActionable`, so sixteen rows blocked
 * by one symbol is sixteen reasons a round cannot close.
 *
 * `repair.mjs` already has these semantics and states them: "Answer it once and
 * all of them are answered; they are not asked separately." This is `derive`
 * using the same shape for the recorder's own outcomes.
 */
export function blockedSymbol(result) {
  const why = String(result?.why ?? "");
  const m = /blocked egress:\s*([\w.$]+)/.exec(why);
  return m ? m[1] : null;
}

/**
 * Collapse recorder outcomes that share one undeclared symbol.
 *
 * ONLY where the symbol is known AND the outcome is the one a declaration
 * fixes. An INVALID row is a field on that row, a CANNOT_INVOKE is that
 * function's entry — neither is shared, and grouping them would tell the agent
 * one fix closes rows it does not close.
 */
export function groupByBlockedSymbol(results = []) {
  const groups = new Map();
  const singles = [];
  for (const r of results) {
    const sym = r?.outcome === OUTCOMES.MOCK_NOT_APPLIED ? blockedSymbol(r) : null;
    if (!sym) { singles.push(r); continue; }
    if (!groups.has(sym)) groups.set(sym, []);
    groups.get(sym).push(r);
  }
  const led = [];
  for (const [symbol, members] of groups) {
    if (members.length < 2) { singles.push(members[0]); continue; }
    led.push({ symbol, lead: members[0], members });
  }
  return { led, singles };
}

export function recorderItem(r, { byArm, labelsByArm, skeleton, handoff, schema, vocabulary, scan }) {
  const target = firstClaimedSide(r.proposal, byArm, labelsByArm);
  const item = target?.item ?? null;
  const subject = r.proposal.via ?? item?.owner?.name ?? r.proposal.functionId ?? "the subject";
  const opener = {
    [OUTCOMES.CANNOT_INVOKE]: `the recorder could not call ${subject} at all`,
    [OUTCOMES.MOCK_NOT_APPLIED]: `the recorder reached ${subject} and its arrangement did not hold`,
    [OUTCOMES.INVALID]: `the recorder refused ${r.proposal.id} before attempting any call`,
  }[r.outcome] ?? `the recorder produced no usable observation for ${r.proposal.id}`;
  return {
    id: `${r.proposal.id}: ${r.outcome ?? "undecided"}`,
    kind: "recorded",
    question:
      `${r.outcome ?? "undecided"} — ${opener}: ${r.why}. ` +
      `${OUTCOME_ROUTES[r.outcome] ?? "report what the recorder said; nothing here knows which of the five outcomes it is"}.`,
    file: item?.file ?? null,
    line: item?.line ?? null,
    context: {
      ...(target ? contextFor({ item: target.item, side: target.side, skeleton, handoff, schema, vocabulary, scan }) : {}),
      recorded: {
        proposal: r.proposal.id,
        proposalFile: r.proposal.file,
        functionId: r.proposal.functionId ?? null,
        via: r.proposal.via ?? null,
        artifact: here(r.artifact),
        // THE ROUTING KEY. A caller reads this field, not the prose.
        outcome: r.outcome ?? null,
        route: OUTCOME_ROUTES[r.outcome] ?? null,
        // Which line of record.mjs classified it, so a reason that gets
        // reworded there is traceable from here rather than mysterious.
        rule: r.rule ?? null,
        // The recorder's own sentence. Never a paraphrase.
        why: r.why,
        invoked: r.invoked,
        armsMoved: r.armsMoved ?? [],
        claimed: target ? { armId: target.item.armId, side: target.side } : null,
      },
    },
  };
}

/**
 * THE PROBE — can the recorder call this function at all, asked of the
 * recorder and never of a model of it.
 *
 * MEASURED, run `20260916T112101Z`: ten sides got full derivation effort —
 * arguments, boundaries, reasoning — and the recorder then said it could not
 * call the function at all. The agent had also simulated the decorator by hand
 * and declared its scenario correct; the recorder's real invocation path was
 * different, so the simulation proved nothing and the ten sides came back as
 * `kind: input` for three rounds.
 *
 * SO THE VERDICT IS RECORD.MJS'S OWN BYTES. This reads the `skipped[]` entries
 * record.mjs has already written — in the batch artifact, and in the
 * per-proposal artifacts verify-on-write asked for — maps each id to the
 * function its proposal names, and keeps only the ones `SKIP_REASONS` calls
 * `cannot-invoke`. Nothing here re-derives reachability from the scan: a second
 * opinion about whether a function can be called is exactly the mistake the
 * agent made by hand, and it fails in the worst direction — a function the
 * recorder could actually drive, sent to `declaration` with a written reason
 * attached, is coverage lost silently.
 *
 * WHAT IT COSTS PER FUNCTION: no process at all. It is a read of artifacts that
 * exist, so a repo with 256 functions pays one `readdirSync` and one
 * `JSON.parse` per artifact already on disk, not one invocation attempt per
 * function. A probe pass that spawned something per function would be a tax on
 * every function to save work on a few, which is the way this drops off.
 *
 * WHAT IT CANNOT DO, said plainly rather than guessed at: a function the
 * recorder has never been given anything to classify gets NO verdict and is
 * left alone. Closing that gap needs a change to record.mjs — `--plan`
 * aggregates its reasons by text and drops the ids (record.mjs:2676-2692), and
 * PROPOSALS_DIR has no environment override (config.mjs:258), so there is no
 * way to ask it about a function that has no proposal yet without this step
 * writing one, and a step never writes.
 */
export function cannotInvoke(paths, { batchArtifact, proposals } = {}) {
  const byId = new Map((proposals ?? landedProposals(paths.proposalsDir)).map((p) => [p.id, p]));
  const verdicts = new Map();
  const read = (artifact) => {
    if (!artifact || !existsSync(artifact)) return;
    let doc;
    try {
      doc = JSON.parse(readFileSync(artifact, "utf8"));
    } catch {
      // An unreadable artifact is not a verdict. It leaves every function it
      // might have spoken about undecided, which is the safe direction.
      return;
    }
    for (const s of doc.skipped ?? []) {
      const p = byId.get(s?.id);
      // An id this round's proposals do not carry is a stale artifact's, or
      // another target's. It must not speak for a function here.
      if (!p?.functionId) continue;
      if (outcomeOfSkip(s.reason).outcome !== OUTCOMES.CANNOT_INVOKE) continue;
      if (!verdicts.has(p.functionId)) {
        verdicts.set(p.functionId, { functionId: p.functionId, proposal: p.id, via: p.via ?? null, why: s.reason, artifact: here(artifact) });
      }
    }
  };
  read(batchArtifact ?? recordedArtifact());
  if (existsSync(paths.outDir)) {
    for (const f of readdirSync(paths.outDir).filter((n) => n.startsWith("behaviour-verify-") && n.endsWith(".json"))) {
      read(join(paths.outDir, f));
    }
  }
  return verdicts;
}

/** The question a side gets once the RECORDER has said its function is uncallable. */
export function probeQuestion(item, side, verdict) {
  const fn = item.owner?.name ?? item.owner?.functionId ?? "the function";
  return (
    `${sideId(item.armId, side)}: the recorder could not call ${verdict.via ?? fn} — ${verdict.why} (its own words, from ` +
    `${verdict.artifact} for ${verdict.proposal}). No argument reaches this side, so do not derive one: write the reason ` +
    `this side cannot be reached. Quote the recorder's verdict in \`why\`; the \`proof\` is the SOURCE line that makes ` +
    `the function uncallable, never ${verdict.artifact} - a generated file is rewritten on every recording, and the ` +
    `ledger refuses a proof that cites one (D56).`
  );
}

/**
 * The reason this step cannot run yet, or null.
 *
 * Both checks are about ARTIFACTS, not about work: the walk has already run the
 * worklist step, so a missing out/worklist.json here is the inconsistency the
 * walk refuses on rather than a question anybody can answer, and a missing tool
 * means the toolset is not installed in the repo being walked.
 */
export function precondition(repo, opts = {}) {
  const paths = toolPaths(repo, opts);
  if (!existsSync(paths.worklistJson)) {
    return `${relative(REPO_ROOT, paths.worklistJson) || paths.worklistJson} does not exist — the worklist step reported itself satisfied without writing it`;
  }
  for (const name of ["worklist.mjs", "handoff.mjs", "validate.mjs"]) {
    if (!existsSync(paths.tool(name))) {
      return `${relative(REPO_ROOT, paths.tool(name)) || paths.tool(name)} is not there — the toolset is not installed in this repo, so the brief cannot be built`;
    }
  }
  return null;
}

/**
 * The steps whose handover ADDRESSES A SIDE, so a side named in one is a side
 * already in front of the answering turn.
 *
 * `derive` and `repair` are the only two steps in the walk that return a
 * `pending` item at all, and both address an open side as `sideId` spells it —
 * so the file this reads is always one of theirs. Named as a list rather than
 * assumed, because the assumption is what a fourteenth step would silently
 * break: a future step that handed over a side for a PERSON to rule on would,
 * unnamed here, read as a side this pipeline had already briefed.
 */
export const HANDS_OVER_SIDES = Object.freeze(["derive", "repair"]);

/**
 * Every side the last handover asked about, from the walk's own record of it.
 *
 * NOT A STATE FILE, and the distinction is the one repair.mjs already draws
 * about the same bytes: this file makes no claim about progress, about what is
 * covered or about which steps have run. It says which questions were handed
 * over, it is the walk's record of what the WALK did, and it is read here and
 * written nowhere.
 *
 * Absent, unparseable, or written by a step that does not address sides — all
 * three are "nothing was asked", which is the safe reading: it makes this step
 * ask rather than assume.
 */
export function handedOver(path) {
  // READ THROUGH THE INDEX. The walk writes a round as an index plus one brief
  // per packet, so `pending` is not a key of the file at `path` any more —
  // reading it there would find nothing and report "nothing was asked", which
  // is the safe reading of an ABSENT handover and a false reading of a present
  // one. `readHandoverDoc` reassembles the round and still understands a file
  // that is `{ step, pending }` on its own.
  const doc = readHandoverDoc(path);
  if (!HANDS_OVER_SIDES.includes(doc?.step)) return new Set();
  return new Set((doc.pending ?? []).map((p) => p?.id).filter(Boolean));
}

/**
 * Has this step nothing NEW to ask — is every side still open already in the
 * handover on disk?
 *
 * THE ZERO CASE IS THE ONE THAT MATTERS and it is stated on its own line. A
 * `derive` that handed over nothing while sides are open must never be
 * satisfied: "everything it can" means everything that REMAINS, never
 * everything it managed. Satisfied with an empty handover, this step would
 * declare stage 3 finished with every side underived, `record` would run over
 * an empty proposals directory, `emit` would render nothing and `report` would
 * quote a rate off an empty suite — a clean report over a false premise, which
 * is the failure this whole pipeline exists to refuse. (The `every` below
 * already returns false in that case; the line is kept because a reader of this
 * predicate must not have to derive the catastrophic case from a quantifier.)
 */
export function handedEverything(open, asked) {
  if (!open.length) return true;
  if (!asked.size) return false;
  return open.every(({ item, side }) => asked.has(sideId(item.armId, side)));
}

/**
 * Whether this step has handed over everything it can, asked of the filesystem
 * and of the tool that judges proposals. Never of a state file: a second
 * account of the run is the one that turns out to be wrong, which is why the
 * walk has none.
 *
 * IT IS NOT "EVERY SIDE IS CLOSED", and that is this predicate's whole point.
 * Run `20260916T112101Z` ran 145 minutes and produced no coverage number at
 * all: 136 of its 146 sides had valid proposals on disk and ten could not be
 * closed, so this step never became satisfied, and `record`, `emit` and
 * `measure` — which the walk reaches only after it — never ran once. The 136
 * ready inputs were never recorded, never emitted and never measured. The
 * baseline run `20260916T031317Z` recorded what it had, measured it and
 * repaired what missed, and that is where its 96.7% came from. `repair` exists
 * precisely to catch what `derive` could not, and `repair` is downstream of
 * `record` — so gating `record` on a complete `derive` makes `repair`
 * unreachable and turns ten unanswerable sides into a run with no number.
 *
 * So: a side that is still open and has NOT been handed over is work this step
 * has not done, and it says so. A side that is still open and HAS been handed
 * over is a question already in front of the answering turn — asking it a
 * second time produces the same brief and the same silence, while `repair`
 * reads the same side with the measurement behind it and can tell an input that
 * missed from a side nothing reaches.
 *
 * THREE conditions, because none is sufficient alone:
 *
 *   nothing new to ask   every open side is in the handover on disk, and an
 *                        empty handover with open sides is never that.
 *   validate.mjs exits 0 it judges the proposals that EXIST, so on its own it
 *                        would pass a repo with one good proposal and 400
 *                        untouched sides — and without it the open count alone
 *                        would pass a side "answered" by a proposal whose value
 *                        cites no source, which is exactly what validate
 *                        refuses.
 *   the work list reads  an unreadable one is not done; the worklist step owns
 *                        that failure.
 *
 * THE ROUND'S CAP IS STILL NOT READ HERE, and `openSides` is still asked for
 * the whole list. The cap bounds what one round HANDS OVER; a cap that leaked
 * in would let a repo with 945 open sides close stage 3 having briefed 20,
 * which nothing downstream would notice because a partially-briefed repo
 * validates exactly like a finished one. Reading the handover is the opposite
 * of reading the cap: it counts what was actually asked, round after round.
 *
 * AND IT NO LONGER GATES `record`, WHICH IS WHAT USED TO MAKE IT RUINOUS.
 *
 * Until 2026-09-19 the walk stopped at the first unsatisfied step, so this
 * predicate — false while a single open side is unbriefed — held `record`,
 * `determinism`, `emit`, `measure`, `repair`, `ruling` and `report` behind a
 * finished stage 3. Run `20260918T164503Z` (tracy-worker) answered 626 of 754
 * sides over nine rounds and $225.19 and not one of those seven steps ever
 * ran; its `result.json` said `coverage_percentage: null`. That run's
 * directory exists on no reachable checkout — these figures are plan 13's D45 table (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`), which is
 * where they can still be checked and the only place they can.
 *
 * The fix is in the WALK and not here: workflow.mjs now runs the banking steps
 * over what is already on disk before this step hands a round over, so a run
 * killed at any point has recorded and measured everything it had answered.
 * This predicate keeps its old meaning, which is the only correct one for the
 * question it answers — "has stage 3 nothing left to brief" — and a reader
 * tempted to make it true on a BATCH instead should know what that costs: the
 * sides of a finished batch are closed for good, so nothing would ever make it
 * false again, the walk would run to the end of ORDER and exit 0, and
 * docker/char/packs/nodejs.py reads exit 0 as a finished run. A repo would be
 * reported as characterized having briefed twenty of its 754 sides.
 */
export function satisfied(repo, opts = {}) {
  const paths = toolPaths(repo, opts);
  if (!existsSync(paths.worklistJson)) return false;

  let worklist;
  try {
    worklist = JSON.parse(readFileSync(paths.worklistJson, "utf8"));
  } catch {
    // Unreadable is not done. The worklist step owns that failure.
    return false;
  }
  const labelsByArm = labelIndex(worklist);
  // THE JUDGEMENT FIRST, because it decides what counts as proposed. A row
  // validate.mjs refused is quarantined and stops answering its side, so the
  // open list below already holds that side — which is what makes it safe for
  // this predicate to stop demanding a clean directory.
  // BOTH QUARANTINES, for the reason the comment above gives and one more: a
  // row the last measurement could not measure is not an answer either (D51),
  // so its side is in the open list below and this predicate must hold the
  // round until that side is in front of somebody. Reading only validate's
  // half here would close stage 3 over a claim stage 6 is about to refuse for
  // the third time — which is rounds 3 and 5 of run 20260919T104903Z.
  const judgement = judgeProposals(repo, paths);
  const proposed = proposedSides(paths.proposalsDir, labelsByArm, allHeld(judgement));
  const declared = declaredSides(paths.proposalsDir, labelsByArm);
  const asked = handedOver(paths.handover);

  // AN ANSWER ON DISK THAT NOTHING HAS MATERIALISED IS WORK THIS STEP HAS NOT
  // DONE, and it is asked first because it CHANGES the open list: a declaration
  // materialised this round closes its side, and a step that computed the open
  // list before materialising would brief a side it was about to close.
  //
  // It is read with the same asymmetry an open side gets. A submission not yet
  // in the handover is work this step has not done. One already handed over —
  // because a tool refused it, or because it is malformed — is a question in
  // front of the answering turn, not a reason to hold the run: `repair` is
  // downstream of `record`, so a derive that never becomes satisfied makes it
  // unreachable, which is how run 20260916T112101Z produced no coverage number
  // at all. The id carries a fingerprint of the entry, so a submission the
  // agent has since REPAIRED does not read as the one that was refused.
  //
  // D75 — AND THIS IS THE CLAUSE THAT COULD NOT BE SATISFIED. It is asked of
  // `inspectSubmissions`, which read every `{ "notes": … }` file in the answers
  // directory as still-to-do on every round for ever: a note that materialised
  // cleanly is never in the handover, so `ready.every(asked.has)` was false
  // from the first note that landed until the end of the run. Run
  // `20260920T030124Z` closed its last side at round 6 with `open=0`,
  // `heldBack=0` and `quarantinedRows=0`, and failed at round 10 on 26 of them.
  // THE PREDICATE WAS RIGHT AND THE RESIDUE WAS UPSTREAM: `notes.mjs` now
  // leaves a receipt for a document it has consumed and `inspectSubmissions`
  // skips it, so `ready` means the same thing for all three formats. Nothing
  // here changed, and nothing here should: an unmaterialised answer of any kind
  // still holds the run until it is in front of somebody.
  const submissions = inspectSubmissions(paths, { labelsByArm, declared, proposed });
  if (!submissions.ready.every((r) => asked.has(r.id))) return false;
  if (!submissions.problems.every((p) => asked.has(p.id))) return false;

  // D64, AND THE SAME MAP `run` BUILDS. A side the recorder refused is not in
  // the open list, so this predicate must not demand it be in front of
  // anybody: asking for a handover of a question nobody can answer is the
  // round-after-round loop the whole item removes.
  const { open } = openSides(worklist, {
    proposed,
    // D56: a refused declaration answers nothing, so its side is open here
    // too. The submissions above still read the whole map: a refused entry
    // re-submitted unchanged is consumed there, not written back.
    declared: withoutRefused(declared, refusedDeclarations(paths.proposalsDir, labelsByArm)),
    undeliverable: undeliverableIndex(paths.coverageJson),
    covered: measuredCoveredIndex(paths.coverageJson, paths.behaviourJson),
  });
  if (!handedEverything(open, asked)) return false;

  // A DUPLICATED ID THE RULE COULD NOT DECIDE is put in front of the agent
  // once before this step closes over it, whether or not its side is open:
  // every copy is set aside, and when another row covers the side nothing else
  // would ever ask. Once asked it does not hold the run, the same asymmetry a
  // refused submission gets above.
  if (!duplicateIdProblems(judgement, paths).every((p) => asked.has(p.id))) return false;

  if (!existsSync(paths.tool("validate.mjs"))) return false;
  if (!judgement.ran) return false;
  if (judgement.status === 0) return true;

  // A REFUSAL THIS STEP HAS ACTED ON DOES NOT HOLD THE RUN, and a refusal it
  // could not act on still does.
  //
  // This condition used to be `validate.mjs exits 0`, full stop, and the reason
  // given for it was sound: without it, a side "answered" by a proposal whose
  // value cites no source would close stage 3, which is exactly what
  // validate.mjs refuses. That reason is now carried by a narrower mechanism —
  // the refused rows are quarantined, `proposedSides` above does not count
  // them, and their sides are in `open`, so `handedEverything` has already
  // refused this round if they are not in front of the answering turn.
  //
  // What the old condition ALSO did was fail a run over the other 145 sides.
  // Run `20260916T165524Z` reached 146 of 146 accounted at minute 102 and then
  // never closed stage 3, so `record`, `emit`, `measure` and `repair` never ran
  // once. `validate.mjs` judges the directory, not the row, so one bad row cost
  // the whole run — and each resubmission was a fresh chance to write another.
  //
  // A fault this step could not place is the case where nothing has been set
  // aside, nothing has moved, and closing would be closing over an unread
  // refusal. Those still hold, exactly as before.
  return judgement.faults.length > 0 && judgement.unplaced.length === 0;
}

/**
 * Every label an arm has, so a comma inside one cannot be split on. D59: the
 * ledger's `armSideLabels`, the one definition coverage.mjs and the ledger read
 * too, so "has a written reason" here means what `ruled` means there.
 */
function labelIndex(worklist) {
  return armSideLabels({ worklist });
}

/**
 * Enumerate what is left to decide, and hand it over.
 *
 * The tools are run ONCE for the whole round and the result is indexed by side,
 * rather than once per item: the skeleton of a 256-function repo is one process
 * and 945 rows, and per-item invocation would be 945 full worklist builds.
 */
export function run(repo, opts = {}) {
  const paths = toolPaths(repo, opts);
  const worklist = JSON.parse(readFileSync(paths.worklistJson, "utf8"));
  const labelsByArm = labelIndex(worklist);
  // THE DRIVER SIGNATURES, from the file validate.mjs builds its own index
  // from. Read once for the round, never per item: it is the stage-2 artifact
  // and it is hundreds of kilobytes.
  //
  // READ HERE RATHER THAN BESIDE THE BRIEFS because D63 needs it BEFORE the
  // round is sized: which function a side is addressed to decides which sides
  // group together, and that decides the batch, the weights and the packets.
  const scan = readScan(paths.scanJson);
  /* ------------------------------------------------------------------------
   * D63 — WHERE EACH SIDE'S WORK IS ADDRESSED, decided once, before anything
   * groups. A side inside an anonymous callback is filed under the nearest
   * enclosing function a worker can call; everything else is untouched. See
   * the block above `CALL_ARGUMENT_NAME`.
   * ---------------------------------------------------------------------- */
  const addressing = attachUnits(worklist.items ?? [], scan);

  // FIRST, AND BEFORE THE OPEN LIST IS READ. What the last round submitted is
  // an answer, and an answer materialised now is a side this round must not ask
  // about again — three rounds over the same ten sides is exactly what run
  // 20260916T112101Z did while the answers sat on disk in a form ledger.mjs
  // could not read.
  // WHAT THE LAST ROUND SAID, read once, off its own index. Two things come out
  // of it: which answer-file names it reserved and what each of them carried
  // (so a second write to one name is detectable rather than silent), and what
  // earlier workers learned about each function (so a packet does not meet its
  // function cold). It is READ and never written: it is the walk's record of
  // what the walk did.
  const lastHeaders = headersInHandover(paths.handover);
  const reserved = new Map(
    lastHeaders.filter((h) => h?.answers?.file).map((h) => [h.answers.file, { bundleId: h.id, sides: h.sides ?? [] }])
  );
  const lastSeen = new Map(
    lastHeaders
      .filter((h) => h?.answers?.file && h.answers.lastSeen)
      .map((h) => [h.answers.file, h.answers.lastSeen])
  );
  const carriedNotes = notesInHandover(paths.handover);
  // WHAT THE LAST ROUND ASKED ABOUT, read once and used twice. `materialise`
  // wants it so a quarantine the answering turn has already been told about is
  // not told again; `dynamicBatch` wants it because a side that was DEALT and
  // is still open is the only free signal anybody has for how hard a side is —
  // location-ms's rounds 2 and 3 are made entirely of that population, and they
  // closed 3 sides and about 6 for 1,004s and 1,300s.
  const askedLastRound = handedOver(paths.handover);

  // THE ROUND NUMBER THIS STEP IS MATERIALISING IN, taken from the one log
  // that already stamps round numbers on this run's own rows.
  //
  // `recordPackets` (below, at the end of this same step) writes its rows with
  // `(roundsIn() ?? 0) + 1`, so this is not a number invented here: it is the
  // number that will be printed against this round's packets in the run's own
  // packet log, and a note stamped with it can be looked up against them.
  // `notes.mjs` refuses to invent one, and says so — a tool writing provenance
  // nobody can check is worse than a fact with no round.
  //
  // THE HONEST LIMIT. `recordPackets` runs only when the round HANDED OUT
  // packets, so a round that dealt nothing writes no row and the round after
  // it computes the same number. That makes this a monotonic non-decreasing
  // round stamp rather than a strict ordinal, which is exactly what it is worth
  // as a DEFAULT: a fact carrying its own `round` keeps it
  // (`materialiseNoteSubmission`), and this is only the fallback for one that
  // does not.
  const materialisingRound = (roundsIn() ?? 0) + 1;

  const submissions = materialise(repo, paths, {
    labelsByArm,
    declared: declaredSides(paths.proposalsDir, labelsByArm),
    proposed: proposedSides(paths.proposalsDir, labelsByArm),
    // What was in front of the answering turn last round, so a quarantine it
    // has already been told about is not told again. The sides are the question
    // from here on.
    asked: askedLastRound,
    reserved,
    lastSeen,
    // WITHOUT THIS, `notesArgv` NEVER PASSES `--round` AND `notes.mjs` REFUSES
    // EVERY FACT THAT DOES NOT CARRY ONE OF ITS OWN. 15 facts in run
    // `20260919T092410Z`.
    round: materialisingRound,
  });

  // AFTER materialising, and WITH the quarantine. A row validate.mjs refused
  // does not answer its side, so the side is open and this round asks it —
  // which is the move that makes the run advance while the bad row is fixed,
  // or instead of it.
  // BOTH QUARANTINES. `allHeld` merges the rows validate.mjs refused with the
  // rows the last measurement could not measure (D51): the two are set aside
  // by different tools for different reasons, and for this one question — does
  // this row still answer its side — they are the same thing.
  const held = allHeld(submissions.judgement);
  // PLAN 20 T2.3, OBSERVATION ONLY: what each held row tried and what came
  // back, fingerprinted, so a per-side stopping rule can be replayed on real
  // inputs before it is built. Nothing reads this to decide anything.
  recordAttempts(paths.outDir, attemptLines(held, paths.proposalsDir, { round: materialisingRound }));
  // PLAN 20 T2.3, THE POLICY, ON BY DEFAULT since the nginx A/B (run 20260924T091852Z); CHARPILOT_SALVAGE_OPEN=off is the
  // rollback. A row held in 3 consecutive rounds with the SAME
  // input and the SAME outcome stops being dealt; its sides are ruled `open` by
  // coverage.mjs from out/salvaged.json. Read here, in `run`, and never in
  // `satisfied` -- see attempts.mjs.
  const runEnv = opts.env ?? process.env;
  const salvaged = salvageOn(runEnv)
    ? salvagedRows(readAttempts(paths.outDir), { round: materialisingRound, after: salvageAfter(runEnv) })
    : [];
  const salvageIndex = new Map();
  for (const s of salvaged) {
    for (const pair of s.sides) {
      const m = /^(.*) \[(.*)\]$/.exec(pair);
      if (m) salvageIndex.set(sideKey(m[1], m[2]), s);
    }
  }
  // PLAN 20 T2.1, behind CHARPILOT_CARRY_CUTOFF=on: the packets a worker was
  // cut off holding last round. Carried ones get more time and go first and
  // alone (header + queue below); one cut off CARRY_LIMIT rounds running is a
  // visible exception, ruled open through the same map as a salvaged side.
  const carried = carryOn(runEnv)
    ? carriedPackets(paths.outDir, {
        baseMin: workerDeadlineMin(runEnv),
        roundWallMin: Number(runEnv.CHARACTERIZE_ROUND_WALL_MINUTES) > 0 ? Number(runEnv.CHARACTERIZE_ROUND_WALL_MINUTES) : 90,
      })
    : new Map();
  for (const [, c] of carried) {
    if (!c.limitReached) continue;
    for (const pair of c.sides) {
      const m = /^(\S+#\S+) \[(.*)\]$/.exec(pair);
      if (m && !salvageIndex.has(sideKey(m[1], m[2]))) {
        salvageIndex.set(sideKey(m[1], m[2]), {
          row: null, sides: [pair], attempts: c.times, by: "carry.mjs",
          outcome: `cut off ${c.times} rounds running at ${c.deadlineMinutes} min`,
        });
      }
    }
  }
  const proposed = proposedSides(paths.proposalsDir, labelsByArm, held);
  // D56: the entries the ledger refused. Their sides are open, and dealt with
  // the refusal leading the question (withRefusedDeclaration below).
  const refusals = refusedDeclarations(paths.proposalsDir, labelsByArm);
  const declared = withoutRefused(declaredSides(paths.proposalsDir, labelsByArm), refusals);
  // D64 — READ OUT OF THE LAST MEASUREMENT'S JOIN, never stored. A side whose
  // function the recorder refused to exercise is not dealt; it stays uncovered
  // in the denominator and `coverage.mjs` carries the recorder's own reason on
  // its row. See the D64 block above `undeliverableIndex`.
  const undeliverable = undeliverableIndex(paths.coverageJson);
  const { open, proposedCount, declaredCount, notInstrumented, undeliverableSides: notDealt, coveredCount } = openSides(worklist, {
    proposed,
    declared,
    // T2.3: a salvaged side is kept out of the deal the same way a side the
    // recorder refused is, and told apart from it right below.
    undeliverable: salvageIndex.size ? new Map([...undeliverable, ...salvageIndex]) : undeliverable,
    // D46: the same index `satisfied` reads, so the two never disagree.
    covered: measuredCoveredIndex(paths.coverageJson, paths.behaviourJson),
  });
  const salvagedSides = notDealt.filter((x) => salvageIndex.has(sideKey(x.item.armId, x.side)));
  const undeliverableSides = notDealt.filter((x) => !salvageIndex.has(sideKey(x.item.armId, x.side)));
  if (salvageOn(runEnv)) {
    writeSalvaged(paths.outDir, {
      round: materialisingRound,
      sides: salvagedSides.map((x) => {
        const s = salvageIndex.get(sideKey(x.item.armId, x.side));
        return { armId: x.item.armId, side: x.side, row: s.row, attempts: s.attempts, outcome: s.outcome, by: s.by };
      }),
    });
  }
  // D52 — THE SIDES A QUARANTINE FREED, NAMED BEFORE THE ROUND IS SIZED, so
  // this round can deal them rather than free them in principle.
  const freed = freedSides(held, labelsByArm, open);
  // Before anything is built: a cap that cannot be read is refused here, where
  // the walk turns it into one sentence, rather than after three tools have
  // been spawned to fill a round whose size is unknown.
  // PINNED WINS, UNSET CHOOSES. `batchSize` refuses a malformed value here,
  // where the walk turns it into one sentence, rather than after three tools
  // have been spawned to fill a round whose size is unknown. When nothing is
  // pinned it used to mean 20 for every repo on the fleet; now it means "size
  // this round to this repo", floored at the batch the proven run used.
  // UNSET MEANS AUTO, and that is the whole point of it.
  //
  // A default of 20 is a throttle nobody can see: run 20260918T043026Z spent
  // 130 minutes retiring 101 sides on qode-ptp-ms because nothing said the
  // round was sized for a service a hundredth of it. An operator who has to
  // know to set a variable before the tool goes at a usable speed will one day
  // not know, and will ask why it is slow. So the run sizes itself and SAYS so,
  // and pinning stays available for a smoke run or a bisect.
  const asked = opts.batch !== undefined ? String(opts.batch) : String(process.env[BATCH_ENV] ?? "").trim();
  const auto = asked === "" || asked.toLowerCase() === "auto";
  const pinned = !auto;
  // WEIGHED, not counted. `root` is this repo, so the source bytes of each
  // packet's own file are a `stat` rather than a guess; `dealtBefore` is what
  // the last round asked about, so a side coming back for a second time weighs
  // what the tail of location-ms showed it costs. A file that cannot be stat'd
  // weighs exactly one packet, which is what this returned before either weight
  // existed.
  const sized = auto ? dynamicBatch(open, { root: repo, dealtBefore: askedLastRound }) : batchSize(opts);
  /* ------------------------------------------------------------------------
   * D53 — WHAT THE LAST ROUND DEALT, AND WHEN IT DEALT NOTHING, WHY.
   *
   * ASKED HERE, ABOVE THE BATCH, because the answer changes the batch. The
   * join itself is `packetCompletion` and is unchanged; what is new is that a
   * handedOut of zero now carries a REASON, read off the handover the last
   * round wrote — see `dealtNothing`.
   * ---------------------------------------------------------------------- */
  const completion = packetCompletion(lastHeaders, answeredSideIds({ proposed, declared }), handoverStep(paths.handover));
  /* ------------------------------------------------------------------------
   * D53(b) — RE-DEAL AFTER AN UPSTREAM DEATH.
   *
   * A walk that died in `measure` never reached this step, so nobody was asked
   * about a single open side that round: `handedOver` returns an empty set,
   * `askedLastRound` is empty, and every side still open is one nobody has
   * been put in front of. The round after it should therefore deal THE OPEN
   * LIST rather than a slice sized as though the last round had been doing the
   * work.
   *
   * D66 — AND THAT IS NOW WHAT EVERY ROUND DOES, so the clause that raised the
   * batch is GONE and only the reporting is left. It existed to escape the old
   * `want = ceil(open / CHARPILOT_NODE_MAX_ROUNDS)` term, which could size a
   * round at four sides on a repo with forty open and no reason but arithmetic;
   * the re-deal raised that to the 40-packet ceiling. With `want` removed, an
   * auto round is already `packetsPerRound()` packets — what this machine can
   * finish — and raising it to the same number is a no-op with a name. Raising
   * it ABOVE that would be dealing a round the round cannot finish, which is
   * the defect the budget exists to stop.
   *
   * WHAT IS KEPT, and it is the half that was always load-bearing: the round
   * SAYS the last one died upstream, and `redealtAfterUpstreamDeath` counts the
   * sides nobody was asked about. Run `20260919T104903Z`'s rounds 4, 6 and 8
   * each opened with `packetsHandedOutLastRound=0` and nothing in the log told
   * the three cases apart.
   * ---------------------------------------------------------------------- */
  // PINNED IS STILL PINNED: an operator who set CHARPILOT_DERIVE_BATCH asked
  // for a round of that size, and `redeal` stays false so the metric does not
  // claim a re-deal the operator did not get.
  const redeal = auto && completion.dealtNothing?.reason === UPSTREAM_DEATH && open.length > 0;
  const batch = sized;
  // D52 — THE SIDES THE QUARANTINE FREED GO FIRST. `nextBatch` fills the round
  // a whole function at a time, front to back over the open list, so which
  // sides are at the front decides which are dealt. A side freed this round by
  // a row being set aside is a side NOBODY is working on and nobody has a
  // pending answer for, so it is the first thing this round should ask about —
  // rather than the last, behind sides that already have an answer in flight.
  const round = nextBatch(freedFirst(open, freed.keys), batch);
  const heldBack = open.length - round.length;
  // WHICH OF THE FREED SIDES THIS ROUND ACTUALLY DEALT. Recorded whether it is
  // all of them or none: "quarantine freed 6 sides and this round dealt 6" and
  // "freed 6 and dealt 0" are the difference between a recovery and a
  // standstill, and run 20260919T104903Z's rounds 6 and 8 are the only reason
  // anybody knows which of the two that run was.
  const dealtIds = new Set(round.map(({ item, side }) => sideId(item.armId, side)));
  const freedDealt = [...freed.keys].filter((id) => dealtIds.has(id));
  const freedUndealt = [...freed.keys].filter((id) => !dealtIds.has(id));

  const { ask: askableProblems, held: cacheHeld } = cacheOnly(submissions.problems, open);
  const submitted = askableProblems.map(submissionItem);
  // THE ANSWER DIRECTORY, COUNTED. A round that read six files carrying 41
  // answers and a round that read six files carrying 3 are different rounds and
  // nothing else in the log tells them apart — which is what made a lost
  // submission unattributable.
  const census = submissions.census ?? new Map();
  const censusLine = census.size
    ? `submissions: read ${census.size} file(s) in ${here(paths.answersDir)} — ` +
      [...census.values()].map((c) => `${c.file} ${c.proposals + c.declarations}`).join(", ")
    : null;
  // PACKETS HANDED OUT AGAINST PACKETS ANSWERED. There is no per-packet
  // deadline and this round does not invent one: the only bound that exists is
  // the stage budget (out/stage3-clock.json), which every packet shares, so a
  // packet that runs long spends another packet's time. What CAN be recorded is
  // the shape of the over-run — how many of the packets handed out came back —
  // and an over-run recorded is worth more than a deadline nobody has measured.
  // Run 20260916T223906Z round 2 improvised a fan-out at minute 51 of 113 and
  // one worker became the long tail while finished work waited; nothing in that
  // run's log counts this.
  // JOINED ON SIDE IDS. See `packetCompletion` above for why it is not the file
  // name it used to be and not a packet id either: one submission answers
  // several packets, one packet yields rows in several files, and some of a
  // packet's sides are answered while others are declared dead. The only
  // one-to-one thing anywhere in that is the side.
  //
  // TAKEN ABOVE THE BATCH, because D53(b) sizes the round on its answer. It is
  // the same join over the same two inputs; only its position moved.
  const handedOutLast = completion.handedOut;
  const answeredThisRound = completion.finished;
  // THE OLD SIGNAL, KEPT AS ITS OWN FACT rather than as the completion metric.
  // "A submission landed under this packet's reserved name" is true of almost
  // no packet — workers name their own files — so it says nothing about whether
  // the work came back. It is still worth recording: a packet with every side
  // closed and no file under its reserved name is a worker that answered
  // everything under a name of its own, and a packet with neither is a packet
  // nothing was heard from at all.
  const filedUnderReserved = [...reserved.keys()].filter((name) => census.has(name)).length;
  const did = [
    ...submissions.did,
    ...(censusLine ? [censusLine] : []),
    // D75(b). SAID IN THE ROUND THAT HELD THEM, naming the files, because a
    // refusal that stops being asked has to be visible somewhere or this is a
    // silent reduction of the work — the same rule D64's line above follows.
    ...(cacheHeld.length
      ? [
          `submissions: ${cacheHeld.length} refused note submission(s) are NOT asked about this round — nothing is ` +
            `open, so no worker will read a source file again and a note cannot close a side or move the rate. What ` +
            `verified is published; notes.mjs holds the receipt with its own words for what did not. ` +
            cacheHeld.map((p) => p.file).join(", "),
        ]
      : []),
    // D64. SAID EVERY ROUND IT IS TRUE, and it is true of a round that deals
    // nothing else: a side nobody is asked about has to be visible somewhere,
    // or this is a silent reduction of the work list.
    ...(undeliverableSides.length ? [undeliverableSaid(undeliverableSides)] : []),
    // PLAN 20 T2.3: said every round it is true, with the repeated failure.
    ...(salvagedSides.length
      ? [
          `salvage: ${salvagedSides.length} side(s) are NOT dealt this round — each one's row was held in ` +
            `${salvageAfter(runEnv)} consecutive rounds with the same input and the same outcome, so another identical ` +
            `attempt buys nothing. They stay UNCOVERED and in the denominator and are ruled open with that failure: ` +
            [...new Set(salvagedSides.map((x) => salvageIndex.get(sideKey(x.item.armId, x.side)).outcome))]
              .slice(0, 3).map((o) => JSON.stringify(o)).join("; "),
        ]
      : []),
    ...(handedOutLast
      ? [
          `packets: ${answeredThisRound} of the ${handedOutLast} packet(s) handed over last round are FINISHED — ` +
            `every side each one holds now carries a proposal or a written reason; ` +
            `${handedOutLast - answeredThisRound} packet(s) are not, and between them still hold ` +
            `${completion.sidesDealt - completion.sidesClosed} of the ${completion.sidesDealt} side(s) dealt. ` +
            `${completion.sidesClosed} side(s) closed, and ${filedUnderReserved} packet(s) had a submission filed ` +
            `under their own reserved name. THE JOIN IS ON SIDE IDS and not on a file name: one submission ` +
            `answers several packets, one packet yields rows in several files, and a side declared dead is as ` +
            `answered as a side with an input — the name-matched version of this counted 0 of 33 on a round that ` +
            `closed 127 sides. There is no per-packet deadline — the only bound is the stage budget every packet ` +
            `shares — so this counts the over-run rather than bounding it` +
            (completion.empty
              ? `. ${completion.empty} more header(s) last round were not packets of sides at all — a refused ` +
                `submission or a recorder outcome, filed under a header of its own — and they are left out of both ` +
                `halves of this ratio rather than scored as packets that never finished`
              : ``),
        ]
      : completion.dealtNothing.reason === NO_ROUND_BEFORE
      ? // SILENT ON A COLD ROUND, where there is no round to report on and the
        // yield ratchet's own line already says the same thing. The reason is
        // still on `metrics` and still on the round row: what is dropped here
        // is a sentence about a round that does not exist, on the one round
        // where every line is the first thing anybody reads.
        []
      : [
          // D53(a) — THE LINE A DEALT-NOTHING ROUND OWES. `packetsHandedOutLastRound=0`
          // appeared four times on run 20260919T104903Z and said the same word
          // for three different states. It now says which one.
          `packets: the last round dealt no packet of sides — ${completion.dealtNothing.why}` +
            (completion.empty
              ? `. ${completion.empty} header(s) it wrote were not packets of sides — a refused submission, a ` +
                `recorder outcome or a step's own question, each filed under a header of its own`
              : ``) +
            (completion.dealtNothing.reason === UPSTREAM_DEATH
              ? `. ${open.length} side(s) are open and this round deals them: nothing was in front of anybody last ` +
                `round, so none of them has an answer in flight`
              : ``),
        ]),
    ...(freed.keys.size
      ? [
          // D52 — QUARANTINE WITH NO RE-DEAL IS A STANDSTILL, NOT A RECOVERY.
          // Rounds 6 and 8 of run 20260919T104903Z quarantined the identical
          // two files, 3 faults and 6 rows, byte for byte. The sides those
          // rows freed are the only work that quarantine created, and a round
          // that frees them and does not deal them has bought nothing.
          `quarantine: ${freed.keys.size} side(s) came back into the brief because the row that answered each one ` +
            `is set aside, and this round deals ${freedDealt.length} of them` +
            (freedUndealt.length
              ? `. ${freedUndealt.length} are NOT dealt this round — the round is capped at ${batch} side(s) and ` +
                `${open.length} are open, so they are in \`heldBack\` and come first next round: ` +
                `${freedUndealt.slice(0, 5).join(", ")}${freedUndealt.length > 5 ? `, …` : ``}`
              : `, in the same round that freed them`),
        ]
      : []),
    `read ${proposedCount + declaredCount + coveredCount + undeliverableSides.length + open.length} uncovered side(s) from ${relative(REPO_ROOT, paths.worklistJson) || paths.worklistJson}`,
    `${proposedCount} already has an input, ${declaredCount} has a written reason` +
      (coveredCount ? `, ${coveredCount} the last measurement covers and nothing claims (not asked about)` : ``) +
      (undeliverableSides.length
        ? `, ${undeliverableSides.length} the recorder refused to exercise and is not asked about (still uncovered)`
        : ``) +
      // D56: said, because "has a written reason" no longer counts them.
      (refusals.size
        ? `, and ${open.filter((o) => refusals.has(sideKey(o.item.armId, o.side))).length} open side(s) have a ` +
          `declaration ledger.mjs refused, which rules nothing: they are dealt with the refusal`
        : ``),
  ];
  const metrics = {
    // HOW THIS ROUND'S SIZE WAS DECIDED. `batchFrom` is "pinned" when
    // CHARPILOT_DERIVE_BATCH or the option set it and "chosen" when
    // dynamicBatch sized it to the repo -- without it a reader cannot tell a
    // run that was throttled from one that decided it needed a small round,
    // and run 20260918T043026Z spent 130 minutes at 20 because nobody could
    // see which of the two it was.
    batchFrom: pinned ? "pinned" : "chosen",
    // D66 — WHAT THE ROUND WAS SIZED BY. `packetsPerRound` is the answer and
    // the three numbers under it are what a reader needs to see it move: the
    // concurrency is the machine's, the budget and the per-packet minutes are
    // the operator's. `packetFloor` and `packetCeiling` are gone from here
    // because they are gone from the arithmetic — a reader who still sees them
    // would read a round as throttled by a dial nothing consults.
    packetsPerRound: pinned ? null : packetsPerRound(),
    roundBudgetMin: pinned ? null : roundBudgetMin(),
    packetMinutes: pinned ? null : packetMinutes(),
    workerConcurrency: pinned ? null : workerConcurrency(),
    // THE TWO WEIGHTS THE FLOOR AND THE CEILING ARE NOW COUNTED IN. Without
    // them a reader cannot tell a round that was small because the repo is
    // small from one that was small because its packets are 47 KB each, and
    // those want opposite responses. Null when the batch was pinned, because a
    // pinned batch is not weighed at all.
    packetContextBytes: pinned ? null : PACKET_CONTEXT_BYTES,
    packetMaxWeight: pinned ? null : MAX_PACKET_WEIGHT,
    redealtSideWeight: pinned ? null : REDEALT_SIDE_WEIGHT,
    packetsHandedOutLastRound: handedOutLast,
    // D53(a) — THE WORD THAT GOES WITH THE ZERO. Present only when the zero is
    // there, because a reason for a round that dealt packets is a field the
    // reader has to decide to ignore. The walk carries it onto the round row
    // (packetlog.mjs's `dealtNothingReason`), so the two cases are apart in
    // the log line, on the round row and in `packetCompletion`'s output.
    ...(completion.dealtNothing ? { packetsDealtNothingReason: completion.dealtNothing.reason } : {}),
    // D53(b) — how many sides this round re-deals because nobody was asked
    // about them last round. Zero unless the walk died upstream.
    redealtAfterUpstreamDeath: redeal ? round.length : 0,
    // D52 — the sides a quarantine freed, and how many of them this round put
    // in front of somebody. Freed and dealt is a recovery; freed and undealt is
    // the standstill, and the two are one line apart in the log.
    quarantineFreedSides: freed.keys.size,
    quarantineFreedSidesDealt: freedDealt.length,
    quarantineFreedSidesUndealt: freedUndealt.length,
    // "ANSWERED" MEANS FINISHED: every side the packet holds is answered or
    // declared. The name is kept because it is the same question it always
    // asked; what changed is that it is now joined on the sides rather than on
    // a file name, and therefore answers it.
    packetsAnsweredThisRound: answeredThisRound,
    packetSidesDealtLastRound: completion.sidesDealt,
    packetSidesClosedLastRound: completion.sidesClosed,
    packetsFiledUnderReservedName: filedUnderReserved,
    submissionFilesRead: census.size,
    submissionAnswersRead: [...census.values()].reduce((n, c) => n + c.proposals + c.declarations, 0),
    // THE WHOLE open count, not this round's. The number that says how much
    // work is left has to survive the batching, or the run's own log would
    // report a backlog of 20 forever.
    open: open.length,
    handed: round.length,
    heldBack,
    batch,
    proposed: proposedCount,
    blocked: declaredCount,
    // D64. Uncovered, live, in the denominator, and NOT dealt: the recorder
    // refused to exercise the function and wrote why. A number that moves to
    // zero the round the recorder stops refusing, because it is read out of
    // the measurement rather than stored.
    undeliverable: undeliverableSides.length,
    // Uncovered, real work, and NOT asked about here: istanbul's branch map
    // cannot verify a `catch` arm, so it never ratchets and the ledger never
    // demands an account of it. Counted so that is visible.
    notInstrumented,
    // D75(b). Refused, materialised, receipted and NOT asked about, because
    // nothing is open and a note cannot close a side. Zero on every round that
    // still has work, which is what makes a non-zero one readable.
    cacheOnlyRefusalsHeld: cacheHeld.length,
    ...(salvageOn(runEnv) ? { salvagedOpen: salvagedSides.length } : {}),
    ...submissions.metrics,
  };
  // PLAN 20 T2.3: NOTHING LEFT BUT SALVAGED SIDES ends this walk, the way the
  // yield ratchet does -- from `run`, never from `satisfied`.
  if (salvagedSides.length && !open.length) {
    const stop =
      `every side still open is salvaged — ${salvagedSides.length} side(s), each held ${salvageAfter(runEnv)} rounds ` +
      `running with the same input and the same outcome. Ending the run here rather than dealing them again; they ` +
      `are ruled open with their repeated failure and stay in the denominator. CHARPILOT_SALVAGE_OPEN=off switches this off`;
    did.push(stop);
    return { did, pending: [], metrics, stop };
  }

  // ONE ROW PER PACKET OF THE ROUND THAT JUST ENDED, and nothing acts on it.
  //
  // WHY IT IS WRITTEN HERE AND NOT WHEN THE PACKET WAS DEALT: this is the first
  // moment the answers exist to join against, so one row can carry both halves
  // — what was dealt and what came back — instead of two rows nobody can pair.
  //
  // WHY IT EXISTS AT ALL: 14a's round row is per ROUND, and every scheduling
  // decision plan 15 describes is per PACKET. A p95 straggler trigger cannot be
  // written against a distribution nobody has seen, so this builds the
  // distribution and the trigger is deliberately not built. What a row still
  // cannot say is how long a packet took — see `packetlog.mjs`, which says so on
  // the object rather than leaving a reader to notice the field is absent.
  if (completion.handedOut) {
    recordPackets(
      completion.packets.map((p) => {
        const bytes = sourceBytes(p.file, { root: repo });
        return {
          packet: p.id,
          functionId: p.functionId,
          file: p.file,
          sidesDealt: p.dealt,
          contextBytes: bytes,
          contextWeight: bytes == null ? null : Math.max(1, bytes / PACKET_CONTEXT_BYTES),
          filed: p.answersFile ? census.has(p.answersFile) : null,
          sidesClosed: p.closed,
          finished: p.finished,
        };
      })
    );
  }
  reportPackets(metrics, did);
  reportRoundClock(metrics, did);

  /* ------------------------------------------------------------------------
   * THE YIELD RATCHET — does the round that just ended say to stop the run?
   *
   * ASKED HERE, and the position is the whole saving. Everything above this
   * line reads what is already on disk; everything below it spawns tools to
   * build a brief and then hands that brief to an agent turn. The walk has
   * already run `record`, `determinism`, `emit` and `measure` before calling
   * this step, so at this exact point the run's answered sides are banked and
   * nothing further is in flight. Stopping here costs nothing and skips a
   * whole round.
   *
   * WHAT IT WOULD HAVE DONE, on the three runs on disk. All three verdicts are
   * stated, including the one where it saves nothing and the one where it is
   * blind. Neither of the two runs below ended by finishing: both died by
   * SIGTERM when Docker Desktop stopped, so neither ending is a completion.
   *
   *   `20260918T164503Z` (tracy-worker) — NOT ONE OF THE RUNS ON DISK, despite
   *   the sentence above: no directory of that stamp is on any reachable
   *   checkout and its numbers are plan 13's D45 table (`docs/plans/plan13-bank-the-work-and-price-it-honestly.md`). Round 7 closed 9 sides for $25.83
   *   against a prior median of $0.28/side — 10.2x — but round 6 was 0.88x, so
   *   there is no confirming round and it does NOT fire. Rounds 8 and 9, which
   *   closed 96 and 48 sides for about $48, are kept. That is the whole reason
   *   the confirming round exists: under the single-round rule this run was
   *   the only measured firing and it was a false positive.
   *
   *   `20260919T092106Z` (location-ms). Round 2 is 334.7s a side and round 3 is
   *   433.3s a side, both far past 4x a 14.3s median, so it fires at the top of
   *   round 4 and saves round 4's 451s. The single-round rule fired a round
   *   earlier and saved 1,751s; the confirming round costs 1,300s of savings
   *   here, and that is the price of not throwing away tracy's 144 sides.
   *
   *   `20260919T104903Z` (location-ms). It does NOT fire, and the reason is
   *   worth more than the firing would have been: six of that run's nine
   *   rounds reported `packetsHandedOutLastRound=0`. A round that was dealt
   *   nothing closes nothing, and its zero is "nothing was asked" rather than
   *   "nothing was bought" — so the guard below refuses to judge it, and only
   *   rounds 2 and 9 are judgeable, which is not enough for a confirming round.
   *   That run spun for six rounds (194s, 355s and 201s with zero child turns,
   *   four sides open throughout) and this rule cannot see it. The signal that
   *   would is `packetsHandedOutLastRound=0` repeating, which is a different
   *   rule and is not this one; it is recorded here rather than papered over
   *   by loosening the guard, because loosening it would make every
   *   dealt-nothing round look like the worst round ever measured.
   *
   * IT IS SECONDS AND NOT DOLLARS, and `packetlog.mjs` carries the whole
   * argument for the substitution, including the three rounds where both can
   * be checked and agree. The short version: the walk runs inside the
   * container and the agent's spend is reported by the gateway to the HOST.
   * ---------------------------------------------------------------------- */
  // ONLY WHEN A ROUND ACTUALLY ENDED HERE. `handedOut` is how many packets
  // the last round put in front of an answering turn, so zero means there was
  // no round to judge — a cold round 1, or a walk re-entered without an agent
  // turn between it and the last one. Without this the clock would still
  // subtract two timestamps and hand the ratchet a round nobody ran, whose
  // closed-side count is zero and which therefore looks like the worst round
  // ever measured.
  // A FAILED ROUND is not a yield to judge either: a turn that brought nothing
  // back reads as the worst round ever measured, and it is retried below
  // rather than allowed to stop the run (see FAILED_ROUND_LIMIT).
  const ratchet = failedRound(completion)
    ? { fired: false, why: "the last round brought nothing back, so it is retried rather than judged", multiple: null, sample: null }
    : completion.handedOut
    ? ratchetFromLog({ closed: completion.sidesClosed, target: repo, env: opts.env ?? process.env })
    : { fired: false, why: "no round was handed over before this one, so there is no yield to judge", multiple: null, sample: null };
  // ONLY THE NUMBERS THAT EXIST. The walk prints every metric as `key=value`,
  // and a key whose value is null prints `roundYieldRatio=null` — which reads
  // as a measurement that came out null rather than as a question that was
  // never asked. A cold round has no ratio, and the `did` line below says so
  // in words instead.
  for (const [key, value] of [
    ["roundYieldSecondsPerClosedSide", ratchet.secondsPerClosedSide],
    ["roundYieldMedian", ratchet.median],
    ["roundYieldRatio", ratchet.ratio],
    ["roundYieldSampleSides", ratchet.sampleSides],
    ["roundYieldCollapsedInARow", ratchet.collapsedInARow],
  ]) {
    if (Number.isFinite(value)) metrics[key] = value;
  }
  if (ratchet.fired) {
    const stop =
      `the round that just ended bought almost nothing — ${ratchet.why}. Ending the run here rather than paying ` +
      `for another round of the same: every side this run answered is already recorded, emitted and measured, ` +
      `${open.length} side(s) are still open and a later run or shard can take them. Measured on run ` +
      `20260919T092106Z, where 54% of the clock bought 4% of the sides and the good round's work was banked ` +
      `before the bad ones started. The threshold is ${ratchet.confirm} round(s) in a row past ${ratchet.multiple}x ` +
      `the rolling median, with at least ${ratchet.sample} side(s) closed behind it; CHARPILOT_YIELD_RATCHET=off ` +
      `switches it off, CHARPILOT_YIELD_RATCHET_MULTIPLE, _SAMPLE and _CONFIRM move it, and _CONFIRM=1 restores ` +
      `the single-round rule that fired once on 20260918T164503Z (a run whose log is gone — the figures are ` +
      `plan 13's D45 table) and was wrong to`;
    did.push(stop);
    return { did, pending: [], metrics, stop };
  }
  // SAID EVEN WHEN IT DOES NOT FIRE, because a ratchet nobody can see the
  // arithmetic of is a ratchet nobody will trust when it does fire — and
  // because the run log is the only place these numbers have ever existed.
  did.push(`round yield: ${ratchet.why}`);

  /* ----------------------------------------------------------------------
   * D54 — THE STALL THE RATCHET ABOVE CANNOT SEE, ASKED HERE BECAUSE THIS IS
   * WHERE THE ANSWER IS.
   *
   * The ratchet judges what a round's seconds BOUGHT, which needs a round that
   * was dealt something. Run `20260919T104903Z` has two judgeable rounds and
   * they are not adjacent, so it is blind to it — and it must stay blind,
   * because a unit cost forced onto a dealt-nothing round makes every such
   * round in every run the worst ever measured. The signal that catches it is
   * `packetsHandedOutLastRound=0` repeating, which is a different question:
   * not "what did the round buy" but "was anybody asked at all".
   *
   * IT FIRES ON ONE OF THE THREE REASONS D53 NAMES APART, `walk-died-upstream`,
   * and only while sides are open. A cold round 1 and a run with nothing left
   * to do are the other two, and neither is a round anybody failed to ask
   * about. The whole rule is in `packetlog.mjs:stallRule`, beside the ratchet,
   * sharing its off switch and its shape; what is here is the two facts only
   * this step holds — which kind of nothing the last round dealt, and how much
   * is open right now.
   *
   * IT STOPS THE ASKING AND NOT THE RUN, exactly as the ratchet does, and the
   * walk carries on to `repair`, `ruling` and `report`. On the run this is
   * written about that is the difference between a result and a SIGTERM.
   * -------------------------------------------------------------------- */
  const stall = stallFromLog({
    reason: completion.dealtNothing?.reason ?? null,
    open: open.length,
    target: repo,
    env: opts.env ?? process.env,
  });
  if (Number.isFinite(stall.deadInARow)) metrics.roundsDeadUpstreamInARow = stall.deadInARow;
  if (stall.fired) {
    const stop =
      `nobody was asked about the work that is left — ${stall.why}. Ending the asking here rather than paying for ` +
      `another round that deals nothing: everything answered so far is already recorded, emitted and measured, ` +
      `${open.length} side(s) are still open and a later run or shard can take them, and the walk runs on through ` +
      `repair, ruling and report so this run still writes a result. The threshold is ${stall.rounds} round(s) in a ` +
      `row that ended before \`derive\` with sides open; CHARPILOT_STALL_RULE=off switches it off and ` +
      `CHARPILOT_STALL_RULE_ROUNDS moves it. THE THING TO FIX IS UPSTREAM: a round ends before \`derive\` because ` +
      `a step ahead of it refused, and that refusal is in this run's log at the round before each of these`;
    did.push(stop);
    return { did, pending: [], metrics, stop };
  }
  // SAID EVEN WHEN IT DOES NOT FIRE, for the reason the ratchet's line is said:
  // a rule nobody can see the arithmetic of is a rule nobody trusts on the day
  // it finally fires.
  did.push(`round deal: ${stall.why}`);

  // AFTER the cap is read and BEFORE anything is spawned to build a brief: an
  // unreadable cap is refused above with nothing yet run, and what the recorder
  // says about the last round is wanted before this round's inputs are derived
  // on top of it.
  const decision = opts.decision ?? mode();
  const verify = verifyOnWrite(repo, paths, { ...opts, decision });
  did.push(...verify.did);
  Object.assign(metrics, verify.metrics);

  // EVERY ATTEMPT THAT IS NOT A PASS AND NOT A DEGRADE. `target-missed` is left
  // out because `verify.contradictions` already carries it, one item per
  // contradicted claim with the arm the run actually hit. An UNDECIDED outcome
  // is deliberately in: a skip nobody could classify is still a skip, and
  // dropping it would put it back where run 20260916T112101Z left it — a `did`
  // line, read once, routed on never.
  const recorderResults = verify.results.filter(
    (r) => r.outcome !== OUTCOMES.VERIFIED && r.outcome !== OUTCOMES.TARGET_MISSED && r.outcome !== OUTCOMES.NOT_RUN
  );
  metrics.verifyActionable = recorderResults.length;

  // NOTHING LEFT TO BRIEF, and refusals still to hand back. They are items like
  // any other and they state the round's limits like any other: this is the
  // round where an agent is deciding how much to put in its next submission,
  // which is the decision run 20260916T194950Z got wrong from an invented cap.
  if (!open.length && !verify.contradictions.length && !recorderResults.length) {
    return {
      did,
      pending: withLimits(
        submitted,
        roundLimits({ items: submitted.length, open: 0, briefed: 0, heldBack, batch, verify: verifyLimit(opts) })
      ),
      metrics,
    };
  }

  // NOTHING NEW TO ASK, and this round was only reached because something was
  // submitted. `satisfied` refuses while an answer waits to be materialised, so
  // a submission made during a REPAIR round re-enters here on the next walk —
  // and re-briefing sides the handover already names is the three-round loop
  // this file exists to have stopped. Materialising them is the work; asking
  // again is not.
  if (!submitted.length && !verify.contradictions.length && !recorderResults.length && metrics.submissionsMaterialised > 0 && handedEverything(open, handedOver(paths.handover))) {
    did.push(
      `every one of the ${open.length} side(s) still open is already in the handover on disk — this round materialised ` +
        `what was submitted and asks nothing new`
    );
    return { did, pending: [], metrics };
  }

  const cwd = repo;
  const skeleton = readSkeleton({ tool: paths.tool, exec: paths.exec, cwd });
  // PAST THE BUDGET WITH WORK UNRECORDED: hand over nothing and name the step
  // that can move. `record` clears the clock, so the derive after it starts
  // fresh and the 3->4->5->6 loop turns again. The walk applies this only when
  // `record` is actually still ahead of us in ITS order — where it is not, this
  // is a dead end and the walk fails exactly as before.
  if (skeleton?.overBudget) {
    // THE TOOL'S OWN BYTES, WHOLE — not a paraphrase and not the first line.
    // Its stderr carries the count, the budget AND `npm run pilot:record`, and
    // that last one is the move; a summary that drops it turns an instruction
    // into "the brief could not be built", which is the state this whole branch
    // spent a day in.
    const said = skeleton.said
      ? skeleton.said.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")
      : "stage 3 is past its budget with proposals unrecorded";
    did.push(
      `worklist.mjs exited 3 — ${said} ` +
        `Nothing is handed over this round: record is what clears the clock, and the derive after it starts fresh.`
    );
    metrics.overBudget = 1;
    return { did, pending: [], metrics, deferTo: "record" };
  }
  const handoff = readHandoff({ tool: paths.tool, exec: paths.exec, cwd, outDir: paths.outDir });
  const schema = readSchema({ tool: paths.tool, exec: paths.exec, cwd });
  const vocabulary = readVocabulary(paths.outDir);

  const byArm = new Map((worklist.items ?? []).map((i) => [i.armId, i]));

  // THE PROBE, before a single argument is invented for this round's sides.
  //
  // In `live` it does not run at all, for the reason verify-on-write does not:
  // everything here degrades to the batch in live mode, and a step that made a
  // live round behave differently from the record step it anticipates is the
  // one disagreement this file exists not to have. It costs no process either
  // way — see `cannotInvoke` — so the whole of it is a map lookup per side.
  const probe = decision.live
    ? new Map()
    : cannotInvoke(paths, { batchArtifact: opts.batchArtifact ?? recordedArtifact() });
  if (decision.live) {
    did.push(
      `probe: did not run — in live mode every recorded row is a real billed request, so nothing here asks the recorder ` +
        `anything and the sides are briefed as the work list reads them. mode: live`
    );
  } else {
    did.push(
      `probe: the recorder has already said it cannot invoke ${probe.size} function(s), read from its own \`skipped\` ` +
        `entries — no process was spawned to find out, and a function it has said nothing about is left exactly as it was`
    );
  }
  let rerouted = 0;

  // THE ROUND'S PACKETS, off the grouping `nextBatch` already filled the round
  // with. Nothing is dispatched and nothing is re-derived: this names which of
  // the round's sides are arms of one function, so the handover says "one
  // reading answers these" instead of repeating the owner once per side.
  const packets = packetsFor(round, { boundariesByFunction: skeleton.boundaries ?? {} });
  const packetCount = new Set([...packets.values()]).size;
  // THE ROUND'S CONTEXT CLUSTERS. `nextBatch` already dealt the round by
  // context, so a cluster's packets are together in it; this names the cluster
  // so each of its packets' files says which other packets share the reading,
  // and decides whether the answering turn may put more than one worker on it.
  //
  // THE SPLIT DEPENDS ON A NOTE AND ON NOTHING ELSE. `record: false` because
  // asking whether a note exists in order to DECIDE something is not a worker
  // hitting it, and counting it as a hit would inflate the one rate plan 14 is
  // judged on. A file whose note cannot be read at its current bytes is not
  // split — see the D47 block above for what the alternative costs.
  const clusters = clusterPackets(packets, {
    hasNote: (file) => {
      try {
        return readNote(file, { root: repo, record: false }).hit;
      } catch {
        // A note store that cannot be read is "no note", which is the safe
        // answer: the cluster stays whole and one worker reads the file once.
        return false;
      }
    },
  });
  // COUNTED, never capped. `batch` bounds sides and only sides — a repo whose
  // 30 open sides are one function is 30 against the cap, not 1, and a cap that
  // counted packets would smuggle a whole function past a round of 20.
  metrics.packets = packetCount;
  /* ------------------------------------------------------------------------
   * D63 — SAID OUT LOUD, both halves. The re-addressing is invisible in the
   * packet count (a callback whose enclosing function already has open sides
   * costs nothing and shows as one packet fewer), so the only place the change
   * can be checked against a run is here.
   * ---------------------------------------------------------------------- */
  // COUNTED OVER THE OPEN SIDES AND NOT OVER THE WORK LIST. `attachUnits`
  // decides per ITEM and an item carries several sides; the quantity every
  // other number in this log is quoted in is the side, and an item-count
  // reported as a side-count is the kind of unit mismatch D53 was about.
  const refusedArms = new Set(addressing.refused.map((r) => r.armId));
  const readdressedSides = open.filter(({ item }) => item.packetUnit).length;
  const refusedSides = open.filter(({ item }) => refusedArms.has(item.armId)).length;
  const unitsInPlay = new Set(open.filter(({ item }) => item.packetUnit).map(({ item }) => item.packetUnit.functionId));
  metrics.sidesReaddressed = readdressedSides;
  metrics.sidesUnaddressable = refusedSides;
  if (readdressedSides || refusedSides) {
    did.push(
      `packet unit: ${readdressedSides} open side(s) whose owning function is an anonymous call argument with no own ` +
        `entry are addressed to ${unitsInPlay.size} enclosing function(s) a worker can call — the row keeps its own ` +
        `functionId and nothing about recording or validation moves, only the packet. ` +
        (refusedSides
          ? `${refusedSides} more were left exactly where they are: ${addressing.refused[0].why}` +
            (addressing.refused.length > 1 ? `, and ${addressing.refused.length - 1} more like it` : "") +
            `.`
          : `Nothing was refused.`)
    );
  }

  // D60: the rulings the scan step superseded, by side, so a side re-dealt
  // because its entry's premise no longer holds SAYS so in its packet.
  const supersededBySide = supersededRulings(join(paths.outDir, "blocked-premises.json")).bySide;
  const items = round.map(({ item, side }) => withRefusedDeclaration(refusals.get(sideKey(item.armId, side)), withSupersededRuling(supersededBySide.get(sideKey(item.armId, side)), (() => {
    const packet = packets.get(sideId(item.armId, side)) ?? null;
    const context = contextFor({ item, side, skeleton, handoff, schema, vocabulary, packet, scan });
    // THE RECORDER OUTRANKS THE SCAN HERE, and only in this direction. `kindOf`
    // reads the scan's own reachability, which is what the agent simulated by
    // hand on run 20260916T112101Z and got wrong; a verdict in `probe` is
    // record.mjs's real invocation path saying it could not call the thing. A
    // function the recorder has NOT refused is untouched — this never promotes
    // a `declaration` back to an `input`.
    const uncallable = probe.get(item.owner?.functionId) ?? null;
    // THE NARROW SET DECIDES THE KIND. `context.boundaries` is the ANSWER SET —
    // every symbol validate.mjs demands, identity or not — and asking the kind
    // out of it would call an `instanceof` arm a boundary question, which is
    // exactly what `worklist.mjs:855-858` filters `functionBoundaries` to stop.
    // An identity is an ARGUMENT question: nothing is mocked to take that side,
    // a value of the right type is passed.
    const asks = Object.keys(skeleton.boundaries[item.owner?.functionId] ?? {});
    const kind = uncallable ? "declaration" : kindOf(item, asks);
    if (uncallable) rerouted += 1;
    return {
      // The side, addressed the way the ledger names an unaccounted one. It is
      // an address rather than a derivation, so it is mechanical on purpose —
      // and it is the SAME function `satisfied` reads these ids back with, so
      // the two cannot drift into disagreeing about what was handed over.
      id: sideId(item.armId, side),
      kind,
      question: uncallable ? probeQuestion(item, side, uncallable) : question(kind, item, side),
      file: item.file,
      line: item.line,
      context: uncallable
        ? {
            ...context,
            // NAMED as the recorder's verdict and not merged into the brief:
            // the agent has to be able to tell "the scan resolved no entry"
            // from "the recorder tried and could not", because only the second
            // one is evidence a declaration can cite.
            probe: {
              outcome: OUTCOMES.CANNOT_INVOKE,
              route: OUTCOME_ROUTES[OUTCOMES.CANNOT_INVOKE],
              askedOf: "record.mjs",
              functionId: uncallable.functionId,
              via: uncallable.via,
              why: uncallable.why,
              provenance: { proposal: uncallable.proposal, artifact: uncallable.artifact },
            },
          }
        : context,
    };
  })())));

  // FIRST, ahead of this round's own sides. A premise that is already wrong
  // costs more the longer more inputs are built on it — 40 of the 55 false
  // claims on run 20260915T111114Z were two clusters, one subagent's slice
  // each, and each of those slices was one shared premise.
  // A REFUSED SUBMISSION COMES FIRST OF ALL. It is the cheapest item in the
  // round — one named field in a file the agent already wrote — and until it is
  // fixed the answer it carries is not on disk at all.
  // ONE UNDECLARED SYMBOL IS ONE QUESTION. See groupByBlockedSymbol: 16 rows
  // blocked by `prisma.apiKey` on run 20260917T140215Z were 16 items about one
  // missing declaration, and every one of them gated `record`.
  const grouped = groupByBlockedSymbol(recorderResults);
  metrics.verifyGrouped = grouped.led.length;
  metrics.verifyGroupedMembers = grouped.led.reduce((n, g) => n + g.members.length, 0);
  const recorderItems = [
    ...grouped.led.map(({ symbol, lead, members }) => {
      const it = recorderItem(lead, { byArm, labelsByArm, skeleton, handoff, schema, vocabulary, scan });
      return {
        ...it,
        question:
          `${members.length} row(s) were refused for ONE undeclared boundary — \`${symbol}\`. ` +
          `Declare it once and every one of them records: ${it.question}`,
        context: {
          ...it.context,
          group: {
            // The field a reader routes on, named the same as repair's.
            sharedCause: `no boundary declared for \`${symbol}\``,
            symbol,
            members: members.map((m) => m.proposal.id),
            says:
              "ANSWER THIS ONCE AND ALL OF THEM ARE ANSWERED. These rows are not asked separately: they were each " +
              "refused by the recorder for the same missing declaration, so one boundary answer releases every one " +
              "of them. Run 20260917T140215Z had 16 rows waiting on `prisma.apiKey` alone.",
          },
        },
      };
    }),
    ...grouped.singles.map((r) => recorderItem(r, { byArm, labelsByArm, skeleton, handoff, schema, vocabulary, scan })),
  ];
  // THE ROUND'S REFERENCE MATERIAL, WRITTEN ONCE. Last, over the whole list, so
  // the submissions and the recorder's own items are covered by it too — they
  // carry the same brief and the same vocabularies, and a block deduplicated
  // over four fifths of a file is a block still repeated.
  const briefs = [
    ...submitted,
    ...verify.contradictions.map((c) => contradictionItem(c, { byArm, skeleton, handoff, schema, vocabulary, scan })),
    ...recorderItems,
    ...items,
  ];
  // WHAT THIS ROUND ACTUALLY PERMITS, on every item, counted here and nowhere
  // else. `assembled.length` is the round's real item count — the sides briefed
  // plus the refusals and recorder outcomes handed back with them — and it is
  // not knowable until the list is assembled, which is why this is the line
  // after it rather than a field on each item's own brief.
  const limits = roundLimits({
    items: briefs.length,
    open: open.length,
    briefed: items.length,
    heldBack,
    batch,
    verify: verifyLimit(opts),
  });
  const assembled = withLimits(briefs, limits);
  // THE FILES THIS ROUND IS HANDED OVER AS, one per packet — decided here,
  // where the packets are, and written by the walk, which is the one layer
  // allowed to put bytes on disk.
  //
  // `bundle` is a TOP-LEVEL field and deliberately not part of `context`: it is
  // ROUTING, not evidence. `pendingJson` renders the brief and drops it, so what
  // the answering turn reads carries no trace of how it was filed, and an item
  // still says nothing about where any other item lives.
  const byPacketId = new Map([...packets.values()].map((p) => [p.id, p]));
  // WHAT AN EARLIER ROUND LEARNED, matched to this round's source. The
  // fingerprint is computed once per function for the whole round; a note whose
  // fingerprint is not this one is not served, and how many were dropped is
  // said out loud below rather than being a silence.
  const observations = observationsByFunction({
    results: verify.results,
    probe,
    landed: landedRowsById(paths.proposalsDir),
    recorded: recordedRowsById(paths.outDir),
  });
  // HOW MANY OF THIS ROUND'S FILES OWE A NOTE — counted ONCE, over every
  // packet, because the number is the ROUND's and a packet cannot see past its
  // own reading plan. It is the number `noteCacheFurniture` gates its all-miss
  // notice on and the number `reportNoteCache` prints in `did`, and neither
  // had it: `reportNoteCache(metrics, did)` was called with no `obligation`
  // and the packet header with no `owed`, so the notice existed and was
  // emitted nowhere.
  const obligation = noteObligation(packets, { root: repo });
  const sourceCache = new Map();
  const headers = new Map();
  let notesServed = 0;
  let notesDropped = 0;
  let notesMinted = 0;
  const bundled = assembled.map((p) => {
    const id = p.context?.packet?.id;
    const packet = id ? byPacketId.get(id) : null;
    if (!packet) return { ...p, bundle: soloHeader(p) };
    // The item the header is built from — the first of its packet to arrive.
    const firstOf = p;
    // ONE HEADER OBJECT PER PACKET, shared by its items. That is what makes
    // "written once, at the top of the file" true of the bytes and not just of
    // the intention: `shareIntoPackets` writes into this object, and the walk
    // renders it once.
    if (!headers.has(id)) {
      const functionId = packet.functionId;
      const source = sourceFingerprint(functionSource(scan, functionId, { cache: sourceCache }));
      const notes = notesForFunction({
        functionId,
        source,
        carried: carriedNotes.get(functionId) ?? [],
        observations: observations.get(functionId) ?? [],
      });
      notesServed += notes.block?.notes?.length ?? 0;
      notesDropped += notes.dropped;
      notesMinted += notes.minted;
      // A SUBMISSION ITEM ANSWERS THE FILE IT NAMES, NOT A NAME DERIVED FROM
      // ITS OWN ID.
      //
      // THE DEFECT, run 20260917T100643Z. An item whose job is "fix
      // charpilot-answers/answers-af58166112c4.json" was handed a packet
      // reserving `answers-80a1e57a1c7d.json`, so the item said one file and
      // its own furniture said another. The agent wrote the one the item
      // named, which is correct and is the only one that repairs anything, and
      // the reserved-name check then minted a FRESH submission fault because
      // that file was not written under its reservation. Each repair
      // manufactured its next item: packets 01, 02 and 03 of round 6 were pure
      // name complaints pointing back at 04 and 05, `open` never reached 0,
      // and `record` had not run once in 88 minutes.
      //
      // `repair.mjs` already passes `answersFile` for exactly this reason
      // (repair.mjs:1795). This is derive doing the same thing.
      // A RECORDER OUTCOME IS A REPAIR OF A ROW THAT ALREADY EXISTS, so its
      // packet reserves the file that row LIVES IN — exactly as a submission
      // fault does. `validate.mjs:681` keeps `seen` ids across the whole
      // flattened proposals directory, so the same id in two files quarantines
      // BOTH and the side reopens.
      //
      // THE COST, run 20260917T140215Z rounds 4 and 5. Recorder items were
      // given fresh reserved names, workers wrote the rows there, and the ids
      // were already in the files they came from:
      //   quarantined answers-0643aa52a86d.json[0] "parseAddressesForJd-113-default-arg-0" — duplicate id
      //   quarantined answers-a5707c2dd6e6.json[0] "parseAddressesForJd-113-default-arg-0" — duplicate id
      //   quarantined answers-f1ebbe4c83f8.json[0] "parseAddressesForJd-113-default-arg-0" — duplicate id
      //   quarantined worker5-googlemap-parseaddresses.json[0] "parseAddressesForJd-113-default-arg-0" — duplicate id
      // One side, four files, every copy set aside. quarantinedRows went 4 ->
      // 12, open went 2 -> 6 and proposed 134 -> 130: derivation had finished
      // at round 3 and rounds 4 and 5 un-finished it.
      const resubmit =
        firstOf?.context?.submission?.resubmit?.file ?? firstOf?.context?.recorded?.proposalFile ?? null;
      headers.set(
        id,
        packetHeader(packet, {
          notes: notes.block,
          // D62: a fresh name when an earlier round's answers hold the derived one.
          lastSeen: census.get(resubmit ? answerFileFor(id) : freshAnswerFile(id, census).file) ?? null,
          answersFile: resubmit ? basename(resubmit) : null,
          fresh: resubmit ? null : freshAnswerFile(id, census),
          cluster: clusterBlock(clusters.get(packet.file)),
          source: briefSourceOn(runEnv) ? sourceBlock(scan, packet.functionId, { root: repo }) : null,
          // PLAN 20 T2.5d: the low-risk cohort goes to the lower-effort worker.
          worker: lightWorkerOn(runEnv) && lightCohort({
            count: packet.count,
            sideIds: [firstOf?.id].filter(Boolean),
            sourceBytes: Buffer.byteLength(functionSource(scan, packet.functionId, { cache: sourceCache }) ?? "x".repeat(1e6), "utf8"),
          }) ? LIGHT_WORKER_AGENT : null,
          carried: carried.get(id) && !carried.get(id).limitReached ? carriedBlock(carried.get(id)) : null,
          // NOTHING OWED, NOTHING SAID. `noteObligation` leaves out a file
          // the checkout does not have — there is nothing to read and so
          // nothing to write down — so a round can reach zero honestly, and
          // `noteOwedNotice` interpolated with 0 tells a worker that "1 of the
          // files above ... owe one; 0 in this round", which is a
          // contradiction in one sentence. Absent instead, by the same rule
          // `notes` and `cluster` above follow.
          owed: obligation.owed > 0 ? obligation.owed : null,
          // THE STEP'S OWN CHECKOUT, not the module-level `REPO_ROOT`.
          // `noteCacheFurniture` resolves every file of the reading plan
          // against this to decide hit or miss, and until it was passed an
          // in-process caller got `REPO_ROOT` — `nodejs/` under the tests —
          // where the target's files do not exist. See `noteObligation` above:
          // same argument, same reason.
          root: repo,
        })
      );
    }
    return { ...p, bundle: headers.get(id) };
  });
  if (notesServed || notesDropped) {
    metrics.packetNotes = notesServed;
    metrics.packetNotesMinted = notesMinted;
    metrics.packetNotesDroppedAsStale = notesDropped;
    did.push(
      `carried ${notesServed} note(s) forward in their packets (${notesMinted} written this round) and did NOT serve ` +
        `${notesDropped} whose function's source has moved since somebody wrote them down — a note is keyed to the ` +
        `function AND to a digest of its source, so it cannot go stale silently. Each says whether it was OBSERVED (a ` +
        `tool's own bytes), DERIVED (a reading of them) or UNTESTED (a hypothesis nobody ran), and each reads as ` +
        `EVIDENCE and never as authority: the fingerprint bounds staleness, not correctness, and a note trusted ` +
        `instead of the source propagates one misreading to every round that touches the function. Measured on run ` +
        `20260916T223906Z: 93 of 98 source reads were of a file an earlier round had already read`
    );
  }
  // A DIFFERENT CACHE, AND THE NAME COLLISION IS REAL. The block above is the
  // handover's per-FUNCTION notes, minted by this step from tools' own output.
  // This is notes.mjs's per-FILE cache of what a worker learned by reading, and
  // it answers the other half of the same waste: measured on run
  // 20260918T164503Z, 86% of 1,537 Read calls were re-reads and one 47 KB file
  // was read 72 times — that run has no directory anywhere reachable, so those
  // counts are plan 13's D45 table rather than a log you can open. Reports nothing at all when no packet was served a note.
  reportNoteCache(metrics, did, { obligation });
  did.push(
    `checkpoint: every item says how to get the REAL verdict on ONE scenario before a family is built on it — submit ` +
      `one representative row, and ${CHECKPOINT_TOOL} judges it through the SAME spawn this step makes at the round ` +
      `boundary, with the recorder's own outcome beside it where verify-on-write is on. There is no second checker: a ` +
      `friendlier one that disagreed would teach a pattern that fails the real gate. Asking whether a document would ` +
      `be accepted advances no state, so it is not the thing the prompt forbids; running \`pilot:*\` still is. Round 2 ` +
      `of run 20260916T223906Z wrote 135 rows before anything judged one, and 353 faults then quarantined 99 of them`
  );
  did.push(
    `stated this round's real limits on every item: ${limits.items} item(s) here, all ${limits.mayAnswer} answerable, ` +
      `no per-submission cap, ${limits.openSides} side(s) still open, round capped at ${limits.roundCap} ` +
      `(${limits.roundCapFrom}) and ${limits.verifiedNextRound} proposal(s) recorded early next round ` +
      `(${limits.verifiedFrom}) — every number read off this run. Run 20260916T194950Z's answering turn held itself ` +
      `to 12 proposals under a "20-proposal claiming cap" that exists nowhere in this pipeline`
  );
  const { pending, shared, saved } = shareIntoPackets(bundled);
  if (shared.length) {
    metrics.sharedBlocks = shared.length;
    metrics.sharedBytesSaved = saved;
    did.push(
      `wrote ${shared.length} reference block(s) ONCE at the top of each packet's own file instead of once per item ` +
        `(${shared.map((b) => `${b.key} ${b.bytes}B x${b.wasCopies} -> x${b.copies}`).join(", ")}) — about ${saved} ` +
        `bytes of reference material that was the same on every item of a packet. It is in that file's \`packet.shared\` ` +
        `now and every item below it names it in a sentence, so following it is scrolling and never opening a second ` +
        `file. NOTHING AN ITEM MUST FILL MOVED: the arm, the owner, the boundaries and the whole document to submit ` +
        `are all still on the item itself`
    );
  }

  if (rerouted) {
    did.push(
      `routed ${rerouted} of this round's ${items.length} side(s) to \`declaration\` because record.mjs has already said ` +
        `it cannot invoke their function — the verdict is the recorder's own \`skipped\` reason, quoted on the item, and ` +
        `no argument is derived for a subject that cannot be called`
    );
  }
  if (recorderItems.length) {
    const byOutcome = {};
    for (const r of recorderResults) byOutcome[r.outcome ?? "undecided"] = (byOutcome[r.outcome ?? "undecided"] ?? 0) + 1;
    did.push(
      `handing back ${recorderItems.length} recorder outcome(s): ` +
        `${Object.entries(byOutcome).map(([k, n]) => `${n} ${k}`).join(", ")} — ` +
        `a proposal the recorder could not turn into a row is an item naming what it could not do, never a \`did\` line alone`
    );
  }
  if (submitted.length) {
    did.push(
      `handing back ${submitted.length} refused submission(s) ahead of everything else — each names the field, the ` +
        `file and the entry, and the round carries on around it`
    );
  }
  if (verify.contradictions.length) {
    did.push(
      `handing back ${verify.contradictions.length} recorded contradiction(s) ahead of this round's sides — ` +
        `a claim the recorder has already refuted is not a question to ask again, it is an input to repair`
    );
  }
  if (items.length) {
    did.push(
      `briefed ${items.length} open side(s) from worklist.mjs --skeleton, handoff.mjs --stage 4 and validate.mjs --schema`
    );
    // THE UNIT, said in the run's own log. A round that grouped 20 sides into 6
    // packets and a round that grouped them into 20 are different amounts of
    // reading, and nothing else in the log distinguishes them. Nothing is
    // dispatched on this count — it is one walk, one exit 75 and one answering
    // turn whatever it says.
    const largest = [...new Set([...packets.values()])].reduce((n, p) => Math.max(n, p.count), 0);
    did.push(
      `grouped them into ${packetCount} packet(s) — a packet is one function, its sides are the questions one reading of ` +
        `that function answers, and the largest here carries ${largest} side(s). Each side is still its own item with its ` +
        `own id and its own whole brief. Each packet is a UNIT OF WORK: its own file, its own reserved answer file name ` +
        `(\`packet.answers.file\`), and its own submit-and-verify cycle, so a finished packet is materialised and ` +
        `validated without waiting for the slowest one. From HERE nothing is dispatched — this step spawns the same ` +
        `tools once for the whole round whatever the packet count — and a packet is never split, because its sides are ` +
        `collected by bundle id before anything is written`
    );
    // WHICH PACKETS SHARE A READING, and which of those the answering turn may
    // put more than one worker on. Both halves are said because they answer
    // different failures: the clusters are what stops one file being read by
    // two workers and then again next round (91% of reads on run
    // 20260918T164503Z were re-reads, and `agent.ts` was read 72 times — that
    // run's log is gone; the figures are plan 13's D45 table), and
    // the split rule is what stops the dominant cluster becoming the straggler
    // the round waits on.
    const shared = [...clusters.values()].filter((c) => c.packets.length > 1);
    const splittable = shared.filter((c) => c.mayBeSplit);
    did.push(
      `context: this round's ${packetCount} packet(s) read ${clusters.size} distinct file(s); ${shared.length} of those ` +
        `file(s) are read by more than one packet and were DEALT TOGETHER, so the reading is acquired once instead of ` +
        `once per packet and once again next round. ${splittable.length} of them may be worked by more than one worker ` +
        `— a cluster is splittable only when a note for its file exists at that file's current bytes, because the ` +
        `second worker has to be handed the NOTE and not the file or the split has traded a straggler for the ` +
        `duplicate reading affinity existed to remove. The other ${shared.length - splittable.length} carry ` +
        `\`cluster.mayBeSplit: false\` on their own files, which the stage-3 skill reads as "one reading, one worker, ` +
        `and publish the note so a later round may split it"`
    );
  }
  if (heldBack) {
    // Said in the run's own log, because a round that quietly handed over a
    // fifth of the list is indistinguishable from a round that handed over all
    // of it — and that is the exact shape of the defect this cap exists to
    // avoid, one level up.
    did.push(
      `handed over ${items.length} of ${open.length} open side(s) and held ${heldBack} back: a round is capped at ` +
        `${batch} side(s) (${BATCH_ENV}), and the next walk rebuilds from the filesystem and briefs the next ${Math.min(heldBack, batch)}`
    );
  }
  const missing = items.filter((p) => !p.context.proposal.skeleton).length;
  if (missing) {
    // Said out loud rather than papered over: the skeleton is built from the
    // same work list this step read, so a side with no row in it means the two
    // disagree, and the agent is about to author a document by hand that the
    // tool was supposed to pre-address.
    did.push(`${missing} of them have NO skeleton row — worklist.mjs --skeleton and out/worklist.json disagree`);
  }
  // ── THE PHASE-3 TAIL CONTROLLER, judged on the whole transition ──────────
  //
  // Read BEFORE the walk overwrites the index: at this point `paths.handover`
  // still holds the round this one is replacing.
  const prev = lastProgress(paths.handover);
  const now = progressOf(metrics);
  const best = bestOf(prev?.best ?? prev, now);
  // A FAILED ROUND is judged first and is not a stall: see FAILED_ROUND_LIMIT.
  // The stall streak is carried through it unchanged, neither grown nor reset.
  const failed = failedRound(completion);
  const gatewayTurn = runEnv[GATEWAY_TURN_ENV] === "1";
  const failedRounds = failedRoundsAfter(prev?.failedRounds ?? 0, failed, gatewayTurn);
  const stalled = !failed && stalledAgainst(prev, now, prev?.best ?? prev);
  const stalledRounds = failed ? (prev?.stalledRounds ?? 0) : stalled ? (prev?.stalledRounds ?? 0) + 1 : 0;
  const progress = { ...now, stalledRounds, failedRounds, best };
  metrics.stalledRounds = stalledRounds;
  metrics.failedRounds = failedRounds;

  if (failed && failedRounds >= FAILED_ROUND_LIMIT) {
    did.push(
      `FAILED ROUNDS: 0 of ${completion.handedOut} packet(s) finished and no side closed, for ${failedRounds} ` +
        `round(s) in a row. Stage 3 stops opening rounds: ${open.length} side(s) are still open, record is next, ` +
        `and whatever is still open comes back through repair. Nothing is discarded — the handover stays on disk.`
    );
    return { did, pending: [], metrics, progress, deferTo: "record" };
  }
  if (failed) {
    did.push(
      `FAILED ROUND: 0 of ${completion.handedOut} packet(s) handed over last round finished and no side closed — ` +
        `the answering turn brought nothing back, which is a turn that did not deliver (run 20260925T085519Z: ` +
        `every turn ended on a 429 before it launched a worker), not a tail that does not move. This round deals ` +
        `again and it does not count as a stall. ` +
        (gatewayTurn
          ? `That turn hit the gateway, so it is not counted here either: the pack backs off between rounds and ` +
            `ends the run on infrastructure when its patience is spent (${failedRounds} of ${FAILED_ROUND_LIMIT} ` +
            `failed round(s) counted).`
          : `It is failed round ${failedRounds} of ${FAILED_ROUND_LIMIT} before stage 3 stops.`)
    );
  }

  if (stalled) {
    did.push(
      `NOTHING MOVED: proposed ${prev.proposed}->${now.proposed}, blocked ${prev.blocked}->${now.blocked}, ` +
        `verifyWaiting ${prev.verifyWaiting}->${now.verifyWaiting}. That is ${stalledRounds} consecutive round(s) ` +
        `with no new answer and no queue shrinkage. A round costs the whole agent turn whatever it closes — round 3 ` +
        `of run 20260917T140215Z took 30 minutes and left verifyActionable at 8.`
    );
  }

  if (stalledRounds >= STALL_LIMIT) {
    // CLOSE THE PHASE — and nothing is lost by it. The walk falls through to
    // `record`, and the sides still open come back through `repair` aimed by a
    // COVERAGE REPORT, which is better evidence than a fourth reading of the
    // same source. The handover stays on disk and `satisfied` is answered from
    // the filesystem, so this resumes rather than restarts.
    did.push(
      `RESIDUAL: ${open.length} side(s) still open, ${now.verifyWaiting} row(s) still queued for the recorder, ` +
        `and ${STALL_LIMIT} rounds running have moved neither. Stage 3 stops opening rounds for them. record is next ` +
        `and it is what turns ${now.proposed} proposal(s) into coverage; whatever is still open comes back through ` +
        `repair with the measurement to aim it. Nothing is discarded — the handover stays on disk.`
    );
    return { did, pending: [], metrics, progress, deferTo: "record" };
  }

  return { did, pending, metrics, progress };
}

/**
 * The one line the walk prints for an item.
 *
 * It names the arm, the side and the condition, because those three are what
 * makes one of 400 items distinguishable from another in a log. `oneLine`
 * strips literals out of the condition: the verbatim source is in `context`
 * where it is read as evidence, and a log line that carries a value is a value
 * that gets pasted.
 */
/**
 * D60 — A SIDE WHOSE RULING WAS SUPERSEDED SAYS SO, in the question and in the
 * context, so the answering turn knows the BLOCKED.md entry it may find cited
 * elsewhere (a note, an earlier answer file) is not the verdict: it was written
 * while the scan found no way to call the function, and the scan now finds one.
 * The item is otherwise exactly what `kindOf` and `callShape` made of the
 * current scan - an input question, driven through the driver (D58).
 */
export function withSupersededRuling(record, it) {
  if (!record || !it) return it;
  const said =
    `This side was ruled ${record.fields?.category ?? "unreachable"} in BLOCKED.md while ${record.was}; ${record.now}, ` +
    `so that ruling is SUPERSEDED and has been removed. Answer it as the input question it now is.`;
  return {
    ...it,
    question: `${said} ${it.question}`,
    context: {
      ...it.context,
      supersededRuling: {
        entry: record.fields,
        was: record.was,
        now: record.now,
        says:
          "The entry's premise was the scan's reachability fact, and the current scan contradicts it. Do not " +
          "re-declare the side from the old entry's reasoning; drive it through `call.driver` with `call.driverEntry`. " +
          "Declare it again only with proof that no caller the scan now resolves reaches it.",
      },
    },
  };
}

export function question(kind, item, side) {
  const where = `${item.armId} [${side}]`;
  // The TEST, not the statement: an `if` arm's stored source carries its whole
  // body, and a log line that quotes a body is a log line nobody reads.
  const cond = oneLine(decisiveText(item));
  const fn = item.owner?.name ?? item.owner?.functionId ?? "the function";
  switch (kind) {
    case "declaration":
      // D58: an unresolved via is the scan's limit, and the question says so
      // rather than "nothing can call" - see callShape.
      if (item.via?.kind === "unresolved") {
        const nearby = item.via.nearby ?? [];
        return (
          `${where}: the scan did not resolve a driver for ${fn} (${item.via.note ?? "unresolved"}) — that is not proof nothing calls it. ` +
          (nearby.length ? `Read whether ${nearby.join(", ")} reaches this side and drive it through that; ` : "") +
          `write the reason this side cannot be reached, with proof, only if no caller reaches it.`
        );
      }
      return `${where}: nothing can call ${fn} — the scan resolved no own entry, no driver and no trigger. Write the reason this side cannot be reached, with proof.`;
    case "boundary":
      return `${where}: the condition \`${cond}\` turns on what a collaborator does. What does it do on the run that takes ${side}?`;
    default:
      return `${where}: which argument values to ${fn} take the \`${side}\` side of \`${cond}\`?`;
  }
}
