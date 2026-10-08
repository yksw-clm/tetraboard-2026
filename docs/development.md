# Development

## Development Strategy

土台 → Vertical Slice → ロビー → ルーム → 四人リバーシ → E2E
の順で開発します。

## ゲームIDと軽量カタログ

ゲームIDの正本は `packages/protocol/src/games.ts` の `gameIds` です。追加時は同じファイルの `gameCatalog` に表示名・ロビーパス・ランキングAPIパスを登録します。`GameId` は実ゲームだけ、`GameScope` は集計・フィードバックなどのサービス全体を表す `all` も含みます。`all` をルームや対局のゲームとして渡しません。既定ゲームは `defaultGameId` の四人リバーシです。

表示名・選択肢・パスだけが必要な画面は `@tetraboard/protocol/games` を直接参照します。この入口にはZod・React・エンジン・CPUを持ち込まず、検証スキーマは別の `gameSchemas.ts` に置きます。テーマとルール表示、ゲーム固有の処理は各アプリで管理します。カタログへの登録だけで新ゲームの対局機能が実装されるわけではありません。

IDと `all` の境界・既定値は `bun run --cwd apps/worker test test/gameCatalog.test.ts test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` で確認します。軽量入口の依存は `bun build packages/protocol/src/games.ts --target=browser --outfile=/tmp/tetraboard-game-catalog.js --metafile=/tmp/tetraboard-game-catalog.meta.json` の入力一覧で確認できます。

## Local Development

リポジトリのルートで `bun run dev` を実行すると、WorkerのローカルD1マイグレーションを適用してからWebとWorkerの開発サーバーが同時に起動します。
どちらもLANから接続できます。

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。ポートは `/5173` ではなく `:5173` とし、例は `http://192.168.68.52:5173/` です。LANのHTTPでは `crypto.randomUUID()` が利用できないため、WebのUUID生成は `shared/createUuid.ts` の `crypto.getRandomValues()` によるUUID v4を使います。フィードバック送信IDとアクセス解析IDで共用します。HTTPS限定APIを使う機能は、個別に対応可否を判定します。
通信の確認にはWorkerの `/healthz` を使います。ロビー画面にはAPIステータスや生のAPI応答を表示しません。
開発機からは `http://127.0.0.1:8787/healthz` でWorkerを直接、Viteの `Network` URLに `/api/healthz` を付けてWeb経由の通信を確認できます。

ルーム作成は `POST http://127.0.0.1:8787/rooms` に `{"name":"てとら","quickPlay":false,"mode":"singles"}` をJSONで送ります。`mode` は `singles` または `doubles` の必須項目です。成功応答の `room.id` に含まれる5桁のIDを使い、`GET http://127.0.0.1:8787/rooms/<ID>` で保存した部屋を確認できます。Workerを再起動した後も同じIDで取得できます。開発時のDurable ObjectとD1の状態は `apps/worker/.wrangler/state` に保存されます。D1だけを準備する場合は `bun run --cwd apps/worker db:migrate:local` を実行します。
既存ルームへの入室は `POST http://127.0.0.1:8787/rooms/<ID>/players` に `{"name":"二人目"}` をJSONで送ります。作成・入室の成功応答は `{ "room": ..., "membership": { "playerId": ..., "role": ..., "token": ... } }` です。満室なら409を返します。本人確認は `GET http://127.0.0.1:8787/rooms/<ID>/me` に `Authorization: Bearer <token>` を付けて行います。トークンは公開GETやWebSocketの応答には含めません。
Webの `/` は履歴を置き換えて `/games/four-reversi` へ転送します。四人リバーシ専用ロビーで「ルームを作る」「ルーム番号で参加」などを押すと、入力ダイアログを開きます。ニックネームなどを入力して確定すると、`/rooms/<ID>` に移動します。ルームページはGETで保存済みの情報を確認してから表示し、WebSocket接続後に受信したルーム情報と接続状態を表示します。別の画面からの入室もWebSocketで反映します。ページを再読み込みしても同じルームを取得できます。接続が切れた場合はGETで状態を再取得してから再接続します。開発機のブラウザで確認後、スマートフォンでもViteの `Network` URLから同じルームURLを開いて確認します。
作成・「すぐ遊ぶ」のダイアログでシングルス・ダブルスを選択します。初期値はシングルスです。「すぐ遊ぶ」を確定すると、選択したモードでホストは準備完了、CPU 3体はレベル1で待機します。ホストが「対局開始」を押した後、CPUの手番は約0.5秒後に自動で進みます。通常の待機部屋では、ホストがCPUの追加・削除・レベル変更とモード変更を行えます。モード・時間設定の変更時は人間全員の準備状態を解除します。人間とCPUの合計が4席で、接続中の人間全員が準備完了なら開始できます。設定変更と自動着手はWebSocketのルームスナップショットで他の画面へ反映されます。
同じタブで再読み込みすると、保存した参加資格をサーバーで確認してホスト・プレイヤーの区分と「[あなた]」を表示します。別の独立したタブから資格なしで通常URLを開いた場合は観戦者として表示し、空席のある待機中なら状況カードから参加できます。
ホスト・プレイヤーのWebSocket接続は、接続後に資格トークンを送って認証します。認証後の「準備完了」「準備取消」はWebSocketメッセージで送信し、Durable Objectが本人の状態を保存して全接続へ最新のルーム情報を配信します。別のタブで同じ部屋を観戦し、表示が更新されることを確認できます。GET、再読み込み、Worker再起動後も準備状態を取得できます。観戦者や無効な資格では準備状態を変更できません。
四人リバーシの着手を確認するには、4つの独立したタブで同じルームへ入室し、全員が準備完了にします。ホストが「対局開始」を押すと担当色がランダムに割り当てられ、黒の担当者が盤面のC4をクリックできます。座標は左上A1が `{x:0,y:0}` で、C4は `{x:2,y:3}` です。Durable Objectが `packages/four-reversi` で合法手を判定し、更新した盤面と手番を全接続へ配信します。`bun run test` でエンジンの判定を確認できます。
四人リバーシのエンジンは、シングルス・ダブルスの自動パス、終局、石数と順位・勝敗の確定、脱落色を飛ばす進行を扱います。ルームは保存したモードで開始し、エンジンが終局したら前局の最終盤面と結果を保持して自動で待機状態へ戻ります。Webは最終局面から棋譜モードになり、「←」・Select・「→」で開始局面や着手・パス・脱落へ移動できます。前局の結果は「結果」ボタンでダイアログ表示します。人間のReadyを改めて揃え、ホストが次の対局を開始します。
公開ロビーは `/games/four-reversi` で表示します。`GET http://127.0.0.1:8787/rooms` はD1索引から更新時刻の新しい順に20件返し、続きは応答の `nextCursor` を `?cursor=` に指定して取得します。参加ダイアログではゲストはニックネームを入力し、ログイン中はプロフィールを確認します。観戦は入力なしでルームページを開きます。終局後は対局前として一覧に表示されます。索引の反映が遅れた場合も、参加と観戦の可否はGameRoomが判定します。今回より前に保存したローカルルームは新しい索引へ移行しないため、動作確認には新規ルームを使用します。本番D1 `tetraboard-2026-prod-db` は作成済みです。`wrangler.jsonc` の `env.production` に本番用IDを設定し、トップレベルのローカル用IDは置き換えません。本番のマイグレーションは初回公開時にCDから適用します。
4つの独立したブラウザタブで1人ずつ入室・準備完了し、ホストが開始した後、各手番の担当タブで合法手を選び続けると、終局後の再戦待機画面に同じ結果が全タブで表示されることを確認できます。1タブを再読み込みしても同じ結果が表示されます。
ルーム内チャットは認証済みのプレイヤーが送信し、観戦者も閲覧・通報できます。投稿とシステムログは合計100件を上限に再接続後も復元します。運営者APIのローカル確認では `apps/worker/.dev.vars.example` を参考に、追跡対象外の `.dev.vars` に `MODERATOR_TOKEN` を設定します。`GET /admin/reports` と `POST /admin/reports/:id/actions` にその値をBearerトークンとして渡します。通報データのマイグレーションは通常の `bun run dev` 時にも適用されます。期限切れ通報は毎時の定期処理で削除されます。
待機中の退室では席が解放され、ホストが抜けると最も早く入室した人へ役割が移ります。対局中は自分の手番で投了でき、退室や30秒の切断期限切れ、持ち時間切れでも脱落します。再読み込み・再接続が期限前なら同じ参加資格で復帰し、期限後は閲覧のみできます。対局はルームの持ち時間・秒読み設定で進み、初期設定は各人5分＋1手30秒です。GETの応答は `{ "room": ..., "presence": { "hostPlayerId": ..., "connectedPlayerIds": [...] }, "serverNowMs": ... }` で、WebSocketの `room.snapshot` にも接続情報と送信時のサーバー時刻が含まれます。接続情報は認証済みソケットから算出し、脱落後の切断・復帰も配信します。Webはこの時刻を基準に残り時間を表示します。復帰期限と時計の期限にはDurable Object Alarmを使い、Workerテストではアラームと保存済み期限を操作して確認します。以前のエンジン状態で保存されたローカルルームの移行は行わないため、進行確認には新規ルームを使用します。

招待リンクはルーム情報の「招待リンクをコピー」から取得します。`/rooms/<ID>?invite=<instanceId>` を資格のない別タブで開くと、空席のある待機中ルームでは参加ダイアログを自動表示します。閉じれば観戦でき、状況カードから再度参加できます。参加時は `POST /rooms/<ID>/players` のJSONに `instanceId` を追加し、WebSocketは `/rooms/<ID>/ws?instanceId=<instanceId>` へ接続します。識別子が不正なら400、不一致なら410を返します。従来の識別子なしリクエストも受け付けます。コピーAPIが使えないLAN上のHTTPなどでは、手動コピー用のダイアログを表示します。

## Checks

ルートで `bun run check` を実行すると、整形確認、lint、全Workspaceの型チェック、四人リバーシ・四人将棋、Worker、Web・Adminの表示ロジックのテストを実行します。`bun run test` では両エンジン・Worker・Web・Adminのテストを実行します。WorkerのテストはCloudflare Workers実行環境でDurable ObjectとWebSocketを検証します。

GitHub Actionsは `main` へのpushと `main` 宛てのPRで整形・lint・型チェック・テストに加え、Web・Adminのビルドと本番デプロイのdry-runを実行します。CIでは `bun install --frozen-lockfile` を使用します。コミット前フックも `bun run check` を実行します。

Workerの `gameBoundary.test.ts` は公開 `/api` の作成・一覧・本人の履歴・戦績で、game省略のリバーシ互換、明示した両ゲームの分離、未知ID・空文字の拒否を検証します。`commonRoomBehavior.test.ts` は同じシナリオを両ゲームへ適用し、待機中の参加・観戦・準備・資格認証・接続復帰・チャットを実HTTP／WebSocketで確認します。関連テストだけを実行する場合は `bun run --cwd apps/worker test test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` を使います。共通fixtureは公開応答と対象IDに一致する通知を待ち、テスト終了時に席・資格・ソケットを解放します。

### PR提出前の検証

コード・設定変更では、PRを作成する前にルートから次の全コマンドを成功させます。

```sh
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
```

自動検証はBunの純粋関数テスト、Bun＋happy-domの部品・hookテスト、Worker統合テストへ集約します。ブラウザ起動・画面寸法・ネイティブ入力・実画像デコードの検証とレポート生成は廃止します。`bun run check` の目標は180秒以内です。[テスト方針・移管対応表](testing.md)に実行環境と各検証の対応を記載します。

PR本文には検証対象コミット、実行環境、各コマンドの結果、未確認事項を記載します。PR提出後にコード・設定を変更した場合と、main取り込みでコード・設定が変わった場合も上記の必須コマンドを再実行して結果を更新します。文書だけの変更では同一コード・設定の直前の成功結果を再利用できますが、検証済みコミットを明記し、文書の整形確認と `git diff --check` は最終差分で行います。マージはGitHub CI成功、必須のローカル検証成功、差分と結果に対する開発者の承認を条件とし、ローカル成功でGitHub CIを代替しません。

### 変更内容に応じた確認

変更したロジックに応じて、既存の純粋関数・部品・hook・Worker統合テストへ確認を追加します。画面幅やブラウザ別の重複ケースは追加しません。

ロビーはゲーム別の作成・参加API、入力・時間設定、認証失効、送信ロック、取得失敗と追加取得を軽量テストで確認します。遊び方は各ゲームのルール正本と照合します。

ルームは待機中の操作禁止、準備・開始、CPU・モード・時間設定、投了・退室、再戦、接続とホスト権限、revision・局ID・送信待ちの制御をWorkerとWebのテストで確認します。時計は基本時間から秒読みへの切替、残り10秒／9秒、サーバー時刻と経過時間を確認します。
チャットは100文字／101文字、100件保持、入退室・CPU・形式変更ログ、初回・再接続時のtoast抑止、通常投稿とシステム通知を確認します。送信後はサーバーの履歴反映を確認して入力をクリアし、拒否・切断時は入力を残します。旧投稿は読み込み時に通常投稿へ正規化し、過去200文字の履歴・通報も読み込めます。途中スクロールと最下部追従、タブ切替時の保持は画面の仕様として維持します。
Webの純粋関数テストは初回待機の初期盤面・再戦待機の最終盤面、入室順、リバーシの全24配色・本人4色・観戦の黒基準・4方向の回転、脱落後の配置保持と再戦時の再抽選を確認します。直前局棋譜は盤面が前局、カードが現在の待機メンバー・入室順・準備状態であることを確認します。将棋の待機・対局・保存棋譜・持ち駒・回転は純粋関数とDOMテストを使います。
盤面の `lastMove` はエンジンの着手時に更新し、ルームとともに保存・配信します。旧保存状態に座標がない場合は `null` として読み込み、次の着手から表示します。棋譜では選択局面に追従し、開始局面では消えます。着手可能なマスの丸い点、名前と王冠の一行表示、円形の接続バッジなどの表示仕様は維持します。3秒の通知は偽時計で境界を確認します。

招待ダイアログの自動表示履歴は `useRoomInvitation` が `sessionStorage` に部屋番号・`instanceId` ごとに保存します。Reactの初期化中には書き込まず、自動表示の描画後に記録します。閉鎖前に更新しても表示済みとして扱い、手動の参加操作には影響させません。保存領域を利用できない場合も画面の操作を継続できますが、更新をまたぐ履歴保持は保証しません。招待URLの `invite` は保持し、部屋世代の検証を継続します。

招待の自動案内はタブ・ルーム世代ごとに表示時に消費し、閉じた後の更新とロビー往復では繰り返しません。独立したタブ・別世代では初回表示します。参加済み・対局中・満室では消費せず、保存領域が利用できなくても閉じて観戦・手動参加できます。`useRoomInvitation` のDOMテストと純粋関数テストで確認します。番号再利用後の古い招待は、読み込み・参加・WebSocket接続・再接続で別の部屋へ進まないことをWorkerとWebのテストで検証します。

