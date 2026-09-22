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

test('TelemetryFeature prometheusMode defaults to embedded', () => {
  const f = new TelemetryFeature('telemetry', {});
  expect(f.prometheusMode).toBe('embedded');
});

test('TelemetryFeature prometheusMode respects managed override', () => {
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed', platform: 'openshift' });
  expect(f.prometheusMode).toBe('managed');
});

test('validate() throws when prometheusMode is managed but platform is not openshift', () => {
  process.env.GRAFANA_ADMIN_USERNAME = 'admin';
  process.env.GRAFANA_ADMIN_PASSWORD = 'pw';
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed' });
  expect(() => f.validate()).toThrow(/prometheusMode: managed requires platform: openshift/);
  delete process.env.GRAFANA_ADMIN_USERNAME;
  delete process.env.GRAFANA_ADMIN_PASSWORD;
});

test('validate() throws on an unknown prometheusMode value', () => {
  process.env.GRAFANA_ADMIN_USERNAME = 'admin';
  process.env.GRAFANA_ADMIN_PASSWORD = 'pw';
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'bogus', platform: 'openshift' });
  expect(() => f.validate()).toThrow(/Invalid prometheusMode/);
  delete process.env.GRAFANA_ADMIN_USERNAME;
  delete process.env.GRAFANA_ADMIN_PASSWORD;
});

test('validate() passes for managed mode on openshift with credentials set', () => {
  process.env.GRAFANA_ADMIN_USERNAME = 'admin';
  process.env.GRAFANA_ADMIN_PASSWORD = 'pw';
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed', platform: 'openshift' });
  expect(f.validate()).toBe(true);
  delete process.env.GRAFANA_ADMIN_USERNAME;
  delete process.env.GRAFANA_ADMIN_PASSWORD;
});

test('buildPrometheusStackHelmArgs omits sub-component disables in embedded mode', () => {
  const f = new TelemetryFeature('telemetry', {});
  const args = f.buildPrometheusStackHelmArgs();
  expect(args).not.toContain('prometheus.enabled=false');
  expect(args).not.toContain('--skip-crds');
});

test('buildPrometheusStackHelmArgs disables prometheus/alertmanager/operator and skips CRDs in managed mode', () => {
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed', platform: 'openshift' });
  const args = f.buildPrometheusStackHelmArgs();
  expect(args).toContain('prometheus.enabled=false');
  expect(args).toContain('alertmanager.enabled=false');
  expect(args).toContain('prometheusOperator.enabled=false');
  expect(args).toContain('--skip-crds');
});

test('buildPrometheusStackHelmArgs skips CRDs on openshift even in embedded mode', () => {
  const f = new TelemetryFeature('telemetry', { platform: 'openshift' });
  const args = f.buildPrometheusStackHelmArgs();
  expect(args).toContain('--skip-crds');
  expect(args).not.toContain('prometheus.enabled=false');
});
