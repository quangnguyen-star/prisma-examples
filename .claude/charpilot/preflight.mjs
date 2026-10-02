#!/usr/bin/env node
/**
 * Stage 4 preflight - what can this machine actually reach, and what must it
 * never call?
 *
 * Two different questions, and both have to be answered BEFORE recording:
 *
 *   reachable  - a DNS + TCP check. If an address is unreachable from here, a
 *                failure against it is a HARNESS failure, and recording it as
 *                behaviour is the worst outcome available. Several downstream
 *                addresses default to localhost in env.ts, which from a laptop
 *                means "my machine", not staging.
 *
 *   forbidden  - metered or side-effecting regardless of reachability. An LLM
 *                provider bills per call; the Slack hook posts to a real
 *                channel. These are default-DENY: a proposal may only reach
 *                them through a mock, never a passthrough.
 *
 *   node .claude/charpilot/preflight.mjs [--env-file <path>]
 */
import { createConnection } from "node:net";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { OUT_DIR, REPO_ROOT } from "./config.mjs";
// The allowlist `record.mjs` ENFORCES, read the way handoff.mjs reads it. See
// the block above `targets()` for why this file no longer keeps its own copy,
// and for the one direction this dependency is allowed to point in.
import { RECORD_MJS, enforcedAllowlist } from "./handoff.mjs";
import { parseEnvText } from "./envfile.mjs";

const ARGV = process.argv.slice(2);
const ENV_FILE = ARGV.includes("--env-file") ? ARGV[ARGV.indexOf("--env-file") + 1] : undefined;
const OUTPUT = resolve(OUT_DIR, "preflight.json");

/**
 * Default-deny. Nothing here may be reached by a real call during a recording
 * run, however reachable it is.
 */
const FORBIDDEN = [
  { match: /api\.openai\.com/i, why: "metered - bills per request" },
  { match: /api\.anthropic\.com/i, why: "metered - bills per request" },
  { match: /aiplatform\.googleapis\.com/i, why: "metered - bills per request" },
  { match: /api\.deepseek\.com/i, why: "metered - bills per request" },
  { match: /hooks\.slack\.com/i, why: "side-effecting - posts to a real channel" },
];

function loadEnv() {
  const env = { ...process.env };
  if (!ENV_FILE) return env;
  if (!existsSync(ENV_FILE)) throw new Error(`--env-file ${ENV_FILE} not found`);
  Object.assign(env, parseEnvText(readFileSync(ENV_FILE, "utf8")));
  return env;
}

/* ---------------------------------------------------------------------------
 * THE PROBE LIST IS THE ENFORCED ALLOWLIST'S, IN ONE DIRECTION ONLY.
 *
 * This file used to answer "which addresses does this service dial?" from a
 * hand-written list: `langfuse.qode.world`, `us-central1-aiplatform.googleapis.com`,
 * the redis and zipkin localhost defaults, and four provider hosts. That is a
 * SECOND COPY of a question `record.mjs` already answers, and it was wrong in
 * the way a second copy always is. Run `20260916T223906Z` dialled
 * `places.googleapis.com` and `maps.googleapis.com` — the two hosts location-ms
 * exists to call, named by `googleMap.service.ts` and reached through
 * `baseline.json`'s `egressHosts.fromSource` — and neither was in any row here.
 * They were the hosts whose rows in the stage-4 address table read
 * "not preflighted", and they were the hosts the run's skips named.
 *
 * `65241cf` fixed the TABLE: handoff.mjs generates its rows from the enforcement
 * and joins preflight in only for reachability, so the table no longer trusts
 * this file. But the table can only report what was measured, and this file was
 * still MEASURING THE WRONG SET. So the probe list comes from the same place the
 * table's rows do — `enforcedAllowlist()`, over `record.mjs`'s source and the
 * two stage-1 artifacts its own `stagingAllowHosts()` reads.
 *
 * THE DIRECTION IS THE WHOLE DESIGN, AND IT IS ONE-WAY.
 *
 *   allowlist -> probe list      what this file now does
 *   probe list -> allowlist      never, in any form
 *
 * Preflight MEASURES reachability; the allowlist AUTHORISES. Generating the
 * allowlist from what preflight found would open egress to whatever happens to
 * answer a TCP connect, which is the same defect with the loss pointing the
 * other way. Nothing in this file is read by `record.mjs`, and `preflight.json`
 * is read by `handoff.mjs` for one column — `enforcedAllowlist()` does not even
 * take a preflight argument, so there is no parameter through which a
 * measurement could become an allowance.
 *
 * WHAT STAYS. The env-derived rows — postgres, redis, zipkin — are not a copy of
 * anything: they carry the PORT, which a host allowlist does not have, and the
 * "DEFAULTS TO LOCALHOST" finding, which is the single most useful thing this
 * tool reports and is a fact about `env.ts`, not about egress.
 * ------------------------------------------------------------------------ */

