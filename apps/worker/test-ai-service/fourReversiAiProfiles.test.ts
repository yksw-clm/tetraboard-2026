import { test } from "vitest";
import { FourReversiAiFixture } from "./fourReversiAiFixture";

const { completeGame } = new FourReversiAiFixture();

for (const profile of ["lv1-v1", "lv2-v1", "lv3-v1", "lv4-v1", "lv5-v1"])
  test(
    `API v2の${profile}をGameRoomから指定し、復元を挟んで完走する`,
    () =>
      completeGame(2, {
        profile_id: profile,
        ...(profile === "lv4-v1" || profile === "lv5-v1"
          ? { limits: { max_iterations: 4, max_nodes: 256 } }
          : {}),
      }),
    20000,
  );
