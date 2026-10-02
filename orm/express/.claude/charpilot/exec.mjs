/**
 * Run a function against staging and write down what it did. Nothing else.
 *
 * This exists to answer one question: is "execute the function with this input
 * against the staging environment" actually hard? It is not. The whole thing is
 * below, and the only reason `record.mjs` is 2,529 lines is that it also asks
 * each input to DECLARE every boundary the function touches - which is 61% of
 * the authored artifact and was the source of 4 of the 5 mechanical defect
 * classes that produced 131 false claims. You do not need a declaration if you
 * record what actually happened.
 *
 * What this deliberately does NOT do, because a real one must:
 *
 *   - freeze determinism (uuid, clock, ordering). Without it a pair differs
 *     from itself; the per-run uuid that bit us was an object KEY, not a value.
 *   - scrub secrets before a fixture is committed. Recorded arguments carry
 *     credentials - one service built `?secret=` + an env key into a URL.
 *   - emit a replayable fixture. A recording against live staging is only as
 *     reproducible as staging, so the fixture is the pinned artifact and the
 *     committed test replays IT, not the environment.
 *
 * Those three are the real cost of the record-first design, and they are the
 * reason "just run it" is a smaller idea than it looks - not the executor.
 *
 *   node --import ./.claude/charpilot/tsload.mjs .claude/charpilot/exec.mjs \
 *     --inputs .claude/charpilot/out/exec-inputs.json \
 *     --env-file .claude/charpilot/out/staging.env
 *
 * Input file is a list of `{ id, module, member, args }`. That is the entire
 * contract - no boundaries, no setup, no invoke recipe.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT, assertExpectedDb, expectedDb } from "./config.mjs";
// One thrown value, one printable line, one implementation of that rule in this
// toolset - D50, D59. providervocab.mjs runs nothing on import.
import { failureLine } from "./providervocab.mjs";
import { parseEnvText } from "./envfile.mjs";

const require = createRequire(import.meta.url);
const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const INPUTS = resolve(arg("--inputs") ?? `${OUT_DIR}/exec-inputs.json`);
const ENV_FILE = arg("--env-file");
const OUTPUT = resolve(arg("--out") ?? `${OUT_DIR}/exec-rows.json`);
/** Deliberate escape hatch for guardOutput. Prints what it discards. */
const OVERWRITE = ARGV.includes("--overwrite");
/**
 * Widening the egress allowlist, and the ONLY way to widen it.
 *
 * It is a flag rather than an environment variable, and a different input from
 * the one that states the database expectation, because those are two different
 * decisions: `CHARPILOT_EXPECTED_DB` used to do both, so naming a database also
 * opened the network. Same spelling as record.mjs --allow-host. Entries still
 * go through matchKind(), so this cannot allow-list a bare `com` either.
 */
const ALLOW_HOSTS = (arg("--allow-host") ?? "").split(",").map((h) => h.trim()).filter(Boolean);

/**
 * Staging's env, and an assertion that it is staging.
 *
 * `34.143.159.14` serves staging on :5434 AND `tracy-log` on :5433, which is
 * referenced from a PRODUCTION deployment manifest. A host allow-list waves
 * that through. So the whole triple is checked, and a mismatch refuses the run
 * rather than warning about it.
 */
// The expected triple and assertExpectedDb come from config.mjs, shared with
// record.mjs - two copies of a safety constant is one copy too many. The triple
// itself is DERIVED from this repo's stage-1 staging env, not typed in: see
// config.mjs expectedDb().

/**
 * Which environment produced these rows.
 *
 * A recorded value is only as real as the environment it ran against, and the
 * file NAME does not pin that - the same path can hold different values a week
 * apart. Measured on record.mjs: the same 366 inputs recorded 365 rows with one
 * env file and 333 without it, and the 32 that vanished were every error path
 * that fires a Slack alert. The hash is of the file's contents; no value is
 * stored or printed.
 */
