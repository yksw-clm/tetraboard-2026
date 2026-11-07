# フェーズ2：AI ServiceとGame Roomの最小接続

Rustの`server` crateにAxum + TokioのHTTP Serviceを追加し、既存Game Roomの四人リバーシCPUから接続します。対象は引き続き**脱落なしの4人シングルス**です。Game Roomが局面・手番・合法手・時計・棋譜・勝敗の正本を持ち、Serviceは候補手だけを計算します。Serviceは対局状態・参加者・レーティングを保存しません。

## 実行と接続設定

Serviceには32〜256文字のASCII秘密値`AI_SERVICE_TOKEN`を環境変数で渡します。設定なし・短い値では起動しません。リポジトリルートから`bun run --cwd packages/ai serve`で起動し、既定の待受は`127.0.0.1:3001`です。`AI_SERVICE_LISTEN`で変更でき、ポート0は空きポートを選びます。起動時の標準出力は待受アドレスだけです。`AI_SERVICE_CONCURRENCY`は1〜16、既定2です。

Workerは次の任意設定を使います。ローカルは追跡対象外の`apps/worker/.dev.vars`、公開環境の秘密値はWrangler Secretsで管理します。本番・開発TetraBoardへ接続設定を追加せず、[別Workerでのクラウド検証](#cloudflareでの検証)を行いました。

| 設定                    | 意味                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `AI_SERVICE_URL`        | Serviceのorigin。未設定なら現行CPU経路。HTTPSを使い、HTTPはlocalhost・127.0.0.1・::1だけ許可 |
| `AI_SERVICE_TOKEN`      | Serviceと同じBearer token。Room・Web・棋譜には含めない                                       |
| `AI_SERVICE_TIMEOUT_MS` | 100〜5000ms、既定5000。不正な値は既定値。時計の期限が先ならその時刻まで                      |

URLに資格情報・パス・クエリ・fragmentは指定しません。`AI_SERVICE_URL`が設定されてもtokenやURLが不正なら、HTTP送信をせず合法な代替手へ退避します。ダブルス・脱落後・他ゲームは外部Serviceの対象外とし、既存CPU経路を維持します。

対象局のCPU Lv1は`four-reversi-random-v1`、Lv2は`four-reversi-greedy-v1`へ対応します。RustのLv3候補`four-reversi-maxn-v1`はService APIで利用できますが、今回の変更で既存UIやprotocolのCPUレベルを増やしません。各候補の評価定義は[フェーズ1](phase1.md)を参照してください。既存Service未接続時のLv2採用仕様とは別の、設定で有効にする接続経路です。

## HTTP契約：版1

`GET /health`は認証なしで`status: "ok"`、`api_version`、`engine_version`を返します。`POST /v1/move`は`Authorization: Bearer <token>`とJSONを必須とします。認証は本文解析より前に確認します。リクエスト上限は16KiBです。

```json
{
  "api_version": 1,
  "game_id": "four-reversi",
  "ruleset_version": "four-reversi-singles-v1",
  "state_version": 1,
  "request_id": "00000000-0000-4000-8000-000000000001",
  "position_revision": "0000000000000000000000000000000000000000000000000000000000000000",
  "agent_id": "four-reversi-maxn-v1",
  "seed": 7,
  "budget": { "max_depth": 3, "max_nodes": 1024 },
  "state": {
    "board": [
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, "black", null, null, null, null],
      [null, null, null, "red", "black", "blue", null, null],
      [null, null, "red", "white", "blue", null, null, null],
      [null, null, null, null, "white", null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null]
    ],
    "turn": "black",
    "moveNumber": 0,
    "lastMove": null,
    "consecutivePasses": []
  }
}
```

上記は初期局面です。`board`は8×8の配列で、セルはnullまたは`black`・`white`・`red`・`blue`です。`state`はEngineの構築入力へ変換します。全4色の存在、合法手のある手番、補助情報と`盤上石数 = 8 + moveNumber`を検査します。終局済み・脱落・ダブルスの状態は受け付けません。任意局面の到達可能性までは検証しません。

`request_id`は16〜64文字のASCII英数字・ハイフン、`position_revision`は64文字の小文字16進です。Workerはrequest_idにUUID、revisionに部屋世代・局ID・CPU本人・色・レベル・手番開始時刻・局面キーのSHA-256を使います。参加者の氏名やアカウントIDは送りません。seedはrevisionの先頭32bitから導出し、同じ要求を再試行するときは本文とIDを保持します。

MaxNのbudgetは深さ1〜4・ノード1〜4096で、未指定なら3/1024です。他のAgentではbudgetを指定しません。重みはフェーズ1の既定係数に固定し、未知のAgent・項目・版・過大予算を拒否します。seedはu64です。JavaScriptの安全な整数を超えるseedを扱う外部クライアントは整数精度を保持してください。Workerからのseedは32bitです。

成功応答は版・ゲーム・ルール・状態版、request_id、position_revision、agent_id、engine_version、`position: { x, y }`と`diagnostics: { nodes, completed_depth, interrupted }`を返します。要求の識別子をそのまま応答へ返し、時間依存の値を混ぜないため、同じ要求は同じ結果になります。エラーは`{ "error": "..." }`で、不正入力400、認証401、本文過大413、Content-Type不正415、過負荷503、計算失敗500です。

CPU計算は`spawn_blocking`へ渡し、Semaphoreで同時実行数を制限します。permitは計算完了まで計算側が保持し、呼出元の切断で空きを誤って増やしません。[Tokioの仕様](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html)上、開始済みのblocking処理はabortだけでは停止しないため、ノード・深さの上限で有限にします。過負荷時は待ち行列を増やさず503にします。

## Game Roomの保存・照合・失敗処理

CPUの最低2秒待ちとAlarm限定の適用を維持します。GETやWebSocketの通常処理では外部思考を起動しません。

1. Alarmのtransactionで局面と期限を確認し、request_idと期限付きの未完了ジョブを保存します。
2. transaction・DOの入力ゲートを保持せずHTTPを待ちます。未完了ジョブがある間の重複Alarmは再送しません。
3. network・429・5xxだけ同じ要求を最大1回再試行し、2回を合わせてtimeout以内に制限します。redirectは追従せず拒否します。応答本文は8KiBまで読みます。
4. 応答の版・要求ID・revision・Agent・座標・診断を検査し、現在の部屋世代・局ID・CPU本人・色・レベル・手番開始時刻・局面キーを再確認します。時計・脱落・閉鎖を先に処理します。
5. 正しい合法候補だけを既存のCPU候補ジョブへ保存します。失敗・不正候補では現在の合法手の先頭を代替手にし、既存AIの探索を代替計算に流用しません。
6. 次のAlarmで再度局面と期限を検証し、既存のTypeScriptエンジンで着手・時計・棋譜・終局を確定します。古い応答で進行を上書きしません。

未完了ジョブはtimeout+250ms（時計の期限が先ならその時刻）まで保持します。プロセスの再起動で応答が失われても、その期限のAlarmで合法な代替手を保存できます。次Alarmとの間に時計が切れた場合も、着手より脱落処理が優先です。手番変更・投了/脱落・再戦・終局・部屋閉鎖では未完了ジョブを破棄します。

Serviceは状態を持たず、同じ要求の再計算を許容します。二重着手を防ぐ正本はGame Room側の未完了ID・局面照合・候補消費transactionです。内部ジョブのrequest_id、revision、source、診断を公開Roomや保存棋譜へ追加しません。Workerの障害ログは分類した理由だけを記録し、token・局面・参加者情報を記録しません。

## コンテナと測定

```sh
docker build --platform linux/amd64 -t tetraboard-ai:phase2 packages/ai
# AI_SERVICE_TOKENをシェル環境に設定してから実行します。
docker run --rm --platform linux/amd64 --cpus 2 --memory 256m \
  -p 127.0.0.1:3001:3001 --env AI_SERVICE_TOKEN tetraboard-ai:phase2
```

イメージはRust 1.99.1でビルドし、Debian bookworm-slim上のUID/GID 10001で動きます。tokenはイメージへ含めません。HTTPの既定ポートは3001、TLSの終端はホスティング側で扱います。[Cloudflare Containersの要件](https://developers.cloudflare.com/containers/get-started/)を確認し、linux/amd64イメージをローカルでビルド・起動しました。

2026-11-07のローカル測定はOrbStack上のamd64エミュレーション、2CPU・256MiB、初期局面、各Agent50要求です。キャッシュ済みイメージの`docker run`からhealth成功まで約163ms、アイドルメモリ約4.7MiB、HTTP応答p95はランダム0.510ms・1手評価0.462ms・MaxN（3/1024）1.335msでした。全150要求の候補は合法でした。イメージID・条件・詳細はローカルの`results/phase2-container.json`に記録しています。

これはloopback測定で、イメージ取得・ビルド時間、ネットワーク距離、Cloudflareの配置・コールドスタート・費用・実負荷を含みません。

## Cloudflareでの検証

2026-11-08（日本時間）に開発者の公開・クラウド実測の承認を受け、`cloudflare/wrangler.jsonc`の独立したWorker `tetraboard-ai-validation`へ公開しました。検証後、同日の依頼でWorker・専用Durable Object・Container・検証用イメージを削除しています。[測定値と費用](cloudflare-validation.md)に条件・結果・利用枠との比較を記します。本番・開発TetraBoardの公開コード、接続設定、DBは変更していません。

入口の薄いWorkerだけTypeScriptと公式`@cloudflare/containers 0.3.7`を使い、候補計算は同じRustイメージで行います。`lite`を最大1台、全要求で`shared-v1`を共有し、アイドル10秒で停止します。Containerの外向き通信を無効にし、秘密値はWorker Secretsから起動時に渡します。公開`GET /health`は入口の稼働だけを返し、Containerを起動しません。`POST /v1/move`は入口で認証した後にContainerへ渡し、Rust側でも再確認します。認証した`GET /admin/status`は起動せず状態を返します。対局ごと・CPUごとにContainerを作りません。

```sh
# 初回はWorkerを公開してから、同じ秘密値をSecretsへ登録します。
bun run --cwd packages/ai deploy:cloud:dry-run
bun run --cwd packages/ai deploy:cloud
bun --cwd packages/ai x --no-install wrangler secret put AI_SERVICE_TOKEN --config cloudflare/wrangler.jsonc
# AI_SERVICE_URLに検証先origin、AI_SERVICE_TOKENに同じ秘密値を環境変数で渡します。
bun run --cwd packages/ai measure:cloud
```

Secrets設定前は候補APIが503で停止し、Containerを起動しません。秘密値はGit・Docker build引数・計測JSONへ含めません。`measure:cloud`はこの検証先だけを許可し、0・12・28・44手の固定局面で各Agent40要求、停止後3要求、2・4・8並列を各5batch計測します。合法性・同一要求の結果・401時の停止維持・最後の自動停止を確認し、追跡対象外の`results/phase2-cloud.json`へ保存します。通常のcheckやCIはクラウドへ接続しません。

検証環境の削除に伴い、今回の秘密値を保存したローカルの`.env.cloud-validation`も削除しました。再測定には上記の再公開と新しい秘密値の登録が必要です。接続情報を追跡対象外の`packages/ai/.env.cloud-validation`へ権限0600で保存した場合、リポジトリルートから`bun --cwd packages/ai --env-file=.env.cloud-validation run measure:cloud`で実行できます。実行前に他の要求を止め、16秒以上待ってください。このファイルは通常のcheckで自動読込しません。

冷起動の実測最大約2.52秒を受け、Workerの既定timeoutを5秒へ調整しました。時計の期限が優先です。常時起動・自動スケール・本番採用の負荷容量やSLAは確定していません。

## 検証範囲と次の作業

Rustではhealth・認証・版・状態・予算・本文上限・過負荷、全Agentの合法性と決定性を検証します。Bunは実Rustプロセスを起動し、別プロセスのWorker統合テストを実行します。実HTTPで人間1人＋CPU3人のLv1・Lv2対局を終局まで進め、全棋譜を既存ルールで再実行します。候補保存後のDO再作成、重複Alarm、別世代の応答、再試行、HTTP失敗・不正応答・timeout・未完了ジョブの再起動復帰も検証します。linux/amd64コンテナを接続先とする同じ完走テストも実施しました。ブラウザテストは使いません。

本番採用には同時対局数に合わせた容量とtimeoutの継続測定が残っています。以後のフェーズ3では多人数MCTS等のLv4〜5候補と予算・棋力を比較します。既存UIのLv3公開、脱落/ダブルス、他ゲーム、マッチング、学習、棋譜解析は今回追加しません。
