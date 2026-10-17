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

async function cleanupCapturingExecCalls(feature) {
  const originalExec = CommandRunner.exec;
  const originalKubectl = KubernetesHelper.kubectl;
  const execCalls = [];
  CommandRunner.exec = async command => {
    execCalls.push(command);
    return { stdout: '', stderr: '' };
  };
  KubernetesHelper.kubectl = async () => ({ stdout: '' });
  try {
    await feature.cleanup();
  } finally {
    CommandRunner.exec = originalExec;
    KubernetesHelper.kubectl = originalKubectl;
  }
  return execCalls;
}

test('WaypointFeature.cleanup removes the namespace label without an invalid kubectl flag', async () => {
  const feature = new WaypointFeature('waypoint', baseConfig({ labels: { target: 'namespace' } }));
  const execCalls = await cleanupCapturingExecCalls(feature);

  const labelCall = execCalls.find(cmd => cmd.includes('label namespace'));
  expect(labelCall).toBeDefined();
  expect(labelCall).toContain('istio.io/use-waypoint-');
  expect(labelCall).not.toContain('--ignore-not-found');
});

test('WaypointFeature.cleanup removes the service label without an invalid kubectl flag', async () => {
  const feature = new WaypointFeature(
    'waypoint',
    baseConfig({ labels: { target: 'service', serviceName: 'test-svc' } })
  );
  const execCalls = await cleanupCapturingExecCalls(feature);

  const labelCall = execCalls.find(cmd => cmd.includes('label service'));
  expect(labelCall).toBeDefined();
  expect(labelCall).toContain('istio.io/use-waypoint-');
  expect(labelCall).not.toContain('--ignore-not-found');
});
