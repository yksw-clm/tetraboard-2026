use tetraboard_ai_server::router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("AI_SERVICE_TOKEN").map_err(|_| "AI_SERVICE_TOKENが必要です")?;
    let concurrency: usize = std::env::var("AI_SERVICE_CONCURRENCY")
        .unwrap_or_else(|_| "2".into())
        .parse()?;
    let listen = std::env::var("AI_SERVICE_LISTEN").unwrap_or_else(|_| "127.0.0.1:3001".into());
    let app = router(token, concurrency)?;
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    println!(
        "{}",
        serde_json::json!({"listen":listener.local_addr()?.to_string()})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("終了シグナルを登録します");
        tokio::select! { _=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
