#!/usr/bin/env node
/**
 * Stage 1, second half - resolve the staging environment FROM THE MANIFESTS.
 *
 * The baseline recorded the SUITE. It never resolved the environment the later
 * stages would run against, so stage 4 discovered its own addresses one failure
 * at a time. This closes that.
 *
 * It reads qode-iac and nothing else. No kubectl, no DNS lookup, no TCP probe,
 * no network call of any kind - deliberately, because the agent running this
 * frequently has no cluster credential, and a stage that needs one is a stage
 * that does not run. Everything here is derivable from committed YAML:
 *
 *   Ingress host                  -> published, reachable from outside
 *   Service type ClusterIP        -> cluster-only, must be doubled or forwarded
 *   Service type LoadBalancer     -> external address is NOT in the manifest
 *   *.svc.cluster.local, ns-form  -> cluster-only
 *   RFC1918 literal               -> cluster-only
 *   localhost / 127.*             -> THIS machine, which is the dangerous one
 *   public IP or dotted hostname  -> outside the cluster
 *
 * A cluster query can confirm any of that; it can never be a prerequisite. Where
 * the manifests cannot answer - a LoadBalancer's assigned address is the real
 * case - the report says UNVERIFIED rather than guessing.
 *
 *   node .claude/charpilot/stagingenv.mjs \
 *     --iac  <path to qode-iac> \
 *     [--env <path to the service .env>] \
 *     [--namespace staging] \
 *     [--db-address host:port]
 *
 * Writes, both under gitignored out/:
 *   staging-env.json  - the report. Secret VALUES are redacted to a length and
 *                       a fingerprint; hosts and non-secret values are kept.
 *   staging.env       - the real values, for `record.mjs --env-file`. Never
 *                       committed, never printed.
 *
 * Nothing secret is written to stdout or to any tracked file.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { BASELINE_JSON, OUT_DIR, REPO_ROOT, SRC_ROOT, databasePlaceholder, isDatabaseVar, isNoDatabase, isSrcExcluded } from "./config.mjs";
import { envNames, parseEnvText } from "./envfile.mjs";
import { planStandIns } from "./standins.mjs";

/**
 * Which service's manifests to read.
 *
 * This was hardcoded, which is why this script had never run on any repo but
 * the one it was written in - every fleet repo recorded `process-env-only`
 * instead, and two of them carry a local .env pointing at localhost, which is
 * THIS machine rather than staging. Derived from the target so the common case
 * needs no flag, and `--service` overrides it where the manifest prefix differs
 * from the package name.
 *
 * The package NAME is not always there to derive from: profile-centralized's
 * package.json has `scripts` and no `name`, so the old module-scope version of
 * this exited 1 before anything ran - `! no --service and no name in the
 * target's package.json` - on a repo whose manifests are named
 * `profile-centralized` exactly, i.e. one this could have resolved. The
 * DIRECTORY is the second source, and it is the one qode-iac agrees with far
 * more often than not, because a checkout is normally named after the service.
 * Both candidates are returned so the caller can report which one answered.
 */
