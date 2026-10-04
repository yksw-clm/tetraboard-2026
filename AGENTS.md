# 作業ルール

- `main` は本番です。作業は最新mainから `feat/xxx`、`fix/xxx`、`docs/xxx`、`chore/xxx` などのブランチを作り、PRで取り込みます。mainへの直接push・force pushは行いません。非公開リポジトリの現行プランでは保護を強制できないため、GitHub CI成功、下記のローカルブラウザ検証成功、開発者のマージ承認を運用で守ります。他者レビューは必須ではありません。
- 仕様に関わる作業では、まず `README.md` の関連箇所を読み、次に対象ゲームのルール正本を読む。現在の四人リバーシの正本は `docs/rules/four-reversi.md`。対象ゲームがない共通仕様の作業は `README.md` を参照する。
- コードの作成・変更・レビューでは、作業前に `docs/development.md` を読む。
- 過去の変更経緯はGit履歴を参照し、利用できる場合は閉じたIssue・PRも参照する。現在有効な共通仕様は `README.md`、ゲーム固有のルールと長期参照が必要な設計判断は `docs/` に置く。過去資料の保管だけを目的にファイルやフォルダを増やさない。
- 資料にない内容や資料間の矛盾を推測で仕様として確定しない。未決定事項として示し、開発者に確認する。
- 仕様を変更した場合は、`README.md` や対象ゲームのルール正本など、該当する仕様文書を必ず同じ変更で更新する。
- 変更後は、変更内容、実施した確認と結果、未確認事項を報告する。

## PR提出前の検証

- 通常のGitHub CIでは `bun install --frozen-lockfile` 後に `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run` を実行する。Playwrightは通常CIで自動実行せず、ローカルでの成功をPR提出前の条件とする。GitHub CI成功をローカル検証で代替しない。
- コード・設定変更では、PRを作成する前にローカルで次の全コマンドを成功させる。UI・Adminは `CI=true` でビルド済み画面を検証し、Worker E2Eはproduction構成のローカルWorkerを使う。ブラウザ検証はChromiumとWebKitの両方で全ケースを実行する。

  ```sh
  bun run check
  bun run build
  bun run --cwd apps/worker deploy:dry-run
  CI=true bun run --cwd apps/web test:browser
  bun run --cwd apps/web test:browser:worker
  CI=true bun run --cwd apps/admin test:browser
  ```

- PR本文に検証対象コミット、実行環境、各コマンドの結果、未確認事項を記載する。PR提出後にコード・設定を変更した場合も、更新対象に対して全コマンドを再実行し、結果を更新する。mainの取り込みでコード・設定が変わった場合も同様に扱う。
- 文書だけの変更では同一コード・設定に対する直前の成功結果を再利用できる。検証済みコミットを明記し、文書の整形確認と `git diff --check` は最終差分で行う。
- Linux環境でブラウザ検証が必要な場合は、GitHub Actionsの `Browser Regression` を対象ブランチを選んで手動実行する。手動実行は本番デプロイを行わず、ローカルでの必須検証を省略する理由にしない。

## 承認が必要な場合

- 共通仕様、ゲームルール、MVPの範囲を新たに確定または変更するときは、実装前に開発者の承認を得る。開発者からの明示的な変更指示は承認済みとして扱う。
- 主要な構成や依存技術、外部サービスの採用を決めるときは、理由と影響を示して実装前に承認を得る。
- 変更のマージまたは公開は、差分と確認結果をレビューできる状態にしてから開発者の承認を得る。
