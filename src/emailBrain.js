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

// Broadcast email style templates — rotates between 3 styles
const BROADCAST_STYLES = [
  // Style 0: Educational Email
  {
    name: 'Educational',
    buildPrompt: (tipContext, ctaOptions) => `Write a BROADCAST email using the EDUCATIONAL style. This goes to Jimmy's entire mailing list (mix of customers and non-customers).

CTA OPTIONS (pick the ONE that best fits the topic of this email):
- ${ctaOptions}

REFERENCE MATERIAL FROM JIMMY'S COURSE (pick ONE topic and write about it in Jimmy's voice):
${tipContext}

STRUCTURE — Follow this EXACT format:
1. Start with a "Words I like:" line — a short, punchy quote or one-liner related to the topic. Something memorable.
2. Then a 1-sentence problem statement — what's the issue most sim racers face?
3. "Why it matters:" — 1 sentence that raises the stakes or consequence of not fixing it.
4. "The tactic:" — The 1 clear thing to do, in 1-3 sentences.
5. "How to do it today:" — 3 numbered steps they can apply immediately.
6. Sign off as Jimmy.
7. CTA line: pick the best fit from CTA OPTIONS. Keep it one line.
8. PS: Either a second free resource link OR a second CTA.

EXAMPLE FORMAT (don't copy content — match the structure):
"""
Words I like: "Slow in, fast out isn't about going slow — it's about being precise where it matters most."

Most sim racers think corner entry is about braking later. But the real problem is they're not looking far enough ahead.

Why it matters: If your eyes are glued to the car's nose, your brain is reacting to things that already happened.

The tactic: Force your eyes to the furthest visible point on track. The corner will "slow down" within 3-5 laps.

How to do it today:
1. Pick one corner you struggle with
2. Consciously look at the apex while braking, then shift to the exit before turn-in
3. Repeat for 10 laps — notice how much calmer the corner feels

Jimmy

If you want the full framework for vision and technique, check out Sim Racing University: [URL]

PS: I also put together a free trail braking guide — grab it here: [URL]
"""

IMPORTANT:
- This is NOT personalized — it goes to everyone. Don't reference any specific customer details.
- Keep it 100-200 words (excluding the CTA and PS lines).
- The "Words I like" quote should feel authentic and insightful — not generic motivational fluff.
- The 3 steps should be specific and actionable, not vague.
- The tip should feel like genuine value from Jimmy's actual teaching, not generic advice.`,
  },

  // Style 1: Case Study Email
  {
    name: 'Case Study',
    buildPrompt: (tipContext, ctaOptions) => `Write a BROADCAST email using the CASE STUDY style. This goes to Jimmy's entire mailing list (mix of customers and non-customers).

CTA OPTIONS (pick the ONE that best fits the topic of this email):
- ${ctaOptions}

REFERENCE MATERIAL FROM JIMMY'S COURSE (pick ONE topic and build a scenario around it):
${tipContext}

STRUCTURE — Follow this EXACT format:
1. Start with a "Words I like:" line — a short quote that frames the lesson.
2. Then a HEADLINE — the core idea in 3-6 words (bold/standalone line).
3. Write a short STORY or real scenario in 4-8 sentences. Keep it practical, direct, and slightly conversational. Explain what the problem was, what was done differently, and what happened as a result. This can be about Jimmy, a driver he coached, or a relatable situation. Make it feel real.
4. "Takeaway:" — Summarize the lesson in 1-3 sentences. Make it feel like a rule someone can apply immediately.
5. CTA: One clear action step. Examples: "Try this in your next session." / "Reply and tell me what you think." / "If you want help applying this, grab the guide here: [LINK]"
6. A short punchy closer line (e.g. "Go faster." / "See you on track." / "Do it today.")
7. Sign off as Jimmy.
8. PS: Optional one-liner that reinforces the emotional payoff or outcome.

EXAMPLE FORMAT (don't copy content — match the structure):
"""
Words I like: "When it's easy, do more. When it's hard, do different."

Double Sessions

My practice used to feel slow. I'd do one session a day and wonder why I wasn't improving.

So I started doing two focused sessions instead of one long one. First session: work on one specific thing. Second session: put the full lap together.

The difference was immediate. Instead of aimlessly lapping, I had two clear objectives. Every day became two days of improvement.

If you're stuck on a plateau, it's probably not talent — it's structure.

Takeaway: Split your practice into two focused blocks. Pick ONE technique to isolate, then run full laps applying it. You'll improve twice as fast.

Try this in your next session — reply and tell me what you worked on.

See you on track.

Jimmy

PS: The feeling when you nail a corner you've been struggling with for weeks — nothing beats it.
"""

IMPORTANT:
- This is NOT personalized — it goes to everyone. Don't reference any specific customer details.
- Keep the story section 4-8 sentences. Total body 100-200 words.
- The story should feel REAL and specific — not hypothetical or generic. Use concrete details (lap times, corner numbers, specific techniques).
- The takeaway should be a clear, quotable rule.`,
  },

  // Style 2: Story-Based Email
  {
    name: 'Story-Based',
    buildPrompt: (tipContext, ctaOptions) => `Write a BROADCAST email using the STORY-BASED style. This goes to Jimmy's entire mailing list (mix of customers and non-customers).

CTA OPTIONS (pick the ONE that best fits the topic of this email):
- ${ctaOptions}

REFERENCE MATERIAL FROM JIMMY'S COURSE (pick ONE topic and build a story around the lesson):
${tipContext}

STRUCTURE — Follow this EXACT format:
1. Start with a "Words I like:" line — a short, memorable quote.
2. Then a TITLE — the lesson name (standalone line).
3. 1-2 sentences setting the scene (when/where/who).
4. What went wrong — the problem or mistake.
5. What was done about it — the fix, insight, or counterintuitive move.
6. The result/outcome — what changed.
7. "This taught me an important lesson:" followed by ONE bold rule/principle in quotes.
8. "How to use it:" with 3 bullet points (practical tips).
9. CTA: One simple action (try it today / reply / grab the guide: [LINK]).
10. Short punchy closing line.
11. Sign off as Jimmy.
12. PS: Optional one-liner.

EXAMPLE FORMAT (don't copy content — match the structure):
"""
Words I like: "The fastest drivers look like they're going slowly. The slowest drivers look like they're in a movie."

The Overdriving Trap

I was coaching a driver last year who was incredibly fast in sector 1 but always lost time in sectors 2 and 3.

He was overdriving — pushing past the grip limit in every corner, sliding through apexes, overheating tyres. He'd exit each corner a few km/h slower without realising it.

I told him to try something counterintuitive: drive at 90% effort for 5 laps. Just focus on being smooth and hitting every apex cleanly.

His lap time dropped by 0.8 seconds. Less effort, more speed.

This taught me an important lesson:

"Driving at 90% is faster than driving at 110%."

How to use it:
- Pick your worst sector and drive it at 8/10 effort for 5 laps
- Focus on clean apexes and smooth inputs — not raw speed
- Compare your sector times to your "try-hard" laps

If you want a structured approach to this, grab the free 3 Must-Know Driving Drills PDF: [URL]

Smooth is fast.

Jimmy

PS: You'd be surprised how much time is hiding in the corners you think you're already good at.
"""

IMPORTANT:
- This is NOT personalized — it goes to everyone. Don't reference any specific customer details.
- Keep it 100-200 words total.
- The story must feel REAL and personal — like Jimmy is telling you about something that actually happened. Use specific details.
- The "lesson" line should be bold and memorable — something they'll remember.
- The 3 tips should be immediately actionable.`,
  },
];

