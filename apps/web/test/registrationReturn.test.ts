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
    cpuLevel: 2,
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
  test("大会の復帰先と参加意図は同じ正の大会番号だけを受け入れる", () => {
    expect(registrationPath("/tournaments/1")).toBe("/tournaments/1");
    expect(
      parseRegistrationReturn(
        { path: "/tournaments/1", tournamentEntry: 1, createdAt: now, oauthStarted: true },
        now,
      )?.tournamentEntry,
    ).toBe(1);
    for (const path of [
      "/tournaments/0",
      "/tournaments/01",
      "/tournaments/-1",
      "/tournaments/1?entry=1",
      "/tournaments/9007199254740992",
    ])
      expect(registrationPath(path)).toBeNull();
    for (const tournamentEntry of [0, -1, 2, "1", null])
      expect(
        parseRegistrationReturn(
          { path: "/tournaments/1", tournamentEntry, createdAt: now, oauthStarted: true },
          now,
        ),
      ).toBeNull();
    expect(
      parseRegistrationReturn({ path: "/tournaments/1", createdAt: now, oauthStarted: true }, now)
        ?.tournamentEntry,
    ).toBeUndefined();
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
      ...[0, 3, "2", null].map((cpuLevel) => ({ ...value, entry: { ...value.entry, cpuLevel } })),
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
