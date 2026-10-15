# Development

## 最初に読む案内

この文書は実装を探す入口、変更手順、構造と注意点を記します。最初にこの案内と次の共通手順を読み、変更対象別の表から必要な節へ進んでください。仕様を判断するときは、案内のリンク先にある正本の本文を確認します。

| 文書                                                     | 主に残す内容                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [README](../README.md)                                   | サービスの目的、利用者向け仕様、ゲーム共通仕様、詳細への入口                                      |
| [ゲームのルール正本](#変更対象別の案内)                  | ゲーム固有のルールとCPUの現在の採用仕様                                                           |
| [構成文書](architecture.md)                              | 技術構成、責務と状態の分担、長期参照が必要な設計理由                                              |
| この開発文書                                             | 実装の入口、変更手順、構造と互換性などの注意点                                                    |
| [テスト方針](testing.md)                                 | 実行方法、検証範囲、対象別のテストと移管根拠                                                      |
| [四人将棋AIの測定・採用記録](four-shogi-ai.md)           | 比較条件、対象コミット、結果、採用判断と限界                                                      |
| [四人将棋シングルスAIの契約](four-shogi-ai-engine.md)    | 新AIの承認済み目標・D01〜D05の設計契約、判断IDと未決事項。実装前の計画と現行CPUの採用仕様を分ける |
| [四人リバーシAI強化の計画・採用判断](four-reversi-ai.md) | Goal・制約・受入条件・コミット計画、測定条件と採用判断の記録                                      |

CPUの探索方式・上限・評価値など、現在の採用仕様はルール正本で保守し、実装案内から参照します。APIの使用例や実装の責務はこの文書に残します。測定時の設定や旧方式は測定対象コミットにひも付く条件として保持し、現在仕様へ書き換えません。正本にない実装値を、新しい採用仕様として推測で確定しないでください。

## 共通の作業手順

1. [AGENTS.md](../AGENTS.md) の作業・承認・検証ルールを確認し、READMEの対象箇所と、ゲーム固有の変更なら対象ゲームのルール正本を読みます。
2. コードの作成・変更・レビューでは [Code Principles](#code-principles)、[Naming](#naming)、[Comments](#comments) を確認します。ローカル起動が必要な場合は [Local Development](#local-development)、検証環境は [Checks](#checks) と [テスト方針の実行環境](testing.md#実行環境) を参照します。
3. 下表から必要な仕様・実装・テストを確認します。共通部品や通信・時計・保存を横断する変更では、関連する行の説明と契約も読みます。案内にない対象は見出し・キーワードを検索して参照範囲を広げます。
4. 仕様と実装に差があれば、承認指示・正本・Git履歴・利用できるIssue／PRを照合し、文書の陳腐化か実装の不具合かを判断します。未決定事項や矛盾を推測で埋めず、開発者に確認します。
5. 変更に伴う仕様文書と実装案内を更新し、関連文書を検索して現在仕様として旧説明が残っていないか確認します。[PR提出前の検証](#pr提出前の検証) を行い、[PRテンプレート](../.github/pull_request_template.md) に対象コミット・環境・結果・未確認事項を記載します。

## 変更対象別の案内

実装・テスト欄は代表的な入口です。対象別の部分実行コマンドは [変更対象別の確認](testing.md#変更対象別の確認) にまとめています。PR前の必須検証は上の共通手順に従います。

| 変更対象                                 | 仕様の正本                                                                                                                                                        | 開発文書の該当節と主な実装                                                                                                                                                                                                                                                                    | テストの入口                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 終局後の登録・対局引き継ぎ               | [共通仕様](../README.md#終局後の登録と継続再戦)                                                                                                                   | [実装と完了条件](#任意登録の案内と画面復帰)、[構成](architecture.md#終局後の登録フローと記録の帰属)、[registrationRoutes.ts](../apps/worker/src/accounts/registrationRoutes.ts)、[matchClaims.ts](../apps/worker/src/accounts/matchClaims.ts)                                                 | [受入検証](testing.md#終局後の登録引き継ぎ)                                                                                                                                                            |
| 認証・プロフィール・参加資格             | [認証とプロフィール](../README.md#googlediscord認証とプロフィール)、[参加](../README.md#対局部屋と参加)                                                           | [認証と移行](#google認証とアカウント移行)、[アカウント参加](#アカウントでのルーム参加)、[auth.ts](../apps/worker/src/accounts/auth.ts)、[AccountSession.tsx](../apps/web/src/features/account/AccountSession.tsx)                                                                             | [accounts.test.ts](../apps/worker/test/accounts.test.ts)、[accountSession.test.tsx](../apps/web/test-dom/accountSession.test.tsx)                                                                      |
| プライバシー・規約・退会・計測期限       | [確定仕様](../README.md#プライバシー利用規約退会の確定仕様)                                                                                                       | [実装計画](#プライバシー規約退会の実装計画)、認証・棋譜・ルーム・計測・フィードバックの既存入口                                                                                                                                                                                               | [検証と公開前の確認](testing.md#プライバシー規約退会の確認)                                                                                                                                            |
| 時計・接続・ルーム進行                   | [投了、通信切れと持ち時間](../README.md#投了通信切れと持ち時間)                                                                                                   | [共有transport](#共有transportとゲーム別session)、[時計と期限](#workerの時計計算と期限選択)、[進行とライフサイクル](#workerのゲーム進行と共有ライフサイクル)、[clockCore.ts](../apps/worker/src/rooms/clockCore.ts)、[useRoomTransport.ts](../apps/web/src/features/room/useRoomTransport.ts) | [timeControl.test.ts](../apps/worker/test/timeControl.test.ts)、[roomTransportLifecycle.test.tsx](../apps/web/test-dom/roomTransportLifecycle.test.tsx)                                                |
| 終局保存・棋譜・互換性                   | [終局保存](../README.md#終局データの保存対局履歴)、[保存棋譜](../README.md#保存済み棋譜の閲覧)、対象ゲームの正本                                                  | [終局保存](#終局保存と本人の対局履歴)、[棋譜互換](#保存データの契約と棋譜互換)、[matchStore.ts](../apps/worker/src/rooms/matchStore.ts)、[shogiMatchStore.ts](../apps/worker/src/rooms/shogiMatchStore.ts)、[fetchEventReplay.ts](../apps/web/src/features/room/fetchEventReplay.ts)          | [matchCompatibility.test.ts](../apps/worker/test/matchCompatibility.test.ts)、[savedReplay.test.tsx](../apps/web/test-dom/savedReplay.test.tsx)                                                        |
| 総合ロビー・公開チャット                 | [確定仕様](../README.md#総合ロビーの確定仕様)                                                                                                                     | [実装計画](#総合ロビーの実装計画)・[実装](#総合ロビーの実装)、既存のルーム索引・公開棋譜・認証・管理・配信                                                                                                                                                                                    | [受入検証](testing.md#総合ロビーの確認)                                                                                                                                                                |
| 画面・ロビー・共通部品                   | READMEの対象画面、[共通UI](../README.md#共通uiとスタイル)                                                                                                         | [Webの編集先](#webの編集先)、[共通ロビー](#共通ロビーと四人将棋ui)、[LobbyView.tsx](../apps/web/src/features/lobby/LobbyView.tsx)、[RoomLayout.tsx](../apps/web/src/features/room/RoomLayout.tsx)、[shared/ui](../apps/web/src/shared/ui/)                                                    | [lobbyComponents.test.tsx](../apps/web/test-dom/lobbyComponents.test.tsx)、[presentation.test.tsx](../apps/web/test-dom/presentation.test.tsx)                                                         |
| ルーム共有                               | [確定した共有仕様](../README.md#ルーム共有の確定仕様)                                                                                                             | [Goal・ContextProviders・Constraints・Done When](#ルーム共有の実装計画)、[useRoomEntry.ts](../apps/web/src/features/lobby/useRoomEntry.ts)、[useRoomInvitation.ts](../apps/web/src/features/room/useRoomInvitation.ts)、[publicAssets.ts](../apps/worker/src/publicAssets.ts)                 | [ルーム共有の確認](testing.md#ルーム共有の確認)                                                                                                                                                        |
| ゲーム・CPU                              | [四人リバーシ](rules/four-reversi.md)、[四人将棋](rules/four-shogi.md)、[リバーシ](rules/reversi.md)、[将棋](rules/shogi.md)、[五目並べ](rules/gomoku.md)         | [ゲームの必須登録](#ゲームの必須登録と型の対応)、[四人将棋エンジン](#四人将棋エンジン)、[四人将棋CPU](#四人将棋cpu)、[通常リバーシ](#通常リバーシの実装)、[通常将棋](#通常将棋の実装)、[packages](../packages/)、[gameProgress.ts](../apps/worker/src/rooms/gameProgress.ts)                  | 各ゲームの `test/`、[cpuSearch.test.ts](../packages/four-shogi/test/cpuSearch.test.ts)、[commonRoomBehavior.test.ts](../apps/worker/test/commonRoomBehavior.test.ts)                                   |
| 表示・サウンド設定                       | [設定](../README.md#表示サウンド設定)、[効果音](../README.md#効果音)、[時計通知](../README.md#時間切れ5秒前の通知)                                                | [表示・サウンド設定](#表示サウンド設定)、[共通効果音](#ルームの共通効果音)、[browserSettings.ts](../apps/web/src/shared/browserSettings.ts)、[soundPlayer.ts](../apps/web/src/shared/soundPlayer.ts)                                                                                          | [設定の確認](testing.md#表示サウンド設定の確認)、[browserSettings.test.tsx](../apps/web/test-dom/browserSettings.test.tsx)                                                                             |
| チャット・スタンプ                       | [チャット](../README.md#チャット)、[保存とモデレーション](../README.md#チャットの保存期間とモデレーション)、[スタンプ](../README.md#ルームのスタンプ)             | [スタンプ](#ルームのスタンプ)、[gameRoom.ts](../apps/worker/src/rooms/gameRoom.ts)、[useSessionChat.ts](../apps/web/src/features/room/useSessionChat.ts)、[useRoomStamps.ts](../apps/web/src/features/room/useRoomStamps.ts)                                                                  | [スタンプの確認](testing.md#ルームのスタンプの確認)、[commonRoomBehavior.test.ts](../apps/worker/test/commonRoomBehavior.test.ts)                                                                      |
| 戦績・ランキング・戦型・バッジ           | [戦績](../README.md#戦績の表示)、[ランキング](../README.md#ランキングの表示)、[バッジ](../README.md#バッジ)、[四人将棋の戦型](rules/four-shogi.md#戦型の成立判定) | [戦績集計](#本人の戦績集計)、[ランキング](#ゲーム別のランキング)、[戦型解析](#四人将棋の戦型解析と通知)、[バッジ](#バッジ判定と画像)、[accounts](../apps/worker/src/accounts/)                                                                                                                | [accountStats.test.ts](../apps/worker/test/accountStats.test.ts)、[badgeNotifications.test.ts](../apps/worker/test/badgeNotifications.test.ts)、[バッジ通知の確認](testing.md#バッジ獲得通知issue-122) |
| 管理画面・計測・フィードバック・お知らせ | [計測画面](../README.md#計測用管理画面)、[フィードバック](../README.md#フィードバック受付とお知らせ)、[お知らせ管理](../README.md#お知らせの管理とロビー掲載)     | [管理画面](#計測用管理画面の開発と公開)、[フィードバック運営](#フィードバックの受付運営)、[お知らせ](#お知らせの保存管理公開)、[admin](../apps/worker/src/admin/)、[apps/admin](../apps/admin/src/)                                                                                           | [adminAnalytics.test.ts](../apps/worker/test/adminAnalytics.test.ts)、[feedback.test.ts](../apps/worker/test/feedback.test.ts)、[announcements.test.ts](../apps/worker/test/announcements.test.ts)     |
| 公開・環境設定・CI                       | [開発と本番公開](../README.md#開発と本番公開)、[AGENTS.md](../AGENTS.md)                                                                                          | [本番デプロイ](#本番デプロイ)、[Checks](#checks)、[個人設定からの分離](testing.md#個人設定からの分離)、[ci.yml](../.github/workflows/ci.yml)、[buildAssets.ts](../scripts/buildAssets.ts)                                                                                                     | [testEnvironment.test.ts](../apps/worker/test/testEnvironment.test.ts)、[publicAssets.test.ts](../apps/worker/test/publicAssets.test.ts)、必須のcheck・build・Worker dry-run                           |
| 五目並べ                                 | [追加範囲](../README.md#五目並べ)、[ルール正本](rules/gomoku.md)                                                                                                  | [実装](#五目並べの実装)・[計画](#五目並べの実装計画)、[ゲームの必須登録](#ゲームの必須登録と型の対応)                                                                                                                                                                                         | [エンジン](../packages/gomoku/test/)、[Worker](../apps/worker/test/gomokuRoom.test.ts)、[DOM](../apps/web/test-dom/gomoku.test.tsx)                                                                    |
| 四人五目並べ                             | [追加範囲](../README.md#四人五目並べ)、[ルール正本](rules/four-gomoku.md)                                                                                         | [実装](#四人五目並べの実装)・[計画と完了条件](#四人五目並べの実装計画)                                                                                                                                                                                                                        | [エンジン](../packages/four-gomoku/test/)、[Worker](../apps/worker/test/fourGomokuRoom.test.ts)、[DOM](../apps/web/test-dom/fourGomoku.test.tsx)                                                       |

## 四人リバーシCPU

現行APIは `@tetraboard/four-reversi` の `chooseCpuMove(state, level, random = Math.random): Position | null` です。合法手・公開API・採用したCPU方式は [ルール正本のCPU節](rules/four-reversi.md#cpu) を確認してください。

2026-10-11に強化仕様と [Goal・ContextProviders・Constraints・Done When・コミット計画](four-reversi-ai.md) を確定しました。仕様PR取り込み後のdevelopから実装し、多人数探索・配置とチーム評価・終盤全読み・終局予測・Worker接続を追加し、採用測定の結果を同文書へ記録しています。

実装の入口は [公開API](../packages/four-reversi/src/index.ts)、[エンジン](../packages/four-reversi/src/engine.ts)、[CPU](../packages/four-reversi/src/cpu.ts)、[探索](../packages/four-reversi/src/cpuSearch.ts)、[評価](../packages/four-reversi/src/cpuEvaluation.ts)、[終局予測](../packages/four-reversi/src/cpuForecast.ts)、[Worker進行](../apps/worker/src/rooms/fourReversiProgress.ts)、[GameRoomのAlarmと期限処理](../apps/worker/src/rooms/gameRoom.ts) です。生成済みの合法候補を使う内部経路を通常着手の確定処理と共有します。公開エンジン状態と通信契約は維持します。

Workerは四人リバーシのLv1／Lv2をAlarm限定で選択保存し、次Alarmで適用します。内部対局ID・部屋世代・CPU本人とレベル・ゲーム局面キー・手番開始時刻で照合し、通常GETでは選択も適用も起動しません。記録導入前の対局IDなしのDOも進行できます。手番外の脱落でもジョブを破棄し、チャット・スタンプだけで再探索しません。詳細な検証の分担は [四人リバーシAI強化の確認](testing.md#四人リバーシai強化の確認) を参照します。

## Development Strategy

既存の共通ロビー・ルーム・記録機能を土台に、ゲーム固有のエンジンと画面を追加します。検証は純粋関数、部品・hook、Worker統合テストへ集約します。

## ゲームIDと軽量カタログ

ゲームIDの正本は `packages/protocol/src/games.ts` の `gameIds` です。追加時は同じファイルの `gameCatalog` に表示名・ロビーパス・ランキングAPIパスを登録します。`GameId` は実ゲームだけ、`GameScope` は集計・フィードバックなどのサービス全体を表す `all` も含みます。`all` をルームや対局のゲームとして渡しません。既定ゲームは `defaultGameId` の四人リバーシです。

表示名・選択肢・パスだけが必要な画面は `@tetraboard/protocol/games` を直接参照します。この入口にはZod・React・エンジン・CPUを持ち込まず、検証スキーマは別の `gameSchemas.ts` に置きます。テーマとルール表示、ゲーム固有の処理は各アプリで管理します。カタログへの登録だけで新ゲームの対局機能が実装されるわけではありません。

IDと `all` の境界・既定値は `bun run --cwd apps/worker test test/gameCatalog.test.ts test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` で確認します。軽量入口の依存は `bun build packages/protocol/src/games.ts --target=browser --outfile=/tmp/tetraboard-game-catalog.js --metafile=/tmp/tetraboard-game-catalog.meta.json` の入力一覧で確認できます。

#189のデータ生成は [selfPlayCli.ts](../packages/four-shogi/bench/selfPlayCli.ts) が入口です。[selfPlayData.ts](../packages/four-shogi/bench/selfPlayData.ts) は版付きmanifest/系列/分割/相手/教師の設定、[selfPlayGame.ts](../packages/four-shogi/bench/selfPlayGame.ts) は既存対戦runnerのhookで完全イベント・必要局面・教師を記録します。[selfPlayRun.ts](../packages/four-shogi/bench/selfPlayRun.ts) と [selfPlayWorker.ts](../packages/four-shogi/bench/selfPlayWorker.ts) がBun子プロセスの上限/中断/ACKを、[selfPlayStore.ts](../packages/four-shogi/bench/selfPlayStore.ts) が親だけの原子的保存/lock/容量を担当し、[selfPlayInspect.ts](../packages/four-shogi/bench/selfPlayInspect.ts) が再生/結果/マスク/版/漏れを照合します。[actionEncoding.ts](../packages/four-shogi/src/actionEncoding.ts) はBun/FSへ依存しない固定行動IDです。固定CPUの一時ソースもdataset内scratchへ置き、終了・再開時に回収します。[保存形式と操作手順](four-shogi-ai-engine.md#自己対戦と探索教師データ189)、[テスト](testing.md#四人将棋シングルスaiの契約確認)を参照してください。#190の学習は以下の専用CLIで実装しました。

## 通常リバーシの実装

`packages/reversi` は黒白2人の独立したルールエンジンとCPUを持ちます。ゲームカタログの `capacity` と `hasModes` に定員2・モードなしを登録し、共有の席管理・開始条件・公開情報・集計条件はゲーム別定員を参照します。

`ReversiRoom`・対局記録・戦績・ランキングは専用の公開契約を持ち、通常リバーシの作成と履歴取得はモード指定を受け付けません。公開JSONにもモードを含めません。既存のD1のNOT NULLモード列には内部識別値 `standard` を保存します。既存の四人ゲームのモード値・JSONと既定ゲームを維持し、過去データの移行は行いません。保存は四人リバーシと同じ局面列方式で、保存待ち・5秒後の再送・本人索引・閉鎖後の保持を共用します。本人索引のゲーム列は保存済み対局から明示的に設定します。

Workerは `reversiProgress`・`reversiClock`・`reversiMatchStore` を登録し、共有GameRoomから呼びます。戦績は専用の勝敗SQL、ランキングは勝数と対局数、公開プレイヤー情報はモードなしの戦績を返します。通常リバーシのバッジは判定・表示しません。

Webの通常リバーシロビー・ライブ・保存棋譜はゲーム別に登録し、独立したエンジンだけを読み込みます。盤面描画と石・プレイヤーカードの基本描画は共有します。通常リバーシの対局・棋譜は上下2カード、観戦・保存棋譜は180度回転、ゲーム本文・マイページ・棋譜・Portalは薄い緑テーマです。静的生成・配信・サイトマップは6ロビーに対応します。

## 通常将棋の実装

通常将棋のルール正本は `docs/rules/shogi.md` です。独立した `packages/shogi` に純粋なルールエンジンとCPUを置き、初期化・合法手・王手・着手・外部敗北・千日手・持将棋・入玉宣言・500手を扱います。先手と後手、持ち駒7種類、8種類の盤上駒を専用のprotocol契約で検証します。`rulesVersion: 1` の棋譜は初期の配席と受理したイベントを再実行して復元し、最終状態の一致を検査します。互換を壊すルール変更では再生版を追加します。

CPU Lv1は合法手から一様に選びます。Lv2は駒の価値・成り・前進・無防備な駒・持ち駒・王手を評価し、最大3手・512回の着手評価で探索します。完了した深さの結果を採用し、予算が少なくても合法手を返します。探索時の入力と永続履歴を変更しません。Workerは勝てる入玉宣言を優先し、成立可能な人間の持将棋提案へ手番外でも同意します。CPUの選択をKVへ保存してから次のAlarmで期限・局・revision・手番を再検証して適用し、探索時間も時計に含めます。

`standardShogiProgress.ts` は通常将棋の開始・着手・特殊操作・終局を担当し、認証・席管理・時計計算・準備・チャット・接続期限・保存再試行はGameRoomの既存処理を使います。`EventGameStore` は四人将棋と通常将棋のイベント・局・保護棋譜・ページングを共用します。通常将棋のSQLite表は `standard_shogi_`、四人将棋は既存の `shogi_` を使い、既存データを移行しません。通常将棋の反復辞書は配信せず、必要な局面の回数と初回時の連続王手判定用カウンターをSQLiteから取得し、変更分だけ保存します。公開状態には各側の王手をしなかった着手の累積カウンターだけを含めます。

D1の分割棋譜転送・全ページ検証・本人索引・再送は `shogiMatchStore.ts` を共用し、ゲームごとにイベントと記録の契約を切り替えます。モードなしの内部DB値は通常リバーシと同じ `standard` です。勝敗集計・ランキング・公開プロフィール・モードの表示条件には通常リバーシの2人用処理とカタログの `capacity`・`hasModes` を再利用します。CPU戦も履歴と公開棋譜を保存し、対人戦績とランキングから除きます。新しい外部サービス・本番DBマイグレーションはありません。

Webは四人将棋の盤面操作・持ち駒・成り選択・画像キャッシュ・楽観表示・送信待ち判定を共用します。通常将棋では上下2カードと横並びの7種類の持ち駒を描画し、後手の本人も下に置きます。カード・持ち駒の幅は盤面とそろえ、手前は左寄せ、奥は右寄せです。盤面の上限幅は600pxとし、カード・持ち駒・余白も含めて表示領域の高さに収まる幅を計算します。通常将棋だけカード・アバター・駒を拡大し、四人将棋の寸法を維持します。デスクトップの棋譜操作欄はカードと重ならないよう通常の文書フローに置きます。四人将棋の引分提案と同じ送信待ちを使い、通常将棋のルールで提案ボタンの表示可否を決めます。入玉宣言は確認した局とrevisionに限って送信し、局面が変わったら確認を閉じます。棋譜の分割取得・検証・取消・ルーム内の取得hookは `fetchEventReplay.ts` と `useEventRoomReplay.ts` を共用し、再生ルールと表示名はゲーム別にします。ライブ・保存棋譜の入口は遅延読み込みし、ビルドで6ゲームすべての静的依存とCPUの混入を検査します。

部分確認は次のコマンドを使います。

```sh
bun run --cwd packages/shogi test
bun run --cwd apps/worker test test/standardShogiRoom.test.ts test/standardShogiRecords.test.ts test/standardShogiStore.test.ts test/commonRoomBehavior.test.ts
bun test --cwd apps/web test/standardShogiReplay.test.ts
bun test --cwd apps/web --preload ../../test-support/dom.ts test-dom/standardShogi.test.tsx
```

Goalは対人／CPU対局から終局・再戦・棋譜・集計までを統合し、必須ローカル検証とGitHub CIが成功したPRを提出することです。ContextProviderの優先順位は承認指示、AGENTS、READMEと通常将棋ルール正本、開発・テスト文書、既存実装・固定棋譜・履歴、外部規則です。既存3ゲームの通信・保存互換、ゲーム別の遅延読み込み、Bun／happy-dom／Workerテスト、180秒以内を目標とするcheckを制約とします。

Done Whenは全駒・禁止手・詰み・千日手・持将棋・入玉・500手の境界検証、CPUの合法性・入力不変・決定性・探索上限、オンラインの時計・接続・再戦・保存再試行、7種類の持ち駒・回転・モードとバッジの非表示、対人限定集計・既存ゲーム回帰、6ロビーの配信、必須ローカル検証とGitHub CIの成功です。画面寸法・ネイティブ入力・実画像デコードは手動確認と未確認事項を記録します。

作業ブランチは `feat/shogi`、当初計画は次の7コミットです。各実装に関連テストを含め、ゲームの必須登録と各層の統合は同じコミットにします。追加の表示調整指示を受け、8つ目に `fix: 通常将棋の持ち駒と盤面の配置を調整する` を加えます。

1. `docs: 通常将棋の仕様と採用する裁定を確定する`
2. `feat: 通常将棋のルールエンジンを追加する`
3. `feat: 通常将棋の千日手と持将棋と入玉宣言を追加する`
4. `feat: 通常将棋のCPUレベル1とレベル2を追加する`
5. `feat: 通常将棋をオンライン対局とロビーと記録機能に統合する`
6. `test: 通常将棋の対局フローと既存ゲームの互換性を検証する`
7. `docs: 通常将棋の開発手順と検証結果を記載する`

## 五目並べの実装

- [packages/gomoku](../packages/gomoku/src/index.ts) が15路・手番・勝敗・外部敗北・全空点の合法手を扱います。[forbidden.ts](../packages/gomoku/src/forbidden.ts) は三三の発展先を再帰的に検証します。CPU専用の [cpu.ts](../packages/gomoku/src/cpu.ts) は `@tetraboard/gomoku/cpu` からWorkerだけが読み込みます。採用した探索上限・評価係数は[ルール正本](rules/gomoku.md#cpu)を参照します。
- [gomokuProgress.ts](../apps/worker/src/rooms/gomokuProgress.ts) が配席・開始・着手・時計・終局・CPUを担当し、GameRoomの共通ライフサイクルへ接続します。CPUは候補をDOへ保存して次Alarmで期限を再確認し、同期計算時間を時計へ反映します。更新・終局・閉鎖時は候補を破棄します。時計の計算は既存の2色用モジュールを共用します。
- 着手通信は `placeGomokuStone` と0〜14の座標、必須の `roundId`・`positionRevision` を使います。既存リバーシの `placeStone` と0〜7の契約を維持します。禁手設定は待機中のホストだけが変更でき、対局開始時の設定はゲーム状態・対局記録・直前局に保持します。
- [gomokuMatchStore.ts](../apps/worker/src/rooms/gomokuMatchStore.ts) と [gomokuMatchData.ts](../apps/worker/src/accounts/gomokuMatchData.ts) が保存・読取り・公開／本人棋譜・集計を接続します。D1の既存テーブルと再送処理を使い、新しいマイグレーションはありません。規則版1の局面列は [replay.ts](../packages/gomoku/src/replay.ts) で全着手を再実行し、途中・最終局面を照合します。
- [GomokuLobbyPage](../apps/web/src/features/lobby/GomokuLobbyPage.tsx)、[GomokuRoomDetail](../apps/web/src/features/room/GomokuRoomDetail.tsx)、[GomokuMatchReplayView](../apps/web/src/features/room/GomokuMatchReplayView.tsx) を登録します。SVGの15路盤・上下カード・紫テーマ・座標表記を専用の画面で扱い、接続・設定・チャット・スタンプ・棋譜操作を共用します。禁手はクライアントとサーバーで検査し、本人の3秒toastへ接続します。
- 固定棋譜と境界の確認は[テスト文書](testing.md#五目並べの確認)にまとめています。実機の入力・寸法・音声は自動検証の対象外とし、PRで実施結果または未確認事項を報告します。

## 五目並べの実装計画

2026-10-11に開発者が仕様確定と実装計画の作成を指示しました。仕様の正本は[五目並べのルール](rules/gomoku.md)、サービスへの追加範囲は[README](../README.md#五目並べ)です。仕様PR [#149](https://github.com/yksw-clm/tetraboard-2026/pull/149)を取り込んだmain `5da1f62` から実装しました。実装の入口を以下に記し、承認済みのGoal・制約・完了条件を維持します。検証対象コミットと結果は実装PRで管理します。

**Goal**

5番目のゲームとして、承認済みの禁手ON/OFFを持つ2人用五目並べを `/games/gomoku` に追加します。人間同士またはCPUと対局し、観戦・終局・再戦・履歴・棋譜・対人戦績・ランキングまで既存2人用ゲームと同等に利用できる状態を作ります。紫テーマ、1回で確定する着手、禁手拒否toast、固定座標の棋譜を統合し、必須ローカル検証とGitHub CIが成功したレビュー可能な実装PRを提出します。

仕様文書PRだけでは上記の実装Goalを達成したことにはしません。実装・検証を含むPRを提出し、マージ・本番公開は別途の承認対象です。

**ContextProviders**

次の順で参照します。外部ルール・過去PR・表示見本に差がある場合は、承認済みのTetraBoard仕様を優先します。

1. この会話での開発者の承認。禁手3種類を黒だけにまとめて初期ON、禁手拒否とtoast、黒の合法手なしで白勝ち、各局の抽選、紫テーマ、1回の着手、既存2人用ゲームと同等の範囲、棋譜・CPU・集計・対象外の確定内容です。
2. [AGENTS.md](../AGENTS.md)の作業ブランチ、コミット、承認、ローカル検証・CIの規約。
3. [README](../README.md)のゲーム共通仕様・五目並べの追加範囲と、[五目並べのルール正本](rules/gomoku.md)。画面見本は補助資料とし、文書にない見本専用操作を製品仕様へ追加しません。
4. この開発文書のゲーム登録・transport・時計・保存・Web編集先、[構成文書](architecture.md)、[テスト方針](testing.md)。ゲーム共通の処理とゲーム固有の処理の責務を確認します。
5. 既存の通常リバーシ・通常将棋・四人将棋の実装と固定棋譜、Git履歴、基盤整備のIssue [#56](https://github.com/yksw-clm/tetraboard-2026/issues/56)・[#57](https://github.com/yksw-clm/tetraboard-2026/issues/57)・[#58](https://github.com/yksw-clm/tetraboard-2026/issues/58)・[#59](https://github.com/yksw-clm/tetraboard-2026/issues/59)、追加時のPR [#105](https://github.com/yksw-clm/tetraboard-2026/pull/105)・[#106](https://github.com/yksw-clm/tetraboard-2026/pull/106)。古いブラウザ自動テストの記載は現行の検証方針に置き換えて読みます。
6. 正本が参照する[Gomocupの説明](https://gomocup.org/detail-information/)と[RIF連珠規則](https://www.renju.net/rifrules/)の定義。大会固有の開始手順・パス・反則負け・申告制をTetraBoardへ追加しません。

**Constraints**

- 最新developから仕様文書は `docs/gomoku-spec`、実装は `feat/gomoku` などの作業ブランチを作り、PRで取り込みます。mainへ直接push・force pushを行わず、仕様・主要構成の変更とマージ・公開はAGENTSの承認条件に従います。
- 既存のBun・TypeScript・React・HeroUI・Worker・Durable Object・D1を使います。純粋なルールエンジンとCPUは独立した `packages/gomoku` に置き、新しい外部サービス・主要依存を追加しません。共通ライフサイクルを複製したり、将来のためだけの汎用化を行ったりしません。
- 既存4ゲームのルール・通信・保存棋譜・認証・集計互換を守り、五目並べを未知ID時のフォールバックにしません。15路の座標を既存リバーシの0〜7の契約へ流用しません。規則版・保存形式と表示設定を区別し、対局開始時の禁手設定で旧棋譜を復元します。
- 着手の正本はサーバーです。局・更新番号・手番・期限を照合し、二重送信や古い局面からの操作を防ぎます。禁手拒否で時計を停止・リセットせず、黒の合法手なしは全空点を検査して白勝ちにします。
- 禁手の再帰的な判定をCPUの予算切れで近似せず、近傍候補の不足を合法手なしと誤判定しません。CPUの具体的な近傍距離・探索予算・評価係数などは実装時の測定で調整し、採用値と境界テストを正本へ追記します。確認なしにCPUレベル数や対局ルールを変更しません。
- ゲームカタログは軽量に保ち、ライブ・棋譜はゲーム別の遅延読み込みを維持します。五目並べのCPUをWebへ含めず、他ゲームのエンジンを五目並べの入口へ混入させません。新しいGameIdと必須登録は整合した単位で追加します。
- 禁手ON/OFFの戦績は合算し、CPU戦は棋譜保存のみで戦績・ランキングへ含めません。待った・ヒント・パス・合意引き分け・バッジ・戦法別戦績・盤サイズ切替・連珠の開局規定は初回範囲外です。
- 自動検証は純粋関数のBunテスト、Bun＋happy-domの部品・hook、Worker統合テストに集約します。ブラウザを起動するテスト・設定・workflowを追加しません。画面寸法・ネイティブ入力・実画像デコード・実音声は手動確認の結果または未確認事項を記録します。
- `bun run check` の180秒以内は目標です。CIで所要時間を記録し、超過時は結果と理由を報告します。テスト省略や失敗の無視で目標達成とはしません。基準PR #148のCI checkは192秒だったため、既存の超過と五目並べ追加の影響を区別して測定します。
- 実装PR前に `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run` をすべて成功させます。GitHub CIの成功も独立して必要です。コード・設定の追加修正やmain・develop取り込み後は必須コマンドを再実行します。

**Done When**

- 15路・黒白交互、全4方向と盤端の勝利、5個／6個以上、両端を塞がれた連、最後の着手の勝利と満盤引き分けを確認しています。黒の五連と禁手の同時成立では五連を優先し、白・OFFは5個以上で勝ちます。
- 三三・四四・長連、見かけの三三、発展先が禁手になる三、同一の四の二重計数、同方向の異なる四を独立した固定局面で確認しています。正本の再帰的な条件を満たし、入力盤面を変更しません。全空点が禁手の黒は白勝ちになり、近傍以外に合法手がある場合は継続します。
- 初期ON、作成・すぐ遊ぶ・待機設定、ホスト権限、変更時の準備解除、対局中固定、再戦引き継ぎ、開始・再戦の抽選、ルーム復元と保存棋譜の設定保持を確認しています。禁手拒否では盤面・手数・直前手が不変で時計が継続し、本人だけに理由付き3秒toastを表示して重複を抑止します。
- 人間同士／CPU、ゲスト／アカウント、参加・観戦・招待・準備・開始・着手・投了・時計・切断復帰・再戦・閉鎖・チャット・スタンプ・表示設定が動作します。CPUはON/OFFで合法手を返し、Lv2の即勝ち・防御、予算上限、最低2秒待機、期限優先を検証しています。
- 終局保存・再送・重複防止・閉鎖後の保存待ち・本人限定履歴が動作します。固定棋譜で初期・途中・終局を再現し、禁手拒否を記録せず、外部敗北を保存します。禁手ON/OFF合算、対人限定集計、CPU除外、引き分けの分母を確認しています。
- 紫テーマ、上下2カード、交点への1回の着手、座標、直前手・勝利の強調、固定表記、前後・Select、観戦・保存棋譜の180度回転を検証しています。巻き戻しで未来の勝利を表示せず、待機設定変更で前局の棋譜を変えません。実端末の交点の押しやすさ・toast・長い名前・横スクロールは手動確認の結果または未確認理由を記録します。
- ロビー・マイページ・ランキング・公開プロフィール・管理・計測・フィードバック・お知らせのゲーム登録がそろっています。6ロビーの初期HTML・紹介・メタ情報・canonical・サイトマップと配信を検証し、既定ゲームと他画面の検索除外を維持します。
- 既存4ゲームの固定棋譜・共通ルーム・認証・戦績と、5ゲームの型対応・未知ID拒否・遅延読み込みを確認しています。READMEのゲーム数・ロビー一覧・CPU席数・スマートフォンの4等分などを実装に合わせて更新し、現在仕様として古い説明を残していません。
- 必須ローカルコマンド、文書の整形・リンク・`git diff --check`、対象コミットのGitHub CIが成功しています。PR本文に検証対象コミット・実行環境・各結果・check所要時間・未確認事項を記録し、開発者が差分と結果をレビューできる状態です。マージ・本番公開・Search Consoleの反映は、この実装PR提出の完了条件に含めず、承認後の公開手順で確認します。

**コミット計画**

各実装コミットに対応するテストを含め、最後のテストコミットまで検証を先送りしません。仕様確定は文書PR、実装は別PRを基本とし、文書PRが取り込まれた最新developを実装の起点にします。取り込まれていない場合は依存する文書コミットを明示して、同じ文書を重複作成しません。

| 順  | コミットメッセージ                                         | 主な内容・確認                                                                                                                                               |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `docs: 五目並べの仕様と実装計画を確定する`                 | 仕様PR #149。README、ルール正本、本節に確定仕様・4項目・計画を記載。文書確認と既存コードに対する検証結果の確認                                               |
| 2   | `feat: 五目並べの基本ルールエンジンを追加する`             | 独立パッケージ、15路・手番・石の配置・連の判定・満盤・外部敗北と純粋関数テスト。公開ゲームにはまだ登録しない                                                 |
| 3   | `feat: 五目並べの禁手判定と合法手なしの終局を追加する`     | 黒の禁手ON/OFF、三三の再帰・四四・長連・五連優先、全空点の合法手、白勝ちの裁定と固定局面テスト                                                               |
| 4   | `feat: 五目並べのCPUレベル1とレベル2を追加する`            | 近傍ランダム、即勝ち・防御と探索上限。合法性・入力不変・処理量・レベル差を確認し、採用した調整値を正本へ追記                                                 |
| 5   | `feat: 五目並べをオンライン対局と記録機能に統合する`       | protocol・Worker・Webの必須登録を同時追加。設定・時計・保存・再戦、紫のロビーと盤面、禁手toast、棋譜・集計・管理・SEOを接続。関連する統合／DOM／型検証も追加 |
| 6   | `test: 五目並べの対局フローと既存ゲームの互換性を検証する` | ON/OFFの固定棋譜、終局・保存失敗と再送・時計境界、5ゲームの共通動作・既存棋譜・集計・配信の横断回帰を補完                                                    |
| 7   | `docs: 五目並べの実装案内と検証範囲を更新する`             | 実際の実装・テストへの入口、調整値、実装済み範囲を正本・開発・テスト文書へ反映。コミット別の測定結果・環境・未確認事項はPR本文に記録                         |

GameIdを追加すると型付きの必須登録が一斉に必要になるため、5番の統合では未対応の画面や保存契約を残しません。実際の差分が大きい場合は、公開登録前に準備できる内部部品を先行コミットへ分けます。コミット分割は実装の都合で調整できますが、承認済みの仕様・範囲・完了条件は変えません。

## 四人五目並べの実装

- [packages/four-gomoku](../packages/four-gomoku/src/index.ts) が15路・4色・両モード・順位を扱います。`completedColors` と `eliminatedColors` を分け、`standings` と `winningLines` は継続中も保持します。[CPU](../packages/four-gomoku/src/cpu.ts) は専用入口だけから読み込みます。探索方式・値は[ルール正本](rules/four-gomoku.md#cpu)を参照します。
- [fourGomokuProgress.ts](../apps/worker/src/rooms/fourGomokuProgress.ts) が配席・着手・期限・CPU・全体終局を共通ライフサイクルへ接続します。通信は専用の `placeFourGomokuStone` に `roundId` と `positionRevision` を要求します。途中順位ではplayingを維持し、最後の確定で保存・結果・再戦へ進みます。
- [fourGomokuMatchData.ts](../apps/worker/src/accounts/fourGomokuMatchData.ts) が規則版1の全局面再生と保存理由を照合します。共通D1保存とモード別SQLを利用し、既存ゲームの契約は維持します。
- [FourGomokuRoomView](../apps/web/src/features/room/FourGomokuRoomView.tsx) と [FourGomokuMatchReplayView](../apps/web/src/features/room/FourGomokuMatchReplayView.tsx) は4カード・途中順位・90度回転を扱います。木の盤面の描画は通常版と共用し、エンジンは別の遅延チャンクです。待機カードは現在の準備状態、保存棋譜カードは選択したフレームの順位を表示します。
- [検証範囲と部分実行](testing.md#四人五目並べの確認)を参照してください。既存5ゲームと新ゲームの全体回帰・必須検証と実機未確認事項はPRへ記録します。

## 四人五目並べの実装計画

2026-10-11に開発者が四人五目並べの仕様確定、Goal・ContextProviders・Constraints・Done Whenとコミット計画の作成を指示しました。同日の追加回答で順位・満盤・チーム脱落・戦績も確定しました。ルール・表示・CPUの正本は[四人五目並べのルール](rules/four-gomoku.md)、サービスへの追加範囲は[README](../README.md#四人五目並べ)です。仕様PR #152のマージ後に実装しました。実装の入口は前節を参照します。

**Goal**

6番目のゲームとして `/games/four-gomoku` に四人五目並べを追加します。15路・4色・禁手なしのシングルスとダブルスを初回から提供し、シングルスは勝ち抜けと脱落によって1〜4位を決め、満盤の未確定者は同順位とします。ダブルスは黒・赤対白・青とし、味方2色を混ぜた5個以上の連でチーム勝利、1人の脱落でチーム敗北とします。人間1〜4人とCPUを組み合わせた計4席の対局から、観戦・終局・再戦・履歴・棋譜・対人戦績・ランキングまで利用できる状態を作ります。

通常の五目並べの紫テーマ・盤・操作と既存四人ゲームのカード配置を組み合わせ、必須ローカル検証とGitHub CIが成功したレビュー可能な実装PRを提出します。今回の文書化の完了は、ゲーム本体の実装Goal達成とは区別します。

**ContextProviders**

次の優先順位で参照します。一般的な五目並べと四人版の独自裁定、現行実装と追加予定を混同しません。

1. この会話での開発者の明示回答。初回から両モード、全順位確定まで継続、禁手・オプションなし、石を残す脱落、色と順番の抽選、通常版と同じUI・操作、初回機能範囲、味方2色の混色完成、および順位・満盤・チーム脱落・戦績についての追加回答です。
2. [AGENTS.md](../AGENTS.md)のブランチ・日本語コミット・仕様承認・ローカル検証・GitHub CI・マージと公開のルール。
3. [README](../README.md)のゲーム共通仕様と四人五目並べの追加範囲、[四人五目並べのルール正本](rules/four-gomoku.md)。通常版の黒だけの禁手、他ゲームの個人脱落によるチーム敗北は、四人版の採用規則として自動的にコピーしません。
4. この開発文書の必須登録・transport・時計・ライフサイクル・保存互換・Web編集先、[構成文書](architecture.md)、[テスト方針](testing.md)。
5. [通常の五目並べ](rules/gomoku.md)の盤・棋譜・CPU・保存、[四人リバーシ](rules/four-reversi.md)と[四人将棋](rules/four-shogi.md)の席・モード・順位・時計・集計の実装と固定棋譜。Git履歴、五目並べ仕様PR [#149](https://github.com/yksw-clm/tetraboard-2026/pull/149)・実装PR [#151](https://github.com/yksw-clm/tetraboard-2026/pull/151)、基盤Issue [#56](https://github.com/yksw-clm/tetraboard-2026/issues/56)・[#57](https://github.com/yksw-clm/tetraboard-2026/issues/57)・[#58](https://github.com/yksw-clm/tetraboard-2026/issues/58)・[#59](https://github.com/yksw-clm/tetraboard-2026/issues/59)。
6. 正本が引用する[Gomocupの説明](https://gomocup.org/detail-information/)。連続5個以上の根拠に限って参照し、二人用の大会規定・連珠の禁手・開局規定を四人版へ追加しません。

**Constraints**

- 最新developから文書用の `docs/four-gomoku-spec`、実装用の `feat/four-gomoku` などのブランチを作り、PRで取り込みます。mainへの直接push・force pushはせず、マージ・本番公開は差分と確認結果への開発者承認後に行います。
- 既存のBun・TypeScript・React・HeroUI・Worker・Durable Object・D1を使います。純粋なルールエンジンとCPUを `packages/four-gomoku` に分離し、四人版の順位・チーム判定を通常版へ押し込みません。共通ルームの複製、将来用途だけの汎用化、新しい主要依存・外部サービスは追加しません。
- `four-gomoku` は定員4・モードありの専用契約にします。禁手オプションをUI・通信契約・ルーム設定へ追加しません。15路の着手と4色の状態を専用のゲーム型に対応付け、通常版や8路リバーシの契約へ読み替えません。
- 追加前の5ゲームのルール・通信・棋譜・認証・集計互換を保ち、未知IDを四人版へフォールバックしません。既存データの書換え・自動バックフィルは行いません。D1の既存保存・索引・再送を活用し、追加migrationが必要になった場合は目的と影響を明示します。
- 勝ち抜け、脱落、対局全体の終局を状態として区別します。確定済みの順位は後続イベントで上書きせず、手番・時計・CPU候補・席保持がそれぞれの状態に対応するようにします。途中の完成で終局保存・集計・再戦待機へ移行しません。
- サーバーを着手と結果の正本とし、局ID・更新番号・手番・期限・参加資格を照合します。期限処理とCPU計算時間の計時、候補適用前の再検証を共用し、古い着手・二重操作・古いCPU候補を拒否します。
- 再生規則は `rulesVersion: 1` として固定棋譜で初期・途中・最終状態を確認します。保存形式の版と再生ルールの版を区別し、開始時のモード・配席・チームで復元します。勝ち抜け・脱落・満盤を保存し、未知版・不正な順位や結果・途中局面の不整合を拒否します。
- ゲームカタログは軽量に保ち、ライブ・保存棋譜をゲーム別に遅延読み込みします。CPUはWorkerだけが読み込み、Webへ混入させません。新GameIdとprotocol・Worker・保存・Webの必須登録は整合した単位で追加します。
- CPU Lv1／Lv2の探索量と評価係数は実装時に測定して調整し、採用値を正本に記します。候補の絞込みをルール上の合法手なしとせず、ルール判定を探索予算で近似しません。モード・順位・レベル数など利用者向け仕様は測定を理由に無断変更しません。
- 戦績・ランキングは開始時4人とも人間の終局・保存済み対局をモード別に集計し、CPU戦は履歴・棋譜の保存対象とします。確定した集計方式は専用のゲーム別契約に登録し、既存ゲームのSQLの意味を変えません。
- 自動検証はBunの純粋関数、Bun＋happy-domの部品・hook、Worker統合テストへ集約します。ブラウザ起動型のテスト・設定・workflowは追加しません。実画面寸法・ネイティブ入力・実画像デコード・実音声は手動確認の結果か未確認理由を記録します。
- `bun run check` は180秒以内を目標に、CIで所要時間を記録します。基準PR #151のCI checkは215秒で目標を超えているため、既存の超過と今回の追加による影響を区別し、検証を省略せず結果を報告します。
- コード・設定の実装PR前には `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run` を成功させ、同じ対象コミットのGitHub CI成功を独立して確認します。コード・設定の修正やmain・develop取り込み後は必須検証を再実行します。

**Done When**

- 開発者が承認したルール・UI・初回範囲・集計がREADMEとルール正本へ反映され、実装と一致しています。新たな未決定事項や矛盾が見つかった場合は確認して解消し、推測した裁定を残していません。
- シングルスで15路・4色の循環手番、全4方向・盤端・両端が塞がれた連、5個／6個以上、勝ち抜け・外部脱落・最後の1人・満盤の順位を固定局面で確認しています。完成と脱落の混在、複数方向同時完成、手番外脱落、既確定者の後続イベントでも順位の重複・上書きがありません。
- ダブルスで味方2色の混色と同色の完成、相手色による分断、黒・赤対白・青と手番の対応、1人の脱落によるチーム敗北、満盤引き分けと最後の着手の完成優先を確認しています。
- 人間4人、人間とCPU、ゲストとアカウントの両モードで、作成・参加・招待・観戦・準備・開始・着手・投了・時計・切断復帰・再戦・閉鎖・チャット・スタンプ・個人設定が動作します。モード変更時の準備解除と前局保持、開始・再戦ごとの抽選を確認しています。
- CPUの両モードでの合法性、Lv1の制御可能な乱数、Lv2の自分／味方の完成・相手3人／相手チームの防御・脱落後の手番、同評価の決定性、入力不変、探索上限を確認しています。最低2秒待機、計算中の期限超過、古い候補の破棄をWorkerで検証しています。
- 途中の順位確定で全体を終了せず、全体の終局だけを一度保存します。保存失敗と再送・本人索引・重複防止・閉鎖後の保持を確認し、両モードの固定棋譜で初期・勝ち抜け後・脱落後・最終局面を再現します。再戦設定の変更、破損・未知版の拒否を検証しています。
- 紫テーマ・4カード・1回の交点操作・座標・直前手・完成した連・順位とチーム表示・前後とSelect・90度回転を検証しています。棋譜を戻して未来の順位や完成線を表示せず、途中の勝ち抜けで結果を自動表示しません。実機の押しやすさ・長い名前・4色の判別・6ゲームの横スクロールは手動確認の結果か未確認理由を記録します。
- シングルスの優勝・2〜4位の件数と率、ダブルスの勝敗、各モードのランキング、対人限定条件、CPU戦の除外と棋譜保存を確認しています。満盤の同順位は該当順位に加算し、同率1位も優勝数に含めます。ダブルスの引き分けを対局数と率の分母に含め、モード別タブ・マイページ・公開プレイヤー情報・最近の対局の条件が一致しています。
- ロビー・ゲーム選択・管理・計測・フィードバック・お知らせの登録がそろっています。6ロビーの紹介・初期HTML・title・description・canonical・サイトマップと配信を検証し、既定ゲームと他画面の検索除外を維持します。
- 既存5ゲームの固定棋譜・共通ルーム・認証・集計と、6ゲームの型対応・未知ID拒否・遅延読み込みを確認しています。README・開発・テスト・構成文書で現在仕様としてのゲーム数・一覧・CPU席数・実装済み範囲を更新し、過去の測定条件は対象コミットとともに保持しています。
- 必須ローカルコマンド、文書の整形・リンク・`git diff --check`、対象コミットのGitHub CIが成功しています。PRに検証対象コミット・実行環境・結果・check所要時間・未確認事項を記載し、差分と結果をレビューできます。マージ・本番公開・公開後の配信とSearch Console反映は、別途承認後の公開手順で確認します。

**コミット計画**

仕様確定は文書PR、実装は別PRとし、文書PRを取り込んだ最新developから実装を始めます。文書PR未取り込みの場合は依存する文書コミットを明示します。各実装コミットに関連テストを含め、最後まで検証を先送りしません。

| 順  | コミットメッセージ                                             | 主な内容・確認                                                                                                                                                            |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `docs: 四人五目並べの仕様と実装計画を確定する`                 | 今回の文書PR。README、ルール正本、本節へ確定仕様・4項目・計画を記載。文書の整形・リンク・差分と、同一コードの直前成功結果を確認                                           |
| 2   | `feat: 四人五目並べの基本ルールとシングルス順位を追加する`     | 独立パッケージ、15路・4色・着手・連、勝ち抜け・脱落・満盤・全順位確定と純粋関数テスト。公開カタログにはまだ登録しない                                                     |
| 3   | `feat: 四人五目並べの混色ダブルスと棋譜再生を追加する`         | チーム混色の連、チーム勝敗・脱落、両モードの規則版1の再生と固定局面テスト                                                                                                 |
| 4   | `feat: 四人五目並べのCPUレベル1とレベル2を追加する`            | 近傍ランダム、個人／チームの完成・防御・手番評価、探索上限。両モードの合法性・決定性・入力不変・処理量を確認し、採用値を正本へ追記                                        |
| 5   | `feat: 四人五目並べをオンライン対局と記録機能に統合する`       | protocol・Worker・Web・保存・集計の必須登録を同時追加。モード・時計・CPU・順位・再戦、紫のロビー・4カード・棋譜・ランキング・管理・SEOを接続。関連統合／DOM／型検証を追加 |
| 6   | `test: 四人五目並べの対局フローと既存ゲームの互換性を検証する` | 両モードの固定棋譜、勝ち抜けと脱落の混在、満盤、時計境界、保存再送、6ゲームの共通動作と既存棋譜・集計・配信の横断回帰を補完                                               |
| 7   | `docs: 四人五目並べの実装案内と検証範囲を更新する`             | 実装・テストへの入口、採用したCPU値、6ゲームの実装済み範囲を正本・開発・テスト・構成文書へ反映。対象コミット・検証環境・測定結果・未確認事項をPRへ記録                    |

GameIdを登録すると各層の型付き登録が必要になるため、5番で未対応の画面・保存契約・集計を残しません。差分が大きい場合は、公開登録前に準備できる内部部品を先行コミットに分けます。コミットの分割は実装の都合で調整できますが、承認済みの仕様・初回範囲・完了条件は変更しません。

## Local Development

リポジトリのルートで `bun run dev` を実行すると、WorkerのローカルD1マイグレーションを適用してからWebとWorkerの開発サーバーが同時に起動します。
どちらもLANから接続できます。

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。ポートは `/5173` ではなく `:5173` とし、例は `http://192.168.68.52:5173/` です。LANのHTTPでは `crypto.randomUUID()` が利用できないため、WebのUUID生成は `shared/createUuid.ts` の `crypto.getRandomValues()` によるUUID v4を使います。フィードバック送信ID、アクセス解析ID、スタンプのrequestIdで共用します。HTTPS限定APIを使う機能は、個別に対応可否を判定します。
通信の確認にはWorkerの `/healthz` を使います。ロビー画面にはAPIステータスや生のAPI応答を表示しません。
開発機からは `http://127.0.0.1:8787/healthz` でWorkerを直接、Viteの `Network` URLに `/api/healthz` を付けてWeb経由の通信を確認できます。

規約・年齢条件の確認後、作成と入室のHTTPリクエストに `X-Legal-Consent: 2026-10-12` を付けます。版は `packages/protocol/src/privacy.ts` の `legalVersion` と一致させます。

ルーム作成は `POST http://127.0.0.1:8787/rooms` に `{"name":"てとら","quickPlay":false,"mode":"singles"}` をJSONで送ります。`mode` は `singles` または `doubles` の必須項目です。成功応答の `room.id` に含まれる5桁のIDを使い、`GET http://127.0.0.1:8787/rooms/<ID>` で保存した部屋を確認できます。Workerを再起動した後も同じIDで取得できます。開発時のDurable ObjectとD1の状態は `apps/worker/.wrangler/state` に保存されます。D1だけを準備する場合は `bun run --cwd apps/worker db:migrate:local` を実行します。
既存ルームへの入室は `POST http://127.0.0.1:8787/rooms/<ID>/players` に `{"name":"二人目"}` をJSONで送ります。作成・入室の成功応答は `{ "room": ..., "membership": { "playerId": ..., "role": ..., "token": ... } }` です。満室なら409を返します。本人確認は `GET http://127.0.0.1:8787/rooms/<ID>/me` に `Authorization: Bearer <token>` を付けて行います。トークンは公開GETやWebSocketの応答には含めません。
Webの `/` は総合ロビーを表示します。四人リバーシ専用ロビーで「ルームを作る」「ルーム番号で参加」などを押すと、入力ダイアログを開きます。ニックネームなどを入力して確定すると、`/rooms/<ID>` に移動します。ルームページはGETで保存済みの情報を確認してから表示し、WebSocket接続後に受信したルーム情報と接続状態を表示します。別の画面からの入室もWebSocketで反映します。ページを再読み込みしても同じルームを取得できます。接続が切れた場合はGETで状態を再取得してから再接続します。開発機のブラウザで確認後、スマートフォンでもViteの `Network` URLから同じルームURLを開いて確認します。
作成・「すぐ遊ぶ」のダイアログでシングルス・ダブルスを選択します。初期値はシングルスです。「すぐ遊ぶ」を確定すると、選択したモードでホストは準備完了、CPU 3体は作成時に選んだレベル（省略時はLv1）で待機します。ホストが「対局開始」を押した後、CPUの各手番は最低2秒待ってから自動で進みます。通常の待機部屋では、ホストがCPUの追加・削除・レベル変更とモード変更を行えます。モード・時間設定の変更時は人間全員の準備状態を解除します。人間とCPUの合計が4席で、接続中の人間全員が準備完了なら開始できます。設定変更と自動着手はWebSocketのルームスナップショットで他の画面へ反映されます。
同じタブで再読み込みすると、保存した参加資格をサーバーで確認してホスト・プレイヤーの区分と「[あなた]」を表示します。別の独立したタブから資格なしで通常URLを開いた場合は観戦者として表示し、空席のある待機中なら状況カードから参加できます。
ホスト・プレイヤーのWebSocket接続は、接続後に資格トークンを送って認証します。認証後の「準備完了」「準備取消」はWebSocketメッセージで送信し、Durable Objectが本人の状態を保存して全接続へ最新のルーム情報を配信します。別のタブで同じ部屋を観戦し、表示が更新されることを確認できます。GET、再読み込み、Worker再起動後も準備状態を取得できます。観戦者や無効な資格では準備状態を変更できません。
四人リバーシの着手を確認するには、4つの独立したタブで同じルームへ入室し、全員が準備完了にします。ホストが「対局開始」を押すと担当色がランダムに割り当てられ、黒の担当者が盤面のC4をクリックできます。座標は左上A1が `{x:0,y:0}` で、C4は `{x:2,y:3}` です。Durable Objectが `packages/four-reversi` で合法手を判定し、更新した盤面と手番を全接続へ配信します。`bun run test` でエンジンの判定を確認できます。
四人リバーシのエンジンは、シングルス・ダブルスの自動パス、終局、石数と順位・勝敗の確定、脱落色を飛ばす進行を扱います。ルームは保存したモードで開始し、エンジンが終局したら前局の最終盤面と結果を保持して自動で待機状態へ戻ります。Webは最終局面から棋譜モードになり、「←」・Select・「→」で開始局面や着手・パス・脱落へ移動できます。前局の結果は「結果」ボタンでダイアログ表示します。人間のReadyを改めて揃え、ホストが次の対局を開始します。
公開ロビーは `/games/four-reversi` で表示します。`GET http://127.0.0.1:8787/rooms` はD1索引から更新時刻の新しい順に20件返し、続きは応答の `nextCursor` を `?cursor=` に指定して取得します。参加ダイアログではゲストはニックネームを入力し、ログイン中はプロフィールを確認します。観戦は入力なしでルームページを開きます。終局後は対局前として一覧に表示されます。索引の反映が遅れた場合も、参加と観戦の可否はGameRoomが判定します。今回より前に保存したローカルルームは新しい索引へ移行しないため、動作確認には新規ルームを使用します。本番D1 `tetraboard-2026-prod-db` は作成済みです。`wrangler.jsonc` の `env.production` に本番用IDを設定し、トップレベルのローカル用IDは置き換えません。本番のマイグレーションは初回公開時にCDから適用します。
4つの独立したブラウザタブで1人ずつ入室・準備完了し、ホストが開始した後、各手番の担当タブで合法手を選び続けると、終局後の再戦待機画面に同じ結果が全タブで表示されることを確認できます。1タブを再読み込みしても同じ結果が表示されます。
ルーム内チャットは認証済みのプレイヤーが送信し、観戦者も閲覧・通報できます。投稿とシステムログは合計100件を上限に再接続後も復元します。運営者APIのローカル確認では `apps/worker/.dev.vars.example` を参考に、追跡対象外の `.dev.vars` に `MODERATOR_TOKEN` を設定します。`GET /admin/reports` と `POST /admin/reports/:id/actions` にその値をBearerトークンとして渡します。通報データのマイグレーションは通常の `bun run dev` 時にも適用されます。期限切れ通報は毎時の定期処理で削除されます。
待機中の退室では席が解放され、ホストが抜けると最も早く入室した人へ役割が移ります。対局中は自分の手番で投了でき、退室や30秒の切断期限切れ、持ち時間切れでも脱落します。再読み込み・再接続が期限前なら同じ参加資格で復帰し、期限後は閲覧のみできます。対局はルームの持ち時間・秒読み設定で進み、初期設定は各人5分＋1手30秒です。GETの応答は `{ "room": ..., "presence": { "hostPlayerId": ..., "connectedPlayerIds": [...] }, "serverNowMs": ... }` で、WebSocketの `room.snapshot` にも接続情報と送信時のサーバー時刻が含まれます。接続情報は認証済みソケットから算出し、脱落後の切断・復帰も配信します。Webはこの時刻を基準に残り時間を表示します。復帰期限と時計の期限にはDurable Object Alarmを使い、Workerテストではアラームと保存済み期限を操作して確認します。以前のエンジン状態で保存されたローカルルームの移行は行わないため、進行確認には新規ルームを使用します。

招待リンクはルーム情報の「ルームを共有」で開くダイアログから取得します。`/rooms/<ID>?invite=<instanceId>` を資格のない別タブで開くと、空席のある待機中ルームでは参加ダイアログを自動表示します。閉じれば観戦でき、状況カードから再度参加できます。参加時は `POST /rooms/<ID>/players` のJSONに `instanceId` を追加し、WebSocketは `/rooms/<ID>/ws?instanceId=<instanceId>` へ接続します。識別子が不正なら400、不一致なら410を返します。従来の識別子なしリクエストも受け付けます。コピーAPIが使えないLAN上のHTTPなどでは、同じ共有ダイアログのURL欄と失敗案内から手動コピーできます。共有ダイアログ・X募集・OGPの実装は [ルーム共有の実装計画](#ルーム共有の実装計画) を参照します。

## Checks

ルートで `bun run check` を実行すると、整形確認、lint、全Workspaceの型チェック、6ゲームのエンジン、Worker、Web・Adminの表示ロジックのテストを実行します。`bun run test` では6エンジン・Worker・Web・Adminのテストを実行します。WorkerのテストはCloudflare Workers実行環境でDurable ObjectとWebSocketを検証します。

GitHub Actionsは `main`・`develop` へのpushと両ブランチ宛てのPRで整形・lint・型チェック・テストに加え、本番・開発それぞれのWeb・AdminのビルドとWorkerデプロイのdry-runを実行します。CIでは `bun install --frozen-lockfile` を使用します。コミット前フックも `bun run check` を実行します。

Workerテストは `vitest.config.mts` でローカルのD1・R2・SQLite対応Durable Objectとテスト専用のbindingsを指定します。追跡済みWrangler設定はJSONCとして入口・互換日・互換フラグだけを読み、Wranglerの開発用設定ローダーを通しません。管理者はテストごとに指定し、開発用 `.dev.vars`・`.env` やプロセスの秘密設定を取り込みません。詳細と回帰検証は [個人設定からの分離](testing.md#個人設定からの分離) を参照してください。

Workerの `typecheck` は `bun run cf-typegen` を呼び、型生成の入力を追跡済み `.dev.vars.example` に固定します。`--env-file` とコマンド内の `CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=true`・`CLOUDFLARE_INCLUDE_PROCESS_ENV=false` により、個人設定から型のキーを推定しません。設定例には秘密値を記載せず、秘密設定のキーを追加・削除するときは同じ変更で更新します。生成ファイルは従来どおり追跡対象外です。

Workerの `gameBoundary.test.ts` は公開 `/api` の作成・一覧・本人の履歴・戦績で、game省略のリバーシ互換、明示した両ゲームの分離、未知ID・空文字の拒否を検証します。`commonRoomBehavior.test.ts` は同じシナリオを6ゲームへ適用し、待機中の参加・観戦・準備・資格認証・接続復帰・チャットを実HTTP／WebSocketで確認します。関連テストだけを実行する場合は `bun run --cwd apps/worker test test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` を使います。共通fixtureは公開応答と対象IDに一致する通知を待ち、テスト終了時に席・資格・ソケットを解放します。

### PR提出前の検証

コード・設定変更では、PRを作成する前にルートから次の全コマンドを成功させます。

```sh
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
bun run build:development
bun run --cwd apps/worker deploy:dry-run:development
```

自動検証はBunの純粋関数テスト、Bun＋happy-domの部品・hookテスト、Worker統合テストへ集約します。ブラウザ起動・画面寸法・ネイティブ入力・実画像デコードの検証とレポート生成は廃止します。`bun run check` の目標は180秒以内です。[テスト方針・移管対応表](testing.md)に実行環境と各検証の対応を記載します。

PR本文には検証対象コミット、実行環境、各コマンドの結果、未確認事項を記載します。PR提出後にコード・設定を変更した場合と、main・develop取り込みでコード・設定が変わった場合も上記の必須コマンドを再実行して結果を更新します。文書だけの変更では同一コード・設定の直前の成功結果を再利用できますが、検証済みコミットを明記し、文書の整形確認と `git diff --check` は最終差分で行います。マージはGitHub CI成功、必須のローカル検証成功、差分と結果に対する開発者の承認を条件とし、ローカル成功でGitHub CIを代替しません。

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

ゲームIDの正本は `packages/protocol/src/games.ts`、具体型の対応は型専用の `gameTypes.ts` です。`RoomFor<G>`・`MatchFor<G>`・`ActionFor<G>` と着手コマンド型でゲームを対応付けます。将棋と五目並べの着手には局IDとrevisionが必須、リバーシの石置きには付けません。通信スキーマによる実行時検証も継続します。

ゲーム追加時にはprotocolの型対応と `gameRankingContracts`、Workerの `waitingRoomFactories`・`rankingReaders`、Webの `createRoomRequests`・`lobbyRoutes`・`liveViews`・`replayLoaders`・`replayViews` を登録します。各表は `GameId` のmapped typeと `satisfies` で検証します。異なるRoom／Matchを渡す入口はゲームで判別するunionを明示的に分岐し、残りを `assertNever` で確認します。カタログへエンジンやスキーマを追加しません。

Webはstrict型検査を使います。`bun run --cwd apps/web typecheck` とWorkerのtypecheckは型検査専用fixtureを含み、登録漏れ・ゲーム取り違え・局面情報や棋譜フレームの欠落を `@ts-expect-error` で確認します。境界の確認は `bun run --cwd apps/worker test -- gameBoundary.test.ts commonRoomBehavior.test.ts rankingBoundary.test.ts` と `bun run --cwd apps/web test` で実行します。

ライブのsession／viewと保存棋譜の前処理／viewはゲーム別に遅延読み込みします。共通カード・名前・席順・時計表示はエンジン実装に依存しません。Webビルドは生成チャンクの静的依存を検査し、別ゲームのエンジン参照、入口へのライブ・棋譜処理の混入、CPU実装の出力を拒否します。Rolldownが残す空モジュールのregionとReact Compilerの共通runtime初期化は実装として数えません。検査結果は追跡対象外の `apps/web/node_modules/.tmp/game-chunks.json` に保存します。WASMは同一originのasset URLと出力バイナリをビルド時に検査します。PR前の全コマンドは上記の順番で実行します。

## 共有transportとゲーム別session

`useRoomTransport` は通信契約の解析、Roomの型ガード、認証・準備・チャット・再接続と送信待ちの管理を担当します。開始待ちとゲーム操作待ちは内部の判別unionで区別します。`gameSessionTypes.ts` はゲームIDに待機データと固有設定コマンドを対応付ける型だけの表です。将棋の着手・提案待ちは局IDとrevisionを必須にし、リバーシの固有設定コマンドは `never` にします。

各sessionは、具体的なRoomと待機データを受け取る `fourReversiSessionBehavior.ts`／`fourShogiSessionBehavior.ts` の純粋な完了判定と固有エラー文言をtransportへ渡します。判定関数はモジュールで定義し、再描画でWebSocketを張り直さない参照にします。開始待ちは対局開始、リバーシの着手待ちは手数の増加、将棋の着手待ちはrevision増加・局変更で解除します。投了は本人の脱落を確認します。将棋の提案・取消は状態反映も確認し、待機への移行・エラー・送信失敗・切断での既存解除条件を維持します。

提案の送信は各将棋session、入玉宣言は通常将棋session、表示は各ゲームviewが担当します。`RoomViewShell` へ任意の `turnActions` を渡して共有の状況カードへ配置し、リバーシは渡しません。三人攻撃禁止と五目並べの禁手設定は共通の `RoomSettingsDialog` がゲームIDに応じて表示し、一括設定コマンドで送信します。設定値の検証とゲーム進行への適用はサーバーが担当します。時計計算・表示と手番への対応、WorkerのGameRoom・CPU・Alarm・ライフサイクルの分離は #57、保存形式・棋譜互換・戦績SQL・保存再試行は #58 の範囲です。

`roomSession.test.tsx` と `sessionBehavior.test.ts` は通信境界と状態モデルを使い、開始・着手・投了・提案の待ち保持と解除、本人と他人の脱落、同revisionでの提案反映、新局・終局、設定権限を確認します。サーバーでの配信・準備解除はWorker統合テスト、型の取り違えと局面情報欠落の否定ケースは `bun run --cwd apps/web typecheck` で確認します。

### ページ離脱・表示復帰と応答期限

共有transportは `pagehide` とReact cleanupでソケット・再試行・取得・応答待ちを停止します。履歴キャッシュに残るページでは停止と破棄を区別し、`pageshow` でルームGET・本人確認・再接続を行います。単なる非表示ではソケットを維持し、表示復帰時にGET・本人確認・既存ソケットの再認証を行います。同期・認証中は操作を止めます。取得と接続の世代を照合し、終了通知が遅れた旧ソケットと中止したGETの結果は採用しません。取得応答より新しいWebSocket通知がある場合は、その状態を保持します。

ルームGET・本人確認・接続開始・認証・準備・設定・開始・対局操作・チャットに各10000msの期限を設けます。操作の完了条件を満たさない通知では期限を延長・解除せず、設定は送信した値やCPU席の反映を確認します。期限超過はclose通知を待たずに接続を無効化し、全待ちを解除して、既存の1秒から最大30秒のバックオフで再取得・再接続します。結果不明の操作は再送しません。チャットは本人の同内容の新規投稿で完了し、切断では入力を保持します。表示復帰では経過した期限も確認します。サーバーの切断検知後30秒の復帰期限・複数本人接続の扱いは維持します。

`roomTransportLifecycle.test.tsx` は両ゲームの離脱・履歴復帰・10秒境界、終了通知の遅延、無関係な通知、未応答GET・本人確認、旧取得結果の破棄、未確定着手・設定・チャットを確認します。WebSocketの状態と通知タイミング、fetchと時計は既存の境界で制御します。Workerの `roomDeadlineBoundary.test.ts` は両ゲームの最後の本人接続の終了を確認し、既存の復帰・脱落・席解放テストも実行します。ブラウザ履歴キャッシュの実際の使用・ネイティブURL移動・モバイルの強制終了はDOMテストでは確認せず、手動確認の結果または未確認としてPRに記載します。`pagehide` が発火しない終了とclose通知がサーバーへ届かない場合の一定時間内検出は保証しません。

## ルームのスタンプ

固定6種類のID・絵文字・名称と通信スキーマは `packages/protocol/src/stamps.ts` に置き、ゲームエンジンには依存させません。GET `/rooms/:id?stamps=1` の `stampsSupported: true` を確認したWebだけがWebSocketにも `stamps=1` を付けます。再接続のGETで対応を確認し直し、旧Workerでは入口を表示しません。GameRoomは既存の戦型解析タグ・認証attachmentを保持し、`room-stamps-v1` の接続だけに新しい通知を配信します。

`room.stamp.send` はルーム世代、送信ごとのUUID `requestId`、スタンプIDを送ります。`room.stamp.received` はサーバー発行の通知ID、同じ世代とrequestId、送信者ID、スタンプID、受理時刻を返します。拒否は `room.stamp.error` でrequestIdと理由を返し、連打制限には `interactionAvailableAtMs` を添えます。対応接続の認証応答にも本人の送信再開時刻を含めます。

Workerは既存の期限処理後に世代・人間の在室資格・種類・送信停止を検証し、既存の `last-chat-at:<playerId>` をチャットと共用して3秒に1件へ制限します。検証、送信時刻、部屋の最終活動時刻を同じDOトランザクションで確定するため、複数タブとDO再作成にも制限が残ります。スタンプ本体は保存せず、時計・CPU予定を変更しません。受理後は既存の期限選択でAlarmを更新し、本人を含む対応接続へ通知します。

共通transportはスタンプの10秒の応答待ちを他の操作と分離し、requestIdが一致する通知・エラーで解除します。期限超過は既存の復旧経路へ移り、自動再送しません。本人のチャット・スタンプ受理と認証応答から共通の送信再開時刻を更新します。非表示・同期中・旧接続の通知は演出へ渡さず、同じ通知IDを再演しません。

`RoomViewShell` の `useRoomStamps` とContextで送信者ごとの最新1件と3秒のタイマーを共有し、`PlayerCardView` がプレイヤーIDで参照します。画像は再マウントせず、アバター内に黒50%のレイヤーと絵文字を重ねます。席削除・次局・切断・退室・閉鎖・非表示・離脱で破棄し、Contextのない保存棋譜には表示しません。状況カードの38pxボタンは、絵文字だけを3列・2行に並べる非モーダルPopoverを開き、選択・外側操作・Esc・フォーカス離脱と手番・ダイアログ・接続の切替で閉じます。開閉ボタンはPopoverのblurによる閉鎖対象から除外し、フォーカス移動で閉じた直後のpressで再び開くことを防ぎます。表示設定とブラウザ保存は #121 の範囲です。

部分検証は `bun run --cwd apps/worker test test/roomStamps.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomStamps.test.tsx` を使います。

## 表示・サウンド設定

2026年10月10日、開発者の指示により仕様と実装目標を確定しました。仕様の正本は[READMEの表示・サウンド設定](../README.md#表示サウンド設定)です。設定UI・ブラウザ保存はWeb側で実装し、Worker・ゲームエンジン・通信契約は変更しません。

`shared/browserSettings.ts` のページ共通ストアがlocalStorageの初期読取・項目単位の検証・最新値との合成書込・storage／pageshow／visibilitychangeの同期を扱います。保存できない変更は別に保持し、古い保存値による取消を防ぎます。React側は `useBrowserSettings` の `useSyncExternalStore` で同じsnapshotを購読します。

`shared/ui/BrowserSettings.tsx` の設定ボタン・スイッチ・保存補足をヘッダー、ルーム情報、保存棋譜、スタンプパネルで共用します。ルームは `RoomViewShell` の既存ダイアログ状態に設定を追加し、結果自動表示・スタンプパネルとの競合を抑止します。`RoomInfoCard` の見出し行に24pxのボタンを収め、行・カードの高さを維持します。パネルの幅は244pxを基本とし、6種類の選択を3列2行で中央に残し、その下へ表示設定を置きます。送信制限とパネルを開く操作を分離し、送信待ち・制限中でも設定を変更できます。

音声はストアの初期値・購読を既存 `SoundPlayer.setEnabled` へつなぎ、OFF中はAudioContextの有効化も行いません。スタンプは表示を即時に空へ切り替え、共有ストアの購読でタイマーと演出を破棄します。受信時には最新の設定を参照し、transportの通知ID消費・重複抑止を継続します。

部分検証は `bun test --cwd apps/web ./test/browserSettings.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/browserSettings.test.tsx ./test-dom/roomStamps.test.tsx ./test-dom/soundPlayer.test.ts ./test-dom/clockWarning.test.tsx` を使います。寸法比較・スクリーンショット用の一時的な表示確認はリポジトリの自動テストへ追加しません。

**Goal**

全6ゲームで「効果音」「カード上のスタンプ表示」を初期値ONの個人設定として提供し、対局中・観戦中も即時に変更できるようにします。同一ブラウザ・オリジンでゲストとログインユーザー共通の保存・復元・別タブへの反映を行います。ルームではPC右上のルーム情報・設定エリア、スマートフォン・タブレットでは「ルーム」タブ内を入口とし、設定ボタンの追加・開閉・切替によって盤面・カード・持ち駒・状況カード・棋譜操作欄・タブの配置と寸法を変えません。音と演出の停止・再演防止を検証し、必須ローカル検証とGitHub CIが成功したレビュー可能な実装PRを提出します。

**ContextProviders**

参照の優先順位は次のとおりです。資料間の矛盾を推測で確定せず、承認指示と正本で解消できない事項は開発者へ確認します。

1. 開発者の承認・変更指示。この変更では既存の2項目の提案を確定する指示、ルームにヘッダーを追加せずスマートフォンの「ルーム」タブ・PC右上へ入口を置く指示、カードなどのレイアウトを崩さない指示を含みます。
2. [AGENTS.md](../AGENTS.md)のブランチ・コミット・仕様更新・承認・検証ルール。
3. [README.md](../README.md)の表示・サウンド設定、ルーム画面、効果音、時間切れ5秒前の通知、チャットとスタンプの共通仕様。ゲームルールは変更しません。ゲーム固有の境界を確認する場合だけ各ゲームのルール正本を参照します。
4. 本書の共有transport・ルーム効果音・スタンプ・共通UIと、[testing.md](testing.md)の検証環境・手動確認の範囲。
5. [#121](https://github.com/yksw-clm/tetraboard-2026/issues/121)、効果音の[#85](https://github.com/yksw-clm/tetraboard-2026/pull/85)、スタンプの[#130](https://github.com/yksw-clm/tetraboard-2026/pull/130)、時計音の[#136](https://github.com/yksw-clm/tetraboard-2026/pull/136)、Git履歴。旧Issueの「7種類」より、開発者の最終指示を反映したREADME・PRと現行の6種類を参照します。
6. `shared/soundPlayer.ts`・`soundEffects.ts`、`roomSoundEvents.ts`、`clockWarning.ts`・`useRoomTransport.ts`、`useRoomStamps.ts`・`RoomStampPicker.tsx`、`RoomInfo.tsx`・`RoomLayout.tsx`・`RoomViewShell.tsx`、`AppHeader`・`AppDialog`、既存音声・時計・スタンプのBun／happy-domテスト。
7. 必要な場合のWeb Storage・storageイベント・Web Audio・自動再生制限の公式資料。ブラウザの制限から新しいプロダクト仕様を推測で追加しません。

**Constraints**

- 全6ゲーム・四人ゲームの両モード、ゲスト・ログインユーザー、ホスト・参加者・観戦者で同じ個人設定を使います。初期値は2項目ともONで、自分のタブの音・演出だけを制御し、他の閲覧者の設定を変更しません。同一ブラウザ・オリジンの別タブにだけ保存済みの変更を反映します。
- ルームの既存の1280px境界に従い、PCでは右上のルーム情報・設定エリア、1279px以下では「ルーム」タブ内へ入口を置きます。ホスト専用の「ルーム設定」から独立させ、対局中・観戦中・認証確認中・通信切断中も個人設定を変更できます。ルームへヘッダー・新しいタブ・状況カードの操作行を追加しません。
- 設定ボタンと設定の開閉・切替で、盤面・プレイヤーカード・持ち駒・状況カード・棋譜操作欄・タブの位置と寸法を変えません。ルーム情報の既存見出し行の右側へ、読み上げ名付きの歯車アイコンボタンを収め、新しい行を追加せず、見出し行・ルーム情報カードの高さ、本文・既存操作の位置を維持します。PCの列幅・左右列の独立した高さ・右列のスクロールと、スマートフォンの状況カードの高さを維持します。既存の名前・ゲーム名・ルーム番号・主要操作を隠したり、カードや文字を縮小して入口を収めたりしません。スタンプパネル内の設定はオーバーレイ内に収めます。
- 共通のHeroUIベースのボタン・ダイアログ・スイッチを使い、読み上げ名・現在値・キーボード操作・閉鎖後のフォーカス復帰を用意します。ダイアログはゲームのテーマと既存の閉じる操作・背景ぼかしを共用し、スタンプパネルとの二重表示や結果自動表示の競合を防ぎます。設定で時計・手番・通信を停止しません。
- Web側に共有設定ストアを置き、画面・入口ごとに別の設定状態を持ちません。保存キーは `tetraboard:settings:v1`、値はJSONの `soundEnabled`・`stampsVisible` の真偽値とします。未保存・不正JSON・非オブジェクトは両方ON、項目欠落・真偽値以外はその項目だけONとします。保存済みOFFは音声・スタンプの初期化前に適用します。
- 書込時は最新の保存済み値と変更項目を合わせ、他の項目を古いタブの値で上書きしません。変更したタブはストア購読で即時反映し、別タブは対象キーのstorageイベントで反映します。復帰時にも保存済み値と同期します。ただし、保存失敗後のメモリ内の変更は古い保存値の再読取だけで取り消しません。保存領域の読取・書込例外は捕捉し、現在のタブのページ存続中は変更を維持します。保存できない場合は設定内の補足を表示し、次回の保存成功で解除します。別タブの同時書込に厳密なトランザクション保証は追加しません。
- 共通設定から既存の `SoundPlayer.setEnabled` に接続します。OFFでは再生中・予約中の6種類すべてを停止し、ONでも過去のイベントや停止途中の音を再演しません。比較基準・joinの重複抑止・本人着手の重複抑止・時計の通知済み記録を設定切替で解除しません。時計音の5秒以下でのONは通知済み相当、時計の視覚的強調は設定から独立です。
- `useRoomStamps` と共有Contextに表示設定を接続し、OFF時は表示中演出・タイマーを破棄します。OFF中も通知IDの重複抑止を維持し、ONに戻しても再表示しません。送信機能・送信間隔・送信停止は設定から独立させ、全体ONと送信者非表示を併用します。パネル内での設定切替は送信・パネル閉鎖を起こさず、送信待ち・送信制限中も利用できます。
- 最初のユーザー操作による音声有効化、単一AudioContext、ambient、端末の消音設定、音声失敗時の操作継続を維持します。ONへの操作で有効化を試み、復元・別タブ同期だけではユーザー操作を代替しません。確認音・音量・音ごとの設定・時計音専用設定・演出軽減の追加設定・スキン・プレミアム・端末間同期・複数タブの再生担当選出を追加しません。
- Worker・ゲームエンジン・サーバー時計・通信契約・チャット履歴・棋譜・対局保存・アカウントを変更せず、依存ライブラリ・外部サービス・DBマイグレーションを追加しません。
- 自動検証はBunの純粋関数、Bun＋happy-domの部品・hookと既存Worker統合テストに集約します。ブラウザ起動型の自動テスト・設定・workflowは追加しません。画面寸法・ネイティブ入力・実音声デコード・絵文字やCSSの実描画は手動確認します。`bun run check`の目標は180秒以内です。

**Done When**

- 共通ヘッダーのある利用者向け画面、全6ゲームのPC右上・スマートフォン／タブレットの「ルーム」タブ、スタンプパネルから同じ設定を変更でき、ゲスト・アカウント・ホスト・参加者・観戦者と、待機・対局・再戦待機の各状態で利用できます。認証・通信・送信制限によって個人設定を不必要にロックしません。
- 保存済みOFFでの作成・参加・観戦・再読み込み・再入室では、最初の音・スタンプが一瞬だけ発生することもありません。ゲーム切替・ログイン／ログアウト・アカウント切替で値を保ち、未保存・不正JSON・項目単位の不正値は定義した初期値へ戻ります。
- 効果音OFFで参加・CPU追加・着手・開始・終了・時計音を停止し、最終着手後に予約された終了音も破棄します。OFF中のイベント、再生途中の音、5秒以下でONへ戻した時計音を再演しません。5秒より多い状態でONへ戻した後の5秒到達、新しい手番・次局では通常どおり通知し、時計の強調はOFFでも維持します。
- スタンプ表示OFFで全員の表示中演出・タイマーを即時解除し、OFF中・重複・過去の通知をON後に再演しません。本人の送信、他の閲覧者の演出、既存の送信者非表示、チャットの履歴不変と送信制限を確認します。パネルと共通設定の表示値が常に一致します。
- storageイベントによる別タブ反映と復帰時の同期、他の項目の保持、保存キーの削除、保存領域の読取・書込失敗を検証します。失敗しても現在タブの画面移動・再入室で変更を保持し、保存補足の表示・解除を確認します。同期で音声有効化を代替したり、見送った音・スタンプを再演したりしません。
- ダイアログとパネルのキーボード操作、読み上げ名・現在値、Esc・閉じる操作・フォーカス復帰、スタンプとの二重表示防止、結果自動表示との競合、通信・時計の継続をDOM／hookテストで確認します。音声未有効化・未準備・中断・再生失敗でも操作が継続します。
- 全6ゲームを320×640、390×844、768×1024、1279×900、1280×800で手動確認し、1280px境界の前後、四人ゲームの両モード、対局者・観戦者、待機・対局・再戦待機で入口の追加前後と開閉・切替時の寸法と位置が不変です。盤面・プレイヤーカード・持ち駒・状況カード・ルーム情報カードと見出し行・棋譜操作欄・タブ、ゲーム名・ルーム番号・主要操作を確認します。通常将棋で投了・持将棋・入玉宣言・スタンプが並ぶ状態も維持します。ルーム情報エリアとスタンプパネルの入口は画面内に収まり、文字・操作が重なりません。
- PC、iPhone Safari、Android Chromeで実音声のON/OFF・途中停止、初回操作とON操作での有効化、消音・他アプリ音声との併用・背景復帰、タッチ・フォーカス・スタンプの実表示を手動確認します。端末・OS・ブラウザの版と結果、未確認事項を記録します。
- 実装PRの対象コミットに対して `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run` が成功し、GitHub CIも成功します。既存の全ゲーム・Worker回帰を維持し、README・本書・検証文書を同じ変更で更新します。PRに対象コミット・実行環境・各結果・手動確認と未確認事項を記載し、マージ・公開は差分と確認結果に対する開発者の承認後に行います。

## ルームの共通効果音

添付された6種類のMP3を `apps/web/src/assets/sounds/` に保持し、Viteのasset URLで同一originから配信します。`shared/soundEffects.ts` のページ共通プレイヤーはロビー・ルームで音源を先読みし、ユーザー操作のcaptureでambientの設定、単一AudioContextの作成・resumeを非同期操作より先に実行します。Web Audio未対応時には代替のHTML音声再生を使いません。デコード済み音源を再利用し、非表示・切断・ルーム離脱では再生中・予約中の音を停止します。音声の失敗はゲームのエラーへ伝播しません。

`RoomSoundTracker` は共有transportの各スナップショットを受信順で比較します。各sessionからゲーム別の純粋な音声状態の読取りを渡し、着手は手数、開始・終了は状態遷移、参加・CPU追加は新しい席IDで判定します。将棋のrevisionだけの変化と棋譜表示は着手にしません。終局の最終着手はlastRoundから検出します。リバーシの公開中の局IDはないため、同一接続内の開始・終局で局を区切り、接続・可視状態の切替で比較基準を破棄します。非表示からの復帰時は共有の状態再取得で最新状態を基準にし、その基準時刻以前に送信されたWebSocket通知は音声の比較へ戻しません。再取得失敗時は通信の復旧経路へ移り、再接続時に基準を作り直します。

本人の合法手の送信成功時に着手音を再生し、局・期待手数・担当色／方向・着手内容が一致した通知だけを抑止します。拒否・切断・終局・次局開始で抑止を解除します。HTTP参加成功とWebSocketの新規席通知は部屋世代・プレイヤーIDでjoinを重複抑止し、新規参加と既存資格の再利用を参加処理の返値で区別します。参加者へ切り替わる再マウントでは再演しません。公開通信契約・Worker・エンジン・保存形式は変更しません。

部分検証は `bun test --cwd apps/web ./test/roomSoundEvents.test.ts ./test/roomInvitation.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomSounds.test.tsx ./test-dom/soundPlayer.test.ts` を使います。音声API・時刻・取得を制御し、実デコード・ネイティブ操作・他アプリとの同時再生は自動テストに含めません。マージ前にiPhone Safari／Android ChromeでYouTubeとの同時再生、初回有効化、消音モード、スピーカー・イヤホン、アプリ切替からの復帰を実機確認し、端末・OS・ブラウザの版と結果を記載します。

### 時間切れ5秒前の通知（#131）

仕様の正本は[READMEの時間切れ5秒前の通知](../README.md#時間切れ5秒前の通知)です。時計音と強調は実際の期限まで5秒以下を共通の境界とします。

`clockWarning.ts` は最終期限・手番の担当者とカウントIDを読み取り、通知済み記録を最大64件で保持します。共有transportは受理したスナップショットと既存の250msの時計更新から判定し、同期・認証後の基準が5秒以下なら見送ります。手番開始・手数・局・部屋世代でカウントを区別し、将棋のrevisionや引分提案だけでは変えません。`roomClockPresentation.ts` は手番中の最終期限を直接比較して強調し、基本時間と秒読みの表示形式は維持します。

`SoundPlayer.playClock` は既存のAudioContextとデコード済み音源を使い、時計音を識別して最大5秒・残り時間までの停止を予約します。時計音だけの停止は着手音・終了音を切りません。時刻の同期更新でも最初に予約した再生上限を越えず、AudioContextの中断で破棄します。`setEnabled` と可用性変更の購読は#121の共通設定との接続境界であり、この変更では設定UI・ブラウザ保存を追加しません。

部分検証は `bun test --cwd apps/web ./test/clockWarning.test.ts ./test/timeControl.test.ts ./test/roomPresentation.test.ts ./test/fourShogiRoomPresentation.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/clockWarning.test.tsx ./test-dom/soundPlayer.test.ts ./test-dom/roomSounds.test.tsx` を使います。全6ゲーム・四人ゲームの両モード、時間構成・5秒境界・再戦・同一人物の連続手番、送信・停止・復帰・OFF/ON・中断・失敗を確認します。検証対象コミット・必須コマンドとCIの結果・実機確認の実施状況はPR本文に記録します。

**Goal**

全6ゲームの本人手番で、実際の時間切れ5秒前に添付の時計音を最大1回再生し、プレイヤーカード・状況カードの時計を同じ5秒境界で強調します。着手・終局・復帰時の不要な音を防ぎ、既存効果音・対局進行を維持した実装を、必須ローカル検証とGitHub CIが成功したレビュー可能なPRとして提出します。

**ContextProviders**

参照の優先順位は次のとおりです。資料間の矛盾・仕様追加が必要な場合は、未決事項として開発者に確認します。

1. 開発者の承認・変更指示。この変更では添付 `clock.mp3`、#131の仕様確定、時計の強調を5秒へそろえる指示を含みます。
2. [AGENTS.md](../AGENTS.md)の作業・ブランチ・コミット・承認・検証ルール。
3. [README.md](../README.md)の共通仕様、特に時間設定・効果音・時間切れ5秒前の通知。
4. 本書の共有transport・効果音・Workerの時計計算と、[docs/testing.md](testing.md)の検証方針。
5. [#131](https://github.com/yksw-clm/tetraboard-2026/issues/131)、設定担当の[#121](https://github.com/yksw-clm/tetraboard-2026/issues/121)、未導入のフィッシャー方式担当の[#123](https://github.com/yksw-clm/tetraboard-2026/issues/123)。未決事項や古い記述より承認済みの正本を優先します。
6. `roomClockPresentation.ts`・`RoomClock.tsx`・`playerClocks.ts`・`useRoomTransport.ts`・各ゲームsession、`shared/soundPlayer.ts`・`soundEffects.ts`・`roomSoundEvents.ts`、Workerの`clockCore.ts`と関連テスト。Git履歴と[PR #85](https://github.com/yksw-clm/tetraboard-2026/pull/85)も参照します。
7. Web Audio・タイマー・可視状態の一次仕様と実機確認。外部仕様からゲームルールを新たに決めません。

共通仕様の変更なのでゲーム固有のルールは変更しません。ゲーム固有の進行・自動パスの変更が必要になった場合は、先にそのゲームのルール正本を読み直します。

**Constraints**

- 最新developから専用ブランチを作り、mainへの直接push・force pushを行いません。コミットは種別と日本語の説明を使います。マージ・公開は開発者の承認後に行います。
- 最終期限・同期したサーバー時刻・5,000msの境界を時計音と強調で共用し、表示文字列から判定しません。時刻補正・同期復帰を扱い、タイマーが5秒ちょうどを飛び越えても境界を取りこぼしません。期限ちょうど以降は音を開始しません。
- 手番ごとの通知記録を、通常のスナップショット更新・再描画・同期補正・同じ画面での再接続から分離します。ルーム世代・局・手番の変化を判定し、自動パスによる同一人物の新しい手番も扱います。通知記録を無制限に蓄積しません。
- Webの共通時計・既存の単一AudioContextを使います。時計音の再生ノードを識別して個別停止と期限での停止予約を行い、既存の着手音・終了音の順序を維持します。AudioContextの中断時は予約中・再生中の時計音を破棄し、復帰で再演しません。
- サーバーの時間計算・脱落判定・CPU待ち・通信契約・対局記録・保存形式は維持します。新しい外部サービス・依存ライブラリ・DBマイグレーションを導入しません。
- #121の設定画面・保存方式、専用の時計音設定・音量設定、#123のフィッシャー方式、複数タブ間の再生担当調停は範囲に含めません。共通の効果音設定へ接続できる再生可否の境界を設け、設定未導入時はONとして扱います。
- 時計の基本時間の黒・秒読みの黄色、強調の赤と既存アニメーション、動きを減らす設定を維持し、盤面・カードの寸法を変えません。手番外・待機・棋譜で強調しません。音の有無と視覚的強調を独立させます。
- 自動検証はBunの純粋関数とBun＋happy-domの部品・hook、既存Worker統合テストを使います。ブラウザ起動型のテスト・設定・workflowを追加しません。実デコード・ネイティブ操作・CSSの実描画・他アプリとの同時再生は手動確認します。checkは180秒以内を目標とします。
- コード・設定変更のPR提出前と更新後に `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run` を成功させます。GitHub CI成功をローカル結果で代替しません。README・開発手順・検証結果を同じ変更で更新します。

**Done When**

- 全6ゲーム・各モード・人間とCPUの組み合わせで、本人だけに時計音が鳴り、対局者・観戦者の現在手番の時計が同じ5秒境界で強調されます。持ち時間＋秒読み、持ち時間のみ、秒読みのみの各構成と持ち時間から秒読みへの移行を確認します。
- 5,001／5,000／4,999／1／0msと期限後を検証し、5秒をまたぐタイマー更新も確認します。6秒・9秒では強調せず、5秒以下で強調し、0秒で新たに音を開始しません。0秒の強調はサーバー確定まで維持し、手番交代・脱落・終局で解除します。
- 再戦、秒読みの毎手番、自動パスで同一人物へ戻る手番で通知でき、再描画・同じスナップショット・チャット・将棋の提案などの手番を変えない更新・同期補正・再接続では重複しません。
- ライブの新しい手番が5秒以下なら即時に鳴り、初回入室・再読み込み・復帰時に5秒以下なら鳴りません。復帰時に5秒より多ければ、その後の到達だけを通知します。古い接続の通知・遅い取得結果による再演や予約の復活も防ぎます。
- 時計音の最大5秒・残り時間による短縮・期限での停止、本人の着手／投了送信成功・手番交代・脱落・終局・非表示・切断・復旧同期・離脱による停止を確認します。送信失敗では継続し、送信後の拒否では同じカウントを再演しません。既存の着手音と最終着手後の終了音は正常に再生します。
- 音声未有効化・未準備・AudioContext中断・取得／デコード／再生失敗と、共通の再生可否をOFF／ONへ切り替える境界を制御して確認します。見送った通知を再演せず、音声失敗でも操作・通信・時計が継続します。OFFでも視覚的強調は表示します。
- 純粋な境界・カウント判定はBunテスト、全6ゲームへの接続と送信・停止・復帰は部品／hookテスト、サーバー時計・自動パス・期限優先の維持は既存Worker統合テストで確認します。添付MP3がViteの同一origin資産としてビルド出力に含まれます。
- 必須ローカルコマンドとGitHub CIが成功し、PRに検証対象コミット・実行環境・各結果・未確認事項を記載します。PCとiPhone Safari／Android Chromeで音の聞こえ方・5秒での停止・初回有効化・消音・他アプリ音声との併用・背景復帰と、時計の強調・動きを減らす設定を手動確認し、端末・OS・ブラウザの版と結果を記録します。未実施分は明記し、マージ前に必要な実機確認を完了します。

## Workerの時計計算と期限選択

CPUの最低待ち時間は `progressHelpers.ts` の `cpuMoveDelayMs = 2_000` を全ゲームで共用し、サーバーの `clock.turnStartedAt` を基準に確定を制御します。保存済みCPU選択のAlarmは選択の `applyAt` と手番開始＋2秒の遅い方を使い、早い旧予定でも待機中のAlarmを繰り返しません。時計・復帰期限を先に処理し、再接続や手番を変えない更新では開始時刻を保持します。思考計算は既存の同期選択・2段階適用を維持し、時間を固定するsleepを追加しません。

CPU付き作成の `POST /rooms` は任意の `cpuLevel: 1 | 2` を受け、未指定はLv1です。不正値は400で拒否します。`waitingRoomFactories` が全CPUへ適用し、Webの共有 `RoomEntryDialog`・`useRoomEntry` はquick作成にだけ選択を表示・送信します。OAuth復帰情報の任意 `cpuLevel` も1／2だけを復元し、旧復帰データはLv1にします。

`apps/worker/src/rooms/clockCore.ts` は席IDを型パラメータとする内部時計型と純粋な初期化・手番更新・停止計算を持ちます。`clock.ts`／`shogiClock.ts` はColor／Sideの具体的な4キーの残時間recordを作り、既存の引数・既定値・戻り値・overloadを保つwrapperです。基本時間は前手番の経過だけ減算し、手番が変わらない脱落では同じ時計を保持します。リバーシの自動パスで同じ色へ戻る場合は完了した1手として秒読みをリセットします。共通計算へゲームエンジンを読み込みません。

`roomDeadlines.ts` は現在の時計期限・プレイヤー配列の復帰期限・呼び出し側の現在時刻から、到達済みの次イベントと確定時刻を返します。早い期限を先に、同時刻なら時間切れを先に、切断同士の同時刻なら現在の配列順に選びます。GameRoomは処理のたびに更新後の状態から選び直します。Alarm候補の最小時刻も純粋関数で選び、空はnull、過去の候補は補正しません。

GameRoomには共有ライフサイクルの現在時刻の取得、活動停止・人間不在の判定、transaction、配信・索引更新、Alarm候補収集と設定・削除を残します。ゲーム進行側の時計更新・脱落・CPU・終局については次節のモジュールへ委譲します。通常リバーシCPUの同期確定と、四人リバーシ・将棋・五目並べCPUの選択保存→次Alarmで局面と期限を再検証する順序を維持します。Webの時計取得・表示・時刻同期は従来どおりです。保存形式・互換性・戦績SQL・保存再試行の再設計は #58、ページ遷移時の接続管理は前述の共有transportが担当します。

関連回帰は `bun run --cwd apps/worker test test/clock.test.ts test/roomDeadlines.test.ts test/roomDeadlineBoundary.test.ts test/gameRoom.test.ts test/fourShogiRoom.test.ts test/humanlessRooms.test.ts test/shogiStore.test.ts` で実行します。全14設定・秒読み・期限前後・同時刻と遅延処理・期限後のエラー・Alarm候補に加え、実DOの `evictDurableObject` によるhibernation／接続を閉じた復元、保存済みCPU選択の再検証、終局再実行時の棋譜・対局保存・本人索引・計測の非重複を確認します。HTTP／WebSocketの公開応答を通信契約で解析し、時刻とCPU選択は保存境界で制御します。内部メソッドのモックや固定sleepを使いません。Color／Side・残時間recordの取り違えはWorkerのtypecheckに含まれる型検査専用fixtureで検証します。

## Workerのゲーム進行と共有ライフサイクル

`fourReversiProgress.ts`／`fourShogiProgress.ts`／`reversiProgress.ts`／`standardShogiProgress.ts`／`gomokuProgress.ts` は配席・開始・着手・投了・外部脱落・時計更新・棋譜記録・終局データと保存待ちの生成・CPUを担当します。将棋の合法手・王手・千日手・提案もゲーム側に置きます。撃破数と三人攻撃禁止は四人将棋のみ、入玉宣言は通常将棋のみです。依存は実DOのstorage、参加資格読取り、開始時のアカウントID読取りだけです。通信・配信・外部保存への権限を渡しません。対局状態は呼出しごとにstorageから読み、モジュールに保持しません。将棋Storeは初めて必要になったときに生成し、千日手の参照cacheは一回の遷移内に限定します。

`gameProgress.ts` はWorker内部の型対応と必須登録を持ちます。追加ゲームには `ProgressTypes` の終局・直前局と、`GameProgressRegistration` のfactoryを登録します。protocolの `RoomFor<G>`・`GameActionCommandFor<G>` に開始・進行・終局・再戦データを対応付け、mapped typeと `satisfies` で欠落を検出します。将棋・五目並べ着手の局ID・revisionは必須です。結果は拒否・変更なし・継続・終局のunionで、共有側が明示的に分岐し `never` で網羅性を確認します。別ゲームのRoom・着手・終局結果・再戦データの混入は型検査専用fixtureで拒否します。

GameRoomは認証・参加・準備・接続／切断・チャット・transactionと共有副作用を担当します。期限ループは一つで、活動停止・人間不在の閉鎖、欠落した復帰期限の補完、期限の選び直し、待機席の解放、資格・アカウント処理を共有し、盤面の脱落だけをゲーム側へ渡します。終局はゲーム側の棋譜・局面更新 → 共有の計測確定 → ゲーム側の保存待ち・直前局確定 → 共有の席保持・元の復帰期限保持・資格解放・ホスト交代・準備解除 → ゲーム側の待機Room生成の順です。transaction後のflush・Alarm・配信・索引更新の既存順序を保ちます。

通常リバーシCPUは通常アクセスでも同期選択し、計算後の現在時刻で期限を確認して確定します。四人リバーシCPUはLv1・Lv2ともAlarmだけで内部選択を保存し、次Alarmで部屋世代・局ID・CPU本人・局面・時計・期限を再検証して適用します。将棋CPUはAlarm限定で提案を同期し、終局しなければ選択を保存、次Alarmで局ID・revision・手番・期限を再検証して適用します。五目並べCPUも同じ選択保存・次Alarmでの検証を使い、引分提案は行いません。明示退室はリバーシの盤面・棋譜処理後に資格を失効させ、将棋は資格失効後に盤面処理します。D1保存・SQL・再試行の設計は維持し、閉鎖後の保存待ちと保護棋譜も保持します。保存形式・互換性・戦績SQL・保存再試行の再設計は #58、ページ遷移時の接続管理は前述の共有transportが担当します。

前節の回帰コマンドは通常GETでのCPU進行の差、将棋の複数接続・切断通知欠落・活動停止・再戦時の元の復帰期限も確認します。抽出した進行・終局更新を実storageのtransactionで実行し、例外後にKV・SQLiteの千日手・棋譜・保護状態・保存待ちが全て戻ることを検証します。公開応答は通信契約で解析し、内部メソッドのモック・固定sleep・テスト用公開APIを追加しません。

## 総合ロビーの実装計画

2026-10-13に開発者がUIモックと本実装の提案を承認し、仕様確定と以下の4項目の決定を指示しました。利用者向け仕様の正本は[README](../README.md#総合ロビーの確定仕様)です。実装の入口と保存・配信の構成は[次節](#総合ロビーの実装)、受入検証は[テスト方針](testing.md#総合ロビーの確認)を参照します。本節は承認された目的・制約・完了条件を保持します。

**Goal**

`/` を全6ゲームの総合ロビーにし、空席のある募集を優先して参加・観戦へ進め、最近の終局を振り返り、公開チャットで次の対局の約束を話せる状態を作ります。承認済みのUIを維持して実データ・認証・永続化・運営機能へ接続し、対人戦と継続利用の効果を既存の管理計測で比較できる、develop向けのレビュー可能な実装PRを完成させます。

本番βの公開は、開発環境での確認と開発者のリリース承認後に行います。対人戦比率の改善は公開後の成果指標とし、実装PRの完成条件には数値の改善を要求しません。会話で示されたCPU戦177・対人戦29は問題意識の参考値で、計測期間・条件が未指定のため比較基準として固定しません。

**ContextProviders**

次の優先順位と用途で参照します。プレビューの架空データや現行コードを、承認された本実装仕様と混同しません。

1. この会話の開発者の承認・変更指示。総合ロビーを左端とトップにすること、部屋の3分類順、満室の無効な参加ボタン、固定高さ、簡潔なチャット、ナビゲーションの盤面図・見出し・幅・区切り線、および本実装提案の承認です。
2. [AGENTS.md](../AGENTS.md)のブランチ・日本語コミット・仕様承認・必須検証・CI・マージと公開のルール。
3. [READMEの確定仕様](../README.md#総合ロビーの確定仕様)と、同文書の認証・参加・公開棋譜・ルーム内チャット・退会・プライバシー・計測・共通UI・検索向け配信。ゲームのルールは変更しません。
4. [構成文書](architecture.md#総合ロビーの追加方針)、この文書の[共通手順](#共通の作業手順)・[ゲームID](#ゲームidと軽量カタログ)・[共通ロビー](#共通ロビーと四人将棋ui)・[SEO生成](#ロビーのseo生成と成果確認)・認証と管理の案内、[受入検証](testing.md#総合ロビーの確認)。
5. 承認済みのモック：`features/lobby/GeneralLobbyPage.tsx`・`GeneralLobbyRooms.tsx`・`GeneralLobbyChat.tsx`・`GeneralLobbyGameNavigation.tsx` と共通ナビゲーション・盤面図・`shared/ui`。配置・寸法・見た目の参照とし、疑似ログイン・架空データ・確認用ダイアログは本実装へ持ち越しません。
6. 実データと資格の入口：Workerの [roomIndex.ts](../apps/worker/src/rooms/roomIndex.ts)・[roomRoutes.ts](../apps/worker/src/rooms/roomRoutes.ts)・[publicMatchRoutes.ts](../apps/worker/src/rooms/publicMatchRoutes.ts)、Webの [useLobby.ts](../apps/web/src/features/lobby/useLobby.ts)・[useRoomEntry.ts](../apps/web/src/features/lobby/useRoomEntry.ts)・[AccountSession.tsx](../apps/web/src/features/account/AccountSession.tsx)。ゲームカタログは `packages/protocol/src/games.ts` を参照します。
7. 運営・保存期限・配信・計測の入口：Workerの `rooms/reportStore.ts`・`admin/auth.ts`・`admin/routes.ts`・`privacy/deletion.ts`・`analytics/retention.ts`・`publicAssets.ts`、`apps/admin/src`、Webの `analytics/pageAnalytics.ts`・`seo/pageMetadata.ts`・`build/generatePublicLobbies.ts`、`scripts/checkDeployment.ts`。ルーム専用の通報契約を公開チャットへそのまま流用せず、既存の認証・期限処理を参照します。
8. Git履歴で導入経緯・互換性を確認します。必要になった過去のIssue・PRは補助資料として参照し、現在仕様の決定には正本とこの会話の承認を優先します。

**Constraints**

- `feat/general-lobby` はdevelopから作成済みです。既存モックの差分を保持し、develop向けPRで取り込みます。main・developへ直接push・force pushせず、取り込みでコード・設定が変われば必須検証をやり直します。コミットの種別に続く説明は日本語にします。マージ・公開は差分と検証結果を示した後の承認が必要です。
- 既存のBun・TypeScript・React・HeroUI・Cloudflare Worker・Durable Objects・D1を使います。新しい主要依存・外部サービス、ゲームルーム全体の複製、将来用途だけの汎用化を追加しません。保存先・責務は既存構成内で選び、アカウント単位の制限と競合時の整合性を満たす方式を実装文書へ記録します。
- 総合ロビーは実ゲームの `GameId` を増やしません。横断取得とページ計測にはサービス全体のスコープを用い、`all` を対局のゲームとして保存せず、既定ゲームの省略時挙動・未知ゲームIDの拒否を維持します。
- 横断一覧はサーバー側でフィルター・分類・並べ替え・ページ分割します。ルーム索引を使い、一覧更新ごとに各DOを巡回しません。索引の遅延を前提に、参加・観戦の最終可否はルームの正本と世代で再検証します。既存のゲーム別APIの条件・順序・戻り値を無断変更しません。
- 公開チャットの状態・保存・制限・投稿停止をゲーム進行から分離し、障害や全体投稿停止が対局・ルーム内チャットを止めないようにします。部屋の時計・準備・再戦・資格・棋譜・戦績・ランキングを変更しません。
- 閲覧者・投稿者・通報者・管理者の資格をサーバーで検証します。投稿と管理操作は既存の同一オリジン検証・認証方針に従い、Cookie・メール・内部ID・トークンを公開応答へ含めません。本文はテキストとして表示し、URL禁止と100文字・10秒制限、停止中・退会後の拒否を直接APIにも適用します。
- 投稿の確定・重複防止・送信間隔を複数タブ／端末・同時送信・応答喪失・再試行でも守ります。公開チャットの通常投稿と通報証拠を分け、7日・500件の境界、削除再試行、退会受付後の即時取得除外と遅延投稿の復活防止を検証します。追加migrationは目的・既存データへの影響・両環境での適用手順を記載し、既存棋譜の一括書換えは行いません。
- 承認済みのナビゲーション幅、固定高さ、色、共通部品、キーボード・読み上げ操作を維持します。非表示時のポーリング停止、復帰時の再取得、古い応答の破棄、閲覧位置と入力の保持を機能別に扱います。ある領域の取得失敗を画面全体の失敗にしません。
- ローカル限定分岐、架空データ、疑似認証、確認用操作を本実装で外します。本番／開発buildの両方で総合ロビーが機能し、公開チャット本文を初期HTMLへ埋め込まず、開発環境の検索除外と既存非検索画面の扱いを維持します。
- 計測は既存の開始時CPU有無・完了・7日継続率と除外・保存期限を使います。総合ロビー閲覧を特定ゲームの開始率へ混ぜず、チャット本文・操作内容を分析用に保存しません。予約・通知・自動マッチング・新ランキングなど、確定仕様外の機能を追加しません。
- 自動検証はBun純粋関数、Bun＋happy-dom、Worker統合に集約し、ブラウザ起動型テスト・設定・workflowを追加しません。画面寸法・ネイティブ入力・実画像・実OAuthは手動確認の結果または未確認理由を記録します。
- 実装PR前に `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run`、`bun run build:development`、`bun run --cwd apps/worker deploy:dry-run:development` をすべて成功させ、同じ対象コミットのGitHub CIを独立して確認します。checkは180秒以内を目標とし、所要時間を記録します。

**Done When**

1. READMEの確定仕様・本計画・テスト方針が実装と一致し、モックと実装済み範囲を明記しています。プライバシーポリシー・規約に公開チャットの公開範囲・保存期限・退会を反映し、関連文書に旧トップ転送やモック限定を現行の完成仕様として残していません。
2. 本番／開発buildの `/` が総合ロビーで、通常の遷移と直接GET／HEAD・再読み込みが動作します。6ゲームのURL・通常タブと既定ゲームの契約を維持し、根拠のないGameId追加・架空データ・疑似ログインがありません。ホームリンク・title・description・canonical・トップを含むサイトマップ・開発noindexを検証しています。
3. 6ゲームを横断する公開ルームが3分類順で表示され、同分類の順序・定員フィルター・20件の追加取得・0件・少数・多数が正しい状態です。満室の参加は表示されて無効、対局中は非表示、観戦は全件にあります。10秒更新・非表示／復帰・条件変更・通信失敗・古い応答・スクロール保持を検証しています。
4. 全6ゲームでゲスト／登録者の参加と観戦を既存フローへ接続し、満室化・開始・閉鎖・番号再利用・別ルームの席競合をサーバーが拒否でき、理由と復旧操作が表示されます。招待・ゲスト登録引き継ぎ・ルーム資格の既存回帰が成功しています。
5. 最近の対局が全6ゲームの保存済み終局の最新20件で、開始日時とUUIDの順序・ゲスト／CPU／両モード・人間限定条件・手動更新・失敗時保持が正しく、公開棋譜へ進めます。保存中・未終局・不正ゲームの混入がなく、定員フィルターと独立しています。
6. 公開チャットが未ログインで読め、プロフィール完成済みの本人だけが投稿できます。100文字・URL禁止・10秒の境界・同時送信・複数端末・応答喪失と再送をサーバーで検証し、二重投稿がありません。入力保持・IME・認証復帰、50件と過去分、新着と追従、5秒更新・日付・古い応答を検証しています。
7. 通常投稿の7日・500件の上限、期限到達時の除外、削除・保存失敗からの再試行、退会受付・同時投稿・遅延応答、通報証拠の別の7日期限を検証しています。一般画面や古い同期応答から削除済み情報が復活しません。
8. ブラウザ内の送信者非表示・名前変更時の同一性・ログイン必須の通報、管理者だけの一覧／削除／投稿停止・解除／全体停止・再開が動作します。直接APIの権限・停止状態を検証し、停止中も履歴・ルーム・対局が利用できます。
9. サービス全体の総合ロビー閲覧・滞在を確認でき、対人／CPUの開始・完了・割合・継続率の既存定義と除外・期限・退会を維持しています。個別ゲームの開始率に総合ロビーだけの閲覧が混入せず、本文・操作内容が分析に保存されません。
10. [受入検証](testing.md#総合ロビーの確認)と6ゲーム・認証・棋譜・ルーム内チャット・管理・配信の関連回帰が成功しています。PC／スマートフォンの幅・固定高さ・内部スクロール・配置、キーボード・読み上げ・実認証は手動確認結果か未確認理由を記録しています。
11. 必須5コマンド・文書整形・リンク・`git diff --check` と対象コミットのGitHub CIが成功し、develop向けPRに対象コミット・実行環境・結果・check所要時間・未確認事項を記載してレビューできます。マージ・開発／本番公開は、この実装PRの完了とは別の承認手順として扱います。

**実装の順序**

横断取得と契約 → 公開チャットの保存・認証・重複／制限・期限 → 管理操作と退会 → 承認済みUIの実データ接続 → トップ配信・SEO・計測 → 横断回帰・手動確認・PRの順に進めます。各機能の実装と関連テストを同じ段階で追加し、公開時点で運営・削除を欠いたβにしません。分割方法は実装の都合で調整できますが、承認済みの範囲と完了条件は変更しません。

## 総合ロビーの実装

`features/lobby/GeneralLobbyPage.tsx` がトップ、`GeneralLobbyRooms.tsx`・`useGeneralLobbyRooms.ts` が横断一覧、`GeneralLobbyChat.tsx`・`useLobbyChat.ts` が公開チャットです。架空データ・プレビュー操作・疑似ログイン・DEV限定分岐は撤去し、`/` を両環境のbuildへ含めます。既存の `AccountMenu`・`useRoomEntry`・`RoomEntryDialog`・`RecentMatches` を使い、参加時と観戦URLにルーム世代を渡します。観戦URLは世代確認用の `invite` と `watch=1` を持ち、参加ダイアログを自動表示しません。通常の招待URLは従来どおり参加案内を表示します。登録復帰先に `/` を許可し、チャット下書きはsessionStorage、送信者非表示は公開IDをキーにlocalStorageへ保存します。

PCの2列はCSS Gridのsubgridで見出し・720pxの本文・凡例を共有し、767px以下では公開ルーム400px・チャット600pxの縦並びにします。投稿欄と送信ボタンは共通UIに48pxの高さを指定します。`GeneralLobbyGameNavigation` だけが初期盤面図を読み込み、通常のナビゲーションは文字表示と同じ幅・間隔を使います。タイトル・共有盤面図・共通UIはモックの承認済み配置を維持します。

`GeneralLobbyRooms` は取得済みデータと空表示を自動更新中も保ち、`pendingSource === "refresh"` のときだけ一覧に共通スピナーを重ねます。0件のゲームボタンは履歴stateの `roomEntryIntent: "create"` を渡し、共通の `LobbyView` が既存ダイアログを初期表示します。stateの作成意図だけを履歴置換で消費し、他のstateを残して再訪時の自動再表示を防ぎます。

通信契約は `@tetraboard/protocol/general-lobby`、Workerの `lobby/routes.ts` が `/lobby/rooms`・`/lobby/matches` を提供します。ルームは既存D1索引の状態分類・更新日時・番号のカーソルで20件ずつ取得し、Webは取得済みページ数を再取得して追加分も10秒更新します。最近の終局はゲーム条件を外した既存記録から最新20件を取得し、人間限定をページ分割より先に適用します。

`lobby/chatRoutes.ts` と `chatStore.ts` が `/lobby/chat`・`/lobby/chat/reports`・`/admin/lobby-chat` を扱います。D1の条件付きINSERTが本人・プロフィール・停止・10秒制限・退会・再送IDを検証し、AFTER INSERTトリガーが同一トランザクションで送信時刻・再送台帳・最新500件を更新します。再送台帳は本文のハッシュと投稿IDを持ち、運営削除後の同一再送も本文を復活させません。通常投稿と再送台帳は7日、通報証拠は通報から7日です。期限と退会受付の時点で取得から除外し、毎時削除・削除失敗の再試行へ接続します。退会の完了前に通常投稿と再送台帳を削除し、証拠内の本人識別を除去します。

通報は開発者の明示承認に従い、直近1時間で1アカウント5件までです。同じ発言への再通報は重複登録せず、件数を消費しません。件数の照合と登録を単一の条件付きINSERTで行い、同時要求でも上限を守ります。

管理画面の `LobbyChat.tsx` は通報と現在の投稿、停止中の利用者、全体受付状態を表示します。既存の管理者認証とOrigin検証を使い、実行前に操作内容を確認でき、失敗時は再試行できます。ルームチャットの通報契約・進行処理は変更しません。

`general-lobby` のページ種別・ゲームnullで閲覧と滞在を計測し、ゲーム別開始率へ混入させません。管理集計に総合ロビー閲覧・滞在、対人／CPUの完了数と対人開始割合を追加しました。90日超の集計にも追加列を保存し、導入前に集約済みで完了内訳が分からない期間は「—」で表示します。導入前の内訳を推測して補完しません。

D1 migration `0017_general_lobby.sql` はチャット・送信者・再送台帳・証拠・全体設定とトリガー、ルーム索引、計測集計列を追加します。既存棋譜の書換えと外部依存の追加はありません。ローカルは `bun run dev` のmigrationで適用します。公開は開発環境のmigration適用と実認証・運営操作・削除処理の確認後、リリース承認を得て本番にも適用します。必要なSecretsは既存の認証・管理者設定を利用し、新しい外部サービス設定は不要です。OAuthのホームページ設定は公開時にトップURLへ整合させます。

トップの初期紹介HTMLは `renderGeneralLobby` で生成します。通常のSPA用の空root・noindexを持つ `app.html` を別に生成し、ログイン・ルーム共有・規約にはこちらを配信します。`index.html` の直接アクセスはトップへクエリを保持して308、トップ自体は200です。公開チャット本文をHTMLへ埋め込まず、サイトマップはトップ＋6ゲーム、開発は検索対象外です。

## 共通ロビーと四人将棋UI

`/games/four-reversi` と `/games/four-shogi` は `features/lobby/LobbyView` を共通利用します。タイトル・説明・遊び方・盤面プレビューはゲームごとに切り替え、一覧とランキングは各ページから渡します。両ゲームともPCは操作カードとランキングを上段、その下に公開ルームを置き、スマートフォンでは操作・公開ルーム・ランキングの順にします。画面幅による並べ替えでもランキングの状態を維持します。

将棋ページは `LobbyView` の省略可能な `boardPreview` に `FourShogiLobbyBoardPreview` を渡します。エンジンの `createInitialState` から初期盤面を取得し、既存の盤画像・`ShogiPiece`・方向変換を使って南を手前に描画します。盤内の余白と駒の縮尺は対局画面に合わせ、盤画像の縦横比458:500を保ちます。幅は768px以上で88px、767px以下で56px、左へ7度傾けて影を付けます。盤面図は `aria-hidden` の装飾とし、マスにはボタンを使いません。入力中のモードや通信状態には連動させません。767px／768pxの境界をまたぐときは渡された盤面図だけを再描画し、WebKitの縮尺変更後の画像の乱れを防ぎます。既存のリバーシ盤面図は共通ロビー内で維持します。

`GameBadge` は棋譜カードとルームカードのゲーム名表示を共用します。両カードの `showGame` で表示を切り替え、各ゲームロビーからはfalseを渡し、総合ロビーとマイページでは表示します。`LobbyFooter` は総合・各ゲームロビーの規約導線と著作権表記を共用します。

`LobbyRoomCard` と `LobbyRoomLegend` は総合ロビーとゲーム別ロビーのルーム表示を共用します。ゲーム別はCSS Gridの `auto-fill` と最小440px（狭い場合は100%）で最大2列にし、1件だけの場合も空き列を残して半幅にします。表形式の列見出しを置きません。プロフィール参照・持ち時間・席数の読み上げを共通化し、参加／観戦のボタンと処理中状態は各呼び出し元で管理します。凡例は色と名称だけで、席数の補足文を表示しません。総合ロビーの一覧領域は薄い背景と枠・paddingで囲み、取得中も領域の高さを保ちます。ゲーム別の満室時の参加非表示と総合ロビーの無効表示、一覧の取得・スクロール方針を維持します。

`LobbyRankings` は取得部分と共通の表示部分を分けています。各ゲームのランキングAPIを専用hookで取得し、モード・ロビーと詳細の集計項目を共通の `AppTabs` で切り替えます。ロビーでは表示内容を上・操作行を下へCSSで配置し、TabListを先に描画してtab／tabpanelの参照を維持します。集計TabListは `w-max min-w-0 flex-none`、各Tabは `w-auto flex-none` でHeroUIの `min-w-full`／`w-full` を上書きして文字に合わせた幅にします。操作行は `flex-wrap` で狭い幅でも全操作を表示し、モードタブの全幅表示は維持します。カルーセルの自動切替と選択タブは同じmetricから決めます。更新・空一覧・エラーと再試行を共通で扱います。Portalの詳細ダイアログにも将棋テーマを渡します。

両ゲームで `useLobby` と `useRoomEntry` を使い、ゲーム指定を付けて取得・作成・参加します。省略時はリバーシです。将棋では作成時に三人攻撃禁止を設定できます。ランキングもゲーム別に集計し、リバーシの値を将棋へ流用しません。ダイアログを閉じても入力を保持し、ゲームを切り替えたときは破棄します。

`GameLobbyNavigation` は全ロビーのヘッダー直下に `NavLink` を並べ、現在のURLを選択表示と `aria-current="page"` に反映します。リンク幅は768px以上で124px、767px以下で104px、通常のリンクの高さは44px以上にし、横スクロールの1行を維持します。総合ロビーだけは盤面図を含む高さ128px以上のリンクにし、区切り線の右側のゲーム群の上に「ゲーム一覧」を表示します。通常の文字タブも同じ幅・間隔を使い、ゲーム群の横位置をそろえます。アカウント・ルーム画面には追加せず、`/` は総合ロビーへ接続します。

選択背景の移動には `motion` の `layoutId` とspringを使います。ルーターの親に `LayoutGroup` を置き、別のロビーページへの入れ替えでも同じ選択背景としてつなぎます。文字・盤面図は背景と分けて拡大縮小させず、装飾は読み上げ・クリックの対象外にします。横スクロール領域は `overflow-x-auto overflow-y-hidden` とし、総合ロビーの大きな選択背景が通常タブへ縮む途中も縦のスクロールバーを表示しません。横方向だけautoにすると縦方向もautoへ計算されるため、縦方向を明示的に隠します。左右ボタンは `AppHorizontalScrollButtons` をゲームナビゲーションと `RecentMatches` の横並び棋譜一覧で共用します。スクロール位置とResizeObserverの通知で続きの有無を判定し、表示領域の75%を横に移動します。カードの取得・切替後も子要素の観測を更新します。OSの動きを減らす設定では即時移動します。`layoutScroll` を指定し、現在リンクへのスクロールをlayout effectで描画前に反映します。`MotionConfig reducedMotion="user"` でOSの動きを減らす設定に従います。リンク・選択表示・戻る操作は `lobbyComponents.test.tsx` で確認し、動きの感触・横スクロール・寸法変更・OS設定の実表示は手動確認します。

既定の共通テーマは緑です。将棋の本文には `game-theme-four-shogi` を付け、Portalの入力・遊び方・ランキングのダイアログには `AppDialog` の `theme="four-shogi"` を渡します。`primary`／`primary-hover` は主要ボタンの塗り、`primary-foreground` は文字、`brand` は文字アクセントとして分けます。HeroUIの `--accent` と `--accent-foreground` も同じ範囲で設定します。共通ヘッダー・アカウントメニューをゲームのテーマ範囲に含めず、グローバルなテーマ切り替えは行いません。意味を持つdanger・focusの色は上書きしません。

ゲーム別のURLとAPI、作成・参加payload、入力保持と破棄、ランキングの選択と戦績・履歴の共通選択はBunとhappy-domで確認します。通信・認証・永続化はWorker統合テストで確認します。遊び方は各ゲームのルール正本と照合します。

## ロビーのSEO生成と成果確認

`/` の初期紹介HTMLとメタ情報を生成し、サイトマップと配信確認はトップ＋6ゲームです。[確定仕様](../README.md#検索向け配信と効果の確認)に従います。

`src/seo/lobbyMetadata.ts` はWeb側のゲーム別title・description・紹介の正本です。ゲーム名・ロビーパスは軽量ゲームカタログを参照します。紹介は `GameIntroduction` で通常ロビーと初期HTMLが共用し、ルール正本に合わせて同じ変更で更新します。エンジン・認証・API・動的一覧を静的生成へ持ち込みません。

6ロビーのtitleは「ゲーム名をブラウザで無料対戦 | TetraBoard」、四人将棋・四人リバーシの検索向け別表記は[README](../README.md#ゲームロビーの検索向け紹介と配信)に従います。既定HTMLと遷移後の `og:site_name` も `TetraBoard` にそろえます。ルーム共有では `protocol/room-sharing` の同じブランド表記を使い、遷移時に共有用のtitle・画像を残しません。

各ロビーと `generalLobbyMetadata` の `lastModified` は、title・description・紹介・主要ルールなどページの内容を更新した日に `YYYY-MM-DD` で更新します。全7URLの `lastmod` はこの値から生成し、再ビルドや動的一覧の更新だけで日付を進めません。[Googleのlastmodの説明](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap#additional-notes-about-xml-sitemaps)を参照します。

WebのbuildはVite出力後に `build/generatePublicLobbies.ts` を実行し、ハッシュ付きJS・CSSの参照を保持した6ロビーのHTML、robots.txt、7件のsitemap.xml、404.html、トップのindex.htmlと検索対象外のapp.htmlを生成します。生成コードと関連Bunテストは `tsconfig.build.json` でも型検査します。ルートのbuildが既存の `scripts/buildAssets.ts` でこれらをWorker資産へコピーします。生成物はGit管理しません。Viteの開発画面は従来のCSRを使い、初期HTML・HTTPヘッダーの確認には `bun run build` 後の本番相当ローカルWorkerを使います。

`startPublicLobby` は紹介HTMLを持つ初回ロビーだけでルーターの初期化完了を待ちます。成功時に既存createRootへ渡し、遅延ルートの失敗時には紹介・通常リンクを残して再読み込みを案内します。他画面の初回loader・fallbackは従来どおりです。`pageMetadata` は初期表示とルーターのlocation変更でtitle・description・canonical・robotsを同期し、公開棋譜独自のrobots操作は行いません。`/terms`・`/privacy` のtitleはWorkerの `legalHtml.ts` と同じ `protocol/privacy` の `legalDocuments` を参照し、文書名とサービス名を保ちます。

本番の資産配信はWorkerが公開ロビー・既知SPA経路・静的資産を明示し、Wranglerの無条件SPAフォールバックを使いません。`worker.ts` の入口で、本番設定の `tetraboard.net` へのHTTPと旧Workerホストを本番HTTPSへ308転送し、パス・クエリを保持します。資産・API・認証・WebSocketの処理前に転送し、ローカル・開発環境には適用しません。HTTPSの `/` は200、`/index.html` と公開URLの別表記は308、未知URL・欠落資産は404、既知の非検索画面はnoindexです。公開ページのGET／HEAD・ETag／304を維持し、404本文の取得では条件付きヘッダーを除去します。`scripts/checkDeployment.ts` はトップ配信、全ロビーの初期本文・メタ情報、robots／sitemapと既存APIを確認します。本番URLを指定した場合だけ、HTTPのトップ・ロビー・APIの308とクエリを含むHTTPS転送先も確認します。

関連検証は `bun test --cwd apps/web ./test/publicLobbies.test.ts`、`bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/publicLobbies.test.tsx`、`bun run --cwd apps/worker test test/publicAssets.test.ts test/apiRouting.test.ts` です。Bun・happy-dom・Worker統合テストで生成、遷移、200／308／404、GET／HEAD／304、Content-Type、通常UA／Googlebot、認証とAPIの境界を確認します。画面寸法・実ブラウザ入力・JavaScript無効時の見え方は手動確認とし、ブラウザ自動テストは追加しません。

公開前に既存Search Consoleのドメインプロパティ `tetraboard.net` で「検索タイプ: ウェブ」「国: 日本」を指定し、直近28日間の対象ページ別・対象検索語別のクリック数・表示回数・CTR・平均掲載順位を記録します。対象語は「四人将棋」「四人リバーシ」、ページは各正規URLの完全一致です。期間・フィルター・端末区分も併記し、データのない項目を0と断定せず「データなし」とします。集計・期間はSearch Consoleの表示に従い、既存Adminの日本時間の指標と混ぜません。新たな個人別流入計測を追加しません。

必須ローカル検証とGitHub CI、差分・結果に対する開発者の承認後にマージ・公開します。本番確認後、Search ConsoleのライブURL検査でトップと全6ロビーの本文・検索許可を確認し、既存のサイトマップURLを再送信して未登録・更新対象ページのインデックス登録をリクエストします。サイトマップ送信の受理は取得待ちを意味し、個別URLの登録依頼や登録完了とは区別します。URL検査APIは登録済み情報の確認だけに使い、ライブURL検査と個別の登録リクエストはSearch Console画面から行います。実Googlebotによる登録と正規URL選択はライブ検査・UAのローカル比較と区別します。SEO整備の完了は本番確認・送信・基準値記録までとし、公開前は未完了です。

Issue [#207](https://github.com/yksw-clm/tetraboard-2026/issues/207) の別表記追加を本番公開したら、公開日とコミットを成果確認Issue [#87](https://github.com/yksw-clm/tetraboard-2026/issues/87) に記録します。公開4週間後に「4人将棋」のCTR・クリック数・表示回数・平均掲載順位を公開前28日間と同じフィルターで比較し、「四人将棋」と対象ロビーの数値も併記します。実装PR提出時点では公開日や公開後の結果を確定しません。

公開後4〜8週間で最初の成果を評価します。両URLが登録されGoogleの正規URLと一致し、日本・日本語・ログアウト状態のPC／スマートフォンで週1回×4週間、両検索語の通常の自然検索1位を確認し、各ページの評価対象28日間クリック数が公開前28日間より増加した場合を成果達成とします。日時・地域・端末を記録し、平均順位だけで常に1位と判定しません。データ不足は観測期間を延長し、未達なら継続課題とします。順位・反映時期の保証と自動監視は設けません。

## 四人将棋のオンラインルーム

公開型は `FourReversiRoom | FourShogiRoom | ReversiRoom | ShogiRoom | GomokuRoom` で、`settings.game` をガード関数で判別します。既存リバーシの保存形式・着手通信は維持します。将棋は担当方向、方向別の時計、局ID、局面revision、三人攻撃禁止、同じrevisionの合法手・三人攻撃禁止候補（`threePlayerAttackForbiddenActions`）と王手情報を配信します。禁止候補はエンジンの `getActionAvailability` で通常合法手から三人攻撃で除外された手だけを導出し、別の不正手を含めません。旧保存局面の未保存フィールドは公開局面から読込時に補完します。通常スナップショットに千日手の出現数は含めません。Webは受理された局面を表示し、履歴を補って独自に進行させません。

`room.game.action` の将棋着手は `roundId`・`positionRevision` と `movePiece`／`dropPiece` を送ります。サーバーが認証・局ID・revision・手番・合法性を検査し、着手と脱落でrevisionを進めます。`room.three-player-attack.set` は待機中のホストだけが変更でき、モードと同様に人間の準備を解除します。

将棋のDO保存は通常状態、局ID・局面キー別の千日手回数、初期化情報と連番イベントへ分けます。 実対局では千日手の全行を読み込まず、エンジンが必要とする局面キーだけを主キーで参照し、確定した変更分だけを保存します。参照キャッシュは同期的な一回の状態遷移またはCPU選択内に限定し、保存・ロールバック・次局へ持ち越しません。CPU探索では枝ごとの変更分を基底履歴より優先し、仮想着手の回数は永続化しません。完全な回数辞書を使う従来のエンジン呼び出しとWebの棋譜再生は維持します。局面・回数・イベント・revisionを同じトランザクションで確定し、棋譜へ全状態を複製しません。直前局は `GET /api/rooms/:id/rounds/:roundId/replay?instanceId=<UUID>&cursor=<offset>` から100イベントずつ取得します。Webは部屋世代・局ID・規則バージョン・件数・連続番号を検証し、エンジンで再生します。再生中の完全な状態は1つだけ保持し、閲覧用には千日手索引を除いた局面を保持します。次局開始で部屋の棋譜取得を中止します。未保存の終局イベントは次局開始・部屋閉鎖でも保持し、D1保存を確認後に不要な行を削除します。将棋の恒久履歴・戦績・ランキングはゲーム指定で分離します。

CPUの待ち時間と計時は [READMEの共通仕様](../README.md#投了通信切れと持ち時間) に従います。選択結果と局ID・revision・手番を保存し、次のAlarmで期限を再確認して適用します。同期処理中に `Date.now()` が進まない本番でも、別のイベントで得た時刻までを時計へ反映します。根拠は [Cloudflareの時刻仕様](https://developers.cloudflare.com/workers/runtime-apis/performance/) と [保存上限](https://developers.cloudflare.com/durable-objects/platform/limits/) です。

外側の `RoomLayout`、タブ、チャット、招待、カードの名前・アバター・ホスト・接続表示、時計表示と棋譜操作を共有し、将棋の盤内配置と操作は専用部品に分けます。PNG盤の縦横比を保ち、座標と向きを変換して4方向を表示します。盤上・持ち駒・ドラッグは同じ駒部品と盤内寸を使います。8pxのドラッグ閾値、盤外・取消・Escape、成り選択、局面更新時の解除、重複送信は純粋関数とDOMの状態テストで確認します。操作可能な盤上・持ち駒はホバーで画像だけが2px浮きます。選択中はホバーが外れても同じ高さを保ち、解除後は元へ戻ります。通常将棋・四人将棋で共有する `shogiPieceLiftClasses` は相対配置の `top` だけで即時に位置を補正し、着手時のちらつき対策として、浮き上がりには画像の `filter`・`transform` とその遷移を使いません。ドラッグ中は元画像を隠し、取消後に復元します。持ち駒の枚数は送信前に変更しません。選択・ドラッグ中は合法候補を緑、三人攻撃禁止候補を同寸の赤い丸で示します。禁止候補だけの駒・持ち駒も選択可能ですが、着手・成り選択・送信の判定は合法手だけを使います。合法な成り／不成がある移動先は緑を優先します。

成り選択は盤上へ重ね、左が成り・右が不成、駒画像は盤上と同寸にします。2枚の境界を移動先の中央に合わせ、盤端では全体を盤内へ寄せます。画面全体の透明なクリック受けで、選択外のクリック・タップは成りだけを確定します。成りボタンへ初期フォーカスを移し、Tabで二択を移動、Enter・Spaceで確定、Escapeで取消して移動元へフォーカスを戻します。

`useShogiPromotion` は未確定の移動元・移動先と部屋世代・本人・局ID・局面revision・陣営を `sessionStorage` に保存します。接続待ちで削除せず、認証と最新合法手の確認後、成り・不成の両方が合法な場合だけ復元します。確定・取消・局面更新・次局開始・脱落・資格変更、破損値、保存失敗と同じタブの再読み込みをBun＋happy-domのhookテストで検証します。

直前手は移動元の暗い茶色の背景と移動先の枠を描き分けます。マス装飾は盤PNGの罫線の原寸座標（アンチエイリアスを含む）に合わせ、各辺を罫線の内縁まで広げます。盤と同じ縮尺で追従し、盤の配置や当たり判定は動かしません。

767px以下の `FourShogiBoardLayout` は、盤面タブのコンテナ幅と高さから盤幅を決めます。カード2段（各48px）・持ち駒2段の固定余白・4つの2px間隔を差し引き、盤画像と持ち駒2段の駒画像の比率で残り高さを割ります。持ち駒の上下paddingは1px、ボタンの高さは駒画像＋2pxで、枠線を合わせた固定分は1段6pxです。横幅が十分でも高さが足りなければ盤だけ中央で縮小し、カードと持ち駒領域の幅は維持します。通常ルームと保存棋譜の両方にこの配置を使います。

固定局面を使ったBun・DOMテストと、実HTTP・WebSocket・D1を使う通常のWorker統合テストで、作成・参加・観戦・準備・開始・着手・CPU両レベル・チャット・再接続・終局・棋譜・再戦を確認します。ブラウザE2Eは廃止し、少数E2Eの再構築は次の作業で行います。PR前の必須検証は `bun run check`、`bun run build`、Worker dry-runです。

### 脱落後の持ち駒表示

全脱落原因で脱落時の持ち駒を表示として残します。`captureEliminatedHands` は遷移前後のルール状態から新たな脱落陣営を抽出し、着手時の捕獲・打ち駒の増減を反映した表示用枚数を追加します。入力とルール上の `hands` は変更しません。

Workerの `FourShogiProgress.accept` は確定遷移と同じトランザクションで、局IDと陣営別枚数を専用KV `shogi-eliminated-hands` に保存します。終局後も保持し、次局開始で空情報へ置き換え、部屋閉鎖で削除します。導入前に脱落済みだった陣営の失われた枚数を推測しません。

ルームGET・WebSocketの任意クエリ `eliminatedHands=1` を要求した四人将棋の画面だけへ、`room` の外側に `{ eliminatedHands: { roundId, hands } | null }` を付加します。対象局のない待機中はnull、非要求と他ゲームは項目なしです。ソケットタグ `eliminated-hands-v1` で休止後も要求を保持し、戦型解析との要求組合せごとに配信JSONを共有します。認証attachmentは変更しません。

WebはHTTP応答の項目の有無で対応を確認し、対応Workerだけにソケットの要求を追加します。追加クエリが400になればその項目を外して一度再取得し、再接続時に対応を再確認します。付加情報は同じsnapshotのルームと受理し、局IDが異なる情報や旧Workerの省略情報は表示へ使いません。表示専用の持ち駒には操作可能な種類を渡しません。

ルーム内・保存棋譜は版1のルール再生と表示用枚数を併走させ、フレームの `game` の外側へ `eliminatedHands` を保持します。完全な旧棋譜もイベントから導出でき、選択局面・回転に追従します。最終ルール状態の一致検証、保存JSON、分割イベント、manifest、D1形式、`rulesVersion: 1` を維持し、保存記録を書き換えません。検証と手動確認の境界は [テスト方針](testing.md#四人将棋の脱落後の持ち駒表示) を参照してください。

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

`@tetraboard/four-shogi/analysis` の [analysis.ts](../packages/four-shogi/src/analysis.ts) は版付き棋譜から完全なシングルス解析状態を復元し、合法手・仮遷移・状態/解析識別を提供します。[入力と識別の契約](four-shogi-ai-engine.md#完全解析状態の復元api186)に従い、表示frameを直接入力しません。[analysisInput.ts](../packages/four-shogi/src/analysisInput.ts) は外部JSONの形状と版を検証し、[replay.ts](../packages/four-shogi/src/replay.ts) は既存エンジンへイベントを渡す裁定をWebと共有します。ランタイム依存・DB/通信・ルール本体を追加せず、HTTPとWorker内部状態の接続は後続Issueで行います。

### 四人将棋の引分提案

エンジンの `setDrawProposal(state, side, proposed)` は自手番の生存者の提案・取消を処理します。`drawProposals: readonly Side[]` を保持し、全生存者の同意で終局理由 `agreement` を返します。提案操作では手番・盤面・手数・直前手・千日手回数を変えません。着手・外部脱落による自動処理の後は、通常終局を優先して残った生存者の同意を再判定します。

WebSocketの `room.game.draw.set` は `proposed`・`roundId`・`positionRevision` を必須にし、本人・局ID・revision・期限・生存・手番を検証します。変更時だけrevisionを進め、`drawProposal { side, proposed }` イベントと状態を同じトランザクションで保存・配信します。変更なしは送信者へ最新スナップショットを返します。`advanceShogiClock` の `turnEnded: false` を使い、現在の時計と期限を維持します。更新前のCPUジョブは破棄します。

CPUの同意判断は人間／CPUを識別できるルーム側で行い、CPU着手の公開APIは維持します。各CPUの手番で人間全員の提案状態に合わせて提案・取消し、終局しなければ通常の思考・着手を続けます。人間が0人の場合は提案しません。

ルームと保存済み棋譜の再生は同じイベント適用関数で提案・取消を処理し、「南 引分提案」「南 引分取消」の形式で表示します。保存済み棋譜のカードは選択局面の提案状態を表示し、再戦待機のカードは準備表示を維持します。`rulesVersion: 1` を維持し、旧保存状態に `drawProposals` がない場合は空配列へ正規化します。最終状態比較にも正規化を適用し、D1／DOのテーブル移行は不要です。

エンジン・Worker・Webのテストで手番制限、状態と時計の不変、脱落後の判定、同意成立、保存・再接続・再戦、CPU同意・取消、旧棋譜との互換性を確認します。送信中と拒否・切断後の復帰、観戦者・脱落者の操作制限、保存棋譜の局面追従はDOMテストと純粋関数で確認します。

### 四人将棋CPU

レベルごとの選択方式、探索上限、評価値、同点時の選択とAPIの契約は [ルール正本のCPU仕様](rules/four-shogi.md#cpu) を参照します。呼び出し側は `@tetraboard/four-shogi` の公開入口を使います。

```ts
import { chooseCpuAction } from "@tetraboard/four-shogi";

const cpuAction = chooseCpuAction(state, 2);
if (cpuAction !== null && state.status === "playing") {
  const cpuResult = applyAction(state, state.turn, cpuAction);
}
```

Lv1の選択をテストで再現するときは、第三引数へ0以上1未満の値を返す関数を渡します。非有限値を返した場合のTypeErrorは [公開APIのテスト](../packages/four-shogi/test/cpu.test.ts) で確認します。

実装を変更するときは次の入口を使います。

| 担当                                       | 実装の入口                                                            |
| ------------------------------------------ | --------------------------------------------------------------------- |
| 公開APIと診断付き選択、レベルの振り分け    | [cpu.ts](../packages/four-shogi/src/cpu.ts)                           |
| 探索と処理量の計上、履歴・キャッシュの分離 | [cpuSearch.ts](../packages/four-shogi/src/cpuSearch.ts)               |
| 局面の静的評価                             | [cpuEvaluation.ts](../packages/four-shogi/src/cpuEvaluation.ts)       |
| 序盤候補の構成と照合                       | [cpuOpenings.ts](../packages/four-shogi/src/cpuOpenings.ts)           |
| ルームでの選択保存とAlarmによる適用        | [fourShogiProgress.ts](../apps/worker/src/rooms/fourShogiProgress.ts) |

ルーム連携の変更では [時計計算と期限選択](#workerの時計計算と期限選択) と [ゲーム進行と共有ライフサイクル](#workerのゲーム進行と共有ライフサイクル) を確認します。ルール状態・通信・保存形式との境界を維持し、思考中の履歴を永続化しない注意点は正本と実装の両方で照合します。

関連確認は [CPU探索](../packages/four-shogi/test/cpuSearch.test.ts)、[評価](../packages/four-shogi/test/cpuEvaluation.test.ts)、[手筋](../packages/four-shogi/test/cpuTactics.test.ts)、[序盤候補](../packages/four-shogi/test/cpuOpenings.test.ts)、[オンラインルーム](../apps/worker/test/fourShogiRoom.test.ts) のテストを使います。パッケージ全体は `bun run --cwd packages/four-shogi check`、ルーム側は `bun run --cwd apps/worker test test/fourShogiRoom.test.ts` で部分確認します。比較条件・測定対象コミット・結果と限界、再測定手順は [四人将棋AIの測定・採用記録](four-shogi-ai.md) を参照します。

#190の [modelFeatures.ts](../packages/four-shogi/src/modelFeatures.ts) は固定の盤面/実手番/攻撃/取り返しと全反復辞書を疎特徴へ変換します。[trainingExport.ts](../packages/four-shogi/bench/trainingExport.ts) は#189の全再生検査後に単一manifestの教師を新規出力先へ出し、元データを書き換えません。[trainingSmokeData.ts](../packages/four-shogi/bench/trainingSmokeData.ts) は通常check外の少数実自己対戦です。Pythonの [dataset.py](../training/four-shogi-ai/dataset.py) がchecksum/分割/ラベルを、[model.py](../training/four-shogi-ai/model.py) が全履歴の共有MLPとPolicy/Valueを、[train.py](../training/four-shogi-ai/train.py) と [checkpoint.py](../training/four-shogi-ai/checkpoint.py) が決定的なCPU学習・MPS・再開契約・原子的保存を担当します。依存は [requirements.txt](../training/four-shogi-ai/requirements.txt) に固定し、通常のBun/Web/WorkerにPyTorchを含めません。[セットアップと再現コマンド](four-shogi-ai-engine.md#軽量policyvalueの学習とチェックポイント190)を使い、Linux CPU推論は#191、共通探索での実使用は#192へ引き継ぎます。

#191の [modelInference.ts](../packages/four-shogi/src/modelInference.ts) はサーバー専用の `/model-inference` 入口です。正本から疎特徴/合法手を作り、同一ホストの永続プロセスへまとめて送り、版/要求ID/実使用モデルID/数値/合法手/脱落者の席を検査します。期限超過・不正応答でプロセスを停止し、理由を呼出側へ返します。[inference.py](../training/four-shogi-ai/inference.py) が推論用配布物・Mac基準fixtureの照合・候補の起動/切替を、[inferenceSmoke.py](../training/four-shogi-ai/inferenceSmoke.py) が単発/バッチ/IPC/RSS/異環境比較を担当します。[Dockerfile](../training/four-shogi-ai/Dockerfile) は既存のPyTorchだけをCPU版で入れたLinux再現環境です。[再現手順と制限](four-shogi-ai-engine.md#linux-cpu推論とmac出力の照合191)を参照し、HTTP/Workerや現行同期CPUへ推論を混ぜません。

### 四人将棋シングルスAIの実装前整理

[Issue #184](https://github.com/yksw-clm/tetraboard-2026/issues/184)で、[READMEの開発目標](../README.md#四人将棋シングルスaiの開発計画)を起点に、[契約と判断一覧](four-shogi-ai-engine.md)を整理しました。VPSで推論しMac等で学習する前提は開発者の指示済みです。初期の規則、探索の副目的・引分同意、構成、試用範囲、障害時の動作は2026-10-14にD01〜D05の推奨案で承認済みです。具体的なAPI型や推論形式などの未決事項は担当Issueで検証します。

現在の入口は `packages/four-shogi/src/cpu.ts`・`cpuSearch.ts`・`cpuEvaluation.ts`、`apps/worker/src/rooms/fourShogiProgress.ts`・`shogiStore.ts`、Webの `fourShogiReplayV1.ts`・`fourShogiMatchReplay.ts` です。表示frameから千日手履歴が除かれること、Workerの `cpuDraw` が着手探索と別に同意を決めることを確認します。#185の現行Lv2固定は [lv2Baseline.json](../packages/four-shogi/bench/lv2Baseline.json)、新しい測定入口は [singlesCli.ts](../packages/four-shogi/bench/singlesCli.ts)。開始系列/合法対局/集計は `singlesMeasurement.ts`、履歴版の取得/hash検査は `baseline.ts`、性能は `singlesPerformance.ts` に置きます。[実行条件と使い方](four-shogi-ai-engine.md#現行lv2の固定基準と測定cli)を確認し、既存benchの旧基準と過去測定条件は維持します。

後続のエージェントは親Issueの依存と契約案の判断IDを確認し、影響する判断だけを開始条件にします。承認済みの目標・既存ルール・現行基準の調査を全項目の決定待ちにせず、変更は最新developから専用ブランチにまとめます。新パッケージやモデル形式は提案段階で、空の実装・主要依存を先に追加しません。確認分担は[契約確認](testing.md#四人将棋シングルスaiの契約確認)を参照します。

#187の `@tetraboard/four-shogi/ai` は [ai.ts](../packages/four-shogi/src/ai.ts) が版/条件の解決と識別、時間/取消/ホストへのyield、完成結果の凍結を担当します。[aiSearch.ts](../packages/four-shogi/src/aiSearch.ts) は旧Maxⁿの反復深化・並べ替えを起点に、既存の合法手/確定遷移/基底反復参照を共有し、各手番者自身の値・PVを伝播します。[aiEvaluation.ts](../packages/four-shogi/src/aiEvaluation.ts) がD01の単独1位/副順位、[aiTypes.ts](../packages/four-shogi/src/aiTypes.ts) が出力と版です。旧 `cpuSearch.ts` の並べ替え関数を共有しますが、Lv2の選択結果・初期設定は変えません。[共通APIの使用例と診断](four-shogi-ai-engine.md#共通ai解析api187)、[部分テスト](testing.md#四人将棋シングルスaiの契約確認)を参照してください。性能CLIは [analysisCli.ts](../packages/four-shogi/bench/analysisCli.ts) と既存 `singlesPerformance.ts` を使い、#185の初期/開始系列だけを完全状態復元から測定します。

#188では [aiSearchContext.ts](../packages/four-shogi/src/aiSearchContext.ts) に実行内の参照キャッシュと合法手/遷移/評価/並べ替えを共有し、[aiBudget.ts](../packages/four-shogi/src/aiBudget.ts) を共通APIと局面実験の同じ時計/取消/処理量運転に使います。[aiMcts.ts](../packages/four-shogi/src/aiMcts.ts) は4方向のUCT試行と平均/合法PV、[aiTactics.ts](../packages/four-shogi/src/aiTactics.ts) は次の実自手番までの別応手の証拠です。通常の `getCheckState` も駒一覧を一度の走査で共有し、旧単独判定と照合します。[searchExperimentCli.ts](../packages/four-shogi/bench/searchExperimentCli.ts) と [searchExperiment.ts](../packages/four-shogi/bench/searchExperiment.ts) が一要因の設定・同時間/処理量・固定Lv2との対戦を記録し、[searchTactics.ts](../packages/four-shogi/bench/searchTactics.ts) を新しい調整構図として使います。[契約](four-shogi-ai-engine.md#探索の戦術速度とmcts比較188)と[測定・採否](four-shogi-ai.md#シングルス専用aiの限定探索実験188)を参照し、旧基準と最終評価を調整へ流用しません。

## 軽量テスト

純粋関数は既存のBunプロセス、React部品・hookはBun＋happy-domの別プロセスで実行します。Workerは従来のCloudflare環境で実HTTP・WebSocket・D1・R2を検証します。全195定義の論理検証は [移管対応表](testing.md#移管対応表) を参照してください。

### 将棋の画像準備と駒表示

`shogiImageStore.ts` のURL別ストアは `idle / loading / ready / error`、準備Promiseとデコードした `Image` を保持します。同じURLの準備要求をまとめ、`decode()` 成功かつ `complete` と有効な画像寸法を確認して `ready` にします。成功・失敗はページ内で保持し、失敗の自動再試行はしません。再読み込みで新しく準備します。

`ShogiPiece` は `useSyncExternalStore` で現在のURLの準備状態を読み、準備済みなら初回描画から画像を表示します。移動先への再マウントでも画像要素ごとの `decode()` を繰り返さず、代替文字へ戻りません。準備中・失敗時は同寸法の駒名を表示します。表示用画像要素自体の失敗はその要素だけ文字へ戻し、URL変更後や別要素へ持ち越しません。URL別の購読とURLをkeyにした描画で、旧URLの完了やアンマウント後の通知から現在の表示を守ります。PNGと駒名は `shogiPieceImages.ts` で管理します。

`FourShogiBoardLayout` のマウント直後に、盤画像1枚と上下各9種類の駒画像、計19画像をブラウザ既定の優先度で一括準備します。現在の盤面のデコード完了は待ちません。参加・観戦・再戦・ルーム内棋譜・保存済み棋譜で同じ仕組みを使い、表示・通信・操作・時計は準備を待ちません。将棋ロビーの装飾盤面は表示する駒画像だけを準備し、ルームではその準備結果も再利用します。リバーシやアバター・効果音は対象に含めません。

`shogiComponents.test.tsx` は偽の画像loaderで全19URLの準備・重複排除・成功と失敗の保持、移動直後の画像表示、初回準備中・失敗時の文字、旧URLの完了と購読解除を確認します。捕獲・打ち駒・成り後の盤面と持ち駒、ドラッグ、成り候補、回転・再戦・棋譜相当の再表示も共有状態で確認します。実デコード・実描画・低速回線は自動検証に含めず、iOS Safariで参加・観戦時の着手と画像表示を手動確認します。

### 共通の実行方法

Web・Adminの `test:unit` はDOMなし、`test:dom` は共有preloadでhappy-domを準備して実行します。`test` は両方を実行します。新しいWeb DOMテストは `tsconfig.test.json`、Adminは既存の型チェックに含めます。ゲーム間の型の取り違えを検出する型テストは維持します。

対象だけを確認するときは以下のコマンドを使います。PR前にはルートの必須コマンドを実行します。

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

最新developから `feat/xxx`・`fix/xxx`・`docs/xxx`・`chore/xxx` を作り、ローカル検証を成功させてdevelop向けPRを開きます。開発環境で確認後、develop→mainのリリースPRをマージコミットで取り込みます。両ブランチへの直接push・force pushは禁止します。GitHubの既定ブランチはdevelopです。非公開リポジトリでは現在のGitHubプランによる保護を利用できないため、GitHub CI成功、必須のローカル検証成功、開発者の確認を運用で必須にします。他者レビューは必須ではありません。初回も差分と検証結果の承認後にマージし、それ以降はPRのマージを公開の契機とします。

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

### 初回の認証設定

開発環境の初回準備・ブランチ移行は次節に従います。本番用の既存Secretは維持します。

### 開発環境の準備と移行

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

### 本番の認証設定

1. Cloudflareで本プロジェクト専用APIトークンを新規作成します。「Edit Cloudflare Workers」を基に、対象アカウントだけを選び、Workersの公開に必要な権限とD1の編集権限と対象R2バケットを読み書きできる権限を付与します。workers.devでの公開には独自ドメインのZone権限は不要です。ローカルWranglerのOAuthトークンや他プロジェクトのトークンは流用しません。
2. GitHubのリポジトリ設定 → Secrets and variables → Actions → Repository secretsに `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を登録します。値をソース・PR・会話・ログに記載しません。GitHub Environmentは利用しません。
3. 初回公開直後に `bunx wrangler secret put MODERATOR_TOKEN --env production` を `apps/worker` から実行し、運営者API専用の十分に長い乱数を非表示の入力欄へ渡します。APIトークンとは別の値を使い、運営者の安全な保管先で管理します。未登録の間は運営者APIの認証は成功しません。登録後に認証付き運営者APIを確認します。

CloudflareのGit連携は設定せず、公開経路はこのリポジトリのActionsに一本化します。本番Worker・D1の名前は今後も変更せず、ドメインを変える場合も同じリソースを利用します。

### CI/CDの流れ

main・develop向けPRと両ブランチのpushでは、checksジョブで `bun install --frozen-lockfile` → `bun run check` → 本番ビルド・dry-run → 開発ビルド・dry-runを実行します。`check` のformat確認・lint・型・全テストを合わせた秒数をGitHub Actionsのsummaryに記録し、180秒を目標とします。PRジョブはCloudflareの認証情報を使いません。

main・developのpushでは同じ実行の対象環境の成果物をデプロイジョブへ渡します。成果物名は環境とSHAを含みます。対象ブランチの先頭SHAをD1マイグレーションの前後に確認し、古い実行なら公開をスキップします。mainはproduction、developはdevelopmentへ公開します。同時デプロイを環境別に禁止し、進行中のデプロイは途中キャンセルしません。先頭確認後の更新は次の実行で公開します。

独自ドメインの変更時はCD用APIトークンに対象Zoneの読み取り権限と、対象アカウントのWorkersルート・独自ドメインを更新できる権限があることを確認します。

公開後は `scripts/checkDeployment.ts` でトップページのHTML、`/api/healthz` の応答、公開ルーム一覧のスキーマ、全16戦法の画像URLの成功応答・JPEGのContent-Type・ファイル先頭の識別バイトを検証します。実画像のデコードは行いません。各リクエストにはタイムアウトと最大5回の再試行を設けています。チェック・マイグレーション失敗時はデプロイへ進まず、公開後の確認失敗もActionsの失敗として残ります。

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

ロビーナビゲーションの選択背景には `motion`（`motion/react`）を使用します。既存のHeroUI部品とCSSのアニメーションを保ち、共有レイアウトの移動に適用します。
`main.tsx` から `shared/heroui.css` を一度だけ読み込みます。このCSS内でTailwindのtheme／utilities、HeroUIの必要な公式スタイル、`shared/theme.css` を同じ生成単位として読み込みます。テーマを別のCSS入口に分けると独自色のutilityが生成されないため、読み込みを分割しません。Tailwindの全体リセットは使わず、最小リセットと共通テーマをロビー・ルーム・Portalに適用します。

共通部品は `shared/ui/` の `AppAvatar`、`AppHeader`、`AppButton`／`AppButtonLink`、`AppTextField`、`AppCard`、`AppDialog`、`AppTabs`、`AppIcon` です。HeroUIのprops・ref・キーボード操作を引き継ぎ、繰り返す見た目は部品内のTailwindクラスへ集約します。`AppButton` は `appearance`（primary／secondary／quiet／danger）と `size`（default／compact）、`AppDialog` は `size`（default／compact）で用途を指定します。`AppTextField` はLabel・Input・Description・Errorを組み合わせ、入力プロパティとrefはInputに渡します。フィールド単位のErrorはTextFieldの `isInvalid` とともに使い、フォーム全体の通信エラーは独立したalertに表示します。

`AppSelectTrigger` は時間設定で共有し、全幅・最小高さ44px・縦中央揃えを指定します。HeroUIの `Select.Trigger` のprops・ref・状態に応じたclassNameを引き継ぎます。棋譜の局面Selectは専用の寸法を使います。

`AppPageState` は既存のロビー背景とゲーム別テーマを使った画面中央の共通配置、`AppPageLoading` はスピナーとstatus文の表示です。ルートの初回fallbackとゲーム別viewのSuspense、ルーム・棋譜のエラーに使います。データ取得前は共通テーマ、取得後はloaderのゲームを使います。

`AppRouteErrorPage` は親ルートの共通エラー境界、`AppErrorPage` はProviderに依存しない復旧表示です。`main.tsx` の先頭で `installPreloadRecovery` を読み込み、ルーター初期化前に `vite:preloadError` を登録します。`preloadRecovery` は通知された `event.payload` を記録して識別し、`preventDefault()` は呼ばず既存のエラー境界へ伝播させます。ルーム・棋譜の境界も通知済みエラーを共通表示へ渡し、将棋棋譜loaderは通常の503へ変換しません。通常のAPIエラー・404・410は既存の案内を維持します。

自動更新はエラー画面の描画後、初回ロビーでは起動失敗が確定してから実行します。イベント受信直後には実行しないため、遷移先のURLを更新できます。専用の `sessionStorage` キー `tetraboard:preload-recovery:auto-reloaded` を保存できた場合だけ自動更新し、タブを閉じるまで一度に制限します。成功や手動更新でも記録を解除せず、読取・書込不可なら手動案内にします。初回ロビーでは紹介HTMLを残し、再読み込みリンクにも現在URLを設定します。

`preloadRecovery.test.tsx` のBun＋happy-domテストは両ロビーへのURL確定後の更新、文書をまたぐ上限、重複通知・StrictMode・保存領域失敗、ルーム・棋譜のReact.lazyと棋譜loader、CSS preload失敗、通常例外、紹介HTML保持と手動更新を確認します。実際の旧タブを開いたまま新版を配信する経路は手動確認し、未実施ならPRに明記します。公開HTMLの200・304と再検証キャッシュはWorkerの `publicAssets.test.ts` で確認します。旧チャンク保持方式や管理画面の復旧処理は変更しません。

`AppButton`／`AppButtonLink` の `isPending` は元の内容を配置・読み上げのために残し、見た目だけを中央のHeroUI Spinnerに置き換えます。非同期操作の完了・失敗・中止は既存の通信状態で管理します。初回・自動取得と手動の更新／再試行は `pendingSource` で区別し、共有リクエストの複数の入口では操作元を指定します。CPU操作はtransportの `pendingSettingsCommand` を参照し、設定全体のロックで他のボタンまでスピナーにしません。Context／Providerの配置と通信契約は維持します。

PCのルーム画面は `RoomLayout` に `statusBelowBoard` を渡し、`RoomBoardStatusProvider` で状況カードを盤面へ渡します。各ゲームの盤面は共通の `RoomBoardGroup` を使い、状況カードを最後のグリッド行に盤面と同じ幅で置き、盤面・プレイヤーカード・状況カード全体を上下中央に配置します。カードの実高さを `ResizeObserver` でCSS変数へ渡し、盤面の高さ計算からカードと間隔・上下paddingを差し引きます。PCのライブ盤面では盤幅の下限を外し、縮小時に下限幅がスクロールを生むことを防ぎます。自動パスの通知もグリッド行へ入れて高さを確保します。右列はルーム情報とチャットで高さを使い、スマホ・タブレットのタブ構成と保存済み棋譜の配置は維持します。

`RoomChat` は現在の `room.players` から送信者IDで画像を選び、共通の `AppAvatar` で表示します。名前・時刻と本文を右列に並べ、左列の34pxアイコンは2行をまたいで配置して上端を名前の上端にそろえます。CSS Gridで並べます。本文の1行を20px・上下余白を計14pxにし、1行の吹き出しとアイコンの高さをそろえます。複数行でもアイコンは34px固定です。名前が同じでも他人の画像を使わず、退室済み・画像なしの発言は仮アイコンにします。通信・保存データは変更しません。

`RoomViewShell` が共通の `RoomSettingsDialog` を開き、`RoomInfo` は起動ボタンだけを配置します。ダイアログのPortalで表示するため、設定の項目数はチャットや盤面の高さに影響しません。`RoomModeSetting` はルーム作成と設定のカード選択を共用し、CPUレベルはquietボタンの `CpuLevelSelector` で薄いテーマ色のホバーを使います。モード・時間・CPU一覧・三人攻撃禁止／禁手はダイアログ内で下書きにし、キャンセル時は破棄します。ログインホストの最初のCPU追加は `useCpuAddition` と共通の注意文を使い、適用時に同じダイアログ内で確認します。

`room.settings.apply` は `expectedPublicUpdatedAtMs` と全設定・希望CPU一覧を一度に送ります。既存CPUのUUIDを維持し、新しいCPUは `playerId: null` とします。protocolで重複ID・値を検査し、Workerの `prepareRoomSettings` で待機状態・編集版・ゲーム固有の項目・CPUの存在・定員を検査してから、GameRoomの一つの `withIndexTransaction` で保存・チャット通知・公開索引を更新します。失敗時はどの項目も反映しません。時間・モード・固有設定が変わる場合の準備解除とCPU変更時の既存方針、前局の棋譜を維持します。旧画面の個別設定コマンドも引き続き受け付けます。

Webの送信ロック・タイムアウト・再接続は既存transportを使います。`commonSettingsComplete` で全項目と追加CPUのレベルを照合し、確定後だけダイアログを閉じます。失敗時は下書きを保持します。編集中の公開更新日時が変わった場合は「設定を読み直す」で最新情報から下書きを作り直し、古い版での上書きを防ぎます。`roomSettingsPresentation` の無効時の透明度保持を適用中だけ使います。

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

将棋の表記仕様はREADMEと両将棋のルール正本に置きます。`shogiNotation.ts` はエンジン実装を読み込まず、固定座標・駒名・同・成／不成／打・方向語・読み上げ名を生成する純粋なWeb表示処理です。各ゲームの再生アダプターが着手前の駒と直前手、既存エンジンの合法手を渡します。四人将棋だけ、通常の補助語で区別できない龍の縦移動に直・直上・直引を使います。盤上移動だけ候補を一度取得し、成り可能性と曖昧さの判定で共有します。

`fetchEventReplay` の `createFrame(after, transition?: { before, event })` は開始局面でtransitionを省略し、各イベントでは適用前の状態とイベントを必ず渡します。ページをまたいでも状態を保ち、提案・取消・外部脱落で直前手を更新しません。ルーム内・本人・公開棋譜の取得処理と再生ルール・保存JSONは維持します。通常将棋のframeの任意 `accessibleLabel` は先手・後手を明記し、`ReplayCard` の選択値と候補へ渡します。見た目のlabelは▲・△のままです。

既存の固定棋譜JSONとチェックポイントは書き換えません。Webの互換性検証は旧表示labelを除いた全フレーム情報とイベントを比較し、新表記は別の固定期待値で確認します。期待値をテスト実行時に再生成しません。`shogiNotation.test.ts`・`shogiNotationReplay.test.ts` は全81座標・駒名・合法手候補・禁止手・全4方向／両モード・同のページ境界・入力不変を、DOMテストはSelect候補・読み上げ名・選択と回転を確認します。画面の収まりとネイティブ入力は手動確認としてPRに記載し、ブラウザ自動テストは追加しません。

スマートフォンの両ゲームのプレイヤーカードは、文字・アバター・下段情報の寸法を維持し、上下paddingを1px・高さを48pxに固定します。盤面だけの縮小ではカード寸法を変えません。リバーシの `RoomBoardLayout` はカード2段と2つの2px間隔を空き高さから差し引き、横幅との小さい方を正方形の盤幅にします。自動パス通知がある場合は15pxの行高と2pxの間隔も確保します。通常ルーム・保存棋譜の両方で低い画面にも4席を収め、名前・下段情報とカード枠の間は各2px（枠線1px＋padding1px）とします。

棋譜は新しく開始した対局から記録します。CPU対戦または4人の対戦を終局させ、最終局面が自動で選ばれること、開始局面・着手・自動パス・各種脱落をSelectと左右ボタンで確認できることを検証します。待機中の準備・設定・入退室・チャットで閲覧局面をリセットしないこと、再読み込みと再接続で復元すること、次局開始で解除されることを確認します。古い対局は最終局面のみの表示になります。
PCでは盤面領域右下、タブレット・スマートフォンでは状況カード内へ配置します。タブ切替後の局面保持と先頭・末尾でのボタン無効化を軽量テストで確認します。Workerテストは棋譜と実際の盤面の一致・パス・CPU着手・脱落原因・再取得・次局の記録更新を、Webテストは局面ラベルと自動パスの分割を検証します。表示は `ReplayCard.tsx`、選択状態は `useRoomReplay.ts`、項目の生成は `replayFrames.ts` を編集します。
両ゲームの `ReplayCard` は選択値・候補を一行で表示し、幅不足時のみ省略記号を使います。候補の `textValue` は全文を保持し、矢印・選択マークの幅と画面内の候補領域を確保します。将棋の `createFourShogiReplayFrame` は着手または外部脱落の短いラベルだけを生成し、詰み・合法手なし・同時脱落・順位の説明を付加しません。`game.eliminations` と全局面・結果は保持し、通常ルームと保存済み棋譜で同じframe生成を使います。打ち駒・成り・投了・パス・退室・時間切れ・通信切れ・同時詰みを確認し、ラベル短縮後も局面数・順位・脱落理由が変わらないことを検証します。
スマートフォンでは320px幅も含めて待機ラベル・棋譜カード・結果を一行に収め、棋譜の表示前後で状況カードの高さを維持します。

## ルーム共有の実装計画

2026-10-11に開発者が前回の提案を承認し、共有ダイアログ・X募集・OGPの仕様と以下の実装条件を確定しました。利用者向け仕様の正本は [README](../README.md#ルーム共有の確定仕様) です。同日の実装指示に基づき、機能と静的画像7枚を `feat/room-sharing` で実装しました。実装起点のdevelopは `115bedacd2169c5be5e56752c666375536423de9` です。Goalと以下の受入条件は引き続き実装の基準として維持します。

### Goal

全6ゲームで、ルーム作成直後に友達への招待・対戦相手の募集を始められる共通の共有ダイアログを提供します。ルーム内の同じ位置・寸法の「ルームを共有」からも開け、URLのコピーとXの投稿画面への移動を利用できます。共有URLにはゲームに合う画像付きカードを用意し、既存の参加・観戦・部屋世代の照合を維持します。

下記のDone Whenを満たし、差分・検証対象コミット・結果・未確認事項をレビューできるdevelop向け実装PRを提出することを実装作業のGoalとします。マージ・公開は開発者が差分と結果を承認した後に行います。

### ContextProviders

優先順位は次のとおりです。実装や過去資料と正本に食い違いがあれば、承認済み指示と正本を優先し、未決定事項を推測で確定しません。

| 優先度 | 参照元                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 用途                                                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1      | 開発者の今回の仕様確定指示と、その後の明示的な変更指示                                                                                                                                                                                                                                                                                                                                                                                                                  | 承認済みの範囲と意思決定                            |
| 2      | [AGENTS.md](../AGENTS.md)、[READMEのルーム共有](../README.md#ルーム共有の確定仕様)・[ルーム画面](../README.md#四人リバーシのルーム画面)・[共通UI](../README.md#共通uiとスタイル)・[検索向け配信](../README.md#ゲームロビーの検索向け紹介と配信)                                                                                                                                                                                                                         | Git運用、利用者向け仕様、寸法・参加・検索除外の契約 |
| 3      | [共通の作業手順](#共通の作業手順)、[Webの編集先](#webの編集先)、[ロビーのSEO生成](#ロビーのseo生成と成果確認)、[部屋の指定と検索](architecture.md#部屋の指定と検索)、[テスト方針](testing.md)                                                                                                                                                                                                                                                                           | 共通部品・状態・配信・検証の責務                    |
| 4      | [useRoomEntry.ts](../apps/web/src/features/lobby/useRoomEntry.ts)、[useRoomInvitation.ts](../apps/web/src/features/room/useRoomInvitation.ts)、[RoomInfo.tsx](../apps/web/src/features/room/RoomInfo.tsx)、[RoomViewShell.tsx](../apps/web/src/features/room/RoomViewShell.tsx)、[roomAccess.ts](../apps/web/src/shared/roomAccess.ts)、[pageMetadata.ts](../apps/web/src/seo/pageMetadata.ts)、[publicAssets.ts](../apps/worker/src/publicAssets.ts)、既存の関連テスト | 作成・招待・メタ情報・HTML配信の実装と回帰          |
| 5      | [X公式Web Intents](https://docs.x.com/x-for-websites/web-intents/overview)、[Open Graph公式仕様](https://ogp.me/)、Git履歴と関連Issue・PRが利用できる場合はその記録                                                                                                                                                                                                                                                                                                     | 外部仕様と変更理由。実装時にも一次資料を確認        |

ゲーム名・ハッシュタグは軽量ゲームカタログを参照します。ゲーム固有のルールと盤面表現を確認する場合は、[変更対象別の案内](#変更対象別の案内)から対象ゲームのルール正本へ進みます。

### Constraints

- 全6ゲームの共通ロビー・ルームへ接続します。自動表示は通常の作成成功直後の作成者に1回だけとし、「すぐ遊ぶ」・参加・観戦・再読み込み・再接続・戻りでは開きません。URLに自動表示用の共有フラグを含めず、参加先に自動表示の意図を引き継ぎません。
- 既存ボタンの文言と動作を置き換え、幅・高さ・余白・配置・周囲のレイアウトを変えません。既存のHeroUI・AppDialog・ボタン・toast・ゲームテーマ・フォーカス制御を使います。
- 共有URLは既存の部屋番号と `instanceId` を使い、コピーとXで一致させます。参加資格トークンを含めず、招待先の参加案内、登録からの復帰、参加資格の保存と世代照合を変更しません。
- 満室・対局中のX募集抑止は最新のルーム状態へ追従します。Xは別タブの投稿画面を開く方式とし、自動投稿、投稿完了の推測、XのAPI認証・連携、外部SDKを追加しません。
- ゲームごとの静的画像6枚と共通画像1枚を配信します。動的な人数・名前・募集状態を画像へ埋め込まず、実行時の画像生成サービス、新しい依存技術、ルームごとの画像生成を採用しません。
- Workerは直接アクセスの初期HTMLへゲームに対応するメタ情報を設定します。部屋世代が異なる・存在しない・期限切れのURLは共通カードにし、古いリンクに再利用後の別ルームのゲーム情報を載せません。取得失敗によって既存の画面配信や参加を妨げない構成にします。
- ルームのHTML・HTTPのnoindex、開発環境のOriginと検索除外、総合ロビーと6ゲームのサイトマップ、API・WebSocket・認証Cookie・HTTP配信の契約を維持します。メタ情報とキャッシュをルーム間・環境間で混在させません。ゲーム進行、時計、参加資格、棋譜・戦績の保存形式を変更しません。
- 検証はBun純粋関数、Bun＋happy-domの部品・hook、Worker統合テストへ集約します。ブラウザ起動型のテストは追加せず、画面寸法・ネイティブ入力・実画像デコード・Xの実表示は手動確認します。
- 実装は最新developから作業ブランチを作り、develop向けPRを使います。main・developへの直接pushとforce pushは行いません。必須ローカル5コマンドとGitHub CIの成功を確認し、マージ・公開には開発者の承認を得ます。

### Done When

以下をすべて満たしたら実装作業を完了とします。外部共有先のキャッシュ反映やカード表示の保証は完了条件に含めず、実際に確認できた範囲を記録します。

1. 全6ゲームの通常作成成功後、作成者のルーム画面に共有ダイアログが1回だけ開くことと、対象外の入口・再読み込み・再接続・戻り・他の閲覧者で開かないことを検証できている。
2. ルーム内の「ルームを共有」から対局者・観戦者が開け、閉じる・Escape・フォーカスの閉じ込めと復帰・背景ぼかし・小さい画面でのスクロールを確認できている。既存ボタンの幅・高さ・余白・配置と周囲のレイアウトが変更前と一致している。
3. 正しい世代の共有URLを表示し、コピー成功の3秒toast、失敗時の案内・手動選択・再試行・重複操作抑止を検証できている。共有URLからの既存の参加案内と参加・観戦・登録復帰が回帰していない。
4. 全6ゲームの投稿文・ハッシュタグ・URLが正しく、Xの投稿画面を別タブで開ける。満室・対局中の無効化と案内、空席へ戻ったときの有効化、表示中の状態変更を検証できている。
5. ゲーム別画像6枚と共通画像1枚が用意され、全ゲームの共有URLの初期HTMLに正しいOGP・X用メタ情報がある。世代不一致・存在しない・期限切れのルームは共通カードを返し、メタ情報の取得失敗でも既存画面へアクセスできる。ルーム間・画面内遷移・開発／本番でメタ情報が混在しない。
6. 画像配信とHTMLのGET／HEAD・条件付きリクエスト、noindex、API・WebSocket・認証Cookieと既存ロビーSEOの回帰を検証できている。[テスト文書の受入項目](testing.md#ルーム共有の確認)に対応した純粋関数・DOM・Worker統合テストが成功している。
7. PC・スマートフォンで既存ボタンの寸法・配置、ダイアログの閉鎖とURL選択、画像の読み込みと見栄えを手動確認している。Xの投稿画面への遷移と実際のカード表示は承認後に開発者が行う投稿で確認し、確認環境・結果・キャッシュなどによる未確認事項を記録している。検証目的の外部投稿を実装担当者が無断で行わない。
8. README・開発文書・テスト文書を実装状態に合わせて更新し、関連文書に旧操作を現在仕様として残していない。対象コミットで `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run`、`bun run build:development`、`bun run --cwd apps/worker deploy:dry-run:development` とGitHub CIが成功し、対象コミット・環境・各結果・未確認事項を記載したdevelop向け実装PRがレビュー可能になっている。

### 実装の責務と確認状況

- 軽量な `@tetraboard/protocol/room-sharing` に共有URL・募集文・募集可否・メタ情報を集約します。エンジン・Zod・Reactへ依存しません。
- `useRoomEntry` は通常作成の成功時だけ `roomShareIntent` を作成してルーターのstateへ渡します。nonceをメモリに保持し、作成者・世代・ホスト資格を照合します。`useRoomInvitation` の初期表示後に意図を消費するため、StrictMode・履歴stateの複製でも初回表示を保ち、戻り・再読み込みでは再演しません。共有URLにはこの意図を含めません。
- `RoomShareDialog` は既存 `AppDialog`、入力欄・ボタン・toastを使用し、コピー失敗の案内、再試行、閉鎖後やunmount後の遅い完了の破棄、最新ルーム状態によるX募集の無効化へ対応します。`RoomInfo` の既存ボタンの寸法・配置のクラスは維持し、文言と操作を置き換えます。
- Workerの `roomShareHtml` はルームHTMLをHTMLRewriterで処理します。`GameRoom.getShareMetadata` は保存状態を読み、世代・24時間の閉鎖期限・人間の復帰期限を照合します。normalize・期限処理・CPU・保存・索引更新は呼びません。情報の取得失敗または1500msの期限では共通カードを返します。
- ルームHTMLは生成元のETag・更新時刻・Content-Length・Content-Encodingを引き継がず、条件付き取得にも新しいHTMLを200・no-storeで返します。HEADは本文なしです。静的画像7枚は `/assets/ogp/` のPNGで既存の資産配信・HEAD・304を使用します。ゲーム名・画像・URLは同じメタ情報生成関数を使い、Webのルーターから確定したloaderデータで更新して、画面間の残存を防ぎます。
- OGP画像は既存のfavicon・将棋の盤と駒、エンジンの初期盤面を使って構成しました。五目並べは15路の初期空盤を描きます。全7枚の1200×630・PNG形式・5MB未満をファイルヘッダーで検証し、全画像の原寸・縮小した一覧を目視確認しました。画像生成の実行時依存はありません。
- 自動検証の入口は [共有の純粋関数](../apps/web/test/roomSharing.test.ts)、[共有の部品・hook](../apps/web/test-dom/roomSharing.test.tsx)、[Worker共有配信](../apps/worker/test/roomSharing.test.ts)、[既存資産配信](../apps/worker/test/publicAssets.test.ts) です。検証対象コミットと必須コマンド・GitHub CIの結果はPRに記載します。
- PC・スマートフォンの実画面での寸法・配置、ネイティブのクリップボード・URL選択・Escape・フォーカス・Xへの遷移と実際の投稿カードは未確認です。自動テストのDOM・操作検証や画像単体の目視確認を、これらの実機確認の代替にはしません。PRの未確認事項として引き継ぎ、マージ・公開は承認後に行います。

## ダイアログ・脱落理由の確認

PCでは棋譜表示の有無で盤面と全プレイヤーカードの座標・寸法を維持し、右下の棋譜カードと重ならない配置とします。Selectの上下中央揃え、44×44pxの閉じるボタン、順位と理由・石数の収まり、観戦案内の一行表示という画面仕様は維持します。
ロビー・ルームのダイアログはキーボード開閉・スクロール・画面回転時も背景全体のぼかしと確定ボタンへの到達を維持します。フォーカスの閉じ込めと復帰も画面仕様として維持します。送信中の閉鎖防止はDOMテストで確認します。
`Room.eliminations` は対局中の色と脱落理由を保持し、待機中と次局開始時は空になります。脱落を盤面・棋譜と同じトランザクションで記録し、GETとWebSocketに配信します。旧保存データでこの項目がない場合は保存済み棋譜から復元し、記録がなければ理由を推測しません。Workerテストは4種類の理由の保存・配信・再取得・途中観戦・旧形式の復元と次局の初期化を、Webテストは順位ラベルと記録がない場合の表示を確認します。

## プライバシー・規約・退会の実装計画

2026-10-12に開発者が仕様確定と計画作成を指示しました。ゲスト名は棋譜に保存・公開する現行仕様を維持し、それ以外のプライバシー・規約・退会対応を採用します。追加回答で「13歳以上・未成年は保護者同意」、運営者 `chaossi`、窓口 `support@tetraboard.net` を承認しました。利用者向け仕様の正本は [README](../README.md#プライバシー利用規約退会の確定仕様) です。

開発者の実装指示に基づき、最新 `origin/develop` の `0dc26da` から作った `feat/privacy-account-deletion` で、以下の全実装と検証までを1件のdevelop向けPRにまとめます。仕様文書だけのPRへ分割しません。マージ・公開・Googleへの審査申請はレビュー可能な差分と結果を用意した後の承認対象です。実装では共通のD1移行・削除境界に依存する計画2〜8を、認証の整理と、公開文書・同意・計測・退会の実装／検証へまとめます。各対象を検証してからコミットし、最後に運営手順と検証結果を記録します。

### Goal

TetraBoardの全6ゲームで、ゲスト名を含む棋譜公開を参加前に説明し、未ログインで読める `/privacy`・`/terms`、規約と年齢条件の確認、常時計測の明示と個別計測の90日期限、再認証付きの退会を提供する。退会した本人の名前・画像・認証情報・棋譜の本人参照等を削除し、相手の棋譜・結果・戦績を維持する。保存待ち・再送・部屋の再起動・バックアップ復元で本人情報が復活しない手順を整え、仕様・実装・必要なマイグレーション・検証を同じPRでレビューできる状態にする。

文書の作成だけではこの実装Goalを達成したことにしません。PRの完了と本番公開後の確認を分け、Googleの審査成功・本番反映をPR提出時の自動テスト成功と同一視しません。

### ContextProviders

1. この会話の開発者の承認。ゲスト表記と保存名の維持、その他の推奨案の採用、年齢・運営者・窓口、同じPRで扱う指示を最優先にします。
2. [AGENTS.md](../AGENTS.md) のブランチ・日本語コミット・承認・ローカル検証・GitHub CIの規約。
3. [READMEの確定仕様](../README.md#プライバシー利用規約退会の確定仕様) と認証・棋譜・プロフィール・チャット・計測・フィードバック・公開環境の各節。ゲーム固有の退出結果は各ゲームのルール正本を参照します。
4. この実装計画、[構成文書](architecture.md#プライバシーと退会の構成方針)、[テスト方針](testing.md#プライバシー規約退会の確認)、既存のデータ契約・D1 migration・DO保存待ち・固定棋譜。
5. Git履歴、利用できる閉じたIssue・PR。認証・ゲスト名記憶・公開棋譜・現在プロフィール参照・計測・通報・フィードバックの採用経緯を確認します。過去の未保存・無期限計測を新仕様の根拠にしません。
6. 実装で使用する版のBetter Auth公式文書とGoogle／Discord／Cloudflareの公式文書・設定。取得情報・プロバイダー解除方式・バックアップとログの期限は実測と設定を照合します。秘密値や実ユーザーの情報をPR・テストfixture・会話へ出しません。
7. [Google OAuthポリシー](https://developers.google.com/identity/protocols/oauth2/policies)、[ブランディング要件](https://support.google.com/cloud/answer/15549049?hl=en)、[ユーザーデータポリシー](https://developers.google.com/terms/api-services-user-data-policy)、[個人情報保護委員会のガイドライン](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/)。外部規則との不整合は明示し、承認済み仕様を黙って変更しません。

### Constraints

- 既存のBun・TypeScript・React・HeroUI・Better Auth・Worker・D1・Durable Object・R2を使います。新しい主要依存・認証方式・外部サービスを追加しません。
- 全6ゲーム、ゲスト戦・CPU戦、現行の名前保存と棋譜公開を維持します。完全匿名化、非公開ルーム・非公開棋譜、ゲスト棋譜の一括移行、アカウント連携、データエクスポート、課金は追加しません。
- 退会による変更は本人の情報・参照に限定します。棋譜の着手・イベント・盤面・順位・撃破数・日時・時間設定・相手の履歴を変えず、ゲームルールの版を更新しません。ゲストの過去名を一括で置換しません。
- 退会状態と、元から参照先がない旧記録を区別します。削除済みの内部参照を、ゲストや別の再登録者へ読み替えません。退会表現は全ゲームの保存読取り・公開応答・UI契約で扱い、旧記録との互換を検証します。
- 再認証は同じプロバイダーの同じ本人と最近の認証を確認します。別の通常ログインを再認証の代わりに使い、削除対象を切り替えません。削除操作は本人限定・同一Origin・期限付き一回用確認・回数制限で保護します。
- D1・DO・R2・外部プロバイダーの一括トランザクションを仮定しません。受付は永続化し、即時の利用停止・表示除去と、物理削除・解除の完了を分けます。再実行可能な処理と毎時の回収で失敗・中断から再開します。重複受付で新規アカウントを削除しません。
- 退会のための旧アカウント識別、削除対象索引、復元後に削除を再適用する情報は最小限にし、非公開で目的と期限を決めます。古い再送を拒否するための必要情報を削除し、後から旧名を復活させる順序にしません。必要期間を確認しないまま「全情報を即時完全消去」と記載しません。
- プロバイダー権限はログインに必要な範囲だけに限定します。Google設定とライブラリの実際の要求を一致させ、不要な長期トークンの取得・保存を減らします。メール照合だけによる自動統合とGoogle／Discordの本名・画像の自動公開を行いません。
- 利用計測は常時実施し、項目・具体的目的・関連付け・保存期間を規約とポリシーで説明します。ON/OFF設定は設けず、広告利用・販売・他サービスの追跡を行いません。登録前後の人物統合や端末間のゲスト統合をせず、Cookie拒否を回避する指紋採取を行いません。認証・ゲーム参加・投稿制限用Cookieは別の用途として扱います。
- 長期集計へ個別ID・対局IDや復元用対応表を残しません。日別ユニーク数の合算を期間ユニーク数と表示しません。90日期限で保証できない指標は対象範囲を表示して算出不可にします。
- 公開URL・メール等へ未設定の仮値を出しません。文書の内容とボタン操作による同意の対応を明示し、年齢の厳密な認証・完全な匿名化・第三者保存の回収・未確認のバックアップ期限・Googleの審査通過を保証しません。
- 自動検証は純粋関数のBunテスト、Bun＋happy-domの部品・hookテスト、Worker統合テストです。ブラウザを起動する自動テストを追加せず、実画面とGoogle／Discord認証・メール受信等は手動確認を記録します。checkの目標は180秒以内です。

### 実装の入口と順序

1. **保存情報の棚卸しと認証。** `accounts/auth.ts`、認証ルートの許可リスト、D1の `user`・`account`・`session`・`verification`、`account_room_seats`、ルームのプロフィール・資格、履歴・バッジ・計測・通報・フィードバック、R2、ログ・バックアップを列挙します。情報・目的・取得元・保存先・公開範囲・期限・退会処理・再送元を同じ実装案内へ記載します。Google／Discordの実scope・名前・画像・IP・user agent・トークンの動作を確認します。
2. **公開文書と確認導線。** router・`publicAssets.ts`・静的生成、共通UI、`RoomEntryDialog`・登録案内・ログイン・初回設定へ日本語文書とリンク・公開説明・同意確認を追加します。新規・既存登録者とゲストが、説明を読んだ後のボタン操作で現在版への同意と年齢条件を確認するようにします。ゲスト名の説明は全参加経路で実際の送信前に表示します。
3. **計測の明示と期限。** `analytics/pageAnalytics.ts`、Workerの `analytics/routes.ts`・`store.ts`、DOの計測保存待ち、管理画面と毎時処理で常時計測・90日境界・長期集計を扱います。旧ON/OFF Cookieに依存しないこと、設定APIを提供しないこと、過去の90日超データの集計・削除、遅延送信・再送による復活防止を検証します。正しく算出できない旧期間指標をUIで案内します。
4. **退会の受付と公開抑止。** 再認証確認、退会状態・作業索引・進捗、読み取りと編集の拒否を追加します。プロフィール・ランキング・公開棋譜・相手履歴で旧名を即時に出さない判定を共有します。本人履歴以外にもゲスト・CPUと混在した全保存記録、将棋の転送中manifestを対象として発見できる索引を用意します。
5. **本人情報の除去と再送対策。** D1保存済みJSONと履歴、将棋のmanifest・チャンク、DOの席・資格・開始時メタデータ・直前局・保存待ち・計測待ち、R2の旧画像と参照、フィードバックと編集履歴を処理します。ゲーム進行データと将棋の元JSON照合を保ち、退会処理前後で二重の保存や不整合を起こしません。連携解除の失敗を再試行し、画像が他のルーム参照を理由に残り続けないようにします。
6. **退会UIと運営手順。** マイページの入口、在室の案内、再認証復帰、最終確認、処理中・完了・失敗時の再試行を追加します。接続中のクライアントへ失効を同期し、ほかの端末も次の通信で取得済み本人情報を破棄します。閉じた端末や第三者の保存を遠隔消去できるとは案内せず、再登録は新規として処理します。削除依頼・通報の例外保持・メール窓口・バックアップ復元後の削除再適用を運営手順へまとめます。
7. **検証と提出。** [検証項目](testing.md#プライバシー規約退会の確認) と必須コマンドを成功させ、文書・コードの旧説明を検索し、同じブランチからdevelop向けPRを提出します。未確認の本番設定・外部審査は公開前の条件として明示します。

### Done When

PR提出・レビュー可能な状態の条件は次のすべてです。

1. ゲスト名の保存・公開が維持され、全6ゲーム・全参加導線で事前説明と規約リンクが確認できる。登録者・観戦者への公開範囲と検索対象外の意味も説明されている。
2. `/privacy`・`/terms` が未ログイン・初回設定前の直接アクセス・再読み込みで読める。運営者と窓口、文書版・日付、取得情報と目的・保存期間・削除依頼・未成年条件・公開棋譜・外部サービスの説明が実装と一致する。
3. 新規／既存登録者とゲストに同意・13歳以上・未成年の保護者同意の確認があり、文書改定時の再確認が機能する。ボタン直前の説明と直後の文書リンクを登録案内で共用し、ゲスト参加も対応する。生年月日を保存せず、計測の具体的項目と目的を説明する。
4. 計測はON/OFFを設けず、目的とCookie・内部IDの関連付けを規約・ポリシーへ明記する。90日境界と毎時削除、過去データ移行、再送・失敗の再試行が動作する。長期集計と管理画面が不正確なユニーク数・継続率を表示しない。
5. 退会は同じ本人の再認証と最終確認を要求し、別人・取消・期限切れ・Origin違反・未認証・在室競合を拒否する。受付後に全セッション・席資格が無効で、プロフィール・ランキング・管理一覧から除外される。
6. 退会者が公開棋譜・相手履歴・ルーム内の棋譜／結果で退会者表記となり、保存名・公開ID・画像・プロフィールリンク・本人参照が残らない。元から参照先がない旧記録と区別され、ゲスト名・相手の結果と履歴は維持される。
7. メール・プロバイダー識別子・トークン・プロフィール・同意・本人履歴／バッジ・個別計測・本人フィードバック等の削除を保存先ごとに確認する。R2・外部解除・DO通信・D1書込の失敗から再開でき、完了前に完了表示を出さない。
8. 保存待ち・転送途中・再送・再起動・部屋閉鎖・番号再利用・同時編集／参加・再登録があっても旧情報が復活しない。全6ゲームと既存固定棋譜の再現、相手の勝敗・戦績、認証・プロフィール編集の回帰が成功する。
9. 変更対象のREADME・構成・開発・テスト文書を更新し、期限なしの個別計測・退会者の旧名フォールバック等の旧説明を残さない。対象コミット・環境・結果・未確認事項をPRに記載する。
10. `bun run check`、`bun run build`、`bun run --cwd apps/worker deploy:dry-run`、`bun run build:development`、`bun run --cwd apps/worker deploy:dry-run:development`、文書整形・リンク確認、`git diff --check` が成功する。PRのGitHub CI成功も別途確認する。

公開前は、開発環境での実OAuth再認証・退会・連携解除と全端末失効、文書表示と全参加導線、`support@tetraboard.net` の受信、Googleの所有ドメイン確認と本番scope・3つのURL、Cloudflareのバックアップ／ログ期限・処理先、復元時の削除再適用手順を確認します。確認した設定と文書を一致させ、マージ・公開の承認を得ます。本番URLでの確認とGoogle審査は公開後に記録し、未確認のまま成功扱いにしません。

### コミット計画

すべて `feat/privacy-account-deletion` の同じPRに含めます。各実装コミットに対象の意味のあるテストと関連文書の更新を含め、最後のテストコミットまで検証を先送りしません。

1. `docs: プライバシーと退会の仕様と実装計画を確定する` — README、Goal・ContextProviders・Constraints・Done When、構成・検証案内を追加する。
2. `chore: 認証情報の取得と保存を必要な範囲に整理する` — 保存情報の棚卸し、scopeと不要なトークン保存の見直し、認証回帰を行う。
3. `feat: 規約とポリシーの公開ページと同意確認を追加する` — 公開文書、全参加導線のゲスト名公開説明、年齢・版別同意とリンクを追加する。
4. `feat: 利用計測の説明と保存期限を追加する` — 常時計測の目的・関連付け、90日期限と長期集計・管理表示・移行を追加する。
5. `feat: 再認証付きの退会受付と退会者表示を追加する` — 再認証と本人確認、退会状態・進捗、公開抑止と全棋譜契約、本人操作の拒否を追加する。
6. `feat: 退会時の情報削除と保存再送の復活防止を追加する` — D1・DO・R2・フィードバック・外部連携の処理、再開・再送・転送途中・部屋再利用の対策を追加する。
7. `feat: マイページの退会操作と削除状況の案内を追加する` — 在室確認、再認証復帰、最終確認、処理中・完了、全端末失効後の画面と再登録を追加する。
8. `test: 退会と計測期限の統合回帰を確認する` — 全6ゲーム・相手履歴・固定棋譜・障害復旧・同時実行・旧データ移行を横断して検証する。
9. `docs: プライバシー対応の確認結果と公開手順を記録する` — 実装入口と確認記録、削除依頼・復元手順、Google登録URL、バックアップ・ログと未確認事項を更新する。

各コミットは変更規模に応じて分割できますが、同じPRにまとめる方針と完了範囲は維持します。計画だけの段階で実装済み・ローカル検証成功・CI成功を記載しません。

仕様確定・認証情報の整理・実装と統合回帰・運営文書の後、開発者の追加承認により、常時計測とボタン操作の同意へ改める変更を同じPRへ追加します。ON/OFFのUI・API・Cookie判定・切替RPCと同意チェック／端末保存を除去し、保存期限・退会・復活防止の範囲は維持します。検証対象コミット・macOS／Bun／Nodeの実行環境・必須5コマンド・文書整形とリンク・差分確認・GitHub CIの結果はPRに記録します。外部サービス・実機の未確認事項は公開手順とPRに残します。

### 実装・保存情報の棚卸し

公開文書の本文・版は [privacy.ts](../packages/protocol/src/privacy.ts)、画面は [privacy/](../apps/web/src/features/privacy/)、初回HTMLは [legalHtml.ts](../apps/worker/src/privacy/legalHtml.ts) にあります。OAuth開始と成功したコールバックの同意を結び、登録者はD1に版・日時を保存します。登録・参加・初回設定の操作時に現在版を送信し、同意チェックや端末の同意保存に依存しません。参加APIも現在版の確認を要求します。説明は `LegalNotice`、リンクは `PrivacyLinks`、登録ボタン群は `SocialSignInButtons` で共用し、文書リンクは別タブで開きます。プロフィール設定前でも規約と退会ページを読めます。

| 情報・取得元                                                       | 目的・保存先・公開範囲                                                                       | 保存上限・退会・再送元                                                                                                                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Google／Discordの識別子、メール・確認状態                          | 本人確認。D1 `user`・`account`、非公開                                                       | 利用中。受付時に利用停止、外部解除後に物理削除。再登録は新しいID                                                                         |
| プロバイダーの名前・画像、IDトークン                               | OAuthコールバック内の基本プロフィール確認                                                    | 名前・画像を公開プロフィールに転記せず、IDトークンとrefresh tokenを保存しない。旧トークンもmigrationで除去                               |
| access token、scope・有効期限                                      | 連携解除。Better Authの暗号化を使いD1 `account` に保存                                       | 現在のトークンだけを保存。退会中の解除用コピーも暗号化のまま、解除後に削除。秘密鍵は既存 `BETTER_AUTH_SECRET`                            |
| Cookie、セッションID・IP・user agent                               | 認証・不正対策。D1 `session`、HttpOnly Cookie                                                | セッション7日、更新1日。期限切れを毎時回収、退会受付で全セッション削除。Cookieキャッシュからも旧本人を採用しない                         |
| OAuth state／PKCE・同意state・再認証challenge                      | 認証と同意／削除操作の対応。D1 `verification`・`oauth_legal_consents`・`deletion_challenges` | 同意stateとchallengeは10分で無効、削除対象を固定するflowは最大1日。期限切れを毎時削除。通常ログインを削除確認に流用しない                |
| 公開名・公開ID・画像                                               | プロフィール。D1 `user`、R2 `avatars/`、公開API                                              | 現在プロフィールを公開。受付で参照除去・画像配信抑止、DOの旧画像参照も回収し、R2失敗は再試行                                             |
| 席、資格、開始時プロフィール・直前局・保存待ち                     | ゲーム。DO KV、D1席予約・部屋索引・画像参照・アップロード待ち                                | 在室中は受付不可。退会で資格・表示・保存待ちの本人情報を除去。古い非同期処理は現在KVとD1制約で復活を抑止                                 |
| 棋譜・結果・日時・設定・ゲスト名                                   | D1 `matches`、将棋manifest／chunks、相手履歴。公開                                           | 期限なし。退会者だけを `retired: true`、本人参照なしに変換。着手・イベント・結果・ゲスト名を保ち、転送途中も照合して公開                 |
| 本人履歴・戦績・バッジ・通知・同意                                 | D1索引・集計・通知・`legal_consents`                                                         | 退会で本人索引・バッジ・通知・同意を削除。相手の索引と結果は維持                                                                         |
| チャット・システムログ／通報証拠                                   | DO直近100件／D1 `reports`。チャットは観戦者も閲覧、証拠は管理者だけ                          | 部屋閉鎖で通常ログを除去。退会者の送信者名と入退室ログをマスク。通報証拠は7日、本文中の個人情報は窓口で個別確認                          |
| 計測Cookie・閲覧・滞在・対局参加者                                 | ブラウザ送信とDO保存待ち、D1 `analytics_*`。管理者だけ                                       | Cookie最大1年、個別記録90日。常時計測と関連付けを明記し、ON/OFF・選択Cookie・設定APIを提供しない。退会で本人の個別行を削除               |
| 長期の閲覧・滞在・対局・退会者の登録数                             | D1日別集計、管理者だけ                                                                       | ID・対応表を含まない集計を期限なしで保持。日別人数を期間ユニークへ足さない。終了不明の古い対局と初回観測不明の継続率は「—」              |
| フィードバック本文・画像・技術情報・編集履歴・投稿者HMAC           | D1 `feedback*`、R2 `feedback/`。管理者だけ                                                   | 180日、退会で原文・画像・履歴・本人由来の制限キーも削除。旧HMAC形式と新account列を照合。削除後の画像再送も削除キューへ戻す               |
| 削除済みID・旧部屋世代とプレイヤーID・受付／完了時刻・資格ハッシュ | D1 `deleted_accounts`・`privacy_room_players`。非公開                                        | 再送・復元による復活防止のためサービス運営中。メール・プロバイダー識別子・名前・画像を含めない。作業中の画像・解除トークンは完了時に除去 |
| 障害ログ・提供者バックアップ                                       | Cloudflareの実設定、提供者の管理機能                                                         | 保存先・処理先・保存期間は公開前に実設定を確認。復元前に削除台帳を確保して再適用。利用者の端末や第三者の保存は遠隔消去できない           |

認証ライブラリのログ出力を停止し、アプリ側でも障害の種類だけを記録してOAuth応答・トークン・メールを記録しません。HTTPSの `__Secure-` 認証Cookieも同意・再認証・失効の対象です。

Googleの要求は `openid email profile`、`access_type=online`、Discordは `identify email` です。退会と画像アップロードの競合では先にアップロード待ちをD1へ登録し、受付が新しい画像の削除先も取得します。進行中は削除を完了にせず、終了または10分の中断判定後に回収します。期限後に遅れてアップロードが終わった場合も削除キューへ戻し、失敗した画像削除を再試行します。

新しいトークンは暗号化し、導入前の平文access tokenは `migrateOAuthTokens` が毎時最大100件ずつ、元の値が変わっていない場合だけ暗号化します。初回導入では全件の変換が完了したことを公開前に確認します。解除用の暗号化キーを、未完了ジョブがある間に破棄しません。現行のトークン取扱いは [Google OAuthポリシー](https://developers.google.com/identity/protocols/oauth2/policies) と照合しています。

退会APIの入口は [deletionRoutes.ts](../apps/worker/src/privacy/deletionRoutes.ts)、段階処理は [deletion.ts](../apps/worker/src/privacy/deletion.ts) です。`POST /api/account/deletion/reauth` →同じproviderのコールバック→ `GET /api/account/deletion/confirmation` → `POST /api/account/deletion/confirm` を使います。challengeはHttpOnly Cookie、同じ本人・新しいセッション・OAuth state・provider・10分期限を照合し、開始を1分5回までに制限し、取消や在室拒否でも直近の試行回数を消しません。削除対象をflowで固定し、別人で再認証した後に対象を切り替えません。手続きの取消は `POST /api/account/deletion/cancel` を使い、アカウントを削除せず確認資格を失効させてflowを破棄します。最終操作は同一Origin・`confirm: true`・一回用challengeと在室の再検査が必要です。202で受付資格を返し、セッションを失効させた後は `POST /api/account/deletion/status` が資格ハッシュで状態だけを返します。

### 公開前・運営・障害復元の手順

1. 開発環境で `0014_privacy.sql` とコードを適用し、旧access tokenの変換完了、毎時処理、D1・DO・R2の削除・解除失敗の再試行を確認します。未完了ジョブの件数・最終試行時刻を運営者が調べ、内容・メール・トークンをログやIssueに転記しません。
2. Google／Discordの実OAuthで同じ本人・取消・別人・期限切れ・在室拒否・全端末失効・新規再登録を確認します。scopeとURLをコンソール設定に合わせます。Googleのホームページは `https://tetraboard.net/games/four-reversi`、ポリシーは `https://tetraboard.net/privacy`、規約は `https://tetraboard.net/terms` とし、所有ドメインを確認します。開発と本番のOAuthプロジェクトの分離も確認します。
3. 運営者が `support@tetraboard.net` の受信・返信と窓口の継続管理を確認します。削除依頼は対象URL・本人の事情を確認し、同名ゲストだけで本人と断定しません。本文や転載の個人情報を個別に確認し、処理内容と必要な証拠保持期限を本人へ案内します。残す開発課題は個人情報を除いてIssueへ移します。
4. CloudflareのD1復元可能期間、R2とログの保存・閲覧権限・処理先・保存期間を実設定で確認し、公開文書へ必要な具体値を反映します。自動テストのローカルR2削除を提供者のバックアップ消去と扱いません。
5. 障害復元では先に受付後の削除台帳と未完了ジョブ、画像の削除先索引を保護された保存先へ確保し、通信受付を停止します。D1／DOを復元しても公開を再開する前に新しいコードとマイグレーションを適用し、確保した削除済み識別子・旧部屋世代の対応を戻します。復元した本人の情報へ削除処理を再適用し、棋譜・索引・DO・R2・認証が戻っていないことを検証してから再開します。削除台帳まで古い時点へ巻き戻して公開しません。
6. ローカルの必須5コマンドとGitHub CIの結果、上記の外部確認をレビュー可能にし、develop向けPRのマージ承認を得ます。開発環境の確認後、develop→mainのリリースPRで公開承認を得ます。本番URLの全文表示・リンクとGoogle審査の結果は公開後に別途記録します。

実OAuth・メール受信・提供者バックアップ／ログ設定・実機の文章と操作の確認は自動テストでは保証せず、PRの未確認事項にも記載します。

## Google認証とアカウント移行

### セッション更新Cookie

Better Auth 1.7.5の既定値（有効期間7日・更新間隔1日）を維持します。`accountIdentity` は `getSession({ headers, returnHeaders: true })` の本文で本人を確認し、生成された全 `Set-Cookie` を保持します。期限切れ時の削除Cookieも引き継ぎます。

Workerの最終HTTP応答を `withAccountSessionCookies` で包み、元の `Request` をキーとする `WeakMap` へリクエスト内のCookieを集めます。アカウント・バッジ・棋譜・戦績・ルーム入室・フィードバック・計測・管理APIと、Honoを通らない管理画面の認証も同じ応答境界を使います。本人確認をしない経路でセッションを読み取ることはありません。Cookieは `headers.getSetCookie()` で個別に取得し、既存の応答Cookieへ `append` します。属性・本文・status・WebSocketを保持し、終了時は例外の有無にかかわらず収集状態を破棄します。セッション更新後のプロフィール取得や権限判定が失敗しても、生成済みのCookieを最終応答へ返します。

`bun run --cwd apps/worker test test/sessionCookieRenewal.test.ts` で更新境界・複数Cookie・属性・失効・障害・並行リクエストを確認します。ブラウザでのCookie保存と本番QAのログイン喪失との因果関係は、このWorker統合テストだけでは確認できません。認証喪失後の画面再同期は次の節を参照します。

### 認証喪失後の画面復帰

`AccountLayout` はセッション確認の要求版と、loader・hookで共有する `accountRequestScope` の認証世代を管理します。初回・focus・手動の確認は新しい要求版を使い、401からの `recoverUnauthorized` は進行中の確認を共有します。結果は同じ本人で有効・未認証・確認失敗・古い要求を区別します。確認はAbortControllerと10秒の期限で打ち切り、古い要求版の応答は採用しません。失敗時はプロフィールと下書きを保持します。

`useAccountDataRequest` は戦績・本人履歴・戦法別戦績の401で確認を呼び、同じ本人で有効なら同じURLを一度だけ再取得します。要求前後とJSON解析後に認証世代・abortを照合します。正常な確認・明示的な認証更新・Providerの破棄で世代を進め、古い401を新しい認証の確認に使いません。古い初回取得は現行世代で取得し直し、取得済み値は同じ本人の間保持します。プロフィール本文は `profileId`（旧応答はusername）をkeyとし、別アカウントへの変更で取得要求・キャッシュ・編集フォームを破棄します。

本人棋譜loaderは直接ログインへredirectせず、開始時の認証世代を持つ内部401 Responseを返します。分割棋譜取得中の401も同じ形式です。`AccountReplayRecovery` がContextで確認し、有効または古い要求なら現行世代でloaderを一度だけ再検証します。二度目の失敗は手動再試行へ戻し、公開棋譜はこの処理を使いません。ログイン喪失の確認後は履歴置換で `/login` へ移り、履歴stateの `sessionLost` で案内を表示します。stateを認証判定には使わず、再ログイン後の復帰先は既存方針を維持します。

WorkerのAPI、Cookie、保存形式、protocol契約は変更しません。DOM/hookとloaderの検証は[認証喪失後の画面復帰の確認](testing.md#認証喪失後の画面復帰issue-143)を参照します。本番QAで認証を失った直接原因は未確定です。

### Google・Discordの設定

Discordは既存Better Authのproviderを使用します。権限は `identify email`、コールバックはローカル `http://localhost:5173/api/auth/callback/discord`、本番 `https://tetraboard.net/api/auth/callback/discord` です。Discord Developer Portalにそれぞれ登録し、`DISCORD_CLIENT_ID`・`DISCORD_CLIENT_SECRET` をGoogleと同じ方法で設定します。秘密値を会話・ログ・Gitへ出しません。選択したproviderの設定不足だけを503にし、もう一方は利用できます。

認証開始APIのproviderは `google`・`discord` のみを許可し、省略はGoogle、未知値は400です。戻り先は従来のサーバー固定値を維持し、管理画面はGoogle限定です。Discordのメール欠落はBetter Authの `email_not_found` でユーザー作成前に拒否し、日本語でGoogleの選択肢を示します。アカウント連携は無効を維持し、`account_not_linked` は初回の登録方法を使う案内にします。DB migrationと認証依存更新は不要です。Google・Discordの識別子で再ログインし、プロバイダーの名前・画像を公開プロフィールに自動設定しません。

OAuthのエラー戻り先には事前の `error` パラメータを付けず、Better Authが実際のエラーコードを1件だけ追加します。一般の戻り先は `/login`、管理画面向けは `/login?destination=admin` です。`discordAuth.test.ts` はメール欠落・別方式での登録・Google認証の取消で `error` が1件だけになることと、管理画面の戻り先を保持することを確認します。

### ローカル確認と本番設定

`bun run dev` は既存ローカルD1に認証テーブルも適用し、R2はローカルエミュレーターを使います。`APP_ORIGIN` の初期値は `http://localhost:5173` です。Google認証の確認はそのURLでWebを開きます。別のポートやLANのURLを使うときは、Workerの追跡対象外 `.dev.vars` で `APP_ORIGIN` を同じURLへ上書きします。Googleのコールバック設定にも同じオリジンが必要です。通常のロビー・対局はGoogle設定がなくても利用できます。

Google CloudのOAuthクライアントはWebアプリケーション用を使い、承認済みリダイレクトURIに次を登録します。

- ローカル: `http://localhost:5173/api/auth/callback/google`
- 本番: `https://tetraboard.net/api/auth/callback/google`

`BETTER_AUTH_SECRET`（32文字以上の乱数）、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` をローカルは `.dev.vars`、本番は `wrangler secret put <名前> --env production` で設定します。秘密値はコード・PR・会話・ログに出しません。認証処理には本番Secretが必要で、ローカルだけは開発専用Secretのフォールバックがあります。本番Secretが未設定のときに開発用の値は使いません。Googleの設定不足はログイン画面で「準備中」と案内します。旧版のSecretやCookieをコピーしてセッションを共有する必要はありません。

専用R2 `tetraboard-2026-objects-prod` は存在を確認済みです。旧版の `tetraboard-objects-prod` は切替後の確認まで保持し、確認後に削除します。バケットを公開せず、画像はWorker経由で配信します。productionのR2も `remote: false` のため、ローカルプレビューから本番画像を変更しません。D1の本番名・IDとローカル名・IDも維持します。

マイページのページ枠は `AccountPageShell` の `layout="profile"` を使います。最大幅・左右余白は共通の `shared/ui/pageLayout.ts` にまとめ、ヘッダーと一致させます。本文先頭の左に共通ゲームDropdown、右に選択中ゲームのロビーへ移動するsecondaryの`AppButtonLink`、共通モードタブは651px以上ではDropdownのすぐ右に最大360px幅、650px以下では次の行に全幅で配置し、その下にプロフィール＋戦績・棋譜のカードを配置します。タブは複製せずCSS Gridで配置を切り替え、幅の変更で選択・カード・取得済みデータを維持します。本文は`lobby-background`と`gameThemes`で選択中ゲームの背景・テーマを使い、共通ヘッダーはテーマ範囲の外に置きます。DropdownのPortalとプロフィール編集の`AppDialog`にも同じテーマを渡します。1024px以上は左560px・間隔20px・右は残り幅、それ未満は同幅の縦並びです。ログインは `AccountPageShell` の `layout="login"` でヘッダー下の残り領域を使い、左右20px余白・カード最大560pxの中央配置にします。内容が高い場合は自然に画面を伸ばしてスクロールし、上部が欠けないようにします。初回設定は従来のフォーム用幅を維持し、下部のロビーリンクは両方に残します。登録メリットとバッジ例をログインでも共用し、管理画面向けでは省略します。

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

`GET /api/account/matches?game=four-reversi|four-shogi&mode=singles|doubles&cursor=<開始日時ms>:<UUID>` はCookieで確認した本人の開始時の参加局と、結果から本人へ引き継いだ局をゲーム・モード別に返します。`game` の省略時はリバーシです。開始日時・UUIDの降順で21件を取得し、応答は `{ matches: [...最大20件], nextCursor: string | null }` です。カード用応答は日時・ゲーム・モード・参加者・結果だけを含み、内部アカウントID、参加資格、部屋識別子、盤面、棋譜は含めません。アカウント参加者の名前・画像は取得時の現在のプロフィールを参照します。未引き継ぎのゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使います。退会者は [確定した退会仕様](../README.md#アカウント削除) に従い、保存名へのフォールバックを禁止します。GETにOriginヘッダーを必須とせず、プロフィール変更用の回数制限も適用しません。未認証は401、不正な条件は400、認証取得・D1取得の失敗は503とし、全応答に `Cache-Control: no-store` を付けます。

Workerテストは通常終局の棋譜再現、投了・退室・時間切れ・通信切れ、人間不在で未決着の打ち切り・非保存、退室による即時終局の保存、ゲストのみの保存、D1本体／索引の一括保存、複数局の保存失敗・再戦・閉鎖・番号再利用・再送、導入前の対局の除外を確認します。履歴APIは本人限定、両モード、0・20・21・41件、同時刻のページング、名前・画像変更、認証・D1障害を確認します。Webは履歴カードの値とリンク、空一覧、取得失敗と再試行、追加取得、共通のゲーム・モード、保持と遅延応答、更新をDOMテストで確認します。履歴の期限削除は行いません。

保存参加者へ `match_participant_accounts` の適用済み帰属を重ねてから内部アカウントIDを重複排除し、`participantProfiles` で現在の名前・アイコンを一括取得します。本人用・公開用の一覧と詳細は同じ変換処理を使い、通常のプロフィール変更では応答項目と保存JSONを変更しません。退会時の保存名・本人参照の除去と退会者表示は [退会計画](#プライバシー規約退会の実装計画) の対象です。画像未設定・参照先なしは仮アバターとし、プロフィール取得障害は503です。プロフィール変更は次回取得時に反映し、表示中の自動同期は行いません。ルーム内の直前局の結果は当時の表示情報を保持し、結果からの席切替成功時だけ本人の名前・アイコンを更新します。

## 最近の対局一覧と公開棋譜

公開・総合・本人の一覧APIは任意条件 `includeMoveCount=1` を受けたときだけ、共通の `matchSummary` で保存局面の `game.moveNumber` を `moveCount` に付加します。省略時は旧応答を維持し、不正値は400です。更新済みWebはこの条件を渡し、任意フィールドとして解析します。手数がない旧応答の解析も維持します。D1の保存形式・スキーマは変更しません。`MatchHistoryCard` は手数がある場合だけ表示し、長い名前（見た目の文字数8文字以上）を10px、他は12pxにして列幅内で折り返します。

`0009_public_matches.sql` は `matches (game, started_at_ms DESC, id DESC)` の索引を追加します。記録の書き換えや再保存は不要です。公開一覧は本人索引を使わず、保存完了した本体を参照するため、ゲストのみの対局も含み、将棋の転送途中のmanifest・チャンクは公開しません。

`GET /api/matches?game=four-reversi|four-shogi` はゲーム指定必須で、両モード・CPU戦を含む最新20件を開始日時・UUIDの降順で返します。応答は `{ matches: MatchSummary[] }` です。`GET /api/matches/:matchId` は本人用詳細から `selfPlayerId` を除いた公開詳細を返し、`GET /api/matches/:matchId/replay?cursor=<event offset>` は将棋のイベントを100件ずつ返します。認証不要、不正条件は400、対象なし・リバーシへのイベント取得は404、D1障害・不整合は503、全応答は `no-store` です。アカウント参加者の名前・画像は取得時の現在のプロフィール、ゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使い、退会者は旧名へのフォールバックをせず、内部アカウントID・instanceId・参加資格・チャットは返しません。本人用APIの認証・本人索引は維持します。

公開一覧の任意条件 `humanOnly=true|false` は省略時にfalse、不正値は400です。trueでは保存済みJSONの開始時の参加者がゲームの定員2人または4人を満たし全員humanの条件をSQLで適用してから並べ替え・20件制限を行います。ゲストも含み、CPUが1人でもいる対局は除外します。既存の保存データと索引を使い、migration・記録の書き換えは不要です。

Webは全ロビーの公開ルーム直下に共通棋譜カードを一列・内部横スクロールで表示します。表示時と手動更新のみ取得し、成功時は左端へ戻します。失敗時は既存一覧と位置を保持し、再試行を案内します。ゲーム切替・離脱では取得を中止し、前ゲームの遅延応答を採用しません。公開 `/matches/:matchId` と本人用の画面は棋譜の復元・盤面・結果・回転を共有し、公開閲覧では本人IDを作らず、リバーシは黒・将棋は南を手前にします。プロフィール設定への転送を行わず、戻り先は対象ゲームのロビーです。Workerは直接URLにもSPAのindexを配信し、HTTPの `X-Robots-Tag` と画面のrobotsメタで検索対象外にします。計測は `replay` と対局のゲームで分類します。

「対人戦のみ」は見出し下・一覧上に配置し、初期状態はチェックなしです。ロビー表示中だけ保持し、ゲーム別にkeyを変えて再読み込み・ゲーム切替では初期状態へ戻します。条件切替では即座に前の取得を中止し、旧条件のカードを消して再取得します。読み込み中も切替可能で、古い応答は採用しません。切替失敗では選択条件を保って再試行を案内し、同条件の更新失敗では既存一覧と位置を保持します。対人条件が0件なら「対人戦の対局履歴がありません。」を表示します。Webは対人条件にCPUを含む応答も拒否します。

ロビーの棋譜カードだけ、開始時刻から1時間以内は切り捨てた分数（1分未満は0分前、ちょうど1時間は60分前）、1時間を超えて24時間以内は切り捨てた時間数（ちょうど24時間は24時間前）を表示します。24時間を超える時刻と端末時計より未来の時刻は従来の端末時間帯の年月日・時分です。共通カードに任意の相対時刻の基準を渡し、マイページでは従来の日時表示を維持します。time要素のdatetime・titleとカードのaria-labelは正確な開始日時を保持します。ロビーの時計は一覧取得後と1分ごとに更新し、離脱時にタイマーを解除します。表示時刻だけの更新ではAPI再取得・カードの並べ替え・スクロール位置のリセットを行いません。単体テストで分・時間・24時間の境界、日付をまたぐ経過時間、未来時刻、本人用の日時表示を確認します。

Workerの `publicMatches.test.ts` で最新20件・同時刻・ゲーム分離・両モード・CPU／ゲスト・未ログインでの取得・転送途中の除外・非公開情報・本人用APIの認可・不正条件・D1障害を確認します。Webの `publicMatches.test.ts` は公開取得・初期方向・既存棋譜の再現・将棋の連番と最終局面の一致・取消・不正応答を確認します。関連の単体テストは `bun run check` に含まれます。

対人フィルタのWorker回帰では両ゲーム・両モードでCPU1人の除外・ゲスト4人の採用・0件・絞り込み後の最新20件と同時刻順序を確認し、最新21件がCPU戦でも古い対人戦を取得できることを検証します。Webでは条件の送信・CPU入り応答の拒否・取得中止と中止後の遅延応答の拒否を確認します。

## 保存済み棋譜の閲覧

`GET /api/account/matches/:matchId` はCookieで本人を確認し、`account_match_history` と `matches` を結合して本人の対局だけを取得します。応答は `{ match: MatchDetail }` で、対局ID・元の部屋番号・開始／終了日時・設定・開始時の参加者と本人のプレイヤーID・最終ゲーム状態・脱落理由・棋譜を含みます。アカウント参加者の名前・アイコンは取得時の現在のプロフィール、未引き継ぎのゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使います。退会者は [確定した退会仕様](../README.md#アカウント削除) に従い、保存名へのフォールバックを禁止します。内部アカウントID・instanceId・参加トークン・チャットは返しません。不正IDは400、未認証は401、他人／存在しない対局は404、認証／D1取得失敗は503です。全応答に `Cache-Control: no-store` を付けます。将棋の詳細は棋譜本体に代えて `{ rulesVersion: 1, initial, eventCount }` と方向別 `knockouts` を返し、脱落は最終ゲーム状態の `eliminations` に含みます。

Webの `/account/matches/:matchId` は専用loaderと `MatchReplayPage` で取得・閲覧します。移動時は取得をキャンセルし、失敗画面から再試行できます。再試行は同じURLへの履歴置換でloaderを再実行し、取得成功時にエラー境界を解除します。再試行中はボタンを無効にし、連続失敗後も再試行できます。`RoomLayout`・`RoomInfoCard`・`ReplayCard` とゲーム別の盤面・カード・結果ダイアログを通常ルームと共有します。リバーシの棋譜は既存の状態列、将棋は初期化情報とイベントをエンジンで再生します。棋譜閲覧はルームセッション・チャット・招待hookを起動せず、参加資格を読み書きしません。プレイヤーカードの棋譜表示は選択局面と保存された脱落理由から求め、未来の脱落を表示しません。

Workerテストで本人限定・両モード・不正ID・未認証・取得障害・非公開情報の除外・名前とアイコン・実終局と部屋閉鎖後の取得を確認します。Webテストで本人の配置・石数・脱落・着手枠・通常終局と自動パスを確認します。棋譜の取得・認証失効・abort・ページ境界・失敗と再試行はloaderとDOMのテストで確認します。局面操作はローカルで行い、オンラインルームへ接続せず参加資格を維持します。

### 四人将棋の結果の撃破列（#134）

**Goal**

四人将棋の結果ダイアログで、撃破人数にかかわらず対象アイコンの開始位置をそろえ、順位・方角・本人のアイコン・名前を読みやすく保ちます。シングルス・ダブルス、ルーム内・本人の保存棋譜・公開棋譜を対象とします。

**ContextProviders**

開発者の承認済み指示、[AGENTS.md](../AGENTS.md)、[READMEの結果表示仕様](../README.md#保存済み棋譜の閲覧)と[四人将棋ルール](rules/four-shogi.md)、本書と[検証方針](testing.md)、[Issue #134](https://github.com/yksw-clm/tetraboard-2026/issues/134)・[PR #83](https://github.com/yksw-clm/tetraboard-2026/pull/83)・既存実装とGit履歴の順に参照します。複数対象をPC・スマートフォンとも縦並びにすることは開発者の承認済みです。

**Constraints**

`GameResultList` の任意の `rightHeading` で共通見出しを表示し、`GameResultTeam` からも渡します。見出しと右欄付きの `GameResultRow` は同じ2列のGrid定義を使い、本人情報の列を広めに確保します。右欄なしの既存ゲームの配置は維持します。`FourShogiGameResultView` は各行のラベルを削除し、対象を縦に並べます。長い名前の折り返し・アイコン・ID対応、撃破なしと取得中・失敗の区別、再試行を維持します。撃破判定・順位・戦績・通信・保存・ルール版を変更せず、新しい依存技術を追加しません。作業ブランチ・コミット・マージ承認と検証はAGENTSの規則に従います。

**Done When**

共通見出しがシングルスで1つ・ダブルスで各チームに1つ表示され、0〜3人の対象・ID・名前・順序と「なし」、取得中・失敗・再試行をDOMテストで確認します。ルームと保存・公開棋譜の共有表示、他ゲームの結果、既存の撃破判定と固定棋譜の回帰を維持します。PC・スマートフォン相当の幅でアイコン位置・長い名前・折り返し・はみ出しを目視確認します。画面寸法・実画像・ネイティブ操作はブラウザ自動テストへ追加せず、確認結果と未確認事項をPRに記録します。README更新、必須ローカルコマンドとGitHub CIの成功、検証対象コミット・環境・結果を記載したレビュー可能なPRの提出で完了です。

部分確認は `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/gameResults.test.tsx ./test-dom/savedReplay.test.tsx` と `bun test --cwd apps/web ./test/shogiKnockoutTargets.test.ts` を使います。

## 本人の戦績集計

戦績とランキングは共有SQLの `matchOutcomesCte` で、保存された開始時の `participants` が4人かつ全員 `kind: human` の対局に限定します。ゲストの相手も人間として扱い、本人の集計・ランキング掲載は既存のアカウント索引を使います。順位・勝敗・引き分け・率の分母・将棋の累計撃破数を同じ条件で集計し、過去の保存済みCPU戦にも適用します。履歴・詳細・棋譜の取得にはこの条件を付けず、CPU戦の記録と撃破数は保持します。CPU戦の集計除外には、保存済みデータの移行・削除・再保存は不要です。

`GET /api/account/stats?game=four-reversi|four-shogi` はCookieで本人を確認し、既存の `account_match_history` と `matches` の保存結果をD1内でゲーム別に全件集計します。省略時はリバーシです。リバーシの応答は `{ singles: { total, first, second, third, fourth }, doubles: { total, wins, losses, draws } }` です。順位は本人の開始時の色に対応する確定順位、勝敗は黒・赤／白・青のチームと保存された勝者から求めます。引き分けも `total` に含めます。全応答は `Cache-Control: no-store`、未認証は401、不正なゲーム指定は400、認証取得・D1集計失敗は503です。将棋のシングルスは `knockouts` と `perfectWins` を追加し、開始時の本人の担当方向から確定順位と撃破数を引きます。ダブルスは南・北／西・東のチームで勝敗を判定します。

Webは`ProfilePage`で`useAccountSelection`を一度読み、共通のゲーム・モードを`AccountStats`と`MatchHistory`へ渡します。`useAccountStats`はゲーム別の両モード、`useMatchHistory(game, mode)`はゲーム・モード別の棋譜一覧を取得・保持し、各カードの更新・再試行を維持します。カードは共通タブの選択パネル内に置き、ゲーム・モードの切替で取り外しません。棋譜へのリンクとマイページへの戻りには共通の`accountSelection`（ゲームとゲーム別モード）をブラウザ履歴stateで渡し、選択変更は履歴置換で保存します。旧`accountSelections`は有効な値を棋譜側・戦績側・初期値の順に読み取り、無関係なstateを保持します。選択情報のない直接アクセスの初期値は四人リバーシ・シングルスです。戦績タイトル下に「対人戦のみ集計」を表示し、率は集計対象の対局数を分母にして `.000` 形式の小数3桁で表示します。読み込み・失敗を0件として表示せず、更新中と更新失敗時は取得済みの戦績を保持します。

全6ゲームの共通`LobbyView`だけが`AccountMenu`へ`lobbyGame`を渡し、プロフィール設定済みユーザーの「マイページ」遷移に`createAccountSelection`で作った`accountSelection`を設定します。初期ゲームは移動元、ゲーム別モードはシングルスです。ロビーのフォーム入力や履歴stateは引き継がず、URLパラメーター・新しい永続保存は追加しません。選択情報のない直接アクセスでは従来どおり四人リバーシ・シングルスです。ロビー以外のメニュー、認証・初回設定・認証後の復帰導線は従来の動作を維持します。ゲーム選択は戦績・棋譜・本文テーマ・ロビーリンクで共有し、再読み込み・履歴移動・棋譜往復は現在の選択を復元します。

戦績の表は `StatsTable` で共用し、`AccountStats` の先頭行は対局数と四人将棋シングルスの完全優勝数を左右に配置します。その他の先頭行の右セルは空欄です。`FormationStats` の順位詳細も同じ2列の表を使います。

Workerテストで両ゲーム・両モードの人間4人、CPU1〜3人の過去分除外、CPU戦のみの本人の0件表示と履歴・詳細・棋譜の保存を確認します。集計用データは対人戦、保存用データはCPU戦を維持します。本人限定・全順位・同順位・両チームの勝敗・引き分け・0件・20件超・保存再送・実終局の反映・認証とD1障害を確認します。Webは率の丸め・0件、表示値、棋譜と共通の選択・ゲーム別モードの復元、読み込み・失敗・再試行・更新を純粋関数とDOMテストで確認します。

## 公開プレイヤー情報

`participantProfiles` は保存参加者から内部IDを重複排除する入口として維持し、`readCurrentProfiles` に現在の名前・公開ID・画像・設定状態の一括読取を集約します。保存棋譜の公開変換は従来の名前・画像だけを使い、公開カードの可否判定とは分けます。保存JSON・参加者スキーマ・本人索引・将棋イベントを変更しません。

`0010_player_profiles.sql` は `user.publicProfileId` の一意UUIDと `room_index` の部屋世代・ホストID列を追加します。内部アカウントIDと変更可能な公開IDから独立した参照キーを既存ユーザーへ付与し、プロフィール保存では未設定の場合だけ生成します。デプロイの間に未付与の登録者が生じても、参照の返却時に条件付きUPDATEで補完します。旧Workerの動作は追加migration後も維持できます。

`GET /api/player-profile` はゲームと参照種別を必須にします。`source=room` は `roomId, instanceId, playerId`、`source=match` は `matchId, playerId`、`source=profile` は `profileId` を渡します。GameRoom内部の参加者・アカウント対応、保存記録、公開参照キーをサーバーで照合します。名前や画像で本人を判定せず、内部IDはHTTP・WebSocketへ返しません。省略可能な `includeStats=1` を指定した場合は、平均順位・勝敗分・撃破数の表示に必要な既存 `AccountStats` の全項目を返します。追加指定がない場合、登録者には現在のプロフィールと対象ゲームの `{ singles: { total, first }, doubles: { total, wins } }` だけを返し、既存の `readAccountStats` を呼びます。ゲスト・CPUを区別し、不正400、対象なし404、部屋世代変更410、障害503、全応答no-storeです。対局のWebSocket配信へD1取得を追加しません。

ロビー・ランキングは `profilePreview=1` の要求にだけ参照情報を追加します。通常の応答は従来の形で、旧Workerの400では通常取得へ戻ります。ロビーの古い索引で参照情報がない行は `getPublicMetadata` で現在の部屋世代とホストへ補完し、閉鎖済みを除外します。参照のない旧応答をゲストと判断しません。

Webのプレイヤー機能は取得store、Provider、表示カード、トリガーに分離します。storeは `includeStats=1` と `includeBadges=1` を指定し、400時は両方を外して一度だけ再取得します。旧応答の不足項目は補完せず、`playerStatsSummary.ts` で取得済み値だけを文章にまとめます。成功結果を60秒再利用し、解決した公開参照キーとゲームで共有します。プロフィール保存・終局・画面遷移で無効化し、abort後や旧要求の完了を採用しません。HeroUIのPopoverは非モーダルで位置・Portalを再利用し、開閉・フォーカスは操作種別に応じて制御します。ランキング内ではPortalを所属ダイアログへ置き、Escapeの伝播を止めて外側を閉じません。

Workerの `playerProfiles.test.ts` と既存の公開／本人棋譜・戦績テスト、Webの `playerProfiles.test.tsx` で未ログインでの取得、別人への誤紐付け防止、ゲスト・CPU・参照先なし、旧応答、取得障害、開閉、再試行、キャッシュ期限・無効化・遅延応答を確認します。実寸法・ネイティブ入力・画像デコードは手動確認し、PRへ結果と未確認を記載します。

## ゲーム別のランキング

ロビーと詳細の集計説明は「対人戦・登録済ユーザーのみ集計」とし、詳細では対戦相手がゲストでも対象であることを補足します。SQLの集計条件は変更しません。

`GET /api/games/four-reversi/rankings` と `GET /api/games/four-shogi/rankings` は認証不要で、`{ singles: { first, total }, doubles: { wins, total } }` の各上位10人を返します。各行は `rank`・`username`・`name`・`avatarUrl`・`value` です。既存の `account_match_history`・`matches` を対象ゲームに限定してD1内で全件集計し、現在の設定済みアカウントのプロフィールを結合します。本人戦績と同じ順位・チーム勝敗の判定を使います。四人将棋シングルスの撃破数は `includeKnockouts=1` を指定した要求にだけ `singles.knockouts` を追加します。既存の保存済み `knockouts` を同じ対人戦条件で累計し、0人は除外します。通常応答とダブルスの形を維持し、プレイヤー参照付き応答にも要求時だけ追加します。他ゲームの要求や不正値は400です。Webは四人将棋だけ追加指定し、旧Workerで項目が欠落した場合は0件に置き換えず表示できない旨を案内します。

SQLの `RANK()` で同順位と順位の飛びを求め、値の降順・公開IDの昇順の `ROW_NUMBER()` で10人に制限します。集計値が1以上の人だけを掲載します。名前・画像は履歴の開始時情報ではなく現在のプロフィールを参照します。内部アカウントID・棋譜は返しません。全応答は `Cache-Control: no-store`、D1取得失敗は503です。

ロビーの `LobbyRankings` と専用hookで全ランキングを取得し、通常表示は上位3人、共通ダイアログでは上位10人を表示します。「対人戦・登録済ユーザーのみ集計」はロビーの見出し横に置き、その下にモードタブを置きます。通常表示は優勝数／勝利数→対局数→四人将棋シングルスだけ撃破数を10秒ごとに循環します。Motionの出入りで横へスライドし、退場中の内容は読み上げ・操作から除外します。最小高さを確保し、空一覧でも表示の切替でカードを縮めません。集計項目の手動選択、その右の「自動切り替え」チェックボックス、右端の枠付き「もっと見る」を一つの操作行にまとめます。狭い幅では操作行を折り返し、すべての操作を表示します。自動切替は初期ONとし、チェックのON/OFF・ホバー・フォーカス・タブ非表示・詳細表示の停止と再開を扱い、OSの動きを減らす設定では移動を省きます。詳細は現在のモード・項目を引き継ぎ、手動で選びます。両画面で取得結果と更新状態を共有し、更新失敗時は既存データを保持します。モード切替はロビーと詳細で独立し、キャンセル済み応答で新しい取得結果を上書きしません。ロビー上部は768pxで等幅2列へ切り替え、盤面図をタイトル左へ移します。767px以下の表示順は操作カード・公開ルーム・最近行われた対局・ランキングです。`matchMedia` を `useSyncExternalStore` で購読し、同じ親内のkey付き領域を並べ替えて、DOM順と表示順をそろえながらランキングの状態を保持します。操作ボタンは説明付きの2段にし、「みんなで遊ぶ」のラベルを作成ボタンの前に置きます。公開ルームの一覧部分だけ、767px以下で最大400px・縦スクロールにし、見出し・更新・エラー・補足・追加読込は領域外に残します。

Workerテストで未ログインアクセス・全色・同率優勝・両チーム勝利・引き分け・CPU戦除外・ゲスト相手の対人戦と未引き継ぎゲスト本人の掲載除外・0件・0回除外・10人の境界・全履歴・再送・プロフィール更新・未終局と実終局・D1障害を確認します。Webは初回取得・失敗・再試行・更新時保持とモード・集計項目・上位3人／詳細10人の表示をDOMテストで確認します。

ロビーは取得失敗・追加取得・0件と末尾・参加／観戦のURL、ランキングの取得済み値・選択と更新をDOMテストで確認します。偽の幅変更通知によるDOM順・選択の保持は確認し、画面幅ごとの寸法やフォーカスの実ブラウザ検証は自動検証対象から外します。画面のレスポンシブ仕様は維持します。

## 四人将棋の恒久記録の確認

将棋はDOの終局トランザクションでメタデータ・保存待ちと `shogi_archives` の保護局を確定します。再戦・閉鎖・番号再利用でも保護局のイベントを削除しません。Alarmごとに最大400イベントをD1へアップロードし、全チャンクを逐次検証してから `matches` 本体と本人索引を最後のD1 batchで公開します。途中状態は一覧・戦績・ランキングへ出さず、失敗は5秒後に再送します。成功後は保存待ちと保護を解除し、現部屋の直前局ならイベントを残し、別局または閉鎖後なら不要な行を削除します。リバーシのJSONと保存処理は維持します。

終局保存は導入後に開始した対局だけを対象とし、導入前・導入時に進行中の棋譜や撃破数を補完しません。撃破数は受理されたシングルス着手の新たな `checkmate` 脱落だけを着手者へ人数分加算します。CPUも記録し、外部脱落・`no_legal_actions`・ダブルスは加算しません。エンジンの順位や勝敗を変更せず、対局記録の集計情報として扱います。

`GET /api/account/matches/:matchId/replay?cursor=<event offset>` は本人の保存済み将棋対局を100イベントずつ返します。応答は `MatchReplayPage`（`matchId`・`rulesVersion`・`initial`・`eventCount`・`events: [{ index, event }]`・`nextCursor`）です。詳細と同じ本人限定・認証・不正ID・障害・no-storeの規則を使います。Webは対局ID、バージョン、初期化情報、件数、連続番号とカーソルを照合し、`createInitialState`・`applyAction`・`eliminateSide` で復元して保存済み最終状態と比較します。途中の移動でfetchを中止し、失敗時は未完成の棋譜を表示せず再試行します。

固定データは公開エンジンで受理される初期局面からのイベント列で作ります。Webの純粋関数・DOMテストは戦績・棋譜の4つのゲーム／モード、遅延応答・更新失敗時の保持、方向・持ち駒・成り・裏王・読み取り専用を確認します。同時脱落はWorkerと保存棋譜と共通のframe生成を合わせて確認します。ランキングの未ログインでの取得・集計・人数境界はWorker、表示内容・選択と失敗・再試行はWebで確認します。リバーシの通信形式と既存棋譜の互換性は維持します。

## 観戦と保存済み棋譜の回転

両ゲームの観戦と保存済み棋譜は、閲覧画面の0〜3の回転状態を共有ボタンで進めます。観戦者の状況カードは「観戦中」・参加可能なら参加ボタン・回転ボタン、保存済み棋譜は「棋譜閲覧中」・回転ボタンを下段に表示します。参加者のルーム内棋譜は対象外です。将棋は既存の座標・駒方向・持ち駒・カードの変換を使い、リバーシは表示マスを基準座標へ戻して盤面と最終手を参照します。カードは時計回りに位置だけを変え、文字は回転しません。通信・サーバー状態・棋譜データへの書き込みは行いません。

状態は手数変更・タブ切替・再接続・同じルームの次局開始で保持し、ページ再読み込みと画面の識別子・参加資格の切替で初期化します。座標変換・回転・閲覧権限は純粋関数、局面変更時の保持はhookテストで確認します。

## 計測用管理画面の開発と公開

`apps/admin` はWebと同じReact・HeroUI・Tailwindを使い、SVGでグラフを描きます。`bun run dev` はWorker・Web・Adminを起動します。AdminのViteは5174で起動し、Webの `/admin` をプロキシするため、ブラウザでは `http://localhost:5173/admin` を開きます。Google認証は既存の同一オリジン設定を使い、専用のOAuthクライアントや別の本番Workerは不要です。開発用Vite自体のHTMLは認証前も取得できますが、管理データは常にWorkerの本人確認を通します。本番はHTMLとアセットも本人限定です。

### 管理者設定

ローカルの追跡対象外 `.dev.vars` に `ADMIN_ACCOUNT_IDS` をJSON配列（例：`["owner-id-1","owner-id-2"]`）で設定します。値は本人の内部 `user.id` で、公開IDの `username`・Googleの識別子・メールとは異なります。本人のプロフィールを公開IDまたはメールで検索したD1の行から確認してください。IDをソースやフロントエンドの環境変数へ埋め込みません。設定なし・空配列・不正な配列は503で閉じ、開発者用の認証回避は設けません。従来の `ADMIN_ACCOUNT_ID` は配列が未設定の場合だけ利用し、不正な配列からはフォールバックしません。

本番は開発者の指示に基づき、`apps/worker` で `bunx wrangler secret put ADMIN_ACCOUNT_IDS --env production` から本人のIDのJSON配列を設定します。secretに保存したIDは認証と本人利用の除外で共通に使います。公開・マージは差分と確認結果をレビューした開発者の承認後に行います。既存の `MODERATOR_TOKEN` は通報API用で、管理画面には使いません。ログイン画面の `destination=admin` はサーバー固定の `/admin` へだけ戻し、任意の外部URLをOAuthの遷移先にしません。

### データとAPI

`0007_analytics.sql` は閲覧・日別累積時間・対局・人間の開始時情報と計測開始日時を追加します。過去の棋譜を集計へ移しません。ブラウザのCookieがないゲストは対局数には含めますが、ユニーク利用者・開始率・継続率には含めません。既存アカウントはCookieがなくても登録利用者の集計対象です。ON/OFFを設けず、ブラウザIDと内部アカウントIDによる関連付けと具体的目的を規約・ポリシーへ明記します。個別計測の90日期限と長期集計は [確定仕様](../README.md#保存期間利用計測) に従います。テスト区分は閲覧・参加時のサーバー情報を記録します。

- `POST /api/analytics/pageviews` はUUID・画面種別・ゲーム、`POST /api/analytics/dwell` はビューUUIDと日本時間の日別累積ミリ秒を受け取ります。Origin、容量、形式、所有ブラウザ、実経過時間による上限を検査し、閲覧の重複送信・古い時間更新で増加させません。
- `GET /api/admin/session` は本人確認、`GET /api/admin/analytics?from=YYYY-MM-DD&to=YYYY-MM-DD&game=all|four-reversi|four-shogi&bucket=day|month&includeInternal=false|true` は期間全体と各期間の集計を返します。開始・終局はブラウザから受け付けません。ゲストのブラウザIDや内部アカウントIDは集計レスポンスに含めません。
- `GET /api/admin/users?search=名前またはID&cursor=...` は50件と次カーソルを返します。現在のR2アイコンを参照し、未設定・取得失敗時は仮アバターにします。同時刻は内部IDを使った安定した順でページングします。

登録日時はBetter Authが保存するISO文字列と既存のUNIXミリ秒整数を読み取り時にミリ秒へそろえ、一覧の応答・並び順・カーソルと新規登録数の日別／月別集計に使います。DBの日時を一括で書き換えません。Workerテストは両形式の混在と同時刻の追加取得、日本時間の月境界、計測開始前と期間外の除外を検証します。

### ビルドと確認

`bun run build` はWeb・Adminを個別にビルドし、`scripts/buildAssets.ts` で `apps/worker/dist/assets` にWeb、その `admin/` 配下にAdminをまとめます。Wranglerはこの成果物を配信します。Adminの深いURLは認証後に専用indexを返し、HTMLの自動転送を無効にしてリダイレクトループを防ぎます。通常WebのSPA・API・WebSocketを維持します。CI/CDも同じビルド成果物を使います。Worker単独のdry-runや本番構成プレビューの前に、必ず `bun run build` を実行してください。

本番構成のローカルプレビューは `preview:production` がupstreamも `http://127.0.0.1:8788` にそろえます。本番のcustom domainをupstreamとして使うとWranglerがOriginを書き換え、ローカル用 `APP_ORIGIN` と一致しなくなるためです。

`bun run check` はAdminの型・表示計算・DOMテストと計測のWorkerテストも含みます。Web計測は偽時計・visibility通知・複数の偽Lock主体で検証します。Adminは集計条件・検索・追加取得・競合・削除・401/403時のデータ破棄を検証します。実Google認証・本番データでの確認はローカルのモック検証と区別して報告します。

## フィードバックの受付・運営

共通仕様はREADMEの「フィードバック受付とお知らせ」を参照します。`packages/protocol/src/feedback.ts` のスキーマをWeb・Worker・Adminで共有し、`0008_feedback.sql` は投稿・テーマ・編集履歴・送信上限・アップロード予約を追加します。既存ゲーム・通報のデータ形式は変更せず、過去データの移行は不要です。プロフィール未完了でも `/feedback` と `/updates` を開けるよう、通常の設定画面への転送から除外します。

### 受付と非公開画像

`POST /api/feedback` はmultipartの `input`（JSON）と任意の `attachment`（静止WebP）を受け、201で `{ id }` だけ返します。送信IDはWebが生成し、入力または画像を編集すると新しくします。失敗時は同じ入力・画像・技術情報を固定して再送します。サーバーは本文と画像のハッシュを照合し、同じIDの異なる内容は409です。D1の一意制約と同一batchの上限更新により、並行送信も1件として数えます。画像ありは保存予約を先にD1へ記録し、R2保存後に受付を確定します。失敗した予約は一覧に出さず、同じ内容の再送で回復します。

技術情報は許可した項目だけを厳密に検証し、認証で確認した登録／ゲストと内部利用の区分をサーバーで付けます。ログイン必須として送った投稿や、残ったログインCookieを確認できない場合は401、認証・DB・R2障害は503です。ゲストへ自動降格しません。容量はContent-Lengthに依存せず読み取り中に1MiB＋64KiBで制限し、上限超過は413、形式不備は400／415、送信上限は429とRetry-Afterです。ゲストの専用HttpOnly・SameSite=Lax Cookieは180日、本番はSecureです。Cookie拒否はブラウザ重複排除を不完全にしますが、IP側の上限も適用します。

Webは元画像5MiBまで、長辺1,600px・1MiB以内のWebPへ変換します。既存のWebP WASMを共通の画像モジュールへ移し、フィードバックでは全ブラウザで画素だけを再エンコードしてメタデータを除去します（ChromiumのCanvas WebPにはICCが付くため）。アバターの切り抜き・256px固定仕様は維持します。WorkerはRIFF・WebPチャンク・寸法・容量を確認し、EXIF・XMP・ICC・アニメーションを拒否します。R2の `feedback/` を使い、公開アバター経路へ流用しません。管理者認証後の `GET /api/admin/feedback/:id/attachment` だけで配信し、no-storeとnosniffを付けます。送信内容・画像・IP・secretをログへ出力しません。

### 管理APIと保存期限

一覧・詳細・PATCH・DELETE、テーマのGET／POST／PATCH、集計APIは `/api/admin/feedback` 配下です。管理者は既存のADMIN_ACCOUNT_IDSで確認し、すべての書き込みにOrigin検査を追加します。一覧は受信日時・IDの降順カーソルで50件ずつ。更新と削除にはversionが必須で、競合は409です。完了には `published: true`、見送りには運営メモが必要です。初回確認日時は初めて未確認から変更した時点にだけ記録します。集計は期限内・受付確定済み・未削除だけを対象に、迷惑投稿を除き、内部投稿も初期除外します。テーマ変更・削除は現在の集計へ反映します。

180日以上と削除済みは読み取り時点で除外します。既存の毎時処理に削除を追加し、先に非表示、R2削除後にD1本文と履歴を削除します。失敗した行は残して次回再試行し、24時間以上の未確定予約・孤立画像と期限切れ上限カウンターも掃除します。1回100件ずつ処理するため、削除件数が多い場合と障害時は物理削除が遅れます。期限切れ・削除済みの閲覧拒否はその間も維持します。テーマ名だけは残せます。

### 設定・確認・公開

ハッシュ用に `FEEDBACK_HASH_SECRET`（32文字以上のランダム値）を使います。HTTPのローカル環境だけに専用の既定値があり、本番で未設定・短すぎる場合は受付を503で閉じます。本番公開の承認後、`apps/worker` で `bunx wrangler secret put FEEDBACK_HASH_SECRET --env production` から設定します。認証secretを流用せず、ソースやフロントエンドへ埋め込みません。ローカルは追跡対象外の `.dev.vars` に設定できます。稼働中に変更すると既存の報告者の集計と送信上限の識別が分かれるため、定期的な変更は行いません。

フィードバック画面からのお知らせ導線は `/updates` へ向けます。ViteはGitのコミットをビルド識別子へ埋め込み、アーカイブからのビルドでは `VITE_APP_REVISION` を明示します。

Worker統合テストはHTTP・実D1・R2で権限、並行再送、保存失敗、上限境界、競合、集計、期限と削除再試行を確認します。WebのDOMテストはフィードバックの入力・画像処理・下書き・再送ID・technicalの秘匿・送信ロックを、Adminは分類・競合・公開前確認・履歴・削除・権限喪失を確認します。実画像デコード・実描画は対象から外します。

## お知らせの保存・管理・公開

共通仕様はREADMEの「お知らせの管理とロビー掲載」を参照します。`packages/protocol/src/announcements.ts` のスキーマ・型・種別表示名・説明文の最初の行をWeb・Admin・Workerで共有します。日付は実在する `YYYY-MM-DD` を検証し、文字数はUnicodeコードポイントで数えます。新規記事のIDはWorkerがUUIDで発行します。旧記事のID `feedback` は維持します。

`0012_announcements.sql` は記事とゲーム別掲載先、並び順の索引を追加します。既存記事は日付・タイトル・説明文を維持して公開状態・掲載先なしで登録し、同じIDが存在する場合は上書きしません。SQLは新規DBと既存DBの双方で確認します。コード内の記事配列は使用しません。

- 公開APIは `GET /api/announcements?cursor=...`（20件）、`GET /api/announcements/lobby?game=four-reversi|four-shogi`（対象の最新1件、該当なしはnull）、`GET /api/announcements/:id`（全文）です。公開応答から管理情報を除外し、非公開・存在しない記事の詳細は404を返します。
- 管理APIは `GET /api/admin/announcements?cursor=...`（50件）、`GET /api/admin/announcements/:id`、`POST /api/admin/announcements`、`PATCH /api/admin/announcements/:id` です。既存の管理者認証と書き込み時のOrigin検査で保護します。PATCHにはversionが必須で、競合は409、入力不備は400、保存・取得障害は503です。本文は読み取り中に32KiBで制限します。
- 記事と掲載先はD1 batchで一括保存します。更新では各掲載先変更を旧versionでガードし、最後に記事とversionを更新します。競合とbatch失敗は記事・掲載先をどちらも変更しません。登録日時は更新しません。
- 一覧は日付・登録日時・IDの降順で、同じ3項目をカーソルへ含めます。公開・管理応答はno-storeです。Webもno-storeで取得し、画面切り替えでは旧リクエストを中止して古い応答を破棄します。

管理画面は `/admin/announcements`、`/admin/announcements/new`、`/admin/announcements/:id` を使います。保存中の重複操作を防ぎ、競合では入力を保持して明示的な読み直しを案内します。新規保存後は編集URLへ移動します。公開画面は `/updates` と `/updates/:id` を使い、WorkerのSPA配信・プロフィール未設定時の閲覧許可へ詳細URLを含めます。HTMLとHTTPのnoindexを維持します。ロビーの告知取得は対局操作から独立させ、失敗時は告知だけを表示しません。

Worker統合テストで保存・公開・掲載先・並び順・カーソル・権限・競合・batchロールバック・移行を確認します。Bun＋happy-domでフォーム・入力保持・プレビュー・権限喪失・ヘッダー・一覧・詳細・ロビー切り替えを確認します。幅・折り返し・キーボード操作は手動確認とし、ブラウザを起動する自動テストは追加しません。通常の必須コマンドとCIの成功を確認し、開発者のマージ承認後に既存CI/CDでマイグレーションと配信を行います。公開後は既存記事の閲覧と、検証用非公開記事の管理保存・再取得を確認します。

## 任意登録の案内と画面復帰

利用者向けの正本は [終局後の登録と継続再戦](../README.md#終局後の登録と継続再戦) です。登録案内は参加フォームから除き、全体が終局したゲスト本人の結果だけに表示します。結果自体の自動表示は `useAutoGameResult` の既存条件と1,000msの遅延を維持し、案内対象の判定とは分離します。登録済み席をログアウトしてもゲスト扱いにしないよう、本人用の参加資格応答で席のアカウント対応を確認します。

**Goal** は全6ゲームで、結果から新規登録・既存ログインした本人に今回の1局を引き継ぎ、参加し直さず同じ参加者ID・席・ホスト権で再戦することです。**ContextProviders** は開発者の指示、AGENTS.md・README、開発・構成・テスト文書、関連実装・テスト・Git履歴の順です。**Constraints** は既存の認証・Worker・DO・D1・共通UIの利用、10分の席保持／1時間の引き継ぎ受付、再試行での期限延長禁止、全ルーム1アカウント1席、CPU戦など既存の集計条件の維持です。今回の1局以外の一括移行や新しい外部サービスは追加しません。

実装は次の責務に分けます。仕様と受入条件、認証連携、席保持と切替、記録帰属、Web接続の順に変更をまとめ、完成差分を1本のdevelop向けPRで確認します。

1. `registrationFlows`／`registrationRoutes` と追加migrationで処理ID・資格ハッシュ・対象局・元の席・期限・OAuth stateを保存します。既存のコールバックで本人と当該セッションを固定し、設定・同意完了後だけ処理します。更新は同一Origin、応答はno-storeです。
2. `GameRoom` は登録開始と本人の準備解除を同時に保存し、登録待ち中の本人の準備変更と次局開始を拒否します。通常の切断時刻は保持し、既存Alarmで10分期限を管理します。アカウント席予約とDO確定は操作ID・永続状態・取消で回復し、遅延処理で席を復活させません。
3. 席確定では新資格ハッシュ・現在の名前／アイコン・アカウント・計測対応を更新し、旧資格と旧WebSocketを失効させます。次局の開始時はアカウントとして保存し、前局の開始時計測は変更しません。席と記録の進捗は独立させます。
4. `matchClaims` の対局ID＋参加者ID対応を本人棋譜・公開棋譜・プレイヤー・履歴・集計で共有します。保存確認、帰属確定、本人履歴、バッジ・通知をD1 batchで反映します。保存待ちは保存完了時と登録完了時、5秒Alarm・毎時処理から再試行します。
5. `useResultRegistration` と `GuestRegistrationCompletion` は同じタブへ登録資格・256bitの新参加資格を保存し読戻してからOAuthへ進みます。固定コールバックと共通の認証ボタン・メリット表示を使い、復帰完了まで資格を保持します。プロフィール設定中の取消は固定した当該セッションだけを終了します。通常ログイン／管理画面ログインと既存の `registrationReturn` の復帰互換は維持します。

**Done When** は [受入検証](testing.md#終局後の登録引き継ぎ) の正常系・競合・期限・障害復旧・退会・既存認証回帰が成功し、必須のcheck・本番／開発buildとdry-run・GitHub CIが成功していることです。実Google／Discord認証、端末表示・ネイティブ操作、開発環境のmigration適用は手動確認として区別します。マージと公開にはレビューできる差分・結果を提示して承認を得ます。障害復旧にも引き継ぎ対応を読めるコードを使い、追加テーブルを削除したり対応を読めない旧版へ単純に戻したりしません。

## ルームの持ち時間・秒読み

両ゲームの作成・「すぐ遊ぶ」と待機室で `TimeControlSetting` を共有します。持ち時間はなし・1・3・5・10分、秒読みはなし・10・30秒です。「なし」は通信・保存上は0msとし、共通の `roomTimeControlSchema` でプリセット外と両方0を拒否します。作成リクエストの `timeControl` は省略可能で、省略時は従来の5分＋30秒です。選択値はダイアログを閉じても保持し、登録からの復帰でも検証して復元します。古い復帰データに時間がなければ初期値を使います。

待機中のホストは `room.time-control.set` に `{ timeControl: { mainTimeMs, byoyomiMs } }` を送ります。変更は保存・配信・公開索引へ反映し、人間全員の準備を解除します。同じ値の再送は準備・活動時刻・公開更新時刻を変えません。待機室では選択ごとに送信し、応答待ち・切断中は無効にします。再戦待機で変更しても前局の棋譜・保存済み対局の時間設定は書き換えません。

時計の開始と手番更新は両ゲームともルームの時間設定を受け取ります。持ち時間なしでは最初から毎手の秒読み、秒読みなしでは持ち時間だけを消費します。時間なしの枠はルーム情報に「なし」と表示し、秒読みなしでは0秒になっても秒読み色にしません。Workerで全14組み合わせ、開始・着手・CPU・脱落・自動パス・期限境界・権限・準備解除・永続化を確認し、Webで時計表示・登録復帰・選択payloadと待機室の送信待ちを確認します。

## 保存データの契約と棋譜互換

Workerの `matchDataContracts` は `GameId` ごとの保存記録読取り・公開要約／棋譜・戦績・ランキングの解析を必須登録します。JSONはunknownからゲーム別スキーマで検証し、内部IDと参加者のアカウント情報、設定・結果・棋譜の対応を確認します。D1のゲーム列と記録内のゲームが異なる場合も取得失敗です。集計の方向・順位・チーム・撃破数は `gameOutcomeSql` へ登録し、人間4人の条件と集計SQLは共有します。新ゲームは双方の登録と型対応が必要です。軽量カタログには保存スキーマ・エンジン・SQLを置きません。

| ゲーム       | 保存形式                                     | 再生ルール                                             | 既知の旧データ補完                         |
| ------------ | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| 四人リバーシ | 版項目のない既存JSON。初期・各手の局面を保存 | 保存された局面列を表示。ルール版を新設しない           | 既存通信スキーマに定義された既定値のみ     |
| 四人将棋     | 版項目のない既存メタデータJSONと分割イベント | `rulesVersion: 1` の初期化・イベント適用・フレーム生成 | 省略された引分提案を読取り時に空配列へ補完 |

保存形式の版、再生ルールの版、派生解析の版は別の責務です。未知のゲーム・ルール版・未対応の保存形状を既知形式へ読み替えません。破損した保存記録は既存の503、Webの再生不整合は既存のルートエラーとして扱い、未完成の棋譜を表示しません。ゲーム本体の保存JSONへ版項目を追加せず、通常の互換対応で既存データ書換え・撃破数の補完は行いません。承認された退会対応では本人の保存名と参照を除去しますが、ゲーム進行データを変更しません。本人戦績用の成立履歴は、後述の専用migrationと別テーブルで管理します。

読取りの正規化結果と保存用元データを分離します。将棋の保存待ちから来る元記録は、検証してもプロパティ順・省略項目を変更せずシリアライズし、既存manifestと同じ文字列で照合します。正規化した読取り結果を保存待ちやmanifestへ戻しません。全チャンクの検証後に本体・本人索引を公開する順序、最大400イベントの転送・検証、5秒後の再送、閉鎖後の保護、重複防止は維持します。

将棋の純粋な `fourShogiReplayV1` は保存棋譜とルーム内の直前局で共用します。取得・認証・ページング・中止・失敗処理は各loaderの責務です。現在のエンジンを呼びますが、将来の変更では固定棋譜との比較を必須とします。版1の再現性を壊す場合は新ルール版と旧版を再現する実装を別途用意し、旧版を最新のルールで黙って再生しません。移行する場合は開発者の承認後、元データを保持し、新旧の初期・途中・終局、結果・撃破数・本人索引・集計値を比較します。再実行しても重複しない手順と差異の報告を必須とし、自動バックフィルはしません。

`test-fixtures/matches` のJSONは作成元コミット・固定ID・日時・元保存JSON・将棋イベント・期待フレームを持ち、Worker、Webで共用します。通常初期局面から公開エンジンで受理された棋譜を一度生成して固定し、テスト実行時に期待値を再生成しません。省略形fixtureは既知の旧形式を再現したもので、本番から収集した記録ではありません。新しい互換ケースは既存fixtureを更新せず追加し、元データと期待値の差分をレビューします。関連テストは `bun run --cwd apps/worker test test/matchCompatibility.test.ts` と `bun test --cwd apps/web ./test/matchCompatibility.test.ts` です。

### Firebase棋譜の手動移行

Firebase `tetra-board` の旧棋譜は、元JSONをローカルに保持したまま `apps/worker/scripts/prepareFirebaseMatches.ts` でSQLと除外理由付き計画を作成します。このコマンドはDBへ接続せず、書き込みません。通常のアカウント移行で旧棋譜を除外する方針とは別の、開発者が対象を指定した手動移行です。

旧実装 `yksw-clm/tetraboard_archive` の `f70c9ba966d9a19f6165e8c72106fae310b6f237` の初期・途中・終局を照合します。リバーシは全局をシングルスとして扱い、旧初期配置・元着手・自動パス・盤面・結果を保持します。将棋はモード欠落、未記録の外部脱落等を必要とする棋譜、結果不一致を除外します。現行エンジンは脱落者の持ち駒を破棄し、ダブルス終局で敗者の王を死王として表示するため、その差が発生する局も除外します。推測したイベント、手番の強制変更、旧版と異なる局面を保存しません。時間設定だけは承認された例外として `null` を保存し、保存棋譜の持ち時間・秒読みを「不明」と表示します。ルームの時間設定は従来どおり必須です。

名前だけで本人を自動判定しません。旧UID・旧名と現在の内部アカウントID・公開IDを明示した `links.json` の指定だけを、現在の登録済みプロフィールと照合します。指定された「あるきびと」→ `arukibito`、「ちゃおっしー」→ `chaossi` 以外は `accountId: null` の人間ゲストです。開始時の表示名を保存し、旧画像・UID・認証情報を公開応答へ含めません。紐付いた対象局だけが本人履歴・既存の戦績／ランキング集計へ反映されます。通常の移行では保存名を元記録として維持し、閲覧APIでは紐付いたアカウントの現在の名前・アイコンを表示します。退会者の保存名・本人参照は退会仕様に従って除去し、旧移行データの再投入で復活させません。

事前に本番D1を読み取り、対象IDの `matches` 全列、`shogi_match_chunks` 全列、`account_match_history` 全列、および指定アカウントの `user` の `id, username, profileCompleted, isAnonymous` を `target.json` の `matches, chunks, history, users` に保存します。既存の記録・チャンク・本人索引と競合する場合は計画作成を停止します。同一データは再実行でき、SQL実行時にも既存行を上書きせず、変更された紐付け先や行の競合で停止します。SQLは本体の前に将棋チャンク、本体の後に本人索引を生成します。ゲストの本人索引は作りません。対象局の不足／余分な行がないことと集計差分を、実行前後で確認します。

```sh
cd apps/worker
bun scripts/prepareFirebaseMatches.ts <export-directory> <links.json> <target.json> <output.sql>
```

出力と元JSONはGit管理外・本人だけが読めるファイルとして保持します。SQLのローカルD1での保存・再実行、公開／本人応答、局面・結果・本人索引・戦績の比較と、全必須検証・GitHub CIを確認してPRを提出します。マージ・公開と本番取り込みは、差分・対象一覧・除外理由・検証結果をレビューできる状態にして開発者が承認してから実施します。承認後も実行直前に本番の事前照合を更新します。

### 四人将棋の戦型解析と通知

`packages/four-shogi/src/formations.ts` の `detectFormations(position, side)` はルール版・盤面・脱落情報だけを入力にし、公開局面とサーバーのルール状態をそのまま渡せます。16戦型の固定定義をここに集約し、初期配置と同じ `positionForSide` の回転を再利用します。結果は安定した `id`・`name`・9枚の `matchedSquares`（実盤座標）です。公開定数は `formationAnalyzerId = "four-shogi-formations"` と `formationAnalysisVersion = 3`。`formationIds` は定義順の全16IDを公開します。単独ID `subway-rook` は廃止し、`lower-gold` と `yuzuu-muge` は従来の配置とIDを維持して、それぞれ「地下鉄飛車・下段金寄せ」「地下鉄飛車・融通無碍」を正式名称にします。各名称を1件の解析結果として返します。条件・意味を変える場合は解析版を更新し、ルール版・保存版とは分けます。

HTTPの `GET /rooms/:id?formationAnalysis=1` とWebSocketの `/rooms/:id/ws?instanceId=...&formationAnalysis=1` は、通常の応答の `room` の外側へ任意の `formationAnalysis` を付加します。将棋の待機中は `null`、対局中は `{ analyzerId, analysisVersion, rulesVersion, roundId, positionRevision, matches: { south, west, north, east } }`。要求なしとリバーシには項目を付加しません。`protocol` は通信スキーマだけを管理し、戦型IDの列挙と判定条件はエンジンに置きます。エンジンへのprotocol依存追加はありません。成立一覧の上限は17件、根拠座標は各9件で、同時成立も別項目として返します。要求クエリと接続タグは解析版とは独立し、版3でも従来の形式を使います。受信上限17件は旧版との通信互換性のため維持します。

WorkerはWebSocketの要求を `formation-analysis-v1` 接続タグで保持し、従来の認証attachmentを維持します。配信ごとに通常応答と付加応答を各1回だけ生成して共有します。HTTP・WebSocketとも確定したルーム状態の4陣営を判定します。付加解析結果をルーム状態・棋譜・保存対局JSONへ含めません。本人戦績用の成立履歴は下記の専用処理・別テーブルで保存します。WebはHTTPで付加項目の有無を確認し、対応Workerの場合だけWebSocketでも要求します。再接続時にHTTPで再確認するため、旧Workerへの切替も従来形式で動作します。

`useShogiFormationNotice` は `room.game` を共有関数で照合し、楽観表示用の `session.displayGame` とサーバーの派生結果を通知判定に使いません。認証・接続済みの本人について、同じ局の連続revision・連続手数・本人の直前手と不成立→成立を確認します。未通知の新規成立をすべて取り出し、通知データ `{ ids, name }` の名称を定義順に「・」で連結します。初回・再接続・飛んだrevisionは基準とし、既に成立している戦型も既知IDへ含めます。部屋世代・本人ごとの `sessionStorage` キーに局ID・解析版を含むscopeと通知済みIDを保存し、次局で置き換えます。保存値は全16種類の既知IDだけを受け付け、解析版1・2のscopeは引き継がず初回局面を基準にします。まとめ通知の全IDを通知済みにします。保存エラーはメモリ内の抑止へ退避します。別タブ同期は行いません。

`FourShogiBoardLayout` の任意propsで本人側2段目中央に名称を重ね、2000ms・選択・ドラッグ・成り選択・切断・脱落・終局・次局で消します。既存のCSS効果ファイルに置いた `shogi-formation-fade` は2秒のうち0〜180msをフェードイン、1760〜2000msをフェードアウトにし、opacityだけをease-in-outで変えます。名称をkeyにして別戦型への置換時はフェードを再開します。`motion-safe` で動きを減らす設定の場合は省略し、操作や切断などによる解除は即時のままです。表示・解除用の状態やタイマーは増やしません。盤内縮尺・クリック透過・`role=status` の控えめな読み上げを使い、音・フォーカス移動・寸法変更はありません。観戦と棋譜には接続しません。

エンジンは実装定義と独立した完成図fixtureで16形×4方向×両モードと各必須条件を検証します。Workerは実HTTP・WebSocketの混在接続、確定revision、再接続、インスタンス再作成時のタグ・認証維持、保存分離を検証します。WebはBun＋happy-domと偽時計で、受理前／後、1999ms／2000ms、重複抑止・保存エラー・操作・再接続時の対応確認を検証します。従来の固定棋譜の回帰も維持します。

### 将来の派生解析

囲いなどの派生解析は復元済みの読取り専用局面を入力とする純粋な処理として設計します。入力の出所はゲーム・対局ID・局面位置・保存形式・ルール版で識別し、結果は解析器ID・解析バージョン・対象局面・判定根拠を持つ別データとします。保存された盤面・棋譜・勝敗・撃破数は記録の正本であり、解析結果によって変更しません。解析からGameRoom、storage、D1の更新、戦績SQLを呼びません。解析の再実行も元データを変更せず、版ごとの結果を比較できる構成にします。

16戦型の判定と通信・通知は上記の専用処理で実装しています。シングルス専用AIの入力復元は [独立API](four-shogi-ai-engine.md#完全解析状態の復元api186) で扱い、戦型の公開指標を追加するものではありません。本人戦績用の専用成立履歴テーブルは下記の範囲で使用します。戦型別ランキングなど新しい指標とバックフィルは仕様承認、比較検証、再実行可能な移行計画を別途必要とし、Admin KPIは #43 の範囲です。

### 四人将棋シングルスの拡張戦績

通常戦績の `perfectWins` は保存済み結果の単独1位、終局理由 `last_player`、本人の撃破数3をすべて満たす局数です。過去分も既存の対人戦条件で集計します。Webの撃破率は `knockouts / total` を既存の率整形で小数3桁にし、最大3.000・0局は.000です。

`shogiFormationUsage` は解析器ID・解析版3・ルール版1と陣営別の使用ID集合を扱います。開始時の人間4人・シングルスにだけ `ActiveShogiMatch.formationUsage` を初期化し、受理された本人着手の前後を `detectFormations` で比較します。新規成立の全IDを集合へ追加し、イベント・状態と同じDOトランザクションで保存します。開始時に印がない既存進行局は途中から初期化しません。通知状態・要求クエリ・未確定盤面には依存せず、エンジンの入力・順位・千日手キーを変更しません。

終局で成立履歴を `PendingShogiMatch` へ引き継ぎ、D1 migration 0011の `shogi_match_formations` に対局ID・解析器ID・解析版・ルール版・陣営別ID集合を保存します。成立なしも空集合の行を保存します。全棋譜検証後、本体・本人索引・履歴を同じ最終batchで公開します。履歴の失敗も保存待ちを保持して既存の5秒再送へ戻し、対局IDの一意キーで重複を防ぎます。元の保存JSON・manifest・棋譜形式を維持し、過去分を再解析・補完しません。

`GET /api/account/four-shogi/formation-stats` はCookieで本人を確認し、同じ対人戦CTEと成立履歴を結合して全対象局をD1内で集計します。現行解析版の経験済み戦法だけの `{ id, total, first, second, third, fourth }[]` を返します。0件は空配列、未認証401、認証・D1失敗503、`Cache-Control: no-store`です。棋譜ページの取得件数には依存しません。protocolは通信型を定義し、戦法ID・名称・固定Noの正本はエンジンパッケージの軽量 `formation-catalog` 入口です。Webのアカウント画面へ盤面・CPU実装を読み込ませません。

Webは通常戦績と戦法別戦績の取得状態を分け、将棋シングルスの選択時だけ戦法別データを読みます。ゲーム・モード往復では結果を保持し、「更新」は両方を取得、再試行は失敗した側を取得します。ダイアログは共通 `AppDialog` と黄色テーマを使い、選択変更で閉じます。カード画像は添付JPEGをそのまま静的資産として使用し、未経験カードには実名・画像を出しません。画像は `public/four-shogi/formations/` に置き、本番Workerは `/four-shogi/formations/` を `ASSETS.fetch` へ渡します。Worker統合テストで全16画像の配信・HEAD・304と欠落画像の404を確認します。集計開始時点・期間は画面に表示しません。

純粋関数で全16戦法×4方向・同時成立・再成立・入力不変、Workerで確定着手・DO再作成・終局保存と再送・保存失敗時の一括ロールバック・本人/方向/全件/対象外/同率順位/旧データを確認します。Webは独立した取得・エラー・更新・保持・カード秘匿・順位のみのダイアログ・選択変更をDOMテストで確認します。横スクロール・名前の収まり・実画像・ネイティブ入力は手動確認し、ブラウザ自動テストは追加しません。

## バッジ判定と画像

Protocolの `badges.ts` に種類・名称・単位・閾値・表示順と純粋な判定関数をまとめます。ゲーム別シングルスの `AccountStats` から星0〜3、現在値、次の目標を導出します。バッジの現在表示は通常戦績の保存済み対局から導出します。獲得通知だけを下記の専用記録で管理し、WebSocket配信は追加しません。

Webの `AccountStats` は既存hookの結果をバッジ欄と戦績で共有します。公開カードは既存 `readAccountStats` の結果から獲得済みだけを返します。`GET /api/player-profile` は省略可能な `includeBadges=1` を受け、この指定時だけ登録者の応答へ `badges: { id, tier, value }[]` を追加します。未獲得は含めず、ゲスト・CPUには追加しません。無指定時の応答は従来どおりです。新Webは400時に一度だけ追加指定を外して再取得し、旧応答のバッジ情報不足を未獲得と判定せず欄を省略します。既存のキャッシュ期限・無効化・abortと内部ID非公開を維持します。利用可能な高さを超える情報はカード内でスクロールし、カード内のスクロールでは閉じません。

配信用画像は `apps/web/public/assets/badges/` のゲーム別ディレクトリに、種類と星を含む名前の透過256px WebPを18枚置きます。生成原本・修正前の画像は配信に含めません。星3の数字はWeb側で重ね、画像ごとのプレート座標と桁数・描画幅に応じた文字サイズを使います。バッジは再生成せず、元の透過・形・色を保って配信形式へ変換します。

共通 `BadgeImage` は画像のネイティブドラッグを無効にします。マイページの画像は72pxを基本に、651px以上では画像とテキストを横に並べ、小さい画面では縦に並べます。名前・ランク・現在値と次の目標・条件だけを表示し、全段階の閾値一覧と残り件数の重複表示は省きます。

共通 `PlayerBadges` は獲得済み画像だけを56px・間隔4pxの折り返し可能な横並びで表示します。見出し・キャプション・条件の開閉欄・title属性のツールチップは設けません。画像内の星3累計を保持し、画像のaria-labelにはバッジ名・ランク・累計を付けます。各画面のプレイヤー情報カードで同じ部品を使います。

純粋関数テストは閾値直前・到達・超過と星3以降の累計、Workerは過去分・対人戦・ゲーム別集計・同率優勝・完全優勝とAPI互換性、DOMテストは未獲得・獲得済み・モード切替・更新失敗・旧Workerへのフォールバックを確認します。実画像・縮小表示・数字位置・スマートフォン配置・ネイティブ操作は手動確認します。

### バッジ獲得イベントとtoast

Goalは、初獲得・昇格の確定を本人へ画像付きtoastで伝え、通常時の複数取得・遷移・再接続で重複や取りこぼしを防ぐことです。ContextProvidersの優先順位は承認済み指示、AGENTS、READMEのバッジ仕様、開発・テスト文書、Issue #122と既存実装・Git履歴です。Constraintsは既存集計・閾値の維持、D1保存後の本人限定通知、既存HeroUI・画像の再利用、純粋関数／happy-dom／Worker統合テスト、必須ローカル検証とGitHub CIです。Done Whenは閾値・昇格・対象外、最大4種類、移行基準、保存失敗と再送、取得競合と認証、5秒と停止、遷移・復帰・アカウント切替の検証成功、文書更新、レビューできるPRの提出です。画面寸法・実画像・ネイティブ入力・実際の読み上げは手動確認と未確認事項を記録します。

D1 migration `0013_badge_notifications.sql` は `account_badge_awards` と `account_badge_notifications` を作成します。前者はアカウント・ゲーム・種類・星を一意にし、取得時の累計・直前ランク・対局IDを保存します。後者はアカウント・対局ID単位の通知、保存時刻、表示済み時刻、取得tokenと期限を持ちます。既存戦績を同じ対人シングルス条件で集計して達成段階を基準行として登録し、対局IDをnullにして過去の通知は生成しません。表示用のバッジ取得履歴APIは追加しません。未表示通知に期限を設けず、既存6種類×3段階の最大18取得行／アカウントに収まります。

`badgeAwardsSql` は `matchOutcomesCte` とprotocolの名称・閾値の正本を使います。通常保存は対局本体・本人索引の後、将棋は全棋譜チャンク検証後の最終batchへ `badgeAwardStatements` を追加します。保存された本人索引で対象アカウントを限定して全期間の戦績を集計し、未記録段階を一意キーで追加して同じ対局の通知を作成します。通知行の失敗も本体・本人索引・取得行と一緒にロールバックし、既存の5秒再送へ戻します。競合する再送の参加者情報は使わず、確定済み対局・索引を参照します。星3以降の累計更新は新規取得行を作りません。通知の画像内累計は取得時点の値で、マイページの現在値は従来どおりです。

本人向けの `POST /api/account/badge-notifications/claim` はUUIDのtokenを受け、最古の未表示グループだけを15秒間貸し出します。アカウントをCookieで確認し、同一Originを必須にしてno-storeで応答します。同時の別tokenは取得できず、同一tokenは再取得・延長できます。返却は `{ notification: { id, game, badges: { id, tier, previousTier, value }[] } | null }`。同一種類で複数段階を超えた場合は最高ランクだけを返します。

`shown`・`renew`・`release` はtokenと通知IDを受けます。表示済み記録・延長には未失効の取得権を必須とし、別アカウントからの指定は拒否します。shownの成功応答を失った同一tokenの再送は成功扱いです。表示前の非表示化はreleaseし、終了やログアウトで未表示の取得権が残っても15秒後に再取得できます。未認証401、Origin不正403、入力不正400、取得権失効409、認証・D1失敗503です。

`AccountLayout` 内の `BadgeNotificationProvider` はアカウント単位の取得状態と共通toastキューを保持します。認証確認済み・表示中に5秒ごと、online・表示復帰時と既存toast終了時にも取得し、同時取得を防ぎます。認証の再確認中・失敗中は新しい通知を取得せず、取得応答の到着時にも確認待ちならreleaseします。HTTPは10秒で中止して再試行し、通知の取得失敗で対局や既存UIを止めません。画面のOutlet変更では状態を破棄しません。取得後に非表示なら表示せずreleaseします。実際のtoast内容の描画後にshownを送信し、失敗時は再送と取得権延長を行います。失効時は再取得へ戻り、同じ画面で既に表示したIDは再演せず記録だけを再試行します。別タブ・端末の抑止はサーバーの取得権・表示済み記録を使います。

`AppToastRegion` は既存のHeroUI外観・位置・幅と既定の積み重ねを共有します。バッジは既存toastが終わってから取得し、同じ対局の全種類を1つにまとめ、別対局は順に取得します。バッジのタイトル・ゲーム名・画像列は中央揃えとし、折り返した行も中央に並べます。バッジは5秒、既存チャット・コピーは3秒です。HeroUIが非表示・ホバー・フォーカスを独立した停止理由として残り時間を管理します。バッジ内容のrole=status・aria-live=politeを指定し、画像は装飾として扱い、文字でゲーム名・種類・星・累計を伝えます。アカウント切替時は退出アニメーション中も本人内容を隠し、取得を中止して古い応答を無視します。新しい依存・外部サービス・通知音は追加しません。

Workerの `badgeNotifications.test.ts` は全段階、ゲーム別集計、同時4種類、過去基準、保存ロールバック・再送、取得競合・失効・解放、Cookie・Origin・入力・本人制限を確認します。Webの同名DOMテストは画像と順序、初獲得・昇格文言、表示後の記録、5秒境界、非表示・表示復帰・フォーカス停止、別対局の順次表示、認証確認待ち、遷移、通信失敗、失効からの復旧、ログアウト・切替・StrictModeの古い応答、既存通知との共用を確認します。
