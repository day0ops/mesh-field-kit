// addons/keycloak/runbook.js
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v)) ? v : fb

export function envVarsFor(_addonCfg, _clusterName) {
  return [];
}

const DEFAULT_KEYCLOAK_VERSION = '26.5.3';
const DEFAULT_POSTGRES_VERSION = '18.2-alpine';

const DEFAULT_KEYCLOAK_ADMIN_PASSWORD = 'admin';

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const hostname = tpl(cfg.hostname, env.spec.domains?.keycloak) || 'keycloak.example.com';
  const keycloakVersion = addonCfg.version || addonCfg.keycloakVersion || cfg.version || cfg.keycloakVersion || DEFAULT_KEYCLOAK_VERSION;
  const postgresVersion = addonCfg.postgresVersion || cfg.postgresVersion || DEFAULT_POSTGRES_VERSION;
  const exports = [
    { name: 'KEYCLOAK_HOSTNAME', value: hostname, comment: 'Keycloak public hostname' },
    { name: 'KEYCLOAK_NAMESPACE', value: addonCfg.namespace || 'keycloak', comment: 'Keycloak namespace' },
    { name: 'KEYCLOAK_VERSION', value: keycloakVersion, comment: 'Keycloak container image tag' },
    { name: 'POSTGRES_VERSION', value: postgresVersion, comment: 'PostgreSQL container image tag' },
    {
      name: 'KEYCLOAK_ADMIN_PASSWORD',
      value: cfg.adminPassword || DEFAULT_KEYCLOAK_ADMIN_PASSWORD,
      comment: 'Keycloak master realm admin password (username: admin)',
    },
  ];

  const soloUIClients = cfg.soloUIClients;
  if (soloUIClients?.enabled) {
    exports.push(
      {
        name: 'SOLO_UI_ADMIN_USER',
        value: 'solo-admin',
        comment: 'Solo UI demo admin username (Keycloak solo-ui realm)',
      },
      {
        name: 'SOLO_UI_ADMIN_PASSWORD',
        value: soloUIClients.defaultPassword || 'Passwd00',
        comment: 'Solo UI demo admin password (solo-reader/solo-writer use the same password)',
      },
    );
  }

  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, profile, env) {
  const [postgresYamlRaw, keycloakYamlRaw] = await Promise.all([
    fs.promises.readFile(join(__dir, 'config/postgres.yaml'), 'utf8'),
    fs.promises.readFile(join(__dir, 'config/keycloak.yaml'), 'utf8'),
  ]);

  const ns = addonCfg.namespace || 'keycloak';
  const cfg = addonCfg.config || {};
  const hostname = tpl(cfg.hostname, env.spec.domains?.keycloak) || 'keycloak.example.com';
  const protocol = tpl(cfg.protocol, null) || 'https';

  const tlsEnabled = cfg.tls?.enabled !== false;
  const createCertificate = cfg.tls?.createCertificate !== false;
  const issuerName = tpl(cfg.tls?.clusterIssuerName, null) || 'selfsigned-issuer';
  const tlsSecretName = tpl(cfg.tls?.secretName, null) || 'keycloak-tls';
  const certOrg = tpl(cfg.tls?.organization, null) || 'solo.io';
  const keycloakVersion = addonCfg.version || addonCfg.keycloakVersion || cfg.version || cfg.keycloakVersion || DEFAULT_KEYCLOAK_VERSION;
  const postgresVersion = addonCfg.postgresVersion || cfg.postgresVersion || DEFAULT_POSTGRES_VERSION;
  const adminPassword = cfg.adminPassword || DEFAULT_KEYCLOAK_ADMIN_PASSWORD;

  // Substitute template vars in embedded YAML files
  const fillYaml = (s) => s
    .replaceAll("'{{NAMESPACE}}'", ns)
    .replaceAll('"{{NAMESPACE}}"', ns)
    .replaceAll('{{NAMESPACE}}', ns)
    .replaceAll("'{{HOSTNAME}}'", hostname)
    .replaceAll('"{{HOSTNAME}}"', hostname)
    .replaceAll('{{HOSTNAME}}', hostname)
    .replaceAll("'{{TLS_SECRET_NAME}}'", tlsSecretName)
    .replaceAll('"{{TLS_SECRET_NAME}}"', tlsSecretName)
    .replaceAll('{{TLS_SECRET_NAME}}', tlsSecretName)
    .replaceAll("'{{POSTGRES_VERSION}}'", postgresVersion)
    .replaceAll('"{{POSTGRES_VERSION}}"', postgresVersion)
    .replaceAll('{{POSTGRES_VERSION}}', postgresVersion)
    .replaceAll("'{{KEYCLOAK_VERSION}}'", keycloakVersion)
    .replaceAll('"{{KEYCLOAK_VERSION}}"', keycloakVersion)
    .replaceAll('{{KEYCLOAK_VERSION}}', keycloakVersion)
    .replaceAll("'{{ADMIN_PASSWORD}}'", adminPassword)
    .replaceAll('"{{ADMIN_PASSWORD}}"', adminPassword)
    .replaceAll('{{ADMIN_PASSWORD}}', adminPassword)

  const postgresYaml = fillYaml(postgresYamlRaw)
  const keycloakYaml = fillYaml(keycloakYamlRaw)

  // Collect all addon names defined anywhere in the profile (global + per-cluster)
  const allProfileAddonNames = new Set();
  for (const g of (profile?.spec?.addons?.global || [])) {
    allProfileAddonNames.add(typeof g === 'string' ? g : g.name);
  }
  for (const clusterDef of (profile?.spec?.addons?.clusters || [])) {
    for (const a of (clusterDef.addons || [])) {
      allProfileAddonNames.add(typeof a === 'string' ? a : a.name);
    }
  }

  // Collect addon names installed on this specific cluster
  const thisClusterDef = (profile?.spec?.addons?.clusters || []).find(c => c.name === clusterName);
  const thisClusterAddonNames = new Set(
    (thisClusterDef?.addons || []).map(a => typeof a === 'string' ? a : a.name)
  );

  // Filter realms: if realm name matches a known addon, only include if that addon is on this cluster
  const realms = (cfg.realms || []).filter(r =>
    !allProfileAddonNames.has(r.realm) || thisClusterAddonNames.has(r.realm)
  );
  const soloUIClients = cfg.soloUIClients || null;

  let tlsSection = '';
  if (tlsEnabled && createCertificate) {
    tlsSection = `

Create TLS certificate for Keycloak (cert-manager):

\`\`\`bash
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ${tlsSecretName}
  namespace: ${ns}
spec:
  secretName: ${tlsSecretName}
  issuerRef:
    name: ${issuerName}
    kind: ClusterIssuer
  commonName: ${hostname}
  dnsNames:
    - ${hostname}
  subject:
    organizations:
      - ${certOrg}
    organizationalUnits:
      - keycloak
EOF
\`\`\`

Wait for the certificate to be issued:

\`\`\`bash
kubectl wait certificate/${tlsSecretName} -n ${ns} \\
  --for=condition=Ready --timeout=120s
\`\`\`
`;
  }

  const baseUrl = `${protocol}://${hostname}`;

  // Helper — builds the "Configure realm `<name>`" snippet
  const makeRealmSnippet = (realm) => {
    const clients = realm.clients || [];
    const users = realm.users || [];
    const groups = realm.groups || [];

    const groupLines = groups.map(g => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/groups" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"name":"${g}"}'`).join('\n\n');

    const clientLines = clients.map(c => {
      const isPublic = c.type === 'public';
      return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/clients" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"clientId":"${c.clientId}","publicClient":${isPublic},"enabled":true}'`;
    }).join('\n\n');

    const userLines = users.map(u => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"username":"${u.username}","email":"${u.email || ''}","enabled":true,"credentials":[{"type":"password","value":"${realm.defaultPassword || 'Admin1234'}","temporary":false}]}'`).join('\n\n');

    return `
**Configure realm \`${realm.realm}\`** (${clients.length} clients, ${users.length} users):

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=admin&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

# Create realm
curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${realm.realm}","enabled":true,"defaultLocale":"en"}'
${groups.length > 0 ? `
# Create groups
${groupLines}` : ''}${clients.length > 0 ? `
# Create clients
${clientLines}` : ''}${users.length > 0 ? `
# Create users
${userLines}` : ''}
\`\`\`
`;
  };

  const realmSnippets = realms.map(makeRealmSnippet).join('\n');

  let soloUISection = '';
  if (soloUIClients?.enabled) {
    const suiRealm = soloUIClients.realm || 'solo-ui';
    const suiHostname = tpl(soloUIClients.hostname, env.spec.domains?.soloUI) || '';
    const suiPassword = soloUIClients.defaultPassword || 'Passwd00';
    const suiUsers = ['solo-admin', 'solo-reader', 'solo-writer'];
    const suiUserLines = suiUsers.map(u => `curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/users" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"${u}","enabled":true,"credentials":[{"type":"password","value":"${suiPassword}","temporary":false}]}'`).join('\n\n');
    soloUISection = `

**Configure Solo UI realm \`${suiRealm}\`**:

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=admin&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${suiRealm}","enabled":true}'

# Backend client (confidential)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUIClients.backendClientId || 'solo-ui-backend'}","secret":"${soloUIClients.backendClientSecret || 'solo-ui-backend-secret'}","publicClient":false,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Frontend client (public, PKCE)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUIClients.frontendClientId || 'solo-ui-frontend'}","publicClient":true,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Demo users (password: ${suiPassword})
${suiUserLines}
\`\`\`
`;
  }

  return `Install Keycloak on the **${clusterName}** cluster as OIDC provider. Deployed via raw Kubernetes manifests (PostgreSQL 18.2-alpine + Keycloak 26.5.3) — no Helm chart.

\`\`\`bash
kubectl create namespace ${ns} --dry-run=client -o yaml | kubectl apply -f -
\`\`\`
${tlsSection}
Apply PostgreSQL (ServiceAccount, Secret, PVC, Service, Deployment):

\`\`\`bash
kubectl apply -n ${ns} -f - <<'EOF'
${postgresYaml.trimEnd()}
EOF
\`\`\`

Wait for PostgreSQL to be ready:

\`\`\`bash
kubectl wait --for=condition=Ready pod -l app=postgres -n ${ns} --timeout=300s
\`\`\`

Initialize the Keycloak database:

\`\`\`bash
kubectl exec -n ${ns} deploy/postgres -- psql -U postgres -d postgres -c "CREATE DATABASE keycloak;"
kubectl exec -n ${ns} deploy/postgres -- psql -U postgres -d postgres -c "CREATE USER keycloak WITH PASSWORD 'password';"
kubectl exec -n ${ns} deploy/postgres -- psql -U postgres -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;"
\`\`\`

Apply Keycloak (Deployment + Service):

\`\`\`bash
kubectl apply -n ${ns} -f - <<'EOF'
${keycloakYaml.trimEnd()}
EOF
\`\`\`

Wait for Keycloak to be ready:

\`\`\`bash
kubectl wait --for=condition=Ready pod -l app=keycloak -n ${ns} --timeout=600s
\`\`\`

Verify Keycloak is reachable:

\`\`\`bash
curl -sk ${baseUrl}/realms/master | jq '.realm'
# Expected: "master"
\`\`\`
${realmSnippets}${soloUISection}`;
}

export async function cleanup(addonCfg, _clusterName) {
  const [postgresYaml, keycloakYaml] = await Promise.all([
    fs.promises.readFile(join(__dir, 'config/postgres.yaml'), 'utf8'),
    fs.promises.readFile(join(__dir, 'config/keycloak.yaml'), 'utf8'),
  ]);
  const ns = addonCfg.namespace || 'keycloak';
  return `\`\`\`bash
kubectl delete -n ${ns} -f - <<'EOF'
${keycloakYaml.trimEnd()}
EOF
kubectl delete -n ${ns} -f - <<'EOF'
${postgresYaml.trimEnd()}
EOF
kubectl delete namespace ${ns}
\`\`\``;
}
