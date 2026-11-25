import { describe, expect, it } from 'vitest';

import { buildDefinition } from './definition.js';
import { SandboxError, SidecarError, Sidecar } from './index.js';
import { validateSidecars, type SidecarOptions } from './sidecar.js';

/** The Python test's `_sidecar`, at step 2's reference commit. */
function sidecar(overrides: Partial<SidecarOptions> & Record<string, unknown> = {}): Sidecar {
  const options: SidecarOptions = {
    name: 'proxy',
    image: 'mitmproxy/mitmproxy',
    ports: [8080],
  };

  return new Sidecar({ ...options, ...overrides } as SidecarOptions);
}

/** `service_spec(region=...).deployment_definition()` in Python: the service each sidecar is created with. */
function define(overrides: Partial<SidecarOptions> & Record<string, unknown> = {}) {
  return sidecar(overrides).definition('fra');
}

describe('Sidecar validation', () => {
  it('keeps the ports and defaults the instance type to nano', () => {
    const s = sidecar({ ports: [8080, 9000] });
    expect(s.ports).toEqual([8080, 9000]);
    expect(s.instance_type).toBe('nano');
  });

  it('fails with SidecarError, which is a SandboxError', () => {
    expect(() => sidecar({ name: 'Bad' })).toThrow(SidecarError);
    expect(() => sidecar({ name: 'Bad' })).toThrow(SandboxError);
  });

  it.each([[''], ['a'], ['Proxy'], ['-proxy'], ['proxy-'], ['my_proxy'], ['a.b'], ['x'.repeat(64)], [null], [3]])(
    'rejects the invalid name %p',
    (name) => {
      expect(() => sidecar({ name: name as never })).toThrow(SidecarError);
    },
  );

  it.each([['db'], ['proxy-1'], ['x'.repeat(63)], ['1a']])('accepts the valid name %p', (name) => {
    expect(sidecar({ name: name as never }).name).toBe(name);
  });

  it('requires an image', () => {
    expect(() => sidecar({ image: '' })).toThrow(SidecarError);
  });

  it.each([[[]], [[0]], [[65000]], [[8080, 8080]], [[1, 2, 3, 4, 5, 6]], [['80']], [[true]], ['8080'], [null], [8080]])(
    'rejects the invalid ports %p',
    (ports) => {
      expect(() => sidecar({ ports: ports as never })).toThrow(SidecarError);
    },
  );

  it('rejects conflicting egress options', () => {
    expect(() => sidecar({ block_network: true, outbound_allowlist: ['1.2.3.4'] })).toThrow(SidecarError);
  });

  it('rejects an invalid allowlist entry', () => {
    expect(() => sidecar({ outbound_allowlist: ['not-an-ip'] })).toThrow(/Invalid outbound_allowlist entry/);
    expect(() => sidecar({ outbound_allowlist: ['not-an-ip'] })).toThrow(SidecarError);
  });
});

