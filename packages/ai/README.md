# TetraBoard AI

フェーズ0のRust Workspaceです。四人リバーシの**脱落のない4人シングルス**について、ルールエンジン、固定seedのランダムAI、自動対局Benchmarkを提供します。

ゲームの正本は[四人リバーシルール](../../docs/rules/four-reversi.md)です。[対応ルールと検証範囲](docs/rules-four-player-reversi.md)に確認元コミットと対象範囲を記載しています。既存CPU・探索・評価・Benchmarkの移植や流用は行っていません。TypeScriptのルールエンジンは比較テストだけから参照します。

## 準備と実行

リポジトリルートで`mise install`と`bun install --frozen-lockfile`を実行します。Rust 1.99.1、rustfmt、Clippyはルートのmise設定で管理します。Rustの識別子・ファイル名にはRust標準のsnake_case、コメントには日本語の丁寧体を使います。

```sh
# リポジトリルートから実行します。
bun run --cwd packages/ai check
bun run --cwd packages/ai bench --games 100 --seed 0 > /tmp/tetraboard-ai-seed0.jsonl
```

Cargoから直接実行する場合は、このディレクトリで次を実行します。

```sh
cargo fmt --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked
cargo run --release --locked -p tetraboard-ai-benchmark -- --games 100 --seed 0
```

`--games`は1以上のu64整数、`--seed`はu64整数です。既定値は1局・seed 0です。不正・不足・重複した引数は非ゼロ終了し、`--help`は使用方法を表示します。

## 責務と境界

| crate                     | 責務                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| `tetraboard-ai-engine`    | `four_reversi`モジュールの局面、合法手、着手、自動パス、終局と順位 |
| `tetraboard-ai-agents`    | Engineから得た合法手から一様に抽選する`RandomAgent`                |
| `tetraboard-ai-benchmark` | 4席のAgentによる完走、処理時間計測、CLIとJSONL出力                 |

Engineは乱数・時計・通信に依存しません。局面は8×8の固定長配列、4色の列挙型とし、`State::initial()`、`legal_moves()`、`apply_move()`で進めます。着手は元の局面を変更せず、更新後の局面・反転座標・自動パス色を返します。`PositionSetup`は確認用の局面構築入力で、全4色の存在・手番の合法手・補助情報を検査しますが、初期局面からの到達可能性は保証しません。任意のサービス局面を受信するAPIではありません。

Rust内のJSON表現はfixture・計測ログ用です。既存protocolや保存棋譜のJSON契約を置き換えません。将来の外部AI ServiceではGame Roomが対局状態・手番・合法手・勝敗の最終権限を持ち、Rust側は候補手を計算する責務とします。

6ゲームは必要になった時点でゲーム固有モジュールを追加します。汎用Game trait、HTTPサーバー、Python、学習用バインディング、モデル推論の依存はまだ導入しません。

## 再現可能なログ

標準出力は1局1行のJSONL、CargoとCLIの診断は標準エラーへ出力します。失敗は非ゼロ終了し、途中までの成功行だけで全局成功とは扱いません。stdoutへの書き込み失敗もエラーです。

各行に次の情報を含みます。

- `format_version`、`ruleset_version`、`engine_version`、元seed、局番号、対局seedと導出方法
- 席順と各席の`agent_id`、乱数方式・seed・streamを含む`agent_config`
- 初期局面、全着手の合法手一覧・選択手・反転座標・パス・意思決定時間・探索ノード数と試行回数
- 最終局面、終局理由、得点・順位・勝利と同率1位、対局総時間
- 実行OS・CPUアーキテクチャ、実行時のソースコミットと未コミット変更の有無（取得できない場合はnull）

`game_seed = seed.wrapping_add(game_index)`、streamは黒0・白1・赤2・青3です。`rand_chacha 0.9.0`の`ChaCha8Rng::seed_from_u64`とstreamを使い、`rand 0.9.2`のu32範囲抽選で合法手の添字を選びます。合法手は上から左からの固定順です。依存は`Cargo.lock`で固定します。バージョンを更新するときは再現性を確認し、系列が変わる場合はAgent ID・乱数設定も更新します。

同じコード・依存・seed・局番号から棋譜と結果を再現できます。`decision_time_ns`、`total_time_ns`、`environment`は比較から除きます。計測値は壁時計の待ち時間を含み、乱数系列には影響しません。Engine版はcrate版です。コミットだけで未コミットの実装は特定できないため、比較実験にはcleanなコミットとlockfileを使います。

順位は同点人数分だけ次順位を飛ばします。単独・同率とも順位1なら`won: true`、同率1位には`shared_first: true`を記録し、シングルスの引き分けは作りません。ランダムAIの`search_nodes`と`trials`は0です。総時間は対局処理とログデータ構築の範囲で、プロセス起動・JSONエンコード・出力を含みません。性能目標や棋力の保証はまだ設けません。

## テストと次の段階

8組の固定fixtureをRustとBunで照合します。初期局面からの到達を要しない合成局面も含みます。期待値は確認元TypeScriptのルール処理から一度固定し、テスト実行時には再生成しません。Rustでは8方向の反転、局面構築の拒否、Agentの決定性、引数処理、100seedの完走と再現性・石数・順位を検証します。BunではRust CLIが出力した100局をTypeScriptルールで再生し、全着手の合法手・反転・パスと最終結果を比較します。

ルートの`bun run check`とFull CIはこのworkspaceも検証します。`typecheck`はBunの比較テストの型検査、Rustの整形とClippy（型検査を含む）、`test`はRustテストとBunの比較テストを実行します。Rust・lockfile・fixtureの変更はFull CI対象です。

未確定の対象ルールは現時点でありません。ダブルスと脱落後の進行は既存仕様が確定していますが、今回の実装対象外です。次はフェーズ1として位置・角・機動力などの評価関数、浅い多人数探索、席順と相手構成を変えた比較を行います。共通Agentインターフェースと探索予算はその実装に合わせて設計します。外部Serviceの契約・ホスティング・学習方式・強さの境界は後続フェーズの未決定事項です。
