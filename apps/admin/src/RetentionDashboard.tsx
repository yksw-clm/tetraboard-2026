import { retentionAnalyticsSchema, type RetentionAnalytics } from "@tetraboard/protocol";
import { gameCatalog } from "@tetraboard/protocol/games";
import { useAdminData } from "./useAdminData";
import { AnalyticsFilters, useAnalyticsFilters, ReportStatus } from "./AnalyticsFilters";
import { percent } from "./presentation";
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
const parse = (body: unknown) => retentionAnalyticsSchema.parse(body);
const kind = { registered: "登録者", guest: "ゲスト", unknown: "不明（起点情報不足）" };
type Row = RetentionAnalytics["returns"][number];
const gameName = (r: Row) =>
  r.game === "all" ? "全体（別ゲームを含む）" : gameCatalog[r.game].name;
function ratio(r: Row, next = false) {
  return r.eligible === 0
    ? r.unknown > 0
      ? "不明"
      : r.observing > 0
        ? "観測中"
        : "対象者なし"
    : `${percent(next ? r.nextDayRate : r.rate)} (${next ? r.retainedNextDay : r.retained}/${r.eligible}人)`;
}
function ReturnTable({
  rows,
  title,
  post = false,
}: {
  rows: Row[];
  title: string;
  post?: boolean;
}) {
  return (
    <Card className="gap-4 p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">
        {post
          ? "起点は認定5局目の完了日です。同じゲームの別の対局を168時間以内に開始したかを数えます。認定1局目の期間とは独立しています。"
          : "起点は保存データで確認できる初回完了日です。全体はサービス内の別ゲームも含む再対局、ゲーム別は同じゲームへの再対局です。ゲーム別人数を足して全体にしません。"}{" "}
        7日間観測済みだけが分母です。再対局済みでも観測中の人は割合へ含めません。
      </p>
      <Table>
        <TableCaption className="sr-only">{title}の分子・分母・観測中と不明の人数</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>ゲーム</TableHead>
            <TableHead>起点時点の区分</TableHead>
            <TableHead>対象人数</TableHead>
            <TableHead>{post ? "7日以内再利用" : "同日を含む7日以内"}</TableHead>
            {!post && <TableHead>別日の7日以内</TableHead>}
            <TableHead>観測中</TableHead>
            <TableHead>不明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.game}:${r.kind}`}>
              <TableCell>{gameName(r)}</TableCell>
              <TableCell>{kind[r.kind]}</TableCell>
              <TableCell>{r.enrolled}人</TableCell>
              <TableCell>{ratio(r)}</TableCell>
              {!post && <TableCell>{ratio(r, true)}</TableCell>}
              <TableCell>{r.observing}人</TableCell>
              <TableCell>{r.unknown}人</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 && <p className="text-sm">対象者なし（計測済み）</p>}
    </Card>
  );
}
export function RetentionDashboard() {
  const filters = useAnalyticsFilters(),
    result = useAdminData(`/api/admin/analytics/retention?${filters.query}`, parse),
    data = result.data;
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">再対局・認定</h1>
        <Button disabled={result.loading} onClick={result.refresh}>
          更新
        </Button>
      </div>
      <AnalyticsFilters {...filters} showDateBasis={false} />
      <p className="text-sm text-muted-foreground">
        登録者・ゲストともアカウント単位です。区分は起点に保存された情報で固定し、後日の登録や別アカウントへの統合で過去を書き換えません。別日版は日本時間の翌日以降、168時間ちょうどまでです。
      </p>
      {result.loading && <p role="status">再対局・認定を取得中…</p>}
      {result.error && (
        <Card className="gap-3 p-5">
          <p role="alert">{result.error}</p>
          <Button onClick={result.refresh}>再試行</Button>
        </Card>
      )}
      {data && (
        <>
          <ReportStatus
            report={{
              ...data,
              status: data.coverage === "unmeasured" ? "unmeasured" : data.status,
            }}
            query={filters.query}
          />
          <p className="text-xs text-muted-foreground">
            指標版2です。旧概要のゲーム別コホートを合計した継続率とは、同じ指標として比較しません。
          </p>
          {data.coverage === "unmeasured" ? (
            <Card className="p-5">
              <p>この期間は未計測です。0件や0%へ補完していません。</p>
            </Card>
          ) : (
            <>
              <ReturnTable title="7日以内再対局率" rows={data.returns} />
              <Card className="gap-4 p-5">
                <h2 className="text-lg font-semibold">認定1〜5局目の到達</h2>
                <p className="text-sm text-muted-foreground">
                  起点は初回のレート有効局の完了日です。そこから90日以内に完了を確認できた各有効局の到達人数を表示します。通常の完了局数を代用しません。まだ90日たっていない人は観測中で、確定した離脱率にはしません。
                </p>
                <Table>
                  <TableCaption className="sr-only">
                    認定の90日以内到達人数と観測中人数
                  </TableCaption>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ゲーム</TableHead>
                      <TableHead>区分</TableHead>
                      <TableHead>対象人数</TableHead>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <TableHead key={n}>{n}局目</TableHead>
                      ))}
                      <TableHead>90日観測中</TableHead>
                      <TableHead>不明</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.placement.map((r) => (
                      <TableRow key={`${r.game}:${r.kind}`}>
                        <TableCell>{gameName(r)}</TableCell>
                        <TableCell>{kind[r.kind]}</TableCell>
                        <TableCell>{r.enrolled}人</TableCell>
                        {r.reached.map((n, i) => (
                          <TableCell key={i}>{n}人</TableCell>
                        ))}
                        <TableCell>{r.observing}人</TableCell>
                        <TableCell>{r.unknown}人</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {!data.placement.length && <p>対象者なし（計測済み）</p>}
              </Card>
              <ReturnTable title="認定後の7日以内再利用" rows={data.postPlacement} post />
              <p className="text-xs text-muted-foreground">
                個別の分析対応は90日上限で、その後はIDのない集計だけを保持します。90日到達時の確定は毎時保守で匿名化してから次の集計へ反映し、それまでは前回値・更新遅延を表示します。
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
