// addons/keycloak/runbook.js
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// tpl: return v if it's a real value (not an unresolved {{...}} template), otherwise fb
const tpl = (v, fb) => (v && !/\{\{/.test(v) ? v : fb);

// shellVar: turn a config value (realm/user/role name) into a BASH-safe variable name fragment
const shellVar = v =>
  String(v)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');

export function envVarsFor(addonCfg, _clusterName) {
  const vars = [
    {
      name: 'KEYCLOAK_ADMIN_USERNAME',
      required: true,
      description: 'Keycloak master realm bootstrap admin username',
    },
    {
      name: 'KEYCLOAK_ADMIN_PASSWORD',
      required: true,
      description: 'Keycloak master realm bootstrap admin password',
    },
    {
      name: 'KEYCLOAK_POSTGRES_USER',
      required: true,
      description: "Postgres superuser backing Keycloak's DB",
    },
    {
      name: 'KEYCLOAK_POSTGRES_PASSWORD',
      required: true,
      description: 'Postgres superuser password',
    },
  ];
  if (addonCfg?.config?.soloUiClients?.enabled) {
    vars.push({
      name: 'SOLO_UI_DEFAULT_PASSWORD',
      required: true,
      description: 'Solo UI demo bootstrap password (solo-admin/solo-reader/solo-writer)',
    });
  }
  if ((addonCfg?.config?.realms || []).some(r => r.realm === 'grafana')) {
    vars.push(
      {
        name: 'GRAFANA_REALM_ADMIN_USERNAME',
        required: false,
        description: "Grafana OIDC demo admin username (default: 'grafana-admin')",
      },
      {
        name: 'GRAFANA_REALM_ADMIN_PASSWORD',
        required: true,
        description: 'Grafana OIDC demo admin password',
      }
    );
  }
  for (const realm of addonCfg?.config?.realms || []) {
    for (const user of realm.users || []) {
      if (!user.passwordEnvVar) continue;
      vars.push({
        name: user.passwordEnvVar,
        required: true,
        description: `Password for Keycloak user '${user.username}' in realm '${realm.realm}'`,
      });
    }
  }
  return vars;
}

const DEFAULT_KEYCLOAK_VERSION = '26.7.0';
const DEFAULT_POSTGRES_VERSION = '18.2-alpine';

export function envExportsFor(addonCfg, _profile, env) {
  const cfg = addonCfg.config || {};
  const hostname = tpl(cfg.hostname, env.spec.domains?.core?.keycloak) || 'keycloak.example.com';
  const keycloakVersion =
    addonCfg.version ||
    addonCfg.keycloakVersion ||
    cfg.version ||
    cfg.keycloakVersion ||
    DEFAULT_KEYCLOAK_VERSION;
  const postgresVersion =
    addonCfg.postgresVersion || cfg.postgresVersion || DEFAULT_POSTGRES_VERSION;
  const exports = [
    { name: 'KEYCLOAK_HOSTNAME', value: hostname, comment: 'Keycloak public hostname' },
    {
      name: 'KEYCLOAK_NAMESPACE',
      value: addonCfg.namespace || 'keycloak',
      comment: 'Keycloak namespace',
    },
    { name: 'KEYCLOAK_VERSION', value: keycloakVersion, comment: 'Keycloak container image tag' },
    { name: 'POSTGRES_VERSION', value: postgresVersion, comment: 'PostgreSQL container image tag' },
  ];

  const soloUiClients = cfg.soloUiClients;
  if (soloUiClients?.enabled) {
    exports.push({
      name: 'SOLO_UI_ADMIN_USER',
      value: 'solo-admin',
      comment:
        'Solo UI demo admin username (Keycloak solo-ui realm); password is $SOLO_UI_DEFAULT_PASSWORD',
    });
  }

  return exports;
}

export async function generate(_subIndex, addonCfg, clusterName, profile, env) {
  const [postgresYamlRaw, keycloakYamlRaw] = await Promise.all([
    fs.promises.readFile(join(__dir, 'config/postgres.yaml'), 'utf8'),
    fs.promises.readFile(join(__dir, 'config/keycloak.yaml'), 'utf8'),
  ]);

  const ns = addonCfg.namespace || 'keycloak';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  const cfg = addonCfg.config || {};
  const hostname = tpl(cfg.hostname, env.spec.domains?.core?.keycloak) || 'keycloak.example.com';
  const protocol = tpl(cfg.protocol, null) || 'https';

  const tlsEnabled = cfg.tls?.enabled !== false;
  const createCertificate = cfg.tls?.createCertificate !== false;
  const issuerName = tpl(cfg.tls?.clusterIssuerName, null) || 'selfsigned-issuer';
  const tlsSecretName = tpl(cfg.tls?.secretName, null) || 'keycloak-tls';
  const certOrg = tpl(cfg.tls?.organization, null) || 'solo.io';
  const keycloakVersion =
    addonCfg.version ||
    addonCfg.keycloakVersion ||
    cfg.version ||
    cfg.keycloakVersion ||
    DEFAULT_KEYCLOAK_VERSION;
  const postgresVersion =
    addonCfg.postgresVersion || cfg.postgresVersion || DEFAULT_POSTGRES_VERSION;

  // Substitute template vars in embedded YAML files. Credentials render as the
  // operator-facing shell variables (not literal values) so the runbook never
  // prints a real secret and mirrors what the deploy reads from the environment.
  const fillYaml = s =>
    s
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
      .replaceAll('{{ADMIN_USERNAME}}', '$KEYCLOAK_ADMIN_USERNAME')
      .replaceAll('{{ADMIN_PASSWORD}}', '$KEYCLOAK_ADMIN_PASSWORD')
      .replaceAll('{{POSTGRES_USER}}', '$KEYCLOAK_POSTGRES_USER')
      .replaceAll('{{POSTGRES_PASSWORD}}', '$KEYCLOAK_POSTGRES_PASSWORD');

  const postgresYaml = fillYaml(postgresYamlRaw);
  const keycloakYaml = fillYaml(keycloakYamlRaw);

  // Collect all addon names defined anywhere in the profile (global + per-cluster)
  const allProfileAddonNames = new Set();
  for (const g of profile?.spec?.addons?.global || []) {
    allProfileAddonNames.add(typeof g === 'string' ? g : g.name);
  }
  for (const clusterDef of profile?.spec?.addons?.clusters || []) {
    for (const a of clusterDef.addons || []) {
      allProfileAddonNames.add(typeof a === 'string' ? a : a.name);
    }
  }

  // Collect addon names installed on this specific cluster
  const thisClusterDef = (profile?.spec?.addons?.clusters || []).find(c => c.name === clusterName);
  const thisClusterAddonNames = new Set(
    (thisClusterDef?.addons || []).map(a => (typeof a === 'string' ? a : a.name))
  );

  // Filter realms: if realm name matches a known addon, only include if that addon is on this cluster
  const realms = (cfg.realms || []).filter(
    r => !allProfileAddonNames.has(r.realm) || thisClusterAddonNames.has(r.realm)
  );
  const soloUiClients = cfg.soloUiClients || null;

  let tlsSection = '';
  if (tlsEnabled && createCertificate) {
    tlsSection = `

Create TLS certificate for Keycloak (cert-manager):

\`\`\`bash
kubectl --context=${ctx} apply -f - <<EOF
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
kubectl --context=${ctx} wait certificate/${tlsSecretName} -n ${ns} \\
  --for=condition=Ready --timeout=120s
\`\`\`
`;
  }

  const baseUrl = `${protocol}://${hostname}`;

  // Helper — builds the "Configure realm `<name>`" snippet
  const makeRealmSnippet = realm => {
    const clients = realm.clients || [];
    const users = realm.users || [];
    const groups = realm.groups || [];
    const roles = realm.roles || [];

    const groupLines = groups
      .map(
        g => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/groups" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"name":"${g}"}'`
      )
      .join('\n\n');

    const roleLines = roles
      .map(
        r => `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/roles" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"name":"${r.name}","composite":${!!(r.composite && r.composite.length)}}'`
      )
      .join('\n\n');

    // Composite children are assigned by real role id, which this hand-run snippet
    // can only get via a lookup-then-POST (the real code resolves it from an
    // earlier in-memory createAndVerify() result).
    const compositeRoleLines = roles
      .filter(r => r.composite?.length)
      .map(r => {
        const childLookups = r.composite
          .map(
            child => `      ${shellVar(r.name)}_${shellVar(child)}_ROLE_ID=$(curl -s "$KEYCLOAK_URL/admin/realms/${realm.realm}/roles/${child}" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.id')`
          )
          .join('\n');
        const compositePayload = r.composite
          .map(
            child =>
              `{"id":"'"$${shellVar(r.name)}_${shellVar(child)}_ROLE_ID"'","name":"${child}"}`
          )
          .join(',');
        return `${childLookups}
      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/roles/${r.name}/composites" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '[${compositePayload}]'`;
      })
      .join('\n\n');

    // Same caveat as composites above — a per-user role assignment needs the
    // user's real id and each role's real id, both resolved via lookup here.
    const userRoleLines = users
      .filter(u => u.roles?.length)
      .map(u => {
        const userIdVar = `${shellVar(u.username)}_USER_ID`;
        const roleLookups = u.roles
          .map(
            roleName => `      ${shellVar(u.username)}_${shellVar(roleName)}_ROLE_ID=$(curl -s "$KEYCLOAK_URL/admin/realms/${realm.realm}/roles/${roleName}" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.id')`
          )
          .join('\n');
        const roleReps = u.roles
          .map(
            roleName =>
              `{"id":"'"$${shellVar(u.username)}_${shellVar(roleName)}_ROLE_ID"'","name":"${roleName}"}`
          )
          .join(',');
        return `      ${userIdVar}=$(curl -s "$KEYCLOAK_URL/admin/realms/${realm.realm}/users?username=${u.username}&exact=true" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" | jq -r '.[0].id')
${roleLookups}
      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users/$${userIdVar}/role-mappings/realm" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '[${roleReps}]'`;
      })
      .join('\n\n');

    const clientLines = clients
      .map(c => {
        const isPublic = c.type === 'public';
        return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/clients" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"clientId":"${c.clientId}","publicClient":${isPublic},"enabled":true}'`;
      })
      .join('\n\n');

    const isGrafanaRealm = realm.realm === 'grafana';
    const userLines = users
      .map(u => {
        if (isGrafanaRealm) {
          return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"username":"'"\${GRAFANA_REALM_ADMIN_USERNAME:-grafana-admin}"'","email":"${u.email || ''}","enabled":true,"credentials":[{"type":"password","value":"'"$GRAFANA_REALM_ADMIN_PASSWORD"'","temporary":false}]}'`;
        }
        // Mirrors index.js's precedence: literal password > passwordEnvVar > realm default.
        const password = u.password
          ? u.password
          : u.passwordEnvVar
            ? `'"$${u.passwordEnvVar}"'`
            : realm.defaultPassword || 'Admin1234';
        return `      curl -s -X POST "$KEYCLOAK_URL/admin/realms/${realm.realm}/users" \\
        -H "Authorization: Bearer $ACCESS_TOKEN" \\
        -H "Content-Type: application/json" \\
        -d '{"username":"${u.username}","email":"${u.email || ''}","enabled":true,"credentials":[{"type":"password","value":"${password}","temporary":false}]}'`;
      })
      .join('\n\n');

    return `
**Configure realm \`${realm.realm}\`** (${clients.length} clients, ${users.length} users):

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=$KEYCLOAK_ADMIN_USERNAME&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

# Create realm
curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${realm.realm}","enabled":true,"defaultLocale":"en"}'
${
  groups.length > 0
    ? `
# Create groups
${groupLines}`
    : ''
}${
      roles.length > 0
        ? `
# Create roles
${roleLines}`
        : ''
    }${
      compositeRoleLines
        ? `
# Assign composite roles
${compositeRoleLines}`
        : ''
    }${
      clients.length > 0
        ? `
# Create clients
${clientLines}`
        : ''
    }${
      users.length > 0
        ? `
# Create users
${userLines}`
        : ''
    }${
      userRoleLines
        ? `
# Assign realm roles to users
${userRoleLines}`
        : ''
    }
\`\`\`
`;
  };

  const realmSnippets = realms.map(makeRealmSnippet).join('\n');

  let soloUISection = '';
  if (soloUiClients?.enabled) {
    const suiRealm = soloUiClients.realm || 'solo-ui';
    const suiHostname = tpl(soloUiClients.hostname, env.spec.domains?.core?.soloUi) || '';
    const suiPassword = '$SOLO_UI_DEFAULT_PASSWORD';
    const suiUsers = ['solo-admin', 'solo-reader', 'solo-writer'];
    const suiUserLines = suiUsers
      .map(
        u => `curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/users" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"username":"${u}","enabled":true,"credentials":[{"type":"password","value":"'"$SOLO_UI_DEFAULT_PASSWORD"'","temporary":false}]}'`
      )
      .join('\n\n');
    soloUISection = `

**Configure Solo UI realm \`${suiRealm}\`**:

\`\`\`bash
KEYCLOAK_URL="${baseUrl}"
ACCESS_TOKEN=$(curl -s -X POST "$KEYCLOAK_URL/realms/master/protocol/openid-connect/token" \\
  -d "client_id=admin-cli&grant_type=password&username=$KEYCLOAK_ADMIN_USERNAME&password=$KEYCLOAK_ADMIN_PASSWORD" \\
  | jq -r '.access_token')

curl -s -X POST "$KEYCLOAK_URL/admin/realms" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"realm":"${suiRealm}","enabled":true}'

# Backend client (confidential)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUiClients.backendClientId || 'solo-ui-backend'}","secret":"${soloUiClients.backendClientSecret || 'solo-ui-backend-secret'}","publicClient":false,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Frontend client (public, PKCE)
curl -s -X POST "$KEYCLOAK_URL/admin/realms/${suiRealm}/clients" \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"clientId":"${soloUiClients.frontendClientId || 'solo-ui-frontend'}","publicClient":true,"enabled":true,"redirectUris":["${suiHostname}/*"]}'

# Demo users (password: ${suiPassword})
${suiUserLines}
\`\`\`
`;
  }

  return `Install Keycloak on the **${clusterName}** cluster as OIDC provider. Deployed via raw Kubernetes manifests (PostgreSQL 18.2-alpine + Keycloak 26.5.3) — no Helm chart.

\`\`\`bash
kubectl --context=${ctx} create namespace ${ns} --dry-run=client -o yaml | kubectl --context=${ctx} apply -f -
\`\`\`
${tlsSection}
Apply PostgreSQL (ServiceAccount, Secret, PVC, Service, Deployment):

\`\`\`bash
kubectl --context=${ctx} apply -n ${ns} -f - <<EOF
${postgresYaml.trimEnd()}
EOF
\`\`\`

Wait for PostgreSQL to be ready:

\`\`\`bash
kubectl --context=${ctx} wait --for=condition=Ready pod -l app=postgres -n ${ns} --timeout=300s
\`\`\`

Initialize the Keycloak database:

\`\`\`bash
kubectl --context=${ctx} exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "CREATE DATABASE keycloak;"
kubectl --context=${ctx} exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "CREATE USER keycloak WITH PASSWORD 'password';"
kubectl --context=${ctx} exec -n ${ns} deploy/postgres -- psql -U $KEYCLOAK_POSTGRES_USER -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak;"
\`\`\`

Apply Keycloak (Deployment + Service):

\`\`\`bash
kubectl --context=${ctx} apply -n ${ns} -f - <<EOF
${keycloakYaml.trimEnd()}
EOF
\`\`\`

Wait for Keycloak to be ready:

\`\`\`bash
kubectl --context=${ctx} wait --for=condition=Ready pod -l app=keycloak -n ${ns} --timeout=600s
\`\`\`

Verify Keycloak is reachable:

\`\`\`bash
curl -sk ${baseUrl}/realms/master | jq '.realm'
# Expected: "master"
\`\`\`
${realmSnippets}${soloUISection}`;
}

export async function cleanup(addonCfg, clusterName) {
  const [postgresYaml, keycloakYaml] = await Promise.all([
    fs.promises.readFile(join(__dir, 'config/postgres.yaml'), 'utf8'),
    fs.promises.readFile(join(__dir, 'config/keycloak.yaml'), 'utf8'),
  ]);
  const ns = addonCfg.namespace || 'keycloak';
  const ctx = `$${clusterName.toUpperCase()}_CONTEXT`;
  return `\`\`\`bash
kubectl --context=${ctx} delete -n ${ns} -f - <<'EOF'
${keycloakYaml.trimEnd()}
EOF
kubectl --context=${ctx} delete -n ${ns} -f - <<'EOF'
${postgresYaml.trimEnd()}
EOF
kubectl --context=${ctx} delete namespace ${ns}
\`\`\``;
}
