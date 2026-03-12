/**
 * Collection Orchestrator — runs all collectors in sequence
 * Can be invoked via CLI: node collectors/run-all.js
 * Or programmatically from the server's cron scheduler
 */

require('dotenv').config();
const { initDB } = require('../db/schema');
const TwitterCollector = require('./twitter');
const RedditCollector = require('./reddit');
const HackerNewsCollector = require('./hackernews');
const BlueskyCollector = require('./bluesky');
const NewsCollector = require('./news');

async function runAll(db) {
  const ownDb = !db;
  if (!db) db = initDB();

  const startTime = Date.now();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Collection run started at ${new Date().toISOString()}`);
  console.log('═'.repeat(60));

  const collectors = [
    { name: 'Twitter/X', instance: new TwitterCollector(db) },
    { name: 'Reddit', instance: new RedditCollector(db) },
    { name: 'Hacker News', instance: new HackerNewsCollector(db) },
    { name: 'Bluesky', instance: new BlueskyCollector(db) },
    { name: 'News/RSS', instance: new NewsCollector(db) }
  ];

  const results = [];

  for (const { name, instance } of collectors) {
    try {
      console.log(`\n── ${name} ──`);
      const result = await instance.collect();
      results.push(result);

      if (result.skipped) {
        console.log(`  ⏭  Skipped (not configured)`);
      } else if (result.error) {
        console.log(`  ⚠  Error: ${result.error}`);
      } else {
        console.log(`  ✓  ${result.collected} items collected`);
      }
    } catch (err) {
      console.error(`  ✗  ${name} failed: ${err.message}`);
      results.push({ platform: name.toLowerCase(), collected: 0, error: err.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalCollected = results.reduce((sum, r) => sum + (r.collected || 0), 0);
  const activeCollectors = results.filter(r => !r.skipped).length;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Collection complete: ${totalCollected} items from ${activeCollectors} platforms in ${elapsed}s`);
  console.log('═'.repeat(60));

  // Log collection stats to DB
  const totalPosts = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  const todayPosts = db.prepare(
    "SELECT COUNT(*) as c FROM posts WHERE collected_at >= date('now')"
  ).get().c;

  console.log(`Database totals: ${totalPosts} all-time, ${todayPosts} today`);

  if (ownDb) db.close();

  return {
    results,
    totalCollected,
    activeCollectors,
    elapsed: parseFloat(elapsed),
    dbStats: { totalPosts, todayPosts }
  };
}

// CLI execution
if (require.main === module) {
  runAll()
    .then(summary => {
      console.log('\nSummary:', JSON.stringify(summary.results, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { runAll };
