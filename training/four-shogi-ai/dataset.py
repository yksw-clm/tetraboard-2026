import hashlib
import json
import math
from pathlib import Path

FEATURE_VERSION = "four-shogi-features-v1"
ACTION_VERSION = "four-shogi-policy-index-v1"
CURRENT_SIZE, HISTORY_SIZE, ACTION_SIZE = 4481, 4463, 13446
VALUE_ORDER = ["south", "west", "north", "east", "noSoleWinner"]


def fileHash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("整数が範囲外です")
    return value


def validateSparse(value, size):
    if set(value) != {"indices", "values"} or len(value["indices"]) != len(value["values"]):
        raise ValueError("疎特徴の形式が不正です")
    previous = -1
    for index, number in zip(value["indices"], value["values"]):
        integer(index, previous + 1, size - 1)
        if type(number) not in (float, int) or not math.isfinite(number) or number == 0:
            raise ValueError("特徴値は有限の非零値です")
        previous = index


class LearningData:
    def __init__(self, directory, maxBytes=256 * 1024 ** 2):
        directory = Path(directory)
        metaPath = directory / "manifest.json"
        if metaPath.stat().st_size > 16 * 1024 ** 2:
            raise ValueError("manifestが大きすぎます")
        self.manifest = json.loads(metaPath.read_text())
        meta = self.manifest
        expected = {"schemaVersion": 1, "format": "four-shogi-learning-data-v1",
                    "ruleProfileId": "tetraboard-four-shogi-singles-v1", "rulesVersion": 1,
                    "featureVersion": FEATURE_VERSION, "actionEncodingVersion": ACTION_VERSION,
                    "currentFeatureSize": CURRENT_SIZE, "historyFeatureSize": HISTORY_SIZE,
                    "maxHistoryEntries": 2048, "actionSpaceSize": ACTION_SIZE, "valueOrder": VALUE_ORDER}
        if any(meta.get(key) != value for key, value in expected.items()):
            raise ValueError("学習入力の特徴/行動/Value/形式版が不一致です")
        info = meta["samples"]
        if info["file"] != "samples.jsonl":
            raise ValueError("学習入力のファイル名が不正です")
        source = directory / "samples.jsonl"
        if source.is_symlink() or source.stat().st_size != info["bytes"] or info["bytes"] > maxBytes:
            raise ValueError("学習入力の容量が不一致または上限超過です")
        if fileHash(source) != info["sha256"]:
            raise ValueError("学習入力のchecksumが不一致です")
        self.identity = {"manifestSha256": fileHash(metaPath), "samplesSha256": info["sha256"],
                         "datasetId": meta["source"]["manifest"]["datasetId"]}
        self.splits = {key: [] for key in ("train", "validation", "calibration", "test")}
        if meta["source"]["inspection"]["datasetId"] != self.identity["datasetId"]:
            raise ValueError("元datasetの識別が不一致です")
        sourcePlans = {plan["gameId"]: plan for plan in meta["source"]["plans"]}
        seen, families, positions = set(), {}, {}
        with source.open() as handle:
            for line in handle:
                if len(line) > 32 * 1024 ** 2:
                    raise ValueError("教師行が大きすぎます")
                row = json.loads(line)
                split = row["split"]
                if split not in self.splits or row["id"] in seen or len(seen) >= 100000:
                    raise ValueError("重複局面/不明split/件数上限です")
                plan = sourcePlans.get(row["gameId"])
                if not plan or (plan["familyId"], plan["split"]) != (row["familyId"], split):
                    raise ValueError("元datasetの系列/分割と不一致です")
                for registry, key in [(families, row["familyId"]), (positions, row["positionFamily"])]:
                    if key in registry and registry[key] != split:
                        raise ValueError("回転局面/開始系列が分割集合を横断しています")
                    registry[key] = split
                seen.add(row["id"])
                if type(row["restricted"]) is not bool:
                    raise ValueError("ON/OFFがありません")
                features = row["features"]
                validateSparse(features["current"], CURRENT_SIZE)
                if not 1 <= len(features["history"]) <= 2048:
                    raise ValueError("全反復履歴が必要です")
                for entry in features["history"]:
                    validateSparse(entry, HISTORY_SIZE)
                    if not entry["indices"] or entry["indices"][-1] != 4462 or not 0 < entry["values"][-1] <= 1:
                        raise ValueError("反復回数がありません")
                current = dict(zip(features["current"]["indices"], features["current"]["values"]))
                if current.get(4462, 0) != int(row["restricted"]):
                    raise ValueError("特徴とON/OFFが不一致です")
                mask = row["legalActionIds"]
                if not mask or len(mask) != len(set(mask)):
                    raise ValueError("合法手マスクが空または重複です")
                for action in mask:
                    integer(action, 0, ACTION_SIZE - 1)
                policy, value = row["policyTarget"], row["valueTarget"]
                if policy is not None and (type(policy) is not int or policy not in mask):
                    raise ValueError("Policy教師が違法です")
                if row["status"] not in ("finished", "truncated"):
                    raise ValueError("生成途中の局は採用しません")
                if value is not None:
                    integer(value, 0, 4)
                    if row["status"] != "finished" or (value < 4 and not current.get(2689 + value)):
                        raise ValueError("未終局/脱落者をValue教師にできません")
                if policy is None and value is None:
                    raise ValueError("教師のない局面です")
                self.splits[split].append(row)
        counts = {key: len(rows) for key, rows in self.splits.items()}
        if counts != info["splits"] or sum(counts.values()) != info["count"]:
            raise ValueError("件数/分割のchecksumが不一致です")
        if not self.splits["train"] or not self.splits["validation"]:
            raise ValueError("独立したtrain/validationの両方が必要です")
