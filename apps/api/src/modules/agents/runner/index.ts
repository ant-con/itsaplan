import { Elysia, t } from 'elysia';
import { noContent } from '#shared/http';
import { HttpError } from '#shared/lib';
import { commonErrors, errors } from '#shared/responses';
import { runnerAuth } from '../runner-auth';
import {
  ClaimResponse,
  heartbeatBody,
  resultBody,
  runParams,
  runEventsBody,
  RunEventsAck,
} from './model';
import { claimRunnerRun, finishRun, heartbeatRun } from './service';
import { entityGuard } from '#shared/guards';
import { assertPermission } from '#shared/access';
import {
  createPlanChild,
  claimPlanChild,
  cancelPlanChild,
  runnerRunProject,
} from './plan-children';
import {
  planChildBody,
  PlanChildResponse,
  planChildParams,
  childClaimBody,
  ChildClaimResponse,
  ChildCancelResponse,
} from './model';
import { appendRunEvents } from './run-events';

// The queue an external agent's runner drains, authenticated with the agent's own
// API key.
export const agentRunnerRoutes = new Elysia({
  name: 'agent-runner',
  detail: { tags: ['Agent Runner'] },
})
  .use(runnerAuth)
  .macro({
    planParent: entityGuard(
      'work_items',
      'Parent run not found',
      (p) => runnerRunProject(Number(p.runId)),
      'subtasks',
    ),
  })
  .post(
    '/agent-runs/:runId/children',
    ({ agent, params, body }) => createPlanChild(agent, params.runId, body),
    {
      runnerAgent: true,
      planParent: 'create',
      params: runParams,
      body: planChildBody,
      beforeHandle: async ({ projectId, agent }) => {
        await assertPermission(projectId, { id: agent.userId }, 'work_items', 'edit');
      },
      response: { 200: PlanChildResponse, ...commonErrors, ...errors(409) },
      detail: { summary: 'Create and queue an idempotent planned child' },
    },
  )
  .post(
    '/agent-runs/:runId/children/:operationId/claim',
    ({ agent, params, body }) =>
      claimPlanChild(agent, params.runId, params.operationId, body.attempt),
    {
      runnerAgent: true,
      planParent: 'edit',
      params: planChildParams,
      body: childClaimBody,
      response: { 200: ChildClaimResponse, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Claim only the mapped child of a live parent attempt',
        description:
          'A retry by the same parent attempt returns the run it already claimed. ' +
          'run: null with retryLater: true when the child run is not due yet. 409 when it ended.',
      },
    },
  )
  .post(
    '/agent-runs/:runId/children/:operationId/cancel',
    ({ agent, params, body }) =>
      cancelPlanChild(agent, params.runId, params.operationId, body.attempt),
    {
      runnerAgent: true,
      planParent: 'edit',
      params: planChildParams,
      body: childClaimBody,
      response: { 200: ChildCancelResponse, ...commonErrors },
      detail: { summary: 'Cancel the mapped child run of a live parent attempt' },
    },
  )

  .post('/agent-runs/claim', async ({ agent }) => ({ run: await claimRunnerRun(agent) }), {
    runnerAgent: true,
    response: { 200: ClaimResponse, ...errors(401, 403, 409) },
    detail: {
      summary: 'Claim the next run',
      description:
        "Take the calling agent's next queued run, or run: null when it has none. It is " +
        'leased: report a result or send heartbeats, otherwise it is handed out again. ' +
        '409 for an agent with an invocation URL, whose runs are sent to that URL.',
    },
  })

  .post(
    '/agent-runs/:runId/heartbeat',
    async ({ agent, params, body }) => {
      const ok = await heartbeatRun(agent.id, params.runId, body?.attempt);
      if (!ok) throw new HttpError(404, 'Run not found');
      return noContent();
    },
    {
      runnerAgent: true,
      params: runParams,
      body: heartbeatBody,
      response: { 204: t.Void(), ...commonErrors },
      detail: {
        summary: 'Extend a run lease',
        description: 'Keep a claimed run leased while the runner is still working on it.',
      },
    },
  )

  .post(
    '/agent-runs/:runId/events',
    ({ agent, params, body }) => appendRunEvents(agent.id, params.runId, body),
    {
      runnerAgent: true,
      params: runParams,
      body: runEventsBody,
      response: { 200: RunEventsAck, ...commonErrors, ...errors(409) },
      detail: {
        summary: 'Append external run events',
        description:
          'Ordered, idempotent event batches for the current leased attempt. Session ids name local Codex threads.',
      },
    },
  )

  .post(
    '/agent-runs/:runId/result',
    async ({ agent, params, body }) => {
      const ok = await finishRun(agent, params.runId, body);
      if (!ok) throw new HttpError(404, 'Run not found');
      return noContent();
    },
    {
      runnerAgent: true,
      params: runParams,
      body: resultBody,
      response: { 204: t.Void(), ...commonErrors },
      detail: {
        summary: 'Report a run result',
        description: 'Finish a claimed run as success or failed. A failure is not retried.',
      },
    },
  );
