import { parseArgs } from "node:util";
import { origin, profileNameSchema, runConfigSchema, type RunConfig } from "./config";

export const cliHelp = `auth <profile> --origin <URL>   Cookieを非表示で取り込み
run --origin <URL> --game <four-reversi|four-shogi> --bot <profile> <参加先>
run <config.json>               保存した設定ファイルで起動（任意）

参加先（いずれか1つ）:
  --room <5桁の部屋番号>       通常ルームに参加
  --tournament <大会ID>         大会に参加
  --rated                      レートマッチに参加
  --create                     通常ルームを新規作成

--botは1〜4体まで繰り返し指定できます。--originと--gameは必須です。
--create専用: --main-time-minutes <0|1|3|5|10>（既定5）
              --byoyomi-seconds <0|10|30>（既定30）
              --three-player-attack-prohibited <on|off>（既定on）
設定ファイルと起動引数は同時に指定できません。
Ctrl+C: 完局後終了、2回目: 即退出

例: run --origin https://tetraboard.net --game four-reversi --bot bot1 --room 12345`;

export type CliCommand =
  | { type: "help" }
  | { type: "auth"; profile: string; origin: string }
  | { type: "file"; path: string }
  | { type: "run"; config: RunConfig };

function integer(value: string, name: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw Error(`${name}は整数で指定してください`);
  return Number(value);
}

export function parseCliArguments(args: string[]): CliCommand {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      origin: { type: "string" },
      game: { type: "string" },
      bot: { type: "string", multiple: true },
      room: { type: "string" },
      tournament: { type: "string" },
      rated: { type: "boolean" },
      create: { type: "boolean" },
      "main-time-minutes": { type: "string" },
      "byoyomi-seconds": { type: "string" },
      "three-player-attack-prohibited": { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, input] = positionals;
  if (values.help || !command) return { type: "help" };
  if (command === "auth") {
    if (
      positionals.length !== 2 ||
      !input ||
      !values.origin ||
      Object.keys(values).some((key) => key !== "origin")
    )
      throw Error("認証は auth <profile> --origin <URL> で指定してください");
    return { type: "auth", profile: profileNameSchema.parse(input), origin: origin(values.origin) };
  }
  if (command !== "run" || positionals.length > 2)
    throw Error("使用方法は --help を参照してください");
  if (input !== undefined) {
    if (!input) throw Error("設定ファイルのパスを指定してください");
    if (Object.keys(values).length) throw Error("設定ファイルと起動引数は同時に指定できません");
    return { type: "file", path: input };
  }
  if (!values.origin || !values.game || !values.bot?.length)
    throw Error("--origin <URL>、--game <ゲーム>、--bot <profile> を指定してください");
  const targets = [
    values.room !== undefined,
    values.tournament !== undefined,
    values.rated === true,
    values.create === true,
  ];
  if (targets.filter(Boolean).length !== 1)
    throw Error("参加先は --room、--tournament、--rated、--create のいずれか1つを指定してください");
  const main = values["main-time-minutes"],
    byoyomi = values["byoyomi-seconds"],
    prohibited = values["three-player-attack-prohibited"];
  if (!values.create && [main, byoyomi, prohibited].some((value) => value !== undefined))
    throw Error("持ち時間・秒読み・三人攻撃禁止の指定は --create 専用です");
  if (prohibited !== undefined && prohibited !== "on" && prohibited !== "off")
    throw Error("--three-player-attack-prohibited は on または off を指定してください");
  const target =
    values.room !== undefined
      ? { type: "room", roomId: values.room }
      : values.tournament !== undefined
        ? { type: "tournament", id: integer(values.tournament, "大会ID") }
        : values.rated
          ? { type: "rated" }
          : {
              type: "create",
              timeControl: {
                mainTimeMs: integer(main ?? "5", "持ち時間") * 60000,
                byoyomiMs: integer(byoyomi ?? "30", "秒読み") * 1000,
              },
              threePlayerAttackProhibited: prohibited !== "off",
            };
  return {
    type: "run",
    config: runConfigSchema.parse({
      origin: values.origin,
      game: values.game,
      profiles: values.bot,
      target,
    }),
  };
}
