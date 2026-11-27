export const boardPostPath = (id: string) => `/posts/${encodeURIComponent(id)}`;

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

export function boardPostExcerpt(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  let count = 0;
  for (const { index } of segmenter.segment(normalized)) {
    if (count === limit) return `${normalized.slice(0, index)}…`;
    count++;
  }
  return normalized;
}
