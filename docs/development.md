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

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。
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

コード・設定変更では、PRを作成する前にルートから次の全コマンドを成功させます。UI・Adminは `CI=true` でビルド済み画面を検証し、Worker E2Eはproduction構成のローカルWorkerを使用します。すべてのブラウザ検証でChromium・WebKitの全ケースを実行します。

```sh
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
CI=true bun run --cwd apps/web test:browser
bun run --cwd apps/web test:browser:worker
CI=true bun run --cwd apps/admin test:browser
```

PR本文には検証対象コミット、実行環境、各コマンドの結果、未確認事項を記載します。PR提出後にコード・設定を変更した場合と、main取り込みでコード・設定が変わった場合も全コマンドを再実行して結果を更新します。文書だけの変更では同一コード・設定の直前の成功結果を再利用できますが、検証済みコミットを明記し、文書の整形確認と `git diff --check` は最終差分で行います。マージはGitHub CI成功、ローカルブラウザ検証成功、差分と結果に対する開発者の承認を条件とし、ローカル成功でGitHub CIを代替しません。

### 変更内容に応じた確認

ロビーUIの変更では `bun run --cwd apps/web build` も実行し、ブラウザで作成・参加・観戦、空一覧と取得失敗、更新と追加読み込みを確認します。PCとスマートフォンの幅で横スクロールや文字の折り返しを確認し、ダイアログのキーボード操作、閉じた後のフォーカス復帰、送信中の連打・閉鎖防止、同じタブの参加資格の再利用も確認します。「遊び方」の内容はルール正本と照合します。

ルームの確認では、PC（1280px以上）、タブレット横・縦（768〜1279px）、スマートフォン（320pxを含む）で盤面・カードの寸法とタブ切替を確認します。最大10文字の名前、待機中の盤面操作禁止、準備・開始、CPU・モード設定、投了・退室、再戦・結果ダイアログを確認します。時計は基本時間から秒読みへの切替と残り10秒／9秒、カードは脱落・接続・ホスト交代を確認します。
チャットは100文字／101文字、100件保持、入退室・CPU・形式変更ログ、初回・再接続時のtoast抑止、通常投稿とシステム通知、途中スクロールと最下部追従、タブ切替時の保持を確認します。送信後はサーバーの履歴反映を確認して入力をクリアし、拒否・切断時は入力を残します。旧投稿は読み込み時に通常投稿へ正規化し、過去200文字の履歴・通報も読み込めます。
`bun run --cwd apps/web test` は初回待機の初期盤面・再戦待機の最終盤面、待機中の入室順、リバーシの対局中・保存済み棋譜の色順配置、時計表示の境界を検証します。リバーシは全24配色、本人4色、観戦の黒基準、4方向の回転、脱落後の配置保持と再戦時の再抽選を確認します。ルーム内の直前局棋譜は盤面が前局、カードが現在の待機メンバー・入室順・準備状態であることを確認します。色順配置のブラウザ回帰はChromium／WebKitの320・390・767・768・1280・1440pxでシャッフルした配色を使い、観戦・対局者・保存済み棋譜の実際のカード位置、名前・色・手番・時計・順位の対応、再接続と再戦を確認します。将棋の待機・対局・保存棋譜・持ち駒・回転も回帰確認します。ルームUI変更後もWebのビルド、キーボード操作、ダイアログのフォーカス復帰、ロビーへの戻りを確認します。
盤面の `lastMove` はエンジンの着手時に更新し、ルームとともに保存・配信します。旧保存状態に座標がない場合は `null` として読み込み、次の着手から表示します。再読み込み・観戦でも最終手の枠が残り、棋譜では選択局面に追従し、開始局面では消えること、着手可能なマスの丸い点、名前と王冠の一行表示、円形の接続バッジ、3秒の通知、PCで設定展開時の配置を確認します。

招待ダイアログの自動表示履歴は `useRoomInvitation` が `sessionStorage` に部屋番号・`instanceId` ごとに保存します。Reactの初期化中には書き込まず、自動表示の描画後に記録します。閉鎖前に更新しても表示済みとして扱い、手動の参加操作には影響させません。保存領域を利用できない場合も画面の操作を継続できますが、更新をまたぐ履歴保持は保証しません。招待URLの `invite` は保持し、部屋世代の検証を継続します。

招待導線ではコピー成功と手動コピー、自動ダイアログと閉鎖・手動再表示、資格の再利用、入力不正、送信中の連打・閉鎖、入力中の満室化・開始・閉鎖を確認します。両ゲームで「観戦する」・×・Escapeから閉じた後の更新、閉鎖前の更新、ロビー往復でも再び自動表示しないこと、独立したタブ・別のルーム世代では初回表示すること、保存領域が利用できなくても観戦できることをブラウザテストで検証します。番号再利用後の古い招待は、読み込み・参加・WebSocket接続・再接続で別の部屋へ進まないことをWorkerとWebのテストで検証します。PC・タブレット・スマホで操作とフォーカス移動を確認します。

## ゲームの必須登録と型の対応

ゲームIDの正本は `packages/protocol/src/games.ts`、具体型の対応は型専用の `gameTypes.ts` です。`RoomFor<G>`・`MatchFor<G>`・`ActionFor<G>` と着手コマンド型でゲームを対応付けます。将棋の着手には局IDとrevisionが必須、リバーシの石置きには付けません。通信スキーマによる実行時検証も継続します。

ゲーム追加時にはprotocolの型対応と `gameRankingContracts`、Workerの `waitingRoomFactories`・`rankingReaders`、Webの `createRoomRequests`・`lobbyRoutes`・`liveViews`・`replayLoaders`・`replayViews` を登録します。各表は `GameId` のmapped typeと `satisfies` で検証します。異なるRoom／Matchを渡す入口はゲームで判別するunionを明示的に分岐し、残りを `assertNever` で確認します。カタログへエンジンやスキーマを追加しません。

Webはstrict型検査を使います。`bun run --cwd apps/web typecheck` とWorkerのtypecheckは型検査専用fixtureを含み、登録漏れ・ゲーム取り違え・局面情報や棋譜フレームの欠落を `@ts-expect-error` で確認します。境界の確認は `bun run --cwd apps/worker test -- gameBoundary.test.ts commonRoomBehavior.test.ts rankingBoundary.test.ts` と `bun run --cwd apps/web test` で実行します。

ライブのsession／viewと保存棋譜の前処理／viewはゲーム別に遅延読み込みします。共通カード・名前・席順・時計表示はエンジン実装に依存しません。Webビルドは生成チャンクの静的依存を検査し、別ゲームのエンジン参照、入口へのライブ・棋譜処理の混入、CPU実装の出力を拒否します。Rolldownが残す空モジュールのregionとReact Compilerの共通runtime初期化は実装として数えません。検査結果は追跡対象外の `apps/web/node_modules/.tmp/game-chunks.json` に保存します。`game-dispatch.spec.ts` はビルド済み画面の通信から選択ゲームのチャンク取得を確認します。PR前の全コマンドは上記の順番で実行し、ブラウザ検証中に別プロセスで配信ディレクトリを再ビルドしません。

