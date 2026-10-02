/**
 * The AST-arm to istanbul-branch join, in ONE place.
 *
 * Stage 2 proved this matching closes at zero drift (1518 vs 1518 sides, 504 vs
 * 504 functions). Stages 4 and 6 both have to ask the same question of a
 * different coverage report - "which side of this arm ran?" - and a second copy
 * of the join would be a second thing to keep true. So it lives here and every
 * caller imports it.
 *
 * `buildHitIndex` takes the coverage directory, because stage 6 measures into
 * its OWN reportsDirectory: a measurement run must never overwrite the baseline
 * it is being compared against.
 *
 * `hitIndexFromSkeleton` is the stage-4 entry to the SAME join. The recorder
 * reads istanbul's in-process counters (`globalThis.__VITEST_COVERAGE__`) and
 * has no coverage-final.json to point at, so it hands over the branch map it
 * saw in the worker and gets the identical index back. The alternative was a
 * second branch->arm mapping in record.mjs, which is how you get to be wrong
 * twice.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { REPO_ROOT } from "./config.mjs";

export const ISTANBUL_TYPE = {
  if: "if",
  "cond-expr": "cond-expr",
  "binary-expr": "binary-expr",
  switch: "switch",
  "default-arg": "default-arg",
  "transpile-artifact": "binary-expr",
};

/**
 * Why a unit of THIS kind can never be verdicted from istanbul's branch map.
 *
 * Not a diagnosis to hunt down - a permanent property of the kind, and the one
 * sentence a reader needs in order to stop looking. It exists because stage 6
 * said something else: an entry, catch or statement unit is absent from
 * `branchMap`, so the position join never holds one, and coverage.mjs then read
 * a missing key as `arm not found in scan` - blaming the SCAN for a claim whose
 * arm id was correct all along. Measured on one run: 8 of 38 claims (21%) read
 * that way, `validate.mjs` had accepted every one of the eight against
 * scan.json, and `armids.mjs` reported 0 stale ids. The message cost a
 * stale-arm-id investigation per run and could never have found anything.
 *
 * One producer, because stages 4 and 6 must not describe the same limit in two
 * ways: `annotateClaims` and the stage-6 claim check both call this.
 *
 * The kinds are named individually rather than lumped, because WHICH map holds
 * the unit is what says whether another oracle could answer the question -
 * a function entry and a statement are counted (in `f` and `s`), so
 * `uncoveredNonBranch` can ratchet them; a catch clause is counted nowhere at
 * all, which is why stage 2 keeps it apart from the denominator.
 */
export function nonBranchReason(kind) {
  if (kind === "function-entry" || kind === "entry")
    return "function-entry is not a branch: istanbul counts it in fnMap/f, never in the branch map a side claim is verdicted against";
  if (kind === "statement" || kind === "stmt")
    return "statement is not a branch: istanbul counts it in statementMap/s, never in the branch map a side claim is verdicted against";
  if (kind === "catch")
    return "catch is not a branch: istanbul instruments no counter for the catch decision at all, so no coverage map holds it";
  return `${kind} is not a branch: istanbul's branch map has no entry for it`;
}

/**
 * The kind token carried by an arm id, or null.
 *
 * `<file>#<line>:<kind>:<ordinal>` is minted in exactly one place (scan.mjs's
 * `push`, plus worklist.mjs for `stmt`), so the token is readable without the
 * scan - which is what lets a caller tell "this id names a unit kind that has
 * no branch counter" from "this id names nothing at all" even when the artifact
 * that would have listed it is missing.
 */
export function armIdKind(armId) {
  const m = /#\d+:([a-z-]+):\d+$/.exec(String(armId));
  return m ? m[1] : null;
}

/**
 * True for a kind istanbul never puts in its branch map.
 *
 * `ISTANBUL_TYPE` is the whole test, and deliberately so: it is the table the
 * join itself uses to decide what it can pair, so nothing can be a branch here
 * and not a branch there.
 */
export const isNonBranchKind = (kind) => Boolean(kind) && !ISTANBUL_TYPE[kind];

