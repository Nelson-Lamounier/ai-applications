---
name: self-healing-updater
description: Encodes manual Kubernetes cluster troubleshooting into the self-healing AI agent. Use this whenever you've just fixed a cluster issue by hand and want the agent to handle it automatically next time, when an agent report email shows a diagnostic gap or missed remediation step, or when you want to add a new tool, event trigger, or alarm to the agent's capabilities. Accepts raw logs, kubectl output, CloudWatch excerpts, SSM run summaries, natural language descriptions of what you did, and pasted agent report emails. Applies changes across all four agent layers (system prompt, per-event prompts, tool registry, infrastructure) and deploys end-to-end.
---

# Self-Healing Agent Updater

You are updating a production Bedrock-powered self-healing agent for a solo-operated AWS/Kubernetes portfolio. The agent diagnoses and remediates cluster failures automatically. Your job is to encode what the operator just learned from a manual troubleshooting session.

## Project Layout

```
ai-applications/
├── applications/self-healing/src/
│   ├── index.ts                         ← agent handler: buildPrompt(), getDefaultTools()
│   ├── handler.test.ts                  ← unit tests
│   └── tools/
│       ├── diagnose-alarm/index.ts
│       ├── check-node-health/index.ts
│       ├── analyse-cluster-health/index.ts
│       ├── get-node-diagnostic-json/index.ts
│       ├── inspect-workloads/index.ts
│       └── remediate-node-bootstrap/index.ts
└── infra/lib/
    ├── config/self-healing/
    │   └── configurations.ts            ← DEFAULT_SYSTEM_PROMPT lives here
    └── stacks/self-healing/
        ├── gateway-stack.ts             ← Lambda tools + MCP registration
        └── agent-stack.ts              ← EventBridge rules / alarm triggers
```

Working directories:
- **Infra**: `/Users/nelsonlamounier/Desktop/portfolio/ai-applications/infra`
- **App**: `/Users/nelsonlamounier/Desktop/portfolio/ai-applications/applications/self-healing`

---

## Step 1 — Gather Input

Ask the operator for (if not already provided in the conversation):

1. **What happened** — paste logs, kubectl output, CloudWatch metrics, SSM run summaries, or the agent report email
2. **What you did manually** — the sequence of commands or actions that resolved it
3. **What you want the agent to do instead** — if not obvious from the above

If the operator says "update based on this" and pastes content, proceed without further questions unless something is genuinely ambiguous.

---

## Step 2 — Classify the Gap

Map the manual fix to one or more of these layers. Be conservative — only touch layers that are clearly needed.

| Layer | Change type | Files |
|-------|------------|-------|
| **A** | System prompt — reasoning strategy, tool selection guide, guardrails | `configurations.ts` → `DEFAULT_SYSTEM_PROMPT` |
| **B** | Per-event prompt — how a specific trigger type is framed for the model | `index.ts` → `buildPrompt()` |
| **C** | Tool registry — add/modify a tool the agent knows it can call | `index.ts` → `getDefaultTools()` |
| **D** | New Lambda tool — create a real tool that the agent can invoke | new file in `tools/`, updates to `gateway-stack.ts` |
| **E** | New alarm/trigger — make a new event fire the agent | `agent-stack.ts` EventBridge rules |

Announce your classification before making any changes: "This fix maps to **Layer B + C** — updating the worker node termination prompt and adding a new tool description."

---

## Step 3 — Implement

### Layer A: System Prompt (`configurations.ts`)

File: `infra/lib/config/self-healing/configurations.ts`

The `DEFAULT_SYSTEM_PROMPT` constant (line ~59) is a multi-line array joined with `\n`. Each section serves a purpose:

- **TOOL SELECTION GUIDE** — tells the agent *when* to use each tool
- **CLUSTER-LEVEL DIAGNOSTIC WORKFLOW** — the ordered steps for diagnosing cluster events
- **MANDATORY REASONING PROTOCOL** — chain-of-thought requirement before remediation
- **Guardrails** — hard stops (never delete resources, never modify IAM)

