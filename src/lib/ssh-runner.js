import { CommandRunner } from './common.js';

const DEFAULT_SSH_OPTS = [
  '-o StrictHostKeyChecking=no',
  '-o UserKnownHostsFile=/dev/null',
  '-o ConnectTimeout=10',
];

/** Single-quote a string for safe interpolation into a bash -c command. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * SshRunner - runs commands and copies files on a remote host over SSH.
 * Mirrors how TerraformRunner wraps the terraform CLI: build a shell
 * command string and delegate to CommandRunner.
 */
export class SshRunner {
  constructor(keyPath, user = 'ec2-user') {
    this.keyPath = keyPath;
    this.user = user;
  }

  async exec(host, command, options = {}) {
    const sshCommand = [
      'ssh',
      '-i',
      shellQuote(this.keyPath),
      ...DEFAULT_SSH_OPTS,
      `${this.user}@${host}`,
      shellQuote(command),
    ].join(' ');

    return CommandRunner.exec(sshCommand, options);
  }

  async copyFile(localPath, host, remotePath, options = {}) {
    const scpCommand = [
      'scp',
      '-i',
      shellQuote(this.keyPath),
      ...DEFAULT_SSH_OPTS,
      shellQuote(localPath),
      shellQuote(`${this.user}@${host}:${remotePath}`),
    ].join(' ');

    return CommandRunner.exec(scpCommand, options);
  }
}
