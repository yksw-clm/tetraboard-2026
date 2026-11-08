use tetraboard_ai_agents::{
    build_agent,
    config::{AgentConfig, SearchBudget},
    evaluation::{EvaluationWeights, evaluate},
};
use tetraboard_ai_engine::four_reversi::{Board, Color, Position, PositionSetup, State};

fn setup(board: Board, turn: Color, move_number: u8) -> State {
    State::from_setup(PositionSetup {
        board,
        turn,
        move_number,
        last_move: None,
        consecutive_passes: vec![],
        eliminated_colors: Vec::new(),
    })
    .unwrap()
}

fn rows(text: [&str; 8]) -> Board {
    text.map(|row| {
        let cells: Vec<_> = row
            .chars()
            .map(|symbol| match symbol {
                '.' => None,
                'K' => Some(Color::Black),
                'W' => Some(Color::White),
                'R' => Some(Color::Red),
                'B' => Some(Color::Blue),
                _ => panic!("不明な記号です"),
            })
            .collect();
        cells.try_into().unwrap()
    })
}

fn maxn(weights: EvaluationWeights, max_depth: u8, max_nodes: u64) -> AgentConfig {
    AgentConfig::MaxN {
        seed: 0,
        weights,
        budget: SearchBudget {
            max_depth,
            max_nodes,
        },
    }
}

#[test]
fn greedy_takes_a_valuable_corner_even_when_it_is_not_the_first_move() {
    let state = setup(
        rows([
            "RRBB....", "........", "........", ".WK.....", "........", "........", "........",
            ".....KW.",
        ]),
        Color::Black,
        0,
    );
    let original = state.clone();
    let config = AgentConfig::Greedy {
        seed: 0,
        weights: EvaluationWeights {
            stones: 0,
            endgame_stones: 0,
            mobility: 0,
            corners: 100,
            position: 0,
        },
    };
    assert_ne!(state.legal_moves()[0], Position { x: 7, y: 7 });
    let decision = build_agent(&config, 0, 0).unwrap().decide(&state);
    assert_eq!(decision.position, Some(Position { x: 7, y: 7 }));
    assert_eq!(decision.stats.completed_depth, 1);
    assert_eq!(state, original);
}

#[test]
fn equal_evaluations_use_row_order_and_depth_one_matches_greedy() {
    let state = State::initial();
    let zero = EvaluationWeights {
        stones: 0,
        endgame_stones: 0,
        mobility: 0,
        corners: 0,
        position: 0,
    };
    let greedy = build_agent(
        &AgentConfig::Greedy {
            seed: 0,
            weights: zero.clone(),
        },
        0,
        0,
    )
    .unwrap()
    .decide(&state);
    assert_eq!(greedy.position, Some(state.legal_moves()[0]));
    assert_eq!(
        greedy,
        build_agent(&maxn(zero, 1, 64), 9, 2)
            .unwrap()
            .decide(&state)
    );
}

#[test]
fn budget_exhaustion_retains_the_last_complete_depth_or_a_legal_fallback() {
    let state = State::initial();
    let original = state.clone();
    let weights = EvaluationWeights::default();
    let greedy = build_agent(
        &AgentConfig::Greedy {
            seed: 0,
            weights: weights.clone(),
        },
        0,
        0,
    )
    .unwrap()
    .decide(&state);
    let tiny = build_agent(&maxn(weights.clone(), 3, 1), 0, 0)
        .unwrap()
        .decide(&state);
    assert_eq!(tiny.position, Some(state.legal_moves()[0]));
    assert_eq!(tiny.stats.completed_depth, 0);
    assert_eq!(tiny.stats.nodes, 1);
    assert!(tiny.stats.interrupted);
    let config = maxn(weights, 3, state.legal_moves().len() as u64);
    let decision = build_agent(&config, 0, 0).unwrap().decide(&state);
    assert_eq!(decision.position, greedy.position);
    assert_eq!(decision.stats.completed_depth, 1);
    assert!(decision.stats.interrupted);
    assert_eq!(
        decision,
        build_agent(&config, u64::MAX, 3).unwrap().decide(&state)
    );
    assert_eq!(state, original);
}

