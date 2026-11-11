//! 合法手から一様に選択する、再現可能なランダムAgentを提供します。

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use tetraboard_ai_engine::four_reversi::{Position, State};

pub mod config;
pub mod evaluation;
pub mod four_shogi;
pub mod mcts;
pub mod policy;
pub mod profiles;
pub use policy::{Agent, Decision, SearchStats, build_agent};

pub const AGENT_ID: &str = "four-reversi-random-v1";
pub const RNG_ID: &str = "rand_chacha-0.9.0/ChaCha8Rng/rand-0.9.2/u32-range";

pub struct RandomAgent {
    rng: ChaCha8Rng,
}

impl RandomAgent {
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        rng.set_stream(stream);
        Self { rng }
    }

    pub fn choose_move(&mut self, state: &State) -> Option<Position> {
        let moves = state.legal_moves();
        if moves.is_empty() {
            return None;
        }
        // 整数幅を固定して、32/64bit環境による抽選方法の違いを避けます。
        let index = self.rng.random_range(0..moves.len() as u32) as usize;
        Some(moves[index])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_agents_choose_legal_moves_without_changing_input() {
        let state = State::initial();
        let original = state.clone();
        let mut a = RandomAgent::new(42, 0);
        let mut b = RandomAgent::new(42, 0);
        let mut other_stream = RandomAgent::new(42, 1);
        let choices: Vec<_> = (0..128).map(|_| a.choose_move(&state).unwrap()).collect();
        assert!(choices.iter().all(|p| state.legal_moves().contains(p)));
        assert_eq!(
            choices,
            (0..128)
                .map(|_| b.choose_move(&state).unwrap())
                .collect::<Vec<_>>()
        );
        assert_ne!(
            choices,
            (0..128)
                .map(|_| other_stream.choose_move(&state).unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(state, original);
    }
}
