import argparse
import json
import os
import shutil
import uuid
from pathlib import Path
from inference import exportModel, loadModel
from localExport import exportLocal
from checkpoint import atomicWrite

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for arg in ["checkpoint", "output", "fixture", "report"]:
        parser.add_argument("--" + arg, required=True)
    args = parser.parse_args()
    target = Path(args.output)
    if target.exists():
        model, meta = loadModel(target)
        latest = json.loads((Path(args.checkpoint) / "latest.json").read_text())
        if meta["training"]["checkpointSha256"] != latest["sha256"]:
            raise ValueError("既存exportとcheckpointが不一致です")
        local = exportLocal(target)
    else:
        temporary = target.with_name(target.name + ".preparing-" + str(uuid.uuid4()))
        try:
            meta = exportModel(args.checkpoint, temporary, args.fixture)
            local = exportLocal(temporary)
            os.rename(temporary, target)
            fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except BaseException:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    atomicWrite(args.report, json.dumps({"modelId": meta["modelId"], "weights": meta["weights"],
                                       "local": local, "verified": True}, indent=2).encode())
