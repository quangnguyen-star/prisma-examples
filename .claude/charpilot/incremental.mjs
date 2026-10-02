/**
 * THE INCREMENTAL WALK: what changed in the suite since a step last ran over
 * it, and when that step has to run over all of it anyway.
 *
 * WHAT A WALK USED TO COST, and why most of it bought nothing. Every walk
 * re-emitted the whole suite, ran the repo's CI config over every spec file
 * (cigate.mjs) and re-measured every spec file under istanbul (coverage.mjs),
 * whatever the agent had changed. qode-ptp-ms (18k sides) paid 28 minutes a
 * walk and reserved 223 minutes for its final one, so it stopped starting
 * agent turns with 80 minutes left; sourcing-ms paid 22 minutes and its walks
 * hit the exit-124 limit (docs/speed/README.md, sections 1, 3 and 6c). A round
 * that changed three rows paid for eighty-three spec files.
 *
 * THE DIRTY SET IS BYTES, NOT A GUESS ABOUT BYTES. A spec file's rendering is
 * a function of its rows AND of the falseClaims in coverage.json, the unstable
 * paths in determinism.json, the quarantine and the emitter (record.mjs:3527
 * onwards reads all four). A dirty set built from the rows alone would miss a
 * file whose row never changed but whose quarantine was lifted. So the files
 * that changed are the ones whose sha256 in `emitted.json` changed - the hash
 * record.mjs already writes per file (`emittedFileHashes`) - and the rows record
 * re-ran are carried beside them in out/dirty.json for the reader, never as the
 * thing a step trusts.
 *
 * WHO KEEPS WHAT. Each consumer keeps its OWN ledger of the suite it last ran
 * over - cigate.mjs in cigate.json, coverage.mjs in out/coverage-chunks/ - and
 * out/dirty.json says what the last emission changed. A partial run is allowed
 * only when the two AGREE: the consumer's ledger is the emission dirty.json
 * starts from, and the per-file diff it computes itself is the one dirty.json
 * names. Any disagreement, any file that cannot be read, anything on disk that
 * is not what emitted.json says, and the step runs over everything - it never
 * runs over less than it can prove is enough.
 *
 * WHAT A PARTIAL RUN CANNOT SEE, and why the walk still runs full passes. A
 * spec file can be red only in company: D48 (a row that runs past its budget
 * with 34 other files transforming beside it) and D52 (a mock one row's build
 * registers leaking into the next). So cigate runs the whole corpus on every
 * `--bank-only` walk, at every step's own position in ORDER (the visits a
 * report rests on), every `CHARPILOT_FULL_GATE_EVERY` passes, when anything the
 * suite runs under changed (`contextDigest`), and whenever a partial pass is
 * red. A report never rests on a partial gate.
 *
 * `CHARPILOT_INCREMENTAL_WALK=off` restores the full walk exactly: no step
 * passes `--incremental`, the coverage config goes back to the stock istanbul
 * provider, and the pack stops skipping a walk after an empty turn.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CORPUS_REL, FIXTURES_DIR, OUT_DIR, PILOT_DIR, REPO_ROOT, isCorpusSpec } from "./config.mjs";
import { targetNode } from "./cinode.mjs";

/** The kill switch. Anything but `off` is on. */
export const INCREMENTAL_ENV = "CHARPILOT_INCREMENTAL_WALK";
export const incrementalOn = (env = process.env) => String(env[INCREMENTAL_ENV] ?? "").trim().toLowerCase() !== "off";

/**
 * A full pass every N passes, whatever else is true: the cross-file red D48
 * and D52 describe is found at the latest N-1 walks after it appears, and the
 * report never waits for it (see the docblock).
 */