/**
 * Join AST arms to the branches istanbul actually instrumented, so the brief can
 * say which SIDE of each arm is still uncovered. Matching is by (file, type,
 * line) and then by order within that slot — safe only because the stage 2
 * reconcile closes exactly; anything that fails to match is reported, never
 * silently dropped.
 *
 * `final` is an istanbul coverage map: absolute path -> { branchMap, b }.
 */
export function hitIndexFrom(final) {
  const index = new Map();
  // Secondary index for the S2-11 fallback: every record for a file+type, in
  // branchMap order, so an arm whose exact-line key missed can still find the
  // branch whose OPERANDS cover its line.
  const byFileType = new Map();

  for (const [absPath, entry] of Object.entries(final)) {
    const file = relative(REPO_ROOT, absPath);
    for (const [branchId, branch] of Object.entries(entry.branchMap ?? {})) {
      const key = `${file}:${branch.type}:${branch.loc?.start?.line ?? branch.line}`;
      const hits = entry.b?.[branchId] ?? [];
      const bucket = index.get(key);
      // `branchId` and `file` are carried through so a caller holding raw
      // istanbul counters (stage 4 diffs `b` per row) can ask the reverse
      // question - "which arm is branch 12 of this file?" - without a second
      // copy of the key/order logic above.
      // The line of every LOCATION, not just the branch's own start line.
      // istanbul keys a branch at the line of the enclosing condition and gives
      // one location per operand, so a multi-line or chained condition has
      // operands on lines the branch key never mentions - which is exactly what
      // the exact-line join misses (S2-11). Kept here because the branchMap
      // already carries it; `hitIndexFromSkeleton` has no location lines, so
      // this is empty there and the fallback below stays inert for stage 4.
      const locLines = (branch.locations ?? [])
        .map((l) => l?.start?.line)
        .filter((n) => typeof n === "number");
      const record = { hits, locations: branch.locations?.length ?? hits.length, branchId, file, locLines, key };
      byFileType.set(`${file}:${branch.type}`, [...(byFileType.get(`${file}:${branch.type}`) ?? []), record]);
      if (bucket) bucket.push(record);
      else index.set(key, [record]);
    }
  }
  index.set("__byFileType", byFileType);
  return index;
}

export function buildHitIndex(coverageDir) {
  return hitIndexFrom(JSON.parse(readFileSync(join(coverageDir, "coverage-final.json"), "utf8")));
}

/**
 * The same index, built from what a vitest worker saw in-process.
 *
 * The recorder cannot use `buildHitIndex`: a record run writes no
 * coverage-final.json worth reading (each chunk would overwrite the last, and
 * only the files that chunk touched would be in it). What it CAN do is dump
 * istanbul's own `branchMap` for the files it loaded, trimmed to the three
 * fields the join uses. `{ [relativeFile]: { [branchId]: { type, line, n } } }`
 * where `n` is the number of sides.
 */
export function hitIndexFromSkeleton(skeleton) {
  const final = {};
  for (const [file, branches] of Object.entries(skeleton ?? {})) {
    const branchMap = {};
    const b = {};
    for (const [branchId, br] of Object.entries(branches)) {
      const n = Number(br.n) || 0;
      branchMap[branchId] = {
        type: br.type,
        loc: { start: { line: br.line } },
        line: br.line,
        locations: new Array(n).fill(null),
      };
      // Hit counts are irrelevant here - stage 4 asks only for the SHAPE, and
      // supplies the movement itself from its own per-row diff. Zeros keep the
      // record's `hits` array the right length so labels line up by index.
      b[branchId] = new Array(n).fill(0);
    }
    final[join(REPO_ROOT, file)] = { branchMap, b };
  }
  return hitIndexFrom(final);
}

/**
 * Records per `file|type`, in SOURCE POSITION order.
 *
 * The line-keyed join is wrong in principle and only works by luck. istanbul
 * keys a branch where the enclosing EXPRESSION starts; the AST keys it where the
 * NODE starts, and those differ the moment a condition spans two lines - so
 * `if (\n (a||b||c) && d\n)` is one istanbul binary-expr at the `if` line and an
 * AST arm one line down. Measured on ptp-be: 12 of 1175 file+type slots
 * disagreed on lines, 10 arms never joined, and the worklist refused.
 *
 * What DOES agree is the shape and the order. Both models emit exactly one
 * record per if / ternary / switch / default-arg and one per FLATTENED logical
 * chain with one side per operand - verified on ptp-be at 1175 of 1175 slots
 * with every type delta at zero. So pairing the two sequences by position rank
 * within a file+type is exact, and it needs no line to agree.
 *
 * istanbul's own branchMap id order is NOT usable for this: on
 * use-case-1/index.route.ts the ids run line 75, 264, 47. Sort by position.
 */
