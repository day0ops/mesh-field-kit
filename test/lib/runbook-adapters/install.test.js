// test/lib/runbook-adapters/install.test.js
import { test, expect } from 'bun:test';
import { InstallAdapter } from '../../../src/lib/runbook-adapters/install.js';

const singleClusterSelection = {
  infraProfile: {
    spec: {
      name: 'maple',
      provider: 'eks',
      clusters: [{ name: 'east' }],
    },
  },
  profile: {
    metadata: { name: 'test-profile' },
    spec: {
      mesh: {
        istioVersion: '1.30.0',
        gatewayApiVersion: 'v1.4.0',
        profile: 'ambient',
        image: {
          tag: '1.30.0-solo',
          istioRepo: 'us-docker.pkg.dev/soloio-img/istio',
          helmIstioRepo: 'us-docker.pkg.dev/soloio-img/istio-helm',
        },
        components: [
          { name: 'base', values: { defaultRevision: '' } },
          {
            name: 'istiod',
            values: { global: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          },
          { name: 'cni', values: { ambient: { dnsCapture: true } } },
          { name: 'ztunnel', values: { multiCluster: { clusterName: '{{cluster.name}}' } } },
        ],
      },
    },
  },
};

const multiClusterSelection = {
  infraProfile: {
    spec: {
      name: 'maple',
      provider: 'eks',
      clusters: [{ name: 'east' }, { name: 'west' }],
    },
  },
  profile: {
    metadata: { name: 'test-profile' },
    spec: {
      mesh: {
        istioVersion: '1.30.0',
        gatewayApiVersion: 'v1.4.0',
        profile: 'ambient',
        peering: 'helm',
        certificates: { mode: 'self-signed' },
        image: {
          tag: '1.30.0-solo',
          istioRepo: 'us-docker.pkg.dev/soloio-img/istio',
          helmIstioRepo: 'us-docker.pkg.dev/soloio-img/istio-helm',
        },
        components: [
          { name: 'base', values: {} },
          {
            name: 'istiod',
            values: { global: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          },
          { name: 'cni', values: {} },
          { name: 'ztunnel', values: { multiCluster: { clusterName: '{{cluster.name}}' } } },
          { name: 'peering-eastwest', values: { eastwest: { cluster: '{{cluster.name}}' } } },
          { name: 'peering-remote', values: { trustDomain: '{{cluster.name}}.local' } },
        ],
      },
    },
  },
};

test('InstallAdapter.generate produces Lab 3 heading', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('## Lab 4');
  expect(md).toContain('Istio Ambient');
});

test('InstallAdapter.generate includes Gateway API CRDs install', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('gateway-api/releases/download/v1.4.0/standard-install.yaml');
  expect(md).toContain('Gateway API CRDs');
});

test('InstallAdapter.generate includes helm install commands for all non-deferred components', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('istio-base');
  expect(md).toContain('istiod');
  expect(md).toContain('istio-cni');
  expect(md).toContain('ztunnel');
  // peering-remote is deferred — should not appear
  expect(md).not.toContain('peering-remote');
});

test('InstallAdapter.generate uses OCI helm repo from profile', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('oci://us-docker.pkg.dev/soloio-img/istio-helm');
  expect(md).toContain('1.30.0-solo');
});

test('InstallAdapter.generate passes the license as a --set-string flag, not inside the single-quoted heredoc', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  // A $VAR reference inside `-f - <<'EOF' ... EOF` never gets shell-expanded — it must be
  // passed as a separate --set-string flag instead.
  expect(md).toContain('--set-string license.value=$ENTERPRISE_ISTIO_LICENSE');
  expect(md).not.toContain('license:');
});

test('InstallAdapter.generate resolves {{cluster.name}} templates', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  // Template variable should be resolved to actual cluster name
  expect(md).not.toContain('{{cluster.name}}');
  expect(md).toContain('east');
});

test('InstallAdapter.generate labels namespace with network topology', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, singleClusterSelection);
  expect(md).toContain('topology.istio.io/network=east');
});

test('InstallAdapter.generateCertSetup emits Cluster Bootstrap cert setup for multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, multiClusterSelection);
  expect(md).toContain('## Lab 5 — Cluster Bootstrap');
  expect(md).toContain('Root CA');
  expect(md).toContain('cacerts');
  expect(md).toContain('Intermediate CA');
});

test('InstallAdapter.generateCertSetup appends extra preamble sections', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generateCertSetup(5, multiClusterSelection, [
    '**Generate independent SPIRE roots**',
  ]);
  expect(md).toContain('**Generate independent SPIRE roots**');
});

test('InstallAdapter.generateCertSetup is empty for single cluster with no preambles', () => {
  const adapter = new InstallAdapter();
  expect(adapter.generateCertSetup(5, singleClusterSelection)).toBe('');
});

test('InstallAdapter.generate no longer inlines cert setup (moved to Cluster Bootstrap)', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(7, multiClusterSelection);
  expect(md).not.toContain('Set Up Shared Root of Trust');
});

test('InstallAdapter.generate installs on both clusters in multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  expect(md).toContain('### Install on `east`');
  expect(md).toContain('### Install on `west`');
});

test('InstallAdapter.generate includes cluster linking for multicluster', () => {
  const adapter = new InstallAdapter();
  const md = adapter.generate(4, multiClusterSelection);
  // helm peering method — should show peering-remote install
  expect(md).toContain('Link Clusters');
  expect(md).toContain('peering-remote');
});

test('InstallAdapter.generateCleanupSections uninstalls components in reverse per cluster', () => {
  const adapter = new InstallAdapter();
  const sections = adapter.generateCleanupSections(9, multiClusterSelection, 1);
  expect(sections).toHaveLength(1);
  const md = sections[0];
  expect(md).toContain('### Lab 9.1 — Uninstall');
  expect(md).toContain('helm uninstall ztunnel --kube-context=$EAST_CONTEXT');
  expect(md).toContain('helm uninstall peering-remote --kube-context=$EAST_CONTEXT');
  // reverse order: ztunnel uninstalled before istio-base
  expect(md.indexOf('helm uninstall ztunnel')).toBeLessThan(
    md.indexOf('helm uninstall istio-base')
  );
});

test('InstallAdapter envVars returns empty array', () => {
  const adapter = new InstallAdapter();
  expect(adapter.envVars(singleClusterSelection)).toEqual([]);
});

test('InstallAdapter envExports returns empty array', () => {
  const adapter = new InstallAdapter();
  expect(adapter.envExports(singleClusterSelection)).toEqual([]);
});
