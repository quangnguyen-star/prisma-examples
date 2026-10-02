/**
 * attempts.mjs — one line per held row per round: what was tried, and what came back.
 *
 * PLAN 20, T2.3, THE OBSERVATION HALF. The replay `tools/tailstat.py
 * --salvage-sim` ruled a row `open` after 3 identical faults in a row and found
 * that 41 of the 68 rows it would have given up on had arms the run covered
 * later anyway (60%). The log carries each held row's FAULT but not what the
 * worker SUBMITTED, so "the same fault" could not be told from "the same input,
 * the same fault" — and only the second is no progress. This ledger records
 * both, so the rule can be replayed on real fingerprints before anything is
 * built on it.
 *
 * WHO READS IT. With CHARPILOT_SALVAGE_OPEN off (the default) nothing does: it
 * is an append-only measurement, like `packetlog.mjs`'s packet log. With it on,
 * `derive.run` reads it to keep salvaged sides out of the deal (`salvagedRows`
 * below) -- and never `satisfied`: `steps.never-repair-a-tools-output` forbids
 * a step from answering "am I done" out of its own writing, so the walk is
 * stopped the way the yield ratchet stops it, from `run`.
 *
 * A LINE:
 *   round        derive's materialising round
 *   step         who judged it ("derive")
 *   id, file, at the row
 *   fingerprint  a digest of the row's INPUT fields only (below), so a changed
 *                input or boundary setup is a different fingerprint and a
 *                reworded note is not
 *   outcome      the first fault's reason, with volatile text normalised away
 *   by           the tool that said so (validate.mjs, coverage.mjs)
 *   arms         the arms the row covers or claims to reach
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ATTEMPTS_DIRNAME = "attempts";
export const ATTEMPTS_FILE = "attempts.jsonl";

/**
 * The fields that ARE the attempt: what the recorder will run and how. Prose
 * (`note`, `why`, `behaviour` text inside a boundary is kept, because a
 * boundary's `mock` and `behaviour` are what stage 4 installs) and the row's
 * own `id` are not, so renaming a row or rewording its note is not progress.
 */
export const FINGERPRINT_FIELDS = Object.freeze([
  "functionId", "invoke", "via", "args", "build", "boundaries", "setup", "env", "seeds", "before", "after",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

/** A 16-hex digest of the row's input fields, or "none" for no row. */
export function rowFingerprint(row) {
  if (!row || typeof row !== "object") return "none";
  const picked = {};
  for (const k of FINGERPRINT_FIELDS) if (row[k] !== undefined) picked[k] = row[k];
  return createHash("sha256").update(JSON.stringify(stable(picked))).digest("hex").slice(0, 16);
}

const VOLATILE = /(\/tmp\/\S+|\/private\/\S+|\b\d{4}-\d\d-\d\dT[\d:.]+Z?\b)/g;

/** A fault reason with nothing volatile in it, so two identical outcomes compare equal. */
export function normaliseOutcome(why) {
  return String(why ?? "").replace(VOLATILE, "<v>").trim();
}

/**
 * The ledger lines for one round, from a held-row map (`allHeld(judgement)`).
 * Each held row is read back from its proposals file for its body, because the
 * held entry carries only the row's address, `covers` and `reaches`.
 */
export function attemptLines(held, proposalsDir, { round = null, step = "derive" } = {}) {
  const docs = new Map();
  const bodyOf = (file, at) => {
    if (!docs.has(file)) {
      let doc = null;
      try {
        doc = JSON.parse(readFileSync(join(proposalsDir, file), "utf8"));
      } catch {
        doc = null;
      }
      docs.set(file, doc);
    }
    return docs.get(file)?.proposals?.[at] ?? null;
  };
  const out = [];
  for (const row of held?.values?.() ?? []) {
    const body = bodyOf(row.file, row.at);
    const fault = row.faults?.[0] ?? {};
    const arms = new Set([...(row.covers ?? []), ...Object.keys(row.reaches ?? {})]);
    const sides = [];
    for (const [arm, value] of Object.entries(row.reaches ?? {})) {
      for (const side of Array.isArray(value) ? value : [value]) sides.push(`${arm} [${side}]`);
    }
    out.push({
      round,
      step,
      id: row.id ?? null,
      file: row.file,
      at: row.at,
      fingerprint: rowFingerprint(body),
      outcome: normaliseOutcome(fault.why),
      by: fault.by ?? "validate.mjs",
      arms: [...arms].sort(),
      sides: sides.sort(),
    });
  }
  return out.sort((a, b) => `${a.file}${a.at}`.localeCompare(`${b.file}${b.at}`));
}

/** Append this round's lines to `<outDir>/attempts/attempts.jsonl`. Never throws. */
export function recordAttempts(outDir, lines) {
  if (!lines?.length) return 0;
  try {
    const dir = join(outDir, ATTEMPTS_DIRNAME);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, ATTEMPTS_FILE), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
    return lines.length;
  } catch {
    return 0;
  }
}

/** Every ledger line on disk, oldest first. Unreadable lines are skipped. */
export function readAttempts(outDir) {
  const path = join(outDir, ATTEMPTS_DIRNAME, ATTEMPTS_FILE);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line is not a reason to lose the rest
    }
  }
  return out;
}

