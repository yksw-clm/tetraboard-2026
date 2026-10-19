import { useState, type ReactNode } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router";
import { AppAvatar } from "../../shared/ui/AppAvatar";
import { AppButton, AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppDialog } from "../../shared/ui/AppDialog";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AppIcon } from "../../shared/ui/AppIcon";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { LobbyBoardPreview } from "../../features/lobby/LobbyBoardPreview";
import { GameLobbyNavigation } from "../../features/lobby/GameLobbyNavigation";
import {
  sampleStandings,
  stageLabels,
  standingStats,
  tournamentDate,
  tournamentName,
  type MockAccount,
  type MockScenario,
  type Standing,
  type TournamentStage,
} from "./tournamentSamples";

type RankedStanding = Standing & ReturnType<typeof standingStats> & { rank: number | null };
type MockState = {
  stage: TournamentStage;
  account: MockAccount;
  scenario: MockScenario;
  queue: boolean;
  entered: boolean;
  entryCount: number;
  standings: RankedStanding[];
  onEnter: () => void;
  onQueue: () => void;
};

function TournamentStatus({ stage }: { stage: TournamentStage }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-0.5 text-[11px] font-bold text-brand">
      {stage === "active" && (
        <span className="relative flex size-2" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-40 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-brand" />
        </span>
      )}
      {stageLabels[stage]}
    </span>
  );
}

function EntryAction({ state, compact = false }: { state: MockState; compact?: boolean }) {
  if (state.stage === "settling" || state.stage === "finished") return null;
  const waiting = state.stage === "upcoming" && state.entered;
  const label = waiting
    ? "エントリー済み"
    : state.queue
      ? "取り消す"
      : !state.entered
        ? state.account === "guest"
          ? "ログインまたは登録してエントリー"
          : state.stage === "active"
            ? "エントリーして参加"
            : "エントリー"
        : "対局する";
  return (
    <AppButton
      size={compact ? "compact" : "default"}
      isDisabled={waiting}
      appearance={state.queue || waiting ? "secondary" : "primary"}
      className="min-h-11 whitespace-normal text-center"
      onPress={state.entered ? state.onQueue : state.onEnter}
    >
      {!waiting && <AppIcon name={state.queue ? "close" : "join"} className="size-4" />}
      {label}
    </AppButton>
  );
}

function TournamentEntrance({ state }: { state: MockState }) {
  const ended = state.stage === "settling" || state.stage === "finished";
  return (
    <section aria-label="四人将棋大会">
      <AppCard
        density="compact"
        className="flex flex-row flex-wrap items-center justify-between gap-x-5 gap-y-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="hidden size-10 shrink-0 place-items-center rounded-control bg-surface-muted text-brand sm:grid">
            <AppIcon name="crown" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-sm font-bold">{tournamentName}</h2>
              <TournamentStatus stage={state.stage} />
            </div>
            <p className="text-xs text-muted">
              {state.stage === "finished"
                ? state.scenario === "empty"
                  ? "有効対局がなかったため、今回は対局不成立となりました。"
                  : state.scenario === "tied"
                    ? "てとらさん・しろくまさん、同率優勝おめでとうございます！"
                    : "優勝：てとらさん　準優勝：しろくまさん"
                : state.stage === "settling"
                  ? "対局と結果の保存を待っています。順位は暫定です。"
                  : `${state.stage === "active" ? "終了まであと45分" : "10月24日（土）20:00〜22:00〈日本時間〉"} · 現在${state.entryCount}人がエントリー中`}
            </p>
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <AppButtonLink to="/tournaments/1" size="compact" className="min-h-11">
            {state.stage === "finished" ? "結果を見る" : "詳細へ"}
          </AppButtonLink>
          {!ended &&
            (state.stage === "active" && state.entered ? (
              <AppButtonLink
                to="/tournaments/1"
                appearance="primary"
                size="compact"
                className="min-h-11"
              >
                大会に参加
              </AppButtonLink>
            ) : (
              <EntryAction state={state} compact />
            ))}
        </div>
      </AppCard>
    </section>
  );
}

