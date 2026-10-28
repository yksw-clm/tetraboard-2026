import type { Side } from "@tetraboard/four-shogi";
import { sideNames, sideOrder } from "./presentation";
import { Field, fieldClass } from "./ui";

export function FocusSelector({
  side,
  pending,
  onChange,
}: {
  side: Side | null;
  pending: boolean;
  onChange(side: Side | null): void;
}) {
  return (
    <Field
      label="フォーカスする席"
      help="相手の予測手順をたどり、指定した人の次の実手番で指す手を検討します。"
    >
      <select
        className={fieldClass}
        value={side ?? "none"}
        disabled={pending}
        onChange={(event) =>
          onChange(event.target.value === "none" ? null : (event.target.value as Side))
        }
      >
        <option value="none">通常（現在の手番を検討）</option>
        {sideOrder.map((value) => (
          <option key={value} value={value}>
            {sideNames[value]}のプレイヤー
          </option>
        ))}
      </select>
    </Field>
  );
}
