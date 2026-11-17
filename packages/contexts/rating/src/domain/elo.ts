import { eloPolicy, placementGames } from "./policy";
export interface EloArithmetic<T> {
  number(value: number): T;
  add(a: T, b: T): T;
  subtract(a: T, b: T): T;
  multiply(a: T, b: T): T;
  divide(a: T, b: T): T;
  power(a: T, b: T): T;
}
// D1 の遅延計算とメモリの計算で、式と演算の順序を共有します。
export function eloCalculation<T>(math: EloArithmetic<T>, rating: T, opponent: T, score: T, k: T) {
  const expected = math.divide(
    math.number(1),
    math.add(
      math.number(1),
      math.power(
        math.number(10),
        math.divide(math.subtract(opponent, rating), math.number(eloPolicy.scale)),
      ),
    ),
  );
  return math.add(rating, math.multiply(k, math.subtract(score, expected)));
}
const arithmetic: EloArithmetic<number> = {
  number: (value) => value,
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => a / b,
  power: (a, b) => a ** b,
};
export function calculateElo(
  rating: number,
  opponent: number,
  score: number,
  games: number,
  kind: "human" | "cpu",
) {
  const k = eloPolicy[kind][games < placementGames ? "placement" : "rated"];
  return eloCalculation(arithmetic, rating, opponent, score, k);
}
