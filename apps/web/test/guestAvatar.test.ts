import { expect, spyOn, test } from "bun:test";
import { avatarPresets } from "@tetraboard/protocol";
import { randomGuestAvatar } from "../src/features/account/guestAvatar";

test("初期選択は全プリセットを使い、変更では現在の画像以外の全候補を使う", () => {
  const random = spyOn(Math, "random");
  try {
    for (const current of [undefined, ...avatarPresets.map((preset) => preset.id)]) {
      const candidates = avatarPresets.filter((preset) => preset.id !== current);
      const selected = candidates.map((_, index) => {
        random.mockReturnValue((index + 0.5) / candidates.length);
        return randomGuestAvatar(current);
      });
      expect(selected).toEqual(candidates.map((preset) => preset.id));
      expect(selected).not.toContain(current);
    }
  } finally {
    random.mockRestore();
  }
});
