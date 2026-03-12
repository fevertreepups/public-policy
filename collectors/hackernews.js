/**
 * Hacker News Collector — Free public API (no auth needed)
 * https://github.com/HackerNewsAPI/HN-API
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const HN_BASE = 'https://hn.algolia.com/api/v1';

class HackerNewsCollector {
  constructor(db) {
    this.db = db;
    this.enabled = true; // No auth needed

    this.insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, platform, author, content, url, created_at, score, replies, is_reply, parent_id)
      VALUES (?, 'hackernews', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Search HN via Algolia API
   */
  async search(query, options = {}) {
    const params = new URLSearchParams({
      query,
      tags: options.tags || '(story,poll)',
      numericFilters: options.numericFilters || 'created_at_i>' + Math.floor((Date.now() - 86400000) / 1000),
      hitsPerPage: String(options.limit || 50)
    });

    try {
      const res = await fetch(`${HN_BASE}/search?${params}`);
      if (!res.ok) {
        console.error(`[HN] API error ${res.status}`);
        return [];
      }

      const data = await res.json();
      return (data.hits || []).map(hit => ({
        id: `hn_${hit.objectID}`,
        author: hit.author || 'unknown',
        content: hit.title + (hit.story_text ? `\n\n${hit.story_text}` : ''),
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        created_at: hit.created_at || new Date().toISOString(),
        score: hit.points || 0,
        replies: hit.num_comments || 0,
        is_reply: 0,
        parent_id: null,
        hn_url: `https://news.ycombinator.com/item?id=${hit.objectID}`
      }));
    } catch (err) {
      console.error(`[HN] Search error: ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch comments for a story
   */
  async fetchComments(storyId, limit = 30) {
    const objectID = storyId.replace('hn_', '');
    try {
      const res = await fetch(`${HN_BASE}/search?tags=comment,story_${objectID}&hitsPerPage=${limit}`);
      if (!res.ok) return [];

      const data = await res.json();
      return (data.hits || []).map(hit => ({
        id: `hn_c_${hit.objectID}`,
        author: hit.author || 'unknown',
        content: hit.comment_text || '',
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        created_at: hit.created_at || new Date().toISOString(),
        score: hit.points || 0,
        replies: 0,
        is_reply: 1,
        parent_id: storyId
      }));
    } catch (err) {
      console.error(`[HN] Comment fetch error: ${err.message}`);
      return [];
    }
  }

  /**
   * Full collection run
   */
  async collect() {
    let totalCollected = 0;

    const queries = this.db.prepare(
      "SELECT query FROM tracked_queries WHERE enabled = 1 AND (platforms LIKE '%hackernews%' OR platforms LIKE '%all%')"
    ).all();

    for (const { query } of queries) {
      const posts = await this.search(query);
      this._insertPosts(posts);
      totalCollected += posts.length;

      // Fetch comments for high-engagement stories
      const highEngagement = posts.filter(p => p.replies > 10);
      for (const story of highEngagement.slice(0, 5)) {
        const comments = await this.fetchComments(story.id);
        this._insertPosts(comments);
        totalCollected += comments.length;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Also check front page for relevant stories
    const frontPage = await this._checkFrontPage();
    this._insertPosts(frontPage);
    totalCollected += frontPage.length;

    console.log(`[HN] Collected ${totalCollected} items across ${queries.length} queries + front page`);
    return { platform: 'hackernews', collected: totalCollected };
  }

  /**
   * Check HN front page for AI policy stories
   */
  async _checkFrontPage() {
    try {
      const res = await fetch(`${HN_BASE}/search?tags=front_page&hitsPerPage=30`);
      if (!res.ok) return [];

      const data = await res.json();
      const keywords = /\b(anthropic|claude|ai policy|ai regulation|ai safety|ai governance|openai|gpt|frontier model|ai act|ai legislation|artificial intelligence)\b/i;

      return (data.hits || [])
        .filter(hit => keywords.test(hit.title || '') || keywords.test(hit.story_text || ''))
        .map(hit => ({
          id: `hn_${hit.objectID}`,
          author: hit.author || 'unknown',
          content: hit.title + (hit.story_text ? `\n\n${hit.story_text}` : ''),
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          created_at: hit.created_at || new Date().toISOString(),
          score: hit.points || 0,
          replies: hit.num_comments || 0,
          is_reply: 0,
          parent_id: null
        }));
    } catch (err) {
      console.error(`[HN] Front page check error: ${err.message}`);
      return [];
    }
  }

  _insertPosts(posts) {
    const insertMany = this.db.transaction((items) => {
      for (const p of items) {
        this.insertPost.run(
          p.id, p.author, p.content, p.url, p.created_at,
          p.score, p.replies, p.is_reply, p.parent_id
        );
      }
    });
    insertMany(posts);
  }
}

module.exports = HackerNewsCollector;
