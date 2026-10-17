import argparse
import hashlib
import io
import json
import math
import re
import shutil
import sys
from pathlib import Path
import torch
from checkpoint import CHECKPOINT_VERSION, atomicWrite
from dataset import (FEATURE_VERSION, ACTION_VERSION, CURRENT_SIZE, HISTORY_SIZE,
                     ACTION_SIZE, VALUE_ORDER, fileHash, integer, validateSparse)
from model import MODEL_VERSION, TinyPolicyValue, batchTensors

FORMAT = "four-shogi-inference-v1"
PROTOCOL = "four-shogi-inference-ipc-v1"
MAX_FRAME = 16 * 1024 ** 2
MAX_WEIGHTS = 32 * 1024 ** 2
MAX_BATCH, MAX_HISTORY = 16, 4096
RUNTIME = {"python": "3.12", "torch": "2.14.1", "device": "cpu"}
ABS_TOLERANCE, REL_TOLERANCE = 1e-5, 1e-4
VERSIONS = {"modelVersion": MODEL_VERSION, "featureVersion": FEATURE_VERSION,
            "actionEncodingVersion": ACTION_VERSION, "ruleProfileId": "tetraboard-four-shogi-singles-v1",
            "rulesVersion": 1, "valueOrder": VALUE_ORDER}


def codeHash():
    digest = hashlib.sha256()
    for name in ["inference.py", "model.py", "dataset.py", "checkpoint.py", "requirements.txt"]:
        digest.update(name.encode() + b"\0" + Path(__file__).with_name(name).read_bytes())
    return digest.hexdigest()


def readJson(path, limit):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("manifest/重みの欠落、symlinkまたは容量上限です")
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError("manifest/fixtureはobjectが必要です")
    return value


def checkVersions(contract):
    if any(contract.get(key) != value for key, value in VERSIONS.items()):
        raise ValueError("モデル/特徴/行動/席/ルール版が不一致です")


def compareOutputs(expected, actual):
    if len(expected) != len(actual):
        raise ValueError("比較件数が不一致です")
    maximum = {"policyLogits": 0.0, "policy": 0.0, "value": 0.0}
    for left, right in zip(expected, actual):
        for key in ["id", "legalActionIds", "topActionId", "illegalPolicyNonzero"]:
            if left[key] != right[key]:
                raise ValueError("行動ID/合法手/最良手が不一致です: " + key)
        for key in maximum:
            if len(left[key]) != len(right[key]):
                raise ValueError("Policy/Valueの次元が不一致です")
            for a, b in zip(left[key], right[key]):
                if not math.isfinite(a) or not math.isfinite(b) or not math.isclose(a, b, abs_tol=ABS_TOLERANCE, rel_tol=REL_TOLERANCE):
                    raise ValueError("数値許容誤差を超えています: " + key)
                maximum[key] = max(maximum[key], abs(a - b))
    return {"passed": True, "absoluteTolerance": ABS_TOLERANCE, "relativeTolerance": REL_TOLERANCE,
            "maxAbsoluteError": maximum, "topActionAgreement": len(actual)}


