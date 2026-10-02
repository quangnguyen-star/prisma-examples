/**
 * emit — the recorded pairs turned into the committed characterization suite,
 * and the suite checked against the manifest that says what generated it.
 *
 * TWO TOOLS, because the emission is only half of the step. `record.mjs
 * --emit-tests` renders the rows into `test/characterization/` and writes the
 * manifest beside them (record.mjs:2074); `emitted-integrity.mjs` is what then
 * says whether those files are byte-for-byte what the emitter wrote. Skipping
 * the second half is not free: every generated file carries `do not hand-edit`
 * in its first line, and a hand-typed expected value wears that header exactly
 * like a recorded one and reads as recorded in review
 * (emitted-integrity.mjs:5-11). The assertions in this suite are trustworthy
 * only because they were produced by RUNNING the code.
 *
 * WHAT `satisfied` ASKS, and why "the manifest exists" is the wrong question.
 * `--emit-tests` deletes the target's `*.test.ts` and re-renders from whatever
 * `behaviour.json` holds at that moment, so a manifest OLDER than the recording
 * describes a suite built from rows that have since been replaced. Read as
 * fresh, stage 6 then measures last round's tests and credits this round's
 * inputs with coverage they never earned — the stale-half failure union.mjs's
 * own header records, one stage earlier. So the manifest must be at least as
 * new as the artifact it was rendered from, which is a question the disk
 * answers.
 *
 * NO BILLING FLAG HERE EITHER. `--emit-tests` returns before vitest runs and
 * records nothing, but it is still `record.mjs`, and `--live` or `--fresh`
 * added on the way past would make it record. The only argument this step
 * passes is the output directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { CORPUS_REL, INCREMENTAL_RECORD, PILOT_DIR, SELF_REPO_ROOT, emitterDigest, isCorpusSpec } from "../config.mjs";
import { BANK_WALK_ENV, incrementalOn, manifestHashes, partialVisitRefusal, restsOnFull, specDiff, writeDirty } from "../incremental.mjs";
import * as earlyMeasure from "./earlymeasure.mjs";
import { here, runTool } from "./preflight.mjs";
import { environmentDefectReason, mode, recordedArtifact, supersededReason, unaccounted } from "./record.mjs";
import { readRecorded } from "../recordedstore.mjs";
import { loadTimeoutWithhold } from "../vitestred.mjs";

export const NAME = "emit";

/**
 * The committed suite, spelled the one way the pipeline spells it —
 * `package.json`'s `pilot:emit` passes exactly this string, and
 * emitted-integrity.mjs defaults `--tests` to it.
 */
export const EMIT_TESTS_REL = CORPUS_REL;

/**
 * Where the manifest lands. config.mjs exports no path for it, so it is
 * derived here rather than re-spelled in two places.
 *
 * SELF_REPO_ROOT, because record.mjs reads `--emit-tests` off argv and resolves
 * it against its own CWD (record.mjs:1992), and runTool fixes that CWD at
 * SELF_REPO_ROOT for every tool it spawns. This is where the write actually
 * lands, which is the only thing `satisfied` may answer from.
 */
export const EMITTED_JSON = resolve(SELF_REPO_ROOT, EMIT_TESTS_REL, "emitted.json");

/** The directory the manifest is a manifest OF, resolved the same way it is. */
export const EMIT_TESTS_DIR = resolve(SELF_REPO_ROOT, EMIT_TESTS_REL);

/** The generated specs on disk now, which is what `measure` will be handed. */
function renderedSpecs() {
  if (!existsSync(EMIT_TESTS_DIR)) return [];
  try {
    return readdirSync(EMIT_TESTS_DIR).filter(isCorpusSpec);
  } catch {
    return [];
  }
}

/** Milliseconds, or null when the file is not there. */
const mtimeOf = (path) => (existsSync(path) ? statSync(path).mtimeMs : null);

/**
 * Why the emitted suite cannot be read as this round's, or null when it can.
 *
 * A sentence rather than a boolean because `run` prints it: "the manifest is
 * older than the recording" is the diagnosis, and a bare false is a reader
 * comparing two timestamps by hand.
 */
