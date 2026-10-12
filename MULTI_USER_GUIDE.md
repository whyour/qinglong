# Multi-user accounts

Administrators can create, disable and delete accounts in Settings → User Management. New administrator accounts have full access to the shared instance. Ordinary accounts can only read their assigned environment variables, task metadata and subscription metadata. They cannot execute tasks, read shared files or logs, install dependencies, or modify system settings.

Existing data with no owner remains visible only to administrators. The original administrator and its password migration, MFA and sessions are preserved. Accounts from older drafts that used bcrypt require an administrator password reset.

See [the permission contract](docs/development/multiuser-permissions.md) and [resource migration](MIGRATION_GUIDE.md). This draft does not provide isolated execution for untrusted users.
