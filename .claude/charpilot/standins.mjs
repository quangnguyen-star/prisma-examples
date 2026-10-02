/**
 * A STAND-IN FOR EVERY ENV VAR THE SERVICE NEEDS AND NOBODY SUPPLIED - MOCKED
 * MODE ONLY (tool backlog; run 20260924T054817Z, image-forwarder-ms).
 *
 * image-forwarder's `src/services/blobService.ts` throws at module top level
 * when AZURE_STORAGE_ACCOUNT_NAME or AZURE_STORAGE_ACCOUNT_KEY is unset. Stage 1
 * resolves values from the qode-iac ConfigMap only, and that one carries
 * GCP_STORAGE_BUCKET_NAME and GCP_STORAGE_PATH and nothing else. The repo's
 * `.env.example` names the Azure keys, the container name and SECRET_KEY, and
 * nothing filled them - so every row that imported blobService died in its
 * ARRANGEMENT: 12 of 28 sides lost as `pipeline_defect` with "Azure Storage
 * account name and key must be provided." That is the tool failing, not the
 * code behaving, and it is the same for any service that checks its env on
 * import.
 *
 * WHAT "NEEDS" MEANS, and nothing wider: a name read as `process.env.X` /
 * `process.env["X"]` / `const { X } = process.env` in the source directory
 * (srcdir.mjs, minus SRC_EXCLUDE and test files) by AT LEAST ONE READ THAT
 * BRINGS NO DEFAULT - no `??`, no `||`, no destructuring default, no optional
 * chain (review B1), not used as a test and not guarded by one, not a parse
 * whose result is defaulted (verifier F3; processEnvReadsIn). A name every read of which defaults is left unset: the
 * code has its own answer for "unset", and a stand-in would make that side,
 * and the var's `undefined` side, unreachable. The rule is the narrowest that
 * still unblocks image-forwarder: `process.env.AZURE_STORAGE_ACCOUNT_NAME` is
 * read bare. (Keying on the guard or throw instead would need data flow - the
 * guard there tests a local copy - for no extra name.)
 *
 * AND A NAME THE ENV SCHEMA REQUIRES with no default (baseline.json
 * `envDefaults.requiredNoDefault`), read or not. `z.object({...}).parse(
 * process.env)` names no var in a `process.env.X` read, yet refuses to load
 * without every required one - pricing-service lost 114 sides to exactly that
 * (planStandIns).
 *
 * AND A NAME THE CODE REFUSES TO LOAD WITHOUT, read through the parsed env
 * object, whose schema default is "" or absent (envReadsIn). qode-ptp-ms
 * declares `SOURCING_MS_HOST: z.string().default('')` and a module-scope
 * singleton throws "SOURCING_MS_HOST is not set" on `if (env.X) .. else throw`
 * - 212 sides lost in run 20260925T072635Z to a name neither rule above saw.
 *
 * AND A NAME AN SDK THE REPO DEPENDS ON CANNOT BE CONSTRUCTED WITHOUT
 * (SDK_ENV, sdkEnvNeeds). qode-ptp-ms, September 2026, 904 sides: a
 * module-scope singleton runs `new S3Client({ region: env.AWS_REGION })`, the
 * schema says `AWS_REGION: z.string().default('')`, and the AWS SDK's own
 * `if (!region) throw new Error("Region is missing")` runs in the constructor.
 * The refusal is inside node_modules, so no read rule above sees it, and the
 * empty default kept the name out of the plan.
 *
 * The example files (`.env.example`, `.env.sample`, `.env.template`) only
 * annotate `neededBy`; a name they carry that no source read names is not
 * stood in. Only NAMES are read from them. Their values are frequently real -
 * image-forwarder's carries a live-shaped storage key - and none of them is
 * ever used, printed or stored.
 *
 * A ROW CAN STILL UNSET ANY OF THEM: `setup[].apply.env` takes `null` for a
 * name, which deletes it for that row and restores it after (record.mjs), in
 * the recording and in the emitted suite alike. That is how the missing-env
 * side of a stood-in var is reached.
 *
 * NEVER A STAND-IN FOR:
 *   - a name anything already supplies: staging, the process env, the repo's
 *     own .env files (a dotenv load never overrides a set value, so a stand-in
 *     there would silently beat the repo's own value);
 *   - a name the env schema DEFAULTS (baseline.json envDefaults) - the repo
 *     provides that value itself;
 *   - a database variable (config.mjs isDatabaseVar). Those keep the existing
 *     rule: masked to db.invalid when set, left alone when not. Nothing here
 *     touches the mocked-mode database deny or the client-module deny;
 *   - a FLAG-SHAPED name (ENABLE_*, DISABLE_*, *_ENABLED, *_DISABLED, USE_*,
 *     SKIP_*, IS_*, *_FLAG): any stand-in reads as ON (verifier F3) - unless
 *     a read of it guards a load refusal, which the module cannot pass without it;
 *   - a name the runtime or the harness owns (NODE_ENV, TZ, PORT, PATH, ...):
 *     the recorder sets several of those itself, and a fake TZ or NODE_ENV
 *     changes every row, not the one that needed it.
 *
 * NEVER IN A LIVE RUN. A live recording that lacks a real value must fail on
 * it, visibly; a stand-in would let it record against a value nobody deployed.
 * Every caller checks the mode before it applies this.
 *
 * THE VALUE is deterministic - one name, one value, every run - and obviously
 * fake, in a shape the common validators accept: never empty; a URL on a
 * `.invalid` host (RFC 6761, resolves nowhere) for *_URL/_URI/_ENDPOINT/_WEBHOOK;
 * the bare `.invalid` host for a name that carries a host - HOST, HOSTNAME,
 * DOMAIN, BROKERS, SERVER, ADDR, BUCKET... (ROUTES);
 * digits for *_PORT and for duration- and count-shaped names (NUMERIC_TIME,
 * NUMERIC_COUNT); base64 for *_KEY/_SECRET (Azure's StorageSharedKeyCredential
 * base64-decodes the key at construction); a stand-in PEM of the right kind for
 * *PUBLIC_KEY / *PRIVATE_KEY (envfile.mjs placeholderPem). A declared schema
 * shape wins over the name, as it does for recorded.env (record.mjs
 * inertEnvValue): an enum its first member, a number a number, a URL rule an
 * https URL on the `.invalid` host.
 *
 * A NAME THE SOURCE USES AS A KEY OR AS CIPHERTEXT is given what that use
 * accepts, whatever the name looks like (cryptoUsesIn). A key handed to
 * `publicDecrypt`/`publicEncrypt`/`createPublicKey` gets the stand-in public
 * PEM, one handed to `privateDecrypt`/`privateEncrypt`/`createPrivateKey` the
 * stand-in private PEM - one fixed pair, so a public and a private name always
 * match. A name whose value is decrypted by `publicDecrypt` under a stood-in
 * key gets `charpilot-placeholder` encrypted under the stand-in private key
 * (envfile.mjs standInCiphertext). pricing-ms, the mocked run of September 26:
 * `STRIPE_SECRET_KEY: z.string().transform(decrypt)`, and `decrypt` runs
 * `crypto.publicDecrypt({ key: process.env.PUBLIC_KEY, .. }, Buffer.from(data,
 * 'base64'))`. The base64 text stand-in is no ciphertext, the schema threw
 * "rsa routines::invalid padding" at import, and 104 sides died in arrangement.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";

import { envNames, placeholderPem, standInCiphertext } from "./envfile.mjs";

/** The repo's own example env files - names only. */
export const EXAMPLE_ENV_FILES = [".env.example", ".env.sample", ".env.template"];
/** The repo's own env files, whose names are SUPPLIED (a dotenv load sets them). baseline.mjs keeps the same list. */
export const REPO_ENV_FILES = [".env", ".env.local", ".env.test", ".env.test.local", ".env.development", ".env.development.local"];

