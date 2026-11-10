//! 認証された局面から候補手だけを計算します。対局状態は保存しません。

pub mod local_analysis;
mod reversi;
mod shogi;

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State as AppState, rejection::JsonRejection},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tetraboard_ai_agents::profiles::{
    ProfileLimits, ServedProfile, builtin_profiles, configured, effective_limits,
};
use tetraboard_ai_agents::{
    AGENT_ID, SearchStats, build_agent,
    config::{AgentConfig, GREEDY_ID, MAXN_ID, SearchBudget},
    evaluation::EvaluationWeights,
};
use tetraboard_ai_engine::four_reversi::{
    ELIMINATION_RULESET_VERSION, ENGINE_VERSION, Position, PositionSetup, RULESET_VERSION, State,
    count_stones,
};
use tokio::sync::Semaphore;

pub const API_VERSION: u32 = 1;
pub const MAX_BODY_BYTES: usize = 16 * 1024;
pub const MAX_NODES: u64 = 4096;
pub const MAX_DEPTH: u8 = 4;

#[derive(Clone)]
struct ServiceState {
    token: Arc<String>,
    permits: Arc<Semaphore>,
    profiles: Arc<Vec<ServedProfile>>,
    shogi: Option<Arc<shogi::Engine>>,
    reversi: Option<Arc<reversi::Engine>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileMoveRequest {
    pub api_version: u32,
    pub game_id: String,
    pub ruleset_version: String,
    pub state_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub profile_id: String,
    pub seed: u64,
    pub limits: Option<ProfileLimits>,
    pub state: PositionSetup,
}

#[derive(Debug, Serialize)]
pub struct ProfileMoveResponse {
    pub api_version: u32,
    pub game_id: &'static str,
    pub ruleset_version: &'static str,
    pub state_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub profile_id: String,
    pub profile_hash: String,
    pub agent_id: &'static str,
    pub engine_version: &'static str,
    pub effective_limits: Option<ProfileLimits>,
    pub reproducible: bool,
    pub position: Position,
    pub diagnostics: SearchStats,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MoveRequest {
    pub api_version: u32,
    pub game_id: String,
    pub ruleset_version: String,
    pub state_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub agent_id: String,
    pub seed: u64,
    pub budget: Option<SearchBudget>,
    pub state: PositionSetup,
}

#[derive(Debug, Serialize)]
pub struct MoveResponse {
    pub api_version: u32,
    pub game_id: &'static str,
    pub ruleset_version: &'static str,
    pub state_version: u32,
    pub request_id: String,
    pub position_revision: String,
    pub agent_id: String,
    pub engine_version: &'static str,
    pub position: Position,
    pub diagnostics: SearchStats,
}

struct ApiError(StatusCode, &'static str);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"error":self.1})),
        )
            .into_response()
    }
}

pub fn router(token: String, concurrency: usize) -> Result<Router, &'static str> {
    router_with_engines(token, concurrency, None, None)
}

pub fn router_with_engines(
    token: String,
    concurrency: usize,
    shogi_path: Option<std::path::PathBuf>,
    reversi_path: Option<std::path::PathBuf>,
) -> Result<Router, &'static str> {
    if !(32..=256).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("AI_SERVICE_TOKENには32〜256文字のASCII秘密値が必要です");
    }
    if !(1..=16).contains(&concurrency) {
        return Err("AI_SERVICE_CONCURRENCYは1〜16にしてください");
    }
    Ok(app(ServiceState {
        token: Arc::new(token),
        permits: Arc::new(Semaphore::new(concurrency)),
        profiles: Arc::new(builtin_profiles().map_err(|_| "Service profile一覧が不正です")?),
        shogi: shogi_path.map(shogi::Engine::new).map(Arc::new),
        reversi: reversi_path.map(reversi::Engine::new).map(Arc::new),
    }))
}

