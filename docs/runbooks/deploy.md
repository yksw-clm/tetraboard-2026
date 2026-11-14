# デプロイと環境

本番と開発環境の構成、デプロイの流れ、初回設定、障害時の対応です。

## 概要

developは `https://tetraboard-dev.chaossi-lab.workers.dev` へCI成功後に自動公開します。Workerは `tetraboard-dev`、D1は `tetraboard-dev-db`、R2は `tetraboard-dev-objects` とし、対局状態・アカウント・画像・棋譜を本番と分離します。本番データをコピーせず空の状態から開始します。誰でも利用できますがHTTPとHTMLのnoindexで検索対象外にします。canonicalは開発URL、サイトマップは空とし、robots.txtからサイトマップを案内しません。本番ドメイン・データ・検索設定は維持します。

本番URLは `https://tetraboard.net`、Worker名は `tetraboard-2026`、D1名は `tetraboard-2026-prod-db` です。Worker 1つでWeb画面・管理画面・HTTP API・WebSocketを配信します。GitHub ActionsはmainのCI成功後にD1マイグレーションとデプロイを行います。CloudflareのGit連携による別の自動公開は設定しません。

初回は差分と検証結果を確認し、開発者の承認後にマージ・公開します。以後はPRのマージが本番更新の契機です。ローカルのデータは本番へ移行せず、開発環境を設け、PRごとのプレビューは設けません。`tetraboard-2026.chaossi-lab.workers.dev` はパスとクエリを保持して本番ドメインへ308転送します。ドメインをまたいだログイン状態・タブ内の参加資格は引き継がず、再ログイン・再入室します。旧版の `/profile` はマイページ、`/games/game-…` の棋譜と `/guest/name` はリバーシロビーへ案内します。旧ルームは移行せず、存在しない部屋には既存のエラー画面とロビーへの導線を表示します。

## ブランチと公開先

ブランチ、マージ、公開の承認のルールは [AGENTS.md](../../AGENTS.md) にあります。PRのマージが公開の契機です。

| 設定           | 本番の値                                          |
| -------------- | ------------------------------------------------- |
| Wrangler環境   | `production`                                      |
| Worker         | `tetraboard-2026`                                 |
| URL            | `https://tetraboard.net`                          |
| D1             | `tetraboard-2026-prod-db`                         |
| D1接続名       | `APP_DB`                                          |
| R2             | `tetraboard-2026-objects-prod` / `OBJECT_STORAGE` |
| Durable Object | `GAME_ROOM` / `GameRoom`（SQLite）                |

本番用D1はAPACの配置ヒントで新規作成済みです。IDは `env.production.d1_databases` に記載しています。通常の `bun run dev` とWorkerテストはトップレベルのローカルDBだけを利用します。productionの `remote: false` はローカル実行時にリモートDBへ接続しない指定で、本番Workerでは本番D1へ接続します。ローカルデータは移行しません。

## 初回の認証設定

開発環境の初回準備・ブランチ移行は次節に従います。本番用の既存Secretは維持します。

## 開発環境の準備と移行

`env.development` はWorker `tetraboard-dev`、URL `https://tetraboard-dev.chaossi-lab.workers.dev`、D1 `tetraboard-dev-db`、R2 `tetraboard-dev-objects` を使います。GAME_ROOMはこのWorker専用のSQLite Durable Objectです。本番からデータをコピーせず、アカウントも新規登録します。

1. 初回のみ最新mainからdevelopを作成します。初回ブランチ作成は直接push禁止の例外です。そこから作業ブランチを作り、設定変更はdevelop向けPRにします。
2. Cloudflareの認証を用意し、`apps/worker` で `bunx wrangler d1 create tetraboard-dev-db --location apac` と `bunx wrangler r2 bucket create tetraboard-dev-objects` を実行します。返されたD1 IDを `env.development.d1_databases` に記録します。ゼロ始まりIDは未準備の印で、開発用リモートmigration・deployコマンドは停止します。dry-runは実リソースの存在や権限を保証しません。
3. GitHub Actionsの専用APIトークンが開発用D1・R2も操作できることを確認します。Google・Discordの既存OAuthアプリに開発URLの `/api/auth/callback/google`・`/api/auth/callback/discord` を追加します。
4. `wrangler secret put <名前> --env development` でGoogle・Discord設定を登録します。BETTER_AUTH_SECRET・FEEDBACK_HASH_SECRET・MODERATOR_TOKENは開発専用の乱数を使います。秘密値は会話・ログ・Gitに記載しません。Secret登録がWorkerを作成する場合も初回公開承認後に行います。初回マージ前に必要なSecretを揃えます。
5. 検証結果と差分の承認後、developへマージして初回公開します。開発環境で登録した本人のIDをADMIN_ACCOUNT_IDSに設定し、ログイン・画像・棋譜・ルーム・WebSocket再接続・管理画面と本番データとの分離を確認します。
6. 開発環境の動作確認後、GitHubの既定ブランチをdevelopへ変更します。未マージPRがあれば差分を確認してdevelop向けに変更します。その後develop→mainのリリースPRを提出し、CI成功と開発者承認後にマージします。