/**
 * Names the runtime, the shell or this harness owns. record.mjs buildEnv sets
 * NODE_ENV, DATABASE_URL, REDIS_ENABLED, REDIS_PASSWORD and BUILD_ID itself;
 * PORT and HOST are what a server binds, and a module that listens on import
 * must keep its own default.
 */
/**
 * FLAG-SHAPED NAMES are never stood in (verifier F3): a feature switch has no
 * value a module needs to load, and any non-empty stand-in reads as ON -
 * `if (process.env.DISABLE_X)` flipped the module's flag for every row and for
 * the repo's own baseline suite.
 */
export const FLAG_SHAPED = /^(?:ENABLE|DISABLE|USE|SKIP|IS)_|_(?:ENABLED|DISABLED|FLAG)$/i;

const RUNTIME_OWNED =
  /^(NODE_\w*|npm_\w*|TZ|PORT|HOST|HOSTNAME|PATH|HOME|PWD|OLDPWD|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TERM|TMPDIR|TEMP|TMP|CI|DEBUG|FORCE_COLOR|NO_COLOR|VITEST\w*|JEST_\w*|CHARPILOT_\w*|BUILD_ID|REDIS_ENABLED|REDIS_PASSWORD|LOG_LEVEL|UV_THREADPOOL_SIZE)$/;

export const STANDIN_TEXT = "charpilot-standin";
export const STANDIN_HOST = "standin.charpilot.invalid";

/** Names shaped like a duration: `CALLBACK_TIMEOUT_MS`, `CACHE_TTL`, `POLL_INTERVAL`, ... */
export const NUMERIC_TIME = /(?:^|_)(MS|MILLIS|MILLISECONDS|SEC|SECS|SECONDS|MINUTES|MINS|HOURS|DAYS|TIMEOUT|TTL|INTERVAL|DELAY|BACKOFF|EXPIRY|EXPIRES_IN|DURATION)$/i;
/** Names shaped like a count or bound: `CALLBACK_MAX_ATTEMPTS`, `BATCH_SIZE`, `MAX_RETRIES`, ... */
export const NUMERIC_COUNT = /(?:^|_)(ATTEMPTS|COUNT|MAX|MIN|LIMIT|SIZE|RETRIES|RETRY|CONCURRENCY|WORKERS|THRESHOLD|CAPACITY|DEPTH|NUM|NUMBER|LENGTH|LEN|PAGE_SIZE|BATCH)$|^(MAX|MIN|NUM)_/i;

/** Names that carry a host: `REDIS_HOSTNAME`, `KAFKA_BROKERS`, `SMTP_SERVER`, `MQ_ADDR`, `APP_DOMAIN`, `GCP_STORAGE_BUCKET_NAME`, ... */
export const ROUTES = /(?:^|_)(HOST|HOSTS|HOSTNAME|HOSTNAMES|DOMAIN|DOMAINS|BROKER|BROKERS|SERVER|SERVERS|ADDR|ADDRS|ADDRESS|ADDRESSES)(?:_|$)|BUCKET/i;
/** Names that carry a mail address: `SENDER_EMAIL`, `EMAIL_FROM`, `SUPPORT_EMAIL_ADDRESS`, ... */
export const EMAIL_SHAPED = /(?:^|_)E?MAIL(?:_|$)/i;
const HOST_TOKEN = /(?:^|_)(HOST|HOSTS|HOSTNAME|HOSTNAMES|DOMAIN|DOMAINS|BROKER|BROKERS|SERVER|SERVERS)(?:_|$)|BUCKET/i;

/**
 * The one value for `name`; `shape` is a baseline.json envDefaults shape, when
 * the schema declares one. `url` says the source parses the name as a URL
 * (envReadsIn `urlUses`): a value that is not an absolute URL becomes the
 * .invalid ORIGIN. An origin and not `https://<host>/<NAME>`: an Elasticsearch
 * client hands `node` to undici, whose parseOrigin refuses any path ("invalid
 * url", sourcing-ms, once ELASTIC_HOST_URL was stood in).
 */
