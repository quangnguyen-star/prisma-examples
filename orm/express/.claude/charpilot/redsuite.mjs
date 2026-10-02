/**
 * WHY THE REPO'S OWN SUITE IS RED, FILE BY FILE, AND WHO OWNS EACH CAUSE.
 *
 * Verifier, review of PR #38 (c498dfe). baseline.mjs turned ANY red suite that
 * wrote coverage into a note and went on. That is right for a suite that is
 * red because a service it talks to is not there - a mocked run has no
 * database, no broker and no network, and the passing tests' coverage is the
 * repo's coverage as it stands. It is wrong for a suite that is red because of
 * US: our vitest config, our doubles, a module of ours that does not resolve,
 * or a suite that passes on its own and passes nothing under our config.
 * Those were noted and forgotten, and the run carried on measuring against a
 * denominator our own harness had broken.
 *
 * So each failing file gets one cause, read off the failure text vitest wrote
 * for it (the file's own message, then each failed test's messages):
 *
 *   external  a service the mocked run does not have: a database (db.invalid,
 *             Prisma's P1001, ECONNREFUSED on 5432/3306/27017), a broker
 *             (RabbitMQ, Kafka, Redis), or the network (ECONNREFUSED,
 *             ENOTFOUND, EAI_AGAIN, fetch failed). A NOTE: "needs <service>;
 *             not measurable in a mocked run".
 *   ours      the failure names a file of ours (.claude/charpilot/,
 *             vitest.charpilot.config, fixtures/doubles.ts, src-exclude.mjs,
 *             our characterization specs). A PIPELINE DEFECT.
 *   setup     the repo needs a generated artifact its own CI makes and this
 *             run did not: an ungenerated Prisma client ("Cannot find module
 *             '.prisma/client/default'"). The pipeline owns it: baseline.mjs
 *             generates the client and runs the suite again, and a file still
 *             failing this way is a PIPELINE DEFECT.
 *   theirs    anything else: the repo's own test failing on its own code. A
 *             NOTE, as before - their suite is theirs.
 *
 * And one rule over the whole suite: NOTHING passed under our config, and the
 * repo's own command (its `vitest` script, its own config, run by
 * baseline.mjs theirOwnRun) passes tests. Then our config broke it, whatever
 * the messages say - a PIPELINE DEFECT. Measured on a synthetic repo whose
 * `test` script names vitest.unit.config.mts with `globals: true`: under our
 * config every file failed on "describe is not defined", which reads like
 * their bug and is ours.
 *
 * Measured, qode-backend at staging (run in qode/characterize:nj3-5d2d7be):
 * 93 of 93 tests pass, and 5 files fail to collect on
 * "Cannot find module '.prisma/client/default'". Its CI runs
 * `npm run prisma:generate` before `npm test` and needs no database; those 5
 * are `setup`, not a database.
 */

const OURS = /\.claude\/charpilot\/|vitest\.charpilot\.config|vitest\.coverage\.config|fixtures\/doubles(\.ts)?\b|src-exclude\.mjs|\.char\.(test\.)?ts\b|(^|[\s'"(/])characterization\/[^\s'"]*\.ts/;

const SETUP = [
  { re: /Cannot find module ['"]\.prisma\/client|@prisma\/client did not initialize yet|run ["`']?prisma generate/i, need: "prisma-client", says: "its generated Prisma client (prisma generate, which its CI runs before the tests)" },
];

const PORTS = { 5432: "a PostgreSQL database", 3306: "a MySQL database", 27017: "a MongoDB database", 1433: "a SQL Server database", 6379: "Redis", 5672: "a RabbitMQ broker", 9092: "a Kafka broker", 4222: "a NATS server" };

/** The service a failure text says was not there, or null. */
export function externalService(text) {
  const t = String(text ?? "");
  if (/db\.invalid/.test(t)) return "a database";
  if (/PrismaClientInitializationError|Can't reach database server|\bP100[01]\b|Authentication failed against database server/.test(t)) return "a database";
  if (/MongoServerSelectionError|MongoNetworkError|MongooseServerSelectionError/.test(t)) return "a MongoDB database";
  if (/KafkaJS\w*(Connection|Broker|Protocol)\w*Error|KafkaJSNumberOfRetriesExceeded/.test(t)) return "a Kafka broker";
  const refused = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH)\s*(\[?::1\]?|[\w.-]+)?:(\d+)/.exec(t);
  if (refused && PORTS[refused[3]]) return PORTS[refused[3]];
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH/.test(t) && /amqp|rabbit/i.test(t)) return "a RabbitMQ broker";
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH/.test(t) && /redis/i.test(t)) return "Redis";
  if (refused) return `the network (${(refused[2] ?? "localhost").replace(/[[\]]/g, "")}:${refused[3]})`;
  const host = /(ENOTFOUND|EAI_AGAIN)\s+([\w.-]+)/.exec(t) ?? /getaddrinfo \w+ ([\w.-]+)/.exec(t);
  if (host) return `the network (${host[2] ?? host[1]})`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|connect ETIMEDOUT/.test(t)) return "the network";
  return null;
}

