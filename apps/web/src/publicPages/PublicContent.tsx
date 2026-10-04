import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";
import { gameIntroductions, publicPages } from "./catalog";

export type RulesContent = { html: string; headings: { id: string; title: string }[] };

export function PublicGameNavigation() {
  return (
    <nav aria-label="公開ゲーム">
      <ul className="flex flex-wrap gap-4">
        {gameIds.map((game) => (
          <li key={game}>
            <a href={publicPages[game].lobby.path} className="text-brand underline">
              {gameCatalog[game].name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
export function GameIntroduction({ game }: { game: GameId }) {
  return (
    <section
      aria-labelledby="game-introduction"
      className="rounded-lg border border-lobby-footer-line p-5 leading-relaxed"
    >
      <h2 id="game-introduction" className="text-xl font-bold">
        {gameCatalog[game].name}をブラウザで遊ぼう
      </h2>
      <p className="mt-3">{gameIntroductions[game].introduction}</p>
      <p className="mt-3">
        アプリのインストールやユーザー登録なしで遊べます。「すぐ遊ぶ」からCPU3人との待機室へ進み、「対局開始」を押してください。友達とオンラインで遊ぶときは「ルームを作る」からURLや5桁のルーム番号を共有できます。
      </p>
      <p className="mt-3">
        <a
          className="text-brand underline inline-flex min-h-11 items-center"
          href={publicPages[game].rules.path}
        >
          {gameCatalog[game].name}のルール・遊び方
        </a>
      </p>
    </section>
  );
}
export function PublicRulesContent({ game, content }: { game: GameId; content: RulesContent }) {
  return (
    <main
      className={`app-theme ${game === "four-shogi" ? "game-theme-four-shogi" : ""} public-rules max-w-[900px] mx-auto px-5 py-6 leading-relaxed`}
    >
      <PublicGameNavigation />
      <h1 className="mt-6 text-3xl font-bold">{gameCatalog[game].name}のルール・遊び方</h1>
      <p className="mt-4">TetraBoardで採用しているルールです。</p>
      <a
        className="text-brand underline inline-flex min-h-11 items-center"
        href={publicPages[game].lobby.path}
      >
        {gameCatalog[game].name}を遊ぶ
      </a>
      <nav aria-label="ルールの目次" className="my-5 rounded-lg border p-4">
        <h2 className="font-bold">目次</h2>
        <ul>
          {content.headings.map((heading) => (
            <li key={heading.id}>
              <a
                className="text-brand underline inline-flex min-h-9 items-center"
                href={`#${heading.id}`}
              >
                {heading.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <article dangerouslySetInnerHTML={{ __html: content.html }} />
      <a
        className="text-brand underline inline-flex min-h-11 items-center mt-6"
        href={publicPages[game].lobby.path}
      >
        {gameCatalog[game].name}を遊ぶ
      </a>
    </main>
  );
}
