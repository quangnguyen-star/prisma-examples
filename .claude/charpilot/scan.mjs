#!/usr/bin/env node
/**
 * Stage 2 — scan for functions and branch arms.
 *
 * ts-morph walks the AST for the function list, its decision points, and — the
 * part a bare function list is missing — an ENTRY RECIPE: how the thing is
 * actually invoked. A function with no own entry cannot be driven at its own id
 * in stage 4, so it is work-listed differently, not counted as a target.
 *
 *   node .claude/charpilot/scan.mjs
 *
 * Writes .claude/charpilot/out/scan.json, and reconciles its istanbul-model arm
 * count against the denominator baseline.json recorded from a real coverage run.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, relative } from "node:path";

import { Node, Project, SyntaxKind } from "ts-morph";

import { BASELINE_JSON, IS_FOREIGN_TARGET, isSrcExcluded, OUT_DIR, REPO_ROOT, SCAN_JSON, SRC_GLOB, SRC_ROOT, TSCONFIG, TYPE_ONLY_DIRS, VITEST_MAJOR } from "./config.mjs";
// The same reader freshness.mjs uses, rather than a second `git rev-parse`.
import { headSha } from "./freshness.mjs";
import { toolDigest } from "./freshness.mjs";
import { fileURLToPath } from "node:url";

/**
 * vitest 4 emits no branch for a downlevelled `enum`; 2 and 3 do. A namespace
 * still emits `N || (N = {})` under all three. See VITEST_MAJOR in config.mjs
 * for the probe the three numbers come from. Unknown version keeps the pre-4
 * model, which is the one this pipeline shipped with.
 */
const ENUM_ELISION = VITEST_MAJOR >= 4;

const FUNCTION_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
]);

const isFunctionLike = (node) => FUNCTION_KINDS.has(node.getKind());

const rel = (sourceFile) => relative(REPO_ROOT, sourceFile.getFilePath());

// ---------------------------------------------------------------------------
// naming
// ---------------------------------------------------------------------------

/** Anonymous arrows still need a stable id — derive one from where they sit. */
function deriveName(fn) {
  if (Node.isConstructorDeclaration(fn)) {
    return `${fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName() ?? "<class>"}.constructor`;
  }

  const own = typeof fn.getName === "function" ? fn.getName() : undefined;
  if (own) return own;

  const parent = fn.getParent();
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  if (Node.isPropertyDeclaration(parent)) return parent.getName();
  if (Node.isExportAssignment(parent)) return "default";
  if (Node.isCallExpression(parent)) {
    const callee = parent.getExpression().getText().split("\n")[0];
    const idx = parent.getArguments().indexOf(fn);
    return `<arg${idx} of ${callee}>`;
  }
  if (Node.isReturnStatement(parent)) return "<returned closure>";
  return "<anonymous>";
}

// ---------------------------------------------------------------------------
// entry recipe — the part that decides whether stage 4 can invoke this at all
// ---------------------------------------------------------------------------

function isExportedStatement(node) {
  const statement =
    node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ??
    (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node) ? node : undefined);
  if (!statement) return false;
  return typeof statement.isExported === "function" ? statement.isExported() : false;
}

function isDefaultExported(node) {
  return typeof node.isDefaultExport === "function" ? node.isDefaultExport() : false;
}

/**
 * Returns the ancestor of `kind` only when `node` is its actual initializer,
 * seeing through parens and `as`/`satisfies` casts. Returns undefined when the
 * node merely sits somewhere inside it.
 */
function initializerOf(node, kind) {
  let current = node;
  let parent = current.getParent();
  while (
    Node.isParenthesizedExpression(parent) ||
    Node.isAsExpression(parent) ||
    Node.isSatisfiesExpression(parent) ||
    Node.isTypeAssertion(parent)
  ) {
    current = parent;
    parent = current.getParent();
  }
  if (!parent || parent.getKind() !== kind) return undefined;
  return parent.getInitializer?.() === current ? parent : undefined;
}

/**
 * D43: A REFERENCE IN A DOC COMMENT IS NO USE. ats-sourcing-service, the mocked
 * run of September 26: `pickResume`'s JSDoc says "the caller passes the mapped
 * {@link AtsDocument} slice from {@link UnifiedService.listDocuments}", the
 * language service returns that link as a reference to the class, its
 * enclosing function is pickResume, and the scan named pickResume - a pure
 * helper that never touches the class - the driver of every private
 * UnifiedService method and of the callbacks inside them. Rows derived through
 * it declared `this.sdk` on a subject with no receiver and were refused, 3
 * sides ruled pipeline_defect. Whatever a comment names, nothing runs there.
 */
function inDocComment(ref) {
  return ref.getAncestors().some((a) => Node.isJSDoc(a) || a.getKindName().startsWith("JSDoc"));
}

/** The call that invokes a function expression where it is written - `(() => {})()` - or undefined. */
function invokedWhereWritten(fn) {
  if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn)) return undefined;
  let current = fn;
  let parent = current.getParent();
  while (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent) || Node.isTypeAssertion(parent)) {
    current = parent;
    parent = current.getParent();
  }
  return parent && Node.isCallExpression(parent) && parent.getExpression() === current ? parent : undefined;
}

/**
 * D43: THE CALL `node` IS HANDED TO, INSIDE `varDecl`'s INITIALIZER - the
 * callee's text, or null when `node` is not inside any argument of one.
 *
 * tracy-worker's tasks, the mocked run of September 26:
 *   export const companyResearchTask = defineTask({ name: "company-research-task", handler: async ({ payload, log }) => { .. } });
 *   export const taskList = { "company-research-task": companyResearchTask, .. };
 * The handler is a property of an object passed to defineTask, and the binding
 * holds what defineTask RETURNED (graphile's `(payload, helpers) => ..`). The
 * scan looked the handler's references up through the enclosing declaration,
 * called taskList's key the place the handler is held, and the recorder read
 * `taskList['"company-research-task"']` off the handler's own module, which
 * exports no taskList: "Cannot read properties of undefined", 4 rows lost in
 * arrangement as pipeline_defect. The call the function is handed to decides
 * when it runs and with what, so no member of any binding is the function.
 */
function wrappingCall(node, varDecl) {
  const init = varDecl?.getInitializer?.();
  if (!init) return null;
  const inside = new Set(node.getAncestors());
  if (!inside.has(init) && node !== init) return null;
  for (const a of node.getAncestors()) {
    if (a === varDecl) break;
    if (!Node.isCallExpression(a) && !Node.isNewExpression(a)) continue;
    if ((a.getArguments?.() ?? []).some((arg) => arg === node || inside.has(arg))) {
      return a.getExpression().getText().replace(/\s+/g, " ").slice(0, 80);
    }
  }
  return null;
}

function classCtorParams(classDecl) {
  const ctor = classDecl?.getConstructors?.()[0];
  if (!ctor) return [];
  return ctor.getParameters().map((p) => ({
    rest: typeof p.isRestParameter === "function" ? p.isRestParameter() : false,
    name: p.getName(),
    type: p.getType().getText(p),
    optional: p.isOptional() || p.hasInitializer(),
  }));
}

/**
 * D47: A FUNCTION WRITTEN INSIDE A DECORATOR'S ARGUMENT IS NO MEMBER OF THE CLASS.
 *
 * qode-itl-be (NestJS), the mocked run of September 26: every module binds its
 * port with
 *   @Module({ providers: [{ provide: X_PORT, inject: [...], useFactory: (config, stub, http) =>
 *     config.get('X_MODE', 'stub') === 'http' ? http : stub }] })
 *   export class XModule {}
 * and app.module.ts hands `idGenerator: (req) => ...` to ClsModule.forRoot
 * inside @Module's imports. The arrow has no enclosing function and a class
 * ancestor, so the scan wrote it as a class-method of XModule with member
 * null; the recorder built `new XModule()[null].bind(...)` and 41 rows died
 * in arrangement with "Cannot read properties of undefined (reading 'bind')",
 * ruled pipeline_defect - the factories' own rows, and the rows whose `via`
 * named a factory as their driver.
 *
 * Nothing the class holds is the function: the decorator ran once, when the
 * class was defined, and gave the argument to whatever reads it (Nest keeps
 * @Module's fields as class metadata and calls useFactory while it builds the
 * module). So it has no own entry, and is framework-triggered: `at` is where
 * it sits in the argument, for the invoke.build that fetches it.
 */
function decoratorArgument(fn, classDecl) {
  if (!classDecl) return null;
  const path = [];
  let child = fn;
  for (const a of fn.getAncestors()) {
    if (a === classDecl) return null;
    if (Node.isDecorator(a)) {
      const call = a.getCallExpression?.();
      const decorator = (call ? call.getExpression() : a.getExpression()).getText().replace(/\s+/g, "");
      const target = a.getParent();
      const on = target === classDecl
        ? `class ${classDecl.getName()}`
        : `${classDecl.getName()}.${typeof target?.getName === "function" ? target.getName() : "?"}`;
      return { decorator, on, className: classDecl.getName(), at: path.reverse().join("").replace(/^\./, "") || "argument 0" };
    }
    if (Node.isPropertyAssignment(a) || Node.isShorthandPropertyAssignment(a) || Node.isMethodDeclaration(a)) path.push(`.${a.getName()}`);
    else if (Node.isArrayLiteralExpression(a)) path.push(`[${a.getElements().indexOf(child)}]`);
    else if ((Node.isCallExpression(a) || Node.isNewExpression(a)) && !Node.isDecorator(a.getParent())) {
      const i = (a.getArguments?.() ?? []).indexOf(child);
      if (i >= 0) path.push(` -> ${a.getExpression().getText().replace(/\s+/g, "").slice(0, 60)}(argument ${i})`);
    }
    child = a;
  }
  return null;
}

