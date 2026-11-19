import type { Tunnel } from "./types";

/** Matches MAX_BULK_TUNNELS in commands.rs. */
export const MAX_RANGE_HOSTS = 256;

export type HostRange =
  | { kind: "single" }
  | { kind: "range"; hosts: string[] }
  | { kind: "error"; reason: "order" | "tooMany"; count?: number };

function parseIpv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/**
 * Reads the host field as an IPv4 range: `10.1.1.1-10.1.1.10`, or the short
 * form `10.1.1.1-10` that varies only the last octet. Anything else (a plain
 * address, a hostname) is a single host, so the field keeps working as before.
 */
export function parseHostRange(text: string): HostRange {
  const match = /^\s*([\d.]+)\s*-\s*([\d.]+)\s*$/.exec(text);
  if (!match) return { kind: "single" };
  const start = parseIpv4(match[1]);
  if (start === null) return { kind: "single" };
  let end: number | null;
  if (/^\d{1,3}$/.test(match[2])) {
    const last = Number(match[2]);
    end = last > 255 ? null : start - (start % 256) + last;
  } else {
    end = parseIpv4(match[2]);
  }
  if (end === null) return { kind: "single" };
  if (end < start) return { kind: "error", reason: "order" };
  const count = end - start + 1;
  if (count > MAX_RANGE_HOSTS) return { kind: "error", reason: "tooMany", count };
  const hosts: string[] = [];
  for (let value = start; value <= end; value++) hosts.push(formatIpv4(value));
  return { kind: "range", hosts };
}

/** Local ports already taken by a tunnel's SOCKS listener or a forward. */
export function usedLocalPorts(tunnels: Tunnel[]): Set<number> {
  const used = new Set<number>();
  for (const tunnel of tunnels) {
    if (tunnel.socksEnabled) used.add(tunnel.localSocksPort);
    for (const forward of tunnel.forwards) used.add(forward.localPort);
  }
  return used;
}

/** `count` distinct free ports, counting up from `start`. */
export function allocatePorts(start: number, count: number, used: Set<number>): number[] {
  const ports: number[] = [];
  for (let port = start; ports.length < count && port <= 65535; port++) {
    if (!used.has(port)) ports.push(port);
  }
  return ports;
}

/**
 * Name for one tunnel of a range. `{ip}` in the typed name is replaced by the
 * address; without it the address is appended, so names stay unique.
 */
export function rangeName(template: string, host: string): string {
  const name = template.trim();
  if (name.includes("{ip}")) return name.split("{ip}").join(host);
  return name ? `${name} ${host}` : host;
}
