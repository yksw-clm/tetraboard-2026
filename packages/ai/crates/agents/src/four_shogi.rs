//! ローカルAI Serviceで四人将棋の探索予算を比較する試作です。

mod evaluation;
mod learned;
mod ordering;
pub use learned::{FEATURE_COUNT, Features, training_features};

use evaluation::Values;
pub use evaluation::evaluate as static_evaluation;
use evaluation::evaluate;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tetraboard_ai_engine::four_shogi::{
    Action, EndReason, History, Kind, LegalMove, PositionKey, Side, State,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Profile {
    Reference,
    FullWidth,
    #[serde(alias = "focused")]
    Lv3,
    RankTrial,
    ReplyRiskTrial,
    ReplyMixTrial,
    MoveOrderTrial,
}

#[derive(Debug, Default, Serialize)]
pub struct Diagnostics {
    pub nodes: u64,
    pub work: u64,
    pub root_moves: usize,
    pub completed_depth: u16,
    pub disproved_roots: usize,
    pub cutoff: bool,
    pub search_us: u64,
}

#[derive(Debug, Serialize)]
pub struct Decision {
    pub action: Action,
    pub diagnostics: Diagnostics,
}

#[derive(Serialize)]
pub struct RootTrace {
    pub action: Action,
    pub initial: f64,
    pub score: f64,
    pub depth: u16,
    pub kept_after_depth_two: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordering_features: Option<[f64; ordering::FEATURE_COUNT]>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnalysisCandidate {
    pub action: Action,
    pub score: f64,
}
#[derive(Clone, Debug, Default, Serialize)]
pub struct ContinuousSnapshot {
    pub candidates: Vec<AnalysisCandidate>,
    pub completed_depth: u16,
    pub nodes: u64,
    pub work: u64,
}
struct Continuous<'a> {
    cancelled: &'a mut dyn FnMut() -> bool,
    publish: &'a mut dyn FnMut(ContinuousSnapshot),
    snapshot: ContinuousSnapshot,
    updated: Instant,
}
struct Search<'a> {
    deadline: Option<Instant>,
    continuous: Option<Continuous<'a>>,
    max_work: u64,
    root: Side,
    two_players: bool,
    focus: bool,
    reply_risk: bool,
    reply_mix: bool,
    learned_order: bool,
    teacher: bool,
    evaluate: fn(&State) -> Values,
    stats: Diagnostics,
}

struct Candidate {
    action: Action,
    state: State,
    key: Option<PositionKey>,
    initial: f64,
    score: f64,
    depth_two_score: Option<f64>,
    ordering_score: f64,
    tactical: bool,
    refuted: bool,
    checked_replies: bool,
    depth: u16,
    kept_after_depth_two: bool,
    index: usize,
}

#[derive(Clone, Copy)]
struct Window {
    alpha: f64,
    beta: f64,
}
impl Window {
    const OPEN: Self = Self {
        alpha: f64::NEG_INFINITY,
        beta: f64::INFINITY,
    };
}

