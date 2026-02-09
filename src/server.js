require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const db = require('./database');
const telegram = require('./telegram');
const emailBrain = require('./emailBrain');
const emailSender = require('./emailSender');
const wordpress = require('./wordpress');
const proactive = require('./proactive');
const { resolveProductId } = require('./config');

const app = express();
app.use(express.json());

// --- Webhook authentication middleware ---
function verifyWebhook(req, res, next) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return next(); // no secret configured = skip auth

  const token = req.headers['x-webhook-secret'] || req.query.secret;
  if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Health check ---
app.get('/health', (req, res) => {
  const stats = db.getStats();
  res.json({ status: 'ok', ...stats });
});

// --- Inbound email webhook ---
// FunnelKit sends inbound email data here
app.post('/webhook/inbound-email', verifyWebhook, async (req, res) => {
  try {
    const { from_email, from_name, subject, body, text_body } = req.body;

    if (!from_email) {
      return res.status(400).json({ error: 'Missing from_email' });
    }

    console.log(`[Webhook] Inbound email from ${from_email}: ${subject}`);

    // Upsert the contact
    const contact = db.upsertContact({
      email: from_email,
      name: from_name || undefined,
    });

    // Check blacklist
    if (contact.blacklisted) {
      console.log(`[Webhook] Skipping blacklisted contact: ${from_email}`);
      return res.json({ status: 'skipped', reason: 'blacklisted' });
    }

    // Save inbound email as a thread
    const emailBody = text_body || body || '';
    const inboundThread = db.createThread({
      contactId: contact.id,
      direction: 'inbound',
      subject: subject || '(no subject)',
      body: emailBody,
      status: 'received',
    });
    db.updateContactLastEmailReceived(contact.id);

    // Refresh contact profile from WooCommerce
    try {
      await wordpress.refreshContactProfile(from_email);
    } catch (err) {
      console.warn(`[Webhook] Profile refresh failed for ${from_email}:`, err.message);
    }

    // Reload contact after profile refresh
    const freshContact = db.getContactByEmail(from_email);
    const threadHistory = db.getThreadsByContact(freshContact.id, 10);

    // Generate reply with Claude
    const draft = await emailBrain.generateReply({
      contact: freshContact,
      inboundSubject: subject || '(no subject)',
      inboundBody: emailBody,
      threadHistory,
    });

    // Save draft
    const replyThread = db.createThread({
      contactId: freshContact.id,
      direction: 'outbound',
      subject: draft.subject,
      body: draft.body,
      status: 'pending_approval',
      claudeReasoning: draft.reasoning,
    });

    // Auto-approve or send for approval
    if (db.isAutoApprove()) {
      // Check rate limits even in auto mode
      const rateCheck = db.canEmailContact(freshContact.id);
      if (!rateCheck.allowed) {
        console.log(`[Webhook] Rate limited: ${rateCheck.reason}`);
        await telegram.sendMessage(
          `⚠️ Auto-send blocked for ${freshContact.email}: ${rateCheck.reason}\nDraft saved as #${replyThread.id}`
        );
        return res.json({ status: 'rate_limited', threadId: replyThread.id });
      }

      try {
        const result = await emailSender.send({
          to: freshContact.email,
          subject: draft.subject,
          body: draft.body,
        });
        db.updateThreadStatus(replyThread.id, 'sent');
        db.updateThreadSesId(replyThread.id, result.messageId);
        db.updateContactLastEmailSent(freshContact.id);
        await telegram.sendAutoApproveNotification(freshContact, replyThread);
      } catch (err) {
        console.error('[Webhook] Auto-send failed:', err);
        db.updateThreadStatus(replyThread.id, 'failed');
        await telegram.sendMessage(`❌ Auto-send failed for ${freshContact.email}: ${err.message}`);
      }
    } else {
      await telegram.sendApprovalRequest(freshContact, replyThread);
    }

    res.json({ status: 'ok', threadId: replyThread.id });
  } catch (err) {
    console.error('[Webhook] Inbound email error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Contact event webhook ---
// FunnelKit fires this on purchase, tag change, etc.
app.post('/webhook/contact-event', verifyWebhook, async (req, res) => {
  try {
    const { email, event_type, data } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }

    console.log(`[Webhook] Contact event: ${event_type} for ${email}`);

    switch (event_type) {
      case 'purchase':
      case 'order_completed': {
        // Refresh full profile from WooCommerce
        await wordpress.refreshContactProfile(email);
        const contact = db.getContactByEmail(email);
        if (contact) {
          await telegram.sendMessage(
            `🛒 New purchase by ${contact.name || email}\nProducts: ${contact.purchases.join(', ')}\nTotal: $${contact.total_spent.toFixed(2)}`
          );
        }
        break;
      }
      case 'tag_added':
      case 'tag_removed': {
        const contact = db.getContactByEmail(email);
        if (contact && data?.tags) {
          db.upsertContact({ email, tags: data.tags });
        }
        break;
      }
      default:
        console.log(`[Webhook] Unhandled event type: ${event_type}`);
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[Webhook] Contact event error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start ---
async function start() {
  // Initialize all modules
  db.init();
  emailBrain.init();
  emailSender.init();
  telegram.init();
  proactive.init();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`[Server] Running on port ${port}`);
    telegram.sendMessage('🟢 Email agent started.').catch(() => {});
  });
}

start().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
