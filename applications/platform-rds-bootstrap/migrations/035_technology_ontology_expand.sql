-- 035_technology_ontology_expand.sql
--
-- Tech Extractor Layer 1 — curated ontology expansion (toward LLM parity).
--
-- Data-driven from the live parity run on Nelson-Lamounier/{kubernetes-bootstrap,
-- tucaken-app}: adds the genuine technologies in this AWS/Kubernetes monorepo
-- (curation_level='curated'), with rich aliases that absorb the LLM enricher's
-- free-form variant spellings (e.g. "aws auto scaling" / "autoscaling" / "asg"
-- -> aws_autoscaling) so they resolve to one canonical. Raises intersection
-- with the LLM set without inventing non-technologies (file names, shell
-- commands, web APIs in the LLM output are intentionally NOT curated).
--
-- Expand-only, idempotent (ON CONFLICT DO NOTHING). Categories must be in the
-- 034 CHECK set. Grants already cover these tables (034).

BEGIN;

-- ── Canonical technologies ────────────────────────────────────────────────
INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source)
VALUES
    -- languages / runtimes / build
    ('bash','Bash','language','curated','seed-035'),
    ('bun','Bun','runtime','curated','seed-035'),
    ('yarn','Yarn','package_manager','curated','seed-035'),
    ('npm','npm','package_manager','curated','seed-035'),
    ('esbuild','esbuild','build_tool','curated','seed-035'),
    ('vite','Vite','build_tool','curated','seed-035'),
    -- web / frontend
    ('tailwindcss','Tailwind CSS','framework_web','curated','seed-035'),
    ('framer_motion','Framer Motion','framework_web','curated','seed-035'),
    ('hono','Hono','framework_web','curated','seed-035'),
    ('vitest','Vitest','testing','curated','seed-035'),
    -- databases / cache
    ('dynamodb','Amazon DynamoDB','database_nosql','curated','seed-035'),
    ('pgbouncer','PgBouncer','database_relational','curated','seed-035'),
    -- containers / orchestration / k8s ecosystem
    ('argocd','Argo CD','orchestration','curated','seed-035'),
    ('argo_rollouts','Argo Rollouts','orchestration','curated','seed-035'),
    ('argocd_image_updater','Argo CD Image Updater','ci_cd','curated','seed-035'),
    ('karpenter','Karpenter','orchestration','curated','seed-035'),
    ('cluster_autoscaler','Cluster Autoscaler','orchestration','curated','seed-035'),
    ('calico','Calico','cloud_networking','curated','seed-035'),
    ('cert_manager','cert-manager','cloud_security','curated','seed-035'),
    ('external_secrets','External Secrets Operator','cloud_security','curated','seed-035'),
    ('traefik','Traefik','cloud_networking','curated','seed-035'),
    ('metrics_server','Kubernetes Metrics Server','observability','curated','seed-035'),
    ('aws_load_balancer_controller','AWS Load Balancer Controller','cloud_networking','curated','seed-035'),
    ('crossplane','Crossplane','iac','curated','seed-035'),
    ('ansible','Ansible','iac','curated','seed-035'),
    ('cdk_nag','cdk-nag','iac','curated','seed-035'),
    ('checkov','Checkov','cloud_security','curated','seed-035'),
    ('headlamp','Headlamp','observability','curated','seed-035'),
    -- observability
    ('loki','Grafana Loki','observability','curated','seed-035'),
    ('alloy','Grafana Alloy','observability','curated','seed-035'),
    ('pyroscope','Grafana Pyroscope','observability','curated','seed-035'),
    ('alertmanager','Alertmanager','observability','curated','seed-035'),
    ('opencost','OpenCost','observability','curated','seed-035'),
    ('aws_cloudwatch','Amazon CloudWatch','observability','curated','seed-035'),
    -- AWS compute / containers
    ('aws_ec2','Amazon EC2','cloud_compute','curated','seed-035'),
    ('aws_eks','Amazon EKS','cloud_compute','curated','seed-035'),
    ('aws_ecr','Amazon ECR','cloud_compute','curated','seed-035'),
    ('aws_ecs','Amazon ECS','cloud_compute','curated','seed-035'),
    ('aws_ebs','Amazon EBS','cloud_storage','curated','seed-035'),
    -- AWS networking / edge
    ('aws_cloudfront','Amazon CloudFront','cloud_networking','curated','seed-035'),
    ('aws_route53','Amazon Route 53','cloud_networking','curated','seed-035'),
    ('aws_api_gateway','Amazon API Gateway','cloud_networking','curated','seed-035'),
    ('aws_vpc','Amazon VPC','cloud_networking','curated','seed-035'),
    ('aws_elb','AWS Elastic Load Balancing','cloud_networking','curated','seed-035'),
    ('aws_waf','AWS WAF','cloud_security','curated','seed-035'),
    -- AWS security / identity
    ('aws_iam','AWS IAM','cloud_security','curated','seed-035'),
    ('aws_kms','AWS KMS','cloud_security','curated','seed-035'),
    ('aws_secrets_manager','AWS Secrets Manager','cloud_security','curated','seed-035'),
    ('aws_cognito','Amazon Cognito','auth','curated','seed-035'),
    ('aws_ssm','AWS Systems Manager','cloud_security','curated','seed-035'),
    ('aws_sts','AWS STS','cloud_security','curated','seed-035'),
    -- AWS messaging / events / workflow
    ('aws_sqs','Amazon SQS','message_broker','curated','seed-035'),
    ('aws_sns','Amazon SNS','message_broker','curated','seed-035'),
    ('aws_eventbridge','Amazon EventBridge','message_broker','curated','seed-035'),
    ('aws_step_functions','AWS Step Functions','cloud_serverless','curated','seed-035'),
    ('aws_firehose','Amazon Data Firehose','cloud_serverless','curated','seed-035'),
    -- AWS data / ml / other
    ('aws_textract','Amazon Textract','ai_platform','curated','seed-035'),
    ('aws_cost_explorer','AWS Cost Explorer','observability','curated','seed-035'),
    ('aws_cloudformation','AWS CloudFormation','iac','curated','seed-035'),
    ('aws_cloudtrail','AWS CloudTrail','cloud_security','curated','seed-035'),
    ('aws_backup','AWS Backup','cloud_storage','curated','seed-035'),
    ('aws_sdk','AWS SDK','build_tool','curated','seed-035'),
    -- AI
    ('anthropic_claude','Anthropic Claude','ai_platform','curated','seed-035'),
    ('boto3','boto3','build_tool','curated','seed-035'),
    -- auth / misc libs
    ('jwt','JSON Web Tokens','auth','curated','seed-035'),
    ('bcrypt','bcrypt','auth','curated','seed-035'),
    ('zod','Zod','build_tool','curated','seed-035'),
    ('opentelemetry','OpenTelemetry','observability','curated','seed-035'),
    ('grpc','gRPC','api_protocol','curated','seed-035'),
    ('graphql','GraphQL','api_protocol','curated','seed-035'),
    ('rest','REST','api_protocol','curated','seed-035')
