const { Telegraf, Markup } = require('telegraf');
const db = require('./database');
const emailBrain = require('./emailBrain');

// Escape special chars for Telegram Markdown v1: _ * ` [
function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

let bot;
let proactiveModule; // lazy-loaded to avoid circular deps
let pendingEdit = null; // { type: 'thread'|'broadcast'|'cold', id: number }

const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID;

function init() {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // Only respond to messages from the configured chat
  bot.use((ctx, next) => {
    if (String(ctx.chat?.id) !== CHAT_ID()) return;
    return next();
  });

  bot.catch((err, ctx) => {
    console.error('[Telegram] Unhandled bot error:', err);
  });

  // Handle pending edit instructions (must be before command registration)
  bot.on('text', async (ctx) => {
    if (!pendingEdit) return; // no pending edit, let other handlers run
    if (String(ctx.chat?.id) !== CHAT_ID()) return;

    // If the message is a command, cancel the edit and let commands handle it
    if (ctx.message.text.startsWith('/')) {
      pendingEdit = null;
      return;
    }

    const edit = pendingEdit;
    pendingEdit = null; // clear immediately so next messages pass through

    const instructions = ctx.message.text;
    await sendMessage('🔄 Rewriting...');

    try {
      if (edit.type === 'thread') {
        const thread = db.getThread(edit.id);
        const rewritten = await emailBrain.rewriteEmail({
          subject: thread.subject,
          body: thread.body,
          instructions,
        });
        db.updateThreadBody(edit.id, rewritten.body);
        db.updateThreadSubject(edit.id, rewritten.subject);
        db.updateThreadStatus(edit.id, 'pending_approval');
        const updatedThread = db.getThread(edit.id);
        const contact = db.getContact(thread.contact_id);
        await sendApprovalRequest(contact, updatedThread);

      } else if (edit.type === 'broadcast') {
        const broadcast = db.getBroadcast(edit.id);
        const rewritten = await emailBrain.rewriteEmail({
          subject: broadcast.subject,
          body: broadcast.body,
          instructions,
        });
        db.updateBroadcastBody(edit.id, rewritten.body);
        db.updateBroadcastSubject(edit.id, rewritten.subject);
        db.updateBroadcastStatus(edit.id, 'pending_approval');
        const updated = db.getBroadcast(edit.id);
        await sendBroadcastApproval(updated);

      } else if (edit.type === 'cold') {
        const batch = db.getColdOutreachBatch(edit.id);
        const rewritten = await emailBrain.rewriteEmail({
          subject: batch.subject,
          body: batch.body,
          instructions,
        });
        db.updateColdOutreachBatchBody(edit.id, rewritten.body);
        db.updateColdOutreachBatchSubject(edit.id, rewritten.subject);
        db.updateColdOutreachBatchStatus(edit.id, 'pending_approval');
        const updated = db.getColdOutreachBatch(edit.id);
        await sendColdOutreachApproval(updated, updated.total_contacts, updated.batch_type);
      }
    } catch (err) {
      console.error(`[Telegram] AI rewrite failed for ${edit.type} #${edit.id}:`, err);
      await sendMessage(`❌ Rewrite failed: ${err.message}`);
      // Re-show original for approval
      if (edit.type === 'thread') {
        db.updateThreadStatus(edit.id, 'pending_approval');
        const thread = db.getThread(edit.id);
        const contact = db.getContact(thread.contact_id);
        await sendApprovalRequest(contact, thread);
      } else if (edit.type === 'broadcast') {
        db.updateBroadcastStatus(edit.id, 'pending_approval');
        const broadcast = db.getBroadcast(edit.id);
        await sendBroadcastApproval(broadcast);
      } else if (edit.type === 'cold') {
        db.updateColdOutreachBatchStatus(edit.id, 'pending_approval');
        const batch = db.getColdOutreachBatch(edit.id);
        await sendColdOutreachApproval(batch, batch.total_contacts, batch.batch_type);
      }
    }
  });

  registerCommands();
  registerCallbacks();

  bot.launch({ dropPendingUpdates: true });
  console.log('[Telegram] Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

function registerCommands() {
  bot.command('help', async (ctx) => {
    const msg =
      `*Available Commands*\n\n` +
      `/status — Agent stats (contacts, pending, sent today)\n` +
      `/auto on|off — Toggle auto-approve for outbound emails\n` +
      `/broadcast — Generate a broadcast email for all contacts\n` +
      `/testbroadcast — Generate a broadcast sent only to test emails\n` +
      `/outreach — Run proactive outreach to all eligible contacts\n` +
      `/sync — Sync contacts from WooCommerce\n` +
      `/pending — Resend all pending approval requests\n` +
      `/analytics [days] — Open/click/purchase stats (default 30 days)\n` +
      `/learn — Run self-learning analysis on past email performance\n` +
      `/insights — View current learned email writing insights\n` +
      `/coldoutreach — Run daily cold outreach for non-purchasers\n` +
      `/coldstatus — View cold outreach pipeline stats\n` +
      `/blacklist email — Block a contact from receiving emails\n` +
      `/unblacklist email — Unblock a contact`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('status', async (ctx) => {
    const stats = db.getStats();
    await ctx.reply(
      `📊 *Agent Status*\n\n` +
      `Contacts: ${stats.totalContacts} (${stats.blacklisted} blacklisted)\n` +
      `Pending approvals: ${stats.pendingApprovals}\n` +
      `Sent today: ${stats.sentToday}\n` +
      `Sent this week: ${stats.sentThisWeek}\n` +
      `Auto-approve: ${stats.autoApprove ? 'ON ✅' : 'OFF ❌'}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('auto', async (ctx) => {
    const arg = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (arg === 'on') {
      db.setSetting('auto_approve', 'true');
      await ctx.reply('✅ Auto-approve is now ON. Emails will send without approval.');
    } else if (arg === 'off') {
      db.setSetting('auto_approve', 'false');
      await ctx.reply('❌ Auto-approve is now OFF. Emails require your approval.');
    } else {
      const current = db.isAutoApprove();
      await ctx.reply(
        `Auto-approve is currently ${current ? 'ON ✅' : 'OFF ❌'}\n\nUsage: /auto on | /auto off`
      );
    }
  });

  bot.command('blacklist', async (ctx) => {
    const email = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (!email || !email.includes('@')) {
      await ctx.reply('Usage: /blacklist email@example.com');
      return;
    }
    const success = db.blacklistContact(email);
    if (success) {
      await ctx.reply(`🚫 ${email} has been blacklisted.`);
    } else {
      await ctx.reply(`Contact ${email} not found in database. Add them first or check the email.`);
    }
  });

  bot.command('unblacklist', async (ctx) => {
    const email = ctx.message.text.split(' ')[1]?.toLowerCase();
    if (!email || !email.includes('@')) {
      await ctx.reply('Usage: /unblacklist email@example.com');
      return;
    }
    const success = db.unblacklistContact(email);
    if (success) {
      await ctx.reply(`✅ ${email} has been removed from the blacklist.`);
    } else {
      await ctx.reply(`Contact ${email} not found in database.`);
    }
  });

  bot.command('outreach', async (ctx) => {
    await ctx.reply('🔄 Starting proactive outreach run...');
    try {
      if (!proactiveModule) proactiveModule = require('./proactive');
      const count = await proactiveModule.runOutreach();
      await ctx.reply(`✅ Outreach complete. Generated ${count} email draft(s).`);
    } catch (err) {
      console.error('[Telegram] Outreach error:', err);
      await ctx.reply(`❌ Outreach failed: ${err.message}`);
    }
  });

  bot.command('sync', async (ctx) => {
    await ctx.reply('🔄 Starting CRM sync...');
    try {
      if (!proactiveModule) proactiveModule = require('./proactive');
      const count = await proactiveModule.syncContacts();
      await ctx.reply(`✅ Sync complete. ${count} contact(s) updated.`);
    } catch (err) {
      console.error('[Telegram] Sync error:', err);
      await ctx.reply(`❌ Sync failed: ${err.message}`);
    }
  });

  bot.command('broadcast', async (ctx) => {
    await ctx.reply('🔄 Generating broadcast email...');
    try {
      if (!proactiveModule) proactiveModule = require('./proactive');
      await proactiveModule.generateBroadcast();
    } catch (err) {
      console.error('[Telegram] Broadcast error:', err);
      await ctx.reply(`❌ Broadcast generation failed: ${err.message}`);
    }
  });

  bot.command('testbroadcast', async (ctx) => {
    const testEmails = (process.env.TEST_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
    if (testEmails.length === 0) {
      await ctx.reply('❌ No TEST_EMAILS configured in .env. Set TEST_EMAILS=email1@example.com,email2@example.com');
      return;
    }
    await ctx.reply(`🔄 Generating test broadcast (will send to ${testEmails.length} test email(s) only)...`);
    try {
      if (!proactiveModule) proactiveModule = require('./proactive');
      await proactiveModule.generateBroadcast({ testEmails });
    } catch (err) {
      console.error('[Telegram] Test broadcast error:', err);
      await ctx.reply(`❌ Test broadcast generation failed: ${err.message}`);
    }
  });

  bot.command('analytics', async (ctx) => {
    const arg = ctx.message.text.split(' ')[1];
    const days = parseInt(arg, 10) || 30;

    const stats = db.getAnalytics({ days });

    const indRate = stats.individual.sent > 0
      ? ((stats.individual.opened / stats.individual.sent) * 100).toFixed(1)
      : '0.0';
    const indClickRate = stats.individual.sent > 0
      ? ((stats.individual.clicked / stats.individual.sent) * 100).toFixed(1)
      : '0.0';

    const bcRate = stats.broadcast.sent > 0
      ? ((stats.broadcast.opened / stats.broadcast.sent) * 100).toFixed(1)
      : '0.0';
    const bcClickRate = stats.broadcast.sent > 0
      ? ((stats.broadcast.clicked / stats.broadcast.sent) * 100).toFixed(1)
      : '0.0';

    let broadcastLines = '';
    if (stats.broadcastBreakdown.length > 0) {
      broadcastLines = '\n\n*Recent Broadcasts:*\n' +
        stats.broadcastBreakdown.map(b => {
          const openPct = b.sent > 0 ? ((b.opened / b.sent) * 100).toFixed(0) : 0;
          const clickPct = b.sent > 0 ? ((b.clicked / b.sent) * 100).toFixed(0) : 0;
          const subj = escapeMd((b.subject || '').slice(0, 30));
          return `#${b.id} "${subj}" — ${b.sent} sent, ${openPct}% opened, ${clickPct}% clicked`;
        }).join('\n');
    }

    let topLinkLines = '';
    if (stats.topLinks.length > 0) {
      topLinkLines = '\n\n*Top Clicked Links:*\n' +
        stats.topLinks.map(l => {
          const shortUrl = escapeMd(l.original_url.replace('https://jimmygrills.com', '').slice(0, 40));
          return `${shortUrl} — ${l.clicks} clicks`;
        }).join('\n');
    }

    const msg =
      `*Analytics (last ${days} days)*\n\n` +
      `*Individual Emails:*\n` +
      `Sent: ${stats.individual.sent}\n` +
      `Opened: ${stats.individual.opened} (${indRate}%)\n` +
      `Clicked: ${stats.individual.clicked} (${indClickRate}%)\n\n` +
      `*Broadcasts:*\n` +
      `Sent: ${stats.broadcast.sent}\n` +
      `Opened: ${stats.broadcast.opened} (${bcRate}%)\n` +
      `Clicked: ${stats.broadcast.clicked} (${bcClickRate}%)\n\n` +
      `*Purchase Attribution:*\n` +
      `Purchases: ${stats.attributedPurchases.count}\n` +
      `Revenue: $${stats.attributedPurchases.revenue.toFixed(2)}` +
      broadcastLines +
      topLinkLines;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('learn', async (ctx) => {
    await ctx.reply('📊 Running self-learning analysis...');
    try {
      const selfLearning = require('./selfLearning');
      const result = await selfLearning.runAnalysis();
      if (!result) {
        // runAnalysis already sent its own message about insufficient data
      }
    } catch (err) {
      console.error('[Telegram] Self-learning error:', err);
      await ctx.reply(`❌ Self-learning analysis failed: ${err.message}`);
    }
  });

  bot.command('insights', async (ctx) => {
    const insights = db.getSetting('self_learning_insights');
    const meta = db.getSetting('self_learning_meta');

    if (!insights) {
      await ctx.reply('No self-learning insights stored yet. Run /learn to generate them.');
      return;
    }

    let metaInfo = '';
    if (meta) {
      const parsed = JSON.parse(meta);
      metaInfo = `Last run: ${parsed.last_run}\n` +
        `Confidence: ${parsed.confidence}\n` +
        `Broadcasts analyzed: ${parsed.broadcasts_analyzed}\n\n`;
    }

    await ctx.reply(
      `📊 *Current Email Insights*\n\n${metaInfo}${escapeMd(insights)}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('coldoutreach', async (ctx) => {
    await ctx.reply('❄️ Starting cold outreach generation...');
    try {
      if (!proactiveModule) proactiveModule = require('./proactive');
      // Expire stale batches
      db.expireOldColdOutreachBatches();
      // Follow-ups first, then new initial outreach
      await proactiveModule.generateColdFollowupBatch();
      await proactiveModule.generateColdOutreachBatch();
    } catch (err) {
      console.error('[Telegram] Cold outreach error:', err);
      await ctx.reply(`❌ Cold outreach generation failed: ${err.message}`);
    }
  });

  bot.command('coldstatus', async (ctx) => {
    const stats = db.getColdOutreachStats();
    await ctx.reply(
      `❄️ *Cold Outreach Pipeline*\n\n` +
      `Eligible (remaining): ${stats.eligible}\n` +
      `Total contacted: ${stats.total}\n` +
      `Awaiting follow-up: ${stats.sent}\n` +
      `Follow-up sent: ${stats.followupSent}\n` +
      `Replied: ${stats.replied}\n` +
      `Completed (no reply): ${stats.completed}\n` +
      `Pending batches: ${stats.pendingBatches}`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('pending', async (ctx) => {
    const pending = db.getPendingApprovals();
    if (pending.length === 0) {
      await ctx.reply('No pending approvals.');
      return;
    }
    await ctx.reply(`${pending.length} pending approval(s). Resending...`);
    for (const thread of pending) {
      const contact = db.getContact(thread.contact_id);
      await sendApprovalRequest(contact, thread);
    }
  });
}

function registerCallbacks() {
  bot.action(/^approve:(\d+)$/, async (ctx) => {
    try {
      const threadId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Approve callback for thread #${threadId}`);
      const thread = db.getThread(threadId);
      if (!thread) {
        await ctx.answerCbQuery('Thread not found');
        return;
      }
      if (thread.status !== 'pending_approval') {
        await ctx.answerCbQuery(`Already ${thread.status}`);
        return;
      }

      db.updateThreadStatus(threadId, 'approved');
      await ctx.answerCbQuery('Approved! Sending...');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      // Send the email
      try {
        const emailSender = require('./emailSender');
        const tracking = require('./tracking');
        const contact = db.getContact(thread.contact_id);
        const tracked = tracking.prepareTrackedEmail({
          contactId: contact.id,
          threadId: threadId,
          body: thread.body,
        });
        const result = await emailSender.send({
          to: contact.email,
          subject: thread.subject,
          body: tracked.textBody,
          htmlBody: tracked.htmlBody,
        });
        db.updateThreadStatus(threadId, 'sent');
        db.updateThreadSesId(threadId, result.messageId);
        db.updateContactLastEmailSent(thread.contact_id);
        await sendMessage(`✅ Sent to ${contact.name || contact.email}`);
      } catch (err) {
        console.error('[Telegram] Send error:', err);
        db.updateThreadStatus(threadId, 'failed');
        await sendMessage(`❌ Failed to send thread #${threadId}: ${err.message}`);
      }
    } catch (err) {
      console.error('[Telegram] Approve callback error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^reject:(\d+)$/, async (ctx) => {
    try {
      const threadId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Reject callback for thread #${threadId}`);
      const thread = db.getThread(threadId);
      if (!thread) {
        await ctx.answerCbQuery('Thread not found');
        return;
      }
      db.updateThreadStatus(threadId, 'rejected');
      await ctx.answerCbQuery('Rejected');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await sendMessage(`❌ Draft #${threadId} rejected.`);
    } catch (err) {
      console.error('[Telegram] Reject callback error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  // --- Broadcast callbacks ---

  bot.action(/^approve_test_bc:(\d+)$/, async (ctx) => {
    try {
      const broadcastId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Approve TEST broadcast #${broadcastId}`);
      const broadcast = db.getBroadcast(broadcastId);
      if (!broadcast) {
        await ctx.answerCbQuery('Broadcast not found');
        return;
      }
      if (broadcast.status !== 'pending_approval') {
        await ctx.answerCbQuery(`Already ${broadcast.status}`);
        return;
      }

      const testEmails = (process.env.TEST_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
      db.updateBroadcastStatus(broadcastId, 'approved');
      await ctx.answerCbQuery(`Sending to ${testEmails.length} test email(s)...`);
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      if (!proactiveModule) proactiveModule = require('./proactive');
      proactiveModule.sendBroadcastTest(broadcastId, testEmails).catch(err => {
        console.error('[Telegram] Test broadcast send error:', err);
        sendMessage(`❌ Test broadcast #${broadcastId} failed: ${err.message}`);
      });
    } catch (err) {
      console.error('[Telegram] Test broadcast approve error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^approve_bc:(\d+)$/, async (ctx) => {
    try {
      const broadcastId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Approve broadcast #${broadcastId}`);
      const broadcast = db.getBroadcast(broadcastId);
      if (!broadcast) {
        await ctx.answerCbQuery('Broadcast not found');
        return;
      }
      if (broadcast.status !== 'pending_approval') {
        await ctx.answerCbQuery(`Already ${broadcast.status}`);
        return;
      }

      db.updateBroadcastStatus(broadcastId, 'approved');
      await ctx.answerCbQuery('Approved! Sending to all contacts...');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      // Send in background — don't block the callback
      if (!proactiveModule) proactiveModule = require('./proactive');
      proactiveModule.sendBroadcastToAll(broadcastId).catch(err => {
        console.error('[Telegram] Broadcast send error:', err);
        sendMessage(`❌ Broadcast #${broadcastId} failed: ${err.message}`);
      });
    } catch (err) {
      console.error('[Telegram] Broadcast approve error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^reject_bc:(\d+)$/, async (ctx) => {
    try {
      const broadcastId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Reject broadcast #${broadcastId}`);
      const broadcast = db.getBroadcast(broadcastId);
      if (!broadcast) {
        await ctx.answerCbQuery('Broadcast not found');
        return;
      }
      db.updateBroadcastStatus(broadcastId, 'rejected');
      await ctx.answerCbQuery('Broadcast rejected');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await sendMessage(`❌ Broadcast #${broadcastId} rejected.`);
    } catch (err) {
      console.error('[Telegram] Broadcast reject error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^edit_bc:(\d+)$/, async (ctx) => {
    try {
      const broadcastId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Edit broadcast #${broadcastId}`);
      const broadcast = db.getBroadcast(broadcastId);
      if (!broadcast) {
        await ctx.answerCbQuery('Broadcast not found');
        return;
      }
      await ctx.answerCbQuery('Tell me what to change');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      pendingEdit = { type: 'broadcast', id: broadcastId };
      await sendMessage(
        `✏️ *Editing broadcast #${broadcastId}*\n\nWhat would you like to change? Describe the changes and I'll rewrite it.`,
        'Markdown'
      );
    } catch (err) {
      console.error('[Telegram] Broadcast edit error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  // --- Cold Outreach callbacks ---

  bot.action(/^approve_cold:(\d+)$/, async (ctx) => {
    try {
      const batchId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Approve cold outreach batch #${batchId}`);
      const batch = db.getColdOutreachBatch(batchId);
      if (!batch) {
        await ctx.answerCbQuery('Batch not found');
        return;
      }
      if (batch.status !== 'pending_approval') {
        await ctx.answerCbQuery(`Already ${batch.status}`);
        return;
      }

      db.updateColdOutreachBatchStatus(batchId, 'approved');
      await ctx.answerCbQuery('Approved! Sending to all contacts...');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      if (!proactiveModule) proactiveModule = require('./proactive');
      proactiveModule.sendColdOutreachBatchToAll(batchId).catch(err => {
        console.error('[Telegram] Cold outreach send error:', err);
        sendMessage(`❌ Cold outreach batch #${batchId} failed: ${err.message}`);
      });
    } catch (err) {
      console.error('[Telegram] Cold outreach approve error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^reject_cold:(\d+)$/, async (ctx) => {
    try {
      const batchId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Reject cold outreach batch #${batchId}`);
      const batch = db.getColdOutreachBatch(batchId);
      if (!batch) {
        await ctx.answerCbQuery('Batch not found');
        return;
      }
      db.updateColdOutreachBatchStatus(batchId, 'rejected');
      await ctx.answerCbQuery('Batch rejected');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

      // Free contacts so they're re-eligible
      if (batch.batch_type === 'initial') {
        db.deleteColdOutreachContactsByBatch(batchId);
      } else {
        db.resetFollowupContactsByBatch(batchId);
      }

      await sendMessage(`❌ Cold outreach batch #${batchId} rejected.`);
    } catch (err) {
      console.error('[Telegram] Cold outreach reject error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  bot.action(/^edit_cold:(\d+)$/, async (ctx) => {
    try {
      const batchId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Edit cold outreach batch #${batchId}`);
      const batch = db.getColdOutreachBatch(batchId);
      if (!batch) {
        await ctx.answerCbQuery('Batch not found');
        return;
      }
      await ctx.answerCbQuery('Tell me what to change');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      pendingEdit = { type: 'cold', id: batchId };
      await sendMessage(
        `✏️ *Editing cold outreach batch #${batchId}*\n\nWhat would you like to change? Describe the changes and I'll rewrite it.`,
        'Markdown'
      );
    } catch (err) {
      console.error('[Telegram] Cold outreach edit error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  // --- Per-contact email callbacks ---

  bot.action(/^edit:(\d+)$/, async (ctx) => {
    try {
      const threadId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Edit callback for thread #${threadId}`);
      const thread = db.getThread(threadId);
      if (!thread) {
        await ctx.answerCbQuery('Thread not found');
        return;
      }
      await ctx.answerCbQuery('Tell me what to change');
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      pendingEdit = { type: 'thread', id: threadId };
      await sendMessage(
        `✏️ *Editing draft #${threadId}*\n\nWhat would you like to change? Describe the changes and I'll rewrite it.\n\n` +
        `e.g. "make it shorter", "remove the upsell", "more casual tone", "ask about their lap times instead"`,
        'Markdown'
      );
    } catch (err) {
      console.error('[Telegram] Edit callback error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });
}

// Send a draft email to Telegram for approval
async function sendApprovalRequest(contact, thread) {
  const purchaseSummary = contact.purchases.length > 0
    ? contact.purchases.join(', ')
    : 'None';

  // Find the most recent inbound message from this contact
  const recentThreads = db.getThreadsByContact(contact.id, 10);
  const lastInbound = recentThreads.find(t => t.direction === 'inbound');
  const inboundSection = lastInbound
    ? `📩 *Their last message:*\n${escapeMd((lastInbound.body || '').slice(0, 500))}\n\n`
    : '';

  const text =
    `📧 *New Email Draft*\n\n` +
    `*To:* ${escapeMd(contact.name || 'Unknown')} <${escapeMd(contact.email)}>\n` +
    `*Purchases:* ${escapeMd(purchaseSummary)}\n` +
    `*Total spent:* $${(contact.total_spent || 0).toFixed(2)}\n\n` +
    inboundSection +
    `*Subject:* ${escapeMd(thread.subject || '(no subject)')}\n\n` +
    `---\n${escapeMd(thread.body)}\n---\n\n` +
    `Draft #${thread.id}`;

  const msg = await bot.telegram.sendMessage(CHAT_ID(), text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Approve', `approve:${thread.id}`),
        Markup.button.callback('❌ Reject', `reject:${thread.id}`),
        Markup.button.callback('✏️ Edit', `edit:${thread.id}`),
      ],
    ]),
  });

  db.updateThreadTelegramId(thread.id, msg.message_id);
}

// Send a broadcast draft to Telegram for approval (single message for all contacts)
async function sendBroadcastApproval(broadcast) {
  const contacts = db.getNonBlacklistedContacts();
  const text =
    `📢 *Broadcast Email Draft*\n\n` +
    `*Recipients:* ${contacts.length} contacts\n` +
    `*Subject:* ${escapeMd(broadcast.subject || '(no subject)')}\n\n` +
    `---\n${escapeMd(broadcast.body)}\n---\n\n` +
    (broadcast.claude_reasoning ? `💡 *Strategy:* ${escapeMd(broadcast.claude_reasoning)}\n\n` : '') +
    `Broadcast #${broadcast.id}`;

  const msg = await bot.telegram.sendMessage(CHAT_ID(), text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Send to All', `approve_bc:${broadcast.id}`),
        Markup.button.callback('❌ Reject', `reject_bc:${broadcast.id}`),
        Markup.button.callback('✏️ Edit', `edit_bc:${broadcast.id}`),
      ],
    ]),
  });

  db.updateBroadcastTelegramId(broadcast.id, msg.message_id);
}

// Send a test broadcast draft to Telegram for approval (sends to test emails only)
async function sendTestBroadcastApproval(broadcast, testEmails) {
  const text =
    `🧪 *TEST Broadcast Email Draft*\n\n` +
    `*Test recipients:* ${escapeMd(testEmails.join(', '))}\n` +
    `*Subject:* ${escapeMd(broadcast.subject || '(no subject)')}\n\n` +
    `---\n${escapeMd(broadcast.body)}\n---\n\n` +
    (broadcast.claude_reasoning ? `💡 *Strategy:* ${escapeMd(broadcast.claude_reasoning)}\n\n` : '') +
    `Broadcast #${broadcast.id}`;

  const msg = await bot.telegram.sendMessage(CHAT_ID(), text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Send Test', `approve_test_bc:${broadcast.id}`),
        Markup.button.callback('❌ Reject', `reject_bc:${broadcast.id}`),
        Markup.button.callback('✏️ Edit', `edit_bc:${broadcast.id}`),
      ],
    ]),
  });

  db.updateBroadcastTelegramId(broadcast.id, msg.message_id);
}

// Send a cold outreach batch to Telegram for approval
async function sendColdOutreachApproval(batch, contactCount, type) {
  const typeLabel = type === 'followup' ? '🔄 FOLLOW-UP' : '🆕 INITIAL';
  const text =
    `❄️ *Cold Outreach — ${typeLabel}*\n\n` +
    `*Recipients:* ${contactCount} non-purchaser(s)\n` +
    `*Subject:* ${escapeMd(batch.subject || '(no subject)')}\n\n` +
    `---\n${escapeMd(batch.body)}\n---\n\n` +
    (batch.claude_reasoning ? `💡 *Strategy:* ${escapeMd(batch.claude_reasoning)}\n\n` : '') +
    `Cold Outreach Batch #${batch.id}`;

  const msg = await bot.telegram.sendMessage(CHAT_ID(), text, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Send to All', `approve_cold:${batch.id}`),
        Markup.button.callback('❌ Reject', `reject_cold:${batch.id}`),
        Markup.button.callback('✏️ Edit', `edit_cold:${batch.id}`),
      ],
    ]),
  });

  db.updateColdOutreachBatchTelegramId(batch.id, msg.message_id);
}

// Send a plain notification (used by other modules)
async function sendMessage(text, parseMode = 'Markdown') {
  if (!bot) return;
  return bot.telegram.sendMessage(CHAT_ID(), text, { parse_mode: parseMode });
}

// Send auto-approve notification (no buttons)
async function sendAutoApproveNotification(contact, thread) {
  const text =
    `📨 *Auto-sent Email*\n\n` +
    `*To:* ${escapeMd(contact.name || 'Unknown')} <${escapeMd(contact.email)}>\n` +
    `*Subject:* ${escapeMd(thread.subject || '(no subject)')}\n\n` +
    `---\n${escapeMd(thread.body)}\n---\n\n` +
    (thread.claude_reasoning ? `💡 *Strategy:* ${escapeMd(thread.claude_reasoning)}\n` : '') +
    `Draft #${thread.id}`;

  await bot.telegram.sendMessage(CHAT_ID(), text, { parse_mode: 'Markdown' });
}

function getBot() {
  return bot;
}

module.exports = {
  init,
  getBot,
  sendApprovalRequest,
  sendBroadcastApproval,
  sendTestBroadcastApproval,
  sendColdOutreachApproval,
  sendMessage,
  sendAutoApproveNotification,
};
