use crate::config::{AgentConfig, MctsBudget};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServedProfile {
    pub id: String,
    pub profile_hash: String,
    pub config: AgentConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    format_version: u32,
    profiles: Vec<ServedProfile>,
}

pub fn builtin_profiles() -> Result<Vec<ServedProfile>, String> {
    let registry: Registry =
        serde_json::from_str(include_str!("../../../configs/profiles-v1.json"))
            .map_err(|e| e.to_string())?;
    if registry.format_version != 1 || registry.profiles.len() != 5 {
        return Err("profile一覧の版・件数が不正です".into());
    }
    for (i, profile) in registry.profiles.iter().enumerate() {
        profile.config.validate()?;
        if profile.id != format!("lv{}-v1", i + 1)
            || profile.profile_hash.len() != 64
            || !profile
                .profile_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("profileのID・hashが不正です".into());
        }
        if let AgentConfig::Mcts { budget, .. } = &profile.config
            && (budget.max_iterations > 4096
                || budget.max_nodes > 65536
                || budget.max_time_ms.is_some())
        {
            return Err("Service profileの予算が範囲外です".into());
        }
    }
    Ok(registry.profiles)
}

/// 実験候補は公開Serviceのprofile一覧と分けて読み込みます。
pub fn local_analysis_profiles() -> Result<Vec<ServedProfile>, String> {
    let registry: Registry = serde_json::from_str(include_str!(
        "../../../configs/local-analysis-profiles-v1.json"
    ))
    .map_err(|e| e.to_string())?;
    if registry.format_version != 1
        || registry.profiles.len() != 1
        || registry.profiles[0].id != "lv6-candidate-a-v1"
    {
        return Err("ローカルprofile一覧の版・ID・件数が不正です".into());
    }
    let mut baseline = builtin_profiles()?.remove(4);
    if let AgentConfig::Mcts { budget, .. } = &mut baseline.config {
        budget.max_time_ms = Some(2000);
    }
    let mut profiles = vec![baseline];
    for profile in registry.profiles {
        profile.config.validate()?;
        if !matches!(
            profile.config,
            AgentConfig::Mcts {
                budget: MctsBudget {
                    max_iterations: 8192,
                    max_nodes: 262144,
                    max_time_ms: Some(2000),
                },
                ..
            }
        ) || profile.profile_hash.len() != 64
            || !profile
                .profile_hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("ローカルprofileの設定・hashが不正です".into());
        }
        profiles.push(profile);
    }
    Ok(profiles)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_nodes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_time_ms: Option<u64>,
}

pub fn configured(
    profile: &ServedProfile,
    seed: u64,
    limits: Option<ProfileLimits>,
) -> Result<AgentConfig, String> {
    let mut config = profile.config.clone();
    match &mut config {
        AgentConfig::Random { seed: s }
        | AgentConfig::Greedy { seed: s, .. }
        | AgentConfig::MaxN { seed: s, .. }
        | AgentConfig::Mcts { seed: s, .. } => *s = seed,
    }
    if let Some(limits) = limits {
        let invalid = || "profileの予算を増やす指定・対象外の指定はできません".to_string();
        match &mut config {
            AgentConfig::Mcts { budget, .. } => {
                if let Some(n) = limits.max_iterations {
                    if n == 0 || n > budget.max_iterations {
                        return Err(invalid());
                    }
                    budget.max_iterations = n;
                }
                if let Some(n) = limits.max_nodes {
                    if n == 0 || n > budget.max_nodes {
                        return Err(invalid());
                    }
                    budget.max_nodes = n;
                }
                if let Some(n) = limits.max_time_ms {
                    if !(1..=500).contains(&n) {
                        return Err(invalid());
                    }
                    budget.max_time_ms = Some(n);
                }
            }
            AgentConfig::MaxN { budget, .. } => {
                if limits.max_iterations.is_some() || limits.max_time_ms.is_some() {
                    return Err(invalid());
                }
                if let Some(n) = limits.max_nodes {
                    if n == 0 || n > budget.max_nodes {
                        return Err(invalid());
                    }
                    budget.max_nodes = n;
                }
            }
            _ => return Err(invalid()),
        }
    }
    config.validate()?;
    Ok(config)
}

pub fn effective_limits(config: &AgentConfig) -> Option<ProfileLimits> {
    match config {
        AgentConfig::Mcts {
            budget:
                MctsBudget {
                    max_iterations,
                    max_nodes,
                    max_time_ms,
                },
            ..
        } => Some(ProfileLimits {
            max_iterations: Some(*max_iterations),
            max_nodes: Some(*max_nodes),
            max_time_ms: *max_time_ms,
        }),
        AgentConfig::MaxN { budget, .. } => Some(ProfileLimits {
            max_nodes: Some(budget.max_nodes),
            ..Default::default()
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_candidates_do_not_change_public_profiles() {
        let public = builtin_profiles().unwrap();
        assert_eq!(public.len(), 5);
        assert!(public.iter().all(|p| p.id != "lv6-candidate-a-v1"));
        let local = local_analysis_profiles().unwrap();
        assert_eq!(local.len(), 2);
        assert_eq!(local[0].profile_hash, public[4].profile_hash);
        let mut expected = public[4].config.clone();
        if let AgentConfig::Mcts { budget, .. } = &mut expected {
            budget.max_time_ms = Some(2000);
        }
        assert_eq!(local[0].config, expected);
        assert!(configured(&local[1], 0, None).is_ok());
    }
    #[test]
    fn profiles_are_bounded_and_overrides_only_reduce_work() {
        let profiles = builtin_profiles().unwrap();
        for p in &profiles {
            configured(p, 7, None).unwrap();
        }
        let p = &profiles[4];
        assert!(
            configured(
                p,
                7,
                Some(ProfileLimits {
                    max_nodes: Some(1),
                    ..Default::default()
                })
            )
            .is_ok()
        );
        for limits in [
            ProfileLimits {
                max_nodes: Some(65537),
                ..Default::default()
            },
            ProfileLimits {
                max_time_ms: Some(501),
                ..Default::default()
            },
            ProfileLimits {
                max_iterations: Some(0),
                ..Default::default()
            },
        ] {
            assert!(configured(p, 0, Some(limits)).is_err());
        }
        assert!(configured(&profiles[0], 0, Some(ProfileLimits::default())).is_err());
    }
}
