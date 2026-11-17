import { expect, test } from "bun:test";
import { publicMatchDetailSchema } from "@tetraboard/protocol";
import { ResultShareButton } from "../src/features/room/ResultShareButton";
import { reversiArchives } from "../../../test-fixtures/matches";
import { render, rerender, requests, flush, clock, press, wrap } from "./harness";

const fixture = () => parsePublic(reversiArchives[0]!.detail);
test("共有準備後に勝者・敗者に応じたXロゴ付きボタンを表示する", async () => {
  const match = fixture();
  for (const marker of ["blue", "black"] as const) {
    const self = match.participants.find((p) => "color" in p && p.color === marker)!;
    const view = render(wrap()(<ResultShareButton matchId={match.id} selfId={self.id} />));
    expect(view.querySelector("a")).toBeNull();
    requests.at(-1)!.respond({ match });
    await flush();
    const link = view.querySelector("a")!;
    expect(link.textContent).toBe(marker === "blue" ? "フォロワーに自慢する" : "結果をポストする");
    expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(link.target).toBe("_blank");
    expect(new URL(link.href).searchParams.get("text")).toContain(`/matches/${match.id}`);
  }
});
test("保存待ちは再照会し、失敗は手動再試行で復帰する", async () => {
  const match = fixture();
  const view = render(
    wrap()(<ResultShareButton matchId={match.id} selfId={match.participants[0]!.id} />),
  );
  requests[0]!.respond({}, 404);
  await flush();
  expect(view.textContent).toContain("棋譜の保存");
  clock.advance(5000);
  requests[1]!.respond({}, 503);
  await flush();
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  press(view, "共有の準備を再試行");
  requests[2]!.respond({ match });
  await flush();
  expect(view.querySelector("a")).not.toBeNull();
});
test("他人の結果を共有せず、対局切替後の遅延応答を捨てる", async () => {
  const match = fixture();
  const view = render(
    wrap()(<ResultShareButton matchId={match.id} selfId={match.participants[0]!.id} />),
  );
  const old = requests[0]!;
  const nextId = "00000000-0000-4000-8000-000000000099";
  rerender(view, wrap()(<ResultShareButton matchId={nextId} selfId={match.participants[0]!.id} />));
  old.respond({ match });
  await flush();
  expect(old.init.signal!.aborted).toBe(true);
  expect(view.querySelector("a")).toBeNull();
  const nextMatch = structuredClone(match);
  nextMatch.id = nextId;
  if ("id" in nextMatch.replay) nextMatch.replay.id = nextId;
  requests[1]!.respond({ match: nextMatch });
  await flush();
  expect(view.querySelector("a")).not.toBeNull();
  expect(requests).toHaveLength(2);
  const other = render(wrap()(<ResultShareButton matchId={match.id} selfId="spectator" />));
  requests.at(-1)!.respond({ match });
  await flush();
  expect(other.querySelector("a")).toBeNull();
});

function parsePublic(value: object) {
  const copy = { ...value };
  Reflect.deleteProperty(copy, "selfPlayerId");
  return publicMatchDetailSchema.parse(copy);
}
