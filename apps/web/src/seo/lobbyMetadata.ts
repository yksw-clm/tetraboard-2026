import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";

export const publicOrigin = import.meta.env?.VITE_PUBLIC_ORIGIN ?? "https://tetraboard.net";
export const searchIndexable = import.meta.env?.VITE_SEARCH_INDEXABLE !== "false";

export const lobbyMetadata = {
  shogi: {
    title: "将棋をオンラインで対戦 | TetraBoard",
    description: "通常将棋を友達やCPUと対戦。登録なしで遊べる無料オンライン将棋。",
    overview: "9×9の盤で先手と後手が対戦する将棋です。友達やCPUと対局し、棋譜も閲覧できます。",
    rules: [
      "先手から交互に指し、相手の玉を詰ませます。",
      "取った駒は持ち駒として使えます。二歩・打ち歩詰めなどの反則手は指せません。",
      "千日手、持将棋、入玉宣言に対応します。",
    ],
  },
  reversi: {
    title: "TetraBoard | リバーシをブラウザでオンライン対戦",
    description:
      "リバーシを登録・インストール不要のブラウザでオンライン対戦。CPUとの一人プレイや友人との2人対局、棋譜の閲覧を楽しめます。",
    overview:
      "リバーシは8×8の盤で黒と白の2人が競うボードゲームです。TetraBoardではCPUと一人で遊ぶことも、友人とオンラインで対局することもできます。",
    rules: [
      "黒から交互に石を置き、縦・横・斜めに相手の石を挟んで返します。色は対局ごとにランダムで決まります。",
      "合法手がなければ自動でパスします。相手の石を0枚にする手も置けます。",
      "盤が埋まるか双方が置けなくなると終局し、石数が多い側の勝ち、同数は引き分けです。投了・退室・時間切れ・通信切れの復帰期限切れは敗北です。",
    ],
  },
  "four-reversi": {
    title: "TetraBoard | 四人リバーシをブラウザでオンライン対戦",
    description:
      "四人リバーシを登録・インストール不要のブラウザでオンライン対戦。CPUとの一人プレイや友人との対局、シングルス・ダブルスを楽しめます。",
    overview:
      "四人リバーシ（4人リバーシ）は、8×8の盤で黒・白・赤・青の4色が競うボードゲームです。TetraBoardではCPUと一人で遊ぶことも、友人とオンラインで対局することもできます。",
    rules: [
      "黒→白→赤→青の順に石を置き、縦・横・斜めに他の色を挟んで自分の色へ返します。間に複数の色が混ざっていても、まとめて返せます。",
      "対局を続けている他の人の石を0枚にする全滅手は禁止です。ダブルスの味方も対象です。置ける場所がないときは自動でパスします。",
      "シングルスは最後の石数が多い順に順位を決めます。ダブルスは黒・赤と白・青のチーム戦で、合計石数が多いチームが勝ちます。同数なら同順位・引き分けです。投了・退室・時間切れ・通信切れによる脱落では、シングルスは脱落順、ダブルスは1人の脱落でチーム敗北となります。",
    ],
  },
  "four-shogi": {
    title: "TetraBoard | 四人将棋をブラウザでオンライン対戦",
    description:
      "四人将棋を登録・インストール不要のブラウザでオンライン対戦。CPUとの一人プレイや友人との対局、シングルス・ダブルスを楽しめます。",
    overview:
      "四人将棋（4人将棋）は、9×9の盤を南・西・北・東の4人で囲む将棋です。各9枚の駒を使い、自分の王を守りながら相手の王を詰ませます。TetraBoardではCPUや友人とオンラインで遊べます。",
    rules: [
      "通常は南→西→北→東の時計回りに指します。王手を受けた人の応手を優先し、応手がない王は詰みで脱落します。取った駒は持ち駒として打つことができます。",
      "シングルスは最後の1人まで続け、脱落順で順位を決めます。ダブルスは南・北と西・東のチーム戦で、1人の脱落でそのチームの敗北となります。",
      "三人攻撃禁止は初期値ONで、待機中にホストがON／OFFを切り替えられます。4人が生存するシングルスで、2人が同じ相手への攻撃状態を続けている間、残る1人の新しい攻撃を制限します。王手への応手などには例外があります。",
    ],
  },
} satisfies Record<
  GameId,
  { title: string; description: string; overview: string; rules: string[] }
>;

export function lobbyGameForPath(path: string): GameId | undefined {
  return gameIds.find((game) => path === gameCatalog[game].lobbyPath);
}

export function lobbyCanonical(game: GameId): string {
  return `${publicOrigin}${gameCatalog[game].lobbyPath}`;
}
