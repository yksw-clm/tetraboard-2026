import { useId } from "react";
import type { GameId } from "@tetraboard/protocol/games";
import { getBadgeIds } from "@tetraboard/protocol";
import { BadgeImage } from "../badges/BadgeImage";
import { SocialSignInButtons } from "./SocialSignInButtons";
import type { SocialProvider } from "./useSocialSignIn";

export function GuestResultLinkCard({
  game,
  humanOnly,
  busy,
  pendingProvider,
  error,
  onLink,
}: {
  game: GameId;
  humanOnly: boolean;
  busy: boolean;
  pendingProvider: SocialProvider | null;
  error: string | null;
  onLink: (provider: SocialProvider) => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="mt-4 flex flex-col gap-3 rounded-panel border border-solid border-line bg-surface-muted p-3.5"
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="m-0 text-base font-bold">
            アカウントを連携しよう
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {humanOnly
              ? "GoogleまたはDiscordと連携すると、これまでの戦績・棋譜・獲得したバッジを引き継げます。"
              : "GoogleまたはDiscordと連携すると、別端末でも同じアカウントで遊べ、バッジ、戦績など各種機能をご利用いただけます。"}
          </p>
        </div>
        {humanOnly && getBadgeIds(game).includes("games") && (
          <figure className="m-0 shrink-0 text-center">
            <BadgeImage game={game} id="games" tier={1} value={0} size={52} />
            <figcaption className="text-[11px] text-muted">バッジの例</figcaption>
          </figure>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <SocialSignInButtons
        busy={busy}
        pendingProvider={pendingProvider}
        consentBelowButtons
        onSignIn={onLink}
      />
    </section>
  );
}
