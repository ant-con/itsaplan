import { beforeEach, describe, expect, it } from 'bun:test';
import { authedApi, apiKeyApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { createAgent } from '#tests/helpers/agents';
import { resetDb } from '#tests/helpers/db';
import { db, agentRun, issue, runnerPlanChild, issueStatus } from '@repo/db';
import { eq, sql } from 'drizzle-orm';

async function setup() {
  const owner = authedApi((await signUpTestUser()).cookie);
  await createProject(owner, { key: 'PLAN', name: 'Plan' });
  const project = (await owner.projects({ projectKey: 'PLAN' }).get()).data!;
  const created = (
    await createAgent(owner, 'PLAN', {
      name: 'Planner',
      username: 'planner',
      kind: 'external',
      triggerOnMention: true,
    })
  ).data!;
  const runner = apiKeyApi(created.apiKey!);
  const parent = (
    await owner
      .projects({ projectKey: 'PLAN' })
      .issues.post({ title: 'Compare backends', columnId: project.columns[0].id })
  ).data!;
  await owner.issues({ issueId: parent.id }).comments.post({ body: '@planner compare' });
  const run = (await runner['agent-runs'].claim.post()).data!.run!;
  const body = {
    attempt: run.attempts,
    operationId: 'a'.repeat(64),
    expectedParentColumnId: parent.columnId,
    columnId: parent.columnId,
    title: 'Backend A',
    specification: 'Execute the comparison corpus.',
    acceptanceCriteria: ['Save actual outputs and scores'],
    role: 'experiment' as const,
    budgetSeconds: 300,
    comparisonTarget: 'A',
  };
  return {
    owner,
    runner,
    parent,
    project,
    run,
    body,
    route: runner['agent-runs']({ runId: run.id }).children,
  };
}

describe('runner planned children', () => {
  beforeEach(resetDb);
  it('creates exactly one child and queued run on concurrent retry, with status history', async () => {
    const { route, body, parent } = await setup();
    const responses = await Promise.all([route.post(body), route.post(body)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].data).toEqual(responses[1].data);
    const child = (await db.select().from(issue).where(eq(issue.parentId, parent.id)))[0];
    expect(child.title).toBe('Backend A');
    expect(await db.select().from(runnerPlanChild)).toHaveLength(1);
    expect(await db.select().from(agentRun).where(eq(agentRun.issueId, child.id))).toHaveLength(1);
    expect(
      await db.select().from(issueStatus).where(eq(issueStatus.issueId, child.id)),
    ).toHaveLength(1);
    expect((await route.post({ ...body, title: 'Changed' })).status).toBe(409);
  });
  it('claims the mapped child without taking an unrelated queued run', async () => {
    const { owner, runner, project, run, route, body } = await setup();
    const unrelated = (
      await owner
        .projects({ projectKey: 'PLAN' })
        .issues.post({ title: 'Unrelated', columnId: project.columns[0].id })
    ).data!;
    await owner.issues({ issueId: unrelated.id }).comments.post({ body: '@planner unrelated' });
    const child = (await route.post(body)).data!;
    const claim = await runner['agent-runs']({ runId: run.id })
      .children({ operationId: body.operationId })
      .claim.post({ attempt: run.attempts });
    expect(claim.status).toBe(200);
    expect(claim.data!.run!.id).toBe(child.runId);
    expect(claim.data!.run!.issueId).toBe(child.issueId);
    expect((await runner['agent-runs'].claim.post()).data!.run!.issueId).toBe(unrelated.id);
  });
  it('refuses expired and stale parent attempts on creation and claim', async () => {
    const { route, body, runner, run } = await setup();
    expect((await route.post(body)).status).toBe(200);
    expect((await route.post({ ...body, attempt: 2 })).status).toBe(404);
    await db
      .update(agentRun)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(agentRun.id, run.id));
    expect((await route.post(body)).status).toBe(404);
    expect(
      (
        await runner['agent-runs']({ runId: run.id })
          .children({ operationId: body.operationId })
          .claim.post({ attempt: 1 })
      ).status,
    ).toBe(404);
  });
  it('refuses another agent and a superseding parent run', async () => {
    const { owner, route, body, run, parent } = await setup();
    const other = (
      await createAgent(owner, 'PLAN', { name: 'Other', username: 'other', kind: 'external' })
    ).data!;
    expect(
      (await apiKeyApi(other.apiKey!)['agent-runs']({ runId: run.id }).children.post(body)).status,
    ).toBe(404);
    await owner.issues({ issueId: parent.id }).comments.post({ body: '@planner another request' });
    expect((await route.post(body)).status).toBe(409);
    expect(await db.select().from(runnerPlanChild)).toHaveLength(0);
  });
  it('retains a deleted operation as a tombstone', async () => {
    const { route, body } = await setup();
    const child = (await route.post(body)).data!;
    await db.delete(issue).where(eq(issue.id, child.issueId));
    expect((await route.post(body)).status).toBe(409);
    expect(await db.select().from(runnerPlanChild)).toHaveLength(1);
  });
  it('caps parent-wide count across requests', async () => {
    const { route, body } = await setup();
    for (let i = 0; i < 6; i++)
      expect((await route.post({ ...body, operationId: i.toString().repeat(64) })).status).toBe(
        200,
      );
    expect(
      (await route.post({ ...body, operationId: 'f'.repeat(64), budgetSeconds: 1 })).status,
    ).toBe(409);
    expect(await db.select().from(runnerPlanChild)).toHaveLength(6);
  });
  it('caps total budget below the count limit', async () => {
    const { route, body } = await setup();
    for (let i = 0; i < 3; i++)
      expect(
        (await route.post({ ...body, operationId: i.toString().repeat(64), budgetSeconds: 600 }))
          .status,
      ).toBe(200);
    expect((await route.post({ ...body, budgetSeconds: 1 })).status).toBe(409);
  });
  it('refuses changed parent state, foreign columns, nesting and terminal runs', async () => {
    const { owner, runner, route, body, parent, run, project } = await setup();
    expect(
      (await route.post({ ...body, expectedParentColumnId: project.columns[1].id })).status,
    ).toBe(409);
    await createProject(owner, { key: 'OTHER', name: 'Other' });
    const other = (await owner.projects({ projectKey: 'OTHER' }).get()).data!;
    expect((await route.post({ ...body, columnId: other.columns[0].id })).status).toBe(400);
    const child = (await route.post(body)).data!;
    await db.update(issue).set({ parentId: child.issueId }).where(eq(issue.id, parent.id));
    expect((await route.post(body)).status).toBe(409);
    await db.update(issue).set({ parentId: null }).where(eq(issue.id, parent.id));
    await runner['agent-runs']({ runId: run.id }).result.post({ attempt: 1, status: 'success' });
    expect((await route.post(body)).status).toBe(404);
  });
});