function envProvenance() {
  if (!ENV_FILE) return "process-env-only";
  if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
  return createHash("sha1").update(readFileSync(ENV_FILE, "utf8")).digest("hex").slice(0, 12);
}

/**
 * Refuse to replace rows this run cannot account for.
 *
 * The output path comes from the flags, never from what ran, so a 5-input run
 * lands on the file a 500-input run wrote and wins by being later. Two things
 * make a prior capture incomparable: rows this run does not produce, and a
 * different environment. Both stop the run; `--overwrite` is the deliberate
 * escape hatch and prints what it is discarding.
 */
function guardOutput(willWriteIds) {
  if (!existsSync(OUTPUT)) return;
  let prior;
  try {
    prior = JSON.parse(readFileSync(OUTPUT, "utf8"));
  } catch {
    return; // unreadable is not a capture worth protecting
  }
  const where = relative(REPO_ROOT, OUTPUT);
  const refuse = (why, how) => {
    if (OVERWRITE) {
      process.stdout.write(`! --overwrite: ${why}\n`);
      return;
    }
    throw new Error(`refusing to overwrite ${where}: ${why}\n  ${how}\n  Or send this run elsewhere with --out <path>.`);
  };

  const priorEnv = prior.envProvenance;
  const thisEnv = envProvenance();
  if (priorEnv && priorEnv !== thisEnv) {
    refuse(
      `it was recorded under env ${priorEnv}, and this run is env ${thisEnv}` +
        (prior.envFile ? ` (that file: ${prior.envFile})` : ""),
      "Rows from two different environments must not share a file. Pass the same --env-file, or --overwrite to re-record under the new one."
    );
  }

  const had = new Set((prior.rows ?? []).map((r) => r.id));
  if (had.size === 0) return;
  const willWrite = new Set(willWriteIds);
  const lost = [...had].filter((id) => !willWrite.has(id));
  if (lost.length) {
    refuse(
      `it holds ${had.size} row(s) and this run writes ${willWrite.size}, dropping ${lost.length} ` +
        `(${lost.slice(0, 4).join(", ")}${lost.length > 4 ? ", …" : ""})`,
      "Widen the run, or pass --overwrite if discarding those rows is what you mean."
    );
  }
}

/** What the DSN assertion in loadEnv() actually proved, for the artifact. */
let DB_ASSERTION;

function loadEnv() {
  if (!ENV_FILE) return;
  if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
  Object.assign(process.env, parseEnvText(readFileSync(ENV_FILE, "utf8")));
  // The result says WHICH check carried the run: the triple comparison, or -
  // when the DSN under test is the expectation's own source file, which is what
  // `--env-file out/staging.env` means - the corroboration against
  // out/staging-env.json. Recorded on the artifact rather than assumed.
  DB_ASSERTION = assertExpectedDb(process.env.DATABASE_URL, "exec.mjs");
}

/**
 * Default-deny egress. This was missing from the first version of this file,
 * and that omission is the most expensive kind: running the corpus with no
 * guard would have made real calls on the provider keys that live in staging's
 * `api_key` rows, and those BILL a real account. "Just run the function" is
 * only safe with this in place.
 *
 * Allowed: Langfuse, loopback, and the staging Postgres host WHEN STAGE 1
 * ESTABLISHED IT - not when an environment variable merely named it. Everything
 * else refuses loudly and the refusal is recorded on the row, so a blocked call
 * reads as "this input needs a boundary" rather than as service behaviour.
 */
/** Never suffix-matched: a subdomain of these means nothing. */
const EXACT_ONLY = new Set(["localhost", "127.0.0.1", "::1"]);
const isIpLiteral = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":");

