import { legalDocuments, legalVersion } from "@tetraboard/protocol/privacy";
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export async function legalHtml(
  request: Request,
  assets: Fetcher,
  kind: keyof typeof legalDocuments,
) {
  const response = await assets.fetch(
    new Request(new URL("/index.html", request.url), { method: "GET" }),
  );
  if (!response.ok) return response;
  const doc = legalDocuments[kind];
  const body = `<main class="app-theme mx-auto max-w-[600px] p-5 flex flex-col gap-5"><h1>${escape(doc.title)}</h1><p>TetraBoard・chaossi　文書版・改定日：${legalVersion}</p>${doc.sections.map(([title, text]) => `<section><h2>${escape(title)}</h2><p>${escape(text)}</p></section>`).join("")}<p><a href="mailto:support@tetraboard.net">support@tetraboard.net</a></p><nav><a href="/terms">利用規約</a> <a href="/privacy">プライバシーポリシー</a> <a href="/games/four-reversi">ロビーへ</a></nav></main>`;
  const html = (await response.text())
    .replace(/<title>.*?<\/title>/s, `<title>${doc.title} | TetraBoard</title>`)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
  return new Response(request.method === "HEAD" ? null : html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
