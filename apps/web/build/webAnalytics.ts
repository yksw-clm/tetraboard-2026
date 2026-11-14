import type { Plugin } from "vite";

const webAnalyticsToken = "7c2843b0f00c4711a562009cbfa778bf";
const snippet = `<!-- Cloudflare Web Analytics --><script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${webAnalyticsToken}"}'></script><!-- End Cloudflare Web Analytics -->`;

export function webAnalytics(): Plugin {
  let enabled = false;
  return {
    name: "cloudflare-web-analytics",
    configResolved(config) {
      enabled =
        config.command === "build" &&
        (config.env.VITE_PUBLIC_ORIGIN ?? "https://tetraboard.net") === "https://tetraboard.net";
    },
    transformIndexHtml: {
      // Viteが外部のmoduleスクリプトをバンドルしないよう、HTML処理の最後に挿入します。
      order: "post",
      handler(html) {
        return enabled ? html.replace("</head>", `${snippet}</head>`) : html;
      },
    },
  };
}