export const salvageOn = (env = process.env) => env.CHARPILOT_SALVAGE_OPEN !== "off";
export const salvageAfter = (env = process.env) => {
  const n = Number(env.CHARPILOT_SALVAGE_OPEN_AFTER);
  return Number.isInteger(n) && n >= 2 ? n : 3;
};

/**
 * PLAN 20 T2.3 — THE ROWS WITH NO PROGRESS, from the ledger alone.
 *
 * A row is salvaged when it was held in `after` CONSECUTIVE rounds, ending with
 * `round`, each time with the SAME fingerprint (the same input and boundary
 * setup) and the SAME outcome. Either changing is progress and restarts the
 * count: a worker that changed the input is still trying, and a recorder that
 * says something new is new evidence. A row not held this round is not
 * salvaged, whatever its history, because the latest reading is what counts.
 *
 * This is a BOUNDED SALVAGE POLICY and not a quality-preserving change: it gives
 * up the chance that one more identical attempt would have closed the side. The
 * replay on fault text alone (`tailstat --salvage-sim`) found that 60% of such
 * rows were covered later, which is why it keys on the fingerprint too, and why
 * it is on unless CHARPILOT_SALVAGE_OPEN=off.
 */
export function salvagedRows(lines, { round, after = 3 } = {}) {
  const byRow = new Map();
  for (const l of lines) {
    const key = l.id ?? `${l.file}#${l.at}`;
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(l);
  }
  const out = [];
  for (const [key, seen] of byRow) {
    // ONE READING PER ROUND: a second walk in the same round writes the row
    // again, and two lines of one round are one attempt, the later one.
    const perRound = new Map();
    for (const l of [...seen].sort((a, b) => (a.round ?? 0) - (b.round ?? 0))) perRound.set(l.round, l);
    const rows = [...perRound.values()];
    const last = rows[rows.length - 1];
    if (!Number.isInteger(last.round) || last.round !== round) continue;
    let streak = 1;
    for (let i = rows.length - 2; i >= 0; i--) {
      const r = rows[i];
      if (r.round !== rows[i + 1].round - 1) break;
      if (r.fingerprint !== last.fingerprint || r.outcome !== last.outcome) break;
      streak += 1;
    }
    if (streak >= after) out.push({ row: key, id: last.id, file: last.file, sides: last.sides ?? [], arms: last.arms ?? [],
      outcome: last.outcome, by: last.by, attempts: streak, round });
  }
  return out;
}

export const SALVAGED_FILE = "salvaged.json";

/** Rewrite `<outDir>/salvaged.json`, which coverage.mjs reads for its rulings. Never throws. */
export function writeSalvaged(outDir, payload) {
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, SALVAGED_FILE), JSON.stringify(payload, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
