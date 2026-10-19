import { expect, test } from "bun:test";
import { Acquisition, acquisitionCoverage } from "../src/Acquisition";
import { render } from "../../web/test-dom/support";
import type { AcquisitionReport } from "@tetraboard/protocol";

const collected = Date.parse("2026-10-15T12:00:00+09:00"),
  asOf = Date.parse("2026-10-19T12:00:00+09:00");
test("日別・月別は未計測と初日・当日の途中集計を区別する", () => {
  expect(acquisitionCoverage("2026-10-14", collected, asOf)).toBe("未計測");
  expect(acquisitionCoverage("2026-10-15", collected, asOf)).toBe("途中集計");
  expect(acquisitionCoverage("2026-10-16", collected, asOf)).toBe("");
  expect(acquisitionCoverage("2026-10-19", collected, asOf)).toBe("途中集計");
  expect(acquisitionCoverage("2026-10-20", collected, asOf)).toBe("未計測");
  expect(acquisitionCoverage("2026-09", collected, asOf)).toBe("未計測");
  expect(acquisitionCoverage("2026-10", collected, asOf)).toBe("途中集計");
  expect(acquisitionCoverage("2026-10", null, asOf)).toBe("未計測");
});
test("3表に期間合計・各期間・UTM3項目・不明を表示し、実測0を未計測と混同しない", () => {
  const rows: AcquisitionReport["summary"] = [
    { dimension: "referrer", value: "social", medium: "", campaign: "", visits: 7, started: 2 },
    {
      dimension: "utm",
      value: "x",
      medium: "social",
      campaign: "20261015_event",
      visits: 7,
      started: 2,
    },
    { dimension: "device", value: "", medium: "", campaign: "", visits: 1, started: 0 },
  ];
  const report: AcquisitionReport = {
    collectedFromMs: collected,
    summary: rows,
    buckets: [
      { period: "2026-10-14", rows: [] },
      { period: "2026-10-15", rows },
      { period: "2026-10-16", rows: [] },
    ],
  };
  const view = render(<Acquisition report={report} asOf={asOf} />);
  expect(view.querySelectorAll("table")).toHaveLength(3);
  expect(view.textContent).toContain("訪問セッション数");
  expect(view.textContent).toContain("合計は全体の開始対局数と一致しません");
  expect(view.textContent).toContain("20261015_event");
  expect(view.textContent).toContain("不明");
  expect(
    [...view.querySelectorAll("tbody tr")]
      .filter((row) => row.textContent?.includes("2026-10-14"))
      .every((row) => row.textContent?.includes("未計測")),
  ).toBe(true);
  expect(
    [...view.querySelectorAll("tbody tr")]
      .filter((row) => row.textContent?.includes("2026-10-16"))
      .every((row) => row.textContent?.includes("0件")),
  ).toBe(true);
  expect(
    [...view.querySelectorAll("tbody tr")]
      .filter((row) => row.textContent?.includes("2026-10-15"))
      .every((row) => row.textContent?.includes("途中集計")),
  ).toBe(true);
});
test("対象期間の全てが計測開始前なら合計にも0を出さず、旧Workerでも未計測を案内する", () => {
  const report: AcquisitionReport = {
    collectedFromMs: collected,
    summary: [],
    buckets: [{ period: "2026-10-14", rows: [] }],
  };
  const view = render(<Acquisition report={report} asOf={asOf} />);
  expect(view.textContent).not.toContain("0件");
  expect(view.textContent).toContain("選択期間の合計未計測");
  expect(render(<Acquisition report={undefined} asOf={asOf} />).textContent).toContain("未計測");
});