export function positionIndexFrom(final) {
  const index = new Map();
  for (const [absPath, entry] of Object.entries(final)) {
    const file = relative(REPO_ROOT, absPath);
    for (const [branchId, branch] of Object.entries(entry.branchMap ?? {})) {
      const key = `${file}|${branch.type}`;
      const rec = {
        branchId,
        file,
        hits: entry.b?.[branchId] ?? [],
        sides: (branch.locations ?? []).length,
        line: branch.loc?.start?.line ?? branch.line ?? 0,
        col: branch.loc?.start?.column ?? 0,
      };
      if (index.has(key)) index.get(key).push(rec);
      else index.set(key, [rec]);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.line - b.line || a.col - b.col);
  return index;
}

export function buildPositionIndex(coverageDir) {
  return positionIndexFrom(JSON.parse(readFileSync(join(coverageDir, "coverage-final.json"), "utf8")));
}

/**
 * The same join, paired by position rank instead of by line.
 *
 * `isSuppressed(armId)` is REQUIRED wherever a directive exists, and getting it
 * wrong is worse than the defect this replaces: a suppressed arm is in the AST
 * and not in istanbul's branchMap, so leaving it in the sequence shifts every
 * rank after it by one and pairs arms with the wrong record - which mislabels a
 * side, and a mislabelled side is how a `reaches` claim comes out FALSE while
 * looking verified. Measured on ai-centralization, whose 37 directives remove 20
 * arms: without the filter 4 of 81 slots pair wrongly, all four in files that
 * carry a directive.
 *
 * An arm whose rank has no record, or whose side count disagrees with the record
 * it paired with, is reported - never joined on a guess.
 */
export function measureArmsByPosition(scan, positionIndex, { isSuppressed = () => false, lineFallback = null } = {}) {
  const byArm = new Map();

  const groups = [
    ...scan.functions.map((fn) => ({ file: fn.file, id: fn.id, name: fn.name, list: fn.arms.list ?? [] })),
    ...(scan.moduleScopeArms ?? []).map((g) => ({ file: g.file, id: `${g.file}:module`, name: "<module scope>", list: g.list ?? [] })),
  ];

  // Every arm of a file+type in one sequence, in position order, with the
  // suppressed ones removed so the ranks line up with istanbul's.
  const seqs = new Map();
  const meta = new Map();
  for (const fn of groups) {
    for (const arm of fn.list) {
      if (!arm.istanbul) continue;
      const type = ISTANBUL_TYPE[arm.kind];
      if (!type) {
        byArm.set(arm.armId, { armId: arm.armId, file: fn.file, line: arm.line, kind: arm.kind, labels: arm.labels ?? [], functionId: fn.id, functionName: fn.name, known: false, reason: `${arm.kind} is not instrumented by istanbul` });
        continue;
      }
      meta.set(arm.armId, { fn, arm });
      if (isSuppressed(arm.armId)) {
        byArm.set(arm.armId, { armId: arm.armId, file: fn.file, line: arm.line, kind: arm.kind, labels: arm.labels ?? [], functionId: fn.id, functionName: fn.name, known: false, reason: "suppressed by an istanbul directive - there is no branch to join to" });
        continue;
      }
      const key = `${fn.file}|${type}`;
      if (seqs.has(key)) seqs.get(key).push(arm.armId);
      else seqs.set(key, [arm.armId]);
    }
  }

  for (const [key, armIds] of seqs) {
    // Line AND column. Sorting by line alone leaves arms that share a line in
    // collection order, which is per-function grouping rather than document
    // order - and two arms of one type on one line then pair with each other's
    // record. Measured on ai-centralization: 9 arms in slots whose cardinality
    // already matched. The arms have carried a `column` all along.
    armIds.sort(
      (a, b) =>
        meta.get(a).arm.line - meta.get(b).arm.line ||
        (meta.get(a).arm.column ?? 0) - (meta.get(b).arm.column ?? 0)
    );
    const records = positionIndex.get(key) ?? [];

    // Rank pairing is only sound when the two sequences have the SAME length.
    //
    // A directive removes some arms on its line and keeps their siblings - an
    // `istanbul ignore next` before a `??` operand drops that side and leaves
    // the rest - so "this arm is on a suppressed line" over-filters, and the
    // exact set istanbul dropped is knowable only from istanbul, which is the
    // question the join exists to answer. Measured: filtering by line on
    // ai-centralization removed 35 arms where 20 are genuinely absent, shifted
    // the ranks the other way, and lost 14 uncovered sides - a join that
    // silently reports FEWER uncovered sides is the worst possible failure here.
    //
    // Cardinality equality is checkable without knowing which arm was dropped.
    // Where it holds, rank pairing is exact and needs no line to agree. Where it
    // does not, the slot contains a directive and the line-keyed join already
    // handles it - and reports the rest as suppressed, which is true.
    if (records.length !== armIds.length) {
      if (!lineFallback) {
        for (const armId of armIds) {
          const { fn, arm } = meta.get(armId);
          byArm.set(armId, { armId, file: fn.file, line: arm.line, kind: arm.kind, labels: arm.labels ?? [], functionId: fn.id, functionName: fn.name, known: false, reason: `${key} holds ${armIds.length} arm(s) against ${records.length} istanbul branch(es) - a directive removed some, and rank pairing cannot say which` });
        }
        continue;
      }
      const cursor = new Map();
      for (const armId of armIds) {
        const { fn, arm } = meta.get(armId);
        const cov = lineFallback(fn.file, arm, cursor);
        byArm.set(armId, { armId, file: fn.file, line: arm.line, kind: arm.kind, labels: arm.labels ?? [], functionId: fn.id, functionName: fn.name, ...cov });
      }
      continue;
    }
    armIds.forEach((armId, rank) => {
      const { fn, arm } = meta.get(armId);
      const base = { armId, file: fn.file, line: arm.line, kind: arm.kind, labels: arm.labels ?? [], functionId: fn.id, functionName: fn.name };
      const record = records[rank];
      if (!record) {
        byArm.set(armId, { ...base, known: false, reason: `no istanbul branch at rank ${rank} of ${records.length} for ${key}` });
        return;
      }
      // FEWER istanbul sides than the arm has labels means a directive removed a
      // SIDE, not the branch: `istanbul ignore next` before one operand of a
      // `??` drops that operand's location and keeps the sibling. The branch is
      // still there, the pairing is still right, and refusing it would lose a
      // real uncovered side - measured as 444 -> 443 on ai-centralization across
      // 9 arms in the four files that carry directives.
      //
      // So pair it, and say so. WHICH label survived is not recoverable from the
      // branchMap: the surviving location is mapped onto labels[0..n], which is
      // an assumption today's line-keyed join also makes and never states. It is
      // recorded per arm here so a caller can refuse to build a `reaches` claim
      // on one. See S2-12.
      const partialSuppression = record.sides < (arm.labels?.length ?? record.sides);
      if (record.sides > (arm.labels?.length ?? record.sides)) {
        byArm.set(armId, { ...base, known: false, reason: `rank ${rank} paired with branch ${record.branchId}, which has MORE sides (${record.sides}) than this arm's ${arm.labels?.length} - the arm model is wrong here, not the join` });
        return;
      }
      byArm.set(armId, {
        ...base,
        known: true,
        hits: record.hits,
        branchId: record.branchId,
        ...(partialSuppression
          ? { partialSuppression: { istanbulSides: record.sides, armLabels: arm.labels?.length ?? null } }
          : {}),
        uncoveredSides: record.hits.map((n, i) => (n === 0 ? (arm.labels?.[i] ?? `arm${i}`) : null)).filter((x) => x !== null),
      });
    });
  }

  return byArm;
}

export function armCoverage(file, arm, hitIndex, cursor) {
  const type = ISTANBUL_TYPE[arm.kind];
  if (!type) return { known: false, reason: `${arm.kind} is not instrumented by istanbul` };

  const key = `${file}:${type}:${arm.line}`;
  const bucket = hitIndex.get(key);

  let record;
  if (bucket) {
    const nth = cursor.get(key) ?? 0;
    cursor.set(key, nth + 1);
    record = bucket[nth];
  }

  // S2-11 fallback, reached ONLY when the exact-line join found nothing. It
  // never runs for an arm that already joins, so no existing arm can move.
  //
  // istanbul keys a branch at the line of the enclosing condition and gives one
  // location per operand, so on a multi-line condition the operands sit on lines
  // the branch key never mentions:
  //
  //   if ( (a || b || c) && d )   ->  binary-expr line=224 locLines=[225,225,225,226]
  //
  // Asking "which branch has an operand on this arm's line" finds it, using
  // istanbul's own numbers. `hitIndexFromSkeleton` carries no location lines, so
  // locLines is empty there and this stays inert for stage 4.
  if (!record) {
    const candidates = (hitIndex.get("__byFileType")?.get(`${file}:${type}`) ?? []).filter(
      (r) => r.locLines?.includes(arm.line) && !cursor.get(`__used:${r.branchId}`)
    );
    // Only a record whose locations map ONE-TO-ONE onto this arm's sides can be
    // joined. A flattened chain (4 locations serving 3 nested AST arms) does
    // not, and guessing which location belongs to which arm would mislabel a
    // side - which is how a `reaches` claim comes out false while looking
    // verified. So that case is still refused, but now with the reason that
    // says what is actually wrong.
    const fit = candidates.find((r) => r.hits.length === (arm.labels?.length ?? r.hits.length));
    if (fit) {
      cursor.set(`__used:${fit.branchId}`, true);
      record = fit;
    } else if (candidates.length) {
      const c = candidates[0];
      return {
        known: false,
        reason:
          `istanbul flattened this condition: branch ${c.branchId} has ${c.hits.length} location(s) ` +
          `on lines ${[...new Set(c.locLines)].join(",")} and this arm has ${arm.labels?.length ?? "?"} side(s)`,
      };
    }
  }

  if (!record) {
    return {
      known: false,
      reason: bucket ? "more AST arms than istanbul branches on this line" : "no matching istanbul branch",
    };
  }

  return {
    known: true,
    hits: record.hits,
    branchId: record.branchId,
    uncoveredSides: record.hits
      .map((n, i) => (n === 0 ? (arm.labels?.[i] ?? `arm${i}`) : null))
      .filter((x) => x !== null),
  };
}

/**
 * Every arm's hit state, keyed by armId, in one pass with per-file cursors.
 *
 * Module-scope arms live OUTSIDE scan.functions - a top-level `??`, a class
 * property initializer, a transpiled enum. Iterating only scan.functions
 * measured 1508 sides against a 1518 denominator, and the missing 10 were
 * silently absent rather than reported. Stage 2 attributes them to module
 * scope precisely so they are not dropped; a measurement has to read them from
 * there. They share the file cursors, because istanbul numbers every branch in
 * a file in one source-order sequence regardless of what encloses it.
 */
export function measureArms(scan, hitIndex) {
  const byArm = new Map();
  const cursors = new Map();

  const groups = [
    ...scan.functions.map((fn) => ({ file: fn.file, id: fn.id, name: fn.name, list: fn.arms.list ?? [] })),
    ...(scan.moduleScopeArms ?? []).map((g) => ({ file: g.file, id: `${g.file}:module`, name: "<module scope>", list: g.list ?? [] })),
  ].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  for (const fn of groups) {
    if (!cursors.has(fn.file)) cursors.set(fn.file, new Map());
    const cursor = cursors.get(fn.file);
    for (const arm of fn.list) {
      if (!arm.istanbul) continue;
      const cov = armCoverage(fn.file, arm, hitIndex, cursor);
      byArm.set(arm.armId, {
        armId: arm.armId,
        file: fn.file,
        line: arm.line,
        kind: arm.kind,
        labels: arm.labels ?? [],
        functionId: fn.id,
        functionName: fn.name,
        known: cov.known,
        // Which istanbul branch of that file this arm IS. Null when the join
        // found nothing, which is the same condition as `known: false`.
        branchId: cov.branchId ?? null,
        hits: cov.hits ?? [],
        uncoveredSides: cov.uncoveredSides ?? [],
        reason: cov.reason ?? null,
      });
    }
  }
  return byArm;
}

/**
 * Every arm the scan knows about, with no coverage report involved.
 *
 * This is what tells "the claim named an arm that does not exist" and "the
 * claim named a side that is not a side of this arm" apart from "the input
 * never went that way". The first two are unmeasurable and the third is FALSE,
 * and they have different fixes.
 */
export function armIndexFromScan(scan, worklistItems = null) {
  const byArm = new Map();
  const groups = [
    ...scan.functions.map((fn) => ({ file: fn.file, id: fn.id, name: fn.name, list: fn.arms.list ?? [] })),
    ...(scan.moduleScopeArms ?? []).map((g) => ({ file: g.file, id: `${g.file}:module`, name: "<module scope>", list: g.list ?? [] })),
  ];
  // The ENTRY unit. validate.mjs deliberately accepts fn.entryArmId in `covers`
  // and `from.arm`, and this index never carried it - so the two halves of the
  // pipeline disagreed about whether an entry arm exists, and every claim on one
  // came back `unmeasurable: "arm not found in scan"`, a message that blames the
  // scan for something the join was missing. That is not cosmetic: on
  // pricing-ms, 12 of 37 sampled functions have NO branch arm at all, so their
  // entry unit is the only claim available and it was permanently unverifiable.
  // 27 of that agent's 48 claims read this way.
  //
  // Carried with istanbul: false, which is the truth - an entry unit is a
  // FUNCTION counter, not a branch one - so the verdict now says
  // "function-entry is not instrumented by istanbul" and names the real limit
  // instead of implying a missing arm.
  for (const fn of scan.functions ?? []) {
    if (!fn.entryArmId || byArm.has(fn.entryArmId)) continue;
    byArm.set(fn.entryArmId, {
      armId: fn.entryArmId,
      file: fn.file,
      line: fn.line ?? null,
      kind: "function-entry",
      labels: ["entered"],
      istanbul: false,
      functionId: fn.id,
      functionName: fn.name,
    });
  }
  // STATEMENT units, for the same reason and with the same fix as the entry
  // units above: validate.mjs accepts a `#NN:stmt:0` in both `covers` and
  // `from.arm` because worklist.items carries them, and this index did not - so
  // a claim on one read "arm not found in scan", blaming the scan for what the
  // join was missing. I fixed the entry half and left this one, and two agents
  // reported it independently on the next rung: 28 of profile-centralized's 69
  // unmeasurable claims read that way, every one a statement arm.
  //
  // istanbul: false, because a statement is not a branch counter. The verdict
  // then names the real limit rather than implying a typo in the input.
  if (worklistItems) {
    for (const item of worklistItems) {
      if (!item.armId || byArm.has(item.armId)) continue;
      if (!/:stmt:\d+$/.test(item.armId)) continue;
      byArm.set(item.armId, {
        armId: item.armId,
        file: item.file ?? null,
        line: item.line ?? null,
        kind: "statement",
        labels: item.sides ?? ["executed"],
        istanbul: false,
        functionId: item.owner?.functionId ?? null,
        functionName: item.owner?.name ?? null,
      });
    }
  }
  for (const fn of groups) {
    for (const arm of fn.list) {
      byArm.set(arm.armId, {
        armId: arm.armId,
        file: fn.file,
        line: arm.line,
        kind: arm.kind,
        labels: arm.labels ?? [],
        istanbul: Boolean(arm.istanbul) && Boolean(ISTANBUL_TYPE[arm.kind]),
        functionId: fn.id,
        functionName: fn.name,
      });
    }
  }
  return byArm;
}

/**
 * `reaches` values may be one label or several. One parser, because two would
 * disagree about a label containing a comma inside braces (a destructured
 * default-arg label is the whole pattern).
 */
/**
 * The sides a `reaches` value claims.
 *
 * A string is comma-joined by convention, which is ambiguous the moment a side
 * LABEL contains a comma - and labels are lifted verbatim from source, so they
 * do. Measured on interview-service: `events.service.ts#96:binary-expr:0` is
 * labelled `isUniqueViolation(err, 'client_key')`, and the split turned one true
 * claim into two invented sides, both reported `unmeasurable` while `armsMoved`
 * showed the side had in fact moved. The brace lookahead did not help: the comma
 * is inside PARENTHESES.
 *
 * So the arm decides. Given its labels, the whole string wins if it is itself a
 * label, and a split wins only when every piece is one. Anything else is passed
 * through whole, so the caller reports "not a side of this arm" - which names
 * the real problem - instead of inventing two sides that were never claimed.
 *
 * With no labels to check against (a caller that has not resolved the arm) the
 * old behaviour stands, because there is nothing better to do.
 */
/**
 * Does a claimed side name one of an arm's labels.
 *
 * Labels are SOURCE EXCERPTS, and the scan truncates them at 60 characters with
 * a trailing ellipsis - so an arm whose operand is
 * `Date.now() - meeting.processingStartedAt.getTime() > STALE_MS` is labelled
 * with the first 59 characters and a "…". Exact-match meant a proposal had to
 * reproduce that truncation byte-for-byte, ellipsis included, and
 * interview-service's agent had to go and copy it out of scan.json to make a
 * true claim verdict. Worse, validate.mjs did not warn about the untruncated
 * form, because that arm was not in worklist.items - so the two checks
 * disagreed and a wrong-looking label passed stage 3 in silence.
 *
 * A truncated label is a PREFIX of what the author would naturally write, so
 * both directions are accepted. Nothing else is loosened: two different
 * operands that agree for 59 characters are indistinguishable in the artifact
 * anyway, and that is a scan-side limit, not a matching one.
 */
export function sideIndexOf(labels, side) {
  const exact = labels.indexOf(side);
  if (exact !== -1) return exact;
  const bare = (t) => String(t).replace(/…$/, "");
  const want = bare(side);
  return labels.findIndex((label) => {
    const have = bare(label);
    if (have === want) return true;
    // A truncated label against a full claim, or the reverse.
    if (String(label).endsWith("…") && want.startsWith(have)) return true;
    if (String(side).endsWith("…") && have.startsWith(want)) return true;
    return false;
  });
}

/**
 * A claimed side, rewritten as the arm's OWN label for it.
 *
 * D6: `sideIndexOf` was tolerant of the truncation and every downstream
 * comparison was not, so the two halves of one check disagreed about what a
 * side is called. Stage 4's verdict is
 * `movedSides.has(`${armId}|${side}`)` over a set built from `arm.labels`;
 * stage 6's `claimedKeys` and the ledger's `key(armId, side)` are the same
 * shape. A proposal that wrote the natural untruncated operand therefore
 * passed the "is this a side of this arm" gate and then failed the set
 * lookup - reported as `false` / "that side never incremented", i.e. as a
 * mis-aimed input. Measured on qode-ptp-ms:
 * `questionBankUtils.ts#116:binary-expr:0`, side
 * `questionList.find(item => item.mixerType === mixerType)?.questions`, which
 * moved the correct side of the correct arm and came back FALSE.
 *
 * The label is truncated exactly ONCE, in scan.mjs's `snippet(leaf, 60)`, and
 * every tool reads that one stored string - so there is no second producer to
 * reconcile and nothing to renumber. Funnelling the claim through the arm's
 * label list makes both sides of every later comparison see the same
 * transformation, which is why this changes no stored label and invalidates no
 * recorded row or committed test.
 *
 * Ambiguity is refused rather than guessed: two labels can only both match a
 * claim when they are the same string (two 60-char truncations are prefixes of
 * each other only if equal), so a multi-match over DIFFERENT labels means the
 * caller is holding something this function does not understand. Return the
 * claim untouched and let the caller report it.
 */
export function canonicalSide(labels, side) {
  const claim = String(side);
  if (!Array.isArray(labels) || labels.length === 0) return claim;
  if (labels.includes(claim)) return claim;
  const hits = [];
  for (const label of labels) {
    if (sideIndexOf([label], claim) === 0) hits.push(String(label));
  }
  if (hits.length === 0) return claim;
  if (hits.some((h) => h !== hits[0])) return claim;
  return hits[0];
}

export const claimedSides = (v, knownSides) => {
  const canon = (s) => canonicalSide(knownSides, s);
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).map(canon);
  const whole = String(v).trim();
  const pieces = whole.split(/\s*,\s*(?![^{]*})/).map((s) => s.trim()).filter(Boolean);
  if (!knownSides || !knownSides.length) return pieces;
  const known = new Set(knownSides);
  // Exact first, in both shapes, so the tolerance below can only ever be a
  // fallback: a comma-joined pair of short labels must never be swallowed by a
  // truncated label it happens to share a prefix with.
  if (known.has(whole)) return [whole];
  if (pieces.length > 1 && pieces.every((s) => known.has(s))) return pieces;
  // PIECES BEFORE THE TOLERANT WHOLE, and the order is the whole point.
  //
  // With the tolerant whole-string match first, a comma-joined two-side claim
  // whose FIRST piece is the untruncated spelling of a truncated label matches
  // that one label as a prefix, and the second side disappears:
  //
  //   labels  ["…mixerType === mixerType)?.qu…", "[]"]
  //   reaches "…?.questions, []"   ->  1 side, the "[]" claim silently gone
  //
  // Before the tolerance existed that returned `[whole]`, which validate and
  // record both rejected loudly as "not a side of this arm". Accepting it
  // instead leaves a side unaccounted in the ledger with nothing said - a
  // quiet miscount is worse than the loud rejection it replaced. Nothing in
  // either repo hits it today (0 of 797 `reaches` entries), which is why it
  // has to be closed now rather than after it appears.
  if (pieces.length > 1 && pieces.every((s) => sideIndexOf(knownSides, s) !== -1)) return pieces.map(canon);
  if (sideIndexOf(knownSides, whole) !== -1) return [canon(whole)];
  return [whole];
};