impl Search<'_> {
    fn spend(&mut self, work: u64) -> Option<()> {
        if let Some(continuous) = &mut self.continuous {
            if (continuous.cancelled)() {
                self.stats.cutoff = true;
                return None;
            }
            if continuous.updated.elapsed() >= Duration::from_secs(1) {
                continuous.snapshot.nodes = self.stats.nodes;
                continuous.snapshot.work = self.stats.work;
                (continuous.publish)(continuous.snapshot.clone());
                continuous.updated = Instant::now();
            }
        }
        if self.stats.work + work > self.max_work
            || self.deadline.is_some_and(|end| Instant::now() >= end)
        {
            self.stats.cutoff = true;
            return None;
        }
        self.stats.work += work;
        Some(())
    }

    fn advance(
        &mut self,
        state: &State,
        action: &LegalMove,
        history: &History,
    ) -> Option<(State, Option<PositionKey>)> {
        self.spend(1)?;
        self.stats.nodes += 1;
        Some(state.advance(action, history))
    }

    fn explore(
        &mut self,
        state: &State,
        history: &mut History,
        mut depth: u16,
        mut extension: u8,
        mut window: Window,
        mut immediate_loss: Option<&mut bool>,
    ) -> Option<Values> {
        self.spend(0)?;
        let Some(turn) = state.turn() else {
            return Some((self.evaluate)(state));
        };
        let checked = state.checked(turn);
        if depth == 0
            && extension > 0
            && (checked || state.last_capture() || (!self.focus && turn == self.root))
        {
            depth = 1;
            extension -= 1;
        }
        if depth == 0 {
            return Some((self.evaluate)(state));
        }

        self.spend(1)?;
        let moves = state.legal_moves();
        self.spend(moves.len().div_ceil(16) as u64)?;
        let mut ordered = Vec::with_capacity(moves.len());
        for action in moves {
            self.spend(0)?;
            let gives_check = action.gives_check(turn);
            let promote = match action.action {
                Action::MovePiece {
                    from,
                    promote: true,
                    ..
                } => {
                    if state
                        .piece_at(from)
                        .is_some_and(|(_, kind, _)| kind == Kind::Pawn)
                    {
                        400
                    } else {
                        200
                    }
                }
                _ => 0,
            };
            let priority =
                2 * action.capture_value() + promote + if gives_check { 10_000 } else { 0 };
            ordered.push((priority, gives_check, action));
        }
        ordered.sort_by_key(|(priority, _, _)| std::cmp::Reverse(*priority));
        let mut best: Option<Values> = None;
        let mut second: Option<Values> = None;
        let root_index = self.root.index();
        let mix_replies = self.reply_mix && state.active_count() > 2 && turn != self.root;
        for (i, (_, gives_check, action)) in ordered.iter().enumerate() {
            if immediate_loss.is_none()
                && i >= if self.teacher { 12 } else { 6 }
                && !checked
                && !gives_check
                && action.capture_value() == 0
            {
                continue;
            }
            let (next, key) = self.advance(state, action, history)?;
            if turn != self.root && !next.alive(self.root) {
                if let Some(refuted) = immediate_loss.as_deref_mut() {
                    *refuted = true;
                }
                return Some((self.evaluate)(&next));
            }
            let child = self.visit(
                (&next, key.as_ref()),
                history,
                depth - 1,
                extension,
                window,
                None,
            )?;
            let index = if self.two_players {
                root_index
            } else {
                turn.index()
            };
            let preference = |values: Values| {
                if self.reply_risk && !self.two_players && turn != self.root {
                    values[index] - 0.20 * values[root_index]
                } else {
                    values[index]
                }
            };
            let prefers = |previous: Values| {
                if self.two_players && turn != self.root {
                    child[index] < previous[index]
                } else {
                    preference(child) > preference(previous)
                        || (!self.two_players
                            && preference(child) == preference(previous)
                            && child[root_index] < previous[root_index])
                }
            };
            if best.is_none_or(prefers) {
                if mix_replies {
                    second = best;
                }
                best = Some(child);
            } else if mix_replies && second.is_none_or(prefers) {
                second = Some(child);
            }
            if self.two_players {
                let score = best.expect("候補を評価済みです")[root_index];
                if turn == self.root {
                    window.alpha = window.alpha.max(score);
                } else {
                    window.beta = window.beta.min(score);
                }
                if window.alpha >= window.beta {
                    break;
                }
            }
        }
        let best = best.unwrap_or_else(|| (self.evaluate)(state));
        Some(match second {
            Some(second) => mix_reply_values(best, second, turn.index()),
            None => best,
        })
    }

    fn visit(
        &mut self,
        (state, key): (&State, Option<&PositionKey>),
        history: &mut History,
        depth: u16,
        extension: u8,
        window: Window,
        immediate_loss: Option<&mut bool>,
    ) -> Option<Values> {
        if let Some(key) = key {
            history.push(key.clone());
        }
        let result = self.explore(state, history, depth, extension, window, immediate_loss);
        if key.is_some() {
            history.pop();
        }
        result
    }

    fn rank_roots(
        &mut self,
        state: &State,
        moves: &[LegalMove],
        history: &History,
    ) -> Vec<Candidate> {
        let mut roots = Vec::with_capacity(moves.len());
        for (index, action) in moves.iter().enumerate() {
            let Some((next, key)) = self.advance(state, action, history) else {
                break;
            };
            let initial = (self.evaluate)(&next)[self.root.index()];
            let tactical =
                next.last_capture() || next.turn().is_some_and(|turn| next.checked(turn));
            let won = next.alive(self.root)
                && matches!(
                    next.reason(),
                    Some(EndReason::LastPlayer | EndReason::Agreement | EndReason::Repetition)
                );
            let refuted = !next.alive(self.root);
            roots.push(Candidate {
                action: action.action,
                state: next,
                key,
                initial,
                score: initial,
                depth_two_score: None,
                ordering_score: 0.0,
                tactical,
                refuted,
                checked_replies: false,
                depth: 1,
                kept_after_depth_two: false,
                index,
            });
            if won && self.continuous.is_none() {
                break;
            }
        }
        roots.sort_by(|a, b| b.initial.total_cmp(&a.initial).then(a.index.cmp(&b.index)));
        roots
    }

    fn publish_roots(&mut self, roots: &[Candidate], depth: u16) {
        if let Some(continuous) = &mut self.continuous {
            let mut ranked: Vec<_> = roots
                .iter()
                .filter(|r| !r.refuted && r.depth == depth)
                .collect();
            ranked.sort_by(|a, b| {
                b.score
                    .total_cmp(&a.score)
                    .then(b.initial.total_cmp(&a.initial))
                    .then(a.index.cmp(&b.index))
            });
            if ranked.is_empty() {
                ranked = roots.iter().filter(|r| r.depth == depth).collect();
                ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.index.cmp(&b.index)));
            }
            continuous.snapshot = ContinuousSnapshot {
                candidates: ranked
                    .into_iter()
                    .take(3)
                    .map(|r| AnalysisCandidate {
                        action: r.action,
                        score: r.score,
                    })
                    .collect(),
                completed_depth: depth,
                nodes: self.stats.nodes,
                work: self.stats.work,
            };
            (continuous.publish)(continuous.snapshot.clone());
            continuous.updated = Instant::now();
        }
    }

    fn deeper(&mut self, roots: &mut [Candidate], history: &mut History) -> Action {
        let mut selected = roots[0].action;
        let mut active: Vec<_> = roots
            .iter()
            .enumerate()
            .filter(|(i, r)| self.focus || *i < 24 || r.tactical)
            .map(|(i, _)| i)
            .collect();
        for depth in 2..=if self.continuous.is_some() {
            u16::MAX
        } else if self.teacher {
            8
        } else {
            6
        } {
            let mut complete = true;
            let mut best = None;
            let extension = if self.focus && depth == 2 { 0 } else { 2 };
            for &i in &active {
                let root = &mut roots[i];
                if self.focus && root.refuted {
                    continue;
                }
                let values = self.visit(
                    (&root.state, root.key.as_ref()),
                    history,
                    depth - 1,
                    extension,
                    Window::OPEN,
                    if self.focus && depth == 2 {
                        Some(&mut root.refuted)
                    } else {
                        None
                    },
                );
                let Some(values) = values else {
                    complete = false;
                    break;
                };
                root.score = values[self.root.index()];
                root.depth = depth;
                if depth == 2 && self.focus {
                    root.checked_replies = true;
                    root.depth_two_score = Some(root.score);
                }
                if self.focus && root.refuted {
                    continue;
                }
                if best.is_none_or(|(score, initial, index)| {
                    root.score > score
                        || (root.score == score
                            && (root.initial > initial
                                || (root.initial == initial && root.index < index)))
                }) {
                    best = Some((root.score, root.initial, root.index));
                }
            }
            if !complete {
                // 読み切れなかった深さの評価値は比較せず、確定した脱落の反証だけ残します。
                if self.focus && roots.iter().any(|r| r.action == selected && r.refuted) {
                    let remaining = || active.iter().map(|i| &roots[*i]).filter(|r| !r.refuted);
                    if let Some(candidate) = remaining()
                        .find(|r| r.checked_replies)
                        .or_else(|| remaining().next())
                    {
                        selected = candidate.action;
                    }
                }
                break;
            }
            let Some((_, _, index)) = best else {
                break;
            };
            selected = roots
                .iter()
                .find(|r| r.index == index)
                .expect("評価済みの候補です")
                .action;
            self.stats.completed_depth = depth;
            self.publish_roots(roots, depth);
            if self.focus {
                active.retain(|i| !roots[*i].refuted);
                if depth == 2 && self.learned_order {
                    for &i in &active {
                        roots[i].ordering_score = ordering::score(&roots[i], self.root);
                    }
                }
                active.sort_by(|a, b| {
                    let (a, b) = (&roots[*a], &roots[*b]);
                    let policy = if depth == 2 && self.learned_order {
                        b.ordering_score.total_cmp(&a.ordering_score)
                    } else {
                        std::cmp::Ordering::Equal
                    };
                    policy
                        .then(b.score.total_cmp(&a.score))
                        .then(b.initial.total_cmp(&a.initial))
                        .then(a.index.cmp(&b.index))
                });
                if depth == 2 {
                    active.truncate(if self.teacher { 24 } else { 8 });
                    for &i in &active {
                        roots[i].kept_after_depth_two = true;
                    }
                }
            }
        }
        self.stats.disproved_roots = roots.iter().filter(|r| r.refuted).count();
        selected
    }
}