export const FULL_EVERY_ENV = "CHARPILOT_FULL_GATE_EVERY";
export const FULL_EVERY_DEFAULT = 5;
export function fullEvery(env = process.env) {
  const n = Number.parseInt(String(env[FULL_EVERY_ENV] ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : FULL_EVERY_DEFAULT;
}

/**
 * WHICH VISIT THIS IS, said by workflow.mjs before it asks a step anything.
 *
 * `banking` is a visit pulled forward to bank a round before `derive` hands
 * the next one over; it is the one that runs every round, and the only one a
 * partial gate may serve. `own` is the step at its own position in ORDER -
 * reached only on a walk that goes on to `report` - and `clearing` is D60's
 * splice. The bank walk sets CHARPILOT_BANK_WALK=1 for all of its visits.
 */
export const VISIT_ENV = "CHARPILOT_WALK_VISIT";
export const BANK_WALK_ENV = "CHARPILOT_BANK_WALK";
export const WALK_ID_ENV = "CHARPILOT_WALK_ID";

/** Null when a partial pass may serve this visit, else why it may not. */
export function partialVisitRefusal(env = process.env) {
  if (!incrementalOn(env)) return `${INCREMENTAL_ENV}=off`;
  if (String(env[BANK_WALK_ENV] ?? "") === "1") return "this is the bank walk, and the report it writes rests on a full gate";
  const visit = String(env[VISIT_ENV] ?? "");
  if (visit !== "banking") {
    return visit
      ? `this is the step's ${visit === "own" ? "own position in ORDER, which a report rests on" : `${visit} visit`}`
      : "no walk said which visit this is";
  }
  return null;
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** One digest for a `{ path: sha256 }` map, independent of key order. */
export function digestOfHashes(hashes) {
  const lines = Object.keys(hashes ?? {})
    .sort()
    .map((k) => `${k}\0${hashes[k]}\n`);
  return sha256(lines.join(""));
}

/** emitted.json's per-file hashes and their digest, or null when unreadable. */
export function manifestHashes(manifestPath = join(REPO_ROOT, CORPUS_REL, "emitted.json")) {
  try {
    const doc = JSON.parse(readFileSync(manifestPath, "utf8"));
    const hashes = doc?.emittedFileHashes;
    if (!hashes || typeof hashes !== "object" || !Object.keys(hashes).length) return null;
    return { hashes, digest: digestOfHashes(hashes) };
  } catch {
    return null;
  }
}

/**
 * The corpus spec files on disk now, hashed the way record.mjs hashes them
 * (sha256 of the utf8 text), keyed repo-relative like `emittedFileHashes`.
 */
export function diskHashes(dir = join(REPO_ROOT, CORPUS_REL), root = REPO_ROOT) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(isCorpusSpec).sort()) {
    const path = join(dir, f);
    try {
      if (!statSync(path).isFile()) continue;
      out[relative(root, path).split(sep).join("/")] = sha256(readFileSync(path, "utf8"));
    } catch {
      out[relative(root, path).split(sep).join("/")] = "unreadable";
    }
  }
  return out;
}

/** What moved between two `{ path: hash }` maps. Every list sorted. */
export function specDiff(before = {}, after = {}) {
  const changed = [];
  const added = [];
  const removed = [];
  let unchanged = 0;
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added.push(k);
    else if (before[k] !== v) changed.push(k);
    else unchanged += 1;
  }
  for (const k of Object.keys(before)) if (!(k in after)) removed.push(k);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort(), unchanged };
}

/**
 * The files on disk that disagree with emitted.json, as sentences: an edit, a
 * deletion or an addition nobody's emitter made. Any one of them means the
 * ledger's picture of the suite is not the suite, so the step runs full.
 */
export function diskDisagrees(manifest, disk) {
  const d = specDiff(manifest ?? {}, disk ?? {});
  return [
    ...d.changed.map((f) => `${f} differs from its emitted.json hash`),
    ...d.removed.map((f) => `${f} is in emitted.json and not on disk`),
    ...d.added.map((f) => `${f} is on disk and not in emitted.json`),
  ];
}

