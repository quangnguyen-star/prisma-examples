/**
 * Real provider outcomes, taken from what this service already recorded.
 *
 * 76 proposals are blocked because they reach a provider endpoint no boundary
 * answers, and 66 of them would need real authenticated LLM calls to record -
 * metered, and the credentials live in api_key rows rather than env.
 *
 * They do not need calling. This service writes every call it makes to
 * usage_log / usage_log_content: 17,136 rows on staging, including 220 errors
 * across all three providers. That is the real vocabulary - real error strings,
 * real finish_reason values, real token and cost null rates - and it is free.
 *
 * READ ONLY, and content is never captured. `output_text` is model output over
 * real candidate data and `input_messages` carries the prompts, so this reads
 * only their SHAPE: types, lengths, null rates, JSON key names. Error messages
 * are truncated hard - enough to build a mock answer, not enough to carry
 * request content. Provider keys already arrive masked in that column
 * (`sk-proj-********`), and none is widened here.
 *
 * ONE SERVICE IN THE FLEET HAS THAT TABLE, AND THIS TOOL RAN AS IF THEY ALL DID.
 *
 * `usage_log` is the AI gateway's. Of the 38 services under
 * qode-knowledge/repos, exactly ONE declares it - ai-centralization
 * (prisma/schema.prisma:51, `@@map("usage_log")`) - and the walked repos are
 * geocoders, workers and a recruiting backend that never had it. So the first
 * statement this tool sent hit a table that was not there, and it exited 1:
 * 7 of 7 rounds on qode-ptp-ms (docker/runs/20260918T073111Z), 2 of 2 and 5 of 5
 * on tracy-worker, 4 of 4 and 9 of 9 on location-ms. Twenty-seven consecutive
 * failures over four days, and no run in that log has ever held a provider
 * vocabulary - so every CHARPILOT_MODE=mocked answer the fleet produced was
 * written without one.
 *
 * It was invisible because the tolerance around it is CORRECT: steps/vocabulary
 * .mjs is OPTIONAL and satisfied when the repo cannot give this tool a DSN, and
 * a missing table read as that case. What was wrong is reporting a HARD ERROR
 * for an ordinary condition - a service that records no provider usage.
 *
 * So the tables are PROBED against information_schema before anything is
 * selected from them, and their absence is an answer rather than a failure: an
 * `empty: true` vocabulary with a reason, on disk, exit 0. The same shape
 * dbvocab.mjs:660 already writes when the schema and the DSN describe different
 * databases. A table that IS there and a query that then fails is a real error
 * and still exits 1.
 *
 * Both arms verified against the real staging databases on 2026-09-19:
 *   34…/tracy-worker            probe returns [], the old first query threw
 *                               P2010 / `Raw query failed. Code: 42P01.
 *                               Message: relation "usage_log" does not exist`
 *   34…/ai-centralization-ms    probe returns usage_log and usage_log_content,
 *                               and the query answers 17,136 recorded calls
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";

const ARGV = process.argv.slice(2);
const arg = (f) => (ARGV.includes(f) ? ARGV[ARGV.indexOf(f) + 1] : undefined);
const ENV_FILE = arg("--env-file") ?? join(OUT_DIR, "staging.env");
const OUTPUT = join(OUT_DIR, "provider-vocab.json");
const ERROR_CLIP = 160;

function readUrl() {
  const text = readFileSync(ENV_FILE, "utf8");
  for (const key of ["DATABASE_URL_READ_ONLY", "DATABASE_URL"]) {
    const line = text.split("\n").find((l) => l.startsWith(`${key}=`));
    if (line) return { url: line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, ""), from: key };
  }
  throw new Error(`no DATABASE_URL_READ_ONLY or DATABASE_URL in ${ENV_FILE}`);
}

/** The two tables every statement below reads, and nothing else is ever probed. */
export const USAGE_LOG = "usage_log";
export const USAGE_LOG_CONTENT = "usage_log_content";

/**
 * The columns that make a `usage_log` THIS tool's `usage_log`.
 *
 * A table of that name with neither `provider` nor `status` is some other
 * service's table that happens to share a word, and reading it would produce a
 * vocabulary of the wrong thing - which is worse than none, because nothing
 * downstream can tell them apart.
 */
const GATEWAY_COLUMNS = ["provider", "status"];

/** The sentence a reader gets when there is nothing to read. One spelling of it. */
export const NO_PROVIDER_USAGE = "this service records no provider usage";

