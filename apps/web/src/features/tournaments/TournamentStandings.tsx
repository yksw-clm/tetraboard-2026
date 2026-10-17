import { useEffect, useRef, useState } from "react";
import type { TournamentDetail, TournamentStanding } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { tournamentPoints } from "./tournamentPresentation";
import { readTournamentStandings } from "./tournamentApi";

export function TournamentPlayer({
  row,
  large = false,
}: {
  row: TournamentStanding;
  large?: boolean;
}) {
  return (
    <span>
      <span className="flex items-center gap-1.5">
        <AppAvatar src={row.avatarUrl} className={large ? "size-11" : "size-6"} />
        <span className="inline-block min-w-[10em] shrink-0 font-semibold whitespace-nowrap">
          {row.name}
        </span>
      </span>
    </span>
  );
}
function StandingRow({ row }: { row: TournamentStanding }) {
  return (
    <tr
      className={`border-b border-solid border-line last:border-b-0 ${row.self ? "bg-surface-muted" : ""}`}
    >
      <td className="py-2 pr-1.5 pl-1 font-bold whitespace-nowrap text-brand">
        {row.rank ? `${row.rank}位` : "—"}
        {row.self && <span className="block text-[9px] font-normal text-muted">あなた</span>}
      </td>
      <th scope="row" className="py-2 pr-1.5 font-normal">
        <TournamentPlayer row={row} />
      </th>
      {[
        tournamentPoints(row.pointsUnits),
        row.games,
        row.first,
        row.second,
        row.third,
        row.fourth,
        row.knockouts,
        row.games ? (row.rankSum / row.games).toFixed(2) : "—",
      ].map((value, index) => (
        <td key={index} className="px-1 py-2 text-right tabular-nums">
          {value}
        </td>
      ))}
    </tr>
  );
}
export function TournamentStandings({ detail }: { detail: TournamentDetail }) {
  const [showAll, setShowAll] = useState(false);
  const [all, setAll] = useState<{
    rows: TournamentStanding[];
    nextCursor: string | null;
    self: TournamentStanding | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const pageCount = useRef(1);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!showAll) return;
    let disposed = false;
    async function refresh() {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      try {
        let page = await readTournamentStandings(
          detail.tournament.id,
          undefined,
          controller.signal,
        );
        const rows = [...page.standings];
        for (let index = 1; index < pageCount.current && page.nextCursor; index++) {
          page = await readTournamentStandings(
            detail.tournament.id,
            page.nextCursor,
            controller.signal,
          );
          rows.push(...page.standings);
        }
        if (!disposed) {
          setAll({ rows, nextCursor: page.nextCursor, self: page.self });
          setError(null);
        }
      } catch {
        if (!disposed) setError("全順位を取得できませんでした。");
      } finally {
        if (request.current === controller) request.current = null;
      }
    }
    const timeout = window.setTimeout(() => void refresh(), 0);
    const visibleRefresh = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(visibleRefresh, 5000);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => {
      disposed = true;
      request.current?.abort();
      request.current = null;
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibleRefresh);
    };
  }, [showAll, revision, detail.tournament.id]);
  async function more() {
    if (!all?.nextCursor || request.current || loading) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const page = await readTournamentStandings(
        detail.tournament.id,
        all.nextCursor,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setAll({
          rows: [...all.rows, ...page.standings],
          nextCursor: page.nextCursor,
          self: page.self,
        });
        pageCount.current++;
        setError(null);
      }
    } catch {
      if (!controller.signal.aborted) setError("続きの順位を取得できませんでした。");
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  const rows = showAll ? (all?.rows ?? []) : detail.standings;
  const self = showAll ? all?.self : detail.self;
  const separateSelf =
    self &&
    !rows.some((row) => row.self || (row.username !== null && row.username === self.username));
  const hasGames = rows.some((row) => row.games > 0);
  const finished = detail.tournament.status === "finished";
  return (
    <AppCard className="@container min-w-0 gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{finished ? "最終順位" : "順位表"}</h2>
          <p className="mt-1 text-xs text-muted">
            {finished
              ? "すべての対象対局の結果が確定しました。"
              : "終了・保存済みの大会対局を集計しています。順位は暫定です。"}
          </p>
        </div>
        <span className="text-xs text-muted">{showAll ? "全参加者" : "上位5位とあなたの成績"}</span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
          <AppButton
            appearance="quiet"
            size="compact"
            onPress={() => setRevision((value) => value + 1)}
          >
            再試行
          </AppButton>
        </p>
      )}
      {showAll && !all && !error && (
        <p role="status" className="text-sm text-muted">
          全順位を読み込んでいます…
        </p>
      )}
      {!hasGames && (!showAll || all) && (
        <p className="rounded-control bg-surface-muted p-5 text-center text-sm text-muted">
          {finished
            ? "有効対局がなかったため、今回は対局不成立となりました。表彰はありません。"
            : "まだ対局結果はありません。最初の対局が終了すると、順位が表示されます。"}
        </p>
      )}
      {(rows.length > 0 || separateSelf) && (
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="大会順位表（横スクロールできます）"
          tabIndex={0}
        >
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <caption className="sr-only">
              大会順位と成績。勝ち点、撃破数、平均順位の順に順位を決定します。
            </caption>
            <thead className="border-b border-solid border-line text-[11px] text-muted">
              <tr>
                <th scope="col" className="py-2 pr-1.5 font-medium whitespace-nowrap">
                  順位
                </th>
                <th
                  scope="col"
                  className="w-[calc(10em+30px)] py-2 pr-1.5 font-medium whitespace-nowrap"
                >
                  プレイヤー
                </th>
                {[
                  "勝ち点",
                  "対局数",
                  "優勝数",
                  "2位数",
                  "3位数",
                  "4位数",
                  "撃破数",
                  "平均順位",
                ].map((label) => (
                  <th
                    scope="col"
                    key={label}
                    className="px-1 py-2 text-right font-medium whitespace-nowrap"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <StandingRow key={row.username ?? `deleted-${index}`} row={row} />
              ))}
              {separateSelf && (
                <>
                  <tr>
                    <td colSpan={10} className="py-2 text-center text-xs text-muted">
                      ⋯
                    </td>
                  </tr>
                  <StandingRow row={self} />
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex justify-center gap-2">
        <AppButton appearance="quiet" size="compact" onPress={() => setShowAll((value) => !value)}>
          {showAll ? "上位5位に戻る" : "全員を見る"}
        </AppButton>
        {showAll && all?.nextCursor && (
          <AppButton
            appearance="secondary"
            size="compact"
            isPending={loading}
            isDisabled={loading}
            onPress={() => void more()}
          >
            もっと見る
          </AppButton>
        )}
      </div>
    </AppCard>
  );
}
