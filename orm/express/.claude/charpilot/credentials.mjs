#!/usr/bin/env node
/**
 * Stage 4 helper - fetch ONE real, enabled api_key row per provider so a live
 * recording can make a real provider call.
 *
 * This exists because of a fact that only shows up when you try it: staging's
 * environment carries NO provider credentials. `stagingenv.mjs` finds
 * `SLACK_HOOK`, `DATABASE_URL` and `DATABASE_URL_READ_ONLY` and nothing else -
 * every OpenAI / Anthropic / Vertex credential this service uses lives in an
 * `api_key` row (`openai_api_keys`, `anthropic_api_keys`, `google_key`). So
 * "call the real provider" is downstream of "read the real row".
 *
 *   node .claude/charpilot/credentials.mjs --env-file <staging .env>
 *
 * Writes out/.credentials.json - gitignored (`.claude/charpilot/out/`), and the
 * ONLY file in this pipeline that holds credential VALUES. `dbvocab.mjs`
 * deliberately reduces the same columns to key names; this one does not, which
 * is why it is a separate script with its own name rather than a flag on that
 * one. Nothing here is ever copied into behaviour-live.json: `record.mjs`
 * redacts credential-bearing headers and fields out of every captured request.
 *
 * Read-only URL, SELECT only, staging only, LIMIT 1 per provider.
 *
 * ONE SERVICE IN THE FLEET HAS THAT TABLE, AND THIS TOOL ASSUMED THEY ALL DID.
 *
 * `api_key` is the AI gateway's, exactly as `usage_log` is: of the 38 services
 * under qode-knowledge/repos, ONE declares it - ai-centralization. This tool is
 * hand-run and no step spawns it, so it has never appeared in a run log and the
 * assumption was never caught; providervocab.mjs made the same one against
 * `usage_log` and failed twenty-seven times over four days before anyone read
 * the line (D49/D50). So the table is PROBED against information_schema before
 * anything is selected from it - the same probe, `tableShape`, not a second
 * copy of it.
 *
 * AND THE ANSWER TO "NO api_key" IS A REFUSAL, NOT AN EMPTY ARTIFACT. That is
 * the opposite of what providervocab.mjs does with a missing `usage_log`, and
 * deliberately: see `noApiKeyTable` below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";
// The probe providervocab.mjs asks before IT selects anything - one statement
// against `information_schema.columns` under `current_schema()`, answering "is
// the table there" and "does it carry the column I am about to name" together.
// Imported rather than re-written: two copies of this question are two chances
// for them to disagree. providervocab.mjs runs nothing on import.
import { tableShape } from "./providervocab.mjs";

const OUTPUT = resolve(OUT_DIR, ".credentials.json");
const PROVIDERS = ["OPENAI", "ANTHROPIC", "VERTEXAI"];

function readUrl() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--env-file");
  if (i !== -1) {
    const path = argv[i + 1];
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

/** The one table this tool reads, and the only name it ever probes. */
export const API_KEY = "api_key";

/**
 * The columns the STATEMENT ITSELF names: `enable` and `provider` are its WHERE,
 * `id` is its ORDER BY and the row's identity in the report. Without all three
 * there is no "ONE real, enabled row per provider" to fetch - the ordering that
 * makes the answer reproducible is gone with it.
 */
const REQUIRED_COLUMNS = ["id", "provider", "enable"];

/**
 * The columns that make an `api_key` THIS tool's `api_key`.
 *
 * The whole output of this tool is credential VALUES, so a table of that name
 * carrying none of these three holds no provider credentials: it is some other
 * service's `api_key` that happens to share a word - an internal API token
 * table, say - and emptying it into out/.credentials.json would produce a
 * credentials file with no credentials in it and a reader who cannot tell.
 * At least ONE must be there.
 */
const CREDENTIAL_COLUMNS = ["openai_api_keys", "anthropic_api_keys", "google_key"];

