import { gameCatalog } from "@tetraboard/protocol/games";
import { tournamentListPath } from "@tetraboard/protocol/tournament-pages";
import { fourShogiRulesMetadata } from "../../seo/fourShogiRulesMetadata";
import type { ReactNode } from "react";
import { AppHeader } from "../../shared/ui/AppHeader";
import { AccountMenu } from "../account/AccountMenu";
import { Link } from "react-router";
import { appThemeClasses, gameThemes } from "../../shared/ui/appTheme";
import { FourShogiRules } from "./FourShogiRules";
import {
  InitialPositionDiagram,
  PieceMovesDiagrams,
  PromotionZoneDiagram,
  type RulesDiagramAssetResolver,
} from "./FourShogiRuleDiagrams";

const rulesPageSections = [
  {
    heading: "勝ち方のコツ",
    items: [
      {
        title: "王手で手番の順番が変わる",
        body: "王手を受けた人は、通常の順番を飛ばして応手を指します。王手をかけると次に指す人が変わるので、指す前に、その手のあとで誰の手番になるかを確かめましょう。",
      },
      {
        title: "3人の相手を同時に見る",
        body: "相手は左・右・正面の3人で、どの方向からも駒が来ます。1人の相手だけを見ず、自分の王に利いている駒がないかを毎手確かめましょう。",
      },
      {
        title: "駒が少ないので1枚が重い",
        body: "1人の駒は9枚で、角・桂・香はありません。取った駒は持ち駒として打てるので、駒を取られないこと、取れる駒を見逃さないことが大切です。",
      },
      {
        title: "脱落した人の駒を取る",
        body: "脱落した人の王以外の盤上の駒は利きを失い、生き残った人が取って持ち駒にできます。脱落が出たら、取れる駒がないか盤上を見直しましょう。",
      },
      {
        title: "三人攻撃禁止を意識する",
        body: "ONのとき、4人全員が生存しているシングルスで、2人が同じ相手への攻撃状態を続けている間、残る1人の新しい攻撃が制限されます。王手への応手などには例外があり、誰かが脱落した後は作用しません。",
      },
    ],
  },
  {
    heading: "よくある質問",
    items: [
      {
        title: "通常の将棋との違いは？",
        body: "4人で9×9の盤を囲み、1人の駒は王・飛車・金2枚・銀2枚・歩3枚の9枚で、角・桂・香は使いません。王手を受けた人の応手が通常の手番より優先され、詰んだ人から脱落します。取った駒を打てることや、二歩・打ち歩詰めの禁止は通常の将棋と同じです。",
      },
      {
        title: "4人そろわなくても遊べる？",
        body: "「CPUと遊ぶ」なら、ひとりでCPU3人と対局できます。友達と遊ぶ部屋でも、足りない席はホストがCPUで埋められます。アカウントの登録は要りません。",
      },
      {
        title: "大会はある？",
        body: "毎週土曜の夜に四人将棋などの大会を開いています。日程と過去の結果は大会一覧で見られます。",
      },
    ],
  },
];

export function FourShogiRulesPage({
  header,
  resolveDiagramAsset,
}: {
  header?: ReactNode;
  resolveDiagramAsset?: RulesDiagramAssetResolver;
}) {
  return (
    <div
      className={`app-theme lobby-background min-h-dvh text-ink ${appThemeClasses[gameThemes["four-shogi"]]}`}
    >
      {header ?? (
        <div className="app-theme">
          <AppHeader homeTo="/" homeLabel="TetraBoard ホーム">
            <AccountMenu />
          </AppHeader>
        </div>
      )}
      <main className="mx-auto flex max-w-[920px] flex-col gap-6 px-5 py-8">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">{fourShogiRulesMetadata.heading}</h1>
          <p className="leading-relaxed">
            四人将棋（4人将棋）の初期配置、駒の動き、成りを図で見てみましょう。
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-[1fr_1.6fr]">
          <section className="space-y-3 rounded-lg border border-solid border-lobby-footer-line bg-white p-4">
            <h2 className="text-xl font-bold">初期配置</h2>
            <InitialPositionDiagram resolveAsset={resolveDiagramAsset} />
          </section>
          <section className="space-y-3 rounded-lg border border-solid border-lobby-footer-line bg-white p-4">
            <h2 className="text-xl font-bold">駒の動き</h2>
            <p className="text-sm leading-relaxed">
              図の上が駒の前です。丸は1マス、矢印は途中に駒がなければ何マスでも進める方向です。
            </p>
            <PieceMovesDiagrams resolveAsset={resolveDiagramAsset} />
            <p className="text-sm leading-relaxed">成った銀と歩は金と同じ動きです。</p>
          </section>
        </div>
        <section className="space-y-3 rounded-lg border border-solid border-lobby-footer-line bg-white p-4">
          <h2 className="text-xl font-bold">成れる区域</h2>
          <p className="text-sm leading-relaxed">
            どの陣営でも、自分から見て対面側の3段で成れます。図は南から見た例です。
          </p>
          <PromotionZoneDiagram resolveAsset={resolveDiagramAsset} />
        </section>
        <div className="flex flex-col gap-5 rounded-lg border border-solid border-lobby-footer-line bg-white p-5 leading-relaxed [&_h2]:mb-2 [&_h2]:text-xl [&_section_p+p]:mt-2">
          <FourShogiRules heading="h2" />
        </div>
        {rulesPageSections.map(({ heading, items }) => (
          <section
            key={heading}
            className="space-y-4 rounded-lg border border-solid border-lobby-footer-line bg-white p-5 leading-relaxed"
          >
            <h2 className="text-xl font-bold">{heading}</h2>
            {items.map(({ title, body }) => (
              <div key={title}>
                <h3 className="text-base font-bold">{title}</h3>
                <p className="mt-2">{body}</p>
              </div>
            ))}
          </section>
        ))}
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to={gameCatalog["four-shogi"].lobbyPath}
            state={{ scrollToTop: true }}
            className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-[18px] py-2 text-[15px] font-[650] text-primary-foreground no-underline shadow-action hover:bg-primary-hover focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-4"
          >
            四人将棋で遊ぶ
          </Link>
          <Link
            to={tournamentListPath}
            state={{ scrollToTop: true }}
            className="inline-flex min-h-11 items-center font-bold text-brand underline"
          >
            大会の日程と結果
          </Link>
        </div>
      </main>
    </div>
  );
}
