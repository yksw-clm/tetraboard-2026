use serde::Deserialize;
use serde_json::{Value, json};
use tetraboard_ai_engine::four_reversi::{Board, Color, Position, PositionSetup, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureFile {
    format_version: u32,
    cases: Vec<Fixture>,
}

#[derive(Deserialize)]
struct Fixture {
    name: String,
    input: Value,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    position: Position,
    legal_moves: Vec<Position>,
    expected: Value,
}

fn symbol(color: Option<Color>) -> char {
    match color {
        None => '.',
        Some(Color::Black) => 'K',
        Some(Color::White) => 'W',
        Some(Color::Red) => 'R',
        Some(Color::Blue) => 'B',
    }
}

fn decode_board(rows: &Value) -> Board {
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 8);
    std::array::from_fn(|y| {
        let row: Vec<_> = rows[y].as_str().unwrap().chars().collect();
        assert_eq!(row.len(), 8);
        std::array::from_fn(|x| match row[x] {
            '.' => None,
            'K' => Some(Color::Black),
            'W' => Some(Color::White),
            'R' => Some(Color::Red),
            'B' => Some(Color::Blue),
            other => panic!("不明な盤面記号です: {other}"),
        })
    })
}

fn snapshot(state: &State) -> Value {
    let mut value = serde_json::to_value(state).unwrap();
    value["board"] = json!(
        state
            .board()
            .map(|row| row.map(symbol).iter().collect::<String>())
    );
    value
}

#[test]
fn fixed_fixtures_match_legal_moves_transitions_passes_and_results() {
    let file: FixtureFile =
        serde_json::from_str(include_str!("../../../fixtures/four-reversi-v1.json")).unwrap();
    assert_eq!(file.format_version, 1);
    assert_eq!(file.cases.len(), 8);
    let mobility: Value =
        serde_json::from_str(include_str!("../../../fixtures/mobility-v1.json")).unwrap();
    let mut initial = snapshot(&State::initial());
    initial.as_object_mut().unwrap().remove("result");
    assert_eq!(initial, file.cases[0].input);
    for case in file.cases {
        let mut input = case.input;
        input["board"] = json!(decode_board(&input["board"]));
        let setup: PositionSetup = serde_json::from_value(input).unwrap();
        let mut state = State::from_setup(setup).unwrap();
        let expected_counts = mobility["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["name"] == case.name)
            .unwrap();
        assert_eq!(
            json!(state.legal_move_counts()),
            expected_counts["counts"],
            "{}",
            case.name
        );
        for step in case.steps {
            assert_eq!(state.legal_moves(), step.legal_moves, "{}", case.name);
            let original = state.clone();
            let actual = match state.apply_move(step.position) {
                Ok(transition) => {
                    let value = json!({"ok":true,"state":snapshot(&transition.state),"flipped":transition.flipped,"passedColors":transition.passed_colors});
                    assert_eq!(state, original);
                    state = transition.state;
                    value
                }
                Err(reason) => {
                    assert_eq!(state, original);
                    json!({"ok":false,"reason":reason})
                }
            };
            assert_eq!(
                actual, step.expected,
                "{} at {:?}",
                case.name, step.position
            );
        }
    }
}

#[test]
fn eight_capture_directions_do_not_wrap_or_drop_a_ray() {
    let mut board = [[None; 8]; 8];
    board[0][0] = Some(Color::White);
    board[0][7] = Some(Color::Red);
    board[7][0] = Some(Color::Blue);
    let mut expected = Vec::new();
    for dy in -1i16..=1 {
        for dx in -1i16..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            board[(3 + dy) as usize][(3 + dx) as usize] = Some(Color::White);
            board[(3 + dy * 2) as usize][(3 + dx * 2) as usize] = Some(Color::Black);
            expected.push(Position {
                x: 3 + dx,
                y: 3 + dy,
            });
        }
    }
    let state = State::from_setup(PositionSetup {
        board,
        turn: Color::Black,
        move_number: 0,
        last_move: None,
        consecutive_passes: Vec::new(),
    })
    .unwrap();
    let moved = state.apply_move(Position { x: 3, y: 3 }).unwrap();
    assert_eq!(moved.flipped, expected);
    for p in expected {
        assert_eq!(
            moved.state.board()[p.y as usize][p.x as usize],
            Some(Color::Black)
        );
    }
}

#[test]
fn setup_rejects_absent_colors_invalid_metadata_and_unplayable_turns() {
    let initial = State::initial();
    let setup = || PositionSetup {
        board: *initial.board(),
        turn: Color::Black,
        move_number: 0,
        last_move: None,
        consecutive_passes: Vec::new(),
    };
    let mut missing = setup();
    for cell in missing.board.iter_mut().flatten() {
        if *cell == Some(Color::Blue) {
            *cell = None;
        }
    }
    assert!(State::from_setup(missing).is_err());
    let mut bad_position = setup();
    bad_position.last_move = Some(Position { x: 8, y: 0 });
    assert!(State::from_setup(bad_position).is_err());
    let mut bad_pass = setup();
    bad_pass.consecutive_passes = vec![Color::Red, Color::Red];
    assert!(State::from_setup(bad_pass).is_err());
    let mut no_move = setup();
    no_move.board = [[Some(Color::Black); 8]; 8];
    no_move.board[0][0] = Some(Color::White);
    no_move.board[0][1] = Some(Color::Red);
    no_move.board[0][2] = Some(Color::Blue);
    assert!(State::from_setup(no_move).is_err());
}
