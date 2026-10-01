import { healthzContract, listRoomsContract } from "../packages/protocol/src/index";

const origin = process.argv[2];
if (!origin) throw new Error("Usage: bun scripts/checkDeployment.ts <origin>");
const base = new URL(origin);
if (!["http:", "https:"].includes(base.protocol)) throw new Error("Expected an HTTP(S) URL");

async function check(path: string, validate: (response: Response) => Promise<void>) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(new URL(path, base), {
        signal: AbortSignal.timeout(10_000),
        headers: { "Cache-Control": "no-cache" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await validate(response);
      console.log(`OK ${path}`);
      return;
    } catch (error) {
      if (attempt === 5) throw new Error(`Deployment check failed: ${path}`, { cause: error });
      await Bun.sleep(2_000);
    }
  }
}

await check("/", async (response) => {
  if (!response.headers.get("content-type")?.includes("text/html"))
    throw new Error("Expected HTML");
  if (!(await response.text()).includes('id="root"')) throw new Error("SPA root is missing");
});
await check("/api/healthz", async (response) => {
  healthzContract.response.parse(await response.json());
});
await check("/api/rooms", async (response) => {
  listRoomsContract.response.parse(await response.json());
});
