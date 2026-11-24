import "server-only";
import { isIP } from "node:net";

// Ordinary public unicast destinations only. Keep special-purpose ranges
// conservative, but match their actual prefix lengths instead of whole /16s.
const blockedIPv4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8: this network
  [0x0a000000, 8], // 10.0.0.0/8: private
  [0x64400000, 10], // 100.64.0.0/10: shared address space
  [0x7f000000, 8], // 127.0.0.0/8: loopback
  [0xa9fe0000, 16], // 169.254.0.0/16: link-local
  [0xac100000, 12], // 172.16.0.0/12: private
  [0xc0000000, 24], // 192.0.0.0/24: protocol assignments (conservative)
  [0xc0000200, 24], // 192.0.2.0/24: documentation
  [0xc0586300, 24], // 192.88.99.0/24: deprecated 6to4 relay
  [0xc0a80000, 16], // 192.168.0.0/16: private
  [0xc6120000, 15], // 198.18.0.0/15: benchmarking, including common Fake-IP pools
  [0xc6336400, 24], // 198.51.100.0/24: documentation
  [0xcb007100, 24], // 203.0.113.0/24: documentation
  [0xe0000000, 4], // 224.0.0.0/4: multicast
  [0xf0000000, 4], // 240.0.0.0/4: reserved, including limited broadcast
];

export function publicIP(ip: string): boolean {
  if (isIP(ip) === 4) {
    const value = ip.split(".").reduce((result, part) => result * 256 + Number(part), 0);
    return !blockedIPv4.some(([network, prefix]) => {
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      return ((value & mask) >>> 0) === network;
    });
  }
  if (isIP(ip) !== 6) return false;

  // Numeric prefixes handle compression and leading zeroes consistently.
  // Preserve the existing policy: native global unicast only, excluding
  // special assignments, documentation, and 6to4 IPv4-encoding destinations.
  const [left, right = ""] = ip.toLowerCase().split("::");
  const start = left ? left.split(":") : [];
  const end = right ? right.split(":") : [];
  const parts = ip.includes("::")
    ? [...start, ...Array(8 - start.length - end.length).fill("0"), ...end]
    : start;
  const first = parseInt(parts[0], 16);
  const second = parseInt(parts[1], 16);
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && first !== 0x2002
    && !(first === 0x3fff && second < 0x1000);
}
