import { expect, spyOn, test } from "bun:test";
import { accountRequest } from "../src/features/account/accountApi";
import { accountPrivacyEvent } from "../src/features/account/accountPrivacy";

test.each(["invalid-json", "body-error"])(
  "accountRequestの既定動作は%sを従来どおりnullにする",
  async (failure) => {
    const response =
      failure === "invalid-json"
        ? new Response("{")
        : new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new DOMException("Timed out", "TimeoutError"));
              },
            }),
          );
    const fetch = spyOn(globalThis, "fetch").mockResolvedValueOnce(response);
    try {
      expect(await accountRequest("/api/account/session")).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  },
);

test.each([401, 503])("JSONを必須にしてもHTTP %sの既存のエラー処理を維持する", async (status) => {
  const fetch = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response("{", { status }))
    .mockResolvedValueOnce(new Response("{", { status }));
  let privacyChecks = 0;
  const privacyCheck = () => {
    privacyChecks++;
  };
  window.addEventListener(accountPrivacyEvent, privacyCheck);
  try {
    for (const options of [undefined, { requireJson: true }]) {
      await expect(accountRequest("/api/account/session", undefined, options)).rejects.toThrow(
        "通信に失敗しました。もう一度お試しください。",
      );
    }
    expect(privacyChecks).toBe(status === 401 ? 2 : 0);
  } finally {
    window.removeEventListener(accountPrivacyEvent, privacyCheck);
    fetch.mockRestore();
  }
});