## ゲームの必須登録と型の対応

ゲームIDの正本は `packages/protocol/src/games.ts`、具体型の対応は型専用の `gameTypes.ts` です。`RoomFor<G>`・`MatchFor<G>`・`ActionFor<G>` と着手コマンド型でゲームを対応付けます。将棋の着手には局IDとrevisionが必須、リバーシの石置きには付けません。通信スキーマによる実行時検証も継続します。

ゲーム追加時にはprotocolの型対応と `gameRankingContracts`、Workerの `waitingRoomFactories`・`rankingReaders`、Webの `createRoomRequests`・`lobbyRoutes`・`liveViews`・`replayLoaders`・`replayViews` を登録します。各表は `GameId` のmapped typeと `satisfies` で検証します。異なるRoom／Matchを渡す入口はゲームで判別するunionを明示的に分岐し、残りを `assertNever` で確認します。カタログへエンジンやスキーマを追加しません。

Webはstrict型検査を使います。`bun run --cwd apps/web typecheck` とWorkerのtypecheckは型検査専用fixtureを含み、登録漏れ・ゲーム取り違え・局面情報や棋譜フレームの欠落を `@ts-expect-error` で確認します。境界の確認は `bun run --cwd apps/worker test -- gameBoundary.test.ts commonRoomBehavior.test.ts rankingBoundary.test.ts` と `bun run --cwd apps/web test` で実行します。

ライブのsession／viewと保存棋譜の前処理／viewはゲーム別に遅延読み込みします。共通カード・名前・席順・時計表示はエンジン実装に依存しません。Webビルドは生成チャンクの静的依存を検査し、別ゲームのエンジン参照、入口へのライブ・棋譜処理の混入、CPU実装の出力を拒否します。Rolldownが残す空モジュールのregionとReact Compilerの共通runtime初期化は実装として数えません。検査結果は追跡対象外の `apps/web/node_modules/.tmp/game-chunks.json` に保存します。WASMは同一originのasset URLと出力バイナリをビルド時に検査します。PR前の全コマンドは上記の順番で実行します。

## 共有transportとゲーム別session

`useRoomTransport` は通信契約の解析、Roomの型ガード、認証・準備・チャット・再接続と送信待ちの管理を担当します。開始待ちとゲーム操作待ちは内部の判別unionで区別します。`gameSessionTypes.ts` はゲームIDに待機データと固有設定コマンドを対応付ける型だけの表です。将棋の着手・提案待ちは局IDとrevisionを必須にし、リバーシの固有設定コマンドは `never` にします。

各sessionは、具体的なRoomと待機データを受け取る `fourReversiSessionBehavior.ts`／`fourShogiSessionBehavior.ts` の純粋な完了判定と固有エラー文言をtransportへ渡します。判定関数はモジュールで定義し、再描画でWebSocketを張り直さない参照にします。開始待ちは対局開始、リバーシの着手待ちは手数の増加、将棋の着手待ちはrevision増加・局変更で解除します。投了は本人の脱落を確認します。将棋の提案・取消は状態反映も確認し、待機への移行・エラー・送信失敗・切断での既存解除条件を維持します。

引分操作と三人攻撃禁止の送信は将棋session、表示は将棋viewが担当します。`RoomViewShell` から共有の状況カード・設定フォームへ任意の `turnActions`／`gameSettings` を渡し、リバーシは渡しません。共有UIは固有操作を送信しません。時計計算・表示と手番への対応、WorkerのGameRoom・CPU・Alarm・ライフサイクルの分離は #57、保存形式・棋譜互換・戦績SQL・保存再試行は #58 の範囲です。

`roomSession.test.tsx` と `sessionBehavior.test.ts` は通信境界と状態モデルを使い、開始・着手・投了・提案の待ち保持と解除、本人と他人の脱落、同revisionでの提案反映、新局・終局、設定権限を確認します。サーバーでの配信・準備解除はWorker統合テスト、型の取り違えと局面情報欠落の否定ケースは `bun run --cwd apps/web typecheck` で確認します。

## ルームの共通効果音

添付された5種類のMP3を `apps/web/src/assets/sounds/` に保持し、Viteのasset URLで同一originから配信します。`shared/soundEffects.ts` のページ共通プレイヤーはロビー・ルームで音源を先読みし、ユーザー操作のcaptureでambientの設定、単一AudioContextの作成・resumeを非同期操作より先に実行します。Web Audio未対応時には代替のHTML音声再生を使いません。デコード済み音源を再利用し、非表示・切断・ルーム離脱では再生中・予約中の音を停止します。音声の失敗はゲームのエラーへ伝播しません。

`RoomSoundTracker` は共有transportの各スナップショットを受信順で比較します。各sessionからゲーム別の純粋な音声状態の読取りを渡し、着手は手数、開始・終了は状態遷移、参加・CPU追加は新しい席IDで判定します。将棋のrevisionだけの変化と棋譜表示は着手にしません。終局の最終着手はlastRoundから検出します。リバーシの公開中の局IDはないため、同一接続内の開始・終局で局を区切り、接続・可視状態の切替で比較基準を破棄します。非表示からの復帰時は音声のための公開GETで最新状態を基準にし、その応答時刻以前に送信されたWebSocket通知は音声の比較へ戻しません。再取得失敗時は音声の通知だけを停止し、次の復帰・再接続で再開します。

本人の合法手の送信成功時に着手音を再生し、局・期待手数・担当色／方向・着手内容が一致した通知だけを抑止します。拒否・切断・終局・次局開始で抑止を解除します。HTTP参加成功とWebSocketの新規席通知は部屋世代・プレイヤーIDでjoinを重複抑止し、新規参加と既存資格の再利用を参加処理の返値で区別します。参加者へ切り替わる再マウントでは再演しません。公開通信契約・Worker・エンジン・保存形式は変更しません。

部分検証は `bun test --cwd apps/web ./test/roomSoundEvents.test.ts ./test/roomInvitation.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomSounds.test.tsx ./test-dom/soundPlayer.test.ts` を使います。音声API・時刻・取得を制御し、実デコード・ネイティブ操作・他アプリとの同時再生は自動テストに含めません。マージ前にiPhone Safari／Android ChromeでYouTubeとの同時再生、初回有効化、消音モード、スピーカー・イヤホン、アプリ切替からの復帰を実機確認し、端末・OS・ブラウザの版と結果を記載します。

## Workerの時計計算と期限選択

`apps/worker/src/rooms/clockCore.ts` は席IDを型パラメータとする内部時計型と純粋な初期化・手番更新・停止計算を持ちます。`clock.ts`／`shogiClock.ts` はColor／Sideの具体的な4キーの残時間recordを作り、既存の引数・既定値・戻り値・overloadを保つwrapperです。基本時間は前手番の経過だけ減算し、手番が変わらない脱落では同じ時計を保持します。リバーシの自動パスで同じ色へ戻る場合は完了した1手として秒読みをリセットします。共通計算へゲームエンジンを読み込みません。

`roomDeadlines.ts` は現在の時計期限・プレイヤー配列の復帰期限・呼び出し側の現在時刻から、到達済みの次イベントと確定時刻を返します。早い期限を先に、同時刻なら時間切れを先に、切断同士の同時刻なら現在の配列順に選びます。GameRoomは処理のたびに更新後の状態から選び直します。Alarm候補の最小時刻も純粋関数で選び、空はnull、過去の候補は補正しません。

GameRoomには共有ライフサイクルの現在時刻の取得、活動停止・人間不在の判定、transaction、配信・索引更新、Alarm候補収集と設定・削除を残します。ゲーム進行側の時計更新・脱落・CPU・終局については次節のモジュールへ委譲します。リバーシCPUの同期確定と将棋CPUの選択保存→次のAlarmで局ID・revision・手番・期限を再検証する順序を維持します。Webの時計取得・表示・時刻同期は従来どおりです。保存形式・互換性・戦績SQL・保存再試行の再設計は #58、ページ遷移時の接続問題は #4 で扱います。

関連回帰は `bun run --cwd apps/worker test test/clock.test.ts test/roomDeadlines.test.ts test/roomDeadlineBoundary.test.ts test/gameRoom.test.ts test/fourShogiRoom.test.ts test/humanlessRooms.test.ts test/shogiStore.test.ts` で実行します。全14設定・秒読み・期限前後・同時刻と遅延処理・期限後のエラー・Alarm候補に加え、実DOの `evictDurableObject` によるhibernation／接続を閉じた復元、保存済みCPU選択の再検証、終局再実行時の棋譜・対局保存・本人索引・計測の非重複を確認します。HTTP／WebSocketの公開応答を通信契約で解析し、時刻とCPU選択は保存境界で制御します。内部メソッドのモックや固定sleepを使いません。Color／Side・残時間recordの取り違えはWorkerのtypecheckに含まれる型検査専用fixtureで検証します。

## Workerのゲーム進行と共有ライフサイクル

`fourReversiProgress.ts`／`fourShogiProgress.ts` は配席・開始・着手・投了・外部脱落・時計更新・棋譜記録・終局データと保存待ちの生成・CPUを担当します。将棋の合法手・王手・千日手・撃破数・引分提案・三人攻撃禁止も将棋側に置きます。依存は実DOのstorage、参加資格読取り、開始時のアカウントID読取りだけです。通信・配信・外部保存への権限を渡しません。対局状態は呼出しごとにstorageから読み、モジュールに保持しません。将棋Storeは初めて必要になったときに生成し、千日手の参照cacheは一回の遷移内に限定します。

`gameProgress.ts` はWorker内部の型対応と必須登録を持ちます。追加ゲームには `ProgressTypes` の終局・直前局と、`GameProgressRegistration` のfactoryを登録します。protocolの `RoomFor<G>`・`GameActionCommandFor<G>` に開始・進行・終局・再戦データを対応付け、mapped typeと `satisfies` で欠落を検出します。将棋着手の局ID・revisionは必須です。結果は拒否・変更なし・継続・終局のunionで、共有側が明示的に分岐し `never` で網羅性を確認します。別ゲームのRoom・着手・終局結果・再戦データの混入は型検査専用fixtureで拒否します。

GameRoomは認証・参加・準備・接続／切断・チャット・transactionと共有副作用を担当します。期限ループは一つで、活動停止・人間不在の閉鎖、欠落した復帰期限の補完、期限の選び直し、待機席の解放、資格・アカウント処理を共有し、盤面の脱落だけをゲーム側へ渡します。終局はゲーム側の棋譜・局面更新 → 共有の計測確定 → ゲーム側の保存待ち・直前局確定 → 共有の席保持・元の復帰期限保持・資格解放・ホスト交代・準備解除 → ゲーム側の待機Room生成の順です。transaction後のflush・Alarm・配信・索引更新の既存順序を保ちます。

リバーシCPUは通常アクセスでも同期選択し、計算後の現在時刻で期限を確認して確定します。将棋CPUはAlarm限定で提案を同期し、終局しなければ選択を保存、次Alarmで局ID・revision・手番・期限を再検証して適用します。明示退室はリバーシの盤面・棋譜処理後に資格を失効させ、将棋は資格失効後に盤面処理します。D1保存・SQL・再試行の設計は維持し、閉鎖後の保存待ちと保護棋譜も保持します。保存形式・互換性・戦績SQL・保存再試行の再設計は #58、ページ遷移時の接続問題は #4 の範囲です。

前節の回帰コマンドは通常GETでのCPU進行の差、将棋の複数接続・切断通知欠落・活動停止・再戦時の元の復帰期限も確認します。抽出した進行・終局更新を実storageのtransactionで実行し、例外後にKV・SQLiteの千日手・棋譜・保護状態・保存待ちが全て戻ることを検証します。公開応答は通信契約で解析し、内部メソッドのモック・固定sleep・テスト用公開APIを追加しません。

## 共通ロビーと四人将棋UI

`/games/four-reversi` と `/games/four-shogi` は `features/lobby/LobbyView` を共通利用します。タイトル・説明・遊び方・盤面プレビューはゲームごとに切り替え、一覧とランキングは各ページから渡します。両ゲームともPCは操作カードとランキングを上段、その下に公開ルームを置き、スマートフォンでは操作・公開ルーム・ランキングの順にします。画面幅による並べ替えでもランキングの状態を維持します。

将棋ページは `LobbyView` の省略可能な `boardPreview` に `FourShogiLobbyBoardPreview` を渡します。エンジンの `createInitialState` から初期盤面を取得し、既存の盤画像・`ShogiPiece`・方向変換を使って南を手前に描画します。盤内の余白と駒の縮尺は対局画面に合わせ、盤画像の縦横比458:500を保ちます。幅は768px以上で88px、767px以下で56px、左へ7度傾けて影を付けます。盤面図は `aria-hidden` の装飾とし、マスにはボタンを使いません。入力中のモードや通信状態には連動させません。767px／768pxの境界をまたぐときは渡された盤面図だけを再描画し、WebKitの縮尺変更後の画像の乱れを防ぎます。既存のリバーシ盤面図は共通ロビー内で維持します。

`LobbyRankings` は取得部分と共通の表示部分を分けています。各ゲームのランキングAPIを専用hookで取得し、モード・詳細の集計項目を切り替えます。更新・空一覧・エラーと再試行を共通で扱います。Portalの詳細ダイアログにも将棋テーマを渡します。

両ゲームで `useLobby` と `useRoomEntry` を使い、ゲーム指定を付けて取得・作成・参加します。省略時はリバーシです。将棋では作成時に三人攻撃禁止を設定できます。ランキングもゲーム別に集計し、リバーシの値を将棋へ流用しません。ダイアログを閉じても入力を保持し、ゲームを切り替えたときは破棄します。

`GameLobbyNavigation` は両ロビーのヘッダー直下に `NavLink` を並べ、現在のURLを選択表示と `aria-current="page"` に反映します。PCでは幅360px以内、650px以下では本文幅を2等分し、両リンクの高さを44px以上にします。アカウント・ルーム画面には追加せず、`/` のリバーシへの転送も維持します。

既定の共通テーマは緑です。将棋の本文には `game-theme-four-shogi` を付け、Portalの入力・遊び方・ランキングのダイアログには `AppDialog` の `theme="four-shogi"` を渡します。`primary`／`primary-hover` は主要ボタンの塗り、`primary-foreground` は文字、`brand` は文字アクセントとして分けます。HeroUIの `--accent` と `--accent-foreground` も同じ範囲で設定します。共通ヘッダー・アカウントメニューをゲームのテーマ範囲に含めず、グローバルなテーマ切り替えは行いません。意味を持つdanger・focusの色は上書きしません。

