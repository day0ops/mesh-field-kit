import { test, expect } from 'bun:test';
import { ExternalDnsFeature } from '../../addons/external-dns/index.js';

test('ExternalDnsFeature constructor sets defaults', () => {
  const f = new ExternalDnsFeature('external-dns', { domainFilter: 'demo.example.com' });
  expect(f.provider).toBe('route53');
  expect(f.namespace).toBe('external-dns');
  expect(f.serviceAccountRoleArn).toBeNull();
});

test('ExternalDnsFeature constructor respects serviceAccountRoleArn override', () => {
  const f = new ExternalDnsFeature('external-dns', {
    domainFilter: 'demo.example.com',
    serviceAccountRoleArn: 'arn:aws:iam::111111111111:role/external-dns-role',
  });
  expect(f.serviceAccountRoleArn).toBe('arn:aws:iam::111111111111:role/external-dns-role');
});

test('validate passes without serviceAccountRoleArn (optional, not all clouds need IRSA)', () => {
  const f = new ExternalDnsFeature('external-dns', { domainFilter: 'demo.example.com' });
  expect(f.validate()).toBe(true);
});
