use super::{ApiError, ServiceState, valid_identity};
use axum::{
    Json,
    extract::{State, rejection::JsonRejection},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex, Semaphore},
    time::timeout,
};

pub(super) struct Engine {
    path: PathBuf,
    pending: Semaphore,
    session: Mutex<Option<Session>>,
}

impl Engine {
    pub(super) fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: Semaphore::new(4),
            session: Mutex::new(None),
        }
    }

    async fn search(&self, request: &MoveRequest) -> Result<[u8; 2], ApiError> {
        let _permit = self
            .pending
            .try_acquire()
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "overloaded"))?;
        timeout(Duration::from_secs(4), async {
            let mut slot = self.session.lock().await;
            let mut session = match slot.take() {
                Some(session) => session,
                None => Session::start(&self.path)?,
            };
            let turn = if request.black_to_move { 'B' } else { 'W' };
            // 別対局の探索結果が次の要求に影響しないようにキャッシュを消去します。
            let commands = format!(
                "clearcache\nlevel {}\nsetboard {} {}\ngo\n",
                request.level, request.board, turn
            );
            session.input.write_all(commands.as_bytes()).await?;
            let line = session.output.next_line().await?.ok_or(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "engine exited",
            ))?;
            let square = match line.as_bytes() {
                [x @ b'a'..=b'h', y @ b'1'..=b'8'] => [x - b'a', y - b'1'],
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "unexpected move",
                    ));
                }
            };
            *slot = Some(session);
            Ok(square)
        })
        .await
        .map_err(|_| ApiError(StatusCode::GATEWAY_TIMEOUT, "engine_timeout"))?
        .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "engine_failed"))
    }
}

struct Session {
    _child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
}

impl Session {
    fn start(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected absolute engine path",
            ));
        }
        let mut child = Command::new(path)
            .current_dir(path.parent().expect("absolute engine path"))
            .args([
                "-quiet",
                "-nobook",
                "-thread",
                "1",
                "-hashlevel",
                "18",
                "-mode",
                "3",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("AI_SERVICE_TOKEN")
            .kill_on_drop(true)
            .spawn()?;
        Ok(Self {
            input: child.stdin.take().expect("piped stdin"),
            output: BufReader::new(child.stdout.take().expect("piped stdout")).lines(),
            _child: child,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MoveRequest {
    request_id: String,
    position_revision: String,
    level: u8,
    board: String,
    black_to_move: bool,
}

#[derive(Serialize)]
pub(super) struct MoveResponse {
    request_id: String,
    position_revision: String,
    engine_version: &'static str,
    level: u8,
    position: Position,
}

#[derive(Serialize)]
struct Position {
    x: u8,
    y: u8,
}

pub(super) async fn choose_move(
    State(service): State<ServiceState>,
    payload: Result<Json<MoveRequest>, JsonRejection>,
) -> Result<Json<MoveResponse>, ApiError> {
    let Json(request) = payload.map_err(|error| ApiError(error.status(), "invalid_request"))?;
    if !valid_identity(&request.request_id, &request.position_revision)
        || request.level != 4
        || request.board.len() != 64
        || !request
            .board
            .bytes()
            .all(|cell| matches!(cell, b'B' | b'W' | b'-'))
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let engine = service.reversi.ok_or(ApiError(
        StatusCode::SERVICE_UNAVAILABLE,
        "reversi_disabled",
    ))?;
    let [x, y] = engine.search(&request).await?;
    Ok(Json(MoveResponse {
        request_id: request.request_id,
        position_revision: request.position_revision,
        engine_version: "egaroucid-console-7.8.2-0c1b84ef",
        level: request.level,
        position: Position { x, y },
    }))
}
