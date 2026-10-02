#!/usr/bin/env node
/**
 * Find every stale arm id, and repair it by content rather than by hand.
 *
 * WHY. An `armId` is `file#line:kind:index`, so any edit above an arm moves it,
 * and every artifact naming that id is then wrong. Nothing detects it: a
 * reference to an arm that no longer exists reads exactly like a reference to
 * an arm that got covered, so a blocked entry silently stops covering the arm
 * it was written for. Measured in one session:
 *
 *   1,747 references remapped by a single one-line comment
 *   1,938 by a later pair
 *      13 of 29 blocked entries stale at once, with shifts of +8 to +56
 *       6 false "contradicted" verdicts produced against entries that were right
 *
 * Each of those remaps was done by matching each live arm's own source text and
 * rewriting the numbers - slow, and unverifiable afterwards.
 *
 * HOW. `scan.mjs` now mints a content-addressed `stableId` beside each `armId`,
 * hashed over the enclosing function's name, the arm kind, the arm's own source
 * text and its ordinal among identical arms in that function. A comment above
 * the arm changes none of those. It also keeps the previous ledger, so a repair
 * is a two-step lookup rather than a search:
 *
 *   stale armId  ->  stableId          (from out/armids.prev.json)
 *                ->  current armId     (from out/armids.json)
 *
 * When a stableId has no successor in the current ledger, the arm is genuinely
 * gone - the code changed, not the line numbers - and this refuses to guess.
 *
 *   node .claude/charpilot/armids.mjs           report only
 *   node .claude/charpilot/armids.mjs --fix     rewrite the references
 *
 * Exit 1 if any stale reference remains.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { OUT_DIR, PROPOSALS_DIR, REPO_ROOT, SCAN_JSON, WORKLIST_JSON } from "./config.mjs";
import { answersDir } from "./steps/handover.mjs";
import { moduleScopeFunctions, resolveFunctionId } from "./validate.mjs";

const FIX = process.argv.slice(2).includes("--fix");
const LEDGER = join(OUT_DIR, "armids.json");
const PREV = join(OUT_DIR, "armids.prev.json");

/**
 * Every file that names an arm id.
 *
 * THE ANSWERS DIRECTORY TOO (D86). `derive` reads every submission in
 * `charpilot-answers/` each round and lands it in `proposals/` again, so a
 * reference repaired in `proposals/` alone came back stale from its submission
 * one round later. Both copies are rewritten, or neither is repaired.
 */
function targets() {
  const out = [];
  for (const dir of [PROPOSALS_DIR, answersDir(REPO_ROOT)]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".json") || f.endsWith(".md")) out.push(join(dir, f));
    }
  }
  for (const f of ["out/worklist.json", "out/behaviour.json", "out/coverage.json", "decisions.json"]) {
    const p = join(REPO_ROOT, ".claude/charpilot", f);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

// `file#<line>:<kind>:<index>` — the shape of every reference in an artifact.
// `[` and `]` are path characters: a route directory such as
// `src/routes/start-interview/[aiInterviewerId].route.ts` held 24 stale
// references on qode-ptp-ms that this pattern never saw (D86).
const REF = /((?:src|prisma)\/[\w./\[\]-]+?)#(\d+):([a-z-]+):(\d+)/g;

/**
 * A STALE ID THE LEDGER NEVER SAW, MAPPED THROUGH GIT (D86).
 *
 * The ledger bridges ONE scan: `armids.prev.json` is the scan before this one.
 * qode-ptp-ms moved under its proposals (production took AI-5440, +44 lines in
 * aiInterviewService.ts), and run 20260929T042904Z's scan said
 * "repairable by stableId lookup ... run with --fix" - but the walk ran this
 * tool without --fix, and the next scan rotated the pre-move ledger away.
 * From then on 2,031 references in that one file "predate the ledger", 548
 * rows were quarantined every round, and 271 of the next round's 324 packets
 * asked the agent to retype ids the tool could have computed.
 *
 * The line a reference names still exists in the file's history. `git diff
 * -U0 <commit> HEAD` maps an old line to its new one when the line is
 * unchanged, and to nothing when the edit touched it. The newest version of the
 * file in which the reference's line maps onto a live arm of the same kind and
 * ordinal is the one it was written against: an unchanged line with the same
 * arm on it is the same arm. A line the edit touched maps to nothing and is
 * left for a person, exactly as a stableId with no successor is.
 */
const GIT_HISTORY = 40;
const lineMaps = new Map();

/** Hunks of `git diff -U0 <from> HEAD -- file`, as [oldStart, oldCount, newStart, newCount]. */
export function hunksOf(diff) {
  const hunks = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]);
  }
  return hunks;
}

