import { describe, expect, test } from "bun:test";
import {
  formatRatio,
  nicknameSchema,
  profileInputSchema,
  usernameSchema,
} from "@tetraboard/protocol";
describe("アカウント表示と入力", () => {
  test("割合を小数3桁で表示し、0局でもNaNにならない", () => {
    expect(formatRatio(20, 100)).toBe(".200");
    expect(formatRatio(1, 3)).toBe(".333");
    expect(formatRatio(0, 0)).toBe(".000");
    expect(formatRatio(3, 3)).toBe("1.000");
  });
  test("公開IDを小文字に揃え、名前の制限は文字の見た目で数える", () => {
    expect(usernameSchema.parse(" Tetra_123 ")).toBe("tetra_123");
    for (const value of ["ab", "@abc", "日本語", "a-b", "a".repeat(21)])
      expect(usernameSchema.safeParse(value).success).toBe(false);
    expect(nicknameSchema.safeParse("👨‍👩‍👧‍👦".repeat(10)).success).toBe(true);
    expect(nicknameSchema.safeParse("👨‍👩‍👧‍👦".repeat(11)).success).toBe(false);
    expect(profileInputSchema.safeParse({ name: " ", username: "hello" }).success).toBe(false);
  });
});
