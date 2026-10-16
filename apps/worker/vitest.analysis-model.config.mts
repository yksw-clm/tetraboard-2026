import config from "./vitest.cpu-model.config.mts";
config.test = {
  ...config.test,
  include: ["test/fourShogiAi.test.ts"],
  testNamePattern: "実モデル解析",
};
export default config;
