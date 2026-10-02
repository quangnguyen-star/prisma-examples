#!/usr/bin/env node
/**
 * Stage 3 helper — read the service's own vocabulary out of the staging DB.
 *
 * Some arms cannot be decided from source. `if (location.locationType ===
 * LocationType.CITY)` is only reachable if a row with that value exists, and a
 * lookup by country name needs a name the table actually holds. Guessing those
 * is exactly the fabrication this pipeline exists to prevent — so they get read
 * from staging instead.
 *
 * SAFETY — this file is why the probe is a script and not an ad-hoc query:
 *   - read-only URL only, SELECT only, staging only. Never production.
 *   - every table declares an allowlist. A column not on it is NEVER selected.
 *   - the credential columns (api key material, provider secrets) are reduced to
 *     their JSON KEY NAMES. No value from them is read, printed, or written.
 *   - a table too big to read whole is SAMPLED rather than skipped, and every
 *     distribution says which it was: `"exhaustive": true` means every row was
 *     counted, `"exhaustive": false` carries the `sample` block that produced it.
 *
 *   node .claude/charpilot/dbvocab.mjs --env-file <path/to/.env>
 *   CHARPILOT_DB_URL=postgres://… node .claude/charpilot/dbvocab.mjs
 *
 * Writes out/db-vocabulary.json (gitignored — it describes a live system).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { relative, resolve, join } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

const OUTPUT = resolve(OUT_DIR, "db-vocabulary.json");

/**
 * CREDENTIAL-SHAPED COLUMN NAMES — the words that make a column unreadable.
 *
 * Matched against the name split into WORDS (`langfuse_key` → langfuse, key;
 * `anthropicApiKeys` → anthropic, api, keys), so `keyword` is one word of its
 * own and stays readable while `key` does not. A match is final: a Json column
 * is reduced to its KEY NAMES and a column of any other type is dropped from
 * the plan entirely, so no value from one is read, printed or written. The list
 * errs long: not selecting a readable column costs vocabulary; the reverse costs a secret.
 */
const CREDENTIAL_WORDS = new Set([
  "key", "keys", "apikey", "apikeys", "privatekey", "publickey", "private", "secret",
  "secrets", "token", "tokens", "password", "passwords", "passwd", "passphrase", "pwd",
  "credential", "credentials", "hash", "hashed", "hashes", "salt", "signature",
  "signatures", "sig", "nonce", "cert", "certificate", "certificates", "bearer", "jwt",
  "auth", "authorization", "otp", "session", "cookie", "cipher", "encrypted", "verifier",
]);

function readUrl() {
  const argv = process.argv.slice(2);
  const fileFlag = argv.indexOf("--env-file");
  if (fileFlag !== -1) {
    const path = argv[fileFlag + 1];
    if (!path || !existsSync(path)) throw new Error(`--env-file ${path} not found`);
    const text = readFileSync(path, "utf8");
    for (const key of ["DATABASE_URL_READ_ONLY", "DATABASE_URL"]) {
      const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
      if (line) return { url: line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, ""), from: key };
    }
    throw new Error(`no DATABASE_URL_READ_ONLY or DATABASE_URL in ${path}`);
  }
  const url = process.env.CHARPILOT_DB_URL ?? process.env.DATABASE_URL_READ_ONLY;
  if (!url) throw new Error("pass --env-file <path> or set CHARPILOT_DB_URL");
  return { url, from: "environment" };
}

