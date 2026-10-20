// Better AuthのISO日時と、移行・既存データのUNIXミリ秒を同じ値で扱う。
export function accountCreatedAtMsSql(column: "createdAt" | "u.createdAt") {
  return `CASE WHEN typeof(${column}) IN ('integer', 'real') THEN CAST(${column} AS INTEGER)
    ELSE CAST(ROUND(unixepoch(${column}, 'subsec') * 1000) AS INTEGER) END`;
}

export function accountRegisteredAtMsSql() {
  return `COALESCE(u.guestRegisteredAt,${accountCreatedAtMsSql("u.createdAt")})`;
}
