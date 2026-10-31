import { join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { defaultAiDirectory, currentGeneration, listGenerations, readJson } from "./nightlyStore";
import { nightlyConfig } from "./nightlyConfig";
import { runNightly } from "./nightlyRun";

const args = new Map<string, string>();
const flags = new Set([
  "help",
  "dry-run",
  "resume",
  "status",
  "smoke",
  "engineering",
  "allow-dirty",
]);
for (const argument of process.argv.slice(2)) {
  const match = /^--([a-z-]+)(?:=(.+))?$/.exec(argument);
  if (
    !match ||
    args.has(match[1]) ||
    (!flags.has(match[1]) && !["root", "config", "stop-after"].includes(match[1])) ||
    (!match[2] && !flags.has(match[1])) ||
    (match[2] && flags.has(match[1]))
  )
    throw new Error(`未知/重複した引数: ${argument}`);
  args.set(match[1], match[2] ?? "true");
}
if (args.has("help")) {
  console.log(`ローカル四人将棋AIの夜間学習
bun run ai:nightly [--root=/専用保存先] [--config=/設定.json]
  --dry-run       書込み・対局・学習を行わず条件を表示
  --status        現役/候補・各夜の状態を表示
  --resume        最後の未完runを同じコード・条件で再開
  --smoke         3分上限・2局・少量教師の動作確認（昇格しない）
  --engineering   品質不足でも明示的な動作試験モデルを保存（昇格不可）
  --stop-after=工程  確定工程の後で保存して中断
  --allow-dirty   未コミット版の明示的な実験。通常運用では使用しない
初回Python/PyTorch準備と設定はNIGHTLY-RUNBOOK.mdを参照。
停止はCtrl+C。heldは終了済みで、次の夜は引数なしで新しいrunを開始。`);
} else {
  const root = resolve(args.get("root") ?? defaultAiDirectory());
  if (args.has("status")) {
    const path = join(root, "runs");
    console.log(
      JSON.stringify(
        {
          root,
          current: currentGeneration(root),
          generations: listGenerations(root),
          nights: existsSync(path)
            ? readdirSync(path)
                .filter((n) => /^night-\d+$/.test(n))
                .sort()
                .map((n) => readJson(join(path, n, "state.json")))
            : [],
        },
        null,
        2,
      ),
    );
  } else {
    const raw = args.has("config") ? readJson(args.get("config")!) : undefined;
    if (args.has("dry-run"))
      console.log(
        JSON.stringify(
          {
            root,
            config: {
              ...nightlyConfig(raw ?? {}, args.has("smoke")),
              ...(args.has("engineering") ? { engineering: true } : {}),
            },
            current: currentGeneration(root).id,
            plan: "生成→P0-5教師→不変集合→品質gate→CPU/MPS比較→学習→推論検証→戦術→独立比較→昇格/保留",
            writes: false,
          },
          null,
          2,
        ),
      );
    else {
      const controller = new AbortController(),
        stop = () => controller.abort();
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      try {
        const result = await runNightly({
          root,
          config: raw,
          smoke: args.has("smoke"),
          engineering: args.has("engineering"),
          resume: args.has("resume"),
          allowDirty: args.has("allow-dirty"),
          stopAfter: args.get("stop-after"),
          signal: controller.signal,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        if (String(error).includes("requested_stop_after:")) {
          console.log("確定工程の後で保存して中断しました。--resumeで再開できます。");
          process.exitCode = 0;
        } else {
          console.error(String(error));
          process.exitCode = controller.signal.aborted ? 130 : 1;
        }
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  }
}
