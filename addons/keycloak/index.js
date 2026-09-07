import { AddonFeature, FeatureManager } from '../../src/lib/feature.js';
import { KubernetesHelper, CommandRunner, waitForPublicUrl } from '../../src/lib/common.js';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_DIR = join(__dirname, 'config');

const KEYCLOAK_VERSION = '26.6.3';
const POSTGRES_VERSION = '18.2-alpine';

// Double any single quote so a value stays parseable when substituted into a
// single-quoted YAML scalar (YAML escapes a literal ' as ''). Used for the
// operator-supplied credentials that land in keycloak.yaml / postgres.yaml.
const yamlSingleQuote = value => String(value).replaceAll("'", "''");

/**
 * Keycloak Feature (manifest-based, no Helm)
 *
 * Deploys Keycloak + PostgreSQL via raw Kubernetes manifests. After pods are
 * healthy the Keycloak Admin API is used to bootstrap realms, OIDC clients,
 * and test users.
 *
 * YAML templates live in ./config/ and use {{VAR}} placeholders that are
 * resolved at deploy time.
 *
 * Configuration:
 * {
 *   keycloakNamespace: string,    // Default: 'keycloak'
 *   keycloakVersion: string,       // Keycloak image tag (default: KEYCLOAK_VERSION)
 *   keycloakImage: string,        // Image repo without tag; combined with keycloakVersion (default: quay.io/keycloak/keycloak)
 *   postgresVersion: string,      // Default: POSTGRES_VERSION
 *   hostname: string,             // Default: cluster-local FQDN
 *   protocol: string,             // Default: 'https'
 *   realm: string,                // Default: 'mesh-dev' (legacy path only)
 *   clientId: string,             // Default: 'mesh-client' (legacy path only)
 *   clientSecret: string,         // Default: 'mesh-client-secret' (legacy path only)
 *   publicClientId: string,       // Default: 'mesh-client-public' (legacy path only)
 *   storageClassName: string,     // Default: '' (use cluster default)
 *   tls: {
 *     enabled: boolean,           // Default: true
 *     secretName: string,         // Default: 'keycloak-tls'
 *     createCertificate: boolean, // Default: true
 *     clusterIssuerName: string,  // Default: 'selfsigned-issuer' (use 'letsencrypt-dns' for LE)
 *     organization: string,       // Default: 'solo.io' (cert subject organization)
 *     includeInternalDnsNames: boolean, // Default: auto (false for letsencrypt* issuers)
 *   },
 *   workloadClients: [],          // Optional: workload identity clients
 *   soloUIClients: {              // Optional: create a Solo UI realm + clients
 *     enabled: boolean,
 *     realm: string,              // Default: 'solo-ui'
 *     hostname: string,           // Solo UI HTTPS hostname
 *     backendClientId: string,
 *     backendClientSecret: string,
 *     frontendClientId: string,
 *                                   // Bootstrap password for solo-admin/solo-reader/solo-writer
 *                                   // comes from SOLO_UI_DEFAULT_PASSWORD (see below), not config.
 *   },
 *   realms: [],                   // Optional: config-driven realm setup (overrides legacy path)
 *                                  // A realm named 'grafana' gets its sole user's username/password
 *                                  // sourced from GRAFANA_REALM_ADMIN_USERNAME/PASSWORD (see below)
 *                                  // instead of the realm's own username/defaultPassword fields.
 *   externalDns: boolean,         // Optional: explicit override; auto-detected when external-dns addon is present
 * }
 *
 * Requires the following environment variables (no defaults - deploy fails
 * cleanly via validate() if any are unset):
 *   KEYCLOAK_ADMIN_USERNAME       - Keycloak master realm bootstrap admin username
 *   KEYCLOAK_ADMIN_PASSWORD       - Keycloak master realm bootstrap admin password
 *   KEYCLOAK_POSTGRES_USER        - Postgres superuser backing Keycloak's DB
 *   KEYCLOAK_POSTGRES_PASSWORD    - Postgres superuser password
 *   SOLO_UI_DEFAULT_PASSWORD      - solo-admin/solo-reader/solo-writer bootstrap password
 *                                   (only required when soloUIClients.enabled is true)
 *   GRAFANA_REALM_ADMIN_USERNAME  - Grafana OIDC demo admin username (default: 'grafana-admin';
 *                                   only used when a 'grafana' realm is configured)
 *   GRAFANA_REALM_ADMIN_PASSWORD  - Grafana OIDC demo admin password (only required when a
 *                                   'grafana' realm is configured)
 */
export class KeycloakFeature extends AddonFeature {
  constructor(name, config) {
    super(name, config);
    this.keycloakNamespace = config.keycloakNamespace || 'keycloak';
    this.keycloakVersion = config.keycloakVersion || config.version || KEYCLOAK_VERSION;
    // config.keycloakImage may be a bare repo (append keycloakVersion) or already a full
    // repo:tag reference - only append when there's no tag after the last '/', so a
    // registry:port prefix isn't mistaken for a tag.
    const hasExplicitTag = /:[^/]+$/.test(config.keycloakImage || '');
    this.keycloakImage = config.keycloakImage
      ? hasExplicitTag
        ? config.keycloakImage
        : `${config.keycloakImage}:${this.keycloakVersion}`
      : `quay.io/keycloak/keycloak:${this.keycloakVersion}`;
    this.postgresVersion = config.postgresVersion || POSTGRES_VERSION;
    this.hostname = config.hostname || 'keycloak.keycloak.svc.cluster.local';
    this.protocol = config.protocol || 'https';
    this.realm = config.realm || 'mesh-dev';
    this.clientId = config.clientId || 'mesh-client';
    this.clientSecret = config.clientSecret || 'mesh-client-secret';
    this.publicClientId = config.publicClientId || 'mesh-client-public';
    this.tlsEnabled = config.tls?.enabled !== false;
    this.tlsSecretName = config.tls?.secretName || 'keycloak-tls';
    this.createCertificate = config.tls?.createCertificate !== false;
    this.tlsClusterIssuerName = config.tls?.clusterIssuerName || 'selfsigned-issuer';
    this.tlsOrganization = config.tls?.organization || 'solo.io';
    // Public CAs (e.g. Let's Encrypt) cannot validate internal cluster DNS names
    const isPublicIssuer = this.tlsClusterIssuerName.startsWith('letsencrypt');
    this.tlsIncludeInternalDns =
      config.tls?.includeInternalDnsNames !== undefined
        ? config.tls.includeInternalDnsNames
        : !isPublicIssuer;
    this.kubeContext = config.kubeContext || null;
    this.postgres = config.postgres || null;
    this.workloadClients = config.workloadClients || [];
    this.soloUIClients = config.soloUIClients || null;
    this.soloUIRealm = config.soloUIClients?.realm || 'solo-ui';
    this.adminUsername = process.env.KEYCLOAK_ADMIN_USERNAME || '';
    this.adminPassword = process.env.KEYCLOAK_ADMIN_PASSWORD || '';
    this.postgresUser = process.env.KEYCLOAK_POSTGRES_USER || '';
    this.postgresPassword = process.env.KEYCLOAK_POSTGRES_PASSWORD || '';
    this.soloUiDefaultPassword = process.env.SOLO_UI_DEFAULT_PASSWORD || '';
    this.grafanaAdminUsername = process.env.GRAFANA_REALM_ADMIN_USERNAME || 'grafana-admin';
    this.grafanaAdminPassword = process.env.GRAFANA_REALM_ADMIN_PASSWORD || '';
    this.hasGrafanaRealm = (config.realms || []).some(r => r.realm === 'grafana');
    const clusterAddons = config.clusterAddons || [];
    this.externalDns = config.externalDns === true || clusterAddons.includes('external-dns');
  }

