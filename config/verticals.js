/**
 * 22 Anyreach verticals with scraping + enrichment configuration.
 *
 * Each vertical defines:
 *   - targetCount: target lead count (10K per vertical = 220K+ total)
 *   - label: display name
 *   - landingSlug: URL path under anyreach.ai/ (resolved by landingPageFor())
 *   - searchQueries: Google Maps search terms (6-8 per vertical for volume)
 *   - apolloIndustries: Apollo industry tag keywords
 *   - apolloTitles: budget-holding decision-maker title filters only
 *   - apolloSizes: employee count ranges (Apollo format)
 *   - directories: which scrapers to use beyond Google Maps
 */

const LANDING_BASE = process.env.LANDING_PAGE_BASE || 'https://anyreach.ai';

export const VERTICALS = {
  contactcenter: {
    targetCount: 10000,
    label: 'Contact Center',
    searchQueries: [
      'contact center',
      'call center company',
      'customer service center',
      'inbound call center',
      'outbound call center',
      'customer support outsourcing',
      'omnichannel contact center',
    ],
    apolloIndustries: ['outsourcing/offshoring', 'telecommunications'],
    apolloTitles: ['VP Customer Operations', 'Director of CX', 'COO', 'CEO', 'SVP Operations'],
    apolloSizes: ['51,100', '101,200', '201,500', '501,1000'],
    directories: ['google-maps', 'clutch'],
  },

  dental: {
    targetCount: 10000,
    label: 'Dental',
    searchQueries: [
      'dentist',
      'dental clinic',
      'dental office',
      'orthodontist',
      'oral surgeon',
      'cosmetic dentist',
      'pediatric dentist',
      'dental group practice',
    ],
    apolloIndustries: ['dental', 'health care'],
    apolloTitles: ['Practice Owner', 'Dentist', 'Office Manager', 'Managing Partner'],
    apolloSizes: ['1,10', '11,20', '21,50'],
    directories: ['google-maps', 'yelp'],
  },

  automotive: {
    targetCount: 10000,
    label: 'Automotive',
    searchQueries: [
      'car dealership',
      'auto dealer',
      'used car dealer',
      'auto repair shop',
      'auto body shop',
      'auto service center',
      'automotive group',
      'collision repair center',
    ],
    apolloIndustries: ['automotive'],
    apolloTitles: ['Dealer Principal', 'General Manager', 'Service Director', 'Owner'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100', '101,200'],
    directories: ['google-maps', 'yelp'],
  },

  logistics: {
    targetCount: 10000,
    label: 'Logistics',
    searchQueries: [
      'logistics company',
      'freight broker',
      'trucking company',
      'supply chain management',
      'warehousing company',
      'third party logistics',
      '3pl provider',
      'shipping and distribution',
    ],
    apolloIndustries: ['logistics and supply chain', 'transportation/trucking/railroad'],
    apolloTitles: ['VP Operations', 'Director of Logistics', 'CEO', 'COO', 'Owner'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps'],
  },

  propertymanagement: {
    targetCount: 10000,
    label: 'Property Management',
    searchQueries: [
      'property management company',
      'property manager',
      'rental management',
      'apartment management',
      'hoa management company',
      'commercial property management',
      'residential property management',
    ],
    apolloIndustries: ['real estate'],
    apolloTitles: ['VP Operations', 'Regional Manager', 'Director of Operations', 'Owner'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps'],
  },

  realestate: {
    targetCount: 10000,
    label: 'Real Estate',
    searchQueries: [
      'real estate agency',
      'real estate broker',
      'realty',
      'real estate company',
      'commercial real estate firm',
      'real estate brokerage',
      'real estate investment company',
    ],
    apolloIndustries: ['real estate'],
    apolloTitles: ['Managing Broker', 'Broker', 'Owner', 'Principal', 'VP of Sales'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps'],
  },

  healthcare: {
    targetCount: 10000,
    label: 'Healthcare',
    searchQueries: [
      'medical practice',
      'healthcare clinic',
      'urgent care center',
      'medical group',
      'physician group',
      'outpatient clinic',
      'specialty medical practice',
      'community health center',
    ],
    apolloIndustries: ['hospital & health care', 'medical practice'],
    apolloTitles: ['CMO', 'VP Operations', 'Director of Revenue Cycle', 'CEO', 'Administrator'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps'],
  },

  recruiting: {
    targetCount: 10000,
    label: 'Recruiting',
    searchQueries: [
      'staffing agency',
      'recruiting firm',
      'employment agency',
      'temp agency',
      'executive search firm',
      'talent acquisition company',
      'headhunter',
      'staffing company',
    ],
    apolloIndustries: ['staffing and recruiting', 'human resources'],
    apolloTitles: ['CEO', 'Managing Director', 'VP of Business Development', 'Owner', 'President'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps', 'clutch'],
  },

  homeservices: {
    targetCount: 10000,
    label: 'Home Services',
    searchQueries: [
      'home services company',
      'handyman service',
      'landscaping company',
      'cleaning service',
      'pest control company',
      'painting contractor',
      'remodeling contractor',
      'window cleaning service',
    ],
    apolloIndustries: ['facilities services', 'consumer services', 'construction'],
    apolloTitles: ['Owner', 'President', 'General Manager', 'CEO'],
    apolloSizes: ['1,10', '11,20', '21,50'],
    directories: ['google-maps', 'yelp'],
  },

  restaurants: {
    targetCount: 10000,
    label: 'Restaurants',
    searchQueries: [
      'restaurant',
      'catering company',
      'food service company',
      'restaurant group',
      'fast casual restaurant',
      'fine dining restaurant',
      'quick service restaurant',
      'multi-unit restaurant',
    ],
    apolloIndustries: ['restaurants', 'food & beverages'],
    apolloTitles: ['Owner', 'Multi-Unit Operator', 'Director of Operations', 'General Manager'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps', 'yelp'],
  },

  agencies: {
    targetCount: 10000,
    label: 'Agencies',
    searchQueries: [
      'marketing agency',
      'digital marketing agency',
      'advertising agency',
      'creative agency',
      'pr agency',
      'branding agency',
      'social media agency',
      'seo agency',
    ],
    apolloIndustries: ['marketing and advertising'],
    apolloTitles: ['Founder', 'CEO', 'Managing Director', 'Partner', 'President'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps', 'clutch'],
  },

  msp: {
    targetCount: 10000,
    label: 'MSP',
    searchQueries: [
      'managed it services',
      'it support company',
      'managed service provider',
      'it consulting firm',
      'cybersecurity company',
      'cloud services provider',
      'it managed services',
    ],
    apolloIndustries: ['information technology and services'],
    apolloTitles: ['Owner', 'CEO', 'President', 'VP of Operations', 'Managing Partner'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps', 'clutch'],
  },

  saas: {
    targetCount: 10000,
    label: 'SaaS',
    searchQueries: [
      'saas company',
      'software as a service',
      'cloud software company',
      'b2b software company',
      'software startup',
      'enterprise software company',
      'vertical saas company',
    ],
    apolloIndustries: ['computer software', 'internet'],
    apolloTitles: ['VP Customer Success', 'VP Support', 'CEO', 'COO', 'Head of Operations'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps', 'clutch'],
  },

  technology: {
    targetCount: 10000,
    label: 'Technology',
    searchQueries: [
      'technology company',
      'it services company',
      'software development company',
      'tech startup',
      'systems integrator',
      'data analytics company',
      'ai company',
      'devops consulting',
    ],
    apolloIndustries: ['information technology and services', 'computer software'],
    apolloTitles: ['CTO', 'VP Engineering', 'CEO', 'COO', 'VP Operations'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps', 'clutch'],
  },

  ecommerce: {
    targetCount: 10000,
    label: 'eCommerce',
    searchQueries: [
      'ecommerce company',
      'online store',
      'dtc brand',
      'direct to consumer brand',
      'online retailer',
      'ecommerce brand',
      'shopify store',
    ],
    apolloIndustries: ['retail', 'consumer goods', 'e-commerce'],
    apolloTitles: ['Founder', 'CEO', 'Head of Marketing', 'VP eCommerce', 'Head of Growth'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps'],
  },

  communications: {
    targetCount: 10000,
    label: 'Communications',
    searchQueries: [
      'telecommunications company',
      'telecom provider',
      'voip provider',
      'unified communications company',
      'internet service provider',
      'wireless carrier',
      'communications technology company',
    ],
    apolloIndustries: ['telecommunications'],
    apolloTitles: ['CTO', 'VP Operations', 'CEO', 'Director of Engineering'],
    apolloSizes: ['21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps'],
  },

  financial: {
    targetCount: 10000,
    label: 'Financial',
    searchQueries: [
      'financial services company',
      'wealth management firm',
      'financial advisory firm',
      'investment firm',
      'private equity firm',
      'credit union',
      'mortgage company',
      'fintech company',
    ],
    apolloIndustries: ['financial services', 'banking', 'investment management'],
    apolloTitles: ['VP Operations', 'Managing Director', 'CEO', 'CFO', 'COO'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200', '201,500'],
    directories: ['google-maps'],
  },

  education: {
    targetCount: 10000,
    label: 'Education',
    searchQueries: [
      'private school',
      'charter school',
      'college',
      'university',
      'vocational school',
      'online education company',
      'education technology company',
      'training institute',
    ],
    apolloIndustries: ['education management', 'e-learning', 'higher education'],
    apolloTitles: ['Dean', 'Admissions Director', 'VP of Enrollment', 'Provost', 'President'],
    apolloSizes: ['21,50', '51,100', '101,200', '201,500', '501,1000'],
    directories: ['google-maps'],
  },

  energy: {
    targetCount: 10000,
    label: 'Energy & Utilities',
    searchQueries: [
      'energy company',
      'utility company',
      'power generation company',
      'renewable energy company',
      'oil and gas company',
      'electric utility',
      'energy services company',
    ],
    apolloIndustries: ['utilities', 'oil & energy', 'renewables & environment'],
    apolloTitles: ['VP Operations', 'Director of Infrastructure', 'CEO', 'COO', 'Plant Manager'],
    apolloSizes: ['51,100', '101,200', '201,500', '501,1000'],
    directories: ['google-maps'],
  },

  insurance: {
    targetCount: 10000,
    label: 'Insurance',
    searchQueries: [
      'insurance agency',
      'insurance broker',
      'insurance agent',
      'independent insurance agency',
      'commercial insurance agency',
      'life insurance agency',
      'insurance brokerage firm',
    ],
    apolloIndustries: ['insurance'],
    apolloTitles: ['Agency Owner', 'Principal Agent', 'Managing Partner', 'VP Claims', 'Regional VP'],
    apolloSizes: ['1,10', '11,20', '21,50', '51,100'],
    directories: ['google-maps'],
  },

  travel: {
    targetCount: 10000,
    label: 'Travel & Hospitality',
    searchQueries: [
      'hotel',
      'resort',
      'travel agency',
      'boutique hotel',
      'hospitality management company',
      'vacation rental company',
      'tour operator',
      'bed and breakfast',
    ],
    apolloIndustries: ['hospitality', 'leisure, travel & tourism'],
    apolloTitles: ['General Manager', 'Owner', 'VP Operations', 'Director of Revenue', 'CEO'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200'],
    directories: ['google-maps'],
  },

  retail: {
    targetCount: 10000,
    label: 'Retail',
    searchQueries: [
      'retail store',
      'retail chain',
      'specialty retailer',
      'franchise retail',
      'multi-location retail',
      'retail group',
      'brick and mortar retail',
    ],
    apolloIndustries: ['retail', 'consumer goods'],
    apolloTitles: ['Store Manager', 'Regional Manager', 'VP of Retail', 'Director of Operations', 'Owner'],
    apolloSizes: ['11,20', '21,50', '51,100', '101,200'],
    directories: ['google-maps'],
  },
};

// Per-vertical URL slug. Kept separate from VERTICALS so adding a new
// vertical requires explicit slug consideration rather than auto-deriving
// from the key (e.g. "propertymanagement" → "property-management" is not a
// safe derivation if marketing later decides on a different path).
const LANDING_SLUGS = {
  contactcenter: 'contact-center',
  dental: 'dental',
  automotive: 'automotive',
  logistics: 'logistics',
  propertymanagement: 'property-management',
  realestate: 'real-estate',
  healthcare: 'healthcare',
  recruiting: 'recruiting',
  homeservices: 'home-services',
  restaurants: 'restaurants',
  agencies: 'agencies',
  msp: 'msp',
  saas: 'saas',
  technology: 'technology',
  ecommerce: 'ecommerce',
  communications: 'communications',
  financial: 'financial',
  education: 'education',
  energy: 'energy',
  insurance: 'insurance',
  travel: 'travel',
  retail: 'retail',
};

export function getVertical(key) {
  return VERTICALS[key] || null;
}

/**
 * Resolve the landing page URL for a vertical key.
 * Returns the configured base + slug, e.g. https://anyreach.ai/dental.
 * Falls back to the base URL when the vertical is unknown.
 */
export function landingPageFor(key) {
  const slug = LANDING_SLUGS[key];
  if (!slug) return LANDING_BASE;
  return `${LANDING_BASE}/${slug}`;
}

/**
 * The bare host of LANDING_BASE — used as Instantly's `tracking_domain`
 * so click tracking links resolve to the same root the leads land on.
 */
export function landingHost() {
  try {
    return new URL(LANDING_BASE).host;
  } catch {
    return 'anyreach.ai';
  }
}
