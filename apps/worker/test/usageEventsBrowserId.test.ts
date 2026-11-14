import { expect, test } from "vitest";
import { browserIdFromRequest } from "../src/usageEvents/browserId";

const browserId = "01234567-89ab-4cde-8fab-0123456789ab";
const cookie = (value: string) => `tetraboard-2026.analytics=${value}`;

test.each([
  { header: undefined, expected: null },
  { header: "", expected: null },
  { header: "unrelated=value", expected: null },
  { header: cookie(""), expected: null },
  { header: cookie("not-a-uuid"), expected: null },
  { header: cookie("01234567-89ab-1cde-8fab-0123456789ab"), expected: null },
  { header: cookie("01234567-89ab-4cde-7fab-0123456789ab"), expected: null },
  { header: cookie(`${browserId}extra`), expected: null },
  { header: cookie(`"${browserId}"`), expected: null },
  { header: cookie(browserId), expected: browserId },
  { header: cookie(browserId.toUpperCase()), expected: browserId.toUpperCase() },
  { header: `other=value;  ${cookie(browserId)}; session=value`, expected: browserId },
  {
    header: `other-${cookie(browserId)}; ${cookie(browserId.toUpperCase())}`,
    expected: browserId.toUpperCase(),
  },
  { header: `${cookie(browserId)}; ${cookie(browserId.toUpperCase())}`, expected: browserId },
  { header: `${cookie("invalid")}; ${cookie(browserId)}`, expected: null },
])("計測Cookieの最初の値がUUID v4のときだけそのまま返す: $header", ({ header, expected }) => {
  const request = new Request("https://tetraboard.net/", {
    headers: header === undefined ? {} : { Cookie: header },
  });
  expect(browserIdFromRequest(request)).toBe(expected);
});
