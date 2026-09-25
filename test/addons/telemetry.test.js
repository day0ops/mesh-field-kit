import { test, expect, describe, spyOn, beforeEach, afterEach } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  TelemetryFeature,
  mergeUserWorkloadConfig,
  readClusterMonitoringConfigYaml,
  waitForCaBundleConfigMap,
} from '../../addons/telemetry/index.js';
import { generate as telemetryRunbookGenerate } from '../../addons/telemetry/runbook.js';
import { CommandRunner } from '../../src/lib/common.js';
import { Feature } from '../../src/lib/feature.js';

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
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift' },
    'my-cluster',
    {},
    {
      spec: {},
    }
  );
  expect(md).toContain('--skip-crds');
});

test('telemetry runbook disables prometheus/alertmanager/operator for managed mode', async () => {
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).toContain('prometheus.enabled=false');
  expect(md).toContain('alertmanager.enabled=false');
  expect(md).toContain('prometheusOperator.enabled=false');
});

test('telemetry runbook documents enabling user-workload-monitoring for managed mode', async () => {
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).toContain('user-workload-monitoring');
  expect(md).toContain('grafana-thanos-reader');
  expect(md).toContain('cluster-monitoring-view');
});

test('telemetry runbook omits managed-mode steps for embedded mode', async () => {
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift' },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).not.toContain('grafana-thanos-reader');
  expect(md).not.toContain('prometheus.enabled=false');
});

test('telemetry runbook orders managed-mode steps to match the real install sequence', async () => {
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  const uwmIndex = md.indexOf('user-workload-monitoring');
  const prometheusInstallIndex = md.indexOf('Install Prometheus + Grafana (kube-prometheus-stack)');
  const thanosCredsIndex = md.indexOf('Provision the ServiceAccount Grafana uses');
  const datasourcesIndex = md.indexOf('Apply Grafana datasources');
  // enableUserWorkloadMonitoring() runs before installPrometheusStack() in deployFull()
  expect(uwmIndex).toBeGreaterThan(-1);
  expect(uwmIndex).toBeLessThan(prometheusInstallIndex);
  // the Thanos ServiceAccount/token/CA-bundle are minted inside installDatasources(),
  // which runs after installPrometheusStack()
  expect(thanosCredsIndex).toBeGreaterThan(prometheusInstallIndex);
  expect(thanosCredsIndex).toBeLessThan(datasourcesIndex);
});

test('telemetry runbook selects the pull-based metrics values file for managed mode', async () => {
  const managedMd = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  const embeddedMd = await telemetryRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });

  expect(managedMd).toContain("endpoint: '0.0.0.0:8889'");
  expect(managedMd).toContain('serviceMonitor:');

  expect(embeddedMd).not.toContain("endpoint: '0.0.0.0:8889'");
  expect(embeddedMd).toContain('prometheusremotewrite/local');
});

test('telemetry runbook selects the pull-based gateway values file for managed mode', async () => {
  const managedMd = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  const embeddedMd = await telemetryRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });

  expect(managedMd).toContain("endpoint: '0.0.0.0:8890'");
  // logs/traces pipelines are unaffected by prometheusMode
  expect(managedMd).toContain('otlphttp/loki');
  expect(managedMd).toContain('otlp/tempo');

  expect(embeddedMd).not.toContain("endpoint: '0.0.0.0:8890'");
  expect(embeddedMd).toContain(
    "endpoint: 'http://kube-prometheus-stack-prometheus.telemetry.svc.cluster.local:9090/api/v1/write'"
  );
});

test('telemetry runbook wires the Grafana datasource at Thanos Querier for managed mode', async () => {
  const md = await telemetryRunbookGenerate(
    1,
    { platform: 'openshift', prometheusMode: 'managed' },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).toContain('url: https://thanos-querier.openshift-monitoring.svc:9092');
  expect(md).toContain('httpHeaderName1: Authorization');
  expect(md).toContain('tlsAuthWithCACert: true');
  expect(md).not.toContain('{{');
});

test('telemetry runbook keeps the in-cluster Prometheus datasource URL for embedded mode with no unresolved placeholders', async () => {
  const md = await telemetryRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });
  expect(md).toContain('url: http://kube-prometheus-stack-prometheus.telemetry:9090');
  expect(md).not.toContain('{{');
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

const CONFIG_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'addons',
  'telemetry',
  'config'
);

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

