import { type Page, type Route } from "@playwright/test";
import type { AccountProfile } from "@tetraboard/protocol";
import { mockLobby } from "./fixtures";
export const profile: AccountProfile = {
  name: "あいうえおかきくけこ",
  username: "abcdefghijklmnopqrst",
  avatarUrl: null,
  profileCompleted: true,
};
export async function mockAccount(page: Page, initial: AccountProfile | null) {
  await mockLobby(page);
  let user = initial;
  let failure = false;
  let held: Route | null = null;
  let hold = false;
  const saves: FormData[] = [];
  // 保存後のアバター表示用。変換結果自体はテスト中の実画像をデコードして検証します。
  await page.route("**/test-avatar.webp", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE8sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.route("**/api/account/session", (route) => route.fulfill({ json: { user } }));
  async function save(route: Route) {
    const data = await new Response(new Uint8Array(route.request().postDataBuffer()!), {
      headers: { "Content-Type": route.request().headers()["content-type"] },
    }).formData();
    saves.push(data);
    if (failure)
      return route.fulfill({ status: 409, json: { message: "このIDはすでに使われています。" } });
    user = {
      name: String(data.get("name")).trim(),
      username: String(data.get("username")).replace(/^@/, "").trim().toLowerCase(),
      avatarUrl:
        data.get("avatarAction") === "replace"
          ? "/test-avatar.webp"
          : data.get("avatarAction") === "remove"
            ? null
            : (user?.avatarUrl ?? null),
      profileCompleted: true,
    };
    await route.fulfill({ json: user });
  }
  for (const path of ["setup", "profile"])
    await page.route(`**/api/account/${path}`, async (route) => {
      if (hold) held = route;
      else await save(route);
    });
  await page.route("**/api/auth/sign-out", async (route) => {
    user = null;
    await route.fulfill({ json: { success: true } });
  });
  return {
    saves,
    fail: () => {
      failure = true;
    },
    succeed: () => {
      failure = false;
    },
    hold: () => {
      hold = true;
    },
    release: async () => {
      hold = false;
      if (held) {
        await save(held);
        held = null;
      }
    },
  };
}
