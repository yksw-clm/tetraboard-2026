# 対局参加BOTの導入と操作

[確定仕様](../../docs/specs/player-bot.md)に従い、既存APIを使う開発者向けCLIです。設定JSONにCookieを記載しないでください。

## 準備

リポジトリの依存導入後、RustのローカルAIをビルドします。Dockerやブラウザ拡張の登録は不要です。

```sh
bun run --cwd apps/player-bot build:ai
```

使用する接続先で、BOTごとのGoogle／Discordアカウントを登録し、プロフィールと規約同意を完了します。本番と開発の認証情報は別に取り込みます。

Chromeでは対象サイトのDevTools → Application → Storage → Cookiesから、`__Secure-tetraboard-2026.session_token`を確認します。HTTPのローカル環境では`__Secure-`が付きません。値だけをコピーし、次の非表示入力へ貼り付けます。[ChromeのCookie操作](https://developer.chrome.com/docs/devtools/application/cookies/)も参照してください。

```sh
bun run --cwd apps/player-bot start auth bot1 --origin https://tetraboard-dev.chaossi-lab.workers.dev
```

`bot1`〜`bot4`など、必要なプロフィールごとに取り込みます。同じプロフィールへの別アカウントの上書きは拒否します。認証切れは、同じアカウントで再ログインして再取り込みしてください。

保存先は`~/Library/Application Support/TetraBoard Bot/`です。`TETRABOARD_BOT_HOME`で変更できます。接続先・プロフィール別に認証と復帰情報を保存し、ディレクトリは0700、ファイルは0600で作ります。保存先を失うと、通常ルームの参加資格はCookieだけでは復元できません。

## 起動設定

次を任意のJSONファイルへ保存します。接続先にはorigin、`profiles`には取り込み済みの1〜4プロフィールを指定します。

```json
{
  "origin": "https://tetraboard-dev.chaossi-lab.workers.dev",
  "game": "four-shogi",
  "profiles": ["bot1", "bot2", "bot3", "bot4"],
  "target": {
    "type": "create",
    "timeControl": { "mainTimeMs": 300000, "byoyomiMs": 30000 },
    "threePlayerAttackProhibited": true
  }
}
```

`game`は`four-shogi`または`four-reversi`です。`create`の時間設定を省略した場合は既定値を使います。持ち時間は0・60000・180000・300000・600000、秒読みは0・10000・30000ミリ秒から選び、両方0にはできません。

参加方式に応じて`target`を次のいずれかに置き換えます。

| 用途 | target |
| --- | --- |
| 通常ルームへ参加 | `{"type":"room","roomId":"12345"}` |
| 大会へ参加 | `{"type":"tournament","id":123}` |
| レートマッチへ参加 | `{"type":"rated"}` |

大会は設定したゲームと一致するものを指定します。開催前はエントリーせず開催を待ちます。レートマッチの設定はサービス側の現行設定に従います。通常ルームを人間がホストする場合、開始操作はそのホストが行います。

```sh
bun run --cwd apps/player-bot start run /absolute/path/bots.json
```

待機、接続、開始、着手、AIの代替理由、終局、停止をJSON行で標準出力へ表示します。ルーム作成時のURLから観戦できます。認証値は出力しません。

## 停止と復帰

Ctrl+Cを1回で完局後の終了、2回で即退出です。途中でプロセスが終了した場合は、保存情報を残して同じ設定ファイルで再起動してください。別の参加先へ切り替える前に、前の設定で復帰・停止します。

「前回の参加結果が不明」と表示された場合は、新規参加を保留しています。部屋作成・通常入室の応答を失うと資格を取得できない場合があるため、サーバー上の席の状態を確認してください。保存情報を消して無条件に再参加しないでください。

## 検証

```sh
bun run --cwd apps/player-bot test
bun run --cwd apps/player-bot typecheck
bun run check
```

通常のBOTテストはローカルHTTP/WebSocketと既存ゲームエンジンを使い、外部サイトや実OAuthへ接続しません。Rustの実探索を伴う検証はAI workspaceの検証と分けて実施します。

`bun run --cwd apps/player-bot test:ai`は実Rustの専用4プロセスで18秒間の並行探索と取消を確認し、その間のメモリ・CPU使用量を表示します。通常のcheckには含めません。