function SampleAnnouncement({ onRead }: { onRead: () => void }) {
  return (
    <section aria-label="ロビーのお知らせ">
      <AppCard density="compact" className="flex flex-row items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold">四人将棋の対局画面が使いやすくなりました</h2>
          <p className="text-xs text-muted">盤面とプレイヤー情報の表示を改善しました。</p>
        </div>
        <AppButton
          appearance="quiet"
          size="compact"
          onPress={onRead}
          className="min-h-11 px-0 text-brand underline"
        >
          お知らせへ
        </AppButton>
      </AppCard>
    </section>
  );
}

function MockLobby({ state, onOtherAction }: { state: MockState; onOtherAction: () => void }) {
  return (
    <>
      <GameLobbyNavigation />
      <main
        className={`${appPageWidthClasses} flex flex-col gap-[22px] pt-6 pb-6 max-sm:gap-[18px]`}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-5 max-sm:gap-3">
            <LobbyBoardPreview game="four-shogi" />
            <div>
              <h1 className="text-[36px] leading-[1.35] tracking-[0.02em] max-sm:text-[27px]">
                四人将棋
              </h1>
              <p className="mt-1.5 text-sm text-muted">
                ひとりでも、友達とでも。4方向から楽しむ将棋。
              </p>
            </div>
          </div>
          <AppButton appearance="quiet" size="compact" onPress={onOtherAction}>
            <AppIcon name="help" />
            遊び方
          </AppButton>
        </div>
        <TournamentEntrance state={state} />
        <SampleAnnouncement onRead={onOtherAction} />
        <div className="grid gap-5 md:grid-cols-2">
          <AppCard className="lobby-quick-background gap-3 border-lobby-play-line">
            <h2 className="text-lg font-bold">一人で遊ぶ</h2>
            {[
              ["すぐ遊ぶ", "CPU3人と対戦"],
              ["ルームを作る", "友達を招待して、一緒に対戦"],
              ["ルーム番号で参加", "5桁の番号を入力して合流"],
            ].map(([title, description], index) => (
              <div key={title}>
                {index === 1 && <h2 className="mt-2 mb-3 text-lg font-bold">みんなで遊ぶ</h2>}
                <AppButton
                  className="min-h-[72px] w-full justify-between gap-3 px-[18px] py-3 text-left"
                  appearance={index === 0 ? "primary" : "secondary"}
                  onPress={onOtherAction}
                >
                  <span>
                    <strong className="block text-base">{title}</strong>
                    <span className="mt-1 block text-xs font-normal">{description}</span>
                  </span>
                  <AppIcon name={index === 1 ? "plus" : "arrow"} />
                </AppButton>
              </div>
            ))}
          </AppCard>
          <AppCard className="gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-bold">ランキング</h2>
              <span className="text-xs text-muted">対人戦・登録済ユーザーのみ集計</span>
            </div>
            <div className="flex gap-2 text-sm">
              <span className="rounded-control bg-surface-muted px-4 py-2 font-bold text-brand">
                シングルス
              </span>
              <span className="px-4 py-2 text-muted">ダブルス</span>
            </div>
            <div className="flex items-center justify-between border-b border-solid border-line pb-3 text-sm">
              <strong>優勝数</strong>
              <span className="text-xs text-muted">対局数　撃破数　もっと見る</span>
            </div>
            {sampleStandings.slice(0, 3).map((row, index) => (
              <div key={row.name} className="flex items-center gap-3 py-2">
                <span className="w-7 font-bold text-brand">{index + 1}位</span>
                <AppAvatar src={null} />
                <strong className="flex-1 text-sm">{row.name}</strong>
                <span className="text-lg font-bold tabular-nums">
                  {[28, 21, 15][index]}
                  <span className="ml-1 text-xs font-normal text-muted">回</span>
                </span>
              </div>
            ))}
          </AppCard>
        </div>
        <AppCard className="gap-3">
          <h2 className="text-lg font-bold">公開ルーム</h2>
          <div className="rounded-control border border-solid border-line bg-surface-muted p-5 text-center text-sm text-muted">
            大会の対局は、上の大会入口から参加できます。
          </div>
        </AppCard>
        <MockFooter />
      </main>
    </>
  );
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold tabular-nums">{children}</dd>
    </div>
  );
}

