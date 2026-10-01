import { Button, Card, ListBox, Select } from "@heroui/react";
import { type useRoomReplay } from "./useRoomReplay";

export function ReplayCard({ replay }: { replay: ReturnType<typeof useRoomReplay> }) {
  return (
    <Card className="room-replay" aria-label="棋譜">
      <Button
        isIconOnly
        variant="ghost"
        aria-label="棋譜を1つ戻る"
        isDisabled={replay.index <= 0}
        onPress={() => replay.select(replay.index - 1)}
      >
        ←
      </Button>
      <Select
        aria-label="棋譜の局面"
        className="room-replay-select"
        value={String(replay.index)}
        onChange={(key) => replay.select(Number(key))}
      >
        <Select.Trigger>
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover className="room-replay-popover" placement="top">
          <ListBox>
            {replay.frames.map((frame, index) => (
              <ListBox.Item key={index} id={String(index)} textValue={frame.label}>
                {frame.label}
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
      <Button
        isIconOnly
        variant="ghost"
        aria-label="棋譜を1つ進む"
        isDisabled={replay.index >= replay.frames.length - 1}
        onPress={() => replay.select(replay.index + 1)}
      >
        →
      </Button>
    </Card>
  );
}
