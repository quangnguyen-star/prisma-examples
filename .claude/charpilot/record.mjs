#!/usr/bin/env node
/**
 * Stage 4 - record mode.
 *
 * Runs each stage-3 input and records what the service ACTUALLY did. The rule
 * that makes this worth anything: the proposal's `boundaries[].behaviour` is a
 * PLAN for what to observe. This script must overwrite it with an observation,
 * never confirm it. A recorded pair that merely echoes the plan proves nothing.
 *
 *   node .claude/charpilot/record.mjs [--env-file <path>] [--only <id-substring>]
 *                                    [--chunk <n>] [--fresh] [--plan]
 *                                    [--row-timeout <ms>]
 *
 * Writes out/behaviour.json - one row per proposal:
 *   { id, invoked, returned | threw, console, boundaryCalls, durationMs, source }
 *
 * A row is written ONLY when the call actually ran. A proposal the harness
 * cannot execute is reported as `skipped` with the reason, and NEVER given a
 * placeholder row - a stalled recorder must be a stop, not a shrug.
 *
 * ## Why this runs in chunks, with a cache
 *
 * Every row does `vi.resetModules()` and then re-imports the subject, which on
 * this service means re-importing langchain, the OpenAI client and prisma. A
 * single 287-row vitest invocation blew a 600s timeout and produced NOTHING -
 * all-or-nothing is the worst possible shape for a recorder. So rows are run in
 * chunks, each chunk's results are merged into `out/.record-cache.json` as soon
 * as it finishes, and a later run picks up where the last one stopped. The cache
 * is stamped with a hash of this script + the fixtures + the vitest config, so a
 * harness change invalidates it rather than silently serving stale observations
 * (a real check reading a stale input is the bug class this pilot keeps hitting).
 */
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { modeStamp } from "./targets.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

import {
  armIndexFromScan,
  claimedSides,
  nonBranchReason,
  sideIndexOf,
  hitIndexFromSkeleton,
  measureArms,
} from "./armjoin.mjs";
import {
  BASELINE_JSON,
  BEHAVIOUR_JSON,
  CONFIG_DIR,
  FIXTURES_DIR,
  OUT_DIR,
  PILOT_DIR,
  PROPOSALS_DIR,
  REPO_ROOT,
  SCAN_JSON,
  TARGET_ROOT,
  WORKLIST_JSON,
  assertExpectedDb,
  CORPUS_SUFFIX,
  isCorpusSpec,
  databasePlaceholder,
  isDatabaseVar,
  maskDatabaseEnv,
  SRC_ROOT,
  isSrcExcluded,
  emitterDigest,
  INCREMENTAL_RECORD,
  CORPUS_REL,
  TSCONFIG,
} from "./config.mjs";
// Which of the repo's files a row depends on, and whether they moved (6b).
import { changedSince, legacyChanged, packageMoved, rootsOf, sourceGraph, stampChanged, stampOf } from "./sourcedeps.mjs";
// The mocked-mode stand-ins for env vars the service needs and nobody supplied.
// ONE plan, applied by buildEnv (the recording) and by the emit (recorded.env
// and the per-spec prelude), so the suite replays under the env it was recorded
// under. See standins.mjs.
import { isStandIn, planStandIns, standInLines } from "./standins.mjs";
// One error message here lists a closure's parameter NAMES, and a name is the
// whole binding pattern - defaults included. Same sanitiser as the briefs.
import { paramName } from "./novalues.mjs";
// ONE env-file reader for every loader (tool backlog). See envfile.mjs.
import { envNames, parseEnvText, placeholderCiphertext, placeholderPem } from "./envfile.mjs";
// The ONE rule in this toolset for turning a thrown value into one printable
// line - D50, D59. Not a copy of it: `problemLine` below is the only caller
// here and it adds nothing but the case that rule answers in providervocab's
// own name. providervocab.mjs runs nothing on import (`import.meta.main`).
import { failureLine } from "./providervocab.mjs";
import { hostSetup, setupUndoLines } from "./hostsetup.mjs";
import { BOOTSTRAP_MARKER, REPLAY_TEST_ENV, aliasSource } from "./resolution.mjs";
import { liveDecision } from "./stagingenv.mjs";
// D54: the Node the repo's CI runs, which runs the target here too (cinode.mjs).
import { targetNode, targetNodeLine } from "./cinode.mjs";
// D55: the emitted spec carries no absolute repo root (rootfree.mjs).
import { rootFree } from "./rootfree.mjs";
import { partCount, specsOfKey, splitBytes, splitRows } from "./specsplit.mjs";
import { loadTimeoutWithhold } from "./vitestred.mjs";
import {
  environmentCause,
  environmentDefect,
  environmentFailures,
  environmentFixed,
  environmentWhat,
  failedOnPlaceholder,
  placeholderRowsAreStale,
} from "./prismaclient.mjs";
import { credentialShaped } from "./secrets.mjs";
import { SHARD_BYTES, landRecorded, readRecorded, renderRecorded, writeRecorded } from "./recordedstore.mjs";
// The ONE reader of proposals/, so stage 3's `functionBoundaries` merge and
// stage 4's arrangement cannot disagree. Import only - validate.mjs runs
// nothing on import (`import.meta.main`), which the gate's `tools-parse` check
// depends on for every tool here.
import { awaitOutsideAsync, loadProposals, moduleScopeFunctions, resolveFunctionId, resolveVia, staleFunctionIdReason } from "./validate.mjs";

const ARGV = process.argv.slice(2);
const arg = (flag) => (ARGV.includes(flag) ? ARGV[ARGV.indexOf(flag) + 1] : undefined);
const ONLY = arg("--only");
/**
 * Stage 1 wrote the environment. Stage 4 should USE it without being told.
 *
 * Measured on run 20260908T222433Z: stage 1 resolved staging correctly at 80
 * seconds - mounted qode-iac, manifests parsed, the cluster-internal DSN
 * rewritten to its external address, out/staging.env written - and then the
 * agent ran a bare `node record.mjs`. No --env-file, no --live. All 108 rows
 * recorded `envProvenance: process-env-only`, every boundary mocked, exactly
 * like the run before it that had no environment at all.
 *
 * The capability existed and nothing compelled its use. That is the same shape
 * as `--fields` (documented nowhere, used zero times) and the stage-3 clock
 * (visible, ignored 18 times), and the cheapest cure is the same: make the
 * right thing the default rather than an argument someone has to remember.
 *
 * An explicit --env-file still wins, and `--no-env-file` opts out - the opt-out
 * exists because "recorded against the ambient shell" is a legitimate choice
 * and has to stay sayable, just not by accident.
 */
function defaultEnvFile() {
  if (ARGV.includes("--no-env-file")) return undefined;
  const explicit = arg("--env-file");
  if (explicit) return explicit;
  const resolved = join(OUT_DIR, "staging.env");
  return existsSync(resolved) ? resolved : undefined;
}
const ENV_FILE = defaultEnvFile();

/**
 * A NUMERIC FLAG THAT IS NOT A NUMBER IS REFUSED HERE, NOT ABSORBED.
 *
 * `Number(...)` turns every typo into a value this tool then runs on.
 * `--chunk 0` makes `for (… i += CHUNK)` an INFINITE LOOP, and `--chunk two`
 * makes CHUNK `NaN`, which produces exactly one empty chunk: the run prints
 * "running 47 in 1 chunk(s)", records zero rows and exits 0. `--row-timeout
 * 30s` is the same shape one stage further on — `NaN` is baked into
 * `harnessVersion()` and written into every emitted spec, so every row times
 * out instantly at stage 5 and the failures surface as FALSE claims that blame
 * the stage-3 input. A run that reports success and produced nothing is the
 * most expensive answer this pipeline can give: run 20260918T073111Z
 * (qode-ptp-ms) closed 865 of 865 sides in 7 rounds and wrote no result.json,
 * and it took a person to notice.
 *
 * Refused rather than defaulted, because a typo silently replaced by 16 is a
 * run that did not do what its command line says it did. The exit code is 2,
 * the one validate.mjs already uses for an argument it cannot read, so a walk
 * can tell a bad command line from a failed recording.
 */
function integerFlag(flag, fallback, what) {
  const raw = arg(flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `✗ record.mjs: ${flag} ${JSON.stringify(raw ?? null)} is not a whole number of ${what}.\n` +
        `  It must be an integer of at least 1. ${flag} was read as ${JSON.stringify(n)}, which this run would\n` +
        `  have used silently.\n`
    );
    process.exit(2);
  }
  return n;
}
const CHUNK = integerFlag("--chunk", 16, "rows per chunk");
const FRESH = ARGV.includes("--fresh");
/**
 * A LIST OF ROW IDS, as `<id>,<id>` or `@<file>` (a JSON array, or one id a
 * line). `@` because cigate can find a hundred rows red, and a hundred ids is a
 * command line nobody should have to read.
 */
function idsFlag(flag) {
  const raw = arg(flag);
  if (raw === undefined) return null;
  let ids;
  try {
    const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
    ids = text.trim().startsWith("[") ? JSON.parse(text) : text.split(/[\n,]/);
  } catch (err) {
    process.stderr.write(`✗ record.mjs: ${flag} ${JSON.stringify(raw)} could not be read - ${err.message}\n`);
    process.exit(2);
  }
  return new Set(ids.map((i) => String(i).trim()).filter(Boolean));
}
/**
 * `--rerecord <ids>`: RECORD THESE ROWS AGAIN IF ANOTHER TOOLSET RECORDED THEM
 * (item 6b). The cigate path's half of the cache key: a row the emitted suite
 * found red under the tools installed now, whose cached recording another
 * toolset made (`__recordedBy`), is evicted and recorded under this one before
 * anything withholds it. A red row THIS toolset recorded is left as it is:
 * recording it again would observe the same thing, and it is withheld.
 * Everything else in the run is an ordinary recording - the artifact stays
 * whole, every other row is served as usual.
 */
const RERECORD = idsFlag("--rerecord");
/**
 * `--ids <ids>`: RECORD ONLY THESE ROWS, into an artifact of their own. The
 * second observation determinism.mjs takes of the rows that carry no verdict
 * (item 6): a row whose recording was reused keeps the verdict it was stamped
 * with, so only new or re-recorded rows are observed twice. Refused without
 * CHARPILOT_OUTPUT: a narrowed run must never land on the artifact a full run
 * wrote, the rule `--only` keeps with a file name of its own.
 */
const ONLY_IDS = idsFlag("--ids");
if (ONLY_IDS && !process.env.CHARPILOT_OUTPUT) {
  process.stderr.write("✗ record.mjs: --ids narrows the recording, so it writes only where CHARPILOT_OUTPUT points - never over behaviour.json\n");
  process.exit(2);
}
/** Overwrite an artifact holding rows this run will not produce. See guardOutput. */
const OVERWRITE = ARGV.includes("--overwrite");
const PLAN_ONLY = ARGV.includes("--plan");
const KEEP_SPEC = ARGV.includes("--keep-spec");
/**
 * Stage 5 has to re-run the recorded rows under istanbul to find out whether a
 * proposal's `reaches` claim is TRUE. It cannot: recording writes one spec to a
 * fixed path, overwrites it per chunk and deletes it, so only the last chunk
 * ever survived. `--emit-specs <dir>` writes one spec per chunk and exits
 * without running vitest - specs to measure, not observations to record.
 */
const EMIT_SPECS = arg("--emit-specs");
/**
 * Stage 5 - write the TESTS. Same per-row arrangement as a recording (same
 * mocks, same env, same egress denial), but the row's recorded outcome becomes
 * an assertion instead of a value to capture. Driven by --emit-tests, which
 * owns the policy of which rows qualify.
 */
const EMIT_TESTS = arg("--emit-tests");
// Loopback is always open so a local stub (mountebank) can answer a provider.
// Anything else - api.openai.com, api.anthropic.com, *-aiplatform.googleapis.com,
// hooks.slack.com - has to be named here on purpose, per run, and preflight
// lists all four as forbidden.
/**
 * Hosts stage 4 may reach, from the flag OR from the environment.
 *
 * The env path exists because docker/run.env is the dominant way this pipeline
 * is driven and a flag cannot be set from there. Stage 4's contract is to run
 * against REAL downstream - the recorded response is what stage 5 turns into
 * the test's mock - so the hosts a service legitimately calls have to be
 * expressible per target. `LIVE_HOSTS` below is ai-centralization's set, baked
 * in, and that is exactly the per-repo-fact-in-the-tool problem the hard-coded
 * database triple used to have.
 *
 * Still default-deny: nothing here is implicit, every host is named by someone,
 * and the row records a refusal for anything not listed. zipkin, redis and
 * slack stay unlisted on purpose - they are the three doubled at record time.
 */
/**
 * The allowlist DERIVES from the resolved staging environment first, and only
 * then from anything a person typed.
 *
 * A hand-maintained list is the wrong shape for this: a host named by the
 * service's own staging ConfigMap or Secret is, by definition, a host this
 * service talks to in staging — allowing it is not a judgement, it is reading
 * stage 1's answer. What the config does NOT name stays denied, and that is the
 * half that protects: a provider the code reaches for but staging never
 * configured is precisely the unauthorised call.
 *
 * `--allow-host` and `CHARPILOT_ALLOW_HOSTS` remain, for a host that is real
 * and deliberately outside the manifests. They ADD; they are no longer the
 * only source.
 */
function stagingAllowHosts() {
  const hosts = [];
  // 1. named by the staging ConfigMap or Secret, post ingress-swap.
  try {
    const p = join(OUT_DIR, "staging-env.json");
    if (existsSync(p)) {
      const r = JSON.parse(readFileSync(p, "utf8"));
      // Older artifacts predate `allowHosts`; fall back to the per-var hosts so
      // a stale staging-env.json degrades to the same answer, not to none.
      hosts.push(
        ...(Array.isArray(r.allowHosts)
          ? r.allowHosts
          : Object.values(r.vars ?? {}).map((v) => v && v.host).filter(Boolean))
      );
    }
  } catch {
    /* an unreadable artifact contributes nothing; --allow-host still applies */
  }
  // 2 and 3. a default staging never overrides, and a URL written into src.
  // Measured on location-ms: `maps.googleapis.com` and `places.googleapis.com`
  // are named by neither the ConfigMap nor a default — only by
  // googleMap.service.ts — so a config-only allowlist denies the single
  // downstream that service exists to call.
  try {
    const p = join(OUT_DIR, "baseline.json");
    if (existsSync(p)) {
      const b = JSON.parse(readFileSync(p, "utf8"));
      hosts.push(...(b.egressHosts?.fromDefaults ?? []), ...(b.egressHosts?.fromSource ?? []));
    }
  } catch {
    /* same */
  }
  return hosts;
}
/**
 * Hosts an OPERATOR opened, by typing them. Nothing derived.
 *
 * stagingAllowHosts() used to be spread in here, and ALLOW_HOSTS is not gated
 * on LIVE - only LIVE_HOSTS and PROVIDER_HOSTS are - so a MOCKED run opened
 * every host named by the staging ConfigMap, by a default, or SCRAPED OUT OF THE
 * SERVICE'S OWN SOURCE. On location-ms that allowlist reads
 *
 *   34.143.159.14, jaeger-service.monitoring, development.ustra.ai,
 *   maps.googleapis.com, places.googleapis.com,
 *   qode-communication.communication.azure.com, qode.world
 *
 * in a run nobody asked to go anywhere. Together with policy.mjs answering an
 * unnamed symbol `real`, a mocked run on any repo the policy table does not
 * describe calls the live internet - measured here: `fetch` reached
 * places.googleapis.com with `blocked egress 0` and recorded the reply as the
 * service's behaviour.
 *
 * A mocked run exists to establish reachability and freeze the deployed code's
 * behaviour against doubles. A real call inside one is not a bonus, it is the
 * recording being of something else.
 *
 * So the derived hosts moved to the point of use and are gated on LIVE. These
 * two stay ungated because a person typed them for this run, which is the one
 * kind of allowance that is never accidental.
 */
const ALLOW_HOSTS = [
  ...(arg("--allow-host") ?? "").split(","),
  ...(process.env.CHARPILOT_ALLOW_HOSTS ?? "").split(","),
]
  .map((h) => h.trim())
  .filter(Boolean);
/**
 * The per-row budget, and it belongs to the RECORDING run only.
 *
 * A recording is where this number is an input: the operator chooses it, and
 * every row it produces is stamped with it (`out.rowTimeoutMs`). Every LATER
 * consumer - `--emit-tests` here, `determinism.mjs`'s second observation - must
 * read it back off the rows instead of taking it from its own command line. See
 * `recordedRowTimeout`; the flag was re-typed at all three, so the three could
 * disagree, and the one that lost was always the one nobody typed.
 */
export const DEFAULT_ROW_TIMEOUT_MS = 10_000;
// REFUSED BY THE SAME RULE AS `--chunk`, and for a defect that travels further:
// this number is baked into `harnessVersion()` and stamped onto every row and
// every emitted spec, so `--row-timeout 30s` writes `ROW_TIMEOUT_MS = NaN` into
// the generated suite and every row times out instantly two stages later. Those
// failures arrive at stage 6 as FALSE claims, which the invariants define as a
// stage-3 input to repair — so the cost of one unreadable flag is a round of
// people repairing inputs that were never wrong. `resolveRowTimeout` already
// refuses a non-finite budget on the artifact side; this is the same refusal on
// the side that writes it.
const ROW_TIMEOUT_MS = integerFlag("--row-timeout", DEFAULT_ROW_TIMEOUT_MS, "milliseconds");
/** Was the flag TYPED, as opposed to defaulted - the emit path needs the difference. */
const ROW_TIMEOUT_GIVEN = ARGV.includes("--row-timeout");

/**
 * LIVE mode - real traffic against real staging, recorded so the response can
 * later be replayed through vi.mock or a mountebank imposter.
 *
 *   --live            open staging Postgres and Langfuse; prisma stops being
 *                     default-denied, so a real api_key row supplies real
 *                     credentials. This is what makes a real provider call
 *                     possible at all: staging's env carries NO provider keys
 *                     (only SLACK_HOOK and the two DATABASE_URLs) - every
 *                     credential lives in api_key.openai_api_keys /
 *                     anthropic_api_keys / google_keys.
 *   --live-providers  additionally drop the proposals' own answers for the
 *                     provider clients and the credential lookup, so the real
 *                     SDK runs against the real endpoint. THIS BILLS. Each row
 *                     is one request; the row cache means a captured row is
 *                     never re-billed unless --fresh is passed.
 *
 * Slack is NOT opened by either: hooks.slack.com posts to a real channel, so it
 * stays behind an explicit --allow-host.
 */
/**
 * Stage 4's boundary policy - see policy.mjs. `--policy real-except-cache`
 * makes the DATABASE AND EVERY DOWNSTREAM REAL and leaves exactly two things
 * mockable: Slack, because posting is not reversible, and Redis, because it
 * has no route from here. Redis is answered at `ioredis` and always MISSES, so
 * the real cache service and the real decorator run and the query below them
 * actually happens.
 *
 * Without it a proposal's own declaration stands, which is how 35 rows came to
 * claim an arm they could not reach: a canned cache answer returned before the
 * arm ran.
 */
// THE DEFAULT IS THE POLICY, because the flag is what nobody types.
//
// This defaulted to "as-declared", and both switches below are false under it,
// so the classification block never ran and EVERY boundary was answered by the
// proposal's own value - including under --live, where the artifact then stamps
// `"live": true` over a run that reached nothing. Measured on location-ms: 265
// boundary calls, every one a hand-written double, 62 prisma and 94 fetch.
//
// A default that silently turns a live run into a mocked one is not a default,
// it is a trapdoor. Stage 4's purpose is that the code decides the output, so
// the default is now the policy that lets it: the seam is cut at the right
// level and nothing a real call could answer is answered by a proposal.
// `--policy as-declared` remains, for deliberately re-recording an old corpus,
// and the artifact records which policy produced it.
const POLICY = arg("--policy") ?? "real-except-cache";
/**
 * Three independent switches, because they answer to different constraints.
 *
 *   MOCK_AT_IOREDIS / MOCK_AT_AXIOS - "answer the boundary at the right LEVEL".
 *     Pure corrections to where the seam is cut, and they hold whether or not
 *     the run is live. They are what the OFFLINE suite needs: the offline
 *     suite is what stage 6 measures, and a canned `withCache` answer there
 *     returns before the arm runs just as surely as it does live.
 *
 *   REAL_DOWNSTREAM - "answer nothing that a real call could answer". Requires
 *     --live, because without it the real call hits a denied endpoint.
 *
 * They were one flag first, which meant the two level corrections were only
 * available in a live run - and a live run's rows are deliberately not what
 * stage 5 writes tests from, so the corrections could not reach the number
 * they were correcting.
 */
const MOCK_AT_IOREDIS = POLICY === "real-except-cache" || POLICY === "right-level";
// AXIOS IS NOT ANSWERED. It is a transport, not an endpoint - see
// SLACK_MOCK_POINT. Slack is refused at hooks.slack.com by the egress guard,
// which is exact; silencing axios would delete a repo's real downstream with it.
const MOCK_AT_AXIOS = false;
// REAL_DOWNSTREAM is declared BELOW, beside LIVE, because it depends on it.
// See the note there.

/**
 * Stage 4 records against REAL staging - that is the stage's purpose. The
 * committed suite then replays what was recorded (see hermeticise()), so this
 * is the only run that ever touches staging.
 *
 * A DEFAULT rather than a flag, because a capability nothing compels goes
 * unused. Measured three times today: `--fields` (0 uses until documented), the
 * stage-3 clock (visible, ignored 18 times), and `out/staging.env` (written by
 * stage 1, never read by stage 4 - so 108 rows recorded `process-env-only`
 * against a correctly resolved environment).
 *
 * SAFETY IS THE GATE. Live is enabled only when all three hold:
 *   1. out/staging-env.json exists with state `resolved`
 *   2. CHARPILOT_EXPECTED_DB is set
 *   3. it matches the resolved DSN's host:port/database EXACTLY
 *
 * The triple is the check that matters: one staging credential in this fleet
 * reaches any service's database by swapping the name, and one host serves a
 * production database on a neighbouring port (5434 staging, 5435 production).
 * A mismatch is not a warning - live stays off, the reason is printed, and the
 * run records against denied boundaries rather than the wrong database.
 *
 * `--live` forces it on, `--no-live` forces it off.
 */
const LIVE_DECISION = liveDecision({ outDir: OUT_DIR, argv: ARGV });

const LIVE = LIVE_DECISION.live;
// GATED ON LIVE, because a mocked run that still bills a provider is not a
// mocked run. `--live-providers` is typed by the agent and read straight off
// argv, so CHARPILOT_MODE=mocked - which is the operator saying what this run is
// for - would have selected doubles for the database and the ordinary
// downstream while real LLM calls went out and were charged.
const LIVE_PROVIDERS = LIVE && ARGV.includes("--live-providers");

/**
 * GATED ON LIVE, which is what the switch's own description said all along and
 * the code did not do.
 *
 * The comment beside MOCK_AT_IOREDIS above states the contract exactly:
 * "REAL_DOWNSTREAM - 'answer nothing that a real call could answer'. Requires
 * --live, because without it the real call hits a denied endpoint." It was
 * `POLICY === "real-except-cache"` and nothing more, so in a MOCKED run - where
 * the default policy still applies, because the default is the policy - a
 * classify() verdict of `real` dropped the proposal's own declared double for
 * `prisma`, `OpenAI`, every downstream, and substituted `kind: "live"` against
 * a database that is not reachable. There is no real call for a mocked run to
 * defer to; deferring to it is answering the boundary with nothing.
 *
 * The workaround was to type `--policy as-declared` on every mocked run, which
 * turns off the two LEVEL corrections as well - and those are mode-independent
 * by design, because a canned `withCache` answer returns before the arm runs in
 * either mode. So the price of stopping the wrong thing was also stopping the
 * right one, per run, by hand, and the artifact then recorded a policy nobody
 * meant to choose.
 *
 * MOCK_AT_IOREDIS deliberately stays ungated: it is a statement about WHERE the
 * seam is cut, not about what is reachable.
 */
const REAL_DOWNSTREAM = LIVE && POLICY === "real-except-cache";

/** Hosts --live opens: staging's DB is not HTTP, so this is Langfuse + providers. */
const LIVE_HOSTS = [
  "langfuse.qode.world",
  "cloud.langfuse.com",
];
const PROVIDER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "oauth2.googleapis.com",
  "aiplatform.googleapis.com",
];

/**
 * The boundaries --live-providers leaves REAL. Everything else the proposal
 * declared still answers as declared: a live run is not "mock nothing", it is
 * "let the provider path reach the provider". `getApiKey`/`withCache`/`prisma`
 * are in here because a real request needs a real credential, and the
 * credential is a DB read.
 */
const LIVE_SYMBOLS = new Set([
  "getApiKey", "withCache", "prisma",
  "OpenAI", "Anthropic", "JWT", "CallbackHandler",
  "OpenAIModelV1", "AnthropicAIModelV1", "VertexAIModelV1",
  "getLangfuseWithKey", "getLangfuseWithKeyTraceV1",
  "runWithRetry", "timeoutStep",
]);

/**
 * This PROCESS, not this `--only` string.
 *
 * Every scratch path below used to be a fixed name in the one shared OUT_DIR,
 * and concurrent recorders therefore shared them. Measured, with five agents
 * recording slices of one repo at once: the run holding `--only s5-` published
 * 7 rows belonging to the run holding `--only slice2-`, in a batch of 8 - the
 * OTHER run's `--chunk` size, which is what identifies whose spec produced
 * them. `--only` cannot be the isolation key, because those two runs had
 * different `--only` values (and different harness hashes) and collided anyway.
 * The colliding resource was the scratch file, so the scratch file is what gets
 * a per-run name.
 *
 * pid alone is not enough - pids are reused - so a random tail goes with it.
 */
const RUN_ID = `${process.pid}-${randomBytes(3).toString("hex")}`;

/**
 * The path `vitest.record.config.mts` pins in `include`, and the one path here
 * that CANNOT be per-run: a vitest config's include list is static and that
 * file is not this fix's to edit.
 *
 * So it stops carrying the rows. Its content is a CONSTANT loader that imports
 * whatever `CHARPILOT_SPEC` names, and the rows live in a per-run file beside
 * it. Two runs writing identical bytes to a shared path cannot corrupt each
 * other's chunk; two runs writing DIFFERENT rows to it is the race that lost
 * work and crossed observations.
 */
const SPEC_STUB = join(OUT_DIR, "record.test.ts");
const SPEC = join(OUT_DIR, `record.run-${RUN_ID}.test.ts`);
const RESULT = join(OUT_DIR, `.record-result.${RUN_ID}.json`);
// istanbul's static branch map for the files a chunk loaded, written by the
// worker next to its results. Stage 4 diffs branch COUNTERS per row, and a
// counter index only becomes an armId through this map plus armjoin.mjs.
const BRANCHMAP = join(OUT_DIR, `.record-branchmap.${RUN_ID}.json`);
/** The row a chunk is inside, written by the spec as each row starts. See runChunk. */
const ROW_MARK = join(OUT_DIR, `.record-inflight.${RUN_ID}.json`);
/**
 * ITEM 18 - THE WALK'S CHUNKS RUN SIDE BY SIDE, `CHARPILOT_WALK_SHARDS` AT A
 * TIME.
 *
 * How it worked before: one chunk after another, each its own vitest running
 * one spec file in one worker, so a walk used one core however many the
 * machine had. qode-ptp-ms's walk took 41 min partial and 97 min full (the
 * walk history of runs 20260928T014742Z and 20260928T110132Z, vendored) while
 * the container sampled at about 2 of 8 cores.
 *
 * Every chunk is already a process of its own - its own vitest, process group,
 * spec, result, branch map and in-flight mark - and every row in it pins its
 * own clock and tears its mocks down. So a SLOT is one more set of those five
 * names, and N slots run N chunks at once. Slot 0 is the names this file has
 * always used: with the flag unset or 1 nothing about a walk changes, and that
 * is the kill switch. What a chunk returns is folded into the cache and the
 * artifact the same way whichever finishes first, and the artifact is written
 * in proposal order (writeDoc), so the recording does not depend on the order
 * the chunks finished in.
 */
export function walkShards(raw = process.env.CHARPILOT_WALK_SHARDS, cores = availableParallelism()) {
  // One core stays with this process and the agent's workers.
  const cap = Math.max(1, Math.min(8, cores - 1));
  // `auto`: the machine's cap. The pool never runs more slots than there are
  // chunks, so a small walk stays at one or two (the pool below).
  if (String(raw ?? "").trim().toLowerCase() === "auto") return cap;
  const n = Number.parseInt(String(raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return Math.min(n, cap);
}
const WALK_SHARDS = walkShards();
/** The five per-chunk names, for slot k. Slot 0 keeps the names above. */
export function slotPaths(k, runId = RUN_ID, outDir = OUT_DIR) {
  const tag = k === 0 ? runId : `${runId}-s${k}`;
  return {
    k,
    spec: join(outDir, `record.run-${tag}.test.ts`),
    result: join(outDir, `.record-result.${tag}.json`),
    branchmap: join(outDir, `.record-branchmap.${tag}.json`),
    rowMark: join(outDir, `.record-inflight.${tag}.json`),
    // vitest LOCKS its coverage reportsDirectory: a second vitest on the same
    // one fails at start ("already in use by another Vitest process"), and its
    // chunk records nothing. Slot 0 keeps the config's directory.
    coverageDir: k === 0 ? null : join(outDir, `.record-coverage-s${k}`),
    // `__charpilot_run_<id>__` is slot 0's, and no other slot's token contains
    // it: pgrep for one slot never matches a sibling (reapStrays).
    token: k === 0 ? `__charpilot_run_${runId}__` : `__charpilot_run_${runId}_s${k}__`,
  };
}
const SLOTS = Array.from({ length: WALK_SHARDS }, (_, k) => slotPaths(k));
/**
 * The loader that sits at SPEC_STUB. Constant text: it names no rows, no
 * chunk and no run, so every recorder wants the same bytes there.
 */
const SPEC_STUB_TEXT = `// GENERATED by .claude/charpilot/record.mjs - do not edit, do not commit.
//
// A LOADER, not a spec. The recording config's \`include\` is one fixed path,
// and every concurrent record.mjs resolves to it; whoever wrote it last used to
// decide which rows every running vitest executed. The rows now live in
// out/record.run-<pid>-<rand>.test.ts and this file only forwards to the one
// its own process was told to run.
const spec = process.env.CHARPILOT_SPEC;
if (!spec) {
  throw new Error(
    "charpilot: CHARPILOT_SPEC is not set. This file is a loader - run .claude/charpilot/record.mjs, not vitest directly."
  );
}
await import(spec);
`;
// A live capture and a mocked pair are different artifacts and must not share a
// cache: the mocked pair is deterministic and free to re-record, the live one is
// dated, real and BILLED. Mixing them would silently re-bill a provider every
// time this script is edited (the cache is keyed on the harness hash).
const LIVE_SUFFIX = LIVE ? "-live" : "";
// The cache path carries the harness version too. One fixed path plus a
// content-derived version means two concurrent runs with different flags
// (`--row-timeout 8000` vs the default) compute different versions, and each
// one discards the other's rows and half-writes the same file - so the
// artifact ends up describing neither run. Two orphaned processes did exactly
// that here, producing 160 rows and 69 rows minutes apart from one file. With
// the version in the NAME a mismatched cache is simply not opened.
/**
 * Where the row cache lives.
 *
 * `--only` gets its OWN cache file, for the same reason it gets its own output
 * file: a narrow run must not destroy what a broad one recorded. Safety rule 11
 * was implemented for the artifact and not for the cache, so
 * `--only X --fresh` correctly left behaviour.json alone and then cut the cache
 * from 84 rows to 1 - and the next full run re-recorded 83. On an offline repo
 * that costs forty seconds. Under `--live-providers` it silently re-bills every
 * row, which is the whole reason the cache exists.
 *
 * Found by profile-centralized's agent, which ran `--only … --fresh` to read one
 * emitted spec line and reported the cache it had just lost.
 */
const CACHE_FOR = (version) =>
  join(OUT_DIR, cacheFileName({ version, live: LIVE, only: ONLY, output: process.env.CHARPILOT_OUTPUT }));
/**
 * What this run reused and what it recorded, and why, for the artifact's
 * `reuse` block (item 6b): `seeded` rows taken from the artifact on disk,
 * `evicted` the cached rows recorded again by cause, and `recorded` the ids
 * this process observed. The walk's dirty set, out/dirty.json, is the record
 * step's, off the rows' own digests (steps/record.mjs writeDirtyRows).
 */
const REUSE = { seeded: 0, evicted: {}, recorded: new Set() };
/**
 * The ids the delivered suite asserts - the corpus's recorded.json, in shards
 * or one file - read once per process (D67). Empty when nothing is delivered.
 */
const DELIVERED = new Map();
function deliveredIds(dir = join(REPO_ROOT, CORPUS_REL)) {
  if (!DELIVERED.has(dir)) {
    let ids = new Set();
    try {
      ids = new Set((readRecorded(dir).rows ?? []).map((r) => String(r?.id)));
    } catch {
      // No delivered suite, or one this cannot read: nothing is asserted by it.
    }
    DELIVERED.set(dir, ids);
  }
  return DELIVERED.get(dir);
}
/**
 * The cache file's name. A REDIRECTED ARTIFACT GETS ITS OWN CACHE, the rule
 * `--only` already follows.
 *
 * determinism.mjs takes its second observation by pointing CHARPILOT_OUTPUT at
 * behaviour-second.json. Without the output in the name, that recorder read
 * and wrote the FIRST observation's cache file, so every walk's second
 * observation replaced the first one's cache. When the walk was stopped part
 * way through (sourcing-ms on 2026-09-26, killed by the pack's timeout during
 * determinism), the first cache was left holding only the rows the second
 * observation had reached, and the next recording had to run the rest again.
 * With its own file, each observation keeps its own rows and can resume from
 * them.
 *
 * An `--only` run keeps the name it had: it already has a file of its own.
 */
export function cacheFileName({ version, live = false, only = null, output = null }) {
  const onlyTag = only ? `.only-${only.replace(/[^\w.-]+/g, "_")}` : "";
  const outputTag = output && !only
    ? `.${basename(resolve(output)).replace(/\.json$/, "").replace(/[^\w.-]+/g, "_")}`
    : "";
  return `.record-cache${live ? "-live" : ""}${onlyTag}${outputTag}.${version}.json`;
}
// A NARROWED run must not overwrite the full artifact. `--only` is a
// diagnostic - one row, to check a fix - and writing it to behaviour.json
// replaced 218 recorded rows with 2, which is what stage 5 then read. The doc
// it writes is honest about itself (recorded 2, pending 267); it is still
// destructive to the file every later stage consumes.
// CHARPILOT_OUTPUT lets the determinism check write a SECOND observation
// without touching the artifact the later stages read.
const JOURNAL = join(OUT_DIR, "db-journal.json");
// --only is tested BEFORE --live. A partial run must never land on the file a
// full run produced, and LIVE winning this branch meant `--only redis-` wrote
// 25 rows over the 246-row live capture - the same defect that was fixed for
// the non-live path, reintroduced by a second output path taking precedence.
// The partial name carries the suffix so a live partial and a mocked partial
// stay separate artifacts too.
const OUTPUT = process.env.CHARPILOT_OUTPUT
  ? resolve(process.env.CHARPILOT_OUTPUT)
  : ONLY
    ? join(OUT_DIR, `behaviour-partial${LIVE_SUFFIX}.json`)
    : LIVE
      ? join(OUT_DIR, "behaviour-live.json")
      : BEHAVIOUR_JSON;
const CONFIG = join(CONFIG_DIR, "vitest.record.config.mts");
const DOUBLES = join(FIXTURES_DIR, "doubles.ts");
const VITEST_BIN = join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");

/** A boundary answer that has to be intercepted for the arm to be reached. */
import { NODE_REDIS_SPECIFIERS, assertPolicyRunnable, classify as classifyBoundary, moduleAvailable, nodeRedisModules } from "./policy.mjs";

/** What the policy decided, per boundary, for the run summary. */
const POLICY_DECISIONS = [];

const ACTIVE_MOCK = new Set(["resolves", "rejects", "returns", "throws"]);
/** Answers whose whole observable is "was it called" - wrap the real export. */
const OBSERVE_MOCK = new Set(["spy", "notCalled"]);
/**
 * `value`: THE EXPORT *IS* THE ANSWER.
 *
 * This kind was in `MOCK_KINDS` (validate.mjs) with no substitution semantics
 * anywhere - the only thing that ever happened to it was the `continue` below,
 * which dropped it and everything written beside it. It was an answer the
 * pipeline ACCEPTED AND IGNORED, which record.mjs already says elsewhere is
 * worse than one it refuses (see the note above `stubGlobal` on
 * `vi.doMock("globalThis")`).
 *
 * MEASURED, on run `20260916T223906Z` against location-ms. 233 of its 393
 * boundary declarations - every one of them carrying an executable `build` -
 * used this kind: 121 `prisma` answered with `doubles.prismaClient({...})`,
 * 89 `runWithCaching` answered with a bypass arrow, 23 `fetch` answered with
 * `doubles.fetchStub([...])`. Every one was dropped here, so the generated
 * spec for those rows read `// no boundary needs interception`, the real
 * client ran into `denyEgress()`'s deny proxy, and 122 of 136 rows died as
 * `blocked egress: prisma.<delegate>` - 14 recorded of 136, 63.8% coverage
 * against a 96.7% baseline. The proposals were right; this set was missing a
 * member.
 *
 * WHY IT IS NOT `returns`, and why mapping it there would have been the
 * dangerous fix. `returns` on a FUNCTION export means `() => v`: the export
 * hands the answer back. `value` means the export *is* the answer, so a
 * function-valued one is CALLED. 89 of those 233 answer `runWithCaching` with
 * `(run, getter, setter) => run()` - under `returns` the subject would receive
 * that arrow instead of running it, the cache bypass would never happen, and
 * the row would record a plausible value for a program that never ran. Object
 * answers are indistinguishable between the two kinds; function answers are
 * the opposite of each other, and the majority here are functions.
 *
 * A `value` boundary carrying NEITHER a `build` nor a `value` stays inert, so
 * migrate-executable.mjs's prose mapper - which emits a bare `{kind: "value"}`
 * for "an env read is a value, not a call" (migrate-executable.mjs:105-107) -
 * means exactly what it meant before: nothing is substituted, and
 * `setup.apply.env` is the arrangement. Only an EXECUTABLE answer is executed.
 */
const SUBSTITUTE_MOCK = new Set(["value"]);
/** The kinds whose `build` is evaluated, so the kinds whose `build` must parse. */
const EXECUTED_MOCK = new Set([...ACTIVE_MOCK, ...SUBSTITUTE_MOCK]);

/**
 * Did the proposal write an answer here at all?
 *
 * `"value" in mock` rather than `mock.value !== undefined`, because
 * `{"kind": "value", "value": undefined}` is a row DECLARING undefined - which
 * `answerFrom` in the doubles stub goes out of its way to distinguish from
 * "nothing was configured" - and reading it as absent would substitute the real
 * export for a row that asked for `undefined`.
 */
const carriesAnswer = (mock) => !!mock && (mock.build !== undefined || "value" in mock);

/**
 * Boundaries this run was handed an answer for and did NOT install, with why.
 *
 * An answer that is accepted and does nothing has to be VISIBLE, or the next
 * person debugging a blocked row reads "no boundary declared for it" and goes
 * looking upstream for a declaration that was there all along. That is the
 * search this list exists to remove; it is printed in the run summary and
 * quoted into each affected row's skip reason.
 */
const DROPPED_ANSWERS = [];
/** Proposals whose id a later file also carries; recorded from that file only. See main(). */
const SHADOWED = [];
/** D68: proposals recorded under the scan function their file and name pick out, and the id they were written with. */
const REKEYED = [];

/**
 * WHAT THIS RECORDER WILL DO WITH ONE DECLARED BOUNDARY - the whole decision,
 * in one place, by name.
 *
 * It was an inline predicate inside `classify`, and being inline is half of why
 * it went wrong quietly: the only statement of what a `mock.kind` does lived in
 * a `continue` at the end of a boolean, where nothing could assert on it and a
 * kind could go missing from a Set without anything saying so.
 *
 *   "install"              - a `vi.doMock` / `stubGlobal` is emitted for it
 *   "dropped-with-answer"  - an executable answer was written and is NOT used
 *   "inert"                - nothing was written and nothing is substituted
 */
function boundaryDisposition(kind, mock) {
  if (ACTIVE_MOCK.has(kind) || OBSERVE_MOCK.has(kind)) return "install";
  if (SUBSTITUTE_MOCK.has(kind) && carriesAnswer(mock)) return "install";
  return carriesAnswer(mock) ? "dropped-with-answer" : "inert";
}

/**
 * What a dropped answer costs, and the one-word change that recovers it.
 *
 * "This was ignored" is half a report. The other half is what to write instead,
 * and it is the half that decides whether the next run is different from this
 * one: run `20260916T223906Z` spent 216 minutes deriving 233 answers under a
 * kind that discards them, and nothing it produced said which kind to use.
 */
function droppedAnswerNote(id, symbol, kind, mock, module) {
  return {
    id,
    symbol,
    kind,
    module: module ?? null,
    why:
      `mock.kind "${kind}" substitutes nothing, so the \`${mock.build !== undefined ? "build" : "value"}\` ` +
      `written beside it was not installed and the real export ran`,
    howToRecord:
      `declare \`${symbol}\` with a kind that substitutes: \`value\` (the export IS the answer), ` +
      "or `returns`/`resolves` (the export is a function handing the answer back)",
  };
}

/**
 * Free identifiers the stage-3 expressions use that are neither globals nor
 * `doubles`. Each is a real export; a row only imports the ones its own
 * expressions mention, because importing a module RUNS it (importing the queue
 * middleware constructs queueManager) and an unnecessary import is unnecessary
 * state. Modules are the alias form on purpose: vitest resolves `@/x` and
 * `./x`-from-src to the same module id, so mocking the alias form covers both.
 * The alias form is shorthand for `src/...`; a row imports it under the
 * spelling the target's own config resolves (harnessSpelling, D48).
 */
const HARNESS_SCOPE = {
  CacheKeys: "@/services/redis.service",
  redisCache: "@/services/redis.service",
  loggerV2: "@/utils/loggerV2",
  logger: "@/utils/logger",
  queueManager: "@/middleware/requestQueue.middleware",
  SlackService: "@/services/slack.service",
  llmRequestPayloadV4Stream: "@/types/langfuseV1",
  env: "@/env",
};

/**
 * `construct` was allowed to be prose in stage 3, which stage 4 cannot execute.
 * Only a value that parses as a JS expression is runnable; anything else is a
 * stage-3 defect to report, not something to guess at.
 */
/**
 * The property a `<instance field>` boundary names: `this.redisClient` ->
 * `redisClient`. The scan's `imported` wins when it is there, because it is the
 * field as the class spells it.
 */
function instanceFieldName(name, imported) {
  const fromName = String(name).replace(/^this\./, "");
  const pick = imported && imported !== name ? String(imported) : fromName;
  return pick.replace(/^this\./, "");
}

/**
 * FIX PLAN 1, F3.1. Which receiver a row's field answers are set on, or null
 * when the row has none.
 *
 *   class-method   the instance the row constructs - it dies with the row
 *   exported-binding  the exported singleton, restored in the row's teardown
 *   class-static   the class itself, restored the same way
 *
 * A subject with no receiver (a plain function export, a constructor call, a
 * default export) has nowhere to put `this.<field>`, and saying so is the
 * only honest answer: the old behaviour, recording the row with the double
 * silently gone, froze a different program under the proposal's claim.
 */
function fieldReceiver(entry) {
  if (!entry) return null;
  if (entry.kind === "class-method") return entry.member === "constructor" ? null : "instance";
  if (entry.kind === "exported-binding") return "singleton";
  if (entry.kind === "class-static") return "class";
  return null;
}

/**
 * D83 - A SETUP CALL MAY AWAIT, AS IT IS AWAITED WHERE IT RUNS.
 *
 * A setup call is rendered as `try { await (<call>); } catch {}` inside the
 * row's async test, so `(await import('src/x')).y.flag = false` runs as written.
 * It was checked with `new Function`, which is not an async context, and every
 * such call was refused as "setup[0].apply.call is not an executable
 * expression": qode-ptp-ms had 17 rows and 20 sides of hybridCache.ts held on
 * it across three rounds (run 20260929T151429Z), with nothing the proposal
 * could change to pass. A setup call is checked as the async expression it is.
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
export function isExpression(text, { async = false } = {}) {
  if (typeof text !== "string") return false;
  try {
    // eslint-disable-next-line no-new-func
    if (async) new AsyncFunction(`return (${text});`);
    else new Function(`return (${text});`);
  } catch {
    return false;
  }
  // Parsing is nearly conclusive on its own - "get resolves null" does not
  // parse. The one thing that slips through is a SINGLE WORD of prose, which
  // parses as an identifier, so a bare word is only accepted when it is a
  // literal. (An earlier version demanded a structural character and therefore
  // rejected 78 perfectly runnable answers: `undefined` and `"provider 502"`.)
  if (/[(){}=>.[\]]/.test(text)) return true;
  return /^\s*(-?\d[\d_.eE+-]*|true|false|null|undefined|"[^]*"|'[^]*'|`[^]*`)\s*$/.test(text);
}

/**
 * A boundary is named as the identifier the SUBJECT MODULE imports it under, so
 * the module-level import map is the right resolution scope. A nested arm's
 * boundary is frequently attributed by the scan to a sibling function in the
 * same file, which is why the own-function list alone resolves only 226 of 336.
 */
function boundaryIndex(scan) {
  const byFile = new Map();
  for (const fn of scan.functions) {
    if (!byFile.has(fn.file)) byFile.set(fn.file, new Map());
    const map = byFile.get(fn.file);
    for (const b of fn.boundaries ?? []) if (!map.has(b.symbol)) map.set(b.symbol, b);
  }
  // Module scope's own, so a module-import row's answers resolve like a
  // function's (scan.mjs collects them since module-import rows record).
  for (const group of scan.moduleScopeArms ?? []) {
    if (!byFile.has(group.file)) byFile.set(group.file, new Map());
    const map = byFile.get(group.file);
    for (const b of group.boundaries ?? []) if (!map.has(b.symbol)) map.set(b.symbol, b);
  }
  return byFile;
}

/**
 * Turn the specifier as WRITTEN in src into one the spec file can hand to
 * `vi.doMock`. `./utils/loggerV2` inside src/server.ts means src/utils/loggerV2;
 * from the spec file that same relative string would resolve somewhere else
 * entirely, so it is rewritten to the alias form, which resolves to the same
 * module id from either side.
 */
/**
 * Which spelling of a `src/...` path this TARGET can actually resolve.
 *
 * This used to rewrite `src/X` to `@/X` unconditionally, and that is correct on
 * exactly one repo in the fleet. Measured across four:
 *
 *   repo                generic @/   named @/x   ^src/
 *   ai-centralization      yes           0        no     <- the pilot; blanket @/ works
 *   location-ms            no            9        YES    <- `@/server` does NOT resolve
 *   qode-ptp-ms            no           18        no     <- only the named ones resolve
 *   qode-itl-be            no            0        no     <- neither; relative only
 *
 * On location-ms the blanket rewrite produced `@/server`, which matches none of
 * its nine named aliases, and stage 4 died with `Failed to load url @/server`.
 * The container agent patched it to keep `src/...`, which fixes location-ms and
 * breaks the other two — so neither blanket rule is the answer.
 *
 * The answer is to ask the target. Its vitest config is the authority on what
 * resolves, so the candidate spellings are tested against the `find:` patterns
 * actually written there, and the first that matches wins. When the config
 * cannot be read or nothing matches, the path is left as the scan produced it:
 * an unresolvable specifier is a visible harness failure, while a wrong one
 * that happens to resolve is a row recorded against the wrong module.
 */
let ALIAS_FINDS = null;
function aliasFinds() {
  if (ALIAS_FINDS) return ALIAS_FINDS;
  ALIAS_FINDS = [];
  for (const name of ["vitest.config.mts", "vitest.config.ts", "vite.config.mts", "vite.config.ts"]) {
    const p = join(REPO_ROOT, name);
    if (!existsSync(p)) continue;
    let text = "";
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    // `find: /^@\/services\//` and `find: "@"` are both in use in this fleet.
    // Scan to the first UNESCAPED delimiter: `find: /^@\/env$/` carries `\/`
    // inside the pattern, and a naive `[^/]+` stops on it and parses nothing.
    // Measured: the naive form parsed 0 aliases on all four fleet repos, which
    // made this whole picker inert rather than wrong-looking.
    for (const m of text.matchAll(/find:\s*\/((?:[^/\\]|\\.)+)\//g)) {
      try { ALIAS_FINDS.push(new RegExp(m[1])); } catch { /* not our regex to fix */ }
    }
    for (const m of text.matchAll(/find:\s*["'`]([^"'`]+)["'`]/g)) {
      try { ALIAS_FINDS.push(new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)); } catch { /* same */ }
    }
    // The OBJECT form, which the array form's parser cannot see:
    //   alias: { "@": resolve(__dirname, "src"), "src": resolve(__dirname, "src") }
    // The pilot repo writes it this way and both spellings resolve there, which
    // is exactly why the old blanket `src/` -> `@/` rewrite looked correct for
    // as long as the pilot was the only repo anyone ran.
    const objBlock = text.match(/alias:\s*\{([\s\S]*?)\}/);
    if (objBlock) {
      for (const m of objBlock[1].matchAll(/["'`]([^"'`]+)["'`]\s*:/g)) {
        const key = m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        try { ALIAS_FINDS.push(new RegExp(`^${key}(?:/|$)`)); } catch { /* same */ }
      }
    }
    break;
  }
  return ALIAS_FINDS;
}

/**
 * The spellings of one module, in the order this picker will accept them.
 *
 * A `src/...` path prefers the `@/` form, because that is the order the picker
 * has always used and the pilot repo resolves both. A path already written as
 * `@/...` prefers ITSELF - a named alias that matches is the spelling the
 * author meant - and falls back to `src/...`, which is the case location-ms
 * needs: `@/server` matches none of its nine named aliases, and its tenth,
 * `^src/`, resolves `src/server`.
 *
 * Anything else (a package, a relative path) has exactly one spelling.
 */
function candidateSpellings(path) {
  if (path.startsWith("@/")) return [path, `src/${path.slice(2)}`];
  if (path.startsWith("src/")) return [path.replace(/^src\//, "@/"), path];
  return [path];
}

/**
 * A `src/...` path spelled so the TARGET'S OWN config resolves it - its alias
 * when it has one that matches, else ROOT-RELATIVE (`/src/...`), never the bare
 * `src/...` the scan produced.
 *
 * WHAT THE BARE SPELLING DID. `src/...` resolves at record time only because
 * `vitest.record.config.mts` adds the pipeline's own `^src/` alias, and the
 * committed suite runs under the repo's config, which does not carry it. On
 * company-enrich (no aliases at all) `await import("src/services/sync/index")`
 * still loaded - vite falls back to the root for an import - but
 * `vi.doMock("src/services/tag/tagService")` registered an id the subject's own
 * `../tag/tagService` import never matches. The double was never installed, the
 * real TagService ran against a prisma double that has no `industries`, and PR
 * #30 went red on `the downstream calls changed` - recorded
 * [PrismaClient, TagService, ...], replayed [PrismaClient, ...] - in five rows
 * of services-sync-index alone. `/src/...` is resolved against the project root
 * by vite in every config, the recorder's and the repo's, and it names the same
 * module id the relative import does, so the mock lands in both.
 */
function srcSpelling(path) {
  const aliased = aliasSpelling(path);
  if (aliased) return aliased;
  // A DIRECTORY needs its index named. `vi.doMock("/src/services/sync")`
  // registers nothing the subject's `../../services/sync` import resolves to
  // (it lands on src/services/sync/index.ts), while the pipeline's own alias
  // gave the directory an absolute path vite could complete: company-enrich
  // PR #30, anonymous-29-if-1, where the SyncService double went missing and
  // the real one hit the database deny.
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];
  const isFile = exts.some((e) => existsSync(join(REPO_ROOT, `${path}${e}`)));
  const isDir = !isFile && exts.some((e) => existsSync(join(REPO_ROOT, path, `index${e}`)));
  return `/${path}${isDir ? "/index" : ""}`;
}

/** The first candidate spelling the target's own aliases match, else null. */
function aliasSpelling(path) {
  const finds = aliasFinds();
  if (!finds.length) return null;
  for (const cand of candidateSpellings(path)) {
    if (finds.some((re) => re.test(cand))) return cand;
  }
  return null;
}

/**
 * The same picker, applied to the specifiers INSIDE an expression a stage-3
 * proposal wrote by hand.
 *
 * `invoke.build` and `args[].build` are emitted verbatim, so the alias picker
 * that governs the scan's own module paths never saw them. On location-ms the
 * agent wrote `import("@/server")` in four build expressions and stage 4 died
 * four times with `Failed to load url @/server` - the same failure the picker
 * exists to prevent, arriving through the one door it did not cover.
 *
 * Only `import("...")` and `import('...')` are rewritten, and only when the
 * picker names a DIFFERENT spelling that the target's own aliases match. A
 * specifier nothing matches is left exactly as written: an unresolvable
 * specifier is a visible harness failure, while a rewritten guess that happens
 * to resolve is a row recorded against the wrong module.
 */
function retargetSpecifiers(code) {
  if (typeof code !== "string" || !code.includes("import(")) return code;
  return code.replace(/\bimport\(\s*(["'])([^"'`\n]+)\1\s*\)/g, (whole, q, spec) => {
    if (spec.startsWith(".")) {
      const placed = repoRelativeSpecifier(spec);
      return placed ? `import(${q}${placed}${q})` : whole;
    }
    const picked = spec.startsWith("src/") ? srcSpelling(spec) : aliasSpelling(spec);
    return picked && picked !== spec ? `import(${q}${picked}${q})` : whole;
  });
}

/**
 * D50: every `import("...")` in an invoke.build, wrapped so the harness knows
 * the row is importing (charpilotSubjectImport in the spec).
 *
 * A build that evaluates to `async () => { await import('src/main'); ... }`
 * imports inside the subject call, where the row budget runs; the wrapper
 * gives that import the arrangement's allowance instead, the same one an
 * import the build makes before it hands the subject back already has. Only
 * string-literal specifiers, the ones retargetSpecifiers rewrites; the value
 * the import resolves to is unchanged.
 */
export function markSubjectImports(code) {
  if (typeof code !== "string" || !code.includes("import(")) return code;
  return code.replace(/\bimport\(\s*(["'])([^"'`\n]+)\1\s*\)/g, (whole) => `charpilotSubjectImport(() => ${whole})`);
}

/**
 * THE REPO MODULES AN invoke.build require()s, each with the spelling vite
 * resolves it by from any spec directory (D41).
 *
 * tracy-agent-be-ms (late September 2026) reached a module-private function
 * with invoke.build
 *   (snapshot) => require('../../../src/services/sourcing.service').sourcingService.edit(...)
 * The require goes to node, not vite. Node could not load the module's own
 * import of "@/prisma" (a tsconfig path - requireTypeScript now maps those),
 * and even loaded, a module node loads is not the row's: none of the row's
 * vi.doMock answers apply to it, it is not instrumented, so it moves no
 * counter, and it is compiled apart from the copy the row's imports see. 26
 * sides were lost as a pipeline_defect. So each require("...") in the build
 * that names a repo module - relative, "@/..." or "src/..." - is imported
 * through vite before the build runs (charpilotRepoRequire), under the
 * spelling import() gets in the same expression, and the build's require()
 * hands that module back. A package is left to node.
 *
 * Returns [asWritten, spelling] pairs, first occurrence of each.
 */
function repoRequires(code) {
  if (typeof code !== "string" || !code.includes("require(")) return [];
  const out = new Map();
  for (const m of code.matchAll(/\brequire\(\s*(["'])([^"'`\n]+)\1\s*\)/g)) {
    const spec = m[2];
    if (out.has(spec)) continue;
    let spelling = null;
    if (spec.startsWith(".")) spelling = repoRelativeSpecifier(spec);
    else if (spec.startsWith("src/")) spelling = srcSpelling(spec);
    else if (spec.startsWith("@/")) spelling = aliasSpelling(spec) ?? spec;
    if (spelling) out.set(spec, spelling);
  }
  return [...out.entries()];
}

/**
 * A `value` that is a STRING HOLDING JSON TEXT - `"{ \"a\": 1 }"`,
 * `"[1]"`, `"\"resume.pdf\""` - rather than the JSON itself. Only a reading
 * for the harness-failure message (noteValueAsText); the value is still passed
 * exactly as written, since a parameter or export may really take such a string.
 */
function isJsonText(v) {
  if (typeof v !== "string" || !/^\s*[[{"]/.test(v)) return false;
  try {
    const p = JSON.parse(v);
    return p !== null && (typeof p === "object" || typeof p === "string");
  } catch {
    return false;
  }
}

/**
 * TOOL BACKLOG: A RELATIVE import() IN A HAND-WRITTEN EXPRESSION MEANS THE REPO.
 *
 * An agent writes `(await import('../src/routes/prompt-tests')).promptTestsRouter`
 * as if the spec sat one level under the repo root, the way a repo's own tests
 * do. The spec is written under .claude/charpilot/out/ (and emitted under
 * test/characterization/), so vite resolved `/work/repo/.claude/charpilot/src/
 * routes/prompt-tests` and the row died "Cannot find module" in its
 * arrangement: assessment-service 20260922T101156Z, promptTestsRouter and
 * metricsRouter. The leading ./ and ../ are dropped, and when what remains
 * names a module in the repo it is spelled root-relative (or by the repo's
 * alias for src/), which resolves the same from any spec directory. A
 * specifier that names nothing in the repo is left as written, so it still
 * fails visibly.
 */
function repoRelativeSpecifier(spec) {
  const rest = spec.split("/").filter((p) => p !== "." && p !== "..").join("/");
  if (!rest) return null;
  const exists = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.js"].some((ext) => existsSync(join(REPO_ROOT, `${rest}${ext}`)));
  if (!exists) return null;
  if (rest.startsWith("src/")) return aliasSpelling(rest) ?? `/${rest}`;
  return `/${rest}`;
}

/**
 * The specifiers in the EMITTED files that the target resolves to nothing.
 *
 * The picker leaves a path it cannot place exactly as the scan produced it, on
 * the grounds that an unresolvable specifier is a visible harness failure. It
 * was not visible: on location-ms `@/server` reached a PR and announced itself
 * as four `Failed to load url @/server` rows in CI, hours after the emit that
 * wrote it. So the emit says so itself, while the operator is still looking.
 *
 * Only `@/` and `src/` specifiers are judged - those are the two spellings this
 * pipeline produces. A package the target does not have is npm's business, and
 * a config this picker parsed no aliases out of judges nothing at all, because
 * "matches none of zero patterns" is not evidence about the specifier.
 */
function unresolvableSpecifiers(relPaths) {
  if (!aliasFinds().length) return [];
  const counts = new Map();
  for (const rel of relPaths) {
    let text = "";
    try { text = readFileSync(join(REPO_ROOT, rel), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/\bimport\(\s*(["'])([^"'`\n]+)\1\s*\)/g)) {
      const spec = m[2];
      if (!spec.startsWith("@/") && !spec.startsWith("src/")) continue;
      if (aliasSpelling(spec)) continue;
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([spec, n]) => `${spec} (${n})`);
}

/** Does `spec`, written in `dir` (repo-relative), climb above the repo root? */
function climbsAboveRoot(dir, spec) {
  let depth = dir.split("/").filter((p) => p && p !== ".").length;
  for (const p of spec.split("/")) {
    if (p === "..") depth -= 1;
    else if (p && p !== ".") depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

function normalizeModule(spec, ownerFile) {
  if (!spec.startsWith(".")) return spec.startsWith("src/") ? srcSpelling(spec) : spec;
  const dir = dirname(ownerFile); // e.g. "src/services"
  const parts = `${dir}/${spec}`.split("/");
  const out = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  const path = out.join("/");
  // TOOL BACKLOG: A PATH THAT CLIMBS OUT OF src/ IS NOT A PACKAGE. tracy-agent-be
  // imports its client as `../../prisma/client` from src/repositories, which
  // normalises to `prisma/client` - and vite reads a bare `prisma/client` as
  // the npm package `prisma`, subpath `./client`. The row's own mock then threw
  // `"./client" is not exported ... from package .../node_modules/prisma` in
  // its arrangement, and so did every later row in its chunk, whose
  // unmockAll() re-resolved the same specifier (run `20260922T152300Z`,
  // pipeline.repository's findStatuses and findByUseCase1Id). The repo's
  // `prisma/` directory is what the pilot's own `@/prisma/` alias names in the
  // record and coverage configs, so it is spelled that way.
  if (path.startsWith("prisma/") && !path.startsWith("prisma/node_modules/")) return `@/${path}`;
  if (path.startsWith("src/")) return srcSpelling(path);
  // Generalised (tool backlog): any other directory at the repo root is
  // spelled ROOT-RELATIVE, `/lib/x`. vite resolves a leading `/` against the
  // project root before the filesystem root, in the recorder's config and in
  // the repo's own, so the same spelling works in the spec written here and
  // in a test emitted into the repo - where an absolute path from this
  // machine would not. A bare `lib/x` is read as the npm package `lib`.
  // A path that climbed above the repo is left as it was.
  return climbsAboveRoot(dirname(ownerFile), spec) ? path : `/${path}`;
}

/**
 * Do two specifiers name the SAME module, written from the same file?
 *
 * `./env` inside src/server.ts and `@/env` are one module under two spellings,
 * and normalizeModule already collapses that difference - so the comparison is
 * made on the normalised forms, never on the raw strings. Used only to decide
 * whether a proposal's declared `module` is a RESTATEMENT of what the scan
 * found (in which case the scan's richer entry is kept, `imported` included)
 * or a CORRECTION of it.
 *
 * `<instance field>` is not a specifier and normalizes to itself, which is the
 * behaviour wanted here: it can never equal a real module, so declaring one
 * against an instance field always counts as a correction.
 */
function sameModuleId(a, b, ownerFile) {
  if (a === undefined || b === undefined) return false;
  return normalizeModule(a, ownerFile) === normalizeModule(b, ownerFile);
}

/** The scanner's own driver record for a function, whatever shape it took. */
const GLOBAL_SPELLINGS = new Set(["globalThis", "<global>", "<globalThis>", "global", "window", "self"]);

function scanVia(fn) {
  const v = fn?.via;
  if (!v) return null;
  return typeof v === "string" ? { driver: v, path: [v] } : v;
}

/**
 * D69 — `via: "export <binding>"` WHERE THE BINDING IS ITSELF AN EXPORTED
 * FUNCTION: the scan function to call, or null.
 *
 * qode-ptp-ms, run 20260927T061823Z: candidatesSite/index.ts has
 *
 *   const resolveRecruiterInterviewer = async ({ ... }) => { ... };
 *   export const getOrCreateRecruiterInterviewer: typeof resolveRecruiterInterviewer =
 *     params => { ...; const work = resolveRecruiterInterviewer(params); ... };
 *
 * The scan lists `export getOrCreateRecruiterInterviewer` among the drivers of
 * the module-private function (via kind `through-reference`, because the
 * `typeof` annotation names it at module scope), six rows took that via, and
 * this file drove it as `getOrCreateRecruiterInterviewer.resolveRecruiterInterviewer`
 * - the member-of-an-object reading `export const svc = { label }` needs. A
 * function has no such member, so every row died "entry did not resolve to a
 * function" in arrangement, and 3 sides were ruled pipeline_defect. The via was
 * right: the binding is a function that calls the one the arm is in, so calling
 * it with the row's arguments is the call, exactly as a function-id via to the
 * same function (`index.ts:720:getOrCreateRecruiterInterviewer`) would be.
 *
 * Only when the scan has the binding as a function of its own, exported under
 * that name from the same module, and does not say the binding HOLDS the arm's
 * function as a member (via.held, which keeps `svc.label` a member call).
 */
function exportedFunctionBinding(nested, binding, fnIndex) {
  if (!nested || !binding) return null;
  const key = `export ${binding}`;
  if (scanVia(nested)?.held?.[key]) return null;
  const moduleOf = (f) => f?.entry?.module ?? f?.file;
  const found = [...fnIndex.values()].filter(
    (f) => f.entry?.reachable && f.entry.kind === "import-named" && f.entry.symbol === binding && moduleOf(f) === moduleOf(nested)
  );
  return found.length === 1 ? found[0] : null;
}

/**
 * D56 — THE REFUSAL OF A TRIGGER ROW SAYS WHAT THE INVOKE IS, when the scan
 * knows (scan.mjs decoratorMetadataBuild).
 *
 * "the proposal supplies no invoke of its own" is the whole of what this
 * refusal said, and on qode-itl-be (run 20260926T165924Z) every one of 21 such
 * sides was answered with a declaration that cited this sentence as its proof,
 * rather than with the invoke it asks for. So the sentence now ends in the
 * build to write. The part before it is unchanged, so every reader that
 * matches on it (derive's SKIP_REASONS, the ledger's double-claim rule) still
 * does. Empty when the scan has no build to suggest.
 */
function triggerRecipe(fn) {
  const build = scanVia(fn)?.suggestedBuild;
  if (typeof build !== "string" || !build) return "";
  return (
    ` - this function is reachable: write invoke.build \`${build}\`, which fetches it from where ` +
    `the decorator keeps it, and derive its arguments as for any call`
  );
}

/**
 * A `via` IN ONE OF THE SHAPES A DRIVER HAS: a scan function id
 * (`<file>:<line>:<name>`), `export <binding>`, `export <binding>.<member>`,
 * or `trigger:<kind>`. Anything else is not a name at all.
 *
 * pricing-ms, the mocked run of September 26: three proposals wrote their
 * reasoning into `via` - "default export PricingCreditRoute", "export
 * customerSubscriptionRepository (CustomerSubscriptionRepository singleton,
 * line 248-249) — updateNextRenewalDate is called directly on it", and
 * "export userActionHistoryRepository — userActionHistoryRepository.update(..)
 * with options omitted. ..". Each was looked up as a function id, found
 * nothing, and was refused "driver <via> not resolvable", which reads as the
 * recorder's limit: 7 sides pipeline_defect. The skeleton gave each function
 * no via - all three have their own entry - so the field is the proposal's to
 * fix, and viaNotADriver says how.
 */
const VIA_SHAPED = /^(?:[^\s:]+:\d+:.+|export\s+[\w$]+(?:\.[\w$]+)?|trigger:\S+)$/;
function viaNotADriver(proposal, fn) {
  const via = String(proposal.via);
  const binding = /^export\s+([\w$]+)\b/.exec(via)?.[1] ?? null;
  const drivers = (() => {
    const v = scanVia(fn);
    return v ? (v.drivers ?? [v.driver]).filter(Boolean) : [];
  })();
  const own = fn?.entry?.reachable ? `${proposal.functionId} has its own entry (${fn.entry.kind}${fn.entry.className ? ` of ${fn.entry.className}` : ""}), so it is driven without one: leave via out` : null;
  const through = drivers.length ? `the scan drives ${proposal.functionId} through ${drivers.map((d) => `"${d}"`).join(" | ")}: write that` : null;
  const alone = binding ? `to call it on the exported binding, write via "export ${binding}" alone` : null;
  return (
    `via "${via}" is not a driver - via is one name, byte-exact, with nothing after it: a function id from scan.json, ` +
    `"export <binding>", "export <binding>.<member>" or "trigger:<kind>"; ` +
    [own ?? through, alone].filter(Boolean).join("; or ") +
    (own || through || alone ? "" : "name the function that calls it") +
    " - the reasoning belongs in rationale"
  );
}

function classify(proposal, fnIndex, byFile) {
  /** Set when the arm lives inside a zero-arg closure the driver returns. */
  let invokeReturned = null;

  // `covers` IS AGENT-WRITTEN AND THIS STAGE DOES NOT REQUIRE VALIDATE TO HAVE
  // PASSED. `(proposal.covers ?? []).map(...)` below reads it as an array to
  // decide which files are under test, and `.map` on an object throws "is not a
  // function" out of the whole record step — the round-killing shape that cost
  // run 20260918T105518Z (notification-ms, round 2) 79 runnable rows on disk,
  // recorded none of them, and came back every round because the file that
  // caused it stays in proposals/.
  //
  // Asked once, here, rather than at the read: `covers` is also what the row
  // carries into the artifact, so a proposal whose covers cannot be read has
  // nothing to file its observation under.
  if (proposal.covers !== undefined && !Array.isArray(proposal.covers)) {
    return {
      runnable: false,
      reason:
        `covers is ${proposal.covers === null ? "null" : typeof proposal.covers} — it must be an array of armIds, ` +
        `because it is what says which arms this row answers and which files are therefore under test`,
    };
  }

  // ---- the proposal names its own subject ---------------------------------
  //
  // A decorator cannot be reached by calling the decorator factory. `RedisCache`
  // returns `(target, propertyKey, descriptor) => void`; the arm lives in the
  // `descriptor.value` wrapper it installs, so something has to APPLY it to a
  // method and then call that method. `doubles.redisCacheDecorated(...)` does
  // exactly that and hands back the decorated callable.
  //
  // This overrides only the SUBJECT. The first version returned early with
  // `mocks: []`, `env: []`, `calls: []` and so ran those rows with no boundary
  // mocks and no env whatsoever - every one hung with `boundaryCalls: []`,
  // having reached nothing at all. The arrangement is exactly as load-bearing
  // here as anywhere else; only the way the subject is obtained differs.
  const builtSubject = proposal.invoke?.build ?? null;

  // A trigger-owned arm is refused only when the proposal supplies no driver of
  // its own. `validate.mjs` REQUIRES `via: "trigger:<kind>"` for these arms (the
  // scan is the authority on how a framework-invoked function is reached), so
  // without the `!builtSubject` clause the two guards deadlocked: such an arm
  // could never record no matter what `invoke` it carried. That is why the 9
  // repaired server.ts rows worked - their via is `through-chain`, not a
  // trigger - and why triggered-units.json was the only file that stayed stuck.
  // COERCED, because `via` is the agent's field and this process must not die
  // on its shape. `validate.mjs:377` already reads it as `String(p.via)`, so a
  // non-string via PASSES validation and arrived here — and
  // `proposal.via?.startsWith` is a TypeError, not a refusal. It killed run
  // 20260917T163043Z outright in round 2:
  //   record: record.mjs exited 1 — ✗ proposal.via?.startsWith is not a function
  //   the workflow failed in round 2 (status 1)
  // A recorder that crashes takes the whole run with it, including every
  // proposal that WAS well formed. Refusing one row is the worst this may cost.
  if (String(proposal.via ?? "").startsWith("trigger:") && !builtSubject) {
    return { runnable: false, reason: `${proposal.via} - a framework fires this, and the proposal supplies no invoke of its own${triggerRecipe(fnIndex.get(proposal.functionId))}` };
  }

  const nested = fnIndex.get(proposal.functionId);

  // `export redisCache` names an exported BINDING, not a function. The call is
  // still ordinary - `redisCache.get(...)` - so resolve it as its own entry
  // shape rather than refusing it.
  // COERCED, for the reason line 901 is: `via` is the agent's field and
  // `.match` on a non-string is a TypeError that ends the whole run. This is
  // the SAME defect nine lines below the one dcee311 fixed, found by sweeping
  // for the pattern rather than by another run hitting it.
  let exported = String(proposal.via ?? "").match(/^export\s+(\w+)$/);
  // TOOL BACKLOG: `export <binding>.<member>` NAMES A MEMBER OF AN EXPORTED
  // BINDING, and it is the spelling an agent writes for an arm nested inside
  // that member (pricing-ms: `buildOverdueNote` inside
  // `cronjobService.sendCronjobResultNotification`, whose scan `via` is the
  // chain through `export cronjobService`). It was looked up as a function id,
  // found nothing, and was refused as "driver ... not resolvable". The member
  // is the scan function the binding drives under that name; the row calls it
  // on the binding, and the nested arm runs inside it.
  const exportedMember = String(proposal.via ?? "").match(/^export\s+(\w+)\.(\w+)$/);
  let memberDriver = null;
  if (exportedMember && !builtSubject) {
    const [, binding, member] = exportedMember;
    const drives = (f) => f.via?.drivers?.includes(`export ${binding}`) || f.via?.driver === `export ${binding}`;
    const owner = fnIndex.get(proposal.functionId);
    const found = [...fnIndex.values()].filter((f) => (f.entry?.member ?? f.name) === member && f.entry?.kind !== "nested" && drives(f));
    memberDriver = found.find((f) => f.file === owner?.file) ?? found[0] ?? null;
    if (memberDriver) exported = [proposal.via, binding];
  }
  let subject;
  let entry;
  // A proposal that BUILDS its own subject is not going through the driver
  // named in `via`, so the driver's reach is irrelevant to it - the same guard
  // line 374 already applies to the returned-closure arity check. Without it
  // here, `redis-retryStrategy-*` were refused for "the arm is nested, not a
  // member of `redisCache`" while supplying an `invoke` that reaches the arm
  // directly, out of the options object the constructor was handed.
  if (exported && !builtSubject && memberDriver) {
    // The arm may be nested inside the member: calling the member runs it.
    subject = memberDriver;
    entry = {
      kind: "exported-binding",
      module: memberDriver.entry.module,
      binding: exported[1],
      member: memberDriver.entry.member ?? memberDriver.name,
      static: memberDriver.entry.static ?? false,
    };
  } else if (exported && !builtSubject && nested && (scanVia(nested)?.immediatelyInvoked ?? []).includes(proposal.via)) {
    // THE BINDING'S INITIALIZER IS THE FUNCTION, CALLED WHERE IT IS WRITTEN:
    // `export const N = ((): number => { ... })()` (scan via.immediatelyInvoked).
    // N holds what it returned, so N[name] is nothing, and the row died "entry
    // did not resolve to a function" as a harness failure (email-centralization-ms,
    // GMAIL_READ_CONCURRENCY, September 2026). The function runs when its module
    // is evaluated, so the row imports the module inside the subject window, under
    // its own apply.env, exactly as a module-scope arm's row does, and records
    // what the binding came out as.
    subject = nested;
    entry = { kind: "module-import", module: nested.entry.module ?? nested.file, binding: exported[1] };
  } else if (exported && !builtSubject && nested && exportedFunctionBinding(nested, exported[1], fnIndex)) {
    // D69: THE BINDING IS ITSELF AN EXPORTED FUNCTION, and calling it is the
    // call. See exportedFunctionBinding.
    subject = exportedFunctionBinding(nested, exported[1], fnIndex);
    entry = subject.entry;
  } else if (exported && !builtSubject) {
    // D68: the id is the proposal's to correct, and the sentence says so.
    if (!nested) return { runnable: false, reason: staleFunctionIdReason(proposal, resolveFunctionId(fnIndex, proposal).why) };
    // D43: THE FUNCTION IS HANDED TO A CALL, AND THE BINDING HOLDS THE CALL'S
    // RESULT (scan via.wrapped). tracy-worker's `handler` is a property of the
    // object passed to defineTask(...); `taskList["company-research-task"]` is
    // what defineTask returned, which takes graphile's (payload, helpers), not
    // the handler's ({ payload, log }). Calling any member with the handler's
    // arguments reaches nothing the row claims, so the via is refused and the
    // refusal says what does reach it.
    // The function itself, or a hop of its chain (scan via.path): tracy-worker's
    // CandidateScreeningAgent methods chain through the screening task's
    // handler to `export taskList`, and read taskList off agent.ts.
    const wrappedAt = (() => {
      const own = scanVia(nested)?.wrapped?.[proposal.via];
      if (own) return { hop: nested, w: own };
      for (const id of scanVia(nested)?.path ?? []) {
        const w = scanVia(fnIndex.get(id))?.wrapped?.[proposal.via];
        if (w) return { hop: fnIndex.get(id), w };
      }
      return null;
    })();
    if (wrappedAt) {
      const { hop, w: wrapped } = wrappedAt;
      const file = String(hop.file ?? "");
      const spec = file.replace(/\.[cm]?[jt]sx?$/, "");
      const through = hop === nested ? "it" : `it is reached through ${hop.name} (${hop.id}), and ${hop.name}`;
      return {
        runnable: false,
        reason:
          `via "${proposal.via}" cannot reach ${nested.name}: ${through} is written inside the arguments of ${wrapped.call}(...), which ${wrapped.binding}'s initializer calls in ${file}, ` +
          `so every binding holding ${wrapped.binding} holds what ${wrapped.call} returned, not ${hop.name} - no member of the binding is ${nested.name}; ` +
          `drive it through that value with an invoke.build, e.g. \`(await import("${spec}")).${wrapped.binding}\`, and args in the signature of the function ${wrapped.call} returned`,
      };
    }
    // `export redisCache` only reaches an arm that is a MEMBER of the binding.
    // redis.service.ts:52:retryStrategy is an arrow inside connect(), handed to
    // the ioredis client as an option - ioredis calls it, `redisCache.x()`
    // never can, so the driver named in `via` does not actually reach it.
    // TOOL BACKLOG: A MODULE-PRIVATE FUNCTION IS NOT A MEMBER OF THE BINDING.
    // tracy-agent-be's buildSearchParamsFromJd, buildSearchParamsFromSnapshot
    // and resolveFromEditScreening are plain functions in sourcing.service.ts,
    // reached through `sourcingService.edit`. With `via: "export
    // sourcingService"` the row read sourcingService[name], got undefined, and
    // died "entry did not resolve to a function" as a harness failure in 10
    // rows of 20260922T152300Z. No call made from here reaches a function the
    // module does not export, so the row is refused, naming the member that
    // does reach it. Re-deriving through that member is the proposal's repair.
    // Only when the scan says the binding does NOT hold it: a module-private
    // function the binding references directly (`export const svc = { label,
    // edit }`, via kind through-reference) IS svc.label, and is called as one.
    // TOOL BACKLOG: a module-private function the binding's INITIALIZER only
    // calls - `export const tracer = tracerBuilder(...)` - is no member of it.
    // It runs at import, with the module's own arguments, and no input reaches
    // it (assessment-service tracerBuilder and buildExporter, 20260922T101156Z:
    // "entry did not resolve to a function"). The scan says so since this
    // commit (via.calledAtImport); a scan that predates it is driven as before.
    const atImport = (fn) => {
      const v = scanVia(fn);
      return v?.kind === "through-reference" && (v.calledAtImport ?? []).includes(proposal.via) && !v.held?.[proposal.via];
    };
    const chainOf = (fn) => (scanVia(fn)?.path ?? []).filter((id) => !String(id).startsWith("export ")).map((id) => fnIndex.get(id)).filter(Boolean);
    if (nested.entry.kind === "module-private" && (atImport(nested) || chainOf(nested).some((f) => f.entry?.kind === "module-private" && atImport(f)))) {
      const caller = atImport(nested) ? nested : chainOf(nested).find((f) => atImport(f));
      return {
        runnable: false,
        reason:
          `via "${proposal.via}" cannot reach ${nested.name}: ${caller.name}() is called by the initializer of ${proposal.via.slice("export ".length)} at import, ` +
          `with ${nested.file}'s own arguments - it is not a member of the binding and no input reaches it; declare its uncovered sides as fixed at import`,
      };
    }
    if (nested.entry.kind === "module-private" && scanVia(nested)?.kind !== "through-reference") {
      const path = scanVia(nested)?.path ?? [];
      const reacher = path.filter((id) => !String(id).startsWith("export ")).map((id) => fnIndex.get(id)).filter(Boolean).at(-1);
      const through = reacher && reacher.id !== nested.id && reacher.entry?.kind !== "module-private" ? `${proposal.via}.${reacher.entry?.member ?? reacher.name}` : null;
      return {
        runnable: false,
        reason:
          `via "${proposal.via}" cannot reach ${nested.name}: it is module-private in ${nested.file}, not a member of the binding - ` +
          (through ? `drive it through via "${through}" with that member's own arguments` : "drive it through the member that calls it, with that member's own arguments"),
      };
    }
    if (!nested.entry.module || !(nested.entry.member ?? nested.name)) {
      return { runnable: false, reason: `via "${proposal.via}" names a binding but the arm is ${nested.entry.kind}, not a member of it` };
    }
    if (nested.entry.kind === "nested") {
      return {
        runnable: false,
        reason: `via "${proposal.via}" names a binding but the arm is a callback inside ${nested.entry.enclosedBy}() - a library invokes it, not the binding`,
      };
    }
    subject = nested;
    entry = {
      kind: "exported-binding",
      // D73: the module that EXPORTS the binding, which for a class's
      // singleton is often not the class's own (bindingHolder).
      module: bindingHolderOnce(exported[1], nested.entry.module),
      binding: exported[1],
      // The KEY the binding holds it under, which a `{ run: label }` makes
      // different from the function's own name (scan via.held).
      member: scanVia(nested)?.held?.[proposal.via] ?? nested.entry.member ?? nested.name,
      static: nested.entry.static ?? false,
    };
  } else if (!builtSubject) {
    // D79: a driver one line-shift away is the same driver (validate.mjs resolveVia).
    subject = fnIndex.get(proposal.via ? resolveVia(fnIndex, proposal.via).id : proposal.functionId);
    if (!subject && proposal.via && !VIA_SHAPED.test(String(proposal.via))) return { runnable: false, reason: viaNotADriver(proposal, nested) };
    if (!subject) {
      return {
        runnable: false,
        // D68: no via, so the id is the functionId, and it is the proposal's.
        reason: proposal.via ? `driver ${proposal.via} not resolvable` : staleFunctionIdReason(proposal, resolveFunctionId(fnIndex, proposal).why),
      };
    }
    // D47: a subject the scan resolves as framework-triggered (a Nest
    // useFactory in @Module's argument) is refused as a trigger row is above:
    // its `via: "trigger:<kind>"` and an invoke.build are the proposal's to write.
    const trigger = scanVia(subject)?.kind === "trigger" ? scanVia(subject).trigger : null;
    if (!subject.entry.reachable && trigger) {
      return { runnable: false, reason: `trigger:${trigger} - a framework fires this, and the proposal supplies no invoke of its own${triggerRecipe(subject)}` };
    }
    if (!subject.entry.reachable) return { runnable: false, reason: `${subject.entry.kind} with no driver named` };
    if (!["import-named", "import-default", "import-named-property", "class-method", "class-static", "module-import"].includes(subject.entry.kind)) {
      return { runnable: false, reason: `entry kind ${subject.entry.kind} not supported yet` };
    }
    // A MODULE-SCOPE owner (validate.mjs moduleScopeFunctions) carries no
    // `module`: its file is the module, and importing it is the call.
    entry = subject.entry.kind === "module-import" ? { ...subject.entry, module: subject.entry.module ?? subject.file } : subject.entry;

    // ---- the driver that returns a closure ------------------------------
    //
    // `getInvokeWithToolsV4Action(llmRequest, secret)` returns
    // `async () => Promise<AnthropicToolResponse>`, and the arm under test lives
    // INSIDE that returned closure. Calling the driver alone recorded
    // `{$function: "anonymous"}` - a function object, not behaviour - and 61
    // claims across 218 rows were false for exactly this reason. The recipe has
    // to call the driver AND THEN call what it hands back.
    //
    // Only when the evidence says so: the arm's own function must be nested
    // inside the driver's line range, and take no parameters. A closure that
    // takes arguments needs values nobody has written, and guessing them would
    // invent an input - so that stays a reported gap.
    // ---- the driver that returns a closure ------------------------------
    //
    // Two shapes, one cause. `getInvokeWithToolsV4Action(req, secret)` returns
    // `async () => ...` and the arm may sit INSIDE that closure - or inside a
    // module-private function the closure CALLS (`persistUsage`,
    // `alertUsageError`, `resolveTraceName`). Lexical nesting only caught the
    // first shape, so 19 of 43 proposals were repaired and the other 24 still
    // recorded `{$function: "anonymous"}` - a function object, not behaviour.
    //
    // So the test is not where the arm lives, it is whether the DRIVER hands
    // back a closure at all: any `<returned closure>` lexically inside the via
    // chain. Calling it cannot un-execute the driver's own body, which already
    // ran to produce the closure - it only adds what the closure does.
    //
    // Restricted to ZERO-ARG closures. One that takes arguments would receive
    // `undefined` and could throw a TypeError that gets written down as this
    // service's behaviour, so it is reported as a stage-3 gap instead.
    const armOwner = fnIndex.get(proposal.functionId);
    // A proposal that BUILDS its own subject is not calling the driver, so the
    // driver's returned-closure arity is irrelevant to it. Without this guard
    // the 19 migrated decorator proposals were refused for needing
    // `(target, propertyKey, descriptor)` - arguments the double supplies.
    if (!builtSubject && proposal.via && armOwner) {
      const chain = [armOwner, ...(scanVia(armOwner)?.path ?? []).map((id) => fnIndex.get(id)).filter(Boolean), subject];
      // `byFile` here is the BOUNDARY index (file -> symbol), not functions, so
      // the candidates come from fnIndex.
      const closures = [...fnIndex.values()].filter(
        (f) =>
          f.file === subject.file &&
          f.name === "<returned closure>" &&
          chain.some((c) => c && c.file === f.file && c.line <= f.line && c.endLine >= f.endLine)
      );
      if (closures.length) {
        // A closure whose every parameter is optional (`?`, a default, a rest)
        // is called with none: omitting them is a call its own signature
        // allows, so nothing is invented. ai-centralization's
        // streamWithToolsV4 returns `(signal?: AbortSignal) => ...`, and
        // counting `signal` as owed refused every row through that driver as
        // a tool failure - including the ones whose arms sit in the driver's
        // own body, before the closure is even built.
        const withArgs = closures.filter((c) => (c.params ?? []).some((x) => !x.optional && !x.rest));
        // TOOL BACKLOG: TWO CLOSURE SHAPES WHOSE ARGUMENTS ARE THE FRAMEWORK'S,
        // NOT THE SUBJECT'S. A method decorator's `(target, propertyKey,
        // descriptor)` and an Express middleware's `(req, res, next)` are
        // supplied by TypeScript and by Express, identically for every
        // service, so the recorder supplies them too rather than refusing the
        // row as a tool failure (pricing-ms `cache`, `invalidateCache`,
        // `Transaction`; outreach `validateQuery`). A closure of any other
        // shape is still refused: its arguments are the subject's input.
        const shape = withArgs.length === closures.length ? frameworkClosureShape(withArgs) : null;
        if (shape) {
          // The decorated METHOD is called too when the arm lives inside what
          // the decorator installs (`descriptor.value = async function ...`),
          // and not when the arm is the decorator's own body - calling the
          // method there would run code the claim is not about.
          const armIsClosure = withArgs.some((c) => c.id === armOwner.id);
          invokeReturned = { of: "<returned closure>", synthesize: shape, callMethod: shape === "decorator" && !armIsClosure };
        } else if (withArgs.length === closures.length) {
          return {
            runnable: false,
            reason:
              `the driver returns a closure taking ${withArgs[0].params.length} argument(s) ` +
              `(${withArgs[0].params.map((x) => paramName(x.name)).join(", ")}) that no proposal supplies - stage 3 has to write them`,
          };
        } else {
          invokeReturned = { of: "<returned closure>" };
        }
      }
    }
  }

  // ---- setup directives -------------------------------------------------
  // `env` is applied and restored per row; `module: "fresh"` is what every row
  // already gets (vi.resetModules() is unconditional); `call` is executed as a
  // precondition. `manual` and `db` are the two this harness genuinely cannot
  // apply: one needs a hand-built arrangement, the other a write to shared
  // staging config.
  const env = {};
  const calls = [];
  /** Rows that must exist before the subject runs. Journalled, never swallowed. */
  const seeds = [];
  // `setup` IS AGENT-WRITTEN, AND THIS LOOP ASSUMED IT WAS A LIST OF OBJECTS.
  //
  // `(proposal.setup ?? []).entries()` throws "is not a function" for
  // `"setup": {}`, and `e.apply` throws "Cannot read properties of null" for a
  // null entry — both out of the whole record step, which ends the round for
  // every other proposal in it. That is the shape that cost run
  // 20260918T094824Z (tracy-worker, round 2) its 19 unrecorded proposals, 18 of
  // them well formed. Refused by ROW here, in the same words the null-boundary
  // refusal below uses: this proposal does not record, the reason names the
  // field and the index, and the round keeps everything else.
  if (proposal.setup !== undefined && !Array.isArray(proposal.setup)) {
    return {
      runnable: false,
      reason:
        `setup is ${proposal.setup === null ? "null" : typeof proposal.setup} — it must be an array of ` +
        `{ state, apply } entries, because each entry is one precondition this harness arranges and reverts`,
    };
  }
  for (const [i, e] of (proposal.setup ?? []).entries()) {
    // `e.apply ?? {}` guarded `apply` being absent, never `e` being empty.
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      return {
        runnable: false,
        reason:
          `setup[${i}] is ${e === null ? "null" : Array.isArray(e) ? "an array" : typeof e} — a setup entry ` +
          `must be an object carrying an \`apply\` directive, because that is what says which precondition to arrange`,
      };
    }
    const apply = e.apply ?? {};
    // D43: the reason says what to write instead, and it is the proposal's
    // (repair.mjs): the contract refuses `manual` outright, and ats-sourcing-
    // service's two rows (the mocked run of September 26) wrote one for a
    // precondition an instance-field boundary arranges.
    if (apply.manual !== undefined) {
      return {
        runnable: false,
        reason:
          "setup needs manual - a hand-built harness, not a directive" +
          `: setup[${i}] must arrange its state as { env }, { call } or { db }, or as a boundary - a field the subject reads is one, ` +
          `with "module": "<instance field>" - and a side no directive can arrange is declared, not written as manual`,
      };
    }
    // A `db` directive is a row that has to EXIST for the arm to be reachable.
    // Measured on staging: all 181 api_key rows are well-formed - every one has
    // langfuse keys, every one's provider key JSON parses, none has an empty
    // modelName - so the guards at getAiModelV1.service.ts:458-460 cannot be
    // reached by any row that is there. They are not dead: `langfuse_key` is a
    // nullable column and `modelName` is a bare `z.string()`, so the state is
    // permitted, just absent. That is an INPUT problem, and the input is a row.
    //
    // Allowed only under --live, where every write is journalled and
    // reverse-replayed with verification at the end of the run. A seed is NOT
    // a `calls` entry: those swallow failures as "precondition already
    // satisfied", and a silently-unseeded row would record the arm it was
    // trying to leave behind.
    if (apply.db !== undefined) {
      // TOOL BACKLOG: A MOCKED RUN SEEDS A DOUBLE, NOT STAGING. This refused
      // outright ("setup needs db - a write to staging, which only --live
      // journals and reverts"), so a mocked run could never reach an arm that
      // turns on a row existing: company-enrich `20260922T193606Z`, two sides
      // left as pipeline_defect. Nothing is written anywhere. The rows go into
      // a per-row in-memory store, and the database client's reads of that
      // model are answered from it (installSeedDouble in the spec runtime).
      const d = apply.db;
      // `d.create` was read straight off an agent-written value, so
      // `"db": null` threw here rather than being refused. The refusal below
      // already says what a db directive must be; this puts an empty one under
      // the same sentence instead of under a stack trace.
      if (d === null || typeof d !== "object" || !d.create || !d.create.model || !d.create.data) {
        return { runnable: false, reason: "setup.apply.db supports { create: { model, data } } only - an undo has to be derivable" };
      }
      seeds.push({ model: d.create.model, data: d.create.data, index: i });
      continue;
    }
    // A mocked row may not hand its subject a database either (defence in
    // depth, tool backlog): a DSN a proposal writes is masked like the shell's.
    // `null` is UNSET (review B1): the row deletes the var and the teardown puts
    // it back. It is the only way to reach the missing-env side of a var the
    // run stood in for (standins.mjs), or of one staging supplies.
    if (apply.env) for (const [k, v] of Object.entries(apply.env)) env[k] = v === null ? null : !LIVE && isDatabaseVar(k, v) ? databasePlaceholder(k, v) : v;
    if (apply.module !== undefined) continue; // "fresh" - every row resets the registry
    if (apply.call !== undefined) {
      if (!isExpression(apply.call, { async: true })) return { runnable: false, reason: `setup[${i}].apply.call is not an executable expression` };
      calls.push(apply.call);
    }
  }

  // ---- args -------------------------------------------------------------
  // THE SAME REFUSAL AS `setup`, FOR THE SAME REASON: the recorder does not
  // require validate.mjs to have passed, so `args` arrives here as whatever the
  // agent wrote. An object throws "is not a function" off `.entries()` and a
  // null entry throws off `a.build` — each of them taking the round down rather
  // than the row.
  if (proposal.args !== undefined && !Array.isArray(proposal.args)) {
    return {
      runnable: false,
      reason:
        `args is ${proposal.args === null ? "null" : typeof proposal.args} — it must be an array, positional, ` +
        `one entry per declared parameter, because position is the only thing that says which parameter a value is for`,
    };
  }
  for (const [i, a] of (proposal.args ?? []).entries()) {
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      return {
        runnable: false,
        reason:
          `args[${i}] is ${a === null ? "null" : Array.isArray(a) ? "an array" : typeof a} — an argument must be ` +
          `an object carrying a \`value\` or a \`build\`, because an empty entry says neither what to pass nor how to make it`,
      };
    }
    const expr = a.build ?? a.construct;
    if (expr !== undefined && !isExpression(expr)) {
      // isExpression parses with `new Function`, which is not an async
      // context, so a TOP-LEVEL `await` in the build has always been refused
      // here - it just said "no executable build", which reads as a typo. The
      // build is awaited at the call site now (see writeSpec), so the value an
      // async expression PRODUCES is fine; only the `await` keyword itself
      // cannot survive this check. Say which, and name the recipe that owns
      // asynchrony, instead of leaving the author to guess.
      const asyncish = typeof expr === "string" && /\bawait\b|\basync\b/.test(expr);
      return {
        runnable: false,
        reason: asyncish
          ? `args[${i}].build uses await/async, which this expression check cannot parse - move the asynchronous part into \`invoke.build\` (that recipe is awaited and may await), and pass its result, or use a build that RETURNS a promise: args[].build is awaited at the call site`
          : `args[${i}] has no executable build`,
      };
    }
    // `message = "A".repeat(3000)` parses, but it ASSIGNS to an undeclared name
    // instead of producing the argument. Inlining it records
    // `ReferenceError: message is not defined` as this service's behaviour,
    // which is exactly the class of pair this pipeline exists to prevent. It is
    // a stage-3 defect to report, not an input to repair here.
    if (typeof expr === "string" && /^\s*[A-Za-z_$][\w$]*\s*=[^=>]/.test(expr)) {
      return { runnable: false, reason: `args[${i}].build is an assignment, not a value expression` };
    }
  }

  // ---- boundaries -------------------------------------------------------
  //
  // A PROPOSAL THAT BUILDS ITS OWN SUBJECT STILL HAS TO NAME A FUNCTION THE
  // SCAN KNOWS.
  //
  // `subject` is deliberately left unset on the `invoke.build` path: a
  // proposal that builds its own callable is not reached through the driver in
  // `via`, so neither branch above resolves one, and `nested` - the scan's
  // record for `proposal.functionId` - is what carries the file and the
  // boundary list from here on. When the scan does not hold that functionId
  // either, BOTH are undefined and this line was `undefined.file`:
  //
  //   TypeError: Cannot read properties of undefined (reading 'file')
  //       at classify (record.mjs:1093)
  //
  // which is not a refusal, it is the end of the round. Measured on run
  // 20260918T105518Z (notification-ms, round 2): six proposals across
  // expand-20-rung.json, expand-30-rung.json, slack.json and telegram.json name
  // functionIds like `src/services/slackAuth.service.ts:172:_sendWelcomeDm`
  // that the current scan does not have - the source moved under inputs written
  // against an older scan. validate.mjs quarantines a wrong `covers` armId and
  // says nothing about `functionId`, so these reach the recorder, and one of
  // them took every other row in the round down with it.
  //
  // The two branches above already refuse exactly this with
  // "functionId not in scan.json". This is that refusal on the path that had
  // none: the row does not record, the reason names the id to look for, and the
  // round keeps the proposals that ARE addressed at code that exists.
  if (!nested && !subject) {
    return {
      runnable: false,
      // D68: the same sentence as the other two paths, so it is read as the
      // proposal's; what is particular to this path follows it.
      reason:
        staleFunctionIdReason(proposal, resolveFunctionId(fnIndex, proposal).why) +
        ` - the proposal builds its own subject, so the scan's record for that function is the only source of its file and boundaries`,
    };
  }
  const ownerFile = (nested ?? subject).file;
  const own = new Map(((nested ?? subject).boundaries ?? []).map((b) => [b.symbol, b]));
  const fileMap = byFile.get(ownerFile) ?? new Map();
  const mocks = [];
  // Every declared module boundary, whatever its kind, so a build that names
  // one can have it bound (scopeFor, and the mock factories).
  const bindable = [];
  // Answers destined for the SUBJECT'S CONSTRUCTOR rather than for a module.
  const ctorArgs = [];
  for (const [name, b] of Object.entries(proposal.boundaries ?? {})) {
    // A NULL BOUNDARY IS A MALFORMED ANSWER, NOT A CRASH.
    //
    // `b.mock?.kind` guards `mock` being absent and not `b` being null, so a
    // proposal carrying `"boundaries": { "fetch": null }` threw
    // `Cannot read properties of null (reading 'mock')` out of the whole record
    // step and took the round with it — one bad entry in one proposal ending a
    // round that had 18 good ones. Measured on run 20260918T094824Z
    // (tracy-worker, round 2), the first graphile target anyone has run.
    //
    // Refused by row and named, the way an unrunnable `args[i].build` is above:
    // the row does not record, the reason says which symbol in which proposal,
    // and every other row in the round still goes through.
    if (b === null || typeof b !== "object") {
      return {
        runnable: false,
        reason:
          `boundaries[${JSON.stringify(name)}] is ${b === null ? "null" : typeof b} — a boundary ` +
          `must be an object carrying at least a \`mock\`, because that is what says whether the ` +
          `real export runs or an answer substitutes for it. An empty entry says neither.`,
      };
    }
    const kind = b.mock?.kind;
    // `passthrough` substitutes nothing BY DEFINITION - "the real export runs"
    // is the whole of what it says - so it is dropped here as it always was.
    // `value` substitutes the answer it carries (see SUBSTITUTE_MOCK), and is
    // dropped only when it carries none.
    const disposition = boundaryDisposition(kind, b.mock);
    // FIX PLAN 1, F3.1: AN INSTANCE FIELD DECLARED `value` WITH NO ANSWER IS
    // REFUSED BY NAME. For a module export an answer-less `value` is a
    // legitimate "this is read, not called"; for a field it is a double that was
    // described in prose and never written, and the row then ran against the
    // real field under the double's claim. pricing-ms `20260922T010226Z`: six
    // `cacheService` rows declared `this.redisClient` so, recorded, and all six
    // claims were false. The reason starts `boundary ` so it is repaired as the
    // proposal's missing declaration.
    if (
      disposition === "inert" &&
      SUBSTITUTE_MOCK.has(kind) &&
      (b.module === "<instance field>" || own.get(name)?.module === "<instance field>" || fileMap.get(name)?.module === "<instance field>")
    ) {
      return {
        runnable: false,
        reason:
          `boundary ${name} is an instance field declared \`value\` with neither a build nor a value - there is no double to set ` +
          `on the field, so the row would run against the real one while claiming the double's arm; write the double as ` +
          `mock.build, or declare it passthrough if the real field is meant`,
      };
    }
    {
      const known = own.get(name) ?? fileMap.get(name);
      const bm = GLOBAL_SPELLINGS.has(String(b.module ?? "")) ? null : (b.module ?? known?.module);
      if (bm && bm !== "<instance field>" && bm !== "globalThis" && /^[A-Za-z_$][\w$]*$/.test(name)) {
        bindable.push({ symbol: name, module: normalizeModule(bm, ownerFile), imported: b.imported ?? known?.imported ?? name });
      }
    }
    if (disposition !== "install") {
      // NEVER SILENTLY. A boundary whose kind substitutes nothing while an
      // executable answer sits beside it is a contradiction somebody has to
      // see: the row will run against the real export, and if that export is
      // behind the default-deny the row dies naming an endpoint its own
      // proposal answered. Recorded per (proposal, symbol) so the summary can
      // count it and the skip reason can quote it.
      if (disposition === "dropped-with-answer") {
        DROPPED_ANSWERS.push(droppedAnswerNote(proposal.id, name, kind, b.mock, b.module));
      }
      continue;
    }
    // A proposal may name the MODULE itself. The import map only knows symbols
    // the owner file imports directly, and a call can be several frames deeper:
    // the closure at getAiModelV1.service.ts:1128 reaches prisma.usageLog via
    // persistUsage -> recordUsage, so `recordUsage` is not in the closure's
    // own boundary list even though intercepting it is exactly right. Without
    // this, 41 rows were refused for naming a boundary that is real but not
    // adjacent.
    //
    // An explicit `module` WINS over both of those. The import map is a
    // guess made from a name; the proposal's `module` is a statement about
    // which module is to be answered, and the two are only ever consulted
    // together when they disagree - so deferring to the guess is deferring to
    // the weaker evidence. Measured on qode-ptp-ms:
    // cvProcessingSteps.ts:4 does `import { env } from 'process'`, so a
    // boundary keyed `env` carrying `"module": "@/env.mjs"` was answered at
    // node's `process`, the real config module loaded anyway, and the row
    // stayed harness-failed. Five benchmark agents each worked around it by
    // renaming the key (`envMjsConfigModule`) - a rename that only exists to
    // route around this precedence, and that leaves the boundary named after
    // the recorder instead of after the import the subject uses.
    //
    // A RESTATEMENT is not a correction: when the declared module normalizes
    // to the discovered one, the scan's entry is kept whole, because it also
    // carries `imported` ("default" for a default import), which a proposal
    // that only names the module does not. So this changes precedence for a
    // DISAGREEMENT only, and a boundary with no `module` at all resolves
    // through the import map exactly as before.
    const discovered = own.get(name) ?? fileMap.get(name);
    // TOOL BACKLOG: A GLOBAL HAS ONE SPELLING HERE, "globalThis", which is the
    // scan's and the one the installer assigns rather than module-mocks.
    // tracy-agent-be proposals wrote `fetch` at `"module": "<global>"` and at
    // `"module": "fetch"`; both were vi.doMock'd as modules nothing imports,
    // the real global stayed in place, and 2 rows of 20260922T152300Z died
    // "blocked egress: fetch ... declared AND installed". A global spelling,
    // or a module named after the symbol when the scan says that symbol is a
    // global in this file, is read as globalThis.
    const declaredModule = GLOBAL_SPELLINGS.has(String(b.module ?? "")) || (b.module === name && discovered?.module === "globalThis") ? "globalThis" : b.module;
    const declared = declaredModule ? { symbol: name, module: declaredModule, imported: b.imported ?? name } : undefined;
    const resolved =
      declared && !sameModuleId(declared.module, discovered?.module, ownerFile) ? declared : (discovered ?? declared);
    if (!resolved) {
      if (OBSERVE_MOCK.has(kind)) continue; // nothing to wrap; the call list stays empty
      return { runnable: false, reason: `boundary ${name} is not in the scan's import map for ${ownerFile}, and the proposal names no \`module\` for it` };
    }
    if (resolved.module === "<instance field>") {
      // NOT a refusal any more. "It is a private instance field, not a module
      // export" was true and the wrong conclusion: an INJECTED field does not
      // need a module substituted, it needs a CONSTRUCTOR ARGUMENT. Refusing it
      // meant the recorder could not execute any dependency-injected class
      // method - `new C()` at the driver, zero arguments, so every injected
      // field was undefined and the method failed on its first line. On a Nest
      // codebase that is most of the file, and it is the stage-4 bottleneck:
      // stage 4's job is to execute every function.
      //
      // The proposal already declares an answer for the field; it is routed to
      // the constructor by NAME instead of to the module registry.
      //
      // FIX PLAN 1, F3.1: A FIELD ANSWER THAT MATCHES NO CONSTRUCTOR PARAMETER
      // IS SET ON THE INSTANCE, NOT DROPPED. `callExpression` passes the ones
      // whose name is a constructor parameter and assigns every other one on
      // the row's own receiver after it exists: the instance the row
      // constructs, or the exported singleton (restored when the row ends).
      // Before this, `this.redisClient` on pricing-ms's `cacheService`,
      // `this.state` on tracy's agent and `this.sessions` on company-enrich
      // matched no parameter and vanished without a word - 21 of the 35 false
      // claims in the plan-1 ledger. A `spy`/`notCalled` field was dropped even
      // earlier, here, so notification-ms's `this.logger` spy left the field
      // undefined and the row threw "reading 'info'"; it is now observed on
      // the constructed instance, or refused by name when there is nothing
      // there to observe.
      if (kind === "passthrough") continue; // the real field is the answer
      if (EXECUTED_MOCK.has(kind) && b.mock.build !== undefined && !isExpression(b.mock.build)) {
        return { runnable: false, reason: `boundary ${name} mock.build is not an executable expression` };
      }
      // Both spellings, because the two sides disagree: a proposal names the
      // boundary the way the scan does (`this.repository`), while the
      // constructor parameter is called `repository`. Matching on the boundary
      // key alone meant a correctly-declared answer never reached the
      // constructor even once the field above was carried.
      ctorArgs.push({
        name,
        imported: resolved.imported ?? name,
        // The PROPERTY the double lands on when no parameter takes it.
        field: instanceFieldName(name, resolved.imported),
        kind,
        build: b.mock.build,
        value: b.mock.value,
      });
      continue;
    }
    if (EXECUTED_MOCK.has(kind) && b.mock.build !== undefined && !isExpression(b.mock.build)) {
      return { runnable: false, reason: `boundary ${name} mock.build is not an executable expression` };
    }
    // In a live run the provider path must reach the provider, so the
    // proposal's canned answer for those symbols is replaced by an OBSERVING
    // passthrough: the real call happens and both halves - request and
    // response - are written down.
    // Under the policy the DECISION is the symbol's class, not the flag: a
    // reachable downstream is answered by itself. `redis-wrong-level` is the
    // same outcome by a different argument - the cache service and the cache
    // decorator ARE the code under test, so their declaration is dropped and
    // the ioredis double below them supplies the miss.
    let live = LIVE_PROVIDERS && LIVE_SYMBOLS.has(name);
    if (MOCK_AT_IOREDIS || REAL_DOWNSTREAM) {
      // The row's own arms decide whether an answer sits below its subject or
      // at it. Same symbol, opposite verdict, depending on what is under test.
      const coveredFiles = [...new Set((proposal.covers ?? []).map((a) => String(a).split("#")[0]))];
      // The MODE travels with the question. An unnamed symbol falls back to
      // "real" only when there is a real boundary to fall back to.
      const c = classifyBoundary(name, coveredFiles, { live: LIVE });
      if (c.verdict === "unclassified") {
        return { runnable: false, reason: `boundary ${name} is not classified in policy.mjs - classify it rather than defaulting it` };
      }
      // A wrong-LEVEL answer is dropped in either mode: the double injected
      // below answers underneath it, so the real service/decorator runs.
      const wrongLevel =
        (MOCK_AT_IOREDIS && c.verdict === "redis-wrong-level") ||
        (MOCK_AT_AXIOS && c.verdict === "slack-wrong-level");
      live = wrongLevel || (REAL_DOWNSTREAM && c.verdict === "real");
      POLICY_DECISIONS.push({ symbol: name, verdict: c.verdict, why: c.why, dropped: live });
    }
    mocks.push({
      symbol: name,
      module: normalizeModule(resolved.module, ownerFile),
      imported: resolved.imported,
      kind: live ? "live" : kind,
      build: live ? undefined : b.mock.build,
      value: live ? undefined : b.mock.value,
      // D68 follow-on: the proposal's `module` won over the owner file's own
      // import of this symbol. Said by blockedReason when the call then reached
      // the default-deny through the import the file does make.
      ...(resolved === declared && discovered?.module && discovered.module !== "globalThis"
        ? { overrode: { module: normalizeModule(discovered.module, ownerFile), file: ownerFile } }
        : {}),
    });
  }

  // Redis is mocked for EVERY row under the policy, including the rows that
  // never mentioned it. A row that does not declare redis still imports a
  // module graph that constructs the singleton, and staging's REDIS_HOST is an
  // in-cluster name: a real `new Redis()` from here does not fail, it retries
  // per retryStrategy until the row times out. Answering it is what makes the
  // rest of the run reach the real database at all.
  //
  // A row that DOES declare `Redis` keeps its own answer - its arm is about
  // redis behaviour, and a miss is not what it is testing.
  // GATED ON THE MODULE BEING THERE, the same set the preconditions are read
  // over. A repo with no ioredis has nothing to cut below, and pushing a double
  // it does not export into every row fails every row on a missing helper -
  // which reads as a bad proposal and is not one.
  if (MOCK_AT_IOREDIS && moduleAvailable("ioredis") && !mocks.some((m) => m.module === "ioredis")) {
    // A ROW THAT NEEDS A DOUBLE THE REPO DOES NOT EXPORT IS SKIPPED, BY NAME.
    // This was a throw inside classify(), once per run, and it ended record.mjs
    // with exit 1 for the whole batch (fix plan 1, F1.1). Now only the rows the
    // injection would break are refused, the reason says it is the toolset's,
    // and a row that answers `ioredis` itself is not affected at all.
    const defect = assertPolicyRunnable({ policy: POLICY, module: "ioredis" });
    if (defect) return { runnable: false, reason: defect };
    mocks.push({
      symbol: "Redis",
      module: "ioredis",
      imported: "default",
      kind: "returns",
      build: "doubles.ioredisMiss()",
      value: undefined,
    });
  }

  // NODE-REDIS, ON THE SAME ARGUMENT (D34). The ioredis double above is the
  // only cache this policy injected, so a repo on node-redis v5 ran the REAL
  // client: qode-ptp-ms's redisCache.ts calls `createClient(config)` and
  // `connect()`, which dialled redis://localhost:6379 - loopback, so the egress
  // guard let it through - and got ECONNREFUSED. Its reconnect strategy retries
  // on a timer and each retry fires the service's `on("error")` listener, so a
  // varying number of `logger.error("Redis Client Error:")` calls landed in each
  // row's call list, interleaved differently each run. cigate withheld 162
  // emitted tests as "the downstream calls changed" (161 of them had those
  // calls), and their false claims quarantined 67 rows in measure.
  //
  // `createClient` is answered at each specifier the repo imports node-redis by,
  // kind "value": the export IS the double's factory, so each createClient()
  // builds a fresh connected-on-connect(), always-missing client and no socket
  // is opened. A row that answers the module itself keeps its own answer, and a
  // repo whose doubles.ts lacks the factory has those rows skipped by name.
  if (MOCK_AT_IOREDIS) {
    for (const mod of nodeRedisModules()) {
      if (mocks.some((m) => m.module === mod)) continue;
      const defect = assertPolicyRunnable({ policy: POLICY, module: mod });
      if (defect) return { runnable: false, reason: defect };
      mocks.push({
        symbol: "createClient",
        module: mod,
        imported: "createClient",
        kind: "value",
        build: "doubles.nodeRedisMiss()",
        value: undefined,
      });
    }
  }

  // Slack, on the same argument. `axios` is imported by slack.service.ts and
  // sendErrorToSlack.ts and by nothing else in src, so answering it silences
  // Slack exactly. It is injected for EVERY row because the send is fired and
  // not awaited - langfuse.service.ts:143 and loggerV2.ts:160 both reach it
  // from paths that have nothing to do with Slack - and an un-awaited POST to
  // a denied host became a blocked-egress refusal on 14 rows that never
  // mentioned Slack at all.
  if (MOCK_AT_AXIOS && moduleAvailable("axios") && !mocks.some((m) => m.module === "axios")) {
    const defect = assertPolicyRunnable({ policy: POLICY, module: "axios" });
    if (defect) return { runnable: false, reason: defect };
    mocks.push({
      symbol: "axios",
      module: "axios",
      imported: "default",
      kind: "returns",
      build: "doubles.axiosSilenced()",
      value: undefined,
    });
  }

  if (builtSubject) {
    return {
      runnable: true,
      fn: fnIndex.get(proposal.functionId) ?? subject,
      entry: { kind: "built-subject", build: builtSubject },
      env,
      calls,
      seeds,
      mocks,
      // The subject IS the decorated callable, so there is no returned closure
      // to chase - calling it again would invoke whatever it happened to return.
      invokeReturned: null,
      // `?? []` silently threw away a proposal's own args[] whenever it also
      // used invoke.build - so a built subject could only ever be called with
      // plain JSON, and args[].build was dead. Measured directly: a probe row
      // on profile-centralized passed doubles.expressResponse() through args[]
      // and the method threw
      // "Cannot read properties of undefined (reading 'status')" because res
      // never arrived.
      //
      // invoke.args still WINS when present - it is the more specific
      // statement - but its absence now falls through to args[] rather than to
      // nothing, which also keeps each value's provenance, since `from` lives
      // on args[] and invoke.args has no place for it.
      builtArgs: proposal.invoke.args ?? null,
    };
  }
  // FIX PLAN 1, F3.1: a field answer that cannot land is a named skip, never
  // a silent drop. A constructor parameter still takes it by name; anything
  // else needs a receiver (see fieldReceiver).
  const params = entry?.kind === "class-method" && entry.member !== "constructor" ? (entry.ctorParams ?? []) : [];
  const homeless = ctorArgs.filter(
    (a) => !(ACTIVE_MOCK.has(a.kind) || SUBSTITUTE_MOCK.has(a.kind)) || !params.some((prm) => prm.name === a.name || prm.name === a.imported)
  );
  // D43: A CONSTRUCTOR SUBJECT ASSIGNS ITS OWN FIELDS. ats-sourcing-service,
  // the mocked run of September 26: App's constructor runs `this.app =
  // express()` and then registers middleware on it, and two rows answered
  // `this.app` as an instance field. No instance exists before the
  // constructor runs, and one set after it is too late, so no receiver can
  // ever take the double: the answer belongs to the call the field is built
  // from, at its module. The proposal's to repair, said so.
  if (homeless.length && entry?.kind === "class-method" && entry.member === "constructor") {
    const names = homeless.map((a) => a.name).join(", ");
    return {
      runnable: false,
      reason:
        `instance field ${names} has no receiver in this row: the subject is the constructor itself, which assigns its own fields ` +
        `before any instance exists to set ${homeless.length === 1 ? "it" : "them"} on, and would overwrite a double set earlier - ` +
        `answer what the constructor builds ${homeless.length === 1 ? "it" : "them"} from, as a boundary at that module ` +
        `(\`this.app = express()\` is answered by declaring express), or drive the row through a method of an instance`,
    };
  }
  // D43: A VIA THE SCAN NO LONGER RESOLVES. ats-sourcing-service's three
  // withRateLimitRetry rows drove a callback inside a private UnifiedService
  // method through `via "...:759:pickResume"`, which the scan had named only
  // because of a {@link} in pickResume's JSDoc (scan.mjs inDocComment). The
  // scan now drives it through `export unifiedService`, whose singleton takes
  // `this.sdk`. The missing receiver is the stale via's, so it is the
  // proposal's, said with the driver to write (validate.mjs refuses the same
  // via). Only here: a row that records under such a via is left alone.
  const scanDrivers = (() => {
    const v = scanVia(nested);
    return v && v.kind !== "trigger" ? (v.drivers ?? [v.driver]).filter(Boolean) : [];
  })();
  if (homeless.length && !fieldReceiver(entry) && proposal.via && scanDrivers.length && !scanDrivers.includes(proposal.via)) {
    return {
      runnable: false,
      reason:
        `instance field ${homeless.map((a) => a.name).join(", ")} has no receiver in this row: via "${proposal.via}" is not a driver the scan resolves for ` +
        `${proposal.functionId} - it resolves it through ${scanDrivers.map((d) => `"${d}"`).join(" | ")}; write that via, whose receiver can take the field`,
    };
  }
  if (homeless.length && !fieldReceiver(entry)) {
    return {
      runnable: false,
      reason:
        `instance field ${homeless.map((a) => a.name).join(", ")} has no receiver in this row: the subject is ` +
        `${entry?.kind === "class-method" ? "the constructor itself" : `a ${entry?.kind ?? "subject"} entry`}, which neither takes ` +
        `${homeless.length === 1 ? "it" : "them"} as a constructor parameter nor leaves an instance or singleton to set ` +
        `${homeless.length === 1 ? "it" : "them"} on - declare the collaborator at its module, or drive the row through the class`,
    };
  }
  return { runnable: true, fn: subject, entry, env, calls, seeds, mocks, ctorArgs, invokeReturned, bindable };
}


/**
 * "decorator" | "middleware" | null: whether every candidate closure takes the
 * arguments a framework hands it. Read from the parameter NAMES the scan
 * recorded, which is how these are written in every service: a legacy method
 * decorator's (target, propertyKey, descriptor) and Express's (req, res, next),
 * each with an optional leading underscore.
 */
function frameworkClosureShape(closures) {
  const names = (c) => (c.params ?? []).map((x) => paramName(x.name).replace(/^_+/, "").toLowerCase());
  const isDecorator = (n) => n.length === 3 && /^target$/.test(n[0]) && /^(propertykey|key|propertyname|name|methodname)$/.test(n[1]) && /^(descriptor|desc)$/.test(n[2]);
  const isMiddleware = (n) => n.length === 3 && /^(req|request)$/.test(n[0]) && /^(res|response)$/.test(n[1]) && /^next$/.test(n[2]);
  if (closures.every((c) => isDecorator(names(c)))) return "decorator";
  if (closures.every((c) => isMiddleware(names(c)))) return "middleware";
  return null;
}

/**
 * The spec lines that call the closure a driver returned. The framework's own
 * arguments are built here, per row, so nothing survives the row:
 *
 *   decorator   a fresh class with one method; the closure decorates it the
 *               way TypeScript does (prototype, key, own descriptor). When the
 *               arm is in what the decorator installs, the decorated method is
 *               then called on an instance - with no arguments, since the
 *               row's own args went to the decorator factory. The method
 *               answers what it was called with.
 *   middleware  doubles.expressRequest/Response/Next, the template's Express
 *               contract. The row answers what the middleware returned and
 *               what it handed `next`.
 *   (none)      the closure takes no arguments and is simply called.
 */
function closureCall(ir) {
  if (ir?.synthesize === "decorator") {
    return [
      "        const __C = class CharpilotDecorated { charpilotMethod(...a) { return { charpilotMethodCalledWith: a }; } };",
      '        const __d = Object.getOwnPropertyDescriptor(__C.prototype, "charpilotMethod");',
      '        const __r = await first(__C.prototype, "charpilotMethod", __d);',
      '        const __desc = __r && typeof __r === "object" && typeof __r.value === "function" ? __r : __d;',
      ir.callMethod
        ? "        return await drainIfIterator(await __desc.value.call(new __C()));"
        : "        return __r;",
    ].join("\n");
  }
  if (ir?.synthesize === "middleware") {
    return [
      "        const __req = doubles.expressRequest(); const __res = doubles.expressResponse(); const __next = doubles.expressNext();",
      "        const __out = await first(__req, __res, __next);",
      "        return { returned: __out, nextCalledWith: __next.calls };",
    ].join("\n");
  }
  return "        return await drainIfIterator(await first());";
}

/**
 * The specifier a row imports its subject's module by, as a JS string literal;
 * null for a subject the proposal builds itself, which imports nothing.
 *
 * The SUBJECT import went through a blanket `src/` -> `@/` rewrite while the
 * boundary modules beside it went through aliasSpelling. Same picker here:
 * the target's config is the authority, and a path it cannot resolve either
 * way is left as the scan produced it.
 */
/**
 * The repo's setup files, read once per process (hostsetup.mjs): what every
 * row undoes before its own arrangement, so it replays under the repo's own
 * config in the world the recording saw. Unreadable is "nothing to undo".
 */
let HOST_SETUP = null;
function hostSetupOnce() {
  if (HOST_SETUP === null) {
    try {
      HOST_SETUP = hostSetup(REPO_ROOT);
    } catch {
      HOST_SETUP = { files: [], mocks: [], env: [], fakeTimers: false, stubsGlobals: false };
    }
  }
  return HOST_SETUP;
}

export function subjectSpecifier(entry) {
  if (!entry || entry.kind === "built-subject" || typeof entry.module !== "string") return null;
  const bare = entry.module.replace(/\.ts$/, "");
  return JSON.stringify(bare.startsWith("src/") ? srcSpelling(bare) : (aliasSpelling(bare) ?? bare));
}

/**
 * D73: THE MODULES THAT CLOSE AN IMPORT CYCLE THROUGH THE SUBJECT'S MODULE.
 *
 * qode-ptp-ms 20260927T142354Z (mocked) lost 23 sides of
 * recruiterActionHistory/candidateTimeline.service.ts, in 11 rows, as
 * pipeline_defect: "__vite_ssr_import_0__.CandidateTimelineService is not a
 * constructor". It looked like a double that is not constructible, and it is
 * not one: no row answered CandidateTimelineService at all, and one declared
 * no boundary. The module is on an import cycle:
 *   candidateTimeline.service.ts -> ../sdCandidateService -> candidateService
 *   -> recruiterAction/index.ts -> recruiterActionHistory/index.ts
 * and index.ts imports the class back and runs `new CandidateTimelineService()`
 * at load. The row imports the subject's module FIRST, so the back edge reads
 * it half-evaluated, with the class not yet defined, and the load dies before
 * the subject is entered. The service never loads the module in that order:
 * everything that uses it imports it through index.ts, which imports it
 * whole before using it. The 7 rows of that file that recorded had answered
 * sdCandidateService, which cut the cycle by accident. The proposal cannot
 * see the cycle and has nothing to answer, so this is the harness's.
 *
 * So the spec is told which files import the subject's module directly AND
 * are reached by the module's own imports. The row still imports the subject
 * first. Only a load that dies in one of those files is retried, entering the
 * cycle at that file (charpilotThroughCycle, in the spec). Read off the static
 * graph (sourcedeps.mjs). A type-only edge can list a file that is not a
 * runtime importer, and that costs nothing: nothing is retried unless the
 * runtime failure's first repo frame is in that file. `graph` null (ts-morph
 * did not load) means no cycle is known, and the import is written as before.
 */
let CYCLE_GRAPH = null;
const CYCLE_IMPORTERS = new Map();
export function cycleImporters(graph, subjectRel) {
  if (!graph || typeof subjectRel !== "string" || !subjectRel) return [];
  const s = subjectRel.replace(/\\/g, "/");
  try {
    return graph.closureOf([s]).filter((f) => f !== s && graph.importsOf(f).includes(s)).sort();
  } catch {
    return [];
  }
}
function cycleImportersOnce(subjectRel) {
  if (!CYCLE_GRAPH || typeof subjectRel !== "string") return [];
  if (!CYCLE_IMPORTERS.has(subjectRel)) CYCLE_IMPORTERS.set(subjectRel, cycleImporters(CYCLE_GRAPH, subjectRel));
  return CYCLE_IMPORTERS.get(subjectRel);
}
/**
 * D73, THE SAME RUN: A CLASS'S SINGLETON IS EXPORTED FROM ANOTHER MODULE.
 *
 * checkConditionToShowActionHistoryBaseOnEmailDom-545-if-0 names
 * `via: "export candidateTimelineService"`, which is what the scan lists for
 * the class's private method (through-class-holder). The binding is exported
 * by recruiterActionHistory/index.ts, and the row imported it from the
 * class's own module, candidateTimeline.service.ts, which does not export it.
 * With the cycle entered correctly the row died "Cannot read properties of
 * undefined (reading 'checkConditionToShowActionHistoryBaseOnEmailDomain')",
 * and 1 side would have been a pipeline_defect again. The two
 * checkActionRelatedToInterview rows of that file died the same way.
 *
 * So the binding is imported from the one module that declares
 * `export const <binding>` and imports the class's module. The class's own
 * module wins when it declares the binding itself. With no such module, or
 * more than one, nothing is guessed and the module stays as the scan gave it.
 * `holders` maps a binding to the repo files that declare it exported, and
 * `importsOf` gives a file's direct repo imports (sourcedeps.mjs).
 */
export function bindingHolder(binding, module, holders, importsOf) {
  if (typeof binding !== "string" || typeof module !== "string") return module;
  const declared = holders.get(binding) ?? [];
  if (declared.includes(module)) return module;
  const hit = declared.filter((f) => {
    try {
      return importsOf(f).includes(module);
    } catch {
      return false;
    }
  });
  return hit.length === 1 ? hit[0] : module;
}
let BINDING_HOLDERS = null;
const EXPORTED_BINDING = /\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
function bindingHolders() {
  if (BINDING_HOLDERS) return BINDING_HOLDERS;
  BINDING_HOLDERS = new Map();
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(e.name) || /\.d\.[cm]?ts$/.test(e.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(e.name)) continue;
      let text = "";
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      const rel = relative(REPO_ROOT, p).split(sep).join("/");
      for (const m of text.matchAll(EXPORTED_BINDING)) {
        const list = BINDING_HOLDERS.get(m[1]) ?? [];
        if (!list.includes(rel)) list.push(rel);
        BINDING_HOLDERS.set(m[1], list);
      }
    }
  };
  walk(SRC_ROOT);
  return BINDING_HOLDERS;
}
function bindingHolderOnce(binding, module) {
  if (!CYCLE_GRAPH) return module;
  return bindingHolder(binding, module, bindingHolders(), (f) => CYCLE_GRAPH.importsOf(f));
}
/**
 * The import of the subject's module, as the row's statement. Plain when the
 * module is on no cycle. Otherwise the import goes through
 * charpilotThroughCycle with each cycle importer's own import beside it.
 * `importers` defaults to what the module graph says (cycleImportersOnce).
 */
export function subjectImportStatement(v, mod, entry, importers = cycleImportersOnce(entry?.module)) {
  if (!importers.length) return `const ${v} = await import(${mod});`;
  const via = importers.map((f) => `[${JSON.stringify(f)}, () => import(${subjectSpecifier({ kind: "exported-binding", module: f })})]`);
  return `const ${v} = await charpilotThroughCycle(() => import(${mod}), [${via.join(", ")}]);`;
}

/**
 * D43: THE NAMES A ROW'S OWN BUILDS WRITE, for the spec's buildUnboundName:
 * `builds` is [{ where, words }] for invoke.build and each args[i].build
 * (string literals dropped, so a word inside one is not a name), and
 * `exports` maps each word the subject's own file exports to that file, so the
 * failure can say where to import it from. Text only; an unreadable file
 * exports nothing.
 */
function buildNamesOf(row) {
  const words = (t) => [...new Set(String(t ?? "").replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g, " ").match(/[A-Za-z_$][\w$]*/g) ?? [])];
  const builds = [];
  if (row.entry?.kind === "built-subject") builds.push({ where: "invoke.build", words: words(row.entry.build) });
  (row.args ?? []).forEach((a, i) => {
    if (typeof a?.build === "string") builds.push({ where: `args[${i}].build`, words: words(a.build) });
  });
  const file = String(row.functionId ?? "").split(":")[0];
  let text = "";
  try {
    if (/\.[cm]?[jt]sx?$/.test(file)) text = readFileSync(join(REPO_ROOT, file), "utf8");
  } catch {
    // unreadable: exports nothing
  }
  const exports = {};
  for (const w of new Set(builds.flatMap((b) => b.words))) {
    const n = w.replace(/\$/g, "\\$");
    const declared = new RegExp(`\\bexport\\s+(?:declare\\s+)?(?:const|let|var|(?:async\\s+)?function\\*?|(?:abstract\\s+)?class|enum)\\s+${n}(?![\\w$])`);
    const listed = new RegExp(`\\bexport\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`);
    if (text && (declared.test(text) || listed.test(text))) exports[w] = file.replace(/\.[cm]?[jt]sx?$/, "");
  }
  return { builds: builds.filter((b) => b.words.length), exports };
}

/**
 * The module a row must run REAL under the repo's setup file, as a JS string
 * literal: its subject's module, or null when there is none to name.
 *
 * A BUILT SUBJECT HAS ONE TOO. `subjectSpecifier` is null for a subject the
 * proposal builds (`invoke.build`), because the row imports nothing itself —
 * but the build does. A callback handed anonymously to a library call is only
 * reachable that way: ai-centralization's loggerV2.ts (September 2026) passes
 * its trace-id format to `winston.format(...)`, so the row mocks winston,
 * imports `@/utils/loggerV2` and captures the callback; logger.ts's
 * `getTraceId` has no export, so the row imports `@/utils/logger` and logs.
 * That repo's test/setup.ts mocks both modules for every test file. The
 * recording (no setup file) ran the real code and verified every claim; under
 * the repo's own config the build imported the setup file's fake, captured
 * nothing ("invoke.build evaluated to undefined") or logged into a `vi.fn`
 * ("the downstream calls changed: expected []"), cigate withheld all five rows
 * and their four sides stalled open with no input or declaration able to move
 * them. The module is read off the row's functionId — the file its sides are
 * in, which is the module the build has to load for the recording to have
 * reached them.
 */
export function unmockSpecifier(entry, functionId = null) {
  if (entry?.kind !== "built-subject") return subjectSpecifier(entry);
  const file = String(functionId ?? "").split(":")[0];
  if (!/\.[cm]?[jt]sx?$/.test(file)) return null;
  return subjectSpecifier({ kind: "exported-binding", module: file });
}

function callExpression(entry, i, ctorArgs) {
  // The proposal built its own subject: nothing to import, and the expression
  // may be async (doubles.redisCacheDecorated dynamically imports the
  // decorator), so it is awaited.
  if (entry.kind === "built-subject") {
    // The build is the proposal's own code: a throw from it is marked, so the
    // harness failure says whose it is (charpilotBuildFailed).
    // A require() of a repo module in it is served through vite (repoRequires).
    const viaVite = repoRequires(entry.build);
    const shadow = viaVite.length ? `const require = await charpilotRepoRequire(${JSON.stringify(viaVite)}); ` : "";
    return { imp: `const s${i} = await (async () => { try { ${shadow}return await (${markSubjectImports(retargetSpecifiers(entry.build))}); } catch (e) { throw charpilotBuildFailed(e); } })();`, call: `s${i}` };
  }
  const mod = subjectSpecifier(entry);
  const v = `m${i}`;
  // FIX PLAN 1, F3.1: the field answers no constructor parameter took, set on
  // the row's own receiver once it exists. `restore` is the row's teardown list
  // (__restore, declared per row in the spec) for a receiver that outlives the
  // row - a singleton or a class; an instance the row built needs none.
  const ctorTakes = entry.kind === "class-method" && entry.member !== "constructor" ? (entry.ctorParams ?? []) : [];
  const takenByCtor = (a) =>
    (ACTIVE_MOCK.has(a.kind) || SUBSTITUTE_MOCK.has(a.kind)) && ctorTakes.some((prm) => prm.name === a.name || prm.name === a.imported);
  const fieldArgs = (ctorArgs ?? []).filter((a) => !takenByCtor(a));
  const setFields = (holder, restore) =>
    fieldArgs
      .map((a) => {
        // PARENTHESISED either way. A value answer is JSON, and an object literal
        // after `=>` parses as a BLOCK: outreach-thread-ms PR #143 emitted
        //   setField(inst, "createThreadAndSend", ..., () => {"threadId":"thread-1",...}, null)
        // which is a syntax error - the whole spec file failed to load (TS1005
        // in the repo's tsc, and every row in the file lost).
        const answer = a.build !== undefined ? `(${retargetSpecifiers(a.build)})` : `(${JSON.stringify(a.value ?? null)})`;
        const make = ACTIVE_MOCK.has(a.kind) || SUBSTITUTE_MOCK.has(a.kind) ? `() => ${answer}` : "undefined";
        return ` setField(${holder}, ${JSON.stringify(a.field ?? instanceFieldName(a.name, a.imported))}, ${JSON.stringify(a.name)}, ${JSON.stringify(a.kind)}, ${make}, ${restore});`;
      })
      .join("");
  switch (entry.kind) {
    // FIX ROUND 4: THE IMPORT IS THE SUBJECT CALL. A module-scope arm runs when
    // its module is evaluated - image-forwarder's blobService.ts throws at top
    // level without its Azure credentials - so the row imports the module
    // under its own `apply.env`, INSIDE the subject window (every row already
    // resets the registry, so the top level runs again). What it records is
    // the module's behaviour on load: the names it exports, or - through the
    // same catch as any call - what it threw, as `threw`.
    // A binding's immediately invoked initializer adds the value the binding
    // came out as, which is what that function returned.
    // D50: the import is marked, so a cold one is bounded by the import
    // allowance and not by the row budget (charpilotSubjectImport).
    case "module-import":
      return {
        imp: "// module-import: importing the module is the subject call",
        call: entry.binding
          ? `(async () => { const ${v} = await charpilotSubjectImport(() => import(${mod})); return { exports: Object.keys(${v}).sort(), value: ${v}[${JSON.stringify(entry.binding)}] }; })`
          : `(async () => { const ${v} = await charpilotSubjectImport(() => import(${mod})); return { exports: Object.keys(${v}).sort() }; })`,
      };
    case "import-named":
      return { imp: subjectImportStatement(v, mod, entry), call: `${v}[${JSON.stringify(entry.symbol)}]` };
    case "import-default":
      return { imp: subjectImportStatement(v, mod, entry), call: `${v}.default` };
    case "import-named-property":
      return { imp: subjectImportStatement(v, mod, entry), call: `${v}[${JSON.stringify(entry.symbol)}][${JSON.stringify(entry.property)}]` };
    case "class-static":
      // BOUND to the class. A static that calls a sibling static through `this`
      // - RoleBaseServiceUtils.filterResources reaches this.resolvePath at
      // roleBaseServiceUtils.ts:48 - got `this === undefined` and threw a
      // TypeError attributable to the harness, not the service. pricing-ms's
      // agent avoided it by deriving an input that never reaches that line and
      // saying so in the rationale, which is honest and does not help the next
      // one. The class-method and exported-binding recipes already bind to
      // their receiver; this is the same.
      return {
        imp: subjectImportStatement(v, mod, entry),
        // A handler held in an object a static field holds (scan.mjs
        // deriveEntry): the field is the member, the handler one property of it.
        call: entry.property != null
          ? `(() => { const C = ${v}[${JSON.stringify(entry.classDefaultExport ? "default" : entry.className)}];${setFields("C", "__restore")} const o = C[${JSON.stringify(entry.member)}]; return o[${JSON.stringify(entry.property)}].bind(o); })()`
          : fieldArgs.length
          ? `(() => { const C = ${v}[${JSON.stringify(entry.className)}];${setFields("C", "__restore")} return C[${JSON.stringify(entry.member)}].bind(C); })()`
          : `${v}[${JSON.stringify(entry.className)}][${JSON.stringify(entry.member)}].bind(${v}[${JSON.stringify(entry.className)}])`,
      };
    case "exported-binding":
      return {
        imp: subjectImportStatement(v, mod, entry),
        // A STATIC member is not on the binding - `loggerV2.getInstance` is
        // undefined because getInstance lives on the class, and the class is
        // not exported. The instance's constructor is the only handle on it,
        // and without this fallback both getInstance rows recorded
        // "entry did not resolve to a function".
        // The constructor case got the new-wrap in the class-method branch and
        // not here, and this is the branch the scan picks for a class that is
        // NOT exported but has an exported singleton: b["constructor"] is the
        // class, .bind() changes nothing, and calling it throws "cannot be
        // invoked without 'new'". profile-centralized hit it on
        // ShLinkRepository.constructor and worked around it with a hand-written
        // invoke.build doing exactly what this now does.
        call:
          entry.member === "constructor"
            ? `(() => { const b = ${v}[${JSON.stringify(entry.binding)}]; const C = b.constructor; return (...a) => new C(...a); })()`
            : `(() => { const b = ${v}[${JSON.stringify(entry.binding)}];${setFields("b", "__restore")} const k = ${JSON.stringify(entry.member)}; let t = b[k]; if (typeof t !== "function" && b && b.constructor) t = b.constructor[k]; return typeof t === "function" ? t.bind(typeof b[k] === "function" ? b : b.constructor) : t; })()`,
      };
    case "class-method": {
      const holder = entry.classDefaultExport ? "default" : entry.className;
      // `new C()` with zero arguments was unconditional, while the scan had
      // recorded `entry.ctorParams` all along and nothing read it. So a class
      // with an empty constructor worked and every dependency-injected one got
      // an instance whose collaborators were undefined.
      //
      // Positional, by NAME: each ctorParam is matched to the answer the
      // proposal declared for that field. A param with no answer stays
      // `undefined`, which is what it was before - so a class that used to work
      // still does.
      const params = entry.ctorParams ?? [];
      const args = params
        .map((prm) => {
          const a = (ctorArgs ?? []).find((x) => takenByCtor(x) && (x.name === prm.name || x.imported === prm.name));
          if (!a) return "undefined";
          // Wrapped, so the calls the subject makes ON its injected
          // collaborator are recorded. Emitting the answer raw meant a DI row
          // always reported boundaryCalls: [] - measured on notification-ms,
          // where this.webPushService.getVapidPublicKey() and
          // this.repository.findById() both demonstrably ran and neither
          // appeared. Same blindness the object-boundary fix closed for a
          // module export; the constructor path was simply not included in it.
          const answer = a.build !== undefined ? `(${retargetSpecifiers(a.build)})` : JSON.stringify(a.value ?? null);
          // A PRIMITIVE constructor argument is passed RAW. Routing it through
          // applyMock made it an omni proxy - a callable - because `real` is
          // undefined for a ctor arg so isFn is false, and location-ms then
          // held a FUNCTION in this.API_KEY for a whole row with a phantom
          // apiKey.toString in its call list. It interpolated correctly by
          // luck; typeof, .length, JSON.stringify and a switch would not.
          //
          // Decided at RUNTIME, not here: `answer` is an expression string at
          // emit time. And only for a ctor arg - applyMock's own branch must
          // keep wrapping, because there a primitive answer usually belongs to
          // a FUNCTION export the recorder could not resolve (getTraceId
          // answered `returns: undefined` is a callable that yields undefined,
          // not the value undefined). Changing it there cost 26 claims and 249
          // observed calls before I reverted it.
          return `(() => { const __a = (${answer}); return (__a === null || typeof __a !== "object") ? __a : applyMock(${JSON.stringify(a.name)}, "returns", undefined, () => __a); })()`;
        })
        .join(", ");
      // The CONSTRUCTOR is not a member you can call off an instance. Reading
      // inst["constructor"] returns the class, binding it changes nothing, and
      // calling it throws "Class constructor X cannot be invoked without new" -
      // which is what profile-centralized recorded for HttpException, with the
      // default-arg side filed FALSE because the arrangement's own `new C(...)`
      // had already moved it before the subject window opened. So a
      // constructor subject IS the construction, and its own arguments are the
      // ones the proposal supplies.
      // Required parameters nothing answered, said on a harness failure (CTOR_UNDEFINED).
      const unanswered = params
        .filter((prm) => !prm.optional && !prm.rest && !(ctorArgs ?? []).some((x) => takenByCtor(x) && (x.name === prm.name || x.imported === prm.name)))
        .map((prm) => prm.name);
      const mark = unanswered.length ? ` CTOR_UNDEFINED = ${JSON.stringify(unanswered)};` : "";
      // THE CLASS'S OWN SINGLETON AS THE RECEIVER (charpilotSingleton), when
      // the proposal answered NO constructor parameter and a required one
      // would be passed undefined. image-forwarder's AzureBlobService.INSTANCE
      // was already built by the module; `new C(undefined, undefined)` threw
      // in the SDK before downloadFile was entered. A proposal-declared
      // constructor argument still wins - this is only the no-answer case - and
      // a class with no singleton is constructed exactly as before, with the
      // CTOR_UNDEFINED message on a throw. The singleton outlives the row in
      // its module graph, so the row's field answers go on the teardown list
      // (__restore) there; an instance the row built needs none.
      const satisfied = params.filter((prm) => (ctorArgs ?? []).some((x) => takenByCtor(x) && (x.name === prm.name || x.imported === prm.name))).length;
      const trySingleton = unanswered.length > 0 && satisfied === 0;
      const receiver = trySingleton
        ? ` const C = ${v}[${JSON.stringify(holder)}]; const __single = charpilotSingleton(C); let inst; if (__single !== undefined) inst = __single; else {${mark} inst = new C(${args}); }${setFields("inst", "(__single !== undefined ? __restore : null)")}`
        : `${mark} const C = ${v}[${JSON.stringify(holder)}]; const inst = new C(${args});${setFields("inst", "null")}`;
      const call =
        entry.member === "constructor"
          ? `(() => { const C = ${v}[${JSON.stringify(holder)}]; return (...a) => new C(...a); })()`
          : entry.property != null
          ? `(() => {${receiver} const o = inst[${JSON.stringify(entry.member)}]; return o[${JSON.stringify(entry.property)}].bind(o); })()`
          : `(() => {${receiver} const __accessor = accessorOf(inst, ${JSON.stringify(entry.member)}); if (__accessor) { CTOR_UNDEFINED = []; return __accessor; } const t = inst[${JSON.stringify(entry.member)}]; CTOR_UNDEFINED = []; return t.bind(inst); })()`;
      return {
        imp: subjectImportStatement(v, mod, entry),
        call,
        ctorArity: params.length,
        ctorSatisfied: satisfied,
      };
    }
    default:
      return undefined;
  }
}

/** Which HARNESS_SCOPE bindings a row's own expressions mention. */
/** Names the generated row body declares itself; a binding may not shadow them. */
const ROW_BODY_NAMES = new Set(["row", "out", "started", "envBefore", "__restore", "__processListeners", "captured", "target", "first", "returned", "origs", "covAtRowStart", "covBefore", "doubles", "vi", "it", "expect", "mock", "applyMock", "settle", "results"]);

function scopeFor(row) {
  const text = [
    ...row.args.map((a) => a.build ?? ""),
    ...row.calls,
    ...row.mocks.map((m) => m.build ?? ""),
  ].join("\n");
  const need = [];
  for (const [id, module] of Object.entries(HARNESS_SCOPE)) {
    if (!new RegExp(`\\b${id}\\b`).test(text)) continue;
    // The map above is THIS repo's layout, and it is matched by bare word in
    // any build expression - so on another service, merely writing the word
    // made the row import a module that does not exist and fail as a harness
    // error. Measured on location-ms: 5 of these 8 modules are absent there
    // (redis.service, loggerV2, requestQueue.middleware, slack.service,
    // types/langfuseV1); only logger and env resolve. Skipped when it does not
    // resolve, because a binding the row never asked for should not be able to
    // break it - and the row still fails honestly if it truly needed it.
    if (!harnessModuleExists(module)) continue;
    need.push({ id, module: harnessSpelling(module) });
  }
  // TOOL BACKLOG: another boundary this row DECLARED, named in a build that is
  // evaluated in the row body (an arg, a precondition call, an instance-field
  // answer, a constructor argument): outreach-thread-ms classifyAndDispatch-565
  // answered this.qodeItl with `new ConfigMisconfiguredError(...)`, declared
  // ConfigMisconfiguredError at its module, and died "ConfigMisconfiguredError
  // is not defined". Bound from that module, as this row mocks it.
  const own = [...text.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
  const ctorText = (row.ctorArgs ?? []).map((a) => a.build ?? "").join("\n");
  const named = new Set([...own, ...(ctorText.match(/[A-Za-z_$][\w$]*/g) ?? [])]);
  for (const b of row.bindable ?? []) {
    if (!named.has(b.symbol)) continue;
    if (need.some((n) => n.id === b.symbol) || ROW_BODY_NAMES.has(b.symbol) || /^m\d+$/.test(b.symbol)) continue;
    need.push({ id: b.symbol, module: b.module, imported: b.imported ?? b.symbol });
  }
  return need;
}

/**
 * Does an alias-form harness module exist in THIS target.
 *
 * Only the "@/" alias is understood, because that is the only form the map
 * uses. A bare package specifier is left alone - node resolves those, and a
 * missing one is a genuine dependency problem worth surfacing.
 */
const HARNESS_MODULE_CACHE = new Map();
function harnessModuleExists(module) {
  if (HARNESS_MODULE_CACHE.has(module)) return HARNESS_MODULE_CACHE.get(module);
  let ok = true;
  if (module.startsWith("@/")) {
    const rest = module.slice(2);
    ok = [".ts", ".tsx", ".js", "/index.ts", "/index.js", ""].some((ext) =>
      existsSync(join(TARGET_ROOT, "src", `${rest}${ext}`))
    );
  }
  HARNESS_MODULE_CACHE.set(module, ok);
  return ok;
}

/**
 * A HARNESS_SCOPE module spelled so the REPO'S OWN config resolves it to the
 * file the recording did (D48).
 *
 * The map is written in the `@/` shorthand, and `@/` resolves at record time
 * only because vitest.record.config.mts carries the pipeline's alias floor
 * (resolution.mjs PILOT_ALIAS_TABLE: `@/env` and `@/...` are `src/...`). The
 * emitted row body is that same text, and cigate replays it under the repo's
 * own config, which declares no `@/` unless the repo does. On
 * ats-sourcing-service (the mocked run of late September 2026, no aliases at
 * all) every row whose build names `env` imported `@/env` and died in its
 * arrangement with `Cannot find package '@/env'`: 56 rows red under the repo's
 * config and green under the recording's resolution, which cigate can only
 * name `config-gap`. The module is `src/<rest>` here by construction -
 * harnessModuleExists looks nowhere else - so it takes the spelling every other
 * `src/` path the recorder writes takes (srcSpelling): the repo's alias when
 * it has one that matches, so a repo that does declare `@/` sees no change,
 * else root-relative `/src/...`, which vite resolves the same way in every
 * config.
 */
function harnessSpelling(module) {
  return module.startsWith("@/") ? srcSpelling(`src/${module.slice(2)}`) : module;
}

/**
 * Everything that can change what a row observes, hashed into one id.
 *
 * The ENV FILE belongs here and was the last thing missing. `QUEUE_TIMEOUT`,
 * `MAX_TIMEOUT_*`, `REDIS_HOST` and `SLACK_HOOK` are read by the arms under
 * test, so the same input recorded under two envs gives two different answers.
 * With the env outside the hash both runs computed the same version, shared one
 * cache, and merged row-by-row - an artifact describing neither environment,
 * with nothing in it saying which row came from where. It is the CONTENT that
 * is hashed, not the path, so editing staging.env invalidates the cache too.
 *
 * Values are never stored or printed - only this digest of them.
 */
function envProvenance() {
  if (!ENV_FILE) return "process-env-only";
  if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
  return createHash("sha1").update(readFileSync(ENV_FILE, "utf8")).digest("hex").slice(0, 12);
}

/**
 * The per-row budget an ARTIFACT was recorded under, read off the artifact.
 *
 * The whole point is that no later stage re-types it. `ROW_TIMEOUT_MS` used to
 * be threaded separately through the recording run, `--emit-tests` and
 * `determinism.mjs`'s second observation, each taking it from its own
 * invocation - so the three could disagree, and the number that won was
 * whichever command was typed last rather than the one the rows were measured
 * under. Measured on one 710-line service, all from that single cause:
 *
 *   - emitting without the flag the rows were recorded with: the generated spec
 *     timed out, branch sides went 29 -> 28, one `reaches` claim came back
 *     FALSE, and the next emit stamped an UNVERIFIED marker into a COMMITTED
 *     test file. Re-emitting with the flag restored 29 and cleared the marker.
 *   - determinism's second observation spawned without `--row-timeout`: 1 of 16
 *     rows labelled unstable at the 10s default, 0 of 16 at 30000ms. A slow row
 *     reads as the service being non-deterministic.
 *   - out/loop.json carried a phantom dip (iteration 3, -1 +1) attributable to
 *     no input change at all.
 *
 * The cost is not the minute of runtime. The invariants say a FALSE claim means
 * the stage-3 INPUT is wrong, so a stage-4/5 plumbing defect presents as a
 * derivation error and a whole repair round goes to the wrong stage.
 *
 * Resolution order, and every step of it is a real artifact on disk somewhere:
 *   1. the ROWS. `out.rowTimeoutMs` is stamped on every row, settled or not.
 *   2. `selection.rowTimeoutMs`, then `totals.rowTimeoutMs` - artifacts written
 *      after those fields existed but before the per-row one did.
 *   3. absent. Real artifacts predate all three (ai-centralization's 365-row
 *      behaviour.json carries none of them), and they must stay READABLE: the
 *      caller falls back to its own flag, which is what it did before, and says
 *      so rather than pretending it recovered a value.
 *
 * MAX, where the rows disagree. Raising a budget cannot change a row that
 * already settled - it only removes a timeout - so the largest recorded value
 * is the one budget under which every row in the artifact is reproducible. The
 * minimum would fabricate a timeout for the rows recorded above it. Today
 * record.mjs cannot actually produce a disagreeing artifact, because
 * `ROW_TIMEOUT_MS` is in `harnessVersion()` and therefore in the cache FILE
 * name, so a run under a new budget cannot merge with rows recorded under the
 * old one (see S4-63). This handles it anyway: that key is the thing S4-63 is
 * about changing, and a hand-merged or concatenated artifact is not exotic.
 */
export function recordedRowTimeout(doc) {
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const perRow = rows.map((r) => Number(r?.rowTimeoutMs)).filter((n) => Number.isFinite(n) && n > 0);
  if (perRow.length) {
    const counts = new Map();
    for (const n of perRow) counts.set(n, (counts.get(n) ?? 0) + 1);
    const distinct = [...counts.keys()].sort((a, b) => a - b);
    return {
      ms: distinct[distinct.length - 1],
      source: "rows",
      distinct,
      counts: [...counts.entries()].sort((a, b) => a[0] - b[0]),
      rowsWithValue: perRow.length,
      rowsTotal: rows.length,
    };
  }
  for (const [source, value] of [
    ["selection.rowTimeoutMs", doc?.selection?.rowTimeoutMs],
    ["totals.rowTimeoutMs", doc?.totals?.rowTimeoutMs],
  ]) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0)
      return { ms: n, source, distinct: [n], counts: [[n, rows.length]], rowsWithValue: 0, rowsTotal: rows.length };
  }
  return { ms: null, source: "absent", distinct: [], counts: [], rowsWithValue: 0, rowsTotal: rows.length };
}

/**
 * `recordedRowTimeout` plus the policy on a flag typed at the same time.
 *
 * The three options were: refuse the flag outright, ignore it, or let it
 * override. All three are wrong as a blanket rule, and the asymmetry is what
 * decides it - the budget is a CEILING, so the two directions are not alike:
 *
 *   equal      silent. The common case, and it must stay byte-identical: a
 *              normal emit of a normal artifact produces the same file it
 *              always did.
 *   HIGHER     allowed, with a notice. A raise cannot change an asserted value
 *              - the rows it applies to already settled well inside a smaller
 *              budget - and there is a legitimate need for it: a CI runner is
 *              slower than the machine that recorded, and a test that settled
 *              in 9s locally is not wrong to want 30s there.
 *   LOWER      REFUSED. This is the defect itself. Every row recorded above the
 *              new ceiling is one the generated test will now time out on, and
 *              the failure surfaces two stages later as a FALSE claim about the
 *              input. There is no reading of "lower it" that is worth the
 *              round: a budget nothing was observed under is not a budget.
 *   absent     the artifact predates the field; the flag (or the default) is
 *              all there is, and the notice says the value was not recovered.
 *
 * `where` names the calling stage so the refusal can print a command that
 * actually fixes it.
 */
export function resolveRowTimeout(doc, { flagMs = null, where = "--emit-tests" } = {}) {
  const found = recordedRowTimeout(doc);
  const disagree =
    found.distinct.length > 1
      ? `\n  · the rows DISAGREE on the budget (${found.counts.map(([ms, n]) => `${n} row(s) at ${ms}ms`).join(", ")}); ` +
        `using the largest, the only one every row in this artifact is reproducible under`
      : "";

  if (found.source === "absent") {
    const ms = flagMs ?? DEFAULT_ROW_TIMEOUT_MS;
    return {
      ms,
      source: flagMs === null ? "default (no recorded budget in the artifact)" : `${where} flag (no recorded budget in the artifact)`,
      found,
      notice:
        `· row budget ${ms}ms, from ${flagMs === null ? `the ${DEFAULT_ROW_TIMEOUT_MS}ms default` : `--row-timeout`} - ` +
        `this artifact records none (no per-row rowTimeoutMs, no selection.rowTimeoutMs), so it was NOT recovered from the rows. ` +
        `Re-record to stamp it.`,
    };
  }

  if (flagMs === null || flagMs === found.ms) {
    return {
      ms: found.ms,
      source: found.source,
      found,
      // Silent when the flag was typed and agrees: nothing was decided, so
      // there is nothing to report and the output stays comparable. A
      // disagreement among the rows still gets said, flag or no flag - it is
      // the one thing here a reader cannot see from the command they typed.
      notice:
        flagMs === null
          ? `· row budget ${found.ms}ms, read from the recorded rows (${found.source})${disagree}`
          : disagree
            ? disagree.replace(/^\n/, "")
            : null,
    };
  }

  if (flagMs < found.ms) {
    return {
      ms: null,
      source: found.source,
      found,
      refusal:
        `--row-timeout ${flagMs} is LOWER than the ${found.ms}ms these rows were recorded under (${found.source}).\n` +
        `${disagree ? `${disagree.trim()}\n` : ""}` +
        `A row that settled at up to ${found.ms}ms will time out under ${flagMs}ms, and the failure does not surface here:\n` +
        `it surfaces at stage 6 as a FALSE claim, which the invariants define as a stage-3 input to repair. It is not.\n\n` +
        // The command WITHOUT the flag, spelled out for the caller that is
        // actually refusing. A remedy line naming the wrong tool is the same
        // defect one layer down, and `where` is the only thing that knows.
        `  drop the flag - ${where} reads the budget off the rows now:\n` +
        `    node .claude/charpilot/${where === "--emit-tests" ? "record.mjs --emit-tests <dir>" : where}\n` +
        `  or re-RECORD at ${flagMs}ms first, if that is the budget you mean:\n` +
        `    node .claude/charpilot/record.mjs --fresh --row-timeout ${flagMs}`,
    };
  }

  return {
    ms: flagMs,
    source: `${where} flag, raised above the recorded ${found.ms}ms`,
    found,
    notice:
      `· row budget RAISED to ${flagMs}ms; the rows were recorded under ${found.ms}ms (${found.source}).${disagree}\n` +
      `  A raise cannot change an asserted value - every row already settled inside the smaller budget - so this only buys headroom on a slower machine.`,
  };
}

/**
 * WHAT THIS RECORDER OBSERVES, AS A NUMBER A PERSON CHANGES (item 6b).
 *
 * BUMP IT, BY ONE, ONLY WHEN A CHANGE HERE ALTERS WHAT IS RECORDED FOR ROWS
 * WHOLESALE - a new field every assertion reads, a value snapped differently
 * everywhere, a boundary answered at another level for every row - and say why
 * on the line below, newest first. A bump re-records every row of every repo on
 * its next walk: about an hour of recording and another of determinism on each
 * of the large ones.
 *
 * DO NOT BUMP IT for a fix that changes a FEW rows. Those rows are found by
 * the replay: cigate runs the emitted suite under the tools installed now, and a
 * red row whose recording another toolset made is recorded again before it is
 * withheld (steps/emit.mjs ciGate). D49 (a row reads its own clock), D50 (an
 * import allowance) and D51 (NaN, Infinity and -0 recorded as themselves) are
 * that kind: each moved a handful of rows, and the old key - a hash of this
 * whole file - re-recorded 1460 rows on qode-ptp-ms for them.
 *
 *   2  D63 (September 2026): every row carries `clockEpoch`, the instant its
 *      clock started, and the replay starts there; new Date() reads the row's
 *      clock; each row runs under TZ=UTC. This one IS wholesale, and cigate
 *      cannot find its rows: a row that derives a date from now is green on
 *      the day it is recorded, because the replay's real now is still that
 *      day, so the gate passes it and the delivered suite goes red in the
 *      service's CI a day later (qode-itl-be resolveSweepWindow). A cached row
 *      from version 1 has no epoch to replay from, and which of them read the
 *      clock was never written down, so every one is recorded again.
 *   1  the first declared version (September 2026). A recording that names no
 *      version was made by a recorder that predates this constant, and is read
 *      as version 1.
 */
export const OBSERVATION_VERSION = 2;

/**
 * THE RECORD CACHE'S KEY: what a row's observation is a function of, apart
 * from its own input (the proposal fingerprint) and the repo's code
 * (sourcedeps.mjs).
 *
 * NOT the recorder's bytes. That is `harnessVersion` below, which stays - as
 * the PROVENANCE every row carries (`__recordedBy`), so the cigate path can
 * tell a red row another toolset recorded from one this one did. It stopped
 * being the key because a comment edit in this file re-recorded every row
 * (docs/speed/README.md item 6b).
 *
 * What stays in it is configuration a row is really observed under, each for
 * the reason it was added to the harness hash: the per-row budget, the
 * effective egress allowlist, live or mocked, the env's provenance and the
 * stand-ins.
 *
 * WHY NOT THE ROW RUNTIME, THE DOUBLES OR THE HARNESS TEMPLATE. They are
 * tools, and a change to them is either wholesale - a bump above - or it moves
 * a few rows, and a row it moves no longer replays: the emitted test is drawn
 * from the same template, snapped by the same runtime (ROW_RUNTIME's
 * snap/revive) and answered by the same doubles.ts, so a recording they would
 * now observe differently fails its own assertion under cigate, and is recorded
 * again there. Keying on them is the whole-file hash again, one file at a time:
 * every one of them changes on most toolset merges.
 */
/**
 * THE NODE A ROW IS OBSERVED UNDER IS PART OF WHAT IT IS OBSERVED UNDER (D54).
 *
 * The recorder's vitest runs under the Node the repo's CI runs (cinode.mjs),
 * and the engine writes into values: a JSON.parse message wrapped in the
 * service's own Error, an OpenSSL error's fields. So a row recorded under
 * Node 24 is not the row a Node 20 CI replays, and is recorded again.
 *
 * NOT an OBSERVATION_VERSION bump: that re-records every repo, and a repo whose
 * CI resolves to the image's own Node (qode-ptp-ms sets no node-version) gains
 * nothing from it. Every row before D54 was recorded under Node 24 - the image
 * default - so a key and a row that name no Node are Node 24's, and the key
 * gains `targetNodeMajor` ONLY for another major: a Node 24 repo's key, and
 * with it its cache and its behaviour.json, stay exactly as they were.
 */
export const UNSTAMPED_NODE_MAJOR = 24;
const TARGET_NODE = targetNode({ root: REPO_ROOT });
export const RECORDED_NODE_MAJOR = TARGET_NODE.major ?? UNSTAMPED_NODE_MAJOR;
/** Whether a row (cached, or in the artifact) was recorded under the Node this run records under. */
export const recordedUnderThisNode = (row, major = RECORDED_NODE_MAJOR) => (row?.__recordedNode ?? UNSTAMPED_NODE_MAJOR) === major;

export function recordingKeyParts() {
  return {
    ...(RECORDED_NODE_MAJOR !== UNSTAMPED_NODE_MAJOR ? { targetNodeMajor: RECORDED_NODE_MAJOR } : {}),
    observationVersion: OBSERVATION_VERSION,
    rowTimeoutMs: ROW_TIMEOUT_MS,
    allowHosts: [...new Set([...ALLOW_HOSTS, ...(LIVE ? stagingAllowHosts() : [])])].sort(),
    live: LIVE,
    liveProviders: LIVE_PROVIDERS,
    policy: POLICY,
    envProvenance: envProvenance(),
    standIns: [...standInPlan().standIns].sort(),
  };
}
function recordingKey() {
  return createHash("sha1").update(JSON.stringify(recordingKeyParts())).digest("hex").slice(0, 12);
}

/**
 * The toolset that observed a row: this file, doubles.ts and the recording
 * config, byte for byte, with the flags and env. Stamped on every row as
 * `__recordedBy` and on the artifact as `harnessVersion`. No longer the cache
 * key - see recordingKey.
 */
function harnessVersion() {
  const h = createHash("sha1");
  for (const p of [new URL(import.meta.url).pathname, DOUBLES, CONFIG]) h.update(readFileSync(p, "utf8"));
  h.update(String(ROW_TIMEOUT_MS));
  // The EFFECTIVE allowlist, not just the typed half: a cached row recorded
  // when a host was open is not the row you get when it is closed.
  h.update([...ALLOW_HOSTS, ...(LIVE ? stagingAllowHosts() : [])].join(","));
  h.update(`${LIVE}/${LIVE_PROVIDERS}`);
  h.update(envProvenance());
  // The stand-ins are part of the env a row ran under: a row cached when
  // AZURE_STORAGE_ACCOUNT_KEY was unset is not the row you get with it set.
  h.update(standInPlan().standIns.join(","));
  // D54: another Node than the unstamped default is another harness.
  if (RECORDED_NODE_MAJOR !== UNSTAMPED_NODE_MAJOR) h.update(`node${RECORDED_NODE_MAJOR}`);
  return h.digest("hex").slice(0, 12);
}

/**
 * A row's cache entry is keyed on the PROPOSAL that produced it, not only on
 * the harness that ran it.
 *
 * The harness hash covers record.mjs, doubles.ts, the vitest config, the env
 * and the flags - everything except the input. So editing a proposal's args,
 * boundaries or invoke recipe left its old observation in the cache and the
 * next run served it: "294 already cached, running 0" after 11 proposals had
 * been rewritten. That is the worst failure this cache can have. The row is
 * cited, internally consistent, and describes a program that no longer exists.
 */
function proposalFingerprint(proposal) {
  return createHash("sha1")
    .update(JSON.stringify({
      args: proposal.args ?? null,
      boundaries: proposal.boundaries ?? null,
      invoke: proposal.invoke ?? null,
      setup: proposal.setup ?? null,
      via: proposal.via ?? null,
      covers: proposal.covers ?? null,
      reaches: proposal.reaches ?? null,
      functionId: proposal.functionId ?? null,
    }))
    .digest("hex")
    .slice(0, 12);
}

function loadCache(key) {
  const CACHE = CACHE_FOR(key);
  if (FRESH || !existsSync(CACHE)) return { recordingKey: key, rows: {} };
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (c.recordingKey !== key) {
      process.stdout.write("· recording key changed - discarding the row cache rather than serving stale observations\n");
      return { recordingKey: key, rows: {} };
    }
    // D54: a row another Node observed is not served, whatever the key says.
    for (const [id, row] of Object.entries(c.rows ?? {})) if (!recordedUnderThisNode(row)) delete c.rows[id];
    return c;
  } catch {
    return { recordingKey: key, rows: {} };
  }
}

/**
 * THE RECORDING ON DISK IS A CACHE TOO (item 6b).
 *
 * The row caches are hidden files and a checkpoint carries none of them
 * (char/checkpoint.py), so on a resume the cache above is always empty and the
 * only record of what was observed is the artifact the checkpoint laid back:
 * behaviour.json. Every resume recorded every row again from it, and
 * determinism recorded them all a second time - qode-ptp-ms, 26 September 2026:
 * 1460 rows, about 60 minutes and 50, at the same production commit and the
 * same proposals.
 *
 * So a row the cache does not hold is taken from the artifact when it was
 * recorded under the same key (`recordingKeyParts`) from the same input (its
 * `__fingerprint`), and it then faces every check a cached row does: the
 * repo's code it depends on (evictMovedRows), the placeholder client, a
 * harness failure another toolset produced. Its determinism verdict comes with
 * it - the verdict is about this very observation.
 *
 * Returns why the artifact cannot be used, or null. An artifact that names no
 * key predates it, and is compared on the fields it does store.
 */
export function recordingMismatch(doc, now = recordingKeyParts()) {
  if (!doc || typeof doc !== "object") return "there is no readable recording";
  const argvHosts = (argv) => {
    const at = (argv ?? []).indexOf("--allow-host");
    return at === -1 ? [] : String(argv[at + 1] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  };
  const then = doc.recordingKeyParts ?? {
    observationVersion: 1,
    rowTimeoutMs: doc.selection?.rowTimeoutMs ?? doc.totals?.rowTimeoutMs ?? null,
    allowHosts: [...new Set(argvHosts(doc.selection?.argv))].sort(),
    live: doc.selection?.live ?? null,
    liveProviders: doc.selection?.liveProviders ?? null,
    policy: doc.selection?.policy ?? null,
    envProvenance: doc.envProvenance ?? null,
    standIns: [...(doc.standIns ?? [])].sort(),
  };
  const moved = Object.keys(now).filter((k) => JSON.stringify(then[k] ?? null) !== JSON.stringify(now[k] ?? null));
  if (!moved.length) return null;
  return `it was recorded under another ${moved.map((k) => `${k} (${JSON.stringify(then[k] ?? null)}, now ${JSON.stringify(now[k] ?? null)})`).join(", ")}`;
}

function priorRecording() {
  if (FRESH || !existsSync(OUTPUT)) return null;
  try {
    const doc = JSON.parse(readFileSync(OUTPUT, "utf8"));
    // Another repo's artifact is guardOutput's refusal, not a source of rows.
    if (doc?.target && doc.target !== basename(TARGET_ROOT)) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Rows taken from the artifact into the cache, by id. See recordingMismatch. */
function seedFromRecording(cache, prior, wanted, fingerprints) {
  const seeded = [];
  if (!prior) return seeded;
  const why = recordingMismatch(prior);
  if (why) {
    process.stdout.write(`· ${relative(REPO_ROOT, OUTPUT)} is not reused: ${why} - its rows are recorded again\n`);
    return seeded;
  }
  const byId = new Map((prior.rows ?? []).map((r) => [String(r?.id), r]));
  for (const r of wanted) {
    if (cache.rows[r.id]) continue;
    const row = byId.get(String(r.id));
    // The artifact's own fingerprint stamp, which is the one this run will
    // compare: a row recorded from another input is not this row.
    if (!row || typeof row.__fingerprint !== "string" || row.__fingerprint !== fingerprints.get(r.id)) continue;
    // D54: nor is a row recorded under another Node.
    if (!recordedUnderThisNode(row)) continue;
    cache.rows[r.id] = row;
    seeded.push(r.id);
  }
  return seeded;
}

/**
 * The cached rows whose code has moved since they were recorded, evicted, and
 * the rest stamped (sourcedeps.mjs). Before the stamp existed a row names no
 * code, so it is judged against the commit test/characterization/recorded.json
 * says the recording was taken at, and stamped when nothing it depends on moved
 * since. Returns what it evicted, with the files that moved.
 */
async function evictMovedRows(cache, wanted, prior) {
  const cached = wanted.filter((r) => cache.rows[r.id]);
  if (!cached.length) return { evicted: [], graph: await sourceGraph(REPO_ROOT, { tsconfig: TSCONFIG }) };
  const graph = await sourceGraph(REPO_ROOT, { tsconfig: TSCONFIG });
  if (!graph) {
    process.stdout.write("· the repo's module graph cannot be read (ts-morph did not load) - every cached row is recorded again, since nothing says its code is unchanged\n");
    for (const r of cached) delete cache.rows[r.id];
    return { evicted: cached.map((r) => ({ id: r.id, why: "the module graph could not be read" })), graph: null };
  }
  let legacy;
  const legacyOf = () => {
    if (legacy) return legacy;
    let sha = null;
    try {
      sha = JSON.parse(readFileSync(join(REPO_ROOT, CORPUS_REL, "recorded.json"), "utf8")).recordedAgainst?.gitSha ?? null;
    } catch {
      sha = null;
    }
    const changed = sha ? changedSince(REPO_ROOT, sha) : null;
    legacy = { sha, changed, packageChanged: sha && changed?.has("package.json") ? packageMoved(REPO_ROOT, sha) : false };
    return legacy;
  };
  const evicted = [];
  const table = prior?.sources?.files ?? {};
  for (const r of cached) {
    const row = cache.rows[r.id];
    let moved;
    if (row.__sources) {
      moved = stampChanged(graph, row.__sources, table);
    } else {
      const { sha, changed, packageChanged } = legacyOf();
      const roots = rootsOf(graph, r, row);
      moved = legacyChanged(graph, roots, sha, changed, packageChanged);
      // Nothing it depends on moved since the commit the recording names, so
      // the tree on disk IS what it ran against: stamped now, judged by digest
      // from here on.
      if (!moved) row.__sources = { roots, digest: graph.digest(roots) };
    }
    if (moved) {
      delete cache.rows[r.id];
      evicted.push({ id: r.id, why: moved.why, files: moved.files });
    }
  }
  return { evicted, graph };
}

/**
 * THE RECORDER'S OWN ENV DEFAULTS, in one place, because the replay needs them
 * too (D13).
 *
 * Importing anything that imports `@/env` runs a Zod schema that fails fast on
 * a missing var. These placeholders exist only so the module graph loads; any
 * proposal whose ARM depends on an env value states it in setup.apply.env and
 * overrides them. `...process.env` in baseEnv wins over every one of them.
 *
 * WHY THIS IS A FUNCTION AND NOT AN OBJECT LITERAL IN baseEnv. The recording
 * ran under these and the emitted suite did not: recorded.env and the spec
 * prelude carry the env file's names and the stand-ins, and nothing carried
 * these. notification-ms run 20260925T072757Z, `src/env.ts` returns
 * `envVariables.parse(process.env)` and declares `BUILD_ID:
 * z.string().default("local")`. Row `arg0-of-z-42-if-0` was recorded under
 * `BUILD_ID=charpilot`, and stage 6 replayed it with BUILD_ID unset, so the
 * suite got `"local"` - `expected { env: { …(16) } } to deeply equal { env: {
 * …(16) } }`, one key of sixteen - and measure refused a 98.8% run. Determinism
 * could not see it: both of its observations are record.mjs, under this same
 * env. The one it cannot take is the replay's, so the replay is given the
 * recorder's env instead (harnessEnvCarried, envPrelude).
 */
export function harnessEnvDefaults(mockAtIoredis = MOCK_AT_IOREDIS) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://charpilot:charpilot@127.0.0.1:1/charpilot?schema=public",
    // The policy wants a cache that is CONNECTED and always misses, not one
    // that is switched off. `REDIS_ENABLED=false` returns from connect() at
    // redis.service.ts:38 and leaves `this.redis` null, so every method below
    // it throws instead of missing - which is a different arm, and it makes
    // the whole caching subtree unreachable. With the ioredis double in place
    // there is no socket to open, so enabling it costs nothing.
    REDIS_ENABLED: mockAtIoredis ? "true" : "false",
    // "" is falsy, so `env.REDIS_PASSWORD || undefined` at :49 takes its
    // right-hand side - the side stage 6 reports uncovered.
    REDIS_PASSWORD: "",
    BUILD_ID: "charpilot",
  };
}

/**
 * WHICH OF THOSE DEFAULTS THE REPLAY HAS TO BE HANDED, as [name, value] pairs.
 *
 * Only a default the recording actually ran under: a name the process env or
 * the env file supplied overrode it (baseEnv), and the replay gets that name by
 * the door the recording did. Never a database variable - both sides mask it
 * to the one placeholder (maskDatabaseEnv, inertEnvValue). Never a name the
 * replay config already sets to the same value (REPLAY_TEST_ENV: NODE_ENV).
 *
 * The values are the literals above and nothing else - an ambient value is
 * excluded by construction - so they are safe to stamp on the artifact and to
 * commit in a spec.
 */
export function harnessEnvCarried(defaults = harnessEnvDefaults(), supplied = process.env, replayEnv = REPLAY_TEST_ENV) {
  const has = supplied instanceof Set ? (n) => supplied.has(n) : (n) => supplied?.[n] !== undefined;
  return Object.entries(defaults).filter(
    ([n, v]) => !has(n) && !isDatabaseVar(n, v) && replayEnv?.[n] !== v
  );
}

/** This run's carried defaults: supplied = the process env plus the env file's names. */
function recordedHarnessEnv() {
  const supplied = new Set(Object.keys(process.env).filter((n) => process.env[n] !== undefined));
  if (ENV_FILE && existsSync(ENV_FILE)) for (const n of envNames(readFileSync(ENV_FILE, "utf8"))) supplied.add(n);
  return Object.fromEntries(harnessEnvCarried(harnessEnvDefaults(), supplied));
}

function baseEnv() {
  const env = {
    ...harnessEnvDefaults(),
    ...process.env,
  };
  if (ENV_FILE) {
    if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
    const text = readFileSync(ENV_FILE, "utf8");
    // A MOCKED ROW IS RECORDED UNDER THE ENV ITS TEST WILL REPLAY UNDER - the
    // one stamped into recorded.env and every spec's prelude (inertEnv). It
    // used to record under staging's values and replay under placeholders, so
    // any row that branches on a value diverged by construction: cv-parsing-ms
    // #67 recorded FILE_EXTRACT_PROCESSOR=DOCUMENT_AI and replayed
    // "charpilot-placeholder", and two rows went red in CI. Nothing a mocked
    // row does can use a real credential or address - egress is denied and the
    // database is masked below - so recording under the committed env loses
    // nothing and makes the recording and its replay the same program. A live
    // run needs the real values and keeps them.
    Object.assign(env, LIVE ? parseEnvText(text) : Object.fromEntries(inertEnv(text, envSchemaShapes())));
  }
  return env;
}

/**
 * THE STAND-INS THIS RUN APPLIES (standins.mjs), computed once.
 *
 * MOCKED ONLY: a live run gets none, so a real value staging does not carry
 * stays missing and fails where it is read. `supplied` is every name the
 * recording env already has - the recorder's defaults, the process env and
 * the env file - so a staging value, a shell value or the repo's own .env is
 * never overwritten. Database variables are never stood in: they keep the
 * db.invalid mask below. Names only reach an artifact.
 */
let STAND_IN_PLAN;
function standInPlan() {
  if (STAND_IN_PLAN) return STAND_IN_PLAN;
  if (LIVE) return (STAND_IN_PLAN = { values: new Map(), standIns: [], withheld: "live" });
  let envDefaults = null;
  try { envDefaults = JSON.parse(readFileSync(BASELINE_JSON, "utf8")).envDefaults ?? null; } catch { /* no baseline */ }
  STAND_IN_PLAN = planStandIns({
    repoRoot: REPO_ROOT,
    srcRoot: SRC_ROOT,
    isExcluded: isSrcExcluded,
    supplied: Object.keys(baseEnv()),
    envDefaults,
    isDatabaseVar,
  });
  return STAND_IN_PLAN;
}

function buildEnv() {
  const env = baseEnv();
  // THE STAND-INS GO THROUGH THE SAME DOOR AS THE ENV FILE. A mocked row is
  // recorded under the env its test replays under (baseEnv), and the replay
  // reads recordingEnvText() through inertEnv - the env file AND the stand-in
  // lines. So the recording applies that same text through that same function,
  // not the raw plan values: whatever inertEnv does to a stand-in, both sides
  // see it. A stand-in's name is never supplied (planStandIns), so this
  // overwrites nothing the shell or the recorder set; the env file's own names
  // come out exactly as baseEnv already assigned them.
  if (!LIVE && standInPlan().standIns.length) {
    Object.assign(env, Object.fromEntries(inertEnv(recordingEnvText(), envSchemaShapes())));
  }
  // DEFENCE IN DEPTH (tool backlog): a MOCKED run's subject process gets no
  // database credential at all - every database-looking variable, from the
  // shell or from staging.env, is an address that resolves nowhere. The denies
  // in the spec are the first layer; this one holds if any of them is ever
  // bypassed. A live run needs the real DSN and keeps it. The stages that read
  // staging themselves in a mocked run (stagingenv, preflight, the vocabulary
  // steps) run in their own processes and are not touched.
  if (!LIVE) maskDatabaseEnv(env);
  // What actually protects staging, stated once and correctly. An earlier
  // version of this comment claimed "two independent guards, the database
  // refuses writes" - that was false on both counts, and the correction was
  // appended underneath it rather than replacing it, so the file asserted both
  // at once.
  //
  // There is ONE credential. `DATABASE_URL_READ_ONLY` resolves to the same
  // writable DSN as `DATABASE_URL` (verified), so the database refuses nothing.
  // Writes against staging are permitted, and what makes that safe is not
  // refusal but REVERSIBILITY: every mutation is journalled with what is needed
  // to undo it, and the journal is replayed in reverse at the end of the run. A
  // write nobody can undo is the one thing still refused, and `$executeRaw` is
  // refused with it.
  //
  // The second guard is the DSN triple, and until now it existed only in
  // exec.mjs while THIS is the script that writes behaviour. Asserted below.
  if (LIVE) {
    assertExpectedDb(env.DATABASE_URL, "record.mjs --live");
    env.CHARPILOT_DB_JOURNAL = JOURNAL;
  }
  // WHICH SPEC this vitest is to run. The include path is shared and constant;
  // this is what makes the process that vitest belongs to identifiable, and it
  // travels in the environment because a vitest config's include list cannot.
  env.CHARPILOT_SPEC = SPEC;
  return env;
}

/**
 * Put the constant loader at SPEC_STUB, atomically, and only if it is not
 * already there.
 *
 * `writeFileSync` truncates before it writes, so a concurrent vitest reading
 * the include path at that instant sees an empty or half-written file - the
 * same class of race this whole change is closing. A rename within the
 * directory is atomic: a reader sees the old complete file or the new one.
 * And because the text is constant, the common case is one read and no write.
 */
function ensureSpecStub() {
  try {
    if (readFileSync(SPEC_STUB, "utf8") === SPEC_STUB_TEXT) return;
  } catch { /* absent or unreadable - write it */ }
  const tmp = `${SPEC_STUB}.${RUN_ID}.tmp`;
  writeFileSync(tmp, SPEC_STUB_TEXT);
  renameSync(tmp, SPEC_STUB);
}

/**
 * A token on the vitest COMMAND LINE that names this run.
 *
 * `--exclude` takes a glob and this one matches nothing, so it changes no
 * selection (the config sets `exclude: []` deliberately, and excluding a
 * directory that does not exist is the same thing). It exists so `pgrep -f`
 * can tell THIS run's vitest from another agent's - see reapStrays, which
 * used to match the config path and therefore matched everybody's.
 */
// The marker is now per slot (slotPaths' `token`); slot 0's is this run's.

/**
 * Kill any vitest still holding THIS RUN's chunk after a timeout.
 *
 * It matched `vitest.record.config.mts`, which every concurrent recorder also
 * passes, so one run's timeout SIGKILLed every other run's healthy vitest -
 * their chunks then "produced no rows" for a reason nothing in their log could
 * name. The marker above is per-run, so the sweep is too.
 */
function reapStrays(slot = SLOTS[0]) {
  const found = spawnSync("pgrep", ["-f", slot.token], { encoding: "utf8" });
  for (const pid of (found.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (Number(pid) === process.pid) continue;
    try {
      process.kill(Number(pid), "SIGKILL");
      process.stdout.write(`  · reaped stray vitest ${pid} - it outlived the chunk timeout\n`);
    } catch { /* already gone */ }
  }
}

/**
 * TOOL BACKLOG: A ROW THAT NEVER YIELDS IS STOPPED BY THE PARENT, NOT THE CHUNK.
 *
 * settle() races the row against a setTimeout, and a timer only fires when the
 * event loop gets a turn. A loop whose every await is an answer that is
 * already resolved never gives it one: tracy-agent-be's criteriaToScore-754-if-1
 * drives a 90-turn agent loop over a Gemini double that answers at once, the
 * row's ROW_TIMEOUT_MS never fired, vitest's own timeout never fired, and the
 * chunk ran to spawnSync's whole-chunk limit and was killed (exit 143). Every
 * row behind it, findPendingJob-288 among them, was lost with it.
 *
 * So the spec writes ROW_MARK as each row starts, and this process - which
 * does get turns - reads it. A row still in flight ROW_TIMEOUT_MS + ROW_GRACE_MS
 * after it started has its vitest killed. The caller skips THAT row with a
 * written reason and runs the rows behind it again, in a chunk of their own.
 */
const ROW_GRACE_MS = 15_000;
// The proposal's to repair, so derive routes it back as askable: the answers it
// declared keep a loop in the subject turning and none of them ends it.
const WEDGED_REASON = () =>
  `did not settle: the row ran past its ${ROW_TIMEOUT_MS}ms budget without once yielding to a timer, so it was stopped from outside - ` +
  "the boundary answers resolve at once and none of them ends the loop they feed. Declare an answer that ends it (a final turn, an empty page, a throw), and the same input records";
function readRowMark(at = ROW_MARK) {
  try {
    return JSON.parse(readFileSync(at, "utf8"));
  } catch {
    return null;
  }
}
/**
 * THE WEDGED ROW IS IN A WORKER, NOT IN THE PROCESS THAT GETS KILLED.
 *
 * vitest runs specs in `forks` workers. A SIGKILL to the vitest main process
 * cannot let it tear its pool down, and the worker spinning on the wedged row
 * never gets a turn to notice its parent's IPC channel close - so it was
 * reparented to PID 1 and spun at 85-100% CPU for good (19 of them, 6-10 hours
 * old, from one worktree's test runs). reapStrays could not see them either:
 * the run marker is on the main process's command line, and a worker's is just
 * `vitest/dist/workers/forks.js`.
 *
 * So vitest gets ITS OWN PROCESS GROUP, which its workers inherit, and every
 * kill is `kill(-pgid)` - the same shape as fleetprobe's walk. The group is
 * swept again when the leader exits, and when THIS process exits, so a worker
 * cannot outlive the recorder that started it.
 */
const LIVE_GROUPS = new Set();
function killGroup(pid) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* group already empty */ }
}
process.on("exit", () => { for (const pid of LIVE_GROUPS) killGroup(pid); });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(sig, () => {
    for (const pid of LIVE_GROUPS) killGroup(pid);
    process.kill(process.pid, sig);
  });
}

function spawnWatched(args, opts, limitMs, rowMark = ROW_MARK) {
  return new Promise((resolve) => {
    // D54: under the Node the repo's CI runs, not this tool's (cinode.mjs).
    // vitest's workers fork from it, so the rows run under it too.
    const child = spawn(TARGET_NODE.node, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], detached: true });
    LIVE_GROUPS.add(child.pid);
    let stdout = "";
    let stderr = "";
    // THE HEAD IS KEPT AS WELL AS THE TAIL. vitest leads with the error and
    // follows it with a code frame; on a long spec line the frame fills the
    // tail, so the tail alone carried no error at all (D44).
    let stdoutHead = "";
    let stderrHead = "";
    child.stdout.on("data", (d) => { if (stdoutHead.length < 8000) stdoutHead += d; stdout = (stdout + d).slice(-20000); });
    child.stderr.on("data", (d) => { if (stderrHead.length < 8000) stderrHead += d; stderr = (stderr + d).slice(-20000); });
    let wedged = null;
    let timedOut = false;
    const kill = () => killGroup(child.pid);
    // A leader that exited on its own can still leave a worker behind.
    child.on("exit", () => killGroup(child.pid));
    const whole = setTimeout(() => { timedOut = true; kill(); }, limitMs);
    const watch = setInterval(() => {
      const mark = readRowMark(rowMark);
      // The spec's own clock: the arrangement's allowance until the subject is
      // called, then the row budget from that moment (see settle).
      // D50: a subject import in flight (mark.importing) is on the
      // arrangement's allowance, as settle() has it.
      const overdue = mark && (mark.subjectAt && !mark.importing
        ? Date.now() - Number(mark.subjectAt) > ROW_TIMEOUT_MS + ROW_GRACE_MS
        : Date.now() - Number(mark.started) > Math.max(60_000, ROW_TIMEOUT_MS) + ROW_GRACE_MS);
      if (overdue) {
        wedged = mark;
        kill();
      }
    }, 500);
    child.on("close", (status, signal) => {
      clearTimeout(whole);
      clearInterval(watch);
      killGroup(child.pid);
      LIVE_GROUPS.delete(child.pid);
      resolve({ status, signal, stdout, stderr, stdoutHead, stderrHead, wedged, error: timedOut ? { code: "ETIMEDOUT" } : undefined });
    });
  });
}

async function runChunk(rows, env, slot = SLOTS[0]) {
  ensureSpecStub();
  writeSpec(rows, slot.spec, "record", ROW_TIMEOUT_MS, slot);
  rmSync(slot.result, { force: true });
  rmSync(slot.branchmap, { force: true });
  rmSync(slot.rowMark, { force: true });
  // Run vitest's own entry with THIS node, not through `npx`. `npx` shells out
  // via `npm exec`, so spawnSync's timeout SIGTERMs npm and the nested vitest
  // survives it: the orphan keeps running, and because every chunk writes the
  // same spec path and the same result file, a survivor from chunk N can land
  // its result after chunk N+1 has started - attributing one chunk's
  // observations to another's rows. Removing the shell layer means the timeout
  // signal reaches vitest itself.
  // A chunk of N rows cannot legitimately exceed N * the row timeout plus
  // vitest startup, so a longer wait than this is a wedged worker, not work.
  const limitMs = 60_000 + Math.max(60_000, ROW_TIMEOUT_MS) + rows.length * (ROW_TIMEOUT_MS + 5_000);
  const run = await spawnWatched(
    [VITEST_BIN, "run", "--config", CONFIG, "--reporter=default", "--exclude", `**/${slot.token}/**`,
      ...(slot.coverageDir ? [`--coverage.reportsDirectory=${slot.coverageDir}`] : [])],
    { cwd: REPO_ROOT, env: { ...env, CHARPILOT_SPEC: slot.spec } },
    limitMs,
    slot.rowMark
  );
  rmSync(slot.rowMark, { force: true });
  if (slot.coverageDir) rmSync(slot.coverageDir, { force: true, recursive: true });
  // Belt and braces: if a worker still outlived the signal, it must not be
  // holding the spec while the next chunk rewrites it.
  if (run.error?.code === "ETIMEDOUT" || run.signal) reapStrays(slot);
  let out;
  try {
    out = JSON.parse(readFileSync(slot.result, "utf8"));
  } catch {
    out = null;
  } finally {
    if (!KEEP_SPEC) rmSync(slot.spec, { force: true });
  }
  let branchMap = null;
  try {
    branchMap = JSON.parse(readFileSync(slot.branchmap, "utf8"));
  } catch {
    branchMap = null;
  }
  // The results are only this chunk's if they name this chunk's rows. Nothing
  // checked, and the caller trusts them completely: `cache.rows[row.id] = row`
  // files whatever comes back under whatever id it carries, so a foreign
  // result was cached, published, and counted. The isolation above should make
  // this unreachable; that is exactly why it is asserted rather than assumed,
  // and it is a STOP, because a run that continues writes an artifact whose
  // rows describe another run's program.
  if (Array.isArray(out)) {
    const asked = new Set(rows.map((r) => r.id));
    const foreign = out.filter((r) => !asked.has(r?.id)).map((r) => r?.id);
    if (foreign.length) {
      throw new Error(
        `chunk results do not belong to this chunk: ${foreign.length} of ${out.length} row(s) were not asked for ` +
          `(${foreign.slice(0, 4).join(", ")}${foreign.length > 4 ? ", …" : ""}).\n` +
          `  That means another process wrote ${relative(REPO_ROOT, slot.result)} or ${relative(REPO_ROOT, SPEC_STUB)} under this run.\n` +
          `  Stopping rather than caching them: an observation filed under someone else's id is worse than a missing row.`
      );
    }
  }
  const wedged = run.wedged && rows.some((r) => r.id === run.wedged.id) && !(out ?? []).some((r) => r?.id === run.wedged.id) ? run.wedged.id : null;
  // The stream vitest spoke on, HEAD FIRST: see spawnWatched.
  const [head, tail] = run.stderr ? [run.stderrHead, run.stderr] : [run.stdoutHead, run.stdout];
  const log = (tail ?? "").length > 3000 ? `${(head ?? "").slice(0, 3000)}\n…\n${tail.slice(-1500)}` : (tail ?? "");
  return {
    rows: out, branchMap, status: run.status ?? run.signal, log, wedged,
    timedOut: run.error?.code === "ETIMEDOUT" ? limitMs : null,
  };
}


/**
 * The generated-file marker. A file carrying this line was written by this
 * tool; a file without it was written by a person or an agent and this tool
 * MUST NOT touch it.
 */
const EMIT_HEADER = "GENERATED by `.claude/charpilot/record.mjs --emit-tests`";
/** A spec file this size is named in the emit summary (D57): GitHub warns at 50 MiB, refuses at 100. */
const SPEC_WARN_BYTES = 50 * 1024 * 1024;

/*
 * EMITTED_PRAGMAS - why every emitted spec opens with `// @ts-nocheck` and
 * `/* eslint-disable *\/`.
 *
 * The row runtime is JavaScript: one block of text shared verbatim by the
 * recording spec and the committed test (ROW_RUNTIME), so that the test is
 * arranged by the same code that arranged the observation. It carries no type
 * annotations and cannot without becoming two copies. A repo whose type-check
 * covers `test/` then reads the corpus as thousands of errors before a single
 * test runs: outreach-thread-ms PR #143 (`lint-test`, `tsc --noEmit`) and
 * assessment-service PR #89 (`quality`) went red on TS2339 `Property
 * 'harnessError' does not exist`, TS2339 `'invoked'`, TS7005, TS7006, TS7053 and
 * TS2554 - 896 of one code alone - all inside test/characterization, none in
 * the repo's own code. `harnessError` was the loudest name on the list, not the
 * cause: the guard it sits in is correct, and removing it would let a harness
 * failure pass as behaviour.
 *
 * Generated code is checked by RUNNING it, which is what the corpus is for;
 * the pragma keeps a repo's own tsc and eslint from checking what they cannot
 * usefully check, and changes nothing a test does.
 */

/**
 * Decide what may be removed from an emit target, and refuse when the target
 * does not look like ours.
 *
 * The old behaviour was `readdirSync(dir)` then delete every *.test.ts, which
 * assumes the tool OWNS the directory. It does not, and it should not: test
 * generation is the agent's responsibility, and `--emit-tests` is one tool the
 * agent may choose. An agent that hand-writes a case into the same directory
 * had it silently deleted on the next emit, and pointing the flag at the wrong
 * directory removed a hand-written suite. It nearly did.
 *
 * So ownership is established per file, from two independent facts:
 *   - the file carries EMIT_HEADER, and
 *   - the previous manifest in that directory lists it.
 *
 * A file that is neither is FOREIGN and is left alone. A file that is ours but
 * no longer has a row is an ORPHAN and is removed, because leaving it means the
 * suite asserts against a row that no longer exists.
 *
 * And the accident this exists to stop: a directory holding foreign tests with
 * NO manifest of ours is not an emit target. Refuse, do not "guard".
 */
function planEmitTarget(dir, willWrite) {
  const manifestPath = join(dir, "emitted.json");
  const previous = existsSync(manifestPath)
    ? new Set((JSON.parse(readFileSync(manifestPath, "utf8")).emittedFiles ?? []).map((f) => f.split("/").pop()))
    : null;

  const present = existsSync(dir) ? readdirSync(dir).filter(isCorpusSpec) : [];
  const ours = [];
  const foreign = [];
  for (const f of present) {
    const marked = readFileSync(join(dir, f), "utf8").slice(0, 400).includes(EMIT_HEADER);
    if (marked || previous?.has(f)) ours.push(f);
    else foreign.push(f);
  }

  if (foreign.length && previous === null) {
    throw new Error(
      `refusing to emit into ${relative(REPO_ROOT, dir)}: it holds ${foreign.length} test file(s) this tool did not write ` +
        `(${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}) and no emitted.json of ours. ` +
        `That is what a wrong --emit-tests path looks like. Point it at the generated directory, or delete those files yourself if you meant to.`
    );
  }

  const keep = new Set(willWrite);
  return { orphans: ours.filter((f) => !keep.has(f)), foreign, ours };
}

/**
 * Sweep per-run scratch left by recorders that are GONE.
 *
 * A run that throws keeps its result and branch map on purpose - they are the
 * evidence. Nothing then removes them, so a shared out/ would collect one pair
 * per failed run forever. Ownership is the pid in the name: a file is only
 * removed when its process is no longer running, so a CONCURRENT recorder's
 * scratch is never touched (that being the whole point of naming it per run).
 * Pid reuse can only make this too conservative, which is the safe direction.
 */
function sweepDeadRunScratch() {
  const own = (name) => {
    const m = name.match(/^(?:\.record-(?:result|branchmap)\.|record\.run-)(\d+)-[0-9a-f]{6}(?:\.json|\.test\.ts)$/);
    return m ? Number(m[1]) : null;
  };
  for (const f of readdirSync(OUT_DIR)) {
    const pid = own(f);
    if (pid === null || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // alive - someone else's run in progress
    } catch (e) {
      if (e.code === "EPERM") continue; // alive, just not ours
    }
    rmSync(join(OUT_DIR, f), { force: true });
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  sweepDeadRunScratch();
  // D73: the module graph the subject imports are written from (cycleImporters).
  // Read before any call shape is built; unreadable means no cycle is known.
  try {
    CYCLE_GRAPH = await sourceGraph(REPO_ROOT, { tsconfig: TSCONFIG });
  } catch {
    CYCLE_GRAPH = null;
  }
  const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
  // THE MODULE'S TOP LEVEL IS AN OWNER HERE TOO — the other half of the repair
  // `validate.mjs:300-360` documents and explicitly says is not its to write.
  //
  // WHAT WAS LEFT HALF DONE. `validate.mjs:879` resolves the synthetic owner
  // `<file>:0:<module scope>` that `worklist.mjs:579-620` mints for an arm
  // running at import time, so those rows stopped being quarantined. This
  // index was still `scan.functions` alone, so `classify` refused the same id
  // three times over — `record.mjs:993` ("functionId not in scan.json" on the
  // `export <binding>` path), `:1020` (the driver path) and `:1240` (the
  // `invoke.build` path every module-scope row actually takes). The row
  // LANDED, counted as `proposed`, and was then skipped by the recorder:
  // `proposed` rose and `coverage_percentage` did not, which is the
  // intermediate-counter trap plan 19 is written against. COUNTED OFF THAT
  // RUN'S OWN `log.jsonl` rather than quoted: 37 "is not in scan.json"
  // refusals over FOUR files — src/cluster.ts 13, src/lib/logger.ts 11,
  // src/lib/tracing.ts 7, src/config.ts 6. `validate.mjs`'s docblock says five
  // files and gives 12/11/6/6; the total is right and the breakdown is not.
  //
  // BUILT FROM THE SCAN, NEVER FROM `worklist.items`. `items` holds only what
  // is still UNCOVERED, so an index built from them loses a file's owner the
  // moment that file's module-scope arms all close — and a proposal that had
  // WORKED would then read as naming a function that does not exist, which is
  // the same loss arriving one round later. `moduleScopeFunctions` reads
  // `scan.moduleScopeArms`, which is a census of what EXISTS.
  //
  // ORDERED SO THE SCAN'S OWN FUNCTIONS WIN. A real `scan.functions` entry
  // whose id somehow collides with the synthetic spelling is the authority;
  // this only ever ADDS ids the index did not hold, so no proposal that
  // records today stops recording.
  const fnIndex = new Map([...moduleScopeFunctions(scan), ...scan.functions.map((f) => [f.id, f])]);
  const byFile = boundaryIndex(scan);

  // Classification is over EVERY proposal, always. `--only` narrows what is
  // executed this run, never what is accounted for: a doc that reported 336 as
  // "1 proposal, 1 recorded" is how "stage 4 closed" gets printed over a subset.
  //
  // Read through validate.mjs's `loadProposals` rather than re-implementing the
  // read here, which is what this line used to do. The two were the same
  // `readdirSync().flatMap()` by luck, and `functionBoundaries` - a boundary
  // block declared once per function and overridden per row - is exactly the
  // field that would have landed in one reader and not the other. An answer
  // this stage never sees is the failure this pipeline pays most for: the row
  // runs with no arrangement, reaches nothing, and reads as the service
  // throwing. One reader, so the two stages cannot disagree about what a
  // proposal says.
  const { proposals, malformed } = loadProposals(PROPOSALS_DIR);

  // REFUSED, not recorded around. `loadProposals` now returns a file it could
  // not parse instead of throwing a SyntaxError that named none - and stage 4
  // must not record a SUBSET while reporting it as the corpus. "1 proposal, 1
  // recorded" over a corpus that silently lost a file is the false-completion
  // shape this reader was unified to prevent.
  if (malformed.length) {
    const lines = malformed.map((m) => `    ${m.file}: ${m.message}`).join("\n");
    console.error(
      `charpilot: ${malformed.length} proposal file(s) are not readable JSON, so the corpus is incomplete:\n` +
        `${lines}\n` +
        "  Recording a subset and reporting it as the whole is worse than not recording.\n" +
        "  Fix the file, or move it out of proposals/ deliberately."
    );
    process.exit(1);
  }

  // ONE PROPOSAL PER ID (fix plan 1, F3.1 follow-up). The recording is keyed by
  // id - the row cache, `rows`, `skipped`, and steps/record.mjs's
  // `landedProposals` - and two files carrying one id made behaviour.json hold
  // it as BOTH a recorded row and a skip: pricing-ms `20260922T010226Z` has six
  // ids in two answer files each, one copy skipped, the other recorded, and the
  // row cache served one recording for both. The copy kept is the one
  // `landedProposals` keeps, the LAST in sorted file order; the others are
  // listed in `shadowed` and are not recorded, not skipped and not counted.
  const lastAt = new Map();
  proposals.forEach((p, i) => { if (p?.id !== undefined) lastAt.set(String(p.id), i); });
  const shadowed = [];
  const corpus = proposals.filter((p, i) => {
    if (p?.id === undefined || lastAt.get(String(p.id)) === i) return true;
    shadowed.push({ id: String(p.id), file: p._file ?? null, keptFrom: proposals[lastAt.get(String(p.id))]._file ?? null });
    return false;
  });
  SHADOWED.push(...shadowed);
  if (shadowed.length) {
    process.stdout.write(
      `! ${shadowed.length} proposal(s) share an id with a later file, and the recording is keyed by id - each is ` +
        `recorded from the later file only (${shadowed.slice(0, 3).map((d) => `${d.id}: ${d.file} -> ${d.keptFrom}`).join("; ")}` +
        `${shadowed.length > 3 ? ", …" : ""}). Give each proposal its own id.\n`
    );
  }

  const runnable = [];
  const skipped = [];
  for (const written of corpus) {
    // D68: an id whose file and name pick out one scan function is recorded as
    // that function (validate.mjs resolveFunctionId, which validate reads the
    // same way). A copy: the proposal as written, and its `_fingerprint`, are
    // what the cache and the ledger key on, and they do not move.
    const rk = resolveFunctionId(fnIndex, written);
    const p = rk.rekeyedFrom ? { ...written, functionId: rk.fn.id, rekeyedFrom: rk.rekeyedFrom } : written;
    if (rk.rekeyedFrom) REKEYED.push({ id: p.id, from: rk.rekeyedFrom, to: rk.fn.id });
    const verdict = classify(p, fnIndex, byFile);
    if (!verdict.runnable) {
      skipped.push({ id: p.id, file: p._file, reason: verdict.reason });
      continue;
    }
    // A BUILD THAT WOULD NOT PARSE TAKES THE WHOLE CHUNK WITH IT.
    //
    // The mocks are rendered above the row's async block and `applyMock` calls
    // the thunk synchronously, so a top-level `await` in a boundary build is
    // dead - and the spec is a module, where `await` is reserved, so rollup
    // refuses the FILE:
    //
    //   RollupError: Parse failure: await isn't allowed in non-async function
    //
    // A chunk that does not parse records NONE of its rows, and the pending set
    // re-forms the same chunk, so every resume reproduces it. Measured on
    // notification-ms: one proposal (`sendMessage-119-if-0`) held 16 rows
    // pending across three consecutive resumes and no message named it.
    //
    // `validate.mjs` refuses this proposal by name, and the recorder ran it
    // anyway - `loadProposals` reads the corpus and does not judge it. So the
    // one check whose failure is not survivable is asked here too.
    const awaiting = Object.entries(p.boundaries ?? {})
      .filter(([, b]) => awaitOutsideAsync(b?.mock?.build))
      .map(([sym]) => sym);
    if (awaiting.length) {
      skipped.push({
        id: p.id,
        file: p._file,
        reason:
          `boundaries.${awaiting.join(", boundaries.")} carries a top-level \`await\` in mock.build, which is ` +
          `rendered into a synchronous arrow in a module - the chunk would fail to PARSE and every row in it would ` +
          `record nothing. validate.mjs refuses this proposal by name.`,
      });
      continue;
    }
    const shape = callExpression(verdict.entry, runnable.length, verdict.ctorArgs);
    if (!shape) {
      skipped.push({ id: p.id, file: p._file, reason: "no call shape for this entry kind" });
      continue;
    }
    runnable.push({
      // The proposal that produced this row, kept so the cache can tell an
      // edited input from an unchanged one. Stripped before serialisation.
      proposal: p,
      id: p.id,
      file: p._file,
      functionId: p.functionId,
      covers: p.covers,
      reaches: p.reaches,
      // `a` is read unguarded here on purpose: `classify` has already refused
      // this proposal if `args` is not an array of objects, naming `args[i]`,
      // so a row that reaches this literal cannot carry a null entry. It used
      // to be able to, and `a.value` threw here — after classification had
      // passed — which is the same round-ending crash one step later.
      args: verdict.builtArgs
        ? verdict.builtArgs.map((v) => ({ value: v, build: null }))
        : (p.args ?? []).map((a) => ({ value: a.value, build: a.build ?? a.construct ?? null })),
      env: verdict.env,
      calls: verdict.calls,
      invokeReturned: verdict.invokeReturned ?? null,
      mocks: verdict.mocks,
      bindable: verdict.bindable ?? [],
      // THE ROWS THIS PROPOSAL PUTS INTO STAGING, and without this line there
      // are none. `setup[].apply.db` is parsed above into `verdict.seeds`
      // (record.mjs:786) and read back by the emitter as `row.seeds ?? []`
      // (record.mjs:4110) - and this literal, the ONLY place a runnable row is
      // constructed, listed fourteen fields and `seeds` was not one of them. So
      // `row.seeds` was `undefined` at every read, `${seeds || "// no seeded
      // row"}` rendered a comment, and the row then ran against a database that
      // never got the row it declared it needed.
      //
      // Nothing downstream could notice: a create that writes nothing raises
      // nothing, the proposal validates, the recording succeeds, and the arm it
      // was written for is simply not taken. `setup.apply.db` is the whole
      // answer to a branch that turns on a row staging does not have, so the
      // entire fixture route was dead while reporting success.
      seeds: verdict.seeds ?? [],
      entry: verdict.entry,
      // Carried, because the call shape is REBUILT per chunk and per group -
      // callExpression(r.entry, j, r.ctorArgs) at three sites - and without
      // this field every rebuild passed undefined. The first shape, computed
      // here, was correct; every one after it emitted
      // `new C(undefined, undefined, undefined)`. So constructor injection
      // worked for exactly as long as a row was never regrouped, which is
      // never. Measured on notification-ms: rows threw
      // "Cannot read properties of undefined (reading 'findActiveByUserId')"
      // and 12 of 18 proposals had to build the instance by hand instead.
      ctorArgs: verdict.ctorArgs ?? [],
      shape,
    });
  }
  if (REKEYED.length) {
    process.stdout.write(
      `! ${REKEYED.length} proposal(s) name a functionId the scan spells otherwise, and are recorded as the one scan function ` +
        `their file and name pick out (${REKEYED.slice(0, 3).map((r) => `${r.id}: ${r.from} -> ${r.to}`).join("; ")}` +
        `${REKEYED.length > 3 ? ", …" : ""}). Write the scan's id.\n`
    );
  }

  // THE KILL SWITCH (config.mjs INCREMENTAL_RECORD): off, the key is the whole
  // recorder again and nothing below reuses, stamps or re-records by cause.
  const cache = loadCache(INCREMENTAL_RECORD ? recordingKey() : harnessVersion());
  // D54: which Node the rows are observed under, and where that was read.
  process.stdout.write(`· ${targetNodeLine(TARGET_NODE)}\n`);

  // NOTHING RUNNABLE IS A RECORDING, NOT A STOP (fix plan 1, rule 2).
  //
  // This exited 1 when nothing was cached either - "a STOP, not a shrug" - and
  // left behaviour.json alone otherwise. Both were wrong for the same reason: a
  // proposal refused with a written reason is ACCOUNTED FOR. The first form ended
  // the walk (ai-centralization on a resume, where the seeded doubles.ts has no
  // ioredisMiss() and every row is a named pipeline defect, would die exactly
  // where F1.1 said it must not). The second left the refusals out of the
  // artifact, so steps/record.mjs's `unaccounted` found them missing, `satisfied`
  // stayed false, and the walk re-ran the recorder to the same answer.
  //
  // So the artifact is written through the one door with no rows and every
  // refusal in `skipped`, and the run exits 0. A row the previous recording held
  // is carried into `skipped` with this run's reason by guardOutput, never
  // republished: its proposal is refused now, so the row describes an input
  // that is not the one on disk. Safety refusals (the database guard, tamper,
  // an unreadable corpus) are separate exits and are untouched.
  if (runnable.length === 0) {
    console.error(
      `\nnothing runnable of ${proposals.length} proposals:\n` +
        skipped.slice(0, 10).map((s) => `    ${s.id}: ${s.reason}`).join("\n")
    );
    reportSkips(skipped);
    // --plan writes nothing, here as everywhere else.
    if (PLAN_ONLY) return;
    // NOR DOES --emit-tests (D42). Emitting reads the recording; it never takes
    // one. A resumed qode-ptp-ms run (late September 2026) came up with its
    // 1335-row behaviour.json and no proposals on disk yet, and the walk's emit
    // wrote the recording through this door as 0 rows and 1335 skips ("no
    // proposal on disk carries this id any more") before derive had
    // materialised a single answer.
    if (EMIT_TESTS) {
      process.stdout.write(`\n· nothing to emit: no proposal on disk is runnable, and ${relative(REPO_ROOT, OUTPUT)} is left as it is\n`);
      return;
    }
    REUSE.complete = true;
    writeDoc(proposals, runnable, skipped, cache);
    process.stdout.write(
      `\n· nothing to run: every proposal carries a written reason above, and ${relative(REPO_ROOT, OUTPUT)} ` +
        `now holds them in \`skipped\` with no rows. Each is ruled downstream by its reason - a pipeline defect ` +
        `where the reason says so. This is a round whose answers were refused, not a failed round.\n`
    );
    return;
  }

  // String(): `id` is the agent's field and validate.mjs only asked that it be
  // TRUTHY, so a number or an object reached here. This is the `--only` path
  // verify-on-write takes for every checkpoint row.
  const wanted = selectedOf(runnable);
  // A cached row is reused only if the PROPOSAL is also unchanged. An entry
  // written before fingerprints existed carries none, and is re-run once.
  // THE FILE'S HASH, not this process's.
  //
  // `loadProposals` stamps `_fingerprint` from the row AS WRITTEN, before it
  // merges `functionBoundaries` into `boundaries`. Hashing what this process
  // holds instead hashed the merged document, which `steps/record.mjs` — which
  // reads the file directly — can never reproduce for a proposal that inherits
  // a hoisted block, carries no `boundaries` key, or deletes a symbol with an
  // explicit null. The stamp the recorder writes was then permanently
  // unmatchable, `satisfied()` permanently false, and the walk re-recorded the
  // same rows every round to the same rejection. See the note at
  // validate.mjs:`loadProposals` for the run this cost.
  //
  // The fallback is for a caller holding a proposal this loader did not build.
  const fingerprints = new Map(
    wanted.map((r) => [r.id, (r.proposal ?? r)?._fingerprint ?? proposalFingerprint(r.proposal ?? r)])
  );
  // THE ARTIFACT ON DISK, AS A SECOND CACHE (item 6b; see recordingMismatch).
  // Not for --emit-tests or --emit-specs, which record nothing.
  const INCREMENTAL = INCREMENTAL_RECORD && !EMIT_TESTS && !EMIT_SPECS;
  const prior = INCREMENTAL ? priorRecording() : null;
  const seeded = INCREMENTAL ? seedFromRecording(cache, prior, wanted, fingerprints) : [];
  if (seeded.length) {
    process.stdout.write(
      `· ${seeded.length} row(s) taken from ${relative(REPO_ROOT, OUTPUT)}, recorded from the same input under the same key - ` +
        `each is checked against the repo's code below before it is served\n`
    );
  }
  // D67 - AN OBSERVATION FROM A SUCCESSFUL ARRANGEMENT IS NOT REPLACED BY A
  // FAILURE OF THE ENVIRONMENT (prismaclient.mjs `environmentCause`).
  //
  // Every eviction below sends a row the cache or the artifact holds back to
  // the recorder, and a recorder running where a workspace is unbuilt or the
  // Prisma client is not generated brings back `Failed to resolve entry for
  // package` for it - which then took the good row's place, and the emit
  // dropped its test. So the successful observations of THIS input (the same
  // `__fingerprint`) are noted before anything is evicted, and a row that comes
  // back failed on the environment keeps the one noted here, stamped
  // `__environment` with what failed. That is a hold, never a substitution:
  // the stamped row is recorded again as soon as the environment is set up
  // (the eviction after the harness one below; steps/record.mjs
  // `environmentRows`), and until then the recording names the defect. Only an
  // observation from a successful arrangement supersedes one.
  const earlier = new Map();
  if (!EMIT_TESTS && !EMIT_SPECS) {
    const onDisk = new Map(((prior ?? priorRecording())?.rows ?? []).map((row) => [String(row?.id), row]));
    for (const r of wanted) {
      const found = [cache.rows[r.id], onDisk.get(String(r.id))].find(
        (row) => row && row.invoked === true && !row.harnessError && row.__fingerprint === fingerprints.get(r.id)
      );
      if (found) earlier.set(r.id, found);
    }
  }
  const staleInput = wanted.filter(
    (r) => cache.rows[r.id] && cache.rows[r.id].__fingerprint !== fingerprints.get(r.id)
  );
  if (staleInput.length) {
    process.stdout.write(
      `· ${staleInput.length} cached row(s) had their proposal edited since - re-recording those\n`
    );
  }
  // AND THE OLD ROW IS DROPPED NOW, not when its replacement arrives.
  //
  // Re-recording was the whole of the repair loop and it had a hole: the stale
  // row stayed in the cache until a chunk SUCCEEDED and overwrote it. A chunk
  // that fails (`chunk produced no rows`) or a row the egress guard stops never
  // overwrites anything, so `writeDoc` republished the PREVIOUS recording -
  // carrying the PREVIOUS `__fingerprint` - as this run's account of an input
  // that had since been rewritten.
  //
  // steps/record.mjs:`superseded()` then compares that fingerprint against the
  // proposal on disk, finds them different, and `satisfied()` is false. Running
  // the step again changes nothing: the same chunk fails, the same old row is
  // republished, the same mismatch is reported. That is a deadlock, and it is
  // not cheap. Run 20260918T073111Z (qode-ptp-ms, one shard) closed 865 of 865
  // sides across 7 rounds of an allowed 14 with zero errors, and then wrote NO
  // result.json at all, because 16 repaired proposals were stuck in exactly
  // this state. A run that did all of its work produced nothing.
  //
  // Evicting first makes the failure honest. If the re-record succeeds the new
  // row lands as before. If it does not, the proposal has NO row, so it is
  // reported as `runnable but not yet run in this session` - which is true, and
  // which the next round can act on - instead of as a recording of an input
  // that no longer exists.
  for (const r of staleInput) delete cache.rows[r.id];
  // A CACHED ROW THAT FAILED ON @prisma/client's PLACEHOLDER, now that the
  // client is generated (D42, prismaclient.mjs): the failure was the install's,
  // not the input's, so the row is run again rather than served.
  if (placeholderRowsAreStale(REPO_ROOT)) {
    const onPlaceholder = wanted.filter((r) => cache.rows[r.id] && failedOnPlaceholder(cache.rows[r.id]));
    if (onPlaceholder.length) {
      process.stdout.write(`· ${onPlaceholder.length} cached row(s) failed on @prisma/client's placeholder, and the client is generated now - re-recording those\n`);
      for (const r of onPlaceholder) delete cache.rows[r.id];
    }
  }
  const HARNESS = harnessVersion();
  const recordedElsewhere = (row) => row && row.__recordedBy !== HARNESS;
  // A ROW THE RECORDER ITSELF FAILED ON, recorded by another toolset: the
  // failure was the harness's, and this is a different harness. The step asks
  // for exactly these again (steps/record.mjs `superseded`, evidence
  // "harness"), so serving them would leave it unsatisfied after the run that
  // was meant to satisfy it. The whole-file key used to do this by recording
  // every row; now it is these rows, a few dozen at most.
  const harnessFailed = INCREMENTAL ? wanted.filter((r) => cache.rows[r.id]?.harnessError && recordedElsewhere(cache.rows[r.id])) : [];
  if (harnessFailed.length) {
    process.stdout.write(`· ${harnessFailed.length} cached row(s) are a harness failure another toolset recorded - recording those again under this one\n`);
    for (const r of harnessFailed) delete cache.rows[r.id];
  }
  // D67: A CACHED ROW THE ENVIRONMENT FAILED - or one kept over such a failure
  // (`__environment`) - once that environment is set up. The failure was the
  // install's, so the row is run again rather than served; D42's rule above,
  // for every cause prismaclient.mjs names.
  const setUp = new Map();
  const isSetUp = (key) => {
    if (!setUp.has(key)) setUp.set(key, environmentFixed(key, REPO_ROOT));
    return setUp.get(key);
  };
  const envAgain =
    EMIT_TESTS || EMIT_SPECS
      ? []
      : wanted.filter((r) => {
          const row = cache.rows[r.id];
          const key = row ? environmentCause(row, REPO_ROOT)?.key ?? row.__environment?.cause : null;
          return key ? isSetUp(key) : false;
        });
  if (envAgain.length) {
    const keys = [...setUp].filter(([, ok]) => ok).map(([k]) => k);
    process.stdout.write(
      `· ${envAgain.length} cached row(s) failed on the environment (${keys.join(", ")}), and it is set up now - recording those again\n`
    );
    for (const r of envAgain) delete cache.rows[r.id];
  }
  // A ROW WITH NO STABLE VERDICT, recorded by another toolset. Reused, it is
  // either unchecked by the replay or judged across two toolsets:
  //   - UNSTABLE: its unstable paths are left out of the assertion, so cigate
  //     stays green whatever these tools would observe there now - and a tools
  //     fix is exactly what can make them stable (D49, a row reads its own
  //     clock, turned timestamps into values);
  //   - NOT COMPARED, or no verdict: determinism would compare this old first
  //     observation with a second one these tools take, which measures the
  //     toolset change, not the row. The sourcing-ms resume (26 September 2026)
  //     did exactly that to 93 rows its checkpoint left `compared: false`, and
  //     called every uuid and timing they returned unstable, where a fresh
  //     recording under D49 and the seeded Math.random has 3.
  // So these are recorded again, and both observations are these tools'. A
  // stable row is asserted whole, and cigate is its check.
  // The verdict the row will be published with: its own, or the one the
  // artifact carries for this very recording (writeDoc, priorVerdicts).
  const verdictOf = (id, row) => {
    if (row.determinism) return row.determinism;
    const v = priorVerdicts().get(String(id));
    return v && row.__recording && v.recording === row.__recording && v.fingerprint === row.__fingerprint ? v.determinism : null;
  };
  const verdictElsewhere = INCREMENTAL
    ? wanted.filter((r) => {
        const row = cache.rows[r.id];
        if (!row || !recordedElsewhere(row)) return false;
        const v = verdictOf(r.id, row);
        return !(v?.compared === true && v.stable === true);
      })
    : [];
  if (verdictElsewhere.length) {
    process.stdout.write(`· ${verdictElsewhere.length} cached row(s) another toolset recorded carry no stable verdict - recording those again, so both of their observations are these tools'\n`);
    for (const r of verdictElsewhere) delete cache.rows[r.id];
  }
  // THE CIGATE PATH (`--rerecord`). Only a row another toolset recorded.
  const redAgain = RERECORD && INCREMENTAL ? wanted.filter((r) => RERECORD.has(String(r.id)) && recordedElsewhere(cache.rows[r.id])) : [];
  if (RERECORD && INCREMENTAL) {
    const own = [...RERECORD].filter((id) => cache.rows[id] && !recordedElsewhere(cache.rows[id]));
    process.stdout.write(
      `· --rerecord: ${redAgain.length} of ${RERECORD.size} row(s) were recorded by another toolset - recording them under this one` +
        (own.length ? `; ${own.length} were recorded by this one already, and are left as recorded (red under these tools, so cigate withholds them)` : "") +
        "\n"
    );
    for (const r of redAgain) delete cache.rows[r.id];
  }
  // THE REPO'S CODE (sourcedeps.mjs): a row whose code moved is recorded again.
  const { evicted: codeMoved, graph } = INCREMENTAL ? await evictMovedRows(cache, wanted, prior) : { evicted: [], graph: null };
  if (codeMoved.length) {
    const files = new Map();
    for (const e of codeMoved) for (const f of e.files ?? []) files.set(f, (files.get(f) ?? 0) + 1);
    const top = [...files].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, n]) => `${f} (${n})`).join(", ");
    process.stdout.write(
      `· ${codeMoved.length} cached row(s) depend on code that changed since they were recorded - re-recording those` +
        (top ? `: ${top}` : `: ${codeMoved[0].why}`) +
        "\n"
    );
  }
  REUSE.seeded = seeded.length;
  REUSE.graph = graph;
  REUSE.why = new Map([
    ...staleInput.map((r) => [r.id, "its proposal changed"]),
    ...codeMoved.map((e) => [e.id, `its code changed: ${e.why}`]),
    ...harnessFailed.map((r) => [r.id, "a harness failure another toolset recorded"]),
    ...envAgain.map((r) => [r.id, "it failed on the environment, which is set up now"]),
    ...verdictElsewhere.map((r) => [r.id, "another toolset recorded it, and it has no stable verdict"]),
    ...redAgain.map((r) => [r.id, "cigate found it red, and another toolset recorded it"]),
  ]);
  REUSE.evicted = {
    proposal: staleInput.length,
    code: codeMoved.length,
    harnessFailure: harnessFailed.length,
    environmentSetUp: envAgain.length,
    verdictElsewhere: verdictElsewhere.length,
    cigateRed: redAgain.length,
  };
  const todo = wanted.filter(
    (r) => FRESH || !cache.rows[r.id] || cache.rows[r.id].__fingerprint !== fingerprints.get(r.id)
  );

  if (PLAN_ONLY) {
    process.stdout.write(
      // The live decision is a SAFETY decision, so it prints wherever a run
      // reports anything. An unobservable gate cannot be checked, and today
      // has three separate cases of a control that was on and invisible.
      `\n· stage 4 boundaries: ${LIVE ? "LIVE against staging" : "MOCKED"} - ${LIVE_DECISION.why}` +
      `\n· plan: ${runnable.length} runnable of ${proposals.length} · ${skipped.length} skipped ` +
        `· ${Object.keys(cache.rows).length} cached · ${todo.length} to run\n`
    );
    reportSkips(skipped);
    return;
  }

  const env = buildEnv();
  const chunks = [];
  for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  process.stdout.write(
    dbGuardNotice() +
    `· egress: ${
      LIVE
        ? "OPEN - outbound calls go out as configured; the environment decides what is reachable"
        : ALLOW_HOSTS.length
          ? `CLOSED except ${[...new Set(ALLOW_HOSTS)].sort().join(" ")} (typed for this run)`
          : "CLOSED - a mocked run reaches nothing, every outbound call is refused"
    }\n` +
    `· ${runnable.length} runnable of ${proposals.length} · ${Object.keys(cache.rows).length} already cached ` +
      `· running ${todo.length} in ${chunks.length} chunk(s) of ${CHUNK}\n`
  );

  if (EMIT_TESTS) {
    // Stage 5 emits tests only for rows that HAVE a recorded outcome. A row
    // with no observation has nothing to assert, and inventing one is exactly
    // the failure this pipeline exists to prevent.
    // OUTPUT, not BEHAVIOUR_JSON: under --live the pairs live in
    // behaviour-live.json, and emitting from the mocked artifact would generate
    // tests asserting values that never came from staging.
    const behaviour = existsSync(OUTPUT) ? JSON.parse(readFileSync(OUTPUT, "utf8")) : { rows: [] };
    const observed = new Map((behaviour.rows ?? []).filter((r) => r.invoked).map((r) => [r.id, r]));

    // D66 - A RECORDING THAT SAYS NOTHING ABOUT THESE ROWS IS NOT A REASON TO
    // DROP THEIR TESTS.
    //
    // WHAT THIS DID. A missing OUTPUT read as `{ rows: [] }`, every runnable
    // row then had "no recorded outcome", and the emit went on to land a suite
    // of nothing: every spec the manifest owned was an orphan and was deleted.
    // qode-itl-be's checkpoint `3a0dd7e-20260926T184305Z` carried no
    // behaviour.json, and one `--emit-tests` printed `0 of 1323 runnable rows
    // had a recorded outcome to assert`, removed all 142 delivered specs and
    // wrote an empty manifest and recorded.json. D53 made the emit never wipe
    // the RECORDING; this is the same rule for the delivered SUITE.
    //
    // THE RULE: a runnable row the recording does not ACCOUNT for - in neither
    // `rows` nor `skipped` - refuses the emit, and nothing is touched. A
    // recording taken from these proposals accounts for every one of them: the
    // recorder writes each runnable row it ran into `rows` and each one it
    // refused, with its reason, into `skipped` (fix plan 1, rule 2), and a row
    // it held before and lost is carried into `skipped` by guardOutput. So an
    // unaccounted row means the recording is missing, empty, older than the
    // proposals, or somebody else's - and its silence about a row says nothing
    // about that row's behaviour.
    //
    // WHY NOT A THRESHOLD ("refuse under N% asserted"). A LEGITIMATE shrink is
    // not a small number, it is an accounted one: a proposal that was removed
    // is not runnable, so its row is not asked about at all and its spec goes
    // as an orphan exactly as before; a row the recorder refused this time is
    // in `skipped` with the recorder's reason, and stage 6 counts it with that
    // reason. Both can take a suite to zero and are right to. A threshold would
    // refuse those and would let through a stale recording that happened to
    // share most of its ids - the question is WHOSE recording, not how full.
    //
    // WHY EXACTLY THIS CONDITION: it is steps/record.mjs `unaccounted`, the
    // first clause of `record.satisfied`. So whenever this refuses, the walk's
    // `record` is not satisfied and runs first - it is ahead of `emit` in
    // ORDER - and the refusal clears itself one step back (steps/emit.mjs
    // `precondition` asks the same). A refusal on anything `record` could call
    // done would be one the walk could never get out of.
    const accounted = new Set([...(behaviour.rows ?? []), ...(behaviour.skipped ?? [])].map((r) => String(r?.id)));
    const unrecorded = wanted.filter((r) => !accounted.has(String(r.id)));
    if (unrecorded.length) {
      // What the emit would have removed, for the message only. Asked of the
      // same ownership plan the emit uses; a target it would refuse outright
      // counts none.
      let owned = 0;
      try {
        owned = planEmitTarget(EMIT_TESTS, []).ours.length;
      } catch {
        owned = 0;
      }
      process.stderr.write(
        `\n✗ record.mjs --emit-tests: refusing to emit - ` +
          (existsSync(OUTPUT)
            ? `${unrecorded.length} of ${wanted.length} runnable row(s) are in neither \`rows\` nor \`skipped\` of ${relative(REPO_ROOT, OUTPUT)}, ` +
              `so that recording was not taken from these proposals (it is empty, older than them, or another checkout's)`
            : `${relative(REPO_ROOT, OUTPUT)} is missing, so none of ${wanted.length} runnable row(s) has a recording`) +
          `.\n  Emitting would read the recording's silence as "no outcome" and ` +
          (owned ? `remove the ${owned} spec file(s) this tool delivered to ${relative(REPO_ROOT, EMIT_TESTS)}` : `land an empty suite`) +
          `; ${relative(REPO_ROOT, EMIT_TESTS)} is left exactly as it is.\n` +
          `  Record them first, then stamp and emit:\n` +
          `    node .claude/charpilot/record.mjs${LIVE ? " --live" : ""}\n` +
          `  Unrecorded: ${unrecorded.slice(0, 8).map((r) => r.id).join(" ")}` +
          (unrecorded.length > 8 ? ` (+${unrecorded.length - 8} more)` : "") +
          "\n"
      );
      process.exit(1);
    }

    // D67 - NOR IS A RECORDING THE ENVIRONMENT FAILED.
    //
    // D66's recording said nothing about the rows; this one says something
    // about every row and is still no reason to drop a test. qode-itl-be's
    // checkpoint recorded in a container where @qode/contract was unbuilt and
    // the Prisma client not generated: 884 of 1323 rows failed to arrange, all
    // of them accounted for, and the emit read them as "no outcome" and took
    // the delivered suite from 142 spec files to 64.
    //
    // THE RULE: while the recording carries an environment defect
    // (prismaclient.mjs `environmentDefect` - causes still broken on this disk
    // that are a mass of the rows, or cost a row the delivered suite asserts),
    // the emit refuses and nothing is touched. Same condition as steps/record's
    // `defects` and steps/emit's `precondition`, so the walk names the defect
    // at `record` and holds `emit` behind it instead of running into this; and
    // once the environment is set up `record` is not satisfied, the failed rows
    // are recorded again, and the condition clears itself.
    const envDefect = environmentDefect(behaviour, REPO_ROOT, {
      delivered: deliveredIds(EMIT_TESTS),
      landed: new Set(wanted.map((r) => String(r.id))),
    });
    if (envDefect) {
      const keyOf = (r) => String(r.functionId ?? r.file).split(":")[0].replace(/^src\//, "").replace(/\.ts$/, "").replace(/\//g, "-");
      let shrink = { orphans: [], ours: [] };
      try {
        // N6: a key's spec may be written in parts; those are the key's too.
        const present = existsSync(EMIT_TESTS) ? readdirSync(EMIT_TESTS).filter(isCorpusSpec) : [];
        const keys = [...new Set(wanted.filter((r) => observed.has(r.id)).map(keyOf))];
        shrink = planEmitTarget(EMIT_TESTS, [...new Set(keys.flatMap((k) => [`${k}${CORPUS_SUFFIX}`, ...specsOfKey(k, present, CORPUS_SUFFIX)]))]);
      } catch {
        // A target the emit would refuse outright costs nothing to name here.
      }
      process.stderr.write(
        `\n✗ record.mjs --emit-tests: refusing to emit - ${envDefect.sentence}.\n` +
          (shrink.orphans.length
            ? `  Emitting would read those rows as "no outcome" and remove ${shrink.orphans.length} of the ` +
              `${shrink.ours.length} spec file(s) this tool delivered to ${relative(REPO_ROOT, EMIT_TESTS)}`
            : `  Emitting would render a suite from a recording the environment could not take`) +
          `; ${relative(REPO_ROOT, EMIT_TESTS)} is left exactly as it is.\n` +
          `  Set the environment up, then record them again, stamp and emit:\n` +
          `    node .claude/charpilot/record.mjs${LIVE ? " --live" : ""}\n`
      );
      process.exit(1);
    }

    // THE ROW BUDGET COMES FROM THE ROWS, never from this command line. The
    // generated file bakes one `ROW_TIMEOUT_MS` in, and it used to be whatever
    // --row-timeout this invocation carried - so `pilot:emit` after a recording
    // at 30000ms baked the 10s default, the spec timed out, a side was lost and
    // the resulting FALSE claim pointed at the input. See resolveRowTimeout.
    const budget = resolveRowTimeout(behaviour, {
      flagMs: ROW_TIMEOUT_GIVEN ? ROW_TIMEOUT_MS : null,
      where: "--emit-tests",
    });
    if (budget.refusal) {
      process.stderr.write(`\n✗ ${budget.refusal}\n`);
      process.exit(1);
    }
    if (budget.notice) process.stdout.write(`${budget.notice}\n`);
    // A claim stage 6 measured as never reached is marked in the test, not
    // silently dropped: the pair is real, its LABEL is wrong, and hiding that
    // would leave a mislabelled arm pinned as a contract.
    const covPath = join(OUT_DIR, "coverage.json");
    const falseClaimIds = new Set(
      existsSync(covPath) ? (JSON.parse(readFileSync(covPath, "utf8")).falseClaims ?? []).map((f) => f.id) : []
    );

    // Paths measured as unstable across two runs, so the assertion can exclude
    // exactly those and keep the rest of the value pinned.
    const detPath = join(OUT_DIR, "determinism.json");
    const detDoc = existsSync(detPath) ? JSON.parse(readFileSync(detPath, "utf8")) : null;
    const unstable = new Map((detDoc?.rows ?? []).map((r) => [r.id, r.unstablePaths ?? []]));

    // REFUSED, NOT DEFAULTED. This used to be `existsSync(detPath) ? ... : []`,
    // so a missing or non-covering determinism report meant "no row carries
    // per-run identity" - and every emitted assertion came out byte-exact on a
    // value whose stability had never been measured.
    //
    // Invisible in exactly the way that matters: emit succeeds, the count reads
    // "N of N rows had a recorded outcome to assert", and the failure arrives a
    // stage later as a value diff that looks like the SERVICE being
    // nondeterministic. On location-ms three rows failed on
    // `returned.createdAt.$date` alone, and the mocked run passed the same rows
    // only because determinism.mjs could read the mocked artifact and not the
    // live one.
    //
    // The verdict is read off the OBSERVATION, not off the file's existence: a
    // row the report does not cover is an UNCHECKED row, not a stable one, and
    // a side file can go stale against the recording it judges.
    const qPath = join(OUT_DIR, "quarantine.json");
    const qDoc = existsSync(qPath) ? JSON.parse(readFileSync(qPath, "utf8")) : null;

    const withOutcome = wanted.filter((r) => observed.has(r.id));
    const unstamped = withOutcome.filter((r) => !observed.get(r.id).determinism).map((r) => r.id);
    if (unstamped.length) {
      const how =
        "    node .claude/charpilot/determinism.mjs" +
        (LIVE ? " --live" : "") +
        " --write" +
        (ENV_FILE ? " --env-file " + ENV_FILE : "");
      process.stderr.write(
        "\n✗ record.mjs --emit-tests: refusing to emit - " +
          unstamped.length +
          " of " +
          withOutcome.length +
          " row(s) carry no determinism verdict.\n" +
          "  Emitting them would assert a value byte-exactly without ever having measured whether\n" +
          "  that value is the same on a second observation. A subject that writes a fresh Date or\n" +
          "  uuid into its own return value then produces a test that CANNOT pass, and the failure\n" +
          "  reads as the service being nondeterministic rather than as this stage being skipped.\n" +
          "  Measure them first:\n" +
          how +
          "\n  Unstamped: " +
          unstamped.slice(0, 8).join(" ") +
          (unstamped.length > 8 ? " (+" + (unstamped.length - 8) + " more)" : "") +
          "\n"
      );
      process.exit(1);
    }

    for (const r of withOutcome) {
      const o = observed.get(r.id);
      r.returned = o.returned;
      r.threw = o.threw;
      r.notSettled = o.notSettled;
      // The recorded downstream calls. Omitted here originally, which is why
      // stage 5 asserted only the return value: 755 recorded calls across 246
      // rows never reached the generated test, because the row handed to
      // assertionFor() was the PROPOSAL, and only these fields were copied onto
      // it from the observation.
      r.boundaryCalls = o.boundaryCalls;
      // D63: the instant the recording's clock started, so the replay's starts
      // there too and a date the subject derives from now is the recorded one
      // on any later day. Absent on a row recorded before it: that replays on
      // real time, as it did.
      r.clockEpoch = o.clockEpoch;
      r.__claimUnverified = falseClaimIds.has(r.id);
      r.__unstablePaths = unstable.get(r.id) ?? [];
      r.__observation = observationKey(r, o);
    }

    // A QUARANTINE HOLDS THE OBSERVATION IT JUDGED, NOT THE ROW ID (D33).
    // cigate withholds a red row by rendering it `it.skip`, and a skipped test
    // can neither fail nor pass - so an entry keyed on the id alone was
    // permanent. assessment-service's and contact-ms's module-scope rows (late
    // September 2026) were re-recorded after their repair, verified at record
    // time, and still emitted `it.skip` under the reason the OLD recording
    // earned, so their sides were never measured and the runs stalled on them.
    // And the RENDERER it judged: see config.mjs `emitterDigest`.
    const { quarantined, released, kept } = bindQuarantine(qDoc?.rows ?? [], withOutcome, emitterDigest());
    for (const r of withOutcome) r.__quarantine = quarantined.get(r.id) ?? null;
    if (released.length) {
      process.stdout.write(
        `· ${released.length} quarantined row(s) were recorded again, or are rendered by a record.mjs that has changed, ` +
          `since they were withheld - emitted to run, so cigate judges THIS test ` +
          `(${released.slice(0, 3).join(", ")}${released.length > 3 ? ", …" : ""})\n`
      );
    }

    mkdirSync(EMIT_TESTS, { recursive: true });

    // One test file per SOURCE file, not per chunk: a reader looking for the
    // tests that pin src/services/redis.service.ts should find one file.
    const byFile = new Map();
    for (const r of withOutcome) {
      // `r.file` is the PROPOSAL's json filename, not the source file - grouping
      // on it produced "cache-decorator.json.char.test.ts". The source file is
      // the head of functionId ("src/services/redis.service.ts:52:retryStrategy").
      const src = String(r.functionId ?? r.file).split(":")[0];
      const key = src.replace(/^src\//, "").replace(/\.ts$/, "").replace(/\//g, "-");
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(r);
    }
    // Know the filenames BEFORE touching the directory: the ownership plan needs
    // the set this run will write in order to tell an orphan from a foreign file.
    const willWrite = [...byFile.keys()].map((key) => `${key}${CORPUS_SUFFIX}`);
    // N6: asked here for its refusal; asked again once the parts are known.
    let plan = planEmitTarget(EMIT_TESTS, willWrite);

    /*
     * RENDERED BESIDE THE TARGET AND THEN MOVED IN - never rendered over it.
     *
     * WHAT THIS USED TO DO. The orphans were deleted first, each file was then
     * written straight into EMIT_TESTS by writeSpec and rewritten in place by
     * hermeticise, and `emitted.json` was written last. Every instant in
     * between is a state on disk: a target whose suite has been removed or half
     * replaced, beside an `emitted.json` still describing the suite that used
     * to be there.
     *
     * WHAT IT COST. A failure or a kill anywhere in that stretch leaves no
     * *.test.ts and a stale manifest. `measure.precondition` then refuses the
     * round with "no *.test.ts", and re-running `emit` does not clear it: by
     * then the recording is superseded, so `emit` refuses in its turn and the
     * two refusals hold each other up. The suite is not recoverable from the
     * manifest either - the manifest names files and hashes, not their
     * contents.
     *
     * SO THE RENDER HAPPENS SOMEWHERE ELSE AND THE RESULT IS MOVED. Nothing in
     * the target is touched until every file of this emit exists complete, and
     * a render that dies leaves the previous suite exactly as it was.
     *
     * WHY A SIBLING DIRECTORY, and not one inside the target or one under
     * /tmp: `doublesImport` (record.mjs:3277) bakes the relative path from the
     * FILE'S OWN DIRECTORY to test/fixtures/doubles into every rendered spec,
     * so a staging directory at a different depth renders a different import -
     * a suite that cannot resolve its doubles, which is a worse failure than
     * the one being fixed because it survives the landing. A sibling is at the
     * same depth, and on the same filesystem, which is also what makes
     * `renameSync` a move rather than a copy.
     *
     * WHY NOT SWAP THE WHOLE DIRECTORY. EMIT_TESTS is not this tool's
     * directory - `planEmitTarget` exists precisely because it holds files this
     * tool did not write, and it may hold subdirectories, fixtures and helpers
     * no listing here enumerates. Replacing the directory would take all of
     * them with it, and a kill between the two renames such a swap needs would
     * leave no directory at all. So the swap is PER FILE: each rename is atomic
     * for that name, the manifest lands last, and the orphans are removed only
     * once everything is in place. The window that remains is between two
     * renames rather than across a whole render, and at every point in it the
     * target holds a complete suite - the previous one, this one, or a mixture
     * of the two - never none of one, which is the only state nothing
     * downstream can get out of.
     */
    const STAGE = join(dirname(EMIT_TESTS) || ".", `.${basename(EMIT_TESTS)}.emitting-${RUN_ID}`);
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
    try {
      let emitted = 0;
      let unverified = 0;
      const emittedFiles = [];
      // The staged file for each name this run will land, in landing order.
      const staged = [];
      const render = (name, rows) => {
        const results = writeSpec(rows, join(STAGE, name), "test", budget.ms);
        // Stage 4 may call live staging. Stage 5 may not - strip the live
        // arrangement before the file is committed.
        hermeticise(join(STAGE, name), behaviour.harnessEnv ?? recordedHarnessEnv());
        // D55: and the checkout's absolute root is resolved where the file
        // is, at test time - never the container's /work/repo (rootfree.mjs).
        // The staging directory is a sibling at the same depth, so the
        // relative walk it bakes is the landed file's.
        rootFreeSpec(join(STAGE, name), join(EMIT_TESTS, name));
        return results;
      };
      // N6 (specsplit.mjs): a file past the bound is written again as parts.
      const bound = splitBytes();
      const splits = [];
      for (const [key, group] of byFile) {
        // Shapes are numbered over the WHOLE file, so a row renders the same
        // whether its file is split or not.
        group.forEach((r, j) => { r.shape = callExpression(r.entry, j, r.ctorArgs) ?? r.shape; });
        const whole = `${key}${CORPUS_SUFFIX}`;
        let units = [[whole, render(whole, group), group]];
        const bytes = statSync(join(STAGE, whole)).size;
        const n = partCount(bytes, bound);
        if (n > 1) {
          rmSync(join(STAGE, whole), { force: true });
          units = splitRows(key, group, n).map(([k, rows]) => [`${k}${CORPUS_SUFFIX}`, render(`${k}${CORPUS_SUFFIX}`, rows), rows]);
          splits.push({ file: relative(REPO_ROOT, join(EMIT_TESTS, whole)), bytes, rows: group.length, parts: units.map(([name, , rows]) => ({ file: relative(REPO_ROOT, join(EMIT_TESTS, name)), bytes: statSync(join(STAGE, name)).size, rows: rows.length })) });
        }
        for (const [name, results, rows] of units) {
          staged.push(name);
          // The name the file will HAVE, not the one it has: the manifest describes
          // the landed suite, and it is written before the landing so that both can
          // go in together.
          emittedFiles.push(relative(REPO_ROOT, join(EMIT_TESTS, name)));
          emitted += results.filter((x) => x.kind !== "skip").length;
          unverified += rows.filter((r) => r.__claimUnverified).length;
        }
      }
      for (const sp of splits) {
        process.stdout.write(
          `· ${sp.file} would be ${(sp.bytes / 1048576).toFixed(1)} MB (${sp.rows} rows), over the ${(bound / 1048576).toFixed(0)} MB bound, so it is written as ` +
            `${sp.parts.length} parts by row id: ${sp.parts.map((p) => `${p.file.split("/").pop()} ${(p.bytes / 1048576).toFixed(1)} MB, ${p.rows} rows`).join("; ")} ` +
            `(CHARPILOT_SPEC_SPLIT=off writes one file)\n`
        );
      }
      // The names this emit lands, parts included: what is ours and not among
      // them is an orphan, and a part landed here is not one.
      if (splits.length) plan = planEmitTarget(EMIT_TESTS, staged);
      // THE STAGED COPIES, read where they actually are. These are the bytes
      // about to land, and the target still holds the PREVIOUS suite - asking
      // this question of the destination names the specifiers of the emit
      // before this one. Repo-relative, because that is what this reader takes.
      const unresolved = unresolvableSpecifiers(staged.map((name) => relative(REPO_ROOT, join(STAGE, name))));

      // STAMP THE INVOCATION. Without this the emitted suite is not a function of
      // the repo: a bare `--emit-tests` drops the auto-injected ioredis and axios
      // doubles every row carries, because that injection is gated on
      // `--policy right-level` while the default is `as-declared` - and nothing
      // recorded which was used. Regenerating produced a suite differing in 33 of
      // 33 files, then 17 of 33 with the flag, with no way to tell an intended
      // change from a flag drift. recorded.env stamps env vars only.
      //
      // So the manifest sits beside the suite it produced and names every input
      // that decides the output: flags, the artifact asserted from, and that
      // artifact's own recordedAt.
      const manifest = {
        stage: 5,
        emittedAt: new Date().toISOString(),
        argv: process.argv.slice(2),
        policy: POLICY,
        output: relative(REPO_ROOT, OUTPUT),
        outputRecordedAt: behaviour.recordedAt ?? null,
        // The per-row budget baked into every file this run wrote, and WHERE it
        // came from. `argv` above cannot answer it: the whole defect was that the
        // number in the file was NOT a function of the argv, and on an artifact
        // that predates the field it still is not - so the source is recorded
        // rather than implied.
        rowTimeoutMs: budget.ms,
        rowTimeoutMsSource: budget.source,
        rows: { wanted: wanted.length, asserted: withOutcome.length, unverified },
        // `files: emitted` was a TEST count wearing a file label. Both are here
        // now, named, and the LIST is what makes ownership checkable on the next
        // run - a file this tool wrote is one it can remove; anything else is
        // the agent's and is left alone.
        tests: emitted,
        files: emittedFiles.length,
        emittedFiles: emittedFiles.sort(),
        // A hash per file, so "do not hand-edit" stops being an honour system.
        // Every assertion in these files is trustworthy only because a run
        // produced it; a hand-typed expected value wears the same header and
        // reads as recorded. This is the committed evidence that it was not
        // touched - checked offline by emitted-integrity.mjs, which is the one
        // charpilot check a CI runner can execute (out/ is gitignored).
        // HASHED OFF THE STAGED BYTES, which are the bytes that land: a rename
        // moves a file, it does not rewrite it. Reading the target here instead
        // would read the PREVIOUS suite, because nothing has been moved in yet.
        emittedFileHashes: Object.fromEntries(
          staged
            .slice()
            .sort()
            .map((name) => [
              relative(REPO_ROOT, join(EMIT_TESTS, name)),
              createHash("sha256").update(readFileSync(join(STAGE, name), "utf8")).digest("hex"),
            ])
        ),
        // Written down so a reviewer reading the manifest sees what CI is about
        // to report. Empty on a repo whose config this picker cannot parse.
        unresolvableSpecifiers: unresolved,
        leftAlone: plan.foreign.sort(),
        // N6: each source file whose spec is written in parts, and the parts.
        ...(splits.length ? { splits } : {}),
        reproduce: `node .claude/charpilot/record.mjs --policy ${POLICY} --emit-tests ${relative(REPO_ROOT, EMIT_TESTS)}`,
      };
      writeFileSync(join(STAGE, "emitted.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      // THE ENV, BY NAME, beside the suite that needs it. See
      // `stampRecordedEnv`: two readers defaulted to this path and nothing
      // wrote it, so the corpus was not reproducible off its own branch.
      // Rendered into STAGE like everything else, so it lands or it does not.
      const recordedEnv = stampRecordedEnv(recordingEnvText(), envSchemaShapes());
      if (recordedEnv) writeFileSync(join(STAGE, "recorded.env"), recordedEnv);

      // THE RUNNER CONFIG, committed with the suite. See `corpusVitestConfig`:
      // the check `cicheck.mjs` writes pointed at `.claude/`, which repos
      // gitignore, so it could not pass on any pushed branch.
      // THE RECORDING, beside the corpus and readable by the next run. See
      // `recordedRows`: the specs carry this data but are not a store, and
      // `.claude/charpilot/proposals/` never reaches the branch at all.
      const recorded = recordedRows(
        withOutcome.map((r) => ({ ...r, ...(observed.get(r.id) ?? {}) })),
        { ...recordedCommit(), ledger: armIdLedger(), harness: harnessVersion(), emitter: emitterDigest() }
      );
      // IN SHARDS WHEN ONE FILE WOULD NOT FIT ON THE REMOTE (D57, recordedstore.mjs):
      // qode-ptp-ms's 1,404 rows were a 110 MB recorded.json, over GitHub's
      // 100 MiB per-file limit, and neither its PR nor its checkpoint could be
      // pushed. Under SHARD_BYTES this is the one file it always was.
      const recordedFiles = renderRecorded(recorded);
      writeRecorded(STAGE, recordedFiles);

      const corpusBase = corpusBaseOf(REPO_ROOT, EMIT_TESTS);
      const baseSpec = corpusBase.specifier;
      const corpusConfig = baseSpec || corpusBase.standalone
        ? corpusVitestConfig(baseSpec, relative(REPO_ROOT, EMIT_TESTS).split(sep).join("/"))
        : null;
      if (corpusConfig) writeFileSync(join(STAGE, "vitest.config.mts"), corpusConfig);

      // THE LANDING. Everything below this line is renames and deletions - no
      // rendering, nothing that can fail on the shape of a row - so the target
      // goes from one complete suite to the other with no work in between. The
      // manifest is moved LAST, after the files it describes, and the orphans go
      // only once the new suite is in place: a kill in here leaves an extra file
      // that the next emit removes, never a suite that is not there.
      // A SPEC THE REMOTE WILL NOT TAKE, said before it lands (D57). One spec
      // file is one source file's rows, and qode-ptp-ms's aiInterviewService
      // spec is 27 MB; a spec over 100 MiB would fail the delivery exactly as
      // recorded.json did. Named here; finish.py refuses the push by name.
      const bigSpecs = staged
        .map((name) => [name, statSync(join(STAGE, name)).size])
        .filter(([, size]) => size > SPEC_WARN_BYTES)
        .map(([name, size]) => `${name} (${(size / 1048576).toFixed(1)} MiB)`);
      for (const name of staged) renameSync(join(STAGE, name), join(EMIT_TESTS, name));
      landRecorded(STAGE, EMIT_TESTS, recordedFiles);
      if (recordedEnv) renameSync(join(STAGE, "recorded.env"), join(EMIT_TESTS, "recorded.env"));
      if (corpusConfig) renameSync(join(STAGE, "vitest.config.mts"), join(EMIT_TESTS, "vitest.config.mts"));
      renameSync(join(STAGE, "emitted.json"), join(EMIT_TESTS, "emitted.json"));
      for (const f of plan.orphans) rmSync(join(EMIT_TESTS, f), { force: true });
      // After the landing, so the file never says a row is released while the
      // suite on disk still skips it: coverage.mjs reads this list as "why the
      // side was not measured", and only the suite just landed runs the row.
      if (released.length) writeFileSync(qPath, `${JSON.stringify({ ...qDoc, rows: kept }, null, 2)}\n`);

      process.stdout.write(
        `· stage 5: ${emitted} test(s) in ${byFile.size} file(s) → ${relative(REPO_ROOT, EMIT_TESTS)}\n` +
          `  ${withOutcome.length} of ${wanted.length} runnable rows had a recorded outcome to assert\n` +
          (unverified ? `  ${unverified} carry an UNVERIFIED claim, marked in the file\n` : "") +
          (plan.orphans.length ? `  ${plan.orphans.length} orphan(s) removed - ours, but no row asserts them any more\n` : "") +
          (plan.foreign.length
            ? `  ${plan.foreign.length} file(s) LEFT ALONE - not written by this tool: ${plan.foreign.join(", ")}\n`
            : "") +
          (bigSpecs.length
            ? `  ${bigSpecs.length} spec file(s) OVER ${SPEC_WARN_BYTES / 1048576} MiB - GitHub warns at 50 MiB and REFUSES the push at 100 MiB (GH001)${bound ? "" : " - CHARPILOT_SPEC_SPLIT=off, so nothing split it"}: ${bigSpecs.join(", ")}\n`
            : "") +
          (unresolved.length
            ? `  ${unresolved.length} specifier(s) THIS TARGET CANNOT RESOLVE - every row importing one will fail as a harness error: ${unresolved.join(", ")}\n`
            : "") +
          `  manifest → ${relative(REPO_ROOT, join(EMIT_TESTS, "emitted.json"))}\n` +
          `  recorded.json → ${recorded.rows.length} row(s) keyed by stableId` +
          (recordedFiles.size > 1 ? ` in ${recordedFiles.size - 1} shard(s) under recorded/ (one file would be over ${SHARD_BYTES / 1048576} MiB)` : "") +
          `, recorded against ` +
          `${recorded.recordedAgainst.gitSha?.slice(0, 7) ?? "an unknown commit"}` +
          `${recorded.recordedAgainst.gitDirty ? " (DIRTY - no sha names this tree)" : ""}` +
          ` - a later run can diff that commit against HEAD and reuse what did not change\n` +
          (recordedEnv
            ? `  recorded.env → ${envNames(recordedEnv).length} var name(s) - credentials and addresses inert, configuration as recorded\n`
            : `  NO recorded.env - the recording named no env file, so the suite runs under whatever CI holds\n`) +
          (corpusConfig
            ? baseSpec
              ? `  vitest.config.mts → beside the suite, extending ${baseSpec} - the corpus runs without anything under .claude/\n`
              : `  vitest.config.mts → beside the suite, STANDALONE - ${corpusBase.root} is the bootstrapped one, which a branch may not carry\n`
            : `  NO vitest.config.mts - no root vitest config found to extend, so the corpus carries no runner of its own\n`) +
          `  reproduce: ${manifest.reproduce}\n`
      );
    } finally {
      // The staging directory never outlives the emit, whether it landed or
      // threw. It is removed by name rather than by pattern: another emit
      // running beside this one has its own RUN_ID, and a sweep by prefix would
      // delete the suite it is in the middle of rendering.
      rmSync(STAGE, { recursive: true, force: true });
    }
    return;
  }

  if (EMIT_SPECS) {
    mkdirSync(EMIT_SPECS, { recursive: true });
    // Same rule as --emit-tests. These chunks are throwaway measurement specs,
    // but the directory is still not this tool's to clear: only `chunk-NNN`
    // files it writes itself are removable.
    for (const f of readdirSync(EMIT_SPECS)) {
      if (/^chunk-\d+\.test\.ts$/.test(f)) rmSync(join(EMIT_SPECS, f), { force: true });
    }
    {
      const foreign = readdirSync(EMIT_SPECS).filter((f) => f.endsWith(".test.ts"));
      if (foreign.length) {
        process.stdout.write(`  ${foreign.length} file(s) in ${relative(REPO_ROOT, EMIT_SPECS)} LEFT ALONE - not chunk specs: ${foreign.slice(0, 5).join(", ")}\n`);
      }
    }
    // `todo` means "not yet recorded" - the wrong set here. Measurement wants
    // every runnable row, cached or not, or a fully-recorded run would emit
    // nothing and stage 5 would report 0% while everything was fine.
    const emitChunks = [];
    for (let i = 0; i < wanted.length; i += CHUNK) emitChunks.push(wanted.slice(i, i + CHUNK));
    for (const [i, chunk] of emitChunks.entries()) {
      chunk.forEach((r, j) => { r.shape = callExpression(r.entry, j, r.ctorArgs) ?? r.shape; });
      writeSpec(chunk, join(EMIT_SPECS, `chunk-${String(i + 1).padStart(3, "0")}.test.ts`));
    }
    process.stdout.write(
      `· emitted ${emitChunks.length} spec(s) for ${wanted.length} row(s) → ${relative(REPO_ROOT, EMIT_SPECS)}\n` +
        "  these are for MEASUREMENT under istanbul; they write no behaviour.json\n"
    );
    return;
  }

  let failedChunks = 0;
  const branchSkeleton = {};
  // ITEM 18: SLOTS.length chunks at a time (see walkShards). A slot takes the
  // next chunk when its last one is folded in; a chunk split or cut short is
  // appended to `chunks`, and whichever slot is free takes it.
  // No more slots than chunks: `auto` on a walk of two chunks is two.
  const slots = SLOTS.slice(0, Math.max(1, Math.min(SLOTS.length, chunks.length)));
  if (slots.length > 1) process.stdout.write(`· ${slots.length} chunks at a time (CHARPILOT_WALK_SHARDS)\n`);
  let nextChunk = 0;
  const foldChunk = async (i, chunk, slot) => {
    // Re-index the call variables so each chunk's spec is self-consistent:
    // every row declares `const m<n> = await import(...)` in the same function
    // body, so <n> has to be unique WITHIN THE CHUNK, not within the whole run.
    chunk.forEach((r, j) => { r.shape = callExpression(r.entry, j, r.ctorArgs) ?? r.shape; });
    const { rows: got, branchMap, status, log, wedged, timedOut } = await runChunk(chunk, env, slot);
    let rows = got;
    if (wedged) {
      // The row that never yielded is skipped by name; the rows it held up
      // run again in a chunk of their own, appended so it is still counted.
      const at = chunk.findIndex((r) => r.id === wedged);
      const w = chunk[at];
      delete cache.rows[w.id];
      skipped.push({ id: w.id, file: w.file ?? w.proposal?._file, reason: WEDGED_REASON() });
      const behind = chunk.slice(at + 1).filter((r) => !(rows ?? []).some((o) => o?.id === r.id));
      if (behind.length) chunks.push(behind);
      process.stdout.write(`  ✗ chunk ${i + 1}/${chunks.length}: ${w.id} ran past ${ROW_TIMEOUT_MS + ROW_GRACE_MS}ms without yielding - stopped, ${behind.length} row(s) behind it run again\n`);
      rows = rows ?? [];
    }
    if (!rows) {
      // FIX PLAN 1, RULE 2: A CHUNK VITEST COULD NOT START FAILS ITS OWN ROWS,
      // BY NAME. It set exitCode 1 for the run ("a stalled recorder is a STOP"),
      // which ended the walk over a tool failure. Now each of the chunk's rows
      // is a skip quoting vitest's own first error lines, the other chunks'
      // rows are kept, and the recording is written. Nothing is cached for
      // these rows, so the next recording runs them again.
      //
      // AND A CHUNK OF MANY ROWS IS SPLIT BEFORE ANY OF THEM IS SKIPPED (D44).
      // One row whose code does not parse fails the whole spec file, so every
      // row in the chunk was skipped for it: sourcing-ms (2026-09-26) lost 16
      // rows to one bad `build`, all under one reason quoting a code frame. The
      // halves run again, appended as the wedged path does, until the rows
      // that fail are in chunks of their own: the others record, and each row
      // skipped here carries its own vitest error. A chunk stopped by its time
      // limit is not split: halving it would only spend that time again.
      const why = chunkErrorLines(log, status, timedOut);
      if (chunk.length > 1 && !timedOut) {
        const half = Math.ceil(chunk.length / 2);
        chunks.push(chunk.slice(0, half), chunk.slice(half));
        process.stdout.write(
          `  ✗ chunk ${i + 1}/${chunks.length} produced no rows (exit ${status}) - ${why}\n` +
            `    its ${chunk.length} row(s) run again in two chunks, so the row(s) it fails on are found and the rest are recorded\n`
        );
        return;
      }
      failedChunks += 1;
      process.stdout.write(`  ✗ chunk ${i + 1}/${chunks.length} produced no rows (exit ${status})\n${log}\n`);
      const own = chunk.length === 1 ? "this row, in a chunk of its own: " : "";
      for (const r of chunk) {
        delete cache.rows[r.id];
        skipped.push({ id: r.id, file: r.file ?? r.proposal?._file, reason: `pipeline defect: the recorder's vitest chunk produced no rows - ${own}${why}` });
      }
      writeDoc(proposals, runnable, skipped, cache);
      return;
    }
    // Accumulated across chunks, not reset: the branch map is a property of
    // the SOURCE, so a file's entry is the same whichever chunk loaded it, and
    // a later chunk that loads fewer files must not narrow what an earlier
    // one could map.
    if (branchMap) Object.assign(branchSkeleton, branchMap);
    annotateClaims(rows, scan, branchSkeleton);
    // WHAT THE ROW WAS RECORDED BY AND AGAINST, beside what from (item 6b):
    // `__recordedBy` the toolset (the cigate path asks it), `__recording` this
    // process (a determinism verdict stamped on the artifact is carried back
    // onto the same recording, writeDoc), `__sources` the repo's code
    // (sourcedeps.mjs). Stamped as the row lands, off the tree it ran against.
    const inChunk = new Map(chunk.map((r) => [r.id, r]));
    let kept = 0;
    for (const row of rows) {
      cache.rows[row.id] = {
        ...row,
        __fingerprint: fingerprints.get(row.id) ?? null,
        // D54: the Node major the row was observed under (cinode.mjs).
        __recordedNode: RECORDED_NODE_MAJOR,
        ...(INCREMENTAL_RECORD ? { __recordedBy: HARNESS, __recording: RUN_ID } : {}),
        ...(INCREMENTAL_RECORD && graph ? { __sources: stampOf(graph, inChunk.get(row.id) ?? row, row) } : {}),
      };
      REUSE.recorded.add(row.id);
      // D67: failed on the environment, over an observation of this input
      // that arranged - that one stays, and says what it is standing in for.
      const cause = earlier.has(row.id) ? environmentCause(row, REPO_ROOT) : null;
      if (cause) {
        cache.rows[row.id] = {
          ...earlier.get(row.id),
          __environment: { cause: cause.key, failedWith: String(row.harnessError.message ?? "").split("\n")[0].slice(0, 300) },
        };
        REUSE.recorded.delete(row.id);
        kept += 1;
      }
    }
    writeFileSync(CACHE_FOR(cache.recordingKey), `${JSON.stringify(cache, null, 2)}\n`);
    writeDoc(proposals, runnable, skipped, cache);
    const bad = rows.filter((r) => r.harnessError).length;
    process.stdout.write(
      `  ✓ chunk ${i + 1}/${chunks.length}  ${rows.length} rows${bad ? `  (${bad} harness failure(s)` : ""}` +
        `${bad && kept ? `, ${kept} on the environment over an earlier observation, which is kept` : ""}${bad ? ")" : ""}\n`
    );
  };
  // A slot that finds the queue empty stops; a split pushed after that is
  // taken by the slot that pushed it, which loops again.
  await Promise.all(slots.map(async (slot) => {
    while (nextChunk < chunks.length) {
      const i = nextChunk++;
      await foldChunk(i, chunks[i], slot);
    }
  }));

  if (LIVE) await revertJournal();

  // THE LAST WRITE, and it says so (steps/record.mjs pendingRows): every write
  // before it is a chunk's, and a walk stopped between two of them leaves rows
  // "not yet run" that the next walk has to record.
  REUSE.complete = true;
  const doc = writeDoc(proposals, runnable, skipped, cache);
  const t = doc.totals;
  process.stdout.write(
    `\n✓ behaviour recorded → ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    recorded          ${t.recorded}\n` +
      `    harness failures  ${t.harnessFailures}   ${t.harnessFailures ? "← NOT recorded as behaviour; fix the harness" : ""}\n` +
      `    blocked egress    ${t.blockedEgress}   ${t.blockedEgress ? "← the guard held; the reasons below name the endpoint and why nothing answered it" : ""}\n` +
      `    did not settle    ${t.notSettled}   (measured against --row-timeout ${t.rowTimeoutMs}ms)` +
      `${t.notSettledBeforeSubject ? `\n                      ← ${t.notSettledBeforeSubject} of them never entered the subject call: the ARRANGEMENT spent the whole budget. Raise --row-timeout before repairing any input.` : ""}\n` +
      `    pending           ${t.pending}   ${t.pending ? "← run did not finish; rerun to resume" : ""}\n` +
      `    need a harness    ${t.unrunnable}   (a written reason, not a gap)\n` +
      `    claims            ${t.claimsVerified} verified, ${t.claimsFalse} FALSE at record time` +
      `${t.claimsUnmeasurable ? `, ${t.claimsUnmeasurable} unmeasurable` : ""}\n`
  );
  if (doc.environment?.defect) {
    // D67. Not a non-zero exit: the recording is complete and says what it is.
    // steps/record.mjs names this as the run's defect, and the emit refuses to
    // shrink the delivered suite on it until the environment is set up.
    process.stdout.write(`\n✗ ${doc.environment.defect}\n`);
  }
  if (t.claimsFalse) {
    // Deliberately not a non-zero exit and deliberately not a dropped row. The
    // pair is a real observation; what is wrong is the ARM it is filed under,
    // and that is a stage-3 input to repair. Stage 6 still fails on these -
    // this is the same finding, ~30 minutes earlier.
    process.stdout.write(
      `\n  a FALSE claim means the row froze a DIFFERENT arm under this label - repair the stage-3 input:\n`
    );
    for (const f of (doc.falseClaimsAtRecordTime ?? []).slice(0, 15)) {
      process.stdout.write(`      ${f.id}\n        claims ${f.armId} side "${f.side}" — that side never incremented\n`);
    }
    const more = (doc.falseClaimsAtRecordTime ?? []).length - 15;
    if (more > 0) process.stdout.write(`      … +${more} more in ${relative(REPO_ROOT, OUTPUT)}\n`);
  }
  reportSkips(doc.skipped);
  reportDroppedAnswers();
  // This run's scratch files, and only this run's. They are per-process now, so
  // leaving them behind would litter a shared out/ with one pair per recording.
  // On a throw they deliberately survive, because then they are the evidence.
  if (KEEP_SPEC) {
    process.stdout.write(`\n  --keep-spec: ${relative(REPO_ROOT, SPEC)}  (loaded via ${relative(REPO_ROOT, SPEC_STUB)})\n`);
  } else {
    for (const slot of SLOTS) {
      rmSync(slot.result, { force: true });
      rmSync(slot.branchmap, { force: true });
    }
  }
  if (failedChunks) {
    process.stdout.write(
      `\n  ${failedChunks} chunk(s) produced nothing - their rows are skipped as a pipeline defect with vitest's own error, ` +
        `and the next recording runs them again. The rows of every other chunk are recorded.\n`
    );
  }
}

/**
 * The first lines of what vitest said when a chunk produced no rows, on one
 * line. Its log leads with blank lines and ANSI colour, and a bare
 * `split("\n")[0]` is the empty string (D59), so the first lines that say
 * something are taken, from the first one naming an error if there is one.
 */
function chunkErrorLines(log, status, timedOutMs = null) {
  // A chunk the recorder STOPPED says so first: what vitest printed before it
  // was killed is not why it produced nothing.
  const stopped = timedOutMs ? `the chunk ran past its ${Math.round(timedOutMs / 1000)}s limit and was stopped` : "";
  const lines = String(log ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[⎯─-]+$/.test(l) && !/^[⎯─]+ .* [⎯─]+$/.test(l))
    // A code-frame line is the SOURCE, not the error: `4050 │ const first = …`,
    // and the `│ ┬` / `│ ╰──` markers under it. It still leads with a
    // location, which the `╭─[ file:line:col ]` line above it carries.
    .filter((l) => !/^(\d+\s*)?│/.test(l));
  const at = lines.findIndex((l) => /error|cannot|failed|not found|ERR_/i.test(l));
  const picked = (at === -1 ? lines : lines.slice(at)).slice(0, 3).map((l) => l.slice(0, 200)).join(" | ");
  const said = picked || (stopped ? "" : `vitest exited ${status ?? "on a signal"} and printed nothing`);
  return [stopped, said].filter(Boolean).join(" - ").slice(0, 400);
}

/**
 * WHAT WENT WRONG, IN ONE LINE THAT IS NEVER EMPTY — D59.
 *
 * The revert's problem list was built with `err.message.split("\n")[0]`, and a
 * Prisma error message BEGINS WITH A NEWLINE, so element 0 was the empty string
 * and every problem printed as
 *
 *     Model.op:
 *
 * with nothing after it, under `REVERT INCOMPLETE - staging may be altered`.
 * That banner is the one report in this toolset whose whole job is to say what
 * was left behind in a REAL staging database, and it said nothing at all.
 *
 * IT IS THE SAME DEFECT THAT COST FOUR DAYS ON providervocab.mjs (D50), so it
 * is fixed with that tool's rule and not with a second one: `failureLine` keeps
 * the first non-blank line, and keeps following it while a kept line ends in a
 * colon - because a line ending in `:` is a promise of the next one - capped at
 * three and joined with " · " so the result is still one line. Prisma's shape
 * is a header, two blank lines, then the whole reason on one line, and BOTH
 * arms of this path were measured rather than assumed:
 *
 *   $queryRawUnsafe   docker/runs/20260918T073111Z/stages/db-vocabulary.json
 *                     "\nInvalid `prisma.$queryRawUnsafe()` invocation:\n\n\n
 *                      Raw query failed. Code: `22023`. Message: `ERROR: …`"
 *   a MODEL call,     @prisma/client from repos/ai-centralization, 2026-09-19
 *   which is what     "\nInvalid `prisma.usageLog.deleteMany()` invocation:\n\n\n
 *   this function      Can't reach database server at `127.0.0.1:1`\n\n
 *   makes              Please make sure your database server is running…"
 *
 * Note the second carries no `db error:` and no `ERROR: ` prefix while the
 * first does: the prefix is the engine path's, not Prisma's, and a fix that
 * matched on either one would work on one of these two and not the other.
 *
 * Each problem still gets ONE line because this stderr goes through
 * steps/preflight.mjs `tail`, which splices the LAST FOUR non-blank lines into
 * the step's status - a multi-line Prisma block here would push every other
 * problem out of the log window.
 */
export function problemLine(err) {
  // `failureLine`'s own last resort names providervocab.mjs, which would be a
  // FALSE sentence in this report. It is reached only when the thrown value has
  // nothing printable and no name, so that one case is answered here and
  // everything else is providervocab's line, unchanged.
  const text = String(err?.message ?? err ?? "");
  const named = err && typeof err === "object" && typeof err.name === "string" && err.name;
  if (text.trim() !== "" || named) return failureLine(err);
  return `the revert threw a value with no message (${typeof err})`;
}

/**
 * Undo every journalled mutation, newest first.
 *
 * Writes against staging are allowed because they are reversible, and this is
 * the half that makes that true. Replay is in REVERSE order so a create that
 * depended on an update is removed before the update is rolled back.
 *
 * The revert is then VERIFIED, not assumed: each restored row is read back and
 * compared. An unverified revert is the same failure as an unverified claim -
 * it reads as done. If anything cannot be confirmed the run exits non-zero with
 * the journal left in place, because a half-reverted shared database is worse
 * than a failed run and a person has to look.
 */
async function revertJournal() {
  if (!existsSync(JOURNAL)) return;
  const entries = JSON.parse(readFileSync(JOURNAL, "utf8"));
  if (!entries.length) return;

  const url = buildEnv().DATABASE_URL;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const problems = [];
  let undone = 0;
  try {
    for (const e of [...entries].reverse()) {
      const model = prisma[e.model];
      if (!model) { problems.push(`${e.model}: not on the client`); continue; }
      try {
        if (e.created?.length) {
          await model.deleteMany({ where: { id: { in: e.created } } });
          const left = await model.count({ where: { id: { in: e.created } } });
          if (left) problems.push(`${e.model}: ${left} created row(s) still present`);
          else undone += 1;
        } else if (Array.isArray(e.before)) {
          for (const row of e.before) {
            if (!row?.id) { problems.push(`${e.model}.${e.op}: a before-row had no id, cannot restore it`); continue; }
            const { id, ...rest } = row;
            await model.upsert({ where: { id }, update: rest, create: row });
          }
          undone += 1;
        }
      } catch (err) {
        problems.push(`${e.model}.${e.op}: ${problemLine(err)}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  if (problems.length) {
    process.stderr.write(
      `\n✗ REVERT INCOMPLETE - staging may be altered. The journal is kept at ` +
        `${relative(REPO_ROOT, JOURNAL)} so it can be finished by hand:\n` +
        problems.slice(0, 8).map((x) => `    ${x}`).join("\n") + "\n"
    );
    process.exit(1);
  }
  rmSync(JOURNAL, { force: true });
  process.stdout.write(`· reverted ${undone} journalled mutation(s); staging restored and verified\n`);
}

/**
 * Turn a row's raw counter movement into arm ids, and verdict its own claims.
 *
 * This is the whole point of instrumenting the record pass. A proposal's
 * `reaches` is a SENTENCE it wrote about itself, and until now the only thing
 * that checked it was stage 6 - a full record -> generate -> measure cycle
 * downstream. Measured on the run before this existed: 406 claims checked, 303
 * verified, 103 FALSE, every one of them discoverable at record time.
 *
 * The branch -> arm mapping is armjoin.mjs's, not a second copy: the recorder
 * hands over the branch map its worker saw and gets back the same index stage 6
 * joins against. A second mapping here would be a second thing to keep true,
 * and the interesting failure - a claim that reads as checked and is not - is
 * exactly what that produces.
 *
 * Three verdicts, because they have three different fixes:
 *   verified      the side incremented during this row's own subject call
 *   false         it did not - a STAGE-3 defect to repair. The row is kept: the
 *                 observation is real, its LABEL is wrong, and dropping it
 *                 would hide that.
 *   unmeasurable  nothing could be asked - the arm is not in the scan, istanbul
 *                 does not instrument that kind, the side label is not a side
 *                 of that arm, or the join found no branch for it.
 */
function annotateClaims(rows, scan, skeleton) {
  // The worklist is passed so statement units are in the index too - see the
  // note in armIndexFromScan. Absent is fine: it only means those claims keep
  // the older, less accurate message.
  let worklistItems = null;
  try {
    worklistItems = JSON.parse(readFileSync(WORKLIST_JSON, "utf8")).items ?? null;
  } catch {
    worklistItems = null;
  }
  const staticArms = armIndexFromScan(scan, worklistItems);
  const files = new Set(Object.keys(skeleton ?? {}));
  const joined = files.size ? measureArms(scan, hitIndexFromSkeleton(skeleton)) : new Map();

  const byBranch = new Map();
  for (const a of joined.values()) {
    if (a.known && a.branchId != null) byBranch.set(`${a.file}|${a.branchId}`, a);
  }

  /** Raw { file: { branchId: [sideIdx] } } -> [{ armId, file, line, sides }]. */
  const toArms = (moved) => {
    const arms = [];
    const sideKeys = new Set();
    for (const [file, branches] of Object.entries(moved ?? {})) {
      for (const [branchId, sides] of Object.entries(branches)) {
        const a = byBranch.get(`${file}|${branchId}`);
        // A branch istanbul instrumented that no AST arm claims - a file
        // outside the scan's set. Not a defect and not a claim; just not ours.
        if (!a) continue;
        const labels = sides.map((i) => a.labels[i] ?? `arm${i}`);
        arms.push({ armId: a.armId, file: a.file, line: a.line, sides: labels });
        for (const l of labels) sideKeys.add(`${a.armId}|${l}`);
      }
    }
    arms.sort((x, y) => (x.armId < y.armId ? -1 : x.armId > y.armId ? 1 : 0));
    return { arms, sideKeys };
  };

  for (const row of rows) {
    const moved = row.movedBranches ?? null;
    const { arms: armsMoved, sideKeys: movedSides } = toArms(moved);
    // The other window: what the row's arrangement moved before the subject
    // ran. Not a verdict - the explanation for one.
    const { sideKeys: arrangementSides } = toArms(row.movedBranchesBeforeSubject);
    row.armsMoved = armsMoved;

    const verdicts = [];
    for (const [armId, value] of Object.entries(row.reaches ?? {})) {
      const arm = staticArms.get(armId);
      for (const side of claimedSides(value, arm?.labels)) {
        let verdict = "unmeasurable";
        let why = null;
        if (!row.invoked) {
          // An ARRANGEMENT failure is the case worth naming separately: the
          // claim is not merely unjudged, it could not have been judged, and
          // the repair is to the harness rather than to the input.
          why =
            row.harnessError?.phase === "arrangement"
              ? "the row's ARRANGEMENT threw before the subject call ran, so nothing of the subject was measured - a harness failure to fix, not a claim to repair"
              : "the row was not recorded as behaviour, so nothing ran to measure";
        }
        else if (!moved) why = "no istanbul counters in this run - is coverage enabled in vitest.record.config.mts?";
        else if (!arm) why = "arm not found in scan";
        // ONE producer for this sentence, shared with stage 6. It used to read
        // "<kind> is not instrumented by istanbul", which is not true of an
        // entry or a statement - istanbul counts both, in `f` and `s`, just not
        // in the branch map a side claim is verdicted against. Two stages
        // describing one limit in two ways is a second thing to keep true.
        else if (!arm.istanbul) why = nonBranchReason(arm.kind);
        else if (sideIndexOf(arm.labels, side) === -1) why = `"${side}" is not a side of this arm (${arm.labels.join(", ")})`;
        // The arm's file WAS loaded and instrumented, and the join still found
        // no branch for it. That is a join failure, not an input failure, and
        // calling it FALSE would blame the proposal for the tool.
        else if (files.has(arm.file) && joined.get(armId)?.known === false) why = joined.get(armId)?.reason ?? "no matching istanbul branch";
        else verdict = movedSides.has(`${armId}|${side}`) ? "verified" : "false";
        // A false claim whose side DID move, but before the subject call, is a
        // different repair from one that never ran at all: the arm is reached
        // by importing the module (a module-scope singleton's constructor) or
        // by the row's own precondition, so the driver named in `via` is not
        // the thing that reaches it. Stage 6 cannot tell these apart - it
        // measures the whole file - and it is the difference between "the
        // input is wrong" and "the entry point is wrong".
        if (verdict === "false" && arrangementSides.has(`${armId}|${side}`)) {
          why = "the side moved during this row's own imports/preconditions, not during the subject call - the arm is reached by the arrangement, so `via` names the wrong entry";
        } else if (verdict === "false" && row.subjectCallStarted === false) {
          why = "the row threw before its subject call ran (the entry did not resolve, or an import threw), so the subject moved nothing at all";
        }
        verdicts.push(why ? { armId, side, verdict, why } : { armId, side, verdict });
      }
    }
    row.claimVerdicts = verdicts;
  }
  return rows;
}

/** The claim tallies over whatever rows are in the artifact. */
function claimTotals(rows) {
  const verified = [];
  const wrong = [];
  const unmeasurable = [];
  for (const r of rows) {
    for (const v of r.claimVerdicts ?? []) {
      const entry = { id: r.id, armId: v.armId, side: v.side, ...(v.why ? { why: v.why } : {}) };
      if (v.verdict === "verified") verified.push(entry);
      else if (v.verdict === "false") wrong.push(entry);
      else unmeasurable.push(entry);
    }
  }
  return { verified, wrong, unmeasurable };
}


/**
 * Refuse to shrink an artifact.
 *
 * The output path comes from the FLAGS, never from what the run recorded, so
 * two runs of different breadth claim the same filename and the later one wins
 * by being later. `--live --only x` once resolved to `behaviour-live.json` and
 * a single-row run replaced a 233-row live capture - a capture that cost real
 * staging calls to make. The precedence fix moved that specific collision; it
 * did not remove the shape. `behaviour-partial.json` holds 301 rows today, and
 * any later `--only` writes to that same path.
 *
 * So compare the row-id SETS, not the counts: this run may replace what it can
 * account for, and must refuse what it cannot. `--overwrite` is the deliberate
 * escape hatch, and it prints what it is discarding.
 *
 * "WHAT IT CAN ACCOUNT FOR" IS ASKED OF THIS RUN, not assumed. `observed`
 * carries the two things only the caller knows - the ids this run READ, and
 * `classify`'s written refusal for each one it would not run - and the block at
 * the tail sorts the lost rows on them. `null` when nothing is lost,
 * `{ superseded, forced: false }` when every lost row has a sentence to replace
 * it with, `{ lost, forced: true }` under `--overwrite`, and a throw otherwise.
 */
function guardOutput(willWriteIds, observed = {}) {
  if (!existsSync(OUTPUT)) return null;
  let prior;
  try {
    prior = JSON.parse(readFileSync(OUTPUT, "utf8"));
  } catch {
    return null; // unreadable is not a capture worth protecting
  }
  const had = new Set((prior.rows ?? []).map((r) => r.id));
  if (had.size === 0) return null;

  // The row-id sets can match exactly and the artifact still be replaced by
  // something incomparable, because a row is a function of the ENVIRONMENT as
  // much as of the input. Measured: re-running this repo's full set without
  // `--env-file` recorded 333 rows instead of 365 - the 32 missing ones were
  // every error path that fires a Slack alert, which reached a default-deny
  // endpoint once the env no longer disabled it. Nothing in this guard looked
  // at that, because it only ever counted rows.
  //
  // An env change is a legitimate reason to re-record, so this stops and says
  // which env, rather than banning it.
  const where0 = relative(REPO_ROOT, OUTPUT);
  // A foreign artifact is never something to merge or overwrite quietly - it
  // means a path is wrong, and the rows in it belong to someone else.
  if (prior.target && prior.target !== basename(TARGET_ROOT)) {
    throw new Error(
      `refusing to touch ${where0}: it was recorded for "${prior.target}" and this target is "${basename(TARGET_ROOT)}".\n` +
        `  That is a wrong path, not a stale artifact - the rows in it describe a different repo.\n` +
        `  Check CHARPILOT_TARGET_ROOT and CHARPILOT_OUTPUT before re-running; --overwrite will NOT bypass this.`
    );
  }
  const refuse = (what, detail, how) => {
    const msg = `${where0} was recorded ${what}`;
    if (!OVERWRITE) {
      throw new Error(`refusing to overwrite ${msg}\n${detail}\n  ${how}\n  Or send this run elsewhere with CHARPILOT_OUTPUT=<path>.`);
    }
    process.stdout.write(`! --overwrite: ${msg}\n`);
  };

  const priorEnv = prior.envProvenance;
  const thisEnv = envProvenance();
  // AN ENVIRONMENT THAT BECAME RESOLVED IS NOT A COLLISION.
  //
  // This guard protects a capture that cost something from being replaced by a
  // capture made under different conditions, and that is right in every
  // direction but one. `defaultEnvFile()` picks up `out/staging.env` AS SOON AS
  // STAGE 1 WRITES IT, so a run that recorded round 1 against the ambient
  // process env and then resolved staging arrives here with a different
  // provenance through no decision of anyone's — and the walk spawns this tool
  // WITH NO ARGUMENTS, deliberately, so it can never answer with `--overwrite`.
  // The step refuses, the next round refuses identically, and the run is
  // wedged. Reproduced on notification-ms on 2026-09-18: the local run only got
  // past it because the flag was typed by hand.
  //
  // Rows recorded before the environment resolved are strictly the weaker
  // evidence — that is the whole reason stage 1 resolves it — so replacing them
  // with rows recorded after is the improvement this pipeline exists to make,
  // not a loss to guard against. It is announced, because a reader of the
  // artifact has to know its rows changed provenance.
  //
  // The other direction stays refused. Going from a resolved env back to the
  // ambient one WOULD replace better evidence with worse, and nothing about
  // that is accidental.
  const becameResolved = priorEnv === "process-env-only" && thisEnv !== "process-env-only";
  if (becameResolved && !OVERWRITE) {
    process.stdout.write(
      `! re-recording ${where0}: it was recorded before the environment resolved ` +
        `(process env only), and this run has ${relative(REPO_ROOT, ENV_FILE)}. ` +
        `Rows recorded against an unresolved environment are the weaker evidence.\n`
    );
  } else if (priorEnv && priorEnv !== thisEnv) {
    refuse(
      `under env ${priorEnv}, and this run is env ${thisEnv}` + (prior.envFile ? ` (that file: ${prior.envFile})` : ""),
      ENV_FILE ? `  this run: --env-file ${relative(REPO_ROOT, ENV_FILE)}` : "  this run: no --env-file, process env only",
      "A recorded value is only as real as the environment that produced it, so rows from two envs must not share a file. Pass the same --env-file, or --overwrite to re-record under the new one."
    );
  }

  // The policy decides WHICH BOUNDARIES ARE ANSWERED AT ALL, so it changes what
  // a row is even more than the env does. Measured, and the reason this check
  // exists: re-running this repo's full set under the default `as-declared`
  // recorded 333 rows where the authoritative artifact holds 365. The 32
  // missing ones were every path that fires a Slack alert - under `right-level`
  // the recorder injects the axios answer for every row, and under
  // `as-declared` it does not, so the un-awaited POST reaches a default-deny
  // host and the row is refused. Both numbers are correct for their policy, and
  // nothing said so.
  const priorPolicy = prior.selection?.policy;
  if (priorPolicy && priorPolicy !== POLICY) {
    refuse(
      `under --policy ${priorPolicy}, and this run is --policy ${POLICY}`,
      "  The policy decides which boundaries are answered, so the two runs observe different programs.",
      `Pass --policy ${priorPolicy}, or --overwrite to re-record under ${POLICY}.`
    );
  }
  const willWrite = new Set(willWriteIds);
  const lost = [...had].filter((id) => !willWrite.has(id));
  if (lost.length === 0) return null;

  if (OVERWRITE) {
    process.stdout.write(
      `! --overwrite: ${where0} holds ${had.size} row(s); this run writes ${willWrite.size} and DISCARDS ${lost.length}\n` +
        `  discarding: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? `, … ${lost.length - 5} more` : ""}\n`
    );
    return { lost, forced: true };
  }

  /* ------------------------------------------------------------------------
   * "THIS RUN NEVER LOOKED AT IT" IS NOT THE SAME LOSS AS "THIS RUN LOOKED AT
   * IT AND WROTE DOWN WHY THERE IS NO ROW", AND ONLY THE FIRST IS A SHRINK.
   *
   * THE DEFECT, and it ended two runs on two repos. On location-ms
   * `20260919T171842Z` the yield ratchet had already stopped the asking in
   * round 6 - a deliberate ending, with `repair`, `ruling` and `report` still
   * ahead of it - and then this throw turned it into `status: partial` and a
   * failure exit over ONE row, `arg0-of-run-21-if-0`, whose proposal the round
   * had just moved to a file that was refused, so no proposal on disk carried
   * that id any more. On tracy-worker `20260919T092410Z` it ended round 5 over
   * eight rows (`pauseSourcingPipeline-36-if-0` and seven siblings) whose
   * repair added `setup.apply.db`, which `classify` refuses in a mocked run -
   * "setup needs db - a write to staging, which only --live journals and
   * reverts", one of this file's own refusals and a correct one. Both runs
   * banked their coverage and reported themselves failed.
   *
   * WHAT THE GUARD IS FOR, unchanged: the output path comes from the FLAGS, so
   * a NARROW run lands on a BROAD run's file and wins by being later. That is a
   * run that never observed the rows it is about to delete. A row dropped
   * because this run RE-OBSERVED its proposal and refused it is the opposite
   * situation: the recorder read the same id, and its answer for it this time
   * is a written reason rather than a row. Keeping the old row instead would be
   * keeping an observation of a program that no longer exists - exactly what
   * `steps/record.mjs`'s `superseded` invalidates, which is why refusing here
   * WEDGES the walk: the step must re-record, the recorder refuses to
   * re-record, and the walk spawns this tool with no arguments on purpose so it
   * can never answer `--overwrite`. Same shape as the env deadlock repaired
   * above, one guard along.
   *
   * SO THE LOST ROWS ARE SORTED BY WHAT THIS RUN CAN SAY ABOUT THEM:
   *
   *   re-observed    the proposal is on disk and `classify` refused it, in its
   *                  own words. `doc.skipped` already carries that sentence,
   *                  coverage.mjs reads it through `refusedByRecorder`, and the
   *                  side stays in the denominator as D64's `undeliverable`.
   *   input-deleted  no proposal on disk carries the id at all. There is no
   *                  input left to re-record it from, so no re-run can ever
   *                  produce the row again and refusing forever is a wall. The
   *                  id is carried into `skipped` below with that sentence, so
   *                  the artifact still names it rather than losing it quietly.
   *   withheld       the proposal is on disk, it IS runnable, and this run
   *                  simply did not select it - i.e. `--only`. THIS IS THE
   *                  SHRINK, and it still refuses. `selectedOf` narrows only on
   *                  `ONLY`, so on a run with no `--only` this bucket is empty
   *                  by construction and the guard's original incident - one
   *                  `--only` row over a 233-row live capture - lands here
   *                  exactly as before.
   *
   * COVERAGE CANNOT RISE THROUGH THIS DOOR. Every row it lets go becomes a
   * `skipped` entry, never a row, so the emitted suite shrinks and the sides it
   * covered go back to uncovered with the recorder's reason attached. It can
   * only lower the number, and what it removes is a run that reported nothing
   * at all.
   * --------------------------------------------------------------------- */
  const refusedNow = observed.refused instanceof Map ? observed.refused : new Map();
  const seen = observed.seen instanceof Set ? observed.seen : null;
  const priorRow = new Map((prior.rows ?? []).map((r) => [r.id, r]));
  const superseded = [];
  const withheld = [];
  for (const id of lost) {
    const why = refusedNow.get(id);
    if (why) {
      superseded.push({ id, file: priorRow.get(id)?.file ?? null, evidence: "re-observed", why });
    } else if (seen && !seen.has(id)) {
      superseded.push({
        id,
        file: priorRow.get(id)?.file ?? null,
        evidence: "input-deleted",
        why:
          `recorded in a previous run and no proposal on disk carries this id any more, so this run could not ` +
          `re-observe it - the input it was recorded from has been deleted, renamed or refused at submission`,
      });
    } else {
      withheld.push(id);
    }
  }

  if (withheld.length) {
    throw new Error(
      `refusing to overwrite ${where0}: it holds ${had.size} recorded row(s), and this run would drop ${withheld.length} of them ` +
        `(${withheld.slice(0, 4).join(", ")}${withheld.length > 4 ? ", …" : ""}) WITHOUT HAVING OBSERVED THEM - ` +
        `their inputs are on disk and runnable, this run simply did not select them.\n` +
        `  The output path is chosen from the flags, not from what was recorded, so a narrow run lands on the same file as a broad one.\n` +
        `  Either widen the run, send it somewhere else with CHARPILOT_OUTPUT=<path>, or pass --overwrite if discarding those rows is what you mean.` +
        (prior.selection ? `\n  That file was recorded with: ${prior.selection.argv.join(" ") || "(no flags)"}` : "")
    );
  }

  // ANNOUNCED, never silent. A reader of the artifact has to know its rows
  // changed, and the reason is the recorder's own sentence rather than a
  // summary of one.
  process.stdout.write(
    `\n! re-recording ${where0}: ${superseded.length} row(s) it holds have no row in this run, and this run ` +
      `has a written reason for every one of them - they are carried into \`skipped\` rather than dropped:\n` +
      superseded.slice(0, 5).map((s) => `    ${s.id} (${s.evidence}): ${s.why}\n`).join("") +
      (superseded.length > 5 ? `    … ${superseded.length - 5} more\n` : "")
  );
  return { superseded, forced: false };
}

/**
 * The rows this run may write - `runnable` narrowed by `--only`.
 *
 * The SAME predicate `main()` uses to build `wanted`. It is a function because
 * two things need it and they disagreed: the doc's rows came from the narrowed
 * cache, and the overwrite guard's promise came from the broad `runnable`. See
 * writeDoc's tail.
 */
function selectedOf(runnable) {
  return runnable.filter((r) => (!ONLY || String(r.id ?? "").includes(ONLY)) && (!ONLY_IDS || ONLY_IDS.has(String(r.id ?? ""))));
}

/**
 * The ONE way OUTPUT is written.
 *
 * guardOutput is an INVARIANT, not a step in a sequence. It used to be a bare
 * call sitting next to a bare `writeFileSync(OUTPUT, ...)`, so any second write
 * added anywhere else in this file would be a second chance to truncate a
 * capture with nothing to notice it. There is one door now.
 */
function writeOutput(doc, willWriteIds, observed = {}) {
  doc.overwrite = guardOutput(willWriteIds, observed);
  // A SUPERSEDED ROW LEAVES `rows` AND LANDS IN `skipped`, NEVER NOWHERE. The
  // whole permission the guard now grants is "you may replace this row with a
  // written reason", so the written reason has to be IN the document - a row
  // that simply vanished would be the silent shrink the guard exists to refuse,
  // and `steps/record.mjs`'s `unaccounted` would then report the id as one this
  // recording never saw. The `re-observed` ones are already there, put there by
  // `writeDoc` from `classify`'s verdict; only the `input-deleted` ones are new,
  // and they are appended with the same `{ id, file, reason }` shape every other
  // reader of `skipped[]` expects.
  for (const s of doc.overwrite?.superseded ?? []) {
    if ((doc.skipped ?? []).some((x) => x?.id === s.id)) continue;
    (doc.skipped ??= []).push({ id: s.id, file: s.file, reason: s.why });
  }
  if (doc.totals) {
    doc.totals.notRecorded = (doc.skipped ?? []).length;
    // NAMED, because `notRecorded` moving with no line item is the kind of
    // number a reader has to diff two artifacts to explain.
    doc.totals.supersededRows = (doc.overwrite?.superseded ?? []).length;
  }
  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);

  // Recording clears the stage-3 clock, so the NEXT 3->4->5->6 iteration starts
  // with a fresh budget. Without this the teeth in worklist.mjs would refuse
  // the brief forever after the first overrun and the loop would stop turning -
  // a brake that cannot be released is not a brake, it is a wall.
  try {
    const clock = join(OUT_DIR, "stage3-clock.json");
    if (existsSync(clock)) rmSync(clock, { force: true });
  } catch { /* the clock is an optimisation, never a reason to fail a recording */ }
}

/**
 * WHY THIS ROW HIT THE DEFAULT-DENY, read off the row's own declaration.
 *
 * This message used to end "- no boundary declared for it" unconditionally,
 * and on run `20260916T223906Z` that sentence was FALSE on all 122 rows it was
 * printed for. Every one of them declared the boundary it died on -
 * `arg0-of-Object-entries-ref-128-binary-expr-0` declares `prisma` with
 * `doubles.prismaClient({ cachedLocation: { findMany: { resolves: [] } }, … })`
 * - and the recorder dropped the declaration before installing anything. The
 * artifact then sent every reader upstream to look for a missing declaration
 * that was never missing. A diagnosis nobody can act on is worse than none,
 * because it is acted on.
 *
 * So the reason is now derived from three states the recorder can tell apart:
 * the boundary was never declared, it was declared and DROPPED (and by which
 * kind), or it was declared and INSTALLED and the call escaped anyway - which
 * is a binding failure and a different bug, worth its own sentence.
 *
 * A FOURTH STATE LOOKS LIKE THE THIRD. assessment-service 20260925T072836Z:
 * the answer was installed at the right module, and the row's build patched
 * Array.prototype.map across its own import of the subject, so vitest
 * registered the row's queued mocks through the patch and registered none.
 * "The module the subject imports is not the one the answer was installed at"
 * was false - the mock never existed. flushQueuedMocks closes that door for
 * the build; the sentence still names it when the row shows the signs
 * (builtinPatchIn / mocksNotFlushed / builtinsRestored), so nobody goes hunting
 * a module mismatch.
 */
const BUILTIN_PATCH = /\b(?:Array|Object|Function|Promise|String|Map|Set)\.prototype\.[A-Za-z_$][\w$]*\s*=(?!=)/;
function builtinPatchIn(r) {
  const builds = [r?.entry?.build, ...(r?.args ?? []).map((a) => a?.build), ...(r?.calls ?? []).map((c) => c?.build)];
  const hit = builds.filter((b) => typeof b === "string").map((b) => b.match(BUILTIN_PATCH)).find(Boolean);
  return hit ? hit[0].replace(/\s*=$/, "") : null;
}
function blockedReason(row, runnable) {
  const what = String(row.harnessError.message)
    .replace(/^charpilot: /, "")
    .replace(/ blocked by.*$/, "");
  // `prisma.cachedLocation` -> `prisma`; `fetch to maps.googleapis.com` -> `fetch`.
  const root = what.split(/[. ]/)[0];
  const tail = "so recording would need a real call to a default-deny endpoint";
  const declared = (runnable.find((r) => r.id === row.id)?.mocks ?? []).filter((m) => m.symbol === root);
  const dropped = DROPPED_ANSWERS.filter((d) => d.id === row.id && d.symbol === root);
  if (dropped.length) {
    const d = dropped[0];
    return (
      `blocked egress: ${what} - the proposal DOES declare \`${root}\`, and this recorder did not install it: ${d.why}. ` +
      `To record it, ${d.howToRecord}.`
    );
  }
  // D68 follow-on: THE ANSWER WENT WHERE THE PROPOSAL SAID, AND THE FILE IMPORTS
  // IT FROM ELSEWHERE. qode-ptp-ms 20260927T061823Z,
  // handleRevaluatePrescreeningQuestion-341-binary-expr-0: once its stale
  // functionId was re-keyed it recorded, declaring `prisma` at
  // `@/lib/server/prisma` while helpers.ts imports it from `@/prisma/client`.
  // An explicit module wins over the import map (the `env`-from-'process' case
  // in classify), so the double sat at a module the row never loaded and the
  // real client reached the deny. That is the proposal's `module` to correct,
  // not a binding the recorder got wrong, and the sentence says so - it does
  // not say "declared AND installed", which is the toolset's.
  const overrode = declared.find((m) => m.overrode && !sameModuleId(m.module, m.overrode.module, m.overrode.file))?.overrode;
  if (overrode) {
    return (
      `blocked egress: ${what} - the proposal's own \`module\` put the answer for \`${root}\` at \`${declared[0].module}\`, ` +
      `and ${overrode.file} imports \`${root}\` from \`${overrode.module}\`: ` +
      `a declared module wins over the file's import, so this answer is not where that file's calls go - ` +
      `write "module": "${overrode.module}" for it, or leave \`module\` out`
    );
  }
  if (declared.length) {
    const said = `blocked egress: ${what} - \`${root}\` was declared AND installed (kind \`${declared[0].kind}\`, module \`${declared[0].module}\`) and the call reached the default-deny anyway. `;
    const patch = builtinPatchIn(runnable.find((r) => r.id === row.id));
    const restored = row.builtinsRestored ?? [];
    if (patch || restored.length || row.mocksNotFlushed) {
      const how = patch
        ? `the row's own build reassigns \`${patch}\``
        : restored.length
          ? `the row left ${restored.join(", ")} reassigned`
          : "the harness could not register them before the build ran";
      return (
        said +
        `Its mocks were most likely QUEUED BUT NEVER REGISTERED: ${how}, and vitest registers a row's queued vi.doMock calls on the next import using whatever builtins are in place then. ` +
        `Not a module mismatch - leave builtins alone across an import (import the subject first, patch after), or capture the callback another way.`
      );
    }
    return (
      said +
      `That is a binding failure, not a missing declaration: the module the subject imports is not the one the answer was installed at.`
    );
  }
  return `blocked egress: ${what} - no boundary declared for it, ${tail}`;
}

function writeDoc(proposals, runnable, skipped, cache) {
  // NARROWED, not `runnable`: the rows this artifact carries are the ones this
  // run selected. A cache polluted with another run's ids - which is what a
  // shared RESULT path used to produce - would otherwise be republished here as
  // this artifact's own behaviour, and was: behaviour-slice-5.json shipped 7
  // `slice2-` rows under `--only s5-` and counted them in its totals.
  const selected = selectedOf(runnable);
  const all = selected.map((r) => cache.rows[r.id]).filter(Boolean);
  // Deliberately still the BROAD set. `--only` narrows what is executed, never
  // what is accounted for, so a reader of a partial artifact can still see how
  // much of the runnable population is missing from it.
  // Not an id this run already skipped with a reason (a chunk that could not
  // start): that reason is the account of it, and a second entry would say
  // "not yet run" beside it.
  const skippedNow = new Set(skipped.map((s) => String(s.id)));
  const pending = runnable.filter((r) => !cache.rows[r.id] && !skippedNow.has(String(r.id)));

  // A row the egress guard stopped is NOT an observation, and it is not the
  // harness being broken either - it is the guard doing its job on a proposal
  // that declared no boundary for a default-deny endpoint. Leaving it in `rows`
  // would let `no-echoed-plan` count a blocked call as behaviour, so it is
  // reported as not-recordable, with what it tried to reach.
  const stopped = all.filter((r) => r.harnessError?.name === "CharpilotEgressBlocked");
  // A ROW IS NEVER PUBLISHED FOR AN ID THIS RECORDING SKIPPED. The row would be
  // an older observation - of an input that is now refused with a reason - and
  // emit would pin it. Evicted from the cache too, so a later run cannot
  // republish it either.
  const skippedIds = new Set(skipped.map((s) => String(s.id)));
  for (const r of all) if (skippedIds.has(String(r.id))) delete cache.rows[r.id];
  const rows = all.filter((r) => r.harnessError?.name !== "CharpilotEgressBlocked" && !skippedIds.has(String(r.id)));
  // A VERDICT IS ABOUT ONE OBSERVATION, AND IT STAYS WITH IT (item 6).
  // determinism.mjs stamps the artifact, never the cache, so a row served from
  // the cache came back unstamped and every walk observed every row a second
  // time. The stamp the artifact holds for THIS recording (`__recording`, the
  // process that observed it) is carried back; a row recorded again carries
  // none, and is the only kind determinism observes.
  const verdicts = INCREMENTAL_RECORD ? priorVerdicts() : new Map();
  for (const r of rows) {
    if (r.determinism || !r.__recording) continue;
    const v = verdicts.get(String(r.id));
    if (v && v.recording === r.__recording && v.fingerprint === r.__fingerprint) r.determinism = v.determinism;
  }


  const allSkipped = [
    ...skipped,
    ...stopped.map((r) => ({ id: r.id, file: r.file, reason: blockedReason(r, runnable) })),
    ...pending.map((r) => ({ id: r.id, file: r.file, reason: "runnable but not yet run in this session" })),
  ];
  const doc = {
    stage: "4-behaviour",
    ...modeStamp(),
    recordedAt: new Date().toISOString(),
    // The toolset that wrote this document (provenance, not the key), and the
    // key its rows are served under: recordingKey, OBSERVATION_VERSION.
    harnessVersion: harnessVersion(),
    recordingKey: cache.recordingKey,
    recordingKeyParts: recordingKeyParts(),
    // WHAT THIS RUN SELECTED. Without it a reader holding behaviour-partial.json
    // cannot tell a deliberate subset from a broad capture someone flattened
    // with --only, and the overwrite guard has nothing to quote back. stage 5's
    // emitted.json learned to stamp its argv; stage 4 never did.
    selection: {
      argv: process.argv.slice(2),
      only: ONLY ?? null,
      live: LIVE,
      liveProviders: LIVE_PROVIDERS,
      policy: POLICY,
      // The per-row budget the whole artifact was measured under. A
      // `notSettled` total is meaningless without it - qode-ptp-ms reported 10
      // not-settled sides at the 10s default and 0 at 45s, from the same
      // inputs - and nothing in the document said which number it was.
      rowTimeoutMs: ROW_TIMEOUT_MS,
      proposalsSeen: proposals.length,
      runnableSelected: runnable.length,
    },
    // Provenance the artifact can PROVE. "supplied" was not enough: a reader
    // could not tell which env produced these rows, and neither could a later
    // run. The digest identifies the env without storing any of its values.
    envFile: ENV_FILE ? `${relative(REPO_ROOT, ENV_FILE)} (values not stored)` : "process env only",
    envProvenance: envProvenance(),
    // The env vars this run FAKED (standins.mjs), by name - never a value.
    // Empty in a live run, which gets none.
    standIns: standInPlan().standIns,
    // The recorder's own defaults these rows ran under, with their values -
    // harness literals, never an ambient value (harnessEnvCarried). Stamped
    // HERE, at record time, because the emit is a different invocation: its
    // --policy decides REDIS_ENABLED and its shell may differ, and the spec
    // has to carry what THIS run ran under (D13, run 20260925T072757Z).
    harnessEnv: recordedHarnessEnv(),
    // WHICH REPO this artifact describes. Two agents on the 30% rung reported
    // artifact confusion on the same afternoon: one found its scratch backup
    // overwritten by another repo's 84-row document, and one read a 48-row doc
    // carrying a foreign repo's row ids from its own out/ path and said - fairly
    // - that it could not name the mechanism. Both had copied through one shared
    // scratchpad directory under the same filename, so the foreign document was
    // a scratch copy rather than the repo's file, and config.mjs pins OUT_DIR to
    // resolve(here, "out") with no path from one target to another.
    //
    // Ambiguity is the problem, not the copy. With the target stamped, "is this
    // my artifact" stops being an inference from row ids.
    target: basename(TARGET_ROOT),
    // Which modules the database default-deny actually covered on this run, and
    // what it could not reach. A reader of this artifact should never have to
    // guess whether the guard was live.
    dbGuard: (() => { const g = dbClientModules(); return { denied: g.modules, relativeUnreachable: g.relative, ormModulesSeen: g.ormSeen }; })(),
    totals: {
      proposals: proposals.length,
      runnable: runnable.length,
      recorded: rows.filter((r) => r.invoked).length,
      harnessFailures: rows.filter((r) => r.harnessError).length,
      blockedEgress: stopped.length,
      notSettled: rows.filter((r) => r.notSettled).length,
      // OF WHICH: the rows that never reached their subject at all. These are
      // an arrangement cost, not slow behaviour, and the repair is
      // --row-timeout rather than a new input. Split out because one number
      // for both sends the reader to stage 3 for a stage-4 flag.
      notSettledBeforeSubject: rows.filter((r) => r.notSettled && r.notSettled.subjectCallStarted === false).length,
      rowTimeoutMs: ROW_TIMEOUT_MS,
      egressAfterSettle: rows.filter((r) => r.egressAfterSettle).length,
      // Three different things used to share one `skipped` count, and the sum
      // read as though every one of them had been classified. A PENDING row is
      // runnable and simply has not been reached yet - an unfinished run. An
      // UNRUNNABLE row has a written reason and needs a harness built. Adding
      // them made "224 skipped" out of 68 real reasons, and 268 runnable + 224
      // skipped is more than the 336 proposals that exist - which is the tell.
      pending: pending.length,
      unrunnable: skipped.length,
      notRecorded: allSkipped.length,
    },
    rows,
    skipped: allSkipped,
    // Same-id copies not recorded, and the file each id was recorded from.
    shadowed: SHADOWED,
    // D68: rows recorded under the scan's id for a functionId written otherwise.
    rekeyed: REKEYED,
    // ANSWERS THE PROPOSAL WROTE AND THIS RUN DID NOT INSTALL. In the artifact
    // and not only on the console, because the console scrolls and stage 5
    // reads this file: a row whose boundary answer was dropped was arranged
    // differently from the program its proposal describes, whether or not it
    // went on to fail, and nothing else here would say so. Empty on a run that
    // installed everything it was given, which is the normal case.
    droppedAnswers: DROPPED_ANSWERS,
  };
  // Claim verdicts are per ROW; these are the same verdicts totalled, so a
  // reader does not have to. Only recorded rows can hold a claim - a row the
  // harness could not run measured nothing.
  const claims = claimTotals(rows.filter((r) => r.invoked));
  // EVERY claim, not just the judgeable ones. This read
  // `verified.length + wrong.length`, so claimsChecked equalled claimsVerified
  // in every artifact with no false claims - and a reader comparing it against
  // the rows found 211 verdicts where the field said 124. The console line was
  // always right; the field name promised something it did not deliver.
  doc.totals.claimsChecked = claims.verified.length + claims.wrong.length + claims.unmeasurable.length;
  doc.totals.claimsJudgeable = claims.verified.length + claims.wrong.length;
  doc.totals.claimsVerified = claims.verified.length;
  doc.totals.claimsFalse = claims.wrong.length;
  doc.totals.claimsUnmeasurable = claims.unmeasurable.length;
  // A false claim at stage 4 is a STAGE-3 defect to repair, not a failed run:
  // the observation is real, the label on it is wrong. Listed here so the
  // repair list exists without waiting for stage 6.
  doc.falseClaimsAtRecordTime = claims.wrong;
  doc.unmeasurableClaimsAtRecordTime = claims.unmeasurable;
  // Last thing before the write, so a refusal costs nothing already recorded -
  // the cache holds the rows and a widened re-run reuses them.
  //
  // The set is what the RUN will write, not what the cache holds so far.
  // writeDoc is called once per chunk, so passing the cached rows made the
  // guard compare a mid-run artifact against the finished one: on a 2-chunk
  // cold expansion of location-ms, chunk 1 held 16 rows, a 17th pre-existing
  // row was still queued in chunk 2, and the guard refused and KILLED THE RUN
  // before chunk 2 ever started. Any multi-chunk widening of an existing
  // artifact refused itself unless every prior row happened to land in chunk 1.
  // The run intends to write every SELECTED row, so that is the promise the
  // guard has to judge.
  //
  // `runnable` here - the broad set - is how the guard came to be unreachable
  // for every `--only` run, which is both halves of the "impossible" defect
  // report. The promise was "I will write all 193 runnable rows"; what the run
  // then wrote was the handful of rows its `--only` cache held. Every id in any
  // artifact recorded from the same proposals dir is somewhere in `runnable`,
  // so `lost` was empty by construction, guardOutput returned null before it
  // ever reached a refusal, and the doc even stamped `overwrite: null` to say
  // so. Measured: `--only slice4-isequal-two-numbers` with CHARPILOT_OUTPUT
  // pointed at a 39-row artifact wrote 1 row over it, silently.
  //
  // `selected` is the same predicate `wanted` uses, so a broad run is
  // byte-identical to before and the multi-chunk fix above still holds: chunk 1
  // of a widening run still promises every row chunk 2 will add.
  const willWrite = new Set([...selected.map((r) => r.id), ...rows.map((r) => r.id)]);
  // WHAT THIS RUN CAN SAY ABOUT AN ID IT IS NOT WRITING A ROW FOR. Both halves
  // are fixed before the first chunk - `skipped` is `classify`'s verdict over
  // the whole corpus and `proposals` is the whole corpus - so a row's fate
  // cannot depend on which chunk the guard happens to run in.
  //
  // `skipped` AND NOT `allSkipped`: the `pending` entries in `allSkipped` say
  // "runnable but not yet run in this session", which is not an observation and
  // is exactly what a `--only` run has to say about the rows it is about to
  // delete. Feeding them to the guard would let a narrow run claim it had
  // accounted for a broad capture. A `stopped` (egress-blocked) row is in
  // `runnable`, therefore in `selected`, therefore never in `lost` at all.
  const observed = {
    refused: new Map(skipped.map((s) => [s.id, s.reason])),
    seen: new Set(proposals.map((p) => p.id)),
  };
  // WHAT WAS REUSED AND WHAT WAS RECORDED, and why (item 6b): the walk's
  // record step prints it, so a log says whether a resume re-recorded the repo.
  doc.reuse = {
    rows: rows.length,
    recordedThisRun: rows.filter((r) => REUSE.recorded.has(r.id)).length,
    takenFromArtifact: REUSE.seeded,
    recordedAgainBecause: REUSE.evicted,
    // Each row this run recorded, and why - the one place a reader can see
    // what made a resume record a row.
    why: Object.fromEntries(rows.filter((r) => REUSE.recorded.has(r.id)).map((r) => [r.id, REUSE.why?.get(r.id) ?? "it had no recording"])),
  };
  // WHAT THE RECORDING OWES THE ENVIRONMENT (D67, prismaclient.mjs): each cause
  // its rows failed on, whether it is set up now, and the defect when the
  // causes still broken are a mass or cost a delivered row. In the artifact,
  // because the walk's record and emit steps and the emit itself judge it off
  // this file; the fields they compute from are the rows' own.
  const envDefect = environmentDefect({ rows }, REPO_ROOT, { delivered: deliveredIds() });
  doc.environment = {
    causes: environmentFailures({ rows }, REPO_ROOT).causes.map((c) => ({
      cause: c.key,
      setUp: c.fixed,
      what: environmentWhat(c.key, REPO_ROOT),
      failed: c.failed.length,
      kept: c.kept.length,
    })),
    defect: envDefect?.sentence ?? null,
  };
  // Written by the run's last write only: a document a stopped run left
  // behind says `false`, and its "not yet run" rows are recorded next walk.
  doc.recordingComplete = REUSE.complete === true;
  // The content hash of every repo file a row's stamp covers, as it was when
  // this document was written: only to NAME the file that moved when a stamp
  // stops matching (sourcedeps.mjs stampChanged).
  if (REUSE.graph) doc.sources = { files: REUSE.graph.hashed() };
  writeOutput(doc, [...willWrite], observed);
  return doc;
}

/** The artifact's determinism verdicts as this process found them, by id. */
let PRIOR_VERDICTS = null;
function priorVerdicts() {
  if (PRIOR_VERDICTS) return PRIOR_VERDICTS;
  PRIOR_VERDICTS = new Map();
  try {
    for (const r of JSON.parse(readFileSync(OUTPUT, "utf8")).rows ?? []) {
      if (r?.determinism && r.__recording) PRIOR_VERDICTS.set(String(r.id), { recording: r.__recording, fingerprint: r.__fingerprint, determinism: r.determinism });
    }
  } catch {
    // no artifact yet: nothing to carry
  }
  return PRIOR_VERDICTS;
}

/**
 * ANSWERS THIS RUN WAS HANDED AND DID NOT INSTALL.
 *
 * Printed whether or not the affected rows failed, because the failure is not
 * the point: a row can have its boundary answer dropped, take a path that
 * never touches that boundary, and record a perfectly clean pair - of a
 * program arranged differently from the one the proposal describes. That is
 * the quiet half, and it is the half that never shows up in a skip list.
 */
function reportDroppedAnswers() {
  if (!DROPPED_ANSWERS.length) return;
  const byKind = new Map();
  for (const d of DROPPED_ANSWERS) {
    // JSON, not a separator byte: a symbol can carry anything, and the one
    // delimiter guaranteed not to collide with it is a quoted array. A literal
    // U+0000 here would also make this file binary to git and to grep - see
    // tests/record.replay-port.test.mjs, which exists for exactly that.
    const k = JSON.stringify([d.kind, d.symbol]);
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  process.stdout.write(
    `\n! ${DROPPED_ANSWERS.length} declared boundary answer(s) were NOT installed - the real export ran instead:\n`
  );
  for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const [kind, symbol] = JSON.parse(k);
    process.stdout.write(`    ${String(n).padStart(4)}  ${symbol}  (mock.kind "${kind}" substitutes nothing)\n`);
  }
  process.stdout.write(`  ${DROPPED_ANSWERS[0].howToRecord}.\n`);
}

function reportSkips(skipped) {
  const byReason = {};
  for (const s of skipped) {
    const key = s.reason
      .replace(/^boundary \S+ /, "boundary ")
      .replace(/^trigger:\S+/, "trigger")
      .replace(/ for src\/.*$/, "")
      .replace(/^args\[\d+\]/, "args[n]")
      .replace(/^setup\[\d+\]/, "setup[n]");
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  if (Object.keys(byReason).length) {
    process.stdout.write("\n  why proposals were not recorded:\n");
    for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`    ${String(n).padStart(4)}  ${r}\n`);
    }
  }
}

/**
 * The doubles import has to be relative to where the spec is WRITTEN, not to
 * one hard-coded directory. `--emit-specs` puts specs a level deeper, and a
 * hard-coded "../fixtures/doubles" then resolves to nothing - 16 of 17 spec
 * files failed to load, which stage 5 would otherwise have measured as 0%
 * coverage rather than as a broken harness.
 */
function doublesImport(dest) {
  const rel = relative(dirname(dest), join(FIXTURES_DIR, "doubles")).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * Assert the downstream calls the recorder already wrote down.
 *
 * The recorder captures `boundaryCalls` per row - symbol, args and resolved
 * value - and until now the generated test asserted none of it: 755 recorded
 * calls across 246 of 365 rows, all discarded at stage 5. A return value is
 * only half of what a function DOES, and for the many rows whose recorded
 * return is `undefined` it is the half that carries nothing.
 *
 * That is most of the missing mutation score. A mutant that stops calling
 * prisma, calls it twice, or calls a different boundary changes no return value
 * and goes unnoticed - measured at 63.81% on files sitting at 100% branch
 * coverage.
 *
 * What is asserted is the CALL LEDGER: which boundaries were called, and in
 * what order. Deliberately NOT the arguments. An argument can hold a per-run
 * uuid or a timestamp, and `__unstablePaths` is computed for the returned value
 * only - so asserting args here would trade a weak test for a flaky one, which
 * is the worse trade. The ledger is stable unless the code path itself changes,
 * which is exactly the event worth failing on.
 */
function callLedgerFor(row) {
  const calls = row.boundaryCalls ?? [];
  if (!calls.length) return null;
  const ledger = calls.map((c) => c.symbol);
  return (
    `// The downstream calls this row recorded, in order. Not their arguments:\n    ` +
    `// an argument can carry a per-run identity, and only the RETURNED value\n    ` +
    `// has an unstable-path analysis behind it.\n    ` +
    `expect((observed.boundaryCalls ?? []).map((c) => c.symbol), "the downstream calls changed")\n      ` +
    `.toEqual(${JSON.stringify(ledger)});`
  );
}

/**
 * Turn a recorded outcome into an assertion.
 *
 * The row body is reused verbatim and pushes its result onto `results`, so the
 * assertion compares the JUST-OBSERVED snapshot against the RECORDED one. Both
 * sides go through the same `snap()`, which is what makes the comparison exact
 * rather than approximate - undefined, functions, errors, Map and Set all
 * survive as the same markers on both sides.
 *
 * Two guards come first on every test, because without them a harness failure
 * passes silently:
 *   invoked      the subject actually ran
 *   harnessError absent - a module-resolution or blocked-egress failure is not
 *                behaviour, and must never satisfy a characterization test
 */
/**
 * D46 — A ROW WHOSE WHOLE RETURNED VALUE IS PER-RUN IDENTITY STILL RUNS.
 *
 * This used to be `it.skip`. A skipped test never enters the function, so
 * istanbul counts nothing for it, and coverage.mjs then called the row's claim
 * FALSE ("istanbul says 0 hits") about an input that had taken exactly the
 * side it claimed when it was recorded. Measured on turing-integration-ms on
 * 2026-09-26: `saveCv` returns `${Date.now()}_${uuid}_${name}`, so EVERY row
 * through it is unstable at `returned`. The two rows that took the `"cv"`
 * fallbacks of line 62 recorded `..._cv`, were emitted as `it.skip`, measured
 * at 0 hits, were quarantined, withdrawn, re-answered and quarantined again,
 * and the run ended partial on those two sides with nothing left anybody
 * could write. The same skip is in the interview-service, email-centralization-ms
 * and qode-itl-be checkpoints of 2026-09-25 and 2026-09-26.
 *
 * What is still stable is asserted: the guards (it ran, no harness failure,
 * the replay verdicts, the downstream call ledger), that it RETURNED rather
 * than threw, and the value's kind. The value itself is not, and the test says
 * so. That is weaker than an exact assertion and the strength line says it is;
 * it is not weaker than a skip, which asserted nothing and ran nothing.
 */
function wholeValueUnstable(guards, value, path) {
  const kindOf = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x);
  return {
    kind: "returns",
    strength: `shape only - the whole recorded value is per-run identity (${path}), so its kind and the call ledger are pinned`,
    code:
      `${guards}\n` +
      `    // The WHOLE returned value is excluded as non-deterministic, measured over\n` +
      `    // two independent runs (${path}). It returned rather than threw, and what\n` +
      `    // kind of value it returned, is still the recorded behaviour.\n` +
      `    expect(observed.threw, "the subject threw").toBeUndefined();\n` +
      `    const __returned = observed.returned;\n` +
      `    expect(__returned === null ? "null" : Array.isArray(__returned) ? "array" : typeof __returned)` +
      `.toBe(${JSON.stringify(kindOf(value))});`,
  };
}

function assertionFor(row) {
  const guards = [
    `const observed = results[results.length - 1];`,
    `expect(observed.harnessError, "harness failure is not behaviour").toBeUndefined();`,
    `expect(observed.invoked, "the subject did not run").toBe(true);`,
    // D50: a row that ran out of budget in the replay says so. It used to reach
    // the call ledger first and fail as "the downstream calls changed:
    // expected []", a claim about the recorded value that was a timing
    // outcome; the matcher's name makes it classify as a row timeout.
    `expect(observed.notSettled?.why, "CharpilotRowTimeout: the row did not settle in the replay").toBeUndefined();`,
    // THE REPLAY'S OWN THREE VERDICTS, asserted rather than reported.
    //
    // Each of these is a way the committed test can pass while not being the
    // pair that was observed: a request answered from no recording, a recorded
    // exchange the subject never asked for, or one the replay could not use at
    // all. Left unasserted they are fields in an artifact, and a field in an
    // artifact does not fail a suite.
    `expect(observed.replayMismatch, "the replay answered a request the recording does not hold").toBeUndefined();`,
    `expect(observed.replayUnconsumed, "a recorded exchange was never replayed").toBeUndefined();`,
    callLedgerFor(row),
  ]
    .filter(Boolean)
    .join("\n    ");

  if (row.notSettled) {
    return {
      kind: "skip",
      why:
        row.notSettled.subjectCallStarted === false
          ? `did not settle in ${row.notSettled.afterMs}ms and the SUBJECT CALL WAS NEVER ENTERED - the arrangement used the whole budget, so raise --row-timeout and re-record; there is nothing to assert`
          : `did not settle in ${row.notSettled.afterMs}ms - nothing to assert`,
    };
  }
  // Quarantined by verify-generated.mjs: the pair did not reproduce on an
  // isolated run, so it is not a pair. Skipped with the reason in the file
  // rather than deleted - the arm stays visible as work.
  if (row.__quarantine) return { kind: "skip", why: row.__quarantine };

  if (row.threw) {
    return {
      kind: "throws",
      strength: "name + message",
      // The WHOLE snapped error, not a name/message pair. Rebuilding two fields
      // discarded the status and metadata a custom error carries - the same
      // loss as above, one stage later, and this is the copy that ends up in a
      // committed test.
      code: `${guards}\n    expect(observed.threw).toMatchObject(${JSON.stringify(row.threw)});`,
    };
  }

  const v = row.returned;

  // A path the determinism check found unstable carries per-run identity, so
  // asserting on it makes the test fail on a schedule. The rest of the value is
  // still worth pinning - `pendingEventProcessingPromises` is one field of a
  // Langfuse client with 76 leaves - so the path is REMOVED from both sides and
  // named in the test. Skipping the row would discard 75 stable leaves to avoid
  // one; asserting on it would produce a test that gets deleted the first
  // Friday it fails, silently removing real coverage.
  if (row.__unstablePaths?.length) {
    const strip = (obj, path) => {
      const parts = path.replace(/^returned\.?/, "").split(".").filter(Boolean);
      if (!parts.length) return undefined;
      const clone = JSON.parse(JSON.stringify(obj));
      let cur = clone;
      for (const k of parts.slice(0, -1)) {
        if (cur == null || typeof cur !== "object") return clone;
        cur = cur[k];
      }
      if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
      return clone;
    };
    let expected = v;
    const dropped = [];
    for (const path of row.__unstablePaths) {
      const next = strip(expected, path);
      if (next === undefined) return wholeValueUnstable(guards, v, path);
      expected = next;
      dropped.push(path);
    }
    return {
      kind: "returns",
      strength: `exact, excluding ${dropped.join(", ")} (per-run identity)`,
      code:
        `${guards}\n` +
        `    // Excluded as non-deterministic, measured over two independent runs:\n` +
        dropped.map((d) => `    //   ${d}\n`).join("") +
        dropped.map((d) => `    dropPath(observed.returned, ${JSON.stringify(d.replace(/^returned\.?/, ""))});\n`).join("") +
        `    expect(observed.returned).toEqual(${JSON.stringify(expected)});`,
    };
  }

  if (v && typeof v === "object" && v.$truncated) {
    return { kind: "skip", why: "recorded value was depth-truncated - the value is unknown, so there is nothing honest to assert" };
  }
  if (v && typeof v === "object" && v.$function) {
    // The recorder captured a function OBJECT and never called it. Asserting on
    // its name would pin a minifier artifact; asserting on its behaviour would
    // be asserting something never observed.
    return {
      kind: "returns-function",
      strength: "shape only - a function was captured, never invoked",
      code: `${guards}\n    expect(observed.returned).toHaveProperty("$function");`,
    };
  }
  return {
    kind: "returns",
    strength: "exact",
    code: `${guards}\n    expect(observed.returned).toEqual(${JSON.stringify(v)});`,
  };
}

/**
 * The row runtime, shared verbatim by the recording spec and by a GENERATED
 * TEST. One named block, not two copies: a test must be arranged by the SAME
 * code that arranged the recording - same default-deny transport guard, same
 * applyMock semantics, same serialisation. A second implementation would be a
 * second thing to keep true, and the first time it drifted the test would be
 * asserting about a different program while still passing.
 *
 * Verified by construction: after this was named, the spec the recorder emits
 * was diffed against the spec emitted before it. Byte-identical.
 */
/**
 * Which module exports this repo's database client.
 *
 * The default-deny used to name "@/prisma/client" - THIS repo's path - so on any
 * service that puts its client somewhere else the guard installed nothing and
 * said nothing. interview-service reaches its client as "@/db", and every
 * prisma-touching row there would have dialled a real Postgres unless the
 * proposal happened to answer prisma itself. That is the worst failure shape in
 * the pipeline: not a refused row, a real connection to a shared database.
 *
 * So it is resolved from the target's own scan. A module qualifies by exporting
 * a symbol that IS a client instance - prisma, db, database, prismaClient,
 * getPrisma - and "@prisma/client" itself is deliberately excluded: it exports
 * the enums and error classes the code reads at runtime (ApiKey, Provider,
 * PrismaClientKnownRequestError), and denying those breaks the subject rather
 * than protecting the database.
 */
// Deliberately NOT getPrisma/getDb. A getter lives in a utility module beside
// other exports - pricing-ms has one in @/utils/transaction next to
// runInTransaction and registerBackgroundTask - and the deny below replaces a
// module WHOLESALE, so denying that module would delete the functions the
// subject calls. Only a module whose export IS the client qualifies.
const DB_CLIENT_SYMBOL = /^(prisma|db|database|prismaClient)$/i;
const DB_ORM_MODULE = /prisma|typeorm|mongoose|knex|sequelize|drizzle/i;
let DB_MODULES_CACHE = null;
function dbClientModules() {
  if (DB_MODULES_CACHE) return DB_MODULES_CACHE;
  const found = new Set();
  const ormSeen = new Set();
  const relative = new Set();
  try {
    const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
    for (const fn of scan.functions ?? []) {
      for (const b of fn.boundaries ?? []) {
        if (!b || typeof b !== "object" || !b.module) continue;
        if (DB_ORM_MODULE.test(b.module)) ormSeen.add(b.module);
        // A bare package export is a type/enum surface, not the instance.
        if (b.module.startsWith("@prisma/")) continue;
        // A RELATIVE specifier cannot be used here. vi.doMock resolves it
        // against the SPEC file, not against the source file that wrote it, so
        // "../db" from src/services/x.ts would mock a different path or nothing
        // at all - silently, which is the failure this whole resolver exists to
        // remove. Collected separately and reported, never mocked on a guess.
        if (b.module.startsWith(".")) {
          if (DB_CLIENT_SYMBOL.test(String(b.symbol ?? ""))) relative.add(b.module);
          continue;
        }
        if (DB_CLIENT_SYMBOL.test(String(b.symbol ?? ""))) found.add(b.module);
      }
    }
  } catch {
    // No scan yet is not an error here - the caller still gets the default.
  }
  // Always kept, so a repo laid out like this one behaves exactly as before.
  found.add("@/prisma/client");
  DB_MODULES_CACHE = { modules: [...found], ormSeen: [...ormSeen], relative: [...relative] };
  return DB_MODULES_CACHE;
}

/**
 * Say out loud when the database default-deny covers nothing.
 *
 * A guard that silently protects nothing is worse than no guard, because the
 * run reads as safe. So the two states that mean "unprotected" are printed
 * before the first row, and stamped into the artifact so a later reader of
 * behaviour.json can tell which state produced it.
 */
/**
 * The FILES the client modules name, without an extension - what a CJS
 * require() resolves to, where vi.doMock's module ids do not reach (see
 * denyRequire). Spelled through the pilot's alias floor, the one the record
 * config also resolves by: @/prisma -> prisma/client, @/prisma/x -> prisma/x,
 * @/x and src/x -> src/x, /x -> x. A package name has no file here.
 */
function dbClientFiles() {
  const out = new Set();
  for (const m of dbClientModules().modules) {
    let rel = null;
    if (m === "@/prisma") rel = "prisma/client";
    else if (m.startsWith("@/prisma/")) rel = m.slice(2);
    else if (m.startsWith("@/")) rel = `src/${m.slice(2)}`;
    else if (m.startsWith("src/")) rel = m;
    else if (m.startsWith("/")) rel = m.slice(1);
    if (rel) out.add(join(TARGET_ROOT, rel).replace(/\.(c|m)?[jt]sx?$/, "").replace(/\/index$/, ""));
  }
  return [...out];
}

function dbGuardNotice() {
  const { modules, ormSeen, relative } = dbClientModules();
  // The default counts as RESOLVED when the scan actually shows the target
  // importing it - which is the case in a repo laid out like this one. Filtering
  // it out unconditionally made the warning fire here, where the guard is
  // correct, and a guard that cries wolf gets ignored when it is right.
  const resolved = modules.filter((m) => m !== "@/prisma/client" || ormSeen.includes("@/prisma/client"));
  const lines = [];
  if (relative.length) {
    lines.push(
      `! the database client is imported by a RELATIVE path (${relative.join(", ")}), which vi.doMock resolves against the spec, not the source`,
      `  the default-deny cannot cover it - every db boundary must be answered by its own proposal`
    );
  }
  if (!resolved.length && ormSeen.length && !relative.length) {
    lines.push(
      `! no database client module resolved from the scan, but it imports ${ormSeen.join(", ")}`,
      `  the default-deny is installed at @/prisma/client only - if this repo's client is elsewhere, it covers nothing`
    );
  }
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

const ROW_RUNTIME = `/** Stable, cycle-safe serialisation. An observation must not depend on key order. */
/**
 * Redaction, at the one place every recorded value passes through.
 *
 * The stage-4 skill claimed the recorder "redacts credential-bearing headers
 * and fields out of captured requests". It did not - grepping for "redact"
 * returned nothing - and the consequence was live in the tree: location-ms's
 * behaviour.json held its real GOOGLE_API_KEY verbatim inside an
 * X-Goog-Api-Key header in boundaryCalls, 34 non-placeholder tokens across 14
 * rows, in a directory git did not ignore. One "git add .claude" would have
 * committed a working key. Found by the agent recording that repo's 20% rung.
 *
 * Redaction is by KEY, not by value, because a credential is never a
 * legitimate observable - the standing rule for this whole pipeline is to
 * report a variable NAME and never its value - while guessing at values would
 * both miss short secrets and destroy real data that happens to look random.
 * The key is kept so the shape of the call is still readable, and the length
 * is kept because "was it set at all" is sometimes the observable.
 */
const CREDENTIAL_KEY =
  /^(?:x-)?(?:api[-_]?key|apikey|goog-api-key|authorization|auth|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|password|passwd|passphrase|credential|private[-_]?key|client[-_]?secret|signing[-_]?secret|webhook|hook|dsn|connection[-_]?string|database[-_]?url|session|cookie|set-cookie)$/i;

/** A secret smuggled into a URL or an Authorization value, not into a key. */
function scrubString(text) {
  return String(text)
    .replace(/([?&](?:key|api[-_]?key|apikey|access[-_]?token|token|secret|signature|sig)=)[^&#\\s]+/gi, "$1<redacted>")
    .replace(/\\b(Bearer|Basic|Token)\\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>")
    .replace(/\\b(postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|amqp):\\/\\/[^:@\\s]+:[^@\\s]+@/gi, "$1://<redacted>@")
    // A URL that IS the credential. profile-centralized's artifact captured a
    // live hooks.slack.com webhook as axios.post's argument 0, because
    // sendSlackError.ts passes env.SLACK_HOOK positionally - so it arrived
    // under no key at all and every key-based rule missed it. It got WORSE with
    // the callable-boundary fix: that row used to record boundaryCalls: [].
    // The path segment after the host is the secret, so the host is kept and
    // the rest goes.
    .replace(/(https:\\/\\/hooks\\.slack\\.com\\/services\\/)[A-Za-z0-9\\/+_-]+/g, "$1<redacted>")
    .replace(/(https:\\/\\/discord(?:app)?\\.com\\/api\\/webhooks\\/)[A-Za-z0-9\\/_-]+/g, "$1<redacted>")
    .replace(/(https:\\/\\/[a-z0-9.-]*webhook[a-z0-9.-]*\\/)[A-Za-z0-9\\/+_-]{16,}/gi, "$1<redacted>");
}

/**
 * An engine-written error message, without the part that belongs to the NODE
 * VERSION rather than to the code.
 *
 * V8 12 appends a line and column to a JSON.parse failure; Node 20's V8 does
 * not. cv-parsing-ms PR #67 recorded on the image's node and replayed on the
 * repo's CI node 20 (actions/setup-node, node-version: 20), and two rows went
 * red on nothing else:
 *   - "Unterminated string in JSON at position 8 (line 1 column 9)"
 *   + "Unterminated string in JSON at position 8"
 * and "Unexpected non-whitespace character after JSON at position 2" the same.
 * The position is the code's behaviour and is kept; the suffix is a rendering
 * the engine chose, and is dropped on both sides - this runs in the recorder
 * and in the committed test alike. Only a SyntaxError whose message ends in
 * exactly that suffix is touched, so a message the service wrote itself is
 * never rewritten.
 */
function engineStableMessage(err) {
  const m = String(err.message);
  return err.name === "SyntaxError" ? m.replace(/( JSON at position \\d+) \\(line \\d+ column \\d+\\)$/, "$1") : m;
}

function snap(value, depth = 0) {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") {
    if (typeof value === "function") return { $function: value.name || "anonymous" };
    if (typeof value === "bigint") return { $bigint: String(value) };
    if (typeof value === "string") return scrubString(value);
    // D51 — A NUMBER JSON CANNOT SPELL IS TAGGED, LIKE EVERY OTHER SUCH VALUE.
    //
    // JSON has no NaN, no Infinity and no negative zero: JSON.stringify writes the
    // first three as null and the last as 0. snap() passed numbers through, so the
    // recording stored null where the subject had produced NaN, while the replayed
    // test snapped the SAME NaN in memory and compared it against that null - red
    // on every run, with nothing timing-related in it. Measured on sourcing-ms
    // 20260926T014717Z: calculateTenure's empty-experiences row computes
    // Math.ceil(0 / 0) and returns { avgCompanyTenure: NaN }; the row was recorded
    // as { avgCompanyTenure: null }, cigate withheld it ("expected { avgCompanyTenure:
    // NaN } to deeply equal { avgCompanyTenure: null }"), and a side the input had
    // really taken was ruled pipeline_defect. -0 is the same class: toEqual tells
    // -0 from +0, so a recorded 0 is red against an observed -0.
    //
    // The encoding follows $undefined and $bigint: a tag whose value is the
    // number's own spelling ("NaN", "Infinity", "-Infinity", "-0"), which Number()
    // reads back exactly. Both sides of the comparison go through this snap(), so
    // the emitted expectation and the replayed observation carry the same tag at
    // any depth, and revive() turns a recorded boundary answer back into the
    // number the subject was given rather than into null.
    if (typeof value === "number") {
      if (Object.is(value, -0)) return { $number: "-0" };
      return Number.isFinite(value) ? value : { $number: String(value) };
    }
    return value;
  }
  if (depth > 6) return { $truncated: true };
  if (value instanceof Error) {
    // name and message ALONE threw away what the error was carrying. This
    // service throws HttpException(message, status, metadata), and the row
    // recorded only {name, message} - so a stage-5 test written from it could
    // not assert the 500 or the metadata the throw exists to attach. Own
    // enumerable properties are exactly the fields a custom error adds, and
    // stack is excluded on purpose: it is machine-specific and would make every
    // pair non-reproducible.
    const extra = {};
    for (const k of Object.keys(value)) {
      if (k === "stack" || k === "message" || k === "name") continue;
      extra[k] = snap(value[k], depth + 1);
    }
    const message = engineStableMessage(value);
    return Object.keys(extra).length
      ? { $error: value.name, message, ...extra }
      : { $error: value.name, message };
  }
  // Boxed built-ins carry their value in internal slots, NOT in own enumerable
  // keys, so the Object.keys() walk below flattens every one of them to {}.
  // Measured: a row returning a Date recorded {} and stage 5 would have
  // asserted {} - green, and pinning nothing. Each tag below is a value the
  // walk cannot reach.
  if (value instanceof Date) {
    const t = value.getTime();
    return { $date: Number.isNaN(t) ? "Invalid Date" : value.toISOString() };
  }
  if (value instanceof RegExp) return { $regexp: String(value) };
  // URLSearchParams keeps its pairs in internal slots, so the key walk records
  // {} - and a form-encoded OAuth body is exactly what one arm under test
  // decides. notification-ms recorded axios.post's body as {} for every
  // oauth.v2.access call while the istanbul verdict was verified, so the row
  // was sound with an empty boundary half.
  if (typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams) {
    return { $urlSearchParams: [...value.entries()] };
  }
  // A Node stream has no useful serialisation and an enormous one. winston's
  // logger.info() RETURNS the logger, which is a Transform, so once the spy fix
  // made those calls observable, snap() walked _readableState, _writableState,
  // _events and every transport: one logger.info recorded 37,624 bytes and
  // location-ms's behaviour.json went 107,513 -> 532,988 for three added rows,
  // with four rows at 39-44 KB each. The CALL is the observation there; the
  // return value is the logger itself and says nothing.
  //
  // Tagged rather than dropped, so a row still shows that a stream was the
  // answer, and tagged HERE rather than special-cased for spy because the
  // same walk is just as wrong wherever a stream is returned.
  if (typeof value.pipe === "function" && (value._readableState || value._writableState)) {
    return { $stream: value.constructor?.name ?? "Stream" };
  }
  // A generator object also has no own enumerable keys. Every stream-returning
  // function in this service recorded an empty object because of it. The drain
  // below replaces the top-level case; this tag covers a generator that arrives
  // nested inside a returned object, where draining is not safe to do blind.
  if (typeof value.next === "function" && typeof value[Symbol.asyncIterator] === "function") return { $asyncIterator: true };
  if (typeof value.next === "function" && typeof value[Symbol.iterator] === "function") return { $iterator: true };
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // D51: a Float32/Float64Array slot can hold NaN or -0 as well.
    return { $typedArray: value.constructor.name, values: Array.from(value, (n) => (typeof n === "bigint" ? String(n) : snap(n, depth + 1))) };
  }
  if (value instanceof ArrayBuffer || value instanceof DataView) {
    return { $binary: value.constructor.name, byteLength: value.byteLength };
  }
  if (Array.isArray(value)) return value.map((v) => snap(v, depth + 1));
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [snap(k, depth + 1), snap(v, depth + 1)]) };
  if (value instanceof Set) return { $set: [...value].map((v) => snap(v, depth + 1)) };
  const out = {};
  for (const k of Object.keys(value).sort()) {
    if (CREDENTIAL_KEY.test(k)) {
      const v = value[k];
      out[k] = { $redacted: typeof v, length: typeof v === "string" ? v.length : undefined };
      continue;
    }
    out[k] = snap(value[k], depth + 1);
  }
  return out;
}
const safe = (x) => { try { return JSON.stringify(snap(x)); } catch { return String(x); } };

/**
 * Drain a returned iterator, capped.
 *
 * A generator body does not run when the function is CALLED - it runs when the
 * result is iterated. So a row that called a stream function and stopped there
 * observed nothing: it recorded an empty object (no own enumerable keys) AND
 * moved none of the arms inside the body, so its reaches claim measured as false
 * through no fault of the input. Measured on this service: 6 rows, all of them
 * the LLM streaming paths.
 *
 * Draining is therefore part of invoking, not an extra observation - and it runs
 * INSIDE the row timeout, because an endless stream is exactly the shape that
 * would otherwise wedge a whole chunk.
 *
 * Arrays, Maps, Sets and strings are iterable but have no next(), so they fall
 * through untouched and keep their ordinary snapshot.
 */
const DRAIN_CAP = 100;
async function drainIfIterator(value) {
  if (value === null || typeof value !== "object") return value;
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
    typeof value[Symbol.asyncIterator] === "function" &&
    (typeof value.getReader === "function" || typeof value.next === "function") &&
    typeof value.pipe !== "function";
  // The sync case still needs a guard, because Array/Map/Set/TypedArray are all
  // iterable and each has a better snapshot than a list of yields. next() is the
  // discriminator that keeps generators in and collections out.
  const isSync =
    !isAsync &&
    typeof value[Symbol.iterator] === "function" &&
    typeof value.next === "function" &&
    !Array.isArray(value) &&
    !(value instanceof Map) &&
    !(value instanceof Set) &&
    !ArrayBuffer.isView(value);
  if (!isAsync && !isSync) return value;
  const yielded = [];
  const tag = { $drained: isAsync ? "asyncIterator" : "iterator", yielded };
  try {
    if (isAsync) {
      for await (const v of value) {
        if (yielded.length >= DRAIN_CAP) { tag.truncatedAt = DRAIN_CAP; break; }
        yielded.push(v);
      }
    } else {
      for (const v of value) {
        if (yielded.length >= DRAIN_CAP) { tag.truncatedAt = DRAIN_CAP; break; }
        yielded.push(v);
      }
    }
  } catch (err) {
    // A stream that throws mid-flight is an observation, not a harness failure:
    // the yields BEFORE the throw are real and are kept alongside it.
    tag.threw = err instanceof Error ? snap(err) : { $error: "non-error", message: String(err) };
  }
  return tag;
}

/**
 * Which branch arms did THIS row actually move.
 *
 * @vitest/coverage-istanbul instruments in the vite transform and keeps its
 * counters in-process, on \`globalThis.__VITEST_COVERAGE__\` - istanbul's
 * ordinary \`__coverage__\` shape (path -> { branchMap, b, s, f }) under vitest's
 * own variable name. Probed rather than assumed: the counters increment live
 * inside the worker, the file entry keeps its identity across
 * \`vi.resetModules()\`, and a re-import does NOT reset them (the preamble keeps
 * the existing object when the source hash matches). So they accumulate across
 * rows and a per-row DIFF is the only way to attribute movement.
 *
 * Snapshot and diff only. The README records a prior attempt at member-wise
 * proxy wrapping that destabilised object identity and stopped five clean rows
 * from settling: a WRONG recording is worse than an incomplete one. Nothing
 * here touches the subject, its modules or its promises - it reads integers.
 */
const COVERAGE = () => globalThis.__VITEST_COVERAGE__ ?? globalThis.__coverage__ ?? null;
const REPO_ROOT_PREFIX = ${JSON.stringify(`${REPO_ROOT}/`)};
/**
 * The path istanbul keys by, as the scan writes it: repo-relative, and with any
 * vite query suffix (\`?v=\`, \`?import\`) removed. Both the per-row diff and the
 * branch map go through this one function, because two spellings of the same
 * file are two files as far as the join is concerned.
 */
const relFile = (p) => {
  const clean = String(p).split("?")[0];
  return clean.startsWith(REPO_ROOT_PREFIX) ? clean.slice(REPO_ROOT_PREFIX.length) : clean;
};

/**
 * Deep copy of every branch counter, so the diff cannot alias the live array.
 *
 * An EMPTY object when the store does not exist yet, not null: the provider
 * creates \`globalThis.__VITEST_COVERAGE__\` when the first instrumented module
 * is imported, so a snapshot taken at the top of the first row of a chunk
 * legitimately finds nothing counted. Returning null there made every such
 * baseline unusable and silently dropped the arrangement window. "Coverage is
 * off" is a question about the LIVE store at diff time, and covDiff asks it.
 */
function covSnapshot() {
  const cov = COVERAGE();
  if (!cov) return {};
  const out = {};
  for (const p of Object.keys(cov)) {
    const b = cov[p] && cov[p].b;
    if (!b) continue;
    const file = {};
    for (const id of Object.keys(b)) file[id] = Array.isArray(b[id]) ? b[id].slice() : [];
    out[p] = file;
  }
  return out;
}

/** Only what INCREMENTED between two snapshots: { file: { branchId: [sideIdx] } }. */
function covBetween(before, after) {
  if (!before || !after) return null;
  const moved = {};
  for (const p of Object.keys(after)) {
    const now = after[p];
    const was = before[p] || {};
    const file = {};
    for (const id of Object.keys(now)) {
      const a = now[id] || [];
      const b0 = was[id] || [];
      const sides = [];
      for (let i = 0; i < a.length; i += 1) if ((a[i] || 0) > (b0[i] || 0)) sides.push(i);
      if (sides.length) file[id] = sides;
    }
    if (Object.keys(file).length) moved[relFile(p)] = file;
  }
  return moved;
}

/**
 * What has moved since a snapshot, read against the counters as they stand now.
 * Null - and only null - means there is no coverage store at all, which is the
 * one condition under which a claim on this row cannot be judged.
 */
const covDiff = (before) => (COVERAGE() ? covBetween(before, covSnapshot()) : null);

/**
 * istanbul's static branch map for the files this chunk loaded, trimmed to the
 * three fields the arm join uses. Written next to the results: a branch INDEX
 * means nothing without it, and armjoin.mjs owns the mapping from
 * (file, branchId) back to an armId.
 *
 * ## The line numbers have to be remapped, and this is not optional
 *
 * The in-process counters are keyed to the TRANSFORMED source. esbuild strips
 * the types and comments before istanbul instruments, so
 * \`cache.decorator.ts\`'s branches sit at lines 11, 17, 35, 38 … in there and at
 * 34, 42, 61, 65 … in the file the AST scan read. Joining on the raw numbers
 * matched nothing at all - measured: 19 of 19 claims came back "no matching
 * istanbul branch", which reads as a broken proposal and was a broken join.
 *
 * The provider stores the vite source map on the coverage entry as
 * \`inputSourceMap\` (it is what \`generateCoverage\` remaps the final report
 * through), so the same correction is available here. \`node:module\`'s
 * SourceMap does it with no dependency, and the result was checked branch for
 * branch against the provider's OWN remapped report for five files - 78
 * branches, identical ids, identical lines. That equality is the reason to
 * trust this and the thing to re-check if the join ever drifts.
 *
 * A file whose branches cannot be remapped is emitted EMPTY rather than with
 * transformed lines. An empty entry makes every claim on it "unmeasurable";
 * wrong lines would make them "false", which blames the input for the tool.
 */
const SKELETON_CACHE = new Map();
function covSkeleton() {
  const cov = COVERAGE();
  if (!cov) return null;
  const out = {};
  for (const p of Object.keys(cov)) {
    const e = cov[p];
    if (!e || !e.branchMap || !Object.keys(e.branchMap).length) continue;
    const rel = relFile(p);
    // Keyed on the instrumented file's own hash: the map is a property of the
    // source, so it is computed once and reused for every later row instead of
    // re-parsing 40 source maps per row.
    const key = \`\${rel}|\${e.hash}\`;
    if (!SKELETON_CACHE.has(key)) {
      let sm = null;
      try {
        sm = e.inputSourceMap ? new SourceMap(e.inputSourceMap) : null;
      } catch {
        sm = null;
      }
      const file = {};
      if (sm) {
        for (const id of Object.keys(e.branchMap)) {
          const br = e.branchMap[id];
          const start = (br.loc && br.loc.start) || { line: br.line, column: 0 };
          let line = null;
          try {
            const entry = sm.findEntry(Math.max(0, (start.line ?? 1) - 1), start.column ?? 0);
            if (entry && entry.originalLine !== undefined) line = entry.originalLine + 1;
          } catch {
            line = null;
          }
          if (line === null) continue;
          file[id] = {
            type: br.type,
            line,
            n: (br.locations && br.locations.length) ?? ((e.b && e.b[id] && e.b[id].length) || 0),
          };
        }
      }
      SKELETON_CACHE.set(key, file);
    }
    out[rel] = SKELETON_CACHE.get(key);
  }
  return out;
}

/**
 * A row that never settles must not take the whole chunk with it. The rejection
 * is marked so the row records "did not settle" rather than a fabricated value.
 */
/**
 * TOOL BACKLOG: THE ROW BUDGET IS THE SUBJECT'S, NOT THE IMPORT'S.
 *
 * The budget ran from the start of the row, so a cold import of a heavy
 * module graph spent it before the subject was called. pricing-ms's emitted
 * credit.routes suite (verifier #2 on af220dd): under istanbul and a loaded
 * machine, getCreditHistory-75-cond-expr-0 spent its 10000ms importing the
 * route, recorded no calls, and its late calls landed in the next row -
 * "the downstream calls changed" in both, 182 of 184. Reproduced by setting
 * that file's budget to 1500ms, which gives exactly that pair of failures.
 * Now the arrangement (imports, seeds, preconditions) has its own allowance,
 * IMPORT_BUDGET_MS, and ROW_TIMEOUT_MS runs from the moment the subject is
 * called (ROW_SUBJECT_AT). A row still stuck in its arrangement after the
 * allowance fails as before, and says which half.
 */
const IMPORT_BUDGET_MS = Math.max(60_000, ROW_TIMEOUT_MS);
let ROW_SUBJECT_AT = null;
/**
 * D50: A SUBJECT CALL THAT IMPORTS A MODULE GETS THE IMPORT ALLOWANCE WHILE IT
 * IMPORTS.
 *
 * A module-import row imports its module INSIDE the subject call (the import is
 * the call), and so does an invoke.build written as
 *   async () => { await import('src/main'); ... }
 * for a module-scope \`void bootstrap()\`. The cold import of a heavy graph was
 * then charged to ROW_TIMEOUT_MS, not to IMPORT_BUDGET_MS, and whichever row
 * imported first paid it. qode-itl-be (September 2026): the first bootstrap
 * row took 10075ms importing AppModule's graph and recorded "did not settle",
 * so it was emitted as it.skip; the rows after it recorded warm, in about
 * 450ms. In the committed suite the skipped row no longer pays, so the first
 * row that RUNS imports cold, and under cigate's full, instrumented corpus it
 * hit the 10s budget before NestFactory.create was called: "the downstream
 * calls changed: expected [] to deeply equal ['NestFactory.create', ...]".
 * Which row pays depends on which rows run before it, so the recording and the
 * replay disagreed about the same row.
 *
 * So the import is marked (\`charpilotSubjectImport\`, around the import() of a
 * module-import row and of an invoke.build) and, while one is pending, the row
 * is bounded by the import allowance, as its arrangement is. The subject's own
 * budget starts again when the import settles: what the module's code does
 * after it loads (bootstrap's awaited chain) is still bounded by
 * ROW_TIMEOUT_MS, and the recorded outcome does not depend on how warm the
 * transform cache was. A row still importing after the allowance fails as a
 * row timeout, and says so.
 */
let SUBJECT_IMPORTS = 0;
// The row's ROW_MARK fields ({ id, started }), so the parent's watchdog
// (record.mjs spawnWatched) is told about the import too: it reads the same
// clock from outside, and without \`importing\` it killed the chunk
// ROW_TIMEOUT_MS + ROW_GRACE_MS after subjectAt, mid-import.
let SUBJECT_MARK = null;
function markSubjectImport() {
  if (!ROW_MARK || !SUBJECT_MARK || ROW_SUBJECT_AT === null) return;
  try {
    writeFileSync(ROW_MARK, JSON.stringify({ ...SUBJECT_MARK, subjectAt: ROW_SUBJECT_AT, ...(SUBJECT_IMPORTS > 0 ? { importing: true } : {}) }));
  } catch { /* the mark is advisory */ }
}
async function charpilotSubjectImport(load) {
  const mine = ownRow();
  if (mine) {
    SUBJECT_IMPORTS += 1;
    markSubjectImport();
  }
  try {
    return await load();
  } finally {
    // An import an EARLIER row left pending (it timed out) is not this row's,
    // and neither moves this row's clock.
    if (mine && ownRow()) {
      SUBJECT_IMPORTS = Math.max(0, SUBJECT_IMPORTS - 1);
      if (SUBJECT_IMPORTS === 0 && ROW_SUBJECT_AT !== null) ROW_SUBJECT_AT = HARNESS_DATE_NOW();
      markSubjectImport();
    }
  }
}
/**
 * THE HARNESS'S OWN CLOCK, taken before any row can stub it.
 *
 * A row may declare \`setTimeout\` a boundary, and stubGlobal then replaces
 * \`globalThis.setTimeout\` with a double - one that runs its callback at once,
 * so the subject's poll loop does not wait. settle() and settleInflight()
 * looked the global up when they ran, so their watchdog went through that
 * double too: \`check\` rescheduled itself through a timer that ran it
 * synchronously, 1159 times, until "Maximum call stack size exceeded" in the
 * arrangement (run 20260924T070812Z, pricing-service sendMail and
 * onUpdateSubscription, 36 sides). The row's double is the subject's; the
 * budget that bounds the row is ours and never goes through it.
 */
const HARNESS_SET_TIMEOUT = globalThis.setTimeout;
const HARNESS_CLEAR_TIMEOUT = globalThis.clearTimeout;
const HARNESS_SET_INTERVAL = globalThis.setInterval;
// The same for the wall clock. A row reads its own (see installRowClock); the
// budget that bounds the row, and ROW_SUBJECT_AT, which the parent's watchdog
// compares with ITS clock, are real time.
const HARNESS_DATE_NOW = Date.now;
function settle(p) {
  let timer;
  const began = HARNESS_DATE_NOW();
  const guard = new Promise((_, reject) => {
    const check = () => {
      const now = HARNESS_DATE_NOW();
      // D50: a pending subject import is bounded like the arrangement.
      const importing = ROW_SUBJECT_AT === null || SUBJECT_IMPORTS > 0;
      const left = importing ? began + IMPORT_BUDGET_MS - now : ROW_SUBJECT_AT + ROW_TIMEOUT_MS - now;
      if (left > 0) {
        // In the arrangement, look again soon: the subject's own budget starts
        // the moment it is called, and a long sleep here would miss that.
        timer = HARNESS_SET_TIMEOUT(check, importing ? Math.min(left, 250) : left);
        if (timer && typeof timer.unref === "function") timer.unref();
        return;
      }
      const e = new Error(
        ROW_SUBJECT_AT === null
          ? "row did not settle: its arrangement (imports, seeds, preconditions) took over " + IMPORT_BUDGET_MS + "ms"
          : SUBJECT_IMPORTS > 0
          ? "row did not settle in " + IMPORT_BUDGET_MS + "ms: the subject's own module import had not finished"
          : "row did not settle in " + ROW_TIMEOUT_MS + "ms"
      );
      e.name = "CharpilotRowTimeout";
      reject(e);
    };
    timer = HARNESS_SET_TIMEOUT(check, ROW_TIMEOUT_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([Promise.resolve(p), guard]).finally(() => HARNESS_CLEAR_TIMEOUT(timer));
}

/**
 * Every trip of the guard is logged before it throws, because the SDKs SWALLOW
 * it. @anthropic-ai/sdk catches the blocked \`https.request\`, retries, and
 * finally rethrows \`Error: Connection error.\` - which reaches the row looking
 * exactly like a service-level failure and would be written down as one. The
 * error a guard raises is not reliably the error a row sees; the log is.
 */
let EGRESS = [];
let JOURNAL_ENTRIES = [];
const blockedWrite = (what) => {
  const e = new Error(\`charpilot: \${what} refused - LIVE reads staging, it never writes to it\`);
  e.name = "CharpilotWriteRefused";
  return e;
};
const blocked = (what) => () => {
  rowPush(EGRESS, what);
  const e = new Error(\`charpilot: \${what} blocked by the recorder (default-deny)\`);
  e.name = "CharpilotEgressBlocked";
  throw e;
};

/**
 * THE TRANSPORT-LEVEL GUARD, applied once for the whole process.
 *
 * Mocking axios is not enough and mocking globalThis.fetch is not enough:
 * @anthropic-ai/sdk 0.39 ships its own node-fetch shim, openai 4.83 does the
 * same, and google-auth-library uses gaxios - all three end up in node's
 * http/https request, several layers below anything a module mock sees.
 *
 * This was found the hard way. A row whose proposal declared NO boundary for
 * the Anthropic client, with the placeholder credential from
 * doubles.apiKeyRow(), recorded
 *
 *     threw: 401 {"type":"error","error":{"type":"authentication_error", …}}
 *
 * in 2098ms - a real round trip to api.anthropic.com, which preflight lists as
 * default-deny. It cost nothing because the key was invalid; that is luck, not
 * a control. Every socket-level entry point is closed here so being wrong about
 * which client a provider uses can no longer put a request on the wire.
 *
 * It is a HOST allowlist, not a blanket ban, because the point of the exercise
 * is to run the real client against a stub: loopback is open, so a mountebank
 * imposter (test/helpers/mountebank.ts, reached via ANTHROPIC_BASE_URL /
 * OPENAI_BASE_URL / GOOGLE_OAUTH_TOKEN_URL) is a supported way to answer a
 * provider boundary. --allow-host adds to the list for a deliberate run.
 */
const ALLOWED_HOSTS = new Set(${JSON.stringify([
    ...ALLOW_HOSTS,
    // Derived from the ConfigMap, the defaults and the source. Live only - see
    // the note on ALLOW_HOSTS.
    ...(LIVE ? stagingAllowHosts().map((h) => String(h).trim()).filter(Boolean) : []),
    ...(LIVE ? LIVE_HOSTS : []),
    ...(LIVE_PROVIDERS ? PROVIDER_HOSTS : []),
  ])});
const LIVE_MODE = ${JSON.stringify(LIVE)};
/**
 * A LIVE RUN DOES NOT GATE OUTBOUND CALLS.
 *
 * The allowlist was assembled from the staging ConfigMap, a defaults list, and
 * a SCRAPE of the service's own source. Every host it fails to guess - a URL
 * built at runtime, a redirect, a provider added to config after the scrape -
 * costs a blocked row and a hand fix, per service. Onboarding a hundred repos
 * that way is a hundred fixes for a list that was only ever a guess.
 *
 * And it guards the wrong thing. A host named in the source is hardcoded into
 * the service, so production calls it too; what decides whether a call is safe
 * is the CREDENTIAL and the configuration beside it, which come from the
 * environment someone set up for this repo. A service that can do something
 * irreversible - send mail, charge a card - carries that risk in production and
 * owns its own override for it. A second allowlist in here cannot know which
 * host is which, and would drift from the environment that does.
 *
 * So: live is open, and the environment is the control. What stays is the one
 * gate that is credential-shaped rather than host-shaped - the database triple
 * in assertExpectedDb, which a wrong DSN defeats silently and a person cannot
 * eyeball.
 *
 * MOCKED is the opposite and must stay closed: a double is the whole point, and
 * a mocked run that reaches the internet is recording something else. Measured:
 * before this split, a mocked location-ms run called places.googleapis.com and
 * froze Google's reply to an unauthenticated request as the service's
 * behaviour.
 */
const EGRESS_OPEN = ${JSON.stringify(LIVE)};
function hostOf(...args) {
  for (const a of args) {
    if (!a) continue;
    let h = null;
    if (typeof a === "string") { try { h = new URL(a).hostname; } catch { h = a; } }
    else if (typeof URL !== "undefined" && a instanceof URL) h = a.hostname;
    else if (typeof a === "object") h = a.hostname ?? a.host ?? (a.url ? hostOf(a.url) : null);
    if (typeof h === "string" && h) return h.replace(/:\\d+$/, "").replace(/^\\[|\\]$/g, "");
  }
  return null;
}
// Suffix match, because Vertex is regional: us-central1-aiplatform.googleapis.com,
// europe-west4-aiplatform.googleapis.com, … all have to resolve from one entry.
const isAllowed = (h) => {
  if (!h) return false;
  // See EGRESS_OPEN: live defers to the environment, mocked refuses everything
  // the operator did not type.
  if (EGRESS_OPEN) return true;
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  for (const a of ALLOWED_HOSTS) if (h === a || h.endsWith("." + a) || h.endsWith("-" + a)) return true;
  return false;
};

/**
 * The DOWNSTREAM ledger: one entry per real request that left this process,
 * with what went out and what came back. This is the half of a live capture
 * that a mountebank imposter needs - the module-level observation gives the
 * parsed value a vi.mock can return, this gives the wire exchange a stub can
 * replay.
 */
let DOWNSTREAM = [];
const clip = (s, n = 4000) => (typeof s === "string" && s.length > n ? s.slice(0, n) + \`…[\${s.length} bytes]\` : s);

/**
 * A SPAN EXPORT IS NOT A BOUNDARY, and treating it as one voided every traced row.
 *
 * tracy-agent-be-ms wraps its service methods in \`@tracing()\`, which ends a span
 * on every call, and its \`SimpleSpanProcessor\` hands each span to a
 * \`ZipkinExporter\` at once - an \`http.request\` to staging's
 * \`jaeger-service.monitoring\`. The guard below refused it, pushed it onto
 * EGRESS, and a row with anything on EGRESS is not an observation. Run
 * 20260922T152300Z lost 61 live sides that way, and no answer an agent could
 * write would have reached them: the call is made by the SDK, not by the code
 * under test, and nothing it returns can reach the function's result.
 *
 * So, in a mocked run only, a request the OpenTelemetry EXPORTERS make is
 * answered here with an empty \`202\` and nothing leaves the process. It is
 * recognised by who made it - an \`@opentelemetry/exporter-*\` or
 * \`@opentelemetry/otlp-*\` frame on the stack - never by host, because the
 * collector's address is the service's own config. A live run is untouched:
 * its egress is open and the export goes where staging sends it.
 */
const TELEMETRY_EXPORTER = /[\\\\/]@opentelemetry[\\\\/](?:exporter-[^\\\\/]+|otlp-[^\\\\/]+)[\\\\/]/;
let TELEMETRY = 0;
function isTelemetryExport() {
  return TELEMETRY_EXPORTER.test(String(new Error().stack));
}
/** A request that is accepted and answered locally: \`202\`, no body. */
function sinkRequest(args) {
  const nodeRequire = createRequire(import.meta.url);
  const { EventEmitter } = nodeRequire("node:events");
  const { Readable } = nodeRequire("node:stream");
  const onResponse = args.find((a) => typeof a === "function");
  const req = new EventEmitter();
  let ended = false;
  req.write = () => true;
  req.setHeader = () => req;
  req.getHeader = () => undefined;
  req.removeHeader = () => {};
  req.setTimeout = () => req;
  req.setNoDelay = () => {};
  req.setSocketKeepAlive = () => {};
  req.flushHeaders = () => {};
  req.destroy = () => req;
  req.abort = () => {};
  req.end = (...a) => {
    if (ended) return req;
    ended = true;
    const done = a.find((x) => typeof x === "function");
    setImmediate(() => {
      const res = new Readable({ read() { this.push(null); } });
      res.statusCode = 202;
      res.statusMessage = "Accepted";
      res.headers = {};
      if (onResponse) onResponse(res);
      req.emit("response", res);
      if (done) done();
    });
    return req;
  };
  return req;
}

function guard(what, original, extract) {
  return function (...args) {
    const host = extract(...args);
    if (!isAllowed(host) && /request|get$/.test(what) && what !== "fetch" && isTelemetryExport()) {
      TELEMETRY += 1;
      return sinkRequest(args);
    }
    if (!isAllowed(host)) {
      rowPush(EGRESS, \`\${what} \${host ?? "unknown host"}\`);
      const e = new Error(\`charpilot: \${what} to \${host ?? "unknown host"} blocked by the recorder (default-deny)\`);
      e.name = "CharpilotEgressBlocked";
      throw e;
    }
    if (!LIVE_MODE || !/request|get$/.test(what)) return original.apply(this, args);

    // Live: let it through AND write down both halves.
    const opts = args.find((a) => a && typeof a === "object" && typeof a !== "function" && !(a instanceof URL)) ?? {};
    const entry = {
      transport: what,
      host,
      method: opts.method ?? (what.endsWith("get") ? "GET" : "POST"),
      path: opts.path ?? (typeof args[0] === "string" ? safePath(args[0]) : args[0] instanceof URL ? args[0].pathname : null),
      at: new Date().toISOString(),
    };
    rowPush(DOWNSTREAM, entry);
    const req = original.apply(this, args);
    try {
      const sent = [];
      const w = req.write.bind(req);
      req.write = (c, ...rest) => { if (c && typeof c !== "function") sent.push(Buffer.from(c)); return w(c, ...rest); };
      const e2 = req.end.bind(req);
      req.end = (c, ...rest) => {
        if (c && typeof c !== "function") sent.push(Buffer.from(c));
        if (sent.length) entry.requestBody = clip(Buffer.concat(sent).toString("utf8"));
        return e2(c, ...rest);
      };
      req.on("response", (res) => {
        entry.status = res.statusCode;
        entry.responseHeaders = res.headers;
        // The body is read with a passive 'data' listener. Node delivers to
        // every listener, so this does not starve the SDK's own reader - but
        // it DOES flip the stream into flowing mode, so it is only done in
        // live mode where the capture is the point.
        const buf = [];
        res.on("data", (d) => buf.push(Buffer.from(d)));
        res.on("end", () => { entry.responseBody = clip(Buffer.concat(buf).toString("utf8")); });
      });
    } catch { /* a client that does not expose write/end still gets recorded, just without bodies */ }
    return req;
  };
}
const safePath = (u) => { try { return new URL(u).pathname; } catch { return null; } };

function denyTransport() {
  const req = createRequire(import.meta.url);
  for (const name of ["http", "https"]) {
    const mod = req(\`node:\${name}\`);
    mod.request = guard(\`\${name}.request\`, mod.request, (a, b) => hostOf(a, b));
    mod.get = guard(\`\${name}.get\`, mod.get, (a, b) => hostOf(a, b));
  }
  const net = req("node:net");
  net.connect = guard("net.connect", net.connect, (a, b) => hostOf(a, typeof b === "string" ? b : null) ?? "localhost");
  net.createConnection = guard("net.createConnection", net.createConnection, (a, b) => hostOf(a, typeof b === "string" ? b : null) ?? "localhost");
  const tls = req("node:tls");
  tls.connect = guard("tls.connect", tls.connect, (a, b) => hostOf(a, typeof b === "string" ? b : null) ?? "localhost");
  const realFetch = globalThis.fetch;
  globalThis.fetch = guard("fetch", realFetch, (a) => hostOf(a));
}
denyTransport();

/**
 * A MODULE THAT SERVES ON IMPORT BINDS NOTHING HERE.
 *
 * nginx-redirecting-ms's \`src/index.ts\` ends in \`app.listen(port, cb)\` at
 * module scope, and two rows import it: each one \`vi.resetModules()\` and
 * then \`await import("/src/index")\` in the same worker. The first left a real
 * server on :4000 and the second \`listen\` died \`EADDRINUSE\` as an UNCAUGHT
 * exception - 103 tests passed, vitest exited 1 with "Errors 1", and the
 * suite was red in its own repo (run 20260924T054903Z). Across two workers it
 * collides the same way, whatever the rows do.
 *
 * So \`net.Server.prototype.listen\` - the one every http, https, http2 and
 * express server reaches - is held, in the recorder and in the committed test
 * alike (this is ROW_RUNTIME), in every mode: a characterization row calls
 * functions, nothing ever connects to a port a row opened, and a live
 * recording binding staging's port on the recording machine would only be a
 * second way to collide. What a held listen does, so the code around it still
 * runs:
 *
 *   - binds nothing, opens no handle, and leaks nothing into the next row;
 *   - writes the call on the row as \`serverListens\` (port or path), beside
 *     \`egressAttempts\`: an observation, NOT a boundary call, so the ledger the
 *     committed test asserts is the one the recording already holds;
 *   - emits \`listening\` on the next tick, which runs the listen CALLBACK -
 *     arms inside it stay coverable - inside the row's async scope;
 *   - answers \`address()\` with the host it was asked for, \`listening\`, and
 *     \`close(cb)\` as a server that is listening, then closed - and a second
 *     \`close(cb)\` passes ERR_SERVER_NOT_RUNNING, as node does.
 *
 * ONLY A FIXED PORT (or a pipe path) IS HELD. \`listen(0)\` / \`listen()\` asks
 * the kernel for an EPHEMERAL port, and two of those never collide - so there
 * is no EADDRINUSE to prevent, and it binds for real. That is what a
 * supertest-shaped row needs: it listens on 0, reads \`address().port\` and
 * sends a request there. Held, the port read back was 0 and the request went
 * to :80 (verifier, fix round 1). A fake ephemeral port instead would be a
 * port nothing is bound to - the request would fail just the same. The row
 * still writes \`{ port: 0 }\`, the port it ASKED for, so the observation stays
 * the same across runs; the servers bound this way are closed when the file
 * ends (\`releaseListen\`).
 *
 * AND IT NEVER OUTLIVES OUR FILES. Under \`--no-isolate\` or a vm pool one
 * worker runs the repo's own test files after ours, on the same
 * \`net.Server.prototype\`. So the hold is counted per file on the prototype
 * itself (shared by every realm in the worker), and \`afterAll(releaseListen)\`
 * puts the original back when the last of our files in that worker ends.
 */
let LISTENS = [];
const LISTEN_HOLD = Symbol.for("charpilot.listenHold");
function serverNotRunning() {
  const e = new Error("Server is not running.");
  e.code = "ERR_SERVER_NOT_RUNNING";
  return e;
}
function heldAddress(net, host, port) {
  if (typeof host !== "string" || !host) return { address: "::", family: "IPv6", port };
  if (host === "localhost") return { address: "127.0.0.1", family: "IPv4", port };
  return { address: host, family: net.isIPv6(host) ? "IPv6" : "IPv4", port };
}
function holdListen() {
  const net = createRequire(import.meta.url)("node:net");
  const proto = net.Server.prototype;
  const state = proto[LISTEN_HOLD];
  if (state && proto.listen === state.held) { state.holders += 1; return; }
  const original = proto.listen;
  const bound = new Set();
  const held = function listen(...args) {
    const server = this;
    const first = args[0];
    const opts = first && typeof first === "object" ? first : null;
    const numeric = (v) => (typeof v === "number" || (typeof v === "string" && /^\\d+$/.test(v)) ? Number(v) : null);
    const path = opts ? (typeof opts.path === "string" ? opts.path : null) : typeof first === "string" && numeric(first) === null ? first : null;
    const port = path ? null : numeric(opts ? opts.port : first) ?? 0;
    rowPush(LISTENS, path ? { path } : { port });
    // Ephemeral (or a handle / fd): nothing to collide with - a real bind.
    if (!path && !port) {
      bound.add(server);
      return original.apply(server, args);
    }
    const host = opts ? opts.host : typeof args[1] === "string" ? args[1] : null;
    const onListening = [...args].reverse().find((a) => typeof a === "function");
    let closed = false;
    const addr = path ?? heldAddress(net, host, port);
    Object.defineProperty(server, "listening", { configurable: true, get: () => !closed });
    server.address = () => (closed ? null : addr);
    server.close = function close(done) {
      const wasListening = !closed;
      closed = true;
      process.nextTick(() => {
        server.emit("close");
        if (typeof done === "function") done(wasListening ? undefined : serverNotRunning());
      });
      return server;
    };
    if (onListening) server.once("listening", onListening);
    process.nextTick(() => server.emit("listening"));
    return server;
  };
  held.charpilotHeld = true;
  proto[LISTEN_HOLD] = { held, original, bound, holders: 1 };
  proto.listen = held;
}
function releaseListen() {
  const proto = createRequire(import.meta.url)("node:net").Server.prototype;
  const state = proto[LISTEN_HOLD];
  if (!state) return;
  state.holders -= 1;
  if (state.holders > 0) return;
  if (proto.listen === state.held) proto.listen = state.original;
  delete proto[LISTEN_HOLD];
  for (const server of state.bound) {
    try { if (server.listening) server.close(); } catch { /* already gone */ }
  }
}
holdListen();
afterAll(releaseListen);

/**
 * Nothing leaves this process, and nothing touches a database, unless a
 * proposal says so. Anything blocked here raises a marked error, which the row
 * classifies as a HARNESS failure rather than writing it down as behaviour.
 */
/** The mocked run's database deny proxy, for installSeedDouble. Set by denyEgress. */
let DB_DENY = null;
/**
 * A SECOND CLIENT IS DENIED UNDER ITS OWN NAME. qode-ptp-ms's client module
 * exports \`prisma\` and \`prismaLightWeightReadOnly\`, both \`new PrismaClient()\`,
 * so in a mocked run both are this deny, and the deny called every client
 * \`prisma\`. A row that answered \`prisma\` and not the read-only client
 * (late September 2026, startAiInterviewV2's background callback, reached
 * through getOrganizationIdByAiInterviewerId's
 * \`prismaLightWeightReadOnly.$queryRaw\`) died "blocked egress:
 * prisma.$queryRaw - \`prisma\` was declared AND installed ... a binding
 * failure", and 4 sides were ruled pipeline_defect for a boundary the row
 * never declared. An export of a client module that is the deny is now the
 * deny named after that export, so the blocked call names the client that
 * made it; \`prisma\`, \`db\` and \`default\` keep the name they had.
 */
let DENY_AS = null;
let DENIED_AS = new Map();
function namedDeny(label) {
  if (!DENY_AS) return DB_DENY;
  if (!DENIED_AS.has(label)) DENIED_AS.set(label, DENY_AS(label));
  return DENIED_AS.get(label);
}
function nameDenied(out) {
  if (DB_DENY === null) return out;
  for (const k of Object.keys(out)) if (!["prisma", "db", "default"].includes(k) && out[k] === DB_DENY) out[k] = namedDeny(k);
  return out;
}
/**
 * TOOL BACKLOG (verifier finding on 648012d): THE DENY COVERS require() TOO.
 *
 * vi.doMock intercepts ESM imports through vite. A CJS require() goes through
 * node's own loader and never sees it, so \`new (require('@prisma/client')
 * .PrismaClient)()\` in a build - or process.getBuiltinModule('module')
 * .createRequire(...)('@prisma/client'), or require() of the repo's client
 * file, which node 24 loads as TypeScript by itself - reached the REAL client
 * in a mocked run, whose DATABASE_URL is staging's whenever out/staging.env
 * exists. The verifier's probe logged \`new PrismaClient() | PrismaClient
 * company.deleteMany\`.
 *
 * So in a mocked run Module._load is wrapped, once: \`@prisma/client\` comes
 * back with its PrismaClient building the row's deny (or the seeded double
 * over it), and any request that RESOLVES to a client module's file comes
 * back as that client module (dbModule). Every require() funnels through
 * Module._load - createRequire's included - so there is no second door.
 * Everything else loads as it did.
 */
function cjsDb() {
  return SEEDED.size ? seededClient(DB_DENY) : DB_DENY;
}
let REQUIRE_DENIED = false;
// A resolved file of the Prisma client package or of its generated client -
// \`@prisma/client/index.js\`, \`.prisma/client/default.js\` and every other
// entry - whatever request string reached it (verifier finding on a059b08:
// the exact-string match was bypassed three ways).
const PRISMA_FILE = /[\\\\/](?:@prisma[\\\\/]client|\\.prisma[\\\\/]client)[\\\\/]/;
const DENIED_EXPORTS = new WeakSet();
function prismaFacade(real) {
  if (real === null || (typeof real !== "object" && typeof real !== "function")) return real;
  if (DENIED_EXPORTS.has(real)) return real;
  const facade = { ...real, PrismaClient: clientClass(real.PrismaClient, cjsDb) };
  if (real.default && typeof real.default === "object" && "PrismaClient" in real.default) {
    facade.default = { ...real.default, PrismaClient: facade.PrismaClient };
  }
  DENIED_EXPORTS.add(facade);
  return facade;
}
/**
 * The real module is never left reachable: every cached entry of a Prisma
 * client file has its exports replaced by the denying facade, so
 * \`require.cache[require.resolve('@prisma/client')].exports\` reads the deny too.
 * Swept whenever this runtime loads one (Module._load, the mock factories) and
 * once more before each subject call.
 */
function sweepRequireCache() {
  if (LIVE_MODE) return;
  const Module = createRequire(import.meta.url)("node:module");
  for (const [file, mod] of Object.entries(Module._cache ?? {})) {
    if (!mod || !PRISMA_FILE.test(file)) continue;
    try { mod.exports = prismaFacade(mod.exports); } catch { /* a frozen entry keeps what it had */ }
  }
}
function denyRequire() {
  if (LIVE_MODE || REQUIRE_DENIED) return;
  REQUIRE_DENIED = true;
  const Module = createRequire(import.meta.url)("node:module");
  const realLoad = Module._load;
  const bare = (f) => String(f).replace(/\\.(c|m)?[jt]sx?$/, "").replace(/\\/index$/, "");
  Module._load = function (request, parent, isMain) {
    let file = null;
    try { file = Module._resolveFilename(request, parent, isMain); } catch { /* the real load reports it */ }
    if (request === "@prisma/client" || (file && PRISMA_FILE.test(file))) {
      const real = realLoad.apply(this, arguments);
      const facade = prismaFacade(real);
      if (file && Module._cache[file]) Module._cache[file].exports = facade;
      return facade;
    }
    if (file && DB_CLIENT_FILES.has(bare(file))) return dbModule(cjsDb());
    return realLoad.apply(this, arguments);
  };
}

/**
 * A require() OF THE REPO'S OWN TYPESCRIPT resolves and loads as the build's
 * would, in the recording and in the emitted suite alike.
 *
 * contact-ms's entry file (late September 2026) mounts its routers with
 * require("./routes/api/healthz") from server.ts. The build compiles both to
 * .js, where node finds routes/api/healthz/index.js; under vitest the call goes
 * to node's own loader, which probes no .ts extension and no index.ts, so the
 * row died "Cannot find module './routes/api/healthz'" before line 9 - the
 * port default the row was aimed at - ran. That is the harness failing to
 * load the service, and it was ruled a pipeline_defect.
 *
 * Two parts, both only for a file outside node_modules:
 *   - RESOLUTION. When node's own lookup fails, the request is tried with the
 *     TypeScript extensions and as a directory's index, from the requiring
 *     file's directory - what the compiled tree would hold.
 *   - LOADING. node 24 strips types from a .ts it loads but does not compile
 *     one: a file with import statements is read as ESM, its extensionless
 *     imports do not resolve and its module.exports is not defined. So the
 *     repo's .ts is compiled to CommonJS with the repo's own typescript, as
 *     tsc would. A file node_modules owns keeps node's own handler.
 *
 * What such a require loads is the repo's code as node runs it: the row's
 * module mocks are vite's and do not apply to it, and the database guard
 * below still does, because it resolves through this same lookup.
 *
 * PATH ALIASES resolve as the build's do (D41). tracy-agent-be-ms (late
 * September 2026) imports its client as import { prisma } from "@/prisma",
 * mapped by tsconfig.json's compilerOptions.paths to ./prisma/client, and its
 * build runs with tsconfig-paths/register. A row that reached
 * sourcing.service.ts through require() had it compiled to CommonJS here, its
 * require("@/prisma") went to node's own loader, which reads no tsconfig, and
 * 26 sides died "Cannot find module '@/prisma'" - a pipeline_defect. So a bare
 * request node cannot find, from a file outside node_modules, is mapped by the
 * nearest tsconfig.json above that file (its "extends" followed): the longest
 * matching "paths" pattern, each of its substitutions in order, then
 * "baseUrl" - TypeScript's own order - and each candidate goes through the
 * same .ts / index lookup. A package node finds is never re-mapped: this runs
 * only after node's lookup has failed. The same tsconfig's
 * experimentalDecorators and emitDecoratorMetadata reach the compile below:
 * without them the repo's legacy method decorators ran as standard ones and
 * died reading descriptor.value of undefined.
 *
 * A require() an invoke.build writes of a repo module does not come here at
 * all: it is served through vite (repoRequires, charpilotRepoRequire).
 */
const TS_REQUIRE_EXTS = [".ts", ".tsx", ".cts"];
let TS_REQUIRE_INSTALLED = false;
function requireTypeScript() {
  if (TS_REQUIRE_INSTALLED) return;
  TS_REQUIRE_INSTALLED = true;
  const req = createRequire(import.meta.url);
  const Module = req("node:module");
  const fs = req("node:fs");
  const path = req("node:path");
  const own = (f) => typeof f === "string" && path.isAbsolute(f) && !f.split(path.sep).includes("node_modules");
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  const tsFor = (base) => {
    for (const e of TS_REQUIRE_EXTS) if (isFile(base + e)) return base + e;
    for (const e of TS_REQUIRE_EXTS) if (isFile(path.join(base, "index" + e))) return path.join(base, "index" + e);
    return null;
  };
  const compilers = new Map();
  const compilerFor = (filename) => {
    const dir = path.dirname(filename);
    if (!compilers.has(dir)) {
      let ts = null;
      try { ts = createRequire(filename)("typescript"); } catch { ts = null; }
      compilers.set(dir, ts);
    }
    return compilers.get(dir);
  };
  const realResolve = Module._resolveFilename;
  // Set while a tsconfig's package "extends" is looked up, so that lookup is
  // node's own and never re-enters the alias mapping below.
  let readingConfig = false;
  const extendsFile = (spec, from) => {
    if (spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)) {
      const p = path.resolve(path.dirname(from), spec);
      return isFile(p) ? p : isFile(p + ".json") ? p + ".json" : null;
    }
    readingConfig = true;
    try {
      for (const s of [spec, spec + ".json", spec + "/tsconfig.json"]) {
        try { const p = createRequire(from).resolve(s); if (p.endsWith(".json")) return p; } catch { /* the next spelling */ }
      }
      return null;
    } finally {
      readingConfig = false;
    }
  };
  // One tsconfig as the compiler reads it: what it extends first, its own
  // options over them. "paths" resolve against baseUrl when there is one,
  // else against the directory of the config that set them.
  const FLAGS = ["experimentalDecorators", "emitDecoratorMetadata"];
  const readTsconfig = (file, stack) => {
    if (stack.includes(file)) return null;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
    const ts = compilerFor(file);
    let cfg = null;
    try { cfg = ts && typeof ts.parseConfigFileTextToJson === "function" ? ts.parseConfigFileTextToJson(file, text).config : JSON.parse(text); } catch { cfg = null; }
    if (!cfg || typeof cfg !== "object") return null;
    let out = { paths: null, pathsBase: null, baseUrl: null, flags: {} };
    for (const ext of [].concat(cfg.extends ?? [])) {
      const parent = typeof ext === "string" ? extendsFile(ext, file) : null;
      const got = parent ? readTsconfig(parent, [...stack, file]) : null;
      if (!got) continue;
      out = { paths: got.paths ?? out.paths, pathsBase: got.paths ? got.pathsBase : out.pathsBase, baseUrl: got.baseUrl ?? out.baseUrl, flags: { ...out.flags, ...got.flags } };
    }
    const co = cfg.compilerOptions && typeof cfg.compilerOptions === "object" ? cfg.compilerOptions : {};
    if (typeof co.baseUrl === "string") out.baseUrl = path.resolve(path.dirname(file), co.baseUrl);
    if (co.paths && typeof co.paths === "object") { out.paths = co.paths; out.pathsBase = path.dirname(file); }
    for (const f of FLAGS) if (typeof co[f] === "boolean") out.flags = { ...out.flags, [f]: co[f] };
    return out;
  };
  const tsconfigs = new Map();
  const tsconfigAbove = (dir) => {
    const seen = [];
    let found = null;
    for (let d = dir; ; d = path.dirname(d)) {
      if (tsconfigs.has(d)) { found = tsconfigs.get(d); break; }
      seen.push(d);
      const file = path.join(d, "tsconfig.json");
      if (isFile(file)) { found = readTsconfig(file, []); break; }
      if (path.dirname(d) === d) break;
    }
    for (const d of seen) tsconfigs.set(d, found);
    return found;
  };
  // The files a bare request can mean under that tsconfig, in the order the
  // compiler tries them.
  const aliasCandidates = (request, cfg) => {
    const out = [];
    if (cfg.paths) {
      let best = null, bestLen = -1, captured = "";
      for (const [pattern, subs] of Object.entries(cfg.paths)) {
        if (!Array.isArray(subs)) continue;
        const star = pattern.indexOf("*");
        if (star < 0) {
          if (pattern === request) { best = subs; bestLen = Infinity; captured = ""; }
          continue;
        }
        const pre = pattern.slice(0, star), post = pattern.slice(star + 1);
        if (pre.length > bestLen && request.length >= pre.length + post.length && request.startsWith(pre) && request.endsWith(post)) {
          best = subs; bestLen = pre.length; captured = request.slice(pre.length, request.length - post.length);
        }
      }
      const base = cfg.baseUrl ?? cfg.pathsBase;
      for (const sub of best ?? []) if (typeof sub === "string") out.push(path.resolve(base, sub.replace("*", captured)));
    }
    if (cfg.baseUrl) out.push(path.resolve(cfg.baseUrl, request));
    return out;
  };
  const fileFor = (abs, self, parent, rest) => {
    try { return realResolve.call(self, abs, parent, ...rest); } catch { return tsFor(abs); }
  };
  Module._resolveFilename = function (request, parent, ...rest) {
    try {
      return realResolve.call(this, request, parent, ...rest);
    } catch (err) {
      const from = parent && parent.filename;
      if (!err || err.code !== "MODULE_NOT_FOUND" || typeof request !== "string" || !own(from) || readingConfig) throw err;
      const pathLike = request.startsWith("./") || request.startsWith("../") || path.isAbsolute(request);
      if (pathLike) {
        const found = tsFor(path.resolve(path.dirname(from), request));
        if (found) return found;
        throw err;
      }
      if (request.startsWith("node:")) throw err;
      const cfg = tsconfigAbove(path.dirname(from));
      for (const candidate of cfg ? aliasCandidates(request, cfg) : []) {
        const found = fileFor(candidate, this, parent, rest);
        if (found) return found;
      }
      throw err;
    }
  };
  for (const ext of TS_REQUIRE_EXTS) {
    const prior = Module._extensions[ext];
    Module._extensions[ext] = function (module, filename) {
      const ts = own(filename) ? compilerFor(filename) : null;
      if (!ts) {
        if (prior) return prior.call(this, module, filename);
        throw new Error("charpilot: cannot load " + filename + " - no typescript is installed beside it to compile it");
      }
      const out = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        fileName: filename,
        compilerOptions: {
          ...(tsconfigAbove(path.dirname(filename))?.flags ?? {}),
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
          jsx: ts.JsxEmit.ReactJSX,
          sourceMap: false,
          inlineSourceMap: false,
        },
      });
      module._compile(out.outputText, filename);
    };
  }
}

function denyEgress() {
  requireTypeScript();
  denyRequire();
  sweepRequireCache();
  // axios is deliberately NOT module-mocked any more. It used to be, and the
  // replacement namespace did not survive vite's ESM interop: four slack rows
  // recorded
  //     threw TypeError: __vite_ssr_import_1__.default.post is not a function
  // as if that were the service's behaviour. It was the mock's shape. axios
  // goes through http/https.request like everything else, so the transport
  // guard already stops it - and leaving the real module in place keeps
  // isAxiosError, create and defaults working, which the slack paths branch on.

  // Each client export is denied under its OWN name (see namedDeny).
  const denyAs = (label) => {
  const dbDeny = new Proxy(
    {},
    {
      get: (_t, model) => {
        if (model === "then" || model === Symbol.toStringTag) return undefined;
        if (model === "$transaction") return async (arg) => (typeof arg === "function" ? arg(dbDeny) : Promise.all(arg));
        // A CLIENT'S OWN SET-UP IS NOT EGRESS (D30). sourcing-ms's client
        // module (a submodule, prisma/client.ts) runs
        //     const base = new PrismaClient({..}); export const prisma = base.$extends(softDelete)
        // at load. \`new PrismaClient()\` is this deny, so \`$extends\` hit the
        // \`$\` rule below and pushed "prisma.$extends" onto EGRESS while the
        // row's own answer for \`prisma\` was being built over the real module:
        // 35 sides ruled "declared AND installed ... reached the default-deny
        // anyway", with the answer installed and never the problem. None of
        // these touch a database: \`$extends\` answers the same deny (an
        // extension of a client with no database is that client - every query
        // still reaches the deny), \`$connect\`/\`$disconnect\` resolve
        // \`undefined\` as they do, \`$on\`/\`$use\` register nothing. Raw SQL and
        // every model call stay blocked.
        if (model === "$extends") return () => dbDeny;
        if (model === "$connect" || model === "$disconnect") return async () => undefined;
        if (model === "$on" || model === "$use") return () => undefined;
        // A CLIENT-LEVEL method is called on the client, not on a model, so it
        // must deny as a FUNCTION. This trap returned the model proxy - an
        // object - for every \`$\`-prefixed key, so \`prisma.$queryRaw(sql)\` threw
        //     TypeError: __vite_ssr_import_2__.prisma.$queryRaw is not a function
        // which matches no harness test, pushes nothing onto EGRESS, and was
        // written into \`threw\` as the SERVICE'S contract. It is the stub's
        // shape. Measured on qode-ptp-ms:
        // slice3-fetchUniqueValuesFromJsonArray-no-paging-arguments recorded
        // that TypeError with its claim verdicted "verified", because the arm
        // really did move on the way to the call - so the claim half passed
        // while the value half was an artifact of this proxy.
        if (typeof model === "string" && model.startsWith("$")) return blocked(\`\${label}.\${model}\`);
        return new Proxy({}, { get: () => blocked(\`\${label}.\${String(model)}\`) });
      },
    }
  );
  return dbDeny;
  };
  const dbDeny = (DB_DENY = denyAs("prisma"));
  DENY_AS = denyAs;
  DENIED_AS = new Map();
  // In a live run the database is the whole point: staging's env carries no
  // provider keys, so the credential a real provider call needs comes from a
  // real api_key row. The deny stays for a mocked run.
  // MOCKED: the client module is REPLACED, never imported. Every export of it
  // is the deny - not only prisma/db/default - so a second client the module
  // also exports (qode-ptp-ms's prismaLightWeightReadOnly, a \`prismaRo\`) is
  // denied too instead of being undefined or, through a spread of the real
  // module, real. And \`new PrismaClient()\` from the package itself - a
  // client module the scan could not resolve, a relative one, a service that
  // builds its own - gets the deny as well. Without that, a mocked run with
  // out/staging.env beside it has staging's DSN in DATABASE_URL and a real
  // client that can write to it; the transport guard does not see the query
  // engine's own socket. The package's other exports (enums, the Prisma
  // namespace) stay real.
  if (!LIVE_MODE) {
    for (const m of DB_CLIENT_MODULES) mock(m, () => dbModule(dbDeny));
    mock("@prisma/client", async (io) => {
      const orig = await io();
      sweepRequireCache();
      return { ...orig, PrismaClient: clientClass(orig?.PrismaClient, () => dbDeny) };
    });
  }
  else {
    // LIVE: real staging, writes allowed and JOURNALLED. Each mutation records
    // what it takes to undo it - a created id to delete, or the rows as they
    // were before an update or delete - and journal.mjs replays it in reverse
    // afterwards. Anything whose undo cannot be determined is still refused,
    // because an irreversible write to a shared environment is not worth a
    // recorded pair.
    const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|queryRaw)/;
    const wrapModel = (model, real) =>
      new Proxy(real, {
        get: (t, op) => {
          const v = t[op];
          if (typeof op === "string" && WRITES.test(op)) {
            return async (...args) => {
              const where = args[0] && typeof args[0] === "object" ? args[0].where : undefined;
              // Read the BEFORE state first, or the undo has nothing to restore.
              let before = null;
              if (/^(update|upsert|delete)/.test(op) && where && typeof t.findMany === "function") {
                try { before = await t.findMany({ where }); } catch { before = null; }
                if (before === null) {
                  rowPush(CALLS, { symbol: \`prisma.\${String(model)}.\${op}\`, args: Array.from(args, (a) => snap(a)), refusedWrite: "before-state unreadable" });
                  throw blockedWrite(\`prisma.\${String(model)}.\${op}\` + " - its previous state could not be read, so it could not be undone");
                }
              }
              const result = await v.apply(t, args);
              const created = /^create/.test(op) ? (Array.isArray(result) ? result : [result]).map((r) => r && r.id).filter(Boolean) : [];
              JOURNAL_ENTRIES.push({ model: String(model), op, where: where ?? null, before, created, at: new Date().toISOString() });
              rowPush(CALLS, { symbol: \`prisma.\${String(model)}.\${op}\`, args: Array.from(args, (a) => snap(a)), journalled: true });
              return result;
            };
          }
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
    mock("@/prisma/client", async (io) => {
      const real = await io();
      const client = real.prisma ?? real.default;
      const guarded = new Proxy(client, {
        get: (t, k) => {
          const v = t[k];
          if (typeof k === "string" && k.startsWith("$")) {
            if (k === "$transaction") {
              return async (arg) =>
                typeof arg === "function" ? arg(guarded) : Promise.reject(blockedWrite("prisma.$transaction([])"));
            }
            if (k === "$executeRaw" || k === "$executeRawUnsafe") {
              // Raw SQL has no derivable undo - no where clause to read a
              // before-state from - so it stays refused even in write mode.
              return () => Promise.reject(blockedWrite(\`prisma.\${k}\` + " - raw SQL has no derivable undo"));
            }
          }
          if (v && typeof v === "object" && !Array.isArray(v)) return wrapModel(k, v);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return { ...real, prisma: guarded, default: guarded };
    });
  }
  mock("ioredis", () => ({ default: blocked("new Redis()") }));
  // node-redis gets the same default-deny (D34). Its real client dials
  // redis://localhost:6379, which the transport guard lets through as loopback,
  // so a row the policy did not answer it for is refused here instead. The
  // package's other exports stay real.
  for (const m of ${JSON.stringify(NODE_REDIS_SPECIFIERS)}) {
    mock(m, async (io) => {
      let orig = {};
      try { orig = await io(); } catch { /* not installed: nothing imports it */ }
      return { ...orig, createClient: blocked(\`\${m} createClient()\`) };
    });
  }
}

/**
 * vi.resetModules() clears the module registry but NOT the mock registry, so
 * without this every row inherits every mock the rows before it registered.
 * That is not a small leak: a row that declares no boundary at all would still
 * see the previous row's getApiKey answer, and the pair would describe a state
 * no proposal asked for. Recorded once and never noticed is exactly how this
 * pilot's earlier wrong numbers happened, so mocks are torn down by path.
 */
const MOCKED = new Set();
/**
 * D52: A MOCK A PROPOSAL'S OWN CODE REGISTERS IS TORN DOWN WITH THE ROW TOO.
 *
 * MOCKED held only what \`mock()\` below registered, the declared boundaries.
 * An invoke.build, an arg's build or a setup call is proposal code inlined
 * into the row, and it may call vi.doMock itself. qode-itl-be, September 26:
 * get-229-cond-expr-0 drives a helper inside candidates.pool.e2e.ts by
 * mocking \`vitest\`, \`@prisma/client\`, \`pg\` and
 * \`src/modules/candidates/candidates.repository.ts\` (as a namespace holding
 * only CandidatesRepository) from its build. unmockAll never saw those paths,
 * so the row after it in the chunk, resolveActingQodeAlias-716-if-0, imported
 * feed.service.ts under that repository mock and died in arrangement with
 * \`No "PROFILE_STATUS_STAGES" export is defined on the ".../candidates.repository.ts"
 * mock\` - one side ruled pipeline_defect. The same row records \`null\` alone.
 * Which row failed depended on which row ran before it.
 *
 * So every vi.doMock / vi.mock made while this file runs is added to MOCKED,
 * whoever makes it. Installed once per vi (a worker that runs several files
 * shares it) and pointed at the running file's MOCKED; the arguments go to
 * vitest unchanged.
 */
const VI_MOCK_SINK = Symbol.for("charpilot.vi-mock-sink");
if (!vi[VI_MOCK_SINK]) {
  const sink = { set: MOCKED };
  for (const name of ["doMock", "mock"]) {
    const real = vi[name];
    vi[name] = function (path, factory) {
      if (typeof path === "string") sink.set.add(path);
      return real.call(this, path, factory);
    };
  }
  vi[VI_MOCK_SINK] = sink;
}
vi[VI_MOCK_SINK].set = MOCKED;
/**
 * A GLOBAL is not a module, and vi.doMock("globalThis", ...) is ACCEPTED AND
 * INERT: registration does not throw, unmock does not throw, and nothing ever
 * imports "globalThis" so the factory never runs. The transport guard then
 * stays installed and the row dies with blocked egress - which is exactly
 * what 5 location-ms rows did while their proposals correctly declared fetch.
 * An answer that is accepted and does nothing is worse than one that is refused.
 *
 * So a globalThis boundary is assigned, and restored per row.
 */
// A DI container reads parameter metadata that only exists once this is
// imported, and vitest.record.config.mts sets setupFiles: [] so nothing else
// pulls it in. Optional on purpose: a repo without the dependency must not fail
// to record because of a polyfill it never needed.
try {
  await import("reflect-metadata");
} catch {
  // Not installed here, which is fine - nothing in this target uses decorators
  // that read metadata.
}

/**
 * Modules whose real version could not be loaded, so the replacement is all
 * there is. Reported per row: the other exports of that module are missing, and
 * a later failure on one of them should not read as service behaviour.
 */
let MOCK_FALLBACKS = [];

/**
 * D29: A MODULE THAT COULD NOT BE LOADED STILL HAS ITS OTHER EXPORTS, AS
 * STAND-INS THAT REFUSE TO BE USED.
 *
 * qode-ptp-ms, mocked, September 2026: 55 sides were lost to three messages
 * with one cause. Each row declared a boundary on a module whose real import
 * THROWS in a mocked run - \`@/lib/server/services/fileStorage\` and
 * \`.../unified/unifiedMapper\` both reach awsAuthProcessor, which builds an
 * S3Client at load, and with AWS_REGION empty the SDK throws "Region is
 * missing". The factory's fallback then handed vitest a namespace holding
 * ONLY the declared names, so:
 *
 *   - \`const _MAPPERS_REFERENCED = [toAtsApplication, toAtsCandidate, toAtsJob]\`
 *     at unifiedProcessor's module scope merely READ a sibling and died
 *     \`No "toAtsJob" export is defined on the ... mock\` (12 sides);
 *   - the declared export lost its shape too: applyMock was handed
 *     \`real === undefined\`, took the object branch, and
 *     \`getFileStorageInstance\` answered \`returns { readFileAsString }\` BECAME
 *     that object, so \`getFileStorageInstance()\` threw "is not a function"
 *     (41 sides).
 *
 * The real module is still NOT loaded here - it cannot be - and nothing is
 * invented in its place. Each export the row did not declare is a stand-in
 * that may be HELD (imported, put in an array, re-exported, compared by
 * identity), and that throws \`CharpilotModuleUnloaded\` the moment it is
 * called, constructed or has a member read. That error is always a harness
 * failure, and a use the subject caught and swallowed is still reported
 * (UNLOADED_USES), so a row can never record a path the stand-in steered.
 * The declared exports are given the stand-in as their \`real\`, which tells
 * applyMock the shape is UNKNOWN rather than "not a function".
 *
 * D26 has since stood in AWS_REGION, so on that repo those modules now load.
 * This is for the next module whose import throws for a reason the stand-ins
 * do not cover.
 */
const UNLOADED_STANDINS = new WeakSet();
let UNLOADED_USES = [];
function unloadedError(module, name, use, why) {
  const e = new Error(
    \`charpilot: "\${name}" of \${module} was \${use}, but the real module could not be loaded in this run (\${String(why).slice(0, 160)}), so the export does not exist here - declare an answer for "\${name}", or make the module loadable\`
  );
  e.name = "CharpilotModuleUnloaded";
  return e;
}
// Reads that are the runtime inspecting a value, not the program using it.
const UNLOADED_INERT_READS = new Set(["then", "toJSON", "asymmetricMatch", "$$typeof", "nodeType", "_isMockFunction", "__esModule", "constructor"]);
function unloadedExport(module, name, why) {
  const refuse = (use) => {
    UNLOADED_USES.push(\`\${module}#\${name} \${use}\`);
    return unloadedError(module, name, use, why);
  };
  const standin = new Proxy(function () {}, {
    get: (t, k) => {
      if (typeof k === "symbol" || UNLOADED_INERT_READS.has(k)) return undefined;
      if (k === "name") return String(name);
      throw refuse(\`read (.\${String(k)})\`);
    },
    apply: () => {
      throw refuse("called");
    },
    construct: () => {
      throw refuse("constructed");
    },
  });
  UNLOADED_STANDINS.add(standin);
  return standin;
}
function unloadedModule(module, why, declared) {
  const made = new Map();
  const standinFor = (k) => {
    if (!made.has(k)) made.set(k, unloadedExport(module, k, why));
    return made.get(k);
  };
  // \`__esModule\` and \`then\` are never exports: answering either would make
  // the namespace look like a CJS interop wrapper or a thenable.
  const isExportName = (k) => typeof k === "string" && k !== "then" && k !== "__esModule";
  return new Proxy(declared, {
    get: (t, k) => (k in t ? t[k] : isExportName(k) ? standinFor(k) : undefined),
    has: (t, k) => k in t || isExportName(k),
  });
}
/**
 * Config answers that overlayConfig completed from the real config, by symbol
 * and the NAMES of the fields it filled - never their values. Reported per row
 * as \`configOverlays\`, so a reader can see a row ran on fields it did not set.
 */
let CONFIG_OVERLAYS = [];

const STUBBED_GLOBALS = new Map();
function mock(path, factory) {
  if (path === "globalThis" || path.startsWith("globalThis.")) {
    const name = path === "globalThis" ? undefined : path.slice("globalThis.".length);
    return { needsName: !name, name };
  }
  MOCKED.add(path);
  vi.doMock(path, factory);
}
function stubGlobal(name, value) {
  if (!STUBBED_GLOBALS.has(name)) STUBBED_GLOBALS.set(name, { had: name in globalThis, prev: globalThis[name] });
  globalThis[name] = value;
}
function unstubGlobals() {
  for (const [name, { had, prev }] of STUBBED_GLOBALS) {
    if (had) globalThis[name] = prev;
    else delete globalThis[name];
  }
  STUBBED_GLOBALS.clear();
}
/**
 * D37: MATH.RANDOM IS SEEDED PER ROW, THE SAME IN THE RECORDING AND THE REPLAY.
 *
 * email-centralization-ms, September 2026: getRandomEmailSender-803-if-0-else
 * returns emailSenders[Math.floor(Math.random() * 3)]. It recorded
 * "sender3@qode.world", both determinism observations happened to agree (a
 * one-in-three chance, so the row was stamped stable), and the replay under
 * the repo's own config came back "sender1@qode.world" - red, then green on
 * cigate's re-check, and the run failed on a config gap that was a die roll.
 * Each row body installs a generator seeded by its own id before anything it
 * imports runs and puts the real one back when it ends; the recorder and the
 * emitted test are the same text, so they draw the same numbers in the same
 * order. A proposal that stubs Math.random itself still wins: it does so after.
 */
const REAL_MATH_RANDOM = Math.random;
function seededRandom(seedText) {
  let h = 2166136261;
  for (const ch of String(seedText)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let s = h >>> 0;
  // mulberry32
  return function random() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * D49: A ROW READS ITS OWN CLOCK, THE SAME RECORDED AND REPLAYED.
 *
 * sourcing-ms, September 2026: _executeBulkCreates and
 * _updateProfilesForEnrichmentBulk return a timing breakdown,
 * { parentTablesMs, childTablesMs, totalMs }, each one Date.now() minus an
 * earlier Date.now(). Over mocked prisma those are 0, 1 or 2 milliseconds,
 * depending on how busy the machine was. When the determinism check's two
 * observations happened to agree the row was stamped stable (and a row that
 * was never compared was not checked at all), so the leaf was asserted
 * exactly. The replay then read 1 where 0 was recorded. Between 10 and 22 of
 * the 101 emitted tests for the two functions failed on each run, a different
 * set every time, and cigate withheld them as red in the repo's own CI.
 *
 * So a row's Date.now() and performance.now() come from a clock of its own.
 * It starts at the real time when the row starts, so a timestamp the subject
 * compares with a real Date is still close to one. Each read moves it on by
 * 1ms, so a busy loop that waits for the clock still ends, and an elapsed time
 * is the number of reads in between. A timer the row sets moves the clock to
 * its due time when it fires, so a deadline loop that sleeps between reads
 * gives up after as many sleeps as it would in real time. The recorder and
 * the emitted test are the same text and make the same reads in the same
 * order, so they get the same numbers.
 *
 * Only the row's own work reads this clock. A read from outside the row's
 * async context (the harness, an earlier row's leftover timer), or one the
 * test runner makes itself (see readByRunner), gets real time and does not
 * move the row's clock.
 *
 * process.hrtime and the promise timers of node:timers/promises are not
 * covered. A proposal that stubs a clock or a timer itself still wins: a
 * global it replaced is left alone, and vi.useFakeTimers comes later.
 *
 * D63: A ROW'S CLOCK STARTS WHERE ITS RECORDING'S DID, AND new Date() READS IT.
 *
 * qode-itl-be, 26-27 September 2026: resolveSweepWindow-654-if-0_661-cond-expr-1
 * and resolveSweepWindow-661-cond-expr-0 return
 * { runOn: dayKey(new Date()), windowStart, windowEnd }. Recorded on the 26th,
 * both determinism observations agreed (same day), so runOn was asserted
 * exactly; the next day the emitted tests failed on
 *   expected { runOn: '2026-09-27', …(2) } to deeply equal { runOn: '2026-09-26', …(2) }
 * and the full re-measure stopped at stage 6 on "the suite under measurement
 * did not pass". Everything above ran on a clock that started at the REAL
 * time, and new Date() was left real outright, so any value a subject derives
 * from "now" at a coarser grain than the determinism check can see - a day, a
 * week, an hour - was a literal of the recording day. Every characterization
 * suite delivered to a service's PR goes red in its CI on a later day the same
 * way.
 *
 * So the clock's epoch is PINNED. The recorder starts it at the real time, as
 * before, and writes that instant on the row (\`clockEpoch\`); the emitted test
 * carries the row's recorded fields (emit copies it, beside boundaryCalls) and
 * REPLAY_MODE starts the clock at that same instant instead of at real now.
 * Every read after it is the same count of ticks in both, so a date derived
 * from now is the recording's date on any day the replay runs. A row without
 * one (recorded before this) replays on real time, which is D49; the bump of
 * OBSERVATION_VERSION to 2 is what records every row again with one.
 *
 * And new Date() / Date() with no argument read the same clock, through one
 * Proxy of the harness's Date (ROW_DATE) that is the global while a row runs.
 * Only the no-argument forms are touched - new Date(x) with any argument,
 * Date.UTC, Date.parse and the prototype are the real Date's - and a date made
 * through it is a real Date: its prototype is Date.prototype, so instanceof
 * works for it and for dates made elsewhere, in either direction, and
 * Date.prototype.constructor is the Proxy while it is the global so
 * d.constructor === Date still holds. A library that looks Date up when it
 * runs (dayjs, date-fns, luxon's Settings.now, moment's hooks.now all do)
 * reads the row's clock. The Proxy is one object for the whole file and
 * decides per read: outside a row's async context, or for the test runner's
 * own read, it is real time, so a module that captured it keeps working after
 * the row. Its reads tick the clock like Date.now()'s, and a timer still moves
 * the clock to its due time. A proposal that replaced Date.now inside the row
 * pinned "now" itself, and new Date() then agrees with that pin; one that
 * replaced the Date global (a stub, vi.useFakeTimers, vi.setSystemTime) is
 * left alone, as D49 left its Date.now.
 *
 * AND ITS ZONE. A calendar value depends on the zone as much as on the
 * instant: dayKey() above is UTC, a date-fns format() is local. The replay
 * configs set TZ=UTC (REPLAY_TEST_ENV), the recorder's did not, and the repo's
 * own config - which cigate runs the suite under first - sets nothing, so a
 * recording made on a host that is not UTC, or a suite run by a developer on
 * one, was a different string. Each row now runs under TZ=UTC in both (see
 * pinRowZone), restored when the row ends. The containers and CI runners are
 * UTC already, so no fleet recording changes for it. It is inert in a
 * worker_threads pool, where node does not apply a TZ set at run time; there
 * the config's env is all there is.
 */
let ROW_CLOCK = null;
const HARNESS_PERFORMANCE = globalThis.performance;
const HARNESS_PERFORMANCE_NOW = HARNESS_PERFORMANCE?.now;
const PROMISIFY_CUSTOM = Symbol.for("nodejs.util.promisify.custom");
// The test runner reads the clock from inside a row too: vitest's console
// stamps every line written through it with Date.now(). It intercepts the
// console in the emitted suite and not in the recorder, so counting its reads
// put every elapsed time in the replay one or two milliseconds over the
// recording. Only the caller's frame is taken, so a read costs one short stack.
const RUNNER_FRAME = /[/]node_modules[/](?:vitest|@vitest[/][^/]+|vite-node|vite|tinypool|tinyspy)[/]/;
function readByRunner(fn) {
  const limit = Error.stackTraceLimit;
  const at = {};
  try {
    Error.stackTraceLimit = 1;
    Error.captureStackTrace(at, fn);
    return RUNNER_FRAME.test(String(at.stack));
  } catch {
    return false;
  } finally {
    Error.stackTraceLimit = limit;
  }
}
// D63: the harness's Date, taken before any row can stub it, and the one Proxy
// of it that is the global while a row runs (see the note above).
const HARNESS_DATE = Date;
// "Now" for a no-argument new Date() / Date(): the row's clock inside the
// row's own work, real time for anything else (the harness, an earlier row's
// leftover timer, the test runner). A Date.now the row itself put in place -
// a proposal's pin - is its own "now", and a new Date() agrees with it.
function rowWallNow(caller) {
  const clock = ROW_CLOCK;
  if (!clock || ROW_SCOPE.getStore() !== clock.gen || readByRunner(caller)) return HARNESS_DATE_NOW();
  const now = HARNESS_DATE.now;
  if (typeof now === "function" && now !== clock.dateNow && now !== HARNESS_DATE_NOW) return now.call(HARNESS_DATE);
  return clock.dateBase + (clock.ticks += 1);
}
const ROW_DATE = new Proxy(HARNESS_DATE, {
  // Only the no-argument form reads the clock: new Date(undefined) is an
  // Invalid Date, as it always was, and every other argument is the real
  // constructor's. newTarget is kept, so a class that extends Date still
  // builds its own instances.
  construct: function construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [rowWallNow(construct)], newTarget === ROW_DATE ? target : newTarget);
  },
  // Date() called as a function ignores its arguments and says "now" as text.
  apply: function apply(target) {
    return new target(rowWallNow(apply)).toString();
  },
});
/**
 * D63: THE ROW'S ZONE, the one the replay configs set (REPLAY_TEST_ENV), for
 * the recorder and for the emitted test under any config. Restored when the
 * row ends - after the row's own env, so a row that sets TZ itself still wins
 * for its own duration and does not leave its value behind.
 */
const ROW_ZONE = ${JSON.stringify(REPLAY_TEST_ENV.TZ)};
function pinRowZone() {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const prev = process.env.TZ;
  if (prev === ROW_ZONE) return function restoreRowZone() {};
  process.env.TZ = ROW_ZONE;
  return function restoreRowZone() {
    if (process.env.TZ !== ROW_ZONE) return;
    if (had) process.env.TZ = prev;
    else delete process.env.TZ;
  };
}
// \`epoch\` is the instant the row's recording started (D63): given in the
// replay, so the clock starts where the recording's did; absent in the
// recorder, where it is the real time now and is written on the row.
function installRowClock(gen, epoch = null) {
  // Whole milliseconds, so two reads subtract to a whole number of ticks: a
  // fractional base would leave a rounding error that differs from run to run.
  const perfBase = HARNESS_PERFORMANCE_NOW ? Math.floor(HARNESS_PERFORMANCE_NOW.call(HARNESS_PERFORMANCE)) : 0;
  const dateBase = Number.isSafeInteger(epoch) && epoch > 0 ? epoch : HARNESS_DATE_NOW();
  const clock = { gen, ticks: 0, dateBase, perfBase, dateNow: null };
  ROW_CLOCK = clock;
  const own = () => ROW_CLOCK === clock && ROW_SCOPE.getStore() === clock.gen;
  const ownRead = (fn) => own() && !readByRunner(fn);
  const undo = [];
  const RealDate = Date;
  if (RealDate.now === HARNESS_DATE_NOW) {
    RealDate.now = clock.dateNow = function now() {
      return ownRead(now) ? clock.dateBase + (clock.ticks += 1) : HARNESS_DATE_NOW();
    };
    undo.push(() => { RealDate.now = HARNESS_DATE_NOW; });
  }
  // D63: new Date() / Date() with no argument, through ROW_DATE. Only over the
  // harness's own Date: a global a proposal (or an earlier row) replaced is
  // left alone, and a Date.prototype.constructor someone else set is too.
  if (globalThis.Date === HARNESS_DATE || globalThis.Date === ROW_DATE) {
    const proto = HARNESS_DATE.prototype;
    const ctor = proto.constructor === HARNESS_DATE;
    globalThis.Date = ROW_DATE;
    if (ctor) proto.constructor = ROW_DATE;
    undo.push(() => {
      if (globalThis.Date === ROW_DATE) globalThis.Date = HARNESS_DATE;
      if (ctor && proto.constructor === ROW_DATE) proto.constructor = HARNESS_DATE;
    });
  }
  const perf = HARNESS_PERFORMANCE;
  if (perf && HARNESS_PERFORMANCE_NOW && perf.now === HARNESS_PERFORMANCE_NOW) {
    const hadOwn = Object.prototype.hasOwnProperty.call(perf, "now");
    try {
      Object.defineProperty(perf, "now", {
        configurable: true, writable: true, enumerable: false,
        value: function now() {
          return ownRead(now) ? clock.perfBase + (clock.ticks += 1) : HARNESS_PERFORMANCE_NOW.call(perf);
        },
      });
      undo.push(() => {
        if (hadOwn) Object.defineProperty(perf, "now", { configurable: true, writable: true, enumerable: false, value: HARNESS_PERFORMANCE_NOW });
        else delete perf.now;
      });
    } catch { /* a runtime whose performance.now cannot be replaced keeps the real one */ }
  }
  // Node clamps a delay outside 1..2^31-1 to 1ms; the clock moves the same way.
  const step = (ms) => {
    const d = Math.trunc(Number(ms));
    return d >= 1 && d <= 2147483647 ? d : 1;
  };
  const wrapTimer = (name, real, repeat) => {
    if (typeof real !== "function" || globalThis[name] !== real) return;
    const wrapped = function (fn, ms, ...rest) {
      if (typeof fn !== "function" || !own()) return real(fn, ms, ...rest);
      const by = step(ms);
      let due = clock.ticks + by;
      return real(function (...a) {
        if (ROW_CLOCK === clock && due > clock.ticks) clock.ticks = due;
        if (repeat) due += by;
        return fn.apply(this, a);
      }, ms, ...rest);
    };
    if (real[PROMISIFY_CUSTOM]) wrapped[PROMISIFY_CUSTOM] = real[PROMISIFY_CUSTOM];
    globalThis[name] = wrapped;
    undo.push(() => { if (globalThis[name] === wrapped) globalThis[name] = real; });
  };
  wrapTimer("setTimeout", HARNESS_SET_TIMEOUT, false);
  wrapTimer("setInterval", HARNESS_SET_INTERVAL, true);
  const restoreRowClock = function restoreRowClock() {
    if (ROW_CLOCK === clock) ROW_CLOCK = null;
    for (const u of undo.reverse()) u();
  };
  // The instant this row's clock started, for the row to carry (D63).
  restoreRowClock.epoch = clock.dateBase;
  return restoreRowClock;
}
/**
 * TOOL BACKLOG: AN ORDERING BARRIER BETWEEN TWO SETS OF MOCKS.
 *
 * vitest queues every vi.doMock and, before the next import, resolves each
 * run of CONSECUTIVE mocks IN PARALLEL (Promise.all in resolveMocks), so the
 * registry takes them in whichever order their paths finish resolving. Two
 * specifiers that resolve to one file - the default-deny's \`@/prisma/client\`
 * and a proposal's \`@/prisma\`, both the repo's prisma/client.ts - then race,
 * and the deny sometimes landed last. tracy-agent-be \`20260922T152300Z\`: five
 * rows that declared and installed \`prisma\` died as "blocked egress:
 * prisma.pipeline / prisma.$queryRawUnsafe - declared AND installed", and
 * the same proposals recorded when replayed in a different chunk. vitest runs
 * the groups themselves in order, split wherever the action changes, so one
 * doUnmock of a path nothing mocks puts everything queued before it ahead of
 * everything queued after it. The path resolves to nothing, which vitest
 * accepts, and unmocking it removes nothing.
 */
function mockOrderBarrier() {
  vi.doUnmock("charpilot:mock-order-barrier");
}
function unmockAll() {
  unstubGlobals();
  for (const p of MOCKED) vi.doUnmock(p);
  MOCKED.clear();
}

/** Every mocked boundary records its calls, so the pair says what was invoked. */
let CALLS = [];
function resetCalls() { CALLS = []; INFLIGHT = new Set(); ROW_GEN += 1; }

/**
 * WHICH ROW A CALL BELONGS TO, decided by the async context that made it.
 *
 * The ledgers are module-level (CALLS, EGRESS, DOWNSTREAM) and a row resets
 * them when it starts. Work an EARLIER row left running is not stopped by that:
 * a row that times out keeps its promises, and when they resume they push onto
 * whatever ledger is current - the next row's. cv-parsing-ms PR #67 recorded
 * exactly that: arg0-of-uploadedFiles-map-391-cond-expr-0 hit its 10000ms
 * budget mid-way through a .doc conversion, and the row after it, the pure
 * function sanitizeDate(new Date(NaN)), recorded its tail as its own
 * downstream calls - [processFileConversion, parseResume]. The second
 * observation ran the same two rows in the same order and repeated the leak,
 * so it passed the determinism check; the committed test runs that row alone,
 * after a skipped neighbour, and replayed [] - red in CI.
 *
 * Every row body runs inside ROW_SCOPE.run(ROW_GEN, ...), and node carries
 * that value through every promise, timer and callback the body starts. A push
 * made from an earlier row's context is not this row's observation and is not
 * recorded here. A push made outside any row (nothing the rows started) is
 * kept, which is what happened before.
 */
const ROW_SCOPE = new AsyncLocalStorage();
let ROW_GEN = 0;
function ownRow() { const g = ROW_SCOPE.getStore(); return g === undefined || g === ROW_GEN; }
function rowPush(list, entry) { return ownRow() ? list.push(entry) : list.length; }
function takeCalls() { const c = CALLS; CALLS = []; return c; }

/**
 * BOUNDARY CALLS STILL IN FLIGHT WHEN THE SUBJECT SETTLES.
 *
 * out.boundaryCalls = takeCalls() runs the moment the subject's own promise
 * settles. A boundary the subject called WITHOUT awaiting is still pending at
 * that instant, so its entry holds a symbol and args and no outcome at all -
 * not \`resolved\`, not \`rejected\`, not \`threw\`.
 *
 * That entry is unusable to the replay, and the replay says so exactly:
 * "the recording HELD 1 call(s) here and none could be replayed: no outcome was
 * captured for this call - this is the recorder's capture to repair". It is the
 * recorder's to repair, and this is the repair.
 *
 * Measured on location-ms: the location controller is wrapped by an error-
 * handling decorator and its call to matchingLocationWithCacheOption is not
 * awaited to completion, so the row was captured 374ms into a 10000ms budget
 * with that call's outcome missing, and the emitted test could not replay it.
 *
 * Two outcomes, and BOTH are recorded rather than one being inferred:
 *   - it settles inside the remaining budget: the entry gets its real outcome,
 *     and the row is a complete observation after all
 *   - it is still pending when the budget runs out: the entry is marked
 *     \`pending\`, which is the TRUE observation - the subject really did leave
 *     that call in flight - and the replay reproduces it as a promise that
 *     never settles, because that is what the subject actually saw
 */
let INFLIGHT = new Set();

/**
 * Let in-flight boundary calls settle, bounded by what is left of the row.
 *
 * Bounded, not unbounded: a call the subject abandoned may never settle, and
 * waiting forever on it would turn a recorded row into a hung one. The budget
 * is whatever the row has not spent, so this can never push a row past the
 * budget it is measured against.
 */
async function settleInflight(budgetMs) {
  if (!INFLIGHT.size) return;
  const waiting = [...INFLIGHT];
  let timer;
  const settled = await Promise.race([
    Promise.all(waiting).then(() => true),
    new Promise((res) => { timer = HARNESS_SET_TIMEOUT(() => res(false), Math.max(0, budgetMs)); }),
  ]);
  HARNESS_CLEAR_TIMEOUT(timer);
  // What is STILL unsettled is marked ON THE ENTRY. An entry that merely lacks
  // an outcome is indistinguishable from one the recorder dropped; an entry
  // that SAYS it never settled is an observation.
  if (!settled) {
    for (const entry of CALLS) {
      if (entry.__inflight) {
        entry.pending = true;
        entry.pendingWhy =
          "the subject did not await this call and it had not settled when the row was captured - " +
          "the replay answers it with a promise that never settles, which is what the subject saw";
      }
    }
  }
  for (const entry of CALLS) delete entry.__inflight;
  INFLIGHT = new Set();
}

/**
 * Turn one declared boundary answer into the thing the module will export.
 *
 * Two shapes hide behind \`kind: "returns"\`, and only the real export can tell
 * them apart: \`createUsageRecorder\` is a function whose RETURN is the answer,
 * while \`prisma\` and \`redisCache\` are objects and the answer IS the export.
 * Guessing wrong on either is silent - a function replaced by an object throws
 * "not a function", and an object replaced by a function makes every property
 * undefined.
 *
 * The wrappers are Proxies so a mocked CLASS (\`OpenAI\`, \`Anthropic\`,
 * \`CallbackHandler\`) still works under \`new\`.
 */
/**
 * A passthrough that records BOTH halves of the call: what went in, and what
 * came back. Used for every observed boundary, and it is what a live run turns
 * a provider client into - the real SDK runs, and its parsed response is
 * written down next to the function's own return value, so one row yields both
 * the characterization pair AND the fixture a later vi.mock would serve.
 *
 * A constructed client is wrapped two levels deep, because the request is not
 * made by the constructor - it is made by client.messages.create(...), and
 * that is the call whose response is worth keeping.
 */
function observing(symbol, real, depth = 0, producedBy) {
  // An OBJECT export is the common case for the boundary whose whole observable
  // is the call: loggerV2, logger and prisma are all objects, and returning
  // them untouched made 60-odd spy boundaries look as though they were never
  // called. They were - the call just went to a member. So an object boundary
  // is wrapped member-wise, and loggerV2.service("x").warn(...) is recorded
  // at both hops because the returned builder is wrapped too.
  // Member-wise wrapping was tried once and recorded as a dead end, because the
  // proxy handed back a FRESH wrapper on every property read: object identity
  // stopped being stable, every recursive walker guarding cycles with a Set or
  // WeakSet looped forever, and five rows that had recorded clean values
  // (runWithRetry-succeeds-on-first-attempt,
  // pruneGeminiSchema-called-without-dropped-set,
  // invalidateApiKeyCache-with-no-body, anthropic-invoke-assistant-role-message,
  // ctrl-v4-compiled-prompt-is-a-string) stopped settling at all.
  //
  // That note also named the fix - memoise the wrapper per (object, key) - and
  // this is it. observingObject now caches, so reading the same member twice
  // returns the SAME wrapper and identity holds.
  //
  // It is worth the second attempt because the cost of not wrapping was
  // measured on pricing-ms: all 5 of its spy declarations are on logger, an
  // object, and in 5 of 5 rows the symbol never appeared in boundaryCalls.
  // Winston writes to process.stdout rather than console, so the console
  // capture was empty on 0 of 18 rows too - a logger call was unobservable from
  // either side. 13 of 18 rows had boundaryCalls: [].
  //
  // The five named rows above are the regression test, and they still settle.
  if (typeof real !== "function") return observingObject(symbol, real, depth, producedBy);
  return observingFn(symbol, real, depth, producedBy);
}

/**
 * A Response's OWN state, written onto the exchange rather than into the value.
 *
 * Every property a Response exposes - status, ok, headers - lives in an
 * internal slot behind a prototype getter, so snap() walks its own keys, finds
 * none, and records \`"resolved": {}\`. replayResponse() was written for exactly
 * that shape and takes the status "on the exchange itself"; nothing ever put it
 * there, so \`typeof ex.status !== "number"\` declined on every fetch this
 * pipeline has ever recorded and the reconstruction was unreachable code.
 *
 * What the replay handed back instead was a proxy over the empty object, on
 * which \`res.ok\` reads as UNDEFINED. Measured on a live location-ms row whose
 * recording holds six 200s: googleMap.service.ts:397 is
 * \`if (keys.includes('error_message') || !res.ok) throw\`, so every replayed
 * Google call threw at a boundary that had succeeded, parseAddressesForJd
 * returned two nulls without geocoding anything, and occurrences 6-13 of 14
 * reported as never replayed. That is the whole "retry loop" cluster in run
 * 20260915T033521Z - 56 fetch and 56 fetch.json calls across its 20 rows.
 *
 * Only the status, because that is the only field replayResponse consumes and
 * the only one it can rebuild without inventing: \`ok\`, \`redirected\` and the
 * rest derive from it, and a header the replay does not reproduce would be an
 * expected value nobody observed.
 */
function recordResponseStatus(entry, value) {
  if (typeof Response !== "function" || !(value instanceof Response)) return;
  entry.status = value.status;
}

function observingFn(symbol, real, depth = 0, producedBy) {
  const run = (args, thisArg, construct) => {
    // Array.from, not args.map: a build may have patched Array.prototype.map
    // (see flushQueuedMocks), and the ledger then recorded every call's args
    // as [] - and handed the harness's own callback to the build's capture.
    const entry = { symbol, args: Array.from(args, (a) => snap(a)) };
    if (construct) entry.construct = true;
    // WHICH product this call was made ON. See the note on \`finish\`.
    if (typeof producedBy === "number") entry.on = producedBy;
    // The occurrence number this entry will carry: boundaryCalls IS the CALLS
    // array (takeCalls returns it unchanged) and replayRoot numbers exchanges by
    // their index in it, so the index at push time is the \`seq\` the replay
    // matches on.
    const occurrence = CALLS.length;
    rowPush(CALLS, entry);

    // A FUNCTION ARGUMENT IS A SEAM, NOT A VALUE.
    //
    // A boundary handed a callback RUNS it, and everything the subject does
    // inside that callback is done through whatever the boundary passed in. If
    // the call is recorded as an ordinary exchange, the replay answers it with
    // the recorded result and the callback NEVER RUNS - so every call the
    // subject made inside it goes unmade, and each of those exchanges reports
    // as never replayed.
    //
    // This is the same defect $transaction carries a hand-written special case
    // for, and the special case is why it was only ever fixed for prisma. The
    // rule is general: location-ms wraps every Google call in
    // trace.getTracer(...).startActiveSpan(name, async (span) => { ... fetch ...
    // }), so replaying startActiveSpan from its recorded value orphaned the
    // fetch and the row could not replay at all.
    //
    // Observed, not just passed through: each argument the boundary hands the
    // callback is wrapped under its own name, so span.spanContext() is recorded
    // as an exchange like any other. That matters beyond this seam - the
    // subject builds its Traceparent header out of span.spanContext().traceId,
    // which is fresh per run, and a REPLAYED spanContext returns the recorded
    // ids, so the fetch that carries them keys byte-exactly. Replaying the seam
    // is what makes the call below it stable; a lenient matcher would only have
    // hidden that.
    let cbIndex = -1;
    let cbCalls = 0;
    let cbArity = 0;
    const passed = args.map((a, i) => {
      // ONE callback, the first. A boundary taking two is rare and a
      // node-style (err, value) pair is not a seam at all, so the second is
      // left exactly as the subject passed it rather than guessed at.
      if (typeof a !== "function" || cbIndex !== -1) return a;
      cbIndex = i;
      return function (...cbArgs) {
        cbCalls += 1;
        cbArity = Math.max(cbArity, cbArgs.length);
        return Reflect.apply(
          a,
          this,
          cbArgs.map((v, j) =>
            v !== null && (typeof v === "object" || typeof v === "function")
              ? observingObject(symbol + ".$cb" + j, v, depth)
              : v
          )
        );
      };
    });
    // EXACTLY ONCE, or it is not a pass-through. A callback invoked twice (an
    // event handler, an iteration) has no single execution for the replay to
    // reproduce, and one invoked zero times was never a seam - both keep the
    // recorded outcome they have always had.
    const markPassthrough = () => {
      if (cbCalls === 1) {
        entry.passthroughCallback = cbIndex;
        entry.callbackArity = cbArity;
      }
    };
    const finish = (out) => {
      // A FACTORY's product is observed too, not only a constructor's. pricing-ms
      // reaches its database through getPrisma(), a function export whose RETURN
      // is the client - and only construct was wrapped, so the row recorded
      // {"symbol":"getPrisma","args":[]} and every query through it was
      // invisible. Its agent had to echo each query into the answer's own return
      // value to see anything at all. Every db-shaped row in that repo goes
      // through this seam.
      //
      // A plain data result is left alone: wrapping a returned object would put
      // a proxy into the recorded value, and the depth cap keeps a factory
      // returning a factory from nesting forever.
      //
      // WHICH PRODUCT, not just which path. A member call is recorded at
      // \`<path>.<member>\` for every product of \`<path>\`, so N calls to the same
      // boundary put N indistinguishable member exchanges under one name and the
      // replay has to pair them by queue position. That pairing is wrong
      // whenever the recording's member order is not the call order, and for a
      // Response it routinely is: googleMap.service.ts:122 issues two fetches
      // together and reads each body in its \`.then\`, so the bodies are recorded
      // in the order the NETWORK answered. Measured on a live parseAddressesForJd
      // row - Lockbourne's body was recorded first under Locarno's request twice
      // out of three pairs, and the replayed row came back with the two
      // addresses' rawText swapped while every assertion on the ledger passed.
      //
      // So the producing occurrence is carried down and each member call names
      // it in \`on\`. The replay then asks for the body OF THIS response rather
      // than for the next one under the name.
      if (out && (typeof out === "object" || typeof out === "function") && depth < 2) {
        return observingObject(symbol, out, depth + 1, occurrence);
      }
      return out;
    };
    try {
      const out = construct ? Reflect.construct(real, passed) : Reflect.apply(real, thisArg, passed);
      markPassthrough();
      if (out && typeof out.then === "function") {
        // Tracked so settleInflight() can wait for it. The tracking promise is a
        // SEPARATE, always-fulfilling one: awaiting the observed promise
        // directly would make settleInflight the handler that "handles" a
        // rejection the subject abandoned, changing whether the process reports
        // an unhandled rejection - an observation must not alter what it
        // observes.
        entry.__inflight = true;
        const tracked = out.then(
          () => { entry.__inflight = false; },
          () => { entry.__inflight = false; }
        );
        INFLIGHT.add(tracked);
        return out.then(
          (v) => { markPassthrough(); entry.resolved = snap(v); recordResponseStatus(entry, v); return finish(v); },
          (e) => { markPassthrough(); entry.rejected = snap(e); throw e; }
        );
      }
      if (!construct) { entry.returned = snap(out); recordResponseStatus(entry, out); }
      return finish(out);
    } catch (e) {
      entry.threw = snap(e);
      throw e;
    }
  };
  return new Proxy(real, {
    apply: (_t, thisArg, args) => run(args, thisArg, false),
    construct: (_t, args) => run(args, undefined, true),
  });
}

/**
 * One wrapper per object, and one wrapper per member read.
 *
 * Both caches are what make this safe. Without the outer one,
 * \observingObject(o)\ returns a different proxy each call, so \a.x === a.x\
 * is false. Without the inner one, reading \a.x\ twice returns two different
 * wrappers - which is the exact instability that made the first attempt at this
 * hang five rows, because a cycle guard holding a WeakSet of visited objects
 * never recognised the second read.
 *
 * WeakMap on both, so nothing here keeps a subject alive.
 */
/* ---------------------------------------------------------------------------
 * REPLAY STATE. Per row, reset by installReplay().
 *
 * REPLAY_MODE is FALSE here and hermeticise() turns it on for the committed
 * test, exactly as it already does for LIVE_MODE: the recorder must reach the
 * real dependency and write both halves down, and only the generated test
 * replays what was written.
 * ------------------------------------------------------------------------- */
const REPLAY = { exchanges: [], queues: new Map(), byPath: new Map(), roots: new Set(), nodes: new Map() };
let REPLAY_CALLS = [];
let REPLAY_LIMITS = [];
let REPLAY_MISMATCHES = [];
let REPLAY_UNRESOLVED = [];
const REPLAY_MODE = false;

/** Path plus the request, exactly as the recording serialised it. */
const replayKey = (path, args) => path + "\\u0000" + JSON.stringify(args ?? []);

/** This tree records a boundary call straight onto CALLS; the ported replay
 * code was written against a wrapper, so the wrapper is the adaptation. */
const pushCall = (entry) => (rowPush(CALLS, entry), entry);

/**
 * F9/008-Z8 - \`$personal\` IS ON THIS LIST, AND THAT IS THE WHOLE SUBSTITUTION
 * RULE MECHANISED.
 *
 * "A value may be substituted if and only if no branch depends on it" cannot be
 * decided at snap() time - snap() sees a field, not a branch. It IS decided
 * here. A redacted personal field the subject never reads is never asked for,
 * so the row replays and the emitted expectation pins a type and a length. A
 * redacted personal field that sits in an outcome the replay has to hand BACK
 * to the subject reaches this list, and the row reports \`replayLimited\` with
 * the path on it instead of running against a stand-in.
 *
 * \`$envRef\`'s answer is not available here and saying why is part of the
 * design: a credential has an environment variable a person can export, and
 * nothing in any environment holds a customer's name. So there is no third
 * branch - the row waits, visibly, and the fix is a proposal that does not send
 * a real person through the boundary.
 */
const UNREVIVABLE = ["$truncated", "$redacted", "$personal", "$function", "$stream", "$iterator", "$asyncIterator", "$binary", "$drained"];
function unrevivable(v, path = "") {
  if (v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const why = unrevivable(v[i], path + "[" + i + "]");
      if (why) return why;
    }
    return null;
  }
  for (const tag of UNREVIVABLE) if (tag in v) return (path || "the value") + " was snapshotted as " + tag + ", which cannot be reconstructed";
  // F8/CV-1: a refused credential is a limitation with a REASON, and the reason
  // is not "we could not serialise it" - it is that the recording saw this one
  // reference hold more than one credential, so there is no export that answers
  // for all of them. Quarantining the row here is the refusal; the alternative
  // is a green test asserting one service's credential where another's was.
  if ("$credentialCollision" in v) {
    // A33/2: the count is printed only where a comparison established one. A
    // refusal reached because nothing could be compared says that instead.
    const at = (Array.isArray(v.sites) && v.sites.length ? " (at " + v.sites.join(", ") + ")" : "");
    const named = (path || "the value") + " is a credential reference this recording REFUSED: " + v.$credentialCollision;
    return typeof v.distinctCredentials === "number"
      ? named + " was observed holding " + v.distinctCredentials + " different credentials" + at +
        ", and one exported value cannot faithfully answer for all of them"
      : named + "'s observations were never compared" + at +
        (typeof v.comparison === "string" && v.comparison ? " - " + v.comparison : "") +
        ", so nothing here establishes which credential it held";
  }
  // 008/Z22: nor is a \`$credentialPlaceholder\`. It is the same judgement as the
  // line below with one fewer moving part - there is no environment to consult
  // and therefore nothing that can fail to resolve. The recording said it could
  // not establish which credential this reference held, and \`revive\` answers it
  // with a string derived from the reference name and the recorded length, which
  // both sides of the comparison reconstruct identically.
  if ("$credentialPlaceholder" in v) return null;
  // F8: an \`$envRef\` is NOT a limitation. The recording deliberately holds a
  // reference instead of the secret, and the replay resolves it from the
  // environment - or fails explicitly, by name, at the moment it is read.
  // Reporting it here instead would quarantine 11 of location-ms's 21 rows for
  // a value that is one export away, which is the state F8 exists to end.
  if ("$envRef" in v) return null;
  // A17: $urlSearchParams used to short-circuit here alongside the others, and
  // it can now CONTAIN a credential marker - including a refused one. It falls
  // through to the generic walk below so a $credentialCollision inside a query
  // string is reported instead of replayed. $headers and $formData are new and
  // are deliberately not listed here for the same reason.
  if ("$map" in v || "$set" in v || "$typedArray" in v || "$date" in v || "$regexp" in v || "$buffer" in v || "$bigint" in v || "$undefined" in v || "$number" in v) return null;
  if ("$error" in v) {
    for (const k of Object.keys(v)) {
      if (k === "$error" || k === "message") continue;
      const why = unrevivable(v[k], path ? path + "." + k : k);
      if (why) return why;
    }
    return null;
  }
  for (const k of Object.keys(v)) {
    const why = unrevivable(v[k], path ? path + "." + k : k);
    if (why) return why;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Helpers the replay path CALLS on its success path, dropped by the first
 * port because its extractor matched a declaration shape these do not have.
 * Every one of them sits inside revive() or replayProduct(), so the failure
 * only appears once an exchange actually MATCHES - which is why a corpus that
 * mostly diverged on the key showed it on one row rather than all of them.
 * Observed on qode-ptp-ms: ReferenceError: replayResponse is not defined.
 * ------------------------------------------------------------------------- */

/**
 * 008/Z22 - THE STAND-IN FOR A CREDENTIAL NOTHING COULD VOUCH FOR, DERIVED FROM
 * FACTS THE ARTIFACT ALREADY PUBLISHES.
 *
 * It takes the reference NAME and the recorded LENGTH and nothing else, which
 * is the whole of why it is safe to hand back: both are already in the
 * artifact, in plain sight, and neither is any part of the secret. Two
 * consequences fall out of that and both are load-bearing:
 *
 *   reconstructible   the recording and the replay compute the same string from
 *                     the same two facts, so the value asserted on is a value
 *                     both sides derived rather than one side invented.
 *   length-preserving the replay key carries the length (see \`credentialRef\`),
 *                     and a service that checks \`key.length\` gets the answer it
 *                     got when the pair was recorded.
 *
 * IT IS NOT A SUBSTITUTE FOR AN EXPECTED VALUE, which is the rule this file
 * refuses to break anywhere else. A substitute is a value handed back in place
 * of one the recording HELD, so that the recorded value's own assertion quietly
 * becomes an assertion about the stand-in. Here there is no held value on either
 * side: the recording published a reference, this recording could not establish
 * which credential that reference named, and the placeholder appears identically
 * in the recorded expectation and in the replayed observation. Nothing asserts
 * that the service saw THIS string; the assertion is that the same reference
 * reached the same site with the same length, which is exactly what was
 * observed.
 *
 * The spelling is deliberate: a head a person reading a generated test cannot
 * mistake for a live secret, then a fill derived from the reference name so two
 * different references never produce one string. Under-length references lose
 * the head rather than the determinism - short credentials exist, and a
 * placeholder that is not exactly \`length\` characters long would change the
 * replay key it exists to preserve.
 */
function credentialPlaceholder(name, length) {
  const size = Number(length);
  if (!Number.isInteger(size) || size <= 0) return "";
  const seed = String(name).replace(/[^A-Za-z0-9]+/g, "").toUpperCase() || "CHARPILOTPLACEHOLDER";
  const head = "charpilot-placeholder-";
  let out = size >= head.length + 8 ? head : "";
  for (let i = 0; out.length < size; i += 1) out += seed[i % seed.length];
  return out.slice(0, size);
}

/**
 * F8 - resolve a recorded credential reference, or FAIL, naming it.
 *
 * There is no third branch on purpose. A placeholder, an empty string or the
 * \`$redacted\` marker handed back here would become the value the subject ran
 * against and therefore the value the test expects - a substitute silently
 * becoming an expected value is the exact rule this design exists to keep. So
 * an unresolvable reference is a named, readable failure that says WHICH
 * variable is missing and what to do about it.
 */
function resolveEnvRef(v) {
  const name = String(v.$envRef);
  const value = process.env[name];
  if (typeof value === "string" && value.length) return value;
  REPLAY_UNRESOLVED.push({
    reference: name,
    provenance: v.provenance ?? "unknown",
    recordedLength: v.length ?? null,
  });
  const e = new Error(
    "charpilot replay: the recorded credential reference " + name + " is not resolvable from the environment.\\n" +
      "  The recording carries no secret by design and this runtime will not substitute one - a substitute becomes the expected value.\\n" +
      "  Export " + name + " with the credential the recorded run observed" +
      (v.provenance === "derived"
        ? " (the recording found no environment variable holding it - it came from the service's own data, so the name above was minted from where it was observed)"
        : " (the recording observed it under exactly this variable)") +
      ", or leave this row quarantined."
  );
  e.name = "CharpilotUnresolvedCredential";
  e.reference = name;
  throw e;
}

/**
 * \`fetch\` returns a Response, not a parsed body.
 *
 * The subject calls \`.json()\`, may branch on \`status\`, may read \`ok\` - so
 * handing back the parsed body would change the contract at the boundary. A
 * Response keeps its state in internal slots, so snap() flattened it to \`{}\`
 * and the body is recorded one hop down, at \`<path>.json\` or \`<path>.text\`,
 * with the status on the exchange itself. Both halves are observed, so both are
 * given back as a REAL Response and the member exchange is marked replayed by
 * the reconstruction that consumed it.
 *
 * Declined - and left to the node above - whenever any part of that is missing,
 * because a Response built from a status nobody observed would be an invented
 * expected value.
 */
function replayResponse(path, ex, raw) {
  if (typeof Response !== "function") return null;
  if (typeof ex.status !== "number") return null;
  // A body is not allowed on these, so a Response cannot carry the recorded one.
  if (ex.status < 200 || ex.status === 204 || ex.status === 205 || ex.status === 304) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) return null;
  // THIS RESPONSE'S BODY, named by the recording - \`on\` is the occurrence of the
  // call that produced the Response the read was made on, written by
  // observingFn's finish(). Picking "the next unread body under this name"
  // instead paired two concurrent fetches with each other's bodies; see the note
  // on finish() for the measurement. A body exchange that names no response is
  // not this one's, so it is left alone and the reconstruction declines.
  //
  // \`reserved\` and not \`used\`: see the note on the body read below. A reserved
  // exchange is spoken for by one Response and must not be picked by the next
  // one, but it has not been REPLAYED until the subject asks for it.
  const pick = (member) =>
    (REPLAY.byPath.get(path + "." + member) ?? []).find((e) => !e.used && !e.reserved && e.on === ex.seq);
  const jsonEx = pick("json");
  const textEx = jsonEx ? null : pick("text");
  const source = jsonEx ?? textEx;
  if (!source) return null;
  const outcome = "resolved" in source ? source.resolved : "returned" in source ? source.returned : undefined;
  if (outcome === undefined) return null;
  const body = jsonEx ? JSON.stringify(revive(outcome)) : String(revive(outcome));
  source.reserved = true;
  const key = replayKey(String(source.symbol), source.args);
  const queue = REPLAY.queues.get(key);
  if (queue) REPLAY.queues.set(key, queue.filter((e) => e !== source));
  // Not a guessed header: the recording captured a \`.json()\` that SUCCEEDED,
  // which only a JSON body allows.
  const value = new Response(body, { status: ex.status, headers: jsonEx ? { "content-type": "application/json" } : {} });
  // THE BODY READ IS STILL A CALL, so the ledger has to show it - AT THE MOMENT
  // THE SUBJECT READS IT.
  //
  // The recording captures \`res.json()\` as its own exchange one hop down - that
  // is where this body comes from - and the emitted test asserts the recorded
  // symbols in order. Reconstructing the Response answers that exchange without
  // any node being called, so without an entry here every fetch row would fail
  // on ["fetch","fetch.json"] vs ["fetch"] - the row's own recording used as the
  // expected value against itself.
  //
  // Pushing it at the RECONSTRUCTION was wrong, and its own note said why it
  // might be: it assumed the body is read in the next statement. Two fetches
  // issued together break that assumption without the subject touching any
  // other boundary. googleMap.service.ts:122 is
  // \`Promise.all(rawLocations.map(l => this.getPredictions(l)))\`, so both
  // requests are made before either \`.then\` runs and the recording holds
  // fetch, fetch, json, json - while eager pushing produced fetch, json, fetch,
  // json and the row failed on call order alone. Measured on a live
  // parseAddressesForJd row with three such pairs.
  //
  // A real Response has no seam to observe, so one is put on THIS instance: an
  // own \`json\`/\`text\` shadowing the prototype method, which records the call
  // and then delegates to the real one - so bodyUsed, a second read and the
  // parse all still behave as the Response's own. The exchange is marked
  // \`used\` here rather than at reconstruction, so a Response whose body the
  // subject never reads reports as never replayed instead of passing silently.
  const member = jsonEx ? "json" : "text";
  const readBody = value[member].bind(value);
  Object.defineProperty(value, member, {
    configurable: true,
    writable: true,
    value: () => {
      source.used = true;
      const bodyEntry = { symbol: String(source.symbol), args: source.args };
      if (source.live) bodyEntry.live = source.live;
      bodyEntry["resolved" in source ? "resolved" : "returned"] = outcome;
      bodyEntry.replayed = { occurrence: source.seq, viaResponse: true };
      pushCall(bodyEntry);
      return readBody();
    },
  });
  return { value };
}

/* ---------------------------------------------------------------------------
 * REPLAY - answer a boundary from the recording rather than from the proposal.
 *
 * Ported from the reference tree. Without it an emitted test answers every
 * boundary from the proposal's own hand-written value, so a LIVE recording's
 * real staging reads and real downstream responses are discarded at emit and
 * the committed suite asserts the canned answer instead. Measured on this
 * repo: 265 boundary calls answered by doubles while the artifact stamped
 * "live": true.
 * ------------------------------------------------------------------------- */

/**
 * F8/CV-1 - a refused credential, refused again at the moment it is read.
 *
 * \`unrevivable\` should have kept this row out of the emitted suite entirely,
 * so reaching here means something revived a value that was never offered for
 * revival. The answer is still not a value: one export cannot stand in for the
 * several credentials this reference was seen holding, and a stand-in becomes
 * the expected value the moment it is handed back.
 */
function refuseCollidedCredential(v) {
  const name = String(v.$credentialCollision);
  REPLAY_UNRESOLVED.push({
    reference: name,
    provenance: "collision",
    collision: true,
    distinctCredentials: v.distinctCredentials ?? null,
    recordedLength: v.length ?? null,
  });
  // A33/2: the same rule in the message a failing replay prints. A count where
  // a comparison produced one; the missing evidence where it did not.
  const at = (Array.isArray(v.sites) && v.sites.length ? " (at " + v.sites.join(", ") + ")" : "");
  const e = new Error(
    "charpilot replay: the credential reference " + name + " was REFUSED at record time and cannot be resolved.\\n" +
      (typeof v.distinctCredentials === "number"
        ? "  The recording observed it holding " + v.distinctCredentials + " different credentials" + at + ", " +
          "so a single exported value would answer for one of them and silently substitute for the rest.\\n"
        : "  The recording never compared its observations" + at +
          (typeof v.comparison === "string" && v.comparison ? " - " + v.comparison : "") + ", " +
          "so nothing establishes which credential it held and an exported value would become an expected value nothing observed.\\n") +
      // X11 - AND AT REPLAY TIME, THE SAME SPLIT.
      //
      // This sentence was written for the refusal bindCredential() reaches, where
      // it is exactly right: one name held two credentials and no export fixes
      // that. It was then printed over the refusals the parent reaches with
      // nothing compared, where it is wrong - there IS something that fixes
      // those, and it is not an export, it is recording the group together.
      (v.recovery && v.recovery.action === "re-record-together" && Array.isArray(v.recovery.rows) && v.recovery.rows.length
        ? "  No export fixes this and no new input does either: record " + v.recovery.rows.join(", ") +
          " together under ONE recording, which is the arrangement in which these observations can be compared at all."
        : "  There is nothing to export that fixes this: give the colliding observations distinct sites, or leave these rows quarantined.")
  );
  e.name = "CharpilotCredentialCollision";
  e.reference = name;
  throw e;
}

function revive(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => revive(x));
  if ("$credentialCollision" in v) return refuseCollidedCredential(v);
  // 008/Z22 - RESOLVED WITHOUT THE ENVIRONMENT, AND THAT IS THE POINT.
  //
  // The environment is not consulted first and then fallen back from. This
  // reference was marked a placeholder because the recording could not establish
  // WHICH credential it held; an exported value is therefore one nothing here
  // can attach to any particular observation, and preferring it would reinstate
  // exactly the unestablished equality the marker exists to record. The
  // placeholder is the only value that is equally-not-the-secret at every
  // observation of the name, and it is the same string this row's own
  // \`credentialRef\` reconstructs from the same two published facts - so the
  // emitted assertion compares two DERIVED values rather than asserting a
  // substituted one.
  //
  // A row that needs the real credential is a different marker: an \`$envRef\`
  // this recording DID vouch for, and it still fails by name below when the
  // environment cannot supply it.
  if ("$credentialPlaceholder" in v) return credentialPlaceholder(String(v.$credentialPlaceholder), v.length);
  if ("$envRef" in v) return resolveEnvRef(v);
  if ("$undefined" in v) return undefined;
  if ("$bigint" in v) return BigInt(v.$bigint);
  // D51: NaN, Infinity, -Infinity and -0, as snap() spelled them.
  if ("$number" in v) return Number(v.$number);
  if ("$date" in v) return new Date(v.$date === "Invalid Date" ? NaN : v.$date);
  if ("$regexp" in v) {
    const m = /^\\/([\\s\\S]*)\\/([a-z]*)$/.exec(String(v.$regexp));
    return m ? new RegExp(m[1], m[2]) : new RegExp(String(v.$regexp));
  }
  // A17: the entries may now hold a credential reference, so each value is
  // revived before it is put back. resolveEnvRef() throws by name when the
  // reference is unresolvable - which is the point: the header goes back with
  // the credential the recording observed, or the row fails saying which
  // variable is missing. Never a substitute.
  if ("$urlSearchParams" in v) return new URLSearchParams(v.$urlSearchParams.map(([k, val]) => [k, String(revive(val))]));
  if ("$headers" in v) return new Headers(v.$headers.map(([k, val]) => [k, String(revive(val))]));
  if ("$formData" in v) {
    const fd = new FormData();
    for (const [k, val] of v.$formData) fd.append(k, revive(val));
    return fd;
  }
  if ("$buffer" in v) return Buffer.from(v.$buffer, "base64");
  if ("$typedArray" in v) {
    const C = globalThis[v.$typedArray];
    const big = /^Big/.test(String(v.$typedArray));
    const values = (v.values ?? []).map((n) => (big ? BigInt(n) : n && typeof n === "object" && "$number" in n ? Number(n.$number) : n));
    return typeof C === "function" ? C.from(values) : values;
  }
  if ("$map" in v) return new Map(v.$map.map(([k, val]) => [revive(k), revive(val)]));
  if ("$set" in v) return new Set(v.$set.map((x) => revive(x)));
  if ("$error" in v) {
    const e = new Error(v.message);
    e.name = v.$error;
    for (const k of Object.keys(v)) {
      if (k === "$error" || k === "message") continue;
      e[k] = revive(v[k]);
    }
    return e;
  }
  const out = {};
  for (const k of Object.keys(v)) out[k] = revive(v[k]);
  return out;
}

/**
 * Which recorded exchanges this replay is ALLOWED to answer from.
 *
 * A \`notCalled\` entry is excluded because the test installs that guard itself
 * and reproduces the entry the same way the recording made it; everything else
 * with no reconstructable outcome is a limitation, reported per exchange so a
 * reader can see which call the recording is short of.
 */
function replayUnusable(c) {
  if (c.construct) return "the recording captured a CONSTRUCTED instance, whose identity the snapshot does not carry";
  if (c.refusedWrite) return "the recorder refused this write, so no outcome was ever observed";
  // A call the subject left IN FLIGHT is a complete observation with no
  // outcome, which is a different thing from a capture that lost one. The
  // recorder distinguishes them - see settleInflight() - and this is the half
  // that reads the distinction. Without it a pending call reports as "no
  // outcome was captured", which points a reader at the recorder when the
  // recorder did its job.
  if (c.pending) return null;
  const outcome = ["resolved", "returned", "rejected", "threw"].filter((k) => k in c);
  if (!outcome.length) return "no outcome was captured for this call";
  return unrevivable(c[outcome[0]]);
}

/**
 * MEMOISED per path, and that is not an optimisation.
 *
 * observingObject carries a note that its first attempt handed back a fresh
 * proxy on every property read, so \`a.x === a.x\` was false, every recursive
 * walker guarding cycles with a WeakSet looped forever, and five rows that had
 * recorded clean values stopped settling at all. A replay node that is rebuilt
 * per read is the same defect from the other side.
 */
function replayNode(path) {
  const cached = REPLAY.nodes.get(path);
  if (cached) return cached;
  const node = new Proxy(function () {}, {
    apply: (_t, _this, args) => replayCall(path, args),
    construct: (_t, args) =>
      replayDiverged(path, "the subject used \`new\` here, and the recording captured no constructed instance", Array.from(args, (a) => snap(a))),
    get(t, k) {
      // \`then\` must stay undefined or \`await\` treats the node as a thenable and
      // resolves it to itself; symbols keep their own identity for the language.
      if (typeof k === "symbol" || k === "then") return undefined;
      // An interactive transaction is NOT a recorded exchange. The live db
      // wrapper hands the callback the same client and writes down only the
      // operations INSIDE it - location-ms's googleLocationCacheMultiple reaches
      // tx.googleLocation.createMany that way - so \`$transaction\` is replayed
      // as the pass-through it was, and the calls inside it match on their own.
      if (k === "$transaction") {
        // Cached under its own path for the same identity reason as every other
        // node here: a member rebuilt on each read is the instability
        // observingObject records as its first attempt's failure.
        const at = path + ".$transaction";
        if (!REPLAY.nodes.has(at)) {
          REPLAY.nodes.set(at, async (arg, ...rest) => (typeof arg === "function" ? arg(node) : Promise.all(arg ?? [])));
        }
        return REPLAY.nodes.get(at);
      }
      // A language member is the CALLER doing .map() or String(x), not a
      // downstream call - the same discrimination observingObject makes, and for
      // the same reason: answering one from the queues invents a call the
      // recording never made.
      if (BUILTIN_MEMBER.has(k)) return Reflect.get(t, k);
      return replayNode(path + "." + String(k));
    },
  });
  REPLAY.nodes.set(path, node);
  return node;
}

/**
 * Load every exchange beneath one boundary into the queues, once.
 *
 * Rooted on a PREFIX match rather than on the boundary's own name alone,
 * because the recording writes a member call at \`<symbol>.<member>\` (and a
 * factory's product at the same path as the factory), so \`prisma\` owns
 * \`prisma.googleLocation.findFirst\` and \`fetch\` owns \`fetch.json\`.
 */
function replayRoot(symbol) {
  if (!REPLAY_MODE) return null;
  if (!REPLAY.roots.has(symbol)) {
    REPLAY.roots.add(symbol);
    REPLAY_CALLS.forEach((c, seq) => {
      const sym = String(c.symbol);
      if (sym !== symbol && !sym.startsWith(symbol + ".")) return;
      if (c.declaredNotCalled) return;
      const why = replayUnusable(c);
      if (why) {
        REPLAY_LIMITS.push({ symbol: sym, seq, why });
        return;
      }
      const ex = { ...c, seq, used: false };
      REPLAY.exchanges.push(ex);
      const key = replayKey(sym, c.args);
      if (!REPLAY.queues.has(key)) REPLAY.queues.set(key, []);
      REPLAY.queues.get(key).push(ex);
      if (!REPLAY.byPath.has(sym)) REPLAY.byPath.set(sym, []);
      REPLAY.byPath.get(sym).push(ex);
    });
  }
  return replayNode(symbol);
}

/** Was anything recorded BENEATH this path - i.e. is the thing here a collaborator? */
const replayHasMembers = (path) => {
  for (const p of REPLAY.byPath.keys()) if (p.startsWith(path + ".")) return true;
  return false;
};

/**
 * A LEAF THAT CANNOT BE THE SAME TWICE.
 *
 * This file refuses to ASSERT on arguments because "an argument can hold a
 * per-run uuid or a timestamp" - see callLedgerFor. The same fact makes an
 * argument unsafe to KEY a replayed request on, which is what replayKey does.
 * googleMap.service.ts:220 builds createdAt: new Date() into the object the
 * cache decorator writes through prisma, so the recording keys that call on the
 * record-time instant and the replay computes a fresh one.
 */
const PER_RUN_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c[a-z0-9]{24})$/i;

/**
 * Do two snapped leaves differ ONLY in the way a per-run identity differs?
 *
 * Deliberately narrow. A Date is the recorder's own "{$date}" and nothing else,
 * and a uuid/cuid is matched by shape - so two different STRINGS, two different
 * NUMBERS and a changed object key are all still a real divergence.
 */
function perRunIdentity(a, b) {
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === 1 && kb.length === 1 && ka[0] === "$date" && kb[0] === "$date";
  }
  return typeof a === "string" && PER_RUN_ID.test(a) && PER_RUN_ID.test(b);
}

/**
 * Every path at which two snapped argument lists differ, or null once a
 * difference is found that is NOT a per-run identity.
 *
 * Null is the refusal: one genuine difference anywhere means these are two
 * different requests and no amount of volatile leaves elsewhere makes them one.
 */
function volatileOnlyDiff(a, b, path = "", found = []) {
  if (a === b) return found;
  if (perRunIdentity(a, b)) return (found.push(path || "<arg>"), found);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return null;
  if (Array.isArray(a) !== Array.isArray(b)) return null;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return null;
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return null;
    if (volatileOnlyDiff(a[k], b[k], path ? path + "." + k : k, found) === null) return null;
  }
  return found;
}

/**
 * What a replayed call HANDS BACK, reconstructed as the dependency's interface.
 *
 * The recording wraps whatever a boundary returned in observingObject at the
 * SAME path, so a member of the result is written down at \`<path>.<member>\`.
 * Replay inverts that: a result the recording shows members beneath is a
 * collaborator and comes back as a node over the revived data, and a result
 * with nothing beneath it is data and comes back bare. That test is what keeps
 * a Date or a Buffer out of a Proxy - observingObject carries the measured
 * consequence of proxying one, \`Buffer.byteLength\` throwing on "an instance of
 * bound Buffer" while the row still recorded a plausible-looking outcome.
 */
function replayProduct(path, ex, raw) {
  const asResponse = replayResponse(path, ex, raw);
  if (asResponse) return asResponse.value;
  const value = revive(raw);
  if (!replayHasMembers(path)) return value;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return replayNode(path);
  return new Proxy(value, {
    get(t, k) {
      if (typeof k === "symbol" || k === "then" || BUILTIN_MEMBER.has(k)) {
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      }
      const member = path + "." + String(k);
      if (REPLAY.byPath.has(member) || replayHasMembers(member)) return replayNode(member);
      const v = Reflect.get(t, k);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/**
 * One call, matched against the observation.
 *
 * The CALLS entry is pushed here exactly as the recording pushed it, because
 * the generated test asserts the call ledger and a replayed call is a call. The
 * outcome fields are quoted from the exchange rather than re-snapshotted, and
 * \`replayed\` carries the occurrence it came from - the provenance stays on the
 * value, which is the whole rule this pipeline runs on.
 */
function replayCall(path, args) {
  const snapped = Array.from(args, (a) => snap(a));
  const queue = REPLAY.queues.get(replayKey(path, snapped));
  if (queue && queue.length) {
    const ex = queue.shift();
    ex.used = true;
    const entry = { symbol: path, args: snapped };
    if (ex.live) entry.live = ex.live;
    if (ex.journalled) entry.journalled = ex.journalled;
    for (const k of ["resolved", "returned", "rejected", "threw"]) if (k in ex) { entry[k] = ex[k]; break; }
    entry.replayed = { occurrence: ex.seq };
    // THE SEAM IS REPLAYED BY RUNNING IT, not by answering it. See the note in
    // observingFn: the recording says this boundary invoked the callback
    // exactly once, so answering from the recorded value here would skip the
    // callback and orphan every exchange the subject recorded inside it.
    //
    // Each argument the boundary handed the callback is replayed as a node
    // under its own recorded name, so a call the subject makes on it
    // (span.spanContext(), a transaction client's query) matches the exchange
    // the recording wrote for it.
    if (typeof ex.passthroughCallback === "number" && typeof args[ex.passthroughCallback] === "function") {
      entry.passthroughCallback = ex.passthroughCallback;
      pushCall(entry);
      const handed = [];
      for (let j = 0; j < (ex.callbackArity ?? 0); j += 1) handed.push(replayNode(path + ".$cb" + j));
      const produced = args[ex.passthroughCallback](...handed);
      // The SHAPE the recording observed, for the same reason the ordinary path
      // decides on it: a boundary that returned a promise must return one here
      // even when the callback happened to finish synchronously.
      return "resolved" in ex ? Promise.resolve(produced) : produced;
    }
    // NEVER SETTLES, because that is what the subject saw. The recording says
    // this call was still in flight when the row was captured, so the subject
    // reached its own end without this answer - and handing it one now would
    // run code the observation never ran.
    if (ex.pending) {
      entry.pending = true;
      pushCall(entry);
      return new Promise(() => {});
    }
    pushCall(entry);
    if ("threw" in ex) throw revive(ex.threw);
    if ("rejected" in ex) return Promise.reject(revive(ex.rejected));
    // A promise or a plain value, decided by WHICH key the recording wrote:
    // observingFn records \`resolved\` only for a thenable and \`returned\` only
    // for a settled value, so the shape of the answer is observed too.
    const isAsync = "resolved" in ex;
    const value = replayProduct(path, ex, isAsync ? ex.resolved : ex.returned);
    return isAsync ? Promise.resolve(value) : value;
  }
  const atPath = REPLAY.byPath.get(path) ?? [];
  if (!atPath.length) {
    // NOT "never called" IF THE RECORDING CALLED IT AND THE REPLAY REFUSED IT.
    // replayRoot() skips an exchange replayUnusable rejects, so without this
    // the row reports the one cause that sends a reader to look for a missing
    // call - and the call is not missing, the CAPTURE of it is. A dropped
    // failure resurfacing under another cause is how a recorder defect gets
    // read as an input defect and re-derived for the life of a run.
    const refused = REPLAY_LIMITS.filter((l) => l.symbol === path);
    if (refused.length) {
      return replayDiverged(
        path,
        "the recording HELD " + refused.length + " call(s) here and none could be replayed: " + refused[0].why +
          " - this is the recorder's capture to repair, not a call the subject made and the recording missed",
        snapped
      );
    }
    return replayDiverged(path, "the subject called a boundary the recording never called", snapped);
  }
  if (!atPath.some((e) => !e.used)) {
    return replayDiverged(path, "an EXTRA call: the recording made " + atPath.length + " call(s) here and every one has been replayed", snapped);
  }
  // THE PER-RUN IDENTITY RESCUE, and it is tried only HERE - after the exact
  // key has already missed - so no call that matches today stops matching.
  // See "perRunIdentity": a "{$date}" or a uuid/cuid the subject regenerates on
  // every execution cannot be keyed on, and a row whose request carries one is
  // otherwise unreplayable for the life of the artifact.
  const unused = atPath.filter((e) => !e.used);
  const nearly = unused
    .map((e) => ({ e, at: volatileOnlyDiff(e.args ?? [], snapped) }))
    .filter((c) => c.at !== null && c.at.length);
  if (nearly.length === 1) {
    const { e: ex, at } = nearly[0];
    ex.used = true;
    const entry = { symbol: path, args: snapped };
    if (ex.live) entry.live = ex.live;
    if (ex.journalled) entry.journalled = ex.journalled;
    for (const k of ["resolved", "returned", "rejected", "threw"]) if (k in ex) { entry[k] = ex[k]; break; }
    // PROVENANCE ON THE VALUE, the same rule the exact path follows: the row
    // says which occurrence answered it AND that it was matched on something
    // other than an identical request, so this is auditable rather than silent.
    entry.replayed = { occurrence: ex.seq, matchedDespite: at };
    pushCall(entry);
    const queue = REPLAY.queues.get(replayKey(path, ex.args));
    if (queue) REPLAY.queues.set(replayKey(path, ex.args), queue.filter((q) => q !== ex));
    if ("threw" in ex) throw revive(ex.threw);
    if ("rejected" in ex) return Promise.reject(revive(ex.rejected));
    const isAsync = "resolved" in ex;
    const value = replayProduct(path, ex, isAsync ? ex.resolved : ex.returned);
    return isAsync ? Promise.resolve(value) : value;
  }
  if (nearly.length > 1) {
    // AMBIGUITY IS A DIVERGENCE, not a coin toss. A17's lesson from the other
    // direction: answering one request out of another's recording is the silent
    // substitution this pipeline exists to make impossible.
    return replayDiverged(
      path,
      "the REQUEST differs only by per-run identity from " + nearly.length + " unreplayed recorded calls here, " +
        "so which one answers it is not determined - the recording cannot tell them apart either",
      snapped,
      nearly[0].e
    );
  }
  return replayDiverged(
    path,
    "the REQUEST changed: the recording's next unreplayed call here was made with different arguments",
    snapped,
    unused[0]
  );
}

/**
 * A divergence, and never a fallthrough.
 *
 * "No matching exchange" must not mean "call the real thing" - that is how a
 * committed suite comes to dial staging - so this throws, and it also records
 * the divergence, because a subject that CATCHES the throw (this repo's
 * decorator does exactly that: \`prisma.googleLocation.findMany(...).catch(...)\`)
 * would otherwise swallow it and the row would pass on a value the recording
 * never produced. The generated test asserts on the record, not on the throw.
 */
function replayDiverged(path, why, got, expected) {
  const detail = { symbol: path, why, request: safe(got) };
  if (expected) detail.recordedRequest = safe(expected.args ?? []);
  REPLAY_MISMATCHES.push(detail);
  pushCall({ symbol: path, args: got, replayDiverged: why });
  const e = new Error("charpilot replay: " + path + " - " + why);
  e.name = "CharpilotReplayMismatch";
  throw e;
}

/**
 * Install the row's own observation, after the default-deny and before the
 * row's declared answers, so a proposal that answers a module explicitly still
 * wins.
 *
 * The DATABASE is driven off the exchanges rather than off \`liveBoundaries\`,
 * because the recording is the authority on what was exercised: denyEgress()
 * installs the journalled client for the whole live run, so a row that never
 * declared \`prisma\` still made real queries and still wrote them down -
 * filterLocationsInsideTargetLocations-252-if-0 recorded three of them with an
 * empty boundary declaration. Keying on the declaration would have left exactly
 * those rows denied. The db wrapper writes every entry under a literal
 * \`prisma.\` prefix whatever the module exports the client as, so the root is
 * taken from the recorded symbol.
 *
 * Every other live boundary arrives through applyMock's \`live\` branch.
 */
function installReplay(row) {
  REPLAY.exchanges = [];
  REPLAY.queues = new Map();
  REPLAY.byPath = new Map();
  REPLAY.roots = new Set();
  REPLAY.nodes = new Map();
  REPLAY_LIMITS = [];
  REPLAY_MISMATCHES = [];
  REPLAY_UNRESOLVED = [];
  REPLAY_CALLS = REPLAY_MODE ? (row.boundaryCalls ?? []) : [];
  if (!REPLAY_MODE) return;
  const dbRoots = new Set(
    REPLAY_CALLS.filter((c) => c.live === "db").map((c) => String(c.symbol).split(".")[0])
  );
  for (const root of dbRoots) {
    const node = replayRoot(root);
    // Replaces the deny proxy denyEgress() registered at the same paths. The
    // deny stays in place for a row that recorded NO database call, so a
    // mutant that reaches the database from such a row is still refused rather
    // than answered.
    for (const m of DB_CLIENT_MODULES) mock(m, () => ({ prisma: node, db: node, default: node }));
  }
  // THE SAME REASONING AS THE DATABASE, for the same reason: the recording is
  // the authority on what was exercised. The transport now observes the global
  // fetch whether or not a proposal declared it, so a row can arrive here with
  // a recorded \`fetch\` exchange and an empty boundary declaration - which is
  // every one of location-ms's ten google rows. Keying the arrangement on the
  // declaration would leave exactly those rows to the hermetic transport guard,
  // which refuses the call and lands the row as a harness failure: that is what
  // "replay-unsupported" was.
  //
  // A GLOBAL, not a module, so it is assigned rather than vi.doMock'd - see
  // stubGlobal's note on why doMock("globalThis") is accepted and inert - and
  // unmockAll() restores it before the next row. Only the exact global \`fetch\`
  // is installed this way: it is the one boundary the transport itself observes,
  // and every other live boundary still arrives through applyMock.
  if (REPLAY_CALLS.some((c) => c.live && c.live !== "db" && String(c.symbol).split(".")[0] === "fetch")) {
    stubGlobal("fetch", replayRoot("fetch"));
  }
}

/**
 * Exchanges the row was arranged with and never asked for.
 *
 * A required recorded exchange left unused is a divergence in its own right and
 * the quietest one: the subject took a shorter path than the observation did,
 * every assertion on the return value can still pass, and nothing else in the
 * row would say so.
 */
function replayUnconsumed() {
  if (!REPLAY_MODE) return [];
  return [
    ...REPLAY.exchanges.filter((e) => !e.used).map((e) => ({ symbol: e.symbol, occurrence: e.seq })),
    // A REFUSED EXCHANGE IS AN UNCONSUMED ONE, and it is the half that could
    // vanish. replayRoot() drops an exchange replayUnusable rejects before it
    // reaches REPLAY.exchanges, so this list could not see it - and if the
    // subject never calls that path again, nothing diverges and the row PASSES
    // on an arrangement that was missing a call the recording holds. The
    // emitted test asserts this list is empty, so folding them in is what turns
    // a refused capture into a failing row instead of a line in a truncated
    // report nobody reads.
    ...REPLAY_LIMITS.map((l) => ({ symbol: l.symbol, occurrence: l.seq, refused: l.why })),
  ];
}

/**
 * Members that belong to the language, not to a collaborator.
 *
 * Wrapping these turned every array a boundary answered into a fake call list
 * entry, and wrapping a promise's own then/catch/finally produced an
 * unhandledRejections report for a rejection that Promise.allSettled had
 * already handled - a recorded observation production cannot have.
 */
const BUILTIN_MEMBER = new Set([
  "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "slice", "splice", "concat", "join", "indexOf", "lastIndexOf", "includes",
  "push", "pop", "shift", "unshift", "sort", "reverse", "flat", "flatMap", "fill", "at", "keys",
  "values", "entries", "length", "toString", "valueOf", "toJSON", "constructor",
  "catch", "finally", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
]);

const OBSERVED_OBJECTS = new WeakMap();
const OBSERVED_MEMBERS = new WeakMap();
function observingObject(symbol, obj, depth, producedBy) {
  if (depth > 3) return obj;
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function")) return obj;
  // A value whose state lives in INTERNAL SLOTS must not be proxied. Node reads
  // those slots directly and a Proxy over them is a different object: answering
  // readFileSync with a Buffer handed the caller a proxy whose methods were
  // v.bind(t), and Buffer.byteLength then threw
  //   The "string" argument must be of type string or an instance of Buffer or
  //   ArrayBuffer. Received an instance of bound Buffer
  // The row still recorded with invoked: true and a plausible threw, so it read
  // as sound - only the reaches verdict caught it, because the subject callback
  // was never entered. Found on profile-centralized. Same reasoning as snap()'s
  // tags: these are values, not collaborators, and there is nothing on them
  // worth observing.
  if (
    ArrayBuffer.isView(obj) ||
    obj instanceof ArrayBuffer ||
    obj instanceof Date ||
    obj instanceof RegExp ||
    obj instanceof Error ||
    obj instanceof Map ||
    obj instanceof Set ||
    obj instanceof WeakMap ||
    obj instanceof WeakSet ||
    obj instanceof Promise
  ) {
    return obj;
  }
  const cached = OBSERVED_OBJECTS.get(obj);
  if (cached) return cached;
  const proxy = new Proxy(obj, {
    get(t, k) {
      const v = Reflect.get(t, k);
      // \`then\` is excluded because wrapping it makes a plain object look
      // thenable to await; symbols because Symbol.iterator and friends must
      // keep their exact identity for the language to use them.
      if (typeof k === "symbol" || k === "then") return v;
      // An ordinary Array/Promise method is the CALLER doing .map(), not a
      // downstream call. Wrapping them recorded
      // "prisma.profile.findUnique.map" as though the boundary had a map
      // member - noise in the call list now, and a wrong assertion at stage 5.
      // Two independent agents reported it, and one of them traced a spurious
      // unhandledRejections entry to a wrapped promise method. So: only wrap a
      // member the SUBJECT could plausibly be calling on a collaborator.
      if (BUILTIN_MEMBER.has(k)) return typeof v === "function" ? v.bind(t) : v;
      if (v === null || (typeof v !== "function" && typeof v !== "object")) return v;
      let members = OBSERVED_MEMBERS.get(t);
      if (!members) { members = new Map(); OBSERVED_MEMBERS.set(t, members); }
      if (members.has(k)) return members.get(k);
      // An interactive transaction hands the callback a client, and a double's
      // own $transaction hands it the RAW object - so every call the subject
      // made inside the transaction went unobserved. location-ms lost
      // tx.googleLocation.createMany that way, and interview-service lost a
      // status flip and a whole report upsert; both agents found it only by
      // noticing which log line was ABSENT. The callback gets the observed
      // client here, so a subject inside a transaction has the same call list
      // as one outside it.
      //
      // TRANSPARENT, not observed: no CALLS entry is written for the
      // transaction itself. THE REPLAY HALF DOES NOT CONSUME ONE - replayNode
      // answers \`$transaction\` by invoking the callback, because replaying it
      // from a recorded value would skip the callback and un-make every call
      // inside it. So a recorded \`.$transaction\` exchange is one NOTHING can
      // ever ask for, and it surfaced as replayUnconsumed on every row that
      // reached a transaction: 12 of 29 on location-ms, all of them through
      // rotateApiKey, which is every Google call in the repo.
      //
      // The general rule, and the one being applied here: a seam the replay
      // treats as pass-through must not be RECORDED as an exchange. The two
      // halves are one contract - the record is the replay's only input - so a
      // disagreement between them is not a ruling to make later, it is this
      // defect.
      if (k === "$transaction" && typeof v === "function") {
        const passthrough$ = async (arg, ...rest) => {
          if (typeof arg !== "function") return v.call(t, arg, ...rest);
          return v.call(t, (inner) => arg(inner === t ? proxy : observingObject(symbol, inner, depth)), ...rest);
        };
        members.set(k, passthrough$);
        return passthrough$;
      }
      const wrapped =
        typeof v === "function"
          ? observingFn(\`\${symbol}.\${String(k)}\`, v.bind(t), depth, producedBy)
          : depth < 3
            ? observingObject(\`\${symbol}.\${String(k)}\`, v, depth + 1, producedBy)
            : v;
      members.set(k, wrapped);
      return wrapped;
    },
  });
  OBSERVED_OBJECTS.set(obj, proxy);
  return proxy;
}

/**
 * TOOL BACKLOG: A LOGGER DOUBLE HAS EVERY METHOD THE LOGGER HAS.
 *
 * A proposal answers a logger with the methods it expects its arm to call -
 * \`doubles.stub({ info: { returns: undefined } })\` - and the subject's other
 * paths call the others. tracy-agent-be's resolveFromEditScreening reached
 * \`logger.error\` and died \`logger.error is not a function\` in 4 rows of
 * \`20260922T152300Z\`, a harness failure on a boundary policy.mjs itself calls
 * in-process plumbing with nothing to fake. So the LOGGING methods the answer
 * lacks are added as no-ops that answer undefined (\`child\` answers the logger
 * itself), and the calls are recorded like the declared ones. A declared
 * method is never replaced.
 *
 * Only logging methods, from a fixed list, and only those the real logger
 * has when it could be loaded (the whole list when it could not). The name
 * match catches business objects too - an \`auditLogger\` whose \`record()\`
 * returns an id - and a method like that answering undefined would record an
 * arm the real service never takes (verifier finding on f19a528). So no
 * method outside the list is ever invented.
 */
const LOGGER_SYMBOL = /^(logger|log|loggerV2|.*Logger)$/i;
const LOGGER_LEVELS = ["error", "warn", "warning", "info", "http", "verbose", "debug", "silly", "trace", "fatal", "notice", "critical", "log", "child"];
function completeLogger(answer, real) {
  if (answer === null || (typeof answer !== "object" && typeof answer !== "function")) return answer;
  const has = (k) => { try { return typeof real?.[k] === "function"; } catch { return false; } };
  const names = real !== null && (typeof real === "object" || typeof real === "function") ? LOGGER_LEVELS.filter(has) : LOGGER_LEVELS;
  const missing = names.filter((k) => { try { return !(k in answer); } catch { return false; } });
  if (!missing.length) return answer;
  return new Proxy(answer, {
    get: (t, k, recv) => {
      if (typeof k === "string" && missing.includes(k)) return k === "child" ? () => recv : () => undefined;
      return Reflect.get(t, k, recv);
    },
    has: (t, k) => (typeof k === "string" && missing.includes(k)) || Reflect.has(t, k),
  });
}

/**
 * A PLAIN CONFIG ANSWER IS LAID OVER THE REAL CONFIG, NOT SWAPPED FOR IT.
 *
 * pricing-service run 20260924T145615Z: rows answered \`env\` (src/env.ts, the
 * parsed zod object) with the three fields their subject reads, and nothing
 * else. The module under test also runs \`new Stripe(env.STRIPE_SECRET_KEY)\` at
 * load, so the key came back undefined and 18 rows threw "Neither apiKey nor
 * config.authenticator provided" before the subject was entered - while every
 * row that left \`env\` alone, or answered it with the key included, ran. The
 * row meant "these fields are these values", not "no other field exists".
 *
 * ONLY FOR DATA. Both the real export and the answer must be plain objects
 * holding no function at any depth - a config, an enum, a constants table. A
 * collaborator (\`prisma\`, a client, a logger) is never completed this way:
 * applyMock's rule below that nothing invents a member the answer lacks is
 * what keeps a \`prisma\` double from answering undefined to every delegate.
 * The row's own fields win, so every value it declared is the value recorded.
 */
function isPlainData(o, depth = 0) {
  if (o === null || typeof o !== "object") return typeof o !== "function";
  if (depth > 8) return false;
  const proto = Object.getPrototypeOf(o);
  if (!Array.isArray(o) && proto !== Object.prototype && proto !== null) return false;
  try {
    return Object.values(o).every((x) => isPlainData(x, depth + 1));
  } catch {
    return false;
  }
}
function overlayConfig(real, answer, symbol = null) {
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) return answer;
  if (real === null || typeof real !== "object" || Array.isArray(real)) return answer;
  if (!isPlainData(real) || !isPlainData(answer)) return answer;
  const filled = Object.keys(real).filter((k) => !Object.prototype.hasOwnProperty.call(answer, k));
  if (filled.length && symbol !== null) CONFIG_OVERLAYS.push({ symbol: String(symbol), filled });
  return { ...real, ...answer };
}

/**
 * A CLASS EXPORT ANSWERED WITH AN INSTANCE IS ANSWERED AS A CLASS OF IT.
 *
 * company-enrich 20260925T072816Z, row handleEnrichment-54-if-0: the proposal
 * answered \`PrismaClient\` from \`@prisma/client\` with \`kind: "value"\`,
 * \`build: doubles.prismaClient({ companies: … })\` - an INSTANCE - and
 * companyService.ts:8 runs \`new PrismaClient({ log: ["query"] })\` at load. The
 * export became the observed object, and the row died in its arrangement:
 *
 *     __vite_ssr_import_0__.PrismaClient is not a constructor
 *
 * The row meant "a client constructed here is this one". So when the REAL
 * export is constructable and the answer is an object, the export is a class
 * whose every \`new\` hands back that one observed answer, and the construction
 * is written down like any other boundary call (\`construct: true\`).
 *
 * NOTHING ELSE CHANGES. The instance is the row's own double, observed as it
 * was before - a delegate the row did not configure still throws
 * DoubleNotConfigured and a model it did not name still does not exist, so a
 * query the row did not answer is refused, never handed plausible data. No
 * static of the real class is reachable through it, and calling it without
 * \`new\` throws a TypeError, as calling the bare object did before.
 *
 * AND A MEMBER READ ON THE EXPORT IS A MEMBER OF THE ANSWER. Constructable is
 * not the same as "used with new": axios's default export is a plain function,
 * so \`Reflect.construct\` accepts it, and every service in notification-ms
 * calls \`axios.post(...)\` on the export itself. With the wrapper alone the
 * proposals' \`{ post: … }\` answers became a bare function with no \`post\`, 25
 * recorded claims went false ("__vite_ssr_import_1__.default.post is not a
 * function"), and a run of 2026-09-25 fell from 423 to 398 sides. So the
 * wrapper reads through to the answer: \`new X()\` hands back the answer and
 * \`X.member\` is the answer's member - the two things the row declared, and
 * still nothing of the real export.
 */
function isConstructable(f) {
  if (typeof f !== "function") return false;
  try {
    Reflect.construct(String, [], f); // throws unless f is a constructor; never calls it
    return true;
  } catch {
    return false;
  }
}
function instanceClass(symbol, real, instance) {
  const name = typeof real.name === "string" && real.name ? real.name : String(symbol);
  const target = function () {};
  Object.defineProperty(target, "name", { value: name });
  return new Proxy(target, {
    construct: (_t, args) => {
      rowPush(CALLS, { symbol: String(symbol), args: Array.from(args, (a) => snap(a)), construct: true });
      return instance;
    },
    apply: () => {
      throw new TypeError(name + " is not a function - this row answered the export with an instance, so it is only constructed with new");
    },
    get: (t, k) => (Reflect.has(instance, k) ? Reflect.get(instance, k) : Reflect.get(t, k)),
    has: (t, k) => Reflect.has(instance, k) || Reflect.has(t, k),
  });
}

function applyMock(symbol, kind, real, answer) {
  // D29: \`real\` is an unloadedExport stand-in when the module could not be
  // loaded, so the export's shape is UNKNOWN - not "an object", which is what
  // an undefined \`real\` used to be read as. Decided per kind below.
  const unknown = UNLOADED_STANDINS.has(real);
  const isFn = typeof real === "function" && !unknown;

  // Live: no answer at all - the real thing runs and both halves are recorded.
  // NOT isFn ? observing(...) : real. observing() already dispatches a
  // non-function to the memoised observingObject, and the ternary short-
  // circuited before it could - so the object-boundary observation added for
  // S4-9 was DEAD on both of these paths. That is why the spy half measured
  // only 5 extra calls on this repo when it was first landed, and why a
  // winston logger declared spy on notification-ms still recorded
  // boundaryCalls: [] while its arm demonstrably ran.
  // ONE branch, two callers. "live" means "the real dependency answers this",
  // which is right for the recording and forbidden for the committed suite - so
  // the emitted test answers the same boundary from the exchanges the recording
  // wrote down. Doing it HERE rather than by emitting a different mock line keeps
  // the row body byte-identical between the two, which is the property that makes
  // a generated test the pair that was actually observed.
  if (kind === "live") return REPLAY_MODE ? replayRoot(symbol) : observing(symbol, real);

  // A DELEGATING KIND IN THE EMITTED TEST, where "the real export runs" is not a
  // thing that may happen. Without this branch a passthrough falls through to the
  // generic answer path with a null answer and installs an omni proxy answering
  // null to every call - SHADOWING the queues installReplay() has just loaded, so
  // every recorded exchange reports as never replayed and the row quarantines as
  // replay-mismatch. Guarded on REPLAY_MODE deliberately: at record time
  // "passthrough" means the real export runs, and an unguarded branch would hand a
  // --mock-db recording the real database.
  if (kind === "passthrough" && REPLAY_MODE) return replayRoot(symbol);

  // The observable is the call itself: delegate to the real export and record.
  if (kind === "spy") return observing(symbol, real);

  // notCalled is a CLAIM - "this should not be called" - and it used to be
  // implemented as a pass-through, which makes it an unenforced one: if the
  // claim is wrong the real thing runs, and for a provider client that means a
  // network call. Rows declaring AnthropicAIModelV1/VertexAIModelV1 as
  // notCalled were still reaching api.anthropic.com for exactly this reason.
  //
  // Recorded, never delegated. If the call happens it shows up in the call list
  // and stage 6 reports the contradiction, which is the whole point of the
  // declaration - without ever leaving the machine.
  if (kind === "notCalled") {
    // D29: nothing real to hand back and no shape to go by. A CALL is the
    // claim, so a call is recorded and answers undefined, as for a function.
    // A member READ is refused like the stand-in's own: an enum declared
    // notCalled is read, not called, and any value invented for the read
    // (a nested proxy, undefined) would steer a comparison without a trace.
    if (unknown) {
      return new Proxy(function () {}, {
        get: (_t, k) => real[k],
        apply: (_t, _this, args) => {
          rowPush(CALLS, { symbol, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true });
          noteNotCalled(symbol);
          return undefined;
        },
        construct: (_t, args) => {
          rowPush(CALLS, { symbol, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true, construct: true });
          return {};
        },
      });
    }
    // An OBJECT boundary declared notCalled used to be handed back REAL, which
    // makes the claim unenforced in the one direction that costs something: if
    // the claim is wrong the row reaches the actual collaborator - Postgres and
    // a GraphQL host, in the case pricing-ms found - and the recording is of a
    // real call nobody meant to make. The comment below says this branch exists
    // so the declaration is ENFORCED without leaving the machine; that was true
    // only for a function.
    //
    // Wrapped in a recording proxy instead: every member read returns a
    // function that logs the call and answers undefined, so a broken claim
    // shows up in the call list exactly as it does for a function.
    if (!isFn) {
      if (real === null || typeof real !== "object") return real;
      // notCalled means NOT CALLED, not "not read". The first version of this
      // returned a callable for every property read, which broke a legitimate
      // case immediately: Provider is an enum object declared notCalled, and
      // getAiModelV1.service.ts:188 does config.provider === Provider.ANTHROPIC
      // - a READ. With a function coming back, the comparison stopped matching
      // and two claims went false. A read of a constant is not a call, so the
      // real value is handed back and only an actual invocation is recorded.
      const denyMember = (path, member) => {
        if (typeof member !== "function") {
          return member !== null && typeof member === "object" ? denyObject(path, member) : member;
        }
        return new Proxy(function () {}, {
          apply: (_t, _this, args) => {
            rowPush(CALLS, { symbol: path, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true });
            noteNotCalled(path, symbol);
            return undefined;
          },
          construct: (_t, args) => {
            rowPush(CALLS, { symbol: path, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true, construct: true });
            return {};
          },
        });
      };
      const denyObject = (path, obj) =>
        new Proxy(obj, {
          get: (t, k) => {
            const v = Reflect.get(t, k);
            if (typeof k === "symbol" || k === "then") return v;
            return denyMember(path + "." + String(k), v);
          },
        });
      return denyObject(symbol, real);
    }
    const guard = function (...args) {
      rowPush(CALLS, { symbol, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true });
      noteNotCalled(symbol);
      return undefined;
    };
    // Its members are not reachable through the guard. See NOT_CALLED_FNS.
    NOT_CALLED_FNS.push({ symbol: String(symbol), real });
    return new Proxy(guard, {
      construct: (_t, args) => {
        rowPush(CALLS, { symbol, args: Array.from(args, (a) => snap(a)), declaredNotCalled: true, construct: true });
        return {};
      },
    });
  }

  // A logger answer is completed first (completeLogger), whatever its kind.
  // An unknown export has no methods and no fields to complete an answer from.
  const known = unknown ? undefined : real;
  const built = buildAnswer(symbol, answer);
  const given = LOGGER_SYMBOL.test(String(symbol)) ? completeLogger(built, known) : built;
  // A plain config answer keeps the real config's other fields (overlayConfig).
  const v = kind === "value" || kind === "returns" ? overlayConfig(real, given, symbol) : given;

  // THE EXPORT *IS* THE ANSWER - see SUBSTITUTE_MOCK for why this is not
  // \`returns\`. Handed to \`observing\`, which is the same dispatch a \`spy\` gets:
  // a function answer is CALLED with the subject's own arguments and both
  // halves written down, an object answer is wrapped member-wise so
  // \`prisma.cachedLocation.findMany(...)\` lands in the call list at the depth
  // it was made, and a primitive is handed back as itself.
  //
  // THE ANSWER IS NOT MADE PERMISSIVE ON ITS WAY THROUGH. Nothing here invents
  // a member the answer does not have: \`doubles.prismaClient({ cachedLocation:
  // … })\` still throws \`DoubleNotConfigured\` on a delegate the row did not
  // configure, and still has no key at all for a model it did not name. That
  // is the point - a \`prisma\` double that swallowed every delegate and
  // answered \`undefined\` would record rows that exercise nothing, and 122
  // rows of that is strictly worse than 122 visibly blocked ones.
  // Which members a value answer lacks: see VALUE_ANSWERS.
  if (kind === "value" && !unknown) VALUE_ANSWERS.push({ symbol: String(symbol), real, answer: v });
  // D70: a returns/resolves answer to a FUNCTION export forwards a member read
  // to the answer and to nothing else (the proxy's get, below), so it lacks
  // the real export's other members exactly as a value answer does.
  if ((kind === "returns" || kind === "resolves") && isFn) VALUE_ANSWERS.push({ symbol: String(symbol), real, answer: v, kind });
  // A class export answered with an instance: see instanceClass.
  if (!unknown && isConstructable(real) && kind === "value" && v !== null && typeof v === "object") {
    return instanceClass(symbol, real, observing(symbol, v));
  }
  if (kind === "value") return observing(symbol, v);

  // D29: an UNKNOWN export answered \`returns\`/\`resolves\` with an object is
  // served both ways - called, it answers the object (\`getFileStorageInstance()\`
  // returning \`{ readFileAsString }\`); read, it forwards to the object's members.
  // Read as an object alone, the factory's answer became the export itself and
  // every call of it threw "is not a function".
  const callable = isFn || (unknown && (kind === "returns" || kind === "resolves") && v !== null && (typeof v === "object" || typeof v === "function"));
  if (!callable) {
    // An object-shaped boundary. \`returns\` means the export IS this value;
    // \`rejects\`/\`throws\` mean every method on it fails that way, at any depth
    // (\`prisma.cachedLangfusePrompt.findFirst()\`), which a flat replacement
    // cannot express.
    if (kind === "returns" || kind === "resolves") {
      // Wrapped, so the members the subject calls ON the answer are recorded.
      // Returning the answer bare meant a stateful double - prismaTxPassthrough,
      // or the nested getPrisma().customerSubscription.findUnique chain - was
      // answered correctly and produced no call entries at all, which is how
      // 13 of pricing-ms's 18 rows ended up with an empty boundaryCalls while
      // their arrangements had provably landed. Same memoised wrapper as a spy,
      // so identity holds and a cycle guard still terminates.
      if (v !== null && typeof v === "object") return observingObject(symbol, v, 0);
    }
    const omni = (path) =>
      new Proxy(function () {}, {
        get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : omni(path + "." + String(k))),
        apply: (_t, _this, args) => {
          rowPush(CALLS, { symbol: path, args: Array.from(args, (a) => snap(a)) });
          if (kind === "rejects") return Promise.reject(v);
          if (kind === "throws") throw v;
          if (kind === "resolves") return Promise.resolve(v);
          return v;
        },
        construct: () => (v !== null && typeof v === "object" ? v : {}),
      });
    return omni(symbol);
  }

  const impl =
    kind === "resolves" ? async () => v
    : kind === "rejects" ? async () => { throw v; }
    : kind === "throws" ? () => { throw v; }
    : () => v;
  const fn = function (...args) {
    const entry = { symbol, args: Array.from(args, (a) => snap(a)) };
    rowPush(CALLS, entry);
    const out = impl(...args);
    // The FACTORY's product, observed. S4-39 wrapped a product in
    // observingFn's finish(), and a boundary answered returns never goes
    // through observingFn - it gets this synthetic fn instead. So the fix
    // landed in the wrong branch and pricing-ms, which reaches its database
    // through getPrisma(), recorded 18 bare getPrisma entries and 0 of the
    // queries made on the client it returns. Its agent had to make every
    // answer echo its own query into the return value to see anything, and
    // reported that convention as the workaround it is.
    //
    // The return is recorded too. This fn never did, so a row could not even
    // show which client came back.
    if (out && typeof out.then === "function") {
      return out.then(
        (r) => {
          entry.resolved = snap(r);
          return r !== null && typeof r === "object" ? observingObject(symbol, r, 1) : r;
        },
        (e) => { entry.rejected = snap(e); throw e; }
      );
    }
    entry.returned = snap(out);
    if (out !== null && (typeof out === "object" || typeof out === "function")) {
      return observingObject(symbol, out, 1);
    }
    return out;
  };
  return new Proxy(fn, {
    // Forward property reads to the ANSWER when the answer is itself a
    // function or a class. Without this the proxy hid the double's own
    // statics: \`doubles.ioredisMiss()\` returns a class carrying \`instances\`,
    // and the row reads \`(await import("ioredis")).default.instances[0].options\`
    // to get at \`retryStrategy\` - which is defined inline in the options
    // literal and reachable no other way. The read landed on the empty inner
    // \`fn\` instead and came back undefined, so 19 redis.service.ts claims were
    // false while the rows recorded plausible-looking values.
    get: (t, k) => {
      if (k in t) return t[k];
      const a = kind === "returns" || kind === "resolves" ? v : undefined;
      if (a && (typeof a === "function" || typeof a === "object") && k in a) {
        const got = a[k];
        // OBSERVED, not just bound. axios is callable, so a boundary answering
        // it takes this branch, and every axios.post the subject made was
        // served straight off the answer without ever reaching CALLS - so
        // profile-centralized's Slack row recorded boundaryCalls: [] and the
        // payload it was written to shape was unobservable. spy is no
        // alternative there: it delegates to the real axios and posts for real.
        // The object branch has wrapped its members since the S4-9 fix; this is
        // the same wrap on the callable branch.
        if (typeof got === "function") return observingFn(\`\${symbol}.\${String(k)}\`, got.bind(a), 0);
        if (got !== null && typeof got === "object") return observingObject(\`\${symbol}.\${String(k)}\`, got, 1);
        return got;
      }
      return undefined;
    },
    construct: (_t, args) => {
      rowPush(CALLS, { symbol, args: Array.from(args, (a) => snap(a)), construct: true });
      const r = impl(...args);
      // A CLASS answer has to be constructed, not returned. \`new Redis(opts)\`
      // must hand \`opts\` to the double, because redis.service.ts defines
      // retryStrategy inline in that object and the only route to it is the
      // instance's own options. Returning the class itself made every double
      // built this way collapse to \`{}\` - the class is a function, and the
      // line below discards functions.
      if (typeof r === "function") return new r(...args);
      return r !== null && typeof r === "object" ? r : {};
    },
  });
}

/**
 * FIX PLAN 1, F3.1: A FIELD ANSWER, SET ON THE ROW'S OWN RECEIVER.
 *
 * The receiver is the instance the row constructed, the exported singleton, or
 * the class for a static - whatever \`this\` is inside the subject. \`make\` builds
 * the answer once, here, after the receiver exists, so a sequence double is not
 * restarted and nothing is kept across the row's vi.resetModules().
 *
 * \`restore\` is the row's teardown list, or null for an instance the row built
 * (it dies with the row). A singleton or a class outlives the row in the same
 * module graph, so the original value - or its absence - is put back when the
 * row ends, including a row that threw.
 *
 *   spy        the field's own value, observed. An UNDEFINED field has nothing
 *              to delegate to: it stays undefined, and every read of it is
 *              written down (SPY_UNDEFINED). A row that then throws is refused
 *              by name instead of recorded - notification-ms's retry rows threw
 *              "reading 'info'" off exactly this and read as a wrong input. A
 *              row that never reads it, or reads it and copes (\`?.\`), is an
 *              ordinary observation: refusing those up front turned two verified
 *              notification-ms rows into failures.
 *   notCalled  the field's own value behind the notCalled guard, or left as it
 *              is when there is none (calling it then fails visibly).
 *   anything else  the declared answer, through applyMock with the field's own
 *              value as \`real\` - so a method field answered \`resolves\` is a
 *              function resolving that value. A primitive stays raw, as a
 *              constructor argument does.
 *
 * Every refusal is thrown before the subject is entered, so the row is a named
 * harness failure (phase: arrangement), never an observation.
 */
function setField(holder, field, symbol, kind, make, restore) {
  const refuse = (why) => {
    const e = new Error("charpilot: " + symbol + ": " + why);
    e.name = "CharpilotFieldRefused";
    return e;
  };
  if (holder === null || (typeof holder !== "object" && typeof holder !== "function")) {
    throw refuse("the row's receiver is " + (holder === null ? "null" : typeof holder) + ", so there is no instance to set the field on");
  }
  const real = holder[field];
  let next;
  if (kind === "spy") {
    if (real === undefined) {
      const own0 = Object.getOwnPropertyDescriptor(holder, field);
      try {
        Object.defineProperty(holder, field, {
          configurable: true,
          enumerable: true,
          get() { SPY_UNDEFINED.push(symbol); return undefined; },
          // The subject assigning the field ends the watch: from then on it is
          // an ordinary property holding whatever the subject put there.
          set(v) { Object.defineProperty(holder, field, { value: v, writable: true, configurable: true, enumerable: true }); },
        });
      } catch (e) {
        throw refuse("could not be watched on the receiver (" + (e instanceof Error ? e.message : String(e)) + ")");
      }
      if (restore) restore.push(() => { if (own0) Object.defineProperty(holder, field, own0); else delete holder[field]; });
      return;
    }
    next = observing(symbol, real);
  } else if (kind === "notCalled") {
    if (real === undefined || real === null) return;
    next = applyMock(symbol, "notCalled", real, () => undefined);
  } else {
    if (typeof make !== "function") return;
    const v = make();
    next = (v === null || (typeof v !== "object" && typeof v !== "function")) && typeof real !== "function"
      ? v
      : applyMock(symbol, kind, real, () => v);
  }
  const own = Object.getOwnPropertyDescriptor(holder, field);
  try {
    // defineProperty, not assignment: a getter-only accessor on the prototype
    // makes plain assignment throw in strict mode, and a field answer has to
    // shadow it on this receiver.
    Object.defineProperty(holder, field, { value: next, writable: true, configurable: true, enumerable: own ? own.enumerable : true });
  } catch (e) {
    throw refuse("could not be set on the receiver (" + (e instanceof Error ? e.message : String(e)) + ")");
  }
  if (restore) {
    restore.push(() => {
      if (own) Object.defineProperty(holder, field, own);
      else delete holder[field];
    });
  }
}

/**
 * THE CLASS'S OWN SINGLETON, when it keeps one (tool backlog; image-forwarder-ms
 * 20260924T054817Z). AzureBlobService holds
 * \`static readonly INSTANCE = new AzureBlobService(process.env.X!, ...)\`, and a
 * row whose proposal answered no constructor parameter built its receiver as
 * \`new AzureBlobService(undefined, undefined)\` - which threw in the Azure SDK
 * before the subject was entered (downloadFile-105-if-0, phase arrangement).
 * The class had already built the receiver the service itself uses.
 *
 * Returned, by NAME only: a static data property or getter of C named as a
 * singleton (SINGLETON_NAMES - INSTANCE, instance, _instance, singleton, ...),
 * or what a zero-argument getInstance()/getSingleton() returns - and only when
 * the value is an instance of C ITSELF (its prototype is C.prototype). A
 * getter or factory that throws is treated as "no singleton". Undefined
 * otherwise, and the caller constructs the class as before.
 *
 * WHY THE PROTOTYPE, NOT instanceof (verifier F1): \`Base.INSTANCE = new
 * Derived("d")\` passes \`instanceof Base\`, and a row targeting Base.hit then
 * ran Derived's override - Base.hit's own sides were never entered.
 *
 * WHY BY NAME ONLY (verifier F2): any static holding an instance used to
 * count, and \`class Money { static ZERO = new Money(0) }\` became every
 * no-ctor-arg row's receiver. A constant of the class's own type is a value,
 * not the receiver the service uses. A proposal that wants a specific
 * receiver declares its ctor args, and a declared ctor arg always wins.
 * \`default\` is no longer a singleton name: it names a value as often as a
 * receiver.
 */
/**
 * A CLASS GETTER AS THE SUBJECT IS READ WHEN THE ROW CALLS IT, NOT WHILE THE
 * ROW IS ARRANGED. qode-ptp-ms, mocked, late September 2026:
 * UnifiedATSManager's \`get sdk()\` builds \`new UnifiedTo({...})\` on first
 * read. The entry read \`inst["sdk"]\` to bind it as a method, which ran the
 * getter before the subject window opened and handed back the SDK client, and
 * the row died "t.bind is not a function" - one side ruled pipeline_defect.
 * An accessor on the receiver's prototype chain is looked up by descriptor, so
 * nothing runs early, and the subject is a function that reads it. A plain
 * method (or a setter) is bound as before.
 */
function accessorOf(inst, key) {
  for (let p = inst; p !== null && p !== undefined; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key);
    if (!d) continue;
    return typeof d.get === "function" ? () => d.get.call(inst) : null;
  }
  return null;
}
const SINGLETON_NAMES = ["INSTANCE", "instance", "_instance", "Instance", "_INSTANCE", "singleton", "_singleton", "Singleton", "SINGLETON", "shared", "sharedInstance"];
function charpilotSingleton(C) {
  if (typeof C !== "function" || C.prototype == null) return undefined;
  const ofC = (v) => v != null && typeof v === "object" && Object.getPrototypeOf(v) === C.prototype;
  for (const n of SINGLETON_NAMES) {
    const d = Object.getOwnPropertyDescriptor(C, n);
    if (!d) continue;
    if ("value" in d) {
      if (ofC(d.value)) return d.value;
    } else if (typeof d.get === "function") {
      try { const v = d.get.call(C); if (ofC(v)) return v; } catch { /* no singleton */ }
    }
  }
  for (const f of ["getInstance", "getSingleton"]) {
    if (typeof C[f] === "function" && C[f].length === 0) {
      try { const v = C[f](); if (ofC(v)) return v; } catch { /* no singleton */ }
    }
  }
  return undefined;
}

/**
 * This service deliberately fires promises it does not await -
 * sendSlackNotification at langfuse.service.ts:143, executeInBackground in the
 * usage path. With egress denied those become UNHANDLED rejections, which kill
 * the process mid-run. They are also real behaviour worth recording: a floating
 * promise that rejects is exactly the kind of thing a characterization pair
 * should pin. So they are collected per row instead of being fatal.
 */
let FLOATING = [];
let UNCAUGHT = [];
/** TOOL BACKLOG: rows a mocked row seeded, by prisma model. See installSeedDouble. */
let SEEDED = new Map();

/**
 * A mocked run's \`setup.apply.db\`: the seeded rows answer the database
 * client's READS of their model, and nothing else changes.
 *
 * Installed at every module the default-deny covers (over the deny proxy) and
 * at \`@prisma/client\`'s \`PrismaClient\` (over the real client, which in a
 * mocked run reaches a dead address, as it did before). A model nobody seeded,
 * and every write, goes to what was there before - so a row that did not seed
 * behaves exactly as it did. \`findMany\`/\`findFirst\`/\`findUnique\` (and
 * \`OrThrow\`) and \`count\` filter the seeded rows by \`where\`: equality,
 * \`equals\`, \`in\`, \`notIn\`, \`not\`, \`contains\`, \`startsWith\`,
 * \`endsWith\`, \`gt\`/\`gte\`/\`lt\`/\`lte\`, and \`AND\`/\`OR\`/\`NOT\`. An operator it
 * does not know matches nothing - it never invents a hit. \`include\` and
 * \`select\` are not applied: a seeded row is returned as it was written.
 *
 * A row that declares the client itself (\`prisma\`, \`db\`) keeps its own
 * answer: the seeds are layered over that double, so its models answer as
 * declared and the seeded models answer from the seeds.
 */
function seedMatches(row, where) {
  if (!where || typeof where !== "object") return true;
  return Object.entries(where).every(([k, c]) => {
    if (k === "AND") return [].concat(c).every((w) => seedMatches(row, w));
    if (k === "OR") return [].concat(c).some((w) => seedMatches(row, w));
    if (k === "NOT") return ![].concat(c).some((w) => seedMatches(row, w));
    const v = row[k];
    if (c !== null && typeof c === "object" && !(c instanceof Date) && !Array.isArray(c)) {
      return Object.entries(c).every(([op, x]) => {
        switch (op) {
          case "equals": return v === x;
          case "in": return Array.isArray(x) && x.includes(v);
          case "notIn": return Array.isArray(x) && !x.includes(v);
          case "not": return v !== x;
          case "contains": return typeof v === "string" && v.includes(x);
          case "startsWith": return typeof v === "string" && v.startsWith(x);
          case "endsWith": return typeof v === "string" && v.endsWith(x);
          case "gt": return v > x;
          case "gte": return v >= x;
          case "lt": return v < x;
          case "lte": return v <= x;
          case "mode": return true;
          default: return false;
        }
      });
    }
    return v === c;
  });
}
function seededModel(name, fallback) {
  const rows = () => SEEDED.get(name) ?? [];
  const pick = (args) => rows().filter((r) => seedMatches(r, args?.where));
  const reads = {
    findMany: async (args) => { const m = pick(args); return typeof args?.take === "number" ? m.slice(0, args.take) : m; },
    findFirst: async (args) => pick(args)[0] ?? null,
    findUnique: async (args) => pick(args)[0] ?? null,
    findFirstOrThrow: async (args) => { const r = pick(args)[0]; if (!r) throw Object.assign(new Error("No " + name + " found"), { code: "P2025" }); return r; },
    findUniqueOrThrow: async (args) => { const r = pick(args)[0]; if (!r) throw Object.assign(new Error("No " + name + " found"), { code: "P2025" }); return r; },
    count: async (args) => pick(args).length,
  };
  return new Proxy({}, {
    get: (_t, op) => {
      if (typeof op === "string" && Object.prototype.hasOwnProperty.call(reads, op)) return reads[op];
      const v = fallback == null ? undefined : fallback[op];
      return typeof v === "function" ? v.bind(fallback) : v;
    },
  });
}
function seededClient(base) {
  const client = new Proxy(base, {
    get: (t, k) => {
      if (typeof k === "string" && SEEDED.has(k)) return seededModel(k, t[k]);
      if (k === "$transaction") return async (arg) => (typeof arg === "function" ? arg(client) : Promise.all(arg));
      // Extended, it is still this seeded client: the deny's own \`$extends\`
      // would hand back the bare deny and drop the seeds (D30).
      if (k === "$extends") return () => client;
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return client;
}
function seedOver(answer) {
  return answer !== null && typeof answer === "object" ? seededClient(answer) : answer;
}
/**
 * A database client MODULE made of one client: every export it is asked for is
 * that client. Never built over the real module - see denyEgress.
 */
function dbModule(client) {
  return new Proxy({ prisma: client, db: client, default: client }, {
    get: (t, k) => (typeof k === "symbol" || k === "then" || k === "__esModule" ? t[k] : client === DB_DENY && !(k in t) ? namedDeny(k) : client),
    has: (_t, k) => typeof k === "string" && k !== "then",
  });
}
/** A PrismaClient class whose instances are \`make()\`. Nothing real is constructed. */
function clientClass(Real, make) {
  function PrismaClient() { return make(); }
  if (typeof Real === "function") PrismaClient.prototype = Real.prototype;
  return PrismaClient;
}
function installSeedDouble(seeds, packageAnsweredByRow, rowAnswersClient) {
  for (const s of seeds) SEEDED.set(s.model, [...(SEEDED.get(s.model) ?? []), { ...s.data }]);
  // After the row's own mocks, never alongside them: the deny at the same
  // paths must not win the resolution race (mockOrderBarrier).
  mockOrderBarrier();
  // A row that answers the client itself keeps its answer; the seeds are
  // layered over it where it is built (seedOver), not installed beside it.
  // Mocked runs only (the emitted call is guarded by !LIVE_MODE). The seeds sit
  // over the DENY and nothing else: the real client module is never imported,
  // so no export of it - a second client included - is reachable, and a model
  // nobody seeded or any write still reaches the deny.
  if (!rowAnswersClient) for (const m of DB_CLIENT_MODULES) mock(m, () => dbModule(seededClient(DB_DENY)));
  if (!packageAnsweredByRow) {
    mock("@prisma/client", async (io) => {
      const orig = await io();
      sweepRequireCache();
      return { ...orig, PrismaClient: clientClass(orig?.PrismaClient, () => seededClient(DB_DENY)) };
    });
  }
}
/**
 * A MEMBER A \`value\` ANSWER DOES NOT HAVE, CALLED WHILE THE ROW'S MODULES LOAD.
 *
 * qode-ptp-ms, mocked, late September 2026: three rows answered axios's default
 * export with a \`value\` - a function, or \`doubles.stub({ get: … })\` - that
 * had no \`create\`, and webRtc.service.ts, which a module on the way to each
 * subject imports, runs \`axios.create({...})\` at load. A value answer is the
 * whole export (#73: no member of the real one is reached), so the row died
 * "__vite_ssr_import_1__.default.create is not a function" before its
 * subject, and 10 sides were ruled pipeline_defect under a sentence that named
 * neither the boundary nor the member. Falling through to the real \`create\`
 * would hand the module a real client, so the answer is left as the row wrote
 * it and the failure says what it lacks. Said on an arrangement failure only,
 * and only for a member the real export has and the answer does not.
 */
let VALUE_ANSWERS = [];
function hasMember(o, k) {
  return o !== null && (typeof o === "object" || typeof o === "function") && k in o;
}
function valueMissingMember(err, modules) {
  const m = /\\.([\\w$]+) is not a (?:function|constructor)$/.exec(String(err && err.message) || "");
  if (!m || !err || err.name !== "TypeError") return "";
  const member = m[1];
  const hits = VALUE_ANSWERS.filter((a) => hasMember(a.real, member) && !hasMember(a.answer, member));
  if (!hits.length) return "";
  const stack = String(err.stack ?? "");
  const at = stack
    .split("\\n")
    .map((l) => /(?:\\(|at )((?:file:\\/\\/)?\\/[^():]+):\\d+:\\d+\\)?\\s*$/.exec(l)?.[1])
    .find((f) => f && !/[\\\\/]node_modules[\\\\/]/.test(f) && !/\\.(?:test|spec)\\.[cm]?[jt]sx?$/.test(f));
  const where = at ? at.replace(/^file:\\/\\//, "").replace(process.cwd() + "/", "") : "a module the row loads";
  const loading = /\\.(?:runModule|directRequest|_runInlinedModule) |ModuleJob\\.run/.test(stack);
  const names = hits.map((a) => \`\${a.symbol}\${modules[a.symbol] ? \` (module \${modules[a.symbol]})\` : ""}\`).join(", ");
  const sym = hits[0].symbol;
  const when = loading ? "while it loads" : "before the subject was entered";
  // D70: the returns/resolves form. qode-ptp-ms 20260927T061823Z,
  // packet-118-row-1483-binary-expr-EN answered axios \`returns { get }\`:
  // right for the subject's own \`axios.get\`, which the double forwards to the
  // answer, and the load died on webRtc.service.ts's \`axios.create()\` with
  // Node's bare TypeError - ruled pipeline_defect on 2 sides.
  if (hits[0].kind) {
    return \`; \${where} calls \${sym}.\${member}() \${when}, and the row answered \${names} with a "\${hits[0].kind}" answer that has no \${member} - a \${hits[0].kind} answer to a function export is that function, and a member read on it reaches the answer's own members and no member of the real one: the answer must include \${member}\`;
  }
  return \`; \${where} calls \${sym}.\${member}() \${when}, and the row answered \${names} with a "value" that has no \${member} - a value answer is the whole export, so no member of the real one is reached: the answer must include \${member}\`;
}
/**
 * A \`notCalled\` ANSWER THAT THE ROW'S OWN MODULES CALL, AND USE (D42).
 *
 * qode-ptp-ms, mocked, late September 2026:
 * generateCandidateFitPoints-365-if-0-then declared zod's \`z\` notCalled -
 * true of the subject, which returns before its own \`z.array(...)\` - but a
 * module on the way to it builds a schema at load
 * (\`z.string().default(...)\`). A notCalled answer records the call and
 * answers undefined, so the load died "Cannot read properties of undefined
 * (reading 'default')" and 8 sides were ruled pipeline_defect under a
 * sentence that named neither the boundary nor the call. The answer is left
 * as the row wrote it - a notCalled answer that ran the real export would
 * make the claim unenforced - and the failure says which declared call the
 * failing line used. Said on an arrangement failure only, and only when the
 * TypeError is thrown on the line of a notCalled call (or up to 5 lines
 * below it, for a chain split across lines) in the same file.
 *
 * AND A MEMBER OF A FUNCTION EXPORT ANSWERED notCalled. The same run, once
 * the rows got past their enums: updateProfile-empty-611-624-638 declared
 * axios notCalled, and webRtc.service.ts calls axios.create() at load. A
 * notCalled function export is the guard function alone, so the load died
 * "__vite_ssr_import_1__.default.create is not a function" with no word of
 * the answer. On an arrangement failure "X.m is not a function (or
 * constructor)", where m is a member the real export has, it now says so.
 */
let NOT_CALLED_AT = [];
let NOT_CALLED_FNS = [];
function repoFrames(stack) {
  return String(stack ?? "")
    .split("\\n")
    .map((l) => /(?:\\(|at )((?:file:\\/\\/)?\\/[^():]+):(\\d+):\\d+\\)?\\s*$/.exec(l))
    .filter((m) => m && !/[\\\\/]node_modules[\\\\/]/.test(m[1]) && !/\\.(?:test|spec)\\.[cm]?[jt]sx?$/.test(m[1]))
    .map((m) => ({ file: m[1].replace(/^file:\\/\\//, ""), line: Number(m[2]) }));
}
/**
 * D73: A SUBJECT WHOSE MODULE IS ON AN IMPORT CYCLE IS ENTERED WHERE THE
 * SERVICE ENTERS IT (record.mjs cycleImporters has the case).
 *
 * \`importers\` is [[file, load]] for each file that imports the subject's
 * module and is reached by its imports. The subject is imported first, as
 * always. A load that throws a TypeError, or a ReferenceError from the
 * temporal dead zone, whose first repo frame is in one of those files is the
 * cycle's back edge reading the subject half-loaded. Then the registry is reset and
 * that file is imported first. It imports the subject whole before its own
 * module scope uses it, and the subject's import then returns from the cache.
 * vi.resetModules() keeps the mock registry, so the row's answers stand. The
 * calls the failed load recorded are dropped, because the second load makes
 * them again. The recording and the emitted suite run the same text, so the
 * replay takes the same path. A subject that imports cleanly is never retried.
 * When the second order fails too, its error is the row's, and CYCLE_TRIED
 * says on the harness failure that both orders were tried.
 */
let CYCLE_TRIED = null;
async function charpilotThroughCycle(load, importers) {
  const before = CALLS.length;
  try {
    return await load();
  } catch (e) {
    const cyclic = e && (e.name === "TypeError" || (e.name === "ReferenceError" && /before initiali[sz]ation/.test(String(e.message))));
    const top = cyclic ? repoFrames(e.stack)[0] : null;
    const hit = top ? importers.find(([file]) => top.file === file || top.file.endsWith("/" + file)) : null;
    if (!hit) throw e;
    vi.resetModules();
    if (CALLS.length > before) CALLS.length = before;
    try {
      await hit[1]();
      return await load();
    } catch (again) {
      CYCLE_TRIED = { importer: hit[0], first: String(e.message).slice(0, 200) };
      throw again;
    }
  }
}
function noteNotCalled(path, root = path) {
  if (NOT_CALLED_AT.length < 50) NOT_CALLED_AT.push({ path: String(path), root: String(root), at: repoFrames(new Error().stack)[0] ?? null });
}
function notCalledUsed(err, modules) {
  if (!err || err.name !== "TypeError") return "";
  const top = repoFrames(err.stack)[0];
  if (!top) return "";
  const loading = /\\.(?:runModule|directRequest|_runInlinedModule) |ModuleJob\\.run/.test(String(err.stack ?? ""));
  const when = loading ? "while it loads" : "before the subject was entered";
  const member = /\\.([\\w$]+) is not a (?:function|constructor)$/.exec(String(err.message ?? ""))?.[1];
  const fn = member ? NOT_CALLED_FNS.find((a) => hasMember(a.real, member)) : null;
  if (fn) {
    const mod = modules[fn.symbol];
    return \`; \${top.file.replace(process.cwd() + "/", "")}:\${top.line} calls \${fn.symbol}.\${member}() \${when}, and the row declared \${fn.symbol}\${mod ? \` (module \${mod})\` : ""} notCalled - a notCalled answer to a function export is that function alone, so no member of the real one is reached: declare \${fn.symbol} "passthrough" (or "spy") when the code the row loads uses it, or answer it with a "value" that includes \${member}\`;
  }
  if (!NOT_CALLED_AT.length) return "";
  const hit = NOT_CALLED_AT.find((c) => c.at && c.at.file === top.file && top.line >= c.at.line && top.line - c.at.line <= 5);
  if (!hit) return "";
  const where = hit.at.file.replace(process.cwd() + "/", "");
  const module = modules[hit.root];
  return \`; \${where}:\${hit.at.line} calls \${hit.path}() \${when} and uses what it returns, and the row declared \${hit.root}\${module ? \` (module \${module})\` : ""} notCalled - a notCalled answer records the call and returns undefined, so what that line built from it is undefined: declare \${hit.root} "passthrough" (or "spy") when the code the row loads uses it\`;
}
/** FIX PLAN 1, F3.1: reads of a spied field that was undefined, this row. See setField. */
let SPY_UNDEFINED = [];
/**
 * TOOL BACKLOG: constructor parameters this row's subject was built with as
 * \`undefined\`, because no proposal answered them. Said on a harness failure
 * so it is the proposal's to repair, not a reasonless one: assessment-service
 * AiCentralizationService(type) threw "No AI-centralization api key configured
 * for type: undefined" in 6 rows of 20260922T101156Z.
 */
let CTOR_UNDEFINED = [];
/**
 * Boundaries this row answered with a STRING HOLDING JSON TEXT where the
 * real export is not a string. cv-parsing-ms (September 2026) answered @/env
 * with \`"value": "{ \\"CV_PROCESSOR\\": \\"VERTEX\\" }"\` - JSON text, where
 * \`value\` is the JSON itself - so env became that string, a module-scope
 * \`Buffer.from(env.GOOGLE_PRIVATE_KEY, "base64")\` read undefined while the
 * subject's module loaded, and 7 sides were lost as pipeline_defect under
 * Node's bare TypeError, which names neither the boundary nor the encoding.
 * Said on an arrangement failure so it is the proposal's to repair.
 */
let VALUE_AS_TEXT = [];
function noteValueAsText(symbol, module, real) {
  if (real === undefined || real === null || typeof real === "string") return;
  VALUE_AS_TEXT.push(symbol + " from " + module + " (whose real export is " + (typeof real === "function" ? "a function" : Array.isArray(real) ? "an array" : "an object") + ")");
}
/**
 * A THROW FROM THE PROPOSAL'S OWN MOCK BUILD is the proposal's. qode-ptp-ms,
 * mocked, late September 2026: one row answered \`prisma\` with
 * \`doubles.prismaClient({ meeting: { findFirst: { resolves: { …,
 * aiInterviewerId: None } } } })\` - Python's None in JavaScript - and another
 * built \`doubles.prismaClient({ useCase1: … })\` and then assigned
 * \`p.candidate.findFirst\` on a model it had not named. Each build threw
 * inside vitest's module factory, vitest reported "There was an error when
 * mocking a module" with the build's own error on \`cause\`, and 17 sides were
 * ruled pipeline_defect. Noted here with the boundary it was building; said on
 * the harness failure only when that error is what failed the row and it was
 * thrown by the build's own text (its first frame is this spec), and never for
 * a name the row declared as a boundary, which it is the harness's to bind.
 */
let MOCK_BUILD_THREW = [];
function buildAnswer(symbol, answer) {
  try {
    return answer();
  } catch (e) {
    MOCK_BUILD_THREW.push({ symbol: String(symbol), error: e });
    throw e;
  }
}
const SPEC_BASENAME = String(import.meta.url).split("?")[0].split("/").pop();
const PYTHON_LITERALS = { None: "null", True: "true", False: "false" };
function mockBuildThrew(err, modules, declared) {
  const chain = [];
  for (let e = err, i = 0; e && typeof e === "object" && i < 5; e = e.cause, i++) chain.push(e);
  const own = MOCK_BUILD_THREW.find(({ error: e }) => {
    if (!chain.includes(e) || !(e instanceof Error) || /^Charpilot/.test(e.name)) return false;
    const top = String(e.stack ?? "").split("\\n").find((l) => /^\\s+at /.test(l)) ?? "";
    if (!SPEC_BASENAME || !top.includes(SPEC_BASENAME)) return false;
    const undef = e.name === "ReferenceError" ? /^([\\w$]+) is not defined$/.exec(e.message) : null;
    return !(undef && declared.includes(undef[1]));
  });
  if (!own) return "";
  const e = own.error;
  const undef = e.name === "ReferenceError" ? /^([\\w$]+) is not defined$/.exec(e.message) : null;
  const py = undef && PYTHON_LITERALS[undef[1]] ? \` (\\\`\${undef[1]}\\\` is Python; JavaScript writes \\\`\${PYTHON_LITERALS[undef[1]]}\\\`)\` : "";
  const module = modules[own.symbol];
  return \`; thrown by the proposal's own build of \${own.symbol}\${module ? \` (module \${module})\` : ""} while the row's doubles were built: \${e.name}: \${String(e.message).slice(0, 200)}\${py} - repair the build\`;
}
/**
 * D43: A NAME THE PROPOSAL'S OWN BUILD USES AND NOTHING BINDS is the
 * proposal's. ats-sourcing-service and turing-integration-ms, the mocked runs
 * of September 26: proposals with via "export unifiedService" and via "export
 * interviewService" wrote invoke.build as
 *   (path, opts) => (unifiedService as any).sandboxFetch(path, opts)
 *   () => interviewService.newInterview({ ... })
 * and never imported the binding. A build runs in the row's own scope: via
 * names the driver and binds nothing, and invoke.build is not given the
 * declared boundaries either. The arrow was built, called after the snapshot,
 * and threw "unifiedService is not defined" - 11 rows ruled pipeline_defect
 * as "the harness failed on this row (unknown phase)". Said only when the
 * ReferenceError's first frame is this spec (the build's own text) and the
 * name is one a build of this row writes; \`builds\` is [{ where, words }] and
 * \`exports\` maps a word the subject's own file exports to that file.
 */
function buildUnboundName(err, { builds, exports }) {
  if (!err || typeof err !== "object" || err.name !== "ReferenceError") return "";
  const undef = /^([\\w$]+) is not defined$/.exec(String(err.message));
  if (!undef) return "";
  const top = String(err.stack ?? "").split("\\n").find((l) => /^\\s+at /.test(l)) ?? "";
  if (!SPEC_BASENAME || !top.includes(SPEC_BASENAME)) return "";
  const name = undef[1];
  const hit = builds.find((b) => b.words.includes(name));
  if (!hit) return "";
  const how = exports[name]
    ? \`import it there: \\\`const { \${name} } = await import("\${exports[name]}")\\\`\`
    : "import it there, from the module that exports it";
  return \`; \${name} is named by the proposal's own \${hit.where} and bound nowhere - a build sees only what it imports itself (via names the driver and binds nothing): \${how} - repair the build\`;
}
/**
 * TOOL BACKLOG: a throw from the proposal's own invoke.build is the
 * proposal's. outreach-thread-ms app.ts:44 (20260922T130927Z) built its
 * subject through \`app.app._router.stack\`, which Express 5 no longer has,
 * and two rows died "Cannot read properties of undefined (reading 'stack')"
 * as reasonless harness failures. The error is kept as it was and marked.
 */
/**
 * FLUSH THE ROW'S QUEUED MOCKS BEFORE ITS OWN CODE RUNS.
 *
 * vi.doMock only QUEUES; vitest registers the queue on the next dynamic import,
 * and it does so with the builtins as they are at that moment
 * (resolveMocks: \`Promise.all(group.map(resolveMock))\`). assessment-service
 * 20260925T072836Z: two proposals captured an inline runs.map callback with an
 * invoke.build that set \`Array.prototype.map = function (fn) { captured = fn;
 * return []; }\` and THEN imported the subject. The queue went through the
 * patched map, came back empty and was cleared - every mock of the row,
 * \`/src/db\`'s prisma answer included, was dropped without a word, the real
 * src/db built its client from the default-deny, and 4 sides were lost as
 * "blocked egress: prisma.promptTestRun ... binding failure".
 *
 * So the harness makes that next import itself, before any build: a fresh
 * (query-unique) import of the doubles module, which has no side effects. It
 * relies on vi.doMock's documented contract - applied on the next dynamic
 * import - and on nothing inside vitest. MOCKS_FLUSHED says it happened, so a
 * later deny can tell "installed and bypassed" from "never registered".
 *
 * D47: IMPORTED \`?raw\`, SO NO HOST TRANSFORM HAS TO ACCEPT IT. qode-itl-be
 * (NestJS, unplugin-swc 1.5.9), the mocked run of September 26: the flush
 * imported the doubles module as \`doubles.ts?charpilot-mock-flush=N\`.
 * unplugin-swc tests its filter (\`/\\.m?[jt]sx?$/\`) against the id with the
 * query on, so it declined the file, and its config() hook had already turned
 * vite's own TypeScript transform off: the TypeScript reached vite-node as
 * written, the import threw "'const' declarations must be initialized", and
 * every one of the 1039 rows came out \`mocksNotFlushed: true\` - under record,
 * cigate and measure alike, since the corpus carries this same code. (vitest
 * resolves the queue before it transforms, so the mocks did register; what was
 * lost is this flag, and a blocked-egress row over an installed answer then
 * blamed the queue for it.) vite's own asset plugin answers \`?raw\` with
 * \`export default "<the file's text>"\` - plain JavaScript, which no host
 * plugin needs to transform and none can break, and which runs nothing of the
 * doubles module. The import is still query-unique, so vitest 4 and 5, which
 * register the queue only when they fetch a module they have not evaluated,
 * still do.
 */
let MOCK_FLUSH_N = 0;
let MOCKS_FLUSHED = null;
async function flushQueuedMocks(spec) {
  MOCK_FLUSH_N += 1;
  MOCKS_FLUSHED = false;
  try {
    await import(/* @vite-ignore */ spec + "?raw&charpilot-mock-flush=" + MOCK_FLUSH_N);
    MOCKS_FLUSHED = true;
  } catch {
    // Nothing to flush through; the subject's own import registers the queue, as before.
  }
}
/**
 * The require() an invoke.build calls, for the repo modules it names (D41, see
 * repoRequires): each is imported through vite first, so the row's module
 * mocks apply to it and its counters move, and require(id) hands back that
 * module. A request named nowhere in the list, or one vite could not resolve,
 * goes to node's own require as written; a module that threw while vite
 * evaluated it throws that again, since loading it a second time outside vite
 * would run something the row never arranged.
 */
async function charpilotRepoRequire(specs) {
  const nodeRequire = createRequire(import.meta.url);
  const loaded = new Map();
  const failed = new Map();
  for (const [asWritten, spelling] of specs) {
    try { loaded.set(asWritten, await import(/* @vite-ignore */ spelling)); } catch (e) { failed.set(asWritten, e); }
  }
  const unresolved = (e) => /Failed to load url|Cannot find (module|package)|ERR_MODULE_NOT_FOUND|ERR_LOAD_URL/.test(String(e && typeof e === "object" ? e.code + " " + e.message : e));
  const required = function (id) {
    if (loaded.has(id)) return loaded.get(id);
    if (failed.has(id) && !unresolved(failed.get(id))) throw failed.get(id);
    return nodeRequire(id);
  };
  return Object.assign(required, { resolve: nodeRequire.resolve, cache: nodeRequire.cache });
}
/**
 * AND THE BUILTINS A BUILD REASSIGNED ARE PUT BACK.
 *
 * Captured once, when the spec loads. A build that patches a prototype method
 * and forgets (or throws before) its own restore would otherwise hand every
 * later row - and the harness itself, which calls .map on every snap - a
 * different language. Only methods that EXISTED at load and were replaced are
 * restored; a member the subject's code ADDED (a polyfill) is left alone.
 * Named on the row as builtinsRestored.
 */
const BUILTIN_PROTOTYPES = [
  ["Array", Array.prototype], ["Object", Object.prototype], ["Function", Function.prototype],
  ["Promise", Promise.prototype], ["String", String.prototype], ["Map", Map.prototype], ["Set", Set.prototype],
];
const BUILTINS_AT_LOAD = BUILTIN_PROTOTYPES.map(([name, proto]) => [name, proto, Object.getOwnPropertyDescriptors(proto)]);
// node loads fetch's classes (undici, and zlib under it) LAZILY, on the first
// read of the global - and recordResponseStatus reads \`Response\` from inside
// the first boundary call a row makes. In the assessment-service rows above
// that call landed inside the build's patched map, zlib's own module-scope
// Math.max(...[].map()) came back -Infinity, and the row died "Invalid typed
// array length: -Infinity" - a harness failure no proposal could repair. So the
// globals the harness reads are loaded here, while the builtins are the real ones.
try { void globalThis.Response; void globalThis.Headers; void globalThis.fetch; } catch { /* no fetch on this runtime */ }
function restoreBuiltins() {
  const restored = [];
  for (const [name, proto, was] of BUILTINS_AT_LOAD) {
    for (const key of Reflect.ownKeys(was)) {
      const now = Object.getOwnPropertyDescriptor(proto, key);
      const d = was[key];
      if (now && now.value === d.value && now.get === d.get && now.set === d.set) continue;
      try {
        Object.defineProperty(proto, key, d);
        restored.push(name + ".prototype." + String(key));
      } catch {
        // non-configurable and changed: nothing a harness can do
      }
    }
  }
  return restored;
}
function charpilotBuildFailed(e) {
  if (e !== null && typeof e === "object") {
    try { Object.defineProperty(e, "__charpilotBuild", { value: true, enumerable: false }); } catch { /* frozen: say nothing */ }
  }
  return e;
}
/**
 * D27: A CONSTRUCTOR SUBJECT THAT THROWS WHILE ITS OWN MODULE LOADS HAS RUN.
 * email-centralization-ms and whatsapp-ms (September 2026) construct their
 * services at module scope - export const graphQLService = new
 * GraphQLService() - and the constructor refuses an unset var:
 * if (!env.GRAPHQL_API_URL) throw new Error("GRAPHQL_API_URL is not defined").
 * A row for that THEN side answers the var falsy, so the import of the
 * subject's module IS the constructor call, and it throws before the explicit
 * construction below it is reached. The recorder ruled every such throw an
 * arrangement failure, and 9 sides across the two repos were lost as
 * pipeline_defect with the constructor's own message.
 *
 * Adopted as the subject's only when the thrown error's stack holds a frame of
 * the subject's own constructor, in the subject's own file: another module's
 * load refusal, a boot-schema ZodError, a mock factory that threw - none of
 * them has that frame - stay arrangement failures, as before.
 */
function thrownInConstructor(err, className, file) {
  if (!className || err === null || typeof err !== "object") return false;
  const stack = String(err.stack ?? "");
  const base = String(file ?? "").split("/").pop().replace(/\\.[cm]?[jt]sx?$/, "");
  const frame = "new " + className + " (";
  return stack.split("\\n").some((l) => l.includes(frame) && (!base || l.includes(base)));
}
/**
 * The subject window for a constructor that threw at its module's import:
 * the subject's FILE is diffed from just before that import, every other file
 * from now - so the module graph the import loaded is still the arrangement's,
 * and only what the subject's own module ran is credited to the subject.
 */
function subjectImportWindow(atImport, file) {
  const now = covSnapshot();
  const out = {};
  for (const p of Object.keys(now)) {
    if (relFile(p) !== file) out[p] = now[p];
    else if (atImport[p]) out[p] = atImport[p];
  }
  return out;
}
process.on("unhandledRejection", (reason) => {
  FLOATING.push(
    reason instanceof Error ? { name: reason.name, message: String(reason.message).slice(0, 200) } : { name: "non-error", value: safe(reason) }
  );
});
// AND A THROW FROM A TIMER AFTER THE ROW SETTLED. express-jwt calls its
// callback from setImmediate, so a row handing jwtHandler "next: null" returned
// cleanly and THEN threw "next is not a function" (nginx bench, 2026-09-24).
// The row read as clean, and the suite emitted from it failed: vitest counts
// an uncaught exception as an error and exits 1, and stage 6 then trusts no
// number it measured. Recorded on the row, beside unhandledRejections.
process.on("uncaughtException", (err) => {
  UNCAUGHT.push(
    err instanceof Error ? { name: err.name, message: String(err.message).slice(0, 200) } : { name: "non-error", value: safe(err) }
  );
});

/**
 * A PROCESS LISTENER A ROW'S SUBJECT INSTALLED DOES NOT OUTLIVE THE ROW.
 *
 * A server class commonly wires its shutdown in its constructor:
 * process.on("SIGTERM", () => gracefulShutdown()), with gracefulShutdown
 * calling this.server.close(). A row that constructs it with an app double
 * (listen answering { on }) leaves that listener on the one process every
 * later row and the test runner share. vitest's fork pool then SIGTERMs the
 * worker when the file ends, every leaked handler fires on its long-gone
 * instance, and "this.server.close is not a function" lands as an unhandled
 * rejection attributed to no test (ai-centralization server.ts, September
 * 2026): the suite is red, cigate cannot withhold a row for it, and stage 6
 * trusts no number it measured.
 *
 * So the lifecycle listeners (signals, uncaught errors, exit) are
 * snapshotted when the row starts and anything added since is removed once
 * the row has settled, beside __restore. What the row itself observed is
 * unchanged: a listener it installed was there for every call it made. The
 * harness's own collectors above, and vitest's, predate every row and stay.
 * IPC events ("message", "disconnect") are the runner's channel and are left
 * alone.
 */
const PROCESS_LIFECYCLE_EVENTS = new Set([
  "uncaughtException", "uncaughtExceptionMonitor", "unhandledRejection", "rejectionHandled",
  "beforeExit", "exit", "warning", "multipleResolves",
]);
function isLifecycleEvent(name) {
  return typeof name === "string" && (name.startsWith("SIG") || PROCESS_LIFECYCLE_EVENTS.has(name));
}
function processListenersNow() {
  const at = new Map();
  for (const ev of process.eventNames()) if (isLifecycleEvent(ev)) at.set(ev, new Set(process.rawListeners(ev)));
  return at;
}
function dropRowProcessListeners(before) {
  for (const ev of process.eventNames()) {
    if (!isLifecycleEvent(ev)) continue;
    const had = before.get(ev);
    for (const l of process.rawListeners(ev)) {
      if (!had || !had.has(l)) {
        try { process.removeListener(ev, l); } catch { /* a listener that cannot be removed stays */ }
      }
    }
  }
}
`;

/**
 * `rowTimeoutMs` is a PARAMETER and not the module constant, because the two
 * callers hold different authorities over it. A recording (`mode === "record"`,
 * and `--emit-specs`) is the run that chooses the budget, so it passes its own
 * flag - the default below keeps that byte-identical. `--emit-tests` is not:
 * the budget its file bakes in belongs to the rows it is asserting, and it
 * reads it off them (see `resolveRowTimeout`). Before this it took whatever the
 * emit command was typed with, which is how a spec came to carry a ceiling no
 * row had ever been observed under.
 */
/**
 * STAGE 5 IS HERMETIC. Stage 4 may call live staging; the committed suite may
 * not.
 *
 * `--live` was inlined into every emitted file verbatim - `LIVE_MODE = true`
 * plus the run's whole allowlist - so the database default-deny never installed
 * and a `passthrough` boundary stayed real. Measured on location-ms: five live
 * rows emitted a suite that opened a real staging postgres connection and was
 * allow-listed for billed Google calls on EVERY run of the suite, in CI and on
 * anyone's laptop.
 *
 * The recorded value is the assertion. The live arrangement is not part of it,
 * so it is stripped at the moment the test is written rather than left to a
 * flag nobody passes. A row that cannot reproduce without the real call now
 * FAILS on the first verify and gets quarantined with that reason - which is
 * the honest outcome, and visible, where dialing staging from CI was neither.
 */
/**
 * The SHAPE of each env var `src/env.ts` declares, keyed by name.
 *
 * Replaces a list of names to OMIT. Omitting a defaulted variable was the
 * first fix for a placeholder its schema rejected, and it broke the other way:
 * `ZIPKIN_COLLECTOR_ENDPOINT: z.string().default("")` got no stamp, so replay
 * read `""`, `src/tracer.ts:16` built `new URL("")`, and the row threw
 * `TypeError: Invalid URL` at import. A variable staging SET is one the replay
 * needs a value for - the recording never consulted that default.
 */
function envSchemaShapes() {
  try {
    const e = JSON.parse(readFileSync(BASELINE_JSON, "utf8")).envDefaults ?? {};
    return new Map((e.shapes ?? []).map((v) => [v.name, v]));
  } catch {
    return new Map();
  }
}

/**
 * A value that satisfies a schema and is true of nothing.
 *
 * ONE DEFINITION, TWO READERS: the per-spec prelude `envPrelude` writes, and
 * the `recorded.env` stamped beside the suite. They used to be one reader and a
 * comment claiming the other existed, and this pipeline has now paid twice for
 * two copies of one rule drifting apart - `localrun.py` against
 * `fleetprobe.mjs` on the model pin, and `baseline.mjs` against `record.mjs` on
 * what counts as a default.
 *
 * Chosen by NAME, which is a real limit and has bitten once: a boolean or
 * numeric variable gets `charpilot-placeholder` and its schema rejects it. That
 * is why `baseline.mjs` must not report a defaulted variable as required - see
 * `helperDefaults` - because a variable that never needed a placeholder is the
 * only one this can be wrong about.
 */
export function inertEnvValue(name, shape = null) {
  // THE SHAPE FIRST, because it is the thing a schema actually rejects. Chosen
  // by name alone, this returned a string for everything, and two rounds of
  // that failed in opposite directions - `PORT: envNumber(4005)` came back
  // `Expected number, received "charpilot-placeholder"`, and omitting every
  // defaulted variable instead left `ZIPKIN_COLLECTOR_ENDPOINT:
  // z.string().default("")` to replay as `new URL("")`.
  if (shape?.kind === "enum" && shape.member) return shape.member;
  // Never 0: a numeric env var is frequently a port, a timeout or a limit, and
  // several of those are read as `|| DEFAULT` or checked for truthiness.
  if (shape?.kind === "number") return "1";
  if (shape?.kind === "boolean") return "false";
  // A URL RULE (baseline.mjs envKind): the http placeholder below fails an
  // `https:` refine at import (ats-sourcing-service, run 20260925T072715Z).
  if (shape?.kind === "url") return "https://charpilot.invalid";
  // ONE placeholder for a database, config.mjs's, so the stamp, the prelude
  // and the recorder's masked env all say the same thing.
  if (/DATABASE_URL|POSTGRES|_DSN$/i.test(name) || isDatabaseVar(name)) return databasePlaceholder(name);
  if (/URL|HOST|ENDPOINT/i.test(name)) return "http://charpilot.invalid";
  return "charpilot-placeholder";
}

/**
 * The env the suite needs, stamped beside it - NAMES from the recording, values
 * that are true of nothing.
 *
 * TWO READERS AND NO WRITER. `vitest.coverage.config.mts:26` says "the suite's
 * OWN recorded.env first - stage 5 stamps it next to the tests precisely so the
 * measurement can reproduce the recording", and `verify-generated.mjs:37`
 * defaults `--env-file` to it. Nothing wrote it. So both readers fell back to
 * `out/staging.env`, which `docker/finish.py` excludes from the commit - and
 * the corpus was therefore not reproducible off the branch it was pushed on.
 *
 * MEASURED on notif-prod: the suite is 79 of 79 green with `out/staging.env`
 * present and 74 of 79 with an empty env. The five that fail are
 * `services-telegramBot.service.char.test.ts`, on
 * `the downstream calls changed` - `telegramBot.service.ts:216` reads
 * `env.TELEGRAM_BOT_TOKEN` and short-circuits when it is empty, so the row
 * makes one downstream call where the recording made four. Nothing about that
 * failure names an env file, which is why a CI check added without this stamp
 * would have gone red for a reason no reviewer could find.
 *
 * INERT, NEVER THE RECORDED VALUES. The names come from the env file the
 * recording used; not one value does. This file is COMMITTED, and the recording
 * env is staging's: `staging.env` holds `DATABASE_URL`, `JWT_SECRET`,
 * `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `TELEGRAM_BOT_TOKEN` and
 * `TELEGRAM_WEBHOOK_SECRET` among sixteen. A stamp that copied them would put
 * six live credentials in a pull request, which is a worse defect than the one
 * it fixes and is not recoverable by editing the branch.
 *
 * SUPERSEDED IN PART (keptEnvValue): the credentials stay inert, and so do
 * addresses, but CONFIGURATION is now stamped as recorded - and a mocked row is
 * RECORDED under this same env (buildEnv). The old rule let the suite run under
 * values it was not recorded under, and "that failure is correct" did not
 * survive contact with CI: cv-parsing-ms #67 went red on a processor name.
 */
/**
 * The inert value for every name an env file sets, by the one rule both the
 * stamp and the per-spec prelude use (tool backlog).
 *
 * By shape and name (inertEnvValue), except for a KEY and for what a key
 * decrypts: a PEM value gets a stand-in of the same kind that the code can
 * decode, and a value the env's own public key decrypts gets the placeholder
 * encrypted under the stand-in (envfile.mjs placeholderCiphertext).
 * \`PUBLIC_KEY=charpilot-placeholder\` made pricing-ms's cipher.ts throw on
 * import in 94 of 184 emitted tests.
 */
/**
 * The env TEXT the recording ran under, for the stamp and the prelude: the env
 * file, and below it the stand-ins buildEnv applied. Values from the env file
 * are made inert by `inertEnv`; a stand-in is inert already and kept as it is,
 * so the emitted suite sees exactly what the recorder saw.
 */
function recordingEnvText() {
  const file = ENV_FILE && existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const lines = standInLines(standInPlan().values);
  return lines ? `${file}${file && !file.endsWith("\n") ? "\n" : ""}${lines}\n` : file;
}

export function inertEnv(text, shapes = new Map()) {
  const recorded = parseEnvText(text);
  const keys = [];
  for (const v of Object.values(recorded)) {
    if (!/^-----BEGIN (RSA )?PUBLIC KEY-----/.test(String(v).trim())) continue;
    try { keys.push(createPublicKey(v)); } catch { /* a key nothing can read decrypts nothing */ }
  }
  const out = new Map();
  for (const [n, v] of Object.entries(recorded)) {
    out.set(
      n,
      isDatabaseVar(n, v)
        ? databasePlaceholder(n, v)
        : isStandIn(n, v, shapes.get(n) ?? null)
          ? v
          : (placeholderPem(v) ?? placeholderCiphertext(v, keys) ?? (keptEnvValue(n, v) ? String(v) : inertEnvValue(n, shapes.get(n) ?? null)))
    );
  }
  return out;
}

/**
 * Is this recorded value CONFIGURATION, safe to commit and needed to replay -
 * or a credential or an address, which is neither?
 *
 * WHAT A PLACEHOLDER FOR EVERYTHING COST. The committed env replaced every
 * value, including the ones that decide which branch the code takes, and the
 * recording ran on staging's. cv-parsing-ms PR #67:
 *
 *   FILE_EXTRACT_PROCESSOR=DOCUMENT_AI   recorded -> GoogleDocumentAIProcessor
 *   FILE_EXTRACT_PROCESSOR=charpilot-placeholder  replayed ->
 *     "Could not find file processor. processor=charpilot-placeholder"
 *
 * - getFileExtractInstance-124-default-arg-0 and
 * getLangfuseAiInstance-432-default-arg-0 red in CI for a value that is a
 * processor NAME, published in qode-iac's configmap, and no secret at all.
 *
 * So a value is KEPT unless it is one of the things that must not be
 * committed, by the pipeline's one credential detector and its one address
 * rule:
 *   - credentialShaped() - by name segment (SECRET, TOKEN, API_KEY, ...) or by
 *     value (a provider prefix, a webhook, a high-entropy token)
 *   - an ADDRESS - a name that says URL/URI/HOST/ENDPOINT/ADDR, or a value with
 *     a scheme, an IP literal or a host:port. The suite runs with egress
 *     denied, so an address has nothing to reach, and a staging hostname in a
 *     service repo is infrastructure the repo does not need to carry
 *   - TENANCY - a PROJECT or ACCOUNT name, or any value with an `@`
 *   - anything multi-line or longer than 512 characters, which no enum or
 *     model name is
 * A database variable, a PEM and a ciphertext are decided before this by
 * their own rules. And the RECORDING runs under exactly this env in a mocked
 * run (see buildEnv), so what is committed is what was observed - not a
 * second env the suite hopes is close enough.
 */
export function keptEnvValue(name, value) {
  const v = String(value ?? "");
  if (v === "" || v.length > 512 || /[\r\n]/.test(v)) return false;
  if (credentialShaped(name, v)) return false;
  if (/URL|URI|HOST|ENDPOINT|ADDR|DSN|WEBHOOK|HOOK/i.test(name)) return false;
  // WHO the service runs as and WHERE: a cloud project and a service-account
  // email are tenancy, not configuration the code branches on, and a service
  // repo has no need to carry them (cv-parsing-ms: GOOGLE_CLOUD_PROJECT_ID,
  // GOOGLE_CLIENT_EMAIL).
  // An EMAIL *name* alone is not enough: PERSONAL_EMAIL_DOMAINS is a list of
  // domains the code branches on, and it carries no `@`.
  if (/PROJECT|ACCOUNT/i.test(name) || /@/.test(v)) return false;
  if (/:\/\//.test(v)) return false;
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(v)) return false;
  if (/^[A-Za-z0-9.-]+:\d{2,5}(?:[,/]|$)/.test(v)) return false;
  return true;
}

export function stampRecordedEnv(text, shapes = new Map()) {
  const inert = inertEnv(text, shapes);
  const names = [...inert.keys()];
  if (!names.length) return null;
  return (
    "# GENERATED by `.claude/charpilot/record.mjs --emit-tests` (stage 5) - do not hand-edit.\n" +
    "#\n" +
    "# The env the recording ran under. A CREDENTIAL or an ADDRESS is replaced by\n" +
    "# a value that is true of nothing and is never committed; CONFIGURATION - an\n" +
    "# enum, a model name, a number, a flag - is the recorded value, because the\n" +
    "# code branches on it. A mocked recording runs under exactly this file, so a\n" +
    "# row replays under the env it was observed under (record.mjs keptEnvValue).\n" +
    "#\n" +
    "# EVERY name the recording ran under, and a value its own schema accepts.\n" +
    "# A variable staging SET is one the replay needs a value for: the recording\n" +
    "# never consulted that variable's default, so substituting the default is not\n" +
    "# reproducing the recording. ZIPKIN_COLLECTOR_ENDPOINT is why - declared\n" +
    "# z.string().default(\"\"), omitted by the first version of this stamp, and\n" +
    "# read at import by src/tracer.ts as new URL(\"\") -> TypeError: Invalid URL.\n" +
    "#\n" +
    "# The value is chosen by SHAPE first and name second, so a number field gets\n" +
    "# a number and an enum gets one of its own declared members.\n" +
    "#\n" +
    "# Read by vitest.coverage.config.mts and by verify-generated.mjs.\n" +
    "# A KEY gets a stand-in key of the same kind, and a value the recorded key\n" +
    "# decrypts gets the placeholder encrypted under the stand-in, so a service\n" +
    "# that parses or decrypts on import still loads. Multi-line, as staging.env\n" +
    "# writes it; every reader parses it with envfile.mjs.\n" +
    names.map((n) => `${n}=${inert.get(n)}`).join("\n") +
    "\n"
  );
}

/**
 * The env a HERMETIC test needs: present, never valid.
 *
 * A generated test imports the subject's module, and a required var with no
 * default throws during that import - before the subject is entered, so the
 * failure is an arrangement error rather than behaviour. Measured on
 * location-ms: `DATABASE_URL: z.string()` (src/env.ts, no `.default()`) made
 * `server.char.test.ts` fail in a PR with a ZodError, while the recorded pair
 * was perfectly good.
 *
 * The values are deliberately INERT and deliberately not real. This suite runs
 * with LIVE_MODE=false and the database denied, so the var only has to satisfy
 * a schema - and a committed test holding a working DSN would be both a leak
 * and a lie about what the test does.
 */
function envPrelude(harnessEnv = {}) {
  // EVERY NAME THE RECORDING RAN UNDER, not only the ones with no default.
  //
  // WHAT THIS USED TO DO: `requiredNoDefault` only. That covers the variable
  // whose absence throws for want of it, and misses the one whose DEFAULT is
  // unusable. `ZIPKIN_COLLECTOR_ENDPOINT: z.string().default("")` is declared,
  // defaulted, and read at import by `src/tracer.ts:16` as
  // `url: env.ZIPKIN_COLLECTOR_ENDPOINT` - so a replay with no value for it
  // builds `new URL("")` and throws `TypeError: Invalid URL` in
  // `phase: "arrangement"`.
  //
  // WHY IT HAS TO BE IN THE SPEC AND NOT ONLY IN `recorded.env`. The env file
  // is read by `vitest.coverage.config.mts`, which is under `.claude/` - and
  // the target's `.gitignore` ignores `.claude`, so NOTHING there reaches the
  // branch. Worse, a repo whose own `include` matches the corpus runs these
  // specs under its OWN config, which reads no env file of ours at all:
  // pricing-ms declares `include: ["test/**\/*.test.ts"]`, ran the corpus in
  // its `Unit Tests` check, and that one row took the check red - 1 failed of
  // 358. A spec that only replays under one config is not a deliverable.
  //
  // So the spec carries its own env. `??=` throughout, so a real environment
  // still wins and this only fills what nothing else set.
  let names = [];
  let shapes = new Map();
  let stamped = "";
  try {
    const e = JSON.parse(readFileSync(BASELINE_JSON, "utf8")).envDefaults ?? {};
    shapes = new Map((e.shapes ?? []).map((v) => [v.name, v]));
    // The recording's own env file is the authority on which names were SET.
    // Falling back to the declared schema covers a run with no resolved env.
    stamped = recordingEnvText();
    names = envNames(existsSync(ENV_FILE ?? "") ? readFileSync(ENV_FILE, "utf8") : "");
    if (!names.length) names = (e.requiredNoDefault ?? []).slice();
    // And every stand-in the recording applied (standins.mjs), which the env
    // file does not carry.
    for (const n of standInPlan().standIns) if (!names.includes(n)) names.push(n);
  } catch {
    names = [];
  }
  const inert = inertEnv(stamped, shapes);
  const placeholder = (n) => inert.get(n) ?? inertEnvValue(n, shapes.get(n) ?? null);
  return renderEnvPrelude(names.map((n) => [n, placeholder(n)]), harnessEnv, new Set(hostSetupOnce().env ?? []));
}

/**
 * The prelude's text: the recorded names, then the recorder's own defaults
 * those rows ran under (harnessEnvCarried) - a name already carried is not
 * set twice. Exported for the test that pins D13.
 *
 * THE SECOND BLOCK IS D13. notification-ms run 20260925T072757Z recorded
 * `BUILD_ID=charpilot` (a baseEnv default) and replayed with it unset, so the
 * schema's `.default("local")` filled it and one row of an env-returning
 * function failed stage 6 on that key alone. `??=`, like the first block, so
 * a BUILD_ID the CI sets still wins - exactly as it would have in baseEnv.
 */
export function renderEnvPrelude(entries, harnessEnv = {}, setBySetup = new Set()) {
  const have = new Set(entries.map(([n]) => n));
  const harness = Object.entries(harnessEnv ?? {}).filter(([n]) => !have.has(n));
  if (!entries.length && !harness.length) return "";
  // D37: a name the repo's setup file ASSIGNS is set outright, not `??=`. The
  // setup file runs before this spec, so `??=` kept its value, not the
  // recording's: ai-centralization's test/setup.ts sets REDIS_ENABLED="false"
  // for every test file, the recording ran with "true", and every
  // redis.service row replayed without its `new Redis(...)` call - "the
  // downstream calls changed". A real CI environment still wins for every
  // other name.
  const forced = [...have, ...harness.map(([n]) => n)].filter((n) => setBySetup.has(n));
  const line = ([n, v]) =>
    setBySetup.has(n)
      ? `process.env[${JSON.stringify(n)}] = ${JSON.stringify(String(v))}; // the repo's setup file sets this; the recording saw this value`
      : `process.env[${JSON.stringify(n)}] ??= ${JSON.stringify(String(v))};`;
  return (
    "\n// The env this suite was RECORDED under: credentials and addresses replaced\n" +
    "// by values that are true of nothing, configuration as recorded (a mocked\n" +
    "// recording runs under exactly these). Present so these specs replay under ANY vitest config - the\n" +
    "// repo's own included - because the config that reads `recorded.env` lives\n" +
    "// under `.claude/`, which repos gitignore. `??=`, so a real environment wins.\n" +
    "//\n" +
    "// Chosen by SHAPE first: a number field gets a number, an enum gets one of\n" +
    "// its own members. A value picked by name alone is a string, and a string is\n" +
    "// what made `PORT` fail one way and `ZIPKIN_COLLECTOR_ENDPOINT` the other.\n" +
    "//\n" +
    "// This suite runs with the database denied and no egress, so a credential or\n" +
    "// an address only has to satisfy a schema. A real one here would be a leak.\n" +
    (forced.length
      ? "//\n// Set outright, not `??=`: " + forced.join(", ") + " - the repo's setup file assigns\n" +
        "// them before this file runs, and the recording never ran that file.\n"
      : "") +
    entries.map(line).join("\n") +
    (entries.length ? "\n" : "") +
    (harness.length
      ? "// And the recorder's OWN defaults these rows ran under (record.mjs\n" +
        "// harnessEnvDefaults) - harness literals, no value from any environment.\n" +
        harness.map(line).join("\n") +
        "\n"
      : "")
  );
}

/**
 * A runner config the CORPUS carries, beside the specs it runs.
 *
 * WHY. `cicheck.mjs` wrote a check that runs
 * `vitest run --config .claude/charpilot/vitest.coverage.config.mts`, and the
 * target's `.gitignore` ignores `.claude` - so ZERO files from there reach the
 * pushed branch. Measured on both pull requests it has opened:
 *
 *   Could not resolve ".claude/charpilot/vitest.coverage.config.mts"
 *   failed to load config
 *   Process completed with exit code 1
 *
 * The check could not pass, on any repo, ever. It passed locally because the
 * toolset is installed on disk there, which is exactly the difference between a
 * working tree and a branch.
 *
 * So the corpus carries its own config, committed with `recorded.env` and
 * `emitted.json`, importing nothing from `.claude/`. It extends the repo's OWN
 * root config for aliases and plugins - that file is committed, and resolving
 * differently from the repo would measure a different program.
 *
 * NO COVERAGE HERE. This config exists to answer "does the recorded suite still
 * replay", which is a pass/fail question; `vitest.coverage.config.mts` remains
 * the one that measures, under istanbul, at stage 6. Leaving coverage off also
 * keeps the check from depending on a provider the repo may not install.
 *
 * `setupFiles: []` because the recording ran with none - `vitest.record.config.mts`
 * sets it - so a replay that loads the target's setup is replaying under an
 * arrangement the recording never had.
 */
export function corpusVitestConfig(baseSpecifier, corpusRel) {
  // The repo root, from this file: one `..` per segment of the corpus path.
  const up = String(corpusRel).split("/").filter(Boolean).map(() => '"..", ').join("");
  const base = baseSpecifier
    ? `import baseConfig from "${baseSpecifier}";`
    : "// The root config here is the one install.sh BOOTSTRAPPED, which a branch may not\n" +
      "// carry (finish.py leaves it off until the suite holds a passing test), so this\n" +
      "// corpus does not extend it: it stands alone.\n" +
      "const baseConfig = {};";
  return `// GENERATED by \`.claude/charpilot/record.mjs --emit-tests\` (stage 5) - do not hand-edit.
//
// The config this corpus is meant to be run under, committed beside it:
//
//     npx vitest run --config ${corpusRel}/vitest.config.mts
//
// ${baseSpecifier ? "It extends the repo's own root config, so its plugins and aliases apply," : "It extends no root config (see below),"}
// and resolves modules exactly as the RECORDING did: the recorder's alias
// table and merge, rendered below from its own code, over whatever the root
// declares. It overrides only what a recorded row needs: the corpus as the
// include, and no setup file, because the recording ran with none.
//
// It deliberately imports NOTHING from \`.claude/\` - repos gitignore that
// directory, so anything there is missing on a pushed branch. Each spec also
// carries its own env prelude for the same reason, which is why no env file is
// read here.
//
// Not type-checked: importing the root config by its \`.mts\` name is TS5097
// under a tsconfig without allowImportingTsExtensions, and outreach-thread-ms's
// \`tsc --noEmit\` covers test/. Vitest loads it either way.
// @ts-nocheck
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

${base}

${aliasSource()}

export default defineConfig({
  ...baseConfig,
  resolve: { ...baseConfig.resolve, alias: replayAliases(baseConfig.resolve?.alias, resolve(__dirname, ${up.replace(/, $/, "")})) },
  test: {
    ...baseConfig.test,
    setupFiles: [],
    exclude: [],
    // REPO-RELATIVE, because vitest resolves \`include\` against its own root -
    // the project root, never the config file's directory. \`*.char.test.ts\`
    // matched nothing and the runner exited 1 on "No test files found", which
    // reads as a red suite rather than as a config that looked in the wrong
    // place.
    include: ["${corpusRel}/*${CORPUS_SUFFIX}"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { ...(baseConfig.test?.env ?? {}), ...REPLAY_TEST_ENV },
  },
});
`;
}

/** The repo's own root vitest config, as a specifier relative to the corpus. */
export function baseConfigSpecifier(repoRoot, emitDir, exists = existsSync) {
  const name = rootConfigName(repoRoot, exists);
  if (!name) return null;
  // Relative, from the corpus directory up to the repo root. `..` per
  // segment, so this holds whether the corpus is at `test/characterization`
  // or somewhere one level deeper.
  const depth = relative(repoRoot, emitDir).split(/[\\/]/).filter(Boolean).length;
  return `${"../".repeat(depth) || "./"}${name}`;
}

function rootConfigName(repoRoot, exists = existsSync) {
  for (const name of ["vitest.config.mts", "vitest.config.ts", "vitest.config.mjs", "vitest.config.js"]) {
    if (exists(join(repoRoot, name))) return name;
  }
  return null;
}

/**
 * What the corpus config stands on. A root config install.sh BOOTSTRAPPED is
 * NOT a base: finish.py drops it from the branch whenever the suite holds no
 * passing test, and nginx-redirecting-ms's delivered corpus then imported a
 * file its own branch did not have. So a corpus over a bootstrapped root
 * stands alone (`{ specifier: null, standalone: true }`) - it resolves the
 * same way either way, from the rendered alias table.
 */
export function corpusBaseOf(repoRoot, emitDir, exists = existsSync, read = (f) => readFileSync(f, "utf8")) {
  const name = rootConfigName(repoRoot, exists);
  if (!name) return { specifier: null, standalone: false, root: null };
  let text = "";
  try { text = read(join(repoRoot, name)); } catch { text = ""; }
  if (text.includes(BOOTSTRAP_MARKER)) return { specifier: null, standalone: true, root: name };
  return { specifier: baseConfigSpecifier(repoRoot, emitDir, exists), standalone: false, root: name };
}

/**
 * THE RECORDING, in a file a later run can read - keyed by content, not by line.
 *
 * WHY IT IS NOT THE SPECS. Every emitted spec already carries its rows' `args`,
 * `ctorArgs`, `covers`, `reaches` and observed outcome in a `ROWS` literal, so
 * the data is on the branch. It is not a STORE:
 *
 *   - `--emit-tests` deletes and re-renders the specs it owns on every emit, so
 *     their text is this tool's output and never its input;
 *   - the header says `do not hand-edit`, but a person IS meant to read and
 *     accept the values, and `planEmitTarget` deliberately leaves an edited or
 *     foreign file alone rather than reverting it;
 *   - a reader parsing TypeScript back into rows changes meaning silently the
 *     first time the renderer's shape moves.
 *
 * WHY IT IS NOT `.claude/charpilot/proposals/`. That directory's own docblock
 * calls it "the one artifact of this pipeline that cannot be rebuilt by running
 * something", and says it is tracked in git. It is not: the target's
 * `.gitignore` ignores `.claude`, so 0 of 56 proposals reached
 * `characterize/7c5f26c-20260921T184935Z`. The same line that made the CI check
 * resolve nothing throws away stage 3's output - which is 97% of a run's clock,
 * 7,614s of 7,749s on notification-ms and 13,550s of 14,010s on pricing-ms.
 *
 * SO IT SITS BESIDE THE CORPUS, and it is keyed on `stableId`.
 * `scan.mjs` mints one per arm, content-addressed over the enclosing function's
 * name, the arm kind, the arm's own source text and its ordinal among identical
 * arms - so a comment, a reformat, a moved test or a moved function changes
 * none of them, while an arm whose CODE changed gets a new one and is correctly
 * treated as unanswered. `armId` (`file#line:kind:index`) is carried too,
 * because that is what a person reads, but it is not the key.
 *
 * WHAT IT IS NOT. Not a verdict, and not a coverage claim - `emitted.json`
 * remains the manifest and stage 6 remains the measurement. This answers one
 * question: what did the last run derive and observe, and against which commit.
 */
/**
 * WHICH RECORDING A QUARANTINE WAS ABOUT (D33): the input the row ran
 * (the proposal's fingerprint, inherited blocks included) and what the test
 * asserts of it (outcome and call ledger). The same row recorded again under a
 * repaired input or harness is a different observation, and a verdict on the
 * old one says nothing about it.
 *
 * The ledger's symbols, not their arguments - `callLedgerFor` asserts no more.
 */
export function observationKey(row, observation = row) {
  const o = observation ?? {};
  return createHash("sha1")
    .update(JSON.stringify({
      input: (row?.proposal ?? row)?._fingerprint ?? row?.__fingerprint ?? null,
      returned: o.returned ?? null,
      threw: o.threw ?? null,
      notSettled: o.notSettled ?? null,
      calls: (o.boundaryCalls ?? []).map((c) => c?.symbol ?? null),
    }))
    .digest("hex")
    .slice(0, 12);
}

/**
 * The prior quarantine, split by whether it still judges what is on disk.
 *
 * An entry stays in force when the row's observation is the one it was
 * written against. An entry for a row this emit does not render is kept as it
 * is - nothing here knows anything new about it. Everything else is
 * RELEASED: its row renders as a test again, and cigate runs it and writes a
 * fresh verdict. That includes an entry that names no observation, written
 * before entries carried one - the rule record.mjs's cache already keeps for
 * a row with no fingerprint: re-run once, never trusted for ever.
 *
 * `emitter` is the renderer drawing THIS emit (config.mjs `emitterDigest`).
 * When it is given, an entry is in force only if it names that renderer too:
 * the verdict was about a test, and a template that changed since is a
 * different test. profile-centralized's Slack rows (September 2026) were red
 * because the old template left the repo's setup-file mock of their subject in
 * place; with the entry bound to the recording alone, the repaired template
 * would have emitted them `it.skip` again for as long as the recording held.
 * An entry that names no renderer is judged again once, as above.
 *
 * And an entry cigate wrote only because the row's spec timed out loading
 * (D90, vitestred.mjs loadTimeoutWithhold) is released whatever it names.
 */
export function bindQuarantine(entries, rows, emitter = null, env = process.env) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const quarantined = new Map();
  const released = [];
  const kept = [];
  for (const q of entries ?? []) {
    const row = byId.get(q?.id);
    if (!row) {
      kept.push(q);
      continue;
    }
    // D90: withheld only because its file's module fetch timed out - a verdict
    // about the host, never about this row. Rendered to run, and gated again.
    if (loadTimeoutWithhold(q, env)) {
      released.push(q.id);
      continue;
    }
    if (q.observation && q.observation === row.__observation && (emitter === null || q.emitter === emitter)) {
      quarantined.set(q.id, q.why);
      kept.push(q);
      continue;
    }
    released.push(q.id);
  }
  return { quarantined, released, kept };
}

export function recordedRows(rows, { gitSha, gitBranch, gitDirty, ledger, harness, emitter }) {
  return {
    stage: 5,
    writtenAt: new Date().toISOString(),
    // THE COMMIT THIS DESCRIBES. Without it a later run cannot ask
    // `git diff --name-only <this> HEAD`, which is the whole point of keeping
    // the file. `gitDirty` travels with it because a recording taken against
    // uncommitted edits describes a tree no sha names.
    recordedAgainst: { gitSha: gitSha ?? null, gitBranch: gitBranch ?? null, gitDirty: gitDirty ?? null },
    // The harness that observed these rows. A row recorded under a different
    // one is not reusable, and this is the same digest the in-run cache keys on.
    harness: harness ?? null,
    // The renderer that drew the specs beside this file (config.mjs
    // `emitterDigest`), which a cigate verdict about them is also about.
    emitter: emitter ?? null,
    rows: rows.map((r) => ({
      id: r.id,
      file: r.file ?? null,
      functionId: r.functionId ?? null,
      // BOTH, in step: armIds for a person, stableIds for the machine.
      armIds: r.covers ?? [],
      stableIds: (r.covers ?? []).map((a) => ledger?.byArmId?.[a] ?? null),
      reaches: r.reaches ?? null,
      // The INPUT stage 3 authored. This is the part that costs the 97%.
      args: r.args ?? null,
      ctorArgs: r.ctorArgs ?? null,
      invokeReturned: r.invokeReturned ?? null,
      // What stage 4 observed, so a reuse decision does not need to re-run it.
      outcome: r.threw !== undefined ? { threw: r.threw } : { returned: r.returned ?? null },
      boundaryCalls: r.boundaryCalls ?? [],
      // Which recording this is (observationKey), so a verdict cigate writes
      // about this row can say which one it judged.
      observation: r.__observation ?? null,
    })),
  };
}

/** The armId <-> stableId ledger stage 2 wrote, or null if it never ran. */
function armIdLedger() {
  try {
    return JSON.parse(readFileSync(join(OUT_DIR, "armids.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The target's commit, as stage 1 recorded it. */
function recordedCommit() {
  try {
    const env = JSON.parse(readFileSync(BASELINE_JSON, "utf8")).environment ?? {};
    return { gitSha: env.gitSha ?? null, gitBranch: env.gitBranch ?? null, gitDirty: env.gitDirty ?? null };
  } catch {
    return { gitSha: null, gitBranch: null, gitDirty: null };
  }
}

/**
 * D55: rewrite the run's repo root out of one emitted spec (rootfree.mjs). A
 * leftover the rewrite could not reach (a regex literal, an escaped slash) is
 * printed here and found again by cigate's scan, which withholds its row.
 */
function rootFreeSpec(specPath, landedPath = specPath) {
  const text = readFileSync(specPath, "utf8");
  const out = rootFree(text, { root: REPO_ROOT, specPath: landedPath });
  if (out.text !== text) writeFileSync(specPath, out.text);
  for (const l of out.leftovers.slice(0, 5)) {
    process.stdout.write(`  ! ${relative(REPO_ROOT, landedPath)}:${l.line} still names the repo root ${REPO_ROOT} (${l.kind}) - cigate withholds ${l.row ?? "the file"}\n`);
  }
  return out;
}

function hermeticise(specPath, harnessEnv = {}) {
  let text = readFileSync(specPath, "utf8");
  const before = text;
  // After the last top-level import, so it runs before any dynamic import of
  // the subject inside a row body.
  const prelude = envPrelude(harnessEnv);
  if (prelude && !text.includes("Required by the subject's own env schema")) {
    const lastImport = text.lastIndexOf("\nimport ");
    if (lastImport !== -1) {
      const eol = text.indexOf("\n", lastImport + 1);
      text = text.slice(0, eol + 1) + prelude + text.slice(eol + 1);
    }
  }
  text = text.replace(/^const LIVE_MODE = true;$/m, "const LIVE_MODE = false; // stage 5 is hermetic - see record.mjs hermeticise()");
  // THE OTHER HALF OF THE SAME SWAP. LIVE_MODE off stops the committed test
  // reaching the real dependency; REPLAY_MODE on is what answers it instead -
  // from the recording. Without this the emitted test has neither, and a boundary
  // that was real at record time is answered by the proposal's own guess.
  text = text.replace(/^const REPLAY_MODE = false;$/m, "const REPLAY_MODE = true; // stage 5 replays the recording - see record.mjs hermeticise()");
  text = text.replace(/^const ALLOWED_HOSTS = new Set\(\[[\s\S]*?\]\);$/m, "const ALLOWED_HOSTS = new Set([]); // stage 5 is hermetic - no host is reachable from a committed test");
  // EGRESS_OPEN too, or emptying the allowlist achieves nothing: the guard
  // returns true before it is ever consulted, and a committed test recorded
  // live would keep the open egress of the run that produced it.
  text = text.replace(/^const EGRESS_OPEN = (?:true|false);$/m, "const EGRESS_OPEN = false; // stage 5 is hermetic - a committed test reaches nothing");
  if (text !== before) writeFileSync(specPath, text);
  return text !== before;
}

/**
 * THE TEST'S OWN TIMEOUT, written on every `it`, so no config decides it.
 *
 * The corpus config sets testTimeout 120000, and the repo's own `npm test`
 * runs the same files under ITS config - vitest's default 5000ms on
 * cv-parsing-ms. getContent-51-binary-expr-0 settles in ~1.1s alone and
 * timed out at 5000ms inside the full suite, where 31 files import heavy
 * graphs in parallel: a row is budgeted by the recorder's own clock (the
 * arrangement allowance, then the row budget, then the in-flight settle), and
 * a test runner killing it earlier fails it for being on a busy machine. The
 * bound is the runtime's own worst case: IMPORT_BUDGET_MS + two row budgets,
 * plus slack for the assertions.
 */
function itTimeoutMs(rowTimeoutMs) {
  return Math.max(60_000, rowTimeoutMs) + 2 * rowTimeoutMs + 10_000;
}

/** An `args[].build` as the spec writes it, with the arg's `value` bound to that name. See writeSpec. */
export function argBuild(build, value) {
  if (!/\bvalue\b/.test(build)) return `(${build})`;
  return `(async (value) => (${build}))(${JSON.stringify(value)})`;
}

function writeSpec(rows, dest = SPEC, mode = "record", rowTimeoutMs = ROW_TIMEOUT_MS, slot = SLOTS[0]) {
  // Only THIS RUN's spec writes to this run's result files. `--emit-specs`
  // produces throwaway measurement chunks that stage 6 runs later, long after
  // this process is gone, and baking a dead run's per-run path into them would
  // drop one orphan file into the shared out/ per emit. Nothing reads a
  // measurement chunk's results - istanbul's counters are the point - so they
  // get one scratch name between them.
  const isRecorderSpec = dest === slot.spec;
  const specResult = isRecorderSpec ? slot.result : join(OUT_DIR, ".record-result.measure.json");
  const specBranchmap = isRecorderSpec ? slot.branchmap : join(OUT_DIR, ".record-branchmap.measure.json");
  const blocks = rows
    .map((row, i) => {
      // `args[].build` is AWAITED, exactly as `invoke.build` is at
      // callExpression's built-subject branch. It used to be inlined verbatim,
      // so an async expression passed a PROMISE as the argument and nothing
      // said so: the subject read `undefined` off every field, every fallback
      // side moved, and the claim came back FALSE looking exactly like a
      // mis-aimed input. The diagnostic signature was both sides of a `||`
      // moving AND all three of a `??` chain moving in one row's armsMoved.
      //
      // Awaited rather than refused, because refusing removes a capability the
      // sibling recipe already has, and the two must not disagree about what a
      // stage-3 `build` may contain. `await` on a non-thenable is the identity,
      // so a synchronous build is unchanged; the one behaviour it does change
      // is a build that deliberately produced a thenable ARGUMENT, and passing
      // a raw Promise as the argument is the defect being fixed here, not a
      // feature. It sits inside the subject's own argument list, after
      // covBefore is snapshotted, so it cannot move an arm into the wrong
      // window.
      //
      // `value` IS BOUND, NOT SPELLED IN. A build may name the arg's own
      // `value`, and this used to put it in with
      // `build.replace(/\bvalue\b/g, JSON.stringify(a.value))` - which also
      // rewrote every object KEY and every word inside a STRING that happened
      // to be `value`. sourcing-ms (2026-09-26) had a build of
      // `doubles.expressRequest({ ..., body: { value: 'new-contact-value' } })`,
      // and the spec came out as `body: { {"params":…}: 'new-contact-{"params":…}' }`.
      // That is a parse error, so vitest loaded none of the chunk and all 16 of
      // its rows were skipped as "the recorder's vitest chunk produced no rows".
      // A parameter named `value` means the same thing where the build uses it
      // as a name, and nothing at all where it is a key or a word in a string.
      // `async`, so a build that awaits is still an expression it can contain.
      // A build that never says `value` is written as it was.
      const args = row.args
        .map((a) => (a.build ? `await ${argBuild(retargetSpecifiers(a.build), a.value)}` : JSON.stringify(a.value)))
        .join(", ");
      // Stashed for the test writer. A generated test MUST use the identical
      // arrangement - same mocks, same env, same harness bindings - or it is
      // not the pair that was recorded, and the assertion is about a different
      // program. Assembling the body twice from one set of pieces is what keeps
      // them identical.
      row.__args = args;

      // Per-row module interception. `vi.doMock` is the dynamic form, and it only
      // takes effect for imports made after a registry reset - hence the
      // resetModules() before it. `importOriginal` is spread so only the named
      // export is replaced and the rest of the module stays real; a wholesale
      // replacement would silently break every other symbol the subject uses.
      //
      // The answer expression is evaluated ONCE per row, not once per call: 61
      // proposals answer with a SEQUENCE (`doubles.stub({ acquireLock: [{...},
      // {...}] })`) and a per-call rebuild would restart the sequence every time
      // and make the second arm unreachable.
      // Group by MODULE first. Two boundaries can live in one module -
      // `OpenAIModelV1` and `OpenAIKeys` are both in @/models/openAIModelV1 -
      // and a second `vi.doMock` for the same path REPLACES the first, so
      // emitting one per boundary silently dropped whichever came earlier.
      const byModule = new Map();
      for (const m of row.mocks) {
        if (!byModule.has(m.module)) byModule.set(m.module, []);
        byModule.get(m.module).push(m);
      }
      const mocks = [...byModule.entries()]
        .map(([module, ms]) => {
          const lines = ms
            .map((m) => {
              const answer = m.build != null ? retargetSpecifiers(m.build) : JSON.stringify(m.value ?? null);
              const applied = `applyMock(${JSON.stringify(m.symbol)}, ${JSON.stringify(m.kind)}, __real(${JSON.stringify(m.imported)}), () => (${answer}))`;
              // A mocked row that seeds and answers the client itself: the seeds go over its answer.
              const seeded = (row.seeds ?? []).length && DB_CLIENT_SYMBOL.test(String(m.symbol));
              // A `value` written as JSON text is noted against the real export.
              const asText = m.build == null && isJsonText(m.value)
                ? `      noteValueAsText(${JSON.stringify(m.symbol)}, ${JSON.stringify(module)}, orig?.[${JSON.stringify(m.imported)}]);\n`
                : "";
              return `${asText}      out[${JSON.stringify(m.imported)}] = ${seeded ? `(LIVE_MODE ? ${applied} : seedOver(${applied}))` : applied};`;
            })
            .join("\n");
          // A GLOBAL is assigned, not module-mocked. `vi.doMock("globalThis")`
          // registers and never runs, so the answer was accepted and inert and
          // the row died with `blocked egress` anyway - measured on 5
          // location-ms rows whose proposals correctly declared `fetch`.
          if (module === "globalThis") {
            return ms
              .map((m) => {
                const answer = m.build != null ? retargetSpecifiers(m.build) : JSON.stringify(m.value ?? null);
                return `    stubGlobal(${JSON.stringify(m.symbol)}, applyMock(${JSON.stringify(m.symbol)}, ${JSON.stringify(m.kind)}, globalThis[${JSON.stringify(m.symbol)}], () => (${answer})));`;
              })
              .join("\n");
          }
          // The spread is deliberate - replacing one export and leaving the
          // rest real is what keeps `isAxiosError`, `create` and every sibling
          // working. But it means importOriginal() runs FIRST, so a module that
          // throws at import, or whose path does not resolve, fails here and
          // vitest reports "There was an error when mocking a module" - which
          // profile-centralized recorded as the service's own behaviour, its
          // prisma client being an uninitialised submodule.
          //
          // So: try the real module, and fall back to a replacement when it
          // cannot be loaded. The fallback is recorded on the row rather than
          // done quietly. Every export the row did not declare is an
          // unloadedExport stand-in (D29): it may be held but refuses to be
          // used, so a sibling a module merely references still resolves and a
          // sibling the code USES fails as the harness's, naming the module
          // and why it did not load. The declared exports are answered against
          // a stand-in too, which tells applyMock their shape is unknown.
          // TOOL BACKLOG: A BUILD MAY NAME ANOTHER BOUNDARY THE ROW DECLARED.
          // outreach-thread-ms classifyAndDispatch-565 answered this.qodeItl with
          // `doubles.stub({ fetchReplyConfig: { rejects: new
          // ConfigMisconfiguredError(...) } })` and declared
          // ConfigMisconfiguredError at its own module - but a build is
          // evaluated in the spec, where nothing imported that name, and the
          // row died "ConfigMisconfiguredError is not defined" (20260922T130927Z).
          // Each other declared module boundary a build here names is bound
          // first, from its module as this row mocks it.
          const named = new Set(ms.map((m) => (m.build != null ? String(m.build) : "")).join("\n").match(/[A-Za-z_$][\w$]*/g) ?? []);
          const binds = (row.bindable ?? [])
            .filter((b) => b.module !== module && named.has(b.symbol) && !ms.some((m) => m.symbol === b.symbol))
            .filter((b, i, all) => all.findIndex((x) => x.symbol === b.symbol) === i)
            .map((b) => `      const ${b.symbol} = await (async () => { try { return (await import(${JSON.stringify(b.module)}))[${JSON.stringify(b.imported ?? b.symbol)}]; } catch { return undefined; } })();`)
            .join("\n");
          return `    mock(${JSON.stringify(module)}, async (io) => {
      let orig = {};
      let __unloaded = null;
      try {
        orig = await io();
      } catch (e) {
        __unloaded = e instanceof Error ? e.message : String(e);
        MOCK_FALLBACKS.push({ module: ${JSON.stringify(module)}, why: __unloaded });
      }
      const __real = (k) => (__unloaded === null ? orig?.[k] : unloadedExport(${JSON.stringify(module)}, k, __unloaded));
${binds}
      const out = nameDenied({ ...orig });
${lines}
      return __unloaded === null ? out : unloadedModule(${JSON.stringify(module)}, __unloaded, out);
    });`;
        })
        .join("\n");

      // `null` DELETES the var for this row (review B1) - the same statement
      // in the recording and in the emitted suite, since both are this text -
      // and the finally below restores it either way.
      const env = Object.entries(row.env ?? {})
        .map(([k, v]) =>
          `    envBefore[${JSON.stringify(k)}] = process.env[${JSON.stringify(k)}]; ` +
          (v === null ? `delete process.env[${JSON.stringify(k)}];` : `process.env[${JSON.stringify(k)}] = ${JSON.stringify(String(v))};`)
        )
        .join("\n");

      const scope = scopeFor(row)
        .map((s) =>
          s.imported
            ? `      const ${s.id} = await (async () => { try { return (await import(${JSON.stringify(s.module)}))[${JSON.stringify(s.imported)}]; } catch { return undefined; } })(); void ${s.id};`
            : `      const { ${s.id} } = await import(${JSON.stringify(s.module)}); void ${s.id};`
        )
        .join("\n");

      // Retargeted like every other expression a proposal writes. It was the one
      // door left verbatim: company-enrich PR #30's rewriteCompanyDescription
      // rows warm the module's cache with `import('src/utils/rewriteDescription')`
      // before the subject runs. Under the recorder's alias that is the subject's
      // own module, so the subject hit the cache and the ledger held ONE
      // Anthropic call; under the repo's config the bare spelling is a SECOND
      // instance of the module, the subject's cache was cold, and the replay
      // made the call twice - `the downstream calls changed`.
      const calls = row.calls
        .map((c) => `      try { await (${retargetSpecifiers(c)}); } catch { /* precondition already satisfied, or not applicable */ }`)
        .join("\n");

      // Seeds are NOT calls. A `calls` entry swallows its failure on purpose -
      // "the precondition was already satisfied" is the common case - but a
      // seed that silently did not happen leaves the row recording the arm it
      // was written to leave behind, and the pair looks fine. So a failed seed
      // throws, the row becomes a harness failure, and stage 6 sees no claim.
      //
      // The client comes from "@/prisma/client", which inside a live row is the
      // JOURNALLED proxy - so the seed is undone by the same reverse replay as
      // any other write, with the same end-of-run verification.
      const seeds = (row.seeds ?? [])
        .map(
          (sd) => `      if (LIVE_MODE) {
        const { prisma: __db } = await import("@/prisma/client");
        const __seeded = await __db[${JSON.stringify(sd.model)}].create({ data: ${JSON.stringify(sd.data)} });
        out.seeded = [...(out.seeded ?? []), { model: ${JSON.stringify(sd.model)}, id: __seeded?.id ?? null }];
      } else {
        out.seeded = [...(out.seeded ?? []), { model: ${JSON.stringify(sd.model)}, id: ${JSON.stringify(sd.data?.id ?? null)}, double: true }];
      }`
        )
        .join("\n");
      // Installed with the row's other mocks, before anything is imported, and
      // never over a proposal's own answer for the package.
      const seedDouble = (row.seeds ?? []).length
        ? `    if (!LIVE_MODE) installSeedDouble(${JSON.stringify((row.seeds ?? []).map((sd) => ({ model: sd.model, data: sd.data })))}, ${JSON.stringify(row.mocks.some((m) => m.module === "@prisma/client"))}, ${JSON.stringify(row.mocks.some((m) => DB_CLIENT_SYMBOL.test(String(m.symbol))))});`
        : "";

      // D27: the subject is a CONSTRUCTOR, reached through its class or through
      // the module-scope singleton that holds it - { name, file } from the
      // functionId (`<file>:<line>:<Class>.constructor`), else null. Only such a
      // row can have run its subject while its module was being imported
      // (thrownInConstructor). A proposal that builds its own subject is not one.
      const ctorClass = (() => {
        const e = row.entry;
        if (!e || e.member !== "constructor" || !["exported-binding", "class-method"].includes(e.kind)) return null;
        const m = String(row.functionId ?? "").match(/^(.+):\d+:([A-Za-z_$][\w$]*)\.constructor$/);
        return m ? { name: m[2], file: m[1] } : null;
      })();

      // THE SUBJECT IS THE REAL MODULE, WHATEVER THE REPO'S SETUP FILE MOCKS.
      //
      // The recording runs with `setupFiles: []` (vitest.record.config.mts);
      // the emitted suite is gated under the repo's OWN config, setup file
      // included. profile-centralized's test/setup.ts (September 2026) does
      // `vi.mock('@/utils/sendSlackError', () => ({ sendSlackNotification:
      // vi.fn(), ... }))` for every test file, so each emitted Slack row called a
      // vi.fn instead of the code it pins: the eight rows that reach axios.post
      // replayed `[]`, cigate withheld them as red, and their eight sides stalled
      // open with every claim verified at record time. `unmockAll` cannot undo
      // that mock: it only knows the paths the row mocked itself.
      //
      // Unmocked BEFORE the row's own mocks, so a proposal that answers a
      // sibling export of its own module still wins. In the recorder nothing
      // mocks the subject, and the call changes nothing. A subject the proposal
      // BUILDS is unmocked too, by the module its functionId names: see
      // `unmockSpecifier`.
      const subject = unmockSpecifier(row.entry, row.functionId);
      // AND EVERY OTHER MODULE THE REPO'S SETUP FILES MOCK (hostsetup.mjs, D37).
      // qode-ptp-ms's test/setup.ts mocks `@/env` with a proxy answering "test"
      // for every variable, so the module-scope warns its real env module logs
      // were recorded and never replayed (49 rows withheld as "the downstream
      // calls changed"); email-centralization-ms's pins OTP_BY_GMAIL_ENABLED
      // false, so the two isFromRecruiter rows that set it recorded true and
      // replayed false. Undone here, beside the subject and for the same
      // reason; the row's own mocks, registered below, still win.
      const setupUndo = setupUndoLines(hostSetupOnce(), dirname(dest), new Set(subject ? [subject] : []));
      const unmockSubject =
        (subject
          ? `    // The repo's setup file may mock this module; the recording ran without one.\n    vi.doUnmock(${subject});\n`
          : "") +
        (setupUndo.length
          ? `    // The repo's setup files do this for every test file; the recording ran with none.\n${setupUndo.map((l) => `    ${l}\n`).join("")}`
          : "");

      row.__mocks = mocks;
      row.__scope = scope;
      row.__calls = calls;
      row.__seeds = seeds;
      row.__env = env;

      return `  // ---- ${row.id}
  {
    const row = ROWS[${i}];
    // The harness's clock, not the global: the row before may have stubbed
    // Date (a tracy-worker proposal pins Date.now to 2023), and its stub is still in place
    // here, so a start read from it put this row's mark years in the past and
    // the parent stopped the row as wedged before it began.
    const started = HARNESS_DATE_NOW();
    ROW_SUBJECT_AT = null;
    SUBJECT_IMPORTS = 0;
    SUBJECT_MARK = { id: row.id, started };
    if (ROW_MARK) writeFileSync(ROW_MARK, JSON.stringify({ id: row.id, started }));
    const out = { id: row.id, file: row.file, functionId: row.functionId, covers: row.covers, reaches: row.reaches, source: "recorded" };
    const envBefore = {};
    // FIX PLAN 1, F3.1: what this row set on a receiver that outlives it (a
    // singleton, a class). Undone after the row's in-flight calls settle.
    const __restore = [];
    // The process listeners every row starts from (see dropRowProcessListeners).
    const __processListeners = processListenersNow();
    resetCalls();
    FLOATING = [];
    UNCAUGHT = [];
    SPY_UNDEFINED = [];
    UNLOADED_USES = [];
    CTOR_UNDEFINED = [];
    VALUE_AS_TEXT = [];
    MOCK_BUILD_THREW = [];
    SEEDED = new Map();
    EGRESS = [];
    TELEMETRY = 0;
    LISTENS = [];
    DOWNSTREAM = [];
    VALUE_ANSWERS = [];
    NOT_CALLED_AT = [];
    NOT_CALLED_FNS = [];
    CYCLE_TRIED = null;
    unmockAll();
${unmockSubject}    vi.resetModules();
    // DEFAULT-DENY, before the row's own mocks so the row can still override.
    //
    // The first version of this recorder had no such guard and sent a real
    // request to hooks.slack.com (rejected 400, but it left the machine) and
    // dialled prisma at a dead placeholder address. Classifying a boundary as
    // forbidden in a preflight report is worthless if the runner will still
    // call it. Egress and the database are blocked here unless a proposal
    // explicitly answers them.
    denyEgress();
    // AFTER the default-deny and BEFORE the row's own mocks. The replay
    // replaces the deny proxy at the paths this row actually recorded a call
    // on, and a proposal that answers a module explicitly still wins because
    // its mock is installed after. In the recorder REPLAY_MODE is false and
    // this installs nothing.
    mockOrderBarrier();
    installReplay(row);
    // The row's own mocks are registered after everything above, never
    // alongside it: see mockOrderBarrier.
    mockOrderBarrier();
${mocks || "    // no boundary needs interception"}
${seedDouble || "    // no seeded row"}
    const captured = [];
    // Snapshotted INSIDE the subject call below, read after the row settles.
    // Declared out here because the diff has to survive a throw and a timeout:
    // a row that failed still moved arms, and which ones is exactly what says
    // whether it failed on the path it claimed.
    // TWO windows, because a claim can be true of the wrong half of the row.
    // covAtRowStart opens before the row's own arrangement - its harness
    // imports, its seeds, its precondition calls, and the import of the
    // subject's own module, which for a module-scope singleton
    // (export const queueManager = new RequestQueueManager()) is where the
    // claimed arm actually runs. covBefore opens immediately before the
    // subject call. The verdict is decided on the SUBJECT window, so an arm
    // the arrangement moved is never credited to the input; the arrangement
    // window exists to say WHY a claim came back false, which is what makes it
    // repairable rather than merely reported.
    let covAtRowStart = null;
    let covBefore = null;
    // A constructor subject's counters just before its own module is imported
    // (see thrownInConstructor); null once that import has returned.
    let covSubjectImport = null;
    const builtinsRestored = [];
    const origs = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(origs)) {
      console[k] = (...a) => captured.push({ stream: k, text: a.map((x) => (typeof x === "string" ? x : safe(x))).join(" ") });
    }
    // D37: this row's own Math.random (see seededRandom), restored in the finally.
    Math.random = seededRandom(row.id);
    // D49: and its own clock (see installRowClock), restored in the finally.
    // D63: started where the recording's started, in the replay, and the
    // recording writes down where that was. The zone is pinned beside it.
    const __restoreClock = installRowClock(ROW_GEN, REPLAY_MODE ? row.clockEpoch : null);
    out.clockEpoch = __restoreClock.epoch;
    const __restoreZone = pinRowZone();
    try {
      // THE ROW'S ENV, applied INSIDE the try whose finally restores it
      // (verifier nit c). It used to be applied before the harness setup above,
      // so a throw there - a mock registration, the replay install - left the
      // var set for every row after it. Nothing between here and there reads
      // process.env, and the subject's module is imported below, so the
      // subject still sees it from its first line. Same text in the recording
      // and the emitted suite.
${env ? env.replace(/^    /gm, "      ") : "      // no env override"}
      // The WHOLE row is under the timeout, not just the subject call: an
      // import can hang too, and a chunk that stalls on one row loses the rows
      // behind it. (It did: one anthropic-stream row wedged a chunk of 8.)
      // Scoped to this row: see ROW_SCOPE. Everything the body starts carries it.
      const returned = await ROW_SCOPE.run(ROW_GEN, () => settle((async () => {
        covAtRowStart = covSnapshot();
${scope || "        // no harness binding referenced"}
${seeds || "        // no seeded row"}
${calls || "        // no precondition call"}
        // See flushQueuedMocks: the row's mocks are registered before its own code runs.
        await flushQueuedMocks(${JSON.stringify(doublesImport(dest))});
${ctorClass ? "        covSubjectImport = covSnapshot();\n" : ""}        ${row.shape.imp}
${ctorClass ? "        covSubjectImport = null;\n" : ""}        builtinsRestored.push(...restoreBuiltins());
        const target = ${row.shape.call};
${row.entry?.kind === "built-subject"
  ? `        // TOOL BACKLOG: a build that CALLED the subject hands back its result.
        // outreach-thread-ms advanceCandidateStage-340 (20260922T130927Z) ended
        // its build with 'return await inst.advanceCandidateStage(...)', and the
        // row died "entry did not resolve to a function" with no owner. Said
        // as the build's: a build evaluates to the function the row calls.
        if (typeof target !== "function") throw charpilotBuildFailed(new Error("invoke.build evaluated to " + (target === null ? "null" : typeof target) + ", not the subject function - a build must evaluate to the function the recorder calls with the row's args, not call it itself"));`
  : `        if (typeof target !== "function") throw new Error("entry did not resolve to a function");`}
        // The counters are snapshotted HERE - after the imports, the seeds and
        // the precondition calls, immediately before the subject runs - so the
        // movement this row reports is movement the SUBJECT caused. A snapshot
        // taken earlier would credit the row with arms its own arrangement
        // moved, which is the claim reading better than the input.
        covBefore = covSnapshot();
        sweepRequireCache();
        ROW_SUBJECT_AT = HARNESS_DATE_NOW();
        if (ROW_MARK) writeFileSync(ROW_MARK, JSON.stringify({ id: row.id, started, subjectAt: ROW_SUBJECT_AT }));
        const first = await target(${args});
${row.invokeReturned ? `        // The arm lives inside the closure this driver RETURNS (${row.invokeReturned.of}).
        // Stopping at the driver records a function object and reaches nothing.
        // A driver that answers with something else on this path - null from
        // a guard in its own body - has nothing to invoke, and what it
        // returned IS the observation. Throwing here recorded the harness's
        // sentence as the service's behaviour: 13 rows on ai-centralization
        // (September 2026) froze "expected the driver to return a function"
        // where its get*Action driver had returned null.
        if (typeof first !== "function") return await drainIfIterator(first);
${closureCall(row.invokeReturned)}` : "        return await drainIfIterator(first);"}
      })()));
      if (EGRESS.length) {
        // A row that RETURNED with a blocked call in its path is not a clean
        // observation either, and this is the easier case to miss because
        // nothing threw. A fire-and-forget writer - slack.sendMessage - has its
        // failure swallowed by the service, so the function returns normally
        // and the pair reads as ordinary behaviour. What it actually froze is
        // "what this returns while Slack is DOWN", and production has Slack up.
        // The proposal reached a default-deny endpoint it declared no boundary
        // for: that is a stage-3 defect to repair (declare the boundary), not
        // an observation to keep.
        out.invoked = false;
        out.harnessError = {
          name: "CharpilotEgressBlocked",
          message: \`charpilot: \${EGRESS[0]} blocked by the recorder (default-deny); the call then RETURNED, so the value describes this service with that endpoint unavailable - declare a boundary for it\`,
        };
      } else if (UNLOADED_USES.length) {
        // D29: the subject USED an export of a module that could not be
        // loaded, the stand-in refused, and the code caught that and carried
        // on. What it returned is this service with a fake failure injected,
        // not an observation.
        out.invoked = false;
        out.harnessError = {
          name: "CharpilotModuleUnloaded",
          message: \`charpilot: \${[...new Set(UNLOADED_USES)].slice(0, 3).join(", ")}: an export of a module that could not be loaded was used and the refusal was caught, so the value does not describe this service - declare an answer for it, or make the module loadable\`,
        };
      } else {
        out.invoked = true;
        out.returned = snap(returned);
      }
    } catch (err) {
      // D67: an error vitest's module runner hands across its RPC is a plain
      // object with a \`message\`, not an Error, and String() of it is
      // "[object Object]" - 183 of qode-itl-be's harness failures said only
      // that, so nothing could tell which install gap they were.
      const message =
        err instanceof Error ? err.message : err && typeof err === "object" && typeof err.message === "string" ? err.message : String(err);
      const name = String(err && err.name);
      if (name === "CharpilotRowTimeout") {
        // Not settling IS an observation - but it is not a value, so it is
        // reported on its own rather than dressed up as a return.
        out.invoked = true;
        // A \`notSettled\` bucket that does not name the timeout it was measured
        // against is not a finding, it is a label. Measured on qode-ptp-ms:
        // all 10 not-settled sides in one slice carried subjectCallStarted
        // false and armsMoved [] - the ARRANGEMENT (importing a heavy service
        // graph) spent the whole 10s default before the subject was reached.
        // Re-run at --row-timeout 45000 the same slice reported notSettled 0
        // and one row settled at 41,119ms with its claim verified. The label
        // was wrong, not the input, and nothing in the row said so.
        out.notSettled = {
          afterMs: ROW_SUBJECT_AT === null || SUBJECT_IMPORTS > 0 ? IMPORT_BUDGET_MS : ROW_TIMEOUT_MS,
          rowTimeoutMs: ROW_TIMEOUT_MS,
          subjectCallStarted: covBefore !== null,
          why:
            covBefore === null
              ? \`the SUBJECT CALL WAS NEVER ENTERED - the row's own arrangement (its harness imports, seeds and precondition calls, and the import of the subject's module) used the whole \${ROW_TIMEOUT_MS}ms. This is not a derivation problem: raise --row-timeout and re-run before touching the input.\`
              : \`the subject was called and had not settled \${ROW_TIMEOUT_MS}ms into the row; --row-timeout raises the budget if the work is legitimately slow.\`,
        };
      } else {
        // STRUCTURAL, and deliberately FIRST. Every other test below is a
        // string match on the message, so an arrangement failure that says
        // something new - a module-scope \`throw\` during import
        // ("SOURCING_MS_HOST is not set", "EMAIL_SERVICE_URL environment
        // variable is not defined") - matched none of them and was written
        // into \`threw\`, where it became the service's recorded contract. A
        // frozen fiction is the one failure this pipeline exists to prevent,
        // and no list of strings can be finished.
        //
        // covBefore is snapshotted immediately before the subject call, so
        // \`covBefore === null\` says the subject was never entered. A throw in
        // that state CANNOT be the subject's behaviour, whatever it says:
        // nothing of the subject ran. It is always the arrangement.
        //
        // One exception, and only a structural one (D27): a CONSTRUCTOR subject
        // whose module constructs it at load. When that import throws from
        // inside the subject's own constructor, the subject DID run - the
        // module's \`new C()\` is the same construction the row was about to
        // make - so the import is its window and the throw its behaviour.
${ctorClass ? `        if (covBefore === null && covSubjectImport !== null && thrownInConstructor(err, ${JSON.stringify(ctorClass.name)}, ${JSON.stringify(ctorClass.file)})) {
          covBefore = subjectImportWindow(covSubjectImport, ${JSON.stringify(ctorClass.file)});
          out.subjectAt = "module-import";
        }
` : ""}        const subjectNeverStarted = covBefore === null;
        const harness =
          subjectNeverStarted ||
          name === "CharpilotEgressBlocked" ||
          // D29: a stand-in for an export of a module that could not be
          // loaded refused to be used. Never the service's behaviour.
          name === "CharpilotModuleUnloaded" ||
          // This recorder's OWN sentinel. Two getInstance rows recorded it as
          // a thrown Error with this exact message, which is the spec failing
          // to resolve an entry, not the service failing.
          message === "entry did not resolve to a function" ||
          /Cannot find module|Failed to resolve import|ERR_MODULE_NOT_FOUND/i.test(message) ||
          // A TS-compiled service cannot reference an undeclared name; every
          // "x is not defined" here is a binding the SPEC failed to provide.
          (name === "ReferenceError" && /is not defined/.test(message)) ||
          // A boot-schema ZodError is the env module refusing to load, which is
          // the harness failing to arrange the row - not the service's
          // behaviour. The old test was a list of THIS repo's variable names,
          // so pricing-ms's boot ZodError about STRIPE_SECRET_KEY would have
          // been written down as an observation. The name of the failing key is
          // not the signal; the shape is: an env var is SCREAMING_SNAKE, and a
          // Zod error naming one comes from a boot schema rather than from a
          // request body, whose fields are camelCase by the Qode naming rule.
          //
          // Deliberately still narrow: a ZodError naming no such key - a real
          // request-validation failure, like the pricing-ms pageSize defect -
          // stays an observation, which is what it is.
          (name === "ZodError" && /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(message)) ||
          // vitest could not build the module replacement at all - the factory
          // spreads importOriginal(), so a module that throws at import, or one
          // whose path does not resolve, fails HERE. profile-centralized has an
          // uninitialised prisma submodule and recorded this string as the
          // service's contract, with invoked: true.
          /There was an error when mocking a module/i.test(message) ||
          // A DI container with no metadata polyfill. Recorded verbatim on
          // notification-ms as "this service throws a polyfill error", which
          // would have become the pinned contract of every @injectable class.
          /requires a reflect polyfill|Reflect\.getMetadata is not a function|reflect-metadata/i.test(message);
        if (harness) {
          out.invoked = false;
          // THE CAUSE, NOT ONLY THE WRAPPER. vitest reports a module factory
          // that threw as "There was an error when mocking a module" and puts
          // the factory's own error on \`cause\`. Keeping only the wrapper is how
          // turing-integration-ms lost 163 sides to a sentence that named no
          // module and no reason. Up to three causes are kept, each clipped.
          const causes = (e, depth = 0) =>
            e && typeof e === "object" && e.cause && depth < 3
              ? \`; caused by \${(e.cause && e.cause.name) || "Error"}: \${String((e.cause && e.cause.message) ?? e.cause).slice(0, 300)}\${causes(e.cause, depth + 1)}\`
              : "";
          out.harnessError = {
            name: err instanceof Error ? err.name : "non-error",
            message:
              message.slice(0, 300) +
              causes(err) +
              (subjectNeverStarted && err && typeof err === "object" && err.__charpilotBuild
                ? "; thrown by the proposal's own invoke.build before the subject was entered - repair the build"
                : "") +
              (subjectNeverStarted && CTOR_UNDEFINED.length
                ? \`; the subject's constructor was called with \${CTOR_UNDEFINED.join(", ")} undefined because no proposal answered \${CTOR_UNDEFINED.length > 1 ? "them" : "it"} - declare an answer for each (a boundary named after the parameter, with \"module\": \"<instance field>\"), or an invoke.build that constructs the class\`
                : "") +
              // See VALUE_ANSWERS. Only the arrangement's: the row never ran.
              (subjectNeverStarted ? valueMissingMember(err, ${JSON.stringify(Object.fromEntries((row.mocks ?? []).map((m) => [m.symbol, m.module])))}) : "") +
              // See NOT_CALLED_AT. Only the arrangement's: the row never ran.
              (subjectNeverStarted ? notCalledUsed(err, ${JSON.stringify(Object.fromEntries((row.mocks ?? []).map((m) => [m.symbol, m.module])))}) : "") +
              // D73: see charpilotThroughCycle. Both orders of the cycle were tried.
              (subjectNeverStarted && CYCLE_TRIED
                ? \`; the subject's module is on an import cycle through \${CYCLE_TRIED.importer}, and imported first it failed with "\${CYCLE_TRIED.first}" - the row then entered the cycle at \${CYCLE_TRIED.importer}, and this is what that load threw\`
                : "") +
              // See VALUE_AS_TEXT. Only the arrangement's: the row never ran.
              (subjectNeverStarted && VALUE_AS_TEXT.length
                ? \`; the row answered \${VALUE_AS_TEXT.join(", ")} with a string holding JSON text - a mock's "value" is the answer itself, not its JSON encoding: write the object (or a build), not a string of it${(() => {
  const t = (row.args ?? []).flatMap((a, i) => (!a.build && isJsonText(a.value) ? [`args[${i}]`] : []));
  return t.length ? `; ${t.join(", ")} ${t.length > 1 ? "are strings" : "is a string"} holding JSON text too - pass the value itself unless the parameter takes a string` : "";
})()}\`
                : "") +
              // See MOCK_BUILD_THREW. Only the arrangement's: the row never ran.
              (subjectNeverStarted ? mockBuildThrew(err, ${JSON.stringify(Object.fromEntries((row.mocks ?? []).map((m) => [m.symbol, m.module])))}, ${JSON.stringify([...new Set([...(row.mocks ?? []).map((m) => m.symbol), ...(row.bindable ?? []).map((b) => b.symbol)])])}) : "") +
              // See buildUnboundName. Either phase: the build's own closure may run after the snapshot.
              buildUnboundName(err, ${JSON.stringify(buildNamesOf(row))}),
            // WHICH HALF of the row failed, so a reader does not have to infer
            // it from subjectCallStarted. "arrangement" means the row never
            // reached its subject, so there is no observation here at all and
            // every claim on it is unmeasurable - not verified, and not false.
            ...(subjectNeverStarted
              ? {
                  phase: "arrangement",
                  why: "the subject call was never entered - this threw during the row's imports, seeds or precondition calls, so it is a HARNESS failure and not the subject's behaviour",
                }
              : {}),
          };
        } else if (EGRESS.length) {
          // The call FAILED and the guard tripped somewhere in its path. The
          // thrown value cannot be trusted as the service's own behaviour -
          // the SDK may simply be reporting the blocked socket - so this is
          // not recorded as an observation.
          out.invoked = false;
          out.harnessError = {
            name: "CharpilotEgressBlocked",
            message: \`charpilot: \${EGRESS[0]} blocked by the recorder (default-deny); the call then failed with \${name}: \${message.slice(0, 120)}\`,
          };
        } else if (UNLOADED_USES.length) {
          // D29: the refusal was caught inside the service and something else
          // was thrown instead; that throw is the stand-in's doing.
          out.invoked = false;
          out.harnessError = {
            name: "CharpilotModuleUnloaded",
            message: \`charpilot: \${[...new Set(UNLOADED_USES)].slice(0, 3).join(", ")}: an export of a module that could not be loaded was used, and the row then threw \${name}: \${message.slice(0, 120)}\`,
          };
        } else if (SPY_UNDEFINED.length) {
          // FIX PLAN 1, F3.1: the subject read a field the proposal declared a
          // SPY on, the field was undefined, and the row then threw. A spy has
          // nothing to delegate to there, so the throw is the arrangement's -
          // most likely the read itself - and not this service's behaviour.
          out.invoked = false;
          out.harnessError = {
            name: "CharpilotFieldRefused",
            message: \`charpilot: \${[...new Set(SPY_UNDEFINED)].join(", ")}: spy on a field that is undefined on the receiver - there is nothing to observe, and the row threw after reading it (\${name}: \${message.slice(0, 120)}); declare an answer for the field instead\`,
          };
        } else {
          out.invoked = true;
          // snap(), not a hand-rolled pair. snap() was taught to keep an
          // error's own fields for exactly this case and all four throw paths
          // bypassed it, so the fix never applied to the thing it was written
          // for: notification-ms threw HttpException("Slack API error", 502,
          // SlackErrorCode.API_ERROR) and the row recorded
          // {"name":"Error","message":"Slack API error: unknown_error"} - no
          // status, no code, and name is "Error" because the class never sets
          // it, so the pair cannot tell an HttpException from a plain Error nor
          // a 404 mapping from the 502 fallback. Those are precisely what
          // slackBot.service.ts:65 and messageTemplate.service.ts:35 branch on.
          out.threw = snap(err);
        }
      }
    } finally {
      Math.random = REAL_MATH_RANDOM;
      __restoreClock();
      for (const k of Object.keys(origs)) console[k] = origs[k];
      for (const k of Object.keys(envBefore)) {
        if (envBefore[k] === undefined) delete process.env[k];
        else process.env[k] = envBefore[k];
      }
      // After the row's env: see pinRowZone.
      __restoreZone();
      builtinsRestored.push(...restoreBuiltins());
    }
    if (builtinsRestored.length) out.builtinsRestored = [...new Set(builtinsRestored)];
    if (MOCKS_FLUSHED === false) out.mocksNotFlushed = true;
    out.durationMs = HARNESS_DATE_NOW() - started;
    // THE BUDGET THIS ROW WAS MEASURED AGAINST, on every row and not only on
    // the ones that ran out of it. durationMs without it is unreadable: 9,940ms
    // is a near miss under the 10s default and a comfortable settle under
    // --row-timeout 45000, and the row said which nowhere.
    out.rowTimeoutMs = ROW_TIMEOUT_MS;
    out.console = captured;
    // A boundary the subject called without awaiting is still in flight right
    // now. Give those calls what is left of the row BEFORE the calls are taken,
    // or their entries are captured with no outcome and the emitted test has
    // nothing to replay them from. See settleInflight().
    await settleInflight(ROW_TIMEOUT_MS - (HARNESS_DATE_NOW() - started));
    // The recorded boundary calls OVERWRITE the proposal's planned behaviour.
    // A pair that merely echoes the plan proves nothing.
    out.boundaryCalls = takeCalls();
    // THE REPLAY'S OWN VERDICT, and the quietest of the three is the last one:
    // a recorded exchange the subject never asked for means it took a shorter
    // path than the observation did, every assertion on the return can still
    // pass, and nothing else in the row would say so.
    if (REPLAY_MODE) {
      // Truncated for size, but the COUNT is not truncated: a report that shows
      // five of sixteen without saying sixteen is how a number gets quoted low.
      if (REPLAY_MISMATCHES.length) {
        out.replayMismatch = REPLAY_MISMATCHES.slice(0, 5);
        out.replayMismatchCount = REPLAY_MISMATCHES.length;
      }
      if (REPLAY_LIMITS.length) {
        out.replayUnsupported = REPLAY_LIMITS.slice(0, 5);
        out.replayUnsupportedCount = REPLAY_LIMITS.length;
      }
      const unconsumed = replayUnconsumed();
      if (unconsumed.length) out.replayUnconsumed = unconsumed;
    }
    if (MOCK_FALLBACKS.length) {
      out.mockFallbacks = MOCK_FALLBACKS.map((f) => ({ module: f.module, why: String(f.why).slice(0, 200) }));
      MOCK_FALLBACKS = [];
    }
    if (CONFIG_OVERLAYS.length) {
      out.configOverlays = CONFIG_OVERLAYS.map((o) => ({ symbol: o.symbol, filled: o.filled.slice(0, 50) }));
      CONFIG_OVERLAYS = [];
    }
    // Give any floating promise a tick to settle so it is recorded here rather
    // than landing on the next row -- and a setImmediate turn, where
    // express-jwt's callback runs (see UNCAUGHT).
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setImmediate(r));
    // The row's field answers come off the singletons and classes it set them
    // on - after the tick, so a floating continuation of THIS row still saw
    // them, and before the next row starts. Each restore is attempted even if
    // another fails.
    for (const undo of __restore.splice(0).reverse()) { try { undo(); } catch { /* the receiver went away with its module */ } }
    dropRowProcessListeners(__processListeners);
    // Read after that same tick, so a fire-and-forget continuation's arms are
    // counted here rather than landing on the next row - the identical reason
    // the tick exists for FLOATING. No new await: this reads integers that are
    // already there.
    //
    // \`{}\` and null are different answers. \`{}\` means instrumented and nothing
    // moved; null means there were no counters to read at all, and every claim
    // on this row is then unmeasurable rather than false.
    //
    // covBefore is still null when the row THREW before its subject call - a
    // target expression that did not resolve, or a module whose import threw
    // ("SLACK_HOOK is not set", raised at import by the very arm the row
    // claims). Those rows moved arms, all of them in the arrangement window,
    // and the subject moved none. Reporting that as "no counters" blamed the
    // harness for what is a stage-3 entry-point defect.
    const covAtEnd = COVERAGE() ? covSnapshot() : null;
    out.movedBranches = covAtEnd === null ? null : covBefore ? covBetween(covBefore, covAtEnd) : {};
    // Same shape, the other window: what the row's own arrangement moved
    // before the subject ran. Never a verdict, only an explanation for one.
    out.movedBranchesBeforeSubject = covAtEnd === null ? null : covBetween(covAtRowStart, covBefore ?? covAtEnd);
    out.subjectCallStarted = covBefore !== null;
    if (FLOATING.length) out.unhandledRejections = FLOATING.slice(0, 5);
    if (UNCAUGHT.length) out.uncaughtAfterSettle = UNCAUGHT.slice(0, 5);
    // What this input TRIED to reach is behaviour worth pinning in its own
    // right - a fire-and-forget slack post shows up here and nowhere else.
    if (EGRESS.length) out.egressAttempts = [...new Set(EGRESS)];
    // A server the row's module graph started, held unbound (holdListen).
    if (LISTENS.length) out.serverListens = LISTENS.slice(0, 5);
    // Two different situations reach this line and they are NOT equivalent.
    // A trip taken BEFORE the call settled already demoted the row above, so
    // anything still marked invoked here tripped the guard AFTER the return -
    // a fire-and-forget slack post the service never waits on. The returned
    // value was computed before the attempt, so it is trustworthy and the row
    // stays. What is NOT trustworthy is the call list: production's post
    // succeeds and this one was refused, so a test generated from this row must
    // not treat the observed calls as complete.
    if (EGRESS.length && out.invoked) out.egressAfterSettle = true;
    // Said on the row, so a reader can see the span exports were answered
    // locally rather than wonder why a traced service made no calls.
    if (TELEMETRY) out.telemetryAnsweredLocally = TELEMETRY;
    // Both halves, as asked: out.returned is what the FUNCTION produced,
    // out.downstream is what actually went over the wire and came back.
    if (LIVE_MODE) {
      out.live = true;
      out.capturedAt = new Date().toISOString();
      if (DOWNSTREAM.length) out.downstream = DOWNSTREAM;
    }
    results.push(out);
    writeFileSync(RESULT, JSON.stringify(results, null, 2));
    // The branch map travels with the results, and per row rather than at the
    // end of the chunk: a branch INDEX is meaningless without the map that
    // says which (file, type, line) it is, and a wedged chunk still leaves
    // rows behind (RESULT is flushed per row for exactly that reason). One
    // written only on a clean finish would leave those rows' movement
    // unmappable, and an unmappable claim reads as FALSE.
    writeFileSync(BRANCHMAP, JSON.stringify(covSkeleton()));
    // Flushed per row, not at the end: a wedged chunk must still leave a
    // complete undo trail behind, or a mutation becomes unrevertable because
    // the process died before writing it down.
    if (JOURNAL_ENTRIES.length) writeFileSync(JOURNAL, JSON.stringify(JOURNAL_ENTRIES, null, 2));
  }
`;
    })
    ;
  // The per-row bodies, kept as an ARRAY: record mode joins them into one
  // `it`, test mode wraps each in its own. Both use the SAME body text.
  const blocksList = blocks;
  const blocksJoined = blocksList.join("\n");


  // STAGE 5 - the generated test. Same row blocks, same ROW_RUNTIME, same
  // arrangement; the difference is that each row is its own `it` and the
  // recorded outcome is asserted instead of written down.
  if (mode === "test") {
    const wrapped = rows
      .map((row, i) => {
        const a = assertionFor(row);
        // A side LABEL can contain newlines - a destructured default-arg label is
        // the whole pattern, `{\n  maxRetry,\n  actionName,\n}`. Dropped into a
        // `//` comment verbatim it ends the comment mid-way and the rest of the
        // pattern becomes code: one such label made a 2000-line test file
        // unparseable ("Unexpected }"). Every comment value is flattened.
        const flat = (x) => String(x).replace(/\s+/g, " ").trim();
        const claim = Object.entries(row.reaches ?? {})
          .map(([k, v]) => `${flat(k)} -> ${flat(Array.isArray(v) ? v.join(", ") : v)}`)
          .join("; ");
        const header = [
          `  // [recorded: ${row.id}]  ${flat(row.file)}`,
          `  // covers:  ${flat((row.covers ?? []).join(", ")) || "(none)"}`,
          `  // claims:  ${claim || "(none)"}`,
          `  // asserts: ${a.strength ?? a.why}`,
          row.__claimUnverified
            ? "  // UNVERIFIED: stage 6 measured this side as never reached, so this test\n  //             pins behaviour that is NOT the arm named above. Repair the input."
            : null,
        ].filter(Boolean).join("\n");
        if (a.kind === "skip") return `${header}\n  it.skip(${JSON.stringify(row.id)}, () => {});`;
        return `${header}
  it(${JSON.stringify(`${row.id} - ${a.kind}`)}, async () => {
${blocksList[i]}
    ${a.code}
  }, ${itTimeoutMs(rowTimeoutMs)});`;
      })
      .join("\n\n");

    const testFile = `// GENERATED by \`.claude/charpilot/record.mjs --emit-tests\` (stage 5) - do not hand-edit.
//
// Every assertion here was produced by RUNNING the code, never by predicting it.
// A failure means production behaviour CHANGED: decide whether that change was
// intended, then re-record. It does not mean the test is wrong, and it is not a
// licence to edit the expected value until it passes.
//
// Not type-checked: the row runtime is untyped JavaScript shared verbatim with
// the recorder, and it is checked by being RUN. See the note at EMITTED_PRAGMAS.
// @ts-nocheck
/* eslint-disable */
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, SourceMap } from "node:module";
import { afterAll, expect, it, vi } from "vitest";

import * as doubles from "${doublesImport(dest)}";

// The row body below is the RECORDING body, verbatim. Reusing it unchanged is
// what guarantees the test is arranged exactly as the observation was, so these
// bindings exist to satisfy it: results/RESULT/writeFileSync are the
// recorder's output path, and a test asserts rather than records, so the write
// is a no-op. Faking the arrangement instead would be faking the test.
const ROWS = ${JSON.stringify(rows.map(({ shape, mocks, bindable, env, calls, seeds, entry, proposal, __args, __mocks, __scope, __calls, __seeds, __env, __claimUnverified, __observation, ...r }) => r), null, 2)};
const RESULT = "";
// A test asserts, it does not record - so both output paths are inert here and
// the write is a no-op. The row body is reused VERBATIM; faking the
// arrangement instead would be faking the test.
const BRANCHMAP = "";
const ROW_MARK = "";
const writeFileSync = () => {};
const results = [];
const ROW_TIMEOUT_MS = ${rowTimeoutMs};

/**
 * Remove a dotted path from an observed value before comparing.
 *
 * Used only for paths determinism.mjs measured as unstable across two runs -
 * a container keyed by a freshly generated id, for instance. Everything else in
 * the value stays asserted.
 */
function dropPath(obj, path) {
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const k of parts.slice(0, -1)) {
    if (cur == null || typeof cur !== "object") return;
    cur = cur[k];
  }
  // An ARRAY slot is nulled, not deleted: the expected value is a JSON literal,
  // where a deleted slot is written \`null\`, and a hole never equals null.
  // company-enrich PR #30, arg0-of-fromRedis-proxies-forEach-56-*: a Map entry
  // [0, <timestamp>] measured unstable at $map.0.1 failed on
  //   expected { $map: [[0, undefined]] } to deeply equal { $map: [[0, null]] }
  if (Array.isArray(cur)) cur[parts[parts.length - 1]] = null;
  else if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
}
const DB_CLIENT_MODULES = ${JSON.stringify(dbClientModules().modules)};
const DB_CLIENT_FILES = new Set(${JSON.stringify(dbClientFiles())});
${ROW_RUNTIME}
${wrapped}
`;
    writeFileSync(dest, testFile);
    return rows.map((row) => ({ id: row.id, ...assertionFor(row) }));
  }

  const spec = `// GENERATED by .claude/charpilot/record.mjs - do not edit, do not commit.
import { writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, SourceMap } from "node:module";
import { afterAll, it, vi } from "vitest";

import * as doubles from "${doublesImport(dest)}";

const ROWS = ${JSON.stringify(rows.map(({ shape, mocks, bindable, env, calls, entry, ...r }) => r), null, 2)};
const RESULT = ${JSON.stringify(specResult)};
const BRANCHMAP = ${JSON.stringify(specBranchmap)};
const ROW_MARK = ${JSON.stringify(isRecorderSpec ? slot.rowMark : "")};
const JOURNAL = ${JSON.stringify(JOURNAL)};
const ROW_TIMEOUT_MS = ${rowTimeoutMs};

const DB_CLIENT_MODULES = ${JSON.stringify(dbClientModules().modules)};
const DB_CLIENT_FILES = new Set(${JSON.stringify(dbClientFiles())});
${ROW_RUNTIME}
it("records observed behaviour for each stage-3 input", async () => {
  const results = [];
${blocksJoined}
  writeFileSync(RESULT, JSON.stringify(results, null, 2));
});
`;
  writeFileSync(dest, spec);
}

// Print the WHOLE message. `split("\n")[0]` threw away every remedy line a
// refusal carried - the reader got "refusing to overwrite X" and none of the
// three ways out of it.
// Only when this file is the ENTRY POINT. Importing it to inspect one export
// used to execute a full 366-row recording - which happened, to me, while
// checking that the module even loaded. Same guard as exec.mjs.
// `import.meta.main` needs Node 24. On an older runtime it is undefined, and a
// bare truthiness test would then turn every tool here into a silent no-op -
// far worse than a crash, because a pipeline that runs and does nothing reports
// success. So the absence is an error, not a fallback.
if (import.meta.main === undefined) {
  throw new Error("charpilot requires Node >= 24: import.meta.main is unavailable on " + process.version);
}
if (import.meta.main && ARGV.includes("--harness-version")) {
  // THE TOOLSET THIS RUN WOULD STAMP A ROW WITH (`__recordedBy`), and nothing
  // else: steps/emit.mjs asks it to tell a red row another toolset recorded
  // from one this one did, before it spends a recording on it.
  process.stdout.write(`${harnessVersion()}\n`);
} else if (import.meta.main) {
  main().catch((e) => { process.stderr.write(`\n✗ ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