/**
 * D56 — THE invoke.build THAT FETCHES A DECORATOR-ARGUMENT FUNCTION, when the
 * scan can spell it exactly: `{ suggestedBuild }`, or `{}`.
 *
 * Since D47 the recorder refuses these rows until the proposal supplies an
 * invoke of its own, and it said only that. qode-itl-be, run 20260926T165924Z:
 * 21 sides of fourteen `useFactory`s and `idGenerator` were declared
 * needs-seam instead, citing the refusal itself as the proof, and the ledger
 * refused four of those declarations at the end of the run. The sides were
 * reachable all along - the D52 agent recorded one with
 * `Reflect.getMetadata("providers", AtsModule)[4].useFactory`, every claim
 * verified - and the recipe was in `via.how`, but cut at 200 characters by the
 * worklist and with its string literals stripped, so no brief ever showed it.
 *
 * Nest's @Module keeps each field of its argument as class metadata under the
 * field's name, verbatim, so a path of plain members and array slots
 * (`providers[3].useFactory`) is a path into that metadata. A path through a
 * call (`imports[1] -> ClsModule.forRoot(argument 0)...`) is not: the metadata
 * holds what the call RETURNED, whose shape is the library's, so no build is
 * suggested for it and `how` still says where the function sits. Nor for any
 * other decorator, whose metadata key is its framework's business, nor for a
 * `Module` the file does not import from @nestjs/common (`nest`). The
 * specifier is repo-relative from `../`, which record.mjs's
 * repoRelativeSpecifier resolves the same from any spec directory. It is an
 * ADDRESS the agent quotes back, like `drivers`, never a value: the arguments
 * the function is called with are still the agent's to derive.
 */
export function decoratorMetadataBuild({ decorator, className, at, module, nest = true }) {
  if (!nest || decorator !== "Module" || !className || !module) return {};
  const m = /^(\w+)((?:\[\d+\]|\.\w+)*)$/.exec(String(at ?? ""));
  if (!m) return {};
  const spec = `../${String(module).replace(/\.(m|c)?[jt]sx?$/, "")}`;
  return {
    suggestedBuild: `(async () => Reflect.getMetadata(${JSON.stringify(m[1])}, (await import(${JSON.stringify(spec)})).${className})${m[2]})()`,
  };
}

/**
 * Whether the file `node` sits in takes `decorator` from @nestjs/common - the
 * one decorator whose metadata key decoratorMetadataBuild knows. A local
 * `Module` of the same name keeps its argument wherever it likes.
 */
function importsNestDecorator(node, decorator) {
  try {
    return node.getSourceFile().getImportDeclarations().some(
      (d) => d.getModuleSpecifierValue() === "@nestjs/common" && d.getNamedImports().some((n) => (n.getAliasNode()?.getText() ?? n.getName()) === decorator)
    );
  } catch {
    return false;
  }
}

/**
 * Returns { kind, reachable, ... } — `reachable: false` means "no own entry":
 * the function exists but cannot be called at its own id from a test. Callbacks,
 * returned closures and handlers registered inside another function land here.
 */
