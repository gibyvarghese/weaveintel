import { describe, expect, it } from 'vitest';
import { classifyAddress, isPublicAddress } from './net-address.js';

describe('strict address classification', () => {
  it('passes only public unicast addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111', '[2a00:1450:4001::200e]']) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it('blocks every private, special and tunnelled form', () => {
    const cases: Record<string, string> = {
      '127.0.0.1': 'loopback', '0.0.0.0': 'unspecified', '0.1.2.3': 'unspecified', '10.1.2.3': 'private', '172.31.255.1': 'private',
      '192.168.1.1': 'private', '169.254.169.254': 'link_local', '100.64.0.1': 'cgnat', '198.18.0.1': 'reserved', '224.0.0.1': 'multicast',
      '255.255.255.255': 'reserved', '192.0.2.1': 'documentation', '::1': 'loopback', '[::1]': 'loopback', '::': 'unspecified',
      'fd00::1': 'private', 'fe80::1': 'link_local', 'ff02::1': 'multicast', '2001:db8::1': 'documentation',
      '::ffff:127.0.0.1': 'loopback', '::ffff:7f00:1': 'loopback', '::ffff:a9fe:a9fe': 'link_local', '::127.0.0.1': 'loopback',
      '64:ff9b::a9fe:a9fe': 'link_local', '64:ff9b::7f00:1': 'loopback', '2002:7f00:1::': 'reserved', '2001:0:4136:e378::1': 'reserved',
      'localhost': 'invalid', '1.2.3': 'invalid',
    };
    for (const [ip, cls] of Object.entries(cases)) expect(classifyAddress(ip), ip).toBe(cls);
  });
});
