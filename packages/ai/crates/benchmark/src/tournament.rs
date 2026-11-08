use crate::{GameLog, play_configured_game};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tetraboard_ai_agents::config::AgentConfig;
use tetraboard_ai_engine::four_reversi::{COLORS, Color};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub config: AgentConfig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Matchup {
    pub id: String,
    pub lineup: [String; 4],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TournamentConfig {
    pub format_version: u32,
    pub seed: u64,
    pub profiles: Vec<Profile>,
    pub matchups: Vec<Matchup>,
    #[serde(default, skip_serializing_if = "SeatOrders::is_cyclic")]
    pub seat_orders: SeatOrders,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeatOrders {
    #[default]
    Cyclic,
    AllPermutations,
}
impl SeatOrders {
    fn is_cyclic(&self) -> bool {
        *self == Self::Cyclic
    }
    pub fn orders(self) -> Vec<[usize; 4]> {
        if self == Self::Cyclic {
            return (0..4)
                .map(|r| std::array::from_fn(|i| (i + r) % 4))
                .collect();
        }
        let mut result = Vec::new();
        for a in 0..4 {
            for b in 0..4 {
                for c in 0..4 {
                    for d in 0..4 {
                        let order = [a, b, c, d];
                        if order.iter().copied().collect::<BTreeSet<_>>().len() == 4 {
                            result.push(order);
                        }
                    }
                }
            }
        }
        result
    }
}

impl TournamentConfig {
    pub fn validate(&self) -> Result<(), String> {
        if ![1, 2].contains(&self.format_version)
            || self.profiles.is_empty()
            || self.matchups.is_empty()
        {
            return Err("設定版1でprofileとmatchupを1件以上指定してください".into());
        }
        if self.format_version == 1 && self.seat_orders != SeatOrders::Cyclic {
            return Err("全席順は設定版2を使ってください".into());
        }
        let mut profiles = BTreeSet::new();
        for profile in &self.profiles {
            if profile.id.is_empty() || !profiles.insert(&profile.id) {
                return Err("profile IDが空または重複しています".into());
            }
            profile.config.validate()?;
        }
        let mut matchups = BTreeSet::new();
        for matchup in &self.matchups {
            if matchup.id.is_empty() || !matchups.insert(&matchup.id) {
                return Err("matchup IDが空または重複しています".into());
            }
            if matchup.lineup.iter().any(|id| !profiles.contains(id)) {
                return Err(format!("{}に未知のprofileがあります", matchup.id));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct TournamentGame {
    pub record_type: &'static str,
    pub format_version: u32,
    pub trial_index: u64,
    pub matchup_id: String,
    pub round: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<u8>,
    pub lineup_slots: [usize; 4],
    pub profile_ids: [String; 4],
    pub game: Option<GameLog>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seat_order_index: Option<u8>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Summary {
    pub record_type: &'static str,
    pub format_version: u32,
    pub seed: u64,
    pub rounds: u64,
    pub rotations: u8,
    pub config: TournamentConfig,
    pub attempted_games: u64,
    pub completed_games: u64,
    pub failed_games: u64,
    pub distinct_game_traces: usize,
    pub failure_rate: f64,
    pub statistics: Vec<Statistics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jobs: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Statistics {
    pub matchup_id: String,
    pub profile_id: String,
    pub color: Option<Color>,
    pub attempted_appearances: u64,
    pub completed_appearances: u64,
    pub failed_appearances: u64,
    pub distinct_game_traces: usize,
    pub failure_rate: f64,
    pub mean_rank: Option<f64>,
    pub first_place_rate: Option<f64>,
    pub sole_first_rate: Option<f64>,
    pub shared_first_rate: Option<f64>,
    pub mean_score: Option<f64>,
    pub decisions: usize,
    pub mean_decision_time_ns: Option<f64>,
    pub p50_decision_time_ns: Option<u64>,
    pub p95_decision_time_ns: Option<u64>,
    pub max_decision_time_ns: Option<u64>,
    pub search_nodes: u64,
    pub interrupted_decisions: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trials: Option<u64>,
}

#[derive(Default)]
struct Accumulator {
    attempts: u64,
    completed: u64,
    rank: u64,
    score: u64,
    first: u64,
    sole: u64,
    shared: u64,
    timings: Vec<u64>,
    nodes: u64,
    interrupted: u64,
    traces: BTreeSet<String>,
    trials: Option<u64>,
}

type Group = (String, String, Option<usize>);

impl Accumulator {
    fn record(&mut self, game: Option<&GameLog>, color: Color) {
        self.attempts += 1;
        if let Some(game) = game {
            self.traces.insert(game_trace(game));
            let outcome = game
                .outcomes
                .iter()
                .find(|outcome| outcome.color == color)
                .expect("4色の結果があります");
            self.completed += 1;
            self.rank += u64::from(outcome.rank);
            self.score += u64::from(outcome.score);
            self.first += u64::from(outcome.won);
            self.shared += u64::from(outcome.shared_first);
            self.sole += u64::from(outcome.won && !outcome.shared_first);
            for entry in game.moves.iter().filter(|entry| entry.color == color) {
                self.timings.push(entry.decision_time_ns);
                self.nodes += entry.search_nodes;
                self.interrupted += u64::from(entry.interrupted.unwrap_or(false));
                if entry.mcts.is_some() {
                    *self.trials.get_or_insert(0) += entry.trials;
                }
            }
        }
    }

    fn finish(mut self, (matchup_id, profile_id, color): Group) -> Statistics {
        self.timings.sort_unstable();
        let mean = |sum: u64| (self.completed > 0).then(|| sum as f64 / self.completed as f64);
        Statistics {
            matchup_id,
            profile_id,
            color: color.map(|i| COLORS[i]),
            attempted_appearances: self.attempts,
            completed_appearances: self.completed,
            failed_appearances: self.attempts - self.completed,
            distinct_game_traces: self.traces.len(),
            failure_rate: (self.attempts - self.completed) as f64 / self.attempts as f64,
            mean_rank: mean(self.rank),
            first_place_rate: mean(self.first),
            sole_first_rate: mean(self.sole),
            shared_first_rate: mean(self.shared),
            mean_score: mean(self.score),
            decisions: self.timings.len(),
            mean_decision_time_ns: (!self.timings.is_empty()).then(|| {
                self.timings.iter().map(|&n| n as f64).sum::<f64>() / self.timings.len() as f64
            }),
            p50_decision_time_ns: percentile(&self.timings, 50),
            p95_decision_time_ns: percentile(&self.timings, 95),
            max_decision_time_ns: self.timings.last().copied(),
            search_nodes: self.nodes,
            interrupted_decisions: self.interrupted,
            trials: self.trials,
        }
    }
}

fn percentile(sorted: &[u64], percent: usize) -> Option<u64> {
    (!sorted.is_empty()).then(|| sorted[(sorted.len() * percent).div_ceil(100) - 1])
}

fn game_trace(game: &GameLog) -> String {
    serde_json::to_string(
        &game
            .moves
            .iter()
            .map(|entry| (entry.color, entry.position))
            .collect::<Vec<_>>(),
    )
    .expect("棋譜の色と座標を記録します")
}

pub fn run_tournament(
    config: &TournamentConfig,
    rounds: u64,
    seed: u64,
    output: impl FnMut(&TournamentGame) -> Result<(), String>,
) -> Result<Summary, String> {
    run_tournament_with_jobs(config, rounds, seed, 1, output)
}

pub fn run_tournament_with_jobs(
    config: &TournamentConfig,
    rounds: u64,
    seed: u64,
    jobs: usize,
    mut output: impl FnMut(&TournamentGame) -> Result<(), String>,
) -> Result<Summary, String> {
    config.validate()?;
    let orders = config.seat_orders.orders();
    if rounds == 0
        || !(1..=4).contains(&jobs)
        || rounds
            .checked_mul(orders.len() as u64)
            .and_then(|n| n.checked_mul(config.matchups.len() as u64))
            .is_none()
    {
        return Err("roundsは1以上・総件数はu64以内、jobsは1〜4にしてください".into());
    }
    let version = if config.format_version == 2 { 3 } else { 2 };
    let mut attempted_games = 0;
    let mut failed_games = 0;
    let mut groups: BTreeMap<Group, Accumulator> = BTreeMap::new();
    let mut traces = BTreeSet::new();
    for matchup in &config.matchups {
        let profiles = matchup
            .lineup
            .each_ref()
            .map(|id| config.profiles.iter().find(|p| &p.id == id).unwrap());
        // 同時に保持する棋譜をjobs件までに抑え、結果の出力順も固定します。
        for round in 0..rounds {
            for (chunk_index, chunk) in orders.chunks(jobs).enumerate() {
                let games = std::thread::scope(|scope| {
                    let handles: Vec<_> = chunk
                        .iter()
                        .map(|slots| {
                            let configs = slots.map(|i| profiles[i].config.clone());
                            let streams = slots.map(|i| i as u64);
                            scope
                                .spawn(move || play_configured_game(seed, round, &configs, streams))
                        })
                        .collect();
                    handles
                        .into_iter()
                        .map(|h| {
                            h.join()
                                .unwrap_or_else(|_| Err("対局処理がpanicしました".into()))
                        })
                        .collect::<Vec<_>>()
                });
                for (offset, (slots, result)) in chunk.iter().zip(games).enumerate() {
                    let index = (chunk_index * jobs + offset) as u8;
                    let profile_ids = slots.map(|i| profiles[i].id.clone());
                    let (game, error) = match result {
                        Ok(mut game) => {
                            game.format_version = version;
                            traces.insert(game_trace(&game));
                            for (seat, id) in game.seat_order.iter_mut().zip(&profile_ids) {
                                seat.profile_id = Some(id.clone());
                            }
                            (Some(game), None)
                        }
                        Err(error) => {
                            failed_games += 1;
                            (None, Some(error))
                        }
                    };
                    let record = TournamentGame {
                        record_type: "game",
                        format_version: version,
                        trial_index: attempted_games,
                        matchup_id: matchup.id.clone(),
                        round,
                        rotation: (config.seat_orders == SeatOrders::Cyclic).then_some(index),
                        lineup_slots: *slots,
                        profile_ids,
                        game,
                        error,
                        seat_order_index: (version == 3).then_some(index),
                    };
                    for (i, id) in record.profile_ids.iter().enumerate() {
                        for color in [None, Some(i)] {
                            groups
                                .entry((matchup.id.clone(), id.clone(), color))
                                .or_default()
                                .record(record.game.as_ref(), COLORS[i]);
                        }
                    }
                    output(&record)?;
                    attempted_games += 1;
                }
            }
        }
    }
    Ok(Summary {
        record_type: "summary",
        format_version: version,
        seed,
        rounds,
        rotations: orders.len() as u8,
        config: config.clone(),
        attempted_games,
        completed_games: attempted_games - failed_games,
        failed_games,
        distinct_game_traces: traces.len(),
        failure_rate: failed_games as f64 / attempted_games as f64,
        statistics: groups
            .into_iter()
            .map(|(key, value)| value.finish(key))
            .collect(),
        jobs: (version == 3).then_some(jobs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_profiles_unknown_ids_and_invalid_budgets_are_rejected() {
        let mut config: TournamentConfig =
            serde_json::from_str(include_str!("../../../configs/phase1.json")).unwrap();
        config.validate().unwrap();
        config.profiles.push(config.profiles[0].clone());
        assert!(config.validate().is_err());
        config.profiles.pop();
        config.matchups[0].lineup[0] = "missing".into();
        assert!(config.validate().is_err());
    }

    #[test]
    fn rotations_balance_seats_and_keep_seeded_trials_reproducible() {
        let mut config: TournamentConfig =
            serde_json::from_str(include_str!("../../../configs/phase1.json")).unwrap();
        config.matchups.truncate(1);
        for profile in &mut config.profiles {
            profile.config = AgentConfig::Random { seed: 0 };
        }
        let mut records = Vec::new();
        let summary = run_tournament(&config, 2, 7, |record| {
            records.push(record.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(records.len(), 8);
        assert_eq!(summary.failed_games, 0);
        for round in 0..2 {
            for slot in 0..4 {
                let colors: BTreeSet<_> = records
                    .iter()
                    .filter(|r| r.round == round)
                    .map(|r| r.lineup_slots.iter().position(|&s| s == slot).unwrap())
                    .collect();
                assert_eq!(colors.len(), 4);
            }
        }
        let mut second = Vec::new();
        run_tournament(&config, 2, 7, |r| {
            second.push(r.clone());
            Ok(())
        })
        .unwrap();
        for (first, second) in records.iter().zip(second) {
            let first = first.game.as_ref().unwrap();
            let second = second.game.as_ref().unwrap();
            assert_eq!(first.final_state, second.final_state);
            assert_eq!(
                first.moves.iter().map(|m| m.position).collect::<Vec<_>>(),
                second.moves.iter().map(|m| m.position).collect::<Vec<_>>()
            );
        }
    }

    #[test]
    fn aggregation_distinguishes_ties_failures_and_latency_samples() {
        let game = crate::play_game(0, 0).unwrap();
        let mut stats = Accumulator::default();
        for color in COLORS {
            stats.record(Some(&game), color);
        }
        stats.record(None, Color::Black);
        let values = stats.finish(("match".into(), "profile".into(), None));
        assert_eq!(values.completed_appearances, 4);
        assert_eq!(values.failed_appearances, 1);
        assert_eq!(values.distinct_game_traces, 1);
        assert_eq!(values.first_place_rate, Some(0.5));
        assert_eq!(values.shared_first_rate, Some(0.5));
        assert_eq!(values.sole_first_rate, Some(0.0));
        assert_eq!(values.mean_rank, Some(2.25));
        assert_eq!(percentile(&[], 95), None);
        assert_eq!(percentile(&[1, 2, 3, 4, 5], 95), Some(5));
        assert_eq!(percentile(&[1, 2, 3, 4, 5], 50), Some(3));
        let mut failed = Accumulator::default();
        failed.record(None, Color::Black);
        assert_eq!(
            failed.finish(("m".into(), "p".into(), None)).mean_rank,
            None
        );
    }

    #[test]
    fn deterministic_repeats_do_not_inflate_the_distinct_trace_count() {
        let mut config: TournamentConfig =
            serde_json::from_str(include_str!("../../../configs/phase1.json")).unwrap();
        config.matchups.truncate(1);
        for profile in &mut config.profiles {
            profile.config = AgentConfig::Greedy {
                seed: 0,
                weights: Default::default(),
            };
        }
        let summary = run_tournament(&config, 2, 0, |_| Ok(())).unwrap();
        assert_eq!(summary.completed_games, 8);
        assert_eq!(summary.distinct_game_traces, 1);
        assert!(
            summary
                .statistics
                .iter()
                .all(|stats| stats.distinct_game_traces == 1)
        );
    }
    #[test]
    fn all_seat_orders_preserve_fixed_budget_games_across_parallelism() {
        let mut config: TournamentConfig =
            serde_json::from_str(include_str!("../../../configs/phase1.json")).unwrap();
        config.format_version = 2;
        config.seat_orders = SeatOrders::AllPermutations;
        config.matchups = vec![Matchup {
            id: "parallel".into(),
            lineup: ["lv1".into(), "lv1".into(), "lv1".into(), "lv3".into()],
        }];
        config.profiles[2].config = AgentConfig::Mcts {
            seed: 0,
            weights: Default::default(),
            rollout: tetraboard_ai_agents::config::RolloutPolicy::Uniform,
            exploration_milli: 1000,
            budget: tetraboard_ai_agents::config::MctsBudget {
                max_iterations: 2,
                max_nodes: 256,
                max_time_ms: None,
            },
        };
        let mut first = Vec::new();
        let summary = run_tournament_with_jobs(&config, 1, 7, 1, |r| {
            first.push(r.clone());
            Ok(())
        })
        .unwrap();
        let mut second = Vec::new();
        run_tournament_with_jobs(&config, 1, 7, 4, |r| {
            second.push(r.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(summary.completed_games, 24);
        assert_eq!(
            first
                .iter()
                .map(|r| r.lineup_slots)
                .collect::<BTreeSet<_>>()
                .len(),
            24
        );
        for (a, b) in first.iter().zip(second) {
            assert_eq!(a.trial_index, b.trial_index);
            assert_eq!(a.seat_order_index, b.seat_order_index);
            let a = a.game.as_ref().unwrap();
            let b = b.game.as_ref().unwrap();
            assert_eq!(a.final_state, b.final_state);
            assert_eq!(
                a.moves
                    .iter()
                    .map(|m| (m.position, m.trials, m.search_nodes))
                    .collect::<Vec<_>>(),
                b.moves
                    .iter()
                    .map(|m| (m.position, m.trials, m.search_nodes))
                    .collect::<Vec<_>>()
            );
        }
    }
}