export function standInValue(name, shape = null, { url = false } = {}) {
  const v = standInFor(String(name), shape);
  if (!url || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return `http://${STANDIN_HOST}`;
}

function standInFor(n, shape) {
  if (shape?.kind === "enum" && shape.member) return shape.member;
  if (shape?.kind === "number") return "1";
  if (shape?.kind === "boolean") return "false";
  // A URL RULE in the schema (baseline.mjs envKind; ats-sourcing-service run
  // 20260925T072715Z): `new URL(v).protocol === "https:"` refused the http
  // stand-in below at import. https satisfies every URL rule; the path names
  // the var, so a URL built from two stand-ins says which one it came from.
  if (shape?.kind === "url") return `https://${STANDIN_HOST}/${n}`;
  if (/PUBLIC_KEY$/i.test(n)) return placeholderPem("-----BEGIN PUBLIC KEY-----");
  if (/PRIVATE_KEY$/i.test(n)) return placeholderPem("-----BEGIN PRIVATE KEY-----");
  // A SEARCH CLUSTER'S NODE is a URL too (ats-sourcing-service, run
  // 20260925T072715Z): `new Client({ node: env.ES_NODE })` runs `new URL(node)`
  // at import, so the bare text threw "Invalid URL" in 63 rows once the schema
  // loaded - and "Missing node(s) option" in 5 more while it did not.
  if (/(_URL|_URI|_ENDPOINT|_WEBHOOK)$|^(?:ES|ELASTIC|ELASTICSEARCH|OPENSEARCH)_NODES?$/i.test(n)) return `http://${STANDIN_HOST}`;
  if (/_DSN$/i.test(n)) return `http://charpilot@${STANDIN_HOST}/1`;
  if (/_PORT$/i.test(n)) return "1";
  // NUMERIC-SHAPED (review B1): `Number(process.env.CALLBACK_TIMEOUT_MS)` of the
  // text stand-in is NaN, and NaN is a side of its own. A duration gets a
  // second's worth, a count a small number.
  if (NUMERIC_TIME.test(n)) return "1000";
  if (NUMERIC_COUNT.test(n)) return "3";
  if (/(_KEY|_SECRET)$/i.test(n)) return Buffer.from(`${STANDIN_TEXT}:${n}`).toString("base64");
  // A NAME THAT ROUTES (review S1): a host, a domain, a broker list, a server,
  // an address or a bucket is dialled, or built into a URL that is. The bare
  // text would route (`charpilot-standin.s3.amazonaws.com`, a redis client on
  // `charpilot-standin`), and their suite has no egress block - so it is the
  // .invalid host, bare: these names carry a host, never a URL.
  if (EMAIL_SHAPED.test(n) && !HOST_TOKEN.test(n)) return `${STANDIN_TEXT}@${STANDIN_HOST}`;
  if (ROUTES.test(n)) return STANDIN_HOST;
  return STANDIN_TEXT;
}

/** Names in the repo's example env files, each with the file that named it. */
export function exampleEnvNames(repoRoot) {
  const out = new Map();
  for (const f of EXAMPLE_ENV_FILES) {
    let text;
    try { text = readFileSync(join(repoRoot, f), "utf8"); } catch { continue; }
    // Names only. The parser holds the value for the length of this loop and
    // it goes nowhere.
    for (const n of envNames(text)) if (!out.has(n)) out.set(n, f);
  }
  return out;
}

/** Names the repo's own env files set - they are supplied, not needed. */
export function repoEnvNames(repoRoot) {
  const out = new Set();
  for (const f of REPO_ENV_FILES) {
    try { for (const n of envNames(readFileSync(join(repoRoot, f), "utf8"))) out.add(n); } catch { /* absent */ }
  }
  return out;
}

// Build output, coverage reports and tool state are not the service's source:
// with SRC_DIR="." a Next.js bundle under .next/ read
// `process.env.__NEXT_DEV_INDICATOR_POSITION` (interview-flow-ui, qodeitl;
// review N2). Any other dot-directory is tool state too.
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".next", ".nuxt", ".output", ".turbo", ".vercel", ".cache", ".svelte-kit", "dist", "build", "out", "coverage", "coverage-charpilot", "test", "tests", "__tests__", "__mocks__", "characterization"]);
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith(".") || /^coverage[-_]/.test(name);
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec|e2e-spec|char\.test|char)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * The TypeScript compiler, from ts-morph (the scan's own dependency; install.sh
 * guarantees it), loaded on first use so a caller that never reads source pays
 * nothing for it.
 */
let tsLib = null;
function typescript() {
  if (!tsLib) tsLib = createRequire(import.meta.url)("ts-morph").ts;
  return tsLib;
}

