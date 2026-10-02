# Development

## Development Strategy

土台 → Vertical Slice → ロビー → ルーム → 四人リバーシ → E2E
の順で開発します。

## Local Development

リポジトリのルートで `bun run dev` を実行すると、WorkerのローカルD1マイグレーションを適用してからWebとWorkerの開発サーバーが同時に起動します。
どちらもLANから接続できます。

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。
通信の確認にはWorkerの `/healthz` を使います。ロビー画面にはAPIステータスや生のAPI応答を表示しません。
開発機からは `http://127.0.0.1:8787/healthz` でWorkerを直接、Viteの `Network` URLに `/api/healthz` を付けてWeb経由の通信を確認できます。

ルーム作成は `POST http://127.0.0.1:8787/rooms` に `{"name":"てとら","quickPlay":false,"mode":"singles"}` をJSONで送ります。`mode` は `singles` または `doubles` の必須項目です。成功応答の `room.id` に含まれる5桁のIDを使い、`GET http://127.0.0.1:8787/rooms/<ID>` で保存した部屋を確認できます。Workerを再起動した後も同じIDで取得できます。開発時のDurable ObjectとD1の状態は `apps/worker/.wrangler/state` に保存されます。D1だけを準備する場合は `bun run --cwd apps/worker db:migrate:local` を実行します。
既存ルームへの入室は `POST http://127.0.0.1:8787/rooms/<ID>/players` に `{"name":"二人目"}` をJSONで送ります。作成・入室の成功応答は `{ "room": ..., "membership": { "playerId": ..., "role": ..., "token": ... } }` です。満室なら409を返します。本人確認は `GET http://127.0.0.1:8787/rooms/<ID>/me` に `Authorization: Bearer <token>` を付けて行います。トークンは公開GETやWebSocketの応答には含めません。
Webの `/` は履歴を置き換えて `/games/four-reversi` へ転送します。四人リバーシ専用ロビーで「ルームを作る」「ルーム番号で参加」などを押すと、入力ダイアログを開きます。ニックネームなどを入力して確定すると、`/rooms/<ID>` に移動します。ルームページはGETで保存済みの情報を確認してから表示し、WebSocket接続後に受信したルーム情報と接続状態を表示します。別の画面からの入室もWebSocketで反映します。ページを再読み込みしても同じルームを取得できます。接続が切れた場合はGETで状態を再取得してから再接続します。開発機のブラウザで確認後、スマートフォンでもViteの `Network` URLから同じルームURLを開いて確認します。
作成・「すぐ遊ぶ」のダイアログでシングルス・ダブルスを選択します。初期値はシングルスです。「すぐ遊ぶ」を確定すると、選択したモードでホストは準備完了、CPU 3体はレベル1で待機します。ホストが「対局開始」を押した後、CPUの手番は約0.5秒後に自動で進みます。通常の待機部屋では、ホストがCPUの追加・削除・レベル変更とモード変更を行えます。モード変更時は人間全員の準備状態を解除します。人間とCPUの合計が4席で、接続中の人間全員が準備完了なら開始できます。設定変更と自動着手はWebSocketのルームスナップショットで他の画面へ反映されます。
同じタブで再読み込みすると、保存した参加資格をサーバーで確認してホスト・プレイヤーの区分と「[あなた]」を表示します。別の独立したタブから資格なしで通常URLを開いた場合は観戦者として表示し、空席のある待機中なら状況カードから参加できます。
ホスト・プレイヤーのWebSocket接続は、接続後に資格トークンを送って認証します。認証後の「準備完了」「準備取消」はWebSocketメッセージで送信し、Durable Objectが本人の状態を保存して全接続へ最新のルーム情報を配信します。別のタブで同じ部屋を観戦し、表示が更新されることを確認できます。GET、再読み込み、Worker再起動後も準備状態を取得できます。観戦者や無効な資格では準備状態を変更できません。
四人リバーシの着手を確認するには、4つの独立したタブで同じルームへ入室し、全員が準備完了にします。ホストが「対局開始」を押すと担当色がランダムに割り当てられ、黒の担当者が盤面のC4をクリックできます。座標は左上A1が `{x:0,y:0}` で、C4は `{x:2,y:3}` です。Durable Objectが `packages/four-reversi` で合法手を判定し、更新した盤面と手番を全接続へ配信します。`bun run test` でエンジンの判定を確認できます。
四人リバーシのエンジンは、シングルス・ダブルスの自動パス、終局、石数と順位・勝敗の確定、脱落色を飛ばす進行を扱います。ルームは保存したモードで開始し、エンジンが終局したら前局の最終盤面と結果を保持して自動で待機状態へ戻ります。Webは最終局面から棋譜モードになり、「←」・Select・「→」で開始局面や着手・パス・脱落へ移動できます。前局の結果は「結果」ボタンでダイアログ表示します。人間のReadyを改めて揃え、ホストが次の対局を開始します。
公開ロビーは `/games/four-reversi` で表示します。`GET http://127.0.0.1:8787/rooms` はD1索引から更新時刻の新しい順に20件返し、続きは応答の `nextCursor` を `?cursor=` に指定して取得します。参加ダイアログではゲストはニックネームを入力し、ログイン中はプロフィールを確認します。観戦は入力なしでルームページを開きます。終局後は対局前として一覧に表示されます。索引の反映が遅れた場合も、参加と観戦の可否はGameRoomが判定します。今回より前に保存したローカルルームは新しい索引へ移行しないため、動作確認には新規ルームを使用します。本番D1 `tetraboard-2026-prod-db` は作成済みです。`wrangler.jsonc` の `env.production` に本番用IDを設定し、トップレベルのローカル用IDは置き換えません。本番のマイグレーションは初回公開時にCDから適用します。
4つの独立したブラウザタブで1人ずつ入室・準備完了し、ホストが開始した後、各手番の担当タブで合法手を選び続けると、終局後の再戦待機画面に同じ結果が全タブで表示されることを確認できます。1タブを再読み込みしても同じ結果が表示されます。
ルーム内チャットは認証済みのプレイヤーが送信し、観戦者も閲覧・通報できます。投稿とシステムログは合計100件を上限に再接続後も復元します。運営者APIのローカル確認では `apps/worker/.dev.vars.example` を参考に、追跡対象外の `.dev.vars` に `MODERATOR_TOKEN` を設定します。`GET /admin/reports` と `POST /admin/reports/:id/actions` にその値をBearerトークンとして渡します。通報データのマイグレーションは通常の `bun run dev` 時にも適用されます。期限切れ通報は毎時の定期処理で削除されます。
待機中の退室では席が解放され、ホストが抜けると最も早く入室した人へ役割が移ります。対局中は自分の手番で投了でき、退室や30秒の切断期限切れ、持ち時間切れでも脱落します。再読み込み・再接続が期限前なら同じ参加資格で復帰し、期限後は閲覧のみできます。対局は各人5分の基本時間と、基本時間消費後の1手30秒の秒読みで進みます。GETの応答は `{ "room": ..., "presence": { "hostPlayerId": ..., "connectedPlayerIds": [...] }, "serverNowMs": ... }` で、WebSocketの `room.snapshot` にも接続情報と送信時のサーバー時刻が含まれます。接続情報は認証済みソケットから算出し、脱落後の切断・復帰も配信します。Webはこの時刻を基準に残り時間を表示します。復帰期限と時計の期限にはDurable Object Alarmを使い、Workerテストではアラームと保存済み期限を操作して確認します。以前のエンジン状態で保存されたローカルルームの移行は行わないため、進行確認には新規ルームを使用します。

