import { describe, expect, it } from 'vitest';

import {
  buildConfigFiles,
  buildEnvVars,
  DEFAULT_CONFIG_FILE_PERMISSIONS,
  renderEnvValue,
} from './utils.js';

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
