# TetraBoard 四人将棋AI

人間が4人そろわないときも、プレイヤーの棋力に合うCPUを補充してランダムマッチを成立させるための独立Pythonプロジェクトです。ルールをPythonで実装し、既存TypeScript版は互換性の照合に使います。評価・探索・学習モデルは新規開発します。

2026-11-06の開発者指示で、従来のAI開発計画をこの計画へ全面置換しました。旧計画の1か月目標・優勝者級の認定・TS探索再利用・学習先行・VPS採用を新計画へ引き継ぎません。既存実装の撤去や公開CPUの切替はオンライン統合時に別途判断します。

## 現在の実装範囲

フェーズ01の成果物は、[設計契約](docs/design.md)、Pythonパッケージのひな形、版付き再生入力の検証・不変データへの変換と、品質チェックです。ルールエンジン、対局、合法手生成、探索、学習は未実装です。入力形式を受理しても、その棋譜が合法とは限りません。

- [ゲームのルール正本](../../docs/rules/four-shogi.md)
- [開発手順](../../docs/development.md#独立python四人将棋ai)
- [テスト方針](../../docs/testing.md#独立python四人将棋aiの確認)
- [Notionの進捗・ロードマップ](https://app.notion.com/p/4102355fed8480f089c1e9f3df630c43)

## 起動・検証

リポジトリルートの `mise.toml` でBun・Node・Python・uvを固定します。Pythonは3.14の通常ビルド、依存はこのディレクトリの `uv.lock` で固定します。既存 `training/four-shogi-ai` の専用環境とは共有しません。

リポジトリルートで実行します。

```sh
mise install
mise exec -- bun install --frozen-lockfile
mise exec -- uv sync --locked --directory ai/four-shogi-ai
bun run ai:check
```

`ai:check` はRuff整形確認・Lint、mypy strict、pytestを順に実行します。pytestは固定例・決定的なHypothesis生成例と、実BunプロセスでのTS入力検証器との比較を含みます。TS側の比較入口はルートの型検査対象です。全体の `bun run check` とFull CIにも組み込み、Fast CIでは未実行として表示します。

交換入力をPythonから扱う例です。

```python
from four_shogi_ai import parse_replay, replay_to_dict

replay = parse_replay(
    {
        "schemaVersion": 1,
        "ruleProfileId": "tetraboard-four-shogi-singles-v1",
        "rulesVersion": 1,
        "initial": {
            "mode": "singles",
            "players": {"south": "s", "west": "w", "north": "n", "east": "e"},
            "threePlayerAttackProhibited": True,
        },
        "events": [],
    }
)
assert replay.event_offset == 0
assert replay_to_dict(replay)["eventOffset"] == 0
```

`mise exec -- uv run --locked --directory ai/four-shogi-ai python` で専用環境を使えます。通常実行にBun・TS・PyTorchは不要です。Bunは開発時の照合にだけ必要です。

## 後続の進め方

ルール検証 → 自己対局・評価基盤 → 探索 → 棋風・棋力帯 → TetraBoard統合 → 機械学習の順に進めます。各フェーズの完了はNotionの完了条件と成果物PRで管理します。フェーズ01のテスト成功は、ルール互換性や棋力の達成を意味しません。
