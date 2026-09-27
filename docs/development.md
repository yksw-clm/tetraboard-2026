# Development

## Development Strategy

土台 → Vertical Slice → ロビー → ルーム → 四人リバーシ → E2E
の順で開発します。

## Code Principles

C#/.NET標準ライブラリのような、一貫性があり読みやすいコードを目指します。

過度な抽象化より、意図が明確なコードを優先します。

## Naming

- ファイル名: PascalCase
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