import { beforeEach, describe, expect, it } from 'bun:test';
import { authedApi, apiKeyApi, createProject } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { db, agentRun } from '@repo/db';
import { eq, sql } from 'drizzle-orm';
import { resetDb } from '#tests/helpers/db';
import { createAgent } from '#tests/helpers/agents';

async function setup() {
  const owner = authedApi((await signUpTestUser()).cookie);
  await createProject(owner, { key: 'CAS', name: 'Transitions' });
  const project = (await owner.projects({ projectKey: 'CAS' }).get()).data!;
  const created = (
    await createAgent(owner, 'CAS', {
      name: 'Runner',
      username: 'runner',
      kind: 'external',
      triggerOnMention: true,
    })
  ).data!;
  const runner = apiKeyApi(created.apiKey!);
  const issue = (
    await owner
      .projects({ projectKey: 'CAS' })
      .issues.post({ title: 'Transition', columnId: project.columns[0].id })
  ).data!;
  await owner.issues({ issueId: issue.id }).comments.post({ body: '@runner inspect' });
  const run = (await runner['agent-runs'].claim.post()).data!.run!;
  const body = {
    columnId: project.columns[1].id,
    expectedColumnId: project.columns[0].id,
    runId: run.id,
    attempt: run.attempts,
    phase: 'worker' as const,
  };
  return { owner, runner, issue, run, project, body };
}

describe('atomic runner issue transitions', () => {
  beforeEach(resetDb);

  it('moves a live owned attempt, and safely repeats a lost-response request', async () => {
    const { runner, issue, body } = await setup();
    const route = runner.issues({ issueId: issue.id }).transition;
    expect((await route.post(body)).status).toBe(200);
    expect((await route.post(body)).status).toBe(200);
    expect((await runner.issues({ issueId: issue.id }).get()).data!.columnId).toBe(body.columnId);
  });

  it('does not overwrite a column changed since the client read it', async () => {
    const { owner, runner, issue, body, project } = await setup();
    const manual = project.columns[2].id;
    expect((await owner.issues({ issueId: issue.id }).patch({ columnId: manual })).status).toBe(
      200,
    );
    expect((await runner.issues({ issueId: issue.id }).transition.post(body)).status).toBe(409);
    expect((await owner.issues({ issueId: issue.id }).get()).data!.columnId).toBe(manual);
  });

  it('serializes competing requests with the same expected column', async () => {
    const { runner, owner, issue, body, project } = await setup();
    const route = runner.issues({ issueId: issue.id }).transition;
    const results = await Promise.all([
      route.post(body),
      route.post({ ...body, columnId: project.columns[2].id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect([body.columnId, project.columns[2].id]).toContain(
      (await owner.issues({ issueId: issue.id }).get()).data!.columnId,
    );
  });

  it('refuses a stale attempt even when its target column is already present', async () => {
    const { runner, issue, body } = await setup();
    const route = runner.issues({ issueId: issue.id }).transition;
    expect((await route.post(body)).status).toBe(200);
    expect((await route.post({ ...body, attempt: body.attempt + 1 })).status).toBe(404);
  });

  it('requires terminal success for review and refuses worker transitions after settlement', async () => {
    const { runner, issue, body, run, project } = await setup();
    const route = runner.issues({ issueId: issue.id }).transition;
    expect((await route.post({ ...body, phase: 'review' })).status).toBe(409);
    expect(
      (
        await runner['agent-runs']({ runId: run.id }).result.post({
          attempt: run.attempts,
          status: 'success',
        })
      ).status,
    ).toBe(204);
    expect((await route.post(body)).status).toBe(404);
    expect((await route.post({ ...body, phase: 'review' })).status).toBe(200);
    expect(
      (
        await route.post({
          ...body,
          phase: 'review',
          expectedColumnId: body.columnId,
          columnId: project.columns[2].id,
        })
      ).status,
    ).toBe(200);
  });

  it('refuses a different agent and a run belonging to a different issue', async () => {
    const { owner, runner, issue, body, project } = await setup();
    const other = (
      await createAgent(owner, 'CAS', { name: 'Other', username: 'other', kind: 'external' })
    ).data!;
    expect(
      (await apiKeyApi(other.apiKey!).issues({ issueId: issue.id }).transition.post(body)).status,
    ).toBe(404);
    const second = (
      await owner
        .projects({ projectKey: 'CAS' })
        .issues.post({ title: 'Unrelated', columnId: project.columns[0].id })
    ).data!;
    expect((await runner.issues({ issueId: second.id }).transition.post(body)).status).toBe(404);
  });

  it('rejects an expired lease and a reclaimed prior attempt', async () => {
    const { runner, issue, body, run } = await setup();
    await db
      .update(agentRun)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(eq(agentRun.id, run.id));
    const route = runner.issues({ issueId: issue.id }).transition;
    expect((await route.post(body)).status).toBe(404);
    const reclaimed = (await runner['agent-runs'].claim.post()).data!.run!;
    expect(reclaimed.attempts).toBe(run.attempts + 1);
    expect((await route.post(body)).status).toBe(404);
    expect((await route.post({ ...body, attempt: reclaimed.attempts })).status).toBe(200);
  });

  it('refuses reviewing an older result after another run exists', async () => {
    const { runner, owner, issue, body, run } = await setup();
    await runner['agent-runs']({ runId: run.id }).result.post({
      attempt: run.attempts,
      status: 'success',
    });
    await owner.issues({ issueId: issue.id }).comments.post({ body: '@runner do another pass' });
    expect(
      (await runner.issues({ issueId: issue.id }).transition.post({ ...body, phase: 'review' }))
        .status,
    ).toBe(409);
  });

  it('refuses non-members and target columns from another project', async () => {
    const { owner, runner, issue, body } = await setup();
    await createProject(owner, { key: 'OTHER', name: 'Other project' });
    const other = (await owner.projects({ projectKey: 'OTHER' }).get()).data!;
    expect(
      (
        await runner
          .issues({ issueId: issue.id })
          .transition.post({ ...body, columnId: other.columns[0].id })
      ).status,
    ).toBe(400);
    const outsider = authedApi((await signUpTestUser()).cookie);
    expect((await outsider.issues({ issueId: issue.id }).transition.post(body)).status).toBe(403);
    expect((await owner.issues({ issueId: issue.id }).get()).data!.columnId).toBe(
      body.expectedColumnId,
    );
  });

  it('requires every fence field and validates positive IDs', async () => {
    const { runner, issue, body } = await setup();
    const route = runner.issues({ issueId: issue.id }).transition;
    const missingFence: Partial<typeof body> = { ...body };
    delete missingFence.expectedColumnId;
    expect((await route.post(missingFence as typeof body)).status).toBe(400);
    expect((await route.post({ ...body, runId: 2147483648 })).status).toBe(400);
    expect((await route.post({ ...body, attempt: 0 })).status).toBe(400);
    expect((await route.post({ ...body, expectedColumnId: 0 })).status).toBe(400);
  });
});
