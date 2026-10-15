import argparse
import importlib.metadata
import json
import math
import os
import platform
import resource
import statistics
import subprocess
import sys
import time
from pathlib import Path
import torch
from dataset import fileHash, integer
from inference import (PROTOCOL, VERSIONS, MAX_FRAME, infer, loadModel, readJson, codeHash, compareOutputs)
from model import batchTensors

def compare(reference, actual):
    for key in ["modelId", "weightsSha256", "fixtureSha256", "versions", "codeHash"]:
        if reference[key] != actual[key]:
            raise ValueError("共通fixture/モデル/コードが不一致です: " + key)
    return compareOutputs(reference["rows"], actual["rows"])


def summary(samples):
    ordered = sorted(samples)
    return {"iterations": len(samples), "meanMs": statistics.mean(samples),
            "p95Ms": ordered[math.ceil(len(samples) * 0.95) - 1], "maxMs": max(samples)}


def workerMeasurement(modelPath, fixturePath, meta, rows, repeat):
    start = time.perf_counter()
    worker = subprocess.Popen([sys.executable, str(Path(__file__).with_name("inference.py")), "serve",
                               "--model", str(modelPath), "--fixture", str(fixturePath)],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    def read():
        value = json.loads(worker.stdout.readline(MAX_FRAME + 1))
        if value.get("protocol") != PROTOCOL or not value["ok"]:
            raise ValueError("常駐プロセスが失敗しました: " + str(value))
        return value
    try:
        ready = read()
        startup = (time.perf_counter() - start) * 1000
        timings = []
        for index in range(repeat):
            request = {"protocol": PROTOCOL, "id": index + 1, "op": "evaluate", **VERSIONS,
                       "modelId": meta["modelId"], "rows": rows}
            started = time.perf_counter()
            worker.stdin.write((json.dumps(request) + "\n").encode())
            worker.stdin.flush()
            result = read()
            if result["id"] != index + 1 or result["result"]["modelId"] != meta["modelId"]:
                raise ValueError("IPCの要求ID/モデルIDが不一致です")
            timings.append((time.perf_counter() - started) * 1000)
        return {"startupIncludingImportMs": startup, "batchSize": len(rows),
                "roundTrip": summary(timings), "ready": ready, "processes": 1}
    finally:
        worker.stdin.close()
        try:
            worker.wait(timeout=10)
        except subprocess.TimeoutExpired:
            worker.kill()
            worker.wait()


def smoke(modelPath, fixturePath, device, repeat, reference=None):
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    fixture = readJson(fixturePath, MAX_FRAME)
    if fixture["format"] != "four-shogi-inference-fixture-v1":
        raise ValueError("fixtureの形式が不一致です")
    for key in ["featureVersion", "actionEncodingVersion", "rulesVersion", "ruleProfileId", "valueOrder"]:
        if fixture[key] != VERSIONS[key]:
            raise ValueError("fixtureの版/席順が不一致です")
    started = time.perf_counter()
    model, meta = loadModel(modelPath)
    if device == "mps" and not torch.backends.mps.is_available():
        raise ValueError("MPSを利用できません")
    model = model.to(device)
    rows = infer(model, meta, fixture["rows"], device)
    if device == "mps":
        torch.mps.synchronize()
    loadMs = (time.perf_counter() - started) * 1000
    timings = {}
    for size in [1, 4, len(fixture["rows"])]:
        batch = fixture["rows"][:size]
        for _ in range(3):
            infer(model, meta, batch, device)
        samples = []
        for _ in range(repeat):
            started = time.perf_counter()
            infer(model, meta, batch, device)
            if device == "mps":
                torch.mps.synchronize()
            samples.append((time.perf_counter() - started) * 1000)
        timings[str(size)] = {**summary(samples), "positionsPerSecond": size * 1000 / statistics.mean(samples)}
    for row, output in zip(fixture["rows"], rows):
        current = dict(zip(row["features"]["current"]["indices"], row["features"]["current"]["values"]))
        for side in range(4):
            if current.get(2689 + side, 0) == 0 and output["value"][side] != 0:
                raise ValueError("脱落者のValueが0ではありません")
    result = {"format": "four-shogi-inference-measurement-v1", "modelId": meta["modelId"],
              "weightsSha256": meta["weights"]["sha256"], "fixtureSha256": fileHash(fixturePath),
              "codeHash": codeHash(), "versions": VERSIONS, "calibrated": False,
              "runtime": {"python": sys.version, "torch": str(torch.__version__), "platform": platform.platform(),
                          "machine": platform.machine(), "device": device, "threads": torch.get_num_threads(),
                          "torchConfig": torch.__config__.show(), "cpuCount": os.cpu_count(),
                          "dependencies": sorted(f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions())},
              "packageBytes": sum(p.stat().st_size for p in Path(modelPath).iterdir()),
              "loadAndProbeMs": loadMs, "direct": timings, "rows": rows}
    result["batchComparisons"] = {}
    for size in [1, 4]:
        separate = []
        for offset in range(0, len(fixture["rows"]), size):
            separate.extend(infer(model, meta, fixture["rows"][offset:offset + size], device))
        result["batchComparisons"][str(size)] = compareOutputs(rows, separate)
    if device == "cpu":
        result["persistentWorker"] = workerMeasurement(modelPath, fixturePath, meta, fixture["rows"][:4], repeat)
        try:
            torch.export.export(model, batchTensors(fixture["rows"][:1], "cpu"))
            result["exportExperiment"] = {"exported": True, "adopted": False, "reason": "可変履歴と全fixtureの適合確認が別途必要です"}
        except Exception as error:
            result["exportExperiment"] = {"exported": False, "adopted": False,
                                          "error": type(error).__name__, "reason": str(error)[:1600]}
    result["peakRssBytes"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    result["workerPeakRssBytes"] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    if reference:
        result["comparison"] = compare(readJson(reference, MAX_FRAME), result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--fixture", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reference")
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    parser.add_argument("--repeat", type=int, default=30)
    args = parser.parse_args()
    result = smoke(args.model, args.fixture, args.device, integer(args.repeat, 1, 1000), args.reference)
    with Path(args.output).open("x") as target:
        json.dump(result, target, ensure_ascii=False, indent=2, allow_nan=False)
    print(json.dumps({key: result[key] for key in ["modelId", "runtime", "loadAndProbeMs", "direct", "peakRssBytes"]}, ensure_ascii=False))
