import { expect, test } from "bun:test";
import { avatarPresets } from "@tetraboard/protocol";

test("全プリセットの配信元画像が存在し、WebPとして同梱される", async () => {
  for (const preset of avatarPresets) {
    const file = Bun.file(
      new URL(`../public/assets/avatar-presets/v1/${preset.file}`, import.meta.url),
    );
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe("WEBP");
    expect(bytes.length).toBeLessThan(65536);
  }
});