/** A JSON artifact if it is there and readable, `dflt` otherwise. Never a throw. */
function readOr(path, dflt) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : dflt;
  } catch {
    return dflt;
  }
}

/**
 * The allowlist as `record.mjs` will enforce it, plus which sources were there.
 *
 * `stagingEnv` and `baseline` are stage-1 artifacts and this step runs FIRST in
 * the walk (`steps/index.mjs` ORDER), so on a first pass they are absent and the
 * derived half of the allowlist is empty with them. That is reported, loudly,
 * rather than papered over: the hosts it cannot see are exactly the ones that
 * started this — `maps`/`places.googleapis.com` come from `baseline.json`.
 */
export function enforcedFromDisk(env = process.env) {
  const stagingPath = resolve(OUT_DIR, "staging-env.json");
  const baselinePath = resolve(OUT_DIR, "baseline.json");
  return {
    allowlist: enforcedAllowlist({
      recordSource: existsSync(RECORD_MJS) ? readFileSync(RECORD_MJS, "utf8") : "",
      stagingEnv: readOr(stagingPath, null),
      baseline: readOr(baselinePath, null),
      env,
    }),
    // Named by path, because "which artifact was missing" is the actionable
    // half of an incomplete probe list.
    sources: {
      "record.mjs": existsSync(RECORD_MJS),
      "out/staging-env.json": existsSync(stagingPath),
      "out/baseline.json": existsSync(baselinePath),
    },
  };
}

/**
 * Every `host -> port` a URL in this environment names.
 *
 * The allowlist is a list of HOSTS; a probe needs a port. 443 is the right
 * default for the provider and ingress hosts and the wrong one for the staging
 * database, which run `20260916T223906Z` reached at `34.143.159.14:5434` — an
 * address named by `DATABASE_URL`, right here in the environment. So the port
 * is read off the environment when the environment states it, and assumed only
 * when nothing does. The row says which of the two happened.
 */
export function portsFromEnv(env) {
  const byHost = new Map();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.includes("://")) continue;
    let u;
    try {
      u = new URL(value);
    } catch {
      continue;
    }
    if (!u.hostname) continue;
    const port = Number(u.port || (u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : 0));
    if (!port) continue;
    if (!byHost.has(u.hostname)) byHost.set(u.hostname, { port, source: name });
  }
  return byHost;
}

/**
 * A short label for the left column. Presentation only — nothing reads it as a
 * key, and it holds no vocabulary that could disagree with anything.
 */
function label(host) {
  const parts = String(host).split(".");
  if (parts.length < 3 || /^\d+$/.test(parts[0])) return host;
  // Two labels read better than one - `places` and `maps` are both
  // `googleapis` underneath - but not at the cost of running into the address
  // column, which `qode-communication.communication.azure.com` does.
  const two = parts.slice(0, 2).join(".");
  return two.length <= 20 ? two : parts[0];
}