pub fn decide(
    state: &State,
    history: &mut History,
    profile: Profile,
    budget: Duration,
) -> Option<Decision> {
    decide_with_limits(
        state,
        history,
        profile,
        budget,
        if profile == Profile::Reference {
            2048
        } else {
            u64::MAX
        },
    )
}

pub fn decide_with_limits(
    state: &State,
    history: &mut History,
    profile: Profile,
    budget: Duration,
    max_work: u64,
) -> Option<Decision> {
    search(state, history, profile, budget, max_work, None, false)
}

fn mix_reply_values(best: Values, second: Values, mover: usize) -> Values {
    // 評価差が歩2枚相当になるまで、次点の応手の重みを線形に下げます。
    const REPLY_MARGIN: f64 = 200.0;
    let gap = best[mover] - second[mover];
    let second_weight = 0.5 * (1.0 - gap / REPLY_MARGIN).clamp(0.0, 1.0);
    std::array::from_fn(|i| best[i] + second_weight * (second[i] - best[i]))
}

pub fn trace_lv3(
    state: &State,
    history: &mut History,
    budget: Duration,
) -> Option<(Decision, Vec<RootTrace>)> {
    let mut trace = Vec::new();
    let decision = search(
        state,
        history,
        Profile::Lv3,
        budget,
        u64::MAX,
        Some(&mut trace),
        false,
    )?;
    Some((decision, trace))
}