function scriptKindFor(ts, file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * EVERY READ OF `process.env` IN ONE FILE'S TEXT, and whether that read brings
 * its own default (review B1). Returns name -> { bare, defaulted, refused }:
 * counts of the reads that bring no default and of those that do, and - a
 * subset of `bare` - the reads that decide a LOAD REFUSAL.
 *
 * THE FILE IS PARSED (round 4, B1). The regex classifier saw a guard only when
 * `throw` was the consequent's first statement, so `{ console.error(..);
 * throw .. }`, an `else { throw }` and `process.exit(1)` all read as
 * "defaulted", got no stand-in, and killed every row in arrangement.
 *
 * A read DEFAULTS when the code already says what happens without the var:
 *   process.env.X ?? d     process.env.X || d     process.env.X ??= d
 *   Number(process.env.X ?? 5)   (process.env.X as string) || d
 *   process.env.X?.trim()        - an optional chain handles undefined itself
 *   const { X = d } = process.env
 *   parseInt(process.env.X, 10) || d   - a parse whose RESULT is defaulted
 *   a TEST (verifier F3): process.env.X ? a : b, if (process.env.X),
 *     process.env.X && f(), !process.env.X - the code branches on "unset"
 *     itself, so a stand-in would switch the other side on in every row
 *   a read GUARDED by such a test of the same name: the `a` of
 *   `process.env.X ? Number(process.env.X) : 10`, the `b` of
 *   `!process.env.X ? 10 : b`, the right operand of `process.env.X && ...`,
 *   the body of `if (process.env.X) { ... }`, the `else` of `if (!process.env.X)`
 * Everything else is BARE: `process.env.X`, `process.env.X!`, a comparison,
 * and a test that GUARDS A LOAD REFUSAL. That is an `if` whose branch taken
 * when the var is unset - the consequent of a negated test, the `else` of a
 * positive one - holds a `throw` or a `process.exit(..)` among its top-level
 * statements: `if (!process.env.X) { log(..); throw .. }`, `if (process.env.X)
 * {..} else { process.exit(1) }`. A module that refuses to load without the
 * var is exactly what a stand-in is for, and an `||` inside such a test
 * (`if (!process.env.A || !process.env.B) throw`) is part of the test, not a
 * default. A name is stood in only when at least one read is bare - see
 * planStandIns; a refusal read also beats the flag rule there.
 *
 * Forms read: `process.env.X`, `process.env?.X`, `process.env["X"]` (any
 * quote), `process.env?.["X"]`, `(process.env as any).X`, and a destructuring
 * `const { ... } = process.env` (a default in the pattern defaults the name).
 * `file` picks the parser's dialect (.tsx/.jsx/.js); it defaults to TypeScript.
 */
export function processEnvReadsIn(text, file = "source.ts") {
  return envReadsIn(text, file).reads;
}

/**
 * processEnvReadsIn, and - when `envSchema` is given - the LOAD REFUSALS read
 * through the repo's PARSED env object: name -> count (qode-ptp-ms, run
 * 20260925T072635Z). `envSchema` is { names, isSchemaImport(specifier) }: the
 * names the schema declares, and whether an import specifier is the schema
 * module. A member read `env.X` of a binding imported from it, X declared, is
 * classified like a `process.env.X` read, and only its REFUSALS are kept:
 *
 *   import { env } from '@/env';                     // SOURCING_MS_HOST: z.string().default('')
 *   constructor() { if (env.SOURCING_MS_HOST) {..} else { throw new Error('SOURCING_MS_HOST is not set') } }
 *   export const sourcingMsServiceInstance = SourcingMsService.getInstance();
 *
 * A bare `env.X` is not a need: the schema already answered it (its default,
 * or a ZodError planStandIns covers through `requiredNoDefault`). A refusal
 * is, when that answer is falsy. A read copied into a local first counts too
 * (`const url = env.EMAIL_SERVICE_URL; if (!url) throw ..`, the same run, 4
 * rows): one step of data flow, the `const` and a guard of it in the same block.
 *
 * A READ HANDED TO A URL PARSER is a refusal too, and its name is in `urlUses`
 * (sourcing-ms, the September 25 mocked run, 62 sides): `ELASTIC_HOST_URL:
 * z.string().default('')` fed `new Client({ node: env.ELASTIC_HOST_URL })` at
 * module scope, the client ran `new URL("")`, and every row importing it died
 * "Invalid URL" in arrangement. The empty default was the schema's answer, so
 * no rule stood the name in. `new URL(<read>)`, `new URL(path, <read>)`, a
 * template that starts with the read, and a `node`/`nodes` option of a
 * constructor or call (a search cluster's client) throw on "" exactly as
 * `if (!X) throw` does - see urlConsumed.
 */
export function envReadsIn(text, file = "source.ts", envSchema = null) {
  const out = new Map();
  const schemaRefusals = new Map();
  const urlUses = new Set();
  const t = String(text ?? "");
  const importsSchema = !!envSchema && [...t.matchAll(/\bfrom\s*["'`]([^"'`]+)["'`]/g)].some((m) => envSchema.isSchemaImport(m[1]));
  if (!t.includes("process") && !importsSchema) return { reads: out, schemaRefusals, urlUses };
  const ts = typescript();
  const sf = ts.createSourceFile(file, t, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const add = (name, defaulted, refused = false) => {
    const r = out.get(name) ?? { bare: 0, defaulted: 0, refused: 0 };
    r[defaulted ? "defaulted" : "bare"] += 1;
    if (refused) r.refused += 1;
    out.set(name, r);
  };
  const reads = [];
  const destructured = [];
  // The bindings this file imports from the env schema module.
  const envBindings = new Set();
  if (importsSchema) {
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause || st.importClause.isTypeOnly) continue;
      if (!envSchema.isSchemaImport(st.moduleSpecifier.text)) continue;
      const c = st.importClause;
      if (c.name) envBindings.add(c.name.text);
      if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const el of c.namedBindings.elements) if (!el.isTypeOnly) envBindings.add(el.name.text);
    }
  }
  const schemaReads = [];
  const visit = (n) => {
    if (envBindings.size && ts.isPropertyAccessExpression(n) && ts.isIdentifier(unwrap(ts, n.expression)) && envBindings.has(unwrap(ts, n.expression).text) && envSchema.names.has(n.name.text)) schemaReads.push({ name: n.name.text, node: n });
    if (ts.isPropertyAccessExpression(n) && isProcessEnv(ts, n.expression) && ENV_NAME.test(n.name.text)) reads.push({ name: n.name.text, node: n });
    else if (ts.isElementAccessExpression(n) && isProcessEnv(ts, n.expression)) {
      const a = n.argumentExpression;
      if ((ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && ENV_NAME.test(a.text)) reads.push({ name: a.text, node: n });
    } else if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name) && isProcessEnv(ts, n.initializer)) {
      for (const el of n.name.elements) {
        if (el.dotDotDotToken) continue;
        const key = el.propertyName ?? el.name;
        const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
        if (name && ENV_NAME.test(name)) destructured.push({ name, defaulted: !!el.initializer });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Each member read with its role; then a bare read inside a span a test of
  // the same name guards is counted as defaulted.
  const guards = [];
  for (const r of reads) {
    Object.assign(r, classifyRead(ts, r.node));
    if (!r.refused && copyRefuses(ts, r.node)) Object.assign(r, { defaulted: false, refused: true, span: null });
    if (r.span) guards.push({ name: r.name, start: r.span.getStart(sf), end: r.span.getEnd() });
    if (urlConsumed(ts, r.node)) urlUses.add(r.name);
  }
  for (const r of schemaReads) {
    const url = urlConsumed(ts, r.node);
    if (url) urlUses.add(r.name);
    if (url || classifyRead(ts, r.node).refused || copyRefuses(ts, r.node)) schemaRefusals.set(r.name, (schemaRefusals.get(r.name) ?? 0) + 1);
  }
  for (const r of reads) {
    if (!r.defaulted && !r.refused) {
      const at = r.node.getStart(sf);
      if (guards.some((g) => g.name === r.name && at >= g.start && r.node.getEnd() <= g.end)) r.defaulted = true;
    }
    add(r.name, r.defaulted, r.refused);
  }
  for (const d of destructured) add(d.name, d.defaulted);
  return { reads: out, schemaRefusals, urlUses };
}

/** Option names a client parses as a URL when it is constructed: `new Client({ node })` (Elasticsearch, OpenSearch). */
const URL_OPTIONS = new Set(["node", "nodes"]);

/**
 * Is the read `node` handed, as it is, to something that parses it as a URL
 * and throws on "": `new URL(<read>)` or `new URL(path, <read>)`, a template
 * starting with the read (`new URL(`${env.X}/api`)` is `new URL("/api")`
 * unset), or the `node`/`nodes` option - alone or in an array - of an object
 * passed to a constructor or a call.
 */
function urlConsumed(ts, node) {
  let arg = outer(ts, node);
  // `${<read>}/path`: the read heads the template, so "" leaves a relative URL.
  const span = arg.parent;
  if (span && ts.isTemplateSpan(span) && span.expression === arg) {
    const tpl = span.parent;
    if (!tpl || tpl.head.text !== "" || tpl.templateSpans[0] !== span) return false;
    arg = outer(ts, tpl);
  }
  const p = arg.parent;
  if (!p) return false;
  if (ts.isNewExpression(p) && p.arguments?.includes(arg)) {
    const c = unwrap(ts, p.expression);
    return (ts.isIdentifier(c) && c.text === "URL") || (ts.isPropertyAccessExpression(c) && c.name.text === "URL");
  }
  const prop = ts.isArrayLiteralExpression(p) ? p.parent : p;
  const value = ts.isArrayLiteralExpression(p) ? p : arg;
  if (!prop || !ts.isPropertyAssignment(prop) || prop.initializer !== value) return false;
  const key = prop.name;
  if (!(ts.isIdentifier(key) || ts.isStringLiteral(key)) || !URL_OPTIONS.has(key.text)) return false;
  const obj = prop.parent;
  const call = obj?.parent;
  return !!call && (ts.isNewExpression(call) || ts.isCallExpression(call)) && !!call.arguments?.includes(obj);
}

/** The calls that take a key, and the kind of key each one takes. */
const KEY_CALLS = new Map([
  ["publicDecrypt", "public"], ["publicEncrypt", "public"], ["createPublicKey", "public"],
  ["privateDecrypt", "private"], ["privateEncrypt", "private"], ["createPrivateKey", "private"],
]);

/**
 * WHAT ONE FILE HANDS TO node:crypto AS A KEY OR AS CIPHERTEXT (pricing-ms,
 * the mocked run of September 26). Returns:
 *
 *   keys        name -> "public" | "private": `process.env.K` is the key of a
 *               KEY_CALLS call - its first argument, or that argument's `key`
 *               - read directly or through a `const` of it in the file.
 *   ciphertext  name -> { keyName, encoding }: `process.env.N` is the data of
 *               a `publicDecrypt` under a key read from `process.env`, as
 *               `Buffer.from(process.env.N, "base64" | "hex")`.
 *   decryptors  [{ name, keyName, encoding }]: a function (declaration, or a
 *               `const` arrow or function expression) whose PARAMETER is that
 *               data - `decrypt = (data) => publicDecrypt({ key:
 *               process.env.PUBLIC_KEY, .. }, Buffer.from(data, "base64"))`.
 *   uses        [{ fn, spec, name }]: `fn(process.env.N)`, or `N:
 *               <schema>.transform(fn)` in an object literal; `spec` is where
 *               the file imports `fn` from (its imported name in `fn`), or
 *               null when the file declares it.
 *
 * Only PKCS#1 v1.5 padding (publicDecrypt's default) - the one a stand-in
 * ciphertext can be made deterministic in - and only base64 or hex data.
 */
export function cryptoUsesIn(text, file = "source.ts") {
  const out = { keys: new Map(), ciphertext: new Map(), decryptors: [], uses: [] };
  const t = String(text ?? "");
  if (!/Decrypt|Encrypt|create(?:Public|Private)Key|\.transform\s*\(/.test(t)) return out;
  const ts = typescript();
  const sf = ts.createSourceFile(file, t, ts.ScriptTarget.Latest, true, scriptKindFor(ts, file));
  const consts = new Map();
  const imports = new Map();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) imports.set(el.name.text, { spec: st.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text });
    }
  }
  const envName = (n) => {
    const e = unwrap(ts, n);
    if (!e) return null;
    if (ts.isPropertyAccessExpression(e) && isProcessEnv(ts, e.expression) && ENV_NAME.test(e.name.text)) return e.name.text;
    if (ts.isElementAccessExpression(e) && isProcessEnv(ts, e.expression) && (ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression))) return e.argumentExpression.text;
    return null;
  };
  // One step through a `const` in scope: `const KEY = process.env.K`, the
  // innermost declaration of that name whose function holds the use.
  const scopeOf = (n) => {
    let s = n.parent;
    while (s && !ts.isFunctionLike(s) && !ts.isSourceFile(s)) s = s.parent;
    return s ?? sf;
  };
  const holds = (outerNode, n) => n.getStart(sf) >= outerNode.getStart(sf) && n.getEnd() <= outerNode.getEnd();
  const through = (n) => {
    const e = unwrap(ts, n);
    if (!e || !ts.isIdentifier(e)) return e;
    const d = (consts.get(e.text) ?? []).filter((c) => holds(c.scope, e)).sort((a, b) => b.scope.getStart(sf) - a.scope.getStart(sf))[0];
    return d ? unwrap(ts, d.init) : e;
  };
  const calleeName = (c) => {
    const f = unwrap(ts, c.expression);
    return ts.isIdentifier(f) ? f.text : ts.isPropertyAccessExpression(f) ? f.name.text : null;
  };
  const prop = (obj, key) => obj.properties.find((p) => ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key)?.initializer;
  const calls = [];
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const)) consts.set(n.name.text, [...(consts.get(n.name.text) ?? []), { init: n.initializer, scope: scopeOf(n) }]);
    if (ts.isCallExpression(n)) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const c of calls) {
    const callee = calleeName(c);
    if (KEY_CALLS.has(callee) && c.arguments.length) {
      const first = through(c.arguments[0]);
      const keyExpr = first && ts.isObjectLiteralExpression(first) ? prop(first, "key") : first;
      const keyName = keyExpr ? envName(through(keyExpr)) : null;
      if (keyName) out.keys.set(keyName, KEY_CALLS.get(callee));
      if (callee !== "publicDecrypt" || !keyName || c.arguments.length < 2) continue;
      const padding = first && ts.isObjectLiteralExpression(first) ? prop(first, "padding") : null;
      if (padding && !/RSA_PKCS1_PADDING$/.test(padding.getText(sf))) continue;
      // The data: `Buffer.from(<x>, "base64" | "hex")`, directly or as a const.
      const data = through(c.arguments[1]);
      if (!data || !ts.isCallExpression(data) || calleeName(data) !== "from" || data.arguments.length < 2) continue;
      const enc = unwrap(ts, data.arguments[1]);
      const encoding = enc && ts.isStringLiteral(enc) && /^(?:base64|hex)$/.test(enc.text) ? enc.text : null;
      if (!encoding) continue;
      const x = unwrap(ts, data.arguments[0]);
      const direct = envName(through(x));
      if (direct) { out.ciphertext.set(direct, { keyName, encoding }); continue; }
      if (!x || !ts.isIdentifier(x)) continue;
      let fn = c.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      if (!fn || !fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === x.text)) continue;
      const name = fn.name && ts.isIdentifier(fn.name) ? fn.name.text
        : ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : null;
      if (name) out.decryptors.push({ name, keyName, encoding });
      continue;
    }
    // A use: `fn(process.env.N)`, or `.transform(fn)` as the value of `N:`.
    const f = unwrap(ts, c.expression);
    const refOf = (id) => (imports.has(id) ? { fn: imports.get(id).imported, spec: imports.get(id).spec } : { fn: id, spec: null });
    if (ts.isIdentifier(f) && c.arguments.length) {
      const name = envName(c.arguments[0]);
      if (name) out.uses.push({ ...refOf(f.text), name });
    } else if (callee === "transform" && c.arguments.length === 1 && ts.isIdentifier(unwrap(ts, c.arguments[0]))) {
      let at = c;
      while (at.parent && (ts.isPropertyAccessExpression(at.parent) || (ts.isCallExpression(at.parent) && at.parent.expression === at))) at = at.parent;
      const pa = at.parent;
      if (pa && ts.isPropertyAssignment(pa) && pa.initializer === at && (ts.isIdentifier(pa.name) || ts.isStringLiteral(pa.name)) && ENV_NAME.test(pa.name.text)) {
        out.uses.push({ ...refOf(unwrap(ts, c.arguments[0]).text), name: pa.name.text });
      }
    }
  }
  return out;
}

