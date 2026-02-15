require('dotenv').config();

// Fix Node.js 20 Happy Eyeballs bug causing ETIMEDOUT on some hosts
require('net').setDefaultAutoSelectFamily(false);

const express = require('express');
const crypto = require('crypto');
const db = require('./database');
const telegram = require('./telegram');
const emailBrain = require('./emailBrain');
const emailSender = require('./emailSender');
const wordpress = require('./wordpress');
const proactive = require('./proactive');
const { resolveProductId } = require('./config');
const { parseSesNotification, validateSnsMessage } = require('./sesInbound');
const tracking = require('./tracking');
const selfLearning = require('./selfLearning');

const app = express();
// SNS sends with text/plain content-type, so we need to parse that as JSON too
app.use(express.json({ type: ['application/json', 'text/plain'] }));

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

// --- Skip automated/bounce emails ---
function isAutomatedEmail(fromEmail, subject) {
  const lower = fromEmail.toLowerCase();
  if (lower.startsWith('mailer-daemon@')) return true;
  if (lower.startsWith('postmaster@')) return true;
  if (lower.startsWith('noreply@') || lower.startsWith('no-reply@')) return true;
  if (lower.includes('amazonses.com')) return true;
  if (lower.startsWith('dmarcreport@') || lower.startsWith('dmarc-noreply@') || lower.startsWith('dmarc@')) return true;
  const subLower = (subject || '').toLowerCase();
  if (subLower.includes('delivery status notification')) return true;
  if (subLower.includes('undeliverable') || subLower.includes('undelivered')) return true;
  if (subLower.includes('mail delivery failed')) return true;
  if (subLower.includes('failure notice')) return true;
  if (subLower.includes('dmarc') && subLower.includes('report')) return true;
  return false;
}