export function staleReason() {
  const behaviour = recordedArtifact();
  const recordedAt = mtimeOf(behaviour);
  if (recordedAt === null) return `${here(behaviour)} is missing — there are no pairs to emit from`;
  // ASKED OF THE RECORDING FIRST, and before the two timestamps below. Those
  // compare the suite against the recording and would call a manifest rendered
  // one second ago perfectly fresh — while the rows it was rendered from, and
  // the determinism verdicts stamped on them, describe a proposal that has been
  // repaired since. That is the one staleness a timestamp cannot see, because
  // both files are newer than each other's problem.
  const repaired = supersededReason(behaviour);
  if (repaired) return repaired;
  const emittedAt = mtimeOf(EMITTED_JSON);
  if (emittedAt === null) return `${here(EMITTED_JSON)} is missing — the suite cannot say what generated it`;

  /* ---------------------------------------------------------------------- *
   * A MANIFEST WITHOUT THE SUITE IT DESCRIBES IS NOT AN EMISSION.
   *
   * WHAT THIS USED TO ASK: that `emitted.json` exists and is no older than the
   * recording. Both are true of a directory with NO `*.test.ts` in it at all,
   * and that state is reachable in one step: `record.mjs --emit-tests` DELETES
   * the target's `*.test.ts` and then re-renders them, so anything that stops
   * the process in between — a container kill, an OOM, a throw partway through
   * the rendering — leaves the manifest from the previous round and no suite.
   *
   * WHAT THAT COSTS, and it is the wedge rather than the loss. `satisfied`
   * answers true over that state, so the walk prints `emit: already done` and
   * moves on; `measure.precondition` then refuses with "no *.test.ts in
   * test/characterization — coverage.mjs measures the committed suite, so emit
   * it first", which is a PRECONDITION failure, i.e. an inconsistency the walk
   * refuses on and writes no worklist for. And the instruction it gives cannot
   * be followed by the walk: `emit` is the step that would emit it, and `emit`
   * has just reported itself done. Every later invocation takes the same path.
   *
   * ASKED HERE RATHER THAN FIXED IN `measure`, because this is the step whose
   * `run` can change it: one `--emit-tests` re-renders the suite and the
   * question answers itself. A `measure` that tolerated an empty directory
   * would be measuring nothing and calling it a round.
   *
   * WHERE THE DURABLE FIX BELONGS, named because this is the layer working
   * around it: `record.mjs --emit-tests` should render into a temporary
   * directory and swap it into place, so the window in which the suite does not
   * exist never opens — the same move `workflow.mjs:writeWorklist` now makes for
   * the handover. That is a change in the tool. A step that re-rendered around a
   * tool that deletes before it writes would leave the tool wrong for the next
   * repo, which is the rule `steps.never-repair-a-tools-output` exists to keep.
   * ---------------------------------------------------------------------- */
  if (!renderedSpecs().length) {
    return (
      `${here(EMITTED_JSON)} is there and ${here(EMIT_TESTS_DIR)} holds no *.test.ts — the manifest describes a suite ` +
      "that is not on disk. `--emit-tests` deletes the specs before it re-renders them, so a run killed in that " +
      "window leaves exactly this: read as done, it makes `measure` refuse on a precondition no re-run of this step " +
      "would ever clear"
    );
  }
  if (emittedAt < recordedAt) {
    return (
      `${here(EMITTED_JSON)} is older than ${here(behaviour)} — this suite was rendered from rows that have since been ` +
      "replaced, so measuring it would credit this round's inputs with last round's coverage"
    );
  }
  // THE SUITE THE TOOLS INSTALLED NOW WOULD DRAW, AND GATE (item 6b). With the
  // record cache off the recorder's bytes, a new toolset re-records nothing by
  // itself, so a resume whose inputs and code did not move would otherwise read
  // the suite an older record.mjs drew as done, and no replay under these tools
  // would ever judge a recording another toolset made. Rendered once more, and
  // cigate runs it: a row it finds red is recorded again (ciGate). Off, as
  // before (config.mjs INCREMENTAL_RECORD).
  const drawnBy = recordedEmitter();
  const drawsNow = emitterDigest();
  if (INCREMENTAL_RECORD && drawnBy && drawsNow && drawnBy !== drawsNow) {
    return (
      `${here(EMITTED_JSON)} was rendered by another record.mjs (${drawnBy}, installed now ${drawsNow}) — the suite is ` +
      "drawn again and cigate replays it under these tools, so a recording they no longer reproduce is found and recorded again"
    );
  }
  const unbound = unboundQuarantine();
  if (unbound.length) {
    return (
      `${unbound.length} row(s) are held \`it.skip\` by a quarantine that does not name the recording the suite holds ` +
      `(${unbound.slice(0, 3).join(", ")}${unbound.length > 3 ? ", …" : ""}) — a verdict on an earlier recording, on ` +
      "a test an earlier record.mjs rendered, or one written before a verdict said which it was about, so " +
      "re-emitting runs them and cigate judges this one"
    );
  }
  const partial = partialGateReason();
  if (partial) return partial;
  return null;
}