pub fn trace_move_order(
    state: &State,
    history: &mut History,
    budget: Duration,
) -> Option<(Decision, Vec<RootTrace>)> {
    let mut trace = Vec::new();
    let decision = search(
        state,
        history,
        Profile::ReplyRiskTrial,
        budget,
        u64::MAX,
        Some(&mut trace),
        true,
    )?;
    Some((decision, trace))
}

fn search(
    state: &State,
    history: &mut History,
    profile: Profile,
    budget: Duration,
    max_work: u64,
    trace: Option<&mut Vec<RootTrace>>,
    teacher: bool,
) -> Option<Decision> {
    let start = Instant::now();
    let root = state.turn()?;
    let mut search = Search {
        deadline: Some(start + budget),
        continuous: None,
        max_work,
        root,
        two_players: state.active_count() == 2,
        focus: matches!(
            profile,
            Profile::Lv3
                | Profile::RankTrial
                | Profile::ReplyRiskTrial
                | Profile::ReplyMixTrial
                | Profile::MoveOrderTrial
        ),
        reply_risk: matches!(profile, Profile::ReplyRiskTrial | Profile::MoveOrderTrial),
        reply_mix: profile == Profile::ReplyMixTrial,
        learned_order: profile == Profile::MoveOrderTrial,
        teacher,
        evaluate: if profile == Profile::RankTrial {
            learned::evaluate
        } else {
            evaluate
        },
        stats: Diagnostics::default(),
    };
    let moves = state.legal_moves();
    let first = moves.first()?.action;
    search.stats.root_moves = moves.len();
    let mut ranked = search.rank_roots(state, &moves, history);
    let action = match ranked.first() {
        None => first,
        Some(candidate) if candidate.initial >= 1_000_000.0 => candidate.action,
        Some(candidate) if ranked.len() != moves.len() => candidate.action,
        Some(_) => {
            search.stats.completed_depth = 1;
            search.deeper(&mut ranked, history)
        }
    };
    search.stats.search_us = start.elapsed().as_micros() as u64;
    if let Some(trace) = trace {
        trace.extend(ranked.into_iter().map(|root| {
            RootTrace {
                action: root.action,
                initial: root.initial,
                score: root.score,
                depth: root.depth,
                kept_after_depth_two: root.kept_after_depth_two,
                ordering_features: (teacher && !root.refuted && root.depth_two_score.is_some())
                    .then(|| ordering::features(&root, search.root)),
            }
        }));
    }
    Some(Decision {
        action,
        diagnostics: search.stats,
    })
}

