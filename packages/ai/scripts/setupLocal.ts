import { writeFile } from "node:fs/promises";
const path = new URL("../.env.local", import.meta.url);
if (await Bun.file(path).exists())
  throw Error(".env.localは既にあります。既存のAI_LOCAL_TOKENを使用してください。");
const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
  n.toString(16).padStart(2, "0"),
).join("");
await writeFile(path, `AI_LOCAL_TOKEN=${token}\n`, { mode: 0o600, flag: "wx" });
console.log(
  "packages/ai/.env.localを作成しました。AI_LOCAL_TOKENの値を拡張の設定画面へ登録してください。秘密値はログへ出力しません。",
);
