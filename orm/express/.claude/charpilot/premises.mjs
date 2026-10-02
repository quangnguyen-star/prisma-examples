/**
 * D60 — A RULING WRITTEN WHILE THE SCAN FOUND NO WAY IN IS RE-CHECKED WHEN IT FINDS ONE.
 *
 * A side is dealt as a DECLARATION question ("write the reason this side cannot
 * be reached") exactly when the scan resolves no way to call its function: no
 * own entry, no driver, no trigger (derive `kindOf`). The answer it gets is a
 * BLOCKED.md entry, and that entry's premise is the scan's reachability fact at
 * the time - the fence carries arm, side, category, killer and proof, and not
 * the fact it rests on. Nothing re-checked it. sourcing-ms, run
 * 20260926T222646Z: 159 needs-seam rulings in search-debug.service.ts cite
 * exactly "via: unresolved ... did not reach a callable function", D58 fixed
 * the scan so 15 of those 16 functions now resolve to `SearchDebugService.execute`,
 * and every one of the rulings still stood - counted reasoned by derive,
 * `unreachable` by coverage.mjs - although the sides were now reachable. Only
 * `_countSkillsAtLeast1InTree`'s 18 sides (its one reference is its own
 * recursive call) are really uncallable.
 *
 * WHAT THIS KEEPS, per entry: the reachability fact of the entry's function in
 * the scan the entry was written under (`wayIn`), in out/blocked-premises.json -
 * NOT a seventh BLOCKED.md field, which blocked.mjs refuses by design. An entry
 * with no stamp is stamped from the scan on disk the first time this sees it,
 * and steps/scan.mjs does that BEFORE it re-scans, so an entry carried in by a
 * checkpoint is stamped from the scan it was carried in with - the one it was
 * written under - and not from the scan that is about to replace it. (An entry
 * older than that scan is stamped from it too: the premise this cannot recover
 * is only one the scan before it had already fixed.)
 *
 * WHAT IT DECIDES, and it decides it for EVERY category: an entry stamped
 * `wayIn: false` whose function the current scan gives a way in is SUPERSEDED.
 * Not only needs-seam - a declaration question was dealt BECAUSE of the fact,
 * whatever category the answer chose. A superseded entry is REMOVED from
 * BLOCKED.md (the prose above its fence with it) and kept here with its fields
 * and prose, so its sides are simply open to every reader alike - coverage.mjs,
 * the ledger and derive - and derive deals them as input questions with the
 * driver contract (D58), saying in the packet which ruling they replace. That
 * is the same path a refused entry takes: superseded -> open -> dealt.
 *
 * AND ITS SUBMISSION IS NOT MATERIALISED AGAIN. The declaration that produced
 * the entry is still in charpilot-answers/ (derive cannot delete a consumed
 * submission), and with the entry gone derive would read it as unanswered and
 * write it straight back. The records name the submissions that held a
 * matching declaration when the entry was superseded, and derive skips exactly
 * those; a NEW declaration of the same side - in the fresh answer file each
 * round's packet reserves (D62), against a scan that now finds a way in - lands
 * and is stamped `wayIn: true`, so it is never superseded for this again.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { OUT_DIR, PROPOSALS_DIR } from "./config.mjs";
import { blockedEntries, sidesOf } from "./ledger.mjs";

export const PREMISES_JSON = join(OUT_DIR, "blocked-premises.json");
const BLOCKED_MD = join(PROPOSALS_DIR, "BLOCKED.md");

/**
 * The scan's own "no way in", as derive `kindOf` decides a declaration question
 * from it: no reachable own entry, no driver, and not a framework trigger. One
 * definition, so the fact a ruling was dealt under and the fact it is
 * re-checked against cannot drift.
 */
export function noWayIn({ entry, via } = {}) {
  const drivers = via ? (via.drivers ?? [via.driver]).filter(Boolean) : [];
  return !entry?.reachable && !drivers.length && via?.kind !== "trigger";
}

/** How the scan gets in, said the way a person reads it, or null when it does not. */
export function wayInSaid(fn) {
  if (!fn) return null;
  if (fn.entry?.reachable) return `its own entry (${fn.entry.kind ?? "entry"})`;
  const drivers = fn.via ? (fn.via.drivers ?? [fn.via.driver]).filter(Boolean) : [];
  if (drivers.length) return `${fn.via.kind ?? "via"} ${drivers.slice(0, 3).join(", ")}${drivers.length > 3 ? ` +${drivers.length - 3} more` : ""}`;
  if (fn.via?.kind === "trigger") return "a framework trigger";
  return null;
}

