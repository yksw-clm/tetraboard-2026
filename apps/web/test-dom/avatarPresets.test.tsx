import { expect, spyOn, test } from "bun:test";
import { avatarPresets, avatarPresetUrl, type AccountProfile } from "@tetraboard/protocol";
import { ProfileForm } from "../src/features/account/ProfileForm";
import { useProfileDraft } from "../src/features/account/useProfileDraft";
import { profile } from "../test/fixtures/account";
import { act, flush, press, render, renderHook, requests, wrap } from "./harness";
import * as accountApi from "../src/features/account/accountApi";
import type { FormEvent } from "react";

const initial: AccountProfile = {
  ...profile,
  avatarPresetId: avatarPresets[0].id,
  avatarUrl: avatarPresetUrl(avatarPresets[0].id),
};
const event = { preventDefault() {} } as FormEvent;
test("ゲストも6種類を選べ、保存失敗後も選択を保持し、連携が必要な入力は読み取り専用にする", async () => {
  const user = { ...initial, isGuest: true };
  const saved: AccountProfile[] = [];
  const view = render(
    wrap(user)(<ProfileForm user={user} setup={false} onSaved={(value) => saved.push(value)} />),
  );
  expect(view.querySelector("fieldset")!.querySelectorAll("button[aria-pressed]")).toHaveLength(6);
  expect(view.querySelector('input[type="file"]')).toBeNull();
  expect(view.querySelector<HTMLInputElement>('input[name="profileMessage"]')!.readOnly).toBe(true);
  expect(view.querySelector('[aria-label="お気に入りゲームの選択"]')).not.toBeNull();
  expect(view.querySelector<HTMLInputElement>('input[name="username"]')!.readOnly).toBe(true);
  const preset = avatarPresets[2];
  act(() => view.querySelector<HTMLButtonElement>(`[aria-label="${preset.name}"]`)!.click());
  expect(view.querySelector(`[aria-label="${preset.name}"]`)!.getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(requests).toHaveLength(0);
  press(view, "保存");
  expect(requests[0]!.url).toBe("/api/account/guest/name");
  expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
    name: user.name,
    avatarPresetId: preset.id,
  });
  requests[0]!.respond({ message: "保存できません" }, 503);
  await flush();
  expect(view.querySelector(`[aria-label="${preset.name}"]`)!.getAttribute("aria-pressed")).toBe(
    "true",
  );
  press(view, "保存");
  requests[1]!.respond({
    ...user,
    avatarPresetId: preset.id,
    avatarUrl: avatarPresetUrl(preset.id),
  });
  await flush();
  expect(saved[0]!.avatarPresetId).toBe(preset.id);
});
test("プリセット・アップロードを切り替え、削除は最後に保存したプリセットへ戻し、変換中は操作しない", async () => {
  const user = { ...initial, avatarUrl: "/api/avatars/00000000-0000-4000-8000-000000000099" };
  const h = renderHook(useProfileDraft, { user, setup: false }, wrap(user));
  act(() => h.current.selectPreset(avatarPresets[1].id));
  expect(h.current.image).toBe(avatarPresetUrl(avatarPresets[1].id));
  expect(h.current.canRemoveImage).toBe(false);
  await flush();
  let release!: () => void;
  const converted = new Promise<Blob>((resolve) => {
    release = () => resolve(new Blob(["webp"], { type: "image/webp" }));
  });
  const convert = spyOn(accountApi, "convertAvatar").mockImplementation(() => converted);
  try {
    act(() => {
      void h.current.selectImage(new File(["image"], "avatar.png", { type: "image/png" }));
    });
    act(() => h.current.selectPreset(avatarPresets[3].id));
    expect(h.current.image).toBe(avatarPresetUrl(avatarPresets[1].id));
    release();
    await flush();
    expect(h.current.image).toStartWith("blob:");
    act(() => h.current.removeImage());
    expect(h.current.image).toBe(initial.avatarUrl);
    act(() => h.current.selectPreset(avatarPresets[4].id));
    act(() => {
      void h.current.submit(event);
    });
    const data = requests[0]!.init.body as FormData;
    expect(data.get("avatarAction")).toBe("preset");
    expect(data.get("avatarPresetId")).toBe(avatarPresets[4].id);
    expect(data.get("avatar")).toBeNull();
    h.unmount();
    const fresh = renderHook(useProfileDraft, { user, setup: false }, wrap(user));
    expect(fresh.current.image).toBe(user.avatarUrl);
  } finally {
    convert.mockRestore();
  }
});
