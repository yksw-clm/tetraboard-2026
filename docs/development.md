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
公開ロビーは `/games/four-reversi` で表示します。`GET http://127.0.0.1:8787/rooms` はD1索引から更新時刻の新しい順に20件返し、続きは応答の `nextCursor` を `?cursor=` に指定して取得します。参加にはダイアログでニックネームを入力し、観戦は入力なしでルームページを開きます。終局後は対局前として一覧に表示されます。索引の反映が遅れた場合も、参加と観戦の可否はGameRoomが判定します。今回より前に保存したローカルルームは新しい索引へ移行しないため、動作確認には新規ルームを使用します。本番D1 `tetraboard-2026-prod-db` は作成済みです。`wrangler.jsonc` の `env.production` に本番用IDを設定し、トップレベルのローカル用IDは置き換えません。本番のマイグレーションは初回公開時にCDから適用します。
4つの独立したブラウザタブで1人ずつ入室・準備完了し、ホストが開始した後、各手番の担当タブで合法手を選び続けると、終局後の再戦待機画面に同じ結果が全タブで表示されることを確認できます。1タブを再読み込みしても同じ結果が表示されます。
ルーム内チャットは認証済みのプレイヤーが送信し、観戦者も閲覧・通報できます。投稿とシステムログは合計100件を上限に再接続後も復元します。運営者APIのローカル確認では `apps/worker/.dev.vars.example` を参考に、追跡対象外の `.dev.vars` に `MODERATOR_TOKEN` を設定します。`GET /admin/reports` と `POST /admin/reports/:id/actions` にその値をBearerトークンとして渡します。通報データのマイグレーションは通常の `bun run dev` 時にも適用されます。期限切れ通報は毎時の定期処理で削除されます。
待機中の退室では席が解放され、ホストが抜けると最も早く入室した人へ役割が移ります。対局中は自分の手番で投了でき、退室や30秒の切断期限切れ、持ち時間切れでも脱落します。再読み込み・再接続が期限前なら同じ参加資格で復帰し、期限後は閲覧のみできます。対局は各人5分の基本時間と、基本時間消費後の1手30秒の秒読みで進みます。GETの応答は `{ "room": ..., "presence": { "hostPlayerId": ..., "connectedPlayerIds": [...] }, "serverNowMs": ... }` で、WebSocketの `room.snapshot` にも接続情報と送信時のサーバー時刻が含まれます。接続情報は認証済みソケットから算出し、脱落後の切断・復帰も配信します。Webはこの時刻を基準に残り時間を表示します。復帰期限と時計の期限にはDurable Object Alarmを使い、Workerテストではアラームと保存済み期限を操作して確認します。以前のエンジン状態で保存されたローカルルームの移行は行わないため、進行確認には新規ルームを使用します。

招待リンクはルーム情報の「招待リンクをコピー」から取得します。`/rooms/<ID>?invite=<instanceId>` を資格のない別タブで開くと、空席のある待機中ルームでは参加ダイアログを自動表示します。閉じれば観戦でき、状況カードから再度参加できます。参加時は `POST /rooms/<ID>/players` のJSONに `instanceId` を追加し、WebSocketは `/rooms/<ID>/ws?instanceId=<instanceId>` へ接続します。識別子が不正なら400、不一致なら410を返します。従来の識別子なしリクエストも受け付けます。コピーAPIが使えないLAN上のHTTPなどでは、手動コピー用のダイアログを表示します。

## Checks

ルートで `bun run check` を実行すると、整形確認、lint、全Workspaceの型チェック、四人リバーシ、Worker、Webの表示ロジックのテストを実行します。`bun run test` では3つのテストのみを実行します。WorkerのテストはCloudflare Workers実行環境でDurable ObjectとWebSocketを検証します。

GitHub Actionsは `main` へのpushと `main` 宛てのPRで整形・lint・型チェック・テストに加え、Webビルドと本番デプロイのdry-runを実行します。CIでは `bun install --frozen-lockfile` を使用します。コミット前フックも `bun run check` を実行します。

ロビーUIの変更では `bun run --cwd apps/web build` も実行し、ブラウザで作成・参加・観戦、空一覧と取得失敗、更新と追加読み込みを確認します。PCとスマートフォンの幅で横スクロールや文字の折り返しを確認し、ダイアログのキーボード操作、閉じた後のフォーカス復帰、送信中の連打・閉鎖防止、同じタブの参加資格の再利用も確認します。「遊び方」の内容はルール正本と照合します。