/** A SQL string literal for a name this file owns. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * WHAT THIS DATABASE ACTUALLY HAS, asked before anything is selected from it.
 *
 * `information_schema.columns` rather than `.tables`, in ONE statement, because
 * the two questions this tool has to answer - is the table there, and does it
 * carry the column this statement names - have one answer, and asking them
 * separately is two chances for them to disagree. dbvocab.mjs:718 asks the same
 * question the same way.
 *
 * `table_schema = current_schema()` and not `'public'`: every statement below is
 * unqualified, so the schema it will resolve in is the one the probe must ask
 * about. A DSN carrying `?schema=…` moves both together.
 *
 * Returns a Map from table name to a Set of its column names. A table the
 * database does not have is simply absent from the map - there is no empty-Set
 * case to confuse with it.
 */
export async function tableShape(q, tables) {
  const rows = await q(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN (${tables.map(lit).join(", ")})`
  );
  const shape = new Map();
  for (const r of rows) {
    if (!shape.has(r.table_name)) shape.set(r.table_name, new Set());
    shape.get(r.table_name).add(r.column_name);
  }
  return shape;
}

/**
 * The artifact for a service that records no provider usage.
 *
 * `empty: true` + `reason` is dbvocab.mjs:660's shape, deliberately, so the two
 * vocabularies say "there was nothing here" in one way and steps/vocabulary.mjs
 * needs one reader for both.
 *
 * IT IS WRITTEN, and that is the point of it. An exit 0 that left no file would
 * leave `satisfied()` false, and the step would spend this probe again every
 * round of the run for a question whose answer cannot change mid-walk. The
 * empty arrays are the shape every reader already tolerates - fillboundaries
 * .mjs:212 (`{ errors: [] }`), providerreplay.mjs:73 (`v.errors ?? []`).
 */
export function emptyVocabulary(reason, source = null) {
  return {
    stage: "3-provider-vocabulary",
    readAt: new Date().toISOString(),
    source,
    empty: true,
    reason,
    outcomes: [],
    finishReasons: [],
    errors: [],
    outputText: null,
    inputMessages: null,
    nullRates: [],
  };
}

/**
 * Everything the gateway recorded, read from the columns the probe found.
 *
 * Each block is guarded by the column it needs. A `usage_log` without
 * `finish_reason` is still worth its outcomes and its error strings, and losing
 * all three to the one that is missing is the same all-or-nothing that made the
 * whole tool fail on a missing table. What was NOT read is named in `notRead`,
 * because a reader cannot tell an absent column from a column full of nulls.
 */
async function readRecorded({ q, n, usage, content, source }) {
  const notRead = [];

  const outcomes = (await q(
    `SELECT provider, status, count(*)::bigint AS c FROM ${USAGE_LOG} GROUP BY 1,2 ORDER BY 3 DESC`
  )).map((r) => ({ provider: r.provider, status: r.status, rows: n(r.c) }));

  let finishReasons = [];
  if (usage.has("finish_reason")) {
    finishReasons = (await q(
      `SELECT finish_reason, count(*)::bigint AS c FROM ${USAGE_LOG} GROUP BY 1 ORDER BY 2 DESC`
    )).map((r) => ({ finishReason: r.finish_reason, rows: n(r.c) }));
  } else {
    notRead.push(`finishReasons — ${USAGE_LOG} has no finish_reason column`);
  }

  // The answer a mock needs for an error arm: a REAL message, clipped.
  let errors = [];
  if (usage.has("error_message")) {
    errors = (await q(
      `SELECT provider, left(error_message, ${ERROR_CLIP}) AS message, count(*)::bigint AS c
         FROM ${USAGE_LOG} WHERE error_message IS NOT NULL
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 40`
    )).map((r) => ({
      provider: r.provider,
      rows: n(r.c),
      message: r.message,
      // Our own code raises these, not the provider - a different mock target.
      origin: /^Circuit breaker \[/.test(r.message ?? "")
        ? "this service"
        : /^\d{3} /.test(r.message ?? "")
          ? "provider http error"
          : "this service",
    }));
  } else {
    notRead.push(`errors — ${USAGE_LOG} has no error_message column`);
  }

  let outputText = null;
  if (content?.has("output_text")) {
    const [row] = await q(
      `SELECT count(*) FILTER (WHERE output_text IS NULL)::bigint AS nulls,
              count(*) FILTER (WHERE output_text = '')::bigint AS empties,
              min(length(output_text))::bigint AS min_len,
              max(length(output_text))::bigint AS max_len,
              count(*) FILTER (WHERE left(ltrim(output_text),1) IN ('{','['))::bigint AS json_shaped,
              count(*)::bigint AS rows
         FROM ${USAGE_LOG_CONTENT}`
    );
    outputText = {
      rows: n(row.rows),
      nulls: n(row.nulls),
      emptyStrings: n(row.empties),
      minLength: n(row.min_len),
      maxLength: n(row.max_len),
      jsonShaped: n(row.json_shaped),
    };
  } else {
    notRead.push(`outputText — no ${USAGE_LOG_CONTENT}.output_text to read`);
  }

  const cols = [
    "input_tokens", "output_tokens", "total_tokens", "cache_read_tokens",
    "cache_write_tokens", "cost_usd", "latency_ms", "max_tokens", "streamed",
    "temperature", "trace_id", "app_id", "endpoint", "prompt_name",
  ];
  const nullRates = [];
  for (const c of cols) {
    if (!usage.has(c)) {
      notRead.push(`nullRate for ${c} — ${USAGE_LOG} has no such column`);
      continue;
    }
    const [r] = await q(
      `SELECT count(*) FILTER (WHERE "${c}" IS NULL)::bigint AS nulls, count(*)::bigint AS tot FROM ${USAGE_LOG}`
    );
    nullRates.push({ column: c, nullRate: Number((n(r.nulls) / n(r.tot)).toFixed(4)), alwaysNull: n(r.nulls) === n(r.tot) });
  }

  let inputMessages = null;
  if (content?.has("input_messages")) {
    const messageKeys = (await q(
      `SELECT k, count(*)::bigint AS c FROM (
         SELECT jsonb_object_keys(el) AS k
           FROM ${USAGE_LOG_CONTENT}, jsonb_array_elements(input_messages) el
          WHERE jsonb_typeof(input_messages) = 'array' LIMIT 20000) s
       GROUP BY 1 ORDER BY 2 DESC`
    )).map((r) => ({ key: r.k, seen: n(r.c) }));
    inputMessages = { topLevel: "array", elementKeys: messageKeys };
  } else {
    notRead.push(`inputMessages — no ${USAGE_LOG_CONTENT}.input_messages to read`);
  }

  return {
    stage: "3-provider-vocabulary",
    readAt: new Date().toISOString(),
    source,
    guarantee:
      "SELECT only. No prompt or model output was captured - shapes, lengths, null rates and key names only. " +
      `Error messages clipped to ${ERROR_CLIP} chars.`,
    why:
      "These are real recorded outcomes, so a blocked provider row can be answered from what the service " +
      "actually observed instead of from a billed call.",
    outcomes,
    finishReasons,
    errors,
    outputText,
    inputMessages,
    nullRates,
    ...(notRead.length ? { notRead } : {}),
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const { url, from } = readUrl();
  const target = new URL(url);
  const source = { host: `${target.hostname.slice(0, 3)}…`, database: target.pathname.slice(1), urlFrom: from };
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const q = (s) => prisma.$queryRawUnsafe(s);
  const n = (v) => (typeof v === "bigint" ? Number(v) : v);

  let doc;
  try {
    // THE PROBE COMES FIRST, and every statement after it is against a table
    // this database was just observed to have.
    const shape = await tableShape(q, [USAGE_LOG, USAGE_LOG_CONTENT]);
    const usage = shape.get(USAGE_LOG) ?? null;
    const content = shape.get(USAGE_LOG_CONTENT) ?? null;
    const missing = usage ? GATEWAY_COLUMNS.filter((c) => !usage.has(c)) : [];

    if (!usage) {
      doc = emptyVocabulary(
        `${NO_PROVIDER_USAGE} — ${source.database} has no ${USAGE_LOG} table. That table is the AI ` +
          `gateway's; a service that does not route provider calls through it has nothing recorded to read, ` +
          `and derive proposes from source instead`,
        source
      );
    } else if (missing.length) {
      doc = emptyVocabulary(
        `${NO_PROVIDER_USAGE} — ${source.database} has a ${USAGE_LOG} table, but not the gateway's: no ` +
          `${missing.join(" or ")} column. Reading it would describe some other table that shares the name`,
        source
      );
    } else {
      doc = await readRecorded({ q, n, usage, content, source });
    }
  } finally {
    await prisma.$disconnect();
  }

  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);
  if (doc.empty) {
    process.stdout.write(`\n✓ provider vocabulary → ${relative(REPO_ROOT, OUTPUT)}  (EMPTY)\n    ${doc.reason}\n`);
    return;
  }
  const total = doc.outcomes.reduce((a, b) => a + b.rows, 0);
  process.stdout.write(
    `\n✓ provider vocabulary → ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    recorded calls        ${total}\n` +
      `    error rows            ${doc.outcomes.filter((o) => o.status === "error").reduce((a, b) => a + b.rows, 0)}\n` +
      `    distinct error shapes ${doc.errors.length}  (${doc.errors.filter((e) => e.origin === "provider http error").length} from the provider, ${doc.errors.filter((e) => e.origin === "this service").length} raised by this service)\n` +
      `    finish_reason values  ${doc.finishReasons.length}\n` +
      `    always-null columns   ${doc.nullRates.filter((r) => r.alwaysNull).map((r) => r.column).join(", ") || "(none)"}\n` +
      (doc.notRead ? `    not read              ${doc.notRead.join("; ")}\n` : "")
  );
}


