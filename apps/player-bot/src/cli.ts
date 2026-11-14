import { parseArgs } from "node:util";
import { Api, cookieValue } from "./api";
import { origin, profileNameSchema, runConfigSchema } from "./config";
import { Store } from "./store";
import { runBots } from "./bot";
import { StopControl } from "./session";

async function secret(): Promise<string> {
  if (!process.stdin.isTTY) {
    const value = await Bun.stdin.text();
    if (value.length > 4096) throw Error("Cookieが長すぎます");
    return cookieValue(value);
  }
  process.stderr.write("セッションCookie（非表示）: ");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else {
        try {
          resolve(cookieValue(value));
        } catch (error) {
          reject(error);
        }
      }
    };
    const read = (data: Buffer) => {
      for (const character of data.toString("utf8")) {
        if (character === "\u0003") {
          finish(Error("取り込みを中止しました"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
        if (value.length > 4096) {
          finish(Error("Cookieが長すぎます"));
          return;
        }
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.on("data", read);
    process.stdin.resume();
  });
}
export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { origin: { type: "string" }, help: { type: "boolean" } },
  });
  const [command, input] = parsed.positionals;
  if (parsed.values.help || !command) {
    console.log(
      "auth <profile> --origin <接続先>  Cookieを非表示で取り込み\nrun <config.json>                BOTを起動（Ctrl+C: 完局後終了、2回目: 即退出）",
    );
    return;
  }
  if (command === "auth" && input && parsed.values.origin && parsed.positionals.length === 2) {
    const name = profileNameSchema.parse(input),
      url = origin(parsed.values.origin);
    const store = new Store(url, name);
    const release = await store.lock();
    try {
      const previous = await store.loadProfile();
      const profile = { cookie: await secret(), identity: previous?.identity ?? "" };
      const api = new Api(url, profile, async () => {});
      profile.identity = await api.checkAccess();
      await store.saveProfile(profile);
      console.log(`${name}: ログインと規約同意を確認し、認証情報を保存しました`);
    } finally {
      await release();
    }
  } else if (
    command === "run" &&
    input &&
    parsed.positionals.length === 2 &&
    !parsed.values.origin
  ) {
    const config = runConfigSchema.parse(await Bun.file(input).json());
    const stop = new StopControl();
    const interrupt = () => {
      stop.request();
      console.log(
        stop.mode === "drain"
          ? "新規参加を停止しました。割当済みの対局が終わると終了します"
          : "即退出して終了します",
      );
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      await runBots(config, stop);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  } else throw Error("使用方法は --help を参照してください");
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "BOTを実行できません");
    process.exitCode = 1;
  });
}
