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
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<AdminUsersQuery["kind"]>("registered");
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
            {kind === id && <UserResults key={search} search={search} kind={id} />}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
function UserResults({ search, kind }: { search: string; kind: AdminUsersQuery["kind"] }) {
  const url = `/api/admin/users?${new URLSearchParams({ search, kind })}`;
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
  const users = useMemo(() => [...(result.data?.users ?? []), ...extra], [result.data, extra]);
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
        id: "profile",
        header: "プロフィール",
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {row.original.profileCompleted ? "設定済み" : "未完了"}
          </span>
        ),
      },
    ],
    [kind],
  );
  return (
    <Card className="gap-4 p-5">
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
