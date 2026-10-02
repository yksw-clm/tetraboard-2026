import { Button, Card, Input, Label, TextField } from "@heroui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import {
  accountPaths,
  formatRatio,
  historyPageSchema,
  profileInputSchema,
  statisticsSchema,
  usernameSchema,
  type AccountProfile,
  type AccountStatistics,
  type HistoryEntry,
  type RoomMode,
} from "@tetraboard/protocol";
import { useAccount } from "./useAccount";
import { accountRequest, authClient, convertAvatar } from "./accountApi";
import { PlayerAvatar } from "../../shared/PlayerAvatar";
import { LobbyDialog } from "../lobby/LobbyDialog";
import { ModeSelect } from "./RankingCard";
import "../lobby/lobby.css";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "処理できませんでした。もう一度お試しください。";
function AccountShell({ children }: { children: ReactNode }) {
  return (
    <div className="four-reversi-lobby account-page">
      <header className="lobby-header">
        <div className="lobby-header-inner">
          <Link className="lobby-brand" to="/games/four-reversi">
            TetraBoard
          </Link>
          <Link to="/games/four-reversi">ロビーへ</Link>
        </div>
      </header>
      <main className="account-main">{children}</main>
    </div>
  );
}
export function LoginPage() {
  const { user, loading, error, refresh } = useAccount();
  const [params] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!loading && user)
    return <Navigate to={user.profileCompleted ? "/account" : "/account/setup"} replace />;
  async function login(provider: "google" | "discord") {
    setBusy(true);
    setMessage(null);
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: "/account",
        newUserCallbackURL: "/account/setup",
        errorCallbackURL: "/login?error=oauth",
      });
      if (result.error)
        throw new Error(
          "ログインできませんでした。登録元のサービスとメール確認状態を確認して、もう一度お試しください。",
        );
    } catch (err) {
      setMessage(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountShell>
      <Card className="account-card login-card">
        <h1>ログイン</h1>
        <p>アカウントを作ると、戦績と対局履歴を残せます。</p>
        <Button isDisabled={busy || loading} onPress={() => void login("google")}>
          Googleで続ける
        </Button>
        <Button
          variant="secondary"
          isDisabled={busy || loading}
          onPress={() => void login("discord")}
        >
          Discordで続ける
        </Button>
        <p className="account-muted">初めての方は、続けて名前とIDを設定します。</p>
        {(message || error || params.has("error")) && (
          <p role="alert">
            {message ??
              error ??
              "ログインがキャンセルされたか、連携できませんでした。もう一度お試しください。"}
          </p>
        )}
        {error && (
          <Button variant="secondary" onPress={() => void refresh()}>
            再読み込み
          </Button>
        )}
        <Link to="/games/four-reversi">ゲストとして遊ぶ</Link>
      </Card>
    </AccountShell>
  );
}
function AvatarEditor({ user }: { user: AccountProfile }) {
  const { refresh } = useAccount();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function select(file?: File) {
    const version = ++selection.current;
    setBlob(null);
    setPreview(null);
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      const converted = await convertAvatar(file);
      if (version === selection.current) {
        setBlob(converted);
        setPreview(URL.createObjectURL(converted));
      }
    } catch (err) {
      if (version === selection.current) setError(messageOf(err));
    } finally {
      if (version === selection.current) setBusy(false);
    }
  }
  function close() {
    if (busy) return;
    setOpen(false);
    setBlob(null);
    setPreview(null);
    setError(null);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  async function save(remove = false) {
    if (busy || (!remove && !blob)) return;
    setBusy(true);
    setError(null);
    try {
      await accountRequest(
        accountPaths.avatar,
        remove
          ? { method: "DELETE" }
          : { method: "PUT", headers: { "Content-Type": "image/webp" }, body: blob },
      );
      await refresh();
      setOpen(false);
      setBlob(null);
      setPreview(null);
      requestAnimationFrame(() => trigger.current?.focus());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="account-avatar-edit">
        <PlayerAvatar avatarUrl={user.avatarUrl} className="account-avatar" />
        <Button
          ref={trigger}
          isIconOnly
          className="account-pencil"
          aria-label="アイコンを編集"
          onPress={() => setOpen(true)}
        >
          ✎
        </Button>
      </div>
      {open && (
        <LobbyDialog title="アイコンを編集" busy={busy} onClose={close}>
          <div className="account-avatar-dialog">
            <PlayerAvatar avatarUrl={preview ?? user.avatarUrl} className="account-avatar" />
            <label>
              画像を選択
              <input
                aria-label="アップロードする画像"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(event) => void select(event.target.files?.[0])}
              />
            </label>
            <p>JPEG・PNG・WebP、5MB以下。中央を正方形に切り出します。</p>
            {error && <p role="alert">{error}</p>}
            <Button isDisabled={busy || !blob} onPress={() => void save()}>
              保存
            </Button>
            <Button
              variant="secondary"
              isDisabled={busy || !user.avatarUrl}
              onPress={() => void save(true)}
            >
              アイコンを削除
            </Button>
          </div>
        </LobbyDialog>
      )}
    </>
  );
}
function ProfileEditor({ user, setup }: { user: AccountProfile; setup: boolean }) {
  const { refresh } = useAccount();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<"name" | "username" | null>(null);
  const [name, setName] = useState(user.name);
  const [username, setUsername] = useState(user.username ?? "");
  const [availability, setAvailability] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameButton = useRef<HTMLButtonElement>(null);
  const idButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!setup && editing !== "username") return;
    const parsed = usernameSchema.safeParse(username);
    if (!parsed.success) return;
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      void accountRequest(`${accountPaths.username}?username=${encodeURIComponent(parsed.data)}`, {
        signal: abort.signal,
      })
        .then((value) => {
          if (!abort.signal.aborted)
            setAvailability(
              (value as { available: boolean }).available
                ? "このIDを使えます。"
                : "このIDはすでに使われています。",
            );
        })
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [username, setup, editing]);
  function finishEditing() {
    const ref = editing === "name" ? nameButton : idButton;
    setEditing(null);
    requestAnimationFrame(() => ref.current?.focus());
  }
  async function save() {
    if (busy) return;
    const parsed = profileInputSchema.safeParse({ name, username });
    if (!parsed.success) {
      setError("名前は1〜10文字、IDは半角英数字と_の3〜20文字にしてください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await accountRequest(setup ? accountPaths.setup : accountPaths.profile, {
        method: setup ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      await refresh();
      if (setup) await navigate("/account", { replace: true });
      else finishEditing();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="account-card">
      <div className="account-profile">
        <AvatarEditor user={user} />
        <form
          className="account-profile-fields"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {setup || editing === "name" ? (
            <TextField value={name} onChange={setName} isDisabled={busy}>
              <Label>名前</Label>
              <Input autoFocus autoComplete="nickname" maxLength={100} />
            </TextField>
          ) : (
            <div className="account-profile-value">
              <h2>{user.name}</h2>
              <Button
                ref={nameButton}
                variant="ghost"
                isIconOnly
                aria-label="名前を編集"
                onPress={() => {
                  setName(user.name);
                  setUsername(user.username ?? "");
                  setEditing("name");
                  setError(null);
                }}
              >
                ✎
              </Button>
            </div>
          )}
          {setup || editing === "username" ? (
            <TextField
              value={username}
              onChange={(value) => {
                setUsername(value);
                setAvailability(null);
              }}
              isDisabled={busy}
            >
              <Label>ID（@の後ろ）</Label>
              <Input
                autoFocus={!setup}
                autoComplete="username"
                autoCapitalize="none"
                maxLength={20}
              />
              <p className="account-muted">半角英数字と_、3〜20文字</p>
              <p role="status">{availability}</p>
            </TextField>
          ) : (
            <div className="account-profile-value">
              <span className="account-muted">@{user.username}</span>
              <Button
                ref={idButton}
                variant="ghost"
                isIconOnly
                aria-label="IDを編集"
                onPress={() => {
                  setName(user.name);
                  setUsername(user.username ?? "");
                  setEditing("username");
                  setError(null);
                }}
              >
                ✎
              </Button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {(setup || editing) && (
            <div className="account-actions">
              <Button type="submit" isDisabled={busy}>
                {busy ? "保存中…" : setup ? "設定してはじめる" : "保存"}
              </Button>
              {!setup && (
                <Button
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => {
                    setError(null);
                    finishEditing();
                  }}
                >
                  取消
                </Button>
              )}
            </div>
          )}
        </form>
      </div>
      <p className="account-muted">
        変更は次の入室から反映されます。過去の対局は当時の表示を保持します。
      </p>
    </Card>
  );
}
function HistoryCard({ entry }: { entry: HistoryEntry }) {
  const colorNames = { black: "黒", white: "白", red: "赤", blue: "青" };
  return (
    <Card className="account-history-card">
      <p className="account-muted">
        {new Date(entry.finishedAt).toLocaleString("ja-JP")} ·{" "}
        {entry.mode === "singles" ? "シングルス" : "ダブルス"}
      </p>
      <div className="account-history-players">
        {entry.players.map((player) => (
          <div key={player.participantId}>
            <PlayerAvatar {...player} />
            <span>
              <small>
                {player.outcome === "placement"
                  ? player.placement === 1
                    ? "優勝"
                    : `${player.placement}位`
                  : player.outcome === "win"
                    ? "勝利"
                    : player.outcome === "loss"
                      ? "敗北"
                      : "引き分け"}
              </small>
              <strong>{player.name}</strong>
            </span>
          </div>
        ))}
      </div>
      <div className="account-final-board" role="img" aria-label="対局の最終盤面">
        {entry.finalState.board.flatMap((row, y) =>
          row.map((cell, x) => (
            <span
              key={`${x}-${y}`}
              className="account-board-cell"
              title={`${"ABCDEFGH"[x]}${y + 1}：${cell ? colorNames[cell] : "空き"}`}
            >
              {cell && <i className={`account-stone account-stone-${cell}`} />}
            </span>
          )),
        )}
      </div>
      <Button isDisabled>棋譜を見る</Button>
      <small className="account-muted">準備中</small>
    </Card>
  );
}
function AccountRecords() {
  const [mode, setMode] = useState<RoomMode>("singles");
  return (
    <section className="account-records">
      <ModeSelect mode={mode} onChange={setMode} />
      <RecordsForMode key={mode} mode={mode} />
    </section>
  );
}
function RecordsForMode({ mode }: { mode: RoomMode }) {
  const [stats, setStats] = useState<AccountStatistics | null>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true);
  const loadingMore = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void Promise.all([
      accountRequest(`${accountPaths.statistics}?mode=${mode}`, { signal: controller.signal }),
      accountRequest(`${accountPaths.history}?mode=${mode}`, { signal: controller.signal }),
    ])
      .then(([summary, history]) => {
        if (controller.signal.aborted) return;
        setStats(statisticsSchema.parse(summary));
        const page = historyPageSchema.parse(history);
        setEntries(page.entries);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(messageOf(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [mode, retry]);
  async function loadMore() {
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    setBusy(true);
    setError(null);
    try {
      const page = historyPageSchema.parse(
        await accountRequest(
          `${accountPaths.history}?mode=${mode}&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      if (mounted.current) {
        setEntries((old) => [
          ...old,
          ...page.entries.filter((entry) => !old.some((item) => item.id === entry.id)),
        ]);
        setCursor(page.nextCursor);
      }
    } catch (err) {
      if (mounted.current) setError(messageOf(err));
    } finally {
      loadingMore.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const rows: [string, number][] = stats
    ? mode === "singles"
      ? [
          ["優勝数", stats.first],
          ["2位数", stats.second],
          ["3位数", stats.third],
          ["4位数", stats.fourth],
        ]
      : [
          ["勝利数", stats.wins],
          ["敗北数", stats.losses],
          ["引き分け数", stats.draws],
        ]
    : [];
  return (
    <>
      <Card className="account-card">
        <h2>戦績</h2>
        {stats && (
          <dl className="account-statistics">
            <div>
              <dt>対局数</dt>
              <dd>{stats.total}</dd>
            </div>
            {rows.map(([label, count]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {count} <span className="account-muted">({formatRatio(count, stats.total)})</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      <h2>対局履歴</h2>
      {busy && <p role="status">読み込み中…</p>}
      {error && (
        <p role="alert">
          {error}
          <Button
            variant="secondary"
            onPress={() => {
              setBusy(true);
              setError(null);
              setRetry(retry + 1);
            }}
          >
            再読み込み
          </Button>
        </p>
      )}
      {!busy && !error && !entries.length && (
        <p className="account-muted">
          まだ対局履歴がありません。ログインした状態で参加した対局が残ります。
        </p>
      )}
      <div className="account-history-grid">
        {entries.map((entry) => (
          <HistoryCard entry={entry} key={entry.id} />
        ))}
      </div>
      {cursor && (
        <Button isDisabled={busy} variant="secondary" onPress={() => void loadMore()}>
          もっと見る
        </Button>
      )}
    </>
  );
}
export function AccountPage({ setup = false }: { setup?: boolean }) {
  const { user, loading, error, refresh } = useAccount();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (loading)
    return (
      <AccountShell>
        <p role="status">読み込み中…</p>
      </AccountShell>
    );
  if (error)
    return (
      <AccountShell>
        <p role="alert">{error}</p>
        <Button onPress={() => void refresh()}>再読み込み</Button>
      </AccountShell>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (!setup && !user.profileCompleted) return <Navigate to="/account/setup" replace />;
  if (setup && user.profileCompleted) return <Navigate to="/account" replace />;
  async function signOut() {
    setSigningOut(true);
    setMessage(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("ログアウトできませんでした。");
      await refresh();
      await navigate("/games/four-reversi");
    } catch (err) {
      setMessage(messageOf(err));
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <AccountShell>
      <h1>{setup ? "アカウント設定" : "アカウント"}</h1>
      {setup && <p>公開する名前とIDを設定してください。アイコンは後からでも設定できます。</p>}
      <ProfileEditor user={user} setup={setup} />
      {!setup && <AccountRecords key={user.username} />}
      <Button variant="secondary" isDisabled={signingOut} onPress={() => void signOut()}>
        ログアウト
      </Button>
      {message && <p role="alert">{message}</p>}
    </AccountShell>
  );
}
