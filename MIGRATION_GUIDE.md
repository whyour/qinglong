# Multi-User Data Migration Guide

This document explains how to migrate existing data to the multi-user system.

## Overview

When upgrading to the multi-user version of Qinglong, all existing data (cron tasks, environment variables, subscriptions, and dependencies) will be treated as "legacy data" that is accessible to all users. 

To properly isolate data between users, you need to migrate existing data to specific user accounts.

## Migration Script

The `migrate-to-multiuser.js` script helps you assign existing legacy data to specific users.

### Prerequisites

- Node.js installed
- Sequelize and dotenv packages (already included in the project)
- At least one user created in the User Management interface

### Usage

#### 1. List All Users

First, see all available users in your system:

```bash
node migrate-to-multiuser.js --list-users
```

Output example:
```
Users in the system:
ID    Username    Role        Status
--    --------    ----        ------
1     admin       Admin       Enabled
2     user1       User        Enabled
3     user2       User        Enabled
```

#### 2. Preview Migration (Dry Run)

Before making changes, preview what will be migrated:

```bash
node migrate-to-multiuser.js --userId=1 --dry-run
```

Or by username:

```bash
node migrate-to-multiuser.js --username=admin --dry-run
```

Output example:
```
Legacy Data Statistics:
  Cron tasks: 15
  Environment variables: 8
  Subscriptions: 3
  Dependencies: 5

DRY RUN: No changes will be made.

Would assign all legacy data to user ID 1
```

#### 3. Perform Migration

Once you're ready, run the migration without `--dry-run`:

**By User ID:**
```bash
node migrate-to-multiuser.js --userId=1
```

**By Username:**
```bash
node migrate-to-multiuser.js --username=admin
```

Output example:
```
Found user 'admin' with ID 1

Legacy Data Statistics:
  Cron tasks: 15
  Environment variables: 8
  Subscriptions: 3
  Dependencies: 5

Migrating data to user ID 1...
✓ Migrated 15 cron tasks
✓ Migrated 8 environment variables
✓ Migrated 3 subscriptions
✓ Migrated 5 dependencies

✓ Migration completed successfully!
```

### Command Line Options

| Option | Description |
|--------|-------------|
| `--userId=<id>` | Assign all legacy data to user with this ID |
| `--username=<name>` | Assign all legacy data to user with this username |
| `--list-users` | List all users in the system |
| `--dry-run` | Show what would be changed without making changes |
| `--help` | Show help message |

## Migration Strategy

### Scenario 1: Single User to Multi-User

If you're upgrading from single-user to multi-user and want to keep all existing data under one admin account:

1. Create an admin user in the User Management interface
2. Run migration: `node migrate-to-multiuser.js --username=admin`

### Scenario 2: Distribute Data to Multiple Users

If you want to distribute existing data to different users:

1. Create all necessary user accounts first
2. Identify which data belongs to which user (you may need to do this manually by checking the database)
3. For each user, manually update the `userId` field in the database tables (`Crontabs`, `Envs`, `Subscriptions`, `Dependences`)

**SQL Example:**
```sql
-- Assign specific cron tasks to user ID 2
UPDATE Crontabs 
SET userId = 2 
WHERE name LIKE '%user2%' AND userId IS NULL;

-- Assign specific environment variables to user ID 2
UPDATE Envs 
SET userId = 2 
WHERE name LIKE '%USER2%' AND userId IS NULL;
```

### Scenario 3: Keep as Shared Data

If you want certain data to remain accessible to all users:

- Simply don't run the migration script
- Data with `userId = NULL` remains as "legacy data" accessible to everyone
- This is useful for shared cron tasks or environment variables

## Important Notes

1. **Backup First**: Always backup your database before running migration scripts
   ```bash
   cp data/database.sqlite data/database.sqlite.backup
   ```

2. **Test in Dry Run**: Always use `--dry-run` first to see what will change

3. **One-Time Operation**: The script only migrates data where `userId` is NULL
   - Already migrated data won't be changed
   - You can run it multiple times safely

4. **Transaction Safety**: The migration uses database transactions
   - If any error occurs, all changes are rolled back
   - Your data remains safe

5. **User Must Exist**: The target user must exist before migration
   - Create users in the User Management interface first
   - Use `--list-users` to verify users exist

## Troubleshooting

### Error: "User not found"

**Problem:** The specified user doesn't exist in the database.

**Solution:** 
1. Run `node migrate-to-multiuser.js --list-users` to see available users
2. Create the user in User Management interface if needed
3. Use correct user ID or username

### Error: "Database connection failed"

**Problem:** Cannot connect to the database.

**Solution:**
1. Check that `data/database.sqlite` exists
2. Verify database file permissions
3. Check `QL_DATA_DIR` environment variable if using custom path

### Error: "Migration failed"

**Problem:** An error occurred during migration.

**Solution:**
1. Check the error message for details
2. Verify database is not corrupted
3. Restore from backup if needed
4. Check database file permissions

## Manual Migration

If you prefer to migrate data manually using SQL:

### Connect to Database
```bash
sqlite3 data/database.sqlite
```

### Check Legacy Data
```sql
-- Count legacy cron tasks
SELECT COUNT(*) FROM Crontabs WHERE userId IS NULL;

-- View legacy cron tasks
SELECT id, name, command FROM Crontabs WHERE userId IS NULL;
```

### Migrate Data
```sql
-- Migrate all legacy data to user ID 1
UPDATE Crontabs SET userId = 1 WHERE userId IS NULL;
UPDATE Envs SET userId = 1 WHERE userId IS NULL;
UPDATE Subscriptions SET userId = 1 WHERE userId IS NULL;
UPDATE Dependences SET userId = 1 WHERE userId IS NULL;
```

### Verify Migration
```sql
-- Check if any legacy data remains
SELECT 
  (SELECT COUNT(*) FROM Crontabs WHERE userId IS NULL) as legacy_crons,
  (SELECT COUNT(*) FROM Envs WHERE userId IS NULL) as legacy_envs,
  (SELECT COUNT(*) FROM Subscriptions WHERE userId IS NULL) as legacy_subs,
  (SELECT COUNT(*) FROM Dependences WHERE userId IS NULL) as legacy_deps;
```

## Support

If you encounter issues with data migration:

1. Check this guide for solutions
2. Review the error messages carefully
3. Ensure you have a recent backup
4. Open an issue on GitHub with:
   - Error messages
   - Migration command used
   - Database statistics (from dry run)

## Related Documentation

- [MULTI_USER_GUIDE.md](./MULTI_USER_GUIDE.md) - Complete multi-user feature guide
- [README.md](./README.md) - Main project documentation
