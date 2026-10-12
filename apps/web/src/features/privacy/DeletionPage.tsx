import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useAccount } from "../account/useAccount";
import { accountRequest } from "../account/accountApi";
import { AccountPageShell } from "../account/AccountPages";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
const receiptKey = "tetraboard:deletion-receipt";
export function DeletionPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const [receipt, setReceipt] = useState(() => {
    try {
      return sessionStorage.getItem(receiptKey);
    } catch {
      return null;
    }
  });
  const [state, setState] = useState<{
    verified: boolean;
    seated: boolean;
    changedAccount?: boolean;
  } | null>(null);
  const [status, setStatus] = useState("processing");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).has("error")
      ? "再認証が完了しませんでした。登録した方法で再度認証してください。"
      : null,
  );
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let canceled = false;
    const refresh = async () => {
      try {
        if (receipt) {
          const result = (await accountRequest("/api/account/deletion/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ receipt }),
          })) as { status: string };
          if (!canceled) {
            setStatus(result.status);
            setError(null);
          }
        } else if (account.user) {
          const result = (await accountRequest("/api/account/deletion/confirmation")) as {
            verified: boolean;
            seated: boolean;
            changedAccount?: boolean;
          };
          if (!canceled) setState(result);
        }
      } catch (e) {
        if (!canceled) setError(e instanceof Error ? e.message : "確認できませんでした。");
      }
    };
    void refresh();
    const timer = receipt ? setInterval(() => void refresh(), 10000) : undefined;
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [receipt, account.user, revision]);
  async function reauth() {
    setBusy(true);
    setError(null);
    try {
      const result = (await accountRequest("/api/account/deletion/reauth", { method: "POST" })) as {
        url: string;
      };
      const url = new URL(result.url);
      if (!["https://accounts.google.com", "https://discord.com"].includes(url.origin))
        throw new Error("再認証を開始できません。");
      window.location.assign(url.href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "再認証できません。");
      setBusy(false);
    }
  }
  async function remove() {
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const result = (await accountRequest("/api/account/deletion/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })) as { receipt: string };
      setReceipt(result.receipt);
      try {
        sessionStorage.setItem(receiptKey, result.receipt);
      } catch {
        /* 現在の画面で状況確認を続けます。 */
      }
      account.update(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除できません。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountPageShell>
      <AppCard>
        <h1 className="text-xl font-bold">アカウントの削除</h1>
        {receipt ? (
          <>
            <p role="status">
              {status === "complete"
                ? "アカウントの削除が完了しました。"
                : "削除を受け付けました。情報の削除と連携解除を処理しています。"}
            </p>
            <p>
              棋譜・結果は「退会したプレイヤー」の表記で残ります。このタブから削除状況を確認できます。
            </p>
            {status === "complete" && (
              <AppButton
                onPress={() => {
                  try {
                    sessionStorage.removeItem(receiptKey);
                  } catch {
                    /* 現在の画面では閉じます。 */
                  }
                  setReceipt(null);
                }}
              >
                確認を閉じる
              </AppButton>
            )}
          </>
        ) : !account.user ? (
          <AppButtonLink to="/login">登録した方法でログイン</AppButtonLink>
        ) : (
          <>
            <p>
              現在のログイン：{account.user.name || "名前未設定"}
              {account.user.username ? `（@${account.user.username}）` : ""}
            </p>
            <p>
              プロフィール・認証情報・本人履歴・バッジ・個別計測・本人のフィードバック等を削除します。棋譜・結果・相手の記録は残り、あなたの旧名と画像は「退会したプレイヤー」に置き換わります。再登録しても旧記録は復元されません。
            </p>
            {state?.changedAccount && (
              <p role="alert">
                再認証したアカウントが削除対象と異なります。元のアカウントでログインし直してください。
              </p>
            )}
            {state?.seated ? (
              <>
                <p>待機・対局中の部屋から退室してから削除してください。</p>
                <AppButton onPress={() => setRevision((v) => v + 1)}>退室後に確認</AppButton>
              </>
            ) : state?.verified ? (
              <>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  削除対象と残る棋譜を確認し、アカウントを削除します。
                </label>
                <AppButton
                  appearance="danger"
                  isDisabled={busy || !confirmed}
                  isPending={busy}
                  onPress={() => void remove()}
                >
                  アカウントを削除
                </AppButton>
              </>
            ) : (
              <AppButton
                isDisabled={busy || state?.changedAccount}
                isPending={busy}
                onPress={() => void reauth()}
              >
                登録した方法で再認証
              </AppButton>
            )}
          </>
        )}
        {!receipt && (
          <AppButton
            appearance="quiet"
            isDisabled={busy}
            onPress={() => {
              setBusy(true);
              void accountRequest("/api/account/deletion/cancel", { method: "POST" })
                .then(() => navigate("/account"))
                .catch((e) => {
                  setError(e instanceof Error ? e.message : "手続きを終了できません。");
                  setBusy(false);
                });
            }}
          >
            削除手続きをやめる
          </AppButton>
        )}
        {error && (
          <>
            <p role="alert" className="text-danger">
              {error}
            </p>
            <AppButton appearance="secondary" onPress={() => setRevision((v) => v + 1)}>
              再試行
            </AppButton>
          </>
        )}
      </AppCard>
    </AccountPageShell>
  );
}