/**
 * How an allow-list entry may be matched, or null if it may not be listed.
 *
 * `ok()` matches by SUFFIX, which is what makes one entry cover Vertex's
 * regional hostnames - and what made `com` cover the internet. Measured:
 * `CHARPILOT_EXPECTED_DB=com:5432/x` allowed example.com, sub.example.com and
 * every other `*.com` this probe asked about. A single label is not a host
 * anyone owns, and neither are the registry suffixes named below, so they are
 * refused rather than downgraded to an exact match - a `com` entry means
 * somebody thought they were allowing something, and quietly allowing nothing
 * is as misleading as allowing everything. This is NOT a public-suffix list; it
 * closes the one-label case that was measured and names the two-label registry
 * suffixes that would otherwise read as ordinary domains.
 */
const REGISTRY_SUFFIXES = new Set(["co.uk", "com.au", "com.br", "co.jp", "co.in", "com.sg", "github.io", "appspot.com", "web.app", "firebaseapp.com"]);
function matchKind(a) {
  const h = String(a ?? "").trim().toLowerCase();
  if (!h) return null;
  if (EXACT_ONLY.has(h)) return "exact";
  // `--allow-host example.com:5432` is a port glued to a host name, and this
  // guard only ever sees hosts - so such an entry matches nothing, silently.
  // Refused loudly instead: an entry that cannot match is a hole somebody
  // believes is closed.
  if (/^[^:]+:\d+$/.test(h)) return null;
  // An IP is exact-only: `.34.143.159.14` is not a hostname a subdomain of an
  // address could ever produce.
  if (isIpLiteral(h)) return "exact";
  if (h.split(".").filter(Boolean).length < 2) return null;
  if (REGISTRY_SUFFIXES.has(h)) return null;
  return "suffix";
}

/**
 * Resolved when the egress is sealed, NOT at import.
 *
 * The staging DB host is no longer a literal - it comes from the target's own
 * stage-1 artifact, so reading it can refuse. At module scope that refusal
 * would fire on `import`, and the gate's `tools-parse` check imports every tool
 * in this directory: a repo that had not run stage 1 yet would fail the gate
 * for having nothing to assert, instead of at the moment it tried to run
 * something against a database.
 *
 * ONE ENV VAR MUST NOT DO BOTH JOBS. This used to be `expectedDb().host`
 * unconditionally, so `CHARPILOT_EXPECTED_DB` - whose only stated job is to
 * state the database expectation - also widened the network policy. Measured on
 * ai-centralization: `CHARPILOT_EXPECTED_DB=example.com:5432/anything` made
 * example.com and sub.example.com ALLOWED and the real staging host BLOCKED.
 * Before the expectation was derivable, that host was a compile-time literal
 * and no environment variable could move it; keeping that property is the
 * point. So the DB host is added only when stage 1 vouched for it
 * (`fromStageOne`), which is the same provenance the assertion itself rests on.
 *
 * A DB expectation that cannot be resolved narrows this list instead of
 * throwing: sealing the egress must not depend on there being a staging
 * database, and failing to resolve one can only ever REMOVE a host here. The
 * refusal belongs where a DSN is actually asserted (loadEnv), not here, where
 * it would abort a non-live run that never touches a database.
 */
const allowedHosts = () => {
  const hosts = [...ALLOW_HOSTS, "langfuse.qode.world", "cloud.langfuse.com", "127.0.0.1", "localhost"];
  try {
    const db = expectedDb();
    if (db.fromStageOne) hosts.unshift(db.host);
  } catch {
    /* no expectation: the list stays narrower, which is the safe direction */
  }
  return hosts;
};
let EGRESS = [];

