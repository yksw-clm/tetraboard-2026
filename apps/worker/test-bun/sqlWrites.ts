// Worker の SQL リテラルと、その場で読める定数・条件付き断片を走査します。
// 動的な表名や、関数が組み立てる SQL の中身は検査しません。
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

type SqlToken = string | ts.Expression;
type WriteOperation = "INSERT" | "UPDATE";
type SqlNode = ts.StringLiteralLike | ts.TemplateExpression;

type SqlWrite = {
  file: string;
  operation: WriteOperation;
  table: string;
  sql: string;
  node: SqlNode;
  scope: ts.Node;
  source: ts.SourceFile;
  tokens: SqlToken[];
};

const sqlToken =
  /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|('(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[\w$]+|[^\s])/g;

function tokenize(parts: SqlToken[]): SqlToken[] {
  return parts.flatMap<SqlToken>((part) =>
    typeof part === "string"
      ? [...part.matchAll(sqlToken)].flatMap(([, token]) => (token ? [token] : []))
      : [part],
  );
}

const keyword = (token: SqlToken | undefined) =>
  typeof token === "string" ? token.toUpperCase() : "";

function identifier(token: SqlToken | undefined) {
  if (typeof token !== "string") return;
  if (token.startsWith("[")) return token.slice(1, -1).toLowerCase();
  if (/^['"`]/.test(token))
    return token
      .slice(1, -1)
      .replace(/(['"`])\1/g, "$1")
      .toLowerCase();
  if (/^[\w$]+$/.test(token)) return token.toLowerCase();
}

function writeTarget(tokens: SqlToken[], start: number) {
  const verb = keyword(tokens[start]);
  if (verb !== "INSERT" && verb !== "REPLACE" && verb !== "UPDATE") return;
  let index = start + 1;
  if (keyword(tokens[index]) === "OR") index += 2;
  if (verb !== "UPDATE") {
    if (keyword(tokens[index]) !== "INTO") return;
    index++;
  } else if (keyword(tokens[index]) === "SET") return;

  let table = identifier(tokens[index]);
  if (table && tokens[index + 1] === ".") table = identifier(tokens[index + 2]);
  if (!table) return;
  const operation: WriteOperation = verb === "UPDATE" ? "UPDATE" : "INSERT";
  return { table, operation };
}

// TypeScript のエスケープを解いた文字列を使い、補間は SQL の字句と区別します。
function sqlParts(node: SqlNode): SqlToken[] {
  return ts.isTemplateExpression(node)
    ? [
        node.head.text,
        ...node.templateSpans.flatMap(({ expression, literal }) => [expression, literal.text]),
      ]
    : [node.text];
}

function tokenText(token: SqlToken, source: ts.SourceFile) {
  return typeof token === "string" ? token : "${" + token.getText(source) + "}";
}

function writesInLiteral(node: SqlNode, scope: ts.Node, source: ts.SourceFile): SqlWrite[] {
  const parts = sqlParts(node);
  const sql = parts
    .map((part) => tokenText(part, source))
    .join("")
    .replace(/\s+/g, " ");
  const tokens = tokenize(parts);
  return tokens.flatMap((_, index) => {
    const target = writeTarget(tokens, index);
    if (!target) return [];
    const end = tokens.indexOf(";", index);
    return [
      {
        ...target,
        file: source.fileName,
        sql,
        node,
        scope,
        source,
        tokens: tokens.slice(index, end === -1 ? undefined : end),
      },
    ];
  });
}

export function findSqlWrites(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const writes: SqlWrite[] = [];
  function visit(node: ts.Node, scope: ts.Node) {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) scope = node;
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node))
      writes.push(...writesInLiteral(node, scope, source));
    ts.forEachChild(node, (child) => visit(child, scope));
  }
  visit(source, source);
  return writes;
}

const root = new URL("../src/", import.meta.url);
export const workerSqlWrites = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .flatMap((file) => findSqlWrites(file, readFileSync(new URL(file, root), "utf8")));

function nextTopLevel(tokens: SqlToken[], start: number, stop: (index: number) => boolean) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (depth === 0 && stop(i)) return i;
    if (tokens[i] === "(") depth++;
    if (tokens[i] === ")") depth--;
  }
  return tokens.length;
}

const compoundSelectOperators = ["UNION", "INTERSECT", "EXCEPT"];

function endsWhere(tokens: SqlToken[], i: number) {
  return (
    ["GROUP", "HAVING", "ORDER", "LIMIT", "RETURNING", ...compoundSelectOperators].includes(
      keyword(tokens[i]),
    ) ||
    (keyword(tokens[i]) === "ON" && keyword(tokens[i + 1]) === "CONFLICT")
  );
}

function whereClause(tokens: SqlToken[], start = 0) {
  const where = nextTopLevel(
    tokens,
    start,
    (i) => keyword(tokens[i]) === "WHERE" || endsWhere(tokens, i),
  );
  return keyword(tokens[where]) === "WHERE"
    ? tokens.slice(
        where + 1,
        nextTopLevel(tokens, where + 1, (i) => endsWhere(tokens, i)),
      )
    : [];
}

function updateClause(tokens: SqlToken[], set: number) {
  const columns: string[] = [];
  let start = set + 1;
  while (start < tokens.length) {
    const equals = tokens.indexOf("=", start);
    const target = tokens.slice(start, equals);
    const names =
      target[0] === "(" && target.at(-1) === ")"
        ? target.slice(1, -1).filter((token) => token !== ",")
        : target;
    if (equals < 0 || names.length === 0 || names.some((token) => !identifier(token)))
      throw new Error("UPDATE の代入先を静的に確認できません");
    columns.push(...names.map((token) => identifier(token)!));
    start = nextTopLevel(
      tokens,
      equals + 1,
      (i) =>
        tokens[i] === "," || ["WHERE", "FROM"].includes(keyword(tokens[i])) || endsWhere(tokens, i),
    );
    if (tokens[start] !== ",") break;
    start++;
  }
  return { columns, where: whereClause(tokens, start) };
}

export function updateClauses(write: SqlWrite) {
  const { tokens } = write;
  if (write.operation === "UPDATE")
    return [
      updateClause(
        tokens,
        tokens.findIndex((token) => keyword(token) === "SET"),
      ),
    ];

  return tokens.flatMap((token, i) =>
    keyword(token) === "DO" &&
    keyword(tokens[i + 1]) === "UPDATE" &&
    keyword(tokens[i + 2]) === "SET"
      ? [updateClause(tokens, i + 2)]
      : [],
  );
}

function withoutOuterParens(term: SqlToken[]) {
  while (term[0] === "(" && nextTopLevel(term, 1, (i) => term[i] === ")") === term.length - 1)
    term = term.slice(1, -1);
  return term;
}

function whereAndTerms(where: SqlToken[]) {
  if (where.length === 0) return null;
  const terms: SqlToken[][] = [];
  for (let start = 0; start < where.length;) {
    const end = nextTopLevel(where, start, (i) => ["AND", "OR"].includes(keyword(where[i])));
    if (keyword(where[end]) === "OR") return null;
    terms.push(withoutOuterParens(where.slice(start, end)));
    start = end + 1;
  }
  return terms;
}

export function hasSqlCondition(where: SqlToken[], helper: string) {
  return (
    whereAndTerms(where)?.some(
      ([expression, ...rest]) =>
        expression !== undefined &&
        rest.length === 0 &&
        typeof expression !== "string" &&
        ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === helper,
    ) ?? false
  );
}

function localInitializer(expression: ts.Expression, scope: ts.Node) {
  const property = ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
  const variable = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
  if (
    !ts.isIdentifier(variable) ||
    !(ts.isFunctionDeclaration(scope) || ts.isMethodDeclaration(scope))
  )
    return expression;

  for (const statement of scope.body?.statements ?? []) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    const declaration = statement.declarationList.declarations.find(
      ({ name }) => ts.isIdentifier(name) && name.text === variable.text,
    );
    const initializer = declaration?.initializer;
    if (!initializer) continue;
    if (!property) return initializer;
    if (ts.isObjectLiteralExpression(initializer)) {
      const member = initializer.properties.find(
        (item) =>
          ts.isPropertyAssignment(item) &&
          ts.isIdentifier(item.name) &&
          item.name.text === property,
      );
      if (member && ts.isPropertyAssignment(member)) return member.initializer;
    }
    break;
  }
  return expression;
}

