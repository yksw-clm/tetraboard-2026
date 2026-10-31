# ローカル四人将棋AIの夜間学習

## Goalと境界

`bun run ai:nightly`で、完全棋譜の生成、P0-5教師、データ集合、Policy/Value学習、ローカル検討、独立比較と昇格保留までを継続可能にする。学習成功、推論速度、棋力改善は別の判定とする。G0は従来P0-5、公開Lv1/Lv2と既定v5/root/guard OFFは維持する。

依存PR #266は開始時未マージ、HEAD `99289c1b137ad774b15dcba7aca25dbcf071c29d`、作業ツリーはclean。`feat/ai-nightly-learning`をこのHEADから分岐し、別のstacked PRでレビューする。マージ・デプロイ・履歴改変を行わない。

## ContextProvidersと棚卸し

- 正本はREADME、`rules/four-shogi.md`、`four-shogi-ai-engine.md`。TSの完全状態・合法手・終局判定を再利用する。
- `bench/selfPlay{Data,Game,Run,Store,Inspect}.ts`は固定work、固定CPU、共通MaxN/MCTS、全履歴、毎手atomic保存、排他、checksum、厳密resumeとseed分割を実装済み。既存教師は共通AIでありP0-5ではない。
- `trainingExport.ts`は単一datasetを再生検査して学習入力へ出力する。複数datasetの無検査連結は未対応。
- `training/four-shogi-ai`は既存tinyモデル、CPU/MPS学習、optimizer/RNGまでの同一run復元、Python CPU常駐推論を実装済み。異なる入力へのwarm startと世代管理は未対応。
- `studySearch.ts`と検討runtimeはP0-5の二段階選択探索を実装済み。共通AIのモデル接続をP0-5接続と同一視しない。
- 過去のsmokeは4局すべて千日手、Value32件すべて単独勝者なし。量だけを増やして勝利学習成功にしない。

## 事前計画・比較条件

変更前の混合CPU2局を`.study-measurements/nightly-baseline-99289c1`へ凍結する。train41701/validation51701、禁止ON、共通work128/延長0と固定Lv2、最大512手、教師work256/8局面、60秒上限。打切りと終局を分ける。

1. CPUプロフィールとP0-5固定work運転を追加する。既存探索器・候補比較を使い、単一workerの決定的運転と実アプリの4worker/5秒を区別する。予算中断の未完成比較は教師にしない。
2. 不変datasetから検査済み集合snapshotを作る。元manifest/棋譜は変更せず、全系列・回転・prefix・局面のsplit横断を拒否する。train/validationだけを日常学習へ渡す。
3. 同一run resumeの契約は維持する。warm startは新runへ親の重みだけを読み込み、optimizer/RNGを初期化し、親checkpoint SHAを固定する。
4. P0-5のモデル経路は明示指定だけ。Python常駐IPC、batch、モデル複製費用を測り、tiny構造の同値なローカル推論が有益なら補助配布形式として比較する。元checkpoint/推論形式を壊さない。
5. 世代選択でjob/cache/評価を分離する。候補は研究用として選択でき、G0へ戻せる。
6. 夜間CLIは生成→教師/検査→snapshot→品質gate→学習→推論検証→比較→昇格/保留を直列に運転する。全工程の完了・失敗・中断を保存する。

通常の品質gateはtrain/validationの独立系列、各方向の単独勝ち教師、十分な終局数を要求する。初回smokeの少量・偏った教師で完全なG1を作らない。別の明示的engineering/policy-only試験は昇格不可とする。

棋力比較は学習seed外の開発比較系列（100000以上の正式holdoutは使わない）を実行前に登録する。4席のscreen後、別系列16対応条件を再確認する。5秒・4worker・4096MiB・root・guard OFF・禁止ON、固定Lv2三体。比較系列は学習入力から永久に除外する。少なくとも単独勝ち+3局、平均確定順位0.25改善、全局終局、重要40/40・既知8/8、合法性/モデル実使用/停止/資源gateが必要。少数例・未終局・未測定gateは保留。統計的有意差の保証とはしない。

## Constraintsと中止条件

- 全てローカル。新しい主要依存、オンライン自動着手、クラウド計算を追加しない。ルール、評価係数、fixtureを変更しない。
- 初期は並列1・探索最大4worker・総6時間・観測RSS6GiB程度。空き容量不足、版不一致、モデル不正、履歴/漏洩不整合では新しい書込み/学習を止め、確定済み成果を保持する。
- 上限・取消・signal時は子孫を回収する。排他とatomic更新を使う。OSの厳密な資源保証とは呼ばない。
- 正式test/calibration/holdoutは調整に使わない。実勝敗・順位は正本結果だけから作る。
- 実装のための最初の測定は短いsmokeと少数実局に限定する。6時間バッチを直ちに開始しない。

## Done Whenとコミット

独立コミットを、計画、P0-5プロフィール/教師、集合/品質、継続学習/世代、P0-5推論、世代UI、比較/昇格、nightly運転、最終文書/検証の順にまとめる。各段階は実テストと短い測定で確認し、不採用・未達を残す。

必須はBun/Pythonの実プロセス、完全再生、教師合法性、warm start/resume、集合漏洩拒否、モデル世代/旧job隔離、G0回帰、DOM操作、全check/build/dry-run/study:build、最終HEADのCI確認。人間操作やブラウザ起動を自動テストで代用しない。

実測結果と採否は`four-shogi-ai.md`、利用者の手順は`NIGHTLY-RUNBOOK.md`へ記録する。データ不足で一巡を止めた場合も、停止工程と必要な追加教師を明示する。

## G1品質改善の事前登録（2026-10-31 14:11〜19:00 JST）

開始HEADは`9361c23`、clean、PR #270/#266は未マージ。現役G0と旧candidate/checkpoint/26局の原本を保全し、新しい測定は`.study-measurements/g1-quality-20261031-9361c23`へ保存する。

最初に同じ既知8局面・固定work1000000/深さ9・broad3/root24/幅6/deep応手2/自手3/延長2/cache1024で、G0・Policyのみ・Valueのみ・両方を比較する。各方式を版と条件で識別し、根/broad/deep/PVと自手成り継続の選別を観測する。モデル/なしの既定動作とfixture/期待手は維持し、fixtureを学習へ使わない。

教師はprefix上限による初期局面偏重を仮説とし、全棋譜の時期別/重要局面被覆と、固定work・同一総CPUでの追加予算を独立比較する。Valueは同じ不変snapshot・seed19000/32-8幅/batch4/lr0.001でstep数を先に比較し、必要ならtrainだけの系列/クラスsampling、loss比を一つずつ調べる。クラス別recall/confusion/macro-F1と系列数を報告し、局面数を独立対局数に読み替えない。

候補は重要40/40・既知8/8・合法/完成/実使用/期限/RSSを通過してから5秒/4workerの性能・新規開発系列の席替えへ進む。正式16対応条件、単独勝ち+3・確定順位0.25改善の昇格基準を緩和しない。未達はG0維持。重大な異常や利益のない仮説は中止して証拠を残す。

各重工程は直列・soft6GiB/hard7GiB/空き10GiB、既存の独立watchdogを用いて18:55までの絶対時刻へ予算を制限する。18:15に方式追加を収束、18:40以降は新しい重測定を開始せず、18:55までに所有プロセスを停止し19:00で作業を終了する。最終検証・CI未完はそのまま報告する。
