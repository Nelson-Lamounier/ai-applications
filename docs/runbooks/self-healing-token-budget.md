---
title: Respond to a self-healing token-budget alarm
type: runbook
tags: [operations, bedrock, finops, self-healing]
sources:
  - infra/lib/stacks/self-healing/agent-stack.ts
  - applications/self-healing/src/index.ts
created: 2026-05-27
updated: 2026-05-27
---

## When to run this

When **either** of the two self-healing token-budget alarms fires:

- `${namePrefix}-agent-token-budget` — hourly: input+output tokens
  exceeded the hourly budget (default `100_000`)
  ([agent-stack.ts:370-394](../../infra/lib/stacks/self-healing/agent-stack.ts#L370-L394)).
- `${namePrefix}-agent-monthly-token-budget` — 30-day window: tokens
  exceeded the monthly budget (`props.monthlyTokenBudget`)
  ([agent-stack.ts:630-660](../../infra/lib/stacks/self-healing/agent-stack.ts#L630-L660)).

Both fire on the same `inputTokens + outputTokens` math expression,
extracted from the agent's structured log lines via
`logs.MetricFilter` (`InputTokensMetric`, `OutputTokensMetric` in the
`${namePrefix}/SelfHealing` namespace)
([agent-stack.ts:343-365](../../infra/lib/stacks/self-healing/agent-stack.ts#L343-L365)).

The hourly alarm is the early-warning ("the agent is in a tight loop
right now"). The monthly alarm is the cost-ceiling backstop ("a slow
leak has accumulated"). Both warrant a response; they imply different
root causes.

## Prerequisites

- AWS console or CLI access scoped to the agent's account
- Read access to the agent's CloudWatch log group:
  `/aws/lambda/${namePrefix}-agent`
- Permission to update Lambda concurrency:
  `lambda:PutFunctionConcurrency` on the agent function
- The agent function name: `${namePrefix}-agent` (also exported as
  the SSM parameter `/${namePrefix}/agent-lambda-name`,
  [agent-stack.ts:704-708](../../infra/lib/stacks/self-healing/agent-stack.ts#L704-L708))

## Procedure

### Hourly alarm — `${namePrefix}-agent-token-budget`

Indicates active runaway. Stop the bleeding first, then diagnose.

#### 1. Force-disable the agent

Set reserved concurrency to 0 to stop further invocations without
losing in-flight ones:

```bash
aws lambda put-function-concurrency \
  --function-name ${namePrefix}-agent \
  --reserved-concurrent-executions 0
```

The trigger queue (SQS FIFO) will continue to receive messages but
they will not be delivered until concurrency is restored. After
two failed delivery attempts they land on the agent DLQ
(`${namePrefix}-agent-lambda-dlq`,
[agent-stack.ts:534-536](../../infra/lib/stacks/self-healing/agent-stack.ts#L534-L536)).

#### 2. Identify the offending alarm(s)

Pull the last hour of agent invocations from CloudWatch Logs Insights
on `/aws/lambda/${namePrefix}-agent`:

```
fields @timestamp, alarmName, cumulativeTokens, totalIterations
| filter ispresent(cumulativeTokens)
| sort @timestamp desc
| limit 50
```

Rows are emitted by the agent loop on every iteration
([applications/self-healing/src/index.ts:1084-1091, 1234-1239](../../applications/self-healing/src/index.ts#L1084-L1091))
so a single tight-loop invocation produces ~10 rows (one per
`MAX_ITERATIONS`). A single offender will be obvious by its
`cumulativeTokens` near `MAX_TOKENS_PER_INVOCATION` (20,000) and
`totalIterations` near 10.

#### 3. Inspect the prompt + tool calls for that invocation

Filter by the offender's `correlationId` (extracted from the rows
above):

```
fields @timestamp, level, message, toolName, toolInput
| filter correlationId = "sh-1716800000000-abcdef"
| sort @timestamp asc
```

Two failure modes are common:

- **Tool result loop** — the model invokes the same tool repeatedly
  because the result is ambiguous. Look for the same `toolName` row
  multiple times in succession.
- **Bootstrap diagnostic dwell** — a bootstrap alarm fires repeatedly
  while remediation is in progress. Look for `[REFLECT]` or
  `[VERIFICATION REQUIRED]` injections multiple times in one
  invocation
  ([index.ts:1185-1190, 1218-1232](../../applications/self-healing/src/index.ts#L1185-L1232)).

#### 4. Restore the agent (if the cause is understood)

```bash
aws lambda put-function-concurrency \
  --function-name ${namePrefix}-agent \
  --reserved-concurrent-executions ${original_value}
```

The original value is whatever was set as `reservedConcurrency` in the
CDK props
([agent-stack.ts:331-335](../../infra/lib/stacks/self-healing/agent-stack.ts#L331-L335)).
If undefined in props, the property is omitted and concurrency is
account-unreserved — restore by **deleting** the concurrency override:

```bash
aws lambda delete-function-concurrency \
  --function-name ${namePrefix}-agent
```

### Monthly alarm — `${namePrefix}-agent-monthly-token-budget`

Indicates a slow leak rather than runaway. Diagnose without stopping
the agent.

#### 1. Confirm invocation rate

```
fields @timestamp, alarmName
| filter @message like /Self-healing agent invoked/
| stats count() by bin(1d)
```

A baseline noisy environment produces a handful per day. A monthly
budget breach typically corresponds to one of:

- A specific alarm that flaps daily (visible by repeated `alarmName`)
- An ASG that is replacing nodes more often than expected
  (visible by `aws.autoscaling` source with high count)

#### 2. Pull per-alarm token cost

```
fields alarmName, cumulativeTokens
| filter ispresent(cumulativeTokens) and ispresent(alarmName)
| stats sum(cumulativeTokens) as totalTokens by alarmName
| sort totalTokens desc
| limit 20
```

The output identifies the dominant alarm by cumulative spend.

#### 3. Decide the response

| Cause | Action |
| :- | :- |
| Specific alarm flapping | Fix the underlying alarm (tune threshold, evaluation period, or scoped metric). The agent is doing what it was asked. |
| ASG churn (worker replacements) | Out of scope of self-healing — inspect the kubernetes-platform / kubernetes-bootstrap stack. |
| Single bootstrap loop running for days | Look at the dedup table (`${namePrefix}-dedup`) — possible bug where the dedup key is too narrow and the same alarm reaches the agent repeatedly. |
| All causes look healthy | The monthly budget is set too low; raise it in CDK props and redeploy. |

## Verification

After restoring the agent:

```bash
# Confirm concurrency is back to its intended value
aws lambda get-function-concurrency \
  --function-name ${namePrefix}-agent

# Verify the trigger queue has drained
aws sqs get-queue-attributes \
  --queue-url $(aws ssm get-parameter \
    --name /${namePrefix}/agent-trigger-queue-url \
    --query Parameter.Value --output text) \
  --attribute-names ApproximateNumberOfMessages
```

The DLQ should remain empty:

```bash
aws sqs get-queue-attributes \
  --queue-url $(aws ssm get-parameter \
    --name /${namePrefix}/agent-dlq-url \
    --query Parameter.Value --output text) \
  --attribute-names ApproximateNumberOfMessages
```

If the DLQ contains messages, see [troubleshooting/self-healing-stuck-remediation.md](../troubleshooting/self-healing-stuck-remediation.md)
*(planned)*.

## Rollback

The runbook itself is non-destructive — it only adjusts Lambda
concurrency on a service that is opt-in destructive by default
(`DRY_RUN=true`). The two reversible actions in this runbook are:

| Action | Rollback |
| :- | :- |
| `put-function-concurrency --reserved-concurrent-executions 0` | `delete-function-concurrency` or restore original value |
| Raised CDK `tokenBudgetPerHour` / `monthlyTokenBudget` | Revert the CDK commit and redeploy |

If during diagnosis you discover a code-level cause (e.g. the agent
loop terminates without verification despite the `verificationEnforced`
guard), file an incident and consider keeping `reserved-concurrent-executions
0` until a fix lands. The platform tolerates the agent being offline —
alarms will continue to fire, just without the automated diagnostic
report.

<!--
Evidence trail (auto-generated):
- Source: infra/lib/stacks/self-healing/agent-stack.ts (lines 330-400, 630-770 on 2026-05-27)
- Source: applications/self-healing/src/index.ts (lines 67-105, 1084-1232 on 2026-05-27)
- SSM parameter paths confirmed at agent-stack.ts:697-725
-->
