use super::board::{Piece, squares};
use super::{Action, Kind, LegalMove, Side, Square, State};
use std::cell::Cell;

impl State {
    pub fn legal_moves(&self) -> Vec<LegalMove> {
        self.legal_for(self.turn)
    }

    pub fn legal_action(&self, action: Action) -> Option<LegalMove> {
        if self.reason.is_some() {
            return None;
        }
        if self.restricted_targets(self.turn) == 0 {
            return self.validate(self.turn, action, true);
        }
        self.legal_moves()
            .into_iter()
            .find(|candidate| candidate.action == action)
    }

    pub(super) fn has_legal(&self, side: Side) -> bool {
        if self.restricted_targets(side) == 0 {
            self.has_ordinary(side)
        } else {
            !self.legal_for(side).is_empty()
        }
    }

    pub(super) fn has_ordinary(&self, side: Side) -> bool {
        !self.ordinary(side, true).is_empty()
    }

    fn legal_for(&self, side: Side) -> Vec<LegalMove> {
        let restricted = self.restricted_targets(side);
        let mut moves = self.ordinary(side, false);
        if restricted == 0 {
            return moves;
        }
        let mut avoidable = 0;
        for candidate in &mut moves {
            let relations = self.classify(side, candidate);
            for target in Side::ALL {
                if relations[target.index()].reasons == 0 {
                    avoidable |= target.bit();
                }
            }
            candidate.attacks = Some(relations);
        }
        moves.retain(|candidate| {
            let relations = candidate
                .attacks
                .as_ref()
                .expect("候補の攻撃を分類済みです");
            Side::ALL.into_iter().all(|target| {
                restricted & avoidable & target.bit() == 0
                    || relations[target.index()].reasons == 0
                    || (candidate.checks() & target.bit() != 0
                        && !self.has_reply_to(candidate, side, target))
            })
        });
        moves
    }

    fn has_reply_to(&self, candidate: &LegalMove, mover: Side, target: Side) -> bool {
        let mut next = self.clone();
        next.board = candidate.board.clone();
        next.checked = candidate.checks();
        if let Some(piece) = candidate.captured {
            next.hands[mover.index()][piece.kind as usize] += 1;
        }
        if let Action::DropPiece { piece_kind, .. } = candidate.action {
            next.hands[mover.index()][piece_kind as usize] -= 1;
        }
        next.has_ordinary(target)
    }

    fn ordinary(&self, side: Side, first: bool) -> Vec<LegalMove> {
        let mut moves = Vec::new();
        if self.reason.is_some() || !self.alive(side) {
            return moves;
        }
        for from in squares(self.board.owned(side)) {
            let piece = self.board.at(from).expect("所属マスクと盤面が一致します");
            for to in squares(self.board.attacks(piece, from) & !self.board.owned(side)) {
                let can_promote = promotion_possible(piece, from, to);
                for promote in [false, true] {
                    if promote && !can_promote {
                        continue;
                    }
                    if let Some(m) =
                        self.validate(side, Action::MovePiece { from, to, promote }, true)
                    {
                        moves.push(m);
                        if first {
                            return moves;
                        }
                    }
                }
            }
        }
        for piece_kind in Kind::HAND {
            if self.hands[side.index()][piece_kind as usize] == 0 {
                continue;
            }
            for to in squares(((1u128 << 81) - 1) & !self.board.occupied()) {
                if let Some(m) = self.validate(side, Action::DropPiece { piece_kind, to }, true) {
                    moves.push(m);
                    if first {
                        return moves;
                    }
                }
            }
        }
        moves
    }

    fn validate(&self, side: Side, action: Action, pawn_mate: bool) -> Option<LegalMove> {
        let to = action.to();
        let captured = self.board.at(to);
        if captured.is_some_and(|p| p.side == side || p.kind == Kind::King) {
            return None;
        }
        let mut board = self.board.clone();
        let (fx, fy) = side.forward();
        let ahead = to.offset(fx, fy);
        let piece = match action {
            Action::MovePiece { from, promote, .. } => {
                let mut piece = board.at(from)?;
                if piece.side != side
                    || board.attacks(piece, from) & to.bit() == 0
                    || (promote && !promotion_possible(piece, from, to))
                    || (!promote
                        && !piece.promoted
                        && piece.kind == Kind::Pawn
                        && side.advancement(to) == 8)
                {
                    return None;
                }
                piece.promoted |= promote;
                board.put(from, None);
                piece
            }
            Action::DropPiece { piece_kind, .. } => {
                if captured.is_some()
                    || piece_kind == Kind::King
                    || self.hands[side.index()][piece_kind as usize] == 0
                {
                    return None;
                }
                if piece_kind == Kind::Pawn {
                    let same_file = |other: Square| {
                        if fx == 0 {
                            to.x() == other.x()
                        } else {
                            to.y() == other.y()
                        }
                    };
                    if side.advancement(to) == 8
                        || ahead
                            .and_then(|sq| board.at(sq))
                            .is_some_and(|p| p.kind == Kind::King && !self.alive(p.side))
                        || squares(board.owned(side))
                            .filter(|sq| same_file(*sq))
                            .any(|sq| {
                                board
                                    .at(sq)
                                    .is_some_and(|p| p.kind == Kind::Pawn && !p.promoted)
                            })
                    {
                        return None;
                    }
                }
                Piece {
                    side,
                    kind: piece_kind,
                    promoted: false,
                }
            }
        };
        board.put(to, Some(piece));
        if board.checked(side, self.active) {
            return None;
        }
        if pawn_mate
            && matches!(
                action,
                Action::DropPiece {
                    piece_kind: Kind::Pawn,
                    ..
                }
            )
            && let Some(king) = ahead.and_then(|sq| board.at(sq))
            && king.kind == Kind::King
            && self.alive(king.side)
            && king.side != side
        {
            let mut next = self.clone();
            next.board = board.clone();
            if !next.has_pawn_response(king.side, to) {
                return None;
            }
        }
        Some(LegalMove {
            action,
            board,
            captured,
            active: self.active,
            checks: Cell::new(None),
            attacks: None,
        })
    }

    fn has_pawn_response(&self, side: Side, pawn: Square) -> bool {
        for from in squares(self.board.owned(side)) {
            let piece = self.board.at(from).expect("所属マスクと盤面が一致します");
            if piece.kind == Kind::King {
                if squares(super::board::NEIGHBORS[from.index()]).any(|to| {
                    self.validate(
                        side,
                        Action::MovePiece {
                            from,
                            to,
                            promote: false,
                        },
                        false,
                    )
                    .is_some()
                }) {
                    return true;
                }
            } else {
                for promote in [false, true] {
                    if self
                        .validate(
                            side,
                            Action::MovePiece {
                                from,
                                to: pawn,
                                promote,
                            },
                            false,
                        )
                        .is_some()
                    {
                        return true;
                    }
                }
            }
        }
        false
    }
}

fn promotion_possible(piece: Piece, from: Square, to: Square) -> bool {
    !piece.promoted
        && matches!(piece.kind, Kind::Pawn | Kind::Silver | Kind::Rook)
        && (piece.side.advancement(from) >= 6 || piece.side.advancement(to) >= 6)
}
