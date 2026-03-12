/**
 * Narrative Report Generator
 * Produces daily/weekly summaries with sentiment trends, top narratives,
 * platform breakdowns, and Anthropic-specific insights
 */

require('dotenv').config();

class ReportGenerator {
  constructor(db) {
    this.db = db;

    this.insertReport = db.prepare(`
      INSERT INTO reports (period_start, period_end, type, title, summary, data, html)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Generate a report for a given period
   */
  generate(type = 'daily') {
    const now = new Date();
    let periodStart, periodEnd, title;

    if (type === 'daily') {
      periodEnd = now.toISOString();
      periodStart = new Date(now - 86400000).toISOString();
      title = `Daily Perception Report — ${now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    } else if (type === 'weekly') {
      periodEnd = now.toISOString();
      periodStart = new Date(now - 7 * 86400000).toISOString();
      title = `Weekly Perception Report — Week of ${new Date(now - 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    } else {
      throw new Error(`Unknown report type: ${type}`);
    }

    console.log(`[Report] Generating ${type} report: ${title}`);

    const data = {
      overview: this._getOverview(periodStart, periodEnd),
      sentiment: this._getSentimentBreakdown(periodStart, periodEnd),
      platforms: this._getPlatformBreakdown(periodStart, periodEnd),
      anthropic: this._getAnthropicInsights(periodStart, periodEnd),
      competitors: this._getCompetitorAnalysis(periodStart, periodEnd),
      topPosts: this._getTopPosts(periodStart, periodEnd),
      narratives: this._getTopNarratives(periodStart, periodEnd),
      policyAreas: this._getPolicyAreaBreakdown(periodStart, periodEnd),
      alerts: this._getAlertsSummary(periodStart, periodEnd),
      trends: this._getSentimentTrend(periodStart, periodEnd)
    };

    const summary = this._generateExecutiveSummary(data);
    const html = this._renderHTML(title, data, summary);

    this.insertReport.run(periodStart, periodEnd, type, title, summary, JSON.stringify(data), html);
    console.log(`[Report] ${type} report saved`);

    return { title, summary, data, html };
  }

  _getOverview(start, end) {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total_posts,
        COUNT(DISTINCT platform) as platforms,
        COUNT(DISTINCT author) as unique_authors,
        SUM(CASE WHEN mentions_anthropic = 1 THEN 1 ELSE 0 END) as anthropic_mentions,
        ROUND(AVG(sentiment_score), 4) as avg_sentiment,
        SUM(likes + reposts + replies) as total_engagement
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND sentiment_score IS NOT NULL
    `).get(start, end);
  }

  _getSentimentBreakdown(start, end) {
    return this.db.prepare(`
      SELECT
        sentiment_label,
        COUNT(*) as count,
        ROUND(AVG(sentiment_score), 4) as avg_score,
        ROUND(AVG(sentiment_magnitude), 4) as avg_magnitude
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND sentiment_label IS NOT NULL
      GROUP BY sentiment_label
      ORDER BY count DESC
    `).all(start, end);
  }

  _getPlatformBreakdown(start, end) {
    return this.db.prepare(`
      SELECT
        platform,
        COUNT(*) as count,
        ROUND(AVG(sentiment_score), 4) as avg_sentiment,
        SUM(CASE WHEN mentions_anthropic = 1 THEN 1 ELSE 0 END) as anthropic_mentions,
        SUM(likes) as total_likes,
        SUM(reposts) as total_reposts,
        SUM(replies) as total_replies
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND sentiment_score IS NOT NULL
      GROUP BY platform
      ORDER BY count DESC
    `).all(start, end);
  }

  _getAnthropicInsights(start, end) {
    const overall = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        ROUND(AVG(sentiment_score), 4) as avg_sentiment,
        SUM(CASE WHEN sentiment_label = 'positive' THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN sentiment_label = 'negative' THEN 1 ELSE 0 END) as negative,
        SUM(CASE WHEN sentiment_label = 'neutral' THEN 1 ELSE 0 END) as neutral,
        SUM(CASE WHEN sentiment_label = 'mixed' THEN 1 ELSE 0 END) as mixed
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND mentions_anthropic = 1
        AND sentiment_score IS NOT NULL
    `).get(start, end);

    const topPositive = this.db.prepare(`
      SELECT content, url, platform, sentiment_score, likes, reposts
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND mentions_anthropic = 1
        AND sentiment_label = 'positive'
      ORDER BY sentiment_score DESC, (likes + reposts) DESC
      LIMIT 5
    `).all(start, end);

    const topNegative = this.db.prepare(`
      SELECT content, url, platform, sentiment_score, likes, reposts
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND mentions_anthropic = 1
        AND sentiment_label = 'negative'
      ORDER BY sentiment_score ASC, (likes + reposts) DESC
      LIMIT 5
    `).all(start, end);

    return { overall, topPositive, topNegative };
  }

  _getCompetitorAnalysis(start, end) {
    const posts = this.db.prepare(`
      SELECT mentions_competitors FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND mentions_competitors IS NOT NULL
        AND mentions_competitors != '[]'
    `).all(start, end);

    const counts = {};
    for (const { mentions_competitors } of posts) {
      try {
        const comps = JSON.parse(mentions_competitors);
        for (const c of comps) {
          counts[c] = (counts[c] || 0) + 1;
        }
      } catch {}
    }

    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }

  _getTopPosts(start, end) {
    return this.db.prepare(`
      SELECT content, url, platform, author, sentiment_score, sentiment_label,
             likes, reposts, replies, score, created_at
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
      ORDER BY (likes + reposts + replies + score) DESC
      LIMIT 20
    `).all(start, end);
  }

  _getTopNarratives(start, end) {
    const posts = this.db.prepare(`
      SELECT key_phrases, topics FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND key_phrases IS NOT NULL
    `).all(start, end);

    const phraseCounts = {};
    const topicCounts = {};

    for (const { key_phrases, topics } of posts) {
      try {
        const phrases = JSON.parse(key_phrases);
        for (const p of phrases) {
          const lower = p.toLowerCase().trim();
          if (lower.length > 2) phraseCounts[lower] = (phraseCounts[lower] || 0) + 1;
        }
      } catch {}

      try {
        const topicList = JSON.parse(topics);
        for (const t of topicList) {
          topicCounts[t] = (topicCounts[t] || 0) + 1;
        }
      } catch {}
    }

    const topPhrases = Object.entries(phraseCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([phrase, count]) => ({ phrase, count }));

    const topTopics = Object.entries(topicCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => ({ topic, count }));

    return { topPhrases, topTopics };
  }

  _getPolicyAreaBreakdown(start, end) {
    const posts = this.db.prepare(`
      SELECT policy_areas, sentiment_score FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND policy_areas IS NOT NULL
        AND policy_areas != '[]'
    `).all(start, end);

    const areas = {};
    for (const { policy_areas, sentiment_score } of posts) {
      try {
        const policyList = JSON.parse(policy_areas);
        for (const area of policyList) {
          if (!areas[area]) areas[area] = { count: 0, totalSentiment: 0 };
          areas[area].count++;
          areas[area].totalSentiment += sentiment_score || 0;
        }
      } catch {}
    }

    return Object.entries(areas)
      .map(([area, data]) => ({
        area,
        count: data.count,
        avgSentiment: parseFloat((data.totalSentiment / data.count).toFixed(4))
      }))
      .sort((a, b) => b.count - a.count);
  }

  _getAlertsSummary(start, end) {
    return this.db.prepare(`
      SELECT type, urgency, title, description, created_at
      FROM alerts
      WHERE created_at BETWEEN ? AND ?
      ORDER BY
        CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
    `).all(start, end);
  }

  _getSentimentTrend(start, end) {
    return this.db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', collected_at) as hour,
        COUNT(*) as count,
        ROUND(AVG(sentiment_score), 4) as avg_sentiment,
        SUM(CASE WHEN mentions_anthropic = 1 THEN 1 ELSE 0 END) as anthropic_count
      FROM posts
      WHERE collected_at BETWEEN ? AND ?
        AND sentiment_score IS NOT NULL
      GROUP BY hour
      ORDER BY hour
    `).all(start, end);
  }