Update by adding to or modifying the relevant section. When adding a new tool, add it to the TOOL SELECTION GUIDE. When fixing a diagnostic gap, add or refine a step in the WORKFLOW section. When the agent acted when it shouldn't have, tighten the Guardrails.

### Layer B: Per-Event Prompt (`index.ts`)

File: `applications/self-healing/src/index.ts` → `buildPrompt()` function

Event type branches:
- `source === 'aws.cloudwatch'` — CloudWatch alarm fired
- `source === 'aws.autoscaling'` with `isWorker` check — node terminated (worker vs control-plane path)
- generic fallback — other EventBridge events

Each branch returns a multi-line string with:
1. One-line context sentence ("A Kubernetes worker node has been terminated.")
2. Structured fields (ASG, Instance, Cause, Timestamp)
3. DRY_RUN note (always include — it's toggled by env var)
4. DIAGNOSTIC WORKFLOW: ordered numbered steps the agent should follow for this event type

All user-controlled string fields from the event must pass through `sanitiseEventField(value, maxLength)` before interpolation.

When updating: add a new event branch, or refine the numbered steps in an existing branch to reflect what you actually had to do manually.

### Layer C: Tool Registry (`index.ts`)

File: `applications/self-healing/src/index.ts` → `getDefaultTools()`

This is the *fallback* tool list used if the MCP Gateway is unreachable. It mirrors the tools registered in `gateway-stack.ts`. Each entry has:
```typescript
{
    name: 'snake_case_tool_name',
    description: 'What it does and when to use it.',
    inputSchema: {
        type: 'object',
        properties: { /* param: { type, description } */ },
        required: ['required_params'],
    },
}
```

When adding a new tool here, the name must match exactly what's registered in `gateway-stack.ts` (`toolSchema` → `name` field).

### Layer D: New Lambda Tool

Creating a real new tool requires changes in three places:

**1. Tool source** — create `applications/self-healing/src/tools/<tool-name>/index.ts`

Follow the existing pattern in `tools/check-node-health/index.ts`:
- Export a `handler` function
- Import only `@aws-sdk/*` clients (bundled externally)
- Use `@bedrock/shared` for logging if needed
- Return a plain object — the Gateway serialises it to JSON for the agent

**2. Gateway Lambda + registration** — `infra/lib/stacks/self-healing/gateway-stack.ts`

Add after the last tool Lambda (before the `NagSuppressions` block):

```typescript
// Tool N: <ToolName>
const <toolName>Fn = new lambdaNode.NodejsFunction(this, '<ToolName>Function', {
    functionName: `${namePrefix}-tool-<tool-kebab-name>`,
    runtime: lambda.Runtime.NODEJS_22_X,
    entry: path.join(__dirname, '..', '..', '..', '..', 'applications', 'self-healing', 'src', 'tools', '<tool-kebab-name>', 'index.ts'),
    handler: 'handler',
    memorySize: 256,
    timeout: cdk.Duration.seconds(30),   // increase for long-running SSM commands
    logGroup: new logs.LogGroup(this, '<ToolName>LogGroup', {
        logGroupName: `/aws/lambda/${namePrefix}-tool-<tool-kebab-name>`,
        retention: props.logRetention,
        removalPolicy: props.removalPolicy,
    }),
    tracing: lambda.Tracing.ACTIVE,
    description: `MCP tool: <what it does> for ${namePrefix}`,
    bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
});

// Grant only what the tool needs — follow least-privilege
<toolName>Fn.addToRolePolicy(new iam.PolicyStatement({
    sid: '<DescriptiveSid>',
    effect: iam.Effect.ALLOW,
    actions: ['<service>:<Action>'],
    resources: ['<scoped-arn-or-wildcard>'],
    // Add tag-based conditions when targeting k8s instances:
    // conditions: { StringEquals: { 'ssm:resourceTag/Project': 'kubernetes' } },
}));

NagSuppressions.addResourceSuppressions(
    <toolName>Fn,
    [{
        id: 'AwsSolutions-IAM5',
        reason: '<why wildcard is necessary>',
    }, {
        id: 'AwsSolutions-L1',
        reason: 'Using NODEJS_22_X which is the latest Node.js LTS runtime',
    }],
    true,
);
```

Then register with the Gateway (add after the last `this.gateway.addLambdaTarget` call):

```typescript
this.gateway.addLambdaTarget('<ToolName>Target', {
    gatewayTargetName: '<tool-kebab-name>',
    description: '<Short description for MCP discovery>',
    lambdaFunction: <toolName>Fn,
    toolSchema: ToolSchema.fromInline([{
        name: '<tool_snake_name>',
        description: '<Full description the agent uses to decide whether to call this tool>',
        inputSchema: {
            type: SchemaDefinitionType.OBJECT,
            properties: {
                /* params */
            },
            required: ['required_params'],
        },
        outputSchema: {
            type: SchemaDefinitionType.OBJECT,
            properties: { /* response fields */ },
        },
    }]),
});
```

**3. Add to `getDefaultTools()`** — see Layer C.

### Layer E: New Alarm Trigger (`agent-stack.ts`)

File: `infra/lib/stacks/self-healing/agent-stack.ts`

Two trigger patterns exist — add the one that fits:

**Pattern 1 — CloudWatch Alarm** (existing pattern, just add more alarm names):
Look for the `alarmRule` definition and add the new alarm name to its `alarmNames` array.

**Pattern 2 — EventBridge rule** (for non-alarm events like ASG lifecycle):
```typescript
const <eventName>Rule = new events.Rule(this, '<EventName>Rule', {
    ruleName: `${props.namePrefix}-<event-kebab>-trigger`,
    description: '<What this triggers the agent on>',
    eventPattern: {
        source: ['aws.<service>'],
        detailType: ['<Event Detail Type>'],
        detail: {
            /* filters — e.g. { AutoScalingGroupName: [{ prefix: props.k8sAsgPrefix }] } */
        },
    },
});
<eventName>Rule.addTarget(new targets.SqsQueue(this.triggerQueue, {
    messageGroupId: '<group-id>',   // serialise concurrent events of same type
}));
```

---

## Step 4 — Update Unit Tests

File: `applications/self-healing/src/handler.test.ts`

- If you added a new `buildPrompt()` event branch: add a `describe('buildPrompt — <source>', ...)` block with at least: happy path, missing-field graceful handling, and sanitisation of an injected field.
- If you changed `getDefaultTools()` tool count: update the `toHaveLength(N)` assertions in the `getDefaultTools` and `buildToolConfig` describe blocks.

Run tests from the app directory (not the monorepo root):
```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/applications/self-healing
npx jest --no-coverage 2>&1 | tail -20
```

All tests must pass before deploying.

---

## Step 5 — Deploy

**Determine deploy scope:**

| Changed | Deploy |
|---------|--------|
| Layer A or B only (prompts) | `SelfHealing-Agent-development` only |
| Layer C only (tool descriptions in handler) | `SelfHealing-Agent-development` only |
| Layer D (new Lambda) | `SelfHealing-Gateway-development` first, then `SelfHealing-Agent-development` |
| Layer E (new trigger) | `SelfHealing-Agent-development` only |

```bash
cd /Users/nelsonlamounier/Desktop/portfolio/ai-applications/infra

# If new Lambda tool was added:
npx cdk deploy SelfHealing-Gateway-development \
  -c project=self-healing -c environment=development \
  --require-approval never

# Always deploy Agent (picks up prompt/trigger/tool registry changes):
npx cdk deploy SelfHealing-Agent-development \
  -c project=self-healing -c environment=development \
  --require-approval never
```

Confirm both stacks show `✅ SelfHealing-...-development` in the output before reporting done.

---

## What Good Output Looks Like

After the deploy completes, give the operator:

1. **Classification summary** — which layers were changed and why
2. **Change summary** — bullet list of every file modified and what changed in it
3. **How to verify** — which CloudWatch alarm or event to fire to test the new behaviour, and what to look for in the agent report email
