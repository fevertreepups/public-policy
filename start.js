#!/usr/bin/env node
/**
 * Perception Engine — Async Startup
 * Handles sql.js async initialization before loading the server
 */

const { initDBAsync } = require('./db/schema');

async function main() {
  console.log('Initializing database...');
  const db = await initDBAsync();

  // Patch the sync initDB to return the already-initialized instance
  require('./db/schema').initDB = () => db;

  console.log('Starting server...');
  require('./server');
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
