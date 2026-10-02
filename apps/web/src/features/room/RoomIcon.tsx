import { AppIcon, type AppIconName } from "../../shared/ui/AppIcon";

// ページ側の寸法指定は、そのページの移行時にTailwindへ置き換えます。
export function RoomIcon({ name }: { name: AppIconName }) {
  return <AppIcon name={name} className="room-icon" />;
}
