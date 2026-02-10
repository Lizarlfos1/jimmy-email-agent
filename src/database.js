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

    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_threads_contact ON email_threads(contact_id);
    CREATE INDEX IF NOT EXISTS idx_threads_status ON email_threads(status);
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
  updateBroadcastProgress,
  getPendingBroadcast,
  getStats,
};
