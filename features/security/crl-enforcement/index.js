import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';

/**
 * CRL Enforcement Feature
 *
 * Reference: https://docs.solo.io/istio/1.30.x/ambient/security/crl/
 *
 * Fetches the mesh's own intermediate CA from the cacerts secret (installed by
 * mesh.certificates.mode: self-signed) and demonstrates certificate revocation
 * end-to-end at the PKI layer:
 *   1. Issue two throwaway test leaf certs signed by that CA.
 *   2. Revoke one, build a CRL, and patch it into cacerts' ca-crl.pem key -
 *      the same key istiod reads and propagates to a ConfigMap in every
 *      namespace for ztunnel (peerCaCrl.enabled) to enforce.
 *   3. Verify with `openssl verify -crl_check` that the revoked cert is now
 *      rejected while the other still validates.
 *
 * This proves the CRL generation/distribution/verification plumbing is
 * correct. It does not exercise a live ztunnel mTLS handshake against a real
 * workload - that runtime behavior isn't something a from-scratch local demo
 * can responsibly fabricate.
 *
 * Configuration:
 * {
 *   namespace: string,    // Default: 'istio-system' - where the cacerts secret lives
 * }
 */
export class CrlEnforcementFeature extends Feature {
  constructor(name, config) {
    super(name, config);
    this.certsNamespace = config.namespace || 'istio-system';
    this.workDir = join(tmpdir(), `mesh-crl-${process.pid}`);
  }

  get contextFlag() {
    const context = this.clusterContexts?.[0]?.context;
    return context ? `--context=${context}` : '';
  }

  async deploy() {
    mkdirSync(this.workDir, { recursive: true });

    this.log('Fetching intermediate CA from cacerts secret...', 'info');
    const caCertPath = join(this.workDir, 'ca-cert.pem');
    const caKeyPath = join(this.workDir, 'ca-key.pem');
    const rootCertPath = join(this.workDir, 'root-cert.pem');
    await this.#fetchSecretKey('ca-cert.pem', caCertPath);
    await this.#fetchSecretKey('ca-key.pem', caKeyPath);
    await this.#fetchSecretKey('root-cert.pem', rootCertPath);

    this.log('Setting up local CA database for CRL issuance...', 'info');
    const dbDir = join(this.workDir, 'cadb');
    const opensslCnf = this.#writeCaConfig(dbDir, caCertPath, caKeyPath);

    this.log('Issuing two throwaway test leaf certs...', 'info');
    const revokedCert = await this.#issueTestCert(dbDir, opensslCnf, 'crl-test-revoked');
    const goodCert = await this.#issueTestCert(dbDir, opensslCnf, 'crl-test-control');

    this.log(`Revoking test cert '${revokedCert.name}'...`, 'info');
    await CommandRunner.exec(
      `openssl ca -config "${opensslCnf}" -revoke "${revokedCert.certPath}" -batch`
    );

    this.log('Generating CRL...', 'info');
    const crlPath = join(this.workDir, 'ca-crl.pem');
    await CommandRunner.exec(`openssl ca -config "${opensslCnf}" -gencrl -out "${crlPath}" -batch`);

    this.log('Patching CRL into cacerts secret...', 'info');
    const crlB64 = readFileSync(crlPath).toString('base64').replace(/\n/g, '');
    await CommandRunner.exec(
      `kubectl ${this.contextFlag} patch secret cacerts -n ${this.certsNamespace} --type merge ` +
        `-p "{\\"data\\":{\\"ca-crl.pem\\":\\"${crlB64}\\"}}"`
    );

    this.log('Verifying CRL enforcement at the PKI layer...', 'info');
    const chainPath = join(this.workDir, 'chain.pem');
    writeFileSync(chainPath, readFileSync(caCertPath, 'utf8') + readFileSync(rootCertPath, 'utf8'));

    const revokedResult = await CommandRunner.exec(
      `openssl verify -crl_check -CAfile "${chainPath}" -CRLfile "${crlPath}" "${revokedCert.certPath}"`,
      { ignoreError: true }
    );
    const revokedOutput = `${revokedResult.stdout || ''}${revokedResult.stderr || ''}`;
    if (!/revoked/i.test(revokedOutput)) {
      throw new Error(
        `Expected revoked test cert to fail CRL verification, got: ${revokedOutput.trim()}`
      );
    }
    this.log(`Revoked cert correctly rejected: ${revokedOutput.trim()}`, 'success');

    const goodResult = await CommandRunner.exec(
      `openssl verify -crl_check -CAfile "${chainPath}" -CRLfile "${crlPath}" "${goodCert.certPath}"`
    );
    if (!/OK/.test(goodResult.stdout || '')) {
      throw new Error(
        `Expected non-revoked control cert to pass CRL verification, got: ${goodResult.stdout}`
      );
    }
    this.log(`Control cert correctly still valid: ${goodResult.stdout.trim()}`, 'success');

    this.log(
      'CRL installed on cacerts. istiod propagates ca-crl.pem to a ConfigMap in every ' +
        'namespace within ~60-90s; ztunnel (peerCaCrl.enabled) enforces it on new connections mesh-wide.',
      'success'
    );
  }

