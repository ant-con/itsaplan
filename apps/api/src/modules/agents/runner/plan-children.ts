import { createHash } from 'node:crypto';
import {
  db,
  agentRun,
  issue,
  project,
  projectColumn,
  runnerPlanChild,
  issueStatus,
  type DbExecutor,
} from '@repo/db';
import { and, eq, sql, getTableColumns } from 'drizzle-orm';
import type { Static } from 'elysia';
import { HttpError } from '#shared/lib';
import { recordActivityEntries } from '#modules/issues/activity';
import { planChildBody } from './model';
import { assertRunnerDrained, readClaimedRun, takeNextRun, type RunnerAgent } from './service';

type ChildInput = Static<typeof planChildBody>;

export async function runnerRunProject(runId: number): Promise<number | null> {
  const [run] = await db
    .select({ projectId: agentRun.projectId })
    .from(agentRun)
    .where(eq(agentRun.id, runId));
  return run?.projectId ?? null;
}

async function lockedParent(tx: DbExecutor, agent: RunnerAgent, runId: number, attempt: number) {
  const [ref] = await tx
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), eq(agentRun.agentId, agent.id)));
  if (!ref?.issueId) throw new HttpError(404, 'Current parent attempt not found');
  const [owner] = await tx
    .select()
    .from(project)
    .where(eq(project.id, ref.projectId))
    .for('update');
  const [parent] = await tx.select().from(issue).where(eq(issue.id, ref.issueId)).for('update');
  const [run] = await tx
    .select({
      ...getTableColumns(agentRun),
      live: sql<boolean>`${agentRun.nextAttemptAt} > clock_timestamp()`,
    })
    .from(agentRun)
    .where(eq(agentRun.id, runId))
    .for('update');
  if (
    !owner ||
    owner.teamId !== agent.teamId ||
    !parent ||
    parent.projectId !== owner.id ||
    !run ||
    run.agentId !== agent.id ||
    run.issueId !== parent.id ||
    run.projectId !== owner.id ||
    run.attempts !== attempt ||
    run.status !== 'pending' ||
    !run.executionStartedAt ||
    !run.live
  )
    throw new HttpError(404, 'Current parent attempt not found');
  const [newer] = await tx
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(and(eq(agentRun.issueId, parent.id), sql`${agentRun.id} > ${runId}`))
    .limit(1);
  if (newer) throw new HttpError(409, 'A newer issue run superseded this parent');
  if (parent.parentId !== null || parent.archivedAt)
    throw new HttpError(409, 'Parent must be an active root issue');
  return { parent, owner };
}

