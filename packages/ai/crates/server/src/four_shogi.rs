use super::{ApiError, ServiceState, valid_identity};
use axum::{
    Json,
    extract::{State as AppState, rejection::JsonRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tetraboard_ai_agents::four_shogi::{Decision, Profile, decide_with_limits};
use tetraboard_ai_engine::four_shogi::{Event, Side, State};

pub(super) const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_EVENTS: usize = 1600;
const ENGINE_VERSION: &str = "four-shogi-lv3-v1";
const MAX_TIME_MS: u64 = 500;

#[derive(Clone, Copy, Deserialize, Serialize)]
enum RatedProfile {
    #[serde(rename = "four-shogi-lv3-work4096-v1")]
    Work4096,
    #[serde(rename = "four-shogi-lv3-work16384-v1")]
    Work16384,
    #[serde(rename = "four-shogi-lv3-work65536-v1")]
    Work65536,
}

impl RatedProfile {
    fn max_work(self) -> u64 {
        match self {
            Self::Work4096 => 4096,
            Self::Work16384 => 16384,
            Self::Work65536 => 65536,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MoveRequest {
    api_version: u32,
    rules_version: u8,
    request_id: String,
    position_revision: String,
    profile_id: RatedProfile,
    three_player_attack_prohibited: bool,
    turn: Side,
    events: Vec<Event>,
}

#[derive(Serialize)]
pub(super) struct MoveResponse {
    api_version: u32,
    rules_version: u8,
    request_id: String,
    position_revision: String,
    engine_version: &'static str,
    profile_id: RatedProfile,
    max_work: u64,
    max_time_ms: u64,
    replay_us: u64,
    #[serde(flatten)]
    decision: Decision,
}

pub(super) async fn choose_move(
    AppState(service): AppState<ServiceState>,
    payload: Result<Json<MoveRequest>, JsonRejection>,
) -> Result<Json<MoveResponse>, ApiError> {
    let Json(request) = payload.map_err(|error| {
        let status = match error.status() {
            StatusCode::PAYLOAD_TOO_LARGE | StatusCode::UNSUPPORTED_MEDIA_TYPE => error.status(),
            _ => StatusCode::BAD_REQUEST,
        };
        ApiError(status, "invalid_request")
    })?;
    if request.api_version != 1 || request.rules_version != 1 {
        return Err(ApiError(StatusCode::BAD_REQUEST, "unsupported_version"));
    }
    if request.events.len() > MAX_EVENTS
        || !valid_identity(&request.request_id, &request.position_revision)
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let permit = service
        .permits
        .try_acquire_owned()
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "busy"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let replay_start = Instant::now();
        let (state, mut history) =
            State::replay(request.three_player_attack_prohibited, &request.events)
                .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "invalid_replay"))?;
        let replay_us = replay_start.elapsed().as_micros() as u64;
        if state.turn() != Some(request.turn) {
            return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_turn"));
        }
        let max_work = request.profile_id.max_work();
        let decision = decide_with_limits(
            &state,
            &mut history,
            Profile::Lv3,
            Duration::from_millis(MAX_TIME_MS),
            max_work,
        )
        .ok_or(ApiError(StatusCode::BAD_REQUEST, "no_legal_move"))?;
        Ok(Json(MoveResponse {
            api_version: request.api_version,
            rules_version: request.rules_version,
            request_id: request.request_id,
            position_revision: request.position_revision,
            engine_version: ENGINE_VERSION,
            profile_id: request.profile_id,
            max_work,
            max_time_ms: MAX_TIME_MS,
            replay_us,
            decision,
        }))
    })
    .await
    .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "computation_failed"))?
}