// --- Cold outreach reply detection ---
function handleColdOutreachReply(contact) {
  const cocRecord = db.getColdOutreachByContactEmail(contact.email);
  if (cocRecord) {
    db.markColdOutreachReplied(cocRecord.id);
    console.log(`[ColdOutreach] Contact ${contact.email} replied — marked as replied in funnel.`);
    telegram.sendMessage(
      `🎉 Cold outreach reply! ${contact.name || contact.email} replied to the funnel.`
    ).catch(() => {});
  }
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

    // Skip automated bounce/delivery notifications
    if (isAutomatedEmail(from_email, subject)) {
      console.log(`[Webhook] Skipping automated email from ${from_email}`);
      return res.json({ status: 'skipped', reason: 'automated' });
    }

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

    // Check cold outreach pipeline
    handleColdOutreachReply(contact);

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
        const tracked = tracking.prepareTrackedEmail({
          contactId: freshContact.id,
          threadId: replyThread.id,
          body: draft.body,
        });
        const result = await emailSender.send({
          to: freshContact.email,
          subject: draft.subject,
          body: tracked.textBody,
          htmlBody: tracked.htmlBody,
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
          // Purchase attribution — try UTM token first (direct), then time-window (fallback)
          const orderTotal = data?.total ? parseFloat(data.total) : 0;
          const orderProducts = data?.products || data?.line_items?.map(i => i.name) || [];
          const utmToken = data?.meta?._jg_utm_content || data?.utm_content;

          let trackingRecord = null;
          let attributionMethod = '';

          // 1. Direct attribution via UTM token from checkout
          if (utmToken) {
            trackingRecord = db.getTrackingByToken(utmToken);
            if (trackingRecord) attributionMethod = 'utm';
          }

          // 2. Fallback: time-window attribution
          if (!trackingRecord) {
            const attributionDays = parseInt(process.env.PURCHASE_ATTRIBUTION_DAYS || '7', 10);
            trackingRecord = db.getRecentTrackingForContact(contact.id, attributionDays);
            if (trackingRecord) attributionMethod = 'time-window';
          }

          let attributionNote = '';
          if (trackingRecord) {
            db.createPurchaseAttribution({
              contactId: contact.id,
              trackingId: trackingRecord.id,
              orderTotal,
              products: orderProducts,
            });

            const method = attributionMethod === 'utm' ? '(direct link)' : '(time-window)';
            if (trackingRecord.broadcast_id) {
              const bc = db.getBroadcast(trackingRecord.broadcast_id);
              attributionNote = `\n📊 Attributed ${method} to broadcast #${trackingRecord.broadcast_id}: "${bc?.subject || 'Unknown'}"`;
            } else if (trackingRecord.thread_id) {
              attributionNote = `\n📊 Attributed ${method} to email thread #${trackingRecord.thread_id}`;
            }
          }

          await telegram.sendMessage(
            `🛒 New purchase by ${contact.name || email}\nProducts: ${contact.purchases.join(', ')}\nTotal: $${contact.total_spent.toFixed(2)}` +
            attributionNote
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

// --- SES Inbound Email (via SNS) ---
app.post('/webhook/ses-inbound', async (req, res) => {
  try {
    const body = req.body;

    // Validate it's from SNS
    if (!validateSnsMessage(body)) {
      return res.status(400).json({ error: 'Invalid SNS message' });
    }

    // Handle SNS subscription confirmation
    if (body.Type === 'SubscriptionConfirmation') {
      console.log('[SES Inbound] Confirming SNS subscription...');
      const response = await fetch(body.SubscribeURL);
      if (response.ok) {
        console.log('[SES Inbound] SNS subscription confirmed');
        return res.json({ status: 'confirmed' });
      }
      throw new Error('Failed to confirm SNS subscription');
    }

    // Handle actual email notification
    if (body.Type === 'Notification') {
      const message = typeof body.Message === 'string' ? JSON.parse(body.Message) : body.Message;

      // SES notification types: 'Received' is what we want
      if (message.notificationType !== 'Received') {
        console.log(`[SES Inbound] Ignoring notification type: ${message.notificationType}`);
        return res.json({ status: 'ignored' });
      }

      const email = await parseSesNotification(message);
      console.log(`[SES Inbound] Email from ${email.from_email}: ${email.subject}`);

      // Skip emails from our own sending address to avoid loops
      const fromEmail = email.from_email.toLowerCase();
      if (fromEmail === (process.env.SES_FROM_EMAIL || '').toLowerCase()) {
        console.log('[SES Inbound] Skipping email from self');
        return res.json({ status: 'skipped', reason: 'self' });
      }

      // Skip automated bounce/delivery notifications
      if (isAutomatedEmail(email.from_email, email.subject)) {
        console.log(`[SES Inbound] Skipping automated email from ${email.from_email}`);
        return res.json({ status: 'skipped', reason: 'automated' });
      }

      // Upsert contact
      const contact = db.upsertContact({
        email: email.from_email,
        name: email.from_name || undefined,
      });

      if (contact.blacklisted) {
        console.log(`[SES Inbound] Skipping blacklisted: ${email.from_email}`);
        return res.json({ status: 'skipped', reason: 'blacklisted' });
      }

      // Save inbound thread
      db.createThread({
        contactId: contact.id,
        direction: 'inbound',
        subject: email.subject,
        body: email.text_body,
        status: 'received',
      });
      db.updateContactLastEmailReceived(contact.id);

      // Check cold outreach pipeline
      handleColdOutreachReply(contact);

      // Refresh profile from WooCommerce
      try {
        await wordpress.refreshContactProfile(email.from_email);
      } catch (err) {
        console.warn(`[SES Inbound] Profile refresh failed:`, err.message);
      }

      const freshContact = db.getContactByEmail(email.from_email);
      const threadHistory = db.getThreadsByContact(freshContact.id, 10);

      // Generate reply
      const draft = await emailBrain.generateReply({
        contact: freshContact,
        inboundSubject: email.subject,
        inboundBody: email.text_body,
        threadHistory,
      });

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
        const rateCheck = db.canEmailContact(freshContact.id);
        if (!rateCheck.allowed) {
          await telegram.sendMessage(
            `⚠️ Auto-send blocked for ${freshContact.email}: ${rateCheck.reason}\nDraft saved as #${replyThread.id}`
          );
          return res.json({ status: 'rate_limited', threadId: replyThread.id });
        }

        try {
          const tracked = tracking.prepareTrackedEmail({
            contactId: freshContact.id,
            threadId: replyThread.id,
            body: draft.body,
          });
          const result = await emailSender.send({
            to: freshContact.email,
            subject: draft.subject,
            body: tracked.textBody,
            htmlBody: tracked.htmlBody,
          });
          db.updateThreadStatus(replyThread.id, 'sent');
          db.updateThreadSesId(replyThread.id, result.messageId);
          db.updateContactLastEmailSent(freshContact.id);
          await telegram.sendAutoApproveNotification(freshContact, replyThread);
        } catch (err) {
          db.updateThreadStatus(replyThread.id, 'failed');
          await telegram.sendMessage(`❌ Auto-send failed: ${err.message}`);
        }
      } else {
        await telegram.sendApprovalRequest(freshContact, replyThread);
      }

      return res.json({ status: 'ok', threadId: replyThread.id });
    }

    res.json({ status: 'ok' });
  } catch (err) {
    console.error('[SES Inbound] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Tracking pixel (open tracking) ---
app.get('/t/open/:token', (req, res) => {
  try {
    db.recordOpen(req.params.token);
  } catch (err) {
    console.error('[Tracking] Open recording error:', err.message);
  }

  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': pixel.length,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(pixel);
});

// --- Click tracking redirect ---
app.get('/t/click/:token', (req, res) => {
  const { token } = req.params;
  const originalUrl = req.query.url;

  if (!originalUrl) {
    return res.status(400).send('Missing URL');
  }

  try {
    const trackingRecord = db.getTrackingByToken(token);
    if (trackingRecord) {
      db.recordClick({ trackingId: trackingRecord.id, originalUrl });
    }
  } catch (err) {
    console.error('[Tracking] Click recording error:', err.message);
  }

  res.redirect(302, originalUrl);
});

// --- Start ---
async function start() {
  // Initialize all modules
  db.init();
  emailBrain.init();
  emailSender.init();
  selfLearning.init();
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
