import { AddonFeature } from '../../src/lib/feature.js';
import { Logger, KubernetesHelper, CommandRunner, SpinnerLogger } from '../../src/lib/common.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

// Helm chart version
const CERT_MANAGER_VERSION = 'v1.19.3';
const CERT_MANAGER_CHART_VERSION = '1.19.3';

/**
 * Cert-Manager Feature
 *
 * Installs cert-manager for automatic TLS certificate management in Kubernetes.
 *
 * Reference: https://cert-manager.io/docs/installation/helm/
 *
 * This service installs:
 * - cert-manager (certificate management)
 * - CRDs for Certificate, CertificateRequest, Issuer, ClusterIssuer
 * - Webhook for certificate validation
 *
 * Configuration:
 * {
 *   certManagerNamespace: string,  // Default: 'cert-manager'
 *   installCRDs: boolean,           // Default: true (install CRDs)
 *   webhook: {                      // Optional: Webhook configuration
 *     enabled: boolean              // Default: true
 *   },
 *   cainjector: {                   // Optional: CA Injector configuration
 *     enabled: boolean              // Default: true
 *   },
 *   letsencrypt: {                  // Optional: Let's Encrypt DNS-01 issuer (Route53)
 *     enabled: boolean,             // Default: false
 *     staging: boolean,             // Default: false (use staging ACME server)
 *     email: string,                // Required if enabled: ACME account email
 *     region: string                // AWS region for Route53 (default: us-east-1)
 *   }
 * }
 */
