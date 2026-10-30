# Conditional issue transitions

A custom runner controller can call `POST /issues/{issueId}/transition` with its
agent API key and the usual work-item edit permission:

```json
{
  "columnId": 12,
  "expectedColumnId": 11,
  "runId": 42,
  "attempt": 1,
  "phase": "worker"
}
```

Keep `expectedColumnId` from the original observation across retries. Do not replace it
with a freshly read column after a conflict. The issue and target column must belong to
the run's project, and the authenticated agent must own that run.

The database locks the issue and run before checking the attempt and column. A worker
transition requires a pending run with a live execution lease. A `review` transition
requires the latest run for the issue to have succeeded. Both phases refuse a result
superseded by a newer run. The controller must separately authorize its reviewer;
`phase: "review"` is a run precondition, not proof of operator approval.

A successful request returns the issue DTO with HTTP 200. Repeating a request whose
target is already present also returns 200, but still checks the run and attempt. An
invalid or expired attempt returns 404. A changed expected column, superseded result,
or non-successful review run returns 409. Permission and validation errors use the
usual API responses. Controllers must handle conflicts without an unconditional PATCH
fallback. A server without this route returns 404 and cannot provide this guarantee.

This protects a conditional column write, not a whole workflow transaction. Comments,
run settlement and issue automation remain separate effects. There is no issue revision
counter: moving away from and back to the same expected column is not distinguished.
