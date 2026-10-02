#!/usr/bin/env node
/**
 * Dead production code - the step that must run BEFORE inputs are generated.
 *
 * The plan's rule is right: code nothing references holds no production
 * behaviour, so it leaves the coverage denominator. Skipping it on the pilot
 * cost 28 of 336 proposals (8%) written against dead exports - including five
 * for a function whose only call site is commented out.
 *
 * ts-morph, not ts-prune, deliberately:
 *   - one AST and one denominator. A second dead-code tool is a second source
 *     of truth that can disagree, which is the exact drift this pipeline spent
 *     a day eliminating.
 *   - the reference graph already exists here for driver resolution; "no
 *     reachable caller" is the same query inverted.
 *   - `findReferencesAsNodes` distinguishes a call from a COMMENT. A grep over
 *     the same file counted a commented-out call site as a live reference.
 *
 *   node .claude/charpilot/deadcode.mjs
 *
 * Writes out/dead-exports.json. Reports the corrected denominator; it does not
 * silently apply it - dropping arms from the denominator is a decision, and it
 * has to be visible.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { Node, Project } from "ts-morph";

import { isSrcExcluded, OUT_DIR, REPO_ROOT, SCAN_JSON, SRC_GLOB, SRC_ROOT, TSCONFIG, TYPE_ONLY_DIRS } from "./config.mjs";

const OUTPUT = resolve(OUT_DIR, "dead-exports.json");

/**
 * An entrypoint is referenced by the runtime, not by our code, so "nothing
 * calls it" does not make it dead. Anything reachable from one of these is
 * live by definition.
 */
