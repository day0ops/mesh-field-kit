import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Feature } from '../../../src/lib/feature.js';
import { CommandRunner } from '../../../src/lib/common.js';
import { SshRunner } from '../../../src/lib/ssh-runner.js';
import { IstioctlHelper } from '../../../src/lib/istioctl.js';
import { EastWestGateway } from '../../../src/lib/multicluster.js';

/**
 * VM Integration Feature
 *
 * Onboards workloads running on a plain VM to the ambient mesh, using the
 * multi-workload `istioctl vm add-workload` path (each workload gets its own
 * SPIFFE identity). See:
 * https://docs.solo.io/istio/1.30.x/ambient/setup/sample-apps/vm-integration/
 *
 * Configuration:
 * {
 *   namespace: string,          // Required: namespace for the VM workloads' k8s resources
 *   vmIp: string,               // Required: SSH-reachable VM IP (typically the public IP)
 *   meshAddress: string,        // Optional: address registered with istiod for cluster->VM
 *                               // routing (default: vmIp). Use the VM's private IP when it
 *                               // shares a VPC with the cluster — reaching a same-VPC public
 *                               // IP from cluster nodes needs IGW hairpin NAT, which isn't
 *                               // reliable; the private IP routes directly.
 *   sshKeyPath: string,         // Required: local path to the VM's SSH private key
 *   sshUser: string,            // Optional: SSH user (default: 'ec2-user')
 *   context: string,            // Optional: kubectl context to target
 *   eastWestNamespace: string,  // Optional: namespace for the east-west gateway (default: 'istio-eastwest')
 *   istioImage: string,         // Optional: ztunnel image tag (default: ISTIO_IMAGE/ISTIO_VERSION env)
 *   istioRepo: string,          // Optional: ztunnel image repo (default: 'us-docker.pkg.dev/soloio-img/istio')
 *   installDemoApp: boolean,    // Optional: start a minimal static HTTP responder on each
 *                               // workload's target port (default: true). Set to false if
 *                               // the VM already runs a real application on those ports.
 *   workloads: [                // Required: at least one workload
 *     { name: string, ports: string[] }, // ports e.g. ['http:80:8080']
 *   ],
 * }
 */
export class VmIntegrationFeature extends Feature {
  validate() {
    if (!this.config.namespace) {
      throw new Error('namespace is required for VM Integration feature');
    }
    if (!this.config.vmIp) {
      throw new Error('vmIp is required for VM Integration feature');
    }
    if (!this.config.sshKeyPath) {
      throw new Error('sshKeyPath is required for VM Integration feature');
    }
    if (!this.config.workloads || this.config.workloads.length === 0) {
      throw new Error('workloads is required for VM Integration feature (at least one workload)');
    }
    for (const workload of this.config.workloads) {
      if (!workload.name) {
        throw new Error('Each VM workload requires a name');
      }
      if (!workload.ports || workload.ports.length === 0) {
        throw new Error(`VM workload '${workload.name}' requires at least one port (e.g. 'http:80:8080')`);
      }
    }
    return true;
  }

