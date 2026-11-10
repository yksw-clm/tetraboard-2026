use tetraboard_ai_engine::four_shogi::{Kind, Side, State};

pub(super) type Values = [f64; 4];

pub(super) fn value(kind: Kind, promoted: bool) -> i32 {
    match (kind, promoted) {
        (Kind::Rook, true) => 1000,
        (Kind::Silver | Kind::Pawn, true) => 500,
        _ => kind.value(),
    }
}

pub(super) fn rank_score(rank: u8) -> f64 {
    if rank == 1 {
        1_000_000.0
    } else {
        -1_000_000.0 * f64::from(rank - 1)
    }
}

// Lv2と同じ特徴量と係数を使い、探索方式の比較から評価の変更を分離します。
pub fn evaluate(state: &State) -> Values {
    let ranks = state.ranks();
    if state.reason().is_some() {
        return ranks.map(rank_score);
    }
    let active: Vec<_> = Side::ALL.into_iter().filter(|s| state.alive(*s)).collect();
    let mut attacks = [[0u8; 81]; 4];
    let mut cheapest = [[i32::MAX; 81]; 4];
    let mut assets = [0.0; 4];
    for &side in &active {
        let i = side.index();
        for (from, kind, promoted) in state.pieces(side) {
            assets[i] += f64::from(value(kind, promoted));
            for to in state.attacks_from(from) {
                attacks[i][to.index()] += 1;
                let cost = if kind == Kind::King {
                    2000
                } else {
                    value(kind, promoted)
                };
                cheapest[i][to.index()] = cheapest[i][to.index()].min(cost);
                if kind != Kind::King
                    && state.piece_at(to).is_none_or(|(owner, _, _)| owner != side)
                {
                    assets[i] += 3.0;
                }
            }
            if kind == Kind::Pawn && !promoted {
                assets[i] += 6.0 * f64::from(side.advancement(from));
            }
        }
        for (kind, count) in [Kind::Rook, Kind::Gold, Kind::Silver, Kind::Pawn]
            .into_iter()
            .zip(state.hand(side))
        {
            assets[i] += f64::from(kind.value() * i32::from(count));
        }
    }
    let turn = state.turn().expect("評価する継続局には手番があります");
    for &side in &active {
        let i = side.index();
        let enemies = || active.iter().copied().filter(|s| *s != side);
        for (square, kind, promoted) in state.pieces(side) {
            if kind == Kind::King {
                if state.checked(side) {
                    assets[i] -= 300.0;
                }
                for to in State::neighbors(square) {
                    if enemies().any(|enemy| attacks[enemy.index()][to.index()] != 0) {
                        assets[i] -= 35.0;
                    } else if attacks[i][to.index()] > 1 {
                        assets[i] += 12.0;
                    }
                }
                continue;
            }
            let sq = square.index();
            let cost = enemies()
                .map(|enemy| cheapest[enemy.index()][sq])
                .min()
                .unwrap_or(i32::MAX);
            if cost == i32::MAX {
                continue;
            }
            let worth = value(kind, promoted);
            let risk = if attacks[i][sq] == 0 {
                f64::from(worth) * 0.7
            } else {
                f64::from((worth - cost).max(0)) * 0.45
            };
            let urgency = if turn == side {
                0.4
            } else if attacks[turn.index()][sq] != 0 {
                1.0
            } else {
                0.75
            };
            assets[i] -= risk * urgency;
        }
    }
    Side::ALL.map(|side| {
        let i = side.index();
        if !state.alive(side) {
            return rank_score(ranks[i]);
        }
        let opponents = active
            .iter()
            .copied()
            .filter(|s| *s != side)
            .map(|s| assets[s.index()]);
        let average = opponents.clone().sum::<f64>() / (active.len() - 1).max(1) as f64;
        let strongest = opponents.reduce(f64::max).unwrap_or(0.0);
        5000.0 * (4 - active.len()) as f64 + assets[i] - 0.6 * average - 0.4 * strongest
    })
}
