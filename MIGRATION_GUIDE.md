# Assign existing resources to accounts

The panel adds ownership columns automatically while preserving existing data. Unassigned historical data is visible only to administrators. Ordinary users can read their assigned environment variables, task metadata and subscription metadata; dependencies and execution remain administrative operations.

Prefer the authenticated administrator endpoint `PUT /api/user-management/:id/resources` with a body such as `{"resource":"envs","ids":[1,2]}`. Supported resources are `envs`, `crons` and `subscriptions`. Assignment does not run tasks or move files.

The optional local migration helper assigns every unassigned row to one existing account. Stop the panel and back up `data/db/database.sqlite` before using it; set `QL_DIR` or `QL_DATA_DIR` when the data directory differs from the repository default. The helper refuses to create a new empty database.

```bash
node migrate-to-multiuser.js --list-users
node migrate-to-multiuser.js --username=alice --dry-run
node migrate-to-multiuser.js --username=alice
```

Already assigned rows are preserved and writes run in a transaction. Dependencies may receive an owner for bookkeeping, but remain inaccessible to ordinary users. To allocate only selected rows, use the administrator resource endpoint instead of the bulk helper.

See [the permission contract](docs/development/multiuser-permissions.md).
