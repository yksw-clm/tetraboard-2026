import { gameCatalog } from "@tetraboard/protocol/games";
import {
  acquisitionSnapshotSchema,
  registrationAnalyticsReportSchema,
  type RegistrationAnalyticsReport,
} from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import {
  AnalyticsFilters,
  useAnalyticsFilters,
  ReportStatus,
  isReportMeasured,
} from "./AnalyticsFilters";
import { Card } from "./components/ui/card";
import { Button } from "./components/ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from "./components/ui/table";
const parseAcquisition = (b: unknown) => acquisitionSnapshotSchema.parse(b),
  parseRegistration = (b: unknown) => registrationAnalyticsReportSchema.parse(b);
const entries: Record<string, string> = {
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
const stages = [
  ["entry", "入口"],
  ["oauth_start", "OAuth開始"],
  ["oauth_success", "OAuth成功"],
  ["registered", "新規登録"],
  ["existing_login", "既存ログイン"],
  ["profile_required", "プロフィール対象"],
  ["profile_complete", "プロフィール完了"],
] as const;
function funnelRows(rows: RegistrationAnalyticsReport["rows"]) {
  const groups = new Map<string, { label: string; counts: Record<string, number> }>();
  for (const r of rows) {
    const label = `${entries[r.entry]} ／ ${{ registered: "登録者", guest: "ゲスト", unregistered: "未認証" }[r.kind]} ／ ${r.linkId ? `計測リンク #${r.linkId}` : r.source || "流入不明"} ／ ${r.medium || "媒体不明"} ／ ${r.campaign || "施策不明"} ／ ${r.game === "all" ? "全ゲーム" : gameCatalog[r.game].name}`;
    const key = JSON.stringify([r.entry, r.kind, r.linkId, r.source, r.medium, r.campaign, r.game]);
    const group = groups.get(key) ?? { label, counts: {} };
    group.counts[r.stage] = (group.counts[r.stage] ?? 0) + r.count;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function AcquisitionDashboard() {
  const filters = useAnalyticsFilters(),
    q = filters.query.toString();
  const acquisition = useAdminData(`/api/admin/analytics/acquisition?${q}`, parseAcquisition),
    registration = useAdminData(`/api/admin/analytics/registration?${q}`, parseRegistration);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">集客・登録</h1>
      <AnalyticsFilters {...filters} />
      {[acquisition, registration].map((r, i) => (
        <div key={i}>
          {r.loading && <p role="status">{i ? "登録導線" : "集客"}を取得中…</p>}
          {r.error && (
            <Card className="gap-3 p-5">
              <p role="alert">{r.error}</p>
              <Button onClick={r.refresh}>再試行</Button>
            </Card>
          )}
        </div>
      ))}
      {acquisition.data && (
        <section aria-label="集客の集計" className="space-y-4">
          <ReportStatus report={acquisition.data} query={filters.query} />
          <p className="text-sm text-muted-foreground">
            訪問セッションを数えます。リンク経由の到着はX上のクリック数ではありません。同じ対局に異なる流入の参加者がいると区分ごとに数えるため、開始対局数の行合計は全体と一致しません。
          </p>
          {[
            ["link", "短縮UTM"],
            ["referrer", "参照元の分類"],
            ["host", "実際の参照元ホスト"],
            ["device", "端末"],
            ["utm", "従来UTMと流入属性"],
          ].map(([dimension, title]) => (
            <Card key={dimension} className="gap-4 p-5">
              <h2 className="font-semibold">{title}</h2>
              {dimension === "host" && !acquisition.data!.hostAvailable ? (
                <p>
                  この期間のホスト別集計は算出不可です。ホスト名を含む集計は90日以内に限定します。
                </p>
              ) : (
                <Table>
                  <TableCaption className="sr-only">{title}別の訪問・開始対局</TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>区分</TableHead>
                      <TableHead>媒体</TableHead>
                      <TableHead>施策</TableHead>
                      <TableHead>訪問セッション数</TableHead>
                      <TableHead>開始対局数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {acquisition
                      .data!.rows.filter((r) => r.dimension === dimension)
                      .map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>
                            {r.dimension === "link"
                              ? r.label
                                ? `${r.label} (#${r.value})`
                                : "不明"
                              : r.value || "不明"}
                          </TableCell>
                          <TableCell>{r.medium || "—"}</TableCell>
                          <TableCell>{r.campaign || "—"}</TableCell>
                          <TableCell>{r.visits.toLocaleString("ja-JP")}</TableCell>
                          <TableCell>
                            {r.started === null ? "対象外" : r.started.toLocaleString("ja-JP")}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
              {!acquisition.data!.rows.some((r) => r.dimension === dimension) && (
                <p className="text-sm text-muted-foreground">
                  {!isReportMeasured(acquisition.data!, filters.query)
                    ? "未計測"
                    : "該当する訪問・対局は0件です。"}
                </p>
              )}
            </Card>
          ))}
        </section>
      )}
      {registration.data && (
        <Card className="gap-4 p-5">
          <h2 className="font-semibold">登録導線</h2>
          <ReportStatus report={registration.data} query={filters.query} />
          <p className="text-sm text-muted-foreground">
            {registration.data.dateBasis === "entry" ? "登録を始めた日" : "各段階が発生した日"}
            で絞り込みます。同じ手続きの段階は1回です。既存ログインと新規登録は別で、プロフィール工程が不要な人を離脱に数えません。発生日基準の行同士から到達率を計算しません。
          </p>
          <Table>
            <TableCaption className="sr-only">入口・本人区分・訪問の流入別の登録段階</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>登録を始めた場所・本人区分・流入・ゲーム</TableHead>
                {stages.map(([k, label]) => (
                  <TableHead key={k}>{label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {funnelRows(registration.data.rows).map((r) => (
                <TableRow key={r.label}>
                  <TableCell className="max-w-80 whitespace-normal">{r.label}</TableCell>
                  {stages.map(([k]) => (
                    <TableCell key={k}>
                      {k === "profile_complete" && !r.counts.profile_required
                        ? "対象外"
                        : (r.counts[k] ?? 0)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!registration.data.rows.length && (
            <p>
              {!isReportMeasured(registration.data, filters.query)
                ? "未計測"
                : "該当する登録手続きは0件です。"}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
