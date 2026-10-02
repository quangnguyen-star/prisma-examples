/**
 * `recorded.json`, SHARDED WHEN ONE FILE WOULD NOT FIT ON THE REMOTE (D57).
 *
 * WHAT IT IS. The recording the corpus carries beside its specs (record.mjs
 * `recordedRows`): every emitted row's input, outcome and boundary calls, keyed
 * by stableId, so a later run can diff the commit it was taken against and
 * reuse what did not change (sincelast.mjs), and so cigate / emit / verify can
 * name which observation a verdict judged. The specs do NOT read it: every
 * expected value is rendered into the spec itself, so replay never touches this
 * file and sharding it changes nothing a test does.
 *
 * WHY SHARDS. qode-ptp-ms run 20260926T130032Z emitted 1,404 rows, and their
 * boundary calls (a node-redis client's 60-odd methods, recorded per call) made
 * ONE recorded.json of 110,050,290 bytes. GitHub refuses any file over 100 MiB
 * (GH001, "File test/characterization/recorded.json is 104.95 MB; this exceeds
 * GitHub's file size limit of 100.00 MB") and warns over 50 MiB. It is part of
 * the delivered suite, so that run could never be delivered: its PR push came
 * back as `HTTP 500 ... the remote end hung up unexpectedly`, and every
 * checkpoint push of the run was refused for the same file.
 *
 * WHAT IT DOES NOW. Under SHARD_BYTES the file is written exactly as before -
 * one `recorded.json` holding `rows` - so a small corpus is byte-for-byte what
 * it was. Over it, `recorded.json` keeps the header (recordedAgainst, harness,
 * emitter, ...) with `shards` and `rowCount` in place of `rows`, and the rows
 * go to `recorded/<spec key>.json`: one file per spec file, the key the emitter
 * names the spec by, so the recording of `lib-server-services-foo.char.test.ts`
 * is `recorded/lib-server-services-foo.json`. A spec whose rows alone pass
 * SHARD_BYTES continues in `<key>.2.json`, `<key>.3.json`, ... Every reader goes
 * through `readRecorded`, which gives back the same document either way.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RECORDED = "recorded.json";
export const SHARD_DIR = "recorded";
/**
 * The largest file this writes. GitHub refuses 100 MiB and warns at 50 MiB;
 * a quarter of the hard limit leaves room for a spec that grows between runs,
 * and keeps each shard a diff a reviewer's browser can still open.
 */
export const SHARD_BYTES = 25 * 1024 * 1024;
/** What a shard's name may be: never a path out of the corpus. */
const SHARD_NAME = /^recorded\/[A-Za-z0-9_.@-]+\.json$/;

/**
 * The spec a row is emitted into, as record.mjs names it: the head of its
 * functionId with `src/` and `.ts` dropped and `/` turned into `-`.
 */
export function shardKey(row) {
  const src = String(row?.functionId ?? row?.file ?? "rows").split(":")[0];
  return src.replace(/^src\//, "").replace(/\.ts$/, "").replace(/\//g, "-").replace(/[^A-Za-z0-9_.@-]/g, "_") || "rows";
}

const text = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * The files one recording is written as: a Map of corpus-relative path to text,
 * `recorded.json` LAST so a landing that follows this order moves the index in
 * only after every shard it names.
 */
export function renderRecorded(doc, { maxBytes = SHARD_BYTES } = {}) {
  const whole = text(doc);
  if (Buffer.byteLength(whole) <= maxBytes) return new Map([[RECORDED, whole]]);
  const { rows = [], ...header } = doc;
  const byKey = new Map();
  for (const row of rows) {
    const key = shardKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const files = new Map();
  for (const [key, group] of byKey) {
    // Cut by the size each row takes where it will sit: two levels in, so four
    // more spaces a line than its own JSON.stringify.
    let part = [];
    let bytes = 0;
    let n = 1;
    const flush = () => {
      if (!part.length) return;
      const name = `${SHARD_DIR}/${key}${n === 1 ? "" : `.${n}`}.json`;
      files.set(name, text({ shard: key, part: n, rows: part }));
      part = [];
      bytes = 0;
      n += 1;
    };
    for (const row of group) {
      const own = JSON.stringify(row, null, 2);
      const size = Buffer.byteLength(own) + 4 * (own.split("\n").length) + 2;
      if (part.length && bytes + size > maxBytes) flush();
      part.push(row);
      bytes += size;
    }
    flush();
  }
  files.set(RECORDED, text({ ...header, rowCount: rows.length, shards: [...files.keys()] }));
  return files;
}

/** Write a rendering (renderRecorded) under `dir`, e.g. the emit's staging directory. */
export function writeRecorded(dir, files) {
  for (const [rel, body] of files) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
}

/**
 * Move a staged rendering into the corpus: the shards first, the index last,
 * then the shards the previous recording named and this one does not. Only
 * files in `recorded/` with a shard's name are ever removed; anything else in
 * there is not this tool's.
 */
export function landRecorded(stage, target, files) {
  const names = [...files.keys()];
  for (const rel of names.filter((r) => r !== RECORDED)) {
    mkdirSync(dirname(join(target, rel)), { recursive: true });
    renameSync(join(stage, rel), join(target, rel));
  }
  renameSync(join(stage, RECORDED), join(target, RECORDED));
  const keep = new Set(names);
  const dir = join(target, SHARD_DIR);
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const rel = `${SHARD_DIR}/${f}`;
    if (SHARD_NAME.test(rel) && !keep.has(rel)) rmSync(join(dir, f), { force: true });
  }
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch {
    // Not empty, or already gone: either way nothing of ours is left in it.
  }
}

/**
 * The recording under corpus directory `dir`, with `rows` whichever way it was
 * written. Throws as JSON.parse / readFileSync would when there is none, which
 * is what every caller already handles; a shard that is missing, or rows that
 * do not add up to `rowCount`, throw too - half a recording read as the whole
 * one would tell sincelast that rows were never recorded.
 */
export function readRecorded(dir) {
  const doc = JSON.parse(readFileSync(join(dir, RECORDED), "utf8"));
  if (!Array.isArray(doc?.shards)) return doc;
  const rows = [];
  for (const rel of doc.shards) {
    if (typeof rel !== "string" || !SHARD_NAME.test(rel)) {
      throw new Error(`${RECORDED} names a shard that is not one (${JSON.stringify(rel)})`);
    }
    rows.push(...(JSON.parse(readFileSync(join(dir, rel), "utf8")).rows ?? []));
  }
  if (Number.isInteger(doc.rowCount) && rows.length !== doc.rowCount) {
    throw new Error(`${RECORDED} names ${doc.rowCount} row(s) and its ${doc.shards.length} shard(s) hold ${rows.length}`);
  }
  const { shards: _s, rowCount: _n, ...header } = doc;
  return { ...header, rows };
}
