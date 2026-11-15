import { expect, test } from "bun:test";
import * as context from "@tetraboard/context-community";

test("パッケージを読み込める", () => {
  expect(context).toEqual({});
});
