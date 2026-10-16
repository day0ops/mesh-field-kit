import { test, expect, spyOn, describe, beforeEach, afterEach } from 'bun:test';
import { SoloUIFeature } from '../../addons/solo-ui/index.js';
import { generate as soloUiRunbookGenerate } from '../../addons/solo-ui/runbook.js';
import { KubernetesHelper } from '../../src/lib/common.js';

test('SoloUIFeature sourceRanges defaults to null', () => {
  const f = new SoloUIFeature('solo-ui', {});
  expect(f.sourceRanges).toBeNull();
});

test('SoloUIFeature sourceRanges respects config override', () => {
  const f = new SoloUIFeature('solo-ui', { sourceRanges: ['165.99.148.61/32'] });
  expect(f.sourceRanges).toEqual(['165.99.148.61/32']);
});

test('SoloUIFeature subnetIds defaults to null', () => {
  const f = new SoloUIFeature('solo-ui', {});
  expect(f.subnetIds).toBeNull();
});

test('SoloUIFeature subnetIds respects config override', () => {
  const f = new SoloUIFeature('solo-ui', { subnetIds: ['subnet-abc', 'subnet-def'] });
  expect(f.subnetIds).toEqual(['subnet-abc', 'subnet-def']);
});

test('SoloUIFeature nlbTargetType defaults to ip', () => {
  const f = new SoloUIFeature('solo-ui', {});
  expect(f.nlbTargetType).toBe('ip');
});

test('SoloUIFeature nlbTargetType respects config override', () => {
  const f = new SoloUIFeature('solo-ui', { nlbTargetType: 'instance' });
  expect(f.nlbTargetType).toBe('instance');
});

test('applyGatewayResources omits the ip-mode-only target-group-attributes annotation when nlbTargetType is instance', async () => {
  const f = new SoloUIFeature('solo-ui', {
    hostname: 'soloui.mesh-demo.kasunt.apac.fe.solo.io',
    nlbTargetType: 'instance',
  });
  const applyYamlFileSpy = spyOn(f, 'applyYamlFile').mockResolvedValue();

  await f.applyGatewayResources();

  const [, gatewayOverrides] = applyYamlFileSpy.mock.calls[0];
  const annotations = gatewayOverrides.spec.infrastructure.annotations;
  expect(annotations['service.beta.kubernetes.io/aws-load-balancer-nlb-target-type']).toBe(
    'instance'
  );
  expect(
    annotations['service.beta.kubernetes.io/aws-load-balancer-target-group-attributes']
  ).toBeUndefined();
});

test('applyGatewayResources applies the HTTP gateway/route and skips the Certificate when tls is not enabled', async () => {
  const f = new SoloUIFeature('solo-ui', {
    hostname: 'soloui.mesh-demo.kasunt.apac.fe.solo.io',
    sourceRanges: ['165.99.148.61/32'],
  });
  const applyYamlFileSpy = spyOn(f, 'applyYamlFile').mockResolvedValue();

  await f.applyGatewayResources();

  const filenames = applyYamlFileSpy.mock.calls.map(call => call[0]);
  expect(filenames).toEqual([
    'http-gateway.yaml',
    'http-route.yaml',
    'gateway-tracing-suppress-policy.yaml',
  ]);

  const [, gatewayOverrides] = applyYamlFileSpy.mock.calls[0];
  expect(gatewayOverrides.spec.listeners[0].protocol).toBe('HTTP');
  expect(gatewayOverrides.spec.listeners[0].port).toBe(80);

  const [, routeOverrides] = applyYamlFileSpy.mock.calls[1];
  expect(routeOverrides.spec.parentRefs[0].name).toBe('solo-enterprise-ui-http');
});

test('applyGatewayResources applies the Certificate and HTTPS gateway/route when tls.enabled', async () => {
  const f = new SoloUIFeature('solo-ui', {
    hostname: 'soloui.mesh-demo.kasunt.apac.fe.solo.io',
    tls: { enabled: true, secretName: 'solo-ui-tls', issuer: 'letsencrypt-dns' },
  });
  const applyYamlFileSpy = spyOn(f, 'applyYamlFile').mockResolvedValue();

  await f.applyGatewayResources();

  const filenames = applyYamlFileSpy.mock.calls.map(call => call[0]);
  expect(filenames).toEqual([
    'certificate.yaml',
    'https-gateway.yaml',
    'https-route.yaml',
    'gateway-tracing-suppress-policy.yaml',
  ]);

  const [, gatewayOverrides] = applyYamlFileSpy.mock.calls[1];
  expect(gatewayOverrides.spec.listeners[0].protocol).toBe('HTTPS');
  expect(gatewayOverrides.spec.listeners[0].port).toBe(443);

  const [, routeOverrides] = applyYamlFileSpy.mock.calls[2];
  expect(routeOverrides.spec.parentRefs[0].name).toBe('solo-enterprise-ui-https');
});

describe('installManagementChart() service.type pass-through', () => {
  let helmSpy;
  let assertHelmDeployedSpy;

  beforeEach(() => {
    helmSpy = spyOn(KubernetesHelper, 'helm').mockResolvedValue();
    assertHelmDeployedSpy = spyOn(KubernetesHelper, 'assertHelmDeployed').mockResolvedValue();
  });

  afterEach(() => {
    helmSpy.mockRestore();
    assertHelmDeployedSpy.mockRestore();
  });

  // Chart version 0.5.11 defaults service.type to LoadBalancer (public) when this flag is
  // omitted - callers relying on silent omission get a public Service, not port-forward-safe.
  test('passes --set service.type=ClusterIP when serviceType is configured', async () => {
    const f = new SoloUIFeature('solo-ui', { serviceType: 'ClusterIP' });

    await f.installManagementChart();

    const [helmArgs] = helmSpy.mock.calls[0];
    const setIndex = helmArgs.indexOf('service.type=ClusterIP');
    expect(setIndex).toBeGreaterThan(0);
    expect(helmArgs[setIndex - 1]).toBe('--set');
  });

  test('omits the service.type flag entirely when serviceType is not configured', async () => {
    const f = new SoloUIFeature('solo-ui', {});

    await f.installManagementChart();

    const [helmArgs] = helmSpy.mock.calls[0];
    expect(helmArgs.some(arg => arg.startsWith('service.type='))).toBe(false);
  });
});

test('solo-ui runbook emits --set service.type when serviceType is configured', async () => {
  const md = await soloUiRunbookGenerate(
    1,
    { config: { serviceType: 'ClusterIP' } },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).toContain('--set service.type=ClusterIP');
});

test('solo-ui runbook omits the service.type flag when serviceType is not configured', async () => {
  const md = await soloUiRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });
  expect(md).not.toContain('service.type=');
});

test('solo-ui runbook emits the Gateway/HTTPRoute block when hostname is configured', async () => {
  const md = await soloUiRunbookGenerate(
    1,
    { config: { hostname: 'soloui.prod.example.com' } },
    'my-cluster',
    {},
    { spec: {} }
  );
  expect(md).toContain('kind: Gateway');
  expect(md).toContain('kind: HTTPRoute');
  expect(md).toContain('hostname: soloui.prod.example.com');
});

test('solo-ui runbook omits the Gateway/HTTPRoute/NLB-restriction block when hostname is not configured', async () => {
  const md = await soloUiRunbookGenerate(1, {}, 'my-cluster', {}, { spec: {} });
  expect(md).not.toContain('kind: Gateway');
  expect(md).not.toContain('kind: HTTPRoute');
  expect(md).not.toContain('aws-load-balancer');
});
