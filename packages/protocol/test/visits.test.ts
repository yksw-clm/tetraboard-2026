import { expect, test } from "bun:test";
import { visitContract, type VisitInput } from "../src/visits";
import { visitInputSchema } from "../src/visitSchema";

const input: VisitInput = {
  path: "/",
  referrerHost: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
};

test("訪問APIはPOSTで2048バイトまでの本文を受け付ける", () => {
  expect(visitContract.method).toBe("POST");
  expect(visitContract.url).toBe("/api/visits");
  expect(visitContract.maxBodyBytes).toBe(2048);
});

test.each([
  { field: "path", value: `/${"a".repeat(1023)}` },
  { field: "referrerHost", value: "a".repeat(253) },
  ...["utmSource", "utmMedium", "utmCampaign"].map((field) => ({ field, value: "a".repeat(256) })),
])("$field は文字数の上限を受理し、1文字超えると拒否する", ({ field, value }) => {
  expect(visitInputSchema.safeParse({ ...input, [field]: value }).success).toBe(true);
  expect(visitInputSchema.safeParse({ ...input, [field]: `${value}a` }).success).toBe(false);
});

test("訪問本文はnullと空の参照元を許し、相対パスや余分な項目を拒否する", () => {
  expect(visitInputSchema.parse(input)).toEqual(input);
  expect(visitInputSchema.safeParse({ ...input, referrerHost: "" }).success).toBe(true);
  expect(visitInputSchema.safeParse({ ...input, path: "games" }).success).toBe(false);
  expect(visitInputSchema.safeParse({ ...input, extra: "value" }).success).toBe(false);
});