ゲーム別のURLとAPI、作成・参加payload、入力保持と破棄、ランキングの選択と戦績・履歴の共通選択はBunとhappy-domで確認します。通信・認証・永続化はWorker統合テストで確認します。遊び方は各ゲームのルール正本と照合します。

## ロビーのSEO生成と成果確認

`src/seo/lobbyMetadata.ts` はWeb側のゲーム別title・description・紹介の正本です。ゲーム名・ロビーパスは軽量ゲームカタログを参照します。紹介は `GameIntroduction` で通常ロビーと初期HTMLが共用し、ルール正本に合わせて同じ変更で更新します。エンジン・認証・API・動的一覧を静的生成へ持ち込みません。

WebのbuildはVite出力後に `build/generatePublicLobbies.ts` を実行し、ハッシュ付きJS・CSSの参照を保持した2ロビーのHTML、robots.txt、2件だけのsitemap.xml、404.html、検索対象外のindex.htmlを生成します。生成コードと関連Bunテストは `tsconfig.build.json` でも型検査します。ルートのbuildが既存の `scripts/buildAssets.ts` でこれらをWorker資産へコピーします。生成物はGit管理しません。Viteの開発画面は従来のCSRを使い、初期HTML・HTTPヘッダーの確認には `bun run build` 後の本番相当ローカルWorkerを使います。

`startPublicLobby` は紹介HTMLを持つ初回ロビーだけでルーターの初期化完了を待ちます。成功時に既存createRootへ渡し、遅延ルートの失敗時には紹介・通常リンクを残して再読み込みを案内します。他画面の初回loader・fallbackは従来どおりです。`pageMetadata` は初期表示とルーターのlocation変更でtitle・description・canonical・robotsを同期し、公開棋譜独自のrobots操作は行いません。

本番の資産配信はWorkerが公開ロビー・既知SPA経路・静的資産を明示し、Wranglerの無条件SPAフォールバックを使いません。`/` と公開URLの別表記は308、未知URL・欠落資産は404、既知の非検索画面はnoindexです。公開ページのGET／HEAD・ETag／304を維持し、404本文の取得では条件付きヘッダーを除去します。`scripts/checkDeployment.ts` はトップ転送、両ロビーの初期本文・メタ情報、robots／sitemapと既存APIを確認します。

関連検証は `bun test --cwd apps/web ./test/publicLobbies.test.ts`、`bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/publicLobbies.test.tsx`、`bun run --cwd apps/worker test test/publicAssets.test.ts test/apiRouting.test.ts` です。Bun・happy-dom・Worker統合テストで生成、遷移、200／308／404、GET／HEAD／304、Content-Type、通常UA／Googlebot、認証とAPIの境界を確認します。画面寸法・実ブラウザ入力・JavaScript無効時の見え方は手動確認とし、ブラウザ自動テストは追加しません。

公開前に既存Search Consoleのドメインプロパティ `tetraboard.net` で「検索タイプ: ウェブ」「国: 日本」を指定し、直近28日間の対象ページ別・対象検索語別のクリック数・表示回数・CTR・平均掲載順位を記録します。対象語は「四人将棋」「四人リバーシ」、ページは各正規URLの完全一致です。期間・フィルター・端末区分も併記し、データのない項目を0と断定せず「データなし」とします。集計・期間はSearch Consoleの表示に従い、既存Adminの日本時間の指標と混ぜません。新たな個人別流入計測を追加しません。

必須ローカル検証とGitHub CI、差分・結果に対する開発者の承認後にマージ・公開します。本番確認後、Search ConsoleのライブURL検査で両ロビーの本文・検索許可を確認し、既存のサイトマップURLを再送信して両ページのインデックス登録をリクエストします。実Googlebotによる登録と正規URL選択はライブ検査・UAのローカル比較と区別します。SEO整備の完了は本番確認・送信・基準値記録までとし、公開前は未完了です。

公開後4〜8週間で最初の成果を評価します。両URLが登録されGoogleの正規URLと一致し、日本・日本語・ログアウト状態のPC／スマートフォンで週1回×4週間、両検索語の通常の自然検索1位を確認し、各ページの評価対象28日間クリック数が公開前28日間より増加した場合を成果達成とします。日時・地域・端末を記録し、平均順位だけで常に1位と判定しません。データ不足は観測期間を延長し、未達なら継続課題とします。順位・反映時期の保証と自動監視は設けません。

## 四人将棋のオンラインルーム

公開型は `FourReversiRoom | FourShogiRoom` で、`settings.game` をガード関数で判別します。既存リバーシの保存形式・着手通信は維持します。将棋は担当方向、方向別の時計、局ID、局面revision、三人攻撃禁止、同じrevisionの合法手・三人攻撃禁止候補（`threePlayerAttackForbiddenActions`）と王手情報を配信します。禁止候補はエンジンの `getActionAvailability` で通常合法手から三人攻撃で除外された手だけを導出し、別の不正手を含めません。旧保存局面の未保存フィールドは公開局面から読込時に補完します。通常スナップショットに千日手の出現数は含めません。Webは受理された局面を表示し、履歴を補って独自に進行させません。

`room.game.action` の将棋着手は `roundId`・`positionRevision` と `movePiece`／`dropPiece` を送ります。サーバーが認証・局ID・revision・手番・合法性を検査し、着手と脱落でrevisionを進めます。`room.three-player-attack.set` は待機中のホストだけが変更でき、モードと同様に人間の準備を解除します。

将棋のDO保存は通常状態、局ID・局面キー別の千日手回数、初期化情報と連番イベントへ分けます。 実対局では千日手の全行を読み込まず、エンジンが必要とする局面キーだけを主キーで参照し、確定した変更分だけを保存します。参照キャッシュは同期的な一回の状態遷移またはCPU選択内に限定し、保存・ロールバック・次局へ持ち越しません。CPU探索では枝ごとの変更分を基底履歴より優先し、仮想着手の回数は永続化しません。完全な回数辞書を使う従来のエンジン呼び出しとWebの棋譜再生は維持します。局面・回数・イベント・revisionを同じトランザクションで確定し、棋譜へ全状態を複製しません。直前局は `GET /api/rooms/:id/rounds/:roundId/replay?instanceId=<UUID>&cursor=<offset>` から100イベントずつ取得します。Webは部屋世代・局ID・規則バージョン・件数・連続番号を検証し、エンジンで再生します。再生中の完全な状態は1つだけ保持し、閲覧用には千日手索引を除いた局面を保持します。次局開始で部屋の棋譜取得を中止します。未保存の終局イベントは次局開始・部屋閉鎖でも保持し、D1保存を確認後に不要な行を削除します。将棋の恒久履歴・戦績・ランキングはゲーム指定で分離します。

