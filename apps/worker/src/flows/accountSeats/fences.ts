import { prepareFenceAbort } from "../../db/fenceAbort";

type FenceCode =
  | "matchmaking_waiting"
  | "tournament_waiting"
  | "account_busy"
  | "account_seated"
  | "account_deleted";
type SqlFragment = { sql: string; values: (string | number | null)[] };
type Fence = readonly [FenceCode, SqlFragment[]];
type AccountColumn = "user.id" | "u.id";

export function guestMerged(account: AccountColumn | "?") {
  return `EXISTS(SELECT 1 FROM guest_account_merges WHERE guest_id=${account})`;
}

function seatWaitFences(account: SqlFragment, operationId: string): Fence[] {
  return (
    [
      ["matchmaking_waiting", "matchmaking_wait_reservations"],
      ["tournament_waiting", "tournament_wait_reservations"],
    ] as const
  ).map(([code, table]) => [
    code,
    [
      {
        sql: `EXISTS(SELECT 1 FROM ${table} w WHERE w.account_id=${account.sql} AND (w.match_operation_id IS NULL OR w.match_operation_id != ?))`,
        values: [...account.values, operationId],
      },
    ],
  ]);
}

function accountExists(table: string, column: string, accountId: string): SqlFragment {
  return {
    sql: `EXISTS(SELECT 1 FROM ${table} WHERE ${column}=?)`,
    values: [accountId],
  };
}

function matchmakingWaitFences(accountId: string): Fence[] {
  return [
    [
      "account_busy",
      [
        accountExists("account_room_seats", "account_id", accountId),
        accountExists("tournament_wait_reservations", "account_id", accountId),
      ],
    ],
    [
      "account_deleted",
      [
        accountExists("deleted_accounts", "id", accountId),
        accountExists("guest_account_merges", "guest_id", accountId),
      ],
    ],
  ];
}

function tournamentWaitFences(accountId: string): Fence[] {
  return [
    [
      "matchmaking_waiting",
      [accountExists("matchmaking_wait_reservations", "account_id", accountId)],
    ],
    ["account_seated", [accountExists("account_room_seats", "account_id", accountId)]],
    ["account_deleted", [accountExists("deleted_accounts", "id", accountId)]],
  ];
}

function condition(fences: Fence[]): SqlFragment {
  const clauses = fences.flatMap(([, clauses]) => clauses);
  return {
    sql: clauses.map(({ sql }) => `NOT ${sql}`).join(" AND "),
    values: clauses.flatMap(({ values }) => values),
  };
}

// 列で表せるアカウントIDはbindせず、操作IDだけを出現順に返します。
export function seatFence(account: AccountColumn, operationId: string) {
  const wait = condition(seatWaitFences({ sql: account, values: [] }, operationId));
  return { sql: `${wait.sql} AND NOT ${guestMerged(account)}`, values: wait.values };
}

export function prepareSeatMergedAbort(
  db: D1Database,
  account: AccountColumn,
  operationId: string,
  candidate: SqlFragment,
) {
  const wait = condition(seatWaitFences({ sql: account, values: [] }, operationId));
  return prepareFenceAbort(db, {
    when: `changes()=0 AND EXISTS(SELECT 1 ${candidate.sql} AND ${wait.sql} AND ${guestMerged(account)})`,
    values: [...candidate.values, ...wait.values],
    code: "guest_merged",
  });
}
export const matchmakingWaitFence = (accountId: string) =>
  condition(matchmakingWaitFences(accountId));
export function tournamentWaitFence(accountId: string) {
  const wait = condition(tournamentWaitFences(accountId));
  return { sql: `${wait.sql} AND NOT ${guestMerged("?")}`, values: [...wait.values, accountId] };
}

export function prepareTournamentWaitMergedAbort(db: D1Database, accountId: string) {
  const wait = condition(tournamentWaitFences(accountId));
  return prepareFenceAbort(db, {
    when: `changes()=0 AND ${wait.sql} AND ${guestMerged("?")}`,
    values: [...wait.values, accountId],
    code: "guest_merged",
  });
}

function prepareFence(db: D1Database, fences: Fence[]) {
  return db
    .prepare(
      `SELECT CASE ${fences.map(([code, clauses]) => `WHEN ${clauses.map(({ sql }) => sql).join(" OR ")} THEN '${code}'`).join(" ")} END AS code`,
    )
    .bind(...fences.flatMap(([, clauses]) => clauses.flatMap(({ values }) => values)));
}

async function readFence(db: D1Database, fences: Fence[]) {
  const row = await prepareFence(db, fences).first<{ code: FenceCode | null }>();
  return row?.code ?? null;
}

export const readSeatFence = (db: D1Database, accountId: string, operationId: string) =>
  readFence(db, seatWaitFences({ sql: "?", values: [accountId] }, operationId));
export const readMatchmakingWaitFence = (db: D1Database, accountId: string) =>
  readFence(db, matchmakingWaitFences(accountId));
export const readTournamentWaitFence = (db: D1Database, accountId: string) =>
  readFence(db, tournamentWaitFences(accountId));

export const prepareMatchmakingWaitFence = (db: D1Database, accountId: string) =>
  prepareFence(db, matchmakingWaitFences(accountId));
export const prepareTournamentWaitFence = (db: D1Database, accountId: string) =>
  prepareFence(db, tournamentWaitFences(accountId));

export const prepareSeatWaitFence = (db: D1Database, accountId: string, operationId: string) =>
  prepareFence(db, seatWaitFences({ sql: "?", values: [accountId] }, operationId));
