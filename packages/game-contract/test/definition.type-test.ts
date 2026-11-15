import type { GameDefinition } from "@tetraboard/game-contract";

interface ExampleTypes {
  state: number;
  seat: "player";
  action: { amount: number };
  event: { amount: number };
  settings: { initial: number };
  result: { total: number };
  rejection: "negative_amount";
  cpuLevel: 1;
}

declare const definition: GameDefinition<ExampleTypes, "example">;
// @ts-expect-error ゲームIDのリテラル型を維持します。
export const wrongId: "another-game" = definition.catalog.id;
// @ts-expect-error 席の型を取り違えられません。
definition.cpu.chooseAction(0, "another-player", 1, () => 0);
// @ts-expect-error 別のゲームの操作を渡せません。
definition.rules.applyAction(0, "player", { position: { x: 0, y: 0 } });
// @ts-expect-error 着手する席の型を取り違えられません。
definition.rules.applyAction(0, "another-player", { amount: 1 });
// @ts-expect-error 着手する席は省略できません。
definition.rules.applyAction(0, { amount: 1 });
// @ts-expect-error 脱落理由は共通の4種類に限定します。
definition.rules.eliminateSeat(0, "player", "unknown");
