# Cloudflare検証と費用の判断

2026-11-08（日本時間）のフェーズ2検証です。開発者の公開・クラウド実測の承認に基づき、独立した検証用Serviceを公開しました。現時点の小規模な検証は既存の月額利用枠に収まる見込みです。確定請求額ではなく、下記の使用量・公式単価による判断です。

検証後、同日の開発者の依頼で検証用Worker・専用Durable Object・Container application・Registryの検証用イメージを削除しました。下記のURL・構成・版は測定時の記録であり、現在は公開していません。本番・開発TetraBoardのリソースは変更していません。

## 公開した構成

- origin: `https://tetraboard-ai-validation.chaossi-lab.workers.dev`
- Container: `tetraboard-ai-validation-aicontainer`、`lite`（1/16 vCPU・256MiB・2GB）、最大1台、共通の名前`shared-v1`
- アイドル停止: 10秒。起動時以外の定期呼出し、cron、常時起動、外向き通信はありません。
- 候補APIは入口とRustの両方でBearer認証。認証なしの要求と公開healthではContainerを起動しません。
- 本番・開発TetraBoardのコード・接続設定・DBは公開先へ反映していません。接続テストはローカルのGameRoomから公開Rust Serviceへ実HTTPで行います。
- Worker version: `17befbfc-d28d-4749-bf97-5b4780074277`（Secrets登録後）。Container application: `a03c240f-a7b5-4cdb-8168-ee6122d09475`
- amd64 image digest: `sha256:0676f770b8c161b74b79025a81864afe7587f20e9803b02a756d89405fedec04`

ソースは`feat/ai-phase2`のフェーズ2差分、Rust 1.99.1、Cargo.lock、Wrangler 4.143.0、`@cloudflare/containers 0.3.7`です。イメージ取得・ビルドはデプロイ時に完了してから測定しています。Dockerのローカル測定時のimage IDとは識別形式・生成時点が異なり、このdigestをクラウド測定対象とします。

## 実ネットワークでの測定

測定時間は2026-11-07 15:14:18〜15:15:20 UTC（11月8日0:14〜0:15 JST）。ローカルMacからHTTPSで接続し、応答本文の読了までを測定しました。入口のCF-RayはKIXです。別途取得したContainers統計では配置は`nrt10`、ワークロードの最大実メモリは約6.68MiBでした。課金対象は割当256MiBです。

初期・12・28・44手の4局面を固定し、各Agentは各局面10要求、合計40要求です。seed 7、MaxNは深さ3／1024ノード。全120要求が200・合法手で、同一要求の応答も一致しました。

| Agent    |    平均 |     p50 |     p95 |    最大 |
| -------- | ------: | ------: | ------: | ------: |
| ランダム | 41.82ms | 40.04ms | 57.16ms | 65.25ms |
| 1手評価  | 38.04ms | 37.27ms | 42.22ms | 48.98ms |
| MaxN     | 45.73ms | 43.55ms | 55.14ms | 68.00ms |

停止状態を確認してからの3要求は191ms・2454ms・2521msでした。初回の短い値だけを冷起動の代表にしません。この結果からGameRoom側の既定timeoutを1秒から5秒へ調整し、1秒を超える起動待ちの回帰テストを追加しました。時計期限による打切り・失敗時の合法手への退避を維持します。3試行だけで長期の起動時間・SLAを保証しません。

別途、MaxN深さ4／4096ノードの12手局面で、同時要求数を変えて各5batch測定しました。

| 同時要求数 | 200 | 503（過負荷） | 全応答のp95 |
| ---------- | --: | ------------: | ----------: |
| 2          |  10 |             0 |    229.60ms |
| 4          |  10 |            10 |    213.59ms |
| 8          |  10 |            30 |    206.03ms |

503はRustの同時実行2の上限による意図した拒否です。全30成功要求は合法手でした。高並列でp95が低く見えるのは早く拒否した要求を含むためで、処理能力が向上した意味ではありません。最大1台の検証構成であり、4・8並列を処理できる容量を示しません。