招待リンクはルーム情報の「招待リンクをコピー」から取得します。`/rooms/<ID>?invite=<instanceId>` を資格のない別タブで開くと、空席のある待機中ルームでは参加ダイアログを自動表示します。閉じれば観戦でき、状況カードから再度参加できます。参加時は `POST /rooms/<ID>/players` のJSONに `instanceId` を追加し、WebSocketは `/rooms/<ID>/ws?instanceId=<instanceId>` へ接続します。識別子が不正なら400、不一致なら410を返します。従来の識別子なしリクエストも受け付けます。コピーAPIが使えないLAN上のHTTPなどでは、手動コピー用のダイアログを表示します。

## Checks

ルートで `bun run check` を実行すると、整形確認、lint、全Workspaceの型チェック、四人リバーシ、Worker、Webの表示ロジックのテストを実行します。`bun run test` ではエンジン・Worker・Webのテストを実行します。WorkerのテストはCloudflare Workers実行環境でDurable ObjectとWebSocketを検証します。

GitHub Actionsは `main` へのpushと `main` 宛てのPRで整形・lint・型チェック・テストに加え、Webビルドと本番デプロイのdry-runを実行します。CIでは `bun install --frozen-lockfile` を使用します。コミット前フックも `bun run check` を実行します。

ロビーUIの変更では `bun run --cwd apps/web build` も実行し、ブラウザで作成・参加・観戦、空一覧と取得失敗、更新と追加読み込みを確認します。PCとスマートフォンの幅で横スクロールや文字の折り返しを確認し、ダイアログのキーボード操作、閉じた後のフォーカス復帰、送信中の連打・閉鎖防止、同じタブの参加資格の再利用も確認します。「遊び方」の内容はルール正本と照合します。

