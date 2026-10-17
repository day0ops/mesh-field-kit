// test/features/traffic-management/gateway.test.js
import { test, expect } from 'bun:test';
import { GatewayFeature } from '../../../features/traffic-management/gateway/index.js';
import { CommandRunner, KubernetesHelper } from '../../../src/lib/common.js';

function baseConfig(overrides = {}) {
  return {
    gatewayName: 'test-gw',
    namespace: 'gw-ns',
    gateway: {
      listeners: [{ name: 'http', port: 80, protocol: 'HTTP' }],
    },
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

test('GatewayFeature.deploy labels the namespace ambient when dataplaneMode is unset', async () => {
  const feature = new GatewayFeature('gateway', baseConfig());
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label'));
  expect(labelCall).toBeDefined();
  expect(labelCall).toContain('istio.io/dataplane-mode=ambient');
});

test("GatewayFeature.deploy does not label the namespace when dataplaneMode is 'none'", async () => {
  const feature = new GatewayFeature('gateway', baseConfig({ dataplaneMode: 'none' }));
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label'));
  expect(labelCall).toBeUndefined();
});
