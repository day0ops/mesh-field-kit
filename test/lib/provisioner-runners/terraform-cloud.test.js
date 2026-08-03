// test/lib/provisioner-runners/terraform-cloud.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TerraformCloudRunner } from '../../../src/lib/provisioner-runners/terraform-cloud.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tf-cloud-vm-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRunner({ vms = [], clusters } = {}) {
  const defaultClusters = [
    {
      name: 'east',
      provisioner: {
        type: 'eks',
        owner: 'kasunt',
        region: 'ap-southeast-1',
        cluster_name: 'maple',
      },
    },
  ];
  return new TerraformCloudRunner('eks-multi-cluster', clusters || defaultClusters, {
    outputDir: dir,
    kubeconfigDir: join(dir, 'kubeconfig'),
    vms,
  });
}

function multiClusterList() {
  return [
    {
      name: 'east',
      provisioner: {
        type: 'eks',
        owner: 'kasunt',
        region: 'ap-southeast-1',
        cluster_name: 'maple',
      },
    },
    {
      name: 'west',
      provisioner: {
        type: 'eks',
        owner: 'kasunt',
        region: 'ap-southeast-1',
        cluster_name: 'maple',
      },
    },
  ];
}

test('resolveConfiguration reports enableVm false with no vms', () => {
  const config = makeRunner().resolveConfiguration();
  expect(config.enableVm).toBe(false);
  expect(config.vmInstanceType).toBeUndefined();
});

test('resolveConfiguration reports enableVm true with vms configured', () => {
  const config = makeRunner({ vms: [{ name: 'vm1', role: 'workload' }] }).resolveConfiguration();
  expect(config.enableVm).toBe(true);
});

test('resolveConfiguration passes through per-vm instance_type', () => {
  const config = makeRunner({
    vms: [{ name: 'vm1', instance_type: 't3.small' }],
  }).resolveConfiguration();
  expect(config.vmInstanceType).toBe('t3.small');
});

test('writeTerraformVars emits enable_vm and vm_instance_type when enabled', () => {
  const runner = makeRunner({ vms: [{ name: 'vm1', instance_type: 't3.small' }] });
  runner.ensureDirectories();
  runner.writeTerraformVars(runner.resolveConfiguration());

  const content = readFileSync(runner.varFile, 'utf8');
  expect(content).toContain('enable_vm = true');
  expect(content).toContain('vm_instance_type = "t3.small"');
});

test('writeTerraformVars omits enable_vm when no vms configured', () => {
  const runner = makeRunner();
  runner.ensureDirectories();
  runner.writeTerraformVars(runner.resolveConfiguration());

  const content = readFileSync(runner.varFile, 'utf8');
  expect(content).not.toContain('enable_vm');
});

test('resolveConfiguration defaults vmClusterIndex to 0 with a single cluster', () => {
  const config = makeRunner({ vms: [{ name: 'vm1', cluster: 'east' }] }).resolveConfiguration();
  expect(config.vmClusterIndex).toBe(0);
});

test('resolveConfiguration resolves vmClusterIndex from vm.cluster in a multi-cluster list', () => {
  const config = makeRunner({
    clusters: multiClusterList(),
    vms: [{ name: 'vm1', cluster: 'west' }],
  }).resolveConfiguration();
  expect(config.vmClusterIndex).toBe(1);
});

test('resolveConfiguration falls back to index 0 for an unmatched vm.cluster', () => {
  const config = makeRunner({
    clusters: multiClusterList(),
    vms: [{ name: 'vm1', cluster: 'unknown' }],
  }).resolveConfiguration();
  expect(config.vmClusterIndex).toBe(0);
});

test('writeTerraformVars emits vm_cluster_index when enabled', () => {
  const runner = makeRunner({
    clusters: multiClusterList(),
    vms: [{ name: 'vm1', cluster: 'west' }],
  });
  runner.ensureDirectories();
  runner.writeTerraformVars(runner.resolveConfiguration());

  const content = readFileSync(runner.varFile, 'utf8');
  expect(content).toContain('vm_cluster_index = 1');
});
