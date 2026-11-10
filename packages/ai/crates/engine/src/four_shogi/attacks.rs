use super::board::{Board, NEIGHBORS, squares};
use super::{Kind, LegalMove, Relation, Side, Square, State};

const CHECK: u8 = 1;
const CAPTURE: u8 = 2;
const THREAT: u8 = 4;
const BLOCKADE: u8 = 8;

struct Influence([u128; 81]);
impl Influence {
    fn new(board: &Board) -> Self {
        let mut attacks = [0; 81];
        for from in squares(board.occupied()) {
            let piece = board.at(from).expect("占有マスクと盤面が一致します");
            attacks[from.index()] = board.attacks(piece, from);
        }
        Self(attacks)
    }
    fn at(&self, from: Square) -> u128 {
        self.0[from.index()]
    }
}

impl State {
    pub(super) fn restricted_targets(&self, side: Side) -> u8 {
        if !self.restriction_active() || self.checked(side) {
            return 0;
        }
        Side::ALL
            .into_iter()
            .filter(|target| {
                *target != side
                    && Side::ALL
                        .into_iter()
                        .filter(|attacker| {
                            *attacker != side
                                && self.relations[attacker.index()][target.index()].pending != 0
                        })
                        .count()
                        >= 2
            })
            .fold(0, |bits, target| bits | target.bit())
    }

    pub(super) fn classify(&self, side: Side, candidate: &LegalMove) -> [Relation; 4] {
        let mut relations = [Relation::default(); 4];
        let to = candidate.action.to();
        if !self.restriction_active()
            || self.checked(side)
            || (candidate.captured.is_some() && self.recaptures[side.index()] & to.bit() != 0)
        {
            return relations;
        }

        let board = &candidate.board;
        let before = Influence::new(&self.board);
        let after = Influence::new(board);
        let old_square = |square: Square| {
            if square == to {
                candidate.action.from()
            } else {
                Some(square)
            }
        };
        let piece = board.at(to).expect("着手先に駒があります");
        for target in Side::ALL.into_iter().filter(|s| *s != side) {
            let king = board.king(target);
            let defenders = board.owned(target);
            let mut reasons = 0;
            let mut targets = 0;
            if !self.checked(target) && candidate.checks() & target.bit() != 0 {
                reasons |= CHECK;
            }
            if piece.kind != Kind::King
                && candidate
                    .captured
                    .is_some_and(|p| p.side == target && p.kind != Kind::Pawn)
            {
                reasons |= CAPTURE;
            }
            let protected = Side::ALL.into_iter().fold(0, |bits, attacker| {
                let relation = self.relations[attacker.index()][target.index()];
                if relation.reasons & THREAT != 0 {
                    bits | relation.targets
                } else {
                    bits
                }
            });
            for square in squares(defenders & !king.bit() & !protected) {
                let victim = board.at(square).expect("標的マスに駒があります");
                let defended =
                    || squares(defenders & !square.bit()).any(|s| after.at(s) & square.bit() != 0);
                if squares(board.owned(side) & !board.king(side).bit()).any(|attacker| {
                    if after.at(attacker) & square.bit() == 0
                        || old_square(attacker)
                            .is_some_and(|from| before.at(from) & square.bit() != 0)
                    {
                        return false;
                    }
                    let attacker_kind = board.at(attacker).expect("攻撃マスに駒があります").kind;
                    match victim.kind {
                        Kind::Rook => true,
                        Kind::Pawn => {
                            king.x()
                                .abs_diff(square.x())
                                .max(king.y().abs_diff(square.y()))
                                <= 2
                                && (attacker_kind == Kind::Pawn || !defended())
                        }
                        _ => attacker_kind != Kind::Rook || !defended(),
                    }
                }) {
                    targets |= square.bit();
                }
            }
            if targets != 0 {
                reasons |= THREAT;
            }
            let after_ring = NEIGHBORS[king.index()] & !defenders;
            let before_ring = NEIGHBORS[king.index()] & !self.board.owned(target);
            let attackers = board.occupied() & !defenders;
            if squares(attackers).any(|attacker| {
                board.at(attacker).is_some_and(|p| p.kind != Kind::King)
                    && after.at(attacker) & after_ring != 0
                    && old_square(attacker).is_none_or(|from| before.at(from) & before_ring == 0)
            }) {
                reasons |= BLOCKADE;
            }
            if reasons != 0 {
                relations[target.index()] = Relation {
                    reasons,
                    pending: self.active & !side.bit(),
                    targets,
                };
            }
        }
        relations
    }

    pub(super) fn update_attacks(&self, next: &mut State, candidate: &LegalMove) {
        let side = self.turn;
        let new = candidate
            .attacks
            .unwrap_or_else(|| self.classify(side, candidate));
        let to = candidate.action.to();
        for attacker in Side::ALL {
            for target in Side::ALL {
                let relation = &mut next.relations[attacker.index()][target.index()];
                if attacker == side && new[target.index()].pending != 0 {
                    *relation = new[target.index()];
                    continue;
                }
                relation.pending &= !side.bit();
                if relation.pending == 0 {
                    *relation = Relation::default();
                    continue;
                }
                // 駒の識別子に追随する標的を、同値な盤上のマスで管理します。
                relation.targets &= !to.bit();
                if let Some(from) = candidate.action.from()
                    && relation.targets & from.bit() != 0
                {
                    relation.targets = (relation.targets & !from.bit()) | to.bit();
                }
            }
        }
        next.recaptures[side.index()] = 0;
        if let Some(p) = candidate.captured {
            next.recaptures[p.side.index()] |= to.bit();
        }
    }
}
