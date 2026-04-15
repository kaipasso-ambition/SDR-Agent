// Play → PowerPoint (.pptx) exporter. Three slides, readable at
// the back of the room:
//
//   1. Title            — AMBITION brand, play name + account.
//   2. The play         — numbered step diagram, left-to-right, with a
//                         "YOU ARE HERE" marker on the current step and
//                         a "WHO HAS THE BALL" callout.
//   3. The org          — contact tree (reports_to) with the path
//                         numbered and the champion highlighted.
//
// Voice/brand rules:
//   - White background, slate-900 ink, emerald accent — matches the
//     Ambition corporate deck (AMBITION wordmark on every slide,
//     "<month year> · ambition.com" footer).
//   - Font sizes are deliberately big. This deck gets shared; it has
//     to read at a glance, not reward squinting.
//   - The full sales-kit content (artifacts, narratives, positioning
//     hooks) lives in the app — the exported deck is the briefing
//     summary, not the playbook in full.

import PptxGenJS from 'pptxgenjs';

const COLORS = {
  ink:        '0F172A',   // slate-900
  body:       '334155',   // slate-700
  muted:      '64748B',   // slate-500
  rule:       'E2E8F0',   // slate-200
  surface:    'F8FAFC',   // slate-50
  accent:     '059669',   // emerald-600  (Ambition green)
  accentSoft: 'D1FAE5',   // emerald-100
  accentInk:  '064E3B',   // emerald-900
  warn:       'D97706',   // amber-600
  risk:       'DC2626',   // red-600
  bg:         'FFFFFF',
};

const ROLE_LABEL = {
  economic_buyer: 'Economic Buyer',
  champion:       'Champion',
  coach:          'Coach',
  influencer:     'Influencer',
  blocker:        'Blocker',
  user:           'User',
  unknown:        '—',
};

const STANCE_COLOR = {
  hot:     '059669',
  warm:    '10B981',
  neutral: '94A3B8',
  cold:    '60A5FA',
  hostile: 'DC2626',
};

// Build a filename that's safe on Drive/Windows.
export function buildFilename(accountName, namedPlay) {
  const slug = `${accountName || 'account'}-${namedPlay || 'play'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'play'}.pptx`;
}

