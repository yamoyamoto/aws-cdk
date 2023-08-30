import * as path from 'path';
import { Construct, IConstruct } from 'constructs';
import { BaseLogGroupProps, ILogGroup, RetentionDays } from './log-group';
import { LogGroupBase } from './log-group-base';
import * as iam from '../../aws-iam';
import * as s3_assets from '../../aws-s3-assets';
import * as cdk from '../../core';

const SERVICE_MANAGED_LOG_GROUP_TYPE = 'Custom::ServiceManagedLogGroup';
const SERVICE_MANAGED_LOG_GROUP_TAG = 'aws-cdk:service-managed-log-group';

export interface ServiceManagedLogGroupProps extends BaseLogGroupProps {
  /**
   * Name of the log group.
   */
  readonly logGroupName: string;

  /**
   * The resource owning the log group.
   */
  readonly parent: IConstruct;

  /**
   * Configuration for tagging the parent resource
   */
  readonly tagging: ServiceManagedLogGroupTaggingConfig;
}

export interface ServiceManagedLogGroupTaggingConfig {
  /**
   * The service managing the log group
   */
  readonly service: string;
  /**
   * The API action used to retrieve tags
   */
  readonly action: string;
  /**
   * @default "Resource"
   */
  readonly requestField?: string;
  /**
   * @default "Tags"
   */
  readonly responseField?: string;
  /**
   * Additional permissions given to the custom resource function to query tags
   */
  readonly permissions?: string[];
}

export abstract class ServiceManagedLogGroup extends LogGroupBase implements ILogGroup {
  public readonly logGroupArn: string;
  public readonly logGroupName: string;

