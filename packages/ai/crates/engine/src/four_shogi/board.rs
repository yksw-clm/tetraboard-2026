use super::{Kind, Side, Square};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Piece {
    pub side: Side,
    pub kind: Kind,
    pub promoted: bool,
}

#[derive(Clone, Debug)]
pub(super) struct Board {
    cells: [Option<Piece>; 81],
    sides: [u128; 4],
    occupied: u128,
    kings: [Square; 4],
}

const DIRECTIONS: [(i8, i8); 8] = [
    (0, -1),
    (-1, 0),
    (1, 0),
    (0, 1),
    (-1, -1),
    (1, -1),
    (-1, 1),
    (1, 1),
];

const fn neighborhoods() -> [u128; 81] {
    let mut result = [0; 81];
    let mut index = 0;
    while index < 81 {
        let mut direction = 0;
        while direction < 8 {
            let (dx, dy) = DIRECTIONS[direction];
            if let Some(to) = Square(index as u8).offset(dx, dy) {
                result[index] |= to.bit();
            }
            direction += 1;
        }
        index += 1;
    }
    result
}

pub(super) const NEIGHBORS: [u128; 81] = neighborhoods();

pub(super) fn squares(mut mask: u128) -> impl Iterator<Item = Square> {
    std::iter::from_fn(move || {
        if mask == 0 {
            return None;
        }
        let square = Square(mask.trailing_zeros() as u8);
        mask &= mask - 1;
        Some(square)
    })
}

impl Board {
    pub fn initial() -> Self {
        let mut board = Self {
            cells: [None; 81],
            sides: [0; 4],
            occupied: 0,
            kings: [Square(0); 4],
        };
        let south = [
            (Kind::King, 4, 8),
            (Kind::Rook, 4, 7),
            (Kind::Gold, 3, 8),
            (Kind::Gold, 5, 8),
            (Kind::Silver, 2, 8),
            (Kind::Silver, 6, 8),
            (Kind::Pawn, 3, 7),
            (Kind::Pawn, 5, 7),
            (Kind::Pawn, 4, 6),
        ];
        for side in Side::ALL {
            for (kind, x, y) in south {
                let (x, y) = match side {
                    Side::South => (x, y),
                    Side::West => (8 - y, x),
                    Side::North => (8 - x, 8 - y),
                    Side::East => (y, 8 - x),
                };
                board.put(
                    Square(y * 9 + x),
                    Some(Piece {
                        side,
                        kind,
                        promoted: false,
                    }),
                );
            }
        }
        board
    }

    pub fn at(&self, square: Square) -> Option<Piece> {
        self.cells[square.index()]
    }
    pub fn owned(&self, side: Side) -> u128 {
        self.sides[side.index()]
    }
    pub fn occupied(&self) -> u128 {
        self.occupied
    }
    pub fn king(&self, side: Side) -> Square {
        self.kings[side.index()]
    }

    pub fn put(&mut self, square: Square, piece: Option<Piece>) {
        if let Some(old) = self.at(square) {
            self.sides[old.side.index()] &= !square.bit();
        }
        self.cells[square.index()] = piece;
        if let Some(piece) = piece {
            self.occupied |= square.bit();
            self.sides[piece.side.index()] |= square.bit();
            if piece.kind == Kind::King {
                self.kings[piece.side.index()] = square;
            }
        } else {
            self.occupied &= !square.bit();
        }
    }

    pub fn key(&self) -> [u8; 81] {
        self.cells.map(|cell| {
            cell.map_or(0, |p| {
                1 + p.side as u8 * 10 + p.kind as u8 * 2 + u8::from(p.promoted)
            })
        })
    }

    pub fn attacks(&self, piece: Piece, from: Square) -> u128 {
        if piece.kind == Kind::King {
            return NEIGHBORS[from.index()];
        }
        let mut attacks = 0;
        if piece.kind == Kind::Rook {
            for (dx, dy) in DIRECTIONS.into_iter().take(4) {
                let mut square = from;
                while let Some(to) = square.offset(dx, dy) {
                    attacks |= to.bit();
                    if self.occupied & to.bit() != 0 {
                        break;
                    }
                    square = to;
                }
            }
            if piece.promoted {
                for (dx, dy) in DIRECTIONS.into_iter().skip(4) {
                    if let Some(to) = from.offset(dx, dy) {
                        attacks |= to.bit();
                    }
                }
            }
        } else {
            for (dx, dy) in DIRECTIONS {
                if step_allowed(piece, dx, dy)
                    && let Some(to) = from.offset(dx, dy)
                {
                    attacks |= to.bit();
                }
            }
        }
        attacks
    }

    pub fn checked(&self, side: Side, active: u8) -> bool {
        if active & side.bit() == 0 {
            return false;
        }
        let king = self.king(side);
        for (dx, dy) in DIRECTIONS {
            let mut square = king;
            let mut adjacent = true;
            while let Some(from) = square.offset(dx, dy) {
                if let Some(piece) = self.at(from) {
                    if piece.side != side && active & piece.side.bit() != 0 {
                        let attacks = if adjacent {
                            step_allowed(piece, -dx, -dy)
                        } else {
                            piece.kind == Kind::Rook && (dx == 0 || dy == 0)
                        };
                        if attacks {
                            return true;
                        }
                    }
                    break;
                }
                if dx != 0 && dy != 0 {
                    break;
                }
                adjacent = false;
                square = from;
            }
        }
        false
    }
}

fn step_allowed(piece: Piece, dx: i8, dy: i8) -> bool {
    if piece.kind == Kind::King {
        return true;
    }
    if piece.kind == Kind::Rook {
        return dx == 0 || dy == 0 || piece.promoted;
    }
    let (fx, fy) = piece.side.forward();
    let ahead = dx * fx + dy * fy;
    let across = -dx * fy + dy * fx;
    if piece.kind == Kind::Gold || piece.promoted {
        ahead == 1 || (ahead == 0 && across != 0) || (ahead == -1 && across == 0)
    } else if piece.kind == Kind::Silver {
        (ahead == 1 && across == 0) || (ahead != 0 && across != 0)
    } else {
        ahead == 1 && across == 0
    }
}
