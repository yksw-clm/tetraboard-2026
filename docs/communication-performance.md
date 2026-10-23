# 通信パフォーマンスのリファクタリング調査

2026-10-24に、ルーム作成・入室・人間とCPUの着手で目立つ待ち時間を対象に調査した。作業ブランチは、今後の通信以外の整理にも使う `refactor/codebase`。調査・部分テストの対象は、作成時の最新develop `21ed884c75bd26d9d135e57622a44fbb7f5f7b25`。

この文書は、調査した候補と判断条件、実装した整理の範囲を管理する。C01〜C10は未実装であり、実装済みの仕様はREADME、ゲームのルール正本、構成・開発文書を参照する。

## 調査範囲と結論

Webの参加導線・認証・WebSocket、Workerのルーム進行・Alarm・D1保存、公開ロビー・チャット、永続データと旧Worker向けの互換処理を調べた。現在の実装、正本文書、既存テスト、Git履歴と関連PRを照合した。

現在の成功経路にも、重複したD1確認、空キューに対するAlarm確認、使わない解析結果の生成、独立したDB問い合わせの直列実行がある。まずこれらを整理する。互換分岐のうち、旧Workerでのみ発生する再取得は通常時の速度にほとんど影響しない。一方、旧状態を毎回補完する処理や旧索引をDOへ問い合わせる処理は、対象データが残っていれば負荷になる。

以下の回数は静的な経路の確認値であり、本番の所要時間や改善率ではない。D1の実データは後掲の本番調査で別途確認した。前日のCloudflare統計は全ゲームの集計で、四人将棋の各処理を特定できないため、実装候補の効果測定として扱わない。

## 現在の成功経路で削減できる候補

P1は最初の実装候補、P2は関連する変更または計測後に進める候補とする。

| ID | 優先度 | 対象 | 確認できた負荷と改善候補 |
| --- | --- | --- | --- |
| C01 | P1 | WS認証の期限・退会確認 | `webSocketMessage` と `getRoomMembership` が同じ認証で `reconcileDeadlines` を2回呼び、退会確認SELECTも2回行う。hash計算後に期限処理を1回行い、資格照合だけの内部処理を分離する。 |
| C02 | P1 | 空キューとAlarm同期 | `reconcileDeadlines` は保存待ちがなくても4回の `syncAlarm` を順番に待つ。空のflushを早期終了し、通常イベントのAlarm同期をまとめる。 |
| C03 | P1 | 未使用の戦型解析 | 新WebはHTTP・WSでサーバー解析を要求するが、解析本体を状態へ渡さず、通知は確定盤面からローカル判定する。新Webの解析要求を外す。 |
| C04 | P1 | 外部保存の応答待ち | 索引・席解放・大会反映は非同期で始めても、次の期限処理が実行中Promiseを待ち直す。通常の応答・盤面配信に必要な処理と、永続化済みジョブの外部反映を分離する。 |
| C05 | P2 | Roomの再読取り | transaction前後、各flush、Alarm同期などが同じRoomを繰り返し読み、スキーマ検証・旧状態補完を行う。同期処理内で値を引き回し、C02と併せて重複を減らす。 |
| C06 | P1 | 作成・参加後の再取得 | 設定済みアカウントでも基本4 HTTP、初回ゲストは7 HTTPとWS接続・認証を直列に待つ。POST応答の一度限りの引き継ぎ、またはルームと本人資格の一括取得を検討する。 |
| C07 | P2 | ゲスト本人確認 | 毎回SELECTと期限UPDATEの2 D1往復。180日の期限と失効判定を維持してbatchへまとめる候補。HTTPの重複削減も有効。 |
| C08 | P1 | チャット取得 | 公開チャットは独立3 SELECT、大会チャットは4 SELECTを直列実行。batchで1 D1往復へまとめる。新着時の2回目の全窓取得も、必要な窓を一度で返す方式へ整理できる。 |
| C09 | P2 | 退会確認の索引 | `deletion_rooms WHERE room_id=?` は主キーの先頭列と合わず全走査する。`room_id`を先頭とする索引を追加する。これだけでは毎操作のD1往復は減らない。 |
| C10 | P2 | ロビーの検索索引 | 全ゲーム横断の最近の対局は全走査と一時ソートになる。`(started_at_ms DESC, id DESC)` の索引が候補。公開ルームのCASE優先順・人数条件も、件数を測定して式・部分索引を検討する。 |

