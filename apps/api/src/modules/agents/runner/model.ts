import { t } from 'elysia';
import { agentRunTrigger, contextUsageBody, AgUiEvent } from '../model';

// The run handed to a runner (RunnerRun from the service). `prompt` is the framed
// task, `systemPrompt` the instructions about the run itself; a runner passes the
// first on stdin and the second to whatever its command calls a system prompt.
export const RunnerRunResponse = t.Object({
  id: t.Number(),
  trigger: agentRunTrigger,
  prompt: t.String(),
  systemPrompt: t.String(),
  attempts: t.Number(),
  traceEvents: t.Boolean(),
  issueId: t.Nullable(t.Number()),
  issueIdentifier: t.Nullable(t.String()),
});

// The claim result. The run is wrapped so an empty queue is an explicit null rather
// than an empty body.
export const ClaimResponse = t.Object({ run: t.Nullable(RunnerRunResponse) });

export const runParams = t.Object({ runId: t.Numeric() });

export const heartbeatBody = t.Optional(
  t.Object({ attempt: t.Optional(t.Integer({ minimum: 1 })) }),
);

export const resultBody = t.Object({
  attempt: t.Optional(t.Integer({ minimum: 1 })),
  status: t.Union([t.Literal('success'), t.Literal('failed')], {
    description: 'Whether the run completed or failed.',
  }),
  output: t.Optional(t.Nullable(t.String({ description: 'What the run produced, for history.' }))),
  error: t.Optional(t.Nullable(t.String({ description: 'Why the run failed.' }))),
  usage: contextUsageBody,
});

export const runEventsBody = t.Object({
  attempt: t.Integer({ minimum: 1 }),
  offset: t.Integer({ minimum: 0 }),
  events: t.Array(AgUiEvent, { minItems: 1, maxItems: 200 }),
  sessionId: t.Optional(t.String({ format: 'uuid' })),
});
export const RunEventsAck = t.Object({ nextOffset: t.Number(), truncated: t.Boolean() });

export const externalTraceQuery = t.Object({
  attempt: t.Optional(t.Numeric({ minimum: 1, multipleOf: 1 })),
});
export const ExternalTraceResponse = t.Nullable(
  t.Object({
    attempt: t.Number(),
    previousAttempt: t.Nullable(t.Number()),
    sessionId: t.Nullable(t.String()),
    sessionUrl: t.Nullable(t.String()),
    truncated: t.Boolean(),
    events: t.Array(t.Object({ event: AgUiEvent, receivedAt: t.String() })),
  }),
);

export const planChildBody = t.Object({
  attempt: t.Integer({ minimum: 1 }),
  operationId: t.String({ pattern: '^[a-f0-9]{64}$' }),
  expectedParentColumnId: t.Integer({ minimum: 1 }),
  columnId: t.Integer({ minimum: 1 }),
  title: t.String({ minLength: 1, maxLength: 200 }),
  specification: t.String({ minLength: 1, maxLength: 7000 }),
  acceptanceCriteria: t.Array(t.String({ minLength: 1, maxLength: 500 }), {
    minItems: 1,
    maxItems: 8,
  }),
  role: t.Union([
    t.Literal('research'),
    t.Literal('experiment'),
    t.Literal('evaluation'),
    t.Literal('synthesis'),
  ]),
  budgetSeconds: t.Integer({ minimum: 1, maximum: 600 }),
  comparisonTarget: t.Optional(t.String({ minLength: 1, maxLength: 80 })),
});
export const PlanChildResponse = t.Object({
  issueId: t.Number(),
  runId: t.Number(),
  identifier: t.String(),
});
export const planChildParams = t.Object({
  runId: t.Numeric({ minimum: 1 }),
  operationId: t.String({ pattern: '^[a-f0-9]{64}$' }),
});
export const childClaimBody = t.Object({ attempt: t.Integer({ minimum: 1 }) });
export const ChildClaimResponse = t.Object({
  run: t.Nullable(RunnerRunResponse),
  retryLater: t.Boolean(),
});
export const ChildCancelResponse = t.Object({
  status: t.Union([t.Literal('canceled'), t.Literal('finished'), t.Literal('none')]),
});
