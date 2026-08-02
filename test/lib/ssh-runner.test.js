// test/lib/ssh-runner.test.js
import { test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { CommandRunner } from '../../src/lib/common.js';
import { SshRunner } from '../../src/lib/ssh-runner.js';

let execSpy;
let capturedCommand;
let capturedOptions;

beforeEach(() => {
  capturedCommand = null;
  capturedOptions = null;
  execSpy = spyOn(CommandRunner, 'exec').mockImplementation(async (command, options) => {
    capturedCommand = command;
    capturedOptions = options;
    return { stdout: '', stderr: '', exitCode: 0 };
  });
});

afterEach(() => {
  execSpy.mockRestore();
});

test('exec builds a quoted ssh command with the default user', async () => {
  const runner = new SshRunner('/tmp/key.pem');
  await runner.exec('1.2.3.4', 'echo hello');

  expect(capturedCommand).toContain("ssh -i '/tmp/key.pem'");
  expect(capturedCommand).toContain('ec2-user@1.2.3.4');
  expect(capturedCommand).toContain("'echo hello'");
});

test('exec uses a custom user when provided', async () => {
  const runner = new SshRunner('/tmp/key.pem', 'ubuntu');
  await runner.exec('1.2.3.4', 'whoami');

  expect(capturedCommand).toContain('ubuntu@1.2.3.4');
});

test('exec safely escapes a command containing single quotes', async () => {
  const runner = new SshRunner('/tmp/key.pem');
  await runner.exec('1.2.3.4', "echo 'hi there'");

  // A naive '<cmd>' wrap would break here; escaped quotes must survive intact.
  expect(capturedCommand).toContain(`echo '\\''hi there'\\''`);
});

test('exec forwards options through to CommandRunner.exec', async () => {
  const runner = new SshRunner('/tmp/key.pem');
  await runner.exec('1.2.3.4', 'echo hi', { ignoreError: true });

  expect(capturedOptions).toEqual({ ignoreError: true });
});

test('copyFile builds a quoted scp command', async () => {
  const runner = new SshRunner('/tmp/key.pem');
  await runner.copyFile('/local/file.txt', '1.2.3.4', '/remote/file.txt');

  expect(capturedCommand).toContain('scp -i');
  expect(capturedCommand).toContain("'/local/file.txt'");
  expect(capturedCommand).toContain("'ec2-user@1.2.3.4:/remote/file.txt'");
});
