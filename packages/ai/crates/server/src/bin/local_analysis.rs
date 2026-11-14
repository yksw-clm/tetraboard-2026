use tetraboard_ai_server::local_analysis::router;

fn port(args: impl Iterator<Item = String>) -> Result<u16, &'static str> {
    let args: Vec<_> = args.collect();
    match args.as_slice() {
        [] => Ok(3002),
        [flag, value] if flag == "--port" => value.parse().map_err(|_| "portが不正です"),
        _ => Err("使用方法: tetraboard-ai-local [--port 0..65535]"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = port(std::env::args().skip(1))?;
    let token = std::env::var("AI_LOCAL_TOKEN").map_err(
        |_| "AI_LOCAL_TOKENが必要です。bun run --cwd packages/ai setup:local を実行してください",
    )?;
    let app = router(token)?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "{}",
        serde_json::json!({"listen":listener.local_addr()?.to_string(),"service":"local-analysis"})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::port;

    #[test]
    fn keeps_default_and_accepts_ephemeral_loopback_port() {
        assert_eq!(port([].into_iter()), Ok(3002));
        assert_eq!(port(["--port".into(), "0".into()].into_iter()), Ok(0));
        assert!(port(["--port".into(), "65536".into()].into_iter()).is_err());
        assert!(port(["--listen".into(), "0.0.0.0:3002".into()].into_iter()).is_err());
    }
}