ルームの確認では、PC（1280px以上）、タブレット横・縦（768〜1279px）、スマートフォン（320pxを含む）で盤面・カードの寸法とタブ切替を確認します。最大10文字の名前、待機中の盤面操作禁止、準備・開始、CPU・モード設定、投了・退室、再戦・結果ダイアログを確認します。時計は基本時間から秒読みへの切替と残り10秒／9秒、カードは脱落・接続・ホスト交代を確認します。
チャットは100文字／101文字、100件保持、入退室・CPU・形式変更ログ、初回・再接続時のtoast抑止、通常投稿とシステム通知、途中スクロールと最下部追従、タブ切替時の保持を確認します。送信後はサーバーの履歴反映を確認して入力をクリアし、拒否・切断時は入力を残します。旧投稿は読み込み時に通常投稿へ正規化し、過去200文字の履歴・通報も読み込めます。
`bun run --cwd apps/web test` は初回待機の初期盤面・再戦待機の最終盤面、入室順の配置、時計表示の境界を検証します。ルームUI変更後もWebのビルド、キーボード操作、ダイアログのフォーカス復帰、ロビーへの戻りを確認します。
盤面の `lastMove` はエンジンの着手時に更新し、ルームとともに保存・配信します。旧保存状態に座標がない場合は `null` として読み込み、次の着手から表示します。再読み込み・観戦でも最終手の枠が残り、棋譜では選択局面に追従し、開始局面では消えること、着手可能なマスの丸い点、名前と王冠の一行表示、円形の接続バッジ、3秒の通知、PCで設定展開時の配置を確認します。

招待導線ではコピー成功と手動コピー、自動ダイアログと閉鎖・再表示、資格の再利用、入力不正、送信中の連打・閉鎖、入力中の満室化・開始・閉鎖を確認します。番号再利用後の古い招待は、読み込み・参加・WebSocket接続・再接続で別の部屋へ進まないことをWorkerとWebのテストで検証します。PC・タブレット・スマホで操作とフォーカス移動を確認します。

## ブラウザ回帰テスト

初回は `cd apps/web && bunx playwright install chromium webkit` でテスト用ブラウザを用意し、ルートから `bun run --cwd apps/web test:browser` を実行します。ローカルではVite開発サーバーを `127.0.0.1:4173` で起動します。CIでは一度ビルドしたWebをVite previewで配信し、開発用モジュールの読み込みを省きます。既存の `bun run check` はブラウザテストの型チェックも含みますが、ブラウザ起動は別コマンドです。

`apps/web/browser-tests/` は実際のルート・画面・HeroUIを使う統合テストです。HTTP／WebSocket境界に固定ID・時刻の応答を用意し、ローカルWorkerや外部サービスに依存させません。hookや部品の内部状態はモックしません。幾何の検証に必要なカード部分だけ `data-testid` を使い、その他はラベルとroleから操作します。

Chromium・WebKitで320・390・650・651・767・768・900・901・1024・1279・1280・1440pxのロビーと4席の外寸、10文字名＋王冠の収まり、準備前後の外寸を確認します。ダイアログは320・390・768・1440pxで閉じるボタンの44×44px・右上12px、フォーカスと復帰、送信中の閉鎖防止、入力値、失敗表示、表示領域縮小時の操作を検証します。作成成功後の遷移、投了確認、タブ切替でのチャット入力保持、縦横のリサイズも対象です。色が未生成のまま操作テストだけ通らないよう、共通の主要ボタンがテーマ色で表示されることも確認します。

スクリーンショットはHTMLレポートへ添付し、失敗時は画面とtraceを保存します。`cd apps/web && bunx playwright show-report` で確認できます。CIのbrowserジョブはブラウザ・OS依存を含むPlaywright公式イメージ `mcr.microsoft.com/playwright:v1.63.0-noble` を使います。イメージのバージョンは `bun.lock` 内のPlaywrightと合わせて更新します。UIテストを6分割して別ランナーで並列実行し、ローカルWorkerの主要導線も独立して並行実行します。Chromium・WebKitの全ケースを維持し、ブラウザ検証全体を約3分で完了することを目標にします。ランナーの待ち時間やブラウザ準備時間は実行環境によって変わります。成功時も含めて `browser-report-<コミットSHA>-ui-1`〜`ui-6` と `browser-report-<コミットSHA>-worker` を7日間保存します。本番デプロイは通常のchecksとbrowserの両方の成功を条件とします。

