# Development

## Development Strategy

土台 → Vertical Slice → ロビー → ルーム → 四人リバーシ → E2E
の順で開発します。

## Local Development

リポジトリのルートで `bun run dev` を実行すると、WebとWorkerの開発サーバーが同時に起動します。
どちらもLANから接続できます。

スマートフォンでは開発機と同じLANに接続し、Viteの起動ログに表示される `Network` のURLを開きます。
WebがWorkerの `/healthz` と通信できると、画面に「APIステータス：OK」と表示されます。
開発機からは `http://127.0.0.1:8787/healthz` でWorkerを直接、Viteの `Network` URLに `/api/healthz` を付けてWeb経由の通信を確認できます。

ルーム作成は `POST http://127.0.0.1:8787/rooms` に `{"name":"てとら"}` をJSONで送ります。返された5桁のIDを使い、`GET http://127.0.0.1:8787/rooms/<ID>` で保存した部屋を確認できます。Workerを再起動した後も同じIDで取得できます。開発時のDurable Objectの状態は `apps/worker/.wrangler/state` に保存されます。公開ロビー用のD1索引はロビー実装時に追加します。
既存ルームへの入室は `POST http://127.0.0.1:8787/rooms/<ID>/players` に `{"name":"二人目"}` をJSONで送ります。成功時は更新後のルーム情報を返し、満室なら409を返します。
Web画面ではニックネームを入力して「ルーム作成」を押すか、部屋番号を入力して「入室」を押すと、`/rooms/<ID>` に移動します。ルームページはGETで保存済みの情報を確認してから表示し、WebSocket接続後に受信したルーム情報と接続状態を表示します。別の画面からの入室もWebSocketで反映します。ページを再読み込みしても同じルームを取得できます。接続が切れた場合はGETで状態を再取得してから再接続します。開発機のブラウザで確認後、スマートフォンでもViteの `Network` URLから同じルームURLを開いて確認します。
現段階では、再読み込み後のプレイヤー本人としての復帰と、待機中に離れた人の席の解放は実装していません。再読み込みで入室を再実行することはなく、ルームページは閲覧用として開きます。

## Code Principles

C#/.NET標準ライブラリのような、一貫性があり読みやすいコードを目指します。

過度な抽象化より、意図が明確なコードを優先します。

## Naming

- ファイル名: camelCase（Reactコンポーネントファイルは基本PascalCase）
- クラス名: PascalCase
- 型名: PascalCase
- 関数・メソッド名: camelCase
- 変数名: camelCase

## Comments

コメントは日本語の丁寧体で記述します。

- 「〜を確認します。」
- 「〜を返します。」
- 「〜の場合は処理を終了します。」

コードをそのまま日本語にしただけのコメントは避け、
処理の意図や理由を説明します。
