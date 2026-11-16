import { AppButton } from "../../shared/ui/AppButton";
import { preloadRecovery } from "../../shared/preloadRecovery";
import { roomReloadMessage } from "../../shared/roomResponseValidation";

export function RoomReloadNotice() {
  return (
    <div
      role="alert"
      className="relative z-[110001] flex shrink-0 flex-wrap items-center justify-center gap-2 rounded-lg bg-[#fff4dc] px-4 py-2 text-center text-xs text-[#755b21]"
    >
      <span>{roomReloadMessage}</span>
      <AppButton size="compact" appearance="secondary" onPress={() => preloadRecovery.reload()}>
        再読み込み
      </AppButton>
    </div>
  );
}
