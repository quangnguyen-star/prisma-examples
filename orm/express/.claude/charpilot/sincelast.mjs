#!/usr/bin/env node
/**
 * sincelast — what the last recording still answers, and what a feature moved.
 *
 *   node .claude/charpilot/sincelast.mjs            report
 *   node .claude/charpilot/sincelast.mjs --json
 *   node .claude/charpilot/sincelast.mjs --against <sha>   override the stamp
 *
 * WHY. Stage 3 is 97% of a run's clock - 7,614s of 7,749s on notification-ms,
 * 13,550s of 14,010s on pricing-ms, all of it agent turns against the gateway -
 * and a second run of the same service repeats every second of it. Not because
 * the work is needed twice, but because nothing from the first run survives:
 * the proposals live under `.claude/`, which targets gitignore, so 0 of 56
 * reached the branch of run `20260921T184935Z`.
 *
 * `recorded.json` fixes the surviving half. This is the reading half: given the
 * commit that recording was taken against, it asks git what changed since, and
 * partitions the corpus into what a new run must redo and what it can leave
 * alone.
 *
 * KEYED ON `stableId`, NEVER ON A LINE. `scan.mjs` mints one per arm over the
 * enclosing function's name, the arm kind, the arm's own source text and its
 * ordinal among identical arms. So a reformat, a comment, a moved function or a
 * moved test changes nothing here, while an arm whose code actually changed
 * gets a new id and is correctly treated as unanswered.
 *
 * TWO POLICIES, AND IT REPORTS BOTH RATHER THAN CHOOSING FOR YOU.
 *
 *   file    a row is stale if ANY file it covers changed. Conservative: the arm
 *           may be identical while the function around it decides differently,
 *           so the input that used to reach it may not any more.
 *   arm     a row is stale only if one of its own arms changed identity.
 *           Cheaper, and wrong exactly when a caller's edit redirects control
 *           flow around an untouched arm.
 *
 * The gap between the two numbers is the size of the bet. Nothing here acts on
 * it: this tool reads and reports, and `derive` decides what to re-ask.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { CORPUS_REL, OUT_DIR, REPO_ROOT } from "./config.mjs";
import { readRecorded } from "./recordedstore.mjs";

const ARGV = process.argv.slice(2);
const JSON_OUT = ARGV.includes("--json");
const AGAINST = ARGV.includes("--against") ? ARGV[ARGV.indexOf("--against") + 1] : null;
const CORPUS = process.env.CHARPILOT_SPECS ?? CORPUS_REL;
const SINCE_JSON = join(OUT_DIR, "since-last.json");

/** Files that differ between two commits, or a written reason. */
export function changedFiles(fromSha, toSha = "HEAD", run = gitDiff) {
  if (!fromSha) return { reason: "the recording carries no commit, so there is nothing to diff against" };
  try {
    const out = run(fromSha, toSha);
    return { files: out.split("\n").map((l) => l.trim()).filter(Boolean) };
  } catch (exc) {
    // A sha the clone does not have is the ordinary case for a shallow CI
    // checkout, and it is not a defect in the recording.
    return { reason: `git could not diff ${fromSha}..${toSha}: ${String(exc.message ?? exc).split("\n")[0]}` };
  }
}

