/**
 * Perception Engine — Express API Server
 * Serves the dashboard, REST API, and manages cron-based collection
 */

require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { initDB } = require('./db/schema');
const { runAll } = require('./collectors/run-all');
const SentimentPipeline = require('./analysis/sentiment');
const AlertSystem = require('./analysis/alerts');
const ReportGenerator = require('./reports/generate');

const app = express();
const PORT = process.env.PORT || 3400;
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// Initialize database and modules
const db = initDB();
const sentiment = new SentimentPipeline(db);
const alerts = new AlertSystem(db);
const reports = new ReportGenerator(db);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════
// CORS for local development
// ════════════════════════════════════════════════════════
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ════════════════════════════════════════════════════════
// API Routes
// ════════════════════════════════════════════════════════

// ── Overview stats ──
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM posts').get().c;
  const today = db.prepare("SELECT COUNT(*) as c FROM posts WHERE collected_at >= date('now')").get().c;
  const analyzed = db.prepare('SELECT COUNT(*) as c FROM posts WHERE sentiment_score IS NOT NULL').get().c;
  const anthropicMentions = db.prepare('SELECT COUNT(*) as c FROM posts WHERE mentions_anthropic = 1').get().c;
  const unackedAlerts = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE acknowledged = 0').get().c;
  const avgSentiment = db.prepare('SELECT ROUND(AVG(sentiment_score), 4) as avg FROM posts WHERE sentiment_score IS NOT NULL AND collected_at >= datetime("now", "-24 hours")').get().avg;

  res.json({
    totalPosts: total,
    todayPosts: today,
    analyzedPosts: analyzed,
    anthropicMentions,
    unacknowledgedAlerts: unackedAlerts,
    avgSentiment24h: avgSentiment,
    lastUpdated: new Date().toISOString()
  });
});

// ── Sentiment data ──
app.get('/api/sentiment', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const platform = req.query.platform;

  let query = `
    SELECT
      strftime('%Y-%m-%d %H:00', collected_at) as hour,
      COUNT(*) as count,
      ROUND(AVG(sentiment_score), 4) as avg_sentiment,
      SUM(CASE WHEN sentiment_label = 'positive' THEN 1 ELSE 0 END) as positive,
      SUM(CASE WHEN sentiment_label = 'negative' THEN 1 ELSE 0 END) as negative,
      SUM(CASE WHEN sentiment_label = 'neutral' THEN 1 ELSE 0 END) as neutral,
      SUM(CASE WHEN mentions_anthropic = 1 THEN 1 ELSE 0 END) as anthropic_count
    FROM posts
    WHERE sentiment_score IS NOT NULL
      AND collected_at >= datetime('now', '-${hours} hours')
  `;
  if (platform) query += ` AND platform = '${platform}'`;
  query += ` GROUP BY hour ORDER BY hour`;

  const data = db.prepare(query).all();

  // Distribution
  let distQuery = `
    SELECT sentiment_label, COUNT(*) as count
    FROM posts WHERE sentiment_label IS NOT NULL
      AND collected_at >= datetime('now', '-${hours} hours')
  `;
  if (platform) distQuery += ` AND platform = '${platform}'`;
  distQuery += ` GROUP BY sentiment_label`;

  const distribution = db.prepare(distQuery).all();

  res.json({ trend: data, distribution });
});

