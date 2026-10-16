export type ServiceConfig = {
  codeVersion: string;
  secret: string;
  host: string;
  port: number;
  python: string;
  modelDirectory: string;
  modelId: string | null;
  workers: number;
  cpuReserved: number;
  maxQueueCpu: number;
  maxQueueAnalysis: number;
  maxJobs: number;
  maxPrincipals: number;
  maxPendingPerPrincipal: number;
  maxRequestBytes: number;
  maxResultBytes: number;
  maxEvents: number;
  maxCpuMs: number;
  maxAnalysisMs: number;
  maxCpuWork: number;
  maxAnalysisWork: number;
  maxQueueMs: number;
  resultTtlMs: number;
  quotaWindowMs: number;
  cpuRequests: number;
  analysisRequests: number;
  cpuBudgetMs: number;
  analysisBudgetMs: number;
  maxRssBytes: number;
  cancelGraceMs: number;
  startupTimeoutMs: number;
};
export const trialServiceLimits = {
  host: "127.0.0.1",
  port: 8790,
  workers: 2,
  cpuReserved: 1,
  maxQueueCpu: 16,
  maxQueueAnalysis: 4,
  maxJobs: 128,
  maxPrincipals: 128,
  maxPendingPerPrincipal: 2,
  maxRequestBytes: 524288,
  maxResultBytes: 1048576,
  maxEvents: 2048,
  maxCpuMs: 500,
  maxAnalysisMs: 30000,
  maxCpuWork: 32768,
  maxAnalysisWork: 1000000,
  maxQueueMs: 10000,
  resultTtlMs: 120000,
  quotaWindowMs: 60000,
  cpuRequests: 120,
  analysisRequests: 6,
  cpuBudgetMs: 60000,
  analysisBudgetMs: 90000,
  maxRssBytes: 939524096,
  cancelGraceMs: 250,
  startupTimeoutMs: 15000,
};
export function loadServiceConfig(env: Record<string, string | undefined>): ServiceConfig {
  const config = {
    ...trialServiceLimits,
    codeVersion: env.AI_CODE_VERSION ?? "",
    secret: env.AI_SHARED_SECRET ?? "",
    python: env.AI_PYTHON ?? "python3",
    modelDirectory: env.AI_MODEL_DIRECTORY ?? "",
    modelId: null as string | null,
  };
  for (const key of Object.keys(trialServiceLimits) as (keyof typeof trialServiceLimits)[]) {
    const name = "AI_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
    if (env[name] !== undefined)
      (config as Record<string, unknown>)[key] = key === "host" ? env[name] : Number(env[name]);
  }
  if (
    !/^[0-9a-f]{40}$/.test(config.codeVersion) ||
    config.secret.length < 32 ||
    config.secret.length > 256 ||
    /\s/.test(config.secret) ||
    config.secret.startsWith("replace-") ||
    !config.modelDirectory
  )
    throw new Error("AI service identity/model configuration is missing");
  for (const [key, value] of Object.entries(config))
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 40))
      throw new Error(`Invalid AI limit: ${key}`);
  if (
    config.workers < 2 ||
    config.workers > 4 ||
    config.cpuReserved >= config.workers ||
    config.port > 65535 ||
    config.maxCpuMs > 500 ||
    config.maxAnalysisMs > 30000 ||
    config.maxAnalysisWork > 1000000 ||
    config.maxCpuWork > config.maxAnalysisWork ||
    config.maxEvents > 2048 ||
    config.maxRequestBytes > 1048576 ||
    config.maxResultBytes > 4194304 ||
    config.resultTtlMs < 120000 ||
    config.resultTtlMs > 3600000
  )
    throw new Error("AI limits exceed the trial envelope");
  return config;
}
