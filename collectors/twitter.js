/**
 * Twitter/X Collector — v2 API (Recent Search)
 * Requires Basic tier ($100/mo) for search endpoint
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const TWITTER_BASE = 'https://api.twitter.com/2';

class TwitterCollector {
  constructor(db, config = {}) {
    this.db = db;
    this.bearerToken = config.bearerToken || process.env.TWITTER_BEARER_TOKEN;
    this.maxResults = config.maxResults || 100;

    if (!this.bearerToken || this.bearerToken === 'your_bearer_token_here') {
      this.enabled = false;
      console.log('[Twitter] No bearer token configured — collector disabled');
    } else {
      this.enabled = true;
    }

    this.insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, platform, author, author_followers, content, url, created_at, likes, reposts, replies, is_reply, parent_id)
      VALUES (?, 'twitter', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Search recent tweets matching a query
   * Rate limit: 60 requests/15min on Basic tier
   */
  async search(query, sinceId = null) {
    if (!this.enabled) return [];

    const params = new URLSearchParams({
      query: `${query} -is:retweet lang:en`,
      max_results: String(this.maxResults),
      'tweet.fields': 'created_at,public_metrics,conversation_id,in_reply_to_user_id,referenced_tweets,author_id',
      'user.fields': 'username,public_metrics',
      expansions: 'author_id'
    });

    if (sinceId) params.set('since_id', sinceId);

    try {
      const res = await fetch(`${TWITTER_BASE}/tweets/search/recent?${params}`, {
        headers: { Authorization: `Bearer ${this.bearerToken}` }
      });

      if (res.status === 429) {
        const reset = res.headers.get('x-rate-limit-reset');
        const waitSec = reset ? Math.ceil((parseInt(reset) * 1000 - Date.now()) / 1000) : 60;
        console.log(`[Twitter] Rate limited — waiting ${waitSec}s`);
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return this.search(query, sinceId);
      }

      if (!res.ok) {
        const err = await res.text();
        console.error(`[Twitter] API error ${res.status}: ${err}`);
        return [];
      }

      const data = await res.json();
      if (!data.data) return [];

      // Build author lookup from includes
      const authors = {};
      if (data.includes?.users) {
        data.includes.users.forEach(u => {
          authors[u.id] = {
            username: u.username,
            followers: u.public_metrics?.followers_count || 0
          };
        });
      }

      return data.data.map(tweet => ({
        id: `tw_${tweet.id}`,
        author: authors[tweet.author_id]?.username || tweet.author_id,
        author_followers: authors[tweet.author_id]?.followers || 0,
        content: tweet.text,
        url: `https://x.com/i/status/${tweet.id}`,
        created_at: tweet.created_at,
        likes: tweet.public_metrics?.like_count || 0,
        reposts: tweet.public_metrics?.retweet_count || 0,
        replies: tweet.public_metrics?.reply_count || 0,
        is_reply: tweet.referenced_tweets?.some(r => r.type === 'replied_to') ? 1 : 0,
        parent_id: tweet.referenced_tweets?.find(r => r.type === 'replied_to')?.id || null
      }));

    } catch (err) {
      console.error(`[Twitter] Fetch error: ${err.message}`);
      return [];
    }
  }

  /**
   * Collect tweets for all tracked queries
   */
  async collect() {
    if (!this.enabled) return { platform: 'twitter', collected: 0, skipped: true };

    const queries = this.db.prepare(
      "SELECT query FROM tracked_queries WHERE enabled = 1 AND (platforms LIKE '%twitter%' OR platforms LIKE '%all%')"
    ).all();

    let totalCollected = 0;

    for (const { query } of queries) {
      const tweets = await this.search(query);

      const insertMany = this.db.transaction((posts) => {
        for (const p of posts) {
          this.insertPost.run(
            p.id, p.author, p.author_followers, p.content, p.url,
            p.created_at, p.likes, p.reposts, p.replies, p.is_reply, p.parent_id
          );
        }
      });

      insertMany(tweets);
      totalCollected += tweets.length;

      // Respect rate limits: short pause between queries
      await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`[Twitter] Collected ${totalCollected} tweets across ${queries.length} queries`);
    return { platform: 'twitter', collected: totalCollected };
  }
}

module.exports = TwitterCollector;