/**
 * WHY THE ALLOWLIST IS DISCOVERED AND NOT DECLARED.
 *
 * This file used to carry the five tables of ONE service as a constant —
 * api_key, default_model_key, api_key_fallback, model_pricing,
 * cached_langfuse_prompt — and six probes that named arms in
 * `getAiModelV1.service.ts` and `compilePrompt` by function. Run against
 * location-ms it wrote an artifact whose `source.database` said "location-ms"
 * and whose body described a different service: four of the five tables came
 * back `relation "default_model_key" does not exist`, and the tables the
 * remaining uncovered arms actually turn on — google_location, cached_location,
 * location, country, city, country_city — had no vocabulary at all. An agent
 * reading that cited tables the database does not have, which is worse than
 * reading nothing, because absent is a stop sign and wrong is not.
 *
 * So the allowlist comes from the TARGET: its own `schema.prisma` names the
 * models, their columns and their enums, and nothing is read that the schema
 * did not name. A discovered allowlist is still an allowlist — discovery
 * decides WHICH names are readable, it does not make every name readable:
 *
 *   enum / Boolean columns  a composite GROUP BY, bounded by the enum's own
 *                           size. This is the "does a row with this value
 *                           exist" question, which is the one an arm asks.
 *   String columns          only after `count(DISTINCT c)` says the column is a
 *                           vocabulary and not data. Above the cap only that
 *                           count is written, never a value.
 *   Json columns            KEY NAMES only, never a value — the rule the
 *                           credential columns were already held to, applied to
 *                           every Json column there is.
 *   credential-shaped       dropped from the plan, and named with the reason so
 *   personal-data-shaped    the artifact says what it declined to read. A Json
 *                           column keeps the key-names read, which is the same
 *                           no-values rule by another route.
 *   everything else         listed as a column. Never selected.
 *
 * The six PROBES are gone rather than generalised. Four of them asked a
 * question the distributions above now answer for any schema ("which providers
 * exist", "are any pricing rows disabled", "what does the enable filter do",
 * "can any row be enabled"), one is the `rowsMissingKey` count that jsonShapes
 * already measures, and the last two were regexes over one service's prompt
 * names. A probe that names a function cannot be carried to a repo that has no
 * such function, and carrying it anyway is how the artifact came to describe
 * the wrong service.
 */

/** Postgres scalars Prisma can declare. Anything else is a relation or unknown. */
const SCALARS = new Set(["String", "Boolean", "Int", "BigInt", "Float", "Decimal", "DateTime", "Json", "Bytes"]);

/** A String column with more distinct values than this is data, not vocabulary. */
const MAX_DISTINCT = 200;
/** Rows written per distribution. */
const SAMPLE_LIMIT = 50;
/** Longest value that may cross the wire, applied server-side with left(). */
const MAX_VALUE_CHARS = 200;
/**
 * Above this many rows a column is not profiled EXHAUSTIVELY — a `count(DISTINCT
 * c)` over a whole table is a sequential scan, and one run of this tool must not
 * be the most expensive thing that happened to staging that day.
 *
 * It used to mean "not profiled AT ALL", and that emptied the one table the
 * uncovered arms read. Against /private/tmp/p8test every distribution for
 * `google_location` (2,816,129 rows) came back
 *
 *   {"sampled": false, "why": "2816129 rows is above the 200000-row profiling cap"}
 *
 * for raw_text, city and country alike. The agent working that repo sourced
 * exactly ONE real string out of the whole artifact and computed the rest by
 * hand, including an md5 of a cache key — which is the fabrication this file
 * exists to prevent, arrived at by way of an artifact that carried nothing.
 *
 * The REASON behind the cap is "do not read the whole table", and a bounded
 * sample does not read the whole table. So above the cap the read changes shape
 * and the artifact says so; it does not become a refusal. The 200-DISTINCT cap
 * below is a different rule with a different reason and is untouched by this.
 */
const MAX_ROWS_TO_PROFILE = 200_000;
/**
 * Rows a bounded sample may draw above that cap.
 *
 * Deliberately an order of magnitude under MAX_ROWS_TO_PROFILE: the escape from
 * the cap must not cost more than the read the cap already permits. `samplePlan`
 * clamps the TABLESAMPLE percentage so the PAGES Postgres touches stay under the
 * cap too, whatever the table's size.
 */
const SAMPLE_ROWS = 20_000;
/**
 * TABLESAMPLE SYSTEM picks PAGES, not rows, and `IS NOT NULL` then throws some
 * of them away — so ask for more than the LIMIT keeps rather than come back
 * short. Still clamped by the cap: see samplePlan.
 */
const SAMPLE_OVERSHOOT = 4;
/**
 * A fixed seed, so two runs against an unchanged table draw the same rows. A
 * vocabulary that changes under the agent between the read and the citation is
 * a vocabulary they cannot cite.
 */
const SAMPLE_SEED = 20260917;
/**
 * The longest any one statement here may run, in seconds, handed to the driver
 * as `socket_timeout`.
 *
 * Nothing here used to bound a statement in TIME. The caps bound how many rows a
 * read may RETURN, which is not the same question: a sampled read of a 2.8M-row
 * table is bounded work and can still sit behind a lock or a cold cache. A
 * profiling step that hangs has replaced a bad artifact with a stalled run,
 * which is worse. Not applied when the DSN already names one — an operator's
 * number wins over this one.
 */
const STATEMENT_BUDGET_SECONDS = 60;
/** Json key names listed per column. */
const MAX_JSON_KEYS = 50;

