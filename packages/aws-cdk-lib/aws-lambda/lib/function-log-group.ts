import { Construct } from 'constructs';
import { IFunction } from './function-base';
import { BaseLogGroupProps, ServiceManagedLogGroup } from '../../aws-logs';

export interface FunctionLogGroupProps extends BaseLogGroupProps {
  /**
   * Name of the log group.
   */
  readonly logGroupName: string;

  /**
   * The resource owning the log group.
   */
  readonly parent: IFunction;
}

export class FunctionLogGroup extends ServiceManagedLogGroup {
  constructor(scope: Construct, id: string, props: FunctionLogGroupProps) {
    super(scope, id, {
      ...props,
      logGroupName: `/aws/lambda/${props.parent.functionName}`,
      tagging: {
        service: 'lambda',
        action: 'ListTags',
      },
    });
  }
}