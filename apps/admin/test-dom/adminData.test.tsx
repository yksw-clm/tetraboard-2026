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