function PersonalStanding({ state }: { state: MockState }) {
  if (!state.entered || state.stage === "upcoming") return null;
  const self = state.standings.find((row) => row.self)!;
  const ended = state.stage === "settling" || state.stage === "finished";
  return (
    <AppCard className="@container gap-4 border-lobby-play-line bg-[#fffdf7]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <AppAvatar src={null} className="size-7" />
          こはくさんの{state.stage === "finished" ? "最終成績" : "大会成績"}
        </h2>
        <span className="text-xs font-semibold text-brand">
          {ended
            ? state.stage === "finished"
              ? "確定成績"
              : "暫定成績"
            : self.games
              ? "まずは次の1勝を目指そう"
              : "まずは1局、楽しもう"}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-4 @min-[480px]:grid-cols-4">
        <Metric label={state.stage === "finished" ? "最終順位" : "現在の順位"}>
          {self.rank ? (
            <>
              {self.rank}
              <span className="ml-1 text-sm">位</span>
            </>
          ) : (
            "未対局"
          )}
        </Metric>
        <Metric label="勝ち点">
          {self.points}
          <span className="ml-1 text-sm">点</span>
        </Metric>
        <Metric label="対局数">
          {self.games}
          <span className="ml-1 text-sm">局</span>
        </Metric>
        <Metric label="撃破数">
          {self.knockouts}
          <span className="ml-1 text-sm">人</span>
        </Metric>
      </dl>
      {!ended && (
        <p className="text-xs text-muted">
          途中参加でも、自分のペースで。大会期間中は何局でも挑戦できます。
        </p>
      )}
    </AppCard>
  );
}

function TournamentAwards({ state }: { state: MockState }) {
  if (state.stage !== "finished" || state.scenario === "empty") return null;
  const winners = state.standings.filter((row) => row.rank === 1 || row.rank === 2);
  return (
    <section aria-label="大会の表彰" className="grid gap-4 sm:grid-cols-2">
      {winners.map((row) => (
        <AppCard
          key={row.name}
          className={`items-center gap-3 py-6 text-center ${row.rank === 1 ? "border-[#dfbd62] bg-linear-to-br from-[#fffbeb] to-[#fff2c9]" : "bg-[#f9faf9]"}`}
        >
          <AppIcon
            name="crown"
            className={`size-8 ${row.rank === 1 ? "text-brand" : "text-muted"}`}
          />
          <span className="text-xs font-bold tracking-widest text-muted">
            {row.rank === 1 ? (state.scenario === "tied" ? "同率優勝" : "優勝") : "準優勝"}
          </span>
          <div className="flex items-center gap-3">
            <AppAvatar src={null} className="size-11" />
            <strong className="text-xl">{row.name}</strong>
          </div>
          <p className="text-sm text-muted">
            <strong className="text-ink">{row.points}点</strong> · {row.games}局 · {row.knockouts}
            撃破
          </p>
        </AppCard>
      ))}
    </section>
  );
}

