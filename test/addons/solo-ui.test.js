import { test, expect, spyOn } from 'bun:test';
import { SoloUIFeature } from '../../addons/solo-ui/index.js';

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
  expect(filenames).toEqual(['http-gateway.yaml', 'http-route.yaml', 'gateway-tracing-suppress-policy.yaml']);

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
