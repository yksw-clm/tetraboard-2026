use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader},
    path::Path,
};

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p).ceil() as usize).max(1) - 1]
}

pub fn bootstrap(blocks: &[f64], attempt: u64) -> Value {
    let mean = blocks.iter().sum::<f64>() / blocks.len() as f64;
    let mut rng = ChaCha8Rng::seed_from_u64(9_000_000 + attempt);
    let mut means = Vec::with_capacity(100_000);
    for _ in 0..100_000 {
        means.push(
            (0..blocks.len())
                .map(|_| blocks[rng.random_range(0..blocks.len() as u32) as usize])
                .sum::<f64>()
                / blocks.len() as f64,
        );
    }
    means.sort_by(f64::total_cmp);
    let alpha = 0.05 / (2.0 * attempt as f64 * (attempt as f64 + 1.0));
    json!({"mean_difference":mean,"ci95":[percentile(&means,0.025),percentile(&means,0.975)],"adjusted_lower":percentile(&means,alpha),"one_sided_alpha":alpha,"bootstrap_samples":100_000,"bootstrap_seed":9_000_000+attempt,"independent_seed_blocks":blocks.len()})
}

#[derive(Default)]
struct Totals {
    appearances: u64,
    rank: u64,
    score: u64,
    first: u64,
    sole: u64,
    shared: u64,
}
impl Totals {
    fn record(&mut self, outcome: &Value) -> Result<(), String> {
        self.appearances += 1;
        self.rank += outcome["rank"]
            .as_u64()
            .filter(|n| (1..=4).contains(n))
            .ok_or("順位が不正です")?;
        self.score += outcome["score"]
            .as_u64()
            .filter(|n| *n <= 64)
            .ok_or("得点が不正です")?;
        let first = outcome["won"].as_bool().ok_or("勝敗が不正です")?;
        let shared = outcome["shared_first"]
            .as_bool()
            .ok_or("同率判定が不正です")?;
        self.first += u64::from(first);
        self.shared += u64::from(shared);
        self.sole += u64::from(first && !shared);
        Ok(())
    }
    fn json(&self) -> Value {
        let n = self.appearances as f64;
        json!({"appearances":self.appearances,"mean_rank":self.rank as f64/n,"mean_score":self.score as f64/n,"first_place_rate":self.first as f64/n,"sole_first_rate":self.sole as f64/n,"shared_first_rate":self.shared as f64/n})
    }
}

#[derive(Default)]
struct Pair {
    blocks: BTreeMap<u64, BTreeMap<String, Vec<(f64, f64)>>>,
    keys: BTreeSet<(u64, String, u64)>,
    candidate_timings: Vec<f64>,
    baseline_timings: Vec<f64>,
    totals: [Totals; 2],
    colors: [[Totals; 4]; 2],
}

