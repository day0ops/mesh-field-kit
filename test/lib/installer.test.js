// test/lib/installer.test.js
import { test, expect, describe } from 'bun:test';
import {
  buildComponentBaseValues,
  resolveComponentNamespace,
  InstallerManager,
} from '../../src/lib/installer.js';

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

describe('InstallerManager.orderForCleanup', () => {
  test('defers cert-manager, external-dns, aws-load-balancer-controller, and CNI addons to the end, in that priority order', () => {
    const addons = [
      { name: 'cilium' },
      { name: 'aws-load-balancer-controller' },
      { name: 'external-dns' },
      { name: 'keycloak' },
      { name: 'cert-manager' },
      { name: 'solo-ui' },
    ];
    const ordered = InstallerManager.orderForCleanup(addons);
    expect(ordered.map(a => a.name)).toEqual([
      'solo-ui',
      'keycloak',
      'cert-manager',
      'external-dns',
      'aws-load-balancer-controller',
      'cilium',
    ]);
  });

  test('reverses install order for the non-deferred addons', () => {
    const addons = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual(['c', 'b', 'a']);
  });

  test('supports addon entries given as plain strings', () => {
    const addons = ['aws-load-balancer-controller', 'keycloak', 'calico'];
    expect(InstallerManager.orderForCleanup(addons)).toEqual([
      'keycloak',
      'aws-load-balancer-controller',
      'calico',
    ]);
  });

  test('cilium/calico stay last even when cert-manager/external-dns/aws-load-balancer-controller are absent', () => {
    const addons = [{ name: 'calico' }, { name: 'keycloak' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual([
      'keycloak',
      'calico',
    ]);
  });

  test('is a no-op when none of the deferred addons are present', () => {
    const addons = [{ name: 'keycloak' }, { name: 'solo-ui' }];
    expect(InstallerManager.orderForCleanup(addons).map(a => a.name)).toEqual([
      'solo-ui',
      'keycloak',
    ]);
  });

  test('handles an empty list', () => {
    expect(InstallerManager.orderForCleanup([])).toEqual([]);
  });
});
