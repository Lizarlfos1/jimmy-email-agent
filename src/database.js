const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'agent.db');

let db;

function init() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      wp_contact_id TEXT,
      tags TEXT DEFAULT '[]',
      purchases TEXT DEFAULT '[]',
      total_spent REAL DEFAULT 0,
      last_email_sent TEXT,
      last_email_received TEXT,
      blacklisted INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS email_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'received'
        CHECK(status IN ('received', 'draft', 'pending_approval', 'approved', 'rejected', 'sent', 'failed')),
      telegram_message_id TEXT,
      claude_reasoning TEXT,
      ses_message_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );

    CREATE TABLE IF NOT EXISTS upsell_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      product_suggested TEXT,
      email_thread_id INTEGER,
      outcome TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (email_thread_id) REFERENCES email_threads(id)
    );

    CREATE TABLE IF NOT EXISTS broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK(status IN ('pending_approval', 'approved', 'sending', 'sent', 'rejected', 'failed')),
      telegram_message_id TEXT,
      claude_reasoning TEXT,
      total_contacts INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS email_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      contact_id INTEGER NOT NULL,
      thread_id INTEGER,
      broadcast_id INTEGER,
      first_opened_at TEXT,
      open_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (thread_id) REFERENCES email_threads(id),
      FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id)
    );

    CREATE TABLE IF NOT EXISTS tracking_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_id INTEGER NOT NULL,
      original_url TEXT NOT NULL,
      clicked_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (tracking_id) REFERENCES email_tracking(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_attributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      tracking_id INTEGER NOT NULL,
      order_total REAL DEFAULT 0,
      products TEXT DEFAULT '[]',
      attributed_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (tracking_id) REFERENCES email_tracking(id)
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_threads_contact ON email_threads(contact_id);
    CREATE INDEX IF NOT EXISTS idx_threads_status ON email_threads(status);
    CREATE INDEX IF NOT EXISTS idx_tracking_token ON email_tracking(token);
    CREATE INDEX IF NOT EXISTS idx_tracking_contact ON email_tracking(contact_id);
    CREATE INDEX IF NOT EXISTS idx_tracking_thread ON email_tracking(thread_id);
    CREATE INDEX IF NOT EXISTS idx_tracking_broadcast ON email_tracking(broadcast_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_tracking ON tracking_clicks(tracking_id);
    CREATE INDEX IF NOT EXISTS idx_attributions_contact ON purchase_attributions(contact_id);

    CREATE TABLE IF NOT EXISTS cold_outreach_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_type TEXT NOT NULL CHECK(batch_type IN ('initial', 'followup')),
      subject TEXT,
      body TEXT,
      claude_reasoning TEXT,
      status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK(status IN ('pending_approval', 'approved', 'sending', 'sent', 'rejected', 'failed', 'expired')),
      telegram_message_id TEXT,
      total_contacts INTEGER DEFAULT 0,
      sent_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cold_outreach_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued', 'sent', 'replied', 'followup_queued', 'followup_sent', 'completed', 'failed')),
      initial_sent_at TEXT,
      followup_batch_id INTEGER,
      followup_sent_at TEXT,
      replied_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (contact_id) REFERENCES contacts(id),
      FOREIGN KEY (batch_id) REFERENCES cold_outreach_batches(id),
      FOREIGN KEY (followup_batch_id) REFERENCES cold_outreach_batches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cold_outreach_contact ON cold_outreach_contacts(contact_id);
    CREATE INDEX IF NOT EXISTS idx_cold_outreach_status ON cold_outreach_contacts(status);
    CREATE INDEX IF NOT EXISTS idx_cold_outreach_batch ON cold_outreach_contacts(batch_id);
  `);

  // Seed default settings
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  upsert.run('auto_approve', 'false');

  console.log('[DB] Initialized at', DB_PATH);
}

// --- Settings ---

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?'
  ).run(key, value, value);
}

function isAutoApprove() {
  return getSetting('auto_approve') === 'true';
}

// --- Contacts ---

function upsertContact({ email, name, wpContactId, tags, purchases, totalSpent }) {
  const existing = getContactByEmail(email);
  if (existing) {
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (wpContactId !== undefined) { updates.push('wp_contact_id = ?'); params.push(wpContactId); }
    if (tags !== undefined) { updates.push('tags = ?'); params.push(JSON.stringify(tags)); }
    if (purchases !== undefined) { updates.push('purchases = ?'); params.push(JSON.stringify(purchases)); }
    if (totalSpent !== undefined) { updates.push('total_spent = ?'); params.push(totalSpent); }
    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      params.push(existing.id);
      db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return getContact(existing.id);
  }

  const result = db.prepare(
    'INSERT INTO contacts (email, name, wp_contact_id, tags, purchases, total_spent) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    email,
    name || null,
    wpContactId || null,
    JSON.stringify(tags || []),
    JSON.stringify(purchases || []),
    totalSpent || 0
  );
  return getContact(result.lastInsertRowid);
}

function getContact(id) {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  return row ? parseContact(row) : null;
}

function getContactByEmail(email) {
  const row = db.prepare('SELECT * FROM contacts WHERE email = ? COLLATE NOCASE').get(email);
  return row ? parseContact(row) : null;
}

function getAllContacts() {
  return db.prepare('SELECT * FROM contacts').all().map(parseContact);
}

function getNonBlacklistedContacts() {
  return db.prepare('SELECT * FROM contacts WHERE blacklisted = 0').all().map(parseContact);
}

function blacklistContact(email) {
  const result = db.prepare(
    "UPDATE contacts SET blacklisted = 1, updated_at = datetime('now') WHERE email = ? COLLATE NOCASE"
  ).run(email);
  return result.changes > 0;
}

function unblacklistContact(email) {
  const result = db.prepare(
    "UPDATE contacts SET blacklisted = 0, updated_at = datetime('now') WHERE email = ? COLLATE NOCASE"
  ).run(email);
  return result.changes > 0;
}

function parseContact(row) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    purchases: JSON.parse(row.purchases || '[]'),
    blacklisted: !!row.blacklisted,
  };
}

// --- Email Threads ---

function createThread({ contactId, direction, subject, body, status, claudeReasoning }) {
  const result = db.prepare(
    'INSERT INTO email_threads (contact_id, direction, subject, body, status, claude_reasoning) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(contactId, direction, subject || null, body || null, status || 'received', claudeReasoning || null);
  return getThread(result.lastInsertRowid);
}

function getThread(id) {
  return db.prepare('SELECT * FROM email_threads WHERE id = ?').get(id);
}

function getThreadsByContact(contactId, limit = 20) {
  return db.prepare(
    'SELECT * FROM email_threads WHERE contact_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(contactId, limit);
}

function getPendingApprovals() {
  return db.prepare(
    `SELECT t.*, c.email, c.name FROM email_threads t
     JOIN contacts c ON t.contact_id = c.id
     WHERE t.status = 'pending_approval'
     ORDER BY t.created_at ASC`
  ).all();
}

function updateThreadStatus(id, status) {
  db.prepare(
    "UPDATE email_threads SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

function updateThreadTelegramId(id, telegramMessageId) {
  db.prepare(
    "UPDATE email_threads SET telegram_message_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(String(telegramMessageId), id);
}

function updateThreadSesId(id, sesMessageId) {
  db.prepare(
    "UPDATE email_threads SET ses_message_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(sesMessageId, id);
}

function updateThreadBody(id, body) {
  db.prepare(
    "UPDATE email_threads SET body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(body, id);
}

function updateThreadSubject(id, subject) {
  db.prepare(
    "UPDATE email_threads SET subject = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(subject, id);
}

function getThreadByTelegramId(telegramMessageId) {
  return db.prepare(
    'SELECT * FROM email_threads WHERE telegram_message_id = ?'
  ).get(String(telegramMessageId));
}

function updateContactLastEmailSent(contactId) {
  db.prepare(
    "UPDATE contacts SET last_email_sent = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(contactId);
}

function updateContactLastEmailReceived(contactId) {
  db.prepare(
    "UPDATE contacts SET last_email_received = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(contactId);
}

// --- Rate Limiting ---

function getEmailsSentToContactThisWeek(contactId) {
  return db.prepare(
    `SELECT COUNT(*) as count FROM email_threads
     WHERE contact_id = ? AND direction = 'outbound' AND status = 'sent'
     AND created_at >= datetime('now', '-7 days')`
  ).get(contactId).count;
}

function getDaysSinceLastEmail(contactId) {
  const row = db.prepare(
    `SELECT last_email_sent FROM contacts WHERE id = ?`
  ).get(contactId);
  if (!row || !row.last_email_sent) return Infinity;
  const diff = Date.now() - new Date(row.last_email_sent + 'Z').getTime();
  return diff / (1000 * 60 * 60 * 24);
}

function canEmailContact(contactId) {
  const maxPerWeek = parseInt(process.env.MAX_EMAILS_PER_CONTACT_PER_WEEK || '2', 10);
  const minDays = parseInt(process.env.MIN_DAYS_BETWEEN_EMAILS || '3', 10);

  const contact = getContact(contactId);
  if (!contact) return { allowed: false, reason: 'Contact not found' };
  if (contact.blacklisted) return { allowed: false, reason: 'Contact is blacklisted' };

  const sentThisWeek = getEmailsSentToContactThisWeek(contactId);
  if (sentThisWeek >= maxPerWeek) {
    return { allowed: false, reason: `Already sent ${sentThisWeek} emails this week (max ${maxPerWeek})` };
  }

  const daysSince = getDaysSinceLastEmail(contactId);
  if (daysSince < minDays) {
    return { allowed: false, reason: `Only ${daysSince.toFixed(1)} days since last email (min ${minDays})` };
  }

  return { allowed: true };
}

// --- Upsell Log ---

function logUpsell({ contactId, productSuggested, emailThreadId, outcome }) {
  db.prepare(
    'INSERT INTO upsell_log (contact_id, product_suggested, email_thread_id, outcome) VALUES (?, ?, ?, ?)'
  ).run(contactId, productSuggested, emailThreadId || null, outcome || 'pending');
}

// --- Broadcasts ---

function createBroadcast({ subject, body, claudeReasoning, totalContacts }) {
  const result = db.prepare(
    'INSERT INTO broadcasts (subject, body, claude_reasoning, total_contacts) VALUES (?, ?, ?, ?)'
  ).run(subject, body, claudeReasoning || null, totalContacts || 0);
  return getBroadcast(result.lastInsertRowid);
}

function getBroadcast(id) {
  return db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id);
}

function updateBroadcastStatus(id, status) {
  db.prepare(
    "UPDATE broadcasts SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

function updateBroadcastTelegramId(id, telegramMessageId) {
  db.prepare(
    "UPDATE broadcasts SET telegram_message_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(String(telegramMessageId), id);
}

function updateBroadcastBody(id, body) {
  db.prepare(
    "UPDATE broadcasts SET body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(body, id);
}

function updateBroadcastSubject(id, subject) {
  db.prepare(
    "UPDATE broadcasts SET subject = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(subject, id);
}

function updateBroadcastProgress(id, sentCount, failedCount) {
  db.prepare(
    "UPDATE broadcasts SET sent_count = ?, failed_count = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(sentCount, failedCount, id);
}

function getPendingBroadcast() {
  return db.prepare(
    "SELECT * FROM broadcasts WHERE status = 'pending_approval' ORDER BY created_at DESC LIMIT 1"
  ).get();
}

function getRecentBroadcastTopics(limit = 6) {
  return db.prepare(
    `SELECT subject, body, created_at FROM broadcasts
     WHERE status IN ('sent', 'pending_approval', 'approved', 'sending')
     ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
}

// --- Stats ---

function getStats() {
  const totalContacts = db.prepare('SELECT COUNT(*) as c FROM contacts').get().c;
  const blacklisted = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE blacklisted = 1').get().c;
  const pendingApprovals = db.prepare("SELECT COUNT(*) as c FROM email_threads WHERE status = 'pending_approval'").get().c;
  const sentToday = db.prepare(
    "SELECT COUNT(*) as c FROM email_threads WHERE status = 'sent' AND created_at >= datetime('now', '-1 day')"
  ).get().c;
  const sentThisWeek = db.prepare(
    "SELECT COUNT(*) as c FROM email_threads WHERE status = 'sent' AND created_at >= datetime('now', '-7 days')"
  ).get().c;
  return { totalContacts, blacklisted, pendingApprovals, sentToday, sentThisWeek, autoApprove: isAutoApprove() };
}

// --- Email Tracking ---

function createTrackingToken({ contactId, threadId, broadcastId }) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(16).toString('hex');
  const result = db.prepare(
    'INSERT INTO email_tracking (token, contact_id, thread_id, broadcast_id) VALUES (?, ?, ?, ?)'
  ).run(token, contactId, threadId || null, broadcastId || null);
  return { id: result.lastInsertRowid, token };
}