function deriveEntry(fn, moduleSpecifier) {
  const enclosingFn = fn.getAncestors().find(isFunctionLike);
  if (enclosingFn) {
    return {
      kind: "nested",
      reachable: false,
      reason: "declared inside another function — reach it through its enclosing call",
      enclosedBy: deriveName(enclosingFn),
    };
  }

  const classDecl = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  const decorated = decoratorArgument(fn, classDecl);
  if (decorated) {
    return {
      kind: "decorator-argument",
      reachable: false,
      reason: `written inside the argument of @${decorated.decorator}(...) on ${decorated.on}, at ${decorated.at} - not a member of ${decorated.className}, so no instance or class holds it; whatever reads that decorator calls it`,
      module: moduleSpecifier,
      className: decorated.className,
      decorator: decorated.decorator,
      at: decorated.at,
    };
  }
/**
 * Which member of the class this function IS.
 *
 * The old expression was `typeof fn.getName === "function" ? fn.getName() : "constructor"`,
 * and an ArrowFunction node has no getName - so a method written as a class
 * PROPERTY holding an arrow function was recorded as the constructor. Stage 4
 * then evaluated Holder["constructor"], got the class, bound it and called it:
 * `TypeError: Class constructor QodeApplyMapping cannot be invoked without 'new'`,
 * with all 5 of that row's reaches claims coming back FALSE on a derivation that
 * was correct. Measured on profile-centralized, where the sibling
 * MethodDeclaration in the same class resolved fine and recorded first try.
 *
 * So the name comes from the property when the function is its initialiser, and
 * "constructor" is returned only for an actual ConstructorDeclaration. Anything
 * else returns null, which is honest: a call recipe that cannot name its member
 * should refuse rather than guess at the most destructive possible answer.
 */
function classMemberName(fn) {
  if (fn.getKind && fn.getKind() === SyntaxKind.Constructor) return "constructor";
  if (typeof fn.getName === "function") {
    const own = fn.getName();
    if (own) return own;
  }
  // An arrow or function expression assigned to a class property: the member is
  // the property, and ts-morph gives it as the immediate parent.
  const parent = typeof fn.getParent === "function" ? fn.getParent() : undefined;
  if (parent && parent.getKind && parent.getKind() === SyntaxKind.PropertyDeclaration) {
    const propName = typeof parent.getName === "function" ? parent.getName() : undefined;
    if (propName) return propName;
  }
  return null;
}

  if (classDecl) {
    const exported = classDecl.isExported();
    // TOOL BACKLOG: A HANDLER IN AN OBJECT HELD BY A CLASS FIELD.
    // tracy-agent-be's PipelineRoute keeps its per-type creators as
    // `private static creators: Record<...> = { SCREENING: async (input, req) => ..., ... }`.
    // The arrow is not a class member, so classMemberName gave null, and stage 4
    // evaluated PipelineRoute[null] and died on `.bind` in 32 rows
    // (`20260922T152300Z`). The member is the FIELD, and the function is one
    // PROPERTY of the object it holds. The field's `private` is TypeScript's
    // alone and the handler is called directly by its dispatcher with the same
    // arguments, so it stays reachable.
    const assigned = Node.isMethodDeclaration(fn) ? fn : initializerOf(fn, SyntaxKind.PropertyAssignment);
    const literal = assigned?.getParent();
    const field = literal && Node.isObjectLiteralExpression(literal) ? initializerOf(literal, SyntaxKind.PropertyDeclaration) : undefined;
    if (field) {
      const fieldStatic = field.isStatic();
      return {
        kind: fieldStatic ? "class-static" : "class-method",
        reachable: exported,
        private: false,
        reason: exported ? undefined : "class is not exported",
        module: moduleSpecifier,
        className: classDecl.getName(),
        classExported: exported,
        classDefaultExport: classDecl.isDefaultExport(),
        member: field.getName(),
        property: deriveName(fn),
        static: fieldStatic,
        ctorParams: fieldStatic ? [] : classCtorParams(classDecl),
      };
    }
    const isPrivate = typeof fn.hasModifier === "function" && fn.hasModifier(SyntaxKind.PrivateKeyword);
    const isStatic = typeof fn.isStatic === "function" && fn.isStatic();
    return {
      kind: isStatic ? "class-static" : "class-method",
      reachable: exported && !isPrivate,
      private: isPrivate,
      reason: !exported
        ? "class is not exported"
        : isPrivate
          ? "private member — drive it through the public method that calls it"
          : undefined,
      module: moduleSpecifier,
      className: classDecl.getName(),
      classExported: exported,
      classDefaultExport: classDecl.isDefaultExport(),
      member: classMemberName(fn),
      static: isStatic,
      ctorParams: isStatic ? [] : classCtorParams(classDecl),
    };
  }

  // Top-level `export function f()` / `export const f = () => {}`.
  //
  // `initializerOf` and not an ancestor search: an arrow that merely SITS inside
  // an exported declaration — `export const S = z.object({ x: () => {} })` — is a
  // call argument, not the exported value. Claiming it as `import-named` hands
  // stage 4 a symbol that resolves to an object, and the recipe fails on import.
  const decl = Node.isFunctionDeclaration(fn) ? fn : initializerOf(fn, SyntaxKind.VariableDeclaration);

  if (decl && isExportedStatement(decl)) {
    const isDefault = isDefaultExported(decl) || isDefaultExported(fn);
    return {
      kind: isDefault ? "import-default" : "import-named",
      reachable: true,
      module: moduleSpecifier,
      symbol: Node.isFunctionDeclaration(decl) ? decl.getName() : decl.getName(),
    };
  }

  // Method on an exported object literal: `export const svc = { run() {} }`.
  const member = Node.isMethodDeclaration(fn) ? fn : initializerOf(fn, SyntaxKind.PropertyAssignment);
  const objectLiteral = member?.getParent();
  if (objectLiteral && Node.isObjectLiteralExpression(objectLiteral)) {
    const varDecl = initializerOf(objectLiteral, SyntaxKind.VariableDeclaration);
    if (varDecl && isExportedStatement(varDecl)) {
      return {
        kind: "import-named-property",
        reachable: true,
        module: moduleSpecifier,
        symbol: varDecl.getName(),
        property: deriveName(fn),
      };
    }
  }

  const call = fn.getParent();
  if (Node.isCallExpression(call) || Node.isNewExpression(call)) {
    return {
      kind: "call-argument",
      reachable: false,
      reason: "passed as an argument at module scope — it runs when the surrounding call runs",
      calledBy: call.getExpression().getText().split("\n")[0],
      module: moduleSpecifier,
    };
  }

  return {
    kind: "module-private",
    reachable: false,
    reason: "declared at module scope but not exported — reach it through a caller in the same module",
    module: moduleSpecifier,
  };
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------

/** One-line source excerpt — what the agent reads the input off of in stage 3. */
function snippet(node, max = 160) {
  const text = node.getText().replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clauseLabel(clause) {
  return Node.isDefaultClause(clause) ? "default" : `case ${snippet(clause.getExpression(), 60)}`;
}

/** Ambient declarations and const enums are erased before istanbul ever runs. */
function isAmbient(node) {
  // `const enum` is NOT ambient under this toolchain, and treating it as such
  // was model error #7. tsc inlines a const enum and emits nothing; ESBUILD
  // CANNOT, because it compiles one file at a time and has no cross-module view
  // - so it emits the same `X || (X = {})` IIFE as a regular enum, and istanbul
  // counts 2 sides and 1 function for it. Under vitest the transform is esbuild,
  // so esbuild's behaviour is the one that decides the denominator.
  //
  // Found by the construct conformance suite in a single run: it isolated the
  // whole divergence to one file, `e-enums-namespaces.ts`, at -2 sides and -1
  // function - exactly one construct's worth.
  //
  // A `declare` ancestor still means ambient: that genuinely emits nothing.
  for (let current = node; current; current = current.getParent()) {
    if (typeof current.hasDeclareKeyword === "function" && current.hasDeclareKeyword()) {
      return true;
    }
    if (Node.isSourceFile(current)) break;
  }
  return false;
}

/** Parens are not nodes in the tree istanbul instruments — see through them. */
function unwrapParens(node) {
  let current = node;
  while (Node.isParenthesizedExpression(current)) current = current.getExpression();
  return current;
}

/** Flatten `a && b || c` to its operand leaves — istanbul counts one arm each. */
function logicalLeaves(node) {
  const inner = unwrapParens(node);
  if (Node.isBinaryExpression(inner) && isLogicalOperator(inner)) {
    return [...logicalLeaves(inner.getLeft()), ...logicalLeaves(inner.getRight())];
  }
  return [inner];
}

/** True when this logical expression is the root of its chain, parens included. */
function isChainRoot(node) {
  let current = node;
  let parent = current.getParent();
  while (Node.isParenthesizedExpression(parent)) {
    current = parent;
    parent = current.getParent();
  }
  return !(Node.isBinaryExpression(parent) && isLogicalOperator(parent));
}

function isLogicalOperator(binary) {
  const kind = binary.getOperatorToken().getKind();
  return (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken
  );
}

/**
 * Every arm in the file, attributed to the function that owns it — or to module
 * scope, where a top-level `const x = a ?? b` or a class-property initializer
 * lives. istanbul instruments those too, so a per-function-only walk under-counts
 * the file and the reconcile drifts.
 *
 * `istanbul: true` marks the kinds istanbul instruments. `catch` is a genuine
 * decision point but istanbul does not instrument it, so it is counted apart.
 */
/**
 * Does esbuild DOWNLEVEL class fields for this target?
 *
 * Below ES2022 it must: `class A { x = 1 }` becomes a synthesised
 * `constructor() { __publicField(this, "x", 1) }` plus two module-level helper
 * arrows, and istanbul counts all of them as functions. At ES2022 and above
 * class fields are native, so none of it exists.
 *
 * Measured on the conformance suite at six targets: ES6, ES2019 and ES2021 are
 * exact, while ES2022, ES2024 and ESNext over-counted functions by 6 across 3
 * files - because the rule was applied unconditionally. `ts.ScriptTarget`
 * numbers ES2021 as 8 and ES2022 as 9, so the boundary is `>= 9`.
 */
function downlevelsClassFields(target) {
  // vitest 4 stopped downlevelling class fields at ALL, whatever the tsconfig
  // says. Measured on the same probe as the enum arms - one class with a field
  // initializer and no constructor, tsconfig target es2019:
  //
  //   vitest 2.1.9   3 functions - the synthesised constructor is counted
  //   vitest 3.2.4   3 functions - the synthesised constructor is counted
  //   vitest 4.1.10  2 functions - no synthesised constructor exists
  //
  // Corroborated on ats-sourcing-service (vitest 4.1.9, target es2019): arms
  // reconciled 2307/2307 while functions came in +2, on exactly the two files
  // holding a class with an instance field and no constructor.
  //
  // So the tsconfig target decides this only while the runner still downlevels.
  if (VITEST_MAJOR >= 4) return false;
  // An absent target means tsc's default, ES3/ES5 - which downlevels.
  if (target === undefined || target === null) return true;
  return target < 9;
}

/**
 * The line istanbul keys a class's SYNTHESISED constructor on.
 *
 * A decorated class splits the two coordinates ts-morph offers:
 * `getStartLineNumber()` is the DECORATOR's line, because decorators are
 * children of the node, while the synthesised constructor lands on the class
 * itself. The name node is what matches.
 *
 * Measured against the real chain - vitest 5.0.0 with @vitest/coverage-istanbul
 * and `all: true`, not a bare esbuild call - on a fixture holding each shape:
 *
 *   4: @Cls()
 *   5: export class Controller {      <- istanbul puts the synthesised ctor HERE
 *   6:   private cache = 1;
 *
 * A DECORATED METHOD goes the other way and keeps its decorator's line, so this
 * helper is deliberately not used for one. That asymmetry is the whole reason
 * it is written down: an earlier pass "fixed" methods to the name node on the
 * strength of an esbuild-plus-istanbul proxy, which reports the opposite - the
 * same proxy bench.mjs records as being off by 13% on this repo's own sides.
 * Ground truth is the toolchain stage 1 runs, never a reconstruction of it.
 */
function istanbulLineOfClass(cls) {
  const nameNode = typeof cls.getNameNode === "function" ? cls.getNameNode() : undefined;
  return nameNode ? nameNode.getStartLineNumber() : cls.getStartLineNumber();
}

/**
 * WHAT SURVIVES OF AN ENUM, which from vitest 4 depends on the enum's SHAPE and
 * not only on the runner's version.
 *
 * A TS `enum` downlevels to `var X; (function (X) { … })(X || (X = {}))` - one
 * IIFE istanbul counts as a function, and one `||` it counts as a 2-arm
 * binary-expr. Before vitest 4 that was the whole story. From 4 the transform
 * elides what it can prove is unused, and the two halves are elided under
 * DIFFERENT conditions. Measured on vitest 4.1.8 and 2.1.9, target es6, four
 * enums in one file:
 *
 *                                      4.1.8          2.1.9
 *   local,    member access only      0 arms 0 fns   2 arms 1 fn
 *   local,    object referenced       2 arms 1 fn    2 arms 1 fn
 *   exported, member access only      0 arms 1 fn    2 arms 1 fn
 *   exported, object referenced       0 arms 1 fn    2 arms 1 fn
 *
 * So under 4: the ARM survives only for a local enum whose OBJECT is used, and
 * the FUNCTION is lost only for a local enum that is never used as an object.
 * `X.Member` on a string enum inlines to a constant, so nothing needs the
 * object; `Object.values(X)` or `z.nativeEnum(X)` needs it and keeps the IIFE.
 *
 * Found by the fleet, not by a probe: sourcing-ms (vitest 4.1.8) drifted -4 arms
 * across exactly two files, `src/types/jdKeyword/index.ts` and
 * `src/services/locationService/index.ts`, each holding one local enum reached
 * through `z.nativeEnum(ATSEnum)` and `Object.values(HTTP_METHOD)`. Its
 * functions reconciled at the same time, which is what said the two halves obey
 * different rules.
 *
 * A namespace is unaffected - it keeps 2 arms and 1 function everywhere.
 */
function enumObjectIsReferenced(node) {
  const nameNode = typeof node.getNameNode === "function" ? node.getNameNode() : undefined;
  if (!nameNode || typeof nameNode.findReferencesAsNodes !== "function") return true;
  let refs;
  try {
    refs = nameNode.findReferencesAsNodes();
  } catch {
    // Refusing to guess would mean dropping the arm; keeping it is the side that
    // shows up as drift rather than hiding as a silent under-count.
    return true;
  }
  for (const ref of refs) {
    if (ref === nameNode) continue;
    const parent = ref.getParent?.();
    // `X.Member` READ is inlinable, so it alone does not keep the object alive.
    const isMemberRead =
      parent &&
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === ref &&
      !(Node.isBinaryExpression(parent.getParent?.()) && parent.getParent().getLeft() === parent);
    if (!isMemberRead) return true;
  }
  return false;
}

function collectFileArms(sourceFile, file, downlevelFields) {
  const byFunction = new Map();
  const moduleScope = [];
  // Each downlevelled enum/namespace also emits an IIFE, which istanbul counts
  // as one function. Tracked so the function reconcile closes too.
  //
  // The LINES go with the count, because stage 7 prices a suppression by
  // joining the scan's function model against the coverage report per line. An
  // artifact with no line is invisible to that join: a directive that removed
  // one would read as an unexplained gap rather than as a priced side.
  let transpileArtifacts = 0;
  const transpileArtifactLines = [];

  /**
   * A class with property initializers and NO explicit constructor gets one
   * SYNTHESISED by esbuild, and istanbul counts it as a function:
   *
   *   class A { private router = 1; routes() {} }
   *     ->  class A { constructor() { __publicField(this, "router", 1); } ... }
   *
   * Reading TypeScript there is no constructor to see, so the scan missed one
   * function per such class. Found by benchmarking the scan against 10 foreign
   * repos: branch sides matched 41839/41839 exactly, while functions came in
   * 180 LOW, every drifting file off by exactly -1 - and the one NestJS repo
   * drifted zero, because Nest classes already declare a constructor for
   * dependency injection while Express service and route classes do not.
   */
  for (const cls of downlevelFields
    ? sourceFile
        .getDescendantsOfKind(SyntaxKind.ClassDeclaration)
        .concat(sourceFile.getDescendantsOfKind(SyntaxKind.ClassExpression))
    : []) {
    if (cls.getConstructors().length) continue;
    const hasInstanceInitializer = cls
      .getProperties()
      .some((prop) => prop.getInitializer() !== undefined && !prop.isStatic());
    // A parameter property (`constructor(private x: T)`) also emits an
    // assignment, but that requires an explicit constructor - which the guard
    // above already excluded.
    // Keyed on the CLASS, and on its name rather than its start: `@Injectable()`
    // on the line above puts ts-morph's start on the decorator, while istanbul
    // puts the synthesised constructor on the class line. Probed: decorator 3,
    // `class Decorated` 4, fnMap 4.
    if (hasInstanceInitializer) {
      transpileArtifacts += 1;
      transpileArtifactLines.push(istanbulLineOfClass(cls));
    }
  }
  const seen = new Map();

  const push = (node, kind, count, istanbul, labels) => {
    const line = node.getStartLineNumber();
    // The id every proposal cites and every artifact is keyed on. Line + kind +
    // ordinal, because one line can carry several arms of one kind.
    const slot = `${line}:${kind}`;
    const ordinal = seen.get(slot) ?? 0;
    seen.set(slot, ordinal + 1);

    const text = snippet(node);
    const owner = node.getAncestors().find(isFunctionLike);

    // A CONTENT-ADDRESSED id, minted beside the line-based one.
    //
    // A line-based id is a schema keyed on a coordinate that any edit moves. One
    // one-line comment remapped 1,747 references in `proposals/`; a later pair
    // moved 1,938; 13 of 29 blocked entries were stale at once, with shifts of
    // +8 to +56. Nothing detects it, because an id that no longer exists reads
    // the same as an arm that was covered - so an entry silently stops covering
    // the arm it was written for.
    //
    // The hash is over what an arm IS rather than where it sits: the enclosing
    // function's name, the arm kind, the arm's own source text, and its ordinal
    // among identical arms in that function. A comment above it changes none of
    // those. `?? null` appears many times in one file, which is why the owner
    // and the ordinal are in the digest and the text alone is not enough.
    //
    // Both ids ship. `armId` stays authoritative until every consumer reads
    // `stableId`, and `armids.mjs` uses stableId to repair line-based
    // references mechanically instead of by hand.
    const ownerName = owner ? deriveName(owner) : "<module>";
    const shape = `${ownerName}|${kind}|${text}`;
    const shapeOrdinal = seen.get(shape) ?? 0;
    seen.set(shape, shapeOrdinal + 1);
    const stableId = `${file}#${createHash("sha1")
      .update(`${shape}|${shapeOrdinal}`)
      .digest("hex")
      .slice(0, 10)}:${kind}`;

    const arm = {
      armId: `${file}#${slot}:${ordinal}`,
      stableId,
      kind,
      count,
      istanbul,
      line,
      column: node.getStart() - node.getStartLinePos(),
      labels,
      text,
    };
    if (!owner) {
      moduleScope.push(arm);
      return;
    }
    const existing = byFunction.get(owner);
    if (existing) existing.push(arm);
    else byFunction.set(owner, [arm]);
  };

  sourceFile.forEachDescendant((node) => {
    switch (node.getKind()) {
      case SyntaxKind.IfStatement:
        // istanbul records 2 locations for an `if`, with or without an `else`.
        push(node, "if", 2, true, ["then", "else"]);
        break;

      case SyntaxKind.ConditionalExpression:
        push(node, "cond-expr", 2, true, ["whenTrue", "whenFalse"]);
        break;

      case SyntaxKind.BinaryExpression: {
        if (!isLogicalOperator(node)) break;
        // Count once, at the root of the chain, over its flattened leaves.
        if (!isChainRoot(node)) break;
        const leaves = logicalLeaves(node);
        push(node, "binary-expr", leaves.length, true, leaves.map((leaf) => snippet(leaf, 60)));
        break;
      }

      case SyntaxKind.SwitchStatement:
        push(node, "switch", node.getClauses().length, true, node.getClauses().map(clauseLabel));
        break;

      case SyntaxKind.Parameter:
      case SyntaxKind.BindingElement:
        if (node.hasInitializer()) push(node, "default-arg", 1, true, [`${node.getName()} falls back to its default`]);
        break;

      case SyntaxKind.CatchClause:
        push(node, "catch", 1, false, ["throws"]);
        break;

      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.ModuleDeclaration:
        // Not source logic: TS downlevels these to `X || (X = {})`, which
        // istanbul instruments as a 2-arm binary-expr. Counted so the
        // denominator reconciles; never a target — no test can cover arm 2.
        // Ambient (`declare global { namespace … }`) emits no runtime code at
        // all, so istanbul never sees it. A `const enum` is NOT ambient here:
        // esbuild compiles one file at a time and cannot inline it, so it
        // downlevels like any other enum — see isAmbient.
        //
        // The ENUM half is version-dependent and the namespace half is not.
        // Under vitest 4 an enum contributes 0 arms and a namespace still
        // contributes 2. Measured: assessment-service (vitest 4.1.10) drifted
        // +2 on src/services/ai-centralization.ts, its one `export enum`, and
        // istanbul's branchMap for that file holds 6 locations, none of them at
        // the enum — while its fnMap still counts the enum's IIFE. So the
        // FUNCTION model is unchanged and only the arm is gated.
        if (!isAmbient(node)) {
          // The IIFE is still a FUNCTION under every version measured - vitest
          // 4 counts both enums in the probe - so this counter increments
          // whether or not the arm below is pushed. Skipping it with the arm
          // traded a +2 arm drift for a -1 function drift on the same file.
          const isEnum = node.getKind() === SyntaxKind.EnumDeclaration;
          // See enumObjectIsReferenced: from vitest 4 the IIFE and the `||` are
          // elided under different conditions, so the function and the arm are
          // decided separately rather than together.
          const exported = typeof node.isExported === "function" ? node.isExported() : false;
          const objectUsed = isEnum && ENUM_ELISION ? enumObjectIsReferenced(node) : true;
          const keepsFunction = !isEnum || !ENUM_ELISION || exported || objectUsed;
          const keepsArm = !isEnum || !ENUM_ELISION || (!exported && objectUsed);
          if (keepsFunction) {
            transpileArtifacts += 1;
            // An enum/namespace IIFE carries no decorator, so its own start line
            // is the one istanbul uses.
            transpileArtifactLines.push(node.getStartLineNumber());
          }
          if (!keepsArm) break;
          push(node, "transpile-artifact", 2, true, ["init", "reuse"]);
        }
        break;

      default:
        break;
    }
  });

  return { byFunction, moduleScope, transpileArtifacts, transpileArtifactLines };
}

/**
 * Abstract methods, overload signatures and ambient declarations have no body.
 * They emit no runtime code, so istanbul never sees them and nothing can invoke
 * them — they are type surface, not functions.
 */
function hasBody(fn) {
  if (Node.isConstructorDeclaration(fn)) return fn.getBody() !== undefined;
  if (typeof fn.getBody !== "function") return true;
  return fn.getBody() !== undefined;
}

const armTotals = (arms) => ({
  istanbul: arms.filter((a) => a.istanbul).reduce((n, a) => n + a.count, 0),
  ast: arms.reduce((n, a) => n + a.count, 0),
  list: arms,
});

// ---------------------------------------------------------------------------
// boundaries — what stage 3/4 will have to answer for
// ---------------------------------------------------------------------------

/**
 * Globals that are real egress or real nondeterminism, and have NO import for
 * the import map to find.
 *
 * `fetch` is the sole network call of location-ms's googleMap.service.ts, and
 * the scan reported `boundaries: []` for every method in it - so the worklist
 * asked for no arrangement at all for a file whose only job is to call Google.
 * A global has no module, so it is named `globalThis` and answered there.
 */
/**
 * `required` means an unanswered one makes the row unrunnable or its value
 * wrong: real egress. `advisory` means it is real nondeterminism that only
 * matters when the recorded value depends on it - a `Date.now()` inside a log
 * line does not need controlling, one inside the returned object does.
 *
 * The split exists because marking them all required added 43 warnings to this
 * repo's own proposals in one run, every one of them `Date` or `setTimeout`,
 * and a check that fires 43 times on correct work gets tuned off.
 */
const GLOBAL_BOUNDARIES = new Map([
  ["fetch", { why: "network", advisory: false }],
  ["XMLHttpRequest", { why: "network", advisory: false }],
  ["WebSocket", { why: "network", advisory: false }],
  ["setTimeout", { why: "time", advisory: true }],
  ["setInterval", { why: "time", advisory: true }],
  ["Date", { why: "time", advisory: true }],
  ["crypto", { why: "crypto", advisory: true }],
  ["performance", { why: "time", advisory: true }],
]);

function importMap(sourceFile) {
  const map = new Map();
  // Seeded first so a real import of the same name overwrites it - a file that
  // imports `fetch` from node-fetch gets the module, not the global.
  for (const [name, meta] of GLOBAL_BOUNDARIES) {
    map.set(name, { module: "globalThis", imported: name, global: true, ...meta });
  }
  for (const decl of sourceFile.getImportDeclarations()) {
    const module = decl.getModuleSpecifierValue();
    // `import type { X }` erases before the code runs, so X has no runtime
    // existence to answer for. Read off the import rather than inferred from
    // usage, because it is the author's own declaration of the fact.
    const declTypeOnly = decl.isTypeOnly();
    const def = decl.getDefaultImport();
    if (def) map.set(def.getText(), { module, imported: "default", ...(declTypeOnly ? { typeOnly: true } : {}) });
    for (const named of decl.getNamedImports()) {
      // `import { type X, y }` - the inline form marks one specifier.
      const typeOnly = declTypeOnly || named.isTypeOnly();
      map.set(named.getAliasNode()?.getText() ?? named.getName(), {
        module,
        imported: named.getName(),
        ...(typeOnly ? { typeOnly: true } : {}),
      });
    }
    const ns = decl.getNamespaceImport();
    if (ns) map.set(ns.getText(), { module, imported: "*", ...(declTypeOnly ? { typeOnly: true } : {}) });
  }
  return map;
}

/**
 * Is this identifier standing in a TYPE position rather than a value one?
 *
 * `collectBoundaries` matched every identifier in a body against the file's
 * import map without asking, so `const message: EmailMessage = { … }` reported
 * `EmailMessage` as a live boundary that stage 3 had to answer and stage 4 had
 * to substitute. There is nothing there to substitute — the annotation is gone
 * before the code runs.
 *
 * Measured on a freshly-onboarded 710-line service: 6 of 47 boundary answers
 * existed only to declare that a type is a type, and the only way to satisfy
 * the demand was an answer whose whole content was the words "type only",
 * matched by a regex in validate.mjs. ts-morph knows the position; asking it is
 * cheaper than asking the author.
 *
 * The walk is deliberately SHORT — through a qualified name (`ns.Type`) to the
 * node holding it, and no further. A deep ancestor walk would have to decide
 * where value-land begins, and getting that boundary wrong in the permissive
 * direction drops a REAL boundary silently, which is the one outcome worse than
 * asking for an answer nobody needs.
 */
const TYPE_POSITION_KINDS = new Set([
  SyntaxKind.TypeReference,
  SyntaxKind.TypeQuery,
  SyntaxKind.ExpressionWithTypeArguments,
  SyntaxKind.ImportType,
  SyntaxKind.TypePredicate,
  SyntaxKind.TypeOperator,
  SyntaxKind.IndexedAccessType,
]);

function inTypePosition(node) {
  let parent = node.getParent();
  while (parent && Node.isQualifiedName(parent)) parent = parent.getParent();
  if (!parent) return false;
  return TYPE_POSITION_KINDS.has(parent.getKind()) || Node.isTypeNode(parent);
}

/**
 * `this.redis.get` -> "this.redis". Walks a property-access chain down to its
 * root and returns the first field name when that root is `this`.
 */
function thisFieldOf(expression, fn) {
  const chain = [];
  let cursor = expression;
  while (Node.isPropertyAccessExpression(cursor)) {
    chain.unshift(cursor.getName());
    cursor = cursor.getExpression();
  }
  if (!Node.isThisExpression(cursor) || chain.length === 0) return undefined;

  // `this.generateKey()` is a private method on the same class — internal logic,
  // not a boundary. Only a HELD field (a property declaration) is something
  // stage 4 has to answer for.
  const classDecl = fn.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
  if (classDecl?.getInstanceMethod?.(chain[0]) || classDecl?.getStaticMethod?.(chain[0])) {
    return undefined;
  }
  return `this.${chain[0]}`;
}

function collectBoundaries(fn, imports) {
  const found = new Map();
  // Whether a symbol was ever seen in VALUE position. A symbol only ever seen
  // in a type annotation is marked `typeOnly` and stage 3 stops demanding an
  // answer for it — see `inTypePosition`. Tracked per key rather than decided
  // at first sight, because one identifier can appear both ways in the same
  // body (`const c: Client = new Client()`), and one value use is enough to
  // make the boundary real.
  const usedAsValue = new Set();

  const visit = (node, traversal) => {
    if (isFunctionLike(node) && node !== fn) {
      traversal?.skip();
      return;
    }
    if (Node.isIdentifier(node)) {
      const hit = imports.get(node.getText());
      if (hit) {
        const key = `${hit.module}#${hit.imported}`;
        if (!hit.typeOnly && !inTypePosition(node)) usedAsValue.add(key);
        if (!found.has(key)) {
          // `advisory` and `global` ride along from the import map, or validate
          // cannot tell a `Date` it may ignore from a `fetch` it may not.
          found.set(key, {
            symbol: node.getText(),
            module: hit.module,
            imported: hit.imported,
            ...(hit.global ? { global: true, why: hit.why } : {}),
            ...(hit.advisory ? { advisory: true } : {}),
          });
        }
      }
      return;
    }
    if (Node.isPropertyAccessExpression(node) && node.getText().startsWith("process.env.")) {
      const key = node.getText();
      if (!found.has(key)) found.set(key, { symbol: key, module: "process", imported: "env" });
      return;
    }

    // A client held on a class field — `this.redis.get(...)`, `this.prisma.x()` —
    // is an outbound call that stage 4 has to answer, but it is not an imported
    // identifier so the import map never sees it. Collected as its own kind.
    if (Node.isCallExpression(node)) {
      const field = thisFieldOf(node.getExpression(), fn);
      if (field && !found.has(field)) {
        found.set(field, { symbol: field, module: "<instance field>", imported: field.slice(5) });
      }
    }
  };

  if (Node.isSourceFile(fn)) {
    // MODULE SCOPE: what runs at import. The statements of the file itself,
    // minus the imports (whose identifiers are the map, not uses of it), the
    // declarations that only DEFINE something for later (a function, a class,
    // a type), and every function body below them -- `visit` skips those by
    // `isFunctionLike`, so nginx's `logHook: (span, record) => ...` is not an
    // import-time call but the `new NodeSDK(...)` holding it is.
    for (const stmt of fn.getStatements()) {
      if (Node.isImportDeclaration(stmt) || Node.isImportEqualsDeclaration(stmt) || Node.isExportDeclaration(stmt)) continue;
      if (isFunctionLike(stmt) || Node.isClassDeclaration(stmt) || Node.isInterfaceDeclaration(stmt) || Node.isTypeAliasDeclaration(stmt)) continue;
      stmt.forEachDescendant(visit);
    }
  } else {
    const body = typeof fn.getBody === "function" ? fn.getBody() : undefined;
    body?.forEachDescendant(visit);
  }
  // MARKED, not dropped. Dropping the entry would turn every answer already
  // written for one of these into "answers a boundary nothing touches" — a
  // different complaint about the same correct work. Marked, validate stops
  // DEMANDING an answer and still accepts one.
  return [...found.entries()].map(([key, b]) =>
    // `<instance field>` and `process.env.X` keys never enter `usedAsValue` and
    // are not import hits, so they are exempted by construction rather than by
    // being in the set: only a key the import map produced can be type-only.
    b.module === "<instance field>" || b.module === "process" || usedAsValue.has(key)
      ? b
      : { ...b, typeOnly: true }
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const project = new Project({ tsConfigFilePath: TSCONFIG, skipAddingFilesFromTsConfig: false });
  // The target is part of the denominator, so it is read from the tsconfig
  // rather than assumed.
  const scriptTarget = project.getCompilerOptions().target;
  const downlevelFields = downlevelsClassFields(scriptTarget);
  // ts-morph resolves a RELATIVE glob against process.cwd(), not the project
  // root. Run from .claude/charpilot this matched NOTHING, and scan.mjs wrote
  // an empty scan.json - 0 files, 0 functions, 0 arms - under a leading tick,
  // destroying the artifact that validate/coverage/worklist/ledger and the
  // recorder's arm join all read. The same defect was fixed in deadcode.mjs;
  // this is the second instance, so the glob is absolute AND the count is
  // asserted below.
  const sourceFiles = project
    .getSourceFiles(SRC_GLOB)
    // Glob-matched, because the host's coverage.exclude is globbed by
    // istanbul. An `.includes()` here left `src/**/types.ts` in the scan and
    // out of the denominator - drift the list exists to prevent.
    .filter((sf) => !isSrcExcluded(rel(sf)))
    .filter((sf) => !sf.getFilePath().includes("/node_modules/"))
    .sort((a, b) => rel(a).localeCompare(rel(b)));

  if (sourceFiles.length === 0) {
    throw new Error(
      `scan found 0 files under ${SRC_ROOT} - refusing to write an empty scan.json. ` +
        `Every later stage reads this file, and a zero here is indistinguishable from a real answer.`
    );
  }

  const functions = [];
  const records = []; // [node, record] so the driver pass can resolve identities
  const perFileArms = {};
  const perFileFunctions = {};
  // The same function model as perFileFunctions, but broken out by the line
  // istanbul keys each function on, so stage 7 can price a directive that
  // removed one. `{ [file]: { [line]: count } }`.
  const perFileFunctionLines = {};
  const moduleScopeArms = [];

  for (const sourceFile of sourceFiles) {
    const file = rel(sourceFile);
    const typeOnly = TYPE_ONLY_DIRS.some((dir) => file.startsWith(`${dir}/`));
    const imports = importMap(sourceFile);
    const { byFunction, moduleScope, transpileArtifacts, transpileArtifactLines } = collectFileArms(
      sourceFile,
      file,
      downlevelFields
    );
    // Per FILE, for the entry-unit ordinal below. Reusing collectFileArms's own
    // `seen` map does not work: it is scoped inside that function and its keys
    // are branch slots, so the entry ordinal never incremented.
    const entrySlots = new Map();
    perFileFunctions[file] = transpileArtifacts;
    const fnLines = {};
    perFileFunctionLines[file] = fnLines;
    for (const line of transpileArtifactLines) fnLines[line] = (fnLines[line] ?? 0) + 1;

    const moduleTotals = armTotals(moduleScope);
    perFileArms[file] = moduleTotals.istanbul;
    if (moduleTotals.istanbul > 0) {
      // Module-scope arms have no owning function, so nothing in the work list
      // can drive them directly — they run at import time.
      // AND WHAT THEY CALL. Module-scope code has boundaries like any function:
      // nginx-redirecting-ms's instrumentation.ts hands `buildId` to
      // `new Resource(...)` inside `new NodeSDK(...)` and calls `sdk.start()`,
      // all at import. Listed, validate asks for their answers and the
      // recorder's ledger shows what the import passed them -- which is where
      // a module with no exports keeps its behaviour. Without the list the
      // import ran the real SDK inside the row.
      moduleScopeArms.push({ file, ...moduleTotals, boundaries: collectBoundaries(sourceFile, imports) });
    }

    sourceFile.forEachDescendant((node) => {
      if (!isFunctionLike(node) || !hasBody(node)) return;

      // MODEL ERROR #8: istanbul does not instrument a native `#private` class
      // method, so it is a real function that is NOT in istanbul's function
      // denominator. Probed:
      //
      //   class A { m(){} n(){} }         es2022 -> 2 fns
      //   class A { m(){} #p(){} }        es2022 -> 1 fn   (#p not counted)
      //   class A { m(){} #p(){} #q(){} } es2022 -> 1 fn
      //   class A { m(){} private p(){} } es2022 -> 2 fns  (TS `private` is
      //                                                     type-only, emits a
      //                                                     normal method)
      //
      // Found on backstage, whose src/entrypoints/scheduler/lib/TaskStatePoller.ts
      // holds 14 real functions of which 9 are `#private` - and istanbul
      // reported exactly 5. No internal service uses `#private`, so only
      // foreign code could surface this.
      //
      // Below ES2022 esbuild downlevels them into WeakSet helpers and the count
      // goes UP instead (5 for the one-method case above), which this does not
      // yet model - see the register.
      const isNativePrivateMethod =
        !downlevelFields &&
        Node.isMethodDeclaration(node) &&
        node.getName?.()?.startsWith("#") === true;
      // A decorated METHOD keeps its decorator's line under the real chain -
      // istanbul put `@Dec()` on 8 and `find()` on 9 at line 8, and a
      // two-decorator method at the FIRST decorator. That is exactly
      // `getStartLineNumber()`, so `line` is already the istanbul key.
      const istanbulLine = node.getStartLineNumber();
      if (!isNativePrivateMethod) {
        perFileFunctions[file] += 1;
        fnLines[istanbulLine] = (fnLines[istanbulLine] ?? 0) + 1;
      }
      const arms = armTotals(byFunction.get(node) ?? []);
      const entry = deriveEntry(node, file);
      const line = node.getStartLineNumber();

      perFileArms[file] += arms.istanbul;

      const record = {
        id: `${file}:${line}:${deriveName(node)}`,
        file,
        typeOnly,
        line,
        // The line istanbul keys this function on, which differs from `line`
        // only for a decorated member. Carried beside it rather than replacing
        // it, because `line` is what `armId` and `entryArmId` are built from.
        istanbulLine,
        // Whether istanbul's fnMap models this function at all - the mirror of
        // `arm.istanbul` on the branch side. False for a native `#private`
        // method, which is a real function istanbul does not instrument.
        istanbulFn: !isNativePrivateMethod,
        endLine: node.getEndLineNumber(),
        name: deriveName(node),
        kind: node.getKindName(),
        async: typeof node.isAsync === "function" ? node.isAsync() : false,
        params: (node.getParameters?.() ?? []).map((p) => ({
          name: p.getName(),
          type: p.getType().getText(p),
          optional: p.isOptional() || p.hasInitializer(),
          // A REST parameter is unbounded, and recording it as one optional
          // param made validate's arity check cap the call at one argument -
          // so `runWithFallback(...runs: Run<T>[])` could not be proposed with
          // more than one runner, which is the whole reason the function
          // exists. Found on location-ms.
          rest: typeof p.isRestParameter === "function" ? p.isRestParameter() : false,
        })),
        entry,
        // Every function has one unit before any branch: "was it invoked at all".
        // A function with no decision point has no arms, so an arm-driven work
        // list drops it entirely — 77 such functions on this service.
        //
        // The trailing index is an ORDINAL, not the constant 0 it used to be.
        // Two functions can declare on one line - a curried arrow is the common
        // case, `errorHandler(fn)` and the `(req,res,next)` it returns both
        // start at src/utils/errorHandler.ts:2 - and both then minted
        // `...#2:entry:0`. The ledger caught it as an asymmetry, 1301 distinct
        // stableIds against 1300 armId keys, because the second write silently
        // won. worklist.mjs emits entryArmId as a function-entry item's armId,
        // so downstream the two entry units were ONE id and one of them could
        // never be commissioned. The per-file ordinal that fixed this on the
        // stableId side was never applied here.
        entryArmId: `${file}#${line}:entry:${(() => {
          const n = entrySlots.get(line) ?? 0;
          entrySlots.set(line, n + 1);
          return n;
        })()}`,
        arms,
        boundaries: collectBoundaries(node, imports),
      };
      functions.push(record);
      records.push([node, record]);
    });
  }

  resolveDrivers(records);

  const runnable = functions.filter((f) => !f.typeOnly);
  // A scan that finds source files and then zero runnable functions in them is
  // not a result, it is a misconfiguration - and it was reported under a
  // leading tick. Measured on profile-centralized: TYPE_ONLY_DIRS was installed
  // as ["src","prisma","test"], and because the test is file.startsWith(dir +
  // "/"), a bare "src" marked ALL 282 functions type-only. The scan printed
  // "functions 0 / with own entry 0 / arms 0" while scan.json held 282 records,
  // and the next percentage divided by zero.
  if (functions.length && !runnable.length) {
    throw new Error(
      `refusing to write a scan with 0 runnable functions: all ${functions.length} were marked type-only.\n` +
        `  TYPE_ONLY_DIRS in test/src-exclude.mjs is matched as a DIRECTORY PREFIX, so a bare "src" excludes the whole tree.\n` +
        `  Name the actual type directories (e.g. ["src/types"]), not the source root.`
    );
  }
  const withEntry = runnable.filter((f) => f.entry.reachable);

  const byEntryKind = {};
  for (const f of runnable) byEntryKind[f.entry.kind] = (byEntryKind[f.entry.kind] ?? 0) + 1;

  const scan = {
    stage: "2-scan",
    generatedAt: new Date().toISOString(),
    // THE COMMIT THIS DESCRIBES. baseline.json has carried one since it was
    // written (`environment.gitSha`) and scan.json never did, so
    // `freshness.recordedSha` fell through to null for it and the only signal
    // left was mtime. A timestamp says when the file was made, not what it was
    // made from: run 20260918T040720Z reused a scan.json generated 2026-09-08
    // against a checkout three weeks newer, and nothing in the artifact could
    // contradict it.
    gitSha: headSha(),
    // D61: WHICH SCAN WROTE THIS. `gitSha` says what the scan describes and
    // says nothing about the model that described it, so a resume under a
    // fixed scan.mjs read the old artifact as done - `scan: already done`, and
    // the vias D58 fixed stayed unresolved. steps/scan.mjs `satisfied` asks
    // for this digest to equal the installed scan.mjs's. The digest is of this
    // file's own bytes (freshness.mjs `toolDigest`), so a change nobody
    // remembered to version still re-scans; the re-scan of an unchanged tree
    // is one ts-morph pass, and what it re-records downstream is only what it
    // changed (a proposal whose via moved has a new fingerprint - 6b).
    scanTool: { file: "scan.mjs", sha256: toolDigest(fileURLToPath(import.meta.url)) },
    srcRoot: "src",
    totals: {
      files: sourceFiles.length,
      functions: runnable.length,
      withOwnEntry: withEntry.length,
      withoutOwnEntry: runnable.length - withEntry.length,
      pctWithOwnEntry: Number(((withEntry.length / runnable.length) * 100).toFixed(1)),
      armsIstanbul: runnable.reduce((n, f) => n + f.arms.istanbul, 0),
      armsAst: runnable.reduce((n, f) => n + f.arms.ast, 0),
      armsBehindOwnEntry: withEntry.reduce((n, f) => n + f.arms.istanbul, 0),
      armsAtModuleScope: moduleScopeArms.reduce((n, f) => n + f.istanbul, 0),
    },
    moduleScopeArms,
    // The per-file model the reconcile compares, PERSISTED. Without it a
    // benchmark can only count entries in `functions`, which omits the
    // transpile artifacts istanbul does count - so the two sides were
    // measuring different things and the fix for the synthesised constructor
    // looked like it had changed nothing.
    perFileFunctions,
    // Same model, per line, so a directive that removed a FUNCTION can be
    // priced the way one that removed an arm already is. Without it the
    // functions reconcile had no suppressed term at all and read a bookkeeping
    // difference as model drift - the same mistake the arms line documents
    // making three times.
    perFileFunctionLines,
    perFileArms,
    byEntryKind,
    reconcile: {
      arms: reconcile(perFileArms, "istanbulArms"),
      functions: reconcile(perFileFunctions, "istanbulFunctions"),
    },
    functions,
  };

  writeFileSync(SCAN_JSON, JSON.stringify(scan, null, 2));

  // THE ID LEDGER, and the reason it is written before anything reads it.
  //
  // `armId` is line-based, so any edit above an arm moves it, and every artifact
  // naming that id is then wrong without saying so. A remap was done by hand
  // four times in one session - 1,747 references, then 1,938 - by matching each
  // live arm's own source text, which is slow and unverifiable.
  //
  // `stableId` is content-addressed, so it survives the edit. Keeping the
  // PREVIOUS ledger next to the current one turns the remap into a lookup:
  // stale armId -> stableId (from the previous ledger) -> current armId (from
  // this one). `armids.mjs` does exactly that, and refuses when a stableId has
  // no successor, which is the case that means the arm really is gone.
  // PER TARGET. The ledger lived at a single `out/armids.json`, so a scan of a
  // foreign repo overwrote this service's arm-id ledger - measured: a
  // location-ms scan cut it from 1301 arms to 413, and `pilot:armids:fix` then
  // "repaired" this repo's proposals against another repo's ids. A shared
  // mutable ledger across targets is the same class of collision as shared
  // proposals, which is why those are already per-target.
  const ledgerPath = IS_FOREIGN_TARGET
    ? join(OUT_DIR, "bench", `${REPO_ROOT.split("/").filter(Boolean).pop()}.armids.json`)
    : join(OUT_DIR, "armids.json");
  const prevPath = join(OUT_DIR, "armids.prev.json");
  const armRows = scan.functions
    .flatMap((f) => f.arms?.list ?? [])
    .concat((scan.moduleScopeArms ?? []).flatMap((g) => g.list ?? []))
    // Function ENTRY units shift with the file exactly as branch arms do, and
    // 692 references name one. Leaving them out made the first run of
    // `armids.mjs` report them all as stale, which is a checker that cries wolf
    // - the failure mode the three gate outcomes exist to avoid. An entry's
    // identity is its function, so the digest is over the function's name and
    // its signature rather than an arm's text.
    .concat(
      (() => {
        // An ordinal per (file, shape) is required, not optional: the first
        // version digested name + kind + params and produced 107 COLLISIONS,
        // because a file holds many anonymous callbacks with the same derived
        // name and no parameters. A colliding id is worse than a line-based one
        // - it maps two different arms onto one entry.
        const nth = new Map();
        return scan.functions
          .filter((f) => f.entryArmId)
          .map((f) => {
            const shape = `${f.file}|${f.name}|entry|${f.kind}|${(f.params ?? []).map((x) => x.name).join(",")}`;
            const ordinal = nth.get(shape) ?? 0;
            nth.set(shape, ordinal + 1);
            return {
              armId: f.entryArmId,
              stableId: `${f.file}#${createHash("sha1")
                .update(`${shape}|${ordinal}`)
                .digest("hex")
                .slice(0, 10)}:entry`,
              kind: "entry",
            };
          });
      })()
    );
  if (existsSync(ledgerPath)) writeFileSync(prevPath, readFileSync(ledgerPath, "utf8"));
  writeFileSync(
    ledgerPath,
    JSON.stringify(
      {
        stage: 2,
        scannedAt: new Date().toISOString(),
        totals: { arms: armRows.length, distinctStableIds: new Set(armRows.map((a) => a.stableId)).size },
        byStableId: Object.fromEntries(armRows.map((a) => [a.stableId, a.armId])),
        byArmId: Object.fromEntries(armRows.map((a) => [a.armId, a.stableId])),
      },
      null,
      2
    )
  );
  report(scan);
}

/**
 * For every function that cannot be invoked at its own id, name the REACHABLE
 * function an input has to go through to run it. Without this the work list can
 * only say "no own entry", which reads like an exemption — it is not. These are
 * developer-written functions with real arms; the input just belongs to a caller.
 *
 * Resolution, in order of confidence:
 *   nested / call-argument → the innermost enclosing function that IS reachable
 *   module-private         → any reachable function in the file that references it
 *   unexported class       → an exported binding that constructs or holds the class
 */
function resolveDrivers(records) {
  const byNode = new Map(records.map(([node, record]) => [node, record]));

  const firstReachableAncestor = (node) => {
    for (const ancestor of node.getAncestors()) {
      if (!isFunctionLike(ancestor)) continue;
      const record = byNode.get(ancestor);
      if (record?.entry.reachable) return record;
    }
    return undefined;
  };

  // Records are also indexed by file:line, because a node reached through
  // findReferencesAsNodes is not always identity-equal to the node collected in
  // the main walk — and an identity miss silently reports "no caller", which is
  // how getTraceId came out as module-import instead of log-call.
  const byFileLine = new Map(
    records.map(([node, record]) => [`${record.file}:${node.getStartLineNumber()}`, record])
  );

  const enclosingRecord = (node) => {
    for (const ancestor of [node, ...node.getAncestors()]) {
      if (!isFunctionLike(ancestor)) continue;
      if (byNode.has(ancestor)) return byNode.get(ancestor);
      const file = ancestor.getSourceFile().getFilePath().replace(`${REPO_ROOT}/`, "");
      const hit = byFileLine.get(`${file}:${ancestor.getStartLineNumber()}`);
      if (hit) return hit;
    }
    return undefined;
  };

  const referencingRecords = (declaration) => {
    if (!declaration || typeof declaration.findReferencesAsNodes !== "function") return [];
    let refs;
    try {
      refs = declaration.findReferencesAsNodes();
    } catch {
      return [];
    }
    const found = new Set();
    for (const ref of refs) {
      if (inDocComment(ref)) continue;
      const owner = enclosingRecord(ref);
      if (owner && owner.id !== undefined) found.add(owner.id);
    }
    return [...found];
  };

  // How an exported binding at module scope uses a module-private function:
  // HOLDS it as a property (`export const svc = { label }` or `{ run: label }`),
  // which the binding's member of that key then is, or only CALLS it
  // (`export const tracer = tracerBuilder(...)`), which runs at import with the
  // module's own arguments and is no member at all. Tool backlog: the recorder
  // drove both as `binding[name]`, and the second died "entry did not resolve
  // to a function" (assessment-service `20260922T101156Z`, tracerBuilder).
  const bindingUse = new Map();
  // D43: THE KEY AS THE BINDING HOLDS IT. getName() of `{ "company-research-task":
  // x }` is the key's source text, quotes included, and the recorder read
  // binding['"company-research-task"'].
  const keyOf = (prop) => {
    const n = typeof prop.getNameNode === "function" ? prop.getNameNode() : null;
    return n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) || Node.isNumericLiteral(n)) ? n.getLiteralText() : prop.getName();
  };
  const noteBindingUse = (key, ref, varDecl) => {
    const parent = ref.getParent();
    const use = bindingUse.get(key) ?? { held: null, called: false, wrapped: null };
    // D43: a reference inside an ARGUMENT of a call the initializer makes -
    // `export const t = defineTask({ handler })` - is handed to that call, and
    // the binding holds what the call returned, not the function.
    const call = wrappingCall(ref, varDecl);
    if (call) use.wrapped ??= { binding: varDecl.getName(), call };
    else if (parent && Node.isShorthandPropertyAssignment(parent)) use.held ??= parent.getName();
    else if (parent && Node.isPropertyAssignment(parent) && parent.getInitializer() === ref) use.held ??= keyOf(parent);
    else if (parent && Node.isCallExpression(parent) && parent.getExpression() === ref) use.called = true;
    bindingUse.set(key, use);
  };
  const referencingDrivers = (declaration) => {
    if (!declaration || typeof declaration.findReferencesAsNodes !== "function") return [];
    bindingUse.clear();
    const found = new Map();
    let refs;
    try {
      refs = declaration.findReferencesAsNodes();
    } catch {
      return [];
    }
    for (const ref of refs) {
      if (inDocComment(ref)) continue;
      const owner = enclosingRecord(ref);
      if (owner && owner.entry.reachable && !found.has(owner.id)) found.set(owner.id, owner.id);
      if (!owner) {
        // Reference sits at module scope. An exported binding there is itself a
        // driver: importing the module runs it.
        const varDecl = ref.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        if (varDecl && isExportedStatement(varDecl)) {
          const key = `export ${varDecl.getName()}`;
          if (!found.has(key)) found.set(key, key);
          noteBindingUse(key, ref, varDecl);
        }
      }
    }
    return [...found.values()];
  };

  for (const [node, record] of records) {
    if (record.entry.reachable) continue;

    // D47 (decoratorArgument): the framework that reads the decorator calls it.
    if (record.entry.kind === "decorator-argument") {
      const { decorator, className, at } = record.entry;
      const field = /^\w+/.exec(at)?.[0];
      const nest = decorator === "Module" && field ? ` (Nest keeps each @Module field as class metadata under its name: Reflect.getMetadata("${field}", ${className}))` : "";
      record.via = {
        kind: "trigger",
        trigger: "decorator-metadata",
        how: `whatever reads @${decorator}(...) on ${className} calls ${at} - no import or instance calls it, so drive it with an invoke.build that takes it from where the decorator left it${nest}`,
        ...decoratorMetadataBuild({ decorator, className, at, module: record.entry.module, nest: importsNestDecorator(node, decorator) }),
      };
      continue;
    }

    if (record.entry.kind === "nested" || record.entry.kind === "call-argument") {
      const driver = firstReachableAncestor(node);
      if (driver) {
        record.via = { kind: "through-caller", driver: driver.id, confidence: "certain" };
        continue;
      }
      // No reachable ancestor. Either an unreachable one encloses it — in which
      // case the chain continues through THAT function — or nothing does, and it
      // runs when the module is imported.
      const encloser = node.getAncestors().find((a) => isFunctionLike(a) && byNode.has(a));
      record.via = encloser
        ? { kind: "chain", hop: byNode.get(encloser).id }
        : { kind: "at-import", note: "no enclosing function — runs when the module is imported" };
      continue;
    }

    if (record.entry.kind === "module-private") {
      // A function CALLED WHERE IT IS WRITTEN, as an exported binding's
      // initializer: `export const N = ((): number => { ... })()`. It runs
      // once, when the module is imported, and N holds what it returned. The
      // declaration lookup below found N and listed N's references as drivers:
      // N's own name (`export N`) and every function that READS N, none of
      // which runs it. The recorder then called N["<anonymous>"] and the row
      // died "entry did not resolve to a function" (email-centralization-ms,
      // GMAIL_READ_CONCURRENCY, September 2026). Importing the module is the
      // only driver, and the recorder drives it so (immediatelyInvoked).
      const invokedBy = invokedWhereWritten(node);
      const binding = invokedBy && initializerOf(invokedBy, SyntaxKind.VariableDeclaration);
      if (binding && isExportedStatement(binding) && !node.getAncestors().some(isFunctionLike)) {
        const key = `export ${binding.getName()}`;
        record.via = { kind: "through-reference", drivers: [key], confidence: "certain", immediatelyInvoked: [key] };
        continue;
      }
      const decl = Node.isFunctionDeclaration(node)
        ? node
        : node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const drivers = referencingDrivers(
        Node.isFunctionDeclaration(decl) ? decl.getNameNode() : decl?.getNameNode()
      );
      if (drivers.length) {
        const held = {};
        const calledOnly = [];
        const wrapped = {};
        // D43: the function is not `decl`'s value but sits inside an argument
        // of a call its initializer makes (wrappingCall), so what `decl` - and
        // every binding holding `decl` - holds is that call's result.
        const enclosedIn = !Node.isFunctionDeclaration(node) && decl ? wrappingCall(node, decl) : null;
        for (const [key, use] of bindingUse) {
          if (enclosedIn) wrapped[key] = { binding: decl.getName(), call: enclosedIn };
          else if (use.wrapped) wrapped[key] = use.wrapped;
          else if (use.held) held[key] = use.held;
          else if (use.called) calledOnly.push(key);
        }
        if (enclosedIn && isExportedStatement(decl)) wrapped[`export ${decl.getName()}`] ??= { binding: decl.getName(), call: enclosedIn };
        record.via = {
          kind: "through-reference",
          drivers,
          confidence: drivers.length === 1 ? "certain" : "ambiguous",
          ...(Object.keys(held).length ? { held } : {}),
          ...(calledOnly.length ? { calledAtImport: calledOnly } : {}),
          ...(Object.keys(wrapped).length ? { wrapped } : {}),
        };
      } else {
        const hops = referencingRecords(
          Node.isFunctionDeclaration(decl) ? decl.getNameNode() : decl?.getNameNode()
        );
        record.via = hops.length
          ? { kind: "chain", hop: hops[0], hops }
          : { kind: "unresolved", note: "nothing in this file references it" };
      }
      continue;
    }

    // class-method / class-static.
    //
    // A PRIVATE member on an exported class is not a seam problem: the scan's own
    // entry already says "drive it through the public method that calls it", so
    // resolve it by the MEMBER name. Searching the class name only finds holders
    // of the class, which is the wrong question for a private member.
    const classDecl = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const memberName = typeof node.getNameNode === "function" ? node.getNameNode() : undefined;

    // Order matters. A PRIVATE member has to be driven through the public method
    // that calls it, so member-callers win. A PUBLIC member on an unexported
    // class is directly callable on whatever exported binding holds the
    // instance — `redisCache.connect()` — and that is a far cheaper driver than
    // whichever production caller happens to call it first.
    const preferMember = record.entry.private === true;
    const memberDrivers = referencingDrivers(memberName);
    const holderDrivers = referencingDrivers(classDecl?.getNameNode());
    const ordered = preferMember
      ? [["through-member", memberDrivers], ["through-class-holder", holderDrivers]]
      : [["through-class-holder", holderDrivers], ["through-member", memberDrivers]];

    let placed = false;
    for (const [kind, drivers] of ordered) {
      if (!drivers.length) continue;
      record.via = { kind, drivers, confidence: drivers.length === 1 ? "certain" : "ambiguous" };
      placed = true;
      break;
    }
    if (placed) continue;

    // No reachable holder or caller yet — hand it to the chain pass, which can
    // reach a public method two or more hops out.
    const memberHops = referencingRecords(memberName);
    const classHops = referencingRecords(classDecl?.getNameNode());
    const hops = [...memberHops, ...classHops].filter((id) => id !== record.id);
    record.via = hops.length
      ? { kind: "chain", hop: hops[0], hops }
      : { kind: "needs-seam", note: "nothing references the member or the class — needs a test seam" };
  }

  // Second pass, iterated to a FIXPOINT. A single pass gives up when the next
  // hop is itself unresolved — but `verifyServiceKey -> routeMiddleware -> start`
  // needs two, and giving up early reports real work as unreachable.
  const byId = new Map(records.map(([, record]) => [record.id, record]));

  // D58: EVERY HOP, NOT THE FIRST ONE. sourcing-ms, the mocked run of September
  // 26 (`20260926T203755Z`): `parseExplainTree` in search-debug.service.ts is
  // module-private and RECURSIVE, so the references to it are its own
  // recursive calls (lines 410-448) and one call inside `execute`'s
  // `hits.map(...)` callback (line 532), which already resolves through-caller
  // to `SearchDebugService.execute`. `referencingRecords` returned both, the
  // recursive one first, and this walk followed only `hop` - hops[0], the
  // function itself - so the cycle check stopped it before its first step.
  // Every function whose only way in was parseExplainTree inherited the dead
  // end: 16 records in that file came out "chain from ... did not reach a
  // callable function", among them getWinningFieldAndTerm, whose `#109` else
  // was asked twice, contracted `call.driver: null`, and declared needs-seam
  // by both answers although GET /:searchId/debug runs it.
  //
  // So the walk is DEPTH-FIRST OVER ALL of `hops`, in their own order. The
  // leftmost path is exactly the one the single-hop walk followed, and it is
  // tried in full before any other, so a chain that resolved before resolves
  // to the same driver and the same path; only a chain whose leftmost path
  // dead-ends goes on to the next hop. The limits are the old ones: nothing is
  // visited twice (which also bounds the walk by the number of records), and a
  // hop that is not a record, or a record with no via, ends that branch rather
  // than the walk. An explicit stack rather than recursion, because a chain can
  // be as long as the file has functions (ptp-ms holds 6,948).
  const hopsOf = (via) => (via.hops?.length ? via.hops : [via.hop]).filter(Boolean);

  const forward = (record) => {
    const v = record.via;
    if (v?.kind !== "chain") return false;

    const seen = new Set([record.id]);
    const ends = new Map();
    const stack = hopsOf(v)
      .reverse()
      .map((hop) => [hop, []]);

    while (stack.length) {
      const [cursor, before] = stack.pop();
      if (cursor === record.id) ends.set(cursor, "a recursive call of its own - no caller outside it on this branch");
      if (seen.has(cursor)) continue;
      seen.add(cursor);
      const path = [...before, cursor];
      const next = byId.get(cursor);
      if (!next) {
        ends.set(cursor, "not a function the scan collected");
        continue;
      }

      if (next.entry.reachable) {
        record.via = { kind: "through-chain", driver: cursor, path, confidence: "certain" };
        return true;
      }
      const nv = next.via;
      if (!nv) {
        ends.set(cursor, "has no via of its own");
        continue;
      }
      if (nv.kind === "through-caller" || nv.kind === "through-chain") {
        record.via = { kind: "through-chain", driver: nv.driver, path: [...path, nv.driver], confidence: "certain" };
        return true;
      }
      if (nv.kind === "through-member" || nv.kind === "through-reference" || nv.kind === "through-class-holder") {
        record.via = { kind: "through-chain", driver: nv.drivers[0], path: [...path, nv.drivers[0]], confidence: nv.confidence };
        return true;
      }
      if (nv.kind === "at-import" || nv.kind === "trigger") {
        record.via = { ...nv, note: `${nv.note ?? nv.kind} — reached via ${cursor}` };
        return true;
      }
      if (nv.kind !== "chain") {
        ends.set(cursor, nv.note ?? nv.kind);
        continue;
      }
      for (const hop of hopsOf(nv).reverse()) stack.push([hop, path]);
    }
    // Where the walk stopped, for the unresolved note below - the static call
    // graph's own last word on this record, rather than a verdict about it.
    record.via.ends = [...ends].map(([id, why]) => ({ id, why }));
    return false;
  };

  const settle = () => {
    for (let round = 0; round < records.length; round += 1) {
      let moved = false;
      for (const [, record] of records) {
        if (forward(record)) moved = true;
      }
      if (!moved) break;
    }
  };

  // 1. Name the trigger for anything a framework invokes, BEFORE any chain
  //    forwarding. Order is load-bearing and cost me two wrong guesses: if the
  //    settle runs first it forwards the formatter's raw `at-import` onto
  //    getTraceId, which then looks like a module-import record in its own right
  //    and gets re-triggered from its own node. Trigger the ends first, then
  //    let the chains inherit.
  //
  //    Records whose via is a `chain` are skipped: they have a hop, so their
  //    answer belongs to whatever that hop resolves to.
  for (const [node, record] of records) {
    if (record.entry.reachable) continue;
    const kind = record.via?.kind;
    if (kind !== "unresolved" && kind !== "at-import" && kind !== "needs-seam") continue;
    const trigger = resolveTrigger(node);
    if (trigger) record.via = { kind: "trigger", ...trigger };
  }

  // 2. Settle every chain — onto a callable function or onto an inherited trigger.
  settle();

  // D58: AN UNRESOLVED CHAIN SAYS WHERE IT STOPPED AND WHAT IS CALLABLE NEARBY.
  // The note alone read as a verdict - "did not reach a callable function" -
  // and derive contracted it as `call.driver: null`, which an answering agent
  // took to mean nothing can call the function and declared needs-seam, twice,
  // on a side GET /:searchId/debug runs. It is the static call graph's limit,
  // not a fact about the code, so the record now carries what the walk saw:
  // `ends`, each place a branch stopped and its own reason, and `nearby`, the
  // callable functions of the same module - the public entries a reader checks
  // first. `nearby` is a suggestion and is said to be one: nothing the scan
  // found connects them, so validate.mjs still accepts any `via` here (it only
  // matches a declared via against drivers the scan resolved).
  const NEARBY_CAP = 8;
  for (const [, record] of records) {
    if (record.via?.kind === "chain") {
      const { hop, ends = [] } = record.via;
      record.via = {
        kind: "unresolved",
        note: `chain from ${hop} did not reach a callable function`,
        ...(ends.length ? { ends } : {}),
      };
    }
    if (record.via?.kind !== "unresolved") continue;
    const nearby = records
      .map(([, r]) => r)
      .filter((r) => r.file === record.file && r.entry.reachable && r.id !== record.id)
      .map((r) => r.id);
    if (!nearby.length) continue;
    record.via.nearby = nearby.slice(0, NEARBY_CAP);
    if (nearby.length > NEARBY_CAP) record.via.nearbyTruncated = nearby.length;
  }
}

/**
 * What invokes this, when our own code never calls it. Express invokes a route
 * handler, winston invokes a formatter, Zod invokes a refinement — none of which
 * is a call reference, so no call-graph pass can find them. Naming the trigger
 * turns "unresolved" into a work item with an actual instruction.
 */
function resolveTrigger(node) {
  const parent = node.getParent();
  if (!parent || !(Node.isCallExpression(parent) || Node.isNewExpression(parent))) {
    return node.getAncestors().some(isFunctionLike)
      ? undefined
      : { trigger: "module-import", how: "runs when the module is imported" };
  }

  const callee = parent.getExpression().getText();
  const firstArg = parent.getArguments()[0];
  const literal =
    firstArg && firstArg !== node && Node.isStringLiteral(firstArg) ? firstArg.getLiteralValue() : undefined;

  if (/^(router|app)\.(get|post|put|patch|delete|use|all|options|head)$/.test(callee)) {
    return {
      trigger: "http-request",
      how: literal
        ? `an HTTP request matching ${callee.split(".")[1].toUpperCase()} ${literal}`
        : `an HTTP request through ${callee}`,
    };
  }
  if (/winston\.format|^format$|\.printf$/.test(callee)) {
    return { trigger: "log-call", how: "any log written through this logger — winston invokes the formatter per record" };
  }
  if (/^z\.|\.(refine|superRefine|transform|preprocess)$/.test(callee)) {
    return { trigger: "schema-parse", how: "parsing a payload with this schema — Zod invokes the refinement" };
  }
  if (/^process\.on$/.test(callee)) {
    return { trigger: "process-signal", how: `emitting ${literal ?? "the registered signal"} on the process` };
  }
  if (/^set(Timeout|Interval)$/.test(callee)) {
    return { trigger: "timer", how: `the ${callee} firing — advance timers rather than waiting` };
  }
  if (/\.on$/.test(callee)) {
    return { trigger: "event", how: `emitting "${literal ?? "?"}" on ${callee.replace(/\.on$/, "")}` };
  }
  if (/\.(then|catch|finally)$/.test(callee)) {
    return undefined; // settled by the promise its caller already drives
  }
  return { trigger: "callback-argument", how: `invoked by ${callee} when it runs` };
}

/**
 * The AST arm model is a model. This checks it against the denominator istanbul
 * actually produced in stage 1 — a large drift means the model is wrong and any
 * per-arm work list built on it is wrong too.
 */
function reconcile(perFileCounts, istanbulField) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_JSON, "utf8"));
  } catch {
    return { available: false, note: "run baseline.mjs first to get the istanbul denominator" };
  }

  const istanbulPerFile = baseline.coverage?.perFile ?? {};
  const files = new Set([...Object.keys(perFileCounts), ...Object.keys(istanbulPerFile)]);

  const diffs = [];
  let ast = 0;
  let ist = 0;
  for (const file of [...files].sort()) {
    const a = perFileCounts[file] ?? 0;
    const i = istanbulPerFile[file]?.[istanbulField] ?? 0;
    ast += a;
    ist += i;
    if (a !== i) diffs.push({ file, ast: a, istanbul: i, delta: a - i });
  }

  return {
    available: true,
    astTotal: ast,
    istanbulTotal: ist,
    delta: ast - ist,
    matchPct: ist === 0 ? 0 : Number(((1 - Math.abs(ast - ist) / ist) * 100).toFixed(1)),
    filesWithDrift: diffs,
  };
}

