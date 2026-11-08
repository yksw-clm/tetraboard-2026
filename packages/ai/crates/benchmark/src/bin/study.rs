use serde_json::json;
use std::{
    io::{self, Write},
    path::Path,
    time::Instant,
};
use tetraboard_ai_agents::{
    RandomAgent, build_agent,
    profiles::{ServedProfile, builtin_profiles},
};
use tetraboard_ai_engine::four_reversi::State;

fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("analyze") if args.len() == 2 => {
            let result = tetraboard_ai_benchmark::study::analyze(Path::new(&args[1]))?;
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
        }
        Some("performance") if (1..=3).contains(&args.len()) => {
            let profiles: Vec<ServedProfile> =
                if let Some(path) = args.get(1).filter(|s| s.as_str() != "-") {
                    let value: serde_json::Value =
                        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                            .map_err(|e| e.to_string())?;
                    serde_json::from_value(value["profiles"].clone()).map_err(|e| e.to_string())?
                } else {
                    builtin_profiles()?
                };
            let mut positions = vec![State::initial()];
            for seed in 0..16 {
                let mut agents: Vec<_> = (0..4).map(|s| RandomAgent::new(seed, s)).collect();
                let mut state = State::initial();
                while let Some(color) = state.turn() {
                    let p = agents[color.index()].choose_move(&state).unwrap();
                    state = state.apply_move(p).unwrap().state;
                    if state.turn().is_some() && [12, 28, 44, 52].contains(&state.move_number()) {
                        positions.push(state.clone());
                    }
                }
            }
            let mut out = io::BufWriter::new(io::stdout().lock());
            let count = profiles
                .iter()
                .filter(|p| args.get(2).is_none_or(|id| id == &p.id))
                .count();
            if count == 0 {
                return Err("profileが見つかりません".into());
            }
            for profile in profiles
                .into_iter()
                .filter(|p| args.get(2).is_none_or(|id| id == &p.id))
            {
                let reproducible = !matches!(&profile.config,tetraboard_ai_agents::config::AgentConfig::Mcts{budget,..} if budget.max_time_ms.is_some());
                let mut times = Vec::new();
                for (index, state) in positions.iter().enumerate() {
                    let mut first = None;
                    for sample in 0..3 {
                        let mut agent = build_agent(&profile.config, 7, 0)?;
                        let start = Instant::now();
                        let decision = agent.decide(state);
                        let ns = start.elapsed().as_nanos() as u64;
                        if !state
                            .legal_moves()
                            .contains(&decision.position.ok_or("継続局面で着手なし")?)
                        {
                            return Err("不正手です".into());
                        }
                        if reproducible && first.as_ref().is_some_and(|d| d != &decision) {
                            return Err("固定予算の再現性がありません".into());
                        }
                        first = Some(decision.clone());
                        times.push(ns);
                        writeln!(out,"{}",json!({"record_type":"performance","profile_id":profile.id,"profile_hash":profile.profile_hash,"config":profile.config,"reproducible":reproducible,"position_index":index,"state":state,"sample":sample,"elapsed_ns":ns,"diagnostics":decision.stats})).map_err(|e|e.to_string())?;
                    }
                }
                times.sort_unstable();
                writeln!(out,"{}",json!({"record_type":"performance_summary","profile_id":profile.id,"profile_hash":profile.profile_hash,"config":profile.config,"reproducible":reproducible,"samples":times.len(),"positions":positions.len(),"p50_ms":times[(times.len()*50).div_ceil(100)-1] as f64/1e6,"p95_ms":times[(times.len()*95).div_ceil(100)-1] as f64/1e6,"max_ms":*times.last().unwrap() as f64/1e6,"mean_ms":times.iter().map(|n|*n as f64).sum::<f64>()/times.len() as f64/1e6})).map_err(|e|e.to_string())?;
            }
        }
        _ => return Err("Usage: study analyze <run-directory> | study performance".into()),
    }
    Ok(())
}
fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            std::process::ExitCode::FAILURE
        }
    }
}
