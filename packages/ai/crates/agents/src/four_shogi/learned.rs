use super::evaluation::{self, Values, rank_score, value};
use serde::Deserialize;
use std::sync::OnceLock;
use tetraboard_ai_engine::four_shogi::{Kind, Side, State};

pub const FEATURE_COUNT: usize = 13;
pub type Features = [[f64; FEATURE_COUNT]; 4];

#[derive(Deserialize)]
struct Phase {
    weights: [f64; FEATURE_COUNT],
    tie_logit: f64,
}

#[derive(Deserialize)]
struct Model {
    phases: [Phase; 3],
    blend: [f64; 3],
    scale: f64,
}

fn model() -> &'static Model {
    static MODEL: OnceLock<Model> = OnceLock::new();
    MODEL.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../configs/four-shogi-rank-model-v1.json"
        ))
        .expect("四人将棋の学習係数を読み込みます")
    })
}

struct BoardFeatures {
    by_side: Features,
    assets: [f64; 4],
}

fn board_features(state: &State, turn: Side) -> BoardFeatures {
    let mut result = BoardFeatures {
        by_side: [[0.0; FEATURE_COUNT]; 4],
        assets: [0.0; 4],
    };
    let mut attacks = [[0u8; 81]; 4];
    let mut cheapest = [[i32::MAX; 81]; 4];
    for side in Side::ALL.into_iter().filter(|&s| state.alive(s)) {
        let i = side.index();
        let f = &mut result.by_side[i];
        f[0] = f64::from(side == turn);
        f[1] = f64::from(state.checked(side));
        for (from, kind, promoted) in state.pieces(side) {
            f[2] += f64::from(value(kind, promoted));
            for to in state.attacks_from(from) {
                let square = to.index();
                attacks[i][square] += 1;
                let cost = if kind == Kind::King {
                    2000
                } else {
                    value(kind, promoted)
                };
                cheapest[i][square] = cheapest[i][square].min(cost);
                if kind != Kind::King
                    && state.piece_at(to).is_none_or(|(owner, _, _)| owner != side)
                {
                    f[4] += 1.0;
                }
            }
            if kind == Kind::Pawn && !promoted {
                f[5] += f64::from(side.advancement(from));
            }
            if kind == Kind::Rook {
                f[12] += 1.0;
            }
        }
        for (kind, count) in [Kind::Rook, Kind::Gold, Kind::Silver, Kind::Pawn]
            .into_iter()
            .zip(state.hand(side))
        {
            f[3] += f64::from(kind.value() * i32::from(count));
            if kind == Kind::Rook {
                f[12] += f64::from(count);
            }
        }
    }

    for side in Side::ALL.into_iter().filter(|&s| state.alive(s)) {
        let i = side.index();
        let f = &mut result.by_side[i];
        let enemies = || {
            Side::ALL
                .into_iter()
                .filter(|&other| other != side && state.alive(other))
        };
        let mut weighted_risk = 0.0;
        for (from, kind, promoted) in state.pieces(side) {
            if kind == Kind::King {
                for to in State::neighbors(from) {
                    if enemies().any(|enemy| attacks[enemy.index()][to.index()] != 0) {
                        f[6] += 1.0;
                    } else {
                        if attacks[i][to.index()] > 1 {
                            f[7] += 1.0;
                        }
                        if state
                            .piece_at(to)
                            .is_none_or(|(owner, kind, _)| owner != side && kind != Kind::King)
                        {
                            f[8] += 1.0;
                        }
                    }
                }
                continue;
            }
            let sq = from.index();
            let cost = enemies()
                .map(|enemy| cheapest[enemy.index()][sq])
                .min()
                .unwrap_or(i32::MAX);
            if cost == i32::MAX {
                continue;
            }
            let worth = value(kind, promoted);
            let defended = attacks[i][sq] != 0;
            let risk = if defended {
                f64::from((worth - cost).max(0)) * 0.45
            } else {
                f64::from(worth) * 0.7
            };
            let immediate = side != turn && attacks[turn.index()][sq] != 0;
            weighted_risk += risk
                * if side == turn {
                    0.4
                } else if immediate {
                    1.0
                } else {
                    0.75
                };
            f[9] += risk;
            if immediate {
                let loss = if defended {
                    (worth - cheapest[turn.index()][sq]).max(0)
                } else {
                    worth
                };
                f[10] = f[10].max(f64::from(loss));
            }
        }
        let king = state.king(side).index();
        f[11] = enemies()
            .filter(|enemy| attacks[enemy.index()][king] != 0)
            .count() as f64;
        result.assets[i] = f[2] + f[3] + 3.0 * f[4] + 6.0 * f[5] - 300.0 * f[1] - 35.0 * f[6]
            + 12.0 * f[7]
            - weighted_risk;
        for (value, scale) in f.iter_mut().zip([
            1.0, 1.0, 1000.0, 1000.0, 32.0, 18.0, 8.0, 8.0, 8.0, 1000.0, 1000.0, 2.0, 3.0,
        ]) {
            *value /= scale;
        }
    }
    result
}

pub fn training_features(state: &State) -> Option<Features> {
    Some(board_features(state, state.turn()?).by_side)
}

pub(super) fn evaluate(state: &State) -> Values {
    let ranks = state.ranks();
    let Some(turn) = state.turn() else {
        return ranks.map(rank_score);
    };
    let n = state.active_count();
    let model = model();
    let index = (n - 2) as usize;
    let blend = model.blend[index];
    if blend == 0.0 {
        return evaluation::evaluate(state);
    }
    let phase = &model.phases[index];
    let features = board_features(state, turn);
    let mut strengths = [0.0; 4];
    for side in Side::ALL.into_iter().filter(|&s| state.alive(s)) {
        strengths[side.index()] = features.by_side[side.index()]
            .iter()
            .zip(phase.weights)
            .map(|(x, w)| x * w)
            .sum();
    }
    let tie = phase.tie_logit.exp();
    let mut head_to_head = [0.0; 4];
    for (i, side) in Side::ALL
        .into_iter()
        .enumerate()
        .filter(|(_, s)| state.alive(*s))
    {
        for (j, other) in Side::ALL
            .into_iter()
            .enumerate()
            .skip(i + 1)
            .filter(|(_, s)| state.alive(*s))
        {
            debug_assert_ne!(side, other);
            let lead = (strengths[i] - strengths[j]).clamp(-12.0, 12.0);
            let ahead = lead.exp();
            let behind = ahead.recip();
            let score = (ahead - behind) / (ahead + behind + tie);
            head_to_head[i] += score;
            head_to_head[j] -= score;
        }
    }
    Side::ALL.map(|side| {
        let i = side.index();
        if !state.alive(side) {
            return rank_score(ranks[i]);
        }
        let opponents = Side::ALL
            .into_iter()
            .filter(|&s| s != side && state.alive(s))
            .map(|s| features.assets[s.index()]);
        let material_prior = features.assets[i]
            - 0.6 * opponents.clone().sum::<f64>() / f64::from(n - 1)
            - 0.4 * opponents.reduce(f64::max).unwrap_or(0.0);
        let learned = model.scale * head_to_head[i] / f64::from(n - 1);
        5000.0 * f64::from(4 - n) + (1.0 - blend) * material_prior + blend * learned
    })
}