def exportModel(checkpoint, destination, fixturePath):
    source, target = Path(checkpoint), Path(destination)
    if target.resolve().is_relative_to(source.resolve()):
        raise ValueError("推論出力は学習checkpointの外へ作成してください")
    manifest = readJson(source / "latest.json", 1024 ** 2)
    digest = manifest.get("sha256")
    if manifest.get("format") != CHECKPOINT_VERSION or not re.fullmatch(r"[0-9a-f]{64}", str(digest)):
        raise ValueError("学習checkpointの形式/hashが不正です")
    weight = source / (digest + ".pt")
    if weight.is_symlink() or weight.stat().st_size > 128 * 1024 ** 2 or fileHash(weight) != digest:
        raise ValueError("学習checkpointのchecksum/容量が不一致です")
    saved = torch.load(weight, map_location="cpu", weights_only=True)
    if saved.get("format") != CHECKPOINT_VERSION or saved.get("metadata") != manifest.get("metadata"):
        raise ValueError("学習checkpointとmanifestが不一致です")
    metadata = saved["metadata"]
    contract = metadata["contract"]
    checkVersions(contract)
    if metadata.get("calibrated") is not False:
        raise ValueError("未校正モデルの契約が不一致です")
    config = {key: contract["config"][key] for key in ("width", "historyWidth")}
    model = checkedModel(saved["model"], config)
    package = {"format": FORMAT, **VERSIONS, "runtime": RUNTIME, "codeHash": codeHash(),
               "supportedRestrictions": [False, True], "calibrated": False, "config": config,
               "modelId": MODEL_VERSION + ":" + digest,
               "training": {"checkpointSha256": digest, "metadata": metadata, "step": saved["step"]}}
    fixture = readJson(fixturePath, MAX_FRAME)
    checkVersions({**fixture, "modelVersion": MODEL_VERSION})
    if (fixture.get("format") != "four-shogi-inference-fixture-v1" or
        {r["restricted"] for r in fixture["rows"]} != {False, True} or
        {r["turn"] for r in fixture["rows"]} != set(VALUE_ORDER[:4])):
        raise ValueError("基準fixtureには両設定と全4手番が必要です")
    probe = {"format": "four-shogi-inference-probe-v1", "fixtureSha256": fileHash(fixturePath),
             "rows": fixture["rows"], "expected": infer(model, package, fixture["rows"])}
    probeData = json.dumps(probe, ensure_ascii=False, allow_nan=False).encode()
    package["probe"] = {"file": "probe.json", "sha256": hashlib.sha256(probeData).hexdigest(), "bytes": len(probeData)}
    stream = io.BytesIO()
    torch.save({"metadata": package, "model": model.state_dict()}, stream)
    data = stream.getvalue()
    artifactHash = hashlib.sha256(data).hexdigest()
    package = {**package, "weights": {"file": artifactHash + ".pt", "sha256": artifactHash, "bytes": len(data)}}
    # 推論配布物にはAdam・乱数を含めず、元checkpointのIDと学習由来を保持します。
    target.mkdir()
    try:
        atomicWrite(target / package["weights"]["file"], data)
        atomicWrite(target / "probe.json", probeData)
        atomicWrite(target / "manifest.json", json.dumps(package, ensure_ascii=False, indent=2).encode())
        loadModel(target)
    except BaseException:
        shutil.rmtree(target)
        raise
    return package


def checkedModel(weights, config):
    if set(config) != {"width", "historyWidth"}:
        raise ValueError("モデル構成が不正です")
    integer(config["width"], 1, 256)
    integer(config["historyWidth"], 1, 64)
    if not isinstance(weights, dict) or any(not isinstance(t, torch.Tensor) or t.dtype != torch.float32 or
                                           not bool(torch.isfinite(t).all()) for t in weights.values()):
        raise ValueError("重みは有限のfloat32 tensorに限定します")
    model = TinyPolicyValue(**config)
    model.load_state_dict(weights, strict=True)
    return model.eval()