ルームの確認では、PC（1280px以上）、タブレット横・縦（768〜1279px）、スマートフォン（320pxを含む）で盤面・カードの寸法とタブ切替を確認します。最大10文字の名前、待機中の盤面操作禁止、準備・開始、CPU・モード設定、投了・退室、再戦・結果ダイアログを確認します。時計は基本時間から秒読みへの切替と残り10秒／9秒、カードは脱落・接続・ホスト交代を確認します。
チャットは100文字／101文字、100件保持、入退室・CPU・形式変更ログ、初回・再接続時のtoast抑止、通常投稿とシステム通知、途中スクロールと最下部追従、タブ切替時の保持を確認します。送信後はサーバーの履歴反映を確認して入力をクリアし、拒否・切断時は入力を残します。旧投稿は読み込み時に通常投稿へ正規化し、過去200文字の履歴・通報も読み込めます。
`bun run --cwd apps/web test` は初回待機の初期盤面・再戦待機の最終盤面、入室順の配置、時計表示の境界を検証します。ルームUI変更後もWebのビルド、キーボード操作、ダイアログのフォーカス復帰、ロビーへの戻りを確認します。
盤面の `lastMove` はエンジンの着手時に更新し、ルームとともに保存・配信します。旧保存状態に座標がない場合は `null` として読み込み、次の着手から表示します。再読み込み・観戦でも最終手の枠が残り、棋譜では選択局面に追従し、開始局面では消えること、着手可能なマスの丸い点、名前と王冠の一行表示、円形の接続バッジ、3秒の通知、PCで設定展開時の配置を確認します。

招待導線ではコピー成功と手動コピー、自動ダイアログと閉鎖・再表示、資格の再利用、入力不正、送信中の連打・閉鎖、入力中の満室化・開始・閉鎖を確認します。番号再利用後の古い招待は、読み込み・参加・WebSocket接続・再接続で別の部屋へ進まないことをWorkerとWebのテストで検証します。PC・タブレット・スマホで操作とフォーカス移動を確認します。

## ブラウザ回帰テスト

初回は `cd apps/web && bunx playwright install chromium webkit` でテスト用ブラウザを用意し、ルートから `bun run --cwd apps/web test:browser` を実行します。Viteを `127.0.0.1:4173` で起動します。既存の `bun run check` はブラウザテストの型チェックも含みますが、ブラウザ起動は別コマンドです。

`apps/web/browser-tests/` は実際のルート・画面・HeroUIを使う統合テストです。HTTP／WebSocket境界に固定ID・時刻の応答を用意し、ローカルWorkerや外部サービスに依存させません。hookや部品の内部状態はモックしません。幾何の検証に必要なカード部分だけ `data-testid` を使い、その他はラベルとroleから操作します。

Chromium・WebKitで320・390・650・651・767・768・900・901・1024・1279・1280・1440pxのロビーと4席の外寸、10文字名＋王冠の収まり、準備前後の外寸を確認します。ダイアログは320・390・768・1440pxで閉じるボタンの44×44px・右上12px、フォーカスと復帰、送信中の閉鎖防止、入力値、失敗表示、表示領域縮小時の操作を検証します。作成成功後の遷移、投了確認、タブ切替でのチャット入力保持、縦横のリサイズも対象です。色が未生成のまま操作テストだけ通らないよう、共通の主要ボタンがテーマ色で表示されることも確認します。

スクリーンショットはHTMLレポートへ添付し、失敗時は画面とtraceを保存します。`cd apps/web && bunx playwright show-report` で確認できます。CIのbrowserジョブは両ブラウザを実行し、成功時も含めて `browser-report-<コミットSHA>` を7日間保存します。本番デプロイは通常のchecksとbrowserの両方の成功を条件とします。

現段階では画素一致の自動判定は行わず、移行前後の添付画像と寸法・操作結果を比較します。プレイヤーカード内部の状態別固定領域、全脱落理由、棋譜・チャットの全導線は後続のルーム移行で拡充します。WebKitでの幅・高さ変更はiOS Safari実機でのキーボード確認とは区別し、未確認の場合は報告します。

