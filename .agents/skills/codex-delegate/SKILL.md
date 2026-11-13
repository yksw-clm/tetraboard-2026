---
name: codex-delegate
description: Claude Code が Codex CLI を呼んで実装を任せ、差分をレビューして PR にするまでの手順。Notion のタスクを実装に回すとき、Codex に修正を頼むとき、Codex に追加レビューを頼むときに使う。
---

# Codex への実装の委任

Claude Code が設計とレビューを受け持ち、実装は Codex CLI（`codex exec`）に任せる。Codex は worktree の中のファイルを変えるだけで、commit、push、PR 作成は Claude Code が行う。

試運転（TB-18、2026-11-14、codex-cli 0.162.1）で確かめたこと:

- 下の `codex exec` のコマンドは、承認を求めて止まることなく最後まで動いた。Codex は依頼文に書いた lint と整形のコマンドを自分で実行し、対象のファイルだけを変更し、commit はしなかった。
- 書き込めるのは、worktree、`/tmp`、`$TMPDIR` だけである。
- Bun のコマンドは `mise exec --` を付けて実行する。付けないと、手元の古い Bun が使われて型チェックが失敗する。依頼文に書くコマンドにも付ける。

**未確認**: 直しを頼むときに前の会話を引き継ぐ方法（`codex exec resume`）と、サンドボックスの中で `bun run check` の全体が通るかは、まだ試していない。check は Claude Code が worktree で実行する。

## 始める前に

- Notion のタスクが Todo で、本文に設計と受け入れ条件がある（[notion-tasks](../notion-tasks/SKILL.md)）。未決が残っていれば、先に開発者へ確認する。
- フェーズの設計が開発者に承認されている。
- 同時に動かすのは 2 本まで。触るファイルが重なるタスクは並べない。`packages/protocol` と DB スキーマを変えるタスクは 1 本ずつ進める。

## 手順

1. **Notion を In Progress にする。**

2. **worktree を作る。** 置き場所はリポジトリの外にする。

   ```sh
   git fetch origin develop
   git worktree add ../tetraboard-2026-wt/tb-123 -b feat/tb-123-short-name origin/develop
   (cd ../tetraboard-2026-wt/tb-123 && mise exec -- bun install --frozen-lockfile)
   ```

   依存は Codex を呼ぶ前に入れておく。Codex には `bun install` を実行させない。

3. **依頼文を書く。** リポジトリの外の一時ファイルに書く。Notion の本文を写すのではなく、Codex がこの文だけで作業できるように書き直す。入れる内容は次のとおり。
   - タスク ID と目的（なぜ必要か）。
   - 変更してよい範囲（パッケージ、ディレクトリ）と、触ってはいけない範囲。
   - 受け入れ条件。足すべきテストと、通すべきコマンド（`bun run check`）。
   - 守ること: commit、push、PR 作成をしない。依存を足さない。仕様にない振る舞いを推測で足さない。迷ったら実装せず、最後の報告に疑問として書く。
   - 最後に報告すること: 変えたファイル、実行したコマンドと結果、未解決の疑問。

4. **Codex を呼ぶ。** 数分以上かかるので、バックグラウンドで実行する。

   ```sh
   codex exec -C ../tetraboard-2026-wt/tb-123 -s workspace-write -o /path/to/report.md - < /path/to/brief.md
   ```

5. **差分をレビューする。** Codex の報告は主張であり、確認結果ではない。自分で確かめる。
   - `git -C <worktree> status` と `git -C <worktree> diff` を読む。範囲外のファイルが変わっていないか見る。
   - 受け入れ条件を 1 つずつ照合する。
   - 仕様にない振る舞いが足されていないか、依存の向きを破っていないか、テストが振る舞いを確かめているかを見る。
   - worktree で `mise exec -- bun run check` を実行する。

6. **直しが必要なら Codex に戻す。** 指摘を具体的に書いて、同じ worktree でもう一度呼ぶ。小さな直しでも、実装コードは自分で書かない。3 往復しても受け入れ条件を満たさないときは、設計か依頼文に問題があるとみて、タスクの本文を見直す。

7. **コミットして PR を作る。** コミットと PR の形は AGENTS.md に従う。PR 本文には、検証対象のコミット、確認の結果、未確認事項を書く。

8. **Notion を In Review にし、PR の URL を入れる。** 開発者に、何を変えたか、何を確かめたか、何が未確認かを報告する。

9. **マージ後に片づける。** 開発者の承認を得てマージしたら、Notion を Done にし、worktree を消す。

   ```sh
   git worktree remove ../tetraboard-2026-wt/tb-123
   ```

## 追加レビューを頼むとき

次のいずれかに当たる PR は、開発者へ出す前に Codex のレビューも取る。指摘は自分で妥当性を判断し、採否を PR 本文に書く。

- DB スキーマ、migration、Durable Object の保存形式を変える。
- 認証、セッション、退会、ゲスト統合に触る。
- `packages/protocol` の契約を変える。
- 本番データの移行を含む。

```sh
cd ../tetraboard-2026-wt/tb-123 && codex exec review --base origin/develop
```
