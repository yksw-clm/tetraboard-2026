import { test, expect } from "bun:test";
import { ModelInferenceClient } from "../src/modelInference";
import { restoreAnalysisPosition } from "../src/analysis";
import { createInferenceFixture } from "../bench/inferenceFixture";

const modelId = "four-shogi-tiny-policy-value-v1:" + "1".repeat(64);
const command = (mode = "ok") => [
  process.execPath,
  "-e",
  `const protocol = "four-shogi-inference-ipc-v1";
const modelId = ${JSON.stringify(modelId)};
const health = {modelId, calibrated:false, codeHash:"2".repeat(64), supportedRestrictions:[false,true],
valueOrder:["south","west","north","east","noSoleWinner"],runtime:{python:"3.12",torch:"2.14.1",device:"cpu"}};
const send = (id,result) => process.stdout.write(JSON.stringify({protocol,id,ok:true,result})+"\\n");
send(0,health);
require("node:readline").createInterface({input:process.stdin}).on("line", line=>{
  const request=JSON.parse(line);
  if (${JSON.stringify(mode)} === "wait") return;
  const rows = request.rows.map(row=>({id:row.id, legalActionIds:row.legalActionIds,
    policy:row.legalActionIds.map(()=>1/row.legalActionIds.length),
    policyLogits:row.legalActionIds.map(()=>0), topActionId:row.legalActionIds[0],
    value:[0.2,0.2,0.2,0.2,0.2], illegalPolicyNonzero:0}));
  if (${JSON.stringify(mode)} === "bad") rows[0].topActionId = -1;
  send(request.id,{modelId, rows});
});`,
];
const position = () =>
  restoreAnalysisPosition({
    schemaVersion: 1,
    ruleProfileId: "tetraboard-four-shogi-singles-v1",
    rulesVersion: 1,
    initial: {
      mode: "singles",
      players: { south: "s", west: "w", north: "n", east: "e" },
      threePlayerAttackProhibited: true,
    },
    events: [],
  });

test("推論fixtureは両設定・全実手番・脱落・絶対行動/回転対応を含む", async () => {
  const fixture = await createInferenceFixture();
  expect(fixture.rows).toHaveLength(14);
  expect(new Set(fixture.rows.map((row) => row.turn))).toEqual(
    new Set(["south", "west", "north", "east"]),
  );
  expect(fixture.actionCorrespondence[0].rotations).toEqual([0, 1312, 13120, 11808]);
  expect(fixture.actionCorrespondence[3].rotations).toEqual([13122, 13130, 13202, 13194]);
  for (const row of fixture.rows) {
    expect(row.legalActionIds.length).toBeGreaterThan(0);
    const flag = row.features.current.indices.includes(4462);
    expect(flag).toBe(row.restricted);
    if (row.id.includes("eliminated")) expect(row.features.current.indices).not.toContain(2690);
  }
});

test("常駐推論は複数要求を同じプロセスへ送り、正本の合法手IDを照合する", async () => {
  const client = await ModelInferenceClient.start(command());
  try {
    const source = await position();
    expect(client.loadedModel.modelId).toBe(modelId);
    const [first, second] = await Promise.all([
      client.evaluate([source]),
      client.evaluate([source]),
    ]);
    expect(first).toEqual(second);
    expect(first[0].legalActionIds).toContain(first[0].topActionId);
    await expect(client.evaluate([])).rejects.toThrow("batch");
  } finally {
    client.close();
  }
});

test("推論の不正な最良手と期限超過は明示的に失敗し、再利用しない", async () => {
  const source = await position();
  const bad = await ModelInferenceClient.start(command("bad"));
  await expect(bad.evaluate([source])).rejects.toThrow("整合検査");
  await expect(bad.evaluate([source])).rejects.toThrow("整合検査");
  const late = await ModelInferenceClient.start(command("wait"), { timeoutMs: 50 });
  await expect(late.evaluate([source])).rejects.toThrow("期限");
  expect(() => late.loadedModel).toThrow("期限");
});
