import { AppDialog, type AppDialogProps } from "../../shared/ui/AppDialog";

// 本文のCSS移行が完了するまで、既存のスコープを引き継ぎます。
export function LobbyDialog(
  props: Pick<AppDialogProps, "title" | "busy" | "onClose" | "children">,
) {
  return <AppDialog {...props} size="default" legacyScope="four-reversi-lobby" />;
}
