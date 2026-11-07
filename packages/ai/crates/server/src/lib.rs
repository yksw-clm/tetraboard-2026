//! 認証された局面から候補手だけを計算します。対局状態は保存しません。

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
use tetraboard_ai_agents::{
    AGENT_ID, SearchStats, build_agent,
    config::{AgentConfig, GREEDY_ID, MAXN_ID, SearchBudget},
    evaluation::EvaluationWeights,
};
use tetraboard_ai_engine::four_reversi::{
    ENGINE_VERSION, Position, PositionSetup, RULESET_VERSION, State, count_stones,
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
    if !(32..=256).contains(&token.len()) || !token.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("AI_SERVICE_TOKENには32〜256文字のASCII秘密値が必要です");
    }
    if !(1..=16).contains(&concurrency) {
        return Err("AI_SERVICE_CONCURRENCYは1〜16にしてください");
    }
    Ok(app(ServiceState {
        token: Arc::new(token),
        permits: Arc::new(Semaphore::new(concurrency)),
    }))
}

fn app(state: ServiceState) -> Router {
    Router::new()
        .route("/v1/move",post(choose_move))
        .route_layer(middleware::from_fn_with_state(state.clone(),authenticate))
        .route("/health", get(|| async { ([(header::CACHE_CONTROL,"no-store")],Json(serde_json::json!({"status":"ok","api_version":API_VERSION,"engine_version":ENGINE_VERSION}))) }))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
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
        let mut request =
            Request::post("/v1/move").header(header::CONTENT_TYPE, "application/json");
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
}
