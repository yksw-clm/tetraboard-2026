import { Api, cookieValue } from "./api";
import { runConfigSchema } from "./config";
import { cliHelp, parseCliArguments } from "./cliArguments";
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
  const command = parseCliArguments(args);
  if (command.type === "help") {
    console.log(cliHelp);
    return;
  }
  if (command.type === "auth") {
    const store = new Store(command.origin, command.profile);
    const release = await store.lock();
    try {
      const previous = await store.loadProfile();
      const profile = { cookie: await secret(), identity: previous?.identity ?? "" };
      const api = new Api(command.origin, profile, async () => {});
      profile.identity = await api.checkAccess();
      await store.saveProfile(profile);
      console.log(`${command.profile}: ログインと規約同意を確認し、認証情報を保存しました`);
    } finally {
      await release();
    }
  } else {
    const config =
      command.type === "file"
        ? runConfigSchema.parse(await Bun.file(command.path).json())
        : command.config;
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
  }
}
if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "BOTを実行できません");
    process.exitCode = 1;
  });
}
