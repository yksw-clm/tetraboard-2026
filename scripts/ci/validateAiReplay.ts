import { AnalysisInputError, validateAnalysisReplay } from "../../packages/four-shogi/src/analysis";

// Pythonの契約テストから同じ入力を照合します。ゲームの再生や探索は行いません。
const inputs: unknown = JSON.parse(await Bun.stdin.text());
if (!Array.isArray(inputs)) throw new Error("入力配列が必要です");
console.log(
  JSON.stringify(
    inputs.map((input: unknown) => {
      try {
        return { ok: true, replay: validateAnalysisReplay(input) };
      } catch (error) {
        if (!(error instanceof AnalysisInputError)) throw error;
        return { ok: false, code: error.code, eventIndex: error.eventIndex ?? null };
      }
    }),
  ),
);