/**
 * The names the service uses as keys and as ciphertext, across every file
 * cryptoUsesIn read: { keys: name -> kind, ciphertext: name -> { keyName,
 * encoding } }. A use joins a decryptor when it calls it by the name it is
 * declared under, and imports it from the decryptor's file (or is that file).
 */
export function cryptoNeeds(perFile, repoRoot) {
  const keys = new Map();
  const ciphertext = new Map();
  const decryptors = [];
  for (const { abs, uses } of perFile) {
    for (const [n, k] of uses.keys) if (!keys.has(n)) keys.set(n, k);
    for (const [n, c] of uses.ciphertext) if (!ciphertext.has(n)) ciphertext.set(n, c);
    for (const d of uses.decryptors) decryptors.push({ ...d, abs, matches: schemaImportMatcher(relative(repoRoot, abs), repoRoot) });
  }
  for (const { abs, uses } of perFile) {
    for (const u of uses.uses) {
      const d = decryptors.find((d) => d.name === u.fn && (u.spec === null ? d.abs === abs : d.matches(u.spec, abs)));
      if (d && !ciphertext.has(u.name)) ciphertext.set(u.name, { keyName: d.keyName, encoding: d.encoding });
    }
  }
  return { keys, ciphertext };
}

/**
 * `const v = <read>;` followed, in the same block, by a guard of `v` that
 * refuses to load (classifyRead on the local): the read decides the refusal.
 */
