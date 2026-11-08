//! 四人リバーシ・シングルスの着手と外部脱落を扱います。

use serde::{Deserialize, Serialize};
use std::fmt;

pub const RULESET_VERSION: &str = "four-reversi-singles-v1";
pub const ELIMINATION_RULESET_VERSION: &str = "four-reversi-singles-v2";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BOARD_SIZE: usize = 8;
pub const MAX_MOVES: u8 = 56;
pub type Board = [[Option<Color>; BOARD_SIZE]; BOARD_SIZE];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Black,
    White,
    Red,
    Blue,
}

pub const COLORS: [Color; 4] = [Color::Black, Color::White, Color::Red, Color::Blue];

impl Color {
    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: i16,
    pub y: i16,
}

impl Position {
    fn in_bounds(self) -> bool {
        (0..8).contains(&self.x) && (0..8).contains(&self.y)
    }
}

/// 検証済みのテスト局面を組み立てる入力です。サービスの通信契約ではありません。
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PositionSetup {
    pub board: Board,
    pub turn: Color,
    #[serde(default)]
    pub move_number: u8,
    #[serde(default)]
    pub last_move: Option<Position>,
    #[serde(default)]
    pub consecutive_passes: Vec<Color>,
    #[serde(default)]
    pub eliminated_colors: Vec<Color>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    BoardFull,
    AllPassed,
    LastPlayer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub color: Color,
    pub rank: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stone_count: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameResult {
    pub reason: EndReason,
    pub standings: [Standing; 4],
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    board: Board,
    turn: Option<Color>,
    move_number: u8,
    last_move: Option<Position>,
    consecutive_passes: Vec<Color>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    eliminated_colors: Vec<Color>,
    result: Option<GameResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub state: State,
    pub flipped: Vec<Position>,
    pub passed_colors: Vec<Color>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MoveError {
    GameFinished,
    OutOfBounds,
    Occupied,
    NoCapture,
    EliminatesPlayer,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EliminationError {
    GameFinished,
    AlreadyEliminated,
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for MoveError {}

impl State {
    pub fn initial() -> Self {
        let mut board = [[None; BOARD_SIZE]; BOARD_SIZE];
        for (color, positions) in [
            (Color::Black, [(3, 2), (4, 3)]),
            (Color::White, [(3, 4), (4, 5)]),
            (Color::Red, [(3, 3), (2, 4)]),
            (Color::Blue, [(5, 3), (4, 4)]),
        ] {
            for (x, y) in positions {
                board[y][x] = Some(color);
            }
        }
        Self {
            board,
            turn: Some(Color::Black),
            move_number: 0,
            last_move: None,
            consecutive_passes: Vec::new(),
            eliminated_colors: Vec::new(),
            result: None,
        }
    }

    /// 構造と継続条件を確認します。初期局面からの到達可能性は保証しません。
    pub fn from_setup(setup: PositionSetup) -> Result<Self, &'static str> {
        let active: Vec<_> = COLORS
            .into_iter()
            .filter(|c| !setup.eliminated_colors.contains(c))
            .collect();
        if active.len() < 2
            || active
                .iter()
                .any(|c| count_stones(&setup.board)[c.index()] == 0)
            || setup
                .eliminated_colors
                .iter()
                .enumerate()
                .any(|(i, c)| setup.eliminated_colors[..i].contains(c))
            || !active.contains(&setup.turn)
        {
            return Err("継続色・脱落順が不正です");
        }
        if setup.move_number > MAX_MOVES
            || setup.last_move.is_some_and(|p| !p.in_bounds())
            || setup.consecutive_passes.len() >= active.len()
            || setup.consecutive_passes.contains(&setup.turn)
            || setup.consecutive_passes.iter().any(|c| !active.contains(c))
            || setup
                .consecutive_passes
                .iter()
                .enumerate()
                .any(|(i, c)| setup.consecutive_passes[..i].contains(c))
        {
            return Err("局面の補助情報が不正です");
        }
        if legal_moves_for(&setup.board, setup.turn, &setup.eliminated_colors).is_empty() {
            return Err("手番には合法手のある色を指定してください");
        }
        Ok(Self {
            board: setup.board,
            turn: Some(setup.turn),
            move_number: setup.move_number,
            last_move: setup.last_move,
            consecutive_passes: setup.consecutive_passes,
            eliminated_colors: setup.eliminated_colors,
            result: None,
        })
    }

    pub fn board(&self) -> &Board {
        &self.board
    }

    pub fn turn(&self) -> Option<Color> {
        self.turn
    }

    pub fn move_number(&self) -> u8 {
        self.move_number
    }

    pub fn result(&self) -> Option<&GameResult> {
        self.result.as_ref()
    }

    pub fn consecutive_passes(&self) -> &[Color] {
        &self.consecutive_passes
    }

    pub fn legal_moves(&self) -> Vec<Position> {
        self.turn
            .map(|color| legal_moves_for(&self.board, color, &self.eliminated_colors))
            .unwrap_or_default()
    }

    pub fn legal_move_counts(&self) -> [u8; 4] {
        if self.turn.is_none() {
            return [0; 4];
        }
        let counts = count_stones(&self.board);
        COLORS.map(|color| {
            (0..8)
                .flat_map(|y| (0..8).map(move |x| Position { x, y }))
                .filter(|&p| {
                    !self.eliminated_colors.contains(&color)
                        && check_move_with_counts(
                            &self.board,
                            color,
                            p,
                            counts,
                            &self.eliminated_colors,
                        )
                        .is_ok()
                })
                .count() as u8
        })
    }

    pub fn apply_move(&self, position: Position) -> Result<Transition, MoveError> {
        let color = self.turn.ok_or(MoveError::GameFinished)?;
        let flipped = check_move_with_counts(
            &self.board,
            color,
            position,
            count_stones(&self.board),
            &self.eliminated_colors,
        )?;
        let mut next = self.clone();
        next.board[position.y as usize][position.x as usize] = Some(color);
        for p in &flipped {
            next.board[p.y as usize][p.x as usize] = Some(color);
        }
        next.move_number += 1;
        next.last_move = Some(position);
        next.consecutive_passes.clear();
        let mut passed_colors = Vec::new();
        if next.board.iter().flatten().all(Option::is_some) {
            next.finish(EndReason::BoardFull);
        } else {
            passed_colors = next.advance(color);
        }
        Ok(Transition {
            state: next,
            flipped,
            passed_colors,
        })
    }

    pub fn eliminated_colors(&self) -> &[Color] {
        &self.eliminated_colors
    }

    pub fn eliminate(&self, color: Color) -> Result<Transition, EliminationError> {
        let turn = self.turn.ok_or(EliminationError::GameFinished)?;
        if self.eliminated_colors.contains(&color) {
            return Err(EliminationError::AlreadyEliminated);
        }
        let mut next = self.clone();
        next.eliminated_colors.push(color);
        next.consecutive_passes.retain(|c| *c != color);
        let passed_colors = if next.eliminated_colors.len() == 3 {
            next.finish(EndReason::LastPlayer);
            Vec::new()
        } else if turn == color {
            next.advance(color)
        } else {
            Vec::new()
        };
        Ok(Transition {
            state: next,
            flipped: Vec::new(),
            passed_colors,
        })
    }

    fn advance(&mut self, after: Color) -> Vec<Color> {
        let active = 4 - self.eliminated_colors.len();
        let mut passed = Vec::new();
        for offset in 1.. {
            let color = COLORS[(after.index() + offset) % 4];
            if self.eliminated_colors.contains(&color) {
                continue;
            }
            if !legal_moves_for(&self.board, color, &self.eliminated_colors).is_empty() {
                self.turn = Some(color);
                break;
            }
            passed.push(color);
            self.consecutive_passes.push(color);
            if self.consecutive_passes.len() == active {
                self.finish(EndReason::AllPassed);
                break;
            }
        }
        passed
    }

    fn finish(&mut self, reason: EndReason) {
        let counts = count_stones(&self.board);
        let mut active: Vec<_> = COLORS
            .into_iter()
            .filter(|c| !self.eliminated_colors.contains(c))
            .collect();
        active.sort_by_key(|c| std::cmp::Reverse(counts[c.index()]));
        let mut standings: Vec<_> = active
            .iter()
            .map(|&color| Standing {
                color,
                rank: 1 + active
                    .iter()
                    .filter(|c| counts[c.index()] > counts[color.index()])
                    .count() as u8,
                stone_count: Some(counts[color.index()]),
            })
            .collect();
        for &color in self.eliminated_colors.iter().rev() {
            standings.push(Standing {
                color,
                rank: (standings.len() + 1) as u8,
                stone_count: None,
            });
        }
        self.turn = None;
        self.result = Some(GameResult {
            reason,
            standings: standings.try_into().expect("4色の順位を保持します"),
        });
    }
}

pub fn count_stones(board: &Board) -> [u8; 4] {
    let mut counts = [0; 4];
    for color in board.iter().flatten().flatten() {
        counts[color.index()] += 1;
    }
    counts
}

fn legal_moves_for(board: &Board, color: Color, eliminated: &[Color]) -> Vec<Position> {
    let counts = count_stones(board);
    (0..8)
        .flat_map(|y| (0..8).map(move |x| Position { x, y }))
        .filter(|&position| {
            check_move_with_counts(board, color, position, counts, eliminated).is_ok()
        })
        .collect()
}

fn check_move_with_counts(
    board: &Board,
    color: Color,
    position: Position,
    counts: [u8; 4],
    eliminated: &[Color],
) -> Result<Vec<Position>, MoveError> {
    if !position.in_bounds() {
        return Err(MoveError::OutOfBounds);
    }
    if board[position.y as usize][position.x as usize].is_some() {
        return Err(MoveError::Occupied);
    }
    let mut flipped = Vec::new();
    for dy in -1..=1 {
        for dx in -1..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let mut ray = Vec::new();
            let mut cursor = Position {
                x: position.x + dx,
                y: position.y + dy,
            };
            while cursor.in_bounds() {
                match board[cursor.y as usize][cursor.x as usize] {
                    Some(other) if other != color => ray.push(cursor),
                    Some(_) => {
                        flipped.extend(ray);
                        break;
                    }
                    None => break,
                }
                cursor.x += dx;
                cursor.y += dy;
            }
        }
    }
    if flipped.is_empty() {
        return Err(MoveError::NoCapture);
    }
    // 全方向を同時に返した結果で、各相手色の残数を確認します。
    let mut remaining = counts;
    for p in &flipped {
        if let Some(other) = board[p.y as usize][p.x as usize] {
            remaining[other.index()] -= 1;
        }
    }
    if COLORS.iter().any(|&other| {
        other != color && !eliminated.contains(&other) && remaining[other.index()] == 0
    }) {
        return Err(MoveError::EliminatesPlayer);
    }
    Ok(flipped)
}