### C01・C02：イベント入口とAlarmの整理

根拠は [gameRoom.ts](../apps/worker/src/rooms/gameRoom.ts) の3798・3815・2529行（WS認証）、2723行（期限処理）、3030〜3034行（同期処理）、1779・1130・1907行（各flush）、1858行（`getAlarm`）。

通常GETの期限処理1回でも、直接のAlarm同期と3種類のflushから少なくとも4回 `getAlarm` を待つ。WS認証では二重の期限処理によって共通経路だけで8回になる。四人将棋以外は空の `flushMatches` からも非同期のAlarm確認が加わる。

WS認証の2回目だけを削ると、tokenのhash計算のawait中に復帰期限を越した認証を通す可能性がある。hash計算を先に行い、その後の期限処理と資格照合をつなぐ。公開RPCの `getRoomMembership` 自体が必要とする期限確認は維持する。

AlarmはCPU・持ち時間・復帰・24時間閉鎖・保存再送の最も早い期限を選ぶ。非同期flushが新たな期限を作った場合は再同期が必要で、イベントをまたぐ無条件のメモリキャッシュへ置き換えない。関連テストは `gameRoom.test.ts`、`roomDeadlineBoundary.test.ts`、`cpuRoom.test.ts`。

### C03：現在のWebが使わない解析要求

根拠は [roomAccess.ts](../apps/web/src/shared/roomAccess.ts) 46行、[roomLoader.ts](../apps/web/src/features/room/roomLoader.ts) 47・77行、[useRoomTransport.ts](../apps/web/src/features/room/useRoomTransport.ts) 624・733行、[fourShogiFormationAnalysis.ts](../apps/worker/src/rooms/fourShogiFormationAnalysis.ts) 27行。

Workerは要求されたスナップショットで4陣営の戦型を判定する。Webは対応有無だけを引き継ぎ、解析本体を利用しない。実際の通知は [useShogiFormationNotice.ts](../apps/web/src/features/room/useShogiFormationNotice.ts) が確定した `room.game` を判定する。開発文書の「サーバーの派生結果を通知判定に使わない」という説明とも一致する。

新WebのHTTP・WS要求と対応フラグを外すだけなら、旧Web向けのWorkerの任意解析APIは残せる。本人戦績の戦型履歴、保存棋譜、楽観盤面とは別なので変更しない。`shogiState.test.tsx` はサーバー解析を渡さず、4方向・全16戦型・再通知抑止・2秒消去を検証している。`roomSession.test.tsx` の対応可否テストは変更対象になる。

### C04・C05：状態確定と外部反映の責務

[withIndexTransaction](../apps/worker/src/rooms/gameRoom.ts) の1714行以降は、状態・反映待ちを同じSQLite transactionへ保存してから `waitUntil` で外部反映を始める。一方、次の `reconcileDeadlines` が索引・席解放・大会反映のPromiseをawaitするため、先行D1処理が遅いと次のGET・着手・CPU配信も待つ。

反映処理を消すのではなく、通常操作の応答が完了を待つ必要のある処理を明確にする。索引revision、5秒再送、閉鎖後の保存、古い席解放による新しい席の削除防止、大会の開始・結果確定、退会情報の再露出防止を維持する。大会への適用は通常ルームと分けて契約を確認する。

`readRoom`（1216行）はKV読取りのたびに `roomSchema.parse` とnormalizeを実行する。同期transaction内の重複は削減候補だが、外部awaitをまたいでRoomを使い回すと再入後の現在状態とずれる。永続データを検証する境界も残す。関連テストは `gameRoom.test.ts`、`accountRooms.test.ts`、`privacy.test.ts`。

### C06・C07：作成・参加の通信列

初回ゲストの作成では、ロビー初回取得や並行する通知取得を除いて次を順番に行う。

