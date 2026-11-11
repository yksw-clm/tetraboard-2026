use crate::{
    Agent, Decision, SearchStats,
    config::{AgentConfig, MctsBudget, RolloutPolicy},
    evaluation::{EvaluationWeights, evaluate},
};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;
use std::time::{Duration, Instant};
use tetraboard_ai_engine::four_reversi::{Position, State};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    Terminal,
    IterationLimit,
    NodeLimit,
    Deadline,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MctsStats {
    pub iterations_started: u64,
    pub trials: u64,
    pub max_tree_depth: u8,
    pub stop_reason: StopReason,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RootCandidate {
    pub position: Position,
    pub visits: u64,
    pub solo_wins: [u64; 4],
}

pub struct MctsAnalysis {
    pub decision: Decision,
    pub candidates: Vec<RootCandidate>,
}

pub struct MctsAgent {
    rng: ChaCha8Rng,
    weights: EvaluationWeights,
    rollout: RolloutPolicy,
    exploration: f64,
    budget: MctsBudget,
}

struct Node {
    state: State,
    unexpanded: Vec<Position>,
    children: Vec<(Position, usize)>,
    visits: u64,
    wins: [u64; 4],
}

impl Node {
    fn new(state: State) -> Self {
        let unexpanded = state.legal_moves();
        Self {
            state,
            unexpanded,
            children: Vec::new(),
            visits: 0,
            wins: [0; 4],
        }
    }
}

struct Work<'a> {
    nodes: u64,
    limit: u64,
    cancelled: &'a mut dyn FnMut() -> bool,
    reason: Option<StopReason>,
}

impl Work<'_> {
    fn check(&mut self) -> bool {
        if (self.cancelled)() {
            self.reason = Some(StopReason::Deadline);
            false
        } else {
            true
        }
    }
    fn apply(&mut self, state: &State, position: Position) -> Option<State> {
        if !self.check() {
            return None;
        }
        if self.nodes >= self.limit {
            self.reason = Some(StopReason::NodeLimit);
            return None;
        }
        let next = state
            .apply_move(position)
            .expect("Engineの合法手を適用します")
            .state;
        self.nodes += 1;
        Some(next)
    }
}

impl MctsAgent {
    pub fn new(config: &AgentConfig, game_seed: u64, stream: u64) -> Self {
        let AgentConfig::Mcts {
            seed,
            weights,
            rollout,
            exploration_milli,
            budget,
        } = config
        else {
            unreachable!()
        };
        let mut rng = ChaCha8Rng::seed_from_u64(game_seed.wrapping_add(*seed));
        rng.set_stream(stream);
        Self {
            rng,
            weights: weights.clone(),
            rollout: *rollout,
            exploration: f64::from(*exploration_milli) / 1000.0,
            budget: *budget,
        }
    }

    fn search(&mut self, state: &State, cancelled: &mut dyn FnMut() -> bool) -> Decision {
        self.search_with_candidates(state, cancelled, None)
    }

