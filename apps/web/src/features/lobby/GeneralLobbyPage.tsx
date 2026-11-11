import { matchmakingPath } from "../matchmaking/paths";

import { useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import type { LobbyRoomCard } from "@tetraboard/protocol/general-lobby";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "../account/AccountMenu";
import { useAccount } from "../account/useAccount";
import { LobbyFooter } from "./LobbyFooter";
import { LobbyGameGrid } from "./LobbyGameGrid";
import { AppDialog } from "../../shared/ui/AppDialog";
import { GeneralLobbyRooms } from "./GeneralLobbyRooms";
import { GeneralLobbyChat } from "./GeneralLobbyChat";
import { useGeneralLobbyRooms } from "./useGeneralLobbyRooms";
import { useRoomEntry } from "./useRoomEntry";
import { RoomEntryDialog } from "./RoomEntryDialog";
import { RecentMatches } from "../matches/RecentMatches";
import { TournamentList } from "../tournaments/TournamentList";
import { ActiveTournamentNotice } from "../tournaments/ActiveTournamentNotice";
import { gameThemes } from "../../shared/ui/appTheme";
import { AppButton } from "../../shared/ui/AppButton";
import { useLobbyGameRatings } from "./useLobbyGameRatings";

const mobileQuery = "(max-width: 767px)";
function subscribeToMobile(onChange: () => void) {
  const media = window.matchMedia(mobileQuery);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const isMobile = () => window.matchMedia(mobileQuery).matches;
const isServerMobile = () => false;

export function GeneralLobbyPage() {
  const rooms = useGeneralLobbyRooms(),
    account = useAccount(),
    navigate = useNavigate();
  const [selected, setSelected] = useState<LobbyRoomCard | null>(null);
  const entry = useRoomEntry(selected?.game);
  const [selectingGame, setSelectingGame] = useState(false);
  const mobile = useSyncExternalStore(subscribeToMobile, isMobile, isServerMobile);
  const ratings = useLobbyGameRatings();
  const ratingsFailed =
    ratings.error ||
    Object.values(ratings.games ?? {}).some(({ summary }) => summary?.status === "error");
  const sections = {
    tournaments: <TournamentList key="tournaments" game="all" />,
    chat: <GeneralLobbyChat key="chat" />,
    matches: <RecentMatches key="matches" game="all" />,
  };
  const order = mobile
    ? (["chat", "matches", "tournaments"] as const)
    : (["tournaments", "chat", "matches"] as const);
  function roomAction(room: LobbyRoomCard, intent: "join" | "watch") {
    if (intent === "watch") {
      void navigate(`/rooms/${room.id}?invite=${room.instanceId}&watch=1`);
      return;
    }
    if (room.matchmaking) {
      void navigate(matchmakingPath(room.game));
      return;
    }
    if (room.tournamentId) {
      void navigate(`/tournaments/${room.tournamentId}`);
      return;
    }
    entry.clearMessage();
    setSelected(room);
  }
  return (
    <div className="app-theme min-h-dvh text-[15px] leading-[1.6] text-ink">
      <AppHeader homeTo="/" homeLabel="TetraBoard 総合ロビー">
        <AccountMenu />
      </AppHeader>
      <div className="lobby-background">
        <main
          className={`${appPageWidthClasses} mx-auto flex flex-col gap-[22px] px-6 py-6 [@media(max-width:767px)]:px-4`}
        >
          <div className="flex items-center gap-4">
            <span
              aria-hidden="true"
              className="grid size-14 shrink-0 place-items-center rounded-panel border border-solid border-line bg-white shadow-panel [@media(max-width:767px)]:size-11"
            >
              <img
                src="/favicon.ico"
                width="42"
                height="42"
                alt=""
                className="block [@media(max-width:767px)]:size-8"
              />
            </span>
            <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] [@media(max-width:767px)]:text-[27px]">
              Tetra<span className="text-brand">Board</span>
            </h1>
          </div>
          <p className="text-sm text-muted">
            将棋・リバーシ・五目並べを、二人でも四人でも。気軽に対戦や観戦を楽しめるオンラインボードゲームサイトです。
          </p>
          <ActiveTournamentNotice />
          <section aria-labelledby="game-list-title" className="min-w-0">
            <h2 id="game-list-title" className="mb-4 text-xl font-bold">
              ゲーム一覧
            </h2>
            <LobbyGameGrid mobile={mobile} ratings={ratings} />
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {!account.loading && !account.error && !ratings.registered && (
                <Link to="/login" className="text-brand underline">
                  ログインすると自分のレートを確認できます
                </Link>
              )}
              {ratings.loading && <span role="status">レート情報を読み込んでいます…</span>}
              {ratingsFailed && (
                <AppButton
                  appearance="quiet"
                  size="compact"
                  isPending={ratings.loading}
                  onPress={() => void ratings.retry()}
                >
                  レート情報を再取得
                </AppButton>
              )}
            </div>
          </section>
          <GeneralLobbyRooms
            page={rooms}
            onRoomAction={roomAction}
            onCreate={() => setSelectingGame(true)}
          />
          {order.map((section) => sections[section])}
          <LobbyFooter>
            <Link to="/feedback" className="inline-flex min-h-11 items-center text-brand underline">
              不具合・ご意見
            </Link>
          </LobbyFooter>
        </main>
      </div>
      {selectingGame && (
        <AppDialog title="ゲームを選択" onClose={() => setSelectingGame(false)}>
          <LobbyGameGrid create />
        </AppDialog>
      )}
      {selected && (
        <RoomEntryDialog
          game={selected.game}
          theme={gameThemes[selected.game]}
          intent="join"
          selectedRoomId={selected.id}
          {...entry}
          busy={entry.isSubmitting !== null}
          unavailable={account.loading || Boolean(account.error)}
          onNameChange={entry.setName}
          onRoomCodeChange={entry.setRoomCode}
          onModeChange={entry.setMode}
          onCpuLevelChange={entry.setCpuLevel}
          onTimeControlChange={entry.setTimeControl}
          onClose={() => setSelected(null)}
          onSubmit={(avatarPresetId) =>
            void entry.submitRoom("join", selected.id, selected.instanceId, avatarPresetId)
          }
        />
      )}
    </div>
  );
}
