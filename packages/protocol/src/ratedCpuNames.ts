import type { CpuProfile } from "./cpuProfiles";

export const ratedCpuNames = {
  shogi: { 128: "フミ", 64: "ヤリ", 256: "ケイ", 512: "ギン", 1024: "リュウ" },
  reversi: {
    mix25: "パチ",
    mix50: "クルリ",
    mix75: "カエシ",
    level1: "セキ",
    level2: "フチ",
    level4: "シメ",
    level8: "クロシロ",
  },
  fourShogi: { 4096: "ヨツメ", 16384: "シテン", 65536: "カコイ" },
} as const;

const savedRatedCpuNames = new Set<string>([
  ...Object.values(ratedCpuNames.shogi),
  ...Object.values(ratedCpuNames.reversi),
  ...Object.values(ratedCpuNames.fourShogi).flatMap((name) => [
    name,
    `${name}1`,
    `${name}2`,
    `${name}3`,
  ]),
]);

type CpuIdentity = { name?: string; cpuProfile?: CpuProfile };

export function cpuDisplayName({ name, cpuProfile }: CpuIdentity): string | undefined {
  if (cpuProfile) return name ?? cpuProfile.name;
  return name && savedRatedCpuNames.has(name) ? name : undefined;
}

export function cpuPlayerAppearance(player: CpuIdentity & { level: 1 | 2 }) {
  const name = cpuDisplayName(player);
  return {
    kind: "cpu" as const,
    level: player.level,
    ...(name === undefined ? {} : { name }),
    ...(player.cpuProfile ? { cpuProfile: player.cpuProfile } : {}),
  };
}