/** armId -> the scan's function record that holds the arm. Module-scope arms have none. */
export function functionsByArm(scan) {
  const out = new Map();
  for (const f of scan?.functions ?? []) {
    for (const a of f?.arms?.list ?? []) if (a?.armId) out.set(a.armId, f);
    if (f?.entryArmId) out.set(f.entryArmId, f);
  }
  return out;
}

/** The scan a premise was read from, named so the record says which one. */
export function scanStamp(scan) {
  return scan ? `${scan.generatedAt ?? "?"} @ ${String(scan.gitSha ?? "?").slice(0, 8)} / scan.mjs ${String(scan.scanTool?.sha256 ?? "unrecorded").slice(0, 12)}` : null;
}

/** One entry's identity: its fields, with the sides as the arm's labels, in order. */
export function premiseKey(fields, labels) {
  const sides = [...sidesOf(fields?.side ?? "", labels ?? new Set())].sort();
  return createHash("sha256")
    .update(JSON.stringify([fields?.arm ?? null, sides, fields?.category ?? null, fields?.killer ?? null, fields?.proof ?? null]))
    .digest("hex")
    .slice(0, 16);
}

export function readPremises(path = PREMISES_JSON) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return { stage: "blocked-premises", validatedAgainst: null, entries: {}, superseded: [], ...doc };
  } catch {
    return { stage: "blocked-premises", validatedAgainst: null, entries: {}, superseded: [] };
  }
}

function writePremises(doc, path = PREMISES_JSON) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Stamp every BLOCKED.md entry that has no premise yet, from `scan`. Returns
 * how many were stamped. Writes nothing when there is nothing to stamp.
 */
export function stampPremises(scan, { labelsByArm = new Map(), blockedPath = BLOCKED_MD, premisesPath = PREMISES_JSON } = {}) {
  if (!scan || !existsSync(blockedPath)) return 0;
  const { entries } = blockedEntries(readFileSync(blockedPath, "utf8"), null);
  const doc = readPremises(premisesPath);
  const byArm = functionsByArm(scan);
  let n = 0;
  for (const e of entries) {
    const k = premiseKey(e, labelsByArm.get(e.arm));
    if (doc.entries[k]) continue;
    const fn = byArm.get(e.arm);
    if (!fn) continue;
    doc.entries[k] = {
      arm: e.arm,
      side: e.side,
      category: e.category ?? null,
      functionId: fn.id,
      wayIn: !noWayIn(fn),
      how: wayInSaid(fn),
      ...(fn.via?.note ? { note: fn.via.note } : {}),
      stampedFrom: scanStamp(scan),
    };
    n += 1;
  }
  if (n) writePremises(doc, premisesPath);
  return n;
}

/**
 * The fence and the prose a person reads above it, as one span: from the `##`
 * heading that opens it (or the end of the block before) to the end of the fence.
 */
function spanOf(text, blocks, i) {
  const b = blocks[i];
  const floor = i > 0 ? blocks[i - 1].end : 0;
  const heading = text.lastIndexOf("\n## ", b.start);
  const start = heading >= floor ? heading + 1 : i > 0 ? floor : b.start;
  let end = b.end;
  if (text[end] === "\n") end += 1;
  return { start, end };
}

/**
 * A submission's address WITH the entry it declares: the file, the index and
 * the premise key. A worker that rewrites the same file later with something
 * else at that index is a different submission, and is materialised.
 */
export const submissionTag = (file, at, key) => `${file}#${at}@${key}`;

/** Every declaration in charpilot-answers/ that names one of these entries, as `submissionTag`s. */
function submissionsFor(keys, answersDir, labelsByArm) {
  const out = new Map();
  if (!answersDir || !existsSync(answersDir)) return out;
  for (const name of readdirSync(answersDir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(answersDir, name), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(doc?.declarations)) continue;
    doc.declarations.forEach((d, i) => {
      if (!d || typeof d !== "object") return;
      const side = Array.isArray(d.side) ? d.side.map((s) => String(s).trim()).join(",") : String(d.side ?? "").trim();
      const trim = (v) => (typeof v === "string" ? v.trim() : v);
      const k = premiseKey({ arm: trim(d.arm), side, category: trim(d.category), killer: trim(d.killer), proof: trim(d.proof) }, labelsByArm.get(trim(d.arm)));
      if (!keys.has(k)) return;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(submissionTag(name, `declarations[${i}]`, k));
    });
  }
  return out;
}

/**
 * Re-check every stamped entry against `scan`, and supersede the ones whose
 * premise no longer holds. Entries with no stamp are stamped from `scan` first
 * (they were written under it). Returns
 * `{ superseded: [record], kept: [{arm, functionId}] , stamped }` for this pass.
 */
