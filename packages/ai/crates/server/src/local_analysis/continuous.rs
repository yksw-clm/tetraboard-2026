//! 継続探索の実行枠・進捗・生存確認をローカル専用APIで管理します。
use super::*;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tetraboard_ai_agents::four_shogi;
use tetraboard_ai_engine::four_shogi::{Event, Kind, Side, State as ShogiState};

pub(super) struct Progress {
    polled: Mutex<Instant>,
    snapshot: Mutex<Value>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartRequest {
    api_version: u32,
    request_id: String,
    position_revision: String,
    profile_hash: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(tag = "game", deny_unknown_fields)]
enum Input {
    #[serde(rename = "four-reversi")]
    Reversi { state: PositionSetup },
    #[serde(rename = "four-shogi")]
    Shogi {
        three_player_attack_prohibited: bool,
        events: Vec<Event>,
        state: Box<ShogiPosition>,
    },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShogiPosition {
    board: [[Option<ObservedPiece>; 9]; 9],
    hands: [[u8; 4]; 4],
    turn: Side,
    move_number: usize,
    eliminated_sides: Vec<Side>,
}
#[derive(Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct ObservedPiece {
    side: Side,
    kind: Kind,
    promoted: bool,
}
impl Input {
    fn game(&self) -> &'static str {
        match self {
            Self::Reversi { .. } => "four-reversi",
            Self::Shogi { .. } => "four-shogi",
        }
    }
}
fn profile(game: &str) -> Value {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../../configs/continuous-analysis-profiles-v1.json"
    ))
    .expect("固定profile一覧です");
    registry["profiles"]
        .as_array()
        .expect("一覧です")
        .iter()
        .find(|p| p["game"] == game)
        .expect("対応ゲームです")
        .clone()
}
fn stopped(job: &Job) -> bool {
    if let Some(progress) = &job.continuous
        && progress
            .polled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .elapsed()
            >= Duration::from_secs(15)
    {
        job.cancelled.store(true, Ordering::Release);
    }
    job.cancelled.load(Ordering::Acquire)
}
fn publish(job: &Job, candidates: Value, diagnostics: Value) {
    let progress = job.continuous.as_ref().expect("継続探索です");
    let mut snapshot = progress.snapshot.lock().unwrap_or_else(|e| e.into_inner());
    let sequence = snapshot["sequence"].as_u64().unwrap_or(0) + 1;
    snapshot["sequence"] = json!(sequence);
    snapshot["candidates"] = candidates;
    snapshot["diagnostics"] = diagnostics;
}
fn fail(job: &Job, error: &str) {
    let mut snapshot = job
        .continuous
        .as_ref()
        .expect("継続探索です")
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    snapshot["status"] = json!("failed");
    snapshot["error"] = json!(error);
}
fn matches_position(state: &ShogiState, expected: &ShogiPosition) -> bool {
    if state.turn() != Some(expected.turn)
        || state.ply() != expected.move_number
        || expected.eliminated_sides.len() != 4 - state.active_count() as usize
        || Side::ALL.into_iter().any(|side| {
            state.alive(side) == expected.eliminated_sides.contains(&side)
                || state.hand(side) != expected.hands[side.index()]
        })
    {
        return false;
    }
    for y in 0..9 {
        for x in 0..9 {
            let square = serde_json::from_value(json!({"x":x,"y":y})).expect("盤内座標です");
            let actual = state
                .piece_at(square)
                .map(|(side, kind, promoted)| ObservedPiece {
                    side,
                    kind,
                    promoted,
                });
            if actual != expected.board[y][x] {
                return false;
            }
        }
    }
    true
}
pub(super) async fn start(
    AppState(service): AppState<LocalState>,
    payload: Result<Json<StartRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let Json(request) = payload.map_err(|e| ApiError(e.status(), "invalid_request"))?;
    let game = request.input.game();
    let profile = profile(game);
    if request.api_version != 2
        || !valid_id(&request.request_id)
        || !crate::valid_identity(&request.request_id, &request.position_revision)
        || request.profile_hash != profile["hash"].as_str().expect("設定hashです")
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unsupported_version_or_profile",
        ));
    }
    let initial = json!({
        "api_version":2,"game":game,"request_id":request.request_id,"position_revision":request.position_revision,
        "profile_id":profile["id"],"profile_hash":profile["hash"],"status":"running","sequence":0,
        "candidates":[],"diagnostics":{},"reproducible":false
    });
    let job = Arc::new(Job {
        id: request.request_id,
        cancelled: AtomicBool::new(false),
        done: AtomicBool::new(false),
        finished: Notify::new(),
        continuous: Some(Progress {
            polled: Mutex::new(Instant::now()),
            snapshot: Mutex::new(initial.clone()),
        }),
    });
    {
        let mut jobs = service
            .jobs
            .lock()
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
        if jobs.cancelled.contains(&job.id) {
            return Err(ApiError(StatusCode::CONFLICT, "cancelled"));
        }
        if jobs.active.is_some() {
            return Err(ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"));
        }
        jobs.active = Some(job.clone());
    }
    let running = Running {
        state: service.clone(),
        job: job.clone(),
    };
    let config = service
        .profiles
        .iter()
        .find(|p| p.id == "lv6-candidate-a-v1")
        .expect("Lv6設定です")
        .config
        .clone();
    tokio::task::spawn_blocking(move || {
        let _running = running;
        // 失敗時も実行枠と進捗を解放し、次の解析を妨げません。
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match request.input {
                Input::Reversi { state: setup } => {
                    if count_stones(&setup.board)
                        .iter()
                        .map(|&n| u16::from(n))
                        .sum::<u16>()
                        != 8 + u16::from(setup.move_number)
                    {
                        fail(&job, "invalid_state");
                        return;
                    }
                    let Ok(state) = State::from_setup(setup) else {
                        fail(&job, "invalid_state");
                        return;
                    };
                    MctsAgent::new(&config, 0, 0).analyze_continuously(&state, &mut || stopped(&job), &mut |report| {
                        publish(&job, json!(report.candidates), json!({"trials":report.trials,"nodes":report.nodes,"tree_nodes":report.tree_nodes}));
                    });
                }
                Input::Shogi {
                    three_player_attack_prohibited,
                    events,
                    state: expected,
                } => {
                    let (mut state, mut history) =
                        ShogiState::start(three_player_attack_prohibited);
                    for event in events {
                        if stopped(&job) {
                            return;
                        }
                        if !state.apply_event(event, &mut history) {
                            fail(&job, "invalid_replay");
                            return;
                        }
                    }
                    if !matches_position(&state, &expected) {
                        fail(&job, "position_mismatch");
                        return;
                    }
                    four_shogi::analyze_continuously(
                        &state,
                        &mut history,
                        &mut || stopped(&job),
                        &mut |report| {
                            publish(
                                &job,
                                json!(report.candidates),
                                json!({"completed_depth":report.completed_depth,"nodes":report.nodes,"work":report.work}),
                            );
                        },
                    );
                    // 全候補の反証などで深化が終わっても、最後の結果を着手まで保持します。
                    while !stopped(&job) {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        }));
        if outcome.is_err() {
            fail(&job, "computation_failed");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(initial)))
}
pub(super) async fn poll(
    AppState(service): AppState<LocalState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let job = {
        let jobs = service
            .jobs
            .lock()
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
        jobs.active
            .iter()
            .chain(jobs.previous.iter())
            .find(|job| job.id == id && job.continuous.is_some())
            .cloned()
    }
    .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let progress = job.continuous.as_ref().expect("継続探索です");
    // 期限切れの取得では探索を復活させません。
    let expired = stopped(&job);
    if !expired {
        *progress.polled.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }
    let mut result = progress
        .snapshot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if result["status"] != "failed" && (expired || job.done.load(Ordering::Acquire)) {
        result["status"] = json!("stopped");
    }
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;
    const TOKEN: &str = "continuous-test-token-at-least-32-characters";
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    async fn send(app: Router, method: &str, path: &str, payload: Value) -> (StatusCode, Value) {
        let response = app
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("Authorization", format!("Bearer {TOKEN}"))
                    .header("Content-Type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 100_000).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
    fn reversi() -> Value {
        let mut state = serde_json::to_value(State::initial()).unwrap();
        state.as_object_mut().unwrap().remove("result");
        json!({"api_version":2,"request_id":ID,"position_revision":"a".repeat(64),"profile_hash":profile("four-reversi")["hash"],"input":{"game":"four-reversi","state":state}})
    }
    fn shogi(restricted: bool) -> Value {
        let state = ShogiState::initial(restricted);
        let board: Vec<Vec<_>> = (0..9).map(|y| (0..9).map(|x| {
            let square = serde_json::from_value(json!({"x":x,"y":y})).unwrap();
            state.piece_at(square).map(|(side,kind,promoted)| json!({"side":side,"kind":kind,"promoted":promoted}))
        }).collect()).collect();
        json!({"api_version":2,"request_id":ID,"position_revision":"a".repeat(64),"profile_hash":profile("four-shogi")["hash"],"input":{"game":"four-shogi","three_player_attack_prohibited":restricted,"events":[],"state":{"board":board,"hands":([[0u8;4];4]),"turn":"south","moveNumber":0,"eliminatedSides":[]}}})
    }
    async fn wait_result(app: Router) -> Value {
        for _ in 0..200 {
            let (_, value) = send(
                app.clone(),
                "GET",
                &format!("/v2/analysis/{ID}"),
                Value::Null,
            )
            .await;
            if value["sequence"].as_u64().unwrap_or(0) > 0 || value["status"] == "failed" {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("初回の解析結果が公開されませんでした");
    }
    #[test]
    fn replay_positions_match_fixed_typescript_snapshots_after_special_events() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../fixtures/local-shogi-positions-v1.json"
        ))
        .unwrap();
        let replays: Vec<Value> = include_str!("../../../../fixtures/four-shogi-lv3-v1.jsonl")
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        for case in fixtures["cases"].as_array().unwrap() {
            let events: Vec<Event> = serde_json::from_value(
                replays[case["replay_index"].as_u64().unwrap() as usize]["events"].clone(),
            )
            .unwrap();
            let count = case["event_count"].as_u64().unwrap() as usize;
            let (state, _) = ShogiState::replay(true, &events[..count]).unwrap();
            let position: ShogiPosition = serde_json::from_value(case["state"].clone()).unwrap();
            assert!(matches_position(&state, &position), "{}", case["label"]);
        }
    }

    #[tokio::test]
    async fn v2_keeps_a_shared_slot_and_cancels_before_and_during_search() {
        let app = router(TOKEN.into()).unwrap();
        let path = format!("/v2/analysis/{ID}");
        assert_eq!(
            send(app.clone(), "POST", "/v2/analysis", reversi()).await.0,
            StatusCode::ACCEPTED
        );
        assert_eq!(
            send(app.clone(), "POST", "/v2/analysis", reversi()).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let progress = wait_result(app.clone()).await;
        assert_eq!(progress["status"], "running");
        assert!(progress["diagnostics"]["trials"].as_u64().unwrap() >= 1);
        for c in progress["candidates"].as_array().unwrap() {
            assert!(
                State::initial()
                    .legal_moves()
                    .contains(&serde_json::from_value(c["position"].clone()).unwrap())
            );
        }
        for _ in 0..2 {
            assert_eq!(
                send(app.clone(), "DELETE", &path, Value::Null).await.0,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            send(app.clone(), "GET", &path, Value::Null).await.1["status"],
            "stopped"
        );
        assert_eq!(
            send(app.clone(), "POST", "/v2/analysis", reversi()).await.0,
            StatusCode::CONFLICT
        );
        let mut next = reversi();
        next["request_id"] = json!("00000000-0000-4000-8000-000000000002");
        assert_eq!(
            send(app.clone(), "POST", "/v2/analysis", next).await.0,
            StatusCode::ACCEPTED
        );
        send(
            app,
            "DELETE",
            "/v2/analysis/00000000-0000-4000-8000-000000000002",
            Value::Null,
        )
        .await;
    }
    #[tokio::test]
    async fn shogi_replays_both_rule_settings_and_rejects_a_mismatching_board() {
        for restricted in [true, false] {
            let app = router(TOKEN.into()).unwrap();
            assert_eq!(
                send(app.clone(), "POST", "/v2/analysis", shogi(restricted))
                    .await
                    .0,
                StatusCode::ACCEPTED
            );
            let result = wait_result(app.clone()).await;
            assert_eq!(result["status"], "running");
            assert!(result["diagnostics"]["completed_depth"].as_u64().unwrap() >= 1);
            assert!(!result["candidates"].as_array().unwrap().is_empty());
            send(app, "DELETE", &format!("/v2/analysis/{ID}"), Value::Null).await;
        }
        let app = router(TOKEN.into()).unwrap();
        let mut input = shogi(true);
        input["input"]["state"]["board"][8][4] = Value::Null;
        send(app.clone(), "POST", "/v2/analysis", input).await;
        let result = wait_result(app).await;
        assert_eq!(result["status"], "failed");
        assert_eq!(result["error"], "position_mismatch");
    }
    #[tokio::test]
    async fn expired_running_job_releases_the_shared_slot() {
        let service = LocalState {
            token: Arc::new(TOKEN.into()),
            profiles: Arc::new(local_analysis_profiles().unwrap()),
            jobs: Arc::new(Mutex::new(Jobs::default())),
        };
        let _ = start(
            AppState(service.clone()),
            Ok(Json(serde_json::from_value(reversi()).unwrap())),
        )
        .await
        .unwrap_or_else(|_| panic!("継続探索を開始できませんでした"));
        let job = service.jobs.lock().unwrap().active.clone().unwrap();
        *job.continuous.as_ref().unwrap().polled.lock().unwrap() =
            Instant::now() - Duration::from_secs(16);
        let notified = job.finished.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !job.done.load(Ordering::Acquire) {
            tokio::time::timeout(Duration::from_secs(2), notified)
                .await
                .unwrap();
        }
        assert!(job.cancelled.load(Ordering::Acquire));
        assert!(service.jobs.lock().unwrap().active.is_none());
    }

    #[test]
    fn expired_progress_cannot_renew_itself() {
        let job = Job {
            id: ID.into(),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            finished: Notify::new(),
            continuous: Some(Progress {
                polled: Mutex::new(Instant::now() - Duration::from_secs(16)),
                snapshot: Mutex::new(Value::Null),
            }),
        };
        assert!(stopped(&job));
        *job.continuous.as_ref().unwrap().polled.lock().unwrap() = Instant::now();
        assert!(stopped(&job));
    }
    #[tokio::test]
    async fn v2_rejects_unknown_profiles_and_is_absent_from_the_public_router() {
        let app = router(TOKEN.into()).unwrap();
        let mut input = reversi();
        input["profile_hash"] = json!("b".repeat(64));
        assert_eq!(
            send(app.clone(), "POST", "/v2/analysis", input).await.0,
            StatusCode::BAD_REQUEST
        );
        let public = crate::router(TOKEN.into(), 1).unwrap();
        assert_eq!(
            send(public, "POST", "/v2/analysis", reversi()).await.0,
            StatusCode::NOT_FOUND
        );
        let path = format!("/v2/analysis/{ID}");
        send(app.clone(), "DELETE", &path, Value::Null).await;
        assert_eq!(
            send(app, "POST", "/v2/analysis", reversi()).await.0,
            StatusCode::CONFLICT
        );
    }
}
