import { expect, test } from "bun:test";
import { authorized, validToken } from "../cloudflare/src/access";

test("Containerを起動する前の認証は欠落・別token・長すぎる値を拒否する", async () => {
  const token = "cloud-access-test-token-at-least-32-characters";
  expect(validToken(token)).toBe(true);
  for (const value of [undefined, "", "short", " ".repeat(32), "a".repeat(257)])
    expect(validToken(value)).toBe(false);
  for (const value of ["", `Bearer ${token}x`, "x".repeat(264), `Basic ${token}`])
    expect(
      await authorized(
        new Request("https://example.test", { headers: { authorization: value } }),
        token,
      ),
    ).toBe(false);
  expect(
    await authorized(
      new Request("https://example.test", { headers: { authorization: `Bearer ${token}` } }),
      token,
    ),
  ).toBe(true);
});