def loadModel(directory):
    directory = Path(directory)
    if directory.is_symlink():
        raise ValueError("モデルディレクトリにsymlinkは使えません")
    meta = readJson(directory / "manifest.json", 256 * 1024)
    checkVersions(meta)
    if (meta.get("format") != FORMAT or meta.get("runtime") != RUNTIME or
        meta.get("codeHash") != codeHash() or meta.get("calibrated") is not False):
        raise ValueError("推論形式/コード/必要ランタイムが不一致です")
    if sys.version_info[:2] != (3, 12) or str(torch.__version__).split("+")[0] != RUNTIME["torch"]:
        raise ValueError("実行中のPython/PyTorch版が不一致です")
    supported = meta.get("supportedRestrictions")
    if not isinstance(supported, list) or not supported or any(type(x) is not bool for x in supported) or len(set(supported)) != len(supported):
        raise ValueError("対応ON/OFFが不正です")
    origin = meta.get("training", {})
    if meta.get("modelId") != MODEL_VERSION + ":" + str(origin.get("checkpointSha256")) or not re.fullmatch(r"[0-9a-f]{64}", str(origin.get("checkpointSha256"))):
        raise ValueError("モデルIDと学習checkpointが不一致です")
    training = origin.get("metadata", {})
    checkVersions(training.get("contract", {}))
    if training.get("contract", {}).get("codeHash") != training.get("code", {}).get("sha256"):
        raise ValueError("学習コード版が不一致です")
    if any(training.get("contract", {}).get("config", {}).get(k) != v for k, v in meta["config"].items()):
        raise ValueError("学習時のモデル構成が不一致です")
    info = meta["weights"]
    if not re.fullmatch(r"[0-9a-f]{64}", str(info["sha256"])) or info["file"] != info["sha256"] + ".pt":
        raise ValueError("重みの名前/hashが不正です")
    path = directory / info["file"]
    if path.is_symlink() or path.stat().st_size != info["bytes"] or info["bytes"] > MAX_WEIGHTS or fileHash(path) != info["sha256"]:
        raise ValueError("重みの欠落/checksum/容量が不一致です")
    loaded = torch.load(path, map_location="cpu", weights_only=True)
    if loaded.get("metadata") != {k: v for k, v in meta.items() if k != "weights"}:
        raise ValueError("重みとmanifestの契約が不一致です")
    model = checkedModel(loaded["model"], meta["config"])
    probeInfo = meta["probe"]
    probePath = directory / "probe.json"
    if (probeInfo["file"] != "probe.json" or probePath.is_symlink() or probePath.stat().st_size != probeInfo["bytes"] or
        probeInfo["bytes"] > MAX_FRAME or fileHash(probePath) != probeInfo["sha256"]):
        raise ValueError("基準fixtureの欠落/checksum/容量が不一致です")
    probe = readJson(probePath, MAX_FRAME)
    if probe.get("format") != "four-shogi-inference-probe-v1":
        raise ValueError("基準fixtureの形式が不一致です")
    compareOutputs(probe["expected"], infer(model, meta, probe["rows"]))
    return model, meta


def validateRows(rows, meta):
    if not isinstance(rows, list):
        raise ValueError("局面batchが必要です")
    integer(len(rows), 1, MAX_BATCH)
    historyCount = 0
    for row in rows:
        if type(row["restricted"]) is not bool or row["restricted"] not in meta["supportedRestrictions"]:
            raise ValueError("対応設定外のON/OFFです")
        features = row["features"]
        validateSparse(features["current"], CURRENT_SIZE)
        integer(len(features["history"]), 1, 2048)
        historyCount += len(features["history"])
        for history in features["history"]:
            validateSparse(history, HISTORY_SIZE)
            count = dict(zip(history["indices"], history["values"])).get(4462, 0)
            if count not in (0.25, 0.5, 0.75, 1):
                raise ValueError("反復回数が不正です")
        current = dict(zip(features["current"]["indices"], features["current"]["values"]))
        if current.get(4462, 0) != int(row["restricted"]):
            raise ValueError("特徴とON/OFFが不一致です")
        alive = [current.get(2689 + i, 0) for i in range(4)]
        turn = [current.get(2693 + i, 0) for i in range(5)]
        if any(x not in (0, 1) for x in alive + turn) or sum(turn) != 1 or turn[4] or not alive[turn.index(1)]:
            raise ValueError("生存陣営/実手番の対応が不正です")
        ids = row["legalActionIds"]
        integer(len(ids), 1, ACTION_SIZE)
        for action in ids:
            integer(action, 0, ACTION_SIZE - 1)
        if ids != sorted(set(ids)):
            raise ValueError("合法手IDは重複なしの昇順です")
    integer(historyCount, 1, MAX_HISTORY)


