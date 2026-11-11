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

const ENGINE_VERSION: &str = "yaneuraou-material-faeb37f0";
const NODE_BUDGETS: [u16; 5] = [64, 128, 256, 512, 1024];
const STANDARD_BOOK_FILE: &str = "standard_book.db";

pub(super) struct Engine {
    path: PathBuf,
    book_dir: Option<PathBuf>,
    pending: Semaphore,
    session: Mutex<Option<Session>>,
}

impl Engine {
    pub(super) async fn warmup(&self) -> Result<(), ApiError> {
        // 定跡と本体を初期化し、次の要求にも同じセッションを引き継ぎます。
        self.search(&[], 64, Some(OpeningBook::StandardV1)).await?;
        Ok(())
    }

    pub(super) fn new(path: PathBuf) -> Self {
        let book_dir = path
            .parent()
            .and_then(|dir| dir.join("book").canonicalize().ok())
            .filter(|dir| dir.join(STANDARD_BOOK_FILE).is_file());
        Self {
            path,
            book_dir,
            pending: Semaphore::new(4),
            session: Mutex::new(None),
        }
    }

    async fn search(
        &self,
        moves: &[String],
        nodes: u16,
        opening_book: Option<OpeningBook>,
    ) -> Result<String, ApiError> {
        if opening_book.is_some() && self.book_dir.is_none() {
            return Err(ApiError(
                StatusCode::SERVICE_UNAVAILABLE,
                "shogi_book_unavailable",
            ));
        }
        let _permit = self
            .pending
            .try_acquire()
            .map_err(|_| ApiError(StatusCode::SERVICE_UNAVAILABLE, "overloaded"))?;
        timeout(Duration::from_secs(4), async {
            let mut slot = self.session.lock().await;
            // 探索中に期限切れになったプロセスは破棄し、遅延した応答を次の要求に使いません。
            let mut session = match slot.take() {
                Some(session) => session,
                None => Session::start(&self.path, self.book_dir.as_deref()).await?,
            };
            if self.book_dir.is_some() {
                // 共有プロセスの設定を要求ごとに切り替え、対局間で混ざらないようにします。
                let book_moves = if opening_book.is_some() { 2 } else { 0 };
                session
                    .send(&format!("setoption name BookMoves value {book_moves}"))
                    .await?;
            }
            let position = if moves.is_empty() {
                "position startpos".to_owned()
            } else {
                format!("position startpos moves {}", moves.join(" "))
            };
            session.send(&position).await?;
            session.send(&format!("go nodes {nodes}")).await?;
            let line = session.read_until("bestmove ").await?;
            let best_move = line
                .split_ascii_whitespace()
                .nth(1)
                .filter(|action| valid_move(action))
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid bestmove"))?;
            *slot = Some(session);
            Ok::<_, io::Error>(best_move.to_owned())
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
    async fn start(path: &Path, book_dir: Option<&Path>) -> io::Result<Self> {
        let mut child = Command::new(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_remove("AI_SERVICE_TOKEN")
            .kill_on_drop(true)
            .spawn()?;
        let mut session = Self {
            input: child.stdin.take().expect("標準入力を接続します"),
            output: BufReader::new(child.stdout.take().expect("標準出力を接続します")).lines(),
            _child: child,
        };
        session.send("usi").await?;
        session.read_until("usiok").await?;
        for option in [
            "setoption name USI_Hash value 16",
            "setoption name Threads value 1",
            "setoption name EnteringKingRule value NoEnteringKing",
        ] {
            session.send(option).await?;
        }
        if let Some(book_dir) = book_dir {
            session
                .send(&format!(
                    "setoption name BookDir value {}",
                    book_dir.display()
                ))
                .await?;
            session
                .send(&format!(
                    "setoption name BookFile value {STANDARD_BOOK_FILE}"
                ))
                .await?;
            session
                .send("setoption name BookOnTheFly value true")
                .await?;
            session
                .send("setoption name ConsiderBookMoveCount value true")
                .await?;
        } else {
            session
                .send("setoption name BookFile value no_book")
                .await?;
        }
        session.send("isready").await?;
        session.read_until("readyok").await?;
        session.send("usinewgame").await?;
        Ok(session)
    }

    async fn send(&mut self, line: &str) -> io::Result<()> {
        self.input.write_all(line.as_bytes()).await?;
        self.input.write_all(b"\n").await
    }

    async fn read_until(&mut self, prefix: &str) -> io::Result<String> {
        while let Some(line) = self.output.next_line().await? {
            if line.starts_with(prefix) {
                return Ok(line);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "engine exited",
        ))
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
enum OpeningBook {
    #[serde(rename = "standard-v1")]
    StandardV1,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MoveRequest {
    request_id: String,
    position_revision: String,
    nodes: u16,
    moves: Vec<String>,
    opening_book: Option<OpeningBook>,
}

#[derive(Serialize)]
pub(super) struct MoveResponse {
    request_id: String,
    position_revision: String,
    engine_version: &'static str,
    nodes: u16,
    best_move: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    opening_book: Option<OpeningBook>,
}

pub(super) async fn choose_move(
    State(service): State<ServiceState>,
    payload: Result<Json<MoveRequest>, JsonRejection>,
) -> Result<Json<MoveResponse>, ApiError> {
    let Json(request) = payload.map_err(|error| ApiError(error.status(), "invalid_request"))?;
    if !valid_identity(&request.request_id, &request.position_revision)
        || !NODE_BUDGETS.contains(&request.nodes)
        || request.moves.len() > 1024
        || !request.moves.iter().all(|action| valid_move(action))
    {
        return Err(ApiError(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let engine = service
        .shogi
        .ok_or(ApiError(StatusCode::SERVICE_UNAVAILABLE, "shogi_disabled"))?;
    let best_move = engine
        .search(&request.moves, request.nodes, request.opening_book)
        .await?;
    Ok(Json(MoveResponse {
        request_id: request.request_id,
        position_revision: request.position_revision,
        engine_version: ENGINE_VERSION,
        nodes: request.nodes,
        best_move,
        opening_book: request.opening_book,
    }))
}

fn valid_move(action: &str) -> bool {
    let square =
        |file: u8, rank: u8| (b'1'..=b'9').contains(&file) && (b'a'..=b'i').contains(&rank);
    match *action.as_bytes() {
        [piece, b'*', file, rank] => b"RBGSNLP".contains(&piece) && square(file, rank),
        [file, rank, to_file, to_rank] | [file, rank, to_file, to_rank, b'+'] => {
            square(file, rank) && square(to_file, to_rank)
        }
        _ => false,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn timed_out_session_is_replaced_before_the_next_search() {
        let path = std::env::temp_dir().join(format!("tetraboard-usi-{}", std::process::id()));
        fs::write(
            &path,
            "#!/bin/sh\nwhile IFS= read -r line; do\ncase \"$line\" in\nusi) echo usiok ;;\nisready) echo readyok ;;\n'position startpos') blocked=no ;;\n'position startpos moves '*) blocked=yes ;;\n'go nodes '*) if [ \"$blocked\" = no ]; then echo 'bestmove 7g7f'; else while IFS= read -r ignored; do :; done; fi ;;\nesac\ndone\n",
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = Engine::new(path.clone());
        let result = engine.search(&["7g7f".into()], 256, None).await;
        let replacement = engine.search(&[], 256, None).await;
        fs::remove_file(path).unwrap();

        assert!(matches!(
            result,
            Err(ApiError(StatusCode::GATEWAY_TIMEOUT, _))
        ));
        assert!(replacement.is_ok_and(|action| action == "7g7f"));
    }
}