export function defaultService(repoRoot = REPO_ROOT) {
  let fromPackage = null;
  try {
    fromPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name?.replace(/^@[^/]+\//, "") ?? null;
  } catch {
    fromPackage = null;
  }
  const fromDirectory = repoRoot.split("/").filter(Boolean).pop() ?? null;
  return { service: fromPackage ?? fromDirectory, fromPackage, fromDirectory };
}

/**
 * Where qode-iac is, without asking.
 *
 * `--iac` stays the explicit answer and `CHARPILOT_IAC` the per-machine one.
 * The search exists because stage 1 now resolves the environment as part of
 * baseline.mjs, and a stage that needs a path typed by hand is a stage that
 * gets skipped - which is exactly how six repos ended up with the artifact and
 * a fresh onboarding with none. Only committed YAML is read either way, so a
 * wrong guess is inert: it either holds `manifests/` or it is not returned.
 */
export function findIac(repoRoot = REPO_ROOT) {
  const candidates = [];
  if (process.env.CHARPILOT_IAC) candidates.push(process.env.CHARPILOT_IAC);
  // Up the tree from the target, and at each level the two layouts this fleet
  // actually uses: a sibling checkout, and the qode-knowledge submodule pool.
  let dir = repoRoot;
  for (let i = 0; i < 5 && dir !== "/"; i++) {
    candidates.push(join(dir, "qode-iac"), join(dir, "qode-knowledge", "repos", "qode-iac"), join(dir, "repos", "qode-iac"));
    dir = resolve(dir, "..");
  }
  for (const c of candidates) {
    if (existsSync(join(c, "manifests"))) return { iac: resolve(c), from: process.env.CHARPILOT_IAC === c ? "CHARPILOT_IAC" : "found beside the target" };
  }
  return { iac: null, from: null };
}

/** Anything matching is never printed and never written to the report in full. */
const SECRET = /(PASSWORD|SECRET|TOKEN|_KEY$|APIKEY|API_KEY|PRIVATE|HOOK|DATABASE_URL|CREDENTIAL)/i;

const fingerprint = (v) => `${v.length} chars, sha256:${createHash("sha256").update(v).digest("hex").slice(0, 8)}`;

/* ------------------------------------------------------------------ manifests */

/**
 * Every manifest for this service in this namespace, by kind.
 *
 * The filename is NOT `${SERVICE}.yaml` everywhere: staging's ingress is
 * `ai-centralization-ms-ingress.yaml`, development's is `ai-centralization-ms.yaml`,
 * and production has TWO ingress files. A hardcoded name silently reads one of
 * them and reports "(none found)" for the rest, so match on prefix and take all.
 */
function manifests(iac, kind, ns, service) {
  const dir = join(iac, "manifests", kind, ns);
  if (!existsSync(dir)) return [];
  // Prefix, but the character after the prefix has to be `.` or the start of
  // `-ingress`. A bare startsWith is what this comment above describes as the
  // fix and it over-matches on any service whose name prefixes another: on
  // ptp-be it also caught ptp-be-aansi, ptp-be-bg, ptp-be-japanese-staging and
  // ptp-be-poc-turing, and since the deployment is read as
  // `manifests("deployments")[0]` after sorting, the resolved environment came
  // from ptp-be-aansi - a different tenant's deployment, silently.
  const exact = new RegExp(`^${service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-ingress[^.]*)?\\.ya?ml$`);
  return readdirSync(dir)
    .filter((n) => exact.test(n))
    .sort()
    .map((n) => ({ path: join(dir, n), rel: relative(iac, join(dir, n)), text: readFileSync(join(dir, n), "utf8") }));
}

/**
 * Which manifest prefix this service deploys under, tried rather than asked.
 *
 * The name asked for (--service, CHARPILOT_SERVICE, or the package / directory
 * name) wins whenever it has a ConfigMap or Secret. When it has none, the near
 * names are tried - `<name>-ms`, the package.json name, the directory name and
 * their `-ms` forms - and EXACTLY ONE match is used. Two matches use none: a
 * guess between two tenants' manifests is how ptp-be once read ptp-be-aansi's
 * deployment. Only committed YAML is read, and `manifests()` keeps its exact
 * prefix rule, so `company-enrich-ms` never matches `company-enrich-ms-poc`.
 */
export function resolveManifestPrefix(iac, ns, asked, derived = {}) {
  const has = (name) => ["configmaps", "secrets"].some((kind) => manifests(iac, kind, ns, name).length > 0);
  if (has(asked)) return { asked, used: asked, from: "as named", tried: [asked], matched: [asked] };
  const near = [
    [`${asked}-ms`, "<name>-ms"],
    [derived.fromPackage, "package.json name"],
    [derived.fromPackage && `${derived.fromPackage}-ms`, "package.json name + -ms"],
    [derived.fromDirectory, "target directory name"],
    [derived.fromDirectory && `${derived.fromDirectory}-ms`, "target directory name + -ms"],
  ].filter(([n]) => n && n !== asked);
  const tried = [asked];
  const from = {};
  for (const [n, how] of near) {
    if (tried.includes(n)) continue;
    tried.push(n);
    from[n] = how;
  }
  const matched = tried.slice(1).filter(has);
  return matched.length === 1
    ? { asked, used: matched[0], from: from[matched[0]], tried, matched }
    : { asked, used: null, from: null, tried, matched };
}

/** One flat `data:` block. Not a YAML dependency, so it must fail visibly. */
function parseDataBlock(text, { base64 = false } = {}) {
  const out = {};
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^data:\s*$/.test(l));
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^[a-zA-Z]/.test(line)) break;
    const m = line.match(/^\s{2}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim().replace(/^['"]|['"]$/g, "");
    out[m[1]] = base64 ? Buffer.from(raw, "base64").toString("utf8").trim() : raw;
  }
  return out;
}

function parseDotenv(text) {
  // The one env reader (envfile.mjs), so a multi-line PEM in the repo's .env
  // is read whole here too.
  return parseEnvText(text);
}

/**
 * Every Service and every Ingress host in the WHOLE tree, not just this
 * namespace - a boundary this service dials usually lives in another one
 * (`postgres.database-staging`, `jaeger-service.monitoring`). This is the table
 * that makes reachability answerable without a cluster.
 */
function topology(iac) {
  const services = new Map(); // "name" and "name.namespace" -> { type, rel, ports }
  const ingressHosts = new Map(); // host -> { rel, backend }
  const root = join(iac, "manifests");
  if (!existsSync(root)) return { iac, services, ingressHosts };

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.ya?ml$/.test(entry.name)) continue;
      const text = readFileSync(p, "utf8");
      const rel = relative(iac, p);
      for (const doc of text.split(/^---\s*$/m)) {
        const kind = (doc.match(/^kind:\s*(\S+)/m) ?? [])[1];
        const name = (doc.match(/^\s*name:\s*(\S+)/m) ?? [])[1];
        const ns = (doc.match(/^\s*namespace:\s*(\S+)/m) ?? [])[1];
        if (kind === "Service" && name) {
          const rec = {
            type: (doc.match(/^\s*type:\s*(\S+)/m) ?? [])[1] ?? "ClusterIP",
            ports: [...doc.matchAll(/^\s*(?:port|targetPort|nodePort):\s*(\d+)/gm)].map((m) => m[1]),
            rel,
            namespace: ns ?? null,
          };
          services.set(name, rec);
          if (ns) services.set(`${name}.${ns}`, rec);
        }
        if (kind === "Ingress") {
          for (const m of doc.matchAll(/^\s*-\s*host:\s*(\S+)/gm)) {
            ingressHosts.set(m[1], {
              rel,
              backend: (doc.match(/service:\s*\n\s*name:\s*(\S+)/) ?? [])[1] ?? null,
            });
          }
        }
      }
    }
  };
  walk(root);
  return { iac, services, ingressHosts };
}

/* ------------------------------------------------------------------ classify */

const hostOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return value.split("@").pop().split("/")[0].split(":")[0];
  }
};

/**
 * Reachable from outside the cluster? Answered from the manifests, never from
 * a probe. `topo` is the Service/Ingress table built above.
 */
