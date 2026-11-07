use serde::Serialize;
use std::io::{self, BufWriter, Write};
use std::process::{Command, ExitCode};
use tetraboard_ai_benchmark::{GameLog, play_game};

const USAGE: &str = "Usage: tetraboard-ai-benchmark [--games <positive-u64>] [--seed <u64>]\nDefaults: --games 1 --seed 0. Outputs one JSON record per game to stdout.";

#[derive(Debug, PartialEq, Eq)]
struct Options {
    games: u64,
    seed: u64,
}

fn parse_options(args: impl IntoIterator<Item = String>) -> Result<Option<Options>, String> {
    let mut args = args.into_iter();
    let mut options = Options { games: 1, seed: 0 };
    let mut seen = Vec::new();
    while let Some(flag) = args.next() {
        if flag == "--help" || flag == "-h" {
            return Ok(None);
        }
        if !["--games", "--seed"].contains(&flag.as_str()) || seen.contains(&flag) {
            return Err(format!("不明または重複した引数: {flag}"));
        }
        let number: u64 = args
            .next()
            .ok_or_else(|| format!("{flag} の値がありません"))?
            .parse()
            .map_err(|_| format!("{flag} にはu64整数を指定してください"))?;
        match flag.as_str() {
            "--games" if number > 0 => options.games = number,
            "--seed" => options.seed = number,
            _ => return Err("--games は1以上にしてください".into()),
        }
        seen.push(flag);
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
struct Record<'a> {
    environment: &'a Environment,
    #[serde(flatten)]
    game: GameLog,
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
    for game_index in 0..options.games {
        let game = play_game(options.seed, game_index)?;
        serde_json::to_writer(
            &mut output,
            &Record {
                environment: &environment,
                game,
            },
        )?;
        writeln!(output)?;
        output.flush()?;
    }
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
        assert_eq!(parse(&[]).unwrap(), Some(Options { games: 1, seed: 0 }));
        assert_eq!(
            parse(&["--seed", "18446744073709551615", "--games", "100"]).unwrap(),
            Some(Options {
                games: 100,
                seed: u64::MAX
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
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
    }
}