/** A name safe to put between double quotes in SQL. Anything else is dropped. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** The words in a column name, lowercased: `anthropicApiKeys` → anthropic, api, keys. */
export function words(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * PERSONAL-DATA-SHAPED COLUMN NAMES.
 *
 * A vocabulary is a list of values an arm turns on. An email address is not
 * one — it is a person on staging — and neither is a URL, which can carry a
 * credential in its userinfo. Same treatment as a credential name: dropped from
 * the plan, listed by name with the reason, never selected.
 *
 * `name` is deliberately NOT here. The schema cannot tell `country.name` from
 * `users.name`, and excluding it would take out the exact vocabulary whose
 * absence caused this rewrite. What stands between the two is the distinct-value
 * cap, and that is the honest account of it.
 */
const PERSONAL_WORDS = new Set([
  "email", "emails", "mail", "phone", "phones", "mobile", "msisdn", "address",
  "addresses", "street", "zip", "zipcode", "postcode", "postalcode", "ssn",
  "passport", "dob", "birthdate", "birthday", "gender", "ip", "ipaddress",
  "useragent", "avatar", "photo", "url", "uri", "href", "link", "webhook",
]);

/** Is this name credential-shaped? Erring towards NOT selecting is the whole point. */
export function isCredentialName(name) {
  return words(name).some((w) => CREDENTIAL_WORDS.has(w));
}

/** Is this name personal-data-shaped? */
export function isPersonalName(name) {
  return words(name).some((w) => PERSONAL_WORDS.has(w));
}

/** Why this column may never be selected by value, or null. */
export function withholdReason(field) {
  for (const n of [field.name, field.column]) {
    if (isCredentialName(n)) return "credential-shaped name";
    if (isPersonalName(n)) return "personal-data-shaped name";
  }
  return null;
}

/** Names that identify a row rather than describe it — never a vocabulary. */
function isIdentifierName(name) {
  const w = words(name);
  return w.at(-1) === "id" || ["uuid", "guid", "cuid", "ulid"].includes(w.at(-1));
}

/** Strip `//` and `///` comments without touching a `//` inside a quoted string. */
function stripComments(text) {
  const out = [];
  for (const line of text.split("\n")) {
    let quoted = false;
    let cut = line.length;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '"') quoted = !quoted;
      else if (!quoted && line[i] === "/" && line[i + 1] === "/") {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join("\n");
}

/**
 * The models and enums a `schema.prisma` declares.
 *
 * A focused reader, not a Prisma parser: it needs the table name, the column
 * names and the enums, and no dependency may be added to get them. Anything it
 * cannot read is left out rather than guessed at — a field it does not
 * recognise is a field that never reaches the plan.
 */
export function parsePrismaSchema(text) {
  const enums = {};
  const blocks = [];
  let block = null;

  for (const raw of stripComments(String(text)).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!block) {
      const m = /^(model|enum|view|type)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/.exec(line);
      if (m) block = { kind: m[1], name: m[2], body: [] };
      continue;
    }
    if (line === "}") {
      if (block.kind === "enum") {
        enums[block.name] = block.body.map((l) => l.split(/\s+/)[0]).filter((v) => /^[A-Za-z_]/.test(v));
      } else if (block.kind === "model") {
        blocks.push(block);
      }
      block = null;
      continue;
    }
    block.body.push(line);
  }

  const modelNames = new Set(blocks.map((b) => b.name));
  const models = blocks.map((b) => {
    let table = b.name;
    const fields = [];
    for (const line of b.body) {
      if (line.startsWith("@@")) {
        const m = /^@@map\(\s*"([^"]+)"\s*\)/.exec(line);
        if (m) table = m[1];
        continue;
      }
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, name, type, list, optional, attrs] = m;
      const mapped = /@map\(\s*"([^"]+)"\s*\)/.exec(attrs);
      const kind = enums[type] ? "enum" : SCALARS.has(type) ? "scalar" : "relation";
      fields.push({
        name,
        type,
        kind: modelNames.has(type) || /@relation\b/.test(attrs) ? "relation" : kind,
        column: mapped ? mapped[1] : name,
        list: Boolean(list),
        optional: Boolean(optional),
        isId: /@id\b/.test(attrs),
        isUnique: /@unique\b/.test(attrs),
      });
    }
    return { model: b.name, table, fields };
  });

  return { enums, models };
}