## 共有transportとゲーム別session

`useRoomTransport` は通信契約の解析、Roomの型ガード、認証・準備・チャット・再接続と送信待ちの管理を担当します。開始待ちとゲーム操作待ちは内部の判別unionで区別します。`gameSessionTypes.ts` はゲームIDに待機データと固有設定コマンドを対応付ける型だけの表です。将棋の着手・提案待ちは局IDとrevisionを必須にし、リバーシの固有設定コマンドは `never` にします。

各sessionは、具体的なRoomと待機データを受け取る `fourReversiSessionBehavior.ts`／`fourShogiSessionBehavior.ts` の純粋な完了判定と固有エラー文言をtransportへ渡します。判定関数はモジュールで定義し、再描画でWebSocketを張り直さない参照にします。開始待ちは対局開始、リバーシの着手待ちは手数の増加、将棋の着手待ちはrevision増加・局変更で解除します。投了は本人の脱落を確認します。将棋の提案・取消は状態反映も確認し、待機への移行・エラー・送信失敗・切断での既存解除条件を維持します。

引分操作と三人攻撃禁止の送信は将棋session、表示は将棋viewが担当します。`RoomViewShell` から共有の状況カード・設定フォームへ任意の `turnActions`／`gameSettings` を渡し、リバーシは渡しません。共有UIは固有操作を送信しません。時計計算・表示と手番への対応、WorkerのGameRoom・CPU・Alarm・ライフサイクルの分離は #57、保存形式・棋譜互換・戦績SQL・保存再試行は #58 の範囲です。

`game-session-boundary.spec.ts` はHTTP／WebSocket境界を制御して、開始・着手・投了・提案の待ち保持と解除、本人と他人の脱落、同revisionでの提案・取消反映、新局・終局、固有設定の権限・配信・準備解除とキーボード操作を確認します。関連する画面回帰は `CI=true bun run --cwd apps/web test:browser game-session-boundary.spec.ts four-shogi-draw.spec.ts room-ui.spec.ts game-dispatch.spec.ts`、型の取り違えと局面情報欠落の否定ケースは `bun run --cwd apps/web typecheck` で実行します。

## 共通ロビーと四人将棋UI

`/games/four-reversi` と `/games/four-shogi` は `features/lobby/LobbyView` を共通利用します。タイトル・説明・遊び方・盤面プレビューはゲームごとに切り替え、一覧とランキングは各ページから渡します。両ゲームともPCは操作カードとランキングを上段、その下に公開ルームを置き、スマートフォンでは操作・公開ルーム・ランキングの順にします。画面幅による並べ替えでもランキングの状態を維持します。

将棋ページは `LobbyView` の省略可能な `boardPreview` に `FourShogiLobbyBoardPreview` を渡します。エンジンの `createInitialState` から初期盤面を取得し、既存の盤画像・`ShogiPiece`・方向変換を使って南を手前に描画します。盤内の余白と駒の縮尺は対局画面に合わせ、盤画像の縦横比458:500を保ちます。幅は768px以上で88px、767px以下で56px、左へ7度傾けて影を付けます。盤面図は `aria-hidden` の装飾とし、マスにはボタンを使いません。入力中のモードや通信状態には連動させません。767px／768pxの境界をまたぐときは渡された盤面図だけを再描画し、WebKitの縮尺変更後の画像の乱れを防ぎます。既存のリバーシ盤面図は共通ロビー内で維持します。

`LobbyRankings` は取得部分と共通の表示部分を分けています。各ゲームのランキングAPIを専用hookで取得し、モード・詳細の集計項目を切り替えます。更新・空一覧・エラーと再試行を共通で扱います。Portalの詳細ダイアログにも将棋テーマを渡します。

両ゲームで `useLobby` と `useRoomEntry` を使い、ゲーム指定を付けて取得・作成・参加します。省略時はリバーシです。将棋では作成時に三人攻撃禁止を設定できます。ランキングもゲーム別に集計し、リバーシの値を将棋へ流用しません。ダイアログを閉じても入力を保持し、ゲームを切り替えたときは破棄します。

`GameLobbyNavigation` は両ロビーのヘッダー直下に `NavLink` を並べ、現在のURLを選択表示と `aria-current="page"` に反映します。PCでは幅360px以内、650px以下では本文幅を2等分し、両リンクの高さを44px以上にします。アカウント・ルーム画面には追加せず、`/` のリバーシへの転送も維持します。

既定の共通テーマは緑です。将棋の本文には `game-theme-four-shogi` を付け、Portalの入力・遊び方・ランキングのダイアログには `AppDialog` の `theme="four-shogi"` を渡します。`primary`／`primary-hover` は主要ボタンの塗り、`primary-foreground` は文字、`brand` は文字アクセントとして分けます。HeroUIの `--accent` と `--accent-foreground` も同じ範囲で設定します。共通ヘッダー・アカウントメニューをゲームのテーマ範囲に含めず、グローバルなテーマ切り替えは行いません。意味を持つdanger・focusの色は上書きしません。

ブラウザ回帰では直接アクセス・再読み込み・切り替え・戻る／進む、ランキングの配置とモード・詳細操作、Tab・Enter・Escape、入力保持と破棄、ゲーム指定を付けた部屋APIの呼び出し、将棋本文とPortalの黄色、共通ヘッダー・アカウント画面の緑を確認します。Chromium・WebKitで320〜1440pxの既存境界を使い、リンクの2等分・44px・横スクロール防止を検証します。リバーシの作成・参加・観戦・一覧とランキングの既存テストも実行します。遊び方は各ゲームのルール正本と照合します。

## 四人将棋のオンラインルーム

公開型は `FourReversiRoom | FourShogiRoom` で、`settings.game` をガード関数で判別します。既存リバーシの保存形式・着手通信は維持します。将棋は担当方向、方向別の時計、局ID、局面revision、三人攻撃禁止、同じrevisionの合法手・三人攻撃禁止候補（`threePlayerAttackForbiddenActions`）と王手情報を配信します。禁止候補はエンジンの `getActionAvailability` で通常合法手から三人攻撃で除外された手だけを導出し、別の不正手を含めません。旧保存局面の未保存フィールドは公開局面から読込時に補完します。通常スナップショットに千日手の出現数は含めません。Webは受理された局面を表示し、履歴を補って独自に進行させません。

`room.game.action` の将棋着手は `roundId`・`positionRevision` と `movePiece`／`dropPiece` を送ります。サーバーが認証・局ID・revision・手番・合法性を検査し、着手と脱落でrevisionを進めます。`room.three-player-attack.set` は待機中のホストだけが変更でき、モードと同様に人間の準備を解除します。

