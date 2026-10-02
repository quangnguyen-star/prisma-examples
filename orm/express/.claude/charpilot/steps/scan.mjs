/**
 * scan — the ts-morph arm model, and the arm-id ledger that makes every later
 * reference to an arm survive an edit above it.
 *
 * TWO TOOLS, because the scan is only half of the step. `scan.mjs` writes
 * out/scan.json and mints the ledger beside it (scan.mjs:1024-1071);
 * `armids.mjs` is what then says whether anything still points at an arm that
 * no longer exists. Skipping the second half is not free: an `armId` is
 * `file#line:kind:index`, so a one-line comment remapped 1,747 references in a
 * single measured session, and a reference to a moved arm reads exactly like a
 * reference to a covered one.
 *
 * WHAT `satisfied` ASKS. The scan is done when out/scan.json is on disk AND the
 * ledger accounts for every arm that file names. Both sides are read from the
 * two artifacts themselves — no state file, no "the scan ran" flag — so a
 * ledger left behind by an earlier scan of a different tree cannot be mistaken
 * for this one's. That case is real: a location-ms scan once cut this repo's
 * shared ledger from 1301 arms to 413.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { IS_FOREIGN_TARGET, OUT_DIR, REPO_ROOT, SCAN_JSON, SELF_REPO_ROOT, TSCONFIG, WORKLIST_JSON } from "../config.mjs";
import { check as freshnessOf } from "../freshness.mjs";
import { toolDigest } from "../freshness.mjs";
import { armSideLabels } from "../ledger.mjs";
import { revalidatePremises, stampPremises, validatedAgainst } from "../premises.mjs";
import { answersDir } from "./handover.mjs";
import { here, runTools } from "./preflight.mjs";

export const NAME = "scan";

/**
 * The arm-id ledger. Per target, exactly as scan.mjs:1024-1027 chooses it —
 * config.mjs does not export this path, and the two must not disagree, because
 * a step reading the shared ledger while the scan wrote the bench one would
 * reconcile this repo's scan against another repo's ids.
 */
export const ARMIDS_JSON = IS_FOREIGN_TARGET
  ? join(OUT_DIR, "bench", `${REPO_ROOT.split("/").filter(Boolean).pop()}.armids.json`)
  : join(OUT_DIR, "armids.json");

/** Every arm id the scan itself names — the same three sources the ledger is built from. */
function* scannedArmIds(scan) {
  for (const fn of scan.functions ?? []) {
    for (const arm of fn.arms?.list ?? []) if (arm.armId) yield arm.armId;
    if (fn.entryArmId) yield fn.entryArmId;
  }
  for (const group of scan.moduleScopeArms ?? []) {
    for (const arm of group.list ?? []) if (arm.armId) yield arm.armId;
  }
}

/**
 * Why the scan and its ledger do not reconcile, or null when they do.
 *
 * Returned as a sentence rather than a boolean because `precondition` prints it
 * and `satisfied` only asks whether it is null, and a reconcile that can only
 * say "no" makes the person reading the log go and diff two JSON files by hand.
 */
export function unreconciled() {
  if (!existsSync(ARMIDS_JSON)) return `${here(ARMIDS_JSON)} is missing — scan.mjs mints it beside scan.json`;
  let scan;
  let ledger;
  try {
    scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
    ledger = JSON.parse(readFileSync(ARMIDS_JSON, "utf8"));
  } catch (err) {
    return `${here(SCAN_JSON)} and ${here(ARMIDS_JSON)} cannot both be read — ${err.message}`;
  }
  const known = ledger.byArmId ?? {};
  let counted = 0;
  for (const armId of scannedArmIds(scan)) {
    counted += 1;
    if (!(armId in known)) {
      return `${armId} is in ${here(SCAN_JSON)} and not in ${here(ARMIDS_JSON)} — the ledger is from a different scan`;
    }
  }
  if (!counted && Object.keys(known).length) {
    return `${here(SCAN_JSON)} names no arms while ${here(ARMIDS_JSON)} holds ${Object.keys(known).length} — the two are not from the same run`;
  }
  return null;
}

/**
 * ts-morph is driven by the target's own tsconfig, and a missing one surfaces
 * as a ts-morph error about a project it could not open rather than as the
 * configuration problem it is.
 */
