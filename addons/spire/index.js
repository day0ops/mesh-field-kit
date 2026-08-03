import { AddonFeature } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner } from '../../src/lib/common.js';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import yaml from 'js-yaml';

const SPIRE_HELM_REPO_NAME = 'spire';
const SPIRE_HELM_REPO_URL = 'https://spiffe.github.io/helm-charts-hardened/';
const SPIRE_CERTS_WORK_DIR = join(tmpdir(), 'mesh-spire-certs');

const VALID_CERT_MODES = ['self-signed', 'cert-manager', 'manual'];

/**
 * SPIRE Addon Feature
 *
 * Installs SPIRE server and agents for workload identity attestation
 * in Istio Ambient mesh. Must run as a pre-phase addon (before istiod/ztunnel).
 *
 * Reference: https://docs.solo.io/istio/1.30.x/ambient/security/spire/
 *
 * Configuration:
 * {
 *   spireNamespace: string,     // Default: 'spire-server'
 *   trustDomain: string,        // Default: cluster.name
 *   spireVersion: string,       // Default: '0.24.2'
 *   spireCrdsVersion: string,   // Default: '0.5.0'
 *   certMode: string,           // 'self-signed' | 'cert-manager' | 'manual'
 *   certs: {                    // manual mode only
 *     caCert: string,           // Path to intermediate CA cert
 *     caKey: string,            // Path to intermediate CA private key
 *     caChain: string,          // Path to cert chain (intermediate + root)
 *   },
 *   certManager: {              // cert-manager mode only
 *     issuerRef: {
 *       name: string,           // Default: 'selfsigned-issuer'
 *       kind: string,           // Default: 'ClusterIssuer'
 *     }
 *   }
 * }
 *
 * self-signed and cert-manager modes both stamp the intermediate CA cert with a
 * trustDomain SAN (DNS + SPIFFE URI), which ztunnel's VALIDATE_SPIFFE_TRUST_DOMAIN_NAMES=STRICT
 * chain verification requires. manual mode's supplied CA must carry the same SAN itself.
 */
