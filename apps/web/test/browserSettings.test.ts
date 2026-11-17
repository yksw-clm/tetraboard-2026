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
    expect(parseBrowserSettings(value)).toEqual({
      soundEnabled: true,
      stampsVisible: true,
      boardAnimationsEnabled: true,
    });
  expect(parseBrowserSettings('{"soundEnabled":false,"stampsVisible":"false"}')).toEqual({
    soundEnabled: false,
    stampsVisible: true,
    boardAnimationsEnabled: true,
  });
  expect(parseBrowserSettings('{"stampsVisible":false}')).toEqual({
    soundEnabled: true,
    stampsVisible: false,
    boardAnimationsEnabled: true,
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
    boardAnimationsEnabled: true,
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
    boardAnimationsEnabled: true,
    storageError: true,
  });
  state.value = '{"soundEnabled":true,"stampsVisible":false}';
  state.writeFails = false;
  store.update({ stampsVisible: true });
  expect(store.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: true,
    boardAnimationsEnabled: true,
    storageError: false,
  });
  expect(JSON.parse(state.value!)).toEqual({
    soundEnabled: false,
    stampsVisible: true,
    boardAnimationsEnabled: true,
  });
});

test("保存領域の読取失敗も現在値を保ち、復元不能な初回はONで操作を継続", () => {
  const { store, state, storage } = memory('{"soundEnabled":false,"stampsVisible":false}');
  state.readFails = true;
  store.sync();
  expect(store.getSnapshot()).toEqual({
    soundEnabled: false,
    stampsVisible: false,
    boardAnimationsEnabled: true,
    storageError: true,
  });
  state.writeFails = true;
  store.update({ stampsVisible: true });
  expect(store.getSnapshot().soundEnabled).toBe(false);
  expect(new BrowserSettingsStore(() => storage).getSnapshot()).toEqual({
    soundEnabled: true,
    stampsVisible: true,
    boardAnimationsEnabled: true,
    storageError: true,
  });
});

test("旧保存データは他の設定を保って着手アニメーションをONとし、不正値もONへ戻す", () => {
  expect(parseBrowserSettings('{"soundEnabled":false,"stampsVisible":false}')).toEqual({
    soundEnabled: false,
    stampsVisible: false,
    boardAnimationsEnabled: true,
  });
  for (const value of ['"false"', "0", "null"])
    expect(parseBrowserSettings(`{"boardAnimationsEnabled":${value}}`).boardAnimationsEnabled).toBe(
      true,
    );
  expect(parseBrowserSettings('{"boardAnimationsEnabled":false}').boardAnimationsEnabled).toBe(
    false,
  );
});

test("着手アニメーションOFFを再読込・別タブ・別項目の変更でも維持する", () => {
  const { store, storage } = memory('{"soundEnabled":false,"stampsVisible":false}');
  const other = new BrowserSettingsStore(() => storage);
  store.update({ boardAnimationsEnabled: false });
  other.update({ soundEnabled: true });
  const reloaded = new BrowserSettingsStore(() => storage);
  expect(reloaded.getSnapshot()).toEqual({
    soundEnabled: true,
    stampsVisible: false,
    boardAnimationsEnabled: false,
    storageError: false,
  });
  store.sync();
  expect(store.getSnapshot()).toEqual(reloaded.getSnapshot());
});

test("着手アニメーションの未保存のOFFは同期で消さず、次の保存成功で永続化する", () => {
  const { store, state, storage } = memory();
  state.writeFails = true;
  store.update({ boardAnimationsEnabled: false });
  store.sync();
  store.sync('{"soundEnabled":false,"stampsVisible":false}');
  expect(store.getSnapshot().boardAnimationsEnabled).toBe(false);
  expect(store.getSnapshot().storageError).toBe(true);
  state.writeFails = false;
  store.update({ soundEnabled: false });
  expect(new BrowserSettingsStore(() => storage).getSnapshot().boardAnimationsEnabled).toBe(false);
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