export async function createPlanChild(agent: RunnerAgent, runId: number, input: ChildInput) {
  assertRunnerDrained(agent);
  const { attempt, operationId, ...spec } = input;
  const inputHash = createHash('sha256')
    .update(
      JSON.stringify({
        expectedParentColumnId: spec.expectedParentColumnId,
        columnId: spec.columnId,
        title: spec.title,
        specification: spec.specification,
        acceptanceCriteria: spec.acceptanceCriteria,
        role: spec.role,
        budgetSeconds: spec.budgetSeconds,
        comparisonTarget: spec.comparisonTarget ?? null,
      }),
    )
    .digest('hex');
  return db.transaction(async (tx) => {
    const { parent, owner } = await lockedParent(tx, agent, runId, attempt);
    const [prior] = await tx
      .select()
      .from(runnerPlanChild)
      .where(
        and(
          eq(runnerPlanChild.parentIssueId, parent.id),
          eq(runnerPlanChild.operationId, operationId),
        ),
      );
    if (prior) {
      if (prior.agentId !== agent.id || prior.inputHash !== inputHash)
        throw new HttpError(409, 'Child operation payload changed');
      if (prior.childIssueId === null || prior.childRunId === null)
        throw new HttpError(409, 'Child operation was deleted; operator repair required');
      const [child] = await tx.select().from(issue).where(eq(issue.id, prior.childIssueId));
      const [childRun] = await tx.select().from(agentRun).where(eq(agentRun.id, prior.childRunId));
      if (
        !child ||
        child.parentId !== parent.id ||
        child.projectId !== owner.id ||
        childRun?.issueId !== child.id ||
        childRun.agentId !== agent.id
      )
        throw new HttpError(409, 'Child operation identity changed');
      return {
        issueId: child.id,
        runId: childRun.id,
        identifier: `${owner.key}-${child.sequenceNumber}`,
      };
    }
    if (parent.columnId !== spec.expectedParentColumnId)
      throw new HttpError(409, 'Parent column changed');
    const [quota] = await tx
      .select({
        count: sql<number>`count(*)::int`,
        budget: sql<number>`coalesce(sum(${runnerPlanChild.budgetSeconds}),0)::int`,
      })
      .from(runnerPlanChild)
      .where(eq(runnerPlanChild.parentRunId, runId));
    if (quota.count >= 6 || quota.budget + spec.budgetSeconds > 1800)
      throw new HttpError(409, 'Parent plan limit exceeded');
    const [column] = await tx
      .select()
      .from(projectColumn)
      .where(and(eq(projectColumn.id, spec.columnId), eq(projectColumn.projectId, owner.id)))
      .for('update');
    if (!column || !['backlog', 'unstarted'].includes(column.stateType))
      throw new HttpError(400, 'Child requires a backlog or unstarted column in this project');
    if (column.wipLimit !== null) {
      const [occupancy] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(issue)
        .where(and(eq(issue.columnId, column.id), sql`${issue.archivedAt} IS NULL`));
      if (occupancy.count >= column.wipLimit)
        throw new HttpError(409, 'Child column WIP limit reached');
    }
    const description = `${spec.specification}\n\nAcceptance criteria:\n${spec.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nRole: ${spec.role}\nBudget: ${spec.budgetSeconds} seconds${spec.comparisonTarget ? `\nComparison target: ${spec.comparisonTarget}` : ''}`;
    await tx
      .update(project)
      .set({ nextSequence: owner.nextSequence + 1 })
      .where(eq(project.id, owner.id));
    const [position] = await tx
      .select({ value: sql<number>`coalesce(max(${issue.position}),0)+1000` })
      .from(issue)
      .where(eq(issue.columnId, column.id));
    const [child] = await tx
      .insert(issue)
      .values({
        projectId: owner.id,
        sequenceNumber: owner.nextSequence,
        columnId: column.id,
        parentId: parent.id,
        title: spec.title,
        description,
        delegateUserId: agent.userId,
        position: Number(position.value),
      })
      .returning();
    const [childRun] = await tx
      .insert(agentRun)
      .values({
        agentId: agent.id,
        projectId: owner.id,
        issueId: child.id,
        trigger: 'delegation',
        prompt: description,
      })
      .returning();
    await tx.insert(issueStatus).values({
      issueId: child.id,
      columnId: column.id,
      columnName: column.name,
      stateType: column.stateType,
      enteredAt: child.createdAt,
    });
    await recordActivityEntries(
      [
        { issueId: child.id, event: { action: 'created' } },
        {
          issueId: child.id,
          event: {
            action: 'parent',
            to: { id: parent.id, value: `${owner.key}-${parent.sequenceNumber}` },
          },
        },
        {
          issueId: parent.id,
          event: {
            action: 'subtask_add',
            to: { id: child.id, value: `${owner.key}-${child.sequenceNumber}` },
          },
        },
      ],
      agent.userId,
      tx,
    );
    await tx.insert(runnerPlanChild).values({
      parentIssueId: parent.id,
      operationId,
      parentRunId: runId,
      agentId: agent.id,
      inputHash,
      budgetSeconds: spec.budgetSeconds,
      childIssueId: child.id,
      childRunId: childRun.id,
    });
    const [lease] = await tx
      .select({ live: sql<boolean>`${agentRun.nextAttemptAt} > clock_timestamp()` })
      .from(agentRun)
      .where(eq(agentRun.id, runId));
    if (!lease.live) throw new HttpError(404, 'Parent lease expired');
    return {
      issueId: child.id,
      runId: childRun.id,
      identifier: `${owner.key}-${child.sequenceNumber}`,
    };
  });
}

