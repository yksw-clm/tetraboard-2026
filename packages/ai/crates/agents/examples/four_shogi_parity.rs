use serde::Deserialize;
use std::io::{self, BufRead};
use tetraboard_ai_agents::four_shogi::static_evaluation;
use tetraboard_ai_engine::four_shogi::{Action, EndReason, Event, Side, State};

#[derive(Deserialize)]
struct Position {
    index: usize,
    turn: Side,
    ranks: [u8; 4],
    actions: Vec<Action>,
    evaluation: Option<[f64; 4]>,
}

#[derive(Deserialize)]
struct Replay {
    restricted: bool,
    events: Vec<Event>,
    checkpoints: Vec<Position>,
    reason: Option<EndReason>,
    ranks: [u8; 4],
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut games = 0;
    let mut events = 0;
    let mut checkpoints = 0;
    for line in io::stdin().lock().lines() {
        let replay: Replay = serde_json::from_str(&line?)?;
        let (mut state, mut history) = State::start(replay.restricted);
        let mut expected = replay.checkpoints.into_iter().peekable();
        for (index, event) in replay.events.into_iter().enumerate() {
            if expected.peek().is_some_and(|point| point.index == index) {
                let point = expected.next().expect("比較対象があります");
                assert_eq!(
                    state.turn(),
                    Some(point.turn),
                    "game {games}, event {index}"
                );
                assert_eq!(state.ranks(), point.ranks, "game {games}, event {index}");
                let actions: Vec<_> = state.legal_moves().into_iter().map(|m| m.action).collect();
                assert_eq!(actions, point.actions, "game {games}, event {index}");
                if let Some(evaluation) = point.evaluation {
                    for (rust, ts) in static_evaluation(&state).into_iter().zip(evaluation) {
                        assert!(
                            (rust - ts).abs() < 1e-8,
                            "game {games}, event {index}: evaluation {rust} != {ts}"
                        );
                    }
                }
                checkpoints += 1;
            }
            assert!(
                state.apply_event(event, &mut history),
                "game {games}, event {index}"
            );
            events += 1;
        }
        assert!(expected.next().is_none());
        assert_eq!(state.reason(), replay.reason, "game {games}");
        assert_eq!(state.ranks(), replay.ranks, "game {games}");
        games += 1;
    }
    println!("{games} games, {events} events, {checkpoints} legal-action checkpoints");
    Ok(())
}
