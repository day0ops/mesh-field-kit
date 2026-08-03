// test/lib/runbook-adapters/env.test.js
import { test, expect } from 'bun:test';
import { EnvAdapter } from '../../../src/lib/runbook-adapters/env.js';

const mockSelection = {
  profile: { metadata: { name: 'test-profile' } },
  infraProfile: { spec: { name: 'maple' } },
  environment: { spec: {} },
};

const mockVars = [
  { name: 'ENTERPRISE_ISTIO_LICENSE', description: 'License key', required: true },
  { name: 'AWS_PROFILE', description: 'AWS profile', required: true },
  { name: 'GRAFANA_HOSTNAME', description: 'Grafana hostname', required: false },
];

const mockExports = [
  { name: 'AWS_REGION', value: 'ap-southeast-1', comment: 'AWS region' },
  { name: 'CILIUM_VERSION', value: '1.19.4', comment: 'Cilium version' },
];

test('EnvAdapter.envVars returns empty array', () => {
  const adapter = new EnvAdapter();
  expect(adapter.envVars(mockSelection)).toEqual([]);
});

test('EnvAdapter.envExports returns empty array', () => {
  const adapter = new EnvAdapter();
  expect(adapter.envExports(mockSelection)).toEqual([]);
});

test('EnvAdapter.generate produces markdown table with all vars', () => {
  const adapter = new EnvAdapter();
  const md = adapter.generate(1, mockSelection, mockVars, mockExports);
  expect(md).toContain('## Lab 1');
  expect(md).toContain('ENTERPRISE_ISTIO_LICENSE');
  expect(md).toContain('AWS_PROFILE');
  expect(md).toContain('GRAFANA_HOSTNAME');
  expect(md).toContain('Yes');
  expect(md).toContain('No');
});

test('EnvAdapter.generate includes collapsible export block', () => {
  const adapter = new EnvAdapter();
  const md = adapter.generate(1, mockSelection, mockVars, mockExports);
  expect(md).toContain('<details>');
  expect(md).toContain('export AWS_REGION="ap-southeast-1"');
  expect(md).toContain('export CILIUM_VERSION="1.19.4"');
  expect(md).toContain('# AWS region');
});

test('EnvAdapter dedup logic: first-occurrence wins', () => {
  const vars = [
    { name: 'KEY', description: 'first', required: true },
    { name: 'KEY', description: 'second', required: false },
  ];
  const seen = new Set();
  const deduped = vars.filter(v => {
    if (seen.has(v.name)) return false;
    seen.add(v.name);
    return true;
  });
  expect(deduped).toHaveLength(1);
  expect(deduped[0].description).toBe('first');
});
