import yaml from 'js-yaml';
import { join } from 'path';
import { tmpdir } from 'os';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { CommandRunner, Logger } from './common.js';
import { IstioctlHelper } from './istioctl.js';

const EW_GATEWAY_NAME = 'istio-eastwestgateway';
const EW_GATEWAY_NAMESPACE = 'istio-system';
const EW_ADDRESS_POLL_INTERVAL_MS = 10000;
const EW_ADDRESS_POLL_MAX = 36; // 6 minutes
const VERIFY_MAX_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 30000;

/**
 * Links clusters via standard `istioctl create-remote-secret` multi-primary,
 * multi-network peering — not Solo's proprietary peering system in
 * multicluster.js (ClusterLinker/EastWestGateway/PeeringInstaller), which only
 * works when every participating cluster runs a compatible Solo peering
 * controller. Used for `spec.mesh.multicluster: { mode: 'remote-secret' }`
 * profiles, e.g. federating with a non-Solo mesh (OSSM3/Sail Operator) that
 * has none.
 *
 * Each cluster's east-west Gateway is created twice: once under its own
 * vendor's real GatewayClass, and once more as a "shim" under the OTHER
 * vendor's expected GatewayClass name, with its status hand-patched to the
 * real gateway's address. This works around a genuine bug in Solo's Istio
 * fork (`EastWestGatewayClassName` renamed from upstream's `istio-east-west`
 * to `istio-eastwest`) that makes each vendor's ambient multi-network gateway
 * discovery reject the other vendor's real gateway — see
 * docs/cross-mesh-federation/instructions.md Step 6 for the full writeup.
 * This is a workaround for that bug, not a supported pattern: remove once
 * Solo's constant is reverted or made configurable.
 *
 * Configuration:
 * {
 *   clusters: [{ name, context, eastWestGatewayClassName }],
 *   istioImage: string,   // for istioctl resolution (create-remote-secret)
 * }
 */
export class RemoteSecretLinker {
  constructor(config) {
    this.config = config;
  }

  async deploy() {
    const { clusters } = this.config;
    Logger.info(`Linking ${clusters.length} clusters via standard remote-secret multicluster...`);

    const addresses = await this.#deployRealGateways(clusters);
    await this.#deployShimGateways(clusters, addresses);
    await this.#exchangeRemoteSecrets(clusters);

    Logger.success('Clusters linked via remote-secret multicluster');
    await this.#verifyRemoteSecrets(clusters);
  }

  async cleanup() {
    const { clusters } = this.config;
    Logger.info('Cleaning up remote-secret multicluster linking...');

    for (const cluster of clusters) {
      const ctx = cluster.context ? `--context=${cluster.context}` : '';
      try {
        await CommandRunner.exec(
          `kubectl ${ctx} delete gateway ${EW_GATEWAY_NAME} ${EW_GATEWAY_NAME}-shim -n ${EW_GATEWAY_NAMESPACE} --ignore-not-found=true`
        );
        for (const peer of clusters.filter(c => c.name !== cluster.name)) {
          await CommandRunner.exec(
            `kubectl ${ctx} delete secret istio-remote-secret-${peer.name} -n ${EW_GATEWAY_NAMESPACE} --ignore-not-found=true`
          );
        }
        Logger.info(`Remote-secret linking removed from ${cluster.name}`);
      } catch {
        Logger.warn(`Could not fully clean up remote-secret linking from ${cluster.name}`);
      }
    }

    Logger.success('Remote-secret multicluster linking cleaned up');
  }

  // ── Real east-west gateways ──────────────────────────────────────────────

