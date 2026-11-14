# ローカル開発と検証

手元で開発サーバーを動かす手順と、検証コマンドの説明です。CIで何が走るかは [CIの実行範囲](../testing.md#ciの実行範囲) にあります。

## 準備

ツールの版は `mise.toml` で固定しています。初回は `mise install` と `bun install` を実行します。シェルのPATHに古いBunが残っている場合は、Bunのコマンドに `mise exec --` を付けて実行します。

## 開発サーバーと動作確認

リポジトリのルートで `bun run dev` を実行すると、WorkerのローカルD1マイグレーションを適用してからWeb・Worker・Adminの開発サーバーが同時に起動します。
どちらもLANから接続できます。

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。ポートは `/5173` ではなく `:5173` とし、例は `http://192.168.68.52:5173/` です。LANのHTTPでは `crypto.randomUUID()` が利用できないため、WebのUUID生成は `shared/createUuid.ts` の `crypto.getRandomValues()` によるUUID v4を使います。フィードバック送信ID、アクセス解析ID、スタンプのrequestIdで共用します。HTTPS限定APIを使う機能は、個別に対応可否を判定します。
通信の確認にはWorkerの `/healthz` を使います。ロビー画面にはAPIステータスや生のAPI応答を表示しません。
開発機からは `http://127.0.0.1:8787/healthz` でWorkerを直接、Viteの `Network` URLに `/api/healthz` を付けてWeb経由の通信を確認できます。

規約・年齢条件の確認後、作成と入室のHTTPリクエストに `X-Legal-Consent: 2026-10-21` を付けます。版は `packages/protocol/src/privacy.ts` の `legalVersion` と一致させます。

ルーム作成は `POST http://127.0.0.1:8787/rooms` に `{"name":"てとら","quickPlay":false,"mode":"singles"}` をJSONで送ります。`mode` は `singles` または `doubles` の必須項目です。成功応答の `room.id` に含まれる5桁のIDを使い、`GET http://127.0.0.1:8787/rooms/<ID>` で保存した部屋を確認できます。Workerを再起動した後も同じIDで取得できます。開発時のDurable ObjectとD1の状態は `apps/worker/.wrangler/state` に保存されます。D1だけを準備する場合は `bun run --cwd apps/worker db:migrate:local` を実行します。
既存ルームへの入室は `POST http://127.0.0.1:8787/rooms/<ID>/players` に `{"name":"二人目"}` をJSONで送ります。作成・入室の成功応答は `{ "room": ..., "membership": { "playerId": ..., "role": ..., "token": ... } }` です。満室なら409を返します。本人確認は `GET http://127.0.0.1:8787/rooms/<ID>/me` に `Authorization: Bearer <token>` を付けて行います。トークンは公開GETやWebSocketの応答には含めません。
Webの `/` は総合ロビーを表示します。各ゲームロビーの「CPUと遊ぶ」「公開ルームを作る」、公開一覧の「参加する」から入力ダイアログを開きます。名前などを入力して確定すると、`/rooms/<ID>` に移動します。「ルーム番号で参加」の入力入口は設けず、公開一覧と招待URLを使います。ルームページはGETで保存済みの情報を確認してから表示し、WebSocket接続後に受信したルーム情報と接続状態を表示します。別の画面からの入室もWebSocketで反映します。ページを再読み込みしても同じルームを取得できます。接続が切れた場合はGETで状態を再取得してから再接続します。開発機のブラウザで確認後、スマートフォンでもViteの `Network` URLから同じルームURLを開いて確認します。
作成・「CPUと遊ぶ」のダイアログでシングルス・ダブルスを選択します。初期値はシングルスです。「CPUと遊ぶ」を確定すると、選択したモードでホストは準備完了、CPU 3体は作成時に選んだレベル（省略時はLv1）で待機します。ホストが「対局開始」を押した後、CPUの各手番は最低2秒待ってから自動で進みます。通常の待機部屋では、ホストがCPUの追加・削除・レベル変更とモード変更を行えます。モード・時間設定の変更時は人間全員の準備状態を解除します。人間とCPUの合計が4席で、接続中の人間全員が準備完了なら開始できます。設定変更と自動着手はWebSocketのルームスナップショットで他の画面へ反映されます。
同じタブで再読み込みすると、保存した参加資格をサーバーで確認してホスト・プレイヤーの区分と「[あなた]」を表示します。別の独立したタブから資格なしで通常URLを開いた場合は観戦者として表示し、空席のある待機中なら状況カードから参加できます。
ホスト・プレイヤーのWebSocket接続は、接続後に資格トークンを送って認証します。認証後の「準備完了」「準備取消」はWebSocketメッセージで送信し、Durable Objectが本人の状態を保存して全接続へ最新のルーム情報を配信します。別のタブで同じ部屋を観戦し、表示が更新されることを確認できます。GET、再読み込み、Worker再起動後も準備状態を取得できます。観戦者や無効な資格では準備状態を変更できません。
四人リバーシの着手を確認するには、4つの独立したタブで同じルームへ入室し、全員が準備完了にします。ホストが「対局開始」を押すと担当色がランダムに割り当てられ、黒の担当者が盤面のC4をクリックできます。座標は左上A1が `{x:0,y:0}` で、C4は `{x:2,y:3}` です。Durable Objectが `packages/four-reversi` で合法手を判定し、更新した盤面と手番を全接続へ配信します。`bun run test` でエンジンの判定を確認できます。
四人リバーシのエンジンは、シングルス・ダブルスの自動パス、終局、石数と順位・勝敗の確定、脱落色を飛ばす進行を扱います。ルームは保存したモードで開始し、エンジンが終局したら前局の最終盤面と結果を保持して自動で待機状態へ戻ります。Webは最終局面から棋譜モードになり、「←」・Select・「→」で開始局面や着手・パス・脱落へ移動できます。前局の結果は「結果」ボタンでダイアログ表示します。人間のReadyを改めて揃え、ホストが次の対局を開始します。
公開ロビーは `/games/four-reversi` で表示します。`GET http://127.0.0.1:8787/rooms` はD1索引から更新時刻の新しい順に20件返し、続きは応答の `nextCursor` を `?cursor=` に指定して取得します。参加ダイアログではゲストはニックネームを入力し、ログイン中はプロフィールを確認します。観戦は入力なしでルームページを開きます。終局後は対局前として一覧に表示されます。索引の反映が遅れた場合も、参加と観戦の可否はGameRoomが判定します。今回より前に保存したローカルルームは新しい索引へ移行しないため、動作確認には新規ルームを使用します。本番D1 `tetraboard-2026-prod-db` は作成済みです。`wrangler.jsonc` の `env.production` に本番用IDを設定し、トップレベルのローカル用IDは置き換えません。本番のマイグレーションは初回公開時にCDから適用します。
4つの独立したブラウザタブで1人ずつ入室・準備完了し、ホストが開始した後、各手番の担当タブで合法手を選び続けると、終局後の再戦待機画面に同じ結果が全タブで表示されることを確認できます。1タブを再読み込みしても同じ結果が表示されます。
ルーム内チャットは認証済みのプレイヤーが送信し、観戦者も閲覧・通報できます。投稿とシステムログは合計100件を上限に再接続後も復元します。運営者APIのローカル確認では `apps/worker/.dev.vars.example` を参考に、追跡対象外の `.dev.vars` に `MODERATOR_TOKEN` を設定します。`GET /admin/reports` と `POST /admin/reports/:id/actions` にその値をBearerトークンとして渡します。通報データのマイグレーションは通常の `bun run dev` 時にも適用されます。期限切れ通報は毎時の定期処理で削除されます。
待機中の退室では席が解放され、ホストが抜けると最も早く入室した人へ役割が移ります。対局中は自分の手番で投了でき、退室や30秒の切断期限切れ、持ち時間切れでも脱落します。再読み込み・再接続が期限前なら同じ参加資格で復帰し、期限後は閲覧のみできます。対局はルームの持ち時間・秒読み設定で進み、初期設定は各人5分＋1手30秒です。GETの応答は `{ "room": ..., "presence": { "hostPlayerId": ..., "connectedPlayerIds": [...] }, "serverNowMs": ... }` で、WebSocketの `room.snapshot` にも接続情報と送信時のサーバー時刻が含まれます。接続情報は認証済みソケットから算出し、脱落後の切断・復帰も配信します。Webはこの時刻を基準に残り時間を表示します。復帰期限と時計の期限にはDurable Object Alarmを使い、Workerテストではアラームと保存済み期限を操作して確認します。以前のエンジン状態で保存されたローカルルームの移行は行わないため、進行確認には新規ルームを使用します。

招待リンクはルーム情報の「ルームを共有」で開くダイアログから取得します。`/rooms/<ID>?invite=<instanceId>` を資格のない別タブで開くと、空席のある待機中ルームでは参加ダイアログを自動表示します。閉じれば観戦でき、状況カードから再度参加できます。参加時は `POST /rooms/<ID>/players` のJSONに `instanceId` を追加し、WebSocketは `/rooms/<ID>/ws?instanceId=<instanceId>` へ接続します。識別子が不正なら400、不一致なら410を返します。従来の識別子なしリクエストも受け付けます。コピーAPIが使えないLAN上のHTTPなどでは、同じ共有ダイアログのURL欄と失敗案内から手動コピーできます。共有ダイアログ・X募集・OGPの実装は [ルーム共有の実装計画](../development.md#ルーム共有の実装計画) を参照します。

## 検証コマンド

ルートで `bun run check` を実行すると、整形確認、lint、全Workspaceの型チェック、6ゲームのエンジン、Worker、Web・Adminの表示ロジックのテストを実行します。`packages/ai` は含めず、`bun run check:ai` で検証します。`bun run test` は各workspaceのテストを自動収集します。並列数はCPU数と4の小さいほうで、Workerは `--shard` で2つのMiniflareに分けます。診断用の `bun run test:serial` は同じ全ファイルを直列実行します。WorkerのテストはCloudflare Workers実行環境でDurable ObjectとWebSocketを検証します。

`bun run typecheck` は全workspaceの `typecheck` を順番に実行し、Bun内蔵の `bun check --no-script --all` で検査します。workspaceの追加は従来どおり自動で対象になります。Webは `tsconfig.check.json` からapp・node・test・type-tests・buildの5設定、Workerは同名の設定から本体・test・scriptsの3設定を参照します。ほかのworkspaceは各 `tsconfig.json` を使い、従来の検査対象を維持します。CI選択・実行スクリプトも専用tsconfigで検査します。同時に各workspaceから全CPUを使う処理を起動しないよう、workspace間は直列にします。Web・Adminのbuild前の型検査も内蔵チェッカーを使います。Webのbuildは従来どおりapp・node・buildを検査し、共有のBun版確認スクリプトもbuild設定に含めます。

miseとCIはBun 1.4.4へ固定しています。`scripts/checkBunVersion.ts` はmiseの指定より古いBunを内蔵チェック前に拒否し、旧Bunで既存checkスクリプトが再帰実行されることを防ぎます。シェルのPATHに古いBunが残っている場合は `mise exec -- bun run typecheck` で実行してください。protocolは `types: ["bun"]` を明示し、暗黙の型定義読込みに依存しません。

比較用の従来方式は `bun run typecheck:tsc`、部分比較は `bun run --cwd <workspace> typecheck:tsc` です。通常CIで両方式を重複実行しません。Bun内蔵のTypeScriptと標準型定義はインストール済みTypeScriptやエディタの版とは独立しており、100%互換は前提にしません。診断差は比較コマンドと既存の否定fixtureで調べます。TypeScriptパッケージは比較用とWorkerテスト設定のJSONC解析にも必要なため維持します。Bunを更新するときは[測定条件と互換性の確認](../testing.md#bun-144での型チェック比較2026-10-24)も参照してください。

GitHub Actionsの実行範囲は [CIの実行範囲](../testing.md#ciの実行範囲) を参照してください。`scripts/ci/run.ts` が `packages/ai` 以外のworkspaceを並列（CPU数と4の小さいほう）で実行し、WorkerのテストはVitestの `--shard` で2つに分けます。CIは `bun install --frozen-lockfile` を使い、型検査済みのアプリを `build:assets` でビルドして型チェックの重複を避けます。

Workerテストは `vitest.config.mts` でローカルのD1・R2・SQLite対応Durable Objectとテスト専用のbindingsを指定します。追跡済みWrangler設定はJSONCとして入口・互換日・互換フラグだけを読み、Wranglerの開発用設定ローダーを通しません。管理者はテストごとに指定し、開発用 `.dev.vars`・`.env` やプロセスの秘密設定を取り込みません。詳細と回帰検証は [個人設定からの分離](../testing.md#個人設定からの分離) を参照してください。

Workerの `typecheck` は `bun run cf-typegen` を呼び、型生成の入力を追跡済み `.dev.vars.example` に固定します。`--env-file` とコマンド内の `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=true`・`CLOUDFLARE_INCLUDE_PROCESS_ENV=false` により、個人設定から型のキーを推定しません。設定例には秘密値を記載せず、秘密設定のキーを追加・削除するときは同じ変更で更新します。生成ファイルは従来どおり追跡対象外です。

Workerの `gameBoundary.test.ts` は公開 `/api` の作成・一覧・本人の履歴・戦績で、game省略のリバーシ互換、明示した両ゲームの分離、未知ID・空文字の拒否を検証します。`commonRoomBehavior.test.ts` は同じシナリオを6ゲームへ適用し、待機中の参加・観戦・準備・資格認証・接続復帰・チャットを実HTTP／WebSocketで確認します。関連テストだけを実行する場合は `bun run --cwd apps/worker test test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` を使います。共通fixtureは公開応答と対象IDに一致する通知を待ち、テスト終了時に席・資格・ソケットを解放します。

### PR提出前の検証

コード・設定変更では、PRを作成する前にルートから `bun run check` を成功させます。buildとdeployのdry-runはGitHub CIが実行します（[ADR 0007](../adr/0007-ci-and-tests.md)）。CIと同じ確認を手元で行うときは、次のコマンドを使います。

```sh
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
bun run build:development
bun run --cwd apps/worker deploy:dry-run:development
```

自動検証はBunの純粋関数テスト、Bun＋happy-domの部品・hookテスト、Worker統合テストへ集約します。ブラウザ起動・画面寸法・ネイティブ入力・実画像デコードの検証とレポート生成は廃止します。フェーズ1の目標は、手元の `bun run check` が150秒以内、CIの `checks` ジョブが4分以内です（[ADR 0008](../adr/0008-ci-single-job.md)）。[テスト方針](../testing.md)に実行環境と各検証の対応を記載します。

PR本文の書き方、PR提出後の再検証、マージの条件は [AGENTS.md](../../AGENTS.md) に従います。

### 変更内容に応じた確認

変更したロジックに応じて、既存の純粋関数・部品・hook・Worker統合テストへ確認を追加します。画面幅やブラウザ別の重複ケースは追加しません。

ロビーはゲーム別の作成・参加API、入力・時間設定、認証失効、送信ロック、取得失敗と追加取得を軽量テストで確認します。遊び方は各ゲームのルール正本と照合します。

ルームは待機中の操作禁止、準備・開始、CPU・モード・時間設定、投了・退室、再戦、接続とホスト権限、revision・局ID・送信待ちの制御をWorkerとWebのテストで確認します。時計は基本時間から秒読みへの切替、残り10秒／9秒、サーバー時刻と経過時間を確認します。
チャットは100文字／101文字、100件保持、入退室・CPU・形式変更ログ、初回・再接続時のtoast抑止、通常投稿とシステム通知を確認します。送信後はサーバーの履歴反映を確認して入力をクリアし、拒否・切断時は入力を残します。旧投稿は読み込み時に通常投稿へ正規化し、過去200文字の履歴・通報も読み込めます。途中スクロールと最下部追従、タブ切替時の保持は画面の仕様として維持します。
Webの純粋関数テストは初回待機の初期盤面・再戦待機の最終盤面、入室順、リバーシの全24配色・本人4色・観戦の黒基準・4方向の回転、脱落後の配置保持と再戦時の再抽選を確認します。直前局棋譜は盤面が前局、カードが現在の待機メンバー・入室順・準備状態であることを確認します。将棋の待機・対局・保存棋譜・持ち駒・回転は純粋関数とDOMテストを使います。
盤面の `lastMove` はエンジンの着手時に更新し、ルームとともに保存・配信します。旧保存状態に座標がない場合は `null` として読み込み、次の着手から表示します。棋譜では選択局面に追従し、開始局面では消えます。着手可能なマスの丸い点、名前と王冠の一行表示、円形の接続バッジなどの表示仕様は維持します。3秒の通知は偽時計で境界を確認します。

招待ダイアログの自動表示履歴は `useRoomInvitation` が `sessionStorage` に部屋番号・`instanceId` ごとに保存します。Reactの初期化中には書き込まず、自動表示の描画後に記録します。閉鎖前に更新しても表示済みとして扱い、手動の参加操作には影響させません。保存領域を利用できない場合も画面の操作を継続できますが、更新をまたぐ履歴保持は保証しません。招待URLの `invite` は保持し、部屋世代の検証を継続します。

招待の自動案内はタブ・ルーム世代ごとに表示時に消費し、閉じた後の更新とロビー往復では繰り返しません。独立したタブ・別世代では初回表示します。参加済み・対局中・満室では消費せず、保存領域が利用できなくても閉じて観戦・手動参加できます。`useRoomInvitation` のDOMテストと純粋関数テストで確認します。番号再利用後の古い招待は、読み込み・参加・WebSocket接続・再接続で別の部屋へ進まないことをWorkerとWebのテストで検証します。
