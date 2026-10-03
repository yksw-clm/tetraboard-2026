import { useState } from "react";
import { nextRotation, type QuarterTurn } from "./boardRotation";

export function useBoardRotation() {
  const [rotation, setRotation] = useState<QuarterTurn>(0);
  return { rotation, rotate: () => setRotation(nextRotation) };
}