function classify(value, topo) {
  if (typeof value !== "string" || value === "") return { scope: "value" };

  // A port, a timeout and a threshold are not addresses. Treating any
  // all-numeric or dotted string as a host made six ConfigMap integers -
  // 700, 2000, 30000, 6379 and two timeouts - report as `public`, which made
  // the whole scope tally unusable.
  if (/^\d+(\.\d+)?$/.test(value)) return { scope: "value", why: "numeric - a port, size or duration, not an address" };
  if (/^(true|false)$/i.test(value)) return { scope: "value" };

  const looksLikeAddress = /:\/\/|^[a-z0-9.-]+:\d+$|\.[a-z]{2,}$|\.svc$|\.local$|^\d{1,3}(\.\d{1,3}){3}/i.test(value);
  if (!looksLikeAddress) return { scope: "value" };

  const host = hostOf(value);
  if (!host || /^\d+$/.test(host)) return { scope: "value" };

  if (/^localhost$|^127\./.test(host)) {
    return { scope: "localhost", host, why: "THIS machine - not staging. A wrong-but-reachable address ANSWERS instead of failing" };
  }

  const ing = topo.ingressHosts.get(host);
  if (ing) {
    return {
      scope: "public",
      host,
      why: `published by an Ingress (${ing.rel})${ing.backend ? `, backend service \`${ing.backend}\`` : ""}`,
      manifest: ing.rel,
      backend: ing.backend,
    };
  }

  // `name.namespace`, `name.namespace.svc`, `name.namespace.svc.cluster.local`.
  // When the host names a namespace, the lookup MUST be the qualified pair:
  // `postgres` alone matches a Service in some other namespace out of the 445
  // indexed, and would attribute this boundary to the wrong manifest. Only a
  // single-label host may fall back to the bare name.
  const label = host.split(".")[0];
  const nsGuess = host.split(".")[1];
  const svc = nsGuess
    ? topo.services.get(`${label}.${nsGuess}`)
    : topo.services.get(host.replace(/\.svc(\.cluster\.local)?$/, "")) ?? topo.services.get(label);
  if (svc) {
    if (svc.type === "LoadBalancer") {
      return {
        scope: "cluster-internal",
        host,
        manifest: svc.rel,
        unverified: "the LoadBalancer's assigned external address is NOT in the manifest - it cannot be established from qode-iac",
        why: `a Service of type LoadBalancer (${svc.rel}). This NAME is cluster-only; whether an external address exists is unknowable from the manifests`,
      };
    }
    return {
      scope: "cluster-internal",
      host,
      manifest: svc.rel,
      why: `a Service of type ${svc.type} (${svc.rel}) - resolvable only inside the cluster`,
    };
  }

  if (/\.svc(\.cluster\.local)?$|\.svc$/.test(host)) {
    return { scope: "cluster-internal", host, why: "kubernetes service DNS - resolvable only inside the cluster" };
  }
  if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { scope: "cluster-internal", host, why: "RFC1918 private address" };
  }
  // A bare `name.namespace` naming a namespace directory under manifests/ is
  // cross-namespace k8s DNS even when no Service manifest was found for it.
  if (nsGuess && existsSync(join(topo.iac, "manifests/services", nsGuess))) {
    return { scope: "cluster-internal", host, why: `\`${label}.${nsGuess}\` is cross-namespace kubernetes DNS - namespace \`${nsGuess}\` exists under manifests/services` };
  }
  return { scope: "public", host, why: "publicly routable hostname or address" };
}

/* ------------------------------------------------------------------- resolve */

/**
 * Resolve the environment and write both artifacts. The whole stage, callable.
 *
 * It is a FUNCTION and not just a CLI because stage 1 has to run it: the router
 * skill and the stage-1 skill both said stage 1 resolved staging "so stage 4
 * does not discover its addresses one failure at a time", and nothing in the
 * documented flow invoked this file. Six repos held out/staging-env.json
 * because somebody ran the tool by hand; a fresh onboarding produced none, and
 * every recorded row then carried `envProvenance: "process-env-only"`. That
 * became load-bearing when config.mjs made a `--live` run REQUIRE
 * out/staging-env.json to corroborate the database expectation - a guard whose
 * input the documented flow never created.
 *
 * Returns the report. It never throws for a state the target is simply IN - no
 * qode-iac checkout, no manifest for this service, no DATABASE_URL in any
 * staging manifest - because those are findings about the target, and stage 1's
 * other half (the denominator) is measurable regardless. `report.state` names
 * which case it is; the gate is what refuses.
 */
