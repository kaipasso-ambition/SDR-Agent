// Minimal CSV/TSV parser for campaign roster uploads. Handles:
//   - comma OR tab delimiters (auto-detected from the header row)
//   - quoted fields with embedded delimiters/newlines
//   - escaped quotes ("")
//   - BOM + CRLF
// Not exhaustive, but good enough for lists exported from Excel / Google
// Sheets / LinkedIn Sales Nav / Apollo.
export function parseDelimited(text) {
  if (!text) return { header: [], rows: [] };
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  // Detect delimiter: pick whichever appears more often in the first line
  const firstLine = text.split(/\r?\n/)[0] || '';
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  const delim = tabs > commas ? '\t' : ',';

  const records = parse(text, delim);
  if (records.length === 0) return { header: [], rows: [] };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const rows = records.slice(1).filter((r) => r.some((c) => c && c.trim()));
  return { header, rows };
}

function parse(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore, handled with \n */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Map a parsed row to { company, domain, contact_name, contact_title, contact_email }
// using fuzzy header matching — supports Sales Nav / Apollo / ZoomInfo naming.
export function mapRosterRow(header, row) {
  const get = (...aliases) => {
    for (const alias of aliases) {
      const idx = header.indexOf(alias);
      if (idx !== -1 && row[idx] != null && row[idx].trim()) return row[idx].trim();
    }
    return null;
  };

  const company = get('company', 'company name', 'account', 'account name', 'organization');
  const domain = get('domain', 'website', 'company website', 'company domain', 'url');

  // Name: prefer a single field, fall back to first+last
  let contact_name = get('name', 'contact name', 'full name');
  if (!contact_name) {
    const first = get('first name', 'firstname');
    const last = get('last name', 'lastname');
    if (first || last) contact_name = [first, last].filter(Boolean).join(' ');
  }

  const contact_title = get('title', 'job title', 'contact title', 'position');
  const contact_email = get('email', 'work email', 'contact email', 'email address');

  return { company, domain, contact_name, contact_title, contact_email };
}
