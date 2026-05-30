---
title: Self-healing agent stuck remediating a flapping alarm
type: troubleshooting
tags: [self-healing, bedrock, sqs, dynamodb, s3, idempotency]
sources:
  - applications/self-healing/src/index.ts
  - infra/lib/stacks/self-healing/agent-stack.ts
created: 2026-05-27
updated: 2026-05-27
---

## Symptom

One or more of the following, all relating to the same alarm name:

- The SNS report email lands repeatedly (every few minutes) for the
  same `alarmName` even though the agent reports `status: SUCCESS`.
- The hourly token-budget alarm
  (`${namePrefix}-agent-token-budget`) fires repeatedly for the same
  `alarmName`.
- `cumulativeTokens` rows in CloudWatch Logs Insights show the same
  alarm name appearing every 5 minutes.
- The trigger SQS FIFO queue (`ApproximateNumberOfMessages`) never
  drains because new messages arrive at the same rate they leave.

The agent's report often reads "previous remediation attempt failed —
escalating" or just repeats the same diagnostic the previous
invocation produced.

## Root cause

The agent is doing what it is supposed to — running on every alarm
ALARM state-change — but the *alarm* is flapping. Each ALARM →
something → ALARM transition is a new EventBridge event, and the
dedup window (5 minutes,
[index.ts:323](../../applications/self-healing/src/index.ts#L323))
is too short to suppress a flap with a longer period.

There are three flavours of this failure mode:

1. **Alarm flap.** The underlying metric oscillates around the
   threshold. Each ALARM transition is genuinely a new event from
   the agent's perspective — different `eventTime` ⇒ different dedup
   key (`alarmName#eventTime`,
   [index.ts:341](../../applications/self-healing/src/index.ts#L341)).
2. **Unfixable problem, retried regardless.** The remediation
   physically cannot succeed (e.g. permanent AMI mismatch), but the
   classification step incorrectly marks it as TRANSIENT. The
   session-memory `PREVIOUS REMEDIATION ATTEMPT (do NOT repeat the
   same actions)` block
   ([index.ts:1444-1456](../../applications/self-healing/src/index.ts#L1444-L1456))
   is being ignored or the alarm name keeps changing so memory
   lookups miss.
3. **DLQ replay storm.** A bug caused the Lambda to fail repeatedly;
   messages landed on the DLQ; the DLQ was manually reprocessed
   without first fixing the bug.

## How to diagnose

### Confirm the symptom — is the same alarm hitting repeatedly?

```
fields @timestamp, alarmName, correlationId
| filter @message like /Self-healing agent invoked/
| stats count() as invocations, earliest(@timestamp) as first, latest(@timestamp) as last by alarmName
| sort invocations desc
| limit 10
```

If a single `alarmName` shows ≥5 invocations within the last hour, you
have the flap pattern.

### Check the dedup table state

```bash
DEDUP_TABLE=$(aws ssm get-parameter \
  --name /${namePrefix}/agent-dedup-table-name \
  --query Parameter.Value --output text 2>/dev/null \
  || echo "${namePrefix}-dedup")

# Find recent dedup keys for the suspect alarm
aws dynamodb scan \
  --table-name "$DEDUP_TABLE" \
  --filter-expression "begins_with(dedupKey, :prefix)" \
  --expression-attribute-values '{":prefix":{"S":"YourAlarmName#"}}' \
  --max-items 20
```

Each row's `dedupKey` includes the `eventTime` suffix. A flapping alarm
will produce many distinct rows over the dedup window — confirming
this is mechanism (1).

### Check session memory

```bash
MEMORY_BUCKET=$(aws ssm get-parameter \
  --name /${namePrefix}/agent-memory-bucket \
  --query Parameter.Value --output text 2>/dev/null \
  || echo "${namePrefix}-memory")

# List recent sessions for the alarm
SANITISED=$(echo "your-alarm-name" \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')

aws s3 ls "s3://$MEMORY_BUCKET/sessions/${SANITISED}/" --recursive \
  | tail -20
```

If recent session files all share an identical `result:` text, the
model is recomputing the same answer because nothing about the alarm
has changed — but is still being invoked because each new `eventTime`
re-opens the dedup gate.

### Check the DLQ

```bash
DLQ_URL=$(aws ssm get-parameter \
  --name /${namePrefix}/agent-dlq-url \
  --query Parameter.Value --output text)

aws sqs get-queue-attributes \
  --queue-url "$DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages
```

Non-zero count = mechanism (3). Inspect a sample message before doing
anything else:

```bash
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 1
```

(Do not delete; messages re-appear after the visibility timeout.)

## How to fix

### For mechanism (1) — alarm flap

Fix the alarm, not the agent. The agent is correctly responding to a
broken upstream signal. Common fixes:

- Increase the alarm's evaluation period or evaluation count
  (`evaluationPeriods` / `datapointsToAlarm`) so it does not transition
  on momentary spikes.
- Tighten the metric (use a wider statistic window, e.g. p99 over 5
  minutes instead of max over 1 minute).
- Add an OK action that suppresses re-fires for a cooldown window
  (only for alarms where you accept the diagnostic latency).

While the alarm is being fixed, **disable agent processing for that
specific alarm** by adding the alarm name to the
`anything-but` exclusion list in `AlarmTriggerRule`
([agent-stack.ts AlarmTriggerRule](../../infra/lib/stacks/self-healing/agent-stack.ts)
— search for `'anything-but'`). Redeploy. This is preferable to
disabling the whole agent.

### For mechanism (2) — wrong classification

The model is calling `remediate_node_bootstrap` on a PERMANENT failure
classification. Two responses:

1. **Force `DRY_RUN=true` immediately:**
   ```bash
   aws lambda update-function-configuration \
     --function-name ${namePrefix}-agent \
     --environment "Variables={DRY_RUN=true,…}"
   ```
   This converts the next invocation into a propose-only run, breaking
   the act → fail → act loop. **You must pass the full env block** —
   `update-function-configuration` replaces, not merges. Get the
   current values first with
   `aws lambda get-function-configuration --function-name …`.
2. **Inspect the system prompt and the classification step.** The
   prompt's bootstrap diagnostic guidance enumerates PERMANENT cases
   ([index.ts:963-966](../../applications/self-healing/src/index.ts#L963-L966))
   — does the symptom match one of them? If yes, the model is ignoring
   the guidance and the prompt needs a sharper rule. If not, the
   guidance is missing a case; update the SSM parameter:
   ```bash
   PROMPT_PATH=$(aws lambda get-function-configuration \
     --function-name ${namePrefix}-agent \
     --query "Environment.Variables.SYSTEM_PROMPT_SSM_PATH" --output text)
   aws ssm get-parameter --name "$PROMPT_PATH" --with-decryption
   # Edit, then:
   aws ssm put-parameter --name "$PROMPT_PATH" --type SecureString --overwrite --value "..."
   ```
   The agent picks up the new prompt at the next cold start
   ([index.ts:271-307](../../applications/self-healing/src/index.ts#L271-L307)).

### For mechanism (3) — DLQ replay storm

Stop the replay; then handle the DLQ contents.

```bash
# Stop new invocations
aws lambda put-function-concurrency \
  --function-name ${namePrefix}-agent \
  --reserved-concurrent-executions 0

# Inspect (do not consume) a sample DLQ message
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 5

# Once the cause is understood, purge the DLQ:
aws sqs purge-queue --queue-url "$DLQ_URL"
# (Purge is destructive. Confirm you've captured anything actionable first.)

# Restore concurrency once the cause is fixed
aws lambda delete-function-concurrency \
  --function-name ${namePrefix}-agent
```

## How to prevent

- **Widen the dedup window** if your alarms have known flap behaviour.
  Set `DEDUP_WINDOW_MS` higher than the alarm's longest legitimate
  re-fire interval. Current default is 5 minutes
  ([index.ts:323](../../applications/self-healing/src/index.ts#L323));
  10-15 minutes is often more appropriate. The downside is that a
  legitimate re-fire of a different incident on the same alarm is
  suppressed longer.
- **Keep `DRY_RUN=true` in any environment where the alarm-prompt
  surface is new.** The S3 session memory is then a *log* of what the
  agent would have done, which is reviewable without consequence.
- **Maintain the bootstrap diagnostic guidance as code.** Every new
  PERMANENT failure mode that the agent misclassifies should be added
  to `buildBootstrapDiagnosticGuidance()`
  ([index.ts:931-985](../../applications/self-healing/src/index.ts#L931-L985))
  with the explicit "do NOT retry; report to operator" instruction.
  The prompt-as-code pattern keeps the guidance versioned with the
  agent.
- **Alarm on the outcome metric.** The outcome-tracker emits
  `RemediationFailure=0` when an alarm resolves with no recent agent
  invocation
  ([applications/self-healing/src/outcome-tracker.ts](../../applications/self-healing/src/outcome-tracker.ts)).
  A dashboard on `RemediationSuccess` vs `RemediationFailure` will
  surface a flapping alarm long before it eats the token budget.

<!--
Evidence trail (auto-generated):
- Source: applications/self-healing/src/index.ts (read in full on 2026-05-27)
- Source: applications/self-healing/src/outcome-tracker.ts (lines 1-40 on 2026-05-27)
- Source: infra/lib/stacks/self-healing/agent-stack.ts (lines 280-580, 697-770 on 2026-05-27)
- SSM parameter paths confirmed at agent-stack.ts:697-725
-->
