import { useEffect, useState } from "react";
import { getPublicMatchContract, type PublicMatchDetail } from "@tetraboard/protocol";
import { matchPostIntent, matchShareRows } from "@tetraboard/protocol/match-sharing";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { XIcon } from "../../shared/ui/XIcon";

const shareButtonClasses =
  "w-full shadow-none [--color-primary:#000] [--color-primary-hover:#262626] [--color-primary-foreground:#fff]";

type ShareState = {
  key: string;
  status: "saving" | "error" | "ready";
  match?: PublicMatchDetail;
};

export function ResultShareButton({ matchId, selfId }: { matchId: string; selfId: string }) {
  const [attempt, setAttempt] = useState(0);
  const key = `${matchId}:${selfId}:${attempt}`;
  const [state, setState] = useState<ShareState>({ key, status: "saving" });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingChecks = 0;
    async function check() {
      try {
        const response = await fetch(`/api/matches/${matchId}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        if (controller.signal.aborted) return;
        if (response.status === 404 && pendingChecks++ < 12) {
          timer = setTimeout(() => void check(), 5000);
          return;
        }
        if (!response.ok) throw new Error("Match unavailable");
        const match = getPublicMatchContract.response.parse(await response.json()).match;
        if (match.id !== matchId) throw new Error("Unexpected match");
        if (!match.participants.some((player) => player.id === selfId))
          throw new Error("Not a participant");
        if (!controller.signal.aborted) setState({ key, status: "ready", match });
      } catch {
        if (!controller.signal.aborted) setState({ key, status: "error" });
      }
    }
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [matchId, selfId, key]);
  const current = state.key === key ? state : { status: "saving" as const };
  const match = "match" in current ? current.match : undefined;
  const intent = match ? matchPostIntent(match, selfId, window.location.origin) : null;
  const winner = match && matchShareRows(match).find((row) => row.id === selfId)?.winner;
  return (
    <div className="mt-4">
      {current.status === "ready" && intent ? (
        <AppButtonLink
          to={intent}
          target="_blank"
          rel="noopener noreferrer"
          className={shareButtonClasses}
          appearance="primary"
        >
          <XIcon />
          {winner ? "フォロワーに自慢する" : "結果をポストする"}
        </AppButtonLink>
      ) : (
        <>
          <AppButton
            className={shareButtonClasses}
            appearance="primary"
            isDisabled={current.status === "saving"}
            onPress={() => setAttempt((previous) => previous + 1)}
          >
            <XIcon />
            {current.status === "error" ? "共有の準備を再試行" : "共有の準備中…"}
          </AppButton>
          <p
            className="mt-2 text-xs text-muted"
            role={current.status === "error" ? "alert" : "status"}
          >
            {current.status === "error"
              ? "棋譜を取得できませんでした。再試行してください。"
              : "棋譜の保存を待っています。"}
          </p>
        </>
      )}
    </div>
  );
}