  async #deployRealGateways(clusters) {
    const addresses = {};
    for (const cluster of clusters) {
      const ctx = cluster.context ? `--context=${cluster.context}` : '';
      Logger.info(`Creating real east-west gateway on ${cluster.name}...`);

      const gateway = this.#buildGateway({
        name: EW_GATEWAY_NAME,
        network: cluster.name,
        gatewayClassName: cluster.eastWestGatewayClassName,
      });
      await this.#applyYaml(gateway, ctx, `ew-${cluster.name}`);

      addresses[cluster.name] = await this.#waitForGatewayAddress(cluster, EW_GATEWAY_NAME);
      Logger.success(`${cluster.name} east-west gateway address: ${addresses[cluster.name]}`);
    }
    return addresses;
  }

  // ── Shim gateways (Solo GatewayClass-naming bug workaround) ─────────────

  async #deployShimGateways(clusters, addresses) {
    Logger.warn(
      "Creating GatewayClass-name shim gateways — this works around a known bug in Solo's " +
        'Istio fork (EastWestGatewayClassName diverges from upstream), NOT a supported ' +
        'pattern. See docs/cross-mesh-federation/instructions.md Step 6.'
    );

    for (const cluster of clusters) {
      const ctx = cluster.context ? `--context=${cluster.context}` : '';

      for (const peer of clusters.filter(c => c.name !== cluster.name)) {
        const shimName = `${EW_GATEWAY_NAME}-shim`;
        Logger.info(
          `Creating shim gateway on ${cluster.name} using ${peer.name}'s GatewayClass (${peer.eastWestGatewayClassName})...`
        );

        const gateway = this.#buildGateway({
          name: shimName,
          network: cluster.name,
          gatewayClassName: peer.eastWestGatewayClassName,
          serviceAccountAnnotation: EW_GATEWAY_NAME,
        });
        await this.#applyYaml(gateway, ctx, `ew-shim-${cluster.name}`);
        await this.#patchGatewayStatusAddress(cluster, shimName, addresses[cluster.name]);
      }
    }
  }

  #buildGateway({ name, network, gatewayClassName, serviceAccountAnnotation }) {
    const annotations = {};
    if (serviceAccountAnnotation) {
      annotations['gateway.istio.io/service-account'] = serviceAccountAnnotation;
    }

    return {
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'Gateway',
      metadata: {
        name,
        namespace: EW_GATEWAY_NAMESPACE,
        labels: { 'topology.istio.io/network': network },
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
      spec: {
        gatewayClassName,
        listeners: [
          {
            name: 'mesh',
            port: 15008,
            protocol: 'HBONE',
            tls: {
              mode: 'Terminate',
              options: { 'gateway.istio.io/tls-terminate-mode': 'ISTIO_MUTUAL' },
            },
          },
        ],
      },
    };
  }

  async #patchGatewayStatusAddress(cluster, gatewayName, address) {
    const ctx = cluster.context ? `--context=${cluster.context}` : '';
    const addressType = /^(\d{1,3}\.){3}\d{1,3}$/.test(address) ? 'IPAddress' : 'Hostname';
    const patch = JSON.stringify({
      status: { addresses: [{ type: addressType, value: address }] },
    });

    await CommandRunner.exec(
      `kubectl ${ctx} patch gateway ${gatewayName} -n ${EW_GATEWAY_NAMESPACE} --type=merge --subresource=status -p '${patch}'`
    );
  }

  async #waitForGatewayAddress(cluster, gatewayName) {
    const ctx = cluster.context ? `--context=${cluster.context}` : '';

    for (let i = 0; i < EW_ADDRESS_POLL_MAX; i++) {
      const result = await CommandRunner.exec(
        `kubectl ${ctx} get gateway ${gatewayName} -n ${EW_GATEWAY_NAMESPACE} -o jsonpath="{.status.addresses[0].value}"`,
        { ignoreError: true }
      );
      const addr = result.stdout?.trim();
      if (addr) return addr;

      if (i === 0) Logger.info(`Waiting for east-west gateway address on ${cluster.name}...`);
      await new Promise(resolve => setTimeout(resolve, EW_ADDRESS_POLL_INTERVAL_MS));
    }

    throw new Error(`Timed out waiting for east-west gateway address on ${cluster.name}`);
  }

  // ── Remote secrets ────────────────────────────────────────────────────────

  async #exchangeRemoteSecrets(clusters) {
    const istioctl = await IstioctlHelper.resolve({ istioImage: this.config.istioImage });
    if (!istioctl) {
      throw new Error('istioctl could not be resolved or downloaded for create-remote-secret');
    }
    const bin = istioctl.includes('/') ? `"${istioctl}"` : istioctl;

    for (const cluster of clusters) {
      const ctx = cluster.context ? `--context=${cluster.context}` : '';
      Logger.info(`Generating remote secret for ${cluster.name}...`);

      const result = await CommandRunner.exec(
        `${bin} create-remote-secret ${ctx} --name=${cluster.name}`
      );
      // istioctl defaults the generated Secret's namespace to 'default'; istiod's
      // remote-secret controller only watches its own namespace, so an unpatched
      // secret is silently ignored — no error, endpoints just never appear.
      const secretYaml = result.stdout.replace(
        /namespace: default/g,
        `namespace: ${EW_GATEWAY_NAMESPACE}`
      );
      const file = join(tmpdir(), `.mesh-remote-secret-${cluster.name}-${process.pid}.yaml`);
      writeFileSync(file, secretYaml);

      try {
        for (const peer of clusters.filter(c => c.name !== cluster.name)) {
          const peerCtx = peer.context ? `--context=${peer.context}` : '';
          Logger.info(`Applying ${cluster.name}'s remote secret on ${peer.name}...`);
          await CommandRunner.exec(`kubectl ${peerCtx} apply -f ${file}`);
        }
      } finally {
        if (existsSync(file)) {
          try {
            unlinkSync(file);
          } catch {
            /* best effort */
          }
        }
      }
    }
  }

  async #verifyRemoteSecrets(clusters) {
    for (const cluster of clusters) {
      const ctx = cluster.context ? `--context=${cluster.context}` : '';
      const expectedPeers = clusters.filter(c => c.name !== cluster.name).length;
      let count = 0;

      for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
        const result = await CommandRunner.exec(
          `kubectl ${ctx} get secret -n ${EW_GATEWAY_NAMESPACE} -l istio/multiCluster=true --no-headers`,
          { ignoreError: true }
        );
        count = (result.stdout || '').trim().split('\n').filter(Boolean).length;
        if (count >= expectedPeers) break;

        if (attempt < VERIFY_MAX_ATTEMPTS) {
          Logger.info(
            `${cluster.name}: ${count}/${expectedPeers} remote secret(s) found — retrying in 30s...`
          );
          await new Promise(resolve => setTimeout(resolve, VERIFY_INTERVAL_MS));
        }
      }

      if (count >= expectedPeers) {
        Logger.success(`${cluster.name}: ${count} remote secret(s) present`);
      } else {
        Logger.warn(
          `${cluster.name}: expected ${expectedPeers} remote secret(s), found ${count} after retries`
        );
      }
    }
  }

  async #applyYaml(resource, ctx, tmpName) {
    const file = join(tmpdir(), `.mesh-remote-secret-linker-${tmpName}-${process.pid}.yaml`);
    writeFileSync(file, yaml.dump(resource, { lineWidth: -1 }));
    try {
      await CommandRunner.exec(`kubectl ${ctx} apply -f ${file}`);
    } finally {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          /* best effort */
        }
      }
    }
  }
}
