import { describe, expect, it } from 'vitest';

import { EgressPolicyError } from './errors.js';
import { buildNetworkPolicy } from './cidr.js';

describe('buildNetworkPolicy', () => {
  it('returns undefined when neither argument is set', () => {
    expect(buildNetworkPolicy(false, undefined)).toBeUndefined();
    expect(buildNetworkPolicy(undefined, undefined)).toBeUndefined();
  });

  it('rejects block_network combined with an allowlist', () => {
    expect(() => buildNetworkPolicy(true, ['10.0.0.1'])).toThrow(EgressPolicyError);
  });

  it('blocks everything when only block_network is set', () => {
    expect(buildNetworkPolicy(true, undefined)).toEqual({ egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL' } });
  });

  it('normalizes bare IPv4 to /32 and clears host bits on CIDRs', () => {
    expect(buildNetworkPolicy(false, ['10.0.0.7', '10.0.0.1/8'])).toEqual({
      egress: {
        mode: 'EGRESS_POLICY_MODE_DENY_ALL',
        allow_list: [
          { cidr: '10.0.0.7/32' },
          { cidr: '10.0.0.0/8' },
        ],
      },
    });
  });

  it('normalizes bare IPv6 to /128 and compresses zero runs', () => {
    expect(buildNetworkPolicy(false, ['2001:db8::1', 'fe80::/10'])).toEqual({
      egress: {
        mode: 'EGRESS_POLICY_MODE_DENY_ALL',
        allow_list: [
          { cidr: '2001:db8::1/128' },
          { cidr: 'fe80::/10' },
        ],
      },
    });
  });

  it('maps embedded IPv4 in IPv6 to the combined notation', () => {
    expect(buildNetworkPolicy(false, ['::ffff:1.2.3.4'])).toMatchObject({
      egress: { allow_list: [{ cidr: '::ffff:102:304/128' }] },
    });
  });

  it('rejects invalid entries with a typed error', () => {
    expect(() => buildNetworkPolicy(false, ['not-an-ip'])).toThrow(EgressPolicyError);
    expect(() => buildNetworkPolicy(false, ['10.0.0.1/33'])).toThrow(EgressPolicyError);
    expect(() => buildNetworkPolicy(false, ['fe80::1%eth0'])).toThrow(EgressPolicyError);
    expect(() => buildNetworkPolicy(false, ['   '])).toThrow(/Invalid outbound_allowlist entry/);
  });

  it('treats an empty allowlist as deny-all', () => {
    expect(buildNetworkPolicy(false, [])).toEqual({ egress: { mode: 'EGRESS_POLICY_MODE_DENY_ALL', allow_list: [] } });
  });
});
