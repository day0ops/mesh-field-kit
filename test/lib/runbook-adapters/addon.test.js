// test/lib/runbook-adapters/addon.test.js
import { test, expect } from 'bun:test';
import { AddonAdapter } from '../../../src/lib/runbook-adapters/addon.js';

const mockSelection = {
  profile: {
    spec: {
      addons: {
        global: [
          { name: 'cilium', version: '1.19.4' },
          { name: 'cert-manager', version: '1.20.2' },
        ],
        clusters: [
          { name: 'east', addons: [{ name: 'external-dns' }, { name: 'keycloak' }] },
          { name: 'west', addons: [{ name: 'telemetry', config: { mode: 'agent' } }] },
        ],
      },
    },
  },
  environment: { spec: {} },
};

test('AddonAdapter._iterateAddons returns global addons first', async () => {
  const adapter = new AddonAdapter();
  const addons = await adapter._iterateAddons(mockSelection);
  expect(addons[0].addon.name).toBe('cilium');
  expect(addons[0].clusterName).toBe('global');
  expect(addons[1].addon.name).toBe('cert-manager');
  expect(addons[1].clusterName).toBe('global');
});

test('AddonAdapter._iterateAddons preserves per-cluster order after globals', async () => {
  const adapter = new AddonAdapter();
  const addons = await adapter._iterateAddons(mockSelection);
  const names = addons.map(a => `${a.addon.name}@${a.clusterName}`);
  expect(names).toEqual([
    'cilium@global',
    'cert-manager@global',
    'external-dns@east',
    'keycloak@east',
    'telemetry@west',
  ]);
});

test('AddonAdapter._iterateAddons returns null sidecar for unknown addon', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'nonexistent-addon-xyz' }], clusters: [] } } },
    environment: { spec: {} },
  };
  const addons = await adapter._iterateAddons(selection);
  expect(addons[0].addon.name).toBe('nonexistent-addon-xyz');
  expect(addons[0].sidecar).toBeNull();
});

test('AddonAdapter.generate includes Lab heading and sub-lab headings', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'nonexistent-xyz' }], clusters: [] } } },
    environment: { spec: {} },
  };
  const md = await adapter.generate(3, selection);
  expect(md).toContain('## Lab 3');
  expect(md).toContain('### Lab 3.1');
  expect(md).toContain('nonexistent-xyz');
});

test('AddonAdapter._iterateAddons expands global addons per cluster when infraProfile present', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: { spec: { addons: { global: [{ name: 'cilium' }], clusters: [] } } },
    infraProfile: { spec: { clusters: [{ name: 'east' }, { name: 'west' }] } },
    environment: { spec: {} },
  };
  const addons = await adapter._iterateAddons(selection);
  const names = addons.map(a => `${a.addon.name}@${a.clusterName}`);
  expect(names).toEqual(['cilium@east', 'cilium@west']);
});

test('AddonAdapter.generatePreambles collects spire distinctRoots preamble', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: {
      spec: {
        addons: {
          global: [],
          clusters: [
            { name: 'east', addons: [{ name: 'spire', config: { distinctRoots: true } }] },
            { name: 'west', addons: [{ name: 'spire', config: { distinctRoots: true } }] },
          ],
        },
      },
    },
    environment: { spec: {} },
  };
  const preambles = await adapter.generatePreambles(selection);
  expect(preambles).toHaveLength(1);
  expect(preambles[0]).toContain('Generate independent SPIRE roots');
  // No markdown heading — it's a plain paragraph
  expect(preambles[0].startsWith('#')).toBe(false);
});

test('AddonAdapter.generateCleanupSections lists addons in reverse order', async () => {
  const adapter = new AddonAdapter();
  const selection = {
    profile: {
      spec: {
        addons: {
          global: [{ name: 'cilium' }],
          clusters: [{ name: 'east', addons: [{ name: 'cert-manager' }] }],
        },
      },
    },
    infraProfile: { spec: { clusters: [{ name: 'east' }] } },
    environment: { spec: {} },
  };
  const sections = await adapter.generateCleanupSections(9, selection, 1);
  expect(sections).toHaveLength(1);
  expect(sections[0]).toContain('### Lab 9.1 — Uninstall Addons');
  // cert-manager (per-cluster) appears before cilium (global) after reversing
  expect(sections[0].indexOf('cert-manager')).toBeLessThan(sections[0].indexOf('cilium'));
});
