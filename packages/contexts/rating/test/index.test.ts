import { expect, test } from "bun:test";
import * as context from "@tetraboard/context-rating";

test("パッケージを読み込める", () => {
  expect(context).toEqual({});
});
