// test/lib/installer.test.js
import { test, expect } from 'bun:test';
import { buildComponentBaseValues, resolveComponentNamespace } from '../../src/lib/installer.js';

const cfg = {
  istioRevision: null,
  istioRepo: 'us-docker.pkg.dev/soloio-img/istio',
  istioImage: '1.30.3-solo',
  meshProfile: 'ambient',
  licenseKey: 'test-license',
};

test('istiod base values omit env by default', () => {
  const values = buildComponentBaseValues('istiod', cfg, 'east');
  expect(values.env).toBeUndefined();
});

test('istiod base values set REQUIRE_3P_TOKEN=false when isVmCluster is true', () => {
  const values = buildComponentBaseValues('istiod', cfg, 'east', true);
  expect(values.env).toEqual({ REQUIRE_3P_TOKEN: 'false' });
});

test('istiod base values omit env when isVmCluster is false', () => {
  const values = buildComponentBaseValues('istiod', cfg, 'east', false);
  expect(values.env).toBeUndefined();
});

test('isVmCluster does not affect other components', () => {
  const cni = buildComponentBaseValues('cni', cfg, 'east', true);
  const ztunnel = buildComponentBaseValues('ztunnel', cfg, 'east', true);
  expect(cni.env).toBeUndefined();
  expect(ztunnel.env).toEqual({ L7_ENABLED: 'true' });
});

test('resolveComponentNamespace uses a per-cluster componentNamespaces override', () => {
  const profile = {
    spec: {
      mesh: {
        clusters: [
          {
            name: 'rosa-cluster',
            componentNamespaces: { cni: 'kube-system', ztunnel: 'kube-system' },
          },
        ],
      },
    },
  };
  const cluster = { name: 'rosa-cluster' };
  const cfg = { namespace: 'istio-system' };

  expect(resolveComponentNamespace(profile, cluster, 'cni', cfg)).toBe('kube-system');
  expect(resolveComponentNamespace(profile, cluster, 'ztunnel', cfg)).toBe('kube-system');
  expect(resolveComponentNamespace(profile, cluster, 'istiod', cfg)).toBe('istio-system');
});

test('resolveComponentNamespace falls back to the global map then cfg.namespace', () => {
  const profile = { spec: { mesh: {} } };
  const cluster = { name: 'east' };
  const cfg = { namespace: 'istio-system' };

  expect(resolveComponentNamespace(profile, cluster, 'peering-eastwest', cfg)).toBe(
    'istio-eastwest'
  );
  expect(resolveComponentNamespace(profile, cluster, 'istiod', cfg)).toBe('istio-system');
});