    /// 元の探索と同じ乱数列で根候補を収集し、外部の停止要求も確認します。
    pub fn analyze(&mut self, state: &State, cancelled: &mut dyn FnMut() -> bool) -> MctsAnalysis {
        let deadline = self
            .budget
            .max_time_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms));
        let mut candidates = Vec::new();
        let decision = self.search_with_candidates(
            state,
            &mut || cancelled() || deadline.is_some_and(|end| Instant::now() >= end),
            Some(&mut candidates),
        );
        MctsAnalysis {
            decision,
            candidates,
        }
    }

    fn search_with_candidates(
        &mut self,
        state: &State,
        cancelled: &mut dyn FnMut() -> bool,
        candidates: Option<&mut Vec<RootCandidate>>,
    ) -> Decision {
        let legal = state.legal_moves();
        let Some(player) = state.turn() else {
            return Decision {
                position: None,
                stats: SearchStats {
                    mcts: Some(MctsStats {
                        iterations_started: 0,
                        trials: 0,
                        max_tree_depth: 0,
                        stop_reason: StopReason::Terminal,
                    }),
                    ..Default::default()
                },
            };
        };
        let mut tree = vec![Node::new(state.clone())];
        let mut work = Work {
            nodes: 0,
            limit: self.budget.max_nodes,
            cancelled,
            reason: None,
        };
        let mut stats = MctsStats {
            iterations_started: 0,
            trials: 0,
            max_tree_depth: 0,
            stop_reason: StopReason::IterationLimit,
        };
        for _ in 0..self.budget.max_iterations {
            if !work.check() {
                break;
            }
            let mut path = vec![0];
            let mut cursor = 0;
            stats.iterations_started += 1;
            loop {
                if !work.check() {
                    break;
                }
                if tree[cursor].state.turn().is_none() {
                    break;
                }
                if !tree[cursor].unexpanded.is_empty() {
                    let index = self
                        .rng
                        .random_range(0..tree[cursor].unexpanded.len() as u32)
                        as usize;
                    let position = tree[cursor].unexpanded[index];
                    let Some(next) = work.apply(&tree[cursor].state, position) else {
                        break;
                    };
                    tree[cursor].unexpanded.swap_remove(index);
                    let child = tree.len();
                    tree.push(Node::new(next));
                    tree[cursor].children.push((position, child));
                    path.push(child);
                    cursor = child;
                    stats.max_tree_depth = stats.max_tree_depth.max((path.len() - 1) as u8);
                    break;
                }
                let actor = tree[cursor].state.turn().unwrap().index();
                let parent_visits = tree[cursor].visits.max(1) as f64;
                cursor = tree[cursor]
                    .children
                    .iter()
                    .max_by(|(pa, a), (pb, b)| {
                        let score = |index: usize| {
                            let node = &tree[index];
                            if node.visits == 0 {
                                f64::INFINITY
                            } else {
                                node.wins[actor] as f64 / node.visits as f64
                                    + self.exploration
                                        * (parent_visits.ln() / node.visits as f64).sqrt()
                            }
                        };
                        score(*a)
                            .total_cmp(&score(*b))
                            .then_with(|| position_key(*pb).cmp(&position_key(*pa)))
                    })
                    .expect("継続局面には合法な子があります")
                    .1;
                path.push(cursor);
            }
            if work.reason.is_some() {
                break;
            }
            let Some(reward) = self.playout(tree[cursor].state.clone(), &mut work) else {
                break;
            };
            for index in path {
                tree[index].visits += 1;
                for (value, increment) in tree[index].wins.iter_mut().zip(reward) {
                    *value += increment;
                }
            }
            stats.trials += 1;
        }
        if let Some(reason) = work.reason {
            stats.stop_reason = reason;
        }
        let position = tree[0]
            .children
            .iter()
            .filter(|(_, i)| tree[*i].visits > 0)
            .max_by(|(pa, a), (pb, b)| {
                let a = &tree[*a];
                let b = &tree[*b];
                a.visits
                    .cmp(&b.visits)
                    .then_with(|| {
                        (u128::from(a.wins[player.index()]) * u128::from(b.visits))
                            .cmp(&(u128::from(b.wins[player.index()]) * u128::from(a.visits)))
                    })
                    .then_with(|| position_key(*pb).cmp(&position_key(*pa)))
            })
            .map(|(p, _)| *p)
            .or_else(|| legal.first().copied());
        if let Some(candidates) = candidates {
            candidates.extend(
                tree[0]
                    .children
                    .iter()
                    .filter(|(_, index)| tree[*index].visits > 0)
                    .map(|(position, index)| RootCandidate {
                        position: *position,
                        visits: tree[*index].visits,
                        solo_wins: tree[*index].wins,
                    }),
            );
            candidates.sort_by(|a, b| {
                b.visits
                    .cmp(&a.visits)
                    .then_with(|| {
                        (u128::from(b.solo_wins[player.index()]) * u128::from(a.visits))
                            .cmp(&(u128::from(a.solo_wins[player.index()]) * u128::from(b.visits)))
                    })
                    .then_with(|| position_key(a.position).cmp(&position_key(b.position)))
            });
        }
        let interrupted = matches!(
            stats.stop_reason,
            StopReason::NodeLimit | StopReason::Deadline
        );
        Decision {
            position,
            stats: SearchStats {
                nodes: work.nodes,
                completed_depth: 0,
                interrupted,
                mcts: Some(stats),
            },
        }
    }

    fn playout(&mut self, mut state: State, work: &mut Work<'_>) -> Option<[u64; 4]> {
        while let Some(color) = state.turn() {
            let legal = state.legal_moves();
            if self.rollout == RolloutPolicy::Uniform || self.rng.random_range(0..8u32) == 0 {
                let position = legal[self.rng.random_range(0..legal.len() as u32) as usize];
                state = work.apply(&state, position)?;
            } else {
                let mut best = None;
                let mut best_score = i32::MIN;
                for position in legal {
                    let next = work.apply(&state, position)?;
                    let score = evaluate(&next, &self.weights)[color.index()];
                    if score > best_score {
                        best_score = score;
                        best = Some(next);
                    }
                }
                state = best.expect("継続局面には合法手があります");
            }
        }
        Some(terminal_reward(&state))
    }
}

impl Agent for MctsAgent {
    fn decide(&mut self, state: &State) -> Decision {
        let deadline = self
            .budget
            .max_time_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms));
        self.search(state, &mut || {
            deadline.is_some_and(|end| Instant::now() >= end)
        })
    }
}

