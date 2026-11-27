import { test, expect, describe, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync } from 'fs';
import { writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { UseCaseManager } from '../../src/lib/usecase.js';
import { Feature, FeatureManager } from '../../src/lib/feature.js';
import { InfraStateManager } from '../../src/lib/infra-state.js';

class RecordingFeature extends Feature {
  async deploy() {}
  async cleanup() {
    RecordingFeature.cleanedUp.push(this.name);
  }
}
RecordingFeature.cleanedUp = [];
FeatureManager.register('certificate', RecordingFeature);
FeatureManager.register('__test-uc-cert-skip-other', RecordingFeature);

const usecaseYaml =
  `apiVersion: mesh.demo/v1\n` +
  `kind: UseCase\n` +
  `metadata:\n` +
  `  name: cert-skip-test\n` +
  `spec:\n` +
  `  features:\n` +
  `    - name: certificate\n` +
  `      config: { name: cert-skip-test-tls }\n` +
  `    - name: __test-uc-cert-skip-other\n`;

// detectActiveInfra()'s precedence logic scans real infra state on disk - mock it out so
// these tests never depend on (or get polluted by) whatever's actually provisioned.
let originalListInfraProfiles, originalMatchProfilesByKubeContext;

describe('UseCaseManager.cleanup certificate skip/force', () => {
  let tmpRoot;

  beforeEach(() => {
    RecordingFeature.cleanedUp = [];
    originalListInfraProfiles = InfraStateManager.listInfraProfiles;
    originalMatchProfilesByKubeContext = InfraStateManager.matchProfilesByKubeContext;
    InfraStateManager.matchProfilesByKubeContext = async () => ({ kubeContext: null, matches: [] });
    InfraStateManager.listInfraProfiles = async () => [];
  });

  afterEach(() => {
    InfraStateManager.listInfraProfiles = originalListInfraProfiles;
    InfraStateManager.matchProfilesByKubeContext = originalMatchProfilesByKubeContext;
  });

  afterAll(async () => {
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  test('skips the certificate feature by default', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-cert-skip-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);

    await UseCaseManager.cleanup(usecaseFile);

    expect(RecordingFeature.cleanedUp).toEqual(['__test-uc-cert-skip-other']);
  });

  test('cleans up the certificate feature too when force is set', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'uc-cert-skip-'));
    const usecaseFile = join(tmpRoot, 'uc.yaml');
    await writeFile(usecaseFile, usecaseYaml);

    await UseCaseManager.cleanup(usecaseFile, { force: true });

    expect(RecordingFeature.cleanedUp).toEqual(['__test-uc-cert-skip-other', 'certificate']);
  });
});