開発用コマンドは `bun run build:development`、Workerの `deploy:dry-run:development`、`db:migrate:development`、`deploy:development` です。公開確認は `bun scripts/checkDeployment.ts https://tetraboard-dev.chaossi-lab.workers.dev development`。本番は既存コマンドを維持します。リモートmigrationは通常Actionsからのみ実行します。

開発ビルドはVITE_PUBLIC_ORIGINとVITE_SEARCH_INDEXABLEを設定し、初期HTMLと画面内遷移のcanonical・robotsを一致させます。開発Workerは101応答を除いてX-Robots-Tagを付与します。robots.txtはnoindexを読めるようクロールを許可し、サイトマップの案内を省きます。サイトマップは空のXMLです。本番のSEO確認は維持します。

緊急修正も原則develop経由です。復旧は修正またはrevertのPRで行い、DB・Durable Object保存形式と旧コードの互換性を確認します。マイグレーションの自動巻き戻しはしません。

## 本番の認証設定

1. Cloudflareで本プロジェクト専用APIトークンを新規作成します。「Edit Cloudflare Workers」を基に、対象アカウントだけを選び、Workersの公開に必要な権限とD1の編集権限と対象R2バケットを読み書きできる権限を付与します。workers.devでの公開には独自ドメインのZone権限は不要です。ローカルWranglerのOAuthトークンや他プロジェクトのトークンは流用しません。
2. GitHubのリポジトリ設定 → Secrets and variables → Actions → Repository secretsに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録します。値をソース・PR・会話・ログに記載しません。GitHub Environmentは利用しません。
3. 初回公開直後に `bunx wrangler secret put MODERATOR_TOKEN --env production` を `apps/worker` から実行し、運営者API専用の十分に長い乱数を非表示の入力欄へ渡します。APIトークンとは別の値を使い、運営者の安全な保管先で管理します。未登録の間は運営者APIの認証は成功しません。登録後に認証付き運営者APIを確認します。

CloudflareのGit連携は設定せず、公開経路はこのリポジトリのActionsに一本化します。本番Worker・D1の名前は今後も変更せず、ドメインを変える場合も同じリソースを利用します。

## CI/CDの流れ

