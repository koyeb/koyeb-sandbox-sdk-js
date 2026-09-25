import { afterEach, describe, expect, it, vi } from 'vitest';

import { KoyebApi } from './api.js';
import { ServicePool } from './service-pool.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ServicePool.create', () => {
  it('threads every definition option into the pool definition', async () => {
    const create = vi.spyOn(KoyebApi.prototype, 'createServicePool').mockResolvedValue({
      id: 'pool-1',
      name: 'my-pool',
    } as never);

    await ServicePool.create('my-pool', {
      api_token: 't',
      size: 2,
      entrypoint: ['/bin/sh', '-c'],
      command: 'sleep 1',
      args: ['--flag'],
      enable_mesh: true,
      sandbox_secret: 'explicit-secret',
      idle_timeout: 60,
      _experimental_enable_light_sleep: true,
      _experimental_deep_sleep_value: 600,
    });

    const body = create.mock.calls[0][0] as {
      definition: {
        docker: { entrypoint?: string[]; command?: string; args?: string[] };
        mesh?: string;
        env: { key: string; value: string }[];
        scalings: { targets: { sleep_idle_delay: Record<string, number> }[] }[];
      };
    };

    expect(body.definition.docker).toMatchObject({
      entrypoint: ['/bin/sh', '-c'],
      command: 'sleep 1',
      args: ['--flag'],
    });
    expect(body.definition.mesh).toBe('DEPLOYMENT_MESH_ENABLED');
    expect(body.definition.env[0]).toEqual({ key: 'SANDBOX_SECRET', value: 'explicit-secret' });
    expect(body.definition.scalings[0].targets[0].sleep_idle_delay).toEqual({
      light_sleep_value: 60,
      deep_sleep_value: 600,
    });
  });
});
