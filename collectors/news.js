/**
 * News/RSS Collector — Google News RSS + custom RSS feeds
 * Free — no authentication required
 */

const RSSParser = require('rss-parser');
// Uses Node 18+ built-in fetch

const parser = new RSSParser({
  timeout: 10000,
  headers: { 'User-Agent': 'AnthropicPerceptionEngine/1.0' }
});

// Google News RSS search URL template
const GNEWS_RSS = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// Curated RSS feeds for AI policy news
const CURATED_FEEDS = [
  { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
  { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { name: 'Ars Technica AI', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
  { name: 'Wired AI', url: 'https://www.wired.com/feed/tag/ai/latest/rss' },
  { name: 'Reuters Tech', url: 'https://www.reutersagency.com/feed/?taxonomy=best-topics&post_type=best' }
];

class NewsCollector {
  constructor(db) {
    this.db = db;
    this.enabled = true;

    this.insertPost = db.prepare(`
      INSERT OR IGNORE INTO posts (id, platform, author, content, url, created_at)
      VALUES (?, 'news', ?, ?, ?, ?)
    `);
  }

  /**
   * Search Google News RSS for a query
   */
  async searchGoogleNews(query) {
    try {
      const feed = await parser.parseURL(GNEWS_RSS(query));
      return (feed.items || []).map(item => ({
        id: `news_${this._hashId(item.link || item.title)}`,
        author: item.creator || item['dc:creator'] || this._extractSource(item.title),
        content: this._cleanContent(item.title, item.contentSnippet || item.content),
        url: item.link,
        created_at: item.isoDate || item.pubDate || new Date().toISOString()
      }));
    } catch (err) {
      console.error(`[News] Google News error for "${query}": ${err.message}`);
      return [];
    }
  }

  /**
   * Fetch a curated RSS feed and filter for relevant articles
   */
  async fetchFeed(feedInfo) {
    try {
      const feed = await parser.parseURL(feedInfo.url);
      const keywords = /\b(anthropic|claude|ai policy|ai regulation|ai safety|ai governance|openai|frontier|ai act|executive order|ai legislation|artificial intelligence|gpt|deepmind|ai law)\b/i;

      return (feed.items || [])
        .filter(item => {
          const text = `${item.title || ''} ${item.contentSnippet || ''} ${item.content || ''}`;
          return keywords.test(text);
        })
        .map(item => ({
          id: `news_${this._hashId(item.link || item.title)}`,
          author: item.creator || item['dc:creator'] || feedInfo.name,
          content: this._cleanContent(item.title, item.contentSnippet || item.content),
          url: item.link,
          created_at: item.isoDate || item.pubDate || new Date().toISOString()
        }));
    } catch (err) {
      console.error(`[News] Feed error for ${feedInfo.name}: ${err.message}`);
      return [];
    }
  }

  /**
   * Full collection run
   */
  async collect() {
    let totalCollected = 0;

    // 1. Search Google News for tracked queries
    const queries = this.db.prepare(
      "SELECT query FROM tracked_queries WHERE enabled = 1 AND (platforms LIKE '%news%' OR platforms LIKE '%all%')"
    ).all();

    for (const { query } of queries) {
      const articles = await this.searchGoogleNews(query);
      this._insertPosts(articles);
      totalCollected += articles.length;
      await new Promise(r => setTimeout(r, 1500));
    }

    // 2. Check curated feeds
    for (const feed of CURATED_FEEDS) {
      const articles = await this.fetchFeed(feed);
      this._insertPosts(articles);
      totalCollected += articles.length;
    }

    console.log(`[News] Collected ${totalCollected} articles (${queries.length} queries + ${CURATED_FEEDS.length} feeds)`);
    return { platform: 'news', collected: totalCollected };
  }

  _insertPosts(posts) {
    const insertMany = this.db.transaction((items) => {
      for (const p of items) {
        this.insertPost.run(p.id, p.author, p.content, p.url, p.created_at);
      }
    });
    insertMany(posts);
  }

  _cleanContent(title, snippet) {
    const clean = (snippet || '')
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/g, ' ')
      .trim();
    return title ? `${title}\n\n${clean}` : clean;
  }

  _extractSource(title) {
    // Google News titles often end with " - Source Name"
    const match = (title || '').match(/ - ([^-]+)$/);
    return match ? match[1].trim() : 'Unknown';
  }

  _hashId(str) {
    let hash = 0;
    for (let i = 0; i < (str || '').length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}

module.exports = NewsCollector;
