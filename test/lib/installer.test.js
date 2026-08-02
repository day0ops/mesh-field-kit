// test/lib/installer.test.js
import { test, expect } from 'bun:test';
import { buildComponentBaseValues } from '../../src/lib/installer.js';

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
