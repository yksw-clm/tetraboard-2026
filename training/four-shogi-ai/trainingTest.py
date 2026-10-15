import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import torch
from checkpoint import CheckpointStore, CHECKPOINT_VERSION
from dataset import LearningData, VALUE_ORDER, fileHash
from model import TinyPolicyValue, batchTensors, supervisedLoss
from train import train

DATA = None


class TrainingTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.data = LearningData(DATA)

    def tearDown(self):
        self.temporary.cleanup()

    def testPolicyAndSeatMasks(self):
        torch.manual_seed(190)
        model = TinyPolicyValue(16, 4)
        row = copy.deepcopy(self.data.splits["train"][0])
        rows = [row]
        inputs = batchTensors(rows, "cpu")
        policy, value = model(*inputs)
        probabilities = policy.softmax(dim=1)
        self.assertEqual(int(torch.count_nonzero(probabilities[~inputs[3]])), 0)
        self.assertAlmostEqual(float(probabilities.detach().sum()), 1, places=6)
        inputs[0][0, 2690] = 0
        _, value = model(*inputs)
        self.assertEqual(float(value.softmax(dim=1)[0, 1]), 0)
        self.assertEqual(VALUE_ORDER, ["south", "west", "north", "east", "noSoleWinner"])
        inputs[3].fill_(False)
        with self.assertRaisesRegex(ValueError, "合法手"):
            model(*inputs)

    def testValueUsesAllFiveAbsoluteSlotsAndIgnoresUnfinished(self):
        logits = torch.tensor([[0., 1., 2., 3., 4.]], requires_grad=True)
        for target in range(5):
            rows = [{"policyTarget": None, "valueTarget": target}]
            loss, _, valueLoss = supervisedLoss(torch.zeros(1, 13446, requires_grad=True), logits, rows)
            self.assertAlmostEqual(float(valueLoss), float(torch.logsumexp(logits[0], 0) - logits[0, target]), places=6)
            self.assertTrue(torch.isfinite(loss))
        _, _, absent = supervisedLoss(torch.zeros(1, 13446, requires_grad=True), logits,
                                     [{"policyTarget": 0, "valueTarget": None}])
        self.assertEqual(float(absent), 0)

    def testMpsDeterministicBackward(self):
        if not torch.backends.mps.is_available():
            self.skipTest("MPSを利用できない環境です")
        torch.use_deterministic_algorithms(True)
        torch.manual_seed(190)
        model = TinyPolicyValue(16, 4).to("mps")
        rows = self.data.splits["train"][:2]
        policy, value = model(*batchTensors(rows, "mps"))
        loss, _, _ = supervisedLoss(policy, value, rows)
        loss.backward()
        self.assertTrue(bool(torch.isfinite(model.policy.weight.grad).all()))
        self.assertGreater(int(torch.count_nonzero(model.policy.weight.grad)), 0)

    def rewrite(self, mutate):
        target = self.root / "data"
        shutil.copytree(DATA, target)
        path = target / "samples.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        mutate(rows)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        manifest = json.loads((target / "manifest.json").read_text())
        manifest["samples"]["sha256"] = fileHash(path)
        manifest["samples"]["bytes"] = path.stat().st_size
        (target / "manifest.json").write_text(json.dumps(manifest))
        return target

    def testRejectsCrossSplitPositions(self):
        def leak(rows):
            start = next(row for row in rows if row["split"] == "train")
            other = next(row for row in rows if row["split"] == "validation")
            other["positionFamily"] = start["positionFamily"]
        with self.assertRaisesRegex(ValueError, "横断"):
            LearningData(self.rewrite(leak))

    def testRejectsUnfinishedValueLabels(self):
        def change(rows):
            rows[0]["status"], rows[0]["valueTarget"] = "truncated", 4
        with self.assertRaisesRegex(ValueError, "未終局"):
            LearningData(self.rewrite(change))

    def testRejectsIllegalPolicyEvenWithRecomputedChecksum(self):
        def change(rows):
            rows[0]["policyTarget"] = next(i for i in range(13446) if i not in rows[0]["legalActionIds"])
        with self.assertRaisesRegex(ValueError, "違法"):
            LearningData(self.rewrite(change))

    def testCheckpointFailurePreservesPreviousAndRecoversOrphan(self):
        directory = self.root / "checkpoint"
        store = CheckpointStore(directory)
        state = {"format": CHECKPOINT_VERSION, "metadata": {"calibrated": False}, "step": 1, "model": {"weight": torch.ones(3)}}
        digest = store.save(state)
        store.maxBytes = 1
        with self.assertRaisesRegex(ValueError, "容量"):
            store.save({**state, "step": 2})
        store.maxBytes = 1024 * 1024
        self.assertEqual(store.load()["step"], 1)
        with self.assertRaises(BlockingIOError):
            CheckpointStore(directory)
        store.close()
        orphan = directory / ("f" * 64 + ".pt")
        orphan.write_text("partial commit")
        store = CheckpointStore(directory)
        try:
            self.assertFalse(orphan.exists())
            self.assertEqual(store.load()["step"], 1)
            with (directory / (digest + ".pt")).open("ab") as target:
                target.write(b"corrupt")
            with self.assertRaisesRegex(ValueError, "checksum"):
                store.load()
        finally:
            store.close()

    def testResumeMatchesContinuousWeightsOptimizerAndSampler(self):
        options = dict(steps=6, width=16, historyWidth=4, batchSize=2, checkpointEvery=2, allowDirty=True)
        interrupted, continuous = self.root / "interrupted", self.root / "continuous"
        first = train(DATA, interrupted, stopAfterSteps=3, **options)
        self.assertEqual((first["status"], first["step"]), ("paused", 3))
        resumed = train(DATA, interrupted, **options)
        whole = train(DATA, continuous, **options)
        self.assertEqual(resumed["history"][-1], whole["history"][-1])
        leftStore, rightStore = CheckpointStore(interrupted), CheckpointStore(continuous)
        try:
            left, right = leftStore.load(), rightStore.load()
            self.assertTrue(torch.equal(left["samplerRng"], right["samplerRng"]))
            self.assertTrue(torch.equal(left["rng"], right["rng"]))
            for key in left["model"]:
                self.assertTrue(torch.equal(left["model"][key], right["model"][key]), key)
            for key in left["optimizer"]["state"]:
                for name, tensor in left["optimizer"]["state"][key].items():
                    self.assertTrue(torch.equal(tensor, right["optimizer"]["state"][key][name]))
        finally:
            leftStore.close()
            rightStore.close()
        with self.assertRaisesRegex(ValueError, "再開元"):
            train(DATA, interrupted, **{**options, "seed": 19100})

    def testBrokenPointerAndUnrelatedOutputPreserveFiles(self):
        directory = self.root / "checkpoint"
        store = CheckpointStore(directory)
        digest = store.save({"format": CHECKPOINT_VERSION, "metadata": {}, "model": {"w": torch.ones(1)}})
        store.close()
        (directory / "latest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "参照"):
            CheckpointStore(directory)
        self.assertTrue((directory / (digest + ".pt")).exists())
        unrelated = self.root / "unrelated"
        unrelated.mkdir()
        (unrelated / "preserve.txt").write_text("preserve")
        with self.assertRaisesRegex(ValueError, "既存"):
            CheckpointStore(unrelated)
        self.assertEqual([p.name for p in unrelated.iterdir()], ["preserve.txt"])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("trainingTest.py <TSで出力したsmoke学習入力>")
    DATA = sys.argv.pop(1)
    unittest.main()
