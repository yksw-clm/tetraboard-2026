import type { ReactNode } from "react";
import { Link } from "react-router";
import { AccountMenu } from "../account/AccountMenu";
import { LobbyFooter } from "../lobby/LobbyFooter";
import { AppButtonLink } from "../../shared/ui/AppButton";
import { AppCard } from "../../shared/ui/AppCard";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
import { helpScreenshots } from "./helpScreenshots";

const chapters = [
  { number: 1, id: "choose-game", title: "ゲームを選ぶ" },
  { number: 2, id: "cpu", title: "CPUと遊ぶ" },
  { number: 3, id: "friends", title: "友達を招待する" },
  { number: 4, id: "public-rooms", title: "公開ルームに参加・観戦する" },
  { number: 5, id: "play", title: "対局画面を使う" },
  { number: 6, id: "records", title: "対局の記録を見る" },
  { number: 7, id: "tournaments", title: "大会に参加する" },
  { number: 8, id: "account-settings", title: "アカウントと設定" },
] as const;

type Screenshot = keyof typeof helpScreenshots;
type Figure = { image: Screenshot; alt: string; caption: string };

function GuideFigure({
  image,
  alt,
  caption,
  eager = false,
  desktop = false,
}: Figure & { eager?: boolean; desktop?: boolean }) {
  const screenshot = helpScreenshots[image];
  return (
    <figure className={`m-0 w-full min-w-0 ${desktop ? "max-w-[960px]" : "max-w-[320px]"}`}>
      <div className="overflow-hidden rounded-2xl border border-solid border-line bg-surface-muted p-2 shadow-panel">
        <img
          src={screenshot.src}
          width={screenshot.width}
          height={screenshot.height}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          className="block h-auto w-full rounded-lg"
        />
      </div>
      <figcaption className="mt-2 text-xs leading-relaxed text-muted">{caption}</figcaption>
    </figure>
  );
}