現段階では画素一致の自動判定は行わず、移行前後の添付画像と寸法・操作結果を比較します。カードのアバター・名前・下段2領域は、待機／準備完了／対局中／各脱落理由／空席・CPU／ホスト交代・切断で座標と寸法を比較します。石と石数の大きさが脱落前後で変わらないこと、長い順位理由と名前が収まることを1 CSS px以内の許容差で検証します。320・900・1440pxでは一覧の取得失敗・追加読込・参加・観戦、設定・招待・準備・開始・着手・退室、再戦の結果・棋譜、チャットの入力・スクロール保持と送信を確認します。WebKitでの幅・高さ変更はiOS Safari実機でのキーボード確認とは区別し、未確認の場合は報告します。

`bun run --cwd apps/web test:browser:worker` はWebをビルドし、production設定のローカルWorker（127.0.0.1:8788、ローカルD1）でChromium・WebKitの作成・CPU対局・着手・チャット・再読み込み・退室を確認します。対局テストはAPIを差し替えません。画像変換テストでは認証APIの応答を固定し、本番ビルドのJS・WASMと実際の画像デコードを確認します。本番への接続や公開は行いません。ローカル状態は `.wrangler/production-preview`、レポートは `playwright-report-worker` に保存します。通常のブラウザテストとは別コマンドです。

## 本番デプロイ

### ブランチと公開先

最新のmainから `feat/xxx`・`fix/xxx`・`docs/xxx`・`chore/xxx` を作り、main向けPRを開きます。mainへの直接push・force pushは行いません。非公開リポジトリでは現在のGitHubプランによる保護を利用できないため、CI成功と開発者の確認を運用で必須にします。他者レビューは必須ではありません。初回も差分と検証結果の承認後にマージし、それ以降はPRのマージを公開の契機とします。

| 設定 | 本番の値 |
| --- | --- |
| Wrangler環境 | `production` |
| Worker | `tetraboard-2026` |
| URL | `https://tetraboard-2026.chaossi-lab.workers.dev` |
| D1 | `tetraboard-2026-prod-db` |
| D1接続名 | `APP_DB` |
| R2 | `tetraboard-2026-objects-prod` / `OBJECT_STORAGE` |
| Durable Object | `GAME_ROOM` / `GameRoom`（SQLite） |

本番用D1はAPACの配置ヒントで新規作成済みです。IDは `env.production.d1_databases` に記載しています。通常の `bun run dev` とWorkerテストはトップレベルのローカルDBだけを利用します。productionの `remote: false` はローカル実行時にリモートDBへ接続しない指定で、本番Workerでは本番D1へ接続します。ローカルデータは移行しません。

### 初回の認証設定

1. Cloudflareで本プロジェクト専用APIトークンを新規作成します。「Edit Cloudflare Workers」を基に、対象アカウントだけを選び、Workersの公開に必要な権限とD1の編集権限と対象R2バケットを読み書きできる権限を付与します。workers.devでの公開には独自ドメインのZone権限は不要です。ローカルWranglerのOAuthトークンや他プロジェクトのトークンは流用しません。
2. GitHubのリポジトリ設定 → Secrets and variables → Actions → Repository secretsに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録します。値をソース・PR・会話・ログに記載しません。GitHub Environmentは利用しません。
3. 初回公開直後に `bunx wrangler secret put MODERATOR_TOKEN --env production` を `apps/worker` から実行し、運営者API専用の十分に長い乱数を非表示の入力欄へ渡します。APIトークンとは別の値を使い、運営者の安全な保管先で管理します。未登録の間は運営者APIの認証は成功しません。登録後に認証付き運営者APIを確認します。

CloudflareのGit連携は設定せず、公開経路はこのリポジトリのActionsに一本化します。本番Worker・D1の名前は今後も変更せず、ドメインを変える場合も同じリソースを利用します。

### CI/CDの流れ

PRとmainのpushでは `bun install --frozen-lockfile` → `bun run check` → Webビルド → `deploy:dry-run` を実行します。並行するbrowserジョブでChromium・WebKitのUI回帰テストを実行します。PRジョブはCloudflareの認証情報を使いません。

mainでは同じ実行で生成したWeb成果物をデプロイジョブへ渡し、mainの先頭コミットであることを確認します。本番D1マイグレーション適用後にもう一度mainを確認し、古い実行ならWorkerの公開をスキップします。現行mainなら `wrangler deploy --env production` で画面とWorkerを一緒に公開します。同時デプロイを禁止し、進行中のデプロイは途中キャンセルしません。先頭確認後にmainが更新された場合は、進行中の公開完了後に次の実行で更新します。

公開後は `scripts/checkDeployment.ts` でトップページのHTML、`/api/healthz` の応答、公開ルーム一覧のスキーマを検証します。各リクエストにはタイムアウトと最大5回の再試行を設けています。チェック・マイグレーション失敗時はデプロイへ進まず、公開後の確認失敗もActionsの失敗として残ります。

