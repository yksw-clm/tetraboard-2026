export const formationCatalog = [
  {
    no: 1,
    id: "tenshukaku",
    name: "天守閣玉",
  },
  {
    no: 2,
    id: "right-king",
    name: "右玉",
  },
  {
    no: 3,
    id: "e-shape",
    name: "エの字",
  },
  {
    no: 4,
    id: "riggtosfar",
    name: "リッグトスファー",
  },
  {
    no: 5,
    id: "floating-rook",
    name: "浮き飛車",
  },
  {
    no: 6,
    id: "tenshukaku-subway",
    name: "天守閣地下鉄",
  },
  {
    no: 7,
    id: "tenshukaku-ship",
    name: "天守閣シップ",
  },
  {
    no: 8,
    id: "batto-silver",
    name: "抜刀銀",
  },
  {
    no: 9,
    id: "lower-gold",
    name: "地下鉄飛車・下段金寄せ",
  },
  {
    no: 10,
    id: "yuzuu-muge",
    name: "地下鉄飛車・融通無碍",
  },
  {
    no: 11,
    id: "one-watch-rook",
    name: "１見飛車",
  },
  {
    no: 12,
    id: "king-58",
    name: "５八玉型",
  },
  {
    no: 13,
    id: "teni-muho",
    name: "天衣無縫",
  },
  {
    no: 14,
    id: "tempo-riggtosfar",
    name: "１手得リッグトスファー",
  },
  {
    no: 15,
    id: "silver-28-quick-attack",
    name: "２八銀早仕掛け",
  },
  {
    no: 16,
    id: "five",
    name: "ファイブ",
  },
] as const;
export type FormationId = (typeof formationCatalog)[number]["id"];
