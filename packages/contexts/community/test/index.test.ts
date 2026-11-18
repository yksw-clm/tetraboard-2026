import { expect, test } from "bun:test";
import { readChatPage } from "@tetraboard/context-community";

test("パッケージを読み込める", () => {
  expect(typeof readChatPage).toBe("function");
});