function GuideChapter({
  number,
  id,
  title,
  children,
  figures,
  desktop,
}: (typeof chapters)[number] & {
  children: ReactNode;
  figures: ReactNode;
  desktop?: Figure;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <AppCard className="gap-6 p-5 sm:p-7">
        <div className="grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(280px,360px)] md:gap-8">
          <div className="min-w-0">
            <div className="mb-5 flex items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-hover text-sm font-bold text-brand"
              >
                {number}
              </span>
              <h2 id={`${id}-title`} className="pt-1 text-xl font-bold leading-snug">
                {title}
              </h2>
            </div>
            <div className="space-y-4 text-sm leading-7 text-ink-secondary">{children}</div>
          </div>
          <div className="flex min-w-0 flex-col items-center gap-5">{figures}</div>
        </div>
        {desktop && (
          <details className="min-w-0 border-t border-solid border-line pt-4">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold text-brand">
              PCの画面例
            </summary>
            <div className="mt-3 flex justify-center">
              <GuideFigure {...desktop} desktop />
            </div>
          </details>
        )}
      </AppCard>
    </section>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="m-0 space-y-3 pl-5 marker:font-bold marker:text-brand">{children}</ol>;
}

export function HowToPlayPage() {
  return (
    <div className="app-theme min-h-dvh bg-page text-ink">
      <AppHeader homeTo="/" homeLabel="TetraBoard ホーム">
        <AccountMenu />
      </AppHeader>
      <main aria-label="遊び方" className={`${appPageWidthClasses} space-y-6 py-8`}>
        <div className="max-w-3xl space-y-4">
          <p className="text-sm font-bold text-brand">はじめての方へ</p>
          <h1 className="text-[28px] font-bold leading-snug sm:text-[36px]">TetraBoardの使い方</h1>
          <p className="text-sm leading-7 text-ink-secondary">
            名前を決めたら、ひとりでも友達とでも遊べます。スマホの画面を見ながら、遊び始めるまでの操作を紹介します。
          </p>
          <p className="text-sm leading-7 text-muted">
            画面例は四人リバーシ、大会は四人将棋です。人数や設定項目はゲームによって異なります。
            ゲームごとのルールは、各ゲームのロビー右上にある「遊び方」で確認できます。
          </p>
          <AppButtonLink to="/" appearance="primary">
            ホームでゲームを選ぶ
          </AppButtonLink>
        </div>

        <nav aria-label="使い方の目次" className="rounded-panel bg-surface-hover p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-bold">やりたいことから探す</h2>
          <ol className="m-0 grid list-none grid-cols-2 gap-2 p-0">
            {chapters.map((chapter) => (
              <li key={chapter.id}>
                <a
                  href={`#${chapter.id}`}
                  className="flex min-h-11 items-center gap-2 rounded-control px-2 py-2 text-sm font-semibold text-brand no-underline hover:bg-white focus-visible:outline-2 focus-visible:outline-focus"
                >
                  <span aria-hidden="true" className="shrink-0 text-xs tabular-nums">
                    {chapter.number}
                  </span>
                  <span>{chapter.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <GuideChapter
          {...chapters[0]}
          figures={
            <GuideFigure
              image="home"
              alt="スマホのホームに並ぶ6種類のゲームと公開ルームの入口"
              caption="ホームのゲーム一覧。遊びたいゲームをタップします。"
              eager
            />
          }
          desktop={{
            image: "desktopNavigation",
            alt: "PCのホーム上部にあるホーム・遊び方・直近ゲームのナビゲーション",
            caption: "PCでは上部のナビから移動できます。直近に開いたゲームもここに表示されます。",
          }}
        >
          <Steps>
            <li>ホームの「ゲーム一覧」から、遊びたいゲームをタップします。</li>
            <li>
              ゲームのロビーが開きます。ひとりなら「CPUと遊ぶ」、友達となら「公開ルームを作る」を選びます。
            </li>
            <li>
              スマホでは下の「ホーム」でゲーム一覧へ戻れます。直近に開いたゲームも下のタブから開けます。
            </li>
          </Steps>
        </GuideChapter>

        <GuideChapter
          {...chapters[1]}
          figures={
            <GuideFigure
              image="cpu"
              alt="四人リバーシで名前・CPUレベル・持ち時間を確認するCPUとの対局ダイアログ"
              caption="名前やCPUレベルなどを確認して、待機室へ進みます。"
            />
          }
        >
          <Steps>
            <li>ゲームのロビーで「CPUと遊ぶ」を押します。</li>
            <li>
              初めてなら名前を入力し、CPUレベルや時間設定を確認します。下へスクロールして「CPUとの待機室へ」を押します。
            </li>
            <li>
              待機室で準備がそろったら、ホストの「対局開始」を押します。自分で作った部屋では自分がホストです。
            </li>
          </Steps>
          <p>
            四人リバーシの例では、ほかの3席にCPUが入ります。必要な人数はゲームごとに異なります。
          </p>
          <Link
            className="inline-flex min-h-11 items-center font-bold text-brand underline"
            to="/games/four-reversi"
          >
            四人リバーシのロビーへ
          </Link>
        </GuideChapter>

        <GuideChapter
          {...chapters[2]}
          figures={
            <>
              <GuideFigure
                image="invite"
                alt="作成したルームのURLをコピーできるルーム共有ダイアログ"
                caption="「ルームURLをコピー」を押して、友達へ送ります。"
              />
              <GuideFigure
                image="ready"
                alt="四人全員の準備が完了しホストの対局開始ボタンが使える四人リバーシの待機室"
                caption="全員が準備できたら、ホストが「対局開始」を押します。"
              />
            </>
          }
        >
          <Steps>
            <li>「公開ルームを作る」で名前や設定を確認し、「ルームを作る」を押します。</li>
            <li>
              ルームの「ルームを共有」を開き、「ルームURLをコピー」で友達へ送ります。スマホでは「ルーム」タブから共有できます。
            </li>
            <li>
              友達はURLを開き、「参加する」から入室します。参加した人は「準備完了」を押します。
            </li>
            <li>
              必要な人数がそろい、人間全員が準備完了になったら、ホストが「対局開始」を押します。
            </li>
          </Steps>
          <p className="rounded-control bg-surface-muted p-3 text-sm">
            招待URLを送った部屋も公開一覧に載ります。すべてのルームは公開され、ほかの人も参加・観戦できます。
          </p>
        </GuideChapter>

        <GuideChapter
          {...chapters[3]}
          figures={
            <GuideFigure
              image="publicRooms"
              alt="参加する・観戦ボタンと参加人数が表示されたスマホの公開ルーム一覧"
              caption="募集中の部屋へ参加するか、観戦して対局を見られます。"
            />
          }
        >
          <Steps>
            <li>ホームやゲームのロビーにある「公開ルーム」を見ます。</li>
            <li>空席のある部屋の「参加する」を押し、名前などを確認して入室します。</li>
            <li>まず見てみたいときは「観戦」を押します。満員・対局中の部屋も観戦できます。</li>
          </Steps>
          <p>
            参加できる部屋を探すときは「参加できるルームのみ」を使います。大会の部屋は「大会へ」から大会ページへ進みます。
          </p>
        </GuideChapter>

        <GuideChapter
          {...chapters[4]}
          figures={
            <GuideFigure
              image="roomTabs"
              alt="共有・ルーム設定・退室の操作と、下部の盤面・ルーム・チャットタブがあるスマホのルーム情報"
              caption="「ルーム」タブの情報画面。共有や設定、退室はここから行います。"
            />
          }
          desktop={{
            image: "desktopRoom",
            alt: "PCでCPUとの対局中の盤面とルーム情報・チャットが並ぶ四人リバーシの画面",
            caption: "広いPC画面では盤面と情報を並べて見られます。操作はスマホと共通です。",
          }}
        >
          <Steps>
            <li>「盤面」で手番や残り時間を確認し、自分の番になったら盤面を操作します。</li>
            <li>
              「ルーム」で参加者や共有URLを確認できます。退室も「ルーム」タブから行います。待機中の設定変更はホストが行います。
            </li>
            <li>「チャット」で同じ部屋の人とやり取りできます。観戦中は読むだけです。</li>
          </Steps>
          <p>駒や石の動かし方などは、各ゲームのロビー右上の「遊び方」で確認してください。</p>
        </GuideChapter>

        <GuideChapter
          {...chapters[5]}
          figures={
            <GuideFigure
              image="records"
              alt="マイページの棋譜に表示された四人リバーシの対局結果と棋譜を見るリンク"
              caption="マイページの「棋譜」で対局結果を確認し、棋譜を開けます。"
            />
          }
        >
          <Steps>
            <li>スマホ下部の「アカウント」からマイページを開き、見たいゲームを選びます。</li>
            <li>
              「棋譜」にある「棋譜を見る」から対局を開き、手順を戻したり進めたりして振り返ります。
            </li>
            <li>ほかの人の対局は、ロビーの「最近の対局」から見ることもできます。</li>
          </Steps>
          <p>
            ゲストで遊んだ対局も保存されます。CPU戦も棋譜は残りますが、戦績・ランキングの集計対象は対人戦です。
          </p>
          <Link
            className="inline-flex min-h-11 items-center font-bold text-brand underline"
            to="/account"
          >
            マイページへ
          </Link>
        </GuideChapter>

        <GuideChapter
          {...chapters[6]}
          figures={
            <GuideFigure
              image="tournament"
              alt="大会の開催日時・人数・エントリー操作を確認できる四人将棋の大会詳細"
              caption="大会の日時とルールを読み、エントリーして参加します。"
            />
          }
        >
          <Steps>
            <li>四人将棋のロビーで「大会」「次回の大会」から、参加したい大会の詳細を開きます。</li>
            <li>
              日時やルールを確認し、エントリーの確認画面で「エントリーする」を押します。開催前のエントリーは参加予約です。ゲストも参加できます。
            </li>
            <li>
              開催中は「対局する」で相手を待ちます。待機をやめるときは「取り消す」を押します。
            </li>
            <li>
              4人そろうと入室の案内が出ます。「入室する」を押すか、5秒後に自動で移動します。全員がルームに接続すると自動で対局が始まります。
            </li>
            <li>
              観戦は大会詳細の「進行中の部屋」から。終了後も同じ大会ページで結果を見られます。
            </li>
          </Steps>
          <p>
            大会機能は現在、四人将棋が対象です。通常の部屋のようにホストが開始する操作はありません。
          </p>
          <Link
            className="inline-flex min-h-11 items-center font-bold text-brand underline"
            to="/games/four-shogi"
          >
            四人将棋のロビーへ
          </Link>
        </GuideChapter>

        <GuideChapter
          {...chapters[7]}
          figures={
            <GuideFigure
              image="settings"
              alt="効果音とカード上のスタンプ表示を切り替える表示・サウンド設定ダイアログ"
              caption="右上の設定ボタンから、音やスタンプの表示を変えられます。"
            />
          }
        >
          <Steps>
            <li>
              スマホは下の「アカウント」、PCは右上のアカウントメニューからプロフィールや記録を開きます。
            </li>
            <li>
              名前だけのゲストでも遊べます。Google・Discordで登録すると、別の端末でも同じアカウントで遊べます。ゲストの対局記録も、アカウントの連携で引き継げます。
            </li>
            <li>
              右上の歯車から「表示・サウンド設定」を開き、効果音やカード上のスタンプ表示を切り替えます。
            </li>
          </Steps>
          <p>
            ゲストのままCookieを削除したり有効期限が切れたりすると、そのゲストのマイページへ戻れません。残しておきたい記録はGoogle・Discordに連携して引き継ぎましょう。
          </p>
          <p>
            表示・サウンド設定は、このブラウザで共通の設定です。部屋の時間やCPUなどを変える「ルーム設定」とは別です。
          </p>
          <Link
            className="inline-flex min-h-11 items-center font-bold text-brand underline"
            to="/account"
          >
            アカウントを開く
          </Link>
        </GuideChapter>

        <LobbyFooter>
          <Link to="/" className="inline-flex min-h-11 items-center text-brand underline">
            ホームへ戻る
          </Link>
        </LobbyFooter>
      </main>
    </div>
  );
}
