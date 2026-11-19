import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const migrations = new URL("../migrations/", import.meta.url);
const games = ["shogi", "reversi", "four-shogi", "four-reversi"] as const;
const method = (game: string) => (game.startsWith("four-") ? "skill" : "elo");
function ratingFixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(new URL(file, migrations), "utf8"));
  for (const id of ["one", "two"])
    db.query(
      "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,? ,?,1,1,1)",
    ).run(id, id, id + "@example.test");
  for (const game of games) {
    const rating = method(game);
    for (const account of ["one", "two"]) {
      for (let n = 1; n <= 2; n++) {
        const match = `${game}-${account}-${n}`;
        db.query("INSERT INTO matches VALUES (?,?,'singles',1,2,'{}')").run(match, game);
        db.query(
          `INSERT INTO ${rating}_rating_changes VALUES (?, ?, ?, ${rating === "elo" ? "1500.25,1524.5" : "25.25,8.125,26.5,7.25"}, ?, ?)`,
        ).run(game, match, account, n, n - 1);
      }
      db.query(`INSERT INTO ${rating}_rating_pending VALUES (?, ?, ?, ?, ?)`).run(
        game,
        account,
        `${game}-${account}-pending`,
        account === "one" ? "12345" : null,
        account === "one" ? "instance" : null,
      );
    }
  }
  return db;
}

test("0049: changesの主キーとゲーム別の局数の一意性、pendingのゲーム別主キーを維持する", () => {
  const db = ratingFixture();
  try {
    for (const game of games) {
      const table = `${method(game)}_rating_changes`;
      const counterpart =
        game === "shogi"
          ? "reversi"
          : game === "reversi"
            ? "shogi"
            : game === "four-shogi"
              ? "four-reversi"
              : "four-shogi";
      // 同じアカウントの同じ局数は別ゲームと共存します。
      expect(
        db
          .query(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id='one' AND rated_games=1`)
          .get(),
      ).toEqual({ n: 2 });
      expect(() =>
        db.exec(
          `UPDATE ${table} SET game='${counterpart}' WHERE game='${game}' AND account_id='one' AND rated_games=1`,
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.exec(
          `UPDATE ${table} SET match_id='${counterpart}-one-1' WHERE game='${game}' AND account_id='one' AND rated_games=1`,
        ),
      ).toThrow(/UNIQUE/);
      const pending = `${method(game)}_rating_pending`;
      expect(() =>
        db.exec(
          `INSERT INTO ${pending} SELECT * FROM ${pending} WHERE game='${game}' AND account_id='one'`,
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        db.exec(
          `INSERT INTO ${pending}(game,account_id,match_id) VALUES ('${game}','missing','pending')`,
        ),
      ).toThrow(/FOREIGN KEY/);
    }
  } finally {
    db.close();
  }
});

test("0049: changesの対局とアカウント、pendingのアカウントの外部キーとCASCADEを維持する", () => {
  const db = ratingFixture();
  try {
    for (const game of games) {
      const table = `${method(game)}_rating_changes`;
      expect(() =>
        db.exec(
          `UPDATE ${table} SET match_id='missing' WHERE game='${game}' AND account_id='one' AND rated_games=1`,
        ),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        db.exec(
          `UPDATE ${table} SET account_id='missing' WHERE game='${game}' AND account_id='one'`,
        ),
      ).toThrow(/FOREIGN KEY/);
      expect(() =>
        db.exec(
          `UPDATE ${method(game)}_rating_pending SET account_id='missing' WHERE game='${game}' AND account_id='one'`,
        ),
      ).toThrow(/FOREIGN KEY/);
      db.query("DELETE FROM matches WHERE id=?").run(`${game}-one-1`);
      expect(db.query(`SELECT 1 FROM ${table} WHERE match_id=?`).get(`${game}-one-1`)).toBeNull();
    }
    db.exec("DELETE FROM user WHERE id='one'");
    for (const name of ["elo", "skill"])
      for (const kind of ["changes", "pending"]) {
        expect(
          db.query(`SELECT 1 FROM ${name}_rating_${kind} WHERE account_id='one'`).get(),
        ).toBeNull();
        expect(
          db.query(`SELECT 1 FROM ${name}_rating_${kind} WHERE account_id='two'`).get(),
        ).not.toBeNull();
      }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
  }
});
