#!/usr/bin/env node
/**
 * checkrow — a worker checks ONE row it has written, inside its own turn.
 *
 *   node .claude/charpilot/checkrow.mjs <answers-file> <row-id>
 *
 * PLAN 20, T2.4, ON BY DEFAULT since the nginx A/B (run 20260924T091852Z); CHARPILOT_INROUND_VERIFY=off is the
 * rollback. The one tool a stage-3 worker is allowed to run.
 *
 * WHY. A row whose input does not reach the side it claims is found at the next
 * round boundary, and fixing it costs a whole round (8-30 minutes in the tail).
 * The boundary already knows every row's verdict, so what this buys is not
 * earlier detection: it is the FIX ITERATION happening inside the worker's turn,
 * from the same context, instead of across rounds.
 *
 * WHAT IT DOES. Copies the proposals directory to a scratch directory, puts this
 * answers file's row in it, runs `validate.mjs` and then `record.mjs --only
 * <id>` against the scratch copy (CHARPILOT_PROPOSALS_DIR) with the recording
 * sent to a scratch artifact (CHARPILOT_OUTPUT) -- the pair `verifyOnWrite`
 * already uses at the boundary -- and prints the verdict as JSON.
 *
 * WHAT IT MAY NOT DO, and doesn't: advance any state. Nothing is written to
 * out/'s artifacts, proposals/ or test/. That is the property CHECKPOINT
 * requires of anything that is allowed to check before submitting.
 *
 * THE RULES IT ENFORCES:
 *   - only a row with a `reaches` claim is checked (the plan's rule);
 *   - each check is time-boxed (CHARPILOT_INROUND_VERIFY_SECONDS, default 120);
 *     a timeout is "not verified", never "false";
 *   - at most CHARPILOT_INROUND_VERIFY_SLOTS (default 2) run at once on this
 *     machine, by lock files: fifteen workers each booting vitest at once is a
 *     real memory risk on a 16 GB host.
 *
 * Exit 0 with a verdict printed; exit 2 when it refuses (flag off, no such row,
 * no claim, no slot in time). It never exits non-zero because the ROW failed:
 * a failed row is a verdict, and the verdict is the output.
 */
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFaults } from "./steps/derive.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const checkrowOn = (env = process.env) => env.CHARPILOT_INROUND_VERIFY !== "off";
const positive = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Take one of the machine-wide slots, waiting up to `waitMs`. Returns a release function or null. */
export function takeSlot({ slots = 2, waitMs = 120_000, dir = join(tmpdir(), "charpilot-checkrow-slots"), now = Date.now } = {}) {
  mkdirSync(dir, { recursive: true });
  const deadline = now() + waitMs;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const path = join(dir, `slot-${i}`);
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => rmSync(path, { force: true });
      } catch {
        // Held. A holder that died leaves its file: free it when its pid is gone.
        try {
          const pid = Number(readFileSync(path, "utf8"));
          if (pid && pid !== process.pid) process.kill(pid, 0);
        } catch (err) {
          if (err?.code === "ESRCH") rmSync(path, { force: true });
        }
      }
    }
    if (now() >= deadline) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}

/**
 * THIS ROW'S FAULTS, WARNINGS INCLUDED, read with the parser the round boundary
 * uses (`validateFaults`), so the two can never disagree about what a line
 * says.
 *
 * WARNINGS COUNT. The first cut kept only lines matching /✗|error|fault/, and
 * validate.mjs prints "no answer declared for boundary ..." as a `!` warning,
 * so run 20260924T074107Z's workers checked rows like `error-141-if-0` here,
 * were told nothing was wrong, and had them quarantined at the boundary: when
 * validate exits non-zero -- because of ANY row in the directory -- derive
 * quarantines every row that carries a fault of either severity. A check that
 * passes on a row the boundary sets aside is worse than no check.
 *
 * Matched by id (the address validate prints in parentheses), or by file: the
 * scratch copy of this answers file holds this one row and nothing else, so a
 * fault that names the file is about the row whatever index it prints.
 */
export function rowFaults(faults, rowId, fileName) {
  return faults.filter((f) => f.proposal === rowId || (f.file && basename(f.file) === fileName));
}