  async cleanup() {
    this.log('Removing CRL from cacerts secret...', 'info');
    try {
      await CommandRunner.exec(
        `kubectl ${this.contextFlag} patch secret cacerts -n ${this.certsNamespace} --type=json ` +
          `-p '[{"op":"remove","path":"/data/ca-crl.pem"}]'`,
        { ignoreError: true }
      );
    } catch {
      // key may not exist
    }
    try {
      rmSync(this.workDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  async #fetchSecretKey(key, outPath) {
    const jsonKey = key.replace(/\./g, '\\.');
    const result = await CommandRunner.exec(
      `kubectl ${this.contextFlag} get secret cacerts -n ${this.certsNamespace} -o jsonpath="{.data.${jsonKey}}"`
    );
    const value = (result.stdout || '').trim();
    if (!value) {
      throw new Error(
        `cacerts secret in '${this.certsNamespace}' is missing key '${key}' - ` +
          'is mesh.certificates.mode: self-signed configured on this profile?'
      );
    }
    writeFileSync(outPath, Buffer.from(value, 'base64'));
  }

  #writeCaConfig(dbDir, caCertPath, caKeyPath) {
    mkdirSync(join(dbDir, 'newcerts'), { recursive: true });
    writeFileSync(join(dbDir, 'index.txt'), '');
    writeFileSync(join(dbDir, 'serial'), '1000\n');
    writeFileSync(join(dbDir, 'crlnumber'), '1000\n');

    const opensslCnf = join(dbDir, 'openssl.cnf');
    writeFileSync(
      opensslCnf,
      '[ca]\ndefault_ca = CA_default\n\n' +
        '[CA_default]\n' +
        `dir = ${dbDir}\n` +
        `database = ${join(dbDir, 'index.txt')}\n` +
        `serial = ${join(dbDir, 'serial')}\n` +
        `new_certs_dir = ${join(dbDir, 'newcerts')}\n` +
        `certificate = ${caCertPath}\n` +
        `private_key = ${caKeyPath}\n` +
        `crlnumber = ${join(dbDir, 'crlnumber')}\n` +
        'default_md = sha256\n' +
        'default_days = 30\n' +
        'default_crl_days = 30\n' +
        'policy = policy_anything\n\n' +
        '[policy_anything]\ncommonName = supplied\n'
    );
    return opensslCnf;
  }

  async #issueTestCert(dbDir, opensslCnf, name) {
    const keyPath = join(dbDir, `${name}-key.pem`);
    const csrPath = join(dbDir, `${name}-csr.pem`);
    const certPath = join(dbDir, `${name}-cert.pem`);
    await CommandRunner.exec(`openssl genrsa -out "${keyPath}" 2048`);
    await CommandRunner.exec(
      `openssl req -new -key "${keyPath}" -out "${csrPath}" -subj "/CN=${name}"`
    );
    await CommandRunner.exec(
      `openssl ca -config "${opensslCnf}" -in "${csrPath}" -out "${certPath}" -batch -notext`
    );
    return { name, keyPath, csrPath, certPath };
  }
}

export function createCrlEnforcementFeature(config) {
  return new CrlEnforcementFeature('crl-enforcement', config);
}
