import { describe, expect, test } from "bun:test";
import { isBedrockActive, parseEstablishedCount, shouldPowerOff, shouldStayAwake } from "./idle_shutdown";

describe("parseEstablishedCount", () => {
  test("empty output has no connections", () => {
    expect(parseEstablishedCount("")).toBe(0);
  });

  // Real sample captured live via `ss -tn state established '( sport = :22 )'` on
  // mc-home, 2026-07-22. `ss` suppresses the State column entirely when filtering by
  // a single state, so there is no "ESTAB" text anywhere in this output, the exact
  // reason the original `.includes("ESTAB")` check always returned 0.
  test("counts a single real connection row", () => {
    const output = [
      "Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process",
      "0      0      192.168.31.145:22   192.168.31.212:32846",
    ].join("\n");
    expect(parseEstablishedCount(output)).toBe(1);
  });

  test("counts multiple connection rows", () => {
    const output = [
      "Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process",
      "0      0      192.168.31.145:25565   203.0.113.5:51234",
      "0      0      192.168.31.145:25565   203.0.113.6:51235",
    ].join("\n");
    expect(parseEstablishedCount(output)).toBe(2);
  });

  test("header-only output (no connections) counts zero", () => {
    const output = "Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process";
    expect(parseEstablishedCount(output)).toBe(0);
  });

  test("garbage input does not throw", () => {
    // parseEstablishedCount trusts ss's structure (line 1 is always the header when
    // filtering to a single state), not the content of each row, that's the actual
    // fix: counting non-blank rows instead of matching text ss never guarantees. So
    // multi-line garbage legitimately counts every line past the first, by design,
    // this only asserts the robustness property (no throw), not a specific count.
    expect(() => parseEstablishedCount("not ss output at all\n***\nmore garbage")).not.toThrow();
    // Single-line garbage has nothing left after the header is dropped.
    expect(parseEstablishedCount("just one garbage line")).toBe(0);
  });

  test("trailing blank line from a trailing newline is not counted as a connection", () => {
    const output = [
      "Recv-Q Send-Q  Local Address:Port   Peer Address:Port Process",
      "0      0      192.168.31.145:25565   203.0.113.5:51234",
      "",
    ].join("\n");
    expect(parseEstablishedCount(output)).toBe(1);
  });
});

describe("isBedrockActive", () => {
  test("recent activity within max age is active", () => {
    expect(isBedrockActive(1000, 950, 60)).toBe(true);
  });

  test("activity exactly at max age is active", () => {
    expect(isBedrockActive(1000, 940, 60)).toBe(true);
  });

  test("activity older than max age is not active", () => {
    expect(isBedrockActive(1000, 900, 60)).toBe(false);
  });
});

describe("shouldStayAwake", () => {
  test("no TCP connections and no Bedrock activity is idle", () => {
    expect(shouldStayAwake(0, false)).toBe(false);
  });

  test("at least one TCP connection is active", () => {
    expect(shouldStayAwake(1, false)).toBe(true);
  });

  test("Bedrock activity alone is active", () => {
    expect(shouldStayAwake(0, true)).toBe(true);
  });

  test("a failed ss check (null) is treated as active, not idle (2026-07-22 regression)", () => {
    expect(shouldStayAwake(null, false)).toBe(true);
  });
});

describe("shouldPowerOff", () => {
  test("elapsed time just under the limit does not power off", () => {
    expect(shouldPowerOff(299, 300)).toBe(false);
  });

  test("elapsed time exactly at the limit powers off", () => {
    expect(shouldPowerOff(300, 300)).toBe(true);
  });

  test("elapsed time well over the limit powers off", () => {
    expect(shouldPowerOff(600, 300)).toBe(true);
  });
});
