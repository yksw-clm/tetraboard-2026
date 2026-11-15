import { expect, test } from "bun:test";
import * as context from "@tetraboard/context-record";

test("パッケージを読み込める", () => {
  expect(context).toEqual({});
});
