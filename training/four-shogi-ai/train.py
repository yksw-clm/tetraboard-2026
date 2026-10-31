import argparse
import hashlib
import importlib.metadata
import json
import math
import os
import platform
import random
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path
import torch
from dataset import LearningData, FEATURE_VERSION, ACTION_VERSION, VALUE_ORDER, integer, fileHash
from model import TinyPolicyValue, MODEL_VERSION, batchTensors, supervisedLoss, evaluate
from checkpoint import CheckpointStore, CHECKPOINT_VERSION


def codeIdentity():
    directory = Path(__file__).resolve().parent
    digest = hashlib.sha256()
    for name in ["dataset.py", "model.py", "checkpoint.py", "train.py", "requirements.txt"]:
        digest.update(name.encode() + b"\0" + (directory / name).read_bytes())
    root = directory.parent.parent
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain", "--", str(directory)], cwd=root, text=True))
    return {"commit": commit, "dirty": dirty, "sha256": digest.hexdigest()}


def runtime(device, threads):
    return {"python": sys.version, "torch": str(torch.__version__), "platform": platform.platform(),
            "machine": platform.machine(), "device": device, "threads": threads,
            "torchConfig": torch.__config__.show(),
            "dependencies": sorted(f"{d.metadata['Name']}=={d.version}" for d in importlib.metadata.distributions()),
            "environment": {key: os.environ.get(key) for key in ["PYTORCH_ENABLE_MPS_FALLBACK", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"]}}


def trainingValueWeights(rows, mode):
    if mode not in ("none", "inverse-frequency"):
        raise ValueError("Value重み付けの条件が不正です")
    if mode == "none":
        return None
    counts = [sum(row["valueTarget"] == i for row in rows) for i in range(5)]
    present = sum(count > 0 for count in counts)
    if not present:
        raise ValueError("Value重み付けにはtrainのValue教師が必要です")
    return [sum(counts) / (present * count) if count else 0.0 for count in counts]


def trainingLoss(policy, value, rows, weights=None):
    loss, policyLoss, valueLoss = supervisedLoss(policy, value, rows)
    if weights is not None and any(row["valueTarget"] is not None for row in rows):
        targets = torch.tensor([row["valueTarget"] if row["valueTarget"] is not None else -100
                                for row in rows], device=value.device)
        valueLoss = torch.nn.functional.cross_entropy(
            value, targets, weight=value.new_tensor(weights), ignore_index=-100)
        loss = policyLoss + valueLoss
    return loss, policyLoss, valueLoss


def classificationMetrics(result):
    confusion = result["valueConfusion"]
    predicted = [sum(row[i] for row in confusion) for i in range(5)]
    f1 = []
    for i in range(5):
        denominator = predicted[i] + result["valueClasses"][i]
        f1.append(2 * confusion[i][i] / denominator if denominator else 0.0)
    return {**result, "valuePredictedClasses": predicted, "valueF1": f1,
            "valueMacroF1": sum(f1) / 5,
            "noSoleBaselineAccuracy": (result["valueClasses"][4] / result["valueSamples"]
                                       if result["valueSamples"] else None)}


def train(directory, output, *, steps=100, seed=19000, width=64, historyWidth=16,
          batchSize=4, learningRate=0.001, device="cpu", threads=1, checkpointEvery=10,
          maxSeconds=600, maxCheckpointBytes=128 * 1024 ** 2, maxInputBytes=256 * 1024 ** 2,
          allowPolicyOnly=False, allowDirty=False, stopAfterSteps=None,
          warmStart=None, warmStartSha256=None, replayValidation=None, valueWeighting="none"):
    for number, low, high in [(steps, 1, 100000), (seed, 0, 2**31 - 1), (width, 16, 128),
                              (historyWidth, 4, 32), (batchSize, 1, 32), (threads, 1, 8),
                              (checkpointEvery, 1, 10000), (maxSeconds, 1, 86400),
                              (maxCheckpointBytes, 1, 1024**3), (maxInputBytes, 1, 1024**3)]:
        integer(number, low, high)
    if not math.isfinite(learningRate) or not 0.000001 <= learningRate <= 0.1:
        raise ValueError("learningRateが範囲外です")
    if stopAfterSteps is not None:
        integer(stopAfterSteps, 0, 100000)
    if device not in ("cpu", "mps") or (device == "mps" and not torch.backends.mps.is_available()):
        raise ValueError("要求したcpu/mpsを利用できません")
    code = codeIdentity()
    if code["dirty"] and not allowDirty:
        raise ValueError("学習コードをコミットするか、実験時にallow-dirtyを明示してください")
    data = LearningData(directory, maxInputBytes)
    replayData = LearningData(replayValidation, maxInputBytes) if replayValidation else None
    trainRows = data.splits["train"]
    valueWeights = trainingValueWeights(trainRows, valueWeighting)
    if not allowPolicyOnly and not any(row["valueTarget"] is not None for row in trainRows):
        raise ValueError("Value教師がありません。Policyのみの実験はallow-policy-onlyが必要です")
    torch.set_num_threads(threads)
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(seed)
    random.seed(seed)
    sampler = torch.Generator().manual_seed(seed + 1)
    model = TinyPolicyValue(width, historyWidth).to(device)
    parent = None
    parentState = None
    if warmStart is not None or warmStartSha256 is not None:
        import re
        if not warmStart or not re.fullmatch(r"[0-9a-f]{64}", str(warmStartSha256)):
            raise ValueError("warm startには親checkpointと固定SHAの両方が必要です")
        path = Path(warmStart) / (warmStartSha256 + ".pt")
        if path.is_symlink() or path.stat().st_size > maxCheckpointBytes or fileHash(path) != warmStartSha256:
            raise ValueError("親checkpointのchecksum/容量が不一致です")
        parentState = torch.load(path, map_location="cpu", weights_only=True)
        pc = parentState["metadata"]["contract"]
        expected = {"modelVersion": MODEL_VERSION, "featureVersion": FEATURE_VERSION,
                    "actionEncodingVersion": ACTION_VERSION, "valueOrder": VALUE_ORDER,
                    "ruleProfileId": data.manifest["ruleProfileId"], "rulesVersion": data.manifest["rulesVersion"]}
        if (parentState.get("format") != CHECKPOINT_VERSION or
            any(pc.get(k) != v for k, v in expected.items()) or
            pc["config"]["width"] != width or pc["config"]["historyWidth"] != historyWidth):
            raise ValueError("親モデルと特徴/構造/ルール版が不一致です")
        parent = {"checkpointSha256": warmStartSha256, "optimizer": "reset", "rng": "new-run-seed"}
    optimizer = torch.optim.Adam(model.parameters(), lr=learningRate)
    config = {"seed": seed, "width": width, "historyWidth": historyWidth, "batchSize": batchSize,
              "learningRate": learningRate, "allowPolicyOnly": allowPolicyOnly,
              "valueWeighting": valueWeighting, "valueWeights": valueWeights}
    contract = {"modelVersion": MODEL_VERSION, "featureVersion": FEATURE_VERSION,
                "ruleProfileId": data.manifest["ruleProfileId"], "rulesVersion": data.manifest["rulesVersion"],
                "actionEncodingVersion": ACTION_VERSION, "valueOrder": VALUE_ORDER,
                "data": data.identity, "codeHash": code["sha256"], "runtime": runtime(device, threads), "config": config}
    if parent:
        contract["warmStart"] = parent
    if replayData:
        contract["replayValidation"] = replayData.identity
    store = CheckpointStore(output, maxCheckpointBytes)
    interrupted = False
    def stop(_signal, _frame):
        nonlocal interrupted
        interrupted = True
    handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    for sig in handlers:
        signal.signal(sig, stop)
    started, cpuStarted = time.monotonic(), time.process_time()
    completed, history, digest = 0, [], None
    sampledValueClasses = [0] * 5
    try:
        saved = store.load()
        if saved:
            if saved["metadata"]["contract"] != contract:
                raise ValueError("再開元とデータ/版/コード/環境/学習条件が異なります")
            model.load_state_dict(saved["model"], strict=True)
            optimizer.load_state_dict(saved["optimizer"])
            torch.set_rng_state(saved["rng"])
            random.setstate(saved["pythonRng"])
            sampler.set_state(saved["samplerRng"])
            if device == "mps":
                torch.mps.set_rng_state(saved["mpsRng"])
            completed, history = saved["step"], saved["history"]
            sampledValueClasses = saved["sampledValueClasses"]
            code = saved["metadata"]["code"]
        elif parentState is not None:
            model.load_state_dict(parentState["model"], strict=True)
        if steps < completed:
            raise ValueError("stepsは保存済みstep以上にしてください")
        def metrics():
            result = {"step": completed, **{split: classificationMetrics(evaluate(model, data.splits[split], device, batchSize))
                                           for split in ("train", "validation")}}
            if replayData:
                result["replayValidation"] = classificationMetrics(evaluate(model, replayData.splits["validation"], device, batchSize))
            return result
        if not history:
            history.append(metrics())
        def save():
            nonlocal digest
            if history[-1]["step"] != completed:
                history.append(metrics())
            digest = store.save({"format": CHECKPOINT_VERSION, "metadata": {
                "contract": contract, "code": code, "calibrated": False,
                "parameterCount": sum(p.numel() for p in model.parameters())},
                "step": completed, "model": {k: v.detach().cpu() for k, v in model.state_dict().items()},
                "optimizer": optimizer.state_dict(), "rng": torch.get_rng_state(),
                "pythonRng": random.getstate(), "samplerRng": sampler.get_state(),
                "mpsRng": torch.mps.get_rng_state() if device == "mps" else None, "history": history,
                "sampledValueClasses": sampledValueClasses})
        initialStep = completed
        while completed < steps and not interrupted:
            if time.monotonic() - started >= maxSeconds or (stopAfterSteps is not None and completed - initialStep >= stopAfterSteps):
                break
            model.train()
            indices = torch.randint(len(trainRows), (batchSize,), generator=sampler).tolist()
            batch = [trainRows[index] for index in indices]
            optimizer.zero_grad(set_to_none=True)
            policy, value = model(*batchTensors(batch, device))
            loss, _, _ = trainingLoss(policy, value, batch, valueWeights)
            if not bool(torch.isfinite(loss)):
                raise ValueError("学習lossが有限値ではありません")
            loss.backward()
            optimizer.step()
            for row in batch:
                if row["valueTarget"] is not None:
                    sampledValueClasses[row["valueTarget"]] += 1
            completed += 1
            if completed % checkpointEvery == 0:
                save()
        save()
        return {"status": "completed" if completed == steps else "paused", "step": completed,
                "checkpointSha256": digest, "modelId": MODEL_VERSION + ":" + digest, "modelVersion": MODEL_VERSION, "featureVersion": FEATURE_VERSION,
                "calibrated": False, "data": data.identity, "code": code,
                "parameterCount": sum(p.numel() for p in model.parameters()), "history": history,
                "elapsedSeconds": time.monotonic() - started, "cpuSeconds": time.process_time() - cpuStarted,
                "device": device, "threads": threads, "parent": parent,
                "valueWeighting": valueWeighting, "valueWeights": valueWeights,
                "sampledValueClasses": sampledValueClasses,
                "maxRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)}
    finally:
        store.close()
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TS検査済みデータの軽量Policy/Value学習")
    parser.add_argument("--data", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--report")
    for name, default in [("steps", 100), ("seed", 19000), ("width", 64), ("history-width", 16),
                          ("batch-size", 4), ("threads", 1), ("checkpoint-every", 10),
                          ("max-seconds", 600), ("max-checkpoint-bytes", 128 * 1024**2),
                          ("max-input-bytes", 256 * 1024**2)]:
        parser.add_argument("--" + name, type=int, default=default)
    parser.add_argument("--stop-after-steps", type=int)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    parser.add_argument("--allow-policy-only", action="store_true")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--warm-start")
    parser.add_argument("--warm-start-sha256")
    parser.add_argument("--replay-validation")
    parser.add_argument("--value-weighting", choices=["none", "inverse-frequency"], default="none")
    args = vars(parser.parse_args())
    source, output, report = args.pop("data"), args.pop("output"), args.pop("report")
    options = {key.split("_")[0] + "".join(part.title() for part in key.split("_")[1:]): value for key, value in args.items()}
    result = train(source, output, **options)
    text = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    if report:
        target = Path(report).resolve()
        if target.is_relative_to(Path(output).resolve()) or target.is_relative_to(Path(source).resolve()):
            raise ValueError("reportは入力とcheckpointの外に保存してください")
        target.write_text(text)
    print(text, end="")
