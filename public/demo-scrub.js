/* Demo white-label text scrub, shared by the server (JSON responses) and the
   browser (static page text). Removes the pilot client's name, its building
   names, street addresses and the city, replacing them with generic labels.
   Only used when the demo runs with DEMO_WHITE_LABEL on (the default). */
(function (root) {
  const RULES = [
    // Client name
    [/\s*\(\s*Mayo\s+Clinic\s*\)/gi, ''],
    [/\(\s*Mayo\s+/gi, '('],
    [/\bMayo\s+Clinic\s+Rochester\b/gi, 'City Centre'],
    [/\bMayo\s+Clinic['’]s\b/gi, 'the'],
    [/\bMayo['’]s\b/gi, 'the'],
    [/\bat\s+Mayo\s+Clinic\b/gi, 'on site'],
    [/\bMayo\s+Clinic\s+/gi, ''],
    [/\bMayo\s+Clinic\b/gi, 'Client'],
    [/\bMayo\s+/gi, ''],
    [/\s*\bMayo\b/gi, ''],
    [/https?:\/\/[^\s"']*mayoclinic\.org[^\s"']*/gi, ''],
    // Street addresses in brackets, e.g. "(200 1st St SW)", "(3033 41st St NW)"
    [/\s*\(\d{1,5}\s[^)]*\b(St|Ave|Avenue|Street|Rd|Road|Blvd|Dr|Pl)\b[^)]*\)/gi, ''],
    // Building names (longest phrases first)
    [/\bMary\s+Brigh\s*[—–-]\s*Saint\s+Marys\s+Hospital\b/gi, 'General Hospital — West Campus'],
    [/\bSaint\s+Marys\s+Hospital\b/gi, 'General Hospital'],
    [/\bSaint\s+Marys\b/gi, 'West Campus'],
    [/\bMary\s+Brigh\b/gi, 'General Hospital'],
    [/\bMedical\s+Complex\s+NW\s*[—–-]\s*Building\s+B\b/gi, 'Park & Ride North'],
    [/\bMedical\s+Complex\s+NW\s+Building\s+B\b/gi, 'Park & Ride North'],
    [/\bMedical\s+Complex\s+NW\b/gi, 'Park & Ride North'],
    [/\bBuilding\s+B\b/g, 'Park & Ride North'],
    [/\bGonda\s+Building\b/gi, 'Main Hospital'],
    [/\bGonda\b/gi, 'Main Hospital'],
    [/\bCharlton\s+Building\b/gi, 'Outpatient Centre'],
    [/\bCharlton\b/gi, 'Outpatient Centre'],
    [/\bBaldwin\s+Building\b/gi, 'Clinics Building'],
    [/\bBaldwin\b/gi, 'Clinics Building'],
    // City
    [/\bRochester\s*,\s*(MN|Minnesota)\b/gi, 'City Centre'],
    [/\bRochester\s+(MN|Minnesota)\b/gi, 'City Centre'],
    [/\bRochester\b/gi, 'City Centre'],
    [/\bMinneapolis\b|\bMinnesota\b/gi, 'the region'],
    // Tidy-ups
    [/\bCity Centre\s*\(\s*downtown\s*\)/gi, 'City Centre'],
    [/\s*\(\s*\)/g, ''],
  ];
  const TEST = /mayo|rochester|gonda|charlton|saint\s+marys|mary\s+brigh|baldwin|building\s+b|medical\s+complex|minneapolis|minnesota|\(\d{1,5}\s/i;
  function scrub(str) {
    if (typeof str !== 'string' || !TEST.test(str)) return str;
    let out = str;
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    return out;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { scrub };
  else root.SUS_SCRUB = scrub;
})(typeof window !== 'undefined' ? window : this);
