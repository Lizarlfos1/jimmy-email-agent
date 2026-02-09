// ============================================================
// Product catalog and upsell rules
// Edit this file to update products, pricing, and upsell logic
// ============================================================

const products = {
  book: {
    id: 'book',
    name: 'Precision Racing (2nd Edition)',
    slug: 'precision-racing-book',
    type: 'book',
    description: 'Comprehensive sim racing theory covering fundamentals through advanced concepts',
    price: null, // fill in actual price
    url: null,   // fill in product URL
  },
  course_fundamentals: {
    id: 'course_fundamentals',
    name: 'Sim Racing Fundamentals Course',
    slug: 'fundamentals-course',
    type: 'course',
    description: 'Online course covering the essentials of sim racing technique',
    price: null,
    url: null,
  },
  course_advanced: {
    id: 'course_advanced',
    name: 'Advanced Sim Racing Course',
    slug: 'advanced-course',
    type: 'course',
    description: 'Advanced module building on fundamentals — car setup, racecraft, consistency',
    price: null,
    url: null,
  },
  gloves: {
    id: 'gloves',
    name: 'GLZ Performance Racing Gloves',
    slug: 'glz-gloves',
    type: 'gear',
    description: 'Premium sim racing gloves for better wheel feel and grip',
    price: null,
    url: null,
  },
  // Future products — uncomment when ready
  // coaching: {
  //   id: 'coaching',
  //   name: '1-on-1 Coaching Session',
  //   slug: 'coaching-session',
  //   type: 'coaching',
  //   description: 'Personal coaching session with Jimmy',
  //   price: null,
  //   url: null,
  // },
  // masterclass: {
  //   id: 'masterclass',
  //   name: 'Masterclass',
  //   slug: 'masterclass',
  //   type: 'course',
  //   description: 'Deep-dive masterclass on specific racing topics',
  //   price: null,
  //   url: null,
  // },
};

// Maps product slugs/WooCommerce names to our product IDs.
// Add aliases here when WooCommerce product names don't match our slugs.
const productAliases = {
  'precision-racing': 'book',
  'precision-racing-book': 'book',
  'precision-racing-2nd-edition': 'book',
  'fundamentals-course': 'course_fundamentals',
  'sim-racing-fundamentals': 'course_fundamentals',
  'advanced-course': 'course_advanced',
  'sim-racing-advanced': 'course_advanced',
  'glz-gloves': 'gloves',
  'glz-performance-gloves': 'gloves',
  'racing-gloves': 'gloves',
};

// Upsell rules — ordered by priority (first match wins).
// `hasBought`: products the contact owns (ALL must match).
// `hasNotBought`: products the contact does NOT own (ALL must match).
// `suggest`: the product to recommend.
// `angle`: guidance for Claude on how to pitch it.
const upsellRules = [
  {
    hasBought: ['book'],
    hasNotBought: ['course_fundamentals'],
    suggest: 'course_fundamentals',
    angle: 'They liked the theory — now show them how to apply it with structured practice in the fundamentals course.',
  },
  {
    hasBought: ['course_fundamentals'],
    hasNotBought: ['course_advanced'],
    suggest: 'course_advanced',
    angle: 'They\'ve nailed the basics — the advanced course will take them to the next level with setup work and racecraft.',
  },
  {
    hasBought: ['course_fundamentals'],
    hasNotBought: ['book'],
    suggest: 'book',
    angle: 'Complement their practical skills with the deeper theory in the book — covers concepts the course touches on but doesn\'t go deep into.',
  },
  {
    hasBought: ['course_advanced'],
    hasNotBought: ['gloves'],
    suggest: 'gloves',
    angle: 'They\'re serious about their racing — quality gloves improve wheel feel and consistency. Natural next step for someone at their level.',
  },
  {
    hasBought: ['course_fundamentals', 'course_advanced'],
    hasNotBought: ['gloves'],
    suggest: 'gloves',
    angle: 'They\'ve invested in their skills — the gloves are the gear upgrade that matches their commitment.',
  },
  {
    hasBought: [],
    hasNotBought: ['book'],
    suggest: 'book',
    angle: 'The book is the best entry point — low commitment, packed with value, and gives them a taste of what Jimmy teaches.',
  },
];

// Nurture angle for contacts who already own everything
const nurtureFallback = {
  angle: 'They own everything — nurture the relationship. Ask how their racing is going, if they have questions, and hint that new stuff is coming.',
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
      return {
        product: products[rule.suggest],
        angle: rule.angle,
      };
    }
  }
  return { product: null, angle: nurtureFallback.angle };
}

module.exports = {
  products,
  productAliases,
  upsellRules,
  nurtureFallback,
  resolveProductId,
  getUpsellRecommendation,
};
