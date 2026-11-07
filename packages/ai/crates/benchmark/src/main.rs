use serde::Serialize;
use std::io::{self, BufWriter, Write};
use std::process::{Command, ExitCode};
use tetraboard_ai_benchmark::{
    play_game,
    tournament::{TournamentConfig, run_tournament},
};

const USAGE: &str = "Usage: tetraboard-ai-benchmark [--games <positive-u64>] [--seed <u64>]\n       tetraboard-ai-benchmark --config <path> [--rounds <positive-u64>] [--seed <u64>]\nDefaults: random mode 1 game, seed 0; config mode 1 round with 4 rotations per matchup and config.seed. Outputs JSONL.";

#[derive(Debug, PartialEq, Eq)]
struct Options {
    games: u64,
    seed: Option<u64>,
    config: Option<String>,
    rounds: u64,
}

fn parse_options(args: impl IntoIterator<Item = String>) -> Result<Option<Options>, String> {
    let mut args = args.into_iter();
    let mut options = Options {
        games: 1,
        seed: None,
        config: None,
        rounds: 1,
    };
    let mut seen = Vec::new();
    while let Some(flag) = args.next() {
        if flag == "--help" || flag == "-h" {
            return Ok(None);
        }
        if !["--games", "--seed", "--config", "--rounds"].contains(&flag.as_str())
            || seen.contains(&flag)
        {
            return Err(format!("不明または重複した引数: {flag}"));
        }
        let value = args
            .next()
            .ok_or_else(|| format!("{flag} の値がありません"))?;
        if flag == "--config" {
            options.config = Some(value);
            seen.push(flag);
            continue;
        }
        let number: u64 = value
            .parse()
            .map_err(|_| format!("{flag} にはu64整数を指定してください"))?;
        match flag.as_str() {
            "--games" if number > 0 => options.games = number,
            "--seed" => options.seed = Some(number),
            "--rounds" if number > 0 => options.rounds = number,
            _ => return Err("--gamesと--roundsは1以上にしてください".into()),
        }
        seen.push(flag);
    }
    if (options.config.is_some() && seen.iter().any(|s| s == "--games"))
        || (options.config.is_none() && seen.iter().any(|s| s == "--rounds"))
    {
        return Err("--gamesはランダム対局専用、--roundsは--configと併用してください".into());
    }
    Ok(Some(options))
}

#[derive(Serialize)]
struct Environment {
    os: &'static str,
    arch: &'static str,
    source_commit: Option<String>,
    source_dirty: Option<bool>,
}

#[derive(Serialize)]
struct Record<'a, T> {
    environment: &'a Environment,
    #[serde(flatten)]
    record: &'a T,
}

fn environment() -> Environment {
    // 実行場所の別リポジトリを誤って記録しないよう、ビルド元を指定します。
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..");
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(&source)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| String::from_utf8(output.stdout).ok())
    };
    Environment {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        source_commit: git(&["rev-parse", "HEAD"]).map(|s| s.trim().into()),
        source_dirty: git(&["status", "--porcelain"]).map(|s| !s.is_empty()),
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let Some(options) = parse_options(std::env::args().skip(1))? else {
        println!("{USAGE}");
        return Ok(());
    };
    let environment = environment();
    let mut output = BufWriter::new(io::stdout().lock());
    if let Some(path) = options.config {
        let config: TournamentConfig = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        let summary = run_tournament(
            &config,
            options.rounds,
            options.seed.unwrap_or(config.seed),
            |record| emit(&mut output, &environment, record).map_err(|error| error.to_string()),
        )?;
        emit(&mut output, &environment, &summary)?;
        if summary.failed_games > 0 {
            return Err(format!("{}局の失敗があります", summary.failed_games).into());
        }
        return Ok(());
    }
    for game_index in 0..options.games {
        let game = play_game(options.seed.unwrap_or(0), game_index)?;
        emit(&mut output, &environment, &game)?;
    }
    Ok(())
}

fn emit(
    output: &mut impl Write,
    environment: &Environment,
    record: &impl Serialize,
) -> Result<(), Box<dyn std::error::Error>> {
    serde_json::to_writer(
        &mut *output,
        &Record {
            environment,
            record,
        },
    )?;
    writeln!(output)?;
    output.flush()?;
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}\n{USAGE}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Option<Options>, String> {
        parse_options(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn options_accept_defaults_and_explicit_limits() {
        assert_eq!(
            parse(&[]).unwrap(),
            Some(Options {
                games: 1,
                seed: None,
                config: None,
                rounds: 1
            })
        );
        assert_eq!(
            parse(&["--seed", "18446744073709551615", "--games", "100"]).unwrap(),
            Some(Options {
                games: 100,
                seed: Some(u64::MAX),
                config: None,
                rounds: 1
            })
        );
        assert_eq!(parse(&["--help"]).unwrap(), None);
    }

    #[test]
    fn options_reject_invalid_or_ambiguous_arguments() {
        for args in [
            vec!["--games", "0"],
            vec!["--seed", "-1"],
            vec!["--seed"],
            vec!["--games", "1.5"],
            vec!["--seed", "18446744073709551616"],
            vec!["--unknown", "1"],
            vec!["--seed", "1", "--seed", "2"],
            vec!["--rounds", "1"],
            vec!["--config", "x", "--games", "1"],
            vec!["--config", "x", "--rounds", "0"],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
}
