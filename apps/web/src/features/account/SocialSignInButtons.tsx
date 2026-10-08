import { AppButton } from "../../shared/ui/AppButton";

export function SocialSignInButtons({
  busy,
  isPending = false,
  onSignIn,
}: {
  busy: boolean;
  isPending?: boolean;
  onSignIn: () => void;
}) {
  return (
    <AppButton
      appearance="secondary"
      className="min-h-11 w-full border-[#747775] bg-white px-3 text-sm font-medium [font-family:Google_Sans,Arial,sans-serif] text-[#1f1f1f]"
      isDisabled={busy}
      isPending={isPending}
      onPress={onSignIn}
    >
      <span aria-hidden="true" className="relative size-5 shrink-0 overflow-hidden">
        <img
          src="/assets/auth/google.png"
          alt=""
          draggable={false}
          width={40}
          height={40}
          className="absolute -left-2.5 -top-2.5 size-10 max-w-none"
        />
      </span>
      Googleで続ける
    </AppButton>
  );
}
