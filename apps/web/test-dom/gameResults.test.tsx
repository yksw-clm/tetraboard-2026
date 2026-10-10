import { expect, test } from "bun:test";
import { fourReversiMatchDetailSchema, type FourShogiLastRound } from "@tetraboard/protocol";
import { reversiArchives } from "../../../test-fixtures/matches";
import { GameResultView } from "../src/features/room/GameResultView";
import { FourShogiGameResultView } from "../src/features/room/FourShogiGameResultView";
import { PlayerAvatar } from "../src/features/room/PlayerAvatar";
import { resultPlayer } from "../src/features/room/gameResultPresentation";
import { playerAppearance } from "../src/features/room/roomCommonPresentation";
import { simultaneousMateFrames } from "../test/fixtures/shogiKnockouts";
import { waitingShogiRoom, shogiRoundId } from "../test/fixtures/fourShogiFixtures";
import { render, rerender, press, act, flush } from "./harness";

const avatarUrl = "/api/avatars/00000000-0000-4000-8000-000000000099";
function shogiResult(mode: "singles" | "doubles" = "singles") {
  const frames = simultaneousMateFrames(mode);
  const game = frames.at(-1)!.game;
  if (game.status !== "finished") throw new Error("Expected final result");
  const room = waitingShogiRoom();
  const lastRound: FourShogiLastRound = {
    roundId: shogiRoundId,
    game,
    eventCount: frames.length - 1,
    players: room.players.map((player, index) => ({
      id: player.id,
      name: ["優勝者", "同じ名前", "同じ名前", "CPU Lv2"][index]!,
      side: ["south", "west", "north", "east"][index] as "south" | "west" | "north" | "east",
      appearance:
        index === 3
          ? { kind: "cpu", level: 2 }
          : { kind: "human", avatarUrl: index === 1 ? avatarUrl : null },
    })),
  };
  return { lastRound, replay: { frames, loading: false, error: null } };
}
test("将棋は各人の右欄に撃破対象のアイコン・名前をIDで対応付け、順位に理由を付けない", () => {
  const props = shogiResult();
  const view = render(<FourShogiGameResultView {...props} />);
  const rows = view.querySelectorAll("li");
  expect(rows).toHaveLength(4);
  expect([...rows].map((row) => row.querySelector('[data-slot="chip"]')?.textContent)).toEqual([
    "1位",
    "2位",
    "3位",
    "3位",
  ]);
  const targets = rows[0]!.querySelector('[aria-label="撃破したプレイヤー"]')!;
  expect(
    [...targets.querySelectorAll("[data-player-id]")].map((entry) =>
      entry.getAttribute("data-player-id"),
    ),
  ).toEqual(props.lastRound.players.slice(1, 3).map((p) => p.id));
  expect(targets.querySelectorAll('[data-testid="player-avatar"]')).toHaveLength(2);
  expect(targets.textContent).toContain("同じ名前");
  expect(rows[1]!.textContent).toContain("なし");
  expect(view.textContent).not.toContain("撃破：");
  expect(
    [...view.querySelectorAll("span")].filter((span) => span.textContent === "撃破"),
  ).toHaveLength(1);
  expect(view.textContent).not.toContain("（");
  expect(view.textContent).toContain("南");
  expect([...rows[0]!.children[0]!.children].map((entry) => entry.textContent)).toEqual([
    "1位",
    "南",
    "優勝者",
  ]);
  expect(rows[1]!.querySelector('[title="CPU"]')).not.toBeNull();
  expect(rows[0]!.children[1]).toBe(targets);
});
test("将棋の読込中・失敗は撃破なしと区別し、順位を残して再試行できる", () => {
  const props = shogiResult();
  const view = render(
    <FourShogiGameResultView {...props} replay={{ frames: [], loading: true, error: null }} />,
  );
  expect(view.textContent).toContain("1位");
  expect(view.textContent).toContain("読み込み中");
  expect(view.textContent).not.toContain("なし");
  let retries = 0;
  rerender(
    view,
    <FourShogiGameResultView
      {...props}
      replay={{
        frames: [],
        loading: false,
        error: "失敗",
        retry: () => {
          retries++;
        },
      }}
    />,
  );
  expect(view.querySelector('[role="alert"]')).not.toBeNull();
  press(view.querySelector("li")!, "再試行");
  expect(retries).toBe(1);
  rerender(view, <FourShogiGameResultView {...props} />);
  expect(view.textContent).not.toContain("取得できません");
  expect(view.querySelectorAll('[aria-label="撃破したプレイヤー"] [data-player-id]')).toHaveLength(
    2,
  );
});
test("将棋ダブルスはチーム別の勝敗と撃破対象を表示し、個人順位を付けない", () => {
  const view = render(<FourShogiGameResultView {...shogiResult("doubles")} />);
  expect([...view.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
    "南・北チーム：勝利",
    "西・東チーム：敗北",
  ]);
  expect(view.querySelectorAll("li")).toHaveLength(4);
  expect(
    [...view.querySelector("li")!.children[0]!.children].map((entry) => entry.textContent),
  ).toEqual(["南", "優勝者"]);
  expect(view.querySelectorAll('[aria-label="撃破したプレイヤー"] [data-player-id]')).toHaveLength(
    2,
  );
  expect(view.textContent).not.toContain("位");
  expect(view.textContent).not.toContain("撃破：");
  for (const team of view.querySelectorAll(
    'section[aria-label$="勝利"], section[aria-label$="敗北"]',
  )) {
    expect(
      [...team.querySelectorAll("span")].filter((span) => span.textContent === "撃破"),
    ).toHaveLength(1);
  }
});
for (const count of [0, 1, 2, 3]) {
  test(`撃破${count}人は相手全員のIDと省略しない名前を表示する`, () => {
    const props = shogiResult();
    const names = ["長いプレイヤー名を省略せず表示", "同じ名前", "同じ名前", "CPU Lv2"];
    props.lastRound.players.forEach((player, index) => {
      player.name = names[index]!;
    });
    // 表示用の確定局面を渡し、詰みと対象外の脱落を切り替えます。
    const final = props.replay.frames.at(-1)!;
    const eliminated = final.game.eliminations.map((entry, index) => ({
      ...entry,
      reason: index < count ? ("checkmate" as const) : ("no_legal_actions" as const),
    }));
    props.replay.frames = [
      props.replay.frames[0]!,
      {
        ...final,
        event: props.replay.frames[1]!.event,
        game: { ...final.game, eliminations: eliminated },
      },
    ];
    const view = render(<FourShogiGameResultView {...props} />);
    const winner = view.querySelector("li")!;
    expect(winner.querySelector("[data-player-id]")!.textContent).toBe(names[0]);
    const targets = winner.querySelector('[aria-label="撃破したプレイヤー"]')!;
    expect(
      [...targets.querySelectorAll("[data-player-id]")].map((entry) =>
        entry.getAttribute("data-player-id"),
      ),
    ).toEqual(
      eliminated
        .slice(0, count)
        .map((entry) => props.lastRound.players.find((player) => player.side === entry.side)!.id),
    );
    expect(
      [...targets.querySelectorAll("[data-player-id]")].map((entry) => entry.textContent),
    ).toEqual(
      eliminated
        .slice(0, count)
        .map((entry) => props.lastRound.players.find((player) => player.side === entry.side)!.name),
    );
    expect(targets.textContent).toContain(count === 0 ? "なし" : names[1]!);
  });
}
test("リバーシは石色・石数と脱落者を保持し、ダブルスは4人とチーム勝敗を表示", () => {
  for (const fixture of reversiArchives) {
    const match = fourReversiMatchDetailSchema.parse(fixture.detail);
    const lastRound = {
      game: match.game,
      players: match.participants.map((player) => ({
        ...player,
        appearance: playerAppearance(player),
      })),
      replay: match.replay,
    };
    const view = render(<GameResultView lastRound={lastRound} />);
    expect(view.querySelectorAll("li")).toHaveLength(4);
    expect(view.querySelectorAll('[data-testid="player-avatar"]')).toHaveLength(4);
    for (const player of match.participants) {
      const row = [...view.querySelectorAll("li")].find((li) =>
        li.querySelector(`[data-player-id="${player.id}"]`),
      )!;
      const count = row.querySelector('[data-testid="player-stone-count"]')!;
      const participant = row.querySelector("[data-player-id]")!;
      expect(
        count.compareDocumentPosition(participant) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
      const rank = row.querySelector('[data-slot="chip"]');
      if (rank)
        expect(rank.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      if (match.game.eliminatedColors.includes(player.color)) {
        expect(count.textContent).toBe("");
        expect(row.textContent).toContain("脱落");
      } else expect(count.getAttribute("aria-label")).toContain("石");
    }
    if (match.game.result.mode === "doubles") {
      expect(view.querySelectorAll("h3")).toHaveLength(2);
      expect(view.textContent).not.toContain("位");
    }
  }
});
test("旧結果は同じIDの在室者だけで画像を補い、保存された画像を優先する", () => {
  const current = waitingShogiRoom().players;
  const human = current[0]!;
  if (human.kind !== "human") throw new Error("Expected human");
  human.avatarUrl = avatarUrl;
  const old = { id: human.id, name: "当時の名前" };
  expect(resultPlayer(old, current)).toEqual({ ...old, appearance: { kind: "human", avatarUrl } });
  expect(resultPlayer({ ...old, id: "退室者" }, current).appearance).toBeUndefined();
  expect(
    resultPlayer({ ...old, appearance: { kind: "human", avatarUrl: null } }, current).appearance,
  ).toEqual({ kind: "human", avatarUrl: null });
});
test("アバターは人間の画像と失敗時の仮アイコン、CPUの識別を共通表示する", async () => {
  const images: HTMLImageElement[] = [];
  const NativeImage = window.Image;
  window.Image = class extends NativeImage {
    constructor(width?: number, height?: number) {
      super(width, height);
      images.push(this);
    }
  };
  try {
    const view = render(
      <PlayerAvatar appearance={{ kind: "human", avatarUrl }} className="size-8" />,
    );
    expect(images.at(-1)!.src).toBe(new URL(avatarUrl, window.location.href).href);
    Object.defineProperties(images.at(-1)!, {
      complete: { value: true },
      naturalWidth: { value: 32 },
    });
    act(() => images.at(-1)!.dispatchEvent(new Event("load")));
    await flush();
    expect(view.querySelector("img")!.getAttribute("src")).toBe(avatarUrl);
    const otherUrl = "/api/avatars/00000000-0000-4000-8000-000000000088";
    rerender(view, <PlayerAvatar appearance={{ kind: "human", avatarUrl: otherUrl }} />);
    act(() => images.at(-1)!.dispatchEvent(new Event("error")));
    await flush();
    expect(view.querySelector('[data-slot="avatar-fallback"] svg')).not.toBeNull();
    rerender(view, <PlayerAvatar appearance={{ kind: "cpu", level: 2 }} />);
    expect(view.querySelector('[title="CPU"]')).not.toBeNull();
    expect(view.querySelector("img")).toBeNull();
  } finally {
    window.Image = NativeImage;
  }
});