function Standings({ state }: { state: MockState }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll
    ? state.standings
    : state.standings.filter((row) => row.rank !== null && row.rank <= 5);
  const self = state.standings.find((row) => row.self);
  const separateSelf = !showAll && self && !rows.includes(self);
  const hasGames = state.standings.some((row) => row.games > 0);
  return (
    <AppCard className="@container min-w-0 gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">
            {state.stage === "finished" ? "最終順位" : "順位表"}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {state.stage === "finished"
              ? "すべての対象対局の結果が確定しました。"
              : "終了・保存済みの大会対局を集計しています。順位は暫定です。"}
          </p>
        </div>
        <span className="text-xs text-muted">{showAll ? "全参加者" : "上位5位とあなたの成績"}</span>
      </div>
      {!hasGames && (
        <p className="rounded-control bg-surface-muted p-5 text-center text-sm text-muted">
          {state.stage === "finished"
            ? "有効対局がなかったため、今回は対局不成立となりました。表彰はありません。"
            : "まだ対局結果はありません。最初の対局が終了すると、順位が表示されます。"}
        </p>
      )}
      {(hasGames || showAll || separateSelf) && (
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="大会順位表（横スクロールできます）"
          tabIndex={0}
        >
          <table className="w-full min-w-[560px] border-collapse text-left text-xs">
            <caption className="sr-only">
              大会順位と成績。勝ち点、撃破数、平均順位の順に順位を決定します。
            </caption>
            <thead className="border-b border-solid border-line text-[11px] text-muted">
              <tr>
                <th scope="col" className="py-2 pr-1.5 font-medium whitespace-nowrap">
                  順位
                </th>
                <th
                  scope="col"
                  className="w-[calc(10em+30px)] py-2 pr-1.5 font-medium whitespace-nowrap"
                >
                  プレイヤー
                </th>
                {[
                  "勝ち点",
                  "対局数",
                  "優勝数",
                  "2位数",
                  "3位数",
                  "4位数",
                  "撃破数",
                  "平均順位",
                ].map((label) => (
                  <th
                    scope="col"
                    key={label}
                    className="px-1 py-2 text-right font-medium whitespace-nowrap"
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <StandingRow key={row.name} row={row} />
              ))}
              {separateSelf && (
                <tr>
                  <td colSpan={10} className="py-2 text-center text-xs text-muted">
                    {hasGames ? "⋯" : "あなたの成績"}
                  </td>
                </tr>
              )}
              {separateSelf && <StandingRow row={self} />}
            </tbody>
          </table>
        </div>
      )}
      <p className="hidden text-[11px] text-muted @max-[560px]:block">
        横にスクロールして全項目を確認できます。
      </p>
      <p className="text-xs leading-relaxed text-muted">
        同順位の場合、次の順位は人数分だけ飛びます。未対局の人には順位を付けません。
      </p>
      <AppButton
        appearance="secondary"
        className="self-center"
        onPress={() => setShowAll(!showAll)}
      >
        {showAll ? "上位5位に戻す" : `全${state.entryCount}人を見る`}
      </AppButton>
    </AppCard>
  );
}

function StandingRow({ row }: { row: RankedStanding }) {
  return (
    <tr
      className={`border-b border-solid border-line last:border-b-0 ${row.self ? "bg-surface-muted" : ""}`}
    >
      <td className="py-2 pr-1.5 pl-1 font-bold whitespace-nowrap text-brand">
        {row.rank ? `${row.rank}位` : "—"}
        {row.self && <span className="block text-[9px] font-normal text-muted">あなた</span>}
      </td>
      <th scope="row" className="py-2 pr-1.5 font-normal">
        <div className="flex items-center gap-1.5">
          <AppAvatar src={null} className="size-6" />
          <span className="inline-block min-w-[10em] shrink-0 font-semibold whitespace-nowrap">
            {row.name}
          </span>
        </div>
      </th>
      <td className="px-1 py-2 text-right text-sm font-bold tabular-nums">{row.points}</td>
      <td className="px-1 py-2 text-right tabular-nums">{row.games}</td>
      {row.places.map((count, index) => (
        <td key={index} className="px-1 py-2 text-right tabular-nums">
          {count}
        </td>
      ))}
      <td className="px-1 py-2 text-right tabular-nums">{row.knockouts}</td>
      <td className="px-1 py-2 text-right tabular-nums">{row.average}</td>
    </tr>
  );
}

