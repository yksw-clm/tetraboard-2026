import { gameCapacity } from "@tetraboard/protocol/games";
import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { lobbyMetadata } from "./lobbyMetadata";
import { lobbyQuestions } from "./lobbyQuestions";

export function GameIntroduction({ game }: { game: GameId }) {
  const content = lobbyMetadata[game];
  const questions = lobbyQuestions[game];
  return (
    <section
      aria-label={`${gameCatalog[game].name}の紹介`}
      className={`rounded-lg border border-solid border-lobby-footer-line p-5 leading-relaxed ${questions ? "bg-white" : ""}`}
    >
      <h2 className="text-xl font-bold">ゲーム概要</h2>
      <p className="mt-3">{content.overview}</p>
      {questions ? (
        <>
          <h2 className="mt-5 text-xl font-bold">ひとりでCPUと遊ぶ</h2>
          <p className="mt-3">
            通常ルームでの対局は、アプリのインストールやユーザー登録は不要です。人間が4人集まらなくても、CPUを交えて遊べます。
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>ロビー上部の「CPUと遊ぶ」を押します。</li>
            <li>
              名前・モード・時間設定などを選ぶと、CPU3人との待機室へ進みます。ログイン中はプロフィールの名前を使います。
            </li>
            <li>ホストが「対局開始」を押すと対局が始まります。</li>
          </ol>
          <h2 className="mt-5 text-xl font-bold">友人とオンラインで遊ぶ</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>ロビー上部の「公開ルームを作る」から部屋を作成します。</li>
            <li>部屋の招待URLを友人へ共有し、それぞれの端末から参加してもらいます。</li>
            <li>人数が足りなければ、ホストがCPUを追加して、人間とCPUで4席を埋めます。</li>
            <li>人間全員が「準備完了」にし、ホストが「対局開始」を押します。</li>
          </ol>
          <p className="mt-3">
            招待URLを共有した部屋も公開ルーム一覧に掲載され、他の人が参加・観戦できます。全員が準備完了になっても、自動では始まりません。
          </p>
        </>
      ) : (
        <>
          <h2 className="mt-5 text-xl font-bold">遊び始め方</h2>
          <p className="mt-3">
            {!gameCatalog[game].hasModes
              ? "アプリのインストールやユーザー登録は不要です。「CPUと遊ぶ」でニックネーム・時間設定を選ぶと、CPU1人との待機室へ進みます。ホストが「対局開始」を押してから対局を始めます。"
              : "アプリのインストールやユーザー登録は不要です。「CPUと遊ぶ」でニックネーム・モード・時間設定を選ぶと、CPU3人との待機室へ進みます。ホストが「対局開始」を押してから対局を始めます。"}
          </p>
          <p className="mt-3">
            友人と遊ぶときは「公開ルームを作る」から招待URLを共有してください。公開ルーム一覧からも参加できます。人間とCPUで
            {gameCapacity(game)}
            席を埋め、人間全員が準備完了になったらホストが開始します。公開ルームの観戦もできます。
          </p>
        </>
      )}
      <h2 className="mt-5 text-xl font-bold">
        {questions ? "TetraBoardの主要ルール" : "主要ルール"}
      </h2>
      {content.rules.map((rule) => (
        <p key={rule} className="mt-3">
          {rule}
        </p>
      ))}
      {questions ? (
        <>
          <h2 className="mt-5 text-xl font-bold">よくある質問</h2>
          {questions.map(({ question, answer }) => (
            <div key={question} className="mt-4">
              <h3 className="text-base font-bold">{question}</h3>
              <p className="mt-2">{answer}</p>
            </div>
          ))}
          <a
            href="/how-to-play"
            className="mt-5 inline-flex min-h-11 items-center font-bold text-brand underline"
          >
            詳しい遊び方を見る
          </a>
        </>
      ) : null}
      <p className="mt-3 text-muted">詳しいルールはロビー上部の「遊び方」で確認できます。</p>
    </section>
  );
}
