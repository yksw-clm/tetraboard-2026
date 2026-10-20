import { useEffect, useRef, useState } from "react";
import { Avatar, Button, Card } from "@heroui/react";
import { adminUsersSchema, type AdminUser } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { adminRequest, AdminApiError } from "./api";
const parseUsers = (body: unknown) => adminUsersSchema.parse(body);
export function Users() {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-brand">ACCOUNTS</p>
        <h1 className="mt-1 text-3xl font-bold">登録ユーザー</h1>
        <p className="mt-2 text-sm text-gray-600">
          現在のプロフィールを表示します。設定未完了の登録者も含みます。
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
            <input
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
      <UserResults key={search} search={search} />
    </div>
  );
}
function UserResults({ search }: { search: string }) {
  const url = `/api/admin/users?${new URLSearchParams({ search })}`;
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
  const users = [...(result.data?.users ?? []), ...extra];
  return (
    <Card className="gap-4 p-5">
      {result.loading && <p role="status">ユーザーを読み込んでいます…</p>}
      {result.error && (
        <div className="flex flex-wrap gap-3">
          <p role="alert">{result.error}</p>
          {result.status === 401 ? (
            <a href="/login?destination=admin">ログインへ</a>
          ) : (
            <Button onPress={result.refresh}>再試行</Button>
          )}
        </div>
      )}
      {result.data && !users.length && <p role="status">該当する登録ユーザーはいません。</p>}
      {!!users.length && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                <th className="p-3">ユーザー</th>
                <th className="p-3">ID</th>
                <th className="p-3">登録日時（日本時間）</th>
                <th className="p-3">プロフィール</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user, index) => (
                <tr
                  key={`${user.username}:${user.createdAtMs}:${index}`}
                  className="border-t border-gray-200"
                >
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <Avatar className="size-10 shrink-0">
                        <Avatar.Image src={user.avatarUrl ?? undefined} alt="" />
                        <Avatar.Fallback>{user.name.slice(0, 1) || "?"}</Avatar.Fallback>
                      </Avatar>
                      <span className="break-all">{user.name || "未設定"}</span>
                    </div>
                  </td>
                  <td className="p-3">
                    {user.isGuest ? "ゲスト" : user.username ? `@${user.username}` : "未設定"}
                  </td>
                  <td className="whitespace-nowrap p-3">
                    {new Date(user.createdAtMs).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                  </td>
                  <td className="whitespace-nowrap p-3">
                    {user.profileCompleted ? "設定済み" : "未完了"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {moreError && <p role="alert">{moreError}</p>}
      {cursor && (
        <Button onPress={() => void more()} isDisabled={loadingMore}>
          {loadingMore ? "読み込んでいます…" : "もっと見る"}
        </Button>
      )}
    </Card>
  );
}