// Generate a broadcast email (same email sent to all contacts)
async function generateBroadcast() {
  // Determine which style to use — rotate 0→1→2→0→1→2...
  const lastStyleRaw = db.getSetting('broadcast_style_index');
  const lastStyle = lastStyleRaw !== null ? parseInt(lastStyleRaw, 10) : -1;
  const styleIndex = (lastStyle + 1) % BROADCAST_STYLES.length;
  const style = BROADCAST_STYLES[styleIndex];

  console.log(`[Broadcast] Using style ${styleIndex}: ${style.name}`);

  // Pull 5 random tips from the course content for variety
  const tips = getRandomTips(5);
  const tipContext = formatTipsForPrompt(tips);

  // Build the CTA options list — rotate between products and lead magnets
  const ctaOptions = [
    `PAID: Precision Racing (PDF) — $36.99 — ${products.book.url}`,
    `PAID: Sim Racing University — $89.95 — ${products.university.url}`,
    `FREE: ${leadMagnets.trail_braking_pdf.name} — ${leadMagnets.trail_braking_pdf.url}`,
    `FREE: ${leadMagnets.driving_drills_pdf.name} — ${leadMagnets.driving_drills_pdf.url}`,
    `FREE: ${leadMagnets.steering_technique_pdf.name} — ${leadMagnets.steering_technique_pdf.url}`,
    `FREE: ${leadMagnets.throttle_audit.name} — ${leadMagnets.throttle_audit.description} — ${leadMagnets.throttle_audit.url}`,
  ].join('\n- ');

  // Build the style-specific prompt
  const userPrompt = style.buildPrompt(tipContext, ctaOptions);

  // Inject self-learning insights if available
  const insights = db.getSetting('self_learning_insights');
  const fullPrompt = insights
    ? userPrompt + `\n\nPERFORMANCE INSIGHTS (learned from past email data — follow these patterns):\n${insights}`
    : userPrompt;

  const result = await callClaude(fullPrompt);

  // Save the style index so next broadcast uses the next style
  db.setSetting('broadcast_style_index', String(styleIndex));

  return { ...result, styleUsed: style.name };
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
