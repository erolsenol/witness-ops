import { describe, expect, it } from "vitest";
import { resolveProbeTarget } from "../src/probes/target.js";

describe("HTTP probe target validation", () => {
  it.each([
    ["127.0.0.1", "IPv4 loopback"],
    ["10.20.30.40", "RFC1918 IPv4"],
    ["169.254.169.254", "link-local metadata IPv4"],
    ["100.64.0.1", "shared address space IPv4"],
    ["192.0.2.4", "documentation IPv4"],
    ["224.0.0.1", "multicast IPv4"],
    ["::1", "IPv6 loopback"],
    ["fc00::1", "IPv6 unique-local"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["2001:db8::1", "IPv6 documentation"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
  ])("rejects %s (%s)", async (address) => {
    await expect(
      resolveProbeTarget(
        new URL(
          `https://${address.includes(":") ? `[${address}]` : address}/health`,
        ),
      ),
    ).rejects.toMatchObject({ code: "HTTP_URL_UNSAFE" });
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])(
    "accepts public address %s",
    async (address) => {
      const target = await resolveProbeTarget(
        new URL(
          `https://${address.includes(":") ? `[${address}]` : address}/health`,
        ),
      );
      expect(target[0]?.address).toBe(address);
    },
  );

  it("rejects a hostname when one of its DNS answers is non-public", async () => {
    await expect(
      resolveProbeTarget(
        new URL("https://app.example.test/health"),
        false,
        async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "192.168.1.4", family: 4 },
        ],
      ),
    ).rejects.toMatchObject({ code: "HTTP_URL_UNSAFE" });
  });

  it("allows localhost HTTP only with explicit opt-in and loopback resolution", async () => {
    const target = await resolveProbeTarget(
      new URL("http://localhost/health"),
      true,
      async () => [{ address: "127.0.0.1", family: 4 }],
    );
    expect(target[0]?.address).toBe("127.0.0.1");
    await expect(
      resolveProbeTarget(new URL("http://localhost/health"), true, async () => [
        { address: "93.184.216.34", family: 4 },
      ]),
    ).rejects.toMatchObject({ code: "HTTP_URL_UNSAFE" });
  });

  it("bounds hostname resolution time", async () => {
    await expect(
      resolveProbeTarget(
        new URL("https://app.example.test/health"),
        false,
        () => new Promise(() => {}),
        5,
      ),
    ).rejects.toMatchObject({ code: "HTTP_DNS_LOOKUP_FAILED" });
  });
});
