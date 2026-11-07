# TetraBoard AI

フェーズ0〜1のRust Workspaceです。四人リバーシの**脱落のない4人シングルス**について、ルールエンジン、Lv1〜3のAgent候補、席順を変えた自動対局Benchmarkを提供します。[フェーズ1の設計・比較条件](docs/phase1.md)に評価と探索の定義を記載しています。レベル名は実装候補の識別用で、棋力の順序を保証しません。

ゲームの正本は[四人リバーシルール](../../docs/rules/four-reversi.md)です。[対応ルールと検証範囲](docs/rules-four-player-reversi.md)に確認元コミットと対象範囲を記載しています。既存CPU・探索・評価・Benchmarkの移植や流用は行っていません。TypeScriptのルールエンジンは比較テストだけから参照します。

## 準備と実行

リポジトリルートで`mise install`と`bun install --frozen-lockfile`を実行します。Rust 1.99.1、rustfmt、Clippyはルートのmise設定で管理します。Rustの識別子・ファイル名にはRust標準のsnake_case、コメントには日本語の丁寧体を使います。

```sh
# リポジトリルートから実行します。
bun run --cwd packages/ai check
bun run --cwd packages/ai bench --games 100 --seed 0 > /tmp/tetraboard-ai-seed0.jsonl
bun run --cwd packages/ai bench --config configs/phase1.json --rounds 32 --seed 0 > /tmp/tetraboard-ai-phase1.jsonl
```

Cargoから直接実行する場合は、このディレクトリで次を実行します。

```sh
cargo fmt --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked
cargo run --release --locked -p tetraboard-ai-benchmark -- --games 100 --seed 0
```

`--games`は1以上のu64整数、`--seed`はu64整数です。既定値は1局・seed 0です。不正・不足・重複した引数は非ゼロ終了し、`--help`は使用方法を表示します。

設定ファイルのパスはCLI実行時の作業ディレクトリから解決します。上記の`bun run --cwd`では実行ディレクトリが`packages/ai`になります。

`--config`モードでは`--rounds`がseedの数です。1roundに各組合せの4回転を実行し、同梱の4組合せでは32roundで512局になります。`--games`とは併用できません。seedはCLI指定を優先し、省略時は設定ファイルの値、roundsは省略時1です。

## 責務と境界

| crate                     | 責務                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| `tetraboard-ai-engine`    | `four_reversi`モジュールの局面、合法手、着手、自動パス、終局と順位 |
| `tetraboard-ai-agents`    | 共通Agentインターフェース、設定、ランダム・1手評価・MaxN探索       |
| `tetraboard-ai-benchmark` | 4席のAgentによる完走、席順ローテーション、順位・勝率・速度の集計   |

Engineは乱数・時計・通信に依存しません。局面は8×8の固定長配列、4色の列挙型とし、`State::initial()`、`legal_moves()`、`apply_move()`で進めます。着手は元の局面を変更せず、更新後の局面・反転座標・自動パス色を返します。`PositionSetup`は確認用の局面構築入力で、全4色の存在・手番の合法手・補助情報を検査しますが、初期局面からの到達可能性は保証しません。任意のサービス局面を受信するAPIではありません。

`legal_move_counts()`は全4色の合法手数を返します。Agentは`Agent::decide(&State) -> Decision`を共通入口とし、選択手とノード数・完了深さ・予算中断の診断を返します。`build_agent`は設定を検査してAgentを生成します。壁時計はBenchmarkだけが測定し、探索終了条件には使いません。

Rust内のJSON表現はfixture・計測ログ用です。既存protocolや保存棋譜のJSON契約を置き換えません。将来の外部AI ServiceではGame Roomが対局状態・手番・合法手・勝敗の最終権限を持ち、Rust側は候補手を計算する責務とします。

6ゲームは必要になった時点でゲーム固有モジュールを追加します。汎用Game trait、HTTPサーバー、Python、学習用バインディング、モデル推論の依存はまだ導入しません。

## 再現可能なログ

標準出力は1局1行のJSONL、CargoとCLIの診断は標準エラーへ出力します。失敗は非ゼロ終了し、途中までの成功行だけで全局成功とは扱いません。stdoutへの書き込み失敗もエラーです。

これは`--games`モードの版1ログです。設定ファイルを使うモードは版2で、各対局を`record_type: "game"`として`game`内へ記録し、最後に`record_type: "summary"`を出力します。対局レコードは組合せ、round、回転、元のlineup slotとprofileを持ち、summaryには全設定、件数・失敗率、組合せ・profile・色別（color nullは全色合計）の平均順位・1位率・単独/同率1位率・平均石数、意思決定時間の平均・p50・p95・最大、ノード総数・予算中断数を含めます。失敗した席も出場数・失敗率に含め、順位・速度の平均には含めません。全失敗時の平均はnullです。

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

フェーズ1では評価・探索・設定・席順・統計のテストも追加しています。BunはさらにLv1〜3混在の4組合せ×4回転を再生し、ノード上限とsummaryも確認します。未確定の対象ルールは現時点でありません。ダブルスと脱落後の進行は既存仕様が確定していますが、今回の実装対象外です。次はフェーズ2の外部AI Service最小接続です。通信契約・ホスティング・学習方式・強さの境界は後続フェーズの未決定事項です。
