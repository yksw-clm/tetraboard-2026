# TetraBoard 四人将棋AI

人間が4人そろわないときも、プレイヤーの棋力に合うCPUを補充してランダムマッチを成立させるための独立Pythonプロジェクトです。ルールをPythonで実装し、既存TypeScript版は互換性の照合に使います。評価・探索・学習モデルは新規開発します。

2026-11-06の開発者指示で、従来のAI開発計画をこの計画へ全面置換しました。旧計画の1か月目標・優勝者級の認定・TS探索再利用・学習先行・VPS採用を新計画へ引き継ぎません。既存実装の撤去や公開CPUの切替はオンライン統合時に別途判断します。

## 現在の実装範囲

フェーズ01の入力検証・[設計契約](docs/design.md)に加え、02として三人攻撃禁止ON／OFFの初期化、合法手生成、着手・外部脱落・引分提案の適用、終局までの再生を実装しています。ONでは4分類の攻撃、応手・取り返し・同一標的・一手撃破・選択肢がない場合の例外、履歴の解除・再開始と千日手への反映を扱います。探索・学習・オンライン接続は未実装です。

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

`ai:check` はRuff整形確認・Lint、mypy strict、pytestを順に実行します。pytestは固定例・決定的なHypothesis生成例と、実BunプロセスでのTS入力検証器・ON／OFFルールとの逐次比較を含みます。TS側の比較入口はルートの型検査対象です。全体の `bun run check` とFull CIにも組み込み、Fast CIでは未実行として表示します。

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

## ON／OFFのルールを使う

```python
from four_shogi_ai import (
    ActionEvent,
    InitialOptions,
    apply_event,
    create_initial_state,
    legal_actions,
)

state = create_initial_state(InitialOptions(("s", "w", "n", "e"), True))
result = apply_event(state, ActionEvent("south", legal_actions(state)[0]))
assert result.ok
assert result.state.move_number == 1
assert state.move_number == 0  # 元の状態は不変
```

`replay(parse_replay(json_value))` で `eventOffset` までの完全状態を復元します。形状エラーは `ReplayInputError`、再生中のルール拒否は `ReplayExecutionError`（`code`、`event_index`、`reason`）です。状態には反復辞書を含み、表示用frameで置き換えません。

`InitialOptions` の第2引数でON（`True`）／OFF（`False`）を指定します。ONは4人生存中だけ作用し、誰かが脱落したら履歴と制限を解除します。三人攻撃の拒否理由は `three_player_attack` です。

ON／OFFの版付き再生入力を実TSと照合する開発用コマンドです。入力と出力には絶対パスを指定します。

```sh
mise exec -- uv run --locked --directory ai/four-shogi-ai python scripts/rule_comparison.py /tmp/replay.json --output /tmp/rule-comparison.json
```

初期局面と各イベント後の合法手集合・完全状態・遷移結果を比較します。結果JSONに入力、両実装のコミット、作業ツリーの変更有無、比較器の版、最初の不一致を記録し、不一致なら非零終了します。出力先は通常Gitへ追加しません。テスト内の不一致はpytestの一時ディレクトリへ同じ再現情報を保存します。

## 後続の進め方

ルール検証 → 自己対局・評価基盤 → 探索 → 棋風・棋力帯 → TetraBoard統合 → 機械学習の順に進めます。各フェーズの完了はNotionの完了条件と成果物PRで管理します。02のOFFとONは別PRで実装し、両設定の終局再生と逐次比較を受入条件にします。03で生成対局の範囲・失敗列の縮小・性能測定を拡張します。固定例と短い生成列の一致を、全到達局面の一致や棋力の認定とは扱いません。