#[test]
fn maxn_finds_second_place_after_three_passes_instead_of_third_place() {
    // 共有fixtureを180度回転し、悪い手H2が列挙順の先頭になるようにします。
    let source = rows([
        "KBBRRRRR", "KKKKKKWW", "KKKKBWWW", "KKBKWWWW", "KKBWWWWW", "K.WWWWWW", ".WBRWRWW",
        "BBBRRRRW",
    ]);
    let board = std::array::from_fn(|y| std::array::from_fn(|x| source[7 - y][7 - x]));
    let state = setup(board, Color::Red, 54);
    assert_eq!(state.legal_moves()[0], Position { x: 7, y: 1 });
    let decision = build_agent(&maxn(EvaluationWeights::default(), 2, 64), 0, 0)
        .unwrap()
        .decide(&state);
    assert_eq!(decision.position, Some(Position { x: 6, y: 2 }));
    assert_eq!(decision.stats.completed_depth, 2);
    let first = state.apply_move(decision.position.unwrap()).unwrap();
    assert_eq!(
        first.passed_colors,
        vec![Color::Blue, Color::Black, Color::White]
    );
    assert_eq!(first.state.turn(), Some(Color::Red));
    let last = first.state.apply_move(Position { x: 7, y: 1 }).unwrap();
    let standing = last
        .state
        .result()
        .unwrap()
        .standings
        .iter()
        .find(|s| s.color == Color::Red)
        .unwrap();
    assert_eq!((standing.rank, standing.stone_count), (2, Some(19)));
    let bad = state.apply_move(Position { x: 7, y: 1 }).unwrap().state;
    let bad = bad.apply_move(Position { x: 6, y: 2 }).unwrap().state;
    assert_eq!(
        bad.result()
            .unwrap()
            .standings
            .iter()
            .find(|s| s.color == Color::Red)
            .unwrap()
            .rank,
        3
    );
}

#[test]
fn terminal_evaluation_uses_rank_then_stones_and_agents_return_no_move() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/four-reversi-v1.json")).unwrap();
    let case = fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == "full-board-and-shared-ranks")
        .unwrap();
    let strings: [&str; 8] = std::array::from_fn(|i| case["input"]["board"][i].as_str().unwrap());
    let state = setup(rows(strings), Color::Black, 55)
        .apply_move(Position { x: 7, y: 7 })
        .unwrap()
        .state;
    let values = evaluate(&state, &EvaluationWeights::default());
    assert_eq!(values, [3_000_020, 3_000_020, -999_988, -999_988]);
    assert_eq!(state.legal_move_counts(), [0; 4]);
    for config in [
        AgentConfig::Random { seed: 0 },
        AgentConfig::Greedy {
            seed: 0,
            weights: EvaluationWeights::default(),
        },
        maxn(EvaluationWeights::default(), 3, 64),
    ] {
        assert_eq!(
            build_agent(&config, 0, 0).unwrap().decide(&state).position,
            None
        );
    }
}

#[test]
fn config_rejects_unknown_policy_fields_and_unbounded_search() {
    assert!(serde_json::from_str::<AgentConfig>(r#"{"agent_id":"missing","seed":0}"#).is_err());
    assert!(
        serde_json::from_str::<AgentConfig>(
            r#"{"agent_id":"four-reversi-random-v1","seed":0,"unused":1}"#
        )
        .is_err()
    );
    assert!(build_agent(&maxn(EvaluationWeights::default(), 0, 1), 0, 0).is_err());
    assert!(build_agent(&maxn(EvaluationWeights::default(), 3, 0), 0, 0).is_err());
    assert!(build_agent(&maxn(EvaluationWeights::default(), 7, 1), 0, 0).is_err());
    let weights = EvaluationWeights {
        corners: 1001,
        ..EvaluationWeights::default()
    };
    assert!(build_agent(&maxn(weights, 2, 64), 0, 0).is_err());
}
