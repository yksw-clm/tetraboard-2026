import { gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { lobbyMetadata } from "./lobbyMetadata";

export function GameIntroduction({ game }: { game: GameId }) {
  const content = lobbyMetadata[game];
  return (
    <section
      aria-label={`${gameCatalog[game].name}の紹介`}
      className="rounded-lg border border-solid border-lobby-footer-line p-5 leading-relaxed"
    >
      <h2 className="text-xl font-bold">ゲーム概要</h2>
      <p className="mt-3">{content.overview}</p>
      <h2 className="mt-5 text-xl font-bold">遊び始め方</h2>
      <p className="mt-3">
        {game === "reversi"
          ? "アプリのインストールやユーザー登録は不要です。「すぐ遊ぶ」でニックネーム・時間設定を選ぶと、CPU1人との待機室へ進みます。ホストが「対局開始」を押してから対局を始めます。"
          : "アプリのインストールやユーザー登録は不要です。「すぐ遊ぶ」でニックネーム・モード・時間設定を選ぶと、CPU3人との待機室へ進みます。ホストが「対局開始」を押してから対局を始めます。"}
      </p>
      <p className="mt-3">
        友人と遊ぶときは「ルームを作る」からURLや5桁のルーム番号を共有してください。人間とCPUで4席を埋め、人間全員が準備完了になったらホストが開始します。公開ルームの観戦もできます。
      </p>
      <h2 className="mt-5 text-xl font-bold">主要ルール</h2>
      {content.rules.map((rule) => (
        <p key={rule} className="mt-3">
          {rule}
        </p>
      ))}
      <p className="mt-3 text-muted">詳しいルールはロビー上部の「遊び方」で確認できます。</p>
    </section>
  );
}
