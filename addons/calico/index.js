import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import yaml from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const DEFAULT_CALICO_VERSION = '3.32.1';
const CALICO_HELM_REPO = 'https://docs.tigera.io/calico/charts';
const RELEASE_NAME = 'calico';
const OPERATOR_NAMESPACE = 'tigera-operator';
const CALICO_NAMESPACE = 'calico-system';
const VALID_MODES = ['chaining', 'primary'];

/**
 * Calico Feature
 *
 * Installs Calico (via the Tigera operator) for use with Istio Ambient.
 *
 * Reference:
 *   https://docs.tigera.io/calico/latest/getting-started/kubernetes/helm
 *   https://docs.tigera.io/calico/latest/getting-started/kubernetes/managed-public-cloud/eks
 *
 * This addon installs the Tigera operator, which in turn provisions Calico's
 * control plane (calico-kube-controllers) and dataplane (calico-node) via the
 * Installation custom resource.
 *
 * Configuration:
 * {
 *   version: string,          // Helm chart version (default: '3.32.1')
 *   mode: string,             // 'chaining' (default, policy-only) or 'primary'
 *   chainingTarget: string,   // Installation cni.type when mode=chaining: 'AmazonVPC' (default/EKS)
 *   kubernetesProvider: string, // Installation kubernetesProvider (default: 'EKS')
 *   values: object,           // Arbitrary Helm value overrides merged last
 * }
 */
export class CalicoFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.chartVersion = config.version || DEFAULT_CALICO_VERSION;
    this.mode = config.mode || 'chaining';
    // chainingTarget: Installation cni.type when mode=chaining (i.e. which CNI
    // stays responsible for pod networking/IPAM while Calico only enforces policy).
    // Only applies when mode=chaining. Defaults to AmazonVPC (EKS).
    this.chainingTarget = config.chainingTarget || 'AmazonVPC';
    this.kubernetesProvider = config.kubernetesProvider || 'EKS';
    this.userValues = config.values || {};
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!VALID_MODES.includes(this.mode)) {
      this.log(
        `Invalid Calico mode: ${this.mode}. Valid values: ${VALID_MODES.join(', ')}`,
        'error'
      );
      return false;
    }
    return true;
  }

  async deploy() {
    this.log(`Installing Calico ${this.chartVersion} (mode: ${this.mode})...`, 'info');

    await this.addHelmRepo();
    await this.installCRDs();
    await this.installCalico();
    await this.waitForCalico();

    this.log('Calico installed successfully.', 'success');
  }

  /**
   * Add the Tigera Helm repository
   */
  async addHelmRepo() {
    this.log('Adding Tigera Helm repository...', 'info');

    try {
      await CommandRunner.run('helm', ['repo', 'add', 'projectcalico', CALICO_HELM_REPO], {
        ignoreError: true,
      });
      await CommandRunner.run('helm', ['repo', 'update', 'projectcalico']);
      this.log('Tigera Helm repository added and updated', 'info');
    } catch (error) {
      throw new Error(`Failed to add Tigera Helm repository: ${error.message}`);
    }
  }

  /**
   * Install the operator.tigera.io / crd.projectcalico.org CRDs.
   * The tigera-operator chart does not bundle these itself - they must be
   * applied separately before the operator chart, per the upstream docs:
   * https://docs.tigera.io/calico/latest/getting-started/kubernetes/helm
   */
  async installCRDs() {
    this.log('Installing Calico CRDs...', 'info');
    const ctxFlag = this.kubeContext ? `--context=${this.kubeContext}` : '';

    try {
      await CommandRunner.exec(
        `helm template calico-crds projectcalico/crd.projectcalico.org.v1 --version ${this.chartVersion} | kubectl ${ctxFlag} apply --server-side -f -`
      );
      this.log('Calico CRDs installed', 'info');
    } catch (error) {
      throw new Error(`Failed to install Calico CRDs: ${error.message}`);
    }
  }

  /**
   * Install Calico via Helm (Tigera operator chart).
   * Values are layered: base -> mode overlay -> user overrides.
   */
  async installCalico() {
    this.log('Installing Calico Helm chart...', 'info');

    const helmArgs = [
      'upgrade',
      '-i',
      RELEASE_NAME,
      'projectcalico/tigera-operator',
      '-n',
      OPERATOR_NAMESPACE,
      '--version',
      this.chartVersion,
      '-f',
      join(CONFIG_DIR, 'values.yaml'),
    ];

    if (this.mode === 'primary') {
      helmArgs.push('-f', join(CONFIG_DIR, 'values-primary.yaml'));
    } else {
      if (this.chainingTarget !== 'AmazonVPC') {
        helmArgs.push('--set', `installation.cni.type=${this.chainingTarget}`);
      }
      if (this.kubernetesProvider !== 'EKS') {
        helmArgs.push('--set', `installation.kubernetesProvider=${this.kubernetesProvider}`);
      }
    }

    let userValuesFile = null;
    if (Object.keys(this.userValues).length > 0) {
      userValuesFile = join(tmpdir(), `.mesh-calico-values-${process.pid}.yaml`);
      writeFileSync(userValuesFile, yaml.dump(this.userValues, { lineWidth: -1 }));
      helmArgs.push('-f', userValuesFile);
    }

    if (this.kubeContext) {
      helmArgs.push('--kube-context', this.kubeContext);
    }

    helmArgs.push('--create-namespace', '--wait', '--timeout', '10m');

    try {
      await KubernetesHelper.helm(helmArgs, this.spinner);
      await KubernetesHelper.assertHelmDeployed(RELEASE_NAME, OPERATOR_NAMESPACE, this.kubeContext);
      this.log('Calico Helm chart installed', 'info');
    } finally {
      if (userValuesFile && existsSync(userValuesFile)) {
        try {
          unlinkSync(userValuesFile);
        } catch {
          /* best effort */
        }
      }
    }
  }

  /**
   * Wait for Calico's control plane and dataplane to be ready
   */
  async waitForCalico() {
    this.log('Waiting for Calico to be ready...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];

    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'rollout',
          'status',
          'daemonset/calico-node',
          '-n',
          CALICO_NAMESPACE,
          '--timeout=300s',
        ],
        { ignoreError: true }
      );
      this.log('calico-node daemonset is ready', 'info');
    } catch (error) {
      this.log(`calico-node daemonset may not be ready: ${error.message}`, 'warn');
    }

    try {
      await KubernetesHelper.waitForDeployment(
        CALICO_NAMESPACE,
        'calico-kube-controllers',
        300,
        this.spinner,
        this.kubeContext
      );
    } catch (error) {
      this.log(`calico-kube-controllers may not be ready: ${error.message}`, 'warn');
    }

    this.log('Calico is ready', 'info');
  }

  async cleanup() {
    this.log('Cleaning up Calico...', 'info');
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        RELEASE_NAME,
        '-n',
        OPERATOR_NAMESPACE,
        '--wait',
      ]);
      this.log('Calico Helm release uninstalled', 'info');
    } catch (err) {
      if (!/not found|no deployed releases/i.test(err.message)) throw err;
    }

    this.log('Calico cleaned up', 'success');
  }
}
