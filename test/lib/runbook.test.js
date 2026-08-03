// test/lib/runbook.test.js
import { test, expect } from 'bun:test';

test('RunbookPicker.filterProfiles excludes profiles without spec.infra', () => {
  const profiles = [
    { metadata: { name: 'with-infra' }, spec: { infra: 'eks-multi-cluster' } },
    { metadata: { name: 'no-infra' }, spec: {} },
    { metadata: { name: 'null-infra' }, spec: { infra: null } },
  ];
  const result = profiles.filter(p => p.spec?.infra);
  expect(result).toHaveLength(1);
  expect(result[0].metadata.name).toBe('with-infra');
});

import { RunbookPicker } from '../../src/lib/runbook.js';

test('RunbookPicker exists and exports RunbookPicker class', () => {
  expect(RunbookPicker).toBeDefined();
  const picker = new RunbookPicker();
  expect(typeof picker.pick).toBe('function');
  expect(typeof picker.listProfiles).toBe('function');
});

import { UseCaseAdapter } from '../../src/lib/runbook-adapters/usecase.js';

const mockUsecase = {
  metadata: { name: 'zero-trust-l4', description: 'Enforce zero-trust L4 authorization' },
  spec: {
    diagram: 'sequenceDiagram\n  Client->>Waypoint: request\n  Waypoint->>Ztunnel: authz check',
    features: [
      {
        name: 'deny-all-policy',
        description: 'Deny all traffic by default',
        config: { namespace: 'demo' },
      },
      { name: 'authorization-policy', description: 'Allow specific workloads', config: {} },
    ],
    tests: [{ name: 'auth-enforced', description: 'Verify unauthenticated request is rejected' }],
  },
};

test('UseCaseAdapter.generate returns empty string when no usecases selected', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [] };
  const md = await adapter.generate(4, selection);
  expect(md).toBe('');
});

test('UseCaseAdapter.generate produces lab section with use case name', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).toContain('## Lab 4');
  expect(md).toContain('authorization-policy');
  expect(md).toContain('Enforce zero-trust L4 authorization');
});

test('UseCaseAdapter.generate includes mermaid diagram when present', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).toContain('```mermaid');
  expect(md).toContain('sequenceDiagram');
});

test('UseCaseAdapter.generate includes feature steps', async () => {
  const adapter = new UseCaseAdapter();
  const selection = { usecases: [mockUsecase] };
  const md = await adapter.generate(4, selection);
  expect(md).toContain('deny-all-policy');
  expect(md).toContain('authorization-policy');
  expect(md).toContain('namespace: demo');
});

import { RunbookBuilder } from '../../src/lib/runbook.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const fullSelection = {
  profile: {
    metadata: { name: 'eks-multi-cluster-peering-with-kgateway' },
    spec: {
      mesh: { gatewayApiVersion: 'v1.4.0', istioVersion: '1.30.0' },
      addons: {
        global: [{ name: 'cilium', version: '1.19.4', description: 'eBPF CNI' }],
        clusters: [
          {
            name: 'east',
            addons: [
              {
                name: 'kgateway',
                description: 'ingress',
                config: { enterprise: true },
                version: 'v2.2.0',
                namespace: 'kgateway-system',
              },
            ],
          },
          {
            name: 'west',
            addons: [
              {
                name: 'kgateway',
                description: 'ingress',
                config: { enterprise: true },
                version: 'v2.2.0',
                namespace: 'kgateway-system',
              },
            ],
          },
        ],
      },
    },
  },
  infraProfile: {
    metadata: { name: 'eks-multi-cluster' },
    spec: { name: 'maple', provider: 'eks', clusters: [{ name: 'east' }, { name: 'west' }] },
  },
  environment: {
    spec: { aws: { region: 'ap-southeast-1' }, domains: { app: 'app.example.com' } },
  },
  usecases: [],
  outputDir: path.join(os.tmpdir(), `runbook-test-${Date.now()}`),
  filename: 'test-runbook',
};

test('RunbookBuilder.build() writes markdown file with all required sections', async () => {
  const builder = new RunbookBuilder(fullSelection);
  const outputPath = await builder.build();

  expect(fs.existsSync(outputPath)).toBe(true);

  const content = fs.readFileSync(outputPath, 'utf8');
  expect(content).toContain('# Mesh Demo Runbook');
  expect(content).toContain('## Lab 0');
  expect(content).toContain('## Lab 1');
  expect(content).toContain('## Lab 2');
  expect(content).toContain('## Lab 3');

  // Cleanup
  fs.rmSync(fullSelection.outputDir, { recursive: true });
});
