import { describe, expect, test } from "bun:test";
import { allocatePorts, parseHostRange, rangeName } from "../src/hostRange";

describe("parseHostRange", () => {
  test("full range", () => {
    const r = parseHostRange("10.1.1.1-10.1.1.10");
    expect(r.kind === "range" && [r.hosts.length, r.hosts[0], r.hosts[9]]).toEqual([10, "10.1.1.1", "10.1.1.10"]);
  });
  test("short form varies the last octet", () => {
    const r = parseHostRange(" 10.1.1.1 - 10 ");
    expect(r.kind === "range" && r.hosts.at(-1)).toBe("10.1.1.10");
  });
  test("crosses an octet boundary", () => {
    const r = parseHostRange("10.1.1.254-10.1.2.1");
    expect(r.kind === "range" && r.hosts).toEqual(["10.1.1.254", "10.1.1.255", "10.1.2.0", "10.1.2.1"]);
  });
  test.each(["10.1.1.1", "server.example", "10.1.1.1-300", "a-b"])("%s is a single host", (h) =>
    expect(parseHostRange(h).kind).toBe("single"),
  );
  test("reversed range is an error", () =>
    expect(parseHostRange("10.1.1.9-3")).toEqual({ kind: "error", reason: "order" }));
  test("over 256 addresses is an error", () =>
    expect(parseHostRange("10.0.0.1-10.0.2.1")).toMatchObject({ kind: "error", reason: "tooMany" }));
});

test("allocatePorts skips used ports", () =>
  expect(allocatePorts(1080, 4, new Set([1081, 1083]))).toEqual([1080, 1082, 1084, 1085]));

test("rangeName", () => {
  expect(rangeName("web-{ip}", "10.0.0.1")).toBe("web-10.0.0.1");
  expect(rangeName("db", "10.0.0.1")).toBe("db 10.0.0.1");
});
