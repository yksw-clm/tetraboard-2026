# 四人将棋AIのローカル夜間学習

この機能はMac内で棋譜とモデルを蓄積する研究用です。学習候補の作成・推論の動作確認・棋力向上・昇格を別々に判定します。公開CPU、既定v5/root/ガードOFF、オンライン対局には接続しません。

## 初回の準備

Python 3.12、Bun、既存requirementsのPyTorch 2.14.1が必要です。リポジトリのルートで実行します。

```sh
bun install --frozen-lockfile
python3.12 -m venv training/four-shogi-ai/.venv
training/four-shogi-ai/.venv/bin/python -m pip install -r training/four-shogi-ai/requirements.txt
bun run ai:nightly --help
bun run ai:nightly --dry-run
```

Pythonを別の場所へ用意した場合は、`AI_PYTHON`へ実行ファイルの絶対パスを指定します。Python/依存を夜ごとに入れ替えません。同じrunの再開はコード・環境・設定の一致が必要です。

既定保存先は`~/tetraboard-ai`です。`AI_DATA_DIR`または`--root=/専用保存先`で変更できます。無関係なファイルがあるディレクトリは初期化しません。生棋譜・モデル・ログはGitへ追加しません。

## 最初の短い確認

```sh
bun run ai:nightly --smoke
bun run ai:nightly --status
```

smokeは3分・2局・最大128手・少量教師です。教師不足なら`held`で終了します。手数打切りを勝敗教師にはしません。

配線の実学習まで確認する研究者向けの指定は`--smoke --engineering`です。少なくともtrain側の実終局Valueが必要です。品質gateを満たさないモデルは「動作試験用」で保存し、**昇格しません**。これをG1の棋力完成と呼びません。Policyのみを試す場合は設定で`engineering:true, policyOnly:true`を明示し、Value未学習を記録します。

## 毎晩の実行

```sh
caffeinate -i bun run ai:nightly
```

電源へ接続して蓋を開けて運用します。`caffeinate -i`も蓋を閉じた場合のスリープを保証して防ぐものではありません。

設定を変える場合は[設定例](training/four-shogi-ai/nightly.example.json)をコピーし、`--config=/設定.json`を指定します。翌夜の新しいrunへだけ変更を適用します。

初期条件は自己対局並列1、P0-5固定workの着手4096・教師16000、禁止ON、train2系列/validation1系列×2混合CPU構成×4席、最大512手、教師最大24局面/局です。固定Lv2、共通MaxNのwork128/1024、現役世代のP0-5を混ぜます。棋譜生成と追加教師解析は直列です。

P0-5の固定work運転は既存`createStudyRootSearch`と候補選別を使用する**単一プロセスのfirst-pass運転**です。広い比較から主要3根へ進み、既定深さ9で止めます。アプリの4worker/壁時計による候補巡回と同じスケジューラーとは主張しません。運転版・全条件・実消費workを記録します。共通MaxNとP0-5は別のCPUプロフィールです。

研究用設定`teacherSelection:"trajectory-importance-v1"`は、確定した全棋譜を正本で再生し、序中終盤の各枠から時系列の錨と王手・成り・捕獲・脱落の局面を採ります。終局ラベルは選別に使いません。元棋譜は変えず、新しい派生datasetへ教師を保存して選別を再検査します。既定は比較用の従来`prefix-v1`です。旧runへ設定を足してresumeせず、新しい夜へ適用します。

学習は32/8幅の既存tinyモデル、1000step、batch4です。同じ構成のCPU/MPS比較を各夜に記録し、`device:auto`では完走した速い方を選びます。`device:cpu|mps`を指定した場合は勝手に切り替えません。前世代があれば重みだけを初期化に使用し、optimizer/RNGは新run用に初期化します。親のvalidation集合も別に評価して忘却を監視します。

## 停止・再開・翌夜

Ctrl+Cで停止します。保存済み棋譜・checkpointは維持し、子プロセスを回収します。

```sh
bun run ai:nightly --resume
bun run ai:nightly --status
```

`--stop-after=generation`などで確定工程の直後に止め、再開を試せます。再開は最新の未完runを使用します。Bun/OS/コード/教師条件などが変わった場合は拒否します。Pythonのcheckpointはデータ・依存・学習条件も厳密に検査します。失敗原因の修正でソースが変わった場合は、旧runを保持して新しい夜を開始します。

`held`/`completed`は終了済みです。翌夜は`--resume`を付けずに開始し、新しい不変datasetとsnapshotを作ります。直近8夜の教師datasetを再利用し、古いデータも削除しません。新しい入力へ旧runのresume検査を無効化して読み込むことはしません。

一夜の工程時間の累積上限は初期6時間です。通常の休止中は消費に含めません。親が強制終了して計測できなかった区間は、再開時に保守的な壁時計時間として計上します。スリープからの復帰後も期限を再確認します。OS/同期処理による瞬間的な超過を厳密には保証しません。

## 品質gateと昇格

train/validationの独立系列、Policy件数、**各方向の実単独勝利Value**を要求します。trainは2系列・Policy64件・各方向8Value、validationは1系列・Policy16件・各方向2Valueが初期の運用gateです。これは学習可能性の最低確認で、十分な棋力データの認定ではありません。「単独勝者なし」も第5分類として変更せず集計します。

未終局・打切りはValue対象外です。合法手マスク・完全履歴・Policy・PV・版・checksum・系列/回転/途中棋譜・split漏洩をTSで検査します。日常snapshotはtrain/validationだけを使用し、calibration/test/正式holdoutを調整へ取り込みません。

