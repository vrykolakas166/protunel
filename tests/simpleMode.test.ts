import { describe, expect, test } from "bun:test";
import { classifyError, routedTunnels } from "../src/simpleMode";
import type { RouterConfig, RouterRule, Tunnel } from "../src/types";

describe("classifyError", () => {
  test.each([
    ["password authentication failed: simulated", "auth"],
    ["authentication failed", "auth"],
    ["no password stored for this tunnel", "auth"],
    ["Unknown server key", "hostKey"],
    ["failed to connect to 10.0.0.1:22: Connection timed out (os error 110)", "unreachable"],
    ["Connection refused (os error 111)", "unreachable"],
    ["failed to lookup address information: Name or service not known", "unreachable"],
    ["something else entirely", "other"],
  ])("%s → %s", (message, expected) => expect(classifyError(message)).toBe(expected));
});

const tunnel = (id: string, jumpTunnelId: string | null = null): Tunnel => ({
  id,
  name: id,
  host: `${id}.example`,
  port: 22,
  username: "u",
  auth: { type: "password" } as Tunnel["auth"],
  localSocksPort: 1080,
  autoConnect: false,
  forwards: [],
  jumpTunnelId,
  socksEnabled: true,
});

const rule = (target: string, enabled = true): RouterRule => ({
  id: `r-${target}`,
  position: 0,
  enabled,
  kind: "domain" as RouterRule["kind"],
  pattern: "*.internal",
  port: null,
  action: "tunnel",
  targetTunnelId: target,
});

const config = (defaultTunnelId: string | null): RouterConfig => ({
  enabled: true,
  port: 1090,
  defaultAction: defaultTunnelId ? "tunnel" : "direct",
  defaultTunnelId,
  setSystemProxy: true,
  bypassList: "",
  resolveForIpRules: false,
});

describe("routedTunnels", () => {
  const all = [tunnel("bastion"), tunnel("app", "bastion"), tunnel("db"), tunnel("shell")];

  test("no tunnel rules: everything", () => expect(routedTunnels(all, [], config(null))).toEqual(all));
  test("rule targets plus the hop they jump through, in list order", () =>
    expect(routedTunnels(all, [rule("app")], config(null)).map((t) => t.id)).toEqual(["bastion", "app"]));
  test("default tunnel counts; disabled rules don't", () =>
    expect(routedTunnels(all, [rule("shell", false)], config("db")).map((t) => t.id)).toEqual(["db"]));
  test("a jump cycle terminates", () => {
    const cyclic = [tunnel("a", "b"), tunnel("b", "a")];
    expect(routedTunnels(cyclic, [rule("a")], config(null)).map((t) => t.id)).toEqual(["a", "b"]);
  });
});

import { plainSshError } from "../src/simpleMode";

describe("plainSshError", () => {
  test("sign-in and unreachable errors get plain words", () => {
    expect(plainSshError("Authentication failed: invalid password")).toContain("Sign-in failed");
    expect(plainSshError("Connection refused (os error 111)")).toContain("Can't reach the server");
  });
  test("anything else is left to the raw text", () => {
    expect(plainSshError("channel closed")).toBeNull();
  });
});
