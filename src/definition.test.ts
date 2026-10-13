import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConfigFiles,
  buildDefinition,
  buildEnvVars,
  DEFAULT_CONFIG_FILE_PERMISSIONS,
  renderEnvValue,
} from './definition.js';

describe('renderEnvValue', () => {
  it('passes strings through verbatim for server-side interpolation', () => {
    expect(renderEnvValue('literal')).toBe('literal');
    expect(renderEnvValue('{{ user.name }}')).toBe('{{ user.name }}');
  });

  it('renders secret references as interpolation tokens', () => {
    expect(renderEnvValue({ name: 'my-secret' })).toBe('{{ secret.my-secret }}');
  });

  it('reads the name field of a full secret object', () => {
    expect(renderEnvValue({ name: 'full' } as never)).toBe('{{ secret.full }}');
  });
});

describe('buildEnvVars', () => {
  it('maps a record to deployment env entries', () => {
    expect(buildEnvVars({ A: 'a', B: { name: 'b' } })).toEqual([
      { key: 'A', value: 'a' },
      { key: 'B', value: '{{ secret.b }}' },
    ]);
  });

  it('returns an empty list for no env', () => {
    expect(buildEnvVars(undefined)).toEqual([]);
  });
});

describe('buildConfigFiles', () => {
  it('defaults permissions and renders secret content', () => {
    expect(buildConfigFiles({ '/etc/app.yaml': 'key: value', '/etc/cert.pem': { content: { name: 'cert' } } })).toEqual([
      { path: '/etc/app.yaml', content: 'key: value', permissions: DEFAULT_CONFIG_FILE_PERMISSIONS },
      { path: '/etc/cert.pem', content: '{{ secret.cert }}', permissions: DEFAULT_CONFIG_FILE_PERMISSIONS },
    ]);
  });

  it('honors explicit permissions', () => {
    expect(buildConfigFiles({ '/x': { content: 'y', permissions: '0600' } })).toEqual([
      { path: '/x', content: 'y', permissions: '0600' },
    ]);
  });
});

describe('buildDefinition region resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads KOYEB_REGION when opts.region is unset', () => {
    vi.stubEnv('KOYEB_REGION', 'fra');
    const { definition } = buildDefinition({ name: 'pool', image: 'koyeb/sandbox:slim' });
    expect(definition.regions).toEqual(['fra']);
  });

  it('prefers opts.region over KOYEB_REGION', () => {
    vi.stubEnv('KOYEB_REGION', 'fra');
    const { definition } = buildDefinition({
      name: 'pool',
      image: 'koyeb/sandbox:slim',
      region: 'par',
    });
    expect(definition.regions).toEqual(['par']);
  });

  it('falls back to the default region when neither is set', () => {
    const saved = process.env.KOYEB_REGION;
    delete process.env.KOYEB_REGION;
    try {
      const { definition } = buildDefinition({ name: 'pool', image: 'koyeb/sandbox:slim' });
      expect(definition.regions).toEqual(['na']);
    } finally {
      if (saved !== undefined) {
        process.env.KOYEB_REGION = saved;
      }
    }
  });
});

describe('buildDefinition sandbox secret generation', () => {
  it('generates a CSPRNG-backed, URL-safe secret when none is supplied — no Math.random path', () => {
    const random = vi.spyOn(Math, 'random');

    const { definition, sandbox_secret } = buildDefinition({ name: 'sb', image: 'koyeb/sandbox' });

    // The generation seam must not draw from Math.random.
    expect(random).not.toHaveBeenCalled();
    // token_urlsafe(32) strength: base64url of 32 bytes — 43 chars, 256 bits.
    expect(sandbox_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(definition.env).toContainEqual({ key: 'SANDBOX_SECRET', value: sandbox_secret });
  });
});
