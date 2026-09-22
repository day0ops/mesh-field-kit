import { test, expect } from 'bun:test';
import { AwsLoadBalancerControllerFeature } from '../../addons/aws-load-balancer-controller/index.js';

test('AwsLoadBalancerControllerFeature constructor sets defaults', () => {
  const f = new AwsLoadBalancerControllerFeature('aws-load-balancer-controller', {
    serviceAccountRoleArn: 'arn:aws:iam::111111111111:role/lbc-role',
    clusterName: 'my-cluster',
  });
  expect(f.lbControllerNamespace).toBe('kube-system');
  expect(f.chartVersion).toBe('3.5.0');
  expect(f.vpcId).toBeNull();
  expect(f.kubeContext).toBeNull();
});

test('AwsLoadBalancerControllerFeature constructor respects overrides', () => {
  const f = new AwsLoadBalancerControllerFeature('aws-load-balancer-controller', {
    namespace: 'custom-ns',
    version: '3.6.0',
    serviceAccountRoleArn: 'arn:aws:iam::111111111111:role/lbc-role',
    clusterName: 'my-cluster',
    vpcId: 'vpc-123',
    kubeContext: 'ctx1',
  });
  expect(f.lbControllerNamespace).toBe('custom-ns');
  expect(f.chartVersion).toBe('3.6.0');
  expect(f.serviceAccountRoleArn).toBe('arn:aws:iam::111111111111:role/lbc-role');
  expect(f.clusterName).toBe('my-cluster');
  expect(f.vpcId).toBe('vpc-123');
  expect(f.kubeContext).toBe('ctx1');
});

test('validate fails without serviceAccountRoleArn', () => {
  const f = new AwsLoadBalancerControllerFeature('aws-load-balancer-controller', {
    clusterName: 'my-cluster',
  });
  expect(f.validate()).toBe(false);
});

test('validate fails without clusterName', () => {
  const f = new AwsLoadBalancerControllerFeature('aws-load-balancer-controller', {
    serviceAccountRoleArn: 'arn:aws:iam::111111111111:role/lbc-role',
  });
  expect(f.validate()).toBe(false);
});

test('validate passes with required fields', () => {
  const f = new AwsLoadBalancerControllerFeature('aws-load-balancer-controller', {
    serviceAccountRoleArn: 'arn:aws:iam::111111111111:role/lbc-role',
    clusterName: 'my-cluster',
  });
  expect(f.validate()).toBe(true);
});
