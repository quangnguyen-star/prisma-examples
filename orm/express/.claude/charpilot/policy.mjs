/**
 * Which boundaries may be answered by a mock, and which must reach the real
 * thing. Stage 4's contract.
 *
 * The rule, stated once: **the database and every downstream service are real.
 * Slack and Redis are the only two mockable boundaries, and Redis is mocked at
 * `ioredis`, one level below the code under test, in a state where every
 * lookup MISSES.**
 *
 * Why those two and nothing else:
 *
 *   - Slack posts to a real channel. There is no staging channel and a recorded
 *     pair is not worth a message in a room people read. Outward-facing, so it
 *     is answered, not called.
 *   - Redis lives at an in-cluster DNS name (`REDIS_HOST` in staging's
 *     configmap) with no external route. A real `new Redis()` from a laptop
 *     does not fail fast, it retries per `retryStrategy` and the row times out.
 *     Unreachable infrastructure, so it is answered.
 *   - Everything else is reachable. Staging Postgres answers on the external
 *     LB, Langfuse is a public host. A canned answer where a real one is
 *     available is the degree of freedom stage 4 exists to remove: tuning a
 *     fabricated mock until the function runs is indistinguishable from tuning
 *     until the test goes green.
 *   - The LLM providers are the one reachable boundary that is REPLAYED rather
 *     than called, and that is not a compromise. The service records the whole
 *     exchange - `usage_log_content.input_messages` and `.output_text`, plus
 *     `usage_log.finish_reason`, the token counts, `status` and `error_message`
 *     - so a replayed row is the same data a live call returns, minus the bill
 *     and minus the nondeterminism. It is also more data: 17,136 rows carry 8
 *     distinct finish reasons, 9 distinct error shapes, and real null rates
 *     (`input_tokens` null in 1.25%), where one live call returns whatever it
 *     returns today. Live provider calls were made first and remain available;
 *     replay is preferred wherever the recorded row is complete.
 *
 * The Redis MISS is not a detail. A cache that ANSWERS is a cache that hides
 * the call underneath it: a canned `withCache` returns a value without running
 * the decorator's own arms or the database read it wraps, so the arm the row
 * claimed to reach never executes. Measured at stage 6: 35 of 102 false
 * `reaches` claims were rows in exactly that shape. A cache that misses is
 * transparent - the decorator takes the compute path and the real query runs.
 *
 * ===========================================================================
 * THE RULE ABOVE IS GENERAL. THE SYMBOL TABLE THAT USED TO IMPLEMENT IT WAS NOT
 * ===========================================================================
 *
 * This file used to answer the rule out of two hand-written lists of SYMBOL
 * NAMES: `REAL_ONLY` held `CachedLangfusePrompt`, `AnthropicApiKeys`,
 * `OpenAIKeys`, `VertexAIKeys`, `LangfuseKeys`, `getApiKey`,
 * `warmupApiKeyCache`; `KEEP_AS_DECLARED` held roughly sixty more including
 * `llmRequestPayloadV4Stream`, `getInvokeWithToolsV4Action`,
 * `providerHttpStatus` and `queueManager`. Every one of those names is a fact
 * about ONE service, and none of them exists in location-ms.
 *
 * An agent deriving inputs on location-ms was handed that vocabulary in all 56
 * of its items and reported back:
 *
 *   "location-ms has no LLM provider, no Langfuse, no queue... I read the deny
 *    list as 'metered or side-effecting hosts are default-deny' and applied it
 *    to Google Maps BY ANALOGY. That is me supplying a policy the artifact did
 *    not state, for the only egress this service has."
 *
 * That is the same defect dbvocab.mjs had - a per-service constant hardcoded
 * into a fleet tool, producing confident guidance about a service that is not
 * the target - and it is worse than an absent answer, because an agent cites
 * it. `trace` and `flagTraceStep` were already removed from `REAL_ONLY` for
 * exactly this reason (location-ms imports `trace` from `@opentelemetry/api`,
 * an in-process API with a no-op default provider), which was the same bug one
 * name at a time.
 *
 * THE BASIS IS NOW THE MODULE, AND IT COMES FROM THE TARGET.
 *
 * `out/scan.json` already records, for every boundary a function touches, the
 * symbol AND the module it was imported from - `scan.mjs` builds it in
 * `collectBoundaries` (scan.mjs:707) off the file's own import declarations,
 * and `worklist.mjs:920` prints it to the agent as "`sym` from `module`". A
 * module is a far better basis than a name:
 *
 *   - `@prisma/client` is the database in every repo that has it. `prisma` is
 *     a variable name that in some other repo is a pure helper.
 *   - `ioredis` is the cache in every repo that has it. `Redis` is a name.
 *   - `maps.googleapis.com` behind `@googlemaps/*` or a bare `fetch` is a
 *     downstream service in every repo that has it.
 *
 * So the classification is: resolve the symbol to the module it came from IN
 * THIS TARGET, decide what that module IS, and answer from that. A symbol the
 * target's own scan does not carry is not named, not classified from a list,
 * and not guessed at - it falls to the uncertainty rule below.
 *
 * WHICH WAY UNCERTAINTY GOES, AND WHY.
 *
 * The two ways to be wrong point in opposite directions:
 *
 *   1. Calling something mockable that should be real re-opens the degree of
 *      freedom this whole file exists to remove.
 *   2. Calling something real that cannot be reached wedges the derivation -
 *      the agent cannot answer the boundary and the run loops.
 *
 * (1) is unrecoverable and (2) is not, so uncertainty resolves to REAL. The
 * reason (2) is recoverable is structural, not optimistic: what a run may
 * REACH is decided by the egress allowlist and the staging credentials, not
 * here, and a real call to a host that is not allowlisted comes back as a
 * NAMED blocked-egress row (record.mjs, and blocked.mjs's ledger), not as a
 * silent retry. This file decides what a symbol IS; something else decides
 * what today's run may talk to. Keeping those two apart is what lets the safe
 * answer also be the answer that terminates.
 *
 * WHAT THAT MEANS FOR GOOGLE MAPS, concretely: location-ms's only egress is
 * `maps.googleapis.com`, reached through a global `fetch`. The scan marks that
 * global `why: "network"`. It is a downstream service, so it is REAL, and the
 * artifact says so in those words instead of leaving an agent to reason from a
 * deny list written for LLM providers. Whether this run's allowlist opens that
 * host is a separate question with a separate artifact, and if it does not,
 * the row comes back blocked and named.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";

// The repo being recorded, resolved the one canonical way. This file needs it
// for four facts about the TARGET rather than about this checkout: what its
// scan says its boundaries are, whether the doubles it injects exist, whether
// the modules it mocks are installed, and where its fixtures live.
import { FIXTURES_DIR, FIXTURES_REL, REPO_ROOT, SCAN_JSON } from "./config.mjs";

/* ------------------------------------------------------------ module classes */

/**
 * WHAT A MODULE IS. Seven answers, and the verdict follows from the answer.
 *
 *   database    the store the service owns. REAL: staging answers, and a canned
 *               row is an invented shape.
 *   downstream  a metered or hosted service, or the transport that reaches one.
 *               REAL, for the same reason. Reachability is the allowlist's
 *               question, not this file's.
 *   outward     a downstream whose call is NOT REVERSIBLE - a message in a room
 *               people read, an email, an SMS. Still REAL here, because this
 *               file stopped guarding sends at the transport (see
 *               SLACK_MOCK_POINT) and guards them at the ENDPOINT, which is
 *               exact. Split out only so the reason can say so.
 *   cache       the one legitimate mock point. Redis and the queues built on
 *               it: an in-cluster DNS name with no external route, where a real
 *               client does not fail fast but retries until the row times out.
 *   determinism a clock, a uuid, a random source. Not a downstream - the reason
 *               two recordings of one row differ. Frozen, and a frozen uuid is
 *               not an invented downstream shape.
 *   inprocess   a framework, a validator, a logger, an in-process tracing API.
 *               Nothing to reach, nothing to fake. The proposal's declaration
 *               stands because the row is arranging ITSELF.
 *   self        the target's own source. Classified by what the file it names
 *               transitively reaches - see `reachOf`.
 *
 * EVERY ENTRY HERE IS A PACKAGE IDENTITY, NOT A SERVICE SYMBOL. `@prisma/client`
 * means the same thing in ai-centralization, location-ms and a repo neither of
 * them has heard of; `CachedLangfusePrompt` did not. That is the whole
 * difference between this table and the one it replaces. A package absent from
 * the target is never consulted, so it can never be named in the target's
 * output.
 *
 * The lists err SHORT on the mockable side and LONG on the real side, because
 * the uncertainty rule is REAL: a package missing from `database` or
 * `downstream` still ends up real via the unknown fallback, while a package
 * wrongly in `cache` or `inprocess` silently re-opens the degree of freedom.
 */