export function resolveStagingEnv({
  iac,
  envFile = null,
  namespace = "staging",
  dbAddress = null,
  service = null,
  noIngressSwap = false,
} = {}) {
  const NO_INGRESS_SWAP = noIngressSwap;
  mkdirSync(OUT_DIR, { recursive: true });

  const derived = defaultService();
  // CHARPILOT_SERVICE is the per-machine answer, exactly as CHARPILOT_IAC is for
  // `--iac` and CHARPILOT_DB_ADDRESS is for `--db-address`. It is not a
  // convenience: the walk spawns this tool through runTool(), which passes no
  // arguments and consults no npm script, so a service whose manifest prefix
  // differs from its package.json name has NO other way to say so and the run
  // refuses four steps later with what reads as a qode-iac gap. qode-ptp-ms
  // deploys as ptp-be; 279 variables resolve under the right name and none
  // under the derived one.
  const ASKED = service ?? process.env.CHARPILOT_SERVICE ?? derived.service;
  const NS = namespace;
  const ENVFILE = envFile;
  // `--db-address` is the explicit answer; CHARPILOT_DB_ADDRESS is the
  // per-machine one, exactly as CHARPILOT_IAC is for `--iac`. The container has
  // no way to pass a flag into stage 1, so without an env form the resolved DSN
  // stays cluster-internal and every db row dies on DNS - which is a stage-1
  // gap wearing a stage-4 symptom.
  const DB_ADDRESS = dbAddress ?? process.env.CHARPILOT_DB_ADDRESS ?? null;

  // Two states that are not errors, and must not be written as one. A stage
  // that throws here takes the baseline down with it, and the denominator does
  // not depend on any of this.
  if (!ASKED) {
    return writeReport({
      stage: "1-staging-env",
      state: "no-service-name",
      resolvedAt: new Date().toISOString(),
      namespace: NS,
      findings: [
        "no --service, no name in the target's package.json and no usable directory name - nothing to look up in qode-iac",
      ],
      vars: {},
      sources: [],
      unverified: [],
    });
  }
  if (!iac || !existsSync(join(iac, "manifests"))) {
    return writeReport({
      stage: "1-staging-env",
      state: "iac-not-found",
      resolvedAt: new Date().toISOString(),
      namespace: NS,
      serviceName: ASKED,
      findings: [
        `no qode-iac checkout with a manifests/ directory ${iac ? `at ${iac}` : "beside the target"} - the deployed environment cannot be resolved, so stage 4 would run against whatever the shell happens to hold. Pass --iac <path> or set CHARPILOT_IAC`,
      ],
      vars: {},
      sources: [],
      unverified: [],
    });
  }

  // The name asked for is not always the manifest prefix: company-enrich
  // deploys as company-enrich-ms, and run 20260922T190516Z asked the agent
  // about `no-manifest` 9 times - an item no answer can settle, because the
  // walk spawns this tool with no arguments. So the near names are tried here.
  const prefix = resolveManifestPrefix(iac, NS, ASKED, derived);
  const SERVICE = prefix.used ?? ASKED;

  const topo = topology(iac);
  const sources = [];
  const merged = {};
  const origin = {};
  const record = (map, label, rel) => {
    for (const [k, v] of Object.entries(map)) {
      merged[k] = v;
      origin[k] = label;
    }
    sources.push({ source: rel, origin: label, vars: Object.keys(map).length });
  };

  // Precedence, lowest first. The ConfigMap is the deployed non-secret config;
  // the Secret carries what the ConfigMap deliberately does not; the local .env
  // wins last because it is what a developer actually runs with - and it is
  // frequently NOT staging, which is why every value it overrides is flagged.
  for (const m of manifests(iac, "configmaps", NS, SERVICE)) record(parseDataBlock(m.text), "qode-iac configmap", m.rel);
  for (const m of manifests(iac, "secrets", NS, SERVICE)) record(parseDataBlock(m.text, { base64: true }), "qode-iac secret", m.rel);
  if (ENVFILE && existsSync(ENVFILE)) {
    const dot = parseDotenv(readFileSync(ENVFILE, "utf8"));
    const overrides = Object.keys(dot).filter((k) => k in merged && merged[k] !== dot[k]);
    record(dot, "service .env", ENVFILE);
    if (overrides.length) {
      sources[sources.length - 1].overrides = overrides;
    }
  }

  // The deployed DSN is normally the cluster-internal one, which does not
  // resolve from a laptop. --db-address rewrites host:port and keeps
  // credentials, path and query untouched, so the output is runnable without
  // anyone hand-editing a file that holds a password.
  // EVERY DATABASE_URL* KEY, not only the base one. dbvocab.mjs:47-61 reads
  // DATABASE_URL_READ_ONLY *before* DATABASE_URL, so rewriting only the base
  // left the flag missing the exact variable its consumer prefers: on a service
  // that publishes a read-only DSN, --db-address could never make db vocabulary
  // reachable. Measured on qode-ptp-ms, where DATABASE_URL resolved to
  // 34.143.159.14:5434 and DATABASE_URL_READ_ONLY stayed at
  // postgres.database-staging:5432, and dbvocab failed every round against a
  // host it could not reach.
  let dbRewrite = null;
  if (DB_ADDRESS) {
    const [h, p] = DB_ADDRESS.split(":");
    const rewritten = [];
    for (const key of Object.keys(merged)) {
      if (!/^DATABASE_URL/.test(key) || !merged[key]) continue;
      const before = hostOf(merged[key]);
      merged[key] = merged[key].replace(/@([^/@]+)(?=\/)/, `@${h}${p ? `:${p}` : ""}`);
      rewritten.push({ key, from: before });
    }
    if (rewritten.length) {
      dbRewrite = {
        from: rewritten[0].from,
        to: DB_ADDRESS,
        keys: rewritten.map((r) => r.key),
        note: "host:port only; credentials, database name and query string unchanged",
      };
    }
  }

  // CLUSTER-INTERNAL → PUBLISHED INGRESS, automatically.
  //
  // A service's config names its neighbours by cluster DNS
  // (`http://data-reader-ms.staging/graphql`), which is correct in the cluster
  // and unreachable from anywhere stage 4 runs. Most of those neighbours are
  // ALSO published: qode-iac carries an Ingress whose backend is that same
  // Service. So the address stage 4 needs is already in the manifests, one
  // lookup away, and leaving the row to die on DNS was throwing away an answer
  // this tool had indexed.
  //
  // Host only. Scheme, port, path and query are the service's own contract and
  // are not this tool's to rewrite. Every swap is recorded, because a value the
  // manifests did not literally contain has to be traceable to the rule that
  // produced it.
  // Keyed by NAMESPACE AND backend, never by backend alone.
  //
  // Measured the moment this landed: keyed by backend with first-wins,
  // `data-reader-ms.staging` swapped to
  // `data-reader-ms.development.internal.qode-cluster.qode.world` — a STAGING
  // address replaced by a DEVELOPMENT one, because the development manifest
  // sorts first. Five of five swaps on email-sequence-ms crossed environments
  // that way. A row recorded against it would describe the wrong deployment
  // while every artifact said "staging", which is worse than the unreachable
  // address it replaced.
  //
  // So a swap is same-namespace or it does not happen. No fallback: an ingress
  // in another environment is not a substitute, it is a different service.
  const byBackend = new Map();
  for (const [host, meta] of topo.ingressHosts) {
    if (!meta.backend) continue;
    // `manifests/ingresses/<namespace>/<file>.yaml`
    const ns = (String(meta.rel).split("/")[2] ?? "").trim();
    if (!ns) continue;
    const key = `${ns}/${meta.backend}`;
    if (!byBackend.has(key)) byBackend.set(key, { host, rel: meta.rel, ns });
  }
  const ingressSwaps = [];
  const ingressFindings = [];
  if (!NO_INGRESS_SWAP) {
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v !== "string" || !v) continue;
      const host = hostOf(v);
      if (!host) continue;
      const c = classify(v, topo);
      if (c.scope !== "cluster-internal") continue;
      // `data-reader-ms.staging` → Service `data-reader-ms`. A bare
      // `postgres.database-staging` resolves the same way and simply finds no
      // ingress, which is the correct answer for a TCP service.
      // `data-reader-ms.staging` → Service `data-reader-ms` in namespace
      // `staging`. A host with no namespace segment is in this run's own
      // namespace, which is what cluster DNS means by a bare Service name.
      const [svcLabel, hostNs] = host.split(".");
      const ns = hostNs || NS;
      const pub = byBackend.get(`${ns}/${svcLabel}`);
      if (!pub) {
        // Named, not swapped. A neighbour with no ingress in ITS OWN namespace
        // is a real gap in qode-iac, and silently leaving it looks identical to
        // having checked.
        const elsewhere = [...byBackend.values()].filter((e) => e.host.startsWith(`${svcLabel}.`));
        if (elsewhere.length) {
          ingressFindings.push(
            `${k} points at ${host}, which has no Ingress in namespace \`${ns}\` — only in ${[...new Set(elsewhere.map((e) => e.ns))].join(", ")}. NOT swapped: an ingress in another environment is a different deployment, not a substitute`
          );
        }
        continue;
      }
      merged[k] = v.split(host).join(pub.host);
      ingressSwaps.push({ var: k, from: host, to: pub.host, manifest: pub.rel, namespace: ns });
    }
  }

  const svcManifest = manifests(iac, "services", NS, SERVICE)[0] ?? null;
  const depManifest = manifests(iac, "deployments", NS, SERVICE)[0] ?? null;
  const ingressManifests = manifests(iac, "ingresses", NS, SERVICE);
  const ingressHosts = ingressManifests.flatMap((m) => [...m.text.matchAll(/^\s*-\s*host:\s*(\S+)/gm)].map((x) => ({ host: x[1], manifest: m.rel })));

  const report = {
    stage: "1-staging-env",
    // Set below, once it is known whether any manifest for this service exists.
    state: null,
    resolvedAt: new Date().toISOString(),
    namespace: NS,
    serviceName: SERVICE,
    // What was asked for, what was tried, and which one answered. Written on
    // every report from a qode-iac read, so a `no-manifest` state can say the
    // near names were already tried and none (or more than one) had manifests.
    manifestPrefix: prefix,
    serviceFrom: prefix.used && prefix.used !== ASKED
      ? `${prefix.from} (resolved from ${JSON.stringify(ASKED)})`
      : service
      ? "--service"
      : process.env.CHARPILOT_SERVICE
        ? "CHARPILOT_SERVICE"
        : derived.fromPackage
          ? "package.json name"
          : "target directory name",
    iac: relative(REPO_ROOT, iac) || iac,
    resolvedFrom: "qode-iac manifests only - no kubectl, no DNS, no TCP probe",
    sources,
    ingress: ingressHosts.length ? ingressHosts : null,
    service: svcManifest
      ? {
          manifest: svcManifest.rel,
          type: (svcManifest.text.match(/^\s*type:\s*(\S+)/m) ?? [])[1] ?? "ClusterIP",
          ports: [...svcManifest.text.matchAll(/^\s*(?:port|targetPort):\s*(\d+)/gm)].map((m) => m[1]),
        }
      : null,
    deployment: depManifest
      ? {
          manifest: depManifest.rel,
          containerPort: (depManifest.text.match(/containerPort:\s*(\d+)/) ?? [])[1] ?? null,
          probes: [...depManifest.text.matchAll(/path:\s*(\S+)/g)].map((m) => m[1]),
          envFrom: [...depManifest.text.matchAll(/(configMapRef|secretRef):\s*\n\s*name:\s*(\S+)/g)].map((m) => `${m[1]}:${m[2]}`),
        }
      : null,
    databaseAddressRewrite: dbRewrite,
    ingressSwaps: ingressSwaps.length ? ingressSwaps : null,
    topology: { servicesIndexed: new Set([...topo.services.values()]).size, ingressHostsIndexed: topo.ingressHosts.size },
    vars: {},
    findings: [],
    unverified: [],
  };

  for (const [k, v] of Object.entries(merged)) {
    const secret = SECRET.test(k);
    const c = classify(v, topo);
    report.vars[k] = {
      scope: c.scope,
      host: c.host ?? null,
      why: c.why ?? null,
      manifest: c.manifest ?? null,
      from: origin[k],
      value: secret ? `<redacted: ${fingerprint(v)}>` : v,
    };
    if (c.unverified) report.unverified.push(`${k}: ${c.unverified}`);
    if (c.scope === "cluster-internal") {
      report.findings.push(`${k} is cluster-internal (${c.host}) - unreachable from outside; that boundary must be doubled, port-forwarded, or reached at a published address if one exists`);
    }
    if (c.scope === "localhost") {
      report.findings.push(`${k} resolves to localhost - from a developer machine that is THIS machine, not staging. A wrong-but-reachable address answers instead of failing, and the recorder writes the answer down as behaviour`);
    }
  }

  // THE EGRESS RULE, derived rather than hand-maintained.
  //
  // The recorder shipped a hardcoded ALLOWED_HOSTS plus a `--allow-host` flag,
  // which made the reachable set a list somebody had to remember to edit. It is
  // not a judgement call: **a host this service's own staging config names is a
  // host this service talks to in staging**, and recording it is the point of
  // stage 4. Anything the config does NOT name stays denied, which is the part
  // that actually protects — a provider the code reaches for but staging never
  // configured is exactly the call nobody authorised.
  //
  // So the allowlist is every host the resolved environment resolved to,
  // including the ones classified cluster-internal: naming them here does not
  // make them reachable, it only stops the guard from being the reason a row
  // failed when the address was the reason.
  // Under CHARPILOT_EXPECTED_DB=none no database host joins the list, even one
  // a manifest names: `none` approves no DSN, so it opens no route to one.
  // "Database" is config.mjs isDatabaseVar - DB_URL, DB_HOST, PGHOST,
  // MONGODB_URI, a postgres:// value under any name - not DATABASE_URL alone,
  // and a host one of them names is dropped even when another key repeats it.
  const noDb = isNoDatabase(process.env.CHARPILOT_EXPECTED_DB);
  const dbKeys = noDb ? Object.keys(merged).filter((k) => isDatabaseVar(k, merged[k])) : [];
  const dbHosts = new Set();
  for (const k of dbKeys) {
    if (report.vars[k]?.host) dbHosts.add(String(report.vars[k].host).toLowerCase());
    // A bare DB_HOST / PGHOST value is itself the host.
    const bare = String(merged[k] ?? "").trim().replace(/^["']|["']$/g, "");
    if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(bare) && /[A-Za-z]|\./.test(bare) && !/^\d+$/.test(bare)) dbHosts.add(bare.split(":")[0].toLowerCase());
  }
  const allow = new Set();
  for (const [k, v] of Object.entries(report.vars)) {
    if (!v.host) continue;
    if (noDb && (dbKeys.includes(k) || dbHosts.has(String(v.host).toLowerCase()))) continue;
    allow.add(v.host);
  }
  if (dbRewrite?.to && !noDb) allow.add(String(dbRewrite.to).split(":")[0]);
  report.allowHosts = [...allow].sort();
  if (noDb) {
    const dsnKeys = dbKeys;
    report.expectedDbNone = { checked: true, manifestDsnKeys: dsnKeys };
    if (dsnKeys.length) {
      report.findings.push(
        `CHARPILOT_EXPECTED_DB=none, but ${dsnKeys.join(", ")} ${dsnKeys.length === 1 ? "is" : "are"} in the resolved environment for ${SERVICE} - the expectation is wrong. ` +
          `No database host was allow-listed, and every database assertion refuses under none. Name the database (CHARPILOT_EXPECTED_DB=host:port/database) or confirm the service does not use it`
      );
    }
  }

  // A secret-shaped key committed in a ConfigMap is a finding in its own right,
  // and it must be attributed per key - the earlier condition was
  // key-independent, so once any ConfigMap was read every secret-shaped key in
  // the merged set was blamed on it, including .env-only ones.
  for (const f of ingressFindings) report.findings.push(f);

  const cmSecrets = Object.keys(merged).filter((k) => SECRET.test(k) && origin[k] === "qode-iac configmap");
  if (cmSecrets.length) {
    report.findings.push(
      `${cmSecrets.length} secret-shaped var(s) are in a ConfigMap rather than a Secret: ${cmSecrets.join(", ")} - values are committed in plaintext to the qode-iac repo`
    );
  }
  const secretManifestKeys = Object.keys(merged).filter((k) => origin[k] === "qode-iac secret");
  if (secretManifestKeys.length) {
    report.findings.push(
      `${secretManifestKeys.length} var(s) come from a base64 Secret manifest committed to qode-iac: ${secretManifestKeys.join(", ")} - base64 is not encryption; anyone with read access to that repo holds these credentials`
    );
  }
  // A REAL GAP, not an error to paper over. profile-centralized has no
  // DATABASE_URL in any staging manifest - not in a ConfigMap and not in a
  // Secret - so there is nothing here to resolve it from, and inventing a
  // placeholder would hand stage 4 an address nobody deployed. Named, recorded,
  // and left for the gate to refuse or a person to rule.
  if (!merged.DATABASE_URL && isNoDatabase(process.env.CHARPILOT_EXPECTED_DB)) {
    report.findings.push(`DATABASE_URL is in no staging manifest for ${SERVICE}, which is what CHARPILOT_EXPECTED_DB=none says`);
  } else if (!merged.DATABASE_URL) {
    report.findings.push(
      `DATABASE_URL is in NO staging manifest for ${SERVICE} - a qode-iac gap, not a stage-4 problem. Nothing here can resolve it, and no default may stand in for it: a service whose schema defaults it would boot against whatever the shell holds`
    );
  }

  // The three states, decided from what was actually read rather than from
  // whether anything threw.
  report.state =
    sources.length === 0
      ? "no-manifest"
      : merged.DATABASE_URL
        ? "resolved"
        : "resolved-no-database";
  if (prefix.used && prefix.used !== ASKED) {
    report.findings.push(
      `manifest prefix resolved: no ConfigMap or Secret named ${ASKED} in manifests/*/${NS}, and exactly one near name has them - ${prefix.used} (tried ${prefix.tried.join(", ")})`
    );
  }
  if (report.state === "no-manifest") {
    report.findings.push(
      prefix.matched.length > 1
        ? `no ConfigMap or Secret named ${SERVICE} in manifests/*/${NS}, and ${prefix.matched.length} near names do (${prefix.matched.join(", ")}) - ambiguous, so none is used. Set CHARPILOT_SERVICE to the one this service deploys as`
        : `no ConfigMap or Secret named ${SERVICE} in manifests/*/${NS}, nor under any near name (tried ${prefix.tried.join(", ")}) - either the manifest prefix is something else (set CHARPILOT_SERVICE) or this service is not deployed to ${NS}`
    );
  }

  return writeReport(report, merged);
}


