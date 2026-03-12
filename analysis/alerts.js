/**
 * Alert System — detects anomalies and generates alerts
 * Types: volume_spike, sentiment_shift, trending_narrative, competitor_mention
 * Urgency levels: low, medium, high, critical
 */

require('dotenv').config();

class AlertSystem {
  constructor(db, config = {}) {
    this.db = db;
    this.volumeSpikeMultiplier = config.volumeSpikeMultiplier || parseFloat(process.env.ALERT_VOLUME_SPIKE_MULTIPLIER) || 3;
    this.negativeThreshold = config.negativeThreshold || parseFloat(process.env.ALERT_NEGATIVE_SENTIMENT_THRESHOLD) || -0.5;
    this.minMentions = config.minMentions || parseInt(process.env.ALERT_URGENCY_MIN_MENTIONS) || 10;

    this.insertAlert = db.prepare(`
      INSERT INTO alerts (type, urgency, title, description, data)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  /**
   * Run all alert checks
   */
  runChecks() {
    console.log('\n[Alerts] Running checks...');
    const alerts = [];

    alerts.push(...this.checkVolumeSpikes());
    alerts.push(...this.checkSentimentShifts());
    alerts.push(...this.checkTrendingNarratives());
    alerts.push(...this.checkCompetitorMentions());
    alerts.push(...this.checkAnthropicSpikes());

    if (alerts.length > 0) {
      console.log(`[Alerts] Generated ${alerts.length} new alerts`);
    } else {
      console.log('[Alerts] No new alerts');
    }

    return alerts;
  }

  /**
   * Detect volume spikes — when post volume exceeds N× the 7-day average
   */
  checkVolumeSpikes() {
    const alerts = [];

    // Get today's count by platform
    const todayCounts = this.db.prepare(`
      SELECT platform, COUNT(*) as count
      FROM posts
      WHERE collected_at >= datetime('now', '-1 day')
      GROUP BY platform
    `).all();

    // Get 7-day daily average by platform
    const avgCounts = this.db.prepare(`
      SELECT platform, CAST(COUNT(*) AS REAL) / 7.0 as avg_daily
      FROM posts
      WHERE collected_at >= datetime('now', '-7 days')
        AND collected_at < datetime('now', '-1 day')
      GROUP BY platform
    `).all();

    const avgMap = {};
    avgCounts.forEach(a => { avgMap[a.platform] = a.avg_daily; });

    for (const { platform, count } of todayCounts) {
      const avg = avgMap[platform] || 0;
      if (avg > 0 && count > avg * this.volumeSpikeMultiplier) {
        const multiplier = (count / avg).toFixed(1);
        const urgency = count > avg * 5 ? 'critical' : count > avg * 4 ? 'high' : 'medium';

        const alert = {
          type: 'volume_spike',
          urgency,
          title: `Volume spike on ${platform}: ${multiplier}× normal`,
          description: `${count} posts today vs ${avg.toFixed(0)} daily average (${multiplier}× increase). This may indicate a breaking story or viral moment.`,
          data: JSON.stringify({ platform, todayCount: count, avgDaily: avg, multiplier: parseFloat(multiplier) })
        };

        this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Detect sentiment shifts — when average sentiment drops significantly
   */
  checkSentimentShifts() {
    const alerts = [];

    // Compare last 6 hours to previous 24 hours
    const recent = this.db.prepare(`
      SELECT
        AVG(sentiment_score) as avg_score,
        COUNT(*) as count
      FROM posts
      WHERE sentiment_score IS NOT NULL
        AND collected_at >= datetime('now', '-6 hours')
    `).get();

    const baseline = this.db.prepare(`
      SELECT
        AVG(sentiment_score) as avg_score,
        COUNT(*) as count
      FROM posts
      WHERE sentiment_score IS NOT NULL
        AND collected_at >= datetime('now', '-30 hours')
        AND collected_at < datetime('now', '-6 hours')
    `).get();

    if (recent.count >= 5 && baseline.count >= 10) {
      const shift = recent.avg_score - baseline.avg_score;

      // Alert on significant negative shifts
      if (shift < -0.15) {
        const urgency = shift < -0.3 ? 'critical' : shift < -0.2 ? 'high' : 'medium';

        const alert = {
          type: 'sentiment_shift',
          urgency,
          title: `Sentiment declining: ${shift.toFixed(3)} shift in 6 hours`,
          description: `Average sentiment dropped from ${baseline.avg_score.toFixed(3)} to ${recent.avg_score.toFixed(3)} (Δ${shift.toFixed(3)}). ${recent.count} recent posts analyzed.`,
          data: JSON.stringify({
            recentAvg: recent.avg_score,
            baselineAvg: baseline.avg_score,
            shift,
            recentCount: recent.count,
            baselineCount: baseline.count
          })
        };

        this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
        alerts.push(alert);
      }

      // Also alert on very negative overall sentiment
      if (recent.avg_score < this.negativeThreshold) {
        const urgency = recent.avg_score < -0.7 ? 'critical' : 'high';

        const alert = {
          type: 'sentiment_shift',
          urgency,
          title: `Highly negative sentiment: ${recent.avg_score.toFixed(3)}`,
          description: `Average sentiment in the last 6 hours is ${recent.avg_score.toFixed(3)}, below the threshold of ${this.negativeThreshold}.`,
          data: JSON.stringify({ avgScore: recent.avg_score, threshold: this.negativeThreshold, count: recent.count })
        };

        this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Detect trending narratives — topics that are suddenly appearing much more frequently
   */
  checkTrendingNarratives() {
    const alerts = [];

    // Get key phrase frequency in last 12 hours vs previous 48 hours
    const recentPosts = this.db.prepare(`
      SELECT key_phrases FROM posts
      WHERE key_phrases IS NOT NULL
        AND collected_at >= datetime('now', '-12 hours')
    `).all();

    const baselinePosts = this.db.prepare(`
      SELECT key_phrases FROM posts
      WHERE key_phrases IS NOT NULL
        AND collected_at >= datetime('now', '-60 hours')
        AND collected_at < datetime('now', '-12 hours')
    `).all();

    const recentPhrases = this._countPhrases(recentPosts);
    const baselinePhrases = this._countPhrases(baselinePosts);
    const baselineHours = 48;
    const recentHours = 12;

    for (const [phrase, recentCount] of Object.entries(recentPhrases)) {
      if (recentCount < 3) continue; // Minimum threshold

      const baselineCount = baselinePhrases[phrase] || 0;
      const recentRate = recentCount / recentHours;
      const baselineRate = baselineCount / baselineHours;

      if (baselineRate > 0 && recentRate > baselineRate * 3) {
        const spike = (recentRate / baselineRate).toFixed(1);
        const urgency = recentCount >= 20 ? 'high' : recentCount >= 10 ? 'medium' : 'low';

        const alert = {
          type: 'trending_narrative',
          urgency,
          title: `Trending: "${phrase}" (${spike}× increase)`,
          description: `"${phrase}" appeared ${recentCount} times in the last 12h vs ${baselineCount} in the prior 48h (${spike}× rate increase).`,
          data: JSON.stringify({ phrase, recentCount, baselineCount, spike: parseFloat(spike) })
        };

        this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Monitor competitor mentions in context of Anthropic
   */
  checkCompetitorMentions() {
    const alerts = [];

    const recentMentions = this.db.prepare(`
      SELECT mentions_competitors, COUNT(*) as count
      FROM posts
      WHERE mentions_anthropic = 1
        AND mentions_competitors IS NOT NULL
        AND mentions_competitors != '[]'
        AND collected_at >= datetime('now', '-12 hours')
      GROUP BY mentions_competitors
      ORDER BY count DESC
      LIMIT 5
    `).all();

    for (const row of recentMentions) {
      if (row.count >= 5) {
        const competitors = JSON.parse(row.mentions_competitors);
        const urgency = row.count >= 20 ? 'high' : 'medium';

        const alert = {
          type: 'competitor_mention',
          urgency,
          title: `Anthropic compared with ${competitors.join(', ')} (${row.count} posts)`,
          description: `${row.count} posts in the last 12h mention Anthropic alongside ${competitors.join(', ')}. Review for narrative positioning.`,
          data: JSON.stringify({ competitors, count: row.count })
        };

        this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  /**
   * Check for sudden spikes in Anthropic mentions specifically
   */
  checkAnthropicSpikes() {
    const alerts = [];

    const recentCount = this.db.prepare(`
      SELECT COUNT(*) as c FROM posts
      WHERE mentions_anthropic = 1
        AND collected_at >= datetime('now', '-6 hours')
    `).get().c;

    const baselineAvg = this.db.prepare(`
      SELECT CAST(COUNT(*) AS REAL) / 7.0 / 4.0 as avg_6h
      FROM posts
      WHERE mentions_anthropic = 1
        AND collected_at >= datetime('now', '-7 days')
        AND collected_at < datetime('now', '-6 hours')
    `).get().avg_6h || 0;

    if (baselineAvg > 0 && recentCount > baselineAvg * this.volumeSpikeMultiplier) {
      const multiplier = (recentCount / baselineAvg).toFixed(1);

      // Check sentiment of these mentions
      const sentimentData = this.db.prepare(`
        SELECT AVG(sentiment_score) as avg, MIN(sentiment_score) as min
        FROM posts
        WHERE mentions_anthropic = 1
          AND sentiment_score IS NOT NULL
          AND collected_at >= datetime('now', '-6 hours')
      `).get();

      const urgency = recentCount > baselineAvg * 5 ? 'critical'
        : sentimentData.avg < -0.3 ? 'critical'
        : recentCount > baselineAvg * 3 ? 'high' : 'medium';

      const alert = {
        type: 'volume_spike',
        urgency,
        title: `Anthropic mention spike: ${multiplier}× normal (${recentCount} posts)`,
        description: `${recentCount} Anthropic mentions in 6h vs ~${baselineAvg.toFixed(0)} average. Avg sentiment: ${sentimentData.avg?.toFixed(3) || 'N/A'}.`,
        data: JSON.stringify({
          count: recentCount,
          baseline: baselineAvg,
          multiplier: parseFloat(multiplier),
          avgSentiment: sentimentData.avg,
          minSentiment: sentimentData.min
        })
      };

      this.insertAlert.run(alert.type, alert.urgency, alert.title, alert.description, alert.data);
      alerts.push(alert);
    }

    return alerts;
  }

  /**
   * Get recent alerts
   */
  getRecent(limit = 20) {
    return this.db.prepare(`
      SELECT * FROM alerts
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  /**
   * Get unacknowledged alerts by urgency
   */
  getUnacknowledged() {
    return this.db.prepare(`
      SELECT * FROM alerts
      WHERE acknowledged = 0
      ORDER BY
        CASE urgency
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at DESC
    `).all();
  }

  /**
   * Acknowledge an alert
   */
  acknowledge(alertId, by = 'system') {
    this.db.prepare(`
      UPDATE alerts SET acknowledged = 1, acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ?
      WHERE id = ?
    `).run(by, alertId);
  }

  _countPhrases(posts) {
    const counts = {};
    for (const { key_phrases } of posts) {
      try {
        const phrases = JSON.parse(key_phrases);
        for (const p of phrases) {
          const lower = p.toLowerCase().trim();
          if (lower.length > 2) {
            counts[lower] = (counts[lower] || 0) + 1;
          }
        }
      } catch {}
    }
    return counts;
  }
}

// CLI execution
if (require.main === module) {
  const { initDB } = require('../db/schema');
  const db = initDB();
  const alertSystem = new AlertSystem(db);
  const alerts = alertSystem.runChecks();
  console.log(`\nGenerated ${alerts.length} alerts`);
  db.close();
}

module.exports = AlertSystem;
