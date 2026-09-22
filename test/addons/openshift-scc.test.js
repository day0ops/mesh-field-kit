import { test, expect } from 'bun:test';
import { OpenshiftSccFeature } from '../../addons/openshift-scc/index.js';

test('OpenshiftSccFeature constructor sets defaults', () => {
  const f = new OpenshiftSccFeature('openshift-scc', {});
  expect(f.sccNamespace).toBe('kube-system');
  expect(f.scc).toBe('privileged');
  expect(f.kubeContext).toBeNull();
  expect(f.enableRoutingViaHost).toBe(true);
  expect(f.enablePodSecurityLabel).toBe(true);
});

test('OpenshiftSccFeature constructor respects overrides', () => {
  const f = new OpenshiftSccFeature('openshift-scc', {
    namespace: 'custom-ns',
    scc: 'anyuid',
    kubeContext: 'ctx1',
    enableRoutingViaHost: false,
    enablePodSecurityLabel: false,
  });
  expect(f.sccNamespace).toBe('custom-ns');
  expect(f.scc).toBe('anyuid');
  expect(f.kubeContext).toBe('ctx1');
  expect(f.enableRoutingViaHost).toBe(false);
  expect(f.enablePodSecurityLabel).toBe(false);
});
