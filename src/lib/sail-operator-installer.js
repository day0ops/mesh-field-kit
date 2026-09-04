import yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync } from 'fs';
import { CommandRunner, SpinnerLogger } from './common.js';
import { ProfileSchema } from './profile-schema.js';
import { TemplateResolver } from './template-resolver.js';
import { ConfigResolver } from './config-resolver.js';

const DEFAULTS = {
  SUBSCRIPTION_NAME: 'servicemeshoperator3',
  OPERATOR_NAMESPACE: 'openshift-operators',
  CATALOG_SOURCE: 'redhat-operators',
  CATALOG_SOURCE_NAMESPACE: 'openshift-marketplace',
  CHANNEL: 'stable',
  NAMESPACE: 'istio-system',
  WAIT_TIMEOUT_SEC: 300,
  POLL_INTERVAL_MS: 5000,
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function contextFlags(context) {
  if (!context) return { kubectl: '' };
  return { kubectl: `--context=${context}` };
}

function writeTempYaml(name, resource) {
  const file = join(tmpdir(), `.mesh-sail-${name}-${process.pid}.yaml`);
  writeFileSync(file, yaml.dump(resource, { lineWidth: -1 }));
  return file;
}

function cleanupTempFile(file) {
  try {
    unlinkSync(file);
  } catch {
    /* best effort */
  }
}

/**
 * Installs Red Hat OpenShift Service Mesh 3 (OSSM3) via the Sail Operator (OLM),
 * for clusters resolving to `installMethod: sail-operator` (e.g. ROSA) in a
 * mixed-vendor profile. Mirrors OperatorInstaller's shape but drives OLM plus
 * sailoperator.io/v1 CRs instead of Solo's Gloo Operator.
 */
export class SailOperatorInstaller {
  /**
   * @param {object} options
   * @param {object} options.profile - Loaded profile YAML
   * @param {object} options.cluster - { name, context, role }
   * @param {object} [options.templateContext] - Template resolution context
   * @param {object} options.cfg - Resolved config from installer
   */
  static async installCluster({ profile, cluster, templateContext, cfg }) {
    const operatorConfig = ProfileSchema.getOperatorConfig(profile);
    const flags = contextFlags(cluster.context);
    const contextDisplay = cluster.context || 'current context';
    const spinner = new SpinnerLogger();

    const istioNamespace = cfg.namespace || DEFAULTS.NAMESPACE;
    // OSSM3/Sail Operator ships its own upstream Istio release, versioned
    // independently of Solo's fork used on any Helm-installed clusters in the
    // same profile — falls back to cfg.istioVersion only if not set explicitly.
    const sailIstioVersion = operatorConfig.istioVersion || cfg.istioVersion;

    const resolved = ConfigResolver.resolveForCluster(profile, cluster);
    const label = ConfigResolver.meshModeLabel(resolved.components);

    spinner.start(
      `Installing ${label} via Sail Operator on ${cluster.name} (${contextDisplay})...`
    );

    try {
      spinner.log(`Cluster: ${cluster.name} (role: ${cluster.role || 'default'})`);
      spinner.log(`  INSTALL_METHOD: sail-operator`);
      spinner.log(`  ISTIO_VERSION:  ${sailIstioVersion}`);
      spinner.log(`  INSTALL_NS:     ${istioNamespace}`);

      spinner.setText('Installing Gateway API CRDs...');
      await this.#installGatewayApi(cfg, flags, spinner);

      spinner.setText('Installing Sail Operator subscription...');
      await this.#installSubscription(flags, spinner);

      spinner.setText('Waiting for Sail Operator to install...');
      await this.#waitForSubscriptionReady(flags, spinner);

      // Same component-value shapes the Helm path uses (global.meshID, global.network,
      // global.multiCluster.clusterName, env.*) — remapped below into the Sail Operator
      // CR shape instead of Helm values, so both install methods share one profile YAML
      // convention for these settings.
      const istiodValues = TemplateResolver.resolveValues(
        resolved.componentValues.istiod || {},
        templateContext
      );
      const ztunnelValues = TemplateResolver.resolveValues(
        resolved.componentValues.ztunnel || {},
        templateContext
      );

      spinner.setText('Applying IstioCNI CR...');
      await this.#applyIstioCNI({
        istioNamespace,
        meshProfile: cfg.meshProfile,
        version: sailIstioVersion,
        flags,
      });

      spinner.setText('Applying Istio CR...');
      await this.#applyIstio({
        istioNamespace,
        meshProfile: cfg.meshProfile,
        version: sailIstioVersion,
        istiodValues,
        cluster,
        flags,
      });

      spinner.setText('Waiting for IstioCNI to become ready...');
      await this.#waitForCrReady('istiocni', 'default', flags, spinner);

      spinner.setText('Waiting for Istio control plane to become ready...');
      await this.#waitForCrReady('istio', 'default', flags, spinner);

      spinner.setText('Applying ZTunnel CR...');
      await this.#applyZTunnel({
        istioNamespace,
        version: sailIstioVersion,
        ztunnelValues,
        cluster,
        flags,
      });

      spinner.setText('Waiting for ZTunnel to become ready...');
      await this.#waitForCrReady('ztunnel', 'default', flags, spinner);

      spinner.setText('Labeling istio-system namespace with network topology...');
      const network = istiodValues.global?.network || cluster.name;
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} label namespace ${istioNamespace} topology.istio.io/network=${network} --overwrite`,
        { ignoreError: true }
      );

      spinner.succeed(
        `${label} installed via Sail Operator on ${cluster.name} (${contextDisplay})`
      );
      return true;
    } catch (error) {
      spinner.fail(`Failed to install via Sail Operator on ${cluster.name}: ${error.message}`);
      throw error;
    }
  }

  static async uninstall(context = null) {
    const flags = contextFlags(context);
    const contextDisplay = context || 'current context';
    const spinner = new SpinnerLogger();

    spinner.start(`Uninstalling Sail Operator from ${contextDisplay}...`);

    try {
      spinner.setText('Deleting Sail Operator CRs...');
      for (const kind of ['ztunnel', 'istio', 'istiocni']) {
        await CommandRunner.exec(
          `kubectl ${flags.kubectl} delete ${kind} default --ignore-not-found=true --wait=true --timeout=120s`,
          { ignoreError: true }
        );
      }

      spinner.setText('Deleting Sail Operator subscription...');
      const csv = await this.#getInstalledCsv(flags);
      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete subscription ${DEFAULTS.SUBSCRIPTION_NAME} -n ${DEFAULTS.OPERATOR_NAMESPACE} --ignore-not-found=true`,
        { ignoreError: true }
      );
      if (csv) {
        await CommandRunner.exec(
          `kubectl ${flags.kubectl} delete clusterserviceversion ${csv} -n ${DEFAULTS.OPERATOR_NAMESPACE} --ignore-not-found=true`,
          { ignoreError: true }
        );
      }

      await CommandRunner.exec(
        `kubectl ${flags.kubectl} delete namespace ${DEFAULTS.NAMESPACE} --ignore-not-found=true`,
        { ignoreError: true }
      );

      spinner.succeed(`Sail Operator uninstalled from ${contextDisplay}`);
      return true;
    } catch (error) {
      spinner.fail(`Failed to uninstall Sail Operator: ${error.message}`);
      throw error;
    }
  }

  static async #getInstalledCsv(flags) {
    const result = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get subscription ${DEFAULTS.SUBSCRIPTION_NAME} -n ${DEFAULTS.OPERATOR_NAMESPACE} -o jsonpath="{.status.installedCSV}"`,
      { ignoreError: true }
    );
    return result.stdout?.trim() || null;
  }

  static async #installGatewayApi(cfg, flags, spinner) {
    const crdCheck = await CommandRunner.exec(
      `kubectl ${flags.kubectl} get crd gateways.gateway.networking.k8s.io`,
      { ignoreError: true }
    );
    if (!crdCheck.exitCode) {
      spinner.log('Gateway API CRDs already exist, skipping');
      return;
    }

    await CommandRunner.exec(
      `kubectl ${flags.kubectl} apply --server-side --force-conflicts -f https://github.com/kubernetes-sigs/gateway-api/releases/download/${cfg.gatewayApiVersion}/standard-install.yaml`
    );
    spinner.log('Gateway API CRDs installed', 'success');
  }

  static async #installSubscription(flags, spinner) {
    const subscription = {
      apiVersion: 'operators.coreos.com/v1alpha1',
      kind: 'Subscription',
      metadata: {
        name: DEFAULTS.SUBSCRIPTION_NAME,
        namespace: DEFAULTS.OPERATOR_NAMESPACE,
      },
      spec: {
        channel: DEFAULTS.CHANNEL,
        name: DEFAULTS.SUBSCRIPTION_NAME,
        source: DEFAULTS.CATALOG_SOURCE,
        sourceNamespace: DEFAULTS.CATALOG_SOURCE_NAMESPACE,
        installPlanApproval: 'Automatic',
      },
    };

    const file = writeTempYaml('subscription', subscription);
    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${file}`);
      spinner.log('Sail Operator subscription applied', 'success');
    } finally {
      cleanupTempFile(file);
    }
  }

  static async #waitForSubscriptionReady(flags, spinner) {
    const maxAttempts = DEFAULTS.WAIT_TIMEOUT_SEC / (DEFAULTS.POLL_INTERVAL_MS / 1000);

    for (let i = 0; i < maxAttempts; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${flags.kubectl} get subscription ${DEFAULTS.SUBSCRIPTION_NAME} -n ${DEFAULTS.OPERATOR_NAMESPACE} -o json`,
        { ignoreError: true }
      );

      const stdout = result.stdout || '';
      if (stdout) {
        try {
          const sub = JSON.parse(stdout);
          if (sub.status?.installedCSV && sub.status?.state === 'AtLatestKnown') {
            spinner.log(`Sail Operator installed (CSV: ${sub.status.installedCSV})`, 'success');
            return;
          }
        } catch {
          /* continue polling */
        }
      }

      spinner.log('Waiting for Sail Operator subscription to install...');
      await sleep(DEFAULTS.POLL_INTERVAL_MS);
    }

    throw new Error('Sail Operator subscription did not reach AtLatestKnown within timeout');
  }

  static async #applyIstioCNI({ istioNamespace, meshProfile, version, flags }) {
    const cr = {
      apiVersion: 'sailoperator.io/v1',
      kind: 'IstioCNI',
      metadata: { name: 'default' },
      spec: {
        namespace: istioNamespace,
        profile: meshProfile,
        version,
      },
    };
    const file = writeTempYaml('istiocni', cr);
    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${file}`);
    } finally {
      cleanupTempFile(file);
    }
  }

  static async #applyIstio({ istioNamespace, meshProfile, version, istiodValues, cluster, flags }) {
    // Default network identity to the cluster's own name, matching the Helm path's
    // buildComponentBaseValues() auto-derivation and installer.js's unconditional
    // topology.istio.io/network=<cluster.name> namespace label — explicit profile
    // YAML values (istiodValues.global) still win when set.
    const global = {
      network: cluster.name,
      multiCluster: { clusterName: cluster.name },
      ...istiodValues.global,
    };
    const values = { global };
    if (istiodValues.env) values.pilot = { env: istiodValues.env };

    const cr = {
      apiVersion: 'sailoperator.io/v1',
      kind: 'Istio',
      metadata: { name: 'default' },
      spec: {
        namespace: istioNamespace,
        profile: meshProfile,
        version,
        values,
      },
    };
    const file = writeTempYaml('istio', cr);
    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${file}`);
    } finally {
      cleanupTempFile(file);
    }
  }

  static async #applyZTunnel({ istioNamespace, version, ztunnelValues, cluster, flags }) {
    const ztunnel = {
      network: cluster.name,
      multiCluster: { clusterName: cluster.name },
      ...ztunnelValues,
    };

    const cr = {
      apiVersion: 'sailoperator.io/v1',
      kind: 'ZTunnel',
      metadata: { name: 'default' },
      spec: {
        namespace: istioNamespace,
        version,
        values: { ztunnel },
      },
    };
    const file = writeTempYaml('ztunnel', cr);
    try {
      await CommandRunner.exec(`kubectl ${flags.kubectl} apply -f ${file}`);
    } finally {
      cleanupTempFile(file);
    }
  }

  // Istio/IstioCNI/ZTunnel are cluster-scoped CRDs (sailoperator.io/v1); `kubectl wait`
  // targets them without a namespace flag.
  static async #waitForCrReady(kind, name, flags, spinner, timeoutSec = DEFAULTS.WAIT_TIMEOUT_SEC) {
    const result = await CommandRunner.exec(
      `kubectl ${flags.kubectl} wait --for=condition=Ready ${kind}/${name} --timeout=${timeoutSec}s`,
      { ignoreError: true }
    );
    if (result.exitCode) {
      throw new Error(
        `${kind}/${name} did not become Ready within timeout: ${result.stderr || result.stdout}`
      );
    }
    spinner.log(`${kind}/${name} is Ready`, 'success');
  }
}