describe('validateSidecars', () => {
  it('rejects duplicate names', () => {
    expect(() => validateSidecars([sidecar(), sidecar()], 'sb')).toThrow(/Duplicate sidecar name 'proxy'/);
  });

  it('rejects a name equal to the sandbox’s', () => {
    expect(() => validateSidecars([sidecar({ name: 'sb' })], 'sb')).toThrow(/is the sandbox's name/);
  });

  it('rejects a non-Sidecar', () => {
    expect(() => validateSidecars([{ name: 'proxy' } as never], 'sb')).toThrow(SidecarError);
    expect(() => validateSidecars([{ name: 'proxy' } as never], 'sb')).toThrow(/Expected a Sidecar/);
  });

  it('returns a list from any iterable', () => {
    function* two() {
      yield sidecar({ name: 'a1' });
      yield sidecar({ name: 'b1' });
    }

    expect(validateSidecars(two(), 'sb')).toEqual([sidecar({ name: 'a1' }), sidecar({ name: 'b1' })]);
  });
});

describe('Sidecar definition', () => {
  it('is a WEB service without routes and with tcp ports', () => {
    const d = define();
    expect(d.type).toBe('WEB');
    expect(d.routes).toEqual([]);
    expect(d.ports).toEqual([{ port: 8080, protocol: 'tcp' }]);
  });

  it('health-checks the first port', () => {
    const d = define({ ports: [9000, 8080] });
    expect(d.health_checks).toHaveLength(1);
    expect(d.health_checks![0]).toEqual({ tcp: { port: 9000 } });
  });

  it('enables the mesh with app scope', () => {
    const d = define();
    expect(d.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
    expect(d.network_policy?.mesh?.scope).toBe('MESH_SCOPE_APP');
    expect(d.network_policy?.egress).toBeUndefined();
  });

  it('never scales to zero: mesh traffic must not wake the sidecar', () => {
    const scaling = define().scalings![0];
    expect(scaling.min).toBe(1);
    expect(scaling.max).toBe(1);
    expect(scaling.targets).toBeUndefined();
  });

  it('carries no sandbox secret, sandbox ports or proxy ports', () => {
    const d = define();
    expect(d.env?.map(({ key }) => key)).not.toContain('SANDBOX_SECRET');
    expect(d.ports?.map(({ port }) => port)).not.toContain(3030);
    expect(d.proxy_ports).toBeUndefined();
  });

  it('renders secret env values as references', () => {
    const d = define({ env: { API_KEY: { name: 'my-key' }, MODE: 'x' } });
    expect(d.env).toEqual([
      { key: 'API_KEY', value: '{{ secret.my-key }}' },
      { key: 'MODE', value: 'x' },
    ]);
  });

  it('keeps the egress allowlist next to the mesh scope', () => {
    const d = define({ outbound_allowlist: ['1.2.3.4'] });
    expect(d.network_policy?.egress?.mode).toBe('EGRESS_POLICY_MODE_DENY_ALL');
    expect(d.network_policy?.mesh?.scope).toBe('MESH_SCOPE_APP');
    expect(d.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
  });

  it('passes docker overrides, files and the region through', () => {
    const d = define({
      command: 'mitmdump',
      args: ['--listen-port', '8080'],
      entrypoint: ['/bin/sh', '-c'],
      registry_secret: 'reg',
      config_files: { '/etc/x.py': 'print(1)' },
      instance_type: 'small',
    });

    expect(d.docker).toMatchObject({
      command: 'mitmdump',
      args: ['--listen-port', '8080'],
      entrypoint: ['/bin/sh', '-c'],
      image_registry_secret: 'reg',
    });
    expect(d.instance_types![0].type).toBe('small');
    expect(d.regions).toEqual(['fra']);
    expect(d.config_files?.map(({ path }) => path)).toEqual(['/etc/x.py']);
  });
});

describe('Sidecar VPN options (privileged and startup_grace_period)', () => {
  it('defaults to unprivileged', () => {
    expect(define().docker?.privileged).toBe(false);
  });

  it('runs privileged when asked', () => {
    expect(define({ privileged: true }).docker?.privileged).toBe(true);
  });

  it('sends no grace period by default, and the given one when set', () => {
    expect(define().health_checks![0].grace_period).toBeUndefined();
    expect(define({ startup_grace_period: 300 }).health_checks![0].grace_period).toBe(300);
  });

  it.each([4, 901, '60', true, 1.5])('rejects the invalid startup_grace_period %p', (value) => {
    expect(() => sidecar({ startup_grace_period: value as never })).toThrow(SidecarError);
  });
});

describe('Sidecar validation from review', () => {
  it.each(['a--b', 'ab\n', 'a.b', 'proxy--1'])('rejects the name %p the API rejects', (name) => {
    expect(() => sidecar({ name: name as never })).toThrow(SidecarError);
  });

  it('rejects overlapping allowlist entries', () => {
    expect(() => sidecar({ outbound_allowlist: ['10.0.0.0/8', '10.1.0.0/16'] })).toThrow(SidecarError);
    expect(() => sidecar({ outbound_allowlist: ['1.2.3.4', '1.2.3.4/32'] })).toThrow(/must not overlap/);
  });

  it('accepts disjoint entries across versions', () => {
    expect(() => sidecar({ outbound_allowlist: ['10.0.0.0/8', '192.168.0.0/16', '2001:db8::/32'] })).not.toThrow();
  });
});

describe('health_checks on the definition builder', () => {
  it('sends none by default', () => {
    const { definition } = buildDefinition({ name: 'sb', image: 'koyeb/sandbox', instance_type: 'micro' });
    expect(definition.health_checks).toBeUndefined();
  });
});
