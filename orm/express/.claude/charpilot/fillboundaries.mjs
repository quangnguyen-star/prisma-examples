/**
 * Answer the endpoints a proposal actually reaches but never declared.
 *
 * 76 rows blocked on a default-deny endpoint. The scan's per-function boundary
 * list does not help: only 19 of the 76 have an undeclared boundary anywhere in
 * their own chain, and most of those are TYPES, not mockable symbols. The call
 * happens deeper - `v4-anthropic-closure-failure-without-messages` declares
 * AnthropicAIModelV1 correctly and still hits prisma.usageLog, because the
 * closure calls persistUsage which calls recordUsage which calls prisma.
 *
 * So the boundary is chosen by the ENDPOINT the recorder observed, not by
 * walking the chain. Every answer below is either a real recorded value from
 * out/provider-vocab.json (17,136 staging calls, 220 of them errors) or a spy
 * where the call itself is the observable - never an invented payload, and
 * never a real provider call.
 *
 * Dry-run by default. `--write` to apply.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { OUT_DIR, PROPOSALS_DIR, REPO_ROOT } from "./config.mjs";

const WRITE = process.argv.includes("--write");
const BEHAVIOUR = join(OUT_DIR, "behaviour.json");
const VOCAB = join(OUT_DIR, "provider-vocab.json");

/**
 * endpoint the guard reported  ->  the boundary that intercepts it.
 *
 * `answerFor(arm)` picks resolve-vs-reject from the proposal itself: an id
 * naming a failure wants the provider to reject, and the rejection value is a
 * REAL recorded error string rather than a plausible-looking one.
 */
