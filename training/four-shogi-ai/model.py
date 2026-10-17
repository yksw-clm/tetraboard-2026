import torch
from torch import nn
from dataset import CURRENT_SIZE, HISTORY_SIZE, ACTION_SIZE

MODEL_VERSION = "four-shogi-tiny-policy-value-v1"


def batchTensors(rows, device):
    current = torch.zeros((len(rows), CURRENT_SIZE), dtype=torch.float32)
    entries = sum(len(row["features"]["history"]) for row in rows)
    history = torch.zeros((entries, HISTORY_SIZE), dtype=torch.float32)
    owners, offset = [], 0
    legal = torch.zeros((len(rows), ACTION_SIZE), dtype=torch.bool)
    for index, row in enumerate(rows):
        feature = row["features"]["current"]
        current[index, feature["indices"]] = torch.tensor(feature["values"], dtype=torch.float32)
        for entry in row["features"]["history"]:
            history[offset, entry["indices"]] = torch.tensor(entry["values"], dtype=torch.float32)
            owners.append(index)
            offset += 1
        legal[index, row["legalActionIds"]] = True
    return current.to(device), history.to(device), owners, legal.to(device)


class TinyPolicyValue(nn.Module):
    def __init__(self, width=64, historyWidth=16):
        super().__init__()
        self.history = nn.Sequential(nn.Linear(HISTORY_SIZE, historyWidth), nn.Tanh())
        self.body = nn.Sequential(nn.Linear(CURRENT_SIZE + historyWidth + 1, width), nn.ReLU(),
                                  nn.Linear(width, width), nn.ReLU())
        self.policy = nn.Linear(width, ACTION_SIZE)
        self.value = nn.Linear(width, 5)

    def forward(self, current, history, owners, legal):
        if not bool(legal.any(dim=1).all()):
            raise ValueError("合法手のない局面はPolicy入力にできません")
        encoded = self.history(history)
        # 履歴辞書の順序は意味を持たないため、全項目の共有MLP出力を集約します。
        pooled, sizes, offset = [], [], 0
        if owners != sorted(owners):
            raise ValueError("履歴は局面ごとに連続して配置してください")
        for index in range(current.shape[0]):
            count = owners.count(index)
            if not count:
                raise ValueError("反復履歴がありません")
            pooled.append(encoded[offset:offset + count].sum(dim=0) / count ** 0.5)
            sizes.append(count / 2048)
            offset += count
        hidden = self.body(torch.cat([current, torch.stack(pooled),
                                     current.new_tensor(sizes).unsqueeze(1)], dim=1))
        policy = self.policy(hidden).masked_fill(~legal, -torch.inf)
        alive = torch.cat([current[:, 2689:2693] > 0,
                           torch.ones((len(current), 1), device=current.device, dtype=torch.bool)], dim=1)
        value = self.value(hidden).masked_fill(~alive, -torch.inf)
        return policy, value


def supervisedLoss(policy, value, rows):
    losses = []
    for logits, name in [(policy, "policyTarget"), (value, "valueTarget")]:
        targets = [row[name] if row[name] is not None else -100 for row in rows]
        count = sum(target != -100 for target in targets)
        losses.append(nn.functional.cross_entropy(logits, torch.tensor(targets, device=logits.device),
                                                 ignore_index=-100, reduction="sum") / max(1, count))
    policyLoss, valueLoss = losses
    return policyLoss + valueLoss, policyLoss, valueLoss


@torch.no_grad()
def evaluate(model, rows, device, batchSize):
    model.eval()
    result = {"policyLoss": 0.0, "valueLoss": 0.0, "policySamples": 0, "valueSamples": 0,
              "policyCorrect": 0, "valueClasses": [0] * 5, "restricted": {"on": 0, "off": 0}}
    for start in range(0, len(rows), batchSize):
        batch = rows[start:start + batchSize]
        policy, value = model(*batchTensors(batch, device))
        _, pl, vl = supervisedLoss(policy, value, batch)
        pc = sum(row["policyTarget"] is not None for row in batch)
        vc = sum(row["valueTarget"] is not None for row in batch)
        result["policyLoss"] += float(pl) * pc
        result["valueLoss"] += float(vl) * vc
        result["policySamples"] += pc
        result["valueSamples"] += vc
        for index, row in enumerate(batch):
            result["restricted"]["on" if row["restricted"] else "off"] += 1
            if row["policyTarget"] is not None:
                result["policyCorrect"] += int(int(policy[index].argmax()) == row["policyTarget"])
            if row["valueTarget"] is not None:
                result["valueClasses"][row["valueTarget"]] += 1
    for kind in ("policy", "value"):
        count = result[kind + "Samples"]
        result[kind + "Loss"] = result[kind + "Loss"] / count if count else None
    result["policyAccuracy"] = result.pop("policyCorrect") / result["policySamples"] if result["policySamples"] else None
    return result