function copyRefuses(ts, node) {
  const o = outer(ts, node);
  const decl = o.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || decl.initializer !== o || !ts.isIdentifier(decl.name)) return false;
  let scope = decl.parent;
  while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope) && !ts.isCaseClause(scope) && !ts.isDefaultClause(scope)) scope = scope.parent;
  if (!scope) return false;
  const local = decl.name.text;
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (n !== decl.name && ts.isIdentifier(n) && n.text === local && classifyRead(ts, n).refused) { found = true; return; }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(scope, walk);
  return found;
}

/** Names read from `process.env` in one file's text. */
export function processEnvNamesIn(text, file) {
  return new Set(processEnvReadsIn(text, file).keys());
}

/** Strip what cannot change a value: parens, `!`, `as T`, `<T>x`, `satisfies T`. */
function unwrap(ts, n) {
  while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))) n = n.expression;
  return n;
}

/** The outermost of those wrappers around `n`. */
function outer(ts, n) {
  let cur = n;
  for (;;) {
    const p = cur.parent;
    if (p && p.expression === cur && (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(p)))) cur = p;
    else return cur;
  }
}

function isProcessEnv(ts, n) {
  const e = unwrap(ts, n);
  return !!e && ts.isPropertyAccessExpression(e) && e.name.text === "env" && ts.isIdentifier(e.expression) && e.expression.text === "process";
}

const DEFAULT_OPS = (ts) => new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken]);

/** Is the value `cur` defaulted by what it sits in: the left of `??`/`||`/`??=`/`||=`, or an optional chain's base? */
function defaultedBy(ts, cur) {
  const p = cur.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === cur && DEFAULT_OPS(ts).has(p.operatorToken.kind)) return true;
  if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === cur && p.questionDotToken) return true;
  return false;
}

/** `parseInt(<cur>, 10) || d`, `Number.parseFloat(<cur>) ?? d`: the first argument of a numeric parse whose result is defaulted. */
function parsedThenDefaulted(ts, cur) {
  const call = cur.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== cur) return false;
  const callee = unwrap(ts, call.expression);
  const fn = ts.isIdentifier(callee) ? callee.text
    : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Number" ? callee.name.text : null;
  if (!/^(?:parseInt|parseFloat|Number)$/.test(fn ?? "")) return false;
  return defaultedBy(ts, outer(ts, call));
}

/** Does this branch refuse to go on: a top-level `throw` or `process.exit(..)` among its statements? */
function refusesLoad(ts, stmt) {
  if (!stmt) return false;
  const list = ts.isBlock(stmt) ? stmt.statements : [stmt];
  return list.some((s) => {
    if (ts.isThrowStatement(s)) return true;
    if (!ts.isExpressionStatement(s)) return false;
    const c = unwrap(ts, s.expression);
    if (!ts.isCallExpression(c)) return false;
    const f = unwrap(ts, c.expression);
    return ts.isPropertyAccessExpression(f) && f.name.text === "exit" && ts.isIdentifier(f.expression) && f.expression.text === "process";
  });
}

/**
 * One member read's role: { defaulted, refused, span }. The read is climbed
 * through `!` and `&&`/`||`/`??` to the position its truth is used in - an
 * `if`, a ternary's condition, a loop's condition, or none. `span` is the node
 * its truth guards, when one does.
 */
function classifyRead(ts, node) {
  const AND = ts.SyntaxKind.AmpersandAmpersandToken;
  const OR = ts.SyntaxKind.BarBarToken;
  const NULLISH = ts.SyntaxKind.QuestionQuestionToken;
  const read = outer(ts, node);
  const path = [];
  let cur = read;
  for (;;) {
    const p = cur.parent;
    if (p && ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) { path.push({ not: true }); cur = outer(ts, p); continue; }
    if (p && ts.isBinaryExpression(p) && [AND, OR, NULLISH].includes(p.operatorToken.kind)) { path.push({ op: p.operatorToken.kind, left: p.left === cur, bin: p }); cur = outer(ts, p); continue; }
    break;
  }
  const at = cur.parent;
  let kind = null;
  if (at && ts.isIfStatement(at) && at.expression === cur) kind = "if";
  else if (at && ts.isConditionalExpression(at) && at.condition === cur) kind = "ternary";
  else if (at && (ts.isWhileStatement(at) || ts.isDoStatement(at)) && at.expression === cur) kind = "loop";
  else if (at && ts.isForStatement(at) && at.condition === cur) kind = "loop";
  const nots = path.filter((s) => s.not).length;
  const negated = nots % 2 === 1;
  const ops = path.filter((s) => !s.not).map((s) => s.op);

  // A LOAD REFUSAL: the branch taken when the var is unset throws or exits.
  if (kind === "if" && refusesLoad(ts, negated ? at.thenStatement : at.elseStatement)) return { defaulted: false, refused: true, span: null };

  if (defaultedBy(ts, read) || parsedThenDefaulted(ts, read)) return { defaulted: true, refused: false, span: null };

  const firstAndLeft = path[0] && !path[0].not && path[0].op === AND && path[0].left;
  const isTest = kind !== null || nots > 0 || firstAndLeft;
  if (!isTest) return { defaulted: false, refused: false, span: null };

  // Which node the var being SET guards: a positive test joined only by `&&`
  // is true only when the var is set; `!X` joined only by `||` is false only
  // when it is set.
  const setWhenTrue = nots === 0 && ops.every((o) => o === AND);
  const setWhenFalse = nots === 1 && path[0]?.not && ops.every((o) => o === OR);
  let span = null;
  if (kind === "if") span = setWhenTrue ? at.thenStatement : setWhenFalse ? at.elseStatement ?? null : null;
  else if (kind === "ternary") span = setWhenTrue ? at.whenTrue : setWhenFalse ? at.whenFalse : null;
  else if (kind === "loop") span = setWhenTrue ? at.statement : null;
  else if (firstAndLeft) span = path[0].bin.right;
  return { defaulted: true, refused: false, span };
}

