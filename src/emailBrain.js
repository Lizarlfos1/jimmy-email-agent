const Anthropic = require('@anthropic-ai/sdk');
const db = require('./database');
const { products, leadMagnets, getUpsellRecommendation } = require('./config');
const { getRandomTips, formatTipsForPrompt } = require('./tipBank');

let client;

function init() {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log('[EmailBrain] Initialized');
}

const SYSTEM_PROMPT = `You are ghostwriting emails as Jimmy Grills, a sim racing expert who sells two products: the Precision Racing book (PDF, $36.99) and Sim Racing University (video course, $89.95). He also offers free lead magnets: an Advanced Trail Braking PDF, a 3 Must-Know Driving Drills PDF, and an interactive Throttle Control Audit tool.

VOICE & TONE:
- Friendly, knowledgeable, slightly casual but professional
- Like a mate who's an expert — not a corporate salesperson
- NEVER use cringe salesy language: "act now!", "limited time!", "don't miss out!", "exclusive offer!", "you won't believe!"
- Reference specific racing concepts naturally to demonstrate expertise
- Keep emails concise — 100-200 words max, people don't read long emails
- Sign off as "Jimmy"

FORMAT:
- Plain text only, no HTML formatting
- Short paragraphs (1-3 sentences each)
- No bullet points or numbered lists in emails — keep it conversational
- Include a clear but soft call to action when relevant
- When mentioning a product, include its link naturally (e.g. "you can check it out here: <url>")

IMPORTANT RULES:
- Never fabricate details about the customer — only reference info provided in the context
- Never promise discounts or offers unless specifically instructed
- If replying to an inbound email, address their actual question/topic FIRST, then weave in the upsell naturally
- If the customer seems frustrated or has a complaint, focus entirely on helping — no upselling
- For proactive outreach, open with something relevant to them (their purchase, a racing topic) — never "just checking in"
- Only include a product link when you're actually suggesting/mentioning that product — don't force links into every email

You must respond with valid JSON only. No markdown, no code fences. The JSON schema:
{
  "subject": "Email subject line",
  "body": "The email body text",
  "reasoning": "1-2 sentence explanation of your strategy (not sent to customer, just for Jimmy to see)"
}`;

// Generate a reply to an inbound email
async function generateReply({ contact, inboundSubject, inboundBody, threadHistory }) {
  const upsell = getUpsellRecommendation(contact.purchases);
  const productInfo = upsell.product ? products[upsell.product.id] : null;

  const historyBlock = threadHistory.length > 0
    ? threadHistory.map(t =>
      `[${t.direction.toUpperCase()} — ${t.created_at}]\nSubject: ${t.subject}\n${t.body}`
    ).join('\n\n---\n\n')
    : 'No previous emails.';

  const userPrompt = `CUSTOMER PROFILE:
Name: ${contact.name || 'Unknown'}
Email: ${contact.email}
Products purchased: ${contact.purchases.length > 0 ? contact.purchases.join(', ') : 'None'}
Total spent: $${(contact.total_spent || 0).toFixed(2)}
Tags: ${contact.tags.length > 0 ? contact.tags.join(', ') : 'None'}

PREVIOUS EMAIL THREAD:
${historyBlock}

INBOUND EMAIL TO REPLY TO:
Subject: ${inboundSubject}
${inboundBody}

UPSELL GUIDANCE:
${upsell.angle}
${productInfo ? `${upsell.type === 'lead_magnet' ? 'Free resource' : 'Product'} to suggest: ${productInfo.name}${productInfo.price ? ` ($${productInfo.price})` : ' (FREE)'} — ${productInfo.description}\nLink: ${productInfo.url}` : 'No specific product to push right now.'}

Write a reply email. Reply to their email content first, then naturally work in the upsell if appropriate. If they have a problem or complaint, focus on helping and skip the upsell.`;

  return callClaude(userPrompt);
}