function report(scan) {
  const t = scan.totals;
  const r = scan.reconcile.arms;
  const rf = scan.reconcile.functions;
  const lines = [
    "",
    `✓ scan written → ${SCAN_JSON.replace(`${REPO_ROOT}/`, "")}`,
    `    files              ${t.files}`,
    `    functions          ${t.functions}`,
    `    with own entry     ${t.withOwnEntry} (${t.pctWithOwnEntry}%)  ← stage-4 work list`,
    `    no own entry       ${t.withoutOwnEntry}                ← reachable only through a caller`,
    `    arms (istanbul)    ${t.armsIstanbul}, of which ${t.armsBehindOwnEntry} sit behind an own entry`,
    `    arms (ast, +catch) ${t.armsAst}`,
    `    arms at module scope ${t.armsAtModuleScope}   ← run at import time, no owning function`,
    "",
    "  entry kinds:",
    ...Object.entries(scan.byEntryKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `    ${String(n).padStart(4)}  ${k}`),
  ];

  if (!r.available) {
    lines.push("", `  reconcile: ${r.note}`);
  } else {
    lines.push("", "  reconcile vs the istanbul denominator recorded in stage 1:");
    for (const [label, x] of [["arms     ", r], ["functions", rf]]) {
      lines.push(
        `    ${label}  ast ${x.astTotal} vs istanbul ${x.istanbulTotal} — ${x.matchPct}% match, ${x.filesWithDrift.length} files drift`
      );
      for (const d of x.filesWithDrift.slice(0, 8)) {
        lines.push(`        ${d.delta > 0 ? "+" : ""}${d.delta}  ${d.file} (ast ${d.ast}, istanbul ${d.istanbul})`);
      }
      if (x.filesWithDrift.length > 8) lines.push(`        … ${x.filesWithDrift.length - 8} more`);
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
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