/**
 * A SUITE GATED IN PART IS FRESH ONLY FOR A VISIT THAT MAY REST ON A PART.
 *
 * incremental.mjs lets cigate run only the spec files that changed, on the
 * banking visit a round makes before `derive` hands the next one over. That
 * visit decides nothing: the walk ends at `derive`. The visits that go on to
 * `report` - this step at its own position in ORDER, and every visit of the
 * bank walk - may not stand on it, because a file can be red only in company
 * (D48, D52). So there the suite is stale until a full pass has seen it, and
 * `run` gates the whole corpus: the report never rests on a partial gate.
 * Null under the kill switch, and for a ledger a full pass wrote.
 */
export function partialGateReason(env = process.env) {
  if (!incrementalOn(env)) return null;
  const refusal = partialVisitRefusal(env);
  if (refusal === null) return null;
  const ledger = readGateReport()?.ledger;
  if (restsOnFull(ledger, manifestHashes(join(EMIT_TESTS_DIR, "emitted.json")), env)) return null;
  return (
    `the suite was last gated in part (${ledger.scope}, ${ledger.at}: ${ledger.why}) and ${refusal}, so cigate ` +
    "runs over the whole corpus before anything rests on it"
  );
}

/**
 * The quarantined rows whose entry is not about the recording the corpus holds.
 *
 * WHY THE TIMESTAMPS ABOVE CANNOT SEE IT (D33). A quarantine renders its row
 * `it.skip`, and before entries named the recording they judged
 * (record.mjs observationKey) nothing ever lifted one: assessment-service and
 * contact-ms (late September 2026) carried entries earned by recordings that
 * had since been replaced, and the suite was "already done" on top of them. A
 * resumed run that re-records nothing would never re-emit, so the step asks:
 * every entry for a row in `recorded.json` must name that row's observation.
 * A corpus emitted before the key names none, which re-emits it once.
 *
 * AND THE RENDERER INSTALLED NOW (config.mjs `emitterDigest`). A verdict is
 * about the test record.mjs drew, so an entry must also name the record.mjs
 * this step would run: a toolset replaced since the verdict - a resumed run on
 * a new image - re-emits once, and cigate judges the new template's test. That
 * is what lets a template fix reach a row that is already quarantined:
 * profile-centralized's Slack rows (September 2026) were held `it.skip` by
 * verdicts an older template earned, over a recording nothing re-records.
 *
 * AND A WITHHOLD THAT WAS ONLY A LOAD TIMEOUT (D90, vitestred.mjs
 * loadTimeoutWithhold): qode-ptp-ms 20260930T093551Z withheld 248 rows of one
 * spec for vitest's module-fetch timeout, over recordings that are intact. It
 * re-emits, and the next gate judges them.
 */
export function unboundQuarantine(renderer = emitterDigest()) {
  let entries;
  let recorded;
  try {
    entries = JSON.parse(readFileSync(resolve(SELF_REPO_ROOT, ".claude", "charpilot", "out", "quarantine.json"), "utf8")).rows ?? [];
    recorded = new Map(
      // In shards or one file (D57, recordedstore.mjs).
      (readRecorded(EMIT_TESTS_DIR).rows ?? []).map((r) => [r.id, r])
    );
  } catch {
    return [];
  }
  return entries
    .filter((q) => recorded.has(q?.id))
    .filter((q) => {
      // D90: a withhold for a spec that timed out loading re-emits, whatever it names.
      if (loadTimeoutWithhold(q)) return true;
      const now = recorded.get(q.id).observation ?? null;
      return now === null || q.observation !== now || (renderer !== null && q.emitter !== renderer);
    })
    .map((q) => q.id);
}

