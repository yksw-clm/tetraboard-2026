import { AppIcon } from "../../shared/ui/AppIcon";
import { AccountLinkDialog } from "../account/AccountLinkDialog";
import type { RegistrationDestination } from "../account/registrationReturn";

export function BoardLinkDialog({
  destination,
  onClose,
}: {
  destination: RegistrationDestination;
  onClose: () => void;
}) {
  return (
    <AccountLinkDialog
      title="掲示板のアカウント連携"
      introduction={
        <>
          <div aria-hidden="true" className="flex items-center justify-center gap-2 py-2">
            <AppIcon
              name="chat"
              className="size-9 text-brand motion-safe:[animation:board-link-bounce_420ms_ease-in-out]"
            />
            <AppIcon
              name="heart"
              fill="currentColor"
              className="size-6 text-danger motion-safe:[animation:board-link-bounce_420ms_ease-in-out_80ms]"
            />
          </div>
          <div className="grid gap-2 text-center">
            <h3 className="text-lg font-bold">
              <span className="inline-block">アカウントを連携して、</span>
              <wbr />
              <span className="inline-block">掲示板を楽しもう！</span>
            </h3>
            <p className="text-sm leading-relaxed">連携すると、投稿・返信・いいねができます。</p>
          </div>
        </>
      }
      beforeSignInNotice={
        destination.boardDraft ? "連携後も、入力した内容から続けられます。" : undefined
      }
      destination={destination}
      cancelLabel="キャンセル"
      onClose={onClose}
    />
  );
}