### 本番構成のローカル確認

リポジトリのルートから順に実行します。

```sh
bun run check
bun run --cwd apps/web build
bun run --cwd apps/worker deploy:dry-run
bun run --cwd apps/worker db:migrate:preview
bun run --cwd apps/worker preview:production
```

最後のコマンドはローカルサーバーを継続実行します。別のターミナルで `bun scripts/checkDeployment.ts http://127.0.0.1:8788` を実行します。プレビュー用DBは `.wrangler/production-preview` に隔離し、本番には書き込みません。
ブラウザで `/games/four-reversi` と `/rooms/<ID>` を直接開き、招待・参加・観戦・CPU対戦・チャット・再接続を確認します。未知の `/api/*` がSPAのHTMLにならないこと、WebSocketのUpgradeと資格確認・部屋世代の照合が保たれることも確認します。Workerテストは `/api` 経由のJSON・認証・WebSocketと404を検証します。

初回公開後も本番URLで上記の主要導線を確認し、作成した確認用ルームから退室します。本番のマイグレーションはActionsからのみ適用し、ローカル確認時に `db:migrate:production` を使わないでください。

### 失敗時の対応と将来のドメイン

- CI失敗は修正してPRを更新します。秘密値不足や認証エラーはRepository secretsと権限を確認します。秘密値はログへ出さず、初回は必要なSecretが揃うまでマージしません。
- マイグレーションは旧コードでも動く追加変更を基本とし、破壊的な変更は段階を分けて別途承認します。マイグレーション失敗時は公開されません。適用済みの変更は公開失敗やスキップ時にも残るため、自動でDBを巻き戻しません。
- 公開後に不具合があれば、修正またはrevertのPRをCI成功後にマージして再デプロイします。DBやDurable Objectの保存形式に変更がある場合は旧コードとの互換性を確認し、互換性がなければ修正を前進適用します。
- Actionsの実行履歴とCloudflareのWorkerログで障害を確認します。デプロイ時にはWebSocketが切断されるため、公開後に再接続も確認します。
- `tetraboard.net` の設定は今回行いません。移行時に同じWorkerへ独自ドメインを設定し、旧URLの転送・オリジン変更によるタブ内参加資格の扱いを決定します。

## Code Principles

C#/.NET標準ライブラリのような、一貫性があり読みやすいコードを目指します。

過度な抽象化より、意図が明確なコードを優先します。

## Webの編集先

ロビーとルームでは `@heroui/react` v3と `@heroui/styles` を使います。スタイルの生成にTailwind CSS v4、`@tailwindcss/vite`、HeroUIのアニメーションに `tw-animate-css` を使用します。導入は通常の `bun install` に含まれ、追加のセットアップは不要です。
`main.tsx` から `shared/heroui.css` を一度だけ読み込みます。このCSS内でTailwindのtheme／utilities、HeroUIの必要な公式スタイル、`shared/theme.css` を同じ生成単位として読み込みます。テーマを別のCSS入口に分けると独自色のutilityが生成されないため、読み込みを分割しません。Tailwindの全体リセットは使わず、最小リセットと共通テーマをロビー・ルーム・Portalに適用します。

共通部品は `shared/ui/` の `AppAvatar`、`AppHeader`、`AppButton`／`AppButtonLink`、`AppTextField`、`AppCard`、`AppDialog`、`AppTabs`、`AppIcon` です。HeroUIのprops・ref・キーボード操作を引き継ぎ、繰り返す見た目は部品内のTailwindクラスへ集約します。`AppButton` は `appearance`（primary／secondary／quiet／danger）と `size`（default／compact）、`AppDialog` は `size`（default／compact）で用途を指定します。`AppTextField` はLabel・Input・Description・Errorを組み合わせ、入力プロパティとrefはInputに渡します。フィールド単位のErrorはTextFieldの `isInvalid` とともに使い、フォーム全体の通信エラーは独立したalertに表示します。

ロビー・ルームともページ別CSSと移行用ラッパーは撤去済みです。各部品のTailwindクラスを編集し、状態別クラスは静的な対応表にします。共通の見た目は `shared/ui/` に集約し、ゲーム固有の `PlayerCard`・`Stone`・`RoomClock`・`ReplayCard` はfeature側に置きます。`AppCard` の `density="compact"` はルームの狭い領域向けの余白です。`AppActionCard` と `AppSectionHeading` は操作カードと見出しの共通表現です。

CSSを追加できる範囲は `shared/theme.css` の共通テーマ／最小リセットと、`shared/effects.css` の背景・石の陰影・アニメーションです。`shared/heroui.css` は読み込み専用です。特定ページのレイアウト、通常の色や操作状態をCSSへ戻さず、同じTailwindクラス群を複製しないで共通部品を使います。Preflightを導入せず、box-sizing・margin・border幅など必要な最小リセットを共通テーマにまとめます。

