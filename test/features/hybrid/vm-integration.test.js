// test/features/hybrid/vm-integration.test.js
import { test, expect } from 'bun:test';
import { VmIntegrationFeature } from '../../../features/hybrid/vm-integration/index.js';

function baseConfig(overrides = {}) {
  return {
    namespace: 'vm-apps',
    vmIp: '1.2.3.4',
    sshKeyPath: '/tmp/vm-key.pem',
    workloads: [{ name: 'app1', ports: ['http:80:8080'] }],
    ...overrides,
  };
}

test('validate passes with a complete config', () => {
  const f = new VmIntegrationFeature('vm-integration', baseConfig());
  expect(f.validate()).toBe(true);
});

test('validate throws when namespace is missing', () => {
  const config = baseConfig();
  delete config.namespace;
  const f = new VmIntegrationFeature('vm-integration', config);
  expect(() => f.validate()).toThrow('namespace is required for VM Integration feature');
});

test('validate throws when vmIp is missing', () => {
  const config = baseConfig();
  delete config.vmIp;
  const f = new VmIntegrationFeature('vm-integration', config);
  expect(() => f.validate()).toThrow('vmIp is required for VM Integration feature');
});

test('validate throws when sshKeyPath is missing', () => {
  const config = baseConfig();
  delete config.sshKeyPath;
  const f = new VmIntegrationFeature('vm-integration', config);
  expect(() => f.validate()).toThrow('sshKeyPath is required for VM Integration feature');
});

test('validate throws when workloads is empty', () => {
  const f = new VmIntegrationFeature('vm-integration', baseConfig({ workloads: [] }));
  expect(() => f.validate()).toThrow(
    'workloads is required for VM Integration feature (at least one workload)'
  );
});

test('validate throws when a workload is missing a name', () => {
  const f = new VmIntegrationFeature(
    'vm-integration',
    baseConfig({ workloads: [{ ports: ['http:80:8080'] }] })
  );
  expect(() => f.validate()).toThrow('Each VM workload requires a name');
});

test('validate throws when a workload is missing ports', () => {
  const f = new VmIntegrationFeature(
    'vm-integration',
    baseConfig({ workloads: [{ name: 'app1' }] })
  );
  expect(() => f.validate()).toThrow(
    "VM workload 'app1' requires at least one port (e.g. 'http:80:8080')"
  );
});

test('validate passes with multiple workloads', () => {
  const f = new VmIntegrationFeature(
    'vm-integration',
    baseConfig({
      workloads: [
        { name: 'app1', ports: ['http:80:8080'] },
        { name: 'app2', ports: ['http:80:9090'] },
      ],
    })
  );
  expect(f.validate()).toBe(true);
});
