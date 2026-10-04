import { Avatar, Badge, Chip, cn } from "@heroui/react";
import type { Room, MatchHistoryParticipant } from "@tetraboard/protocol";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { playerName } from "./roomCommonPresentation";
import { AppIcon } from "../../shared/ui/AppIcon";
import { AppCard } from "../../shared/ui/AppCard";
import { RoomClock, type RoomClockPresentation } from "./RoomClock";
const seatClasses = {
  top: "[grid-area:top]",
  bottom: "[grid-area:bottom]",
  left: "[grid-area:left]",
  right: "[grid-area:right]",
} as const;
const rankClasses = {
  1: "bg-[#fff0ba] text-[#896315]",
  2: "bg-[#e0edff] text-[#376597]",
  3: "bg-[#f5e5d9] text-[#99633d]",
  4: "bg-[#e9ecef] text-[#62717b]",
} as const;

export function PlayerReadyBadge() {
  return (
    <Chip
      className="h-5 py-px px-[5px] text-[10px] font-bold text-[#247c51] bg-[#e3f2e8] rounded-[6px] whitespace-nowrap [@container(max-width:160px)]:text-[8px] [@container(max-width:160px)]:px-[3px]"
      size="sm"
    >
      準備完了
    </Chip>
  );
}

export function PlayerCardView({
  player,
  self,
  host,
  connected,
  position,
  current = false,
  score,
  rank,
  clock,
  shogi = false,
}: {
  player: Room["players"][number] | MatchHistoryParticipant | null;
  self: boolean;
  host: boolean;
  connected?: boolean;
  position: keyof typeof seatClasses;
  current?: boolean;
  score: ReactNode;
  rank: { rank: number; label: string } | null;
  clock: RoomClockPresentation | null;
  shogi?: boolean;
}) {
  const name = player ? playerName(player) : "空席";
  const nameBox = useRef<HTMLDivElement>(null);
  const nameContent = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = nameBox.current;
    const content = nameContent.current;
    if (!box || !content) return;
    const fit = () => {
      const availableWidth = box.getBoundingClientRect().width;
      if (availableWidth === 0) return;
      content.style.fontSize = "";
      const naturalWidth = content.getBoundingClientRect().width;
      const fontSize = Number.parseFloat(getComputedStyle(content).fontSize);
      if (naturalWidth <= availableWidth) return;
      let upper = fontSize * (availableWidth / naturalWidth);
      content.style.fontSize = `${upper}px`;
      // フォントによって字幅は文字サイズに比例しないため、実測で収まりを確かめます。
      if (content.getBoundingClientRect().width <= availableWidth) return;
      let lower = 0;
      for (let index = 0; index < 10; index++) {
        const candidate = (lower + upper) / 2;
        content.style.fontSize = `${candidate}px`;
        if (content.getBoundingClientRect().width <= availableWidth) lower = candidate;
        else upper = candidate;
      }
      content.style.fontSize = `${lower}px`;
    };
    fit();
    // 計測による文字サイズ変更をobserverの通知フレームから分離します。
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(box);
    document.fonts.addEventListener("loadingdone", fit);
    document.addEventListener("visibilitychange", fit);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", fit);
      document.removeEventListener("visibilitychange", fit);
    };
  }, [name, host, player?.kind]);
  return (
    <AppCard
      data-testid="player-card"
      className={cn(
        "[container-type:inline-size] grid grid-cols-[32px_minmax(0,1fr)] grid-rows-[20px_22px] content-center gap-x-2 gap-y-[2px] py-[6px] px-2 w-[var(--seat-width)] h-[var(--player-height)] justify-self-center rounded-[17px] overflow-visible shadow-[0_2px_5px_#203b2210] [@media(max-width:767px)]:py-px [@media(max-width:767px)]:px-[6px] [@media(max-width:767px)]:gap-x-1 [@media(max-width:767px)]:grid-cols-[26px_minmax(0,1fr)]",
        seatClasses[position],
        !player && "bg-[#e9ede9] text-muted shadow-none",
        self &&
          (shogi
            ? "border-[#d5b35d] shadow-[0_0_0_1px_#d5b35d2b]"
            : "border-[#81b99d] shadow-[0_0_0_1px_#8ec4a62b]"),
        current && "border-[#dc9a39] shadow-[0_0_0_2px_#e8b76640]",
      )}
      aria-label={
        player ? `${playerName(player)}${self ? "、あなた" : ""}${host ? "、ホスト" : ""}` : "空席"
      }
    >
      <Badge.Anchor
        data-testid="player-avatar-slot"
        className="col-start-1 row-span-2 self-center size-8 min-w-8 min-h-8 [@media(max-width:767px)]:size-[26px] [@media(max-width:767px)]:min-w-[26px] [@media(max-width:767px)]:min-h-[26px]"
      >
        <Avatar
          data-testid="player-avatar"
          title={player?.kind === "cpu" ? "CPU" : undefined}
          className={cn(
            "size-full min-w-0 min-h-0 aspect-square rounded-full",
            player?.kind === "cpu" ? "bg-[#e0edff] text-[#376597]" : "bg-[#e1e6e3] text-[#7a8880]",
          )}
          aria-hidden="true"
        >
          {player?.kind === "human" && player.avatarUrl && (
            <Avatar.Image src={player.avatarUrl} alt="" className="size-full object-cover" />
          )}
          <Avatar.Fallback className="bg-transparent text-inherit">
            <AppIcon name={player?.kind === "cpu" ? "robot" : "user"} className="block size-5" />
          </Avatar.Fallback>
        </Avatar>
        {player && connected !== undefined && (
          <Badge
            className={cn(
              "absolute right-0 bottom-0 size-[11px] min-w-[11px] min-h-[11px] max-w-[11px] max-h-[11px] aspect-square border-2 border-solid border-white p-0 rounded-full [transform:translate(20%,20%)]",
              connected ? "bg-[#34a871]" : "bg-[#e2b232]",
            )}
            placement="bottom-right"
            size="sm"
            aria-label={connected ? "接続中" : "切断中"}
          />
        )}
      </Badge.Anchor>
      <div
        data-testid="player-name"
        className="col-start-2 row-start-1 min-w-0 overflow-clip whitespace-nowrap self-center leading-5"
        ref={nameBox}
      >
        <span
          className="inline-flex w-max items-center font-bold text-sm leading-[1.3] align-middle"
          ref={nameContent}
        >
          {name}
          {host && (
            <span className="inline-flex ml-[0.28em] text-[#b58a28]" title="ホスト">
              <AppIcon name="crown" className="size-[1em]" />
            </span>
          )}
        </span>
      </div>
      <div className="col-start-2 row-start-2 min-w-0 grid grid-cols-[54px_minmax(0,1fr)] items-center gap-[3px] [@container(max-width:160px)]:grid-cols-[40px_minmax(0,1fr)] [@container(max-width:160px)]:gap-[2px]">
        <span data-testid="player-score-slot" className="flex items-center min-w-0 h-[22px]">
          {score}
        </span>
        <span
          data-testid="player-time-slot"
          className="flex justify-end items-center min-w-0 h-[22px]"
        >
          {rank ? (
            <Chip
              className={cn(
                "h-[22px] py-[2px] px-1 rounded-[6px] font-bold whitespace-nowrap shrink-0 [@container(max-width:160px)]:px-[3px]",
                shogi ? "text-[clamp(7px,4cqw,11px)]" : "text-[clamp(8px,5cqw,12px)]",
                rankClasses[rank.rank as keyof typeof rankClasses],
              )}
              size="sm"
            >
              {rank.label}
            </Chip>
          ) : (
            clock && <RoomClock clock={clock} />
          )}
        </span>
      </div>
    </AppCard>
  );
}
