//! 既存TypeScript版のシングルス規則に合わせた探索用の局面です。

mod attacks;
mod board;
mod moves;

use board::{Board, Piece, squares};
use serde::{Deserialize, Serialize};
use std::{cell::Cell, collections::HashMap};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    South,
    West,
    North,
    East,
}
impl Side {
    pub const ALL: [Self; 4] = [Self::South, Self::West, Self::North, Self::East];
    pub const fn index(self) -> usize {
        self as usize
    }
    const fn bit(self) -> u8 {
        1 << self as u8
    }
    const fn forward(self) -> (i8, i8) {
        match self {
            Self::South => (0, -1),
            Self::West => (1, 0),
            Self::North => (0, 1),
            Self::East => (-1, 0),
        }
    }
    pub const fn advancement(self, square: Square) -> u8 {
        match self {
            Self::South => 8 - square.y(),
            Self::West => square.x(),
            Self::North => square.y(),
            Self::East => 8 - square.x(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Rook,
    Gold,
    Silver,
    Pawn,
    King,
}
impl Kind {
    const HAND: [Self; 4] = [Self::Rook, Self::Gold, Self::Silver, Self::Pawn];
    pub const fn value(self) -> i32 {
        match self {
            Self::Rook => 800,
            Self::Gold => 500,
            Self::Silver => 400,
            Self::Pawn => 100,
            Self::King => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Coordinate", into = "Coordinate")]
pub struct Square(u8);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Coordinate {
    x: u8,
    y: u8,
}
impl TryFrom<Coordinate> for Square {
    type Error = &'static str;
    fn try_from(c: Coordinate) -> Result<Self, Self::Error> {
        if c.x < 9 && c.y < 9 {
            Ok(Self(c.y * 9 + c.x))
        } else {
            Err("invalid square")
        }
    }
}
impl From<Square> for Coordinate {
    fn from(s: Square) -> Self {
        Self { x: s.x(), y: s.y() }
    }
}
impl Square {
    pub const fn index(self) -> usize {
        self.0 as usize
    }
    pub const fn x(self) -> u8 {
        self.0 % 9
    }
    pub const fn y(self) -> u8 {
        self.0 / 9
    }
    pub const fn bit(self) -> u128 {
        1 << self.0
    }
    const fn offset(self, dx: i8, dy: i8) -> Option<Self> {
        let x = self.x() as i8 + dx;
        let y = self.y() as i8 + dy;
        if x >= 0 && x < 9 && y >= 0 && y < 9 {
            Some(Self((y * 9 + x) as u8))
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    MovePiece {
        from: Square,
        to: Square,
        promote: bool,
    },
    DropPiece {
        piece_kind: Kind,
        to: Square,
    },
}
impl Action {
    const fn to(self) -> Square {
        match self {
            Self::MovePiece { to, .. } | Self::DropPiece { to, .. } => to,
        }
    }
    const fn from(self) -> Option<Square> {
        match self {
            Self::MovePiece { from, .. } => Some(from),
            Self::DropPiece { .. } => None,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Event {
    Action { side: Side, action: Action },
    Eliminate { side: Side, reason: ExternalReason },
    DrawProposal { side: Side, proposed: bool },
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalReason {
    Resigned,
    Left,
    Timeout,
    Disconnected,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
struct Relation {
    reasons: u8,
    pending: u8,
    targets: u128,
}

#[derive(Clone, Debug)]
pub struct State {
    board: Board,
    hands: [[u8; 4]; 4],
    active: u8,
    turn: Side,
    checked: u8,
    ranks: [u8; 4],
    restricted: bool,
    relations: [[Relation; 4]; 4],
    recaptures: [u128; 4],
    draw_proposals: u8,
    reason: Option<EndReason>,
    last_capture: bool,
    ply: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndReason {
    LastPlayer,
    NoSurvivors,
    Agreement,
    Repetition,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PositionKey {
    board: [u8; 81],
    hands: [[u8; 4]; 4],
    active: u8,
    turn: u8,
    attacks: Option<Box<AttackHistoryKey>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct AttackHistoryKey {
    relations: [[Relation; 4]; 4],
    recaptures: [u128; 4],
}

#[derive(Clone)]
pub struct LegalMove {
    pub action: Action,
    board: Board,
    captured: Option<Piece>,
    active: u8,
    checks: Cell<Option<u8>>,
    attacks: Option<[Relation; 4]>,
}
impl LegalMove {
    pub fn capture_value(&self) -> i32 {
        self.captured.map_or(0, |p| p.kind.value())
    }
    pub fn gives_check(&self, side: Side) -> bool {
        self.checks() & !side.bit() != 0
    }
    fn checks(&self) -> u8 {
        if let Some(checks) = self.checks.get() {
            return checks;
        }
        let checks = State::checks(&self.board, self.active);
        self.checks.set(Some(checks));
        checks
    }
}

#[derive(Default)]
pub struct History {
    played: HashMap<PositionKey, u8>,
    branch: Vec<PositionKey>,
}
impl History {
    fn occurrences(&self, key: &PositionKey) -> usize {
        usize::from(self.played.get(key).copied().unwrap_or(0))
            + self
                .branch
                .iter()
                .filter(|position| *position == key)
                .count()
    }
    pub fn push(&mut self, key: PositionKey) {
        self.branch.push(key);
    }
    pub fn pop(&mut self) {
        self.branch.pop();
    }
}

impl State {
    pub fn initial(restricted: bool) -> Self {
        Self {
            board: Board::initial(),
            hands: [[0; 4]; 4],
            active: 15,
            turn: Side::South,
            checked: 0,
            ranks: [0; 4],
            restricted,
            relations: Default::default(),
            recaptures: [0; 4],
            draw_proposals: 0,
            reason: None,
            last_capture: false,
            ply: 0,
        }
    }

    pub fn replay(restricted: bool, events: &[Event]) -> Result<(Self, History), usize> {
        let (mut state, mut history) = Self::start(restricted);
        for (index, &event) in events.iter().enumerate() {
            if !state.apply_event(event, &mut history) {
                return Err(index);
            }
        }
        Ok((state, history))
    }

    pub fn start(restricted: bool) -> (Self, History) {
        let state = Self::initial(restricted);
        let mut history = History::default();
        history.played.insert(state.key(), 1);
        (state, history)
    }

    pub fn apply_event(&mut self, event: Event, history: &mut History) -> bool {
        if self.reason.is_some() {
            return false;
        }
        let key = match event {
            Event::Action { side, action } if side == self.turn => {
                let Some(legal) = self.legal_action(action) else {
                    return false;
                };
                let (next, key) = self.advance(&legal, history);
                *self = next;
                key
            }
            Event::Eliminate { side, reason }
                if self.alive(side)
                    && (!matches!(reason, ExternalReason::Resigned) || side == self.turn) =>
            {
                self.eliminate(side.bit());
                self.settle(side, true, history)
            }
            Event::DrawProposal { side, proposed } if side == self.turn => {
                if proposed {
                    self.draw_proposals |= side.bit();
                } else {
                    self.draw_proposals &= !side.bit();
                }
                self.check_agreement();
                None
            }
            _ => return false,
        };
        if let Some(key) = key {
            *history.played.entry(key).or_default() += 1;
        }
        true
    }

    pub fn turn(&self) -> Option<Side> {
        self.reason.is_none().then_some(self.turn)
    }
    pub fn reason(&self) -> Option<EndReason> {
        self.reason
    }
    pub fn ranks(&self) -> [u8; 4] {
        self.ranks.map(|r| {
            if self.reason.is_some() && r == 0 {
                1
            } else {
                r
            }
        })
    }
    pub fn alive(&self, side: Side) -> bool {
        self.active & side.bit() != 0
    }
    pub fn active_count(&self) -> u32 {
        self.active.count_ones()
    }
    pub fn checked(&self, side: Side) -> bool {
        self.checked & side.bit() != 0
    }
    pub fn last_capture(&self) -> bool {
        self.last_capture
    }
    pub fn ply(&self) -> usize {
        self.ply
    }
    fn restriction_active(&self) -> bool {
        self.restricted && self.active == 15
    }
    fn key(&self) -> PositionKey {
        PositionKey {
            board: self.board.key(),
            hands: self.hands,
            active: self.active,
            turn: self.turn as u8,
            attacks: self.restriction_active().then(|| {
                Box::new(AttackHistoryKey {
                    relations: self.relations,
                    recaptures: self.recaptures,
                })
            }),
        }
    }
    fn checks(board: &Board, active: u8) -> u8 {
        Side::ALL
            .into_iter()
            .filter(|s| board.checked(*s, active))
            .fold(0, |bits, s| bits | s.bit())
    }
    fn check_agreement(&mut self) {
        if self.draw_proposals & self.active == self.active {
            self.reason = Some(EndReason::Agreement);
        }
    }
    fn eliminate(&mut self, removed: u8) {
        self.active &= !removed;
        let rank = self.active.count_ones() as u8 + 1;
        for side in Side::ALL.into_iter().filter(|s| removed & s.bit() != 0) {
            self.ranks[side.index()] = rank;
            self.hands[side.index()] = [0; 4];
        }
        self.draw_proposals &= self.active;
        self.relations = Default::default();
        self.recaptures = [0; 4];
        self.checked = Self::checks(&self.board, self.active);
        self.reason = match self.active_count() {
            0 => Some(EndReason::NoSurvivors),
            1 => Some(EndReason::LastPlayer),
            _ => None,
        };
    }
    fn next_side(&self, after: Side) -> Side {
        let candidates = if self.checked == 0 {
            self.active
        } else {
            self.checked
        };
        (1..=4)
            .map(|offset| Side::ALL[(after.index() + offset) % 4])
            .find(|side| candidates & side.bit() != 0)
            .expect("継続局には次の手番があります")
    }
    fn settle(&mut self, after: Side, preserve: bool, history: &History) -> Option<PositionKey> {
        if self.reason.is_some() {
            return None;
        }
        let mated = Side::ALL
            .into_iter()
            .filter(|s| self.checked(*s) && !self.has_ordinary(*s))
            .fold(0, |bits, s| bits | s.bit());
        if mated != 0 {
            self.eliminate(mated);
        }
        if self.reason.is_some() {
            return None;
        }
        let mut side = if preserve && self.alive(self.turn) {
            self.turn
        } else {
            self.next_side(after)
        };
        loop {
            self.turn = side;
            if self.has_legal(side) {
                break;
            }
            self.eliminate(side.bit());
            if self.reason.is_some() {
                return None;
            }
            side = self.next_side(side);
        }
        self.check_agreement();
        if self.reason.is_some() {
            return None;
        }
        let key = self.key();
        if history.occurrences(&key) >= 3 {
            self.reason = Some(EndReason::Repetition);
        }
        Some(key)
    }
    pub fn advance(&self, action: &LegalMove, history: &History) -> (Self, Option<PositionKey>) {
        let mut next = self.clone();
        next.board = action.board.clone();
        next.checked = action.checks();
        next.last_capture = action.captured.is_some();
        next.ply += 1;
        if let Some(piece) = action.captured {
            next.hands[self.turn.index()][piece.kind as usize] += 1;
        }
        if let Action::DropPiece { piece_kind, .. } = action.action {
            next.hands[self.turn.index()][piece_kind as usize] -= 1;
        }
        if self.restriction_active() {
            self.update_attacks(&mut next, action);
        }
        let key = next.settle(self.turn, false, history);
        (next, key)
    }

    pub fn piece_at(&self, square: Square) -> Option<(Side, Kind, bool)> {
        self.board.at(square).map(|p| (p.side, p.kind, p.promoted))
    }
    pub fn hand(&self, side: Side) -> [u8; 4] {
        self.hands[side.index()]
    }
    pub fn pieces(&self, side: Side) -> impl Iterator<Item = (Square, Kind, bool)> {
        squares(self.board.owned(side)).map(|sq| {
            let p = self.board.at(sq).expect("所属マスクと盤面が一致します");
            (sq, p.kind, p.promoted)
        })
    }
    pub fn attacks_from(&self, square: Square) -> impl Iterator<Item = Square> {
        squares(
            self.board
                .at(square)
                .map_or(0, |p| self.board.attacks(p, square)),
        )
    }
    pub fn king(&self, side: Side) -> Square {
        self.board.king(side)
    }
    pub fn neighbors(square: Square) -> impl Iterator<Item = Square> {
        squares(board::NEIGHBORS[square.index()])
    }
}