fn app(state: ServiceState) -> Router {
    Router::new()
        .route("/v1/reversi/move",post(reversi::choose_move))
        .route("/v1/move",post(choose_move))
        .route("/v2/move",post(choose_profile_move))
        .route("/v1/shogi/move",post(shogi::choose_move))
        .route_layer(middleware::from_fn_with_state(state.clone(),authenticate))
        .route("/health", get(|| async { ([(header::CACHE_CONTROL,"no-store")],Json(serde_json::json!({"status":"ok","api_version":API_VERSION,"engine_version":ENGINE_VERSION}))) }))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

async fn choose_profile_move(
    AppState(service): AppState<ServiceState>,
    payload: Result<Json<ProfileMoveRequest>, JsonRejection>,
) -> Result<Json<ProfileMoveResponse>, ApiError> {
    let Json(request) = payload.map_err(|error| {
        ApiError(
            if [
                StatusCode::PAYLOAD_TOO_LARGE,
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ]
            .contains(&error.status())
            {
                error.status()
            } else {
                StatusCode::BAD_REQUEST
            },
            "invalid_request",
        )
    })?;
    let supported = (request.ruleset_version == RULESET_VERSION
        && request.state_version == 1
        && request.state.eliminated_colors.is_empty())
        || (request.ruleset_version == ELIMINATION_RULESET_VERSION && request.state_version == 2);
    if request.api_version != 2 || request.game_id != "four-reversi" || !supported {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unsupported_version"));
    }
    let ruleset_version = if request.state_version == 2 {
        ELIMINATION_RULESET_VERSION
    } else {
        RULESET_VERSION
    };
    if !valid_identity(&request.request_id, &request.position_revision) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let profile = service
        .profiles
        .iter()
        .find(|p| p.id == request.profile_id)
        .ok_or(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid_profile_or_limits",
        ))?;
    let config = configured(profile, request.seed, request.limits)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_profile_or_limits"))?;
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
    let permit = service
        .permits
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))?;
    let profile_hash = profile.profile_hash.clone();
    let agent_id = config.id();
    let limits = effective_limits(&config);
    let reproducible = limits.is_none_or(|l| l.max_time_ms.is_none());
    let decision = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        build_agent(&config, 0, 0)
            .expect("検証済みのprofileです")
            .decide(&state)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
    Ok(Json(ProfileMoveResponse {
        api_version: 2,
        game_id: "four-reversi",
        ruleset_version,
        state_version: request.state_version,
        request_id: request.request_id,
        position_revision: request.position_revision,
        profile_id: request.profile_id,
        profile_hash,
        agent_id,
        engine_version: ENGINE_VERSION,
        effective_limits: limits,
        reproducible,
        position: decision
            .position
            .ok_or(ApiError(StatusCode::BAD_REQUEST, "invalid_state"))?,
        diagnostics: decision.stats,
    }))
}

fn valid_identity(request_id: &str, revision: &str) -> bool {
    (16..=64).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && revision.len() == 64
        && revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

async fn authenticate(
    AppState(state): AppState<ServiceState>,
    request: Request,
    next: Next,
) -> Response {
    let valid = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(token.as_bytes().ct_eq(state.token.as_bytes())));
    if !valid {
        return ApiError(StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(request).await
}

async fn choose_move(
    AppState(service): AppState<ServiceState>,
    payload: Result<Json<MoveRequest>, JsonRejection>,
) -> Result<Json<MoveResponse>, ApiError> {
    let Json(request) = payload.map_err(|error| {
        ApiError(
            if [
                StatusCode::PAYLOAD_TOO_LARGE,
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ]
            .contains(&error.status())
            {
                error.status()
            } else {
                StatusCode::BAD_REQUEST
            },
            "invalid_request",
        )
    })?;
    if request.api_version != API_VERSION
        || request.state_version != 1
        || request.game_id != "four-reversi"
        || request.ruleset_version != RULESET_VERSION
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unsupported_version"));
    }
    if !(16..=64).contains(&request.request_id.len())
        || !request
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || request.position_revision.len() != 64
        || !request
            .position_revision
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
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
    if !request.state.eliminated_colors.is_empty() {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_state"));
    }
    let config = profile(&request)?;
    let state = State::from_setup(request.state)
        .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_state"))?;
    let permit = service
        .permits
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))?;
    // 切断後も計算の終了までpermitを保持し、CPU処理の同時実行数を守ります。
    let decision = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        build_agent(&config, 0, 0)
            .expect("検査済みのprofileです")
            .decide(&state)
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?;
    let position = decision
        .position
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "invalid_state"))?;
    Ok(Json(MoveResponse {
        api_version: API_VERSION,
        game_id: "four-reversi",
        ruleset_version: RULESET_VERSION,
        state_version: 1,
        request_id: request.request_id,
        position_revision: request.position_revision,
        agent_id: request.agent_id,
        engine_version: ENGINE_VERSION,
        position,
        diagnostics: decision.stats,
    }))
}

