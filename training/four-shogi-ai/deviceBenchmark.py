import argparse
import json
import time
import resource
import sys
import torch
from dataset import LearningData
from model import TinyPolicyValue, batchTensors, supervisedLoss


def benchmark(directory, iterations=12):
    data = LearningData(directory)
    batch = data.splits["train"][:4]
    results = {}
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)
    for device in ("cpu", "mps"):
        if device == "mps" and not torch.backends.mps.is_available():
            results[device] = {"status": "unavailable"}
            continue
        try:
            torch.manual_seed(190)
            model = TinyPolicyValue(32, 8).to(device)
            optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
            timings = []
            cpu = time.process_time()
            for step in range(iterations + 2):
                if device == "mps":
                    torch.mps.synchronize()
                started = time.monotonic()
                optimizer.zero_grad(set_to_none=True)
                policy, value = model(*batchTensors(batch, device))
                loss, _, _ = supervisedLoss(policy, value, batch)
                loss.backward()
                optimizer.step()
                if device == "mps":
                    torch.mps.synchronize()
                if step >= 2:
                    timings.append((time.monotonic() - started) * 1000)
            results[device] = {"status": "completed", "steps": iterations,
                               "medianStepMs": sorted(timings)[len(timings)//2],
                               "cpuSeconds": time.process_time() - cpu,
                               "loss": float(loss.detach().cpu()),
                               "maxRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)}
            del optimizer, model
            if device == "mps":
                torch.mps.empty_cache()
        except Exception as error:
            results[device] = {"status": "failed", "error": str(error)}
    choices = [d for d, r in results.items() if r["status"] == "completed"]
    if not choices:
        raise ValueError("利用できる学習deviceがありません")
    return {"format": "four-shogi-device-benchmark-v1", "batchSize": len(batch),
            "width": 32, "historyWidth": 8, "threads": 1, "results": results,
            "selected": min(choices, key=lambda d: results[d]["medianStepMs"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    from checkpoint import atomicWrite
    result = benchmark(args.data)
    atomicWrite(args.report, json.dumps(result, ensure_ascii=False, indent=2).encode())
    print(json.dumps(result))
