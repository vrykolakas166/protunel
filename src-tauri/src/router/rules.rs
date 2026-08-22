use std::net::IpAddr;
use std::str::FromStr;

use ipnet::IpNet;
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What a rule looks at. Host patterns are tested against the destination
/// hostname the SOCKS client asked for (or its literal IP, rendered as text);
/// `IpCidr` needs an actual address, which for a hostname target means resolving
/// it first — see [`match_target`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    HostWildcard,
    HostRegex,
    IpCidr,
    All,
}

impl RuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleKind::HostWildcard => "host_wildcard",
            RuleKind::HostRegex => "host_regex",
            RuleKind::IpCidr => "ip_cidr",
            RuleKind::All => "all",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "host_regex" => RuleKind::HostRegex,
            "ip_cidr" => RuleKind::IpCidr,
            "all" => RuleKind::All,
            _ => RuleKind::HostWildcard,
        }
    }
}

/// Where a matched connection goes. `Direct` dials from this machine, bypassing
/// every tunnel; `Block` refuses the connection outright.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleAction {
    Tunnel,
    Direct,
    Block,
}

impl RuleAction {
    pub fn as_str(self) -> &'static str {
        match self {
            RuleAction::Tunnel => "tunnel",
            RuleAction::Direct => "direct",
            RuleAction::Block => "block",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "tunnel" => RuleAction::Tunnel,
            "block" => RuleAction::Block,
            _ => RuleAction::Direct,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRule {
    pub id: Uuid,
    /// Evaluation order, ascending. First enabled match wins.
    pub position: i64,
    pub enabled: bool,
    pub kind: RuleKind,
    pub pattern: String,
    /// Optional extra constraint on the destination port.
    pub port: Option<u16>,
    pub action: RuleAction,
    pub target_tunnel_id: Option<Uuid>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterRuleInput {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub kind: RuleKind,
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub port: Option<u16>,
    pub action: RuleAction,
    #[serde(default)]
    pub target_tunnel_id: Option<Uuid>,
}

fn default_true() -> bool {
    true
}

/// A rule with its pattern already turned into something matchable. Compiling on
/// every connection would mean re-parsing a regex per request, so the router
/// keeps a compiled snapshot and rebuilds it whenever the rule list changes.
pub struct CompiledRule {
    pub rule: RouterRule,
    pub matcher: Matcher,
}

pub enum Matcher {
    Host(Regex),
    Cidr(IpNet),
    All,
}

/// The destination a SOCKS client asked for, decoupled from `fast_socks5` types
/// so the matcher stays testable and the listener owns the protocol details.
#[derive(Debug, Clone)]
pub enum Target {
    Domain(String, u16),
    Ip(IpAddr, u16),
}

impl Target {
    pub fn port(&self) -> u16 {
        match self {
            Target::Domain(_, port) | Target::Ip(_, port) => *port,
        }
    }

    /// Text form used for host pattern matching. A literal-IP destination is
    /// matched as its own string, so a regex rule can target one.
    pub fn host_text(&self) -> String {
        match self {
            Target::Domain(host, _) => host.clone(),
            Target::Ip(ip, _) => ip.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MatchOutcome {
    /// `None` when no rule matched and the router's default action applied.
    pub rule_id: Option<Uuid>,
    pub action: RuleAction,
    pub target_tunnel_id: Option<Uuid>,
}

/// Rejects a pattern the matcher could never use, so a typo surfaces in the rule
/// editor instead of silently failing every connection later.
pub fn validate(input: &RouterRuleInput) -> Result<(), String> {
    match input.kind {
        RuleKind::All => {}
        RuleKind::HostWildcard => {
            if input.pattern.trim().is_empty() {
                return Err("wildcard pattern is empty".to_string());
            }
        }
        RuleKind::HostRegex => {
            Regex::new(&host_regex_source(&input.pattern))
                .map_err(|e| format!("invalid regex: {e}"))?;
        }
        RuleKind::IpCidr => {
            IpNet::from_str(input.pattern.trim())
                .map_err(|e| format!("invalid CIDR: {e}"))?;
        }
    }

    if input.action == RuleAction::Tunnel && input.target_tunnel_id.is_none() {
        return Err("a rule routing to a tunnel must name one".to_string());
    }
    Ok(())
}

pub fn compile(rule: RouterRule) -> Result<CompiledRule, String> {
    let matcher = match rule.kind {
        RuleKind::All => Matcher::All,
        RuleKind::HostWildcard => Matcher::Host(
            Regex::new(&wildcard_to_regex(&rule.pattern))
                .map_err(|e| format!("invalid wildcard: {e}"))?,
        ),
        RuleKind::HostRegex => Matcher::Host(
            Regex::new(&host_regex_source(&rule.pattern))
                .map_err(|e| format!("invalid regex: {e}"))?,
        ),
        RuleKind::IpCidr => Matcher::Cidr(
            IpNet::from_str(rule.pattern.trim()).map_err(|e| format!("invalid CIDR: {e}"))?,
        ),
    };
    Ok(CompiledRule { rule, matcher })
}

/// Compiles a whole list, dropping (and reporting) rules that no longer compile
/// rather than refusing to route at all — one bad row shouldn't take the router
/// down, but the user should hear about it.
pub fn compile_all(rules: Vec<RouterRule>) -> (Vec<CompiledRule>, Vec<String>) {
    let mut compiled = Vec::with_capacity(rules.len());
    let mut errors = Vec::new();
    for rule in rules {
        let label = format!("{} {}", rule.kind.as_str(), rule.pattern);
        match compile(rule) {
            Ok(c) => compiled.push(c),
            Err(e) => errors.push(format!("{label}: {e}")),
        }
    }
    compiled.sort_by_key(|c| c.rule.position);
    (compiled, errors)
}

/// Host regexes are matched case-insensitively and *unanchored*, so the common
/// `\.example\.com$` reads the way a user expects. Anchor explicitly with `^`/`$`.
fn host_regex_source(pattern: &str) -> String {
    format!("(?i){pattern}")
}

/// `*.example.com` deliberately also matches bare `example.com` — that is what
/// people mean by it, and matching SwitchyOmega here avoids a class of
/// "why didn't my rule fire" bugs. Other `*`/`?` wildcards are anchored literally.
fn wildcard_to_regex(pattern: &str) -> String {
    let pattern = pattern.trim();
    if let Some(rest) = pattern.strip_prefix("*.") {
        return format!("(?i)^(?:.*\\.)?{}$", regex::escape(rest));
    }

    let mut out = String::from("(?i)^");
    for ch in pattern.chars() {
        match ch {
            '*' => out.push_str(".*"),
            '?' => out.push('.'),
            _ => out.push_str(&regex::escape(&ch.to_string())),
        }
    }
    out.push('$');
    out
}

/// Walks the compiled rules in order and returns the first enabled match, or the
/// router's default action if nothing matches.
///
/// A CIDR rule tested against a hostname needs an address. When
/// `resolve_for_ip_rules` is on, the hostname is resolved locally *once* and the
/// result reused for every later CIDR rule in the same connection; when it is
/// off, CIDR rules simply never match hostname targets.
pub async fn match_target(
    rules: &[CompiledRule],
    target: &Target,
    default_action: RuleAction,
    default_tunnel_id: Option<Uuid>,
    resolve_for_ip_rules: bool,
) -> MatchOutcome {
    let host_text = target.host_text();
    let port = target.port();
    // `None` = not looked up yet, `Some(None)` = looked up and got nothing.
    let mut resolved: Option<Option<IpAddr>> = match target {
        Target::Ip(ip, _) => Some(Some(*ip)),
        Target::Domain(..) => None,
    };

    for compiled in rules {
        if !compiled.rule.enabled {
            continue;
        }
        if let Some(rule_port) = compiled.rule.port {
            if rule_port != port {
                continue;
            }
        }

        let hit = match &compiled.matcher {
            Matcher::All => true,
            Matcher::Host(re) => re.is_match(&host_text),
            Matcher::Cidr(net) => {
                if resolved.is_none() {
                    resolved = Some(if resolve_for_ip_rules {
                        resolve_first(&host_text, port).await
                    } else {
                        None
                    });
                }
                resolved
                    .flatten()
                    .is_some_and(|ip| net.contains(&ip))
            }
        };

        if hit {
            return MatchOutcome {
                rule_id: Some(compiled.rule.id),
                action: compiled.rule.action,
                target_tunnel_id: compiled.rule.target_tunnel_id,
            };
        }
    }

    MatchOutcome {
        rule_id: None,
        action: default_action,
        target_tunnel_id: default_tunnel_id,
    }
}

async fn resolve_first(host: &str, port: u16) -> Option<IpAddr> {
    tokio::net::lookup_host((host, port))
        .await
        .ok()?
        .next()
        .map(|addr| addr.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: RuleKind, pattern: &str, action: RuleAction) -> RouterRule {
        RouterRule {
            id: Uuid::new_v4(),
            position: 0,
            enabled: true,
            kind,
            pattern: pattern.to_string(),
            port: None,
            action,
            target_tunnel_id: None,
        }
    }

    async fn action_for(rules: Vec<RouterRule>, target: Target) -> RuleAction {
        let (compiled, errors) = compile_all(rules);
        assert!(errors.is_empty(), "{errors:?}");
        // Resolution off keeps the test hermetic — no DNS from the test suite.
        match_target(&compiled, &target, RuleAction::Direct, None, false)
            .await
            .action
    }

    #[test]
    fn wildcard_star_dot_matches_bare_domain_and_subdomains() {
        let re = Regex::new(&wildcard_to_regex("*.example.com")).unwrap();
        assert!(re.is_match("example.com"));
        assert!(re.is_match("api.example.com"));
        assert!(re.is_match("a.b.example.com"));
        assert!(re.is_match("EXAMPLE.COM"));
        assert!(!re.is_match("notexample.com"));
        assert!(!re.is_match("example.com.evil.net"));
    }

    #[test]
    fn wildcard_without_leading_star_dot_is_anchored() {
        let re = Regex::new(&wildcard_to_regex("db-*.internal")).unwrap();
        assert!(re.is_match("db-01.internal"));
        assert!(!re.is_match("x.db-01.internal"));
    }

    #[test]
    fn host_regex_is_unanchored_and_case_insensitive() {
        let re = Regex::new(&host_regex_source(r"\.corp\.net$")).unwrap();
        assert!(re.is_match("host.CORP.net"));
        assert!(!re.is_match("corp.net.example.com"));
    }

    #[tokio::test]
    async fn first_enabled_match_wins() {
        let mut first = rule(RuleKind::HostWildcard, "*.example.com", RuleAction::Block);
        first.position = 0;
        let mut second = rule(RuleKind::All, "", RuleAction::Direct);
        second.position = 1;

        let target = Target::Domain("api.example.com".into(), 443);
        assert_eq!(
            action_for(vec![first, second], target).await,
            RuleAction::Block
        );
    }

    #[tokio::test]
    async fn disabled_rules_are_skipped() {
        let mut disabled = rule(RuleKind::All, "", RuleAction::Block);
        disabled.enabled = false;
        let target = Target::Domain("example.com".into(), 443);
        assert_eq!(action_for(vec![disabled], target).await, RuleAction::Direct);
    }

    #[tokio::test]
    async fn port_constraint_filters() {
        let mut https_only = rule(RuleKind::All, "", RuleAction::Block);
        https_only.port = Some(443);

        assert_eq!(
            action_for(vec![https_only.clone()], Target::Domain("a.com".into(), 443)).await,
            RuleAction::Block
        );
        assert_eq!(
            action_for(vec![https_only], Target::Domain("a.com".into(), 80)).await,
            RuleAction::Direct
        );
    }

    #[tokio::test]
    async fn cidr_matches_literal_ip_target() {
        let r = rule(RuleKind::IpCidr, "10.0.0.0/8", RuleAction::Block);
        let inside: IpAddr = "10.1.2.3".parse().unwrap();
        let outside: IpAddr = "192.168.1.1".parse().unwrap();

        assert_eq!(
            action_for(vec![r.clone()], Target::Ip(inside, 22)).await,
            RuleAction::Block
        );
        assert_eq!(
            action_for(vec![r], Target::Ip(outside, 22)).await,
            RuleAction::Direct
        );
    }

    #[tokio::test]
    async fn cidr_never_matches_hostname_when_resolution_disabled() {
        let r = rule(RuleKind::IpCidr, "0.0.0.0/0", RuleAction::Block);
        assert_eq!(
            action_for(vec![r], Target::Domain("example.com".into(), 443)).await,
            RuleAction::Direct
        );
    }

    #[test]
    fn validation_rejects_bad_patterns_and_targetless_tunnel_rules() {
        let bad_regex = RouterRuleInput {
            enabled: true,
            kind: RuleKind::HostRegex,
            pattern: "(unclosed".into(),
            port: None,
            action: RuleAction::Direct,
            target_tunnel_id: None,
        };
        assert!(validate(&bad_regex).is_err());

        let bad_cidr = RouterRuleInput {
            kind: RuleKind::IpCidr,
            pattern: "10.0.0.0/99".into(),
            ..bad_regex.clone()
        };
        assert!(validate(&bad_cidr).is_err());

        let targetless = RouterRuleInput {
            kind: RuleKind::All,
            pattern: String::new(),
            action: RuleAction::Tunnel,
            ..bad_regex.clone()
        };
        assert!(validate(&targetless).is_err());

        let ok = RouterRuleInput {
            kind: RuleKind::HostWildcard,
            pattern: "*.example.com".into(),
            ..bad_regex
        };
        assert!(validate(&ok).is_ok());
    }
}
