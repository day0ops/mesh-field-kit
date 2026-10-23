// test/features/security/certificate.test.js
import { test, expect } from 'bun:test';
import { CertificateFeature } from '../../../features/security/certificate/index.js';
import { CommandRunner, KubernetesHelper } from '../../../src/lib/common.js';

function baseConfig(overrides = {}) {
  return {
    secretName: 'test-tls',
    namespace: 'test-ns',
    hostname: 'test.example.com',
    ...overrides,
  };
}

test('CertificateFeature.validate throws when secretName is missing', () => {
  const feature = new CertificateFeature('certificate', {
    namespace: 'test-ns',
    hostname: 'test.example.com',
  });
  expect(() => feature.validate()).toThrow('secretName is required');
});

test('CertificateFeature.validate throws when namespace is missing', () => {
  const feature = new CertificateFeature('certificate', {
    secretName: 'test-tls',
    hostname: 'test.example.com',
  });
  expect(() => feature.validate()).toThrow('namespace is required');
});

test('CertificateFeature.validate throws when hostname is missing', () => {
  const feature = new CertificateFeature('certificate', {
    secretName: 'test-tls',
    namespace: 'test-ns',
  });
  expect(() => feature.validate()).toThrow('hostname is required');
});

test('CertificateFeature.validate passes with all required fields', () => {
  const feature = new CertificateFeature('certificate', baseConfig());
  expect(feature.validate()).toBe(true);
});

test('CertificateFeature.buildCertificateManifest produces the expected shape', () => {
  const feature = new CertificateFeature('certificate', baseConfig());
  const manifest = feature.buildCertificateManifest();

  expect(manifest.apiVersion).toBe('cert-manager.io/v1');
  expect(manifest.kind).toBe('Certificate');
  expect(manifest.metadata).toEqual({ name: 'test-tls', namespace: 'test-ns' });
  expect(manifest.spec.secretName).toBe('test-tls');
  expect(manifest.spec.issuerRef).toEqual({ name: 'selfsigned-issuer', kind: 'ClusterIssuer' });
  expect(manifest.spec.commonName).toBe('test.example.com');
  expect(manifest.spec.dnsNames).toEqual(['test.example.com']);
  expect(manifest.spec.subject.organizations).toEqual(['solo.io']);
});

test('CertificateFeature.buildCertificateManifest honors clusterIssuerName and organization overrides', () => {
  const feature = new CertificateFeature(
    'certificate',
    baseConfig({ clusterIssuerName: 'letsencrypt-dns', organization: 'acme-bank' })
  );
  const manifest = feature.buildCertificateManifest();

  expect(manifest.spec.issuerRef.name).toBe('letsencrypt-dns');
  expect(manifest.spec.subject.organizations).toEqual(['acme-bank']);
});

test('CertificateFeature.deploy applies the manifest and waits for readiness', async () => {
  const feature = new CertificateFeature('certificate', baseConfig());
  const originalExec = CommandRunner.exec;
  const originalKubectl = KubernetesHelper.kubectl;
  const execCalls = [];
  let kubectlCallCount = 0;

  CommandRunner.exec = async command => {
    execCalls.push(command);
    return { stdout: '', stderr: '' };
  };
  // First poll: not ready. Second poll: ready. Proves waitForReady actually polls
  // rather than trusting the first response.
  KubernetesHelper.kubectl = async () => {
    kubectlCallCount++;
    return { stdout: kubectlCallCount < 2 ? '' : 'True' };
  };

  try {
    await feature.deploy();
  } finally {
    CommandRunner.exec = originalExec;
    KubernetesHelper.kubectl = originalKubectl;
  }

  const applyCall = execCalls.find(c => c.includes('apply -f'));
  expect(applyCall).toBeDefined();
  expect(kubectlCallCount).toBeGreaterThanOrEqual(2);
});

test('CertificateFeature.deploy throws if the certificate never becomes ready', async () => {
  const feature = new CertificateFeature('certificate', baseConfig());
  const originalExec = CommandRunner.exec;
  const originalKubectl = KubernetesHelper.kubectl;

  CommandRunner.exec = async () => ({ stdout: '', stderr: '' });
  KubernetesHelper.kubectl = async () => ({ stdout: '' });

  try {
    await expect(feature.waitForReady('test-tls', 'test-ns', 2)).rejects.toThrow(
      'did not become Ready'
    );
  } finally {
    CommandRunner.exec = originalExec;
    KubernetesHelper.kubectl = originalKubectl;
  }
});

test('CertificateFeature.cleanup deletes the Certificate resource', async () => {
  const feature = new CertificateFeature('certificate', baseConfig());
  const originalExec = CommandRunner.exec;
  const execCalls = [];
  CommandRunner.exec = async command => {
    execCalls.push(command);
    return { stdout: '', stderr: '' };
  };

  try {
    await feature.cleanup();
  } finally {
    CommandRunner.exec = originalExec;
  }

  const deleteCall = execCalls.find(c => c.includes('delete certificate test-tls'));
  expect(deleteCall).toBeDefined();
});
