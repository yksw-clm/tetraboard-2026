"""事前選定12局面の条件別RSSを、思考区間と検証区間を分けて補足計測します。"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from datetime import datetime

root = Path(sys.argv[1]).resolve()
plan_name = sys.argv[2] if len(sys.argv) > 2 else "quality-plan-v2.json"
plan = json.loads((root / plan_name).read_text())
registered = datetime.fromisoformat(plan["registeredAt"].replace("Z", "+00:00")).timestamp()
started = time.monotonic()
rows = []
directory = root / "validation" / "memory-trials"
directory.mkdir(exist_ok=True)
for index, case in enumerate(plan["warm"]):
    conditions = plan["conditions"]["matrix"]
    offset = index % len(conditions)
    for condition in conditions[offset:] + conditions[:offset]:
        if time.time() - registered >= 90 * 60 or time.monotonic() - started >= 8 * 60:
            raise SystemExit("RSS補足計測の時間上限")
        stem = directory / (case + "-" + condition)
        command = ["bun", "apps/four-shogi-study/bench/lethalGuardMemory.ts", str(root), case, condition, plan_name]
        with stem.with_suffix(".log").open("w") as log:
            proc = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            begin = time.monotonic()
            samples = []
            peak = 0
            stopped = None
            while proc.poll() is None:
                tick = time.monotonic()
                output = subprocess.check_output(["ps", "-axo", "pid=,ppid=,rss="], text=True)
                processes = {int(x[0]): (int(x[1]), int(x[2]) * 1024) for line in output.splitlines() if len(x := line.split()) == 3}
                descendants = {proc.pid}
                while True:
                    found = descendants | {pid for pid, (parent, _) in processes.items() if parent in descendants}
                    if found == descendants:
                        break
                    descendants = found
                rss = sum(processes[p][1] for p in descendants if p in processes)
                samples.append({"at": time.time() * 1000, "rssBytes": rss})
                peak = max(peak, rss)
                if rss >= 6144 * 1024**2 or time.monotonic() - begin > 30:
                    stopped = "rss" if rss >= 6144 * 1024**2 else "wall"
                    os.killpg(proc.pid, signal.SIGKILL)
                    break
                time.sleep(max(0, .025 - (time.monotonic() - tick)))
            code = proc.wait()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        start_file = Path(str(stem) + ".started.json")
        end_file = Path(str(stem) + ".ended.json")
        first = json.loads(start_file.read_text())["at"] if start_file.exists() else None
        last = json.loads(end_file.read_text())["at"] if end_file.exists() else None
        think = [s["rssBytes"] for s in samples if first is not None and last is not None and first <= s["at"] <= last]
        row = {"caseId": case, "condition": condition, "exitCode": code, "stop": stopped,
               "peakTotalBytes": peak, "thinkingPeakBytes": max(think) if think else None,
               "thinkingSamples": len(think), "samples": samples,
               "scope": "fresh parent/runtime/workers; 25ms sample; post-response proof verification excluded from thinking peak"}
        rows.append(row)
        (root / "validation/memory-comparison.json").write_text(json.dumps({"source": plan["source"], "rows": rows}, indent=2) + "\n")
        print(case, condition, code, flush=True)
        if code or stopped:
            raise SystemExit(1)
