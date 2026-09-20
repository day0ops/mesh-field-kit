import { test, expect } from 'bun:test';
import { OpenshiftSccFeature } from '../../addons/openshift-scc/index.js';

test('OpenshiftSccFeature constructor sets defaults', () => {
  const f = new OpenshiftSccFeature('openshift-scc', {});
  expect(f.sccNamespace).toBe('kube-system');
  expect(f.scc).toBe('privileged');
  expect(f.kubeContext).toBeNull();
});

test('OpenshiftSccFeature constructor respects overrides', () => {
  const f = new OpenshiftSccFeature('openshift-scc', {
    namespace: 'custom-ns',
    scc: 'anyuid',
    kubeContext: 'ctx1',
  });
  expect(f.sccNamespace).toBe('custom-ns');
  expect(f.scc).toBe('anyuid');
  expect(f.kubeContext).toBe('ctx1');
});
