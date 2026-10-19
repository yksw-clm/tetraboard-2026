import { gameCatalog, type GameScope } from "@tetraboard/protocol/games";
import { useState } from "react";
import { Button, Card } from "@heroui/react";
import { adminAnalyticsSchema, type AnalyticsMetrics } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { defaultPeriod, duration, metricCards, percent, quantity } from "./presentation";
import { BreakdownChart, TrendChart } from "./Charts";
import { Acquisition } from "./Acquisition";
const parseAnalytics = (body: unknown) => adminAnalyticsSchema.parse(body);
const columns: {
  label: string;
  key: keyof AnalyticsMetrics;
  format?: (value: number | null) => string;
  value?: (metrics: AnalyticsMetrics) => number | null;
}[] = [
  { label: "訪問", key: "visitors" },
  { label: "閲覧", key: "pageViews" },
  { label: "滞在", key: "dwellMs", format: duration },
  { label: "開始", key: "started" },
  { label: "完了", key: "completed" },
  { label: "打ち切り", key: "abandoned" },
  { label: "進行中", key: "playing" },
  { label: "完了率", key: "completionRate", format: percent },
  { label: "開始率", key: "startRate", format: percent },
  { label: "総合ロビー閲覧", key: "generalLobbyViews" },
  { label: "総合ロビー滞在", key: "generalLobbyDwellMs", format: duration },
  { label: "CPU戦開始", key: "cpuMatches" },
  { label: "CPU戦完了", key: "cpuCompleted" },
  { label: "対人戦開始", key: "humanMatches" },
  { label: "対人戦完了", key: "humanCompleted" },
  {
    label: "対人戦割合",
    key: "humanMatches",
    value: (m) => (m.started ? m.humanMatches / m.started : null),
    format: percent,
  },
  { label: "シングルス", key: "singles" },
  { label: "ダブルス", key: "doubles" },
  {
    label: "平均対局時間",
    key: "completedDurationMs",
    format: duration,
    value: (m) => (m.completed ? m.completedDurationMs / m.completed : null),
  },
  { label: "延べ対局参加時間", key: "participationMs", format: duration },
  { label: "登録利用者", key: "registeredActive" },
  { label: "ゲスト", key: "guestActive" },
  {
    label: "登録IDあたり対局",
    key: "registeredParticipations",
    value: (m) =>
      m.registeredActive ? (m.registeredParticipations ?? 0) / m.registeredActive : null,
  },
  {
    label: "ゲストIDあたり対局",
    key: "guestParticipations",
    value: (m) => (m.guestActive ? (m.guestParticipations ?? 0) / m.guestActive : null),
  },
  { label: "新規登録", key: "newUsers" },
  { label: "登録・再対局率", key: "registeredRetentionRate", format: percent },
  { label: "ゲスト・再対局率", key: "guestRetentionRate", format: percent },
];
export function Dashboard({ game }: { game: GameScope }) {
  const [bucket, setBucket] = useState<"day" | "month">("day");
  const [period, setPeriod] = useState(() => defaultPeriod("day"));
  const [includeInternal, setIncludeInternal] = useState(false);
  const params = new URLSearchParams({
    ...period,
    bucket,
    game,
    includeInternal: String(includeInternal),
  });
  const result = useAdminData(`/api/admin/analytics?${params}`, parseAnalytics);
  const title = game === "all" ? "全体概要" : gameCatalog[game].name;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-brand">ANALYTICS</p>
        <h1 className="mt-1 text-3xl font-bold">{title}</h1>
        <p className="mt-2 text-sm text-gray-600">
          利用量と継続性を、日本時間の集計で確認できます。個別計測は90日以内です。古い期間の人数・継続率、終了を確認できなかった対局の進行状態・率・参加時間など、算出できない値は「—」で表示します。
        </p>
      </div>
      <Card className="flex flex-row flex-wrap items-end gap-4 p-5">
        <label className="flex flex-col gap-2">
          集計単位
          <select
            aria-label="集計単位"
            value={bucket}
            onChange={(event) => {
              const next = event.target.value as "day" | "month";
              setBucket(next);
              setPeriod(defaultPeriod(next));
            }}
          >
            <option value="day">日別</option>
            <option value="month">月別</option>
          </select>
        </label>
        <label className="flex flex-col gap-2">
          開始日
          <input
            aria-label="開始日"
            type="date"
            value={period.from}
            onChange={(event) => setPeriod((old) => ({ ...old, from: event.target.value }))}
          />
        </label>
        <label className="flex flex-col gap-2">
          終了日
          <input
            aria-label="終了日"
            type="date"
            value={period.to}
            onChange={(event) => setPeriod((old) => ({ ...old, to: event.target.value }))}
          />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            checked={includeInternal}
            onChange={(event) => setIncludeInternal(event.target.checked)}
          />
          本人・テストを含める
        </label>
        <Button onPress={result.refresh} isDisabled={result.loading} className="ml-auto">
          更新
        </Button>
      </Card>
      {result.error && (
        <Card className="gap-3 p-5">
          <p role="alert">
            {result.error}
            {result.data ? " 表示済みのデータを保持しています。" : ""}
          </p>
          {result.status === 401 ? (
            <a href="/login?destination=admin">ログインへ</a>
          ) : (
            <Button onPress={result.refresh}>再試行</Button>
          )}
        </Card>
      )}
      {result.loading && (
        <p role="status">{result.data ? "更新しています…" : "計測データを読み込んでいます…"}</p>
      )}
      {result.data && (
        <>
          <p className="text-sm text-gray-600">
            計測開始：
            {result.data.collectedFromMs === null
              ? "まだ計測データがありません"
              : new Date(result.data.collectedFromMs).toLocaleString("ja-JP", {
                  timeZone: "Asia/Tokyo",
                })}{" "}
            ／ 取得：
            {new Date(result.data.asOfMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </p>
          {!result.data.summary.pageViews && !result.data.summary.started && (
            <p role="status">この期間の訪問・対局データはありません。</p>
          )}
          <section
            aria-label="主要指標"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {metricCards(result.data.summary, result.data.totalUsers).map(([label, value]) => (
              <Card key={label} className="gap-3 p-5">
                <h2 className="text-sm text-gray-600">{label}</h2>
                <p className="text-3xl font-semibold tabular-nums">{value}</p>
              </Card>
            ))}
          </section>
          <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
            <Card className="gap-4 p-5">
              <h2 className="text-lg font-bold">訪問・対局の推移</h2>
              <TrendChart buckets={result.data.buckets} />
            </Card>
            <Card className="gap-4 p-5">
              <h2 className="text-lg font-bold">対局の内訳</h2>
              <BreakdownChart metrics={result.data.summary} />
            </Card>
          </div>
          <Card className="gap-4 p-5">
            <h2 className="text-lg font-bold">集計表</h2>
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-right text-sm">
                <caption className="sr-only">
                  {title}の{bucket === "day" ? "日別" : "月別"}計測データ
                </caption>
                <thead>
                  <tr>
                    <th className="p-3 text-left">期間</th>
                    {columns.map((col) => (
                      <th key={col.key} className="p-3">
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.data.buckets.map(({ period: label, metrics }) => (
                    <tr key={label} className="border-t border-gray-200">
                      <th className="p-3 text-left font-normal">{label}</th>
                      {columns.map((col) => {
                        const value = col.value ? col.value(metrics) : metrics[col.key];
                        return (
                          <td key={col.key} className="p-3 tabular-nums">
                            {col.format
                              ? col.format(value)
                              : value === null
                                ? "—"
                                : quantity(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Acquisition report={result.data.acquisition} asOf={result.data.asOfMs} />
          <Card className="gap-3 p-5 text-sm text-gray-600">
            <h2 className="font-bold text-gray-900">指標の読み方</h2>
            <p>
              CPU戦も含みます。登録利用者はアカウント単位、ゲストはブラウザ単位です。ログイン前後を同一人物として統合せず、端末変更・Cookie削除・保存拒否・通信失敗で計測に差が生じます。
            </p>
            <p>
              開始率は同じゲーム・同じ日にロビーまたはルームを訪問したブラウザのうち、対局を開始した割合です。完了率・対局時間は選択期間に開始した対局を対象にします。進行中の値は取得時点の状態です。
            </p>
            <p>
              再対局率は計測開始後のゲーム別初回完了から7日以内の再対局です。7日間の観測が済んだ対象だけを集計します。登録：
              {result.data.summary.registeredRetained}／
              {result.data.summary.registeredRetentionEligible}、ゲスト：
              {result.data.summary.guestRetained}／{result.data.summary.guestRetentionEligible}
              （全体概要ではゲーム別コホートの合計）。
            </p>
            <p>
              滞在時間は前面で表示されている時間です。延べ対局参加時間は対局経過時間×集計対象の人間の席数で、操作時間や広告表示回数とは異なります。新規登録・登録総数はサービス全体の値です。過去の対局は取り込んでいません。
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
