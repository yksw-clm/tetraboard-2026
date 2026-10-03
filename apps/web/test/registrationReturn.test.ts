import { describe, expect, test } from "bun:test";
import {
  parseRegistrationReturn,
  registrationPath,
} from "../src/features/account/registrationReturn";

const now = 1_790_899_200_000;
const value = {
  path: "/games/four-shogi",
  createdAt: now,
  oauthStarted: true,
  entry: {
    intent: "create",
    name: "入力中",
    roomCode: "12",
    mode: "doubles",
    threePlayerAttackProhibited: false,
  },
};
describe("登録後の復帰情報", () => {
  test("入力途中の参加情報を保持し、アカウントや参加資格は復元対象に含めない", () => {
    expect(parseRegistrationReturn({ ...value, token: "secret", account: "another" }, now)).toEqual(
      value,
    );
  });
  test("両ロビーと部屋世代付きの部屋URLだけに戻れる", () => {
    expect(registrationPath("/games/four-reversi")).toBe("/games/four-reversi");
    const path = "/rooms/12345?invite=00000000-0000-4000-8000-000000000010";
    expect(registrationPath(path)).toBe(path);
    for (const target of [
      "https://example.com",
      "//example.com",
      "/rooms/12345",
      `${path}&invite=other`,
      `${path}#x`,
      "/login",
      "/admin",
      "/account",
      "/games/four-shogi?next=https://example.com",
      "/rooms/12345?invite=invalid",
    ])
      expect(registrationPath(target)).toBeNull();
  });
  test("未来・期限切れ・破損した情報を適用しない", () => {
    expect(parseRegistrationReturn(value, now + 3_599_999)).not.toBeNull();
    for (const record of [
      null,
      [],
      { ...value, createdAt: now + 1 },
      { ...value, createdAt: now - 3_600_000 },
      { ...value, createdAt: NaN },
      { ...value, oauthStarted: "true" },
      { ...value, entry: { ...value.entry, mode: "other" } },
      { ...value, entry: { ...value.entry, selectedRoomId: 12345 } },
    ])
      expect(parseRegistrationReturn(record, now)).toBeNull();
  });
  test("部屋の入力とロビーの入力を取り違えない", () => {
    expect(parseRegistrationReturn({ ...value, joinName: "別の入力" }, now)).toBeNull();
    expect(
      parseRegistrationReturn(
        { ...value, path: "/rooms/12345?invite=00000000-0000-4000-8000-000000000010" },
        now,
      ),
    ).toBeNull();
  });
});
