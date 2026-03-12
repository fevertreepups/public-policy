/**
 * Sentiment Analysis Pipeline
 * Uses `sentiment` (AFINN-based) + `natural` (NLP toolkit) + `compromise` (entity extraction)
 * Processes unanalyzed posts and writes scores back to the DB
 */

require('dotenv').config();
const Sentiment = require('sentiment');
const natural = require('natural');
const nlp = require('compromise');

const sentimentAnalyzer = new Sentiment();
const tokenizer = new natural.WordTokenizer();
const TfIdf = natural.TfIdf;

// ── Policy domain lexicon (boosts/penalizes domain-specific terms) ──
const DOMAIN_LEXICON = {
  // Positive policy signals
  'responsible': 2, 'transparent': 2, 'accountable': 2, 'safety': 1,
  'guardrails': 1, 'oversight': 1, 'governance': 1, 'innovation': 2,
  'collaboration': 2, 'trust': 2, 'voluntary': 1, 'compliance': 1,
  'beneficial': 3, 'protect': 1, 'empower': 2, 'progress': 2,

  // Negative policy signals
  'stifle': -2, 'overreach': -2, 'restrict': -1, 'ban': -2,
  'reckless': -3, 'dangerous': -2, 'threat': -2, 'loophole': -2,
  'lobby': -1, 'capture': -2, 'monopoly': -3, 'censorship': -3,
  'surveillance': -2, 'existential': -2, 'doom': -3, 'hype': -2,

  // Anthropic-specific
  'anthropic': 0, 'claude': 0, 'dario': 0, 'amodei': 0,
  'constitutional': 1, 'rlhf': 0
};

// ── Topic classifiers ──
const TOPIC_PATTERNS = {
  'frontier_safety': /\b(frontier|safety|alignment|catastrophic|existential|x-risk|agi|superintelligence|red team)\b/i,
  'regulation': /\b(regulat|legislat|law|act|bill|congress|parliament|mandate|enforce|compliance)\b/i,
  'copyright': /\b(copyright|training data|fair use|intellectual property|ip rights|scraping|consent)\b/i,
  'open_source': /\b(open.?source|open.?weight|release|access|democratiz|llama|mistral)\b/i,
  'competition': /\b(monopol|antitrust|competi|market|dominan|consolidat)\b/i,
  'labor': /\b(job|worker|employ|automat|displace|workforce|labor|labour)\b/i,
  'national_security': /\b(national security|defense|military|cyber|biosecurity|china|arms race)\b/i,
  'elections': /\b(election|deepfake|misinformation|disinformation|political|campaign|voter)\b/i,
  'education': /\b(school|student|university|education|academic|research|cheating|plagiar)\b/i,
  'healthcare': /\b(health|medical|patient|clinical|diagnos|drug|pharma)\b/i,
  'privacy': /\b(privacy|surveillance|data protection|gdpr|biometric|facial recogn)\b/i
};

const POLICY_AREA_PATTERNS = {
  'frontier_safety': /\b(frontier|safety|alignment|responsible scaling|agi|catastrophic)\b/i,
  'copyright': /\b(copyright|training data|fair use|intellectual property)\b/i,
  'eu_ai_act': /\b(eu ai act|european|brussels|gpai|general.purpose)\b/i,
  'us_executive_order': /\b(executive order|14110|eo |white house|nist|commerce department)\b/i,
  'uk_ai_safety': /\b(uk|aisi|ai safety institute|bletchley|british)\b/i,
  'state_regulation': /\b(california|colorado|texas|state law|sb.?1047|state.?level)\b/i,
  'international': /\b(g7|un|oecd|global|multilateral|hiroshima|international)\b/i
};

const JURISDICTION_PATTERNS = {
  'US': /\b(us|usa|united states|american|congress|senate|house|federal|california|washington|nist)\b/i,
  'EU': /\b(eu|european|brussels|strasbourg|gdpr|ai act|european commission|parliament)\b/i,
  'UK': /\b(uk|united kingdom|british|london|westminster|ofcom|aisi|bletchley)\b/i,
  'CN': /\b(china|chinese|beijing|cac|alibaba|baidu)\b/i,
  'CA': /\b(canada|canadian|ottawa|toronto)\b/i,
  'JP': /\b(japan|japanese|tokyo)\b/i,
  'Global': /\b(global|worldwide|international|g7|g20|un|oecd|multilateral)\b/i
};

const COMPETITOR_PATTERNS = {
  'OpenAI': /\b(openai|gpt|chatgpt|sam altman|o1|dall.?e)\b/i,
  'Google': /\b(google|deepmind|gemini|bard|sundar|demis hassabis)\b/i,
  'Meta': /\b(meta|facebook|llama|zuckerberg|instagram)\b/i,
  'Microsoft': /\b(microsoft|copilot|bing|satya|azure openai)\b/i,
  'xAI': /\b(xai|grok|elon musk)\b/i,
  'Mistral': /\b(mistral)\b/i,
  'Cohere': /\b(cohere)\b/i
};

class SentimentPipeline {
  constructor(db) {
    this.db = db;

    this.getUnanalyzed = db.prepare(`
      SELECT id, content FROM posts
      WHERE sentiment_score IS NULL
      ORDER BY collected_at DESC
      LIMIT ?
    `);

    this.updatePost = db.prepare(`
      UPDATE posts SET
        sentiment_score = ?,
        sentiment_label = ?,
        sentiment_magnitude = ?,
        topics = ?,
        policy_areas = ?,
        jurisdictions = ?,
        mentions_anthropic = ?,
        mentions_competitors = ?,
        key_phrases = ?
      WHERE id = ?
    `);
  }

