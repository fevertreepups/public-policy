/**
 * Reddit Collector — via snoowrap (OAuth2)
 * Free tier — create app at https://www.reddit.com/prefs/apps
 */

const Snoowrap = require('snoowrap');

// Subreddits most relevant to AI policy discourse
const TARGET_SUBREDDITS = [
  'artificial', 'MachineLearning', 'technology', 'singularity',
  'ChatGPT', 'OpenAI', 'LocalLLaMA', 'ArtificialIntelligence',
  'AIethics', 'policy', 'futurology', 'ClaudeAI'
];

class RedditCollector {
  constructor(db, config = {}) {
    this.db = db;

    const clientId = config.clientId || process.env.REDDIT_CLIENT_ID;
    const clientSecret = config.clientSecret || process.env.REDDIT_CLIENT_SECRET;
    const username = config.username || process.env.REDDIT_USERNAME;
    const password = config.password || process.env.REDDIT_PASSWORD;
    const userAgent = config.userAgent || process.env.REDDIT_USER_AGENT || 'AnthropicPerceptionEngine/1.0';

    if (!clientId || clientId === 'your_client_id') {
      this.enabled = false;
      console.log('[Reddit] No credentials configured — collector disabled');
    } else {
      this.enabled = true;
      this.reddit = new Snoowrap({
        userAgent,
        clientId,
        clientSecret,
        username,
        password
      });
      // Respect rate limits
      this.reddit.config({ requestDelay: 1100, continueAfterRatelimitError: true });
    }

    this.insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, platform, author, content, url, created_at, likes, replies, score, is_reply, parent_id)
      VALUES (?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Search Reddit for posts matching a query
   */
  async search(query, options = {}) {
    if (!this.enabled) return [];

    try {
      const results = await this.reddit.search({
        query,
        sort: 'relevance',
        time: options.time || 'day',
        limit: options.limit || 50
      });

      return results.map(post => ({
        id: `rd_${post.id}`,
        author: post.author?.name || '[deleted]',
        content: post.selftext || post.title,
        title: post.title,
        url: `https://reddit.com${post.permalink}`,
        created_at: new Date(post.created_utc * 1000).toISOString(),
        likes: post.ups || 0,
        replies: post.num_comments || 0,
        score: post.score || 0,
        is_reply: 0,
        parent_id: null,
        subreddit: post.subreddit_name_prefixed
      }));
    } catch (err) {
      console.error(`[Reddit] Search error for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch top/hot posts from target subreddits
   */
  async collectSubreddits() {
    if (!this.enabled) return [];

    const allPosts = [];

    for (const sub of TARGET_SUBREDDITS) {
      try {
        const hot = await this.reddit.getSubreddit(sub).getHot({ limit: 25 });
        const mapped = hot.map(post => ({
          id: `rd_${post.id}`,
          author: post.author?.name || '[deleted]',
          content: post.selftext ? `${post.title}\n\n${post.selftext}` : post.title,
          url: `https://reddit.com${post.permalink}`,
          created_at: new Date(post.created_utc * 1000).toISOString(),
          likes: post.ups || 0,
          replies: post.num_comments || 0,
          score: post.score || 0,
          is_reply: 0,
          parent_id: null
        }));
        allPosts.push(...mapped);
      } catch (err) {
        console.error(`[Reddit] Error fetching r/${sub}: ${err.message}`);
      }
    }

    return allPosts;
  }

  /**
   * Collect comments from high-engagement posts
   */
  async collectComments(postId, limit = 20) {
    if (!this.enabled) return [];

    try {
      const submission = await this.reddit.getSubmission(postId.replace('rd_', '')).expandReplies({ limit, depth: 1 });
      return submission.comments.map(c => ({
        id: `rd_c_${c.id}`,
        author: c.author?.name || '[deleted]',
        content: c.body || '',
        url: `https://reddit.com${c.permalink}`,
        created_at: new Date(c.created_utc * 1000).toISOString(),
        likes: c.ups || 0,
        replies: 0,
        score: c.score || 0,
        is_reply: 1,
        parent_id: postId
      }));
    } catch (err) {
      console.error(`[Reddit] Comment fetch error: ${err.message}`);
      return [];
    }
  }

  /**
   * Full collection run: search queries + subreddit monitoring
   */
  async collect() {
    if (!this.enabled) return { platform: 'reddit', collected: 0, skipped: true };

    let totalCollected = 0;

    // 1. Search tracked queries
    const queries = this.db.prepare(
      "SELECT query FROM tracked_queries WHERE enabled = 1 AND (platforms LIKE '%reddit%' OR platforms LIKE '%all%')"
    ).all();

    for (const { query } of queries) {
      const posts = await this.search(query);
      this._insertPosts(posts);
      totalCollected += posts.length;
    }

    // 2. Monitor target subreddits
    const subPosts = await this.collectSubreddits();

    // Filter subreddit posts for relevance (must mention AI policy keywords)
    const keywords = /\b(anthropic|claude|ai policy|ai regulation|ai safety|ai governance|frontier|ai act|executive order|openai|deepmind|ai legislation)\b/i;
    const relevant = subPosts.filter(p => keywords.test(p.content));
    this._insertPosts(relevant);
    totalCollected += relevant.length;

    console.log(`[Reddit] Collected ${totalCollected} posts (${queries.length} queries + ${TARGET_SUBREDDITS.length} subreddits)`);
    return { platform: 'reddit', collected: totalCollected };
  }

  _insertPosts(posts) {
    const insertMany = this.db.transaction((items) => {
      for (const p of items) {
        this.insertPost.run(
          p.id, p.author, p.content, p.url, p.created_at,
          p.likes, p.replies, p.score, p.is_reply, p.parent_id
        );
      }
    });
    insertMany(posts);
  }
}

module.exports = RedditCollector;
