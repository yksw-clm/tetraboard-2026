//! ランダムAgent4人の自動対局と、再生可能な計測ログを提供します。

use serde::Serialize;
use std::time::{Duration, Instant};
use tetraboard_ai_agents::{RNG_ID, build_agent, config::AgentConfig as PolicyConfig};
use tetraboard_ai_engine::four_reversi::{
    COLORS, Color, ENGINE_VERSION, MAX_MOVES, Position, RULESET_VERSION, State,
};

pub mod tournament;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentSeat {
    pub color: Color,
    pub agent_id: &'static str,
    pub agent_config: AgentConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AgentConfig {
    pub rng: &'static str,
    pub seed: u64,
    pub stream: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<PolicyConfig>,
}

#[derive(Clone, Debug, Serialize)]
pub struct MoveLog {
    pub move_number: u8,
    pub color: Color,
    pub legal_moves: Vec<Position>,
    pub position: Position,
    pub flipped: Vec<Position>,
    pub passed_colors: Vec<Color>,
    pub decision_time_ns: u64,
    pub search_nodes: u64,
    pub trials: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_depth: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub color: Color,
    pub score: u8,
    pub rank: u8,
    pub won: bool,
    pub shared_first: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct GameLog {
    pub format_version: u32,
    pub ruleset_version: &'static str,
    pub engine_version: &'static str,
    pub seed_derivation: &'static str,
    pub tie_policy: &'static str,
    pub seed: u64,
    pub game_index: u64,
    pub game_seed: u64,
    pub seat_order: [AgentSeat; 4],
    pub initial_state: State,
    pub moves: Vec<MoveLog>,
    pub final_state: State,
    pub outcomes: [Outcome; 4],
    pub total_time_ns: u64,
}

pub fn play_game(seed: u64, game_index: u64) -> Result<GameLog, String> {
    play(seed, game_index, None)
}

pub fn play_configured_game(
    seed: u64,
    round: u64,
    configs: &[PolicyConfig; 4],
    streams: [u64; 4],
) -> Result<GameLog, String> {
    play(seed, round, Some((configs, streams)))
}

fn play(
    seed: u64,
    game_index: u64,
    configured: Option<(&[PolicyConfig; 4], [u64; 4])>,
) -> Result<GameLog, String> {
    let started = Instant::now();
    let game_seed = seed.wrapping_add(game_index);
    let defaults = std::array::from_fn(|_| PolicyConfig::Random { seed: 0 });
    let (configs, streams) = configured.unwrap_or((&defaults, [0, 1, 2, 3]));
    let seat_order = COLORS.map(|color| AgentSeat {
        color,
        agent_id: configs[color.index()].id(),
        agent_config: AgentConfig {
            rng: if matches!(configs[color.index()], PolicyConfig::Random { .. }) {
                RNG_ID
            } else {
                "none"
            },
            seed: game_seed.wrapping_add(configs[color.index()].seed()),
            stream: streams[color.index()],
            policy: configured.map(|_| configs[color.index()].clone()),
        },
        profile_id: None,
    });
    let mut agents = configs
        .iter()
        .enumerate()
        .map(|(i, config)| build_agent(config, game_seed, streams[i]))
        .collect::<Result<Vec<_>, _>>()?;
    let initial_state = State::initial();
    let mut state = initial_state.clone();
    let mut moves = Vec::new();
    while let Some(color) = state.turn() {
        if state.move_number() >= MAX_MOVES {
            return Err("56着手以内に終局しませんでした".into());
        }
        let legal_moves = state.legal_moves();
        let deciding = Instant::now();
        let decision = agents[color.index()].decide(&state);
        let position = decision
            .position
            .ok_or("継続中の手番でAgentが着手を返しませんでした")?;
        let decision_time_ns = nanoseconds(deciding.elapsed());
        if !legal_moves.contains(&position) {
            return Err("Agentが非合法手を返しました".into());
        }
        let transition = state
            .apply_move(position)
            .map_err(|error| error.to_string())?;
        moves.push(MoveLog {
            move_number: transition.state.move_number(),
            color,
            legal_moves,
            position,
            flipped: transition.flipped,
            passed_colors: transition.passed_colors,
            decision_time_ns,
            search_nodes: decision.stats.nodes,
            trials: 0,
            completed_depth: configured.map(|_| decision.stats.completed_depth),
            interrupted: configured.map(|_| decision.stats.interrupted),
        });
        state = transition.state;
    }
    let result = state.result().ok_or("終局結果がありません")?;
    let winners = result
        .standings
        .iter()
        .filter(|standing| standing.rank == 1)
        .count();
    let outcomes = result.standings.clone().map(|standing| Outcome {
        color: standing.color,
        score: standing.stone_count,
        rank: standing.rank,
        won: standing.rank == 1,
        shared_first: standing.rank == 1 && winners > 1,
    });
    Ok(GameLog {
        format_version: if configured.is_some() { 2 } else { 1 },
        ruleset_version: RULESET_VERSION,
        engine_version: ENGINE_VERSION,
        seed_derivation: if configured.is_some() {
            "game_seed=seed.wrapping_add(round); agent_seed=game_seed.wrapping_add(profile.seed); stream=lineup_slot"
        } else {
            "game_seed=seed.wrapping_add(game_index); stream=color_index(black,white,red,blue)"
        },
        tie_policy: "competition-ranking; shared-first-is-win; singles-has-no-draw",
        seed,
        game_index,
        game_seed,
        seat_order,
        initial_state,
        moves,
        final_state: state,
        outcomes,
        total_time_ns: nanoseconds(started.elapsed()),
    })
}

fn nanoseconds(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tetraboard_ai_agents::RandomAgent;
    use tetraboard_ai_engine::four_reversi::{EndReason, count_stones};

    fn without_timings(log: &GameLog) -> serde_json::Value {
        let mut value = serde_json::to_value(log).unwrap();
        value.as_object_mut().unwrap().remove("total_time_ns");
        for entry in value["moves"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().remove("decision_time_ns");
        }
        value
    }

    #[test]
    fn hundred_games_finish_reproduce_and_preserve_rule_invariants() {
        for seed in 0..100 {
            let log = play_game(seed, 0).unwrap();
            assert_eq!(
                without_timings(&log),
                without_timings(&play_game(seed, 0).unwrap())
            );
            let mut state = State::initial();
            for entry in &log.moves {
                let before = state.clone();
                assert_eq!(state.turn(), Some(entry.color));
                assert_eq!(state.legal_moves(), entry.legal_moves);
                let next = state.apply_move(entry.position).unwrap();
                assert_eq!(state, before);
                assert_eq!(next.flipped, entry.flipped);
                assert_eq!(next.passed_colors, entry.passed_colors);
                let old_counts = count_stones(state.board());
                let new_counts = count_stones(next.state.board());
                assert_eq!(
                    new_counts.iter().sum::<u8>(),
                    old_counts.iter().sum::<u8>() + 1
                );
                assert!(new_counts.iter().all(|&count| count > 0));
                state = next.state;
            }
            assert_eq!(state, log.final_state);
            assert!(state.turn().is_none());
            assert!(state.legal_moves().is_empty());
            assert_eq!(log.moves.len(), usize::from(state.move_number()));
            assert!(state.move_number() <= MAX_MOVES);
            let result = state.result().unwrap();
            let counts = count_stones(state.board());
            for standing in &result.standings {
                assert_eq!(standing.stone_count, counts[standing.color.index()]);
                assert_eq!(
                    standing.rank,
                    1 + counts.iter().filter(|&&n| n > standing.stone_count).count() as u8
                );
            }
            match result.reason {
                EndReason::BoardFull => assert_eq!(counts.iter().sum::<u8>(), 64),
                EndReason::AllPassed => {
                    assert!(
                        COLORS
                            .iter()
                            .all(|color| state.consecutive_passes().contains(color))
                    );
                }
            }
            assert_eq!(
                state.apply_move(Position { x: 0, y: 0 }),
                Err(tetraboard_ai_engine::four_reversi::MoveError::GameFinished)
            );
            assert!(RandomAgent::new(seed, 0).choose_move(&state).is_none());
        }
    }

    #[test]
    fn game_seed_wraps_and_seats_have_separate_streams() {
        let log = play_game(u64::MAX, 1).unwrap();
        assert_eq!(log.game_seed, 0);
        for (i, seat) in log.seat_order.iter().enumerate() {
            assert_eq!(seat.agent_config.seed, 0);
            assert_eq!(seat.agent_config.stream, i as u64);
        }
        assert_eq!(log.outcomes, play_game(0, 0).unwrap().outcomes);
    }
}
