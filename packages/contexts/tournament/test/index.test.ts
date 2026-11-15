import { expect, test } from "bun:test";
import * as context from "@tetraboard/context-tournament";

test("パッケージを読み込める", () => {
  expect(context).toEqual({});
});
