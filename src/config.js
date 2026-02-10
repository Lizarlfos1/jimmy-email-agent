// ============================================================
// Product catalog, lead magnets, and upsell rules
// Edit this file to update products, pricing, and upsell logic
// ============================================================

// --- Paid Products ---
const products = {
  book: {
    id: 'book',
    name: 'Precision Racing (PDF)',
    slug: 'precision-racing-pdf',
    type: 'book',
    price: 36.99,
    url: 'https://jimmygrills.com/sp/precision-racing-pdf/',
    description: 'Comprehensive sim racing theory book covering fundamentals through advanced concepts (PDF)',
  },
  university: {
    id: 'university',
    name: 'Sim Racing University',
    slug: 'sim-racing-university',
    type: 'course',
    price: 89.95,
    url: 'https://jimmygrills.com/sp/sim-racing-university/',
    description: 'Complete video course with all 4 core modules, lifetime platform access, Fundamentals Bootcamp (5-day program), Improvement Challenge (30-day program), Car Handling Exercise Library, and weekly Time Trial Challenges',
  },
};

// --- Free Lead Magnets ---
const leadMagnets = {
  trail_braking_pdf: {
    id: 'trail_braking_pdf',
    name: 'Advanced Trail Braking Framework (PDF)',
    url: 'https://jimmygrills.com/wp-content/uploads/2026/01/Advanced_Trail_Braking_Framework.pdf',
    description: 'Free PDF guide diving deep into trail braking technique',
    topics: ['trail braking', 'braking', 'corner entry', 'rotation'],
  },
  driving_drills_pdf: {
    id: 'driving_drills_pdf',
    name: '3 Must-Know Driving Drills (PDF)',
    url: 'https://jimmygrills.com/wp-content/uploads/2025/11/3-Must-Know-Driving-Exercises-Jimmy-Grills.pdf',
    description: 'Free PDF with 3 practical driving exercises to improve consistency',
    topics: ['drills', 'exercises', 'practice', 'consistency', 'fundamentals'],
  },
  throttle_audit: {
    id: 'throttle_audit',
    name: 'Throttle Control Audit',
    url: 'https://jimmygrills.com/sp/throttle-audit/',
    description: 'Free interactive tool — log your laps, identify throttle errors, and get personalised drills based on your most common mistakes',
    topics: ['throttle', 'throttle control', 'acceleration', 'exit speed', 'traction'],
  },
};

// Maps product slugs/WooCommerce names to our product IDs.
// Add aliases here when WooCommerce product names don't match our slugs.
const productAliases = {
  'precision-racing': 'book',
  'precision-racing-pdf': 'book',
  'precision-racing-book': 'book',
  'precision-racing-2nd-edition': 'book',
  'precision-racing--pdf-': 'book',
  'sim-racing-university': 'university',
  'sim-racing-uni': 'university',
  'university': 'university',
};

// Upsell rules — ordered by priority (first match wins).
// `hasBought`: products the contact owns (ALL must match).
// `hasNotBought`: products the contact does NOT own (ALL must match).
// `suggest`: product ID to recommend (from products or leadMagnets).
// `type`: 'product' or 'lead_magnet' — determines which catalog to look up.
// `angle`: guidance for Claude on how to pitch it.
const upsellRules = [
  // Paid product upsells
  {
    hasBought: ['book'],
    hasNotBought: ['university'],
    suggest: 'university',
    type: 'product',
    angle: 'They\'ve read the theory — Sim Racing University is the next step to put it into practice with structured video modules, the 5-day Fundamentals Bootcamp, and the 30-day Improvement Challenge.',
  },
  {
    hasBought: ['university'],
    hasNotBought: ['book'],
    suggest: 'book',
    type: 'product',
    angle: 'They\'re already in the University — the Precision Racing book goes deeper on the theory behind the techniques they\'re practicing. Great companion resource.',
  },
  // Downsell to free lead magnets for non-buyers
  {
    hasBought: [],
    hasNotBought: ['book', 'university'],
    suggest: 'trail_braking_pdf',
    type: 'lead_magnet',
    angle: 'They haven\'t bought anything yet — offer genuine free value first to build trust. The Advanced Trail Braking PDF is a great entry point that demonstrates Jimmy\'s teaching quality.',
  },
  // Fallback — suggest the book (cheapest paid product)
  {
    hasBought: [],
    hasNotBought: ['book'],
    suggest: 'book',
    type: 'product',
    angle: 'The Precision Racing book is the best entry point — $36.99, packed with value, and gives them a solid foundation in sim racing theory.',
  },
];

// Nurture angle for contacts who already own everything
const nurtureFallback = {
  angle: 'They own both products — nurture the relationship. Ask how their racing is going, how they\'re finding the University content, and if they have any questions.',
};

// Resolve a WooCommerce product name/slug to our internal product ID
function resolveProductId(nameOrSlug) {
  const normalized = nameOrSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  if (products[normalized]) return normalized;
  if (productAliases[normalized]) return productAliases[normalized];
  // Try partial match
  for (const [alias, id] of Object.entries(productAliases)) {
    if (normalized.includes(alias) || alias.includes(normalized)) return id;
  }
  return null;
}

// Given a list of product IDs the contact owns, return the best upsell
function getUpsellRecommendation(ownedProductIds) {
  for (const rule of upsellRules) {
    const hasAll = rule.hasBought.every(p => ownedProductIds.includes(p));
    const lacksAll = rule.hasNotBought.every(p => !ownedProductIds.includes(p));
    if (hasAll && lacksAll) {
      const catalog = rule.type === 'lead_magnet' ? leadMagnets : products;
      return {
        product: catalog[rule.suggest],
        type: rule.type || 'product',
        angle: rule.angle,
      };
    }
  }
  return { product: null, type: null, angle: nurtureFallback.angle };
}

module.exports = {
  products,
  leadMagnets,
  productAliases,
  upsellRules,
  nurtureFallback,
  resolveProductId,
  getUpsellRecommendation,
};