/**
 * Both artifacts, always written together - the report and the values.
 *
 * A state that resolved nothing still writes the report, because "stage 1 ran
 * and found no manifest" and "stage 1 never ran" are different facts and the
 * gate has to be able to tell them apart. The values file is written only when
 * there are values: an empty staging.env passed as `--env-file` would look
 * like a resolved environment and hold none.
 */
function writeReport(report, merged = null) {
  mkdirSync(OUT_DIR, { recursive: true });
  report.vars ??= {};
  report.scopes = Object.values(report.vars).reduce((acc, v) => {
    acc[v.scope] = (acc[v.scope] ?? 0) + 1;
    return acc;
  }, {});
  writeFileSync(join(OUT_DIR, "staging-env.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (merged && Object.keys(merged).length) {
    // UNDER CHARPILOT_EXPECTED_DB=none NO DSN IS WRITTEN (safety; found running
    // contact-ms, whose manifest carries a DATABASE_URL). `none` approves no
    // database, and the host was already kept off the allowlist - but the value
    // still went into staging.env, and dbvocab.mjs and providervocab.mjs read
    // that file and dialled postgres.database-staging:5432 from a mocked run.
    // The name stays, so the finding above and every schema that requires it
    // still see it; the value is config.mjs's unreachable placeholder.
    writeFileSync(
      join(OUT_DIR, "staging.env"),
      `# GENERATED by stagingenv.mjs - gitignored, never commit, never print.\n` +
        Object.entries(merged)
          .map(([k, v]) => `${k}=${isNoDatabase(process.env.CHARPILOT_EXPECTED_DB) && isDatabaseVar(k, v) ? databasePlaceholder(k, v) : v}`)
          .join("\n") +
        "\n"
    );
  }
  // After both files: liveDecision reads them.
  report.standIns = standInsReport(merged ? Object.keys(merged) : null);
  writeFileSync(join(OUT_DIR, "staging-env.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/**
 * WHICH ENV VARS A MOCKED RUN WILL FAKE, by name (standins.mjs).
 *
 * Stage 1 owns the environment, so stage 1 says what it could not supply and
 * what stands in for it: the vars the service needs (`.env.example`/`.sample`/
 * `.template`, or read from `process.env` in its source) that neither this
 * resolution, the process env nor the repo's own .env files set. The values
 * are not written here or into staging.env - staging.env stays staging's - and
 * the recorder, the emitted suite and the repo's own suite each apply the same
 * plan themselves, in mocked mode only.
 *
 * LIVE: nothing is stood in, and the same names are listed as `missing`, so a
 * live run lacking a real value says which one before stage 4 fails on it.
 *
 * `envDefaults` is baseline.json's; baseline.mjs calls refreshStandIns once it
 * has scanned the schema, so defaulted names drop out here too.
 */
function standInsReport(mergedNames, envDefaults = readEnvDefaults()) {
  const plan = planStandIns({
    repoRoot: REPO_ROOT,
    srcRoot: SRC_ROOT,
    isExcluded: isSrcExcluded,
    supplied: [...(mergedNames ?? []), ...Object.keys(process.env)],
    envDefaults,
    isDatabaseVar,
  });
  const decision = liveDecision({ outDir: OUT_DIR, argv: [] });
  return decision.live
    ? { mode: "live", names: [], missing: plan.standIns, why: "a live run gets no stand-in: a missing real value must fail where it is read" }
    : { mode: "mocked", names: plan.standIns, neededBy: plan.neededBy, notStoodIn: plan.skipped };
}

function readEnvDefaults() {
  try { return JSON.parse(readFileSync(BASELINE_JSON, "utf8")).envDefaults ?? null; } catch { return null; }
}

/** Re-plan the stand-ins against a freshly scanned env schema (baseline.mjs, after scanEnvDefaults). */
export function refreshStandIns(envDefaults) {
  const path = join(OUT_DIR, "staging-env.json");
  let report;
  try { report = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  let names = null;
  try { names = envNames(readFileSync(join(OUT_DIR, "staging.env"), "utf8")); } catch { /* nothing resolved */ }
  report.standIns = standInsReport(names, envDefaults);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return report.standIns;
}

/* ---------------------------------------------------------------------- main */

/** One screen. Hosts and scopes only - a value never reaches stdout. */
export function printReport(report) {
  const sources = report.sources ?? [];
  const ingressHosts = report.ingress ?? [];
  const dbRewrite = report.databaseAddressRewrite ?? null;
  const scopes = report.scopes ?? {};
  const out = process.stdout;
  const mark = report.state === "resolved" ? "\u2713" : "!";
  out.write(
    `\n${mark} staging env ${report.state} \u2192 out/staging-env.json${Object.keys(report.vars ?? {}).length ? " (report) + out/staging.env (values, gitignored)" : ""}\n` +
      `    service          ${report.serviceName ?? "(unresolved)"}${report.serviceFrom ? ` (from ${report.serviceFrom})` : ""} \u00b7 namespace ${report.namespace}\n` +
      `    resolved from    qode-iac manifests only - no kubectl, no DNS, no TCP probe\n` +
      `    sources          ${sources.length ? sources.map((s) => `${s.origin} (${s.vars})`).join(" \u00b7 ") : "(none)"}\n` +
      (report.topology
        ? `    topology         ${report.topology.servicesIndexed} Service(s) \u00b7 ${report.topology.ingressHostsIndexed} Ingress host(s) indexed across the whole tree\n`
        : "") +
      `    public ingress   ${ingressHosts.length ? ingressHosts.map((i) => i.host).join(" \u00b7 ") : "(none found)"}\n` +
      `    vars by scope    ${Object.entries(scopes).length ? Object.entries(scopes).map(([k, n]) => `${k} ${n}`).join(" \u00b7 ") : "(no vars resolved)"}\n`
  );
  if (dbRewrite) out.write(`    DATABASE_URL     address rewritten ${dbRewrite.from} → ${dbRewrite.to}\n`);
  for (const s of report.ingressSwaps ?? []) {
    out.write(`    ${s.var.padEnd(16)} cluster-internal ${s.from} → published ingress ${s.to} (${s.manifest})\n`);
  }

  out.write("\n  addresses (hosts only; secret values never printed):\n");
  for (const [k, v] of Object.entries(report.vars ?? {})) {
    if (!v.host) continue;
    const mark = v.scope === "public" ? "✓" : v.scope === "localhost" ? "✗" : "○";
    out.write(`    ${mark} ${k.padEnd(28)}${String(v.host).padEnd(46)}${v.scope}\n`);
  }

  // Names only, as everywhere else here.
  const standIns = report.standIns;
  if (standIns?.names?.length) {
    out.write(`\n  stand-ins (mocked only, fake values, names only): ${standIns.names.join(", ")}\n`);
  }
  if (standIns?.missing?.length) {
    out.write(`\n  ! LIVE and NOT stood in - the service needs these and nothing supplies them: ${standIns.missing.join(", ")}\n`);
  }
  if (report.findings?.length) {
    out.write("\n  findings:\n");
    for (const f of [...new Set(report.findings)]) out.write(`    • ${f}\n`);
  }
  if (report.unverified?.length) {
    out.write("\n  UNVERIFIED - the manifests cannot answer these:\n");
    for (const u of [...new Set(report.unverified)]) out.write(`    ? ${u}\n`);
  }
  out.write("\n");
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
  // `--iac` still wins; the search is what makes the stage runnable unattended.
  const iac = arg("--iac") ?? findIac().iac;
  const report = resolveStagingEnv({
    iac,
    envFile: arg("--env"),
    namespace: arg("--namespace", "staging"),
    dbAddress: arg("--db-address"),
    service: arg("--service"),
    noIngressSwap: argv.includes("--no-ingress-swap"),
  });
  printReport(report);
  // A state the target is simply IN is reported, not thrown - but it is not a
  // success either, and a caller in a shell script has to be able to tell.
  process.exitCode = report.state === "resolved" ? 0 : 1;
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

/**
 * Will stage 4 be able to record against the real thing?
 *
 * This lives HERE, in stage 1, because stage 1 owns the environment - and the
 * pipeline's own rule is to attribute a failure to the stage that could have
 * prevented it. Answering it at stage 4 means a run discovers at minute 99 that
 * everything it recorded was mocked. Measured exactly that: runs 2 and 4 both
 * reported success at 96.5% and 93.5% against denied boundaries.
 *
 * Both stages call this one function, so the answer stage 1 prints and the
 * decision stage 4 acts on cannot drift apart.
 */
export function liveDecision({
  outDir,
  argv = [],
  expected = process.env.CHARPILOT_EXPECTED_DB,
  mode = process.env.CHARPILOT_MODE,
} = {}) {
  // THE RUN-LEVEL SWITCH, and it OUTRANKS the flag.
  //
  // Whether stage 4 reaches the real database and the real downstream was not
  // configurable at the run level at all. `--live` is a literal string in
  // docker/continue-prompt.md - the agent types it - so the operator's only
  // lever was to remove CHARPILOT_EXPECTED_DB, which does not select a mocked
  // run: assertExpectedDb then REFUSES, and stage 4 stops. "Mocked" was
  // unreachable from configuration, and reaching it depended on the agent
  // noticing a refusal and choosing to re-run without the flag.
  //
  // So config beats argv here, in that direction only. A person who wrote
  // CHARPILOT_MODE=mocked into run.env has said what the run is for, and a
  // prompt template cannot overrule them. The opposite is NOT symmetrical:
  // CHARPILOT_MODE=live only grants PERMISSION to go live - the database triple
  // is still asserted below and in record.mjs, because a switch that could turn
  // the safety check off would be a worse defect than the one it fixes.
  const wanted = (mode ?? "").trim().toLowerCase();
  // `none` FORCES MOCKED, ahead of every flag. There is no database to assert,
  // so no live recording can be made safe; nodejs.py refuses `none` with
  // CHARPILOT_MODE=live before a run starts, and this is the same answer for
  // anything that gets here anyway (an agent's `--live`).
  if (isNoDatabase(expected)) {
    return {
      live: false,
      why:
        wanted === "live"
          ? "CHARPILOT_EXPECTED_DB=none with CHARPILOT_MODE=live - none forces mocked, and nodejs.py refuses this pair at preflight"
          : "CHARPILOT_EXPECTED_DB=none - this service has no database, so every boundary is answered by a double",
    };
  }
  if (wanted === "mocked" || wanted === "mock") {
    return { live: false, why: "CHARPILOT_MODE=mocked - every boundary is answered by a double" };
  }
  if (wanted && wanted !== "live") {
    return { live: false, why: `CHARPILOT_MODE=${wanted} is not a mode - use "live" or "mocked"` };
  }
  if (argv.includes("--no-live")) return { live: false, why: "--no-live" };
  if (argv.includes("--live") || argv.includes("--live-providers")) return { live: true, why: "--live" };
  if (wanted === "live") return { live: true, why: "CHARPILOT_MODE=live" };
  const want = (expected ?? "").trim();
  if (!want) return { live: false, why: "CHARPILOT_EXPECTED_DB is unset - nothing to check the resolved database against" };
  try {
    const reportPath = join(outDir, "staging-env.json");
    if (!existsSync(reportPath)) return { live: false, why: "no staging-env.json - stage 1 resolved no environment" };
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (report.state !== "resolved") return { live: false, why: `staging-env state is ${report.state}` };
    const dsn = readFileSync(join(outDir, "staging.env"), "utf8").match(/^DATABASE_URL=(.*)$/m)?.[1];
    if (!dsn) return { live: false, why: "no DATABASE_URL in staging.env" };
    const u = new URL(dsn);
    const norm = (x) => String(x).replace(/^\//, "").replace(/\/$/, "");
    const actual = norm(`${u.hostname}:${u.port || "5432"}${u.pathname}`);
    if (actual !== norm(want)) {
      return { live: false, why: `resolved ${actual} != CHARPILOT_EXPECTED_DB ${norm(want)} - refusing to record live against an unexpected database` };
    }
    return { live: true, why: `resolved staging matches CHARPILOT_EXPECTED_DB (${actual})` };
  } catch (e) {
    return { live: false, why: `could not verify the database triple: ${e.message}` };
  }
}