function gitDiff(fromSha, toSha) {
  return execFileSync("git", ["diff", "--name-only", `${fromSha}`, toSha], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The corpus split three ways.
 *
 * `gone` is separated from `redo` deliberately: a row whose arm no longer
 * exists is not a row to re-derive, it is a row to DELETE, and conflating the
 * two is how a suite grows tests for code nobody has.
 */
export function partition(recorded, changed, ledger) {
  const live = new Set(Object.keys(ledger?.byStableId ?? {}));
  const touched = new Set(changed);
  const valid = [];
  const redoByFile = [];
  const redoByArm = [];
  const gone = [];

  for (const row of recorded.rows ?? []) {
    const ids = row.stableIds ?? [];
    const files = [...new Set((row.armIds ?? []).map((a) => String(a).split("#")[0]))];
    // An arm whose stableId has no successor: its own source text changed, or
    // it is gone. `armids.mjs` refuses to guess at this point and so does this.
    if (ids.length && ids.some((id) => id && !live.has(id))) {
      gone.push({ id: row.id, stableIds: ids, files });
      continue;
    }
    const fileMoved = files.some((f) => touched.has(f));
    if (fileMoved) redoByFile.push({ id: row.id, files });
    else valid.push({ id: row.id, files });
    // Under the `arm` policy an identical arm is answered whatever its file
    // did, so this list is only ever the `gone` rows - kept explicit so the
    // two policies can be counted side by side.
  }
  return { valid, redoByFile, redoByArm, gone };
}

function main() {
  const recordedPath = join(REPO_ROOT, CORPUS, "recorded.json");
  if (!existsSync(recordedPath)) {
    const msg =
      `no recording at ${relative(REPO_ROOT, recordedPath)} - nothing from a previous run to reuse.\n` +
      `  This file is written by \`record.mjs --emit-tests\`. A corpus committed before it existed does not carry one,\n` +
      `  and a run against such a branch has to derive every side from nothing.`;
    const doc = { state: "no-recording", reason: msg };
    writeFileSync(SINCE_JSON, `${JSON.stringify(doc, null, 2)}\n`);
    if (JSON_OUT) process.stdout.write(`${JSON.stringify(doc)}\n`);
    else process.stdout.write(`· ${msg}\n`);
    return;
  }
  // In shards or one file (D57, recordedstore.mjs): the index is what `existsSync` asked about.
  const recorded = readRecorded(dirname(recordedPath));
  const from = AGAINST ?? recorded.recordedAgainst?.gitSha ?? null;
  const diff = changedFiles(from);

  let ledger = null;
  try {
    ledger = JSON.parse(readFileSync(join(OUT_DIR, "armids.json"), "utf8"));
  } catch {
    ledger = null;
  }

  if (diff.reason || !ledger) {
    const reason = diff.reason ?? "no out/armids.json - run the scan first, or a stale arm cannot be told from a moved one";
    const doc = { state: "unanswerable", reason, recordedAgainst: recorded.recordedAgainst };
    writeFileSync(SINCE_JSON, `${JSON.stringify(doc, null, 2)}\n`);
    if (JSON_OUT) process.stdout.write(`${JSON.stringify(doc)}\n`);
    else process.stdout.write(`! ${reason}\n  Every row must be treated as unanswered.\n`);
    return;
  }

  const p = partition(recorded, diff.files, ledger);
  const total = (recorded.rows ?? []).length;
  const doc = {
    state: "answered",
    recordedAgainst: recorded.recordedAgainst,
    head: from,
    changedFiles: diff.files.length,
    totals: {
      rows: total,
      valid: p.valid.length,
      redoByFile: p.redoByFile.length,
      gone: p.gone.length,
    },
    ...p,
  };
  // WRITTEN EVERY TIME, in every state. The walk's `worklist` step reads this
  // to put the counts in front of the agent, and a reader that has to infer
  // "absent means it could not answer" is a reader that will infer it wrongly.
  writeFileSync(SINCE_JSON, `${JSON.stringify(doc, null, 2)}\n`);
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  const dirty = recorded.recordedAgainst?.gitDirty
    ? " (recorded against a DIRTY tree, so no sha names exactly what it saw)"
    : "";
  process.stdout.write(
    `· recorded against ${String(from).slice(0, 7)}${dirty}\n` +
      `  ${diff.files.length} file(s) changed since\n` +
      `  ${total} recorded row(s):\n` +
      `    ${p.valid.length} still answered - the files they cover did not change\n` +
      `    ${p.redoByFile.length} in a changed file - conservative: re-derive\n` +
      `    ${p.gone.length} whose arm no longer exists - DELETE, not re-derive\n` +
      (p.gone.length
        ? `\n  arms that are gone:\n` +
          p.gone.slice(0, 10).map((g) => `      ${g.id}  ${g.stableIds.join(", ")}`).join("\n") +
          (p.gone.length > 10 ? `\n      … ${p.gone.length - 10} more` : "") +
          "\n"
        : "")
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