/// 公開Lv3と同じ評価で、完了した深さだけを公開しながら反復深化します。
pub fn analyze_continuously(
    state: &State,
    history: &mut History,
    cancelled: &mut dyn FnMut() -> bool,
    publish: &mut dyn FnMut(ContinuousSnapshot),
) {
    let Some(root) = state.turn() else {
        return;
    };
    let mut search = Search {
        deadline: None,
        continuous: Some(Continuous {
            cancelled,
            publish,
            snapshot: ContinuousSnapshot::default(),
            updated: Instant::now(),
        }),
        max_work: u64::MAX,
        root,
        two_players: state.active_count() == 2,
        focus: true,
        reply_risk: false,
        reply_mix: false,
        learned_order: false,
        teacher: false,
        evaluate,
        stats: Diagnostics::default(),
    };
    let moves = state.legal_moves();
    let mut roots = search.rank_roots(state, &moves, history);
    if roots.is_empty() || roots.len() != moves.len() {
        return;
    }
    search.stats.completed_depth = 1;
    search.publish_roots(&roots, 1);
    search.deeper(&mut roots, history);
}

#[cfg(test)]
mod tests {
    use super::mix_reply_values;
    #[test]
    fn continuous_shogi_publishes_common_completed_depths_and_cancels() {
        use super::*;
        for restricted in [true, false] {
            let (state, mut history) = State::start(restricted);
            let stop = std::cell::Cell::new(false);
            let mut reports = Vec::new();
            analyze_continuously(&state, &mut history, &mut || stop.get(), &mut |report| {
                stop.set(report.completed_depth >= 2);
                reports.push(report);
            });
            assert_eq!(reports.first().unwrap().completed_depth, 1);
            assert_eq!(reports.last().unwrap().completed_depth, 2);
            assert!(reports.last().unwrap().nodes > reports.first().unwrap().nodes);
            for report in reports {
                assert!(!report.candidates.is_empty());
                assert!(report.candidates.iter().all(|candidate| {
                    state
                        .legal_moves()
                        .iter()
                        .any(|legal| legal.action == candidate.action)
                }));
            }
            // 探索の枝が停止後に元の千日手履歴へ残らないことを確認します。
            let decision = decide_with_limits(
                &state,
                &mut history,
                Profile::Lv3,
                Duration::from_secs(1),
                1,
            )
            .unwrap();
            assert!(
                state
                    .legal_moves()
                    .iter()
                    .any(|m| m.action == decision.action)
            );
        }
    }

    #[test]
    fn reply_mix_uses_movers_gap_and_one_weight_for_all_sides() {
        let best = [500.0, 100.0, 50.0, 0.0];
        assert_eq!(
            mix_reply_values(best, [-300.0, 100.0, 90.0, 80.0], 1),
            [100.0, 100.0, 70.0, 40.0]
        );
        assert_eq!(
            mix_reply_values(best, [-300.0, 0.0, 90.0, 80.0], 1),
            [300.0, 75.0, 60.0, 20.0]
        );
        assert_eq!(
            mix_reply_values(best, [-300.0, -100.0, 90.0, 80.0], 1),
            best
        );
    }
}
