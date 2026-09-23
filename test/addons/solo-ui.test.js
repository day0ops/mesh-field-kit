import { test, expect } from 'bun:test';
import { SoloUIFeature } from '../../addons/solo-ui/index.js';

test('SoloUIFeature sourceRanges defaults to null', () => {
  const f = new SoloUIFeature('solo-ui', {});
  expect(f.sourceRanges).toBeNull();
});

test('SoloUIFeature sourceRanges respects config override', () => {
  const f = new SoloUIFeature('solo-ui', { sourceRanges: ['165.99.148.61/32'] });
  expect(f.sourceRanges).toEqual(['165.99.148.61/32']);
});