// ── Posts feed ──
app.get('/api/posts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const platform = req.query.platform;
  const sentiment_label = req.query.sentiment;
  const anthropicOnly = req.query.anthropic === 'true';
  const search = req.query.q;

  let where = ['sentiment_score IS NOT NULL'];
  const params = [];

  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (sentiment_label) { where.push('sentiment_label = ?'); params.push(sentiment_label); }
  if (anthropicOnly) { where.push('mentions_anthropic = 1'); }
  if (search) { where.push('content LIKE ?'); params.push(`%${search}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const posts = db.prepare(`
    SELECT id, platform, author, content, url, created_at,
           sentiment_score, sentiment_label, likes, reposts, replies, score,
           topics, mentions_anthropic, mentions_competitors, key_phrases
    FROM posts ${whereClause}
    ORDER BY collected_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) as c FROM posts ${whereClause}`).all(...params)[0].c;

  res.json({ posts, total, limit, offset });
});

// ── Alerts ──
app.get('/api/alerts', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const unackedOnly = req.query.unacked === 'true';

  let query;
  if (unackedOnly) {
    query = db.prepare(`SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY created_at DESC LIMIT ?`);
  } else {
    query = db.prepare(`SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`);
  }

  res.json(query.all(limit));
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  alerts.acknowledge(parseInt(req.params.id), req.body.by || 'user');
  res.json({ success: true });
});

// ── Reports ──
app.get('/api/reports', (req, res) => {
  res.json(reports.getAll());
});

app.get('/api/reports/:id', (req, res) => {
  const report = reports.getById(parseInt(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

app.get('/api/reports/:id/html', (req, res) => {
  const report = reports.getById(parseInt(req.params.id));
  if (!report || !report.html) return res.status(404).send('Report not found');
  res.type('html').send(report.html);
});

app.post('/api/reports/generate', async (req, res) => {
  const type = req.body.type || 'daily';
  try {
    const report = reports.generate(type);
    res.json({ success: true, title: report.title, summary: report.summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Topics & Narratives ──
app.get('/api/narratives', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;

  const posts = db.prepare(`
    SELECT key_phrases, topics, policy_areas FROM posts
    WHERE key_phrases IS NOT NULL
      AND collected_at >= datetime('now', '-${hours} hours')
  `).all();

  const phraseCounts = {};
  const topicCounts = {};
  const policyCounts = {};

  for (const { key_phrases, topics, policy_areas } of posts) {
    try { JSON.parse(key_phrases).forEach(p => { const l = p.toLowerCase(); phraseCounts[l] = (phraseCounts[l] || 0) + 1; }); } catch {}
    try { JSON.parse(topics).forEach(t => { topicCounts[t] = (topicCounts[t] || 0) + 1; }); } catch {}
    try { JSON.parse(policy_areas).forEach(a => { policyCounts[a] = (policyCounts[a] || 0) + 1; }); } catch {}
  }

  const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ name: k, count: v }));

  res.json({
    phrases: sortDesc(phraseCounts).slice(0, 30),
    topics: sortDesc(topicCounts),
    policyAreas: sortDesc(policyCounts)
  });
});

// ── Tracked queries management ──
app.get('/api/queries', (req, res) => {
  res.json(db.prepare('SELECT * FROM tracked_queries ORDER BY category, query').all());
});

app.post('/api/queries', (req, res) => {
  const { query, category, platforms } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  const result = db.prepare(
    'INSERT INTO tracked_queries (query, category, platforms) VALUES (?, ?, ?)'
  ).run(query, category || 'custom', platforms || '["all"]');

  res.json({ id: result.lastInsertRowid, success: true });
});

app.delete('/api/queries/:id', (req, res) => {
  db.prepare('DELETE FROM tracked_queries WHERE id = ?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ── Manual triggers ──
app.post('/api/collect', async (req, res) => {
  try {
    const result = await runAll(db);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/analyze', (req, res) => {
  const result = sentiment.processBatch(parseInt(req.body.batchSize) || 500);
  const alertResults = alerts.runChecks();
  res.json({ ...result, alerts: alertResults.length });
});

// ════════════════════════════════════════════════════════
// Dashboard route
// ════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ════════════════════════════════════════════════════════
// Cron Schedulers
// ════════════════════════════════════════════════════════
if (!isDev) {
  // Twitter: every 15 min
  cron.schedule(process.env.COLLECT_TWITTER_CRON || '*/15 * * * *', async () => {
    console.log('[Cron] Running Twitter collection...');
    const TwitterCollector = require('./collectors/twitter');
    const tw = new TwitterCollector(db);
    await tw.collect();
    sentiment.processBatch(200);
    alerts.runChecks();
  });

  // Reddit: every 10 min
  cron.schedule(process.env.COLLECT_REDDIT_CRON || '*/10 * * * *', async () => {
    console.log('[Cron] Running Reddit collection...');
    const RedditCollector = require('./collectors/reddit');
    const rd = new RedditCollector(db);
    await rd.collect();
    sentiment.processBatch(200);
    alerts.runChecks();
  });

  // HN: every 30 min
  cron.schedule(process.env.COLLECT_HN_CRON || '*/30 * * * *', async () => {
    console.log('[Cron] Running HN collection...');
    const HackerNewsCollector = require('./collectors/hackernews');
    const hn = new HackerNewsCollector(db);
    await hn.collect();
    sentiment.processBatch(200);
    alerts.runChecks();
  });

  // Bluesky: every 15 min
  cron.schedule(process.env.COLLECT_BLUESKY_CRON || '*/15 * * * *', async () => {
    console.log('[Cron] Running Bluesky collection...');
    const BlueskyCollector = require('./collectors/bluesky');
    const bs = new BlueskyCollector(db);
    await bs.collect();
    sentiment.processBatch(200);
    alerts.runChecks();
  });

  // News: every hour
  cron.schedule(process.env.COLLECT_NEWS_CRON || '0 * * * *', async () => {
    console.log('[Cron] Running News collection...');
    const NewsCollector = require('./collectors/news');
    const news = new NewsCollector(db);
    await news.collect();
    sentiment.processBatch(200);
    alerts.runChecks();
  });

  // Daily report: 6 AM
  cron.schedule('0 6 * * *', () => {
    console.log('[Cron] Generating daily report...');
    reports.generate('daily');
  });

  // Weekly report: Monday 7 AM
  cron.schedule('0 7 * * 1', () => {
    console.log('[Cron] Generating weekly report...');
    reports.generate('weekly');
  });

  console.log('[Cron] All collection schedules active');
}

// ════════════════════════════════════════════════════════
// Start Server
// ════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Anthropic Perception Engine`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/stats`);
  console.log(`  Mode:      ${isDev ? 'development (cron disabled)' : 'production'}`);
  console.log('═'.repeat(60));
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

module.exports = app;