/** `lodash/omit` -> `lodash`; `@google-cloud/storage/build/x` -> `@google-cloud/storage`. */
export function packageOf(specifier) {
  const m = String(specifier);
  if (m.startsWith("node:")) return m;
  const parts = m.split("/");
  return m.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * Ordered. The first rule whose pattern matches the package name wins, so
 * `@google-cloud/firestore` is a database before `@google-cloud/*` is a
 * downstream.
 */
const MODULE_RULES = [
  {
    cls: "database",
    why: "an ORM or database driver - the store this service owns",
    match: [
      /^@prisma\/(client|adapter-.+)$/, /^\.?prisma$/, /^\.prisma\/client$/, /^@?prisma\/client$/,
      /^(typeorm|mongoose|sequelize|knex|objection|drizzle-orm|bookshelf|waterline)$/,
      /^@mikro-orm\/.+$/, /^@drizzle-team\/.+$/,
      /^(pg|pg-promise|postgres|mysql|mysql2|mariadb|sqlite3|better-sqlite3|mssql|tedious|oracledb|cassandra-driver|neo4j-driver|clickhouse|@clickhouse\/client)$/,
      /^mongodb$/, /^@google-cloud\/(firestore|datastore|spanner|bigquery)$/,
      /^@aws-sdk\/client-dynamodb$/, /^@aws-sdk\/lib-dynamodb$/, /^dynamoose$/,
      /^@supabase\/supabase-js$/, /^@elastic\/elasticsearch$/, /^elasticsearch$/,
    ],
  },
  {
    cls: "cache",
    why: "a Redis client, or a queue built on one - an in-cluster address with no external route, where a real call retries instead of failing fast",
    match: [
      /^ioredis$/, /^redis$/, /^@redis\/.+$/, /^node-redis$/, /^redis-mock$/,
      /^keyv$/, /^@keyv\/.+$/, /^cache-manager(-.+)?$/, /^(memcached|memjs)$/,
      // A redis-backed queue IS the redis boundary with an API on top, and
      // mocking the `ioredis` module intercepts the client it loads.
      /^(bull|bullmq|bee-queue)$/,
    ],
  },
  {
    cls: "determinism",
    why: "a clock, a uuid or a random source - the reason two recordings of one row differ, not a downstream",
    match: [
      /^(uuid|nanoid|cuid|cuid2|ulid|shortid|uid|uid-safe|randomstring|random-bytes)$/,
      /^@paralleldrive\/cuid2$/, /^(@faker-js\/faker|faker|chance|casual)$/,
      /^node:crypto$/, /^crypto$/, /^node:timers(\/promises)?$/, /^timers(\/promises)?$/,
    ],
  },
  {
    cls: "outward",
    why: "an outward-facing send - a message in a room people read, an email or an SMS, and not reversible",
    match: [
      /^@slack\/.+$/, /^(slack|slackify-markdown)$/,
      /^(nodemailer|postmark|resend|mailgun\.js|mailgun-js|node-mailjet|emailjs)$/,
      /^@sendgrid\/.+$/, /^twilio$/, /^web-push$/, /^@aws-sdk\/client-(ses|sns)$/,
    ],
  },
  {
    cls: "downstream",
    why: "a metered or hosted service, or the transport that reaches one",
    match: [
      // transports. A transport is NOT an endpoint - see SLACK_MOCK_POINT for
      // what answering one costs - so it is real and the endpoint is guarded.
      /^(axios|node-fetch|got|undici|superagent|request|request-promise|ky|phin|needle|cross-fetch|isomorphic-fetch)$/,
      /^node:(http|https|net|tls|dgram)$/, /^(http|https|net|tls|dgram)$/,
      /^(ws|socket\.io|socket\.io-client|eventsource)$/,
      /^https-proxy-agent$/, /^http-proxy-agent$/, /^socks-proxy-agent$/,
      // brokers and RPC
      /^(amqplib|kafkajs|nats|mqtt|@grpc\/grpc-js|grpc)$/, /^@google-cloud\/pubsub$/,
      // LLM and AI providers
      /^(openai|cohere-ai|replicate|groq-sdk|together-ai|mistralai|@mistralai\/.+)$/,
      /^@anthropic-ai\/.+$/, /^@google\/(generative-ai|genai)$/, /^@google-cloud\/vertexai$/,
      /^@huggingface\/.+$/, /^(langchain|@langchain\/.+)$/, /^langfuse(-.+)?$/,
      /^@aws-sdk\/client-bedrock.*$/,
      // cloud and third-party APIs
      /^googleapis$/, /^google-auth-library$/, /^@googlemaps\/.+$/, /^@google-cloud\/.+$/,
      /^(aws-sdk|@aws-sdk\/.+|@azure\/.+|@sentry\/.+|@datadog\/.+|dd-trace|newrelic)$/,
      /^(stripe|plaid|shippo|algoliasearch|@algolia\/.+|contentful|@sanity\/.+)$/,
      /^(firebase-admin|firebase|@firebase\/.+)$/, /^(soap|graphql-request|@apollo\/client|apollo-client)$/,
      /^(minio|@aws-sdk\/client-s3|@google-cloud\/storage)$/,
    ],
  },
  {
    cls: "inprocess",
    why: "in-process plumbing - a framework, a validator, a logger or a no-op tracing API, with nothing to reach and nothing to fake",
    match: [
      /^(express|fastify|koa|hapi|@hapi\/.+|restify|connect|body-parser|cors|helmet|multer|compression|morgan|cookie-parser|express-rate-limit|serve-static)$/,
      /^@nestjs\/.+$/, /^(swagger-ui-express|swagger-jsdoc|@fastify\/.+)$/,
      /^(zod|joi|yup|ajv|class-validator|class-transformer|superstruct|io-ts)$/,
      /^(lodash|lodash-es|ramda|underscore|immer|rxjs|reflect-metadata|tslib)$/,
      /^(winston|pino|bunyan|debug|loglevel|log4js|consola)$/,
      /^@opentelemetry\/.+$/, /^(dotenv|dotenv-flow|config|convict)$/,
      /^(http-errors|@nestjs\/common|boom|@hapi\/boom)$/,
      /^node:(path|url|util|fs|stream|buffer|events|os|assert|zlib|string_decoder|querystring)$/,
      /^(path|url|util|fs|stream|buffer|events|os|assert|zlib|string_decoder|querystring)$/,
      /^node:fs\/promises$/, /^fs\/promises$/, /^node:stream\/promises$/,
    ],
  },
];

/** What a bare package specifier IS, or null when this table does not know. */
export function classOfModule(specifier) {
  const pkg = packageOf(specifier);
  for (const rule of MODULE_RULES) {
    if (rule.match.some((re) => re.test(pkg))) return { cls: rule.cls, why: rule.why };
  }
  return null;
}

/**
 * The globals the scan itself treats as boundaries, and what they are.
 *
 * This mirrors `GLOBAL_BOUNDARIES` at scan.mjs:608 rather than restating a
 * judgement: a global has no import for the module map to find, so the scan
 * names the module `globalThis` and carries `why` alongside. `fetch` is the
 * sole network call of location-ms's googleMap.service.ts, and it is the reason
 * this entry exists at all.
 */
const GLOBAL_CLASS = new Map([
  ["network", { cls: "downstream", why: "a network global - real egress, with no module to name it by" }],
  ["time", { cls: "determinism", why: "a clock - the reason two recordings of one row differ, not a downstream" }],
  ["crypto", { cls: "determinism", why: "a random source - frozen so the pair replays, which is not an invented downstream shape" }],
]);

/** Globals by name, for a caller asking about a repo whose scan cannot be read. */
const GLOBAL_BY_NAME = new Map([
  ["fetch", "network"], ["XMLHttpRequest", "network"], ["WebSocket", "network"],
  ["setTimeout", "time"], ["setInterval", "time"], ["Date", "time"], ["performance", "time"],
  ["crypto", "crypto"],
]);

/* ---------------------------------------------------------- the target's scan */

/**
 * The target's own boundary index, or null.
 *
 * Read lazily and at most once. `classify` is only ever called with the policy
 * in force and stage 4 runs after stage 2, so the scan is there; a caller with
 * no scan (a `--schema` print in a repo where stage 2 has not run) gets `null`
 * and is told so rather than handed another service's vocabulary.
 *
 * Importing a tool has to stay side-effect free - the gate's `tools-parse`
 * check imports every one of them - so nothing here runs at import.
 */
let scanCache;
function scan() {
  if (scanCache !== undefined) return scanCache;
  scanCache = null;
  try {
    const raw = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
    const functions = Array.isArray(raw?.functions) ? raw.functions : null;
    if (!functions) return scanCache;

    /** file -> boundaries declared in it. */
    const byFile = new Map();
    /** symbol -> {modules, files} across the whole target. */
    const bySymbol = new Map();
    const files = new Set();
    for (const fn of functions) {
      const file = fn.file;
      if (typeof file !== "string") continue;
      files.add(file);
      if (!byFile.has(file)) byFile.set(file, []);
      for (const b of fn.boundaries ?? []) {
        // A type-only boundary erases before the code runs; there is nothing
        // there to classify and naming it would be naming a symbol that does
        // not exist at runtime.
        if (b?.typeOnly || typeof b?.symbol !== "string") continue;
        byFile.get(file).push(b);
        if (!bySymbol.has(b.symbol)) bySymbol.set(b.symbol, { modules: new Set(), files: new Set(), advisory: true, why: new Set() });
        const e = bySymbol.get(b.symbol);
        e.modules.add(String(b.module ?? ""));
        e.files.add(file);
        if (!b.advisory) e.advisory = false;
        if (b.why) e.why.add(b.why);
      }
    }
    scanCache = { byFile, bySymbol, files };
  } catch {
    scanCache = null;
  }
  return scanCache;
}

/**
 * Resolve an in-repo import specifier to a file the scan knows.
 *
 * Relative first, then the two alias shapes a nodejs service actually uses
 * (`src/...` and `@/...` or `~/...` rooted at src). A specifier that resolves
 * to nothing is not in-repo, and falls through to the package tables.
 */
function resolveSelf(specifier, fromFile, files) {
  const m = String(specifier);
  const candidates = [];
  if (m.startsWith(".")) candidates.push(posix.normalize(posix.join(posix.dirname(fromFile), m)));
  else if (m.startsWith("src/")) candidates.push(m);
  else if (/^[@~]\//.test(m)) candidates.push(posix.join("src", m.slice(2)));
  else candidates.push(m);
  for (const base of candidates) {
    for (const suffix of ["", ".ts", ".tsx", "/index.ts", ".js", "/index.tsx"]) {
      if (files.has(base + suffix)) return base + suffix;
    }
  }
  return null;
}

/** Is this specifier the target's own source rather than a package? */
function selfFileFor(specifier, fromFile, s) {
  if (!s || typeof fromFile !== "string") return null;
  return resolveSelf(specifier, fromFile, s.files);
}

/**
 * What a file of the target's OWN source transitively reaches.
 *
 * This is what replaces the hand-listed `SUBJECT_RELATIVE` / `REAL_ONLY` split
 * for in-repo symbols, and it is the part that cannot be done by name at all.
 * `getApiKey` is not a downstream because somebody wrote its name here; it is
 * real because the module that exports it imports `@prisma/client`, and a
 * canned key means the row's database read never happens. `isNumber` is a
 * helper because the module that exports it reaches nothing.
 *
 * Cycle-guarded, memoised, and it returns the SET of classes, because the
 * decision below needs to know whether a module reaches only the cache or also
 * something real.
 */
const reachCache = new Map();
function reachOf(file, s, seen = new Set()) {
  if (reachCache.has(file)) return reachCache.get(file);
  if (seen.has(file)) return new Set();
  seen.add(file);
  const out = new Set();
  for (const b of s.byFile.get(file) ?? []) {
    const mod = String(b.module ?? "");
    if (mod === "globalThis") {
      const g = GLOBAL_CLASS.get(b.why);
      if (g) out.add(g.cls);
      continue;
    }
    if (mod === "process") { out.add("inprocess"); continue; }
    if (mod === "<instance field>") continue; // decided by this file's own reach
    const child = selfFileFor(mod, file, s);
    if (child) {
      for (const c of reachOf(child, s, seen)) out.add(c);
      continue;
    }
    const k = classOfModule(mod);
    out.add(k ? k.cls : "unknown");
  }
  if (seen.size === 1) reachCache.set(file, out);
  return out;
}

/** Does this reach set contain something that must be answered by the real thing? */
function reachesReal(reach) {
  return reach.has("database") || reach.has("downstream") || reach.has("outward");
}

/* ------------------------------------------------------------ mockable points */

/**
 * The one legitimate Slack mock point.
 *
 * EMPTY, AND THAT IS THE POINT. This held "axios", so every axios call in every
 * repo was answered - and axios is not Slack, it is a TRANSPORT. On
 * ai-centralization it happens to be imported only by the two Slack modules,
 * which is a fact about that repo; on any other it is that service's main
 * downstream, and silencing it deletes the downstream from the measurement
 * while reporting a live run. `classOfModule` keeps every transport in
 * `downstream` for the same reason.
 *
 * SLACK IS GUARDED AT THE ENDPOINT INSTEAD, which is exact and already in
 * place: hooks.slack.com is in no allowlist and neither live flag opens it, so
 * a real send is refused as blocked egress and named as such. Guarding the
 * transport to protect one endpoint is the same class of mistake as keying a
 * replay on a per-run identity - it catches the case it was written for and
 * something else besides.
 *
 * Redis stays mocked and that is NOT symmetrical: it answers at a
 * cluster-internal DNS name with no external route, so a real call does not
 * fail fast, it retries per retryStrategy until the row times out. Unreachable
 * infrastructure, not an outward-facing send.
 */
export const SLACK_MOCK_POINT = new Set([]);

/**
 * `ioredis` and its default export, `Redis`.
 *
 * KEPT BY NAME, and it is the one place that is defensible, because these two
 * strings are a MODULE IDENTITY and not a service symbol: `Redis` is what
 * `ioredis` calls its default export in every repo that installs it, the same
 * way `@prisma/client` is the database in every repo that installs it. They are
 * consulted only when the target's scan cannot be read - with a scan, `Redis`
 * is classified because the scan says it came from `ioredis`, and a repo
 * without ioredis never sees these names at all.
 */
const IOREDIS_MOCK_POINT_NAMES = ["ioredis", "Redis"];

/* ----------------------------------------------- what the target's policy IS */

/**
 * A set whose contents are computed the first time anybody looks.
 *
 * The exported policy sets describe THE TARGET, so they cannot be literals, and
 * they must not be computed at import (see `scan()`). Everything a caller does
 * to these - `.has()`, `[...s]`, `.size` - fills them first.
 */
class DerivedSet extends Set {
  #fill;
  constructor(fill) {
    super();
    this.#fill = fill;
  }
  #ready() {
    if (this.#fill) {
      const f = this.#fill;
      this.#fill = null;
      for (const v of f()) super.add(v);
    }
    return this;
  }
  has(v) { this.#ready(); return super.has(v); }
  get size() { this.#ready(); return super.size; }
  values() { this.#ready(); return super.values(); }
  keys() { this.#ready(); return super.keys(); }
  entries() { this.#ready(); return super.entries(); }
  forEach(cb, t) { this.#ready(); return super.forEach(cb, t); }
  [Symbol.iterator]() { this.#ready(); return super[Symbol.iterator](); }
}

/**
 * THE ONE HARDCODED VOCABULARY LEFT, AND EXACTLY WHAT IT IS FOR.
 *
 * These are the names this file carried before the module classifier: the
 * boundaries of ai-centralization, the service it was written against. They are
 * NOT a classification and `classify()` never reads them. They are returned by
 * the exported sets in one case only - a caller asking what the policy is in a
 * repo where `out/scan.json` cannot be read, which is a repo where stage 2 has
 * not run and there is nothing to derive from.
 *
 * The first element says so, in the output, so that a `--schema` print in that
 * state cannot be mistaken for this repo's own vocabulary - which is the exact
 * mistake the location-ms run made, and the one dbvocab.mjs was fixed for in
 * commit 8d32abd. On any real target the scan exists, this list is unreachable,
 * and none of these names is printed.
 *
 * It is kept rather than deleted because `nodejs/tests/policy.declared-mock.test.mjs:60`
 * asserts these membership facts against a fixture repo with no scan, and that
 * test is not mine to edit. Deleting it is a one-line change the moment that
 * test moves to a fixture that has a scan.
 */
const NO_SCAN_NOTICE = "(no out/scan.json here - stage 2 has not run, so these names are NOT derived from this repo)";

const UNDERIVED_REAL = [
  "prisma", "Prisma", "ApiKey", "CachedLangfusePrompt", "PrismaClientKnownRequestError",
  "getApiKey", "getFallbackKey", "verifyApiKey", "warmupApiKeyCache", "clearApiKeyCache",
  "AnthropicApiKeys", "OpenAIKeys", "VertexAIKeys", "LangfuseKeys",
  "OpenAI", "Anthropic", "ChatOpenAI", "ChatVertexAI", "HttpsProxyAgent", "JWT",
  "OpenAIModelV1", "AnthropicAIModelV1", "VertexAIModelV1",
  "Langfuse", "CallbackHandler", "getLangfuseWithKey", "getLangfuseWithKeyTraceV1",
  "recordUsage", "createUsageRecorder",
];

const UNDERIVED_KEEP = [
  "uuidv4", "v4", "crypto", "hostname",
  "env", "logger", "loggerV2", "context",
  "HttpException", "ZodError", "z",
  "isNumber", "isToolsUnsupported", "getLanguageMapping", "providerHttpStatus",
  "getTraceId", "computeCost", "omit", "lodashChunk", "fs", "pipeline",
  "fromAnthropicUsage", "fromLangChainUsage", "fromOpenAIUsage", "fromVertexUsage",
  "UsageMetadata", "AnthropicToolResponse", "Provider", "CacheKeys",
  "OpenAIKeysSchema", "GoogleKeysSchema", "AnthropicApiKeysSchema",
  "LlmRequestPayloadV1", "LlmRequestPayloadV4", "CachedPromptData",
  "llmRequestPayloadV1", "llmRequestPayloadV1Combined", "llmRequestPayloadV3",
  "llmRequestPayloadV3Combined", "llmRequestPayloadV4", "llmRequestPayloadV4Stream",
  "openApiDocument",
  "express", "swaggerUi", "healthRoutes", "langfuseRoutes", "this.server",
  "queueManager", "this.queue", "requestQueueMiddleware",
  "executeWithCircuitBreaker", "executeInBackground", "runWithRetry", "timeoutStep",
  "getInvokeAction", "getInvokeWithToolsAction", "getInvokeWithToolsV4Action",
  "getStreamAction", "getStreamWithToolsV4Action", "Prompt",
];

const UNDERIVED_SLACK = ["SlackService", "sendSlackNotification", "sendErrorToSlack"];

/**
 * The target's boundary symbols, bucketed by the verdict they get with no row
 * context. This is what `--policy right-level` actually says about THIS repo.
 */
let bucketCache;
function buckets() {
  if (bucketCache) return bucketCache;
  const s = scan();
  if (!s) {
    bucketCache = {
      real: [NO_SCAN_NOTICE, ...UNDERIVED_REAL].slice(),
      keep: [NO_SCAN_NOTICE, ...UNDERIVED_KEEP].slice(),
      cache: IOREDIS_MOCK_POINT_NAMES.slice(),
      outward: [NO_SCAN_NOTICE, ...UNDERIVED_SLACK].slice(),
      derived: false,
    };
    return bucketCache;
  }
  const real = new Set();
  const keep = new Set();
  const cacheBucket = new Set();
  const outward = new Set();
  for (const symbol of s.bySymbol.keys()) {
    const ev = evidence(symbol);
    if (!ev) continue;
    switch (ev.cls) {
      case "cache":
        cacheBucket.add(symbol);
        break;
      case "outward":
        // Real, and named separately so the reason can say it is refused at the
        // endpoint rather than answered here.
        outward.add(symbol);
        real.add(symbol);
        break;
      case "database":
      case "downstream":
      case "database-or-downstream-field":
      // An unclassified symbol is recorded against the real boundary, so it
      // belongs in the real bucket and not in a bucket that reads as "the
      // proposal's answer stands".
      case "unknown":
        real.add(symbol);
        break;
      // determinism, inprocess, cache-wrapper: the proposal's declaration stands.
      default:
        keep.add(symbol);
    }
  }
  bucketCache = {
    real: [...real].sort(),
    keep: [...keep].sort(),
    cache: [...cacheBucket].sort(),
    outward: [...outward].sort(),
    derived: true,
  };
  return bucketCache;
}

/**
 * The database and every downstream service. A live run answers none of these:
 * the proposal's declaration is replaced by an OBSERVING passthrough, so the
 * real call happens and both halves are written down.
 *
 * Derived from the target's own scan - these are ITS symbols, or nothing.
 */
export const REAL_ONLY = new DerivedSet(() => buckets().real);

/**
 * Determinism controls and pure local helpers. These stay as the proposal
 * declared them.
 *
 * A uuid or a clock is not a downstream service, it is the reason two
 * recordings of one row differ - the determinism checker found a per-run uuid
 * as a KEY, not a value. Freezing them is what makes the pair replayable, and
 * a frozen uuid is not an invented downstream shape.
 *
 * Derived, same as REAL_ONLY.
 */
export const KEEP_AS_DECLARED = new DerivedSet(() => buckets().keep);

/** The cache mock points this target actually has. Empty on a repo with no Redis. */
export const REDIS_MOCK_POINT = new DerivedSet(() => buckets().cache);

/**
 * Outward-facing sends this target actually has. Informational: they are REAL,
 * and refused at the endpoint (see SLACK_MOCK_POINT), not answered here.
 */
export const SLACK = new DerivedSet(() => buckets().outward);

/* --------------------------------------------------------------- the evidence */

/**
 * What the TARGET says this symbol is, or null when it says nothing.
 *
 * `prisma.googleLocation.findMany` and `this.redis.get` are how proposals
 * spell a boundary, so a dotted name falls back to its root - the same key the
 * scan stores.
 *
 * Ambiguity resolves to `unknown`, which resolves to REAL: one name meaning two
 * things in two files is precisely the case where a guess is worth least.
 */
const evidenceCache = new Map();
function evidence(symbol) {
  if (evidenceCache.has(symbol)) return evidenceCache.get(symbol);
  const out = computeEvidence(symbol);
  evidenceCache.set(symbol, out);
  return out;
}

/**
 * `prisma.googleLocation.findMany` -> `prisma`, `this.redis.get` -> `this.redis`.
 * The key the scan stores, and the identifier the target's own source spells.
 */
function rootOf(symbol) {
  if (!symbol.includes(".")) return symbol;
  return symbol.startsWith("this.") ? symbol.split(".").slice(0, 2).join(".") : symbol.split(".")[0];
}

/** The scan's entry for a symbol, by its own name or by its root, or null. */
function scanEntry(symbol) {
  const s = scan();
  if (!s) return null;
  return s.bySymbol.get(symbol) ?? s.bySymbol.get(rootOf(symbol)) ?? null;
}

function computeEvidence(symbol) {
  const s = scan();
  if (!s) return null;
  const entry = scanEntry(symbol);
  if (!entry) return null;

  const seen = [];
  for (const mod of entry.modules) {
    for (const file of entry.files) {
      seen.push(classifyBoundaryModule(mod, file, entry, s));
    }
  }
  const distinct = [...new Set(seen.map((v) => v.cls))];
  if (distinct.length !== 1) {
    return {
      cls: "unknown",
      why: `imported from ${[...entry.modules].map((m) => `"${m}"`).join(" and ")} in this repo, which are not the same kind of thing`,
      owner: null,
    };
  }
  return seen[0];
}

/** One (module, importing file) pair -> a class, an owner file when in-repo. */
function classifyBoundaryModule(mod, fromFile, entry, s) {
  if (mod === "globalThis") {
    const g = GLOBAL_CLASS.get([...entry.why][0]);
    return g ? { ...g, owner: null } : { cls: "unknown", why: "a global the scan did not name", owner: null };
  }
  if (mod === "process") {
    return { cls: "inprocess", why: "process.env - configuration this row arranges for itself, not a downstream", owner: null };
  }
  if (mod === "<instance field>") {
    // A client held on a class field has no import to read. What it is follows
    // from what the file holding it reaches: a field in a file whose only
    // egress is the cache is the cache client; a field in a file that reaches
    // the database is a database client.
    const reach = reachOf(fromFile, s);
    if (reachesReal(reach)) {
      return { cls: "database-or-downstream-field", why: `held on a class in ${fromFile}, which reaches a real boundary`, owner: null };
    }
    if (reach.has("cache")) {
      return { cls: "cache-wrapper", why: `held on a class in ${fromFile}, whose only egress is the cache`, owner: fromFile };
    }
    return { cls: "unknown", why: `held on a class in ${fromFile}, which the scan cannot resolve to a module`, owner: null };
  }
  const selfFile = selfFileFor(mod, fromFile, s);
  if (selfFile) {
    const reach = reachOf(selfFile, s);
    if (reachesReal(reach)) {
      return { cls: "downstream", why: `defined in ${selfFile}, which reaches a real boundary - answering it deletes that call from the measurement`, owner: selfFile };
    }
    if (reach.has("cache")) {
      return { cls: "cache-wrapper", why: `defined in ${selfFile}, whose only egress is the cache`, owner: selfFile };
    }
    return { cls: "inprocess", why: `defined in ${selfFile}, which reaches no boundary of its own - this row is arranging ITSELF`, owner: selfFile };
  }
  const known = classOfModule(mod);
  if (known) return { ...known, why: `from "${mod}" - ${known.why}`, owner: null };
  if (entry.advisory) {
    return { cls: "determinism", why: `from "${mod}", marked advisory by the scan - nondeterminism, not a downstream`, owner: null };
  }
  return { cls: "unknown", why: `from "${mod}", which this policy has no classification for`, owner: null };
}

/* ------------------------------------------------------------- preconditions */

/** How the doubles file is referred to in a message - the absolute path is only worth printing once. */
const DOUBLES_REL = `${FIXTURES_REL}/doubles.ts`;

/**
 * What the policy (`real-except-cache`, the default, and `right-level`) injects
 * into EVERY row, and therefore what a repo must have for those rows to record. Kept next to the policy
 * because the policy is what requires them; record.mjs is where they are
 * written into the spec.
 */
/** The specifiers node-redis v5 is imported by. `redis` re-exports `@redis/client`. */
export const NODE_REDIS_SPECIFIERS = ["redis", "@redis/client"];

const RIGHT_LEVEL_INJECTS = [
  {
    module: "ioredis",
    double: "ioredisMiss",
    what: "the cache miss below the code under test",
    // Named so the refusal can say what this repo uses INSTEAD. ptp-be depends
    // on node-redis (`redis`), so "no ioredis" there is not a missing install,
    // it is a different transport - and a refusal that says which one is a
    // refusal somebody can act on.
    instead: ["redis", "@redis/client", "redis-mock", "keyv"],
  },
  // node-redis, the OTHER Redis client, under the same policy (D34). Without it
  // the real v5 client dialled 127.0.0.1:6379 in a mocked run and its reconnect
  // timer put a varying number of error-log calls into every row's call list.
  // One entry per specifier the source can import it by; `available` says
  // whether this repo would import it (see nodeRedisModules).
  ...NODE_REDIS_SPECIFIERS.map((module) => ({
    module,
    double: "nodeRedisMiss",
    what: "the cache miss below the code under test",
    available: () => nodeRedisModules().includes(module),
    instead: ["ioredis", "redis-mock", "keyv"],
  })),
  {
    module: "axios",
    double: "axiosSilenced",
    // INACTIVE. axios is a transport, not an endpoint - see SLACK_MOCK_POINT.
    // Kept in the table so the reasoning stays next to the entry it explains,
    // and so re-activating it is one word rather than a reconstruction.
    active: false,
    what: "the transport under an outward-facing Slack send",
    instead: ["node-fetch", "got", "undici", "superagent"],
  },
];

/** Is `name` exported from the target's doubles? Read textually - the doubles are TypeScript. */
function doublesExport(name) {
  try {
    const src = readFileSync(resolve(FIXTURES_DIR, "doubles.ts"), "utf8");
    return new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`, "m").test(src);
  } catch {
    return false;
  }
}

/** Is `mod` installed in, or declared by, the repo being recorded? */
export function moduleAvailable(mod) {
  if (existsSync(resolve(REPO_ROOT, "node_modules", mod, "package.json"))) return true;
  return declaresDependency(mod);
}

/** Does the repo's own package.json name `mod` as a dependency? */
function declaresDependency(mod) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
    return Boolean({ ...pkg.dependencies, ...pkg.devDependencies }[mod]);
  } catch {
    return false;
  }
}

/**
 * Which node-redis specifiers this repo can import its client by, so the policy
 * answers `createClient` at each of them (D34).
 *
 * `redis` when it is there at all, the same test `ioredis` gets. `@redis/client`
 * only when the repo DECLARES it: it is installed under every `redis`, so its
 * presence in node_modules says nothing about the source, and a mock at a
 * specifier nothing imports is one more line in every row for nothing.
 */
export function nodeRedisModules() {
  return NODE_REDIS_SPECIFIERS.filter((m) => (m === "redis" ? moduleAvailable(m) : declaresDependency(m)));
}

let preconditionCache;
/**
 * What this repo is missing for the injections the policy makes, as sentences.
 * Empty when it can carry them all.
 *
 * Called on the FIRST classification of a run rather than at import: importing
 * a tool has to stay side-effect free (the gate's `tools-parse` check imports
 * every one of them), and `classify` is only ever called with the policy in
 * force, so the first call is the earliest honest moment.
 */
export function policyPreconditions() {
  if (preconditionCache === undefined) {
    // ONLY THE INJECTIONS THIS REPO CAN CARRY.
    //
    // A repo with no ioredis has no ioredis to cut below, so there is nothing
    // to inject and nothing to demand. Asking for the double anyway refused the
    // whole run: location-ms has neither ioredis nor axios and neither double
    // in its fixtures, which is four unmet preconditions and a throw on the
    // first classified boundary - on a repo where the policy had no work to do
    // in the first place.
    // GATED ON THE INJECTION BEING ACTIVE, not merely on the module existing.
    //
    // Filtering on module availability alone demanded a double the policy will
    // never use: `MOCK_AT_AXIOS` is false now that axios is a transport rather
    // than a mock point, yet a repo that HAS axios still had to export
    // `axiosSilenced()` or every row refused before recording. Measured on
    // qode-ptp-ms, which has axios and the stub `doubles.ts` that install.sh
    // writes: stage 4 exited 1 on all 190 proposals. location-ms has neither
    // axios nor ioredis, which is the only reason it never tripped.
    preconditionCache = RIGHT_LEVEL_INJECTS.filter((i) => i.active !== false && (i.available ? i.available() : moduleAvailable(i.module))).flatMap((i) =>
      doublesExport(i.double) ? [] : [{ module: i.module, double: i.double, why: `${DOUBLES_REL} exports no ${i.double}() - ${i.what}` }]
    );
  }
  return preconditionCache;
}

/**
 * The skip reason for a row that needs an injection this repo cannot carry, or
 * null when it can. NEVER THROWS (fix plan 1, F1.1).
 *
 * It threw, once per run, from inside `classify()` - and `classify()` is called
 * per row from record.mjs, so the throw ended record.mjs with exit 1 for the
 * whole batch. ai-centralization `20260922T213127Z` died that way: the default
 * policy injects `doubles.ioredisMiss()` into every row of an ioredis repo, the
 * seeded `doubles.ts` had none, and not one row recorded. That is a kill point.
 * A tool that cannot serve some rows fails THOSE rows, with a name: the caller
 * skips each affected row with this reason, and the skip is a pipeline defect
 * downstream - never a bad proposal, and never an exit.
 *
 * The message named `--policy right-level` whatever the policy in force was;
 * `policy` is now the caller's own. `module` narrows it to one injection, for a
 * row that declares its own answer for the other.
 */
export function assertPolicyRunnable({ policy = "real-except-cache", module } = {}) {
  const unmet = policyPreconditions().filter((u) => module === undefined || u.module === module);
  if (unmet.length === 0) return null;
  return (
    `pipeline defect: --policy ${policy} injects ${unmet.map((u) => `doubles.${u.double}() at "${u.module}"`).join(" and ")} ` +
    `into every row that does not answer ${unmet.length === 1 ? "that module" : "those modules"} itself, and ${unmet.map((u) => u.why).join("; ")}. ` +
    `The toolset is short, not the proposal: reseed ${DOUBLES_REL} from install.sh's template, or write ` +
    `${unmet.map((u) => `${u.double}()`).join(" and ")} in ${resolve(FIXTURES_DIR, "doubles.ts")}`
  );
}

/* ------------------------------------------------------------------- degrades */

/**
 * Symbols the target's own scan carries no module for. Reported, never silent.
 */
const DEGRADED = new Set();
let degradeReported = false;

function noteDegraded(symbol) {
  const first = DEGRADED.size === 0;
  DEGRADED.add(symbol);
  if (first) {
    process.stderr.write(
      `! policy: ${scan() ? "out/scan.json carries no module for" : "out/scan.json could not be read, so there is no module for"} ` +
        `some boundary symbols, and an unclassified symbol is the worst case to answer from a guess - they are RECORDED AGAINST THE REAL BOUNDARY. Count printed at exit.\n`
    );
  }
  if (degradeReported) return;
  degradeReported = true;
  process.on("exit", () => {
    const names = [...DEGRADED].sort();
    process.stderr.write(
      `\n! policy: ${names.length} boundary symbol(s) could not be classified from this repo's own scan and were recorded against the REAL boundary:\n` +
        `    ${names.join(" ")}\n` +
        `  Those rows recorded what the real boundary did, NOT the proposal's answer for it.\n` +
        `  Set CHARPILOT_POLICY_UNCLASSIFIED=refuse to make them unrunnable instead.\n`
    );
  });
}

/** What was degraded this run, for a caller that would rather report than print. */
export function degradedSymbols() {
  return [...DEGRADED].sort();
}

/* ----------------------------------------------------- the mode is the boundary */

/**
 * WHY THE MODE DECIDES THE VERDICT, AND WHY IT DOES IT HERE.
 *
 * `uncertain()` below already says it for the symbols nobody could classify: in
 * a MOCKED run there is no real boundary to record from. A mocked run has
 * deliberately taken it away, so "real" there does not mean "observe the
 * dependency", it means "run the real export against a placeholder DSN and a
 * closed egress allowlist", which is an account of nothing the service does.
 *
 * THAT REASONING WAS NEVER ABOUT UNCERTAINTY. It is about what exists to record
 * from, and nothing about a CONFIDENT classification puts the dependency back.
 * On location-ms, in a mocked run against its own scan: `fetch` is classified
 * `downstream` from the scan's `why: "network"`, so it never reaches
 * `uncertain()` at all, and came back `real`. `prisma` and `logger` came back
 * `mock` there - but only because that repo's scan resolves neither to a module
 * this table knows, so they fell through to `uncertain()`. On a repo whose scan
 * DOES say `@prisma/client`, the same mocked run answers `real` for the
 * database. That is luck, not policy.
 *
 * ===========================================================================
 * WHAT THIS RULE DOES NOT DO, WHICH IS THE PART EVERYONE GETS WRONG
 * ===========================================================================
 *
 * A VERDICT OF `real` HERE DOES NOT, TODAY, MAKE A MOCKED RUN CALL ANYTHING.
 * The other half of the decision is in record.mjs and it is already gated:
 *
 *     record.mjs:367   const REAL_DOWNSTREAM = LIVE && POLICY === "real-except-cache";
 *     record.mjs:1004  live = wrongLevel || (REAL_DOWNSTREAM && c.verdict === "real");
 *
 * `live` there is the only thing that suppresses the proposal's declared answer
 * (`kind: live ? "live" : kind`), and in a mocked run `LIVE` is false, so
 * `REAL_DOWNSTREAM` is false, so that disjunct is false WHATEVER this file
 * says. The declared answer is installed either way; only `redis-wrong-level`
 * and `slack-wrong-level` can still flip it, and neither is reachable for a
 * downstream symbol.
 *
 * THE location-ms INCIDENT WAS FIXED THERE, NOT HERE. `REAL_DOWNSTREAM` used to
 * be `POLICY === "real-except-cache"` and nothing more, so a mocked run dropped
 * the declared double for `prisma` and every downstream and substituted
 * `kind: "live"` against a database it could not reach - the story record.mjs
 * tells in its own words at record.mjs:344-356. Gating it on `LIVE` is what
 * stopped it. Read `uncertain()`'s note below with that in mind: it describes a
 * real incident, and the repair it belongs to was in the recorder.
 *
 * SO WHY STATE IT HERE AT ALL. Three reasons, none of them "this stops the
 * call":
 *
 *   1. THE ROW MUST NOT CONTRADICT ITSELF. record.mjs:1005 records
 *      `{verdict, why, dropped}` per boundary. In a mocked run a confidently
 *      classified downstream produced `verdict: "real"` beside `dropped: false`
 *      - "this was recorded against the real boundary" next to "the proposal's
 *      answer was installed". Both halves written by us, disagreeing, in the
 *      artifact that explains the pair. Nothing reads that array yet, which is
 *      the only reason it has misled nobody.
 *   2. A REFUSAL SHOULD NOT REST ON ONE GATE IN ANOTHER FILE. `LIVE &&` at
 *      record.mjs:367 is a single expression, and it was absent once. With the
 *      mode read here too, deleting it again re-opens the level correction and
 *      not the billed call.
 *   3. IT IS WHAT THE FILE ALREADY CLAIMS. The rule was stated once, for the
 *      uncertain case, and applied nowhere else; a rule with one arbitrary
 *      exception is a rule nobody can reason from.
 *
 * WHAT WOULD MAKE IT LOAD-BEARING, for whoever picks this up: the live call a
 * mocked run can still make is a REQUIRED boundary with NO declared answer.
 * validate.mjs:984 only WARNS about one ("no answer declared for boundary ..."),
 * and an unanswered global is stubbed by nothing - `stubGlobal` at
 * record.mjs:3658 installs an answer, it does not invent one - so the real
 * `fetch` runs. Making that refuse the row in a mocked run, where this file now
 * says the symbol must be answered, is the half that actually closes it. It is
 * a change to the recorder and the validator, and it is not made here.
 *
 * SO THE MODE IS APPLIED AT THE VERDICT, NOT AT THE CLASSIFICATION. What a
 * module IS does not change with the run: `classifyBoundaryModule` and the
 * buckets it feeds answer "what is this symbol in this repo", and they are what
 * `REAL_ONLY`, `KEEP_AS_DECLARED` and `--policy right-level` print about the
 * TARGET, with no run and no mode in sight. Teaching either of them about
 * `live` would make the target's own description depend on today's flags.
 * `live` is a fact about the RUN, so it is spent where the run's answer is
 * produced - in `classify`, on the way out.
 *
 * THE TRADE IS REAL AND IT IS REPORTED. A pair whose boundary the mode answered
 * is only as good as the agent's declared answer, where in a live run it was as
 * good as the dependency. That is what mocked mode IS - but a run must be able
 * to say which symbols it happened to, so every one is counted, named at exit,
 * carried on the decision as `modeAnswered` and readable through
 * `modeAnsweredSymbols()`. Silent would be the defect.
 */
const MODE_ANSWERED = new Set();
let modeReported = false;

function noteModeAnswered(symbol) {
  MODE_ANSWERED.add(symbol);
  if (modeReported) return;
  modeReported = true;
  process.stderr.write(
    `! policy: this is a MOCKED run, so boundaries that a live run would RECORD FROM are answered by the proposal instead - ` +
      `there is no real dependency here to record from. Named at exit.\n`
  );
  process.on("exit", () => {
    const names = [...MODE_ANSWERED].sort();
    process.stderr.write(
      `\n! policy: ${names.length} boundary symbol(s) would have been recorded against the REAL boundary in a live run and were answered by the proposal because this run is MOCKED:\n` +
        `    ${names.join(" ")}\n` +
        `  Those pairs are only as good as the declared answer. Re-record them with --live to characterize the dependency itself.\n`
    );
  });
}

/** What the mode answered this run, for a caller that would rather report than print. */
export function modeAnsweredSymbols() {
  return [...MODE_ANSWERED].sort();
}

/**
 * THE ONE EXCEPTION, AND IT IS NOT A NAME.
 *
 * `err instanceof PrismaClientKnownRequestError` is a boundary symbol imported
 * from `@prisma/client/runtime/library`, which this table calls the database,
 * so the mode rule above would answer it. Answering it is the worst outcome
 * this pipeline has: a substitute is not that constructor, the identity check
 * is false for every value, the arm takes the else branch, and the test PASSES
 * while characterizing nothing.
 *
 * THE CLASS IS "USED AS AN IDENTITY, NOT CALLED FOR AN ANSWER". A symbol in
 * `instanceof X`, `class Y extends X` or `X.prototype` is not a source of
 * behaviour that a value could stand in for - it is the fixed point the code
 * COMPARES against, and the comparison is the arm. There is no answer to give:
 * whatever is substituted, the only thing that changes is which branch runs,
 * and it changes silently. Leaving it real costs nothing either, because an
 * identity reference makes no call - "real" for these means "leave the export
 * alone", not "reach the dependency".
 *
 * READ OFF THE TARGET'S OWN SOURCE, in the files its own scan says the symbol is
 * touched in, for the same reason nothing else here is a name list: a list
 * would hold `PrismaClientKnownRequestError` and miss this repo's `ZodError`,
 * that repo's `HttpException` and the next one's hand-written `class
 * DomainError`. The question "is this symbol compared against rather than
 * called" is a fact about the target, and the target is where it is asked.
 *
 * ANY identity use is enough, not "only ever an identity". A symbol that is
 * both called and compared against still breaks the comparison when it is
 * substituted, and the direction to be wrong in is the one that leaves the
 * verdict where live already has it.
 */
const IDENTITY_USE = [
  (n) => new RegExp(`\\binstanceof\\s+${n}\\b`),
  (n) => new RegExp(`\\bextends\\s+${n}\\b`),
  (n) => new RegExp(`\\b${n}\\s*\\.\\s*prototype\\b`),
];

const sourceCache = new Map();
function sourceOf(file) {
  if (!sourceCache.has(file)) {
    try {
      sourceCache.set(file, readFileSync(resolve(REPO_ROOT, file), "utf8"));
    } catch {
      sourceCache.set(file, null);
    }
  }
  return sourceCache.get(file);
}

const identityCache = new Map();
/**
 * Where this repo compares against the symbol rather than calling it, or null.
 *
 * EXPORTED because `worklist.mjs` asks the same question one stage earlier: an
 * arm whose condition names an identity - `err instanceof
 * PrismaClientKnownRequestError` - is not decided by what a collaborator does,
 * so it must not be handed over as a boundary question. That is this rule, not
 * a neighbouring one, and a second copy of it in the other tool is how the two
 * come to disagree with nothing to say which is wrong.
 */
export function identityUse(symbol) {
  if (identityCache.has(symbol)) return identityCache.get(symbol);
  const out = computeIdentityUse(symbol);
  identityCache.set(symbol, out);
  return out;
}

function computeIdentityUse(symbol) {
  const entry = scanEntry(symbol);
  if (!entry) return null;
  // The identifier the source spells. `Prisma.PrismaClientKnownRequestError` is
  // reached by the root `Prisma`, which is how the scan carries it.
  const name = rootOf(symbol).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forms = IDENTITY_USE.map((f) => f(name));
  for (const file of entry.files) {
    const src = sourceOf(file);
    if (!src) continue;
    for (const re of forms) {
      const at = src.split("\n").findIndex((l) => re.test(l));
      if (at >= 0) return `${file}:${at + 1}`;
    }
  }
  return null;
}

/**
 * A verdict of `real`, unless the mode says there is nothing real to record
 * from. The single funnel every `real` in `classify` goes through, so the rule
 * cannot hold on one path and not another - which is the defect this exists for.
 */
function realUnlessMocked(symbol, live, why) {
  if (live) return { verdict: "real", why };
  const where = identityUse(symbol);
  if (where) {
    return {
      verdict: "real",
      why:
        `${why} - and although this is a MOCKED run, ${symbol} is compared against rather than called here (${where}): ` +
        `a substitute is not that constructor, so the check goes false and the arm takes the other branch with nothing to show for it`,
    };
  }
  noteModeAnswered(symbol);
  return {
    verdict: "mock",
    why:
      `${why} - but this is a MOCKED run, which has taken that dependency away: calling this real would be an account of a boundary ` +
      `this run does not have, and the proposal's declared answer is what gets installed for it either way (mode-answered, named at exit)`,
    modeAnswered: true,
  };
}

/* ------------------------------------------------------------------- classify */

/** class -> verdict, for the classes that do not depend on the row. */
function verdictOfClass(cls) {
  switch (cls) {
    case "database":
    case "downstream":
    case "outward":
    case "database-or-downstream-field":
      return "real";
    case "cache":
      return "mock";
    case "determinism":
    case "inprocess":
      return "mock";
    default:
      return null;
  }
}

/**
 * @param {string} symbol
 * @param {string[]} coveredFiles files this row's own arms live in
 * @param {{ live?: boolean }} mode whether this run has a real boundary at all
 * @returns {{ verdict: "real" | "mock" | "redis-wrong-level" | "slack-wrong-level" | "unclassified", why: string, degraded?: boolean, modeAnswered?: boolean }}
 */
export function classify(symbol, coveredFiles = [], { live = true } = {}) {
  // NO PRECONDITION CHECK HERE ANY MORE. It threw from this line, per row, and
  // ended the whole recording (fix plan 1, F1.1). A classification is a fact
  // about a symbol; whether this repo can carry the injection is a fact about a
  // ROW, and record.mjs asks `assertPolicyRunnable` for each row it injects into.

  const ev = evidence(symbol);
  if (ev) {
    // Subject-relative, and this one cost the most to get right.
    //
    // Answering a cache wrapper replaces the wrapper's arms AND whatever it
    // wraps. That is fatal for a row whose arms are IN the wrapper. It is not
    // fatal for a row whose arms are in a resolver: there the answer is simply
    // "what the cached lookup returned", the resolver's own arms run normally,
    // and the alternative - running the real wrapper against a denied database
    // - is strictly worse.
    //
    // Measured, dropping them unconditionally: 47 resolver/model rows lost
    // their config resolution, the union fell 1325/1488 -> 1233/1488, and false
    // claims doubled (102 -> 201) with 36 of the new ones in anthropicAIModel.ts
    // alone. So the rule is: wrong level only when the row's own arms live in
    // the file that defines it.
    //
    // NARROWED, deliberately: a module that reaches the cache AND the database
    // is NOT treated this way - `reachesReal` is checked first, so it comes
    // back real. Answering it would replace a real query with a canned value,
    // which is drop-off (1), and the level argument above only holds for a
    // wrapper whose whole egress is the cache.
    if (ev.cls === "cache-wrapper") {
      if (ev.owner && coveredFiles.includes(ev.owner)) {
        return {
          verdict: "redis-wrong-level",
          why: `${symbol} IS this row's subject (its arms are in ${ev.owner}) - the seam moves down to the cache client itself`,
        };
      }
      return {
        verdict: "mock",
        why: `${symbol} is ${ev.why}, strictly below this row's arms - a per-call sequence here is what selects the branch, and dropping it would remove the only control the row has`,
      };
    }
    if (ev.cls === "cache") {
      return { verdict: "mock", why: `${symbol} is ${ev.why} - the one legitimate cache mock point` };
    }
    if (ev.cls === "outward") {
      return realUnlessMocked(
        symbol,
        live,
        `${symbol} is ${ev.why} - answered nowhere: the send is refused at its ENDPOINT by the egress allowlist and named as blocked, which is exact where silencing the transport is not`
      );
    }
    const v = verdictOfClass(ev.cls);
    if (v === "real") {
      return realUnlessMocked(
        symbol,
        live,
        `${symbol} is ${ev.why} - reachability is the egress allowlist's question, and a canned answer here would be an invented shape`
      );
    }
    if (v === "mock") {
      return { verdict: "mock", why: `${symbol} is ${ev.why}` };
    }
    // ev.cls === "unknown": the scan named a module and this policy has no
    // classification for it. Falls through to the uncertainty rule below with
    // the module quoted, so the report says what it could not decide.
    return uncertain(symbol, live, ev.why);
  }

  // NO EVIDENCE FROM THE TARGET.
  //
  // Two general facts are still worth consulting, and neither is a service
  // symbol. A global has no import for the scan's module map to find, so it is
  // named by the same table scan.mjs itself carries (scan.mjs:608).
  const g = GLOBAL_BY_NAME.get(symbol);
  if (g) {
    const k = GLOBAL_CLASS.get(g);
    return verdictOfClass(k.cls) === "real"
      ? realUnlessMocked(symbol, live, `${symbol} is ${k.why} - a canned answer here would be an invented shape`)
      : { verdict: "mock", why: `${symbol} is ${k.why}` };
  }

  // And, ONLY when there is no scan to read at all, a symbol that IS a module
  // name answers for itself. With a scan this is skipped on purpose: a name
  // that happens to match a package in a repo whose scan does not carry it is
  // not evidence about that repo, and refusal (1) - never name a symbol the
  // target does not have - is worth more than the guess.
  if (!scan()) {
    if (IOREDIS_MOCK_POINT_NAMES.includes(symbol)) {
      return { verdict: "mock", why: `${symbol} is ioredis or its default export - unreachable in-cluster infrastructure, and the one legitimate cache mock point` };
    }
    const k = classOfModule(symbol);
    if (k) {
      return verdictOfClass(k.cls) === "real"
        ? realUnlessMocked(symbol, live, `${symbol} names a module that is ${k.why} - a canned answer here would be an invented shape`)
        : { verdict: "mock", why: `${symbol} names a module that is ${k.why}` };
    }
  }

  return uncertain(symbol, live, "this repo's own scan carries no module for it");
}

/**
 * THE UNCERTAIN CASE, AND WHY IT IS REAL.
 *
 * Stage 4 exists so the code decides the output, and a symbol nobody could
 * classify is the case where we know least - the worst possible one to answer
 * from a proposal. Recording what the real boundary DOES is the only answer
 * that cannot freeze an invented shape.
 *
 * IN A MOCKED RUN THERE IS NO REAL BOUNDARY TO RECORD FROM. A mocked run has
 * deliberately taken it away; "real" there does not mean "observe the
 * dependency", it means "run the real export against a placeholder DSN and a
 * closed egress allowlist", which records a connection error as the service's
 * behaviour. So the fallback follows the mode - live: record the real boundary;
 * mocked: the proposal's declared answer is the only answer there is.
 *
 * WHAT THIS PARAGRAPH USED TO CLAIM, CORRECTED. It said "measured on
 * location-ms: in a mocked run `fetch` was classified real and called
 * places.googleapis.com for real", which reads as though the call followed from
 * the verdict and was stopped here. It did not and it was not. The verdict is
 * spent at record.mjs:1004, where the mocked-mode gate `REAL_DOWNSTREAM = LIVE
 * && ...` (record.mjs:367) makes a `real` verdict inert - and that gate is what
 * repaired the incident. See "WHAT THIS RULE DOES NOT DO" above the mode
 * section for the whole mechanism. This branch, and the one above it, are the
 * policy telling the truth about the run, not the thing that closes the egress.
 */
function uncertain(symbol, live, because) {
  if (!live) {
    // NOT A SECOND RULE. This branch is the mode rule stated for the symbols
    // that reach here, and `realUnlessMocked` is the same rule for the ones
    // that never do; they cannot disagree, because the one case where they
    // could - a symbol that is unclassified AND compared against rather than
    // called - is decided by the same `identityUse` on both paths.
    //
    // It stays written out here rather than delegating because the degrade is
    // this function's: an unclassified symbol recorded REAL is what `! policy:`
    // counts, and that accounting belongs to the live path alone. An identity
    // reference makes no call, so it is not "recorded against the real
    // boundary" in the sense the degrade counter reports, and it is not counted
    // as one.
    const where = identityUse(symbol);
    if (where) {
      return {
        verdict: "real",
        why: `${symbol} could not be classified from this repo (${because}), and this is a MOCKED run - but it is compared against rather than called here (${where}), so a substitute would send the arm silently down the other branch`,
      };
    }
    noteModeAnswered(symbol);
    return {
      verdict: "mock",
      why: `${symbol} could not be classified from this repo (${because}), and this is a MOCKED run - the proposal's declared answer is the only boundary there is (mode-answered, named at exit)`,
      modeAnswered: true,
    };
  }
  if ((process.env.CHARPILOT_POLICY_UNCLASSIFIED ?? "").trim() === "refuse") {
    return {
      verdict: "unclassified",
      why: `${symbol} could not be classified from this repo (${because}) - classify it before the run rather than defaulting it`,
    };
  }
  noteDegraded(symbol);
  return {
    verdict: "real",
    why: `${symbol} could not be classified from this repo (${because}) - recorded against the REAL boundary rather than the proposal's answer, because an unclassified symbol is the worst case to answer from a guess (degraded, counted at exit)`,
    degraded: true,
  };
}

/** Human-readable summary of a run's decisions, for the recorder's stdout. */
export function summarise(decisions) {
  const by = new Map();
  for (const d of decisions) {
    const k = `${d.verdict}`;
    if (!by.has(k)) by.set(k, new Set());
    by.get(k).add(d.symbol);
  }
  const lines = [...by.entries()].map(
    ([k, s]) => `    ${k.padEnd(20)} ${String(s.size).padStart(3)} symbols  ${[...s].sort().slice(0, 8).join(" ")}${s.size > 8 ? " …" : ""}`
  );
  // Degrades are inside the `mock` bucket - they ARE mocks, the proposal's own -
  // so a caller reading only the buckets would not see them.
  const degraded = decisions.filter((d) => d.degraded).map((d) => d.symbol);
  if (degraded.length) {
    const uniq = [...new Set(degraded)].sort();
    lines.push(`    ${"(of which degraded)".padEnd(20)} ${String(uniq.length).padStart(3)} symbols  ${uniq.slice(0, 8).join(" ")}${uniq.length > 8 ? " …" : ""}`);
  }
  // And the mode's own downgrades, which are inside the `mock` bucket for the
  // same reason - they ARE the proposal's answer - but were REAL boundaries
  // that a live run would have recorded from. A run that cannot name them
  // reports a mocked pair as though the mode had cost it nothing.
  const answered = decisions.filter((d) => d.modeAnswered).map((d) => d.symbol);
  if (answered.length) {
    const uniq = [...new Set(answered)].sort();
    lines.push(`    ${"(of which mocked-by-mode)".padEnd(20)} ${String(uniq.length).padStart(3)} symbols  ${uniq.slice(0, 8).join(" ")}${uniq.length > 8 ? " …" : ""}`);
  }
  return lines.join("\n");
}