export function revalidatePremises(scan, { labelsByArm = new Map(), answersDir = null, blockedPath = BLOCKED_MD, premisesPath = PREMISES_JSON, now = new Date() } = {}) {
  const result = { superseded: [], kept: [], stamped: 0 };
  if (!scan) return result;
  const validatedAgainst = scanStamp(scan);
  if (!existsSync(blockedPath)) {
    const doc = readPremises(premisesPath);
    if (doc.validatedAgainst !== validatedAgainst) writePremises({ ...doc, validatedAgainst }, premisesPath);
    return result;
  }
  result.stamped = stampPremises(scan, { labelsByArm, blockedPath, premisesPath });
  const doc = readPremises(premisesPath);
  const byArm = functionsByArm(scan);
  const text = readFileSync(blockedPath, "utf8");
  const parsed = blockedEntries(text, null);
  const stale = [];
  parsed.blocks.forEach((b, i) => {
    if (!b.fields.arm || !b.fields.side) return;
    const k = premiseKey(b.fields, labelsByArm.get(b.fields.arm));
    const premise = doc.entries[k];
    if (!premise || premise.wayIn !== false) return;
    const fn = byArm.get(b.fields.arm);
    if (!fn) return;
    if (noWayIn(fn)) {
      result.kept.push({ arm: b.fields.arm, functionId: fn.id });
      return;
    }
    stale.push({ i, k, premise, fn });
  });
  if (stale.length) {
    // THE SAME DISCIPLINE AS blocked.mjs: its lock, a temp file and a rename,
    // and the reader's own parser agreeing that exactly these fences went and
    // every other one is byte-for-byte what it was.
    const lock = `${blockedPath}.lock`;
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
    } catch (err) {
      throw new Error(`could not take ${lock} to supersede ${stale.length} BLOCKED.md entr(ies): ${err?.code === "EEXIST" ? "another writer holds it" : err?.message}`);
    }
    try {
      const spans = stale.map((s) => ({ ...s, ...spanOf(text, parsed.blocks, s.i) }));
      let out = "";
      let at = 0;
      for (const s of [...spans].sort((a, b) => a.start - b.start)) {
        out += text.slice(at, s.start);
        at = s.end;
      }
      out += text.slice(at);
      const after = blockedEntries(out, null);
      const gone = new Set(stale.map((s) => s.i));
      const kept = parsed.blocks.filter((_, i) => !gone.has(i)).map((b) => JSON.stringify(b.fields));
      if (JSON.stringify(after.blocks.map((b) => JSON.stringify(b.fields))) !== JSON.stringify(kept)) {
        throw new Error("the rewritten BLOCKED.md would not parse back to every entry it kept - nothing was written");
      }
      const subs = submissionsFor(new Set(stale.map((s) => s.k)), answersDir, labelsByArm);
      const tmp = `${blockedPath}.tmp`;
      writeFileSync(tmp, out);
      renameSync(tmp, blockedPath);
      for (const s of spans) {
        const record = {
          key: s.k,
          arm: parsed.blocks[s.i].fields.arm,
          side: parsed.blocks[s.i].fields.side,
          sides: sidesOf(parsed.blocks[s.i].fields.side, labelsByArm.get(parsed.blocks[s.i].fields.arm) ?? new Set()),
          fields: parsed.blocks[s.i].fields,
          prose: text.slice(s.start, s.end),
          functionId: s.fn.id,
          was: `the scan found no way to call ${s.fn.name ?? s.fn.id}${s.premise.note ? ` (${s.premise.note})` : ""} - ${s.premise.stampedFrom}`,
          now: `the scan reaches it through ${wayInSaid(s.fn)} - ${validatedAgainst}`,
          submissions: subs.get(s.k) ?? [],
          supersededAt: now.toISOString(),
        };
        doc.superseded.push(record);
        result.superseded.push(record);
        delete doc.entries[s.k];
      }
    } finally {
      try {
        unlinkSync(lock);
      } catch {}
    }
  }
  writePremises({ ...doc, validatedAgainst }, premisesPath);
  return result;
}

/** Whether out/blocked-premises.json was last validated against this scan. */
export function validatedAgainst(scan, premisesPath = PREMISES_JSON) {
  return readPremises(premisesPath).validatedAgainst === scanStamp(scan);
}

/**
 * The superseded rulings derive reads: `bySide` (armId\0side -> record) for the
 * packet, and `submissions` (`submissionTag`s) it must not materialise again.
 */
export function supersededRulings(premisesPath = PREMISES_JSON) {
  const doc = readPremises(premisesPath);
  const bySide = new Map();
  const submissions = new Set();
  for (const r of doc.superseded ?? []) {
    for (const s of r.sides ?? []) bySide.set(`${r.arm}\u0000${s}`, r);
    for (const x of r.submissions ?? []) submissions.add(x);
  }
  return { bySide, submissions };
}