/* --------------------------------------------------------------------------
 * out/dirty.json — THE INTERFACE BETWEEN THE STEPS, written once per walk.
 *
 *   {
 *     "version": 1,
 *     "walk": "<CHARPILOT_WALK_ID of the walk that wrote it>",
 *     "rows":  { "changed": [ids], "removed": [ids], "source": "..." },
 *     "specs": { "from": <digest>, "to": <digest>,
 *                "changed": [paths], "added": [paths], "removed": [paths],
 *                "unchanged": <n> }
 *   }
 *
 * `rows` is what record (re)ran this walk: written by steps/record.mjs from a
 * diff of behaviour.json across the recorder's run, unless record.mjs already
 * wrote it itself for this walk (6b, keyed per row), in which case the step
 * keeps record.mjs's. `specs` is written by steps/emit.mjs from emitted.json
 * before and after `--emit-tests`: `from` and `to` are `digestOfHashes` of the
 * two manifests. Readers treat anything missing, unparseable or about another
 * emission as "no dirty set" and run full.
 * ------------------------------------------------------------------------ */
export const DIRTY_JSON = join(OUT_DIR, "dirty.json");

export function readDirty(path = DIRTY_JSON) {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return doc && typeof doc === "object" && doc.version === 1 ? doc : null;
  } catch {
    return null;
  }
}

/** Merge `patch` into this walk's dirty.json; another walk's document is replaced, not merged. */
export function writeDirty(patch, { path = DIRTY_JSON, walk = process.env[WALK_ID_ENV] ?? null } = {}) {
  const prior = readDirty(path);
  const base = prior && prior.walk === walk && walk !== null ? prior : { version: 1, walk };
  const doc = { ...base, ...patch, version: 1, walk, at: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
  return doc;
}

/* --------------------------------------------------------------------------
 * WHAT THE SUITE RUNS UNDER, apart from the spec files themselves.
 *
 * A spec file whose bytes did not change can still pass or fail differently if
 * anything it runs under did: the source it tests, the doubles, the root and
 * corpus vitest configs, recorded.env, the lockfile, a tool, the mode. All of
 * it is hashed here, and a digest that moved runs the step over everything.
 *
 * The repo is read through `git ls-files --cached --others --exclude-standard`,
 * so it is every file a commit could carry and nothing ignored (node_modules,
 * coverage reports); the directories the pipeline itself rewrites every walk
 * are left out, or the digest would move every walk and nothing would ever be
 * partial. What is left out, and why each is safe:
 *   the corpus's own spec files  - they are the thing being diffed, per file;
 *   emitted.json, recorded.json  - data about the specs no spec imports
 *   and recorded/*.json          (the recording's shards, D57);
 *   .claude/                     - the tools are hashed below, one by one;
 *   charpilot-answers/           - the agent's answers, which reach a spec
 *                                  only through a recording, i.e. its bytes;
 *   .github/                     - CI definitions (cicheck.mjs), which vitest
 *                                  never reads;
 *   coverage*                    - reports.
 * The fixtures directory is read directly as well, because a repo may ignore
 * it. A git that cannot answer returns a null digest, which runs full.
 * ------------------------------------------------------------------------ */
const CONTEXT_SKIP = [".claude/", "charpilot-answers/", ".github/"];

export function contextDigest({ root = REPO_ROOT, corpusRel = CORPUS_REL, pilotDir = PILOT_DIR, fixturesDir = FIXTURES_DIR, env = process.env } = {}) {
  const h = createHash("sha256");
  const add = (label, data) => {
    h.update(label);
    h.update("\0");
    h.update(data);
    h.update("\0");
  };
  try {
    for (const f of readdirSync(pilotDir).filter((n) => /\.(mjs|mts)$/.test(n)).sort()) add(`tool:${f}`, readFileSync(join(pilotDir, f)));
  } catch (err) {
    return { digest: null, why: `the installed tools could not be read (${err?.message ?? err})` };
  }
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listed.status !== 0 || listed.error) {
    return { digest: null, why: `git ls-files could not list the repo (${listed.error?.message ?? `exit ${listed.status}`})` };
  }
  const corpus = `${corpusRel.split(sep).join("/")}/`;
  const files = String(listed.stdout)
    .split("\0")
    .filter(Boolean)
    .filter((f) => !CONTEXT_SKIP.some((p) => f.startsWith(p)) && !/^coverage/.test(f))
    // recorded/<spec>.json too: the shards of a recording too big for one
    // file (D57, recordedstore.mjs) are the same data recorded.json is.
    .filter((f) => !f.startsWith(corpus) || !(isCorpusSpec(f) || /\/(emitted|recorded)\.json$/.test(f) || /\/recorded\/[^/]+\.json$/.test(f)))
    .sort();
  for (const f of files) {
    const path = join(root, f);
    let st;
    try {
      st = statSync(path);
    } catch {
      add(`gone:${f}`, "");
      continue;
    }
    // A submodule is listed as its directory: its commit is what a checkout
    // pins, and nothing in a run moves it.
    if (!st.isFile()) {
      add(`dir:${f}`, "");
      continue;
    }
    add(`file:${f}`, readFileSync(path));
  }
  const walkFixtures = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walkFixtures(path);
      else if (e.isFile()) add(`fixture:${relative(root, path)}`, readFileSync(path));
    }
  };
  walkFixtures(fixturesDir);
  for (const extra of [join(root, "node_modules", ".prisma", "client", "schema.prisma"), join(root, "node_modules", "vitest", "package.json")]) {
    if (existsSync(extra)) add(`dep:${relative(root, extra)}`, readFileSync(extra));
  }
  add(
    "env",
    JSON.stringify({
      node: process.version,
      // D54: the Node the suite RUNS under (cinode.mjs), which is not this
      // tool's: a repo whose CI Node changed (a workflow edit, a new image)
      // is gated in full under the new one.
      targetNode: targetNode({ root, env }).node,
      mode: env.CHARPILOT_MODE ?? "",
      envFile: env.CHARPILOT_ENV_FILE ?? "",
      nodeOptions: env.NODE_OPTIONS ?? "",
      tz: env.TZ ?? "",
    })
  );
  return { digest: h.digest("hex"), files: files.length };
}

