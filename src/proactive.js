const cron = require('node-cron');
const db = require('./database');
const emailBrain = require('./emailBrain');
const emailSender = require('./emailSender');
const telegram = require('./telegram');
const wordpress = require('./wordpress');
const { getUpsellRecommendation } = require('./config');
const tracking = require('./tracking');

let syncJob;
let outreachJob;
let broadcastJob;

function init() {
  // Sync contacts from CRM daily at 2am
  syncJob = cron.schedule('0 2 * * *', async () => {
    console.log('[Cron] Running daily contact sync...');
    try {
      const count = await syncContacts();
      await telegram.sendMessage(`🔄 Daily sync complete. ${count} contact(s) updated.`);
    } catch (err) {
      console.error('[Cron] Sync failed:', err);
      await telegram.sendMessage(`❌ Daily sync failed: ${err.message}`);
    }
  }, { timezone: 'Australia/Sydney' });

  // Outreach cron disabled — run manually via /outreach in Telegram when ready

  // Broadcast emails: Mon, Thu, Sat at 9am AEST
  broadcastJob = cron.schedule('0 9 * * 1,4,6', async () => {
    console.log('[Cron] Running broadcast generation...');
    try {
      await generateBroadcast();
    } catch (err) {
      console.error('[Cron] Broadcast generation failed:', err);
      await telegram.sendMessage(`❌ Broadcast generation failed: ${err.message}`);
    }
  }, { timezone: 'Australia/Sydney' });

  console.log('[Cron] Scheduled: sync at 2am AEST, broadcasts Mon/Thu/Sat at 9am AEST');
}

async function syncContacts() {
  return wordpress.syncAllContacts();
}

async function runOutreach() {
  const contacts = db.getNonBlacklistedContacts();
  let draftsGenerated = 0;

  for (const contact of contacts) {
    // Check rate limits
    const rateCheck = db.canEmailContact(contact.id);
    if (!rateCheck.allowed) {
      console.log(`[Outreach] Skipping ${contact.email}: ${rateCheck.reason}`);
      continue;
    }

    // Check if there's something to upsell
    const upsell = getUpsellRecommendation(contact.purchases);

    // Generate the outreach email
    let draft;
    try {
      draft = await emailBrain.generateOutreach({ contact });
    } catch (err) {
      console.error(`[Outreach] Failed to generate for ${contact.email}:`, err.message);
      continue;
    }

    // Save as thread
    const thread = db.createThread({
      contactId: contact.id,
      direction: 'outbound',
      subject: draft.subject,
      body: draft.body,
      status: 'pending_approval',
      claudeReasoning: draft.reasoning,
    });

    // Log the upsell attempt
    if (upsell.product) {
      db.logUpsell({
        contactId: contact.id,
        productSuggested: upsell.product.id,
        emailThreadId: thread.id,
      });
    }

    // Auto-approve or send for approval
    if (db.isAutoApprove()) {
      try {
        const tracked = tracking.prepareTrackedEmail({
          contactId: contact.id,
          threadId: thread.id,
          body: draft.body,
        });
        const result = await emailSender.send({
          to: contact.email,
          subject: draft.subject,
          body: tracked.textBody,
          htmlBody: tracked.htmlBody,
        });
        db.updateThreadStatus(thread.id, 'sent');
        db.updateThreadSesId(thread.id, result.messageId);
        db.updateContactLastEmailSent(contact.id);
        await telegram.sendAutoApproveNotification(contact, thread);
      } catch (err) {
        console.error(`[Outreach] Send failed for ${contact.email}:`, err.message);
        db.updateThreadStatus(thread.id, 'failed');
        await telegram.sendMessage(`❌ Auto-send failed for ${contact.email}: ${err.message}`);
      }
    } else {
      await telegram.sendApprovalRequest(contact, thread);
    }

    draftsGenerated++;
  }

  return draftsGenerated;
}

