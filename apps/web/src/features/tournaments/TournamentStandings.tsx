import { useEffect, useId, useRef, useState } from "react";
import type { TournamentDetail, TournamentStanding } from "@tetraboard/protocol";
import { AppCard } from "../../shared/ui/AppCard";
import { AppButton } from "../../shared/ui/AppButton";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppIcon } from "../../shared/ui/AppIcon";
import { PlayerProfileTrigger } from "../players/PlayerProfileTrigger";
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
    <PlayerProfileTrigger
      target={row.profileId ? { source: "profile", profileId: row.profileId } : null}
      game="four-shogi"
      mode="singles"
      theme="four-shogi"
      label={row.name}
      className="min-h-11 max-w-full"
    >
      <span className="flex items-center gap-1.5 [@media(max-width:400px)]:gap-1">
        <AppAvatar
          src={row.avatarUrl}
          className={large ? "size-11" : "size-6 [@media(max-width:400px)]:size-5"}
        />
        <span className="inline-block shrink-0 font-semibold whitespace-nowrap">{row.name}</span>
      </span>
    </PlayerProfileTrigger>
  );
}
function StandingRow({ row }: { row: TournamentStanding }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const stats = [
    ["対局数", row.games],
    ["優勝数", row.first],
    ["2位数", row.second],
    ["3位数", row.third],
    ["4位数", row.fourth],
    ["撃破数", row.knockouts],
    ["平均順位", row.games ? (row.rankSum / row.games).toFixed(2) : "—"],
  ] as const;
  const rankColor =
    row.rank === 1
      ? "text-[#876100]"
      : row.rank === 2
        ? "text-[#626b78]"
        : row.rank === 3
          ? "text-[#95542e]"
          : "text-ink";
  return (
    <>
      <tr
        className={`border-b border-solid border-line last:border-b-0 ${row.self ? "bg-surface-muted" : ""}`}
      >
        <td
          className={`py-2 pr-1.5 pl-1 font-bold whitespace-nowrap [@media(max-width:400px)]:px-0.5 ${rankColor}`}
        >
          {row.rank ? `${row.rank}位` : "—"}
          {row.self && <span className="block text-[9px] font-normal text-muted">あなた</span>}
        </td>
        <th scope="row" className="py-2 pr-1.5 font-normal [@media(max-width:400px)]:text-[11px]">
          <TournamentPlayer row={row} />
        </th>
        <td className="px-1 py-2 text-right whitespace-nowrap tabular-nums [@media(max-width:400px)]:px-0.5">
          <strong className="text-base font-bold">{tournamentPoints(row.pointsUnits)}</strong>
          <span className="ml-0.5 text-[10px] text-muted">点</span>
        </td>
        {stats.map(([label, value]) => (
          <td
            key={label}
            className="px-1 py-2 text-right tabular-nums [@media(max-width:767px)]:hidden"
          >
            {value}
          </td>
        ))}
        <td className="w-11 p-0 [@media(min-width:768px)]:hidden">
          <AppButton
            appearance="quiet"
            size="compact"
            className="size-11 min-h-11 px-0"
            aria-label={`${row.name}の成績${expanded ? "を閉じる" : "を表示"}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onPress={() => setExpanded((value) => !value)}
          >
            <AppIcon name="chevronDown" className={`size-4 ${expanded ? "rotate-180" : ""}`} />
          </AppButton>
        </td>
      </tr>
      <tr
        hidden={!expanded}
        className={`[@media(min-width:768px)]:hidden ${row.self ? "bg-surface-muted" : ""}`}
      >
        <td colSpan={11} className="border-b border-solid border-line px-3 py-3">
          <dl
            id={detailsId}
            aria-label={`${row.name}の大会成績`}
            className="grid grid-cols-3 gap-x-3 gap-y-2 rounded-control bg-surface-muted p-3"
          >
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt className="text-[11px] text-muted">{label}</dt>
                <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </td>
      </tr>
    </>
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
    !rows.some(
      (row) =>
        row.self ||
        (row.profileId && row.profileId === self.profileId) ||
        (row.username !== null && row.username === self.username),
    );
  const hasGames = rows.some((row) => row.games > 0);
  const finished = detail.tournament.status === "finished";
  return (
    <AppCard className="@container min-w-0 gap-3 p-4 [@media(max-width:400px)]:p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{finished ? "最終順位" : "順位表"}</h2>
          {finished && (
            <p className="mt-1 text-xs text-muted">すべての対象対局の結果が確定しました。</p>
          )}
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
      <div className={`flex flex-col gap-3 ${showAll ? "" : "min-h-60"}`}>
        <div className="overflow-x-auto" role="region" aria-label="大会順位表" tabIndex={0}>
          <table className="w-full border-collapse text-left text-xs [@media(min-width:768px)]:min-w-[560px]">
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
                  className="py-2 pr-1.5 font-medium whitespace-nowrap [@media(min-width:768px)]:w-[calc(10em+30px)]"
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
                    className={`px-1 py-2 text-right font-medium whitespace-nowrap [@media(max-width:400px)]:px-0.5 ${label === "勝ち点" ? "" : "[@media(max-width:767px)]:hidden"}`}
                  >
                    {label}
                  </th>
                ))}
                <th scope="col" className="[@media(min-width:768px)]:hidden">
                  <span className="sr-only">成績詳細</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {!hasGames && (!showAll || all) && (
                <tr>
                  <td colSpan={11} className="p-0">
                    <p
                      className={`sticky left-0 flex w-[100cqw] max-w-full items-center justify-center rounded-control bg-surface-muted p-5 text-center text-sm text-muted ${showAll ? "" : "min-h-60"}`}
                    >
                      {finished
                        ? "有効対局がなかったため、今回は対局不成立となりました。表彰はありません。"
                        : "まだ対局結果はありません。最初の対局が終了すると、順位が表示されます。"}
                    </p>
                  </td>
                </tr>
              )}
              {rows.map((row, index) => (
                <StandingRow key={row.profileId ?? row.username ?? `deleted-${index}`} row={row} />
              ))}
              {separateSelf && (
                <>
                  <tr>
                    <td colSpan={11} className="py-2 text-center text-xs text-muted">
                      ⋯
                    </td>
                  </tr>
                  <StandingRow row={self} />
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
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
