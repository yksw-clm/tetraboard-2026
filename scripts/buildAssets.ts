import { cp, mkdir, rm } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const target = new URL("apps/worker/dist/assets/", root);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL("apps/web/dist/", root), target, { recursive: true });
await cp(new URL("apps/admin/dist/", root), new URL("admin/", target), { recursive: true });
