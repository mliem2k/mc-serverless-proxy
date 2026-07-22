import { describe, expect, test } from "bun:test";
import { parseConnections, shouldTriggerWake } from "./catcher_wake_watcher";

describe("parseConnections", () => {
  test("empty output has no connections", () => {
    expect(parseConnections("")).toEqual([]);
  });

  // ss suppresses the State column entirely when filtering to a single state (real
  // sample captured live for the sibling relay/idle_shutdown.test.ts, 2026-07-22;
  // that fix's own comment calls out that catcher_wake_watcher.ts's parseConnections
  // already relies on this same header-only-slice behavior). So there is no "ESTAB"
  // column in real `ss -tin state established (...)` output: the summary line is
  // Recv-Q Send-Q Local-Address:Port Peer-Address:Port, and fields[3] (Peer) is
  // correct as-is in the implementation.
  test("parses a single connection's summary + info line", () => {
    const output = [
      "Recv-Q Send-Q   Local Address:Port     Peer Address:Port",
      "0      0        10.138.0.3:25565       203.0.113.9:52341",
      "\t cubic wscale:7,7 rto:204 rtt:1.5/0.75 bytes_acked:20480 bytes_received:512",
    ].join("\n");
    expect(parseConnections(output)).toEqual([{ conn: "203.0.113.9:52341", totalBytes: 20992 }]);
  });

  test("parses multiple connections independently", () => {
    const output = [
      "Recv-Q Send-Q   Local Address:Port     Peer Address:Port",
      "0      0        10.138.0.3:25565       203.0.113.9:52341",
      "\t bytes_acked:1000 bytes_received:200",
      "0      0        10.138.0.3:25565       203.0.113.10:52342",
      "\t bytes_acked:5000 bytes_received:100",
    ].join("\n");
    expect(parseConnections(output)).toEqual([
      { conn: "203.0.113.9:52341", totalBytes: 1200 },
      { conn: "203.0.113.10:52342", totalBytes: 5100 },
    ]);
  });

  test("ss's own header line is never miscounted as a connection (2026-07-17 regression)", () => {
    // The header line starts with a non-space character just like a real summary
    // line. Without dropping it (lines.slice(1) in the implementation), a
    // single-connection output like this would be misread as two connections.
    const output = [
      "Recv-Q Send-Q   Local Address:Port     Peer Address:Port",
      "0      0        10.138.0.3:25565       203.0.113.9:52341",
      "\t bytes_acked:1000 bytes_received:200",
    ].join("\n");
    expect(parseConnections(output)).toHaveLength(1);
  });

  test("missing byte counters default to zero", () => {
    const output = [
      "Recv-Q Send-Q   Local Address:Port     Peer Address:Port",
      "0      0        10.138.0.3:25565       203.0.113.9:52341",
      "\t bytes_acked:1000",
    ].join("\n");
    expect(parseConnections(output)).toEqual([{ conn: "203.0.113.9:52341", totalBytes: 1000 }]);
  });
});

describe("shouldTriggerWake", () => {
  const CONFIRM_COUNT = 2;
  const MIN_ACTIVITY_BYTES = 16384;

  test("streak below confirmCount never triggers, regardless of bytes", () => {
    expect(shouldTriggerWake(1, 999999, CONFIRM_COUNT, MIN_ACTIVITY_BYTES)).toBe(false);
  });

  test("streak at confirmCount but bytes under threshold is treated as noise", () => {
    expect(shouldTriggerWake(2, 100, CONFIRM_COUNT, MIN_ACTIVITY_BYTES)).toBe(false);
  });

  test("streak at confirmCount and bytes at threshold triggers", () => {
    expect(shouldTriggerWake(2, MIN_ACTIVITY_BYTES, CONFIRM_COUNT, MIN_ACTIVITY_BYTES)).toBe(true);
  });

  test("streak above confirmCount and bytes above threshold triggers", () => {
    expect(shouldTriggerWake(5, 700_000, CONFIRM_COUNT, MIN_ACTIVITY_BYTES)).toBe(true);
  });
});
