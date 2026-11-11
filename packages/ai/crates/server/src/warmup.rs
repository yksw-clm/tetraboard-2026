use super::{ApiError, ServiceState};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct WarmupRequest {
    game: String,
}

pub(super) async fn prepare(
    State(service): State<ServiceState>,
    Query(request): Query<WarmupRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    match request.game.as_str() {
        "reversi" => {
            service
                .reversi
                .ok_or(ApiError(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "reversi_disabled",
                ))?
                .warmup()
                .await?;
        }
        "shogi" => {
            service
                .shogi
                .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "shogi_disabled"))?
                .warmup()
                .await?;
        }
        _ => return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request")),
    }
    Ok(Json(serde_json::json!({ "status": "ok" })))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::Request,
    };
    use std::{fs, os::unix::fs::PermissionsExt};
    use tower::ServiceExt;

    const TOKEN: &str = "warmup-test-token-at-least-32-characters";

    async fn send(app: Router, game: &str, authenticated: bool) -> (StatusCode, serde_json::Value) {
        let mut request = Request::post(format!("/admin/warmup?game={game}"));
        if authenticated {
            request = request.header("authorization", format!("Bearer {TOKEN}"));
        }
        let response = app
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn health_does_not_claim_an_unavailable_engine_is_ready() {
        let app = crate::router(TOKEN.into(), 2).unwrap();
        let health = app
            .clone()
            .oneshot(Request::get("/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(health.status(), StatusCode::OK);
        for game in ["shogi", "reversi"] {
            assert_eq!(
                send(app.clone(), game, false).await.0,
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                send(app.clone(), game, true).await.0,
                StatusCode::SERVICE_UNAVAILABLE
            );
        }
        assert_eq!(send(app, "unknown", true).await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn readiness_requires_a_move_and_keeps_the_initialized_session() {
        for game in ["shogi", "reversi"] {
            let directory = std::env::temp_dir()
                .join(format!("tetraboard-warmup-{game}-{}", std::process::id()));
            fs::create_dir_all(directory.join("book")).unwrap();
            fs::write(directory.join("book/standard_book.db"), "test").unwrap();
            let path = directory.join("engine");
            let events = directory.join("events");
            let script = format!(
                "#!/bin/sh\necho start >> '{events}'\nwhile IFS= read -r line; do\ncase \"$line\" in\nusi) echo usiok ;;\nisready) echo readyok ;;\n'go nodes '*) echo search >> '{events}'; echo 'bestmove 7g7f' ;;\ngo) echo search >> '{events}'; echo d3 ;;\nesac\ndone\n",
                events = events.display(),
            );
            fs::write(&path, script).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            let app = crate::router_with_engines(
                TOKEN.into(),
                2,
                (game == "shogi").then(|| path.clone()),
                (game == "reversi").then(|| path.clone()),
            )
            .unwrap();
            for _ in 0..2 {
                let (status, body) = send(app.clone(), game, true).await;
                assert_eq!(status, StatusCode::OK);
                assert_eq!(body, serde_json::json!({ "status": "ok" }));
            }
            assert_eq!(
                fs::read_to_string(&events).unwrap(),
                "start\nsearch\nsearch\n"
            );
            drop(app);
            fs::remove_file(&events).unwrap();
            fs::write(&path, "#!/bin/sh\nexit 1\n").unwrap();
            let app = crate::router_with_engines(
                TOKEN.into(),
                2,
                (game == "shogi").then(|| path.clone()),
                (game == "reversi").then(|| path.clone()),
            )
            .unwrap();
            assert_eq!(
                send(app, game, true).await.0,
                StatusCode::SERVICE_UNAVAILABLE
            );
            fs::remove_dir_all(directory).unwrap();
        }
    }
}
