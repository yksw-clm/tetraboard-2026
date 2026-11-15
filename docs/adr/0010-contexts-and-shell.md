# 0010 文脈の境界と Worker の殻の形

- 状態: 承認済み（2026-11-15）。[0003](0003-contexts-and-drizzle.md) の「境界はフェーズ 3 の冒頭で確定します」を具体化します。ゲームの扱いは [0011](0011-game-contract.md) に従います。

## 状況

2026-11-15 の develop を読んで分かったことです。

- `apps/worker/src` の実装は 128 ファイルあります。ディレクトリは `rooms`、`accounts`、`matchmaking`、`tournaments`、`privacy`、`lobby`、`announcements`、`feedback`、`notifications`、`usageEvents`、`kpi`、`admin`、`db` です。
- ディレクトリと責務が合っていません。
  - `rooms` に、棋譜の保存、レートの計算、ランキングの API、通報が入っています。
  - `accounts` に、棋譜の読み取り、戦績、バッジ、ルームの席の予約が入っています。
- `gameRoom.ts`（5,273 行）は、1 つのイベントの中で同じルームの状態を何度も読み直し、検証し直しています。期限の処理では、Alarm の確認を少なくとも 4 回待ちます。外部への反映（索引、席の解放、大会への反映）は非同期で始まりますが、次のイベントがその完了を待ち直します（`docs/communication-performance.md` の C02、C04、C05）。
- 「1 アカウント 1 席」は、ルームの席（`account_room_seats`）、マッチングの待機（`matchmaking_wait_reservations`）、大会の待機（`tournament_wait_reservations`）の 3 か所にまたがっています。今は、トリガーのフェンスと、`roomAccounts.ts`、マッチングと大会の coordinator の処理で守っています。
- 守るべき不変条件が、`docs/communication-performance.md` と `docs/development.md` の「〜の実装計画」の節に散らばっています。

## 決定

### パッケージの形

- 文脈ごとに 1 つの workspace パッケージにします。置き場所は `packages/contexts/<文脈>/`、名前は `@tetraboard/context-<文脈>` です。
  - パッケージの依存は `package.json` に書くので、別の文脈を import すると依存の宣言が必要になり、レビューで気づけます。
  - 文脈のパッケージが依存してよいのは、`@tetraboard/context-shared`、`@tetraboard/game-contract`、各ゲームのパッケージ、`@tetraboard/protocol` の型だけです。protocol からは `import type` だけを許し、zod の schema は使いません。検証は殻が受け持ちます。
- 各パッケージの中は `domain/` と `use-cases/` に分けます。
  - **domain**: Cloudflare に依存しない純粋な型と関数です。
  - **use-cases**: domain を使って 1 つの操作を行う関数です。保存先などは、use-cases の側で定義したインターフェース（ポート）で受け取ります。

### 文脈と、今のファイルの行き先

| 文脈 | 受け持つこと | 今のファイル |
| --- | --- | --- |
| room（対局ルーム） | 席、待機、開始、進行（ゲーム契約の呼び出し）、時計、CPU の予定と外部 AI のジョブ、再戦、ルームの索引、席の台帳（1 アカウント 1 席） | `rooms/` の `gameRoom`、`*Progress`（ゲーム契約へ）、`clock*`、`*Clock`、`roomDeadlines`、`roomIndex`、`roomRoutes`、`aiService*`、`cpuCapacity`、`applyRoomSettings`、`waitingRoomFactories`、`matchSequences`、`progressHelpers`、`gameProgress`、`eventGameStore`、`shogiStore`、`standardShogiStore`。`accounts/roomAccounts` |
| matchmaking（マッチング） | レート戦の待機列と組み合わせ、CPU の補充 | `matchmaking/` の全部（`ratingStore` を除く） |
| tournament（大会） | 大会の定義、エントリー、対局の割り当て、勝ち点と順位 | `tournaments/` の全部、`rooms/tournamentRoom` |
| account（アカウント） | 認証、ゲスト、登録の流れ、ゲストの引き継ぎ、プロフィール | `accounts/` の `auth`、`guest*`、`registration*`、`accountRoutes`、`currentProfiles`、`playerProfileRoutes`、`profileDetails`、`timestamps`。`rooms/registrationTypes` |
| rating（レート） | Elo と skill の計算、保留、ランキング | `rooms/` の `*Rating`、`eloRating`、`rankingRoutes`、`ratedTimeControls`。`accounts/profileRatings`、`matchmaking/ratingStore` |
| record（棋譜） | 棋譜の保存と再送、読み取り、本人の履歴と戦績、使用戦型、バッジ | `rooms/` の `*MatchStore`、`matchStore`、`shogiMatchUploads`、`normalizeLegacyShogiState`、`publicMatchRoutes`、`shogiFormationUsage`、`fourShogiFormationAnalysis`。`accounts/` の `*MatchData`、`matchDataContracts`、`matchRoutes`、`matchClaims`、`matchKinds`、`matchOutcomes`、`matchProfiles`、`statsRoutes`、`formationStatsRoutes`、`badge*` |
| community（コミュニティ） | ロビーと大会のチャット、通報、お知らせ、フィードバック、通知 | `lobby/`、`announcements/`、`feedback/`、`notifications/` の全部、`rooms/reportStore` |
| privacy（プライバシー） | 退会、同意、規約の表示、画像の削除 | `privacy/` の全部 |

殻（`apps/worker`）に残すもの: `worker.ts`、`scheduledMaintenance`、`publicAssets`、`roomShareHtml`、`admin/`、`usageEvents/`、`kpi/`、`db/`、`fourShogiDiagnostics`。