/** The pairs have to exist before they can be rendered into a suite. */
export function precondition(_repo) {
  const behaviour = recordedArtifact();
  if (!existsSync(behaviour)) {
    return `${here(behaviour)} is missing — record.mjs --emit-tests renders the recorded rows, so record them first`;
  }
  // `--emit-tests` DELETES the target's tests and re-renders from whatever this
  // artifact holds, and it renders the determinism verdict stamped on each row
  // (record.mjs:1949, record.mjs:1977). So a superseded recording is not
  // something to emit and then notice: emitting it replaces a real suite with
  // assertions about inputs that no longer exist, all of them wearing the
  // `do not hand-edit` header that makes them read as recorded. It refuses here
  // instead, and the fix is one step back rather than one step on.
  const repaired = supersededReason(behaviour);
  if (repaired) return `${repaired} Re-record and re-stamp before the suite is rendered from them.`;
  // D66. `--emit-tests` refuses a recording that does not account for every
  // runnable proposal, and leaves the delivered suite as it is. This is the
  // same question asked before it is spawned, off the same predicate `record`
  // answers `satisfied` from, so the walk never runs the tool into its own
  // refusal: `record` is ahead of this step and has already been asked, and a
  // recording it left unaccounted is its defect, written down there - this
  // step is BLOCKED behind it, not a second defect.
  const missing = unaccounted(behaviour);
  if (missing?.length) {
    return (
      `${missing.length} proposal(s) are in neither \`rows\` nor \`skipped\` of ${here(behaviour)} ` +
      `(${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}) — that recording was not taken from ` +
      "these proposals, and record.mjs --emit-tests refuses it rather than drop their tests; record them first"
    );
  }
  // D67. Nor a recording the environment failed: `record` names that as its
  // defect (steps/record.mjs `defects`) and `--emit-tests` refuses to shrink the
  // delivered suite on it. The same predicate, so this step is BLOCKED behind
  // record's defect rather than a second one, and it clears itself once the
  // environment is set up and record has recorded those rows again.
  const env = environmentDefectReason(behaviour);
  if (env) {
    return `${env}. record.mjs --emit-tests refuses to shrink the delivered suite on it, and ${EMIT_TESTS_REL} is left as it is`;
  }
  return null;
}

/** THE DISK: the manifest is there, and it is no older than the recording. */
export function satisfied(_repo) {
  return staleReason() === null;
}

/**
 * Run cigate.mjs, and when it withholds a row, re-emit (so the row renders as
 * `it.skip` with its error) and run it once more over the re-rendered suite.
 * Twice at most: a second pass that withholds more is recorded the same way;
 * nothing loops until green.
 *
 * A RED ROW ANOTHER TOOLSET RECORDED IS RECORDED AGAIN FIRST (item 6b). The
 * record cache no longer keys on the recorder's bytes, so a row recorded by an
 * older record.mjs is served for as long as its input, its code and the
 * OBSERVATION_VERSION hold - and the replay is what says whether that recording
 * still describes what these tools observe. So on the first red pass, the rows
 * `stale` names (their recording's `__recordedBy` is not the toolset installed
 * now) are recorded again (`record.mjs --rerecord`), observed a second time,
 * re-emitted, and judged by one more cigate pass; the rows it did not change,
 * and the rows this toolset had already recorded, are withheld exactly as
 * before. One re-record per walk, never a loop: a row still red after it is a
 * row these tools record red, and it is withheld with its error. Without that,
 * a recorder fix like D51's (NaN recorded as itself) would have left every row
 * it moved withheld over a recording nobody re-took.
 */
