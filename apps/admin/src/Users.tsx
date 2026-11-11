import { useInRouterContext, useSearchParams } from "react-router";
import { gameIds, gameCatalog } from "@tetraboard/protocol/games";
import { adminUserDetailSchema } from "@tetraboard/protocol";
import { defaultPeriod } from "./presentation";
import { NativeSelect } from "./components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Input } from "./components/ui/input";
import { DataTable, type DataColumn } from "./components/DataTable";
import { useEffect, useRef, useState, useMemo } from "react";
import { Avatar, AvatarImage, AvatarFallback } from "./components/ui/avatar";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { adminUsersSchema, type AdminUser, type AdminUsersQuery } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { adminRequest, AdminApiError } from "./api";
const parseUsers = (body: unknown) => adminUsersSchema.parse(body);
const userKinds = [
  { id: "registered", label: "連携済みユーザー" },
  { id: "guest", label: "ゲストユーザー" },
] as const;
export function Users() {
  return useInRouterContext() ? <RoutedUsers /> : <UserScreen />;
}
function RoutedUsers() {
  const [query, setQuery] = useSearchParams();
  return <UserScreen query={query.toString()} onQuery={(q) => setQuery(q)} />;
}
function UserScreen({ query, onQuery }: { query?: string; onQuery?: (q: string) => void }) {
  const [local, setLocal] = useState("");
  const [period] = useState(() => defaultPeriod("day"));
  const params = new URLSearchParams(query ?? local);
  const search = params.get("search") ?? "",
    kind: AdminUsersQuery["kind"] = params.get("kind") === "guest" ? "guest" : "registered";
  const today = new Date(Date.now() + 32400000).toISOString().slice(0, 10);
  const from = params.get("from") ?? period.from,
    to = params.get("to") ?? period.to;
  const game = params.get("game") ?? "all",
    sort = params.get("sort") ?? "created",
    direction = params.get("direction") ?? "desc";
  const update = (values: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(values)) next.set(k, v);
    (onQuery ?? setLocal)(next.toString());
  };
  const [draft, setDraft] = useState(search);
  useEffect(() => {
    setDraft(search);
  }, [search]);
  const setSearch = (value: string) => update({ search: value });
  const setKind = (value: AdminUsersQuery["kind"]) => update({ kind: value });
  const filters = new URLSearchParams({ search, kind, from, to, game, sort, direction }).toString();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-primary">ACCOUNTS</p>
        <h1 className="mt-1 text-3xl font-bold">ユーザー</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Google・Discord連携済みのユーザーとゲストを分けて表示します。プロフィール設定未完了のユーザーも含みます。
        </p>
      </div>
      <Card className="p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft.trim());
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-2">
            名前・IDで検索
            <Input
              aria-label="名前・IDで検索"
              value={draft}
              maxLength={100}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="名前 または @ID"
            />
          </label>
          <Button type="submit">検索</Button>
        </form>
      </Card>
      <Card className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-5">
        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-5">
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
        <label className="space-y-2 text-sm">
          開始日
          <Input
            aria-label="開始日"
            type="date"
            max={today}
            value={from}
            onChange={(e) => update({ from: e.target.value })}
          />
        </label>
        <label className="space-y-2 text-sm">
          終了日
          <Input
            aria-label="終了日"
            type="date"
            max={today}
            value={to}
            onChange={(e) => update({ to: e.target.value })}
          />
        </label>
        <label className="space-y-2 text-sm">
          ゲーム
          <NativeSelect
            aria-label="ゲーム"
            value={game}
            onChange={(e) =>
              update({ game: e.target.value, sort: sort === "rating" ? "created" : sort })
            }
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
          並べ替え
          <NativeSelect
            aria-label="並べ替え"
            value={sort}
            onChange={(e) => update({ sort: e.target.value })}
          >
            {[
              ["created", "作成・登録日時"],
              ["lastLogin", "最終ログイン"],
              ["lastUsed", "最終利用日"],
              ["completed", "通算対局数"],
              ["periodCompleted", "期間内対局数"],
              ["rating", "現在レート"],
            ].map(([k, label]) => (
              <option
                key={k}
                value={k}
                disabled={k === "rating" && (game === "all" || game.includes("gomoku"))}
              >
                {label}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="space-y-2 text-sm">
          表示順
          <NativeSelect
            aria-label="表示順"
            value={direction}
            onChange={(e) => update({ direction: e.target.value })}
          >
            <option value="desc">降順</option>
            <option value="asc">昇順</option>
          </NativeSelect>
        </label>
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-5">
          期間内局数は日本時間の完了日で絞り、直近90日まで算出できます。通算対局数・現在レート・最新日時は期間とは別の現在値です。CPU戦を含み、未決着の打ち切りを含めません。
        </p>
      </Card>
      <Tabs value={kind} onValueChange={(key) => setKind(key as AdminUsersQuery["kind"])}>
        <TabsList aria-label="ユーザー種別">
          {userKinds.map(({ id, label }) => (
            <TabsTrigger key={id} value={id}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {userKinds.map(({ id }) => (
          <TabsContent key={id} value={id} className="pt-4">
            {kind === id && <UserResults key={filters} filters={filters} kind={id} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
function UserResults({ filters, kind }: { filters: string; kind: AdminUsersQuery["kind"] }) {
  const url = `/api/admin/users?${filters}`;
  const [selected, setSelected] = useState<string | null>(null);
  const result = useAdminData(url, parseUsers);
  const [extra, setExtra] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const cursor = nextCursor === undefined ? result.data?.nextCursor : nextCursor;
  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    const request = new AbortController();
    controller.current = request;
    try {
      const data = parseUsers(
        await adminRequest(`${url}&cursor=${encodeURIComponent(cursor)}`, request.signal),
      );
      if (!request.signal.aborted) {
        setExtra((old) => [...old, ...data.users]);
        setNextCursor(data.nextCursor);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        if (error instanceof AdminApiError && [401, 403].includes(error.status))
          window.location.assign("/admin");
        else setMoreError("追加取得できません。表示済みのユーザーを保持しています。");
      }
    } finally {
      if (!request.signal.aborted) setLoadingMore(false);
    }
  }
  const users = useMemo(
    () => (result.data ? [...result.data.users, ...extra] : []),
    [result.data, extra],
  );
  const columns = useMemo<DataColumn<AdminUser>[]>(
    () => [
      {
        id: "name",
        header: "ユーザー",
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <Avatar className="size-9 shrink-0">
              <AvatarImage src={row.original.avatarUrl ?? undefined} alt="" />
              <AvatarFallback>{row.original.name.slice(0, 1) || "?"}</AvatarFallback>
            </Avatar>
            <span className="break-all font-medium">{row.original.name || "未設定"}</span>
          </div>
        ),
      },
      {
        id: "username",
        header: "ID",
        cell: ({ row }) => (row.original.username ? `@${row.original.username}` : "未設定"),
      },
      {
        id: "created",
        header: `${kind === "guest" ? "作成日時" : "登録日時"}（日本時間）`,
        cell: ({ row }) => (
          <span className="whitespace-nowrap">
            {new Date(row.original.createdAtMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
          </span>
        ),
      },
      {
        id: "login",
        header: "最終ログイン（日本時間）",
        cell: ({ row }) => (kind === "guest" ? "対象外" : dateTime(row.original.lastLoginAtMs)),
      },
      {
        id: "usage",
        header: "最終利用日",
        cell: ({ row }) => row.original.lastUsedDay ?? "未計測",
      },
      {
        id: "completed",
        header: "通算対局数",
        cell: ({ row }) => countValue(row.original.completed),
      },
      {
        id: "period",
        header: "期間内対局数",
        cell: ({ row }) => countValue(row.original.periodCompleted),
      },
      {
        id: "rating",
        header: "現在レート",
        cell: ({ row }) => (
          <div className="space-y-1">
            {Object.entries(row.original.ratings ?? {})
              .filter(
                ([g]) =>
                  new URLSearchParams(filters).get("game") === "all" ||
                  new URLSearchParams(filters).get("game") === g,
              )
              .map(([g, r]) => (
                <p key={g}>
                  {gameCatalog[g as keyof typeof gameCatalog].name}：{ratingValue(r)}
                </p>
              ))}
            {!row.original.ratings && "未取得"}
            {new URLSearchParams(filters).get("game")?.includes("gomoku") && "対象外"}
          </div>
        ),
      },
      {
        id: "detail",
        header: "詳細",
        cell: ({ row }) => (
          <Button
            variant="outline"
            disabled={!row.original.id}
            onClick={() => setSelected(row.original.id ?? null)}
          >
            詳細を表示
          </Button>
        ),
      },
      {
        id: "profile",
        header: "プロフィール",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.profileCompleted ? "設定済み" : "未完了"}
          </span>
        ),
      },
    ],
    [kind, filters],
  );
  return (
    <Card className="gap-4 p-5">
      {result.data && (
        <p className="text-xs text-muted-foreground">
          {result.data.status === "delayed" ? "更新遅延 ／ " : ""}最終集計：
          {dateTime(result.data.aggregatedAtMs)}
          {result.data.backfillComplete === false ? " ／ 補完・更新中" : ""}
          {result.data.periodAvailable === false ? " ／ この期間の局数は算出不可" : ""}
          。局数は5分ごとの集計値です。最新日時の計測開始：{dateTime(
            result.data.collectedFromMs,
          )}{" "}
          ／ 指標版 {result.data.metricVersion ?? "未取得"}
        </p>
      )}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent aria-modal="true" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>ユーザー詳細</DialogTitle>
            <DialogDescription>
              最新日時・現在値と、選択した期間の完了対局数を表示します。
            </DialogDescription>
          </DialogHeader>
          {selected && <UserDetail id={selected} filters={filters} />}
        </DialogContent>
      </Dialog>
      {result.loading && <p role="status">ユーザーを読み込んでいます…</p>}
      {result.error && (
        <div className="flex flex-wrap gap-3">
          <p role="alert">{result.error}</p>
          {result.status === 401 ? (
            <a href="/login?destination=admin">ログインへ</a>
          ) : (
            <Button onClick={result.refresh}>再試行</Button>
          )}
        </div>
      )}
      {result.data && !users.length && (
        <p role="status">
          該当する{kind === "guest" ? "ゲストユーザー" : "連携済みユーザー"}
          はいません。
        </p>
      )}
      {!!users.length && (
        <DataTable
          data={users}
          columns={columns}
          caption={kind === "guest" ? "ゲストユーザー一覧" : "連携済みユーザー一覧"}
        />
      )}
      {moreError && <p role="alert">{moreError}</p>}
      {cursor && (
        <Button onClick={() => void more()} disabled={loadingMore}>
          {loadingMore ? "読み込んでいます…" : "もっと見る"}
        </Button>
      )}
    </Card>
  );
}

const countValue = (v: number | null | undefined) =>
  v === undefined ? "未取得" : v === null ? "集計待ち・算出不可" : v.toLocaleString("ja-JP");
const dateTime = (v: number | null | undefined) =>
  v == null ? "未計測" : new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
const ratingValue = (
  r: NonNullable<AdminUser["ratings"]>[keyof NonNullable<AdminUser["ratings"]>],
) =>
  !r
    ? "未取得"
    : r.status === "ineligible"
      ? "対象外"
      : r.status === "placement"
        ? `認定中 ${r.ratedGames}/5局`
        : String(r.rating);
const parseDetail = (body: unknown) => adminUserDetailSchema.parse(body);
function UserDetail({ id, filters }: { id: string; filters: string }) {
  const result = useAdminData(`/api/admin/users/${encodeURIComponent(id)}?${filters}`, parseDetail),
    u = result.data?.user;
  return (
    <div className="space-y-4">
      {result.loading && <p role="status">詳細を取得中…</p>}
      {result.error && (
        <>
          <p role="alert">{result.error}</p>
          <Button onClick={result.refresh}>再試行</Button>
        </>
      )}
      {u && (
        <>
          <h2 className="font-semibold">
            {u.name || "未設定"} {u.username ? `@${u.username}` : ""}
          </h2>
          <p className="break-all text-xs text-muted-foreground">管理用ID：{u.id}</p>
          <dl className="grid grid-cols-2 gap-2">
            <dt>最終ログイン</dt>
            <dd>{u.isGuest ? "対象外" : dateTime(u.lastLoginAtMs)}</dd>
            <dt>最終利用日</dt>
            <dd>{u.lastUsedDay ?? "未計測"}</dd>
          </dl>
          {u.games?.map((g) => (
            <Card key={g.game} className="gap-2 p-4">
              <h3>{gameCatalog[g.game].name}</h3>
              <p>
                通算 {countValue(g.completed)}局 ／ 期間内 {countValue(g.periodCompleted)}局
              </p>
              <p>現在レート：{u.ratings?.[g.game] ? ratingValue(u.ratings[g.game]) : "対象外"}</p>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
