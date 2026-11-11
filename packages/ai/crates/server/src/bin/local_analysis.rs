use tetraboard_ai_server::local_analysis::router;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let token = std::env::var("AI_LOCAL_TOKEN").map_err(
        |_| "AI_LOCAL_TOKENが必要です。bun run --cwd packages/ai setup:local を実行してください",
    )?;
    let app = router(token)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3002").await?;
    println!(
        "{}",
        serde_json::json!({"listen":"127.0.0.1:3002","service":"local-analysis"})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