function sealEgress() {
  const http = require("node:http");
  const https = require("node:https");
  const net = require("node:net");
  const ALLOW = [];
  for (const a of allowedHosts()) {
    const kind = matchKind(a);
    if (kind) ALLOW.push({ host: String(a).toLowerCase(), kind });
    else process.stdout.write(`! egress: refusing to allow-list "${a}" - it is not a host, and suffix-matching it would allow every domain under it\n`);
  }
  const ok = (h) => {
    const host = String(h ?? "").trim().toLowerCase().replace(/\.$/, "");
    if (!host) return false;
    return ALLOW.some((a) => host === a.host || (a.kind === "suffix" && host.endsWith(`.${a.host}`)));
  };
  const deny = (what) => {
    EGRESS.push(what);
    const e = new Error(`exec: ${what} blocked - default-deny egress`);
    e.charpilotBlocked = true;
    throw e;
  };
  for (const mod of [http, https]) {
    const orig = mod.request.bind(mod);
    mod.request = (a, b, c) => {
      const host = typeof a === "string" ? new URL(a).hostname : a?.hostname ?? a?.host;
      if (!ok(host)) deny(`${mod === https ? "https" : "http"}.request ${host}`);
      return orig(a, b, c);
    };
  }
  const origConnect = net.createConnection.bind(net);
  net.createConnection = (opts, cb) => {
    const host = typeof opts === "object" ? opts.host : undefined;
    if (host && !ok(host)) deny(`net.createConnection ${host}`);
    return origConnect(opts, cb);
  };
  const origFetch = globalThis.fetch;
  if (origFetch) {
    globalThis.fetch = (u, init) => {
      const host = typeof u === "string" ? new URL(u).hostname : u?.hostname ?? new URL(String(u)).hostname;
      if (!ok(host)) deny(`fetch ${host}`);
      return origFetch(u, init);
    };
  }
}

/**
 * Serialise anything the service can return.
 *
 * The naive version is where a recorder quietly lies. `Prisma.DbNull` prints as
 * `{}` under JSON.stringify, and `{}` and `DbNull` are OPPOSITE instructions to
 * Postgres. A Decimal prints as an object. A cyclic structure throws. So
 * sentinels are matched by constructor name and depth is bounded.
 */
/**
 * Redaction, mirrored from record.mjs.
 *
 * This runner writes exec-rows.json, which is the same hazard: location-ms's
 * behaviour.json was found holding a real GOOGLE_API_KEY verbatim in an
 * X-Goog-Api-Key header. By KEY, never by value - a credential is never a
 * legitimate observable, and guessing at values both misses short secrets and
 * destroys real data that happens to look random.
 */
const CREDENTIAL_KEY =
  /^(?:x-)?(?:api[-_]?key|apikey|goog-api-key|authorization|auth|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|passphrase|credential|private[-_]?key|client[-_]?secret|signing[-_]?secret|account[-_]?key|access[-_]?key|shared[-_]?key|secret[-_]?key|webhook|hook|dsn|connection[-_]?string|database[-_]?url|session|cookie|set-cookie)$/i;

function scrubString(text) {
  return String(text)
    .replace(/([?&](?:key|api[-_]?key|apikey|access[-_]?token|token|secret|signature|sig)=)[^&#\s]+/gi, "$1<redacted>")
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^:@\s]+:[^@\s]+@/gi, "$1://<redacted>@")
    // A URL that IS the credential. profile-centralized's artifact captured a
    // live hooks.slack.com webhook as axios.post's argument 0, because
    // sendSlackError.ts passes env.SLACK_HOOK positionally - so it arrived
    // under no key at all and every key-based rule missed it. It got WORSE with
    // the callable-boundary fix: that row used to record boundaryCalls: [].
    // The path segment after the host is the secret, so the host is kept and
    // the rest goes.
    .replace(/(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9\/+_-]+/g, "$1<redacted>")
    .replace(/(https:\/\/discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9\/_-]+/g, "$1<redacted>")
    .replace(/(https:\/\/[a-z0-9.-]*webhook[a-z0-9.-]*\/)[A-Za-z0-9\/+_-]{16,}/gi, "$1<redacted>");
}