// Generate a proactive outreach email
async function generateOutreach({ contact }) {
  const upsell = getUpsellRecommendation(contact.purchases);
  const productInfo = upsell.product ? products[upsell.product.id] : null;

  const previousThreads = db.getThreadsByContact(contact.id, 5);
  const historyBlock = previousThreads.length > 0
    ? previousThreads.map(t =>
      `[${t.direction.toUpperCase()} — ${t.created_at}]\nSubject: ${t.subject}\n${t.body}`
    ).join('\n\n---\n\n')
    : 'No previous emails.';

  const userPrompt = `CUSTOMER PROFILE:
Name: ${contact.name || 'Unknown'}
Email: ${contact.email}
Products purchased: ${contact.purchases.length > 0 ? contact.purchases.join(', ') : 'None'}
Total spent: $${(contact.total_spent || 0).toFixed(2)}
Tags: ${contact.tags.length > 0 ? contact.tags.join(', ') : 'None'}

PREVIOUS EMAIL THREAD:
${historyBlock}

UPSELL GUIDANCE:
${upsell.angle}
${productInfo ? `${upsell.type === 'lead_magnet' ? 'Free resource' : 'Product'} to suggest: ${productInfo.name}${productInfo.price ? ` ($${productInfo.price})` : ' (FREE)'} — ${productInfo.description}\nLink: ${productInfo.url}` : 'No specific product to push right now.'}

This is a PROACTIVE outreach email — the customer hasn't emailed us. Write a personalized opener that references something specific to them (their purchase history, a racing topic relevant to their level). Don't open with "just checking in" or generic greetings. Make it feel like Jimmy genuinely thought of them for a reason.`;

  // Inject self-learning insights if available
  const insights = db.getSetting('self_learning_insights');
  const fullPrompt = insights
    ? userPrompt + `\n\nWRITING INSIGHTS (learned from email performance data — apply where relevant, but prioritize personalization):\n${insights}`
    : userPrompt;

  return callClaude(fullPrompt);
}

// Generate a broadcast email (same email sent to all contacts)
async function generateBroadcast() {
  // Pull 5 random tips from the course content for variety
  const tips = getRandomTips(5);
  const tipContext = formatTipsForPrompt(tips);

  // Build the CTA options list — rotate between products and lead magnets
  const ctaOptions = [
    `PAID: Precision Racing (PDF) — $36.99 — ${products.book.url}`,
    `PAID: Sim Racing University — $89.95 — ${products.university.url}`,
    `FREE: ${leadMagnets.trail_braking_pdf.name} — ${leadMagnets.trail_braking_pdf.url}`,
    `FREE: ${leadMagnets.driving_drills_pdf.name} — ${leadMagnets.driving_drills_pdf.url}`,
    `FREE: ${leadMagnets.throttle_audit.name} — ${leadMagnets.throttle_audit.description} — ${leadMagnets.throttle_audit.url}`,
  ].join('\n- ');

  const userPrompt = `Write a BROADCAST email that goes to Jimmy's entire mailing list (mix of customers and non-customers).

CTA OPTIONS (pick the ONE that best fits the topic of this email):
- ${ctaOptions}

REFERENCE MATERIAL FROM JIMMY'S COURSE (pick ONE topic and write about it in Jimmy's voice):
${tipContext}

STRUCTURE:
1. Pick ONE topic from the reference material above. Use the insight and actionable tip as your foundation, but rewrite it in Jimmy's casual, conversational email voice. Don't copy it verbatim — adapt and expand on it naturally.
2. End the main content with an OPEN LOOP QUESTION — something that invites them to reply. Make it related to the topic. Examples: "What track are you struggling with most right now?", "Have you ever noticed this happening in your driving?", "What's the one thing holding you back from being consistently fast?"
3. Sign off as Jimmy.
4. AFTER the sign-off, add a short CTA on its own line. Pick whichever option from the CTA OPTIONS above fits the email topic best. Examples:
   "Want to get faster? Check out Sim Racing University: ${products.university.url}"
   "Want the theory behind the technique? Grab Precision Racing: ${products.book.url}"
   "Want to nail your trail braking? Grab my free guide: ${leadMagnets.trail_braking_pdf.url}"
   "Try these 3 drills in your next session: ${leadMagnets.driving_drills_pdf.url}"
   "Find out what's costing you time on corner exit — try the free Throttle Audit: ${leadMagnets.throttle_audit.url}"
   Alternate between free and paid CTAs — don't always push a product. Match the CTA to the topic.

IMPORTANT:
- This is NOT personalized — it goes to everyone. Don't reference any specific customer details.
- Keep it 100-150 words (excluding the CTA line).
- The tip should feel like genuine value from Jimmy's actual teaching, not generic advice.
- The open loop question should feel natural, not forced.`;

  // Inject self-learning insights if available
  const insights = db.getSetting('self_learning_insights');
  const fullPrompt = insights
    ? userPrompt + `\n\nPERFORMANCE INSIGHTS (learned from past email data — follow these patterns):\n${insights}`
    : userPrompt;

  return callClaude(fullPrompt);
}

