"""同期Lv2から独立して、当該測定の子孫だけのRSSと壁時計を監視します。"""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--directory", required=True)
    parser.add_argument("--wall-seconds", type=float, default=5400)
    parser.add_argument("--soft-mib", type=int, default=6144)
    parser.add_argument("--hard-mib", type=int, default=7168)
    args = parser.parse_args()
    root = Path(args.directory) / "diagnostics"
    root.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    closing = False
    stopped_at = None
    reason = None
    peak = dict(total=0, aggregation=0, game=0, workers=0, monitor=0)
    groups = set()
    max_workers = 0
    last_saved = 0
    def close(_sig, _frame):
        nonlocal closing
        closing = True
    signal.signal(signal.SIGTERM, close)
    def send(pid, sig):
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
    def kill_groups():
        for pid in groups:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    def write(name, data):
        path = root / name
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, indent=2) + "\n")
        temporary.replace(path)
    write("guard-ready.json", dict(pid=os.getpid(), targetPid=args.pid))
    with (root / "resources.jsonl").open("x") as output:
        while not closing:
            tick = time.monotonic()
            result = subprocess.run(["ps", "-axo", "pid=,ppid=,rss=,command="], capture_output=True, text=True, timeout=3, check=True)
            processes = {}
            for line in result.stdout.splitlines():
                parts = line.strip().split(None, 3)
                if len(parts) == 4:
                    pid, parent, rss = map(int, parts[:3])
                    processes[pid] = (parent, rss * 1024, parts[3])
            if args.pid not in processes:
                reason = reason or "aggregation_parent_exited"
                kill_groups()
                break
            descendants = {args.pid}
            while True:
                found = {pid for pid, row in processes.items() if row[0] in descendants}
                updated = descendants | found
                if updated == descendants:
                    break
                descendants = updated
            rss = dict(total=0, aggregation=0, game=0, workers=0, monitor=0)
            worker_count = 0
            for pid in descendants:
                parent, memory, command = processes[pid]
                if pid == args.pid:
                    role = "aggregation"
                elif pid == os.getpid() or parent == os.getpid():
                    role = "monitor"
                elif "strengthGameWorker.ts" in command:
                    role = "game"
                    groups.add(pid)
                elif "/search/worker.ts" in command:
                    role = "workers"
                    worker_count += 1
                else:
                    role = "game"
                rss[role] += memory
                rss["total"] += memory
            peak = {key: max(peak[key], value) for key, value in rss.items()}
            max_workers = max(max_workers, worker_count)
            elapsed = time.monotonic() - started
            if elapsed - last_saved >= 1 or rss["total"] > args.soft_mib * 1024**2:
                output.write(json.dumps(dict(elapsedSeconds=elapsed, rssBytes=rss, workers=worker_count)) + "\n")
                output.flush()
                last_saved = elapsed
                write("resource-summary.json", dict(peakBytes=peak, maxWorkers=max_workers, reason=reason, elapsedSeconds=elapsed))
            if stopped_at is None and (rss["total"] >= args.soft_mib * 1024**2 or worker_count > 8 or elapsed >= max(0, args.wall_seconds - 15)):
                reason = "soft_memory_limit" if rss["total"] >= args.soft_mib * 1024**2 else "worker_limit" if worker_count > 8 else "wall_clock_limit"
                stopped_at = elapsed
                write("guard-stop.json", dict(reason=reason, elapsedSeconds=elapsed, rssBytes=rss))
                send(args.pid, signal.SIGINT)
            if rss["total"] >= args.hard_mib * 1024**2 or elapsed >= max(0, args.wall_seconds - 2):
                kill_groups()
                send(args.pid, signal.SIGINT)
            if elapsed >= args.wall_seconds:
                kill_groups()
                send(args.pid, signal.SIGKILL)
                break
            time.sleep(max(0, 0.1 - (time.monotonic() - tick)))
    write("resource-summary.json", dict(peakBytes=peak, maxWorkers=max_workers, reason=reason, elapsedSeconds=time.monotonic() - started, samplingMs=100))


if __name__ == "__main__":
    main()