test('otel-gateway-managed-values.yaml exists, uses a pull-based prometheus exporter on a distinct port, and preserves logs/traces pipelines', () => {
  const path = join(CONFIG_DIR, 'otel-gateway-managed-values.yaml');
  expect(existsSync(path)).toBe(true);
  const content = readFileSync(path, 'utf8');
  expect(content).toContain('prometheus:');
  expect(content).toContain("endpoint: '0.0.0.0:8890'");
  expect(content).toContain('serviceMonitor:');
  expect(content).toContain('enabled: true');
  expect(content).not.toContain('prometheusremotewrite');

  // Distinct port from the local metrics collector's 8889
  const metricsContent = readFileSync(join(CONFIG_DIR, 'otel-metrics-managed-values.yaml'), 'utf8');
  expect(metricsContent).not.toContain('8890');
  expect(content).not.toContain('8889');

  // Logs/traces exporters/pipelines untouched
  expect(content).toContain('otlphttp/loki');
  expect(content).toContain('otlp/tempo');
  expect(content).toContain('otlp/solo-ui');
  const parsed = yaml.load(content);
  expect(parsed.config.service.pipelines.logs.exporters).toEqual(['otlphttp/loki']);
  expect(parsed.config.service.pipelines.traces.exporters).toEqual(['otlp/tempo', 'otlp/solo-ui']);
  expect(parsed.config.service.pipelines.metrics.exporters).toEqual(['prometheus']);
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
    const f = new TelemetryFeature('telemetry', {
      prometheusMode: 'managed',
      platform: 'openshift',
    });
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

describe('installOtelGateway() gateway values file selection', () => {
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

  test('managed mode installs the gateway collector with the pull-based values file', async () => {
    const f = new TelemetryFeature('telemetry', {
      prometheusMode: 'managed',
      platform: 'openshift',
    });
    await f.installOtelGateway();

    const gatewayCall = calls.find(c => c.release === 'opentelemetry-collector-gateway');
    expect(gatewayCall).toBeDefined();
    expect(gatewayCall.valuesContent).toContain("endpoint: '0.0.0.0:8890'");
    expect(gatewayCall.valuesContent).not.toContain('prometheusremotewrite');
  });

  test('embedded (default) mode installs the gateway collector with the prometheusremotewrite values file', async () => {
    const f = new TelemetryFeature('telemetry', {});
    await f.installOtelGateway();

    const gatewayCall = calls.find(c => c.release === 'opentelemetry-collector-gateway');
    expect(gatewayCall).toBeDefined();
    expect(gatewayCall.valuesContent).toContain('prometheusremotewrite');
    expect(gatewayCall.valuesContent).not.toContain("endpoint: '0.0.0.0:8890'");
  });
});

test('mergeUserWorkloadConfig sets enableUserWorkload on empty existing config', () => {
  const result = mergeUserWorkloadConfig('', yaml);
  expect(result).toEqual({ enableUserWorkload: true });
});

test('mergeUserWorkloadConfig preserves existing unrelated keys', () => {
  const existing = yaml.dump({ someOtherSetting: 'value', nested: { a: 1 } });
  const result = mergeUserWorkloadConfig(existing, yaml);
  expect(result).toEqual({
    someOtherSetting: 'value',
    nested: { a: 1 },
    enableUserWorkload: true,
  });
});

describe('waitForCaBundleConfigMap()', () => {
  let runSpy;
  let setTimeoutSpy;

  afterEach(() => {
    runSpy?.mockRestore();
    setTimeoutSpy?.mockRestore();
  });

  test('returns the CA cert when the first poll finds it populated', async () => {
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 0,
      stdout: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
      stderr: '',
    });
    const result = await waitForCaBundleConfigMap('thanos-querier-ca-bundle', 'telemetry', []);
    expect(result).toBe('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    expect(runSpy).toHaveBeenCalledWith(
      'oc',
      expect.arrayContaining(['get', 'configmap', 'thanos-querier-ca-bundle', '-n', 'telemetry']),
      expect.any(Object)
    );
  });

  test('throws a clear, actionable error naming the ConfigMap/namespace if it never populates', async () => {
    // The retry loop sleeps 3s between polls; fire that timer immediately so the test
    // doesn't actually wait. A short timeoutMs then bounds real wall-clock time.
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(fn => fn());
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    await expect(
      waitForCaBundleConfigMap('thanos-querier-ca-bundle', 'telemetry', [], 20)
    ).rejects.toThrow(
      /ConfigMap 'thanos-querier-ca-bundle' in 'telemetry' was not populated with service-ca\.crt/
    );
  });
});

