const cron = require('node-cron');
const db = require('./database');
const emailBrain = require('./emailBrain');
const emailSender = require('./emailSender');
const telegram = require('./telegram');
const wordpress = require('./wordpress');
const { getUpsellRecommendation } = require('./config');

let syncJob;
let outreachJob;

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

  // Run proactive outreach daily at 10am
  outreachJob = cron.schedule('0 10 * * *', async () => {
    console.log('[Cron] Running proactive outreach...');
    try {
      const count = await runOutreach();
      await telegram.sendMessage(`📧 Outreach complete. ${count} draft(s) generated.`);
    } catch (err) {
      console.error('[Cron] Outreach failed:', err);
      await telegram.sendMessage(`❌ Outreach failed: ${err.message}`);
    }
  }, { timezone: 'Australia/Sydney' });

  console.log('[Cron] Scheduled: sync at 2am AEST, outreach at 10am AEST');
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
        const result = await emailSender.send({
          to: contact.email,
          subject: draft.subject,
          body: draft.body,
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

module.exports = { init, syncContacts, runOutreach };
