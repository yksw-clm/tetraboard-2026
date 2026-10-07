import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { readGuestName, saveGuestName } from "../src/shared/guestName";

const storageKey = "tetraboard:guest-name";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let values: Map<string, string>;
let write: ReturnType<typeof mock<(key: string, value: string) => void>>;

beforeEach(() => {
  values = new Map();
  write = mock((key: string, value: string) => {
    values.set(key, value);
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => values.get(key) ?? null, setItem: write },
  });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("保存名は既存の文字数・空白除去の規則で読み書きする", () => {
  expect(readGuestName()).toBe("");
  for (const name of [
    "  てとら  ",
    "あいうえおかきくけこ",
    "👨‍👩‍👧‍👦".repeat(10),
    "か\u3099".repeat(10),
  ]) {
    saveGuestName(name);
    expect(values.get(storageKey)).toBe(name.trim());
    expect(readGuestName()).toBe(name.trim());
  }
  values.set(storageKey, "  読取り  ");
  expect(readGuestName()).toBe("読取り");
  expect(values.get(storageKey)).toBe("  読取り  ");
});

test("不正な保存名は空文字として読み、未指定・不正な名前では以前の名前を更新しない", () => {
  for (const name of ["", " \t\n", "あいうえおかきくけこさ", "👨‍👩‍👧‍👦".repeat(11), '{"name":"名前"}']) {
    values.set(storageKey, name);
    expect(readGuestName()).toBe("");
    values.set(storageKey, "前の名前");
    saveGuestName(name);
    expect(values.get(storageKey)).toBe("前の名前");
  }
  saveGuestName(undefined);
  expect(write).not.toHaveBeenCalled();
});

test("localStorageへのアクセス・取得・書込みの例外を呼出し側へ伝えない", () => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => {
      throw new Error("access denied");
    },
  });
  expect(readGuestName()).toBe("");
  expect(() => saveGuestName("名前")).not.toThrow();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => {
        throw new Error("read denied");
      },
      setItem: () => {
        throw new Error("write denied");
      },
    },
  });
  expect(readGuestName()).toBe("");
  expect(() => saveGuestName("名前")).not.toThrow();
});
