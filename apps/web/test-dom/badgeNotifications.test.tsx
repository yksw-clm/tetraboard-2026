import { afterEach, expect, test } from "bun:test";
import { StrictMode, useContext } from "react";
import type { AccountProfile, BadgeNotification } from "@tetraboard/protocol";
import { AccountContext } from "../src/features/account/useAccount";
import { BadgeNotificationProvider } from "../src/features/badges/BadgeNotificationProvider";
import { BadgeToastDetails } from "../src/features/badges/BadgeToastDetails";
import { badgeToastTitle } from "../src/features/badges/badgeNotificationPresentation";
import { AppToastContext } from "../src/shared/ui/appToastContext";
import { act, clock, flush, render, rerender, requests } from "./harness";

const user: AccountProfile = {
  profileId: "10000000-0000-4000-8000-000000000001",
  name: "本人",
  username: "self",
  avatarUrl: null,
  profileCompleted: true,
};
const notification: BadgeNotification = {
  id: "match-1",
  game: "four-shogi",
  badges: [
    { id: "perfect-wins", tier: 1, previousTier: 0, value: 1 },
    { id: "knockouts", tier: 3, previousTier: 2, value: 50 },
    { id: "wins", tier: 2, previousTier: 1, value: 15 },
    { id: "games", tier: 1, previousTier: 0, value: 5 },
  ],
};
function tree(account: AccountProfile | null = user, page = "room", loading = false) {
  return (
    <AccountContext.Provider
      value={{
        user: account,
        loading,
        error: null,
        refresh: async () => {},
        update: () => {},
      }}
    >
      <BadgeNotificationProvider>
        <button>{page}</button>
      </BadgeNotificationProvider>
    </AccountContext.Provider>
  );
}
const requestFor = (operation: string) => requests.filter((r) => r.url.endsWith("/" + operation));
async function deliver(value: BadgeNotification = notification) {
  requestFor("claim").at(-1)!.respond({ notification: value });
  await flush();
}
function visibility(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: hidden ? "hidden" : "visible",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
}
afterEach(() => {
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "visibilityState");
});

test("all four images retain order, rank, cumulative numbers, names and decorative accessibility", () => {
  const view = render(<BadgeToastDetails notification={notification} onShown={() => {}} />);
  expect([...view.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
    "/assets/badges/four-shogi/games-star-1.webp",
    "/assets/badges/four-shogi/wins-star-2.webp",
    "/assets/badges/four-shogi/knockouts-star-3.webp",
    "/assets/badges/four-shogi/perfect-wins-star-1.webp",
  ]);
  for (const img of view.querySelectorAll("img")) {
    expect(img.width).toBe(56);
    expect(img.getAttribute("draggable")).toBe("false");
    expect(img.alt).toBe("");
  }
  expect(view.textContent).toContain("累計50人");
  expect(badgeToastTitle(notification)).toBe("バッジを4個獲得・更新しました！");
  expect(badgeToastTitle({ ...notification, badges: [notification.badges[0]!] })).toBe(
    "バッジを獲得しました！",
  );
  expect(badgeToastTitle({ ...notification, badges: [notification.badges[1]!] })).toBe(
    "バッジが星3になりました！",
  );
});

test("shows only after claim, acknowledges on mount once, survives page change and dismisses at 5000ms", async () => {
  const view = render(tree());
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(requestFor("shown")).toHaveLength(0);
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(4);
  expect(document.querySelector("[role=status]")?.getAttribute("aria-live")).toBe("polite");
  expect(document.activeElement).toBe(document.body);
  expect(requestFor("shown")).toHaveLength(1);
  requestFor("shown")[0]!.respond({ ok: true });
  await flush();
  const token = JSON.parse(String(requestFor("shown")[0]!.init.body)).token;
  rerender(view, tree(user, "lobby"));
  await flush();
  expect(document.querySelectorAll("img")).toHaveLength(4);
  expect(requestFor("shown")).toHaveLength(1);
  expect(JSON.parse(String(requestFor("claim")[0]!.init.body)).token).toBe(token);
  clock.advance(4999);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  clock.advance(1);
  await flush();
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).toBe("true");
  clock.advance(300);
  await flush();
  expect(document.querySelectorAll("img")).toHaveLength(0);
});

test("hidden page does not claim, preserves remaining display time and resumes on visibility", async () => {
  visibility(true);
  render(tree());
  expect(requestFor("claim")).toHaveLength(0);
  clock.advance(10000);
  expect(requestFor("claim")).toHaveLength(0);
  visibility(false);
  await deliver();
  requestFor("shown")[0]!.respond({ ok: true });
  await flush();
  clock.advance(2000);
  visibility(true);
  clock.advance(20000);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  visibility(false);
  clock.advance(2999);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  clock.advance(1);
  await flush();
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).toBe("true");
});

