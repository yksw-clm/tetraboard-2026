// 親がSIGKILL/スリープ復帰で監視できない場合も、工程のプロセス群を期限で回収する。
if (import.meta.main) {
  const [parent, group, deadline] = process.argv.slice(2).map(Number);
  if (![parent, group, deadline].every(Number.isSafeInteger) || parent < 2 || group < 2)
    throw new Error("watchdog引数が不正です");
  const exists = (id: number) => {
    try {
      process.kill(id, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM" && id < 0) {
        const ps = Bun.spawnSync(["ps", "-axo", "pgid=,stat="]);
        if (ps.exitCode !== 0) throw error;
        const states = ps.stdout
          .toString()
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/))
          .filter((row) => Number(row[0]) === -id);
        if (!states.length || states.every((row) => row[1].startsWith("Z"))) return false;
      }
      throw error;
    }
  };
  let stopping: number | null = null;
  const timer = setInterval(() => {
    if (!exists(-group)) {
      clearInterval(timer);
      return;
    }
    if (!exists(parent) || Date.now() >= deadline || stopping !== null) {
      stopping ??= Date.now();
      try {
        process.kill(-group, Date.now() - stopping > 1500 ? "SIGKILL" : "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }, 500);
}
