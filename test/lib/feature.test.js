// test/lib/feature.test.js
import { test, expect } from 'bun:test';
import { Feature } from '../../src/lib/feature.js';
import { CommandRunner, KubernetesHelper } from '../../src/lib/common.js';

function withMockedKubectl(fn) {
  const originalExec = CommandRunner.exec;
  const originalKubectl = KubernetesHelper.kubectl;
  const kubectlCalls = [];
  CommandRunner.exec = async () => ({ stdout: '', stderr: '' });
  KubernetesHelper.kubectl = async args => {
    kubectlCalls.push(args);
    return { stdout: '' };
  };
  return fn(kubectlCalls).finally(() => {
    CommandRunner.exec = originalExec;
    KubernetesHelper.kubectl = originalKubectl;
  });
}

test('ensureNamespace defaults to ambient and logs the label claim', async () => {
  await withMockedKubectl(async kubectlCalls => {
    const logs = [];
    const feature = new Feature('test-feature', {});
    feature.log = msg => logs.push(msg);

    await feature.ensureNamespace('test-ns');

    const labelCall = kubectlCalls.find(args => args.includes('label'));
    expect(labelCall).toBeDefined();
    expect(labelCall).toContain('istio.io/dataplane-mode=ambient');
    expect(logs).toContain("Namespace 'test-ns' labeled for ambient mode");
  });
});

test("ensureNamespace with dataplaneMode 'none' skips labeling and logs accurately", async () => {
  await withMockedKubectl(async kubectlCalls => {
    const logs = [];
    const feature = new Feature('test-feature', {});
    feature.log = msg => logs.push(msg);

    await feature.ensureNamespace('test-ns', null, 'none');

    const labelCall = kubectlCalls.find(args => args.includes('label'));
    expect(labelCall).toBeUndefined();
    expect(logs).toContain("Namespace 'test-ns' left unlabeled (dataplane mode 'none')");
    expect(logs.some(msg => msg.includes('labeled for'))).toBe(false);
  });
});