/** Where a target keeps its schema, in the order Prisma itself would look. */
export function findSchemaFiles(root, env = process.env) {
  const override = env.CHARPILOT_PRISMA_SCHEMA;
  if (override) {
    const path = resolve(root, override);
    return existsSync(path) ? [path] : [];
  }
  // Prisma 5.15+ lets the schema be a FOLDER of .prisma files. Read them all:
  // half a schema would name half the models and look complete.
  const folder = join(root, "prisma", "schema");
  if (existsSync(folder)) {
    try {
      const parts = readdirSync(folder)
        .filter((f) => f.endsWith(".prisma"))
        .sort()
        .map((f) => join(folder, f));
      if (parts.length) return parts;
    } catch {
      // Unreadable is the same as absent; the caller says so plainly.
    }
  }
  for (const rel of [join("prisma", "schema.prisma"), "schema.prisma", join("src", "prisma", "schema.prisma")]) {
    const path = join(root, rel);
    if (existsSync(path)) return [path];
  }
  return [];
}

/**
 * What this target's schema says, or the sentence explaining why there is
 * nothing to read. `refusal` is never null AND a model list at the same time.
 */
export function discover(root, env = process.env) {
  const files = findSchemaFiles(root, env);
  if (!files.length) {
    return {
      files: [],
      models: [],
      enums: {},
      refusal:
        `no Prisma schema under ${root} (looked for prisma/schema/*.prisma, prisma/schema.prisma, ` +
        `schema.prisma, src/prisma/schema.prisma; $CHARPILOT_PRISMA_SCHEMA overrides) — ` +
        `so nothing names the tables this service has, and a vocabulary read without one would ` +
        `describe whatever database the DSN happens to point at`,
    };
  }

  let text = "";
  for (const f of files) {
    try {
      text += `${readFileSync(f, "utf8")}\n`;
    } catch (err) {
      return { files, models: [], enums: {}, refusal: `${f} could not be read: ${err.message}` };
    }
  }

  const { enums, models } = parsePrismaSchema(text);
  if (!models.length) {
    return {
      files,
      models: [],
      enums,
      refusal: `${files.join(", ")} declares no models, so there is no table list to read from`,
    };
  }
  return { files, models, enums, refusal: null };
}

/**
 * One model's READ PLAN: the only columns this tool is allowed to touch, and
 * the named reason each one is on its list.
 */
export function planTable(model) {
  const combine = [];
  const strings = [];
  const json = [];
  const neverSelected = [];
  const unreadableName = [];

  for (const f of model.fields) {
    if (f.kind === "relation" || f.list) continue;
    if (!IDENT.test(f.column)) {
      unreadableName.push(f.column);
      continue;
    }
    const withheld = withholdReason(f);

    // Json is key names either way, so the reason is carried rather than acted on.
    if (f.type === "Json") {
      json.push({ column: f.column, credential: withheld === "credential-shaped name" });
      continue;
    }
    if (f.isId) continue;

    const flag = f.kind === "enum" || f.type === "Boolean";
    const vocabulary = f.type === "String" && !isIdentifierName(f.name) && !isIdentifierName(f.column);
    // Only a column that WOULD have been read can be withheld from being read.
    // Listing an Int of token counts as "never selected" because it is spelled
    // `total_tokens` says this file found a credential where there is none, and
    // an artifact that claims a check it did not make is the defect in little.
    if (!flag && !vocabulary) continue;
    if (withheld) {
      neverSelected.push({ column: f.column, why: withheld });
      continue;
    }
    if (flag) combine.push(f.column);
    else strings.push(f.column);
  }

  return { table: model.table, model: model.model, combine, strings, json, neverSelected, unreadableName };
}

/** Every model's plan, and never a table the schema did not name. */
export function plan(discovery) {
  return discovery.models.filter((m) => IDENT.test(m.table)).map(planTable);
}

/**
 * The plan that survives contact with the database.
 *
 * `columnRows` is what information_schema answered. A table with no columns
 * there is a table the database does not have, and it goes on `absent` — it is
 * NEVER given an entry in `tables`, because an entry is what an agent cites. A
 * planned column the database does not have is dropped the same way.
 */
export function reconcile(planned, columnRows) {
  const byTable = new Map();
  for (const r of columnRows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, []);
    byTable.get(r.table_name).push(r);
  }

  const readable = [];
  const absent = [];
  for (const p of planned) {
    const columns = byTable.get(p.table);
    if (!columns?.length) {
      absent.push(p.table);
      continue;
    }
    const has = (c) => columns.some((x) => x.column_name === c);
    readable.push({
      ...p,
      columns,
      combine: p.combine.filter(has),
      strings: p.strings.filter(has),
      json: p.json.filter((j) => has(j.column)),
      neverSelected: p.neverSelected.filter((w) => has(w.column)),
    });
  }
  return { readable, absent };
}