fn position_key(position: Position) -> (i16, i16) {
    (position.y, position.x)
}

fn terminal_reward(state: &State) -> [u64; 4] {
    let result = state.result().expect("終局した試行だけを逆伝播します");
    let mut reward = [0; 4];
    if result.standings.iter().filter(|s| s.rank == 1).count() == 1 {
        let winner = result.standings.iter().find(|s| s.rank == 1).unwrap();
        reward[winner.color.index()] = 1;
    }
    reward
}

#[cfg(test)]
mod tests {
    use super::*;
    use tetraboard_ai_engine::four_reversi::{Color, PositionSetup};

    fn cfg() -> AgentConfig {
        AgentConfig::Mcts {
            seed: 0,
            weights: EvaluationWeights::default(),
            rollout: RolloutPolicy::Uniform,
            exploration_milli: 1000,
            budget: MctsBudget {
                max_iterations: 8,
                max_nodes: 4096,
                max_time_ms: None,
            },
        }
    }

    #[test]
    fn cancellation_discards_partial_playouts_without_wall_clock_assertions() {
        let state = State::initial();
        let mut agent = MctsAgent::new(&cfg(), 0, 0);
        let mut calls = 0;
        let decision = agent.search(&state, &mut || {
            calls += 1;
            calls > 8
        });
        assert!(decision.stats.nodes > 0);
        assert_eq!(decision.stats.mcts.as_ref().unwrap().trials, 0);
        assert_eq!(
            decision.stats.mcts.unwrap().stop_reason,
            StopReason::Deadline
        );
        assert_eq!(decision.position, state.legal_moves().first().copied());
    }

    #[test]
    fn shared_first_gets_no_solo_reward_and_unique_first_gets_one_component() {
        for shared in [true, false] {
            let mut board = [[Some(Color::Black); 8]; 8];
            let colors = [Color::Black, Color::White, Color::Red, Color::Blue];
            for (i, cell) in board.iter_mut().flatten().enumerate() {
                *cell = Some(colors[i / 16]);
            }
            board[0][0] = None;
            board[0][1] = Some(Color::White);
            board[0][2] = Some(Color::Black);
            if !shared {
                board[7][7] = Some(Color::Black);
            }
            let state = State::from_setup(PositionSetup {
                board,
                turn: Color::Black,
                move_number: 55,
                last_move: None,
                consecutive_passes: Vec::new(),
                eliminated_colors: Vec::new(),
            })
            .unwrap();
            let finished = state.apply_move(Position { x: 0, y: 0 }).unwrap().state;
            let reward = terminal_reward(&finished);
            assert_eq!(reward, if shared { [0; 4] } else { [1, 0, 0, 0] });
        }
    }
    #[test]
    fn baseline_preserves_moves_work_and_rng_streams() {
        let baseline: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/local-analysis-baseline.json"
        ))
        .unwrap();
        let profiles = crate::profiles::builtin_profiles().unwrap();
        for pair in baseline["cases"].as_array().unwrap().chunks(2) {
            let seed = pair[0]["seed"].as_u64().unwrap();
            let mut analyzer = MctsAgent::new(&profiles[4].config, seed, 0);
            for row in pair {
                let mut setup = row["state"].clone();
                setup.as_object_mut().unwrap().remove("result");
                let state = State::from_setup(serde_json::from_value(setup).unwrap()).unwrap();
                let report = analyzer.analyze(&state, &mut || false);
                let decision = &report.decision;
                assert_eq!(
                    serde_json::to_value(decision.position).unwrap(),
                    row["position"]
                );
                assert_eq!(serde_json::to_value(&decision.stats).unwrap(), row["stats"]);
                assert_eq!(
                    report.candidates.first().map(|c| c.position),
                    decision.position
                );
                assert!(
                    report
                        .candidates
                        .iter()
                        .all(|c| state.legal_moves().contains(&c.position)
                            && c.solo_wins.iter().sum::<u64>() <= c.visits)
                );
                assert_eq!(
                    report.candidates.iter().map(|c| c.visits).sum::<u64>(),
                    decision.stats.mcts.as_ref().unwrap().trials
                );
            }
        }
    }

    #[test]
    fn analysis_does_not_rank_unfinished_playouts() {
        let state = State::initial();
        let report = MctsAgent::new(&cfg(), 0, 0).analyze(&state, &mut || true);
        assert!(report.candidates.is_empty());
        assert_eq!(report.decision.stats.nodes, 0);
        assert_eq!(
            report.decision.stats.mcts.unwrap().stop_reason,
            StopReason::Deadline
        );
    }
}
