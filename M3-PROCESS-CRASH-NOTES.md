# M3 process-level crash tests

This checkpoint adds a child-process integration harness. It starts the TaskList API with the existing `createApp` hooks, forcibly terminates the process with `SIGKILL` immediately after a cJSON forward operation or compensation commits, and starts a fresh process against the same directory.

The restarted server must block mutations until explicit reconciliation. The test then verifies the task assignment and available budget, and confirms writes resume. These are actual process terminations, rather than exceptions raised in the server.

## Run

```sh
npm test
```

## Coverage and limits

- Covers the first committed step of assignment and its first committed compensation step.
- Does not cover every step, journal-write boundary, interrupted reconciliation, ambiguous journal evidence, or power loss.
- Assumes one process owns the data directory at a time. The test terminates each child before opening the same directory in another process.
- The test uses Node's IPC solely to invoke the existing `app.reconcile()` method; it does not add an HTTP administration endpoint.

Further process-level tests should exercise all workflow step boundaries and deliberate ambiguity before closing M3.