/**
 * Names read from `process.env` under `srcRoot`: name -> { file, bare,
 * defaulted, refused, bareIn } - the first file that reads it, how many reads
 * carry no default, how many do, how many decide a load refusal, and the first
 * file with a bare read.
 */
/**
 * One file's reads, and never a thrown stage. The AST walk recurses, so a file
 * nested deep enough (a minified bundle under src/, a few thousand chained
 * terms) overflows the stack. One such file must not abort stage 1, baseline
 * and the recorder, which all plan through here. It falls back to the names
 * the file reads, every read counted bare: the pre-AST behaviour, which can
 * stand in for a name the file defaults but never leaves a load refusal
 * without its value. The fallback is said on stderr, by file.
 */
const ENV_READ = /process\.env(?:\?\.)?(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([A-Za-z_$][\w$]*)["'`]\s*\])/g;
export function readsOrFallback(text, name, file, envSchema = null, schemaRefusals = null, urlUses = null) {
  try {
    const got = envReadsIn(text, name, envSchema);
    for (const [n, c] of schemaRefusals ? got.schemaRefusals : []) {
      const seen = schemaRefusals.get(n);
      if (seen) seen.count += c;
      else schemaRefusals.set(n, { count: c, file });
    }
    for (const n of urlUses ? got.urlUses : []) urlUses.add(n);
    return got.reads;
  } catch (err) {
    const reads = new Map();
    for (const m of text.matchAll(ENV_READ)) {
      const n = m[1] ?? m[2];
      const r = reads.get(n) ?? { bare: 0, defaulted: 0, refused: 0 };
      r.bare += 1;
      reads.set(n, r);
    }
    process.stderr.write(`stand-ins: ${file} could not be parsed (${err?.name ?? "Error"}: ${err?.message ?? err}); its ${reads.size} env name(s) are counted as read with no default\n`);
    return reads;
  }
}

export function sourceEnvNames(srcRoot, { repoRoot = srcRoot, isExcluded = () => false, envSchema = null, schemaRefusals = null, urlUses = null, crypto = null } = {}) {
  const out = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 16 && !skipDir(e.name)) walk(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !SOURCE.test(e.name) || NOT_SOURCE.test(e.name)) continue;
      if (isExcluded(relative(srcRoot, abs))) continue;
      let text = "";
      try { text = readFileSync(abs, "utf8"); } catch { continue; }
      const file = relative(repoRoot, abs);
      const schema = envSchema ? { names: envSchema.names, isSchemaImport: (spec) => envSchema.isSchemaImport(spec, abs) } : null;
      // Keys and ciphertext (cryptoUsesIn). A file it cannot parse holds none.
      if (crypto) try { crypto.push({ abs, uses: cryptoUsesIn(text, e.name) }); } catch { /* readsOrFallback says so */ }
      for (const [n, r] of readsOrFallback(text, e.name, file, schema, schemaRefusals, urlUses)) {
        const seen = out.get(n);
        if (!seen) out.set(n, { file, bare: r.bare, defaulted: r.defaulted, refused: r.refused, bareIn: r.bare ? file : null });
        else {
          seen.bare += r.bare;
          seen.defaulted += r.defaulted;
          seen.refused += r.refused;
          if (r.bare && !seen.bareIn) seen.bareIn = file;
        }
      }
    }
  };
  walk(srcRoot, 0);
  return out;
}

/**
 * Does an import specifier, written in the file at `fromAbs`, name the env
 * schema module `schemaFile` (repo-relative, baseline.json envDefaults.file)?
 * A relative specifier is resolved; any other is read as an alias rooted at the
 * source directory - `@/env`, `~/env`, `#/env`, `src/env`, `@/config/env` - the
 * forms the fleet uses. The extension and a trailing `/index` never matter.
 */