// Generate cold outreach email for non-purchasers (batch — same email for all)
async function generateColdOutreach() {
  const userPrompt = `Write a COLD OUTREACH email that feels like a PERSONAL 1-on-1 message from Jimmy — NOT a broadcast or newsletter.

GOAL: Start a conversation. Offer the free Advanced Trail Braking Framework PDF as a genuine gift, and get them to reply.

FREE RESOURCE TO OFFER:
- Advanced Trail Braking Framework (PDF) — FREE
- Link: ${leadMagnets.trail_braking_pdf.url}
- What it covers: ${leadMagnets.trail_braking_pdf.description}

TONE & STYLE — THIS IS CRITICAL:
- This must read like Jimmy personally sat down and wrote this email to ONE person. Like a mate checking in.
- Subject line should be casual and personal — something like "Quick question for you", "Thought of you", "Curious about something" — NOT a newsletter-style subject.
- Start with "Hey," (no name — we don't have it). No "Hey there" or "Hi everyone".
- Short, conversational paragraphs. Like a text message turned into an email.
- Do NOT use any broadcast/newsletter language: "I wanted to share", "I'm excited to announce", "check out our latest", etc.
- Do NOT open with a teaching moment or insight dump. Open like you're mid-conversation — ask a question, share a quick thought, be curious about them.

STRUCTURE:
1. Open casually — ask a question or share a brief thought that invites them in. Something like "I've been working on X lately and it got me thinking..." or "Quick one for you —"
2. Bridge naturally to the free PDF. Frame it as something you put together that they might find useful, not as a "resource" or "guide" you're "offering". Just drop the link casually: ${leadMagnets.trail_braking_pdf.url}
3. End with an OPEN LOOP QUESTION — something dead easy to reply to. Make it feel like you genuinely want to know. Examples: "What's the one thing you're working on improving right now?", "Have you given it a read before? Curious what you thought.", "What sim are you mainly driving at the moment?"
4. Sign off as Jimmy.

EXAMPLE OF THE RIGHT FEEL (don't copy this verbatim, but match the vibe):
"""
Subject: Quick question for you

Hey,

I've been putting together some new content on trail braking lately and it got me thinking — are you someone who's been working on their braking technique, or is it more of a "I know I should but haven't really dug into it" kind of thing?

No judgement either way — most people fall into the second camp until something clicks.

I actually put together a free PDF that breaks down an advanced trail braking framework step by step. It's the same stuff I teach in my course, just condensed into something you can read before your next session: ${leadMagnets.trail_braking_pdf.url}

If you've already seen it, I'd genuinely love to know what you thought. And if not — what's the one thing you're working on improving right now?

Jimmy
"""

IMPORTANT:
- Same email goes to ~50 people but it must NOT feel like it. No personalization details needed — just make it feel 1-on-1.
- Keep it 100-150 words.
- The free PDF is the star — don't push paid products in this email.
- The open loop question is critical — we want them to REPLY.
- Do NOT mention discounts, courses, or books in this email.`;

  const insights = db.getSetting('self_learning_insights');
  const fullPrompt = insights
    ? userPrompt + `\n\nWRITING INSIGHTS (learned from email performance data):\n${insights}`
    : userPrompt;

  return callClaude(fullPrompt);
}

