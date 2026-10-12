# 四人将棋Lv3の自己対局・1日試用

2026-10-12の追加指示に従い、初回は **自己対局と学習だけ** を実行します。通常シングルスの三人攻撃禁止あり／なしを交互に回し、最大5探索プロセス・5vCPU・10GiBを使います。HTTPS入口は0.25vCPU・256MiBです。12GBのVPSでもOS用の余裕を残します。実対局用API、TetraBoardのLv3選択、モデルの本番配布は後続です。

## 実装した内容

- Lv3専用探索は `@tetraboard/four-shogi/lv3` から読み込みます。全候補の捕獲・取り返しの合法性を比較し、完了した深さの結果だけを返します。3〜4人はMaxn、2人はalpha-beta、既定16,384単位・最大6手です。既存Lv1／Lv2を変更しません。
- 各ルールで親の8重みを変更した2候補を生成します。調整は8開始系列×4席×親・2候補、検証は別の8系列×4席×親・選抜候補です。相手はLv2、固定した初期Lv3、親を巡回します。候補だけが4席を占める対局にはしません。
- 順位報酬は1、2/3、1/3、0。千日手等の同率順位を保持し、引分と単独1位を別集計します。上限800手で未終局なら報酬0にし、ルール上の引分にはしません。
- 親との差は4席をまとめた開始系列単位で比較します。最低8系列の95%区間の下限が正、引分・未完了率の増加が各5ポイント以内、既知3戦術局面の回帰を通過した場合だけ学習の親を更新します。初回試用では本番への採用を行いません。
- SQLite WALに各局の入力、開始seed、席、全イベント、反復履歴を含む途中状態と結果を保存します。中断局を同じモデル・設定で再開し、完了局は二重計上しません。モデルにはコードコミットとエンジン・学習コード・検証局面のSHA-256を記録します。
- APIのHTTP処理と探索は別プロセスです。10秒おきの管理画面更新は非表示タブで停止します。障害時は最後の値と取得時刻を表示し、権限喪失時は値を消します。

改善の有無は対戦結果で判断します。短いsmoke試験で世代が進んでも、棋力の向上を意味しません。モデルはニューラルネットではなく、評価重みを自己対局で最適化する初版です。盤面全体を手番順に精密に交換するSEE、局面段階別重み、公開前の未使用400局ずつの評価は後続です。

## ローカルで確認

リポジトリのルートで実行します。Bunは1.4.2を使います。

```sh
bun install --frozen-lockfile
AI_DATA_DIR=/tmp/tetraboard-ai-smoke bun run --cwd apps/shogi-ai smoke
AI_DATA_DIR=/tmp/tetraboard-ai-smoke bun apps/shogi-ai/src/cli.ts status
```

相対パスの保存先はコマンドの作業ディレクトリが基準です。上のように絶対パスを指定します。smokeは8開始系列の検証を満たさない短い試験なので、親を更新しません。

監視APIも起動する場合、32文字以上の秘密鍵を環境変数へ設定します。例の値を公開環境で使わず、自分の鍵を生成してください。

```sh
export AI_MONITOR_KEY=$(openssl rand -hex 32)
AI_DATA_DIR=/tmp/tetraboard-ai-api bun apps/shogi-ai/src/cli.ts serve --workers 2 --seconds 60 --seeds 1 --max-plies 16 --work 128
```

`serve`は時間切れで学習だけを停止し、監視APIを残します。`train`は時間切れ後に終了します。SIGINT/SIGTERMで保存して停止できます。同じ保存先の再開は元の試用期限を引き継ぎます。期限を延長しません。探索予算・seed数・上限手数・コードを変えた比較は新しい保存先で開始します。同じ保存先を二つの制御プロセスから同時に使わないでください。

Worker側の未追跡 `.dev.vars` に次を設定します。

```dotenv
SHOGI_AI_API_URL=http://127.0.0.1:8090
SHOGI_AI_MONITOR_KEY=APIと同じ秘密鍵
```

通常の `bun run dev` でWeb、Worker、管理画面を起動し、管理者として `/admin/four-shogi-ai` を開きます。自己対局サービスは通常のdevとは別に起動します。本人の内部IDを既存の `ADMIN_ACCOUNT_IDS` へ登録する手順は既存の管理画面と同じです。

## VPSへ配置

まずローカルで差分と検証結果を確認します。ConoHaの契約・課金開始・本番公開はこの手順で自動実行しません。VPSはUbuntuベースのDockerイメージ、SSH鍵、管理するドメインを用意します。

```sh
uname -m
docker version
docker compose version
df -h
```

VPSが`x86_64`の場合は`linux/amd64`、`aarch64`の場合は`linux/arm64`を使います。ソースをVPSへ送ってビルドする場合、依存インストールを含むため初回はネットワーク接続が必要です。

```sh
cp ops/shogi-ai/.env.example ops/shogi-ai/.env
chmod 600 ops/shogi-ai/.env
```

`.env`の`AI_DOMAIN`を実際のドメイン、`AI_MONITOR_KEY`を`openssl rand -hex 32`で生成した鍵、`AI_CODE_COMMIT`を配置するコミットへ変更します。鍵はGit・ブラウザ・会話へ貼りません。ドメインのAレコードをVPSへ向け、80/443番を許可します。8090番はlocalhostだけへ公開し、外部へ開けません。