export function ciGate(did, run = runTool, read = readGateReport, env = process.env, stale = () => [], observations = recordedObservations, onWithhold = () => null) {
  const withheld = [];
  // Red cigate could hang on no row (vitest's unhandled errors with no test
  // named, a non-zero exit with no failure): the LAST pass's, because that is
  // the suite as delivered. Never withheld, never green.
  let defects = [];
  // THE FIRST PASS MAY BE PARTIAL, AND ONLY THE FIRST (incremental.mjs), and
  // only on a visit no report rests on. cigate.mjs decides from its own ledger
  // whether it can be; a second pass follows a withhold, and is full.
  const partialRefused = partialVisitRefusal(env);
  // Once cigate's red rows have been recorded again (item 6b), every pass that
  // judges them is full: the re-emit changed files the dirty set never saw.
  let rerecorded = false;
  // ITEM 3: after a withhold, a round walk gates again only the files that
  // were red (redFilesFor); null is a full pass, as before.
  let redFiles = null;
  for (let pass = 1; pass <= 2; pass += 1) {
    const g = run("cigate", redFiles ? ["--red-files", redFiles.join(",")] : pass === 1 && !rerecorded && partialRefused === null ? ["--incremental"] : []);
    if (g.line) did.push(g.line);
    if (!g.ok) {
      did.push("cigate could not run the repo's tests over the corpus - the suite is delivered unchecked, and said so");
      return { withheld, defect: { tool: "cigate.mjs", message: "cigate could not run the repo's own tests over the emitted suite", sides: [] } };
    }
    const report = read();
    if (report?.scope) {
      did.push(
        report.scope === "partial"
          ? `cigate: PARTIAL over ${report.gatedFiles.length} changed spec file(s) (${report.gatedFiles.join(", ")}) - ${report.scopeWhy}`
          : report.scope === "red-files"
          ? `cigate: RED FILES over ${report.gatedFiles.length} spec file(s) (${report.gatedFiles.join(", ")}) - ${report.scopeWhy}`
          : `cigate: ${report.scope} - ${report.scopeWhy}`
      );
    }
    defects = report?.pipelineDefects ?? [];
    // Said on every pass, never a defect: the config the corpus was gated
    // under when the repo's own runs none of it, and a coverage threshold that
    // is a number about the corpus alone (cigate.mjs exitReasonOf).
    for (const n of [...(report?.notes ?? []), ...(report?.measurements ?? [])]) did.push(`cigate: [${n.kind}] ${n.message}`);
    const now = report?.withheld ?? [];
    if (!now.length) break;
    // Item 1: the suite is about to be re-emitted, so a measurement of it
    // started beside this gate measures tests that will not exist.
    const stopped = onWithhold(`cigate withheld ${now.length} row(s)`);
    if (stopped) did.push(stopped);
    redFiles = redFilesFor(now, report, env);
    if (redFiles) did.push(`cigate: the next pass gates only the ${redFiles.length} spec file(s) this one found red - ${REGATE_RED_ENV}=off gates the whole corpus again`);
    if (!rerecorded) {
      rerecorded = true;
      const again = stale(now.map((w) => w.id));
      if (again.length) {
        const changed = rerecordRed(again, did, run, observations);
        if (changed !== null) {
          // What the re-record changed is judged again, by a pass that does
          // not count against the two; the rest is withheld as this pass found
          // it - the emit inside rerecordRed has already rendered those
          // `it.skip`, which is the job of the emit below.
          withheld.push(...now.filter((w) => !changed.has(w.id)));
          if (changed.size) pass -= 1;
          continue;
        }
      }
    }
    withheld.push(...now);
    const re = run("record", ["--emit-tests", EMIT_TESTS_REL]);
    if (re.line) did.push(`${re.line} (to withhold ${now.length} row(s) cigate found red)`);
  }
  if (!withheld.length && !defects.length) return { withheld, defect: null };
  const parts = [];
  if (withheld.length) {
    parts.push(
      `${withheld.length} emitted test(s) failed the repo's own CI and were withheld as it.skip with their error: ` +
        withheld.map((w) => `${w.id} [${w.gate}] ${w.message}`).join("; ")
    );
  }
  if (defects.length) {
    parts.push(
      `the repo's own CI is red for ${defects.length} reason(s) no row could be withheld for: ` +
        defects.map((d) => `[${d.kind}] ${d.message}`).join("; ")
    );
    did.push(`cigate: ${defects.length} pipeline_defect(s) left the suite red with no row to withhold - named, not green`);
  }
  const sides = [...new Set([...withheld, ...defects].flatMap((w) => w.sides ?? []))];
  // WHAT THE DEFECT IS MADE OF, as fields and not only as prose (D37). A
  // withhold costs exactly the sides its rows claim, so report.mjs can tell a
  // withhold whose every side is covered or ruled otherwise (it costs nothing,
  // and is a note) from a red suite no row explains (`suiteRed`, always a
  // failure). email-centralization-ms, September 2026: two rows withheld, both
  // sides already ruled unreachable, and the run ended `failed` "in 0 class(es)".
  return {
    withheld,
    defects,
    defect: {
      tool: "cigate.mjs",
      message: parts.join(". ").slice(0, 4000),
      sides,
      withheld: withheld.map((w) => w.id),
      suiteRed: defects.length,
    },
  };
}

