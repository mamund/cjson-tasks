# TaskList API — M2 resource server

Node.js 20+ HTTP/JSON server backed by published `@mamund/comp-json-store@0.1.0`.

## Run

```sh
npm install
npm test
npm start
```

Environment variables: `PORT` (default 3000), `DATA_DIR` (default `./data`). Run only one server process per data directory. Data and journal are local; do not run multiple instances against the same directory.

## Resource endpoints implemented

- `GET /tasks`, `POST /tasks`, `GET /tasks/{id}`, `PATCH /tasks/{id}`, `DELETE /tasks/{id}`
- `GET /users`, `POST /users`, `GET /users/{id}`, `PATCH /users/{id}`, `DELETE /users/{id}`
- `GET /tasks/{id}/history`, `GET /users/{id}/history`, `GET /operations/{id}`

Create tasks with `{ "id": "T100", "title": "Review", "estimatedHours": 4 }`; create users with `{ "id": "U100", "name": "Alice", "budgetHours": 20 }`. IDs are optional and generated when absent. Task status defaults to `OPEN`, and `assignedUser` defaults to null. Query filtering supports `title`, `description`, `status`, `assignedUser` for tasks and `name` for users.

**M2 limitations:** Only title/description (tasks) and name (users) can be patched, one field per request. `estimatedHours` is immutable. `budgetHours` is protected. Assignment, reassignment, unassignment, completion, activity ledger, compensation coordination, and the standalone CLI are **M3/M4**, and return `501 Not Implemented` where routed. M2 does not claim application-level atomicity or coordinated recovery.

## Example

```sh
curl -i -X POST http://localhost:3000/users -H 'content-type: application/json' -d '{"id":"U100","name":"Alice","budgetHours":20}'
curl -i -X POST http://localhost:3000/tasks -H 'content-type: application/json' -d '{"id":"T100","title":"Review","estimatedHours":4}'
curl http://localhost:3000/tasks
```
