const cron = require('node-cron');
const db = require('./database');
const emailBrain = require('./emailBrain');
const emailSender = require('./emailSender');
const telegram = require('./telegram');
const wordpress = require('./wordpress');
const { getUpsellRecommendation } = require('./config');
const tracking = require('./tracking');
const selfLearning = require('./selfLearning');

let syncJob;
let outreachJob;
let broadcastJob;
let learningJob;
let coldOutreachJob;

async function retryOnOverload(fn, label, maxRetries = 3, delayMs = 30000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isOverloaded = err.message && err.message.includes('overloaded');
      if (isOverloaded && attempt < maxRetries) {
        console.log(`[${label}] API overloaded (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs / 1000}s...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

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

  // Self-learning analysis: check every Sunday at 3am, run if 14+ days since last
  learningJob = cron.schedule('0 3 * * 0', async () => {
    const meta = db.getSetting('self_learning_meta');
    if (meta) {
      const { last_run } = JSON.parse(meta);
      const daysSince = (Date.now() - new Date(last_run).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 13) {
        console.log(`[Cron] Self-learning: ${daysSince.toFixed(1)} days since last run, skipping.`);
        return;
      }
    }

    console.log('[Cron] Running self-learning analysis...');
    try {
      await selfLearning.runAnalysis();
    } catch (err) {
      console.error('[Cron] Self-learning analysis failed:', err);
      await telegram.sendMessage(`❌ Self-learning analysis failed: ${err.message}`);
    }
  }, { timezone: 'Australia/Sydney' });

  // Cold outreach: Sun/Tue/Wed/Fri at 7pm AEST (non-broadcast days)
  coldOutreachJob = cron.schedule('0 19 * * 0,2,3,5', async () => {
    console.log('[Cron] Running daily cold outreach...');
    try {
      // Expire stale batches first
      const expired = db.expireOldColdOutreachBatches();
      if (expired > 0) {
        console.log(`[ColdOutreach] Expired ${expired} stale batch(es).`);
      }

      // Follow-ups first (time-sensitive — contacts from 2+ days ago)
      await generateColdFollowupBatch();

      // Then new initial outreach
      await generateColdOutreachBatch();
    } catch (err) {
      console.error('[Cron] Cold outreach failed:', err);
      await telegram.sendMessage(`❌ Cold outreach failed: ${err.message}`);
    }
  }, { timezone: 'Australia/Sydney' });

  console.log('[Cron] Scheduled: sync 2am, broadcasts Mon/Thu/Sat 9am, cold outreach Sun/Tue/Wed/Fri 7pm, self-learning biweekly Sun 3am');
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
    draft = await retryOnOverload(() => emailBrain.generateBroadcast(), 'Broadcast');
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

// --- Cold Outreach ---

async function generateColdOutreachBatch() {
  // Guard: skip if pending initial batch exists
  const pendingInitial = db.getPendingColdOutreachBatch('initial');
  if (pendingInitial) {
    console.log(`[ColdOutreach] Pending initial batch #${pendingInitial.id} exists. Skipping.`);
    await telegram.sendMessage(
      `⏸️ Cold outreach: Skipping today — batch #${pendingInitial.id} is still awaiting approval.`
    );
    return null;
  }

  const limit = parseInt(process.env.COLD_OUTREACH_DAILY_LIMIT || '50', 10);
  const eligible = db.getEligibleColdOutreachContacts(limit);
  if (eligible.length === 0) {
    console.log('[ColdOutreach] No eligible contacts for cold outreach.');
    await telegram.sendMessage('📭 Cold outreach: No eligible non-purchasers found today.');
    return null;
  }

  let draft;
  try {
    draft = await retryOnOverload(() => emailBrain.generateColdOutreach(), 'ColdOutreach');
  } catch (err) {
    console.error('[ColdOutreach] Failed to generate initial email:', err.message);
    throw err;
  }

  const batch = db.createColdOutreachBatch({
    batchType: 'initial',
    subject: draft.subject,
    body: draft.body,
    claudeReasoning: draft.reasoning,
    totalContacts: eligible.length,
  });

  for (const contact of eligible) {
    db.addColdOutreachContact({ contactId: contact.id, batchId: batch.id });
  }

  console.log(`[ColdOutreach] Created initial batch #${batch.id} with ${eligible.length} contacts`);
  await telegram.sendColdOutreachApproval(batch, eligible.length, 'initial');

  return batch;
}

async function generateColdFollowupBatch() {
  // Guard: skip if pending followup batch exists
  const pendingFollowup = db.getPendingColdOutreachBatch('followup');
  if (pendingFollowup) {
    console.log(`[ColdOutreach] Pending followup batch #${pendingFollowup.id} exists. Skipping.`);
    return null;
  }

  // Cleanup: mark completed those who didn't reply to the follow-up
  const completedCount = db.markCompletedAfterFollowup();
  if (completedCount > 0) {
    console.log(`[ColdOutreach] Marked ${completedCount} contacts as completed (no reply to follow-up).`);
  }

  const eligible = db.getContactsEligibleForFollowup();
  if (eligible.length === 0) {
    console.log('[ColdOutreach] No contacts eligible for follow-up today.');
    return null;
  }

  // Get the initial batch content to reference in the follow-up
  const initialBatch = db.getColdOutreachBatch(eligible[0].batch_id);
  if (!initialBatch) {
    console.error('[ColdOutreach] Could not find initial batch for follow-up generation.');
    return null;
  }

  let draft;
  try {
    draft = await retryOnOverload(() => emailBrain.generateColdFollowup({
      initialSubject: initialBatch.subject,
      initialBody: initialBatch.body,
    }), 'ColdOutreach');
  } catch (err) {
    console.error('[ColdOutreach] Failed to generate follow-up email:', err.message);
    throw err;
  }

  const batch = db.createColdOutreachBatch({
    batchType: 'followup',
    subject: draft.subject,
    body: draft.body,
    claudeReasoning: draft.reasoning,
    totalContacts: eligible.length,
  });

  for (const coc of eligible) {
    db.markColdOutreachFollowupQueued(coc.id, batch.id);
  }

  console.log(`[ColdOutreach] Created follow-up batch #${batch.id} with ${eligible.length} contacts`);
  await telegram.sendColdOutreachApproval(batch, eligible.length, 'followup');

  return batch;
}

async function sendColdOutreachBatchToAll(batchId) {
  const batch = db.getColdOutreachBatch(batchId);
  if (!batch) throw new Error('Cold outreach batch not found');

  db.updateColdOutreachBatchStatus(batchId, 'sending');

  const isFollowup = batch.batch_type === 'followup';
  const contacts = isFollowup
    ? db.getFollowupContactsByBatch(batchId)
    : db.getColdOutreachContactsByBatch(batchId);

  let sent = 0;
  let failed = 0;

  await telegram.sendMessage(
    `📤 Sending cold outreach ${isFollowup ? 'follow-up' : 'initial'} batch #${batchId} to ${contacts.length} contacts...`
  );

  for (let i = 0; i < contacts.length; i++) {
    const coc = contacts[i];
    try {
      const contact = db.getContact(coc.contact_id);
      if (!contact || contact.blacklisted) {
        failed++;
        continue;
      }

      // Create a thread per contact for tracking + reply history
      const thread = db.createThread({
        contactId: contact.id,
        direction: 'outbound',
        subject: batch.subject,
        body: batch.body,
        status: 'sent',
        claudeReasoning: batch.claude_reasoning,
      });

      const tracked = tracking.prepareTrackedEmail({
        contactId: contact.id,
        threadId: thread.id,
        body: batch.body,
      });

      await emailSender.send({
        to: contact.email,
        subject: batch.subject,
        body: tracked.textBody,
        htmlBody: tracked.htmlBody,
      });

      if (isFollowup) {
        db.markColdOutreachFollowupSent(coc.id);
      } else {
        db.markColdOutreachInitialSent(coc.id);
      }
      db.updateContactLastEmailSent(contact.id);
      sent++;
    } catch (err) {
      console.error(`[ColdOutreach] Failed to send to ${coc.email}:`, err.message);
      db.updateColdOutreachContactStatus(coc.id, 'failed');
      failed++;
    }

    // SES rate limit delay
    await new Promise(r => setTimeout(r, 50));
  }

  db.updateColdOutreachBatchProgress(batchId, sent, failed);
  db.updateColdOutreachBatchStatus(batchId, failed === contacts.length ? 'failed' : 'sent');

  await telegram.sendMessage(
    `✅ Cold outreach ${isFollowup ? 'follow-up' : 'initial'} batch #${batchId} complete!\n` +
    `Sent: ${sent} | Failed: ${failed} | Total: ${contacts.length}`
  );

  return { sent, failed, total: contacts.length };
}

module.exports = {
  init, syncContacts, runOutreach, generateBroadcast, sendBroadcastToAll, sendBroadcastTest,
  generateColdOutreachBatch, generateColdFollowupBatch, sendColdOutreachBatchToAll,
};