```text
GET account/session
→ GET account/session（ゲスト作成ロック内）
→ POST account/guest
→ GET account/session（HttpOnly Cookieの読戻し）
→ POST rooms
→ GET rooms/:id
→ GET rooms/:id/me
→ WebSocket接続
→ room.auth
```

設定済みゲスト・登録者ではゲスト準備の3通信が不要なので、HTTPは4回。招待の世代確認、保存済み資格の再利用確認、再試行が必要な経路は追加取得がある。

根拠は [useRoomEntry.ts](../apps/web/src/features/lobby/useRoomEntry.ts) 102行、[guestAccount.ts](../apps/web/src/features/account/guestAccount.ts) 20行、[roomLoader.ts](../apps/web/src/features/room/roomLoader.ts) 47行、[guestAccounts.ts](../apps/worker/src/accounts/guestAccounts.ts) 23〜37行。

POSTはルームと本人資格を返すため、その結果を初期表示に利用する余地がある。ただし操作可能になる条件はWSの本人認証後のままにする。GETと本人資格照会を単純に並行化すると、招待の部屋世代を確認する前に401で保存資格を消す可能性がある。資格照会と資格削除の確定を分離する必要がある。

ロック内の本人再確認は別タブとの競合対策、Cookie読戻しは保存拒否時にルームを作らないための確認である。単純削除より、最新本人確認とゲスト準備の入口を集約する。ゲストの期限UPDATEを間引くなら、最終利用から180日という確定仕様への影響を別途判断する。関連テストは `guestAccounts.test.tsx`、`roomInvitation.test.ts`、`roomTransportLifecycle.test.tsx`、`sessionCookieRenewal.test.ts`。

同意保存も [roomAccounts.ts](../apps/worker/src/accounts/roomAccounts.ts) 39行で席予約batchとは別に待つ。集約候補だが、現在は席予約に失敗しても同意を保存するため、失敗時の動作を確認してから変える。全ルーム1席の予約・DOでの確定確認・取消フェンスは維持する。

### C08〜C10：継続取得とSQL計画

[chatStore.ts](../apps/worker/src/lobby/chatStore.ts) 41〜70行は、メッセージ・設定・本人の停止状態・大会状態を直列取得する。名前設定済みゲストでは本人確認の2往復と合わせ、公開チャット1回に通常5 D1往復がある。[useLobbyChat.ts](../apps/web/src/features/lobby/useLobbyChat.ts) 45〜58行は新着を検出すると窓拡張のため再GETするので、この経路では通常10往復になる。

batch化と一度のHTTPで表示窓を確定する方式を検討する。新着差分だけへ変える場合も、既存投稿の削除・退会・期限切れ、投稿停止と受付停止を取りこぼさない。5秒間隔や通知方式の変更は、取得処理の整理とは別に仕様を確認する。

全24 migrationをSQLite 3.54.1のメモリDBへ適用し、`EXPLAIN QUERY PLAN` を確認した。リモートDBは変更していない。

| SQL | 現在の計画 | 候補をメモリDBだけへ追加した確認 |
| --- | --- | --- |
| `SELECT account_id FROM deletion_rooms WHERE room_id=?` | `SCAN deletion_rooms` | `(room_id, account_id)` 索引で `SEARCH ... USING COVERING INDEX` |
| `/lobby/matches` の全ゲーム最新20件 | `SCAN matches` と `USE TEMP B-TREE FOR ORDER BY` | `(started_at_ms DESC, id DESC)` 索引で一時ソートを除去可能 |
| 総合ルームのCASE優先順 | 一時ソートあり | 候補の実行時間・件数は未測定。既存の並び順とカーソルを維持して検討 |

退会確認の主キーは `(account_id, room_id)` で、`room_id`を先頭とする索引がない。チャットはscope・時刻の索引が効いており、まず問い合わせの往復削減を優先する。SQL計画の確認は、Cloudflare D1の実行時間や実データでの改善率を保証しない。

## 互換処理の棚卸し

