import { ListBox, Select } from "@heroui/react";
import { type MatchGame } from "@tetraboard/protocol";

export function GameSelect({
  label,
  game,
  onChange,
}: {
  label: string;
  game: MatchGame;
  onChange: (game: MatchGame) => void;
}) {
  return (
    <Select
      aria-label={label}
      value={game}
      className="w-full min-w-0"
      onChange={(key) => {
        if (key === "four-reversi" || key === "four-shogi") onChange(key);
      }}
    >
      <Select.Trigger className="w-full min-w-0 min-h-11 bg-surface-muted text-sm">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover className="app-theme bg-white text-ink text-sm">
        <ListBox>
          <ListBox.Item id="four-reversi" textValue="四人リバーシ" className="min-h-11">
            四人リバーシ
            <ListBox.ItemIndicator />
          </ListBox.Item>
          <ListBox.Item id="four-shogi" textValue="四人将棋" className="min-h-11">
            四人将棋
            <ListBox.ItemIndicator />
          </ListBox.Item>
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
