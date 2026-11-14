import { useState, type ReactNode } from "react";
import {
  kpiQuerySchema,
  kpiReportSchema,
  type KpiQuery,
  type KpiRatio,
} from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { percent, quantity } from "./presentation";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./components/ui/table";

const parseKpi = (body: unknown) => kpiReportSchema.parse(body);
const presets = [
  [7, "直近 7 日"],
  [30, "直近 30 日"],
  ["month", "今月"],
  ["lastMonth", "先月"],
] as const;
function presetPeriod(preset: (typeof presets)[number][0]): KpiQuery {
  const today = new Date(Date.now() + 32400000);
  const date = (value: Date) => value.toISOString().slice(0, 10);
  if (typeof preset === "number")
    return {
      from: date(new Date(today.getTime() - (preset - 1) * 86400000)),
      to: date(today),
    };
  const year = today.getUTCFullYear(),
    month = today.getUTCMonth();
  return {
    from: date(new Date(Date.UTC(year, month - (preset === "lastMonth" ? 1 : 0), 1))),
    to: preset === "lastMonth" ? date(new Date(Date.UTC(year, month, 0))) : date(today),
  };
}
const referrerNames: Record<string, string> = {
  search: "検索",
  social: "SNS・動画・配信",
  internal: "サイト内",
  direct: "直接・参照元なし",
  other: "その他",
};
const deviceNames: Record<string, string> = {
  smartphone: "スマートフォン",
  tablet: "タブレット",
  pc: "PC",
};
const entryNames: Record<string, string> = {
  "account-menu": "アカウントメニュー",
  "mobile-navigation": "モバイルナビ",
  "login-page": "ログイン画面",
  "guest-account": "ゲストのアカウント",
  "room-result": "対局結果",
  "rated-match": "レート戦の登録案内",
  "profile-edit": "プロフィール編集",
  "account-link": "アカウント連携",
  unknown: "不明",
};
const registrationStages: Record<string, string> = {
  entry: "入口",
  oauth_start: "OAuth開始",
  oauth_success: "OAuth成功",
  registered: "新規登録",
  existing_login: "既存ログイン",
  profile_required: "プロフィール対象",
  profile_complete: "プロフィール完了",
};
const matchmakingStages: Record<string, string> = {
  accepted: "受付",
  matched: "成立",
  started: "開始",
  cancelled: "取消",
  failed: "失敗",
  retry: "再試行",
};
function Ratio({ value }: { value: KpiRatio }) {
  return (
    <>
      {percent(value.denominator === 0 ? null : value.rate)}
      <small className="text-xs font-normal text-muted-foreground">
        （{quantity(value.numerator)} / {quantity(value.denominator)}）
      </small>
    </>
  );
}
function KpiTable({
  title,
  headers,
  rows,
  unavailableReason,
}: {
  title: string;
  headers: string[];
  rows: ReactNode[][] | undefined;
  unavailableReason: string;
}) {
  return (
    <Card className="gap-4 p-5">
      <h2 className="font-semibold">{title}</h2>
      {rows ? (
        <>
          <Table>
            <TableCaption className="sr-only">{title}</TableCaption>
            <TableHeader>
              <TableRow>
                {headers.map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((cells, i) => (
                <TableRow key={i}>
                  {cells.map((cell, j) => (
                    <TableCell key={j}>{cell}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!rows.length && <p className="text-sm text-muted-foreground">該当する記録は0件です。</p>}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{unavailableReason}</p>
      )}
    </Card>
  );
}
function KpiResults({ period }: { period: KpiQuery }) {
  const report = useAdminData(`/api/admin/kpi?${new URLSearchParams(period)}`, parseKpi);
  const data = report.data,
    events = data?.events;
  const unavailableReason = data?.eventsUnavailableReason ?? "イベント由来の値を取得できません。";
  const unavailable = (
    <span className="text-sm font-normal text-muted-foreground">{unavailableReason}</span>
  );
  const seconds = (value: number | null) => (value === null ? "—" : quantity(value / 1000));
  return (
    <>
      {report.loading && <p role="status">KPIを取得中…</p>}
      {report.error && (
        <Card className="gap-3 p-5">
          <p role="alert">{report.error}</p>
          <Button onClick={report.refresh}>再試行</Button>
        </Card>
      )}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[
              ["訪問ブラウザ数", events ? quantity(events.visitingBrowsers) : unavailable],
              ["対局開始率", events ? <Ratio value={events.matchStartRate} /> : unavailable],
              ["対局完了率", events ? <Ratio value={events.matchCompletionRate} /> : unavailable],
              ["完了対局数", quantity(data.completedMatches)],
              ["対局者数", quantity(data.players)],
              ["対人戦の割合", events ? <Ratio value={events.humanMatchRate} /> : unavailable],
              ["7 日以内の再対局率", <Ratio value={data.replayWithin7Days} />],
              ["新規登録数", events ? quantity(data.newRegistrations) : unavailable],
            ].map(([title, value]) => (
              <Card key={String(title)} className="gap-2 p-5">
                <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
                <p className="text-2xl font-semibold">{value}</p>
                {title === "7 日以内の再対局率" && (
                  <p className="text-xs text-muted-foreground">
                    観測中 {quantity(data.replayWithin7Days.observing)} 人
                  </p>
                )}
              </Card>
            ))}
          </div>
          <KpiTable
            title="流入元ごと"
            headers={[
              "参照元の分類",
              "utm_source",
              "utm_medium",
              "utm_campaign",
              "端末",
              "訪問ブラウザ数",
              "対局に参加したブラウザ数",
            ]}
            rows={events?.acquisition.map((row) => [
              referrerNames[row.referrerClass] ?? (row.referrerClass || "不明"),
              row.utmSource || "—",
              row.utmMedium || "—",
              row.utmCampaign || "—",
              deviceNames[row.device] ?? (row.device || "不明"),
              quantity(row.visitingBrowsers),
              quantity(row.participatingBrowsers),
            ])}
            unavailableReason={unavailableReason}
          />
          <KpiTable
            title="登録の段階ごと"
            headers={["入口", "段階", "手続き数"]}
            rows={events?.registration.map((row) => [
              entryNames[row.entry] ?? (row.entry || "不明"),
              registrationStages[row.stage] ?? (row.stage || "不明"),
              quantity(row.flows),
            ])}
            unavailableReason={unavailableReason}
          />
          <KpiTable
            title="マッチングの段階ごと"
            headers={["段階", "件数", "待ち時間の中央値（秒）", "待ち時間の90パーセンタイル（秒）"]}
            rows={events?.matchmaking.map((row) => [
              matchmakingStages[row.stage] ?? (row.stage || "不明"),
              quantity(row.count),
              seconds(row.waitingMs.median),
              seconds(row.waitingMs.p90),
            ])}
            unavailableReason={unavailableReason}
          />
          {data.sampling !== false && (
            <p className="text-xs text-muted-foreground">
              {data.sampling === true
                ? "一部のイベントが間引かれています"
                : "間引きの有無は確認できません"}
            </p>
          )}
        </>
      )}
    </>
  );
}
export function Kpi() {
  const [period, setPeriod] = useState(() => presetPeriod(30));
  let error: string | null = null;
  if (!period.from || !period.to) error = "開始日と終了日を選択してください。";
  else if (!kpiQuerySchema.safeParse(period).success)
    error =
      period.from > period.to
        ? "開始日は終了日以前の日付を選択してください。"
        : "期間は開始日と終了日を含めて92日以内にしてください。";
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">KPI</h1>
      <p className="text-sm text-muted-foreground">
        訪問数・ページビュー・表示速度は Cloudflare のダッシュボードの Web Analytics で確認します。{" "}
        <a
          className="underline"
          href="https://dash.cloudflare.com/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Cloudflare のダッシュボードを開く
        </a>
      </p>
      <Card className="gap-4 p-5">
        <div className="flex flex-wrap gap-2">
          {presets.map(([preset, label]) => (
            <Button key={preset} variant="outline" onClick={() => setPeriod(presetPeriod(preset))}>
              {label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {(
            [
              ["from", "開始日"],
              ["to", "終了日"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="space-y-2 text-sm">
              {label}
              <Input
                aria-label={label}
                type="date"
                value={period[key]}
                onChange={(event) => setPeriod({ ...period, [key]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">日付は日本時間です。期間は最大92日です。</p>
        {error && <p role="alert">{error}</p>}
      </Card>
      {!error && <KpiResults period={period} />}
    </div>
  );
}