将棋のDO保存は通常状態、局ID・局面キー別の千日手回数、初期化情報と連番イベントへ分けます。 実対局では千日手の全行を読み込まず、エンジンが必要とする局面キーだけを主キーで参照し、確定した変更分だけを保存します。参照キャッシュは同期的な一回の状態遷移またはCPU選択内に限定し、保存・ロールバック・次局へ持ち越しません。CPU探索では枝ごとの変更分を基底履歴より優先し、仮想着手の回数は永続化しません。完全な回数辞書を使う従来のエンジン呼び出しとWebの棋譜再生は維持します。局面・回数・イベント・revisionを同じトランザクションで確定し、棋譜へ全状態を複製しません。直前局は `GET /api/rooms/:id/rounds/:roundId/replay?instanceId=<UUID>&cursor=<offset>` から100イベントずつ取得します。Webは部屋世代・局ID・規則バージョン・件数・連続番号を検証し、エンジンで再生します。再生中の完全な状態は1つだけ保持し、閲覧用には千日手索引を除いた局面を保持します。次局開始で部屋の棋譜取得を中止します。未保存の終局イベントは次局開始・部屋閉鎖でも保持し、D1保存を確認後に不要な行を削除します。将棋の恒久履歴・戦績・ランキングはゲーム指定で分離します。