/**
 * Why a String column may not be profiled EXHAUSTIVELY: a `count(DISTINCT c)` is
 * a sequential scan, and one run of this tool must not be the most expensive
 * thing that happened to staging that day.
 *
 * Still the same sentence it always returned, and still the reason the read
 * changes — what changed is what the caller DOES with it. It used to end the
 * read; now it chooses a bounded sample, and the sentence becomes the artifact's
 * account of why the values are sampled. See profileStrategy.
 */
export function profilable(rows) {
  return rows > MAX_ROWS_TO_PROFILE ? `${rows} rows is above the ${MAX_ROWS_TO_PROFILE}-row profiling cap` : null;
}

/**
 * Why a String column's VALUES may not be written: above the cap the column is
 * data rather than vocabulary, and the count alone is the honest answer. This
 * is the line between "a value stage 3 can pick" and "a dump of the table".
 *
 * NOT THE SAME CAP AS MAX_ROWS_TO_PROFILE, and not moved when that one was.
 * That cap is about the cost of the read; this one is about whether there is a
 * vocabulary at the end of it. `cached_location.raw_text` has 68,899 distinct
 * values on staging: it is genuinely data, and handing stage 3 all 68,899 to
 * choose between is worse than handing it one. So this stays exactly where it
 * is, and it applies to a sampled read as much as to an exhaustive one.
 */
export function sampleable(distinct) {
  if (!distinct) return "no non-null values";
  if (distinct > MAX_DISTINCT) return `${distinct} distinct values is above the ${MAX_DISTINCT} cap — this column is data, not vocabulary`;
  return null;
}

/**
 * How much of a table above the row cap a sample may touch.
 *
 * `percent` goes to TABLESAMPLE SYSTEM, which reads that fraction of the table's
 * PAGES — so the work is a fraction of the table rather than a scan of it, which
 * is the whole reason the row cap can be satisfied rather than lifted. Two
 * clamps, and the tighter one wins:
 *
 *   sampleRows × overshoot   enough pages to fill the sample after the nulls
 *   cap                      never more pages than a permitted whole-table read
 *
 * Below the cap there is nothing to sample and this is not called.
 */
export function samplePlan(rows, { sampleRows = SAMPLE_ROWS, cap = MAX_ROWS_TO_PROFILE, overshoot = SAMPLE_OVERSHOOT } = {}) {
  const want = Math.min(sampleRows * overshoot, cap);
  const percent = Math.min(100, Math.max(0.01, Math.ceil((want / rows) * 10_000) / 100));
  return {
    sampleRows: Math.min(sampleRows, rows),
    percent,
    scanCeiling: Math.ceil((rows * percent) / 100),
    seed: SAMPLE_SEED,
  };
}

/**
 * How this column gets read, and the sentence the artifact carries about it.
 *
 * `exhaustive` is the field an agent has to see. A top-values list drawn from a
 * sample is evidence that a value EXISTS — which is the whole question an arm
 * like `if (location.locationType === CITY)` asks — and it is NOT evidence that
 * the list is complete or that the counts are the column's. Saying which one it
 * is, per column, is the difference between a vocabulary and a guess with
 * counts printed next to it.
 */
export function profileStrategy(rows, opts) {
  const above = profilable(rows);
  if (!above) return { mode: "exhaustive", exhaustive: true, ofRows: rows, why: null };
  const s = samplePlan(rows, opts);
  return {
    mode: "sample",
    exhaustive: false,
    ofRows: rows,
    ...s,
    why:
      `${above}, so this column was read from a BOUNDED RANDOM SAMPLE instead of being skipped: at most ` +
      `${s.sampleRows} rows drawn with TABLESAMPLE SYSTEM (${s.percent}) REPEATABLE (${s.seed}), touching at ` +
      `most ${s.scanCeiling} of ${rows} rows. These values are SAMPLED, not exhaustive — each one exists in ` +
      `this column, the counts are the sample's and not the column's, and a value absent from the list is ` +
      `not a value the column lacks.`,
  };
}

/**
 * The distinct cap's verdict, told honestly for whichever read produced the
 * count.
 *
 * The cap is unchanged and bites in both modes. What a SAMPLE can say is weaker
 * in one direction only: 201 distinct values in 20,000 sampled rows proves the
 * column holds at least 201, so declining is still right; under the cap in the
 * sample does not prove under the cap in the table, so the `sample` block that
 * travels with the values is what makes that readable.
 */
