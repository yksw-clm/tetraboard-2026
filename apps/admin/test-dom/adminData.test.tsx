import { expect, test } from "bun:test";
import { useAdminData } from "../src/useAdminData";
import { adminMutation, AdminApiError } from "../src/api";
import { act, flush, renderHook, requests } from "../../web/test-dom/support";

const parse = (body: unknown) => {
  if (!body || typeof body !== "object" || !("value" in body)) throw new Error("invalid");
  return String(body.value);
};
test("Admin取得は失敗時に値を保持し、401/403では必ず管理データを破棄", async () => {
  for (const status of [401, 403]) {
    requests.length = 0;
    const h = renderHook((url: string) => useAdminData(url, parse), "/api/admin/analytics");
    requests[0]!.respond({ value: "機密データ" });
    await flush();
    expect(h.current.data).toBe("機密データ");
    act(() => h.current.refresh());
    requests[1]!.respond({ message: "取得失敗" }, 503);
    await flush();
    expect(h.current.data).toBe("機密データ");
    act(() => h.current.refresh());
    requests[2]!.respond({ message: "権限なし" }, status);
    await flush();
    expect(h.current.data).toBeNull();
    expect(h.current.status).toBe(status);
    h.unmount();
  }
});
test("検索・条件変更は旧データを消去し、遅い応答をabort/unmountで破棄", async () => {
  const h = renderHook((url: string) => useAdminData(url, parse), "/api/admin/users?search=old");
  requests[0]!.respond({ value: "old" });
  await flush();
  act(() => h.current.refresh());
  h.rerender("/api/admin/users?search=new");
  expect(h.current.data).toBeNull();
  expect(requests[1]!.init.signal?.aborted).toBe(true);
  requests[2]!.respond({ value: "new" });
  requests[1]!.respond({ value: "old delayed" });
  await flush();
  expect(h.current.data).toBe("new");
  act(() => h.current.refresh());
  h.unmount();
  expect(requests[3]!.init.signal?.aborted).toBe(true);
  requests[3]!.respond({ value: "after unmount" });
  await flush();
});
test("別の管理APIでの権限喪失を通知されたら、取得中の応答を含めてデータを破棄する", async () => {
  const h = renderHook(() => useAdminData("/api/admin/tournaments/id", parse), undefined);
  requests[0]!.respond({ value: "管理者だけのデータ" });
  await flush();
  act(() => h.current.refresh());
  act(() => h.current.discard());
  expect(h.current.data).toBeNull();
  expect(requests[1]!.init.signal?.aborted).toBe(true);
  requests[1]!.respond({ value: "権限喪失後の遅い応答" });
  await flush();
  expect(h.current.data).toBeNull();
});
test("Adminの分類・削除はversionを送り、競合と権限エラーをstatus付きで返す", async () => {
  const pending = adminMutation("/api/admin/feedback/id", "PATCH", {
    version: 2,
    status: "done",
    published: false,
  });
  expect(requests[0]!.init.credentials).toBe("same-origin");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    version: 2,
    status: "done",
    published: false,
  });
  requests[0]!.respond({ message: "競合" }, 409);
  await expect(pending).rejects.toEqual(new AdminApiError(409, "競合"));
  const remove = adminMutation("/api/admin/feedback/id", "DELETE", { version: 3 });
  requests[1]!.respond(null, 204);
  await expect(remove).resolves.toBeNull();
  expect(JSON.parse(String(requests[1]!.init.body))).toEqual({ version: 3 });
});

test("別の管理操作が403になったら表示済みデータと進行中の取得を破棄する", async () => {
  const first = renderHook(() => useAdminData("/api/admin/analytics", parse), undefined);
  const second = renderHook(() => useAdminData("/api/admin/users", parse), undefined);
  requests[0]!.respond({ value: "機密の集計" });
  requests[1]!.respond({ value: "機密の一覧" });
  await flush();
  act(() => second.current.refresh());
  const mutation = adminMutation("/api/admin/feedback/id", "PATCH", { version: 1 });
  await act(async () => {
    requests[3]!.respond({ message: "権限を失いました" }, 403);
    await expect(mutation).rejects.toEqual(new AdminApiError(403, "権限を失いました"));
  });
  await flush();
  expect(first.current.data).toBeNull();
  expect(second.current.data).toBeNull();
  expect(requests[2]!.init.signal?.aborted).toBe(true);
  requests[2]!.respond({ value: "遅れて届く一覧" });
  await flush();
  expect(second.current.data).toBeNull();
});
