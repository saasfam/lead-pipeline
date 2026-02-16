/**
 * Top 50 US metros for Google Maps scraping.
 * Format: { name, state, searchSuffix } where searchSuffix is used in Maps queries.
 */

export const CITIES = [
  { name: 'New York', state: 'NY', searchSuffix: 'New York, NY' },
  { name: 'Los Angeles', state: 'CA', searchSuffix: 'Los Angeles, CA' },
  { name: 'Chicago', state: 'IL', searchSuffix: 'Chicago, IL' },
  { name: 'Houston', state: 'TX', searchSuffix: 'Houston, TX' },
  { name: 'Phoenix', state: 'AZ', searchSuffix: 'Phoenix, AZ' },
  { name: 'Philadelphia', state: 'PA', searchSuffix: 'Philadelphia, PA' },
  { name: 'San Antonio', state: 'TX', searchSuffix: 'San Antonio, TX' },
  { name: 'San Diego', state: 'CA', searchSuffix: 'San Diego, CA' },
  { name: 'Dallas', state: 'TX', searchSuffix: 'Dallas, TX' },
  { name: 'Austin', state: 'TX', searchSuffix: 'Austin, TX' },
  { name: 'Jacksonville', state: 'FL', searchSuffix: 'Jacksonville, FL' },
  { name: 'Fort Worth', state: 'TX', searchSuffix: 'Fort Worth, TX' },
  { name: 'San Jose', state: 'CA', searchSuffix: 'San Jose, CA' },
  { name: 'Columbus', state: 'OH', searchSuffix: 'Columbus, OH' },
  { name: 'Charlotte', state: 'NC', searchSuffix: 'Charlotte, NC' },
  { name: 'Indianapolis', state: 'IN', searchSuffix: 'Indianapolis, IN' },
  { name: 'San Francisco', state: 'CA', searchSuffix: 'San Francisco, CA' },
  { name: 'Seattle', state: 'WA', searchSuffix: 'Seattle, WA' },
  { name: 'Denver', state: 'CO', searchSuffix: 'Denver, CO' },
  { name: 'Nashville', state: 'TN', searchSuffix: 'Nashville, TN' },
  { name: 'Washington', state: 'DC', searchSuffix: 'Washington, DC' },
  { name: 'Oklahoma City', state: 'OK', searchSuffix: 'Oklahoma City, OK' },
  { name: 'El Paso', state: 'TX', searchSuffix: 'El Paso, TX' },
  { name: 'Boston', state: 'MA', searchSuffix: 'Boston, MA' },
  { name: 'Portland', state: 'OR', searchSuffix: 'Portland, OR' },
  { name: 'Las Vegas', state: 'NV', searchSuffix: 'Las Vegas, NV' },
  { name: 'Memphis', state: 'TN', searchSuffix: 'Memphis, TN' },
  { name: 'Louisville', state: 'KY', searchSuffix: 'Louisville, KY' },
  { name: 'Baltimore', state: 'MD', searchSuffix: 'Baltimore, MD' },
  { name: 'Milwaukee', state: 'WI', searchSuffix: 'Milwaukee, WI' },
  { name: 'Albuquerque', state: 'NM', searchSuffix: 'Albuquerque, NM' },
  { name: 'Tucson', state: 'AZ', searchSuffix: 'Tucson, AZ' },
  { name: 'Fresno', state: 'CA', searchSuffix: 'Fresno, CA' },
  { name: 'Sacramento', state: 'CA', searchSuffix: 'Sacramento, CA' },
  { name: 'Mesa', state: 'AZ', searchSuffix: 'Mesa, AZ' },
  { name: 'Kansas City', state: 'MO', searchSuffix: 'Kansas City, MO' },
  { name: 'Atlanta', state: 'GA', searchSuffix: 'Atlanta, GA' },
  { name: 'Omaha', state: 'NE', searchSuffix: 'Omaha, NE' },
  { name: 'Raleigh', state: 'NC', searchSuffix: 'Raleigh, NC' },
  { name: 'Miami', state: 'FL', searchSuffix: 'Miami, FL' },
  { name: 'Cleveland', state: 'OH', searchSuffix: 'Cleveland, OH' },
  { name: 'Tampa', state: 'FL', searchSuffix: 'Tampa, FL' },
  { name: 'Orlando', state: 'FL', searchSuffix: 'Orlando, FL' },
  { name: 'Minneapolis', state: 'MN', searchSuffix: 'Minneapolis, MN' },
  { name: 'Pittsburgh', state: 'PA', searchSuffix: 'Pittsburgh, PA' },
  { name: 'Cincinnati', state: 'OH', searchSuffix: 'Cincinnati, OH' },
  { name: 'St. Louis', state: 'MO', searchSuffix: 'St. Louis, MO' },
  { name: 'Salt Lake City', state: 'UT', searchSuffix: 'Salt Lake City, UT' },
  { name: 'Richmond', state: 'VA', searchSuffix: 'Richmond, VA' },
  { name: 'Birmingham', state: 'AL', searchSuffix: 'Birmingham, AL' },
];

export function getCities(names = null) {
  if (!names) return CITIES;
  const set = new Set(names.map((n) => n.toLowerCase()));
  return CITIES.filter((c) => set.has(c.name.toLowerCase()));
}