/* --------------------------------------------------------------------------
 * THE ONE DECISION, shared by cigate.mjs and coverage.mjs so the two cannot
 * reach different answers from one disk.
 *
 *   ledger    what the consumer last ran over: { manifest, specs, context,
 *             green, partialsSinceFull }
 *   manifest  emitted.json now: { hashes, digest } (manifestHashes)
 *   disk      the spec files on disk now (diskHashes)
 *   dirty     out/dirty.json (readDirty)
 *   context   contextDigest()
 *   refusal   the caller's own reason to run full, or null
 *   every     fullEvery()
 *
 * Returns { scope: "full" | "partial" | "unchanged", why, files }. `files` are
 * the repo-relative spec files a partial pass runs; `unchanged` runs none.
 * ------------------------------------------------------------------------ */
export function planIncremental({ ledger, manifest, disk, dirty, context, refusal = null, every = FULL_EVERY_DEFAULT }) {
  const full = (why) => ({ scope: "full", why, files: [] });
  if (refusal) return full(refusal);
  if (!ledger || typeof ledger !== "object" || !ledger.specs || !ledger.manifest) return full("there is no record of a previous pass to build on");
  if (ledger.green !== true) return full("the last pass was not green, so nothing it saw may be carried");
  if (!context?.digest) return full(`what the suite runs under cannot be hashed (${context?.why ?? "no digest"})`);
  if (ledger.context !== context.digest) return full("what the suite runs under changed since the last pass (source, configs, doubles, lockfile, tools or mode)");
  if (!manifest) return full("emitted.json is missing or carries no per-file hashes");
  const off = diskDisagrees(manifest.hashes, disk);
  if (off.length) return full(`the suite on disk is not the one emitted.json describes: ${off.slice(0, 3).join("; ")}${off.length > 3 ? `; +${off.length - 3} more` : ""}`);
  if (digestOfHashes(ledger.specs) !== ledger.manifest) return full("the ledger's own file list does not hash to the emission it names");
  if (ledger.manifest === manifest.digest) return { scope: "unchanged", why: "no spec file changed since the last pass", files: [] };
  if (!dirty?.specs) return full("out/dirty.json is missing, unreadable or names no spec files");
  if (dirty.specs.to !== manifest.digest) return full("out/dirty.json describes another emission than the one on disk");
  if (dirty.specs.from !== ledger.manifest) return full("the last pass ran over an emission out/dirty.json does not start from");
  const own = specDiff(ledger.specs, manifest.hashes);
  const same = (a = [], b = []) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!same(own.changed, dirty.specs.changed) || !same(own.added, dirty.specs.added) || !same(own.removed, dirty.specs.removed)) {
    return full("out/dirty.json and this step's own diff of emitted.json disagree about which spec files changed");
  }
  if ((Number(ledger.partialsSinceFull) || 0) + 1 >= every) return full(`a full pass every ${every} passes (${FULL_EVERY_ENV})`);
  const files = [...own.changed, ...own.added].sort();
  if (!files.length) return { scope: "unchanged", why: `only removals (${own.removed.length} file(s)); nothing left to run changed`, files: [] };
  return { scope: "partial", why: `${files.length} of ${Object.keys(manifest.hashes).length} spec file(s) changed since the last pass`, files };
}