CPUは開始待ち約0.5秒後に選択し、選択結果と局ID・revision・手番を保存します。次のAlarmで期限を再確認して適用します。同期処理中に `Date.now()` が進まない本番でも、別のイベントで得た時刻までを時計へ反映します。根拠は [Cloudflareの時刻仕様](https://developers.cloudflare.com/workers/runtime-apis/performance/) と [保存上限](https://developers.cloudflare.com/durable-objects/platform/limits/) です。

外側の `RoomLayout`、タブ、チャット、招待、カードの名前・アバター・ホスト・接続表示、時計表示と棋譜操作を共有し、将棋の盤内配置と操作は専用部品に分けます。PNG盤の縦横比を保ち、座標と向きを変換して4方向を表示します。盤上・持ち駒・ドラッグは同じ駒部品と盤内寸を使います。8pxのドラッグ閾値、盤外・取消・Escape、成り選択、局面更新時の解除、重複送信は純粋関数とDOMの状態テストで確認します。操作可能な盤上・持ち駒はホバーで画像だけが2px浮きます。選択中はホバーが外れても同じ高さと影を保ち、解除後は元へ戻ります。ドラッグ中は元画像を隠し、取消後に復元します。持ち駒の枚数は送信前に変更しません。選択・ドラッグ中は合法候補を緑、三人攻撃禁止候補を同寸の赤い丸で示します。禁止候補だけの駒・持ち駒も選択可能ですが、着手・成り選択・送信の判定は合法手だけを使います。合法な成り／不成がある移動先は緑を優先します。

成り選択は盤上へ重ね、左が成り・右が不成、駒画像は盤上と同寸にします。2枚の境界を移動先の中央に合わせ、盤端では全体を盤内へ寄せます。画面全体の透明なクリック受けで、選択外のクリック・タップは成りだけを確定します。成りボタンへ初期フォーカスを移し、Tabで二択を移動、Enter・Spaceで確定、Escapeで取消して移動元へフォーカスを戻します。

`useShogiPromotion` は未確定の移動元・移動先と部屋世代・本人・局ID・局面revision・陣営を `sessionStorage` に保存します。接続待ちで削除せず、認証と最新合法手の確認後、成り・不成の両方が合法な場合だけ復元します。確定・取消・局面更新・次局開始・脱落・資格変更、破損値、保存失敗と同じタブの再読み込みをBun＋happy-domのhookテストで検証します。

直前手は移動元の暗い茶色の背景と移動先の枠を描き分けます。マス装飾は盤PNGの罫線の原寸座標（アンチエイリアスを含む）に合わせ、各辺を罫線の内縁まで広げます。盤と同じ縮尺で追従し、盤の配置や当たり判定は動かしません。

767px以下の `FourShogiBoardLayout` は、盤面タブのコンテナ幅と高さから盤幅を決めます。カード2段（各48px）・持ち駒2段の固定余白・4つの2px間隔を差し引き、盤画像と持ち駒2段の駒画像の比率で残り高さを割ります。持ち駒の上下paddingは1px、ボタンの高さは駒画像＋2pxで、枠線を合わせた固定分は1段6pxです。横幅が十分でも高さが足りなければ盤だけ中央で縮小し、カードと持ち駒領域の幅は維持します。通常ルームと保存棋譜の両方にこの配置を使います。

固定局面を使ったBun・DOMテストと、実HTTP・WebSocket・D1を使う通常のWorker統合テストで、作成・参加・観戦・準備・開始・着手・CPU両レベル・チャット・再接続・終局・棋譜・再戦を確認します。ブラウザE2Eは廃止し、少数E2Eの再構築は次の作業で行います。PR前の必須検証は `bun run check`、`bun run build`、Worker dry-runです。

## 四人将棋エンジン

`packages/four-shogi` は `@tetraboard/four-shogi` として利用する独立したパッケージです。ランタイム依存はなく、既存の四人リバーシと同じTypeScript・Bunの構成を使います。`bun run --cwd packages/four-shogi check` で単体の整形・lint・型・テストを確認できます。

```ts
import { applyAction, createInitialState, getLegalActions } from "@tetraboard/four-shogi";

const state = createInitialState({
  mode: "singles",
  players: { south: "player-1", west: "player-2", north: "player-3", east: "player-4" },
  threePlayerAttackProhibited: true,
});
const actions = getLegalActions(state);
const result = applyAction(state, "south", actions[0]);
if (result.ok) {
  const saved = JSON.stringify(result.state);
}
```

担当方向は呼び出し側で決め、重複しない4人のIDを入力します。三人攻撃禁止は省略時ONです。状態は `playing` と `finished` の型で区別し、終局時は `turn: null` と結果を保持します。座標はルール正本と同じ左上 `{ x: 0, y: 0 }` です。

`getLegalActionsForSide` は指定した生存陣営の候補、`getCheckState` は全陣営の王手状態、`getActiveSides` は生存陣営を返します。着手は `movePiece { from, to, promote }` と `dropPiece { pieceKind, to }` を使います。`promote` はこの手で新たに成る指定なので、成駒の移動ではfalseです。`eliminateSide` は確定した投了・退室・時間切れ・通信切れを渡す入口で、投了は自手番だけ受理します。

成功時は新状態・捕獲駒・今回の脱落一覧を、失敗時は理由を返し、入力状態を変更しません。詰み・合法手なしは着手や外部脱落に伴って自動処理し、同時脱落の群と理由・順位を保持します。持ち時間、接続期限、プロフィール、ネットワークはエンジンへ持ち込みません。担当方向の抽選は呼び出し側で行います。保存した状態はJSONで復元して同じAPIへ渡せます。外部入力の検証と認証は、将来のルーム接続側で行います。

### 四人将棋の引分提案

エンジンの `setDrawProposal(state, side, proposed)` は自手番の生存者の提案・取消を処理します。`drawProposals: readonly Side[]` を保持し、全生存者の同意で終局理由 `agreement` を返します。提案操作では手番・盤面・手数・直前手・千日手回数を変えません。着手・外部脱落による自動処理の後は、通常終局を優先して残った生存者の同意を再判定します。

WebSocketの `room.game.draw.set` は `proposed`・`roundId`・`positionRevision` を必須にし、本人・局ID・revision・期限・生存・手番を検証します。変更時だけrevisionを進め、`drawProposal { side, proposed }` イベントと状態を同じトランザクションで保存・配信します。変更なしは送信者へ最新スナップショットを返します。`advanceShogiClock` の `turnEnded: false` を使い、現在の時計と期限を維持します。更新前のCPUジョブは破棄します。

CPUの同意判断は人間／CPUを識別できるルーム側で行い、CPU着手の公開APIは維持します。各CPUの手番で人間全員の提案状態に合わせて提案・取消し、終局しなければ通常の思考・着手を続けます。人間が0人の場合は提案しません。

ルームと保存済み棋譜の再生は同じイベント適用関数で提案・取消を処理し、「南 引分提案」「南 引分取消」の形式で表示します。保存済み棋譜のカードは選択局面の提案状態を表示し、再戦待機のカードは準備表示を維持します。`rulesVersion: 1` を維持し、旧保存状態に `drawProposals` がない場合は空配列へ正規化します。最終状態比較にも正規化を適用し、D1／DOのテーブル移行は不要です。

エンジン・Worker・Webのテストで手番制限、状態と時計の不変、脱落後の判定、同意成立、保存・再接続・再戦、CPU同意・取消、旧棋譜との互換性を確認します。送信中と拒否・切断後の復帰、観戦者・脱落者の操作制限、保存棋譜の局面追従はDOMテストと純粋関数で確認します。

### 四人将棋CPU

同じパッケージから `CpuLevel = 1 | 2` と `chooseCpuAction(state, level, random = Math.random): FourShogiAction | null` を公開します。終局済み、または合法手がない状態ではnullを返します。候補はエンジンの合法手一覧から選び、入力状態を変更しません。CPUの状態項目や保存形式は追加していません。

```ts
import { chooseCpuAction } from "@tetraboard/four-shogi";

const cpuAction = chooseCpuAction(state, 2);
if (cpuAction !== null && state.status === "playing") {
  const cpuResult = applyAction(state, state.turn, cpuAction);
}
```

Lv1は合法手を一様ランダムに選びます。テストや再現可能な選択では、第三引数へ0以上1未満の値を返す関数を渡せます。Lv1で乱数関数が非有限値を返した場合はTypeErrorにします。Lv2は乱数を使わず、全候補を `applyAction` で一手進めて評価し、直ちにシングルス1位またはチーム勝利となる手を優先します。残りは静的評価の上位8候補について、実際に選ばれた次の手番の応手を最大16件読みます。王手で手番が飛ぶ場合や、次の手番がダブルスの味方になる場合も、更新後の状態に従います。

応手の並べ替えでは、盤面・持ち駒だけを仮に更新した軽い評価を使います。その盤面で生存する敵王への王手があるもの、応手側の静的評価、元の合法手の列挙順で並べ、上位16件だけを `applyAction` で進めて詰み・脱落・千日手まで読みます。読んだ応手の中から、応手側本人またはそのチームの評価を最大にする手を想定します。同点は元の列挙順で決めます。駒の価値・王の安全・終局結果の具体的な重みは [ルール正本のCPU仕様](rules/four-shogi.md#cpu) に記します。

探索は件数で制限し、時刻による打ち切りを行いません。上位候補から外れる手や16件に入らない応手は読み落とす可能性があります。持ち駒が多い局面でも全候補の一手目は評価するため、一定の実行時間を保証する方式ではありません。CPUはオンラインルームへ接続し、思考結果の保存と適用を別のAlarmで行います。`bun run --cwd packages/four-shogi check` とルートの `bun run check` でCPUの公開APIと既存ルールを確認します。

## 軽量テスト

純粋関数は既存のBunプロセス、React部品・hookはBun＋happy-domの別プロセスで実行します。Workerは従来のCloudflare環境で実HTTP・WebSocket・D1・R2を検証します。全195定義の論理検証は [移管対応表](testing.md#移管対応表) を参照してください。

### 将棋の駒画像の初回表示

`ShogiPiece` は現在のURLに対応する画像の `decode()` が成功するまで、同じ寸法の駒名を表示します。取得・デコード失敗時も文字を保持し、画像が準備できれば文字を消します。URLが変わったら直ちに新しい駒名を表示し、以前の画像の完了通知では表示を更新しません。PNGと対応する駒名は `shogiPieceImages.ts` で管理します。

`FourShogiBoardLayout` の初回表示後、描画中の駒と盤画像のデコードが完了または失敗してから、成銀・龍・裏王の上下計6画像を低優先度・2並列で事前取得しデコードします。URLごとのPromiseに成功した画像をページ内で保持し、再戦・回転・棋譜でも再利用します。失敗した先読みは自動再試行せず、通常の画像取得と再読み込みを妨げません。盤面表示・通信・操作は先読みを待ちません。将棋ロビーの装飾盤面とリバーシでは先読みしません。

`shogiComponents.test.tsx` は偽の画像loaderで取得待ち・失敗・decode待ちの代替名、古い完了の破棄、画像src・方向、成り候補と送信を確認します。希少画像6URL・2並列・低優先の先読みとキャッシュを確認します。実デコード・実描画・低速回線のブラウザ計測は自動検証から外します。

### 共通の実行方法

Web・Adminの `test:unit` はDOMなし、`test:dom` は共有preloadでhappy-domを準備して実行します。`test` は両方を実行します。新しいWeb DOMテストは `tsconfig.test.json`、Adminは既存の型チェックに含めます。ゲーム間の型の取り違えを検出する型テストは維持します。

対象だけを確認するときは以下のコマンドを使います。PR前にはルートの必須3コマンドを実行します。

```sh
bun test --cwd apps/web ./test/matchCompatibility.test.ts
bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomSession.test.tsx
bun run --cwd apps/admin test:dom
bun run --cwd apps/worker test test/feedback.test.ts
```

純粋なルーム・局面・棋譜fixtureは `apps/web/test/fixtures/`、固定棋譜と固定期待値は `test-fixtures/matches/` に置きます。DOMの共有preloadは `test-support/dom.ts`、React操作と偽時計・通信の支援は `apps/web/test-dom/support.tsx` です。時刻・タイマー・fetch・WebSocket・保存領域・画像処理の境界を制御し、実際の待ち時間・外部通信・実デコードを使いません。部品・hookの状態モデル自体は実装を使います。

テスト結果は通常CIのログへ出力し、HTML・スクリーンショット・traceのレポートartifactは生成しません。デプロイに使う `web-<コミットSHA>` のビルドartifactは維持します。

既存のWorker E2Eと専用SQL・Playwright設定は削除します。実APIの権限・再送・保存・CPU・閉鎖は通常のWorker統合テストで確認します。画像変換は入力検証と状態・出力境界をDOMテスト、WASMの同一origin asset参照はビルド時の検証、assetへのHTTP転送はWorkerテストで確認します。既存のPlaywright依存は維持します。

## 本番デプロイ

### ブランチと公開先

最新のmainから `feat/xxx`・`fix/xxx`・`docs/xxx`・`chore/xxx` を作り、ローカルでのPR提出前の検証を成功させてからmain向けPRを開きます。mainへの直接push・force pushは行いません。非公開リポジトリでは現在のGitHubプランによる保護を利用できないため、GitHub CI成功、必須のローカル検証成功、開発者の確認を運用で必須にします。他者レビューは必須ではありません。初回も差分と検証結果の承認後にマージし、それ以降はPRのマージを公開の契機とします。

| 設定 | 本番の値 |
| --- | --- |
| Wrangler環境 | `production` |
| Worker | `tetraboard-2026` |
| URL | `https://tetraboard.net` |
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

PRとmainのpushではchecksジョブで `bun install --frozen-lockfile` → `bun run check` → Web・Adminのビルド → `deploy:dry-run` を実行します。`check` のformat確認・lint・型・全テストを合わせた秒数をGitHub Actionsのsummaryに記録し、180秒を目標とします。PRジョブはCloudflareの認証情報を使いません。

mainでは同じ実行で生成したWeb・Adminの成果物をデプロイジョブへ渡し、mainの先頭コミットであることを確認します。本番D1マイグレーション適用後にもう一度mainを確認し、古い実行ならWorkerの公開をスキップします。現行mainなら `wrangler deploy --env production` で画面とWorkerを一緒に公開します。同時デプロイを禁止し、進行中のデプロイは途中キャンセルしません。先頭確認後にmainが更新された場合は、進行中の公開完了後に次の実行で更新します。

独自ドメインの変更時はCD用APIトークンに対象Zoneの読み取り権限と、対象アカウントのWorkersルート・独自ドメインを更新できる権限があることを確認します。

公開後は `scripts/checkDeployment.ts` でトップページのHTML、`/api/healthz` の応答、公開ルーム一覧のスキーマを検証します。各リクエストにはタイムアウトと最大5回の再試行を設けています。チェック・マイグレーション失敗時はデプロイへ進まず、公開後の確認失敗もActionsの失敗として残ります。

### 本番構成のローカル確認

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

### 失敗時の対応と将来のドメイン

- CI失敗は修正してPRを更新します。秘密値不足や認証エラーはRepository secretsと権限を確認します。秘密値はログへ出さず、初回は必要なSecretが揃うまでマージしません。
- マイグレーションは旧コードでも動く追加変更を基本とし、破壊的な変更は段階を分けて別途承認します。マイグレーション失敗時は公開されません。適用済みの変更は公開失敗やスキップ時にも残るため、自動でDBを巻き戻しません。
- 公開後に不具合があれば、修正またはrevertのPRをCI成功後にマージして再デプロイします。DBやDurable Objectの保存形式に変更がある場合は旧コードとの互換性を確認し、互換性がなければ修正を前進適用します。
- Actionsの実行履歴とCloudflareのWorkerログで障害を確認します。デプロイ時にはWebSocketが切断されるため、公開後に再接続も確認します。
- 本番ドメインは `tetraboard.net` です。Worker・D1・R2の名前とIDを維持します。旧workers.dev URLは同じパス・クエリで308転送します。転送を静的アセットより先に処理するため `run_worker_first: true` と `ASSETS` を設定し、`/api` と `/api/*` はHono、画面・画像は `ASSETS.fetch` へ渡します。
- 旧版の `/profile` は `/account`、`/games/game-…` と `/guest/name` は `/games/four-reversi` へ302転送します。旧ルーム・棋譜は移行しません。旧ルームの取得失敗は既存のエラー画面からロビーへ戻れます。ログイン状態とオリジン別の `sessionStorage` は移行せず、再ログイン・再入室します。
- 切替前にアカウントの追加移行を済ませ、CI成功後にドメイン・`APP_ORIGIN`・CIの `PRODUCTION_URL` を同じ変更で切り替えます。ドメインの割当先、HTML・API・WebSocket、Googleログイン、プロフィールと既存棋譜を確認した後、旧Worker `tetraboard`、旧D1 `tetraboard-db-prod`、旧R2 `tetraboard-objects-prod` を削除します。削除前に旧版へ戻す場合は、ドメインの割当先を旧Workerへ戻します。

## Code Principles

C#/.NET標準ライブラリのような、一貫性があり読みやすいコードを目指します。

過度な抽象化より、意図が明確なコードを優先します。

## Webの編集先

ロビーとルームでは `@heroui/react` v3と `@heroui/styles` を使います。スタイルの生成にTailwind CSS v4、`@tailwindcss/vite`、HeroUIのアニメーションに `tw-animate-css` を使用します。導入は通常の `bun install` に含まれ、追加のセットアップは不要です。
`main.tsx` から `shared/heroui.css` を一度だけ読み込みます。このCSS内でTailwindのtheme／utilities、HeroUIの必要な公式スタイル、`shared/theme.css` を同じ生成単位として読み込みます。テーマを別のCSS入口に分けると独自色のutilityが生成されないため、読み込みを分割しません。Tailwindの全体リセットは使わず、最小リセットと共通テーマをロビー・ルーム・Portalに適用します。

共通部品は `shared/ui/` の `AppAvatar`、`AppHeader`、`AppButton`／`AppButtonLink`、`AppTextField`、`AppCard`、`AppDialog`、`AppTabs`、`AppIcon` です。HeroUIのprops・ref・キーボード操作を引き継ぎ、繰り返す見た目は部品内のTailwindクラスへ集約します。`AppButton` は `appearance`（primary／secondary／quiet／danger）と `size`（default／compact）、`AppDialog` は `size`（default／compact）で用途を指定します。`AppTextField` はLabel・Input・Description・Errorを組み合わせ、入力プロパティとrefはInputに渡します。フィールド単位のErrorはTextFieldの `isInvalid` とともに使い、フォーム全体の通信エラーは独立したalertに表示します。

`AppSelectTrigger` は時間設定で共有し、全幅・最小高さ44px・縦中央揃えを指定します。HeroUIの `Select.Trigger` のprops・ref・状態に応じたclassNameを引き継ぎます。棋譜の局面Selectは専用の寸法を使います。

`AppPageState` は既存のロビー背景とゲーム別テーマを使った画面中央の共通配置、`AppPageLoading` はスピナーとstatus文の表示です。ルートの初回fallbackとゲーム別viewのSuspense、ルーム・棋譜のエラーに使います。データ取得前は共通テーマ、取得後はloaderのゲームを使います。

`AppButton`／`AppButtonLink` の `isPending` は元の内容を配置・読み上げのために残し、見た目だけを中央のHeroUI Spinnerに置き換えます。非同期操作の完了・失敗・中止は既存の通信状態で管理します。初回・自動取得と手動の更新／再試行は `pendingSource` で区別し、共有リクエストの複数の入口では操作元を指定します。CPU操作はtransportの `pendingSettingsCommand` を参照し、設定全体のロックで他のボタンまでスピナーにしません。Context／Providerの配置と通信契約は維持します。

ルーム設定の選択値は `pendingSettingsCommand` から表示上だけ先行反映し、transportのルーム状態と処理完了判定は変更しません。`roomSettingsPresentation` で送信待ちを判定し、接続済みの待機中ホストの一時的なロックだけ無効時の透明度を保ちます。CPUレベルの操作は `CpuLevelSelector` を共用します。PCの `RoomLayout` は左右列を独立させ、右列の展開内容が盤面の高さ計算へ影響しないようにします。

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

## ルームの共通操作と接続通知

`AppRadio` はHeroUIの共通ラジオ部品です。`Content` 内に `Control` と文字を置き、丸・文字・余白が同じクリック領域に入るようにします。未選択の丸は白背景と `text-muted` と同じテーマ色の1px枠線を使い、選択色・フォーカス・無効化はHeroUIに従います。作成・すぐ遊ぶ・待機ルームの対局形式と三人攻撃禁止に適用します。設定payload・送信待ちのロックと解除は部品・hookのDOMテストで確認します。

`RoomViewShell` を配置基準にし、接続中・再接続中と同じ帯に出る操作エラーを絶対配置します。安全領域から8px、ルーム中央、最大幅480px・左右8px以上の余白とし、長文は帯内で折り返します。通知は `pointer-events: none` と `z-index: 10` を使い、ダイアログ・Select候補より下に重ねます。既存の `role=status`、文言、表示条件、再接続hookは保持します。接続・再接続・操作エラーの状態遷移と文言はDOMテストで確認し、矩形差や中央配置の実ブラウザ検証は自動検証から外します。

## 棋譜の確認

スマートフォンの両ゲームのプレイヤーカードは、文字・アバター・下段情報の寸法を維持し、上下paddingを1px・高さを48pxに固定します。盤面だけの縮小ではカード寸法を変えません。リバーシの `RoomBoardLayout` はカード2段と2つの2px間隔を空き高さから差し引き、横幅との小さい方を正方形の盤幅にします。自動パス通知がある場合は15pxの行高と2pxの間隔も確保します。通常ルーム・保存棋譜の両方で低い画面にも4席を収め、名前・下段情報とカード枠の間は各2px（枠線1px＋padding1px）とします。

棋譜は新しく開始した対局から記録します。CPU対戦または4人の対戦を終局させ、最終局面が自動で選ばれること、開始局面・着手・自動パス・各種脱落をSelectと左右ボタンで確認できることを検証します。待機中の準備・設定・入退室・チャットで閲覧局面をリセットしないこと、再読み込みと再接続で復元すること、次局開始で解除されることを確認します。古い対局は最終局面のみの表示になります。
PCでは盤面領域右下、タブレット・スマートフォンでは状況カード内へ配置します。タブ切替後の局面保持と先頭・末尾でのボタン無効化を軽量テストで確認します。Workerテストは棋譜と実際の盤面の一致・パス・CPU着手・脱落原因・再取得・次局の記録更新を、Webテストは局面ラベルと自動パスの分割を検証します。表示は `ReplayCard.tsx`、選択状態は `useRoomReplay.ts`、項目の生成は `replayFrames.ts` を編集します。
両ゲームの `ReplayCard` は選択値・候補を一行で表示し、幅不足時のみ省略記号を使います。候補の `textValue` は全文を保持し、矢印・選択マークの幅と画面内の候補領域を確保します。将棋の `createFourShogiReplayFrame` は着手または外部脱落の短いラベルだけを生成し、詰み・合法手なし・同時脱落・順位の説明を付加しません。`game.eliminations` と全局面・結果は保持し、通常ルームと保存済み棋譜で同じframe生成を使います。打ち駒・成り・投了・パス・退室・時間切れ・通信切れ・同時詰みを確認し、ラベル短縮後も局面数・順位・脱落理由が変わらないことを検証します。
スマートフォンでは320px幅も含めて待機ラベル・棋譜カード・結果を一行に収め、棋譜の表示前後で状況カードの高さを維持します。

## ダイアログ・脱落理由の確認

PCでは棋譜表示の有無で盤面と全プレイヤーカードの座標・寸法を維持し、右下の棋譜カードと重ならない配置とします。Selectの上下中央揃え、44×44pxの閉じるボタン、順位と理由・石数の収まり、観戦案内の一行表示という画面仕様は維持します。
ロビー・ルームのダイアログはキーボード開閉・スクロール・画面回転時も背景全体のぼかしと確定ボタンへの到達を維持します。フォーカスの閉じ込めと復帰も画面仕様として維持します。送信中の閉鎖防止はDOMテストで確認します。
`Room.eliminations` は対局中の色と脱落理由を保持し、待機中と次局開始時は空になります。脱落を盤面・棋譜と同じトランザクションで記録し、GETとWebSocketに配信します。旧保存データでこの項目がない場合は保存済み棋譜から復元し、記録がなければ理由を推測しません。Workerテストは4種類の理由の保存・配信・再取得・途中観戦・旧形式の復元と次局の初期化を、Webテストは順位ラベルと記録がない場合の表示を確認します。

## Google認証とアカウント移行

### ローカル確認と本番設定

`bun run dev` は既存ローカルD1に認証テーブルも適用し、R2はローカルエミュレーターを使います。`APP_ORIGIN` の初期値は `http://localhost:5173` です。Google認証の確認はそのURLでWebを開きます。別のポートやLANのURLを使うときは、Workerの追跡対象外 `.dev.vars` で `APP_ORIGIN` を同じURLへ上書きします。Googleのコールバック設定にも同じオリジンが必要です。通常のロビー・対局はGoogle設定がなくても利用できます。

Google CloudのOAuthクライアントはWebアプリケーション用を使い、承認済みリダイレクトURIに次を登録します。

- ローカル: `http://localhost:5173/api/auth/callback/google`
- 本番: `https://tetraboard.net/api/auth/callback/google`

`BETTER_AUTH_SECRET`（32文字以上の乱数）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` をローカルは `.dev.vars`、本番は `wrangler secret put <名前> --env production` で設定します。秘密値はコード・PR・会話・ログに出しません。認証処理には本番Secretが必要で、ローカルだけは開発専用Secretのフォールバックがあります。本番Secretが未設定のときに開発用の値は使いません。Googleの設定不足はログイン画面で「準備中」と案内します。旧版のSecretやCookieをコピーしてセッションを共有する必要はありません。

専用R2 `tetraboard-2026-objects-prod` は存在を確認済みです。旧版の `tetraboard-objects-prod` は切替後の確認まで保持し、確認後に削除します。バケットを公開せず、画像はWorker経由で配信します。productionのR2も `remote: false` のため、ローカルプレビューから本番画像を変更しません。D1の本番名・IDとローカル名・IDも維持します。

マイページのページ枠は `AccountPageShell` の `layout="profile"` を使います。最大幅・左右余白は共通の `shared/ui/pageLayout.ts` にまとめ、ヘッダーと一致させます。本文先頭の左に共通ゲームDropdown、右に選択中ゲームのロビーへ移動するsecondaryの`AppButtonLink`、共通モードタブは651px以上ではDropdownのすぐ右に最大360px幅、650px以下では次の行に全幅で配置し、その下にプロフィール＋戦績・棋譜のカードを配置します。タブは複製せずCSS Gridで配置を切り替え、幅の変更で選択・カード・取得済みデータを維持します。本文は`lobby-background`と`gameThemes`で選択中ゲームの背景・テーマを使い、共通ヘッダーはテーマ範囲の外に置きます。DropdownのPortalとプロフィール編集の`AppDialog`にも同じテーマを渡します。1024px以上は左560px・間隔20px・右は残り幅、それ未満は同幅の縦並びです。ログイン・初回設定は既存のフォーム用幅と下部のロビーリンクを使います。

Webの編集先は `features/account/`、プロフィールの共通フォームは `ProfileForm.tsx`、認証処理はWorkerの `src/accounts/` です。初回設定はページ内、マイページの編集は共通 `AppDialog` 内に同じフォームを表示し、名前・ID・任意アイコンをmultipartでまとめて保存します。カメラボタンから画像を選択してプレビューし、「保存」（初回設定は「プロフィールを作成」）で反映します。アイコンの削除も同じです。フォームの `onBusyChange` で画像変換・保存中の閉鎖を防ぎ、`onSaved` で成功時にダイアログを閉じてページに通知します。閉じた未保存フォームは破棄し、再度開くと保存済みプロフィールで初期化します。 ファイル選択や別タブから戻った際のログイン再確認では、取得済みのプロフィールと編集中のフォームを保持します。再確認の通信失敗は再試行案内を追加し、名前・ID・画像の下書きを保持します。セッション失効が確認された場合はログインへ誘導します。

`bun run check` にCookie本人確認、期限切れ、ログアウト、Originチェック、入力境界、ID競合、画像変更・削除、移行計画、Google通信を差し替えたOAuth往復を含めます。プロフィール入力・保存・破棄・画像処理中のロックはDOMテストで確認します。WebKitでCanvasのWebP出力が使えない場合は、承認済みの `@jsquash/webp` を遅延読み込みします。Viteではこの依存をprebundleから除外し、WASMは明示的なasset URLで読み込みます。

### 旧版からの移行準備

移行対象はアカウント情報だけです。旧版Worker `tetraboard`、D1 `tetraboard-db-prod` から、新版D1 `tetraboard-2026-prod-db` へ移します。2026-10-03に開発者が「棋譜は移行しない」「本人の旧アカウントを除いた登録アカウントを移行する」方針を承認しました。旧版のGoogle登録2件から、同じGoogle識別子で新版に存在する本人の旧アカウント1件を除外し、残る1件を対象にします。新版の既存アカウント・棋譜を維持し、本人のプロフィールは統合・上書きしません。移行対象1件の画像は外部URLのため未設定へ正規化し、R2コピーは不要です。
`user` と `account` の列名・文字列ID・ミリ秒の日時は旧版と互換です。Googleの `accountId` と内部 `user.id` を保持します。名前・ID・完了状態・アップロード画像を維持し、外部画像URLは保持せずアイコン未設定へ正規化します。ゲスト・テストユーザー、旧session・verification、accessToken・refreshToken・idToken・password、戦績・棋譜・ルーム情報は移しません。Google未連携ユーザーやID不正、移行先のメール／ID／Google識別子の競合は計画作成時に停止し、推測で統合・上書きしません。

今回は有効な対局がないことを開発者が確認し、メンテナンス時間は設けずに進める指示を受けています。直前の新旧スナップショットで対象と競合を検証し、競合を無視するSQLは使用しません。Googleの独自ドメイン向け設定は開発者が完了済みです。以下は承認された移行で使う手順です。

1. 新版D1の認証マイグレーションを適用し、対象D1の復旧ポイントを控えます。旧版と新版のDB名・ID、Googleクライアントのコールバック、対象件数を確認します。
2. `apps/worker/scripts/accountSnapshot.sql` は移行に必要な列だけを取得します。旧版設定を明示して `wrangler d1 execute tetraboard-db-prod --env production --config <旧版wrangler.jsoncの絶対パス> --remote --file scripts/accountSnapshot.sql --json`、新版では `wrangler d1 execute APP_DB --env production --remote --file scripts/accountSnapshot.sql --json` を使います。標準出力はアクセス制限した一時ディレクトリの `source.json`・`target.json` に保存し、画面・ログ・Gitに出しません。JSON・SQLには個人情報が含まれます。
3. `apps/worker` から `bun scripts/prepareLegacyAccounts.ts <source.json> <target.json> <output.sql> <exclusions.json>` を実行します。除外ファイルは `[{ "userId": "<旧内部ID>", "googleAccountId": "<Google識別子>" }]` とし、Gitやログに出しません。両識別子が旧版の同じ登録ユーザーと一致しない場合や、除外指定が重複した場合は停止します。リモートには書き込まず、移行SQLと `<output.sql>.avatars.json` を生成します。同じ既存データはスキップし、異なるプロフィールは拒否します。SQLのINSERTは競合を無視しないので、計画後に状態が変わった場合も上書きしません。
4. 合成データのテストに加えて、生成SQLをローカルD1へ適用して件数・名前・ID・Google識別子を確認します。manifestのR2キーだけを旧バケットから取得し、新バケットへ同じキーでコピーする計画を確認します。画像は取得後にWebPとしてデコードし、ハッシュ一致を確認します。旧バケットから削除しません。
5. 差分・対象件数・検証結果の開発者承認後、manifestの各キーを `wrangler r2 object get tetraboard-objects-prod/<key> --remote --file <一時ファイル>` で取得し、`wrangler r2 object put tetraboard-2026-objects-prod/<key> --remote --file <一時ファイル> --content-type image/webp` でコピーします。画像が確認できてから生成SQLを新版D1へ適用します。D1のSQLファイル適用は途中まで反映される可能性があるため、失敗時は最新スナップショットを再取得し、既存分を再検証して計画を作り直します。
6. 新版へデプロイ後、対象ユーザーがGoogleで再ログインし、初回設定を要求されず元の名前・ID・画像が表示されることを確認します。元データに外部URLがあった場合は仮アイコンが表示され、本人がアップロードして設定できます。一時ファイルは確認後に削除します。

マージ・公開・本番データの移行は、差分と確認結果に対する開発者承認後に実施します。Secret名とR2の存在確認だけでは、Google側のコールバック設定・秘密値の正しさ・CD用APIトークンのR2権限は確認できません。

## アカウントでのルーム参加

ルーム作成・参加APIはログイン中に `name` を省略できます。サーバーがCookieから本人を確認し、最新プロフィールを取得します。ゲストには従来どおり1〜10文字の `name` が必要です。内部アカウントIDや画像をJSONで指定することはできません。ログイン参加は `APP_ORIGIN` と一致するOriginを要求します。既存の参加トークンと再接続の手順は変更しません。

`0004_account_room_entry.sql` でD1に全ルーム共通の席予約・画像参照と、索引のホストアイコン列を追加します。`account_seated` / HTTP 409は既にほかの席を持つアカウント、`profile_required` / HTTP 403は初回設定未完了を示します。認証・D1取得に失敗したときはゲストへ自動降格しません。

Workerテストはサーバー本人確認、入力偽装・初回設定、同時作成・参加の排他、プロフィール編集・ログアウト・画像保持、退室・復帰期限切れ・脱落、予約中断・取消後の遅延RPCと解放の再試行を検証します。作成・番号・招待の参加payload、重複参加と認証失効はDOMテストで確認します。ロビーの4つの丸ぽちは人間・CPU・空席の順で緑・青・グレーにし、読み上げ用の内訳を付けます。

ログイン中の「すぐ遊ぶ」は `CpuMatchNotice` で「CPUを含んだ対局は、戦績に反映されません。」と「ランキングにも反映されません。終局した対局の履歴・棋譜は保存されます。」をCPU説明の直下に表示します。ゲストと通常の作成・参加には表示しません。

CPU追加の確認レベルは両ゲーム共通の `RoomViewShell` で保持し、PC境界で `RoomInfo` が再配置されても確認を保持します。ログイン中かつCPU0人で毎回確認し、既存CPUあり・ゲストは直接追加します。確認時にも接続・待機・ホスト・空席・ログイン取得状態を再確認し、既存の設定送信pendingガードを使います。取消・閉じる・Escapeでは送信せず、閉鎖後は追加ボタンまたはルームへフォーカスを戻します。`AccountLayout` は初回・再試行・フォーカス復帰の取得中を明示し、取得失敗をゲストに降格せず再確認を案内します。

CPU追加は `useCpuAddition` のDOMテストで確認します。ログイン済みの初回だけ確認し、ゲスト・CPUありは直接追加、取消は未送信、全削除後は再確認とします。満席・対局開始・ホスト喪失・認証の取得待ちや失敗では確認を省略して送信せず、確認中の権限変更で保留を破棄します。

対局中も人間の参加者が全員退室・復帰期限切れになれば、未決着の部屋を閉鎖します。脱落による終局を先に判定し、終局した対局は保存します。投了・脱落後の在室者（ゲストを含む）と30秒の復帰待ちは部屋を維持し、通常の観戦者は維持条件に含めません。期限切れ後の閲覧資格は在室者に数えません。閉鎖で現在局の棋譜・CPU選択を破棄しても、過去の保存待ちと将棋の保護局は残し、必要な再試行Alarmを維持します。両ゲームの退室・切断・同資格の別接続・保存失敗と番号再利用をWorkerテストで、閉鎖受信による接続終了と案内をWebのDOMテストで検証します。

## 終局保存と本人の対局履歴

`0005_match_history.sql` はD1に対局本体 `matches` と本人別の索引 `account_match_history` を追加します。既存のローカル開発・テスト・CDのマイグレーション手順で適用します。保存処理の障害復旧をWorkerテストで確認した後、履歴APIとWebを接続します。`0006_shogi_match_history.sql` は本人索引へゲーム列（既定値はリバーシ）とゲーム別索引を追加し、将棋用の非公開アップロードmanifest `shogi_match_uploads` と100イベントごとの `shogi_match_chunks` を作ります。

GameRoomは対局開始時に棋譜と共通のUUID・開始日時・参加者情報を非公開の `match-start` に記録します。終局時に再戦待機への変更または部屋閉鎖と同じトランザクションで `match-pending:<UUID>` を作り、D1へ非同期保存します。本体と全アカウント索引をD1のbatchで一括保存し、索引の本人情報は保存済み本体から取得します。一意制約で再送の重複を防ぎ、既存の対局を上書きしません。成功を確認した保存待ちだけを削除し、失敗時は5秒後のAlarmで再試行します。保存待ちは部屋や直前1局の棋譜とは独立して保持し、部屋がない状態や番号再利用後にもAlarmを動かします。

`GET /api/account/matches?game=four-reversi|four-shogi&mode=singles|doubles&cursor=<開始日時ms>:<UUID>` はCookieで確認した本人の開始時の参加局だけをゲーム・モード別に返します。`game` の省略時はリバーシです。開始日時・UUIDの降順で21件を取得し、応答は `{ matches: [...最大20件], nextCursor: string | null }` です。カード用応答は日時・ゲーム・モード・参加者・結果だけを含み、内部アカウントID、参加資格、部屋識別子、盤面、棋譜は含めません。アカウント参加者の名前・画像は取得時の現在のプロフィールを参照します。ゲスト・CPUと参照先のないアカウントの名前は保存名を使います。GETにOriginヘッダーを必須とせず、プロフィール変更用の回数制限も適用しません。未認証は401、不正な条件は400、認証取得・D1取得の失敗は503とし、全応答に `Cache-Control: no-store` を付けます。

Workerテストは通常終局の棋譜再現、投了・退室・時間切れ・通信切れ、人間不在で未決着の打ち切り・非保存、退室による即時終局の保存、ゲストのみの保存、D1本体／索引の一括保存、複数局の保存失敗・再戦・閉鎖・番号再利用・再送、導入前の対局の除外を確認します。履歴APIは本人限定、両モード、0・20・21・41件、同時刻のページング、名前・画像変更、認証・D1障害を確認します。Webは履歴カードの値とリンク、空一覧、取得失敗と再試行、追加取得、共通のゲーム・モード、保持と遅延応答、更新をDOMテストで確認します。履歴の期限削除は行いません。

保存参加者の内部アカウントIDを重複排除し、`participantProfiles` で現在の名前・アイコンを一括取得します。本人用・公開用の一覧と詳細は同じ変換処理を使い、応答項目と保存JSONは変更しません。画像未設定・参照先なしは仮アバターとし、プロフィール取得障害は503です。プロフィール変更は次回取得時に反映し、表示中の自動同期は行いません。ルーム内の直前局の結果は従来どおり当時の表示情報を保持します。

## 最近の対局一覧と公開棋譜

`0009_public_matches.sql` は `matches (game, started_at_ms DESC, id DESC)` の索引を追加します。記録の書き換えや再保存は不要です。公開一覧は本人索引を使わず、保存完了した本体を参照するため、ゲストのみの対局も含み、将棋の転送途中のmanifest・チャンクは公開しません。

`GET /api/matches?game=four-reversi|four-shogi` はゲーム指定必須で、両モード・CPU戦を含む最新20件を開始日時・UUIDの降順で返します。応答は `{ matches: MatchSummary[] }` です。`GET /api/matches/:matchId` は本人用詳細から `selfPlayerId` を除いた公開詳細を返し、`GET /api/matches/:matchId/replay?cursor=<event offset>` は将棋のイベントを100件ずつ返します。認証不要、不正条件は400、対象なし・リバーシへのイベント取得は404、D1障害・不整合は503、全応答は `no-store` です。アカウント参加者の名前・画像は取得時の現在のプロフィール、ゲスト・CPUと参照先のないアカウントの名前は保存名を使い、内部アカウントID・instanceId・参加資格・チャットは返しません。本人用APIの認証・本人索引は維持します。

公開一覧の任意条件 `humanOnly=true|false` は省略時にfalse、不正値は400です。trueでは保存済みJSONの開始時の参加者が4人かつ全員humanの条件をSQLで適用してから並べ替え・20件制限を行います。ゲストも含み、CPUが1人でもいる対局は除外します。既存の保存データと索引を使い、migration・記録の書き換えは不要です。

Webは両ロビーの公開ルーム直下に共通棋譜カードを一列・内部横スクロールで表示します。表示時と手動更新のみ取得し、成功時は左端へ戻します。失敗時は既存一覧と位置を保持し、再試行を案内します。ゲーム切替・離脱では取得を中止し、前ゲームの遅延応答を採用しません。公開 `/matches/:matchId` と本人用の画面は棋譜の復元・盤面・結果・回転を共有し、公開閲覧では本人IDを作らず、リバーシは黒・将棋は南を手前にします。プロフィール設定への転送を行わず、戻り先は対象ゲームのロビーです。Workerは直接URLにもSPAのindexを配信し、HTTPの `X-Robots-Tag` と画面のrobotsメタで検索対象外にします。計測は `replay` と対局のゲームで分類します。

「人間4人の対局のみ」は見出し下・一覧上に配置し、初期状態はチェックなしです。ロビー表示中だけ保持し、ゲーム別にkeyを変えて再読み込み・ゲーム切替では初期状態へ戻します。条件切替では即座に前の取得を中止し、旧条件のカードを消して再取得します。読み込み中も切替可能で、古い応答は採用しません。切替失敗では選択条件を保って再試行を案内し、同条件の更新失敗では既存一覧と位置を保持します。対人条件が0件なら「人間4人の対局履歴がありません。」を表示します。Webは対人条件にCPUを含む応答も拒否します。

ロビーの棋譜カードだけ、開始時刻から1時間以内は切り捨てた分数（1分未満は0分前、ちょうど1時間は60分前）、1時間を超えて24時間以内は切り捨てた時間数（ちょうど24時間は24時間前）を表示します。24時間を超える時刻と端末時計より未来の時刻は従来の端末時間帯の年月日・時分です。共通カードに任意の相対時刻の基準を渡し、マイページでは従来の日時表示を維持します。time要素のdatetime・titleとカードのaria-labelは正確な開始日時を保持します。ロビーの時計は一覧取得後と1分ごとに更新し、離脱時にタイマーを解除します。表示時刻だけの更新ではAPI再取得・カードの並べ替え・スクロール位置のリセットを行いません。単体テストで分・時間・24時間の境界、日付をまたぐ経過時間、未来時刻、本人用の日時表示を確認します。

Workerの `publicMatches.test.ts` で最新20件・同時刻・ゲーム分離・両モード・CPU／ゲスト・匿名取得・転送途中の除外・非公開情報・本人用APIの認可・不正条件・D1障害を確認します。Webの `publicMatches.test.ts` は公開取得・初期方向・既存棋譜の再現・将棋の連番と最終局面の一致・取消・不正応答を確認します。関連の単体テストは `bun run check` に含まれます。

対人フィルタのWorker回帰では両ゲーム・両モードでCPU1人の除外・ゲスト4人の採用・0件・絞り込み後の最新20件と同時刻順序を確認し、最新21件がCPU戦でも古い対人戦を取得できることを検証します。Webでは条件の送信・CPU入り応答の拒否・取得中止と中止後の遅延応答の拒否を確認します。

## 保存済み棋譜の閲覧

`GET /api/account/matches/:matchId` はCookieで本人を確認し、`account_match_history` と `matches` を結合して本人の対局だけを取得します。応答は `{ match: MatchDetail }` で、対局ID・元の部屋番号・開始／終了日時・設定・開始時の参加者と本人のプレイヤーID・最終ゲーム状態・脱落理由・棋譜を含みます。アカウント参加者の名前・アイコンは取得時の現在のプロフィール、ゲスト・CPUと参照先のないアカウントの名前は保存名を使います。内部アカウントID・instanceId・参加トークン・チャットは返しません。不正IDは400、未認証は401、他人／存在しない対局は404、認証／D1取得失敗は503です。全応答に `Cache-Control: no-store` を付けます。将棋の詳細は棋譜本体に代えて `{ rulesVersion: 1, initial, eventCount }` と方向別 `knockouts` を返し、脱落は最終ゲーム状態の `eliminations` に含みます。

Webの `/account/matches/:matchId` は専用loaderと `MatchReplayPage` で取得・閲覧します。移動時は取得をキャンセルし、失敗画面から再試行できます。再試行は同じURLへの履歴置換でloaderを再実行し、取得成功時にエラー境界を解除します。再試行中はボタンを無効にし、連続失敗後も再試行できます。`RoomLayout`・`RoomInfoCard`・`ReplayCard` とゲーム別の盤面・カード・結果ダイアログを通常ルームと共有します。リバーシの棋譜は既存の状態列、将棋は初期化情報とイベントをエンジンで再生します。棋譜閲覧はルームセッション・チャット・招待hookを起動せず、参加資格を読み書きしません。プレイヤーカードの棋譜表示は選択局面と保存された脱落理由から求め、未来の脱落を表示しません。

Workerテストで本人限定・両モード・不正ID・未認証・取得障害・非公開情報の除外・名前とアイコン・実終局と部屋閉鎖後の取得を確認します。Webテストで本人の配置・石数・脱落・着手枠・通常終局と自動パスを確認します。棋譜の取得・認証失効・abort・ページ境界・失敗と再試行はloaderとDOMのテストで確認します。局面操作はローカルで行い、オンラインルームへ接続せず参加資格を維持します。

## 本人の戦績集計

戦績とランキングは共有SQLの `matchOutcomesCte` で、保存された開始時の `participants` が4人かつ全員 `kind: human` の対局に限定します。ゲストの相手も人間として扱い、本人の集計・ランキング掲載は既存のアカウント索引を使います。順位・勝敗・引き分け・率の分母・将棋の累計撃破数を同じ条件で集計し、過去の保存済みCPU戦にも適用します。履歴・詳細・棋譜の取得にはこの条件を付けず、CPU戦の記録と撃破数は保持します。APIのURL・応答型、DBの保存形式を変更せず、移行・削除・再保存は不要です。

`GET /api/account/stats?game=four-reversi|four-shogi` はCookieで本人を確認し、既存の `account_match_history` と `matches` の保存結果をD1内でゲーム別に全件集計します。省略時はリバーシです。リバーシの応答は `{ singles: { total, first, second, third, fourth }, doubles: { total, wins, losses, draws } }` です。順位は本人の開始時の色に対応する確定順位、勝敗は黒・赤／白・青のチームと保存された勝者から求めます。引き分けも `total` に含めます。全応答は `Cache-Control: no-store`、未認証は401、不正なゲーム指定は400、認証取得・D1集計失敗は503です。将棋のシングルスは `knockouts` を追加し、開始時の本人の担当方向から確定順位と撃破数を引きます。ダブルスは南・北／西・東のチームで勝敗を判定します。

Webは`ProfilePage`で`useAccountSelection`を一度読み、共通のゲーム・モードを`AccountStats`と`MatchHistory`へ渡します。`useAccountStats`はゲーム別の両モード、`useMatchHistory(game, mode)`はゲーム・モード別の棋譜一覧を取得・保持し、各カードの更新・再試行を維持します。カードは共通タブの選択パネル内に置き、ゲーム・モードの切替で取り外しません。棋譜へのリンクとマイページへの戻りには共通の`accountSelection`（ゲームとゲーム別モード）をブラウザ履歴stateで渡し、選択変更は履歴置換で保存します。旧`accountSelections`は有効な値を棋譜側・戦績側・初期値の順に読み取り、無関係なstateを保持します。初期値は四人リバーシ・シングルスです。戦績タイトル下に「対人戦のみ集計」を表示し、率は集計対象の対局数を分母にして `.000` 形式の小数3桁で表示します。読み込み・失敗を0件として表示せず、更新中と更新失敗時は取得済みの戦績を保持します。

Workerテストで両ゲーム・両モードの人間4人、CPU1〜3人の過去分除外、CPU戦のみの本人の0件表示と履歴・詳細・棋譜の保存を確認します。集計用データは対人戦、保存用データはCPU戦を維持します。本人限定・全順位・同順位・両チームの勝敗・引き分け・0件・20件超・保存再送・実終局の反映・認証とD1障害を確認します。Webは率の丸め・0件、表示値、棋譜と共通の選択・ゲーム別モードの復元、読み込み・失敗・再試行・更新を純粋関数とDOMテストで確認します。

## 公開プレイヤー情報

`participantProfiles` は保存参加者から内部IDを重複排除する入口として維持し、`readCurrentProfiles` に現在の名前・公開ID・画像・設定状態の一括読取を集約します。保存棋譜の公開変換は従来の名前・画像だけを使い、公開カードの可否判定とは分けます。保存JSON・参加者スキーマ・本人索引・将棋イベントを変更しません。

`0010_player_profiles.sql` は `user.publicProfileId` の一意UUIDと `room_index` の部屋世代・ホストID列を追加します。内部アカウントIDと変更可能な公開IDから独立した参照キーを既存ユーザーへ付与し、プロフィール保存では未設定の場合だけ生成します。デプロイの間に未付与の登録者が生じても、参照の返却時に条件付きUPDATEで補完します。旧Workerの動作は追加migration後も維持できます。

`GET /api/player-profile` はゲームと参照種別を必須にします。`source=room` は `roomId, instanceId, playerId`、`source=match` は `matchId, playerId`、`source=profile` は `profileId` を渡します。GameRoom内部の参加者・アカウント対応、保存記録、公開参照キーをサーバーで照合します。名前や画像で本人を判定せず、内部IDはHTTP・WebSocketへ返しません。登録者には現在のプロフィールと対象ゲームの `{ singles: { total, first }, doubles: { total, wins } }` だけを返し、既存の `readAccountStats` を呼びます。ゲスト・CPUを区別し、不正400、対象なし404、部屋世代変更410、障害503、全応答no-storeです。対局のWebSocket配信へD1取得を追加しません。

ロビー・ランキングは `profilePreview=1` の要求にだけ参照情報を追加します。通常の応答は従来の形で、旧Workerの400では通常取得へ戻ります。ロビーの古い索引で参照情報がない行は `getPublicMetadata` で現在の部屋世代とホストへ補完し、閉鎖済みを除外します。参照のない旧応答をゲストと判断しません。

Webのプレイヤー機能は取得store、Provider、表示カード、トリガーに分離します。成功結果を60秒再利用し、解決した公開参照キーとゲームで共有します。プロフィール保存・終局・画面遷移で無効化し、abort後や旧要求の完了を採用しません。HeroUIのPopoverは非モーダルで位置・Portalを再利用し、開閉・フォーカスは操作種別に応じて制御します。ランキング内ではPortalを所属ダイアログへ置き、Escapeの伝播を止めて外側を閉じません。

Workerの `playerProfiles.test.ts` と既存の公開／本人棋譜・戦績テスト、Webの `playerProfiles.test.tsx` で匿名取得、別人への誤紐付け防止、ゲスト・CPU・参照先なし、旧応答、取得障害、開閉、再試行、キャッシュ期限・無効化・遅延応答を確認します。実寸法・ネイティブ入力・画像デコードは手動確認し、PRへ結果と未確認を記載します。

## ゲーム別のランキング

`GET /api/games/four-reversi/rankings` と `GET /api/games/four-shogi/rankings` は認証不要で、`{ singles: { first, total }, doubles: { wins, total } }` の各上位10人を返します。各行は `rank`・`username`・`name`・`avatarUrl`・`value` です。既存の `account_match_history`・`matches` を対象ゲームに限定してD1内で全件集計し、現在の設定済みアカウントのプロフィールを結合します。本人戦績と同じ順位・チーム勝敗の判定を使います。将棋にも優勝数／対局数・勝利数／対局数を用い、撃破数のランキングは設けません。

SQLの `RANK()` で同順位と順位の飛びを求め、値の降順・公開IDの昇順の `ROW_NUMBER()` で10人に制限します。集計値が1以上の人だけを掲載します。名前・画像は履歴の開始時情報ではなく現在のプロフィールを参照します。内部アカウントID・棋譜は返しません。全応答は `Cache-Control: no-store`、D1取得失敗は503です。

ロビーの `LobbyRankings` と専用hookで全ランキングを取得し、通常表示は上位3人、共通ダイアログでは上位10人と対局数を表示します。ロビーと詳細に「対人戦のみ集計」と表示します。両画面で取得結果と更新状態を共有し、更新失敗時は既存データを保持します。モード切替はロビーと詳細で独立し、キャンセル済み応答で新しい取得結果を上書きしません。ロビー上部は768pxで等幅2列へ切り替え、盤面図をタイトル左へ移します。767px以下の表示順は操作カード・公開ルーム・最近行われた対局・ランキングです。`matchMedia` を `useSyncExternalStore` で購読し、同じ親内のkey付き領域を並べ替えて、DOM順と表示順をそろえながらランキングの状態を保持します。操作ボタンは説明付きの2段にし、「みんなで遊ぶ」のラベルを作成ボタンの前に置きます。公開ルームの一覧部分だけ、767px以下で最大400px・縦スクロールにし、見出し・更新・エラー・補足・追加読込は領域外に残します。

Workerテストで匿名アクセス・全色・同率優勝・両チーム勝利・引き分け・CPU戦除外・ゲスト相手の対人戦とゲスト本人の掲載除外・0件・0回除外・10人の境界・全履歴・再送・プロフィール更新・未終局と実終局・D1障害を確認します。Webは初回取得・失敗・再試行・更新時保持とモード・集計項目・上位3人／詳細10人の表示をDOMテストで確認します。

ロビーは取得失敗・追加取得・0件と末尾・参加／観戦のURL、ランキングの取得済み値・選択と更新をDOMテストで確認します。偽の幅変更通知によるDOM順・選択の保持は確認し、画面幅ごとの寸法やフォーカスの実ブラウザ検証は自動検証対象から外します。画面のレスポンシブ仕様は維持します。

## 四人将棋の恒久記録の確認

将棋はDOの終局トランザクションでメタデータ・保存待ちと `shogi_archives` の保護局を確定します。再戦・閉鎖・番号再利用でも保護局のイベントを削除しません。Alarmごとに最大400イベントをD1へアップロードし、全チャンクを逐次検証してから `matches` 本体と本人索引を最後のD1 batchで公開します。途中状態は一覧・戦績・ランキングへ出さず、失敗は5秒後に再送します。成功後は保存待ちと保護を解除し、現部屋の直前局ならイベントを残し、別局または閉鎖後なら不要な行を削除します。リバーシのJSONと保存処理は維持します。

終局保存は導入後に開始した対局だけを対象とし、導入前・導入時に進行中の棋譜や撃破数を補完しません。撃破数は受理されたシングルス着手の新たな `checkmate` 脱落だけを着手者へ人数分加算します。CPUも記録し、外部脱落・`no_legal_actions`・ダブルスは加算しません。エンジンの順位や勝敗を変更せず、対局記録の集計情報として扱います。

`GET /api/account/matches/:matchId/replay?cursor=<event offset>` は本人の保存済み将棋対局を100イベントずつ返します。応答は `MatchReplayPage`（`matchId`・`rulesVersion`・`initial`・`eventCount`・`events: [{ index, event }]`・`nextCursor`）です。詳細と同じ本人限定・認証・不正ID・障害・no-storeの規則を使います。Webは対局ID、バージョン、初期化情報、件数、連続番号とカーソルを照合し、`createInitialState`・`applyAction`・`eliminateSide` で復元して保存済み最終状態と比較します。途中の移動でfetchを中止し、失敗時は未完成の棋譜を表示せず再試行します。

固定データは公開エンジンで受理される初期局面からのイベント列で作ります。Webの純粋関数・DOMテストは戦績・棋譜の4つのゲーム／モード、遅延応答・更新失敗時の保持、方向・持ち駒・成り・裏王・読み取り専用を確認します。同時脱落はWorkerと保存棋譜と共通のframe生成を合わせて確認します。ランキングの匿名取得・集計・人数境界はWorker、表示内容・選択と失敗・再試行はWebで確認します。リバーシの通信形式と既存棋譜の互換性は維持します。

## 観戦と保存済み棋譜の回転

両ゲームの観戦と保存済み棋譜は、閲覧画面の0〜3の回転状態を共有ボタンで進めます。観戦者の状況カードは「観戦中」・参加可能なら参加ボタン・回転ボタン、保存済み棋譜は「棋譜閲覧中」・回転ボタンを下段に表示します。参加者のルーム内棋譜は対象外です。将棋は既存の座標・駒方向・持ち駒・カードの変換を使い、リバーシは表示マスを基準座標へ戻して盤面と最終手を参照します。カードは時計回りに位置だけを変え、文字は回転しません。通信・サーバー状態・棋譜データへの書き込みは行いません。

状態は手数変更・タブ切替・再接続・同じルームの次局開始で保持し、ページ再読み込みと画面の識別子・参加資格の切替で初期化します。座標変換・回転・閲覧権限は純粋関数、局面変更時の保持はhookテストで確認します。

## 計測用管理画面の開発と公開

`apps/admin` はWebと同じReact・HeroUI・Tailwindを使い、SVGでグラフを描きます。`bun run dev` はWorker・Web・Adminを起動します。AdminのViteは5174で起動し、Webの `/admin` をプロキシするため、ブラウザでは `http://localhost:5173/admin` を開きます。Google認証は既存の同一オリジン設定を使い、専用のOAuthクライアントや別の本番Workerは不要です。開発用Vite自体のHTMLは認証前も取得できますが、管理データは常にWorkerの本人確認を通します。本番はHTMLとアセットも本人限定です。

### 管理者設定

ローカルの追跡対象外 `.dev.vars` に `ADMIN_ACCOUNT_IDS` をJSON配列（例：`["owner-id-1","owner-id-2"]`）で設定します。値は本人の内部 `user.id` で、公開IDの `username`・Googleの識別子・メールとは異なります。本人のプロフィールを公開IDまたはメールで検索したD1の行から確認してください。IDをソースやフロントエンドの環境変数へ埋め込みません。設定なし・空配列・不正な配列は503で閉じ、開発者用の認証回避は設けません。従来の `ADMIN_ACCOUNT_ID` は配列が未設定の場合だけ利用し、不正な配列からはフォールバックしません。

本番は開発者の指示に基づき、`apps/worker` で `bunx wrangler secret put ADMIN_ACCOUNT_IDS --env production` から本人のIDのJSON配列を設定します。secretに保存したIDは認証と本人利用の除外で共通に使います。公開・マージは差分と確認結果をレビューした開発者の承認後に行います。既存の `MODERATOR_TOKEN` は通報API用で、管理画面には使いません。ログイン画面の `destination=admin` はサーバー固定の `/admin` へだけ戻し、任意の外部URLをOAuthの遷移先にしません。

### データとAPI

`0007_analytics.sql` は閲覧・日別累積時間・対局・人間の開始時情報と計測開始日時を追加します。過去の棋譜を集計へ移しません。ブラウザのCookieがないゲストは対局数には含めますが、ユニーク利用者・開始率・継続率には含めません。既存アカウントはCookieがなくても登録利用者の集計対象です。テスト区分は閲覧・参加時のサーバー情報を記録します。

- `POST /api/analytics/pageviews` はUUID・画面種別・ゲーム、`POST /api/analytics/dwell` はビューUUIDと日本時間の日別累積ミリ秒を受け取ります。Origin、容量、形式、所有ブラウザ、実経過時間による上限を検査し、閲覧の重複送信・古い時間更新で増加させません。
- `GET /api/admin/session` は本人確認、`GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&game=all|four-reversi|four-shogi&bucket=day|month&includeInternal=false|true` は期間全体と各期間の集計を返します。開始・終局はブラウザから受け付けません。ゲストのブラウザIDや内部アカウントIDは集計レスポンスに含めません。
- `GET /api/admin/users?search=名前またはID&cursor=...` は50件と次カーソルを返します。現在のR2アイコンを参照し、未設定・取得失敗時は仮アバターにします。同時刻は内部IDを使った安定した順でページングします。

登録日時はBetter Authが保存するISO文字列と既存のUNIXミリ秒整数を読み取り時にミリ秒へそろえ、一覧の応答・並び順・カーソルと新規登録数の日別／月別集計に使います。DBの日時を一括で書き換えません。Workerテストは両形式の混在と同時刻の追加取得、日本時間の月境界、計測開始前と期間外の除外を検証します。

### ビルドと確認

`bun run build` はWeb・Adminを個別にビルドし、`scripts/buildAssets.ts` で `apps/worker/dist/assets` にWeb、その `admin/` 配下にAdminをまとめます。Wranglerはこの成果物を配信します。Adminの深いURLは認証後に専用indexを返し、HTMLの自動転送を無効にしてリダイレクトループを防ぎます。通常WebのSPA・API・WebSocketを維持します。CI/CDも同じビルド成果物を使います。Worker単独のdry-runや本番構成プレビューの前に、必ず `bun run build` を実行してください。

本番構成のローカルプレビューは `preview:production` がupstreamも `http://127.0.0.1:8788` にそろえます。本番のcustom domainをupstreamとして使うとWranglerがOriginを書き換え、ローカル用 `APP_ORIGIN` と一致しなくなるためです。

`bun run check` はAdminの型・表示計算・DOMテストと計測のWorkerテストも含みます。Web計測は偽時計・visibility通知・複数の偽Lock主体で検証します。Adminは集計条件・検索・追加取得・競合・削除・401/403時のデータ破棄を検証します。実Google認証・本番データでの確認はローカルのモック検証と区別して報告します。

## フィードバックの受付・運営

共通仕様はREADMEの「フィードバック受付と改善のお知らせ」を参照します。`packages/protocol/src/feedback.ts` のスキーマをWeb・Worker・Adminで共有し、`0008_feedback.sql` は投稿・テーマ・編集履歴・送信上限・アップロード予約を追加します。既存ゲーム・通報のデータ形式は変更せず、過去データの移行は不要です。プロフィール未完了でも `/feedback` と `/updates` を開けるよう、通常の設定画面への転送から除外します。

### 受付と非公開画像

`POST /api/feedback` はmultipartの `input`（JSON）と任意の `attachment`（静止WebP）を受け、201で `{ id }` だけ返します。送信IDはWebが生成し、入力または画像を編集すると新しくします。失敗時は同じ入力・画像・技術情報を固定して再送します。サーバーは本文と画像のハッシュを照合し、同じIDの異なる内容は409です。D1の一意制約と同一batchの上限更新により、並行送信も1件として数えます。画像ありは保存予約を先にD1へ記録し、R2保存後に受付を確定します。失敗した予約は一覧に出さず、同じ内容の再送で回復します。

技術情報は許可した項目だけを厳密に検証し、認証で確認した登録／ゲストと内部利用の区分をサーバーで付けます。ログイン必須として送った投稿や、残ったログインCookieを確認できない場合は401、認証・DB・R2障害は503です。ゲストへ自動降格しません。容量はContent-Lengthに依存せず読み取り中に1MiB＋64KiBで制限し、上限超過は413、形式不備は400／415、送信上限は429とRetry-Afterです。ゲストの専用HttpOnly・SameSite=Lax Cookieは180日、本番はSecureです。Cookie拒否はブラウザ重複排除を不完全にしますが、IP側の上限も適用します。

Webは元画像5MiBまで、長辺1,600px・1MiB以内のWebPへ変換します。既存のWebP WASMを共通の画像モジュールへ移し、フィードバックでは全ブラウザで画素だけを再エンコードしてメタデータを除去します（ChromiumのCanvas WebPにはICCが付くため）。アバターの切り抜き・256px固定仕様は維持します。WorkerはRIFF・WebPチャンク・寸法・容量を確認し、EXIF・XMP・ICC・アニメーションを拒否します。R2の `feedback/` を使い、公開アバター経路へ流用しません。管理者認証後の `GET /api/admin/feedback/:id/attachment` だけで配信し、no-storeとnosniffを付けます。送信内容・画像・IP・secretをログへ出力しません。

### 管理APIと保存期限

一覧・詳細・PATCH・DELETE、テーマのGET／POST／PATCH、集計APIは `/api/admin/feedback` 配下です。管理者は既存のADMIN_ACCOUNT_IDSで確認し、すべての書き込みにOrigin検査を追加します。一覧は受信日時・IDの降順カーソルで50件ずつ。更新と削除にはversionが必須で、競合は409です。完了には `published: true`、見送りには運営メモが必要です。初回確認日時は初めて未確認から変更した時点にだけ記録します。集計は期限内・受付確定済み・未削除だけを対象に、迷惑投稿を除き、内部投稿も初期除外します。テーマ変更・削除は現在の集計へ反映します。

180日以上と削除済みは読み取り時点で除外します。既存の毎時処理に削除を追加し、先に非表示、R2削除後にD1本文と履歴を削除します。失敗した行は残して次回再試行し、24時間以上の未確定予約・孤立画像と期限切れ上限カウンターも掃除します。1回100件ずつ処理するため、削除件数が多い場合と障害時は物理削除が遅れます。期限切れ・削除済みの閲覧拒否はその間も維持します。テーマ名だけは残せます。

### 設定・確認・公開

ハッシュ用に `FEEDBACK_HASH_SECRET`（32文字以上のランダム値）を使います。HTTPのローカル環境だけに専用の既定値があり、本番で未設定・短すぎる場合は受付を503で閉じます。本番公開の承認後、`apps/worker` で `bunx wrangler secret put FEEDBACK_HASH_SECRET --env production` から設定します。認証secretを流用せず、ソースやフロントエンドへ埋め込みません。ローカルは追跡対象外の `.dev.vars` に設定できます。稼働中に変更すると既存の報告者の集計と送信上限の識別が分かれるため、定期的な変更は行いません。

お知らせは `apps/web/src/features/updates/updates.ts` の構造化データで管理し、ID・日付・対象・見出し・説明をレビューします。公開時の日付を確認し、機能と同じ成果物で配信します。UIを失敗させる外部取得はありません。ViteはGitのコミットをビルド識別子へ埋め込み、アーカイブからのビルドでは `VITE_APP_REVISION` を明示します。

Worker統合テストはHTTP・実D1・R2で権限、並行再送、保存失敗、上限境界、競合、集計、期限と削除再試行を確認します。WebのDOMテストはフィードバックの入力・画像処理・下書き・再送ID・technicalの秘匿・送信ロックを、Adminは分類・競合・公開前確認・履歴・削除・権限喪失を確認します。実画像デコード・実描画は対象から外します。

## 任意登録の案内と画面復帰

登録案内は両ゲームで共通の `RegistrationPrompt` を使い、参加フォーム・通常ルームの結果に配置します。結果の自動表示は、認証を確認できた未ログイン参加者がplayingからwaitingへ進んだ場合だけを対象とします。他のダイアログを優先し、既存結果の閲覧では自動表示しません。`tetraboard:registration-result-shown` を表示後に保存し、両ゲームを通じて同じタブで1回に制限します。保存不能時はモジュール内のメモリで抑止します。

Google認証開始を `useGoogleSignIn` に集約し、既存の認証APIと固定コールバックを維持します。管理画面へのログインもこの処理を使い、`destination=admin` を送信して固定の `/admin` へ戻します。その際は通常登録の画面復帰情報を消去し、プロフィール設定画面への誘導より管理画面への復帰を優先します。`tetraboard:registration-return` に元画面・参加入力・開始時刻を1時間保存します。許可する戻り先は両ロビーと部屋世代付きの部屋URLだけです。`RegistrationCompletion` が本人確認とプロフィール設定の完了後に復帰情報を消費し、復帰先も履歴から復元情報を除きます。入力の復元だけで作成・参加を送信せず、既存ゲスト席や対局履歴の紐付けも変更しません。失敗・取消時の入力保持、保存不能・破損・期限切れのマイページへのフォールバックを検証します。

登録案内とOAuth復帰は純粋関数・DOMテストで、ゲスト・アカウント・観戦・認証待ち、CPU戦・対人戦、初回終局・再戦・再読み込み、ダイアログ競合、認証境界の失敗、入力復元・消費、保存領域の失敗、部屋世代とゲスト席保持を確認します。実OAuthはWorkerでGoogle通信を置き換えて検証します。分析イベントの追加はこの機能に含めません。

## ルームの持ち時間・秒読み

両ゲームの作成・「すぐ遊ぶ」と待機室で `TimeControlSetting` を共有します。持ち時間はなし・1・3・5・10分、秒読みはなし・10・30秒です。「なし」は通信・保存上は0msとし、共通の `roomTimeControlSchema` でプリセット外と両方0を拒否します。作成リクエストの `timeControl` は省略可能で、省略時は従来の5分＋30秒です。選択値はダイアログを閉じても保持し、登録からの復帰でも検証して復元します。古い復帰データに時間がなければ初期値を使います。

待機中のホストは `room.time-control.set` に `{ timeControl: { mainTimeMs, byoyomiMs } }` を送ります。変更は保存・配信・公開索引へ反映し、人間全員の準備を解除します。同じ値の再送は準備・活動時刻・公開更新時刻を変えません。待機室では選択ごとに送信し、応答待ち・切断中は無効にします。再戦待機で変更しても前局の棋譜・保存済み対局の時間設定は書き換えません。

時計の開始と手番更新は両ゲームともルームの時間設定を受け取ります。持ち時間なしでは最初から毎手の秒読み、秒読みなしでは持ち時間だけを消費します。時間なしの枠はルーム情報に「なし」と表示し、秒読みなしでは0秒になっても秒読み色にしません。Workerで全14組み合わせ、開始・着手・CPU・脱落・自動パス・期限境界・権限・準備解除・永続化を確認し、Webで時計表示・登録復帰・選択payloadと待機室の送信待ちを確認します。

## 保存データの契約と棋譜互換

Workerの `matchDataContracts` は `GameId` ごとの保存記録読取り・公開要約／棋譜・戦績・ランキングの解析を必須登録します。JSONはunknownからゲーム別スキーマで検証し、内部IDと参加者のアカウント情報、設定・結果・棋譜の対応を確認します。D1のゲーム列と記録内のゲームが異なる場合も取得失敗です。集計の方向・順位・チーム・撃破数は `gameOutcomeSql` へ登録し、人間4人の条件と集計SQLは共有します。新ゲームは双方の登録と型対応が必要です。軽量カタログには保存スキーマ・エンジン・SQLを置きません。

| ゲーム | 保存形式 | 再生ルール | 既知の旧データ補完 |
| --- | --- | --- | --- |
| 四人リバーシ | 版項目のない既存JSON。初期・各手の局面を保存 | 保存された局面列を表示。ルール版を新設しない | 既存通信スキーマに定義された既定値のみ |
| 四人将棋 | 版項目のない既存メタデータJSONと分割イベント | `rulesVersion: 1` の初期化・イベント適用・フレーム生成 | 省略された引分提案を読取り時に空配列へ補完 |

保存形式の版、再生ルールの版、派生解析の版は別の責務です。未知のゲーム・ルール版・未対応の保存形状を既知形式へ読み替えません。破損した保存記録は既存の503、Webの再生不整合は既存のルートエラーとして扱い、未完成の棋譜を表示しません。今回、公開APIや保存JSONへ版項目を追加せず、migration・既存データ書換え・撃破数の補完は行いません。

読取りの正規化結果と保存用元データを分離します。将棋の保存待ちから来る元記録は、検証してもプロパティ順・省略項目を変更せずシリアライズし、既存manifestと同じ文字列で照合します。正規化した読取り結果を保存待ちやmanifestへ戻しません。全チャンクの検証後に本体・本人索引を公開する順序、最大400イベントの転送・検証、5秒後の再送、閉鎖後の保護、重複防止は維持します。

将棋の純粋な `fourShogiReplayV1` は保存棋譜とルーム内の直前局で共用します。取得・認証・ページング・中止・失敗処理は各loaderの責務です。現在のエンジンを呼びますが、将来の変更では固定棋譜との比較を必須とします。版1の再現性を壊す場合は新ルール版と旧版を再現する実装を別途用意し、旧版を最新のルールで黙って再生しません。移行する場合は開発者の承認後、元データを保持し、新旧の初期・途中・終局、結果・撃破数・本人索引・集計値を比較します。再実行しても重複しない手順と差異の報告を必須とし、自動バックフィルはしません。

`test-fixtures/matches` のJSONは作成元コミット・固定ID・日時・元保存JSON・将棋イベント・期待フレームを持ち、Worker、Webで共用します。通常初期局面から公開エンジンで受理された棋譜を一度生成して固定し、テスト実行時に期待値を再生成しません。省略形fixtureは既知の旧形式を再現したもので、本番から収集した記録ではありません。新しい互換ケースは既存fixtureを更新せず追加し、元データと期待値の差分をレビューします。関連テストは `bun run --cwd apps/worker test test/matchCompatibility.test.ts` と `bun test --cwd apps/web ./test/matchCompatibility.test.ts` です。

### Firebase棋譜の手動移行

Firebase `tetra-board` の旧棋譜は、元JSONをローカルに保持したまま `apps/worker/scripts/prepareFirebaseMatches.ts` でSQLと除外理由付き計画を作成します。このコマンドはDBへ接続せず、書き込みません。通常のアカウント移行で旧棋譜を除外する方針とは別の、開発者が対象を指定した手動移行です。

旧実装 `yksw-clm/tetraboard_archive` の `f70c9ba966d9a19f6165e8c72106fae310b6f237` の初期・途中・終局を照合します。リバーシは全局をシングルスとして扱い、旧初期配置・元着手・自動パス・盤面・結果を保持します。将棋はモード欠落、未記録の外部脱落等を必要とする棋譜、結果不一致を除外します。現行エンジンは脱落者の持ち駒を破棄し、ダブルス終局で敗者の王を死王として表示するため、その差が発生する局も除外します。推測したイベント、手番の強制変更、旧版と異なる局面を保存しません。時間設定だけは承認された例外として `null` を保存し、保存棋譜の持ち時間・秒読みを「不明」と表示します。ルームの時間設定は従来どおり必須です。

名前だけで本人を自動判定しません。旧UID・旧名と現在の内部アカウントID・公開IDを明示した `links.json` の指定だけを、現在の登録済みプロフィールと照合します。指定された「あるきびと」→ `arukibito`、「ちゃおっしー」→ `chaossi` 以外は `accountId: null` の人間ゲストです。開始時の表示名を保存し、旧画像・UID・認証情報を公開応答へ含めません。紐付いた対象局だけが本人履歴・既存の戦績／ランキング集計へ反映されます。保存名は元記録として維持しますが、閲覧APIでは紐付いたアカウントの現在の名前・アイコンを表示します。

事前に本番D1を読み取り、対象IDの `matches` 全列、`shogi_match_chunks` 全列、`account_match_history` 全列、および指定アカウントの `user` の `id, username, profileCompleted, isAnonymous` を `target.json` の `matches, chunks, history, users` に保存します。既存の記録・チャンク・本人索引と競合する場合は計画作成を停止します。同一データは再実行でき、SQL実行時にも既存行を上書きせず、変更された紐付け先や行の競合で停止します。SQLは本体の前に将棋チャンク、本体の後に本人索引を生成します。ゲストの本人索引は作りません。対象局の不足／余分な行がないことと集計差分を、実行前後で確認します。

```sh
cd apps/worker
bun scripts/prepareFirebaseMatches.ts <export-directory> <links.json> <target.json> <output.sql>
```

出力と元JSONはGit管理外・本人だけが読めるファイルとして保持します。SQLのローカルD1での保存・再実行、公開／本人応答、局面・結果・本人索引・戦績の比較と、全必須検証・GitHub CIを確認してPRを提出します。マージ・公開と本番取り込みは、差分・対象一覧・除外理由・検証結果をレビューできる状態にして開発者が承認してから実施します。承認後も実行直前に本番の事前照合を更新します。

### 四人将棋の戦型解析と通知

`packages/four-shogi/src/formations.ts` の `detectFormations(position, side)` はルール版・盤面・脱落情報だけを入力にし、公開局面とサーバーのルール状態をそのまま渡せます。16戦型の固定定義をここに集約し、初期配置と同じ `positionForSide` の回転を再利用します。結果は安定した `id`・`name`・9枚の `matchedSquares`（実盤座標）です。公開定数は `formationAnalyzerId = "four-shogi-formations"` と `formationAnalysisVersion = 3`。`formationIds` は定義順の全16IDを公開します。単独ID `subway-rook` は廃止し、`lower-gold` と `yuzuu-muge` は従来の配置とIDを維持して、それぞれ「地下鉄飛車・下段金寄せ」「地下鉄飛車・融通無碍」を正式名称にします。各名称を1件の解析結果として返します。条件・意味を変える場合は解析版を更新し、ルール版・保存版とは分けます。

HTTPの `GET /rooms/:id?formationAnalysis=1` とWebSocketの `/rooms/:id/ws?instanceId=...&formationAnalysis=1` は、通常の応答の `room` の外側へ任意の `formationAnalysis` を付加します。将棋の待機中は `null`、対局中は `{ analyzerId, analysisVersion, rulesVersion, roundId, positionRevision, matches: { south, west, north, east } }`。要求なしとリバーシには項目を付加しません。`protocol` は通信スキーマだけを管理し、戦型IDの列挙と判定条件はエンジンに置きます。エンジンへのprotocol依存追加はありません。成立一覧の上限は17件、根拠座標は各9件で、同時成立も別項目として返します。要求クエリと接続タグは解析版とは独立し、版3でも従来の形式を使います。受信上限17件は旧版との通信互換性のため維持します。

WorkerはWebSocketの要求を `formation-analysis-v1` 接続タグで保持し、従来の認証attachmentを維持します。配信ごとに通常応答と付加応答を各1回だけ生成して共有します。HTTP・WebSocketとも確定したルーム状態の4陣営を判定します。解析結果をルーム状態・棋譜・保存対局へ含めず、成立履歴やDB migrationを追加しません。WebはHTTPで付加項目の有無を確認し、対応Workerの場合だけWebSocketでも要求します。再接続時にHTTPで再確認するため、旧Workerへの切替も従来形式で動作します。

`useShogiFormationNotice` は `room.game` を共有関数で照合し、楽観表示用の `session.displayGame` とサーバーの派生結果を通知判定に使いません。認証・接続済みの本人について、同じ局の連続revision・連続手数・本人の直前手と不成立→成立を確認します。未通知の新規成立をすべて取り出し、通知データ `{ ids, name }` の名称を定義順に「・」で連結します。初回・再接続・飛んだrevisionは基準とし、既に成立している戦型も既知IDへ含めます。部屋世代・本人ごとの `sessionStorage` キーに局ID・解析版を含むscopeと通知済みIDを保存し、次局で置き換えます。保存値は全16種類の既知IDだけを受け付け、解析版1・2のscopeは引き継がず初回局面を基準にします。まとめ通知の全IDを通知済みにします。保存エラーはメモリ内の抑止へ退避します。別タブ同期は行いません。

`FourShogiBoardLayout` の任意propsで本人側2段目中央に名称を重ね、2000ms・選択・ドラッグ・成り選択・切断・脱落・終局・次局で消します。既存のCSS効果ファイルに置いた `shogi-formation-fade` は2秒のうち0〜180msをフェードイン、1760〜2000msをフェードアウトにし、opacityだけをease-in-outで変えます。名称をkeyにして別戦型への置換時はフェードを再開します。`motion-safe` で動きを減らす設定の場合は省略し、操作や切断などによる解除は即時のままです。表示・解除用の状態やタイマーは増やしません。盤内縮尺・クリック透過・`role=status` の控えめな読み上げを使い、音・フォーカス移動・寸法変更はありません。観戦と棋譜には接続しません。

エンジンは実装定義と独立した完成図fixtureで16形×4方向×両モードと各必須条件を検証します。Workerは実HTTP・WebSocketの混在接続、確定revision、再接続、インスタンス再作成時のタグ・認証維持、保存分離を検証します。WebはBun＋happy-domと偽時計で、受理前／後、1999ms／2000ms、重複抑止・保存エラー・操作・再接続時の対応確認を検証します。従来の固定棋譜の回帰も維持します。

### 将来の派生解析

囲いなどの派生解析は復元済みの読取り専用局面を入力とする純粋な処理として設計します。入力の出所はゲーム・対局ID・局面位置・保存形式・ルール版で識別し、結果は解析器ID・解析バージョン・対象局面・判定根拠を持つ別データとします。保存された盤面・棋譜・勝敗・撃破数は記録の正本であり、解析結果によって変更しません。解析からGameRoom、storage、D1の更新、戦績SQLを呼びません。解析の再実行も元データを変更せず、版ごとの結果を比較できる構成にします。

基本6戦型の判定と通信・通知は上記の専用処理で実装しています。汎用解析基盤・公開指標・解析の保存テーブルは追加しません。戦型別ランキングなど新しい指標とバックフィルは仕様承認、比較検証、再実行可能な移行計画を別途必要とし、Admin KPIは #43 の範囲です。
