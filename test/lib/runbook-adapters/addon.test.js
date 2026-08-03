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
