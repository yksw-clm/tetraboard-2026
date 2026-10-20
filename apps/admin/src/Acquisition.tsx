import { Card } from "@heroui/react";
import type { AcquisitionReport, AcquisitionRow } from "@tetraboard/protocol";
import { quantity } from "./presentation";

const referrerNames: Record<string, string> = {
  search: "検索",
  social: "SNS・動画・配信",
  internal: "サイト内",
  direct: "直接・参照元なし",
  other: "その他",
};
const deviceNames: Record<string, string> = {
  mobile: "モバイル",
  tablet: "タブレット",
  desktop: "デスクトップ",
};
export function acquisitionCoverage(period: string, collected: number | null, asOf: number) {
  const start = Date.parse(`${period.length === 7 ? period + "-01" : period}T00:00:00+09:00`);
  const end =
    period.length === 7
      ? new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 1)).getTime() -
        32400000
      : start + 86400000;
  if (collected === null || end <= collected || start > asOf) return "未計測";
  return start < collected || end > asOf ? "途中集計" : "";
}
function label(row: AcquisitionRow) {
  if (row.dimension === "referrer") return referrerNames[row.value] ?? "不明";
  if (row.dimension === "device") return deviceNames[row.value] ?? "不明";
  return row.value || "未指定・不明";
}
function Rows({
  rows,
  period,
  status,
  utm,
}: {
  rows: AcquisitionRow[];
  period: string;
  status: string;
  utm: boolean;
}) {
  const span = utm ? 5 : 3;
  if (status === "未計測")
    return (
      <tr>
        <th>{period}</th>
        <td colSpan={span}>未計測</td>
      </tr>
    );
  if (!rows.length)
    return (
      <tr>
        <th>
          {period}
          {status && `（${status}）`}
        </th>
        <td colSpan={span}>訪問・開始対局 0件</td>
      </tr>
    );
  return (
    <>
      {rows.map((row, i) => (
        <tr key={JSON.stringify([row.value, row.medium, row.campaign])}>
          {i === 0 && (
            <th rowSpan={rows.length}>
              {period}
              {status && <span className="block text-xs">{status}</span>}
            </th>
          )}
          <td className="break-all">{label(row)}</td>
          {utm && (
            <>
              <td className="break-all">{row.medium || "未指定・不明"}</td>
              <td className="break-all">{row.campaign || "未指定・不明"}</td>
            </>
          )}
          <td>{quantity(row.visits)}</td>
          <td>{quantity(row.started)}</td>
        </tr>
      ))}
    </>
  );
}
export function Acquisition({
  report,
  asOf,
}: {
  report: AcquisitionReport | undefined;
  asOf: number;
}) {
  if (!report)
    return (
      <Card className="p-5">
        <h2>流入・端末</h2>
        <p>未計測（対応する計測情報がありません）</p>
      </Card>
    );
  const statuses = report.buckets.map((bucket) =>
    acquisitionCoverage(bucket.period, report.collectedFromMs, asOf),
  );
  const summaryStatus =
    report.collectedFromMs === null || statuses.every((status) => status === "未計測")
      ? "未計測"
      : statuses.some(Boolean)
        ? "途中集計"
        : "";
  return (
    <Card className="gap-5 p-5">
      <h2 className="text-xl font-semibold">流入・端末</h2>
      <p className="text-sm text-gray-600">
        訪問セッション数は30分間、閲覧・前面滞在の更新が途絶えた後の閲覧で区切ります。既存の訪問ブラウザ数とは異なります。流入情報は最初の閲覧で固定します。ゲーム別の訪問は、その訪問で最初に対象ゲームを閲覧した日に数えます。
      </p>
      <p className="text-sm text-gray-600">
        開始対局は開始日の参加者に対応する各区分で対局IDを重複排除します。異なる流入元・端末の人が同じ対局に参加した場合は各区分に数えるため、行の合計は全体の開始対局数と一致しません。UTMは参照元分類を変更しません。未指定・不明には欠測を含み、端末分類は推定です。
      </p>
      <p className="text-sm">
        計測開始：
        {report.collectedFromMs === null
          ? "未計測"
          : new Date(report.collectedFromMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
      </p>
      {(
        [
          ["referrer", "参照元分類"],
          ["utm", "UTM"],
          ["device", "端末"],
        ] as const
      ).map(([dimension, title]) => (
        <section key={dimension} className="flex flex-col gap-2">
          <h3 className="font-semibold">{title}別の訪問・開始対局</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm [&_th]:p-3 [&_th]:text-left [&_td]:p-3 [&_td]:align-top [&_tbody_tr]:border-t [&_tbody_tr]:border-gray-200">
              <thead>
                <tr>
                  <th>期間（日本時間）</th>
                  <th>{dimension === "utm" ? "source" : title}</th>
                  {dimension === "utm" && (
                    <>
                      <th>medium</th>
                      <th>campaign</th>
                    </>
                  )}
                  <th>訪問セッション数</th>
                  <th>開始対局</th>
                </tr>
              </thead>
              <tbody>
                <Rows
                  rows={report.summary.filter((row) => row.dimension === dimension)}
                  period="選択期間の合計"
                  status={summaryStatus}
                  utm={dimension === "utm"}
                />
                {report.buckets.map((bucket) => (
                  <Rows
                    key={bucket.period}
                    rows={bucket.rows.filter((row) => row.dimension === dimension)}
                    period={bucket.period}
                    status={acquisitionCoverage(bucket.period, report.collectedFromMs, asOf)}
                    utm={dimension === "utm"}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </Card>
  );
}
