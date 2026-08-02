import { test, expect } from 'bun:test';
import { SpireFeature } from '../../addons/spire/index.js';
import { join } from 'path';
import { tmpdir } from 'os';

test('SpireFeature constructor sets defaults', () => {
  const f = new SpireFeature('spire', { clusterName: 'my-cluster' });
  expect(f.spireNamespace).toBe('spire-server');
  expect(f.trustDomain).toBe('my-cluster');
  expect(f.spireVersion).toBe('0.24.2');
  expect(f.spireCrdsVersion).toBe('0.5.0');
  expect(f.certMode).toBe('self-signed');
  expect(f.kubeContext).toBeNull();
});

test('SpireFeature constructor respects overrides', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'my-cluster',
    trustDomain: 'custom.domain',
    spireNamespace: 'custom-spire',
    spireVersion: '0.25.0',
    spireCrdsVersion: '0.6.0',
    certMode: 'cert-manager',
    kubeContext: 'ctx1',
  });
  expect(f.spireNamespace).toBe('custom-spire');
  expect(f.trustDomain).toBe('custom.domain');
  expect(f.spireVersion).toBe('0.25.0');
  expect(f.spireCrdsVersion).toBe('0.6.0');
  expect(f.certMode).toBe('cert-manager');
  expect(f.kubeContext).toBe('ctx1');
});

test('SpireFeature validate passes for self-signed', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'self-signed' });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate passes for cert-manager', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate throws for manual without cert paths', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'manual' });
  expect(() => f.validate()).toThrow('manual certMode requires certs.caCert, certs.caKey, and certs.caChain');
});

test('SpireFeature validate passes for manual with all cert paths', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'c1',
    certMode: 'manual',
    certs: { caCert: '/a/ca.crt', caKey: '/a/ca.key', caChain: '/a/chain.pem' },
  });
  expect(f.validate()).toBe(true);
});

test('SpireFeature validate throws for unknown certMode', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'bogus' });
  expect(() => f.validate()).toThrow("Invalid certMode 'bogus'. Must be: self-signed, cert-manager, manual");
});

test('SpireFeature certsWorkDir returns path under tmpdir', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1' });
  const expected = join(tmpdir(), 'mesh-spire-certs');
  expect(f.certsWorkDir).toBe(expected);
});

test('SpireFeature validate throws for cert-manager mode missing cert-manager addon hint', () => {
  // No throw — cert-manager presence check is at runtime, not validate()
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.validate()).toBe(true); // validate doesn't require clusterAddons
});

test('SpireFeature certManagerIssuerRef defaults', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1', certMode: 'cert-manager' });
  expect(f.certManagerIssuerRef).toEqual({ name: 'selfsigned-issuer', kind: 'ClusterIssuer' });
});

test('SpireFeature certManagerIssuerRef uses config override', () => {
  const f = new SpireFeature('spire', {
    clusterName: 'c1',
    certMode: 'cert-manager',
    certManager: { issuerRef: { name: 'my-issuer', kind: 'Issuer' } },
  });
  expect(f.certManagerIssuerRef).toEqual({ name: 'my-issuer', kind: 'Issuer' });
});

test('SpireFeature buildSpireHelmValues includes trust domain and ztunnel delegate', () => {
  const f = new SpireFeature('spire', { clusterName: 'test-cluster' });
  const v = f.buildSpireHelmValues();
  expect(v.global.spire.trustDomain).toBe('test-cluster');
  expect(v['spire-agent'].authorizedDelegates).toContain(
    'spiffe://test-cluster/ns/istio-system/sa/ztunnel'
  );
  expect(v['spire-agent'].sockets.admin.enabled).toBe(true);
  expect(v['spire-agent'].sockets.admin.mountOnHost).toBe(true);
  expect(v['spire-agent'].sockets.hostBasePath).toBe('/run/spire/agent/sockets');
  expect(v['spire-server'].upstreamAuthority.disk.enabled).toBe(true);
  expect(v['spire-server'].upstreamAuthority.disk.secret.name).toBe('spiffe-upstream-ca');
});

test('SpireFeature cleanup method exists and is a function', () => {
  const f = new SpireFeature('spire', { clusterName: 'c1' });
  expect(typeof f.cleanup).toBe('function');
  // We can't run the real cleanup (requires a cluster), but we can verify
  // the method doesn't throw immediately on instantiation
  expect(f.cleanup).toBeDefined();
});

import '../../addons/index.js';
import { FeatureManager } from '../../src/lib/feature.js';

test('spire addon is registered in FeatureManager', () => {
  expect(FeatureManager.has('spire')).toBe(true);
});

import { generate as spireRunbookGenerate, cleanup as spireRunbookCleanup } from '../../addons/spire/runbook.js';

test('spire runbook generate returns markdown with helm commands', async () => {
  const addonCfg = { certMode: 'self-signed' };
  const md = await spireRunbookGenerate(1, addonCfg, 'my-cluster', {}, { spec: {} });
  expect(md).toContain('helm');
  expect(md).toContain('spire');
  expect(md).toContain('spiffe-upstream-ca');
});

test('spire runbook cleanup returns helm uninstall command', () => {
  const md = spireRunbookCleanup({ spireNamespace: 'spire-server' }, 'my-cluster');
  expect(md).toContain('helm uninstall spire');
});
