import type { Plugin } from "vite";

/** Keep the fallback encoder's WASM on our own static asset origin. */
export function webpAssets(): Plugin {
  return {
    name: "webp-asset-boundaries",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      for (const name of ["webp_enc", "webp_enc_simd"]) {
        const asset = Object.values(bundle).find(
          (output) =>
            output.type === "asset" &&
            new RegExp(`^assets/${name}-[^/]+\\.wasm$`).test(output.fileName),
        );
        if (!asset || asset.type !== "asset") this.error(`Missing ${name} WASM asset`);
        const source =
          typeof asset.source === "string" ? new TextEncoder().encode(asset.source) : asset.source;
        if (source[0] !== 0 || source[1] !== 97 || source[2] !== 115 || source[3] !== 109)
          this.error(`Invalid WASM asset: ${asset.fileName}`);
        if (
          !chunks.some((chunk) =>
            ['"', "'", "`"].some((quote) =>
              chunk.code.includes(`${quote}/${asset.fileName}${quote}`),
            ),
          )
        )
          this.error(`WASM must use a same-origin asset URL: ${asset.fileName}`);
      }
      console.info("WebP WASM assets: same-origin URLs and emitted binaries verified");
    },
  };
}