  constructor(scope: Construct, id: string, props: ServiceManagedLogGroupProps) {
    super(scope, id);

    const retentionInDays = this.validateRetention(props.retention);

    this.logGroupName = props.logGroupName;
    this.logGroupArn = cdk.Stack.of(this).formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: `${props.logGroupName}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });

    // Custom resource provider
    const provider = this.ensureSingletonProviderFunction(props.tagging);
    // Grant required permissions to the provider function, depending on used features
    if (props.retention) {
      provider.grantRetentionPolicy(this.logGroupName);
    }
    if (props.encryptionKey) {
      provider.grantEncryption(this.logGroupName);
    }
    if (props.dataProtectionPolicy) {
      provider.grantDataProtectionPolicy(this.logGroupName);
    }
    if (props.removalPolicy === cdk.RemovalPolicy.DESTROY) {
      provider.grantDelete(this.logGroupName);
    }

    const resource = new cdk.CfnResource(this, 'Resource', {
      type: SERVICE_MANAGED_LOG_GROUP_TYPE,
      properties: {
        ServiceToken: provider.functionArn,
        DataProtectionPolicy: props.dataProtectionPolicy?._bind(this),
        KmsKeyId: props.encryptionKey?.keyArn,
        LogGroupName: props.logGroupName,
        RetentionInDays: retentionInDays,
        Tagging: props.tagging,
      },
    });
    resource.applyRemovalPolicy(props.removalPolicy);

    // We also tag the parent resource to record the fact that we are updating the log group
    // The custom resource will check this tag before delete the log group
    // Because tagging and untagging will ALWAYS happen before the CR is deleted,
    // we can remove the construct, without the deleting the log group  as a side effect.
    cdk.Tags.of(props.parent).add(SERVICE_MANAGED_LOG_GROUP_TAG, 'true');
  }

  /**
   * Validate log retention
   */
  private validateRetention(retentionInDays?: RetentionDays) {
    if (retentionInDays === undefined) { retentionInDays = RetentionDays.TWO_YEARS; }
    if (retentionInDays === Infinity || retentionInDays === RetentionDays.INFINITE) { retentionInDays = undefined; }

    if (retentionInDays !== undefined && !cdk.Token.isUnresolved(retentionInDays) && retentionInDays <= 0) {
      throw new Error(`retentionInDays must be positive, got ${retentionInDays}`);
    }

    return retentionInDays;
  }

  /**
   * Helper method to ensure that only one instance of the provider function resources is in the stack.
   * Mimicking the behavior of @aws-cdk/aws-lambda's SingletonFunction to prevent circular dependencies.
   */
  private ensureSingletonProviderFunction(tagging: ServiceManagedLogGroupTaggingConfig) {
    const functionLogicalId = 'ServiceManagedLogGroupGroup' + 'f0360f7393ea41069d5f706d30f37fa7';
    const existing = cdk.Stack.of(this).node.tryFindChild(functionLogicalId);
    if (existing) {
      return existing as ServiceManagedLogGroupFunction;
    }
    return new ServiceManagedLogGroupFunction(cdk.Stack.of(this), functionLogicalId, {
      tagging,
    });
  }
}

interface ServiceManagedLogGroupFunctionProps {
  tagging: ServiceManagedLogGroupTaggingConfig;
}

/**
 * The lambda function backing the custom resource
 */
class ServiceManagedLogGroupFunction extends Construct implements cdk.ITaggable {
  public readonly functionArn: cdk.Reference;

  public readonly tags: cdk.TagManager = new cdk.TagManager(cdk.TagType.KEY_VALUE, 'AWS::Lambda::Function');

  private readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: ServiceManagedLogGroupFunctionProps) {
    super(scope, id);

    const asset = new s3_assets.Asset(this, 'Code', {
      path: path.join(__dirname, 'log-retention-provider'),
    });

    const role = new iam.Role(this, 'ServiceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });

    // Special permissions for log retention
    // Using '*' here because we will also put a retention policy on
    // the log group of the provider function.
    // Referencing its name creates a CF circular dependency.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy'],
      resources: ['*'],
    }));

    this.role = role;

    // Lambda function
    const resource = new cdk.CfnResource(this, 'Resource', {
      type: 'AWS::Lambda::Function',
      properties: {
        Handler: 'index.handler',
        Runtime: 'nodejs18.x',
        Code: {
          S3Bucket: asset.s3BucketName,
          S3Key: asset.s3ObjectKey,
        },
        Environment: {
          TAG_SERVICE: props.tagging.service,
          TAG_API_ACTION: props.tagging.action,
          TAG_REQUEST_FIELD: props.tagging.requestField ?? 'Resource',
          TAG_RESPONSE_FIELD: props.tagging.responseField ?? 'Tags',
        },
        Role: role.roleArn,
        Tags: this.tags.renderedTags,
      },
    });
    this.functionArn = resource.getAtt('Arn');

    asset.addResourceMetadata(resource, 'Code');

    // Function dependencies
    role.node.children.forEach((child) => {
      if (cdk.CfnResource.isCfnResource(child)) {
        resource.addDependency(child);
      }
      if (Construct.isConstruct(child) && child.node.defaultChild && cdk.CfnResource.isCfnResource(child.node.defaultChild)) {
        resource.addDependency(child.node.defaultChild);
      }
    });
  }

  /**
   * @internal
   */
  public grantDataProtectionPolicy(logGroupName: string) {
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:PutDataProtectionPolicy', 'DeleteDataProtectionPolicy'],
      resources: [this.arnFromLogGroupName(logGroupName)],
    }));
  }

  /**
   * @internal
   */
  public grantRetentionPolicy(logGroupName: string) {
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:PutRetentionPolicy', 'DeleteRetentionPolicy'],
      resources: [this.arnFromLogGroupName(logGroupName)],
    }));
  }

  /**
   * @internal
   */
  public grantEncryption(logGroupName: string) {
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:AssociateKmsKey', 'logs:DisassociateKmsKey'],
      resources: [this.arnFromLogGroupName(logGroupName)],
    }));
  }

  /**
   * @internal
   */
  public grantDelete(logGroupName: string) {
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['logs:DeleteLogGroup'],
      resources: [this.arnFromLogGroupName(logGroupName)],
    }));
  }

  /**
   * Get the ARN for a Log Group name
   */
  private arnFromLogGroupName(logGroupName: string): string {
    return cdk.Stack.of(this).formatArn({
      service: 'logs',
      resource: 'log-group',
      resourceName: `${logGroupName}:*`,
      arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
    });
  }
}
