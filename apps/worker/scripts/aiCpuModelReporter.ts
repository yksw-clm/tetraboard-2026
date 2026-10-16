import type { Reporter } from "vitest/reporters";
/** 成功した実モデル検証の診断だけを測定用JSON行へ出力します。 */
export default class AiCpuModelReporter implements Reporter {
  onTestCaseResult(test: Parameters<NonNullable<Reporter["onTestCaseResult"]>>[0]) {
    for (const annotation of test.annotations()) {
      if (annotation.type === "ai-cpu-model")
        console.log("AI_CPU_MODEL_SMOKE " + annotation.message);
    }
  }
}
