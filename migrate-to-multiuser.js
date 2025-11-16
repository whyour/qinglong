#!/usr/bin/env node

/**
 * Multi-User Data Migration Script
 * 
 * This script migrates existing data (Cron, Env, Subscription, Dependence) 
 * to be associated with specific users.
 * 
 * Usage:
 *   node migrate-to-multiuser.js --userId=1
 *   node migrate-to-multiuser.js --username=admin
 *   node migrate-to-multiuser.js --list-users
 * 
 * Options:
 *   --userId=<id>        Assign all legacy data to user with this ID
 *   --username=<name>    Assign all legacy data to user with this username
 *   --list-users         List all users in the system
 *   --dry-run            Show what would be changed without making changes
 *   --help               Show this help message
 */

const path = require('path');
const fs = require('fs');
const Sequelize = require('sequelize');

// Load environment variables
require('dotenv').config();

// Configuration
const config = {
  dbPath: process.env.QL_DATA_DIR || path.join(__dirname, '../data'),
  rootPath: __dirname,
};

// Initialize Sequelize
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: path.join(config.dbPath, 'database.sqlite'),
  logging: false,
});

// Define models
const UserModel = sequelize.define('User', {
  username: Sequelize.STRING,
  password: Sequelize.STRING,
  role: Sequelize.NUMBER,
  status: Sequelize.NUMBER,
});

const CrontabModel = sequelize.define('Crontab', {
  name: Sequelize.STRING,
  command: Sequelize.STRING,
  schedule: Sequelize.STRING,
  userId: Sequelize.NUMBER,
});

const EnvModel = sequelize.define('Env', {
  name: Sequelize.STRING,
  value: Sequelize.STRING,
  userId: Sequelize.NUMBER,
});

const SubscriptionModel = sequelize.define('Subscription', {
  name: Sequelize.STRING,
  url: Sequelize.STRING,
  userId: Sequelize.NUMBER,
});

const DependenceModel = sequelize.define('Dependence', {
  name: Sequelize.STRING,
  type: Sequelize.NUMBER,
  userId: Sequelize.NUMBER,
});

