/**
 * NPI dental taxonomy codes.
 *
 * All dental providers have taxonomy codes starting with "1223".
 * This module maps specific codes to human-readable specialty labels.
 */

export const DENTAL_TAXONOMY_PREFIX = '1223';

export const DENTAL_TAXONOMIES = {
  '1223G0001X': 'General Practice',
  '1223P0106X': 'Oral & Maxillofacial Pathology',
  '1223D0001X': 'Dental Public Health',
  '1223E0200X': 'Endodontics',
  '1223P0221X': 'Pediatric Dentistry',
  '1223P0300X': 'Periodontics',
  '1223P0700X': 'Prosthodontics',
  '1223S0112X': 'Oral & Maxillofacial Surgery',
  '1223X0008X': 'Oral & Maxillofacial Radiology',
  '1223X0400X': 'Orthodontics',
  '1223D0004X': 'Dentist Anesthesiologist',
  '1223G0002X': 'General Practice (Dental)',
};

/** Check if a taxonomy code is dental. */
export function isDentalTaxonomy(code) {
  return typeof code === 'string' && code.startsWith(DENTAL_TAXONOMY_PREFIX);
}

/** Get the specialty label for a taxonomy code. */
export function getSpecialtyLabel(code) {
  return DENTAL_TAXONOMIES[code] || 'General Dentistry';
}
