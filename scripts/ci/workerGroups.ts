export const workerTestPattern = "test/**/*.test.ts";

export function splitWorkerFiles(files: { path: string; size: number }[]): string[][] {
  const groups = [
    { size: 0, files: [] as string[] },
    { size: 0, files: [] as string[] },
  ];
  // hash分割では大きな対局試験が片側へ偏るため、ソース量を目安に均等化します。
  // 新規ファイルも自動でどちらか一方に入り、手動の除外リストは持ちません。
  for (const file of [...files].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))) {
    const group = groups[0].size <= groups[1].size ? groups[0] : groups[1];
    group.files.push(file.path);
    group.size += file.size;
  }
  return groups.map((group) => group.files.sort()).filter((group) => group.length > 0);
}