function getTrackingByToken(token) {
  return db.prepare('SELECT * FROM email_tracking WHERE token = ?').get(token);
}

function recordOpen(token) {
  db.prepare(`
    UPDATE email_tracking
    SET open_count = open_count + 1,
        first_opened_at = COALESCE(first_opened_at, datetime('now'))
    WHERE token = ?
  `).run(token);
}

function recordClick({ trackingId, originalUrl }) {
  db.prepare(
    'INSERT INTO tracking_clicks (tracking_id, original_url) VALUES (?, ?)'
  ).run(trackingId, originalUrl);
}

function createPurchaseAttribution({ contactId, trackingId, orderTotal, products }) {
  db.prepare(
    'INSERT INTO purchase_attributions (contact_id, tracking_id, order_total, products) VALUES (?, ?, ?, ?)'
  ).run(contactId, trackingId, orderTotal || 0, JSON.stringify(products || []));
}

function getRecentTrackingForContact(contactId, days) {
  return db.prepare(`
    SELECT * FROM email_tracking
    WHERE contact_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(contactId, days);
}

function getAnalytics({ days = 30 } = {}) {
  const cutoff = `-${days} days`;

  const individualSent = db.prepare(`
    SELECT COUNT(*) as c FROM email_tracking
    WHERE thread_id IS NOT NULL AND created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const individualOpened = db.prepare(`
    SELECT COUNT(*) as c FROM email_tracking
    WHERE thread_id IS NOT NULL AND open_count > 0 AND created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const individualClicked = db.prepare(`
    SELECT COUNT(DISTINCT et.id) as c FROM email_tracking et
    INNER JOIN tracking_clicks tc ON tc.tracking_id = et.id
    WHERE et.thread_id IS NOT NULL AND et.created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const broadcastSent = db.prepare(`
    SELECT COUNT(*) as c FROM email_tracking
    WHERE broadcast_id IS NOT NULL AND created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const broadcastOpened = db.prepare(`
    SELECT COUNT(*) as c FROM email_tracking
    WHERE broadcast_id IS NOT NULL AND open_count > 0 AND created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const broadcastClicked = db.prepare(`
    SELECT COUNT(DISTINCT et.id) as c FROM email_tracking et
    INNER JOIN tracking_clicks tc ON tc.tracking_id = et.id
    WHERE et.broadcast_id IS NOT NULL AND et.created_at >= datetime('now', ?)
  `).get(cutoff).c;

  const attributedPurchases = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(order_total), 0) as revenue
    FROM purchase_attributions
    WHERE attributed_at >= datetime('now', ?)
  `).get(cutoff);

  const topLinks = db.prepare(`
    SELECT original_url, COUNT(*) as clicks
    FROM tracking_clicks tc
    INNER JOIN email_tracking et ON et.id = tc.tracking_id
    WHERE et.created_at >= datetime('now', ?)
    GROUP BY original_url
    ORDER BY clicks DESC
    LIMIT 5
  `).all(cutoff);

  const broadcastBreakdown = db.prepare(`
    SELECT
      b.id,
      b.subject,
      b.created_at,
      COUNT(et.id) as sent,
      SUM(CASE WHEN et.open_count > 0 THEN 1 ELSE 0 END) as opened,
      (SELECT COUNT(DISTINCT tc2.tracking_id) FROM tracking_clicks tc2
       INNER JOIN email_tracking et2 ON et2.id = tc2.tracking_id
       WHERE et2.broadcast_id = b.id) as clicked
    FROM broadcasts b
    LEFT JOIN email_tracking et ON et.broadcast_id = b.id
    WHERE b.status = 'sent' AND b.created_at >= datetime('now', ?)
    GROUP BY b.id
    ORDER BY b.created_at DESC
    LIMIT 10
  `).all(cutoff);

  return {
    individual: { sent: individualSent, opened: individualOpened, clicked: individualClicked },
    broadcast: { sent: broadcastSent, opened: broadcastOpened, clicked: broadcastClicked },
    attributedPurchases: { count: attributedPurchases.count, revenue: attributedPurchases.revenue },
    topLinks,
    broadcastBreakdown,
  };
}

// --- Self-Learning Queries ---

function getBroadcastsWithPerformance() {
  return db.prepare(`
    SELECT
      b.id,
      b.subject,
      b.body,
      b.created_at,
      b.total_contacts,
      b.sent_count,
      COUNT(DISTINCT et.id) as tracked_count,
      COUNT(DISTINCT CASE WHEN et.open_count > 0 THEN et.id END) as open_count,
      COUNT(DISTINCT CASE WHEN tc.id IS NOT NULL THEN et.id END) as click_count,
      COUNT(DISTINCT pa.id) as purchase_count,
      COALESCE(SUM(DISTINCT pa.order_total), 0) as purchase_revenue
    FROM broadcasts b
    LEFT JOIN email_tracking et ON et.broadcast_id = b.id
    LEFT JOIN tracking_clicks tc ON tc.tracking_id = et.id
    LEFT JOIN purchase_attributions pa ON pa.tracking_id = et.id
    WHERE b.status = 'sent'
    GROUP BY b.id
    ORDER BY b.created_at DESC
  `).all();
}

function getClickedUrlsForBroadcast(broadcastId) {
  return db.prepare(`
    SELECT tc.original_url, COUNT(*) as clicks
    FROM tracking_clicks tc
    INNER JOIN email_tracking et ON et.id = tc.tracking_id
    WHERE et.broadcast_id = ?
    GROUP BY tc.original_url
    ORDER BY clicks DESC
  `).all(broadcastId);
}

// --- Cold Outreach Batches ---

function createColdOutreachBatch({ batchType, subject, body, claudeReasoning, totalContacts }) {
  const result = db.prepare(
    'INSERT INTO cold_outreach_batches (batch_type, subject, body, claude_reasoning, total_contacts) VALUES (?, ?, ?, ?, ?)'
  ).run(batchType, subject, body, claudeReasoning || null, totalContacts || 0);
  return getColdOutreachBatch(result.lastInsertRowid);
}

function getColdOutreachBatch(id) {
  return db.prepare('SELECT * FROM cold_outreach_batches WHERE id = ?').get(id);
}

function updateColdOutreachBatchStatus(id, status) {
  db.prepare(
    "UPDATE cold_outreach_batches SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

function updateColdOutreachBatchTelegramId(id, telegramMessageId) {
  db.prepare(
    "UPDATE cold_outreach_batches SET telegram_message_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(String(telegramMessageId), id);
}

function updateColdOutreachBatchBody(id, body) {
  db.prepare(
    "UPDATE cold_outreach_batches SET body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(body, id);
}

function updateColdOutreachBatchSubject(id, subject) {
  db.prepare(
    "UPDATE cold_outreach_batches SET subject = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(subject, id);
}

function updateColdOutreachBatchProgress(id, sentCount, failedCount) {
  db.prepare(
    "UPDATE cold_outreach_batches SET sent_count = ?, failed_count = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(sentCount, failedCount, id);
}

function getPendingColdOutreachBatch(batchType) {
  return db.prepare(
    "SELECT * FROM cold_outreach_batches WHERE status = 'pending_approval' AND batch_type = ? ORDER BY created_at DESC LIMIT 1"
  ).get(batchType);
}

// --- Cold Outreach Contacts ---

function addColdOutreachContact({ contactId, batchId }) {
  db.prepare(
    'INSERT INTO cold_outreach_contacts (contact_id, batch_id) VALUES (?, ?)'
  ).run(contactId, batchId);
}

function getColdOutreachContactsByBatch(batchId) {
  return db.prepare(
    `SELECT coc.*, c.email, c.name FROM cold_outreach_contacts coc
     JOIN contacts c ON coc.contact_id = c.id
     WHERE coc.batch_id = ?`
  ).all(batchId);
}

function getFollowupContactsByBatch(followupBatchId) {
  return db.prepare(
    `SELECT coc.*, c.email, c.name FROM cold_outreach_contacts coc
     JOIN contacts c ON coc.contact_id = c.id
     WHERE coc.followup_batch_id = ?`
  ).all(followupBatchId);
}

function getColdOutreachByContactId(contactId) {
  return db.prepare(
    'SELECT * FROM cold_outreach_contacts WHERE contact_id = ? LIMIT 1'
  ).get(contactId);
}

function getColdOutreachByContactEmail(email) {
  return db.prepare(
    `SELECT coc.* FROM cold_outreach_contacts coc
     JOIN contacts c ON coc.contact_id = c.id
     WHERE c.email = ? COLLATE NOCASE
     AND coc.status IN ('sent', 'followup_queued', 'followup_sent')
     ORDER BY coc.created_at DESC LIMIT 1`
  ).get(email);
}

function markColdOutreachInitialSent(id) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = 'sent', initial_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

function markColdOutreachFollowupQueued(id, followupBatchId) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = 'followup_queued', followup_batch_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(followupBatchId, id);
}

function markColdOutreachFollowupSent(id) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = 'followup_sent', followup_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

function markColdOutreachReplied(id) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = 'replied', replied_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
  ).run(id);
}

function updateColdOutreachContactStatus(id, status) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

function getEligibleColdOutreachContacts(limit) {
  return db.prepare(
    `SELECT c.* FROM contacts c
     LEFT JOIN cold_outreach_contacts coc ON coc.contact_id = c.id
     WHERE c.blacklisted = 0
     AND (c.purchases = '[]' OR c.purchases IS NULL)
     AND c.total_spent = 0
     AND coc.id IS NULL
     ORDER BY c.created_at ASC
     LIMIT ?`
  ).all(limit).map(parseContact);
}

function getContactsEligibleForFollowup() {
  return db.prepare(
    `SELECT coc.*, c.email, c.name FROM cold_outreach_contacts coc
     JOIN contacts c ON coc.contact_id = c.id
     WHERE coc.status = 'sent'
     AND coc.initial_sent_at <= datetime('now', '-2 days')
     ORDER BY coc.initial_sent_at ASC`
  ).all();
}

function markCompletedAfterFollowup() {
  const result = db.prepare(
    `UPDATE cold_outreach_contacts
     SET status = 'completed', updated_at = datetime('now')
     WHERE status = 'followup_sent'
     AND followup_sent_at <= datetime('now', '-3 days')`
  ).run();
  return result.changes;
}

function expireOldColdOutreachBatches() {
  const expired = db.prepare(
    `UPDATE cold_outreach_batches
     SET status = 'expired', updated_at = datetime('now')
     WHERE status = 'pending_approval'
     AND created_at <= datetime('now', '-2 days')`
  ).run();

  if (expired.changes > 0) {
    // Free contacts from expired initial batches
    db.prepare(
      `DELETE FROM cold_outreach_contacts
       WHERE batch_id IN (SELECT id FROM cold_outreach_batches WHERE status = 'expired' AND batch_type = 'initial')
       AND status = 'queued'`
    ).run();

    // Reset follow-up contacts from expired follow-up batches
    db.prepare(
      `UPDATE cold_outreach_contacts
       SET status = 'sent', followup_batch_id = NULL, updated_at = datetime('now')
       WHERE followup_batch_id IN (SELECT id FROM cold_outreach_batches WHERE status = 'expired' AND batch_type = 'followup')
       AND status = 'followup_queued'`
    ).run();
  }

  return expired.changes;
}

function deleteColdOutreachContactsByBatch(batchId) {
  db.prepare(
    "DELETE FROM cold_outreach_contacts WHERE batch_id = ? AND status = 'queued'"
  ).run(batchId);
}

function resetFollowupContactsByBatch(followupBatchId) {
  db.prepare(
    "UPDATE cold_outreach_contacts SET status = 'sent', followup_batch_id = NULL, updated_at = datetime('now') WHERE followup_batch_id = ? AND status = 'followup_queued'"
  ).run(followupBatchId);
}

function getColdOutreachStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM cold_outreach_contacts').get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM cold_outreach_contacts WHERE status = 'sent'").get().c;
  const replied = db.prepare("SELECT COUNT(*) as c FROM cold_outreach_contacts WHERE status = 'replied'").get().c;
  const followupSent = db.prepare("SELECT COUNT(*) as c FROM cold_outreach_contacts WHERE status = 'followup_sent'").get().c;
  const completed = db.prepare("SELECT COUNT(*) as c FROM cold_outreach_contacts WHERE status = 'completed'").get().c;
  const pendingBatches = db.prepare("SELECT COUNT(*) as c FROM cold_outreach_batches WHERE status = 'pending_approval'").get().c;
  const eligible = db.prepare(
    `SELECT COUNT(*) as c FROM contacts c
     LEFT JOIN cold_outreach_contacts coc ON coc.contact_id = c.id
     WHERE c.blacklisted = 0
     AND (c.purchases = '[]' OR c.purchases IS NULL)
     AND c.total_spent = 0
     AND coc.id IS NULL`
  ).get().c;
  return { total, sent, replied, followupSent, completed, pendingBatches, eligible };
}

function getDb() {
  return db;
}

module.exports = {
  init,
  getDb,
  getSetting,
  setSetting,
  isAutoApprove,
  upsertContact,
  getContact,
  getContactByEmail,
  getAllContacts,
  getNonBlacklistedContacts,
  blacklistContact,
  unblacklistContact,
  createThread,
  getThread,
  getThreadsByContact,
  getPendingApprovals,
  updateThreadStatus,
  updateThreadTelegramId,
  updateThreadSesId,
  updateThreadBody,
  updateThreadSubject,
  getThreadByTelegramId,
  updateContactLastEmailSent,
  updateContactLastEmailReceived,
  canEmailContact,
  logUpsell,
  createBroadcast,
  getBroadcast,
  updateBroadcastStatus,
  updateBroadcastTelegramId,
  updateBroadcastBody,
  updateBroadcastSubject,
  updateBroadcastProgress,
  getPendingBroadcast,
  getRecentBroadcastTopics,
  getStats,
  createTrackingToken,
  getTrackingByToken,
  recordOpen,
  recordClick,
  createPurchaseAttribution,
  getRecentTrackingForContact,
  getAnalytics,
  getBroadcastsWithPerformance,
  getClickedUrlsForBroadcast,
  createColdOutreachBatch,
  getColdOutreachBatch,
  updateColdOutreachBatchStatus,
  updateColdOutreachBatchTelegramId,
  updateColdOutreachBatchBody,
  updateColdOutreachBatchSubject,
  updateColdOutreachBatchProgress,
  getPendingColdOutreachBatch,
  addColdOutreachContact,
  getColdOutreachContactsByBatch,
  getFollowupContactsByBatch,
  getColdOutreachByContactId,
  getColdOutreachByContactEmail,
  markColdOutreachInitialSent,
  markColdOutreachFollowupQueued,
  markColdOutreachFollowupSent,
  markColdOutreachReplied,
  updateColdOutreachContactStatus,
  getEligibleColdOutreachContacts,
  getContactsEligibleForFollowup,
  markCompletedAfterFollowup,
  expireOldColdOutreachBatches,
  deleteColdOutreachContactsByBatch,
  resetFollowupContactsByBatch,
  getColdOutreachStats,
};
