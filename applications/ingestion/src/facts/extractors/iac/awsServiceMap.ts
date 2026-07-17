/** @format */

const AWS_SERVICE_MAP: ReadonlyMap<string, string> = new Map([
    ['acm', 'aws_acm'],
    ['apigateway', 'aws_api_gateway'],
    ['execute-api', 'aws_api_gateway'],
    ['autoscaling', 'aws_autoscaling'],
    ['backup', 'aws_backup'],
    ['bedrock', 'aws_bedrock'],
    ['ce', 'aws_cost_explorer'],
    ['cloudformation', 'aws_cloudformation'],
    ['cloudfront', 'aws_cloudfront'],
    ['cloudtrail', 'aws_cloudtrail'],
    ['cognito-idp', 'aws_cognito'],
    ['cognito-identity', 'aws_cognito'],
    ['dynamodb', 'dynamodb'], // ontology canonical is unprefixed (historic)
    ['ec2', 'aws_ec2'],
    ['ecr', 'aws_ecr'],
    ['ecs', 'aws_ecs'],
    ['eks', 'aws_eks'],
    ['elasticloadbalancing', 'aws_elb'],
    ['firehose', 'aws_firehose'],
    ['iam', 'aws_iam'],
    ['kafka', 'aws_kafka'],
    ['kinesis', 'aws_kinesis'],
    ['kms', 'aws_kms'],
    ['lambda', 'aws_lambda'],
    ['logs', 'aws_cloudwatch'],
    ['rds', 'aws_rds'],
    ['route53', 'aws_route53'],
    ['s3', 'aws_s3'],
    ['secretsmanager', 'aws_secrets_manager'],
    ['sns', 'aws_sns'],
    ['sqs', 'aws_sqs'],
    ['ssm', 'aws_ssm'],
    ['states', 'aws_step_functions'],
    ['sts', 'aws_sts'],
    ['textract', 'aws_textract'],
    ['vpc', 'aws_vpc'],
    ['waf', 'aws_waf'],
    ['wafv2', 'aws_wafv2'],
]);

export const AWS_SERVICE_SLUGS: readonly string[] = [...AWS_SERVICE_MAP.keys()];

export function awsCanonicalForSlug(slug: string): string | null {
    return AWS_SERVICE_MAP.get(slug.toLowerCase()) ?? null;
}