/**
 * ONE LINE, AND NEVER AN EMPTY ONE, for whatever main() threw.
 *
 * This printed `e.message.split("\n")[0]` and Prisma error messages BEGIN WITH
 * A NEWLINE, so element 0 was the empty string: every round of run
 * 20260916T223906Z logged
 *
 *     vocabulary: providervocab.mjs exited 1 — ✗
 *
 * and nothing after the mark. Nine consecutive failures that could not be told
 * apart from "staging has no vocabulary to read", which is a legitimate and
 * completely different answer - the vocabulary step is OPTIONAL
 * (steps/vocabulary.mjs:145), so an absent file is not by itself a fault.
 *
 * TWO THINGS IT MUST NOT DO, both of which were the obvious fix:
 *
 *   print the whole message - a Prisma failure carries a multi-line stack and
 *     a schema excerpt, and steps/preflight.mjs `tail` splices the LAST FOUR
 *     non-blank lines into the step's one-line status with " · " between
 *     them. A log line that carries four stack frames is not a status any more.
 *   take [0] after a trim of the whole message - a message that is only
 *     whitespace, or a throw that is not an Error at all (`throw undefined`
 *     from an aborted socket), still has to print something a reader can act
 *     on, and "" is the defect this replaces.
 *
 * AND THE FIRST LINE ALONE WAS NOT ENOUGH EITHER — D50. That fix left the
 * header and dropped the reason, so four runs across three repos logged
 *
 *     vocabulary: providervocab.mjs exited 1 — ✗ Invalid `prisma.$queryRawUnsafe()` invocation:
 *
 * twenty-seven times, ending at the colon, and D49 went unread for four days
 * behind it. Prisma's shape is a HEADER, two blank lines, and then the whole
 * reason on one line — measured against 34…/tracy-worker on 2026-09-19:
 *
 *     "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\n" +
 *     "Raw query failed. Code: `42P01`. Message: `relation \"usage_log\" does not exist`"
 *
 * A LINE ENDING IN A COLON IS A PROMISE OF THE NEXT ONE. So a kept line that
 * ends in `:` pulls in the line after it, up to THREE, and the parts are joined
 * with `tail`'s own " · " so the result is still one line wherever it lands. A
 * line that ends in anything else is decisive and stops the walk immediately -
 * `one line only` is unchanged, and a Prisma stack still contributes no frames.
 *
 * A trailing colon with nothing behind it is dropped: the message ran out, the
 * promise cannot be kept, and `…exited 1 — ✗ something:` is the defect this
 * whole block exists to remove. `no log line ends in :` is a rule, and it is
 * held by tests/providervocab.failure-line.test.mjs.
 *
 * \r is a separator too - a message that arrived over a CRLF transport would
 * otherwise print its whole body as one "line".
 */
export function failureLine(e) {
  const lines = String(e?.message ?? e ?? "")
    .split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  const kept = [];
  for (const line of lines) {
    kept.push(line);
    // Decisive: it is not announcing something that follows it.
    if (!line.endsWith(":")) break;
    if (kept.length === 3) break;
  }

  if (kept.length) return kept.join(" · ").replace(/:$/, "");
  // Nothing sayable in the message. Name what was thrown instead of printing
  // the blank that started this.
  const named = e && typeof e === "object" && typeof e.name === "string" && e.name ? e.name : null;
  return named ? `${named} with no message` : `providervocab.mjs failed and the thrown value carried no message (${typeof e})`;
}

// Only when this file is the ENTRY POINT.
//
// 26 of the 40 tools here executed on import, so a tool that wanted to reuse
// another's helper triggered a full run of it instead - which happened three
// times in one session: importing exec.mjs to read one function overwrote
// exec-rows.json, importing record.mjs to check it loaded started a 366-row
// recording, and importing diversity.mjs for its shape signature ran the whole
// census AND consumed the caller's own --json argument.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main) {
  main().catch((e) => { process.stderr.write(`\n✗ ${failureLine(e)}\n`); process.exit(1); });
}