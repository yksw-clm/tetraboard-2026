"""既存の検証済み推論配布物から、Bun用float32補助配布物を作る。"""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from checkpoint import atomicWrite
from inference import loadModel, VERSIONS


def exportLocal(directory):
    directory = Path(directory)
    model, metadata = loadModel(directory)
    content, tensors = bytearray(), {}
    for name, tensor in model.state_dict().items():
        values = tensor.detach().cpu().reshape(-1).tolist()
        tensors[name] = {"shape": list(tensor.shape), "offset": len(content) // 4, "length": len(values)}
        content.extend(struct.pack("<" + str(len(values)) + "f", *values))
    digest = hashlib.sha256(content).hexdigest()
    result = {"format": "four-shogi-local-f32-v1", **VERSIONS,
              "modelId": metadata["modelId"], "config": metadata["config"],
              "calibrated": False, "supportedRestrictions": metadata["supportedRestrictions"],
              "sourceManifestSha256": hashlib.sha256((directory / "manifest.json").read_bytes()).hexdigest(),
              "weights": {"file": digest + ".f32", "sha256": digest, "bytes": len(content)},
              "tensors": tensors}
    target = directory / "local-model.json"
    encoded = json.dumps(result, ensure_ascii=False, indent=2).encode()
    if target.exists():
        if target.read_bytes() != encoded or (directory / result["weights"]["file"]).read_bytes() != content:
            raise ValueError("既存のlocal配布物は上書きしません")
        return result
    atomicWrite(directory / result["weights"]["file"], content)
    atomicWrite(target, encoded)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    print(json.dumps(exportLocal(parser.parse_args().model), ensure_ascii=False))