/** Everything vitest wrote about one failed file, as one text. */
export function failureText(file) {
  const parts = [file?.message ?? ""];
  for (const a of file?.assertionResults ?? []) {
    if (a?.status === "failed") parts.push(...(a.failureMessages ?? []).map(String));
  }
  return parts.filter(Boolean).join("\n");
}

/** One failed file's cause. */
export function causeOf(text) {
  const t = String(text ?? "");
  // OURS FIRST: a double of ours that throws ECONNREFUSED is still ours.
  const ours = OURS.exec(t);
  if (ours) return { cause: "ours", why: `the failure names a file of charpilot's (${ours[0].trim()})` };
  for (const s of SETUP) if (s.re.test(t)) return { cause: "setup", need: s.need, why: `needs ${s.says}` };
  const service = externalService(t);
  if (service) return { cause: "external", service, why: `needs ${service}; not measurable in a mocked run` };
  return { cause: "theirs", why: "the repo's own test fails on its own code" };
}

const firstLine = (t) => String(t ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 200) ?? "";

/**
 * The classification of a red suite from vitest's JSON results.
 *
 *   verdict   "ours" | "setup" | "theirs" | "external" - the most serious cause
 *             present, in that order
 *   owner     "pipeline" (ours, setup) or "repo" (theirs, external)
 *   files     [{ file, cause, why, service?, need?, first }]
 */
export function classifyRedSuite(results, { repoRoot = "", ownRun = null } = {}) {
  const rel = (n) => String(n ?? "").replace(`${repoRoot}/`, "");
  const files = (results?.testResults ?? [])
    .filter((f) => f?.status === "failed")
    .map((f) => {
      const text = failureText(f);
      return { file: rel(f.name), ...causeOf(text), first: firstLine(text) };
    });
  const passed = results?.numPassedTests ?? 0;
  // "0 of N passing when the repo's own suite passes": only with the repo's
  // own run to compare against, and only when it passed something.
  const nonePassed = passed === 0 && files.length > 0 && (ownRun?.passed ?? 0) > 0;
  const has = (c) => files.some((f) => f.cause === c);
  const verdict = has("ours") || nonePassed ? "ours" : has("setup") ? "setup" : has("theirs") ? "theirs" : "external";
  return {
    verdict,
    owner: verdict === "ours" || verdict === "setup" ? "pipeline" : "repo",
    nonePassed,
    ...(ownRun ? { ownRun } : {}),
    files,
    needs: [...new Set(files.filter((f) => f.cause === "setup").map((f) => f.need))],
    services: [...new Set(files.filter((f) => f.cause === "external").map((f) => f.service))],
  };
}

/** The sentence a classification is written down as. */
export function describeRedSuite(c, suite) {
  const by = (cause) => c.files.filter((f) => f.cause === cause);
  const list = (fs) => fs.map((f) => `${f.file} (${f.first || f.why})`).join("; ");
  const head = `the repo's own suite is RED under charpilot's vitest config: ${suite.failed} failing test(s) in ${suite.failedFiles} file(s), ${suite.passed} of ${suite.tests} passing.`;
  const parts = [head];
  if (c.nonePassed) {
    parts.push(
      `No test passed under charpilot's vitest config, and the repo's own command (${c.ownRun.command}) passes ${c.ownRun.passed} of ${c.ownRun.tests}: charpilot's config broke it.`
    );
  }
  if (by("ours").length) parts.push(`Caused by charpilot's own files: ${list(by("ours"))}.`);
  if (by("setup").length) parts.push(`Not prepared the way the repo's CI prepares it: ${by("setup").map((f) => `${f.file} ${f.why}`).join("; ")}.`);
  if (by("theirs").length) {
    parts.push(c.nonePassed
      ? `Failing under charpilot's config only: ${list(by("theirs"))}.`
      : `The repo's own tests fail on its own code: ${list(by("theirs"))}.`);
  }
  if (by("external").length) {
    parts.push(by("external").map((f) => `${f.file} needs ${f.service}; not measurable in a mocked run`).join("; ") + ".");
  }
  parts.push(
    c.owner === "pipeline"
      ? "This is a pipeline defect, not the repo's: the baseline is its coverage as it stands and the run goes on, and it cannot succeed until charpilot's side is fixed."
      : "The baseline is its coverage as it stands - the passing tests' - and the run goes on."
  );
  return parts.join(" ");
}
