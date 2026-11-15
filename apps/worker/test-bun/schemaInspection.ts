import type { Database } from "bun:sqlite";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const sorted = <T>(values: T[]) =>
  values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const normalizeSql = (sql: string) =>
  sql.replace(/'(?:''|[^'])*'|[^']+/g, (token) =>
    token.startsWith("'")
      ? token
      : token
          .replace(/["`\[\]]/g, "")
          .replace(/\s+/g, "")
          .toLowerCase(),
  );

export function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);
}

function tableSql(db: Database, name: string): string {
  return db
    .query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(name)!.sql;
}

// 式内の括弧と文字列を追い、CHECKの外側だけを取り除きます。
function checks(sql: string): string[] {
  return sorted(
    [...sql.matchAll(/\bCHECK\s*\(/gi)].map((match) => {
      const start = match.index! + match[0].length;
      let end = start;
      let depth = 1;
      let quoted = false;
      while (depth > 0 && end < sql.length) {
        const char = sql[end++];
        if (char === "'") {
          if (quoted && sql[end] === "'") end++;
          else quoted = !quoted;
        } else if (!quoted) {
          if (char === "(") depth++;
          if (char === ")") depth--;
        }
      }
      if (depth !== 0) throw new Error("CHECKの括弧が閉じていません");
      return normalizeSql(sql.slice(start, end - 1));
    }),
  );
}

type Index = { name: string; unique: number; origin: string; partial: number };
type TableColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type IndexColumn = { seqno: number; cid: number; name: string | null };
type ExtendedIndexColumn = IndexColumn & { desc: number; coll: string; key: number };
type ForeignKey = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
};

export function inspectTable(db: Database, table: string, uniqueNames = new Set<string>()) {
  const sql = tableSql(db, table);
  const indexes = db.query<Index, []>(`PRAGMA index_list(${quote(table)})`).all();
  const columns = db.query<TableColumn, []>(`PRAGMA table_info(${quote(table)})`).all();
  const primaryKeyColumns = columns.filter(({ pk }) => pk > 0);
  const rowidColumn =
    primaryKeyColumns.length === 1 && !indexes.some(({ origin }) => origin === "pk")
      ? primaryKeyColumns.find(({ type }) => type.toUpperCase() === "INTEGER")
      : undefined;
  const foreignKeys = db.query<ForeignKey, []>(`PRAGMA foreign_key_list(${quote(table)})`).all();
  return {
    // INTEGER PRIMARY KEYはrowidの別名でNULLを保持しないため、notnullの差を無視します。
    columns: columns.map((column) => (column === rowidColumn ? { ...column, notnull: 1 } : column)),
    indexes: sorted(
      indexes.map(({ name, unique, origin, partial }) => {
        const info = db.query<IndexColumn, []>(`PRAGMA index_info(${quote(name)})`).all();
        const extended = db
          .query<ExtendedIndexColumn, []>(`PRAGMA index_xinfo(${quote(name)})`)
          .all()
          .filter(({ key }) => key === 1);
        // 自動索引名の末尾番号と、制約からKitが作った索引名は比較対象から除きます。
        const kind = uniqueNames.has(name) ? "u" : origin;
        return {
          name: kind === "c" ? name : null,
          kind,
          unique,
          partial,
          info,
          extended,
          expression: info.some(({ cid }) => cid === -2)
            ? normalizeSql(tableSql(db, name).slice(tableSql(db, name).indexOf("(")))
            : null,
        };
      }),
    ),
    foreignKeys: sorted(
      [...new Set(foreignKeys.map(({ id }) => id))].map((id) =>
        foreignKeys.filter((fk) => fk.id === id).map(({ id: _id, ...fk }) => fk),
      ),
    ),
    checks: checks(sql),
    autoIncrement: /\bAUTOINCREMENT\b/i.test(sql),
  };
}