const MAP = [
  {
    match: /prisma\.usageLog/,
    symbol: "recordUsage",
    module: "@/services/usageLog.service",
    // usageLog.service.ts:14 — `export function recordUsage(input): void`, and
    // the comment at getAiModelV1.service.ts:219 says it never blocks or throws.
    // The observable IS the call, so a spy is the honest answer; resolving a
    // value would invent a return this function does not have.
    // NOT a spy. `spy` wraps the real export and calls THROUGH, so recordUsage
    // still reached prisma.usageLog. `returns undefined` matches its real
    // signature (usageLog.service.ts:14 returns void), records the call in the
    // call list identically, and stops there.
    mock: () => ({ kind: "returns", build: "undefined" }),
    why: "recordUsage returns void; replaced rather than spied, because a spy calls through to prisma.usageLog",
  },
  {
    // Must precede the /prisma\.apiKey/ rule: `apiKeyFallback` contains
    // `apiKey`, so the looser pattern would swallow it and answer the wrong
    // boundary. Appeared only once the provider classes ran for real - the
    // fallback lookup is inside them.
    match: /prisma\.apiKeyFallback/,
    symbol: "getFallbackKey",
    module: "@/services/fallbackKey.service",
    mock: () => ({ kind: "resolves", build: "null" }),
    why: "fallbackKey.service.ts:20 - resolves null, the shape for no fallback configured",
  },
  {
    match: /prisma\.apiKey/,
    symbol: "getApiKey",
    module: "@/services/apiKey.service",
    mock: (p) => ({ kind: "resolves", build: `doubles.apiKeyRow(${JSON.stringify(providerOf(p))})` }),
    why: "the credential lookup, answered with the shape a real api_key row has",
  },
  {
    match: /prisma\.cachedLangfusePrompt/,
    symbol: "prisma",
    module: "@/prisma",
    // The decorator itself has to stay real - the arms under test are inside
    // it - so the answer goes one level lower, at the client it reads through.
    // An object-shaped boundary answered with `returns` REPLACES the export, so
    // every model method below is served from here and none reaches a socket.
    // A plain object, NOT doubles.stub: prisma is read by property
    // (`prisma.cachedLangfusePrompt.findFirst()`), and stub would make each
    // model a function that returns the methods rather than holding them.
    mock: () => ({
      kind: "returns",
      build:
        "({ cachedLangfusePrompt: { findFirst: async () => null, findUnique: async () => null, " +
        "create: async () => ({}), upsert: async () => ({}), updateMany: async () => ({ count: 0 }), " +
        "deleteMany: async () => ({ count: 0 }) } })",
    }),
    why: "the prompt cache decorator stays real so its arms run; its prisma reads are answered here",
  },
  {
    match: /api\.anthropic\.com/,
    symbol: "AnthropicAIModelV1",
    module: "@/models/anthropicAIModel",
    mock: (p, v) => providerAnswer(p, v, "ANTHROPIC"),
    why: "the Anthropic client, answered from a recorded outcome",
  },
  {
    match: /api\.openai\.com/,
    symbol: "OpenAIModelV1",
    module: "@/models/openAIModelV1",
    mock: (p, v) => providerAnswer(p, v, "OPENAI"),
    why: "the OpenAI client, answered from a recorded outcome",
  },
  {
    match: /hooks\.slack/,
    symbol: "getLangfuseWithKey",
    module: "@/services/langfuse.service",
    // NOT a spy. `spy` wraps the real export and calls through, so it posts to
    // the real channel - the opposite of the intent. loggerV2.ts:160 calls
    // SlackService.getInstance().sendMessage(), so the replacement answers that
    // shape and the call is still recorded in the call list.
    mock: () => ({ kind: "resolves", build: "doubles.langfuseResolution({ provider: \"OPENAI\" })" }),
    why: "prompt.ts:1 reaches the webhook through getLangfuseWithKey, which imports sendSlackNotification; answered below the arm",
  },
  {
    match: /redis\./,
    symbol: "redisCache",
    module: "@/services/redis.service",
    mock: () => ({ kind: "returns", build: "doubles.redisCacheStub({ get: { resolves: null } })" }),
    why: "redis resolves to a cluster-internal address unreachable from here, and the repo owner ruled it mocked",
  },
  {
    // Tried after the service-function rules: those intercept the wrapper, and
    // when a row still reaches prisma the call is deeper than the wrapper, so
    // only the client can answer it. A PLAIN OBJECT, because prisma is read by
    // property (prisma.apiKey.findMany()) - doubles.stub would make each model
    // a function returning the methods instead of holding them.
    match: /^prisma\./,
    symbol: "prisma",
    module: "@/prisma",
    mock: () => ({
      kind: "returns",
      build:
        "({ apiKey: { findMany: async () => [], findUnique: async () => null, findFirst: async () => null }, " +
        "apiKeyFallback: { findFirst: async () => null, findUnique: async () => null }, " +
        "defaultModelKey: { findUnique: async () => null }, " +
        "cachedLangfusePrompt: { findFirst: async () => null, findUnique: async () => null, create: async () => ({}), " +
        "upsert: async () => ({}), updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) }, " +
        "modelPricing: { findUnique: async () => null }, " +
        "usageLog: { create: async () => ({ id: doubles.FIXED_UUID }) }, " +
        "usageLogContent: { create: async () => ({}) }, " +
        "$transaction: async (fn) => (typeof fn === \"function\" ? fn({ usageLog: { create: async () => ({ id: doubles.FIXED_UUID }) }, " +
        "usageLogContent: { create: async () => ({}) } }) : []) })",
    }),
    why: "the client itself; the row reaches prisma deeper than any service wrapper it already answers",
  },
  {
    match: /langfuse/,
    symbol: "Langfuse",
    module: "langfuse",
    // langfuse.service.ts:2 - the SDK client. Answering the SERVICE instead
    // would skip the arms inside it, which is the mistake the provider wrappers
    // already taught: mock below the code under test, never at it.
    mock: () => ({
      kind: "returns",
      build:
        "doubles.stub({ getPrompt: { resolves: { prompt: \"charpilot\", config: {}, compile: () => \"charpilot\" } }, " +
        "flushAsync: { resolves: undefined }, shutdownAsync: { resolves: undefined } })",
    }),
    why: "the langfuse SDK client; the service keeps its own branches while nothing reaches cloud.langfuse.com",
  },
];

const providerOf = (p) =>
  /anthropic/i.test(p.id) ? "ANTHROPIC" : /vertex|gemini/i.test(p.id) ? "VERTEXAI" : /openai/i.test(p.id) ? "OPENAI" : null;

/** Which method of the model class the arm goes through. */
const methodOf = (p) =>
  /toolsv4|withtoolsv4/i.test(p.id) ? "invokeWithToolsV4"
    : /tools/i.test(p.id) ? "invokeWithTools"
      : /stream/i.test(p.id) ? "stream"
        : "invoke";