CIの実行範囲は[CIの実行範囲](../testing.md#ciの実行範囲)を参照してください。工程別の秒数をsummaryへ記録します。CIは型検査後の `build:assets` で重複検査を避けます。PRジョブはCloudflareの認証情報を使いません。

公開確認スクリプトの `scripts/checkDeployment.ts` はWebの `tsconfig.build.json` に含め、通常の型チェックと本番・開発ビルドでも検査します。本番だけが通るサイトマップの検証分岐も、未定義変数やimport漏れを公開前に検出します。

main・developのpushでは、`checks` ジョブが同じ実行の対象環境の成果物をデプロイジョブへ渡します。`ai` ジョブ（AIに関わる差分があるときとmainへのpushで実行）がlinux/amd64の3種類のイメージをビルドし、4コンテナを起動して全採用設定の合法手・版と4並列を検証します。`checks` の成功と、`ai` の成功またはskipを公開条件にします。成果物名は環境とSHAを含みます。対象ブランチの先頭SHAをD1マイグレーションの前後に確認し、古い実行なら公開をスキップします。mainはproduction、developはdevelopmentへ公開します。同時デプロイを環境別に禁止し、進行中のデプロイは途中キャンセルしません。先頭確認後の更新は次の実行で公開します。

独自ドメインの変更時はCD用APIトークンに対象Zoneの読み取り権限と、対象アカウントのWorkersルート・独自ドメインを更新できる権限があることを確認します。

公開後は `scripts/checkDeployment.ts` でトップページのHTML、`/api/healthz` の応答、公開ルーム一覧のスキーマ、全16戦法の画像URLの成功応答・JPEGのContent-Type・ファイル先頭の識別バイトを検証します。実画像のデコードは行いません。各リクエストにはタイムアウトと最大5回の再試行を設けています。チェック・マイグレーション失敗時はデプロイへ進まず、公開後の確認失敗もActionsの失敗として残ります。

## 本番構成のローカル確認

リポジトリのルートから順に実行します。

```sh
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
bun run --cwd apps/worker db:migrate:preview
bun run --cwd apps/worker preview:production
```

最後のコマンドはローカルサーバーを継続実行します。別のターミナルで `bun scripts/checkDeployment.ts http://127.0.0.1:8788` を実行します。プレビュー用DBは `.wrangler/production-preview` に隔離し、本番には書き込みません。
ブラウザで `/games/four-reversi` と `/rooms/<ID>` を直接開き、招待・参加・観戦・CPU対戦・チャット・再接続を確認します。未知の `/api/*` がSPAのHTMLにならないこと、WebSocketのUpgradeと資格確認・部屋世代の照合が保たれることも確認します。Workerテストは `/api` 経由のJSON・認証・WebSocketと404を検証します。

初回公開後も本番URLで上記の主要導線を確認し、作成した確認用ルームから退室します。本番のマイグレーションはActionsからのみ適用し、ローカル確認時に `db:migrate:production` を使わないでください。

## 失敗時の対応と将来のドメイン

- CI失敗は修正してPRを更新します。秘密値不足や認証エラーはRepository secretsと権限を確認します。秘密値はログへ出さず、初回は必要なSecretが揃うまでマージしません。
- マイグレーションは旧コードでも動く追加変更を基本とし、破壊的な変更は段階を分けて別途承認します。マイグレーション失敗時は公開されません。適用済みの変更は公開失敗やスキップ時にも残るため、自動でDBを巻き戻しません。
- 公開後に不具合があれば、修正またはrevertのPRをCI成功後にマージして再デプロイします。DBやDurable Objectの保存形式に変更がある場合は旧コードとの互換性を確認し、互換性がなければ修正を前進適用します。
- Actionsの実行履歴とCloudflareのWorkerログで障害を確認します。デプロイ時にはWebSocketが切断されるため、公開後に再接続も確認します。
- 本番ドメインは `tetraboard.net` です。Worker・D1・R2の名前とIDを維持します。旧workers.dev URLは同じパス・クエリで308転送します。転送を静的アセットより先に処理するため `run_worker_first: true` と `ASSETS` を設定し、`/api` と `/api/*` はHono、画面・画像は `ASSETS.fetch` へ渡します。
- 旧版の `/profile` は `/account`、`/games/game-…` と `/guest/name` は `/games/four-reversi` へ302転送します。旧ルーム・棋譜は移行しません。旧ルームの取得失敗は既存のエラー画面からロビーへ戻れます。ログイン状態とオリジン別の `sessionStorage` は移行せず、再ログイン・再入室します。
- 切替前にアカウントの追加移行を済ませ、CI成功後にドメイン・`APP_ORIGIN`・CIの `PRODUCTION_URL` を同じ変更で切り替えます。ドメインの割当先、HTML・API・WebSocket、Googleログイン、プロフィールと既存棋譜を確認した後、旧Worker `tetraboard`、旧D1 `tetraboard-db-prod`、旧R2 `tetraboard-objects-prod` を削除します。削除前に旧版へ戻す場合は、ドメインの割当先を旧Workerへ戻します。

## 本番AIと4ゲーム同時公開

2026-11-11の開発者指示により、本番専用AI 4コンテナと4ゲームのレート戦を同時公開する構成です。本番の外部AIはレート戦だけで使い、通常ルーム・大会のCPU、ルール・時計・レート計算は変更しません。設定追加と実際の公開を区別し、以下の確認・承認が終わるまでmainへ取り込みません。

- AI Workerは `tetraboard-ai-prod`、各ゲームは `basic`・最大1台・アイドル停止11分です。アプリの `AI_GATEWAY` は本番AIだけへ接続します。`AI_RATED_ONLY` は本番true、開発false、未指定時は従来動作です。四人ゲームの応答期限は四人リバーシ10秒・四人将棋5秒、二人ゲームは5秒を上限に時計期限を優先します。
- 開発環境で4ゲームの冷起動、上限までの同時対局、取消・再接続・枠解放、終局・棋譜・レート保存、正常系で代替手が発生しないこと、AI障害時の代替手とレート対象外処理を確認します。各CPU設定・較正版・基準レートを固定し、特に四人将棋は人間混在試験の結果と開発者の採用判断を記録します。暫定値を確認なしに本番採用しません。
- `bun run check` と `bun run check:ai` に加え、`bun run --cwd packages/ai deploy:cloud:dry-run:production` と `bun run --cwd packages/ai verify:images` を成功させます。後者はDockerを使い、公開先へ接続せず1/4 CPU・1GiBメモリの4コンテナを一時起動します。4並列はエミュレーションの速度差を考慮して要求ごとに最大60秒で回収し、合法手と受付上限を確認します。Cloudflareでの期限内成功率、冷起動やディスク割当の保証ではありません。終了時はこの検証が作成したコンテナとイメージタグだけを回収します。
- develop向け実装PRの検証・承認・開発確認後、develop→mainのリリースPRへ対象SHA、全差分、マイグレーション一覧、検証対象・環境・結果・未確認事項を記載します。4ゲームすべての確認が完了するまで公開しません。コード・設定更新後は必須検証を再実行します。
- 公開前に本番の未適用migration、旧コードとの互換性、D1復元可能時点、Secret・CDトークンのWorkers/DO/Containers・レジストリ権限と、開発を含むアカウントの利用上限を確認します。開発のアカウント・棋譜・レートはコピーしません。実OAuth、ゲスト連携、既存棋譜、管理画面、端末操作の確認を自動テストの成功と混同しません。

公開日は運営者が決め、対局・大会が少ない時間を選びます。更新時の再接続を告知し、公開直後の確認担当を決めます。差分・検証結果への公開承認後、次の順で実施します。

1. 本番専用の32〜256文字ASCII乱数 `AI_SERVICE_TOKEN` を安全な保管先へ生成します。`apps/worker` の `wrangler secret put AI_SERVICE_TOKEN --env production` と、`packages/ai` の `wrangler secret put AI_SERVICE_TOKEN --config cloudflare/wrangler.jsonc --env production` に同じ値を非表示入力で登録します。新規AI Workerの作成や既存Workerの更新を伴うため、これも承認された公開準備操作として扱います。既存の認証Secret・開発AIのtokenは変更しません。
2. 認証付き公開確認のため、同じ値をGitHub Repository secret `AI_SERVICE_TOKEN_PRODUCTION` に登録します。これはアプリへ埋め込む値ではなく、Actionsの公開確認だけへ環境変数で渡します。値は引数・Git・PR・ログに出しません。
3. リリースPRをマージコミットで取り込みます。mainのCIの `checks` と `ai` の成功後、AIに関わる差分があれば先頭SHAを確認してAIをデプロイし、`bun run --cwd packages/ai verify:deployment production` で4エンジンの実着手・要求ID・版・profile・合法性を確認します。初回は起動を含む最大60秒、その後は実際の応答期限で全採用設定を照合します。ゲームごとの確認要求は1件ずつとし、4並列の負荷確認はCIの一時コンテナだけで行います。固定の非個人局面だけを送り、healthだけで成功としません。
4. AI公開確認が成功し、再度先頭SHAが一致する場合だけD1 migrationを適用します。適用後も先頭を確認し、アプリをデプロイします。AIとアプリは同じコミットのソースを使い、AIは更新前のアプリが使うAPI・profileも受理する互換更新とします。AI検証失敗時はDB更新・アプリ公開へ進みません。AIだけ公開済みの場合も自動削除・巻き戻しはしません。
5. 既存の `checkDeployment.ts` と、4ゲームの受付・着手・終局保存・レート反映、開幕案内、通常ルームの従来CPU、ログイン・既存棋譜・再接続を本番で確認します。ActionsのSHA、Worker版と結果をリリースPRへ記録します。

公開直後30分、翌日、1週間後にゲーム別の応答時間、タイムアウト・代替手、枠解放、保存待ち、コンテナ稼働時間と費用を確認します。4台を用意しても常時起動しません。メモリ・ディスクはアイドル中も割当分が課金され、月枠は開発環境と共有します。費用の過去条件はAIの測定記録を参照し、本番の実使用量は別途確認します。

レート結果の不整合・保存不能、または同じゲームで正常対局が連続して成立・進行できない場合は、そのゲームの受付停止PRをdevelop経由で作成します。共通障害は4ゲームを停止します。`MATCHMAKING_ENABLED`（四人リバーシ）、`FOUR_SHOGI_MATCHMAKING_ENABLED`、`SHOGI_MATCHMAKING_ENABLED`、`REVERSI_MATCHMAKING_ENABLED` の対象だけをfalseにします。AI接続・有効化設定・token・コンテナは残し、新規joinを拒否します。受付済み待機は既存の成立・取消・失効処理、成立済み局は終局・保存まで継続します。停止にもCI・承認・再デプロイが必要で、即時停止ではありません。復旧は互換性確認済みの修正・revert PRとし、DBの自動巻き戻しや未確認の旧版復元は行いません。
