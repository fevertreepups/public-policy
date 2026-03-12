/**
 * Database Schema — SQLite via sql.js (pure JS, no native deps)
 * Wraps sql.js to provide a better-sqlite3-compatible API
 * Stores all collected posts, sentiment scores, alerts, and report data
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'perception.db');

/**
 * Wrapper around sql.js to provide a synchronous API similar to better-sqlite3
 */
class DBWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
    this._saveInterval = null;
  }

  exec(sql) {
    this._db.run(sql);
  }

  prepare(sql) {
    const db = this._db;
    return {
      run(...params) {
        db.run(sql, params);
      },
      get(...params) {
        const stmt = db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          stmt.free();
          const row = {};
          cols.forEach((c, i) => { row[c] = vals[i]; });
          return row;
        }
        stmt.free();
        return undefined;
      },
      all(...params) {
        const results = [];
        const stmt = db.prepare(sql);
        stmt.bind(params);
        while (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          const row = {};
          cols.forEach((c, i) => { row[c] = vals[i]; });
          results.push(row);
        }
        stmt.free();
        return results;
      }
    };
  }

  pragma(str) {
    try { this._db.run(`PRAGMA ${str}`); } catch {}
  }

  transaction(fn) {
    const db = this._db;
    return (...args) => {
      db.run('BEGIN TRANSACTION');
      try {
        fn(...args);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    };
  }

  save() {
    try {
      const data = this._db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('[DB] Save error:', err.message);
    }
  }

  close() {
    this.save();
    if (this._saveInterval) clearInterval(this._saveInterval);
    this._db.close();
  }

  // Auto-save every 30 seconds
  enableAutoSave(intervalMs = 30000) {
    this._saveInterval = setInterval(() => this.save(), intervalMs);
  }
}

let _dbInstance = null;

