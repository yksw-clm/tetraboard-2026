import { type ReactNode } from "react";
import { AppTabs } from "../../shared/ui/AppTabs";
import { AppIcon } from "../../shared/ui/AppIcon";
const tabLabels = { board: "盤面", room: "ルーム", chat: "チャット" } as const;
export function RoomBoardLayout({
  children,
  hasNotice = false,
}: {
  children: ReactNode;
  hasNotice?: boolean;
}) {
  // スマホではカード2段と間隔を残し、盤だけを空き高さに収めます。
  // 自動パスの通知がある場合は、その1行分と間隔も確保します。
  return (
    <div
      className={`[--board-notice-space:0px] ${hasNotice ? "[@media(max-width:767px)]:[--board-notice-space:17px]" : ""} [--player-height:60px] [@media(max-width:767px)]:[--player-height:48px] [--seat-width:clamp(168px,23cqw,280px)] [--board-size:max(160px,min(640px,calc(100cqw_-_2_*_var(--seat-width)_-_16px),calc(100cqh_-_2_*_var(--player-height)_-_32px)))] grid w-full min-h-full py-2 px-0 grid-cols-[var(--seat-width)_var(--board-size)_var(--seat-width)] grid-rows-[var(--player-height)_var(--board-size)_var(--player-height)] [grid-template-areas:'._top_.'_'left_board_right'_'._bottom_.'] gap-2 content-center justify-center items-center relative [@media(max-width:767px)]:[--board-size:max(0px,min(100cqw,calc(100cqh_-_2_*_var(--player-height)_-_4px_-_var(--board-notice-space))))] [@media(max-width:767px)]:[--seat-width:100%] [@media(max-width:767px)]:grid-cols-2 [@media(max-width:767px)]:grid-rows-[var(--player-height)_auto_var(--player-height)] [@media(max-width:767px)]:[grid-template-areas:'left_top'_'board_board'_'bottom_right'] [@media(max-width:767px)]:gap-[2px] [@media(max-width:767px)]:content-start [@media(max-width:767px)]:p-0`}
    >
      {children}
    </div>
  );
}

export function RoomLayout({
  desktop,
  tab,
  onTabChange,
  board,
  info,
  status,
  chat,
  replay,
  showChatTab = true,
}: {
  desktop: boolean;
  tab: string;
  onTabChange: (tab: string) => void;
  board: ReactNode;
  info: ReactNode;
  status: ReactNode;
  chat: ReactNode;
  replay: ReactNode;
  showChatTab?: boolean;
}) {
  return (
    <>
      {desktop ? (
        <div className="flex-1 min-w-0 min-h-0 p-3 gap-3 grid grid-cols-[minmax(0,1fr)_360px] grid-rows-[minmax(0,1fr)]">
          <section
            className="min-w-0 min-h-0 [container-type:size] overflow-auto relative flex flex-col gap-2"
            aria-label="盤面とプレイヤー"
          >
            <div className="flex-1 min-w-0 min-h-0 [container-type:size] overflow-auto">
              {board}
            </div>
            {replay}
          </section>
          <div className="min-w-0 min-h-0 flex flex-col gap-3 overflow-y-auto overscroll-contain">
            <section className="min-w-0 shrink-0" aria-label="ルーム">
              {info}
            </section>
            {status}
            <section className="min-w-0 min-h-[140px] flex-1 shrink-0" aria-label="チャット">
              {chat}
            </section>
          </div>
        </div>
      ) : (
        <AppTabs
          className="flex-1 min-w-0 min-h-0 grid grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto] gap-2 pt-[6px] px-3 pb-[max(6px,env(safe-area-inset-bottom))] [@media(max-width:767px)]:pt-1 [@media(max-width:767px)]:px-1 [@media(max-width:767px)]:pb-[max(4px,env(safe-area-inset-bottom))] [@media(max-width:767px)]:gap-[6px]"
          selectedKey={tab}
          onSelectionChange={(key) => onTabChange(String(key))}
        >
          <AppTabs.List aria-label="ルームの表示" className="col-start-1 row-start-3 w-full h-12">
            {(Object.keys(tabLabels) as (keyof typeof tabLabels)[])
              .filter((key) => showChatTab || key !== "chat")
              .map((key) => (
                <AppTabs.Tab key={key} id={key} className="h-full p-2 text-xs [&_svg]:size-4">
                  <AppIcon name={key === "room" ? "user" : key} />
                  {tabLabels[key]}
                  <AppTabs.Indicator />
                </AppTabs.Tab>
              ))}
          </AppTabs.List>
          <AppTabs.Panel
            id="board"
            className="min-w-0 min-h-0 [container-type:size] overflow-auto [@media(min-width:1280px)]:col-start-1 [@media(min-width:1280px)]:row-span-3 relative [@media(min-width:1280px)]:flex [@media(min-width:1280px)]:flex-col [@media(min-width:1280px)]:gap-2 col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
            shouldForceMount
          >
            {board}
          </AppTabs.Panel>
          <AppTabs.Panel
            id="room"
            className="min-w-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-1 [@media(max-width:1279px)]:overflow-y-auto [@media(max-width:767px)]:p-[2px] col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
            shouldForceMount
          >
            {info}
          </AppTabs.Panel>
          {showChatTab && (
            <AppTabs.Panel
              id="chat"
              className="min-w-0 min-h-0 [@media(min-width:1280px)]:col-start-2 [@media(min-width:1280px)]:row-start-3 [@media(max-width:767px)]:p-[2px] col-start-1 row-start-1 p-0 min-w-0 min-h-0 [&[inert]]:hidden [&[hidden]]:hidden"
              shouldForceMount
            >
              {chat}
            </AppTabs.Panel>
          )}
          {status}
        </AppTabs>
      )}
    </>
  );
}
