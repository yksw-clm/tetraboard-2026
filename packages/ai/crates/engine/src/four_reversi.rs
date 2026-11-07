//! 脱落のない四人リバーシ・シングルスを扱います。

use serde::{Deserialize, Serialize};
use std::fmt;

pub const RULESET_VERSION: &str = "four-reversi-singles-v1";
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    BoardFull,
    AllPassed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Standing {
    pub color: Color,
    pub rank: u8,
    pub stone_count: u8,
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
            result: None,
        }
    }

    /// 構造と継続条件を確認します。初期局面からの到達可能性は保証しません。
    pub fn from_setup(setup: PositionSetup) -> Result<Self, &'static str> {
        if count_stones(&setup.board).contains(&0) {
            return Err("脱落なしの局面には全4色の石が必要です");
        }
        if setup.move_number > MAX_MOVES
            || setup.last_move.is_some_and(|p| !p.in_bounds())
            || setup.consecutive_passes.len() >= COLORS.len()
            || setup.consecutive_passes.contains(&setup.turn)
            || setup
                .consecutive_passes
                .iter()
                .enumerate()
                .any(|(i, color)| setup.consecutive_passes[..i].contains(color))
        {
            return Err("局面の補助情報が不正です");
        }
        if legal_moves_for(&setup.board, setup.turn).is_empty() {
            return Err("手番には合法手のある色を指定してください");
        }
        Ok(Self {
            board: setup.board,
            turn: Some(setup.turn),
            move_number: setup.move_number,
            last_move: setup.last_move,
            consecutive_passes: setup.consecutive_passes,
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
            .map(|color| legal_moves_for(&self.board, color))
            .unwrap_or_default()
    }

    pub fn apply_move(&self, position: Position) -> Result<Transition, MoveError> {
        let color = self.turn.ok_or(MoveError::GameFinished)?;
        let flipped = check_move(&self.board, color, position)?;
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
            // 着手後の盤面から次の手番を探し、本人の連続手番も許可します。
            for offset in 1..=COLORS.len() {
                let candidate = COLORS[(color.index() + offset) % COLORS.len()];
                if !legal_moves_for(&next.board, candidate).is_empty() {
                    next.turn = Some(candidate);
                    break;
                }
                passed_colors.push(candidate);
            }
            next.consecutive_passes.clone_from(&passed_colors);
            if passed_colors.len() == COLORS.len() {
                next.finish(EndReason::AllPassed);
            }
        }
        Ok(Transition {
            state: next,
            flipped,
            passed_colors,
        })
    }

    fn finish(&mut self, reason: EndReason) {
        let counts = count_stones(&self.board);
        let mut ordered = COLORS;
        ordered.sort_by_key(|color| std::cmp::Reverse(counts[color.index()]));
        let standings = ordered.map(|color| Standing {
            color,
            rank: 1 + counts
                .iter()
                .filter(|&&count| count > counts[color.index()])
                .count() as u8,
            stone_count: counts[color.index()],
        });
        self.turn = None;
        self.result = Some(GameResult { reason, standings });
    }
}

pub fn count_stones(board: &Board) -> [u8; 4] {
    let mut counts = [0; 4];
    for color in board.iter().flatten().flatten() {
        counts[color.index()] += 1;
    }
    counts
}

fn legal_moves_for(board: &Board, color: Color) -> Vec<Position> {
    (0..8)
        .flat_map(|y| (0..8).map(move |x| Position { x, y }))
        .filter(|&position| check_move(board, color, position).is_ok())
        .collect()
}

fn check_move(board: &Board, color: Color, position: Position) -> Result<Vec<Position>, MoveError> {
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
    let mut remaining = count_stones(board);
    for p in &flipped {
        if let Some(other) = board[p.y as usize][p.x as usize] {
            remaining[other.index()] -= 1;
        }
    }
    if COLORS
        .iter()
        .any(|&other| other != color && remaining[other.index()] == 0)
    {
        return Err(MoveError::EliminatesPlayer);
    }
    Ok(flipped)
}