const ENTRYPOINTS = [/^src\/index\.ts$/, /^src\/instrumentation\.ts$/, /^src\/server\.ts$/, /^src\/routes\//];

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const scan = JSON.parse(readFileSync(SCAN_JSON, "utf8"));
  const armsByFn = new Map(scan.functions.map((f) => [f.id, f.arms.istanbul]));

  // The scan attributes an arm to its INNERMOST enclosing function, so looking
  // up only the exported declaration's own id undercounts every export whose
  // branches live in a closure inside it. `cachePromptName` read 0 while its 6
  // arms sat in `cachePrompt.decorator.ts:30:<anonymous>`. Sum every scanned
  // function whose start line falls inside the declaration's span instead.
  // Measured on the 26 dead exports here: 41 declared vs 51 with closures
  // (`cachePromptName` 0 -> 6, `runWithRetry` 5 -> 9).
  const fnsByFile = new Map();
  for (const f of scan.functions) {
    const list = fnsByFile.get(f.file) ?? [];
    list.push(f);
    fnsByFile.set(f.file, list);
  }
  // The FUNCTIONS in the span, not just their arm count.
  //
  // The count alone cannot be joined to anything. coverage.mjs measures sides
  // one at a time and knows which function each one sits in; to subtract the
  // dead ones from BOTH the numerator and the denominator it needs the same
  // attribution this file used, by identity rather than by arithmetic. Two
  // implementations of "which arms are inside this declaration" is two
  // denominators, which is the drift the header of this file refuses.
  //
  // So the span is published as `functionIds` and the count is derived from it.
  const fnsInSpan = (file, start, end) =>
    (fnsByFile.get(file) ?? []).filter((f) => f.line >= start && f.line <= end);

  // tsconfig.json includes only `src/**/*.ts`, so a project built from it alone
  // cannot see a test file - and `findReferencesAsNodes` then reports ZERO test
  // references for every export, making "referenced only by tests" 0 by
  // construction rather than by fact. The test tree is added explicitly so the
  // distinction is real: an export nothing in src calls but a test imports is
  // dead PRODUCTION code whose test is exercising something unreachable, which
  // is a different problem from an export nothing references at all.
  //
  // THE TEST TREE IS NOT LOADED ALL AT ONCE (D72), and it is only asked about
  // the declarations found dead. That tree holds this pipeline's own output:
  // on qode-ptp-ms, test/characterization was 126 files and 209 MB against
  // src's 12 MB, and it grows every round. Parsing all of it with src took
  // 5 GB of heap before the first query, and the run died at V8's 4 GB default
  // on every re-scan. No test reference can make a declaration live - only
  // src references do - so both passes below run against src alone, and
  // `testReferences` then asks the tree about the dead set a batch at a time.
  const project = new Project({ tsConfigFilePath: TSCONFIG });
  const testPaths = [];
  for (const g of ["test/**/*.ts", "tests/**/*.ts"]) {
    testPaths.push(...project.getFileSystem().globSync([join(REPO_ROOT, g)]).map((p) => resolve(p)));
  }
  const addedTestFiles = testPaths.length;
  const rel = (sf) => relative(REPO_ROOT, sf.getFilePath());

  // ts-morph resolves a RELATIVE glob against process.cwd(), not against the
  // project root. Run from .claude/charpilot, "src/**/*.ts" resolved to
  // .claude/charpilot/src/** - nothing - so the loop below never executed and
  // the scan reported 0 dead exports. Run from the repo root the same code
  // reported 26. A zero that is structurally impossible to be anything else is
  // worse than no answer, so the glob is absolute and the count is asserted.
  const srcFiles = project.getSourceFiles(SRC_GLOB);
  if (srcFiles.length === 0) {
    throw new Error(
      `dead-code scan examined 0 files under ${SRC_ROOT} - refusing to report 0 dead exports from an empty scan`
    );
  }

  const dead = [];
  // The dead declarations still to be asked "does a test reference you?".
  const askTests = [];
  for (const sf of srcFiles) {
    const file = rel(sf);
    if (isSrcExcluded(file)) continue;
    if (TYPE_ONLY_DIRS.some((d) => file.startsWith(`${d}/`))) continue;
    if (ENTRYPOINTS.some((re) => re.test(file))) continue;

    for (const [name, decls] of sf.getExportedDeclarations()) {
      for (const d of decls) {
        const isValue =
          Node.isFunctionDeclaration(d) || Node.isVariableDeclaration(d) || Node.isClassDeclaration(d);
        if (!isValue) continue;
        const nameNode = typeof d.getNameNode === "function" ? d.getNameNode() : undefined;
        if (!nameNode?.findReferencesAsNodes) continue;

        let refs;
        try {
          refs = nameNode.findReferencesAsNodes();
        } catch {
          continue;
        }

        const srcRefs = [];
        const tests = { refs: [], keys: new Set() };
        for (const r of refs) {
          const f = relative(REPO_ROOT, r.getSourceFile().getFilePath());
          const isSelf = f === file && r.getStart() === nameNode.getStart();
          if (isSelf) continue;
          if (f.startsWith("src/")) srcRefs.push(`${f}:${r.getStartLineNumber()}`);
          else addTestRef(tests, f, r);
        }
        if (srcRefs.length > 0) continue;

        const line = d.getStartLineNumber();
        const fnId = `${file}:${line}:${name}`;
        const endLine = d.getEndLineNumber();
        const inSpan = fnsInSpan(file, line, endLine);
        const entry = {
          file,
          name,
          line,
          kind: d.getKindName(),
          // A declaration only tests reference is still dead PRODUCTION code:
          // its behaviour is not production behaviour, so it leaves the
          // denominator too. Reported separately because it reads differently.
          // Settled by `testReferences` once the test tree has been asked.
          referencedOnlyByTests: false,
          testRefs: [],
          // The declaration's own arms, and its arms including any nested
          // closure. `branchSides` is the one the denominator correction uses.
          branchSidesDeclaredOnly: armsByFn.get(fnId) ?? 0,
          branchSides: inSpan.reduce((n, f) => n + (f.arms?.istanbul ?? 0), 0),
          // WHICH functions those sides belong to. coverage.mjs subtracts a
          // dead export from the numerator AND the denominator by testing each
          // side's own `functionId` against this list - so the two tools agree
          // by construction rather than by two matching arithmetics.
          functionIds: inSpan.map((f) => f.id),
        };
        dead.push(entry);
        askTests.push({
          file,
          nameNode,
          ...tests,
          settle: (found) => {
            entry.referencedOnlyByTests = found.length > 0;
            entry.testRefs = found.slice(0, 3);
          },
        });
      }
    }
  }

  dead.push(...onlyReachableFromDead(srcFiles, dead, rel, fnsInSpan, armsByFn, askTests));
  testReferences(project, testPaths, askTests);

  const totalSides = scan.reconcile?.arms?.astTotal ?? 0;
  const deadSides = dead.reduce((n, d) => n + d.branchSides, 0);
  const doc = {
    stage: "2-dead-code",
    scannedAt: new Date().toISOString(),
    tool: "ts-morph getExportedDeclarations + findReferencesAsNodes",
    entrypointsTreatedAsLive: ENTRYPOINTS.map(String),
    totals: {
      deadExports: dead.length,
      deadOnlyReferencedByTests: dead.filter((d) => d.referencedOnlyByTests).length,
      // Proof the question was actually asked. A 0 above with 0 here means the
      // test tree was never in the project, not that no test references exist.
      testFilesInProject: addedTestFiles,
      srcFilesExamined: srcFiles.length,
      branchSidesInsideThem: deadSides,
      denominator: totalSides,
      correctedDenominator: totalSides - deadSides,
      // THE SCHEMA MARKER for the correction, and the reason it is a count
      // rather than a boolean: an artifact written before `functionIds` existed
      // has no key here at all, so coverage.mjs can tell "no dead exports" from
      // "an older deadcode.mjs wrote this" and refuse the second rather than
      // quietly measuring against the raw denominator.
      deadFunctionIds: new Set(dead.flatMap((d) => d.functionIds)).size,
    },
    dead,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(doc, null, 2)}\n`);

  const t = doc.totals;
  process.stdout.write(
    `\n\u2713 dead exports \u2192 ${relative(REPO_ROOT, OUTPUT)}\n` +
      `    exported and referenced nowhere in src   ${t.deadExports}\n` +
      `      of those, referenced only by tests     ${t.deadOnlyReferencedByTests}\n` +
      `    branch sides inside them                 ${t.branchSidesInsideThem}\n` +
      `    denominator ${t.denominator} \u2192 ${t.correctedDenominator} if excluded\n` +
      `\n  RUN THIS BEFORE GENERATING INPUTS. On the pilot it was skipped, and 8% of\n` +
      `  the cases were written against code nothing calls.\n`
  );

  if (dead.length) {
    process.stdout.write("\n  dead exports (name, sides it contains):\n");
    for (const d of dead.sort((a, b) => b.branchSides - a.branchSides)) {
      process.stdout.write(
        // A SEPARATOR, not padding alone. padEnd(40) adds nothing once the path
        // is longer than 40 - and on ptp-be most are - so the file and the
        // symbol ran together: `lib/server/services/logProcessor/index.tsgetLogs`.
        // 141 findings rendered that way are a list nobody can act on, which is
        // the same as not reporting them.
        `    ${String(d.branchSides).padStart(4)}  ${`${d.file.replace("src/", "")} · ${d.name}`}` +
          `${d.referencedOnlyByTests ? "   (tests only)" : ""}\n`
      );
    }
  }
}

/**
 * DEAD BY WHAT CALLS IT, not only by whether anything does.
 *
 * The pass above asks one question of an EXPORT: does anything in src refer to
 * it? That misses code whose only callers are themselves dead. tracy-agent-be-ms
 * showed the cost: `CandidateScreeningAgent` (agent.ts:329) was found dead, but
 * `runAgentLoop`, `withRetry`, `buildCollectionSystemPrompt` and
 * `buildEvaluationSystemPrompt` - module-level helpers in the same file, called
 * ONLY from inside that class - were not exported, so they were never asked
 * about. They stayed in the live denominator and were briefed to the agent; run
 * 20260922T152300Z wrote rows for them, and 5 of its 17 false claims sat in
 * them, including the two `buildCollectionSystemPrompt` rows `repair` could not
 * withdraw.
 *
 * So every module-scope value declaration - exported or not - is dead when
 * every src reference to it lies inside a declaration already found dead, or
 * inside itself (recursion is not a caller). Repeated until nothing changes,
 * because a helper of a dead helper is dead too. A declaration with a single
 * reference from live code stays live; this only ever follows what the
 * reference graph says, it never guesses at reachability.
 *
 * A NON-EXPORTED declaration that nothing references at all is dead by the
 * same rule, and is reported as such.
 */
function onlyReachableFromDead(srcFiles, dead, rel, fnsInSpan, armsByFn, askTests) {
  const spans = new Map();
  const addSpan = (file, start, end) => {
    const list = spans.get(file) ?? [];
    list.push([start, end]);
    spans.set(file, list);
  };
  const candidates = [];
  const seen = new Set(dead.map((d) => `${d.file}:${d.line}:${d.name}`));

  for (const sf of srcFiles) {
    const file = rel(sf);
    if (isSrcExcluded(file)) continue;
    if (TYPE_ONLY_DIRS.some((d) => file.startsWith(`${d}/`))) continue;
    if (ENTRYPOINTS.some((re) => re.test(file))) continue;

    const decls = [];
    for (const st of sf.getStatements()) {
      if (Node.isFunctionDeclaration(st) || Node.isClassDeclaration(st)) decls.push(st);
      else if (Node.isVariableStatement(st)) decls.push(...st.getDeclarations());
    }
    for (const d of decls) {
      const nameNode = typeof d.getNameNode === "function" ? d.getNameNode() : undefined;
      if (!nameNode || !Node.isIdentifier(nameNode)) continue;
      const name = nameNode.getText();
      const line = d.getStartLineNumber();
      // A variable's span is its whole statement, so `const f = () => {...}`
      // owns the arrow's body.
      const owner = Node.isVariableDeclaration(d) ? d.getVariableStatement() ?? d : d;
      const span = [owner.getStart(), owner.getEnd()];
      if (seen.has(`${file}:${line}:${name}`)) {
        addSpan(file, ...span);
        continue;
      }
      let refs;
      try {
        refs = nameNode.findReferencesAsNodes();
      } catch {
        continue;
      }
      const srcRefs = [];
      let testRef = false;
      for (const r of refs) {
        const f = relative(REPO_ROOT, r.getSourceFile().getFilePath());
        if (f === file && r.getStart() === nameNode.getStart()) continue;
        if (f.startsWith("src/")) srcRefs.push({ file: f, pos: r.getStart(), line: r.getStartLineNumber() });
        else if (f.includes("test")) testRef = true;
      }
      const exported = typeof d.isExported === "function" ? d.isExported() : owner.isExported?.() ?? false;
      // An export nothing references was already asked about above; only
      // non-exported unreferenced code, and code with callers, is new here.
      if (!srcRefs.length && exported) continue;
      candidates.push({ file, name, line, endLine: owner.getEndLineNumber(), kind: d.getKindName(), span, srcRefs, testRef, exported, nameNode });
    }
  }
  // A reference keeps a declaration alive unless it sits inside the
  // declaration itself or inside code already found dead.
  const within = (ref, [s, e]) => ref.pos >= s && ref.pos < e;
  const deadRef = (ref, c) =>
    (ref.file === c.file && within(ref, c.span)) || (spans.get(ref.file) ?? []).some((sp) => within(ref, sp));
  const found = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of candidates) {
      if (c.dead) continue;
      if (c.srcRefs.some((r) => !deadRef(r, c))) continue;
      c.dead = true;
      changed = true;
      addSpan(c.file, ...c.span);
      const callers = c.srcRefs.filter((r) => !(r.file === c.file && within(r, c.span)));
      const inSpan = fnsInSpan(c.file, c.line, c.endLine);
      const entry = {
        file: c.file,
        name: c.name,
        line: c.line,
        kind: c.kind,
        referencedOnlyByTests: c.testRef,
        testRefs: [],
        // Which of these it is, so a reader can tell "nothing calls it" from
        // "only dead code calls it" - the second is the one a person should
        // check, because it is only as right as the dead code it follows.
        deadBecause: callers.length ? "only-referenced-from-dead-code" : "unreferenced-and-not-exported",
        referencedFrom: callers.slice(0, 3).map((r) => `${r.file}:${r.line}`),
        branchSidesDeclaredOnly: armsByFn.get(`${c.file}:${c.line}:${c.name}`) ?? 0,
        branchSides: inSpan.reduce((n, f) => n + (f.arms?.istanbul ?? 0), 0),
        functionIds: inSpan.map((f) => f.id),
      };
      found.push(entry);
      // Already true from a test file loaded with src; otherwise the test tree is asked.
      if (!c.testRef) {
        askTests.push({
          file: c.file,
          nameNode: c.nameNode,
          refs: [],
          keys: new Set(),
          settle: (refs) => {
            entry.referencedOnlyByTests = refs.length > 0;
          },
        });
      }
    }
  }
  return found;
}

/** A non-src reference whose path names a test, once per position. */
function addTestRef(tests, f, r) {
  if (f.startsWith("src/") || !f.includes("test")) return;
  const key = `${f}:${r.getStart()}`;
  if (tests.keys.has(key)) return;
  tests.keys.add(key);
  tests.refs.push(`${f}:${r.getStartLineNumber()}`);
}

/**
 * Test source parsed at once while the dead set is asked about it. A file
 * larger than this is a batch of its own. At the 17 to 20 bytes of heap per
 * byte of test source measured on qode-ptp-ms, 32 MB adds under 0.7 GB to
 * src. The variable exists so a test can put every file in a batch of its own.
 */
const TEST_BATCH_BYTES = Number(process.env.CHARPILOT_DEADCODE_TEST_BATCH_BYTES) || 32 * 1024 * 1024;

/**
 * THE TEST TREE, A BATCH AT A TIME, ASKED ONLY ABOUT THE DEAD (D72).
 *
 * Every test file is loaded next to src in exactly one batch. A reference in
 * a file answers the same in any program that holds that file, since its
 * imports come with it. So the union over the batches is what one project
 * with the whole tree reports. A helper that several batches import is seen
 * more than once, and the keys drop the repeats. A file already in the
 * project (tsconfig includes it, or src imports it) was asked about with src
 * and is not loaded again.
 *
 * Each batch is removed before the next is parsed, so the peak is src plus
 * one batch rather than src plus a corpus this pipeline grows every round.
 */
function testReferences(project, testPaths, asks) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const p of testPaths) {
    if (project.getSourceFile(p)) continue;
    const size = statSync(p).size;
    if (batch.length && bytes + size > TEST_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(p);
    bytes += size;
  }
  if (batch.length) batches.push(batch);

  for (const paths of asks.length ? batches : []) {
    const loaded = paths.map((p) => project.addSourceFileAtPath(p));
    for (const a of asks) {
      let refs;
      try {
        refs = a.nameNode.findReferencesAsNodes();
      } catch {
        continue;
      }
      for (const r of refs) {
        const f = relative(REPO_ROOT, r.getSourceFile().getFilePath());
        if (f === a.file && r.getStart() === a.nameNode.getStart()) continue;
        addTestRef(a, f, r);
      }
    }
    for (const sf of loaded) project.removeSourceFile(sf);
  }
  for (const a of asks) a.settle(a.refs);
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