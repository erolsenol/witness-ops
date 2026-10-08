import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ProbeTargetError extends Error {
  constructor(readonly code: "HTTP_URL_UNSAFE" | "HTTP_DNS_LOOKUP_FAILED") {
    super(code);
    this.name = "ProbeTargetError";
  }
}

export type ProbeLookup = (
  hostname: string,
) => Promise<readonly LookupAddress[]>;

const resolveDns: ProbeLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

async function resolveWithTimeout(
  hostname: string,
  lookup: ProbeLookup,
  timeoutMs: number,
): Promise<readonly LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProbeTargetError("HTTP_DNS_LOOKUP_FAILED")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function inIpv4Cidr(address: string, network: string, prefix: number): boolean {
  const valueParts = address.split(".").map(Number);
  const networkParts = network.split(".").map(Number);
  if (valueParts.length !== 4 || networkParts.length !== 4) return false;
  const value = valueParts.reduce(
    (result, part) => (result << 8n) | BigInt(part),
    0n,
  );
  const base = networkParts.reduce(
    (result, part) => (result << 8n) | BigInt(part),
    0n,
  );
  const mask = (0xffff_ffffn << BigInt(32 - prefix)) & 0xffff_ffffn;
  return (value & mask) === (base & mask);
}

const NON_PUBLIC_IPV4_RANGES: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function isPublicIpv4(address: string): boolean {
  return (
    isIP(address) === 4 &&
    !NON_PUBLIC_IPV4_RANGES.some(([network, prefix]) =>
      inIpv4Cidr(address, network, prefix),
    )
  );
}

function ipv6Bytes(address: string): readonly number[] | undefined {
  let normalized = address.toLowerCase();
  if (normalized.includes("%")) return undefined;
  const lastColon = normalized.lastIndexOf(":");
  const possibleIpv4 = normalized.slice(lastColon + 1);
  if (possibleIpv4.includes(".")) {
    if (!isPublicIpv4(possibleIpv4)) return undefined;
    const octets = possibleIpv4.split(".").map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = `${normalized.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const sections = normalized.split("::");
  if (sections.length > 2) return undefined;
  const left = sections[0] ? sections[0].split(":") : [];
  const right =
    sections.length === 2 && sections[1] ? sections[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (
    (sections.length === 1 && missing !== 0) ||
    (sections.length === 2 && missing < 1)
  )
    return undefined;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))
  )
    return undefined;
  return groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function inIpv6Cidr(
  address: readonly number[],
  network: readonly number[],
  prefix: number,
): boolean {
  const wholeBytes = Math.floor(prefix / 8);
  const remainingBits = prefix % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (
    ((address[wholeBytes] ?? 0) & mask) === ((network[wholeBytes] ?? 0) & mask)
  );
}

function bytesFor(address: string): readonly number[] | undefined {
  return ipv6Bytes(address);
}

function isPublicIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const bytes = bytesFor(address);
  if (!bytes) return false;
  const globalUnicast = [0x20, 0x00, ...Array.from({ length: 14 }, () => 0)];
  const documentation = [
    0x20,
    0x01,
    0x0d,
    0xb8,
    ...Array.from({ length: 12 }, () => 0),
  ];
  const teredo = [0x20, 0x01, 0x00, ...Array.from({ length: 13 }, () => 0)];
  const sixToFour = [0x20, 0x02, ...Array.from({ length: 14 }, () => 0)];
  const documentationV2 = [0x3f, 0xff, ...Array.from({ length: 14 }, () => 0)];
  return (
    inIpv6Cidr(bytes, globalUnicast, 3) &&
    !inIpv6Cidr(bytes, documentation, 32) &&
    !inIpv6Cidr(bytes, teredo, 23) &&
    !inIpv6Cidr(bytes, sixToFour, 16) &&
    !inIpv6Cidr(bytes, documentationV2, 20)
  );
}

function isPublicAddress(address: string): boolean {
  return isPublicIpv4(address) || isPublicIpv6(address);
}

function localAddressAllowed(url: URL, address: string): boolean {
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const localhostName =
    hostname === "localhost" || hostname.endsWith(".localhost");
  const loopbackIp =
    (isIP(address) === 4 && inIpv4Cidr(address, "127.0.0.0", 8)) ||
    address.toLowerCase() === "::1";
  return localhostName && loopbackIp;
}

export async function resolveProbeTarget(
  url: URL,
  allowLocalHttp = false,
  lookup: ProbeLookup = resolveDns,
  timeoutMs = 5_000,
): Promise<readonly LookupAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  let addresses: readonly LookupAddress[];
  if (family !== 0) {
    addresses = [{ address: hostname, family }];
  } else {
    try {
      addresses = await resolveWithTimeout(hostname, lookup, timeoutMs);
    } catch {
      throw new ProbeTargetError("HTTP_DNS_LOOKUP_FAILED");
    }
  }

  if (addresses.length === 0)
    throw new ProbeTargetError("HTTP_DNS_LOOKUP_FAILED");
  if (
    url.protocol === "http:" &&
    (!allowLocalHttp ||
      addresses.some(({ address }) => !localAddressAllowed(url, address)))
  ) {
    throw new ProbeTargetError("HTTP_URL_UNSAFE");
  }
  if (
    addresses.some(
      ({ address }) =>
        !isPublicAddress(address) &&
        !(allowLocalHttp && localAddressAllowed(url, address)),
    )
  ) {
    throw new ProbeTargetError("HTTP_URL_UNSAFE");
  }
  return addresses;
}