function initDB() {
  if (_dbInstance) return _dbInstance;

  // sql.js needs to be initialized synchronously for our use case
  // We use the synchronous require pattern
  const SQL = require('sql.js');

  // sql.js returns a promise for the module, but we need sync init
  // Use a cached instance approach
  let sqlDb;

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const db = new DBWrapper(sqlDb);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ── Core posts table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      author TEXT,
      author_followers INTEGER DEFAULT 0,
      content TEXT NOT NULL,
      url TEXT,
      created_at DATETIME NOT NULL,
      collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      likes INTEGER DEFAULT 0,
      reposts INTEGER DEFAULT 0,
      replies INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      sentiment_score REAL,
      sentiment_label TEXT,
      sentiment_magnitude REAL,
      topics TEXT,
      policy_areas TEXT,
      jurisdictions TEXT,
      mentions_anthropic BOOLEAN DEFAULT 0,
      mentions_competitors TEXT,
      narrative_cluster TEXT,
      key_phrases TEXT,
      is_reply BOOLEAN DEFAULT 0,
      parent_id TEXT,
      language TEXT DEFAULT 'en'
    );

    CREATE INDEX IF NOT EXISTS idx_posts_platform ON posts(platform);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_sentiment ON posts(sentiment_label);
    CREATE INDEX IF NOT EXISTS idx_posts_anthropic ON posts(mentions_anthropic);
    CREATE INDEX IF NOT EXISTS idx_posts_topics ON posts(topics);
  `);

  // ── Alerts table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL,
      urgency TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      data TEXT,
      acknowledged BOOLEAN DEFAULT 0,
      acknowledged_at DATETIME,
      acknowledged_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alerts_urgency ON alerts(urgency);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
  `);

  // ── Reports table ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      period_start DATETIME NOT NULL,
      period_end DATETIME NOT NULL,
      type TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      data TEXT,
      html TEXT
    );
  `);

  // ── Search queries / keyword tracking ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      category TEXT,
      platforms TEXT DEFAULT '["all"]',
      enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed default tracked queries
  const count = db.prepare('SELECT COUNT(*) as c FROM tracked_queries').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO tracked_queries (query, category) VALUES (?, ?)');
    const queries = [
      ['Anthropic AI policy', 'anthropic'],
      ['Anthropic regulation', 'anthropic'],
      ['Anthropic government', 'anthropic'],
      ['Anthropic testimony', 'anthropic'],
      ['Anthropic lobby', 'anthropic'],
      ['Anthropic safety policy', 'anthropic'],
      ['Claude AI regulation', 'anthropic'],
      ['Dario Amodei policy', 'anthropic'],
      ['Jack Clark AI policy', 'anthropic'],
      ['AI regulation', 'policy_area'],
      ['EU AI Act', 'policy_area'],
      ['AI safety legislation', 'policy_area'],
      ['AI governance', 'policy_area'],
      ['frontier AI safety', 'policy_area'],
      ['AI copyright training data', 'policy_area'],
      ['AI executive order', 'policy_area'],
      ['GPAI code of practice', 'policy_area'],
      ['AI Act enforcement', 'policy_area'],
      ['OpenAI lobbying', 'competitor'],
      ['Google AI regulation', 'competitor'],
      ['Meta AI policy', 'competitor'],
      ['Microsoft AI governance', 'competitor'],
      ['AI policy debate', 'general_ai'],
      ['AI regulation debate', 'general_ai'],
      ['should we regulate AI', 'general_ai'],
      ['AI safety vs innovation', 'general_ai']
    ];
    queries.forEach(([q, c]) => insert.run(q, c));
    db.save();
  }

  // Auto-save periodically
  db.enableAutoSave();

  _dbInstance = db;
  return db;
}

// Async init for environments that need it (sql.js wasm loading)
async function initDBAsync() {
  if (_dbInstance) return _dbInstance;

  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const db = new DBWrapper(sqlDb);
  db.pragma('foreign_keys = ON');

  // Run same schema creation as initDB
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY, platform TEXT NOT NULL, author TEXT,
      author_followers INTEGER DEFAULT 0, content TEXT NOT NULL, url TEXT,
      created_at DATETIME NOT NULL, collected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      likes INTEGER DEFAULT 0, reposts INTEGER DEFAULT 0, replies INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0, sentiment_score REAL, sentiment_label TEXT,
      sentiment_magnitude REAL, topics TEXT, policy_areas TEXT, jurisdictions TEXT,
      mentions_anthropic BOOLEAN DEFAULT 0, mentions_competitors TEXT,
      narrative_cluster TEXT, key_phrases TEXT, is_reply BOOLEAN DEFAULT 0,
      parent_id TEXT, language TEXT DEFAULT 'en'
    );
    CREATE INDEX IF NOT EXISTS idx_posts_platform ON posts(platform);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_sentiment ON posts(sentiment_label);
    CREATE INDEX IF NOT EXISTS idx_posts_anthropic ON posts(mentions_anthropic);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      type TEXT NOT NULL, urgency TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      data TEXT, acknowledged BOOLEAN DEFAULT 0, acknowledged_at DATETIME, acknowledged_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_urgency ON alerts(urgency);
    CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      period_start DATETIME NOT NULL, period_end DATETIME NOT NULL, type TEXT NOT NULL,
      title TEXT, summary TEXT, data TEXT, html TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, category TEXT,
      platforms TEXT DEFAULT '["all"]', enabled BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const count = db.prepare('SELECT COUNT(*) as c FROM tracked_queries').get().c;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO tracked_queries (query, category) VALUES (?, ?)');
    const queries = [
      ['Anthropic AI policy', 'anthropic'], ['Anthropic regulation', 'anthropic'],
      ['Anthropic government', 'anthropic'], ['Claude AI regulation', 'anthropic'],
      ['AI regulation', 'policy_area'], ['EU AI Act', 'policy_area'],
      ['AI safety legislation', 'policy_area'], ['AI governance', 'policy_area'],
      ['OpenAI lobbying', 'competitor'], ['Google AI regulation', 'competitor'],
      ['AI policy debate', 'general_ai'], ['AI regulation debate', 'general_ai']
    ];
    queries.forEach(([q, c]) => insert.run(q, c));
    db.save();
  }

  db.enableAutoSave();
  _dbInstance = db;
  return db;
}

module.exports = { initDB, initDBAsync, DB_PATH };