  /**
   * Analyze sentiment of a single text
   */
  analyzeSentiment(text) {
    if (!text || text.trim().length === 0) {
      return { score: 0, label: 'neutral', magnitude: 0 };
    }

    // AFINN-based sentiment with domain lexicon
    const result = sentimentAnalyzer.analyze(text, { extras: DOMAIN_LEXICON });

    // Normalize score to -1.0 to 1.0 range
    const wordCount = result.tokens.length || 1;
    const rawScore = result.score / Math.sqrt(wordCount); // Dampen by word count
    const score = Math.max(-1, Math.min(1, rawScore / 5)); // Clamp to [-1, 1]

    // Magnitude = confidence (based on how many sentiment words were found)
    const sentimentWords = (result.positive?.length || 0) + (result.negative?.length || 0);
    const magnitude = Math.min(1, sentimentWords / Math.max(5, wordCount * 0.3));

    // Label
    let label;
    if (score > 0.15) label = 'positive';
    else if (score < -0.15) label = 'negative';
    else if (magnitude > 0.3 && result.positive.length > 0 && result.negative.length > 0) label = 'mixed';
    else label = 'neutral';

    return {
      score: parseFloat(score.toFixed(4)),
      label,
      magnitude: parseFloat(magnitude.toFixed(4))
    };
  }

  /**
   * Classify topics in text
   */
  classifyTopics(text) {
    const topics = [];
    for (const [topic, pattern] of Object.entries(TOPIC_PATTERNS)) {
      if (pattern.test(text)) topics.push(topic);
    }
    return topics;
  }

  /**
   * Detect policy areas
   */
  classifyPolicyAreas(text) {
    const areas = [];
    for (const [area, pattern] of Object.entries(POLICY_AREA_PATTERNS)) {
      if (pattern.test(text)) areas.push(area);
    }
    return areas;
  }

  /**
   * Detect jurisdictions
   */
  classifyJurisdictions(text) {
    const jurs = [];
    for (const [jur, pattern] of Object.entries(JURISDICTION_PATTERNS)) {
      if (pattern.test(text)) jurs.push(jur);
    }
    return jurs;
  }

  /**
   * Detect competitor mentions
   */
  detectCompetitors(text) {
    const competitors = [];
    for (const [name, pattern] of Object.entries(COMPETITOR_PATTERNS)) {
      if (pattern.test(text)) competitors.push(name);
    }
    return competitors;
  }

  /**
   * Extract key phrases using TF-IDF on the text
   */
  extractKeyPhrases(text) {
    const doc = nlp(text);

    // Extract noun phrases and named entities
    const nouns = doc.nouns().out('array').slice(0, 10);
    const people = doc.people().out('array').slice(0, 5);
    const orgs = doc.organizations().out('array').slice(0, 5);

    // Combine and deduplicate
    const phrases = [...new Set([...people, ...orgs, ...nouns])]
      .filter(p => p.length > 2 && p.length < 60)
      .slice(0, 15);

    return phrases;
  }

  /**
   * Check if text mentions Anthropic
   */
  mentionsAnthropic(text) {
    return /\b(anthropic|claude\s?(ai|model|chatbot|assistant)?|dario\s?amodei|daniela\s?amodei|jack\s?clark)\b/i.test(text);
  }

  /**
   * Process a batch of unanalyzed posts
   */
  processBatch(batchSize = 500) {
    const posts = this.getUnanalyzed.all(batchSize);

    if (posts.length === 0) {
      console.log('[Sentiment] No unanalyzed posts found');
      return { processed: 0 };
    }

    console.log(`[Sentiment] Processing ${posts.length} posts...`);
    let processed = 0;

    const updateMany = this.db.transaction((items) => {
      for (const { id, content } of items) {
        const sentiment = this.analyzeSentiment(content);
        const topics = this.classifyTopics(content);
        const policyAreas = this.classifyPolicyAreas(content);
        const jurisdictions = this.classifyJurisdictions(content);
        const isAnthropic = this.mentionsAnthropic(content) ? 1 : 0;
        const competitors = this.detectCompetitors(content);
        const keyPhrases = this.extractKeyPhrases(content);

        this.updatePost.run(
          sentiment.score,
          sentiment.label,
          sentiment.magnitude,
          JSON.stringify(topics),
          JSON.stringify(policyAreas),
          JSON.stringify(jurisdictions),
          isAnthropic,
          JSON.stringify(competitors),
          JSON.stringify(keyPhrases),
          id
        );
        processed++;
      }
    });

    updateMany(posts);
    console.log(`[Sentiment] Processed ${processed} posts`);

    // Print quick stats
    this._printStats();

    return { processed };
  }

  /**
   * Print analysis stats
   */
  _printStats() {
    const stats = this.db.prepare(`
      SELECT
        sentiment_label,
        COUNT(*) as count,
        ROUND(AVG(sentiment_score), 3) as avg_score
      FROM posts
      WHERE sentiment_score IS NOT NULL
      GROUP BY sentiment_label
    `).all();

    console.log('[Sentiment] Distribution:');
    stats.forEach(s => {
      console.log(`  ${s.sentiment_label}: ${s.count} posts (avg score: ${s.avg_score})`);
    });

    const anthropicCount = this.db.prepare(
      'SELECT COUNT(*) as c FROM posts WHERE mentions_anthropic = 1'
    ).get().c;
    console.log(`[Sentiment] Anthropic mentions: ${anthropicCount}`);
  }
}

// CLI execution
if (require.main === module) {
  const { initDB } = require('../db/schema');
  const db = initDB();
  const pipeline = new SentimentPipeline(db);
  pipeline.processBatch(1000);
  db.close();
}

module.exports = SentimentPipeline;