function providerAnswer(p, vocab, provider) {
  const fails = /fail|error|reject|throw|non-error/i.test(p.id);
  const method = methodOf(p);
  if (!fails) {
    return { kind: "returns", build: `doubles.stub({ ${method}: { resolves: "charpilot output" } })` };
  }
  // A REAL recorded error for this provider, preferring one the provider itself
  // returned over one this service raised - the latter is a different arm.
  const real = (vocab.errors ?? [])
    .filter((e) => e.provider === provider && e.origin === "provider http error")
    .sort((a, b) => b.rows - a.rows)[0]
    ?? (vocab.errors ?? []).filter((e) => e.provider === provider).sort((a, b) => b.rows - a.rows)[0];
  const message = real?.message ?? "provider request failed";
  return {
    kind: "returns",
    build: `doubles.stub({ ${method}: { rejects: new Error(${JSON.stringify(message)}) } })`,
    recordedRows: real?.rows ?? 0,
  };
}

/**
 * A guard on this generator itself. `spy` and `notCalled` mean "observe" - they
 * do not intercept - so emitting one for a boundary that exists BECAUSE the row
 * hit a default-deny endpoint is self-defeating. This has now been written
 * wrong three times (recordUsage, SlackService, five SDKs), so it is checked
 * rather than remembered.
 */
function assertIntercepts(symbol, mock, endpoint) {
  if (mock.kind === "spy" || mock.kind === "notCalled") {
    throw new Error(
      `rule for ${endpoint} answers ${symbol} with "${mock.kind}", which calls through to the endpoint it is meant to stop`
    );
  }
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(BEHAVIOUR)) throw new Error("no behaviour.json - run the recorder first");
  const beh = JSON.parse(readFileSync(BEHAVIOUR, "utf8"));
  const vocab = existsSync(VOCAB) ? JSON.parse(readFileSync(VOCAB, "utf8")) : { errors: [] };

  const blocked = new Map(
    (beh.skipped ?? [])
      .filter((s) => /blocked egress/.test(s.reason))
      .map((s) => [s.id, s.reason.replace(/^blocked egress: /, "").split(" - ")[0].trim()])
  );

  const files = readdirSync(PROPOSALS_DIR).filter((f) => f.endsWith(".json"));
  const added = [];
  const unmapped = [];
  for (const file of files) {
    const path = join(PROPOSALS_DIR, file);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    const rows = doc.proposals ?? doc;
    let changed = false;
    for (const p of rows) {
      const endpoint = blocked.get(p.id);
      if (!endpoint) continue;
      const rule = MAP.find((m) => m.match.test(endpoint));
      if (!rule) { unmapped.push({ id: p.id, endpoint }); continue; }
      p.boundaries ??= {};
      if (p.boundaries[rule.symbol]) { unmapped.push({ id: p.id, endpoint, note: `${rule.symbol} already declared` }); continue; }
      const mock = rule.mock(p, vocab);
      assertIntercepts(rule.symbol, mock, endpoint);
      p.boundaries[rule.symbol] = {
        behaviour: rule.why,
        // Named explicitly: the call is deeper than the owner file's imports, so
        // the scan's import map cannot resolve this symbol on its own.
        module: rule.module,
        mock,
        from: {
          arm: (p.covers ?? ["?"])[0],
          evidence: mock.recordedRows
            ? `usage_log via out/provider-vocab.json (${mock.recordedRows} recorded rows with this error)`
            : "out/provider-vocab.json",
          reading:
            `the recorder observed this row reach ${endpoint}, which no boundary answered, so the call was ` +
            `refused and nothing was recorded. Answered here from what this service has already observed in ` +
            `staging - never from a real provider call.`,
        },
      };
      delete p.boundaries[rule.symbol].mock.recordedRows;
      added.push({ id: p.id, endpoint, symbol: rule.symbol, kind: mock.kind });
      changed = true;
    }
    if (changed && WRITE) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }

  const byRule = {};
  for (const a of added) byRule[`${a.endpoint} → ${a.symbol} (${a.kind})`] = (byRule[`${a.endpoint} → ${a.symbol} (${a.kind})`] ?? 0) + 1;
  process.stdout.write(
    `\n${WRITE ? "✓ applied" : "· DRY RUN (pass --write to apply)"}\n` +
      `    blocked rows        ${blocked.size}\n` +
      `    boundaries added    ${added.length}\n` +
      `    not added           ${unmapped.length}\n`
  );
  for (const [k, v] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`      ${String(v).padStart(3)}  ${k}\n`);
  }
  for (const u of unmapped.slice(0, 6)) process.stdout.write(`      skip: ${u.id} — ${u.note ?? u.endpoint}\n`);
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
  main();
}