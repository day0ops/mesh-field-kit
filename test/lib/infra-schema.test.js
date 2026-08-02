// test/lib/infra-schema.test.js
import { test, expect } from 'bun:test';
import { InfraSchema } from '../../src/lib/infra-schema.js';

function baseProfile(overrides = {}) {
  return {
    apiVersion: 'mesh.demo/v1',
    kind: 'InfraProfile',
    metadata: { name: 'test-profile' },
    spec: {
      provider: 'eks',
      clusters: [{ name: 'demo', role: 'management' }],
      ...overrides,
    },
  };
}

test('validate passes for profile without spec.vms', () => {
  const result = InfraSchema.validate(baseProfile());
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('validate passes for profile with valid spec.vms', () => {
  const profile = baseProfile({ vms: [{ name: 'vm1', role: 'workload' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(true);
  expect(result.errors).toEqual([]);
});

test('validate rejects spec.vms that is not an array', () => {
  const profile = baseProfile({ vms: { name: 'vm1' } });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain('Invalid field: spec.vms (must be an array)');
});

test('validate rejects a vm entry missing name', () => {
  const profile = baseProfile({ vms: [{ role: 'workload' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain('spec.vms[0]: Missing required field: name');
});

test('validate rejects duplicate vm names', () => {
  const profile = baseProfile({ vms: [{ name: 'vm1' }, { name: 'vm1' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain('spec.vms[1]: Duplicate vm name: vm1');
});

test('validate rejects an invalid vm role', () => {
  const profile = baseProfile({ vms: [{ name: 'vm1', role: 'management' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain("spec.vms[0]: Invalid role: management. Valid values: workload");
});

test('validate rejects spec.vms on a non-eks provider', () => {
  const profile = baseProfile({ provider: 'gke', vms: [{ name: 'vm1' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain("spec.vms is only supported for provider 'eks' (got 'gke')");
});

test('validate allows empty spec.vms on a non-eks provider', () => {
  const profile = baseProfile({ provider: 'gke', vms: [] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(true);
});

test('getAllVms returns empty array when spec.vms is absent', () => {
  expect(InfraSchema.getAllVms(baseProfile())).toEqual([]);
});

test('getAllVms returns configured vms', () => {
  const vms = [{ name: 'vm1', role: 'workload' }];
  expect(InfraSchema.getAllVms(baseProfile({ vms }))).toEqual(vms);
});

test('isVmEnabled is false when spec.vms is absent or empty', () => {
  expect(InfraSchema.isVmEnabled(baseProfile())).toBe(false);
  expect(InfraSchema.isVmEnabled(baseProfile({ vms: [] }))).toBe(false);
});

test('isVmEnabled is true when spec.vms has entries', () => {
  const profile = baseProfile({ vms: [{ name: 'vm1' }] });
  expect(InfraSchema.isVmEnabled(profile)).toBe(true);
});

test('getValidVmRoles returns the vm role list', () => {
  expect(InfraSchema.getValidVmRoles()).toEqual(['workload']);
});

function multiClusterProfile(overrides = {}) {
  return baseProfile({
    clusters: [{ name: 'east', role: 'workload' }, { name: 'west', role: 'workload' }],
    ...overrides,
  });
}

test('validate passes when vm.cluster references an existing cluster', () => {
  const profile = multiClusterProfile({ vms: [{ name: 'vm1', cluster: 'west' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(true);
});

test('validate rejects vm.cluster referencing an unknown cluster', () => {
  const profile = multiClusterProfile({ vms: [{ name: 'vm1', cluster: 'north' }] });
  const result = InfraSchema.validate(profile);
  expect(result.valid).toBe(false);
  expect(result.errors).toContain('spec.vms[0]: Unknown cluster: north. Must be one of: east, west');
});

test('getVmClusterName returns the explicit cluster field', () => {
  const profile = multiClusterProfile();
  expect(InfraSchema.getVmClusterName(profile, { name: 'vm1', cluster: 'west' })).toBe('west');
});

test('getVmClusterName defaults to the first cluster when unset', () => {
  const profile = multiClusterProfile();
  expect(InfraSchema.getVmClusterName(profile, { name: 'vm1' })).toBe('east');
});

test('getVmClusterName returns null when there are no clusters', () => {
  const profile = baseProfile({ clusters: [] });
  expect(InfraSchema.getVmClusterName(profile, { name: 'vm1' })).toBeNull();
});