function snap(v, depth = 0, seen = new WeakSet()) {
  if (v === undefined) return { $undefined: true };
  if (typeof v === "string") return scrubString(v);
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "bigint") return { $bigint: v.toString() };
  if (typeof v === "function") return { $function: v.name || "anonymous" };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v instanceof Error) return { $error: v.name, message: String(v.message).slice(0, 400) };
  if (typeof v === "object") {
    const ctor = v.constructor?.name;
    if (ctor === "Decimal") return { $decimal: String(v) };
    // Everything below carries its value in internal slots, not own enumerable
    // keys, so the Object.keys() walk further down flattens it to {} - the same
    // failure as the Prisma sentinel above, just less famous. A RegExp, a
    // Buffer, a typed array and a generator all read as an empty object.
    if (v instanceof RegExp) return { $regexp: String(v) };
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return { $buffer: v.toString("base64") };
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return { $typedArray: ctor, values: Array.from(v, (n) => (typeof n === "bigint" ? String(n) : n)) };
    if (v instanceof ArrayBuffer || v instanceof DataView) return { $binary: ctor, byteLength: v.byteLength };
    if (typeof v[Symbol.asyncIterator] === "function") return { $asyncIterator: true };
    if (typeof v.next === "function" && typeof v[Symbol.iterator] === "function") return { $iterator: true };
    if (ctor && /^(DbNull|JsonNull|AnyNull)$/.test(ctor)) return { $prismaSentinel: ctor };
    if (seen.has(v)) return { $cycle: true };
    if (depth > 6) return { $deep: ctor ?? "object" };
    seen.add(v);
    // Both of these recurse, so they sit behind the cycle guard and the depth
    // cap above: a Map that holds itself would otherwise never bottom out.
    if (v instanceof Map) return { $map: [...v.entries()].slice(0, 200).map(([k, x]) => [snap(k, depth + 1, seen), snap(x, depth + 1, seen)]) };
    if (v instanceof Set) return { $set: [...v].slice(0, 200).map((x) => snap(x, depth + 1, seen)) };
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => snap(x, depth + 1, seen));
    const out = {};
    for (const k of Object.keys(v).slice(0, 200)) {
      if (CREDENTIAL_KEY.test(k)) {
        const raw = v[k];
        out[k] = { $redacted: typeof raw, length: typeof raw === "string" ? raw.length : undefined };
        continue;
      }
      try {
        out[k] = snap(v[k], depth + 1, seen);
      } catch {
        out[k] = { $threwOnRead: true };
      }
    }
    return out;
  }
  return { $unserialisable: typeof v };
}

/**
 * Un-awaited promises are real behaviour here, not an accident: this service
 * fires `sendSlackNotification` and its usage writer without awaiting them. So
 * a rejection after the function returns is collected per row instead of
 * killing the process, and the row gets a settle window before it is closed.
 */
let FLOATING = [];
process.on("unhandledRejection", (r) =>
  FLOATING.push(r instanceof Error ? { $error: r.name, message: String(r.message).slice(0, 200) } : snap(r))
);

/** winston writes to the STREAM, not console. Capture both or a void function records nothing. */
function captureOutput() {
  const lines = [];
  const origs = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(origs)) {
    console[k] = (...a) => lines.push({ stream: k, text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(snap(x)))).join(" ") });
  }
  const ow = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...r) => (lines.push({ stream: "stdout", text: String(c).trimEnd() }), true);
  process.stderr.write = (c, ...r) => (lines.push({ stream: "stderr", text: String(c).trimEnd() }), true);
  return {
    lines,
    restore() {
      Object.assign(console, origs);
      process.stdout.write = ow;
      process.stderr.write = oe;
    },
  };
}

const settle = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`exec: row exceeded ${ms}ms`)), ms).unref?.())]);

