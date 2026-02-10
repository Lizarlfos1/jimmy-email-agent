const { Telegraf, Markup } = require('telegraf');
const db = require('./database');

let bot;
let proactiveModule; // lazy-loaded to avoid circular deps

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

  registerCommands();
  registerCallbacks();

  bot.launch({ dropPendingUpdates: true });
  console.log('[Telegram] Bot started');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

function registerCommands() {
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
        const contact = db.getContact(thread.contact_id);
        const result = await emailSender.send({
          to: contact.email,
          subject: thread.subject,
          body: thread.body,
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
      await ctx.answerCbQuery('Send me the edited email text');
      await sendMessage(
        `✏️ Reply with the edited email body for broadcast #${broadcastId}.\n` +
        `The subject line won't change. Just send the new body text.`
      );

      bot.on('text', async function editBcHandler(editCtx) {
        if (String(editCtx.chat?.id) !== CHAT_ID()) return;
        bot.off('text', editBcHandler);

        const newBody = editCtx.message.text;
        db.updateBroadcastBody(broadcastId, newBody);
        db.updateBroadcastStatus(broadcastId, 'pending_approval');

        const broadcast = db.getBroadcast(broadcastId);
        await sendMessage('✅ Broadcast updated. Resending for approval...');
        await sendBroadcastApproval(broadcast);
      });
    } catch (err) {
      console.error('[Telegram] Broadcast edit error:', err);
      await ctx.answerCbQuery('Error — check logs').catch(() => {});
    }
  });

  // --- Per-contact email callbacks ---

  bot.action(/^edit:(\d+)$/, async (ctx) => {
    try {
      const threadId = parseInt(ctx.match[1]);
      console.log(`[Telegram] Edit callback for thread #${threadId}`);
      await ctx.answerCbQuery('Send me the edited email text');
      await sendMessage(
        `✏️ Reply to this message with the edited email body for draft #${threadId}.\n` +
        `The subject line won't change. Just send the new body text.`
      );

      // Listen for the next text message as the edited body
      bot.on('text', async function editHandler(editCtx) {
        if (String(editCtx.chat?.id) !== CHAT_ID()) return;
        // Remove this one-time listener
        bot.off('text', editHandler);

        const newBody = editCtx.message.text;
        db.updateThreadBody(threadId, newBody);
        db.updateThreadStatus(threadId, 'pending_approval');

        const thread = db.getThread(threadId);
        const contact = db.getContact(thread.contact_id);
        await sendMessage('✅ Draft updated. Resending for approval...');
        await sendApprovalRequest(contact, thread);
      });
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

  const text =
    `📧 *New Email Draft*\n\n` +
    `*To:* ${contact.name || 'Unknown'} <${contact.email}>\n` +
    `*Purchases:* ${purchaseSummary}\n` +
    `*Total spent:* $${(contact.total_spent || 0).toFixed(2)}\n\n` +
    `*Subject:* ${thread.subject || '(no subject)'}\n\n` +
    `---\n${thread.body}\n---\n\n` +
    (thread.claude_reasoning ? `💡 *Strategy:* ${thread.claude_reasoning}\n\n` : '') +
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
    `*Subject:* ${broadcast.subject || '(no subject)'}\n\n` +
    `---\n${broadcast.body}\n---\n\n` +
    (broadcast.claude_reasoning ? `💡 *Strategy:* ${broadcast.claude_reasoning}\n\n` : '') +
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

// Send a plain notification (used by other modules)
async function sendMessage(text, parseMode = 'Markdown') {
  if (!bot) return;
  return bot.telegram.sendMessage(CHAT_ID(), text, { parse_mode: parseMode });
}

// Send auto-approve notification (no buttons)
async function sendAutoApproveNotification(contact, thread) {
  const text =
    `📨 *Auto-sent Email*\n\n` +
    `*To:* ${contact.name || 'Unknown'} <${contact.email}>\n` +
    `*Subject:* ${thread.subject || '(no subject)'}\n\n` +
    `---\n${thread.body}\n---\n\n` +
    (thread.claude_reasoning ? `💡 *Strategy:* ${thread.claude_reasoning}\n` : '') +
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
  sendMessage,
  sendAutoApproveNotification,
};