describe('readClusterMonitoringConfigYaml()', () => {
  let runSpy;

  afterEach(() => {
    runSpy?.mockRestore();
  });

  test('returns the ConfigMap content when the read succeeds', async () => {
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 0,
      stdout: 'someOtherSetting: value\n',
      stderr: '',
    });
    const result = await readClusterMonitoringConfigYaml([]);
    expect(result).toBe('someOtherSetting: value\n');
  });

  test('returns empty string when the ConfigMap does not exist yet (NotFound)', async () => {
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error from server (NotFound): configmaps "cluster-monitoring-config" not found',
    });
    const result = await readClusterMonitoringConfigYaml([]);
    expect(result).toBe('');
  });

  test('throws instead of treating a non-NotFound failure as empty', async () => {
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'Error from server (Forbidden): configmaps is forbidden: User "x" cannot get resource',
    });
    await expect(readClusterMonitoringConfigYaml([])).rejects.toThrow(/cannot be safely merged/);
  });

  test('threads context args into the oc get command', async () => {
    runSpy = spyOn(CommandRunner, 'run').mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    await readClusterMonitoringConfigYaml(['--context=my-cluster']);
    expect(runSpy).toHaveBeenCalledWith(
      'oc',
      expect.arrayContaining(['--context=my-cluster', 'get', 'configmap']),
      expect.any(Object)
    );
  });
});

test('grafana-datasources.yaml template has managed-mode placeholders', () => {
  const content = readFileSync(join(CONFIG_DIR, 'grafana-datasources.yaml'), 'utf8');
  expect(content).toContain('{{PROMETHEUS_DATASOURCE_URL}}');
  expect(content).toContain('{{PROMETHEUS_AUTH_JSONDATA}}');
  expect(content).toContain('{{PROMETHEUS_AUTH_SECUREJSONDATA}}');
});

describe('installDatasources()', () => {
  let applyResourceSpy;
  let applyResourceCalls;

  beforeEach(() => {
    applyResourceCalls = [];
    applyResourceSpy = spyOn(Feature.prototype, 'applyResource').mockImplementation(
      async resource => {
        applyResourceCalls.push(resource);
      }
    );
  });

  afterEach(() => {
    applyResourceSpy.mockRestore();
  });

  function grafanaDatasourcesYaml() {
    const configMap = applyResourceCalls.find(
      r => r.kind === 'ConfigMap' && r.metadata.name === 'grafana-datasources'
    );
    return configMap.data['datasources.yaml'];
  }

  test('embedded mode keeps the in-cluster Prometheus URL with no auth block', async () => {
    const f = new TelemetryFeature('telemetry', {});
    await f.installDatasources();

    const content = grafanaDatasourcesYaml();
    expect(content).not.toContain('{{');
    const prometheus = yaml.load(content).datasources.find(d => d.name === 'Prometheus');
    expect(prometheus.url).toBe('http://kube-prometheus-stack-prometheus.telemetry:9090');
    expect(prometheus.jsonData).toEqual({
      httpMethod: 'GET',
      exemplarTraceIdDestinations: [{ name: 'trace_id', datasourceUid: 'tempo' }],
    });
    expect(prometheus.secureJsonData).toBeUndefined();
  });

  test('managed mode points Grafana at Thanos Querier with Bearer token + CA cert auth', async () => {
    const caCert = '-----BEGIN CERTIFICATE-----\nfakecert\n-----END CERTIFICATE-----\n';
    const runSpy = spyOn(CommandRunner, 'run').mockImplementation(async (_cmd, args) => {
      if (args.includes('token')) {
        return { exitCode: 0, stdout: 'fake-sa-token\n', stderr: '' };
      }
      return { exitCode: 0, stdout: caCert, stderr: '' };
    });

    const f = new TelemetryFeature('telemetry', {
      prometheusMode: 'managed',
      platform: 'openshift',
    });
    await f.installDatasources();
    runSpy.mockRestore();

    const content = grafanaDatasourcesYaml();
    expect(content).not.toContain('{{');
    const prometheus = yaml.load(content).datasources.find(d => d.name === 'Prometheus');
    expect(prometheus.url).toBe('https://thanos-querier.openshift-monitoring.svc:9092');
    expect(prometheus.jsonData.httpHeaderName1).toBe('Authorization');
    expect(prometheus.jsonData.tlsAuthWithCACert).toBe(true);
    expect(prometheus.secureJsonData).toEqual({
      httpHeaderValue1: 'Bearer fake-sa-token',
      tlsCACert: caCert,
    });
  });
});
