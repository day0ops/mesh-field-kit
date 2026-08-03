// test/lib/runbook-adapters/infra.test.js
import { test, expect } from 'bun:test';
import { InfraAdapter } from '../../../src/lib/runbook-adapters/infra.js';

const mockSelection = {
  profile: {
    metadata: { name: 'eks-multi-cluster-peering-with-agw-hub-spoke' },
    spec: { mesh: { gatewayApiVersion: 'v1.4.0' } },
  },
  infraProfile: {
    metadata: { name: 'eks-multi-cluster' },
    spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }, { name: 'west' }] },
  },
  environment: { spec: { aws: { region: 'ap-southeast-1' } } },
};

test('InfraAdapter.envVars returns ENTERPRISE_ISTIO_LICENSE and AWS_PROFILE as required', () => {
  const adapter = new InfraAdapter();
  const vars = adapter.envVars(mockSelection);
  const names = vars.map(v => v.name);
  expect(names).toContain('ENTERPRISE_ISTIO_LICENSE');
  expect(names).toContain('AWS_PROFILE');
  expect(vars.every(v => v.required === true)).toBe(true);
});

test('InfraAdapter.envExports returns AWS_REGION and INFRA_NAME', () => {
  const adapter = new InfraAdapter();
  const exports = adapter.envExports(mockSelection);
  const names = exports.map(e => e.name);
  expect(names).toContain('AWS_REGION');
  expect(names).toContain('INFRA_NAME');
  const region = exports.find(e => e.name === 'AWS_REGION');
  expect(region.value).toBe('ap-southeast-1');
});

test('InfraAdapter.generate produces Lab 0 with prereqs, credentials, terraform, and kubeconfig', () => {
  const adapter = new InfraAdapter();
  const md = adapter.generate(0, mockSelection);
  expect(md).toContain('## Lab 0');
  expect(md).toContain('kubectl');
  expect(md).toContain('helm');
  expect(md).toContain('terraform');
  expect(md).toContain('AWS_PROFILE');
  expect(md).toContain('github.com/day0ops/terraform-cloud-provisioner');
  expect(md).toContain('environments/eks/terraform.tfvars');
  expect(md).toContain('eks_kubeconfig');
});
