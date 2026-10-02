/**
 * baseline — the existing suite green, and its istanbul coverage recorded as
 * the denominator every later number is quoted against.
 *
 * WHAT `satisfied` ASKS, and why "the file exists" is the wrong question.
 * baseline.mjs writes out/baseline.json TWICE. The second write, at
 * baseline.mjs:589, is the real one and carries `coverage`. The first, at
 * baseline.mjs:542, happens when the suite is RED: it records the environment,
 * the install and the failures, has no `coverage` key at all, and then exits 1.
 *
 * So a step that asked only whether the file is there would report a red suite
 * as a finished baseline, skip it on the next run, and let every later stage
 * quote a denominator that is not in the file. The artifact has to carry the
 * denominator, which is the predicate steps/index.mjs already writes down.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { BASELINE_JSON, COVERAGE_DIR, REPO_ROOT, SCAN_JSON, SELF_REPO_ROOT, WORKLIST_JSON } from "../config.mjs";
import { check as freshnessOf } from "../freshness.mjs";
import { placeholderRowsAreStale } from "../prismaclient.mjs";
import { here, runTool } from "./preflight.mjs";
import { scanDone as scanCurrent } from "./scan.mjs";
import { satisfied as worklistCurrent } from "./worklist.mjs";

export const NAME = "baseline";

/**
 * baseline.mjs spawns node_modules/vitest/vitest.mjs in the target. Without it
 * the tool fails inside a spawn, several frames from the thing that is actually
 * wrong, so it is named here instead — the same check install.sh makes before
 * it copies anything.
 */
export function precondition(_repo) {
  const vitest = resolve(SELF_REPO_ROOT, "node_modules", "vitest");
  if (!existsSync(vitest)) {
    return `vitest is not installed at ${vitest} — baseline.mjs runs the suite through it, so install the repo's own dependencies first (npm ci)`;
  }
  return null;
}

/** THE DISK: the baseline exists AND carries the coverage it is quoted for. */
/** A worklist.json is on disk and the walk will rebuild it: the scan is not current, or the brief predates it. */
function briefToRebuild() {
  if (!existsSync(WORKLIST_JSON)) return false;
  if (existsSync(SCAN_JSON) && !scanCurrent()) return true;
  return !worklistCurrent();
}

export function satisfied(_repo) {
  if (!existsSync(BASELINE_JSON)) return false;
  // FRESH, not merely present. freshness.mjs already tracks this artifact by
  // name and stage, already reads `environment.gitSha`, and its own doc says to
  // call it "at the top of any stage that reads an artifact it did not just
  // produce" — but only gate.mjs did, which is several rounds too late. Run
  // 20260918T040720Z answered `already done` from a baseline recorded
  // 2026-09-08 against a checkout at a three-week-newer commit, and every
  // number downstream of it described neither.
  if (freshnessOf("baseline.json").state !== "fresh") return false;
  // D61: THE COUNTERS THE MEASUREMENT WROTE, not only the document about them.
  // coverage-charpilot/ is not checkpointed, so a run resumed at the same HEAD
  // in a fresh container read baseline.json as done and had no
  // coverage-final.json - harmless while the scan was never re-run, and fatal
  // once a changed scan.mjs re-scans (D61): worklist.mjs cannot rebuild the
  // brief without it (`worklist: BLOCKED — coverage-charpilot/coverage-final.json
  // is missing`), the walk carried on with the brief of the OLD scan, and the
  // sides D60 re-opened were dealt with the old, unresolved vias. Measured on
  // the sourcing-ms checkpoint of run 20260926T222646Z. ONLY when a brief on
  // disk is about to be rebuilt - the scan re-scans or the brief is older than
  // it - so a walk that rebuilds nothing never pays for a suite run to get
  // counters nothing will read.
  if (briefToRebuild() && !existsSync(join(COVERAGE_DIR, "coverage-final.json"))) return false;
  try {
    const baseline = JSON.parse(readFileSync(BASELINE_JSON, "utf8"));
    // A suite measured over Prisma's placeholder client, which generate could
    // not replace then and something has replaced since (D42), measured a
    // client that is no longer here: it is taken again.
    if (baseline.prismaGenerate?.placeholder && !baseline.prismaGenerate.ok && placeholderRowsAreStale(REPO_ROOT)) return false;
    // AND THE REPORT IT MEASURED, whatever the brief (D57). D61 above asks for
    // it only when a brief is about to be rebuilt, but measure reads it every
    // walk: coverage.mjs counts a side the repo's own suite hits from it
    // (`hitByEither`). qode-ptp-ms, resumed onto the commit its baseline was
    // taken at with no coverage-charpilot/: `already done`, and measure
    // reported 6,644 sides hit where the same suites had hit 13,027. The
    // checkpoint carries the report now (checkpoint.BASELINE_REPORTS), so a
    // resume from one pays for no suite run; one from an older checkpoint does.
    return Boolean(baseline.coverage?.totals) && existsSync(join(COVERAGE_DIR, "coverage-final.json"));
  } catch {
    return false;
  }
}

