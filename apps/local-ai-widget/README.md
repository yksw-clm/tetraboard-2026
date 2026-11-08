# TetraBoard Local AI

四人リバーシ・シングルスの参加者向けChrome拡張です。通常対局・CPU対局・大会の本番画面で、解析だけを自分のMacへ渡します。[現在仕様](../../README.md#ローカルai解析widget)と[解析API](../../packages/ai/README.md#ローカル解析サービス)を参照してください。

## 導入

リポジトリルートで実行します。

```sh
mise install
bun install --frozen-lockfile
bun run --cwd packages/ai setup:local
bun run --cwd apps/local-ai-widget build
bun run --cwd packages/ai serve:local
```

1. Chromeの`chrome://extensions`を開き、デベロッパーモードを有効にします。
2. 「パッケージ化されていない拡張機能を読み込む」から、このcheckoutの`apps/local-ai-widget/dist`を選びます。Chrome 120以降を使います。
3. 拡張の設定画面を開き、`packages/ai/.env.local`の`AI_LOCAL_TOKEN=`より後の値を貼り付けて保存します。このtokenは本番の認証値ではありません。ファイルや値をGit・PR・チャットへ貼り付けないでください。
4. 対局ページを再読み込みし、右上のwidgetで「有効にする」を押します。ローカルAIの端末を起動したまま利用します。

対応ページは`https://tetraboard.net`、開発環境、`http://localhost:5173`、`http://127.0.0.1:5173`です。公開Serviceや本番Webへ拡張をデプロイする操作はありません。

## 使い方

本人の手番で自動解析します。「解析・再解析」は現在手番の色について手動解析、「停止」は現在の解析を停止、「無効にする」はそのタブを無効にします。最後に有効にした1タブだけが対象です。相手手番の候補は、その色にとっての候補です。

解析AIはwidget内で「Lv5 ノヴァ」と「Lv6候補A（未採用）」を選びます。初期値はLv5、選択はページ再読み込みまで保持します。切替は現在の解析を取り消し、本人手番なら選択先で自動解析します。Lv6候補Aは最大8192試行・262144着手適用・2秒の実験設定で、強さの認定前です。[比較計画・測定記録](../../packages/ai/docs/lv6-candidate.md)を参照してください。

候補①②③は通常の盤上操作を通します。右上のカードはヘッダーで移動し、折り畳めます。参考評価は推奨手後の探索内の単独1位率で、対人勝率ではありません。探索回数が少ないと不安定で、同率1位を含まないため合計100%にならないことがあります。時間上限終了は途中結果として表示します。

Serviceと拡張の両方を更新してください。解析端末で既存ServiceをCtrl+Cで終了し、`bun run --cwd packages/ai serve:local`で起動し直します。拡張を更新したらビルド後、拡張管理画面で再読み込みし、対局ページも再読み込みします。更新直後の古いタブには新しい拡張を適用できません。番号が表示されない場合は、解析エラーと対応ゲーム・モード・参加状態を確認してください。AIを停止した場合も対局は続けられ、再起動後に再解析できます。

## 停止・削除

widgetの「無効にする」を押し、解析端末でCtrl+Cを押します。拡張自体を無効化・削除する場合はChromeの拡張管理画面で操作し、開いている対局ページを再読み込みすると追加表示が取り除かれます。

## 開発と確認

```sh
bun run --cwd apps/local-ai-widget typecheck
bun run --cwd apps/local-ai-widget test
bun run --cwd packages/ai check
```

成果物は`dist`でGit対象外です。通常のWebビルド・配信には含めません。ブラウザを起動する自動テストは追加していません。実際のChromeで候補位置・着手・リサイズ・ズーム・ドラッグ・停止を単発確認してください。
