import { expect, test } from "bun:test";
import {
  BrowserSettingsStore,
  browserSettingsKey,
  parseBrowserSettings,
} from "../src/shared/browserSettings";

function memory(value: string | null = null) {
  const state = { value, readFails: false, writeFails: false };
  const storage = {
    getItem(key: string) {
      expect(key).toBe(browserSettingsKey);
      if (state.readFails) throw Error("read denied");
      return state.value;
    },
    setItem(key: string, value: string) {
      expect(key).toBe(browserSettingsKey);
      if (state.writeFails) throw Error("write denied");
      state.value = value;
    },
  };
  return { state, store: new BrowserSettingsStore(() => storage), storage };
}

test("未保存・不正JSONはON、真偽値以外は項目ごとにONへ戻す", () => {
  for (const value of [null, "bad", "null", "[]", "1", '"false"'])
    expect(parseBrowserSettings(value)).toEqual({ soundEnabled: true, stampsVisible: true });
  expect(parseBrowserSettings('{"soundEnabled":false,"stampsVisible":"false"}')).toEqual({
    soundEnabled: false,
    stampsVisible: true,
  });
  expect(parseBrowserSettings('{"stampsVisible":false}')).toEqual({
    soundEnabled: true,
    stampsVisible: false,
  });
});

test("再読込でOFFを復元し、古いタブの変更でも別の項目を上書きしない", () => {
  const { store, storage } = memory();
  const other = new BrowserSettingsStore(() => storage);
  store.update({ soundEnabled: false });
  other.update({ stampsVisible: false });
  const reloaded = new BrowserSettingsStore(() => storage);
  expect(reloaded.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: false,
    storageError: false,
  });
  store.sync();
  expect(store.getSnapshot()).toEqual(reloaded.getSnapshot());
});

test("保存失敗ではメモリの変更を復帰・別タブの通知でも保ち、保存成功で補足を解除", () => {
  const { store, state } = memory();
  state.writeFails = true;
  store.update({ soundEnabled: false });
  store.sync();
  expect(store.getSnapshot().soundEnabled).toBe(false);
  store.sync('{"soundEnabled":true,"stampsVisible":false}');
  expect(store.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: false,
    storageError: true,
  });
  state.value = '{"soundEnabled":true,"stampsVisible":false}';
  state.writeFails = false;
  store.update({ stampsVisible: true });
  expect(store.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: true,
    storageError: false,
  });
  expect(JSON.parse(state.value!)).toEqual({ soundEnabled: false, stampsVisible: true });
});

test("保存領域の読取失敗も現在値を保ち、復元不能な初回はONで操作を継続", () => {
  const { store, state, storage } = memory('{"soundEnabled":false,"stampsVisible":false}');
  state.readFails = true;
  store.sync();
  expect(store.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: false,
    storageError: true,
  });
  state.writeFails = true;
  store.update({ stampsVisible: true });
  expect(store.getSnapshot().soundEnabled).toBe(false);
  expect(new BrowserSettingsStore(() => storage).getSnapshot()).toEqual({
    soundEnabled: true,
    stampsVisible: true,
    storageError: true,
  });
});

test("同期・削除・購読解除を扱い、値が変わらない読取は同じsnapshotを維持", () => {
  const { store } = memory();
  let notified = 0;
  const release = store.subscribe(() => notified++);
  const before = store.getSnapshot();
  store.sync();
  expect(store.getSnapshot()).toBe(before);
  expect(notified).toBe(0);
  store.sync('{"soundEnabled":false,"stampsVisible":false}');
  expect(notified).toBe(1);
  store.sync(null);
  expect(store.getSnapshot().soundEnabled).toBe(true);
  expect(notified).toBe(2);
  release();
  store.update({ soundEnabled: false });
  expect(notified).toBe(2);
});