/**
 * ITEM 3 - THE FILES A ROUND WALK GATES AGAIN AFTER A WITHHOLD, or null for a
 * full pass.
 *
 * qode-ptp-ms 20260930T033300Z: cigate ran its 414 spec files in full, found
 * one row red, withheld it, and ran all 414 again - and again after the next
 * withhold. The re-emit that renders a withheld row `it.skip` changes only
 * that row's file, and every other file was gated a moment ago beside the
 * whole corpus. So a round walk gates those files again, and nothing else.
 *
 * NEVER ON THE BANK WALK (CHARPILOT_BANK_WALK=1). Its report is the one
 * delivered, and its second pass stays the whole corpus in one process: a
 * file made red only by another file's change (D48, D52) is found there
 * before anything is reported. Nor when the pass was partial, when a withheld
 * row names no file, or with CHARPILOT_CIGATE_REGATE_RED=off, the kill switch.
 */
export const REGATE_RED_ENV = "CHARPILOT_CIGATE_REGATE_RED";
export function redFilesFor(withheld, report, env = process.env) {
  if (String(env[REGATE_RED_ENV] ?? "").trim().toLowerCase() === "off") return null;
  if (String(env[BANK_WALK_ENV] ?? "") === "1") return null;
  if (report?.scope === "partial") return null;
  if (!withheld.length || withheld.some((w) => !w?.file)) return null;
  return [...new Set(withheld.map((w) => w.file))].sort();
}