// Generate cold outreach follow-up for non-purchasers who didn't reply (batch)
async function generateColdFollowup({ initialSubject, initialBody }) {
  const userPrompt = `Write a FOLLOW-UP email to a cold outreach that got no reply. This is the ONE AND ONLY follow-up — it must count.

THE INITIAL EMAIL THEY RECEIVED (2 days ago):
Subject: ${initialSubject}
Body:
"""
${initialBody}
"""

GOAL: Get them to reply. That's it. Not to sell, not to push another resource — just to start a conversation.

DISCOUNT LANGUAGE RULES (use ONLY if you mention these products — do NOT lead with discounts):
- Precision Racing book: "60% off" — ${products.book.url}
- Sim Racing University: "78% off" — ${products.university.url}

STRUCTURE:
1. Acknowledge the previous email briefly and casually — don't be needy about it. Something like "Sent you something the other day about [topic]..." NOT "I noticed you haven't replied" or "Just following up..."
2. Add ONE additional piece of genuine value or insight related to the initial email's topic. Something they can use immediately.
3. End with a DIFFERENT open loop question than the initial email — simpler, lower-barrier. Something dead easy to reply to. Examples: "Quick question — what sim do you mainly drive?", "Curious — do you race online or mostly hotlap?"
4. Sign off as Jimmy.
5. Optionally, after the sign-off, include the trail braking PDF link one more time as a PS if it fits naturally: ${leadMagnets.trail_braking_pdf.url}

IMPORTANT:
- Same email goes to everyone who didn't reply to the initial. No personalization.
- Keep it 80-120 words — shorter than the initial email.
- Do NOT repeat the same CTA or the same question from the initial email.
- The tone should be even more casual than the first email — like a "by the way" message.
- Do NOT use "follow up" or "following up" language.`;

  const insights = db.getSetting('self_learning_insights');
  const fullPrompt = insights
    ? userPrompt + `\n\nWRITING INSIGHTS (learned from email performance data):\n${insights}`
    : userPrompt;

  return callClaude(fullPrompt);
}

async function callClaude(userPrompt) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text.trim();

  // Parse JSON — handle case where Claude wraps in code fences
  let cleaned = text;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error('[EmailBrain] Failed to parse Claude response:', text);
    throw new Error('Claude returned invalid JSON. Raw: ' + text.slice(0, 200));
  }

  if (!parsed.subject || !parsed.body) {
    throw new Error('Claude response missing subject or body');
  }

  return {
    subject: parsed.subject,
    body: parsed.body,
    reasoning: parsed.reasoning || '',
  };
}

async function rewriteEmail({ subject, body, instructions }) {
  const userPrompt = `You are editing an existing email draft based on the user's instructions.

CURRENT EMAIL:
Subject: ${subject}
Body:
${body}

USER'S EDIT INSTRUCTIONS:
${instructions}

Rewrite the email incorporating the user's requested changes. Keep everything else the same unless the instructions say otherwise. The tone should remain the same unless asked to change it.

Respond in JSON: { "subject": "...", "body": "...", "reasoning": "brief note on what you changed" }`;

  return callClaude(userPrompt);
}

module.exports = { init, generateReply, generateOutreach, generateBroadcast, generateColdOutreach, generateColdFollowup, rewriteEmail };
