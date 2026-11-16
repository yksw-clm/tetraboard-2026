import type { GameId, RoomFor } from "@tetraboard/protocol";
import { gameAdapters, type GameAdapterRegistration } from "../src/rooms/gameAdapters";
import type { AdapterDependencies, GameAdapter } from "../src/rooms/gameAdapters/types";
import type { FinishedProgress } from "../src/rooms/gameProgress";

declare const missingOne: {
  [G in GameId]: Omit<typeof gameAdapters, G>;
}[GameId];
// @ts-expect-error 6ゲームのどれが欠けても登録表として受け付けません。
export const incompleteAdapters: GameAdapterRegistration = missingOne;
// @ts-expect-error ゲームIDとアダプターの対応を取り違えられません。
export const wrongAdapter: GameAdapterRegistration["four-shogi"] = gameAdapters.reversi;
export const completeAdapters: GameAdapterRegistration = gameAdapters;

declare const missingCpu: {
  [G in GameId]: Omit<typeof gameAdapters, G> & {
    [K in G]: { create: (dependencies: AdapterDependencies) => Omit<GameAdapter<K>, "cpu"> };
  };
}[GameId];
// @ts-expect-error CPU の定義を省いたアダプターは登録できません。
export const incompleteCpuAdapters: GameAdapterRegistration = missingCpu;

declare const dependencies: AdapterDependencies;
declare const reversi: RoomFor<"reversi">;
declare const shogi: RoomFor<"four-shogi">;
declare const shogiFinished: FinishedProgress<"four-shogi">;
declare const retainReversi: (
  players: RoomFor<"reversi">["players"],
  at: number,
) => RoomFor<"reversi">["players"];
const adapter: GameAdapter<"reversi"> = gameAdapters.reversi.create(dependencies);
// @ts-expect-error アダプターへ別ゲームのルームを渡せません。
adapter.resign(shogi, "hash");
// @ts-expect-error CPU の入口でも別ゲームのルームを渡せません。
adapter.cpu.currentCpu(shogi);
// @ts-expect-error 終局結果とアダプターのゲームを取り違えられません。
adapter.finish(shogiFinished, retainReversi);
// @ts-expect-error 将棋のアダプターへリバーシのルームを渡せません。
gameAdapters["four-shogi"].create(dependencies).normalize(reversi, {});