export function schemaImportMatcher(schemaFile, repoRoot) {
  const bare = (p) => p.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
  const target = bare(resolve(repoRoot, schemaFile));
  const underSrc = bare(schemaFile.replace(/\\/g, "/")).replace(/^src\//, "");
  return (spec, fromAbs) => {
    if (spec.startsWith(".")) return !!fromAbs && bare(resolve(dirname(fromAbs), spec)) === target;
    return bare(spec).replace(/^(?:@|~|#)\//, "").replace(/^@?src\//, "") === underSrc;
  };
}

/**
 * THE ENV AN SDK READS OR REQUIRES THAT THE SERVICE'S OWN CODE NEVER CHECKS.
 * One entry per SDK: the dependency that brings it (package.json, any
 * dependency field) and the names it cannot do without.
 *
 * @aws-sdk/* (v3). Every client's constructor runs `resolveRegionConfig`,
 * which throws "Region is missing" when `region` is falsy - an explicit `""`
 * included, and `config.region ?? <env>` never falls back on `""`, so the
 * value has to reach the code's own env (qode-ptp-ms: `region:
 * env.AWS_REGION`, schema default `''`). The SDK reads AWS_REGION from the
 * process env itself when the code passes none. The two credential names are
 * not needed to construct, but without them the SDK's default provider chain
 * goes looking for credentials on the instance metadata endpoint at the first
 * call; with a fake pair it signs a request instead, addressed to the
 * stand-in region. That region is the plain stand-in text: a valid region
 * label, and `s3.charpilot-standin.amazonaws.com` resolves nowhere.
 */
export const SDK_ENV = [
  { dep: /^@aws-sdk\//, names: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
];

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/** name -> the dependency that needs it, for every SDK_ENV entry the repo's package.json depends on. */
export function sdkEnvNeeds(repoRoot) {
  const out = new Map();
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")); } catch { return out; }
  const deps = DEP_FIELDS.flatMap((f) => (pkg?.[f] && typeof pkg[f] === "object" ? Object.keys(pkg[f]) : [])).sort();
  for (const { dep, names } of SDK_ENV) {
    const by = deps.find((d) => dep.test(d));
    if (by) for (const n of names) if (!out.has(n)) out.set(n, by);
  }
  return out;
}

/**
 * The stand-ins a mocked run applies, and why each name was or was not one.
 *
 *   supplied     every name something already sets (staging.env, the process
 *                env, the recorder's own defaults). The repo's own .env files
 *                are added here.
 *   envDefaults  baseline.json `envDefaults`, or null: its `withDefaultNames`
 *                are skipped and its `shapes` choose the value.
 *   isDatabaseVar  config.mjs's, passed in so this module imports no config.
 *
 * Returns `values` (name -> stand-in, in name order) and `standIns` (the
 * names, which is all any artifact records).
 */
export function planStandIns({ repoRoot, srcRoot, isExcluded, supplied = [], envDefaults = null, isDatabaseVar = () => false } = {}) {
  const have = new Set(supplied instanceof Map ? supplied.keys() : supplied);
  for (const n of repoEnvNames(repoRoot)) have.add(n);
  const needed = new Map();
  for (const [n, f] of exampleEnvNames(repoRoot)) needed.set(n, [f]);
  // Reads through the repo's PARSED env object, for their load refusals only
  // (envReadsIn). Needs the schema's file and names, so not before baseline
  // has scanned it; refreshStandIns re-plans once it has.
  const declared = new Set((envDefaults?.shapes ?? []).map((v) => v.name));
  const envSchema = envDefaults?.file && declared.size ? { names: declared, isSchemaImport: schemaImportMatcher(envDefaults.file, repoRoot) } : null;
  const schemaRefusals = new Map();
  const urlUses = new Set();
  const cryptoFiles = [];
  const reads = srcRoot ? sourceEnvNames(srcRoot, { repoRoot, isExcluded, envSchema, schemaRefusals, urlUses, crypto: cryptoFiles }) : new Map();
  for (const [n, r] of reads) needed.set(n, [...(needed.get(n) ?? []), r.bareIn ?? r.file]);
  for (const [n, r] of schemaRefusals) if (!needed.get(n)?.includes(r.file)) needed.set(n, [...(needed.get(n) ?? []), r.file]);
  // THE SCHEMA'S REQUIRED NAMES ARE NEEDED, whether or not a read names them.
  // pricing-service reads its env only as `z.object({...}).parse(process.env)`
  // (run 20260924T070812Z): STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are
  // `z.string()` with no default and no source line reads them, so they landed
  // in `notReadInSource`, the import threw a ZodError, the `@/env` fallback
  // handed `new Stripe` undefined, and 114 sides died in arrangement. A schema
  // that parses at import refuses to load without them - a load refusal, like a
  // bare read that guards a throw - so they beat the flag, default and
  // not-read rules below. Supplied, database and runtime-owned names still win.
  const schemaRequired = new Set(envDefaults?.requiredNoDefault ?? []);
  for (const n of schemaRequired) needed.set(n, [...(needed.get(n) ?? []), envDefaults?.file ?? "env schema"]);
  // AN SDK THE REPO DEPENDS ON NEEDS THEM (SDK_ENV), whether or not a read
  // names them: the refusal is in node_modules, where no read rule looks.
  const sdkNeeds = sdkEnvNeeds(repoRoot);
  for (const [n, dep] of sdkNeeds) needed.set(n, [...(needed.get(n) ?? []), `package.json (${dep})`]);
  const defaulted = new Set(envDefaults?.withDefaultNames ?? []);
  const emptyDefault = new Set(envDefaults?.withEmptyDefaultNames ?? []);
  const shapes = new Map((envDefaults?.shapes ?? []).map((s) => [s.name, s]));
  const valueOf = (n) => standInValue(n, shapes.get(n) ?? null, { url: urlUses.has(n) });
  const values = new Map();
  const skipped = { supplied: [], defaulted: [], database: [], runtime: [], flag: [], everyReadDefaults: [], notReadInSource: [] };
  for (const n of [...needed.keys()].sort()) {
    const r = reads.get(n);
    // THE CODE REFUSES TO LOAD WITHOUT IT, and nothing it reads fills it
    // (qode-ptp-ms, run 20260925T072635Z, 212 sides): a refusal read through
    // the parsed env whose schema default is "" - or none, as `.optional()` -
    // or a `process.env.X` refusal, which no schema default ever reaches. A
    // non-empty default passes a truthiness guard, so that name stays the
    // schema's.
    const refusedWithout = (schemaRefusals.has(n) && (!defaulted.has(n) || emptyDefault.has(n))) || r?.refused > 0
      // An SDK name counts as a refusal the same way: the SDK tests it for
      // truth, so a "" schema default fails and a non-empty one passes. A
      // name whose every source read brings its own default keeps that
      // default, because the code passes the SDK something non-empty.
      || (sdkNeeds.has(n) && (!defaulted.has(n) || emptyDefault.has(n)) && !(r && !r.bare));
    if (have.has(n)) skipped.supplied.push(n);
    else if (defaulted.has(n) && !refusedWithout) skipped.defaulted.push(n);
    else if (isDatabaseVar(n)) skipped.database.push(n);
    else if (RUNTIME_OWNED.test(n)) skipped.runtime.push(n);
    else if (schemaRequired.has(n) || refusedWithout) values.set(n, valueOf(n));
    // A FLAG-SHAPED name is left unset - unless a read of it decides a load
    // refusal (`if (!process.env.USE_REGION) throw ..`, round 4): then the
    // module cannot load without it, and the refusal wins over the flag rule.
    else if (FLAG_SHAPED.test(n) && !(r?.refused > 0)) skipped.flag.push(n);
    // THE CODE'S OWN ANSWER FOR "UNSET" (review B1). A name every read of which
    // brings a default - `process.env.CACHE_TTL ?? "default-60"`, `{ X = d } =
    // process.env` - does not need a value to load, and a stand-in would make
    // its default side unreachable. Left unset.
    else if (r && !r.bare) skipped.everyReadDefaults.push(n);
    // Named only in an example file: no read we can see, so nothing says the
    // code lacks a default for it. Not stood in.
    else if (!r) skipped.notReadInSource.push(n);
    else values.set(n, valueOf(n));
  }
  // KEYS AND CIPHERTEXT (cryptoUsesIn), over the names already stood in and
  // nothing else: a name used as a key gets the stand-in PEM of its kind, and
  // one the source decrypts under a stood-in public key gets ciphertext that
  // key decrypts. Under a key something else supplies, no stand-in can be
  // ciphertext, so the name keeps the value above.
  const crypto = cryptoNeeds(cryptoFiles, repoRoot);
  for (const [n, kind] of crypto.keys) if (values.has(n)) values.set(n, placeholderPem(kind === "public" ? "-----BEGIN PUBLIC KEY-----" : "-----BEGIN PRIVATE KEY-----"));
  for (const [n, { keyName, encoding }] of crypto.ciphertext) {
    if (values.has(n) && values.get(keyName) === placeholderPem("-----BEGIN PUBLIC KEY-----")) values.set(n, standInCiphertext(encoding));
  }
  return {
    values,
    standIns: [...values.keys()],
    neededBy: Object.fromEntries([...values.keys()].map((n) => [n, needed.get(n)])),
    skipped,
  };
}

/** Env-file lines for the stand-ins, in the form every envfile.mjs reader parses. */
export function standInLines(values) {
  return [...values].map(([n, v]) => `${n}=${v}`).join("\n");
}

/**
 * Is `value` the stand-in this module gives `name`? Used so an inert stamp keeps
 * it instead of re-inventing one. Its caller holds the schema's shape but not
 * the source's URL uses, so the value a URL use gives counts too.
 */
export function isStandIn(name, value, shape = null) {
  if (value === undefined || value === null) return false;
  return String(value) === standInValue(name, shape) || String(value) === standInValue(name, shape, { url: true });
}
