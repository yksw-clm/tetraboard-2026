//! loopback専用バイナリだけが公開する解析APIです。
use crate::{ApiError, MAX_BODY_BYTES};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State as AppState},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::Response,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use subtle::ConstantTimeEq;
use tetraboard_ai_agents::{
    SearchStats,
    config::AgentConfig,
    mcts::{MctsAgent, RootCandidate},
    profiles::{ProfileLimits, ServedProfile, builtin_profiles, effective_limits},
};
use tetraboard_ai_engine::four_reversi::{
    ELIMINATION_RULESET_VERSION, ENGINE_VERSION, PositionSetup, State, count_stones,
};
use tokio::sync::Notify;

#[derive(Clone)]
struct LocalState {
    token: Arc<String>,
    profile: Arc<ServedProfile>,
    jobs: Arc<Mutex<Jobs>>,
}
#[derive(Default)]
struct Jobs {
    active: Option<Arc<Job>>,
    cancelled: VecDeque<String>,
}
struct Job {
    id: String,
    cancelled: AtomicBool,
    done: AtomicBool,
    finished: Notify,
}
struct Running {
    state: LocalState,
    job: Arc<Job>,
}
impl Drop for Running {
    fn drop(&mut self) {
        let mut jobs = self
            .state
            .jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if jobs
            .active
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, &self.job))
        {
            jobs.active = None;
        }
        self.job.done.store(true, Ordering::Release);
        self.job.finished.notify_waiters();
    }
}
struct CancelOnDrop(Arc<Job>);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisRequest {
    pub api_version: u32,
    pub ruleset_version: String,
    pub state_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub profile_id: String,
    pub state: PositionSetup,
}
#[derive(Debug, Serialize)]
pub struct AnalysisResponse {
    pub api_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub profile_id: String,
    pub profile_hash: String,
    pub engine_version: &'static str,
    pub effective_limits: Option<ProfileLimits>,
    pub reproducible: bool,
    pub cancelled: bool,
    pub candidates: Vec<RootCandidate>,
    pub diagnostics: SearchStats,
}

