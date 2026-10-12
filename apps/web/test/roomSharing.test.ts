import { expect, test } from "bun:test";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import {
  recruitmentUnavailable,
  roomRecruitmentIntent,
  roomRecruitmentText,
  roomShareMetadata,
  roomSharePath,
} from "@tetraboard/protocol/room-sharing";

test("全6ゲームの募集文は4行と日本語ハッシュタグ、同じ世代付きURLを保持する", () => {
  const room = { id: "01234", instanceId: "00000000-0000-4000-8000-000000000001" };
  const url = `https://tetraboard.net${roomSharePath(room)}`;
  for (const game of gameIds) {
    const name = gameCatalog[game].name;
    const text = roomRecruitmentText(game, url);
    expect(text.split("\n")).toEqual([
      `${name}の対戦相手を募集中！`,
      "ブラウザですぐ遊べます。気軽に参加してください！",
      url,
      `#${name} #TetraBoard`,
    ]);
    const intent = new URL(roomRecruitmentIntent(game, url));
    expect(intent.origin + intent.pathname).toBe("https://x.com/intent/tweet");
    expect(intent.searchParams.get("text")).toBe(text);
    expect([...intent.searchParams.keys()]).toEqual(["text"]);
  }
});

test("全6ゲームは空席がある待機中だけ募集でき、対局中を満室より優先する", () => {
  for (const game of gameIds) {
    const capacity = gameCatalog[game].capacity;
    const room = {
      settings: { game },
      players: Array(capacity - 1).fill(null),
      status: "waiting" as const,
    };
    expect(recruitmentUnavailable(room)).toBeNull();
    expect(recruitmentUnavailable({ ...room, players: Array(capacity).fill(null) })).toBe(
      "満室のため、現在は参加できません",
    );
    expect(recruitmentUnavailable({ ...room, status: "playing" })).toBe(
      "対局中のため、現在は観戦のみできます",
    );
  }
});

test("共有カードは全ゲームの画像と環境ごとの絶対URL、共通カードを生成する", () => {
  for (const origin of [
    "https://tetraboard.net",
    "https://tetraboard-dev.chaossi-lab.workers.dev",
  ]) {
    for (const game of gameIds) {
      const room = { id: "12345", instanceId: "instance", settings: { game } };
      const metadata = roomShareMetadata(origin, room);
      const tags = Object.fromEntries(metadata.tags.map((tag) => [tag.key, tag.value]));
      expect(metadata.title).toBe(`${gameCatalog[game].name}のルーム | TetraBoard`);
      expect(tags["og:url"]).toBe(`${origin}/rooms/12345?invite=instance`);
      expect(tags["og:image"]).toBe(`${origin}/assets/ogp/${game}.png`);
      expect(tags["twitter:image"]).toBe(tags["og:image"]);
      expect(tags["twitter:card"]).toBe("summary_large_image");
      expect(tags["og:image:alt"]).toContain(gameCatalog[game].name);
      expect(tags["og:description"]).not.toContain("募集中");
    }
    const fallback = roomShareMetadata(origin, null);
    expect(fallback.tags.find((tag) => tag.key === "og:image")?.value).toBe(
      `${origin}/assets/ogp/tetraboard.png`,
    );
  }
});

test("配信する画像7枚は1200×630のPNGで5MB未満", async () => {
  for (const game of [...gameIds, "tetraboard"]) {
    const bytes = await Bun.file(
      new URL(`../public/assets/ogp/${game}.png`, import.meta.url),
    ).arrayBuffer();
    expect([...new Uint8Array(bytes, 0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(bytes);
    expect(header.getUint32(16)).toBe(1200);
    expect(header.getUint32(20)).toBe(630);
    expect(bytes.byteLength).toBeLessThan(5 * 1024 * 1024);
  }
});
