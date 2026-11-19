import type { RouterConfig, RouterRule, Tunnel } from "./types";

/**
 * What went wrong with a tunnel, in terms Simple mode can say to someone who
 * did not set it up: the fix is either theirs (network/VPN) or the administrator's.
 */
export type SimpleProblem = "auth" | "unreachable" | "hostKey" | "other";

/** Error texts come from `ssh/mod.rs` and russh/std IO; see `is_fatal`. */
export function classifyError(message: string): SimpleProblem {
  const text = message.toLowerCase();
  if (text.includes("unknown server key") || text.includes("wrong server signature")) return "hostKey";
  if (
    text.includes("authentication failed") ||
    text.includes("no password stored") ||
    text.includes("failed to load private key") ||
    text.includes("ssh-agent")
  ) {
    return "auth";
  }
  if (
    /timed out|refused|unreachable|no route|failed to lookup|dns|name or service not known|network is down|failed to connect|connection reset|os error/.test(
      text,
    )
  ) {
    return "unreachable";
  }
  return "other";
}

/**
 * The tunnels Simple mode lists: the ones the router sends traffic through,
 * plus the hops they jump through. With no tunnel rules at all, every tunnel
 * (there is nothing better to go on).
 */
export function routedTunnels(tunnels: Tunnel[], rules: RouterRule[], config: RouterConfig | null): Tunnel[] {
  const targets = new Set<string>();
  for (const rule of rules) {
    if (rule.enabled && rule.action === "tunnel" && rule.targetTunnelId) targets.add(rule.targetTunnelId);
  }
  if (config?.defaultAction === "tunnel" && config.defaultTunnelId) targets.add(config.defaultTunnelId);
  if (targets.size === 0) return tunnels;

  const byId = new Map(tunnels.map((tun) => [tun.id, tun]));
  const shown = new Set<string>();
  for (const id of targets) {
    let current = byId.get(id);
    // Bounded by the list length, so a jump cycle in bad data can't spin.
    for (let hops = 0; current && hops <= tunnels.length && !shown.has(current.id); hops++) {
      shown.add(current.id);
      current = current.jumpTunnelId ? byId.get(current.jumpTunnelId) : undefined;
    }
  }
  return tunnels.filter((tun) => shown.has(tun.id));
}
