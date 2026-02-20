const db = require('./database');
const { resolveProductId } = require('./config');

const WP_BASE_URL = () => process.env.WP_BASE_URL?.replace(/\/$/, '');
const WP_AUTH = () =>
  'Basic ' + Buffer.from(`${process.env.WP_APP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');

// WooCommerce uses separate keys — fall back to WP app password if not set
const WC_AUTH = () => {
  if (process.env.WC_CONSUMER_KEY && process.env.WC_CONSUMER_SECRET) {
    return 'Basic ' + Buffer.from(
      `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`
    ).toString('base64');
  }
  return WP_AUTH();
};

async function wpFetch(endpoint, auth) {
  const url = `${WP_BASE_URL()}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': auth || WP_AUTH(),
      'Content-Type': 'application/json',
      'User-Agent': 'JimmyEmailAgent/1.0',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Fetch contacts from FunnelKit Automations (autonami-app)
async function fetchFunnelKitContacts(page = 1, perPage = 100) {
  const offset = (page - 1) * perPage;
  const data = await wpFetch(
    `/wp-json/autonami-app/contacts/listing?limit=${perPage}&offset=${offset}`
  );
  return data?.result || [];
}

// Fetch a single contact from FunnelKit by ID
async function fetchFunnelKitContact(contactId) {
  return wpFetch(`/wp-json/autonami-app/contacts/${contactId}`);
}

// Parse total spent from FunnelKit HTML price string (e.g. "<span...>$36.99</span>")
function parsePriceHtml(html) {
  if (!html) return 0;
  const match = String(html).match(/[\d,.]+/);
  return match ? parseFloat(match[0].replace(/,/g, '')) : 0;
}

// Fetch orders from WooCommerce
async function fetchOrders({ email, page = 1, perPage = 100 }) {
  const params = new URLSearchParams({ per_page: perPage, page, orderby: 'date', order: 'desc' });
  if (email) params.set('search', email);
  return wpFetch(`/wp-json/wc/v3/orders?${params}`, WC_AUTH());
}

// Fetch a single order
async function fetchOrder(orderId) {
  return wpFetch(`/wp-json/wc/v3/orders/${orderId}`, WC_AUTH());
}

// Build a full customer profile by combining FunnelKit + WooCommerce data
async function buildCustomerProfile(email) {
  let orders = [];
  try {
    orders = await fetchOrders({ email });
  } catch (err) {
    console.warn(`[WP] Failed to fetch orders for ${email}:`, err.message);
  }

  // Extract products purchased from order line items
  const purchasedProducts = new Set();
  let totalSpent = 0;

  for (const order of orders) {
    if (order.status === 'completed' || order.status === 'processing') {
      totalSpent += parseFloat(order.total || 0);
      for (const item of order.line_items || []) {
        const productId = resolveProductId(item.name);
        if (productId) {
          purchasedProducts.add(productId);
        } else {
          // Store raw product name if we can't resolve it
          purchasedProducts.add(item.name);
        }
      }
    }
  }

  return {
    purchases: Array.from(purchasedProducts),
    totalSpent,
    orderCount: orders.length,
  };
}

// Sync all contacts from FunnelKit into our database
async function syncAllContacts() {
  let page = 1;
  let totalSynced = 0;
  const perPage = 100;

  while (true) {
    const contacts = await fetchFunnelKitContacts(page, perPage);
    if (!contacts || contacts.length === 0) break;

    for (const c of contacts) {
      const email = c.email;
      if (!email) continue;

      const name = [c.f_name, c.l_name].filter(Boolean).join(' ') || null;

      const tags = Array.isArray(c.tags)
        ? c.tags.map(t => typeof t === 'string' ? t : t.name || t.tag)
        : [];

      // FunnelKit already provides purchased products
      const purchases = Array.isArray(c.purchased_products)
        ? c.purchased_products.map(p => resolveProductId(p.name) || p.name)
        : [];

      const totalSpent = parsePriceHtml(c.total_order_value);

      db.upsertContact({
        email,
        name,
        wpContactId: String(c.id || ''),
        tags,
        purchases,
        totalSpent,
      });

      totalSynced++;
    }

    console.log(`[WP] Synced page ${page} (${contacts.length} contacts)`);
    if (contacts.length < perPage) break;
    page++;
  }

  console.log(`[WP] Synced ${totalSynced} contacts total`);
  return totalSynced;
}

// Update a single contact's profile from WooCommerce
async function refreshContactProfile(email) {
  const profile = await buildCustomerProfile(email);
  const contact = db.getContactByEmail(email);
  if (contact) {
    db.upsertContact({
      email,
      purchases: profile.purchases,
      totalSpent: profile.totalSpent,
    });
  }
  return profile;
}

module.exports = {
  fetchFunnelKitContacts,
  fetchFunnelKitContact,
  fetchOrders,
  fetchOrder,
  buildCustomerProfile,
  syncAllContacts,
  refreshContactProfile,
};