  _generateExecutiveSummary(data) {
    const o = data.overview;
    if (!o || o.total_posts === 0) return 'No data collected in this period.';

    const parts = [];
    parts.push(`Monitored ${o.total_posts} posts across ${o.platforms} platforms from ${o.unique_authors} unique authors.`);

    // Sentiment summary
    const sentLabel = o.avg_sentiment > 0.1 ? 'positive' : o.avg_sentiment < -0.1 ? 'negative' : 'neutral';
    parts.push(`Overall sentiment is ${sentLabel} (${o.avg_sentiment.toFixed(3)}).`);

    // Anthropic mentions
    if (o.anthropic_mentions > 0) {
      const pct = ((o.anthropic_mentions / o.total_posts) * 100).toFixed(1);
      parts.push(`Anthropic was mentioned in ${o.anthropic_mentions} posts (${pct}% of total).`);

      if (data.anthropic?.overall) {
        const a = data.anthropic.overall;
        parts.push(`Anthropic sentiment: ${a.avg_sentiment?.toFixed(3)} avg (${a.positive} positive, ${a.negative} negative, ${a.neutral} neutral).`);
      }
    }

    // Top narratives
    if (data.narratives?.topPhrases?.length > 0) {
      const top3 = data.narratives.topPhrases.slice(0, 3).map(p => `"${p.phrase}"`).join(', ');
      parts.push(`Trending phrases: ${top3}.`);
    }

    // Alerts
    if (data.alerts?.length > 0) {
      const critical = data.alerts.filter(a => a.urgency === 'critical').length;
      const high = data.alerts.filter(a => a.urgency === 'high').length;
      if (critical > 0 || high > 0) {
        parts.push(`${data.alerts.length} alerts generated (${critical} critical, ${high} high urgency).`);
      }
    }

    return parts.join(' ');
  }