ロビーはルート単位で遅延読み込みします。ダイアログのフォーカス制御・Esc・スクロール抑止はHeroUIのModalに任せ、送信中は閉鎖を無効にします。背景全体のぼかしだけを共通CSSに残し、閉じるボタンの寸法・位置、Visual Viewport内のスクロールは共通部品のクラスで指定します。

- ルート定義と部屋の存在確認：`apps/web/src/app/router.tsx`、`apps/web/src/features/room/roomLoader.ts`
- ロビー全体と入力・遊び方ダイアログ：`apps/web/src/features/lobby/FourReversiLobbyView.tsx`、`RoomEntryDialog.tsx`、`HowToPlayDialog.tsx`
- ルーム作成・入室：`apps/web/src/features/lobby/useRoomEntry.ts`
- 公開ロビー：`apps/web/src/features/lobby/useLobby.ts`、一覧表示は `LobbyList.tsx`
- ルームの接続・認証・操作：`apps/web/src/features/room/useRoomSession.ts`、HTTP処理は `roomApi.ts`
- 盤面・参加者・状況・設定：`apps/web/src/features/room/` の `FourReversiBoard`、`PlayerCard`、`RoomStatus`、`RoomInfo`。配置とタブは `RoomView.tsx`
- チャット入力・非表示・通報：`apps/web/src/features/room/useRoomChat.ts`、表示は `RoomChat.tsx`
- 招待URLの照合・共通の参加処理：`apps/web/src/shared/roomAccess.ts`、ルーム内の招待操作：`apps/web/src/features/room/useRoomInvitation.ts`
- ルーム参加資格の保存と確認：`apps/web/src/shared/roomMembership.ts`

## Naming

- ファイル名: camelCase（Reactコンポーネントファイルは基本PascalCase）
- クラス名: PascalCase
- 型名: PascalCase
- 関数・メソッド名: camelCase
- 変数名: camelCase

## Comments

コメントは日本語の丁寧体で記述します。

- 「〜を確認します。」
- 「〜を返します。」
- 「〜の場合は処理を終了します。」

コードをそのまま日本語にしただけのコメントは避け、
処理の意図や理由を説明します。

## 棋譜の確認

棋譜は新しく開始した対局から記録します。CPU対戦または4人の対戦を終局させ、最終局面が自動で選ばれること、開始局面・着手・自動パス・各種脱落をSelectと左右ボタンで確認できることを検証します。待機中の準備・設定・入退室・チャットで閲覧局面をリセットしないこと、再読み込みと再接続で復元すること、次局開始で解除されることを確認します。古い対局は最終局面のみの表示になります。
PCの盤面領域右下と、タブレット・スマートフォンの状況カード内の配置、タブ切替後の保持、キーボード選択と先頭・末尾でのボタン無効化も確認します。Workerテストは棋譜と実際の盤面の一致・パス・CPU着手・脱落原因・再取得・次局の記録更新を、Webテストは局面ラベルと自動パスの分割を検証します。表示は `ReplayCard.tsx`、選択状態は `useRoomReplay.ts`、項目の生成は `replayFrames.ts` を編集します。
スマートフォンでは320px幅も含めて、待機ラベル・棋譜カード・結果が一行に収まることと、棋譜の表示前後で状況カードの高さが変わらないことを確認します。

## ダイアログ・脱落理由の確認

PCでは棋譜表示の有無で盤面と全プレイヤーカードの座標・寸法が一致し、右下の棋譜カードと重ならないことを確認します。320px・390px・タブレット・PCでSelectの上下中央揃え、44×44pxの閉じるボタン、順位と理由・石数の収まり、観戦案内の一行表示を確認します。
ロビー・ルームのダイアログはiOS Safariのキーボード開閉、入力欄への移動、スクロール、画面回転で背景全体のぼかしと確定ボタンへの到達を確認します。実機未確認の場合は、画面幅やVisual Viewportのエミュレーションと区別して報告します。フォーカスの閉じ込めと復帰、送信中の閉鎖防止も確認します。
`Room.eliminations` は対局中の色と脱落理由を保持し、待機中と次局開始時は空になります。脱落を盤面・棋譜と同じトランザクションで記録し、GETとWebSocketに配信します。旧保存データでこの項目がない場合は保存済み棋譜から復元し、記録がなければ理由を推測しません。Workerテストは4種類の理由の保存・配信・再取得・途中観戦・旧形式の復元と次局の初期化を、Webテストは順位ラベルと記録がない場合の表示を確認します。

## Google認証とアカウント移行

