use super::Candidate;
use serde::Deserialize;
use std::sync::OnceLock;
use tetraboard_ai_engine::four_shogi::{Action, Side};

pub(super) const FEATURE_COUNT: usize = 12;
const HIDDEN: usize = 12;

#[derive(Deserialize)]
struct Model {
    weights: [[f64; FEATURE_COUNT]; HIDDEN],
    bias: [f64; HIDDEN],
    output: [f64; HIDDEN],
}

pub(super) fn features(candidate: &Candidate, mover: Side) -> [f64; FEATURE_COUNT] {
    let (to, promote, drop) = match candidate.action {
        Action::MovePiece { to, promote, .. } => (to, promote, false),
        Action::DropPiece { to, .. } => (to, false, true),
    };
    let state = &candidate.state;
    let king_distance = Side::ALL
        .into_iter()
        .filter(|&side| side != mover && state.alive(side))
        .map(|side| {
            let king = state.king(side);
            to.x().abs_diff(king.x()) + to.y().abs_diff(king.y())
        })
        .min()
        .unwrap_or(0);
    let score = candidate
        .depth_two_score
        .expect("深さ2の読みが完了しています");
    [
        (candidate.initial / 400.0).clamp(-16.0, 16.0),
        (score / 400.0).clamp(-16.0, 16.0),
        ((score - candidate.initial) / 400.0).clamp(-12.0, 12.0),
        f64::from(state.last_capture()),
        f64::from(state.turn().is_some_and(|turn| state.checked(turn))),
        f64::from(promote),
        f64::from(drop),
        f64::from(state.piece_at(to).map_or(0, |(_, kind, _)| kind.value())) / 800.0,
        f64::from(mover.advancement(to)) / 8.0,
        f64::from(king_distance) / 16.0,
        f64::from(state.active_count()) / 4.0,
        f64::from(state.checked(mover)),
    ]
}

pub(super) fn score(candidate: &Candidate, mover: Side) -> f64 {
    static MODEL: OnceLock<Model> = OnceLock::new();
    let model = MODEL.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../configs/four-shogi-order-model-v1.json"
        ))
        .expect("四人将棋の着手順モデルを読み込みます")
    });
    let x = features(candidate, mover);
    let correction: f64 = model
        .weights
        .iter()
        .zip(model.bias)
        .zip(model.output)
        .map(|((weights, bias), output)| {
            let activation = bias + weights.iter().zip(x).map(|(w, f)| w * f).sum::<f64>();
            activation.max(0.0) * output
        })
        .sum();
    // 学習した補正を深さ2の素点に足して、深掘りする候補を並べます。
    candidate
        .depth_two_score
        .expect("深さ2の読みが完了しています")
        / 400.0
        + correction
}
