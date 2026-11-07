use crate::{AGENT_ID, evaluation::EvaluationWeights};
use serde::{Deserialize, Serialize};

pub const GREEDY_ID: &str = "four-reversi-greedy-v1";
pub const MAXN_ID: &str = "four-reversi-maxn-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchBudget {
    pub max_depth: u8,
    pub max_nodes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "agent_id", deny_unknown_fields)]
pub enum AgentConfig {
    #[serde(rename = "four-reversi-random-v1")]
    Random { seed: u64 },
    #[serde(rename = "four-reversi-greedy-v1")]
    Greedy {
        seed: u64,
        weights: EvaluationWeights,
    },
    #[serde(rename = "four-reversi-maxn-v1")]
    MaxN {
        seed: u64,
        weights: EvaluationWeights,
        budget: SearchBudget,
    },
}

impl AgentConfig {
    pub fn id(&self) -> &'static str {
        match self {
            Self::Random { .. } => AGENT_ID,
            Self::Greedy { .. } => GREEDY_ID,
            Self::MaxN { .. } => MAXN_ID,
        }
    }

    pub fn seed(&self) -> u64 {
        match self {
            Self::Random { seed } | Self::Greedy { seed, .. } | Self::MaxN { seed, .. } => *seed,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let weights = match self {
            Self::Random { .. } => return Ok(()),
            Self::Greedy { weights, .. } | Self::MaxN { weights, .. } => weights,
        };
        if [
            weights.stones,
            weights.endgame_stones,
            weights.mobility,
            weights.corners,
            weights.position,
        ]
        .iter()
        .any(|&n| !(-1000..=1000).contains(&n))
        {
            return Err("評価重みは-1000〜1000にしてください".into());
        }
        if let Self::MaxN { budget, .. } = self
            && (!(1..=6).contains(&budget.max_depth)
                || !(1..=1_000_000).contains(&budget.max_nodes))
        {
            return Err("探索は深さ1〜6、ノード予算1〜1000000にしてください".into());
        }
        Ok(())
    }
}
