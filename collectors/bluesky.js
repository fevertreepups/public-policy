/**
 * Bluesky Collector — AT Protocol
 * Free — uses app passwords for auth
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const BSKY_BASE = 'https://bsky.social/xrpc';

class BlueskyCollector {
  constructor(db, config = {}) {
    this.db = db;
    this.handle = config.handle || process.env.BLUESKY_HANDLE;
    this.appPassword = config.appPassword || process.env.BLUESKY_APP_PASSWORD;
    this.accessJwt = null;
    this.did = null;

    if (!this.handle || this.handle === 'your.handle.bsky.social') {
      this.enabled = false;
      console.log('[Bluesky] No credentials configured — collector disabled');
    } else {
      this.enabled = true;
    }

    this.insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, platform, author, content, url, created_at, likes, reposts, replies, is_reply, parent_id)
      VALUES (?, 'bluesky', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Authenticate with Bluesky via app password
   */
  async auth() {
    if (!this.enabled) return false;

    try {
      const res = await fetch(`${BSKY_BASE}/com.atproto.server.createSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier: this.handle,
          password: this.appPassword
        })
      });

      if (!res.ok) {
        console.error(`[Bluesky] Auth failed: ${res.status}`);
        return false;
      }

      const data = await res.json();
      this.accessJwt = data.accessJwt;
      this.did = data.did;
      return true;
    } catch (err) {
      console.error(`[Bluesky] Auth error: ${err.message}`);
      return false;
    }
  }

  /**
   * Search posts via Bluesky search API
   */
  async search(query, options = {}) {
    if (!this.enabled || !this.accessJwt) return [];

    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit || 50),
      sort: 'latest'
    });

    try {
      const res = await fetch(`${BSKY_BASE}/app.bsky.feed.searchPosts?${params}`, {
        headers: { Authorization: `Bearer ${this.accessJwt}` }
      });

      if (res.status === 401) {
        // Re-auth and retry
        if (await this.auth()) {
          return this.search(query, options);
        }
        return [];
      }

      if (!res.ok) {
        console.error(`[Bluesky] Search error ${res.status}`);
        return [];
      }

      const data = await res.json();
      return (data.posts || []).map(post => {
        const uri = post.uri; // at://did/app.bsky.feed.post/rkey
        const rkey = uri.split('/').pop();
        const authorDid = post.author?.did || '';
        const authorHandle = post.author?.handle || 'unknown';

        return {
          id: `bs_${rkey}`,
          author: authorHandle,
          author_followers: post.author?.followersCount || 0,
          content: post.record?.text || '',
          url: `https://bsky.app/profile/${authorHandle}/post/${rkey}`,
          created_at: post.record?.createdAt || post.indexedAt || new Date().toISOString(),
          likes: post.likeCount || 0,
          reposts: post.repostCount || 0,
          replies: post.replyCount || 0,
          is_reply: post.record?.reply ? 1 : 0,
          parent_id: post.record?.reply?.parent?.uri ? `bs_${post.record.reply.parent.uri.split('/').pop()}` : null
        };
      });
    } catch (err) {
      console.error(`[Bluesky] Search error: ${err.message}`);
      return [];
    }
  }

  /**
   * Full collection run
   */
  async collect() {
    if (!this.enabled) return { platform: 'bluesky', collected: 0, skipped: true };

    const authed = await this.auth();
    if (!authed) return { platform: 'bluesky', collected: 0, error: 'auth_failed' };

    let totalCollected = 0;

    const queries = this.db.prepare(
      "SELECT query FROM tracked_queries WHERE enabled = 1 AND (platforms LIKE '%bluesky%' OR platforms LIKE '%all%')"
    ).all();

    for (const { query } of queries) {
      const posts = await this.search(query);
      this._insertPosts(posts);
      totalCollected += posts.length;
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`[Bluesky] Collected ${totalCollected} posts across ${queries.length} queries`);
    return { platform: 'bluesky', collected: totalCollected };
  }

  _insertPosts(posts) {
    const insertMany = this.db.transaction((items) => {
      for (const p of items) {
        this.insertPost.run(
          p.id, p.author, p.content, p.url, p.created_at,
          p.likes, p.reposts, p.replies, p.is_reply, p.parent_id
        );
      }
    });
    insertMany(posts);
  }
}

module.exports = BlueskyCollector;
