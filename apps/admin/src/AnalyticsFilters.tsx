import { useSearchParams } from "react-router";
import { useState } from "react";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { defaultPeriod } from "./presentation";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { NativeSelect } from "./components/ui/native-select";
import { Checkbox } from "./components/ui/checkbox";
import { Label } from "./components/ui/label";
import { Button } from "./components/ui/button";
export function useAnalyticsFilters() {
  const [params, setParams] = useSearchParams(),
    [initial] = useState(() => defaultPeriod("day"));
  const query = new URLSearchParams({
    from: params.get("from") ?? initial.from,
    to: params.get("to") ?? initial.to,
    game: params.get("game") ?? "all",
    includeInternal: params.get("includeInternal") ?? "false",
    bucket: "day",
    dateBasis: params.get("dateBasis") ?? "entry",
  });
  const update = (changes: Record<string, string>) => {
    const next = new URLSearchParams(query);
    for (const [k, v] of Object.entries(changes)) next.set(k, v);
    setParams(next);
  };
  return { query, update };
}
export function AnalyticsFilters({ query, update }: ReturnType<typeof useAnalyticsFilters>) {
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  return (
    <Card className="gap-4 p-5">
      <div className="flex flex-wrap gap-2">
        {[7, 30, 90].map((days) => (
          <Button
            key={days}
            variant="outline"
            onClick={() =>
              update({
                from: new Date(Date.parse(today) - (days - 1) * 86400000)
                  .toISOString()
                  .slice(0, 10),
                to: today,
              })
            }
          >
            直近{days}日
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <label className="space-y-2 text-sm">
          開始日
          <Input
            aria-label="開始日"
            type="date"
            max={today}
            value={query.get("from")!}
            onChange={(e) => update({ from: e.target.value })}
          />
        </label>
        <label className="space-y-2 text-sm">
          終了日
          <Input
            aria-label="終了日"
            type="date"
            max={today}
            value={query.get("to")!}
            onChange={(e) => update({ to: e.target.value })}
          />
        </label>
        <label className="space-y-2 text-sm">
          ゲーム
          <NativeSelect
            aria-label="ゲーム"
            value={query.get("game")!}
            onChange={(e) => update({ game: e.target.value })}
          >
            <option value="all">全ゲーム</option>
            {gameIds.map((g) => (
              <option key={g} value={g}>
                {gameCatalog[g].name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-2 text-sm">
          登録導線の日付基準
          <NativeSelect
            aria-label="日付基準"
            value={query.get("dateBasis")!}
            onChange={(e) => update({ dateBasis: e.target.value })}
          >
            <option value="entry">登録入口の日</option>
            <option value="event">各段階の発生日</option>
          </NativeSelect>
        </label>
      </div>
      <div className="flex min-h-10 items-center gap-3">
        <Checkbox
          id="report-internal"
          checked={query.get("includeInternal") === "true"}
          onCheckedChange={(checked) => update({ includeInternal: String(checked) })}
        />
        <Label htmlFor="report-internal">本人・テストを含める</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        日付は日本時間です。訪問の流入と、登録を始めた画面を分けて表示します。
      </p>
    </Card>
  );
}
export function ReportStatus({
  report,
  query,
}: {
  report: {
    collectedFromMs: number | null;
    aggregatedAtMs: number | null;
    metricVersion: number;
    status: string;
  };
  query: URLSearchParams;
}) {
  const start =
      report.collectedFromMs === null
        ? null
        : new Date(report.collectedFromMs + 32400000).toISOString().slice(0, 10),
    today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const unmeasured =
    report.status === "unmeasured" ||
    !start ||
    query.get("to")! < start ||
    query.get("from")! > today;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {unmeasured
        ? "未計測"
        : report.status === "delayed"
          ? "更新遅延"
          : query.get("from")! < start! || query.get("to")! >= today
            ? "途中集計"
            : "集計済み"}{" "}
      ／ 計測開始：
      {report.collectedFromMs === null
        ? "未計測"
        : new Date(report.collectedFromMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{" "}
      ／ 最終集計：
      {report.aggregatedAtMs === null
        ? "未集計"
        : new Date(report.aggregatedAtMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{" "}
      ／ 指標版 {report.metricVersion}。5分ごとに更新します。
    </p>
  );
}

export function isReportMeasured(
  report: { collectedFromMs: number | null; status: string },
  query: URLSearchParams,
) {
  const day =
    report.collectedFromMs === null
      ? null
      : new Date(report.collectedFromMs + 32400000).toISOString().slice(0, 10);
  return (
    report.status !== "unmeasured" &&
    day !== null &&
    query.get("to")! >= day &&
    query.get("from")! <= new Date(Date.now() + 32400000).toISOString().slice(0, 10)
  );
}
