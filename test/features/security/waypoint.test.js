// test/features/security/waypoint.test.js
import { test, expect } from 'bun:test';
import { WaypointFeature } from '../../../features/security/waypoint/index.js';
import { CommandRunner, KubernetesHelper } from '../../../src/lib/common.js';

function baseConfig(overrides = {}) {
  return {
    waypointName: 'test-waypoint',
    namespace: 'wp-ns',
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

test('WaypointFeature.deploy labels the namespace ambient when dataplaneMode is unset', async () => {
  const feature = new WaypointFeature('waypoint', baseConfig());
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label') && args.includes('namespace'));
  expect(labelCall).toBeDefined();
  expect(labelCall).toContain('istio.io/dataplane-mode=ambient');
});

test("WaypointFeature.deploy does not label the namespace when dataplaneMode is 'none'", async () => {
  const feature = new WaypointFeature('waypoint', baseConfig({ dataplaneMode: 'none' }));
  const kubectlCalls = await deployCapturingLabelCalls(feature);

  const labelCall = kubectlCalls.find(args => args.includes('label') && args.includes('namespace'));
  expect(labelCall).toBeUndefined();
});