function TournamentRules() {
  return (
    <AppCard className="gap-5">
      <h2 className="text-lg font-bold">大会ルール</h2>
      <div className="grid gap-5 md:grid-cols-[1fr_1fr]">
        <div className="space-y-4 text-sm leading-relaxed text-ink-secondary">
          <p>
            大会期間中は、エントリーしたプレイヤー同士でランダムマッチを行います。1局ごとの勝ち点を積み重ね、合計点で大会順位を決めます。
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
            <dt className="text-muted">対局形式</dt>
            <dd>四人将棋・シングルス（人間4人）</dd>
            <dt className="text-muted">時間設定</dt>
            <dd>持ち時間なし・秒読み30秒</dd>
            <dt className="text-muted">三人攻撃禁止</dt>
            <dd>ON</dd>
            <dt className="text-muted">参加条件</dt>
            <dd>登録済み・エントリー済みのユーザー</dd>
          </dl>
          <p>
            途中参加・途中退出ができます。CPU補充はありません。大会の「対局する」から始まった対局だけが得点対象です。
          </p>
        </div>
        <div>
          <h3 className="mb-3 text-sm font-bold">1局ごとの勝ち点</h3>
          <div className="grid grid-cols-4 gap-2">
            {[4, 2, 1, 0].map((point, index) => (
              <div
                key={point}
                className={`rounded-control border border-solid p-3 text-center ${index === 0 ? "border-lobby-play-line bg-surface-muted" : "border-line"}`}
              >
                <span className="text-xs text-muted">
                  {index === 0 ? "優勝" : `${index + 1}位`}
                </span>
                <strong className="mt-1 block text-xl">
                  {point}
                  <span className="ml-0.5 text-xs font-normal">点</span>
                </strong>
              </div>
            ))}
          </div>
          <h3 className="mt-5 mb-2 text-sm font-bold">勝ち点が同じ場合</h3>
          <ol className="m-0 space-y-1 pl-5 text-sm text-ink-secondary">
            <li>撃破数が多いプレイヤー</li>
            <li>平均順位がよいプレイヤー（数値が小さい）</li>
            <li>すべて同じ場合は同順位</li>
          </ol>
        </div>
      </div>
      <details className="border-t border-solid border-line pt-4 text-sm text-ink-secondary">
        <summary className="min-h-8 cursor-pointer font-semibold text-brand">
          同順位・引き分け・終了時刻について
        </summary>
        <ul className="mt-3 space-y-2 pl-5 leading-relaxed">
          <li>
            大会では合意による引き分けは使いません。千日手などの同順位は、占める順位の点を均等配分します。全員引き分けなら各1.75点、2人が同時に下位へ脱落した場合は各0.5点です。
          </li>
          <li>平均順位は表示上の丸め値ではなく、丸める前の値で比較します。</li>
          <li>
            撃破は着手で相手を詰ませた場合に数えます。投了・時間切れ・通信切れなどは含めません。
          </li>
          <li>
            開催時間内に開始した大会対局は、終了時刻を過ぎても最後まで得点対象です。22:00以降は新しい大会対局を開始できません。
          </li>
          <li>
            すべての対象対局の終了と結果保存を待って順位を確定します。同率優勝は全員を表彰し、有効対局が0局なら表彰しません。
          </li>
        </ul>
      </details>
    </AppCard>
  );
}

