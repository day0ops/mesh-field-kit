import { test, expect } from 'bun:test';
import { TelemetryFeature } from '../../addons/telemetry/index.js';
import { generate as telemetryRunbookGenerate } from '../../addons/telemetry/runbook.js';

test('TelemetryFeature openshift defaults to false', () => {
  const f = new TelemetryFeature('telemetry', {});
  expect(f.openshift).toBe(false);
});

test('TelemetryFeature openshift is true only when platform is openshift', () => {
  const f = new TelemetryFeature('telemetry', { platform: 'openshift' });
  expect(f.openshift).toBe(true);
});

test('telemetry runbook omits --skip-crds when platform is not set', async () => {
  const md = await telemetryRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });
  expect(md).not.toContain('--skip-crds');
});

test('telemetry runbook emits --skip-crds for kube-prometheus-stack when platform is openshift', async () => {
  const md = await telemetryRunbookGenerate(1, { platform: 'openshift' }, 'my-cluster', {}, {
    spec: {},
  });
  expect(md).toContain('--skip-crds');
});
