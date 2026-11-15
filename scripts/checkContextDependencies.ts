import { readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "..");
const shared = "@tetraboard/context-shared";
const protocol = "@tetraboard/protocol";
const allowedDependencies = new Set([
  shared,
  protocol,
  "@tetraboard/game-contract",
  "@tetraboard/reversi",
  "@tetraboard/four-reversi",
  "@tetraboard/gomoku",
  "@tetraboard/four-gomoku",
  "@tetraboard/shogi",
  "@tetraboard/four-shogi",
]);
const forbiddenPackages = new Set(["zod", "drizzle-orm", "hono", "better-auth"]);

export interface Diagnostic {
  file: string;
  line: number;
  reason: string;
}

interface Context {
  directory: string;
  name: string;
}

interface ModuleReference {
  node: ts.Node;
  specifier: ts.Node | undefined;
  typeOnly: boolean;
}

function diagnostic(source: ts.SourceFile, node: ts.Node, reason: string): Diagnostic {
  return {
    file: source.fileName,
    line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    reason,
  };
}

function checkManifest(context: Context, text: string): Diagnostic[] {
  const source = ts.parseJsonText(resolve(context.directory, "package.json"), text);
  const object = source.statements[0]?.expression;
  if (!object || !ts.isObjectLiteralExpression(object)) return [];
  const diagnostics: Diagnostic[] = [];
  for (const field of object.properties) {
    if (!ts.isPropertyAssignment(field) || !ts.isStringLiteral(field.name)) continue;
    const group = field.name.text;
    if (!["dependencies", "devDependencies"].includes(group)) continue;
    if (!ts.isObjectLiteralExpression(field.initializer)) continue;
    for (const dependency of field.initializer.properties) {
      if (!ts.isPropertyAssignment(dependency) || !ts.isStringLiteral(dependency.name)) continue;
      const name = dependency.name.text;
      if (!name.startsWith("@tetraboard/")) continue;
      let reason: string | undefined;
      if (context.name === shared && name.startsWith("@tetraboard/context-"))
        reason = `${shared} は文脈に依存できません: ${name}`;
      else if (!allowedDependencies.has(name))
        reason = `${group} で許可されていない依存です: ${name}`;
      if (reason) diagnostics.push(diagnostic(source, dependency.name, reason));
    }
  }
  return diagnostics;
}

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    !!bindings &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function moduleReference(node: ts.Node): ModuleReference | undefined {
  if (ts.isImportDeclaration(node))
    return { node, specifier: node.moduleSpecifier, typeOnly: isTypeOnlyImport(node.importClause) };
  if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    const bindings = node.exportClause;
    const typeOnly =
      node.isTypeOnly ||
      (!!bindings &&
        ts.isNamedExports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly));
    return { node, specifier: node.moduleSpecifier, typeOnly };
  }
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    return { node, specifier: node.arguments[0], typeOnly: false };
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    return { node, specifier: node.moduleReference.expression, typeOnly: node.isTypeOnly };
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
    return { node, specifier: node.argument.literal, typeOnly: true };
}

function importViolation(
  context: Context,
  file: string,
  specifier: string,
  typeOnly: boolean,
): string | undefined {
  const packageName = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (specifier.startsWith("cloudflare:") || specifier.startsWith("@cloudflare/"))
    return `Cloudflare に依存できません: ${specifier}`;
  if (forbiddenPackages.has(packageName)) return `文脈で禁止された import です: ${specifier}`;
  if (
    packageName.startsWith("@tetraboard/context-") &&
    packageName !== context.name &&
    packageName !== shared
  )
    return `別の文脈を import できません: ${specifier}`;
  if (packageName === protocol && !typeOnly)
    return `protocol は import type だけを許可します: ${specifier}`;
  if (
    [".", ".."].includes(specifier) ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    const target = relative(context.directory, resolve(dirname(file), specifier));
    if (target === ".." || target.startsWith(`..${sep}`) || isAbsolute(target))
      return `パッケージの外への相対 import は禁止です: ${specifier}`;
  }
}

function checkSource(context: Context, file: string): Diagnostic[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const diagnostics: Diagnostic[] = [];
  function visit(node: ts.Node): void {
    const reference = moduleReference(node);
    if (reference) {
      const { specifier, typeOnly } = reference;
      const reason =
        specifier && ts.isStringLiteralLike(specifier)
          ? importViolation(context, file, specifier.text, typeOnly)
          : "import のパスは文字列リテラルにしてください（依存の向きを検査できません）。";
      if (reason) diagnostics.push(diagnostic(source, reference.node, reason));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return diagnostics;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

export function checkContextDependencies(repositoryRoot = root): Diagnostic[] {
  const directory = resolve(repositoryRoot, "packages/contexts");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const packageDirectory = resolve(directory, entry.name);
      const manifest = readFileSync(resolve(packageDirectory, "package.json"), "utf8");
      const context = {
        directory: packageDirectory,
        name: (JSON.parse(manifest) as { name: string }).name,
      };
      return [
        ...checkManifest(context, manifest),
        ...sourceFiles(resolve(packageDirectory, "src"))
          .sort()
          .flatMap((file) => checkSource(context, file)),
      ];
    });
}

if (import.meta.main) {
  const diagnostics = checkContextDependencies();
  for (const { file, line, reason } of diagnostics)
    console.error(`${relative(root, file)}:${line}: ${reason}`);
  if (diagnostics.length > 0) process.exitCode = 1;
  else console.log("文脈の依存の向きに違反はありません。");
}
