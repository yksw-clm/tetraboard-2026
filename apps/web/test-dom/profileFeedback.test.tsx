import { expect, test } from "bun:test";
import { useProfileDraft } from "../src/features/account/useProfileDraft";
import { useFeedback } from "../src/features/feedback/useFeedback";
import { convertAvatar } from "../src/features/account/accountApi";
import { convertFeedbackImage } from "../src/features/feedback/feedbackApi";
import { profile } from "../test/fixtures/account";
import { act, flush, renderHook, requests, wrap } from "./harness";
import { closed, draws, encoded, holdImage, setEncoded, setImage } from "./imageBoundary";
import type { FormEvent } from "react";

const event = { preventDefault() {} } as FormEvent;
const file = () => new File(["image"], "image.png", { type: "image/png" });
test("プロフィールの初期入力・入力検証・送信ロック・409後の下書き・保存・破棄", async () => {
  const saved: (typeof profile)[] = [];
  const h = renderHook(
    useProfileDraft,
    {
      user: profile,
      setup: false,
      onSaved: (p: typeof profile) => {
        saved.push(p);
      },
    },
    wrap(profile),
  );
  expect(h.current.name).toBe(profile.name);
  act(() => h.current.setUsername("!"));
  act(() => {
    void h.current.submit(event);
  });
  expect(requests).toHaveLength(0);
  expect(h.current.usernameInvalid).toBe(true);
  act(() => {
    h.current.setName("新しい名前");
    h.current.setUsername("new_name");
  });
  act(() => {
    void h.current.submit(event);
    void h.current.submit(event);
  });
  expect(requests).toHaveLength(1);
  expect(h.current.busy).toBe(true);
  const data = requests[0]!.init.body as FormData;
  expect(data.get("name")).toBe("新しい名前");
  expect(data.get("avatarAction")).toBe("keep");
  requests[0]!.respond({ message: "IDは使用済みです" }, 409);
  await flush();
  expect(h.current.error).toBe("IDは使用済みです");
  expect(h.current.name).toBe("新しい名前");
  expect(h.current.busy).toBe(false);
  act(() => {
    void h.current.submit(event);
  });
  requests[1]!.respond({ ...profile, name: "保存結果", username: "new_name" });
  await flush();
  expect(saved).toEqual([{ ...profile, name: "保存結果", username: "new_name" }]);
  expect(h.current.name).toBe("保存結果");
  h.unmount();
  const fresh = renderHook(useProfileDraft, { user: profile, setup: false }, wrap(profile));
  expect(fresh.current.name).toBe(profile.name);
});
test("画像処理中はプロフィールを送れず、変換失敗は元画像を保持し、replace/removeをFormDataで保存", async () => {
  const h = renderHook(
    useProfileDraft,
    { user: { ...profile, avatarUrl: "/old.webp" }, setup: true },
    wrap(profile),
  );
  const release = holdImage();
  act(() => {
    void h.current.selectImage(file());
  });
  expect(h.current.processing).toBe(true);
  act(() => {
    void h.current.submit(event);
  });
  expect(requests).toHaveLength(0);
  release();
  await flush();
  expect(h.current.image).toStartWith("blob:");
  act(() => {
    void h.current.selectImage(new File(["bad"], "x.txt", { type: "text/plain" }));
  });
  await flush();
  expect(h.current.image).toStartWith("blob:");
  expect(h.current.error).toContain("JPEG");
  act(() => {
    void h.current.submit(event);
  });
  expect(requests[0]!.url).toBe("/api/account/setup");
  const data = requests[0]!.init.body as FormData;
  expect(data.get("avatarAction")).toBe("replace");
  expect((data.get("avatar") as File).type).toBe("image/webp");
  requests[0]!.respond({ message: "失敗" }, 503);
  await flush();
  act(() => h.current.removeImage());
  expect(h.current.image).toBeNull();
  act(() => {
    void h.current.submit(event);
  });
  expect((requests[1]!.init.body as FormData).get("avatarAction")).toBe("remove");
});
test("画像入力は種別・容量・寸法を検証し、crop/resizeの入出力とbitmap解放を確認", async () => {
  for (const convert of [convertAvatar, convertFeedbackImage]) {
    for (const invalid of [
      new File([], "empty.png", { type: "image/png" }),
      new File(["x"], "bad.gif", { type: "image/gif" }),
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    ])
      await expect(convert(invalid)).rejects.toThrow("5MB");
  }
  expect(await convertAvatar(file())).toBe(encoded);
  expect(draws[0]!.slice(1)).toEqual([600, 0, 1200, 1200, 0, 0, 256, 256]);
  expect(await convertFeedbackImage(file())).toBe(encoded);
  expect(draws[1]!.slice(1)).toEqual([0, 0, 1600, 800]);
  expect(closed).toBe(2);
  setImage(10000, 10000);
  await expect(convertFeedbackImage(file())).rejects.toThrow("大きすぎます");
  expect(closed).toBe(3);
  setImage(20, 10);
  setEncoded(new Blob([], { type: "image/webp" }));
  await expect(convertAvatar(file())).rejects.toThrow("変換に失敗");
  expect(closed).toBe(4);
  setEncoded(new Blob([new Uint8Array(1024 * 1024 + 1)], { type: "image/webp" }));
  await expect(convertFeedbackImage(file())).rejects.toThrow("1MB");
  expect(closed).toBe(5);
});
const context = {
  page: "room" as const,
  game: "four-shogi" as const,
  room: {
    id: "12345",
    instanceId: "00000000-0000-4000-8000-000000000010",
    roundId: "00000000-0000-4000-8000-000000000020",
  },
};
const useFeedbackProbe = (p: typeof context) => useFeedback(p, false);
function feedbackInput(index: number) {
  return JSON.parse(String((requests[index]!.init.body as FormData).get("input")));
}
test("フィードバック入力検証・ロック・失敗時の画像下書き・同一ID再送・technicalの固定・成功後クリア", async () => {
  const h = renderHook(useFeedbackProbe, context);
  act(() => {
    void h.current.submit();
  });
  expect(h.current.message).not.toBeNull();
  expect(requests).toHaveLength(0);
  act(() => {
    h.current.update("kind", "bug");
    h.current.update("body", "問題があります");
    h.current.update("steps", "操作手順");
  });
  act(() => {
    void h.current.selectImage(file());
  });
  await flush();
  expect(h.current.attachment).toBe(encoded);
  act(() => {
    void h.current.submit();
    void h.current.submit();
    h.current.update("body", "ロック中の入力");
    h.current.removeImage();
  });
  expect(requests).toHaveLength(1);
  expect(h.current.draft.body).toBe("問題があります");
  expect(h.current.attachment).toBe(encoded);
  const first = feedbackInput(0);
  expect(Object.keys(first.technical).sort()).toEqual([
    "browser",
    "build",
    "game",
    "height",
    "page",
    "room",
    "width",
  ]);
  expect(JSON.stringify(first)).not.toContain("token");
  expect(JSON.stringify(first)).not.toContain("https:");
  requests[0]!.respond({ message: "再試行してください" }, 503);
  await flush();
  expect(h.current.draft.body).toBe("問題があります");
  expect(h.current.attachment).toBe(encoded);
  h.rerender({
    ...context,
    room: { ...context.room, roundId: "00000000-0000-4000-8000-000000000021" },
  });
  act(() => {
    void h.current.submit();
  });
  expect(feedbackInput(1)).toEqual(first);
  const id = "00000000-0000-4000-8000-000000000099";
  requests[1]!.respond({ id }, 201);
  await flush();
  expect(h.current.receipt).toBe(id);
  expect(h.current.draft.body).toBe("");
  expect(h.current.attachment).toBeNull();
  expect(h.current.preview).toBeNull();
});
test("要望はtechnical=null・手順空、入力変更で再送IDを更新し、文字上限や画像取消を処理", async () => {
  const h = renderHook(useFeedbackProbe, context);
  act(() => {
    h.current.update("kind", "request");
    h.current.update("body", "要望");
    h.current.update("steps", "不要な手順");
  });
  act(() => {
    void h.current.submit();
  });
  const first = feedbackInput(0);
  expect(first.technical).toBeNull();
  expect(first.steps).toBe("");
  requests[0]!.respond({}, 503);
  await flush();
  act(() => {
    h.current.update("body", "変更した要望");
  });
  act(() => {
    void h.current.submit();
  });
  expect(feedbackInput(1).submissionId).not.toBe(first.submissionId);
  requests[1]!.respond({}, 503);
  await flush();
  act(() => h.current.update("body", "あ".repeat(2001)));
  act(() => {
    void h.current.submit();
  });
  expect(requests).toHaveLength(2);
  act(() => {
    void h.current.selectImage(file());
  });
  await flush();
  act(() => h.current.removeImage());
  expect(h.current.attachment).toBeNull();
  h.unmount();
  const fresh = renderHook(useFeedbackProbe, context);
  expect(fresh.current.draft.body).toBe("");
});