比較seedは生成前に登録し、学習から分離します。固定Lv2三体、禁止ON、4worker/root/4096MiB/ガードOFF、自手番5秒でscreen4対応条件、その後別の16対応条件を比較します。未完局を順位や勝敗へ補完しません。

昇格にはデータ品質、モデル実使用、合法性、期限/資源、重要戦術40/40、既知8/8、独立再確認の完了、単独勝ち+3局・平均確定順位0.25改善が必要です。結果不足や退化は保留です。この暫定基準は統計的有意差や優勝級の証明ではありません。候補は保存し、現役を指す`current.json`は通過時だけatomic更新します。

## ローカル検討で使う

既定保存先なら、そのまま起動します。

```sh
bun run study
```

保存先を変更した場合は同じrootを指定します。

```sh
AI_DATA_DIR=/専用保存先 bun run study
```

`http://127.0.0.1:5198`を再読込みし、「設定」→「評価モデル」から実在する候補/昇格済み世代を選びます。学習世代を選ぶとP0-5が選択されます。候補は研究用で、未校正Valueを勝率とは表示しません。モデル切替で新しい解析を開始し、旧モデルの結果・保存PV・矢印を混ぜません。フォーカスも同じ世代の局面へ限定します。

この変更を取り込む前からアプリが動いている場合は、元の端末でサーバーも終了して起動し直します。新しい候補を作った後は画面を再読込みして一覧を更新します。

読込み障害は明示し、「評価モデル」をG0へ戻して再解析できます。学習モデルと致命応手ガードの併用は拒否します。PONDERは既定OFFのままで、今回のモデル品質検証を通過した組合せとは扱いません。オンラインへの自動着手はありません。

## 資源・保存物・復旧

- 観測RSSは初期6GiBで停止、hard側7GiB、空き容量10GiBを予約します。Macのメモリ圧迫も監視します。これは共有ページの重複計上を含む観測で、OSのhard limitではありません。
- 重い工程は直列です。相手/教師/学習/比較のCPU・実時間・RSSを区別します。CPUのpsサンプルは短命プロセスを取りこぼす下限で、GPU時間・電力量ではありません。workerのCPUは復元開始から最後の通知までで、起動前や終了後の全費用を含むとは主張しません。
- 独立watchdogも親の生存と絶対期限を監視し、所有する工程のプロセス群だけを停止します。明示停止・失敗・期限を完了へ置き換えません。強制終了/電源断時の未確定一時ファイルは採用しません。
- `reports/night-XXXX/summary.md`と`summary.json`、`runs/night-XXXX/state.json`で実施済み工程・保留・失敗を確認します。各工程のJSON、log、`*-resources.json`、SHA-256付き完了receiptを保持します。
- summaryは新規棋譜と蓄積snapshot、教師、最終train/validation指標、推論・戦術・比較、資源を別々に集計します。未実行はnullです。`events.jsonl`は中断・失敗・再開の履歴を残します。
- `datasets/`は正本棋譜と追加教師、`snapshots/`は不変の集合、`generations/`はcheckpoint/モデル/世代manifest/戦術/比較です。元の世代・棋譜を上書きしません。
- 二重起動を拒否します。残留ロックは所有PIDの終了を確認して回復し、生存中のPIDや他のアプリを停止しません。壊れたmanifest/checksumを手で書き換えて通過させません。
- 現役モデルが破損してnightlyが停止したら、成果物を退避して原因を調べます。検討画面はG0を選べます。`current.json`を退避してG0へ戻す場合も、夜間バッチを停止してから行い、元ファイルを削除しません。
- ディスク不足では新しいバッチを始めません。古いデータの自動削除はしません。必要なバックアップ/容量確保は利用者が確認して行います。

## 開発検証

初回100step候補は重要40/40を通過しましたが、既知の成り継続が1/8に退化しました。Valueもvalidation全件で「単独勝者なし」を選んでいます。現役はG0を維持し、この候補は研究用途へ限定します。手動で現役参照を書き換えて昇格させません。測定条件と未達は[初回一巡の記録](docs/four-shogi-ai.md#ローカル夜間学習の初回一巡2026-10-31)を参照してください。

必要なBun/DOMテストは通常checkに含めます。Pythonの実テストは次のとおりです。`/学習入力`はsnapshot、`/モデル`は推論配布先、`/fixture.json`は生成済みの基準入力です。

```sh
training/four-shogi-ai/.venv/bin/python training/four-shogi-ai/trainingTest.py /学習入力
training/four-shogi-ai/.venv/bin/python training/four-shogi-ai/inferenceTest.py /モデル /fixture.json
bun run check
bun run build
bun run --cwd apps/worker deploy:dry-run
bun run build:development
bun run --cwd apps/worker deploy:dry-run:development
bun run study:build
```

実測と未達事項は[AI測定記録](docs/four-shogi-ai.md)、契約と事前計画は[夜間学習の設計](docs/four-shogi-ai-nightly.md)を参照してください。PRのマージ・デプロイは別の明示承認が必要です。

### Value多数クラス偏重の研究用比較

単体の`train.py`は`--value-weighting=inverse-frequency`で、trainの確定結果の逆頻度をValue損失へ適用できます。既定は`none`で、通常nightlyの設定は変更しません。validationは重みなしで評価し、クラス別recall・confusion・macro-F1・予測分布を保存します。重みを変えた比較は新しいcheckpoint保存先で始めてください。同じrunのresumeで条件を変えることは拒否されます。分類性能の改善だけでは昇格しません。
