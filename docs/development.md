# Development

## 最初に読む案内

この文書は実装を探す入口、変更手順、構造と注意点を記します。最初にこの案内と次の共通手順を読み、変更対象別の表から必要な節へ進んでください。仕様を判断するときは、案内のリンク先にある正本の本文を確認します。


| 文書                                                     | 主に残す内容                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| [README](../README.md)                                   | サービスの目的、利用者向け仕様、詳細への入口                 |
| [ゲームのルール正本](#変更対象別の案内)                  | ゲーム固有のルールとCPUの現在の採用仕様                      |
| [構成文書](architecture.md)                              | 技術構成、責務と状態の分担、長期参照が必要な設計理由         |
| この開発文書                                             | 実装の入口、変更手順、構造と互換性などの注意点               |
| [テスト方針](testing.md)                                 | 実行方法、検証範囲、対象別のテスト                           |
| [四人将棋AIの測定・採用記録](four-shogi-ai.md)           | 比較条件、対象コミット、結果、採用判断と限界                 |
| [四人リバーシAI強化の計画・採用判断](four-reversi-ai.md) | Goal・制約・受入条件・コミット計画、測定条件と採用判断の記録 |

CPUの探索方式・上限・評価値など、現在の採用仕様はルール正本で保守し、実装案内から参照します。APIの使用例や実装の責務はこの文書に残します。測定時の設定や旧方式は測定対象コミットにひも付く条件として保持し、現在仕様へ書き換えません。正本にない実装値を、新しい採用仕様として推測で確定しないでください。

## 共通の作業手順

1. [AGENTS.md](../AGENTS.md) の作業・承認・検証ルールを確認し、READMEの対象箇所と、ゲーム固有の変更なら対象ゲームのルール正本を読みます。
2. コードの作成・変更・レビューでは [Code Principles](#code-principles)、[Naming](#naming)、[Comments](#comments) を確認します。ローカル起動が必要な場合は [ローカル開発と検証](runbooks/local-dev.md)、検証環境は同じ文書 と [テスト方針の実行環境](testing.md#実行環境) を参照します。
3. 下表から必要な仕様・実装・テストを確認します。共通部品や通信・時計・保存を横断する変更では、関連する行の説明と契約も読みます。案内にない対象は見出し・キーワードを検索して参照範囲を広げます。
4. 仕様と実装に差があれば、承認指示・正本・Git履歴・利用できるIssue／PRを照合し、文書の陳腐化か実装の不具合かを判断します。未決定事項や矛盾を推測で埋めず、開発者に確認します。
5. 変更に伴う仕様文書と実装案内を更新し、関連文書を検索して現在仕様として旧説明が残っていないか確認します。[PR提出前の検証](runbooks/local-dev.md#pr提出前の検証) を行い、[PRテンプレート](../.github/pull_request_template.md) に対象コミット・環境・結果・未確認事項を記載します。

## Workerとの互換性と定期処理

進行中レート戦の観戦カードを表示するWebは、`previousMatch=1` に対応した本変更以降のWorkerを必要とします。先にD1 migration `0042_rating_pending_rooms.sql` を適用し、既存のレート保存待ち台帳へルーム番号と世代を追加します。新規の予約時に席の参照を同じD1 batchへ記録し、退室後も保存完了まで参照を維持します。移行時に席がある旧予約は操作IDで補完し、参照のない旧予約はCoordinatorに割当が残っていれば復元します。復元できないときも保存完了までは検索を止めます。

前局の照会（`apps/worker/src/adapters/matchmaking/previousMatch.ts` と文脈の `domain/previousMatch.ts`）は4ゲームの保存待ち台帳を本人IDで照会し、`previousMatch=1` を指定した登録者向けのidle・playing応答に前局を追加します。受付確認・旧クライアントのGETには前局用の照会・応答項目を増やしません。GameRoomの対局ID・部屋世代を検査した公開メタ情報だけを返します。joinと待機列の成立処理も全台帳を確認し、別ゲームや旧待機からの重複参加を拒否します。Webの `PreviousRatedMatchCard` は既存のカード・盤面アイコンを使い、`watch=1` の観戦URLを案内します。`useMatchmaking` は確認済み状態と前局の有無を検索条件にし、状態GET失敗後も検索を開始しません。POSTの通信失敗は従来どおり本人の明示再試行を許可します。

Webの最低対応Workerは2026-11-06時点の本番main `35ddc5ee32127425ea875f1e2bc6457c3e09163d` 以降です。ルームの `eliminatedHands`、ランキングの `profilePreview`・`includeKnockouts`、公開プロフィールの `includeBadges`・`includeStats` を受理することを前提とします。ひとこと・お気に入りゲームを表示するWebには、追加の `includeDetails=1` を受理する本変更以降のWorkerが必要です。400を受けてオプションを除去する自動再取得は行いません。古いWorkerへ切り戻す場合は対応するWebも戻し、欠落公開IDや平文トークンを現行環境へ持ち込まない移行・復元確認が必要です。新Workerの省略可能な応答項目は維持するため、既存Webのタブも引き続き利用できます。

`scheduledMaintenance.ts` は定期処理を固定順に実行し、一つのジョブが失敗しても後続を実行します。ジョブ名・成否・所要時間を記録し、すべての実行後に失敗名だけを例外として報告します。ログの成功時刻で各ジョブの最終成功を確認し、失敗は次のcronで再試行します。例外本文・認証値・個人情報は追加ログに含めません。退会などの既存の処理順は保ち、全ジョブを並列化しません。

`0027_lookup_indexes.sql` は退会対象ルームの検索に `(room_id, account_id)`、ゲーム横断の最新対局に `(started_at_ms DESC, id DESC)` の索引を追加します。適用は通常の開発・本番デプロイ手順で行い、データを書き換えません。チャットの本文・受付設定・投稿制限・大会状態は `chatPage` の1回のD1 batchで取得します。

GameRoomのWebSocket認証はtokenのhash計算後に期限処理を一度行い、同期的な資格照合へ進みます。公開RPCの期限処理も維持します。保存待ちが空の索引・席解放・大会反映・対局保存ではAlarmの再同期を省きます。実行中のflushは引き続き待ち、保存や失敗再送が期限を変えた場合はAlarmを再同期します。

## 文脈のパッケージ

Worker の処理は、文脈ごとのパッケージ `packages/contexts/<文脈>/`（`@tetraboard/context-<文脈>`）へ順に移します（[ADR 0010](adr/0010-contexts-and-shell.md)）。中は `src/domain/` と `src/use-cases/` に分けます。

`bun run lint` が、依存の向きを `scripts/checkContextDependencies.ts` で検査します。

- 文脈が依存してよいのは、`@tetraboard/context-shared`、`@tetraboard/game-contract`、ゲームのパッケージ、`@tetraboard/protocol` だけです。`context-shared` はほかの文脈に依存しません。
- 文脈のソースは、Cloudflare（`cloudflare:`、`@cloudflare/`）、`zod`、`drizzle-orm`、`hono`、`better-auth`、ほかの文脈を import しません。パッケージの外への相対パスも使いません。
- `@tetraboard/protocol` からは `import type` だけを使います。入力の検証は Worker の殻が受け持ちます。

## D1 のスキーマと migration

D1 のスキーマは `apps/worker/src/db/schema/` に drizzle で定義しています。トリガーは drizzle で表さず、SQL の migration に残しています。

スキーマを変えるときは、drizzle の定義を直してから、次のコマンドで migration を作ります。drizzle-kit の出力を、`apps/worker/migrations/` の次の番号の `NNNN_<名前>.sql` として置きます。drizzle-kit のスナップショットとジャーナルは `apps/worker/drizzle/meta/` にあり、手で編集しません。

```sh
mise exec -- bun run --cwd apps/worker db:generate -- <名前>
```

`bun run --cwd apps/worker test:db` は、全 migration を適用した SQLite と drizzle の定義が一致すること、スナップショットから変更がないことを確かめます。`bun run check` と CI でも実行します。

0001〜0057 は、TB-75 で `0058_baseline.sql` の 1 本にまとめました。基準は 0001〜0057 を当てた結果と同じスキーマと初期データを作り、空の D1（テスト、ローカル、新しい環境）にだけ当たります。本番と開発の D1 は、0057 まで当てた後で `d1_migrations` に `0058_baseline.sql` の行を手で入れてあり、基準は当たりません。

- 次の migration は 0059 から番号を続けます。消した 0001〜0057 の名前は使い回しません。wrangler は `d1_migrations` に名前のないファイルだけを当てるので、古い名前で中身を変えると、既存の D1 では当たらないまま、テストでは当たって、気づかないままずれます。
- 消した migration が行ったデータの変換のテストも、同じ PR で消しました。古い形のデータをアプリが扱えることのテストは、データを基準のスキーマへ直接入れる形で残しています。

## 変更対象別の案内

実装・テスト欄は代表的な入口です。対象別の部分実行コマンドは [変更対象別の確認](testing.md#変更対象別の確認) にまとめています。PR前の必須検証は上の共通手順に従います。

共通ナビの「遊び方」を変更するときは、[サイトの利用ガイド](#サイトの利用ガイド)と[受入確認](testing.md#サイトの利用ガイドの確認)を参照します。

| 変更対象                                 | 仕様の正本                                                                                                                                                        | 開発文書の該当節と主な実装                                                                                                                                                                                                                                                                    | テストの入口                                                                                                                                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 終局後の登録・対局引き継ぎ               | [共通仕様](../README.md#終局後の登録と継続再戦)                                                                                                                   | [実装と完了条件](#任意登録の案内と画面復帰)、[構成](architecture.md#終局後の登録フローと記録の帰属)、[registrationRoutes.ts](../apps/worker/src/routes/registrationRoutes.ts)、[matchClaims.ts](../packages/contexts/record/src/use-cases/matchClaims.ts)                                                 | [受入検証](testing.md#終局後の登録引き継ぎ)                                                                                                                                                            |
| 認証・プロフィール・参加資格             | [認証とプロフィール](../README.md#googlediscord認証とプロフィール)、[参加](specs/room.md#対局部屋と参加)                                                           | [認証と移行](#google認証とアカウント移行)、[アカウント参加](#アカウントでのルーム参加)、[auth.ts](../apps/worker/src/adapters/account/auth.ts)、[AccountSession.tsx](../apps/web/src/features/account/AccountSession.tsx)                                                                             | [accounts.test.ts](../apps/worker/test/accounts.test.ts)、[accountSession.test.tsx](../apps/web/test-dom/accountSession.test.tsx)                                                                      |
| プライバシー・規約・退会・計測期限       | [仕様](specs/privacy.md)                                                                                                       | [入口](#プライバシーの入口)、認証・棋譜・ルーム・計測・フィードバックの既存入口                                                                                                                                                                                               | [検証と公開前の確認](testing.md#プライバシー規約退会の確認)                                                                                                                                            |
| 時計・接続・ルーム進行                   | [投了、通信切れと持ち時間](specs/room.md#投了通信切れと持ち時間)                                                                                                   | [共有transport](#共有transportとゲーム別session)、[ルームの実装の入口](#ルームの実装の入口)、[clockCore.ts](../packages/contexts/room/src/domain/clockCore.ts)、[useRoomTransport.ts](../apps/web/src/features/room/useRoomTransport.ts) | [timeControl.test.ts](../apps/worker/test/timeControl.test.ts)、[roomTransportLifecycle.test.tsx](../apps/web/test-dom/roomTransportLifecycle.test.tsx)                                                |
| 終局保存・棋譜・互換性                   | [終局保存](../README.md#終局データの保存対局履歴)、[保存棋譜](../README.md#保存済み棋譜の閲覧)、対象ゲームの正本                                                  | [終局保存](#終局保存と本人の対局履歴)、[棋譜互換](#保存データの契約と棋譜互換)、[matchStore.ts](../apps/worker/src/adapters/record/matchStore.ts)、[shogiMatchStore.ts](../apps/worker/src/adapters/record/shogiMatchStore.ts)、[fetchEventReplay.ts](../apps/web/src/features/room/fetchEventReplay.ts)          | [matchCompatibility.test.ts](../apps/worker/test/matchCompatibility.test.ts)、[savedReplay.test.tsx](../apps/web/test-dom/savedReplay.test.tsx)                                                        |
| 総合ロビー・公開チャット                 | [確定仕様](../README.md#総合ロビーの確定仕様)                                                                                                                     | [実装](#総合ロビーの実装)、既存のルーム索引・公開棋譜・認証・管理・配信                                                                                                                                                                                    | [受入検証](testing.md#総合ロビーの確認)                                                                                                                                                                |
| 掲示板 | [仕様](specs/board.md)、[ADR 0015](adr/0015-board-post-pages.md) | [コミュニティの入口](#コミュニティの入口)の掲示板、[boardRoutes.ts](../apps/worker/src/routes/boardRoutes.ts)、[board.ts](../packages/contexts/community/src/domain/board.ts)、画面の HTML は [boardPages.ts](../apps/worker/src/boardPages.ts)、画面は [features/board](../apps/web/src/features/board/) | [boardPosts.test.ts](../apps/worker/test/boardPosts.test.ts)、[boardReads.test.ts](../apps/worker/test/boardReads.test.ts)、[boardDeletion.test.ts](../apps/worker/test/boardDeletion.test.ts)、[boardPages.test.ts](../apps/worker/test/boardPages.test.ts)、[board.test.tsx](../apps/web/test-dom/board.test.tsx) |
| 大会・大会管理                   | [確定仕様](specs/tournament.md#四人将棋大会の確定仕様)、[大会対局の例外](rules/four-shogi.md#大会対局の例外)                                                             | [実装計画](specs/tournament.md#維持する契約)、[承認済みモック](#四人将棋大会のuiモック)、[構成方針](architecture.md#四人将棋大会の構成方針)、既存の認証・GameRoom・終局保存・Admin                                                                                                                     | [受入検証](testing.md#大会の確認)                                                                                                                                                              |
| 画面・ロビー・共通部品                   | READMEの対象画面、[共通UI](../README.md#共通uiとスタイル)                                                                                                         | [Webの編集先](#webの編集先)、[共通ロビー](#共通ロビーと四人将棋ui)、[LobbyView.tsx](../apps/web/src/features/lobby/LobbyView.tsx)、[RoomLayout.tsx](../apps/web/src/features/room/RoomLayout.tsx)、[shared/ui](../apps/web/src/shared/ui/)                                                    | [lobbyComponents.test.tsx](../apps/web/test-dom/lobbyComponents.test.tsx)、[presentation.test.tsx](../apps/web/test-dom/presentation.test.tsx)                                                         |
| ルーム共有                               | [ルーム共有の仕様](specs/room-sharing.md)                                                                                                             | [実装](#ルーム共有の実装)、[useRoomEntry.ts](../apps/web/src/features/lobby/useRoomEntry.ts)、[useRoomInvitation.ts](../apps/web/src/features/room/useRoomInvitation.ts)、[publicAssets.ts](../apps/worker/src/publicAssets.ts)                 | [ルーム共有の確認](testing.md#ルーム共有の確認)                                                                                                                                                        |
| ゲーム・CPU                              | [四人リバーシ](rules/four-reversi.md)、[四人将棋](rules/four-shogi.md)、[リバーシ](rules/reversi.md)、[将棋](rules/shogi.md)、[五目並べ](rules/gomoku.md)         | [ゲームの必須登録](#ゲームの必須登録と型の対応)、[四人将棋エンジン](#四人将棋エンジン)、[四人将棋CPU](#四人将棋cpu)、[通常リバーシ](#通常リバーシの実装)、[通常将棋](#通常将棋の実装)、[packages](../packages/)、[gameProgress.ts](../apps/worker/src/adapters/room/games/gameProgress.ts)                  | 各ゲームの `test/`、[cpuSearch.test.ts](../packages/four-shogi/test/cpuSearch.test.ts)、[commonRoomBehavior.test.ts](../apps/worker/test/commonRoomBehavior.test.ts)                                   |
| 表示・サウンド設定                       | [設定](specs/room.md#表示サウンド設定)、[効果音](specs/room.md#効果音)、[時計通知](specs/room.md#時間切れ5秒前の通知)                                                | [表示・サウンド設定](#表示サウンド設定)、[共通効果音](#ルームの共通効果音)、[browserSettings.ts](../apps/web/src/shared/browserSettings.ts)、[soundPlayer.ts](../apps/web/src/shared/soundPlayer.ts)                                                                                          | [設定の確認](testing.md#表示サウンド設定の確認)、[browserSettings.test.tsx](../apps/web/test-dom/browserSettings.test.tsx)                                                                             |
| チャット・スタンプ                       | [チャット](specs/room.md#チャット)、[保存とモデレーション](specs/room.md#チャットの保存期間とモデレーション)、[スタンプ](specs/room.md#ルームのスタンプ)             | [スタンプ](#ルームのスタンプ)、[chat.ts](../apps/worker/src/durableObjects/gameRoom/chat.ts)、[stamps.ts](../apps/worker/src/durableObjects/gameRoom/stamps.ts)、[useSessionChat.ts](../apps/web/src/features/room/useSessionChat.ts)、[useRoomStamps.ts](../apps/web/src/features/room/useRoomStamps.ts)                                                                  | [スタンプの確認](testing.md#ルームのスタンプの確認)、[commonRoomBehavior.test.ts](../apps/worker/test/commonRoomBehavior.test.ts)                                                                      |
| 戦績・ランキング・戦型・バッジ           | [戦績](../README.md#戦績の表示)、[ランキング](../README.md#ランキングの表示)、[バッジ](../README.md#バッジ)、[四人将棋の戦型](rules/four-shogi.md#戦型の成立判定) | [戦績集計](#本人の戦績集計)、[ランキング](#ゲーム別のランキング)、[戦型解析](#四人将棋の戦型解析と通知)、[バッジ](#バッジ判定と画像)、[record の adapter](../apps/worker/src/adapters/record/)                                                                                                                | [accountStats.test.ts](../apps/worker/test/accountStats.test.ts)、[badgeNotifications.test.ts](../apps/worker/test/badgeNotifications.test.ts)、[バッジ通知の確認](testing.md#バッジ獲得通知issue-122) |
| 管理画面・計測・フィードバック・お知らせ | [管理画面](../README.md#管理画面)、[計測](specs/analytics.md)、[フィードバック](../README.md#フィードバック受付とお知らせ)、[お知らせ管理](../README.md#お知らせの管理とロビー掲載)     | [管理画面](#管理画面の開発と公開)、[フィードバック運営](#フィードバックの受付運営)、[お知らせ](#お知らせの保存管理公開)、[admin](../apps/worker/src/admin/)、[apps/admin](../apps/admin/src/)                                                                                           | [kpi.test.ts](../apps/worker/test/kpi.test.ts)、[feedback.test.ts](../apps/worker/test/feedback.test.ts)、[announcements.test.ts](../apps/worker/test/announcements.test.ts)     |
| 公開・環境設定・CI                       | [デプロイと環境](runbooks/deploy.md)、[AGENTS.md](../AGENTS.md)                                                                                          | [ローカル開発と検証](runbooks/local-dev.md)、[個人設定からの分離](testing.md#個人設定からの分離)、[ci.yml](../.github/workflows/ci.yml)、[buildAssets.ts](../scripts/buildAssets.ts)                                                                                                     | [testEnvironment.test.ts](../apps/worker/test/testEnvironment.test.ts)、[publicAssets.test.ts](../apps/worker/test/publicAssets.test.ts)、必須のcheck・build・Worker dry-run                           |
| 五目並べ                                 | [追加範囲](../README.md#五目並べ)、[ルール正本](rules/gomoku.md)                                                                                                  | [実装](#五目並べの実装)、[ゲームの必須登録](#ゲームの必須登録と型の対応)                                                                                                                                                                                         | [エンジン](../packages/gomoku/test/)、[Worker](../apps/worker/test/gomokuRoom.test.ts)、[DOM](../apps/web/test-dom/gomoku.test.tsx)                                                                    |
| 四人五目並べ                             | [追加範囲](../README.md#四人五目並べ)、[ルール正本](rules/four-gomoku.md)                                                                                         | [実装](#四人五目並べの実装)                                                                                                                                                                                                                        | [エンジン](../packages/four-gomoku/test/)、[Worker](../apps/worker/test/fourGomokuRoom.test.ts)、[DOM](../apps/web/test-dom/fourGomoku.test.tsx)                                                       |

## Rust AI開発基盤

新しいAI基盤の入口は [packages/ai](../packages/ai/README.md) です。フェーズ4で脱落後を含む四人リバーシ・シングルスを対象に、engine・agents・benchmark・serverの4 crateで構成します。ルールの正本は既存の[四人リバーシルール](rules/four-reversi.md)です。[対応範囲](../packages/ai/docs/rules-four-player-reversi.md)、[フェーズ1の評価・探索・比較](../packages/ai/docs/phase1.md)、[フェーズ2のAPI・認証・接続・コンテナ](../packages/ai/docs/phase2.md)を参照してください。[フェーズ3のMCTS・API v2・採用基準](../packages/ai/docs/phase3.md)も参照してください。GameRoomのAlarmは未完了の要求を保存し、transaction外でHTTPを待ち、照合済み候補を次Alarmで適用します。I/Oの権限をProgressへ渡さず、既存AIを新しいAgentへ流用しません。

Rustはmiseで固定し、`mise install`でrustfmt・Clippyも導入します。Rustの識別子とファイル名はRust標準のsnake_caseとし、コメントは日本語の丁寧体を使います。ルートの`bun run check:ai`とCIの`ai`ジョブで検証します。`bun run --cwd packages/ai check`は型・Rust整形・Clippy・Rustテスト・TypeScript比較を実行します。fixtureと100局比較の分担は[テスト文書](testing.md#rust-ai基盤の確認)を参照してください。

## 対局参加BOTの実装

起動引数と任意の設定JSONは共通の`RunConfig`検証へ渡します。入力方式によって保存先や復帰scopeを分けず、設定値が混在した場合は起動前に拒否します。`--replace`は実行時の指定として分離し、scopeへ含めません。前回の設定で取消・退出・席解放と結果保存を確認できた後に新しいscopeを保存します。

[確定仕様](specs/player-bot.md)と[CLIの案内](../apps/player-bot/README.md)を参照します。参加・待機は既存HTTP API、対局は既存WebSocket契約を使います。登録者Cookieと部屋専用tokenは別資格として扱い、状態不明時に新しい参加要求を発行しません。大会・レートで終局した後も席の解放と結果保存を確認してから再参加します。

ローカルAIの`--port`は待受ポートだけを選択し、loopbackと既定3002を維持します。BOTは専用の子プロセスに動的ポートを割り当て、既存widgetのプロセスを操作しません。

## ローカルAI解析widgetの実装

Macのサービス操作は`native/host.ts`と`native/serviceManager.ts`が担当します。`setup:native`はBunの単体実行ファイルとRustのローカル解析バイナリをユーザーのApplication Supportへコピーし、Chromeへ拡張ID限定で登録します。`nativeClient.ts`はbackgroundからの`connectNative`接続を保持し、要求ID・protocol版・状態を照合します。内容は起動・停止・再起動・状態取得に限定し、任意コマンドやPIDを受け付けません。tokenはNativeからbackgroundの信頼された保存領域へだけ渡し、contentへの応答には含めません。

補助プログラムは自分の子プロセスだけを管理し、別のlistenerが存在すれば手動起動扱いで操作を拒否します。AIの起動完了は子のlisten応答で確認します。通常終了を2秒待った後は同じ子だけを強制終了し、Native接続終了でも解放します。標準出力は長さ付きJSON専用、AIの標準エラーは非公開の`service.log`です。widgetは3秒間隔で状態を確認し、停止・再起動時は探索の世代を進めて遅延候補を捨てます。既存の手動起動・token設定も維持します。

仕様は[README](../README.md#ローカルai解析widget)、導入は[拡張の案内](../apps/local-ai-widget/README.md)、APIは[AI案内](../packages/ai/README.md#ローカル解析サービス)を参照します。`apps/local-ai-widget`は独立Bun workspaceで、本番Web資産へ含めません。MAIN側bridgeは既存WebSocket・fetchの受信を監視し、ISOLATED側controllerが局面・棋譜・探索の世代を管理します。service workerがloopback通信とタブ排他を担当し、tokenは信頼された保存領域から外へ返しません。継続探索の要求IDはsession storageへ保持し、worker再生成後も取得・取消できます。

四人リバーシは接続先・部屋ID・instanceId・接続と局の世代・本人と色対応・ルール状態・手番開始時刻で識別します。将棋には局ID・positionRevisionも含めます。時計残時間・チャットだけでは再探索せず、古い受信や応答を破棄します。将棋の棋譜は`replay.ts`で完全取得済みの末尾から差分取得し、各ページのrevisionと連続性を照合します。

Workerの`analysis-replay`は進行中シングルスの初期ルール設定とイベントだけを100件ずつ返します。既存の公開ルーム・棋譜と同じ読取範囲とし、参加者情報や認証値を追加しません。各ページでinstanceId・局ID・revisionを再確認し、revision不一致は409です。対局状態の保存形式を変更しません。将棋対応にはこのAPIを提供するWorkerが必要です。

ローカルv2 APIは継続探索を1件保持し、進捗取得で15秒の生存確認を更新します。MCTSは木と乱数状態を、将棋は探索中の履歴・根候補・反復深化を保持します。将棋は深さごとの完了結果を別のsnapshotへ確定してから公開します。旧v1 APIと公開CPUは従来の探索予算を維持し、改修前の固定fixtureで選択手・診断・連続呼び出しを確認します。

盤面はリバーシ64マス・将棋81マスの座標と石／駒を照合します。将棋は各マスの現在の描画座標からSVGの矢印を引くため回転にも追従し、駒打ちは移動先番号で示します。未確定盤面や不一致では表示を消します。定期取得ではwidgetのボタンを作り直さず、フォーカスを保ちます。検証分担は[テスト方針](testing.md#ローカルai解析widgetの確認)を参照します。

## レート戦の開始演出

ルームの盤面は紹介の背後で描画し続けます。紹介の背景は既存の `--lobby-background` を72%にした半透明色と3pxの `backdrop-filter` にし、帯の不透明色は既存テーマのまま保ちます。相手は `translateX(-100vw)` から600ms、本人は `translateX(100vw)` から700msで入れ、終端で減速します。相手を80msずつ遅らせ、本人は200ms後に開始します。登場中の横スクロールは背景幕で抑止します。

表示仕様は[開始演出の仕様](specs/matchmaking.md#レート戦の開始演出)です。`RoomViewShell` はレート戦の初回待機中に `RatedMatchStartCountdown` をマウントし、開始予定時刻の通知前から既存の `PlayerProfileStore` へルーム・instance・プレイヤーIDを指定して並列に先読みします。帯は同じstoreを購読し、入室時の名前・アイコンを維持して公開ID・対象ゲームの通算成績・成立時の対局前レートを補います。現在レートで代用せず、CPUの基準レートと認定中を区別します。

カウントダウンはサーバー時刻から求め、プロフィール取得を開始条件に含めません。表示が中断しても入室中のstoreを利用し、通常ルーム・大会・旧ランダムマッチは既存の `RoomStartCountdown` を維持します。`ratedMatchStartCountdown.css` は帯の切り欠き・配置・登場アニメーションだけを担当し、配色は既存のゲームテーマ変数を使います。

## レート戦の時計変更

ゲーム別の時計の正本は[レート戦の仕様](specs/matchmaking.md#レート戦の持ち時間)です。新規ルームはprotocolの `matchmakingQueues` の `timeControl` を使い、成立後はルームへ保存した設定で時計と開始画面を表示します。待機列キーはDO・D1予約・入室資格の識別子なので、文字列に残る旧時計の数値を書き換えません。通常ルーム・大会・旧ランダムマッチの設定は維持します。

rating の文脈の `ratedTimeControls`（`packages/contexts/rating/src/domain/policy.ts`）は新旧のレート戦の時計を許容し、四人ゲームの順位更新と二人ゲームのElo保存SQLで共用します。変更前の成立済み対局・保存待ちもレートへ反映し、既存履歴とCPUの基準値は変更しません。過去のCPU較正は対象コミットと測定時の時計を保持し、新しい時計での較正は別の検証として扱います。

## レート戦の待機人数

表示の正本は[待機人数の仕様](specs/matchmaking.md#レート戦の待機人数)です。`CpuCapacity.availableSeats()` は既存のゲーム別上限と予約台帳を読み取り、「残り席数」と「残り対局枠×1局のCPU席上限」の小さい方を0以上で返します。`MatchmakingCoordinator` は有効な人間の待機者数を加え、既存の `waitingCount` に入れます。取得失敗はこの項目を省略し、検索・取消などの状態応答は返します。通常対局とレート戦で共有する予約台帳をそのまま参照し、予約・解放の処理や照会時の状態を変更しません。

人数を要求しない受付確認GETではCoordinatorへ照会フラグを渡し、CPU枠への追加RPCを省きます。`waitingCount=1` と省略可能な整数項目の契約を維持し、Webは既存の3秒更新と表示条件を使います。旧Workerとの組合せでは従来の人数表示になり、新しいWorkerへの切替後に空き枠を含む計算になります。DB移行はありません。

## レート戦のマッチング時間の目安

表示の正本は[マッチング時間の目安の仕様](specs/matchmaking.md#レート戦のマッチング時間の目安)です。`MatchmakingCoordinator` は期限内かつ再試行待ちでない待機者について、既存の `ratingPolicy.select` を補充時刻の条件で読み取り、先頭から最大4組を見積もります。先行するCPU入りの組が使う同時対局枠を差し引き、本人が含まれる組の先頭の待機開始＋補充待ち時間を返します。過去の時刻、空き枠を割り当てられない組、CPU枠取得失敗・再試行待ちでは省略します。既存の待機人数と同じCPU照会結果を使い、状態・予約台帳を書き換えません。

公開APIは `estimate=1` を指定したGET・検索・継続などの応答にだけ、省略可能な `estimatedMatchAtMs` を返します。本人の有効な待機と操作元が一致する場合だけ設定し、未指定の既存クライアントへ新項目を返しません。受付確認だけのGETでは引き続きCPU枠を照会しません。Webは `MatchmakingWaitTime` で既存の `serverNowMs` と応答受信時の `performance.now()` を使い、毎秒の表示と背景復帰時の追いつきを処理します。操作IDをkeyに前回検索の目安を分離し、同じ表示中の目安を延長せず、見積もれない回・期限超過では経過時間へ切り替えます。旧Workerは要求を無視して目安項目を省略でき、その場合も経過時間を表示します。DB移行はありません。

## 四人リバーシの待機列とルーム

採用仕様は[レート戦](specs/matchmaking.md#四人リバーシのレート戦の詳細)、ゲームの裁定は[四人リバーシ正本](rules/four-reversi.md)です。Workerの`matchmaking/routes.ts`が本人・Origin・同意・入力を検証し、`MatchmakingCoordinator`がFIFO・lease・操作元・割当と回復を扱います。migration `0031_matchmaking.sql`はD1の通常席・大会待機との排他、ゲスト統合のfence、公開索引の印を追加します。GameRoomは専用ルームの接続・期限・自動開始と既存の時計・脱落・保存を担当します。状態GETは本人の状態を参照するだけで、組合せや全ルーム巡回を行いません。割当・期限・再試行は変更操作とAlarmで処理します。毎時保守は解放済みの割当をD1の席予約と照合して片付け、対局中のGameRoomへ巡回RPCを送りません。

Webの`features/matchmaking`は登録者の参加、10秒の継続、再読み込み・明示引継ぎと入室を担当します。`QueueDocumentController`は大会と共用し、scopeを分離します。Web Locks非対応時も明示参加・引継ぎは可能とし、自動の資格引継ぎはしません。非同期応答は本人・操作元・要求世代で破棄し。

Rust CPUの名前・判断方法・Engine版は`packages/ai/configs/characters-v1.json`、探索設定とhashは既存の`profiles-v1.json`に分けます。旧CPUのlevel 1/2フィールドは互換用に維持し、実際のレベルとprofileは省略可能なcpuProfileへ保存・表示します。専用ルームはこれをLv2として表示しません。Engine 0.2.0はAPI v2のルール識別子v2／局面版2を受理し、旧契約も維持します。

4ゲームのレート戦は開発・本番それぞれの専用AI WorkerへService Bindingで接続します。本番は `AI_RATED_ONLY=true` で通常ルーム・大会を従来CPUのまま保ちます。[ゲーム別のAIコンテナ構成](architecture.md#ゲーム別のaiコンテナ)、[本番AIと4ゲーム同時公開](runbooks/deploy.md#本番aiと4ゲーム同時公開)を参照してください。開発AIの更新は `bun run --cwd packages/ai deploy:cloud:development`、本番はmainのActionsから同じコミットのAIをアプリより先に公開・検証します。削除済みの検証Workerは再作成しません。

## 四人リバーシのレート戦の実装順序

登録者向けの[四人リバーシのレート戦](specs/matchmaking.md#四人リバーシのレート戦の詳細)へ切り替えます。2026-11-08に文書化したフェーズ4.5-Aのうち、[CPU評価と実力推定の較正仕様](../packages/ai/docs/calibration.md)を引き継ぎます。

1. 将棋で使っているロビーダイアログ、待機・取消・自動入室・再参加、認定と対局結果の表示、終局時の二重反映防止を共通化しました。ゲーム別の参加人数・持ち時間・待機上限はprotocolの `matchmakingQueues`、相手選びとレート保存はWorkerの `matchmaking/ratedMatchmaking.ts` のゲーム別設定から参照します。将棋は既存のD1テーブルとAPI形式でレートを読み書きします。
2. 四人リバーシのCPUを較正し、順位ベースのレート計算と保存を追加します。同順位、認定5局目、CPU混在、代替手使用時の除外、再試行を確認します。[公開レートの仕様](specs/matchmaking.md#公開レート)を本人向けの `GET /api/matchmaking/four-reversi/rating` に適用し、開発環境の対局結果で見直します。四人リバーシ・四人将棋のレートAPIは認定後の数値レートと対人戦の有無を返します。Webは旧Workerの応答にあるランク項目を読み捨てます。
3. 四人リバーシを共通の導線に接続しました。最長20秒で人間を優先し、不足席を較正済みCPUで補います。新旧の待機列を分離し、旧対局の接続と保存を継続します。新しい待機列は `0035_four_reversi_rating_pending.sql` の保存待ち予約で、終局結果が確定するまで次の参加を制限します。
4. 必須ローカル検証とCIを通し、開発環境で人間1〜4人、20秒前後の参加・取消、AI障害、終局後の再参加を確認します。対人戦とCPU入りの局でのレートの推移、稼働費用、受付停止手順をまとめ、本番公開は別途承認を得て実施します。

較正では現在のEngine・profile・設定hash・実効予算・source/binaryを固定して結果をひも付けます。OpenSkill 5.0.1はWorkers互換性と予測精度を確認してから採用します。通常ルーム・他ゲームの集計と外部AI接続も回帰確認の対象です。

## 四人リバーシCPU

現行APIは `@tetraboard/four-reversi` の `chooseCpuMove(state, level, random = Math.random): Position | null` です。合法手・公開API・採用したCPU方式は [ルール正本のCPU節](rules/four-reversi.md#cpu) を確認してください。

2026-10-11に強化仕様と [Goal・ContextProviders・Constraints・Done When・コミット計画](four-reversi-ai.md) を確定しました。仕様PR取り込み後のdevelopから実装し、多人数探索・配置とチーム評価・終盤全読み・終局予測・Worker接続を追加し、採用測定の結果を同文書へ記録しています。

実装の入口は [公開API](../packages/four-reversi/src/index.ts)、[エンジン](../packages/four-reversi/src/engine.ts)、[CPU](../packages/four-reversi/src/cpu.ts)、[探索](../packages/four-reversi/src/cpuSearch.ts)、[評価](../packages/four-reversi/src/cpuEvaluation.ts)、[終局予測](../packages/four-reversi/src/cpuForecast.ts)、[Worker進行](../apps/worker/src/adapters/room/games/four-reversi/progress.ts)、[GameRoomのAlarmと期限処理](../apps/worker/src/durableObjects/gameRoom/gameRoom.ts) です。生成済みの合法候補を使う内部経路を通常着手の確定処理と共有します。公開エンジン状態と通信契約は維持します。

Workerは四人リバーシのLv1／Lv2をAlarm限定で選択保存し、次Alarmで適用します。内部対局ID・部屋世代・CPU本人とレベル・ゲーム局面キー・手番開始時刻で照合し、通常GETでは選択も適用も起動しません。記録導入前の対局IDなしのDOも進行できます。手番外の脱落でもジョブを破棄し、チャット・スタンプだけで再探索しません。詳細な検証の分担は [四人リバーシAI強化の確認](testing.md#四人リバーシai強化の確認) を参照します。

## Development Strategy

既存の共通ロビー・ルーム・記録機能を土台に、ゲーム固有のエンジンと画面を追加します。検証は純粋関数、部品・hook、Worker統合テストへ集約します。

## ゲームIDと軽量カタログ

ゲームIDの正本は `packages/protocol/src/games.ts` の `gameIds` です。追加時は同じファイルの `gameCatalog` に表示名・ロビーパス・ランキングAPIパスを登録します。`GameId` は実ゲームだけ、`GameScope` は集計・フィードバックなどのサービス全体を表す `all` も含みます。`all` をルームや対局のゲームとして渡しません。既定ゲームは `defaultGameId` の四人リバーシです。

表示名・選択肢・パスだけが必要な画面は `@tetraboard/protocol/games` を直接参照します。この入口にはZod・React・エンジン・CPUを持ち込まず、検証スキーマは別の `gameSchemas.ts` に置きます。テーマとルール表示、ゲーム固有の処理は各アプリで管理します。カタログへの登録だけで新ゲームの対局機能が実装されるわけではありません。

IDと `all` の境界・既定値は `bun run --cwd apps/worker test test/gameCatalog.test.ts test/gameBoundary.test.ts test/commonRoomBehavior.test.ts` で確認します。軽量入口の依存は `bun build packages/protocol/src/games.ts --target=browser --outfile=/tmp/tetraboard-game-catalog.js --metafile=/tmp/tetraboard-game-catalog.meta.json` の入力一覧で確認できます。

## 通常リバーシの実装

通常リバーシ・通常将棋のCPU補充レート戦は、`AI_WARMUP_ENABLED=true` で既存の開始前準備・再試行・待機列への復帰を共用します。`GameRoom` は部屋のゲームIDから準備先を決めます。`adapters/room/ai/ratedAiWarmup.ts` の `requestRatedAiWarmup` はService Bindingへ送り、AI GatewayとRust Serviceの `/admin/warmup?game=...` がエンジンの初期化と実際の着手応答まで確認します。四人ゲームのヘルス確認も同じ開始待機処理を使います。準備のログは `rated_ai_warmup_*` です。AI側を先にデプロイし、新API対応後にアプリWorkerを更新します。

[レート戦の仕様](reversi-rated-match.md)では共通待機列と将棋のElo計算を使用します。レート履歴は `elo_rating_changes`、保存待ちは `elo_rating_pending` に、`game` を `reversi` として保存します（将棋と共用）。補充CPUの版と基準レートは `reversiCpuProfiles.ts` に置き、棋譜確定と同じD1バッチでレートを反映します。

`packages/reversi` は黒白2人の独立したルールエンジンとCPUを持ちます。ゲームカタログの `capacity` と `hasModes` に定員2・モードなしを登録し、共有の席管理・開始条件・公開情報・集計条件はゲーム別定員を参照します。

`ReversiRoom`・対局記録・戦績・ランキングは専用の公開契約を持ち、通常リバーシの作成と履歴取得はモード指定を受け付けません。公開JSONにもモードを含めません。既存のD1のNOT NULLモード列には内部識別値 `standard` を保存します。既存の四人ゲームのモード値・JSONと既定ゲームを維持し、過去データの移行は行いません。保存は四人リバーシと同じ局面列方式で、保存待ち・5秒後の再送・本人索引・閉鎖後の保持を共用します。本人索引のゲーム列は保存済み対局から明示的に設定します。

Workerは `adapters/room/games/reversi/` の進行の spec と保存（`progress.ts`、`progressStore.ts`）、`reversiClock`、`reversiMatchStore` を登録し、共有GameRoomから呼びます。戦績は専用の勝敗SQL、ランキングは勝数と対局数、公開プレイヤー情報はモードなしの戦績を返します。通常リバーシのバッジは判定・表示しません。

Webの通常リバーシロビー・ライブ・保存棋譜はゲーム別に登録し、独立したエンジンだけを読み込みます。盤面描画と石・プレイヤーカードの基本描画は共有します。通常リバーシの対局・棋譜は上下2カード、観戦・保存棋譜は180度回転、ゲーム本文・マイページ・棋譜・Portalは薄い緑テーマです。静的生成・配信・サイトマップは6ロビーに対応します。

開発環境の `AI_REVERSI_ENABLED` はLv2のCPU手番だけを対象とします。 `adapters/room/ai/reversiExternalCpu.ts` はAlarmで局IDと着手番号に結び付けた要求を保存し、GameRoomはtransaction外で `POST /v1/reversi/move` を呼びます。候補受領時と適用時に現在の局と時計を確認します。着手要求が失われても期限のAlarmで従来のLv2を使用します。`Reversi AI response` ログの `source` と `elapsedMs` でServiceへの往復を確認できます。

`Dockerfile.reversi` は固定コミットのEgaroucid Consoleをビルドします。本体はGPL-3.0-or-laterで、定跡を無効にし、公式ソース配布に含まれる2つの評価ファイルをハッシュ照合します。対応ソース、評価ファイル、ビルド手順とライセンス本文はイメージ内の `/usr/local/share/egaroucid/` に同梱します。開発Serviceを既存の手順で更新してからアプリWorkerを反映します。[公式ソース](https://github.com/Nyanyan/Egaroucid/tree/console_v7.8.2) · [確認手順](testing.md#通常リバーシの外部ai確認)

補充CPUの比較条件、暫定Elo、測定の再実行は[通常リバーシの補充CPU較正](reversi-cpu-calibration.md)を参照します。

## 通常将棋の実装

[将棋のレート戦](shogi-rated-match.md)には、専用待機列、終局時のレート保存、CPUの採用前に行う検証を記載しています。Webの `features/matchmaking` をWorkerの `matchmaking/routes.ts` と `matchmaking/coordinator.ts` から通常将棋のGameRoomへ接続します。対人戦とCPU戦の待機・入室・終局は `apps/worker/test/matchmaking*.test.ts`、Elo計算と認定情報の公開範囲は `apps/worker/test/shogiRating.test.ts`、画面は `apps/web/test-dom/matchmaking*.test.tsx` で確認します。

Webの `RatedMatchmakingDialog` とレート表示は対象ゲームを受け取ります。将棋の対局結果は既存APIの `opponent` を使い、名前の横のレート表示を `RatingResultLabel` に渡します。Workerの `matchmaking/ratingStore.ts` はレート保存待ちの予約・解除、適用済み対局の照合、確定時に使うSQL文を提供します。将棋のElo計算は rating の文脈（`packages/contexts/rating/src/domain/elo.ts`）が持ち、`adapters/rating/shogiRating.ts` の設定で、棋譜確定と同じD1バッチで更新します。

開発環境の外部AI接続は `adapters/room/games/shogi/cpu.ts` が棋譜からUSI要求を準備し、GameRoomがストレージのトランザクションを抜けてから `adapters/room/ai/shogiAi.ts` を呼びます。起動・探索はAI Serviceの `shogi.rs` が担当します。`apps/worker/test-ai-service/shogiAiService.test.ts` で応答とタイムアウトを確認できます。コンテナの実エンジンを使う場合は、既存のAI Service統合テストに `TETRABOARD_SHOGI_TEST_REAL=1` を指定します。

通常将棋のルール正本は `docs/rules/shogi.md` です。独立した `packages/shogi` に純粋なルールエンジンとCPUを置き、初期化・合法手・王手・着手・外部敗北・千日手・持将棋・入玉宣言・500手を扱います。先手と後手、持ち駒7種類、8種類の盤上駒を専用のprotocol契約で検証します。`rulesVersion: 1` の棋譜は初期の配席と受理したイベントを再実行して復元し、最終状態の一致を検査します。互換を壊すルール変更では再生版を追加します。

CPU Lv1は合法手から一様に選びます。内蔵のLv2は駒の価値・成り・前進・無防備な駒・持ち駒・王手を評価し、最大3手・512回の着手評価で探索します。完了した深さの結果を採用し、予算が少なくても合法手を返します。探索時の入力と永続履歴を変更しません。Workerは勝てる入玉宣言を優先し、成立可能な人間の持将棋提案へ手番外でも同意します。CPUの選択をKVへ保存してから次のAlarmで期限・局・revision・手番を再検証して適用し、探索時間も時計に含めます。

`adapters/room/games/shogi/progress.ts` は通常将棋の開始・着手・特殊操作・終局を担当し、認証・席管理・時計計算・準備・チャット・接続期限・保存再試行はGameRoomの既存処理を使います。`EventGameStore` は四人将棋と通常将棋のイベント・局・保護棋譜・ページングを共用します。通常将棋のSQLite表は `standard_shogi_`、四人将棋は既存の `shogi_` を使い、既存データを移行しません。通常将棋の反復辞書は配信せず、必要な局面の回数と初回時の連続王手判定用カウンターをSQLiteから取得し、変更分だけ保存します。公開状態には各側の王手をしなかった着手の累積カウンターだけを含めます。

D1の分割棋譜転送・全ページ検証・本人索引・再送は `shogiMatchStore.ts` を共用し、ゲームごとにイベントと記録の契約を切り替えます。モードなしの内部DB値は通常リバーシと同じ `standard` です。勝敗集計・ランキング・公開プロフィール・モードの表示条件には通常リバーシの2人用処理とカタログの `capacity`・`hasModes` を再利用します。通常ルームのCPU戦も履歴と公開棋譜を保存します。レート戦の集計条件は[本人の戦績集計](#本人の戦績集計)を参照してください。

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
- [gomoku/progress.ts](../apps/worker/src/adapters/room/games/gomoku/progress.ts) が配席・開始・着手・時計・終局・CPUを担当し、GameRoomの共通ライフサイクルへ接続します。CPUは候補をDOへ保存して次Alarmで期限を再確認し、同期計算時間を時計へ反映します。更新・終局・閉鎖時は候補を破棄します。時計の計算は既存の2色用モジュールを共用します。
- 着手通信は `placeGomokuStone` と0〜14の座標、必須の `roundId`・`positionRevision` を使います。既存リバーシの `placeStone` と0〜7の契約を維持します。禁手設定は待機中のホストだけが変更でき、対局開始時の設定はゲーム状態・対局記録・直前局に保持します。
- [gomokuMatchStore.ts](../apps/worker/src/adapters/record/gomokuMatchStore.ts) と [gomokuMatchData.ts](../apps/worker/src/adapters/record/gomokuMatchData.ts) が保存・読取り・公開／本人棋譜・集計を接続します。D1の既存テーブルと再送処理を使い、新しいマイグレーションはありません。規則版1の局面列は [replay.ts](../packages/gomoku/src/replay.ts) で全着手を再実行し、途中・最終局面を照合します。
- [GomokuLobbyPage](../apps/web/src/features/lobby/GomokuLobbyPage.tsx)、[GomokuRoomDetail](../apps/web/src/features/room/GomokuRoomDetail.tsx)、[GomokuMatchReplayView](../apps/web/src/features/room/GomokuMatchReplayView.tsx) を登録します。SVGの15路盤・上下カード・紫テーマ・座標表記を専用の画面で扱い、接続・設定・チャット・スタンプ・棋譜操作を共用します。禁手はクライアントとサーバーで検査し、本人の3秒toastへ接続します。
- 固定棋譜と境界の確認は[テスト文書](testing.md#五目並べの確認)にまとめています。実機の入力・寸法・音声は自動検証の対象外とし、PRで実施結果または未確認事項を報告します。

## 四人五目並べの実装

- [packages/four-gomoku](../packages/four-gomoku/src/index.ts) が15路・4色・両モード・順位を扱います。`completedColors` と `eliminatedColors` を分け、`standings` と `winningLines` は継続中も保持します。[CPU](../packages/four-gomoku/src/cpu.ts) は専用入口だけから読み込みます。探索方式・値は[ルール正本](rules/four-gomoku.md#cpu)を参照します。
- [four-gomoku/progress.ts](../apps/worker/src/adapters/room/games/four-gomoku/progress.ts) が配席・着手・期限・CPU・全体終局を共通ライフサイクルへ接続します。通信は専用の `placeFourGomokuStone` に `roundId` と `positionRevision` を要求します。途中順位ではplayingを維持し、最後の確定で保存・結果・再戦へ進みます。
- [fourGomokuMatchData.ts](../apps/worker/src/adapters/record/fourGomokuMatchData.ts) が規則版1の全局面再生と保存理由を照合します。共通D1保存とモード別SQLを利用し、既存ゲームの契約は維持します。
- [FourGomokuRoomView](../apps/web/src/features/room/FourGomokuRoomView.tsx) と [FourGomokuMatchReplayView](../apps/web/src/features/room/FourGomokuMatchReplayView.tsx) は4カード・途中順位・90度回転を扱います。木の盤面の描画は通常版と共用し、エンジンは別の遅延チャンクです。待機カードは現在の準備状態、保存棋譜カードは選択したフレームの順位を表示します。
- 各色の最終手は表示用の省略可能な `lastMoves` として確定着手時に更新し、脱落・勝ち抜けでも保持します。旧進行局は `FourGomokuProgress.normalize` が永続棋譜から復元します。旧保存棋譜は `replayV1` の再実行で得た局面をWebのフレームへ使い、未来の最終手を持ち込みません。規則版1の勝敗照合には表示用情報を含めません。通常版と共用の `GomokuBoard` はSVGと操作領域に同じ寸法定数を使います。
- [検証範囲と部分実行](testing.md#四人五目並べの確認)を参照してください。既存5ゲームと新ゲームの全体回帰・必須検証と実機未確認事項はPRへ記録します。

## ゲーム契約

6 ゲームは、`packages/game-contract` の `GameDefinition` を通して扱います（[ADR 0011](adr/0011-game-contract.md)）。各ゲームのパッケージが `./definition` で実装を書き出し、Worker の `apps/worker/src/adapters/room/games/gameDefinitions.ts` に登録します。6 ゲームとも移し終え、登録表は `Record<GameId, ...>` を満たすので、登録が欠けると型検査が失敗します。千日手のように過去の局面が要るゲームは、`applyAction` と `chooseAction` の任意の `history` で履歴の検索を受け取ります。引分提案のように手番に関係ない操作は、`rules.requiresTurn` と `rules.endsTurn` で表します。外部 AI を使うゲームは、契約の `cpu.external`（局面のキー、要求の本文、応答の手の読み方、予備の操作）を実装し、ジョブの保存と期限の扱いは Worker の `apps/worker/src/adapters/room/ai/externalCpu.ts` が受け持ちます。通常リバーシの CPU は、他のゲームと同じく Alarm の処理の中だけで動きます。

着手と投了の前の確認は、room の文脈の `checkGameCommand` が全ゲーム共通の順序（状態 → 本人 → 古い局面 → 時計 → 脱落 → 手番）で行います。投了では古い局面の照合を飛ばします。

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

`roomTransportLifecycle.test.tsx` は両ゲームの離脱・履歴復帰・10秒境界、終了通知の遅延、無関係な通知、未応答GET・本人確認、旧取得結果の破棄、未確定着手・設定・チャットを確認します。WebSocketの状態と通知タイミング、fetchと時計は既存の境界で制御します。Workerの `roomDeadline{Persistence,Actions,Cpu,Alarm}.test.ts` は両ゲームの最後の本人接続の終了を確認し、既存の復帰・脱落・席解放テストも実行します。ブラウザ履歴キャッシュの実際の使用・ネイティブURL移動・モバイルの強制終了はDOMテストでは確認せず、手動確認の結果または未確認としてPRに記載します。`pagehide` が発火しない終了とclose通知がサーバーへ届かない場合の一定時間内検出は保証しません。

## ルームのスタンプ

固定6種類のID・絵文字・名称と通信スキーマは `packages/protocol/src/stamps.ts` に置き、ゲームエンジンには依存させません。GET `/rooms/:id?stamps=1` の `stampsSupported: true` を確認したWebだけがWebSocketにも `stamps=1` を付けます。再接続のGETで対応を確認し直し、旧Workerでは入口を表示しません。GameRoomは既存の戦型解析タグ・認証attachmentを保持し、`room-stamps-v1` の接続だけに新しい通知を配信します。

`room.stamp.send` はルーム世代、送信ごとのUUID `requestId`、スタンプIDを送ります。`room.stamp.received` はサーバー発行の通知ID、同じ世代とrequestId、送信者ID、スタンプID、受理時刻を返します。拒否は `room.stamp.error` でrequestIdと理由を返し、連打制限には `interactionAvailableAtMs` を添えます。対応接続の認証応答にも本人の送信再開時刻を含めます。

Workerは既存の期限処理後に世代・人間の在室資格・種類・送信停止を検証し、既存の `last-chat-at:<playerId>` をチャットと共用して3秒に1件へ制限します。検証、送信時刻、部屋の最終活動時刻を同じDOトランザクションで確定するため、複数タブとDO再作成にも制限が残ります。スタンプ本体は保存せず、時計・CPU予定を変更しません。受理後は既存の期限選択でAlarmを更新し、本人を含む対応接続へ通知します。

共通transportはスタンプの10秒の応答待ちを他の操作と分離し、requestIdが一致する通知・エラーで解除します。期限超過は既存の復旧経路へ移り、自動再送しません。本人のチャット・スタンプ受理と認証応答から共通の送信再開時刻を更新します。非表示・同期中・旧接続の通知は演出へ渡さず、同じ通知IDを再演しません。

`RoomViewShell` の `useRoomStamps` とContextで送信者ごとの最新1件と3秒のタイマーを共有し、`PlayerCardView` がプレイヤーIDで参照します。画像は再マウントせず、アバター内に黒50%のレイヤーと絵文字を重ねます。席削除・次局・切断・退室・閉鎖・非表示・離脱で破棄し、Contextのない保存棋譜には表示しません。状況カードの38pxボタンは、絵文字だけを3列・2行に並べる非モーダルPopoverを開き、選択・外側操作・Esc・フォーカス離脱と手番・ダイアログ・接続の切替で閉じます。開閉ボタンはPopoverのblurによる閉鎖対象から除外し、フォーカス移動で閉じた直後のpressで再び開くことを防ぎます。表示設定とブラウザ保存は #121 の範囲です。

部分検証は `bun run --cwd apps/worker test test/roomStamps.test.ts` と `bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/roomStamps.test.tsx` を使います。

## 表示・サウンド設定

2026年10月10日、開発者の指示により仕様と実装目標を確定しました。仕様の正本は[表示・サウンド設定](specs/room.md#表示サウンド設定)です。設定UI・ブラウザ保存はWeb側で実装し、Worker・ゲームエンジン・通信契約は変更しません。

`shared/browserSettings.ts` のページ共通ストアがlocalStorageの初期読取・項目単位の検証・最新値との合成書込・storage／pageshow／visibilitychangeの同期を扱います。保存できない変更は別に保持し、古い保存値による取消を防ぎます。React側は `useBrowserSettings` の `useSyncExternalStore` で同じsnapshotを購読します。

着手アニメーションは同じストアの `boardAnimationsEnabled` を `useBoardMotion` が購読します。OFFで再生中の演出を破棄し、OFF中も表示局面を記録するため、ONへ戻しても見送った着手を再演しません。旧保存値にこの項目がない場合はONで補います。

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

仕様の正本は[時間切れ5秒前の通知](specs/room.md#時間切れ5秒前の通知)です。時計音と強調は実際の期限まで5秒以下を共通の境界とします。

`clockWarning.ts` は最終期限・手番の担当者とカウントIDを読み取り、通知済み記録を最大64件で保持します。共有transportは受理したスナップショットと既存の250msの時計更新から判定し、同期・認証後の基準が5秒以下なら見送ります。手番開始・手数・局・部屋世代でカウントを区別し、将棋のrevisionや引分提案だけでは変えません。`roomClockPresentation.ts` は手番中の最終期限を直接比較します。`PlayerCardView` はその判定を使って枠の色・太さと周囲のぼかしのアニメーションを切り替え、`RoomClock` は残り時間を静止した文字で表示します。

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

## ルームの実装の入口

ルームの仕様と、サーバーの側で守る契約は[ルームの仕様](specs/room.md)を正本とします。

- ルームの Durable Object は、ADR 0010 の殻の形に分かれています（TB-68、TB-88）。
  - `packages/contexts/room/src/use-cases/`: ルームの進行の決定（作成、参加、退室、準備、設定、開始、着手、期限の処理、終局、再戦、閉鎖）。Cloudflare と zod に依存せず、状態は `ports.ts` のポートで読み書きし、配信などの外への効果は `effects.ts` の `RoomEffect` で返します。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
  - `apps/worker/src/durableObjects/gameRoom/`: `GameRoom` のクラス（RPC の入口だけ）と、入口の処理（`socket/` の WebSocket のメッセージ、`fetch.ts`、`admissions.ts`、`queries.ts`、`profiles.ts`）、配信、チャット、スタンプ、通報、期限の処理の外部への await（`deadlines.ts`）、`RoomRuntime` の組み立て（`createRuntime.ts`）。
  - `apps/worker/src/adapters/room/`: ポートの実装と保存。状態の読み書き（版の移行を含む）、`withIndexTransaction`、効果を transaction の確定後に実行する口、外部への反映のジョブ 7 種類、外部 AI の枠、利用イベント、Alarm の入力。
  - `apps/worker/src/flows/`: 他の文脈にまたがる処理（大会とレート戦のルーム、退会したアカウントの消去、ゲストの登録、席の台帳）。それぞれの文脈のパッケージへは、TB-71〜74 で移します。
  - ゲームの違いは `apps/worker/src/adapters/room/games/` のアダプター（ゲームのポートの実装）に閉じ込め、殻と use-case ではゲームの種類で分岐しません。
- 6 ゲームの進行は、room の文脈の共通の進行（`use-cases/gameProgressFlow.ts` の `createGameProgress`）で組み立てます（TB-178〜182）。本人と局面の確認、ルールの適用、確定、投了、退室と脱落、CPU の予定、再戦待機は共通の進行に 1 回だけ書き、ゲームごとの違いは spec（`gameProgressSpec.ts`）の項目で表します。共通の進行には、ゲームの名前で分ける処理を書きません。
  - ゲームごとの spec と保存のポートは、`apps/worker/src/adapters/room/games/<ゲーム ID>/` の `progress.ts` と `progressStore.ts` です。ルールはゲーム契約（`games/gameDefinitions.ts`）を使います。
  - 外部 AI、同期の CPU、引分提案、入玉宣言、旧形式の移行などのゲーム固有の処理は、継承ではなく、`createGameProgress` の結果と組み合わせて adapter に置きます（ADR 0011）。外部 AI のジョブは `adapters/room/ai/externalCpu.ts` です。
  - 保存のキーと値の形は、移す前と同じです。共通の進行を変えるときは、6 ゲームの統合テストと `packages/contexts/room/test/` の単体テストで、振る舞いが変わらないことを確かめます。
- 時計は room の文脈の `domain/clockCore.ts`（席 ID を型パラメータとする純粋な計算）と、`adapters/room/` のゲームごとの wrapper（`clock.ts`、`shogiClock.ts`、`reversiClock.ts`）です。期限の選択は room の文脈の `domain/roomDeadlines.ts` の純粋関数です。
- 1 アカウント 1 席（通常ルームの席、レート戦の待機、大会の待機を合わせて 1 つ）は、`flows/accountSeats/fences.ts` の条件で守ります（TB-118）。統合済みのゲストの席、大会の待機、大会のエントリーを止める条件も同じファイルにあります（TB-136）。席の予約は `flows/accountSeats/reserve.ts`、`entryProfile.ts` と `adapters/room/seatReservations.ts` です（旧 `accounts/roomAccounts.ts`）。3 つの表（`account_room_seats`、`matchmaking_wait_reservations`、`tournament_wait_reservations`）への挿入は、すべてこの条件をつけた `INSERT ... SELECT ... WHERE` です。挿入されなかったときは、同じファイルの関数で理由を読み直します。挿入する場所が決めたファイルの外に増えていないことは、`test-bun/accountSeatFenceBoundaries.test.ts` が確かめます。以前は D1 のトリガー 5 つが同じことを守っていましたが、TB-130 で消しました。トリガーがないので、この条件とテストが唯一の守りです。
- CPU の最低待ち時間は、room の文脈の `cpuMoveDelayMs`（`use-cases/processDeadlines.ts`）を全ゲームで共用します。
- CPU 付きのルームの作成（`POST /rooms`）は、任意の `cpuLevel: 1 | 2` を受け取ります。未指定は Lv1、不正な値は 400 です。`waitingRoomFactories` が全ての CPU に当てます。

関連の回帰は `bun run --cwd apps/worker test test/clock.test.ts test/roomDeadlines.test.ts test/roomDeadlinePersistence.test.ts test/roomDeadlineActions.test.ts test/roomDeadlineCpu.test.ts test/roomDeadlineAlarm.test.ts test/gameRoom test/fourShogiRoom test/humanlessRooms.test.ts test/shogiStore.test.ts` で実行します。実 DO の `evictDurableObject` による復元、保存済みの CPU の手の再検証、終局を再実行したときの非重複、例外の後に kv と SQLite が元に戻ることを確かめます。公開の応答は通信契約で解析し、内部のメソッドのモック、固定の sleep、テスト用の公開 API を使いません。Color と Side、残り時間の record の取り違えは、型検査専用の fixture で確かめます。

## レートの入口

レートの計算と処理は、ADR 0010 の形に分かれています（TB-70、TB-110）。

- `packages/contexts/rating/src/domain/`: Elo の計算（`elo.ts`）、skill の計算（`skill.ts`。openskill の Plackett-Luce。CPU の較正の `packages/ai/scripts/` もこれを使う）、公開のレートへの換算、配置戦とレート戦の時計の判定（`policy.ts`）、ランキングの並べ方。純粋な関数です。
- `packages/contexts/rating/src/use-cases/`: 対局の結果からレートの変化を決める処理、要約と結果、ランキング、保存待ちの予約と取り消し、最新のレート。D1 は `ports.ts` の `RatingReader`、`RatingPublication`、`SkillRatingStore` で読み書きし、棋譜の公開と同じ batch に入れる書き込みは実行せずに返します。Cloudflare と zod に依存しません。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/adapters/rating/`: ポートの D1 の実装。テーブルは `elo_rating_changes`、`skill_rating_changes`、`elo_rating_pending`、`skill_rating_pending`（`game` の列でゲームを分ける）。
- レートの zod のスキーマ（`adapters/rating/eloRating.ts`、`fourReversiRating.ts` など）、ランキングの D1 の読み取り（`adapters/rating/rankingReaders.ts`）、ルートの入口（`routes/rankingRoutes.ts`）。プロフィールのレートの読み取りは rating の文脈の `use-cases/profileRatings.ts`（TB-139）、マッチングからの呼び出しは worker に残ります。Elo は棋譜の公開と同じ batch、skill は公開の直後に反映します（`flows/matchSave/`）。

## アカウントの入口

アカウントの本人確認、プロフィール、ゲストの作成、登録の流れ、ゲストの統合と昇格は、ADR 0010 の形に分かれています（TB-134、TB-135、TB-141）。

- `packages/contexts/account/src/domain/`: 公開プロフィールの形、画像の URL、プロフィールの詳細、現在のプロフィール、時刻の表し方。純粋な関数です。
- `packages/contexts/account/src/use-cases/`: 現在のプロフィールの読み取り、プレイヤー情報、プロフィールの保存。D1 は `ports.ts` のポートで受け取ります。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/adapters/account/`: ポートの D1 の実装と、ゲストの本人確認（`guestIdentity.ts`）。ゲストの本人確認は、期限の延長（条件つきの UPDATE）と本人の読み取り（SELECT）を 1 回の batch で行います（C07）。最終利用から 180 日の期限と失効の判定は変えていません。
- 登録の流れ: 文脈の `domain/registration.ts`、`registrationStatus.ts`、`use-cases/registration.ts`、`registrationWrites.ts`。D1 で 1 つの batch にまとめる書き込みは、実行せずに返します。ルームの席を扱う部分は `flows/guestRegistration/` が room の側と結びます。
- ゲストの統合と昇格: 文脈の `domain/guestLink.ts`（前提の判定）、`use-cases/guestMerge.ts`、`guestLink.ts`、`guestLinkChecks.ts`。D1 の実装は `adapters/account/guestLinks.ts`、`guestLinkWrites.ts` です。統合では、account の use-case が前提の検査と account の書き込みを返し、`flows/guestRegistration/guestLink.ts` がほかの文脈の付け替え（保持した席、フィードバック、棋譜、チャット、通知、大会、プライバシーの索引、バッジ。各文脈の adapter の `guestMergeWrites.ts`）を決まった順に挟んで、1 回の D1 の batch で確定します。通知はバッジより先に付け替えます（逆にすると通知が作り直され、中身からバッジが落ちます。`guestAccounts.test.ts` の回帰テストが確かめます）。統合、昇格、ルームの引き継ぎの確定、登録の流れのフェンスは、条件つきの書き込みです（`adapters/account/guestLinkFences.ts`、`registrationFence.ts`、TB-136）。拒まれたときは、同じ batch の中で `db/fenceAbort.ts` がわざと SQLite のエラーを起こし、batch 全体（ほかの文脈の付け替えを含む）を取り消します。エラーの文面に拒否の符号（`guest_merge_conflict` など）が入るので、ルートはそれで応答を決めます。以前は D1 のトリガー 10 個が同じことを守っていましたが、TB-138 で消しました。トリガーがないので、この条件とテストが唯一の守りです。挿入の場所が決めたファイルの外に増えていないことと、条件が外せない形で付いていることは `test-bun/guestFenceBoundaries.test.ts` が確かめます。
- `apps/worker/src/routes/`: `accountRoutes.ts`、`accountAuthRoutes.ts`、`playerProfileRoutes.ts`、`guestRoutes.ts`、`registrationRoutes.ts`、`guestLinkRoutes.ts`、`guestLinkOAuth.ts` など HTTP の入口。better-auth と Cookie は殻に残ります（`accounts/auth.ts`）。

## コミュニティの入口

お知らせ、通知、フィードバック、ルームのチャットの通報は、ADR 0010 の形に分かれています（TB-143）。

- `packages/contexts/community/src/domain/`: お知らせの公開の範囲とページ、通知の種類と既読の上限、フィードバックの入力と画像、通報の間隔と重複の判定。純粋な関数です。
- `packages/contexts/community/src/use-cases/`: お知らせの一覧と保存、通知の一覧と既読、フィードバックの受付（`submitFeedback.ts`）、編集（`editFeedback.ts`）、期限の削除（`cleanupFeedback.ts`）、通報の受付と一覧と処理（`reports.ts`）。D1 と R2 はポートで受け取ります。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/adapters/community/`: ポートの D1 と R2 の実装。
- `apps/worker/src/flows/`: 文脈をまたぐもの。`feedbackSubmission.ts` は退会の確認（privacy）、`roomReports.ts` はルームの DO での発言の確認（room）と結びます。
- `apps/worker/src/routes/`: `announcementRoutes.ts`、`notificationRoutes.ts`、`feedbackRoutes.ts`、`feedbackAdminRoutes.ts`、`roomReportRoutes.ts` などの HTTP の入口。本文の大きさの上限つきの読み取りは `readLimitedBody.ts` です。
- 通知のイベントは、書き込みと同じ D1 の batch で作ります（TB-145）。お知らせは `adapters/community/announcements.ts`、バッジは `adapters/community/badgeEvents.ts` の文を、対局の保存と引き継ぎの flow（`flows/matchSave/badges.ts`、`claims.ts`）が record のバッジの通知の INSERT の直後に足します。同じ働きの古いトリガー（`notification_badge`、`notification_announcement_*`、チャットの `lobby_chat_accept`）は、TB-146（migration 0055）で消しました。書き込みの場所と、イベントの文を伴うことは `test-bun/communityWriteBoundaries.test.ts` が確かめます。
- お知らせの日付は、`date` から `published_on` の列へ移しています（TB-145、migration 0053）。TB-146（migration 0055）で表を作り直し、`published_on` を NOT NULL にしました。アプリは `published_on` だけを読み書きします。`date` の列は TB-162（migration 0057）で消しました。API の項目名は `date` のままです。
- 掲示板（仕様は [docs/specs/board.md](specs/board.md)、TB-215）: 投稿が公開されているか（通常、削除された枠だけ、見つからない）と index するかの判定は、`domain/board.ts` の `boardPostVisibility` と `shouldIndexBoardPost` だけで決めます。API、検索向けの HTML、サイトマップはこの 2 つを使い、条件を別の場所に書き足しません。本文中の TetraBoard の URL の切り出しと種類の判定は、Worker の受け付けと Web のカード表示が同じ `scanBoardLinks`（`@tetraboard/protocol/board`）を使います。SQL で同じ条件を書く場合（タイムラインで返信のない削除済みの投稿を除くなど）は、結果が関数と食い違わないことを Worker のテストで確かめます。画面の HTML（`boardPages.ts`）は、詳細ページの 404 と 503 を API と同じ `D1BoardReader.detail` で決めます。
  - D1 は `board_posts`（返信も同じ表で、`parent_id` は必ず元の投稿）、`board_likes`、`board_senders`（投稿間隔と投稿停止。公開チャットの `lobby_chat_senders` とは別）、`board_settings`（投稿受付。migration 0059 の初期値は停止）です。投稿は論理削除で、本文と添付を NULL にします。返信の数といいねの数は集計列を持たず、読むときに数えます。添付の列（`match_id`、`position`）は TB-218 まで書き込みません。
  - 投稿と返信は、公開チャットと同じく条件つきの INSERT 1 文で、資格、受付、停止、30 秒の間隔、退会、再送の重複を確定し、同じ batch で最後に投稿した時刻を更新します（`adapters/community/boardPosting.ts`）。
  - 退会の受付と毎時の再処理は `boardDeletion.ts` の `withdrawBoardStatements`（本人の投稿と返信の削除と、再送識別子・本文のハッシュの消去、本人のいいねの削除）、退会の完了は `deleteAccountBoardStatements`（アカウント参照を NULL）です。読み取りでも `deleted_accounts` の投稿者を削除扱いにします。

## マッチングの入口

レート戦の待機列は、ADR 0010 の形に分かれています（TB-115）。仕様は [docs/specs/matchmaking.md](specs/matchmaking.md) です。

- `packages/contexts/matchmaking/src/domain/`: 待機の状態と順序、組み合わせの選び方（四人リバーシ、四人将棋）、CPU のプロフィールの選び方、成立までの目安時間、レート戦の規則、前局の判定。純粋な関数です。
- `packages/contexts/matchmaking/src/use-cases/`: 参加、操作元の切り替え、退出、tick（組み合わせと CPU の補充）、状態の読み取り、退会の消去、解放済みの組の掃除。DO の storage、D1、参加資格、席の予約、ルームの RPC、CPU の枠、時刻は `ports.ts` のポートで受け取ります。席とレートの予約は書き込みを返し、殻が同じ batch で確定します。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/durableObjects/matchmakingCoordinator/`: DO の殻。`apps/worker/src/adapters/matchmaking/`: ポートの実装（D1 の SQL、DO の storage、CPU のプロフィールの設定）。`apps/worker/src/routes/matchmaking.ts`: HTTP の入口。
- 専用ルームの準備と開始は `flows/matchmakingRoom/` が room の側と結びます。

## 大会の入口

大会の処理は、ADR 0010 の形に分かれています（TB-116、TB-119）。仕様は [docs/specs/tournament.md](specs/tournament.md) です。

- `packages/contexts/tournament/src/domain/`: 段階、設定の照合、順位と同順位、勝ち点の単位、大会の対局結果の検証、大会ルームの型と保存キー。純粋な関数です。
- `packages/contexts/tournament/src/use-cases/`: エントリー、管理画面の下書き、公開の一覧・詳細・順位表、結果の確定、勝ち点の書き込みの準備。D1 は `ports.ts` のポートで読み書きし、棋譜の公開と同じ batch に入れる勝ち点の書き込みは実行せずに返します。成績（`tournament_scores`）は、同じ batch の中で勝ち点の記録（`tournament_point_events`）から参加者ごとに集計し直して上書きします。再送しても加算は増えません（TB-117）。以前は D1 のトリガー `tournament_score_apply` が加算していましたが、TB-130 で消しました。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/adapters/tournament/`: ポートの D1 の実装。`store.ts` が Worker の呼び出し元へ、use-case を D1 につないだ関数を渡します。
- 待機、組み合わせ、入室、操作元の引き継ぎ、席の移譲、期限の回収、公開、復旧の判定も文脈の use-case です（`use-cases/` の `tick.ts` など）。DO の殻は `apps/worker/src/durableObjects/tournamentCoordinator/`、HTTP の入口は `apps/worker/src/routes/tournaments*.ts`（公開の読み取り、参加の操作、運営の操作）、参加資格の導出は `adapters/tournament/credentials.ts` です。

### 大会機能の実装の入口

- `TournamentStandings` は768px以上で全成績列、767px以下で基本4項目と成績展開ボタンを表示します。行ごとの開閉と `aria-expanded`・`aria-controls` を持ち、プレイヤー情報カードの操作とは分けます。公開プロフィールIDをReactの行キーにも使い、ゲスト・本人の行を更新時も維持します。順位の上位3色と勝ち点の数字・単位の文字サイズはこの部品に置きます。
- 大会詳細・順位APIは `includeProfiles=1` の指定時だけユーザーの `publicProfileId` を任意の `profileId` として返し、指定なしでは旧Webの厳密なスキーマにも従来の応答を維持します。既存 `PlayerProfileTrigger` の対象ゲーム・シングルスへ接続します。内部アカウントIDは公開しません。退会受付時の既存JOIN条件と削除フラグで公開IDもnullにし、旧応答に公開IDがない場合は操作を置きません。大会一覧の優勝者の応答項目は増やしません。
- ルーターの `ActiveTournamentProvider` がホームと共通ヘッダーの開催中案内用に区分別APIの `game=all` を1回ずつ5秒更新し、本人の参加状態を取得しません。`serverTimeMs` に受信後の単調時計の経過時間を加え、期限タイマーで終了時に除外します。取得失敗時の保持は期限内だけです。非表示時は中断、復帰時は時刻と取得を更新し、対局・観戦・棋譜では停止します。`TournamentStatus` の開催中表示と `AppHeader` の大会リンクに `gameThemes` の対象ゲームテーマを局所的に適用します。区分別・詳細APIは大会の保存設定、大会一覧はゲームと保存設定を参照します。`ActiveTournamentNotice` をホームの説明直後に置き、`AppHeader` では大会ページの既存ナビゲーション制御も引き継ぎます。
- `TournamentStandings` の上位表示は、結果0件でも列見出しを表示し、その下の空表示自体に最小240pxを確保します。5人未満や結果0件でも架空の行を追加せず、取得済みの本人枠と全参加者表示を維持します。`tournamentPresentation.ts` の残り時間は分単位の切り上げ・0下限を共用し、60分以上を時間と2桁の分で整形します。
- `TournamentRooms` は大会詳細の開催中・集計中に、対局操作・順位表の下へ置きます。対象ゲームの `useGeneralLobbyRooms(game)` の既存cards API・全ページ取得を共用し、大会番号の一致と `status === "playing"` で絞り込みます。10秒の表示中更新・非表示停止・復帰時更新・全ページ成功時の一括反映を引き継ぎ、更新失敗時も既存カードを保ちます。共通 `LobbyRoomCard` には世代付きの既存観戦URLだけを渡し、参加操作は置きません。新API・migrationは追加しません。
- 大会チャットは `features/lobby/LobbyChat.tsx` と `useLobbyChat.ts` を総合ロビーと共用し、`TournamentPage` が大会IDと既存エントリー導線を渡します。大会別の下書きは大会IDで分離し、チャットの取得・エラー・5秒更新は成績と独立します。結果確定後も更新を続け、APIのサーバー時刻と締切で投稿欄を閉じます。
- `0024_tournament_chat.sql` が共用チャットの投稿・再送台帳・通報へ大会番号を追加し、大会定義に受付設定を追加します。既存行は総合ロビーとして保持します。`routes/lobbyChatRoutes.ts`・`adapters/community/chatStore.ts` の `/api/tournaments/:id/chat` と `/reports` が公開大会・本人・有効エントリー・名前設定・24時間の締切を検査し、共通の送信者台帳と、投稿の条件付きINSERTを含む1つのbatchで10秒制限・再送・大会別500件を確定します。大会の待機DOや盤面へチャットを保存しません。
- 大会管理の公開済み詳細に共用の `apps/admin/src/LobbyChat.tsx` を組み込みます。`/api/admin/lobby-chat?tournamentId=:id` で対象の受付・通報を取得し、受付操作にだけ任意の `tournamentId` を渡します。全体設定・利用者停止・削除・通報証拠・退会・毎時削除は既存の公開チャット基盤を使います。ゲスト統合では大会番号・再送台帳・過去投稿の非表示用識別子を維持します。

- 公開APIは `apps/worker/src/routes/tournaments.ts` と `tournamentsParticipation.ts`、Admin APIは `tournamentsAdmin.ts`、定義・名簿・順位と確定、待機・抽選・入室配信・席移譲・補償は[大会の入口](#大会の入口)の文脈と adapter です。定義は内部UUID、公開URLは公開時の数字連番です。Adminは `/admin/tournaments` から一覧・新規・編集・名簿へ進みます。
- ロビーの `TournamentEntrance` は全ゲームの共通 `LobbyView` からゲームIDを受け、対局操作とお知らせの後に「大会」「次回の大会」を配置します。対象3ゲームで公開情報の初回取得中に共通のスケルトンを1枚表示します。新UIは `/api/tournaments/lobby?view=sections&game=<GameId>` の `current`・`upcoming`・`serverTimeMs` を使い、公開済みの開催中／終了後24時間未満と開催前を別々に全件表示します。対象なしの見出し・余白は出しません。`TournamentEntranceCard` は開催前の「次回の大会」では `tournamentSettingsDescription` のルール説明を省き、大会名・状態・日時・人数と詳細／エントリー操作を表示します。対象ゲームの保存設定とルールを返し、対象外の2人用ゲームは空一覧にします。旧形式の指定なしAPIは1件の `tournament` を返す既存契約を維持します。分類・状態・件数は同じサーバー時刻を使います。大会設定には0030のmigrationが必要です。
- 大会カードは5秒更新、非表示停止と復帰時取得、失敗時の取得済み表示保持を使います。参加状態は大会IDと本人を区別し、本人を切り替えた後に古い応答を反映しません。ロビーと大会詳細の見出しでは日時の日本時間ラベルを外し、共有の日付整形の既定表記と次回案内は維持します。ロビーの人数は詳細／結果リンク左へ数字を大きく配置し、開催中は詳細ページとともに「参加中」と表記します。大会詳細は開催前の帯に「開催前です。」を加え、見出しの簡易条件から「人間4人・」を外してルールの記載へ集約します。詳細の人数・参加操作はPCで右寄せ、スマートフォンでは左寄せと全幅ボタンにします。
- 大会詳細の全状態で `TournamentRules` の直後に大会チャットを置きます。大会用 `LobbyChat` はPC560px／スマートフォン480pxにし、履歴の内部スクロールと下部の投稿操作を保ちます。総合ロビーの公開チャットは既存の600pxです。
- 下部の `TournamentList` はホームの全ゲームとゲーム別ロビーで共用します。`GET /api/tournaments?game=all|<GameId>&cursor=...` は公開大会を開始日時降順・公開番号降順の20件で返し、カーソルは同じ2項目を使います。応答は `tournaments`・`nextCursor`・`serverTimeMs`、各行は大会番号・ゲーム・名前・日時・状態・`entryCount` と優勝者の名前・画像・ゲスト表示に絞ります。登録済みエントリー人数は削除済みを除き、一覧と同じSELECT内で取得します。カードの下段は開催前・開催中・結果発表待ちに登録済みエントリー人数を表示し、0人も省略しません。開催中は「開催中」、結果発表待ちは「結果集計中」を人数に添えます。結果確定済みの保存順位1位かつ対局数ありの全員を一括取得し、現在プロフィール・ゲスト統合・退会匿名化の既存方針に従います。未確定で暫定優勝者を出さず、確定後に退会しても次順位を繰り上げません。既存の単一大会・区分別APIとDB形式は維持します。
- 大会一覧のカードは `LobbyBoardPreview` の軽量画像と `appThemeClasses[gameThemes[game]]` を共用し、ゲーム名・アイコン背景・枠線・リンクを対象ゲームのテーマへそろえます。ルール説明・独立した状態バッジ・優勝者横のゲスト表記は省きます。`tournamentListDate` は日本時間の同日の終了日を省き、複数日は両日、今年以外・年またぎは年も表示します。大会詳細などの既存 `tournamentDate` は維持します。名前と同率優勝者全員を折り返して表示し、カードの高さを固定しません。
- 大会一覧はPCで本文の全幅（ゲーム別のグリッドは2列分）を使い、カード幅320px・間隔12pxの横一列を一覧内でスクロールします。既存の `AppHorizontalScrollButtons` を共用し、スマートフォンでは矢印を隠してカードを縦に並べます。同じ一覧要素を維持して更新時の横位置を保持し、APIの新しい順を左から表示します。「優勝／同率優勝」と画像・名前は横に並べます。
- 大会一覧は取得済みページを5秒更新で先頭から再取得し、全成功時だけ差し替えます。追加取得と更新を直列化し、非表示時中断・復帰時取得、ゲーム切替時の旧応答破棄、失敗時の既存表示保持を行います。優勝者は `AppAvatar` と名前の静的表示を使います。ローカルで過去大会・アカウント・画像が既にある場合はそれを確認に使い、存在しない場合だけ少数の表示用データをローカルD1へ追加します。本番・開発の共有環境や本番画面のフォールバックへ架空データを混ぜません。
- 設定契約・ルール説明・整数点数とゲーム別順位比較は `packages/protocol/src/tournaments.ts`。`0018_tournaments.sql` の基盤と `0030_tournament_settings.sql` の設定移行、各環境の既存 `TOURNAMENT_COORDINATOR` bindingを使用します。新しいSecretsや外部サービスの設定はありません。環境への適用は既存のdb:migrateコマンドとデプロイ手順に従い、開発・本番への適用を区別します。
- 対局側は大会の文脈の `domain/room.ts`（大会ルームの型と保存キー）とGameRoomの専用RPCを使い、通常のホスト開始を維持します。大会contextは `ActiveShogiMatch`・`PendingShogiMatch` の外側へ保持し、既存の厳密な棋譜JSONを変えません。将棋の最終保存batchで得点イベントと保存済み台帳を一緒に確定します。
- Webの実画面は `features/tournaments`、入口は `features/lobby/LobbyView.tsx`。`tournamentController.ts` がdocumentの操作元とブラウザ内の生存確認、`tournamentRoomRecovery.ts` が入室先の復旧を扱います。ブラウザ内のロックと通知は補助であり、権限はサーバーの世代照合で確定します。`registrationReturn.ts` がエントリー意図付きの認証復帰を許可し、ルームの次局操作は旧席の退室成功後に大会へ戻ります。専用mock HTMLは開発時の参照として残し、実画面へは読み込みません。
- Adminの画面は `apps/admin/src/Tournaments.tsx`、追加ページ取得は `useAdminPages.ts`。権限喪失時に取得中の一覧と編集状態を破棄し、version競合時は入力を保持します。大会ごとの自由文は改行付きテキストとして表示し、機械条件は編集させません。


エントリーは大会名・参加者を確認するダイアログ内の「エントリーする」だけで正式登録します。公開・規約・年齢条件の注記とリンクを表示する旧 `TournamentConsent` は廃止し、既存の現行同意版の送信・参加資格検証は維持します。4人抽選後は「対戦相手が集まりました」の案内から「入室する」または表示後5秒で遷移し、全員接続後の別の5秒カウントダウンで対局を開始します。`useTournament` は同一対局の取得更新で入室タイマーを延ばさず、リロードと明示的な引き継ぎでは同じ割り当てへ直ちに入室します。pagehide・部品の破棄と、明示取消・ログアウトを区別します。GameRoomは開始予定時刻を永続化し、最後の本人接続断で解除、再接続時に再設定し、開始時に30秒の入室猶予・大会締切・本人資格を再検査します。旧参加確認状態は取得時に新しいルーム準備へ移行し、旧確認APIの遅延応答で新しい対局を取り消さない互換を維持します。

## 棋譜の保存と読み取りの入口

棋譜の保存（TB-108）と読み取り（TB-109）、戦績、戦法別の戦績、バッジ、本人の棋譜の一覧、対局の引き継ぎ（TB-139）は、ADR 0010 の形に分かれています。使用戦型の保存は `apps/worker/src/adapters/record/shogiFormationUsage.ts` にあります（TB-173）。

- `packages/contexts/record/src/domain/`: イベント形式の本体の作り方、チャンクへの分け方と件数と連続の検査、チャンクからの再生と照合、棋譜を API の形（詳細、公開の詳細、要約）に整える関数。純粋な関数で、依存は `@tetraboard/protocol` だけです。ゲームの契約での再生は、worker から関数として渡します。
- `packages/contexts/record/src/use-cases/`: 読み取り（詳細、本人の履歴の絞り込みとページング、公開の一覧とロビーの最近の対局、将棋の再生のページ、ゲストの棋譜の引き継ぎの判定。`readPorts.ts` の `MatchReadStore` と `MatchClaimReadStore`）と、保存の進め方（アップロード → チャンク → 公開）、再送、内容の違う再送の拒否、保存済みの判定、将棋の 1 回のイベントの上限。D1 は `ports.ts` の `MatchRecordStore` で読み書きし、公開の書き込みは実行せずに返します。Cloudflare と zod に依存しません。テストは同じパッケージの `test/`（Bun、メモリの上のポート）です。
- `apps/worker/src/adapters/record/`: ポートの D1 の実装、公開の後の確認の SQL、zod とゲームの契約での読み取りの検証（`readValidation.ts`）。ルートの入口（`routes/matchRoutes.ts`、`routes/publicMatchRoutes.ts`、`routes/generalLobbyRoutes.ts`）は worker に残り、応答を protocol のスキーマで検証します。
- 戦績、戦法別の戦績、バッジ、本人の棋譜の一覧、対局の引き継ぎ（TB-139）: 文脈の `domain/accountStats.ts`、`badges.ts`、`matchProfiles.ts`、`use-cases/accountStats.ts`、`badgeAwards.ts`、`badgeNotifications.ts`、`matchProfiles.ts`、`matchClaims.ts`。バッジと履歴の書き込みは実行せずに返し、棋譜の公開と同じ batch に入れます。ルートは `apps/worker/src/routes/` の `statsRoutes.ts`、`formationStatsRoutes.ts`、`badgeNotificationRoutes.ts`、`matchRoutes.ts` です。
- `apps/worker/src/flows/matchSave/`: 文脈をまたぐ組み立て。退会の伏せ字、zod とゲームの契約での検証、履歴の索引、レート、バッジ、使用戦型、大会の結果、棋譜の引き継ぎを、record の公開と同じ batch か直後に並べます。batch の区切りと順序を変えるときは、保存の約束（[ルームの仕様](specs/room.md)）と照らし合わせます。

統合済みのゲスト（`guest_account_merges`）の対局が統合の後に保存されたときは、`matches`、`match_uploads`、`account_match_history` への挿入の SQL の中で、参加者を統合先のアカウントに書き換えます（`adapters/record/guestMerges.ts`、TB-137）。3 つの表への挿入は決めたファイルにしかなく、そのことを `test-bun/guestMergeRecordBoundaries.test.ts` が確かめます。以前は D1 のトリガー 3 つが同じことをしていましたが、TB-138 で消しました。

退会したアカウントの参加者と、引き継ぎが失効した席（`match_participant_accounts` の `retired`）は、同じ挿入と `record_json` の更新の SQL の中で伏せ字にします（`adapters/record/privacyScrub.ts`、TB-152）。統合先への書き換えの後に伏せ字にします。同じ働きの古いトリガー 9 個は TB-155（migration 0056）で消しました。席を `retired` にするのは退会の受付だけで、同じ batch で `scrubRetiredMatchClaimStatements` がその席の棋譜を伏せ字にします（TB-151）。書き込みの場所は `test-bun/guestMergeRecordBoundaries.test.ts` が確かめます。

## 総合ロビーの実装

`features/lobby/GeneralLobbyPage.tsx` がトップ、`GeneralLobbyRooms.tsx`・`useGeneralLobbyRooms.ts` が横断一覧、`GeneralLobbyChat.tsx`・`useLobbyChat.ts` が公開チャットです。架空データ・プレビュー操作・疑似ログイン・DEV限定分岐は撤去し、`/` を両環境のbuildへ含めます。既存の `AccountMenu`・`useRoomEntry`・`RoomEntryDialog`・`RecentMatches` を使い、参加時と観戦URLにルーム世代を渡します。観戦URLは世代確認用の `invite` と `watch=1` を持ち、参加ダイアログを自動表示しません。通常の招待URLは従来どおり参加案内を表示します。登録復帰先に `/` を許可し、チャット下書きはsessionStorage、送信者非表示は公開IDをキーにlocalStorageへ保存します。

ホームはブランド見出し・紹介文、6ゲームカード、公開ルーム、大会一覧、公開チャット、最近の対局を縦に並べ、スマートフォンでは大会一覧を最近の対局の下へ移します。幅の購読でkey付きの領域を並べ替え、DOMと表示の順序をそろえつつチャットの下書き・取得済み状態を保持します。ゲームカードはPC6列／スマートフォン3列、公開ルームはPC2列／スマートフォン1列です。2026-10-30の開発者の承認により、スマートフォンのゲームカードの画像を32pxへ縮め、余白を削減しました。`LobbyGameGrid` は既存の優先順の後に未掲載の `gameIds` を追加し、`HomeGameList` は既存の幅購読結果を受け取って初期6件／全件を切り替えます。7件以上のスマートフォンだけに残件数付きの展開・折りたたみボタンを置き、`aria-expanded` と `aria-controls` を付けます。PCは全件、作成ダイアログは従来の全件・画像寸法を維持します。展開状態は幅切替で保持し、ページの再マウントで初期化します。一覧は最大480px／400pxで内部スクロールします。作成入口はゲーム選択後に対象ロビーへ `roomEntryIntent: "create"` を渡し、既存ダイアログを一度だけ開きます。

`GeneralLobbyRooms` は取得済みデータと空表示を自動更新中も保ち、`pendingSource === "refresh"` のときだけ一覧に共通スピナーを重ねます。ゲーム選択後は履歴stateの `roomEntryIntent: "create"` を渡し、共通の `LobbyView` が既存ダイアログを初期表示します。stateの作成意図だけを履歴置換で消費し、他のstateを残して再訪時の自動再表示を防ぎます。

総合ロビーのレート表示は `useLobbyGameRatings.ts` が本人と認証世代を照合して取得し、`LobbyGameGrid` が対応マーク・受付状態・本人のレートまたは認定進捗を描画します。作成ダイアログはレート情報を渡さず使います。`GET /api/lobby/game-ratings` は対応ゲームの全件について受付状態を返し、登録者には既存の `ratedMatchmakingPolicy.readSummary` から得た本人の数値・進捗をまとめます。待機列の操作は行いません。1ゲームの読み取り失敗はそのゲームのエラーとして返します。応答は `no-store` とし、公開プロフィールID・ユーザー名を使って取得中の本人切替を照合します。認定中の内部値・ランク・内部アカウントIDを返しません。

通信契約は `@tetraboard/protocol/general-lobby` です。新UIは総合・ゲーム別とも `/lobby/rooms?view=cards` を使い、`game`・`capacity` 条件で20件ずつ最後まで取得します。APIの任意の `mode`・`joinable` 条件と条件適用後の `totalCount` は維持し、Webはモード・参加可能条件を取得済み全件へ適用します。各roomの席順の `participants` は既存appearanceに、人間だけ公開用の `profileTarget` を追加します。通常は部屋番号・世代・席の公開参照、退会者はnullで、CPUの形は変更しません。内部アカウントID・参加資格情報は公開しません。ホスト用公開プロフィール参照も維持します。指定なしの `/lobby/rooms` と既存 `/rooms` の形と順序は変更せず、strict schemaを使う更新前タブとの互換性を保ちます。

ルームの並びは募集可能・満室・対局中、更新日時降順・番号降順です。共通hookは初回・10秒更新・手動更新・表示復帰時にカーソルがなくなるまで順次取得し、全ページ成功時だけ一括反映します。取得中の重複要求と繰り返しカーソルを防ぎ、非表示時は中断し、復帰は先頭から取得します。初回途中失敗はエラーだけを表示し、更新途中失敗は前回の全件・選択条件・位置と0件表示を保持します。モード・参加可能条件の切替は通信状態を変えず、画面内でAND適用して件数を算出します。ホームの定員変更だけ取得条件を切り替えます。ゲーム別は初期3件から全件へページ内展開し、条件変更で展開・位置を戻します。追加取得ボタンは使いません。最近の終局は既存記録から最新20件を取得し、人間限定をページ分割より先に適用します。

公開索引には入室時の参加者画像を保存します。保存用schemaは公開cards schemaから独立させ、既存の席IDとappearanceのJSONを維持し、公開プロフィール参照はD1の読取後に組み立てます。旧索引や旧pendingの欠落と実際の空配列を区別し、一覧ページで不足する部屋だけを世代照合して補完します。補完は公開更新日時を変えず索引revisionだけ進め、既存の保存・再送経路へ載せます。匿名化トリガーを通したD1を読み直し、最新条件・件数・カーソルを適用して返します。閉鎖・番号再利用で別世代の画像を混ぜず、遅れた書込みも退会者の画像・プロフィール参照を復活させません。移行は `0025_lobby_room_participants.sql` で行い、プロフィール参照用の追加migration・既存棋譜の書換え・全DOの一括巡回は不要です。

`LobbyChatGuestDialog.tsx` は公開チャットの名前確定時に既存の `ensureGuestAccount` で作成とCookie読戻しを行います。名前確定後に本人を更新し、チャットの認証世代を切り替えて停止・送信間隔を再取得してから投稿欄を使います。本文を自動送信せず、取得・作成失敗では入力を保持します。

`/lobby/chat`・`/lobby/chat/reports`・`/admin/lobby-chat` は `routes/lobbyChatRoutes.ts` が受け、送信と取得の判定は community の文脈の `domain/chat.ts`・`use-cases/chat.ts`、D1 の実装は `adapters/community/chatStore.ts`（通報は `chatReports.ts`、運営の操作は `chatModeration.ts`、期限の削除は `chatCleanup.ts`）にあります（TB-144）。取得は、メッセージ、受付の設定、本人の停止状態、大会の状態を 1 回の D1 の batch で読みます。D1の条件付きINSERTが本人・プロフィール・停止・10秒制限・退会・再送IDを検証し、同じbatchの後続の文が、投稿が入ったときだけ送信時刻・再送台帳・最新500件を更新します（TB-145。同じ働きのAFTER INSERTトリガーはTB-146で消しました）。再送台帳は本文のハッシュと投稿IDを持ち、運営削除後の同一再送も本文を復活させません。通常投稿と再送台帳は7日、通報証拠は通報から7日です。期限と退会受付の時点で取得から除外し、毎時削除・削除失敗の再試行へ接続します。退会の完了前に通常投稿と再送台帳を削除し、証拠内の本人識別を除去します。

通報は開発者の明示承認に従い、直近1時間で1アカウント5件までです。同じ発言への再通報は重複登録せず、件数を消費しません。件数の照合と登録を単一の条件付きINSERTで行い、同時要求でも上限を守ります。

管理画面の `LobbyChat.tsx` は通報と現在の投稿、停止中の利用者、全体受付状態を表示します。既存の管理者認証とOrigin検証を使い、実行前に操作内容を確認でき、失敗時は再試行できます。ルームチャットの通報契約・進行処理は変更しません。

D1 migration `0017_general_lobby.sql` はチャット・送信者・再送台帳・証拠・全体設定とトリガー、ルーム索引、計測集計列を追加します。既存棋譜の書換えと外部依存の追加はありません。ローカルは `bun run dev` のmigrationで適用します。公開は開発環境のmigration適用と実認証・運営操作・削除処理の確認後、リリース承認を得て本番にも適用します。必要なSecretsは既存の認証・管理者設定を利用し、新しい外部サービス設定は不要です。OAuthのホームページ設定は公開時にトップURLへ整合させます。

トップの初期紹介HTMLは `renderGeneralLobby` で生成します。通常のSPA用の空root・noindexを持つ `app.html` を別に生成し、ログイン・ルーム共有・規約にはこちらを配信します。`index.html` の直接アクセスはトップへクエリを保持して308、トップ自体は200です。公開チャット本文をHTMLへ埋め込まず、サイトマップの静的URLはトップ、6ゲームロビー、四人将棋のルール、サイトの利用ガイドです。開発は検索対象外です。

## 共通ロビーと四人将棋UI

四人将棋の盤上駒と持ち駒は、PC・スマートフォンとも `shogiPieceDirection(side, viewerSide)` で同じ向きを求めます。`FourShogiBoardLayout` はスマートフォン用の `FourShogiHand` に上2席は `reverseOrder=true`、下2席は `false` を指定して、向きと駒種の並び順を分けます。PCと通常将棋は方向から求めた既定の並び順を使います。対局・観戦・ルーム内棋譜・保存済み棋譜は同じ部品を共用します。表示仕様の正本は [README](../README.md#四人将棋のルーム画面) です。

全6ゲームは `features/lobby/LobbyView` を共用し、タイトル・説明・遊び方・盤面画像をゲームで切り替えます。対局操作の2ボタンは共通のDOMを使い、768px以上はタイトルの右、767px以下は「遊び方」の下にCSSで配置します。PCは左に公開ルーム、右にランキングと最近の対局、その下に「みんなの投稿」と大会一覧を全幅で置き、スマートフォンは操作・公開ルーム・ランキング・最近の対局・みんなの投稿・大会一覧の順です。DOM順を共通にし、幅の購読や要素の並べ替えを使いません。公開ルームの更新操作は見出し行へ置きます。空表示はPCで右列全体の下端までCSSで伸ばし、スマートフォンは最小高さ240pxにします。お知らせ・大会入口は対局操作の後、ゲーム紹介は一覧の後に表示します。「みんなの投稿」は `LobbyPostPreview` が見出し・スケルトン・計測の送信を受け持ち、取得と一覧は `loadLobbyPostPreview` を動的 import して読みます。初回 JS を増やさないため、ロビーから `features/board` を静的 import しません。チャンクの読み込み失敗は投稿の取得失敗と分け、区画の中の手動の再読み込み（`preloadRecovery.reload`）で扱います。同じ URL への import の再試行では復旧できないためです。総合・ゲーム別ロビーの初回一覧には共通の `AppSkeleton` と `AppSkeletonCard` を使います。ゲーム別のランキング・最近の対局は本文に固定3行分を確保し、0件・初回失敗の案内も同じ領域に表示します。

全6ゲームのタイトル横と総合ロビーのゲーム一覧は `LobbyBoardPreview` を共用し、`assets/lobby/` の専用WebP画像を1枚の `img` で表示します。五目並べと四人五目並べは同じ空の15路盤画像を使い、画像は計5枚です。実行時にゲームエンジン・対局用の盤面部品・`ShogiPiece` を読み込まず、将棋の盤・駒画像の準備も始めません。`width`／`height` で画像の縦横比を確保し、`aria-hidden`・空のalt・ドラッグ無効の装飾として表示します。入力中のモードや通信状態には連動させません。

画像は既存の初期盤面から傾きと外側の影を除いて書き出し、WebP品質0.86で保存しています。四人将棋と通常将棋は、木目と罫線を描く共有盤面に南を手前にした36枚／40枚の初期配置を載せ、250×250pxへ、それ以外は264×264pxへ出力しています。5枚とも20KB未満です。元画像や初期配置を変更した場合は専用画像も更新します。タイトル横は白い囲みなしで48px、ホームはPC64px／スマートフォン32px、共通ナビ・固定タブは20pxです。タイトルとホームの傾きと影はCSSで付け、将棋とリバーシは左へ7度、五目並べは左へ6度を維持し、ナビ・固定タブは回転と影を外します。初期配信HTMLもビルド済みの同じ画像URLを使います。ゲーム別のページから独自の盤面部品を渡さず、共通ロビーがゲームIDから画像を選びます。

`GameBadge` は棋譜カードのゲーム名表示に使い、`showGame` で表示を切り替えます。公開ルームカードは常にゲーム名を表示し、総合ロビーでは `gameLink` で各ゲームのロビーへのリンクにします。`LobbyFooter` は総合・各ゲームロビーの規約導線と著作権表記を共用します。

`LobbyRoomCard` は総合・ゲーム別の表示を共用し、盤面、ゲームとモード、時計、ホスト名から作る部屋名、番号、募集状態、実参加者画像と空席、人数、観戦／参加を配置します。ホストと各人間のアイコンは既存の `PlayerProfileTrigger`、CPUは通信不要のlocalProfileを使います。空席・退会者は操作対象にせず、アバター列は操作可能なgroupとして人数も読み上げます。「募集中」は薄いテーマ色と濃い本文色で表示します。参加不可のボタンは無効にし、大会ルームの参加は「大会へ」に接続します。

`LobbyRankings` はシングルス優勝数（二人ゲームは勝利数）の上位3人を固定表示します。自動切替・タイマー・スライドを廃止し、モード・指標切替と更新は詳細ダイアログの `AppTabs` に集約します。詳細は上位10人を表示し、取得結果をプレビューと共有して更新失敗時も保持します。Portalにはゲームのテーマを渡します。

両ゲームで `useLobby` と `useRoomEntry` を使い、ゲーム指定を付けて取得・作成・参加します。省略時はリバーシです。将棋では作成時に三人攻撃禁止を設定できます。ランキングもゲーム別に集計し、リバーシの値を将棋へ流用しません。ダイアログを閉じても入力を保持し、ゲームを切り替えたときは破棄します。

旧ゲームバーは廃止し、`AppHeader` と共通ナビゲーションを使います。PCはホーム・遊び方・直近ゲーム、スマートフォンは上部にロゴと設定、下部にアカウントも含む4タブを固定表示します。アカウントタブはContextのゲスト・登録者の実効画像を `AppAvatar` に渡し、画像更新・本人切替へ追従します。未ログイン・画像読み込み失敗では既存の人型アイコンを使います。`AccountLayout` で対象ページの下余白とゲームロビー・四人将棋のルールページの訪問記録を扱い、対局・観戦・棋譜を対象外にします。直近GameIdは `tetraboard:last-lobby-game` に保存し、未保存／破損時は四人リバーシ、保存失敗時はメモリ保持、別タブの `storage` イベントも反映します。ナビの表示だけでは保存しません。大会ページの新ナビも既存の待機取消を通し、取消失敗時は移動せず、成功後に選んだページへ進みます。

共通の `/how-to-play` は[スクリーンショット付きのサイト利用ガイド](#サイトの利用ガイド)を表示します。Workerはビルド時に生成したHTMLを配信します。ゲーム別のルールダイアログとは分けます。初期配信HTMLは保存値を読まず、ゲームロビーではそのゲーム、ホームでは四人リバーシを直近枠へ表示し、React起動後に保存値へ同期します。大会一覧と最近の対局には横スクロールの補助ボタンがあります。

既定の共通テーマは緑です。将棋の本文には `game-theme-four-shogi` を付け、Portalの入力・遊び方・ランキングのダイアログには `AppDialog` の `theme="four-shogi"` を渡します。`primary`／`primary-hover` は主要ボタンの塗り、`primary-foreground` は文字、`brand` は文字アクセントとして分けます。HeroUIの `--accent` と `--accent-foreground` も同じ範囲で設定します。共通ヘッダー・アカウントメニューをゲームのテーマ範囲に含めず、グローバルなテーマ切り替えは行いません。意味を持つdanger・focusの色は上書きしません。

ゲーム別のURLとAPI、作成・参加payload、入力保持と破棄、ランキングの選択と戦績・履歴の共通選択はBunとhappy-domで確認します。通信・認証・永続化はWorker統合テストで確認します。遊び方は各ゲームのルール正本と照合します。

### サイトの利用ガイド

利用者向けの正本は[README](../README.md#サイトの利用ガイド)です。[HowToPlayPage.tsx](../apps/web/src/features/help/HowToPlayPage.tsx) が「TetraBoardの使い方」の見出し、目次、ゲーム選択・CPU・友達の招待・公開参加と観戦・対局画面・棋譜と記録・大会・アカウントと設定の8章を表示します。スマートフォンを中心にPCの配置を補足し、既存の共通ナビゲーションと未認証での閲覧を維持します。ゲーム固有のルール説明は既存ダイアログへ案内します。

画像はローカル環境の実UIを通常の操作で開いて撮影し、四人リバーシを基本例、大会は四人将棋を使います。撮影時のviewportはスマートフォン390×844・DPR2を9枚、PC1280×900を2枚とします。PNG原本と一時撮影スクリプトは `/tmp` に置き、採用するWebP11枚を `apps/web/src/assets/help/` に保存します。[helpScreenshots.ts](../apps/web/src/features/help/helpScreenshots.ts) に画像importと `{ src, width, height }` をまとめ、寸法は変換後の画像に合わせます。ページでは代替テキスト・説明とともに縦横比を保って表示し、PC例は「PCの画面例」を開いて確認できる形にします。先頭画像は通常読込み、ほかの画像は遅延読込みにします。

初期HTMLは `HowToPlayPage` のヘッダーを `InitialNavigation` に差し替えて生成します。スクリーンショットの配信URLはViteのmanifestから解決し、ビルド時に実ファイルの存在を確認します。初期HTMLと画面内遷移で `src/seo/howToPlayMetadata.ts` のメタ情報を共用し、本番のサイトマップに更新日付きで掲載します。

本文の操作名は実装と照合します。ゲストも記録を保存できること、友達用も全ルーム公開であること、通常ルームは全員準備後にホストが開始し、大会は入室後に自動開始することを区別します。新API・依存・DBスキーマは追加しません。画像撮影は利用ガイドの資料作成に限り、テスト・CI・常設の撮影コマンドには組み込みません。DOMと実画像の確認範囲は[テスト文書](testing.md#サイトの利用ガイドの確認)に従います。

## 四人将棋大会のUIモック

2026-10-16に開発者が本モックを合格としました。承認された仕様と本実装の案内は[README](specs/tournament.md#四人将棋大会の確定仕様)、本実装の順序は[実装計画](specs/tournament.md#維持する契約)を参照します。専用入口は `apps/web/tournamentMock.html`、画面は `apps/web/src/mocks/tournaments/TournamentMock.tsx`、例示データは同ディレクトリの `tournamentSamples.ts` です。既存のヘッダー・ナビゲーション・盤面図・テーマ・共通UIを使います。

`bun run --cwd apps/web dev` を実行し、以下を開きます。Workerの起動やログインは不要です。

- ロビー入口：`http://localhost:5173/tournamentMock.html#/games/four-shogi`
- 大会詳細：`http://localhost:5173/tournamentMock.html#/tournaments/1`

画面上部の確認用操作で、開催前・開催中・集計中・結果発表、未ログイン・ログイン済み・エントリー済み、通常成績・同率優勝・有効対局なしを切り替えます。ページ移動では状態を保持し、再読み込みで初期状態へ戻します。エントリー導線からの疑似ログインはエントリー完了へ進み、ヘッダーからの疑似ログインはログイン済みにするだけです。

開催前は人数の拡大表示と右寄せのエントリー操作を確認し、参加予定プレイヤーと本人の大会成績は表示しません。開催中・集計中は左側の対局操作と本人の成績、右側の順位表を共通の2列に置き、狭い画面では対局操作・本人の成績・順位表の順に並べます。「対局する」で待機表示と「取り消す」へ切り替わり、集計中は対局受付を終了します。モックは承認当時の全成績列と横スクロールの表示を保持します。現在の本実装のPC全列・スマホ行展開・プレイヤー情報・開催中案内は[READMEの確定仕様](specs/tournament.md#大会の状態と画面)と[実装の入口](#大会機能の実装の入口)に従います。上位の例示データに全角10文字の名前を含め、幅を確認できます。本人の成績の配置はカード幅に応じて切り替えます。全参加者表示とルール詳細の開閉も確認できます。

大会の登録・対局・成績は保存せず、認証・大会API・計測にも接続しません。人数や残り時間はサンプルで自動進行しません。通常対局の操作は説明ダイアログだけを開きます。標準の本番ビルドは `index.html` を入口にするため、このモックのHTML・JavaScriptは出力に含めません。公開ロビーと本番ルートへの組み込み、実際の `/tournaments/:id` の配信は本実装時に行います。

型・整形・既存テスト・両環境のbuild／Worker dry-runで既存コードとの整合を確認します。画面寸法・実画像デコード・動きの見え方は[テスト方針](testing.md#実行環境)に従って手動確認の対象とし、ブラウザを起動する自動検証は追加しません。

## ロビーのSEO生成と成果確認

トップと6ゲームロビーの紹介HTML、四人将棋のルールとサイトの利用ガイドのHTML、各ページのメタ情報をビルド時に生成します。[確定仕様](../README.md#検索向け配信と効果の確認)に従います。

`src/seo/lobbyMetadata.ts` はWeb側のゲーム別title・description・紹介の正本です。ゲーム名・ロビーパスは軽量ゲームカタログを参照します。紹介は `GameIntroduction` で通常ロビーと初期HTMLが共用し、ルール正本に合わせて同じ変更で更新します。ロビーの静的生成にはエンジン・認証・API・動的一覧を使いません。

`/games/four-shogi/rules` の初期HTMLと遅延ルートは `FourShogiRulesPage` を共用します。初期配置図はエンジンの初期局面を参照し、説明文は「遊び方」ダイアログと共用します。図は対局と同じ盤・駒の画像を使い、初期HTMLの画像URLと実ファイルをビルド時に照合します。初期配置には棋譜表記の読み上げ用の説明を添えます。Reactの起動後は共通ヘッダーを表示し、ロビーとルールを結ぶ本文のリンクは遷移先の先頭を表示します。

四人将棋・四人リバーシ・五目並べ・リバーシ・将棋のFAQは `src/seo/lobbyQuestions.ts` に置き、`GameIntroduction` が同じ回答を初期HTMLと通常画面へ出力します。FAQを持つゲームは白背景の紹介カード内に、概要・CPUとの3段階の開始手順・友人（2人用は「友達」）との4段階の開始手順・主要ルール・各3問のFAQを縦1列で表示します。開始手順のCPUの人数・席数・モードの有無は `gameCapacity` と `gameCatalog` から出し分けます。見出しはh2、質問はh3、開始手順はol、既存の利用ガイドへの案内は通常のa要素を使い、折り畳み・追加データ取得・参加処理を持ち込みません。四人五目並べは概要・遊び始め方・主要ルールの3節を表示します。title・descriptionを変えるときはREADMEの仕様を同じ変更で更新します。公開後は対象URLと検索語ごとの28日比較を基本に、表示回数・クリック数・CTR・平均順位を確認します。

トップとゲームロビーのtitleの語順と検索向け別表記は[README](../README.md#ゲームロビーの検索向け紹介と配信)に従います。静的生成・大会HTML・画面内遷移は、ルーム・棋譜の共有と同じ `protocol/room-sharing` の `openGraphTags` でOGPとXのカードを生成します。canonicalと同じオリジンの画像URLを使い、公開ページの `og:site_name` は1件にそろえます。画面内遷移では前の画面の共有タグを取り除きます。

総合ロビー・各ゲームロビー・四人将棋のルール・サイトの利用ガイドの `lastModified` は、title・description・紹介・主要ルールなどページの内容を更新した日に `YYYY-MM-DD` で更新します。静的URLの `lastmod` はこの値から生成し、再ビルドや動的一覧の更新だけで日付を進めません。[Googleのlastmodの説明](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap#additional-notes-about-xml-sitemaps)を参照します。

WebのbuildはVite出力後に `build/generatePublicLobbies.ts` を実行し、ハッシュ付きJS・CSSの参照を保持した6ゲームロビー・四人将棋のルール・サイトの利用ガイドのHTML、robots.txt、静的URL 9件のsitemap.xml、404.html、トップのindex.htmlと検索対象外のapp.htmlを生成します。生成コードと関連Bunテストは `tsconfig.build.json` でも型検査します。ルートのbuildが既存の `scripts/buildAssets.ts` でこれらをWorker資産へコピーします。生成物はGit管理しません。Viteの開発画面は従来のCSRを使い、初期HTML・HTTPヘッダーの確認には `bun run build` 後の本番相当ローカルWorkerを使います。

Worker の `tournamentPages.ts` は `app.html` に大会一覧と公開済み大会詳細の本文・メタ情報を挿入します。本番のサイトマップには静的9 URLへ大会一覧と公開済み大会のURLを追記します。D1の読み取りに失敗した場合、HTMLは `noindex` の `app.html`、サイトマップは静的な資産を配信します。

`renderPublicLobby.tsx` と Worker の `tournamentPages.ts` は `protocol/src/structuredData.ts` のJSON-LD生成を共用します。URLのオリジンは静的HTMLでは `publicOrigin`、大会HTMLでは `APP_ORIGIN` です。`pageMetadata` は表示中のパスが変わったときに初期HTMLのJSON-LDを取り除きます。

`startPublicLobby` は初期本文のあるロビー・四人将棋のルール・サイトの利用ガイド・大会ページでルーターの初期化完了を待ちます。成功時に既存createRootへ渡し、遅延ルートの失敗時には初期本文と通常リンクを残します。四人将棋のルールとサイトの利用ガイドは初期HTMLのメタ情報も保持します。他画面の初回loader・fallbackは従来どおりです。`pageMetadata` は初期表示とルーターのlocation変更でtitle・description・canonical・robotsを同期し、公開棋譜独自のrobots操作は行いません。`/terms`・`/privacy` のtitleはWorkerの `legalHtml.ts` と同じ `protocol/privacy` の `legalDocuments` を参照し、文書名とサービス名を保ちます。

本番の資産配信はWorkerが公開ロビー・四人将棋のルール・サイトの利用ガイド・既知SPA経路・静的資産を明示し、Wranglerの無条件SPAフォールバックを使いません。`worker.ts` の入口で、本番設定の `tetraboard.net` へのHTTPと旧Workerホストを本番HTTPSへ308転送し、パス・クエリを保持します。資産・API・認証・WebSocketの処理前に転送し、ローカル・開発環境には適用しません。HTTPSの `/` は200、`/index.html` と公開URLの別表記は308、未知URL・欠落資産は404、既知の非検索画面はnoindexです。公開ロビー・四人将棋のルール・サイトの利用ガイドはGET／HEAD・ETag／304に対応し、404本文の取得では条件付きヘッダーを除去します。`scripts/checkDeployment.ts` はトップ配信、全ロビーと四人将棋のルールの初期本文・メタ情報、robots／sitemapと既存APIを確認します。本番URLを指定した場合だけ、HTTPのトップ・ロビー・APIの308とクエリを含むHTTPS転送先も確認します。

公開後のロビーHTML検査は `scripts/deploymentLobbyHtml.ts` の副作用のない関数を使い、メタ情報・本文と、メインナビ内のホーム・遊び方・当該ゲームへのリンクを確認します。本文の再読み込みリンクだけではナビの欠落を補えません。本番の全6ゲームと開発環境の実生成HTMLをBunテストでも同じ関数へ渡し、URLと検索設定を確認します。

関連検証は `bun test --cwd apps/web ./test/publicLobbies.test.ts ./test/developmentSeo.test.ts`、`bun test --cwd apps/web --preload ../../test-support/dom.ts ./test-dom/publicLobbies.test.tsx`、`bun run --cwd apps/worker test test/publicAssets.test.ts test/apiRouting.test.ts` です。Bun・happy-dom・Worker統合テストで生成、遷移、200／308／404、GET／HEAD／304、Content-Type、通常UA／Googlebot、認証とAPIの境界を確認します。画面寸法・実ブラウザ入力・JavaScript無効時の見え方は手動確認とし、ブラウザ自動テストは追加しません。

公開前に既存Search Consoleのドメインプロパティ `tetraboard.net` で「検索タイプ: ウェブ」「国: 日本」を指定し、直近28日間の対象ページ別・対象検索語別のクリック数・表示回数・CTR・平均掲載順位を記録します。対象語は「四人将棋」「四人リバーシ」、ページは各正規URLの完全一致です。期間・フィルター・端末区分も併記し、データのない項目を0と断定せず「データなし」とします。集計・期間はSearch Consoleの表示に従い、既存Adminの日本時間の指標と混ぜません。新たな個人別流入計測を追加しません。

必須ローカル検証とGitHub CI、差分・結果に対する開発者の承認後にマージ・公開します。本番確認後、Search ConsoleのライブURL検査でトップと全6ロビーの本文・検索許可を確認し、既存のサイトマップURLを再送信して未登録・更新対象ページのインデックス登録をリクエストします。サイトマップ送信の受理は取得待ちを意味し、個別URLの登録依頼や登録完了とは区別します。URL検査APIは登録済み情報の確認だけに使い、ライブURL検査と個別の登録リクエストはSearch Console画面から行います。実Googlebotによる登録と正規URL選択はライブ検査・UAのローカル比較と区別します。SEO整備の完了は本番確認・送信・基準値記録までとし、公開前は未完了です。

Issue [#207](https://github.com/yksw-clm/tetraboard-2026/issues/207) の別表記追加を本番公開したら、公開日とコミットを成果確認Issue [#87](https://github.com/yksw-clm/tetraboard-2026/issues/87) に記録します。公開4週間後に「4人将棋」のCTR・クリック数・表示回数・平均掲載順位を公開前28日間と同じフィルターで比較し、「四人将棋」と対象ロビーの数値も併記します。実装PR提出時点では公開日や公開後の結果を確定しません。

公開後4〜8週間で最初の成果を評価します。両URLが登録されGoogleの正規URLと一致し、日本・日本語・ログアウト状態のPC／スマートフォンで週1回×4週間、両検索語の通常の自然検索1位を確認し、各ページの評価対象28日間クリック数が公開前28日間より増加した場合を成果達成とします。日時・地域・端末を記録し、平均順位だけで常に1位と判定しません。データ不足は観測期間を延長し、未達なら継続課題とします。順位・反映時期の保証と自動監視は設けません。

## 四人将棋のオンラインルーム

公開型は `FourReversiRoom | FourShogiRoom | ReversiRoom | ShogiRoom | GomokuRoom` で、`settings.game` をガード関数で判別します。既存リバーシの保存形式・着手通信は維持します。将棋は担当方向、方向別の時計、局ID、局面revision、三人攻撃禁止、同じrevisionの合法手・三人攻撃禁止候補（`threePlayerAttackForbiddenActions`）と王手情報を配信します。禁止候補はエンジンの `getActionAvailability` で通常合法手から三人攻撃で除外された手だけを導出し、別の不正手を含めません。旧保存局面の未保存フィールドは公開局面から読込時に補完します。通常スナップショットに千日手の出現数は含めません。Webは受理された局面を表示し、履歴を補って独自に進行させません。

`room.game.action` の将棋着手は `roundId`・`positionRevision` と `movePiece`／`dropPiece` を送ります。サーバーが認証・局ID・revision・手番・合法性を検査し、着手と脱落でrevisionを進めます。`room.three-player-attack.set` は待機中のホストだけが変更でき、モードと同様に人間の準備を解除します。

将棋のDO保存は通常状態、局ID・局面キー別の千日手回数、初期化情報と連番イベントへ分けます。 実対局では千日手の全行を読み込まず、エンジンが必要とする局面キーだけを主キーで参照し、確定した変更分だけを保存します。参照キャッシュは同期的な一回の状態遷移またはCPU選択内に限定し、保存・ロールバック・次局へ持ち越しません。CPU探索では枝ごとの変更分を基底履歴より優先し、仮想着手の回数は永続化しません。完全な回数辞書を使う従来のエンジン呼び出しとWebの棋譜再生は維持します。局面・回数・イベント・revisionを同じトランザクションで確定し、棋譜へ全状態を複製しません。直前局は `GET /api/rooms/:id/rounds/:roundId/replay?instanceId=<UUID>&cursor=<offset>` から100イベントずつ取得します。Webは部屋世代・局ID・規則バージョン・件数・連続番号を検証し、エンジンで再生します。再生中の完全な状態は1つだけ保持し、閲覧用には千日手索引を除いた局面を保持します。次局開始で部屋の棋譜取得を中止します。未保存の終局イベントは次局開始・部屋閉鎖でも保持し、D1保存を確認後に不要な行を削除します。将棋の恒久履歴・戦績・ランキングはゲーム指定で分離します。

CPUの待ち時間と計時は [ルームの仕様](specs/room.md#投了通信切れと持ち時間) に従います。選択結果と局ID・revision・手番を保存し、次のAlarmで期限を再確認して適用します。同期処理中に `Date.now()` が進まない本番でも、別のイベントで得た時刻までを時計へ反映します。根拠は [Cloudflareの時刻仕様](https://developers.cloudflare.com/workers/runtime-apis/performance/) と [保存上限](https://developers.cloudflare.com/durable-objects/platform/limits/) です。

外側の `RoomLayout`、タブ、チャット、招待、カードの名前・アバター・ホスト・接続表示、時計表示と棋譜操作を共有し、将棋の盤内配置と操作は専用部品に分けます。正方形の盤に木目画像を中央で切り出して敷き、四辺の1.3%の余白の内側に9×9のCSS Gridを配置します。盤の背景には [Shogi Imagesの「盤 - 木材（暖）458x500」SVG](https://sunfish-shogi.github.io/shogi-images/board/warm_458x500.svg)（CC0）の `wood` レイヤーのPNGをWebP（品質92）に変換して使います。ルームと棋譜のloaderは、将棋または四人将棋と分かった時点で背景画像を先読みします。座標と駒の向きを変換して4方向を表示します。 上辺と右辺の1.3%の余白には、閲覧方向から基準座標へ変換した筋・段を棋譜と同じ書式で並べます。座標ラベルは入力を透過し、マスの読み上げには棋譜座標を含めます。盤上・持ち駒・ドラッグ・成り選択は同じ駒部品を使い、1マスの幅に対して四人将棋82%、通常将棋86%で描画します。8pxのドラッグ閾値、盤外・取消・Escape、成り選択、局面更新時の解除、重複送信は純粋関数とDOMの状態テストで確認します。操作可能な盤上・持ち駒はホバーで画像だけが2px浮きます。選択中はホバーが外れても同じ高さを保ち、解除後は元へ戻ります。通常将棋・四人将棋で共有する `shogiPieceLiftClasses` は相対配置の `top` だけで即時に位置を補正し、着手時のちらつき対策として、浮き上がりには画像の `filter`・`transform` とその遷移を使いません。ドラッグ中は元画像を隠し、取消後に復元します。持ち駒の枚数は送信前に変更しません。選択・ドラッグ中は合法候補を緑、三人攻撃禁止候補を同寸の赤い丸で示します。禁止候補だけの駒・持ち駒も選択可能ですが、着手・成り選択・送信の判定は合法手だけを使います。合法な成り／不成がある移動先は緑を優先します。

成り選択は盤上へ重ね、左が成り・右が不成、駒画像は盤上と同寸にします。移動先ボタンの実測中心に2枚の境界を合わせ、盤端では全体を盤内へ寄せます。画面全体の透明なクリック受けで、選択外のクリック・タップは成りだけを確定します。成りボタンへ初期フォーカスを移し、Tabで二択を移動、Enter・Spaceで確定、Escapeで取消して移動元へフォーカスを戻します。

`useShogiPromotion` は未確定の移動元・移動先と部屋世代・本人・局ID・局面revision・陣営を `sessionStorage` に保存します。接続待ちで削除せず、認証と最新合法手の確認後、成り・不成の両方が合法な場合だけ復元します。確定・取消・局面更新・次局開始・脱落・資格変更、破損値、保存失敗と同じタブの再読み込みをBun＋happy-domのhookテストで検証します。

直前手は移動元の暗い茶色の背景と移動先の枠を描き分けます。マス装飾はマスボタンの内側に描き、1 CSS pxの罫線と4つの目印を上に重ねます。装飾と駒はポインター入力を透過します。ドラッグ終了時はポインター直下にある現在の盤のボタンを取得し、クリックと同じ基準座標のマスに着手します。

767px以下の `FourShogiBoardLayout` は、盤面タブのコンテナ幅と高さから盤幅を決めます。四人将棋ではカード2段（各48px）・持ち駒2段の固定余白・4つの2px間隔を差し引き、正方形の盤と持ち駒2段の駒画像の比率で残り高さを割ります。持ち駒の上下paddingは1px、ボタンの高さは駒画像＋2pxで、枠線を合わせた固定分は1段6pxです。横幅が十分でも高さが足りなければ盤だけ中央で縮小し、カードと持ち駒領域の幅は維持します。通常ルームと保存棋譜の両方にこの配置を使います。

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

`@tetraboard/four-shogi/replay` の [replay.ts](../packages/four-shogi/src/replay.ts) は、着手・外部脱落・引分提案のイベントを既存エンジンへ適用します。Webの棋譜再生もこの裁定を共有します。

### 四人将棋の引分提案

エンジンの `setDrawProposal(state, side, proposed)` は自手番の生存者の提案・取消を処理します。`drawProposals: readonly Side[]` を保持し、全生存者の同意で終局理由 `agreement` を返します。提案操作では手番・盤面・手数・直前手・千日手回数を変えません。着手・外部脱落による自動処理の後は、通常終局を優先して残った生存者の同意を再判定します。

WebSocketの `room.game.draw.set` は `proposed`・`roundId`・`positionRevision` を必須にし、本人・局ID・revision・期限・生存・手番を検証します。変更時だけrevisionを進め、`drawProposal { side, proposed }` イベントと状態を同じトランザクションで保存・配信します。変更なしは送信者へ最新スナップショットを返します。`advanceShogiClock` の `turnEnded: false` を使い、現在の時計と期限を維持します。更新前のCPUジョブは破棄します。

CPUの同意判断は人間／CPUを識別できるルーム側で行い、CPU着手の公開APIは維持します。現行Lv1/Lv2の各CPUの手番で人間全員の提案状態に合わせて提案・取消し、終局しなければ通常の思考・着手を続けます。人間が0人の場合は提案しません。D01に従う専用AIの限定試用は代替時も自動同意・自発提案を行いません。

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
| ルームでの選択保存とAlarmによる適用        | [four-shogi/progress.ts](../apps/worker/src/adapters/room/games/four-shogi/progress.ts) |

ルーム連携の変更では [ルームの実装の入口](#ルームの実装の入口)と[ルームの仕様](specs/room.md#維持する契約) を確認します。ルール状態・通信・保存形式との境界を維持し、思考中の履歴を永続化しない注意点は正本と実装の両方で照合します。

関連確認は [CPU探索](../packages/four-shogi/test/cpuSearch.test.ts)、[評価](../packages/four-shogi/test/cpuEvaluation.test.ts)、[手筋](../packages/four-shogi/test/cpuTactics.test.ts)、[序盤候補](../packages/four-shogi/test/cpuOpenings.test.ts)、[オンラインルーム](../apps/worker/test/) のテストを使います。パッケージ全体は `bun run --cwd packages/four-shogi check`、ルーム側は `bun run --cwd apps/worker test test/fourShogiRoom` で部分確認します。比較条件・測定対象コミット・結果と限界、再測定手順は [四人将棋AIの測定・採用記録](four-shogi-ai.md) を参照します。

## 軽量テスト

純粋関数は既存のBunプロセス、React部品・hookはBun＋happy-domの別プロセスで実行します。Workerは従来のCloudflare環境で実HTTP・WebSocket・D1・R2を検証します。

### 将棋の画像準備と駒表示

`shogiImageStore.ts` のURL別ストアは `idle / loading / ready / error`、準備Promiseとデコードした `Image` を保持します。同じURLの準備要求をまとめ、`decode()` 成功かつ `complete` と有効な画像寸法を確認して `ready` にします。成功・失敗はページ内で保持し、失敗の自動再試行はしません。再読み込みで新しく準備します。

`ShogiPiece` は `useSyncExternalStore` で現在のURLの準備状態を読み、準備済みなら初回描画から画像を表示します。移動先への再マウントでも画像要素ごとの `decode()` を繰り返さず、代替文字へ戻りません。準備中・失敗時は同寸法の駒名を表示します。表示用画像要素自体の失敗はその要素だけ文字へ戻し、URL変更後や別要素へ持ち越しません。URL別の購読とURLをkeyにした描画で、旧URLの完了やアンマウント後の通知から現在の表示を守ります。PNGと駒名は `shogiPieceImages.ts` で管理します。

`FourShogiBoardLayout` のマウント直後に、木目画像1枚と上下各9種類の駒画像、計19画像をブラウザ既定の優先度で一括準備します。現在の盤面のデコード完了は待ちません。参加・観戦・再戦・ルーム内棋譜・保存済み棋譜で同じ仕組みを使い、表示・通信・操作・時計は準備を待ちません。ロビーの装飾盤面は専用WebP画像だけを表示し、ルームの盤・駒画像は入室時に準備します。リバーシやアバター・効果音は対象に含めません。

`shogiComponents.test.tsx` は偽の画像loaderで全19URLの準備・重複排除・成功と失敗の保持、移動直後の画像表示、初回準備中・失敗時の文字、旧URLの完了と購読解除を確認します。捕獲・打ち駒・成り後の盤面と持ち駒、ドラッグ、成り候補、回転・再戦・棋譜相当の再表示も共有状態で確認します。実デコード・実描画・低速回線は自動検証に含めず、iOS Safariで参加・観戦時の着手と画像表示を手動確認します。

### 着手の演出

仕様は[ルーム仕様](specs/room.md#着手の演出)を参照します。`roomBoardMotion` は接続中の局と手数を表示へ渡し、`useBoardMotion` は確定した描画同士を比較します。共有将棋盤は `boardRef` と各駒の `data-board-piece` だけを公開し、編集用の盤面や保存棋譜では演出を起動しません。リバーシの反転色は `effects.css` の石のグラデーションを参照します。

演出の完了をゲーム状態へ反映せず、Web Animations APIで表示要素だけを動かします。盤面変更・回転・切断・画面の非表示・動きを減らす設定への変更・アンマウントで再生中の演出を解除します。同じ駒配置を確定する通知では先行表示の着地を継続します。

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

テスト結果は通常CIのログへ出力し、HTML・スクリーンショット・traceのレポートartifactは生成しません。デプロイに使う `web-production-<コミットSHA>`・`web-development-<コミットSHA>` のビルドartifactは維持します。

既存のWorker E2Eと専用SQL・Playwright設定は削除します。実APIの権限・再送・保存・CPU・閉鎖は通常のWorker統合テストで確認します。画像変換は入力検証と状態・出力境界をDOMテスト、WASMの同一origin asset参照はビルド時の検証、assetへのHTTP転送はWorkerテストで確認します。既存のPlaywright依存は維持します。

## Code Principles

C#/.NET標準ライブラリのような、一貫性があり読みやすいコードを目指します。

過度な抽象化より、意図が明確なコードを優先します。

### ファイルと関数の長さ

`apps/worker` と `packages/contexts` では、実装のファイルを 300 行以内、関数を 60 行以内、テストのファイルを 500 行以内にします。空行とコメントも数えます。`bun run lint` が oxlint で検査します。

今これを超えているファイルは、`.oxlintrc.json` の規則ごとの例外一覧に載っています。一覧には足さず、ファイルを分けたら外します。規則を満たしたファイルが一覧に残っていると、`bun run lint` が外すよう求めて失敗します。

## Webの編集先

ロビーとルームでは `@heroui/react` v3と `@heroui/styles` を使います。スタイルの生成にTailwind CSS v4、`@tailwindcss/vite`、HeroUIのアニメーションに `tw-animate-css` を使用します。導入は通常の `bun install` に含まれ、追加のセットアップは不要です。

ナビゲーションは共通の現在地表示を使います。
`main.tsx` から `shared/heroui.css` を一度だけ読み込みます。このCSS内でTailwindのtheme／utilities、HeroUIの必要な公式スタイル、`shared/theme.css` を同じ生成単位として読み込みます。テーマを別のCSS入口に分けると独自色のutilityが生成されないため、読み込みを分割しません。Tailwindの全体リセットは使わず、最小リセットと共通テーマをロビー・ルーム・Portalに適用します。

共通部品は `shared/ui/` の `AppAvatar`、`AppHeader`、`AppButton`／`AppButtonLink`、`AppTextField`、`AppCard`、`AppDialog`、`AppTabs`、`AppIcon` です。HeroUIのprops・ref・キーボード操作を引き継ぎ、繰り返す見た目は部品内のTailwindクラスへ集約します。`AppButton` は `appearance`（primary／secondary／quiet／danger）と `size`（default／compact）、`AppDialog` は `size`（default／compact）で用途を指定します。`AppTextField` はLabel・Input・Description・Errorを組み合わせ、入力プロパティとrefはInputに渡します。フィールド単位のErrorはTextFieldの `isInvalid` とともに使い、フォーム全体の通信エラーは独立したalertに表示します。

`AppSelectTrigger` は時間設定で共有し、全幅・最小高さ44px・縦中央揃えを指定します。HeroUIの `Select.Trigger` のprops・ref・状態に応じたclassNameを引き継ぎます。棋譜の局面Selectは専用の寸法を使います。

`AppPageState` は既存のロビー背景とゲーム別テーマを使った画面中央の共通配置、`AppPageLoading` はスピナーとstatus文の表示です。ルートの初回fallbackとゲーム別viewのSuspense、ルーム・棋譜のエラーに使います。データ取得前は共通テーマ、取得後はloaderのゲームを使います。

`AppRouteErrorPage` は親ルートの共通エラー境界、`AppErrorPage` はProviderに依存しない復旧表示です。`main.tsx` の先頭で `installPreloadRecovery` を読み込み、ルーター初期化前に `vite:preloadError` を登録します。`preloadRecovery` は通知された `event.payload` を記録して識別し、`preventDefault()` は呼ばず既存のエラー境界へ伝播させます。ルーム・棋譜の境界も通知済みエラーを共通表示へ渡し、将棋棋譜loaderは通常の503へ変換しません。通常のAPIエラー・404・410は既存の案内を維持します。

自動更新はエラー画面の描画後、初回ロビーでは起動失敗が確定してから実行します。イベント受信直後には実行しないため、遷移先のURLを更新できます。専用の `sessionStorage` キー `tetraboard:preload-recovery:auto-reloaded` を保存できた場合だけ自動更新し、タブを閉じるまで一度に制限します。成功や手動更新でも記録を解除せず、読取・書込不可なら手動案内にします。初回ロビーでは紹介HTMLを残し、再読み込みリンクにも現在URLを設定します。

`preloadRecovery.test.tsx` のBun＋happy-domテストは両ロビーへのURL確定後の更新、文書をまたぐ上限、重複通知・StrictMode・保存領域失敗、ルーム・棋譜のReact.lazyと棋譜loader、CSS preload失敗、通常例外、紹介HTML保持と手動更新を確認します。実際の旧タブを開いたまま新版を配信する経路は手動確認し、未実施ならPRに明記します。公開HTMLの200・304と再検証キャッシュはWorkerの `publicAssets.test.ts` で確認します。旧チャンク保持方式や管理画面の復旧処理は変更しません。

`AppButton`／`AppButtonLink` の `isPending` は元の内容を配置・読み上げのために残し、見た目だけを中央のHeroUI Spinnerに置き換えます。非同期操作の完了・失敗・中止は既存の通信状態で管理します。初回・自動取得と手動の更新／再試行は `pendingSource` で区別し、共有リクエストの複数の入口では操作元を指定します。CPU操作はtransportの `pendingSettingsCommand` を参照し、設定全体のロックで他のボタンまでスピナーにしません。Context／Providerの配置と通信契約は維持します。

PCのルーム画面と保存済み棋譜は `RoomLayout` に `statusBelowBoard` を渡し、`RoomBoardStatusProvider` で状況カードを盤面へ渡します。各ゲームの盤面は共通の `RoomBoardGroup` を使い、状況カードを最後のグリッド行に置き、盤面と同じ幅を基本に、盤面が狭い場合は最大320pxまで操作の幅を確保し、盤面・プレイヤーカード・状況カード全体を上下中央に配置します。カードの実高さを `ResizeObserver` でCSS変数へ渡し、盤面の高さ計算からカードと間隔・上下paddingを差し引きます。PCのライブ盤面では盤幅の下限を外し、縮小時に下限幅がスクロールを生むことを防ぎます。自動パスの通知もグリッド行へ入れて高さを確保します。右列はルーム情報とチャットで高さを使い、スマホ・タブレットでは状況カードをタブの上に置きます。保存済み棋譜ではスマホ・タブレットで局面操作を状況カードに置き、PCでは盤面領域の右下に独立して配置し、棋譜操作の高さを確保して状況カードとの重なりを防ぎます。ライブ対局と保存済み棋譜の状況カードは `RoomStatusCard` で高さをそろえます。初回待機の表示は `RoomViewShell` から `RoomBoardStatusProvider` を経由して盤面のグリッド領域に重ねます。

`RoomChat` は現在の `room.players` から送信者IDで画像を選び、共通の `AppAvatar` で表示します。名前・時刻と本文を右列に並べ、左列の34pxアイコンは2行をまたいで配置して上端を名前の上端にそろえます。CSS Gridで並べます。本文の1行を20px・上下余白を計14pxにし、1行の吹き出しとアイコンの高さをそろえます。複数行でもアイコンは34px固定です。名前が同じでも他人の画像を使わず、退室済み・画像なしの発言は仮アイコンにします。通信・保存データは変更しません。

`RoomViewShell` が共通の `RoomSettingsDialog` を開き、`RoomInfo` は起動ボタンだけを配置します。ダイアログのPortalで表示するため、設定の項目数はチャットや盤面の高さに影響しません。`RoomModeSetting` はルーム作成と設定のカード選択を共用し、CPUレベルはquietボタンの `CpuLevelSelector` で薄いテーマ色のホバーを使います。モード・時間・CPU一覧・三人攻撃禁止／禁手はダイアログ内で下書きにし、キャンセル時は破棄します。ログインホストの最初のCPU追加は `useCpuAddition` と共通の注意文を使い、適用時に同じダイアログ内で確認します。

`room.settings.apply` は `expectedPublicUpdatedAtMs` と全設定・希望CPU一覧を一度に送ります。既存CPUのUUIDを維持し、新しいCPUは `playerId: null` とします。protocolで重複ID・値を検査し、Workerの `prepareRoomSettings` で待機状態・編集版・ゲーム固有の項目・CPUの存在・定員を検査してから、GameRoomの一つの `withIndexTransaction` で保存・チャット通知・公開索引を更新します。失敗時はどの項目も反映しません。時間・モード・固有設定が変わる場合の準備解除とCPU変更時の既存方針、前局の棋譜を維持します。旧画面の個別設定コマンドも引き続き受け付けます。

Webの送信ロック・タイムアウト・再接続は既存transportを使います。`commonSettingsComplete` で全項目と追加CPUのレベルを照合し、確定後だけダイアログを閉じます。失敗時は下書きを保持します。編集中の公開更新日時が変わった場合は「設定を読み直す」で最新情報から下書きを作り直し、古い版での上書きを防ぎます。`roomSettingsPresentation` の無効時の透明度保持を適用中だけ使います。

ロビー・ルームともページ別CSSと移行用ラッパーは撤去済みです。各部品のTailwindクラスを編集し、状態別クラスは静的な対応表にします。共通の見た目は `shared/ui/` に集約し、ゲーム固有の `PlayerCard`・`Stone`・`RoomClock`・`ReplayCard` はfeature側に置きます。`AppCard` の `density="compact"` はルームの狭い領域向けの余白です。`AppActionCard` と `AppSectionHeading` は操作カードと見出しの共通表現です。

CSSを追加できる範囲は `shared/theme.css` の共通テーマ／最小リセットと、`shared/effects.css` の背景・石の陰影・アニメーションです。`shared/heroui.css` は読み込み専用です。特定ページのレイアウト、通常の色や操作状態をCSSへ戻さず、同じTailwindクラス群を複製しないで共通部品を使います。Preflightを導入せず、box-sizing・margin・border幅など必要な最小リセットを共通テーマにまとめます。

ロビーなどのページはルート単位で遅延読み込みします。ルームと棋譜は静的に登録したloaderを実行しながら、画面とエラー境界を遅延読み込みします。ビルドでは[初回JSの検査プラグイン](../apps/web/build/initialJsBudget.ts)が、ロビー・ルーム・棋譜ごとにBrotli圧縮後のサイズと上限を照合します。

ダイアログのフォーカス制御・Esc・スクロール抑止はHeroUIのModalに任せ、送信中は閉鎖を無効にします。背景全体のぼかしだけを共通CSSに残し、閉じるボタンの寸法・位置、Visual Viewport内のスクロールは共通部品のクラスで指定します。

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

`AppRadio` はHeroUIの共通ラジオ部品です。`Content` 内に `Control` と文字を置き、丸・文字・余白が同じクリック領域に入るようにします。未選択の丸は白背景と `text-muted` と同じテーマ色の1px枠線を使い、選択色・フォーカス・無効化はHeroUIに従います。作成・CPUと遊ぶ・待機ルームの対局形式と三人攻撃禁止に適用します。設定payload・送信待ちのロックと解除は部品・hookのDOMテストで確認します。

`RoomViewShell` を配置基準にし、接続中・再接続中と同じ帯に出る操作エラーを絶対配置します。安全領域から8px、ルーム中央、最大幅480px・左右8px以上の余白とし、長文は帯内で折り返します。通知は `pointer-events: none` と `z-index: 10` を使い、ダイアログ・Select候補より下に重ねます。既存の `role=status`、文言、表示条件、再接続hookは保持します。接続・再接続・操作エラーの状態遷移と文言はDOMテストで確認し、矩形差や中央配置の実ブラウザ検証は自動検証から外します。

## 棋譜の確認

将棋の表記仕様はREADMEと両将棋のルール正本に置きます。`shogiNotation.ts` はエンジン実装を読み込まず、固定座標・駒名・同・成／不成／打・方向語・読み上げ名を生成する純粋なWeb表示処理です。各ゲームの再生アダプターが着手前の駒と直前手、既存エンジンの合法手を渡します。四人将棋だけ、通常の補助語で区別できない龍の縦移動に直・直上・直引を使います。盤上移動だけ候補を一度取得し、成り可能性と曖昧さの判定で共有します。

`fetchEventReplay` の `createFrame(after, transition?: { before, event })` は開始局面でtransitionを省略し、各イベントでは適用前の状態とイベントを必ず渡します。ページをまたいでも状態を保ち、提案・取消・外部脱落で直前手を更新しません。ルーム内・本人・公開棋譜の取得処理と再生ルール・保存JSONは維持します。通常将棋のframeの任意 `accessibleLabel` は先手・後手を明記し、`ReplayCard` の選択値と候補へ渡します。見た目のlabelは▲・△のままです。

既存の固定棋譜JSONとチェックポイントは書き換えません。Webの互換性検証は旧表示labelを除いた全フレーム情報とイベントを比較し、新表記は別の固定期待値で確認します。期待値をテスト実行時に再生成しません。`shogiNotation.test.ts`・`shogiNotationReplay.test.ts` は全81座標・駒名・合法手候補・禁止手・全4方向／両モード・同のページ境界・入力不変を、DOMテストはSelect候補・読み上げ名・選択と回転を確認します。画面の収まりとネイティブ入力は手動確認としてPRに記載し、ブラウザ自動テストは追加しません。

スマートフォンの両ゲームのプレイヤーカードは、文字・アバター・下段情報の寸法を維持し、上下paddingを1px・高さを48pxに固定します。盤面だけの縮小ではカード寸法を変えません。リバーシの `RoomBoardLayout` はカード2段と2つの2px間隔を空き高さから差し引き、横幅との小さい方を正方形の盤幅にします。自動パス通知がある場合は15pxの行高と2pxの間隔も確保します。通常ルーム・保存棋譜の両方で低い画面にも4席を収め、名前・下段情報とカード枠の間は各2px（枠線1px＋padding1px）とします。

棋譜は新しく開始した対局から記録します。CPU対戦または4人の対戦を終局させ、最終局面が自動で選ばれること、開始局面・着手・自動パス・各種脱落をSelectと左右ボタンで確認できることを検証します。待機中の準備・設定・入退室・チャットで閲覧局面をリセットしないこと、再読み込みと再接続で復元すること、次局開始で解除されることを確認します。古い対局は最終局面のみの表示になります。
PCでは盤面領域右下、タブレット・スマートフォンでは状況カード内へ配置します。タブ切替後の局面保持と先頭・末尾でのボタン無効化を軽量テストで確認します。Workerテストは棋譜と実際の盤面の一致・パス・CPU着手・脱落原因・再取得・次局の記録更新を、Webテストは局面ラベルと自動パスの分割を検証します。表示は `ReplayCard.tsx`、選択状態は `useRoomReplay.ts`、項目の生成は `replayFrames.ts` を編集します。
両ゲームの `ReplayCard` は選択値・候補を一行で表示し、幅不足時のみ省略記号を使います。候補の `textValue` は全文を保持し、矢印・選択マークの幅と画面内の候補領域を確保します。将棋の `createFourShogiReplayFrame` は着手または外部脱落の短いラベルだけを生成し、詰み・合法手なし・同時脱落・順位の説明を付加しません。`game.eliminations` と全局面・結果は保持し、通常ルームと保存済み棋譜で同じframe生成を使います。打ち駒・成り・投了・パス・退室・時間切れ・通信切れ・同時詰みを確認し、ラベル短縮後も局面数・順位・脱落理由が変わらないことを検証します。
スマートフォンの再戦待機では320px幅も含めて状況カードの操作を一行に収めます。ルーム内の棋譜は直上のパネルを開閉し、保存済み棋譜では前後ボタンとSelectを状況カード内に並べます。

## ルーム共有の実装

利用者向けの仕様と維持する契約は[ルーム共有の仕様](specs/room-sharing.md)、受け入れの確認は[テスト方針](testing.md#ルーム共有の確認)にあります。

- 軽量な `@tetraboard/protocol/room-sharing` に共有URL・募集文・募集可否・メタ情報を集約します。エンジン・Zod・Reactへ依存しません。
- `useRoomEntry` は通常作成の成功時だけ `roomShareIntent` を作成してルーターのstateへ渡します。nonceをメモリに保持し、作成者・世代・ホスト資格を照合します。`useRoomInvitation` の初期表示後に意図を消費するため、StrictMode・履歴stateの複製でも初回表示を保ち、戻り・再読み込みでは再演しません。共有URLにはこの意図を含めません。
- CPU戦の後の「友達と遊ぶ」（TB-201）は、`InviteAfterCpuButton` から `handleLeaveClick("friend-room")` で退室し、`shared/friendRoomIntent.ts` のnonceをルーターのstateでロビーへ渡します。依頼（設定、押したときの `profileId` と同意版）はメモリにだけ置き、`useFriendRoomEntry` が最初に表示したロビーの履歴項目に結び付けて、nonceを消してから1回だけ作成します。再読み込み・戻り・ロビーを離れた後は作成も自動の入室もせず、`useRoomEntry` は作成直前の認証が押したときの本人と一致するときだけ送ります。DOMテストは `autoGameResult.test.tsx` です。
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

## プライバシーの入口

利用者向けの仕様は [プライバシー・利用規約・退会](specs/privacy.md)、運営と障害復元の手順は [runbooks/privacy.md](runbooks/privacy.md) にあります。2026-10-12 の実装計画（Goal、Done When、コミット計画）は、実装が終わったので TB-150 で消しました。経緯は Git 履歴にあります。

コードは ADR 0010 の形に分かれています（TB-150）。

- `packages/contexts/privacy/src/domain/`: 規約の版の照合（`consent.ts`）、退会の受付の資格と状態（`deletion.ts`）、退会者の表示名と伏せ字の規則（`identity.ts`）。純粋な関数です。
- `packages/contexts/privacy/src/use-cases/`: 退会の再認証（`deletionReauthentication.ts`）、最終確認（`deletionConfirmation.ts`）、退会のジョブの進め方（`deletionJobs.ts`）、規約と OAuth の同意（`legalConsent.ts`）、棋譜の参加者の伏せ字（`redactParticipants.ts`）。テストは同じパッケージの `test/` です。
- `apps/worker/src/adapters/privacy/`: D1、R2、退会の Cookie、プロバイダーの連携解除の実装。退会済みかの判定 `isDeleted` は `identity.ts` です。
- `apps/worker/src/flows/accountPurge/`: 退会の受付（`requestDeletion.ts`）と、各文脈の表を消す段階処理（`processDeletions.ts`、`purge.ts`）。文脈をまたぐので flow に置きます。
- `apps/worker/src/routes/`: `deletionRoutes.ts`、`legalRoutes.ts`、`legalHtml.ts`、`privacyInput.ts`。
- 退会の受付（`requestDeletion.ts`）は、`deleted_accounts` への INSERT と同じ D1 batch で、フィードバックの非表示、ルームの索引のホストと参加者の伏せ字、画像の削除の予約、棋譜の引き継ぎの失効と伏せ字、保存済みの棋譜（公開済みと保存待ち）の伏せ字、履歴の索引とセッションの削除、プロフィールの匿名化を行います（TB-151）。各表への文は、その表の文脈の adapter（`adapters/privacy/deletionRequest.ts`、`adapters/community/feedbackDeletion.ts`、`adapters/room/indexDeletion.ts`、`adapters/account/deletionWrites.ts`、`adapters/record/privacyScrub.ts`）が作ります。`deleted_accounts` への INSERT の場所と、batch がこれらの文を伴うことは `test-bun/deletionWriteBoundaries.test.ts` が確かめます。同じ働きの古いトリガー 6 個は TB-155 で消しました。毎時の退会の処理も、未完了の退会について同じ処理を冪等にもう一度行います。バックアップから戻したときは、台帳の行を未完了として入れ直すと、毎時の処理が伏せ字と削除をやり直します（[runbooks/privacy.md](runbooks/privacy.md)）。
- 退会の受付は、すべての `room_index` を削除の対象のルームに登録します。migration 0014 より前に退室し、保存待ちの棋譜だけが Durable Object に残った人は、既存の索引（`privacy_room_accounts`、`privacy_room_players`）では見つけられないためです（TB-151 で調べ、`deletionRoomTargets.test.ts` で再現）。
- ルームの索引（`room_index`）への INSERT と更新は、退会したホストと参加者を、同じ SQL の中で伏せ字にします（`adapters/room/indexScrub.ts`、TB-153）。退会の受付のときの伏せ字（`indexDeletion.ts`）も同じ式を使います。書き込みの場所は `test-bun/roomIndexWriteBoundaries.test.ts` が確かめます。同じ働きの古いトリガー 4 個は TB-155 で消しました。伏せ字の検査が引く `privacy_room_players` の `(room_id, instance_id, player_id)` の索引も TB-155 で足しました。
- 古い版が Durable Object に残した、世代 ID（`instance_id`）のない索引の再送待ちは、Alarm が送る前に DO の今の状態を確かめます。ルームが動いていれば今の情報で新しい版を出し直し、ルームがなければ空の公開行だけを閉じます（`adapters/room/indexJob.ts`、TB-147）。そのため、`instance_id` が NULL の公開行は新しくできません。一覧の取得のときの NULL の行の補完は、既にある行のために残しています。
- 閉じたルームの索引の削除は有効です。実装は `adapters/room/roomIndexRetention.ts` にあります（migration 0054、TB-157）。毎時 25 件まで、期限切れの行と閉じた時刻が不明で初回確認の記録もない行を DO に確認します。毎時のログ（`Room index retention`）には、この 2 種類の行の件数と DO への問い合わせ結果を記録します。DO を起こすと、まだ済んでいない DO では旧計測の保存待ちの掃除（`purgeLegacyAnalytics`、TB-51）が走ります。DO はルームの本体も保存待ちもなく、処理中の作業がなく、索引の版が一致すると `ready` を返します。DO が `ready` を返した行には、閉じた時刻が不明で初回確認の記録もなければ初回確認時刻（`closed_observed_at_ms`）を記録します。閉じた時刻または初回確認から 30 日が経過し、DO が `ready` を返した行は、番号と版を台帳（`room_index_deleted_revisions`）に記録するのと同じ D1 batch で削除します。索引の書き込みは台帳の版以下を拒み、退会の受付は台帳の番号も削除対象に登録するため、索引を削除したルームも退会処理の対象に含まれます。`scheduledMaintenance.ts` には点検を切り替える定数 `roomIndexRetentionInspectionEnabled` も残っています。
- 退会のフェンス（退会したアカウントの行を書かせない）のうち、フィードバック、通知（既読、状態、イベント）、バッジ、履歴、棋譜の引き継ぎの 10 個は、各 adapter の書き込みの条件で行います（`db/deletionGuard.ts` の共通の条件、TB-154）。書き込みの場所と条件は `test-bun/communityRecordDeletionFenceBoundaries.test.ts` が確かめます。
- 退会のフェンスのうち、席（`account_room_seats`）、プライバシーの索引（`privacy_room_accounts`、`privacy_room_players`）、大会のエントリー、退会の確認の回数の上限の 5 個は、各 adapter の条件つきの INSERT で行います（TB-158）。大会のエントリーは、同じ batch の中で `account_deleted` を返して取り消し、今までの 403 の応答を保ちます。書き込みの場所と条件は `test-bun/tb158WriteBoundaries.test.ts` が確かめます。
- 退会と伏せ字の古いトリガー 34 個は、TB-155（migration 0056）で消しました。この節の条件とテストが唯一の守りです。better-auth の表（`account`、`session`、`user`）のフェンス 4 個は、トリガーのまま残します（[ADR 0010](adr/0010-contexts-and-shell.md#移す順序)）。
- ルームのイベントごとの退会の確認（`deletion_rooms` を `room_id` で引く）は、索引 `deletion_rooms_by_room`（migration 0027）を使います（C09）。

### 保存する情報と退会の扱い

公開文書の本文・版は [privacy.ts](../packages/protocol/src/privacy.ts)、画面は [privacy/](../apps/web/src/features/privacy/)、初回HTMLは [legalHtml.ts](../apps/worker/src/routes/legalHtml.ts) にあります。OAuth開始と成功したコールバックの同意を結び、登録者はD1に版・日時を保存します。登録・参加・初回設定の操作時に現在版を送信し、同意チェックや端末の同意保存に依存しません。参加APIも現在版の確認を要求します。説明は `LegalNotice`、リンクは `PrivacyLinks`、登録ボタン群は `SocialSignInButtons` で共用し、文書リンクは別タブで開きます。プロフィール設定前でも規約と退会ページを読めます。

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
| 計測Cookie・利用イベント | Cookieはブラウザ、イベントはAnalytics Engine、KPIの月次値はD1 `kpi_monthly`。管理者だけ | Cookie最大1年、イベント3か月。月次値はIDを含めず保持 |
| フィードバック本文・画像・技術情報・編集履歴・投稿者HMAC           | D1 `feedback*`、R2 `feedback/`。管理者だけ                                                   | 180日、退会で原文・画像・履歴・本人由来の制限キーも削除。旧HMAC形式と新account列を照合。削除後の画像再送も削除キューへ戻す               |
| 削除済みID・旧部屋世代とプレイヤーID・受付／完了時刻・資格ハッシュ | D1 `deleted_accounts`・`privacy_room_players`。非公開                                        | 再送・復元による復活防止のためサービス運営中。メール・プロバイダー識別子・名前・画像を含めない。作業中の画像・解除トークンは完了時に除去 |
| 障害ログ・提供者バックアップ                                       | Cloudflareの実設定、提供者の管理機能                                                         | 保存先・処理先・保存期間は公開前に実設定を確認。復元前に削除台帳を確保して再適用。利用者の端末や第三者の保存は遠隔消去できない           |

認証ライブラリのログ出力を停止し、アプリ側でも障害の種類だけを記録してOAuth応答・トークン・メールを記録しません。HTTPSの `__Secure-` 認証Cookieも同意・再認証・失効の対象です。

Googleの要求は `openid email profile`、`access_type=online`、Discordは `identify email` です。退会と画像アップロードの競合では先にアップロード待ちをD1へ登録し、受付が新しい画像の削除先も取得します。進行中は削除を完了にせず、終了または10分の中断判定後に回収します。期限後に遅れてアップロードが終わった場合も削除キューへ戻し、失敗した画像削除を再試行します。

OAuthトークンは認証ライブラリで暗号化して保存し、解除時も暗号化形式だけを復号します。2026-11-06に本番・開発の平文候補と退会待ちの平文取消トークンが0件であることを再確認し、平文の定期移行と受理を撤去しました。古いバックアップの復元時は公開前に欠落公開IDと平文候補を検査し、旧版の移行処理を隔離環境で実行して0件を確認してから現行Workerへ渡します。解除用の暗号化キーを、未完了ジョブがある間に破棄しません。現行のトークン取扱いは [Google OAuthポリシー](https://developers.google.com/identity/protocols/oauth2/policies) と照合しています。

退会APIの入口は [deletionRoutes.ts](../apps/worker/src/routes/deletionRoutes.ts)、受付は [requestDeletion.ts](../apps/worker/src/flows/accountPurge/requestDeletion.ts)、段階処理は [processDeletions.ts](../apps/worker/src/flows/accountPurge/processDeletions.ts) です。`POST /api/account/deletion/reauth` →同じproviderのコールバック→ `GET /api/account/deletion/confirmation` → `POST /api/account/deletion/confirm` を使います。challengeはHttpOnly Cookie、同じ本人・新しいセッション・OAuth state・provider・10分期限を照合し、開始を1分5回までに制限し、取消や在室拒否でも直近の試行回数を消しません。削除対象をflowで固定し、別人で再認証した後に対象を切り替えません。手続きの取消は `POST /api/account/deletion/cancel` を使い、アカウントを削除せず確認資格を失効させてflowを破棄します。最終操作は同一Origin・`confirm: true`・一回用challengeと在室の再検査が必要です。202で受付資格を返し、セッションを失効させた後は `POST /api/account/deletion/status` が資格ハッシュで状態だけを返します。

## ゲストアカウント（#234）

利用者向けの正本はREADMEの「ゲストアカウントの確定仕様」です。ゲストの作成と名前変更は account の文脈の `use-cases/guestAccounts.ts`、専用HttpOnly Cookieとルートは `routes/guestRoutes.ts`・`guestSession.ts` が担当し、公開チャットでも名前確定時だけ作成して閲覧では作成しません。`guestNameCustomized` と `isAnonymous` を使います。`guestUsernames.ts` はゲストの表示用IDの生成と衝突判定を担当します。作成時に表示用ID・アカウント・本人資格・同意を同じD1 batchで確定し、IDの一意制約への衝突だけを再生成して再試行します。本人・現在プロフィール・ランキングの取得時には未設定IDを書き込みません。表示用ID、公開カード参照用UUID、内部IDは区別します。Webの `ensureGuestAccount` はCookieの読戻しと同一ブラウザの作成直列化を行い、保存不能・認証障害で参加を続行しません。旧クライアントのアカウントなし参加と終局後の1局取得は互換経路として維持します。

ゲストの統合と昇格（account の文脈の `use-cases/guestLink.ts`、`guestMerge.ts` と `flows/guestRegistration/guestLink.ts`）は、既存のOAuth stateとゲストCookie・認証後のsessionを結び付けます。新規連携では一時登録者のprovider・sessionを元ゲストへ移し、内部ID・表示用ID・記録を保って初回設定へ進みます。既存登録者への統合は本人の確認後にD1の単一batchで行い、プロフィールは統合先を優先します。マイページから連携する場合は参加中の席を退室し、大会待機を取り消します。終局後の結果からの連携は、同じ席だけを保持する専用の経路を使います。対局・大会の競合と別タブの再参加はDBのfenceで拒否します。

migration 0022は `guest_sessions.registered_at_ms` を追加します。登録者への認証成功後は、ゲスト資格を統合確認専用へ切り替え、登録セッションや引き継ぎ確認の期限切れでも本人認証に戻しません。既存のCookieが並存する場合も、登録者本人の取得時にこの状態へ移します。確認の辞退と登録者のログアウトではCookie・ゲストセッション・対応する全OAuth手続きを失効させ、元アカウント・記録は削除しません。OAuthの取消・失敗では切り替えません。辞退操作は認証した本人と元ゲスト資格の対応・同一Originを検査します。

migration 0023は過去の公開チャット投稿の送信者識別子を `sender_public_id` に保持します。`adapters/community/guestMergeWrites.ts` のSQLを統合と同じbatchに含め、投稿・再送台帳・通報を移します。送信時刻と投稿停止は両者の厳しい方を保持し、統合前の送信者識別子による運営操作は本人と統合済み別名へ適用します。統合より遅れて到着した投稿・通報は、SQLで統合済みゲストの参照を拒否します。退会処理と期限削除は統合前の送信者行も削除します。

migration 0021はゲストセッション、OAuth対応、統合済み内部IDの対応とfenceを追加します。統合は棋譜の本人参照・履歴索引・バッジ・大会参加者・プライバシー対応を一括で移し、ゲーム手順・日時・結果を変更しません。統合済みゲストの認証を失効させ、再送のため最小限の内部ID対応を保持します。遅延した棋譜保存・本人索引にもDB triggerで統合先を適用し、同じ参加の二重計上を防ぎます。大会のentry IDと得点イベントは保持します。統合時のフィードバックの本人参照は統合先へ移し、退会時の対象に含めます。登録者へ切り替わった日時は `guestRegisteredAt` とし、ゲストの作成日とは区別します。

管理は登録者専用の本人確認を維持し、公開チャットの投稿・通報はゲストの本人確認にも対応します。本人の戦績・履歴・バッジ・大会はゲストの本人確認にも対応し、ランキングと公開カードは公開用UUIDで参照します。ゲスト用認証情報はログや公開応答へ出しません。ゲスト作成はIPを秘密鍵付きでハッシュしたキーで毎分20回までに制限し、IPそのものをこの制限用DBに残しません。OAuth中に別タブの参加が届いた場合は認証応答を保ち、退室後に同じ本人対応で連携を再試行できます。統合先が退会した後も最小限の統合ID対応を残し、元ゲストの保存待ちを正規化・削除済みとして扱います。

## Google認証とアカウント移行

### 認証時のDB読み取り

`adapters/account/auth.ts` は認証インスタンスをリクエスト間で共有せず、`advanced.database.validateSchema: false` により実行時のスキーマ検証を無効にします。Better Auth 1.7.5の検証キャッシュはアダプター単位で、インスタンスを作り直すたびに `sqlite_master` と全表の `pragma_table_info` を読み直すためです。代わりに `authDatabaseReads.test.ts` が全migration適用後のローカルD1で同じ認証設定の検証を明示的に有効にし、HTTP・HTTPSの両方で整合性を確認します。スキーマの不整合は実リクエスト前のテストで検出します。既存のデプロイはmigration適用後にWorkerを配信します。

登録者セッションの確認は、通常名または `__Secure-` 付きの `tetraboard-2026.session_token` Cookieがある場合だけ起動します。ゲスト・計測CookieだけではBetter Authを初期化せず、ゲストは既存の専用認証へ進みます。空・改ざん・期限切れでも登録者のCookieが存在する場合は、別のゲストへ自動復帰しません。OAuth開始・コールバック・ログアウトの直接呼び出しはこの省略判定を通しません。セッションの期限更新・Set-Cookieの引き継ぎ・障害時の応答は維持します。

開発・本番反映後は、反映後だけのUTC時間帯を指定してD1 Insightsの全クエリを確認し、通常アクセスから上記2種類の構造確認SQLが発行されないことを確認します。スキーマ確認を意図して実行した操作は区別します。総読み取り量はアクセス量や管理集計にも依存するため、固定の削減率を受入条件にしません。ゲスト有効期限の更新頻度・管理集計・通知間隔はこの対応で変更しません。

### 自動アイコンとプリセット

ルームの初回名前入力では `RoomEntryDialog` と `RoomInvitationDialogs` の参加ダイアログがプリセットの下書きを持ちます。`RoomIdentityFields` はアイコン・44pxのシャッフル操作・変更結果の読み上げを共有し、`guestAvatar.ts` は現在の画像を除いた候補から選択します。閉鎖時はダイアログとともに下書きを破棄します。全6ゲームの作成・CPU・通常参加と招待／観戦からの参加は、選択IDを `ensureGuestAccount` の作成JSONへ渡します。`prepareRoomGuest` は保存結果を画面へ反映し、下書きと異なるプロフィールを別の操作が先に確定していた場合は入室前に再確認を案内します。大会・公開チャットは既存の名前入力を維持します。

`POST /api/account/guest` は任意の `avatarPresetId` を検証し、新規作成では名前・選択ID・本人資格・同意を同じD1 batchで保存します。名前未設定の既存ゲストも名前と選択IDを一つのUPDATEで確定し、設定済みへの変更を条件に含めて遅れた要求による上書きを防ぎます。設定済みの本人には保存済みプロフィールを返し、作成要求での名前・アイコン変更は行いません。選択IDを省略する既存の経路は固定の自動割り当てを維持します。

共通カタログ `packages/protocol/src/avatarPresets.ts` は6種類の固定UUID・表示名・画像名を定義します。v1の内部IDによる割り当てを固定し、`user.avatarPresetId` が未設定の既存ユーザーも取得時に解決します。migration 0027は選択用列と `account_room_seats.avatar_preset_id` を追加し、一括データ更新やR2コピーは行いません。

アップロード画像を優先する解決処理を全プロフィール表示で共有します。プリセットの固定UUIDは既存の `/api/avatars/<UUID>` と同じ形式で、WorkerのASSETSから `/assets/avatar-presets/v1/` のWebPを配信します。ASSETSのないHTTPのローカル開発では同一オリジンのViteの画像パスへ302で転送し、転送をキャッシュしません。プリセットを個人用 `avatarKey`・R2画像参照・削除待ちへ保存しません。アカウント応答の任意 `avatarPresetId` は実効値です。登録者のmultipartは `avatarAction=preset` とカタログ内IDを受け付け、removeはアップロードだけを解除します。ゲストの名前更新JSONも任意のカタログ内IDを受け付け、ID変更・画像アップロード指定は拒否します。

通常・大会の入室予約は実効プリセットを保存し、プロフィールの同時変更を検知します。入室済みの席は固定し、新しい入室だけ最新設定を使います。プリセット項目がない導入前の席は当時の表示を保持します。退会者・参照先なしへ内部IDからアイコンを補完しません。


### ひとこととお気に入りゲーム

`0028_profile_details.sql` は `user.profileMessage`（空文字）と `favoriteGames`（JSONの空配列）を追加し、旧INSERTと互換な既定値を持たせます。共通の `profileDetailsSchema` で改行なし・30書記素以内、既知のゲームID最大3つ・重複なしを検証し、ゲーム一覧順へ正規化します。ゲストの作成・名前更新APIでは新項目を拒否します。

登録者の初回設定・プロフィール更新multipartは `profileMessage` とJSON配列文字列の `favoriteGames` を受け付けます。全入力を画像アップロード前に検証し、既存項目と一緒にD1 batchで保存します。省略項目はSQLの `COALESCE` でDBの現在値を保持し、空文字・空配列は削除に使います。保存応答には更新後の値を返します。本人応答の追加項目は省略可能で、旧応答ではフォームが空欄で初期化します。

公開カードは `includeDetails=1` の場合だけ登録者の現在値を返し、指定しない旧Webへの応答形状を維持します。ゲスト・CPU・退会者には返しません。`ProfileDetails` をホバーカードとマイページで共有し、既存のアイコン・名前・IDの下に吹き出しとゲームのタグを並べます。タグには20px、選択ボタンには24pxの `LobbyBoardPreview` を影・回転なしで使います。`gameAccentClasses` が共通パレットの識別色を指定し、親のゲームテーマへ依存しない淡い背景・文字色を表示します。選択画面は2列（359px以下は1列）で、ゲーム色の枠とチェック・`aria-pressed` を組み合わせます。編集の保存・破棄・下書き保持・本人キャッシュ無効化は既存の共有フォームの仕組みを使います。公開項目の説明は規約・ポリシーにも追記し、既存の同意方式と版を維持します。

### 共通のアカウント連携ダイアログ

`RatingGrowthPreview` はレート戦の連携案内だけで使う独立した演出です。1秒のtimeoutを段階ごとに予約し、1600到達・unmount・動きを減らす設定で停止します。ゲーム切替では再作成し、通常の再描画では継続します。CSS keyframesは数字の小さな跳ねと増分の浮上だけに使い、固定幅と配置済みの余白でレイアウトを保ちます。`useSyncExternalStore` で端末の動きを減らす設定の変更を購読し、静止表示へ切り替えます。数値は演出用の固定値で、API・保存データ・公開レートと接続しません。

レート戦の未ログイン・ゲスト向け表示は[共通仕様](specs/matchmaking.md#未ログイン時のレート戦の連携案内)に従い、`RatedMatchmakingDialog` の中で `SocialSignInButtons` と `useSocialSignIn` を使います。新しいダイアログを重ねず、ボタン群は任意の `layout="vertical"` で縦に並べます。省略時は既存のレスポンシブ配置です。`registrationPath` は対象4ゲームの固定の `?matchmaking=1` 付きURLも許可し、任意のクエリ・ハッシュは許可しません。`RegistrationCompletion` の既存処理でプロフィール設定・統合後に復帰し、再検索のstateは付けません。認証開始中は閉鎖・戻る・履歴の戻るを防ぎ、失敗後に再操作できます。

`features/account/AccountLinkDialog.tsx` は機能名・テーマ・閉じる操作を受け取り、どの画面からも使える共通の連携案内です。任意の `beforeSignIn` と `beforeSignInNotice` で、事前処理とその説明を渡せます。任意の `destination` は既存の登録復帰情報で扱えるアプリ内の遷移先に限定します。Google・Discordの認証開始と同意表示を共用し、事前処理の失敗ではOAuthへ進みません。`onBusyChange` で親の操作・閉鎖をロックできます。

ゲストの `ProfileForm` は全プロフィール項目を表示し、制限操作から案内を重ねます。`saveBeforeLink` は名前・選択プリセットを保存してセッション表示・本人プロフィールのキャッシュを更新しますが、編集ダイアログを閉じません。通常の「保存」と取消の動作は維持します。案内は `AppDialog` の既存のModalスタックを使い、Escape・外側操作・フォーカスの復帰は最上段だけで処理します。案内を開く・閉じるだけでプロフィールを保存しません。本人の切替やunmount後の事前処理・OAuth応答から更新や遷移を行いません。Workerの権限・API・DBは変更しません。

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

マイページのページ枠は `AccountPageShell` の `layout="profile"` を使います。最大幅・左右余白は共通の `shared/ui/pageLayout.ts` にまとめ、ヘッダーと一致させます。プロフィールカードは本文の先頭に置きます。ゲーム切替は `AppButton` とロビーの盤面画像を共用し、選択中のボタンには `aria-pressed` を設定します。ボタンは横に並べ、画面幅に応じて折り返します。次の段にモードタブを配置し、651px以上は幅240pxで左にそろえ、650px以下は本文幅いっぱいにします。戦績・棋譜カードは1024px以上で左560px・間隔20px・右は残り幅、それ未満では同幅の縦並びです。本文とプロフィール編集の `AppDialog` は選択中ゲームのテーマを使い、共通ヘッダーはテーマ範囲の外に置きます。ログインは `AccountPageShell` の `layout="login"` でヘッダー下の残り領域を使い、左右20px余白・カード最大560pxの中央配置にします。内容が高い場合は自然に画面を伸ばしてスクロールし、上部が欠けないようにします。初回設定は従来のフォーム用幅を維持し、下部のロビーリンクは両方に残します。登録メリットとバッジ例をログインでも共用します。一般向けログインでは「バッジを集めよう」の説明の直下にバッジ例を置き、管理画面向けでは登録メリットとバッジ例を省略します。

Webの編集先は `features/account/`、プロフィールの共通フォームは `ProfileForm.tsx`、認証処理はWorkerの `src/accounts/` です。初回設定はページ内、マイページの編集は共通 `AppDialog` 内に同じフォームを表示します。ゲストの編集では名前とプリセットを選択でき、IDは読み取り専用です。保存時は `PATCH /api/account/guest/name` に名前と選択時だけ `avatarPresetId` を送ります。登録者は名前・ID・任意アイコンをmultipartでまとめて保存します。カメラボタンから画像を選択してプレビューし、「保存」（初回設定は「プロフィールを作成」）で反映します。アイコンの削除も同じです。フォームの `onBusyChange` で画像変換・保存中の閉鎖を防ぎ、`onSaved` で成功時にダイアログを閉じてページに通知します。閉じた未保存フォームは破棄し、再度開くと保存済みプロフィールで初期化します。 ファイル選択や別タブから戻った際のログイン再確認では、取得済みのプロフィールと編集中のフォームを保持します。再確認の通信失敗は再試行案内を追加し、名前・ID・画像の下書きを保持します。セッション失効が確認された場合はログインへ誘導します。

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

作成・参加のPOSTに `snapshot=1` を指定すると、初期表示用の `snapshot` と本人の `currentMembership` を返します。追加の読み取りに失敗したときは両項目を省きます。Webは応答内の部屋番号・世代と本人ID・役割を照合し、発行した資格とともにメモリで一度だけ渡します。 `roomLoader` は受信から10秒以内で、部屋番号・保存トークン・招待世代が一致し、本人がルームにいて、マッチング・大会の復旧参照がない場合に2回のGETを省きます。操作はWebSocketの `room.auth` 後に有効になります。

`0004_account_room_entry.sql` でD1に全ルーム共通の席予約・画像参照と、索引のホストアイコン列を追加します。`account_seated` / HTTP 409は既にほかの席を持つアカウント、`profile_required` / HTTP 403は初回設定未完了を示します。認証・D1取得に失敗したときはゲストへ自動降格しません。

Workerテストはサーバー本人確認、入力偽装・初回設定、同時作成・参加の排他、プロフィール編集・ログアウト・画像保持、退室・復帰期限切れ・脱落、予約中断・取消後の遅延RPCと解放の再試行を検証します。作成・番号・招待の参加payload、重複参加と認証失効はDOMテストで確認します。ロビーは席の実画像・CPU・空席と読み上げ用の内訳を表示します。

本人のアカウント情報がある「CPUと遊ぶ」は `CpuMatchNotice` で「CPUを含んだ対局は、戦績に反映されません。」をCPU説明の直下に表示します。通常の作成・参加には表示しません。冒頭は四人ゲームを「CPU3人と対戦します。」、二人ゲームを「CPUと対戦します。」とし、待機室での開始操作の説明はここに付けません。`RoomEntryDialog` の公開案内は短い1文とし、招待確認と法文書で使う `publicRecordNotice` の詳細は維持します。共通の `RoomIdentityFields` は設定済みゲスト名に「ゲスト」を添え、入力補足を「1〜10文字」とします。

CPU追加の確認レベルは両ゲーム共通の `RoomViewShell` で保持し、PC境界で `RoomInfo` が再配置されても確認を保持します。ログイン中かつCPU0人で毎回確認し、既存CPUあり・ゲストは直接追加します。確認時にも接続・待機・ホスト・空席・ログイン取得状態を再確認し、既存の設定送信pendingガードを使います。取消・閉じる・Escapeでは送信せず、閉鎖後は追加ボタンまたはルームへフォーカスを戻します。`AccountLayout` は初回・再試行・フォーカス復帰の取得中を明示し、取得失敗をゲストに降格せず再確認を案内します。

CPU追加は `useCpuAddition` のDOMテストで確認します。ログイン済みの初回だけ確認し、ゲスト・CPUありは直接追加、取消は未送信、全削除後は再確認とします。満席・対局開始・ホスト喪失・認証の取得待ちや失敗では確認を省略して送信せず、確認中の権限変更で保留を破棄します。

対局中も人間の参加者が全員退室・復帰期限切れになれば、未決着の部屋を閉鎖します。脱落による終局を先に判定し、終局した対局は保存します。投了・脱落後の在室者（ゲストを含む）と30秒の復帰待ちは部屋を維持し、通常の観戦者は維持条件に含めません。期限切れ後の閲覧資格は在室者に数えません。閉鎖で現在局の棋譜・CPU選択を破棄しても、過去の保存待ちと将棋の保護局は残し、必要な再試行Alarmを維持します。両ゲームの退室・切断・同資格の別接続・保存失敗と番号再利用をWorkerテストで、閉鎖受信による接続終了と案内をWebのDOMテストで検証します。

## 終局保存と本人の対局履歴

`0005_match_history.sql` はD1に対局本体 `matches` と本人別の索引 `account_match_history` を追加します。既存のローカル開発・テスト・CDのマイグレーション手順で適用します。保存処理の障害復旧をWorkerテストで確認した後、履歴APIとWebを接続します。`0006_shogi_match_history.sql` は本人索引へゲーム列（既定値はリバーシ）とゲーム別索引を追加し、将棋用の非公開アップロードmanifest `shogi_match_uploads` と100イベントごとの `shogi_match_chunks` を作ります。

GameRoomは対局開始時に棋譜と共通のUUID・開始日時・参加者情報を非公開の `match-start` に記録します。終局時に再戦待機への変更または部屋閉鎖と同じトランザクションで `match-pending:<UUID>` を作り、D1へ非同期保存します。本体と全アカウント索引をD1のbatchで一括保存し、索引の本人情報は保存済み本体から取得します。一意制約で再送の重複を防ぎ、既存の対局を上書きしません。成功を確認した保存待ちだけを削除し、失敗時は5秒後のAlarmで再試行します。保存待ちは部屋や直前1局の棋譜とは独立して保持し、部屋がない状態や番号再利用後にもAlarmを動かします。

`GET /api/account/matches?game=four-reversi|four-shogi&mode=singles|doubles&cursor=<開始日時ms>:<UUID>` はCookieで確認した本人の開始時の参加局と、結果から本人へ引き継いだ局をゲーム・モード別に返します。`game` の省略時はリバーシです。開始日時・UUIDの降順で21件を取得し、応答は `{ matches: [...最大20件], nextCursor: string | null }` です。カード用応答は日時・ゲーム・モード・参加者・結果だけを含み、内部アカウントID、参加資格、部屋識別子、盤面、棋譜は含めません。アカウント参加者の名前・画像は取得時の現在のプロフィールを参照します。未引き継ぎのゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使います。退会者は [確定した退会仕様](specs/privacy.md#アカウント削除) に従い、保存名へのフォールバックを禁止します。GETにOriginヘッダーを必須とせず、プロフィール変更用の回数制限も適用しません。未認証は401、不正な条件は400、認証取得・D1取得の失敗は503とし、全応答に `Cache-Control: no-store` を付けます。

Workerテストは通常終局の棋譜再現、投了・退室・時間切れ・通信切れ、人間不在で未決着の打ち切り・非保存、退室による即時終局の保存、ゲストのみの保存、D1本体／索引の一括保存、複数局の保存失敗・再戦・閉鎖・番号再利用・再送、導入前の対局の除外を確認します。履歴APIは本人限定、両モード、0・20・21・41件、同時刻のページング、名前・画像変更、認証・D1障害を確認します。Webは履歴カードの値とリンク、空一覧、取得失敗と再試行、追加取得、共通のゲーム・モード、保持と遅延応答、更新をDOMテストで確認します。履歴の期限削除は行いません。

保存参加者へ `match_participant_accounts` の適用済み帰属を重ねてから内部アカウントIDを重複排除し、`participantProfiles` で現在の名前・アイコンを一括取得します。本人用・公開用の一覧と詳細は同じ変換処理を使い、通常のプロフィール変更では応答項目と保存JSONを変更しません。退会時の保存名・本人参照の除去と退会者表示は [退会計画](#プライバシーの入口) の対象です。アカウントの画像未設定は自動プリセット、参照先なしは仮アバターとし、プロフィール取得障害は503です。プロフィール変更は次回取得時に反映し、表示中の自動同期は行いません。ルーム内の直前局の結果は当時の表示情報を保持し、結果からの席切替成功時だけ本人の名前・アイコンを更新します。

## 最近の対局一覧と公開棋譜

公開・総合・本人の一覧APIは任意条件 `includeMoveCount=1` を受けたときだけ、共通の `matchSummary` で保存局面の `game.moveNumber` を `moveCount` に付加します。省略時は旧応答を維持し、不正値は400です。更新済みWebはこの条件を渡し、任意フィールドとして解析します。手数がない旧応答の解析も維持します。D1の保存形式・スキーマは変更しません。`MatchHistoryCard` は手数がある場合だけ表示し、長い名前（見た目の文字数8文字以上）を10px、他は12pxにして列幅内で折り返します。

`0009_public_matches.sql` は `matches (game, started_at_ms DESC, id DESC)` の索引を追加します。記録の書き換えや再保存は不要です。公開一覧は本人索引を使わず、保存完了した本体を参照するため、ゲストのみの対局も含み、将棋の転送途中のmanifest・チャンクは公開しません。

`GET /api/matches?game=four-reversi|four-shogi` はゲーム指定必須で、両モード・CPU戦を含む最新20件を開始日時・UUIDの降順で返します。応答は `{ matches: MatchSummary[] }` です。`GET /api/matches/:matchId` は本人用詳細から `selfPlayerId` を除いた公開詳細を返し、`GET /api/matches/:matchId/replay?cursor=<event offset>` は将棋のイベントを100件ずつ返します。認証不要、不正条件は400、対象なし・リバーシへのイベント取得は404、D1障害・不整合は503、全応答は `no-store` です。アカウント参加者の名前・画像は取得時の現在のプロフィール、ゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使い、退会者は旧名へのフォールバックをせず、内部アカウントID・instanceId・参加資格・チャットは返しません。本人用APIの認証・本人索引は維持します。

公開一覧の任意条件 `humanOnly=true|false` は省略時にfalse、不正値は400です。trueでは保存済みJSONの開始時の参加者がゲームの定員2人または4人を満たし全員humanの条件をSQLで適用してから並べ替え・20件制限を行います。ゲストも含み、CPUが1人でもいる対局は除外します。既存の保存データと索引を使い、migration・記録の書き換えは不要です。

Webは総合ロビーで共通棋譜カードの横並び、ゲーム別ロビーで最新3件の簡潔な行表示を使います。ゲーム別の「もっと見る」は共通 `AppDialog` を開き、最大20件の共通棋譜カードを縦に並べ、対人戦フィルター・更新・再試行を表示します。Portalにはゲームのテーマを渡し、ロビーの3件プレビューをページ内展開しません。表示時と手動更新のみ取得し、同条件の更新失敗は既存一覧を保持します。ゲーム切替・離脱では取得を中止し、前ゲームの遅延応答を採用しません。公開 `/matches/:matchId` と本人用の画面は棋譜の復元・盤面・結果・回転を共有し、公開閲覧では本人IDを作らず、リバーシは黒・将棋は南を手前にします。プロフィール設定への転送を行わず、戻り先は対象ゲームのロビーです。Workerは直接URLにもSPAのindexを配信し、HTTPの `X-Robots-Tag` と画面のrobotsメタで検索対象外にします。計測は `replay` と対局のゲームで分類します。

「対人戦のみ」は総合ロビーでは見出し下、ゲーム別では詳細ダイアログの一覧上に配置し、初期状態はチェックなしです。ロビー表示中だけ保持し、ゲーム別にkeyを変えて再読み込み・ゲーム切替では初期状態へ戻します。条件切替では即座に前の取得を中止し、旧条件のカードを消して再取得します。読み込み中も切替可能で、古い応答は採用しません。切替失敗では選択条件を保って再試行を案内し、同条件の更新失敗では既存一覧と位置を保持します。対人条件が0件なら「対人戦の対局履歴がありません。」を表示します。Webは対人条件にCPUを含む応答も拒否します。

ロビーの棋譜カードだけ、開始時刻から1時間以内は切り捨てた分数（1分未満は0分前、ちょうど1時間は60分前）、1時間を超えて24時間以内は切り捨てた時間数（ちょうど24時間は24時間前）を表示します。24時間を超える時刻と端末時計より未来の時刻は従来の端末時間帯の年月日・時分です。共通カードに任意の相対時刻の基準を渡し、マイページでは従来の日時表示を維持します。time要素のdatetime・titleとカードのaria-labelは正確な開始日時を保持します。ロビーの時計は一覧取得後と1分ごとに更新し、離脱時にタイマーを解除します。表示時刻だけの更新ではAPI再取得・カードの並べ替え・スクロール位置のリセットを行いません。単体テストで分・時間・24時間の境界、日付をまたぐ経過時間、未来時刻、本人用の日時表示を確認します。

Workerの `publicMatches.test.ts` で最新20件・同時刻・ゲーム分離・両モード・CPU／ゲスト・未ログインでの取得・転送途中の除外・非公開情報・本人用APIの認可・不正条件・D1障害を確認します。Webの `publicMatches.test.ts` は公開取得・初期方向・既存棋譜の再現・将棋の連番と最終局面の一致・取消・不正応答を確認します。関連の単体テストは `bun run check` に含まれます。

対人フィルタのWorker回帰では両ゲーム・両モードでCPU1人の除外・ゲスト4人の採用・0件・絞り込み後の最新20件と同時刻順序を確認し、最新21件がCPU戦でも古い対人戦を取得できることを検証します。Webでは条件の送信・CPU入り応答の拒否・取得中止と中止後の遅延応答の拒否を確認します。

## 保存済み棋譜の閲覧

結果共有の仕様は[対局結果のX共有](specs/result-sharing.md)。`ResultShareButton` は公開棋譜の保存を確認してXの投稿画面を開きます。共有本文と対局別メタ情報はprotocolの `match-sharing` を共用し、公開棋譜の初期HTMLにも同じメタ情報を挿入します。HTML用の読取りはrecordの `readPublicMatchMetadata` で公開済み本体だけを既存の保存形式で検証し、対局ID・ゲーム種別を返します。チャンクの取得・棋譜再生・プロフィール解決は公開棋譜APIで行い、初期HTMLはこれらを待ちません。メタ情報の読取りが1500ms以内に終わらない場合は共通カードでHTMLを配信します。画像は既存のゲーム別固定OGPを使い、対局ごとの画像生成・保存・外部サービス呼び出しは行いません。確認対象は `matchSharing.test.ts`（Web・Worker）と `resultSharing.test.tsx` です。

`GET /api/account/matches/:matchId` はCookieで本人を確認し、`account_match_history` と `matches` を結合して本人の対局だけを取得します。応答は `{ match: MatchDetail }` で、対局ID・元の部屋番号・開始／終了日時・設定・開始時の参加者と本人のプレイヤーID・最終ゲーム状態・脱落理由・棋譜を含みます。アカウント参加者の名前・アイコンは取得時の現在のプロフィール、未引き継ぎのゲスト・CPUと退会者以外の参照先のないアカウントの名前は保存名を使います。退会者は [確定した退会仕様](specs/privacy.md#アカウント削除) に従い、保存名へのフォールバックを禁止します。内部アカウントID・instanceId・参加トークン・チャットは返しません。不正IDは400、未認証は401、他人／存在しない対局は404、認証／D1取得失敗は503です。全応答に `Cache-Control: no-store` を付けます。将棋の詳細は棋譜本体に代えて `{ rulesVersion: 1, initial, eventCount }` と方向別 `knockouts` を返し、脱落は最終ゲーム状態の `eliminations` に含みます。

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

共有SQLの `matchOutcomesCte` は、開始時の人数が定員を満たす保存済み対局から、全員が人間の対人戦と、対象ゲーム・モードのレート戦を選びます。四人ゲームはシングルスの保存JSONの `fourReversiRating` / `fourShogiRating`、通常リバーシ・将棋はモード `standard` の `rating.kind` で識別します。レートの変更履歴・代替手の有無・現在の参加受付フラグは参照しません。本人索引と人間参加者の帰属で1アカウント・1局を数え、戦績・ランキング・公開プロフィール・戦法別戦績・バッジで同じ条件を使います。履歴・詳細・棋譜の取得にはこの条件を付けません。

`GET /api/account/stats?game=four-reversi|four-shogi` はCookieで本人を確認し、既存の `account_match_history` と `matches` の保存結果をD1内でゲーム別に全件集計します。省略時はリバーシです。リバーシの応答は `{ singles: { total, first, second, third, fourth }, doubles: { total, wins, losses, draws } }` です。順位は本人の開始時の色に対応する確定順位、勝敗は黒・赤／白・青のチームと保存された勝者から求めます。引き分けも `total` に含めます。全応答は `Cache-Control: no-store`、未認証は401、不正なゲーム指定は400、認証取得・D1集計失敗は503です。将棋のシングルスは `knockouts` と `perfectWins` を追加し、開始時の本人の担当方向から確定順位と撃破数を引きます。ダブルスは南・北／西・東のチームで勝敗を判定します。

Webは`ProfilePage`で`useAccountSelection`を一度読み、共通のゲーム・モードを`AccountStats`と`MatchHistory`へ渡します。`useAccountStats`はゲーム別の両モード、`useMatchHistory(game, mode)`はゲーム・モード別の棋譜一覧を取得・保持し、各カードの更新・再試行を維持します。戦績・棋譜カードは共通タブの選択パネル内に置き、ゲーム・モードの切替で取り外しません。棋譜へのリンクとマイページへの戻りには共通の`accountSelection`（ゲームとゲーム別モード）をブラウザ履歴stateで渡し、選択変更は履歴置換で保存します。旧`accountSelections`は有効な値を棋譜側・戦績側・初期値の順に読み取り、無関係なstateを保持します。選択情報のない直接アクセスの初期値は四人リバーシ・シングルスです。戦績タイトル下に「対人戦のみ集計」を表示し、率は集計対象の対局数を分母にして `.000` 形式の小数3桁で表示します。読み込み・失敗を0件として表示せず、更新中と更新失敗時は取得済みの戦績を保持します。

全6ゲームの共通`LobbyView`だけが`AccountMenu`へ`lobbyGame`を渡し、プロフィール設定済みユーザーの「マイページ」遷移に`createAccountSelection`で作った`accountSelection`を設定します。初期ゲームは移動元、ゲーム別モードはシングルスです。ロビーのフォーム入力や履歴stateは引き継がず、URLパラメーター・新しい永続保存は追加しません。選択情報のない直接アクセスでは従来どおり四人リバーシ・シングルスです。ロビー以外のメニュー、認証・初回設定・認証後の復帰導線は従来の動作を維持します。ゲーム選択は戦績・棋譜・本文テーマで共有し、再読み込み・履歴移動・棋譜往復は現在の選択を復元します。

戦績の表は `StatsTable` で共用し、`AccountStats` の先頭行は対局数と四人将棋シングルスの完全優勝数を左右に配置します。その他の先頭行の右セルは空欄です。`FormationStats` の順位詳細も同じ2列の表を使います。

Workerテストで両ゲーム・両モードの人間4人、CPU1〜3人の過去分除外、CPU戦のみの本人の0件表示と履歴・詳細・棋譜の保存を確認します。集計用データは対人戦、保存用データはCPU戦を維持します。本人限定・全順位・同順位・両チームの勝敗・引き分け・0件・20件超・保存再送・実終局の反映・認証とD1障害を確認します。Webは率の丸め・0件、表示値、棋譜と共通の選択・ゲーム別モードの復元、読み込み・失敗・再試行・更新を純粋関数とDOMテストで確認します。

## 公開プレイヤー情報

公開ページ `/players/:profileId` の入口は Web の [PublicPlayerPage.tsx](../apps/web/src/features/players/PublicPlayerPage.tsx) と Worker の [playerProfileRoutes.ts](../apps/worker/src/routes/playerProfileRoutes.ts) です。プロフィールと戦績は `GET /api/player-profile?source=profile&profileId=…&game=…` の公開オプションを使い、モード切替は取得済みの戦績を使います。プロフィール・棋譜のどちらかが404を返した場合、公開参照UUID単位で閲覧不可を保持し、そのUUIDの表示データと進行中の取得を破棄します。公開ページ内でゲームやモードを変える履歴移動でも閲覧不可を維持します。ページはSPAで配信し、HTTPヘッダーと画面に `noindex` を指定します。

`GET /api/players/:profileId/matches?game=…&mode=…` は認証不要です。`game` は必須で、`mode` は四人ゲームだけに指定します。account 文脈が公開プロフィールと同じ条件で対象・統合先を解決し、record 文脈の `readMatchHistory` が参加索引と保存済み対局から公開要約を生成します。応答直前に公開可否と解決先を再照合し、読取中の退会や統合で対象が変わった場合は404を返します。応答は `{ matches: MatchSummary[] }` で、全応答が `no-store` です。条件不正は400、閲覧できない対象は404、取得障害は503を返します。

プレイヤー情報のレートは `includeRating=1` で要求します。応答の省略可能な `rating` は時点（current／before／reference）と公開状態（rated／placement／unavailable）を区別します。新Webはこの指定に対応するWorkerと組み合わせ、旧Workerで400となっても指定を外して再取得しません。既存の `includeShogiRating`・`includeReversiRating` の応答は旧Web向けに維持します。

新規レート戦は成立時にGameRoom内部の参加者ID別スナップショットを固定し、4ゲームの内部対局記録の省略可能な `profileRatings` へ引き継ぎます。公開棋譜の形式へは追加せず、プレイヤー情報APIだけが参照します。既存記録は更新前のレート履歴・認定局数とCPU割当記録を使い、現在値を当時の値として返しません。通常対局・大会ではレート情報を返しません。退会の共通匿名化とGameRoom内の消去はスナップショットも対象にします。DB移行や既存記録の一括更新はありません。

Webのキャッシュは対局・部屋世代・参加者の参照元を維持し、現在プロフィールとの統合を行いません。大会順位表の入口は公開プロフィールを使うため、`showRating=false` で情報パネルのレート欄を抑止します。CPUも参照先がある場合は情報を開いたときにAPIから取得し、失敗時は再試行を表示します。盤面横のカードのレイアウトには変更を加えません。`test/profileRatings.test.ts` と既存の対局完走テスト、`test-dom/playerProfiles.test.tsx`・`test-dom/tournamentStandings.test.tsx` でAPI・永続化・時点の分離と表示を確認します。

`participantProfiles` は保存参加者から内部IDを重複排除する入口として維持し、`readCurrentProfiles` に現在の名前・公開ID・画像・設定状態の一括読取を集約します。保存棋譜の公開変換は従来の名前・画像だけを使い、公開カードの可否判定とは分けます。レート用の内部メタデータ以外の参加者スキーマ・本人索引・将棋イベントは維持します。

公開・総合・本人の対局一覧と棋譜詳細では、`resolveMatchParticipantList` が最大20局の登録引き継ぎ（applied）と退会済みの参加関係（retired）を1回で取得し、引き継ぎ後の内部IDを重複排除して退会状態も1回で取得します。現在プロフィールの取得と合わせて最大3回とし、対局ごとのD1往復を行いません。20局・各4人でも1クエリのバインド数は最大80個です。空の一覧は問い合わせません。参加者IDは対局IDごとに解決し、pending・rejectedは反映せず、保存参加者と引き継ぎ先が矛盾する場合は取得を失敗させます。保存時と読取り時の退会者表示は `redactRetiredParticipants` の共通変換を使い、既に退会した参加者・退会済みの引き継ぎ先を旧名や現在プロフィールで復活させません。単独の公開プレイヤー参照も同じ解決処理を使います。

`0010_player_profiles.sql` は `user.publicProfileId` の一意UUIDと `room_index` の部屋世代・ホストID列を追加します。内部アカウントIDと変更可能な公開IDから独立した参照キーを既存ユーザーへ付与し、プロフィール保存では未設定の場合だけ生成します。ゲスト作成・プロフィール完了時に公開参照IDを確定し、プロフィール・ランキングGETでは補完UPDATEを行いません。公開対象のID欠落はデータ不整合として503にします。2026-11-06に本番232件・開発12件とも欠落0件を確認しています。

`GET /api/player-profile` はゲームと参照種別を必須にします。`source=room` は `roomId, instanceId, playerId`、`source=match` は `matchId, playerId`、`source=profile` は `profileId` を渡します。GameRoom内部の参加者・アカウント対応、保存記録、公開参照キーをサーバーで照合します。名前や画像で本人を判定せず、内部IDはHTTP・WebSocketへ返しません。省略可能な `includeStats=1` を指定した場合は、平均順位・勝敗分・撃破数の表示に必要な既存 `AccountStats` の全項目を返します。追加指定がない場合、登録者には現在のプロフィールと対象ゲームの `{ singles: { total, first }, doubles: { total, wins } }` だけを返し、既存の `readAccountStats` を呼びます。ゲスト・CPUを区別し、不正400、対象なし404、部屋世代変更410、障害503、全応答no-storeです。対局のWebSocket配信へD1取得を追加しません。

ロビー・ランキングは `profilePreview=1` の要求にだけ参照情報を追加します。通常の応答は従来の形で、旧Workerの400では通常取得へ戻ります。ロビーの古い索引で参照情報がない行は `getPublicMetadata` で現在の部屋世代とホストへ補完し、閉鎖済みを除外します。参照のない旧応答をゲストと判断しません。

Webのプレイヤー機能は取得store、Provider、表示カード、トリガーに分離します。storeは `includeStats=1`・`includeBadges=1`・`includeDetails=1` を指定し、400時にオプションを除去する自動再取得は行いません。旧応答の不足項目は補完せず、`playerStatsSummary.ts` で取得済み値だけを文章にまとめます。成功結果を60秒再利用し、解決した公開参照キーとゲームで共有します。プロフィール保存・終局・画面遷移で無効化し、abort後や旧要求の完了を採用しません。ダイアログのスクロール領域でカードやリンクが切れないよう、非モーダルのHeroUI Popoverを既定のPortalに描画します。ダイアログ上でも明示操作でカードへフォーカスを移し、Tabでリンクへ進めます。Escapeはカードだけを閉じ、明示操作で開いていた場合はトリガーへフォーカスを戻します。

Workerの `playerProfiles.test.ts` と既存の公開／本人棋譜・戦績テスト、Webの `playerProfiles.test.tsx` で未ログインでの取得、別人への誤紐付け防止、ゲスト・CPU・参照先なし、旧応答、取得障害、開閉、再試行、キャッシュ期限・無効化・遅延応答を確認します。実寸法・ネイティブ入力・画像デコードは手動確認し、PRへ結果と未確認を記載します。

## 本人棋譜の絞り込み

仕様は[本人棋譜の絞り込み](../README.md#本人棋譜の絞り込み)です。protocolの `matchHistoryFilterSchema` は `all / rated / human / cpu` を定義し、`GET /api/account/matches` の省略可能な `filter` は既定で `all` です。不正値は400、未認証は401、DB取得失敗は503とし、応答はno-storeです。`all` 以外では応答に適用した `filter` を返し、新Webは一致しない旧Workerの応答を成功扱いせず、指定を外した再取得もしません。Workerを先に反映します。

record の文脈の `domain/matchKinds.ts` と `adapters/record/matchKinds.ts` は成立記録と大会台帳による分類SQLを表示・フィルターで共用し、レート戦を優先して通常／大会の開始時参加者を照合します。`matchRoutes.ts` は本人索引・ゲーム・モード・種別の条件を20件のLIMITより前へ適用します。未取得の履歴をWebで除外したり、APIで全件を読み込んでから絞り込んだりしません。保存JSON・戦績集計・DBスキーマを変更しません。

Webの `useMatchHistoryFilter` は本人の公開識別子と選択をブラウザ履歴に保持し、別人へ切り替わると初期化します。`useMatchHistory` の一覧・追加位置・実行中要求のキーはゲーム・モード・フィルターです。アカウント世代・abortの照合と本人変更時の再マウントを維持し、棋譜の選択で戦績APIを取り直しません。`MatchHistory` は既存の `AppTabs`・`AppTabs.List`・`AppTabs.Tab`・`AppTabs.Indicator`・`AppTabs.Panel` で4択と選択中の一覧を表示し、空一覧・失敗を区別します。

## ルーム・棋譜の対局種別

表示仕様は[README](../README.md#対局種別の表示)です。protocolの `MatchKind` は `rated / tournament / normal / unknown` とし、画面は共通の `MatchKindBadge` を使います。ルーム内の直前局は `roomMatchKind` が専用ルームの成立情報を読みます。四人ゲームは `matchmaking.rated`、二人ゲームは専用レート戦のコンテキスト、大会は `tournamentId` を使い、四人リバーシの旧ランダムマッチをレート戦へ読み替えません。WebSocketや保存済み棋譜JSONには項目を追加しません。

`0040_room_match_kind.sql` は公開索引に nullable の `match_kind` を追加します。既存の大会・通常ルームは明示済みの索引フラグから補完し、旧マッチングは未判定のまま保持します。GameRoomは索引更新時に成立情報から種別を記録します。種別を要求した一覧で未判定なら、対象ルームの既存 `refreshLobbyIndex` で一度だけ再発行し再読込みします。再取得できないが他の表示情報はある場合は `unknown` を返します。既存のrevision・部屋世代・閉鎖の照合を維持します。移行をWorker更新前に適用します。

`GET /api/lobby/rooms?view=cards`、`/api/lobby/matches`、`/api/matches`、`/api/account/matches` と公開／本人の棋譜詳細は、`includeMatchKind=1` を要求した場合だけ `matchKind` を追加します。省略時の通常応答は維持し、不正値は400です。新Webはこの指定を追加し、欠落した項目は「種別不明」と表示します。400時に指定を外す自動再取得はしません。公開メタ情報RPCの旧応答にも種別を混入させません。

保存済み棋譜の種別は record の文脈の `domain/matchKinds.ts` と `adapters/record/matchKinds.ts` に集約し、厳密に解析した保存記録のレート戦成立情報と、対局IDで結合する大会台帳から取得します。レート変更履歴の有無は認定中・代替手使用時の判定に使いません。一覧は最大20局を一括照会し、局ごとの追加リクエストや保存内容の再計算を行いません。大会の公開状態・名前・内部キーをラベル表示に公開せず、矛盾する成立記録は `unknown` とします。台帳取得の失敗は503とし、通常対局へフォールバックしません。

## 大会・レート戦のルーム通し番号

表示仕様は[対局種別の表示](../README.md#対局種別の表示)です。`0041_room_match_sequences.sql` は対局IDを主キー、採番範囲と番号を一意とする `room_match_sequences` と、公開索引の nullable な `match_sequence` を追加します。大会は内部大会キー、レート戦はゲームIDで範囲を分け、個人情報は保存しません。台帳は番号を再利用しないために保持します。

`adapters/record/matchSequences.ts` はMAXの参照とINSERTを一文で確定し、同じ対局の再試行では既存番号を返します。Coordinatorはグループを永続化してから採番し、GameRoomを準備します。新規グループだけに `assignSequence` を記録し、導入前の準備済み予約と復旧処理へ後付けしません。失敗は既存のAlarmで再試行し、通常・旧ランダムマッチには採番しません。

番号は内部予約と公開索引へ保存し、索引のrevision・instanceId照合と通常ルームへの再利用時の消去を維持します。`GET /api/lobby/rooms?view=cards&includeMatchSequence=1` の要求時だけ省略可能な正整数 `matchSequence` を返します。カード以外の指定と不正値は400です。未採番の部屋は省略し、一覧取得で採番しません。旧公開メタ情報RPC、既存APIの省略時応答、WebSocket・保存済み棋譜の形式は維持します。

新Webは `includeMatchKind=1` とともに要求し、共通カードが名前を整形します。新Webには対応Workerが必要で、旧Workerへの自動再取得は行いません。反映順はmigration→Worker→Webとし、Workerを切り戻す場合は対応するWebも戻します。

## レート戦開幕ダイアログ

仕様の正本は[開幕の案内](specs/matchmaking.md#レート戦開幕の案内)です。`RatedLaunchAnnouncement` が総合ロビーと対応4ゲームの共通 `LobbyView` に入り、固定キー `tetraboard:rated-launch:seen` を受付情報の取得前に確認します。`ratedLaunch.ts` に既読確認・表示直前の保存・目的付き遷移の判定を集約します。保存不可では自動表示を見送り、既読は本人の切替やデプロイで消去しません。

総合ロビーは既存 `useLobbyGameRatings` の結果を渡し、ゲーム別は未読かつ目的付き遷移でないときだけ同じAPIを取得します。読み込み・非表示・停止・失敗では既読にしません。表示待ち中のpointerdown・keydown・wheel、別ダイアログの出現、別タブの既読を監視し、利用者の操作を優先します。破棄時に取得・タイマー・イベント・Observerを解除します。

`RatedLaunchDialog` は受付確認済みのゲーム一覧を受け、既存 `AppDialog`・`SocialSignInButtons`・`useSocialSignIn` を使います。選択ゲームを既存の登録復帰先へ保存し、OAuth／初回設定後はそのゲームの `?matchmaking=1` へ戻します。認証開始の計測も既存のrated-matchを利用し、新API・保存テーブル・依存や受付フラグ変更はありません。参加者の検索開始は既存画面の操作に残します。

## ゲーム別のランキング

`GET /api/games/:game/rankings/rating` は四人将棋・四人リバーシ・将棋・リバーシだけの公開APIです。`{ entries: [{ rank, profileId, username, name, avatarUrl, value }] }` で最新の公開整数レート上位10人を返し、既存のランキング応答を変更しません。各ゲームのレート更新履歴の最大有効局数から認定済みの登録者を抽出し、公開整数値で同順位を判定します。四人ゲームの変換定数を既存表示と共有し、SQLiteでは負の半整数もMath.roundと一致する `floor(value + 0.5)` を使います。件数用の正整数制約はレートに流用せず、内部ID・μ・σ・認定中の値は返しません。新しい集計テーブルやバックフィルは不要です。応答はno-store、失敗は503です。

新Webのレート表示には本APIを持つWorkerが必要です。旧Workerの404や不正応答を空一覧へ置き換えず再試行を案内します。既存Webは既存APIをそのまま使用できます。Workerを先に反映し、切り戻しでは対応するWebも戻します。

件数ランキングの詳細の集計説明はゲーム・モードに応じて「対人戦/レート戦を集計」または「対人戦のみ集計」とします。詳細では対戦相手がゲストでも対象であること、該当するレート戦ではCPU補充局も含むことを補足します。

`GET /api/games/four-reversi/rankings` と `GET /api/games/four-shogi/rankings` は認証不要で、`{ singles: { first, total }, doubles: { wins, total } }` の各上位10人を返します。各行は `rank`・`username`・`name`・`avatarUrl`・`value` です。既存の `account_match_history`・`matches` を対象ゲームに限定してD1内で全件集計し、現在の設定済みアカウントのプロフィールを結合します。本人戦績と同じ順位・チーム勝敗の判定を使います。四人将棋シングルスの撃破数は `includeKnockouts=1` を指定した要求にだけ `singles.knockouts` を追加します。保存済みの `knockouts` を通常戦績と同じ条件で累計し、0人は除外します。通常応答とダブルスの形を維持し、プレイヤー参照付き応答にも要求時だけ追加します。他ゲームの要求や不正値は400です。Webは四人将棋だけ追加指定し、旧Workerで項目が欠落した場合は0件に置き換えず表示できない旨を案内します。

SQLの `RANK()` で同順位と順位の飛びを求め、値の降順・公開IDの昇順の `ROW_NUMBER()` で10人に制限します。件数ランキングでは集計値が1以上の人だけを掲載します。名前・画像は履歴の開始時情報ではなく現在のプロフィールを参照します。内部アカウントID・棋譜は返しません。全応答は `Cache-Control: no-store`、D1取得失敗は503です。

ロビーの `LobbyRankings` と `useRankings` で件数ランキングとレートランキングを並列取得し、取得状態と再試行を独立管理します。初期表示は対応4ゲームではレートの上位3人、四人五目並べではシングルス優勝数、五目並べでは勝利数です。詳細は上位10人とモード・指標タブ、更新操作を持ち、プレビューと取得結果を共有します。四人将棋シングルスだけ撃破数を表示する契約と、ゲストを含む対人戦の集計を維持します。対応4ゲームは左からレート／優勝数（二人ゲームは勝利数）のコンパクトなタブを持ち、`useRankingRotation` が10秒の表示・100msの退出・150msの登場と停止条件を管理します。演出はTailwind CSSのクラスで指定し、動きを減らす設定では省略します。取得処理とタイマーは独立しています。プレイヤー情報Providerのactive状態と詳細・ホバー・フォーカス・可視状態を監視し、解除後は10秒を数え直します。切替では再取得せず、停止設定はページ内だけで保持します。PCは左に公開ルーム、右にランキングと最近の対局、767px以下は操作・公開ルーム・ランキング・最近の対局です。DOM順を共通にしてCSSだけで配置を切り替え、幅変更時も取得済みデータ・詳細状態を保持します。

Workerテストで未ログインアクセス・全色・同率優勝・両チーム勝利・引き分け・CPU戦除外・ゲスト相手の対人戦と未引き継ぎゲスト本人の掲載除外・0件・0回除外・10人の境界・全履歴・再送・プロフィール更新・未終局と実終局・D1障害を確認します。Webは初回取得・失敗・再試行・更新時保持とモード・集計項目・上位3人／詳細10人の表示をDOMテストで確認します。

ロビーは取得失敗・追加取得・0件と末尾・参加／観戦のURL、ランキングの取得済み値・選択と更新をDOMテストで確認します。偽の幅変更通知によるDOM順・選択の保持は確認し、画面幅ごとの寸法やフォーカスの実ブラウザ検証は自動検証対象から外します。画面のレスポンシブ仕様は維持します。

## 四人将棋の恒久記録の確認

将棋はDOの終局トランザクションでメタデータ・保存待ちと `shogi_archives` の保護局を確定します。再戦・閉鎖・番号再利用でも保護局のイベントを削除しません。Alarmごとに最大400イベントをD1へアップロードし、全チャンクを逐次検証してから `matches` 本体と本人索引を最後のD1 batchで公開します。途中状態は一覧・戦績・ランキングへ出さず、失敗は5秒後に再送します。成功後は保存待ちと保護を解除し、現部屋の直前局ならイベントを残し、別局または閉鎖後なら不要な行を削除します。リバーシのJSONと保存処理は維持します。

終局保存は導入後に開始した対局だけを対象とし、導入前・導入時に進行中の棋譜や撃破数を補完しません。撃破数は受理されたシングルス着手の新たな `checkmate` 脱落だけを着手者へ人数分加算します。CPUも記録し、外部脱落・`no_legal_actions`・ダブルスは加算しません。エンジンの順位や勝敗を変更せず、対局記録の集計情報として扱います。

`GET /api/account/matches/:matchId/replay?cursor=<event offset>` は本人の保存済み将棋対局を100イベントずつ返します。応答は `MatchReplayPage`（`matchId`・`rulesVersion`・`initial`・`eventCount`・`events: [{ index, event }]`・`nextCursor`）です。詳細と同じ本人限定・認証・不正ID・障害・no-storeの規則を使います。Webは対局ID、バージョン、初期化情報、件数、連続番号とカーソルを照合し、`createInitialState`・`applyAction`・`eliminateSide` で復元して保存済み最終状態と比較します。途中の移動でfetchを中止し、失敗時は未完成の棋譜を表示せず再試行します。

固定データは公開エンジンで受理される初期局面からのイベント列で作ります。Webの純粋関数・DOMテストは戦績・棋譜の4つのゲーム／モード、遅延応答・更新失敗時の保持、方向・持ち駒・成り・裏王・読み取り専用を確認します。同時脱落はWorkerと保存棋譜と共通のframe生成を合わせて確認します。ランキングの未ログインでの取得・集計・人数境界はWorker、表示内容・選択と失敗・再試行はWebで確認します。リバーシの通信形式と既存棋譜の互換性は維持します。

## 観戦と保存済み棋譜の回転

観戦と保存済み棋譜では、共有ボタンで盤面を四人ゲームは90度、二人ゲームは180度ずつ回転します。状況カードの右側に観戦では「観戦中」、保存済み棋譜ではタブレット・PCで「棋譜閲覧中」を回転ボタンと並べます。参加可能な待機ルームでは参加ボタンも同じ行に置きます。参加者のルーム内棋譜は対象外です。将棋は既存の座標・駒方向・持ち駒・カードの変換を使い、リバーシは表示マスを基準座標へ戻して盤面と最終手を参照します。カードは時計回りに位置だけを変え、文字は回転しません。通信・サーバー状態・棋譜データへの書き込みは行いません。

状態は手数変更・タブ切替・再接続・同じルームの次局開始で保持し、ページ再読み込みと画面の識別子・参加資格の切替で初期化します。座標変換・回転・閲覧権限は純粋関数、局面変更時の保持はhookテストで確認します。

## 管理画面の開発と公開

`apps/admin` はReact・Vite・Tailwind CSSとshadcn/ui（Base UI版）を使います。一般WebのHeroUIは継続します。`bun run dev` はWorker・Web・Adminを起動します。AdminのViteは5174で起動し、Webの `/admin` をプロキシするため、ブラウザでは `http://localhost:5173/admin` を開きます。Google認証は既存の同一オリジン設定を使い、専用のOAuthクライアントや別の本番Workerは不要です。開発用Vite自体のHTMLは認証前も取得できますが、管理データは常にWorkerの本人確認を通します。本番はHTMLとアセットも本人限定です。

管理メニューは `AdminNavigation.tsx` に集約し、768px以上は開閉式サイドバー、768px未満はヘッダーから開くSheetとネイティブの画面選択欄を使います。現在地はURLから導出し、詳細・新規作成・編集でも親メニューを選択します。`AdminShell.tsx` は共通ヘッダーと本文へのスキップリンクを持ちます。KPIの画面（`Kpi.tsx`）は `GET /api/admin/kpi` を表示します（[計測の仕様](specs/analytics.md)）。

### 管理画面の部品と復旧

`apps/admin/components.json` はshadcn CLI 4.23のBase UI・base-nova・neutralを設定し、生成部品を `src/components/ui` に置きます。`@/` はAdminの `src/` への参照です。Base UIのCheckboxとLabelは同じコンテナ内でIDを関連付け、Checkboxをlabelで囲みません。フォームのロックは各Checkboxにも明示します。グラフは `ChartContainer` とRecharts、ユーザー表はTanStack Table v9の `useTable` と共通 `DataTable` を使います。既存の検索・追加取得・並べ替え条件は変更せず、PR6で列・サーバー側の並べ替えを追加しています。

`ThemeProvider` はライト／ダーク／OS設定を切り替え、初期値はOS設定です。選択はlocalStorageの `tetraboard:admin-theme:v1` だけに保存し、別タブでの変更も反映します。保存不能でもその画面の選択は使えます。サイドバーの開閉はページ内だけで保持し、新しいCookieを発行しません。フォントは同梱のGeistを使い、外部フォント配信へ接続しません。

`AdminApp` は既存のセッション確認後に管理画面を開き、各画面を遅延読み込みします。ページ単位の `AdminPageBoundary` は読み込み・描画失敗でもメニューを残し、再読み込みまたは別メニューへの移動を可能にします。APIの401／403は共通イベントで全 `useAdminData` の保持データ・処理中の取得を破棄し、セッション確認画面へ戻します。更新APIの権限喪失でも別画面の機密データを表示し続けません。503などの一時障害は既存の再試行と入力保持を維持します。公開API・管理権限・Origin検査・Workerの配信制御は変更しません。

### 管理者設定

ローカルの追跡対象外 `.dev.vars` に `ADMIN_ACCOUNT_IDS` をJSON配列（例：`["owner-id-1","owner-id-2"]`）で設定します。値は本人の内部 `user.id` で、公開IDの `username`・Googleの識別子・メールとは異なります。本人のプロフィールを公開IDまたはメールで検索したD1の行から確認してください。IDをソースやフロントエンドの環境変数へ埋め込みません。設定なし・空配列・不正な配列は503で閉じ、開発者用の認証回避は設けません。単一管理者の設定でも配列を使います。

本番は開発者の指示に基づき、`apps/worker` で `bunx wrangler secret put ADMIN_ACCOUNT_IDS --env production` から本人のIDのJSON配列を設定します。secretに保存したIDは認証と本人利用の除外で共通に使います。公開・マージは差分と確認結果をレビューした開発者の承認後に行います。既存の `MODERATOR_TOKEN` は通報API用で、管理画面には使いません。ログイン画面の `destination=admin` はサーバー固定の `/admin` へだけ戻し、任意の外部URLをOAuthの遷移先にしません。

### ビルドと確認

`bun run build` はWeb・Adminを個別にビルドし、`scripts/buildAssets.ts` で `apps/worker/dist/assets` にWeb、その `admin/` 配下にAdminをまとめます。Wranglerはこの成果物を配信します。Adminの深いURLは認証後に専用indexを返し、HTMLの自動転送を無効にしてリダイレクトループを防ぎます。通常WebのSPA・API・WebSocketを維持します。CI/CDも同じビルド成果物を使います。Worker単独のdry-runや本番構成プレビューの前に、必ず `bun run build` を実行してください。

本番構成のローカルプレビューは `preview:production` がupstreamも `http://127.0.0.1:8788` にそろえます。本番のcustom domainをupstreamとして使うとWranglerがOriginを書き換え、ローカル用 `APP_ORIGIN` と一致しなくなるためです。


`bun run check` はAdminの型・表示計算・DOMテストを含みます。実Google認証・本番データでの確認はローカルのモック検証と区別して報告します。

## フィードバックの受付・運営

### 終局後の評価（#132）

利用者向けの正本は [終局後の星評価](../README.md#終局後の星評価) です。`RoomViewShell` の結果を閉じる操作から `usePostGameFeedback` を呼び、本人の参加資格と前局の参加者を確認して `PostGameFeedbackDialog` を開きます。表示記録は `tetraboard:post-game-feedback-shown` のlocalStorageキーで全ゲーム共通です。表示する時点で保存し、未回答・送信失敗でも消しません。保存不能時は表示を省略します。既存結果・登録案内の表示条件と1秒の遅延は維持します。

`POST /api/feedback` の既存入力へ任意の `rating`（整数1〜5）と `opponent`（cpu／human）を対で追加します。評価ありの場合だけ本文を任意にし、opinion・個別ゲームに限定します。投稿者区分は従来のサーバー認証で確認し、対戦区分は前局のappearance（旧形式は対局中の参加構成）から求めます。送信内容は最初の試行で固定し、再送は同じsubmissionIdを使い、編集時に新しいIDへ切り替えます。`0019_feedback_ratings.sql` は既存feedback表へnullable列を追加し、既存行はnullのままです。管理一覧の `author`・`opponent`・`rating` 条件と詳細へ反映し、管理者認証・期限・退会削除の経路を共用します。

`postGameFeedback.test.tsx` と `autoGameResult.test.tsx` は結果を閉じた後の表示、観戦の除外、保存・再表示抑止、星と任意コメント、失敗・再送・変更を確認します。Workerの `feedback.test.ts` は保存・認証・入力境界・管理APIの絞り込み、Adminの `feedbackEditor.test.tsx` は一覧と詳細・区分・評価の表示を確認します。画面寸法と実機の星選択・フォーカスは手動確認です。

### 共通の受付

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

### ベルのお知らせ・既読の実装

仕様は[READMEのベル機能](../README.md#ベルのお知らせ一覧と既読)を正本にします。`routes/notificationRoutes.ts` が受け、community の文脈の `domain/notifications.ts`・`use-cases/notifications.ts` と `adapters/community/notifications.ts` が一覧・詳細・本人の既読を担当し、Protocolの `notifications.ts` で種類別payload・番号・入出力を共有します。

`0029_notifications.sql` は単調増加番号の `notification_events`、初回全体基準とまとめて既読上限の `account_notification_state`、個別既読の `account_notification_reads` を追加します。全体イベントは記事ID、バッジは本人と対局ID、大会は本人とエントリーIDを一意にします。全体通知は現在の記事を参照し、個別通知は獲得・表彰時のpayloadを保持します。公開状態を全体の一覧・詳細・未読判定へ毎回適用します。

記事のINSERT／公開UPDATEと、バッジtoast台帳のINSERTと同じbatchで通知のイベントを作り、既存の保存batchと一緒に確定します（TB-145。同じ働きのD1 triggerはTB-146で消しました）。大会は `finalizeTournament` の同じ競合ガードを使い、最終順位・表彰イベント・結果確定を同じbatchで保存します。triggerによる副次変更を含むため、記事の更新成功は変更件数ではなく `UPDATE ... RETURNING id` の結果で判定します。移行は既存公開記事をlegacyとして登録し、旧バッジイベントを補完しません。導入時刻より前のtoast台帳を統合しても新たな通知を作りません。

APIはすべてno-storeです。

- `GET /api/notifications?cursor=番号&after=番号&announcementId=記事ID` は公開通知と本人宛を20件ずつ返し、`nextCursor` と取得時点の `upperBound` を含めます。`after` は匿名の未読照合、`announcementId` は既存の記事詳細から既読を付けるために使います。
- `GET /api/notifications/:id` は閲覧可能な詳細だけを返します。他人宛・非公開記事は404です。
- `GET /api/account/notifications/unread` は本人の未読有無と上限を返します。初回の本人取得で全体記事の基準だけを一度保存します。
- `POST /api/account/notifications/read` は `{ id }`、`read-all` は `{ through }` を受け、Cookieと同一Originを確認します。既読記録は再送可能で、未来の未発行番号をまとめて既読にする指定は拒否します。入力不備400、未認証401、Origin不正403、取得・保存障害503です。

`NotificationProvider` はAccountLayout配下で本人・認証世代ごとの取得を管理し、ヘッダーの登録中だけ30秒更新します。表示復帰・focus・online・storageで再確認し、取得競合では新しい結果を優先します。通知ごとの通信は10秒で中止します。`NotificationBell` は共通ヘッダーだけに置き、共通AppDialogで一覧・詳細・既読失敗の再試行を表示します。全体記事の表示ラベルは「運営からのお知らせ」です。一覧の更新は読み上げ名「お知らせを更新」のアイコン専用ボタン、すべて既読は文字付きのボタンとし、どちらもsecondaryの枠付き表示で操作中のスピナーと重複操作の抑止を維持します。更新・一括既読・戻るのボタンは高さ36pxにそろえ、更新・戻るは36px角と16pxのアイコンで表示します。一括既読は左右のpaddingも12pxに抑えます。AppDialogの `scrollBody`・`bodyRef`・`footer` を使い、ヘッダーと詳細の下部にある戻るアイコンボタンを残して本文だけをスクロールします。詳細は先頭から表示し、一覧へ戻ると本文のスクロール位置と選択項目のフォーカスを復元します。匿名は専用localStorageにまとめて既読上限と個別IDを保存し、保存不可時はメモリで保持します。

`notificationCache.ts` は本人ごとの最新1ページをメモリに保持します。ヘッダー登録後に未読確認と一覧先読みを並行して開始し、開くときは取得済み一覧を初期表示しつつ再取得します。未読確認の番号上限が変わった場合も先読みを更新します。匿名は従来の未読確認に使う一覧をそのまま先読みに共用します。進行中のGETは認証世代とURLごとに共用し、StrictMode・先読み中のベル操作・更新の重複通信を抑えます。失敗してもキャッシュは保持し、データなしと取得失敗を区別します。追加取得したページとスクロールはダイアログ内だけに保持します。

キャッシュは安定したprofileId（互換時はusername）を本人キーとし、同じ本人の認証再確認では保持します。取得の中止と表示は認証世代で管理し、確認中は非表示、ログアウト・本人切替では新しいキャッシュへ切り替えて旧応答を破棄します。個別本文をlocalStorageへ保存しません。一覧に含まれる全文から詳細を表示し、その表示後に既読を保存するため、項目選択時の詳細GETは不要です。既存記事の直接閲覧も先読み内の通知IDを優先し、未取得記事だけ `announcementId` で照会します。成功した個別既読・一括既読はキャッシュへ反映し、古い取得応答で巻き戻しません。既読保存が404なら表示から除外し、それ以前に開始した一覧応答を無効にします。401は既存の本人再確認へつなぎます。未読APIの `hasUnread: false` だけを根拠に通知を既読へ変更しません。

ゲスト統合は各アカウントの基準・まとめて既読を個別記録へ実体化してから宛先を移し、元イベントが重なる場合は既読を優先します。バッジ台帳の移行より先に実行して再生成を防ぎます。退会処理と削除済みアカウントのINSERT／UPDATEフェンスにも通知を含めます。新しい外部サービス・WebSocket配信は追加しません。

## 任意登録の案内と画面復帰

利用者向けの正本は [終局後の登録と継続再戦](../README.md#終局後の登録と継続再戦) です。登録案内は参加フォームから除き、全体が終局したゲスト本人の結果だけに表示します。結果自体の自動表示は `useAutoGameResult` の既存条件と1,000msの遅延を維持し、案内対象の判定とは分離します。登録済み席をログアウトしてもゲスト扱いにしないよう、本人用の参加資格応答で席のアカウント対応を確認します。

現行ゲストアカウントは `RoomViewShell` で本人のゲスト席と前局参加を確認して `GuestResultLinkCard` を表示します。対人／CPUは前局の参加者情報を使い、認証には既存の `SocialSignInButtons` を使います。Webは登録資格と新しい参加資格を同じタブへ保存し、`POST /api/rooms/:id/registration` に `linkGuest` を指定します。GameRoomはゲスト本人・参加資格・前局・世代を確認し、既存の席保持と開始制御を使います。

migration 0026はOAuthと席保持の対応をD1に記録し、対象席が一致する場合だけ既存のゲスト連携・統合の制約を緩和します。初回連携は元のゲスト内部IDを保ち、既存アカウントへの統合は記録と席の予約を同じD1 batchで移します。他の席・大会待機・二重参加の制約は既存のままです。OAuth開始前の取消とコールバックはD1で競合を判定します。初回設定または統合確認後に新しい参加資格へ切り替えます。通常のマイページ連携と旧来の1局引き継ぎは別の経路として維持します。

### アカウントを持たない旧ゲストの登録

**Goal** は全6ゲームで、結果から新規登録・既存ログインした本人に今回の1局を引き継ぎ、参加し直さず同じ参加者ID・席・ホスト権で再戦することです。**ContextProviders** は開発者の指示、AGENTS.md・README、開発・構成・テスト文書、関連実装・テスト・Git履歴の順です。**Constraints** は既存の認証・Worker・DO・D1・共通UIの利用、10分の席保持／1時間の引き継ぎ受付、再試行での期限延長禁止、全ルーム1アカウント1席、CPU戦など既存の集計条件の維持です。今回の1局以外の一括移行や新しい外部サービスは追加しません。

実装は次の責務に分けます。仕様と受入条件、認証連携、席保持と切替、記録帰属、Web接続の順に変更をまとめ、完成差分を1本のdevelop向けPRで確認します。

1. `registrationFlows`／`registrationRoutes` と追加migrationで処理ID・資格ハッシュ・対象局・元の席・期限・OAuth stateを保存します。既存のコールバックで本人と当該セッションを固定し、設定・同意完了後だけ処理します。更新は同一Origin、応答はno-storeです。
2. `GameRoom` は登録開始と本人の準備解除を同時に保存し、登録待ち中の本人の準備変更と次局開始を拒否します。通常の切断時刻は保持し、既存Alarmで10分期限を管理します。アカウント席予約とDO確定は操作ID・永続状態・取消で回復し、遅延処理で席を復活させません。
3. 席確定では新資格ハッシュ・現在の名前／アイコン・アカウント・計測対応を更新し、旧資格と旧WebSocketを失効させます。次局の開始時はアカウントとして保存し、前局の開始時計測は変更しません。席と記録の進捗は独立させます。
4. `matchClaims` の対局ID＋参加者ID対応を本人棋譜・公開棋譜・プレイヤー・履歴・集計で共有します。保存確認、帰属確定、本人履歴、バッジ・通知をD1 batchで反映します。保存待ちは保存完了時と登録完了時、5秒Alarm・毎時処理から再試行します。
5. `useResultRegistration` と `GuestRegistrationCompletion` は同じタブへ登録資格・256bitの新参加資格を保存し読戻してからOAuthへ進みます。固定コールバックと共通の認証ボタン・メリット表示を使い、復帰完了まで資格を保持します。プロフィール設定中の取消は固定した当該セッションだけを終了します。通常ログイン／管理画面ログインと既存の `registrationReturn` の復帰互換は維持します。

**Done When** は [受入検証](testing.md#終局後の登録引き継ぎ) の正常系・競合・期限・障害復旧・退会・既存認証回帰が成功し、必須のcheck・本番／開発buildとdry-run・GitHub CIが成功していることです。実Google／Discord認証、端末表示・ネイティブ操作、開発環境のmigration適用は手動確認として区別します。マージと公開にはレビューできる差分・結果を提示して承認を得ます。障害復旧にも引き継ぎ対応を読めるコードを使い、追加テーブルを削除したり対応を読めない旧版へ単純に戻したりしません。

## ルームの持ち時間・秒読み

両ゲームの作成・「CPUと遊ぶ」と待機室で `TimeControlSetting` を共有します。持ち時間はなし・1・3・5・10分、秒読みはなし・10・30秒です。「なし」は通信・保存上は0msとし、共通の `roomTimeControlSchema` でプリセット外と両方0を拒否します。作成リクエストの `timeControl` は省略可能で、省略時は従来の5分＋30秒です。選択値はダイアログを閉じても保持し、登録からの復帰でも検証して復元します。古い復帰データに時間がなければ初期値を使います。

待機中のホストは `room.time-control.set` に `{ timeControl: { mainTimeMs, byoyomiMs } }` を送ります。変更は保存・配信・公開索引へ反映し、人間全員の準備を解除します。同じ値の再送は準備・活動時刻・公開更新時刻を変えません。待機室では選択ごとに送信し、応答待ち・切断中は無効にします。再戦待機で変更しても前局の棋譜・保存済み対局の時間設定は書き換えません。

時計の開始と手番更新は両ゲームともルームの時間設定を受け取ります。持ち時間なしでは最初から毎手の秒読み、秒読みなしでは持ち時間だけを消費します。時間なしの枠はルーム情報に「なし」と表示し、秒読みなしでは0秒になっても秒読み色にしません。Workerで全14組み合わせ、開始・着手・CPU・脱落・自動パス・期限境界・権限・準備解除・永続化を確認し、Webで時計表示・登録復帰・選択payloadと待機室の送信待ちを確認します。

## 保存データの契約と棋譜互換

Workerの `adapters/record/matchDataContracts.ts` は `GameId` ごとの保存記録読取り・公開要約／棋譜・戦績・ランキングの解析を必須登録します。JSONはunknownからゲーム別スキーマで検証し、内部IDと参加者のアカウント情報、設定・結果・棋譜の対応を確認します。D1のゲーム列と記録内のゲームが異なる場合も取得失敗です。集計の方向・順位・チーム・撃破数は `gameOutcomeSql` へ登録し、人間4人の条件と集計SQLは共有します。新ゲームは双方の登録と型対応が必要です。軽量カタログには保存スキーマ・エンジン・SQLを置きません。

| ゲーム       | 保存形式                                     | 再生ルール                                             | 既知の旧データ補完                         |
| ------------ | -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| 四人リバーシ | 版項目のない既存JSON。初期・各手の局面を保存 | 保存された局面列を表示。ルール版を新設しない           | 既存通信スキーマに定義された既定値のみ     |
| 四人将棋     | 版項目のない既存メタデータJSONと分割イベント | `rulesVersion: 1` の初期化・イベント適用・フレーム生成 | 省略された引分提案を読取り時に空配列へ補完 |

保存済み棋譜の時間設定は全ゲームで必須です。時間設定を記録していない旧Firebase棋譜の取り込みと `null` の読取り・表示は廃止しています。

保存形式の版、再生ルールの版、派生解析の版は別の責務です。未知のゲーム・ルール版・未対応の保存形状を既知形式へ読み替えません。破損した保存記録は既存の503、Webの再生不整合は既存のルートエラーとして扱い、未完成の棋譜を表示しません。ゲーム本体の保存JSONへ版項目を追加せず、通常の互換対応で既存データ書換え・撃破数の補完は行いません。承認された退会対応では本人の保存名と参照を除去しますが、ゲーム進行データを変更しません。本人戦績用の成立履歴は、後述の専用migrationと別テーブルで管理します。

読取りの正規化結果と保存用元データを分離します。将棋の保存待ちから来る元記録は、検証してもプロパティ順・省略項目を変更せずシリアライズし、既存manifestと同じ文字列で照合します。正規化した読取り結果を保存待ちやmanifestへ戻しません。全チャンクの検証後に本体・本人索引を公開する順序、最大400イベントの転送・検証、5秒後の再送、閉鎖後の保護、重複防止は維持します。

将棋の純粋な `fourShogiReplayV1` は保存棋譜とルーム内の直前局で共用します。取得・認証・ページング・中止・失敗処理は各loaderの責務です。現在のエンジンを呼びますが、将来の変更では固定棋譜との比較を必須とします。版1の再現性を壊す場合は新ルール版と旧版を再現する実装を別途用意し、旧版を最新のルールで黙って再生しません。移行する場合は開発者の承認後、元データを保持し、新旧の初期・途中・終局、結果・撃破数・本人索引・集計値を比較します。再実行しても重複しない手順と差異の報告を必須とし、自動バックフィルはしません。

`test-fixtures/matches` のJSONは作成元コミット・固定ID・日時・元保存JSON・将棋イベント・期待フレームを持ち、Worker、Webで共用します。通常初期局面から公開エンジンで受理された棋譜を一度生成して固定し、テスト実行時に期待値を再生成しません。省略形fixtureは既知の旧形式を再現したもので、本番から収集した記録ではありません。新しい互換ケースは既存fixtureを更新せず追加し、元データと期待値の差分をレビューします。関連テストは `bun run --cwd apps/worker test test/matchCompatibility.test.ts` と `bun test --cwd apps/web ./test/matchCompatibility.test.ts` です。

### 四人将棋の戦型解析と通知

`packages/four-shogi/src/formations.ts` の `detectFormations(position, side)` はルール版・盤面・脱落情報だけを入力にし、公開局面とサーバーのルール状態をそのまま渡せます。16戦型の固定定義をここに集約し、初期配置と同じ `positionForSide` の回転を再利用します。結果は安定した `id`・`name`・9枚の `matchedSquares`（実盤座標）です。公開定数は `formationAnalyzerId = "four-shogi-formations"` と `formationAnalysisVersion = 3`。`formationIds` は定義順の全16IDを公開します。単独ID `subway-rook` は廃止し、`lower-gold` と `yuzuu-muge` は従来の配置とIDを維持して、それぞれ「地下鉄飛車・下段金寄せ」「地下鉄飛車・融通無碍」を正式名称にします。各名称を1件の解析結果として返します。条件・意味を変える場合は解析版を更新し、ルール版・保存版とは分けます。

HTTPの `GET /rooms/:id?formationAnalysis=1` とWebSocketの `/rooms/:id/ws?instanceId=...&formationAnalysis=1` は、通常の応答の `room` の外側へ任意の `formationAnalysis` を付加します。将棋の待機中は `null`、対局中は `{ analyzerId, analysisVersion, rulesVersion, roundId, positionRevision, matches: { south, west, north, east } }`。要求なしとリバーシには項目を付加しません。`protocol` は通信スキーマだけを管理し、戦型IDの列挙と判定条件はエンジンに置きます。エンジンへのprotocol依存追加はありません。成立一覧の上限は17件、根拠座標は各9件で、同時成立も別項目として返します。要求クエリと接続タグは解析版とは独立し、版3でも従来の形式を使います。受信上限17件は旧版との通信互換性のため維持します。

WorkerはWebSocketの要求を `formation-analysis-v1` 接続タグで保持し、従来の認証attachmentを維持します。配信ごとに通常応答と付加応答を各1回だけ生成して共有します。HTTP・WebSocketとも確定したルーム状態の4陣営を判定します。付加解析結果をルーム状態・棋譜・保存対局JSONへ含めません。本人戦績用の成立履歴は下記の専用処理・別テーブルで保存します。現在のWebはHTTP・WebSocketともこの派生結果を要求せず、対応有無のフラグも保持しません。APIは既存タブ向けに維持します。

`useShogiFormationNotice` は `room.game` を共有関数で照合し、楽観表示用の `session.displayGame` とサーバーの派生結果を通知判定に使いません。認証・接続済みの本人について、同じ局の連続revision・連続手数・本人の直前手と不成立→成立を確認します。未通知の新規成立をすべて取り出し、通知データ `{ ids, name }` の名称を定義順に「・」で連結します。初回・再接続・飛んだrevisionは基準とし、既に成立している戦型も既知IDへ含めます。部屋世代・本人ごとの `sessionStorage` キーに局ID・解析版を含むscopeと通知済みIDを保存し、次局で置き換えます。保存値は全16種類の既知IDだけを受け付け、解析版1・2のscopeは引き継がず初回局面を基準にします。まとめ通知の全IDを通知済みにします。保存エラーはメモリ内の抑止へ退避します。別タブ同期は行いません。

`FourShogiBoardLayout` の任意propsで本人側2段目中央に名称を重ね、2000ms・選択・ドラッグ・成り選択・切断・脱落・終局・次局で消します。既存のCSS効果ファイルに置いた `shogi-formation-fade` は2秒のうち0〜180msをフェードイン、1760〜2000msをフェードアウトにし、opacityだけをease-in-outで変えます。名称をkeyにして別戦型への置換時はフェードを再開します。`motion-safe` で動きを減らす設定の場合は省略し、操作や切断などによる解除は即時のままです。表示・解除用の状態やタイマーは増やしません。盤内縮尺・クリック透過・`role=status` の控えめな読み上げを使い、音・フォーカス移動・寸法変更はありません。観戦と棋譜には接続しません。

エンジンは実装定義と独立した完成図fixtureで16形×4方向×両モードと各必須条件を検証します。Workerは実HTTP・WebSocketの混在接続、確定revision、再接続、インスタンス再作成時のタグ・認証維持、保存分離を検証します。WebはBun＋happy-domと偽時計で、受理前／後、1999ms／2000ms、重複抑止・保存エラー・操作・再接続時の対応確認を検証します。従来の固定棋譜の回帰も維持します。

### 将来の派生解析

囲いなどの派生解析は復元済みの読取り専用局面を入力とする純粋な処理として設計します。入力の出所はゲーム・対局ID・局面位置・保存形式・ルール版で識別し、結果は解析器ID・解析バージョン・対象局面・判定根拠を持つ別データとします。保存された盤面・棋譜・勝敗・撃破数は記録の正本であり、解析結果によって変更しません。解析からGameRoom、storage、D1の更新、戦績SQLを呼びません。解析の再実行も元データを変更せず、版ごとの結果を比較できる構成にします。

16戦型の判定と通信・通知は上記の専用処理で実装しています。本人戦績用の専用成立履歴テーブルは下記の範囲で使用します。戦型別ランキングなど新しい指標とバックフィルは仕様承認、比較検証、再実行可能な移行計画を別途必要とし、Admin KPIは #43 の範囲です。

### 四人将棋シングルスの拡張戦績

通常戦績の `perfectWins` は保存済み結果の単独1位、終局理由 `last_player`、本人の撃破数3をすべて満たす局数です。過去分も通常戦績と同じ対人戦・レート戦の条件で集計します。Webの撃破率は `knockouts / total` を既存の率整形で小数3桁にし、最大3.000・0局は.000です。

`shogiFormationUsage` は解析器ID・解析版3・ルール版1と陣営別の使用ID集合を扱います。対人シングルスまたはレート戦の開始時に `ActiveShogiMatch.formationUsage` を初期化し、人間の確定着手の前後を `detectFormations` で比較します。新規成立の全IDを集合へ追加し、イベント・状態と同じDOトランザクションで保存します。開始時に印がない既存進行局は途中から初期化しません。通知状態・要求クエリ・未確定盤面には依存せず、エンジンの入力・順位・千日手キーを変更しません。

終局で成立履歴を `PendingShogiMatch` へ引き継ぎ、D1 migration 0011の `shogi_match_formations` に対局ID・解析器ID・解析版・ルール版・陣営別ID集合を保存します。成立なしも空集合の行を保存します。全棋譜検証後、本体・本人索引・履歴を同じ最終batchで公開します。履歴の失敗も保存待ちを保持して既存の5秒再送へ戻し、対局IDの一意キーで重複を防ぎます。元の保存JSON・manifest・棋譜形式を維持し、過去分を再解析・補完しません。

`GET /api/account/four-shogi/formation-stats` はCookieで本人を確認し、通常戦績と同じ集計用CTEと成立履歴を結合して全対象局をD1内で集計します。現行解析版の経験済み戦法だけの `{ id, total, first, second, third, fourth }[]` を返します。0件は空配列、未認証401、認証・D1失敗503、`Cache-Control: no-store`です。棋譜ページの取得件数には依存しません。protocolは通信型を定義し、戦法ID・名称・固定Noの正本はエンジンパッケージの軽量 `formation-catalog` 入口です。Webのアカウント画面へ盤面・CPU実装を読み込ませません。

Webは通常戦績と戦法別戦績の取得状態を分け、将棋シングルスの選択時だけ戦法別データを読みます。ゲーム・モード往復では結果を保持し、「更新」は両方を取得、再試行は失敗した側を取得します。ダイアログは共通 `AppDialog` と黄色テーマを使い、選択変更で閉じます。カード画像は添付JPEGをそのまま静的資産として使用し、未経験カードには実名・画像を出しません。画像は `public/four-shogi/formations/` に置き、本番Workerは `/four-shogi/formations/` を `ASSETS.fetch` へ渡します。Worker統合テストで全16画像の配信・HEAD・304と欠落画像の404を確認します。集計開始時点・期間は画面に表示しません。

純粋関数で全16戦法×4方向・同時成立・再成立・入力不変、Workerで確定着手・DO再作成・終局保存と再送・保存失敗時の一括ロールバック・本人/方向/全件/対象外/同率順位/旧データを確認します。Webは独立した取得・エラー・更新・保持・カード秘匿・順位のみのダイアログ・選択変更をDOMテストで確認します。横スクロール・名前の収まり・実画像・ネイティブ入力は手動確認し、ブラウザ自動テストは追加しません。

## バッジ判定と画像

Protocolの `badges.ts` に種類・名称・単位・閾値・表示順と純粋な判定関数をまとめます。ゲーム別シングルスの `AccountStats` から星0〜3、現在値、次の目標を導出します。バッジの現在表示は通常戦績の保存済み対局から導出します。獲得通知だけを下記の専用記録で管理し、WebSocket配信は追加しません。

Webの `AccountStats` は既存hookの結果をバッジ欄と戦績で共有します。公開カードは既存 `readAccountStats` の結果から獲得済みだけを返します。`GET /api/player-profile` は省略可能な `includeBadges=1` を受け、この指定時だけ登録者の応答へ `badges: { id, tier, value }[]` を追加します。未獲得は含めず、ゲスト・CPUには追加しません。無指定時の応答は従来どおりです。Webは追加指定を含めて取得し、400時は通常の取得失敗として扱います。省略可能なバッジ情報がない応答は未獲得と判定せず欄を省略します。既存のキャッシュ期限・無効化・abortと内部ID非公開を維持します。利用可能な高さを超える情報はカード内でスクロールし、カード内のスクロールでは閉じません。

配信用画像は `apps/web/public/assets/badges/` のゲーム別ディレクトリに、種類と星を含む名前の透過256px WebPを18枚置きます。生成原本・修正前の画像は配信に含めません。星3の数字はWeb側で重ね、画像ごとのプレート座標と桁数・描画幅に応じた文字サイズを使います。バッジは再生成せず、元の透過・形・色を保って配信形式へ変換します。

共通 `BadgeImage` は画像のネイティブドラッグを無効にします。マイページの画像は72pxを基本に、651px以上では画像とテキストを横に並べ、小さい画面では縦に並べます。名前・ランク・現在値と次の目標・条件だけを表示し、全段階の閾値一覧と残り件数の重複表示は省きます。

共通 `PlayerBadges` は獲得済み画像だけを56px・間隔4pxの折り返し可能な横並びで表示します。見出し・キャプション・条件の開閉欄・title属性のツールチップは設けません。画像内の星3累計を保持し、画像のaria-labelにはバッジ名・ランク・累計を付けます。各画面のプレイヤー情報カードで同じ部品を使います。

純粋関数テストは閾値直前・到達・超過と星3以降の累計、Workerは過去分・対人戦・ゲーム別集計・同率優勝・完全優勝とAPI互換性、DOMテストは未獲得・獲得済み・モード切替・更新失敗・400時の再取得抑止と手動再試行を確認します。実画像・縮小表示・数字位置・スマートフォン配置・ネイティブ操作は手動確認します。

### バッジ獲得イベントとtoast

Goalは、初獲得・昇格の確定を本人へ画像付きtoastで伝え、通常時の複数取得・遷移・再接続で重複や取りこぼしを防ぐことです。ContextProvidersの優先順位は承認済み指示、AGENTS、READMEのバッジ仕様、開発・テスト文書、Issue #122と既存実装・Git履歴です。Constraintsは既存集計・閾値の維持、D1保存後の本人限定通知、既存HeroUI・画像の再利用、純粋関数／happy-dom／Worker統合テスト、必須ローカル検証とGitHub CIです。Done Whenは閾値・昇格・対象外、最大4種類、移行基準、保存失敗と再送、取得競合と認証、5秒と停止、遷移・復帰・アカウント切替の検証成功、文書更新、レビューできるPRの提出です。画面寸法・実画像・ネイティブ入力・実際の読み上げは手動確認と未確認事項を記録します。

D1 migration `0013_badge_notifications.sql` は `account_badge_awards` と `account_badge_notifications` を作成します。前者はアカウント・ゲーム・種類・星を一意にし、取得時の累計・直前ランク・対局IDを保存します。後者はアカウント・対局ID単位の通知、保存時刻、表示済み時刻、取得tokenと期限を持ちます。導入時の対人戦と、対象拡張時の `0038_rated_badge_baseline.sql` で保存済みレート戦を含む達成段階を基準行として登録します。基準行の対局IDはnullとし、トースト・ベル通知は生成しません。表示用のバッジ取得履歴APIは追加しません。未表示通知に期限を設けず、既存6種類×3段階の最大18取得行／アカウントに収まります。

`badgeAwardsSql` は `matchOutcomesCte` とprotocolの名称・閾値の正本を使います。通常保存は対局本体・本人索引の後、将棋は全棋譜チャンク検証後の最終batchへ `badgeAwardStatements` を追加します。保存された本人索引で対象アカウントを限定して全期間の戦績を集計します。今回の対局も集計対象のシングルスである場合だけ、未記録段階を一意キーで追加して同じ対局の通知を作成します。通知行の失敗も本体・本人索引・取得行と一緒にロールバックし、既存の5秒再送へ戻します。競合する再送の参加者情報は使わず、確定済み対局・索引を参照します。星3以降の累計更新は新規取得行を作りません。通知の画像内累計は取得時点の値で、マイページの現在値は従来どおりです。

本人向けの `POST /api/account/badge-notifications/claim` はUUIDのtokenを受け、最古の未表示グループだけを15秒間貸し出します。アカウントをCookieで確認し、同一Originを必須にしてno-storeで応答します。同時の別tokenは取得できず、同一tokenは再取得・延長できます。返却は `{ notification: { id, game, badges: { id, tier, previousTier, value }[] } | null }`。同一種類で複数段階を超えた場合は最高ランクだけを返します。

`shown`・`renew`・`release` はtokenと通知IDを受けます。表示済み記録・延長には未失効の取得権を必須とし、別アカウントからの指定は拒否します。shownの成功応答を失った同一tokenの再送は成功扱いです。表示前の非表示化はreleaseし、終了やログアウトで未表示の取得権が残っても15秒後に再取得できます。未認証401、Origin不正403、入力不正400、取得権失効409、認証・D1失敗503です。

`AccountLayout` 内の `BadgeNotificationProvider` はアカウント単位の取得状態と共通toastキューを保持します。認証確認済み・表示中に5秒ごと、online・表示復帰時と既存toast終了時にも取得し、同時取得を防ぎます。認証の再確認中・失敗中は新しい通知を取得せず、取得応答の到着時にも確認待ちならreleaseします。HTTPは10秒で中止して再試行し、通知の取得失敗で対局や既存UIを止めません。画面のOutlet変更では状態を破棄しません。取得後に非表示なら表示せずreleaseします。実際のtoast内容の描画後にshownを送信し、失敗時は再送と取得権延長を行います。失効時は再取得へ戻り、同じ画面で既に表示したIDは再演せず記録だけを再試行します。別タブ・端末の抑止はサーバーの取得権・表示済み記録を使います。

`AppToastRegion` は既存のHeroUI外観・位置・幅と既定の積み重ねを共有します。バッジは既存toastが終わってから取得し、同じ対局の全種類を1つにまとめ、別対局は順に取得します。バッジのタイトル・ゲーム名・画像列は中央揃えとし、折り返した行も中央に並べます。バッジは5秒、既存チャット・コピーは3秒です。HeroUIが非表示・ホバー・フォーカスを独立した停止理由として残り時間を管理します。バッジ内容のrole=status・aria-live=politeを指定し、画像は装飾として扱い、文字でゲーム名・種類・星・累計を伝えます。アカウント切替時は退出アニメーション中も本人内容を隠し、取得を中止して古い応答を無視します。新しい依存・外部サービス・通知音は追加しません。

Workerの `badgeNotifications.test.ts` は全段階、ゲーム別集計、同時4種類、過去基準、保存ロールバック・再送、取得競合・失効・解放、Cookie・Origin・入力・本人制限を確認します。Webの同名DOMテストは画像と順序、初獲得・昇格文言、表示後の記録、5秒境界、非表示・表示復帰・フォーカス停止、別対局の順次表示、認証確認待ち、遷移、通信失敗、失効からの復旧、ログアウト・切替・StrictModeの古い応答、既存通知との共用を確認します。