// Parse command line arguments
function parseArgs() {
  const args = {
    userId: null,
    username: null,
    listUsers: false,
    dryRun: false,
    help: false,
  };

  process.argv.slice(2).forEach(arg => {
    if (arg.startsWith('--userId=')) {
      args.userId = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--username=')) {
      args.username = arg.split('=')[1];
    } else if (arg === '--list-users') {
      args.listUsers = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  });

  return args;
}

// Show help
function showHelp() {
  console.log(`
Multi-User Data Migration Script

This script migrates existing data (Cron, Env, Subscription, Dependence) 
to be associated with specific users.

Usage:
  node migrate-to-multiuser.js --userId=1
  node migrate-to-multiuser.js --username=admin
  node migrate-to-multiuser.js --list-users

Options:
  --userId=<id>        Assign all legacy data to user with this ID
  --username=<name>    Assign all legacy data to user with this username
  --list-users         List all users in the system
  --dry-run            Show what would be changed without making changes
  --help               Show this help message

Examples:
  # List all users
  node migrate-to-multiuser.js --list-users

  # Migrate all data to user ID 1 (dry run)
  node migrate-to-multiuser.js --userId=1 --dry-run

  # Migrate all data to user 'admin'
  node migrate-to-multiuser.js --username=admin

Note: This script will only migrate data where userId is NULL or undefined.
Data already assigned to users will not be changed.
  `);
}

// List all users
async function listUsers() {
  const users = await UserModel.findAll();
  
  if (users.length === 0) {
    console.log('\nNo users found in the database.');
    console.log('Please create users first using the User Management interface.');
    return;
  }

  console.log('\nUsers in the system:');
  console.log('ID\tUsername\tRole\t\tStatus');
  console.log('--\t--------\t----\t\t------');
  
  users.forEach(user => {
    const role = user.role === 0 ? 'Admin' : 'User';
    const status = user.status === 0 ? 'Enabled' : 'Disabled';
    console.log(`${user.id}\t${user.username}\t\t${role}\t\t${status}`);
  });
  console.log('');
}

// Get statistics of legacy data
async function getStatistics() {
  const stats = {
    crons: await CrontabModel.count({ where: { userId: null } }),
    envs: await EnvModel.count({ where: { userId: null } }),
    subscriptions: await SubscriptionModel.count({ where: { userId: null } }),
    dependences: await DependenceModel.count({ where: { userId: null } }),
  };
  
  return stats;
}

// Migrate data to a specific user
async function migrateData(userId, dryRun = false) {
  const stats = await getStatistics();
  
  console.log('\nLegacy Data Statistics:');
  console.log(`  Cron tasks: ${stats.crons}`);
  console.log(`  Environment variables: ${stats.envs}`);
  console.log(`  Subscriptions: ${stats.subscriptions}`);
  console.log(`  Dependencies: ${stats.dependences}`);
  console.log('');

  if (stats.crons + stats.envs + stats.subscriptions + stats.dependences === 0) {
    console.log('No legacy data found. All data is already assigned to users.');
    return;
  }

  if (dryRun) {
    console.log('DRY RUN: No changes will be made.\n');
    console.log(`Would assign all legacy data to user ID ${userId}`);
    return;
  }

  console.log(`Migrating data to user ID ${userId}...`);

  const transaction = await sequelize.transaction();
  
  try {
    // Migrate crons
    if (stats.crons > 0) {
      await CrontabModel.update(
        { userId },
        { where: { userId: null }, transaction }
      );
      console.log(`✓ Migrated ${stats.crons} cron tasks`);
    }

    // Migrate envs
    if (stats.envs > 0) {
      await EnvModel.update(
        { userId },
        { where: { userId: null }, transaction }
      );
      console.log(`✓ Migrated ${stats.envs} environment variables`);
    }

    // Migrate subscriptions
    if (stats.subscriptions > 0) {
      await SubscriptionModel.update(
        { userId },
        { where: { userId: null }, transaction }
      );
      console.log(`✓ Migrated ${stats.subscriptions} subscriptions`);
    }

    // Migrate dependences
    if (stats.dependences > 0) {
      await DependenceModel.update(
        { userId },
        { where: { userId: null }, transaction }
      );
      console.log(`✓ Migrated ${stats.dependences} dependencies`);
    }

    await transaction.commit();
    console.log('\n✓ Migration completed successfully!');
  } catch (error) {
    await transaction.rollback();
    console.error('\n✗ Migration failed:', error.message);
    throw error;
  }
}

// Main function
async function main() {
  const args = parseArgs();

  if (args.help) {
    showHelp();
    return;
  }

  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection established.');

    if (args.listUsers) {
      await listUsers();
      return;
    }

    // Validate arguments
    if (!args.userId && !args.username) {
      console.error('\nError: You must specify either --userId or --username');
      console.log('Use --help for usage information.');
      process.exit(1);
    }

    // Get user ID
    let userId = args.userId;
    
    if (args.username) {
      const user = await UserModel.findOne({
        where: { username: args.username }
      });
      
      if (!user) {
        console.error(`\nError: User '${args.username}' not found.`);
        console.log('Use --list-users to see available users.');
        process.exit(1);
      }
      
      userId = user.id;
      console.log(`Found user '${args.username}' with ID ${userId}`);
    } else {
      // Verify user exists
      const user = await UserModel.findByPk(userId);
      
      if (!user) {
        console.error(`\nError: User with ID ${userId} not found.`);
        console.log('Use --list-users to see available users.');
        process.exit(1);
      }
      
      console.log(`Found user '${user.username}' with ID ${userId}`);
    }

    // Perform migration
    await migrateData(userId, args.dryRun);

  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Run the script
if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { main, listUsers, migrateData, getStatistics };
