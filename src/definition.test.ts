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