// Main entry point — returns a Node Buffer of the .pptx file.
export async function renderPlayPptx({ play, account, hypothesis, contacts = [] }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';         // 13.333 x 7.5 inches
  pptx.title = play.ai_expansion?.named_play || 'Account Play';
  pptx.company = 'Ambition.com';

  const exp = play.ai_expansion || {};
  const moves = Array.isArray(exp.moves) ? exp.moves : [];
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const pathResolved = (play.contact_path || []).map((id) => byId.get(id)).filter(Boolean);

  // Current step: first move whose day is in the future relative to
  // play.created_at. Falls back to the first move on fresh plays and
  // the last move on plays that have run past their schedule.
  const createdAt = play.created_at ? new Date(play.created_at).getTime() : Date.now();
  const daysSince = Math.max(0, (Date.now() - createdAt) / 86400000);
  let currentStepIdx = moves.findIndex((m) => (m.days_from_now ?? 0) >= daysSince);
  if (currentStepIdx === -1) currentStepIdx = moves.length - 1;
  if (moves.length === 0) currentStepIdx = -1;

  addTitleSlide(pptx, { play, account, exp });
  addPlaySlide(pptx, { play, account, exp, moves, currentStepIdx });
  addOrgSlide(pptx, { account, contacts, pathResolved });

  const buf = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

// ---------- shared chrome ----------

// AMBITION wordmark. Real logo lives outside the repo; we approximate
// with a filled emerald ring + wordmark so the deck reads as on-brand
// without shipping binary assets.
function addBrandMark(s, { x, y }) {
  s.addShape('oval', {
    x, y, w: 0.32, h: 0.32,
    fill: { color: COLORS.bg },
    line: { color: COLORS.accent, width: 2.25 },
  });
  s.addShape('oval', {
    x: x + 0.11, y: y + 0.11, w: 0.10, h: 0.10,
    fill: { color: COLORS.accent }, line: { color: COLORS.accent },
  });
  s.addText('AMBITION', {
    x: x + 0.38, y: y + 0.02, w: 1.6, h: 0.28,
    color: COLORS.ink,
    fontSize: 14, bold: true, charSpacing: 3, fontFace: 'Calibri',
    valign: 'middle',
  });
}

function addFooter(s, { leftText } = {}) {
  s.addShape('line', {
    x: 0.6, y: 7.15, w: 12.2, h: 0,
    line: { color: COLORS.rule, width: 0.75 },
  });
  s.addText(leftText || monthYear(new Date()), {
    x: 0.6, y: 7.2, w: 6, h: 0.25,
    color: COLORS.muted, fontSize: 10, fontFace: 'Calibri',
  });
  s.addText('ambition.com', {
    x: 6.8, y: 7.2, w: 6, h: 0.25,
    color: COLORS.muted, fontSize: 10, fontFace: 'Calibri', align: 'right',
  });
}

function monthYear(d) {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// ---------- slide 1: title ----------

function addTitleSlide(pptx, { play, account, exp }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };

  addBrandMark(s, { x: 0.6, y: 0.55 });

  s.addText('GAME PLAN', {
    x: 0.6, y: 2.0, w: 7.5, h: 0.4,
    color: COLORS.accent, fontSize: 16, bold: true, charSpacing: 4, fontFace: 'Calibri',
  });

  s.addText(exp.named_play || 'Untitled play', {
    x: 0.6, y: 2.45, w: 9.2, h: 2.6,
    color: COLORS.ink, fontSize: 54, bold: true, fontFace: 'Calibri',
    valign: 'top', lineSpacingMultiple: 1.05,
  });

  s.addText(
    `for ${account?.account_name || 'Account'}${account?.industry ? '  ·  ' + account.industry : ''}`,
    {
      x: 0.6, y: 5.3, w: 9.2, h: 0.5,
      color: COLORS.body, fontSize: 22, fontFace: 'Calibri',
    }
  );

  // Decorative stripes on the right — echoes the reference title
  // slide's bar-chart motif without requiring an image asset.
  const stripeX = 10.2;
  const stripeY = 2.4;
  const bars = [
    { w: 2.6, color: COLORS.accent,     t: 0    },
    { w: 2.2, color: COLORS.accent,     t: 45   },
    { w: 2.8, color: COLORS.accentSoft, t: 0    },
    { w: 1.9, color: COLORS.accent,     t: 70   },
  ];
  bars.forEach((b, i) => {
    s.addShape('roundRect', {
      x: stripeX, y: stripeY + i * 0.75, w: b.w, h: 0.45,
      fill: { color: b.color, transparency: b.t },
      line: { type: 'none' },
      rectRadius: 0.22,
    });
  });

  addFooter(s, {
    leftText: `${monthYear(new Date(play.created_at || Date.now()))}  ·  prepared for ${account?.account_name || 'the account'}`,
  });
}

// ---------- slide 2: the play diagram ----------

function addPlaySlide(pptx, { play, account, exp, moves, currentStepIdx }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  addBrandMark(s, { x: 11.2, y: 0.4 });

  s.addText('The play', {
    x: 0.6, y: 0.45, w: 9.0, h: 0.6,
    color: COLORS.ink, fontSize: 34, bold: true, fontFace: 'Calibri',
  });
  const subtitle = exp.named_play
    ? `${exp.named_play}${account?.account_name ? '  ·  ' + account.account_name : ''}`
    : account?.account_name || '';
  if (subtitle) {
    s.addText(subtitle, {
      x: 0.6, y: 1.1, w: 9.0, h: 0.4,
      color: COLORS.muted, fontSize: 14, italic: true, fontFace: 'Calibri',
    });
  }

  if (moves.length === 0) {
    s.addText('No moves on this play yet. Open it in Ambition to draft them.', {
      x: 0.6, y: 3.0, w: 12.2, h: 0.8,
      color: COLORS.muted, fontSize: 18, italic: true, fontFace: 'Calibri', align: 'center',
    });
    addFooter(s, {});
    return;
  }

  // First row: up to 4 steps. Second row: next 4. Overflow collapses
  // into a "+N more" pill.
  const row1 = moves.slice(0, 4);
  const row2 = moves.slice(4, 8);
  const overflow = moves.slice(8);

  drawStepRow(s, {
    moves: row1,
    startIdx: 0,
    y: 1.85,
    currentStepIdx,
    overflowCount: overflow.length,
    overflowOnThisRow: row2.length === 0,
  });
  if (row2.length > 0) {
    drawStepRow(s, {
      moves: row2,
      startIdx: 4,
      y: 3.55,
      currentStepIdx,
      overflowCount: overflow.length,
      overflowOnThisRow: true,
    });
  }

  const current = currentStepIdx >= 0 ? moves[currentStepIdx] : null;
  drawBallCallout(s, { current, currentStepIdx, totalSteps: moves.length });

  addFooter(s, {});
}

function drawStepRow(s, { moves, startIdx, y, currentStepIdx, overflowCount, overflowOnThisRow }) {
  const boxW = 2.75;
  const gap = 0.25;
  const startX = 0.6;
  const rowH = 1.5;

  moves.forEach((m, i) => {
    const idx = startIdx + i;
    const isCurrent = idx === currentStepIdx;
    const isPast = idx < currentStepIdx;
    const x = startX + i * (boxW + gap);

    s.addShape('roundRect', {
      x, y, w: boxW, h: rowH,
      fill: { color: isCurrent ? COLORS.accentSoft : (isPast ? COLORS.surface : COLORS.bg) },
      line: { color: isCurrent ? COLORS.accent : COLORS.rule, width: isCurrent ? 2.5 : 1 },
      rectRadius: 0.12,
    });

    const circleColor = isPast ? COLORS.muted : (isCurrent ? COLORS.accent : COLORS.ink);
    s.addShape('oval', {
      x: x + 0.18, y: y + 0.18, w: 0.5, h: 0.5,
      fill: { color: circleColor }, line: { color: circleColor },
    });
    s.addText(String(m.step ?? idx + 1), {
      x: x + 0.18, y: y + 0.18, w: 0.5, h: 0.5,
      color: 'FFFFFF', fontSize: 16, bold: true, align: 'center', valign: 'middle', fontFace: 'Calibri',
    });

    if (isPast) {
      s.addText('✓', {
        x: x + boxW - 0.55, y: y + 0.1, w: 0.4, h: 0.4,
        color: COLORS.accent, fontSize: 18, bold: true, align: 'right', fontFace: 'Calibri',
      });
    }

    s.addText(truncate(m.actor || '—', 26), {
      x: x + 0.8, y: y + 0.15, w: boxW - 0.95, h: 0.35,
      color: COLORS.ink, fontSize: 15, bold: true, fontFace: 'Calibri', valign: 'middle',
    });
    const channelLine = [m.channel, m.days_from_now != null ? `day ${m.days_from_now}` : null]
      .filter(Boolean).join('  ·  ');
    s.addText(channelLine || '—', {
      x: x + 0.8, y: y + 0.5, w: boxW - 0.95, h: 0.3,
      color: COLORS.muted, fontSize: 11, fontFace: 'Calibri', valign: 'middle',
    });

    s.addText(truncate(m.ask || '', 110), {
      x: x + 0.18, y: y + 0.85, w: boxW - 0.3, h: 0.55,
      color: COLORS.body, fontSize: 11, fontFace: 'Calibri', valign: 'top',
    });

    if (isCurrent) {
      s.addShape('roundRect', {
        x: x + boxW / 2 - 0.85, y: y - 0.42, w: 1.7, h: 0.32,
        fill: { color: COLORS.accent }, line: { color: COLORS.accent },
        rectRadius: 0.08,
      });
      s.addText('YOU ARE HERE', {
        x: x + boxW / 2 - 0.85, y: y - 0.42, w: 1.7, h: 0.32,
        color: 'FFFFFF', fontSize: 10, bold: true, align: 'center', valign: 'middle',
        charSpacing: 2, fontFace: 'Calibri',
      });
    }

    if (i < moves.length - 1) {
      s.addText('›', {
        x: x + boxW - 0.02, y: y + 0.5, w: 0.3, h: 0.5,
        color: COLORS.muted, fontSize: 24, bold: true, align: 'center', valign: 'middle',
      });
    }
  });

  if (overflowOnThisRow && overflowCount > 0) {
    const lastX = startX + moves.length * (boxW + gap);
    s.addShape('roundRect', {
      x: lastX, y: y + 0.45, w: 1.6, h: 0.6,
      fill: { color: COLORS.surface }, line: { color: COLORS.rule, width: 1 },
      rectRadius: 0.3,
    });
    s.addText(`+${overflowCount} more`, {
      x: lastX, y: y + 0.45, w: 1.6, h: 0.6,
      color: COLORS.muted, fontSize: 12, bold: true, align: 'center', valign: 'middle', fontFace: 'Calibri',
    });
  }
}

function drawBallCallout(s, { current, currentStepIdx, totalSteps }) {
  const y = 5.25;
  s.addShape('roundRect', {
    x: 0.6, y, w: 12.2, h: 1.55,
    fill: { color: COLORS.ink }, line: { color: COLORS.ink },
    rectRadius: 0.12,
  });

  s.addText('WHO HAS THE BALL', {
    x: 0.9, y: y + 0.2, w: 6.0, h: 0.3,
    color: COLORS.accentSoft, fontSize: 12, bold: true, charSpacing: 4, fontFace: 'Calibri',
  });

  const ballName = current?.actor || 'Not yet assigned';
  s.addText(ballName, {
    x: 0.9, y: y + 0.5, w: 8.5, h: 0.65,
    color: 'FFFFFF', fontSize: 30, bold: true, fontFace: 'Calibri', valign: 'middle',
  });

  const subline = current
    ? [current.channel, current.days_from_now != null ? `day ${current.days_from_now}` : null, truncate(current.ask || '', 90)]
        .filter(Boolean).join('  ·  ')
    : 'Open this play in Ambition to assign the first move.';
  s.addText(subline, {
    x: 0.9, y: y + 1.1, w: 8.8, h: 0.35,
    color: COLORS.accentSoft, fontSize: 13, fontFace: 'Calibri', valign: 'middle',
  });

  if (currentStepIdx >= 0 && totalSteps > 0) {
    s.addText('STEP', {
      x: 10.4, y: y + 0.2, w: 2.2, h: 0.3,
      color: COLORS.accentSoft, fontSize: 11, bold: true, charSpacing: 3, align: 'right', fontFace: 'Calibri',
    });
    s.addText(`${currentStepIdx + 1} / ${totalSteps}`, {
      x: 10.4, y: y + 0.45, w: 2.2, h: 0.95,
      color: 'FFFFFF', fontSize: 44, bold: true, align: 'right', valign: 'middle', fontFace: 'Calibri',
    });
  }
}

// ---------- slide 3: the org chart ----------

function addOrgSlide(pptx, { account, contacts, pathResolved }) {
  const s = pptx.addSlide();
  s.background = { color: COLORS.bg };
  addBrandMark(s, { x: 11.2, y: 0.4 });

  s.addText('The org', {
    x: 0.6, y: 0.45, w: 9.0, h: 0.6,
    color: COLORS.ink, fontSize: 34, bold: true, fontFace: 'Calibri',
  });
  s.addText(
    `${account?.account_name || 'Account'} — contacts on the board${pathResolved.length ? `. Path: ${pathResolved.length} stop${pathResolved.length === 1 ? '' : 's'}.` : ''}`,
    {
      x: 0.6, y: 1.1, w: 10.0, h: 0.4,
      color: COLORS.muted, fontSize: 14, italic: true, fontFace: 'Calibri',
    }
  );

  if (contacts.length === 0) {
    s.addText('No contacts mapped yet. Add them from the account plan page.', {
      x: 0.6, y: 3.0, w: 12.2, h: 0.8,
      color: COLORS.muted, fontSize: 18, italic: true, fontFace: 'Calibri', align: 'center',
    });
    // Legend stays useful regardless
    drawOrgLegend(s, 6.4);
    addFooter(s, {});
    return;
  }

  const tiers = buildTiers(contacts);
  const pathIdx = new Map();
  pathResolved.forEach((c, i) => pathIdx.set(c.id, i + 1));

  const top = 1.9;
  const bottom = 6.4;
  const tierH = (bottom - top) / Math.max(tiers.length, 1);
  const boxW = 2.35;
  const boxH = Math.min(1.15, tierH - 0.3);
  const usableW = 12.2;
  const startX = 0.6;

  // Draw connector lines FIRST so they sit behind the boxes.
  tiers.forEach((tier, rowIdx) => {
    const slotW = usableW / tier.length;
    tier.forEach((c, colIdx) => {
      if (!c.reports_to_contact_id) return;
      const parentPos = locateContact(tiers, c.reports_to_contact_id, { top, tierH, usableW, startX, boxW, boxH });
      if (!parentPos) return;
      const cx = startX + colIdx * slotW + (slotW - boxW) / 2;
      const cy = top + rowIdx * tierH + (tierH - boxH) / 2;
      s.addShape('line', {
        x: parentPos.x + boxW / 2, y: parentPos.y + boxH,
        w: (cx + boxW / 2) - (parentPos.x + boxW / 2),
        h: cy - (parentPos.y + boxH),
        line: { color: COLORS.rule, width: 1.25 },
      });
    });
  });

  // Draw boxes
  tiers.forEach((tier, rowIdx) => {
    const slotW = usableW / tier.length;
    tier.forEach((c, colIdx) => {
      const cx = startX + colIdx * slotW + (slotW - boxW) / 2;
      const cy = top + rowIdx * tierH + (tierH - boxH) / 2;
      drawContactBox(s, {
        x: cx, y: cy, w: boxW, h: boxH,
        contact: c,
        pathNumber: pathIdx.get(c.id) || null,
      });
    });
  });

  drawOrgLegend(s, 6.75);
  addFooter(s, {});
}

function drawContactBox(s, { x, y, w, h, contact, pathNumber }) {
  const isChampion = contact.deal_role === 'champion';
  const onPath = pathNumber != null;
  const fill = isChampion ? COLORS.accentSoft : (onPath ? COLORS.surface : COLORS.bg);
  const borderColor = isChampion ? COLORS.accent : (onPath ? COLORS.ink : COLORS.rule);
  const borderW = isChampion || onPath ? 2 : 1;

  s.addShape('roundRect', {
    x, y, w, h,
    fill: { color: fill }, line: { color: borderColor, width: borderW },
    rectRadius: 0.1,
  });

  if (onPath) {
    s.addShape('oval', {
      x: x - 0.12, y: y - 0.12, w: 0.4, h: 0.4,
      fill: { color: COLORS.ink }, line: { color: COLORS.ink },
    });
    s.addText(String(pathNumber), {
      x: x - 0.12, y: y - 0.12, w: 0.4, h: 0.4,
      color: 'FFFFFF', fontSize: 13, bold: true, align: 'center', valign: 'middle', fontFace: 'Calibri',
    });
  }

  const stanceColor = STANCE_COLOR[contact.stance] || COLORS.muted;
  s.addShape('oval', {
    x: x + w - 0.28, y: y + 0.12, w: 0.16, h: 0.16,
    fill: { color: stanceColor }, line: { color: stanceColor },
  });

  s.addText(contact.name || '—', {
    x: x + 0.15, y: y + 0.1, w: w - 0.5, h: 0.3,
    color: COLORS.ink, fontSize: 14, bold: true, fontFace: 'Calibri', valign: 'middle',
  });

  s.addText(truncate(contact.title || '', 40), {
    x: x + 0.15, y: y + 0.42, w: w - 0.3, h: 0.28,
    color: COLORS.body, fontSize: 11, fontFace: 'Calibri', valign: 'middle',
  });

  const roleLabel = ROLE_LABEL[contact.deal_role] || '—';
  const roleColor = isChampion
    ? COLORS.accent
    : (contact.deal_role === 'economic_buyer' ? COLORS.ink : COLORS.muted);
  s.addText(roleLabel.toUpperCase(), {
    x: x + 0.15, y: y + h - 0.35, w: w - 0.3, h: 0.28,
    color: roleColor, fontSize: 9, bold: true, charSpacing: 2, fontFace: 'Calibri', valign: 'middle',
  });
}

function drawOrgLegend(s, y) {
  const items = [
    { label: 'Champion',       color: COLORS.accent  },
    { label: 'On path',        color: COLORS.ink     },
    { label: 'Hot/Warm',       color: STANCE_COLOR.warm },
    { label: 'Neutral',        color: STANCE_COLOR.neutral },
    { label: 'Cold/Hostile',   color: STANCE_COLOR.hostile },
  ];
  let x = 0.6;
  items.forEach((it) => {
    s.addShape('oval', {
      x, y: y + 0.06, w: 0.16, h: 0.16,
      fill: { color: it.color }, line: { color: it.color },
    });
    s.addText(it.label, {
      x: x + 0.22, y, w: 1.8, h: 0.28,
      color: COLORS.muted, fontSize: 10, fontFace: 'Calibri', valign: 'middle',
    });
    x += 1.95;
  });
}

// Tier contacts by reports_to graph depth. If no one reports to anyone,
// fall back to deal_role seniority so the chart still reads top-down.
function buildTiers(contacts) {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const hasAnyReports = contacts.some((c) => c.reports_to_contact_id && byId.has(c.reports_to_contact_id));

  if (hasAnyReports) {
    const depth = new Map();
    function computeDepth(c, seen) {
      if (depth.has(c.id)) return depth.get(c.id);
      if (seen.has(c.id)) return 0; // cycle guard
      seen.add(c.id);
      if (!c.reports_to_contact_id || !byId.has(c.reports_to_contact_id)) {
        depth.set(c.id, 0);
        return 0;
      }
      const d = computeDepth(byId.get(c.reports_to_contact_id), seen) + 1;
      depth.set(c.id, d);
      return d;
    }
    contacts.forEach((c) => computeDepth(c, new Set()));
    const max = Math.max(0, ...depth.values());
    const tiers = Array.from({ length: max + 1 }, () => []);
    contacts.forEach((c) => tiers[depth.get(c.id) || 0].push(c));
    return tiers.map((t) => t.slice(0, 6)).filter((t) => t.length > 0);
  }

  // Fallback: tier by deal_role seniority.
  const SENIOR = { economic_buyer: 0, champion: 1, coach: 1, influencer: 1, blocker: 1, user: 2, unknown: 2 };
  const buckets = new Map();
  contacts.forEach((c) => {
    const tier = SENIOR[c.deal_role] ?? 2;
    if (!buckets.has(tier)) buckets.set(tier, []);
    buckets.get(tier).push(c);
  });
  return Array.from(buckets.keys()).sort().map((k) => buckets.get(k).slice(0, 6));
}

function locateContact(tiers, contactId, { top, tierH, usableW, startX, boxW, boxH }) {
  for (let rowIdx = 0; rowIdx < tiers.length; rowIdx++) {
    const tier = tiers[rowIdx];
    const idx = tier.findIndex((c) => c.id === contactId);
    if (idx === -1) continue;
    const slotW = usableW / tier.length;
    return {
      x: startX + idx * slotW + (slotW - boxW) / 2,
      y: top + rowIdx * tierH + (tierH - boxH) / 2,
    };
  }
  return null;
}
