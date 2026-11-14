import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliArguments, cliHelp } from "../src/cliArguments";
import { runConfigSchema, scope } from "../src/config";

const base = [
  "run",
  "--origin",
  "https://tetraboard.net",
  "--game",
  "four-reversi",
  "--bot",
  "bot1",
];

test("設定ファイルなしで通常ルームへ参加でき、既存ファイルと同じ復帰scopeになる", () => {
  const command = parseCliArguments([...base, "--room", "12345"]);
  expect(command).toEqual({
    type: "run",
    config: {
      origin: "https://tetraboard.net",
      game: "four-reversi",
      profiles: ["bot1"],
      target: { type: "room", roomId: "12345" },
    },
  });
  if (command.type !== "run") throw Error("run");
  const legacy = runConfigSchema.parse(
    JSON.parse(
      '{"origin":"https://tetraboard.net/","game":"four-reversi","profiles":["bot1"],"target":{"type":"room","roomId":"12345"}}',
    ),
  );
  expect(scope(command.config)).toBe(scope(legacy));
});

test("大会・レート・複数BOTの起動条件を引数だけで指定できる", () => {
  expect(parseCliArguments([...base, "--tournament", "7"])).toMatchObject({
    type: "run",
    config: { target: { type: "tournament", id: 7 } },
  });
  expect(
    parseCliArguments([...base, "--rated", "--bot", "bot2", "--bot", "bot3", "--bot", "bot4"]),
  ).toMatchObject({
    type: "run",
    config: { profiles: ["bot1", "bot2", "bot3", "bot4"], target: { type: "rated" } },
  });
});

test("新規作成の既定値と明示した設定を既存RunConfigへ変換する", () => {
  const defaults = parseCliArguments([...base, "--create"]);
  expect(defaults).toMatchObject({
    type: "run",
    config: {
      target: {
        type: "create",
        timeControl: { mainTimeMs: 300000, byoyomiMs: 30000 },
        threePlayerAttackProhibited: true,
      },
    },
  });
  if (defaults.type !== "run") throw Error("run");
  expect(scope(defaults.config)).toBe(
    scope(
      runConfigSchema.parse({
        origin: "https://tetraboard.net",
        game: "four-reversi",
        profiles: ["bot1"],
        target: { type: "create" },
      }),
    ),
  );
  expect(
    parseCliArguments([
      "run",
      "--origin",
      "http://localhost:8787",
      "--game",
      "four-shogi",
      "--bot",
      "bot1",
      "--create",
      "--main-time-minutes",
      "0",
      "--byoyomi-seconds",
      "10",
      "--three-player-attack-prohibited",
      "off",
    ]),
  ).toMatchObject({
    type: "run",
    config: {
      target: {
        type: "create",
        timeControl: { mainTimeMs: 0, byoyomiMs: 10000 },
        threePlayerAttackProhibited: false,
      },
    },
  });
});

test("従来の設定ファイル・認証指定・helpを維持する", () => {
  expect(parseCliArguments(["run", "/path with spaces/bots.json"])).toEqual({
    type: "file",
    path: "/path with spaces/bots.json",
  });
  expect(parseCliArguments(["auth", "bot1", "--origin", "https://tetraboard.net/"])).toEqual({
    type: "auth",
    profile: "bot1",
    origin: "https://tetraboard.net",
  });
  expect(parseCliArguments([])).toEqual({ type: "help" });
  expect(parseCliArguments(["run", "--help"])).toEqual({ type: "help" });
  expect(cliHelp).toContain("--bot bot1 --room 12345");
});

const invalid = [
  ["run"],
  ["run", "--room", "12345", "--bot", "bot1"],
  ["run", "--origin", "https://tetraboard.net", "--bot", "bot1", "--rated"],
  ["run", "--origin", "https://tetraboard.net", "--game", "four-reversi", "--rated"],
  base,
  [...base, "--room", "12345", "--rated"],
  [...base, "--room", "1234"],
  [...base, "--tournament", "0"],
  [...base, "--tournament", "7abc"],
  [...base, "--tournament", "9007199254740993"],
  [...base, "--rated", "--bot", "bot1"],
  [...base, "--rated", "--bot", "b2", "--bot", "b3", "--bot", "b4", "--bot", "b5"],
  [...base, "--rated", "--main-time-minutes", "1"],
  [...base, "--create", "--main-time-minutes", "2"],
  [...base, "--create", "--main-time-minutes", ""],
  [...base, "--create", "--byoyomi-seconds", "-10"],
  [...base, "--create", "--main-time-minutes", "0", "--byoyomi-seconds", "0"],
  [...base, "--create", "--three-player-attack-prohibited", "maybe"],
  ["run", "bots.json", "--origin", "https://tetraboard.net"],
  ["run", "bots.json", "--bot", "bot1"],
  ["run", "bots.json", "--rated"],
  ["run", "bots.json", "extra.json"],
  ["run", "--unknown"],
  ["auth", "bot1", "--origin", "https://tetraboard.net", "--room", "12345"],
];
test("不足・競合・不正値・ファイルとの混在を拒否する", () => {
  for (const args of invalid) expect(() => parseCliArguments(args)).toThrow();
});

test("実CLIの引数エラーは認証情報の読み書きより前に終了する", async () => {
  const home = await mkdtemp(join(tmpdir(), "tb48-cli-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("../src/cli.ts", import.meta.url).pathname,
        ...base,
        "--room",
        "12345",
        "--rated",
      ],
      {
        env: { ...process.env, TETRABOARD_BOT_HOME: home },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(error).toContain("いずれか1つ");
    expect(await readdir(home)).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