/** Read when present, named in `notRead` when not. Nothing here is load-bearing. */
const OPTIONAL_COLUMNS = ["key", "service", "env", "proxy_url", "langfuse_key"];

/**
 * WHY THIS REFUSES WHERE providervocab.mjs ANSWERS.
 *
 * providervocab.mjs writes an `empty: true` vocabulary and exits 0 when the
 * database has no `usage_log`, because "this service records no provider usage"
 * is a true and ordinary answer, its step is OPTIONAL, and a downstream reader
 * carries on without it (`v.errors ?? []`).
 *
 * NONE OF THAT HOLDS HERE, and the two questions are not the same question:
 *
 *   "no API keys"    an `api_key` table with no enabled row for a provider. A
 *                    real answer, already handled below - `rows[PROVIDER] =
 *                    null`, one ✗ line, exit 0 - and its fix is to enable a row
 *                    or point at a different environment.
 *   "no api_key"     this service does not keep provider credentials in an
 *                    `api_key` table AT ALL. The premise the tool was run on is
 *                    false, and the fix is to find out where this service's
 *                    credentials actually live.
 *
 * An empty artifact at exit 0 would print those two as the same file. Nothing
 * downstream reads out/.credentials.json - a PERSON does, on their way to
 * making a real, metered provider call - and handing them a file of nulls for
 * the second case invites the conclusion that staging simply has no keys
 * enabled. So this is a refusal: a written reason on stderr, exit 1, and NO
 * file, because the one thing worse than no credentials file is a credentials
 * file that describes a table this database does not have.
 */
export function noApiKeyTable(database, what) {
  const stale = existsSync(OUTPUT)
    ? `\n  ${relative(REPO_ROOT, OUTPUT)} already exists and was NOT touched: it is from an earlier run against some other database.`
    : "";
  return new Error(
    `refusing to write credentials: ${what}\n` +
      `  "${API_KEY}" is the AI gateway's table - ai-centralization is the one service of 38 that declares it - ` +
      `and ${database} is not that service. This is NOT "no API keys are enabled": it is that this service keeps ` +
      `no provider credentials in an ${API_KEY} table at all, and where it does keep them is the question to answer next.\n` +
      `  Check that --env-file names the environment you meant; otherwise read the service's own env (npm run pilot:stagingenv) ` +
      `- stage 1 finds SLACK_HOOK, DATABASE_URL and DATABASE_URL_READ_ONLY on staging and nothing else, so a service outside ` +
      `the gateway may have no provider credential reachable from here at all, and a live recording for it has to be ` +
      `answered with a boundary rather than a real call.${stale}`
  );
}

/**
 * WHAT THE PROBE SAW, TURNED INTO ONE DECISION - and it is a decision this tool
 * can be asked about without a database, which is why it is a function and not
 * three `if`s inside `main`. `columns` is the Set `tableShape` returned for
 * `api_key`, or null when the database does not have the table at all.
 *
 *   { ok: false, what }              a refusal, `what` naming which of the
 *                                    three it is
 *   { ok: true, selected, notRead }  the columns to SELECT, in that order, and
 *                                    the ones this database does not have
 */
export function apiKeyRuling(columns) {
  if (!columns) return { ok: false, what: `has no ${API_KEY} table.` };

  const missing = REQUIRED_COLUMNS.filter((c) => !columns.has(c));
  if (missing.length) {
    return { ok: false, what: `has an ${API_KEY} table, but not the gateway's: no ${missing.join(" or ")} column.` };
  }
  if (!CREDENTIAL_COLUMNS.some((c) => columns.has(c))) {
    return {
      ok: false,
      what: `has an ${API_KEY} table with none of its credential columns (${CREDENTIAL_COLUMNS.join(", ")}).`,
    };
  }

  // What the statement needs, plus whatever else of the eleven this database
  // actually has. A gateway one schema version behind is missing a COLUMN, not
  // a credential, and losing every provider key to it would be the same
  // all-or-nothing that made this tool fail on a missing table.
  return {
    ok: true,
    selected: [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS, ...CREDENTIAL_COLUMNS].filter((c) => columns.has(c)),
    notRead: [...OPTIONAL_COLUMNS, ...CREDENTIAL_COLUMNS]
      .filter((c) => !columns.has(c))
      .map((c) => `${c} — ${API_KEY} has no such column`),
  };
}

