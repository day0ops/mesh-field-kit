// features/security/certificate/index.js
import { Feature } from '../../../src/lib/feature.js';
import { KubernetesHelper } from '../../../src/lib/common.js';

/**
 * Certificate Feature
 *
 * Requests a TLS certificate via cert-manager for a bare usecase (not a whole
 * addon) to consume - e.g. as a Gateway's HTTPS listener certificateRef. Every
 * existing Certificate in this repo is created by a specialized addon's own
 * code (solo-ui, telemetry, keycloak); this is the first one usable directly
 * by any usecase's feature list.
 *
 * Configuration:
 * {
 *   secretName: string,        // Required: name of both the Certificate and its target Secret
 *   namespace: string,         // Required: namespace
 *   hostname: string,          // Required: commonName/dnsNames[0]
 *   clusterIssuerName: string, // Optional: default 'selfsigned-issuer'
 *   organization: string,      // Optional: default 'solo.io'
 * }
 */
export class CertificateFeature extends Feature {
  validate() {
    if (!this.config.secretName) throw new Error('secretName is required for Certificate feature');
    if (!this.config.namespace) throw new Error('namespace is required for Certificate feature');
    if (!this.config.hostname) throw new Error('hostname is required for Certificate feature');
    return true;
  }

  buildCertificateManifest() {
    const { secretName, namespace, hostname } = this.config;
    const clusterIssuerName = this.config.clusterIssuerName || 'selfsigned-issuer';
    const organization = this.config.organization || 'solo.io';

    return {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: secretName, namespace },
      spec: {
        secretName,
        issuerRef: { name: clusterIssuerName, kind: 'ClusterIssuer' },
        commonName: hostname,
        dnsNames: [hostname],
        subject: { organizations: [organization] },
      },
    };
  }

  async deploy() {
    const { secretName, namespace, hostname } = this.config;
    this.log(`Requesting certificate '${secretName}' for ${hostname}...`, 'info');

    await this.applyResource(this.buildCertificateManifest());
    await this.waitForReady(secretName, namespace);

    this.log(`Certificate '${secretName}' is ready`, 'success');
  }

  async waitForReady(secretName, namespace, maxAttempts = 60) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await KubernetesHelper.kubectl([
          'get',
          'certificate',
          secretName,
          '-n',
          namespace,
          '-o',
          'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
        ]);
        if (result?.stdout?.trim() === 'True') return;
      } catch {
        // not found yet, or transient error - keep polling
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error(`Certificate '${secretName}' did not become Ready within ${maxAttempts * 2}s`);
  }

  async cleanup() {
    const { secretName, namespace } = this.config;
    this.log(`Cleaning up certificate '${secretName}'...`, 'info');
    await this.deleteResource('certificate', secretName, namespace);
  }
}
