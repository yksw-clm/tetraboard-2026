import { gameCatalog } from "@tetraboard/protocol/games";
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
        <div>
          <Link
            to={gameCatalog["four-shogi"].lobbyPath}
            state={{ scrollToTop: true }}
            className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-[18px] py-2 text-[15px] font-[650] text-primary-foreground no-underline shadow-action hover:bg-primary-hover focus-visible:outline-[3px] focus-visible:outline-focus focus-visible:outline-offset-4"
          >
            四人将棋で遊ぶ
          </Link>
        </div>
      </main>
    </div>
  );
}
