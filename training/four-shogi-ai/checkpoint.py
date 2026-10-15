import fcntl
import hashlib
import io
import json
import os
import re
from pathlib import Path
import torch
from dataset import fileHash

CHECKPOINT_VERSION = "four-shogi-checkpoint-v1"


def atomicWrite(path, data):
    path = Path(path)
    temporary = path.with_name("." + path.name + ".tmp")
    try:
        with temporary.open("wb") as target:
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


class CheckpointStore:
    def __init__(self, directory, maxBytes=128 * 1024 ** 2):
        self.directory = Path(directory)
        if self.directory.is_symlink():
            raise ValueError("学習出力先にsymlinkは使えません")
        if self.directory.exists() and not (self.directory / ".training-run").exists():
            if any(path.name != ".lock" for path in self.directory.iterdir()):
                raise ValueError("既存ファイルがある出力先は初期化できません")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.maxBytes = maxBytes
        if (self.directory / ".lock").is_symlink():
            raise ValueError("学習ロックにsymlinkは使えません")
        self.lock = (self.directory / ".lock").open("a+b")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            marker = self.directory / ".training-run"
            if marker.exists():
                if marker.is_symlink() or marker.read_text() != CHECKPOINT_VERSION:
                    raise ValueError("学習出力先の所有マーカーが不正です")
            else:
                if any(path.name != ".lock" for path in self.directory.iterdir()):
                    raise ValueError("既存ファイルがある出力先は初期化できません")
                marker.write_text(CHECKPOINT_VERSION)
            for path in self.directory.iterdir():
                if path.is_symlink() or not path.is_file():
                    raise ValueError("学習出力には通常ファイルだけを置けます")
                if path.name not in (".lock", ".training-run", "latest.json") and not re.fullmatch(r"[0-9a-f]{64}\.pt|\..+\.tmp", path.name):
                    raise ValueError("学習出力先に無関係なファイルがあります")
            for path in self.directory.glob(".*.tmp"):
                path.unlink()
            latest = self.directory / "latest.json"
            references = json.loads(latest.read_text()) if latest.exists() else {}
            if latest.exists() and (references.get("format") != CHECKPOINT_VERSION or
                not re.fullmatch(r"[0-9a-f]{64}", str(references.get("sha256"))) or
                (references.get("previousSha256") is not None and
                 not re.fullmatch(r"[0-9a-f]{64}", str(references["previousSha256"])))):
                raise ValueError("checkpoint参照が壊れているため、重みを保持して停止します")
            for path in self.directory.glob("*.pt"):
                if path.stem not in (references.get("sha256"), references.get("previousSha256")):
                    path.unlink()
        except BaseException:
            self.lock.close()
            raise

    def close(self):
        self.lock.close()

    def load(self):
        manifestPath = self.directory / "latest.json"
        if not manifestPath.exists():
            return None
        manifest = json.loads(manifestPath.read_text())
        digest = manifest["sha256"]
        if manifest.get("format") != CHECKPOINT_VERSION or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("checkpointの形式/識別が不正です")
        path = self.directory / (digest + ".pt")
        if path.stat().st_size > self.maxBytes or fileHash(path) != digest:
            raise ValueError("checkpointのchecksum/容量が不一致です")
        state = torch.load(path, map_location="cpu", weights_only=True)
        if state["format"] != CHECKPOINT_VERSION or state["metadata"] != manifest["metadata"]:
            raise ValueError("checkpointとmanifestの契約が不一致です")
        return state

    def save(self, state):
        stream = io.BytesIO()
        torch.save(state, stream)
        data = stream.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        latest = self.directory / "latest.json"
        previous = json.loads(latest.read_text())["sha256"] if latest.exists() else None
        if previous == digest:
            if fileHash(self.directory / (digest + ".pt")) != digest:
                raise ValueError("checkpointのchecksumが不一致です")
            return digest
        manifest = json.dumps({"format": CHECKPOINT_VERSION, "sha256": digest, "previousSha256": previous,
                               "metadata": state["metadata"]}, ensure_ascii=False, indent=2).encode()
        currentBytes = sum(path.stat().st_size for path in self.directory.iterdir())
        if currentBytes + len(data) + len(manifest) > self.maxBytes:
            raise ValueError("checkpoint容量上限です。前回の保存状態は維持します")
        path = self.directory / (digest + ".pt")
        if not path.exists():
            atomicWrite(path, data)
        atomicWrite(latest, manifest)
        for old in self.directory.glob("*.pt"):
            if old.stem not in (digest, previous):
                old.unlink()
        return digest