### ローカル確認と本番設定

`bun run dev` は既存ローカルD1に認証テーブルも適用し、R2はローカルエミュレーターを使います。`APP_ORIGIN` の初期値は `http://localhost:5173` です。Google認証の確認はそのURLでWebを開きます。別のポートやLANのURLを使うときは、Workerの追跡対象外 `.dev.vars` で `APP_ORIGIN` を同じURLへ上書きします。Googleのコールバック設定にも同じオリジンが必要です。通常のロビー・対局はGoogle設定がなくても利用できます。

Google CloudのOAuthクライアントはWebアプリケーション用を使い、承認済みリダイレクトURIに次を登録します。

- ローカル: `http://localhost:5173/api/auth/callback/google`
- 本番: `https://tetraboard-2026.chaossi-lab.workers.dev/api/auth/callback/google`

`BETTER_AUTH_SECRET`（32文字以上の乱数）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` をローカルは `.dev.vars`、本番は `wrangler secret put <名前> --env production` で設定します。秘密値はコード・PR・会話・ログに出しません。認証処理には本番Secretが必要で、ローカルだけは開発専用Secretのフォールバックがあります。本番Secretが未設定のときに開発用の値は使いません。Googleの設定不足はログイン画面で「準備中」と案内します。旧版のSecretやCookieをコピーしてセッションを共有する必要はありません。

専用R2 `tetraboard-2026-objects-prod` は存在を確認済みです。旧版の `tetraboard-objects-prod` はそのまま保持します。バケットを公開せず、画像はWorker経由で配信します。productionのR2も `remote: false` のため、ローカルプレビューから本番画像を変更しません。D1の本番名・IDとローカル名・IDも維持します。

マイページのページ枠は `AccountPageShell` の `layout="profile"` を使います。最大幅・左右余白は共通の `shared/ui/pageLayout.ts` にまとめ、ヘッダーと一致させます。本文先頭に「ロビーへ」、その下にプロフィール＋戦績と棋譜のカードを配置します。1024px以上は左560px・間隔20px・右は残り幅、それ未満は同幅の縦並びです。ログイン・初回設定は既存のフォーム用幅と下部のロビーリンクを使います。

Webの編集先は `features/account/`、プロフィールの共通フォームは `ProfileForm.tsx`、認証処理はWorkerの `src/accounts/` です。初回設定はページ内、マイページの編集は共通 `AppDialog` 内に同じフォームを表示し、名前・ID・任意アイコンをmultipartでまとめて保存します。カメラボタンから画像を選択してプレビューし、「保存」（初回設定は「プロフィールを作成」）で反映します。アイコンの削除も同じです。フォームの `onBusyChange` で画像変換・保存中の閉鎖を防ぎ、`onSaved` で成功時にダイアログを閉じてページに通知します。閉じた未保存フォームは破棄し、再度開くと保存済みプロフィールで初期化します。

`bun run check` にCookie本人確認、期限切れ、ログアウト、Originチェック、入力境界、ID競合、画像変更・削除、移行計画、Google通信を差し替えたOAuth往復を含めます。`test:browser` にChromium／WebKitの320・390・768・1440pxでログイン・メニュー・編集・再読み込み・ログアウト、未完了誘導、編集ダイアログの開閉・フォーカス復帰・未保存変更の破棄、保存後の表示とヘッダー更新、画像変換中・送信中の連打と閉鎖防止、画像の256px WebP変換を含めます。マイページのカード配置は320・390・650・651・768・1023・1024・1440pxで、戦績の包含、左右余白、ヘッダーとの端の一致、560pxの固定幅、20pxの間隔、横並びの切り替えとロビーリンクの上部配置を検証します。画像はブラウザでもデコードして寸法を確認します。WebKitでCanvasのWebP出力が使えない場合は、承認済みの `@jsquash/webp` を遅延読み込みします。Viteではこの依存をprebundleから除外し、WASMは明示的なasset URLで読み込みます。実GoogleとのOAuthは2026-10-02に開発者によるローカル確認済みです。本番Google認証の設定・動作とiOS Safari実機のキーボード・回転確認は別途必要です。

### 旧版からの移行準備

移行対象はアカウント情報だけです。旧版Worker `tetraboard`、D1 `tetraboard-db-prod`、R2 `tetraboard-objects-prod` から、新版D1 `tetraboard-2026-prod-db` とR2 `tetraboard-2026-objects-prod` へ移します。旧版の本番スキーマとプロバイダー別件数を読み取り、2026-10-02時点でGoogle登録2件、設定完了2件、R2画像1件、外部画像URL1件を確認しました。本番データのエクスポート・コピー・書き込みはまだ行っていません。

`user` と `account` の列名・文字列ID・ミリ秒の日時は旧版と互換です。Googleの `accountId` と内部 `user.id` を保持します。名前・ID・完了状態・アップロード画像を維持し、外部画像URLは保持せずアイコン未設定へ正規化します。ゲスト・テストユーザー、旧session・verification、accessToken・refreshToken・idToken・password、戦績・棋譜・ルーム情報は移しません。Google未連携ユーザーやID不正、移行先のメール／ID／Google識別子の競合は計画作成時に停止し、推測で統合・上書きしません。

移行前に旧版の登録・編集を止める時間を開発者と決め、最新スナップショットで検証します。新版を一般利用に公開する前に移行します。公開後の移行では新旧の更新競合があるため、同じく登録・編集を止めた状態で実行します。以下はレビュー後に承認された移行で使う手順です。

1. 新版D1の認証マイグレーションを適用し、対象D1の復旧ポイントを控えます。旧版と新版のDB名・ID、Googleクライアントのコールバック、対象件数を確認します。
2. `apps/worker/scripts/accountSnapshot.sql` は移行に必要な列だけを取得します。旧版設定を明示して `wrangler d1 execute tetraboard-db-prod --env production --config <旧版wrangler.jsoncの絶対パス> --remote --file scripts/accountSnapshot.sql --json`、新版では `wrangler d1 execute APP_DB --env production --remote --file scripts/accountSnapshot.sql --json` を使います。標準出力はアクセス制限した一時ディレクトリの `source.json`・`target.json` に保存し、画面・ログ・Gitに出しません。JSON・SQLには個人情報が含まれます。
3. `apps/worker` から `bun scripts/prepareLegacyAccounts.ts <source.json> <target.json> <output.sql>` を実行します。リモートには書き込まず、移行SQLと `<output.sql>.avatars.json` を生成します。同じ既存データはスキップし、異なるプロフィールは拒否します。SQLのINSERTは競合を無視しないので、計画後に状態が変わった場合も上書きしません。
4. 合成データのテストに加えて、生成SQLをローカルD1へ適用して件数・名前・ID・Google識別子を確認します。manifestのR2キーだけを旧バケットから取得し、新バケットへ同じキーでコピーする計画を確認します。画像は取得後にWebPとしてデコードし、ハッシュ一致を確認します。旧バケットから削除しません。
5. 差分・対象件数・検証結果の開発者承認後、manifestの各キーを `wrangler r2 object get tetraboard-objects-prod/<key> --remote --file <一時ファイル>` で取得し、`wrangler r2 object put tetraboard-2026-objects-prod/<key> --remote --file <一時ファイル> --content-type image/webp` でコピーします。画像が確認できてから生成SQLを新版D1へ適用します。D1のSQLファイル適用は途中まで反映される可能性があるため、失敗時は最新スナップショットを再取得し、既存分を再検証して計画を作り直します。
6. 新版へデプロイ後、対象ユーザーがGoogleで再ログインし、初回設定を要求されず元の名前・ID・画像が表示されることを確認します。元データに外部URLがあった場合は仮アイコンが表示され、本人がアップロードして設定できます。一時ファイルは確認後に削除します。

マージ・公開・本番データの移行は、差分と確認結果に対する開発者承認後に実施します。Secret名とR2の存在確認だけでは、Google側のコールバック設定・秘密値の正しさ・CD用APIトークンのR2権限は確認できません。

## アカウントでのルーム参加

ルーム作成・参加APIはログイン中に `name` を省略できます。サーバーがCookieから本人を確認し、最新プロフィールを取得します。ゲストには従来どおり1〜10文字の `name` が必要です。内部アカウントIDや画像をJSONで指定することはできません。ログイン参加は `APP_ORIGIN` と一致するOriginを要求します。既存の参加トークンと再接続の手順は変更しません。

`0004_account_room_entry.sql` でD1に全ルーム共通の席予約・画像参照と、索引のホストアイコン列を追加します。`account_seated` / HTTP 409は既にほかの席を持つアカウント、`profile_required` / HTTP 403は初回設定未完了を示します。認証・D1取得に失敗したときはゲストへ自動降格しません。

Workerテストはサーバー本人確認、入力偽装・初回設定、同時作成・参加の排他、プロフィール編集・ログアウト・画像保持、退室・復帰期限切れ・脱落、予約中断・取消後の遅延RPCと解放の再試行を検証します。ブラウザテストはChromium・WebKitでアカウント作成・番号・招待・観戦からの参加、重複参加エラー、青いCPUアバターとロビーの人数表示を検証します。ロビーの4つの丸ぽちは人間・CPU・空席の順で緑・青・グレーにし、読み上げ用の内訳を付けます。