/** Addresses this service dials, and where each one comes from. */
export function targets(env, allowlist = { hosts: [], refusal: null }) {
  const out = [];
  const push = (name, host, port, source, note) => out.push({ name, host, port, source, note });

  if (env.DATABASE_URL) {
    try {
      const u = new URL(env.DATABASE_URL);
      push("postgres", u.hostname, Number(u.port || 5432), "DATABASE_URL", "read/write - only the read-only URL should be used for probes");
    } catch {
      push("postgres", "(unparseable DATABASE_URL)", 0, "DATABASE_URL", "");
    }
  }
  if (env.DATABASE_URL_READ_ONLY) {
    try {
      const u = new URL(env.DATABASE_URL_READ_ONLY);
      push("postgres-readonly", u.hostname, Number(u.port || 5432), "DATABASE_URL_READ_ONLY", "preferred for every probe");
    } catch {
      /* ignore */
    }
  }

  push(
    "redis",
    env.REDIS_HOST ?? "localhost",
    Number(env.REDIS_PORT ?? 6379),
    env.REDIS_HOST ? "REDIS_HOST" : "env.ts default",
    env.REDIS_HOST ? "" : "DEFAULTS TO LOCALHOST - this is not staging's redis"
  );

  try {
    const z = new URL(env.ZIPKIN_COLLECTOR_ENDPOINT ?? "http://localhost:9411/api/v2/spans");
    push(
      "zipkin",
      z.hostname,
      Number(z.port || (z.protocol === "https:" ? 443 : 80)),
      env.ZIPKIN_COLLECTOR_ENDPOINT ? "ZIPKIN_COLLECTOR_ENDPOINT" : "env.ts default",
      env.ZIPKIN_COLLECTOR_ENDPOINT ? "" : "DEFAULTS TO LOCALHOST - spans go nowhere"
    );
  } catch {
    /* ignore */
  }

  // AND THE REST OF THE LIST IS THE ALLOWLIST, HOST FOR HOST.
  //
  // Not filtered, not judged, not narrowed: every host `record.mjs` will open is
  // a host whose reachability this report is about, and one that reads
  // "not preflighted" in the stage-4 table is a row that cost the run an hour to
  // discover. `langfuse.qode.world` and the four provider hosts used to be typed
  // above and now arrive here, through `record.mjs`'s own `LIVE_HOSTS` and
  // `PROVIDER_HOSTS`; `maps`/`places.googleapis.com` arrive with them, through
  // `baseline.json`, which is the whole point.
  const ports = portsFromEnv(env);
  for (const entry of allowlist.hosts ?? []) {
    const host = entry.host;
    // Loopback is open in every mode and has no address of its own to dial. The
    // redis and zipkin rows above already probe the real loopback PORTS, which
    // is the question worth asking about it.
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") continue;
    // An env-derived row already holds this host at the port the environment
    // states. A second row at an assumed 443 would report the same host
    // unreachable beside itself.
    if (out.some((t) => t.host === host)) continue;
    const known = ports.get(host);
    push(
      label(host),
      host,
      known ? known.port : 443,
      `record.mjs allowlist — ${entry.from.join("; ")}`,
      `opens under ${entry.opensUnder}${known ? `; port from ${known.source}` : "; port assumed 443 — the allowlist names hosts, not ports"}`
    );
  }
  return out;
}