test("hide during claim releases without showing or acknowledging; connectivity retries fetching", async () => {
  render(tree());
  visibility(true);
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(requestFor("shown")).toHaveLength(0);
  expect(requestFor("release")).toHaveLength(1);
  requestFor("release")[0]!.respond({ ok: true });
  await flush();
  visibility(false);
  requestFor("claim").at(-1)!.reject(new Error("offline"));
  await flush();
  act(() => window.dispatchEvent(new Event("online")));
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(4);
});

test("acknowledgement retry renews lease and does not replay; expired lease allows recovery", async () => {
  render(tree());
  await deliver();
  requestFor("shown")[0]!.reject(new Error("network"));
  await flush();
  expect(requestFor("renew")).toHaveLength(1);
  requestFor("renew")[0]!.respond({ ok: true });
  await flush();
  clock.advance(5000);
  await flush();
  expect(requestFor("shown")).toHaveLength(2);
  requestFor("shown")[1]!.respond({}, 409);
  await flush();
  clock.advance(5000);
  await flush();
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(requestFor("shown")).toHaveLength(3);
  requestFor("shown")[2]!.respond({ ok: true });
  await flush();
});

test("logout/switch clears badge and stale responses cannot display as another account", async () => {
  const view = render(tree());
  const stale = requestFor("claim")[0]!;
  rerender(view, tree(null));
  stale.respond({ notification });
  await flush();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  rerender(view, tree());
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(4);
  rerender(view, tree({ ...user, profileId: "10000000-0000-4000-8000-000000000002" }));
  clock.advance(300);
  await flush();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(requestFor("shown")).toHaveLength(1);
});

test("StrictMode cleanup ignores stale claims and only the live session displays", async () => {
  render(<StrictMode>{tree()}</StrictMode>);
  expect(requestFor("claim")).toHaveLength(2);
  requestFor("claim")[0]!.respond({ notification });
  await flush();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(4);
});

test("session refresh pending prevents new claims and releases an in-flight notification", async () => {
  const view = render(tree(user, "room", true));
  clock.advance(5000);
  await flush();
  expect(requestFor("claim")).toHaveLength(0);
  rerender(view, tree());
  clock.advance(5000);
  await flush();
  expect(requestFor("claim")).toHaveLength(1);
  rerender(view, tree(user, "room", true));
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(0);
  expect(requestFor("shown")).toHaveLength(0);
  requestFor("release")[0]!.respond({ ok: true });
  await flush();
  clock.advance(5000);
  expect(requestFor("claim")).toHaveLength(1);
  rerender(view, tree());
  act(() => window.dispatchEvent(new Event("online")));
  await deliver();
  expect(document.querySelectorAll("img")).toHaveLength(4);
});

test("closing the first match waits for exit before fetching the next notification", async () => {
  render(tree());
  await deliver();
  requestFor("shown")[0]!.respond({ ok: true });
  await flush();
  act(() => document.querySelector<HTMLButtonElement>("[aria-label='通知を閉じる']")!.click());
  await flush();
  expect(requestFor("claim")).toHaveLength(1);
  clock.advance(300);
  await flush();
  expect(requestFor("claim")).toHaveLength(2);
  await deliver({ ...notification, id: "match-2", badges: [notification.badges[1]!] });
  expect(document.querySelectorAll("img")).toHaveLength(1);
  expect(document.body.textContent).toContain("バッジが星3になりました！");
  expect(requestFor("shown")).toHaveLength(2);
});

test("keyboard focus pauses remaining time until focus leaves the toast", async () => {
  render(tree());
  await deliver();
  requestFor("shown")[0]!.respond({ ok: true });
  await flush();
  clock.advance(2000);
  act(() => document.querySelector<HTMLButtonElement>("[aria-label='通知を閉じる']")!.focus());
  clock.advance(10000);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  act(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "room")!.focus(),
  );
  clock.advance(2999);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  clock.advance(1);
  await flush();
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).toBe("true");
});

test("existing room toast occupies shared queue before badge acquisition and keeps 3-second timeout", async () => {
  function RoomNotice() {
    const queue = useContext(AppToastContext)!;
    return (
      <button
        onClick={() =>
          queue.add({ title: "ルームのお知らせ", description: "チャット" }, { timeout: 3000 })
        }
      >
        通知追加
      </button>
    );
  }
  render(
    <AccountContext.Provider
      value={{ user: null, loading: false, error: null, refresh: async () => {}, update: () => {} }}
    >
      <BadgeNotificationProvider>
        <RoomNotice />
      </BadgeNotificationProvider>
    </AccountContext.Provider>,
  );
  act(() =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "通知追加")!.click(),
  );
  expect(document.body.textContent).toContain("ルームのお知らせ");
  clock.advance(2999);
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).not.toBe("true");
  clock.advance(1);
  await flush();
  expect(document.querySelector(".toast")?.getAttribute("data-exiting")).toBe("true");
});
