// test/lib/runbook-adapters/usecase.test.js
import { test, expect } from 'bun:test';
import {
  UseCaseAdapter,
  usecaseTitle,
  usecaseName,
} from '../../../src/lib/runbook-adapters/usecase.js';

const mockUsecase = {
  metadata: { name: 'zero-trust-l4', description: 'Enforce zero-trust L4 authorization.' },
  spec: {
    features: [
      { name: 'deny-all-policy', description: 'Deny all traffic by default', config: {} },
      { name: 'authorization-policy', description: 'Allow specific workloads', config: {} },
    ],
  },
};

test('usecaseTitle prefers first description line, stripped of trailing period', () => {
  expect(usecaseTitle(mockUsecase)).toBe('Enforce zero-trust L4 authorization');
});

test('usecaseTitle falls back to humanized name when no description', () => {
  expect(usecaseTitle({ metadata: { name: 'my-cool-demo' }, spec: {} })).toBe('My Cool Demo');
});

test('usecaseName humanizes the metadata name', () => {
  expect(usecaseName(mockUsecase)).toBe('Zero Trust L4');
});

test('UseCaseAdapter.generateCleanupSections returns empty array when no usecases', () => {
  const adapter = new UseCaseAdapter();
  expect(adapter.generateCleanupSections(9, { usecases: [] }, 1)).toEqual([]);
});

test('UseCaseAdapter.generateCleanupSections emits reverse-order Delete Features section', () => {
  const adapter = new UseCaseAdapter();
  const sections = adapter.generateCleanupSections(9, { usecases: [mockUsecase] }, 3);
  expect(sections).toHaveLength(1);
  const md = sections[0];
  expect(md).toContain('### Lab 9.3 — Enforce zero-trust L4 authorization Cleanup');
  expect(md).toContain('#### Delete Features');
  expect(md).toContain('reverse order of creation');
  // authorization-policy (created last) appears before deny-all-policy after reversing
  expect(md.indexOf('authorization-policy')).toBeLessThan(md.indexOf('deny-all-policy'));
});