/**
 * Drain a returned stream, capped.
 *
 * Calling a function that returns a stream observes almost nothing: a web
 * ReadableStream has no own enumerable keys, so the row records `{}`. Pulling it
 * is what produces the frames, and the frames are the behaviour. Measured on
 * ai-centralization: 15 rows recorded `{}` this way, every one an LLM streaming
 * path - the highest-risk code in the service, pinned to nothing.
 *
 * A ReadableStream implements [Symbol.asyncIterator] and has NO next() - next()
 * belongs to the reader it hands out - so the async test is for the protocol
 * alone. The sync test keeps next(), which is what separates a generator from an
 * Array/Map/Set that is iterable but has a better snapshot of its own.
 *
 * Capped, and inside the caller's timeout: an endless stream is exactly the
 * shape that would otherwise hang the run.
 */
const DRAIN_CAP = 100;
async function drainIfIterator(v) {
  if (v === null || typeof v !== "object") return v;
  // ASYNC, and a whitelist rather than a protocol test. The first version of
  // this asserted "nothing built-in is async-iterable by accident", and that is
  // FALSE: every Node Readable/Transform is async-iterable, so draining one
  // never terminates. Winston's DerivedLogger is a Transform, and a subject
  // returning a logger, an Express response, a socket or a file stream burned
  // the whole row timeout and landed as notSettled - which stage 5 turns into
  // it.skip. Measured on pricing-ms, on a row that had recorded in 40ms before
  // the drain existed.
  //
  // getReader() is a web ReadableStream; next() is a generator or an explicit
  // iterator. A Node stream has NEITHER, and neither does anything else that is
  // merely async-iterable. Declining to drain costs one observation and is
  // tagged $asyncIterator; draining a stream costs the row.
  const isAsync =
    typeof v[Symbol.asyncIterator] === "function" &&
    (typeof v.getReader === "function" || typeof v.next === "function") &&
    typeof v.pipe !== "function";
  const isSync =
    !isAsync &&
    typeof v[Symbol.iterator] === "function" &&
    typeof v.next === "function" &&
    !Array.isArray(v) &&
    !(v instanceof Map) &&
    !(v instanceof Set) &&
    !ArrayBuffer.isView(v);
  if (!isAsync && !isSync) return v;
  const yielded = [];
  const tag = { $drained: isAsync ? "asyncIterator" : "iterator", yielded };
  try {
    if (isAsync) {
      for await (const x of v) {
        if (yielded.length >= DRAIN_CAP) { tag.truncatedAt = DRAIN_CAP; break; }
        yielded.push(x);
      }
    } else {
      for (const x of v) {
        if (yielded.length >= DRAIN_CAP) { tag.truncatedAt = DRAIN_CAP; break; }
        yielded.push(x);
      }
    }
  } catch (e) {
    // A stream that fails mid-flight is an observation. The frames before the
    // failure are real and are kept next to it.
    tag.threw = e instanceof Error ? { $error: e.name, message: String(e.message).slice(0, 400) } : { $error: "non-error", message: String(e) };
  }
  return tag;
}

async function runOne(input) {
  // args through snap() too, not echoed raw. Redaction covered the OBSERVED
  // side - returned, threw, boundary calls - and missed the echoed input, so a
  // credential supplied in an input file landed in the output verbatim. Caught
  // by feeding this runner an input carrying an authorization header and an
  // AIza-shaped key and reading back what it wrote: both were there in full.
  // The row is what gets committed or pasted, so the input half needs the same
  // treatment as the output half.
  const row = { id: input.id, module: input.module, member: input.member, args: snap(input.args) };
  const cap = captureOutput();
  FLOATING = [];
  EGRESS = [];
  const started = Date.now();
  try {
    // require, not import: tsconfig sets `"module": "commonjs"`, so `src/*.ts`
    // compiles to CJS and an ESM `import()` of it fails with "Cannot require()
    // ES Module". Run this file with
    //   node -r ts-node/register -r tsconfig-paths/register
    // and the same resolution the service uses at runtime applies here.
    const mod = require(input.module);
    const target = input.member ? mod[input.member] : mod.default;
    if (typeof target !== "function") throw new Error(`${input.module}#${input.member} is not a function`);
    const returned = await settle(
      (async () => drainIfIterator(await target(...(input.args ?? []))))(),
      input.timeoutMs ?? 15_000
    );
    row.returned = snap(returned);
  } catch (e) {
    row.threw = e instanceof Error ? { $error: e.name, message: String(e.message).slice(0, 400) } : snap(e);
  } finally {
    // one macrotask, so an un-awaited rejection lands inside the row that caused it
    await new Promise((r) => setTimeout(r, 0));
    cap.restore();
    row.console = cap.lines.slice(0, 50);
    row.floating = FLOATING;
    if (EGRESS.length) row.blockedEgress = [...new Set(EGRESS)];
    row.durationMs = Date.now() - started;
  }
  return row;
}

