use tetraboard_ai_agents::{
    Agent, build_agent,
    config::{AgentConfig, MctsBudget, RolloutPolicy},
    evaluation::EvaluationWeights,
    mcts::StopReason,
};
use tetraboard_ai_engine::four_reversi::State;

fn config(nodes: u64, iterations: u64, rollout: RolloutPolicy) -> AgentConfig {
    AgentConfig::Mcts {
        seed: 7,
        weights: EvaluationWeights::default(),
        rollout,
        exploration_milli: 1414,
        budget: MctsBudget {
            max_nodes: nodes,
            max_iterations: iterations,
            max_time_ms: None,
        },
    }
}

#[test]
fn completed_trials_are_reported_and_seeded_decisions_repeat() {
    let state = State::initial();
    let original = state.clone();
    for rollout in [RolloutPolicy::Uniform, RolloutPolicy::EpsilonGreedy] {
        let cfg = config(65_536, 8, rollout);
        let a = build_agent(&cfg, 42, 1).unwrap().decide(&state);
        let b = build_agent(&cfg, 42, 1).unwrap().decide(&state);
        assert_eq!(a, b);
        assert!(state.legal_moves().contains(&a.position.unwrap()));
        assert!(a.stats.nodes > 0, "MCTSは仮着手を数えます");
        let stats = a.stats.mcts.unwrap();
        assert_eq!(stats.trials, 8, "終局まで完了した試行を数えます");
        assert_eq!(stats.stop_reason, StopReason::IterationLimit);
        assert_eq!(state, original);
    }
}

#[test]
fn an_unfinished_rollout_cannot_be_reported_as_a_completed_trial() {
    let state = State::initial();
    let result = build_agent(&config(1, 8, RolloutPolicy::Uniform), 0, 0)
        .unwrap()
        .decide(&state);
    assert_eq!(result.stats.nodes, 1);
    let stats = result.stats.mcts.unwrap();
    assert_eq!(stats.trials, 0);
    assert_eq!(stats.stop_reason, StopReason::NodeLimit);
    assert_eq!(result.position, state.legal_moves().first().copied());
}

#[test]
fn mixed_agents_finish_games_with_legal_moves_and_bounded_work() {
    for seed in 0..4 {
        let cfg = config(512, 4, RolloutPolicy::Uniform);
        let mut agents: Vec<Box<dyn Agent>> = (0..4)
            .map(|i| build_agent(&cfg, seed, i).unwrap())
            .collect();
        let mut state = State::initial();
        while let Some(color) = state.turn() {
            let result = agents[color.index()].decide(&state);
            assert!(result.stats.nodes <= 512);
            let next = state.apply_move(result.position.unwrap()).unwrap().state;
            assert_eq!(next.move_number(), state.move_number() + 1);
            state = next;
        }
        assert!(state.move_number() <= 56);
        let result = agents[0].decide(&state);
        assert_eq!(result.position, None);
        assert!(
            result.stats.mcts.is_some(),
            "終局で探索しなかった理由も診断へ残します"
        );
        assert_eq!(result.stats.mcts.unwrap().stop_reason, StopReason::Terminal);
    }
}