  validate() {
    const missing = [
      !this.adminUsername && 'KEYCLOAK_ADMIN_USERNAME',
      !this.adminPassword && 'KEYCLOAK_ADMIN_PASSWORD',
      !this.postgresUser && 'KEYCLOAK_POSTGRES_USER',
      !this.postgresPassword && 'KEYCLOAK_POSTGRES_PASSWORD',
      this.soloUIClients?.enabled && !this.soloUiDefaultPassword && 'SOLO_UI_DEFAULT_PASSWORD',
      this.hasGrafanaRealm && !this.grafanaAdminPassword && 'GRAFANA_REALM_ADMIN_PASSWORD',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `Keycloak requires the following environment variable(s) to be set: ${missing.join(', ')}.\n` +
          'Set them before deploying, e.g.:\n' +
          '  export KEYCLOAK_ADMIN_USERNAME="admin"\n' +
          '  export KEYCLOAK_ADMIN_PASSWORD="<your-password>"\n' +
          '  export KEYCLOAK_POSTGRES_USER="postgres"\n' +
          '  export KEYCLOAK_POSTGRES_PASSWORD="<your-password>"\n' +
          '  export SOLO_UI_DEFAULT_PASSWORD="<your-password>"\n' +
          '  export GRAFANA_REALM_ADMIN_PASSWORD="<your-password>"'
      );
    }
    return true;
  }

  async deploy() {
    this.log('Installing Keycloak (manifest-based)...', 'info');

    await KubernetesHelper.ensureNamespace(this.keycloakNamespace, this.spinner, this.kubeContext);

    if (this.tlsEnabled && this.createCertificate) {
      await this.applyTemplate('certificate.yaml');
      await this.waitForCertificate();
    }

    await this.applyTemplate('postgres.yaml');
    await this.waitForPostgres();
    await this.initPostgresDb();
    await this.applyTemplate('keycloak.yaml');
    if (this.externalDns) {
      await KubernetesHelper.kubectl([
        ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
        'annotate',
        'service',
        'keycloak',
        '-n',
        this.keycloakNamespace,
        `external-dns.alpha.kubernetes.io/hostname=${this.hostname}`,
        '--overwrite',
      ]);
      this.log(`Annotated keycloak service for external-dns: ${this.hostname}`, 'info');
    }
    await this.waitForKeycloak();
    if (this.externalDns) {
      // Still need the LB address so curl --resolve works during Admin API calls
      // (external-dns record may not have propagated yet)
      await this.waitForLoadBalancer();
    } else {
      await this.setupLocalDns();
    }
    await this.configureKeycloak();

    if (this.externalDns) {
      await waitForPublicUrl(this.hostname, {
        protocol: this.protocol,
        path: '/realms/master',
        spinner: this.spinner,
        log: (msg, level) => this.log(msg, level),
      });
    }

    this.log(
      `Keycloak installed successfully. Access at ${this.protocol}://${this.hostname}/`,
      'success'
    );
    this.log(
      `Keycloak admin login: ${this.adminUsername} (password: $KEYCLOAK_ADMIN_PASSWORD)`,
      'info'
    );
    if (this.soloUIClients?.enabled) {
      this.log('Solo UI login: solo-admin / $SOLO_UI_DEFAULT_PASSWORD', 'info');
    }
  }

  // ---------------------------------------------------------------------------
  // Template helpers
  // ---------------------------------------------------------------------------

  templateVars() {
    return {
      NAMESPACE: this.keycloakNamespace,
      HOSTNAME: this.hostname,
      KEYCLOAK_VERSION: this.keycloakVersion,
      KEYCLOAK_IMAGE: this.keycloakImage,
      POSTGRES_VERSION: this.postgresVersion,
      TLS_SECRET_NAME: this.tlsSecretName,
      CLUSTER_ISSUER_NAME: this.tlsClusterIssuerName,
      CERT_ORGANIZATION: this.tlsOrganization,
      ADMIN_USERNAME: yamlSingleQuote(this.adminUsername),
      ADMIN_PASSWORD: yamlSingleQuote(this.adminPassword),
      POSTGRES_USER: yamlSingleQuote(this.postgresUser),
      POSTGRES_PASSWORD: yamlSingleQuote(this.postgresPassword),
      CERT_INTERNAL_DNS_NAMES: this.tlsIncludeInternalDns
        ? `    - 'keycloak.${this.keycloakNamespace}.svc.cluster.local'\n    - 'keycloak.${this.keycloakNamespace}.svc'\n    - keycloak`
        : '',
      POSTGRES_PVC_SIZE: this.postgres?.persistentVolume?.size || '5Gi',
      STORAGE_CLASS_NAME: this.postgres?.persistentVolume?.storageClass || '',
    };
  }

  async applyTemplate(filename) {
    const raw = await readFile(join(CONFIG_DIR, filename), 'utf8');
    const vars = this.templateVars();
    const rendered = raw.replace(/\{\{(\w+)\}\}/g, (_, key) => {
      if (vars[key] === undefined)
        throw new Error(`Unknown template variable: {{${key}}} in ${filename}`);
      return vars[key];
    });

    const docs = yaml.loadAll(rendered).filter(Boolean);
    for (const doc of docs) {
      // Remove empty storageClassName to use cluster default
      if (doc.kind === 'PersistentVolumeClaim' && doc.spec?.storageClassName === '') {
        delete doc.spec.storageClassName;
      }
      await this.applyResource(doc, this.kubeContext);
    }
  }

  // ---------------------------------------------------------------------------
  // Wait helpers
  // ---------------------------------------------------------------------------

  async waitForCertificate() {
    this.log('Waiting for TLS certificate to be ready...', 'info');

    const maxAttempts = 60;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await KubernetesHelper.kubectl([
          ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
          'get',
          'certificate',
          this.tlsSecretName,
          '-n',
          this.keycloakNamespace,
          '-o',
          'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
        ]);
        if (result?.stdout?.trim() === 'True') {
          this.log('TLS certificate is ready', 'info');
          return;
        }
      } catch {
        // certificate may not exist yet
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    this.log('Certificate may not be fully ready yet, proceeding...', 'warn');
  }

  async waitForPostgres() {
    this.log('Waiting for PostgreSQL to be ready...', 'info');
    try {
      await KubernetesHelper.kubectl([
        ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
        'wait',
        '--for=condition=Ready',
        'pod',
        '-l',
        'app=postgres',
        '-n',
        this.keycloakNamespace,
        '--timeout=300s',
      ]);
    } catch (error) {
      throw new Error(`PostgreSQL did not become ready: ${error.message}`);
    }
  }

  async initPostgresDb() {
    this.log('Initialising PostgreSQL database...', 'info');
    await new Promise(r => setTimeout(r, 5000));

    const execInPg = async sql => {
      try {
        await KubernetesHelper.kubectl(
          [
            ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
            '-n',
            this.keycloakNamespace,
            'exec',
            'deploy/postgres',
            '--',
            'psql',
            '-U',
            this.postgresUser,
            '-d',
            'postgres',
            '-c',
            sql,
          ],
          { ignoreError: true }
        );
      } catch {
        // ignore – object may already exist
      }
    };

    await execInPg('CREATE DATABASE keycloak;');
    await execInPg("CREATE USER keycloak WITH PASSWORD 'password';");
    await execInPg('GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;');
  }

  async waitForKeycloak() {
    this.log('Waiting for Keycloak to be ready...', 'info');
    try {
      await KubernetesHelper.kubectl([
        ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
        'wait',
        '--for=condition=Ready',
        'pod',
        '-l',
        'app=keycloak',
        '-n',
        this.keycloakNamespace,
        '--timeout=600s',
      ]);
    } catch (error) {
      this.log(`Keycloak may not be fully ready: ${error.message}`, 'warn');
    }
  }

  // ---------------------------------------------------------------------------
  // Local DNS (/etc/hosts) so the browser can reach Keycloak via its hostname
  // ---------------------------------------------------------------------------

  async setupLocalDns() {
    this.log('Setting up local DNS for Keycloak...', 'info');

    const lbIp = await this.waitForLoadBalancer();
    if (!lbIp) {
      this.log('Could not resolve LoadBalancer IP — skipping /etc/hosts setup', 'warn');
      return;
    }

    const hostsEntry = `${lbIp} ${this.hostname}`;

    try {
      const check = await CommandRunner.exec(
        `grep -q "${this.hostname}" /etc/hosts 2>/dev/null && echo exists || echo missing`,
        { ignoreError: true }
      );

      if (check.stdout.trim() === 'exists') {
        this.log(`/etc/hosts already contains ${this.hostname}, skipping`, 'info');
        return;
      }

      this.log(`Need to add ${this.hostname} -> ${lbIp} to /etc/hosts`, 'info');
      this.log('Requesting sudo access...', 'info');
      await CommandRunner.exec('sudo -v');

      await CommandRunner.exec(`echo '${hostsEntry}' | sudo tee -a /etc/hosts > /dev/null`);
      this.log(`/etc/hosts: ${this.hostname} -> ${lbIp}`, 'success');
    } catch (error) {
      this.log(`Could not update /etc/hosts: ${error.message}`, 'warn');
      this.log(`Please add manually: ${hostsEntry}`, 'warn');
    }
  }

  async waitForLoadBalancer() {
    this.log('Waiting for Keycloak LoadBalancer IP...', 'info');

    for (let i = 0; i < 60; i++) {
      try {
        const result = await KubernetesHelper.kubectl(
          [
            ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
            'get',
            'svc',
            'keycloak',
            '-n',
            this.keycloakNamespace,
            '-o',
            'jsonpath={.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}',
          ],
          { ignoreError: true }
        );

        const addr = (result.stdout || '').trim();
        if (addr) {
          this.lbAddress = addr;
          return addr;
        }
      } catch {
        /* not ready yet */
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Post-deploy Keycloak configuration via Admin REST API
  // ---------------------------------------------------------------------------

  /**
   * Build curl --resolve args to bypass DNS when LB address is known.
   * Resolves ELB hostnames to IPs since curl --resolve requires an IP address.
   * Falls back to empty args (DNS resolution) if lookup fails.
   */
  async resolveCurlArgs() {
    if (!this.lbAddress) {
      return [];
    }

    // If it's already an IP, use it directly
    if (/^\d+\.\d+\.\d+\.\d+$/.test(this.lbAddress)) {
      const port = this.protocol === 'https' ? 443 : 8080;
      return ['--resolve', `${this.hostname}:${port}:${this.lbAddress}`];
    }

    // Resolve ELB hostname to IP via DNS
    try {
      const { promises: dns } = await import('dns');
      const addresses = await dns.resolve4(this.lbAddress);
      if (addresses.length > 0) {
        const port = this.protocol === 'https' ? 443 : 8080;
        return ['--resolve', `${this.hostname}:${port}:${addresses[0]}`];
      }
    } catch {
      // fall through
    }

    return [];
  }

  getAdminBaseUrl() {
    const port = this.protocol === 'https' ? '' : ':8080';
    return `${this.protocol}://${this.hostname}${port}`;
  }

  async configureKeycloak() {
    this.log('Configuring Keycloak via Admin API...', 'info');

    this.curlResolveArgs = await this.resolveCurlArgs();

    const baseUrl = this.getAdminBaseUrl();
    let token = await this.getAdminToken(baseUrl);

    if (this.config.realms?.length) {
      // Config-driven path: process all realms from profile config
      await this.setupRealms(baseUrl, token, this.config.realms);
    } else {
      // Legacy path
      const realmReady = await this.createAndVerify(
        `Realm '${this.realm}'`,
        () => this.createRealm(baseUrl, token),
        () => this.realmExists(baseUrl, token, this.realm),
        {
          refreshFn: async () => {
            token = await this.getAdminToken(baseUrl);
          },
        }
      );
      if (!realmReady) {
        throw new Error(`Realm '${this.realm}' could not be created — aborting Keycloak setup`);
      }
      await this.configureUserProfile(baseUrl, token);
      await this.createConfidentialClient(baseUrl, token);
      await this.createPublicClient(baseUrl, token);
      await this.createBudgetManagementClient(baseUrl, token);
      await this.createUsers(baseUrl, token);
    }

    if (this.workloadClients.length > 0) {
      await this.configureWorkloadClients(baseUrl, token);
    }

    if (this.soloUIClients?.enabled) {
      await this.createSoloUIClients(baseUrl, token);
    }

    this.log('Keycloak configuration complete', 'info');
  }

  async configureUserProfile(baseUrl, token) {
    this.log('Configuring User Profile attributes...', 'info');

    const getResult = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${this.realm}/users/profile`,
      ],
      { ignoreError: true }
    );

    let profile;
    try {
      profile = JSON.parse(getResult.stdout);
    } catch {
      this.log('Could not parse user profile, using defaults', 'warn');
      profile = { attributes: [] };
    }

    const customAttributes = [
      {
        name: 'group',
        displayName: 'Group',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'org_id',
        displayName: 'Organization ID',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'team_id',
        displayName: 'Team ID',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
      {
        name: 'is_org',
        displayName: 'Is Org Admin',
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
        validations: {},
      },
    ];

    const existingNames = new Set(profile.attributes.map(a => a.name));
    for (const attr of customAttributes) {
      if (!existingNames.has(attr.name)) {
        profile.attributes.push(attr);
        this.log(`Adding user profile attribute: ${attr.name}`, 'info');
      }
    }

    await this.kcApi('PUT', `${baseUrl}/admin/realms/${this.realm}/users/profile`, token, profile);
    this.log('User Profile configured', 'info');
  }

  async createBudgetManagementClient(baseUrl, token) {
    this.log('Creating budget-management client...', 'info');

    const payload = {
      clientId: 'budget-management',
      secret: 'budget-management-secret',
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: false,
      directAccessGrantsEnabled: true,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, 'budget-management');

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgMapper(baseUrl, token, id);
    }

    this.log('budget-management client created with org_id/team_id/is_org claim mappers', 'info');
    return id;
  }

  // ---------------------------------------------------------------------------
  // Config-driven realm setup
  // ---------------------------------------------------------------------------

  async setupRealms(baseUrl, token, realms) {
    this.log(`Setting up ${realms.length} realm(s) from config...`, 'info');
    for (const realm of realms) {
      // Fetch a fresh token per realm -- confirmed live: the token obtained once
      // before this loop can expire partway through a long multi-realm run.
      token = await this.getAdminToken(baseUrl);
      if (realm.teams) {
        await this.setupOrgRealm(baseUrl, token, realm);
      } else {
        await this.setupStandardRealm(baseUrl, token, realm);
      }
    }
  }

  /**
   * Run createFn, then verify success via verifyFn (a truthy result, e.g. an id,
   * means success). Retries up to `attempts` times with a short delay between --
   * confirmed live: creating a client/group immediately after realm creation can
   * silently no-op once (a transient consistency lag) and succeed on retry.
   *
   * verifyFn is expected to THROW (not just return falsy) when the check itself
   * couldn't be completed -- e.g. a network/connectivity failure -- as opposed to
   * returning falsy for a confirmed "doesn't exist yet". Both are retried the same
   * way here, but are logged distinctly, since a connectivity blip mid-run
   * (confirmed live) otherwise gets misreported as "confirmed absent" and can make
   * an already-existing resource look like it failed to create.
   *
   * refreshFn, if given, runs before each retry -- confirmed live: the admin token
   * fetched once at the start of configureKeycloak() can expire mid-run across a
   * long multi-realm setup, after which every call with the stale token fails
   * identically (curl exit 22) and retrying without a new token can't help.
   *
   * Returns verifyFn's result, or null if it never succeeds.
   */
  async createAndVerify(
    label,
    createFn,
    verifyFn,
    { attempts = 3, delayMs = 2000, refreshFn = null } = {}
  ) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      lastError = null;
      try {
        await createFn();
        const result = await verifyFn();
        if (result) return result;
      } catch (err) {
        lastError = err;
      }
      if (attempt < attempts) {
        const reason = lastError ? `error verifying (${lastError.message})` : 'not found';
        this.log(`${label}: ${reason} — attempt ${attempt}/${attempts}, retrying...`, 'warn');
        if (refreshFn) await refreshFn();
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    const reason = lastError ? `error verifying (${lastError.message})` : 'still not found';
    this.log(`${label}: ${reason} after ${attempts} attempts — giving up`, 'error');
    return null;
  }

  async setupStandardRealm(baseUrl, token, realm) {
    this.log(`Setting up standard realm '${realm.realm}'...`, 'info');
    let realmOk = true;
    // Reassigned by refreshToken below; createFn/verifyFn closures close over this
    // binding, so a mid-realm refresh is picked up by their next invocation.
    const refreshToken = async () => {
      token = await this.getAdminToken(baseUrl);
    };

    const realmReady = await this.createAndVerify(
      `Realm '${realm.realm}'`,
      () => this.createNamedRealm(baseUrl, token, realm.realm),
      () => this.realmExists(baseUrl, token, realm.realm),
      { refreshFn: refreshToken }
    );
    if (!realmReady) {
      this.log(
        `Realm '${realm.realm}' could not be created — skipping its clients/groups/users`,
        'error'
      );
      return;
    }

    if (realm.customAttributes?.length) {
      await this.configureUserProfileForRealm(baseUrl, token, realm.realm, realm.customAttributes);
    }

    for (const client of realm.clients || []) {
      // When flows is explicitly specified, derive capabilities from it.
      // When omitted, preserve legacy defaults so existing profiles are unaffected.
      const hasFlows = Array.isArray(client.flows);

      const clientAttributes = {
        'post.logout.redirect.uris': '*',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      };
      if (hasFlows && client.flows.includes('device')) {
        clientAttributes['oauth2.device.authorization.grant.enabled'] = 'true';
      }
      if (client.clientAttributes) {
        Object.assign(clientAttributes, client.clientAttributes);
      }

      if (client.postLogoutRedirectUris) {
        const postLogout = Array.isArray(client.postLogoutRedirectUris)
          ? client.postLogoutRedirectUris.join(' ')
          : client.postLogoutRedirectUris;
        clientAttributes['post.logout.redirect.uris'] = postLogout;
      }

      const payload = {
        clientId: client.clientId,
        enabled: true,
        publicClient: client.type === 'public',
        standardFlowEnabled: hasFlows ? client.flows.includes('authorization-code') : true,
        serviceAccountsEnabled: hasFlows ? client.flows.includes('service-account') : false,
        directAccessGrantsEnabled: hasFlows ? client.flows.includes('direct-access') : true,
        redirectUris: client.redirectUris || ['*'],
        webOrigins: ['*'],
        attributes: clientAttributes,
      };
      if (client.clientSecret) payload.secret = client.clientSecret;

      const id = await this.createAndVerify(
        `Client '${client.clientId}' in realm '${realm.realm}'`,
        () => this.registerClient(baseUrl, token, payload, realm.realm),
        async () => {
          const found = await this.lookupClientId(baseUrl, token, client.clientId, realm.realm);
          return found;
        },
        { refreshFn: refreshToken }
      );

      if (id) {
        if (realm.customAttributes?.length) {
          const existingMapperNames = await this.listProtocolMapperNames(
            baseUrl,
            token,
            id,
            realm.realm
          );
          for (const attrName of realm.customAttributes) {
            if (existingMapperNames.has(attrName)) continue;
            await this.addAttributeMapper(baseUrl, token, id, realm.realm, attrName);
          }
        }
        if (client.groupMembership) {
          await this.addGroupsClaimMapper(baseUrl, token, id, realm.realm);
        }
        if (client.audience) {
          await this.addNamedAudienceMapper(baseUrl, token, id, realm.realm, client.audience);
        }
      } else {
        realmOk = false;
      }
    }

    // Create groups and collect their IDs for user assignment
    const groupIds = {};
    for (const groupName of realm.groups || []) {
      const groupId = await this.createAndVerify(
        `Group '${groupName}' in realm '${realm.realm}'`,
        () =>
          this.kcApi('POST', `${baseUrl}/admin/realms/${realm.realm}/groups`, token, {
            name: groupName,
          }),
        async () => {
          const listResult = await this.kcApi(
            'GET',
            `${baseUrl}/admin/realms/${realm.realm}/groups`,
            token
          );
          if (listResult.exitCode !== 0) {
            throw new Error(
              `could not reach Keycloak to list groups (curl exit ${listResult.exitCode})`
            );
          }
          let allGroups = [];
          try {
            allGroups = JSON.parse(listResult.stdout || '[]');
          } catch {
            /* ignore */
          }
          return allGroups.find(g => g.name === groupName)?.id || null;
        },
        { refreshFn: refreshToken }
      );
      if (groupId) {
        groupIds[groupName] = groupId;
        this.log(`Created group '${groupName}' in realm '${realm.realm}'`, 'info');
      } else {
        realmOk = false;
      }
    }

    const isGrafanaRealm = realm.realm === 'grafana';
    const defaultPassword = isGrafanaRealm ? this.grafanaAdminPassword : realm.defaultPassword;
    for (const user of realm.users || []) {
      const username = isGrafanaRealm ? this.grafanaAdminUsername : user.username;
      const password = user.password || defaultPassword;
      if (!password) {
        throw new Error(
          `No password for user '${username}' in realm '${realm.realm}'. Set defaultPassword or per-user password.`
        );
      }
      const userId = await this.createAndVerify(
        `User '${username}' in realm '${realm.realm}'`,
        () =>
          this.createOrUpdateUserWithPassword(
            baseUrl,
            token,
            username,
            realm.realm,
            user.attributes || {},
            password,
            { firstName: user.firstName, lastName: user.lastName, email: user.email }
          ),
        () => this.lookupUserId(baseUrl, token, username, realm.realm),
        { refreshFn: refreshToken }
      );
      if (!userId) {
        realmOk = false;
        continue;
      }

      if (user.memberOf?.length) {
        for (const groupName of user.memberOf) {
          const groupId = groupIds[groupName];
          if (!groupId) {
            this.log(
              `Cannot add '${username}' to group '${groupName}' — group was not created`,
              'error'
            );
            realmOk = false;
            continue;
          }
          await this.kcApi(
            'PUT',
            `${baseUrl}/admin/realms/${realm.realm}/users/${userId}/groups/${groupId}`,
            token
          );
          this.log(`Added '${username}' to group '${groupName}'`, 'info');
        }
      }
    }

    // Assign service-account users to groups for client_credentials clients
    for (const client of realm.clients || []) {
      if (!client.serviceAccountGroup) continue;
      const groupId = groupIds[client.serviceAccountGroup];
      if (!groupId) {
        this.log(
          `serviceAccountGroup '${client.serviceAccountGroup}' not found for client '${client.clientId}' — skipping`,
          'warn'
        );
        realmOk = false;
        continue;
      }
      const saUsername = `service-account-${client.clientId}`;
      // No createFn -- the service-account user already exists as a side effect of the
      // client's serviceAccountsEnabled, created above. Only the lookup needs retrying.
      const saUserId = await this.createAndVerify(
        `Service account user '${saUsername}' in realm '${realm.realm}'`,
        () => {},
        () => this.lookupUserId(baseUrl, token, saUsername, realm.realm),
        { refreshFn: refreshToken }
      );
      if (saUserId) {
        await this.kcApi(
          'PUT',
          `${baseUrl}/admin/realms/${realm.realm}/users/${saUserId}/groups/${groupId}`,
          token
        );
        this.log(`Added '${saUsername}' to group '${client.serviceAccountGroup}'`, 'info');
      } else {
        this.log(
          `Service account user '${saUsername}' not found — skipping group assignment`,
          'warn'
        );
        realmOk = false;
      }
    }

    if (realmOk) {
      this.log(`Standard realm '${realm.realm}' configured`, 'info');
    } else {
      this.log(
        `Standard realm '${realm.realm}' configured with errors — one or more resources failed to create even after retries, see above`,
        'error'
      );
    }
  }

  async setupOrgRealm(baseUrl, token, realm) {
    this.log(`Setting up org realm '${realm.realm}' (orgId: ${realm.orgId})...`, 'info');
    let realmOk = true;
    const refreshToken = async () => {
      token = await this.getAdminToken(baseUrl);
    };

    const realmReady = await this.createAndVerify(
      `Realm '${realm.realm}'`,
      () => this.createNamedRealm(baseUrl, token, realm.realm),
      () => this.realmExists(baseUrl, token, realm.realm),
      { refreshFn: refreshToken }
    );
    if (!realmReady) {
      this.log(`Realm '${realm.realm}' could not be created — skipping its teams/users`, 'error');
      return;
    }

    const orgAttrs = ['org_id', 'team_id', 'is_org'];
    await this.configureUserProfileForRealm(baseUrl, token, realm.realm, orgAttrs);

    const defaultPassword = realm.defaultPassword;

    for (const team of realm.teams || []) {
      const payload = {
        clientId: team.clientId,
        secret: team.clientSecret,
        enabled: true,
        publicClient: false,
        standardFlowEnabled: true,
        serviceAccountsEnabled: true,
        directAccessGrantsEnabled: true,
        redirectUris: ['*'],
        webOrigins: ['*'],
        attributes: {
          'post.logout.redirect.uris': '*',
          'access.token.signed.response.alg': 'RS256',
          'id.token.signed.response.alg': 'RS256',
        },
      };

      const id = await this.createAndVerify(
        `Client '${team.clientId}' in realm '${realm.realm}'`,
        () => this.registerClient(baseUrl, token, payload, realm.realm),
        () => this.lookupClientId(baseUrl, token, team.clientId, realm.realm),
        { refreshFn: refreshToken }
      );

      if (id) {
        const existingMapperNames = await this.listProtocolMapperNames(
          baseUrl,
          token,
          id,
          realm.realm
        );
        for (const attrName of orgAttrs) {
          if (existingMapperNames.has(attrName)) continue;
          await this.addAttributeMapper(baseUrl, token, id, realm.realm, attrName);
        }
        await this.setServiceAccountAttributes(baseUrl, token, id, realm.realm, {
          org_id: realm.orgId,
          team_id: team.teamId,
        });
      } else {
        realmOk = false;
      }

      for (const user of team.users || []) {
        const password = user.password || defaultPassword;
        if (!password) {
          throw new Error(
            `No password for user '${user.username}' in realm '${realm.realm}'. Set defaultPassword or per-user password.`
          );
        }
        const userId = await this.createAndVerify(
          `User '${user.username}' in realm '${realm.realm}'`,
          () =>
            this.createOrUpdateUserWithPassword(
              baseUrl,
              token,
              user.username,
              realm.realm,
              user.attributes || {},
              password,
              { firstName: user.firstName, lastName: user.lastName, email: user.email }
            ),
          () => this.lookupUserId(baseUrl, token, user.username, realm.realm),
          { refreshFn: refreshToken }
        );
        if (!userId) realmOk = false;
      }
    }

    if (realmOk) {
      this.log(`Org realm '${realm.realm}' configured`, 'info');
    } else {
      this.log(
        `Org realm '${realm.realm}' configured with errors — one or more resources failed to create even after retries, see above`,
        'error'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Workload identity clients
  // ---------------------------------------------------------------------------

  async configureWorkloadClients(baseUrl, token) {
    this.log(`Configuring ${this.workloadClients.length} workload client(s)...`, 'info');
    let k8sIdpRegistered = false;

    for (const client of this.workloadClients) {
      const clientInternalId = await this.createWorkloadClient(baseUrl, token, client);

      if (clientInternalId) {
        await this.addAudienceMapper(
          baseUrl,
          token,
          clientInternalId,
          client.audience || 'ambient'
        );

        if (client.configureTokenExchange) {
          if (!k8sIdpRegistered) {
            await this.registerK8sIdentityProvider(
              baseUrl,
              token,
              client.k8sOidcIssuer || 'https://kubernetes.default.svc.cluster.local',
              client.k8sJwksUrl || 'https://kubernetes.default.svc.cluster.local/openid/v1/jwks'
            );
            k8sIdpRegistered = true;
          }
        }
      }

      if (client.k8sSecretName) {
        await this.createWorkloadClientSecret(client);
      }
    }
  }

  async createWorkloadClient(baseUrl, token, client) {
    const clientId = client.clientId;
    this.log(`Creating workload client '${clientId}'...`, 'info');

    const payload = {
      clientId,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: false,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: false,
      attributes: { 'access.token.signed.response.alg': 'RS256' },
    };
    if (client.clientSecret) payload.secret = client.clientSecret;

    const result = await CommandRunner.run(
      'curl',
      [
        '-sSik',
        ...(this.curlResolveArgs || []),
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
        `${baseUrl}/admin/realms/${this.realm}/clients`,
      ],
      { ignoreError: true }
    );

    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, clientId);

    if (id) {
      this.log(`Workload client '${clientId}' created (internal id: ${id})`, 'info');
    } else {
      this.log(`Workload client '${clientId}' may already exist`, 'warn');
    }
    return id;
  }

  async addAudienceMapper(baseUrl, token, clientInternalId, audience) {
    this.log(`Adding audience mapper (aud=${audience})...`, 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: `audience-${audience}`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.custom.audience': audience,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
        },
      }
    );
  }

  async addNamedAudienceMapper(baseUrl, token, clientInternalId, realmName, audience) {
    this.log(`Adding audience mapper (aud=${audience}) for realm '${realmName}'...`, 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${realmName}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: `audience-${audience}`,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.custom.audience': audience,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
        },
      }
    );
  }

  async registerK8sIdentityProvider(baseUrl, token, issuer, jwksUrl) {
    this.log(`Registering Kubernetes OIDC identity provider (issuer=${issuer})...`, 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/identity-provider/instances`,
      token,
      {
        providerId: 'oidc',
        alias: 'kubernetes',
        displayName: 'Kubernetes',
        enabled: true,
        trustEmail: false,
        storeToken: false,
        addReadTokenRoleOnCreate: false,
        config: {
          validateSignature: 'true',
          useJwksUrl: 'true',
          jwksUrl,
          issuer,
          tokenUrl: `${issuer}/openid/v1/token`,
          authorizationUrl: `${issuer}/openid/v1/auth`,
          disableUserInfoService: 'true',
          clientAuthMethod: 'client_secret_post',
          syncMode: 'IMPORT',
        },
      }
    );
  }

  async createWorkloadClientSecret(client) {
    const secretNamespace = client.k8sSecretNamespace || FeatureManager.getDefaultNamespace();
    this.log(
      `Creating K8s Secret '${client.k8sSecretName}' in namespace '${secretNamespace}'...`,
      'info'
    );

    await KubernetesHelper.ensureNamespace(secretNamespace, this.spinner, this.kubeContext);

    await this.applyResource(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: {
          name: client.k8sSecretName,
          namespace: secretNamespace,
          labels: { 'app.kubernetes.io/managed-by': 'mesh-demo' },
        },
        type: 'Opaque',
        stringData: { client_secret: client.clientSecret },
      },
      this.kubeContext
    );
  }

  // ---------------------------------------------------------------------------
  // Solo UI Clients and Groups
  // ---------------------------------------------------------------------------

  async createSoloUIRealm(baseUrl, token) {
    if (await this.realmExists(baseUrl, token, this.soloUIRealm)) {
      this.log(`Realm '${this.soloUIRealm}' already exists, skipping creation`, 'info');
      await this.ensureRealmLoginTheme(baseUrl, token, this.soloUIRealm);
      return;
    }
    this.log(`Creating Solo UI realm '${this.soloUIRealm}'...`, 'info');
    await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
      realm: this.soloUIRealm,
      enabled: true,
      displayName: 'Solo Enterprise UI',
      loginTheme: 'keycloak-soloio-login-theme',
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      resetPasswordAllowed: true,
      editUsernameAllowed: false,
      bruteForceProtected: false,
    });
  }

  async createSoloUIClients(baseUrl, token) {
    // This runs last, after every config-driven realm -- confirmed live: the token
    // obtained at the start of configureKeycloak() can be stale by now on a long run.
    token = await this.getAdminToken(baseUrl);
    const refreshToken = async () => {
      token = await this.getAdminToken(baseUrl);
    };
    const {
      hostname,
      backendClientId,
      backendClientSecret,
      frontendClientId,
      additionalHostnames = [],
    } = this.soloUIClients;
    const realm = this.soloUIRealm;
    const allHostnames = [hostname, ...additionalHostnames];
    const redirectUris = allHostnames.map(h => `${h}/callback`);
    const postLogoutUris = allHostnames.map(h => `${h}/logout`).join(' ');

    const realmReady = await this.createAndVerify(
      `Solo UI realm '${realm}'`,
      () => this.createSoloUIRealm(baseUrl, token),
      () => this.realmExists(baseUrl, token, realm),
      { refreshFn: refreshToken }
    );
    if (!realmReady) {
      this.log(
        `Solo UI realm '${realm}' could not be created — aborting Solo UI client setup`,
        'error'
      );
      return;
    }

    this.log(`Creating Solo UI backend client '${backendClientId}'...`, 'info');

    const backendPayload = {
      clientId: backendClientId,
      secret: backendClientSecret,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris,
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': postLogoutUris,
        'pkce.code.challenge.method': '',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const backendResult = await this.registerClient(baseUrl, token, backendPayload, realm);
    let backendId = this.extractIdFromLocation(backendResult.stdout);
    if (!backendId) backendId = await this.lookupClientId(baseUrl, token, backendClientId, realm);

    if (backendId) {
      await this.addGroupsClaimMapper(baseUrl, token, backendId, realm);
    }

    this.log(`Creating Solo UI frontend client '${frontendClientId}'...`, 'info');

    const frontendPayload = {
      clientId: frontendClientId,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      serviceAccountsEnabled: false,
      directAccessGrantsEnabled: false,
      redirectUris,
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': postLogoutUris,
        'pkce.code.challenge.method': 'S256',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const frontendResult = await this.registerClient(baseUrl, token, frontendPayload, realm);
    let frontendId = this.extractIdFromLocation(frontendResult.stdout);
    if (!frontendId)
      frontendId = await this.lookupClientId(baseUrl, token, frontendClientId, realm);

    if (frontendId) {
      await this.addGroupsClaimMapper(baseUrl, token, frontendId, realm);
    }

    const groupIds = await this.createSoloUIGroups(baseUrl, token);
    await this.createSoloUIUsers(baseUrl, token, groupIds);

    this.log('Solo UI clients, groups, and users created', 'success');
  }

  async createSoloUIGroups(baseUrl, token) {
    const realm = this.soloUIRealm;
    const groupNames = ['admins', 'readers', 'writers'];
    const groupsUrl = `${baseUrl}/admin/realms/${realm}/groups`;

    const groupIds = {};
    for (const group of groupNames) {
      this.log(`Creating Keycloak group '${group}'...`, 'info');
      await this.kcApi('POST', groupsUrl, token, { name: group });

      const listResult = await this.kcApi('GET', groupsUrl, token);
      let allGroups = [];
      try {
        allGroups = JSON.parse(listResult.stdout);
      } catch {
        /* ignore parse error */
      }
      const created = allGroups.find(g => g.name === group);
      if (created) groupIds[group] = created.id;
    }

    return groupIds;
  }

  async createSoloUIUsers(baseUrl, token, groupIds) {
    const realm = this.soloUIRealm;
    const password = this.soloUiDefaultPassword;
    const users = [
      {
        username: 'solo-admin',
        email: 'solo-admin@solo.io',
        firstName: 'Solo',
        lastName: 'Admin',
        group: 'admins',
      },
      {
        username: 'solo-reader',
        email: 'solo-reader@solo.io',
        firstName: 'Solo',
        lastName: 'Reader',
        group: 'readers',
      },
      {
        username: 'solo-writer',
        email: 'solo-writer@solo.io',
        firstName: 'Solo',
        lastName: 'Writer',
        group: 'writers',
      },
    ];

    for (const user of users) {
      this.log(`Creating Solo UI user '${user.username}'...`, 'info');
      await this.createOrUpdateUserWithPassword(
        baseUrl,
        token,
        user.username,
        realm,
        {},
        password,
        { firstName: user.firstName, lastName: user.lastName, email: user.email }
      );

      const userId = await this.lookupUserId(baseUrl, token, user.username, realm);
      const groupId = groupIds[user.group];
      if (userId && groupId) {
        await this.kcApi(
          'PUT',
          `${baseUrl}/admin/realms/${realm}/users/${userId}/groups/${groupId}`,
          token
        );
        this.log(`Added '${user.username}' to '${user.group}' group`, 'info');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Keycloak Admin REST API helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a realm already exists. Uses a plain status-code check rather than kcApi()
   * so the expected "not found" case on a fresh install doesn't spend a failed request.
   */
  async realmExists(baseUrl, token, realmName) {
    const result = await CommandRunner.run(
      'curl',
      [
        '-sSk',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realmName}`,
      ],
      { ignoreError: true }
    );
    // A connection-level failure (DNS, timeout, reset) leaves curl's own exit code
    // non-zero -- confirmed live: curl still writes the placeholder "000" via -w in
    // that case, which is otherwise indistinguishable from a genuine non-200 and
    // gets misreported as "realm doesn't exist" when the check itself just failed.
    if (result.exitCode !== 0) {
      throw new Error(
        `could not reach Keycloak to check realm '${realmName}' (curl exit ${result.exitCode})`
      );
    }
    return result.stdout?.trim() === '200';
  }

  /**
   * Set the realm's login theme. Keycloak's realm PUT only applies fields present in
   * the body, so this is safe to call on realms that already existed before this addon
   * ran - without it, a realm created before the loginTheme default was added would
   * never pick it up.
   */
  async ensureRealmLoginTheme(baseUrl, token, realmName) {
    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}`, token, {
      loginTheme: 'keycloak-soloio-login-theme',
    });
  }

  /**
   * Names of protocol mappers already configured on a client, so callers can skip
   * re-creating ones that already exist instead of hitting a 409 on rerun.
   */
  async listProtocolMapperNames(baseUrl, token, clientInternalId, realm) {
    const result = await this.kcApi(
      'GET',
      `${baseUrl}/admin/realms/${realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token
    );
    try {
      return new Set(JSON.parse(result.stdout || '[]').map(m => m.name));
    } catch {
      return new Set();
    }
  }

  async kcApi(method, url, token, body) {
    const args = [
      '-sSfk',
      ...(this.curlResolveArgs || []),
      '-X',
      method,
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/json',
    ];
    if (body) args.push('-d', JSON.stringify(body));
    args.push(url);
    return CommandRunner.run('curl', args, { ignoreError: true });
  }

  async getAdminToken(baseUrl) {
    this.log('Obtaining admin token...', 'info');
    this.log(`getAdminToken: baseUrl=${baseUrl}`, 'debug');

    for (let i = 0; i < 30; i++) {
      try {
        const curlArgs = [
          '-sSfk',
          ...(this.curlResolveArgs || []),
          '-X',
          'POST',
          `${baseUrl}/realms/master/protocol/openid-connect/token`,
          '-H',
          'Content-Type: application/x-www-form-urlencoded',
          '-d',
          `username=${encodeURIComponent(this.adminUsername)}&password=${encodeURIComponent(this.adminPassword)}&grant_type=password&client_id=admin-cli`,
        ];
        this.log(`getAdminToken attempt ${i + 1}`, 'debug');

        const result = await CommandRunner.run('curl', curlArgs, { ignoreError: true });
        this.log(`getAdminToken stdout=${result.stdout?.substring(0, 200)}`, 'debug');

        if (result.stdout) {
          const parsed = JSON.parse(result.stdout);
          if (parsed.access_token) return parsed.access_token;
        }
      } catch (err) {
        this.log(`getAdminToken error: ${err.message}`, 'debug');
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    throw new Error('Failed to obtain Keycloak admin token');
  }

  async createRealm(baseUrl, token) {
    if (await this.realmExists(baseUrl, token, this.realm)) {
      this.log(`Realm '${this.realm}' already exists, skipping creation`, 'info');
      await this.ensureRealmLoginTheme(baseUrl, token, this.realm);
      return;
    }
    this.log(`Creating realm '${this.realm}'...`, 'info');
    await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
      realm: this.realm,
      enabled: true,
      displayName: this.realm,
      loginTheme: 'keycloak-soloio-login-theme',
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      resetPasswordAllowed: true,
      editUsernameAllowed: false,
      bruteForceProtected: false,
      accessCodeLifespan: 300,
      accessCodeLifespanUserAction: 600,
      accessCodeLifespanLogin: 1800,
    });
  }

  async createNamedRealm(baseUrl, token, realmName) {
    if (await this.realmExists(baseUrl, token, realmName)) {
      this.log(`Realm '${realmName}' already exists, skipping creation`, 'info');
      await this.ensureRealmLoginTheme(baseUrl, token, realmName);
      return;
    }
    this.log(`Creating realm '${realmName}'...`, 'info');
    await this.kcApi('POST', `${baseUrl}/admin/realms`, token, {
      realm: realmName,
      enabled: true,
      displayName: realmName,
      loginTheme: 'keycloak-soloio-login-theme',
      loginWithEmailAllowed: true,
      duplicateEmailsAllowed: false,
      resetPasswordAllowed: true,
      editUsernameAllowed: false,
      bruteForceProtected: false,
      accessCodeLifespan: 300,
      accessCodeLifespanUserAction: 600,
      accessCodeLifespanLogin: 1800,
    });
  }

  async createConfidentialClient(baseUrl, token) {
    this.log(`Creating confidential client '${this.clientId}'...`, 'info');

    const payload = {
      clientId: this.clientId,
      secret: this.clientSecret,
      enabled: true,
      publicClient: false,
      standardFlowEnabled: true,
      serviceAccountsEnabled: true,
      directAccessGrantsEnabled: true,
      authorizationServicesEnabled: true,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, this.clientId);

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgMapper(baseUrl, token, id);
    }

    process.env.KEYCLOAK_CLIENT_ID = this.clientId;
    process.env.KEYCLOAK_SECRET = this.clientSecret;
    this.log('Client credentials exported to KEYCLOAK_CLIENT_ID / KEYCLOAK_SECRET', 'info');

    return id;
  }

  async createPublicClient(baseUrl, token) {
    this.log(`Creating public client '${this.publicClientId}'...`, 'info');

    const payload = {
      clientId: this.publicClientId,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: false,
      redirectUris: ['*'],
      webOrigins: ['*'],
      attributes: {
        'post.logout.redirect.uris': '*',
        'pkce.code.challenge.method': 'S256',
        'access.token.signed.response.alg': 'RS256',
        'id.token.signed.response.alg': 'RS256',
      },
    };

    const result = await this.registerClient(baseUrl, token, payload);
    let id = this.extractIdFromLocation(result.stdout);
    if (!id) id = await this.lookupClientId(baseUrl, token, this.publicClientId);

    if (id) {
      await this.addGroupMapper(baseUrl, token, id);
      await this.addOrgIdMapper(baseUrl, token, id);
      await this.addTeamIdMapper(baseUrl, token, id);
      await this.addIsOrgMapper(baseUrl, token, id);
    }

    return id;
  }

  async registerClient(baseUrl, token, payload, realm = this.realm) {
    return CommandRunner.run(
      'curl',
      [
        '-sSik',
        ...(this.curlResolveArgs || []),
        '-X',
        'POST',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'Content-Type: application/json',
        '-d',
        JSON.stringify(payload),
        `${baseUrl}/admin/realms/${realm}/clients`,
      ],
      { ignoreError: true }
    );
  }

  async addGroupMapper(baseUrl, token, clientInternalId) {
    this.log('Adding group attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'group',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'group',
          'jsonType.label': 'String',
          'user.attribute': 'group',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addOrgIdMapper(baseUrl, token, clientInternalId) {
    this.log('Adding org_id attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'org_id',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'org_id',
          'jsonType.label': 'String',
          'user.attribute': 'org_id',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addTeamIdMapper(baseUrl, token, clientInternalId) {
    this.log('Adding team_id attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'team_id',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'team_id',
          'jsonType.label': 'String',
          'user.attribute': 'team_id',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addIsOrgMapper(baseUrl, token, clientInternalId) {
    this.log('Adding is_org attribute mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${this.realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'is_org',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': 'is_org',
          'jsonType.label': 'boolean',
          'user.attribute': 'is_org',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addAttributeMapper(baseUrl, token, clientInternalId, realmName, attrName) {
    this.log(`Adding ${attrName} attribute mapper to realm '${realmName}'...`, 'info');
    const jsonType = attrName === 'is_org' ? 'boolean' : 'String';
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${realmName}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: attrName,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'claim.name': attrName,
          'jsonType.label': jsonType,
          'user.attribute': attrName,
          'id.token.claim': 'true',
          'access.token.claim': 'true',
        },
      }
    );
  }

  async addGroupsClaimMapper(baseUrl, token, clientInternalId, realm = this.realm) {
    this.log('Adding Groups membership claim mapper...', 'info');
    await this.kcApi(
      'POST',
      `${baseUrl}/admin/realms/${realm}/clients/${clientInternalId}/protocol-mappers/models`,
      token,
      {
        name: 'Groups',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-group-membership-mapper',
        config: {
          'claim.name': 'Groups',
          'full.path': 'false',
          'id.token.claim': 'true',
          'access.token.claim': 'true',
          'userinfo.token.claim': 'true',
        },
      }
    );
  }

  async setServiceAccountAttributes(baseUrl, token, clientInternalId, realmName, attrs) {
    const result = await this.kcApi(
      'GET',
      `${baseUrl}/admin/realms/${realmName}/clients/${clientInternalId}/service-account-user`,
      token
    );
    let svcUser;
    try {
      svcUser = JSON.parse(result.stdout);
    } catch {
      return;
    }
    if (!svcUser?.id) return;

    const kAttrs = {};
    for (const [k, v] of Object.entries(attrs)) {
      kAttrs[k] = Array.isArray(v) ? v : [String(v)];
    }
    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/${svcUser.id}`, token, {
      attributes: kAttrs,
    });
  }

  async configureUserProfileForRealm(baseUrl, token, realmName, attrNames) {
    this.log(`Configuring user profile attributes for realm '${realmName}'...`, 'info');
    const getResult = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realmName}/users/profile`,
      ],
      { ignoreError: true }
    );

    let profile;
    try {
      profile = JSON.parse(getResult.stdout);
    } catch {
      profile = { attributes: [] };
    }

    const existingNames = new Set((profile.attributes || []).map(a => a.name));
    for (const name of attrNames) {
      if (!existingNames.has(name)) {
        profile.attributes.push({
          name,
          displayName: name,
          permissions: { view: ['admin', 'user'], edit: ['admin'] },
          validations: {},
        });
      }
    }

    await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/profile`, token, profile);
  }

  extractIdFromLocation(stdout) {
    if (!stdout) return null;
    const match = stdout.match(/[Ll]ocation:\s*.*\/clients\/([^\s\r\n]+)/);
    return match ? match[1] : null;
  }

  async lookupClientId(baseUrl, token, clientId, realm = this.realm) {
    const result = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realm}/clients?clientId=${clientId}`,
      ],
      { ignoreError: true }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `could not reach Keycloak to look up client '${clientId}' (curl exit ${result.exitCode})`
      );
    }
    if (!result.stdout) return null;
    try {
      return JSON.parse(result.stdout)[0]?.id || null;
    } catch {
      return null;
    }
  }

  async createUsers(baseUrl, token) {
    this.log('Creating/updating users...', 'info');
    const users = [
      {
        username: 'org-admin',
        email: 'orgadmin@solo.io',
        firstName: 'Org',
        lastName: 'Admin',
        attributes: {
          group: ['admins'],
          is_org: ['true'],
          org_id: ['acme-corp'],
        },
      },
      {
        username: 'user1',
        email: 'user1@solo.io',
        firstName: 'Joe',
        lastName: 'Blogg',
        attributes: {
          group: ['users'],
          is_org: ['false'],
          org_id: ['acme-corp'],
          team_id: ['team-alpha'],
        },
      },
      {
        username: 'user2',
        email: 'user2@solo.io',
        firstName: 'Bob',
        lastName: 'Doe',
        attributes: {
          group: ['users'],
          is_org: ['false'],
          org_id: ['acme-corp'],
          team_id: ['team-alpha'],
        },
      },
      {
        username: 'team-user',
        email: 'teamuser@solo.io',
        firstName: 'Team',
        lastName: 'User',
        attributes: {
          group: ['users'],
          is_org: ['false'],
          org_id: ['acme-corp'],
          team_id: ['team-beta'],
        },
      },
    ];
    for (const u of users) {
      await this.createOrUpdateUser(baseUrl, token, u);
    }
  }

  async createOrUpdateUser(baseUrl, token, user, realm = this.realm) {
    const existingId = await this.lookupUserId(baseUrl, token, user.username, realm);

    if (existingId) {
      this.log(`Updating user '${user.username}' attributes...`, 'info');
      await this.kcApi('PUT', `${baseUrl}/admin/realms/${realm}/users/${existingId}`, token, {
        ...user,
        enabled: true,
        emailVerified: true,
      });
    } else {
      this.log(`Creating user '${user.username}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms/${realm}/users`, token, {
        ...user,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: 'Passwd00', temporary: false }],
      });
    }
  }

  async createOrUpdateUserWithPassword(
    baseUrl,
    token,
    username,
    realmName,
    attrs,
    password,
    profile = {}
  ) {
    const kAttrs = {};
    for (const [k, v] of Object.entries(attrs || {})) {
      kAttrs[k] = Array.isArray(v) ? v : [v];
    }

    const existingId = await this.lookupUserId(baseUrl, token, username, realmName);
    if (existingId) {
      this.log(`Updating user '${username}' in realm '${realmName}'...`, 'info');
      await this.kcApi('PUT', `${baseUrl}/admin/realms/${realmName}/users/${existingId}`, token, {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        enabled: true,
        emailVerified: true,
        attributes: kAttrs,
      });
      await this.kcApi(
        'PUT',
        `${baseUrl}/admin/realms/${realmName}/users/${existingId}/reset-password`,
        token,
        { type: 'password', value: password, temporary: false }
      );
    } else {
      this.log(`Creating user '${username}' in realm '${realmName}'...`, 'info');
      await this.kcApi('POST', `${baseUrl}/admin/realms/${realmName}/users`, token, {
        username,
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }],
        attributes: kAttrs,
      });
    }
  }

  async lookupUserId(baseUrl, token, username, realm = this.realm) {
    const result = await CommandRunner.run(
      'curl',
      [
        '-sSfk',
        ...(this.curlResolveArgs || []),
        '-H',
        `Authorization: Bearer ${token}`,
        `${baseUrl}/admin/realms/${realm}/users?username=${encodeURIComponent(username)}&exact=true`,
      ],
      { ignoreError: true }
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `could not reach Keycloak to look up user '${username}' (curl exit ${result.exitCode})`
      );
    }
    if (!result.stdout) return null;
    try {
      return JSON.parse(result.stdout)[0]?.id || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  async cleanup() {
    this.log('Cleaning up Keycloak...', 'info');
    const ns = this.keycloakNamespace;

    if (this.workloadClients.length > 0) {
      await this.cleanupWorkloadClients();
    }

    await this.deleteResource('deployment', 'keycloak', ns);
    await this.deleteResource('service', 'keycloak', ns);
    await this.deleteResource('secret', 'keycloak-secrets', ns);

    await this.deleteResource('deployment', 'postgres', ns);
    await this.deleteResource('service', 'postgres', ns);
    await this.deleteResource('secret', 'postgres-credentials', ns);
    await this.deleteResource('persistentvolumeclaim', 'postgres-pvc', ns);
    await this.deleteResource('serviceaccount', 'postgres', ns);

    if (this.tlsEnabled && this.createCertificate) {
      await this.deleteResource('certificate', this.tlsSecretName, ns);
      await this.deleteResource('secret', this.tlsSecretName, ns);
    }

    await KubernetesHelper.kubectl([
      ...(this.kubeContext ? [`--context=${this.kubeContext}`] : []),
      'delete',
      'namespace',
      ns,
      '--ignore-not-found=true',
    ]);

    this.log('Keycloak cleaned up', 'success');
  }

  async cleanupWorkloadClients() {
    const baseUrl = `${this.protocol}://${this.hostname}`;
    let token;
    try {
      token = await this.getAdminToken(baseUrl);
    } catch (error) {
      this.log(
        `Could not obtain admin token for workload client cleanup: ${error.message}`,
        'warn'
      );
      return;
    }

    let k8sIdpRemoved = false;
    for (const client of this.workloadClients) {
      try {
        const id = await this.lookupClientId(baseUrl, token, client.clientId);
        if (id) {
          await this.kcApi('DELETE', `${baseUrl}/admin/realms/${this.realm}/clients/${id}`, token);
          this.log(`Workload client '${client.clientId}' deleted`, 'info');
        }
      } catch (error) {
        this.log(`Failed to delete workload client '${client.clientId}': ${error.message}`, 'warn');
      }

      if (client.configureTokenExchange && !k8sIdpRemoved) {
        try {
          await this.kcApi(
            'DELETE',
            `${baseUrl}/admin/realms/${this.realm}/identity-provider/instances/kubernetes`,
            token
          );
          this.log('Kubernetes IdP removed', 'info');
          k8sIdpRemoved = true;
        } catch (error) {
          this.log(`Failed to remove Kubernetes IdP: ${error.message}`, 'warn');
        }
      }

      if (client.k8sSecretName) {
        const secretNamespace = client.k8sSecretNamespace || FeatureManager.getDefaultNamespace();
        await this.deleteResource('secret', client.k8sSecretName, secretNamespace);
      }
    }
  }
}
