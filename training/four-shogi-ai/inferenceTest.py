import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import torch
from inference import (PROTOCOL, VERSIONS, MAX_FRAME, ModelHost, infer, loadModel, readJson, response)
from inferenceSmoke import compare

MODEL, FIXTURE = None, None


class InferenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "model"
        shutil.copytree(MODEL, self.path)
        self.fixture = readJson(FIXTURE, MAX_FRAME)

    def tearDown(self):
        self.temp.cleanup()

    def rewrite(self, change):
        path = self.path / "manifest.json"
        meta = json.loads(path.read_text())
        change(meta)
        path.write_text(json.dumps(meta))

    def testLegalIdsAllSeatsFlagsAndDeadValue(self):
        model, meta = loadModel(self.path)
        rows = infer(model, meta, self.fixture["rows"])
        self.assertEqual({row["restricted"] for row in self.fixture["rows"]}, {False, True})
        self.assertEqual({row["turn"] for row in self.fixture["rows"]}, {"south", "west", "north", "east"})
        for source, output in zip(self.fixture["rows"], rows):
            self.assertIn(output["topActionId"], source["legalActionIds"])
            self.assertEqual(output["legalActionIds"], source["legalActionIds"])
            self.assertAlmostEqual(sum(output["policy"]), 1, places=5)
            self.assertAlmostEqual(sum(output["value"]), 1, places=5)
            if "eliminated" in source["id"]:
                self.assertEqual(output["value"][1], 0)

    def testCorruptionMissingAndVersions(self):
        original = (self.path / "manifest.json").read_text()
        for key in ["codeHash", "featureVersion", "actionEncodingVersion", "rulesVersion", "modelVersion", "valueOrder", "runtime", "modelId", "supportedRestrictions"]:
            with self.subTest(key=key):
                self.rewrite(lambda m: m.update({key: "incompatible"}))
                with self.assertRaises((ValueError, KeyError)):
                    loadModel(self.path)
                (self.path / "manifest.json").write_text(original)
        meta = json.loads(original)
        weight = self.path / meta["weights"]["file"]
        weight.write_bytes(b"corrupt")
        with self.assertRaisesRegex(ValueError, "checksum"):
            loadModel(self.path)
        weight.unlink()
        with self.assertRaises(OSError):
            loadModel(self.path)

    def testFiniteWeightsEvenWithUpdatedChecksum(self):
        meta = json.loads((self.path / "manifest.json").read_text())
        weight = self.path / meta["weights"]["file"]
        state = torch.load(weight, weights_only=True)
        state["model"]["value.bias"][0] = float("nan")
        torch.save(state, weight)
        digest = hashlib.sha256(weight.read_bytes()).hexdigest()
        weight.rename(self.path / (digest + ".pt"))
        self.rewrite(lambda m: m.update(weights={"file": digest + ".pt", "sha256": digest, "bytes": (self.path / (digest + ".pt")).stat().st_size}))
        with self.assertRaisesRegex(ValueError, "有限"):
            loadModel(self.path)

    def testUnsupportedFlagsAndInputBounds(self):
        model, meta = loadModel(self.path)
        meta["supportedRestrictions"] = [True]
        with self.assertRaisesRegex(ValueError, "ON/OFF"):
            infer(model, meta, [next(r for r in self.fixture["rows"] if not r["restricted"])])
        row = copy.deepcopy(next(r for r in self.fixture["rows"] if r["restricted"]))
        with self.assertRaises(ValueError):
            infer(model, meta, [row] * 17)
        row["legalActionIds"] = []
        with self.assertRaises(ValueError):
            infer(model, meta, [row])
        row = copy.deepcopy(self.fixture["rows"][0])
        row["restricted"] = True
        with self.assertRaisesRegex(ValueError, "不一致"):
            infer(model, meta, [row])

    def testFailedActivationRetainsOldModel(self):
        host = ModelHost()
        probe = self.fixture["rows"][:1]
        first = host.activate(MODEL, probe)["modelId"]
        self.rewrite(lambda m: m.update(codeHash="bad"))
        failed = response(host, {"id": 1, "protocol": PROTOCOL, "op": "activate", "directory": str(self.path), "probe": probe})
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["fallback"], "retain-active")
        self.assertEqual(host.health()["modelId"], first)
        request = {"id": 2, "protocol": PROTOCOL, "op": "evaluate", "modelId": first, **VERSIONS, "rows": probe}
        self.assertTrue(response(host, request)["ok"])
        request["modelId"] = "wrong"
        self.assertFalse(response(host, request)["ok"])
        request["modelId"] = first
        request["rulesVersion"] = 2
        self.assertFalse(response(host, request)["ok"])

    def testManifestPairAndMissingModelFallback(self):
        self.rewrite(lambda m: m.update(training={**m["training"], "step": m["training"]["step"] + 1}))
        with self.assertRaisesRegex(ValueError, "重みとmanifest"):
            loadModel(self.path)
        host = ModelHost()
        failure = response(host, {"id": 1, "protocol": PROTOCOL, "op": "activate",
                                  "directory": str(self.path / "missing"), "probe": self.fixture["rows"][:1]})
        self.assertFalse(failure["ok"])
        self.assertEqual(failure["fallback"], "static")
        self.assertIsNone(failure["activeModelId"])

    def testStdioFallbackAndRecovery(self):
        self.rewrite(lambda m: m.update(featureVersion="bad"))
        command = [sys.executable, str(Path(__file__).with_name("inference.py")), "serve", "--model", str(self.path),
                   "--fallback", str(MODEL), "--fixture", str(FIXTURE)]
        lines = ["{bad", json.dumps({"protocol": PROTOCOL, "id": 3, "op": "health"})]
        process = subprocess.run(command, input="\n".join(lines) + "\n", text=True, capture_output=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        ready, malformed, healthy = map(json.loads, process.stdout.splitlines())
        self.assertTrue(ready["ok"])
        self.assertIn("candidateFailure", ready)
        self.assertFalse(malformed["ok"])
        self.assertTrue(healthy["ok"])
        self.assertEqual(healthy["id"], 3)

    def testNumericalProbeFailureRetainsActive(self):
        host = ModelHost()
        first = host.activate(MODEL, self.fixture["rows"][:1])["modelId"]
        metaPath = self.path / "manifest.json"
        meta = json.loads(metaPath.read_text())
        probePath = self.path / "probe.json"
        probe = json.loads(probePath.read_text())
        probe["expected"][0]["value"][0] += 0.01
        probePath.write_text(json.dumps(probe))
        meta["probe"].update(sha256=hashlib.sha256(probePath.read_bytes()).hexdigest(), bytes=probePath.stat().st_size)
        weightPath = self.path / meta["weights"]["file"]
        saved = torch.load(weightPath, weights_only=True)
        saved["metadata"] = {k: v for k, v in meta.items() if k != "weights"}
        torch.save(saved, weightPath)
        digest = hashlib.sha256(weightPath.read_bytes()).hexdigest()
        weightPath.rename(self.path / (digest + ".pt"))
        meta["weights"] = {"file": digest + ".pt", "sha256": digest, "bytes": (self.path / (digest + ".pt")).stat().st_size}
        metaPath.write_text(json.dumps(meta))
        failed = response(host, {"id": 1, "protocol": PROTOCOL, "op": "activate", "directory": str(self.path),
                                 "probe": self.fixture["rows"][:1]})
        self.assertFalse(failed["ok"])
        self.assertIn("数値許容誤差", failed["error"])
        self.assertEqual(failed["activeModelId"], first)

    def testComparisonRejectsNumericalAndActionMismatch(self):
        meta = {"modelId": "m", "weightsSha256": "w", "fixtureSha256": "f", "versions": VERSIONS, "codeHash": "c",
                "rows": [{"id": "r", "legalActionIds": [1], "topActionId": 1, "illegalPolicyNonzero": 0,
                          "policyLogits": [0.1], "policy": [1.], "value": [0., 0., 0., 0., 1.]}]}
        self.assertTrue(compare(meta, meta)["passed"])
        changed = copy.deepcopy(meta)
        changed["rows"][0]["value"][0] = 0.01
        with self.assertRaisesRegex(ValueError, "数値"):
            compare(meta, changed)
        changed = copy.deepcopy(meta)
        changed["rows"][0]["topActionId"] = 2
        with self.assertRaisesRegex(ValueError, "最良手"):
            compare(meta, changed)


if __name__ == "__main__":
    MODEL, FIXTURE = Path(sys.argv.pop(1)), Path(sys.argv.pop(1))
    torch.set_num_threads(1)
    unittest.main()
