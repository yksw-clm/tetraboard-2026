import { ListBox, Select } from "@heroui/react";
import { gameCatalog, gameIds, isGameId, type GameId } from "@tetraboard/protocol/games";
import { AppSelectTrigger } from "./AppSelectTrigger";

export function GameSelect({
  label,
  game,
  onChange,
}: {
  label: string;
  game: GameId;
  onChange: (game: GameId) => void;
}) {
  return (
    <Select
      aria-label={label}
      value={game}
      className="w-full min-w-0"
      onChange={(key) => {
        if (isGameId(key)) onChange(key);
      }}
    >
      <AppSelectTrigger>
        <Select.Value />
        <Select.Indicator />
      </AppSelectTrigger>
      <Select.Popover className="app-theme bg-white text-ink text-sm">
        <ListBox>
          {gameIds.map((id) => (
            <ListBox.Item key={id} id={id} textValue={gameCatalog[id].name} className="min-h-11">
              {gameCatalog[id].name}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}
