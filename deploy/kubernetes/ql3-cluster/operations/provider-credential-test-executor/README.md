# Model provider credential test executor

This is a caller-created, one-shot Job. Create the durable test plan through
`provider-credential.test.plan`, copy its `testId` into a fresh command, use a
fresh `executionId`, and instantiate a new Job name from the template.

The base admits only DNS. Production activation requires both the reviewed
PostgreSQL overlay and a deployment-specific private provider CIDR patch.
The application independently enforces the exact canonical HTTPS URL and
zero-retry/zero-cost budgets from the same allowlist mounted by the manager.
If the provider uses a private CA, also apply the public-only provider CA patch;
it adds `NODE_EXTRA_CA_CERTS` and a read-only CA projection without mounting a
client key or any provider credential.

The long-lived provider credential manager never mounts provider Secret
material and never receives provider egress. Only this Job mounts the one
project-scoped material file selected by the durable binding. An existing
execution intent is never sent to the provider again: the Job returns either
the durable result or `outcome_unknown`.