function TournamentPlay({ state }: { state: MockState }) {
  const closed = state.stage === "settling";
  return (
    <AppCard className="gap-4">
      <h2 className="text-lg font-bold">大会対局</h2>
      {closed ? (
        <>
          <p className="text-sm text-muted">
            新しい対局の受付は終了しました。進行中の対局と結果保存の完了を待っています。
          </p>
          <AppButton isDisabled appearance="secondary" className="min-h-12 w-full">
            対局受付終了
          </AppButton>
        </>
      ) : (
        <>
          <div role="status" className="text-sm leading-relaxed">
            {state.queue ? (
              <>
                <p className="font-bold text-brand">対戦相手を探しています...</p>
                <p className="mt-1 text-xs text-muted">
                  あなたを含めて3人が待機中です。あと1人で参加確認に進みます。
                </p>
              </>
            ) : (
              <p className="text-muted">現在2人が待機中です。4人そろったら、対局を始めます。</p>
            )}
          </div>
          {state.entered ? (
            <AppButton
              onPress={state.onQueue}
              appearance={state.queue ? "secondary" : "primary"}
              className="min-h-12 w-full"
            >
              <AppIcon name={state.queue ? "close" : "join"} />
              {state.queue ? "取り消す" : "対局する"}
            </AppButton>
          ) : (
            <EntryAction state={state} />
          )}
          {!state.entered && (
            <p className="text-xs text-muted">エントリーすると、大会の対局に参加できます。</p>
          )}
        </>
      )}
    </AppCard>
  );
}

function TournamentPage({ state }: { state: MockState }) {
  const ended = state.stage === "settling" || state.stage === "finished";
  return (
    <main className={`${appPageWidthClasses} flex flex-col gap-5 py-6 max-sm:gap-4`}>
      <AppButtonLink to="/games/four-shogi" appearance="quiet" className="self-start px-0">
        <AppIcon name="arrow" className="rotate-180" />
        四人将棋ロビーへ
      </AppButtonLink>
      <AppCard className="gap-5 p-6 max-sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TournamentStatus stage={state.stage} />
          <span className="text-xs text-muted">大会 #1</span>
        </div>
        <div className="grid items-center gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <h1 className="text-[28px] leading-[1.5] max-sm:text-[23px]">{tournamentName}</h1>
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <AppIcon name="clock" className="size-4" />
              <span>
                {tournamentDate}
                <span className="block text-xs sm:ml-2 sm:inline">日本時間</span>
              </span>
            </p>
          </div>
          <div className="flex flex-col items-end gap-3 text-right">
            <p className="flex flex-wrap items-baseline justify-end gap-x-1 text-sm text-muted">
              {!ended && <span>現在</span>}
              <strong className="text-[36px] leading-none font-bold text-ink tabular-nums">
                {state.entryCount}
              </strong>
              <span>人がエントリー{!ended && "中"}</span>
            </p>
            {state.stage === "upcoming" && <EntryAction state={state} />}
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
      </AppCard>
      {state.stage === "upcoming" && (
        <Notice
          title="10月24日（土）20:00 開始"
          description="エントリーは参加予約です。開始後、このページから対局できます。途中からでも参加できます。"
        />
      )}
      {state.stage === "active" && (
        <Notice
          title="大会開催中 · 終了まであと45分"
          description="現在2局が対局中です。途中参加でも、自分のペースで大会を楽しめます。"
        />
      )}
      {state.stage === "settling" && (
        <Notice
          title={
            state.scenario === "empty"
              ? "結果を確認しています"
              : "残り2局の終了と結果保存を待っています"
          }
          description="大会の対局開始受付は終了しました。すべての結果がそろうまで順位は暫定です。"
        />
      )}
      {state.stage === "finished" && (
        <Notice
          title={
            state.scenario === "empty"
              ? "今回は対局不成立となりました"
              : "大会が終了しました。ご参加ありがとうございました！"
          }
          description={
            state.scenario === "empty"
              ? "有効対局がなかったため、表彰はありません。"
              : "すべての対象対局の結果が確定しました。大会の結果は、いつでもこのページで確認できます。"
          }
        />
      )}
      <TournamentAwards state={state} />
      {(state.stage === "active" || state.stage === "settling") && (
        <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <TournamentPlay state={state} />
            <PersonalStanding state={state} />
          </div>
          <Standings state={state} />
        </div>
      )}
      {state.stage === "finished" && (
        <>
          <PersonalStanding state={state} />
          <Standings state={state} />
        </>
      )}
      <TournamentRules />
      {state.stage === "finished" && (
        <AppCard className="items-start gap-2">
          <h2 className="text-base font-bold">また、四人将棋で会いましょう。</h2>
          <p className="text-sm text-muted">
            次回の大会は、開催が決まり次第ロビーでお知らせします。
          </p>
          <AppButtonLink to="/games/four-shogi" className="mt-2">
            四人将棋ロビーへ
            <AppIcon name="arrow" className="size-4" />
          </AppButtonLink>
        </AppCard>
      )}
      <MockFooter />
    </main>
  );
}

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <div
      role="status"
      className="rounded-panel border border-solid border-lobby-play-line bg-surface-muted px-5 py-4"
    >
      <p className="text-sm font-bold text-brand">{title}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{description}</p>
    </div>
  );
}