  _renderHTML(title, data, summary) {
    const sentimentRows = (data.sentiment || [])
      .map(s => `<tr><td>${s.sentiment_label}</td><td>${s.count}</td><td>${s.avg_score}</td></tr>`)
      .join('');

    const platformRows = (data.platforms || [])
      .map(p => `<tr><td>${p.platform}</td><td>${p.count}</td><td>${p.avg_sentiment}</td><td>${p.anthropic_mentions}</td><td>${p.total_likes + p.total_reposts + p.total_replies}</td></tr>`)
      .join('');

    const alertRows = (data.alerts || []).slice(0, 10)
      .map(a => `<tr class="urgency-${a.urgency}"><td><span class="badge ${a.urgency}">${a.urgency}</span></td><td>${a.title}</td><td>${a.created_at}</td></tr>`)
      .join('');

    const topPostRows = (data.topPosts || []).slice(0, 10)
      .map(p => {
        const snippet = (p.content || '').substring(0, 120) + '...';
        return `<tr><td>${p.platform}</td><td>${snippet}</td><td>${p.sentiment_label}</td><td>${p.likes + p.reposts + p.replies + p.score}</td><td><a href="${p.url}" target="_blank">link</a></td></tr>`;
      })
      .join('');

    const trendLabels = (data.trends || []).map(t => `"${t.hour.split(' ')[1]}"`).join(',');
    const trendValues = (data.trends || []).map(t => t.avg_sentiment).join(',');
    const trendCounts = (data.trends || []).map(t => t.count).join(',');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',system-ui,sans-serif;background:#faf9f5;color:#1a1a1a;padding:40px;max-width:1100px;margin:0 auto;line-height:1.6}
h1{font-family:'Source Serif 4',Georgia,serif;font-size:28px;margin-bottom:8px;color:#1a1a1a}
h2{font-family:'Source Serif 4',Georgia,serif;font-size:20px;margin:32px 0 12px;color:#1a1a1a;border-bottom:1px solid #e8e4dc;padding-bottom:8px}
.meta{color:#6b6560;font-size:13px;margin-bottom:24px}
.summary{background:#fff;border:1px solid #e8e4dc;border-radius:8px;padding:20px;margin-bottom:32px;font-size:15px;line-height:1.7}
table{width:100%;border-collapse:collapse;margin:12px 0 24px;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e8e4dc}
th{background:#f3f1eb;text-align:left;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#6b6560}
td{padding:10px 14px;border-top:1px solid #f0ede6;font-size:14px}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase}
.critical{background:#fee;color:#c33}
.high{background:#fff3e0;color:#e65100}
.medium{background:#fff8e1;color:#f57f17}
.low{background:#e8f5e9;color:#2e7d32}
.chart-container{background:#fff;border:1px solid #e8e4dc;border-radius:8px;padding:20px;margin:12px 0 24px}
canvas{width:100%!important;height:300px!important}
a{color:#4a5580}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:768px){.grid{grid-template-columns:1fr}}
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
</head>
<body>
<h1>${title}</h1>
<div class="meta">Generated ${new Date().toLocaleString()} | ${data.overview?.total_posts || 0} posts analyzed</div>
<div class="summary">${summary}</div>

<div class="grid">
<div>
<h2>Sentiment Distribution</h2>
<table><tr><th>Label</th><th>Count</th><th>Avg Score</th></tr>${sentimentRows}</table>
</div>
<div>
<h2>Platform Breakdown</h2>
<table><tr><th>Platform</th><th>Posts</th><th>Sentiment</th><th>Anthropic</th><th>Engagement</th></tr>${platformRows}</table>
</div>
</div>

<h2>Sentiment Trend</h2>
<div class="chart-container"><canvas id="trendChart"></canvas></div>

<h2>Alerts</h2>
<table><tr><th>Urgency</th><th>Alert</th><th>Time</th></tr>${alertRows || '<tr><td colspan="3">No alerts in this period</td></tr>'}</table>

<h2>Top Posts by Engagement</h2>
<table><tr><th>Platform</th><th>Content</th><th>Sentiment</th><th>Engagement</th><th>Link</th></tr>${topPostRows}</table>

<script>
new Chart(document.getElementById('trendChart'),{
  type:'line',
  data:{
    labels:[${trendLabels}],
    datasets:[
      {label:'Avg Sentiment',data:[${trendValues}],borderColor:'#4a5580',tension:0.3,yAxisID:'y'},
      {label:'Post Volume',data:[${trendCounts}],borderColor:'#c8956c',tension:0.3,yAxisID:'y1',borderDash:[5,5]}
    ]
  },
  options:{
    responsive:true,
    interaction:{mode:'index',intersect:false},
    scales:{
      y:{position:'left',title:{display:true,text:'Sentiment'},min:-1,max:1},
      y1:{position:'right',title:{display:true,text:'Volume'},grid:{drawOnChartArea:false}}
    }
  }
});
</script>
</body>
</html>`;
  }

  /**
   * Get all saved reports
   */
  getAll() {
    return this.db.prepare(`
      SELECT id, created_at, period_start, period_end, type, title, summary
      FROM reports ORDER BY created_at DESC
    `).all();
  }

  /**
   * Get a single report by ID
   */
  getById(id) {
    return this.db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  }
}

// CLI execution
if (require.main === module) {
  const { initDB } = require('../db/schema');
  const db = initDB();
  const gen = new ReportGenerator(db);
  const type = process.argv[2] || 'daily';
  const report = gen.generate(type);
  console.log(`\n${report.title}`);
  console.log(report.summary);
  db.close();
}

module.exports = ReportGenerator;