fn profile(request: &MoveRequest) -> Result<AgentConfig, ApiError> {
    let weights = EvaluationWeights::default();
    let invalid = || ApiError(StatusCode::BAD_REQUEST, "invalid_agent_or_budget");
    match request.agent_id.as_str() {
        AGENT_ID if request.budget.is_none() => Ok(AgentConfig::Random { seed: request.seed }),
        GREEDY_ID if request.budget.is_none() => Ok(AgentConfig::Greedy {
            seed: request.seed,
            weights,
        }),
        MAXN_ID => {
            let budget = request.budget.unwrap_or(SearchBudget {
                max_depth: 3,
                max_nodes: 1024,
            });
            if !(1..=MAX_DEPTH).contains(&budget.max_depth)
                || !(1..=MAX_NODES).contains(&budget.max_nodes)
            {
                return Err(invalid());
            }
            Ok(AgentConfig::MaxN {
                seed: request.seed,
                weights,
                budget,
            })
        }
        _ => Err(invalid()),
    }
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

    const TOKEN: &str = "test-ai-service-token-at-least-32-characters";

    fn request() -> Value {
        let mut state = serde_json::to_value(State::initial()).unwrap();
        state.as_object_mut().unwrap().remove("result");
        json!({"api_version":1,"game_id":"four-reversi","ruleset_version":RULESET_VERSION,"state_version":1,"request_id":"00000000-0000-4000-8000-000000000001","position_revision":"0".repeat(64),"agent_id":AGENT_ID,"seed":7,"state":state})
    }

    async fn send(app: Router, value: Value, token: Option<&str>) -> (StatusCode, Value) {
        let mut request = Request::post(if value.get("profile_id").is_some() {
            "/v2/move"
        } else {
            "/v1/move"
        })
        .header(header::CONTENT_TYPE, "application/json");
        if let Some(token) = token {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let response = app
            .oneshot(request.body(Body::from(value.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        (
            status,
            serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap(),
        )
    }

    #[tokio::test]
    async fn authentication_health_and_version_validation() {
        let app = router(TOKEN.into(), 2).unwrap();
        let health = app
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        assert_eq!(
            send(app.clone(), request(), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            send(app.clone(), request(), Some("wrong")).await.0,
            StatusCode::UNAUTHORIZED
        );
        let mut bad = request();
        bad["state_version"] = json!(2);
        assert_eq!(
            send(app.clone(), bad, Some(TOKEN)).await.0,
            StatusCode::BAD_REQUEST
        );
        let mut bad = request();
        bad["state"]["eliminatedColors"] = json!(["red"]);
        assert_eq!(send(app, bad, Some(TOKEN)).await.0, StatusCode::BAD_REQUEST);
        assert!(router("short".into(), 2).is_err());
    }

    #[tokio::test]
    async fn all_agents_return_legal_repeatable_moves_with_identity_and_limits() {
        for id in [AGENT_ID, GREEDY_ID, MAXN_ID] {
            let mut value = request();
            value["agent_id"] = json!(id);
            if id == MAXN_ID {
                value["budget"] = json!({"max_depth":3,"max_nodes":32});
            }
            let app = router(TOKEN.into(), 2).unwrap();
            let (status, first) = send(app.clone(), value.clone(), Some(TOKEN)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(first["request_id"], value["request_id"]);
            assert_eq!(first["position_revision"], value["position_revision"]);
            let position: Position = serde_json::from_value(first["position"].clone()).unwrap();
            assert!(State::initial().legal_moves().contains(&position));
            if id == MAXN_ID {
                assert!(first["diagnostics"]["nodes"].as_u64().unwrap() <= 32);
            }
            assert_eq!(first, send(app, value, Some(TOKEN)).await.1);
        }
    }

    #[tokio::test]
    async fn overload_and_unbounded_requests_are_rejected() {
        let state = ServiceState {
            token: Arc::new(TOKEN.into()),
            permits: Arc::new(Semaphore::new(1)),
            profiles: Arc::new(builtin_profiles().unwrap()),
            shogi: None,
            reversi: None,
        };
        let _permit = state.permits.clone().acquire_owned().await.unwrap();
        assert_eq!(
            send(app(state), request(), Some(TOKEN)).await.0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        let app = router(TOKEN.into(), 2).unwrap();
        let mut value = request();
        value["agent_id"] = json!(MAXN_ID);
        value["budget"] = json!({"max_depth":4,"max_nodes":MAX_NODES+1});
        assert_eq!(
            send(app.clone(), value, Some(TOKEN)).await.0,
            StatusCode::BAD_REQUEST
        );
        let mut value = request();
        value["extra"] = json!("x".repeat(MAX_BODY_BYTES));
        assert_eq!(
            send(app, value, Some(TOKEN)).await.0,
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }
    fn profile_request(id: &str) -> Value {
        let mut value = request();
        value.as_object_mut().unwrap().remove("agent_id");
        value["api_version"] = json!(2);
        value["profile_id"] = json!(id);
        if id == "lv4-v1" || id == "lv5-v1" {
            value["limits"] = json!({"max_iterations":4,"max_nodes":256});
        }
        value
    }

    #[tokio::test]
    async fn profile_api_calls_all_five_agents_and_preserves_fixed_budget_reproducibility() {
        let app = router(TOKEN.into(), 2).unwrap();
        for profile in builtin_profiles().unwrap() {
            let request = profile_request(&profile.id);
            let (status, body) = send(app.clone(), request.clone(), Some(TOKEN)).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["api_version"], 2);
            assert_eq!(body["profile_id"], profile.id);
            assert_eq!(body["profile_hash"], profile.profile_hash);
            assert_eq!(body["reproducible"], true);
            let position = serde_json::from_value(body["position"].clone()).unwrap();
            assert!(State::initial().legal_moves().contains(&position));
            assert_eq!(body, send(app.clone(), request, Some(TOKEN)).await.1);
        }
    }

    #[tokio::test]
    async fn profile_api_rejects_unknown_profiles_excessive_limits_and_bad_identity() {
        let app = router(TOKEN.into(), 2).unwrap();
        let request = profile_request("lv5-v1");
        assert_eq!(
            send(app.clone(), request.clone(), None).await.0,
            StatusCode::UNAUTHORIZED
        );
        for (key, value) in [
            ("profile_id", json!("unknown")),
            ("limits", json!({"max_nodes":65537})),
            ("limits", json!({"max_iterations":4097})),
            ("limits", json!({"max_time_ms":501})),
            ("limits", json!({"max_nodes":0})),
            ("position_revision", json!("bad")),
            ("api_version", json!(1)),
            ("limits", json!({"unknown":1})),
        ] {
            let mut invalid = request.clone();
            invalid[key] = value;
            assert_eq!(
                send(app.clone(), invalid, Some(TOKEN)).await.0,
                StatusCode::BAD_REQUEST
            );
        }
        let mut timed = request;
        timed["limits"] = json!({"max_time_ms":1});
        let (status, body) = send(app, timed, Some(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["reproducible"], false);
        assert_eq!(body["effective_limits"]["max_time_ms"], 1);
    }
    #[tokio::test]
    async fn version_two_state_supports_eliminated_players_without_changing_v1() {
        use tetraboard_ai_engine::four_reversi::Color;
        let app = router(TOKEN.into(), 2).unwrap();
        let state = State::initial()
            .eliminate(Color::White)
            .unwrap()
            .state
            .eliminate(Color::Red)
            .unwrap()
            .state;
        let mut request = profile_request("lv3-v1");
        request["state"] = serde_json::to_value(&state).unwrap();
        request["state"].as_object_mut().unwrap().remove("result");
        assert_eq!(
            send(app.clone(), request.clone(), Some(TOKEN)).await.0,
            StatusCode::BAD_REQUEST
        );
        request["state_version"] = json!(2);
        request["ruleset_version"] = json!(ELIMINATION_RULESET_VERSION);
        let (status, body) = send(app, request, Some(TOKEN)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["state_version"], 2);
        assert_eq!(body["ruleset_version"], ELIMINATION_RULESET_VERSION);
        assert!(
            state
                .legal_moves()
                .contains(&serde_json::from_value(body["position"].clone()).unwrap())
        );
    }
}