/** The ledger a pass leaves, from the plan it ran and what it found. */
export function nextLedger({ prior, plan, manifest, context, green, now = new Date().toISOString() }) {
  const fullPass = plan.scope === "full";
  return {
    manifest: manifest?.digest ?? null,
    specs: manifest?.hashes ?? {},
    context: context?.digest ?? null,
    green: Boolean(green),
    scope: plan.scope,
    why: plan.why,
    files: plan.files,
    at: now,
    fullAt: fullPass ? now : prior?.fullAt ?? null,
    // A full pass resets the count, and so does nothing: an unchanged pass
    // gated nothing it could have got wrong.
    partialsSinceFull: fullPass ? 0 : (Number(prior?.partialsSinceFull) || 0) + (plan.scope === "partial" || plan.scope === "red-files" ? 1 : 0),
    // THE SUITE THE LAST FULL PASS SAW. `restsOnFull` reads it: a verdict may
    // stand on this ledger only while the suite is still that suite.
    fullManifest: fullPass ? manifest?.digest ?? null : prior?.fullManifest ?? null,
    fullContext: fullPass ? context?.digest ?? null : prior?.fullContext ?? null,
    fullGreen: fullPass ? Boolean(green) : Boolean(prior?.fullGreen),
    // A RE-GATE OF THE FILES A FULL PASS FOUND RED (steps/emit.mjs ciGate):
    // whether every file the re-emit changed since that full pass was gated
    // again. `restsOnFull` lets a round walk's report stand on it.
    ...(plan.scope === "red-files" ? { afterFull: Boolean(plan.afterFull) } : {}),
  };
}

/**
 * Whether the suite as it is now was last gated by a FULL pass that was green
 * or red on its own - the question a report's visit asks (steps/emit.mjs).
 * True for a ledger written before this existed, which only a full pass wrote.
 */
export function restsOnFull(ledger, manifest, env = process.env) {
  if (!ledger) return true;
  if (ledger.scope === undefined) return true;
  if (ledger.scope === "full") return true;
  // A full pass, then only the files it found red gated again over the suite
  // the withhold re-emitted: a round walk's report stands on that as it
  // stands on a full pass. The bank walk's may not - a file red only in
  // company is found by a full pass (D48, D52) - so there the suite is gated
  // in full once more.
  if (ledger.scope === "red-files" && ledger.afterFull === true && String(env[BANK_WALK_ENV] ?? "") !== "1") return true;
  return Boolean(ledger.fullManifest) && ledger.fullManifest === manifest?.digest && ledger.fullContext === ledger.context;
}