  async deploy() {
    const {
      namespace,
      vmIp,
      meshAddress = vmIp,
      sshKeyPath,
      sshUser = 'ec2-user',
      context = null,
      eastWestNamespace = 'istio-eastwest',
      istioImage = process.env.ISTIO_IMAGE || process.env.ISTIO_VERSION,
      istioRepo = process.env.ISTIO_REPO || 'us-docker.pkg.dev/soloio-img/istio',
      installDemoApp = true,
      workloads,
    } = this.config;

    if (!istioImage) {
      throw new Error('istioImage is required (set feature config.istioImage or ISTIO_VERSION/ISTIO_IMAGE env)');
    }

    const ssh = new SshRunner(sshKeyPath, sshUser);

    this.log(`Deploying VM integration '${namespace}' for VM ${vmIp}`, 'info');

    await this.ensureNamespace(namespace, context);

    this.log(`Ensuring east-west gateway in '${eastWestNamespace}'...`, 'info');
    await new EastWestGateway({
      clusters: [{ name: 'local', context }],
      namespace: eastWestNamespace,
    }).deploy();

    this.log('Resolving VM hostname...', 'info');
    const hostnameResult = await ssh.exec(vmIp, 'hostname');
    const vmHostname = hostnameResult.stdout.trim();

    const tokenDir = join(tmpdir(), `mesh-vm-tokens-${process.pid}-${Date.now()}`);
    mkdirSync(tokenDir, { recursive: true });

    let bootstrapToken = null;
    try {
      for (let i = 0; i < workloads.length; i++) {
        const workload = workloads[i];
        const isFirst = i === 0;
        this.log(`Adding VM workload '${workload.name}'...`, 'info');

        const result = await IstioctlHelper.vmAddWorkload({
          name: workload.name,
          address: meshAddress,
          namespace,
          ports: workload.ports.join('/'),
          external: isFirst,
          hostname: isFirst ? vmHostname : null,
          outputDir: tokenDir,
          context,
        });

        if (result.bootstrapToken) {
          bootstrapToken = result.bootstrapToken;
        }
      }

      if (!bootstrapToken) {
        throw new Error('istioctl vm add-workload did not produce a BOOTSTRAP_TOKEN');
      }

      for (const workload of workloads) {
        const remoteDir = `/etc/ztunnel/tokens/${namespace}/${workload.name}`;
        this.log(`Copying token for '${workload.name}' to the VM...`, 'info');
        await ssh.exec(vmIp, `sudo mkdir -p ${remoteDir}`);
        await ssh.copyFile(join(tokenDir, `${workload.name}.token`), vmIp, `/tmp/${workload.name}.token`);
        await ssh.exec(vmIp, `sudo mv /tmp/${workload.name}.token ${remoteDir}/token`);
        // ztunnel runs as a non-root distroless user; the token must be world-readable for it to load.
        await ssh.exec(vmIp, `sudo chmod 644 ${remoteDir}/token`);
      }
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }

    await this.#ensureDocker(ssh, vmIp);

    const ztunnelImage = `${istioRepo}/ztunnel:${istioImage}`;
    this.log(`Starting ztunnel (${ztunnelImage}) on the VM...`, 'info');
    await ssh.exec(vmIp, 'sudo docker stop ztunnel', { ignoreError: true });
    await ssh.exec(vmIp, 'sudo docker rm ztunnel', { ignoreError: true });
    await ssh.exec(
      vmIp,
      `sudo docker run -d --name ztunnel --network host -e BOOTSTRAP_TOKEN='${bootstrapToken}' -v /etc/ztunnel:/etc/ztunnel:ro ${ztunnelImage}`
    );

    this.log(`ztunnel started on VM ${vmIp}`, 'success');

    if (installDemoApp) {
      await this.#startDemoApps(ssh, vmIp, workloads);
    }
  }

  /**
   * Start a minimal static HTTP responder on each workload's target port, so
   * there's something to actually reach through the mesh. The doc's own scope
   * is connectivity, not a real workload, so this is intentionally trivial.
   */
  async #startDemoApps(ssh, vmIp, workloads) {
    const targetPorts = new Set();
    for (const workload of workloads) {
      for (const portSpec of workload.ports) {
        const parts = portSpec.split(':');
        targetPorts.add(parts[2] || parts[1]);
      }
    }

    for (const port of targetPorts) {
      this.log(`Starting demo HTTP responder on VM port ${port}...`, 'info');
      await ssh.exec(vmIp, `pkill -f "http.server ${port}"`, { ignoreError: true });
      await ssh.exec(vmIp, `nohup python3 -m http.server ${port} --bind 127.0.0.1 > /tmp/mesh-demo-${port}.log 2>&1 &`);
    }
  }

  async #ensureDocker(ssh, vmIp) {
    const check = await ssh.exec(vmIp, 'command -v docker', { ignoreError: true });
    if (!check.exitCode && check.stdout?.trim()) {
      this.log('Docker already installed on VM', 'info');
      return;
    }
    this.log('Installing Docker on VM...', 'info');
    await ssh.exec(vmIp, 'sudo amazon-linux-extras install docker -y && sudo systemctl enable --now docker');
  }

  async cleanup() {
    const namespace = this.config.namespace;
    const context = this.config.context || null;
    const contextFlag = context ? `--context=${context}` : '';

    this.log(`Cleaning up VM integration namespace '${namespace}'...`, 'info');

    // istioctl vm add-workload's exact WorkloadEntry/Service/ServiceAccount naming
    // isn't documented, so delete the whole (dedicated) namespace instead of
    // guessing individual resource names. VM-side ztunnel is left running — it
    // goes away when `infra destroy` tears down the VM instance.
    await CommandRunner.exec(`kubectl ${contextFlag} delete namespace ${namespace} --ignore-not-found=true`);

    this.log(`Namespace '${namespace}' deleted`, 'success');
  }
}
