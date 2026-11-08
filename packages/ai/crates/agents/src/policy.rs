use crate::{
    RandomAgent,
    config::AgentConfig,
    evaluation::{EvaluationWeights, evaluate},
};
use serde::Serialize;
use tetraboard_ai_engine::four_reversi::{Position, State};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct SearchStats {
    pub nodes: u64,
    pub completed_depth: u8,
    pub interrupted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcts: Option<crate::mcts::MctsStats>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    pub position: Option<Position>,
    pub stats: SearchStats,
}

pub trait Agent {
    fn decide(&mut self, state: &State) -> Decision;
}

impl Agent for RandomAgent {
    fn decide(&mut self, state: &State) -> Decision {
        Decision {
            position: self.choose_move(state),
            stats: SearchStats::default(),
        }
    }
}

struct EvaluatingAgent {
    config: AgentConfig,
}

pub fn build_agent(
    config: &AgentConfig,
    game_seed: u64,
    stream: u64,
) -> Result<Box<dyn Agent>, String> {
    config.validate()?;
    Ok(match config {
        AgentConfig::Random { seed } => {
            Box::new(RandomAgent::new(game_seed.wrapping_add(*seed), stream))
        }
        AgentConfig::Mcts { .. } => {
            Box::new(crate::mcts::MctsAgent::new(config, game_seed, stream))
        }
        _ => Box::new(EvaluatingAgent {
            config: config.clone(),
        }),
    })
}

impl Agent for EvaluatingAgent {
    fn decide(&mut self, state: &State) -> Decision {
        let legal = state.legal_moves();
        let Some(player) = state.turn() else {
            return Decision {
                position: None,
                stats: SearchStats::default(),
            };
        };
        let (weights, max_depth, limit) = match &self.config {
            AgentConfig::Greedy { weights, .. } => (weights, 1, u64::MAX),
            AgentConfig::MaxN {
                weights, budget, ..
            } => (weights, budget.max_depth, budget.max_nodes),
            AgentConfig::Random { .. } | AgentConfig::Mcts { .. } => unreachable!(),
        };
        let mut decision = Decision {
            position: legal.first().copied(),
            stats: SearchStats::default(),
        };
        let mut work = Work { nodes: 0, limit };
        for depth in 1..=max_depth {
            let mut best = None;
            let mut best_score = i32::MIN;
            for &position in &legal {
                let Some(next) = work.apply(state, position) else {
                    decision.stats.interrupted = true;
                    break;
                };
                let Some(values) = maxn(&next, depth - 1, weights, &mut work) else {
                    decision.stats.interrupted = true;
                    break;
                };
                if values[player.index()] > best_score {
                    best_score = values[player.index()];
                    best = Some(position);
                }
            }
            if decision.stats.interrupted {
                break;
            }
            decision.position = best;
            decision.stats.completed_depth = depth;
        }
        decision.stats.nodes = work.nodes;
        decision
    }
}

struct Work {
    nodes: u64,
    limit: u64,
}

impl Work {
    fn apply(&mut self, state: &State, position: Position) -> Option<State> {
        if self.nodes >= self.limit {
            return None;
        }
        self.nodes += 1;
        Some(
            state
                .apply_move(position)
                .expect("Engineの合法手を適用します")
                .state,
        )
    }
}

fn maxn(
    state: &State,
    remaining: u8,
    weights: &EvaluationWeights,
    work: &mut Work,
) -> Option<[i32; 4]> {
    let player = match state.turn() {
        Some(player) if remaining > 0 => player,
        _ => return Some(evaluate(state, weights)),
    };
    let mut best: Option<[i32; 4]> = None;
    for position in state.legal_moves() {
        let next = work.apply(state, position)?;
        let values = maxn(&next, remaining - 1, weights, work)?;
        // 自動パス後の実際の手番者が、本人の評価成分を最大化します。
        if best.is_none_or(|current| values[player.index()] > current[player.index()]) {
            best = Some(values);
        }
    }
    best
}