| 処理 | 現在の負荷 | 整理する条件 |
| --- | --- | --- |
| `formationAnalysis` の要求 | 現行の成功通信でも未使用の本体を生成・送受信 | C03として新Webの要求を外す。旧Web向けAPIの撤去は後で判断できる |
| 旧ロビー索引のDO参照 | `instance_id`がNULLの公開行があれば、一覧20件で最大20 DO RPCと20 D1退会確認。取得後も索引を修復しない | 稼働中NULL行数と索引障害を確認し、世代・revisionを守って一度だけ補完するか、保守移行後に撤去 |
| 旧Roomの毎回normalize | `threePlayerAttackForbiddenActions` フィールドのない旧四人将棋状態は合法手・禁止手を再生成。脱落理由がない旧リバーシ状態は棋譜から復元 | 旧状態の残存確認と、状態を壊さない一度限りの移行を先行。単純削除しない |
| 退会時の全ルーム対象化 | `requestDeletion` が旧実装の保存待ちも拾うため、全 `room_index` を削除対象へ登録 | 旧席・保存待ちの追跡が既存のプライバシー索引で網羅できることを確認。退会対象外の通常操作にも関わるため、失効設計と併せて判断 |
| 旧ゲストのID遅延補完 | 削除済み。作成時のID確定を同じD1 batchへ統合し、本人・現在プロフィール・ランキング取得時の更新を撤去 | 本番の未割当0件と開発者の削除指示に基づく。展開直前にも旧作成経路由来の未割当がないか再確認する |
| 公開プロフィールIDの遅延補完 | migrationと旧Workerの混在期間に生まれた未割当アカウントへの補完 | 未割当件数と旧Workerへの切戻し方針を確認して撤去を判断 |
| 400時のオプション除去・再GET | `eliminatedHands`、`profilePreview`、ランキング等。現行Workerの正常時に追加HTTPはない | 最低対応Worker版、旧タブ、切戻し方針を決めて削除。主な効果は複雑さの削減 |
| スタンプ・表示用持ち駒等の対応確認 | 正常通信の任意フィールド・タグ判定 | 実際に表示へ使うデータ。C03と一括で消さない。最低対応版の判断が必要 |
| 保存棋譜の既定値・旧manifest対応 | 保存済みデータや失敗中の転送を読むための検証・補完 | 四人将棋の引分提案省略は実データ43件で使用中のため維持。時間設定不明の移行棋譜は別途削除対象とし、読取り・表示・取込の例外を撤去 |

旧ロビー索引の根拠は [roomRoutes.ts](../apps/worker/src/rooms/roomRoutes.ts) 192〜209行、[roomIndex.ts](../apps/worker/src/rooms/roomIndex.ts) 82行、migration `0010_player_profiles.sql`。導入日は2026-10-07で、現行の正常書き込みは必ずinstanceIdを持つ。正常な24時間閉鎖と索引更新で旧行が解消済みの可能性があり、現在の遅延原因と断定しない。一覧SQL自体には24時間の時刻フィルタがなく、閉鎖索引の反映に依存する。

旧Roomの根拠は [fourShogiProgress.ts](../apps/worker/src/rooms/fourShogiProgress.ts) 486行、[fourReversiProgress.ts](../apps/worker/src/rooms/fourReversiProgress.ts) 359行、[reversiProgress.ts](../apps/worker/src/rooms/reversiProgress.ts) 294行。現在の一時的な読取り補完を、保存済み棋譜や転送manifestへ書き戻してはいけない。`fourShogiRoom.test.ts` 1250行付近と `matchCompatibility.test.ts` 119行以降が旧状態・旧保存待ちを検証する。

## 本番データの確認と互換処理の判断

2026-10-24（JST）、指定されたChromeプロフィールでCloudflareの `tetraboard-2026-prod-db` を確認した。最初の棚卸しはSELECTのみで行い、その後の開発者承認に基づく削除は後述のとおり実行した。本番デプロイは行っていない。複数の問合せを順次実行したため、全表の同一時点スナップショットではない。調査中にルーム索引は665件から666件へ増えた。

