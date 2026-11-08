use serde::{Deserialize, Serialize};
use tetraboard_ai_engine::four_reversi::{Board, COLORS, State, count_stones};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluationWeights {
    pub stones: i32,
    pub endgame_stones: i32,
    pub mobility: i32,
    pub corners: i32,
    pub position: i32,
}

impl Default for EvaluationWeights {
    fn default() -> Self {
        Self {
            stones: 1,
            endgame_stones: 6,
            mobility: 4,
            corners: 32,
            position: 2,
        }
    }
}

pub fn evaluate(state: &State, weights: &EvaluationWeights) -> [i32; 4] {
    if let Some(result) = state.result() {
        let mut values = [0; 4];
        for standing in &result.standings {
            values[standing.color.index()] = (5 - 2 * i32::from(standing.rank)) * 1_000_000
                + i32::from(standing.stone_count.unwrap_or(0));
        }
        return values;
    }
    let counts = count_stones(state.board());
    let occupied: i64 = counts.iter().map(|&n| i64::from(n)).sum();
    let stone_weight = (i64::from(weights.stones) * (64 - occupied)
        + i64::from(weights.endgame_stones) * occupied)
        / 64;
    let mobility = if weights.mobility == 0 {
        [0; 4]
    } else {
        state.legal_move_counts()
    };
    let mut raw = COLORS.map(|color| {
        i64::from(counts[color.index()]) * stone_weight
            + i64::from(mobility[color.index()]) * i64::from(weights.mobility)
    });
    for (y, row) in state.board().iter().enumerate() {
        for (x, &cell) in row.iter().enumerate() {
            if let Some(color) = cell {
                let corner = (x == 0 || x == 7) && (y == 0 || y == 7);
                raw[color.index()] += if corner {
                    i64::from(weights.corners)
                } else {
                    i64::from(position_value(state.board(), x, y)) * i64::from(weights.position)
                };
            }
        }
    }
    let active: Vec<_> = COLORS
        .into_iter()
        .filter(|c| !state.eliminated_colors().contains(c))
        .collect();
    let total: i64 = active.iter().map(|c| raw[c.index()]).sum();
    for color in COLORS {
        raw[color.index()] =
            if let Some(index) = state.eliminated_colors().iter().position(|c| *c == color) {
                i64::from(5 - 2 * (4 - index as i32)) * 1_000_000
            } else {
                (active.len() as i64 * raw[color.index()] - total).clamp(-100_000, 100_000)
            };
    }
    raw.map(|v| v as i32)
}

fn position_value(board: &Board, x: usize, y: usize) -> i32 {
    for (cx, cy) in [(0usize, 0usize), (7, 0), (0, 7), (7, 7)] {
        if x.abs_diff(cx) <= 1 && y.abs_diff(cy) <= 1 {
            return if board[cy][cx].is_some() {
                0
            } else if x != cx && y != cy {
                -4
            } else {
                -2
            };
        }
    }
    if x == 0 || x == 7 || y == 0 || y == 7 {
        2
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tetraboard_ai_engine::four_reversi::{Color, PositionSetup};

    fn position(board: Board) -> State {
        State::from_setup(PositionSetup {
            board,
            turn: Color::Black,
            move_number: 0,
            last_move: None,
            consecutive_passes: vec![],
            eliminated_colors: Vec::new(),
        })
        .unwrap()
    }

    #[test]
    fn mobility_uses_legal_counts_with_the_elimination_rule() {
        let mut board = *State::initial().board();
        board[4][2] = None;
        let state = position(board);
        let weights = EvaluationWeights {
            stones: 0,
            endgame_stones: 0,
            mobility: 1,
            corners: 0,
            position: 0,
        };
        assert_eq!(evaluate(&state, &weights), [-1, -1, 3, -1]);
    }

    #[test]
    fn stone_weight_increases_with_board_occupancy() {
        let mut board = *State::initial().board();
        board[0][0] = Some(Color::Black);
        let state = position(board);
        let weights = EvaluationWeights {
            stones: 0,
            endgame_stones: 64,
            mobility: 0,
            corners: 0,
            position: 0,
        };
        assert_eq!(evaluate(&state, &weights), [27, -9, -9, -9]);
    }

    #[test]
    fn empty_corner_neighbor_penalty_ends_when_the_corner_is_occupied() {
        let mut board = *State::initial().board();
        board[1][1] = Some(Color::White);
        let weights = EvaluationWeights {
            stones: 0,
            endgame_stones: 0,
            mobility: 0,
            corners: 0,
            position: 1,
        };
        assert_eq!(evaluate(&position(board), &weights), [4, -12, 4, 4]);
        board[0][0] = Some(Color::Black);
        assert_eq!(evaluate(&position(board), &weights), [0; 4]);
    }

    #[test]
    fn a_corner_improves_its_owner_relative_to_each_other_player() {
        let mut board = *State::initial().board();
        board[0][0] = Some(Color::Black);
        let state = State::from_setup(PositionSetup {
            board,
            turn: Color::Black,
            move_number: 0,
            last_move: None,
            consecutive_passes: vec![],
            eliminated_colors: Vec::new(),
        })
        .unwrap();
        let weights = EvaluationWeights {
            stones: 0,
            endgame_stones: 0,
            mobility: 0,
            corners: 7,
            position: 0,
        };
        assert_eq!(evaluate(&state, &weights), [21, -7, -7, -7]);
    }
}