/**
 * The suite verdict baseline.mjs recorded, or null when there is not one to
 * read.
 *
 * baseline.mjs:557 writes this document and exits 1 when the suite is red, so
 * the failures are ALREADY ON DISK by the time this step is asked — the whole
 * list of failing files, counted separately from failing tests because a file
 * that fails to COLLECT runs no test at all (baseline.mjs:248-252). Read rather
 * than re-run: a second vitest invocation here would be a second account of the
 * same suite, and the expensive one.
 */
export function suiteVerdict() {
  if (!existsSync(BASELINE_JSON)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_JSON, "utf8")).suite ?? null;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * A RED SUITE IS A QUESTION, AND THIS STEP USED TO ANSWER IT WITH SILENCE.
 *
 * WHAT IT USED TO DO. `run` was `runTools(["baseline"], BASELINE_JSON)` and
 * nothing else. On a red suite baseline.mjs writes the document WITHOUT a
 * `coverage` key and exits 1, so `satisfied` — which demands
 * `baseline.coverage?.totals` — is false, and stays false however many times
 * the step runs: re-running the suite does not make a failing test pass. The
 * walk's refusal is then `baseline ran (baseline.mjs exited 1 — <the last four
 * lines of stderr>) and is still not satisfied`, at ORDER[2], with nothing on
 * disk for anybody to answer.
 *
 * WHAT IT COSTS. The stderr tail is four lines (`steps/preflight.mjs:tail`), so
 * a suite with nine failing files reports whichever few fitted, and the list
 * that IS complete — `suite.failures`, every failing file by path — sits in
 * out/baseline.json unread. Nothing in the run says which tests fail, and the
 * whole pipeline is behind this step.
 *
 * `notification-ms` is exactly this shape and it is why the item carries the
 * sentence it does: its suite is green only once its local `.env` is moved
 * aside, because vitest auto-loads that file and the one test that deletes
 * `process.env.DATABASE_URL` then finds it restored. That is a thirty-second
 * fix by an answering turn and an unrecoverable run without one.
 *
 * A PENDING ITEM AND NOT A PRECONDITION, and the two were both available. A
 * precondition refusal is for an inconsistency NOBODY can answer — "the scan
 * says 0 functions and the baseline says 367 branches" — and it writes no
 * worklist, deliberately, because there is nothing in it to answer. A red suite
 * is the opposite: it is a concrete, named, ordinary defect in the target, and
 * an agent turn fixes it, quarantines it, or writes down why the baseline
 * cannot be taken. Refusing where a question would do throws away the one turn
 * that could have cleared it.
 *
 * NOT `OPTIONAL` EITHER, and that is the stronger argument against the third
 * option. This artifact is the DENOMINATOR every later number is quoted
 * against. A walk that carried on without it would measure a rate against
 * nothing and report it, which is the class of defect freshness.mjs's own
 * header is about.
 * ------------------------------------------------------------------------ */
export function pendingFor(suite, { measured = false } = {}) {
  // A red suite WITH its coverage recorded is a note, not a question (tool
  // backlog: qode-backend) - baseline.mjs takes the denominator from the suite
  // as it stands and the run goes on. Only a red suite that left no coverage
  // report still has nothing to quote, and that is still asked.
  if (suite?.state !== "red" || measured) return [];
  // OURS IS NOT A QUESTION FOR THE REPO. A suite red because of charpilot's
  // config or files (redsuite.mjs) is a pipeline defect, written by run().
  if (suite.owner === "pipeline") return [];
  const collected = suite.failed === 0 && suite.failedFiles > 0;
  return [
    {
      // OVER THE FAILING FILES, so a round that fixed two of three asks a
      // different question rather than repeating itself — and `writeWorklist`'s
      // repeat detector can tell a stalled loop from a shrinking one.
      id: `baseline:red:${[...(suite.failures ?? [])].sort().join("|") || suite.failedFiles}`,
      kind: "baseline",
      question:
        `the target's EXISTING suite is red — ${suite.failed} failing test(s) in ${suite.failedFiles} file(s) — so ` +
        `there is no denominator to quote anything against. Make it green, or record why it cannot be.`,
      context: {
        // NAMED, ALL OF THEM. This is the list the run never printed: the
        // tool's stderr reaches the walk as a four-line tail, and a suite with
        // nine failing files loses most of it.
        failingFiles: suite.failures ?? [],
        failedTests: suite.failed,
        failedFiles: suite.failedFiles,
        durationSeconds: suite.durationSeconds ?? null,
        ...(collected
          ? {
              readThisFirst:
                "0 failing TESTS with a failing FILE means the file never COLLECTED: an import-time error, not an " +
                "assertion. A generated client is the usual cause (npx prisma generate) — an ungenerated enum reads " +
                "as undefined at module scope and takes the whole file down before a test runs.",
            }
          : {}),
        says:
          "This is the repo's OWN suite, not anything charpilot wrote, and out/baseline.json is written from it as " +
          "the denominator every later percentage is quoted against — so nothing downstream can be measured until " +
          "it is green. Re-running this step cannot change it: a failing test fails again. " +
          "CHECK THE ENVIRONMENT BEFORE THE TESTS. notification-ms's suite is green only once its local `.env` is " +
          "moved aside, because vitest auto-loads that file and the test that deletes `process.env.DATABASE_URL` " +
          "then finds it restored — a failure of the harness that reads exactly like a failure of the service. " +
          "If a test is genuinely broken and not yours to fix, quarantine it and say so; do not weaken an assertion " +
          "to make this pass, because the suite is the thing the denominator is taken from.",
      },
    },
  ];
}