async function main() {
  loadEnv();
  sealEgress();
  if (!existsSync(INPUTS)) throw new Error(`--inputs ${relative(REPO_ROOT, INPUTS)} not found`);
  const inputs = JSON.parse(readFileSync(INPUTS, "utf8"));
  const list = Array.isArray(inputs) ? inputs : inputs.items;

  // Before the first call, not after the last: a run that spends 500 staging
  // calls and then refuses to write them has protected nothing.
  guardOutput(list.map((i) => i.id));

  const rows = [];
  for (const input of list) rows.push(await runOne(input));

  writeFileSync(
    OUTPUT,
    `${JSON.stringify(
      {
        stage: "exec",
        ranAt: new Date().toISOString(),
        envFile: ENV_FILE ? `${relative(REPO_ROOT, ENV_FILE)} (values not stored)` : "process env only",
        envProvenance: envProvenance(),
        // A run that widened the network policy says so on its own artifact.
        ...(ALLOW_HOSTS.length ? { egressWidenedBy: ALLOW_HOSTS } : {}),
        // What was asserted, and by what. Never a throw: a run that spent real
        // staging calls must not lose its rows because a REPORTING field could
        // not resolve an expectation - the refusal for that belongs in loadEnv,
        // before anything ran. `assertion` is absent when no --env-file was
        // passed, i.e. when no DSN was asserted at all, and saying so beats
        // printing a triple that nothing checked.
        dbAsserted: (() => {
          try {
            return { ...expectedDb(), assertion: DB_ASSERTION?.assertedBy ?? "not asserted - no --env-file, no DSN under test" };
          } catch (e) {
            // NOT `e.message.split("\n")[0]` — D50, D59. That is empty for any
            // message that begins with a newline, and `unresolved: ""` is a
            // field that says a triple could not be resolved and then refuses
            // to say why. config.mjs's own refusals put a whole sentence on
            // line 1 and read the same through `failureLine`; what changes is
            // everything else that can land here - a Prisma-shaped message, a
            // TypeError from a bug, a thrown non-Error - none of which can
            // produce a blank any more.
            return { unresolved: failureLine(e) };
          }
        })(),
        totals: {
          inputs: list.length,
          returned: rows.filter((r) => "returned" in r).length,
          threw: rows.filter((r) => r.threw).length,
          withFloating: rows.filter((r) => r.floating?.length).length,
          blockedEgress: rows.filter((r) => r.blockedEgress?.length).length,
        },
        rows,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(
    `\n✓ exec → ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    inputs   ${list.length}\n` +
      `    returned ${rows.filter((r) => "returned" in r).length}\n` +
      `    threw    ${rows.filter((r) => r.threw).length}\n` +
      `    floating ${rows.filter((r) => r.floating?.length).length}   (un-awaited rejections, real behaviour here)\n` +
      `    blocked  ${rows.filter((r) => r.blockedEgress?.length).length}   (needs a boundary; NOT service behaviour)\n`
  );
}

// Only when this file is the entry point. Importing it to reach one helper used
// to execute the whole run and overwrite exec-rows.json - which happened.
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => {
    process.stderr.write(`\n✗ ${e.message}\n`);
    process.exit(1);
  });
}
