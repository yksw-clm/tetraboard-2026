import { readFile } from "node:fs/promises";

const config = JSON.parse(
  await readFile(new URL("../apps/worker/wrangler.jsonc", import.meta.url), "utf8"),
);
const development = config.env.development;
const production = config.env.production;
const database = development.d1_databases[0];
if (
  development.name !== "tetraboard-dev" ||
  database.database_id.startsWith("00000000-") ||
  database.database_id === production.d1_databases[0].database_id ||
  development.r2_buckets[0].bucket_name === production.r2_buckets[0].bucket_name
)
  throw new Error("開発専用D1・R2を準備し、wrangler.jsoncの開発用DB IDを設定してください。");