pub fn router(token: String) -> Result<Router, &'static str> {
    if !(32..=256).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err("AI_LOCAL_TOKENには32〜256文字のASCII秘密値が必要です");
    }
    let profile = builtin_profiles()
        .map_err(|_| "profile一覧が不正です")?
        .into_iter()
        .find(|p| p.id == "lv5-v1")
        .ok_or("Lv5が見つかりません")?;
    let state = LocalState {
        token: Arc::new(token),
        profile: Arc::new(profile),
        jobs: Arc::new(Mutex::new(Jobs::default())),
    };
    Ok(Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({"status":"ok","service":"local-analysis","api_version":1,"engine_version":ENGINE_VERSION})) }))
        .route("/v1/analysis", post(analyze))
        .route("/v1/analysis/{request_id}", delete(cancel))
        .route_layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state))
}
async fn authenticate(
    AppState(state): AppState<LocalState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let valid = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .is_some_and(|value| bool::from(value.as_bytes().ct_eq(state.token.as_bytes())));
    if !valid {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "unauthorized"));
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
async fn analyze(
    AppState(service): AppState<LocalState>,
    payload: Result<Json<AnalysisRequest>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<AnalysisResponse>, ApiError> {
    let Json(request) = payload.map_err(|e| ApiError(e.status(), "invalid_request"))?;
    if request.api_version != 1
        || request.state_version != 2
        || request.ruleset_version != ELIMINATION_RULESET_VERSION
        || request.profile_id != "lv5-v1"
    {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "unsupported_version_or_profile",
        ));
    }
    if !valid_id(&request.request_id)
        || !super::valid_identity(&request.request_id, &request.position_revision)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    if count_stones(&request.state.board)
        .iter()
        .map(|&n| u16::from(n))
        .sum::<u16>()
        != 8 + u16::from(request.state.move_number)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_state"));
    }
    let state = State::from_setup(request.state)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_state"))?;
    let mut config = service.profile.config.clone();
    if let AgentConfig::Mcts { budget, .. } = &mut config {
        budget.max_time_ms = Some(2000);
    }
    let limits = effective_limits(&config);
    let job = Arc::new(Job {
        id: request.request_id.clone(),
        cancelled: AtomicBool::new(false),
        done: AtomicBool::new(false),
        finished: Notify::new(),
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
    // HTTPが中断されても、spawn_blocking内の探索へ停止要求を伝えます。
    let _cancel_on_drop = CancelOnDrop(job.clone());
    let running = Running {
        state: service.clone(),
        job: job.clone(),
    };
    let report = tokio::task::spawn_blocking(move || {
        let running = running;
        let report = MctsAgent::new(&config, 0, 0).analyze(&state, &mut || {
            running.job.cancelled.load(Ordering::Acquire)
        });
        drop(running);
        report
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
    Ok(Json(AnalysisResponse {
        api_version: 1,
        request_id: request.request_id,
        position_revision: request.position_revision,
        profile_id: service.profile.id.clone(),
        profile_hash: service.profile.profile_hash.clone(),
        engine_version: ENGINE_VERSION,
        effective_limits: limits,
        reproducible: false,
        cancelled: job.cancelled.load(Ordering::Acquire),
        candidates: report.candidates.into_iter().take(3).collect(),
        diagnostics: report.decision.stats,
    }))
}
async fn cancel(
    AppState(state): AppState<LocalState>,
    Path(request_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if !valid_id(&request_id) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let active = {
        let mut jobs = state
            .jobs
            .lock()
            .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
        // POSTより先にDELETEが届く場合も、取り消した要求を開始しません。
        if !jobs.cancelled.contains(&request_id) {
            jobs.cancelled.push_back(request_id.clone());
        }
        while jobs.cancelled.len() > 128 {
            jobs.cancelled.pop_front();
        }
        jobs.active
            .as_ref()
            .filter(|job| job.id == request_id)
            .cloned()
    };
    if let Some(job) = active {
        job.cancelled.store(true, Ordering::Release);
        loop {
            let notified = job.finished.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if job.done.load(Ordering::Acquire) {
                break;
            }
            notified.await;
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use serde_json::{Value, json};
    use tower::ServiceExt;
    const TOKEN: &str = "local-analysis-test-token-at-least-32-characters";
    const ID: &str = "00000000-0000-4000-8000-000000000001";
    fn payload() -> Value {
        let mut state = serde_json::to_value(State::initial()).unwrap();
        state.as_object_mut().unwrap().remove("result");
        json!({"api_version":1,"ruleset_version":ELIMINATION_RULESET_VERSION,"state_version":2,"request_id":ID,"position_revision":"a".repeat(64),"profile_id":"lv5-v1","state":state})
    }
    async fn send(
        app: Router,
        method: &str,
        path: &str,
        payload: Value,
        authorized: bool,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header("Content-Type", "application/json");
        if authorized {
            builder = builder.header("Authorization", format!("Bearer {TOKEN}"));
        }
        let response = app
            .oneshot(builder.body(Body::from(payload.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 32768).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
    }
    #[tokio::test]
    async fn auth_versions_input_and_local_only_routes() {
        let app = router(TOKEN.into()).unwrap();
        assert_eq!(
            send(app.clone(), "GET", "/health", Value::Null, false)
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(app.clone(), "GET", "/health", Value::Null, true)
                .await
                .0,
            StatusCode::OK
        );
        for key in ["api_version", "state_version"] {
            let mut p = payload();
            p[key] = json!(99);
            assert_eq!(
                send(app.clone(), "POST", "/v1/analysis", p, true).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let mut p = payload();
        p["profile_id"] = json!("lv6-v1");
        assert_eq!(
            send(app.clone(), "POST", "/v1/analysis", p, true).await.0,
            StatusCode::BAD_REQUEST
        );
        let mut p = payload();
        p["state"]["moveNumber"] = json!(20);
        assert_eq!(
            send(app.clone(), "POST", "/v1/analysis", p, true).await.0,
            StatusCode::BAD_REQUEST
        );
        let mut p = payload();
        p["limits"] = json!({"max_nodes":999999});
        assert_eq!(
            send(app.clone(), "POST", "/v1/analysis", p, true).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let public = crate::router(TOKEN.into(), 1).unwrap();
        assert_eq!(
            send(public, "POST", "/v1/analysis", payload(), true)
                .await
                .0,
            StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn returns_legal_candidates_and_effective_local_budget() {
        let app = router(TOKEN.into()).unwrap();
        let (status, body) = send(app.clone(), "POST", "/v1/analysis", payload(), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["effective_limits"]["max_time_ms"], 2000);
        assert_eq!(body["reproducible"], false);
        let legal = State::initial().legal_moves();
        let candidates = body["candidates"].as_array().unwrap();
        assert!(!candidates.is_empty());
        assert!(candidates.len() <= 3);
        for c in candidates {
            let position = serde_json::from_value(c["position"].clone()).unwrap();
            assert!(legal.contains(&position));
            assert!(
                c["solo_wins"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .sum::<u64>()
                    <= c["visits"].as_u64().unwrap()
            );
        }
        let mut p = payload();
        let mut state = serde_json::to_value(
            State::initial()
                .eliminate(tetraboard_ai_engine::four_reversi::Color::Blue)
                .unwrap()
                .state,
        )
        .unwrap();
        state.as_object_mut().unwrap().remove("result");
        p["state"] = state;
        assert_eq!(
            send(app, "POST", "/v1/analysis", p, true).await.0,
            StatusCode::OK
        );
    }
    #[tokio::test]
    async fn cancellation_before_post_is_idempotent_and_does_not_block_new_request() {
        let app = router(TOKEN.into()).unwrap();
        let path = format!("/v1/analysis/{ID}");
        for _ in 0..2 {
            assert_eq!(
                send(app.clone(), "DELETE", &path, Value::Null, true)
                    .await
                    .0,
                StatusCode::NO_CONTENT
            );
        }
        assert_eq!(
            send(app.clone(), "POST", "/v1/analysis", payload(), true)
                .await
                .0,
            StatusCode::CONFLICT
        );
        let mut next = payload();
        next["request_id"] = json!("00000000-0000-4000-8000-000000000002");
        assert_eq!(
            send(app, "POST", "/v1/analysis", next, true).await.0,
            StatusCode::OK
        );
    }
    #[tokio::test]
    async fn active_job_cancels_cooperatively_and_releases_slot() {
        let job = Arc::new(Job {
            id: ID.into(),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            finished: Notify::new(),
        });
        let state = LocalState {
            token: Arc::new(TOKEN.into()),
            profile: Arc::new(builtin_profiles().unwrap().remove(4)),
            jobs: Arc::new(Mutex::new(Jobs {
                active: Some(job.clone()),
                cancelled: VecDeque::new(),
            })),
        };
        let running = Running {
            state: state.clone(),
            job: job.clone(),
        };
        let observer = job.clone();
        let handle = tokio::task::spawn_blocking(move || {
            while !observer.cancelled.load(Ordering::Acquire) {
                std::thread::yield_now();
            }
            drop(running);
        });
        assert!(
            cancel(AppState(state.clone()), Path(ID.into()))
                .await
                .is_ok()
        );
        handle.await.unwrap();
        assert!(job.done.load(Ordering::Acquire));
        assert!(state.jobs.lock().unwrap().active.is_none());
    }
}