export function declineReason(distinct, exhaustive) {
  const why = sampleable(distinct);
  if (!why || exhaustive) return why;
  if (!distinct) return "no non-null values in the sample — the column may still hold some outside it";
  return `${why} — counted in the sample, so the column holds at least this many`;
}

/**
 * The DSN with a per-statement budget on it, unless it already carries one.
 *
 * `socket_timeout` is the driver's own knob and the one an operator can already
 * write into the DSN, so theirs is left alone. An unparseable URL is handed
 * back untouched: readUrl's caller parses it too and gets the better error.
 */
export function withQueryBudget(url, seconds = STATEMENT_BUDGET_SECONDS) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("socket_timeout")) return url;
    u.searchParams.set("socket_timeout", String(seconds));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * What the two profiling statements read FROM.
 *
 * Exhaustive: the table. Sampled: a bounded subquery, and every question —
 * including the `count(DISTINCT)` that is the sequential scan the row cap exists
 * to prevent — is asked of that subquery rather than of the table. Asking the
 * distinct count of the TABLE and the values of a SAMPLE would be the cap
 * defeated with extra steps.
 *
 * `col` is a column planTable() already cleared: a credential- or
 * personal-data-shaped name never reaches `t.strings`, so it never reaches here.
 * Sampling adds no new way into a column, only a different way through the same
 * one.
 */
export function profileFrom(table, col, strategy) {
  if (strategy.exhaustive) return ident(table);
  return (
    `(SELECT ${ident(col)} FROM ${ident(table)} TABLESAMPLE SYSTEM (${strategy.percent}) ` +
    `REPEATABLE (${strategy.seed}) WHERE ${ident(col)} IS NOT NULL LIMIT ${strategy.sampleRows}) AS charpilot_sample`
  );
}

/**
 * One distribution, as the artifact carries it.
 *
 * `top` is null when the values were declined — `declineReason` says why, and
 * the count still goes out because a count is not a value. The two names for the
 * count are deliberate: a field called `distinct` on a sampled read would be
 * read as the column's number, and it is the sample's.
 */
export function distribution(strategy, { distinct, nonNull = null, top = null }) {
  const why = declineReason(distinct, strategy.exhaustive);
  const count = strategy.exhaustive ? { distinct } : { distinctInSample: distinct };
  const basis = strategy.exhaustive
    ? { exhaustive: true }
    : {
        exhaustive: false,
        sample: {
          ofRows: strategy.ofRows,
          rowsAsked: strategy.sampleRows,
          rowsRead: nonNull,
          percent: strategy.percent,
          seed: strategy.seed,
          why: strategy.why,
        },
      };
  return why ? { ...count, ...basis, sampled: false, why } : { ...count, ...basis, sampled: true, top: top ?? [] };
}

/** Nothing but a SELECT, and exactly one of them. */
export function selectOnly(sql) {
  if (!/^\s*SELECT\b/i.test(String(sql))) throw new Error(`refusing a statement that is not a SELECT: ${String(sql).slice(0, 80)}`);
  if (String(sql).includes(";")) throw new Error(`refusing a statement with a ';' in it: ${String(sql).slice(0, 80)}`);
  return sql;
}

/** A quoted identifier, or a throw. Nothing unvalidated reaches the SQL. */
function ident(name) {
  if (!IDENT.test(name)) throw new Error(`refusing to quote ${JSON.stringify(name)} as an identifier`);
  return `"${name}"`;
}

/** A single-quoted literal. Used only for names this file already validated. */
function lit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** The artifact that carries nothing, and says why. */
export function emptyVocabulary(reason, source = null) {
  return {
    stage: "3-db-vocabulary",
    readAt: new Date().toISOString(),
    source,
    warning: "Shapes only. No credential value was read from this database.",
    empty: true,
    reason,
    tables: {},
  };
}