/**
 * TOOL BACKLOG: DECORATOR METADATA IS A TRANSPILE ARTIFACT TOO (profile-ms).
 *
 * With `emitDecoratorMetadata`, a transform that honours it (oxc under vitest
 * 4, swc) writes `design:paramtypes` as `typeof (_a = typeof T !== "undefined"
 * && T) === "function" ? _a : Object` for each class-typed constructor
 * parameter, located at the class's decorator. istanbul instruments that
 * ternary as a 2-side cond-expr; the scan models source, has no arm there, and
 * no input can take the `Object` side. profile-ms's AppController(private
 * readonly appService: AppService) was exactly this: coverage recorded 55
 * uncovered sides, the worklist 53, and the self-check refused the run as a
 * join defect. Counted here as declined, like an enum's `X || (X = {})`: a
 * cond-expr istanbul placed on a line that is a decorator, where the scan has
 * no arm.
 */
export function decoratorMetadataSides(scan, final, repoRoot = "", readSource = (abs) => readFileSync(abs, "utf8")) {
  if (!final) return 0;
  const armLines = new Set();
  for (const fn of scan.functions ?? []) {
    for (const a of fn.arms?.list ?? []) armLines.add(`${fn.file}:${a.line}`);
  }
  for (const m of scan.moduleScopeArms ?? []) for (const a of m.list ?? []) armLines.add(`${m.file}:${a.line}`);
  let sides = 0;
  for (const [abs, entry] of Object.entries(final)) {
    const rel = repoRoot && abs.startsWith(`${repoRoot}/`) ? abs.slice(repoRoot.length + 1) : abs;
    let lines = null;
    for (const [id, b] of Object.entries(entry.branchMap ?? {})) {
      if (b.type !== "cond-expr") continue;
      const line = b.loc?.start?.line;
      if (!line || armLines.has(`${rel}:${line}`)) continue;
      if (lines === null) {
        try { lines = readSource(abs).split("\n"); } catch { lines = []; }
      }
      if (!/^\s*@/.test(lines[line - 1] ?? "")) continue;
      sides += (entry.b?.[id] ?? []).filter((c) => c === 0).length;
    }
  }
  return sides;
}