// WHERE を含むローカルの定数を開き、条件付き断片はどちらの形でも検査します。
function sqlVariants({ tokens, scope }: SqlWrite) {
  return tokens.reduce<SqlToken[][]>(
    (prefixes, token) => {
      const fragment = typeof token === "string" ? token : localInitializer(token, scope);
      const alternatives =
        typeof fragment !== "string" && ts.isConditionalExpression(fragment)
          ? [fragment.whenTrue, fragment.whenFalse]
          : [fragment];
      const suffixes = alternatives.map((part) =>
        typeof part !== "string" && (ts.isStringLiteralLike(part) || ts.isTemplateExpression(part))
          ? tokenize(sqlParts(part))
          : [part],
      );
      return prefixes.flatMap((prefix) => suffixes.map((suffix) => [...prefix, ...suffix]));
    },
    [[]],
  );
}

export function hasRequiredWhereTerms(write: SqlWrite, ...required: string[]) {
  return sqlVariants(write).every((tokens) => {
    const compound = (i: number) => compoundSelectOperators.includes(keyword(tokens[i]));
    if (write.operation === "INSERT" && nextTopLevel(tokens, 0, compound) < tokens.length)
      return false;
    const terms = whereAndTerms(whereClause(tokens));
    if (!terms) return false;
    const texts = terms.map((term) =>
      term.map((token) => tokenText(token, write.source)).join(" "),
    );
    return required.every((term) => texts.includes(term));
  });
}
