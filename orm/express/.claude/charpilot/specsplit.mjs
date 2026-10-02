/**
 * N6: AN EMITTED SPEC PAST A SIZE IS WRITTEN AS PARTS.
 *
 * qode-ptp-ms's corpus (run 20260930T133720Z, landing
 * characterize/f8034843-20260930T133720Z): src/lib/server/services/
 * aiInterviewService.ts has about 250 recorded rows, and emit wrote all of them
 * into one spec, lib-server-services-aiInterviewService.char.test.ts, 34.3 MB
 * (the next largest is 17.6 MB). That one file is behind two defects:
 *   - D90: vitest 2.1.9's worker gives the fetch of a spec a fixed 60 s, and
 *     vite's SSR transform of the 34 MB file took longer on a loaded host - in
 *     the full run, and on 20260930T170133Z even alone;
 *   - D91: vitest's main process keeps every loaded spec's transform, about 9
 *     bytes of heap per byte, and the 34 MB file is a 300 MB-plus step on top
 *     of a heap already at V8's limit.
 * A spec is one source file's rows because a reader looking for the tests of
 * a file should find them in one place. Past SPLIT_MB that is not worth a
 * file vitest cannot load, so emit writes `<key>.part-<n>.char.test.ts`
 * instead: the same rows, each rendered exactly as it would be in the one
 * file, in parts of about SPLIT_MB each.
 *
 * DETERMINISTIC BY ROW ID. A row's part is its id's hash modulo the number of
 * parts, and the number of parts is the whole file's size over the bound. A
 * re-emit of the same rows writes the same parts byte for byte, and a new row
 * changes only its own part - unless it tips the file over into one more part.
 * A part no row hashed to is not written, so the numbers can skip.
 *
 * Every name ends in the corpus suffix, so every glob and `isCorpusSpec` still
 * take it. What maps a SOURCE file to its spec (cigate's D75 trace, record's
 * shrink plan) asks `specsOfKey` for all of them.
 *
 * `CHARPILOT_SPEC_SPLIT=off` writes one file per source file, as before;
 * `CHARPILOT_SPEC_SPLIT_MB` moves the bound.
 */
import { createHash } from "node:crypto";

export const SPEC_SPLIT_ENV = "CHARPILOT_SPEC_SPLIT";
export const SPEC_SPLIT_MB_ENV = "CHARPILOT_SPEC_SPLIT_MB";
/** The bound, in MB, when none is set: comfortably under what loaded in time on a loaded host. */
export const SPLIT_MB = 6;

const MB = 1048576;

/** The bound in bytes, or null when splitting is off. */
export function splitBytes(env = process.env) {
  if (String(env[SPEC_SPLIT_ENV] ?? "").trim().toLowerCase() === "off") return null;
  const mb = Number.parseFloat(String(env[SPEC_SPLIT_MB_ENV] ?? "").trim());
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : SPLIT_MB) * MB);
}

/** How many parts a file of `bytes` is written as: 1 when it is within `bound`. */
export const partCount = (bytes, bound) => (bound && bytes > bound ? Math.ceil(bytes / bound) : 1);

/** A row's part, 1-based: its id's hash modulo `n`. */
export function partOf(id, n) {
  if (n <= 1) return 1;
  const h = Number.parseInt(createHash("sha256").update(String(id)).digest("hex").slice(0, 12), 16);
  return (h % n) + 1;
}

/** The key a part is written under. */
export const partKey = (key, i) => `${key}.part-${i}`;

/**
 * `rows` as the parts they are written in: `[[partKey, rows]]` in part order,
 * each part's rows in the order they came, and no empty part.
 */
export function splitRows(key, rows, n, idOf = (r) => r.id) {
  if (n <= 1) return [[key, rows]];
  const parts = new Map();
  for (const r of rows) {
    const i = partOf(idOf(r), n);
    if (!parts.has(i)) parts.set(i, []);
    parts.get(i).push(r);
  }
  return [...parts.keys()].sort((a, b) => a - b).map((i) => [partKey(key, i), parts.get(i)]);
}

/** Whether `name` is the spec of `key`, whole or a part of it. */
export function isSpecOfKey(name, key, suffix) {
  if (name === `${key}${suffix}`) return true;
  if (!name.startsWith(`${key}.part-`) || !name.endsWith(suffix)) return false;
  return /^\d+$/.test(name.slice(`${key}.part-`.length, name.length - suffix.length));
}

/** The spec file names among `names` that hold `key`'s rows, whole or in parts, sorted. */
export const specsOfKey = (key, names, suffix) => names.filter((n) => isSpecOfKey(n, key, suffix)).sort();