| 確認対象 | 本番の結果 | 判断 |
| --- | --- | --- |
| 保存棋譜 | 全477局。四人リバーシ97、四人将棋307、リバーシ12、将棋30、五目並べ22、四人五目並べ9 | 不正JSON、ゲーム列の不一致、instanceId・replay欠落は0件 |
| 時間設定が不明な棋譜 | 四人リバーシ18局が明示的なJSON null。他ゲームのnullと全ゲームの設定欠落は0件 | 開発者が18局の削除と関連互換処理の撤去を指示。コードは時計必須へ変更し、Firebase棋譜取込script・専用fixture・「不明」表示を撤去 |
| 四人将棋の引分提案省略 | 307局中43局。開始日は2026-10-03 | 読取り時の空配列補完を維持。時間設定不明データの削除対象には含めない |
| 四人リバーシの直前手 | 最終局面・初期局面・全replay stepで `lastMove` 欠落0件 | D1の結果だけで稼働中DOの補完を撤去しない |
| 旧ルーム索引 | instanceIdがNULLの129行はすべて閉鎖済み。最終更新は2026-10-07以前。確認時の公開1行は現行形式 | 現在の公開一覧で旧行のDO参照は発生しない。閉鎖DOの再送や切戻しまで不存在とは証明できない |
| 有効な設定済みプロフィール | ゲスト39人・登録者13人ともusername・公開プロフィールIDの未設定0件 | ゲストIDは作成時の原子確定へ変更し取得時補完を削除。公開プロフィールUUIDの補完は今回変更しない |
| 保存途中・退会・席の参照 | D1保存途中upload 0、退会ルームjob 0、未完了退会0。確認時の席1件と保持プレイヤーに追跡漏れ0 | DO内の保存待ちまで0とは判断しない。退会の追跡・再送処理を維持 |
| 旧トークン格納 | 現行コードと同じ判定で、平文候補0・旧refresh/id token列の格納0 | 暗号化データの復号可能性やDOの状態を証明する結果ではない。今回は撤去しない |

18局の開始日時は2026-06-05〜2026-09-05。削除対象IDを固定し、`matches` の全列と `account_match_history` 1行の全列をGit管理外の本人限定バックアップへ保存した。元の `record_json` 文字列を保持している。対象に一致する将棋チャンク・upload・戦型・引き継ぎ・登録フロー・バッジ通知／取得台帳・計測・大会とその子テーブルはすべて0件だった。

削除は対象の本人履歴→棋譜本体の順で、D1の一つのbatchに限定した。ID・ゲーム・日時・元のrecord_json文字列との完全一致・時間設定null・本人索引・追加参照を実行時にも照合し、差があれば失敗させるガードを付けた。全24 migrationを適用したローカルSQLiteで、18局＋履歴1行の削除、対象外の正常局保持、元文字列の完全復元、対象の長さ変更／同長の本文変更／追加参照／本人索引追加の4ケースの全ロールバックとFK整合性を確認した。2026-10-24 01:24:33 JST、18局と履歴1行の削除への実行直前承認を得て、[公式D1 query API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)の1 batch（22文）で削除した。Chromeの大きなSQL入力で接続が切れたため、同じ承認済みSQLを既存のWrangler認証で公式APIへ送った。18件の元文字列照合を含む全22文が成功し、削除対象・本人索引・時間設定不明がそれぞれ0件になった。四人リバーシは97→79局、全体は477→459局となり、他5ゲームの件数は不変、FK違反0件も確認した。復元用データ・実行SQL・応答・実行証跡は `apps/worker/.wrangler/backups/20261024-null-time-control/` に本人限定・Git管理外で保持している。公開前にも旧作成経路由来のゲストID未設定がないか再確認する。

戦績・ランキング・現在のバッジ表示は残る棋譜と本人履歴から都度集計するため、18局分が対象外になる。アカウント全体の獲得通知台帳、集計済み計測、大会得点、ルーム・退会追跡を広く削除しない。別の正常局に紐付く獲得通知の台帳は残す。

開発DB `tetraboard-dev-db` も同日に確認した。保存棋譜125局に時間設定のnull・欠落はなく、有効な設定済みゲストのID未設定も0件だった。開発DBに今回の削除対象はない。

