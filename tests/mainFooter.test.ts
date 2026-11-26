import { describe, expect, test } from "bun:test";
import { totalRate } from "../src/components/MainFooter";

describe("status bar traffic", () => {
  test("sums the last tick of connected tunnels only", () => {
    const statuses = {
      a: { status: "connected" as const, message: null },
      b: { status: "connected" as const, message: null },
      c: { status: "disconnected" as const, message: null },
    };
    const throughput = {
      a: { up: [5, 10], down: [100, 200] },
      b: { up: [], down: [7] },
      c: { up: [999], down: [999] },
    };
    expect(totalRate(statuses, throughput)).toEqual({ up: 10, down: 207 });
    expect(totalRate({}, throughput)).toEqual({ up: 0, down: 0 });
  });
});
