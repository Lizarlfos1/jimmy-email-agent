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
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WP API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Fetch contacts from FunnelKit Automations
async function fetchFunnelKitContacts(page = 1, perPage = 100) {
  try {
    const data = await wpFetch(
      `/wp-json/fkautomation/v2/contacts?per_page=${perPage}&page=${page}`
    );
    return data;
  } catch (err) {
    // FunnelKit API might have a different structure — try alternate endpoint
    console.warn('[WP] FunnelKit contacts endpoint failed, trying alternate:', err.message);
    try {
      const data = await wpFetch(
        `/wp-json/wp/v2/fk_contacts?per_page=${perPage}&page=${page}`
      );
      return data;
    } catch (err2) {
      console.error('[WP] Both FunnelKit endpoints failed:', err2.message);
      return [];
    }
  }
}

// Fetch a single contact from FunnelKit by ID
async function fetchFunnelKitContact(contactId) {
  return wpFetch(`/wp-json/fkautomation/v2/contacts/${contactId}`);
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

// Sync all contacts from FunnelKit + WooCommerce into our database
async function syncAllContacts() {
  let page = 1;
  let totalSynced = 0;

  while (true) {
    const contacts = await fetchFunnelKitContacts(page, 100);
    if (!contacts || contacts.length === 0) break;

    for (const fkContact of contacts) {
      const email = fkContact.email || fkContact.contact_email;
      if (!email) continue;

      const name = fkContact.name || fkContact.first_name
        ? `${fkContact.first_name || ''} ${fkContact.last_name || ''}`.trim()
        : null;

      const tags = Array.isArray(fkContact.tags)
        ? fkContact.tags.map(t => typeof t === 'string' ? t : t.name || t.tag)
        : [];

      // Enrich with WooCommerce order data
      let profile = { purchases: [], totalSpent: 0 };
      try {
        profile = await buildCustomerProfile(email);
      } catch (err) {
        console.warn(`[WP] Failed to build profile for ${email}:`, err.message);
      }

      db.upsertContact({
        email,
        name,
        wpContactId: String(fkContact.id || fkContact.contact_id || ''),
        tags,
        purchases: profile.purchases,
        totalSpent: profile.totalSpent,
      });

      totalSynced++;
    }

    // If we got fewer than requested, we've hit the last page
    if (contacts.length < 100) break;
    page++;
  }

  console.log(`[WP] Synced ${totalSynced} contacts`);
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
