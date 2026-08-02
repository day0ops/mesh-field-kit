// test/lib/istioctl.test.js
import { test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { CommandRunner } from '../../src/lib/common.js';
import { IstioctlHelper } from '../../src/lib/istioctl.js';

let execSpy;
let resolveSpy;
let capturedCommand;
let execResult;

beforeEach(() => {
  capturedCommand = null;
  execResult = { exitCode: 0, stdout: '', stderr: '' };
  resolveSpy = spyOn(IstioctlHelper, 'resolve').mockResolvedValue('solo-istioctl');
  execSpy = spyOn(CommandRunner, 'exec').mockImplementation(async (command) => {
    capturedCommand = command;
    return execResult;
  });
});

afterEach(() => {
  resolveSpy.mockRestore();
  execSpy.mockRestore();
});

test('vmAddWorkload builds --external/--hostname flags and parses BOOTSTRAP_TOKEN', async () => {
  execResult = {
    exitCode: 0,
    stdout: 'Start ztunnel on the VM with:\n  BOOTSTRAP_TOKEN=abc123 ztunnel\n',
  };

  const result = await IstioctlHelper.vmAddWorkload({
    name: 'app1',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:8080',
    external: true,
    hostname: 'my-vm',
    outputDir: '/tmp/tokens',
  });

  expect(capturedCommand).toContain('vm add-workload app1');
  expect(capturedCommand).toContain('--address 1.2.3.4');
  expect(capturedCommand).toContain('--namespace vm-apps');
  expect(capturedCommand).toContain('--ports http:80:8080');
  expect(capturedCommand).toContain('--output-dir /tmp/tokens');
  expect(capturedCommand).toContain('--external');
  expect(capturedCommand).toContain('--hostname my-vm');
  expect(result.bootstrapToken).toBe('abc123');
  expect(result.tokenFile).toBe('/tmp/tokens/app1.token');
});

test('vmAddWorkload omits --external/--hostname for subsequent workloads', async () => {
  await IstioctlHelper.vmAddWorkload({
    name: 'app2',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:9090',
    outputDir: '/tmp/tokens',
  });

  expect(capturedCommand).not.toContain('--external');
  expect(capturedCommand).not.toContain('--hostname');
});

test('vmAddWorkload joins multi-port specs with a single --ports flag', async () => {
  await IstioctlHelper.vmAddWorkload({
    name: 'app1',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:8080/grpc:9090',
    outputDir: '/tmp/tokens',
  });

  expect(capturedCommand).toContain('--ports http:80:8080/grpc:9090');
});

test('vmAddWorkload returns a null bootstrapToken when none is printed', async () => {
  execResult = { exitCode: 0, stdout: 'Configured service account vm-apps/app2\n' };

  const result = await IstioctlHelper.vmAddWorkload({
    name: 'app2',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:9090',
    outputDir: '/tmp/tokens',
  });

  expect(result.bootstrapToken).toBeNull();
});

test('vmAddWorkload throws with command output on non-zero exit', async () => {
  execResult = { exitCode: 1, stdout: '', stderr: 'namespace not found' };

  await expect(IstioctlHelper.vmAddWorkload({
    name: 'app1',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:8080',
    outputDir: '/tmp/tokens',
  })).rejects.toThrow(/namespace not found/);
});

test('vmAddWorkload throws when istioctl cannot be resolved', async () => {
  resolveSpy.mockResolvedValue(null);

  await expect(IstioctlHelper.vmAddWorkload({
    name: 'app1',
    address: '1.2.3.4',
    namespace: 'vm-apps',
    ports: 'http:80:8080',
    outputDir: '/tmp/tokens',
  })).rejects.toThrow(/Failed to resolve istioctl/);
});
