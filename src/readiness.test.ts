import { describe, expect, it } from 'vitest';

import { classifyDeploymentStatus, classifyServiceStatus } from './readiness.js';

describe('status classification', () => {
  it('classifies service statuses with the claim-path sets', () => {
    expect(classifyServiceStatus('HEALTHY')).toBe('ready');
    expect(classifyServiceStatus('DEGRADED')).toBe('ready');
    expect(classifyServiceStatus('STARTING')).toBe('in_progress');
    expect(classifyServiceStatus('RESUMING')).toBe('in_progress');
    expect(classifyServiceStatus('UNHEALTHY')).toBe('terminal_failure');
  });

  it('classifies deployment statuses with the sandbox-path sets', () => {
    expect(classifyDeploymentStatus('HEALTHY')).toBe('ready');
    expect(classifyDeploymentStatus('DEGRADED')).toBe('ready');

    expect(classifyDeploymentStatus('PENDING')).toBe('in_progress');
    expect(classifyDeploymentStatus('PROVISIONING')).toBe('in_progress');
    expect(classifyDeploymentStatus('SCHEDULED')).toBe('in_progress');
    expect(classifyDeploymentStatus('ALLOCATING')).toBe('in_progress');
    expect(classifyDeploymentStatus('STARTING')).toBe('in_progress');

    expect(classifyDeploymentStatus('SLEEPING')).toBe('terminal_failure');
    expect(classifyDeploymentStatus('STOPPED')).toBe('terminal_failure');
    expect(classifyDeploymentStatus('ERROR')).toBe('terminal_failure');
  });

  it('fails closed on unknown and missing statuses', () => {
    expect(classifyServiceStatus(undefined)).toBe('terminal_failure');
    expect(classifyServiceStatus('SOMETHING_NEW' as never)).toBe('terminal_failure');
    expect(classifyDeploymentStatus(undefined)).toBe('terminal_failure');
    expect(classifyDeploymentStatus('SOMETHING_NEW' as never)).toBe('terminal_failure');
  });
});