function readGateReport() {
  try {
    return JSON.parse(readFileSync(resolve(SELF_REPO_ROOT, ".claude", "charpilot", "out", "cigate.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The renderer recorded.json says drew the suite (config.mjs emitterDigest), or null. */
function recordedEmitter() {
  try {
    return JSON.parse(readFileSync(join(EMIT_TESTS_DIR, "recorded.json"), "utf8")).emitter ?? null;
  } catch {
    return null;
  }
}

/** Each emitted row's observation (record.mjs observationKey), by id, off recorded.json. */
export function recordedObservations() {
  try {
    // In shards or one file (D57, recordedstore.mjs); the emitter above is in the header either way.
    return new Map((readRecorded(EMIT_TESTS_DIR).rows ?? []).map((r) => [r.id, r.observation ?? null]));
  } catch {
    return new Map();
  }
}

/**
 * The toolset record.mjs would stamp a row with now, asked of record.mjs
 * itself (`--harness-version`), or null when it cannot say. The digest is a
 * function of that file, doubles.ts, the recording config and the flags the
 * walk runs it with - none - so it is asked rather than restated here.
 */
function currentHarness() {
  try {
    return execFileSync(process.execPath, [resolve(PILOT_DIR, "record.mjs"), "--harness-version"], {
      cwd: SELF_REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Of the rows cigate found red, the ones whose recording ANOTHER toolset made
 * (`__recordedBy`): the rows ciGate records again before it withholds them. A
 * row this toolset recorded is not in it - recording it again would observe
 * the same thing - and nor is anything when the incremental record is off
 * (config.mjs INCREMENTAL_RECORD), which withholds as before.
 */
export function staleRecordings(ids, artifact = recordedArtifact(), current = currentHarness) {
  if (!INCREMENTAL_RECORD || !ids.length) return [];
  let rows;
  try {
    rows = new Map((JSON.parse(readFileSync(artifact, "utf8")).rows ?? []).map((r) => [r.id, r]));
  } catch {
    return [];
  }
  const candidates = ids.filter((id) => rows.has(id));
  if (!candidates.length) return [];
  const now = current();
  if (!now) return [];
  return candidates.filter((id) => rows.get(id).__recordedBy !== now);
}

/**
 * Record `ids` again, stamp them, and render the suite from what was recorded.
 * Returns the ids whose observation moved - the rows the next cigate pass has
 * to judge - or null when a step of it failed, in which case every red row is
 * withheld as it was found and the failing tool's line says why.
 */
function rerecordRed(ids, did, run, observations) {
  const before = observations();
  const rec = run("record", ["--rerecord", ids.join(",")]);
  if (rec.line) did.push(`${rec.line.replace(/--rerecord \S+/, `--rerecord <${ids.length} id(s)>`)} (to record again ${ids.length} row(s) cigate found red whose recording another toolset made)`);
  if (!rec.ok) return null;
  const artifact = recordedArtifact();
  // The policy the recording was taken under, as the determinism step reads it
  // (steps/determinism.mjs recordedPolicy) - restated rather than imported, so
  // this step loads without that one beside it.
  let policy = null;
  try {
    policy = JSON.parse(readFileSync(artifact, "utf8")).selection?.policy ?? null;
  } catch {
    policy = null;
  }
  const det = run("determinism", [...(mode().live ? ["--live"] : []), ...(policy ? ["--policy", policy] : []), "--write"]);
  if (det.line) did.push(`${det.line} (the rows recorded again, observed a second time)`);
  if (!det.ok) return null;
  const em = run("record", ["--emit-tests", EMIT_TESTS_REL]);
  if (em.line) did.push(`${em.line} (the suite rendered from the rows recorded again)`);
  if (!em.ok) return null;
  const after = observations();
  const changed = new Set(ids.filter((id) => after.has(id) && after.get(id) !== before.get(id)));
  did.push(
    `${changed.size} of ${ids.length} row(s) recorded again observe something else under these tools and are judged again; ` +
      `${ids.length - changed.size} observe what they did, so they stay withheld with the error cigate gave`
  );
  return changed;
}

export function run(_repo) {
  const did = [];

  // The output directory, and nothing else. See the docblock: any other flag
  // on this command line is a flag on record.mjs.
  const before = manifestHashes(EMITTED_JSON);
  const emitted = runTool("record", ["--emit-tests", EMIT_TESTS_REL]);
  if (emitted.line) did.push(emitted.line);
  if (!emitted.ok) return { did, pending: [], metrics: {} };

  if (existsSync(EMITTED_JSON)) did.push(`wrote ${here(EMITTED_JSON)} and ${renderedSpecs().length} *.test.ts beside it`);

  // THE DIRTY SET, AS BYTES (incremental.mjs): which spec files this emission
  // changed, from emitted.json's own per-file hashes before and after it. Not
  // written under the kill switch, which is today's walk exactly.
  const after = incrementalOn() ? manifestHashes(EMITTED_JSON) : null;
  if (after) {
    const diff = specDiff(before?.hashes ?? {}, after.hashes);
    writeDirty({ specs: { from: before?.digest ?? null, to: after.digest, ...diff } });
    did.push(
      `dirty: ${diff.changed.length} spec file(s) changed, ${diff.added.length} added, ${diff.removed.length} removed, ` +
        `${diff.unchanged} byte-identical to the last emission${before ? "" : " (no earlier emitted.json to diff against)"}`
    );
  }

  // AFTER the emission, never before: the question is whether the files on disk
  // now are the ones this run just wrote.
  const integrity = runTool("emitted-integrity");
  if (integrity.line) did.push(integrity.line);

  // ITEM 1: `measure` starts now, beside the gate, and is kept if the gate
  // withholds nothing (steps/earlymeasure.mjs).
  const started = earlyMeasure.start(_repo, manifestHashes(EMITTED_JSON)?.digest ?? null);
  if (started) did.push(started);

  // THE REPO'S OWN CI, OVER WHAT WAS JUST EMITTED - the last resort (cigate.mjs).
  // A test that fails there is withheld as `it.skip` with its error, re-emitted,
  // and handed to the walk as a pipeline_defect, so the run is `failed` with its
  // numbers and the pull request names every withheld row. Never a refusal.
  const gate = ciGate(did, runTool, readGateReport, process.env, staleRecordings, recordedObservations, (why) => earlyMeasure.stop(why));
  if (gate.defect) {
    const check = runTool("cicheck", ["--write"]);
    if (check.line) did.push(check.line);
    return { did, pending: [], metrics: { ciGateWithheld: gate.withheld.length }, defect: gate.defect };
  }

  // THE CHECK THAT RUNS WHAT WAS JUST EMITTED.
  //
  // Here and not at install: the workflow runs `npm run test:characterization`,
  // and vitest exits 1 on a directory with no spec in it. Written at install
  // time it would be a RED check on every repo that has the toolset and has not
  // emitted yet. Written here it lands in the same commit as the corpus it
  // runs, which is the only state in which it is true.
  //
  // It refuses rather than inventing CI - see cicheck.mjs - and a refusal is a
  // written reason on this step's own `did`, so the run says plainly that the
  // corpus is uncovered instead of leaving a green check to say otherwise.
  const check = runTool("cicheck", ["--write"]);
  if (check.line) did.push(check.line);

  const stale = staleReason();
  if (stale) did.push(stale);

  return { did, pending: [], metrics: {} };
}
