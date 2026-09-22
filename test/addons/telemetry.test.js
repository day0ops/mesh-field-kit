import { test, expect, describe, spyOn, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
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

test('getPrometheusStackWaitTargets waits on operator and prometheus in embedded mode', () => {
  const f = new TelemetryFeature('telemetry', {});
  const { deployments, statefulSets } = f.getPrometheusStackWaitTargets();
  expect(deployments).toEqual(['kube-prometheus-stack-operator', 'kube-prometheus-stack-grafana']);
  expect(statefulSets).toEqual(['prometheus-kube-prometheus-stack-prometheus']);
});

test('getPrometheusStackWaitTargets skips operator and prometheus in managed mode', () => {
  const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed', platform: 'openshift' });
  const { deployments, statefulSets } = f.getPrometheusStackWaitTargets();
  expect(deployments).toEqual(['kube-prometheus-stack-grafana']);
  expect(statefulSets).toEqual([]);
});

const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'addons', 'telemetry', 'config');

test('otel-metrics-managed-values.yaml exists and uses a pull-based prometheus exporter', () => {
  const path = join(CONFIG_DIR, 'otel-metrics-managed-values.yaml');
  expect(existsSync(path)).toBe(true);
  const content = readFileSync(path, 'utf8');
  expect(content).toContain('prometheus:');
  expect(content).toContain("endpoint: '0.0.0.0:8889'");
  expect(content).toContain('serviceMonitor:');
  expect(content).toContain('enabled: true');
  expect(content).not.toContain('prometheusremotewrite');
});

describe('installOtelCollectors() metrics values file selection', () => {
  let installOtelChartSpy;
  let calls;

  beforeEach(() => {
    calls = [];
    // Stub the Helm-calling boundary so branching logic is exercised without touching a cluster.
    installOtelChartSpy = spyOn(TelemetryFeature.prototype, 'installOtelChart').mockImplementation(
      async (release, valuesContent, helmCtxArgs) => {
        calls.push({ release, valuesContent, helmCtxArgs });
      }
    );
  });

  afterEach(() => {
    installOtelChartSpy.mockRestore();
  });

  test('managed mode installs the metrics collector with the pull-based values file', async () => {
    const f = new TelemetryFeature('telemetry', { prometheusMode: 'managed', platform: 'openshift' });
    await f.installOtelCollectors();

    const metricsCall = calls.find(c => c.release === 'opentelemetry-collector-metrics');
    expect(metricsCall).toBeDefined();
    expect(metricsCall.valuesContent).toContain("endpoint: '0.0.0.0:8889'");
    expect(metricsCall.valuesContent).not.toContain('prometheusremotewrite');
  });

  test('embedded (default) mode installs the metrics collector with the prometheusremotewrite values file', async () => {
    const f = new TelemetryFeature('telemetry', {});
    await f.installOtelCollectors();

    const metricsCall = calls.find(c => c.release === 'opentelemetry-collector-metrics');
    expect(metricsCall).toBeDefined();
    expect(metricsCall.valuesContent).toContain('prometheusremotewrite');
    expect(metricsCall.valuesContent).not.toContain("endpoint: '0.0.0.0:8889'");
  });
});