async function mappedChild(
  tx: DbExecutor,
  agent: RunnerAgent,
  parentIssueId: number,
  operationId: string,
) {
  const [child] = await tx
    .select()
    .from(runnerPlanChild)
    .where(
      and(
        eq(runnerPlanChild.parentIssueId, parentIssueId),
        eq(runnerPlanChild.operationId, operationId),
        eq(runnerPlanChild.agentId, agent.id),
      ),
    );
  return child;
}

// A claim retried by the same parent attempt gets the run it already claimed, so a lost
// response or a crash before the runner saved the claim does not strand the child. A
// child run that is not due yet (claimed by another attempt, or deferred) answers
// retryLater; its lease expiry makes it claimable again.
export async function claimPlanChild(
  agent: RunnerAgent,
  runId: number,
  operationId: string,
  attempt: number,
) {
  assertRunnerDrained(agent);
  const decision = await db.transaction(async (tx) => {
    const { parent } = await lockedParent(tx, agent, runId, attempt);
    const child = await mappedChild(tx, agent, parent.id, operationId);
    if (!child?.childRunId) throw new HttpError(404, 'Child operation not found');
    const [run] = await tx
      .select({
        ...getTableColumns(agentRun),
        due: sql<boolean>`${agentRun.nextAttemptAt} <= now()`,
        live: sql<boolean>`${agentRun.nextAttemptAt} > clock_timestamp()`,
      })
      .from(agentRun)
      .where(eq(agentRun.id, child.childRunId))
      .for('update');
    if (!run || run.status !== 'pending') throw new HttpError(409, 'Child run already ended');
    if (
      child.claimParentRunId === runId &&
      child.claimParentAttempt === attempt &&
      child.claimChildAttempt === run.attempts &&
      run.executionStartedAt &&
      run.live
    )
      return { serve: run.id };
    return run.due ? { take: run.id } : {};
  });
  if (decision.serve)
    return { run: await readClaimedRun(agent, decision.serve), retryLater: false };
  if (!decision.take) return { run: null, retryLater: true };
  const run = await takeNextRun(agent, decision.take, { runId, attempt });
  if (!run) return { run: null, retryLater: true };
  await db
    .update(runnerPlanChild)
    .set({ claimParentRunId: runId, claimParentAttempt: attempt, claimChildAttempt: run.attempts })
    .where(eq(runnerPlanChild.childRunId, run.id));
  return { run, retryLater: false };
}

// Ends the mapped child run when the parent plan blocks the step or stops. Safe to repeat:
// a run that already ended is reported as finished, and an operation that never created
// a child as none.
export async function cancelPlanChild(
  agent: RunnerAgent,
  runId: number,
  operationId: string,
  attempt: number,
) {
  assertRunnerDrained(agent);
  return db.transaction(async (tx) => {
    const { parent } = await lockedParent(tx, agent, runId, attempt);
    const child = await mappedChild(tx, agent, parent.id, operationId);
    if (!child?.childRunId) return { status: 'none' as const };
    const ended = await tx
      .update(agentRun)
      .set({
        status: 'canceled',
        executionStartedAt: null,
        lastError: 'Canceled by its parent plan',
        finishedAt: new Date(),
      })
      .where(and(eq(agentRun.id, child.childRunId), eq(agentRun.status, 'pending')))
      .returning({ id: agentRun.id });
    return { status: ended.length > 0 ? ('canceled' as const) : ('finished' as const) };
  });
}