function MockFooter() {
  return (
    <footer className="border-t border-solid border-lobby-footer-line py-5 text-center text-xs text-muted">
      © 2026 chaossi · TetraBoard
    </footer>
  );
}

export function TournamentMock() {
  const [stage, setStage] = useState<TournamentStage>("upcoming");
  const [account, setAccount] = useState<MockAccount>("guest");
  const [scenario, setScenario] = useState<MockScenario>("normal");
  const [samplePlayed, setSamplePlayed] = useState(false);
  const [queue, setQueue] = useState(false);
  const [dialog, setDialog] = useState<"login" | "entry" | "other" | null>(null);
  const location = useLocation();
  const entered = account === "entrant";
  const samples = sampleStandings
    .filter((row) => !row.self || entered)
    .map((row, index): Standing => {
      if (stage === "upcoming" || scenario === "empty" || (row.self && !samplePlayed))
        return { ...row, places: [0, 0, 0, 0], knockouts: 0 };
      if (scenario === "tied" && index === 1) return { ...row, places: [4, 1, 1, 0], knockouts: 9 };
      return row;
    })
    .sort((a, b) => standingStats(b).points - standingStats(a).points);
  const standings = samples.map((row, index): RankedStanding => {
    const stats = standingStats(row);
    return {
      ...row,
      ...stats,
      rank: stats.games ? (scenario === "tied" && index === 1 ? 1 : index + 1) : null,
    };
  });
  const state: MockState = {
    stage,
    account,
    scenario,
    queue,
    entered,
    standings,
    entryCount: standings.length,
    onEnter() {
      if (account === "guest") setDialog("entry");
      else {
        setAccount("entrant");
        setSamplePlayed(false);
      }
    },
    onQueue() {
      if (stage === "active") setQueue(!queue);
    },
  };
  return (
    <div className="app-theme min-h-dvh text-[15px] leading-[1.6] text-ink">
      <aside
        aria-label="モックの表示設定"
        className="border-b border-solid border-[#dfe7e2] bg-[#edf2ef] text-[#455b4e]"
      >
        <div
          className={`${appPageWidthClasses} flex flex-wrap items-center gap-x-5 gap-y-3 py-3 text-xs`}
        >
          <div>
            <strong className="mr-2">UIモック</strong>
            <span>サンプルデータ・登録や対局は保存されません</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <MockSelect
              label="大会の状態"
              value={stage}
              onChange={(value) => {
                setStage(value as TournamentStage);
                setQueue(false);
              }}
              options={[
                ["upcoming", "開催前"],
                ["active", "開催中"],
                ["settling", "集計中"],
                ["finished", "結果発表"],
              ]}
            />
            <MockSelect
              label="ログイン状態"
              value={account}
              onChange={(value) => {
                setAccount(value as MockAccount);
                setSamplePlayed(value === "entrant");
                setQueue(false);
              }}
              options={[
                ["guest", "未ログイン"],
                ["member", "ログイン済み"],
                ["entrant", "エントリー済み"],
              ]}
            />
            <MockSelect
              label="成績の例"
              value={scenario}
              onChange={(value) => setScenario(value as MockScenario)}
              options={[
                ["normal", "通常"],
                ["tied", "同率優勝"],
                ["empty", "有効対局なし"],
              ]}
            />
          </div>
          <div className="flex gap-3 font-semibold">
            <Link
              to="/games/four-shogi"
              className="inline-flex min-h-8 items-center text-brand underline"
              aria-current={location.pathname === "/games/four-shogi" ? "page" : undefined}
            >
              ロビー
            </Link>
            <Link
              to="/tournaments/1"
              className="inline-flex min-h-8 items-center text-brand underline"
              aria-current={location.pathname === "/tournaments/1" ? "page" : undefined}
            >
              大会詳細
            </Link>
          </div>
        </div>
      </aside>
      <AppHeader
        homeTo="/games/four-shogi"
        homeLabel="TetraBoard 四人将棋のロビー"
        theme="four-shogi"
      >
        {account === "guest" ? (
          <AppButton appearance="secondary" size="compact" onPress={() => setDialog("login")}>
            ログイン・登録
          </AppButton>
        ) : (
          <span className="flex items-center gap-2 text-sm">
            <AppAvatar src={null} className="size-7" />
            <strong>こはく</strong>
          </span>
        )}
      </AppHeader>
      <div className="game-theme-four-shogi lobby-background min-h-[calc(100dvh-69px)] text-ink">
        <Routes>
          <Route
            path="/games/four-shogi"
            element={<MockLobby state={state} onOtherAction={() => setDialog("other")} />}
          />
          <Route path="/tournaments/1" element={<TournamentPage state={state} />} />
          <Route path="*" element={<Navigate to="/games/four-shogi" replace />} />
        </Routes>
      </div>
      {(dialog === "login" || dialog === "entry") && (
        <AppDialog
          title={dialog === "entry" ? "ログインまたは登録してエントリー" : "ログイン・登録"}
          theme="four-shogi"
          onClose={() => setDialog(null)}
        >
          <p className="text-sm text-muted">
            {dialog === "entry"
              ? "大会へのエントリーにはユーザー登録が必要です。ログイン後、元の画面に戻ってエントリーできます。"
              : "登録すると、大会への参加や自分の戦績の確認ができます。"}
          </p>
          <p className="mt-3 rounded-control bg-surface-muted p-3 text-xs text-muted">
            モックでは下のボタンでログイン後の状態を確認できます。実際のアカウントは作成しません。
          </p>
          <AppButton
            className="mt-5 w-full"
            onPress={() => {
              setAccount(dialog === "entry" ? "entrant" : "member");
              setSamplePlayed(false);
              setDialog(null);
            }}
          >
            {dialog === "entry" ? "ログイン後のエントリー完了を確認" : "ログイン後の状態を確認"}
          </AppButton>
        </AppDialog>
      )}
      {dialog === "other" && (
        <AppDialog title="大会UIモックについて" theme="four-shogi" onClose={() => setDialog(null)}>
          <p className="text-sm text-muted">
            このプレビューでは、大会入口・大会詳細・エントリー・待機の操作を確認できます。通常対局やお知らせは既存画面の配置を確認するためのサンプルです。
          </p>
          <AppButton className="mt-5" onPress={() => setDialog(null)}>
            大会モックに戻る
          </AppButton>
        </AppDialog>
      )}
    </div>
  );
}

function MockSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span>{label}</span>
      <select
        className="min-h-11 rounded-md border border-solid border-[#ccd9d0] bg-white px-2 text-xs text-ink"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([key, title]) => (
          <option key={key} value={key}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}
