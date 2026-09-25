import { test, expect } from 'bun:test';
import { nlbSourceRangeAnnotations } from '../../src/lib/common.js';

test('nlbSourceRangeAnnotations returns base NLB annotations with no source ranges', () => {
  const result = nlbSourceRangeAnnotations(null);
  expect(result).toEqual({
    'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
    'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'ip',
    'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    'service.beta.kubernetes.io/aws-load-balancer-target-group-attributes':
      'preserve_client_ip.enabled=true',
  });
});

test('nlbSourceRangeAnnotations adds load-balancer-source-ranges (no aws- prefix) when given a single CIDR', () => {
  const result = nlbSourceRangeAnnotations('165.99.148.61/32');
  expect(result['service.beta.kubernetes.io/load-balancer-source-ranges']).toBe('165.99.148.61/32');
});

test('nlbSourceRangeAnnotations joins multiple CIDRs with commas', () => {
  const result = nlbSourceRangeAnnotations(['165.99.148.61/32', '64.226.138.86/32']);
  expect(result['service.beta.kubernetes.io/load-balancer-source-ranges']).toBe(
    '165.99.148.61/32,64.226.138.86/32'
  );
});

test('nlbSourceRangeAnnotations flattens nested arrays and drops falsy entries', () => {
  const result = nlbSourceRangeAnnotations([['165.99.148.61/32', null], '64.226.138.86/32']);
  expect(result['service.beta.kubernetes.io/load-balancer-source-ranges']).toBe(
    '165.99.148.61/32,64.226.138.86/32'
  );
});

test('nlbSourceRangeAnnotations omits the source-ranges key entirely when all entries are falsy', () => {
  const result = nlbSourceRangeAnnotations([null, undefined, false]);
  expect(result['service.beta.kubernetes.io/load-balancer-source-ranges']).toBeUndefined();
});

test('nlbSourceRangeAnnotations targetType instance omits the ip-mode-only target-group-attributes annotation', () => {
  const result = nlbSourceRangeAnnotations('165.99.148.61/32', { targetType: 'instance' });
  expect(result).toEqual({
    'service.beta.kubernetes.io/aws-load-balancer-type': 'external',
    'service.beta.kubernetes.io/aws-load-balancer-nlb-target-type': 'instance',
    'service.beta.kubernetes.io/aws-load-balancer-scheme': 'internet-facing',
    'service.beta.kubernetes.io/load-balancer-source-ranges': '165.99.148.61/32',
  });
});
