import { badgeDefinitions } from "@tetraboard/protocol";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { BadgeImage } from "../badges/BadgeImage";
import { AppIcon } from "../../shared/ui/AppIcon";

export function RegistrationBenefits() {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0 text-left">
      {[
        {
          icon: "crown",
          title: "バッジを集めよう",
          text: "対人シングルスの対局数や優勝数に応じて、バッジを獲得できます。",
        },
        {
          icon: "users",
          title: "自分の戦績を残そう",
          text: "対人戦の成績を確認し、ランキングに参加できます。",
        },
        {
          icon: "board",
          title: "棋譜を振り返ろう",
          text: "アカウントで参加した対局を、マイページから見返せます。CPU戦も保存されます。",
        },
      ].map(({ icon, title, text }) => (
        <li key={title} className="flex items-start gap-2.5">
          <AppIcon name={icon as "crown" | "users" | "board"} className="mt-0.5 text-primary" />
          <div className="min-w-0">
            <strong className="block text-sm">{title}</strong>
            <p className="m-0 text-xs leading-relaxed text-muted">{text}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RegistrationBadgeExamples({ game }: { game: GameId }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-1">
      <div className="flex gap-2">
        {(["games", "wins"] as const).map((id) => (
          <span
            key={id}
            role="img"
            aria-label={`${gameCatalog[game].name}・${badgeDefinitions[id].name}・星1の例`}
          >
            <BadgeImage game={game} id={id} tier={1} value={0} size={56} />
          </span>
        ))}
      </div>
      <figcaption className="text-[11px] text-muted">獲得できるバッジの例</figcaption>
    </figure>
  );
}
