export function processMetrics(usage: ReturnType<Bun.Subprocess["resourceUsage"]>) {
  if (!usage) return null;
  return {
    cpu_user_us: Number(usage.cpuTime.user),
    cpu_system_us: Number(usage.cpuTime.system),
    cpu_total_us: Number(usage.cpuTime.total),
    max_rss_bytes: Number(usage.maxRSS),
  };
}