function tcp(host, port, timeoutMs = 4000) {
  return new Promise((done) => {
    const socket = createConnection({ host, port });
    const finish = (ok, detail) => {
      socket.destroy();
      done({ ok, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, `timeout after ${timeoutMs}ms`));
    socket.once("error", (err) => finish(false, err.message));
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const env = loadEnv();
  const { allowlist, sources } = enforcedFromDisk(env);
  const rows = [];

  for (const t of targets(env, allowlist)) {
    const forbidden = FORBIDDEN.find((f) => f.match.test(t.host));
    const row = { ...t, forbidden: forbidden ? forbidden.why : null };

    if (forbidden) {
      // Deliberately not dialled. Confirming a metered endpoint is up is not
      // worth a request, and a recording run must never call it anyway.
      row.status = "forbidden";
      row.detail = "not dialled by design";
      rows.push(row);
      continue;
    }

    try {
      const dns = await lookup(t.host);
      row.resolved = dns.address;
    } catch (err) {
      row.status = "unresolvable";
      row.detail = err.message;
      rows.push(row);
      continue;
    }

    const probe = await tcp(t.host, t.port);
    row.status = probe.ok ? "reachable" : "unreachable";
    row.detail = probe.detail;
    rows.push(row);
  }

  // WHERE THE PROBE LIST CAME FROM, ON THE ARTIFACT.
  //
  // A reader holding preflight.json cannot otherwise tell a complete probe list
  // from one taken before stage 1 wrote the artifacts the allowlist derives
  // half of itself from. `allowlistRefusal` is the same refusal handoff.mjs
  // prints instead of a table — if `record.mjs` no longer reads the way this is
  // written, the list here is the env-derived rows and nothing else, and it
  // says so rather than looking short.
  //
  // NOTHING DOWNSTREAM MAY TREAT THIS AS AN ALLOWANCE. It is provenance for a
  // measurement. `record.mjs` reads no part of this file.
  const doc = {
    stage: "4-preflight",
    checkedAt: new Date().toISOString(),
    probeList: {
      from: "the allowlist record.mjs enforces (handoff.mjs enforcedAllowlist), plus the env-derived addresses that carry a port",
      sources,
      allowlistHosts: (allowlist.hosts ?? []).map((h) => h.host).sort(),
      allowlistRefusal: allowlist.refusal,
    },
    rows,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);

  const mark = { reachable: "\u2713", unreachable: "\u2717", unresolvable: "\u2717", forbidden: "\u2298" };
  process.stdout.write(`\npreflight \u2192 ${relative(REPO_ROOT, OUTPUT)}\n\n`);
  for (const r of rows) {
    process.stdout.write(
      `  ${mark[r.status] ?? "?"} ${r.name.padEnd(20)} ${`${r.host}:${r.port}`.padEnd(46)} ${r.status}\n` +
        `      source: ${r.source}${r.note ? `\n      note:   ${r.note}` : ""}` +
        `${r.forbidden ? `\n      DENY:   ${r.forbidden}` : ""}` +
        `${r.status === "unreachable" || r.status === "unresolvable" ? `\n      detail: ${r.detail}` : ""}\n`
    );
  }

  const bad = rows.filter((r) => r.status === "unreachable" || r.status === "unresolvable");
  const localhostDefaults = rows.filter((r) => /DEFAULTS TO LOCALHOST/.test(r.note ?? ""));
  process.stdout.write(
    `\n  reachable ${rows.filter((r) => r.status === "reachable").length}` +
      ` \u00b7 unreachable ${bad.length}` +
      ` \u00b7 forbidden ${rows.filter((r) => r.status === "forbidden").length}\n`
  );
  if (localhostDefaults.length) {
    process.stdout.write(
      `\n  ${localhostDefaults.length} address(es) fall back to an env.ts localhost default, which from here means\n` +
        "  THIS MACHINE, not staging. A passthrough to one of those records local behaviour.\n"
    );
  }

  // THE PROBE LIST IS ONLY AS COMPLETE AS THE ARTIFACTS IT WAS DERIVED FROM.
  //
  // `preflight` is the FIRST step of the walk (steps/index.mjs ORDER), and two
  // of the allowlist's three sources are written by steps that come after it.
  // On a first pass `baseline.json` is absent — and `baseline.json` is where
  // `maps.googleapis.com` and `places.googleapis.com` come from, the exact two
  // hosts whose absence from this report started all of this. So the shortfall
  // is named with the command that closes it, rather than being a quiet gap
  // that reads in the stage-4 table as "not preflighted".
  if (allowlist.refusal) {
    process.stdout.write(`\n  ! ${allowlist.refusal}\n    Probed the env-derived addresses only.\n`);
  }
  const absent = Object.entries(sources).filter(([, there]) => !there).map(([path]) => path);
  if (absent.length) {
    process.stdout.write(
      `\n  ! ${absent.join(" and ")} ${absent.length > 1 ? "do" : "does"} not exist yet, so the hosts ${absent.length > 1 ? "they name" : "it names"} were NOT probed.\n` +
        "    Those are the derived half of the allowlist record.mjs enforces - on location-ms they are\n" +
        "    maps.googleapis.com and places.googleapis.com, read out of the service's own source.\n" +
        "    Re-run this after stage 1 (`node .claude/charpilot/preflight.mjs`) to measure them.\n"
    );
  }
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