D1だけではDOのKV状態・旧保存待ちを確認できない。Cloudflareの[DO Data Studio](https://developers.cloudflare.com/durable-objects/observability/data-studio/)はSQL用で、[KV格納用の内部テーブルはSQLから参照できない](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)。既存のルーム取得RPCは期限進行や書込みを伴うため、残存調査目的では呼んでいない。旧Roomのnormalizeや旧manifestの撤去には、別途読取り専用の診断手段または保守移行が必要である。

## 維持する契約と、性能問題と混同しないもの

- 退会受付後の資格失効、旧名・画像の再露出防止、全ルーム1アカウント1席、席予約の再試行と取消フェンスは現役の安全要件。毎操作の退会SELECTをなくすなら、永続的な失効通知・再送・応答前の失効保証を設計する。単純削除や数秒のTTLキャッシュで代用しない。
- 部屋世代・局ID・revision、古い応答の破棄、再接続、認証障害をゲスト扱いしないことは現在の通信の正しさを守る。古い実装への互換だけを目的とした分岐とは分ける。
- CPUの最低2秒は確定仕様。四人将棋などの「同期探索→選択保存→次Alarmで期限再確認」は、本番の同期処理中の時刻を含め時計を守るための構成。単にAlarmを1回に減らす対象ではない。
- 四人将棋のCPUは同じGameRoom内で同期計算する。公開Lv2の探索量2048単位・棋力・最低待ち時間の変更は、通信の内部整理とは別の仕様判断が必要。ルールを保つ合法手生成・探索内の重複計算削減は、同じ結果を返す検証を前提に別途調べる。
- 通常リバーシだけは `gameRoom.ts` 3019行で、通常GETやWS処理からもCPU探索を実行する。他ゲームと同じAlarm限定へ揃えるなら、時計とGETの進行契約を確認する。四人将棋の今回の症状と混同しない。
- ルームtransportの250msタイマーはローカルの時計表示で、定期HTTPポーリングではない。継続通信はロビー10秒、公開チャット5秒、表示中のバッジ通知5秒、focus・表示復帰時の本人確認など。操作がこれらを直接awaitしているとは限らない。
- 対局一覧の参加者プロフィール取得は、PR #229で通常最大3問い合わせへ一括化済み。現在も一局ずつ問い合わせる旧説明で課題を立てない。この変更では旧ゲストIDの補完も撤去した。
- 将棋の反復履歴はSQLiteから必要なキーを読み、盤面配信に全履歴・全棋譜を載せていない。WS配信も対応タグの組み合わせごとに文字列を再利用しており、接続数だけ同じ解析を繰り返しているわけではない。Webの受信スキーマ検証も、一つの本文を二重に全体parseする経路は見当たらなかった。

## 実装の進め方と検証

1. C01・C02・C03を小さく分けて実装する。D1確認回数、空キューでのAlarm操作回数、解析を要求しなくても同じ戦型通知が出ることを確認する。
2. C04・C05で、通常応答と外部反映の依存を整理する。D1の応答を保留した状態でも、契約上可能な盤面配信が完了することを確認する。大会の確定処理は分ける。
3. C06〜C10を、参加導線・認証・チャット・索引ごとに実装する。安全にまとめられるD1呼出しから減らし、件数と問い合わせ数の上限を検証する。
4. 互換データの件数を読み取り確認し、実在するものは補完・移行してから撤去する。最低対応版・旧タブ・切戻しの方針は、開発者が承認してから確定する。
5. 同じ拠点・ゲーム・CPUレベル・局面・本人状態・接続状態で、作成、参加、WS認証、人間着手、CPUの選択と適用を分けて実測する。新規DOの配置ヒントは既存DOの移動にはならないため、コード整理の効果と配置の効果を混ぜない。

回帰は実時間の閾値ではなく、D1の呼出し予算、独立取得の直列依存、保留した応答中の配信、保存済みの再送状態など、観測可能な振る舞いを中心に追加する。ブラウザを起動する自動テストは追加しない。コード・設定を変更してPRを提出するときは、AGENTSの必須5コマンドとGitHub CIを別途成功させる。

### 今回の確認結果

実行環境はmacOS / Darwin arm64、Bun 1.4.2、Node v22.23.3。以下の自動検証はローカルで実行した。本番の旧棋譜削除は前節の手順・結果を参照する。ルーム・Cloudflare設定は変更していない。

| 確認 | 結果 |
| --- | --- |
| `git fetch origin develop` とブランチ作成 | 最新 `21ed884` から `refactor/codebase` を作成 |
| `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomSession.test.tsx ./test-dom/roomTransportLifecycle.test.tsx ./test-dom/shogiState.test.tsx ./test-dom/accountSession.test.tsx` | 4ファイル44件成功、0失敗 |
| `bun run --cwd apps/worker test test/privacy.test.ts test/matchCompatibility.test.ts test/roomDeadlineBoundary.test.ts test/fourShogiRoom.test.ts` | 4ファイル137件成功、終了コード0、15.06秒 |
| 全24 migrationのメモリSQLite適用とSQL計画 | 成功。退会確認の全走査と、候補索引での検索への変更を確認 |
| 文書の整形・参照先・差分確認 | 成功。Markdownの表・空行・コード囲み・末尾空白を確認し、ローカル参照341件が有効。`git diff --check`成功。文書は既存oxfmt設定の対象外 |

Workerテストは最初、サンドボックスのローカルポート制限で起動前に失敗し、ローカルポートを使用できる実行で上記が成功した。成功実行でも終了処理に `EnvironmentTeardownError` / `Account deletion will be retried` が出た。137件の成功と終了コード0は確認したが、後処理ログの原因調査は今回行っていない。

上表は調査開始時の変更前コードに対する部分確認である。時間設定不明の棋譜互換とゲストID補完の撤去後、同じ実行環境で次の必須検証も成功した。

| 変更後の確認 | 結果 |
| --- | --- |
| `bun run check` | 成功、79.28秒。format・lint・全ワークスペースの型確認と全2381テスト（Worker 66ファイル995件を含む）が成功 |
| `bun run build` | 成功、9.35秒 |
| `bun run --cwd apps/worker deploy:dry-run` | 成功、0.62秒。公開なし |
| `bun run build:development` | 成功、9.13秒 |
| `bun run --cwd apps/worker deploy:dry-run:development` | 成功、0.60秒。公開なし |
| 削除・復元SQLのローカル確認 | 成功。18局＋履歴1行だけの削除・対象外保持・元文字列復元・変更時の全ロールバック・FK整合性を確認 |
| 最終文書・差分確認 | 5文書のローカル参照1503件・コード囲みと `git diff --check` が成功 |

成功したcheckに至るまで、サンドボックスのps起動制限による失敗と、Workerテスト基盤のcross-request I/Oエラーによる停止が各1回あった。停止した実行では `accounts.test.ts` のID同時取得でVitestのエラー通知RPCも失敗した。該当ファイル単独6件、ゲストと組み合わせた36件は成功し、コードを変更せず全体を再実行した上表の検証でも再現しなかった。原因は確定していない。buildには500kBを超えるchunkの警告がある。

GitHub CI、実環境での経路別時間・SQL計画、DO内の旧状態の残存件数は未確認である。本番データのDELETEは上記のとおり完了した。マージ・デプロイは未実施であり、通信速度の改善を実測した結果ではない。

### 参照した変更履歴

- [PR #163](https://github.com/yksw-clm/tetraboard-2026/pull/163)：退会受付後の利用停止、旧名・画像の除去、遅延保存による復活防止の契約。退会確認の導入コミットは `f6d4d32`。
- [PR #71](https://github.com/yksw-clm/tetraboard-2026/pull/71)：読取り正規化と保存用元データの分離、旧manifestからの再開、固定棋譜による互換検証。
- [PR #229](https://github.com/yksw-clm/tetraboard-2026/pull/229)：対局一覧の通常の参加者解決を最大3問い合わせへ整理済み。取り込みコミットは `d508a80`。
- `a67d7f1`（2026-10-07）：プロフィール付きロビー索引と旧行のDO参照。
- `2c78625`：ゲスト準備・記録・参加の導入。`0cbf1c3`：表示用持ち駒の旧Worker対応。`776c602`：現在の戦型通知の整理。
