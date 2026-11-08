use serde_json::json;
use tetraboard_ai_engine::four_reversi::{PositionSetup, State};

#[test]
fn eliminated_colors_are_accepted_and_have_no_legal_moves() {
    let initial = State::initial();
    let setup = serde_json::from_value::<PositionSetup>(json!({
        "board": initial.board(), "turn":"black", "eliminatedColors":["white"]
    }));
    assert!(setup.is_ok(), "脱落順を局面入力として受理します");
    let state = State::from_setup(setup.unwrap()).unwrap();
    assert_eq!(state.legal_move_counts()[1], 0);
    assert_eq!(
        serde_json::to_value(state).unwrap()["eliminatedColors"],
        json!(["white"])
    );
}

#[test]
fn fixed_elimination_fixtures_cover_turns_ranks_passes_and_extinct_discs() {
    use serde_json::Value;
    use tetraboard_ai_engine::four_reversi::{Board, Color};
    let file: Value =
        serde_json::from_str(include_str!("../../../fixtures/elimination-v1.json")).unwrap();
    let snapshot = |state: &State| {
        let mut value = serde_json::to_value(state).unwrap();
        value["board"] = json!(state.board().map(|row| {
            row.map(|c| match c {
                None => '.',
                Some(Color::Black) => 'K',
                Some(Color::White) => 'W',
                Some(Color::Red) => 'R',
                Some(Color::Blue) => 'B',
            })
            .iter()
            .collect::<String>()
        }));
        value
    };
    for case in file["cases"].as_array().unwrap() {
        let mut input = case["input"].clone();
        let rows = input["board"].as_array().unwrap();
        let board: Board = std::array::from_fn(|y| {
            let row: Vec<_> = rows[y].as_str().unwrap().chars().collect();
            std::array::from_fn(|x| match row[x] {
                '.' => None,
                'K' => Some(Color::Black),
                'W' => Some(Color::White),
                'R' => Some(Color::Red),
                'B' => Some(Color::Blue),
                _ => panic!("不明な記号です"),
            })
        });
        input["board"] = json!(board);
        let mut state = State::from_setup(serde_json::from_value(input).unwrap()).unwrap();
        for step in case["steps"].as_array().unwrap() {
            assert_eq!(
                json!(state.legal_moves()),
                step["legalMoves"],
                "{}",
                case["name"]
            );
            let before = state.clone();
            let event = &step["event"];
            let actual = if event["type"] == "eliminate" {
                match state.eliminate(serde_json::from_value(event["color"].clone()).unwrap()) {
                    Ok(t) => {
                        let v = json!({"ok":true,"state":snapshot(&t.state),"passedColors":t.passed_colors});
                        state = t.state;
                        v
                    }
                    Err(e) => json!({"ok":false,"reason":e}),
                }
            } else {
                match state.apply_move(serde_json::from_value(event["position"].clone()).unwrap()) {
                    Ok(t) => {
                        let v = json!({"ok":true,"state":snapshot(&t.state),"flipped":t.flipped,"passedColors":t.passed_colors});
                        state = t.state;
                        v
                    }
                    Err(e) => json!({"ok":false,"reason":e}),
                }
            };
            assert_eq!(actual, step["expected"], "{} {:?}", case["name"], event);
            if actual["ok"] == false {
                assert_eq!(state, before);
            }
        }
    }
}
