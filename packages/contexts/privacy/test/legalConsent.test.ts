import { expect, mock, test } from "bun:test";
import {
  acceptLegalConsent,
  completeOAuthLegalConsent,
  readLegalConsent,
} from "@tetraboard/context-privacy";

const version = "current";
const now = () => 1234;

test("保存した規約版が現行版と一致するときだけ同意済みになる", async () => {
  const readVersion = mock(async () => "old");
  expect(await readLegalConsent({ readVersion }, "account", version)).toEqual({
    accepted: false,
    version,
  });
  readVersion.mockResolvedValueOnce(version);
  expect(await readLegalConsent({ readVersion }, "account", version)).toEqual({
    accepted: true,
    version,
  });
});

test("現行版への明示的な同意だけを保存する", async () => {
  const store = { saveConsent: mock(async () => {}) };
  for (const input of [
    null,
    { version: "old", accepted: true },
    { version, accepted: "true" },
    { version, accepted: false },
  ])
    expect(await acceptLegalConsent(store, "account", input, version, now)).toBeNull();

  expect(store.saveConsent).not.toHaveBeenCalled();
  expect(
    await acceptLegalConsent(store, "account", { version, accepted: true }, version, now),
  ).toEqual({ accepted: true, version });
  expect(store.saveConsent).toHaveBeenCalledWith("account", version, now());
});

test("OAuth の同意はプロバイダーと現行版が一致し、本人を取得できたときだけ確定する", async () => {
  const store = {
    readOAuthConsent: mock(async () => ({ provider: "google", version })),
    completeOAuthConsent: mock(async () => {}),
  };
  const readAccount = mock(async (): Promise<string | null> => "account");
  const callback = { state: "state", pathname: "/api/auth/callback/google" };

  store.readOAuthConsent.mockResolvedValueOnce({ provider: "google", version: "old" });
  await completeOAuthLegalConsent(store, callback, version, readAccount, now);
  await completeOAuthLegalConsent(
    store,
    { ...callback, pathname: "/api/auth/callback/discord" },
    version,
    readAccount,
    now,
  );
  expect(readAccount).not.toHaveBeenCalled();

  readAccount.mockResolvedValueOnce(null);
  await completeOAuthLegalConsent(store, callback, version, readAccount, now);
  expect(store.completeOAuthConsent).not.toHaveBeenCalled();

  await completeOAuthLegalConsent(store, callback, version, readAccount, now);
  expect(store.readOAuthConsent).toHaveBeenCalledWith("state", now());
  expect(store.completeOAuthConsent).toHaveBeenCalledWith("account", "state", version);
});
