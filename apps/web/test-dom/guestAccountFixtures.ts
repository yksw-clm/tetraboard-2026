import { expect } from "bun:test";
import { flush, requests } from "./harness";

export const guestProfile = (name = "ゲスト本人") => ({
  profileId: "e1df3e74-a0a5-4dc1-98b3-5bac6f433a01",
  name,
  username: null,
  avatarUrl: null,
  profileCompleted: true,
  isGuest: true,
  nameCustomized: true,
});
export async function completeGuestAccount(name: string, index = 1) {
  expect(requests[index]!.url).toBe("/api/account/session");
  requests[index]!.respond({ user: null });
  await flush();
  expect(requests[index + 1]!.url).toBe("/api/account/guest");
  expect(JSON.parse(String(requests[index + 1]!.init.body))).toEqual({ name });
  const user = guestProfile(name);
  requests[index + 1]!.respond(user, 201);
  await flush();
  expect(requests[index + 2]!.url).toBe("/api/account/session");
  requests[index + 2]!.respond({ user });
  await flush();
  return requests[index + 3]!;
}