const QUARANTINE_SAYS =
  "The round boundary quarantines a row with ANY of these, warnings (!) included, whenever validate.mjs exits " +
  "non-zero for any row in the directory. Fix every one before you submit.";

function refuse(why) {
  process.stdout.write(`${JSON.stringify({ checked: false, why }, null, 2)}\n`);
  return 2;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  if (!checkrowOn(env)) return refuse("in-round checking is off (CHARPILOT_INROUND_VERIFY is not \"on\"); submit and let the round boundary judge the row");
  const [answersArg, rowId] = argv;
  if (!answersArg || !rowId) return refuse("usage: checkrow.mjs <answers-file> <row-id>");
  const repo = process.cwd();
  const answersPath = resolve(repo, answersArg);
  let doc;
  try {
    doc = JSON.parse(readFileSync(answersPath, "utf8"));
  } catch (err) {
    return refuse(`${answersArg} is not readable JSON: ${err.message}`);
  }
  const row = (doc?.proposals ?? []).find((r) => r?.id === rowId);
  if (!row) return refuse(`${answersArg} has no proposal row with id "${rowId}"`);
  if (!row.reaches || !Object.keys(row.reaches).length) return refuse(`row "${rowId}" makes no \`reaches\` claim, and only a claim can be checked`);

  const release = takeSlot({ slots: positive(env.CHARPILOT_INROUND_VERIFY_SLOTS, 2) });
  if (!release) return refuse("no check slot came free within 120 s; submit and let the round boundary judge the row");
  const scratch = mkdtempSync(join(tmpdir(), "charpilot-checkrow-"));
  try {
    const proposals = join(scratch, "proposals");
    const real = join(repo, ".claude", "charpilot", "proposals");
    if (existsSync(real)) cpSync(real, proposals, { recursive: true });
    else mkdirSync(proposals, { recursive: true });
    writeFileSync(join(proposals, basename(answersPath)), `${JSON.stringify({ ...doc, proposals: [row] }, null, 2)}\n`);
    const artifact = join(scratch, "behaviour-check.json");
    const childEnv = { ...env, CHARPILOT_PROPOSALS_DIR: proposals, CHARPILOT_OUTPUT: artifact };
    const timeout = positive(env.CHARPILOT_INROUND_VERIFY_SECONDS, 120) * 1000;

    const validate = spawnSync(process.execPath, [join(HERE, "validate.mjs")], { cwd: repo, env: childEnv, encoding: "utf8", timeout });
    const faults = rowFaults(validateFaults(validate), rowId, basename(answersPath));
    const out = {
      checked: true, row: rowId,
      validate: {
        ok: !faults.length,
        faults: faults.slice(0, 10).map((f) => `${f.severity === "error" ? "✗" : "!"} ${f.line}`),
        ...(faults.length ? { says: QUARANTINE_SAYS } : {}),
      },
    };

    const record = spawnSync(process.execPath, [join(HERE, "record.mjs"), "--only", rowId], { cwd: repo, env: childEnv, encoding: "utf8", timeout });
    if (record.error?.code === "ETIMEDOUT" || record.signal) {
      out.record = { verdict: "not verified", why: `timed out after ${timeout / 1000} s` };
    } else if (!existsSync(artifact)) {
      out.record = { verdict: "not verified", why: `record.mjs exited ${record.status} and wrote nothing: ${String(record.stderr ?? "").split("\n").filter(Boolean).slice(-3).join(" | ")}` };
    } else {
      const recorded = JSON.parse(readFileSync(artifact, "utf8"));
      const r = (recorded?.rows ?? []).find((x) => x?.id === rowId) ?? null;
      const skipped = (recorded?.skipped ?? []).find((x) => x?.id === rowId) ?? null;
      out.record = !r && skipped
        ? { verdict: "skipped", why: skipped.reason ?? "the recorder skipped the row and gave no reason" }
        : r
        ? { invoked: r.invoked ?? null, claims: (r.claimVerdicts ?? []).map((v) => ({ arm: v.arm, side: v.side, verdict: v.verdict, why: v.why })),
            armsMoved: r.armsMoved ?? [], harnessError: r.harnessError?.message ?? null }
        : { verdict: "not verified", why: "the recording has no row with this id" };
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } finally {
    release();
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  process.exitCode = main();
}
