# 四人将棋シングルスAI・解析エンジンの実装計画と契約

> 状態: Issue #184のD01〜D05は2026-10-14に開発者がすべて推奨案で承認。承認済みの設計契約、現行仕様、後続の未決事項を区別する。最終確認日: 2026-10-16。完全状態復元・静的評価の共通AI・再開可能な自己対戦/探索教師生成を実装。軽量Policy/Valueの学習・保存・再開とLinux CPU推論/Mac出力照合も実装。共通MaxⁿのPolicy/Value実使用・従来/fallback比較・モデル教師生成も実装。モデルは実験用で、VPS接続・公開CPU・解析画面は後続。

[親Issue #183](https://github.com/yksw-clm/tetraboard-2026/issues/183) の計画を実装へ渡すための文書。現在の合法手・手番・勝敗と現行Lv1/Lv2は [四人将棋ルール正本](rules/four-shogi.md)、共通の時計・参加・棋譜公開は [README](../README.md) を参照する。D01〜D05の推奨案を採用する。具体的なAPI型・推論形式・設定値は後続Issueで検証し、未決事項を推測で確定しない。利用者向け変更とCPU採用仕様は、実装時に対応する正本へ反映する。

## Goalと承認済みの前提

2026-10-14の開発者の依頼・補足に基づく前提は次のとおり。

- 四人将棋シングルス専用。三人攻撃禁止ON/OFFを両方扱う。
- 最終目標は、連盟主催大会の優勝者クラス3人を同時に相手に、**1局で単独1位を狙える棋力**。複数局の大会総合得点、平均順位、同率1位、本人が他3人全員を撃破する「完全優勝」とは別に判定する。
- 次の一手、上位2〜5候補の比較、各手番者を示した読み筋、4人の形勢・暫定順位、王手・詰み・駒損・次の自手番までの危険を扱う。
- 対局CPU・解析・教師生成は共通AIを使い、思考予算を調整する。0.5秒CPU・30秒解析は予算例であり、応答時間・棋力向上の保証ではない。
- 推論・対局CPU・解析ジョブの実行はVPS上。重い計算実験、自己対戦・教師生成、Python/PyTorch学習はMac等の計算環境で行う。初期機器はM5 MacBook Air 24GB/512GB。VPSプラン、CPU/GPU構成、契約・配置は未確定で、Linux CPU実行を初期計画の検証対象とする。
- 初期開発は着手から1か月以内を目標とし、探索・解析・自己対戦・学習・評価の一巡を合格条件とする。学習済みモデルをLinux CPUの共通探索で実際に使用するところまで含む。
- 現行Lv2超え、優勝者級の棋力、勝率表示の信頼性は別々に測定する。独立対局で信頼性を確認するまで勝率％を表示しない。
- コーディングエージェント主体で進める。既存TypeScript/Bunルールエンジンを再利用し、Pythonに合法手・遷移を再実装しない。

## ContextProvidersと文書の責務

| 参照先                                                      | この計画での用途                                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| [AGENTS.md](../AGENTS.md)                                   | 承認、ブランチ、PR、必須検証                                         |
| [README](../README.md)                                      | 共通仕様、既存CPUの最低待機・時計、棋譜・認証・公開範囲              |
| [四人将棋ルール正本](rules/four-shogi.md)                   | 現在のルール状態、現行CPU、三人攻撃・脱落・千日手                    |
| [構成文書](architecture.md)                                 | 現在のCloudflare/DO/D1と責務分担                                     |
| [開発文書](development.md#四人将棋シングルスaiの実装前整理) | 実装の入口、変更先と進行手順                                         |
| [テスト方針](testing.md#四人将棋シングルスaiの契約確認)     | 後続実装の検証分担                                                   |
| [既存AIの測定記録](four-shogi-ai.md)                        | 過去の比較条件・対象コミット・採用判断。現在の新AI仕様へ書き換えない |

仕様調査の基準はdevelop `40fe0d94c8fd31c8b814cbd7220b39706c6e7be8`。後続Issueでは着手時の最新developと正本を読み直す。新しい契約と長期参照する判断はこの文書へ集約し、実験データの保管だけを目的に文書・フォルダを増やさない。

## 結果ラベルと評価の意味

| 区分                  | 定義・扱い                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 単独1位               | 正本のシングルス終局結果で1位が1人。現行規則では最後の生存者による `last_player` と整合する。撃破した人数は条件に含めない |
| 同率1位・単独勝者なし | 反復・合意・全生存者脱落など、単独勝者がない確定終局。生存者だけ同率1位となる場合と、既に確定した下位順位を区別する       |
| 未終局・中断          | 計算実験の手数・時間上限、中断、失敗。ルール上の引き分けや「単独勝者なし」の教師ラベルへ置換しない                        |
| 探索効用              | AIが手を選ぶ目的。単独1位を主目的とし、引き分け・下位順位の副目的はD01で決める                                            |
| 探索評価              | 指定した評価関数・モデル・相手の行動仮定・予算による評価。初期の駒得等を含む値を勝率と呼ばない                            |
| 暫定順位              | 評価から推定した優劣・順位。確定順位を上書きせず、同評価の同率や不確実性を許す                                            |
| 単独1位確率           | 相手群・思考予算・ルール・モデルを指定した予測。校正前の数値は探索内部の実験に限定する                                    |

Valueの初期案は「南・西・北・東の単独勝ち＋単独勝者なし」の5分類。4人の単独1位確率の和は100%以下となり得る。順位は必要なら別の補助出力にし、勝利ラベルと混ぜない。初期の出力形式・損失・特徴量は [#190の学習契約](#軽量policyvalueの学習とチェックポイント190)で実装しました。棋力と校正の達成は別に検証します。

現行Lv2は同率1位も即勝利として優先し、終局の1位へ同じ評価を与える。現行仕様に沿う動作であり、今回の目的との差として扱う。新AIの即勝利判定と教師ラベルは単独勝者を区別する。また現行Workerの `cpuDraw` は生存する人間全員の引分提案へCPUが同意する。現行Lv1/Lv2の同意は維持し、新AIの同意は承認済みD01に従って#194で実装する。

## ルールの境界と連盟との照合

初期実装でどのルールを使うかはD02、優勝者級との実戦条件はT04で扱う。対象となる連盟の現行ルール全文・大会・持ち時間が未指定のため、以下の未確認項目を推測で埋めない。

| 項目           | TetraBoardの現在仕様                                                            | 連盟側の確認状態・後続対応                                                                      |
| -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 三人攻撃       | ONは4人生存中の攻撃履歴・免除を判定、脱落後は解除。OFFも対応                    | 指定された2022年PDFを基準に機械判定の補完を承認済み。対象の実戦で使う規定・補完との一致は未確認 |
| 手番・複数王手 | 毎回実際の王手・生存者から次手番を決め、予約列・補填手番なし                    | 対象規定の全境界は未確認。固定4手を一巡として探索しない                                         |
| 詰み・同時脱落 | 同じ盤面で全員の詰みを確定して一括脱落・同順位                                  | 同時詰みの裁定との一致は未確認                                                                  |
| 脱落駒・持ち駒 | 盤上駒が残り、裏王は固定障害物。脱落者の持ち駒は廃棄し、生存者へ継承しない      | 方式による相違が既存調査にある。対象の移転・点数規定は未確認                                    |
| 順位・終局     | 最後の生存者が単独1位。撃破数は順位へ影響しない                                 | 対象が生き残り方式か、別の終了条件を持つか未確認                                                |
| 反復・合意     | 同一ルール状態4回で引き分け、連続王手も引き分け。生存者全員の提案で合意引き分け | 現行正本はTetraBoard独自の採用仕様と明記。対象の裁定は未確認                                    |
| 投了・時計     | 自手番で投了、人間/CPU共通時計、CPU最低2秒待機                                  | 個別運用を別途確認する。例示大会の条件を共通仕様へ移さない                                      |

既存調査の根拠は [正本の調査資料](rules/four-shogi.md#調査資料と相違点)。2026-10-14に再確認した [夏の早指し祭2026](https://shogitter.com/champ/yoninshogi-2026-summer) は5分切れ負け・三人攻撃等を不採用・投了しない個別設定を示す。この大会を今回の評価対象と決定したわけではなく、連盟の全大会に同じ条件を当てはめない。

違いが判明した場合は、対象プロフィール・合法手・イベント再生・教師/モデル/キャッシュの版を分ける変更案を開発者へ提示する。現在の `rulesVersion: 1` の意味や過去棋譜を黙って変えない。ON/OFFの対応は共通モデルでも可能だが、入力・合法手・データ・結果を区別する。

## 承認済みの構成と責務

以下はD03で承認した構成。具体的な分割・推論方式は担当Issueで検証する。VPS推論とMac等学習の方針は承認済みで、TetraBoard本体の全面VPS移行は [#128](https://github.com/yksw-clm/tetraboard-2026/issues/128) の別検討とする。

| 部分           | 配置・責務の案                                                                                   | 判断・確認するIssue                                                               |
| -------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| ルール正本     | `packages/four-shogi`。合法手・実手番・遷移・終局・履歴                                          | #186。既存公開APIと棋譜の互換性を確認                                             |
| 新AIの共通入口 | `packages/four-shogi-ai` を追加する案。既存探索を再利用し、予算・候補/PV・評価器注入・診断を扱う | #187/#188/#192。移動/抽出の必要性を確認し、ルール→新AI→ルールの循環依存を作らない |
| VPSサービス    | `apps/four-shogi-ai` を追加する案。Bun/TypeScriptのHTTP・ジョブ受付と独立した計算worker          | #193。長時間探索で受付/取消を塞がないことを確認                                   |
| モデル推論     | 同じホストの永続Python/PyTorch CPUプロセスへモデル評価をまとめて依頼する                         | #191のLinux実測で初期方式を選定。VPSの配置・同時数は後続                          |
| 学習・実験     | `training/four-shogi-ai` にPythonの学習CLIを置く案。TS側で生成/検証したデータを利用する          | #189/#190。重い処理を通常checkから分離                                            |
| 対局進行       | 現在のWorker/DOが時計・現在状態・着手受理・保存を管理し、VPSへ計算だけ依頼する                   | #194。待機中も時計/切断/投了を進める                                              |
| 棋譜解析       | Web→権限検査したWorker→VPSの経路。保存済み終局棋譜を復元して読む                                 | #195。棋譜・勝敗・戦績の正本を更新しない                                          |

パッケージ配置は新しい独立実行部分の責任を示す案で、空のパッケージや将来用の抽象化を先に実装しない。既存探索の再利用・抽出でAPIの互換を守り、現在の `chooseCpuAction` の同期契約へ非同期モデル推論を混ぜない。新AIのCPUと解析を共通入口へ接続し、現行Lv2は比較/fallback用の固定版として別に識別する。

PyTorchの配布はモデル定義を版付きコードで固定し、重み `state_dict` とmanifestを合わせてロードする方式。[PyTorch公式資料](https://docs.pytorch.org/docs/2.14/notes/serialization.html#saving-and-loading-torch-nn-modules) は互換性のため重み保存を推奨する。#191で必要ランタイムと誤差許容値を定め、下記のLinux CPU実測で照合する。ONNX等の新たな主要依存の採用時には理由と影響を示す。探索ノードごとのプロセス起動やMacへの遠隔推論は行わない。

## 共通APIの契約案

次の項目は後続実装が境界を共有するための案。具体的なTypeScript型・JSONスキーマ・URLは#186/#187/#193で確定し、スキーマ版とfixtureで互換性を検証する。

### 入力・復元・識別

- 入力は初期配席/設定＋連番イベントから復元した完全な状態、またはWorkerが渡す同等の内部状態と基底反復履歴。表示frameは `repetitions` を除いているため、そのまま解析入力にしない。
- 合法手を変える攻撃関係・標的駒対応・解除待ち・取り返し免除、生存者・確定順位、引分提案、現在の手番、枝と基底の反復文脈を扱う。拒否された操作・仮探索の状態を元履歴へ書き戻さない。
- `ruleProfileId`、`rulesVersion`、ON/OFFとシングルス、復元形式/イベント位置を明示する。未対応の設定は拒否し、既定ONへ黙って補完しない。
- `stateHash` は盤面だけでなく結果/合法手に影響する設定・履歴を正規化して識別する。既存千日手キーの流用だけで設定・基底履歴を区別できるとは仮定しない。計算と通信で同じfixtureを使う。
- 対局CPUには局ID・部屋世代・revision・担当方向と時計/期限を別の要求文脈として渡す。棋譜解析には対局ID・イベント位置/番号・保存形式を付ける。
- エンジンへ時計/接続/アカウントを持ち込まない。VPSへ渡す参加者表現は方向への不透明な対応だけとし、名前・画像・認証Cookie・参加資格を送らない。

### 完全解析状態の復元API（#186）

`@tetraboard/four-shogi/analysis` は通信・保存から独立したシングルス専用の関数API。ルール版1を既存エンジンで再実行する。`@tetraboard/four-shogi/replay` のイベント裁定はWebの版1再生も共用し、公開frame・保存JSON・ゲームルールは維持する。HTTP経路・認証・VPS配置は#193以降で接続する。

| 関数                                         | 契約                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `restoreAnalysisPosition(input: unknown)`    | 入力を検証・コピーし、指定イベント位置の完全な`AnalysisPosition`を非同期で返す                              |
| `getAnalysisLegalActions(position)`          | 復元済み局面の実手番に対する読取り専用の合法手。終局なら空配列                                              |
| `advanceAnalysisPosition(position, event)`   | 着手・外部脱落・引分提案/取消を仮適用し、新しい完全状態・hash・イベント位置を返す。元局面・棋譜は変更しない |
| `createAnalysisCacheKey(position, identity)` | 局面hashとコード/解析/モデル版・解決済みの解析条件を合わせたSHA-256。キャッシュ自体は実装しない             |

```ts
import { restoreAnalysisPosition, getAnalysisLegalActions } from "@tetraboard/four-shogi/analysis";

const position = await restoreAnalysisPosition({
  schemaVersion: 1,
  ruleProfileId: "tetraboard-four-shogi-singles-v1",
  rulesVersion: 1,
  initial: {
    mode: "singles",
    players: { south: "s", west: "w", north: "n", east: "e" },
    threePlayerAttackProhibited: true,
  },
  events: [],
  eventOffset: 0,
});
const actions = getAnalysisLegalActions(position);
```

入力のschemaVersion・プロフィール・rulesVersion・初期値・`{ index, event }`配列は必須。初期値のモード・四方向の異なる非空ID・ON/OFFを明示し、設定省略を既定ONへ補完しない。未知の版/プロフィール・ダブルス・余分な項目・不正な座標/イベントを拒否する。初期IDは対局内の不透明な対応に限定し、VPSへ送る際の本人情報除去は呼び出し側の責務とする。

eventOffsetは0から提供配列長までの**イベント数**で、省略時は全提供イベントを適用する。着手数と異なり、提案・取消・外部脱落も数える。配列は0始まりの連続indexと全要素の形状を検証し、指定位置までの裁定を再実行する。配列は完全棋譜でも対象位置までのprefixでもよく、未提供の後続や指定位置より先の合法性は検証済みと扱わない。ページ取得側は従来どおり対局/世代・初期値・版・件数・連番・最終状態を照合する。`AnalysisInputError`のcodeで拒否理由を識別し、適用失敗には0始まりのeventIndexを付ける。

出力は `analysisStateVersion: 1`・プロフィール・ルール版・eventOffset・stateHash・完全なFourShogiState。全反復辞書、攻撃理由/標的駒/解除待ち、取り返しマス、持ち駒、実手番、確定順位、引分提案を保持する。出力と合法手は深く凍結し、入力イベントの可変参照を共有しない。仮遷移のeventOffsetは仮に延長した系列の位置であり、元の保存棋譜の位置を更新しない。

stateHashは `analysisStateVersion`・プロフィールと、参加者IDを除く全内部状態をJSONキー順で正規化し、UTF-8のSHA-256で計算する。盤上駒ID/次ID・手数・直前手も保持するので、意味が同じ局面を保守的に別hashとする場合がある。全反復辞書とON/OFFを含め、制限解除後も区別する。参加者対応・対局ID/世代/revision・時計は要求文脈で照合し、stateHashだけで着手を受理しない。

合法手/仮遷移/キャッシュ識別へ渡せる局面は同じ実行内でこのAPIが復元・作成したものだけ。表示frame・手作り状態・JSONへ直列化した局面の再読込みを代用せず、別実行では版付き初期値とイベントから復元する。Workerの部分反復辞書/lookupを持つ内部状態の入口は後続で完全履歴との同等性を確認して接続する。

キャッシュ識別のidentityには非空のcodeVersion・analysisVersion、不変のモデル版を指すmodelId（従来評価はnull）、JSONオブジェクトのparametersを渡す。parametersへ特徴/行動/評価/探索版、思考予算・幅/深さ、相手仮定、seed等の**解決済み全条件**を含める。省略条件をこの関数が推測せず、#187以降の要求解決側が条件をそろえる。キー順は正規化し、非有限数・undefined・関数・循環参照・深すぎるJSONを拒否する。

既存の固定棋譜の初期/途中/終局・省略形旧データを変更せず照合する。通常初期配置からの固定32手反復系列、盤面/手数/直前手が同じで履歴だけが異なる二系列、既存棋譜の49イベント目のON/OFF合法手差を検証する。モデル入り探索・大量自己対戦・VPS接続の合格は入力APIの完了と別に判定する。

### 予算・モデル・結果

| 入力/出力   | 契約案                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 予算        | `timeBudgetMs`、`maxWork`、候補数2〜5、必要な深さ/候補幅・探索方式。時間と処理量の両方で止め、長時間時にも固定の深さ上限だけで早期終了しないよう測定する |
| 中止        | 呼び出し側の取消を受付/計算/モデル推論へ伝え、最後に完了した結果と打切り理由を分ける                                                                     |
| モデル      | 登録済み `modelId` を要求で指定し、開始時に固定。利用者から重みパス/外部URL/コマンドを受けない                                                           |
| 推奨手/候補 | 元局面の合法手。合法手が2件未満ならその件数。候補ごとの4人評価、完了深さ/訪問量/打切り状態を付ける                                                       |
| 読み筋      | 各手の実際の担当方向と着手。元局面から正本で再生できる。相手の行動仮定に基づく例として扱う                                                               |
| 評価/順位   | 固定した方向順、`evaluationKind` と評価器/探索版、暫定順位/同率・不確実性。異なる深さ/尺度を隠して比較しない                                             |
| 危険        | 正本で確定した王手・現在の詰みと、探索が予測する脱落/駒損を区別し、根拠局面・担当方向・読めた範囲を付ける                                                |
| 確率        | 初期UIは非表示。校正版・対象ルール/相手群/予算・検証状態が一致する結果だけ将来表示する                                                                   |
| 診断        | code/engine/search/model/feature/action/evaluation版、loadedModelIdと実使用modelId、推論回数、work/depth、取消/打切り/fallback理由                       |

候補比較と「実際に指した手」の比較は同一局面・同じ視点・同じ評価/モデル/相手仮定で行う。上位外の実戦手も再解析できるようにし、予算や読みの量が異なる場合は結果へ残す。PV中で手番が変わったことを理由に、比較する本人の値を別人の値へ入れ替えない。

### 共通AI・解析API（#187）

公開入口は `@tetraboard/four-shogi/ai` の `analyzePosition(position, options, control?)`。#186で復元した同一実行内の `AnalysisPosition` を使い、CPU・解析・教師生成が同じ `recommendedAction` を利用する。学習済みモデルの接続は下記#192を使う。HTTP・対局への着手確定は後続Issueで実装する。

```ts
import { analyzePosition } from "@tetraboard/four-shogi/ai";

const result = await analyzePosition(
  position,
  {
    codeVersion: deployedCommit,
    timeBudgetMs: 500,
    maxWork: 2048,
    candidateCount: 3,
  },
  { signal: controller.signal, onProgress: reportProgress },
);
const action = result.recommendedAction;
```

`codeVersion` は呼び出し側が実際のビルド版を指定する。`modelId` の省略/nullは従来静的評価で、featureVersion/seedは従来の未使用表現を保つ。#192では非nullの不変モデルIDと評価器を指定できる。ロードだけで実使用を偽装せず、requested/loaded/usedと推論件数を区別する。解決済み設定、版、入力の完全状態hashで `cacheKey` を作り、ON/OFF・基底反復履歴・比較指定手も分離する。結果キャッシュ保存はまだ実装しない。`eventOffset` は要求文脈にも残す。

探索と評価の初期内部仕様は[ルール正本のCPU節](rules/four-shogi.md#cpu)を参照する。`maxWork: 2048`、`maxDepth: 64`、`width: 6`、`rootWidth: 24`、`extensions: 1`、`cacheSize: 256`、`candidateCount: 3`、`timeBudgetMs: null` が内部既定。深さは1〜256、幅/処理量は正の安全整数、延長は0〜4、候補数は2〜5、根の幅は候補数以上、時間は非負の有限ミリ秒またはnull。30秒の指定でも処理量・深さに先に達すれば終了する。時間を主に比較する実験では処理量/深さ上限も明示して増やす。これらは棋力を認定した公開CPUレベルではない。

根の全合法手を同じ深さ1で評価し、完成した候補群を公開する。以後は同じ選択集合を同じ深さで比較する。上位候補と捕獲・王手を中心に絞り、内部の王手中は全応手を残す。候補/その部分木に幅制限があれば `selective`、反復途中の中断は `cutoff`。`completedDepth` は通常探索の手数で、終局ならPVは短く、戦術延長なら長くなり得る。候補ごとの `iterationNodes/iterationWork` は最後に完成した反復に使った量で、全探索量と分ける。省いた手も含めた最善の証明には使わない。

候補の並びは常に元手番者の効用で比較する。PVの各手はその実手番者が自身の効用を最大化する例であり、同点は元の合法手列挙順。二人生存も同じMaxⁿで、相手の値を根の負値に置き換えない。旧Lv2のαβ・定跡・敵が別の撃破を選んでも即脱落を危険視する規則は旧入口に保持し、新探索へ暗黙に持ち込まない。#188のキャッシュ・明示的な別応手の危険検査・MCTS実験は次節を参照する。

`staticEvaluation` は元局面の静的評価、`evaluation` はMaxⁿでは推奨候補のPV末尾から伝播した評価、MCTSでは完成試行の平均。候補の `lineEvaluation` は読み筋末尾の静的/終局評価であり、平均と区別する。未完了fallbackでは後者と候補評価はnull。終局入力では確定評価を返す。固定順は南/西/北/東で、各人の `primary`、副比較の `secondaryRank`、非終局の `heuristicScore` を分ける。未校正なので `probabilities` は常にnull。暫定順位と脱落/終局の確定順位を `kind` で区別する。

上位外の実戦手は `includeAction` へ元局面の合法手を指定し、根の絞込みへ追加する。上位一覧のほか `comparedAction` にMaxⁿでは同じ完成深さ、MCTSでは同じ設定の試行平均/訪問量を返す。予算が足りず完成候補群がない場合はnull。非合法手を解析用の仮着手に置き換えない。全候補のPVは正本で再生でき、各手に実方向・着手・次手番・王手・捕獲・その手の脱落/終局を含む。

`currentDanger` は元局面の王手と既に確定した脱落。候補の `danger` は `pv_example`・`forced: false` とし、PVの根拠を次の自手番/自分の脱落/終局まで、または読めた末尾まで返す。`horizon` は次の自手番まで読めていない。王手・詰み理由・駒損はその進行で正本が判定した事実であり、相手が別の手を選んでも成立する保証とはしない。根拠局面は入力stateHashとPVの `afterPly` で再現する。

時間は単調時計で、識別計算・合法手確保・探索・ホストへのyieldを含む。計上操作の前後で期限/取消/処理量を検査し、128処理単位または約8msごとにホストへ譲る。`AbortSignal`、注入する `isCancelled`、テスト用 `now/yieldToHost`、凍結した `onProgress` を扱う。進捗には全探索量・完了深さ・最後の完成候補群があり、部分評価を上位比較へ混ぜない。

workは合法手生成の開始・着手遷移・探索内の静的評価各1と、生成後の16合法手ごと1。キャッシュ命中は照会1、再生成の16手分を加算しない。MCTSは完成試行の各経路節点の逆伝播も1ずつ数える。処理量の比較と同じ壁時計での比較は別に記録する。元局面の合法手確保と静的評価は取消/予算0でも行い、この準備はworkによる打切りの対象外。evaluationsには元局面の評価1回も含む。ルールAPI1回の内部処理と結果の組立ては分割できないため、壁時計の厳密な応答上限は保証しない。準備欄の `legalPreparationMs`（元局面の静的評価も含む）、elapsedMs、`deadlineOverrunMs` を残す。診断のelapsedMsは最終の凍結コピー直前、性能CLIのelapsedMsはAPIの応答までを含む。VPSでの強制終了・並列枠は#193の別責務。

打切りでは最後に完成した深さの候補群を返す。一度も完成しなければ、最初の合法手1件をdepth0・評価null・空PV・`fallbackReason: no_completed_iteration` で返す。候補数が1件なのは完成比較がないことを示し、薄い候補を2〜5件の評価済み一覧に見せない。終局/合法手なし/取消は異なるstatus、期限/処理量/最大深さ/試行数上限/単独即勝利はstopReasonで区別する。取消や期限後のfallbackを実対局へ適用してよいかはWorkerが別に照合する。

少数性能測定は `bun run --cwd packages/four-shogi bench:analysis --time-ms=500 --max-work=100000000 --max-depth=128 --repeats=1 --output=/tmp/analysis-500.json`。#185の初期/seed301の12手開始系列を復元し、ON/OFFの共通API全体、実設定・版・候補幅・完了深さ・打切り・RSSを記録する。手作り持ち駒局面は復元済み入力へ代用しない。モデル/IPC/待ち行列は未実装/該当なし。重い測定・棋力判定は通常checkに入れない。

### 探索の戦術・速度とMCTS比較（#188）

新AIの内部既定はMaxⁿ、延長1手、状態キャッシュ256件。解析版は `singles-analysis-v2`、探索版は `selective-maxn-v2`、評価版は `sole-first-heuristic-v2`。現行Lv2の既定値・同率即勝利・αβは維持し、旧測定を新しい条件へ書き換えない。調整・同時間比較の結果と採否は[測定記録](four-shogi-ai.md#シングルス専用aiの限定探索実験188)へ残す。

Maxⁿは実際の次手番で反復深化し、王手/捕獲を幅で除かず、王手中は全応手を残す。根が脱落した枝は単独勝ち効用0と順位が確定した時点を葉にする。残る人の値はその局面の静的評価で、対局全体の終局評価には置き換えない。`completedDepth` は完成した反復の通常深さで、終局・根の脱落ではPVが短く、戦術延長では長くなり得る。実際に読んだ担当方向/手数/脱落と確定・暫定順位を併記する。

キャッシュは同一実行の同じ不変状態参照だけをWeakMapで識別し、合法手・確定遷移・評価・手順序を共有する。盤面だけの文字列キーへ履歴を落とさず、別入力/ON・OFF/枝の反復を合流しない。`cacheSize: 0` で無効化でき、最大2048状態まで。件数・legal/transition/evaluation/orderingの命中を診断する。MCTSの木自体の節点数やプロセス全体のメモリを、このキャッシュ件数の上限と混同しない。

`moveOrdering: "previous"` は前の完成反復の有望手を先に調べる実験設定。幅で残す集合と同点時の元列挙順は維持する。既定は `"tactical"`。`evaluationWeights` は解決済みで識別へ含め、既知の非負有限係数だけを受ける。生存人数加点 `survival` は0に固定する。非有限の積算を拒否し、非終局の主指標は浮動小数点でも0と1の間へ収め、確定単独勝ちと同値にしない。未校正の勝率を出力しない。

`dangerWork`（既定0）を指定すると、深さ1時点の上位候補と `includeAction` の各枝へ均等な小予算を割り当て、次の実自手番・根の脱落・終局までの別の合法応手を調べる。全体のmaxWork/時間/取消の内側で実行する。幅では応手を省かず、`dangerPlies`（既定8、1〜16）の地平も区別する。深い探索で新たに上位へ入った未検査手はnullのまま。

`danger.alternatives` は `possible_legal_replies`、完了/未完了・work/ply/interruptedの制限理由、訪問量、根の脱落/飛車損の証拠となる合法手列を返す。王手で手番が飛ぶ場合も正本の次手番へ従い、幾何的に取り返せる別人へ勝手に手番を渡さない。`complete` は指定した次自手番までの範囲を調べた意味で、以後の安全や相手の実選択は保証しない。複数の相手が常に協力する探索へ既定方針を置き換えず、4人評価への順位加点/危険の重みを暗黙に加えない。

`algorithm: "mcts"` は `vector-uct-experiment-v1` の実験設定。UCTの主成分＋探索項は[Sturtevantの多人数UCT論文](https://webdocs.cs.ualberta.ca/~nathanst/papers/multi-player_UCT.pdf)を参考にし、実手番者の成分で選ぶ。4方向の値をそのまま逆伝播し、二人生存でも符号反転しない。順位は主成分が完全に同じ場合だけ副比較する本計画のD01に従う。有限の幅/予算と打切り静的評価を用いる実験で、論文の極限での性質を有限予算の棋力保証へ転用しない。

MCTSも全根候補の浅い比較を先に完成させ、初回の比較前には合法fallbackを返す。根集合へ完成試行が一通り入るまでは、この完成済みの浅い比較を残す。以後は `comparisonKind: sample_mean`、`evaluationKind: sample_mean`、`visits` を返す。途中試行を平均へ混ぜない。`completedDepth: 1` は浅い全根比較の完了だけを表し、深い全読みの完了ではない。`simulations/maxVisitedPly` と実PVを別に診断する。有限サンプルの結果は常にselectiveとし、確率はnull。

読み筋は実際に訪れた木から各担当者の平均効用で選ぶ進行例。平均は複数の末尾から集計したものなので、`lineEvaluation` をその平均と一致させて偽装しない。探索係数 `exploration` は既定1.4、非負有限値。seedは0〜2³²−1、既定0。ロールアウトは一様な合法手を既定2手（0〜32）、木の深さはmaxDepth。`maxSimulations` は既定10000（1〜1000000）。モデル付きは#192のMaxⁿで扱い、MCTSへの非null modelIdは明示的に拒否する。Maxⁿでは実使用seedはnull、MCTSでは指定seedを版情報へ返す。

比較入口は `bench:search`。`--kind=factors|performance|matches`、`--budget=work|time --amount=<単位またはms>`、比較方式・反復・系列数・手数上限を明示する。時間比較は両方式を同じ制限にし、処理量1億/試行100万は保護上限として停止理由を検査する。#185の開始生成/結果ラベル/席回転/系列単位集計を再利用し、新調整seed18800台と独立した構図を使う。過去のvalidation手筋と最終seed100000以降は調整で使わない。重い比較は通常check外。未終局を引分へ変換せず、少数系列の観測値を棋力達成や校正と判定しない。

### 相手モデルとモデル配布

Maxⁿ/MCTSは各節点の実手番者が自身の効用を高めることを基本候補とする。常に他3人が完全協力する探索を既定にしない。王手・即脱落の戦術検査を併用し、相手モデルID・同評価手の選び方・seedを測定条件へ残す。より複雑な相手別学習は初期一巡の必須条件に追加しない。

二人生存時も、引き分けを含む各人の単独勝ち予測がゼロ和とは限らない。モデルの4人値を深さごとに符号反転したり、相手の効用を根の評価の負値とみなしたりせず、実手番者自身の効用で候補を比較する。現行のαβを再利用する場合は、新しい効用との等価性を確認できる設定に限る。実装・実験は#187/#188/#192で、反復による引き分けを含む値の伝播を検証する。

manifest案にはモデルhash/形式・対応するruleProfile/ON/OFF・featureVersion/actionVersion・方向/行動対応・学習code/data/split/seed・依存版・評価記録の参照を持たせる。学習再開checkpointと推論配布物を区別する。ロード時に互換性・有限値・方向/行動対応を検査し、非互換なら理由を返す。

MacとLinux CPUで共通fixtureの出力を比較し、モデル入り/従来評価/fallbackを区別する。学習が完了しても正常系でモデル評価が呼ばれていなければM1合格にしない。評価レポート作成までは自動化し、実運用モデルの更新・昇格・切り戻しは承認された運用で行う。

## VPSジョブ・認証・障害時の契約案

### ジョブの状態と期限

1. Workerが本人/用途/使用量/入力を検証し、`requestId` と入力識別・要求モデル・予算・期限を付けて送信する。
2. VPSは認証と対応版を検査し、上限内で `queued → running → completed` を管理する。`cancelled`、`expired`、`failed` を別状態にする。受付は重い計算と独立させる。
3. CPUと解析の優先度を分け、CPU用の計算枠を確保する案とする。CPUが後から来た場合にも長い解析1件で全枠を塞がないよう、枠分離または中止可能な分割を測る。
4. 同じrequestId・同じ入力/モデル/予算は重複実行しない。違う内容でのID再利用は拒否する。取消済み/期限切れの要求を再送だけで復活させない。新しい解析には新IDを使う。
5. 要求時のモデルを実行中に切り替えず、応答へinputHash/実使用モデル/版/打切り理由を返す。解析キャッシュは入力履歴・設定・相手モデル・予算/品質・各版を区別する。
6. CPU応答はWorker/DOが現在の局・世代・revision・手番・期限へ再照合し、正本で合法性を検査して通常経路で1回だけ確定する。VPSに着手確定権限を与えない。

VPSの予算は単調時計で計測する案とし、異なるホストの時刻が完全一致することを前提にしない。ゲーム期限と時計の正本はWorker。送信・待ち行列・推論・探索・受信・再検証を含む時間を計時し、期限後に古い結果/fallbackを指さない。最低2秒待機は既存共通仕様を維持する。

30秒解析は現在の操作応答待ち10秒と別の非同期ジョブとして扱う案とする。受付応答後に結果取得/取消を行い、通常の対局操作のタイムアウトを全体で30秒以上へ延長しない。局面移動・次局・脱落で対応しなくなった要求は取り消し、到着した結果も照合して破棄する。

### 認証・制限・保存

- WebはVPSへ直接接続せず、既存Workerの本人確認と解析権限検査を通す案とする。CPU要求の資格はDO由来のサーバー文脈で検査する。
- Worker→VPSはHTTPSとサーバー専用の共有秘密による認証を第一案とする。秘密をIssue・Git・Webの配信資産・一般ログへ含めない。用途/方向/版と計算結果だけを返す。
- 同時計算数、CPU用枠、解析待ち行列、実行/待ち時間、入力件数/バイト、1利用者の回数/計算予算を設定で制限する。上限値はT02/T03の測定で決め、無制限の試用として公開しない。
- 過負荷・未認証・不正/非互換入力・モデル不在・取消・期限切れを区別する。自動再試行で待ち行列を無制限に増やさない。
- 初期は実行に必要な短期ジョブ状態/結果とモデルだけをVPSへ持つ案とする。保存済み棋譜や戦績の正本は移さない。ログへ棋譜全体/本人情報を恒常保存せず、利用量/性能/障害理由を分ける。
- 初期のジョブ再起動復旧は期限付きの再要求とfallbackを基本案にし、永続ジョブ基盤・新しいDB/キューサービスは測定前に追加しない。TTL/ログ保持/解析結果の永続保存はT05へ分離する。

CPUの障害時の動作はD05の判断対象。推奨案は、現時点で有効な同じ手番・期限内に限ってローカルの現行Lv2を使うこと。fallbackの予算を残す期限/余裕を計測し、足りなければ既に確保した合法手を使う。VPSの故障を理由に時計を停止・巻き戻ししない。実際の時計期限に達した場合は通常の時間切れを先に扱う。解析失敗は失敗/再試行として表示し、予備の浅い評価を「30秒解析完了」と表示しない。

### 自己対戦と探索教師データ（#189）

保存先には所有マーカー `.selfplay-store` を置き、無関係な既存ファイルがある場所の初期化を拒否します。固定CPUの一時ソースはdataset内の `.scratch` で管理し、通常終了と再開時に回収します。親が強制終了した後も、一時ソースを別の場所へ無制限に残しません。

`bun run --cwd packages/four-shogi selfplay` がMac/Linux上の独立した生成・検査CLIです。既存の対戦runnerへ保存hookを追加し、全イベントの受理は `/analysis` と既存TSエンジン、教師は `/ai` を使います。新しい依存・DB・外部サービスは追加しません。Pythonの学習CLIは#190で接続します。

保存先は利用者が指定する専用ディレクトリです。`manifest.json` とゲームIDごとのJSONをchecksum付きで保存し、初期値・全受理イベント・元系列・split・実手番/相手・必要局面の完全状態・合法手ID・選択した探索教師・結果を保持します。元棋譜の参加者IDは合成IDへ置換します。表示frameだけで反復/攻撃履歴を代用しません。ゲームファイルの `in_progress` と、生成完了の `finished` / `truncated` を区別します。`inspect.complete` は計画した記録がそろった意味であり、全局が終局した意味ではありません。

1手ごとに教師・着手・状態・結果を一つのファイルへまとめ、親プロセスだけが `fsync` → atomic renameで確定します。子プロセスは保存ACKを受けるまで次の着手へ進みません。中断後は最後の保存済みイベント列から再生し、未確定の計算を採用しません。所有者が生存する二重起動は拒否し、終了済み所有者のロックと孤立した一時ファイルを回復します。回復中のプロセスまで強制終了して回復ロックが残った場合、所有PIDの終了を確認してから手動で除去します。電源断/ファイルシステム障害への耐久性は未検証です。

manifestの系列・相手群・思考予算・教師・選別・手数上限は再開時に変更できません。完了済みゲームはスキップし、同じ開始状態と相手配列になる席替えも重複生成しません。ソース集合/runner hashとBun版・OS・アーキテクチャが異なれば再開を拒否します。文書だけのコミットで同一ソースを使う場合は、元manifestのコードSHAを継続使用します。新コード/モデル/別の計画は別datasetにし、初期の学習入力は一つのmanifestを単位に扱います。複数manifestの無検査結合は認めません。

相手は共通AIの異なる処理量と、#185の固定Lv2または `commit:<40桁SHA>` の過去CPUを混ぜられます。過去CPUのソースhash・探索条件もmanifestへ記録/照合します。省略時は従来静的評価です。#192ではconfig.modelに不変ID/artifact/code hashを指定し、共通探索の相手と教師へ同じモデルを使えます。固定CPUは従来のままです。固定CPUの履歴が必要な環境では事前に対象コミットをfetchします。通常checkのテストはGit履歴や学習モデルを必要としません。

教師は周期・現在の王手/直前の捕獲で選び、局あたりの件数に上限を設けます。`every: 0` と `important: true` で重要局面だけにし、teacherのworkを大きくすれば長い再解析を選択局面へ限定できます。再開の決定性のため、生成時のAIは壁時計予算を拒否し、固定workと記録したseedを使います。各教師には実戦手を `includeAction` で比較指定します。候補・読み筋・4人評価・試行数・選択的探索/打切り・実使用モデルを保存し、完成比較がない場合はPolicy教師IDをnullにします。MCTSの上位候補だけの訪問数を、全合法手の完全な訪問分布へ正規化しません。

`@tetraboard/four-shogi/action-encoding` の版は `four-shogi-policy-index-v1`、行動空間は13,446です。座標を `square = y*9+x` とし、移動は `2*(fromSquare*81+toSquare)+promote`、打は `13122 + kindIndex*81+toSquare`（駒順は飛・金・銀・歩）です。成りはこの手で新たに成る指定で、成駒の通常移動はfalseです。幾何的に不可能なIDも含む固定空間なので、保存した疎な合法手IDを `legalActionMask` で復元して制限します。絶対座標と南・西・北・東の対応を固定し、席替えを座標変換と混同しません。AIの生の着手語彙 `four-shogi-action-v1` と数値index版は別の項目です。`stateEncodingVersion: analysis-state-v1` は完全状態の保存形式で、この生成形式の `featureVersion: null` は維持し、#190の別形式への出力時にNN特徴版を付けます。

終局結果のValueは `[南の単独勝ち, 西, 北, 東, 単独勝者なし]`。同率1位は最後の分類で、順位は正本の結果を別に保持します。`in_progress` / `truncated` は `outcome: null` で、引分やValue教師へ置換しません。完成した打切り記録の有効なPolicy教師は利用できますが、生成途中のファイルは採用対象外です。探索評価を校正済み勝率として公開しません。

split版1のseed範囲はtrain=10000〜49999、validation=50000〜59999、calibration=60000〜69999、test=70000〜99999。同系列のON/OFF・席替え・別手数は同じ集合へ固定します。元棋譜の全体/途中ファイル・回転したイベント列の関連も検査します。旧戦術validationと正式棋力用seed100000以降は生成へ使いません。データ内testと#197の正式棋力評価は別です。検査時は、完全状態を確認した上で、盤面/持駒/手番/生存者の回転一致も保守的にsplit漏れとして拒否します。この漏れ検査用の指紋を探索cacheや履歴の同一視へ使いません。

資源の既定上限は並列1（指定は1〜4）、計画64局（最大4096）、論理容量256MiB、親子の合計RSS 1GiB、1回30分です。局の上限は既定256手、教師は最大32局面/局。容量は旧ファイルと新しい一時ファイルの同時存在も含めて書込み前に検査するため、最終サイズより余裕が必要です。RSSはmacOSのps/Linuxのprocを250ms周期と保存時に観測し、超過したら子を止めて再開可能な状態を残します。これはOSのhard memory limitではなく、一時的な超過を許す観測上限です。ファイルシステムのblock消費・archive用の一時ソース・他プロセスのRSSは容量/RSSの上限に含めません。件数/byte/RSS/実行時間の上限は再開時に調整でき、無制限値は受理しません。

```sh
# configを省略するとON/OFF・1系列・4席の既定混合相手。最初の8手を保存して停止するsmoke
bun run --cwd packages/four-shogi selfplay --output=/tmp/four-shogi-data --stop-after-moves=8 --max-bytes=268435456 --max-rss-mb=1024
# 同じ保存先を再開。configを省略すればmanifestの計画を使用する
bun run --cwd packages/four-shogi selfplay --output=/tmp/four-shogi-data --concurrency=2 --max-games=64
# 全イベント/教師PV/結果/合法手マスク/版/分割/重複を再生検査する
bun run --cwd packages/four-shogi selfplay --kind=inspect --output=/tmp/four-shogi-data --report=/tmp/four-shogi-data-report.json
```

設定ファイルを使う場合は `--config=/path/config.json`。項目は以下の例を起点にします。actorの `options` と `teacher` は共通AIの設定で、`codeVersion` は実行側が供給します。`origins[].replay` に正規の完全棋譜と `eventOffset` を渡すと途中局面から生成でき、元棋譜全体は系列の識別だけに使い、入力・結果には実際に適用したprefixと自己対戦の進行を使います。外部棋譜の収集・利用条件・長期保持はT05の未決事項です。

```json
{
  "origins": [{ "seed": 18900 }, { "seed": 58900 }],
  "restrictions": [false, true],
  "seatOffsets": ["south"],
  "agents": [
    { "id": "search", "kind": "analysis", "options": { "maxWork": 256 } },
    { "id": "small", "kind": "analysis", "options": { "maxWork": 64 } },
    { "id": "lv2", "kind": "cpu", "reference": "frozen" }
  ],
  "lineups": [["search", "lv2", "small", "lv2"]],
  "teacher": { "maxWork": 2048 },
  "sampling": { "every": 8, "important": true, "maxPositions": 16 },
  "maxPlies": 256
}
```

コード/runnerに未コミット変更がある生成は既定で拒否し、開発中の実験に限って `--allow-dirty=true` を明示できます。大量データをGitへ追加せず、検証用の/tmpと長期保存先を区別します。レポートには今回生成した局面/秒・選別教師/秒・新規記録/時（打切りを含む）・自然終局/時・byte量・観測RSS・10万Policy局面の容量見積りを出します。少数smokeの値を持続性能や棋力の保証にせず、[測定記録](four-shogi-ai.md#自己対戦と探索教師生成の初期検証189)へ対象SHAと条件を残します。

### 軽量Policy/Valueの学習とチェックポイント（#190）

`training/four-shogi-ai` にPython 3.12とPyTorch 2.14.1の小規模学習CLIを置きます。ルール判定はTSが正本です。`training:export` は#189の単一datasetを排他して全イベント・完全状態・教師PV・結果・版・系列分離を再検査し、完了済みの局だけを新しい出力先へ渡します。`samples.jsonl` とmanifestにSHA-256、全件数/分割、元manifest/検査/計画、出力コード版を残します。生成途中は除外し、手数打切りはPolicyだけ、自然終局だけをValueへ採用します。教師は完成した探索の最良手IDで、全合法手の訪問分布と偽りません。

特徴版は `four-shogi-features-v1`。絶対座標・南/西/北/東を維持し、行動IDは既存の `four-shogi-policy-index-v1`（13,446）を使います。現在局面4,481要素は、81マス×33駒/空マス、持駒16、生存4、実手番5、各攻撃関係の有無/理由/解除待ち/標的マス、取り返し4×81、ON/OFF・引分提案・確定順位/脱落群・手数・直前の手/陣営です。盤上の一時IDはルールの千日手キーと同じ標的マス対応へ正規化し、参加者の個人情報を含めません。

反復辞書の**全項目**を、過去の盤面・持駒・生存/手番・攻撃/取り返しと反復回数を含む4,463要素の可変長集合にします。合法手マスクや履歴hashでの代用、一定手数だけの切出しは行いません。最大2,048項目を超えた局面は黙って切り捨てず拒否します。各疎特徴を共有MLPで16次元へ変換し、全項目の和/件数平方根と件数を現在局面へ結合します。この学習集約は合法手判定や履歴の同一性判定には使いません。

モデル版は `four-shogi-tiny-policy-value-v1`。既定の隠れ幅64の小さなMLPとPolicy 13,446/Value 5分類です。PolicyはTSから渡した合法手以外のlogitを負の無限大にし、softmax後は違法手へ厳密に0を返します。Valueの順は `[南の単独勝ち, 西, 北, 東, 単独勝者なし]`、既に脱落した陣営の出力も0にします。同率1位は最後の分類で、未終局をその教師へ変換しません。Policy/Valueはそれぞれ有効な教師だけのcross entropy平均を加算し、Adamで学習します。Value教師のないtrainは既定で拒否し、Policyのみの実験に限り `--allow-policy-only` を明示します。train/validationの両方を必須にして系列・回転局面・ゲームID・版・checksumをPythonでも検査します。calibration/testは整合性検査だけを行い、最適化や学習中の損失評価に使いません。

checkpointはモデルの `state_dict`・Adam状態・step・専用サンプラ/CPU/Python/MPS乱数・各headの教師数/5分類分布/ON/OFF件数とlossを保存します。モデル/特徴/行動/ルール版、データのmanifest/内容hash、学習ソースhash、seed/設定、Python/PyTorch/全依存版・OS/アーキテクチャ/演算設定も残します。再開は同じデータ・ソース・環境・学習設定を照合し、steps/保存周期/容量/時間は運用上限として変更できます。CPUの同一環境で連続学習との重み・最適化器・乱数の一致を検証します。[PyTorchの再現性の制約](https://docs.pytorch.org/docs/2.14/notes/randomness.html)に従い、異なる環境・CPUとMPSの一致は保証しません。

保存先は専用ディレクトリに限定し、OSのfile lockで二重学習を拒否します。重みをhash名へfsync/atomic renameしてから最新manifestを原子的に切り替え、前回と今回を保持します。失敗や強制終了で残った一時/孤立ファイルは再開時に回収します。容量超過では前回のcheckpointを維持し、参照が壊れた場合は重みを削除せず停止します。[重み保存の公式推奨](https://docs.pytorch.org/docs/2.14/notes/serialization.html)に沿い、`torch.load(..., weights_only=True, map_location="cpu")` で読み、任意のPythonモデルobjectを復元しません。モデルIDはモデル版と保存artifactのSHA-256です。既定上限は入力256MiB・checkpoint128MiB（旧版と一時書込み込み）・100step・1回600秒、batch4/CPU1thread。時間はstep境界で確認するため、初期化・評価・保存を含む厳密な期限ではありません。全データの疎表現はメモリへ読み、密tensorはbatch単位で作ります。長時間の最大RSS・大規模性能は別測定です。

```sh
# Python 3.12を使用。専用venvだけに依存を入れる
python3.12 -m venv /tmp/four-shogi-training-env
/tmp/four-shogi-training-env/bin/python -m pip install -r training/four-shogi-ai/requirements.txt
# 4局の実自己対戦とTS再生検査。raw/inputは専用パスで、inputの既存先は上書きしない
bun run --cwd packages/four-shogi training:smoke-data /tmp/four-shogi-raw /tmp/four-shogi-input
# CPU再開一致・合法手/席対応・破損/分割拒否、利用可能ならMPS逆伝播も検証
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/trainingTest.py /tmp/four-shogi-input
# 20stepの途中で保存して停止し、同じ設定で残りを再開
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/train.py --data=/tmp/four-shogi-input --output=/tmp/four-shogi-checkpoint --steps=20 --stop-after-steps=10 --report=/tmp/four-shogi-first.json
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/train.py --data=/tmp/four-shogi-input --output=/tmp/four-shogi-checkpoint --steps=20 --report=/tmp/four-shogi-resumed.json
```

Macでは `--device=mps` を両実行へ同じように追加できます。利用できないMPSはエラーにし、CPUへ黙って切り替えません。開発中の未コミットコードには生成・学習それぞれで `--allow-dirty` が必要です。通常checkへPyTorchや学習を追加せず、Bunの特徴/出力テストと別実行の極小smokeを分担します。大量生成・重い学習も別コマンドです。データとcheckpointはGitへ追加せず、長期保存場所/期間はT05の未決事項を維持します。

モデルの出力は未校正で、manifest/reportも `calibrated: false`。UIへ勝率％を公開せず、Linux CPUロード・数値整合/配布方式は下記#191、共通探索での実使用は#192で測定します。初期smokeの少数・弱い相手・同じ結果へ偏ったValue教師では棋力や一般化を判定しません。

### Linux CPU推論とMac出力の照合（#191）

初期方式はD03の永続Python/PyTorch CPUです。学習用checkpointを `inference.py export` で `four-shogi-inference-v1` の新規専用ディレクトリへ取り出します。Adam/乱数を除いたCPU float32重み・manifest・Mac CPUの基準出力と入力 `probe.json` を組にします。モデルIDは元の学習checkpointのSHA-256を維持し、推論artifactは別のSHA-256で識別します。元checkpointを書き換えず、既存出力も上書きしません。

manifestはモデル/特徴/行動/ルール/席順の版、推論コードhash、対応ON/OFF、構成、学習コード/データ/環境、重み/基準fixtureのhashとbyte数、必要なPython 3.12/PyTorch 2.14.1 CPUを保持します。同じ契約を重みにも保存して組合せ違いを拒否します。`weights_only=True, map_location="cpu"` で読み、型/shape/有限値と、同梱基準に対する出力誤差・最良手一致を確認してから採用します。学習再開と異なりOS/CPUは固定せず、TorchのCPU版suffixは許容します。manifestのhashは配布元の認証や署名の代わりではなく、配布先/権限は#193/T05で定めます。

共通fixtureはTS正本による14局面です。ON/OFFそれぞれに南/西/北/東の実手番、攻撃、取り返し、脱落した西のValueスロットを含みます。行動IDと回転表の固定値はBunテストでも検証します。特徴は絶対座標で、回転によるモデル出力の対称性は仮定しません。合法手/最良手IDは完全一致、違法手と脱落者は0、数値はPython `math.isclose(a, b, abs_tol=1e-5, rel_tol=1e-4)` で判定します。比較前に固定した閾値を測定結果に合わせて緩めません。出力は内部の未校正分布で、勝率％を表示しません。

`inference.py serve` はstdin/stdoutのJSONL `four-shogi-inference-ipc-v1` です。起動応答のIDは0、後続は要求IDを戻します。`health`、`evaluate`、`activate` を受け、評価では要求modelIdと全版を照合します。候補を別にロードして基準fixtureと追加probeを検査し、成功後に参照を切り替えます。失敗時は `ok:false/error/activeModelId/fallback` を返し、稼働中のモデルとディスクの旧配布物を保持します。起動候補が使えないときは明示した `--fallback <旧配布物>` だけを試し、`candidateFailure` と実際のmodelIdを返します。両方失敗なら静的評価へのfallback理由を返して非零終了します。静的評価の実行とモデル入り探索への切替は下記#192です。

サーバー専用 `@tetraboard/four-shogi/model-inference` の `ModelInferenceClient.start(command, options)` は1プロセスを保持し、`evaluate(positions)` で正本から特徴と合法手を生成します。応答の要求ID/モデルID/合法手/数値/席を照合します。`activate(directory, probePositions)` の失敗で旧モデルを維持し、エラーから理由を取得できます。起動既定30秒、要求既定5秒（各1〜60,000ms）、待ち要求16、batch16/全履歴4,096項目、1局面2,048履歴、1frame16MiB、重み32MiB、manifest256KiBを上限にし、黙って切り捨てません。期限超過・異常応答・子終了で全待ち要求を失敗させプロセスを終了します。自動再起動/再試行はせず、呼出側が予算内の静的fallbackを選びます。#192で要求単位のAbortSignalと遅い応答の排出を加えます。要求の取消/手番期限だけではプロセスを終了せず、通信/推論自体のタイムアウトや異常応答で終了します。対局時計・ジョブ受付を含む最終予算は#193〜#194です。ブラウザ/Worker用入口へ子プロセス依存を混ぜません。

```sh
# #190のPython 3.12 venvとcheckpointを使用します
bun run --cwd packages/four-shogi inference:fixture /tmp/four-shogi-fixture.json
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/inference.py export --checkpoint /tmp/four-shogi-checkpoint --fixture /tmp/four-shogi-fixture.json --output /tmp/four-shogi-model
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/inferenceTest.py /tmp/four-shogi-model /tmp/four-shogi-fixture.json
/tmp/four-shogi-training-env/bin/python training/four-shogi-ai/inferenceSmoke.py --model /tmp/four-shogi-model --fixture /tmp/four-shogi-fixture.json --output /tmp/four-shogi-mac.json
bun run --cwd packages/four-shogi inference:smoke /tmp/four-shogi-training-env/bin/python /tmp/four-shogi-model /tmp/four-shogi-fixture.json
# Linux CPU配布物の再現環境。CPU版Torchだけをインストールし、GPUを使いません
docker build -t tetraboard-four-shogi-inference:local training/four-shogi-ai
# /tmp/four-shogi-checkにはmodel/fixture.json/mac.jsonを配置します。出力だけ書込可能にします
docker run --rm --cpus=2 --memory=1g --pids-limit=64 --network=none --read-only --cap-drop=ALL --tmpfs /tmp:rw,size=64m --user "$(id -u):$(id -g)" --mount type=bind,source=/tmp/four-shogi-check,target=/work --entrypoint python tetraboard-four-shogi-inference:local inferenceSmoke.py --model /work/model --fixture /work/fixture.json --reference /work/mac.json --output /work/linux.json
docker run --rm --cpus=2 --memory=1g --network=none --read-only --tmpfs /tmp:rw,size=64m --mount type=bind,source=/tmp/four-shogi-check,target=/work,readonly --entrypoint python tetraboard-four-shogi-inference:local inferenceTest.py /work/model /work/fixture.json
```

smokeはウォームアップ3回後に既定30回、batch1/4/14の入力検査/疎→密/推論/出力変換、永続プロセスの起動（Python/Torch import込み）とbatch4のJSONL往復、最大RSSを別々に記録します。バッチ分割時の出力も同じ許容差で比較します。Torch内の `torch.export` も試行しますが、現モデルの合法手検査がデータ依存のPython分岐であるため、そのままのexportは失敗します。可変履歴に合わせた別モデルの作り直しやONNX依存は採用せず、最小の既存モデルをそのまま動かす初期方式とします。export方式との速度比較は未実施です。[測定と採用理由](four-shogi-ai.md#linux-cpu推論とmac出力の検証191)に条件と限界を残します。実VPSの性能・x86_64・長時間/多並列・最大履歴負荷は別確認で、T02の契約/配置とT05の長期保存は未決です。

### Policy/Valueを使う共通探索（#192）

`analyzePosition` の同じ入口へ `options.modelId` と `control.modelEvaluator` を渡します。主探索は#188のMaxⁿを維持し、MCTSとの組合せは拒否します。評価器のモデルID/関数を開始時に固定し、要求を凍結し、応答をコピーしてからID・合法手・5分類の席・有限値・正規化・脱落者0を検査します。一般の利用者から重みパス/コマンドを受けるAPIは追加しません。サーバー側が管理した常駐clientの `asEvaluator()` を注入します。

Policyは根の着手と内部候補を並べ替えます。王手対応/捕獲/既存の強制手保護を維持し、静穏手の幅内選択に学習Policyを使います。根の全合法手の浅い比較を完成してから公開し、次局面はbatch16/全履歴4,096以下でまとめます。キャッシュは同じ実行の同じ枝参照だけで、モデルやON/OFFをまたいで共有しません。入力は正本の合法手と遷移から作り、探索の差分反復辞書は元の完全辞書へ上書き合成して全項目を特徴化します。特徴版/13,446行動/絶対座標を変えず、履歴上限は切り捨てず拒否します。

Valueの南/西/北/東の単独勝ち成分を各人の主効用にします。生存者は数値を `(0,1)` へclampし、正本の確定単独勝ち1、非単独勝ち0、脱落者0を上書きしません。根の視点を手番ごとに変えず、各手番者が自分の成分で選びます。順位は完全な主効用同点時の副比較だけで、順位加点やヒューリスティックとの重み付け混合はしません。`evaluationKind: model`、`heuristicScore:null`、`probabilities:null` で未校正の内部値を返し、根の `staticEvaluation` は比較用の従来静的値です。終局は `terminal` の正本値です。

モデル有効時の版は `singles-analysis-model-v1` / `selective-maxn-policy-value-v1` / `uncalibrated-sole-first-model-v1` / 既存feature/policy-index版です。静的要求の版・省略設定は維持します。モデルなし/ロード失敗/ID不一致/特徴限界/不正出力/推論失敗/遅延では、モデル探索を破棄して静的評価へやり直します。既に消費したworkと壁時計をリセットしません。同じ候補集合へ両尺度を混ぜず、実際の評価版とrequested ID/fallback理由を含めたcacheKeyを返します。残予算で比較が完成しなければ従来どおり合法な予備手・評価nullを返します。

`modelTimeoutMs` はモデル指定時だけ1〜60,000ms、既定1,000msです。全体の残時間が短ければその期限を先に使います。取消/手番期限で待ちを解き、遅い応答は登録IDのまま排出して結果へ使いません。Pythonの実行中のnative演算を途中で停止する意味ではありません。待ち数は排出まで上限16に含みます。推論タイムアウト自体・通信タイムアウト・不正応答ではclientを閉じ、通常の手番期限ごとの再起動はしません。同期の特徴準備/合法手生成は協調停止のため、厳密なhard deadlineは保証せず超過時間を診断します。最終の着手期限確認は#193〜#194です。

`result.model` はrequested/開始時loaded/結果を作ったused IDと `inferenceCount`（有効なモデル探索で受理した予測局面数）、`inferenceCalls`（batch往復数）、`policyUses/valueUses`、推論待ちmsを返します。失敗して破棄した場合はused=null/有効件数0とし、`attemptedInferenceCount` と `discardedWork` に実際の試行量を残します。完成比較前の打切りもused=null/有効件数0です。モデルをロードしただけの正常系を実使用と数えません。

```ts
import { analyzePosition } from "@tetraboard/four-shogi/ai";
// clientはサーバー起動時にモデルを検査して作成し、同じプロセスを保持します
const evaluator = client.asEvaluator();
const options = { codeVersion, modelId: evaluator.modelId, maxWork: 1_000_000 };
const cpu = await analyzePosition(
  position,
  { ...options, timeBudgetMs: 500 },
  { modelEvaluator: evaluator },
);
const analysis = await analyzePosition(
  position,
  { ...options, timeBudgetMs: 30_000 },
  { modelEvaluator: evaluator },
);
```

`selfplay` のconfig.modelは `{ modelId, artifactSha256, codeHash }`。全共通AIの対局選択と教師へ同じIDを適用し、固定CPUは変更しません。実行用python/model-dirはmanifestの局面設定へ混ぜず、独立workerの起動設定に渡します。各ゲームに一つの常駐Pythonを作り、探索ノードでは起動しません。親の観測RSSにはBun workerとPythonも含めます。モデルID/artifact/code不一致で再開を拒否し、モデル未使用/fallbackの教師を保存せず停止します。raw datasetの `featureVersion:null` は `analysis-state-v1` の完全状態保存を表し、モデル使用版はconfig.modelと各教師のversions/modelへ保存します。従来datasetは省略形のまま互換を維持します。

保存記録の検査は元イベントを正本で全再生し、PV/合法手/単独1位ラベル/モデル版・ID/非終局値の範囲と席/終局優先を確認します。非終局モデル値の再推論は行わず、checkpointと同梱基準の照合はモデル起動時の#191で行います。打切りをValue教師へ変換しません。生成側と解析側の評価定義は同じ `modelEvaluation` です。

```sh
# 同じ初期/seed301局面のwork/time比較、一手単独勝ち、500msと30sの共通入口
bun run --cwd packages/four-shogi bench:model --python=/tmp/four-shogi-training-env/bin/python --model-dir=/tmp/four-shogi-model --code-version=$(git rev-parse HEAD) --kind=performance --repeats=3 --max-work=1024 --time-ms=100 --analysis-ms=30000 --output=/tmp/four-shogi-model-performance.json
# #185と同じ開始生成/4席/終局ラベル/系列単位集計。少数対戦を別測定します
bun run --cwd packages/four-shogi bench:model --python=/tmp/four-shogi-training-env/bin/python --model-dir=/tmp/four-shogi-model --code-version=$(git rev-parse HEAD) --kind=matches --series=1 --seed=19210 --max-plies=64 --time-ms=100 --output=/tmp/four-shogi-model-matches.json
# #191のPython/Torch CPUイメージに、採用済みBun1.4.2を加えます
docker build -t tetraboard-four-shogi-inference:local training/four-shogi-ai
docker build -f training/four-shogi-ai/Dockerfile.search -t tetraboard-four-shogi-search:local training/four-shogi-ai
# Linuxではrepoと配布物をread-onlyでmountし、同じbench/modelSearchCli.tsを実行します
```

モデルを使う自己対戦は既存configのmodel欄へ、配布物manifestから上の3識別を転記します。識別は `bench/modelRuntime.ts` の `modelIdentity(directory)` でも取得できます。config.modelなしのmodel-dir指定や、実行設定なしのモデル生成を拒否します。

```sh
bun run --cwd packages/four-shogi selfplay --config=/tmp/four-shogi-model-config.json --output=/tmp/four-shogi-model-data --python=/tmp/four-shogi-training-env/bin/python --model-dir=/tmp/four-shogi-model --max-games=4 --stop-after-moves=1 --report=/tmp/four-shogi-model-first.json
bun run --cwd packages/four-shogi selfplay --output=/tmp/four-shogi-model-data --python=/tmp/four-shogi-training-env/bin/python --model-dir=/tmp/four-shogi-model --max-games=4 --report=/tmp/four-shogi-model-resumed.json
bun run --cwd packages/four-shogi training:export /tmp/four-shogi-model-data /tmp/four-shogi-model-input
```

比較CLIの従来相手は共通静的Maxⁿ3体で、固定Lv2を上回ったという検定ではありません。最終seed/校正対局を調整に使わず、モデルが弱くても実験設定として残します。現行Lv1/Lv2・公開CPU・Workerの時計/着手・ルールを変更せず、棋力と機能完成を分けます。[測定と採用判断](four-shogi-ai.md#モデル入り共通探索の検証192)へ対象SHA/環境/使用件数/速度/未終局/制約を記録します。

## 承認済みの設計判断

2026-10-14に開発者が「D01〜D05はすべて推奨案で承認します」と明示し、PR #200のdevelopへの取り込みも承認した。以下の推奨案を採用し、担当Issueで実装する。判断の根拠は [AGENTS.mdの承認規則](../AGENTS.md#承認が必要な場合)。この承認は未決のT01〜T07や本番公開の決定を含まない。

| ID  | 判断内容                                  | 推奨案・理由・影響                                                                                                                                                                                                                                                               | 確定が必要になる前                   |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| D01 | 引き分け/下位順位の副目的と新AIの引分同意 | 終局の主報酬は単独1位1、それ以外0。主評価が同じ場合だけ順位を副比較に使い、平均順位を主報酬へ加算しない。新AIは人間全員の提案へ自動同意せず、自発的な引分提案も初期は行わない案。単独勝ちを追求できるが、新AIを含む合意引き分けが成立しにくくなる。現行Lv1/Lv2の同意は変更しない | #187の探索効用、#194のCPU同意        |
| D02 | 初期の規則と連盟との差の扱い              | 初期はTetraBoard rulesVersion 1・ON/OFFで実装/学習し、連盟向け追加プロフィールは根拠と差がそろってから提案する。既存資産を使って早く一巡できる一方、連盟ルールとの完全一致/大会級の認定は保留                                                                                    | #186の復元契約。対象実戦前にも再照合 |
| D03 | VPSとTetraBoardの責務/パッケージ構成      | 既存Cloudflareが対局管理、別のVPSがAIのみを実行する上記構成。TS/Bunのルール/探索を再利用し、Python/PyTorch CPU推論を第一比較候補とする。全面移行を伴わず進められるが、2環境とサーバー間通信の運用が必要                                                                          | #186/#187の入口・#191/#193の実行基盤 |
| D04 | 初期の公開範囲・CPUレベル                 | 開発環境の許可アカウントに新AIの試用CPU・終局棋譜解析を限定する。既存Lv1/Lv2の公開仕様を保ち、内部の複数思考予算で比較する。新レベルの段数/名前・旧Lv2置換・一般公開は測定後に決める。初月で試用できるが、一般利用者への提供は後続                                               | #194/#195のUI・権限・レベル          |
| D05 | VPS障害・期限前のfallback                 | 期限内だけ現行Lv2→確保した合法手の順で予備着手を使い、故障時も時計を進める。対局が継続できる一方、その着手の棋力は低下する。使用版/理由を診断へ残し、解析失敗は完了として偽装しない                                                                                              | #193/#194の失敗時動作                |

D01の主報酬は承認済みの学習目的であり、校正済み勝率の存在を前提にしない。校正前モデルの推定・静的評価が示す優劣を候補選択へ使う場合も、その尺度/評価版を明示する。主評価が近いだけで副順位を優先する許容幅や重みは勝手に設けず、探索実験の条件として提示する。

許可アカウントの具体ID、VPSの秘密・契約情報は公開文書/Issueへ記載せず、設定時に開発者から適切な保管経路で受け取る。

## 後続の測定・判断へ回せる未決事項

| ID  | 未決事項・推奨する進め方                                                                                                                           | 担当/判断時点                                         | 今進められる範囲                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| T01 | #191で初期方式に既承認の永続PyTorch CPUを選定。torch.exportは現モデルのデータ依存分岐で失敗。再検討/新たな主要依存時に理由と影響を提示             | エージェント比較→開発者、#191                         | モデル/特徴/行動の版、共通fixture、評価器注入                  |
| T02 | VPSの提供者/プラン/OS/CPUアーキテクチャ、予算、配置開始日、同時数。根拠のない最小スペックや料金を断定しない                                        | 開発者＋測定、#191/#193の実VPS確認前                  | Linux CPUの起動/モデル整合、設定可能な上限、配布・切り戻し手順 |
| T03 | 公開CPUレベル数/名前/思考予算、認証・利用量の具体上限、一般公開。予算増加が棋力を上げるとは仮定しない                                              | 開発者、#194/#195および#197の測定後                   | 開発用の予算プロファイル、制限機構、ON/OFF別比較               |
| T04 | 比較対象の連盟規定、3人の優勝者級、持ち時間/席/局数、達成認定の閾値。単発1勝と継続した棋力を分ける                                                 | 開発者が手配、#199前                                  | 正本による合法性、現行Lv2/混合相手群への独立評価               |
| T05 | 人間/外部棋譜の学習利用条件、データ保存場所/容量/保持期間、ジョブTTL/ログ保持、解析結果永続保存。初期データは自前自己対戦と管理可能なfixtureを推奨 | 開発者＋必要な調査、収集/保存仕様変更前               | seed付き自己対戦、個人情報を含まない教師データとhash           |
| T06 | 共有/設定別モデル、特徴/行動符号化、ネットワークの大きさ、Maxⁿ/MCTSの採否、深さ/候補幅。少数実験とMac/Linux測定で判断                              | エージェント、#188〜#192。主要依存/仕様変更は開発者へ | 一つの条件付きモデルを第一実験案にし、設定/履歴を識別するAPI   |
| T07 | 棋力改善・校正・予想順位の合格閾値と独立標本数。結果を見る前に定め、校正条件外の確率を出さない                                                     | エージェント案→開発者、#197/#198の正式測定前          | 測定runner、系列単位の分割/区間、勝率を非表示にした解析        |

ここに載せた全項目の決定を一度に待たない。D01〜D05は承認済み。#185の現行基準固定、現在の固定棋譜/履歴の調査、復元fixture・Linux検証計画を進められる。後続の実装は影響する決定IDだけを開始条件にする。

## 初期一巡のDone Whenと進行

### 現行Lv2の固定基準と測定CLI

Issue #185の固定基準はPR #200取り込み後のdevelop `913a09d4edce5e44c96d190a60757ef184a4738d`。探索・評価設定と15ソースのSHA-256を [lv2Baseline.json](../packages/four-shogi/bench/lv2Baseline.json) に記録する。全ソースの集合hashは `38e9b81f223d79e9e0596901273754e28643b5273f74f4d9bb7b5230c03025a3`。基準のソースが一致しなければ測定を拒否する。新AIの単独1位目的へ固定Lv2の評価を変更しない。

新しい実行入口は `bun run --cwd packages/four-shogi bench:singles`。従来の `bench` と [過去の測定記録](four-shogi-ai.md) は強化前の旧Lv2 `3b84f2cdaf9e280b6f84ee34eaa95de8a1441d03` を比較する条件のまま維持する。Git履歴が必要なので、浅いcloneでは必要な基準コミットを事前に取得する。通常checkの論理テストはGit履歴や大量対局を必要としない。

```sh
# 候補1体対固定現行Lv2三体。ON/OFFそれぞれ2系列×4席、8手で打ち切る動作確認
bun run --cwd packages/four-shogi bench:singles --kind=matches --restricted=both --start=mixed --series=2 --seed=1000 --max-plies=8 --output=/tmp/four-shogi-smoke.json
# 固定現行Lv2の性能。計算負荷を並行実行せず、各phaseを準備実行後に測定
bun run --cwd packages/four-shogi bench:singles --kind=performance --candidate=frozen --restricted=both --repeats=5 --output=/tmp/four-shogi-performance.json
# 従来の旧基準も使用可能。相手の順は候補席の次から南→西→北→東の循環順
bun run --cwd packages/four-shogi bench:singles --kind=matches --opponents=frozen,legacy,frozen --start=initial --series=1 --restricted=both --max-plies=8 --output=/tmp/four-shogi-mixed.json
```

- 候補・相手は `current`（作業中コード）、`frozen`（固定現行Lv2）、`legacy`（強化前）、`commit:<40桁SHA>`（履歴のCPU）を指定できる。この固定CPU用CLIのselectorは `modelId: null` を明記する。モデル入り共通探索の比較には#192の `bench:model` を使う。runnerには注入可能な方向別selectorの境界がある。
- `--max-work`、`--max-depth`、`--width`、`--root-width`、`--extensions`、`--weights` は候補側だけの上書き。固定基準を候補に指定したときは上書きを拒否する。時間上限は未実装で、現在は処理量・深さ・幅を記録する。固定基準の処理量2048・深さ6・幅6・根幅24・延長2は時間保証ではない。
- `--start=initial` は一つの初期配置×4候補席。`opening` はseedごとの合法な12手系列、`mixed` は最初を初期配置、残りを12手系列にする。ON/OFFを分け、同一完全開始状態の重複は拒否する。4席は同系列の標本であり独立4局とは数えない。回転による開始局面の水増しはしない。
- 結果には単独1位・本人の同率1位・確定終局の単独勝者なし・確定順位・脱落理由・終局理由・手数上限の未終局を分けて残す。未終局は単独1位率の分母に残し、引分ラベルへ変えない。合意提案・持ち時間・切断はこの着手専用runnerでは再現しない。
- 単独1位率の区間は開始状態hash単位のクラスタbootstrap（1000回）。同じ開始状態の4席をまとめ、2系列未満なら区間はnull。同一対局IDの二重集計を拒否する。小規模・調整用データの区間を正式な棋力証明に使わず、#197で独立系列と条件を事前に決める。
- code SHA、未コミット変更、runner/ルール/各AIソースのhash、設定、方向別相手ID、seed、完全開始集合のhash、着手列/最終状態のhash、Bun・OS・CPU・メモリ・アーキテクチャを出力する。開始状態は設定/履歴を含み、同じ版から復元できる。時間/RSSを除いた対局結果・集計を再現する。
- 性能は合法手生成、合法性検証込みの公開遷移、現行静的評価、選択したAIの探索を独立に再測定する。探索にはルール・評価が含まれるのでphaseの時間を加算しない。平均/p95/最大はms、RSSはプロセス全体のbytes。各反復の時系列と実work/depthを残して継続負荷の推移を読めるようにする。モデル評価・IPC・ジョブ待ちは未実装/対象外を明記し、#191〜#194で追加する。Macの実測からVPS性能を保証しない。

2026-10-14の動作確認の対象コードは `9c298096294b9f3c759a0a8e2a2d820ade9ac588`。根拠とコマンドは [固定基準の測定データ](four-shogi-ai-baseline-results.json) に保存する。M5・24GiB・macOS/arm64・Bun 1.4.2でローカルの計算を並行せず実行した。`matches` は初期配置＋seed 1001の12手系列、各4候補席、ON/OFF各8局を8手で打ち切るsmoke。同一引数で再実行し、時間/RSSを除く着手列・最終状態hash・実work/depth・集計が16局すべて一致した。全16局は未終局で、単独勝者なしの終局へ置き換えていない。記録された率やbootstrap区間はこの打切りsmokeの集計であり、勝率予測・棋力判定の根拠にしない。

`frozen` と公開Lv2はON/OFF×初期/持ち駒多数/開始系列の6局面で同一着手。`legacy` を含む混合相手8局、コミット指定候補4局も合法に動作した。従来benchの旧Lv2性能12局面を再実行し、過去の性能集合hash `1f2a278178b84ea4ea79ced0e0e33183d78a145dd6226b6f23516c912e122ae5` を再現した。

固定現行Lv2の探索性能は準備実行後に各5回測定した。新しい性能集合hashは `b1dc5d4a91a56580c532dc4c910ff7a05d4c07f3731d47572864351521c9fa70`。合法手生成・遷移・静的評価の値と全120測定の時系列は根拠データを参照する。

| 三人攻撃禁止・局面 | 探索平均ms | p95/最大ms |
| ------------------ | ---------- | ---------- |
| OFF・初期          | 71.31      | 86.96      |
| OFF・持ち駒多数    | 46.80      | 51.25      |
| OFF・開始系列      | 75.08      | 83.83      |
| ON・初期           | 106.36     | 128.37     |
| ON・持ち駒多数     | 56.05      | 62.67      |
| ON・開始系列       | 208.45     | 221.08     |

探索の実workは2046/2048、完了深さは1〜3。最大RSSは322,125,824 bytes（プロセス全体、約307MiB）。5回の測定では熱平衡後の長時間性能は未検証。Linux/VPS、モデル入り評価、IPC/ジョブ待ち、正式棋力は後続で確認する。

### 初期一巡の受入条件

[初期マイルストーン](https://github.com/yksw-clm/tetraboard-2026/milestone/1) は#184〜#196。順序/並行可能範囲は [親Issue](https://github.com/yksw-clm/tetraboard-2026/issues/183)、検証分担は [テスト方針](testing.md#四人将棋シングルスaiの契約確認) を参照する。

- 完全状態復元→共通探索/候補/PV→自己対戦/教師生成→Mac等の学習→Linux CPUのモデル推論→モデル入り共通探索→旧モデル/固定現行Lv2比較を、小規模データと再開可能なCLIで再現する。
- 新AIの対局CPUと保存済み終局棋譜解析が、同じモデル/共通入口を実使用する。正常系の実使用モデルID・推論回数を確認する。
- ON/OFF双方で合法手、履歴、実手番、順位・単独勝者、モデル対応、取消/期限/古い応答/障害を確認する。
- code/model/feature/action/rules/データ版、seed、環境、コマンド、速度/棋力/未終局の結果と未確認を残す。大量学習/正式棋力測定を通常checkへ入れない。
- 現行Lv2より弱いモデルでも機能一巡は別に判定するが、棋力達成や一般公開を自動認定しない。実VPS未確認とLinux検証済み、配布準備と実配置、未校正と校正済みを分ける。

Issue #184はこの契約・参照案内・判断一覧の整理を担当し、AI実装や主要依存の採用を先行しない。承認済みD01〜D05の実装は後続Issueで行い、文書承認だけで開発済みとして扱わない。マージ・公開・VPS契約/配置は、レビュー可能な差分と確認結果への開発者承認後に行う。
