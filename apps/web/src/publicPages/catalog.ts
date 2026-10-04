import { gameCatalog, gameIds, type GameId } from "@tetraboard/protocol/games";

export const publicOrigin = "https://tetraboard.net";
export type PublicPageKind = "lobby" | "rules";
export const gameIntroductions = {
  "four-reversi": {
    short: "4色で楽しむ、4人対戦のリバーシ。",
    description:
      "四人リバーシ（4人リバーシ）をブラウザでオンライン対戦。登録なしでCPUと遊べるほか、友達とシングルス・ダブルスを楽しめます。",
    introduction:
      "四人リバーシは、黒・白・赤・青の4色で遊ぶリバーシです。8×8の盤で相手の石を挟み、自分の色を増やします。一人ずつ競うシングルスと、向かい合う2人で協力するダブルスを選べます。",
  },
  "four-shogi": {
    short: "4方向から楽しむ、4人対戦の将棋。",
    description:
      "四人将棋（4人将棋）をブラウザでオンライン対戦。登録なしでCPUと遊べるほか、友達とシングルス・ダブルスを楽しめます。",
    introduction:
      "四人将棋は、9×9の盤を南・西・北・東の4人で囲んで遊ぶ将棋です。各陣営9枚の駒で、王手、成り、持ち駒を使って競います。最後の一人を目指すシングルスと、対面の2人で協力するダブルスを選べます。",
  },
} satisfies Record<GameId, { short: string; description: string; introduction: string }>;

export const publicPages = {
  "four-reversi": {
    lobby: {
      path: gameCatalog["four-reversi"].lobbyPath,
      title: "四人リバーシをオンラインで遊ぶ｜TetraBoard",
      description: gameIntroductions["four-reversi"].description,
    },
    rules: {
      path: `${gameCatalog["four-reversi"].lobbyPath}/rules`,
      title: "四人リバーシのルール・遊び方｜TetraBoard",
      description:
        "四人リバーシのルールと遊び方。4色の初期配置、石の置き方、自動パス、シングルスの順位、ダブルスの勝敗、持ち時間を紹介します。",
    },
  },
  "four-shogi": {
    lobby: {
      path: gameCatalog["four-shogi"].lobbyPath,
      title: "四人将棋をオンラインで遊ぶ｜TetraBoard",
      description: gameIntroductions["four-shogi"].description,
    },
    rules: {
      path: `${gameCatalog["four-shogi"].lobbyPath}/rules`,
      title: "四人将棋のルール・遊び方｜TetraBoard",
      description:
        "四人将棋のルールと遊び方。9×9盤の初期配置、駒の動き、成り、持ち駒、王手による手番、三人攻撃禁止、シングルス・ダブルスの勝敗を紹介します。",
    },
  },
} satisfies {
  [G in GameId]: {
    [K in PublicPageKind]: {
      path: K extends "lobby"
        ? (typeof gameCatalog)[G]["lobbyPath"]
        : `${(typeof gameCatalog)[G]["lobbyPath"]}/rules`;
      title: string;
      description: string;
    };
  };
};

export function findPublicPage(path: string) {
  for (const game of gameIds) {
    for (const kind of ["lobby", "rules"] as const) {
      const page = publicPages[game][kind];
      if (page.path === path) return { game, kind, ...page };
    }
  }
  return null;
}
