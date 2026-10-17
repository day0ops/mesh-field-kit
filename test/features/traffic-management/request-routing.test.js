// test/features/traffic-management/request-routing.test.js
import { test, expect } from 'bun:test';
import { RequestRoutingFeature } from '../../../features/traffic-management/request-routing/index.js';
import { CommandRunner, KubernetesHelper } from '../../../src/lib/common.js';

function baseConfig(overrides = {}) {
  return {
    routeName: 'test-route',
    namespace: 'route-ns',
    gatewayName: 'test-gw',
    ...overrides,
  };
}

async function deployCapturingLabelCalls(feature) {
  const originalExec = CommandRunner.exec;
  const originalKubectl = KubernetesHelper.kubectl;
  const kubectlCalls = [];
  CommandRunner.exec = async () => ({ stdout: '', stderr: '' });
  KubernetesHelper.kubectl = async args => {
    kubectlCalls.push(args);
    return { stdout: '' };
  };
  try {
    await feature.deploy();
  } finally {
    CommandRunner.exec = originalExec;
    KubernetesHelper.kubectl = originalKubectl;
  }
  return kubectlCalls;
}

test('RequestRoutingFeature.deploy labels the namespace ambient when dataplaneMode is unset', async () => {
  const feature = new RequestRoutingFeature('request-routing', baseConfig());
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label'));
  expect(labelCall).toBeDefined();
  expect(labelCall).toContain('istio.io/dataplane-mode=ambient');
});

test("RequestRoutingFeature.deploy does not label the namespace when dataplaneMode is 'none'", async () => {
  const feature = new RequestRoutingFeature(
    'request-routing',
    baseConfig({ dataplaneMode: 'none' })
  );
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label'));
  expect(labelCall).toBeUndefined();
});