export class SpireFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.spireNamespace = config.spireNamespace || 'spire-server';
    this.trustDomain = config.trustDomain || config.clusterName || 'cluster.local';
    this.spireVersion = config.spireVersion || '0.24.2';
    this.spireCrdsVersion = config.spireCrdsVersion || '0.5.0';
    this.certMode = config.certMode || 'self-signed';
    this.certs = config.certs || null;
    this.certManager = config.certManager || {};
    this.kubeContext = config.kubeContext || null;
  }

  validate() {
    if (!VALID_CERT_MODES.includes(this.certMode)) {
      throw new Error(
        `Invalid certMode '${this.certMode}'. Must be: ${VALID_CERT_MODES.join(', ')}`
      );
    }
    if (this.certMode === 'manual') {
      if (!this.certs?.caCert || !this.certs?.caKey || !this.certs?.caChain) {
        throw new Error('manual certMode requires certs.caCert, certs.caKey, and certs.caChain');
      }
    }
    return true;
  }

  get certsWorkDir() {
    return SPIRE_CERTS_WORK_DIR;
  }

  get certManagerIssuerRef() {
    return {
      name: this.certManager?.issuerRef?.name || 'selfsigned-issuer',
      kind: this.certManager?.issuerRef?.kind || 'ClusterIssuer',
    };
  }

  /**
   * Use cert-manager to issue an intermediate CA, then build the SPIRE secret.
   * Requires cert-manager to be installed and the issuer to exist.
   */
  async #prepareCertManagerCerts(context) {
    this.log('Preparing SPIRE CA certificates (cert-manager)...', 'info');
    const issuerRef = this.certManagerIssuerRef;
    const certName = 'spire-upstream-ca';
    const secretName = 'spire-upstream-ca-cm';

    const certificate = {
      apiVersion: 'cert-manager.io/v1',
      kind: 'Certificate',
      metadata: { name: certName, namespace: this.spireNamespace },
      spec: {
        secretName,
        duration: '87600h',
        renewBefore: '720h',
        isCA: true,
        commonName: `SPIRE Intermediate CA - ${this.trustDomain}`,
        subject: { organizations: ['SPIRE'] },
        // required for ztunnel's VALIDATE_SPIFFE_TRUST_DOMAIN_NAMES=STRICT chain verification
        dnsNames: [this.trustDomain],
        uris: [`spiffe://${this.trustDomain}`],
        issuerRef: { name: issuerRef.name, kind: issuerRef.kind, group: 'cert-manager.io' },
        secretTemplate: { labels: { 'spire.io/upstream-ca': 'true' } },
        privateKey: { algorithm: 'RSA', size: 2048 },
      },
    };

    await this.applyResource(certificate, context);
    this.log(`Waiting for cert-manager secret '${secretName}'...`, 'info');
    await this.#waitForSecret(secretName, this.spireNamespace, context);

    // Extract certs from cert-manager secret (use exec to capture stdout)
    const ctxFlag = context ? `--context=${context}` : '';
    const result = await CommandRunner.exec(
      `kubectl ${ctxFlag} get secret ${secretName} -n ${this.spireNamespace} -o jsonpath={.data}`,
      { ignoreError: false }
    );
    const data = JSON.parse(result.stdout || '{}');
    const caCert = Buffer.from(data['tls.crt'] || '', 'base64').toString('utf8');
    const caKey = Buffer.from(data['tls.key'] || '', 'base64').toString('utf8');

    // ca.crt from cert-manager contains the full chain in newer versions;
    // fall back to tls.crt only if ca.crt is absent
    const caBundle = data['ca.crt']
      ? Buffer.from(data['ca.crt'], 'base64').toString('utf8')
      : caCert;

    await this.#createUpstreamCaSecret(caCert, caKey, caBundle, context);
    this.log('SPIRE upstream CA secret created via cert-manager', 'success');
  }

  /**
   * Read user-provided cert files and create the SPIRE upstream CA secret.
   */
  async #prepareManualCerts(context) {
    this.log('Preparing SPIRE CA certificates (manual)...', 'info');
    const caCert = readFileSync(this.certs.caCert, 'utf8');
    const caKey = readFileSync(this.certs.caKey, 'utf8');
    const caBundle = readFileSync(this.certs.caChain, 'utf8');
    await this.#createUpstreamCaSecret(caCert, caKey, caBundle, context);
    this.log('SPIRE upstream CA secret created from manual certs', 'success');
  }

  /**
   * Generate (or reuse) a shared root CA and per-cluster intermediate CA.
   * Secret format: spiffe-upstream-ca with tls.crt / tls.key / bundle.crt
   */
  async #prepareSelfSignedCerts(context) {
    this.log('Preparing SPIRE CA certificates (self-signed)...', 'info');
    mkdirSync(SPIRE_CERTS_WORK_DIR, { recursive: true });

    const rootKeyPath = join(SPIRE_CERTS_WORK_DIR, 'root-key.pem');
    const rootCertPath = join(SPIRE_CERTS_WORK_DIR, 'root-cert.pem');
    const clusterDir = join(SPIRE_CERTS_WORK_DIR, this.trustDomain.replace(/\//g, '-'));
    mkdirSync(clusterDir, { recursive: true });

    const caKeyPath = join(clusterDir, 'ca.key');
    const caCsrPath = join(clusterDir, 'ca.csr');
    const caCertPath = join(clusterDir, 'ca.crt');
    const caBundlePath = join(clusterDir, 'ca-chain.pem');
    const extFilePath = join(clusterDir, 'ca-ext.cnf');

    // Generate or reuse shared root CA
    if (!existsSync(rootKeyPath)) {
      this.log('Generating shared SPIRE root CA...', 'info');
      await CommandRunner.exec(`openssl genrsa -out "${rootKeyPath}" 2048`);
      await CommandRunner.exec(
        `openssl req -new -x509 -days 3650 -key "${rootKeyPath}" ` +
          `-out "${rootCertPath}" -subj "/CN=SPIRE Root CA"`
      );
    } else {
      this.log('Shared SPIRE root CA already exists, reusing', 'info');
    }

    // Generate per-cluster intermediate CA
    this.log(`Generating intermediate CA for trust domain '${this.trustDomain}'...`, 'info');

    // subjectAltName carries the trust domain on the intermediate CA itself (not just the
    // leaf SVID) - required for ztunnel's VALIDATE_SPIFFE_TRUST_DOMAIN_NAMES=STRICT chain
    // verification, which walks the chain looking for an ancestor SAN matching the trust domain.
    writeFileSync(
      extFilePath,
      '[req]\ndistinguished_name = req_distinguished_name\n' +
        'req_extensions = v3_req\nprompt = no\n' +
        '[req_distinguished_name]\nCN = SPIRE Intermediate CA\n' +
        '[v3_req]\nkeyUsage = critical, keyCertSign, cRLSign\n' +
        'basicConstraints = critical, CA:true, pathlen:1\n' +
        'subjectKeyIdentifier = hash\n' +
        `subjectAltName = DNS:${this.trustDomain}, URI:spiffe://${this.trustDomain}\n`
    );

    await CommandRunner.exec(`openssl genrsa -out "${caKeyPath}" 2048`);
    await CommandRunner.exec(
      `openssl req -new -key "${caKeyPath}" -out "${caCsrPath}" ` +
        `-config "${extFilePath}" -subj "/CN=SPIRE Intermediate CA"`
    );
    await CommandRunner.exec(
      `openssl x509 -req -in "${caCsrPath}" -CA "${rootCertPath}" -CAkey "${rootKeyPath}" ` +
        `-CAcreateserial -out "${caCertPath}" -days 1825 -extensions v3_req -extfile "${extFilePath}"`
    );

    // Build chain: intermediate + root
    writeFileSync(
      caBundlePath,
      readFileSync(caCertPath, 'utf8') + readFileSync(rootCertPath, 'utf8')
    );

    await this.#createUpstreamCaSecret(
      readFileSync(caCertPath, 'utf8'),
      readFileSync(caKeyPath, 'utf8'),
      readFileSync(caBundlePath, 'utf8'),
      context
    );

    this.log('SPIRE upstream CA secret created', 'success');
  }

  /**
   * Create the spiffe-upstream-ca secret in spireNamespace.
   * Overwrites any existing secret.
   */
  async #createUpstreamCaSecret(caCert, caKey, caBundle, context) {
    const ctxArgs = context ? [`--context=${context}`] : [];

    // Write temp files for kubectl --from-literal doesn't support multi-line well
    const tmpCert = join(tmpdir(), `spire-ca-cert-${process.pid}.pem`);
    const tmpKey = join(tmpdir(), `spire-ca-key-${process.pid}.pem`);
    const tmpBundle = join(tmpdir(), `spire-ca-bundle-${process.pid}.pem`);

    try {
      writeFileSync(tmpCert, caCert, 'utf8');
      writeFileSync(tmpKey, caKey, 'utf8');
      writeFileSync(tmpBundle, caBundle, 'utf8');

      // Delete existing secret if present (idempotent)
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'delete',
          'secret',
          'spiffe-upstream-ca',
          '-n',
          this.spireNamespace,
          '--ignore-not-found=true',
        ],
        { spinner: this.spinner }
      );

      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          'create',
          'secret',
          'generic',
          'spiffe-upstream-ca',
          `-n`,
          this.spireNamespace,
          `--from-file=tls.crt=${tmpCert}`,
          `--from-file=tls.key=${tmpKey}`,
          `--from-file=bundle.crt=${tmpBundle}`,
        ],
        { spinner: this.spinner }
      );
    } finally {
      for (const f of [tmpCert, tmpKey, tmpBundle]) {
        try {
          unlinkSync(f);
        } catch {
          /* best effort */
        }
      }
    }
  }

  async #prepareCerts(context) {
    switch (this.certMode) {
      case 'self-signed':
        return this.#prepareSelfSignedCerts(context);
      case 'cert-manager':
        return this.#prepareCertManagerCerts(context);
      case 'manual':
        return this.#prepareManualCerts(context);
      default:
        throw new Error(`Unknown certMode: ${this.certMode}`);
    }
  }

  async #waitForSecret(name, namespace, context, timeoutMs = 120000) {
    const ctxFlag = context ? `--context=${context}` : '';
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = await CommandRunner.exec(
        `kubectl ${ctxFlag} get secret ${name} -n ${namespace}`,
        { ignoreError: true }
      );
      if (!result.exitCode) return;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    throw new Error(`Secret '${name}' not found in '${namespace}' within timeout`);
  }

  buildSpireHelmValues() {
    const tolerations = [
      { effect: 'NoSchedule', operator: 'Exists' },
      { key: 'CriticalAddonsOnly', operator: 'Exists' },
      { effect: 'NoExecute', operator: 'Exists' },
    ];
    return {
      global: {
        spire: { trustDomain: this.trustDomain },
      },
      'spire-agent': {
        authorizedDelegates: [`spiffe://${this.trustDomain}/ns/istio-system/sa/ztunnel`],
        sockets: {
          admin: { enabled: true, mountOnHost: true },
          hostBasePath: '/run/spire/agent/sockets',
        },
        tolerations,
      },
      'spire-server': {
        upstreamAuthority: {
          disk: {
            enabled: true,
            secret: { create: false, name: 'spiffe-upstream-ca' },
          },
        },
      },
      'spiffe-csi-driver': {
        tolerations,
      },
    };
  }

  async deploy() {
    this.log(`Installing SPIRE (trust domain: ${this.trustDomain})...`, 'info');

    // 1. Ensure spire-server namespace
    await this.ensureNamespace(this.spireNamespace, this.kubeContext);
    this.log(`Namespace '${this.spireNamespace}' ready`, 'info');

    // 2. Prepare upstream CA secret
    await this.#prepareCerts(this.kubeContext);

    // 3. Add SPIRE Helm repo
    await this.#addHelmRepo();

    // 4. Install spire-crds
    await this.#installSpirecRDs();

    // 5. Install spire
    await this.#installSpire();

    // 6. Wait for SPIRE pods
    await this.#waitForSpirePods();

    // 7. Register ClusterSPIFFEIDs
    await this.#applyClusterSpiffeIDs();

    this.log('SPIRE installed successfully', 'success');
  }

  async #addHelmRepo() {
    this.log('Adding SPIRE Helm repository...', 'info');
    await CommandRunner.run('helm', ['repo', 'add', SPIRE_HELM_REPO_NAME, SPIRE_HELM_REPO_URL], {
      ignoreError: true,
    });
    await CommandRunner.run('helm', ['repo', 'update', SPIRE_HELM_REPO_NAME]);
  }

  async #installSpirecRDs() {
    this.log(`Installing spire-crds chart (${this.spireCrdsVersion})...`, 'info');
    const args = [
      'upgrade',
      '-i',
      'spire-crds',
      `${SPIRE_HELM_REPO_NAME}/spire-crds`,
      '--namespace',
      this.spireNamespace,
      '--version',
      this.spireCrdsVersion,
      '--create-namespace',
      '--wait',
    ];
    if (this.kubeContext) args.push('--kube-context', this.kubeContext);
    await KubernetesHelper.helm(args, { spinner: this.spinner });
  }

  async #installSpire() {
    this.log(`Installing spire chart (${this.spireVersion})...`, 'info');
    const valuesYaml = yaml.dump(this.buildSpireHelmValues(), { lineWidth: -1 });
    const tmpValues = join(tmpdir(), `spire-values-${process.pid}.yaml`);
    try {
      writeFileSync(tmpValues, valuesYaml, 'utf8');
      const args = [
        'upgrade',
        '-i',
        'spire',
        `${SPIRE_HELM_REPO_NAME}/spire`,
        '--namespace',
        this.spireNamespace,
        '--version',
        this.spireVersion,
        '-f',
        tmpValues,
        '--wait',
        '--timeout',
        '5m',
      ];
      if (this.kubeContext) args.push('--kube-context', this.kubeContext);
      await KubernetesHelper.helm(args, { spinner: this.spinner });
    } finally {
      try {
        unlinkSync(tmpValues);
      } catch {
        /* best effort */
      }
    }
    this.log('spire chart installed', 'info');
  }

  async #waitForSpirePods() {
    this.log('Waiting for SPIRE pods to be ready...', 'info');
    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    try {
      await KubernetesHelper.kubectl(
        [
          ...ctxArgs,
          '-n',
          this.spireNamespace,
          'wait',
          '--for=condition=Ready',
          'pods',
          '--all',
          '--timeout=300s',
        ],
        { spinner: this.spinner }
      );
    } catch (error) {
      this.log(`Warning: some SPIRE pods may not be ready: ${error.message}`, 'warn');
    }
    this.log('SPIRE pods ready', 'info');
  }

  async #applyClusterSpiffeIDs() {
    this.log('Applying ClusterSPIFFEID resources...', 'info');
    const ids = [
      {
        name: 'istio-ztunnel-reg',
        template: `spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}`,
        matchLabels: { app: 'ztunnel' },
      },
      {
        name: 'istio-waypoint-reg',
        template: `spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}`,
        matchLabels: { 'istio.io/gateway-name': 'waypoint' },
      },
      {
        name: 'istio-ambient-reg',
        template: `spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}`,
        matchLabels: { 'istio.io/dataplane-mode': 'ambient' },
      },
    ];

    for (const id of ids) {
      const resource = {
        apiVersion: 'spire.spiffe.io/v1alpha1',
        kind: 'ClusterSPIFFEID',
        metadata: { name: id.name },
        spec: {
          spiffeIDTemplate: id.template,
          podSelector: { matchLabels: id.matchLabels },
        },
      };
      await this.applyResource(resource, this.kubeContext);
      this.log(`ClusterSPIFFEID '${id.name}' applied`, 'info');
    }
  }

  async cleanup() {
    this.log('Cleaning up SPIRE...', 'info');

    const ctxArgs = this.kubeContext ? [`--context=${this.kubeContext}`] : [];
    const helmCtxArgs = this.kubeContext ? ['--kube-context', this.kubeContext] : [];

    // 1. Delete ClusterSPIFFEID resources
    for (const name of ['istio-ambient-reg', 'istio-waypoint-reg', 'istio-ztunnel-reg']) {
      try {
        await KubernetesHelper.kubectl(
          [...ctxArgs, 'delete', 'clusterspiffeid', name, '--ignore-not-found=true'],
          { spinner: this.spinner }
        );
      } catch {
        // best effort
      }
    }

    // 2. Uninstall spire Helm chart
    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        'spire',
        '-n',
        this.spireNamespace,
      ]);
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) {
        this.log(`Warning: could not uninstall spire chart: ${error.message}`, 'warn');
      }
    }

    // 3. Uninstall spire-crds Helm chart
    try {
      await CommandRunner.run('helm', [
        ...helmCtxArgs,
        'uninstall',
        'spire-crds',
        '-n',
        this.spireNamespace,
      ]);
    } catch (error) {
      if (!/not found|no deployed releases/i.test(error.message)) {
        this.log(`Warning: could not uninstall spire-crds chart: ${error.message}`, 'warn');
      }
    }

    // 4. Delete namespace
    try {
      await KubernetesHelper.kubectl(
        [...ctxArgs, 'delete', 'namespace', this.spireNamespace, '--ignore-not-found=true'],
        { spinner: this.spinner }
      );
    } catch {
      // best effort
    }

    this.log('SPIRE cleaned up', 'success');
  }
}