- 席の台帳は room に置きます。マッチングと大会は、待機の予約を、殻の流れを通して room の席の台帳に問い合わせます。
- ルートのファイル（`*Routes`）は殻に置き、入力の検証と応答の整形だけを行って use-case を呼びます。表の「今のファイル」は、中の処理がどの文脈へ移るかを示します。

### 殻の形

`apps/worker/src` を次のように分けます。

| ディレクトリ | 中身 |
| --- | --- |
| `routes/` | Hono のルート。入力を protocol の schema で検証し、use-case か流れを呼び、応答を整形します。 |
| `durableObjects/` | 4 つの DO の殻（`GameRoom`、`MatchmakingCoordinator`、`TournamentCoordinator`、`CpuCapacity`） |
| `adapters/<文脈>/` | ポートの実装（drizzle の D1、DO の kv と SQLite、外部 AI） |
| `flows/` | 複数の文脈にまたがる処理。例: 終局 → 棋譜の保存 → レートの更新 → 大会の勝ち点 → バッジ → 利用イベント |
| `usageEvents/`、`kpi/`、`admin/`、`db/` | 今のまま |

### DO のイベントの流れ

DO の殻は、1 つのイベント（HTTP、WebSocket のメッセージ、Alarm）を次の順で処理します。

1. 状態を 1 回だけ読み、protocol の schema で検証します（C05）。
2. use-case を呼びます。use-case は、新しい状態と、起こすこと（配信、外部への反映のジョブ、次の期限）をデータで返します。
3. 新しい状態と外部への反映のジョブを、同じ `transactionSync` で保存します。
4. 応答と配信を返します。
5. Alarm は、イベントの最後に 1 回だけ、状態とジョブから最も早い期限を計算して合わせます（C02）。
6. 外部への反映（D1 の索引、席の解放、大会、棋譜の保存）は、保存したジョブとして非同期に進めます。次のイベントは、ジョブの順序を守る必要があるものだけを待ちます（C04）。ジョブは今と同じく、失敗したら 5 秒後に再送し、ルームが閉じた後も残します。

### 通信の改善候補の扱い

| 候補 | 扱い |
| --- | --- |
| C02、C04、C05 | 上の「DO のイベントの流れ」で解消します。 |
| C06（作成と参加の通信の数） | サーバー側では、ルームの作成と参加の応答に、ルームと本人の資格を含めます。web 側でその応答を使う変更は、フェーズ 4 で行います。操作できるようになる条件（WebSocket の本人認証の後）は変えません。 |
| C07（ゲストの本人確認の D1 往復） | account の adapter で、本人確認の SELECT と期限の UPDATE を 1 回の batch にまとめます。最終利用から 180 日の期限の仕様は変えません。 |
| C10（最近の対局の索引） | スキーマの目標形（TB-58）で索引を足します。 |

### 維持する契約の行き先

- 次の契約は、文脈を移す PR で `docs/specs/<文脈>.md` に書き、それを守るテストを同じ PR に入れます。
  - 退会を受け付けた後の資格の失効と、旧名や画像の再表示の防止
  - 全ルームで 1 アカウント 1 席。席の予約の再試行と、取り消しのフェンス
  - 部屋の世代、局 ID、局面の版による古い応答の破棄
  - 再接続。認証の障害をゲスト扱いにしないこと
  - CPU の最低 2 秒。時計を守るための「同期探索 → 保存 → 次の Alarm で期限を再確認」の構成
  - 索引の版、保存の 5 秒ごとの再送と閉鎖後の保持、古い席の解放で新しい席を消さないこと
  - 大会の開始と結果の確定
- `docs/development.md` の「大会の実装計画」「プライバシー・規約・退会の実装計画」「ルーム共有の実装計画」は、その文脈を移す PR で不変条件を仕様へ移してから消します。
- `docs/communication-performance.md` は、room の殻を作り直す PR で消します。

### 移す順序

フェーズ 3 のタスクは、次の順で 1 PR ずつ進めます。

1. 土台: `packages/contexts/shared`、`packages/game-contract`、文脈のパッケージの雛形、依存の向きを検査する lint を作ります。
2. ゲーム契約: 五目並べを試験的に移し、残りの 5 ゲームを移します（ADR 0011）。
3. room の殻: `GameRoom` を「DO のイベントの流れ」に作り直し、`gameRoom.ts` からゲームの分岐をなくします。
4. record: 棋譜の保存と読み取りを移し、棋譜をイベント形式へ変換します（ADR 0011）。
5. rating: レートのテーブルを方式ごとに統合します。
6. matchmaking と tournament
7. account、community、privacy。退会と非表示のフェンスのトリガーを最後に移します。
8. migration を 1 本にまとめます。

## 却下した案

- **1 つの `packages/contexts` パッケージにまとめ、ディレクトリだけで分ける。** 別の文脈を import しても何も起きず、依存の向きを守れているかをレビューでしか確かめられません。
- **文脈が protocol の zod の schema を使う。** 文脈のテストに zod が入り、検証の場所が殻と文脈に分かれます。
- **use-case が D1 や DO を直接呼ぶ。** Cloudflare なしでテストできなくなり、0003 の目的に合いません。
- **DO のイベントごとに外部への反映の完了を待つ。** 今の C04 の遅れがそのまま残ります。

## 影響と未決

- パッケージは 10 増えます（文脈 8 つ、`context-shared`、`game-contract`）。ルートの `package.json` の workspaces に `packages/contexts/*` を足します。
- 文脈は protocol の型を使うので、web と通信する形が変わると文脈の型も変わります。
- 外部への反映のジョブのうち、次のイベントが完了を待つ必要があるものはどれかを、room の殻を作り直すタスクで、ジョブごとに確かめます。
