// test/lib/usecase-template-context.test.js
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { InfraStateManager } from '../../src/lib/infra-state.js';
import { TemplateResolver } from '../../src/lib/template-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

const INFRA_A = '__test-tmpl-ctx-a__';
const INFRA_B = '__test-tmpl-ctx-b__';
const infraYamlPath = name => join(PROJECT_ROOT, 'config', 'infra', `${name}.yaml`);

function writeInfraProfile(name, environment = 'local') {
  writeFileSync(
    infraYamlPath(name),
    `apiVersion: mesh.demo/v1\nkind: InfraProfile\nmetadata:\n  name: ${name}\nspec:\n  name: ${name}\n  provider: eks\n  environment: ${environment}\n  clusters:\n    - name: demo\n      role: management\n`
  );
}

async function provision(name, context) {
  await InfraStateManager.setProvisioned(name, 'eks', [
    {
      name: 'demo',
      context,
      cluster: `${name}-cluster`,
      kubeconfig: `/tmp/${name}.yaml`,
      provisioned: true,
    },
  ]);
}

// detectActiveInfra()'s precedence logic sits on top of listInfraProfiles/
// matchProfilesByKubeContext, which scan the real ._output/infra directory -
// mock both so these tests don't depend on (or get polluted by) whatever a
// developer or live session actually has provisioned on disk.
let originalListInfraProfiles;
let originalMatchProfilesByKubeContext;

function mockDetection({ kubeContext = null, matches = [], listed = [] } = {}) {
  InfraStateManager.matchProfilesByKubeContext = async () => ({ kubeContext, matches });
  InfraStateManager.listInfraProfiles = async () => listed;
}

beforeEach(() => {
  originalListInfraProfiles = InfraStateManager.listInfraProfiles;
  originalMatchProfilesByKubeContext = InfraStateManager.matchProfilesByKubeContext;
});

afterEach(() => {
  InfraStateManager.listInfraProfiles = originalListInfraProfiles;
  InfraStateManager.matchProfilesByKubeContext = originalMatchProfilesByKubeContext;
  for (const name of [INFRA_A, INFRA_B]) {
    if (existsSync(infraYamlPath(name))) rmSync(infraYamlPath(name));
    const dir = InfraStateManager.getOutputDir(name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

test('detectActiveInfra returns the sole provisioned profile when no kube context matches', async () => {
  mockDetection({ matches: [], listed: [{ name: INFRA_A, provisioned: true }] });

  const detected = await UseCaseManager.detectActiveInfra();

  expect(detected).toBe(INFRA_A);
});

test('detectActiveInfra prefers the profile matching the current kube context over an ambiguous set', async () => {
  mockDetection({
    kubeContext: 'eks-demo-b',
    matches: [{ name: INFRA_B, provisioned: true }],
    listed: [
      { name: INFRA_A, provisioned: true },
      { name: INFRA_B, provisioned: true },
    ],
  });

  const detected = await UseCaseManager.detectActiveInfra();

  expect(detected).toBe(INFRA_B);
});

test('detectActiveInfra returns null when multiple profiles are provisioned and none match the kube context', async () => {
  mockDetection({
    kubeContext: 'unrelated-context',
    matches: [],
    listed: [
      { name: INFRA_A, provisioned: true },
      { name: INFRA_B, provisioned: true },
    ],
  });

  const detected = await UseCaseManager.detectActiveInfra();

  expect(detected).toBeNull();
});

test('detectActiveInfra returns null when nothing is provisioned', async () => {
  mockDetection({ matches: [], listed: [] });

  const detected = await UseCaseManager.detectActiveInfra();

  expect(detected).toBeNull();
});

test('buildTemplateContext uses the explicit override over spec.infra', async () => {
  writeInfraProfile(INFRA_A);
  writeInfraProfile(INFRA_B);
  await provision(INFRA_A, 'eks-demo-a');
  await provision(INFRA_B, 'eks-demo-b');

  const ctx = await UseCaseManager.buildTemplateContext(INFRA_A, INFRA_B);

  expect(ctx).not.toBeNull();
  expect(ctx.infra.clusters.demo.cluster).toBe(`${INFRA_B}-cluster`);
});

test('buildTemplateContext falls back to auto-detection when neither override nor spec.infra is given', async () => {
  writeInfraProfile(INFRA_A);
  await provision(INFRA_A, 'eks-demo-a');
  mockDetection({ matches: [], listed: [{ name: INFRA_A, provisioned: true }] });

  const ctx = await UseCaseManager.buildTemplateContext(null, null);

  expect(ctx).not.toBeNull();
  expect(ctx.infra.clusters.demo.cluster).toBe(`${INFRA_A}-cluster`);
});

test('buildTemplateContext returns null when no infra can be resolved at all', async () => {
  mockDetection({ matches: [], listed: [] });

  const ctx = await UseCaseManager.buildTemplateContext(null, null);

  expect(ctx).toBeNull();
});

test('buildTemplateContext resolves a real {{env.*}} array value end-to-end (the gateway sourceRanges case)', async () => {
  writeInfraProfile(INFRA_A, 'aws-dev');
  await provision(INFRA_A, 'eks-demo-a');

  const ctx = await UseCaseManager.buildTemplateContext(INFRA_A);
  const resolved = TemplateResolver.resolveString('{{env.security.vpnSourceRanges}}', ctx);

  expect(ctx).not.toBeNull();
  expect(Array.isArray(resolved)).toBe(true);
  expect(resolved).toEqual(['165.99.148.61/32', '64.226.138.86/32']);
});