```sh
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml config --quiet
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml build ai
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml run --rm ai bun apps/shogi-ai/src/cli.ts preflight
```

監視用の環境変数を開発Workerへ設定します。URLは固定したHTTPSのoriginだけを渡します。VPS監視鍵は他の管理APIの鍵と分けます。ブラウザは同一originのWorker APIだけを呼び、Workerが管理者を認証した後、時刻・nonce・HMAC付きでVPSへ接続します。本番の認証付きAPIとHTTPSでの通信は配置後に確認します。

```sh
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml --profile https up -d
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml logs --tail=50 ai
```

時間切れは学習を止めるだけです。VPSの課金停止にはなりません。コンテナを自動再起動しない設定にし、VPS自体の削除は成果の持ち出し確認後に開発者が判断します。

監視ドメイン未設定の初回は `up -d ai` で自己対局だけを開始できます。HTTPS入口は起動しません。SSHで `ssh -L 8090:127.0.0.1:8090 root@VPSのIP` の転送を保ち、ローカルWorkerの監視URLを `http://127.0.0.1:8090` に設定すると、暗号化したSSH経由で管理画面へ状況を表示できます。実際のSSH接続では登録した秘密鍵を `-i` で指定します。

## 1日の運用

1. 最初は`.env`を`AI_SECONDS=60`、`AI_WORKERS=5`、`AI_SEEDS=1`、`AI_MAX_PLIES=16`、`AI_WORK=128`にして動作確認します。この試験は専用のComposeプロジェクト名（例：`-p shogi-ai-smoke`）で起動し、本学習のvolumeを分けます。
2. 本学習は元の`.env.example`の設定へ戻し、別のプロジェクト名で開始します。最大5並列で両ルールを交互に配分します。平均局数・未完了率・空きディスク・エラーを管理画面で確認します。
3. 初期版と親を相手に含めるため、各世代に比較対局が必要です。世代数だけを最大化せず、実際に終局した件数を見ます。下限20GiBを割ると学習を停止します。測定上限800手は維持し、短い上限の結果を強さの証拠へ流用しません。
4. `benchmark`は別プロセスでCPUを使うため、本学習の前か停止中に実行します。100開始局面×3予算×両ルールを測れます。少標本の結果には局面数を添えます。
5. 24時間以内に停止し、成果をVPS外へ持ち出して検証します。1日で採用に値する候補ができない場合も、初期版と候補・測定結果を保持します。

```sh
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml run --rm ai bun apps/shogi-ai/src/cli.ts benchmark 100
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml stop ai
```

## 成果の取り出しと再開

exportはSQLiteの一貫したスナップショット、全モデル、完了局のJSONL棋譜、チェックサムmanifestを出力します。中断局はSQLiteへ保持します。出力先は空のディレクトリが必要です。対局を停止してから取り出すと、最後の途中状態も含められます。

export用のホストディレクトリを追加volumeで渡します。大きいSQLiteやJSONLをメモリへ一括読込みせずに書き出し、チェックサムもストリームで計算します。

```sh
mkdir -p ops/shogi-ai/exports
sudo chown 1000:1000 ops/shogi-ai/exports
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml run --rm -v "$PWD/ops/shogi-ai/exports:/exports" ai bun apps/shogi-ai/src/cli.ts export /exports/day1
docker compose --env-file ops/shogi-ai/.env -f ops/shogi-ai/compose.yml run --rm -v "$PWD/ops/shogi-ai/exports:/exports:ro" ai bun apps/shogi-ai/src/cli.ts verify-export /exports/day1
```

`exports`はモデル等だけを置く専用ディレクトリです。公式Bunイメージの`bun`ユーザー（UID 1000）に所有権を合わせ、SSH経由でローカルへコピーします。Composeにプロジェクト名を付けた場合は、exportにも同じ `-p` を指定して対象volumeを一致させます。

```sh
bun apps/shogi-ai/src/cli.ts verify-export ops/shogi-ai/exports/day1
AI_DATA_DIR="$PWD/ops/shogi-ai/exports/day1" bun apps/shogi-ai/src/cli.ts status
```

同じコード・同じ設定なら中断状態を再利用できます。試用期限後に再学習するときは、新しい保存先で次の試用を開始し、モデル引継ぎを別途判断します。VPSを削除する前に、ローカルでmanifest検証とstatusの読込みを確認します。

## 検証と限界

検証対象は `packages/four-shogi/test/cpuLv3.test.ts`、`apps/shogi-ai/test/`、`apps/worker/test/shogiAiAdmin.test.ts`、`apps/admin/test-dom/shogiAi.test.tsx`です。Lv3の3戦術回帰、30実戦局面、予算・決定性・入力不変、モデル更新・少標本・API認証、並列停止／再開、監視の障害と権限喪失を確認します。GitHub CI成功と公開前の承認は別途必要です。

ローカルの短い5並列Docker試験は800手の棋力測定の代わりにはなりません。ConoHa実機の24時間負荷、メモリ上限付近、DNS/TLS、開発Workerとの実通信、モデルがLv2より強いかはVPS試用で確認します。