/**
 * ONE real, enabled row for one provider, naming only probed columns.
 *
 * Every identifier is quoted and the only interpolations are `selected` - which
 * comes from `information_schema` by way of `apiKeyRuling` - and `provider`,
 * which is one of this file's own three PROVIDERS. Nothing here is reachable
 * from a caller's input.
 */
export function selectOneRow(selected, provider) {
  return (
    `SELECT ${selected.map((c) => `"${c}"`).join(", ")} FROM "${API_KEY}" ` +
    `WHERE "enable" = true AND "provider" = '${provider}' ORDER BY "id" LIMIT 1`
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { url, from } = readUrl();
  const target = new URL(url);
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const q = (s) => prisma.$queryRawUnsafe(s);
  const database = target.pathname.slice(1);

  // THE PROBE COMES FIRST, and every statement after it names a column this
  // database was just observed to have. A refusal here has read nothing and
  // written nothing.
  let ruling;
  try {
    ruling = apiKeyRuling((await tableShape(q, [API_KEY])).get(API_KEY));
  } catch (err) {
    await prisma.$disconnect();
    throw err;
  }
  if (!ruling.ok) {
    await prisma.$disconnect();
    throw noApiKeyTable(database, `${database} ${ruling.what}`);
  }
  const { selected, notRead } = ruling;

  const doc = {
    stage: "4-live-credentials",
    readAt: new Date().toISOString(),
    source: { host: target.hostname, port: target.port, database, urlFrom: from },
    warning: "HOLDS REAL CREDENTIAL VALUES. Gitignored. Never copy into a fixture or a report.",
    rows: {},
    // A reader cannot tell an absent column from a column full of nulls, so the
    // ones this database does not have are named rather than left as nulls.
    ...(notRead.length ? { notRead } : {}),
  };

  for (const provider of PROVIDERS) {
    const rows = await q(selectOneRow(selected, provider));
    if (!rows.length) {
      // A REAL ANSWER, not the refusal above: the gateway's table is there and
      // this provider has no enabled row in it. Named as such.
      doc.rows[provider] = null;
      process.stdout.write(`  ✗ ${provider.padEnd(10)} no enabled row\n`);
      continue;
    }
    const r = rows[0];
    doc.rows[provider] = {
      id: r.id,
      key: r.key ?? null,
      service: r.service ?? null,
      env: r.env ?? null,
      enable: r.enable,
      provider: r.provider,
      proxyUrl: r.proxy_url ?? null,
      langfuseKeys: r.langfuse_key ?? null,
      openaiApiKeys: r.openai_api_keys ?? null,
      anthropicApiKeys: r.anthropic_api_keys ?? null,
      googleKeys: r.google_key ?? null,
    };
    // Shapes only in the log - the values go to the gitignored file, not here.
    const shape = (o) => (o ? Object.keys(o).join(",") : "-");
    process.stdout.write(
      `  ✓ ${provider.padEnd(10)} row ${String(r.id).slice(0, 8)}…  service=${r.service ?? "-"} env=${r.env ?? "-"}  ` +
        `openai[${shape(r.openai_api_keys)}] anthropic[${shape(r.anthropic_api_keys)}] google[${shape(r.google_key)}]\n`
    );
  }

  await prisma.$disconnect();
  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);
  process.stdout.write(
    `\n✓ credentials → ${relative(REPO_ROOT, OUTPUT)} (gitignored)\n` +
      (notRead.length ? `    not read              ${notRead.join("; ")}\n` : "")
  );
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
    console.error(err.message);
    process.exit(1);
  });
}
