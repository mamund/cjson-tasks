# M4: Standalone TaskList CLI

The CLI uses HTTP exclusively and has no dependency on cJSON or the TaskList server modules. It requires Node.js 20+.

## Installation

Copy `client/cli.mjs` and `client/http-client.mjs` into the existing TaskList repository. Run:

```sh
node client/cli.mjs --help
```

Optionally add `"bin": { "tasklist": "./client/cli.mjs" }` to `package.json` and run `npm link` to expose the `tasklist` executable locally.

## Usage

Start the Web API separately with `npm start`. The CLI defaults to `http://127.0.0.1:3000`. Override it using `--server URL` or `TASKLIST_SERVER`.

```sh
node client/cli.mjs users create --id U100 --name Alice --budget 20
node client/cli.mjs tasks create --id T100 --title 'Review proposal' --hours 4
node client/cli.mjs tasks assign T100 U100 --idempotency-key assign-T100-U100
node client/cli.mjs users show U100
node client/cli.mjs tasks complete T100
node client/cli.mjs activities list
node client/cli.mjs activities show ACTIVITY_ID
node client/cli.mjs activities compensate ACTIVITY_ID
node client/cli.mjs --output json tasks show T100
```

The CLI supports `tasks reassign`, `tasks unassign`, `tasks update`, `tasks delete`, `tasks history`, `users list/show/update/delete/history`, and `operations show`. Run `--help` for complete syntax.

## Exit codes and output

- `0`: successful HTTP response
- `1`: HTTP error or network failure; Problem Details message on stderr
- `2`: invalid CLI invocation

`--output json` prints the response body as JSON. Default text output pretty-prints JSON. HTTP 204 returns `null` in JSON mode.

## Tests

Copy `tests/cli.test.mjs` into the existing repository and run `npm test`. These tests start an in-process HTTP server and drive it only through the CLI's HTTP client. They do not bypass the API to change task or user data.

## Scope

This is an initial M4 checkpoint. The server does not currently expose an HTTP reconciliation endpoint, so the CLI cannot initiate recovery. Exposing reconciliation safely requires an explicit administrative API decision. The CLI currently sends an idempotency key when requested; automatic retry policy is deferred.
