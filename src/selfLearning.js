const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const telegram = require('./telegram');

let client;

function init() {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log('[SelfLearning] Initialized');
}

const ANALYSIS_SYSTEM_PROMPT = `You are an email marketing analyst for a sim racing education business run by Jimmy Grills. He sells a PDF book ($36.99) and a video course ($89.95), plus free lead magnets (trail braking PDF, driving drills PDF, throttle audit tool).

You analyze broadcast email performance data to identify what writing patterns, topics, subject lines, and CTAs drive the best engagement (opens, clicks, purchases).

Output specific, actionable writing guidance that will be injected into an email-writing AI's prompt to improve future emails. Focus on concrete patterns backed by the data, not generic marketing advice.

You must respond with valid JSON only. No markdown, no code fences.`;

async function runAnalysis() {
  const broadcasts = db.getBroadcastsWithPerformance();

  // Filter to broadcasts that actually have tracking data
  const tracked = broadcasts.filter(b => b.tracked_count > 0);

  if (tracked.length < 6) {
    const msg = `Only ${tracked.length} broadcast(s) with tracking data. Need at least 6 for meaningful analysis. Skipping.`;
    console.log(`[SelfLearning] ${msg}`);
    await telegram.sendMessage(`📊 Self-learning: ${msg}`);
    return null;
  }

  // Calculate overall averages
  const totalSent = tracked.reduce((s, b) => s + b.tracked_count, 0);
  const totalOpened = tracked.reduce((s, b) => s + b.open_count, 0);
  const totalClicked = tracked.reduce((s, b) => s + b.click_count, 0);
  const totalPurchases = tracked.reduce((s, b) => s + b.purchase_count, 0);
  const totalRevenue = tracked.reduce((s, b) => s + b.purchase_revenue, 0);

  const avgOpenRate = totalSent > 0 ? ((totalOpened / totalSent) * 100).toFixed(1) : '0.0';
  const avgClickRate = totalSent > 0 ? ((totalClicked / totalSent) * 100).toFixed(1) : '0.0';

  // Build per-broadcast data blocks
  const broadcastBlocks = tracked.map(b => {
    const openRate = b.tracked_count > 0 ? ((b.open_count / b.tracked_count) * 100).toFixed(1) : '0.0';
    const clickRate = b.tracked_count > 0 ? ((b.click_count / b.tracked_count) * 100).toFixed(1) : '0.0';

    const clickedUrls = db.getClickedUrlsForBroadcast(b.id);
    const urlLines = clickedUrls.length > 0
      ? clickedUrls.map(u => `  ${u.original_url.replace('https://jimmygrills.com', '')} (${u.clicks} clicks)`).join('\n')
      : '  (no clicks)';

    return `--- Broadcast #${b.id} — ${b.created_at} ---
Subject: "${b.subject}"
Body:
"""
${b.body}
"""
Sent: ${b.tracked_count} | Opened: ${b.open_count} (${openRate}%) | Clicked: ${b.click_count} (${clickRate}%) | Purchases: ${b.purchase_count} ($${b.purchase_revenue.toFixed(2)})
Links clicked:
${urlLines}`;
  }).join('\n\n');

  // Load previous insights for continuity
  const previousInsights = db.getSetting('self_learning_insights');
  const previousBlock = previousInsights
    ? `PREVIOUS INSIGHTS (from last analysis cycle):\n${previousInsights}`
    : 'None — this is the first analysis.';

  const userPrompt = `Analyze the following broadcast email performance data. Each email was sent to the entire mailing list, so open rates and click rates are directly comparable.

BROADCAST PERFORMANCE DATA:
${broadcastBlocks}

OVERALL AVERAGES (across ${tracked.length} broadcasts):
Average open rate: ${avgOpenRate}%
Average click rate: ${avgClickRate}%
Total purchases attributed: ${totalPurchases} ($${totalRevenue.toFixed(2)})

${previousBlock}

TASK:
Compare high-performing emails (above-average open rate AND/OR click rate) against low-performing ones. Identify specific patterns in:

1. SUBJECT LINES: What patterns correlate with higher opens? (length, format, topic framing, questions vs statements, specificity)
2. BODY CONTENT: What writing patterns correlate with higher clicks? (opening style, topic, teaching approach, question style, length)
3. CTAs: Which CTAs and CTA styles drive more clicks and purchases? (free vs paid, product type, positioning, wording)
4. TOPICS: Which sim racing topics generate the most engagement?

If previous insights exist, note which ones are confirmed by new data and which should be revised.

Respond with this JSON schema:
{
  "insights": "A concise block of specific writing guidelines (max 500 words) formatted as bullet points. These will be injected directly into the email-writing AI's prompt. Write them as direct instructions, e.g. 'Use subject lines under 50 characters' not 'Subject lines under 50 characters performed better'. Only include patterns supported by the data.",
  "summary": "A 3-5 sentence human-readable summary of what you found, including specific numbers. This goes to the admin via Telegram.",
  "confidence": "low|medium|high — based on sample size and pattern clarity"
}`;

  console.log(`[SelfLearning] Analyzing ${tracked.length} broadcasts...`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: ANALYSIS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;
  let parsed;
  try {
    // Strip code fences if present
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse analysis response: ${err.message}`);
  }

  if (!parsed.insights || !parsed.summary) {
    throw new Error('Analysis response missing required fields (insights, summary)');
  }

  // Store insights and metadata
  db.setSetting('self_learning_insights', parsed.insights);
  db.setSetting('self_learning_meta', JSON.stringify({
    last_run: new Date().toISOString(),
    confidence: parsed.confidence || 'unknown',
    broadcasts_analyzed: tracked.length,
  }));

  // Notify admin
  const msg =
    `📊 *Self\\-Learning Analysis Complete*\n\n` +
    `Broadcasts analyzed: ${tracked.length}\n` +
    `Confidence: ${parsed.confidence || 'unknown'}\n\n` +
    `${parsed.summary}\n\n` +
    `_Insights stored and will be used in future emails\\._`;

  await telegram.sendMessage(msg);

  console.log(`[SelfLearning] Analysis complete. Confidence: ${parsed.confidence}. Insights stored.`);
  return parsed;
}

module.exports = { init, runAnalysis };
