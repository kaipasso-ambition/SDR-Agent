// Tiny paste-CSV parser. Handles both comma and tab separators (tab wins —
// what you get when you copy-paste out of Excel / Sheets / CSV text).
// Not RFC 4180 strict: no multi-line quoted fields, no embedded newlines.
// Good enough for list imports where every row is one line.

function detectSeparator(firstLine) {
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs >= commas && tabs > 0 ? '\t' : ',';
}

// Split a single line respecting simple "..." quoting for comma-delimited
// fields. Tab-delimited input usually has no quoting at all, which works fine.
function splitLine(line, sep) {
  if (sep === '\t') return line.split('\t').map((s) => s.trim());
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === sep && !inQuote) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function normKey(h) {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Parse pasted text into an array of { header: value } row objects.
// First non-blank line is the header row. Blank lines are skipped.
export function parsePastedCsv(text) {
  if (!text || !text.trim()) return { headers: [], rows: [] };
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const sep = detectSeparator(lines[0]);
  const rawHeaders = splitLine(lines[0], sep);
  const headers = rawHeaders.map(normKey);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ?? '';
    }
    rows.push(row);
  }
  return { headers, rows };
}