/** The new line of old line `x` across `hunks`, or null when an edit touched it. */
export function mapLine(hunks, x) {
  let delta = 0;
  for (const [a, b, , d] of hunks) {
    if (b > 0 && x >= a && x <= a + b - 1) return null;
    if (b > 0 ? a + b - 1 < x : a < x) delta += d - b;
  }
  return x + delta;
}

function git(args) {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * Per earlier version of `file`, newest first: the hunks from it to HEAD.
 *
 * The versions are the file as each commit that touched it left it, and the
 * one before the oldest of them: a commit's parent holds the same file as the
 * next older commit to touch it, so only the last needs asking separately.
 */
function historyOf(file) {
  if (lineMaps.has(file)) return lineMaps.get(file);
  const commits = (git(["log", `-n${GIT_HISTORY}`, "--format=%H", "HEAD", "--", file]) ?? "").split("\n").filter(Boolean);
  if (commits.length) commits.push(`${commits.at(-1)}^`);
  const versions = [];
  for (const commit of commits) {
    const diff = git(["diff", "-U0", "--no-color", "--no-ext-diff", commit, "HEAD", "--", file]);
    if (diff === null) continue;
    const hunks = hunksOf(diff);
    if (hunks.length) versions.push({ commit, hunks });
  }
  lineMaps.set(file, versions);
  return versions;
}

/** The live arm a stale `file#line:kind:n` names, found through git, or null. */
export function throughGit(ref, live) {
  const m = /^(.+)#(\d+):([a-z-]+):(\d+)$/.exec(ref);
  if (!m) return null;
  const [, file, line, kind, n] = m;
  for (const { commit, hunks } of historyOf(file)) {
    const to = mapLine(hunks, Number(line));
    if (to === null || to === Number(line)) continue;
    const id = `${file}#${to}:${kind}:${n}`;
    if (live.has(id)) return { id, commit };
  }
  return null;
}

function main() {
  if (!existsSync(LEDGER)) {
    process.stdout.write("\n  ! out/armids.json missing — run `npm run pilot:scan` first\n");
    process.exit(2);
  }
  const now = JSON.parse(readFileSync(LEDGER, "utf8"));
  const prev = existsSync(PREV) ? JSON.parse(readFileSync(PREV, "utf8")) : null;
  const live = new Set(Object.values(now.byStableId));
  // STATEMENT units are minted by worklist.mjs, not by the scan, so they are
  // absent from the arm-id ledger and every proposal naming one looked stale.
  // The tool then told a person to "match each live arm's own source text once"
  // for references that were correct all along: 13 on interview-service, 15 on
  // profile-centralized, 3 on location-ms, and every single one a `stmt` unit
  // present in worklist.json. validate.mjs already had this exact bug and
  // already fixed it by adding worklist.items to the set it accepts - a
  // comment there records it cost one agent 15 of its 15 first-pass errors.
  // This is the same fix in the other tool.
  //
  // FROM THE CATALOGUE, NOT FROM THE WORK LIST - and that distinction is the
  // whole of the second defect.
  //
  // The fix above read `wl.items`, whose stated rule was "stale precisely when
  // the worklist has stopped listing it either". That rule is wrong, because
  // the work list stops listing a statement the moment it is COVERED:
  // worklist.mjs skips any statement whose istanbul `s` counter is above zero.
  // So a proposal that did its job - drove the statement, got it executed -
  // became the thing this tool reports as pointing at nothing, and it told a
  // person to go and repair 200 references that were right.
  //
  // Measured on run 20260915T050314Z: 73 statement ids cited across the
  // proposals, 71 of them absent from worklist.json for no reason other than
  // success. `arm-ids` red at 200, `validate` red at 187, and the two counts
  // were the same population seen by two tools.
  //
  // `statementUnits` is the catalogue of every statement unit istanbul
  // instruments, covered or not. Existence is read from that; whether the work
  // is done is read from `items`, and the two questions never share a list
  // again. A genuinely dead statement reference is STILL reported, because a
  // statement whose line no longer exists is in neither.
  if (existsSync(WORKLIST_JSON)) {
    try {
      const wl = JSON.parse(readFileSync(WORKLIST_JSON, "utf8"));
      for (const item of wl.items ?? []) if (item.armId) live.add(item.armId);
      for (const unit of wl.statementUnits ?? []) if (unit.armId) live.add(unit.armId);
    } catch {
      // An unreadable worklist means no extra ids, which can only over-report
      // staleness - the safe direction for a check whose output asks a human to
      // go and edit something.
    }
  }

  const stale = [];
  const repaired = [];
  const unresolvable = [];

  /**
   * Which arm ids a proposal file names STRUCTURALLY - in covers, in a reaches
   * key, or in a from.arm - as opposed to mentioning in prose.
   *
   * The scan is a regex over raw file text, which is what makes --fix able to
   * rewrite an id in place, and it cannot tell a reference from a sentence. So
   * profile-centralized's last reported stale id turned out to be a `notes`
   * field in which the agent had written down that the arm does not exist and
   * that they had removed it - documentation of a defect, read back as the
   * defect. "Someone has to act" is the wrong thing to say about that.
   *
   * A ref mentioned ONLY in prose is skipped; one that appears in a structural
   * field is reported as before. Non-JSON targets (BLOCKED.md) have no
   * structure to read, so they keep the old behaviour.
   */
  const structuralRefs = (file, text) => {
    if (!file.endsWith(".json")) return null;
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return null;
    }
    const out = new Set();
    for (const pr of doc.proposals ?? []) {
      for (const a of pr.covers ?? []) out.add(a);
      for (const a of Object.keys(pr.reaches ?? {})) out.add(a);
      const froms = [
        ...(pr.args ?? []).map((x) => x?.from?.arm),
        ...(pr.setup ?? []).map((x) => x?.from?.arm),
        ...Object.values(pr.boundaries ?? {}).map((x) => x?.from?.arm),
        pr.invoke?.from?.arm,
      ];
      for (const a of froms) if (a) out.add(a);
    }
    return out;
  };

  /**
   * A MOVED FUNCTION ID, WRITTEN AS THE ONE IT RESOLVES TO (D86).
   *
   * `validate.mjs` already resolves a `functionId` or `via` whose line moved to
   * the one function of that name in the file (D68, D79), and says so: "is not
   * the scan's id; ... is the one function ... so it is checked and recorded as
   * that". It says it as a WARNING, and the round boundary quarantines a row
   * with any fault, warnings included - so a row the tool had already resolved
   * was set aside and dealt back to the agent to retype every round (128 such
   * warnings on qode-ptp-ms). The id it resolves to is written in, here, by
   * the same resolver, and a name that picks out no single function is left.
   */
  let fnIndex = null;
  const rekeys = [];
  const rekeyFunctionIds = (text, rel) => {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return text;
    }
    if (!Array.isArray(doc?.proposals)) return text;
    if (!fnIndex) {
      const scan = existsSync(SCAN_JSON) ? JSON.parse(readFileSync(SCAN_JSON, "utf8")) : null;
      fnIndex = scan ? new Map([...moduleScopeFunctions(scan), ...scan.functions.map((f) => [f.id, f])]) : new Map();
    }
    if (!fnIndex.size) return text;
    const to = new Map();
    const settle = (id, proposal) => {
      if (typeof id !== "string" || id.startsWith("trigger:") || fnIndex.has(id)) return;
      const r = resolveFunctionId(fnIndex, { ...proposal, functionId: id });
      const next = r.fn ? r.fn.id : null;
      // One old id, two resolutions: the text cannot be rewritten for one row
      // without rewriting it for the other, so it is left for validate to name.
      to.set(id, to.has(id) && to.get(id) !== next ? null : next);
    };
    for (const p of doc.proposals) {
      settle(p?.functionId, p);
      settle(p?.via, { covers: [] });
    }
    let out = text;
    for (const [from, next] of to) {
      if (!next) continue;
      const key = new RegExp(`("(?:functionId|via)"\\s*:\\s*)${JSON.stringify(from).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
      out = out.replace(key, (_, lead) => `${lead}${JSON.stringify(next)}`);
      rekeys.push({ file: rel, from, to: next });
    }
    return out;
  };

  for (const file of targets()) {
    const before = readFileSync(file, "utf8");
    const structural = structuralRefs(file, before);
    const after = before.replace(REF, (whole) => {
      if (live.has(whole)) return whole;
      // Mentioned in prose only - a sentence about an arm, not a reference to
      // one. Left exactly as written, and not reported.
      if (structural && !structural.has(whole)) return whole;
      // stale. Try the two-step lookup.
      const stableId = prev?.byArmId?.[whole];
      const now_ = stableId ? now.byStableId[stableId] : undefined;
      const rel = relative(REPO_ROOT, file);
      if (now_) {
        repaired.push({ file: rel, from: whole, to: now_, via: stableId });
        return FIX ? now_ : whole;
      }
      // D86: no ledger bridges it. The file's own history may.
      const mapped = stableId ? null : throughGit(whole, live);
      if (mapped) {
        repaired.push({ file: rel, from: whole, to: mapped.id, via: `git ${mapped.commit.slice(0, 8)}` });
        return FIX ? mapped.id : whole;
      }
      (stableId ? unresolvable : stale).push({ file: rel, ref: whole, stableId: stableId ?? null });
      return whole;
    });
    const rekeyed = structural ? rekeyFunctionIds(after, relative(REPO_ROOT, file)) : after;
    if (FIX && rekeyed !== before) writeFileSync(file, rekeyed);
  }

  const w = (s) => process.stdout.write(s);
  w(`\narm ids — ${now.totals.arms} arm(s), ${now.totals.distinctStableIds} distinct stableId(s)\n\n`);

  if (repaired.length) {
    const byFile = new Map();
    for (const r of repaired) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
    const byGit = repaired.filter((r) => r.via.startsWith("git ")).length;
    w(
      `  ${FIX ? "repaired" : "repairable"} by stableId lookup: ${repaired.length - byGit} reference(s)` +
        `${byGit ? `, and by the file's git history: ${byGit} (D86)` : ""}\n`
    );
    for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) w(`    ${String(n).padStart(5)}  ${f}\n`);
    for (const r of repaired.slice(0, 4)) w(`      e.g. ${r.from}  ->  ${r.to}  (${r.via.startsWith("git ") ? r.via : "stableId"})\n`);
    if (!FIX) w(`\n  run with --fix to rewrite them\n`);
  }
  if (rekeys.length) {
    w(`\n  ${FIX ? "rewritten" : "rewritable"}: ${rekeys.length} moved function id(s) to the one function of that name (D86)\n`);
    for (const r of rekeys.slice(0, 4)) w(`      e.g. ${r.from}  ->  ${r.to}\n`);
  }
  if (unresolvable.length) {
    // The stableId existed and has no successor: the arm's own text or its
    // enclosing function changed, so this is a real code change, not a shift.
    w(`\n  ${unresolvable.length} reference(s) name an arm whose CONTENT changed — not a shift:\n`);
    for (const r of unresolvable.slice(0, 10)) w(`    ${r.file}  ${r.ref}\n`);
    w(`  Re-derive these against the current source; a lookup cannot honestly guess them.\n`);
  }
  if (stale.length) {
    // No previous ledger entry at all: the reference predates the ledger.
    //
    // Split by whether anyone has to act. `proposals/` is INPUT - a stale id
    // there means a proposal or a blocked entry is pointing at nothing, which
    // is the silent failure this tool exists for. `out/` holds recorded
    // SNAPSHOTS, which are stale by definition once the source moves; the fix
    // for those is to re-run the stage, not to rewrite the file.
    const input = stale.filter((r) => !r.file.includes("/out/"));
    const snapshots = stale.filter((r) => r.file.includes("/out/"));
    // The IDS, not only the file and the count. "someone has to act" over a
    // path and a number is a next action nobody can take without going and
    // grepping for it - and the `unresolvable` block two above already prints
    // the reference it is complaining about.
    const list = (rows) => {
      const byFile = new Map();
      for (const r of rows) byFile.set(r.file, [...(byFile.get(r.file) ?? []), r.ref]);
      for (const [f, refs] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
        w(`    ${String(refs.length).padStart(5)}  ${f}\n`);
        for (const ref of [...new Set(refs)].slice(0, 8)) w(`           ${ref}\n`);
      }
    };
    if (input.length) {
      w(`\n  ${input.length} stale reference(s) in INPUT artifacts — someone has to act:\n`);
      list(input);
      w(`  These predate the ledger, so a lookup cannot repair them. Match each\n`);
      w(`  live arm's own source text once; from the next scan onward the ledger\n`);
      w(`  handles it.\n`);
    }
    if (snapshots.length) {
      w(`\n  ${snapshots.length} stale reference(s) in recorded SNAPSHOTS — expected:\n`);
      list(snapshots);
      w(`  A snapshot is stale the moment the source moves. Re-run the stage that\n`);
      w(`  wrote it rather than rewriting the file.\n`);
    }
  }
  if (!repaired.length && !unresolvable.length && !stale.length && !rekeys.length) {
    w(`  OK — every arm reference in every artifact names a live arm\n`);
    return;
  }
  process.exit(FIX && !unresolvable.length && !stale.length ? 0 : 1);
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main();
}