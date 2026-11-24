import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicIP } from '../lib/server/ai/ip';

test('public IPv4 neighbors are not rejected by overbroad documentation or protocol ranges', () => {
  for (const ip of [
    '192.0.1.0', '192.0.1.255', '192.0.3.0', '192.0.255.255',
    '192.2.0.0', '192.2.255.255',
    '198.51.99.255', '198.51.101.0', '198.51.255.255',
    '203.0.112.255', '203.0.114.0', '203.0.255.255',
  ]) assert.equal(publicIP(ip), true, ip);
});

test('documentation and protocol assignment ranges remain blocked at both boundaries', () => {
  for (const ip of [
    '192.0.0.0', '192.0.0.255', '192.0.2.0', '192.0.2.255',
    '192.88.99.0', '192.88.99.255',
    '198.51.100.0', '198.51.100.255', '203.0.113.0', '203.0.113.255',
  ]) assert.equal(publicIP(ip), false, ip);
});

test('both benchmarking /16s remain blocked, without rejecting neighboring public ranges', () => {
  for (const ip of ['198.18.0.0', '198.18.0.1', '198.18.255.255', '198.19.0.0', '198.19.255.255']) {
    assert.equal(publicIP(ip), false, ip);
  }
  for (const ip of ['198.17.255.255', '198.20.0.0']) assert.equal(publicIP(ip), true, ip);
});

test('private, loopback, link-local, shared, multicast and reserved IPv4 addresses stay blocked', () => {
  for (const ip of [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.127.255.255', '127.0.0.0', '127.255.255.255',
    '169.254.0.0', '169.254.255.255', '172.16.0.0', '172.31.255.255',
    '192.168.0.0', '192.168.255.255', '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255',
  ]) assert.equal(publicIP(ip), false, ip);
  for (const ip of [
    '1.1.1.1', '8.8.8.8', '100.63.255.255', '100.128.0.0',
    '169.253.255.255', '169.255.0.0', '172.15.255.255', '172.32.0.0',
    '192.167.255.255', '192.169.0.0', '223.255.255.255',
  ]) assert.equal(publicIP(ip), true, ip);
});

test('invalid or ambiguous IP notation cannot bypass classification', () => {
  for (const ip of ['', 'api.openai.com', '127.1', '2130706433', '0x7f000001', '127.000.000.001', '256.1.1.1', '[::1]', '::gggg']) {
    assert.equal(publicIP(ip), false, ip);
  }
});

test('IPv6 policy preserves special-use blocks regardless of compression and leading zeroes', () => {
  for (const ip of [
    '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fdff::1', 'fe80::1', 'ff02::1',
    '2001::1', '2001:0000::1', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff',
    '2001:db8::1', '2001:0DB8::1', '2002:7f00:1::1', '2002:0808:0808::1',
    '3fff::1', '3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff', '4000::1',
  ]) assert.equal(publicIP(ip), false, ip);
  for (const ip of ['2001:200::1', '2001:4860:4860::8888', '2606:4700:4700::1111', '2a00:1450:4001::200e', '3fff:1000::1']) {
    assert.equal(publicIP(ip), true, ip);
  }
});