export class CertManagerFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.certManagerNamespace = config.certManagerNamespace || 'cert-manager';
    this.shouldInstallCRDs = config.installCRDs !== false;
    this.webhookEnabled = config.webhook?.enabled !== false;
    this.cainjectorEnabled = config.cainjector?.enabled !== false;
    // Let's Encrypt DNS-01 issuer config (for Route53)
    this.letsencryptEnabled = config.letsencrypt?.enabled === true;
    this.letsencryptStaging = config.letsencrypt?.staging === true;
    this.letsencryptEmail = config.letsencrypt?.email || '';
    this.letsencryptRegion = config.letsencrypt?.region || 'us-east-1';
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    // All configuration is optional
    return true;
  }

  async deploy() {
    this.log('Installing cert-manager...', 'info');

    // Step 1: Install CRDs first (if enabled)
    if (this.shouldInstallCRDs) {
      await this.installCRDs();
    }

    // Step 2: Create cert-manager namespace
    await KubernetesHelper.ensureNamespace(
      this.certManagerNamespace,
      this.spinner,
      this.kubeContext
    );
    this.log(`Namespace '${this.certManagerNamespace}' ready`, 'info');

    // Step 3: Add Jetstack Helm repository
    await this.addHelmRepo();

    // Step 4: Install cert-manager via Helm
    await this.installCertManager();

    // Step 5: Wait for cert-manager to be ready
    await this.waitForCertManager();

    // Step 6: Create ClusterIssuers
    await this.createSelfSignedIssuer();

    if (this.letsencryptEnabled && this.letsencryptEmail) {
      await this.createLetsEncryptDnsIssuer();
    }

    this.log('cert-manager installed successfully', 'success');
  }

  /**
   * Install cert-manager CRDs
   */
  async installCRDs() {
    this.log('Installing cert-manager CRDs...', 'info');

    const crdUrl = `https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.crds.yaml`;
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await KubernetesHelper.kubectl([...ctxArgs, 'apply', '-f', crdUrl], {
        spinner: this.spinner,
      });
      this.log('cert-manager CRDs installed', 'info');
    } catch (error) {
      throw new Error(`Failed to install cert-manager CRDs: ${error.message}`);
    }
  }

  /**
   * Add Jetstack Helm repository
   */
  async addHelmRepo() {
    this.log('Adding Jetstack Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', 'jetstack', 'https://charts.jetstack.io'], {
        ignoreError: true,
      }); // Ignore if repo already exists

      await CommandRunner.run('helm', ['repo', 'update', 'jetstack']);

      this.log('Jetstack Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Helm repository: ${error.message}`);
    }
  }

  /**
   * Install cert-manager via Helm
   */
  async installCertManager() {
    this.log('Installing cert-manager Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      'cert-manager',
      'jetstack/cert-manager',
      '-n',
      this.certManagerNamespace,
      '--version',
      CERT_MANAGER_CHART_VERSION,
      '--create-namespace',
      '--wait',
      '--timeout',
      '5m',
    ];

    // Add values file if it exists
    const valuesFile = join(CONFIG_DIR, 'values.yaml');
    try {
      const fs = await import('fs/promises');
      await fs.access(valuesFile);
      helmArgs.push('-f', valuesFile);
    } catch {
      // Values file doesn't exist, use defaults
    }

    // Add webhook configuration
    if (!this.webhookEnabled) {
      helmArgs.push('--set', 'webhook.enabled=false');
    }

    // Add cainjector configuration
    if (!this.cainjectorEnabled) {
      helmArgs.push('--set', 'cainjector.enabled=false');
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    await KubernetesHelper.helm(helmArgs, this.spinner);
    await KubernetesHelper.assertHelmDeployed(
      'cert-manager',
      this.certManagerNamespace,
      this.kubeContext
    );
    this.log('cert-manager Helm chart installed', 'info');
  }

  /**
   * Wait for cert-manager components to be ready
   */
  async waitForCertManager() {
    this.log('Waiting for cert-manager to be ready...', 'info');

    const deployments = ['cert-manager', 'cert-manager-webhook', 'cert-manager-cainjector'];

    for (const deployment of deployments) {
      if (deployment === 'cert-manager-webhook' && !this.webhookEnabled) {
        continue;
      }
      if (deployment === 'cert-manager-cainjector' && !this.cainjectorEnabled) {
        continue;
      }

      try {
        await KubernetesHelper.waitForDeployment(
          this.certManagerNamespace,
          deployment,
          300,
          this.spinner,
          this.kubeContext
        );
      } catch (error) {
        this.log(`Warning: Deployment ${deployment} may not be ready: ${error.message}`, 'warn');
      }
    }

    this.log('cert-manager is ready', 'info');
  }

  async createSelfSignedIssuer() {
    this.log('Creating self-signed ClusterIssuer...', 'info');

    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: { name: 'selfsigned-issuer' },
      spec: { selfSigned: {} },
    };

    try {
      await this.applyResource(issuer, this.kubeContext);
      this.log('Self-signed ClusterIssuer created', 'info');
    } catch (error) {
      throw new Error(`Failed to create self-signed ClusterIssuer: ${error.message}`);
    }
  }

  /**
   * Create Let's Encrypt DNS-01 ClusterIssuer for Route53
   * Requires IRSA to be configured for cert-manager service account
   */
  async createLetsEncryptDnsIssuer() {
    const acmeServer = this.letsencryptStaging
      ? 'https://acme-staging-v02.api.letsencrypt.org/directory'
      : 'https://acme-v02.api.letsencrypt.org/directory';
    const envLabel = this.letsencryptStaging ? ' (staging)' : '';

    this.log(`Creating Let's Encrypt DNS-01 ClusterIssuer${envLabel}...`, 'info');

    const issuer = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'ClusterIssuer',
      metadata: {
        name: 'letsencrypt-dns',
        labels: { 'app.kubernetes.io/managed-by': 'mesh-demo' },
      },
      spec: {
        acme: {
          server: acmeServer,
          email: this.letsencryptEmail,
          privateKeySecretRef: { name: 'letsencrypt-dns' },
          solvers: [
            {
              dns01: {
                route53: {
                  region: this.letsencryptRegion,
                  // Uses IRSA - no explicit credentials needed
                },
              },
            },
          ],
        },
      },
    };

    try {
      await this.applyResource(issuer, this.kubeContext);
      this.log(`Let's Encrypt DNS-01 ClusterIssuer created${envLabel}`, 'info');
    } catch (error) {
      throw new Error(`Failed to create Let's Encrypt ClusterIssuer: ${error.message}`);
    }
  }

  async cleanup() {
    this.log('Cleaning up cert-manager...', 'info');

    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        'cert-manager',
        '-n',
        this.certManagerNamespace,
      ]);
      this.log('cert-manager Helm chart uninstalled', 'info');
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) throw error;
    }

    try {
      await KubernetesHelper.kubectl([
        ...ctxArgs,
        'delete',
        'clusterissuer',
        'selfsigned-issuer',
        '--ignore-not-found=true',
      ]);
      if (this.letsencryptEnabled) {
        await KubernetesHelper.kubectl([
          ...ctxArgs,
          'delete',
          'clusterissuer',
          'letsencrypt-dns',
          '--ignore-not-found=true',
        ]);
      }
    } catch (error) {
      if (!/doesn't have a resource type|no kind is registered/i.test(error.message)) throw error;
    }

    await KubernetesHelper.kubectl([
      ...ctxArgs,
      'delete',
      'namespace',
      this.certManagerNamespace,
      '--ignore-not-found=true',
    ]);

    this.log('cert-manager cleaned up', 'success');
  }
}
