export function accountCreatedAtMsSql(column: "createdAt" | "u.createdAt") {
  return `CAST(ROUND(unixepoch(${column}, 'subsec') * 1000) AS INTEGER)`;
}

export function accountRegisteredAtMsSql() {
  return `COALESCE(u.guestRegisteredAt,${accountCreatedAtMsSql("u.createdAt")})`;
}