@torch.inference_mode()
def infer(model, meta, rows, device="cpu"):
    validateRows(rows, meta)
    inputs = batchTensors(rows, device)
    policy, value = model(*inputs)
    probabilities, values = policy.softmax(1), value.softmax(1)
    if not bool(torch.isfinite(probabilities).all() and torch.isfinite(values).all()):
        raise ValueError("推論結果が有限ではありません")
    if bool(torch.count_nonzero(probabilities[~inputs[3]])):
        raise ValueError("違法手に非零の出力があります")
    results = []
    for index, row in enumerate(rows):
        ids = row["legalActionIds"]
        logits = policy[index, ids].cpu().tolist()
        scores = probabilities[index, ids].cpu().tolist()
        results.append({"id": row["id"], "legalActionIds": ids,
                        "policyLogits": logits, "policy": scores,
                        "topActionId": ids[max(range(len(ids)), key=lambda i: (logits[i], -ids[i]))],
                        "value": values[index].cpu().tolist(), "illegalPolicyNonzero": 0})
    return results


class ModelHost:
    def __init__(self):
        self.model, self.meta = None, None

    def health(self):
        return {"modelId": self.meta["modelId"] if self.meta else None, "calibrated": False,
                "valueOrder": VALUE_ORDER, "codeHash": codeHash(), "runtime": RUNTIME,
                "supportedRestrictions": self.meta["supportedRestrictions"] if self.meta else []}

    def activate(self, directory, probe):
        model, meta = loadModel(directory)
        infer(model, meta, probe)
        # 健全性検査が完了するまで、稼働中のモデルを置き換えません。
        self.model, self.meta = model, meta
        return self.health()

    def handle(self, request):
        if request.get("protocol") != PROTOCOL:
            raise ValueError("IPCの版が不一致です")
        if request["op"] == "health":
            return self.health()
        if request["op"] == "activate":
            return self.activate(request["directory"], request["probe"])
        if request["op"] != "evaluate" or self.model is None:
            raise ValueError("稼働中のモデル/操作が不正です")
        if request.get("modelId") != self.meta["modelId"]:
            raise ValueError("要求したモデルIDと稼働モデルが不一致です")
        checkVersions(request)
        return {**self.health(), "rows": infer(self.model, self.meta, request["rows"])}


def response(host, request):
    try:
        return {"protocol": PROTOCOL, "id": request.get("id"), "ok": True, "result": host.handle(request)}
    except Exception as error:
        return {"protocol": PROTOCOL, "id": request.get("id"), "ok": False, "error": str(error),
                "activeModelId": host.health()["modelId"], "fallback": "retain-active" if host.model else "static"}


def serve(args):
    host = ModelHost()
    probe = readJson(args.fixture, MAX_FRAME)["rows"][:1]
    startup = response(host, {"protocol": PROTOCOL, "id": 0, "op": "activate",
                              "directory": args.model, "probe": probe})
    if not startup["ok"] and args.fallback:
        failed = startup
        startup = response(host, {"protocol": PROTOCOL, "id": 0, "op": "activate",
                                 "directory": args.fallback, "probe": probe})
        startup["candidateFailure"] = failed["error"]
    print(json.dumps(startup, ensure_ascii=False, allow_nan=False), flush=True)
    if not startup["ok"]:
        return 1
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            return 0
        # フレームを捨てて継続すると境界を誤るため、過大入力は明示して終了します。
        if len(line) > MAX_FRAME or not line.endswith(b"\n"):
            print(json.dumps({"protocol": PROTOCOL, "id": None, "ok": False,
                              "error": "IPC frame上限/改行が不正です", "fallback": "static"}), flush=True)
            return 1
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("IPC要求objectが必要です")
            result = response(host, request)
        except (ValueError, UnicodeError) as error:
            result = {"protocol": PROTOCOL, "id": None, "ok": False, "error": str(error), "fallback": "static"}
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export")
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--output", required=True)
    export.add_argument("--fixture", required=True)
    worker = sub.add_parser("serve")
    worker.add_argument("--model", required=True)
    worker.add_argument("--fixture", required=True)
    worker.add_argument("--fallback")
    worker.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()
    torch.set_num_threads(integer(getattr(args, "threads", 1), 1, 16))
    torch.set_num_interop_threads(1)
    if args.command == "export":
        print(json.dumps(exportModel(args.checkpoint, args.output, args.fixture), ensure_ascii=False, indent=2))
        return 0
    return serve(args)


if __name__ == "__main__":
    sys.exit(main())