function write(vocabulary) {
  writeFileSync(OUTPUT, JSON.stringify(vocabulary, null, 2));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { url, from } = readUrl();
  const target = new URL(url);
  const source = { host: target.hostname, port: target.port, database: target.pathname.slice(1), urlFrom: from };

  // THE SCHEMA FIRST, and the database only if the schema named something. A
  // target with no schema gets an honest empty and no connection at all: there
  // is no allowlist to read against, and reading without one is the failure
  // this rewrite exists to remove.
  const discovery = discover(REPO_ROOT);
  if (discovery.refusal) {
    write(emptyVocabulary(discovery.refusal, source));
    process.stdout.write(`\n✓ db vocabulary → ${relative(REPO_ROOT, OUTPUT)}  (EMPTY)\n    ${discovery.refusal}\n`);
    return;
  }

  const planned = plan(discovery);
  if (!planned.length) {
    // Every model the schema declares has a table name SQL cannot quote. There
    // is no `IN ()` to write and nothing to ask, so the answer is the empty one
    // rather than a malformed statement.
    const reason = `${discovery.models.length} models in ${relative(REPO_ROOT, discovery.files[0])}, and not one has a table name this tool will put in a statement`;
    write(emptyVocabulary(reason, source));
    process.stdout.write(`\n✓ db vocabulary → ${relative(REPO_ROOT, OUTPUT)}  (EMPTY)\n    ${reason}\n`);
    return;
  }

  const { PrismaClient } = await import("@prisma/client");
  // See STATEMENT_BUDGET_SECONDS: bounded rows is not the same as bounded time,
  // and the sampled read above is the one that made the difference matter.
  const prisma = new PrismaClient({ datasources: { db: { url: withQueryBudget(url) } } });

  const q = (sql) => prisma.$queryRawUnsafe(selectOnly(sql));
  const scalar = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
  const n = (rows) => Number(rows[0]?.n ?? 0);

  try {
    // One question for every table at once, and against the schema the
    // unqualified statements below will actually resolve in.
    const columnRows = scalar(
      await q(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name IN (${planned.map((p) => lit(p.table)).join(", ")})
         ORDER BY table_name, ordinal_position`
      )
    );
    const { readable, absent } = reconcile(planned, columnRows);

    if (!readable.length) {
      const reason =
        `none of the ${planned.length} tables ${relative(REPO_ROOT, discovery.files[0])} declares exists in ` +
        `${source.host}/${source.database} — the schema and the DSN describe different databases, and a ` +
        `vocabulary written from one against the other would name tables this service does not have`;
      write(emptyVocabulary(reason, source));
      process.stdout.write(`\n✓ db vocabulary → ${relative(REPO_ROOT, OUTPUT)}  (EMPTY)\n    ${reason}\n`);
      return;
    }

    const vocabulary = {
      stage: "3-db-vocabulary",
      readAt: new Date().toISOString(),
      source,
      warning: "Shapes only. No credential value was read from this database.",
      reading:
        `Every entry in \`distributions\` carries \`exhaustive\`. \`true\` means every row of the column was ` +
        `counted. \`false\` means the column belongs to a table above the ${MAX_ROWS_TO_PROFILE}-row profiling ` +
        `cap and was read from a bounded random sample, described in that entry's \`sample\` block: each value ` +
        `shown EXISTS in the column, the counts are the sample's, \`distinctInSample\` is a floor and not a ` +
        `total, and a value absent from the list is not a value the column lacks. \`sampled: false\` with a ` +
        `\`why\` is a column whose values were deliberately not written — above the ${MAX_DISTINCT}-distinct cap ` +
        `a column is data rather than vocabulary, and only its count is honest to give.`,
      discovery: {
        from: discovery.files.map((f) => relative(REPO_ROOT, f)),
        models: discovery.models.length,
        enums: discovery.enums,
        neverSelected: Object.fromEntries(
          readable.filter((r) => r.neverSelected.length).map((r) => [r.table, r.neverSelected])
        ),
      },
      tables: {},
      tablesInSchemaButNotInDatabase: absent,
    };

    for (const t of readable) {
      const entry = { model: t.model, columns: t.columns, rows: 0 };
      entry.rows = n(scalar(await q(`SELECT count(*) AS n FROM ${ident(t.table)}`)));
      if (t.neverSelected.length) entry.neverSelected = t.neverSelected;

      // Enums and flags together: an arm needs a row where BOTH hold, and two
      // separate counts cannot say whether one exists.
      if (t.combine.length && entry.rows) {
        const list = t.combine.map(ident).join(", ");
        entry.combinations = scalar(
          await q(`SELECT ${list}, count(*) AS n FROM ${ident(t.table)} GROUP BY ${list} ORDER BY n DESC LIMIT ${SAMPLE_LIMIT}`)
        );
      }

      // THE ROW CAP CHOOSES THE READ; IT NO LONGER ENDS IT.
      //
      // Above the cap `from` becomes a bounded sample and EVERY question is
      // asked of that sample — including `count(DISTINCT)`, which is the
      // sequential scan the cap exists to prevent, so it must not be asked of
      // the table. Below the cap `from` is the table and nothing has changed.
      //
      // `t.strings` is what planTable() left after withholding: a
      // credential-shaped or personal-data-shaped column never reaches this
      // loop, so no read written here can select one. That is the same rule and
      // the same single gate it was before sampling existed.
      for (const col of t.strings) {
        if (!entry.rows) break;
        entry.distributions ??= {};
        const strategy = profileStrategy(entry.rows);
        const from = profileFrom(t.table, col, strategy);
        try {
          const counts =
            scalar(await q(`SELECT count(DISTINCT ${ident(col)}) AS n, count(${ident(col)}) AS nonnull FROM ${from}`))[0] ?? {};
          const distinct = Number(counts.n ?? 0);
          const nonNull = Number(counts.nonnull ?? 0);
          const top = declineReason(distinct, strategy.exhaustive)
            ? null
            : scalar(
                await q(
                  `SELECT left(${ident(col)}, ${MAX_VALUE_CHARS}) AS value, count(*) AS n FROM ${from}
                   WHERE ${ident(col)} IS NOT NULL GROUP BY 1 ORDER BY n DESC, 1 ASC LIMIT ${SAMPLE_LIMIT}`
                )
              );
          entry.distributions[col] = distribution(strategy, { distinct, nonNull, top });
        } catch (err) {
          // TABLESAMPLE is a clause about a TABLE's pages: a model mapped onto a
          // view or a foreign table has none. That is an answer about this one
          // column's read and not a reason to lose the table — the same rule the
          // Json reads below already follow.
          entry.distributions[col] = {
            exhaustive: strategy.exhaustive,
            sampled: false,
            why: `${strategy.why ?? `${entry.rows} rows`} — the read failed: ${String(err.message).slice(0, 200)}`,
          };
        }
      }

      // Json: KEY NAMES only, never a value. For the credential columns that is
      // the safety rule; for every other Json column it is the same read, so
      // there is one rule here and not two.
      //
      // DISTINCT key names across rows says nothing about any single row. An arm
      // that needs a key ABSENT needs the per-key presence count, so it is
      // measured rather than inferred from the union.
      for (const j of t.json) {
        if (!entry.rows) break;
        entry.jsonShapes ??= {};
        try {
          const present = n(scalar(await q(`SELECT count(*) AS n FROM ${ident(t.table)} WHERE ${ident(j.column)} IS NOT NULL`)));
          const keys = present
            ? scalar(
                await q(
                  `SELECT k, count(*) AS n FROM ${ident(t.table)},
                     LATERAL jsonb_object_keys(${ident(j.column)}::jsonb) AS k
                   WHERE ${ident(j.column)} IS NOT NULL GROUP BY k ORDER BY n DESC, k ASC LIMIT ${MAX_JSON_KEYS}`
                )
              )
            : [];
          entry.jsonShapes[j.column] = {
            credential: j.credential,
            nonNullRows: present,
            keys: keys.map((r) => r.k),
            keyPresence: Object.fromEntries(keys.map((r) => [r.k, { rowsWithKey: r.n, rowsMissingKey: present - r.n }])),
          };
        } catch (err) {
          // A Json column holding an array or a scalar has no object keys. That
          // is an answer about the shape, not a reason to lose the table.
          entry.jsonShapes[j.column] = { credential: j.credential, error: String(err.message).slice(0, 200) };
        }
      }

      vocabulary.tables[t.table] = entry;
    }

    write(vocabulary);

    process.stdout.write(
      `\n✓ db vocabulary → ${relative(REPO_ROOT, OUTPUT)}  (${source.host}/${source.database})\n` +
        `    from ${vocabulary.discovery.from.join(", ")}: ${discovery.models.length} models, ${readable.length} readable\n`
    );
    for (const [table, e] of Object.entries(vocabulary.tables)) {
      const dist = Object.values(e.distributions ?? {});
      const sampled = dist.filter((d) => d.sampled && d.exhaustive === false).length;
      const note = sampled ? `, ${sampled} column(s) SAMPLED (above the ${MAX_ROWS_TO_PROFILE}-row cap)` : "";
      process.stdout.write(`    ${table.padEnd(24)} ${String(e.rows).padStart(6)} rows, ${e.columns.length} columns${note}\n`);
    }
    for (const table of absent) {
      process.stdout.write(`    ${table.padEnd(24)} in the schema, NOT in this database\n`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n✗ db vocabulary failed: ${err.message}`);
    process.exit(1);
  });
}