## 本番デプロイ

### ブランチと公開先

最新のmainから `feat/xxx`・`fix/xxx`・`docs/xxx`・`chore/xxx` を作り、main向けPRを開きます。mainへの直接push・force pushは行いません。非公開リポジトリでは現在のGitHubプランによる保護を利用できないため、CI成功と開発者の確認を運用で必須にします。他者レビューは必須ではありません。初回も差分と検証結果の承認後にマージし、それ以降はPRのマージを公開の契機とします。

| 設定 | 本番の値 |
| --- | --- |
| Wrangler環境 | `production` |
| Worker | `tetraboard-2026` |
| URL | `https://tetraboard-2026.chaossi-lab.workers.dev` |
| D1 | `tetraboard-2026-prod-db` |
| D1接続名 | `LOBBY_DB` |
| Durable Object | `GAME_ROOM` / `GameRoom`（SQLite） |

本番用D1はAPACの配置ヒントで新規作成済みです。IDは `env.production.d1_databases` に記載しています。通常の `bun run dev` とWorkerテストはトップレベルのローカルDBだけを利用します。productionの `remote: false` はローカル実行時にリモートDBへ接続しない指定で、本番Workerでは本番D1へ接続します。ローカルデータは移行しません。

### 初回の認証設定

1. Cloudflareで本プロジェクト専用APIトークンを新規作成します。「Edit Cloudflare Workers」を基に、対象アカウントだけを選び、Workersの公開に必要な権限とD1の編集権限を付与します。workers.devでの公開には独自ドメインのZone権限は不要です。ローカルWranglerのOAuthトークンや他プロジェクトのトークンは流用しません。
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

共通部品は `shared/ui/` の `AppHeader`、`AppButton`／`AppButtonLink`、`AppTextField`、`AppCard`、`AppDialog`、`AppTabs`、`AppIcon` です。HeroUIのprops・ref・キーボード操作を引き継ぎ、繰り返す見た目は部品内のTailwindクラスへ集約します。`AppButton` は `appearance`（primary／secondary／quiet／danger）と `size`（default／compact）、`AppDialog` は `size`（default／compact）で用途を指定します。`AppTextField` はLabel・Input・Description・Errorを組み合わせ、入力プロパティとrefはInputに渡します。フィールド単位のErrorはTextFieldの `isInvalid` とともに使い、フォーム全体の通信エラーは独立したalertに表示します。

現在は共通基盤への移行段階です。ヘッダー・ダイアログ・参加フォーム・アイコンを共通化し、カードとタブは後続のページ移行で適用します。`LobbyDialog`／`RoomDialog` とアイコンの薄いラッパーは未移行の本文・寸法用CSSを引き継ぎます。`lobby.css` と `room.css` は `shared/heroui.css` からcomponents layerに読み込み、共通部品のutilitiesを優先します。各ページの移行完了時に旧CSSと互換ラッパーを削除します。新しいページCSSや旧CSSの重複追加は行いません。

ロビーはルート単位で遅延読み込みします。ダイアログのフォーカス制御・Esc・スクロール抑止はHeroUIのModalに任せ、送信中は閉鎖を無効にします。背景全体のぼかしだけを共通CSSに残し、閉じるボタンの寸法・位置、Visual Viewport内のスクロールは共通部品のクラスで指定します。

- ルート定義と部屋の存在確認：`apps/web/src/app/router.tsx`、`apps/web/src/features/room/roomLoader.ts`
- ロビー全体と入力・遊び方ダイアログ：`apps/web/src/features/lobby/FourReversiLobbyView.tsx`、`RoomEntryDialog.tsx`、`HowToPlayDialog.tsx`、スタイルは同じ場所の `lobby.css`
- ルーム作成・入室：`apps/web/src/features/lobby/useRoomEntry.ts`
- 公開ロビー：`apps/web/src/features/lobby/useLobby.ts`、一覧表示は `LobbyList.tsx`
- ルームの接続・認証・操作：`apps/web/src/features/room/useRoomSession.ts`、HTTP処理は `roomApi.ts`
- 盤面・参加者・状況・設定：`apps/web/src/features/room/` の `FourReversiBoard`、`PlayerCard`、`RoomStatus`、`RoomInfo`。配置とタブは `RoomView.tsx`、スタイルは `room.css`
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
