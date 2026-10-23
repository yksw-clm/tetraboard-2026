import { RoomIdentityFields } from "../account/RoomIdentityFields";
import { useEffect, useState, type MouseEventHandler, type ReactNode } from "react";
import { useParams } from "react-router";
import {
  tournamentRules,
  type TournamentDetail,
  type TournamentStanding,
} from "@tetraboard/protocol";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppIcon } from "../../shared/ui/AppIcon";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { AccountMenu } from "../account/AccountMenu";
import { useAccount } from "../account/useAccount";
import { LobbyFooter } from "../lobby/LobbyFooter";
import { LobbyChat } from "../lobby/LobbyChat";
import { TournamentStatus } from "./TournamentStatus";
import { TournamentRules } from "./TournamentRules";
import { TournamentPlayer, TournamentStandings } from "./TournamentStandings";
import { tournamentDate, tournamentPoints, tournamentRemaining } from "./tournamentPresentation";
import { useTournament } from "./useTournament";
import { TournamentConsent } from "./TournamentConsent";

type TournamentState = ReturnType<typeof useTournament>;
function EntryAction({ state }: { state: TournamentState }) {
  const account = useAccount();
  const entered = state.participation.entered;
  return (
    <div className="flex max-w-[360px] flex-col items-end gap-2">
      <AppButton
        isDisabled={
          entered ||
          state.participationLoading ||
          state.pending !== null ||
          account.loading ||
          Boolean(account.error)
        }
        isPending={state.pending === "entry"}
        appearance={entered ? "secondary" : "primary"}
        className="min-h-11 whitespace-normal text-center"
        onPress={state.enter}
      >
        {!entered && <AppIcon name="join" className="size-4" />}
        {entered
          ? "エントリー済み"
          : !account.user
            ? "ゲストでエントリー"
            : state.data?.tournament.status === "active"
              ? "エントリーして参加"
              : "エントリー"}
      </AppButton>
    </div>
  );
}
function PersonalStanding({
  row,
  finished,
}: {
  row: TournamentStanding | null;
  finished: boolean;
}) {
  if (!row) return null;
  return (
    <AppCard className="@container gap-4 border-lobby-play-line bg-[#fffdf7]">
      <h2 className="flex items-center gap-2 text-sm font-bold">
        <AppAvatar src={row.avatarUrl} className="size-7" />
        {row.name}さんの{finished ? "最終成績" : "大会成績"}
      </h2>
      <dl className="grid grid-cols-2 gap-4 @min-[480px]:grid-cols-4">
        {[
          [finished ? "最終順位" : "現在の順位", row.rank ? `${row.rank}位` : "未対局"],
          ["勝ち点", `${tournamentPoints(row.pointsUnits)}点`],
          ["対局数", `${row.games}局`],
          ["撃破数", `${row.knockouts}人`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="mt-1 text-xl font-bold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {!finished && (
        <p className="text-xs text-muted">
          途中参加でも、自分のペースで。大会期間中は何局でも挑戦できます。
        </p>
      )}
    </AppCard>
  );
}
function Awards({ detail }: { detail: TournamentDetail }) {
  const winners = detail.standings.filter((row) => row.rank === 1 || row.rank === 2);
  const tied = winners.filter((row) => row.rank === 1).length > 1;
  if (!detail.tournament.completedCount) return null;
  return (
    <section aria-label="大会の表彰" className="grid gap-4 sm:grid-cols-2">
      {winners.map((row, index) => (
        <AppCard
          key={row.username ?? `deleted-${index}`}
          className={`items-center gap-3 py-6 text-center ${row.rank === 1 ? "border-[#dfbd62] bg-linear-to-br from-[#fffbeb] to-[#fff2c9]" : "bg-[#f9faf9]"}`}
        >
          <AppIcon name="crown" className="size-8 text-brand" />
          <span className="text-xs font-bold tracking-widest text-muted">
            {row.rank === 1 ? (tied ? "同率優勝" : "優勝") : "準優勝"}
          </span>
          <div className="text-xl">
            <TournamentPlayer row={row} large />
          </div>
          <p className="text-sm text-muted">
            <strong className="text-ink">{tournamentPoints(row.pointsUnits)}点</strong> ·{" "}
            {row.games}局 · {row.knockouts}撃破
          </p>
        </AppCard>
      ))}
    </section>
  );
}
function TournamentPlay({ state }: { state: TournamentState }) {
  const account = useAccount();
  const participation = state.participation;
  const closed = state.data!.tournament.status !== "active";
  const waiting = participation.status === "waiting";
  const matched = participation.status === "matched" || participation.status === "playing";
  return (
    <AppCard className="gap-4">
      <h2 className="text-lg font-bold">大会対局</h2>
      {state.participationLoading ? (
        <p role="status" className="text-sm text-muted">
          参加状態を確認しています…
        </p>
      ) : participation.controller === "other" ||
        (participation.status !== "idle" && !state.canControl) ? (
        <>
          <p role="status" className="text-sm text-muted">
            {participation.controller === "other"
              ? "別のタブでマッチング中"
              : "操作を再開するには、このタブへ引き継いでください。"}
          </p>
          <AppButton
            onPress={state.takeOver}
            isDisabled={state.pending !== null || account.loading || Boolean(account.error)}
            isPending={state.pending === "controller"}
          >
            このタブで続ける
          </AppButton>
        </>
      ) : closed && participation.status !== "playing" ? (
        <>
          <p className="text-sm text-muted">
            新しい対局の受付は終了しました。進行中の対局と結果保存の完了を待っています。
          </p>
          <AppButton isDisabled appearance="secondary" className="min-h-12 w-full">
            対局受付終了
          </AppButton>
        </>
      ) : matched ? (
        <>
          <p role="status" className="text-sm text-muted">
            {state.canEnterRoom
              ? "対戦相手が集まりました。ルームへの入室を準備しています。"
              : "参加中の対局があります。参加資格を保存したタブから戻れます。"}
          </p>
          {participation.status === "playing" && state.canEnterRoom ? (
            <AppButton onPress={state.enterRoom}>参加中の対局へ</AppButton>
          ) : null}
        </>
      ) : (
        <>
          <div role="status" className="text-sm leading-relaxed">
            {waiting && <p className="font-bold text-brand">対戦相手を探しています...</p>}
            <p className={waiting ? "mt-1 text-xs text-muted" : "text-muted"}>
              現在{state.data!.tournament.waitingCount}
              人が待機中です。4人そろったら入室のご案内が表示されます。
            </p>
          </div>
          {participation.entered ? (
            <AppButton
              onPress={waiting ? state.cancel : state.queue}
              appearance={waiting ? "secondary" : "primary"}
              isDisabled={state.pending !== null || account.loading || Boolean(account.error)}
              isPending={state.pending === "queue" || state.pending === "cancel"}
              className="min-h-12 w-full"
            >
              <AppIcon name={waiting ? "close" : "join"} />
              {waiting ? "取り消す" : "対局する"}
            </AppButton>
          ) : (
            <EntryAction state={state} />
          )}
          {!participation.entered && (
            <p className="text-xs text-muted">エントリーすると、大会の対局に参加できます。</p>
          )}
        </>
      )}
    </AppCard>
  );
}
function TournamentMatchedDialog({
  onEnter,
  message,
  unavailable,
}: {
  onEnter: () => void;
  message: string | null;
  unavailable: boolean;
}) {
  const [readyAt] = useState(() => performance.now() + tournamentRules.entryDelayMs);
  useEffect(() => {
    if (unavailable) return;
    const timeout = window.setTimeout(onEnter, Math.max(0, readyAt - performance.now()));
    return () => window.clearTimeout(timeout);
  }, [onEnter, readyAt, unavailable]);
  return (
    <AppDialog
      title="対戦相手が集まりました"
      size="compact"
      theme="four-shogi"
      dismissible={false}
      onClose={() => {}}
    >
      <p className="text-sm text-muted">5秒後に自動で入室します。</p>
      {message && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {message}
        </p>
      )}
      <AppButton className="mt-5 w-full" isDisabled={unavailable} onPress={onEnter}>
        入室する
      </AppButton>
    </AppDialog>
  );
}
function TournamentContent({ id }: { id: number }) {
  const state = useTournament(id);
  const account = useAccount();
  const detail = state.data;
  const tournament = detail?.tournament;
  useEffect(() => {
    if (tournament) document.title = `${tournament.name} | TetraBoard`;
  }, [tournament]);
  return (
    <TournamentPageLayout
      onLogoClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey ||
          event.defaultPrevented
        )
          return;
        event.preventDefault();
        void state.returnToLobby();
      }}
    >
      <main className={`${appPageWidthClasses} flex flex-col gap-5 py-6 max-sm:gap-4`}>
        <AppButton
          onPress={() => void state.returnToLobby()}
          appearance="quiet"
          className="self-start px-0"
        >
          <AppIcon name="arrow" className="rotate-180" />
          四人将棋ロビーへ
        </AppButton>
        {state.returnReason === "unavailable" && (
          <p role="status" className="text-sm text-muted">
            接続がそろわず対局が成立しませんでした。待機状況を確認し、もう一度対局できます。
          </p>
        )}
        {state.returnReason === "transferred" && (
          <p role="status" className="text-sm text-muted">
            別のタブへ操作を引き継ぎました。
          </p>
        )}
        {account.error && (
          <p role="alert" className="text-sm text-danger">
            {account.error}
            <AppButton
              appearance="quiet"
              size="compact"
              onPress={() => void account.refresh("tournament")}
            >
              ログイン状態を再確認
            </AppButton>
          </p>
        )}
        {(state.error || state.message) && (
          <p role="alert" className="text-sm text-danger">
            {state.error ?? state.message}
            <AppButton appearance="quiet" size="compact" onPress={() => void state.refresh()}>
              再取得
            </AppButton>
          </p>
        )}
        {!detail || !tournament ? (
          !state.error && <p role="status">大会を読み込んでいます…</p>
        ) : (
          <>
            <AppCard className="gap-5 p-6 max-sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <TournamentStatus stage={tournament.status} />
                <span className="text-xs text-muted">大会 #{tournament.id}</span>
              </div>
              <div className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <h1 className="text-[28px] leading-[1.5] wrap-anywhere max-sm:text-[23px]">
                    {tournament.name}
                  </h1>
                  <p className="mt-2 flex items-center gap-2 text-sm text-muted">
                    <AppIcon name="clock" className="size-4" />
                    <span>{tournamentDate(tournament.startsAtMs, tournament.endsAtMs)}</span>
                  </p>
                </div>
                <div className="flex flex-col items-end gap-3 text-right">
                  <p className="flex flex-wrap items-baseline justify-end gap-x-1 text-sm text-muted">
                    {(tournament.status === "active" || tournament.status === "upcoming") && (
                      <span>現在</span>
                    )}
                    <strong className="text-[36px] leading-none font-bold text-ink tabular-nums">
                      {tournament.entryCount}
                    </strong>
                    <span>
                      人がエントリー
                      {(tournament.status === "active" || tournament.status === "upcoming") && "中"}
                    </span>
                  </p>
                  {tournament.status === "upcoming" && <EntryAction state={state} />}
                </div>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-solid border-line pt-4 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <AppIcon name="users" className="size-4" />
                  人間4人・ランダムマッチ
                </span>
                <span>持ち時間なし・秒読み30秒</span>
                <span>途中参加OK</span>
              </div>
              {tournament.description && (
                <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-relaxed text-ink-secondary">
                  {tournament.description}
                </p>
              )}
            </AppCard>
            <div
              role="status"
              className="rounded-panel border border-solid border-lobby-play-line bg-surface-muted px-5 py-4"
            >
              <p className="text-sm font-bold text-brand">
                {tournament.status === "upcoming"
                  ? `${new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }).format(tournament.startsAtMs)} 開始`
                  : tournament.status === "active"
                    ? `大会開催中 · ${tournamentRemaining(tournament)}`
                    : tournament.status === "settling"
                      ? `進行中${tournament.playingCount}局・保存待ち${tournament.pendingCount}局の完了を待っています`
                      : tournament.completedCount
                        ? "大会が終了しました。ご参加ありがとうございました！"
                        : "今回は対局不成立となりました"}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-secondary">
                {tournament.status === "upcoming"
                  ? "エントリーは参加予約です。開始後、このページから対局できます。途中からでも参加できます。"
                  : tournament.status === "active"
                    ? `現在${tournament.playingCount}局が対局中です。途中参加でも、自分のペースで大会を楽しめます。`
                    : tournament.status === "settling"
                      ? "大会の対局開始受付は終了しました。すべての結果がそろうまで順位は暫定です。"
                      : tournament.completedCount
                        ? "すべての対象対局の結果が確定しました。大会の結果は、いつでもこのページで確認できます。"
                        : "有効対局がなかったため、表彰はありません。"}
              </p>
            </div>
            {(tournament.status === "active" || tournament.status === "settling") && (
              <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="flex min-w-0 flex-col gap-5">
                  <TournamentPlay state={state} />
                  <PersonalStanding row={detail.self} finished={false} />
                </div>
                <TournamentStandings
                  key={`${id}:${account.user?.username ?? "guest"}`}
                  detail={detail}
                />
              </div>
            )}
            {tournament.status === "finished" && (
              <>
                <Awards detail={detail} />
                <PersonalStanding row={detail.self} finished />
                <TournamentStandings
                  key={`${id}:${account.user?.username ?? "guest"}`}
                  detail={detail}
                />
              </>
            )}
            <LobbyChat
              key={id}
              tournament={{
                id: tournament.id,
                onEnter: state.enter,
                entryAvailable: tournament.status === "upcoming" || tournament.status === "active",
                entryDisabled:
                  state.participationLoading ||
                  state.pending !== null ||
                  account.loading ||
                  Boolean(account.error),
              }}
            />
            <TournamentRules description={tournament.rulesDescription} />
            {tournament.status === "finished" && (
              <AppCard className="items-start gap-2">
                <h2 className="text-base font-bold">また、四人将棋で会いましょう。</h2>
                <p className="text-sm text-muted">
                  {detail.nextTournament
                    ? `次回：${detail.nextTournament.name} · ${tournamentDate(detail.nextTournament.startsAtMs, detail.nextTournament.endsAtMs)}`
                    : "次回の大会は、開催が決まり次第ロビーでお知らせします。"}
                </p>
                {detail.nextTournament && (
                  <AppButtonLink to={`/tournaments/${detail.nextTournament.id}`}>
                    次回大会の詳細へ
                  </AppButtonLink>
                )}
                <AppButtonLink to="/games/four-shogi" className="mt-2">
                  四人将棋ロビーへ
                  <AppIcon name="arrow" className="size-4" />
                </AppButtonLink>
              </AppCard>
            )}
          </>
        )}
        {state.entryDialog && (
          <AppDialog
            title="大会にエントリー"
            size="compact"
            theme="four-shogi"
            busy={state.pending === "entry"}
            onClose={state.closeEntryDialog}
          >
            <p className="mb-3 text-sm font-bold">{tournament?.name}</p>
            <RoomIdentityFields
              name={state.guestName}
              onChange={state.setGuestName}
              busy={state.pending === "entry"}
            />
            <TournamentConsent />
            {(state.message || state.error || account.error) && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {state.message ?? state.error ?? account.error}
              </p>
            )}
            <AppButton
              className="mt-5 w-full"
              isPending={state.pending === "entry"}
              isDisabled={
                state.pending !== null ||
                account.loading ||
                Boolean(account.error) ||
                !tournament ||
                !["upcoming", "active"].includes(tournament.status)
              }
              onPress={state.confirmEntry}
            >
              エントリーする
            </AppButton>
          </AppDialog>
        )}
        {state.participation.status === "matched" && state.canEnterRoom && (
          <TournamentMatchedDialog
            key={`${account.user?.profileId ?? account.user?.username}:${state.participation.operationId}:${state.participation.matchId}:${state.participation.roomId}`}
            onEnter={state.enterRoom}
            message={state.message}
            unavailable={account.loading || Boolean(account.error)}
          />
        )}
        <LobbyFooter>{null}</LobbyFooter>
      </main>
    </TournamentPageLayout>
  );
}
function TournamentPageLayout({
  children,
  onLogoClick,
}: {
  children: ReactNode;
  onLogoClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <div className="app-theme min-h-dvh text-[15px] leading-[1.6] text-ink">
      <AppHeader
        homeTo="/games/four-shogi"
        homeLabel="TetraBoard 四人将棋のロビー"
        theme="four-shogi"
        onLogoClick={onLogoClick}
      >
        <AccountMenu lobbyGame="four-shogi" />
      </AppHeader>
      <div className="game-theme-four-shogi lobby-background min-h-[calc(100dvh-69px)] text-ink">
        {children}
      </div>
    </div>
  );
}
export function TournamentPage() {
  const { id: value } = useParams();
  const id = value && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) ? (
    <TournamentContent key={id} id={id} />
  ) : (
    <TournamentPageLayout>
      <main className={`${appPageWidthClasses} py-6`}>
        <p>大会が見つかりません。</p>
        <AppButtonLink to="/games/four-shogi">四人将棋ロビーへ</AppButtonLink>
      </main>
    </TournamentPageLayout>
  );
}