async function generateBroadcast({ testEmails } = {}) {
  const contacts = db.getNonBlacklistedContacts();

  let draft;
  try {
    draft = await emailBrain.generateBroadcast();
  } catch (err) {
    console.error('[Broadcast] Failed to generate:', err.message);
    throw err;
  }

  const broadcast = db.createBroadcast({
    subject: draft.subject,
    body: draft.body,
    claudeReasoning: draft.reasoning,
    totalContacts: testEmails ? testEmails.length : contacts.length,
  });

  if (testEmails) {
    console.log(`[Broadcast] Generated TEST #${broadcast.id} for ${testEmails.length} test email(s)`);
    await telegram.sendTestBroadcastApproval(broadcast, testEmails);
  } else {
    console.log(`[Broadcast] Generated #${broadcast.id} for ${contacts.length} contacts`);
    await telegram.sendBroadcastApproval(broadcast);
  }
  return broadcast;
}

async function sendBroadcastToAll(broadcastId) {
  const broadcast = db.getBroadcast(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found');

  db.updateBroadcastStatus(broadcastId, 'sending');
  const contacts = db.getNonBlacklistedContacts();

  let sent = 0;
  let failed = 0;

  await telegram.sendMessage(`📤 Sending broadcast #${broadcastId} to ${contacts.length} contacts...`);

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    try {
      const tracked = tracking.prepareTrackedEmail({
        contactId: contact.id,
        broadcastId: broadcastId,
        body: broadcast.body,
      });
      await emailSender.send({
        to: contact.email,
        subject: broadcast.subject,
        body: tracked.textBody,
        htmlBody: tracked.htmlBody,
      });
      sent++;
    } catch (err) {
      console.error(`[Broadcast] Failed to send to ${contact.email}:`, err.message);
      failed++;
    }

    // Small delay to stay within SES rate limits
    await new Promise(r => setTimeout(r, 50));

    // Progress update every 500 emails
    if ((i + 1) % 500 === 0) {
      db.updateBroadcastProgress(broadcastId, sent, failed);
      await telegram.sendMessage(
        `📊 Broadcast #${broadcastId} progress: ${sent} sent, ${failed} failed, ${contacts.length - i - 1} remaining...`
      );
    }
  }

  db.updateBroadcastProgress(broadcastId, sent, failed);
  db.updateBroadcastStatus(broadcastId, failed === contacts.length ? 'failed' : 'sent');

  await telegram.sendMessage(
    `✅ Broadcast #${broadcastId} complete!\n` +
    `Sent: ${sent} | Failed: ${failed} | Total: ${contacts.length}`
  );

  return { sent, failed, total: contacts.length };
}

async function sendBroadcastTest(broadcastId, testEmails) {
  const broadcast = db.getBroadcast(broadcastId);
  if (!broadcast) throw new Error('Broadcast not found');

  db.updateBroadcastStatus(broadcastId, 'sending');

  let sent = 0;
  let failed = 0;

  await telegram.sendMessage(`🧪 Sending test broadcast #${broadcastId} to ${testEmails.length} email(s)...`);

  for (const email of testEmails) {
    try {
      // Use tracking so test broadcasts can verify the full flow
      const contact = db.getContactByEmail(email) || { id: 0 };
      const tracked = tracking.prepareTrackedEmail({
        contactId: contact.id,
        broadcastId: broadcastId,
        body: broadcast.body,
      });
      await emailSender.send({
        to: email,
        subject: broadcast.subject,
        body: tracked.textBody,
        htmlBody: tracked.htmlBody,
      });
      sent++;
    } catch (err) {
      console.error(`[Broadcast Test] Failed to send to ${email}:`, err.message);
      failed++;
    }
  }

  db.updateBroadcastProgress(broadcastId, sent, failed);
  db.updateBroadcastStatus(broadcastId, 'sent');

  await telegram.sendMessage(
    `🧪 Test broadcast #${broadcastId} complete!\n` +
    `Sent: ${sent} | Failed: ${failed} | Total: ${testEmails.length}`
  );

  return { sent, failed, total: testEmails.length };
}

module.exports = { init, syncContacts, runOutreach, generateBroadcast, sendBroadcastToAll, sendBroadcastTest };