CPUは開始待ち約0.5秒後に選択し、選択結果と局ID・revision・手番を保存します。次のAlarmで期限を再確認して適用します。同期処理中に `Date.now()` が進まない本番でも、別のイベントで得た時刻までを時計へ反映します。根拠は [Cloudflareの時刻仕様](https://developers.cloudflare.com/workers/runtime-apis/performance/) と [保存上限](https://developers.cloudflare.com/durable-objects/platform/limits/) です。

外側の `RoomLayout`、タブ、チャット、招待、カードの名前・アバター・ホスト・接続表示、時計表示と棋譜操作を共有し、将棋の盤内配置と操作は専用部品に分けます。PNG盤の縦横比を保ち、座標と向きを変換して4方向を表示します。盤上・持ち駒・ドラッグは同じ駒部品と盤内寸を使います。8pxのドラッグ閾値、盤外・取消・Escape、成り選択、局面更新時の解除、重複送信を画面の振る舞いで確認します。操作可能な盤上・持ち駒のホバーで画像だけが2px浮くことを確認します。選択中はホバーが外れても同じ高さと影を保ち、解除後は元へ戻ること、ドラッグ中は元画像が隠れ、取消後に復元することを確認します。持ち駒の枚数は送信前に変更しません。選択・ドラッグ中は合法候補を緑、三人攻撃禁止候補を同寸の赤い丸で示します。禁止候補だけの駒・持ち駒も選択可能ですが、着手・成り選択・送信の判定は合法手だけを使います。合法な成り／不成がある移動先は緑を優先します。

成り選択は盤上へ重ね、左が成り・右が不成、駒画像は盤上と同寸にします。2枚の境界を移動先の中央に合わせ、盤端では全体を盤内へ寄せます。画面全体の透明なクリック受けで、選択外のクリック・タップは成りだけを確定します。成りボタンへの初期フォーカス、Tabの二択移動、Enter・Space、Escape取消と移動元へのフォーカス復帰を検証します。

`useShogiPromotion` は未確定の移動元・移動先と部屋世代・本人・局ID・局面revision・陣営を `sessionStorage` に保存します。接続待ちで削除せず、認証と最新合法手の確認後、成り・不成の両方が合法な場合だけ復元します。確定・取消・局面更新・次局開始・脱落・資格変更、破損値、保存失敗と同じタブの再読み込みをHTTP／WebSocket境界のブラウザテストで検証します。

直前手は移動元の暗い茶色の背景と移動先の枠を描き分けます。マス装飾は盤PNGの罫線の原寸座標（アンチエイリアスを含む）に合わせ、各辺を罫線の内縁まで広げます。盤と同じ縮尺で追従し、盤の配置や当たり判定は動かしません。Chromium／WebKitの320・390・768・1440pxと4方向で、成り選択の収まり・同寸の駒・装飾の内側余白、再読み込み・観戦・棋譜への追従を寸法とスクリーンショットで確認します。

767px以下の `FourShogiBoardLayout` は、盤面タブのコンテナ幅と高さから盤幅を決めます。カード2段（各48px）・持ち駒2段の固定余白・4つの2px間隔を差し引き、盤画像と持ち駒2段の駒画像の比率で残り高さを割ります。持ち駒の上下paddingは1px、ボタンの高さは駒画像＋2pxで、枠線を合わせた固定分は1段6pxです。横幅が十分でも高さが足りなければ盤だけ中央で縮小し、カードと持ち駒領域の幅は維持します。通常ルームと保存棋譜で、縦のリサイズ・タブ復帰・空／全種類の持ち駒を確認します。

Chromium・WebKitで320〜1440pxの既存境界を検証します。固定局面とHTTP／WebSocket境界を使った画面検証に加え、ローカルWorkerへ独立した参加資格で4タブ接続し、作成・参加・観戦・準備・開始・着手・CPU両レベル・チャット・再接続・終局・棋譜・再戦を確認します。`bun run check`、Webビルド、ブラウザ回帰、Worker dry-runを実行します。実機iOS Safariと本番での公開後の確認は区別して報告します。

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

エンジン・Worker・Webのテストで手番制限、状態と時計の不変、脱落後の判定、同意成立、保存・再接続・再戦、CPU同意・取消、旧棋譜との互換性を確認します。Chromium／WebKitの320・390・768・1279・1280・1440pxでボタン・バッジ・長い名前とカード寸法、送信中と拒否・切断後の復帰、観戦者・脱落者の操作制限、保存棋譜の局面追従を検証します。

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

## ブラウザ回帰テスト

初回は `cd apps/web && bunx playwright install chromium webkit` でテスト用ブラウザを用意します。開発中の `bun run --cwd apps/web test:browser` はVite開発サーバーを `127.0.0.1:4173` で起動し、対象ファイルを指定して関連テストだけを実行できます。PR提出前は `CI=true bun run --cwd apps/web test:browser` でWebをビルドしてVite previewで配信し、全ケースを検証します。Adminも同じく `CI=true bun run --cwd apps/admin test:browser` でビルド済み画面を検証します。既存の `bun run check` はブラウザテストの型チェックも含みますが、ブラウザ起動は別コマンドです。

`apps/web/browser-tests/` は実際のルート・画面・HeroUIを使う統合テストです。HTTP／WebSocket境界に固定ID・時刻の応答を用意し、ローカルWorkerや外部サービスに依存させません。hookや部品の内部状態はモックしません。幾何の検証に必要なカード部分だけ `data-testid` を使い、その他はラベルとroleから操作します。

Chromium・WebKitで320・390・650・651・767・768・900・901・1024・1279・1280・1440pxのロビーと4席の外寸、10文字名＋王冠の収まり、準備前後の外寸を確認します。ダイアログは320・390・768・1440pxで閉じるボタンの44×44px・右上12px、フォーカスと復帰、送信中の閉鎖防止、入力値、失敗表示、表示領域縮小時の操作を検証します。作成成功後の遷移、投了確認、タブ切替でのチャット入力保持、縦横のリサイズも対象です。色が未生成のまま操作テストだけ通らないよう、共通の主要ボタンがテーマ色で表示されることも確認します。

スクリーンショットはHTMLレポートへ添付し、失敗時は画面とtraceを保存します。`cd apps/web && bunx playwright show-report` で確認できます。通常CIではPlaywrightを自動実行せず、PR提出前のローカル検証を必須にします。

Linux環境での確認には、GitHub Actionsの `Browser Regression`（`.github/workflows/browser.yml`）を開き、対象ブランチを選んで手動実行します。workflowが選択したブランチのコミットをcheckoutし、ブラウザ・OS依存を含むPlaywright公式イメージ `mcr.microsoft.com/playwright:v1.63.0-noble` を使います。イメージのバージョンは `bun.lock` 内のPlaywrightと合わせて更新します。UIテストを6分割し、Worker E2EとAdminブラウザ検証も独立して並行実行します。Chromium・WebKitの全ケースを維持し、成功時も含めて `browser-report-<コミットSHA>-ui-1`〜`ui-6`、`browser-report-<コミットSHA>-worker`、`admin-browser-<コミットSHA>` を7日間保存します。手動workflowは本番デプロイを行わず、通常CIや本番デプロイの自動実行条件には含めません。ローカルでの必須検証を省略する理由にもなりません。GitHubの手動実行UIはworkflowがmainへマージされた後に利用できます。

現段階では画素一致の自動判定は行わず、移行前後の添付画像と寸法・操作結果を比較します。カードのアバター・名前・下段2領域は、待機／準備完了／対局中／各脱落理由／空席・CPU／ホスト交代・切断で座標と寸法を比較します。石と石数の大きさが脱落前後で変わらないこと、長い順位理由と名前が収まることを1 CSS px以内の許容差で検証します。320・900・1440pxでは一覧の取得失敗・追加読込・参加・観戦、設定・招待・準備・開始・着手・退室、再戦の結果・棋譜、チャットの入力・スクロール保持と送信を確認します。WebKitでの幅・高さ変更はiOS Safari実機でのキーボード確認とは区別し、未確認の場合は報告します。

`bun run --cwd apps/web test:browser:worker` はWeb・Adminをビルドし、production設定のローカルWorker（127.0.0.1:8788、ローカルD1）でChromium・WebKitの作成・CPU対局・着手・チャット・再読み込み・退室を確認します。対局テストはAPIを差し替えません。画像変換テストでは認証APIの応答を固定し、本番ビルドのJS・WASMと実際の画像デコードを確認します。本番への接続や公開は行いません。ローカル状態は `.wrangler/production-preview`、レポートは `playwright-report-worker` に保存します。通常のブラウザテストとは別コマンドです。

## 本番デプロイ

### ブランチと公開先

最新のmainから `feat/xxx`・`fix/xxx`・`docs/xxx`・`chore/xxx` を作り、ローカルでのPR提出前の検証を成功させてからmain向けPRを開きます。mainへの直接push・force pushは行いません。非公開リポジトリでは現在のGitHubプランによる保護を利用できないため、GitHub CI成功、ローカルブラウザ検証成功、開発者の確認を運用で必須にします。他者レビューは必須ではありません。初回も差分と検証結果の承認後にマージし、それ以降はPRのマージを公開の契機とします。

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

PRとmainのpushではchecksジョブで `bun install --frozen-lockfile` → `bun run check` → Web・Adminのビルド → `deploy:dry-run` を実行します。Playwrightの全ケースはPR提出前にローカルで実行し、Linuxでの追加確認は別の手動workflowを使用します。PRジョブはCloudflareの認証情報を使いません。

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

`AppRadio` はHeroUIの共通ラジオ部品です。`Content` 内に `Control` と文字を置き、丸・文字・余白が同じクリック領域に入るようにします。未選択の丸は白背景と `text-muted` と同じテーマ色の1px枠線を使い、選択色・フォーカス・無効化はHeroUIに従います。作成・すぐ遊ぶ・待機ルームの対局形式と三人攻撃禁止に適用します。Chromium／WebKitの320・390・768・1440pxで丸・文字・余白・キーボードによる選択と、設定送信中の無効化・送信回数を確認します。

`RoomViewShell` を配置基準にし、接続中・再接続中と同じ帯に出る操作エラーを絶対配置します。安全領域から8px、ルーム中央、最大幅480px・左右8px以上の余白とし、長文は帯内で折り返します。通知は `pointer-events: none` と `z-index: 10` を使い、ダイアログ・Select候補より下に重ねます。既存の `role=status`、文言、表示条件、再接続hookは保持します。棋譜の読み込みと配置更新の完了を待ち、WebSocket切断・復帰と操作エラーの前後で盤面・4席の矩形差が1px以内であること、中央配置・クリック透過・ダイアログの操作を確認します。

## 棋譜の確認

スマートフォンの両ゲームのプレイヤーカードは、文字・アバター・下段情報の寸法を維持し、上下paddingを1px・高さを48pxに固定します。盤面だけの縮小ではカード寸法を変えません。リバーシの `RoomBoardLayout` はカード2段と2つの2px間隔を空き高さから差し引き、横幅との小さい方を正方形の盤幅にします。自動パス通知がある場合は15pxの行高と2pxの間隔も確保します。通常ルーム・保存棋譜で、低い画面でも4席が収まり、名前・下段情報とカード枠の間が各2px（枠線1px＋padding1px）になることを確認します。

棋譜は新しく開始した対局から記録します。CPU対戦または4人の対戦を終局させ、最終局面が自動で選ばれること、開始局面・着手・自動パス・各種脱落をSelectと左右ボタンで確認できることを検証します。待機中の準備・設定・入退室・チャットで閲覧局面をリセットしないこと、再読み込みと再接続で復元すること、次局開始で解除されることを確認します。古い対局は最終局面のみの表示になります。
PCの盤面領域右下と、タブレット・スマートフォンの状況カード内の配置、タブ切替後の保持、キーボード選択と先頭・末尾でのボタン無効化も確認します。Workerテストは棋譜と実際の盤面の一致・パス・CPU着手・脱落原因・再取得・次局の記録更新を、Webテストは局面ラベルと自動パスの分割を検証します。表示は `ReplayCard.tsx`、選択状態は `useRoomReplay.ts`、項目の生成は `replayFrames.ts` を編集します。
両ゲームの `ReplayCard` は選択値・候補を一行で表示し、幅不足時のみ省略記号を使います。候補の `textValue` は全文を保持し、矢印・選択マークの幅と画面内の候補領域を確保します。将棋の `createFourShogiReplayFrame` は着手または外部脱落の短いラベルだけを生成し、詰み・合法手なし・同時脱落・順位の説明を付加しません。`game.eliminations` と全局面・結果は保持し、通常ルームと保存済み棋譜で同じframe生成を使います。打ち駒・成り・投了・パス・退室・時間切れ・通信切れ・同時詰みを確認し、ラベル短縮後も局面数・順位・脱落理由が変わらないことを検証します。
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
- 本番: `https://tetraboard.net/api/auth/callback/google`

`BETTER_AUTH_SECRET`（32文字以上の乱数）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` をローカルは `.dev.vars`、本番は `wrangler secret put <名前> --env production` で設定します。秘密値はコード・PR・会話・ログに出しません。認証処理には本番Secretが必要で、ローカルだけは開発専用Secretのフォールバックがあります。本番Secretが未設定のときに開発用の値は使いません。Googleの設定不足はログイン画面で「準備中」と案内します。旧版のSecretやCookieをコピーしてセッションを共有する必要はありません。

専用R2 `tetraboard-2026-objects-prod` は存在を確認済みです。旧版の `tetraboard-objects-prod` は切替後の確認まで保持し、確認後に削除します。バケットを公開せず、画像はWorker経由で配信します。productionのR2も `remote: false` のため、ローカルプレビューから本番画像を変更しません。D1の本番名・IDとローカル名・IDも維持します。

マイページのページ枠は `AccountPageShell` の `layout="profile"` を使います。最大幅・左右余白は共通の `shared/ui/pageLayout.ts` にまとめ、ヘッダーと一致させます。本文先頭に「ロビーへ」、その下にプロフィール＋戦績と棋譜のカードを配置します。1024px以上は左560px・間隔20px・右は残り幅、それ未満は同幅の縦並びです。ログイン・初回設定は既存のフォーム用幅と下部のロビーリンクを使います。

Webの編集先は `features/account/`、プロフィールの共通フォームは `ProfileForm.tsx`、認証処理はWorkerの `src/accounts/` です。初回設定はページ内、マイページの編集は共通 `AppDialog` 内に同じフォームを表示し、名前・ID・任意アイコンをmultipartでまとめて保存します。カメラボタンから画像を選択してプレビューし、「保存」（初回設定は「プロフィールを作成」）で反映します。アイコンの削除も同じです。フォームの `onBusyChange` で画像変換・保存中の閉鎖を防ぎ、`onSaved` で成功時にダイアログを閉じてページに通知します。閉じた未保存フォームは破棄し、再度開くと保存済みプロフィールで初期化します。 ファイル選択や別タブから戻った際のログイン再確認では、取得済みのプロフィールと編集中のフォームを保持します。再確認の通信失敗は再試行案内を追加し、名前・ID・画像の下書きを保持します。セッション失効が確認された場合はログインへ誘導します。

`bun run check` にCookie本人確認、期限切れ、ログアウト、Originチェック、入力境界、ID競合、画像変更・削除、移行計画、Google通信を差し替えたOAuth往復を含めます。`test:browser` にChromium／WebKitの320・390・768・1440pxでログイン・メニュー・編集・再読み込み・ログアウト、未完了誘導、編集ダイアログの開閉・フォーカス復帰・未保存変更の破棄、保存後の表示とヘッダー更新、画像変換中・送信中の連打と閉鎖防止、画像の256px WebP変換を含めます。マイページのカード配置は320・390・650・651・768・1023・1024・1440pxで、戦績の包含、左右余白、ヘッダーとの端の一致、560pxの固定幅、20pxの間隔、横並びの切り替えとロビーリンクの上部配置を検証します。画像はブラウザでもデコードして寸法を確認します。WebKitでCanvasのWebP出力が使えない場合は、承認済みの `@jsquash/webp` を遅延読み込みします。Viteではこの依存をprebundleから除外し、WASMは明示的なasset URLで読み込みます。実GoogleとのOAuthは2026-10-02に開発者によるローカル確認済みです。本番Google認証の設定・動作とiOS Safari実機のキーボード・回転確認は別途必要です。

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

Workerテストはサーバー本人確認、入力偽装・初回設定、同時作成・参加の排他、プロフィール編集・ログアウト・画像保持、退室・復帰期限切れ・脱落、予約中断・取消後の遅延RPCと解放の再試行を検証します。ブラウザテストはChromium・WebKitでアカウント作成・番号・招待・観戦からの参加、重複参加エラー、青いCPUアバターとロビーの人数表示を検証します。ロビーの4つの丸ぽちは人間・CPU・空席の順で緑・青・グレーにし、読み上げ用の内訳を付けます。

ログイン中の「すぐ遊ぶ」は `CpuMatchNotice` で「CPUを含んだ対局は、戦績に反映されません。」と「ランキングにも反映されません。終局した対局の履歴・棋譜は保存されます。」をCPU説明の直下に表示します。ゲストと通常の作成・参加には表示しません。

CPU追加の確認レベルは両ゲーム共通の `RoomViewShell` で保持し、PC境界で `RoomInfo` が再配置されても確認を保持します。ログイン中かつCPU0人で毎回確認し、既存CPUあり・ゲストは直接追加します。確認時にも接続・待機・ホスト・空席・ログイン取得状態を再確認し、既存の設定送信pendingガードを使います。取消・閉じる・Escapeでは送信せず、閉鎖後は追加ボタンまたはルームへフォーカスを戻します。`AccountLayout` は初回・再試行・フォーカス復帰の取得中を明示し、取得失敗をゲストに降格せず再確認を案内します。

Chromium／WebKitの320・390・768・1440pxで両ゲームの注意文、ログイン／ゲスト、確認前の未送信、取消・閉鎖・Escape、1回だけの追加、CPUありの直接追加、全削除後の再確認、満席・対局開始・ホスト喪失、取得待ち・失敗・再試行、リサイズとフォーカス復帰をHTTP／WebSocket境界から検証します。

対局中も人間の参加者が全員退室・復帰期限切れになれば、未決着の部屋を閉鎖します。脱落による終局を先に判定し、終局した対局は保存します。投了・脱落後の在室者（ゲストを含む）と30秒の復帰待ちは部屋を維持し、通常の観戦者は維持条件に含めません。期限切れ後の閲覧資格は在室者に数えません。閉鎖で現在局の棋譜・CPU選択を破棄しても、過去の保存待ちと将棋の保護局は残し、必要な再試行Alarmを維持します。両ゲームの退室・切断・同資格の別接続・保存失敗と番号再利用をWorkerテストで、観戦者の閉鎖案内とロビーへの戻りをChromium／WebKitで検証します。

## 終局保存と本人の対局履歴

`0005_match_history.sql` はD1に対局本体 `matches` と本人別の索引 `account_match_history` を追加します。既存のローカル開発・テスト・CDのマイグレーション手順で適用します。保存処理の障害復旧をWorkerテストで確認した後、履歴APIとWebを接続します。`0006_shogi_match_history.sql` は本人索引へゲーム列（既定値はリバーシ）とゲーム別索引を追加し、将棋用の非公開アップロードmanifest `shogi_match_uploads` と100イベントごとの `shogi_match_chunks` を作ります。

GameRoomは対局開始時に棋譜と共通のUUID・開始日時・参加者情報を非公開の `match-start` に記録します。終局時に再戦待機への変更または部屋閉鎖と同じトランザクションで `match-pending:<UUID>` を作り、D1へ非同期保存します。本体と全アカウント索引をD1のbatchで一括保存し、索引の本人情報は保存済み本体から取得します。一意制約で再送の重複を防ぎ、既存の対局を上書きしません。成功を確認した保存待ちだけを削除し、失敗時は5秒後のAlarmで再試行します。保存待ちは部屋や直前1局の棋譜とは独立して保持し、部屋がない状態や番号再利用後にもAlarmを動かします。

`GET /api/account/matches?game=four-reversi|four-shogi&mode=singles|doubles&cursor=<開始日時ms>:<UUID>` はCookieで確認した本人の開始時の参加局だけをゲーム・モード別に返します。`game` の省略時はリバーシです。開始日時・UUIDの降順で21件を取得し、応答は `{ matches: [...最大20件], nextCursor: string | null }` です。カード用応答は日時・ゲーム・モード・参加者・結果だけを含み、内部アカウントID、参加資格、部屋識別子、盤面、棋譜は含めません。名前は開始時、画像は現在のプロフィールを参照します。GETにOriginヘッダーを必須とせず、プロフィール変更用の回数制限も適用しません。未認証は401、不正な条件は400、認証取得・D1取得の失敗は503とし、全応答に `Cache-Control: no-store` を付けます。

Workerテストは通常終局の棋譜再現、投了・退室・時間切れ・通信切れ、人間不在で未決着の打ち切り・非保存、退室による即時終局の保存、ゲストのみの保存、D1本体／索引の一括保存、複数局の保存失敗・再戦・閉鎖・番号再利用・再送、導入前の対局の除外を確認します。履歴APIは本人限定、両モード、0・20・21・41件、同時刻のページング、名前・画像変更、認証・D1障害を確認します。ブラウザテストはChromium・WebKitの320・390・768・1024・1440pxで長い名前・同順位・チーム勝敗、空一覧、取得失敗と再試行、20件追加、ゲーム・モード別の保持と遅延応答、更新・棋譜へのリンクと戻り時の選択復元を確認します。履歴の期限削除は行いません。

## 保存済み棋譜の閲覧

`GET /api/account/matches/:matchId` はCookieで本人を確認し、`account_match_history` と `matches` を結合して本人の対局だけを取得します。応答は `{ match: MatchDetail }` で、対局ID・元の部屋番号・開始／終了日時・設定・開始時の参加者と本人のプレイヤーID・最終ゲーム状態・脱落理由・棋譜を含みます。名前は開始時、アイコンは現在のプロフィールを使います。内部アカウントID・instanceId・参加トークン・チャットは返しません。不正IDは400、未認証は401、他人／存在しない対局は404、認証／D1取得失敗は503です。全応答に `Cache-Control: no-store` を付けます。将棋の詳細は棋譜本体に代えて `{ rulesVersion: 1, initial, eventCount }` と方向別 `knockouts` を返し、脱落は最終ゲーム状態の `eliminations` に含みます。

Webの `/account/matches/:matchId` は専用loaderと `MatchReplayPage` で取得・閲覧します。移動時は取得をキャンセルし、失敗画面から再試行できます。再試行は同じURLへの履歴置換でloaderを再実行し、取得成功時にエラー境界を解除します。再試行中はボタンを無効にし、連続失敗後も再試行できます。`RoomLayout`・`RoomInfoCard`・`ReplayCard` とゲーム別の盤面・カード・結果ダイアログを通常ルームと共有します。リバーシの棋譜は既存の状態列、将棋は初期化情報とイベントをエンジンで再生します。棋譜閲覧はルームセッション・チャット・招待hookを起動せず、参加資格を読み書きしません。プレイヤーカードの棋譜表示は選択局面と保存された脱落理由から求め、未来の脱落を表示しません。

Workerテストで本人限定・両モード・不正ID・未認証・取得障害・非公開情報の除外・名前とアイコン・実終局と部屋閉鎖後の取得を確認します。Webテストで本人の配置・石数・脱落・着手枠・通常終局と自動パスを確認します。Chromium／WebKitの320・390・768・1279・1280・1440pxで一覧からの遷移、直接アクセス、再読み込み、矢印とSelect、結果、タブ切替、操作制限、エラーと再試行、マイページへ戻る導線を確認します。通信を監視し、オンラインルームのHTTPリクエストとWebSocket接続が発生しないことも検証します。共通部品の変更では通常ルームの準備・開始・再戦・棋譜・チャット・招待の回帰を実行します。`bun run check`、Webビルド、Workerデプロイdry-run、関連ブラウザテストを実行します。

## 本人の戦績集計

戦績とランキングは共有SQLの `matchOutcomesCte` で、保存された開始時の `participants` が4人かつ全員 `kind: human` の対局に限定します。ゲストの相手も人間として扱い、本人の集計・ランキング掲載は既存のアカウント索引を使います。順位・勝敗・引き分け・率の分母・将棋の累計撃破数を同じ条件で集計し、過去の保存済みCPU戦にも適用します。履歴・詳細・棋譜の取得にはこの条件を付けず、CPU戦の記録と撃破数は保持します。APIのURL・応答型、DBの保存形式を変更せず、移行・削除・再保存は不要です。

`GET /api/account/stats?game=four-reversi|four-shogi` はCookieで本人を確認し、既存の `account_match_history` と `matches` の保存結果をD1内でゲーム別に全件集計します。省略時はリバーシです。リバーシの応答は `{ singles: { total, first, second, third, fourth }, doubles: { total, wins, losses, draws } }` です。順位は本人の開始時の色に対応する確定順位、勝敗は黒・赤／白・青のチームと保存された勝者から求めます。引き分けも `total` に含めます。全応答は `Cache-Control: no-store`、未認証は401、不正なゲーム指定は400、認証取得・D1集計失敗は503です。将棋のシングルスは `knockouts` を追加し、開始時の本人の担当方向から確定順位と撃破数を引きます。ダブルスは南・北／西・東のチームで勝敗を判定します。

Webはプロフィール内の `AccountStats` と専用hookで両モードを取得し、タイトル直下の全幅ゲームSelect（`aria-label="戦績のゲーム"`）と独立したタブ・更新・再試行を提供します。棋譜側にも `aria-label="棋譜のゲーム"` のSelectを置き、ゲームごとのモードと取得済み結果を独立して保持します。棋譜へのリンクとマイページへの戻りには `accountSelections` をブラウザ履歴stateで渡します。戦績タイトル下に「対人戦のみ集計」を表示し、率は集計対象の対局数を分母にして `.000` 形式の小数3桁で表示します。読み込み・失敗を0件として表示せず、更新中と更新失敗時は取得済みの戦績を保持します。

Workerテストで両ゲーム・両モードの人間4人、CPU1〜3人の過去分除外、CPU戦のみの本人の0件表示と履歴・詳細・棋譜の保存を確認します。集計用データは対人戦、保存用データはCPU戦を維持します。本人限定・全順位・同順位・両チームの勝敗・引き分け・0件・20件超・保存再送・実終局の反映・認証とD1障害を確認します。Webのテストで率の丸めと0件を、Chromium／WebKitの320・390・768・1024・1440pxで戦績の項目、棋譜とのタブの独立、読み込み・失敗・再試行・更新と配置を確認します。`bun run check`、Webビルド、関連ブラウザテストを実行します。

## ゲーム別のランキング

`GET /api/games/four-reversi/rankings` と `GET /api/games/four-shogi/rankings` は認証不要で、`{ singles: { first, total }, doubles: { wins, total } }` の各上位10人を返します。各行は `rank`・`username`・`name`・`avatarUrl`・`value` です。既存の `account_match_history`・`matches` を対象ゲームに限定してD1内で全件集計し、現在の設定済みアカウントのプロフィールを結合します。本人戦績と同じ順位・チーム勝敗の判定を使います。将棋にも優勝数／対局数・勝利数／対局数を用い、撃破数のランキングは設けません。

SQLの `RANK()` で同順位と順位の飛びを求め、値の降順・公開IDの昇順の `ROW_NUMBER()` で10人に制限します。集計値が1以上の人だけを掲載します。名前・画像は履歴の開始時情報ではなく現在のプロフィールを参照します。内部アカウントID・棋譜は返しません。全応答は `Cache-Control: no-store`、D1取得失敗は503です。

ロビーの `LobbyRankings` と専用hookで全ランキングを取得し、通常表示は上位3人、共通ダイアログでは上位10人と対局数を表示します。ロビーと詳細に「対人戦のみ集計」と表示します。両画面で取得結果と更新状態を共有し、更新失敗時は既存データを保持します。モード切替はロビーと詳細で独立し、キャンセル済み応答で新しい取得結果を上書きしません。ロビー上部は768pxで等幅2列へ切り替え、盤面図をタイトル左へ移します。767px以下の表示順は操作カード・公開ルーム・ランキングです。`matchMedia` を `useSyncExternalStore` で購読し、同じ親内のkey付き領域を並べ替えて、DOM順と表示順をそろえながらランキングの状態を保持します。操作ボタンは説明付きの2段にし、「みんなで遊ぶ」のラベルを作成ボタンの前に置きます。公開ルームの一覧部分だけ、767px以下で最大400px・縦スクロールにし、見出し・更新・エラー・補足・追加読込は領域外に残します。

Workerテストで匿名アクセス・全色・同率優勝・両チーム勝利・引き分け・CPU戦除外・ゲスト相手の対人戦とゲスト本人の掲載除外・0件・0回除外・10人の境界・全履歴・再送・プロフィール更新・未終局と実終局・D1障害を確認します。Chromium／WebKitの320・390・767・768・1024・1440pxで盤面図と等幅／縦配置、3人／10人、モードと集計項目の切替、アイコン失敗、空一覧・失敗・再試行・更新中の操作・ダイアログのフォーカス復帰を検証します。共通ロビーモックにもランキング応答を用意します。`bun run check`、Webビルド、Workerデプロイdry-run、ロビー・ダイアログのブラウザ回帰を実行します。

ロビーのブラウザ回帰では、各ボタンの説明が320pxでも1行に収まること、画面幅変更後もランキングの選択と取得結果が保持されること、表示とDOMの順が一致することを確認します。公開ルーム0件・少数件・多数件で高さ、末尾の参加・観戦、内部スクロール、追加読込を検証します。リサイズ後のキーボード操作はDOMの並べ替え完了を、ダイアログを閉じた後の操作はフォーカス復帰を、観測できる状態で待ちます。ブラウザテストの同時コマンド実行でtrace保存先を共有しないよう、関連ファイルは1つのPlaywright実行にまとめます。

## 四人将棋の恒久記録の確認

将棋はDOの終局トランザクションでメタデータ・保存待ちと `shogi_archives` の保護局を確定します。再戦・閉鎖・番号再利用でも保護局のイベントを削除しません。Alarmごとに最大400イベントをD1へアップロードし、全チャンクを逐次検証してから `matches` 本体と本人索引を最後のD1 batchで公開します。途中状態は一覧・戦績・ランキングへ出さず、失敗は5秒後に再送します。成功後は保存待ちと保護を解除し、現部屋の直前局ならイベントを残し、別局または閉鎖後なら不要な行を削除します。リバーシのJSONと保存処理は維持します。

終局保存は導入後に開始した対局だけを対象とし、導入前・導入時に進行中の棋譜や撃破数を補完しません。撃破数は受理されたシングルス着手の新たな `checkmate` 脱落だけを着手者へ人数分加算します。CPUも記録し、外部脱落・`no_legal_actions`・ダブルスは加算しません。エンジンの順位や勝敗を変更せず、対局記録の集計情報として扱います。

`GET /api/account/matches/:matchId/replay?cursor=<event offset>` は本人の保存済み将棋対局を100イベントずつ返します。応答は `MatchReplayPage`（`matchId`・`rulesVersion`・`initial`・`eventCount`・`events: [{ index, event }]`・`nextCursor`）です。詳細と同じ本人限定・認証・不正ID・障害・no-storeの規則を使います。Webは対局ID、バージョン、初期化情報、件数、連続番号とカーソルを照合し、`createInitialState`・`applyAction`・`eliminateSide` で復元して保存済み最終状態と比較します。途中の移動でfetchを中止し、失敗時は未完成の棋譜を表示せず再試行します。

固定データは公開エンジンで受理される初期局面からのイベント列で作ります。ブラウザではHTTP／WebSocket境界のみを置き換え、320〜1440pxで戦績・棋譜の全幅Selectと4つのゲーム／モード、遅延応答・更新失敗時の保持・一覧からの遷移と戻り、方向・持ち駒・成り・裏王・読み取り専用と本人限定を確認します。同時脱落はオンラインルームの固定局面と、保存棋譜と共通のframe生成を合わせて確認します。将棋ランキングの匿名取得・3人／10人・モード／集計項目・黄色テーマ・緑の共通ヘッダー・エラーと再試行も確認し、リバーシの通信形式と既存棋譜の回帰を実行します。

## 観戦と保存済み棋譜の回転

両ゲームの観戦と保存済み棋譜は、閲覧画面の0〜3の回転状態を共有ボタンで進めます。観戦者の状況カードは「観戦中」・参加可能なら参加ボタン・回転ボタン、保存済み棋譜は「棋譜閲覧中」・回転ボタンを下段に表示します。参加者のルーム内棋譜は対象外です。将棋は既存の座標・駒方向・持ち駒・カードの変換を使い、リバーシは表示マスを基準座標へ戻して盤面と最終手を参照します。カードは時計回りに位置だけを変え、文字は回転しません。通信・サーバー状態・棋譜データへの書き込みは行いません。

状態は手数変更・タブ切替・再接続・同じルームの次局開始で保持し、ページ再読み込みと画面の識別子・参加資格の切替で初期化します。両ブラウザの320・390・768・1440pxで、4方向のマス・カード・将棋の駒と持ち駒、最終手、参加と棋譜操作、参加者にはボタンがないこと、横スクロールと状況カードの収まりを確認します。

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

登録日時はBetter Authが保存するISO文字列と既存のUNIXミリ秒整数を読み取り時にミリ秒へそろえ、一覧の応答・並び順・カーソルと新規登録数の日別／月別集計に使います。DBの日時を一括で書き換えません。Workerテストは両形式の混在と同時刻の追加取得、日本時間の月境界、計測開始前と期間外の除外を検証し、本番構成のブラウザテストもISO日時の登録者を使用します。

### ビルドと確認

`bun run build` はWeb・Adminを個別にビルドし、`scripts/buildAssets.ts` で `apps/worker/dist/assets` にWeb、その `admin/` 配下にAdminをまとめます。Wranglerはこの成果物を配信します。Adminの深いURLは認証後に専用indexを返し、HTMLの自動転送を無効にしてリダイレクトループを防ぎます。通常WebのSPA・API・WebSocketを維持します。CI/CDも同じビルド成果物を使います。Worker単独のdry-runや本番構成プレビューの前に、必ず `bun run build` を実行してください。

本番構成のローカルプレビューは `preview:production` がupstreamも `http://127.0.0.1:8788` にそろえます。本番のcustom domainをupstreamとして使うとWranglerがOriginを書き換え、ローカル用 `APP_ORIGIN` と一致しなくなるためです。ブラウザ統合テストではローカルD1だけに検証専用の管理者とセッションを用意し、認証・配信・閲覧計測を実際のWorkerで確認します。

`bun run check` はAdminの型・表示計算テストと計測のWorkerテストも含みます。管理画面のChromium／WebKitテストは `bun run --cwd apps/admin test:browser`、Webの閲覧計測は `bun run --cwd apps/web test:browser browser-tests/analytics.spec.ts` です。関連の認証・両ゲームの対局・棋譜保存も回帰します。本番では承認後に `/admin` の本人アクセス・別アカウントの拒否・通常ログインを確認します。実Google認証・本番データでの確認はローカルのモック検証と区別して報告します。

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

Worker統合テストはHTTP・実D1・R2で権限、並行再送、保存失敗、上限境界、競合、集計、期限と削除再試行を確認します。WebとAdminのChromium／WebKitテストは320・390・767・768・1280・1440pxで画像変換、入力保持、分類、編集、フォーカス、長文と横スクロールを検証します。WebKitのroute差替えではBlob本文を取得できないため、変換はプレビューの実寸、送信は既存Worker E2Eへ追加した実D1／R2の経路で検証します。ルームのダイアログは接続を維持し、閉じた後も両ゲームで着手できることを確認します。マージ前にAGENTS.mdの全検証を実行し、本番secret設定・実Googleログイン・実機・公開後の動作はローカル確認と分けて報告します。

## 任意登録の案内と画面復帰

登録案内は両ゲームで共通の `RegistrationPrompt` を使い、参加フォーム・通常ルームの結果に配置します。結果の自動表示は、認証を確認できた未ログイン参加者がplayingからwaitingへ進んだ場合だけを対象とします。他のダイアログを優先し、既存結果の閲覧では自動表示しません。`tetraboard:registration-result-shown` を表示後に保存し、両ゲームを通じて同じタブで1回に制限します。保存不能時はモジュール内のメモリで抑止します。

Google認証開始を `useGoogleSignIn` に集約し、既存の認証APIと固定コールバックを維持します。管理画面へのログインもこの処理を使い、`destination=admin` を送信して固定の `/admin` へ戻します。その際は通常登録の画面復帰情報を消去し、プロフィール設定画面への誘導より管理画面への復帰を優先します。`tetraboard:registration-return` に元画面・参加入力・開始時刻を1時間保存します。許可する戻り先は両ロビーと部屋世代付きの部屋URLだけです。`RegistrationCompletion` が本人確認とプロフィール設定の完了後に復帰情報を消費し、復帰先も履歴から復元情報を除きます。入力の復元だけで作成・参加を送信せず、既存ゲスト席や対局履歴の紐付けも変更しません。失敗・取消時の入力保持、保存不能・破損・期限切れのマイページへのフォールバックを検証します。

Chromium／WebKitで両ゲームのゲスト・アカウント・観戦、CPU戦・対人戦、初回終局・再戦・再読み込み・手動表示・ダイアログ競合、Google認証境界の成功・失敗・取消、初回設定、参加フォームの復元、部屋番号再利用、320pxとキーボード・フォーカス復帰を確認します。認証API境界を固定した検証と、実Workerの対局・再接続の検証を分けます。実Google認証とiOS実機の確認は別途必要です。分析イベントの追加はこの機能に含めません。

## ルームの持ち時間・秒読み

両ゲームの作成・「すぐ遊ぶ」と待機室で `TimeControlSetting` を共有します。持ち時間はなし・1・3・5・10分、秒読みはなし・10・30秒です。「なし」は通信・保存上は0msとし、共通の `roomTimeControlSchema` でプリセット外と両方0を拒否します。作成リクエストの `timeControl` は省略可能で、省略時は従来の5分＋30秒です。選択値はダイアログを閉じても保持し、登録からの復帰でも検証して復元します。古い復帰データに時間がなければ初期値を使います。

待機中のホストは `room.time-control.set` に `{ timeControl: { mainTimeMs, byoyomiMs } }` を送ります。変更は保存・配信・公開索引へ反映し、人間全員の準備を解除します。同じ値の再送は準備・活動時刻・公開更新時刻を変えません。待機室では選択ごとに送信し、応答待ち・切断中は無効にします。再戦待機で変更しても前局の棋譜・保存済み対局の時間設定は書き換えません。

時計の開始と手番更新は両ゲームともルームの時間設定を受け取ります。持ち時間なしでは最初から毎手の秒読み、秒読みなしでは持ち時間だけを消費します。時間なしの枠はルーム情報に「なし」と表示し、秒読みなしでは0秒になっても秒読み色にしません。Workerで全14組み合わせ、開始・着手・CPU・脱落・自動パス・期限境界・権限・準備解除・永続化を確認し、Webで時計表示と登録復帰、Chromium／WebKitで選択と待機室の配信・320px・キーボード操作を確認します。