pub fn analyze(directory: &Path) -> Result<Value, String> {
    let manifest: Value = serde_json::from_slice(
        &fs::read(directory.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let attempt = manifest["attempt"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("attemptが不正です")?;
    let confirm = manifest["phase"] == "confirm";
    let rounds = manifest["rounds"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 32)
        .ok_or("roundsが不正です")?;
    let orders = if confirm { 24 } else { 4 };
    let mut pairs: BTreeMap<String, Pair> = BTreeMap::new();
    let entries = fs::read_dir(directory).map_err(|e| e.to_string())?;
    let mut files = entries
        .map(|e| e.map(|e| e.path()).map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort();
    let mut resources = Vec::new();
    for file in files {
        if file.to_string_lossy().ends_with(".failed.json") {
            return Err("失敗した実行があります".into());
        }
        if file.to_string_lossy().ends_with(".done.json") {
            resources.push(
                serde_json::from_slice::<Value>(&fs::read(&file).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        if file.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let mut summaries = 0;
        let mut games = 0;
        for line in BufReader::new(fs::File::open(&file).map_err(|e| e.to_string())?).lines() {
            let row: Value = serde_json::from_str(&line.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if row["record_type"] == "summary" {
                summaries += 1;
                if row["failed_games"] != 0 || row["completed_games"] != orders * 3 {
                    return Err("対局失敗・不完全なsummaryがあります".into());
                }
                continue;
            }
            if summaries != 0
                || row["record_type"] != "game"
                || !row["error"].is_null()
                || row["game"].is_null()
            {
                return Err("不正な棋譜レコードです".into());
            }
            let matchup = row["matchup_id"]
                .as_str()
                .ok_or("matchupがありません")?
                .to_string();
            let pair_id = matchup
                .rsplit_once('-')
                .ok_or("比較IDが不正です")?
                .0
                .to_string();
            let seed = row["game"]["game_seed"]
                .as_u64()
                .ok_or("seedがありません")?;
            let seed_start = if confirm {
                1_000_000 + 32 * (attempt - 1)
            } else {
                0
            };
            if seed < seed_start || seed >= seed_start + rounds {
                return Err("予約したseed範囲から外れています".into());
            }
            let order = row["seat_order_index"]
                .as_u64()
                .ok_or("席順indexがありません")?;
            if order >= orders {
                return Err("席順indexが範囲外です".into());
            }
            let slots = row["lineup_slots"].as_array().ok_or("席順がありません")?;
            let expected = if confirm {
                crate::tournament::SeatOrders::AllPermutations.orders()
            } else {
                crate::tournament::SeatOrders::Cyclic.orders()
            };
            if slots.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()
                != Some(expected[order as usize].map(|n| n as u64).to_vec())
            {
                return Err("席順の対応が不正です".into());
            }
            let colors = ["black", "white", "red", "blue"];
            let focal =
                [0u64, 1].map(|slot| slots.iter().position(|v| v.as_u64() == Some(slot)).unwrap());
            let outcomes = row["game"]["outcomes"]
                .as_array()
                .ok_or("結果がありません")?;
            let values = focal.map(|i| {
                let outcome = outcomes.iter().find(|o| o["color"] == colors[i]).unwrap();
                if outcome["won"] == true && outcome["shared_first"] == false {
                    1.0
                } else {
                    0.0
                }
            });
            let pair = pairs.entry(pair_id).or_default();
            for (role, color) in focal.iter().enumerate() {
                let outcome = outcomes
                    .iter()
                    .find(|o| o["color"] == colors[*color])
                    .ok_or("4色の結果がありません")?;
                pair.totals[role].record(outcome)?;
                pair.colors[role][*color].record(outcome)?;
            }
            if !pair.keys.insert((seed, matchup.clone(), order)) {
                return Err("同じseed・相手・席順が重複しています".into());
            }
            pair.blocks
                .entry(seed)
                .or_default()
                .entry(matchup)
                .or_default()
                .push((values[0], values[1]));
            for (i, timings) in [&mut pair.candidate_timings, &mut pair.baseline_timings]
                .into_iter()
                .enumerate()
            {
                for entry in row["game"]["moves"].as_array().ok_or("着手がありません")? {
                    if entry["color"] == colors[focal[i]] {
                        timings.push(
                            entry["decision_time_ns"].as_f64().ok_or("時間が不正です")?
                                / 1_000_000.0,
                        );
                    }
                }
            }
            games += 1;
        }
        if summaries != 1 || games != orders * 3 {
            return Err("最後まで完了していない棋譜です".into());
        }
    }
    if pairs.len() != 2 {
        return Err("2組の比較が必要です".into());
    }
    let mut comparisons = Vec::new();
    for (name, mut pair) in pairs {
        if pair.blocks.len() != rounds as usize
            || pair
                .blocks
                .values()
                .any(|b| b.len() != 3 || b.values().any(|v| v.len() != orders as usize))
        {
            return Err("seed・相手構成・席順が欠けています".into());
        }
        let blocks: Vec<_> = pair
            .blocks
            .values()
            .map(|b| b.values().flatten().map(|(a, b)| a - b).sum::<f64>() / (orders * 3) as f64)
            .collect();
        let inference = bootstrap(&blocks, attempt);
        let mut strata: BTreeMap<String, Vec<(f64, f64)>> = BTreeMap::new();
        for block in pair.blocks.values() {
            for (matchup, rows) in block {
                strata.entry(matchup.clone()).or_default().extend(rows);
            }
        }
        let strata:Vec<_>=strata.into_iter().map(|(id,rows)| {
            let a=rows.iter().map(|v|v.0).sum::<f64>()/rows.len() as f64;
            let b=rows.iter().map(|v|v.1).sum::<f64>()/rows.len() as f64;
            json!({"matchup_id":id,"games":rows.len(),"candidate_solo_rate":a,"baseline_solo_rate":b,"difference":a-b})
        }).collect();
        let passed = inference["adjusted_lower"].as_f64().unwrap() > 0.0
            && strata
                .iter()
                .all(|s| s["difference"].as_f64().unwrap() > 0.0);
        pair.candidate_timings.sort_by(f64::total_cmp);
        pair.baseline_timings.sort_by(f64::total_cmp);
        comparisons.push(json!({"comparison":name,"games":pair.keys.len(),"candidate_statistics":pair.totals[0].json(),"baseline_statistics":pair.totals[1].json(),"color_statistics":pair.colors.iter().map(|role|role.iter().map(Totals::json).collect::<Vec<_>>()).collect::<Vec<_>>(),"inference":inference,"strata":strata,"strength_gate_passed":passed,"contended_candidate_p95_ms":percentile(&pair.candidate_timings,0.95),"contended_baseline_p95_ms":percentile(&pair.baseline_timings,0.95)}));
    }
    Ok(
        json!({"format_version":1,"manifest":manifest,"strength_gate_passed":confirm&&rounds==32&&comparisons.iter().all(|c|c["strength_gate_passed"]==true),"comparisons":comparisons,"process_resources":resources}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn confidence_intervals_use_seed_blocks_and_multiple_attempt_correction() {
        let positive = bootstrap(&[0.2; 32], 1);
        assert_eq!(positive["ci95"][0], positive["ci95"][1]);
        assert!(positive["adjusted_lower"].as_f64().unwrap() > 0.0);
        let balanced = bootstrap(&[-0.2, 0.2, -0.2, 0.2], 1);
        assert!(balanced["adjusted_lower"].as_f64().unwrap() < 0.0);
        assert_eq!(
            bootstrap(&[0.2; 32], 2)["one_sided_alpha"],
            json!(0.05 / 12.0)
        );
        assert_eq!(positive, bootstrap(&[0.2; 32], 1));
    }
    #[test]
    fn incomplete_and_duplicate_seed_records_cannot_pass_analysis() {
        use crate::tournament::{Matchup, TournamentConfig, run_tournament};
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "tetraboard-study-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        fs::write(
            path.join("manifest.json"),
            json!({"attempt":1,"phase":"train","rounds":1}).to_string(),
        )
        .unwrap();
        for (a, b) in [("a", "b"), ("b", "c")] {
            let mut config: TournamentConfig =
                serde_json::from_str(include_str!("../../../configs/phase1.json")).unwrap();
            config.format_version = 2;
            for (profile, id) in config.profiles.iter_mut().zip(["a", "b", "c"]) {
                profile.id = id.into();
                profile.config = tetraboard_ai_agents::config::AgentConfig::Random { seed: 0 };
            }
            config.matchups = (0..3)
                .map(|i| Matchup {
                    id: format!("{a}-vs-{b}-{i}"),
                    lineup: [a.into(), b.into(), "c".into(), "c".into()],
                })
                .collect();
            let mut file = fs::File::create(path.join(format!("{a}.jsonl"))).unwrap();
            let summary = run_tournament(&config, 1, 0, |r| {
                writeln!(file, "{}", serde_json::to_string(r).unwrap()).unwrap();
                Ok(())
            })
            .unwrap();
            writeln!(file, "{}", serde_json::to_string(&summary).unwrap()).unwrap();
        }
        assert_eq!(analyze(&path).unwrap()["strength_gate_passed"], false);
        let file = path.join("a.jsonl");
        let text = fs::read_to_string(&file).unwrap();
        fs::write(&file, format!("{}\n{}", text.lines().next().unwrap(), text)).unwrap();
        assert!(analyze(&path).unwrap_err().contains("重複"));
        let mut lines: Vec<_> = text.lines().collect();
        lines.pop();
        fs::write(&file, lines.join("\n") + "\n").unwrap();
        assert!(analyze(&path).unwrap_err().contains("完了"));
        fs::remove_dir_all(path).unwrap();
    }
}