/**
 * THE NOTES (tool backlog): which runner this baseline measured, and a red
 * suite that did not stop the run. Neither loses a side; report.mjs lists them
 * under notes[] without letting them decide the status.
 */
export function notes(_repo) {
  // ONLY A BASELINE THAT DESCRIBES THIS TREE, as `defects` below. The walk asks
  // for notes BEFORE the step runs, so a stale baseline a resume carried in was
  // noted as this run's: qode-ptp-ms, late September 2026, logged the previous
  // container's "RED ... 939 failing test(s)" (taken over a placeholder Prisma
  // client) as a NOTE, then re-ran the baseline green 2274/2274.
  if (!satisfied(_repo)) return [];
  let b;
  try {
    b = JSON.parse(readFileSync(BASELINE_JSON, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  if (b.runner?.note) {
    out.push({ id: `baseline:runner:${b.runner.runner}:${b.runner.action}`, tool: "runner.mjs", message: b.runner.note });
  }
  if (b.suite?.state === "red" && b.coverage?.totals && b.suite.owner !== "pipeline") {
    out.push({
      id: `baseline:red:${[...(b.suite.failures ?? [])].sort().join("|") || b.suite.failedFiles}`,
      tool: "baseline.mjs",
      message: b.suite.note ?? `the repo's own suite is red: ${b.suite.failed} failing test(s); the baseline is its coverage as it stands`,
    });
  }
  return out;
}

/**
 * RED BECAUSE OF CHARPILOT, for as long as the recorded baseline says so
 * (redsuite.mjs). Asked on every visit; only when the step is satisfied,
 * because an unsatisfied step runs and `run` returns the same defect itself.
 */
export function defects(repo) {
  if (!satisfied(repo)) return [];
  const suite = suiteVerdict();
  if (suite?.state !== "red" || suite.owner !== "pipeline") return [];
  return [{ tool: "baseline.mjs", exit: null, message: suite.pipelineDefect ?? "the repo's own suite is red because of charpilot's config or files" }];
}

export function run(_repo) {
  const did = [];
  const outcome = runTool("baseline");
  if (outcome.line) did.push(outcome.line);
  // Named from the disk rather than from the tool's claim to have written it,
  // which is the same rule `satisfied` follows one function up.
  if (outcome.ok && existsSync(BASELINE_JSON)) did.push(`wrote ${here(BASELINE_JSON)}`);

  const suite = suiteVerdict();
  // RED BECAUSE OF US (redsuite.mjs): a pipeline defect, never a note and
  // never a question for the repo. The walk writes it to out/defects.json and
  // goes on; report.mjs then cannot call the run a success.
  if (suite?.state === "red" && suite.owner === "pipeline") {
    const message = suite.pipelineDefect ?? `the repo's own suite is red because of charpilot's config or files`;
    did.push(`the existing suite is RED because of charpilot, not the repo: ${message}`);
    return { did, pending: [], metrics: {}, defect: { tool: "baseline.mjs", exit: null, message } };
  }
  const pending = pendingFor(suite, { measured: satisfied(_repo) });
  if (pending.length) {
    did.push(
      `the existing suite is RED: ${suite.failed} failing test(s) in ${suite.failedFiles} file(s) — ` +
        `${(suite.failures ?? []).join(", ") || "no file named"}. ` +
        `That is handed over rather than refused: re-running the suite does not make a failing test pass.`
    );
  }
  return { did, pending, metrics: {} };
}