ON CONFLICT (canonical_name) DO NOTHING;

-- ── Aliases (lowercased). Absorb the LLM enricher's variant spellings. ─────
INSERT INTO technology_aliases (alias, technology_id, source)
SELECT a.alias, o.id, 'seed-035'
FROM (VALUES
    ('bash','bash'), ('shell','bash'), ('sh','bash'),
    ('bun','bun'),
    ('yarn','yarn'), ('npm','npm'),
    ('esbuild','esbuild'), ('vite','vite'),
    ('tailwindcss','tailwindcss'), ('tailwind','tailwindcss'), ('tailwind css','tailwindcss'),
    ('framer-motion','framer_motion'), ('framer motion','framer_motion'), ('motion','framer_motion'),
    ('hono','hono'),
    ('vitest','vitest'),
    ('dynamodb','dynamodb'), ('aws dynamodb','dynamodb'), ('amazon dynamodb','dynamodb'),
    ('pgbouncer','pgbouncer'),
    ('argocd','argocd'), ('argo cd','argocd'), ('argo-cd','argocd'), ('argo','argocd'), ('argocd cli','argocd'),
    ('argo rollouts','argo_rollouts'), ('argo-rollouts','argo_rollouts'), ('argoproj','argo_rollouts'),
    ('argocd image updater','argocd_image_updater'), ('argocd-image-updater','argocd_image_updater'),
    ('karpenter','karpenter'),
    ('cluster autoscaler','cluster_autoscaler'), ('cluster-autoscaler','cluster_autoscaler'),
    ('calico','calico'),
    ('cert-manager','cert_manager'), ('cert manager','cert_manager'),
    ('external-secrets','external_secrets'), ('external secrets operator','external_secrets'),
    ('external secrets','external_secrets'), ('eso','external_secrets'), ('clustersecretstore','external_secrets'),
    ('traefik','traefik'),
    ('metrics-server','metrics_server'), ('metrics server','metrics_server'),
    ('aws load balancer controller','aws_load_balancer_controller'),
    ('aws-load-balancer-controller','aws_load_balancer_controller'), ('alb ingress controller','aws_load_balancer_controller'),
    ('crossplane','crossplane'), ('aws upbound provider','crossplane'), ('aws upbound','crossplane'),
    ('ansible','ansible'),
    ('cdk-nag','cdk_nag'), ('cdk nag','cdk_nag'),
    ('checkov','checkov'),
    ('headlamp','headlamp'),
    ('loki','loki'), ('grafana loki','loki'),
    ('alloy','alloy'), ('grafana alloy','alloy'),
    ('pyroscope','pyroscope'), ('grafana pyroscope','pyroscope'),
    ('alertmanager','alertmanager'),
    ('opencost','opencost'),
    ('cloudwatch','aws_cloudwatch'), ('aws cloudwatch','aws_cloudwatch'), ('amazon cloudwatch','aws_cloudwatch'),
    ('aws cloudwatch logs','aws_cloudwatch'), ('cloudwatch logs','aws_cloudwatch'), ('cloudwatch agent','aws_cloudwatch'),
    ('ec2','aws_ec2'), ('aws ec2','aws_ec2'), ('amazon ec2','aws_ec2'),
    ('eks','aws_eks'), ('aws eks','aws_eks'), ('amazon eks','aws_eks'),
    ('ecr','aws_ecr'), ('aws ecr','aws_ecr'), ('amazon ecr','aws_ecr'),
    ('ecs','aws_ecs'), ('aws ecs','aws_ecs'),
    ('ebs','aws_ebs'), ('aws ebs','aws_ebs'), ('aws ebs csi driver','aws_ebs'), ('aws-ebs-csi-driver','aws_ebs'),
    ('cloudfront','aws_cloudfront'), ('aws cloudfront','aws_cloudfront'),
    ('route53','aws_route53'), ('aws route53','aws_route53'), ('route 53','aws_route53'),
    ('api gateway','aws_api_gateway'), ('aws api gateway','aws_api_gateway'), ('api gateway v2','aws_api_gateway'),
    ('vpc','aws_vpc'), ('aws vpc','aws_vpc'),
    ('alb','aws_elb'), ('aws alb','aws_elb'), ('nlb','aws_elb'), ('aws nlb','aws_elb'), ('elb','aws_elb'),
    ('waf','aws_waf'), ('aws waf','aws_waf'), ('aws wafv2','aws_waf'),
    ('iam','aws_iam'), ('aws iam','aws_iam'),
    ('kms','aws_kms'), ('aws kms','aws_kms'),
    ('secrets manager','aws_secrets_manager'), ('aws secrets manager','aws_secrets_manager'),
    ('aws-secretsmanager','aws_secrets_manager'), ('aws secretsmanager','aws_secrets_manager'),
    ('cognito','aws_cognito'), ('amazon cognito','aws_cognito'), ('aws cognito','aws_cognito'),
    ('cognito identity provider','aws_cognito'),
    ('ssm','aws_ssm'), ('aws ssm','aws_ssm'), ('aws-ssm','aws_ssm'), ('aws systems manager','aws_ssm'),
    ('aws ssm parameter store','aws_ssm'), ('aws parameter store','aws_ssm'),
    ('sts','aws_sts'), ('aws sts','aws_sts'),
    ('sqs','aws_sqs'), ('aws sqs','aws_sqs'),
    ('sns','aws_sns'), ('aws sns','aws_sns'), ('amazon sns','aws_sns'),
    ('eventbridge','aws_eventbridge'), ('aws eventbridge','aws_eventbridge'),
    ('step functions','aws_step_functions'), ('aws step functions','aws_step_functions'),
    ('firehose','aws_firehose'), ('aws firehose','aws_firehose'),
    ('textract','aws_textract'), ('aws textract','aws_textract'), ('amazon textract','aws_textract'),
    ('cost explorer','aws_cost_explorer'), ('aws cost explorer','aws_cost_explorer'),
    ('cloudformation','aws_cloudformation'), ('aws cloudformation','aws_cloudformation'),
    ('cloudtrail','aws_cloudtrail'), ('aws cloudtrail','aws_cloudtrail'),
    ('aws backup','aws_backup'),
    ('aws sdk','aws_sdk'), ('aws-sdk','aws_sdk'), ('aws sdk v3','aws_sdk'), ('aws sdks','aws_sdk'),
    ('anthropic','anthropic_claude'), ('claude','anthropic_claude'), ('anthropic claude','anthropic_claude'),
    ('claude haiku','anthropic_claude'), ('claude sonnet','anthropic_claude'),
    ('boto3','boto3'),
    ('jwt','jwt'), ('bearer jwt','jwt'), ('json web tokens','jwt'),
    ('bcrypt','bcrypt'),
    ('zod','zod'),
    ('opentelemetry','opentelemetry'), ('otel','opentelemetry'), ('adot','opentelemetry'),
    ('grpc','grpc'), ('graphql','graphql'), ('rest','rest')
) AS a(alias, canon)
JOIN technology_ontology o ON o.canonical_name = a.canon
ON CONFLICT (alias) DO NOTHING;

COMMIT;