認証なしの要求は401となり、前後ともContainerは`stopped`でした。最後の要求から16秒後にも`stopped`を確認しました。詳細は追跡対象外の`results/phase2-cloud.json`、再測定は[フェーズ2のコマンド](phase2.md#cloudflareでの検証)を使います。測定値に秘密値・参加者情報は含めません。

## 既存TetraBoardを含む使用量

公開前にアカウント全体を照会しました。Workers Standardは有効（`workers/standard`の`standard: true`）です。既存Workerは本番・開発TetraBoardと`cpod`で、下記の要求統計に返ったのはTetraBoardの2つです。新しいプラン契約・アップグレードは行っていません。

要求・CPU・DO・D1行数の期間は11月1日00:00 UTC〜11月7日15:09 UTCです。請求サイクルの開始日は取得できていないため、「現在の請求期間の残枠」とは区別します。Cloudflare GraphQLのAdaptive統計は請求明細そのものではありません。

| 項目                       |          本番 |       開発 |          合計 | Paidの月間利用枠 |
| -------------------------- | ------------: | ---------: | ------------: | ---------------: |
| Worker要求                 |       107,731 |     18,746 |       126,477 |       10,000,000 |
| Worker CPU（起動分を含む） |   3,134,024ms |  379,770ms |   3,513,793ms |     30,000,000ms |
| DO要求（分析上の実要求）   |        40,956 |        964 |        41,920 |        1,000,000 |
| DO duration                | 1,055.17 GB-s | 41.28 GB-s | 1,096.45 GB-s |     400,000 GB-s |
| D1読取行                   |    76,493,115 |  5,054,008 |    81,547,123 |   25,000,000,000 |
| D1書込行                   |        50,777 |      5,251 |        56,028 |       50,000,000 |

Worker CPUは`cpuTimeUs + startupCpuTimeUs`をmsへ変換した値です。DOはGameRoomとTournamentCoordinatorを合算し、要求にはWebSocketの請求換算前の値を含むため、利用枠との比較は保守的です。RESTから読んだD1容量は本番28,401,664 bytes・開発5,963,776 bytes、合計約34.4MBで、5GB枠に収まります。

R2は同じ要求集計期間で全API要求861件（課金対象外の管理・削除操作も含む）、11月7日のバケット別最大容量の合計はpayload 94,112 bytes・metadata 203 bytesでした。標準ストレージ10GB-month・Class A 100万件・Class B 1,000万件の枠に対し小さい量です。これは月間GB-monthの確定請求値ではありません。AI ServiceはD1・R2を新設・使用しません。

この約6.63日分のWorker CPUを同じペースで30日に伸ばすと約1,590万ms（枠の約53%）、要求は約57万件です。将来のアクセス増、他の開発作業、料金改定を含む予測ではありません。[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)、[DO料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)を2026-11-08に確認しました。

## 追加費用の考え方

[Containers公式料金](https://developers.cloudflare.com/containers/platform/pricing/)では、既存Workers Paidの月額$5にメモリ25GiB-hours・CPU375vCPU-minutes・ディスク200GB-hoursが含まれます。超過単価はメモリ$0.0000025/GiB-second、CPU$0.000020/vCPU-second、ディスク$0.00000007/GB-secondです。メモリとディスクは実使用量ではなく割当量で課金され、稼働が停止するまでアイドル時間も消費します。CPUは実使用時間です。

liteのモデルでは、月100時間の稼働でメモリ25GiB-hours・ディスク200GB-hoursを消費します。CPUも常時1/16を使用した仮定なら375vCPU-minutesです。したがって、この枠を他のContainersと共有していなければ、短時間の今回の検証や小規模な運用は追加$0の見込みです。サービスごとの新しい月額$5は発生しません。

今月のContainers使用量の照会では今回のapplicationだけが返りました。反映済み値はCPU約0.32秒・メモリ約1.34×10⁹ byte-seconds・ディスク約1.00×10¹⁰ byte-secondsですが、ワークロード統計のCPU約5.91秒よりも小さく、全実測の確定値とは扱いません。統計反映に差があるため、[請求用リソース統計](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/)は後日確認が必要です。仮に今回30分間ずっとlite 1台が稼働し、CPUも1/16を使い続けても、メモリ0.125GiB-hours・ディスク1GB-hours・CPU1.875vCPU-minutesで、それぞれ月枠の0.5%です。

| 月間稼働のモデル（lite 1台） | メモリ・ディスクの超過額 | CPUを常時1/16使う仮定の超過額 |
| ---------------------------- | -----------------------: | ----------------------------: |
| 10時間                       |                       $0 |                            $0 |
| 100時間                      |                       $0 |                            $0 |
| 720時間（30日間常時稼働）    |                  約$1.71 |                       約$2.79 |

金額はUSD・税抜、既存Workers月額$5を除く追加額です。CPU欄は実測値ではなく高利用時のモデルです。別途Worker要求・CPU、Containerを管理するDO、ログ、通信量の利用枠を共有します。Containerのエグレス枠は地域別に500GB〜1TBで、短い候補JSONの今回の規模では十分小さい量です。入口のobservabilityを無効にし、対局状態や要求ログを常時保存しません。

運用見積りは局数だけでなく**アイドルを含む稼働時間**で行います。たとえば1局あたり5分稼働という仮定なら1,000局で約83.3時間ですが、これは対局時間の実測ではありません。複数部屋が1台を共有する場合は稼働が重なり、逆に人間の着手待ちで停止・起動を繰り返す場合は起動遅延が増えます。常時起動で遅延をなくす判断は、費用・並列容量と一緒に再評価します。

## 未確認事項と次の判断

請求明細・契約金額APIは手元のOAuth認証では権限不足です。税・請求サイクル・契約上の割引・最終請求額は確認していません。使用量APIは一時レート制限を受けましたが、公式のアカウント単位の読取方法でR2とContainersを補完しました。Containers請求統計の反映完了後の総量、既存Worker Logsの請求量は未確認です。検証用Workerはobservability無効ですが、既存TetraBoardのログ設定は変更していません。

終了時の状態照会ではPython urllib標準User-AgentはCloudflareの403、Service名のUser-Agentは200でした。Bunとworkerdの実測経路は成功しています。汎用HTTPクライアントを追加する際は入口の制限を確認してください。この検証のために既存アカウントのセキュリティ設定は変更していません。最終照会でもContainerは停止済みでした。

## 検証結果

macOS 27.0.1 arm64・Bun 1.4.4・Rust 1.99.1で、最終コードに対する以下の必須検証が成功しました。Rust 25件、Bun 14件（100局比較を含む）、実ServiceとのWorker統合20件を含みます。公開Serviceへ接続した同じWorker統合20件も成功しました。GameRoom自体はローカルのworkerdで、公開済みTetraBoardの実対局ではありません。

| コマンド                                               | 結果                                    | 所要時間 |
| ------------------------------------------------------ | --------------------------------------- | -------: |
| `bun run check`                                        | 成功（fmt・Clippy・型・全テストを含む） |  38.76秒 |
| `bun run build`                                        | 成功                                    |   4.62秒 |
| `bun run --cwd apps/worker deploy:dry-run`             | 成功                                    |   0.59秒 |
| `bun run build:development`                            | 成功                                    |   4.58秒 |
| `bun run --cwd apps/worker deploy:dry-run:development` | 成功                                    |   0.60秒 |

既存の大きいWeb chunkのbuild警告は残っています。GitHub CI・PR作成・マージは実施していません。クラウド公開はこの検証用Serviceだけです。

## 次の作業

本番導入では、想定同時対局数に対する成功率、冷起動の長い裾、Workerからの実ネットワーク、時計期限近くの退避率を継続測定します。再測定には検証環境の再公開と新しい秘密値の登録が必要です。CPUレベルの追加公開やTetraBoard本番への有効化は別の変更として扱います。
