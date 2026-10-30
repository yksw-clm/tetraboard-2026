import { workerTestConfig } from "./vitest.config.mts";

const url = process.env.CI_ISOLATION_BARRIER;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url))
  throw new Error("ローカルの分離検証barrierを指定してください");
const config = workerTestConfig({ CI_ISOLATION_BARRIER: url });
config.test = { ...config.test, include: ["test/isolationProbe.ts"] };
export default config;