export function precondition(_repo) {
  if (!existsSync(TSCONFIG)) return `no tsconfig.json at ${TSCONFIG} — scan.mjs opens the project through it`;
  return null;
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * D61 — why scan.json was written by a scan.mjs other than the one installed,
 * or null when it was not.
 *
 * `satisfied` asked about src/ and HEAD only, so a run resumed under a FIXED
 * image read the old scan.json as done: sourcing-ms was resumed under D58's
 * image, the walk printed `scan: already done`, and the 16 unresolved vias D58
 * fixed stayed exactly as they were - which is how run 20260926T222646Z ended
 * the way the run before it had. The installed scan.mjs is hashed with the same
 * `toolDigest` scan.mjs stamps itself with; a scan.json from before the stamp
 * says nothing about its tool and is re-scanned once, which is the honest
 * reading of "unknown".
 */
// The scan.mjs the walk SPAWNS - preflight.mjs `runTool` resolves it under the
// target's .claude/charpilot/, which is not always the directory this file was
// loaded from (a suite that imports the steps from the source tree).
export function scanToolReason(scanPath = SCAN_JSON, toolPath = resolve(SELF_REPO_ROOT, ".claude", "charpilot", "scan.mjs")) {
  const now = toolDigest(toolPath);
  if (!now) return null;
  const doc = readJson(scanPath);
  if (!doc) return null;
  const then = doc.scanTool?.sha256 ?? null;
  if (then === now) return null;
  return then
    ? `${here(scanPath)} was written by scan.mjs ${then.slice(0, 12)} and the installed scan.mjs is ${now.slice(0, 12)} - the toolset changed, so it is scanned again`
    : `${here(scanPath)} records no scan.mjs digest (it predates D61), so which scan wrote it is unknown and it is scanned again with the installed one (${now.slice(0, 12)})`;
}

/** The scan itself is done: there, fresh, by the installed tool, and reconciled with its ledger. */
export function scanDone() {
  if (!existsSync(SCAN_JSON)) return false;
  // Same reason as steps/baseline.mjs: a reconciled scan.json describes the
  // commit it was generated from, and `already done` never asked which one.
  // scan.json now records `gitSha`, so freshness can answer on the sha rather
  // than on mtime alone.
  if (freshnessOf("scan.json").state !== "fresh") return false;
  if (scanToolReason()) return false;
  return unreconciled() === null;
}

/**
 * D60 — the BLOCKED.md rulings have been re-checked against THIS scan
 * (premises.mjs). Part of this step because the scan is what changes the
 * reachability facts they rest on, and every reader after it - coverage.mjs,
 * the ledger, derive - must find the entries this scan supersedes already gone.
 */
function premisesChecked() {
  const scan = readJson(SCAN_JSON);
  return !scan || validatedAgainst(scan);
}

/**
 * D86: THE SCAN REPAIRS THE IDS IT MOVED, RATHER THAN REPORTING THEM.
 *
 * `armids.mjs` ran here without `--fix`, so a shift the ledger could bridge
 * was printed ("repairable by stableId lookup ... run with --fix") and left,
 * and the next scan rotated the only ledger that bridged it. qode-ptp-ms ran
 * four more walks with 548 rows quarantined on ids the tool could compute.
 * `CHARPILOT_ARMIDS_FIX=off` goes back to report-only.
 */
export const ARMIDS_FIX_ENV = "CHARPILOT_ARMIDS_FIX";
export function armidsArgs(env = process.env) {
  return String(env[ARMIDS_FIX_ENV] ?? "").trim().toLowerCase() === "off" ? [] : ["--fix"];
}

/** THE DISK: the scan is there, the ledger accounts for every arm in it, and the rulings were re-checked against it. */
export function satisfied(_repo) {
  return scanDone() && premisesChecked();
}

/** The labels a premise key is computed over: the ledger's one definition (D59). */
function labelsFor(scan) {
  return armSideLabels({ worklist: readJson(WORKLIST_JSON), scan });
}

export function run(repo) {
  const did = [];
  let outcome = { did: [], pending: [], metrics: {} };
  if (!scanDone()) {
    const why = scanToolReason();
    if (why) did.push(why);
    // D60: BEFORE the scan that replaces it, every entry not yet stamped is
    // stamped from the scan it was written under - the one on disk now.
    const before = readJson(SCAN_JSON);
    const stamped = before ? stampPremises(before, { labelsByArm: labelsFor(before) }) : 0;
    if (stamped) {
      did.push(`premises: stamped ${stamped} BLOCKED.md entr(ies) with the reachability of the scan they were written under, before it is replaced`);
    }
    outcome = runTools(["scan", ["armids", armidsArgs()]], SCAN_JSON);
  }
  const metrics = { ...(outcome.metrics ?? {}) };
  const scan = readJson(SCAN_JSON);
  if (scan) {
    const r = revalidatePremises(scan, { labelsByArm: labelsFor(scan), answersDir: answersDir(repo ?? REPO_ROOT) });
    metrics.rulingsSuperseded = r.superseded.length;
    metrics.rulingsSupersededSides = r.superseded.reduce((n, x) => n + (x.sides?.length ?? 0), 0);
    metrics.rulingsKeptNoWayIn = r.kept.length;
    const names = (xs) => {
      const fns = [...new Set(xs.map((x) => String(x.functionId).split(":").pop()))];
      return `${fns.slice(0, 6).join(", ")}${fns.length > 6 ? `, +${fns.length - 6} more` : ""}`;
    };
    if (r.superseded.length) {
      did.push(
        `premises: ${r.superseded.length} BLOCKED.md entr(ies) ruling ${metrics.rulingsSupersededSides} side(s) were written while ` +
          `the scan found no way to call their function, and this scan finds one (${names(r.superseded)}) - SUPERSEDED: ` +
          `removed from BLOCKED.md and kept in out/blocked-premises.json, so their sides are open and derive deals them ` +
          `as input questions through the driver`
      );
    }
    if (r.kept.length) {
      did.push(`premises: ${r.kept.length} entr(ies) written with no way in still have none (${names(r.kept)}) - their rulings stand`);
    }
    if (!r.superseded.length && !r.kept.length && r.stamped) did.push(`premises: stamped ${r.stamped} BLOCKED.md entr(ies) from this scan`);
  }
  return { ...outcome, did: [...did, ...outcome.did], metrics };
}
