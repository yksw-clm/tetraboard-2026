import { expect, test, vi } from "vitest";
import { TransactionUsageEvents } from "../src/usageEvents/transactionEvents";

const event = {
  name: "match_ended",
  isTest: false,
  game: "reversi",
  matchId: "match",
  result: "completed",
  reason: "unknown",
  durationMs: 1,
} as const;
function fixture() {
  const writeDataPoint = vi.fn(() => {});
  const buffer = new TransactionUsageEvents(
    () => ({ writeDataPoint }) as unknown as AnalyticsEngineDataset,
  );
  return { buffer, writeDataPoint };
}

test("確定まで書かず、例外なら捨てる。transaction外では直ちに書く", () => {
  const { buffer, writeDataPoint } = fixture();
  expect(() =>
    buffer.run(() => {
      buffer.writer().write(event);
      expect(writeDataPoint).not.toHaveBeenCalled();
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(writeDataPoint).not.toHaveBeenCalled();
  buffer.run(() => {
    buffer.writer().write(event);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  buffer.writer().write(event);
  expect(writeDataPoint).toHaveBeenCalledTimes(2);
});

test("内側の確定は外側の確定まで待ち、内側と外側それぞれの巻き戻しを守る", () => {
  const { buffer, writeDataPoint } = fixture();
  buffer.run(() => {
    buffer.writer().write(event);
    expect(() =>
      buffer.run(() => {
        buffer.writer().write(event);
        throw new Error("inner rollback");
      }),
    ).toThrow();
    buffer.run(() => buffer.writer().write(event));
    expect(writeDataPoint).not.toHaveBeenCalled();
  });
  expect(writeDataPoint).toHaveBeenCalledTimes(2);
  expect(() =>
    buffer.run(() => {
      buffer.run(() => buffer.writer().write(event));
      throw new Error("outer rollback");
    }),
  ).toThrow();
  expect(writeDataPoint).toHaveBeenCalledTimes(2);
});

test("一回の処理の250件上限を保ち、次の処理では改めて書ける", () => {
  const { buffer, writeDataPoint } = fixture();
  buffer.run(() => {
    const writer = buffer.writer();
    for (let i = 0; i < 300; i++) writer.write(event);
    buffer.writer().write(event);
  });
  expect(writeDataPoint).toHaveBeenCalledTimes(250);
  buffer.run(() => buffer.writer().write(event));
  expect(writeDataPoint).toHaveBeenCalledTimes(251);
});
